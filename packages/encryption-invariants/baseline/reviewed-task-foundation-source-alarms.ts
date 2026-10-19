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
  "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:2",
  "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:3",
  "packages/runtime/src/tasks/dispatch-task-run.ts#log_emitter:0ae25e725db4e950:4",
  "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:3",
  "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:8",
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
    locator: "packages/server/src/routes/protected-task-native-fixed-memory-segment.ts#log_emitter:7ef703451e44cded:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.segment-failure-code",
    reason: "This exact protected Task diagnostic emits only a fixed label and the closed PTFMS001–PTFMS008 stage codes. The exception is discarded from the log; no Task prompt, result, transcript, checkpoint, Human identity, key, or provider error is emitted.",
  },
  {
    locator: "packages/server/src/routes/protected-task-native-fixed-memory-segment.ts#log_emitter:7ef703451e44cded:2",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.failure-publication-code",
    reason: "This exact protected Task diagnostic emits only a fixed label and the closed PTFMS001–PTFMS008 stage codes. The exception is discarded from the log; no Task prompt, result, transcript, checkpoint, Human identity, key, or provider error is emitted.",
  },
  {
    locator:
      "packages/db/scripts/finalize-task-crypto-lifecycle.ts#filesystem_write:5e7543910a09a852:1",
    owner: "packages/db",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.generated-crypto-lifecycle-migration-finalizer",
    reason:
      "This exact build-time finalizer writes deterministic schema SQL into the current generated migration. It does not read or persist Task prompts, results, transcripts, checkpoint bytes, credentials, keys, or instance data.",
  },
  {
    locator:
      "packages/db/scripts/finalize-task-cancellation-staging.ts#filesystem_write:094c47a94a93b928:1",
    owner: "packages/db",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.generated-staging-authority-migration-finalizer",
    reason:
      "This exact build-time finalizer writes only deterministic RLS and role-grant SQL for generated Task staging tables. It does not read or persist runtime Task content, ciphertext, credentials, keys, or instance data.",
  },
  {
    locator:
      "packages/runtime/src/tasks/report-back.ts#log_emitter:7ef703451e44cded:3",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.stale-dispatch-result-diagnostic",
    reason:
      "This exact stale-dispatch diagnostic emits a fixed label and one opaque Task UUID. It never logs the dispatch error, Task prompt, result, transcript, checkpoint bytes, credentials, or keys.",
  },
  relocatedDeclaration(
    "packages/runtime/src/tasks/resolve-task-memory-envelope.ts#log_emitter:9f39e0a243a29276:1",
    "source.task-foundation.wide-envelope-fallback",
    "This ordinary Task authority-selection diagnostic emits an opaque Task UUID and the closed envelope-resolution reason before preserving the existing namespace fallback. It is a reviewed plaintext operational boundary and does not establish protected Task authority.",
  ),
  relocatedDeclaration(
    "packages/runtime/src/tasks/resolve-task-memory-envelope.ts#log_emitter:9f39e0a243a29276:2",
    "source.task-foundation.calling-room-envelope-fallback",
    "This ordinary Task authority-selection diagnostic emits an opaque Task UUID and the closed target-user resolution reason after the calling Room was independently authorized. It is a reviewed plaintext operational boundary and does not expose Task content.",
  ),
  relocatedDeclaration(
    "packages/runtime/src/tasks/resolve-task-memory-envelope.ts#log_emitter:9f39e0a243a29276:3",
    "source.task-foundation.base-envelope-fallback",
    "This ordinary Task authority-selection diagnostic emits an opaque Task UUID and the closed target-user resolution reason before preserving the existing base namespace fallback. Protected callers reject this fallback rather than treating the log as authority.",
  ),
  {
    locator:
      "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:6",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-occurrence-recovery-retry",
    reason:
      "This exact protected occurrence recovery diagnostic is a fixed retry code. The catch discards the query error and emits no Task or Message content, identifier, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:7",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-occurrence-prepare-retry",
    reason:
      "This exact protected occurrence preparation diagnostic is a fixed retry code. The catch discards the preparation error and emits no Task or Message content, identifier, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:8",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-occurrence-claim-retry",
    reason:
      "This exact protected occurrence claim diagnostic is a fixed retry code. The catch discards the query error and emits no Task or Message content, identifier, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:9",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-occurrence-port-retry",
    reason:
      "This exact protected occurrence port diagnostic is a fixed retry code. The catch discards the authorization error and emits no Task or Message content, identifier, checkpoint bytes, credentials, or keys.",
  },
  relocatedDeclaration(
    "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:8",
    "source.task-foundation.dispatch-failure-delivery-failure",
    "This ordinary Task dispatch diagnostic retains the existing plaintext operational boundary for the opaque Task UUID and delivery error. It does not establish protected Task authority or classify that generic error text as protected or content-free.",
  ),
  relocatedDeclaration(
    "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:9",
    "source.task-foundation.time-limit-scan-failure",
    "This Task watchdog diagnostic retains the existing plaintext operational boundary for the database scan error. It does not establish protected Task authority or classify that generic error text as protected or content-free.",
  ),
  relocatedDeclaration(
    "packages/runtime/src/tasks/task-observer.ts#log_emitter:0ae25e725db4e950:10",
    "source.task-foundation.ordinary-time-limit-pause-failure",
    "This diagnostic is reachable only for an ordinary Task after the protected branch has emitted its fixed retry code and continued. It retains the existing plaintext operational boundary for the opaque Task UUID and pause error; it does not classify that generic error text as protected or content-free.",
  ),
  {
    locator:
      "packages/runtime/src/tasks/lifecycle.ts#log_emitter:7ef703451e44cded:3",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.checkpoint-resumed-diagnostic",
    reason:
      "This exact checkpoint-resume diagnostic emits a fixed label, one opaque Task UUID, and the closed Task status after the durable resume transition. It contains no Task content, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/runtime/src/tasks/lifecycle.ts#log_emitter:7ef703451e44cded:4",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.stopped-diagnostic",
    reason:
      "This exact stopped-Task diagnostic emits a fixed label plus opaque Task and optional TaskRun UUIDs after terminal settlement. It contains no Task prompt, result, transcript, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:244f290d003a8f2a:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-wake-retry",
    reason:
      "This exact protected wake diagnostic is a fixed retry code. The rejection is discarded and no Task or Message content, identifier, checkpoint bytes, credentials, or keys are interpolated.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:4",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-result-settlement-retry",
    reason:
      "This exact protected result-settlement diagnostic is a fixed retry code derived only from a nonzero failure count. It emits no Task or Message content, identifiers, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:5",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-running-recovery-retry",
    reason:
      "This exact protected abandoned-execution diagnostic is a fixed retry code derived only from a nonzero failure count. It emits no Task or Job content, identifiers, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:6",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-preexecution-recovery-retry",
    reason:
      "This exact protected pre-execution recovery diagnostic is a fixed retry code derived only from a nonzero failure count. It emits no Task content, identifiers, checkpoint bytes, credentials, or keys.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:7",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-checkpoint-pause-retry",
    reason:
      "This exact protected checkpoint-pause recovery diagnostic is a fixed retry code derived only from a nonzero failure count. It emits no Task content, identifiers, checkpoint bytes, credentials, or keys.",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:10",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.time-limit-paused-diagnostic",
    reason: "This exact time-limit diagnostic emits only a fixed label and one opaque Task UUID after the pause transition returns. It contains no Task prompt, result, transcript, checkpoint bytes, credentials, or keys.",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:11",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-timeout-diagnostic",
    reason: "This exact protected Task watchdog diagnostic emits only the fixed settlement-pending code after the pause transition does not settle. It emits no Task content, results, identifiers, tool payloads, credentials, keys, or caught exceptions.",
  },
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:3",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.ordinary-policy-unavailable",
    reason: "This exact Task policy-selection diagnostic emits only a fixed retry code. The catch discards the policy error and emits no Task or Message content, identifier, checkpoint bytes, credentials, or keys.",
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
    exclusionId: "exclusion.task.initial-cancellation-recovery",
    reason:
      "This production initial-composition diagnostic runs only behind the Task content owner and emits the fixed protected-stop retry code. It contains no dynamic payload or caught error text.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:2",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.initial-cancellation-output-recovery",
    reason:
      "This production initial-composition diagnostic runs only behind the Task content owner and emits the fixed protected cancellation-output retry code. It contains no dynamic payload or caught error text.",
  },
  {
    locator:
      "packages/server/src/routes/protected-task-runtime-initial-composition.ts#log_emitter:7ef703451e44cded:3",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.initial-terminal-delivery-recovery",
    reason:
      "This production initial-composition diagnostic runs only behind the Task content owner and emits the fixed protected terminal-delivery retry code. It contains no dynamic payload or caught error text.",
  },
  {
    locator: `${JOB_MANAGER_LOG_PREFIX}:5de77a580b7641d5:1`,
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-wake-settlement-unavailable",
    reason:
      "This exact protected wake settlement diagnostic emits a fixed closed label and one opaque Job UUID. It contains no Task prompt, result, transcript, checkpoint bytes, caught error text, credential or key material.",
  },
  {
    locator:
      "packages/server/src/app.ts#log_emitter:b4d80a858be836ca:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.observer-local-readiness-retry",
    reason:
      "This exact Task observer readiness diagnostic is a fixed literal. Its catch discards the retry error and emits no Task, Message or checkpoint content, identifier, credential or key material.",
  },
];
