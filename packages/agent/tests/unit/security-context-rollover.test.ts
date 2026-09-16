import { expect, test } from "bun:test";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { NautiloState } from "../../src/agent/state";
import { estimateTokenCount } from "../../src/utils/history-manager";
import { describeResearchContextMessage, readResearchContext } from "../../src/tools/security/research-context";
import { budgetResearchContext, currentResearchContextRecovery, remainingResearchContextRefs, researchContextRecoveryToolError } from "../../src/tools/security/research-context-rollover";

const author = { taskId: "11111111-1111-4111-8111-111111111111", taskRunId: "22222222-2222-4222-8222-222222222222", modelId: "openai:gpt-5.6-sol" };
let sequence = 0;
function checkpoint(state: NautiloState, summary = "Saved inspected behavior, counterevidence and next work.") {
  const id = `checkpoint-${sequence++}`;
  const entry = { kind: "checkpoint", summary, nextWork: "Continue investigating the remaining source after reviewing saved evidence.", openRecordIds: [], evidenceRefs: [] };
  state.messages.push(new AIMessage({ id: `ai:${id}`, content: "Saving material research conclusions.", tool_calls: [{ id, name: "security_scan", args: { version: "security-scan-v1", operation: "record", action: "append", entry } }] }),
    new ToolMessage({ id: `tm:${id}`, name: "security_scan", tool_call_id: id, content: JSON.stringify({ ok: true, operation: "record", result: { codeEvidence: [], record: {
      id: `record_${sequence}`, revision: 1, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", createdBy: author, updatedBy: author, entry,
    } } }) }));
}
function stateWith(messages: BaseMessage[] = []): NautiloState {
  return { messages, userId: "owner", currentTaskId: author.taskId, currentTaskRunId: author.taskRunId, subagentRun: true,
    toolWhitelist: ["file", "security_scan"], model: author.modelId, researchContextRecovery: null, researchContextPageBytes: null,
  } as unknown as NautiloState;
}
function hugeState() {
  const state = stateWith([new HumanMessage("Audit the whole authorized repository and retain detailed notes.")]);
  checkpoint(state, "An accepted earlier checkpoint before two enormous grep pages arrived.");
  const calls = ["grep-a", "grep-b"].map((id) => ({ id, name: "file", args: { command: "grep", pattern: "authorize", limit: 10000 } }));
  state.messages.push(new AIMessage({ id: "ai:huge-greps", content: "Inspect both searches for missing authorization.", tool_calls: calls }),
    ...calls.map((call, index) => new ToolMessage({ id: `tm:${call.id}`, name: "file", tool_call_id: call.id, content: JSON.stringify({ matches: (index ? "second tenant boundary\n" : "first tenant boundary\n").repeat(15000) }) })));
  return state;
}
function enter(state: NautiloState, budget = 4000) {
  const result = budgetResearchContext(state, [new SystemMessage("Perform an authorized exhaustive audit."), ...state.messages], budget);
  state.researchContextRecovery = result.recovery;
  state.researchContextPageBytes = result.pageBytes;
  if (!result.recovery) throw new Error("Expected active rollover");
  return result;
}
function appendContextReceipt(state: NautiloState, args: Record<string, unknown>, receipt: unknown, status?: "success" | "error") {
  const id = `context-${sequence++}`;
  state.messages.push(new AIMessage({ id: `ai:${id}`, content: "Inspect this exact retained input page.", tool_calls: [{ id, name: "security_scan", args }] }),
    new ToolMessage({ id: `tm:${id}`, name: "security_scan", tool_call_id: id, content: JSON.stringify(receipt), ...(status ? { status } : {}) }));
}
function readAll(state: NautiloState, ref: string) {
  let cursor: string | undefined;
  do {
    const args = { version: "security-scan-v1", operation: "context", contextRef: ref, ...(cursor ? { contextCursor: cursor } : {}) };
    const page = readResearchContext(state, args, { maxPageBytes: 150000 });
    if (!page.ok) throw new Error(page.error.message);
    appendContextReceipt(state, args, page);
    cursor = page.result.nextCursor ?? undefined;
  } while (cursor);
}

