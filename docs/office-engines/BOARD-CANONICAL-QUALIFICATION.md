# Board canonical integration checkpoint

2026-09-13. This is a historical controlled-fixture checkpoint. Subsequent integrated application proof is recorded in
[live qualification](BOARD-LIVE-QUALIFICATION.md); this checkpoint does not
claim a source merge or release.

## Implemented

- Native `.board.html` identity, complete source-derived schema, inert preview,
  reference/image checks and lossless engine admission. Nested preview geometry
  uses native world transforms; connector site indices are validated against
  their actual target geometry.
- Stable Board host composition, autosave after editing, exact SHA/revision CAS,
  dirty-Human fencing, serial save/copy/close and independent recovery journal.
  In-flight text is recoverable; unfinished image placement refuses close.
- Create-file/Open action, complete or selected inspection, schema discovery,
  native JSON Patch transactions and authorized image insertion. Host owns
  active session, version and idempotency; creative fields remain native-model
  data. Incomplete write receipts require reinspection.
- Workbench/Desktop Board recovery identity, eager canonical draft materialization,
  save-copy, native read-only preview, and a Board Apps-row revision regression.
- Prepared browser/Node bundles, dependency notices, hashed provenance and
  transactional artifact replacement. Prepared-only seeding uses the normal
  enabled default and preserves explicit disable. Docker receives the small
  host contract only; shipping the Board app remains a separate gate.

## Evidence

- 89 Board tests: model/HTML preservation, schema/security, JSON Patch/media,
  session/recovery and app composition.
- 233 Workbench/Desktop bridge, recovery and surface tests.
- 66 Apps-panel and association tests; 24 server registry/seed/authority tests.
- One hermetic artifact test imports the Node tool bundle outside the monorepo
  with no DOM globals; real server scan/build and tool registration use a
  separately seeded temporary app root.
- Ten scanner tests and eight Docker shape tests. Total: 431 focused tests.
- Eighteen native canvas browser scenarios plus ten prepared-app HTTP bridge
  scenarios on Chrome 152.0.7977.83. The latter prove typing/Save/reopen,
  unchanged context/header, unsupported-image refusal, Ivory/Tokyo preservation,
  concurrent Human draft/copy and read-only preview. The expanded fixture also
  covers decode failure, pending/aborted imports and inexact recovery. Results and screenshots:
  [canonical result](board-native/canonical-qualification.json),
  [Ivory](board-native/canonical-ivory.png), [Tokyo](board-native/canonical-tokyo.png).
- Board/Workbench/Server types, source lint, generated-schema drift and scoped unused
  files/exports/types checks. Limit inventory: 5123 observations, 1256 reviewed,
  3867 frozen legacy; two new entries are complete-scene preview extent
  accumulators, not document limits.

The broad mixed Bun invocation exposed cross-suite Workbench module mocks;
the affected suites pass in separate processes. The server typecheck needed
an 8 GiB Node heap after the default 4 GiB process exhausted memory.

## Boundary at this checkpoint

At this earlier checkpoint, integrated application and canonical-delivery
acceptance remained open. The browser used a controlled HTTP bridge, and server
registration used a controlled invocation fixture. Neither proved persisted
Workspace writes, granted Current Folder writes, actual provider execution and
approval, installed Apps-sidebar behavior, nor crash/restart acceptance. Those
flows were exercised later in an isolated populated test environment; see the
live qualification record.

Cold server-image inclusion, default-enabled installed lifecycle,
explicit-disable preservation, backup/restore, rollback and release artwork also
remained open at
this checkpoint. Notes remained deferred. Writer, Sheets and Slides were outside
this implementation scope.
