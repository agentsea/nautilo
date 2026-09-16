# Nautilo Design capability and authored-write race matrix

This records the live Design manifest, handler, and host paths. It describes
current behavior; it does not imply that the human UI, legacy direct tools,
and semantic edit batches share the same caller contract.

## Durable capabilities by actor

| Capability | Human surface | Agent surface | Current boundary |
| --- | --- | --- | --- |
| Create a Design document | New Design action | `create-file` | Human creates in its selected workspace/folder; the tool needs project-content authority and returns the created Design file. |
| Inspect the open Design context | Design editor canvas, inspector, pages, layers, selection | `inspect-open-design` | Read-only live context for the host-open Design surface. It reports current semantic context and does not write a file. |
| Inspect a persisted Design document | Open a Design file in the editor | `inspect-document` | Read-only explicit document inspection. Pagination exposes continuation rather than silently treating one page as the entire scene. |
| Make semantic document edits | Canvas, inspector, layers/pages, keyboard commands | `edit-open-design` | A named operation batch against the open Design document. Public handles and operation preconditions identify the intended targets. |
| Use direct structural helpers | Canvas and editor commands | `create-frame`, `create-text`, `create-shape`, `set-node-props`, `replace-text`, `layout-nodes`, `arrange-nodes` | Legacy agent helpers remain declared and require project-content authority. They are separate calls, so callers do not receive the semantic batch's multi-operation precondition contract. |
| Export SVG / PNG | Export conversion menu | `export-svg`, `export-png` | Export resolves public page and optional node handles from the parsed source. The host forwards only a trusted editor-derived scope; the handler rejects an empty selection or nodes outside that page. |
| Organize and reuse objects | Group/ungroup, reparent, duplicate, clipboard, flip, hide/lock, page management | Explicit limitation: new organizer requests are human-only | Kernel-backed durable edits; the agent manifest does not yet expose these organizer forms. |
| Import editable SVG | Import SVG in More tools | No declared import tool | Safe shapes and M/L/H/V/C/Z paths become canonical editable nodes; unsupported content fails atomically. Root viewport mapping is honored. Slice clipping, nonuniform transformed strokes, linked images, and unsupported path commands are disclosed. |
| Refine paths/connectors | Anchor controls and endpoint gestures | Semantic path and connector operations | Free endpoints can transform; attached endpoints follow eligible targets on the same page. Cross-page reparent detaches affected endpoints at their resolved position. |
| Local presentation state | Selection, viewport, disclosure, inspector focus | None | This is editor-local state. It is intentionally not an agent mutation authority and is not serialized as a semantic document edit. |

## Live manifest tools

`app.json` declares these thirteen tools: `inspect-open-design`,
`edit-open-design`, `create-file`, `inspect-document`, `create-frame`,
`create-text`, `create-shape`, `set-node-props`, `replace-text`,
`layout-nodes`, `arrange-nodes`, `export-svg`, and `export-png`. The prior nine-tool table
was incomplete: it omitted the live-open inspector, the semantic edit surface,
and layout.

`edit-open-design` accepts the manifest operation forms `create`, `path`,
`transform`, `rotate`, `rename`, `text`, `style`, `align`, `distribute`,
`reorder`, `boolean`, `page`, `connector`, `connector-update`, and `delete`.
The handler validates those operations against the parsed current scene and
applies them as one semantic request; this is the agent route for compound
structural work rather than a claim that every legacy direct helper has an
identical shape.

## SVG and PNG export scope at the host boundary

The current host export request is typed as
`scope?: { pageHandle: string; nodeHandles?: string[] }`. The Design export
menu derives choices from trusted active editor context and can send the active
page, the selected nodes on that page, or a selected frame's scope. It passes
the optional scope through the conversion runner and API conversion route to
the Design `export-svg` or `export-png` tool. Iframe-provided target fields are not accepted as
an export scope.

The tool keeps legacy behavior when scope is absent by exporting the first
page. With scope present, the source-scene parser is the final authority for
public-handle existence and page membership. It therefore rejects a cross-page
selection even if a caller bypasses the host menu.