test("two oversized post-checkpoint grep results fit a fresh provider workspace without changing canonical bytes", () => {
  const state = hugeState();
  const before = state.messages.map((message) => message.toDict());
  const result = enter(state);
  expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(4000);
  expect(result.projectedMessages).toBe(2);
  expect(result.recovery!.pendingRefs).toHaveLength(2);
  expect(new Set(result.recovery!.pendingRefs)).toEqual(new Set([describeResearchContextMessage(state, 4)!.ref, describeResearchContextMessage(state, 5)!.ref]));
  expect(state.messages.map((message) => message.toDict())).toEqual(before);
  expect(result.messages.filter((message) => ToolMessage.isInstance(message)).every((message) => state.messages.includes(message) || (typeof message.content === "string" && message.content.includes("contextProjection")))).toBe(true);
});

test("active recovery admits only consolidation operations and never new investigation or finalization", () => {
  const state = hugeState(); enter(state);
  expect(researchContextRecoveryToolError(state, "file", { command: "read", path: "src/auth.ts" })).toContain("Context recovery is active");
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "start" })).not.toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "results", finalize: true })).not.toBeNull();
  for (const operation of ["context", "status", "record", "cancel"]) expect(researchContextRecoveryToolError(state, "security_scan", { operation })).toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "results", category: "research", finalize: false })).toBeNull();
});

test("persisted recovery cannot bind a different owner, Task, Run or ordinary Room", () => {
  const state = hugeState(); enter(state);
  for (const change of [{ userId: "different-owner" }, { currentTaskId: "different-task" }, { currentTaskRunId: "different-run" }, { subagentRun: false }]) {
    expect(currentResearchContextRecovery({ ...state, ...change })).toBeNull();
  }
});

test("only all contiguous exact context reads plus a subsequent accepted checkpoint clear recovery", () => {
  const state = hugeState(); const initial = enter(state).recovery!;
  readAll(state, initial.pendingRefs[0]!);
  expect(remainingResearchContextRefs(state, initial)).toHaveLength(1);
  expect(currentResearchContextRecovery(state)).not.toBeNull();
  readAll(state, initial.pendingRefs[1]!);
  expect(remainingResearchContextRefs(state, initial)).toEqual([]);
  expect(currentResearchContextRecovery(state)).not.toBeNull();
  checkpoint(state);
  expect(currentResearchContextRecovery(state)).toBeNull();
  expect(researchContextRecoveryToolError(state, "file", { command: "read" })).toBeNull();
});

test("a checkpoint before the last required read cannot claim semantic consolidation of unread input", () => {
  const state = hugeState(); const initial = enter(state).recovery!;
  checkpoint(state, "This checkpoint preceded the required new input.");
  for (const ref of initial.pendingRefs) readAll(state, ref);
  expect(currentResearchContextRecovery(state)).not.toBeNull();
  checkpoint(state, "This later checkpoint consolidates all recovered pages.");
  expect(currentResearchContextRecovery(state)).toBeNull();
});

test("forged success, wrong digest/text and unpaired or gapped context claims cannot acknowledge canonical bytes", () => {
  for (const variant of ["tiny", "wrong-digest", "wrong-text", "unpaired", "error", "gap"] as const) {
    const state = hugeState(); const initial = enter(state).recovery!;
    const ref = initial.pendingRefs[0]!;
    const args = { version: "security-scan-v1", operation: "context", contextRef: ref };
    const first = readResearchContext(state, args, { maxPageBytes: 150000 });
    if (!first.ok) throw new Error(first.error.message);
    if (variant === "unpaired") {
      state.messages.push(new ToolMessage({ tool_call_id: "nonexistent", name: "security_scan", content: JSON.stringify(first) }));
    } else if (variant === "gap") {
      if (!first.result.nextCursor) throw new Error("Expected multiple pages");
      const tailArgs = { ...args, contextCursor: first.result.nextCursor };
      const tail = readResearchContext(state, tailArgs, { maxPageBytes: 1000000 });
      appendContextReceipt(state, tailArgs, tail);
    } else {
      const result = { ...first.result,
        ...(variant === "tiny" ? { startByte: 0, endByte: 1, totalBytes: 1, text: "x", complete: true, nextCursor: null } : {}),
        ...(variant === "wrong-digest" ? { sha256: "0".repeat(64), endByte: first.result.totalBytes, complete: true, nextCursor: null } : {}),
        ...(variant === "wrong-text" ? { text: "Fabricated full content", endByte: first.result.totalBytes, complete: true, nextCursor: null } : {}),
      };
      appendContextReceipt(state, args, { ...first, result }, variant === "error" ? "error" : undefined);
    }
    expect(remainingResearchContextRefs(state, initial)).toContain(ref);
  }
});

