import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const REVIEWED_M321_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    locator: "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:034d7815784a896f:1",
    owner: "apps/workbench", closure: "reviewed_exclusion",
    exclusionId: "exclusion.m321.protected-history-closed-diagnostic",
    reason: "The protected-history diagnostic serializes only three closed enums: operation, verification stage, and normalized error class. It excludes exception messages, Message content, identifiers, ciphertext, credentials, and keys.",
  },
  {
    locator: "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:5d3d0abe908ab682:3",
    owner: "apps/workbench", closure: "reviewed_exclusion",
    exclusionId: "exclusion.m321.shared-agent-fallback-coordinate",
    reason: "The development-only fallback diagnostic emits a fixed label, opaque operation identifier, and closed fallback reason. It excludes exception text, Message content, ciphertext, credentials, and keys.",
  },
  {
    locator: "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:64514dceb059bcdc:1",
    owner: "apps/workbench", closure: "reviewed_exclusion",
    exclusionId: "exclusion.m321.protected-edit-failure-class",
    reason: "The protected-edit diagnostic emits a fixed label plus the closed encryption data-operation failure classification. Arbitrary Error names/messages, Message content, ciphertext, credentials, and keys are excluded.",
  },
  {
    locator: "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:64514dceb059bcdc:2",
    owner: "apps/workbench", closure: "reviewed_exclusion",
    exclusionId: "exclusion.m321.room-event-failure-class",
    reason: "The Room-event diagnostic emits a fixed label plus the closed encryption data-operation failure classification. Arbitrary Error names/messages, Message/event content, ciphertext, credentials, and keys are excluded.",
  },
];
