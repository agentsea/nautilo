# Video Timeline capability and authored-write matrix

## Genie document-editing parity (2026-09-07)

The current tool contract is [GENIE_PARITY.md](GENIE_PARITY.md), superseding the
historical ten-tool inventory below. Inspection includes version, media identities,
track protection and optional complete scoped clip/effect/source metadata. Two
new advertised tools provide structural preview and atomic editing across 20
actions through the human command kernel. Expected versions fence stale intent;
failed operations or a failed paste do not partially persist. Link/unlink subset
edits preserve reciprocal outside links. Live context includes range and complete
multi-selection even while paused, with no transient-state document writes.

Host media import/transport/export and Generate controls remain unwired for Genie;
live approved/autonomous actor and rendered-output acceptance remain open. No
full human/Genie parity or release-readiness claim is made.

Verification: 383 Video tests (37 files, 2,011 assertions), 40 server manifest
tests, Video typecheck/build, scoped lint and diff checks pass. The running clone
was not refreshed; there is no new native render, remote CI or deployment proof.

## Media Bin source preview and hidden-track editing (2026-09-07)

Video assets now have a compact 16:9 source preview and explicit Play button in
the Media Bin. Playback starts muted; native controls allow scrubbing and sound.
It does not insert a clip, move the timeline clock or write history. Only visible
cards in the open Media library retain host-authorized preview leases. Leaving
the library releases them; late replies are revoked. Only one bin source plays
at a time; starting timeline playback pauses it, and source playback pauses the
timeline. Failure stays in the card with Retry. No source paths or extra host
grants are exposed.

Hidden tracks are excluded from range and clip cut/copy/delete even when linked
to visible clips. Hiding a linked peer no longer blocks those operations. Its
media, timing, effects and hidden state are preserved; link references alone are
reconciled when visible counterparts are split/deleted, avoiding dangling IDs.
Undo restores the edit and links together. Copy excludes hidden peers; paste
still refuses hidden destinations. Direct editing of a hidden clip is refused.
Explicitly locked visible linked tracks retain the existing atomic protection.
Move/trim/split and explicit linked-effect operations retain their existing
protection semantics; this correction targets cut/copy/delete.

Verification: 349 Video tests pass, plus package typecheck, build and focused
lint. Regression coverage includes hidden linked range cuts, whole-clip copy/
delete, source/timing preservation, link repair, save/reopen and Undo. Preview
tests cover explicit playback, no autoplay, timeline pause handoff, hidden-card
lease cleanup, late replies and Retry. Full live playback remains a separate
acceptance step, not inferred from mounted tests.

## Immediate effect drops (2026-09-07 follow-up)

Product preflight removed the mandatory form from drag/drop. Fades, Crossfade
and Swipe apply on drop through the existing validated command/history/save
path; handles appear immediately. Exact numeric settings remain optional.
Re-dropping an existing effect preserves its custom settings. Defaults reuse
the existing one-second suggestion, shortened to actual footage or linked
clip length; no new hard ceiling or render semantics were introduced.
Eight additional mounted drag/drop cases prove no preselection, typing or Apply
is required, one-step Undo, physical-handle defaults, repeat-drop preservation,
gap/handle refusals and atomic linked-track protection. Full Video suite:
346 pass, zero failures; typecheck, build and focused lint pass. Native render
code is unchanged from the preceding actual-MP4 checkpoint. Live native drag
acceptance remains separate from these mounted event tests.

## Cut transitions (2026-09-07)

Crossfade and four-direction Swipe are implemented. Drop a tile at an adjoining
cut to apply immediately, with the existing one-second suggestion shortened
to available source handles. No typing or Apply is required. A gap refuses.
Selecting an incoming clip and clicking a tile still opens optional exact
settings. Browsing alone does not mutate the document. A small cut badge
has symmetric duration handles; Escape cancels a draft, Delete removes the
effect only, and Undo restores it. Locked/hidden lanes refuse edits.

