package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/server/cmd"
	"github.com/Yongbeom-Kim/LocalAgent/server/services"
	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

const (
	rabbitmqImage       = "rabbitmq:3.13"
	rabbitmqAMQPPort    = "5672/tcp"
	defaultPollInterval = 50 * time.Millisecond
	topologyNameLimit   = 48
)

type testRabbitMQ struct {
	container testcontainers.Container
	url       string
	host      string
	port      string
	conn      *amqp.Connection
	channel   *amqp.Channel
}

type testApp struct {
	rmq    *services.Rmq
	router http.Handler
}

type testTopology struct {
	exchange   string
	queue      string
	routingKey string
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

type errorResponse struct {
	Error string `json:"error"`
}

type publishResponse struct {
	Status string `json:"status"`
}

func startRabbitMQ(t *testing.T) *testRabbitMQ {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)

	provider, err := testcontainers.NewDockerProvider()
	if err != nil {
		handleContainerRuntimeUnavailable(t, err)
	}
	t.Cleanup(func() {
		_ = provider.Close()
	})

	if err := provider.Health(ctx); err != nil {
		handleContainerRuntimeUnavailable(t, err)
	}

	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		Started: true,
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        rabbitmqImage,
			ExposedPorts: []string{rabbitmqAMQPPort},
			WaitingFor: wait.ForAll(
				wait.ForListeningPort(rabbitmqAMQPPort).WithPollInterval(100 * time.Millisecond),
			).WithDeadline(60 * time.Second),
		},
	})
	if err != nil {
		// Even after a provider health-check, Docker can be effectively unavailable
		// (daemon hung, socket timeouts). Only skip for clear runtime connectivity issues;
		// otherwise, treat it as a real test failure (image pull/startup/etc).
		if isContainerRuntimeUnavailableError(err) {
			handleContainerRuntimeUnavailable(t, err)
		}
		t.Fatalf("start rabbitmq container: %v", err)
	}

	t.Cleanup(func() {
		terminateCtx, terminateCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer terminateCancel()
		if termErr := container.Terminate(terminateCtx); termErr != nil {
			t.Fatalf("terminate rabbitmq container: %v", termErr)
		}
	})

	host, err := container.Host(ctx)
	if err != nil {
		t.Fatalf("get rabbitmq host: %v", err)
	}

	mappedPort, err := container.MappedPort(ctx, rabbitmqAMQPPort)
	if err != nil {
		t.Fatalf("get rabbitmq port: %v", err)
	}

	url := fmt.Sprintf("amqp://guest:guest@%s:%s/", host, mappedPort.Port())
	conn := waitForAMQPReady(t, url)
	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		t.Fatalf("open setup channel: %v", err)
	}

	rmq := &testRabbitMQ{
		container: container,
		url:       url,
		host:      host,
		port:      mappedPort.Port(),
		conn:      conn,
		channel:   ch,
	}

	t.Cleanup(func() {
		if rmq.channel != nil {
			_ = rmq.channel.Close()
		}
		if rmq.conn != nil && !rmq.conn.IsClosed() {
			_ = rmq.conn.Close()
		}
	})

	return rmq
}

func handleContainerRuntimeUnavailable(t *testing.T, err error) {
	t.Helper()

	msg := fmt.Sprintf("docker-compatible runtime unavailable for integration tests: %v", err)
	if strings.EqualFold(os.Getenv("CI"), "true") {
		t.Fatalf("%s", msg)
	}

	t.Skip(msg)
}

func isContainerRuntimeUnavailableError(err error) bool {
	if err == nil {
		return false
	}

	// testcontainers wraps a lot of errors; string matching is pragmatic here.
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "cannot connect to the docker daemon"):
		return true
	case strings.Contains(msg, "docker.sock") && (strings.Contains(msg, "context deadline exceeded") || strings.Contains(msg, "connection refused") || strings.Contains(msg, "no such file") || strings.Contains(msg, "permission denied")):
		return true
	case strings.Contains(msg, "dial unix") && (strings.Contains(msg, "no such file") || strings.Contains(msg, "permission denied")):
		return true
	case strings.Contains(msg, "error during connect") || strings.Contains(msg, "is the docker daemon running"):
		return true
	default:
		return false
	}
}

