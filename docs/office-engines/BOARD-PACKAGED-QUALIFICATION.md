# Board packaged qualification

2026-09-14. This records local candidate qualification; it does not claim
source merge, signed publication or production adoption.

## Candidate

- Source: `259703aa0926d5226e73c29a6d07e1bb0d642f40`.
- Linux arm64 server image:
  `sha256:d0b2f83969ec34eaf50c80fd7db578e33079ced48a99d1b5ac200551795966bd`.
- macOS arm64 Desktop: canonical `package:dev`, Electron 41.10.3, with the
  same source SHA injected. Ad-hoc signature verification passed.
- An isolated populated test environment was restored and used for authenticated
  Human/Genie checks. Its application state and documents were isolated from
  ordinary development and installed Desktop state.

## Packaged closure and app lifecycle

`packaging/wafflebase/verify-board-image.mjs` passes against the immutable image.
It compares the source fingerprint and build recipe with the qualified checkout,
then checks every manifested engine file, dependency notice, declared tool
export, browser bundle, Office group and exact icon/preview bytes. The image's
normal build includes Board without an opt-in flag.

The image's real seeder and state store pass fresh enabled installation,
explicit disable through upgrade/reseed, rollback to the original source hash,
exact app-root backup/restore and retained enabled preference through upgrade.
The upgrade fixture changes the app manifest version; it is not a second
published Board release or a database restore substitute.

The authenticated Apps UI separately disables Board and disables Launch.
The stored preference and fresh server API remain disabled after server restart.
Re-enabling through the UI survives another server restart. The final state is
enabled. Both a Workspace file and a Current Folder file reopen afterward.

The sidebar uses the distinct Board Office icon. Expanded app details load the
2240 x 1400 screenshot of the actual editor, with readable connected notes and
no crop. Its fictional Studio North fixture is reproduced by
`packages/first-party-apps/board/scripts/capture-preview.ts`; that bridge rejects
document writes. Operational acceptance screenshots are not publication assets.

## Human, Genie and preservation checks

- The restored pre-existing Workspace Board opens at revision 8 with exactly
  its prior saved bytes. The configured Genie changes only its title and saves
  revision 9;
  independent model comparison preserves all three existing objects and styles.
- Human Workspace creation, note typing, Save and reopen pass. An active text
  draft survives forced Desktop termination and reopen, then saves at revision 3.
  Authentication and configured Genie state also survive restart.
- Light and dark palette captures preserve identical authored HTML. Canvas
  text, controls and the Office icon are readable in both.
- The configured Genie discovers the packaged tools and creates new blank Boards
  in both
  Workspace and granted Current Folder, inspects both, and returns working
  Open in Board actions. The Workspace file is revision 1; the local file is
  independently verified on disk.
- Human note insertion and Save work in the Genie-created local Board. The
  configured Genie changes only its title and one note fill. Independent
  comparison confirms
  unchanged text, geometry and other styles, and exact equality between the
  open document and filesystem bytes. It reopens with the same SHA after the
  disable/re-enable and server restart cycle.
- Tool approvals were granted once for the observed test operations. Global
  auto-approval remained off. No creative-property whitelist was introduced.

The broader pending-image, concurrency, stale-write, atomic-refusal and
missing-original matrix remains recorded in [live qualification](BOARD-LIVE-QUALIFICATION.md).

## Full restore and fixture corrections

Full backup includes both databases and durable application state. Preflight
accepts all 133,643 rows. The actual restore passes migration lineage, ownership,
role and foreign-key integrity, authentication-state reconciliation and
authoritative runtime checks covering health, instance identity, SPA access,
database roles and OIDC. The existing local Board matches its pre-restore SHA
exactly.

The first restore attempt hit container-storage exhaustion. Its completed
automatic safety snapshot was retained. Reclaiming only cache records created by
this qualification build freed 4.388 GB; recovery from the verified full snapshot
then passed. No unrelated environment or storage volume was removed.

The initial packaged debug URL launch bypassed the normal server-authority
commit, so draft recovery correctly refused to open. Qualification was repeated
after the real setup picker committed the server identity. Do not use that debug
shortcut as proof of the normal packaged connection/recovery flow.

A forwarded database connection later timed out and the test server exited. The
final harness uses direct test-environment service networking for database and
identity-provider traffic. Runtime verification and both server restart cycles
pass on that setup.

## Checks and remaining boundary

The final combined packaging, Docker-stage and lifecycle run passes 63 tests
and 826 assertions. Board/server/Workbench types, artwork UI tests, changed-source
lint, Board scoped unused checks and limit checks pass. The limit inventory remains 5123 observations,
1256 reviewed and 3867 frozen legacy observations. An earlier combined run hit
two timeouts while backup and overlapping artifact builds were active; the final
combined run passes without changing assertions or timeouts.

The harness initially serialized shell-quoted values into a container environment
file; the runtime preserved those quotes and the management client refused
authentication. The harness now emits literal values and rejects unrepresentable
newlines. After service recreation, authentication-state equality, token issuance
and an authenticated Management API lookup pass; both requests return HTTP 200.
Runtime acceptance passes again and Board remains enabled. No product credential
rotation or authentication-code change was needed.

Local packaged qualification is complete for this exact candidate. PR
synchronization and full remote CI remain pending. Requalification after sync
must cover changed integration or packaging inputs; this candidate is not proof
for an unbuilt future merged image.
