/** Sanitized reproduction of the failed 49,152-token Harbor qualification.
 * Its immutable prompt consumed about12k message tokens and tool schemas left
 *20,388 message tokens. Recovery must work with that real prompt-to-work ratio,
 * not only a tiny SystemMessage fixture. No captured application data is used. */
import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { estimateTokenCount } from "../../src/utils/history-manager";
import { budgetResearchContext, currentResearchContextRecovery, researchContextRecoveryToolError } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";

const MESSAGE_ALLOWANCE = 20_388;
const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
function setup() {
  const system = new SystemMessage("Immutable authorized research configuration. ".repeat(1064));
  const calls = ["source-a", "source-b"].map((id) => ({ id, name: "file", args: { command: "read", path: `${id}.ts` } }));
  const messages: BaseMessage[] = [new HumanMessage("Audit every behavior, preserve detailed evidence, and do not change the source."),
    new AIMessage({ id: "ai:source", content: "Trace both caller and worker authority checks.", tool_calls: calls }),
    ...calls.map((call) => new ToolMessage({ id: `tm:${call.id}`, name: "file", tool_call_id: call.id,
      content: JSON.stringify({ content: "Check caller, queued principal, destination, and current membership. ".repeat(530) }) }))];
  const state = { messages, userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId, model: author.modelId,
    subagentRun: true, taskRun: true, toolWhitelist: ["file", "security_scan"], researchContextRecovery: null, researchContextPageBytes: null } as unknown as NautiloState;
  return { state, system };
}
function textContent(message: BaseMessage): string {
  if (typeof message.content !== "string") throw new Error("Expected text-only test message");
  return message.content;
}
function prepare(state: NautiloState, system: SystemMessage) {
  const result = budgetResearchContext(state, [system, ...state.messages], MESSAGE_ALLOWANCE);
  state.researchContextRecovery = result.recovery;
  state.researchContextPageBytes = result.pageBytes;
  return result;
}
function save(state: NautiloState, sequence: number, kind: "evidence" | "checkpoint") {
  const id = `${kind}-${sequence}`;
  const summary = kind === "evidence" ? "Inspected request admission and queued delivery: the actor must remain a member of the target project; verified rejection paths, revocation timing, storage selection, caller scope, and unchanged source evidence. ".repeat(8)
    : `Preserved detailed note ${sequence}; recover the remaining source pages before investigating new files.`;
  const entry = { kind, summary, evidenceRefs: [], ...(kind === "checkpoint" ? { nextWork: "Continue the exact remaining historical input pages; keep the accepted behavioral notes available.", openRecordIds: [] } : {}) };
  state.messages.push(new AIMessage({ id: `ai:${id}`, content: "Save this material analysis before continuing.", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry } }] }),
    new ToolMessage({ id: `tm:${id}`, tool_call_id: id, name: "security_scan", content: JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: {
      id: `record_${id}`, revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", createdBy: author, updatedBy: author, entry,
    } } }) }));
}
function recursiveReceiptRefs(state: NautiloState) {
  return state.messages.flatMap((message, index) => {
    if (!ToolMessage.isInstance(message) || typeof message.content !== "string") return [];
    let value: unknown;
    try { value = JSON.parse(message.content); } catch { return []; }
    if (typeof value !== "object" || value === null || !("operation" in value) || value.operation !== "context") return [];
    const ref = describeResearchContextMessage(state, index)?.ref;
    return ref && state.researchContextRecovery?.pendingRefs.includes(ref) ? [ref] : [];
  });
}

test("a production-sized immutable prefix cannot turn a returned page into mandatory escaped context-of-context", () => {
  const { state, system } = setup();
  const originalSources = state.messages.slice(2).map((message) => message.content);
  const protectedTokens = estimateTokenCount([system, state.messages[0]!]);
  expect(protectedTokens).toBeGreaterThan(11_500);
  expect(protectedTokens).toBeLessThan(12_500);
  let budgeted = prepare(state, system);
  expect(budgeted.recovery).not.toBeNull();
  const cursors = new Map<string, string>();
  const recovered = new Map<string, string>();
  const originalRefs = state.messages.slice(2).map((_, offset) => describeResearchContextMessage(state, offset + 2)!.ref);
  for (let turn = 0; turn < 20 && currentResearchContextRecovery(state); turn++) {
    const pending = currentResearchContextRecovery(state)!.pendingRefs;
    if (pending.length === 0) { save(state, turn, "checkpoint"); budgeted = prepare(state, system); continue; }
    const ref = pending[0]!;
    const args = { version: "security-scan-v1", operation: "context", contextRef: ref, ...(cursors.has(ref) ? { contextCursor: cursors.get(ref)! } : {}) };
    const page = readResearchContext(state, args, { maxPageBytes: budgeted.pageBytes });
    if (!page.ok) throw new Error(`Page ${turn}: ${page.error.message}`);
    const id = `context-${turn}`;
    state.messages.push(new AIMessage({ id: `ai:${id}`, content: "Read and analyze the next exact source page.", tool_calls: [{ id, name: "security_scan", args }] }),
      new ToolMessage({ id: `tm:${id}`, name: "security_scan", tool_call_id: id, content: JSON.stringify(page) }));
    const newest = state.messages.at(-1)!;
    recovered.set(ref, (recovered.get(ref) ?? "") + page.result.text);
    if (page.result.nextCursor) cursors.set(ref, page.result.nextCursor); else cursors.delete(ref);
    budgeted = prepare(state, system);
    expect(estimateTokenCount(budgeted.messages)).toBeLessThanOrEqual(MESSAGE_ALLOWANCE);
    expect({ newestPageVisible: budgeted.messages.find((message) => message.id === newest.id)?.content === newest.content,
      mandatoryRecursiveRefs: recursiveReceiptRefs(state) }).toEqual({ newestPageVisible: true, mandatoryRecursiveRefs: [] });
    save(state, turn, "evidence");
    save(state, turn, "checkpoint");
    budgeted = prepare(state, system);
    expect(recursiveReceiptRefs(state)).toEqual([]);
  }
  expect(currentResearchContextRecovery(state)).toBeNull();
  expect(researchContextRecoveryToolError(state, "file", { command: "read", path: "next-behavior.ts" })).toBeNull();
  for (const [index, ref] of originalRefs.entries()) {
    const expected = serializeResearchContextMessage(state.messages[index + 2]!);
    if (expected === null) throw new Error("Expected a visible source message");
    expect(recovered.get(ref)).toBe(expected);
  }
  expect(state.messages.slice(2, 4).map((message) => message.content)).toEqual(originalSources);
});

