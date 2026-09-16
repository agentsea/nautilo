# Video effects: next complete editing workflows

Status: behavior approved, 2026-09-07. Preserve neighboring clip positions;
Make room is an explicit later operation, never automatic ripple. Video/audio
clip fades, crossfade and directional swipe are implemented and automated
preview/export checks pass; full live acceptance is pending. Clip speed remains
the next delivery.

## Current evidence

- `src/FadeControls.tsx` supplies reachable video/audio fade libraries, a
  contextual inspector and timeline duration handles. `src/TransitionControls.tsx`
  adds crossfade/swipe tiles, a cut inspector and removable, resizable cut badges.
  Independent-track audio crossfade and Clip speed remain unavailable.
- `src/edl.ts` persists universal lanes and typed clips. There is no typed
  playback-rate contract. The incoming video clip owns a validated cut transition
  referencing its adjacent outgoing clip; source windows are derived, not saved twice.
- `src/sequence-evaluation.ts` evaluates source-anchored linear opacity/gain
  envelopes at 1x. Opposing envelopes multiply, including across source trims.
  Cut transitions evaluate two simultaneous sources and blend embedded audio.
- `src/render-plan.ts` refuses unknown effect properties. It lowers the same
  sequence model for both Current Folder and Workspace export.
- `apps/desktop/electron/sequence-renderer.ts` validates exact render-layer
  fields and applies the same source-anchored alpha/audio fades and geometric
  swipe. Video trims before expensive pixel effects while retaining source PTS.
- `src/commands.ts` already owns atomic clip edits, collision refusal,
  protection and linked-clip behavior. Effects must extend that spine.

## Experience preflight

The approved browsing/inspection layout now reaches a real fade editor.
The remaining acceptance outcome is live apply/adjust/reopen/export, not just
a working category shell.

The original category shell was a dead end. The first implementation still
required Properties and Apply after dropping. User correction, 2026-09-07:
drop must apply immediately. Implemented happy path: choose a category, drag a
choice onto a clip/cut, then optionally resize its timeline handle. No typing,
confirmation, paths, accounts, provider setup or Genie conversation is required.
The right inspector is optional fine-tuning, not a required step.
Keyboard alternative: select a clip or cut, choose the effect, press Apply.
Never apply an effect merely by browsing its category.

Product preflight verdict: SALVAGEABLE friction corrected. For an editor adding
an effect, the old path imposed a drag, duration field and Apply before value;
the new path is one drag/drop, no fields or confirmations. Existing one-second
inspector suggestions are reused as soft defaults, shortened to the actual
clip/linked-audio length or measured cut handles. Timeline handles remain
unrestricted up to those physical bounds. Re-dropping an existing effect
selects it without overwriting custom settings. Dropping another transition
type preserves its duration/direction. Each successful drop uses the existing
command, save and single-step Undo; protected/incompatible targets and missing
handles refuse without partial writes. Interrupted drags do not change state.
No new Genie judgment, tool contract, persistence or authority is required.
Now: immediate fades/cut transitions. Later: clip speed. No unresolved product
choice is needed for this correction.

Keep one library on the left and one contextual inspector on the right. Do not
add a second effects screen, a node graph, or a generic effects-stack editor.

## Proposed interaction contract

### Clip-edge video and audio fades — first delivery

- Fade in/out attaches to the chosen clip edge without moving or trimming it.
  Video fades alter opacity (revealing lower layers, or black if none); audio
  fades alter gain. Label these separately so users know what will change.
- Draw a small editable envelope/handle inside that clip, not another track.
  Dragging changes duration. The inspector supplies exact duration and Remove.
- Delete while the effect is selected removes only the effect. Undo restores
  it in one step. Escape cancels an uncommitted drag or numeric draft.
- Offer linked-audio application explicitly (default on for video fades),
  applying to embedded and linked audio together. A protected linked target
  refuses the entire operation. This checkbox is a one-time application,
  not persistent effect linking: each timeline handle edits just its own fade.
- Bound duration by the actual clip length. Keep existing ramps anchored to
  source time through trims rather than shortening or restarting them. An
  inspector update explicitly reanchors a ramp to the current edge. The initial duration is a
  visible, overridable UX default, not a universal maximum.
- Deleting the clip deletes its owned effects in the same undoable command.
  Moving the clip carries them. Splitting retains outer-edge fades on the
  appropriate children and does not invent fades at the new internal cut.
  Splitting inside an active fade must preserve its evaluated envelope.

### Crossfade and directional swipe — second delivery

- Drop onto the cut between two adjacent visual clips on the same universal
  lane. No gap means a cut; do not interpret a gap as an implicit transition.
- Keep the cut position and project length unchanged by default. Borrow source
  handles outside the visible trims. Preview the required handles and maximum
  feasible duration before committing; do not freeze, loop, or shorten footage
  silently when handles are unavailable.
- Offer a shorter transition or an explicit trim/overlap operation when there
  is insufficient footage. Keep the original edit intact on refusal.
