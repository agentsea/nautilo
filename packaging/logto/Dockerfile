# syntax=docker/dockerfile:1.7

ARG LOGTO_IMAGE=ghcr.io/logto-io/logto@sha256:aa4c428b70d9dd8eac23b6eeb3826a02d5fe0283b5dd774589b9b9760e0c6e9f
ARG NODE_IMAGE=docker.io/library/node@sha256:206878a60dc7014193f418ab9259b6110c15fbd514b3044a267be706509944e4

# Fetch the signed Alpine package over HTTPS, then bind the bytes to the
# independently recorded repository hash for the selected target architecture.
FROM --platform=$TARGETPLATFORM ${NODE_IMAGE} AS trust-package
ARG TARGETARCH
ARG CA_CERTIFICATES_VERSION=20261020-r0
ARG CA_APK_X86_64_SHA256=a4c5de1bf37652cd98cbe71aec209512ae0508a964961957a6c9650f795e46c4
ARG CA_APK_AARCH64_SHA256=bdf6033710a251d8239f63236eacf40c84afdf8f7b25bb58d69a2c75202350e7
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) apk_arch=x86_64; apk_sha256="$CA_APK_X86_64_SHA256" ;; \
      arm64) apk_arch=aarch64; apk_sha256="$CA_APK_AARCH64_SHA256" ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apk_url="https://dl-cdn.alpinelinux.org/alpine/v3.23/main/${apk_arch}/ca-certificates-bundle-${CA_CERTIFICATES_VERSION}.apk"; \
    wget -q -O /tmp/ca-certificates-bundle.apk "$apk_url"; \
    echo "${apk_sha256}  /tmp/ca-certificates-bundle.apk" | sha256sum -c -

FROM --platform=$TARGETPLATFORM ${LOGTO_IMAGE}
ARG TARGETARCH
ARG CA_CERTIFICATES_VERSION=20261020-r0
ARG CA_APK_X86_64_SHA256=a4c5de1bf37652cd98cbe71aec209512ae0508a964961957a6c9650f795e46c4
ARG CA_APK_AARCH64_SHA256=bdf6033710a251d8239f63236eacf40c84afdf8f7b25bb58d69a2c75202350e7
COPY --from=trust-package /usr/local/bin/node /usr/local/bin/node
COPY --from=trust-package /tmp/ca-certificates-bundle.apk /tmp/ca-certificates-bundle.apk
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) apk_sha256="$CA_APK_X86_64_SHA256" ;; \
      arm64) apk_sha256="$CA_APK_AARCH64_SHA256" ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    echo "${apk_sha256}  /tmp/ca-certificates-bundle.apk" | sha256sum -c -; \
    apk add --no-cache --no-network --upgrade /tmp/ca-certificates-bundle.apk; \
    apk info -e "ca-certificates-bundle=${CA_CERTIFICATES_VERSION}"; \
    test "$(apk info --who-owns /etc/ssl/certs/ca-certificates.crt)" = "/etc/ssl/certs/ca-certificates.crt is owned by ca-certificates-bundle-${CA_CERTIFICATES_VERSION}"; \
    echo '5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b  /etc/ssl/certs/ca-certificates.crt' | sha256sum -c -; \
    rm /tmp/ca-certificates-bundle.apk; \
    mkdir -p /etc/ssl/nautilo-empty-certs; \
    test -d /etc/ssl/nautilo-empty-certs; \
    test -z "$(find /etc/ssl/nautilo-empty-certs -mindepth 1 -maxdepth 1 -print -quit)"; \
    test "$(node --version)" = v22.23.4

# Keep Logto's upstream application, working directory, npm entrypoint, start
# command, and unrelated environment unchanged. Only the Node and CA trust
# identities differ from the pinned upstream image.
ENV NODE_VERSION=22.23.4 \
    NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/nautilo-empty-certs \
    NAUTILO_CA_CERTIFICATES_PACKAGE=alpine:20261020-r0 \
    NAUTILO_CA_BUNDLE_SHA256=5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b
LABEL org.opencontainers.image.title="Nautilo Logto Runtime" \
      org.opencontainers.image.source="https://github.com/logto-io/logto" \
      org.opencontainers.image.version="1.38.0" \
      org.opencontainers.image.licenses="MPL-2.0"
