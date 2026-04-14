package poller

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/worker/models"
)

const retryInterval = time.Second

type Logger interface {
	LogAttrs(ctx context.Context, level slog.Level, msg string, attrs ...slog.Attr)
}

type WorkerPoller struct {
	baseURL           *url.URL
	httpClient        *http.Client
	workerID          string
	queueName         string
	heartbeatInterval time.Duration
	pollInterval      time.Duration
	retryInterval     time.Duration
	logger            Logger
	sleep             func(context.Context, time.Duration) bool
}

type registerResponse struct {
	Status string `json:"status"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func New(cfg models.Config, httpClient *http.Client, logger Logger) *WorkerPoller {
	if httpClient == nil {
		httpClient = &http.Client{}
	}

	return &WorkerPoller{
		baseURL:           cfg.ServerURL,
		httpClient:        httpClient,
		workerID:          cfg.WorkerID,
		queueName:         cfg.QueueName,
		heartbeatInterval: cfg.HeartbeatInterval,
		pollInterval:      cfg.PollInterval,
		retryInterval:     retryInterval,
		logger:            logger,
		sleep:             sleepContext,
	}
}

func (s *WorkerPoller) Init(ctx context.Context) error {
	if err := s.registerUntilSuccess(ctx); err != nil {
		return err
	}

	s.logger.LogAttrs(ctx, slog.LevelInfo, "initial registration succeeded",
		slog.String("worker_id", s.workerID),
		slog.String("queue", s.queueName),
	)

	go s.runHeartbeat(ctx)
	return nil
}

func (s *WorkerPoller) Poll(ctx context.Context, handler func(context.Context, models.QueuedMessage) error) error {
	for ctx.Err() == nil {
		msg, ok, err := s.pollNext(ctx)
		if err != nil {
			s.logError(ctx, "poll failed", err)
			if !s.sleep(ctx, s.retryInterval) {
				return ctx.Err()
			}
			continue
		}
		if !ok {
			if !s.sleep(ctx, s.pollInterval) {
				return ctx.Err()
			}
			continue
		}
		if err := handler(ctx, msg); err != nil {
			return err
		}
		if err := s.ack(ctx, msg.MessageID); err != nil {
			s.logError(ctx, "ack failed", err)
		}
	}

	return ctx.Err()
}

func (s *WorkerPoller) registerUntilSuccess(ctx context.Context) error {
	for ctx.Err() == nil {
		if err := s.register(ctx); err != nil {
			s.logError(ctx, "initial registration failed", err)
			if !s.sleep(ctx, s.retryInterval) {
				return ctx.Err()
			}
			continue
		}
		return nil
	}

	return ctx.Err()
}

func (s *WorkerPoller) runHeartbeat(ctx context.Context) {
	for ctx.Err() == nil {
		if err := s.register(ctx); err != nil {
			s.logError(ctx, "registration failed", err)
			if !s.sleep(ctx, s.retryInterval) {
				return
			}
			continue
		}

		if !s.sleep(ctx, s.heartbeatInterval) {
			return
		}
	}
}

func (s *WorkerPoller) register(ctx context.Context) error {
	resp, err := s.doJSON(ctx, http.MethodPut, "/workers/"+s.workerID+"/registration", struct{}{})
	if err != nil {
		return fmt.Errorf("register worker: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("register worker: %w", decodeAPIError(resp))
	}

	var payload registerResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return fmt.Errorf("register worker: decode response: %w", err)
	}

	if payload.Status != "ok" {
		return fmt.Errorf("register worker: unexpected status %q", payload.Status)
	}

	return nil
}

func (s *WorkerPoller) pollNext(ctx context.Context) (models.QueuedMessage, bool, error) {
	resp, err := s.doJSON(ctx, http.MethodGet, "/queues/"+s.queueName+"/messages/next", nil)
	if err != nil {
		return models.QueuedMessage{}, false, fmt.Errorf("poll next message: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNoContent {
		return models.QueuedMessage{}, false, nil
	}
	if resp.StatusCode != http.StatusOK {
		return models.QueuedMessage{}, false, fmt.Errorf("poll next message: %w", decodeAPIError(resp))
	}

	var payload models.QueuedMessage
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return models.QueuedMessage{}, false, fmt.Errorf("poll next message: decode response: %w", err)
	}

	return payload, true, nil
}

func (s *WorkerPoller) ack(ctx context.Context, messageID string) error {
	resp, err := s.doJSON(ctx, http.MethodDelete, "/queues/"+s.queueName+"/messages/"+messageID, nil)
	if err != nil {
		return fmt.Errorf("ack message: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("ack message: %w", decodeAPIError(resp))
	}

	return nil
}

func (s *WorkerPoller) doJSON(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}

	req, err := http.NewRequestWithContext(ctx, method, s.resolve(path), reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	return s.httpClient.Do(req)
}

func (s *WorkerPoller) resolve(path string) string {
	return strings.TrimRight(s.baseURL.String(), "/") + path
}

func (s *WorkerPoller) logError(ctx context.Context, message string, err error) {
	if err == nil || ctx.Err() != nil {
		return
	}

	s.logger.LogAttrs(ctx, slog.LevelError, message,
		slog.String("worker_id", s.workerID),
		slog.String("queue", s.queueName),
		slog.String("error", err.Error()),
	)
}

func decodeAPIError(resp *http.Response) error {
	body, _ := io.ReadAll(resp.Body)
	if len(body) == 0 {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}

	var payload errorResponse
	if err := json.Unmarshal(body, &payload); err == nil && payload.Error != "" {
		return fmt.Errorf("status %d: %s", resp.StatusCode, payload.Error)
	}

	return fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
