package runner

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/Yongbeom-Kim/LocalAgent/worker/models"
)

type Logger interface {
	LogAttrs(ctx context.Context, level slog.Level, msg string, attrs ...slog.Attr)
}

type TaskRunner struct {
	workerID  string
	queueName string
	logger    Logger
}

func New(cfg models.Config, logger Logger) *TaskRunner {
	return &TaskRunner{
		workerID:  cfg.WorkerID,
		queueName: cfg.QueueName,
		logger:    logger,
	}
}

func (s *TaskRunner) Execute(ctx context.Context, msg models.QueuedMessage) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	s.logger.LogAttrs(ctx, slog.LevelInfo, "message received",
		slog.String("worker_id", s.workerID),
		slog.String("queue", s.queueName),
		slog.String("message_id", msg.MessageID),
		slog.String("routing_key", msg.RoutingKey),
		slog.String("message_json", string(payload)),
	)

	return nil
}
