# Mobile documents, media, and saving originals

## Scope

This design specifies Mobile document previews, media inspection, and saving
originals. It is a contributor specification, not a store-release announcement.
See the [Mobile guide](https://nautilo.ai/docs/use/mobile) for user instructions
and [Mobile source](../../../apps/mobile/README.md) for build information.

## Outcome

A signed-in person can open their authorized document, inspect an image, watch a video, or save/share its original from Mobile Files or the appropriate conversation entry point. They return to the same conversation/file position. A failed preview never traps a downloadable original.

## Requirements

The requirements distinguish intended behavior from the compatibility and
consistency limitations described below.

1. **R1 Documents:** readable canonical Writer and static HTML, including headings, text styling, tables, nested lists, links and embedded PNG/JPEG/GIF data images. Preserve meaningful content and reading order; linked/relative or otherwise unsupported resources receive a visible notice and Save original fallback. Full source-bound linked/relative resource resolution is separate work, not guaranteed by this design. Saving retains the untouched source. Read-only does not claim full editor/layout parity.
2. **R2 Images:** natural-aspect full-screen view from Files and image attachments; pinch, enlarged pan, double-tap zoom/reset, accessible equivalents and reliable back/close. Derive zoom geometry from actual image and viewport; do not invent a replacement universal zoom ceiling.
3. **R3 Video:** supported native codecs, play/pause/seek/sound/full-screen controls; no autoplay with sound. Pause on leaving and coordinate with voice/audio focus. Unsupported or failed media retains Save file recovery.
4. **R4 Originals:** Save file… in file-list/viewer actions and preview failure on both platforms; independent of renderer and editing permission, subject to canonical read/export authority. Preserve bytes and filename/extension. iOS additionally exposes Share…. Do not infer recipient delivery from opening a sharing sheet.
5. **R5 Native destinations:** iOS Files export picker and Android system Create Document save; iOS Share…; supported images/videos can Save to Photos/Gallery with minimum permissions. Android uses Save file → Android Files. Direct Android Share is outside this scope because chooser return is not recipient completion. No extra account, cloud-storage setup or custom file manager.
6. **R6 Recovery:** truthful loading/preparation, progress where available, cancel, retry, denial/unavailable state and return context. Unknown progress is indeterminate, never a fabricated percentage. No partial file represented as success or automatic full-app reset.
7. **R7 Authority:** separate authorized source identity, disposable local bytes, reader projection and explicitly exported copy. Fence stale completions by source/session/revision; revoke/dispose app-managed media when canonical access loss is observed. No credential exposure to document markup or external share targets.
8. **R8 Compatibility:** reuse design tokens, preserve Markdown editing/PDF and discussion behavior, support compact screens/accessibility/reduced motion and current orientation policy. Artifact and message-attachment authorities stay separate; paired-workstation files are not silently treated as server Artifacts.
9. **R9 Delivery:** test the source and native clients, then verify the resulting signed builds on physical devices before release. A passing unit test does not establish native destination behavior.

## Constraints and non-goals

HTML here is an authenticated server Artifact, not an arbitrary web page. Preserve document layout and authored static CSS where possible. Reading authorization does not grant script execution, native device access or ambient authenticated network authority. Resource isolation and explicit fidelity notices remain required.

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
- Embedded PNG/JPEG/GIF raster data is validated before presentation. Unresolved relative, linked, remote, SVG and other unsupported resources show a visible placeholder/notice with Save original fallback; they are never turned into credential-bearing requests. Source-bound linked/relative references require a separate resolver contract. Do not inject active/resource-bearing formats raw.
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

Server: preserve existing persistence and bytes APIs. An exact-revision download extension is outside this scope; see the download-consistency boundary below.

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
| iOS Share handed off | Native share flow; do not label delivery to recipient successful without evidence. Android uses Save file → Android Files; direct Share is outside this scope. |
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
- Documents: canonical envelope/body-empty fixtures; tables/spans/nested cell blocks; mixed nested lists; inline styles and links, including unknown styling; inline PNG/JPEG/GIF data images; general HTML; explicit unknowns and unavailable-resource notices with Save fallback. Hostile markup, navigation, resource and credential-isolation probes on native WebView. Measure source-to-decoded/DOM/raster expansion before fixing reader budgets. Linked/relative resolution needs separate verification.
- Sources: Artifact and message attachment separately; scope/revision/account/server switch, denied/missing/revoked, protected denied/admitted/expired, interruption and cleanup. Verify original export byte hashes, duplicate names, cancellation and full-storage outcomes.
- Images: real two-finger pinch/pan and double-tap on iOS/Android; portrait/landscape-shaped large sources, accessible controls and return position.
- Video: real supported/unsupported codecs, preparation, seek/audio/full-screen, audio-focus/voice coexistence, leaving/background/retry and source loss. Measure actual startup time/memory for representative files.
- Packaging: native modules/config/dependency inventory, fresh native clients and existing mobile-web export compatibility. Run appropriate lint/typecheck/unit/unused/limits gates, exact-head CI and scoped review before merge.
- Delivery: verify the exact signed build installed on each platform and test real-device media/save behavior. Follow the [release procedure](../../../RELEASE.md) for version allocation and publication.

## Delivery slices

1. Save authorized originals from real UI through native destinations; preview support is not a dependency.
2. Read Writer/static HTML in place with isolated resources and honest incomplete states.
3. Inspect images from Files/chat with actual cross-platform gestures and contextual return.
4. Watch supported videos with native controls and recoverable failure.
5. Qualify the integrated signed candidates, deliver them to testers and collect physical-phone results.

The spec/proposal and low-level adapters are enabling work, not user delivery milestones.

## Stewardship

Mobile product/engineering maintainers own presentation, native package drift, tests and tester qualification; document/trust maintainers review shared rendering and source authority. Confirm named reviewers during scoped approval. Store-facing wording and final public submission retain explicit product approval.

## Primary platform references

- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/)
- [Expo FileSystem](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/)
- [Expo Video](https://docs.expo.dev/versions/v57.0.0/sdk/video/)
- [Expo MediaLibrary](https://docs.expo.dev/versions/v57.0.0/sdk/media-library/)
- [Apple document picker](https://developer.apple.com/documentation/uikit/uidocumentpickerviewcontroller)
- [Android document saving](https://developer.android.com/training/data-storage/shared/documents-files)


## Download consistency boundary

This design does not add an immutable exact-revision download endpoint,
per-save object retention, or a server storage rewrite. Existing persistence,
authorization, and coordinated history remain authoritative.

Mobile acquires original bytes through the existing authorized API, with
metadata, source/session, and access rechecks. Those checks detect ordinary
races; they do **not** prove a snapshot or exact revision during a concurrent
write. Save must not be described as an immutable-revision guarantee.

A future stable-file snapshot needs its own writer-coordination contract,
storage/concurrency admission, and cancellation/crash cleanup. Unchecked copying,
a whole-download database lock, permanent per-edit copies, and automatic retry
are not substitutes for that contract.