test("many small cycles without any checkpoint reset through a frozen index and preserve unsaved notes", () => {
  const state = stateWith([new HumanMessage("Perform an exhaustive audit.")]);
  for (let index = 0; index < 40; index++) {
    state.messages.push(new AIMessage({ id: `ai:small-${index}`, content: `Unsaved finding ${index}: ${"A missing per-project authority check crosses the queued delivery boundary. ".repeat(12)}`,
      tool_calls: [{ id: `small-${index}`, name: "file", args: { command: "read", path: `src/flow-${index}.ts` } }] }),
      new ToolMessage({ id: `tm:small-${index}`, tool_call_id: `small-${index}`, name: "file", content: "The inspected source remains canonical." }));
  }
  const original = state.messages.map((message) => message.toDict());
  const budgeted = enter(state, 2000);
  expect(estimateTokenCount(budgeted.messages)).toBeLessThanOrEqual(2000);
  expect(budgeted.pageBytes).toBeGreaterThan(0);
  const recovery = budgeted.recovery!;
  expect(recovery.pendingRefs).not.toContain(recovery.indexRef);
  expect(state.messages.map((message) => message.toDict())).toEqual(original);
  readAll(state, recovery.indexRef);
  checkpoint(state, "I only read the index, not the unsaved substantive note contents.");
  expect(currentResearchContextRecovery(state)).not.toBeNull();
});

test("runtime-sized context pages remain visible on the next turn instead of recursing into context-of-context", () => {
  const state = hugeState();
  let budgeted = enter(state, 4000);
  const ref = budgeted.recovery!.pendingRefs[0]!;
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const args = { version: "security-scan-v1", operation: "context", contextRef: ref, ...(cursor ? { contextCursor: cursor } : {}) };
    const page = readResearchContext(state, args, { maxPageBytes: budgeted.pageBytes });
    if (budgeted.recovery?.consolidationRequired) {
      expect(researchContextRecoveryToolError(state, "security_scan", args)).toContain("needs consolidation");
      checkpoint(state);
      budgeted = enter(state, 4000);
      continue;
    }
    if (!page.ok) throw new Error(page.error.message);
    appendContextReceipt(state, args, page);
    const latest = state.messages.at(-1)!;
    budgeted = budgetResearchContext(state, [new SystemMessage("Perform an authorized exhaustive audit."), ...state.messages], 4000);
    state.researchContextRecovery = budgeted.recovery;
    state.researchContextPageBytes = budgeted.pageBytes;
    expect(estimateTokenCount(budgeted.messages)).toBeLessThanOrEqual(4000);
    const presented = budgeted.messages.find((message) => message.id === latest.id);
    expect(presented?.content).toBe(latest.content);
    cursor = page.result.nextCursor ?? undefined;
    if (!cursor) break;
  }
});

