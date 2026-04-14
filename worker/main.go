package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/Yongbeom-Kim/LocalAgent/worker/core"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	cfg, err := LoadFromEnv()
	if err != nil {
		logger.Error("invalid worker config", "error", err)
		os.Exit(1)
	}

	daemon := core.NewDaemon(cfg, logger)
	if err := daemon.Run(context.Background()); err != nil {
		logger.Error("worker daemon stopped", "error", err)
		os.Exit(1)
	}
}
