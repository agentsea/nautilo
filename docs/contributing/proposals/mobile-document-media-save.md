# Mobile documents, media, and saving originals

## Status

`APPROVED FOR IMPLEMENTATION` — maintainer-approved scope; qualification and release evidence remain required.

## Published problem

- Public problem: [Mobile as a first-class place to live and work](https://nautilo.ai/community/problems).
- Proposal issue URL: publication authorized; linked in the spec-only pull request.
- Direction: In progress / Help welcome. The product maintainer approved this scoped specification and implementation on 2026-09-07.

## Outcome

A signed-in person can open their authorized document, inspect an image, watch a video, or save/share its original from Mobile Files or the appropriate conversation entry point. They return to the same conversation/file position. A failed preview never traps a downloadable original.

## Verified current state

Historical characterization baseline: `95b16456d0f5ee17d856ab747e5628b166fcdbcb`. The table preserves the pre-implementation gaps that motivated the approved work; it is not current implementation status.

| Surface | Current evidence |
| --- | --- |
| Active viewer loading | `apps/mobile/src/app/files/artifact/[id].tsx:161` calls `fetchAggregateArtifactBytes`; aggregate browsing does not choose a discussion Room (`features/files-discussion/artifact-discussion.ts:73`). |
| Classification | `apps/mobile/src/lib/artifact-bytes.ts:105` accepts exact `.html` + `text/html` as Writer; other HTML is unsupported; no video kind. |
| Native original transport | `apps/mobile/src/lib/artifact-byte-download.native.ts:5` uses native file download with authorization and AbortSignal. |
| Writer rendering | `apps/mobile/src/features/artifacts/artifact-writer-preview-model.ts:36` accepts paragraphs/headings/flat lists, not tables or nested lists. |
| Canonical Writer | `packages/writer-proposal-core/src/writer-html.ts:166` parses the manifest and JSON document; the serializer can emit an empty HTML body (`:147`). Source-body-only viewing is therefore insufficient. |
| Existing static preview | `packages/first-party-apps/writer/src/office-document.ts:281` builds semantic HTML; its list builder (`:247`) and resource hydration need explicit compatibility work before shared reuse. |
| Images | `apps/mobile/src/app/files/artifact/[id].tsx:739` uses a ScrollView image branch; `components/message-bubble.tsx:261` renders attachment thumbnails. |
| Native handoff | `apps/mobile/src/lib/artifact-file-handoff.native.ts:9` invokes `expo-sharing`, not a dedicated destination-save operation. |
| Existing server primitives | `packages/server/src/routes/workspace-artifacts.ts:674` supplies authorized metadata; `:837` supplies authorized bytes and range responses. |
| Distinct attachments | `apps/mobile/src/hooks/use-room-chat-controller.ts:179` constructs message-attachment sources; these are not automatically Artifact IDs. |
| Native foundation | `apps/mobile/package.json` pins Expo 57, FileSystem, Sharing, Gesture Handler and Reanimated; `modules/nautilo-share-handoff/expo-module.config.json` demonstrates local native-module registration. Video/media-library/native WebView are not installed Mobile dependencies. |

Authorized follow-up inspection confirmed the reported file is canonical Writer (102 blocks), and current native clients visibly render its title, body and two embedded PNGs without modifying the source. A separate synthetic native fixture preserved static text/table/nested lists, suppressed script/event/frame/form/refresh behavior, disclosed missing resources, and required confirmation before handing a link to Safari/Chrome; return restored the same signed-in file. This does not claim full-content/layout/accessibility, network-exfiltration/cookie/bridge, malformed-input breadth or stale-session coverage.

## Proposed requirements

Requirements below were approved by the product maintainer on 2026-09-07. Named technical unknowns remain implementation/qualification obligations, not permission to bypass safety or silently drop scope.

1. **R1 Documents:** readable canonical Writer and static HTML, including headings, text styling, tables, nested lists, links and embedded PNG/JPEG/GIF data images. Preserve meaningful content and reading order; linked/relative or otherwise unsupported resources receive a visible notice and Save original fallback. Full source-bound linked/relative resource resolution is follow-up F2, not a tester-release claim. Saving retains the untouched source. Read-only does not claim full editor/layout parity.
2. **R2 Images:** natural-aspect full-screen view from Files and image attachments; pinch, enlarged pan, double-tap zoom/reset, accessible equivalents and reliable back/close. Derive zoom geometry from actual image and viewport; do not invent a replacement universal zoom ceiling.
3. **R3 Video:** supported native codecs, play/pause/seek/sound/full-screen controls; no autoplay with sound. Pause on leaving and coordinate with voice/audio focus. Unsupported or failed media retains Save file recovery.
4. **R4 Originals:** Save file… in file-list/viewer actions and preview failure on both platforms; independent of renderer and editing permission, subject to canonical read/export authority. Preserve bytes and filename/extension. iOS additionally exposes Share…. Do not infer recipient delivery from opening a sharing sheet.
5. **R5 Native destinations:** iOS Files export picker and Android system Create Document save; iOS Share…; supported images/videos can Save to Photos/Gallery with minimum permissions. Android tester delivery uses Save file → Android Files. Direct Android Share is follow-up F1 because chooser return is not recipient completion. No extra account, cloud-storage setup or custom file manager.
6. **R6 Recovery:** truthful loading/preparation, progress where available, cancel, retry, denial/unavailable state and return context. Unknown progress is indeterminate, never a fabricated percentage. No partial file represented as success or automatic full-app reset.
7. **R7 Authority:** separate authorized source identity, disposable local bytes, reader projection and explicitly exported copy. Fence stale completions by source/session/revision; revoke/dispose app-managed media when canonical access loss is observed. No credential exposure to document markup or external share targets.
8. **R8 Compatibility:** reuse design tokens, preserve Markdown editing/PDF and discussion behavior, support compact screens/accessibility/reduced motion and current orientation policy. Artifact and message-attachment authorities stay separate; paired-workstation files are not silently treated as server Artifacts.
9. **R9 Delivery:** qualify source/native clients, merge reviewed exact-head CI under merge authorization, reserve fresh version/build counters and publish signed TestFlight/internal-testing candidates. Prove actual tester installation and physical-phone behavior. Public submission is excluded until a later explicit go.

## Constraints and non-goals

Maintainer clarification (2026-09-08): HTML here is an authenticated server Artifact within the server's trust boundary, not an arbitrary web page. Preserve document layout and authored static CSS where possible. Reading authorization does not grant script execution, native device access or ambient authenticated network authority. This replaces the initial proposal to discard all source CSS; resource isolation and explicit fidelity notices remain required.

No arbitrary interactive HTML, new rich editor, all-codec transcoder, casting, background media player, download-manager/offline-sync service, new server/storage entity or model call. No change to global encryption-admission recovery. No cache presented as a user export. No source file conversion or remote document mutation to make Mobile display it.

## Product and architecture fit

```text
Files / conversation source
  -> canonical source adapter (Artifact OR message attachment)
  -> authorized metadata + original bytes / scoped disposable native file
       -> document reader | image viewer | video player
       -> native Save / iOS Share / Photos or Gallery
  -> completion or recoverable failure -> original context
```

| State | Owner / lifetime |
| --- | --- |
| Artifact identity, access, revision, bytes | Server; existing canonical persistence and Namespace access. |
| Message attachment identity and access | Existing server attachment contract; never cast into an Artifact ID. |
| Load/export attempt | Mobile UI/native execution; one bounded user-requested operation, cancelled/fenced on scope loss. |
| Temporary file and reader projection | Mobile-derived, source/session/revision scoped; release on last consumer, explicit cancellation cleanup and restart recovery. |
| Saved file/library item | User-selected destination/provider; independent copy, not subject to later automatic server update/deletion. |
| Discussion Room | Existing server-authorized conversation; opening/saving a file does not create or select a Room. |

No entity or relationship is added. Human authorization stays server-owned; Rooms/Namespaces determine content scope. Device-local rendering/export is a Channel capability. No Agent invocation is needed to parse, download, render or save. OS destination selection is consent to create a user copy, not a new Nautilo authorization grant.

### Proposed implementation spine

- Keep the current aggregate Artifact read as the source adapter. Add an explicit original-byte intent that does not pass through preview eligibility. Preserve message attachments through a distinct source adapter with their own identifier and checks; share presentation only after resolving an authorized native source.
- Extract a pure static Writer renderer into an existing browser-safe shared package, rather than importing first-party app UI into Mobile. Parse the canonical envelope first; render the actual payload with nested-list/table/image support, safe inline style and link projection, escaped text/attributes and visible diagnostics. Preserve existing consumers until parity is proved. Unknown styling must retain its text and disclose fidelity loss, not reject or silently omit the block.
- Parse generic HTML with a maintained structural parser, not regex substitutions. Generate a closed semantic document from allowed elements/attributes/styles. Drop executable behavior, not meaningful text silently. No source-script execution or raw authenticated page embedding.
- Propose a native read-only WebView only for generated, isolated document markup, conditional on dependency approval and platform isolation qualification. Disable script, DOM storage, native messaging and general file/content access; no authenticated base URL/cookies. Apply restrictive CSP. Safe tapped external links leave only through an explicit native navigation handler; page-initiated navigation is denied. Verify actual platform behavior, not prop names alone.
- Embedded PNG/JPEG/GIF raster data is validated before presentation. Unresolved relative, linked, remote, SVG and other unsupported resources show a visible placeholder/notice with Save original fallback; they are never turned into credential-bearing requests. F2 tracks a future reviewed resolver contract for source-bound linked/relative references. Do not inject active/resource-bearing formats raw.
- Reuse Gesture Handler + Reanimated for image geometry/gestures. Full-screen viewer owns only fit/scale/offset and contextual return.
- Prefer Expo Video as a thin native player, not a custom decoder. Initial proposal: native-download to a scoped file with visible preparation/cancel, then local playback/seeking. This avoids making remote range-token/revision behavior a prerequisite; it delays first playback until the download completes. Direct remote streaming is a separate option if its compatibility proof is completed before approval.
- Use one narrow local native export module: iOS document export/cancel callback; Android Create Document result followed by streamed write/close and error cleanup. Only trusted app-generated temporary source files are eligible. No arbitrary native filesystem API exposed to untrusted content.
- Use SDK-supported media-library add/save capability for Photos/Gallery. Do not ask for photo-library browsing access merely to save an original.
- Reuse native FileSystem cancellation; show indeterminate preparation if its selected API lacks byte progress. Do not introduce a background transfer service solely to manufacture a percentage.

## Unknowns and decision forks

### Proposed minimum contracts from independent review

- **Attempt identity:** server identity, signed-in Human/account, source kind, source ID, canonical revision/digest when provided, and request generation. Native filenames use an opaque collision-resistant key derived from this scope, never credentials. Every completion compares the live tuple, discards mismatches and releases owned temporary bytes. A locally calculated digest proves local-copy equality, not correspondence to a canonical revision. Immutable acquisition remains an unresolved server-contract decision below.
- **Attachment projection:** carry the attachment reference's own ID, filename, declared MIME/size, originating message/Room and return-position key into its source adapter. Treat declarations as presentation hints until byte validation. A pressable thumbnail/file row opens that adapter; it never becomes an Artifact route by casting its ID. Do not invent an attachment revision when the source supplies none. Missing authorized metadata is an explicit unavailable state, not permission to infer a URL from display text.
- **Static HTML policy:** preserve semantic structure, authored static CSS and safe presentation attributes. Preserve unknown non-executable containers' text in reading order with a fidelity notice. Remove scripts, active frames/objects, event handlers and form submission behavior, not the document's visual design. Links require an explicit native confirmation before opening validated `https:`, `http:` or `mailto:` destinations outside the reader. Embedded raster data uses MIME/syntax/header checks; actual codec decoding remains the native renderer's responsibility. Other resources have visible capability notices/placeholders, never credential-bearing requests. Generated CSP: `default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`. The exact iOS/Android WebView behavior still requires device proof; CSP alone is not acceptance.
- **Protected content:** Save/Share may not introduce an alternate admission or PIN flow. They must await the existing canonical admission result and honor endpoint denial; on observed expiry/revocation cancel transfer/player, fence completion and remove owned temporary content. Native export already completed is an independent user copy. Mapping actual protected denied/admitted/expired responses for both source adapters remains an explicit pre-implementation contract task.
- **Resource budgets:** native transport does not make whole-document JS decode bounded. Before renderer implementation, qualify representative source sizes, expanded text/DOM/node and raster-pixel costs on both deployment targets and record the resulting measurement-backed admission thresholds. Exceeding a qualified reader budget offers Save original without partial success. Native downloads must also handle actual free-space exhaustion and clean partial files. No new numerical limit is approved by this draft.

1. **Original failing file:** obtain a safe fixture or an authorized inspection. Synthetic table/list tests are not proof of that particular report.
2. **Video startup:** recommended first path downloads to native disk before playback; direct streaming starts sooner but requires header/redirect/range/revision proof. Confirm this visible behavior before implementation; do not claim immediate streaming from a local-file player.
3. **HTML fidelity/resources:** qualify the parser/WebView boundary and a real representative HTML document. Reader layout may differ from authored CSS; blocked resource content must be disclosed. Do not hide unresolved embedded-resource support behind a generic success label.
4. **Source consistency:** choose and prove a native acquisition consistency contract using existing revision/digest mechanisms where available. Metadata recheck is a conservative guard, not proof of an immutable concurrent transfer. If exact immutable download needs server changes, return the narrow API contract for review.
5. **Native packaging:** prove the chosen export and add-only media APIs on both deployment targets before promising destination completion. SDK documentation is not device evidence.

## Implementation seams

Mobile: `features/files-discussion/artifact-discussion.ts`, `lib/artifact-byte-download.*`, `lib/artifact-bytes.ts`, `features/artifacts/*preview*`, `artifact-viewer-actions-sheet.tsx`, `app/files/artifact/[id].tsx`, Files row/menu, `message-bubble.tsx` and attachment controller mapping. Native adapters under `apps/mobile/modules/`; package/config/lockfile changes controlled centrally.

Shared: existing `writer-proposal-core` or an already browser-safe reader package for pure document generation; do not add a new service. Inspect canonical image/table schema before selecting the exact package seam. Existing first-party Writer consumers change only if shared extraction requires tested parity.

Server: no D582 save/storage rewrite remains in scope. The maintainer withdrew the exact-revision extension; preserve existing persistence and bytes APIs. See the rollback boundary below.

## Failure, recovery, and rollback

| State | Visible behavior / action |
| --- | --- |
| Opening/preparing | Keep route and title; truthful progress/spinner; Cancel returns to source. |
| Ready | Read/zoom/play; Save actions refer to the original source on both platforms; iOS also offers Share. |
| Partial document capability | Visible affected-block/resource notice and Save original; no claim of complete fidelity. |
| Offline/network failure | Keep context; Retry reacquires under current identity. Preserve mounted content only where existing authorization policy permits; no new offline authority. |
| Canonical denial/deletion/revocation | Stop exposing affected app-managed content, stop transfer/playback and clean eligible cache; return/retry as appropriate. Previously exported user copies are not remotely retractable. |
| Destination cancelled | No Saved toast; return to same viewer. |
| Destination write/storage failure | Error with Retry/choose another destination; partial write cleaned if provider permits, otherwise explicit residual warning. |
| Save completed | Saved filename only after platform completion; optional Open if supported. OS/provider acceptance is not a guarantee cloud sync has finished. |
| iOS Share handed off | Native share flow; do not label delivery to recipient successful without evidence. Android direct Share is F1; use Save file → Android Files in this release. |
| Identity/source changed | Cancel/fence attempt, discard late UI results and release owned bytes. |

Preserve prior signed binary as rollback. No canonical document migration or server-side content rewrite. A failed newer viewer can offer original save; it must not silently downgrade authorization.

## Security and privacy

Authorization is revalidated through existing source endpoints, including applicable protected-content admission. Sharing/export is explicit, source bytes only; no bearer/PIN/provider credential leaves via filename, logs, markup or metadata. Markup is untrusted data; no script or bridge capability. Temporary data is not public media storage until the user requests a save. Test process death, cancellation, identity change and observed access loss.

Do not treat arbitrary inherited limits as authority. Record each touched byte/decode/zoom/retry/retention boundary with its platform/provider, measured-resource, security or explicit user-policy basis. Use native streaming/bounded decode; disclose partial processing and recovery. Existing constants are not automatically accepted for the new paths.

## Interaction evidence

```text
FILE VIEWER                  FILE ACTIONS                PREVIEW FAILURE
< Back   document.html   ... Save file...                document.html
                            Share... (iOS)              Preview unavailable
[readable document]          Save to Photos/Gallery*     [Save file...] [Retry]
                            Share access in Nautilo...  < Back
[Room chat stays available]  Rename / Delete if allowed
                            Cancel
* only eligible media

SAVE FLOW
Save file... -> Preparing original [Cancel]
            -> native destination/name picker
            -> platform writing/export completion
            -> Saved: filename     (same viewer underneath)
Cancel at a stage never becomes Saved.
```

Use existing sheet, typography and theme tokens. Filename truncation is presentation-only; destination receives the full safe basename/extension. Compact widths wrap labels and keep Cancel/back reachable. Document tables may scroll horizontally within the document; no page-wide clipped controls. Image fit follows source aspect ratio. Video uses native accessible controls; gesture alternatives are labeled buttons. Restore focus and source scroll on close. Respect large text/reduced motion; no mandatory animations. Maintain the app's current portrait policy unless a reviewed full-screen-only orientation exception is necessary.

## Integration addendum

No external SaaS integration. Native file providers and media libraries own their destinations; the app records only truthful operation completion, not remote-provider sync/delivery guarantees.

## Verification

- Characterization: existing active-loader, Writer and convergence tests at exact baseline; keep legacy helper coverage separately identified.
- Documents: canonical envelope/body-empty fixtures; tables/spans/nested cell blocks; mixed nested lists; inline styles and links, including unknown styling; inline PNG/JPEG/GIF data images; general HTML; explicit unknowns and unavailable-resource notices with Save fallback. Hostile markup, navigation, resource and credential-isolation probes on native WebView. Measure source-to-decoded/DOM/raster expansion before fixing reader budgets. Linked/relative resolution belongs to F2.
- Sources: Artifact and message attachment separately; scope/revision/account/server switch, denied/missing/revoked, protected denied/admitted/expired, interruption and cleanup. Verify original export byte hashes, duplicate names, cancellation and full-storage outcomes.
- Images: real two-finger pinch/pan and double-tap on iOS/Android; portrait/landscape-shaped large sources, accessible controls and return position.
- Video: real supported/unsupported codecs, preparation, seek/audio/full-screen, audio-focus/voice coexistence, leaving/background/retry and source loss. Measure actual startup time/memory for representative files.
- Packaging: native modules/config/dependency inventory, fresh native clients and existing mobile-web export compatibility. Run appropriate lint/typecheck/unit/unused/limits gates, exact-head CI and scoped review before merge.
- Delivery: 0.1.2 is verified consumed. The release owner selects the marketing version before reservation. Allocate new monotonic build IDs only after that decision; then require release notes/ledger, both tester tracks truly available, actual installed version proof, real-phone media/save and relay pairing acceptance. Do not submit a production release.

## Delivery slices

1. Save authorized originals from real UI through native destinations; preview support is not a dependency.
2. Read Writer/static HTML in place with isolated resources and honest incomplete states.
3. Inspect images from Files/chat with actual cross-platform gestures and contextual return.
4. Watch supported videos with native controls and recoverable failure.
5. Qualify the integrated signed candidates, deliver them to testers and collect physical-phone results.

The spec/proposal and low-level adapters are enabling work, not user delivery milestones.

## Stewardship

Mobile product/engineering maintainers own presentation, native package drift, tests and tester qualification; document/trust maintainers review shared rendering and source authority. Confirm named reviewers during scoped approval. Store-facing wording and final public submission retain explicit product approval.

## Maintainer decision

_Implementation and specification publication approved by the product maintainer on 2026-09-07._

- Decision: `APPROVED FOR IMPLEMENTATION`
- Approved scope: R1–R9 and the staged tester-only delivery described here; specification publication authorized. Production release still requires separate approval.
- Required revisions: Resolve and prove the named technical contracts in implementation; return any material expansion or weakened safety/visible capability to review. Approval is not evidence that device behavior, original-file reproduction or immutable acquisition is already proved.
- Approval expiry or revalidation trigger: source/authorization changes, native dependency/API changes, material renderer/media scope change.

## Primary platform references

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [Expo FileSystem](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/)
- [Expo Video](https://docs.expo.dev/versions/v57.0.0/sdk/video/)
- [Expo MediaLibrary](https://docs.expo.dev/versions/v57.0.0/sdk/media-library/)
- [Apple document picker](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller)
- [Android document saving](https://developer.android.com/training/data-storage/shared/documents-files)


## Download consistency boundary — maintainer rollback, 2026-09-08

**R10 is WITHDRAWN, not deferred or conditionally approved.** The maintainer directed rollback of the exact-database-revision download extension and its save/storage expansion. Do not restore it from earlier commits, reviews, or test results.

- Remove the new original endpoint, capability flag, shared replacement adapters and extra per-save object retention introduced for Mobile.
- Preserve existing server/agent/database persistence, canonical authorization and pre-existing coordinated history. This rollback does not delete user data or claim to repair older storage-lifecycle debt.
- Preserve Mobile reader/media/native Save and attachment access/cleanup work. Original acquisition uses the existing authorized bytes API with metadata, source/session and access rechecks. These detect ordinary races; they do **not** prove a snapshot or exact revision.
- A bounded, on-demand stable-file snapshot is a possible follow-up, not an implemented or qualified replacement. It needs a narrow reviewed contract, writer-coordination proof, temporary-storage/concurrency admission and cancellation/crash cleanup. Do not substitute unchecked copying, a whole-download database lock, permanent per-edit copies, or an automatic retry loop.
- No retain-copies tester exception or garbage-collection implementation is approved. The withdrawn design and its cleanup gate are removed from this Mobile release. Remaining download consistency qualification stays explicit in task 2.1.1; do not mark it solved by this rollback.
