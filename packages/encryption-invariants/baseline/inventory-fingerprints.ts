export const SOURCE_ALARM_BASELINE = {
  "count": 3321,
  "sha256": "2e2b35607f1dad8d8e65e6eac7bc49a4c39bd55f21c5fde7e4b6bab52bb37830"
} as const;

export const MIGRATION_TREE_BASELINE = {
  "migrations": 289,
  "snapshots": 260,
  "tip": 288,
  "sha256": "20dd5713f6acb5b8449751b1494c718eea98e21760917fbabf555db45b2815aa"
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
export const DATABASE_WRITER_BASELINE = {
  "count": 1383,
  "insert": 469,
  "update": 725,
  "delete": 172,
  "unresolved": 17,
  "sha256": "fa7e0a84fcc51c491689100a171dcb827c069922eb86c5734234549ea40018ad"
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
