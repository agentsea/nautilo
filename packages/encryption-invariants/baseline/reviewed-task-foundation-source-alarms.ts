import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_TASK_FOUNDATION_SOURCE_ALARM_LOCATORS = new Set([
  "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:2",
]);

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
    locator:
      "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:2",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-execution-settlement-failure",
    reason:
      "This exact protected Task settlement diagnostic emits a fixed failure label and one opaque Job UUID. The catch discards the settlement error, so no exception text, Task content, Message content, checkpoint bytes, credentials or keys reach the log.",
  },
  {
    locator:
      "packages/runtime/src/job-manager.ts#log_emitter:7ef703451e44cded:6",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.foreground-lock-release-failure",
    reason:
      "This exact foreground lock-release diagnostic is a fixed literal with no dynamic arguments. The catch discards the lock error, so no exception text, Task content, Message content, identifier, credential or key reaches the log.",
  },
];
