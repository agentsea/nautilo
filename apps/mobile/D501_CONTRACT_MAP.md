# D501 contract map

Task 0.1 decision ledger. Verified against Stack 302 at
`7ffc5ceaa7ffe015fe024fcfcbc07cd7a1004606` on 2026-08-06.

## Runtime baseline

- `apps/mobile/package.json` pins Expo `~57.0.10`, React Native `0.86.2`,
  React `19.2.5`, `react-native-reanimated` `4.5.1`,
  `react-native-worklets` `0.10.1`, and
  `react-native-keyboard-controller` `1.21.9`.
- Expo's versioned SDK 57 reference maps SDK 57 to React Native 0.86. Native
  editor qualification must use prebuilt branch binaries, not Expo Go.
- D501 owns a separate worktree and instance. It must not reuse D468's Metro,
  native builds, simulator devices, services, or profile.

## Shipped artifact read surface

| Concern | Existing symbol | D501 use |
|---|---|---|
| Viewer route | `ArtifactViewerScreen` in `src/app/files/artifact/[id].tsx` | Add the format-aware Edit entry and keep content primary. The discussion controller must remain unmounted until **Discuss this file** resolves a room. |
| Aggregate authorized load | `fetchAggregateArtifactBytes()` in `src/features/files-discussion/artifact-discussion.ts` | Extend or split this metadata-first path for editable text/Writer bytes. Opening a file must remain independent of a discussion room. |
| Format classification | `classifyArtifactKind()` in `src/lib/artifact-bytes.ts` | Keep generic `.html`, `.htm`, and `text/html` unsupported. Writer admission is a second parser-backed decision, never an HTML classification shortcut. |
| Metadata | `ArtifactDto` in `packages/api-client/src/client.ts` | Reuse `id`, `artifactId`, `path`, `mimeType`, `size`, and `revision`. Do not create a mobile artifact DTO or document registry. |
| Metadata client | `NautiloApiClient.getWorkspaceArtifact()` | D501 viewer and edit admission load the server-authorized aggregate row, independent of the room used to navigate there. A `null` result remains indistinguishable missing/unreadable state. |
| Byte URL | `NautiloApiClient.getWorkspaceArtifactBytesUrl()` | Continue native authenticated file download with `expo-file-system`; decode editor text only after the edit cap passes. |
| Auth lifecycle | `getApiClient()`, `ensureValidToken()`, `emitAuthDead()` | Reuse the shared token provider, one forced-refresh retry, and global auth-dead transition. No editor-local session state. |

The current viewer caps text at `MAX_TEXT_BYTES` (50 MiB), which is a transport/
view eligibility ceiling, not a proven native edit limit. Task 0.5 must choose a
smaller measured edit cap and enforce it before mounting either editor.

## Authority and the one required read-projection extension

`workspaceArtifactsRoutes()` in
`packages/server/src/routes/workspace-artifacts.ts` is canonical authority:

- `GET /api/workspace/artifacts/:id` and `/bytes` resolve only through
  `envelopeReadableNamespaces()`.
- `PUT /api/workspace/artifacts/:id/content`, `PATCH
  /api/workspace/artifacts/:id`, and `DELETE /api/workspace/artifacts/:id`
  resolve through `envelopeMutableNamespaces()` and revalidate on mutation.
- The save route distinguishes readable-but-not-mutable as HTTP 403. Rename and
  delete currently return the existing indistinguishable 404 when the mutable
  lookup fails.

No current read DTO says whether the same envelope can mutate a row. Inferring
that from file extension, namespace IDs, room origin, ownership, or local state
would violate D501. The smallest necessary extension is a canonical
`ArtifactDto.canWrite: boolean`, calculated by the existing `rowToDto()` call
sites from the intersection of the already-resolved mutable namespace set and
the artifact namespace set. It adds no route, table, persistence, policy, or
mobile-local DTO. Edit/rename/delete presentation may use this advisory field;
the mutation routes remain authoritative on every request.

