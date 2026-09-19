export const SOURCE_ALARM_BASELINE = {
  "count": 3346,
  "sha256": "3d3380bd78547e1af953b3c7af70f13265e61234a53f38e6e27b50e40da187c5"
} as const;

// Reviewed public-browser receipt constraints (0289–0291), scoped media
// references (0292), content-free Events preferences (0293), and the exact
// content-access receipt FK-cleanup permissions (0294); see the September 17
// coverage regression test. No applied migration was edited.
export const MIGRATION_TREE_BASELINE = {
  "migrations": 295,
  "snapshots": 266,
  "tip": 294,
  "sha256": "2b6366e15c5cd2b023bef84e574e8c652867f57e098ae9635fde0e2bcf0b2800"
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
export const DATABASE_WRITER_BASELINE = {
  "count": 1377,
  "insert": 466,
  "update": 722,
  "delete": 172,
  "unresolved": 17,
  "sha256": "9ee70550efead50646cba282ac614fc9786c15fa3930fd88bbbaa9a9125d851a"
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
