FROM golang:1.26-alpine

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN go build -o /usr/local/bin/localagent-server ./

EXPOSE 8080

CMD ["/usr/local/bin/localagent-server"]
