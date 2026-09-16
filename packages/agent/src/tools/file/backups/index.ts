/**
 * D087 Phase 2A — backup subsystem barrel.
 *
 * Public API surface:
 *   - `recordRevision(input)`       — called from `apply_patch` success.
 *   - `setBackupStorage(zones)`     — called once at server boot.
 *   - `resetBackupStorage()`        — test teardown only.
 *   - `sweepPerFileCap(...)`        — inline post-turn count-cap sweep.
 *   - `sweepHourly(...)` / `runHourlyGc` — background size-cap + blob GC.
 *
 * The internal `hot-lane.ts` / `cold-lane.ts` modules are
 * deliberately NOT re-exported — callers always go through
 * `recordRevision` so routing stays centralized.
 */

export {
  recordRevision,
  BACKUP_ROUTING,
  type RecordRevisionInput,
  type RecordRevisionResult,
} from "./record-revision";

export {
  setBackupStorage,
  resetBackupStorage,
  blobRelPathFor,
} from "./storage-registry";

// D087 Phase 3 §3.10 — revision-event sink. Server wires the
// broadcaster at boot; the backup subsystem fires
// `revisions.state_changed` events whenever the store changes.
export {
  setRevisionEventSink,
  resetRevisionEventSink,
  type RevisionEventSink,
} from "./events-sink";

export { findLatestRevisionForPath } from "./legacy-history-read";

export {
  sweepPerFileCap,
  sweepHourly,
  startBackupGcScheduler,
  stopBackupGcScheduler,
  isBackupGcSchedulerRunning,
  DEFAULT_GC_CONFIG,
  DEFAULT_GC_INTERVAL_MS,
  type GcConfig,
  type StartBackupGcOptions,
  type PerFileSweepResult,
  type HourlySweepResult,
} from "./gc";
