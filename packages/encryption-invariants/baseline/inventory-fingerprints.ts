export const SOURCE_ALARM_BASELINE = {
  "count": 3443,
  "sha256": "9ed2294e1e2325a4e24ceb91c567d56b3117b20b29dcdb57db90a2cbcd250b69"
} as const;

// Reviewed public-browser receipt constraints (0289–0291), scoped media
// references (0292), content-free Events preferences (0293), and the exact
// content-access receipt FK-cleanup permissions (0294); see the September 17
// coverage regression test. The speech-model selection column remains main's
// 0295 migration, followed by the execution-input message lookup index at 0296
// for selected-message interruption summaries. No migration body was edited.
export const MIGRATION_TREE_BASELINE = {
  "migrations": 355,
  "snapshots": 326,
  "tip": 354,
  "sha256": "153d0cd90c2dc942fb3f54149288f9634957f50dd0be55978ad9418b64350f12"
} as const;

/**
 * Reviewed production Drizzle mutation inventory.
 *
 * The scanner retains every endpoint-independent locator in repository
 * inventory; this exact fingerprint prevents additions, removals, moves, table
 * changes, operation changes, and count-neutral substitutions from passing.
 */
// September 12: reviewed appended feature writers and the exact Reflection
// helper moves, then PR #1323's eight typed writer additions (four inserts and
// four updates). Ordinary sibling payloads retain the existing ordinary payload
// classification; the other writes update identity/control state. Five generated
// migrations and seven exact source alarms are reviewed separately. The Memory
// embedding provenance pass replaces its remaining raw Memory mutations with
// table-qualified writers; the extra insert is the typed atomic projection row.
// September 17: PR #12 adds one schema-derived Events preference upsert in
// packages/db/src/queries/event-feed-preferences.ts. It validates the closed
// enum/timestamp pair and changes only those columns plus updatedAt; executable
// recording-transport tests prove it leaves chat policy and feed state alone.
// Retiring the persona-addressed foreground issuer removes four inserts and
// four updates; no writer or plaintext exception is added.
// Protected execution recovery adds one typed lifecycle-only quarantine update.
// Its exact execution-state and publication guards are covered by the shared-Agent
// planner and conversation product-store unit suites; it never writes content.
// Connected-web steering now fails closed when replacement-run budget cannot be
// proven, removing its two run-rotation update callsites without adding writers.
// Task execution review accounts for 103 added and 11 replaced locators. The
// content boundaries are canonical Shadow Memory fallback, foreground Task
// creation, and definition/result mapping; Full clears ordinary content while
// Dual retains its admitted sibling. Other additions retain receipt, authority,
// routing or lifecycle metadata. No new unresolved writer is admitted. The
// migration review accounts for 20 added bodies, with all six earlier conversion
// and funding bodies byte-identical after main's slot reconciliation.
export const DATABASE_WRITER_BASELINE = {
  "count": 1598,
  "insert": 522,
  "update": 873,
  "delete": 186,
  "unresolved": 17,
  "sha256": "bb6cbec94eeef8b96eddeecf55bbe1aaa4253a21c153dff458ee06836a5a9b56"
} as const;

/**
 * The committed initial Wave 0 debt snapshot. Updating this lock is a
 * deliberate baseline reset, not the normal way to classify new inventory.
 */
export const WAVE_0_BASELINE_DEBT_LOCK = {
  "version": "wave-0-initial",
  "count": 1590,
  "sha256": "d235dc3b6a42090e5a65f1f665ad95496b8b5d9b530286b6c975b036d02625ac"
} as const;
