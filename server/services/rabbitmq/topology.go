package services

import (
	"context"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const (
	JobsDirectExchange = "jobs.direct"
	JobsFanoutExchange = "jobs.fanout"
	workerQueuePrefix  = "worker."
	workerQueueTTL     = time.Hour
)

type ExchangeDeclarer interface {
	DeclareExchange(ctx context.Context, opts ExchangeDeclareOptions) error
}

func BootstrapJobTopology(ctx context.Context, declarer ExchangeDeclarer) error {
	if err := declarer.DeclareExchange(ctx, ExchangeDeclareOptions{
		Name:       JobsDirectExchange,
		Kind:       ExchangeKindDirect,
		Durable:    true,
		AutoDelete: false,
		Internal:   false,
		NoWait:     false,
	}); err != nil {
		return err
	}

	return declarer.DeclareExchange(ctx, ExchangeDeclareOptions{
		Name:       JobsFanoutExchange,
		Kind:       ExchangeKindFanout,
		Durable:    true,
		AutoDelete: false,
		Internal:   false,
		NoWait:     false,
	})
}

func WorkerQueueName(workerID string) string {
	return workerQueuePrefix + workerID
}

func WorkerQueueDeclareOptions(workerID string) QueueDeclareOptions {
	return QueueDeclareOptions{
		Name:       WorkerQueueName(workerID),
		Durable:    false,
		AutoDelete: false,
		Exclusive:  false,
		NoWait:     false,
		Args: amqp.Table{
			"x-queue-type": "classic",
			"x-expires":    int32(workerQueueTTL / time.Millisecond),
		},
	}
}
