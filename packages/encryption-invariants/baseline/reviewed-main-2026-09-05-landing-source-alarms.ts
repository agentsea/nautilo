import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_LANDING_SOURCE_LOCATORS = new Set<string>([
  "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:8",
  "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:02d6d32a757bab9d:9",
  "packages/agent/src/graph/resume-approval.ts#log_emitter:a1436e7c26c240df:4",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:0ae25e725db4e950:4",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:7ef703451e44cded:8",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:89b81c36ea23316a:1",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:a1436e7c26c240df:3",
  "packages/runtime/src/executors/langgraph-executor.ts#log_emitter:a1436e7c26c240df:4",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:6c54dafd09158e6d:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:794aa27d55622eb3:1",
  "packages/runtime/src/stenographer/worker.ts#log_emitter:c7761f38ffc51ff7:1"
]);

/** Exact reviewed calls only; no new wildcard or frozen-debt admission. */
export const REVIEWED_LANDING_SOURCE_ALARMS: readonly SourceAlarmReview[] = [
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:5d3d0abe908ab682:1",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.1",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "apps/workbench/src/adapters/nautilo-runtime.tsx#log_emitter:5d3d0abe908ab682:2",
    "owner": "apps/workbench",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.2",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/agent/src/graph/resume-approval.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/agent",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.3",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/runtime/src/executors/persisting-processor.ts#log_emitter:89b81c36ea23316a:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.4",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/runtime/src/reflection/production-reflection-memory.ts#log_emitter:1c3639abca3bb78d:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.5",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:60d2ebbc60ac0040:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.6",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:6a450c440341d85b:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.7",
    "reason": "These forwarding wrappers keep Stenographer diagnostics on the existing source.log.generic plaintext logger. The Record<string, unknown> fields are not claimed content-free or encrypted, and adding the no-throw wrapper does not add a new logging destination."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:92d51e586f3a6191:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.8",
    "reason": "These forwarding wrappers keep Stenographer diagnostics on the existing source.log.generic plaintext logger. The Record<string, unknown> fields are not claimed content-free or encrypted, and adding the no-throw wrapper does not add a new logging destination."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:b2ead30ccaff59a5:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.9",
    "reason": "These forwarding wrappers keep Stenographer diagnostics on the existing source.log.generic plaintext logger. The Record<string, unknown> fields are not claimed content-free or encrypted, and adding the no-throw wrapper does not add a new logging destination."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:cbad719ce71c6b05:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.10",
    "reason": "These forwarding wrappers keep Stenographer diagnostics on the existing source.log.generic plaintext logger. The Record<string, unknown> fields are not claimed content-free or encrypted, and adding the no-throw wrapper does not add a new logging destination."
  },
  {
    "locator": "packages/runtime/src/stenographer/worker.ts#log_emitter:ede98c03825af9b8:1",
    "owner": "packages/runtime",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.11",
    "reason": "These forwarding wrappers keep Stenographer diagnostics on the existing source.log.generic plaintext logger. The Record<string, unknown> fields are not claimed content-free or encrypted, and adding the no-throw wrapper does not add a new logging destination."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:17",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.12",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/server/src/app.ts#log_emitter:89b81c36ea23316a:18",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.13",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/direct-browser-harness.ts#subprocess_processor:9a6fb70d84c0a3ae:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.14",
    "reason": "The exact agent-browser CLI harness is a server-side plaintext Website processor. Its stdout/stderr can contain authenticated page/tool content; closed argv, scoped private directories and sanitization do not make it Human Domain encryption. This is an explicit provider processing boundary, not a content-free subprocess exclusion."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/direct-browser-router.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.15",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-direct-production.ts#temporary_storage:d8df3c6437a141c5:1",
    "owner": "packages/server",
    "closure": "reviewed_exclusion",
    "exclusionId": "exclusion.main-2026-09-05.landing.16",
    "reason": "This call only computes an instance-hashed private temporary-root path. It does not create or write a file and contains no Human data. The directory authority and browser process remain separate inventoried boundaries; this exclusion covers path calculation only."
  },
  {
    "locator": "packages/server/src/connected-web-accounts/operation-direct-runtime.ts#log_emitter:a1436e7c26c240df:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.17",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/server/src/lib/memory-review-runtime.ts#log_emitter:8318f61e53b155b0:1",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.18",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/server/src/realtime/ws-publisher.ts#log_emitter:89b81c36ea23316a:3",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.19",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:89b81c36ea23316a:7",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.20",
    "reason": "This exact failed resume diagnostic forwards an exception message into the existing source.log.generic plaintext log boundary. It remains log debt; no content-free exclusion or claim of encrypted error messages is made."
  },
  {
    "locator": "packages/server/src/routes/auth.ts#log_emitter:89b81c36ea23316a:8",
    "owner": "packages/server",
    "closure": "declaration",
    "declarationId": "source.main-2026-09-05.landing.21",
    "reason": "This exact diagnostic emits a fixed lifecycle label, control/event kind, opaque routing ID, reason code or attempt observation through the existing plaintext logging boundary. It adds no new retained log destination and is not counted as protected Human content. Generic log debt remains explicit."
  }
];
