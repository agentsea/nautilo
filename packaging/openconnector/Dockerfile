# syntax=docker/dockerfile:1.7

# D456 — reproducible Nautilo derivative of OOMOL OpenConnector. The source
# revision, upstream version, patch digest, and base-image digest are recorded
# together in manifest.json and enforced by provenance.test.ts.
ARG NODE_IMAGE=docker.io/library/node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

FROM ${NODE_IMAGE} AS source
ARG OPENCONNECTOR_SOURCE_COMMIT=1bfdc0343057303d2993bcff44d0d5821ea658fd
RUN apk add --no-cache ca-certificates git
WORKDIR /src
RUN git init \
    && git remote add origin https://github.com/oomol-lab/open-connector.git \
    && git fetch --depth=1 origin "${OPENCONNECTOR_SOURCE_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${OPENCONNECTOR_SOURCE_COMMIT}" \
    && rm -rf .git
COPY packaging/openconnector/nautilo.patch /tmp/nautilo-openconnector.patch
RUN git apply --check /tmp/nautilo-openconnector.patch \
    && git apply /tmp/nautilo-openconnector.patch

FROM source AS build
RUN npm ci --ignore-scripts
RUN npm run generate:catalog
RUN npm run build
RUN npm run build --workspace web

FROM ${NODE_IMAGE} AS runtime
ARG OPENCONNECTOR_SOURCE_COMMIT=1bfdc0343057303d2993bcff44d0d5821ea658fd
LABEL org.opencontainers.image.title="Nautilo OpenConnector Runtime" \
      org.opencontainers.image.source="https://github.com/oomol-lab/open-connector" \
      org.opencontainers.image.revision="${OPENCONNECTOR_SOURCE_COMMIT}" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    OOMOL_CONNECT_DATA_DIR=/app/data
COPY --from=source /src/package.json /src/package-lock.json ./
COPY --from=source /src/scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY --from=source /src/scripts/ensure-generated.ts ./scripts/ensure-generated.ts
COPY --from=source /src/scripts/runtime-data.ts ./scripts/runtime-data.ts
COPY --from=source /src/migrations ./migrations
COPY --from=build /src/src ./src
COPY --from=build /src/catalog ./catalog
COPY --from=build /src/dist ./dist
COPY --from=source --chmod=755 /src/docker/entrypoint.sh /usr/local/bin/open-connector-upstream
COPY --chmod=755 packaging/openconnector/entrypoint.sh /usr/local/bin/open-connector
COPY --from=source /src/LICENSE.txt /usr/share/licenses/open-connector/LICENSE.txt
COPY --from=source /src/NOTICE.md /usr/share/licenses/open-connector/NOTICE.md
RUN npm ci --omit=dev --ignore-scripts
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD ["node", "scripts/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/open-connector"]
CMD ["serve"]
