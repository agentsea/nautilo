import type { SourceAlarmReview } from "../src/node/source-alarm-review";

const LOCATORS = [
  "packages/server/src/auth/device-admission-gate.ts#log_emitter:2f2c670d3d97e24d:1",
  "packages/server/src/routes/device-admission.ts#log_emitter:0e89fa60a75a95f8:1",
  "packages/server/src/routes/device-admission.ts#log_emitter:0e89fa60a75a95f8:2",
  "packages/server/src/routes/device-admission.ts#log_emitter:2f2c670d3d97e24d:1",
  "packages/server/src/routes/device-admission.ts#log_emitter:2f2c670d3d97e24d:2",
  "packages/server/src/routes/device-admission.ts#log_emitter:2f2c670d3d97e24d:3",
  "packages/server/src/routes/device-admission.ts#log_emitter:2f2c670d3d97e24d:4",
  "packages/server/src/routes/device-admission.ts#log_emitter:d0e3502dbae9334e:1",
] as const;

export const REVIEWED_M303_SOURCE_ALARMS: readonly SourceAlarmReview[] =
  LOCATORS.map((locator, index) => ({
    locator,
    owner: "packages/server",
    closure: "reviewed_exclusion" as const,
    exclusionId: `exclusion.m303.device-admission-lifecycle-${index + 1}`,
    reason:
      "This exact admission lifecycle log contains only a fixed event code and a closed status or reason code. It emits no bearer or credential digest, challenge, signature, device or Human identifier, protected object coordinate, content, key material, or exception text.",
  }));
