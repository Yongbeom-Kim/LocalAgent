package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/server/cmd"
	rabbitmqsvc "github.com/Yongbeom-Kim/LocalAgent/server/services/rabbitmq"
	"github.com/Yongbeom-Kim/LocalAgent/server/utils"
)

func main() {
	rabbitURL := utils.GetEnv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
	port := utils.GetEnv("PORT", "8080")
	visibilityTimeout := utils.GetDurationEnv("VISIBILITY_TIMEOUT", 60*time.Second)

	rmq := rabbitmqsvc.NewRmq(rabbitURL, visibilityTimeout)
	if err := rmq.Connect(10, 2*time.Second); err != nil {
		slog.Error("rabbitmq connection failed", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := rmq.Close(); err != nil {
			slog.Warn("rabbitmq close failed", "error", err)
		}
	}()

	bootstrapCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := rabbitmqsvc.BootstrapJobTopology(bootstrapCtx, rmq); err != nil {
		cancel()
		slog.Error("rabbitmq topology bootstrap failed", "error", err)
		os.Exit(1)
	}
	cancel()

	app := cmd.NewApp(rmq)

	addr := ":" + port
	slog.Info("server listening", "addr", addr)
	if err := http.ListenAndServe(addr, app.Router()); err != nil {
		slog.Error("http server failed", "error", err)
		os.Exit(1)
	}
}
