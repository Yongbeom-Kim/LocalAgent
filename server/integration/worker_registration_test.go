package integration

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	rabbitmqsvc "github.com/Yongbeom-Kim/LocalAgent/server/services/rabbitmq"
)

type registerStatusResponse struct {
	Status string `json:"status"`
}

func TestBootstrapJobTopologyDeclaresSharedJobExchanges(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)

	if err := rabbitmqsvc.BootstrapJobTopology(context.Background(), app.rmq); err != nil {
		t.Fatalf("bootstrap topology: %v", err)
	}

	assertExchangeExists(t, rabbit, rabbitmqsvc.JobsDirectExchange, "direct")
	assertExchangeExists(t, rabbit, rabbitmqsvc.JobsFanoutExchange, "fanout")
}

func TestRegisterWorkerCreatesQueueAndReturnsOK(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	rec := registerWorker(t, app.router, "alpha-01", map[string]any{"labels": []string{"gpu"}})
	assertStatus(t, rec, http.StatusOK)

	resp := decodeJSONResponse[registerStatusResponse](t, rec)
	if resp.Status != "ok" {
		t.Fatalf("status response = %q, want ok", resp.Status)
	}

	assertQueueExists(t, rabbit, rabbitmqsvc.WorkerQueueName("alpha-01"))
}

func TestRegisterWorkerAcceptsEmptyBody(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	rec := doJSONRequest(t, app.router, http.MethodPut, "/workers/alpha-empty/registration", nil)
	assertStatus(t, rec, http.StatusOK)
	assertQueueExists(t, rabbit, rabbitmqsvc.WorkerQueueName("alpha-empty"))
}

func TestRegisterWorkerRejectsInvalidWorkerID(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	rec := registerWorker(t, app.router, "alpha.01", map[string]any{})
	assertStatus(t, rec, http.StatusBadRequest)

	resp := decodeJSONResponse[errorResponse](t, rec)
	if resp.Error != "worker_id must match [A-Za-z0-9_-]+" {
		t.Fatalf("error = %q, want worker_id validation message", resp.Error)
	}
}

func TestRegisterWorkerRejectsMalformedJSON(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	rec := doRawRequest(t, app.router, http.MethodPut, "/workers/alpha-01/registration", `{`)
	assertStatus(t, rec, http.StatusBadRequest)

	resp := decodeJSONResponse[errorResponse](t, rec)
	if resp.Error != "invalid json body" {
		t.Fatalf("error = %q, want invalid json body", resp.Error)
	}
}

func TestRegisterWorkerReturns500IfSharedExchangesMissing(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)

	// Intentionally do NOT call bootstrapJobTopology.
	rec := registerWorker(t, app.router, "alpha-01", map[string]any{})
	assertStatus(t, rec, http.StatusInternalServerError)

	resp := decodeJSONResponse[errorResponse](t, rec)
	if !strings.Contains(resp.Error, "exchange not found") {
		t.Fatalf("error = %q, want exchange not found", resp.Error)
	}

	assertQueueMissing(t, rabbit, rabbitmqsvc.WorkerQueueName("alpha-01"))
}

func TestRegisterWorkerRollsBackQueueIfSecondBindFails(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	if err := rabbit.channel.ExchangeDelete(rabbitmqsvc.JobsFanoutExchange, false, false); err != nil {
		t.Fatalf("delete fanout exchange: %v", err)
	}

	rec := registerWorker(t, app.router, "rollback-worker", map[string]any{})
	assertStatus(t, rec, http.StatusInternalServerError)

	resp := decodeJSONResponse[errorResponse](t, rec)
	if !strings.Contains(resp.Error, "exchange not found") {
		t.Fatalf("error = %q, want exchange not found", resp.Error)
	}

	assertQueueMissing(t, rabbit, rabbitmqsvc.WorkerQueueName("rollback-worker"))
}

func TestRegisterWorkerIsIdempotentAcrossHeartbeats(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	first := registerWorker(t, app.router, "heartbeat-worker", map[string]any{})
	assertStatus(t, first, http.StatusOK)

	second := registerWorker(t, app.router, "heartbeat-worker", map[string]any{"capabilities": []string{"text"}})
	assertStatus(t, second, http.StatusOK)

	rec := doJSONRequest(t, app.router, http.MethodPost, "/exchanges/"+rabbitmqsvc.JobsDirectExchange+"/messages", map[string]any{
		"routing_key": "heartbeat-worker",
		"body":        map[string]any{"id": 7},
	})
	assertStatus(t, rec, http.StatusAccepted)

	dequeueRec, message := readNextMessage(t, app.router, rabbitmqsvc.WorkerQueueName("heartbeat-worker"))
	assertStatus(t, dequeueRec, http.StatusOK)
	if message == nil {
		t.Fatal("expected dequeued message")
	}
}

func TestDirectPublishRoutesToMatchingWorkerQueue(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	assertStatus(t, registerWorker(t, app.router, "alpha-01", map[string]any{}), http.StatusOK)
	assertStatus(t, registerWorker(t, app.router, "beta-02", map[string]any{}), http.StatusOK)

	pubRec := doJSONRequest(t, app.router, http.MethodPost, "/exchanges/"+rabbitmqsvc.JobsDirectExchange+"/messages", map[string]any{
		"routing_key": "alpha-01",
		"body":        map[string]any{"kind": "targeted"},
	})
	assertStatus(t, pubRec, http.StatusAccepted)

	dequeueRec, message := readNextMessage(t, app.router, rabbitmqsvc.WorkerQueueName("alpha-01"))
	assertStatus(t, dequeueRec, http.StatusOK)
	if message == nil {
		t.Fatal("expected direct message")
	}

	body, ok := message.Body.(map[string]any)
	if !ok || body["kind"] != "targeted" {
		t.Fatalf("body = %#v, want kind=targeted", message.Body)
	}

	assertNoMessageAvailable(t, app.router, rabbitmqsvc.WorkerQueueName("beta-02"))
}

func TestFanoutPublishRoutesToRegisteredWorkerQueue(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	bootstrapJobTopology(t, app)

	assertStatus(t, registerWorker(t, app.router, "fanout-worker", map[string]any{}), http.StatusOK)

	pubRec := doJSONRequest(t, app.router, http.MethodPost, "/exchanges/"+rabbitmqsvc.JobsFanoutExchange+"/messages", map[string]any{
		"routing_key": "ignored",
		"body":        map[string]any{"kind": "broadcast"},
	})
	assertStatus(t, pubRec, http.StatusAccepted)

	dequeueRec, message := readNextMessage(t, app.router, rabbitmqsvc.WorkerQueueName("fanout-worker"))
	assertStatus(t, dequeueRec, http.StatusOK)
	if message == nil {
		t.Fatal("expected fanout message")
	}

	body, ok := message.Body.(map[string]any)
	if !ok || body["kind"] != "broadcast" {
		t.Fatalf("body = %#v, want kind=broadcast", message.Body)
	}
}
