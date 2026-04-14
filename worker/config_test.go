package main

import "testing"

func TestLoadConfigRequiresWorkerID(t *testing.T) {
	t.Setenv("WORKER_ID", "")

	_, err := LoadFromEnv()
	if err == nil || err.Error() != "WORKER_ID is required" {
		t.Fatalf("err = %v, want WORKER_ID is required", err)
	}
}

func TestLoadConfigRejectsInvalidWorkerID(t *testing.T) {
	t.Setenv("WORKER_ID", "bad.id")

	_, err := LoadFromEnv()
	if err == nil || err.Error() != "WORKER_ID must match [A-Za-z0-9_-]+" {
		t.Fatalf("err = %v, want worker id validation error", err)
	}
}

func TestLoadConfigRejectsInvalidServerURL(t *testing.T) {
	t.Setenv("WORKER_ID", "alpha-01")
	t.Setenv("SERVER_URL", "://bad")

	_, err := LoadFromEnv()
	if err == nil || err.Error() != `SERVER_URL is invalid: "://bad"` {
		t.Fatalf("err = %v, want invalid server url", err)
	}
}

func TestLoadConfigRejectsInvalidDurations(t *testing.T) {
	t.Setenv("WORKER_ID", "alpha-01")
	t.Setenv("POLL_INTERVAL", "nope")

	_, err := LoadFromEnv()
	if err == nil || err.Error() != `POLL_INTERVAL is invalid: "nope"` {
		t.Fatalf("err = %v, want invalid duration error", err)
	}
}

func TestLoadConfigUsesDefaults(t *testing.T) {
	t.Setenv("WORKER_ID", "alpha-01")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv error = %v", err)
	}

	if cfg.QueueName != "worker.alpha-01" {
		t.Fatalf("queue name = %q, want worker.alpha-01", cfg.QueueName)
	}
	if cfg.ServerURL.String() != defaultServerURL {
		t.Fatalf("server url = %q, want %q", cfg.ServerURL.String(), defaultServerURL)
	}
	if cfg.PollInterval != defaultPollInterval {
		t.Fatalf("poll interval = %s, want %s", cfg.PollInterval, defaultPollInterval)
	}
	if cfg.HeartbeatInterval != defaultHeartbeatInterval {
		t.Fatalf("heartbeat interval = %s, want %s", cfg.HeartbeatInterval, defaultHeartbeatInterval)
	}
}
