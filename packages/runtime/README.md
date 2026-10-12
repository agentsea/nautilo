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

## Foreground context reconstruction

Each settled foreground segment rebuilds context through its last committed
transcript receipt. Required instructions, admitted tool schemas, response
allowance, accepted Human inputs, and live control state are reserved by the
graph before it supplies the remaining invocation envelope to runtime.

Within that envelope, Journal and recalled Records retain their bounded
semantic allocation first. The newest chronological suffix after the causal
Human trigger follows, using all remaining space. Matching execution output
is labelled current progress; other visible Human and Agent activity is
labelled surrounding Room activity. It remains quoted narration unless it was
explicitly admitted as input. Admitted later replies retain their exact Human
message at their committed position, once, including across checkpoint resumes.
If earlier exchanges cannot fit, those inputs stay pinned before the retained
suffix and the omission is disclosed.

Earlier transcript history uses leftover space within the configured Room
percentage and recent-conversation count. Those settings do not cut current
progress. The source reader pages backward through the authorized Room scope;
the final projection enforces the invocation envelope and discloses excerpts.
A parked segment retains its exact live assistant/tool/Human protocol sequence
until a new committed receipt permits reconstruction. Existing optional Memory
and live-state assembly remain owned by the graph.
