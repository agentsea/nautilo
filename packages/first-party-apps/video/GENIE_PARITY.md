# Video Genie parity

Release qualification: the dated sections below are historical acceptance
checkpoints, not a claim that each intermediate tool count or limitation is
current. Version 0.2.2 exposes 19 tools. The final limits inventory and reviewed
decision gate pass; remaining work is explicitly tracked in [FOLLOW_UPS.md](FOLLOW_UPS.md).
Live test evidence does not imply production deployment or a paid retry.

## Supported document-editing contract

The approved catch-up uses the existing document host, shared pure commands,
manifest approval pipeline and authored-write recovery. It does not create a
second editor, clipboard store, media grant, generation queue or renderer.

1. `inspect-timeline` returns the saved version, exact scoped counts, all track
   names/protection and Media Bin identities. `includeClips: true` adds complete
   clip timing/source windows, links, supported properties and measured cut
   transition handles. Source paths and preview leases are not disclosed.
2. `preview-timeline-edit` runs the exact operations without writing. It returns
   changed clips with before/after values, changed track IDs, durations and
   protected tracks. This is a structural preview, not decoded video. IDs created
   by the preview are provisional; only the successful edit receipt supplies
   persisted new IDs.
3. `edit-timeline` applies the reviewed batch in order and writes once only after
   all commands and serialization pass. Its impact remains `high`, with existing
   `use_project_content` authority. Required `expectedSha256` and optional revision
   come from inspection. Stale intent refuses; write conflicts and uncertainty
   must not trigger blind replay. Existing host author/recovery behavior is reused.

The operation grammar uses `op: track` plus `mode: add/update/delete/reorder`,
`op: links` plus `mode: link/unlink`, and named clip/effect/selection operations.
Tracks are universal lanes; their persisted legacy kind is not a media filter.
Links are added or removed among the supplied clips without breaking outside
links. Existing locked/hidden peer protection applies.

Supported operations cover 20 actions: track add/update/delete/reorder; clip
add/move/group move/trim/split/delete/detach; link/unlink; text and audio settings;
fade and transition apply/adjust/remove; range/clip deletion, duplication and
relocation. A zero effect duration removes that effect. Text properties are
explicit; arbitrary properties, media refs and scripts are not accepted.

Selection operations reuse the human clipboard kernel: nonempty IN/OUT takes
precedence, hidden tracks are excluded, cuts leave gaps, and original-lane paste
refuses collisions. `copy-selection` duplicates directly to `destinationSec`;
`move-selection` cuts and pastes atomically there. The internal clipboard never
enters model output or persists between calls. This is equivalent editing without
an OS or cross-project clipboard. If paste fails, the cut does not persist.

Live context now includes multi-selection, range precedence, selected effect
properties, named track protection and clean saved identity. Context can describe
a dirty draft; saved-document inspection is not a claim to see that unsaved work.

## Open-editor transport catch-up (implemented; partial live acceptance)

`control-open-video` supplies inspect, play, pause, seek, preview-range and
clear-range. These are transient editor controls, not edits to the project or
render/export requests. A separated range plays from IN to OUT and stops;
clear-range restores full-sequence navigation. Seeking outside the selected
range refuses instead of silently clamping the requested position.

The trusted first-party extension admits only this tool's closed command and
result shapes. The normal tool approval and `use_project_content` gate remain.
The host binds app, actor, document version and the already-issued live session;
the model supplies no path, token, media lease, socket or destination. Background
Tasks cannot inherit this control. The parent forwards to the exact mounted
iframe through a one-use reply port. The app checks its clean saved identity
again immediately before changing its transport state. Human edits remain
authoritative; the command never silently saves or discards a draft.

The command broker has no durable queue or replay history: one waiting receiver
and at most one in-flight command per live session. Unavailable/busy refuses with
`stateChanged: false`; interrupted delivery or a lost worker response reports
`stateChanged: unknown`, `retrySafe: false`. The tool invocation's existing
deadline owns cancellation and port cleanup; receive attempts derive their
lifetime from the issued session expiry. Renewing document versions does not
restart the receiver. A dropped connection is not blindly retried; reopening or
renewing the session establishes a fresh receiver.