- Center a transition badge on its cut; dragging its ends changes duration.
  The inspector edits type, duration and swipe direction. Embedded sound blends
  with the transition; previously detached audio tracks remain unchanged and the
  inspector says so. Independent-track audio crossfade is deferred.
  Removing the badge restores a clean cut without moving either clip.
- Use actual simultaneous outgoing/incoming frame evaluation. Crossfade must
  not mean fading both clips through black. Swipe is one restrained directional
  reveal, not an expanding catalog of decorative variants.
- A later move/trim/split/delete that invalidates the cut refuses atomically
  with a remove-transition-first recovery. Moving both clips together preserves
  it. Whole-pair copy/paste remaps references; partial-pair copying refuses.
  Separating audio while an adjoining transition exists also refuses, avoiding
  silently replacing the embedded audio blend with a clean audio cut.

### Clip speed — third delivery

- Select a video/audio clip; Effects > Clip speed opens its settings on the
  right. Show multiplier and resulting duration. Project FPS stays unchanged.
- Preserve the source window and timeline start; duration changes with speed.
  Retiming linked audio/video is one atomic edit, with pitch preservation on
  by default when the complete preview/export path supports it.
- Approved default: leave other clips in place. Faster playback leaves a gap;
  slower playback refuses a collision and offers an explicit Make room action.
  Make room must preview exactly which later clips move and obey protection.
- Do not advertise speed values beyond the verified preview/export intersection.
  Derive constraints from runtime support, not a guessed UI ceiling. Presets
  are conveniences, not hard limits. Reverse and speed ramps are later work.

## Architectural preflight

**Ready:** timing preservation is approved. The first fade vertical requires
no movement of neighbors; crossfade and speed must preserve this invariant.

Canonical fact: effect definitions in the saved Video document, written by
validated app commands. Derived state: evaluated frames/gain and export plan.
Transient state: browsed category, effect selection, drag and inspector drafts.
Existing host-owned media authority remains unchanged; no filesystem grants,
new services, database tables or model calls are required.

One mutation path must serve human editing and any subsequently exposed Genie
commands. Deterministic code measures source handles, validates timing and
protection, applies edits and evaluates envelopes. Genie judgment may choose
effects and timing, but must not calculate or bypass those invariants.

Extend document validation, editing operations, shared evaluation, render-plan
lowering and native rendering together. Handle older documents as no-effects
without rewriting them on read. An older consumer must refuse unsupported
effect semantics instead of dropping them on save or exporting a plain cut.
Fade-bearing HTML uses manifest 1.1 and cut transitions require manifest 1.2 so
older consumers refuse unsupported semantics; no-effect legacy documents remain
compatible with manifest 1.0.

Architecture verdict: ready for bounded live acceptance, not release-qualified.
The shared document/command/evaluation/render spine now implements the cut
vertical without new services or grants. Source durations must be measured;
missing handles refuse rather than freeze frames, loop footage or move neighbors.
Duration is a derived physical bound; the initial one-second choice is an
editable soft default, not a ceiling. The three-pixel drag threshold distinguishes
intent and does not constrain media. Existing document-size limits are unchanged.

Automated checkpoint: 338 Video tests and 38 focused Desktop render/publication
tests passed. Native FFmpeg output checks verify crossfade midpoint pixels,
all four swipe directions, preserved duration and decoded audio amplitude.
Mounted tests cover inspector apply/save, drag cancellation, adjustment, removal,
Undo and two-decoder preview. These do not substitute for live visual acceptance.

Limit-preflight checkpoint: `bun run limits:check` produced no result after more
than nine minutes at approximately one CPU core and was terminated deliberately.
The deterministic gate is unverified, not green; no baseline was mass-admitted
or rewritten. Manual review above covers this vertical's new duration/default/
drag boundaries, not the repository's pre-existing limit debt.

## Acceptance and recovery

Each delivery is complete only after: apply -> adjust -> preview -> save ->
reopen -> export -> inspect actual output. Package builds alone are not proof.

- Test one frame, long clips, endpoint effects, overlapping envelopes, splits
  through effects, trim/move/delete, copy/paste, undo/redo and linked groups.
- Validate unknown/non-finite values and stale/deleted targets without partial
  document mutation; expose the failed target and a useful recovery action.
- Test universal lanes, mixed media, muted/hidden/locked tracks and real gaps.
- Compare real exported pixels/audio with preview at starts, middles, endpoints
  and clean cuts. Speed tests must verify duration, source bounds and A/V sync.
- Exercise Current Folder and Workspace, missing media, unavailable host,
  cancellation and local export/publication failure through existing recovery.
- Check keyboard-only editing, narrow drawers, both themes, stable numeric
  layout and no accidental document mutations while browsing.
- Refresh only the owned acceptance instance when installing changed bundles;
  verify media attestation and reopen the saved project before handing it back.

Audio cleanup, compression, pitch-shifting as a creative effect, grading and
large transition catalogs are deferred. This document is not production-release
or full effects acceptance evidence.