test("a blocked new investigation preserves the unconsolidated page and cursor through the correction turn", () => {
  const { state, system } = setup();
  let budgeted = prepare(state, system);
  const ref = budgeted.recovery!.pendingRefs[0]!;
  const args = { version: "security-scan-v1", operation: "context", contextRef: ref };
  const page = readResearchContext(state, args, { maxPageBytes: budgeted.pageBytes });
  if (!page.ok || !page.result.nextCursor) throw new Error("Expected a partial source page");
  state.messages.push(new AIMessage({ id: "ai:first-page", content: "Recover the source.", tool_calls: [{ id: "first-page", name: "security_scan", args }] }),
    new ToolMessage({ id: "tm:first-page", name: "security_scan", tool_call_id: "first-page", content: JSON.stringify(page) }));
  const pageIndex = state.messages.length - 1;
  const pageMessage = state.messages[pageIndex]!;
  budgeted = prepare(state, system);
  expect(budgeted.messages.find((message) => message.id === pageMessage.id)?.content).toBe(pageMessage.content);
  const nextArgs = { ...args, contextCursor: page.result.nextCursor };
  for (let retry = 0; retry < 3; retry++) {
    const investigation = { command: "read", path: "new-investigation.js", zone: "current" };
    const error = researchContextRecoveryToolError(state, "file", investigation);
    expect(error).toContain("Context recovery is active");
    const id = `premature-page-${retry}`;
    state.messages.push(new AIMessage({ id: `ai:${id}`, content: retry === 2 ? "Uncheckpointed analysis of the source and the rejected next page. ".repeat(1500) : "Continue the next page.", tool_calls: [{ id, name: "file", args: investigation }] }),
      new ToolMessage({ id: `tm:${id}`, name: "file", tool_call_id: id, status: "error", content: error! }));
    budgeted = prepare(state, system);
    expect(estimateTokenCount(budgeted.messages)).toBeLessThanOrEqual(MESSAGE_ALLOWANCE);
    expect(budgeted.messages.find((message) => message.id === pageMessage.id)?.content).toBe(pageMessage.content);
    expect(budgeted.recovery?.unpresentedReadIndices ?? []).not.toContain(pageIndex);
    expect(budgeted.messages.some((message) => message.id === "ai:first-page")).toBe(true);
    const prompt = textContent(budgeted.messages[0]!);
    expect(prompt).toContain(JSON.stringify(page.result.nextCursor));
    expect(prompt).toContain('"continueContext":true');
    expect(recursiveReceiptRefs(state)).toEqual([]);
    if (retry === 2) {
      const correctionIndex = state.messages.length - 2;
      const correctionRef = describeResearchContextMessage(state, correctionIndex)!.ref;
      const projectedCorrection = budgeted.messages.find((message) => message.id === `ai:${id}`);
      expect(projectedCorrection).toBeDefined();
      expect(textContent(projectedCorrection!)).toContain("researchAssistantProjection");
      expect(textContent(projectedCorrection!)).toContain(correctionRef);
      expect(textContent(projectedCorrection!)).not.toContain("Uncheckpointed analysis of the source");
      expect(budgeted.messages.some((message) => ToolMessage.isInstance(message) && message.tool_call_id === id)).toBe(true);
      expect(budgeted.recovery!.pendingRefs).toContain(correctionRef);
      expect(textContent(state.messages[correctionIndex]!).length).toBeGreaterThan(90_000);
    }
  }
  save(state, 101, "evidence");
  save(state, 101, "checkpoint");
  budgeted = prepare(state, system);
  expect(researchContextRecoveryToolError(state, "security_scan", nextArgs)).toBeNull();
  expect(textContent(budgeted.messages[0]!)).toContain('"requiredAction":"read"');
  expect(textContent(budgeted.messages[0]!)).toContain(JSON.stringify(page.result.nextCursor));
  const nextPage = readResearchContext(state, nextArgs, { maxPageBytes: budgeted.pageBytes });
  if (!nextPage.ok) throw new Error(nextPage.error.message);
  expect(nextPage.result.startByte).toBe(page.result.endByte);
  expect(state.messages[pageIndex]!.content).toBe(pageMessage.content);
});
