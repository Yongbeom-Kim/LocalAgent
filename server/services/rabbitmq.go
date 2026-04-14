package services

import (
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

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