`ready` confirms the editor's requested transport state only. In particular,
`playbackConfirmed: false` prevents Genie from claiming that media decoded or
audio was heard merely because the play button is active. Independent decoded
media observations remain necessary beyond this transport acknowledgement.

Live Workspace acceptance found that Chromium can suspend animation frames in
an offscreen Desktop window while native media continues. Playback now races
each animation frame with a cancellable wake-up derived from the project's
frame rate. Only one wins; pause/unmount cancels both. This is a transport
sampling cadence, not a retry, media truncation, or a new sequence-duration cap.
The regression simulates suspended animation frames and delayed timers and
proves range completion, cleanup and no save. Browser timer throttling still
means offscreen rendering is not a frame-accurate presentation guarantee.

Experience preflight: the user asks to preview a section; Genie uses a closed
command and the editor's existing preview/timeline, without file paths or a
second control screen. Architecture verdict: ready with named qualification
gates. Durable project bytes stay with the document authority; transient state
stays in the iframe. Snapshot Video edit tools remain enabled while a transport
session is open, unlike Writer/Design's protected live mutation contract. No new
renderer, database, binary, provider or standing authorization is introduced.

## Remaining parity gates

- Complete live Moxie coverage beyond the Workspace inspect/range-preview test:
  Current Folder, reconnect and dirty-draft refusal still require live proof.
- Live qualification of host-bound native media import/export, cancellation,
  frame-rate choice and reconnect recovery, implemented below. Native file/save
  dialogs still require human selection; this is not arbitrary-path or unattended
  filesystem automation. The old unadvertised `renderPreview`/`exportVideo`
  handlers remain unavailable; the new path is `manage-video-media`.
- Live qualification of generation and scene/block organization tools described
  below. Direct source-preview control and all generator block-content editing
  are not supplied by this increment; do not claim complete generator parity.
- The previous copied-media/save acceptance is recorded separately in private
  acceptance evidence: live edits, human conflicts,
  reopen and a decoded MP4 were verified. That evidence does not qualify the
  new transport command channel or all future effects.
- Clip speed, independent audio crossfade and other editor features not yet
  implemented are not made available by adding agent tools.

## Verification

`timeline-agent-parity.test.ts` checks all action variants against saved/reopened
documents, schema/export coverage, pure human/effect command parity and render
plans, hidden linked range cuts, rollback, stale versions, write conflict,
malformed arguments and protected tracks. Mounted editor tests verify paused
range and additive-selection context updates without saving. Server manifest
tests verify the closed schema and unchanged authority/impact classification.

Transport coverage adds pure playback planning, mounted range/play/pause/seek
and no-save behavior, dirty/stale rejection, exact-session HTTP delivery and
acknowledgement, host actor/app/tool/background gates, worker cancellation and
unknown outcomes, and iframe parent/version/session/deadline fencing. The
latest regression run passed 705 tests (3,684 assertions, 47 files);
Server, Workbench and Video typechecks, focused lint and the Workbench production
build passed before the offscreen fix; that fix also passed Video typecheck and
focused lint. `limits:check` again produced no result and was interrupted to
avoid prolonged CPU use; its qualification gate remains open. No limit baseline
or generated inventory was changed.

Only the retained populated acceptance clone was restarted for the new
build. Health was `ok`, and its installed manifest exposes the 13 tools including
`control-open-video`. The retained saved QA copy was reopened. Moxie discovered
the tool through the ordinary catalogue and used one-time approvals. After the
offscreen fix, independent media observation confirmed decoded playback for
the selected 2–4 second range, followed by paused decoders at the final frame
and a 4.00 second playhead. No remote CI, merge or production release is implied.

## Generation continuation tools — September 8

- `inspect-generation` reads the saved document version, scenes, reusable
  reference IDs, Media Bin IDs and completed takes. It does not expose source
  paths in its reference/media summaries.
- `edit-generation` appends or updates a scene's title, prompt, duration,
  camera/motion, references and continuation flag through the canonical
  optimistic document write. It leaves timeline clips unchanged. Reference
  IDs reuse saved references; media IDs bind existing image/video Media Bin
  items. First-scene continuation and unknown references fail without a write.
