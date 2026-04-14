package integration

import (
	"net/http"
	"testing"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/server/services"
)

func TestPublishMessageAccepted(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 3*time.Second)
	topology := declareTestTopology(t, rabbit)

	rec := doJSONRequest(t, app.router, http.MethodPost, "/exchanges/"+topology.exchange+"/messages", map[string]any{
		"routing_key": topology.routingKey,
		"body": map[string]any{
			"id":   1,
			"kind": "created",
		},
		"headers": map[string]any{
			"x-request-id": "req-1",
		},
	})

	assertStatus(t, rec, http.StatusAccepted)
	resp := decodeJSONResponse[publishResponse](t, rec)
	if resp.Status != "accepted" {
		t.Fatalf("status response = %q, want accepted", resp.Status)
	}

	dequeueRec, message := readNextMessage(t, app.router, topology.queue)
	assertStatus(t, dequeueRec, http.StatusOK)
	if message == nil {
		t.Fatal("expected dequeued message")
	}
	if message.RoutingKey != topology.routingKey {
		t.Fatalf("routing_key = %q, want %q", message.RoutingKey, topology.routingKey)
	}
	body, ok := message.Body.(map[string]any)
	if !ok {
		t.Fatalf("body type = %T, want map[string]any", message.Body)
	}
	if body["kind"] != "created" {
		t.Fatalf("body = %#v, want kind=created", body)
	}
	if message.Headers["x-request-id"] != "req-1" {
		t.Fatalf("headers = %#v, want x-request-id=req-1", message.Headers)
	}
}

func TestGetNextMessageIncludesVisibilityMetadata(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	topology := declareTestTopology(t, rabbit)

	publishDirectly(t, rabbit, topology.exchange, topology.routingKey, map[string]any{"id": 42})
	dequeueStarted := time.Now().UTC()

	rec, message := readNextMessage(t, app.router, topology.queue)
	assertStatus(t, rec, http.StatusOK)
	if message == nil {
		t.Fatal("expected dequeued message")
	}
	if message.MessageID == "" {
		t.Fatal("message_id should not be empty")
	}
	if message.RoutingKey != topology.routingKey {
		t.Fatalf("routing_key = %q, want %q", message.RoutingKey, topology.routingKey)
	}
	if message.Redelivered {
		t.Fatal("redelivered = true, want false on first delivery")
	}
	if !message.VisibleUntil.After(dequeueStarted) {
		t.Fatalf("visible_until = %s, want after %s", message.VisibleUntil, dequeueStarted)
	}
	upperBound := dequeueStarted.Add(3 * time.Second)
	if message.VisibleUntil.After(upperBound) {
		t.Fatalf("visible_until = %s, want before %s", message.VisibleUntil, upperBound)
	}
}

func TestPublishMessageMissingExchange(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)

	rec := doJSONRequest(t, app.router, http.MethodPost, "/exchanges/missing-exchange/messages", map[string]any{
		"routing_key": "orders.created",
		"body":        map[string]any{"id": 1},
	})

	assertErrorMessage(t, rec, http.StatusNotFound, services.ErrExchangeNotFound)
}

func TestGetNextMessageMissingQueue(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)

	rec := doJSONRequest(t, app.router, http.MethodGet, "/queues/missing-queue/messages/next", nil)
	assertErrorMessage(t, rec, http.StatusNotFound, services.ErrQueueNotFound)
}

func TestPublishMessageMalformedJSON(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	topology := declareTestTopology(t, rabbit)

	rec := doRawRequest(t, app.router, http.MethodPost, "/exchanges/"+topology.exchange+"/messages", `{`)
	assertStatus(t, rec, http.StatusBadRequest)
	resp := decodeJSONResponse[errorResponse](t, rec)
	if resp.Error != "invalid json body" {
		t.Fatalf("error = %q, want invalid json body", resp.Error)
	}
}
