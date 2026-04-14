package core

import (
	"context"
	"errors"
	"testing"

	"github.com/Yongbeom-Kim/LocalAgent/worker/models"
)

type fakePoller struct {
	initFn func(context.Context) error
	pollFn func(context.Context, func(context.Context, models.QueuedMessage) error) error
}

func (p *fakePoller) Init(ctx context.Context) error {
	if p.initFn == nil {
		return nil
	}
	return p.initFn(ctx)
}

func (p *fakePoller) Poll(ctx context.Context, handler func(context.Context, models.QueuedMessage) error) error {
	if p.pollFn == nil {
		return ctx.Err()
	}
	return p.pollFn(ctx, handler)
}

type fakeRunner struct {
	executeFn func(context.Context, models.QueuedMessage) error
}

func (r *fakeRunner) Execute(ctx context.Context, msg models.QueuedMessage) error {
	if r.executeFn == nil {
		return nil
	}
	return r.executeFn(ctx, msg)
}

func TestDaemonCallsInitBeforePoll(t *testing.T) {
	steps := make([]string, 0, 2)
	daemon := NewDaemonWithDependencies(&fakePoller{
		initFn: func(context.Context) error {
			steps = append(steps, "init")
			return nil
		},
		pollFn: func(_ context.Context, _ func(context.Context, models.QueuedMessage) error) error {
			steps = append(steps, "poll")
			return nil
		},
	}, &fakeRunner{})

	if err := daemon.Run(context.Background()); err != nil {
		t.Fatalf("Run error = %v", err)
	}
	if len(steps) != 2 || steps[0] != "init" || steps[1] != "poll" {
		t.Fatalf("steps = %#v, want [init poll]", steps)
	}
}

func TestDaemonPassesMessagesToRunner(t *testing.T) {
	seen := false
	daemon := NewDaemonWithDependencies(&fakePoller{
		pollFn: func(ctx context.Context, handler func(context.Context, models.QueuedMessage) error) error {
			return handler(ctx, models.QueuedMessage{MessageID: "msg-1"})
		},
	}, &fakeRunner{executeFn: func(_ context.Context, msg models.QueuedMessage) error {
		seen = msg.MessageID == "msg-1"
		return nil
	}})

	if err := daemon.Run(context.Background()); err != nil {
		t.Fatalf("Run error = %v", err)
	}
	if !seen {
		t.Fatal("runner did not receive message")
	}
}

func TestDaemonReturnsInitError(t *testing.T) {
	daemon := NewDaemonWithDependencies(&fakePoller{initFn: func(context.Context) error {
		return errors.New("init failed")
	}}, &fakeRunner{})

	err := daemon.Run(context.Background())
	if err == nil || err.Error() != "init failed" {
		t.Fatalf("err = %v, want init failed", err)
	}
}

func TestDaemonReturnsPollError(t *testing.T) {
	daemon := NewDaemonWithDependencies(&fakePoller{pollFn: func(context.Context, func(context.Context, models.QueuedMessage) error) error {
		return errors.New("poll failed")
	}}, &fakeRunner{})

	err := daemon.Run(context.Background())
	if err == nil || err.Error() != "poll failed" {
		t.Fatalf("err = %v, want poll failed", err)
	}
}

func TestDaemonReturnsRunnerErrorThroughPoller(t *testing.T) {
	daemon := NewDaemonWithDependencies(&fakePoller{pollFn: func(ctx context.Context, handler func(context.Context, models.QueuedMessage) error) error {
		return handler(ctx, models.QueuedMessage{MessageID: "msg-1"})
	}}, &fakeRunner{executeFn: func(context.Context, models.QueuedMessage) error {
		return errors.New("runner failed")
	}})

	err := daemon.Run(context.Background())
	if err == nil || err.Error() != "runner failed" {
		t.Fatalf("err = %v, want runner failed", err)
	}
}
