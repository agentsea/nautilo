import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { budgetResearchContext, currentResearchContextRecovery } from "../../src/tools/security/research-context-rollover";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext } from "../../src/tools/security/research-context";
import { localToolControlFailure } from "../../src/tools/security/research-control-feedback";
import { estimateTokenCount } from "../../src/utils/history-manager";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openrouter:z-ai/glm-5.3" };
function fixture() {
  const state = { messages: [new HumanMessage("Audit the authorized source."),
    new AIMessage({ id: "source-call", content: "", tool_calls: [{ id: "source", name: "file", args: { command: "read", path: "auth.ts" } }] }),
    new ToolMessage({ id: "source-result", tool_call_id: "source", name: "file", status: "success", content: "Source bytes and unresolved authority boundaries.\n".repeat(1000) })],
    userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId, subagentRun: true,
    toolWhitelist: ["file", "security_scan"], researchContextRecovery: null } as unknown as NautiloState;
  state.researchContextRecovery = { taskRunId: author.taskRunId, throughIndex: 2, indexRef: describeResearchContextIndex(state, 2)!.ref,
    pendingRefs: [describeResearchContextMessage(state, 2)!.ref, describeResearchContextMessage(state, 1)!.ref] };
  const args = { version: "security-scan-v1", operation: "context", contextRef: state.researchContextRecovery.pendingRefs[0], contextBytes: 512 };
  const page = readResearchContext(state, args, { maxPageBytes: 4000 });
  if (!page.ok) throw Error(page.error.code);
  state.messages.push(new AIMessage({ id: "page-call", content: "", tool_calls: [{ id: "page", name: "security_scan", args }] }),
    new ToolMessage({ id: "page-result", tool_call_id: "page", name: "security_scan", status: "success", content: JSON.stringify(page) }));
  state.researchContextRecovery.consolidationRequired = true;
  return state;
}
function save(state: NautiloState, id: string, summary: string, checkpoint = false, mixed = false) {
  const entry = checkpoint ? { kind: "checkpoint", summary, nextWork: "Continue the remaining investigation.", evidenceRefs: [], openRecordIds: [] }
    : { kind: "evidence", summary, evidenceRefs: [] };
  const calls = [{ id: `${id}:record`, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry } }];
  const call = new AIMessage({ id: `${id}-call`, content: "", tool_calls: mixed ? [...calls,
    { id: `${id}:sibling`, name: "file", args: { command: "read", path: "sibling.ts" } }] : calls,
    additional_kwargs: { hostOnlyMarker: "not-provider-data" } });
  const receipt = new ToolMessage({ id: `${id}-result`, tool_call_id: calls[0]!.id, name: "security_scan", status: "success", content: JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: {
    id, revision: 1, entry, createdBy: author, updatedBy: author, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  } } }) });
  state.messages.push(call, receipt);
  if (mixed) state.messages.push(new ToolMessage({ id: `${id}-sibling`, tool_call_id: `${id}:sibling`, name: "file", status: "success", content: "Exact sibling source." }));
  return { call, receipt };
}
function prepared(state: NautiloState, prefix = "Audit source and preserve current notes."): BaseMessage[] {
  return [new SystemMessage(prefix), ...state.messages.map((message) => {
    if (AIMessage.isInstance(message)) return new AIMessage({ id: message.id!, content: message.content, tool_calls: (message.tool_calls ?? []).map((call) => ({ ...call, ...(call.id ? { id: call.id.replaceAll(":", "_") } : {}) })) });
    if (ToolMessage.isInstance(message)) return new ToolMessage({ id: message.id!, content: message.content, name: message.name!, ...(message.status ? { status: message.status } : {}), tool_call_id: message.tool_call_id.replaceAll(":", "_") });
    return message;
  })];
}
function progress(messages: BaseMessage[]) {
  const content = messages[0]!.content as string;
  const line = content.split("\n").find((line) => line.startsWith('{"acceptedWorkSinceCheckpoint":'));
  return line ? (JSON.parse(line) as { acceptedWorkSinceCheckpoint: { acceptedWrites: number; writesOutsideWorkingContext: number; reloadVia: string; notice: string } }).acceptedWorkSinceCheckpoint : undefined;
}

