# Video 0.2.2 follow-ups

These are explicit, open follow-ups accepted for iteration after 0.2.2 on
2026-09-08. They are not completed work or claims that arbitrary limits are safe.
Required CI, authorization, paid approval and data-integrity checks still gate
merge. Owners: Video maintainers, with the platform owners named below.

- [ ] **VIDEO-F1 — Reconnection and expiring review sessions.** Generated-take
  discovery currently stops automatic retries after three transient failures;
  Refresh, focus, online and reopening recover observation of the same durable
  jobs. Five-minute parent attestations can expire during review. Add renewable,
  identity-fenced read sessions without replaying generation or weakening token
  expiry. Test an outage longer than the present retry window, an expired quote,
  account/document changes, and no duplicate paid submission. Owner: Video and
  Workbench. Evidence: `src/generated-candidates.test.ts`, Workbench
  `src/apps/mini-app-surface.test.tsx`, server attestation-registry tests.
- [ ] **VIDEO-F2 — Shared raster acquisition.** The separate first-party raster
  bridge still refuses images over 10 MiB and reads lasting over 15 seconds.
  These are not limits on the new streaming Video import/preview path. Replace
  the arbitrary raster envelope with measured, cancellable acquisition, retaining
  exact-file validation and whole-result refusal. Current errors preserve the
  document; no partial image is admitted. Owner: Workbench asset bridge.
- [ ] **VIDEO-F3 — Proxy control progress and protocol.** The older proxy
  executor drops diagnostic lines over 1,024 bytes and stops publishing progress
  after sequence 1,000,000,000; process completion remains independent. Its
  control-only protocol rejects frames over 8 KiB or opaque IDs over 256 bytes.
  Derive the envelope from the closed grammar and minted identities; stream
  progress parsing and use the numeric representation boundary. Preserve the
  bans on paths, URLs, bytes and arbitrary argv. Owner: Desktop/Relay. Tests:
  `apps/desktop/tests/unit/media-process.test.ts` and
  `packages/relay/src/media-process-protocol.test.ts`.
- [ ] **VIDEO-F4 — Generation schema envelope.** Reconcile 512-character
  reference paths, 64-byte setting labels, 128-character MIME/failure/token
  fields, 160-character prompt-summary DTOs and 16 recovery actions against
  actual producers. Current schemas reject rather than truncate; a rejected
  response can hide a readable status until refreshed. Full briefs and durable
  jobs remain canonical. Derive closed enums/token lengths where appropriate
  and remove unsupported ceilings. Owner: Agent/API client/Video.
- [ ] **VIDEO-F5 — Provider reference transport.** Keep the clear pre-quote
  Venice 50 MB video warning. Confirm the provider's exact decimal/binary byte
  convention before changing the existing 50 * 1024 * 1024 adapter boundary.
  The current embedded-data delivery also faces a 35 MB JSON envelope after
  base64 expansion; larger legal reference sets need authorized provider URL
  delivery, not silent clipping or automatic modification of originals.
  Owner: media-generation provider adapter. Test exact-byte boundaries, ordered
  references and unchanged paid approval bindings. No paid retries are automatic.
- [ ] **VIDEO-F6 — Long-project and gesture qualification.** Benchmark large
  timelines and variable-height group movement; validate mounted and packaged
  gestures at multiple zooms, playback/export synchronization and interruption.
  Waveform decoding discards raw PCM incrementally but retains 100 numeric peaks
  per source second and transfers that array to the renderer. Memory still grows
  with source duration; streaming import alone does not make this representation
  constant-space. Measure long-source memory and replace it with a viewport-aware
  multiresolution representation, retaining honest gaps/cancellation and no
  arbitrary duration rejection. Owner: Video/Desktop media rendering.
  Workspace uploads deliberately have no arbitrary default per-file cap; the
  operator may set `NAUTILO_ARTIFACT_UPLOAD_MAX_MB`. Admission, streaming
  backpressure and failed-upload cleanup remain enforced. Capacity planning and
  aggregate storage/ingress quotas are operator-policy follow-ups; deployments
  must provision storage or configure their own policy, not assume a quota exists.
  The zoom ceiling is a UI projection, not a project duration or clip-count cap.
  Improve it from measured interaction evidence. Owner: Video.
- [ ] **VIDEO-F7 — Remaining feature breadth.** Clip speed, independent audio
  crossfade, reusable generation templates, comparison tools, transcript
  automation and remote-host rendering remain separate feature work. Do not
  represent these as implemented through generic tool declarations. Owner: Video.

## Rechecked findings that are not project limits

Unique request/take lookups return at most one row because database uniqueness
enforces that identity; project take listing has no first-N slice. Timeline
range/scrubber bounds derive from the actual sequence; trim minimums preserve
one frame or an already shorter source clip. The default one-second transition
is editable. Export's 100% clamp affects displayed progress, not completion or
output. Command/stream timers derive from the owning capability deadline and
must retain unknown-outcome/no-replay semantics.

The removed 200 KiB document ceiling and removed local FFmpeg inspection
timeout/diagnostic-buffer cutoff are not reopened by these follow-ups. The
inventory/decision ledger records exact source fingerprints, not blanket approval.
