package integration

import (
	"net/http"
	"testing"
	"time"
)

func TestVisibilityTimeoutRedelivery(t *testing.T) {
	rabbit := startRabbitMQ(t)
	app := newTestApp(t, rabbit, 1*time.Second)
	topology := declareTestTopology(t, rabbit)

	publishDirectly(t, rabbit, topology.exchange, topology.routingKey, map[string]any{"id": 99})
	firstRec, first := readNextMessage(t, app.router, topology.queue)
	assertStatus(t, firstRec, http.StatusOK)
	if first == nil {
		t.Fatal("expected first delivery")
	}

	var redelivery *queuedMessageResponse
	pollUntil(t, 5*time.Second, func() (bool, error) {
		dequeueRec, next := readNextMessage(t, app.router, topology.queue)
		if dequeueRec.Code == http.StatusNoContent {
			return false, nil
		}
		if dequeueRec.Code != http.StatusOK {
			return false, nil
		}
		if next == nil {
			return false, nil
		}
		redelivery = next
		return true, nil
	})

	if redelivery == nil {
		t.Fatal("expected redelivery")
	}
	if !redelivery.Redelivered {
		t.Fatal("redelivered = false, want true after visibility timeout")
	}
	if redelivery.MessageID == first.MessageID {
		t.Fatalf("message_id reused across redelivery: %s", redelivery.MessageID)
	}

	cleanupRec := doJSONRequest(t, app.router, http.MethodDelete, "/queues/"+topology.queue+"/messages/"+redelivery.MessageID, nil)
	assertStatus(t, cleanupRec, http.StatusNoContent)
}
