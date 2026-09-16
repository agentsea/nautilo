import { expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { securityResearchContextReceiptSchema } from "@nautilo/types";
import { describeResearchContextIndex, describeResearchContextMessage, readResearchContext, serializeResearchContextMessage } from "../../src/tools/security/research-context";

function fixture() {
  const message = new ToolMessage({ id: "tm:grep", name: "file", tool_call_id: "grep", content: "first 🦀 中文\n\"quoted\"\\path\t".repeat(300),
    additional_kwargs: { hidden_reasoning: "never disclose", privateSidecar: "secret" } });
  return { messages: [message], userId: "owner", currentTaskId: "task", currentTaskRunId: "run", subagentRun: true, toolWhitelist: ["file", "security_scan"] };
}
test("recovers every exact UTF-8 byte through small escaped pages without mutating canonical content", () => {
  const state = fixture();
  const original = serializeResearchContextMessage(state.messages[0]!)!;
  const descriptor = describeResearchContextMessage(state, 0)!;
  let cursor: string | undefined;
  let joined = "";
  let offset = 0;
  let pages = 0;
  do {
    const receipt = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref, ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: 900 });
    if (!receipt.ok) throw new Error(receipt.error.message);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(900);
    expect(receipt.result.startByte).toBe(offset);
    expect(receipt.result.text).not.toContain("�");
    joined += receipt.result.text;
    offset = receipt.result.endByte;
    cursor = receipt.result.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  expect(pages).toBeGreaterThan(3);
  expect(joined).toBe(original);
  expect(Buffer.byteLength(joined)).toBe(descriptor.totalBytes);
  expect(joined).not.toContain("never disclose");
  expect(joined).not.toContain("privateSidecar");
  expect(serializeResearchContextMessage(state.messages[0]!)).toBe(original);
});
test("binds reference and continuation to owner, Task, Run and unchanged content", () => {
  const state = fixture();
  const contextRef = describeResearchContextMessage(state, 0)!.ref;
  const args = { version: "security-scan-v1", operation: "context", contextRef };
  for (const changed of [{ userId: "other" }, { currentTaskId: "other" }, { currentTaskRunId: "other" }]) {
    expect(readResearchContext({ ...state, ...changed }, args, { maxPageBytes: 900 })).toMatchObject({ ok: false, error: { code: "context_reference_stale" } });
  }
  const first = readResearchContext(state, args, { maxPageBytes: 900 });
  if (!first.ok) throw new Error("expected first page");
  state.messages.push(new ToolMessage({ name: "file", tool_call_id: "later", content: "later file version" }));
  expect(readResearchContext(state, { ...args, contextCursor: first.result.nextCursor }, { maxPageBytes: 900 }).ok).toBe(true);
  const otherRef = describeResearchContextMessage(state, 1)!.ref;
  expect(readResearchContext(state, { ...args, contextRef: otherRef, contextCursor: first.result.nextCursor }, { maxPageBytes: 900 })).toMatchObject({ ok: false, error: { code: "context_cursor_stale" } });
  state.messages[0]!.content = "changed source receipt";
  expect(readResearchContext(state, args, { maxPageBytes: 900 })).toMatchObject({ ok: false, error: { code: "context_reference_stale" } });
});
test("legacy ID-less assistant notes and rejected tool-call arguments remain exact and append-stable", () => {
  const state = { ...fixture(), messages: [new AIMessage({ content: "Unsaved substantive note", tool_calls: [{ id: "save", name: "security_scan", args: { entry: { summary: "Rejected but valuable note" } } }], additional_kwargs: { reasoning_content: "secret thinking" } })] };
  const ref = describeResearchContextMessage(state, 0)!;
  state.messages.push(new AIMessage("later"));
  expect(describeResearchContextMessage(state, 0)).toEqual(ref);
  const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref.ref }, { maxPageBytes: 2000 });
  expect(page.ok).toBe(true);
  if (!page.ok) return;
  expect(page.result.text).toContain("Unsaved substantive note");
  expect(page.result.text).toContain("Rejected but valuable note");
  expect(page.result.text).not.toContain("secret thinking");
});
test("rejects ordinary Room, absent whitelist, task selectors, bad offsets and insufficient framing budget", () => {
  const state = fixture();
  const args = { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(state, 0)!.ref };
  expect(readResearchContext({ ...state, subagentRun: false }, args, { maxPageBytes: 900 }).ok).toBe(false);
  expect(readResearchContext({ ...state, toolWhitelist: ["file"] }, args, { maxPageBytes: 900 }).ok).toBe(false);
  expect(readResearchContext(state, { ...args, taskId: "other" }, { maxPageBytes: 900 }).ok).toBe(false);
  expect(readResearchContext(state, { ...args, contextCursor: "research-page:2:fake" }, { maxPageBytes: 900 }).ok).toBe(false);
  expect(readResearchContext(state, args, { maxPageBytes: 10 })).toMatchObject({ ok: false, error: { code: "context_budget_unavailable" } });
  const smaller = readResearchContext(state, { ...args, contextBytes: 30 }, { maxPageBytes: 900 });
  if (!smaller.ok) throw new Error(smaller.error.message);
  expect(smaller.result.endByte).toBeLessThanOrEqual(30);
});

