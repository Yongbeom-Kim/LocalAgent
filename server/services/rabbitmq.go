package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const defaultVisibilityTimeout = 60 * time.Second

var (
	ErrRabbitUnavailable    = errors.New("rabbitmq unavailable")
	ErrExchangeNotFound     = errors.New("exchange not found")
	ErrQueueNotFound        = errors.New("queue not found")
	ErrMessageNotFound      = errors.New("message not found")
	ErrMessageQueueMismatch = errors.New("message does not belong to queue")
	ErrEmptyQueue           = errors.New("queue is empty")
	ErrInvalidMessageBody   = errors.New("message body is not valid json")
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

type PublishMessageOptions struct {
	ExchangeName string
	RoutingKey   string
	Body         []byte
	Headers      amqp.Table
	ContentType  string
}

type QueuedMessage struct {
	MessageID    string
	Body         any
	Headers      map[string]any
	RoutingKey   string
	ContentType  string
	Redelivered  bool
	VisibleUntil time.Time
}

type queueSession struct {
	queueName string
	ch        *amqp.Channel
	mu        sync.Mutex
}

type Rmq struct {
	connURL           string
	conn              *amqp.Connection
	visibilityTimeout time.Duration
	inflight          *inFlightRegistry

	mu            sync.Mutex
	queueSessions map[string]*queueSession
}

func NewRmq(connURL string, visibilityTimeout time.Duration) *Rmq {
	if visibilityTimeout <= 0 {
		visibilityTimeout = defaultVisibilityTimeout
	}

	return &Rmq{
		connURL:           connURL,
		visibilityTimeout: visibilityTimeout,
		inflight:          newInFlightRegistry(visibilityTimeout),
		queueSessions:     make(map[string]*queueSession),
	}
}

func (rmq *Rmq) Connect(maxAttempts int, delay time.Duration) error {
	var lastErr error

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		conn, err := amqp.Dial(rmq.connURL)
		if err == nil {
			rmq.mu.Lock()
			rmq.conn = conn
			rmq.mu.Unlock()
			return nil
		}

		lastErr = err
		slog.Warn("rabbitmq not ready", "attempt", attempt, "max_attempts", maxAttempts, "error", err)
		time.Sleep(delay)
	}

	return lastErr
}

func (rmq *Rmq) Healthy() bool {
	rmq.mu.Lock()
	defer rmq.mu.Unlock()

	return rmq.conn != nil && !rmq.conn.IsClosed()
}

func (rmq *Rmq) Close() error {
	rmq.mu.Lock()
	sessions := make([]*queueSession, 0, len(rmq.queueSessions))
	for _, session := range rmq.queueSessions {
		sessions = append(sessions, session)
	}
	rmq.queueSessions = make(map[string]*queueSession)
	conn := rmq.conn
	rmq.conn = nil
	rmq.mu.Unlock()

	for _, session := range sessions {
		if session == nil || session.ch == nil {
			continue
		}
		_ = session.ch.Close()
	}

	if conn == nil || conn.IsClosed() {
		return nil
	}

	return conn.Close()
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
		return fmt.Errorf("declare exchange %q: %w", opts.Name, classifyAMQPError(err, ErrExchangeNotFound))
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
		return amqp.Queue{}, fmt.Errorf("declare queue %q: %w", opts.Name, classifyAMQPError(err, ErrQueueNotFound))
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
		return fmt.Errorf("bind queue %q to exchange %q with routing key %q: %w", opts.QueueName, opts.Exchange, opts.RoutingKey, classifyAMQPError(err, ErrQueueNotFound))
	}

	return nil
}