Cut position and project length remain unchanged. Derived source handles supply
two simultaneous frames, not fades through black or frozen footage. Measured
source durations, available handles and neighboring transitions bound duration.
Missing footage produces a visible refusal. Embedded audio blends; already
separated audio is unchanged. Independent-track audio crossfade and clip speed
remain unavailable. There is no new Genie effect tool or host grant.

The incoming clip owns the canonical transition. Manifest 1.2 protects it from
older readers; shared evaluation and native export use derived source windows.
Commands refuse edits that orphan the pair, with remove-first recovery. Pair
moves and whole-pair copy/paste preserve/remap the effect; partial-pair copy and
detaching audio through an active transition refuse atomically.

Verification: 338 Video tests and 38 focused Desktop render/publication tests
pass, including mounted inspector/drag/Undo/save and two-decoder preview tests.
Real MP4 tests inspect crossfade pixels, four swipe directions, duration and
decoded audio amplitude. Both package typechecks, Video build, Electron build
and focused lint pass. The named clone/profile was refreshed; full live
apply/play/reopen/export and light/narrow visual acceptance are not yet proven.
Live checkpoint: the existing seven-clip document reopened, its media waveform
loaded, and Transitions exposes Crossfade/Swipe for the selected middle video
slice. Saved remains clean with no Undo entry; no content was changed. The UI
driver still returns lagging actions and `noWindowsAvailable` on scroll, so
this is discovery/reopen evidence, not a live transition acceptance claim.
The repository-wide limits check was stopped after more than nine minutes at
full CPU with no result; see `EFFECTS_PLAN.md` for the manual boundary review.

## Clip fades (2026-09-07)

Transitions now offers video Fade in/out; Audio offers independent audio Fade
in/out. Drop a tile onto a clip to apply immediately, then resize on the timeline.
The existing one-second suggestion is shortened to the clip/linked-audio length;
Properties remains optional exact control. Timeline handles resize one fade; Escape
cancels the draft, Delete removes only that fade, and Undo restores it. Video
fades can explicitly apply to embedded and linked audio in the same command;
protected targets refuse atomically. Handles are independent, not persistently
linked. No neighboring clips move.

The saved source-anchored ramps drive both preview opacity/gain and native
export. Split, source trim and clipboard fragments retain their envelope phase
instead of restarting a fade at each cut. Effect-bearing files use manifest
1.1, refused by legacy readers; no-effect 1.0 files remain readable. Real FFmpeg
output tests check exported pixel brightness and decoded PCM amplitude across
a mid-ramp trim. Mounted tests check apply, save, drag/cancel, removal and Undo.
The isolated acceptance server and its separate Desktop profile were refreshed.
Its saved seven-clip project reopens; native accessibility
shows the real fade library and clip inspector, with Saved and no Undo entry
after browsing. Full live visual/playback acceptance remains pending: the
renderer reports hidden and the UI driver returns stale screenshots/lagging
actions. No fade was applied to the user's project during this check.
Crossfade/Swipe were added in the subsequent checkpoint above; speed and
independent-track audio crossfade remain unimplemented.

## Selected-range playback (2026-09-07)

Separated IN/OUT wings now bound preview transport: Play starts at IN and stops
at OUT without looping. The stopped preview retains the last frame inside the
selection. Scrubbing and playhead dragging stay inside the selected interval.
The handle remains visible; a tap (or Enter/Space on its focused control)
reunites the wings at the playhead and restores whole-timeline playback. A drag
does not clear the range, and Escape restores its starting playhead position.
Changing the range pauses transport. Timeline and transport share one transient
range; these interactions do not write the document or create history entries.
The misleading preview “safe / caution” legend is removed.

Mounted tests cover bounds, replay, the OUT frame, tap-versus-drag, cancellation,
native decoder alignment on replay, and unchanged document/history. Real-media
Electron playback acceptance of these changes remains open; the user's active
editor has not been reloaded during this coding pass.

## Category toolbox shell (2026-09-07)

Edit now has a labelled Media / Transitions / Audio / Text / Effects rail and
one replaceable library beside the central preview. Properties remains the
selected clip's inspector on the right; the timeline continues below the full
workspace. Category selection is transient presentation state, not EDL state,
clip selection, a command, or a history entry. No project migration is required.

