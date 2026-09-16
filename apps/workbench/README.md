# Nautilo Workbench

Desktop-class web workspace shell. React + Next.js.

## What will live here

- **Chat rail** — Genie chat on the right (same identity, memory, approvals as other surfaces).
- **Work surface** — hotswappable block on the left (doc preview, diff, browser session, later sheets/slides).
- **Artifact store** — versions, anchors, proposals.
- **Job commander** — running jobs, pending approvals.
- **Avatar display** — Rive web component driven by `@nautilo/avatar`.

## Connects to backend via

- HTTP → `@nautilo/api-client`
- Real-time → `@nautilo/realtime-client` (Ably)

## Status

Placeholder. Phase 2+ — not on the critical path for proving the business.
