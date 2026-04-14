package runner

import (
	"context"
	"log/slog"
	"testing"

	"github.com/Yongbeom-Kim/LocalAgent/worker/models"
)

type fakeLogger struct {
	events []string
}

func (l *fakeLogger) LogAttrs(_ context.Context, _ slog.Level, msg string, _ ...slog.Attr) {
	l.events = append(l.events, msg)
}

func TestServiceExecuteLogsMessage(t *testing.T) {
	logger := &fakeLogger{}
	svc := New(models.Config{
		WorkerID:  "alpha-01",
		QueueName: "worker.alpha-01",
	}, logger)

	err := svc.Execute(context.Background(), models.QueuedMessage{
		MessageID:  "msg-1",
		Body:       map[string]any{"kind": "created"},
		RoutingKey: "alpha-01",
	})
	if err != nil {
		t.Fatalf("Execute error = %v", err)
	}
	if len(logger.events) != 1 || logger.events[0] != "message received" {
		t.Fatalf("events = %#v, want [message received]", logger.events)
	}
}

func TestServiceExecuteReturnsMarshalError(t *testing.T) {
	logger := &fakeLogger{}
	svc := New(models.Config{
		WorkerID:  "alpha-01",
		QueueName: "worker.alpha-01",
	}, logger)

	err := svc.Execute(context.Background(), models.QueuedMessage{
		MessageID: "msg-1",
		Body:      map[string]any{"bad": make(chan int)},
	})
	if err == nil {
		t.Fatal("expected Execute error")
	}
	if len(logger.events) != 0 {
		t.Fatalf("events = %#v, want none", logger.events)
	}
}
