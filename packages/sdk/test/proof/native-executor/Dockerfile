FROM --platform=$BUILDPLATFORM golang:1.26.9 AS builder
WORKDIR /src
RUN git init && git remote add origin https://github.com/arkade-os/arkd.git && \
    git fetch --depth=1 origin e0cbfd5d9c6dfc56924d39284edfa76ca8c5cbdd && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = e0cbfd5d9c6dfc56924d39284edfa76ca8c5cbdd
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath \
    -ldflags="-X main.Version=executor-one-shot-e0cbfd5d" -o /arkd ./cmd/arkd
FROM alpine:3.24
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /arkd /app/arkd
ENV ARKD_DATADIR=/app/data
ENTRYPOINT ["/app/arkd"]