Media retains import, reusable bin drag/drop, placement and first-source-rate
settings. Text offers real Title, Caption and Callout insertion through the
existing validated commands. Successful insertion opens Properties and focuses
the editable text, including on narrow screens where it replaces the library
drawer. Merely browsing preserves the selected clip and uncommitted numeric
inspector drafts. Closed panels are inert. Full width and Edit/Generate round
trips retain the current category and inspector.

The original shell shipped unavailable effect entries. Clip-edge video/audio
fades and source-handle Crossfade/Swipe now have real controls as described
above; speed remains unavailable. Retiming remains separate work. No new
generation or host grants are introduced by this shell.

Mounted regression tests cover all categories without document writes or Undo
entries, inspector/draft identity, real text insertion/edit/save, panel/workspace
round trips and mutually exclusive narrow drawers with text focus. These tests
are not rendered or live Electron acceptance: browser policy blocked the local
layout-check page, so visual QA in both themes remains open.

Live follow-up: refreshed the isolated Video clone and reopened its saved
seven-clip project in Electron. Dark-theme screenshots verified the new
Transitions and Text libraries beside a working media preview, with the same
selected caption and inspector retained and no Undo entry. Editor Full width
hid both internal panels and restored the category and caption settings.
**Remaining defect:** if the host is already full-width before entering the
editor's Full width, leaving editor Full width restores the outer Workspace and
Genie panels instead of preserving the pre-existing host full-width state.
Light-theme and narrow-window visual acceptance remain unverified. No clips or
document content were edited in this follow-up.

## Universal lanes and continuous cuts (2026-09-07)

Tracks are universal compositing lanes. Clip kind, not the track's legacy role
label, determines video/audio/image/text behavior. Existing serialized track
kind fields remain compatibility hints, not placement restrictions. **+ Track**
adds a named lane without asking for a type. Existing track names are preserved.
Mixed clip types may share a lane; overlaps are still refused rather than
overwritten. Group moves preserve relative lane/time offsets and use one save
and one human Undo step. Clip starts and ends can both dock to neighbor edges.

Hidden tracks retain their headers for recovery and dim the complete scrollable
lane and its clips, with a crossed-out eye. They are excluded from preview
(including their sound), range clipboard actions, and clip mutations. Showing a
track restores its prior mute/lock state. Linked edits that would mutate a hidden
peer refuse atomically with a readable explanation for move/trim/split and
explicit linked effects. Cut/copy/delete instead exclude hidden peers as
described above; link metadata is reconciled without cutting hidden footage.

Adjacent source-continuous slices reuse the native decoder. An adjoining new
source is prepared silently before its cut; delayed decoding holds the outgoing
frame while the shared clock waits. Real gaps clear the picture. Mounted tests
cover decoder reuse, delayed handoff, one-frame gaps, hide/show recovery, and
cross-lane group drag/save/Undo. This does not substitute for live playback QA.

## Essential clipboard checkpoint (2026-09-06)

The visible timeline **Edit** menu and Cmd/Ctrl C/X/V/Delete share pure
`copyTimelineSelection`, `removeTimelineSelection` and `pasteTimelineClipboard`
commands. A nonempty IN/OUT range takes precedence over the linked clip selection.
Cut/Delete leave gaps; Paste uses the playhead and original tracks, preserving
relative offsets, source windows, media identities and internal links with fresh
clip IDs. Protected linked edits, occupied destinations, deleted/locked lanes,
changed source bindings and changed frame rates refuse atomically with visible
recovery. A refused Cut retains the previous clipboard. Human Undo/Redo and
optimistic autosave remain the existing paths; Copy is not a document edit.

The clipboard is transient to this open project/session, contains metadata rather
than media bytes, and does not read/write the OS clipboard. Text controls keep
native shortcuts. There is no new Genie clipboard tool or authority: agents retain
their existing document mutation tools, not access to the human clipboard. The
shared command kernel is reusable, but exact clipboard-tool parity is not claimed.
Existing format validation bounds apply; no new clipboard limit or store was added.
Pure and mounted tests cover range/clip selection, linked fragments, rational
frame roundoff, refusal, keyboard/menu parity, Undo/Redo and save/reopen. Actual
Electron shortcut/live media acceptance remains task 1.9.4 until separately run.

