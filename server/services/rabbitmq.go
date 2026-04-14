package services

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

type ExchangeKind string

const (
	ExchangeKindDirect  ExchangeKind = "direct"
	ExchangeKindFanout  ExchangeKind = "fanout"
	ExchangeKindTopic   ExchangeKind = "topic"
	ExchangeKindHeaders ExchangeKind = "headers"
)

type ExchangeDeclareOptions struct {
	Name       string
	Kind       ExchangeKind
	Durable    bool
	AutoDelete bool
	Internal   bool
	NoWait     bool
	Args       amqp.Table
}

type QueueDeclareOptions struct {
	Name       string
	Durable    bool
	AutoDelete bool
	Exclusive  bool
	NoWait     bool
	Args       amqp.Table
}

type QueueBindOptions struct {
	QueueName  string
	RoutingKey string
	Exchange   string
	NoWait     bool
	Args       amqp.Table
}

type Rmq struct {
	connUrl string
	conn    *amqp.Connection
}

func NewRmq(connUrl string) *Rmq {
	return &Rmq{
		connUrl: connUrl,
	}
}

func (rmq *Rmq) Connect(maxAttempts int, delay time.Duration) error {
	var lastErr error

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		conn, err := amqp.Dial(rmq.connUrl)
		if err == nil {
			rmq.conn = conn
			return nil
		}

		lastErr = err
		slog.Warn("rabbitmq not ready", "attempt", attempt, "max_attempts", maxAttempts, "error", err)
		time.Sleep(delay)
	}

	return lastErr
}

func (rmq *Rmq) Healthy() bool {
	return rmq.conn != nil && !rmq.conn.IsClosed()
}

func (rmq *Rmq) Close() error {
	if rmq.conn == nil || rmq.conn.IsClosed() {
		return nil
	}

	return rmq.conn.Close()
}

func (rmq *Rmq) DeclareExchange(ctx context.Context, opts ExchangeDeclareOptions) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("declare exchange %q: %w", opts.Name, err)
	}

	ch, err := rmq.openChannel()
	if err != nil {
		return fmt.Errorf("declare exchange %q: %w", opts.Name, err)
	}
	defer func() { _ = ch.Close() }()

	if err := ch.ExchangeDeclare(opts.Name, string(opts.Kind), opts.Durable, opts.AutoDelete, opts.Internal, opts.NoWait, opts.Args); err != nil {
		return fmt.Errorf("declare exchange %q: %w", opts.Name, err)
	}

	return nil
}

func (rmq *Rmq) DeclareQueue(ctx context.Context, opts QueueDeclareOptions) (amqp.Queue, error) {
	if err := ctx.Err(); err != nil {
		return amqp.Queue{}, fmt.Errorf("declare queue %q: %w", opts.Name, err)
	}

	ch, err := rmq.openChannel()
	if err != nil {
		return amqp.Queue{}, fmt.Errorf("declare queue %q: %w", opts.Name, err)
	}
	defer func() { _ = ch.Close() }()

	queue, err := ch.QueueDeclare(opts.Name, opts.Durable, opts.AutoDelete, opts.Exclusive, opts.NoWait, opts.Args)
	if err != nil {
		return amqp.Queue{}, fmt.Errorf("declare queue %q: %w", opts.Name, err)
	}

	return queue, nil
}

func (rmq *Rmq) BindQueue(ctx context.Context, opts QueueBindOptions) error {
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("bind queue %q to exchange %q with routing key %q: %w", opts.QueueName, opts.Exchange, opts.RoutingKey, err)
	}

	ch, err := rmq.openChannel()
	if err != nil {
		return fmt.Errorf("bind queue %q to exchange %q with routing key %q: %w", opts.QueueName, opts.Exchange, opts.RoutingKey, err)
	}
	defer func() { _ = ch.Close() }()

	if err := ch.QueueBind(opts.QueueName, opts.RoutingKey, opts.Exchange, opts.NoWait, opts.Args); err != nil {
		return fmt.Errorf("bind queue %q to exchange %q with routing key %q: %w", opts.QueueName, opts.Exchange, opts.RoutingKey, err)
	}

	return nil
}

func (rmq *Rmq) openChannel() (*amqp.Channel, error) {
	if rmq.conn == nil || rmq.conn.IsClosed() {
		return nil, errors.New("rabbitmq connection is not available")
	}

	ch, err := rmq.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("open rabbitmq channel: %w", err)
	}

	return ch, nil
}
