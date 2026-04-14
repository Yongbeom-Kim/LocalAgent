package core

import (
	"context"
	"log/slog"

	"github.com/Yongbeom-Kim/LocalAgent/worker/models"
	pollersvc "github.com/Yongbeom-Kim/LocalAgent/worker/services/poller"
	runnersvc "github.com/Yongbeom-Kim/LocalAgent/worker/services/runner"
)

type Poller interface {
	Init(ctx context.Context) error
	Poll(ctx context.Context, handler func(context.Context, models.QueuedMessage) error) error
}

type Runner interface {
	Execute(ctx context.Context, msg models.QueuedMessage) error
}

type Daemon struct {
	poller Poller
	runner Runner
}

func NewDaemon(cfg models.Config, logger *slog.Logger) *Daemon {
	return NewDaemonWithDependencies(
		pollersvc.New(cfg, nil, logger),
		runnersvc.New(cfg, logger),
	)
}

func NewDaemonWithDependencies(poller Poller, runner Runner) *Daemon {
	return &Daemon{poller: poller, runner: runner}
}

func (d *Daemon) Run(ctx context.Context) error {
	if err := d.poller.Init(ctx); err != nil {
		return err
	}

	return d.poller.Poll(ctx, func(ctx context.Context, msg models.QueuedMessage) error {
		return d.runner.Execute(ctx, msg)
	})
}
