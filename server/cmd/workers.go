package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"time"

	rabbitmqsvc "github.com/Yongbeom-Kim/LocalAgent/server/services/rabbitmq"
	"github.com/Yongbeom-Kim/LocalAgent/server/utils"
)

var workerIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func (a *App) handleRegisterWorker(w http.ResponseWriter, r *http.Request) {
	workerID := r.PathValue("worker_id")
	if !workerIDPattern.MatchString(workerID) {
		utils.WriteJSONError(w, http.StatusBadRequest, "worker_id must match [A-Za-z0-9_-]+")
		return
	}

	var req registerWorkerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		utils.WriteJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}

	queueOpts := rabbitmqsvc.WorkerQueueDeclareOptions(workerID)
	queueExists, err := a.rmq.QueueExists(r.Context(), queueOpts.Name)
	if err != nil {
		writeWorkerRegistrationError(w, err)
		return
	}

	if _, err := a.rmq.DeclareQueue(r.Context(), queueOpts); err != nil {
		writeWorkerRegistrationError(w, err)
		return
	}

	if err := a.rmq.BindQueue(r.Context(), rabbitmqsvc.QueueBindOptions{
		QueueName:  queueOpts.Name,
		Exchange:   rabbitmqsvc.JobsDirectExchange,
		RoutingKey: workerID,
	}); err != nil {
		rollbackWorkerRegistration(rmqCleanupContext(), a.rmq, queueOpts.Name, queueExists, &err)
		writeWorkerRegistrationError(w, err)
		return
	}

	if err := a.rmq.BindQueue(r.Context(), rabbitmqsvc.QueueBindOptions{
		QueueName: queueOpts.Name,
		Exchange:  rabbitmqsvc.JobsFanoutExchange,
	}); err != nil {
		rollbackWorkerRegistration(rmqCleanupContext(), a.rmq, queueOpts.Name, queueExists, &err)
		writeWorkerRegistrationError(w, err)
		return
	}

	utils.WriteJSON(w, http.StatusOK, statusResponse{Status: "ok"})
}

func writeWorkerRegistrationError(w http.ResponseWriter, err error) {
	if errors.Is(err, rabbitmqsvc.ErrExchangeNotFound) {
		utils.WriteJSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	writeServiceError(w, err)
}

func rollbackWorkerRegistration(ctx context.Context, rmq RmqLike, queueName string, queueExisted bool, opErr *error) {
	if queueExisted || opErr == nil || *opErr == nil {
		return
	}

	if cleanupErr := rmq.DeleteQueue(ctx, queueName); cleanupErr != nil {
		*opErr = fmt.Errorf("%w: rollback worker queue %q: %v", *opErr, queueName, cleanupErr)
	}
}

func rmqCleanupContext() context.Context {
	ctx, _ := context.WithTimeout(context.Background(), 5*time.Second)
	return ctx
}
