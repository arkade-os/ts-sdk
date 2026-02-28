FROM alpine:3.22

ARG INTROSPECTOR_VERSION=v0.0.1-rc.0

RUN apk update && apk upgrade && apk add --no-cache curl

WORKDIR /app

RUN curl -fsSL \
    "https://github.com/ArkLabsHQ/introspector/releases/download/${INTROSPECTOR_VERSION}/introspector-linux-amd64" \
    -o /app/introspector && \
    chmod +x /app/introspector

ENV PATH="/app:${PATH}"

EXPOSE 7073

ENTRYPOINT [ "introspector" ]
