# @nautilo/types

Shared type definitions used across the Nautilo monorepo. Single source of truth for API request/response types, real-time event types, and shared enums.

## What lives here

- **API types** — request/response shapes for server endpoints (`SendMessageRequest`, etc.).
- **Real-time event types** — the discriminated union of all WebSocket/Ably events (`MessageTokensEvent`, `JobStatusEvent`, `ToolStartEvent`, etc.).

## Who uses this

Every package and app that needs to agree on a data shape:
- `@nautilo/server` — publishes events matching these types.
- `@nautilo/api-client` — request/response types.
- `@nautilo/realtime-client` — parses incoming events into these types.
- `apps/*` — consumes both API and event types.
