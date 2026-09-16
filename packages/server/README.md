# @nautilo/server

The Fastify HTTP control plane. Every message — from Workbench, Desktop,
Mobile, Telegram, or Slack — enters through this package.

## What lives here

- **Inbound message routing** — app → HTTP POST, Telegram → webhook, Slack → Socket Mode. All resolve to: identify user → build envelope → run graph → stream response.
- **Identity resolution middleware** — channel + external_id → actor → namespaces → `MemoryAccessEnvelope` → RLS context.
- **Message coalescing middleware** — 2-second debounce per lane to batch rapid messages.
- **Real-time event publishing** — Ably (SaaS) or WebSocket (OSS). Same event types in both modes.
- **State management endpoints** — jobs, threads, personas, connections, config, memory browser.
- **`prove_it` flow** — challenge/response for blocking approval and async pairing.
- **Channel adapters** — Telegram webhook handler, Slack Socket Mode (server-side, not separate apps).
- **Relay WebSocket endpoint** — registration, dispatch, heartbeat for local relays.

## Architecture note

This is a **library package** that exports `createApp()`. It does not boot itself. The entry point that starts the server is `bin/nautilo-local` (for local/OSS) or a container entrypoint (for SaaS).

## Integration tests (M067B)

- **Fixture** — `tests/integration/helpers/app-fixture.ts` boots the real Fastify app with a synthetic owner user, federated handle, PIN, and `NAUTILO_OWNER_ID` / `NAUTILO_OWNER_ACTOR_ID` wired for OSS routes. Always call `cleanup()` in `afterAll` (deletes relay tokens, jobs, credentials, identities, actors, users).
- **`authedInject`** — `tests/integration/helpers/request-helpers.ts`. Omits `Content-Type` on `GET`/`HEAD` so session resolution matches browser clients.
- **Inject vs socket** — Prefer `app.inject` for JSON routes. Use `withListeningServer` + `fetch` when `@fastify/static` or streaming responses are involved (see `onboarding-audio.test.ts` — `inject` can deadlock on streamed bodies).

## Platform abstraction

| Flag | Options |
|------|---------|
| `BILLING_MODE` | `none` \| `stripe` |
| `REALTIME_MODE` | `ws` \| `ably` |
