package models

import (
	"net/url"
	"time"
)

type Config struct {
	WorkerID          string
	QueueName         string
	ServerURL         *url.URL
	PollInterval      time.Duration
	HeartbeatInterval time.Duration
}

type QueuedMessage struct {
	MessageID    string         `json:"message_id"`
	Body         any            `json:"body"`
	Headers      map[string]any `json:"headers,omitempty"`
	RoutingKey   string         `json:"routing_key"`
	ContentType  string         `json:"content_type,omitempty"`
	Redelivered  bool           `json:"redelivered"`
	VisibleUntil time.Time      `json:"visible_until"`
}
