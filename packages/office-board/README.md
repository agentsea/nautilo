# @nautilo/office-board

Nautilo-owned model, viewport and Miro mapper derived from Wafflebase.
The native Nautilo Board mini-app is separate delivery work.

Rather than fork a new scene engine, board **reuses the Slides scene engine**
(`@nautilo/office-slides`): its element model, renderer, hit-testing, and editor
already operate in transform-agnostic world coordinates. A board is presented
as "one unbounded slide" via a single-synthetic-slide adapter, and a
`Viewport { panX, panY, zoom }` is injected at the fit-scale chokepoints.

## Architecture

- **Model** (`model/board.ts`) — `BoardModel` is intentionally flatter than a
  `SlidesDocument`: no slides/layouts/masters/themes, just an `elements[]`
  array plus a small `meta` (title, display unit, recent colors).
  `boardToSlidesDocument(model)` wraps that array in a single-slide
  `SlidesDocument` (`SYNTHETIC_SLIDE_ID = 'board'`, blank layout, default
  master, default-light theme) so the reused slides renderer/editor operate on
  a board unchanged.
- **Viewport** (`view/viewport.ts`) — re-exports the slides `Viewport` type and
  `worldToScreen`/`screenToWorld`, and adds `DEFAULT_VIEWPORT`, `zoomAt`
  (zoom about a screen anchor, keeping the world point under the cursor fixed),
  and `panBy`.

## Public API

Exports from `src/index.ts`:

```typescript
// Model
type BoardModel
SYNTHETIC_SLIDE_ID, boardToSlidesDocument

// Viewport
type Viewport
worldToScreen, screenToWorld, DEFAULT_VIEWPORT, zoomAt, panBy
```

## Build

```bash
bunx turbo run build --filter=@nautilo/office-board...
bunx turbo run lint typecheck test:unit --filter=@nautilo/office-board
```

## Qualification and ownership

Root, `/node` and `/browser` expose the same pure model/mapping API in ES and
CommonJS. Use `@nautilo/office-slides/browser` separately to mount the editor.
`mapMiroItems`, connector-site helpers and Miro payload/result types are also
exported. `zoomAt` has no implicit minimum/maximum; optional bounds are explicit
caller policy. Invalid transforms throw before changing state.

See [qualification and frontend map](../../docs/office-engines/BOARD-QUALIFICATION.md),
[original hashes](../../docs/office-engines/snapshot.json) and [NOTICE](NOTICE.md).
The parser works in Node without global DOM shims. Miro mapping is best-effort;
live authenticated import, atomic application and complete fidelity reporting
remain separate work. This package does not provide storage or app authority.
