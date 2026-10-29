/**
 * Third-party container image version pins for Nautilo compose stacks.
 *
 * Prefer immutable digest references for qualified deployment baselines.
 * A version tag alone can move when upstream rebuilds an image.
 *
 * Keep in sync: `infra/compose/nautilo.yml`, `packages/db/docker/docker-compose.yml`,
 * `deploy/compose-driver/templates/docker-compose.yml`, `buildComposeEnv.ts`,
 * `deploy/compose-driver/templates/.env.local-smoke.example`.
 *
 * The `collabora` pin is also consumed by the deploy template's
 * `collabora` service (`office` profile) via the `COLLABORA_IMAGE` env var in
 * both `.env.example` + `.env.local-smoke.example` (default mirrors this pin).
 */
export const DEPENDENCY_PINS = {
  postgres: "postgres@sha256:1beaa3084eee2676f20a9cd9928f0bf2c5bf674f8e49f81017912183d377c61c",
  pgvectorPg17: "pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d",
  /** Immutable digest; upstream publishes only `main` on GHCR. */
  neonProxy:
    "ghcr.io/timowilhelm/local-neon-http-proxy@sha256:cd2ae14edf2feafbc3330492de5c80506f77274c3bd013154cdef697bdeb768a",
  nginxAlpine: "nginx:1.27-alpine",
  logto: "ghcr.io/agentsea/nautilo-logto-runtime@sha256:fa18003d670d977c78ab2d6d48f488811f447d2b3804b4707bb87eef23835966",
  /** Source-development migration target; matches infra/compose/nautilo.yml. */
  logtoImageTag: "1.38.0",
  /** Packaged deployment application version; advances with its qualified image. */
  packagedLogtoImageTag: "1.45.0",
  /**
   * Collabora Online (CODE) coolwsd base image. Used as the
   * `COOLWSD_BASE` build arg in `infra/compose/nautilo.yml` `collabora`
   * (the dev path builds a thin derived image via
   * `infra/coolwsd-fonts/Dockerfile` that layers fonts on top of this
   * base). When Phase 5.2 ships the self-built coolwsd, either flip
   * `COOLWSD_BASE` here+compose to the self-built tag, or fold the font
   * RUN stanza into the Phase-5.2 Dockerfile directly.
   */
  collabora: "collabora/code:26.04.1.4.1",
} as const;