## Timeline interaction checkpoint (2026-09-06)

The approved compact timeline spans the workspace below the preview and side
panels. Track names are labels until double-click/F2 or **Rename track**; Escape
discards a rename. Aligned lock/mute/visibility buttons and a keyboard-accessible
actions menu replace overflowing text controls. The header divider resizes the
whole column. Timeline zoom has a continuous slider and viewport-derived Fit;
ruler labels adapt without changing the rational frame grid or snap semantics.

Right-click or Shift+F10 on a video exposes **Separate audio**. The existing
atomic command creates an audio track immediately above the video when needed,
preserves source/timeline windows and links, and mutes embedded video audio.
Explicit tool destinations still honor overlap and lock checks. Already-separated
clips refuse duplicate extraction. The operation remains on the human command /
Undo spine, and agent authorship/approval contracts remain unchanged.

First differing video import opens a modal offering **Change project to N fps**,
**Keep N fps**, and **Cancel import**. Remember stores a match/keep policy in the
existing viewer/app-scoped device preferences, never in the EDL. **Import
settings → Ask me** resets it. Later imports cannot silently change an established
project rate, including after concurrent edits while the first import waits.

Visible video clips use real source thumbnails. Visible audio clips share source
decoding and display measured, per-sequence-frame peak envelopes; no synthetic
waveforms are substituted. Decoding is serialized, PCM is discarded after peak
extraction, and off-screen clip leases are released. Canvas allocation follows the
visible viewport rather than the full zoomed clip. Web Audio requires a complete
encoded source to decode, so this is not a streaming waveform decoder. Decode
failure is shown without mutating the edit or blocking its commands.

Live acceptance uncovered a pre-existing Workspace playback boundary failure:
parent-origin blob URLs were unusable in an opaque sandbox. The host now
structured-clones the already-verified immutable Blob; the iframe creates and
revokes its own local URL. Video CSP admits only blob and the owner-bound Desktop
media scheme for media reads, not arbitrary HTTP(S) or filesystem access.
The iframe remains sandboxed with **allow-scripts only**. Source provenance,
room authorization, MIME/byte verification and host revocation are retained.

Evidence: mounted editor/menu tests, command and history regressions, bridge and
CSP tests, Video/Workbench typechecks and Workbench production build. A populated,
isolated Desktop clone demonstrated persisted media import, above-video audio
separation, actual waveform rendering, source preview and playback, and panel
reclamation. This does not qualify paid generation, every codec/large-source
envelope, or a production release.

## Workspace publication checkpoint (2026-09-05)

Export has an explicit, initially unchecked **Also save to Workspace** option.
For a bound Workspace project, Desktop first saves the local MP4 selected in
the native dialog, then streams an independent private copy through the normal
Workspace multipart artifact-admission route. The iframe chooses no room,
endpoint, path or credential. Desktop constructs a unique `exports/` path;
Workbench supplies only the bound room and canonically verified source bindings.
Neither renderer nor IPC buffers the exported movie.

The local exclusive-link commit remains successful even when Workspace upload
is rejected, cancelled, or loses its response. The editor displays publishing
progress and distinguishes a verified artifact receipt, explicit non-publication,
and unknown confirmation with the exact path to check before retrying. No upload
is retried automatically. A retained local copy is deliberate recovery, not
Workspace-only export or local-working project promotion. The option is shown
only after the host advertises support for the currently bound Workspace target;
Current Folder and older Desktop keep ordinary local export without that option.
Forged Current Folder requests for publication refuse before native export begins;
missing publication confirmation remains explicitly unconfirmed. The existing
server upload policy still applies and is not qualified by this
consumer change. Source-version pinning, mixed-location promotion, range export,
disk-space/copy progress and full live Desktop qualification remain open.

