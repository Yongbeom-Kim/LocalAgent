package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"time"

	"github.com/Yongbeom-Kim/LocalAgent/worker/models"
)

const (
	defaultServerURL         = "http://localhost:8080"
	defaultPollInterval      = time.Second
	defaultHeartbeatInterval = 5 * time.Second
	workerQueuePrefix        = "worker."
)

var workerIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func LoadFromEnv() (models.Config, error) {
	workerID := os.Getenv("WORKER_ID")
	if workerID == "" {
		return models.Config{}, errors.New("WORKER_ID is required")
	}
	if !workerIDPattern.MatchString(workerID) {
		return models.Config{}, errors.New("WORKER_ID must match [A-Za-z0-9_-]+")
	}

	serverURLValue := os.Getenv("SERVER_URL")
	if serverURLValue == "" {
		serverURLValue = defaultServerURL
	}
	serverURL, err := url.Parse(serverURLValue)
	if err != nil || serverURL.Scheme == "" || serverURL.Host == "" {
		return models.Config{}, fmt.Errorf("SERVER_URL is invalid: %q", serverURLValue)
	}

	pollInterval, err := loadDuration("POLL_INTERVAL", defaultPollInterval)
	if err != nil {
		return models.Config{}, err
	}

	heartbeatInterval, err := loadDuration("HEARTBEAT_INTERVAL", defaultHeartbeatInterval)
	if err != nil {
		return models.Config{}, err
	}

	return models.Config{
		WorkerID:          workerID,
		QueueName:         workerQueuePrefix + workerID,
		ServerURL:         serverURL,
		PollInterval:      pollInterval,
		HeartbeatInterval: heartbeatInterval,
	}, nil
}

func loadDuration(key string, fallback time.Duration) (time.Duration, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}

	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s is invalid: %q", key, value)
	}

	if parsed <= 0 {
		return 0, fmt.Errorf("%s must be positive", key)
	}

	return parsed, nil
}