test("repeated tighter provider-budget retries retain one recovery instruction and the exact original authority context", () => {
  const state = hugeState();
  const system = new SystemMessage({ content: [{ type: "text", text: "Authorized source and audit instructions.", cache_control: { type: "ephemeral" } }] });
  let prepared: BaseMessage[] = [system, ...state.messages];
  const original = state.messages.map((message) => message.toDict());
  for (const budget of [6000, 4500, 3000]) {
    const result = budgetResearchContext(state, prepared, budget);
    state.researchContextRecovery = result.recovery;
    state.researchContextPageBytes = result.pageBytes;
    prepared = result.messages;
    expect(estimateTokenCount(prepared)).toBeLessThanOrEqual(budget);
    expect(prepared.filter((message) => SystemMessage.isInstance(message))).toHaveLength(1);
    const firstContent = prepared[0]!.content;
    const text = typeof firstContent === "string" ? firstContent : firstContent.flatMap((block) => typeof block === "object" && block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : []).join("\n");
    expect(text.split("[RESEARCH CONTEXT RECOVERY]")).toHaveLength(2);
    expect(text.split("Authorized source and audit instructions.")).toHaveLength(2);
    expect(state.messages.map((message) => message.toDict())).toEqual(original);
    expect(result.recovery?.pendingRefs).toHaveLength(2);
  }
});

test("ID-less messages retain exact canonical origin across provider tool-ID and text-block normalization", async () => {
  const { prepareResearchContextOrigins } = await import("../../src/tools/security/research-context-rollover");
  const state = stateWith([new HumanMessage("Audit the requested source."),
    new AIMessage({ content: [{ type: "text", text: "Unsaved source analysis." }], tool_calls: [{ id: "read:0", name: "file", args: { command: "read", path: "src/auth.ts" } }] }),
    new ToolMessage({ name: "file", tool_call_id: "read:0", content: "large authorization source\n".repeat(20000) })]);
  const before = state.messages.map((message) => message.toDict());
  const origins = prepareResearchContextOrigins(state, state.messages);
  const prepared = origins.messages.map((message) => AIMessage.isInstance(message)
    ? new AIMessage({ id: message.id!, content: "Unsaved source analysis.", tool_calls: message.tool_calls!.map((call) => ({ ...call, id: "read_0" })) })
    : ToolMessage.isInstance(message) ? new ToolMessage({ id: message.id!, content: message.content, name: "file", tool_call_id: "read_0" }) : message);
  origins.bind(prepared);
  const result = budgetResearchContext(state, [new SystemMessage("Audit"), ...prepared], 2000);
  expect(result.projectedMessages).toBe(1);
  expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, 2)!.ref);
  expect(result.messages.filter((message) => ToolMessage.isInstance(message))[0]?.tool_call_id).toBe("read_0");
  expect(state.messages.map((message) => message.toDict())).toEqual(before);
  expect(state.messages[1]?.id).toBeUndefined();
});

test("unknown future normalization falls back to required canonical inputs rather than only reading an index", () => {
  const state = stateWith([new HumanMessage("Audit"),
    new AIMessage({ content: "Unsaved source analysis", tool_calls: [{ id: "read:0", name: "file", args: { command: "read" } }] }),
    new ToolMessage({ name: "file", tool_call_id: "read:0", content: "large authorization source\n".repeat(20000) })]);
  const result = budgetResearchContext(state, [new SystemMessage("Audit"), state.messages[0]!,
    new AIMessage({ content: "Unsaved source analysis", tool_calls: [{ id: "read_0", name: "file", args: { command: "read" } }] }),
    new ToolMessage({ name: "file", tool_call_id: "read_0", content: state.messages[2]!.content })], 2000);
  expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, 1)!.ref);
  expect(result.recovery?.pendingRefs).toContain(describeResearchContextMessage(state, 2)!.ref);
  // Unmapped transformed bytes remain visible, even alongside known debt.
  // Irreducible input must fail the ordinary provider guard, not disappear.
  expect(estimateTokenCount(result.messages)).toBeGreaterThan(2000);
  expect(result.messages.some((message) => ToolMessage.isInstance(message) && message.tool_call_id === "read_0" && message.content === state.messages[2]!.content)).toBe(true);
});


test("repeated smaller provider preparations replace the transient recovery instruction and preserve one leading system", () => {
  const state = hugeState();
  let result = enter(state, 5000);
  for (const budget of [4500, 4000, 3500]) {
    result = budgetResearchContext(state, result.messages, budget);
    state.researchContextRecovery = result.recovery;
    expect(estimateTokenCount(result.messages)).toBeLessThanOrEqual(budget);
    expect(result.messages.filter((message) => SystemMessage.isInstance(message))).toHaveLength(1);
    expect((result.messages[0]!.content as string).split("[RESEARCH CONTEXT RECOVERY]")).toHaveLength(2);
  }
});