Evidence: native `sequence-workspace-publication.test.ts` (real HTTP multipart,
exact streamed bytes, authority/cancellation, rejected/uncertain receipt and local
copy preservation), native render/source tests, mounted Workbench and Video tests,
and serialized iframe/host receipt validators. This is automated evidence, not a
live server/Desktop acceptance claim.

The accompanying recovery audit found that Workspace app-tool anchored writes use
`checkpoint:false` with transient authored patch events; snapshot fallback uses a
human-save path. Current Folder already has canonical authored journal payloads,
but its bridge does not project them. Durable recovery must reuse those canonical
histories and preserve anchored disjoint-rebase behavior; replacing the Workspace
patch writer with a snapshot-only coordinator would regress that behavior. No
authorship/history code was changed in this publication checkpoint.

## Authored recovery checkpoint (2026-09-05)

The historical matrix below predates the current editor recovery implementation.
Video now uses the shared three-way project merge for human-local Undo/Redo,
dirty-draft recovery and explicit Genie Revert. A host-verified `patch_applied`
event supplies the exact predecessor and postimage; receipts require matching
saved SHA/revision, an agent/app-tool author and a valid envelope. Approval does
not convert Genie authorship into a human history entry. Generic reloads and
missing predecessors never manufacture authorship.

The visible **Latest Genie edit** card counts changed clips, tracks and media,
discloses direction/candidate/title changes, and exposes Revert, Dismiss and a
device-local, viewer/app-scoped notice preference. This is the latest observed
event in the current session, **not** complete or durable activity history.
Replacing the card or reopening the app does not retain earlier inverses.
Document-settings changes are inspect-only; ordinary save timestamps are ignored.

Revert applies only the validated inverse delta to the current draft. Disjoint
human work survives; overlap, later track protection, invalid timing and media
dependencies refuse atomically. An inverse may undo its own exact lock/content
transaction. Revert does not enter or consume human Undo, and local application
is labelled unsaved until normal compare-and-swap autosave succeeds. A duplicate
click cannot apply twice. Synchronous contiguous patches and guarded full reads
prevent stale reads, renames, duplicates and old load failures from rolling back
newer content.

Evidence: `src/agent-receipt.test.ts`, mounted `src/editor-interaction.test.tsx`,
`src/project-history.test.ts`, `src/autosave.test.ts`, and Workbench preference/
bridge/client tests. Current Folder writes and Workspace snapshot fallbacks that
do not emit equivalent trusted authored patch events are **not qualified** for
receipt/Revert parity. Durable receipt aggregation, full live actor acceptance,
keyboard/visual notice qualification and long-session memory remain open. The
renderer retains only its latest receipt snapshots; it does not add a new
durable log or job store. Earlier-receipt recovery is a named deferral, not a
qualified retention policy. The repository
limits scan again produced no verdict before being stopped; no clean result is
claimed.

## Historical characterization

Characterization recorded against `b040103e112a789aa9f31fe213e139e18c45bff2` (2026-08-11). The following rows describe that historical head, not current completion or limit authority.

## Durable EDL mutations and current actor disposition

All durable edits are a read → parse → pure command → serialize → optimistic write of the whole `.video.html` container. The underlying commands return a new `VideoProject`; neither the UI nor an advertised agent tool persists an operation log.

