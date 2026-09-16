import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { applyToolResultsToStreaks, buildNoProgressKey, normalizeToolError, type NoProgressStreaks, type NoProgressToolResult } from "../../src/graph/no-progress";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext } from "../../src/tools/security/research-context";
import { researchContextRecoveryToolError, researchRuntimeRecoveryFacts } from "../../src/tools/security/research-context-rollover";

const args = { version: "security-scan-v1", operation: "context", continueContext: true };
const error = (index: number, pending: number): NoProgressToolResult => ({ toolName: "security_scan", args, status: "error",
  errorContent: JSON.stringify({ ok: false, operation: "context", runtimeRecovery: {
    phase: "consolidation_required", pendingInputCount: pending, recoveredInputBytes: 32946,
    retainedUnconsolidatedPages: 9, asOfMessageIndex: index, nextContextRef: "research-context:6:unchanged",
  }, error: { code: "context_recovery_pending", message: "Recovered 32946 verified historical bytes. Save useful notes and a cumulative checkpoint before another page.", retryable: false } }),
});

test("growing recovery counters and timestamps cannot bypass the correction and stop for an unchanged failure", () => {
  let streaks: NoProgressStreaks = new Map();
  const actions: string[] = [];
  for (let index = 0; index < 20; index++) {
    const result = applyToolResultsToStreaks(streaks, [error(96 + index * 2, 17 + index)], 3);
    streaks = result.streaks;
    actions.push(result.action.kind);
  }
  expect(actions.slice(0, 4)).toEqual(["continue", "continue", "inject_corrective", "stop_no_progress"]);
  expect(actions.slice(4).every((action) => action === "stop_no_progress")).toBe(true);
  expect(streaks.size).toBe(1);
  expect([...streaks.values()][0]).toEqual({ count: 20, correctiveTurnIssued: true });
  expect(buildNoProgressKey(error(96, 17))).toEqual(buildNoProgressKey(error(134, 36)));
  expect(buildNoProgressKey(error(96, 17)).operationDiscriminator).toBe("context");
});

test("a successful status lookup does not erase the separate context failure streak", () => {
  let streaks: NoProgressStreaks = new Map();
  for (let index = 0; index < 3; index++) {
    streaks = applyToolResultsToStreaks(streaks, [error(index, 17)], 3).streaks;
    streaks = applyToolResultsToStreaks(streaks, [{ toolName: "security_scan", args: { operation: "status" }, status: "success" }], 3).streaks;
  }
  expect(applyToolResultsToStreaks(streaks, [error(9, 17)], 3).action.kind).toBe("stop_no_progress");
});

test("verified new historical bytes reset a context failure while duplicate pages do not manufacture progress", () => {
  const state = { userId: "owner", currentTaskId: "task", currentTaskRunId: "run", subagentRun: true, toolWhitelist: ["file", "security_scan"], messages: [
    new HumanMessage("Audit source"), new AIMessage({ id: "call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "source.js" } }] }),
    new ToolMessage({ id: "source-result", name: "file", tool_call_id: "source", status: "success", content: "substantive source\n".repeat(1000) }),
  ] } as unknown as NautiloState;
  state.researchContextRecovery = { taskRunId: "run", throughIndex: 2, indexRef: describeResearchContextIndex(state, 2)!.ref,
    pendingRefs: [describeResearchContextMessage(state, 2)!.ref], consolidationRequired: true };
  const failure = (): NoProgressToolResult => ({ toolName: "security_scan", args, status: "error", errorContent: JSON.stringify({
    ok: false, operation: "context", runtimeRecovery: researchRuntimeRecoveryFacts(state),
    error: { code: "context_recovery_pending", message: researchContextRecoveryToolError(state, "security_scan", args)!, retryable: false },
  }) });
  const before = failure();
  const initial = applyToolResultsToStreaks(new Map(), [before], 3);
  const selection = { version: "security-scan-v1", operation: "context", contextRef: state.researchContextRecovery.pendingRefs[0]!, contextBytes: 200 };
  const page = readResearchContext(state, selection, { maxPageBytes: 2000 });
  if (!page.ok) throw Error(page.error.message);
  const appendPage = (id: string) => state.messages.push(new AIMessage({ content: "", tool_calls: [{ id, name: "security_scan", args: selection }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: id, status: "success", content: JSON.stringify(page) }));
  appendPage("first-page");
  const after = failure();
  expect(buildNoProgressKey(after)).not.toEqual(buildNoProgressKey(before));
  const advanced = applyToolResultsToStreaks(initial.streaks, [after], 3);
  expect([...advanced.streaks.values()][0]?.count).toBe(1);
  appendPage("same-page-again");
  const repeated = failure();
  expect(buildNoProgressKey(repeated)).toEqual(buildNoProgressKey(after));
  expect([...applyToolResultsToStreaks(advanced.streaks, [repeated], 3).streaks.values()][0]?.count).toBe(2);
});

test("only matching validated failures use structured normalization; malformed and foreign errors preserve their diagnostic identity", () => {
  const original = error(96, 17);
  for (const result of [
    { ...original, toolName: "other_tool" },
    { ...original, args: { operation: "results" } },
    { ...original, errorContent: original.errorContent!.slice(0, -1) },
    { ...original, errorContent: JSON.stringify({ ...JSON.parse(original.errorContent!), error: { code: "context_recovery_pending", message: "same", retryable: true } }) },
  ]) expect(buildNoProgressKey(result).normalizedError).toBe(normalizeToolError(result.errorContent));
  const changed = JSON.parse(original.errorContent!) as { error: { code: string; message: string } };
  changed.error.code = "context_reference_stale";
  expect(buildNoProgressKey({ ...original, errorContent: JSON.stringify(changed) })).not.toEqual(buildNoProgressKey(original));
  changed.error.message = "An unchanged task reference is required.";
  expect(buildNoProgressKey({ ...original, errorContent: JSON.stringify(changed) }).normalizedError).toContain("unchanged task reference");
});

test("ordinary validated research errors retain their code and repair instruction without volatile runtime fields", () => {
  const receipt = { ok: false, operation: "results", error: { code: "research_incomplete", retryable: false,
    message: "Accessible research remains incomplete.", continuation: "Resolve the upload boundary hypothesis." } };
  const base: NoProgressToolResult = { toolName: "security_scan", args: { operation: "results" }, status: "error", errorContent: JSON.stringify(receipt) };
  const withSnapshot = { ...base, errorContent: JSON.stringify({ ...receipt, runtimeRecovery: {
    phase: "reading", pendingInputCount: 2, recoveredInputBytes: 100, retainedUnconsolidatedPages: 1, asOfMessageIndex: 30, nextContextRef: null,
  } }) };
  expect(buildNoProgressKey(base)).toEqual(buildNoProgressKey(withSnapshot));
  expect(buildNoProgressKey(base).normalizedError).toContain("research_incomplete");
  expect(buildNoProgressKey(base).normalizedError).toContain("resolve the upload boundary hypothesis");
  const successful = { ...withSnapshot, status: "success" as const };
  const failed = applyToolResultsToStreaks(new Map(), [base]);
  expect(applyToolResultsToStreaks(failed.streaks, [successful]).streaks.size).toBe(0);
});
