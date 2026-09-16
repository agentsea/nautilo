# @nautilo/office-core

Shared foundation package for Wafflebase. Holds the engine-level primitives
that would otherwise be duplicated across `@nautilo/office-sheets`,
`@nautilo/office-docs`, and `@nautilo/office-slides` — design tokens, geometry, and
URL helpers.

The package is **subpath-only**: there is no root `.` barrel export. Import
exactly the leaf you need so bundlers tree-shake the rest.

## Subpaths

| Import | Contents |
|--------|----------|
| `@nautilo/office-core/tokens` | Design tokens — `palette`, semantic colors, `radius`, `typography`, `contrast` helpers |
| `@nautilo/office-core/tokens.css` | Generated CSS custom properties for the tokens (built by `scripts/build-css.ts`) |
| `@nautilo/office-core/geometry` | `Point` / `Rect` / `Size` types, bounding-box math, hit-testing |
| `@nautilo/office-core/url` | Safe-protocol hyperlink gating (`SAFE_PROTOCOLS`, `isSafeUrl`) shared by every renderer/exporter across sheets and docs |

`@wafflebase/tokens` is folded into this package as the `./tokens` subpath.

> **Roadmap:** `./canvas`, `./ooxml`, and `./ooxml/drawingml` subpaths are
> planned but not yet shipped — see the design doc below. The exports map in
> the design doc describes the target shape, not the current one.

## Usage

```typescript
import { palette } from '@nautilo/office-core/tokens';
import { rectsIntersect, type Rect } from '@nautilo/office-core/geometry';
import { isSafeUrl } from '@nautilo/office-core/url';
```

Classic CJS resolvers ignore the `exports` map, so a new subpath also needs a
matching `@nautilo/office-core/*` path entry in `packages/backend/tsconfig.json`.

## Build

```bash
pnpm --filter @nautilo/office-core build
```

## Further Reading

- [shared-core-extraction.md](../../docs/design/shared-core-extraction.md) —
  the extraction audit, subpath design, and 3-PR rollout plan.
