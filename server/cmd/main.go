package cmd

import (
	"context"
	"net/http"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/server/services"
	amqp "github.com/rabbitmq/amqp091-go"
)

type App struct {
	rmq RmqLike
}

type RmqLike interface {
	Connect(maxAttempts int, delay time.Duration) error
	Healthy() bool
	Close() error
	DeclareExchange(ctx context.Context, opts services.ExchangeDeclareOptions) error
	DeclareQueue(ctx context.Context, opts services.QueueDeclareOptions) (amqp.Queue, error)
	BindQueue(ctx context.Context, opts services.QueueBindOptions) error
	PublishMessage(ctx context.Context, opts services.PublishMessageOptions) error
	GetNextMessage(ctx context.Context, queueName string) (services.QueuedMessage, error)
	AckMessage(ctx context.Context, queueName, messageID string) error
	NackMessage(ctx context.Context, queueName, messageID string, requeue bool) error
}

func NewApp(rmq RmqLike) *App {
	return &App{rmq: rmq}
}

func (a *App) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.HandleHealth)
	mux.HandleFunc("POST /exchanges/{exchange}/messages", a.handlePublishMessage)
	mux.HandleFunc("GET /queues/{queue}/messages/next", a.handleGetNextMessage)
	mux.HandleFunc("DELETE /queues/{queue}/messages/{message_id}", a.handleAckMessage)
	mux.HandleFunc("POST /queues/{queue}/messages/{message_id}/nack", a.handleNackMessage)
	return mux
}
