# @nautilo/db

Database schema, connection, and migrations. The single source of truth for all persistent state.

## What lives here

- **Drizzle schema** — table definitions for identity (actors, channel identities, namespaces), memory (durable memory with pgvector embeddings, session transcripts, working memory), and runtime state (jobs, threads, config).
- **Database connection** — role-correct `postgres.js` runtime owners for `db` (full `nautilo` role) and `agentDb` (restricted `nautilo_agent` role), plus Drizzle wrappers. Self-hosted Compose connects directly to `app-postgres`; hosted Neon connects to the standard PostgreSQL endpoint.
- **Migrations** — managed by drizzle-kit, stored in `src/migrations/`.
- **Docker Compose** — local Postgres 17 with pgvector for dev (`legacy-postgres` in the dev stack).
- **`ensureDatabase()`** — auto-starts Docker containers and runs migrations on startup.

## Local development

Runtime and migrations both use **direct PostgreSQL wire protocol**. There is
no local Neon SQL-over-HTTP proxy, `db-host` multiplexer, or `:4444` route in
M215-capable dev/deploy templates (M215 code/templates; live operator rollout
pending; transport cutover in M212).

**Schema vs migrations:** run `bun run db:check` (wraps `drizzle-kit check`) from this package before opening a PR that touches `src/schema/` or migrations. The same check runs in `tests/integration/schema-drift.test.ts` under `bun run test:integration`.

```bash
bun run db:dev          # start Postgres container(s)
bun run db:check        # fail if schema and committed migrations diverge
bun run db:generate     # generate migrations from schema changes
bun run db:migrate      # apply migrations
bun run db:studio       # open Drizzle Studio
```

For a complete development environment, use a named instance as described in
the [root README](../../README.md#develop-from-source). Inspect existing resources
before starting services or applying migrations.

## Ports

| Service | Port (default instance) | Purpose |
|---------|-------------------------|---------|
| Postgres (`legacy-postgres` dev / `app-postgres` deploy) | 5434 (host publish for dev) | Direct PostgreSQL — runtime, migrations, drizzle-kit |

Named instances shift the host publish port via `NAUTILO_DB_PORT` / `instance.json`.

## Connection strings

```bash
# Runtime (postgres.js) — set automatically by ensureDatabase() / deploy env
DB_CONNECTION_STRING=postgres://nautilo:<password>@app-postgres:5432/nautilo   # deploy in-network
# local dev host-side equivalent:
DB_CONNECTION_STRING=postgres://postgres:postgres@localhost:5434/nautilo

# Direct Postgres for drizzle-kit and one-off admin (when needed)
DB_DIRECT_CONNECTION=postgresql://postgres:postgres@localhost:5434/nautilo
```

Deploy Compose injects role-specific URLs for `nautilo` and `nautilo_agent` directly
to `app-postgres`. Agent callers use the restricted role, never the full-privilege
application connection as an authorization fallback.

- `DB_AGENT_CONNECTION_STRING` explicitly selects the agent runtime connection.
- `DB_AGENT_DIRECT_CONNECTION` explicitly selects the agent direct connection.
- Without an explicit runtime URL, the resolver derives the restricted role
  from `DB_CONNECTION_STRING`, or falls back to the selected instance's local
  endpoint. The direct resolver uses the selected instance's direct connection.
  Both use `NAUTILO_AGENT_DB_PASSWORD`. Read
  [agent-database.ts](src/config/agent-database.ts) for exact precedence; supply
  the provisioned role password in deployment.
- [postgres-init.sh](../../infra/postgres-init.sh) provisions the restricted role.
  [with-trust-context.ts](src/connection/with-trust-context.ts) binds transaction
  context for row-level policies; a connection alone does not establish access.

The [sensitive-table matrix](audits/sensitive-tables-matrix.md), schema, and
migration tests document the checked-in security boundaries. Unit checks do
not prove grants or policies on a deployed database.
