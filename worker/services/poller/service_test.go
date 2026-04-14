package poller

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/worker/models"
)

type fakeLogger struct {
	events []string
	onLog  func(level slog.Level, msg string)
}

func (l *fakeLogger) LogAttrs(_ context.Context, level slog.Level, msg string, _ ...slog.Attr) {
	l.events = append(l.events, msg)
	if l.onLog != nil {
		l.onLog(level, msg)
	}
}

func testConfig(t *testing.T, serverURL string) models.Config {
	t.Helper()

	urlValue, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}

	return models.Config{
		WorkerID:          "alpha-01",
		QueueName:         "worker.alpha-01",
		ServerURL:         urlValue,
		PollInterval:      time.Second,
		HeartbeatInterval: 5 * time.Second,
	}
}

func testService(t *testing.T, server http.Handler) *WorkerPoller {
	t.Helper()

	httpServer := httptest.NewServer(server)
	t.Cleanup(httpServer.Close)

	return New(testConfig(t, httpServer.URL), httpServer.Client(), &fakeLogger{})
}

func TestServiceInitRetriesInitialRegistrationForever(t *testing.T) {
	attempts := 0
	svc := testService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts < 3 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))

	sleeps := 0
	svc.sleep = func(context.Context, time.Duration) bool {
		sleeps++
		return true
	}

	if err := svc.Init(context.Background()); err != nil {
		t.Fatalf("Init error = %v", err)
	}
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3", attempts)
	}
	if sleeps != 2 {
		t.Fatalf("sleeps = %d, want 2", sleeps)
	}
}

func TestServiceInitStartsHeartbeatAfterSuccessfulRegistration(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	registerCalls := 0
	svc := testService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		registerCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))

	heartbeatStarted := make(chan struct{}, 1)
	svc.sleep = func(_ context.Context, d time.Duration) bool {
		if d == 5*time.Second {
			heartbeatStarted <- struct{}{}
			cancel()
		}
		return false
	}

	if err := svc.Init(ctx); err != nil {
		t.Fatalf("Init error = %v", err)
	}

	select {
	case <-heartbeatStarted:
	case <-time.After(time.Second):
		t.Fatal("heartbeat did not start")
	}
	if registerCalls < 2 {
		t.Fatalf("registerCalls = %d, want at least 2", registerCalls)
	}
}

func TestServicePollSleepsOnPollError(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	slept := time.Duration(0)
	svc := testService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"boom"}`))
	}))
	svc.sleep = func(_ context.Context, d time.Duration) bool {
		slept = d
		cancel()
		return false
	}

	_ = svc.Poll(ctx, func(context.Context, models.QueuedMessage) error { return nil })

	if slept != time.Second {
		t.Fatalf("slept = %s, want %s", slept, time.Second)
	}
}

func TestServicePollSleepsOnEmptyQueue(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	slept := time.Duration(0)
	svc := testService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	svc.sleep = func(_ context.Context, d time.Duration) bool {
		slept = d
		cancel()
		return false
	}

	_ = svc.Poll(ctx, func(context.Context, models.QueuedMessage) error { return nil })

	if slept != time.Second {
		t.Fatalf("slept = %s, want %s", slept, time.Second)
	}
}

func TestServicePollAcksAfterHandlerSucceeds(t *testing.T) {
	events := make([]string, 0, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	svc := testService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/queues/worker.alpha-01/messages/next":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"message_id":  "msg-1",
				"body":        map[string]any{"kind": "created"},
				"routing_key": "alpha-01",
			})
		case r.Method == http.MethodDelete && r.URL.Path == "/queues/worker.alpha-01/messages/msg-1":
			events = append(events, "ack")
			cancel()
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	_ = svc.Poll(ctx, func(context.Context, models.QueuedMessage) error {
		events = append(events, "handle")
		return nil
	})

	if len(events) != 2 || events[0] != "handle" || events[1] != "ack" {
		t.Fatalf("events = %#v, want [handle ack]", events)
	}
}

func TestServicePollSkipsAckWhenHandlerFails(t *testing.T) {
	ackCalled := false
	svc := testService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/queues/worker.alpha-01/messages/next":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"message_id":  "msg-1",
				"body":        map[string]any{"kind": "created"},
				"routing_key": "alpha-01",
			})
		case r.Method == http.MethodDelete:
			ackCalled = true
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	err := svc.Poll(context.Background(), func(context.Context, models.QueuedMessage) error {
		return io.ErrUnexpectedEOF
	})
	if err == nil || err != io.ErrUnexpectedEOF {
		t.Fatalf("err = %v, want io.ErrUnexpectedEOF", err)
	}
	if ackCalled {
		t.Fatal("ack should not be called when handler fails")
	}
}

func TestDecodeAPIErrorFallsBackToBody(t *testing.T) {
	resp := &http.Response{
		StatusCode: http.StatusBadGateway,
		Body:       io.NopCloser(strings.NewReader("bad gateway")),
	}

	err := decodeAPIError(resp)
	if err == nil || err.Error() != "status 502: bad gateway" {
		t.Fatalf("err = %v, want status 502: bad gateway", err)
	}
}