test("reset refills accepted post-checkpoint note batches without changing source recovery or canonical order", () => {
  const state = fixture();
  for (let index = 0; index < 8; index++) save(state, `note_${index}`, `Analysis ${index}: ${"guards and counterexamples; ".repeat(45)}`);
  const canonical = JSON.stringify(state.messages);
  const originalRecovery = currentResearchContextRecovery(state)!;
  const result = budgetResearchContext(state, prepared(state), 4000);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  const calls = result.messages.filter(AIMessage.isInstance).filter((message) => message.id?.startsWith("note_"));
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.map((message) => message.id)).toEqual([...calls.map((message) => message.id)].sort());
  expect(calls.at(-1)!.tool_calls![0]!.args["entry"]).toEqual((state.messages.at(-2) as AIMessage).tool_calls![0]!.args["entry"]);
  expect(result.recovery?.pendingRefs).toEqual(originalRecovery.pendingRefs);
  expect(result.recovery?.unpresentedReadIndices ?? []).toEqual([]);
  expect(result.messages.some((message) => message.id === "page-result")).toBe(true);
  expect(progress(result.messages)).toMatchObject({ acceptedWrites: 8, reloadVia: "savedRecordIndex" });
  expect(progress(result.messages)!.writesOutsideWorkingContext).toBe(8 - calls.length);
  expect(JSON.stringify(result.messages)).not.toContain("not-provider-data");
  expect(JSON.stringify(state.messages)).toBe(canonical);
  for (const call of calls) {
    const receipts = result.messages.filter(ToolMessage.isInstance).filter((message) => message.tool_call_id === call.tool_calls![0]!.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.status).toBe("success");
  }
});

test("oversized saved bodies use constant-shape working-progress disclosure and existing exact retrieval", () => {
  const state = fixture();
  const note = save(state, "large_note", "Complete analysis without truncation.\n".repeat(2000));
  const before = JSON.stringify(state.messages);
  const result = budgetResearchContext(state, prepared(state), 2400);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(2400);
  expect(progress(result.messages)).toMatchObject({ acceptedWrites: 1, writesOutsideWorkingContext: 1, reloadVia: "savedRecordIndex" });
  expect(progress(result.messages)!.notice).toContain("omitted write arguments");
  expect(result.recovery?.pendingRefs).toEqual(state.researchContextRecovery!.pendingRefs);
  const content = result.messages[0]!.content as string;
  const continuity = content.split("\n").find((line) => line.startsWith('{"savedRecordIndex":'))!;
  const locator = (JSON.parse(continuity) as { savedRecordIndex: Record<string, unknown> }).savedRecordIndex;
  const { tool: _tool, ...selection } = locator;
  const page = readResearchContext(state, { ...selection, recordKinds: ["evidence"] }, { maxPageBytes: 4000 });
  expect(page.ok).toBe(true);
  expect(page.ok && page.result.text).toContain("large_note");
  expect(describeResearchContextMessage(state, state.messages.indexOf(note.receipt))).not.toBeNull();
  expect(JSON.stringify(state.messages)).toBe(before);
  save(state, "consolidated", "The useful notes are saved; continue with the remaining source.", true);
  const consolidated = budgetResearchContext(state, prepared(state), 4000);
  expect(progress(consolidated.messages)).toBeUndefined();
});

