import type { SourceAlarmReview } from "../src/node/source-alarm-review";

const JOB_MANAGER_LOG_PREFIX =
  "packages/runtime/src/job-manager.ts#log_emitter";

/**
 * Adding the protected-Task recovery diagnostics changes the occurrence
 * ordinal for later same-signature log calls. Retire every reused historical
 * locator whose semantic callsite changed before installing the exact current
 * review below.
 */
export const SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS = new Set([
  `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:1`,
  `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:2`,
  `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:3`,
  `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:4`,
  "packages/runtime/src/job.ts#log_emitter:a37d1bc96a5f82fa:1",
]);

const relocatedDeclaration = (
  locator: string,
  declarationId: string,
  reason: string,
): SourceAlarmReview => ({
  locator,
  owner: "packages/runtime",
  closure: "declaration",
  declarationId,
  reason,
});

export const REVIEWED_TASK_FOUNDATION_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:10",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-timeout-diagnostic",
    reason: "This exact protected Task watchdog diagnostic emits only a fixed retry code. It never inspects the caught provider/tool error; ordinary Task diagnostics retain their separate reviewed plaintext boundary.",
  },
  {
    locator:
      "packages/db/scripts/finalize-task-execution-evidence.ts#filesystem_write:ff2763bae2791e66:1",
    owner: "packages/db",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.generated-execution-evidence-migration-finalizer",
    reason:
      "This exact build-time finalizer writes only deterministic schema SQL to the current generated migration before commit. It does not read or persist runtime Task content, Message content, checkpoint bytes, credentials, keys or instance data.",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:1`,
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.parked-persistence-recovery-negative-result",
    reason:
      "This exact parked protected Task persistence-recovery diagnostic is a fixed literal. The negative-result branch emits no exception, Task or Message content, identifier, checkpoint bytes, credential or key material.",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:2`,
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.parked-persistence-recovery-catch",
    reason:
      "This exact parked protected Task persistence-recovery diagnostic is a fixed literal. The catch discards the recovery error and emits no Task or Message content, identifier, checkpoint bytes, credential or key material.",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:3`,
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-preexecution-start-recovery",
    reason:
      "This exact protected Task pre-execution recovery diagnostic is a fixed literal. Its catch discards the recovery error and emits no Task or Message content, identifier, checkpoint bytes, credential or key material.",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:4`,
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-preexecution-lost-start-recovery",
    reason:
      "This exact protected Task pre-execution recovery diagnostic is a fixed literal. Its catch discards the recovery error and emits no Task or Message content, identifier, checkpoint bytes, credential or key material.",
  },
  relocatedDeclaration(
    `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:5`,
    "source.task-foundation.relocated-foreground-candidate-failure",
    "This relocated foreground candidate persistence diagnostic remains on Nautilo's reviewed plaintext diagnostic boundary. It emits a fixed status code and an opaque Job identifier; the relocation does not establish any new protected execution authority.",
  ),
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:6`,
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-execution-settlement-failure",
    reason:
      "This exact protected Task settlement diagnostic emits a fixed failure label and one opaque Job UUID. The catch discards the settlement error, so no exception text, Task content, Message content, checkpoint bytes, credentials or keys reach the log.",
  },
  relocatedDeclaration(
    `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:7`,
    "source.task-foundation.relocated-fork-candidate-failure",
    "This relocated fork candidate persistence diagnostic remains on Nautilo's reviewed plaintext diagnostic boundary. It emits a fixed status code and an opaque Job identifier; the relocation does not establish any new protected execution authority.",
  ),
  relocatedDeclaration(
    `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:8`,
    "source.task-foundation.relocated-invocation-cancellation",
    "This relocated invocation-cancellation diagnostic remains on Nautilo's reviewed plaintext diagnostic boundary. The exact call is a fixed literal and the caught persistence failure is not interpolated.",
  ),
  relocatedDeclaration(
    `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:9`,
    "source.task-foundation.relocated-foreground-prepersistence",
    "This relocated foreground pre-persistence diagnostic remains on Nautilo's reviewed plaintext diagnostic boundary. It emits only a fixed label and the closed failure-reason enum already owned by this boundary.",
  ),
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:7ef703451e44cded:10`,
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.foreground-lock-release-failure",
    reason:
      "This exact foreground lock-release diagnostic is a fixed literal with no dynamic arguments. The catch discards the lock error, so no exception text, Task content, Message content, identifier, credential or key reaches the log.",
  },
  relocatedDeclaration(
    `${JOB_MANAGER_LOG_PREFIX}:0ae25e725db4e950:19`,
    "source.task-foundation.relocated-maintenance-stop-failure",
    "This relocated maintenance stop diagnostic remains on Nautilo's reviewed plaintext diagnostic boundary and can include ordinary error text with opaque Task and TaskRun identifiers. This declaration does not classify those generic logged values as encrypted or content-free.",
  ),
  relocatedDeclaration(
    "packages/runtime/src/job.ts#log_emitter:d7b5f728bf9d919d:1",
    "source.task-foundation.relocated-job-failure",
    "This refactored Job failure call remains on Nautilo's reviewed plaintext diagnostic boundary. The protected Full-sink branch emits only the opaque Job identifier and bounded code/category, while the ordinary branch may retain friendly diagnostic details; this declaration does not classify those ordinary values as encrypted or content-free.",
  ),
  {
    locator:
      "packages/runtime/src/tasks/lifecycle.ts#log_emitter:0ae25e725db4e950:2",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-process-settlement-failure",
    reason:
      "This exact protected Task process-settlement diagnostic emits a fixed failure label plus opaque Task and TaskRun UUIDs. The catch discards the settlement error, so no exception text, Task content, Message content, checkpoint bytes, credentials or keys reach the log.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.dark-initial-cancellation-recovery",
    reason:
      "This source-scanned initial-composition diagnostic is currently not mounted by the production app and emits only the fixed protected-stop retry code. It contains no dynamic payload or caught error text.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:2",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.dark-initial-result-recovery",
    reason:
      "This source-scanned initial-composition diagnostic is currently not mounted by the production app and emits only the fixed protected-result retry code. It contains no dynamic payload or caught error text.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:3",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.dark-initial-preexecution-recovery",
    reason:
      "This source-scanned initial-composition diagnostic is currently not mounted by the production app and emits only the fixed protected-start retry code. It contains no dynamic payload or caught error text.",
  },
];
