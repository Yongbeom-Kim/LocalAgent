package integration

import (
	"net/http"
	"testing"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/server/services"
)

func TestAckMessageRemovesDelivery(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	topology := declareTestTopology(t, rabbit)

	publishDirectly(t, rabbit, topology.exchange, topology.routingKey, map[string]any{"id": 1})
	_, message := readNextMessage(t, app.router, topology.queue)
	if message == nil {
		t.Fatal("expected dequeued message")
	}

	rec := doJSONRequest(t, app.router, http.MethodDelete, "/queues/"+topology.queue+"/messages/"+message.MessageID, nil)
	assertStatus(t, rec, http.StatusNoContent)
	assertNoMessageAvailable(t, app.router, topology.queue)
}

func TestNackMessageRequeueTrueMakesMessageAvailableAgain(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	topology := declareTestTopology(t, rabbit)

	publishDirectly(t, rabbit, topology.exchange, topology.routingKey, map[string]any{"id": 2})
	_, first := readNextMessage(t, app.router, topology.queue)
	if first == nil {
		t.Fatal("expected first delivery")
	}

	rec := doJSONRequest(t, app.router, http.MethodPost, "/queues/"+topology.queue+"/messages/"+first.MessageID+"/nack", map[string]any{"requeue": true})
	assertStatus(t, rec, http.StatusNoContent)

	pollUntil(t, 5*time.Second, func() (bool, error) {
		dequeueRec, redelivery := readNextMessage(t, app.router, topology.queue)
		if dequeueRec.Code == http.StatusNoContent {
			return false, nil
		}
		if dequeueRec.Code != http.StatusOK {
			return false, nil
		}
		if redelivery == nil {
			return false, nil
		}
		if !redelivery.Redelivered {
			t.Fatalf("redelivered = false, want true after nack requeue")
		}
		if redelivery.MessageID == first.MessageID {
			t.Fatalf("message_id reused after requeue: %s", redelivery.MessageID)
		}
		return true, nil
	})
}

func TestNackMessageRequeueFalseDropsDelivery(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 1500*time.Millisecond)
	topology := declareTestTopology(t, rabbit)

	publishDirectly(t, rabbit, topology.exchange, topology.routingKey, map[string]any{"id": 3})
	_, message := readNextMessage(t, app.router, topology.queue)
	if message == nil {
		t.Fatal("expected dequeued message")
	}

	rec := doJSONRequest(t, app.router, http.MethodPost, "/queues/"+topology.queue+"/messages/"+message.MessageID+"/nack", map[string]any{"requeue": false})
	assertStatus(t, rec, http.StatusNoContent)

	pollUntil(t, 1500*time.Millisecond, func() (bool, error) {
		dequeueRec, _ := readNextMessage(t, app.router, topology.queue)
		if dequeueRec.Code == http.StatusNoContent {
			return true, nil
		}
		return false, nil
	})
}

func TestAckMessageUnknownMessageID(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	topology := declareTestTopology(t, rabbit)

	rec := doJSONRequest(t, app.router, http.MethodDelete, "/queues/"+topology.queue+"/messages/missing", nil)
	assertErrorMessage(t, rec, http.StatusNotFound, services.ErrMessageNotFound)
}

func TestAckAndNackWrongQueueReturnConflict(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	primary := declareTestTopology(t, rabbit)
	other := testTopology{
		exchange:   primary.exchange + "-other",
		queue:      primary.queue + "-other",
		routingKey: primary.routingKey + ".other",
	}

	if err := rabbit.channel.ExchangeDeclare(other.exchange, "topic", false, true, false, false, nil); err != nil {
		t.Fatalf("declare other exchange: %v", err)
	}
	if _, err := rabbit.channel.QueueDeclare(other.queue, false, true, false, false, nil); err != nil {
		t.Fatalf("declare other queue: %v", err)
	}

	publishDirectly(t, rabbit, primary.exchange, primary.routingKey, map[string]any{"id": 4})
	_, message := readNextMessage(t, app.router, primary.queue)
	if message == nil {
		t.Fatal("expected dequeued message")
	}

	ackRec := doJSONRequest(t, app.router, http.MethodDelete, "/queues/"+other.queue+"/messages/"+message.MessageID, nil)
	assertErrorMessage(t, ackRec, http.StatusConflict, services.ErrMessageQueueMismatch)

	nackRec := doJSONRequest(t, app.router, http.MethodPost, "/queues/"+other.queue+"/messages/"+message.MessageID+"/nack", map[string]any{"requeue": true})
	assertErrorMessage(t, nackRec, http.StatusConflict, services.ErrMessageQueueMismatch)

	cleanupRec := doJSONRequest(t, app.router, http.MethodPost, "/queues/"+primary.queue+"/messages/"+message.MessageID+"/nack", map[string]any{"requeue": false})
	assertStatus(t, cleanupRec, http.StatusNoContent)
}

func TestNackMessageMalformedJSON(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 2*time.Second)
	topology := declareTestTopology(t, rabbit)

	publishDirectly(t, rabbit, topology.exchange, topology.routingKey, map[string]any{"id": 5})
	_, message := readNextMessage(t, app.router, topology.queue)
	if message == nil {
		t.Fatal("expected dequeued message")
	}

	rec := doRawRequest(t, app.router, http.MethodPost, "/queues/"+topology.queue+"/messages/"+message.MessageID+"/nack", `{`)
	assertStatus(t, rec, http.StatusBadRequest)
	resp := decodeJSONResponse[errorResponse](t, rec)
	if resp.Error != "invalid json body" {
		t.Fatalf("error = %q, want invalid json body", resp.Error)
	}

	cleanupRec := doJSONRequest(t, app.router, http.MethodPost, "/queues/"+topology.queue+"/messages/"+message.MessageID+"/nack", map[string]any{"requeue": false})
	assertStatus(t, cleanupRec, http.StatusNoContent)
}
