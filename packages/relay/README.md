# @nautilo/relay

Shared protocol between the server-side relay management and any relay binary (TypeScript or Swift).

## What lives here

- **`RelayCapabilities`** — the profile and capability set a relay declares on connection (device-relay vs. desktop-agent, which devices it can control, security level).
- **`ToolPolicy`** — how the graph's uniform tool interface maps to cloud vs. relay execution, with impact classification and approval requirements.
- **Request/response envelope types** — correlation IDs, timeout semantics, cancellation, scoped task envelopes carrying the requesting user's `MemoryAccessEnvelope`.

## Who uses this

- `@nautilo/server` — relay WebSocket endpoint, dispatch routing.
- `native/mac-relay/` — Swift daemon implements this protocol.
- `bin/nautilo-relay` — headless TypeScript relay implements this protocol.

## Two capability profiles

| Profile | Purpose | Trust level |
|---------|---------|-------------|
| **device-relay** | Smart home (Hue, Sonos, TV). No shell, no filesystem. | Narrow, Phase 0-1 |
| **desktop-agent** | Local files, shell, dev workflows. | Higher trust, Phase 2+ |
