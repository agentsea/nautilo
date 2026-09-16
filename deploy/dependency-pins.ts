/**
 * Third-party container image version pins for Nautilo compose stacks.
 *
 * Use immutable version tags (not `:latest`, `:alpine`, or `:main` without
 * documenting why). Digest pins are reserved for images that publish only
 * mutable tags (see `neonProxy`).
 *
 * Keep in sync: `infra/compose/nautilo.yml`, `packages/db/docker/docker-compose.yml`,
 * `deploy/compose-driver/templates/docker-compose.yml`, `buildComposeEnv.ts`,
 * `deploy/compose-driver/templates/.env.local-smoke.example`.
 *
 * M201: the `collabora` pin is now ALSO consumed by the deploy template's
 * `collabora` service (`office` profile) via the `COLLABORA_IMAGE` env var in
 * both `.env.example` + `.env.local-smoke.example` (default mirrors this pin).
 */
export const DEPENDENCY_PINS = {
  postgres: "postgres:16",
  pgvectorPg17: "pgvector/pgvector:pg17",
  /** M210 — immutable digest; upstream publishes only `main` on GHCR. */
  neonProxy:
    "ghcr.io/timowilhelm/local-neon-http-proxy@sha256:cd2ae14edf2feafbc3330492de5c80506f77274c3bd013154cdef697bdeb768a",
  nginxAlpine: "nginx:1.27-alpine",
  logto: "ghcr.io/logto-io/logto:1.38.0",
  logtoImageTag: "1.38.0",
  /**
   * D362 — Collabora Online (CODE) coolwsd base image. Used as the
   * `COOLWSD_BASE` build arg in `infra/compose/nautilo.yml` `collabora`
   * (the dev path builds a thin derived image via
   * `infra/coolwsd-fonts/Dockerfile` that layers fonts on top of this
   * base). When Phase 5.2 ships the self-built coolwsd, either flip
   * `COOLWSD_BASE` here+compose to the self-built tag, or fold the font
   * RUN stanza into the Phase-5.2 Dockerfile directly.
   */
  collabora: "collabora/code:26.04.1.4.1",
} as const;
