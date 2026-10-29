# syntax=docker/dockerfile:1.7

ARG LOGTO_IMAGE=ghcr.io/logto-io/logto@sha256:9a9aff9423ab7863f00c881c31408e0bfe4def730bac2182d0097367002f5854
ARG NODE_IMAGE=docker.io/library/node@sha256:206878a60dc7014193f418ab9259b6110c15fbd514b3044a267be706509944e4

# Fetch the signed Alpine package over HTTPS, then bind the bytes to the
# independently recorded repository hash for the selected target architecture.
FROM --platform=$TARGETPLATFORM ${NODE_IMAGE} AS trust-package
ARG TARGETARCH
ARG CA_CERTIFICATES_VERSION=20261020-r0
ARG CA_APK_X86_64_SHA256=bb008f6d214b6af7576324659856fb63dc8dcb4373f8345ff706388696f1254d
ARG CA_APK_AARCH64_SHA256=d0a573c27d337c369ad3abe3f39f09ffe67b95af23861577a8d134738375176a
ARG NPM_VERSION=12.2.1
ARG NPM_ARCHIVE_SHA256=228bd64aaef23270dbdbd2cf3d5ef5c467602ef38c4066246cef1984adab9a67
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) apk_arch=x86_64; apk_sha256="$CA_APK_X86_64_SHA256" ;; \
      arm64) apk_arch=aarch64; apk_sha256="$CA_APK_AARCH64_SHA256" ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    apk_url="https://dl-cdn.alpinelinux.org/alpine/v3.24/main/${apk_arch}/ca-certificates-bundle-${CA_CERTIFICATES_VERSION}.apk"; \
    wget -q -O /tmp/ca-certificates-bundle.apk "$apk_url"; \
    echo "${apk_sha256}  /tmp/ca-certificates-bundle.apk" | sha256sum -c -; \
    wget -q -O /tmp/npm.tgz "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz"; \
    echo "${NPM_ARCHIVE_SHA256}  /tmp/npm.tgz" | sha256sum -c -

FROM --platform=$TARGETPLATFORM ${LOGTO_IMAGE}
ARG TARGETARCH
ARG CA_CERTIFICATES_VERSION=20261020-r0
ARG CA_APK_X86_64_SHA256=bb008f6d214b6af7576324659856fb63dc8dcb4373f8345ff706388696f1254d
ARG CA_APK_AARCH64_SHA256=d0a573c27d337c369ad3abe3f39f09ffe67b95af23861577a8d134738375176a
COPY --from=trust-package /usr/local/bin/node /usr/local/bin/node
COPY --from=trust-package /tmp/ca-certificates-bundle.apk /tmp/ca-certificates-bundle.apk
COPY --from=trust-package /tmp/npm.tgz /tmp/npm.tgz
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) apk_sha256="$CA_APK_X86_64_SHA256" ;; \
      arm64) apk_sha256="$CA_APK_AARCH64_SHA256" ;; \
      *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    echo "${apk_sha256}  /tmp/ca-certificates-bundle.apk" | sha256sum -c -; \
    apk add --no-cache --no-network --upgrade /tmp/ca-certificates-bundle.apk; \
    apk upgrade --no-cache; \
    for package in 'alpine-release=3.24.3-r0' 'musl=1.2.6-r3' 'libcrypto3=3.5.9-r0' 'libssl3=3.5.9-r0' 'zlib=1.3.2-r1' 'apk-tools=3.0.8-r0'; do apk info -e "$package"; done; \
    apk info -e "ca-certificates-bundle=${CA_CERTIFICATES_VERSION}"; \
    test "$(apk info --who-owns /etc/ssl/certs/ca-certificates.crt)" = "/etc/ssl/certs/ca-certificates.crt is owned by ca-certificates-bundle-${CA_CERTIFICATES_VERSION}"; \
    echo '5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b  /etc/ssl/certs/ca-certificates.crt' | sha256sum -c -; \
    npm install --global --ignore-scripts --offline --no-audit --no-fund /tmp/npm.tgz; \
    test "$(npm --version)" = 12.2.1; \
    npm cache clean --force; \
    rm /tmp/ca-certificates-bundle.apk /tmp/npm.tgz; \
    mkdir -p /etc/ssl/nautilo-empty-certs; \
    test -d /etc/ssl/nautilo-empty-certs; \
    test -z "$(find /etc/ssl/nautilo-empty-certs -mindepth 1 -maxdepth 1 -print -quit)"; \
    test "$(node --version)" = v22.23.4

# Keep Logto's upstream application, working directory, npm entrypoint, start
# command, and unrelated environment unchanged. Node, npm, CA trust and supported
# Alpine security packages differ from the pinned upstream image.
ENV NODE_VERSION=22.23.4 \
    NODE_OPTIONS=--use-openssl-ca \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_DIR=/etc/ssl/nautilo-empty-certs \
    NAUTILO_CA_CERTIFICATES_PACKAGE=alpine:20261020-r0 \
    NAUTILO_CA_BUNDLE_SHA256=5961c0a3c65459931c023e0075c09733f09aea4ca439cb85bc4a08bb4f3f568b
LABEL org.opencontainers.image.title="Nautilo Logto Runtime" \
      org.opencontainers.image.source="https://github.com/logto-io/logto" \
      org.opencontainers.image.version="1.45.0" \
      org.opencontainers.image.licenses="MPL-2.0"