test("persisted recovery supplies the exact next cursor after earlier context pages leave the workspace", () => {
  const state = hugeState(); const initial = enter(state);
  const ref = initial.recovery!.pendingRefs[0]!;
  const args = { version: "security-scan-v1", operation: "context", contextRef: ref };
  const page = readResearchContext(state, args, { maxPageBytes: initial.pageBytes });
  if (!page.ok || !page.result.nextCursor) throw new Error("Expected partial page");
  appendContextReceipt(state, args, page);
  checkpoint(state);
  const next = budgetResearchContext(state, [new SystemMessage("Research"), state.messages[0]!], 4000);
  expect((next.messages[0]!.content as string)).toContain(page.result.nextCursor);
  expect((next.messages[0]!.content as string)).toContain(`"recoveredBytes":${page.result.endByte}`);
});


test("a checkpoint batched with the last context read cannot claim to consolidate unseen bytes", () => {
  const state = hugeState(); const initial = enter(state).recovery!;
  readAll(state, initial.pendingRefs[0]!);
  const args = { version: "security-scan-v1", operation: "context", contextRef: initial.pendingRefs[1]! };
  const page = readResearchContext(state, args, { maxPageBytes: 2000000 });
  if (!page.ok || !page.result.complete) throw new Error("Expected complete final input");
  appendContextReceipt(state, args, page);
  const readResult = state.messages.pop()!;
  const readCall = state.messages.pop() as AIMessage;
  checkpoint(state, "This checkpoint was written without seeing the batched result.");
  const checkpointResult = state.messages.pop()!;
  const checkpointCall = state.messages.pop() as AIMessage;
  state.messages.push(new AIMessage({ content: "Read and checkpoint in one batch.", tool_calls: [...readCall.tool_calls!, ...checkpointCall.tool_calls!] }), readResult, checkpointResult);
  expect(remainingResearchContextRefs(state, initial)).toEqual([]);
  expect(currentResearchContextRecovery(state)).not.toBeNull();
  checkpoint(state, "Now the model can consolidate the actual final page.");
  expect(currentResearchContextRecovery(state)).toBeNull();
});

test("workspace pressure requires a later checkpoint, but an ordinary page does not", () => {
  const state = hugeState();
  const recovery = enter(state).recovery!;
  const args = { version: "security-scan-v1", operation: "context", contextRef: recovery.pendingRefs[0]! };
  const page = readResearchContext(state, args, { maxPageBytes: 1500 });
  if (!page.ok) throw new Error(page.error.message);
  appendContextReceipt(state, args, page);
  const pageCall = state.messages.at(-2)!;
  if (!AIMessage.isInstance(pageCall)) throw new Error("Expected context request");
  expect(researchContextRecoveryToolError(state, "security_scan", args)).toBeNull();
  state.researchContextRecovery = { ...recovery, consolidationRequired: true };
  expect(researchContextRecoveryToolError(state, "security_scan", args)).not.toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "record" })).toBeNull();
  expect(researchContextRecoveryToolError(state, "security_scan", { operation: "status" })).toBeNull();
  // Model pre-authoring a checkpoint alongside the read cannot establish that
  // it consolidated bytes it had not yet received, even if the receipt is valid.
  checkpoint(state, "This checkpoint was pre-authored in the same batch as the read.");
  const batchedCheckpointCall = state.messages.splice(state.messages.length - 2, 1)[0]!;
  if (!AIMessage.isInstance(batchedCheckpointCall)) throw new Error("Expected checkpoint request");
  pageCall.tool_calls = [...(pageCall.tool_calls ?? []), ...(batchedCheckpointCall.tool_calls ?? [])];
  expect(researchContextRecoveryToolError(state, "security_scan", args)).not.toBeNull();
  checkpoint(state, "This later model turn consolidated the received page's source evidence and outstanding work.");
  expect(researchContextRecoveryToolError(state, "security_scan", args)).toBeNull();
});