func waitForAMQPReady(t *testing.T, url string) *amqp.Connection {
	t.Helper()

	deadline := time.Now().Add(30 * time.Second)
	for {
		conn, err := amqp.Dial(url)
		if err == nil {
			return conn
		}
		if time.Now().After(deadline) {
			t.Fatalf("connect to rabbitmq at %s: %v", url, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func newTestApp(t *testing.T, rabbit *testRabbitMQ, visibilityTimeout time.Duration) *testApp {
	t.Helper()

	rmq := services.NewRmq(rabbit.url, visibilityTimeout)
	if err := rmq.Connect(10, 200*time.Millisecond); err != nil {
		t.Fatalf("connect service to rabbitmq: %v", err)
	}
	t.Cleanup(func() {
		if err := rmq.Close(); err != nil {
			t.Fatalf("close rmq service: %v", err)
		}
	})

	app := cmd.NewApp(rmq)
	return &testApp{rmq: rmq, router: app.Router()}
}

// declareTestTopology provisions explicit exchange, queue, and binding state for one test.
func declareTestTopology(t *testing.T, rabbit *testRabbitMQ) testTopology {
	t.Helper()

	base := sanitizeName(t.Name())
	exchange := fmt.Sprintf("%s-exchange", base)
	queue := fmt.Sprintf("%s-queue", base)
	routingKey := fmt.Sprintf("%s.route", base)

	if err := rabbit.channel.ExchangeDeclare(exchange, "topic", false, true, false, false, nil); err != nil {
		t.Fatalf("declare exchange %q: %v", exchange, err)
	}
	if _, err := rabbit.channel.QueueDeclare(queue, false, true, false, false, nil); err != nil {
		t.Fatalf("declare queue %q: %v", queue, err)
	}
	if err := rabbit.channel.QueueBind(queue, routingKey, exchange, false, nil); err != nil {
		t.Fatalf("bind queue %q to exchange %q: %v", queue, exchange, err)
	}

	return testTopology{exchange: exchange, queue: queue, routingKey: routingKey}
}

func publishDirectly(t *testing.T, rabbit *testRabbitMQ, exchange, routingKey string, body any) {
	t.Helper()

	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal direct publish body: %v", err)
	}

	if err := rabbit.channel.PublishWithContext(context.Background(), exchange, routingKey, false, false, amqp.Publishing{
		ContentType: "application/json",
		Body:        payload,
	}); err != nil {
		t.Fatalf("publish directly to %q: %v", exchange, err)
	}
}

// doJSONRequest drives the in-process router through httptest and returns the recorder for assertions.
func doJSONRequest(t *testing.T, handler http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()

	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body for %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(payload)
	}

	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func doRawRequest(t *testing.T, handler http.Handler, method, path, rawBody string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(method, path, strings.NewReader(rawBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func decodeJSONResponse[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()

	var payload T
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response body %q: %v", rec.Body.String(), err)
	}
	return payload
}

func assertStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d, body = %s", rec.Code, want, rec.Body.String())
	}
}

func assertErrorMessage(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantErr error) {
	t.Helper()

	assertStatus(t, rec, wantStatus)
	resp := decodeJSONResponse[errorResponse](t, rec)
	if !strings.Contains(resp.Error, wantErr.Error()) {
		t.Fatalf("error = %q, want substring %q", resp.Error, wantErr.Error())
	}
}

func pollUntil(t *testing.T, timeout time.Duration, fn func() (bool, error)) {
	t.Helper()

	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		ok, err := fn()
		if ok {
			return
		}
		if err != nil {
			lastErr = err
		}
		time.Sleep(defaultPollInterval)
	}

	if lastErr != nil {
		t.Fatalf("condition not met within %s: %v", timeout, lastErr)
	}
	t.Fatalf("condition not met within %s", timeout)
}

func readNextMessage(t *testing.T, handler http.Handler, queue string) (*httptest.ResponseRecorder, *queuedMessageResponse) {
	t.Helper()

	rec := doJSONRequest(t, handler, http.MethodGet, fmt.Sprintf("/queues/%s/messages/next", queue), nil)
	if rec.Code == http.StatusNoContent {
		return rec, nil
	}

	resp := decodeJSONResponse[queuedMessageResponse](t, rec)
	return rec, &resp
}

func sanitizeName(name string) string {
	replacer := strings.NewReplacer("/", "-", " ", "-", "_", "-")
	cleaned := replacer.Replace(strings.ToLower(name))
	b := strings.Builder{}
	b.Grow(len(cleaned))
	for _, r := range cleaned {
		switch {
		case r >= 'a' && r <= 'z':
			b.WriteRune(r)
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-':
			b.WriteRune(r)
		}
	}
	result := strings.Trim(b.String(), "-")
	if result == "" {
		result = "test"
	}
	if len(result) > topologyNameLimit {
		result = result[:topologyNameLimit]
	}
	return result
}

func assertNoMessageAvailable(t *testing.T, handler http.Handler, queue string) {
	t.Helper()

	rec, _ := readNextMessage(t, handler, queue)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected queue %q to be empty, got status %d with body %s", queue, rec.Code, rec.Body.String())
	}
}
