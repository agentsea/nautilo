import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { securityScanToolResultSchema } from "@nautilo/types";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext, researchContextRecoveryToolError, researchRuntimeRecoveryFacts } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, describeResearchRecordIndex, readResearchContext, replayResearchContextReceipt } from "../../src/tools/security/research-context";
import { localToolControlFailure } from "../../src/tools/security/research-control-feedback";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
function fixture() {
  const state = { messages: [new HumanMessage("Review the authorized source.")], userId: "owner", currentTaskId: author.taskId,
    currentTaskRunId: author.taskRunId, subagentRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
  const append = (args: Record<string, unknown>, result: unknown, error = false) => {
    const id = `call-${state.messages.length}`;
    state.messages.push(new AIMessage({ id: `ai-${id}`, content: "", tool_calls: [{ id, name: "security_scan", args }] }),
      new ToolMessage({ id: `tm-${id}`, name: "security_scan", tool_call_id: id, status: error ? "error" : "success", content: JSON.stringify(result) }));
  };
  for (let index = 0; index < 10; index++) {
    const entry = { kind: "hypothesis", summary: `Investigate ownership on route ${index}; preserve Unicode 🦀 and exact saved notes.`,
      state: "investigating", evidenceRefs: [], counterevidenceRefs: [] };
    const result = { ok: true, operation: "record", result: { codeEvidence: [], record: { id: `record-${index}`, revision: 1, entry,
      createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" } } };
    securityScanToolResultSchema.parse(result);
    append({ version: "security-scan-v1", operation: "record", action: "append", entry }, result);
  }
  const contextRef = describeResearchRecordIndex(state, state.messages.length - 1)!.ref;
  const args = { version: "security-scan-v1", operation: "context", contextRef, recordKinds: ["review_unit" as const, "finding" as const, "hypothesis" as const], contextBytes: 100 };
  const first = readResearchContext(state, args, { maxPageBytes: 2000, runtimeRecovery: researchRuntimeRecoveryFacts(state) });
  if (!first.ok || first.result.complete) throw Error("Expected a real partial filtered navigation page");
  append(args, first);
  const prepared: BaseMessage[] = [new SystemMessage("Policy ".repeat(4000)), state.messages[0]!, ...state.messages.slice(-2)];
  const next = { ...args, contextCursor: first.result.nextCursor! };
  return { state, prepared, first, next, append };
}
function read(state: NautiloState, result: ReturnType<typeof budgetResearchContext>, args: Record<string, unknown>) {
  const current = { ...state, researchContextRecovery: result.recovery };
  return readResearchContext(current, args, { maxPageBytes: result.pageBytes, runtimeRecovery: researchRuntimeRecoveryFacts(current) });
}
function nextCycle(args: Record<string, unknown>, value: unknown): BaseMessage[] {
  return [new AIMessage({ content: "", tool_calls: [{ id: "next", name: "security_scan", args }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "next", content: JSON.stringify(value) })];
}

test("filtered navigation charges its whole continuation frame before dividing payload and notes space", () => {
  const { state, prepared, first, next } = fixture();
  const canonical = JSON.stringify(state.messages);
  const roomy = budgetResearchContext(state, prepared, 12000);
  const budget = estimateTokenCount(roomy.messages) + 382;
  const result = budgetResearchContext(state, prepared, budget);
  // The former half-allocation is only 764 bytes, smaller than the exact frame.
  const old = readResearchContext(state, next, { maxPageBytes: 764, runtimeRecovery: researchRuntimeRecoveryFacts(state) });
  expect(old).toMatchObject({ ok: false, error: { code: "context_budget_unavailable" } });
  const page = read(state, result, next);
  expect(page.ok).toBe(true);
  if (!page.ok) throw Error(page.error.message);
  expect(page.result.startByte).toBe(first.result.endByte);
  expect(page.result.endByte).toBeGreaterThan(page.result.startByte);
  expect(page.result.resolvedSelection).toEqual({ contextRef: next.contextRef, contextCursor: next.contextCursor, contextBytes: next.contextBytes, recordKinds: next.recordKinds });
  expect(replayResearchContextReceipt(state, next, page)).toEqual(page);
  // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- Append the fresh next-call pair once to measure the complete following request.
  expect(estimateTokenCount([...result.messages, ...nextCycle(next, page)])).toBeLessThanOrEqual(budget);
  expect(result.recovery).toBeNull();
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("insufficient navigation slack uses ordinary projection without requiring navigation consolidation", () => {
  const { state, prepared, first, next } = fixture();
  const canonical = JSON.stringify(state.messages);
  const roomy = budgetResearchContext(state, prepared, 12000);
  const budget = estimateTokenCount(roomy.messages) + 50;
  const result = budgetResearchContext(state, prepared, budget);
  const page = read(state, result, next);
  expect(page.ok).toBe(true);
  if (!page.ok) throw Error(page.error.message);
  expect(estimateTokenCount(result.messages)).toBeLessThan(estimateTokenCount(roomy.messages));
  // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- Append the fresh next-call pair once to measure the complete following request.
  expect(estimateTokenCount([...result.messages, ...nextCycle(next, page)])).toBeLessThanOrEqual(budget);
  expect(page.result.startByte).toBe(first.result.endByte);
  expect(result.recovery).toBeNull();
  expect(JSON.stringify(state.messages)).toBe(canonical);
  const retry = budgetResearchContext(state, result.messages, budget);
  expect(read(state, retry, next).ok).toBe(true);
  expect(retry.recovery).toBeNull();
});

test("navigation reservation preserves substantive pending input and never rehydrates protected page bodies", () => {
  const { state, prepared, next } = fixture();
  const lastCycle = state.messages.splice(-2);
  const id = `failed-${state.messages.length}`;
  const args = { version: "security-scan-v1", operation: "record", entry: { kind: "evidence", summary: "Unsaved material observation. ".repeat(200), evidenceRefs: [] } };
  state.messages.push(new AIMessage({ id: "draft-ai", content: "Keep the exact rejected draft.", tool_calls: [{ id, name: "security_scan", args }] }),
    new ToolMessage({ id: "draft-error", tool_call_id: id, name: "security_scan", status: "error", content: localToolControlFailure("security_scan", args, "invalid_request", "Choose append or update before saving this draft.") }), ...lastCycle);
  const draftRef = describeResearchContextMessage(state, state.messages.length - 4)!.ref;
  const index = describeResearchContextIndex(state, state.messages.length - 1)!;
  state.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex: state.messages.length - 1, indexRef: index.ref, pendingRefs: [draftRef], consolidationRequired: false };
  const canonical = JSON.stringify(state.messages);
  const original = prepared.at(-1) as ToolMessage;
  const protectedPage = new ToolMessage({ ...original, content: "Protected navigation display." });
  const safe = [...prepared.slice(0, -1), protectedPage];
  const result = budgetResearchContext(state, safe, 8500);
  expect(result.recovery?.pendingRefs).toContain(draftRef);
  expect(result.recovery?.pendingRefs).not.toContain(next.contextRef);
  expect(result.messages.some((message) => message.id === protectedPage.id && message.content === original.content)).toBe(false);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(8500);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("complete and foreign navigation selections do not acquire reservations", () => {
  const { state, prepared, next, append } = fixture();
  const full = readResearchContext(state, { ...next, contextBytes: undefined }, { maxPageBytes: 100000 });
  if (!full.ok || !full.result.complete) throw Error("Expected complete navigation fixture");
  append({ ...next, contextBytes: undefined }, full);
  const complete = [prepared[0]!, state.messages[0]!, ...state.messages.slice(-2)];
  const result = budgetResearchContext(state, complete, 12000);
  expect(result.pageBytes).toBe(Math.floor(Math.max(0, 12000 - estimateTokenCount(result.messages)) / 2) * 4);
  const foreign = { ...state, currentTaskRunId: "33333333-3333-4333-8333-333333333333" };
  const denied = readResearchContext(foreign, next, { maxPageBytes: 100000 });
  expect(denied).toMatchObject({ ok: false, error: { code: "context_reference_stale" } });
});


test("the latest error-status continuation is retried with its exact cursor and filters", () => {
  const { state, prepared, next, append } = fixture();
  const args = { ...next, contextBytes: 300 };
  const error = readResearchContext(state, args, { maxPageBytes: 764, runtimeRecovery: researchRuntimeRecoveryFacts(state) });
  expect(error).toMatchObject({ ok: false, error: { code: "context_budget_unavailable" } });
  append(args, error, true);
  const failed = state.messages.at(-1)!;
  // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- Append only the newly created failed-call pair, absent from the earlier prepared fixture.
  const safe = [...prepared, ...state.messages.slice(-2)];
  const canonical = JSON.stringify(state.messages);
  const roomy = budgetResearchContext(state, safe, 12000);
  const budget = estimateTokenCount(roomy.messages) + 382;
  const result = budgetResearchContext(state, safe, budget);
  const call = new AIMessage({ content: "", tool_calls: [{ id: "next", name: "security_scan", args }] });
  const current = { ...state, messages: [...state.messages, call], researchContextRecovery: result.recovery };
  const page = readResearchContext(current, args, { maxPageBytes: result.pageBytes, runtimeRecovery: researchRuntimeRecoveryFacts(current) });
  expect(page.ok).toBe(true);
  if (!page.ok) throw Error(page.error.message);
  expect(page.result.resolvedSelection).toEqual({ contextRef: args.contextRef, contextCursor: args.contextCursor, contextBytes: args.contextBytes, recordKinds: args.recordKinds });
  expect(result.messages.some((message) => message.id === failed.id && ToolMessage.isInstance(message) && message.status === "error")).toBe(true);
  expect(replayResearchContextReceipt(current, args, page)).toEqual(page);
  // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- Append one distinct simulated next-call pair to verify its complete request budget.
  expect(estimateTokenCount([...result.messages, ...nextCycle(args, page)])).toBeLessThanOrEqual(budget);
  expect(result.recovery).toBeNull();
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("the reader's next-assistant as-of index is included at a decimal digit boundary", () => {
  const { state, prepared, next, append } = fixture();
  const args = { ...next, contextBytes: 1 };
  append(args, readResearchContext(state, args, { maxPageBytes: 1, runtimeRecovery: researchRuntimeRecoveryFacts(state) }), true);
  // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- Append only the newly created failed-call pair, absent from the earlier prepared fixture.
  const safe = [...prepared, ...state.messages.slice(-2)];
  // Empty historical messages change only the real canonical index. The exact
  // saved-record boundary and its original selector remain unchanged.
  state.messages.splice(state.messages.length - 2, 0, ...Array.from({ length: 100 - state.messages.length }, () => new HumanMessage("")));
  const canonical = JSON.stringify(state.messages);
  const roomy = budgetResearchContext(state, safe, 12000);
  // This fixture leaves only one byte beyond the old minimum envelope after
  // ordinary projection. The next caller moves asOfMessageIndex from 99 to 100.
  const budget = estimateTokenCount(roomy.messages) + 23;
  const result = budgetResearchContext(state, safe, budget);
  const call = new AIMessage({ content: "", tool_calls: [{ id: "next", name: "security_scan", args }] });
  const current = { ...state, researchContextRecovery: result.recovery };
  const reading = { ...current, messages: [...current.messages, call] };
  expect(researchRuntimeRecoveryFacts(current).asOfMessageIndex).toBe(99);
  expect(researchRuntimeRecoveryFacts(reading).asOfMessageIndex).toBe(100);
  const oldFrame = readResearchContext(current, args, { maxPageBytes: budget * 4, runtimeRecovery: researchRuntimeRecoveryFacts(current) });
  if (!oldFrame.ok) throw Error(oldFrame.error.message);
  const oldBytes = Buffer.byteLength(JSON.stringify(oldFrame), "utf8");
  expect(readResearchContext(reading, args, { maxPageBytes: oldBytes, runtimeRecovery: researchRuntimeRecoveryFacts(reading) }))
    .toMatchObject({ ok: false, error: { code: "context_budget_unavailable" } });
  const page = readResearchContext(reading, args, { maxPageBytes: result.pageBytes, runtimeRecovery: researchRuntimeRecoveryFacts(reading) });
  expect(page.ok).toBe(true);
  if (!page.ok) throw Error(page.error.message);
  expect(page.result.endByte - page.result.startByte).toBe(1);
  expect(page.result.resolvedSelection?.contextCursor).toBe(args.contextCursor);
  // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- Measure the real future caller and its one-byte receipt as a single new pair.
  expect(estimateTokenCount([...result.messages, ...nextCycle(args, page)])).toBeLessThanOrEqual(budget);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});

test("new source pressure preserves its consolidation workspace when optional navigation needs more room", () => {
  const { state, prepared, next, append } = fixture();
  const navigationCycle = state.messages.splice(-2);
  state.messages.push(new AIMessage({ id: "source-ai", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "identity/tokens.js", zone: "current" } }] }),
    new ToolMessage({ id: "source-tool", name: "file", tool_call_id: "source", content: "Exact material source. ".repeat(500), status: "success" }));
  const contextRef = describeResearchContextMessage(state, state.messages.length - 1)!.ref;
  const source = { version: "security-scan-v1", operation: "context", contextRef };
  append(source, readResearchContext(state, source, { maxPageBytes: 100000 }));
  const start = state.messages.length;
  const entry = { kind: "checkpoint", summary: "Saved prior source review.", nextWork: "Continue chosen source and navigate saved notes.", evidenceRefs: [], openRecordIds: [] };
  const accepted = { ok: true, operation: "record", result: { codeEvidence: [], record: { id: "saved-checkpoint", revision: 1, entry, createdBy: author, updatedBy: author,
    createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" } } };
  securityScanToolResultSchema.parse(accepted);
  append({ version: "security-scan-v1", operation: "record", action: "append", entry }, accepted);
  const sourceRead = { ...source, contextBytes: 200 };
  append(sourceRead, readResearchContext(state, sourceRead, { maxPageBytes: 3000 }));
  const sourcePage = state.messages.at(-1)!;
  state.messages.push(...navigationCycle);
  const canonical = JSON.stringify(state.messages);
  const safe = [prepared[0]!, state.messages[0]!, ...state.messages.slice(start)];
  const roomy = budgetResearchContext(state, safe, 14000);
  const budget = estimateTokenCount(roomy.messages) + 500;
  const result = budgetResearchContext(state, safe, budget);
  expect(state.researchContextRecovery).toBeNull();
  expect(result.recovery).toMatchObject({ pendingRefs: [], consolidationRequired: true });
  expect(result.messages.some((message) => message.id === sourcePage.id && message.content === sourcePage.content)).toBe(true);
  const current = { ...state, researchContextRecovery: result.recovery };
  expect(researchRuntimeRecoveryFacts(current)).toMatchObject({ phase: "consolidation_required", retainedUnconsolidatedPages: 1 });
  expect(researchContextRecoveryToolError(current, "security_scan", sourceRead)).not.toBeNull();
  expect(researchContextRecoveryToolError(current, "security_scan", next)).toBeNull();
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(budget);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});
