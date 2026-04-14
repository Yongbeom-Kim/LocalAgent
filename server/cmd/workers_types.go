package cmd

type registerWorkerRequest struct{}

type statusResponse struct {
	Status string `json:"status"`
}