D501 keeps this authority scope coherent end to end: once aggregate metadata
admits an action, source save, rename, and delete omit room context and let the
server revalidate aggregate mutable authority. The optional `roomId` carried by
navigation is provenance for returning to the Files surface, not mutation
authority. Mixing aggregate `canWrite` with a room-scoped mutation would expose
an action that can fail solely because the user opened the artifact through a
read-only attachment even though another attachment grants write access.

## Save, conflict, and response-loss contract

| Concern | Existing symbol/shape | D501 decision |
|---|---|---|
| Client | `NautiloApiClient.saveWorkspaceArtifactContent()` | Use unchanged for Markdown and text. Send loaded `baseRevision`, locally computed `baseSha256`, `checkpoint`, exact MIME, no room context, and one stable `clientMutationId` per logical save. |
| Base SHA | `sha256HexForText()` in Workbench `src/editors/editor-io.ts` | Mirror the same SHA-256-over-UTF-8 rule with mobile's installed `expo-crypto`; `ArtifactDto` does not need a SHA field. Hash the exact decoded bytes that seed the editor. |
| Wire | `PUT /api/workspace/artifacts/:id/content` | Raw UTF-8 body; `If-Match`, `X-Base-Sha256`, `X-Checkpoint`, `X-Artifact-Mime-Type`, and `X-Client-Mutation-Id`. |
| Server | `saveWorkspaceEditorSnapshot()` | Existing mutation lock, live authority proof, 50 MiB user-save ceiling, revision/SHA CAS, durable replay lookup, checkpoint, and outbox publication remain canonical. |
| Success | `{ id, revision, size, sha256 }` | Replace the editor baseline only after this response. |
| Stale write | HTTP 409 `{ error: "external_change", currentSha256 }`, mapped to `ConflictError` | Preserve the full unsaved buffer. Offer reload latest, copy changes, or cancel; never force overwrite. A later save uses the newly loaded revision/SHA. |
| Response loss | HTTP 503 `recovery_required` or transport failure | Keep the buffer and retry with the identical logical `clientMutationId`; never mint a new identity for an uncertain attempt. |
| Other failures | `ApiError.status` | Map 401 to global auth-dead; present 403, 404, 400, 413, 503, network, and 5xx as typed actionable outcomes without discarding input. |

The API client's current snapshot wrapper deliberately maps only 409 to
`ConflictError`; all other non-2xx outcomes remain `ApiError`. D501's controller
owns presentation, not a second transport or server error vocabulary.

## Rename, delete, and refresh

- Reuse aggregate `renameWorkspaceArtifact(id, newPath)` and
  `deleteWorkspaceArtifact(id)` from the browser-safe API client. D501 does not
  attach the navigation room to either mutation.
- Existing server routes are `PATCH /api/workspace/artifacts/:id` and `DELETE
  /api/workspace/artifacts/:id`. Rename uses `validateLogicalPath()`, rejects a
  path collision with 409, and emits `workspace.artifact.renamed`; delete marks
  the row deleted and emits `workspace.artifact.deleted`.
- `NautiloApiClient.subscribeWorkspaceArtifactEvents()` is the canonical
  artifact lifecycle stream. D501 installs the already-pinned
  `react-native-sse` EventSource before Expo Router and exposes one
  active-server/signed-in subscription through `ArtifactEventsProvider`.
  Consumers refetch canonical state; they do not create polling loops or local
  authoritative caches. Because the SSE URL freezes its token, only an
  explicit `401` handshake earns one force-refreshed rebind per provider
  generation; offline/status-0/unknown failures remain transport-owned and
  never force auth work. A failed first subscription gets one ordinary retry
  on the next AppState foreground transition, not a timer/polling loop.
  Reconnect is an invalidation signal, not a catch-up protocol.
- `RealtimeProvider.subscribe()` remains the separate authenticated WebSocket
  spine for general server events; artifact convergence does not multiply its
  subscriptions.
- `FilesScreen` currently refreshes with `loadArtifacts()` on server change and
  pull-to-refresh. D501 adds event-triggered refetch/reconciliation while
  preserving manual refresh and request-generation fencing.

## Writer container and block seams