test("frozen paged index discovers every historical message and survives later appends", () => {
  const state = fixture();
  state.messages.push(new ToolMessage({ id: "tm:second", name: "security_scan", tool_call_id: "second", content: "accepted substantive note" }));
  const descriptor = describeResearchContextIndex(state, 1)!;
  state.messages.push(new ToolMessage({ name: "file", tool_call_id: "later", content: "later" }));
  expect(describeResearchContextIndex(state, 1)).toEqual(descriptor);
  let cursor: string | undefined;
  let text = "";
  do {
    const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref, ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: 850 });
    if (!page.ok) throw new Error(page.error.message);
    text += page.result.text;
    cursor = page.result.nextCursor ?? undefined;
  } while (cursor);
  const entries = (JSON.parse(text) as { messages: unknown[] }).messages;
  expect(entries).toHaveLength(2);
  expect(entries[0]).toEqual(describeResearchContextMessage(state, 0));
  expect(entries[1]).toEqual(describeResearchContextMessage(state, 1));
  state.messages[0]!.content = "changed earlier message";
  expect(readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref }, { maxPageBytes: 850 })).toMatchObject({ ok: false, error: { code: "context_reference_stale" } });
});

test("a final page can be replayed at its exact smaller cursor-free serialized budget", () => {
  const state = { ...fixture(), messages: [new ToolMessage({ name: "file", tool_call_id: "small", content: "Retain the final substantive note. ".repeat(20) })] };
  const args = { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(state, 0)!.ref };
  const first = readResearchContext(state, args, { maxPageBytes: 2000 });
  if (!first.ok) throw new Error(first.error.message);
  expect(first.result.complete).toBe(true);
  const exactBudget = Buffer.byteLength(JSON.stringify(first), "utf8");
  expect(readResearchContext(state, args, { maxPageBytes: exactBudget })).toEqual(first);
});

function pairedFixture(path = "identity/tokens.js") {
  const call = new AIMessage({ id: "ai:tokens", content: "Inspect the actual token checks.",
    tool_calls: [{ id: "read:tokens", name: "file", args: { command: "read", path, zone: "current", lineRange: { from: 40, to: 90 }, offset: 39, limit: 51,
      readCursor: "original-private-file-cursor", query: "large argument omitted from page headers".repeat(500) } }],
    additional_kwargs: { reasoning_content: "private chain", privateSidecar: "hidden sidecar" } });
  const result = new ToolMessage({ id: "tm:tokens", name: "file", tool_call_id: "read:tokens", content: "exact source 🦀\n\"quoted\"\\bytes".repeat(80) });
  return { ...fixture(), messages: [call, result] };
}

test("every file-result page carries its canonical request identity even when the original call left the model window", () => {
  const state = pairedFixture();
  const ref = describeResearchContextMessage(state, 1)!;
  const callRef = describeResearchContextMessage(state, 0)!.ref;
  const original = serializeResearchContextMessage(state.messages[1]!)!;
  let cursor: string | undefined;
  let recovered = "";
  do {
    const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref.ref,
      ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: 1200 });
    if (!page.ok) throw new Error(page.error.message);
    securityResearchContextReceiptSchema.parse(page);
    // This lone page is the entire relevant provider-visible window.
    expect(page.result.source).toEqual({ tool: "file", identity: "paired", outcome: "unknown", toolCallId: "read:tokens", callRef,
      command: "read", path: "identity/tokens.js", zone: "current", lineRange: { from: 40, to: 90 }, offset: 39, limit: 51, continuedRead: true });
    expect(JSON.stringify(page)).not.toContain("large argument");
    expect(JSON.stringify(page)).not.toContain("private chain");
    expect(JSON.stringify(page)).not.toContain("hidden sidecar");
    expect(JSON.stringify(page)).not.toContain("original-private-file-cursor");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1200);
    expect(readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref.ref,
      ...(cursor ? { contextCursor: cursor } : {}) }, { maxPageBytes: Buffer.byteLength(JSON.stringify(page)) })).toEqual(page);
    recovered += page.result.text;
    cursor = page.result.nextCursor ?? undefined;
  } while (cursor);
  expect(recovered).toBe(original);
  expect(serializeResearchContextMessage(state.messages[1]!)).toBe(original);
  const origin = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: callRef }, { maxPageBytes: 24_000 });
  if (!origin.ok) throw new Error(origin.error.message);
  expect(origin.result.text).toContain("identity/tokens.js");
  expect(origin.result.text).toContain("large argument");
  expect(origin.result.text).not.toContain("private chain");
});

