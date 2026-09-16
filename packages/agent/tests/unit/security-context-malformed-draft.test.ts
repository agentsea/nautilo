import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { localToolControlFailure, outstandingResearchToolErrors } from "../../src/tools/security/research-control-feedback";
import { budgetResearchContext, restoreResearchContextControlCycle } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";
import { estimateTokenCount, windowResearchHistory } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };

test("malformed-operation authored entries survive the first rollover and unrelated accepted checkpoints", () => {
  for (const operation of [undefined, "unknown", "context"]) {
    const args = { ...(operation === undefined ? {} : { operation }), action: "append", entry: {
      kind: "checkpoint", operation: "record", version: "security-scan-v1",
      summary: "Unaccepted source analysis with unresolved alternatives. 🦀\n".repeat(500),
      nextWork: "Inspect the unresolved source boundary.", evidenceRefs: [], openRecordIds: [],
    } };
    const draft = new AIMessage({ id: "draft", content: "", tool_calls: [{ id: "bad", name: "security_scan", args }] });
    const checkpoint = { kind: "checkpoint", summary: "Unrelated accepted notes.", nextWork: "Investigate another behavior.", evidenceRefs: [], openRecordIds: [] };
    const state = { messages: [new HumanMessage("Audit the authorized source."), draft,
      new ToolMessage({ id: "error", name: "security_scan", tool_call_id: "bad", status: "error", content: localToolControlFailure("security_scan", args, "invalid_request", "Correct the root operation and its fields.") }),
      new AIMessage({ id: "checkpoint", content: "", tool_calls: [{ id: "saved", name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry: checkpoint } }] }),
      new ToolMessage({ id: "accepted-checkpoint", name: "security_scan", tool_call_id: "saved", status: "success", content: JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: {
        id: "record_checkpoint", revision: 1, entry: checkpoint, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
      } } }) })], userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId,
      subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
    const before = JSON.stringify(state.messages);
    const descriptor = describeResearchContextMessage(state, 1)!;
    const prepared = restoreResearchContextControlCycle(state, [new SystemMessage("Preserve the source analysis."), ...windowResearchHistory(state.messages, 2000).messages]);
    const result = budgetResearchContext(state, prepared, 2000);
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(2000);
    expect(result.recovery?.pendingRefs).toContain(descriptor.ref);
    expect(JSON.stringify(state.messages)).toBe(before);
    expect(draft.tool_calls![0]!.args).toEqual(args);
    let cursor: string | null = null;
    let text = "";
    do {
      const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref,
        ...(cursor ? { contextCursor: cursor } : {}), contextBytes: 2048 }, { maxPageBytes: 4000 });
      expect(page.ok).toBe(true);
      if (!page.ok) throw Error(page.error.code);
      text += page.result.text;
      cursor = page.result.nextCursor;
    } while (cursor !== null);
    expect(text).toBe(serializeResearchContextMessage(draft)!);
    expect(Buffer.byteLength(text, "utf8")).toBe(descriptor.totalBytes);
    expect(JSON.stringify(state.messages)).toBe(before);
  }
});

test("a successful retry of navigation or status cannot accept a malformed authored entry", () => {
  for (const operation of ["status", "context", "unknown"]) {
    const args = { operation, entry: { summary: "Unaccepted source notes remain distinct from successful navigation." } };
    const messages = [new AIMessage({ id: "draft", content: "", tool_calls: [{ id: "failed", name: "security_scan", args }] }),
      new ToolMessage({ id: "error", name: "security_scan", tool_call_id: "failed", status: "error", content: localToolControlFailure("security_scan", args, "invalid_request", "Correct arguments.") }),
      new AIMessage({ id: "retry", content: "", tool_calls: [{ id: "succeeded", name: "security_scan", args: { operation } }] }),
      new ToolMessage({ id: "result", name: "security_scan", tool_call_id: "succeeded", status: "success", content: JSON.stringify({ ok: true, operation }) })];
    expect(outstandingResearchToolErrors(messages).map((receipt) => receipt.callIndex)).toEqual([0]);
    // Only the caller's existing verified-recovery/consolidation proof may
    // retire this draft; success of another operation establishes no such fact.
    expect(outstandingResearchToolErrors(messages, new Set([0]))).toEqual([]);
  }
});

test("retiring a pressure demand does not retire an authored entry carried by its failed call", () => {
  const args = { operation: "context", continueContext: true, entry: { summary: "Unsaved investigation notes." } };
  const messages = [new AIMessage({ id: "draft", content: "", tool_calls: [{ id: "pressure", name: "security_scan", args }] }),
    new ToolMessage({ id: "pressure-result", name: "security_scan", tool_call_id: "pressure", status: "error", content: localToolControlFailure("security_scan", args, "context_recovery_pending", "Consolidation required.", {
      phase: "consolidation_required", pendingInputCount: 1, recoveredInputBytes: 100, retainedUnconsolidatedPages: 1, asOfMessageIndex: 0, nextContextRef: null,
    }) })];
  const resolvedPressure = new Map([[1, 3]]);
  expect(outstandingResearchToolErrors(messages, new Set(), resolvedPressure).map((receipt) => receipt.callIndex)).toEqual([0]);
  expect(outstandingResearchToolErrors(messages, new Set([0]), resolvedPressure)).toEqual([]);
});