func (rmq *Rmq) PublishMessage(ctx context.Context, opts PublishMessageOptions) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	ch, err := rmq.openChannel()
	if err != nil {
		return err
	}
	defer func() { _ = ch.Close() }()

	closeCh := ch.NotifyClose(make(chan *amqp.Error, 1))
	if err := ch.PublishWithContext(ctx, opts.ExchangeName, opts.RoutingKey, false, false, amqp.Publishing{
		Headers:     opts.Headers,
		ContentType: opts.ContentType,
		Body:        opts.Body,
	}); err != nil {
		return classifyAMQPError(err, ErrExchangeNotFound)
	}

	select {
	case amqpErr := <-closeCh:
		if amqpErr != nil {
			return classifyAMQPError(amqpErr, ErrExchangeNotFound)
		}
	default:
	}

	return nil
}

func (rmq *Rmq) GetNextMessage(ctx context.Context, queueName string) (QueuedMessage, error) {
	if err := ctx.Err(); err != nil {
		return QueuedMessage{}, err
	}

	session, err := rmq.getOrCreateQueueSession(queueName)
	if err != nil {
		return QueuedMessage{}, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if session.ch == nil || session.ch.IsClosed() {
		rmq.evictQueueSession(queueName, session)
		return QueuedMessage{}, ErrRabbitUnavailable
	}

	delivery, ok, err := session.ch.Get(queueName, false)
	if err != nil {
		rmq.evictQueueSession(queueName, session)
		return QueuedMessage{}, classifyAMQPError(err, ErrQueueNotFound)
	}
	if !ok {
		return QueuedMessage{}, ErrEmptyQueue
	}

	decodedBody, err := decodeJSONBody(delivery.Body)
	if err != nil {
		_ = session.ch.Nack(delivery.DeliveryTag, false, true)
		return QueuedMessage{}, err
	}

	record, err := rmq.inflight.Register(queueName, delivery.DeliveryTag, func(record inFlightRecord) {
		if nackErr := rmq.nackTimedOutMessage(record); nackErr != nil {
			slog.Warn("auto-nack failed", "queue", record.QueueName, "message_id", record.MessageID, "error", nackErr)
		}
	})
	if err != nil {
		_ = session.ch.Nack(delivery.DeliveryTag, false, true)
		return QueuedMessage{}, err
	}

	return QueuedMessage{
		MessageID:    record.MessageID,
		Body:         decodedBody,
		Headers:      tableToMap(delivery.Headers),
		RoutingKey:   delivery.RoutingKey,
		ContentType:  delivery.ContentType,
		Redelivered:  delivery.Redelivered,
		VisibleUntil: record.VisibleUntil,
	}, nil
}

func (rmq *Rmq) AckMessage(ctx context.Context, queueName, messageID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	return rmq.inflight.Complete(queueName, messageID, func(record inFlightRecord) error {
		return rmq.withExistingQueueSession(queueName, func(session *queueSession) error {
			if session.ch == nil || session.ch.IsClosed() {
				rmq.evictQueueSession(queueName, session)
				return ErrRabbitUnavailable
			}

			if err := session.ch.Ack(record.DeliveryTag, false); err != nil {
				rmq.evictQueueSession(queueName, session)
				return classifyAMQPError(err, ErrQueueNotFound)
			}

			return nil
		})
	})
}

func (rmq *Rmq) NackMessage(ctx context.Context, queueName, messageID string, requeue bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	return rmq.inflight.Complete(queueName, messageID, func(record inFlightRecord) error {
		return rmq.withExistingQueueSession(queueName, func(session *queueSession) error {
			if session.ch == nil || session.ch.IsClosed() {
				rmq.evictQueueSession(queueName, session)
				return ErrRabbitUnavailable
			}

			if err := session.ch.Nack(record.DeliveryTag, false, requeue); err != nil {
				rmq.evictQueueSession(queueName, session)
				return classifyAMQPError(err, ErrQueueNotFound)
			}

			return nil
		})
	})
}

func (rmq *Rmq) nackTimedOutMessage(record inFlightRecord) error {
	return rmq.withExistingQueueSession(record.QueueName, func(session *queueSession) error {
		if session.ch == nil || session.ch.IsClosed() {
			rmq.evictQueueSession(record.QueueName, session)
			return ErrRabbitUnavailable
		}

		if err := session.ch.Nack(record.DeliveryTag, false, true); err != nil {
			rmq.evictQueueSession(record.QueueName, session)
			return classifyAMQPError(err, ErrQueueNotFound)
		}

		return nil
	})
}

func (rmq *Rmq) withExistingQueueSession(queueName string, fn func(*queueSession) error) error {
	session, err := rmq.getExistingQueueSession(queueName)
	if err != nil {
		return err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	return fn(session)
}

func (rmq *Rmq) getExistingQueueSession(queueName string) (*queueSession, error) {
	rmq.mu.Lock()
	defer rmq.mu.Unlock()

	session, ok := rmq.queueSessions[queueName]
	if !ok || session == nil {
		return nil, ErrRabbitUnavailable
	}

	return session, nil
}

func (rmq *Rmq) getOrCreateQueueSession(queueName string) (*queueSession, error) {
	rmq.mu.Lock()
	defer rmq.mu.Unlock()

	if session, ok := rmq.queueSessions[queueName]; ok && session != nil && session.ch != nil && !session.ch.IsClosed() {
		return session, nil
	}

	if stale, ok := rmq.queueSessions[queueName]; ok && stale != nil && stale.ch != nil {
		_ = stale.ch.Close()
	}

	if rmq.conn == nil || rmq.conn.IsClosed() {
		return nil, ErrRabbitUnavailable
	}

	ch, err := rmq.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("%w: open queue session channel: %v", ErrRabbitUnavailable, err)
	}

	session := &queueSession{queueName: queueName, ch: ch}
	rmq.queueSessions[queueName] = session
	return session, nil
}

func (rmq *Rmq) evictQueueSession(queueName string, expected *queueSession) {
	rmq.mu.Lock()
	session, ok := rmq.queueSessions[queueName]
	if ok && (expected == nil || session == expected) {
		delete(rmq.queueSessions, queueName)
	}
	rmq.mu.Unlock()

	if ok && session != nil && session.ch != nil {
		_ = session.ch.Close()
	}
}

func (rmq *Rmq) openChannel() (*amqp.Channel, error) {
	rmq.mu.Lock()
	defer rmq.mu.Unlock()

	if rmq.conn == nil || rmq.conn.IsClosed() {
		return nil, ErrRabbitUnavailable
	}

	ch, err := rmq.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("%w: open rabbitmq channel: %v", ErrRabbitUnavailable, err)
	}

	return ch, nil
}

