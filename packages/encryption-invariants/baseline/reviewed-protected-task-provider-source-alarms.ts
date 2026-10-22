import type { SourceAlarmReview } from "../src/node/source-alarm-review";

export const SUPERSEDED_PROTECTED_TASK_PROVIDER_SOURCE_ALARM_LOCATORS =
  new Set<string>([
    "packages/agent/src/subagents/deep-research/agent/graph.ts#log_emitter:89b81c36ea23316a:1",
    "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:89b81c36ea23316a:1",
    "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:89b81c36ea23316a:2",
    "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:89b81c36ea23316a:3",
    "packages/agent/src/subagents/deep-research/supervisor/graph.ts#log_emitter:89b81c36ea23316a:1",
    "packages/agent/src/tools/research/run-deep-research.ts#log_emitter:89b81c36ea23316a:1",
    "packages/agent/src/tools/research/run-deep-research.ts#log_emitter:89b81c36ea23316a:2",
    "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:7ef703451e44cded:1",
    "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:7ef703451e44cded:2",
    "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:89b81c36ea23316a:1",
  ]);

const PROTECTED_TASK_PROVIDER_DIAGNOSTIC_REASON =
  "This diagnostic remains available to the ordinary Deep Research path. The protected Task path supplies the trusted confidential execution option and suppresses the call before any prompt, research text, provider response, or provider error can reach the plaintext logger.";

export const REVIEWED_PROTECTED_TASK_PROVIDER_SOURCE_ALARMS:
  readonly SourceAlarmReview[] = [
  {
    locator: "packages/agent/src/subagents/deep-research/agent/graph.ts#log_emitter:bcd60f5a215dc1be:1",
    owner: "packages/agent",
    closure: "declaration",
    declarationId: "source.protected-task-provider.final-report-ordinary-diagnostic",
    reason: PROTECTED_TASK_PROVIDER_DIAGNOSTIC_REASON,
  },
  {
    locator: "packages/agent/src/subagents/deep-research/supervisor/graph.ts#log_emitter:bcd60f5a215dc1be:1",
    owner: "packages/agent",
    closure: "declaration",
    declarationId: "source.protected-task-provider.supervisor-ordinary-diagnostic",
    reason: PROTECTED_TASK_PROVIDER_DIAGNOSTIC_REASON,
  },
  {
    locator: "packages/agent/src/tools/research/run-deep-research.ts#log_emitter:4f55a0bfa6cd3723:1",
    owner: "packages/agent",
    closure: "declaration",
    declarationId: "source.protected-task-provider.admission-ordinary-diagnostic",
    reason: PROTECTED_TASK_PROVIDER_DIAGNOSTIC_REASON,
  },
  {
    locator: "packages/agent/src/tools/research/run-deep-research.ts#log_emitter:4f55a0bfa6cd3723:2",
    owner: "packages/agent",
    closure: "declaration",
    declarationId: "source.protected-task-provider.creation-ordinary-diagnostic",
    reason: PROTECTED_TASK_PROVIDER_DIAGNOSTIC_REASON,
  },
  {
    locator: "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:640dbd0bc90f7938:1",
    owner: "packages/runtime",
    closure: "declaration",
    declarationId: "source.protected-task-provider.start-ordinary-diagnostic",
    reason: PROTECTED_TASK_PROVIDER_DIAGNOSTIC_REASON,
  },
  {
    locator: "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:640dbd0bc90f7938:2",
    owner: "packages/runtime",
    closure: "declaration",
    declarationId: "source.protected-task-provider.completion-ordinary-diagnostic",
    reason: PROTECTED_TASK_PROVIDER_DIAGNOSTIC_REASON,
  },
  {
    locator: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:1",
    debtId: "debt.source-alarm.log.log_emitter.b35e4880879540d8",
    surface: "log",
    owner: "packages/agent",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:1 remains a reviewed log-emitter alarm because Protected Task execution suppresses it while its ordinary-path dynamic provider error payload remains untriaged.",
    evidenceGap: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:1 lacks log-emitter alarm evidence classifying every possible provider error field and redaction boundary on the ordinary path.",
  },
  {
    locator: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:2",
    debtId: "debt.source-alarm.log.log_emitter.6de0f35e723413fa",
    surface: "log",
    owner: "packages/agent",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:2 remains a reviewed log-emitter alarm because Protected Task execution suppresses it while its ordinary-path dynamic provider error payload remains untriaged.",
    evidenceGap: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:2 lacks log-emitter alarm evidence classifying every possible provider error field and redaction boundary on the ordinary path.",
  },
  {
    locator: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:3",
    debtId: "debt.source-alarm.log.log_emitter.dfa319d75e6e0bd8",
    surface: "log",
    owner: "packages/agent",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:3 remains a reviewed log-emitter alarm because Protected Task execution suppresses it while its ordinary-path dynamic provider error payload remains untriaged.",
    evidenceGap: "packages/agent/src/subagents/deep-research/researcher/graph.ts#log_emitter:bcd60f5a215dc1be:3 lacks log-emitter alarm evidence classifying every possible provider error field and redaction boundary on the ordinary path.",
  },
  {
    locator: "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:3b18901f24fcfb64:1",
    debtId: "debt.source-alarm.log.log_emitter.396e32d68cda57b5",
    surface: "log",
    owner: "packages/runtime",
    closure: "baseline_debt",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    reason: "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:3b18901f24fcfb64:1 remains a reviewed log-emitter alarm because Protected Task execution suppresses it while its ordinary-path dynamic provider error payload remains untriaged.",
    evidenceGap: "packages/runtime/src/executors/deep-research-executor.ts#log_emitter:3b18901f24fcfb64:1 lacks log-emitter alarm evidence classifying every possible provider error field and redaction boundary on the ordinary path.",
  },
] as const;