test("verified byte progress resets only the recovery guard streak, while duplicate reads and ledger chatter cannot mask a stall", async () => {
  const { applyToolResultsToStreaks, buildNoProgressKey, serializeNoProgressKey } = await import("../../src/graph/no-progress");
  const state = hugeState();
  enter(state);
  const blocked = () => ({ toolName: "file", args: { command: "list", path: "." }, status: "error" as const,
    errorContent: researchContextRecoveryToolError(state, "file", { command: "list", path: "." })! });
  const unrelated = { toolName: "file", args: { command: "write" }, status: "error" as const, errorContent: "Write denied by authority." };
  let evaluated = applyToolResultsToStreaks(new Map(), [unrelated, blocked()]);
  evaluated = applyToolResultsToStreaks(evaluated.streaks, [blocked()]);
  expect(evaluated.action.kind).toBe("continue");
  expect(blocked().errorContent).toStartWith("Recovered 0 verified historical bytes.");
  const ref = state.researchContextRecovery!.pendingRefs[0]!;
  const args = { version: "security-scan-v1", operation: "context", contextRef: ref };
  const page = readResearchContext(state, args, { maxPageBytes: 4000 });
  if (!page.ok) throw new Error(page.error.message);
  appendContextReceipt(state, args, page);
  const progressed = blocked();
  expect(progressed.errorContent).toStartWith(`Recovered ${page.result.endByte} verified historical bytes.`);
  appendContextReceipt(state, args, { ...page, result: { ...page.result, endByte: page.result.endByte + 100 } });
  expect(blocked().errorContent).toBe(progressed.errorContent); // Forged byte claims do not advance progress.
  if (!page.result.nextCursor) throw new Error("Expected a second source page");
  const nextArgs = { ...args, contextCursor: page.result.nextCursor };
  const hidden = readResearchContext(state, nextArgs, { maxPageBytes: 4000 });
  if (!hidden.ok) throw new Error(hidden.error.message);
  appendContextReceipt(state, nextArgs, hidden);
  state.researchContextRecovery!.unpresentedReadIndices = [state.messages.length - 1];
  expect(blocked().errorContent).toBe(progressed.errorContent); // Undisclosed bytes cannot reset the guard.
  evaluated = applyToolResultsToStreaks(evaluated.streaks, [progressed]);
  expect(evaluated.action.kind).toBe("continue");
  expect(evaluated.streaks.get(serializeNoProgressKey(buildNoProgressKey(progressed)))?.count).toBe(1);
  expect(evaluated.streaks.get(serializeNoProgressKey(buildNoProgressKey(unrelated)))?.count).toBe(1);
  state.messages.push(new AIMessage({ content: "Check saved status.", tool_calls: [{ id: "status-progress", name: "security_scan", args: { operation: "status" } }] }),
    new ToolMessage({ name: "security_scan", tool_call_id: "status-progress", content: JSON.stringify({ ok: true, operation: "status", result: { state: "active" } }) }));
  expect(blocked().errorContent).toBe(progressed.errorContent);
  evaluated = applyToolResultsToStreaks(evaluated.streaks, [{ toolName: "security_scan", args: { operation: "status" }, status: "success" }, blocked()]);
  expect(evaluated.streaks.get(serializeNoProgressKey(buildNoProgressKey(progressed)))?.count).toBe(2);
  checkpoint(state);
  expect(blocked().errorContent).toBe(progressed.errorContent);
  evaluated = applyToolResultsToStreaks(evaluated.streaks, [{ toolName: "security_scan", args: { operation: "record" }, status: "success" }, blocked()]);
  expect(evaluated.action.kind).toBe("inject_corrective");
  appendContextReceipt(state, args, page); // Exact repeat covers no additional bytes.
  expect(blocked().errorContent).toBe(progressed.errorContent);
  evaluated = applyToolResultsToStreaks(evaluated.streaks, [blocked()]);
  expect(evaluated.action.kind).toBe("stop_no_progress");
});