- `review-generation` uses the host-bound active editor, not a model-authored
  session token or arbitrary target. It requests one saved scene through the
  same visual, exact-price human approval. An optional completed take must
  belong to the preceding scene and pass host revalidation. Explicit model and
  settings are applied through the shared compiler. `review_requested` means
  preparation started, NOT that a quote is ready, payment occurred, or output
  completed. Do not automatically replay uncertain requests.
- Existing receipt recovery admits completed output to the Media Bin and saves
  it automatically. Inspect the saved project again to discover its take before
  requesting the next continuation.

Mounted tests prove explicit 4-second/480p/audio-off continuation review,
duplicate and stale refusal, wrong-scene take rejection before quoting, and
no paid submission on cancellation. Shared human/Genie visual review uses
authenticated exact public-artifact lookup and verifies SHA-256, size and MIME
against the quoted reference binding before displaying local object URLs.

September 8 qualification for this increment: 421 Video tests, 61 shared
contract/API/server tests, 37 Workbench review/lifecycle tests, and one isolated
permission-scoped public-reference route test passed. Video, Types, API client,
Agent, Server and Workbench typechecks, focused source lint, Workbench build and
diff whitespace checks passed. Real local image and both video references
decoded in a separate visual harness at wide and narrow widths. Only the
retained acceptance clone was restarted; its installed manifest then had
16 tools and instance-aware runtime verification passed. The new live Moxie
continuation round trip and a separately approved paid continuation remain
unverified. No new paid generation, commit, PR, merge or release was performed.

## Native media and scene organization — September 8 follow-up

- `organize-generation` deletes or reorders scenes and direction blocks through
  the human UI's pure helpers, then performs one optimistic document write.
  `inspect-generation` supplies effective block IDs, including legacy direction.
  Invalid batches and stale versions write nothing. Deleting direction retains
  completed takes, Media Bin assets and timeline clips. Scene moves preserve
  block identity and synchronize canvas order. Continuation remains relative to
  the new preceding scene; an opening scene cannot generate as a continuation
  until its flag is corrected.
- `manage-video-media` uses the active host-bound editor and existing Desktop
  import/export bridge. Import opens the native chooser, admits media to the
  Media Bin without inserting clips, and reports success only after autosave.
  First-source rate decisions use an inspected operation ID. Export sends the
  exact clean saved snapshot to the existing renderer/save dialog; additional
  Workspace publication is an explicit boolean, with a separate final status.
- `inspect-video-media` is read-only even with forged mutation arguments.
  It reports the latest import/export operation IDs, stages, progress, saved
  media ID and confirmed export result. These are bounded by the two existing
  operation slots, not a durable second job queue or polling service.
- Observation and exact-operation cancellation remain possible during human
  edits. Starting work refuses dirty/stale documents. External content refresh
  fences pending import admission. Native import cancellation prevents late
  Media Bin admission but cannot erase a host upload that already happened;
  export completion wins a late cancellation. Lost responses report unknown,
  never safe retry. After reopening, inspect canonical saved results rather than
  treating missing session receipts as proof that nothing happened.

Product and architecture preflight kept the existing document, host permission, native
dialog and renderer authorities intact. No provider, native IPC, database,
filesystem-path bypass, persistent operation store or paid approval was added.

Qualification: 479 tests across Video and the manifest/live-extension/broker
suites passed; Video, Server and Workbench typechecks, focused lint, Video
browser build and diff whitespace checks passed. Additional organization checks
verify completed takes survive deleting all scenes and reopening. Mounted
tests cover save failure, late import after refresh, uncertain export response,
progress, rate choice, duplicate refusal, cancellation while dirty and late
successful publication. Native media is stubbed in these tests: they do not
prove the live OS dialogs or a real Moxie round trip.

Only the retained acceptance clone was restarted from this worktree.
Its installed 0.2.1 manifest now exposes 19 tools; instance-aware runtime
acceptance passed. The installed app and protected default were untouched.
No paid generation, commit, PR, merge or release occurred.
