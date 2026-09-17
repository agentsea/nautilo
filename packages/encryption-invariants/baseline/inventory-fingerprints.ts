export const SOURCE_ALARM_BASELINE = {
  "count": 3345,
  "sha256": "6e57bf7a7732985ac6ef02e20943bc53e4055981e266757414588a618b5f9c53"
} as const;

// Reviewed public-browser receipt constraints (0289–0291), scoped media
// references (0292), and content-free Events preferences (0293); see the
// September 17 coverage regression test. No applied migration was edited.
export const MIGRATION_TREE_BASELINE = {
  "migrations": 294,
  "snapshots": 265,
  "tip": 293,
  "sha256": "0a0ad6c04b9acdfd80a66b760306a3c69670fe7a9175a46a61ed128dbc9976c9"
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
export const DATABASE_WRITER_BASELINE = {
  "count": 1384,
  "insert": 470,
  "update": 725,
  "delete": 172,
  "unresolved": 17,
  "sha256": "7a048b6b67164ddf1c9a198428521d64c3f6e01f1811c0cb895aeb93cc10dbd1"
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