| EDL command | Human UI | Advertised agent tool | Disposition / evidence |
| --- | --- | --- | --- |
| `addClip` | Partial: only synthetic Title, Caption, and Callout buttons; no media import or generic clip form | `add-clip`; `add-overlay` is a constrained wrapper | Shared command, but different affordances. The agent may construct video/audio/image/text/caption/callout clips and may supply any non-empty `mediaId`; the command does not prove that reference exists. The human cannot import media. `src/app.tsx`, `src/agent-tool-handlers.ts`, `app.json`. |
| `moveClip` | Timeline drag and inspector start/track controls | `move-clip` | Shared. |
| `trimClip` | Timeline trim handles and inspector duration control | `trim-clip` | Shared. |
| `splitClip` | Selected-clip command at the playhead | `split-clip` | Shared. |
| `deleteClip` | Selected-clip command and Delete/Backspace | `delete-clip` | Shared. Deletion follows linked IDs by default. |
| `detachAudio` | Selected video clip inspector command | `detach-audio` | Shared, subject to a media-backed video and an available audio/music track. |
| `updateClipProps` | Partial: selected text/caption/callout inspector text editing only | Not advertised; `replace-caption-text` calls it only for caption `props.text` | Shared kernel but not shared general affordance. Human can only edit the text field exposed by the inspector; agent can only replace caption text, not arbitrary props. |
| `linkClips` | No UI control | No advertised tool; exported handler returns `not_implemented` | Pure EDL command exists and its unit tests pass, but it is not a usable human or agent transaction. **Gap.** |
| `unlinkClips` | No UI control | No advertised tool; exported handler returns `not_implemented` | Same status as `linkClips`. **Gap.** |

`create-file` and `inspect-timeline` are durable-document creation and read affordances, not EDL commands. `renderPreview` and `exportVideo` remain exported compatibility handlers that return `not_implemented`; neither appears in the manifest. Real-media preview, import, playback, and export are deliberately absent from the current envelope.

## Authored-write trace

For a workspace artifact, an agent tool's `mutateAndPersist` captures the read envelope's `baseSha256` and `baseRevision` and passes both to `document.write`. The focused characterization test proves the handler forwards `{ baseSha256: "abc123", baseRevision: 1 }` and leaves the stored document unchanged when the host returns a conflict.

1. The Video agent handler reads/parses, invokes the pure command, serializes, then calls `document.write(target, {content}, {baseSha256, baseRevision})` (`src/agent-tool-handlers.ts`).
2. `createAppToolHost` receives that write. For workspace artifacts it derives an anchored text patch from the remembered base, calls `applyWorkspaceArtifactTextPatch`, and labels the durable event author `{ kind: "app_tool", displayName: appId }`; for this app that display name is `nautilo-video` (`packages/server/src/apps/app-tool-host.ts:598-725`). It is an app identity, not an individual-agent identity.
3. The Workbench session applies the external patch and produces `patch_applied` with exact `patchId`, `revision`, `sha256`, `previousRevision`, `previousSha256`, `patch`, optional `author`, optional `rebased`, and an envelope whose base revision/hash equal the new revision/hash (`apps/workbench/src/apps/app-bridge.ts:96-125, 711-762`).
4. `MiniAppSurface` posts that host event to the iframe as `nautilo.app.document.changed`. The Video bridge's local TypeScript shape retains only event type, path, revision/hash pairs, and the envelope; it does not declare `patchId`, `patch`, `author`, or `rebased` (`src/bridge.ts:35-49`). The runtime event may carry extra properties, but the Video app neither types nor uses them.
5. The Video app handles every non-delete/non-rename change identically: it re-reads the full host document. If its autosave is clean it replaces the document; if dirty it preserves the local full-document draft and enters conflict (`src/app.tsx:262-273`). There is no patch-level merge, operation-level rebase, or actor-specific presentation.

Therefore “agent write through `patch_applied`” exists at the platform boundary, but Video's reuse is only partial: it shares the text-patch transport and revision facts, then degrades that event to a full-document reload/conflict choice. The missing typed provenance and semantic operation transport are Phase 2 work, not repaired here.

## Race matrix: observed current behavior

| Scenario | Fixture | Observed behavior | Preservation / recovery |
| --- | --- | --- | --- |
| Clean editor receives a remote write | `VideoAutosave.applyRemoteEnvelope` with no dirty draft | The returned remote content becomes saved/draft content; state is `idle`, and its SHA/revision become the remote base. | No local draft exists to lose. |
| Dirty editor and remote write affect disjoint conceptual clips | Local serialized draft and distinct remote serialized content | The app does not inspect semantic disjointness. It returns the local draft, records remote content as `conflictLatestContent`, and state is `conflict`. | Local draft is preserved in memory; the only offered recovery is reload latest, which discards it. |
| Dirty editor and remote write affect the same clip/property | Two incompatible serialized caption values | The result is exactly the same `conflict` state as a disjoint write. | Reload latest replaces/discards the local draft. No merge, keep-both, diff, or per-command replay exists. |
| Agent read races an authoritative human write | Agent handler reads base `abc123`/revision `1`; host returns `conflict` | Handler returns `{ok:true,status:"conflict",currentSha256}` and does not overwrite host content. | Caller receives the current hash only. It does not receive latest content or an automatic retry. |

