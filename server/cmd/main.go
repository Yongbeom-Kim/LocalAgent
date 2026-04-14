package cmd

import (
	"net/http"
	"time"
)

type App struct {
	rmq RmqLike
}

type RmqLike interface {
	Connect(maxAttempts int, delay time.Duration) error
	Healthy() bool
	Close() error
}

func NewApp(rmq RmqLike) *App {
	return &App{rmq: rmq}
}

func (a *App) Router() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", a.HandleHealth)
	return mux
}
