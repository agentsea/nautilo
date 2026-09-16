# Mobile message time and workspace sharing

Maintainer-approved scope: port the behavior introduced by PR #1228 to
Mobile, following the reviewed three-screen timestamp/share/recipient mockup.
This is client parity, not a new sharing or authorization system.

## Journey and contract

- Show an unobtrusive local time for messages with authoritative server time.
  Tap for exact date and timezone. Group dated messages by local calendar day;
  never invent a sent time for streaming, optimistic, or undated legacy rows.
- File actions → Add to workspace → select people → Add. Use the existing
  workspace share API and the file's origin Room context. It shares the same
  artifact, sends no DM, and does not transfer ownership.
- Files → Shared with me → open using the returned artifact internal ID and
  authorized Room ID. Preserve the separate Computer files source.
- The server enforces artifact write and recipient access. No client-side
  namespace attachment or new permission tier. Hide sharing for read-only files.

## Recovery and accessibility

Search has explicit loading/error/empty/retry states. Preserve selected people
across searches. Capture the server, user, file and Room scope for each sharing
session; stop queued work after scope change/unmount. Failed deliveries can be
retried individually as a batch without replaying successful deliveries; the
server's idempotency handles response loss. Display partial success truthfully.
Use native accessible controls, keyboard avoidance, safe-area padding, scalable
text and scrollable sheets. No motion is needed to communicate state.

## Proof and exclusions

Test history/live timestamps, missing dates, optimistic/stream reconciliation,
day boundaries, exact-time disclosure, stale-scope fencing, double-submit,
partial success and retry. Test recipient search/list states and correct
authorized file opening. Run Mobile's isolated unit suite, TypeScript and lint;
separately verify both native clients. Rollback is the client-only UI patch;
existing server shares remain valid and visible on Desktop.

Encryption recovery belongs to separate maintainer work. Relay qualification
and the Android talk-button reproduction are separate acceptance tracks; a
green unit suite is not proof of live pairing or native visual behavior.

## Qualification checkpoint — 2026-09-07

The entries in this section are chronological checkpoints, not the current
release verdict. See the latest checkpoint at the end for remaining gates.

Implemented in the feature worktree; not merged or released.

- Mobile isolated unit runner: 222 files passed. Mounted React sharing tests
  additionally prove partial receipts, retrying failures without resending
  successes, shared-list recovery and internal-ID/Room-preserving navigation.
- iPhone native: day/time display and exact-time sheet verified; Files tabs and
  empty shared list verified; existing synthetic visibility fixture shared to
  the clone's delegated test account, with a confirmed `1 of 1 shared` receipt.
- Live iPhone qualification caught a mutable-coordinator render-state defect.
  The sheet now publishes immutable React snapshots; receipt retest passed.
- Android native: timestamp and exact-time sheet verified. Before Files
  acceptance completed, the client returned to sign-in. Cause not established;
  sign-in and the remaining sharing checks are still required.
- Recipient-side native opening is not yet proven with the recipient identity.
- Desktop relay tests pass in the canonical Desktop package working directory:
  27 tests across IPC, lifecycle, session and child-process relay coverage.
  Live Mobile-to-Desktop pairing with the new relay remains unqualified.
- TypeScript still reports three errors in unchanged user-agreement and
  protected-content schema files. Do not describe this as an all-green build.
- Android talk-button blinking remains a separate unqualified reproduction;
  this parity change does not claim to fix it or encryption recovery.

The maintainer subsequently selected 0.1.2 and authorized tester-only
distribution. The branch was synchronized with main through #1237, including
the maintainer's separate Mobile lifecycle-load fixes. The user-agreement type
error was resolved upstream. Mobile's no-emit TypeScript configuration now
allows explicit TypeScript imports, matching the other client applications;
this resolves the two shared API schema import diagnostics without changing
the schemas or weakening runtime checks.

### Continued native qualification

- Paired lab preflight re-passed on the same source checkout and named clone.
- iPhone keyboard-open empty search exposed a collapsed recipient-results
  viewport. The list now retains a visible minimum row height. The checked-in
  `apps/mobile/.maestro/workspace-share-empty-search.yaml` flow passes search,
  visible empty state, reachable Cancel and return to the file viewer without
  hiding the keyboard first. No file mutation is performed by this flow.
- Post-fix focused tests: 11 passed; Mobile lint passed; full isolated Mobile
  runner passed all 222 test files again. Desktop relay tests: 27 passed again.
- Android remains at sign-in; no Android sharing or talk-toggle pass claimed.
- A separate source-built Desktop was prepared against the existing clone for
  protocol/UI pairing checks, not production macOS-permission qualification.
  It reached the clone's Logto sign-in. Fill-only credential delivery refused
  the native secure-field check; no credential fallback or account reset was
  attempted. Human sign-in is required to continue. Other Desktop sessions and
  the installed product remain untouched.

### Latest checkpoint — native keyboard qualification

