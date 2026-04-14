package cmd

import "net/http"

func (a *App) HandleHealth(w http.ResponseWriter, r *http.Request) {
	if !a.rmq.Healthy() {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("UNHEALTHY"))
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("OK"))
}
