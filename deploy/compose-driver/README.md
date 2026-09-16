# `deploy/compose-driver/`

`ComposeDriver` — the host-side TypeScript class that drives the
`nautilo deploy / status / restart / logs / upgrade / backup /
restore / destroy` verbs against a containerized full-stack
deployment (Postgres + Logto + nautilo-server). In the current templates and code,
runtime DB access is direct PostgreSQL via `app-postgres` in-network — no
`neon-proxy`, `db-host`, or SQL-over-HTTP proxy ports. **Live operator rollout**
on existing deployments is an explicit operator action.

The implementation has two main parts:

- **Templates** — `templates/`
  (Dockerfile via `packaging/docker/Dockerfile`, `docker-compose.yml`,
  `postgres-init.sh`, `.env.local-smoke.example`).
- **Driver** — `src/`
  (driver class + helpers), CLI verbs, profile schema consumption,
  multi-instance isolation, automated smoke.

## Layout

```
compose-driver/
├── src/                    ← TS driver class + buildComposeEnv + composeProjectName
├── templates/              ← Dockerfile (in packaging/), docker-compose.yml,
│                             postgres-init.sh, .env.local-smoke.example,
│                             nautilo-server.service.example
├── tests/                  ← unit + integration tests
└── (no package.json today — consumed via TS path map from apps/cli)
```

## Profile contract (M092 Step 3, D420)

`ComposeDriver` consumes `apps/cli/src/lib/profile-schema.ts` profiles.
A profile describes **where** to deploy, not **how** the incoming artifact
is produced. Shape:

```toml
transport   = "local" | "remote"   # two adapters; no third transport enum
lifecycle   = "compose"            # driver REFUSES if "external"
instance_id = "beta"               # "" for the shared default instance
```

Artifact strategy (image vs source) and replacement scope (server-only vs
full) are **invocation-scoped** on the canonical command, never persisted:

```text
nautilo upgrade
  [--from-sources | --image <full-image-ref>]
  [--full]
  [--no-rollback]
  [--wait-for <duration>]
```

Defaults: profile-selected location, the latest compatible image from the
signed stable release channel, server-only replacement, automatic rollback,
five-minute drain ceiling. The CLI resolves that image before driver
construction and passes its immutable digest as request-scoped state.

**M215 topology cutover:** when project-labelled `neon-proxy` / `db-host`
containers remain from the pre-M215 topology, operators must use
`--full` once (`nautilo upgrade --full`). Default server-only upgrade refuses
with guidance. Remote registry `--full` follows baseline preflight → direct
topology/runtime acceptance → project-scoped stale-container cleanup.

### Product locations over two adapters

The three product locations map onto the existing local/remote adapters —
no LAN transport enum is introduced:

| Location | transport | HTTPS | Notes |
|---|---|---|---|
| Local | `local` | `off` | loopback Compose stack |
| LAN | `remote` | `off` | SSH host on the LAN; bootstrap bearer over loopback/SSH |
| Remote | `remote` | `letsencrypt` | public domain + Caddy HTTPS |

A `remote` profile with `https = "off"` and an SSH host is a LAN target; the
same adapter with `https = "letsencrypt"` + a public domain is a public
remote. `from_source` is no longer a profile field.

Runtime gates enforced by the driver (not the schema — M113's schema stays
permissive):

- `lifecycle !== "compose"` → loud error pointing at `bun run server`.
- `transport` other than `local`/`remote` → loud error.
- The request-scoped artifact must resolve before mutation: the CLI supplies
  the verified stable image by default or the exact `--image` override;
  `--image` is mutually exclusive with `--from-sources`.

Two ready-to-copy profile examples live in
[`examples/profiles/`](../../examples/profiles/).

### M215 topology retirement orchestration

- **Server-only upgrade** (`nautilo upgrade` default): read-only preflight refuses
  before stop/backup when project-labelled `neon-proxy` / `db-host` containers
  remain; operator must run **`nautilo upgrade --full`** once to retire them.
- **Full upgrade / deploy**: M212 direct-transport baseline preflight runs before
  mutation; retired containers are removed only after **`checkServerHealth`**
  (full runtime acceptance, not `/health` alone). Remote registry day-two syncs
  the current Compose template before compose mutations, then cleans up after
  runtime acceptance.

## Adapter status

Both adapters are implemented: local uses the host Docker CLI; remote uses
SSH-native Compose/registry operations or the legacy Docker-over-SSH source
path. D420 consolidates their operator contract under `nautilo upgrade`.