## Write and race semantics

| Path | Collision behavior | Recovery |
| --- | --- | --- |
| Human editor actions | The editor store applies canonical transactions and autosaves the scene. | UI errors remain visible to the user; local selection/viewport state is reconstructed from the current scene. |
| `edit-open-design` semantic batch | Each operation carries target handles and applicable expected state. A stale request that is disjoint from intervening changes may proceed; a changed target becomes a semantic conflict rather than silently replacing another edit. | The response reports current state/conflicts so the caller can inspect and submit an intentional follow-up. Idempotency receipts prevent replay from repeating a completed semantic request. |
| Legacy direct agent helpers | Individual calls are serialized through their handler path, but they are not a substitute for a compound semantic batch. | The caller must inspect/retry when a later direct call no longer matches the document it intended to change. |
| SVG / PNG export conversion | Source parsing and scope validation occur before output creation. | Invalid public handles, empty scoped selections, and cross-page nodes fail without creating an export artifact. A valid export remains scoped to the verified source snapshot. |

## Evidence locations

- `app.json` is the manifest source for the thirteen declared tools and the
  semantic operation schemas.
- `src/agent-tool-handlers.ts` dispatches inspection, direct helpers, semantic
  edits, and SVG / PNG exports; its export path validates public handles and page
  membership against the parsed scene.
- `src/design-operations.ts`, `src/transactions.ts`, and
  `src/agent-receipt.ts` define semantic operation application, conflict
  detection, and idempotent receipt behavior.
- `apps/workbench/src/apps/mini-app-surface.tsx` derives trusted Design export
  choices; `apps/workbench/src/apps/export-conversions.ts`,
  `run-conversion.ts`, and the server conversion route carry the typed scope.
- `src/editor/store.ts` is the human editor transaction and transient-state
  boundary. Local clipboard, selection, gestures, and viewport presentation
  are not agent tool capabilities.

## Deliberate limitation

The agent manifest exposes both semantic batches and legacy direct helper
tools. They currently have different request contracts and conflict detail;
this document does not claim full symmetry or a migration of every direct tool
to the semantic operation route. Any consolidation must preserve the existing
public tool names until callers have a documented replacement.

## Persistence and typography qualification

Autosave owns exact serialized snapshots and keeps failed writes dirty. Close,
replacement, SPA navigation and native quit wait for durable save or an exact
host-persisted recovery record. Native cancellation remains available without a
save-success timeout. Export additionally requires the original document to
be saved; recovery alone cannot authorize export from stale server content.
Save Copy creates a sibling and leaves the original conflict intact.

New text defaults to bundled Noto Sans; explicitly selected legacy fonts retain their appearance. Bundled text uses the Noto Sans regular/bold faces for identical browser
and server measurement; unsupported wrapped fonts, weights and glyphs fail
before mutation. Existing unwrapped fonts remain readable. Text resizing and
saved SVG share the explicit horizontal stretch and line-height model.

PNG uses outlined bundled-font glyphs and the host's resource-free SVG rasterizer,
then creates a binary artifact through existing document permissions, colocation,
and collision recovery. PNG destinations are Workspace-only: Current Folder needs an atomic create-only binary relay write before it can be offered. It never relies on the rasterizer's ambient fonts. Legacy
ambient fonts require an explicit font change or SVG export; unresolved images
remain unsupported. No PNG bytes enter the iframe or model context.

Referenced raster placement remains incomplete pending D385 asset custody.
This matrix does not claim image placement or complete live qualification.


Export creation records destination-confirmed receipts in the host runner. The
existing worker deadline can stop app code while an admitted host write settles;
a matching successful receipt recovers the export result. A partial binary write
preserves its bytes, reports unconfirmed metadata and unsafe retry, and never
becomes an exported receipt. No automatic rollback or replay is claimed.
Unwrapped Noto weights 500/600 resolve to the installed 400/700 faces in both
renderers; glyph ink and transformed stroke bounds include text overflow.
