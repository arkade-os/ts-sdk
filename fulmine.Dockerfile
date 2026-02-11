# Build the web interface
FROM node:22 AS web-builder

WORKDIR /app
RUN git clone -b master --single-branch https://github.com/ArkLabsHQ/fulmine.git
WORKDIR /app/fulmine/internal/interface/web
RUN rm -rf .parcel-cache && yarn && yarn build

# Build the Go application
FROM golang:1.25.5 AS go-builder

ARG VERSION
ARG COMMIT
ARG DATE
ARG TARGETOS
ARG TARGETARCH
ARG SENTRY_DSN

WORKDIR /app

RUN git clone -b delegator --single-branch https://github.com/louisinger/fulmine.git
WORKDIR /app/fulmine

# Copy the built web assets from web-builder
COPY --from=web-builder /app/fulmine/internal/interface/web/static ./internal/interface/web/static
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -ldflags="-X 'main.version=${VERSION}' -X 'main.commit=${COMMIT}' -X 'main.date=${DATE}' -X 'main.sentryDsn=${SENTRY_DSN}'" -o bin/fulmine cmd/fulmine/main.go

# Final image
FROM alpine:3.20

WORKDIR /app

COPY --from=go-builder /app/fulmine/bin/* /app

ENV PATH="/app:${PATH}"
ENV FULMINE_DATADIR=/app/data

VOLUME /app/data

ENTRYPOINT [ "fulmine" ]

