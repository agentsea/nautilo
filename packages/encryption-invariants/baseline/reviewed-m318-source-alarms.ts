import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_M318_SOURCE_ALARM_LOCATORS = new Set<string>([
  "packages/runtime/src/job.ts#log_emitter:0ae25e725db4e950:1",
]);

export const REVIEWED_M318_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:c4f22f3fb6bab4a7:1",
    owner: "apps/workbench", closure: "reviewed_exclusion",
    exclusionId: "exclusion.m318.pending-full-human-read-status",
    reason: "The pending Full Human history-read diagnostic has one fixed string argument only. It emits no exception, identifiers, Message content, ciphertext, credentials, or keys.",
  },
  {
    locator: "packages/runtime/src/job.ts#log_emitter:a37d1bc96a5f82fa:1",
    owner: "packages/runtime", closure: "reviewed_exclusion",
    exclusionId: "exclusion.m318.full-job-bounded-failure",
    reason: "The Full-mode branch emits only the Job identifier and bounded friendly code/category. It deliberately excludes exception details, Human input, tool arguments, results, ciphertext, and keys.",
  },
];
