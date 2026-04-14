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
}

func NewApp(rmq RmqLike) *App {
	return &App{rmq: rmq}
}

func (a *App) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.HandleHealth)
	return mux
}
