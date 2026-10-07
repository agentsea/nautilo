import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_TASK_FOUNDATION_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: "packages/runtime/src/tasks/task-observer.ts#log_emitter:7ef703451e44cded:10",
    owner: "packages/runtime",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.task.protected-timeout-diagnostic",
    reason: "This exact protected Task watchdog diagnostic emits only a fixed retry code. It never inspects the caught provider/tool error; ordinary Task diagnostics retain their separate reviewed plaintext boundary.",
  },
];