func decodeJSONBody(body []byte) (any, error) {
	var decoded any
	if err := json.Unmarshal(body, &decoded); err != nil {
		return nil, ErrInvalidMessageBody
	}

	return decoded, nil
}

func tableToMap(table amqp.Table) map[string]any {
	if len(table) == 0 {
		return nil
	}

	converted := make(map[string]any, len(table))
	for key, value := range table {
		converted[key] = value
	}

	return converted
}

func classifyAMQPError(err error, notFound error) error {
	if err == nil {
		return nil
	}

	var amqpErr *amqp.Error
	if errors.As(err, &amqpErr) {
		switch amqpErr.Code {
		case amqp.NotFound:
			return fmt.Errorf("%w: %v", notFound, err)
		case amqp.ChannelError, amqp.FrameError, amqp.SyntaxError:
			return fmt.Errorf("%w: %v", ErrRabbitUnavailable, err)
		default:
			return err
		}
	}

	if errors.Is(err, amqp.ErrClosed) || strings.Contains(strings.ToLower(err.Error()), "channel/connection is not open") {
		return fmt.Errorf("%w: %v", ErrRabbitUnavailable, err)
	}

	return err
}

func newMessageID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("msg-%d", time.Now().UnixNano())
	}

	return hex.EncodeToString(raw[:])
}
