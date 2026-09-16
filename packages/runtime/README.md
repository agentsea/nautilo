# @nautilo/runtime

Everything that coordinates **across** graph runs. If `@nautilo/agent` is one turn of conversation, this package is the long-running brain that ties turns together.

## What lives here

- **Jobs engine** — scheduling, execution, lifecycle, status transitions (`queued → running → completed | failed | timed_out`). Adapted from Papyrus's job manager.
- **Lane locking** — one active foreground run per conversation lane. Advisory locks (Postgres) or in-memory Map (OSS).
- **Message coalescing (M074)** — OSS ships a 2-second sliding silence buffer per lane in front of foreground jobs: rapid sends while a lane is busy merge into one follow-up turn; HTTP may return `jobId: null` with `coalesced: true`, with real ids arriving via `job.dispatched` on the WebSocket. Horizontal scale / Postgres-backed lane locks are a follow-on issue.
- **Identity resolution** — channel + external_id → actor → namespaces → `MemoryAccessEnvelope`. Runs before every graph invocation.
- **Policy resolver** — determines allowed tools, approval requirements, and memory access for each turn.
- **Event bus** — completion, approval, and review events. `EventEmitter` in OSS, pg-boss in SaaS.
- **Observer / cortex-lite** — working-memory synthesis, worker health monitoring, cron/scheduled jobs.
- **Review/learning-loop orchestration** — nudge counters, background reviewer triggers, exit flush scheduling.
- **Relay registry** — tracks connected local relays and their capabilities.

## Scaling via env flags

Each component is backed by an interface with two implementations:

| Flag | OSS | SaaS |
|------|-----|------|
| `JOB_MODE` | fire-and-forget Promise | pg-boss queue |
| `LOCK_MODE` | in-memory Map | `pg_try_advisory_lock` |
| `REALTIME_MODE` | WebSocket | Ably |
| `OBSERVER_MODE` | `setInterval` in-process | pg-boss cron |

## Dependency rule

`@nautilo/runtime` depends on `@nautilo/agent` and `@nautilo/db`. The server depends on runtime. Apps never import runtime directly.