test("changing paired identity or any call arguments invalidates existing result references", () => {
  for (const changed of [{ path: "core/tokens.js" }, { zone: "absolute" }, { command: "grep" }, { query: "different query" }, { lineRange: { from: 1, to: 2 } }]) {
    const state = pairedFixture();
    const ref = describeResearchContextMessage(state, 1)!.ref;
    const call = state.messages[0]!;
    if (!AIMessage.isInstance(call)) throw new Error("Expected original call");
    call.tool_calls![0]!.args = { ...call.tool_calls![0]!.args, ...changed };
    expect(readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref }, { maxPageBytes: 1200 }))
      .toMatchObject({ ok: false, error: { code: "context_reference_stale" } });
  }
  for (const changed of [{ name: "other_tool" }, { id: "wrong-call" }]) {
    const state = pairedFixture(); const ref = describeResearchContextMessage(state, 1)!.ref;
    const call = state.messages[0]!;
    if (!AIMessage.isInstance(call)) throw new Error("Expected original call");
    Object.assign(call.tool_calls![0]!, changed);
    expect(readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: ref }, { maxPageBytes: 1200 }).ok).toBe(false);
    expect(describeResearchContextMessage(state, 1)?.source).toEqual({ tool: "file", identity: "unavailable", outcome: "unknown" });
  }
  const orphan = fixture();
  const result = readResearchContext(orphan, { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(orphan, 0)!.ref }, { maxPageBytes: 1200 });
  if (!result.ok) throw new Error(result.error.message);
  expect(result.result.source).toEqual({ tool: "file", identity: "unavailable", outcome: "unknown" });
  const duplicate = pairedFixture();
  duplicate.messages.push(new ToolMessage({ name: "file", tool_call_id: "read:tokens", content: "Unpaired duplicate result" }));
  expect(describeResearchContextMessage(duplicate, 2)?.source).toEqual({ tool: "file", identity: "unavailable", outcome: "unknown" });
});

test("oversized provenance fields are explicitly omitted under the whole receipt budget with exact call recovery", () => {
  const state = pairedFixture('"\\long-path'.repeat(2000));
  const descriptor = describeResearchContextMessage(state, 1)!;
  const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref }, { maxPageBytes: 1200 });
  if (!page.ok) throw new Error(page.error.message);
  expect(page.result.source).toMatchObject({ identity: "paired", command: "read", zone: "current", fieldsNotPresented: ["path"],
    callRef: describeResearchContextMessage(state, 0)!.ref });
  expect(page.result.source).not.toHaveProperty("path");
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1200);
  expect(page.result.text).toBe(serializeResearchContextMessage(state.messages[1]!)!.slice(0, page.result.text.length));
  expect(readResearchContext({ ...state, currentTaskRunId: "other-run" }, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref }, { maxPageBytes: 1200 }).ok).toBe(false);
});

test("a short provenance-bearing final page replays at its exact cursor-free envelope budget", () => {
  const state = pairedFixture(); state.messages[1]!.content = "";
  const args = { version: "security-scan-v1", operation: "context", contextRef: describeResearchContextMessage(state, 1)!.ref };
  const page = readResearchContext(state, args, { maxPageBytes: 1200 });
  if (!page.ok) throw new Error(page.error.message);
  expect(page.result.complete).toBe(true);
  expect(readResearchContext(state, args, { maxPageBytes: Buffer.byteLength(JSON.stringify(page)) })).toEqual(page);
});


test("ambiguous unconsumed file-call IDs never claim a path; consumed IDs can be reused in later cycles", () => {
  const state = pairedFixture();
  const call = state.messages[0]!;
  if (!AIMessage.isInstance(call)) throw new Error("Expected original call");
  const originalRef = describeResearchContextMessage(state, 1)!.ref;
  call.tool_calls!.push({ id: "read:tokens", name: "file", args: { command: "read", path: "core/tokens.js", zone: "current" } });
  const descriptor = describeResearchContextMessage(state, 1)!;
  expect(descriptor.source).toEqual({ tool: "file", identity: "unavailable", outcome: "unknown" });
  expect(readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: originalRef }, { maxPageBytes: 1200 }).ok).toBe(false);
  const page = readResearchContext(state, { version: "security-scan-v1", operation: "context", contextRef: descriptor.ref }, { maxPageBytes: 12_000 });
  if (!page.ok) throw new Error(page.error.message);
  expect(page.result.source).toEqual({ tool: "file", identity: "unavailable", outcome: "unknown" });
  expect(page.result.text).toBe(serializeResearchContextMessage(state.messages[1]!)!);
  expect(JSON.stringify(page.result.source)).not.toContain("tokens.js");
  const sequential = pairedFixture();
  sequential.messages.push(new AIMessage({ id: "ai:later", content: "", tool_calls: [{ id: "read:tokens", name: "file", args: { command: "read", path: "later/verified.js", zone: "current" } }] }),
    new ToolMessage({ id: "tm:later", name: "file", tool_call_id: "read:tokens", content: "Later uniquely paired bytes." }));
  expect(describeResearchContextMessage(sequential, 3)?.source).toMatchObject({ identity: "paired", path: "later/verified.js", zone: "current" });
});