| Concern | Existing symbol | D501 use |
|---|---|---|
| Safe parse | `parseWriterHtml()` in `@nautilo/writer-proposal-core` | DOM-free size, manifest, payload, unique-script, forbidden-key, and executable-script gate. A parse failure is generic unsupported HTML. |
| Canonical write | `serializeCanonicalWriterHtml()` | Serialize only a validated manifest and Wafflebase document into the deterministic canonical envelope. |
| Manifest constants | `WRITER_DOCUMENT_TYPE`, `WRITER_EDITOR`, `WRITER_HTML_VERSION`, `WAFFLEBASE_DOCUMENT_TYPE` | Require the exact canonical manifest; file extension/MIME alone never admits Writer. |
| Payload gate | `validateWafflebaseDocument()` | Preserve the complete document object and unknown top-level fields. It validates container safety, but D501's adapter must perform the stricter supported-subset check. |
| Model types | `Document`, `Block`, `Inline`, `InlineStyle` from `@wafflebase/docs` (already pinned through writer core at `0.4.9`) | Operate on canonical block identities and inline runs; do not invent a parallel mobile document model. |
| Mutations | `applyDocumentOperations()` and style validators | Reuse validation semantics where applicable. The native adapter may overlay the editor result on cloned original blocks directly when that is the only way to preserve unknown fields and stable IDs. |

Initial adapter admission is all-or-nothing:

- block types: `paragraph`, `heading` (qualified levels), and `list-item` with
  `listLevel === 0` and `listKind` ordered/unordered;
- inline content: text plus only the emphasis/link properties proven common to
  Writer and the qualified native control;
- exact preservation: block IDs, order, document/manifest metadata, unknown
  top-level and supported-object fields, untouched block/inline fields, and
  intentional formatting/text deltas;
- refusal: duplicate IDs, tables, nested lists, image/object inlines,
  horizontal/page breaks, comments/review markers, unknown block/style
  semantics, invalid manifests/payloads, executable scripts, or any native
  output that cannot reverse-map without loss.

The adapter must keep an immutable canonical source snapshot and overlay edits
onto its admitted blocks. It must never rebuild the document from editor HTML
alone, because that would discard stable IDs and unknown fields.

## Reusable native UI primitives

- `AppBar` and `AppBarBackButton` for the one shared editor header.
- `Screen` / `KeyboardAwareScrollView` and the already-pinned
  `react-native-keyboard-controller` for keyboard-safe focused-input scrolling.
- The `beforeRemove` plus explicit-back pattern in
  `src/app/(drawer)/(tabs)/settings/security.tsx` for dirty navigation.
- `BottomSheet` and native `Modal`/`Alert.alert` patterns for overflow,
  confirmations, conflicts, and recovery choices.
- `useAppTheme()` and `AppTheme` tokens for layout, focus, light/dark, and
  accessible states.

D501 adds one editor route/shell and format adapters. It does not add a WebView,
browser editor, cursor engine, persistence table, draft store, save route,
artifact registry, or format-specific navigation/save state machine.

## Existing tests affected or extended

- Mobile read/routing: `src/lib/artifact-bytes.test.ts` and
  `src/features/files-discussion/artifact-discussion.test.ts`.
- API contract: `packages/api-client/tests/unit/workspace-artifacts.test.ts`.
- Server authority/mutations: `packages/server/tests/integration/workspace-artifacts.integration.test.ts`,
  `packages/server/tests/unit-isolated/workspace-artifacts-routes.test.ts`, and
  `packages/server/tests/unit/workspace-editor-save-service.test.ts`.
- Existing save characterization:
  `packages/server/tests/integration/d448-artifact-save-patch-characterization.integration.test.ts`
  and `d448-writer-mutation-characterization.integration.test.ts`.
- Writer safety/model: `packages/writer-proposal-core/tests/writer-proposal-core.test.ts`,
  `packages/first-party-apps/writer/src/office-document.test.ts`, and
  `packages/first-party-apps/writer/src/document-ops.test.ts`.
- New D501 coverage belongs beside the pure admission/adapter/controller modules
  and in focused viewer/editor component tests; native interaction evidence is
  deferred to isolated Phase 0 qualification and Phase 4 Maestro runs.
