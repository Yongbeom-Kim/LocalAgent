package services

import (
	"sync"
	"time"
)

type inFlightRecord struct {
	MessageID    string
	QueueName    string
	DeliveryTag  uint64
	VisibleUntil time.Time

	completed bool
	timer     *time.Timer
	onTimeout func(inFlightRecord)
}

type inFlightRegistry struct {
	timeout time.Duration
	now     func() time.Time
	newID   func() string

	mu   sync.Mutex
	byID map[string]*inFlightRecord
}

func newInFlightRegistry(timeout time.Duration) *inFlightRegistry {
	if timeout <= 0 {
		timeout = defaultVisibilityTimeout
	}

	return &inFlightRegistry{
		timeout: timeout,
		now:     time.Now,
		newID:   newMessageID,
		byID:    make(map[string]*inFlightRecord),
	}
}

func (r *inFlightRegistry) HasMessage(messageID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	_, ok := r.byID[messageID]
	return ok
}

func (r *inFlightRegistry) Register(queueName string, deliveryTag uint64, onTimeout func(inFlightRecord)) (inFlightRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	messageID := r.newID()
	visibleUntil := r.now().Add(r.timeout).UTC()
	record := &inFlightRecord{
		MessageID:    messageID,
		QueueName:    queueName,
		DeliveryTag:  deliveryTag,
		VisibleUntil: visibleUntil,
		onTimeout:    onTimeout,
	}

	record.timer = time.AfterFunc(r.timeout, func() {
		r.expire(messageID)
	})

	r.byID[messageID] = record

	return *record, nil
}

func (r *inFlightRegistry) Complete(queueName, messageID string, fn func(inFlightRecord) error) error {
	record, err := r.claim(queueName, messageID)
	if err != nil {
		return err
	}

	if fn == nil {
		r.finish(record)
		return nil
	}

	if err := fn(record); err != nil {
		r.release(record)
		return err
	}

	r.finish(record)
	return nil
}

func (r *inFlightRegistry) claim(queueName, messageID string) (inFlightRecord, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	record, ok := r.byID[messageID]
	if !ok {
		return inFlightRecord{}, ErrMessageNotFound
	}
	if record.QueueName != queueName {
		return inFlightRecord{}, ErrMessageQueueMismatch
	}
	if record.completed {
		return inFlightRecord{}, ErrMessageNotFound
	}

	record.completed = true
	if record.timer != nil {
		record.timer.Stop()
	}

	return *record, nil
}


func (r *inFlightRegistry) finish(record inFlightRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if current, ok := r.byID[record.MessageID]; ok {
		current.completed = true
		if current.timer != nil {
			current.timer.Stop()
		}
	}

	delete(r.byID, record.MessageID)
}

func (r *inFlightRegistry) release(record inFlightRecord) {
	r.mu.Lock()
	defer r.mu.Unlock()

	current, ok := r.byID[record.MessageID]
	if !ok {
		return
	}

	current.completed = false
	if current.timer != nil {
		current.timer = time.AfterFunc(time.Until(current.VisibleUntil), func() {
			r.expire(record.MessageID)
		})
	}
}

func (r *inFlightRegistry) expire(messageID string) {
	r.mu.Lock()
	record, ok := r.byID[messageID]
	if !ok || record.completed {
		r.mu.Unlock()
		return
	}
	record.completed = true

	delete(r.byID, messageID)
	callback := record.onTimeout
	copyRecord := *record
	r.mu.Unlock()

	if callback != nil {
		callback(copyRecord)
	}
}
