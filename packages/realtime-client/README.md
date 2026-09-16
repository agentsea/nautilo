# @nautilo/realtime-client

WebSocket (and later Ably) subscription wrapper with typed event parsing. Abstracts `REALTIME_MODE` so apps don't care whether they're talking to a local WebSocket or Ably.

## Usage

```typescript
import { createWsRealtimeClient } from "@nautilo/realtime-client";

const client = createWsRealtimeClient("ws://localhost:3001/ws", {
  onEvent(event) {
    if (event.type === "message.tokens") {
      process.stdout.write(event.content);
    }
  },
  onStateChange(state) {
    console.log("Connection:", state);
  },
});
```

## What lives here

- `createWsRealtimeClient()` — WebSocket implementation for `REALTIME_MODE=ws` (OSS/local).
- Typed event parsing — incoming JSON is parsed into the `ServerEvent` discriminated union from `@nautilo/types`.
- Later: `createAblyRealtimeClient()` for `REALTIME_MODE=ably` (SaaS). Same interface, different transport.

## Who uses this

- `apps/mobile/` — React Native app.
- `apps/workbench/` — web workspace (Phase 2+).
