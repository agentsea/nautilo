import type { SourceAlarmReview } from "../src/node/source-alarm-review";

/** One new diagnostic; the sixteen preceding reviews remain unchanged. */
export const REVIEWED_D581_SOURCE_ALARMS: readonly SourceAlarmReview[] = [{
  locator: "packages/agent/src/utils/chat-model-invocation.ts#log_emitter:7ef703451e44cded:11",
  owner: "packages/agent",
  closure: "reviewed_exclusion",
  exclusionId: "exclusion.d581.research-context-recovery-route",
  reason: "The exact successful recovery log emits a fixed label, the selected model route ID, and the preflight/provider source enum. It emits no prompt, source excerpt, research note, tool argument, provider exception, credential, or recovery content. Existing generic logger retention and all earlier log reviews remain unchanged.",
}];

/**
 * These are table-qualified Drizzle updates, not raw-SQL debt. They add no
 * storage boundary: each written column retains its existing plaintext debt
 * classification. This exact producer map is checked against executable source;
 * it deliberately does not advance the repository-wide writer fingerprint.
 */
export const D581_METADATA_WRITERS = [
  { path: "packages/db/src/queries/tasks.ts", symbol: "transitionTaskLifecyclePaused", table: "task_runs", fields: ["status"] },
  { path: "packages/db/src/queries/tasks.ts", symbol: "transitionTaskLifecyclePaused", table: "tasks", fields: ["status", "fireLockId", "fireLockedAt", "updatedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "attachSecurityResearchJob", table: "task_runs", fields: ["jobId"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "parkSecurityReportDelivery", table: "task_runs", fields: ["status", "lastError"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "parkSecurityReportDelivery", table: "tasks", fields: ["status", "lastError", "fireLockId", "fireLockedAt", "updatedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "pauseSecurityResearchResume", table: "tasks", fields: ["status", "fireLockId", "fireLockedAt", "updatedAt", "lastError"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "resumeSecurityResearchRun", table: "task_runs", fields: ["status", "lastError"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "resumeSecurityResearchRun", table: "tasks", fields: ["status", "lastError", "updatedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "recoverSecurityResearchContextFailure", table: "task_runs", fields: ["status", "completedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "recoverSecurityResearchContextFailure", table: "tasks", fields: ["status", "nextFireAt", "fireLockId", "fireLockedAt", "updatedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "parkSecurityResearchInterruption", table: "task_runs", fields: ["status", "lastError"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "parkSecurityResearchInterruption", table: "tasks", fields: ["status", "lastError", "metadata", "fireLockId", "fireLockedAt", "updatedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "resumeReconnectedSecurityResearch", table: "tasks", fields: ["status", "nextFireAt", "fireLockId", "fireLockedAt", "updatedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "holdSecurityResearchDesktop", table: "tasks", fields: ["lastError", "updatedAt"] },
  { path: "packages/runtime/src/tasks/security-report-recovery.ts", symbol: "recordSecurityResearchFailure", table: "tasks", fields: ["metadata"] },
] as const;