- Android authenticated navigation, Files and the writable synthetic Markdown
  fixture passed. A menu test was intercepted by Expo's floating developer
  button; moving that test-only overlay away exposed the correct file actions.
  Earlier sign-in returns remain unexplained; no session-loss fix is claimed.
- The real Android keyboard at 320 × 640 logical pixels exposed a partly
  obscured Cancel action. Sharing now has one bounded, shrinking scroll body
  and a separate non-shrinking action row, without two nested sheet paddings.
  Top safe-area space is retained. Native retesting proved recipient selection,
  scrolling to the final recipient/disclosure, an unobscured Add/Cancel row,
  `1 of 1 shared` to `agent_tester`, and empty-search recovery with Cancel.
  The emulator's original 1080 × 2424 / 420 dpi display was restored afterward.
- iPhone 17 Pro: real software keyboard enabled; the revised body scrolls to
  the disclosure, actions remain reachable, and the checked-in empty-search
  flow passes. A dedicated iPhone SE simulator is being prepared for the
  remaining compact-iPhone check. The signed-in Pro device is preserved.
- Regression coverage now guards the shrinking scroll body, separate footer,
  bounded parent and safe-area integration. Mobile TypeScript and lint pass;
  the full isolated Mobile unit runner passes all 223 test files.
- PR #1240 was fully green at `a8a263f03`; the subsequent compact-keyboard fix
  requires its own exact-head CI pass before merge. No 0.1.2 tester binary has
  been built or uploaded. Compact-iPhone acceptance remains a pre-build gate.
- Live-instance pairing is deliberately deferred until tester builds, as
  requested. Native recipient-identity opening and the Android Talk blink
  remain separate unqualified acceptance rows. No production rollout is
  authorized by this tester release.

### Pre-build native gate passed — 2026-09-07

- Dedicated iPhone SE, 375 × 667 logical pixels: signed into the same populated
  clone. With the real software keyboard open, the bounded body scrolls to the
  complete sharing disclosure while Cancel/Add stay outside the scroll area.
  Empty search, visible recovery copy, Cancel, and return to the file viewer
  pass. Keyboard-closed and keyboard-open captures were visually inspected.
- Together with the compact Android 320 × 640 pass and the larger iPhone Pro
  pass above, the changed sharing surface has cleared its native keyboard gate.
  No production credentials were entered by the harness or copied between
  simulators. The previously signed-in Pro device remains preserved.
- Synchronized with main through #1241 (`703c77c91`) without conflicts. On this
  synchronized source, Mobile TypeScript/lint and all 223 isolated test files
  pass; the shared API admission cancellation/retry-metadata suite passes all
  seven tests. The synchronization refreshed the development client, so the
  final compact-iPhone flow was repeated afterward and passed.
- Remaining release work: exact-head CI, merge, clean-source EAS builds,
  tester-track/group submissions and availability proof. This is not a public
  release approval or a claim that live pairing/the Android Talk blink passed.

### Build candidate frozen — 2026-09-07

- The final compact-iPhone proof was repeated using native Cua control because
  Maestro startup changes the simulator's hardware-keyboard setting. The
  keyboard-open scroll and empty-result captures were inspected independently;
  Cancel returned to the unchanged fixture. Earlier keyboard-closed automation
  captures are not used as keyboard-open proof. Evidence is retained locally
  under `nautilo-mobile-release-evidence/0.1.2/` beside the project worktrees.
- All nine remote checks passed at `b14fc18e4412d8ffa55127a4cc00f6eed357e850`.
  PR #1240 merged normally as `29828af2b85f8bb2a48368cec231b52bf3c1308d`.
- Both production-profile STORE builds were requested from that clean merged
  commit. EAS allocated Android 0.1.2 (37) and iOS 0.1.2 (31); immutable build
  IDs are recorded in `apps/mobile/releases/ledger.json`. Tester upload and
  availability remain unconfirmed until their separate verification step.

### Tester availability verification — 2026-09-07

- Both EAS STORE/production builds finished at the exact merged candidate SHA.
- iOS build 31 uploaded successfully, but EAS initially left it
  `READY_FOR_BETA_TESTING`. One same-build/group retry failed. No further
  duplicate upload was attempted: the existing valid ASC build was attached
  to the existing Nautilo RC group through Apple's official relationship API.
  Assignment returned HTTP 204; group read-back includes the exact build and
  two existing internal testers. Independent EAS status is now `VALID` and
  `IN_BETA_TESTING`. The successful original submission ID is retained in the
  ledger; the failed retry is operational evidence, not another signed build.
- Android version code 37 submission finished with `track=internal` and
  `releaseStatus=COMPLETED`. Existing testers use their enrolled Play account
  and previously accepted opt-in; individual Google account membership/opt-in
  was not re-audited through the portal in this pass. Public store rollout and
  physical-device/live-pairing acceptance remain separate from this release.
- The fail-closed `verify_tester_release.py` passed both platforms against
  `29828af2b85f8bb2a48368cec231b52bf3c1308d`: Android internal/completed and iOS
  valid/in-beta-testing. The ledger contains the verified build/submission IDs.
