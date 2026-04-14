package cmd

import (
	"context"
	"net/http"
	"time"

	rabbitmqsvc "github.com/Yongbeom-Kim/LocalAgent/server/services/rabbitmq"
	amqp "github.com/rabbitmq/amqp091-go"
)

type App struct {
	rmq RmqLike
}

type RmqLike interface {
	Connect(maxAttempts int, delay time.Duration) error
	Healthy() bool
	Close() error
	DeclareExchange(ctx context.Context, opts rabbitmqsvc.ExchangeDeclareOptions) error
	DeclareQueue(ctx context.Context, opts rabbitmqsvc.QueueDeclareOptions) (amqp.Queue, error)
	QueueExists(ctx context.Context, name string) (bool, error)
	DeleteQueue(ctx context.Context, name string) error
	BindQueue(ctx context.Context, opts rabbitmqsvc.QueueBindOptions) error
	PublishMessage(ctx context.Context, opts rabbitmqsvc.PublishMessageOptions) error
	GetNextMessage(ctx context.Context, queueName string) (rabbitmqsvc.QueuedMessage, error)
	AckMessage(ctx context.Context, queueName, messageID string) error
	NackMessage(ctx context.Context, queueName, messageID string, requeue bool) error
}

func NewApp(rmq RmqLike) *App {
	return &App{rmq: rmq}
}

func (a *App) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.HandleHealth)
	mux.HandleFunc("PUT /workers/{worker_id}/registration", a.handleRegisterWorker)
	mux.HandleFunc("POST /exchanges/{exchange}/messages", a.handlePublishMessage)
	mux.HandleFunc("GET /queues/{queue}/messages/next", a.handleGetNextMessage)
	mux.HandleFunc("DELETE /queues/{queue}/messages/{message_id}", a.handleAckMessage)
	mux.HandleFunc("POST /queues/{queue}/messages/{message_id}/nack", a.handleNackMessage)
	return mux
}
