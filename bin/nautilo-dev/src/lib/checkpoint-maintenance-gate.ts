/** D489 3.2 mutation gate.  It deliberately contains no DELETE/UPDATE/VACUUM SQL. */
import type { BackupCaptureState, BackupQuiescenceDeps } from "./backup-quiescence";
import { BackupQuiescenceOperationError, BackupWriterRestorationError, withQuiescedBackupSource, type BackupWriterStateEvidence } from "./backup-quiescence";
import type { VerifiedFullBackup } from "./full-dev-backup";

export type CheckpointMaintenanceGateFailure =
  | "consent"
  | "backup"
  | "source-evidence"
  | "writer-quiescence"
  | "resume";

export interface CheckpointMaintenanceGateResult<SourceEvidence = unknown> {
  readonly backup: VerifiedFullBackup;
  /** Original canonical source proof, for a post-mutation stable-identity recheck. */
  readonly sourceEvidence: SourceEvidence;
  /** Evidence that the quiescence/restore boundary completed; it is not a later mutation lease. */
  readonly paused: BackupCaptureState;
}

export interface CheckpointMaintenanceGateDeps<SourceEvidence = unknown> {
  /** Must evaluate the existing D202 protected-default mutation guard. */
  readonly assertConsent: () => void;
  /** Capture, publish, hash-verify, and return a recovery backup before writers pause for mutation. */
  readonly publishVerifiedRecoveryBackup: () => Promise<VerifiedFullBackup>;
  /** Canonical source identity/lineage evidence captured before backup. */
  readonly captureSourceEvidence: () => Promise<SourceEvidence>;
  /** Re-check source evidence after the published backup. */
  readonly assertSourceEvidenceUnchanged: (before: SourceEvidence) => Promise<void>;
  readonly quiescence: BackupQuiescenceDeps;
  /** Phase 3.3 must execute its transactional delete inside this boundary. */
  readonly afterWritersQuiesced?: (state: BackupCaptureState) => Promise<void>;
}

export class CheckpointMaintenanceGateError extends Error {
  readonly writerState?: BackupWriterStateEvidence;
  constructor(readonly code: CheckpointMaintenanceGateFailure, cause?: unknown, readonly writerBoundary?: "backup" | "mutation") {
    super(`Checkpoint maintenance gate failed: ${code}`);
    this.cause = cause;
    if (cause instanceof BackupWriterRestorationError || cause instanceof BackupQuiescenceOperationError) {
      this.writerState = cause.writerState;
    }
  }
}

function asGateError(code: CheckpointMaintenanceGateFailure, error: unknown, writerBoundary?: "backup" | "mutation"): CheckpointMaintenanceGateError {
  return error instanceof CheckpointMaintenanceGateError ? error : new CheckpointMaintenanceGateError(code, error, writerBoundary);
}

/**
 * The only state-changing action here is pausing/resuming recognized writers.
 * `withQuiescedBackupSource` rejects foreign listeners, drains active clients,
 * and restores exactly what it paused in `finally`, including failure paths.
 */
export async function gateCheckpointMaintenanceApply<SourceEvidence>(
  deps: CheckpointMaintenanceGateDeps<SourceEvidence>,
): Promise<CheckpointMaintenanceGateResult<SourceEvidence>> {
  try {
    deps.assertConsent();
  } catch (error) {
    throw asGateError("consent", error);
  }
  let evidence: SourceEvidence;
  try {
    evidence = await deps.captureSourceEvidence();
  } catch (error) {
    throw asGateError("source-evidence", error);
  }
  let backup: VerifiedFullBackup;
  try {
    backup = await deps.publishVerifiedRecoveryBackup();
  } catch (error) {
    throw asGateError(error instanceof BackupWriterRestorationError ? "resume" : "backup", error, "backup");
  }
  try {
    await deps.assertSourceEvidenceUnchanged(evidence);
  } catch (error) {
    throw asGateError("source-evidence", error);
  }
  try {
    let paused: BackupCaptureState | undefined;
    await withQuiescedBackupSource(deps.quiescence, async (state) => {
      paused = state;
      // Phase 3.3's only mutation entrypoint. It remains inside the same
      // quiescence/finally-restoration boundary as the verified backup gate.
      await deps.afterWritersQuiesced?.(state);
    });
    if (paused === undefined) throw new Error("writer state was not captured");
    return { backup, sourceEvidence: evidence, paused };
  } catch (error) {
    throw asGateError(error instanceof BackupWriterRestorationError ? "resume" : "writer-quiescence", error, "mutation");
  }
}
