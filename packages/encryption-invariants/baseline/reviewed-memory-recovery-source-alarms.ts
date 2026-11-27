import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_MEMORY_RECOVERY_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    locator: "packages/server/src/app.ts#log_emitter:4653f2598ab1da64:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId:
      "exclusion.memory-recovery.stenographer-automatic-scan-warning",
    reason:
      "This exact warning emits only the fixed Stenographer automatic-provider-recovery failure literal. It includes no Room, Human, work, model, provider, request, response, credential, error object, prompt, Journal content, or model output.",
  },
  {
    locator: "packages/server/src/app.ts#log_emitter:4653f2598ab1da64:2",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId:
      "exclusion.memory-recovery.reflection-automatic-scan-warning",
    reason:
      "This exact warning emits only the fixed Reflection automatic-provider-recovery failure literal. It includes no Record, Human, work, model, provider, request, response, credential, error object, prompt, source content, or model output.",
  },
  {
    locator: "packages/server/src/app.ts#log_emitter:52fc75dba775a07f:1",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.memory-recovery.manual-assessment-warning",
    reason:
      "This exact warning emits a fixed manual-recovery assessment-failure literal plus only the closed processor discriminator stenographer, reflection, or memory. It includes no request UUID, operator, Room, Record, work, model, provider, response, credential, error object, prompt, content, or model output.",
  },
  {
    locator: "packages/server/src/routes/reflection-status.ts#log_emitter:a90c23f4818770fe:3",
    owner: "packages/server",
    closure: "reviewed_exclusion",
    exclusionId: "exclusion.memory-recovery.reflection-diagnostics-warning",
    reason: "The supplemental Reflection query reports a fixed failure code. The logger receives no exception, wire evidence, or product content.",
  },
] as const;
