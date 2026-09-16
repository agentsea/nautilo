# nautilo-relay

Local headless Relay consumer. It connects to a chosen `@nautilo/server` as a
`desktop-agent` over the authenticated WebSocket protocol in `@nautilo/relay`.

## Pairing

Run the foreground device ceremony once before normal startup:

```sh
nautilo-relay pair
```

The command authenticates the Human through Nautilo's existing device flow,
mints a dedicated Relay credential, and stores the credential in the operating
system keychain. Only a stable opaque installation UUID and a hash of the
server origin are stored under the Nautilo data directory. No plaintext token,
HTTP bearer, native path, or Desktop credential is written there.

Normal startup is non-interactive and fails closed when the credential is
missing, invalid, or revoked. A 4401 authentication close stops reconnecting,
removes the rejected keychain item, and requires `nautilo-relay pair` again.
The HTTP identity bearer used during pairing is temporary and is never reused
as the long-lived Relay credential.

## Configuration

- **Server URL**: `resolveInstance().server.url` (same merge order as other daemons: env / `nautilo.config.ts` / `~/.nautilo/instance.json`). Override with `NAUTILO_SERVER_URL` as today.
- **Data dir**: `resolveNautiloRootDir()` (typically `~/.nautilo`), reported in relay capabilities for sandbox envelopes.
- **Authenticated identity**: loaded with the paired Relay token from the
  operating-system keychain. `NAUTILO_USER_ID`, `NAUTILO_RELAY_BEARER`, and a
  tokenless legacy fallback are deliberately not startup authority.

## What it does

- Registers capabilities with the server via persistent WebSocket.
- Receives dispatched tool calls and executes them locally.
- No UI — for power users who want local filesystem/shell access without the desktop app.

## Protocol

Implements `@nautilo/relay`: registration, heartbeats, request/response correlation, timeout handling, cancellation.
