package cmd

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/Yongbeom-Kim/LocalAgent/server/services"
	"github.com/Yongbeom-Kim/LocalAgent/server/utils"
	amqp "github.com/rabbitmq/amqp091-go"
)

func (a *App) handlePublishMessage(w http.ResponseWriter, r *http.Request) {
	exchangeName := r.PathValue("exchange")
	if exchangeName == "" {
		utils.WriteJSONError(w, http.StatusBadRequest, "exchange name is required")
		return
	}

	var req publishMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if strings.TrimSpace(req.RoutingKey) == "" {
		utils.WriteJSONError(w, http.StatusBadRequest, "routing_key is required")
		return
	}

	body, err := json.Marshal(req.Body)
	if err != nil {
		utils.WriteJSONError(w, http.StatusBadRequest, "body must be valid json")
		return
	}

	contentType := req.ContentType
	if contentType == "" {
		contentType = "application/json"
	}

	if err := a.rmq.PublishMessage(r.Context(), services.PublishMessageOptions{
		ExchangeName: exchangeName,
		RoutingKey:   req.RoutingKey,
		Body:         body,
		Headers:      toAMQPTable(req.Headers),
		ContentType:  contentType,
	}); err != nil {
		writeServiceError(w, err)
		return
	}

	utils.WriteJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}


func (a *App) handleGetNextMessage(w http.ResponseWriter, r *http.Request) {
	queueName := r.PathValue("queue")
	if queueName == "" {
		utils.WriteJSONError(w, http.StatusBadRequest, "queue name is required")
		return
	}
	message, err := a.rmq.GetNextMessage(r.Context(), queueName)
	if err != nil {
		if errors.Is(err, services.ErrEmptyQueue) {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		writeServiceError(w, err)
		return
	}

	utils.WriteJSON(w, http.StatusOK, queuedMessageResponse{
		MessageID:    message.MessageID,
		Body:         message.Body,
		Headers:      message.Headers,
		RoutingKey:   message.RoutingKey,
		ContentType:  message.ContentType,
		Redelivered:  message.Redelivered,
		VisibleUntil: message.VisibleUntil,
	})
}


func (a *App) handleAckMessage(w http.ResponseWriter, r *http.Request) {
	queueName := r.PathValue("queue")
	if queueName == "" {
		utils.WriteJSONError(w, http.StatusBadRequest, "queue name is required")
		return
	}

	messageID := r.PathValue("message_id")
	if messageID == "" {
		utils.WriteJSONError(w, http.StatusBadRequest, "message id is required")
		return
	}

	if err := a.rmq.AckMessage(r.Context(), queueName, messageID); err != nil {
		writeServiceError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}


func (a *App) handleNackMessage(w http.ResponseWriter, r *http.Request) {
	queueName := r.PathValue("queue")
	if queueName == "" {
		utils.WriteJSONError(w, http.StatusBadRequest, "queue name is required")
		return
	}

	messageID := r.PathValue("message_id")
	if messageID == "" {
		utils.WriteJSONError(w, http.StatusBadRequest, "message id is required")
		return
	}

	var req nackMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		utils.WriteJSONError(w, http.StatusBadRequest, "invalid json body")
		return
	}

	if err := a.rmq.NackMessage(r.Context(), queueName, messageID, req.Requeue); err != nil {
		writeServiceError(w, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func writeServiceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, services.ErrExchangeNotFound), errors.Is(err, services.ErrQueueNotFound):
		utils.WriteJSONError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, services.ErrMessageQueueMismatch):
		utils.WriteJSONError(w, http.StatusConflict, err.Error())
	case errors.Is(err, services.ErrMessageNotFound):
		utils.WriteJSONError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, services.ErrRabbitUnavailable):
		utils.WriteJSONError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, services.ErrInvalidMessageBody):
		utils.WriteJSONError(w, http.StatusInternalServerError, err.Error())
	default:
		utils.WriteJSONError(w, http.StatusInternalServerError, err.Error())
	}
}

func toAMQPTable(headers map[string]any) amqp.Table {
	if len(headers) == 0 {
		return nil
	}

	table := make(amqp.Table, len(headers))
	for key, value := range headers {
		table[key] = value
	}

	return table
}
