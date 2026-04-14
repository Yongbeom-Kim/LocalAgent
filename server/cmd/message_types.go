package cmd

import "time"

type publishMessageRequest struct {
	RoutingKey  string         `json:"routing_key"`
	Body        any            `json:"body"`
	Headers     map[string]any `json:"headers"`
	ContentType string         `json:"content_type"`
}

type queuedMessageResponse struct {
	MessageID    string         `json:"message_id"`
	Body         any            `json:"body"`
	Headers      map[string]any `json:"headers,omitempty"`
	RoutingKey   string         `json:"routing_key"`
	ContentType  string         `json:"content_type,omitempty"`
	Redelivered  bool           `json:"redelivered"`
	VisibleUntil time.Time      `json:"visible_until"`
}

type nackMessageRequest struct {
	Requeue bool `json:"requeue"`
}

type errorResponse struct {
	Error string `json:"error"`
}