test("refill preserves a whole normalized mixed batch and an unmapped sibling exactly once", () => {
  const state = fixture();
  save(state, "mixed", "Accepted mixed-batch note.", false, true);
  save(state, "next", "Next accepted note.");
  const input = prepared(state);
  const sibling = input.findIndex((message) => message.id === "mixed-sibling");
  input[sibling] = new ToolMessage({ id: "unmapped-sibling", tool_call_id: "mixed_sibling", name: "file", status: "success", content: "Unmapped but exact provider sibling." });
  const result = budgetResearchContext(state, input, 4000);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  const ai = result.messages.filter(AIMessage.isInstance).filter((message) => message.id === "mixed-call");
  expect(ai).toHaveLength(1);
  expect(ai[0]!.tool_calls!.map((call) => call.id)).toEqual(["mixed_record", "mixed_sibling"]);
  for (const id of ["mixed_record", "mixed_sibling"]) expect(result.messages.filter(ToolMessage.isInstance).filter((message) => message.tool_call_id === id)).toHaveLength(1);
  expect(result.messages.some((message) => message.content === "Unmapped but exact provider sibling.")).toBe(true);
  expect(JSON.stringify(result.messages)).not.toContain("not-provider-data");
});


test("working-progress counts exact accepted arguments even when mixed-batch prose is projected", () => {
  for (const oversizedArguments of [false, true]) {
    const state = fixture();
    const note = save(state, "accepted", oversizedArguments ? "Detailed accepted analysis. ".repeat(3000) : "Accepted source analysis.");
    const rejectedArgs = { version: "security-scan-v1", operation: "record", action: "append", entry: { kind: "evidence", summary: "Unaccepted sibling draft.", evidenceRefs: [] } };
    const callIndex = state.messages.indexOf(note.call);
    state.messages[callIndex] = new AIMessage({ id: "accepted-call", content: "Additional unsaved assistant analysis. ".repeat(3000),
      tool_calls: [...note.call.tool_calls!, { id: "rejected:record", name: "security_scan", args: rejectedArgs }] });
    state.messages.push(new ToolMessage({ id: "rejected-result", tool_call_id: "rejected:record", name: "security_scan", status: "error",
      content: localToolControlFailure("security_scan", rejectedArgs, "invalid_request", "Correct the rejected entry.") }));
    const canonical = JSON.stringify(state.messages);
    const result = budgetResearchContext(state, prepared(state), 4000);
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
    const call = result.messages.filter(AIMessage.isInstance).find((message) => message.id === "accepted-call")!;
    expect(call.content).not.toBe(state.messages[callIndex].content);
    expect(progress(result.messages)).toMatchObject({ acceptedWrites: 1, writesOutsideWorkingContext: oversizedArguments ? 1 : 0 });
    expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, callIndex)!.ref);
    expect(result.messages.filter(ToolMessage.isInstance).find((message) => message.id === "rejected-result")?.status).toBe("error");
    expect(JSON.stringify(state.messages)).toBe(canonical);
  }
});


test("an unrelated unknown cycle does not create debt for a full retained normalized sibling", () => {
  const state = fixture();
  for (let index = 0; index < 8; index++) save(state, `note_${index}`, "Useful saved notes. ".repeat(100));
  save(state, "mixed", "Accepted mixed note.", false, true);
  const canonical = JSON.stringify(state.messages);
  const input = prepared(state);
  input.push(new AIMessage({ id: "unknown-extra-call", content: "Unmapped current observations.", tool_calls: [{ id: "unknown-extra", name: "file", args: { command: "read", path: "unknown.ts" } }] }),
    new ToolMessage({ id: "unknown-extra-result", tool_call_id: "unknown-extra", name: "file", content: "Unmapped visible result." }));
  const result = budgetResearchContext(state, input, 4000);
  const siblingIndex = state.messages.findIndex((message) => message.id === "mixed-sibling");
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(result.messages.some((message) => message.id === "mixed-sibling" && message.content === "Exact sibling source.")).toBe(true);
  expect(result.recovery?.pendingRefs).not.toContain(describeResearchContextMessage(state, siblingIndex)!.ref);
  expect(result.recovery?.pendingRefs).toEqual(state.researchContextRecovery!.pendingRefs);
  expect(result.recovery?.unpresentedReadIndices ?? []).toEqual([]);
  for (const id of ["mixed-call", "mixed-sibling", "unknown-extra-call", "unknown-extra-result"]) expect(result.messages.filter((message) => message.id === id)).toHaveLength(1);
  expect(JSON.stringify(state.messages)).toBe(canonical);
});