The fixture suite covers the first three cases in `src/autosave.test.ts` and the agent compare-and-swap case in `src/agent-tool-handlers.test.ts`. These are characterization fixtures: a conflict is safe against silent overwrite, but it is not a usable co-creative merge solution.

## Bounds and first-N presentation inventory

| Path | Total / shown / omitted truth | Classification and recovery |
| --- | --- | --- |
| Video HTML parse/serialize: `MAX_DOCUMENT_BYTES = 200 * 1024` | A document at 200 KiB is the app's intended ceiling; the characterization test proves one byte above it is rejected. | **Soft app-local implementation limit, and a product defect for a video container.** It is not a platform authority: the Workbench bridge, server app tool runner, and Writer/container path use 50 MiB limits. Historical implementation copied the value from the now-retired prototype spreadsheet app rather than deriving it from Video requirements. Error text says “app bridge limit,” which is inaccurate. No actionable size/recovery UI exists. |
| EDL media rail: `project.media.slice(0, 40)` | Exact total is in the top bar as `N asset(s)`; at most 40 rows are shown; `max(0, total - 40)` rows are silently omitted. Persisted validation allows up to 200 media assets. | **Defective presentation.** No “40 of N,” omitted count, pagination/search, or recovery is shown. Import is disabled; the agent's `inspect-timeline` reports the media count but not the omitted asset records. |
| Sequence choice: `project.sequences[0]` in UI, summary, preview, and agent inspection | Validator requires one or more sequences but has no maximum; all these surfaces select only the first sequence. Context summary reports total sequence count but offers no selection. | **Defective first-one presentation.** Additional persisted sequences remain in the document but have no Video UI or advertised-tool recovery route. |
| Track summary: `listOrderedTracks(...).slice(0, maxTracks)` | `buildDocumentSummary` defaults to 32 shown tracks. Persisted EDL validation rejects a sequence with more than `MAX_TRACKS = 32`, so valid serialized sequences have total = shown and omitted = 0. | **Authoritative app-format invariant for valid parsed documents.** No current user-visible omission, though callers passing an unvalidated in-memory project could receive a capped summary. |
| Per-track clip cap | Parser and `addClip` enforce 500 clips per track; other presentation code does not slice clips. | **Authoritative app-format invariant.** Rejection names the cap; no design for split/recovery beyond editing the project smaller. |
| Media asset cap | Parser enforces 200 media assets. No current Video UI or advertised tool adds media assets. | **App-format invariant; not a transport authority.** The 40-row rail makes the last 160 valid assets inaccessible in the UI. |
| Context description: `slice(0, 219) + …` | Description is capped at 220 characters. Exact sequence/track/clip/media counts and selected clip ID are separate structured fields, so they are not truncated by this display string. | **Presentation-only soft bound.** Structured counts/selection are recovery data; detailed media and non-first-sequence state are still absent as above. |
| Agent `inspect-timeline(includeClips)` | It returns every clip in the first sequence; there is no first-N clip cap despite the manifest saying “clip samples.” | **Unbounded first-sequence projection.** This is not omission, but it is a separate response-growth risk and does not recover media records or later sequences. |

## Deferred repairs deliberately not made

- No semantic/operation transport, per-command merge, rebase, or conflict resolver.
- No change to the 200 KiB cap, error text, host limits, or media/sequence UI.
- No agent tool exposure for link/unlink, import, real-media preview, or export.
- No authentication or credential changes, and no real-media behavior.

Those are explicit follow-on decisions; this task records the current behavior so later work cannot claim shared co-creative editing where only whole-document optimistic conflict exists.
