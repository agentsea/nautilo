# Mac Relay Daemon

Swift background process — the device-relay profile for smart home control. No UI, no menu bar.

## What will live here

- Outbound WebSocket connection to cloud (implements `@nautilo/relay` protocol).
- Paired via QR code from the mobile app.
- Per-device authentication token.
- Smart-home commands only: Hue bridge HTTP, Sonos UPnP, TV WebSocket.
- No shell, no filesystem access.
- ~5MB download, Apple-notarized.

## Build system

Swift Package Manager. Standalone — can be handed to a Swift developer who never touches the TypeScript monorepo.

## Status

Placeholder. Phase 0-1 priority for the "Genie Moment" (lights change, music starts).
