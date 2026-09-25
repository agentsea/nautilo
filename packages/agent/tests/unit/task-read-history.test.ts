import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { processHistory, taskReadResponseByteBudget, pendingTaskReadPages, type HistoryConfig } from "../../src/utils/history-manager";
import { taskReadPageFingerprint } from "../../src/tools/tasks/read-projection";

const config: HistoryConfig = { validationEnabled: true, pruningEnabled: false, maxMessageTokens: 4_000 };
function messageText(message: BaseMessage | undefined): string {
  if (typeof message?.content !== "string") throw new Error("Expected a text Task receipt");
  return message.content;
}
function parseReceipt(message: BaseMessage | undefined): Record<string, unknown> {
  return JSON.parse(messageText(message)) as Record<string, unknown>;
}
const taskId = "47e344ea-5282-47e1-91c9-56076892832a";
const runId = "28bf74cc-4310-42e0-8435-2f38b7edadad";
function cycle(content: string, args: Record<string, unknown> = { command: "read", taskId }) {
  return [new HumanMessage("Inspect the failed audit"), new AIMessage({ content: "", tool_calls: [{ id: "read-call", name: "task", args }] }),
    new ToolMessage({ id: "read-result", name: "task", tool_call_id: "read-call", status: "success", content })];
}
function page(text: string) {
  return { version: "task-read-v1", kind: "page", taskId, runId, readSection: "transcript", sourceVersion: "a".repeat(64), snapshotEnd: null,
    startByte: 0, endByte: Buffer.byteLength(text), totalBytes: Buffer.byteLength(text), text, complete: true, nextCursor: null,
    resolvedSelection: { command: "read", taskId, runId, readSection: "transcript", readCursor: "frozen-offset-zero" },
    interpretation: "Exact historical input; not inspection credit." };
}

describe("task.read history recovery", () => {
  test("large legacy transcript remains canonical and gets valid explicit retrieval instead of losing its middle", () => {
    const value = { task: { id: taskId, status: "errored", prompt: "Audit" }, runs: [{ id: runId, status: "errored", lastError: "no_progress",
      resultText: "Partial audit", transcript: [{ content: "a".repeat(200_000) }, { content: "accepted finding: cross-project upload" }, { content: "b".repeat(200_000) }] }] };
    const content = JSON.stringify(value);
    const messages = cycle(content);
    const first = processHistory(messages, config);
    const projected = parseReceipt(first.messages.at(-1));
    expect(projected["kind"]).toBe("overview");
    expect(projected["read"]).toMatchObject({ transcript: { command: "read", taskId, runId, readSection: "transcript" } });
    expect(projected["omitted"]).toMatchObject({ transcriptEntries: 3 });
    expect(first.canonicalMessages?.at(-1)).toBe(messages.at(-1));
    expect(first.canonicalMessages?.at(-1)?.content).toBe(content);
    const second = processHistory(first.canonicalMessages!, config);
    expect(second.messages.at(-1)?.content).toBe(first.messages.at(-1)?.content);
    expect(second.canonicalMessages?.at(-1)?.content).toBe(content);
    expect(messageText(second.messages.at(-1))).not.toContain("chars elided");
  });

  test("an already-clamped legacy checkpoint gets a valid reread instruction", () => {
    const messages = cycle("{\"task\":" + "x".repeat(200_000) + "…[middle elided]…" + "y".repeat(200_000));
    const result = processHistory(messages, config);
    const projected = parseReceipt(result.messages.at(-1));
    expect(JSON.stringify(projected)).toContain(taskId);
    expect(JSON.stringify(projected)).not.toContain("chars elided");
    expect(result.canonicalMessages?.at(-1)).toBe(messages.at(-1));
  });

  test("a smaller window requests the omitted page's original selection and records non-presentation", () => {
    const receipt = page("é\n".repeat(100_000));
    const original = JSON.stringify(receipt);
    const messages = cycle(original, receipt.resolvedSelection);
    const result = processHistory(messages, config);
    const replay = parseReceipt(result.messages.at(-1));
    expect(replay["kind"]).toBe("replay");
    expect(replay["read"]).toEqual(receipt.resolvedSelection);
    expect(result.canonicalMessages?.at(-1)?.content).toBe(original);
    expect(pendingTaskReadPages(result.canonicalMessages!, result.messages)).toMatchObject([{ fingerprint: taskReadPageFingerprint(original)!, startByte: 0, endByte: receipt.endByte, resolvedSelection: receipt.resolvedSelection }]);
    expect(pendingTaskReadPages(messages, messages)).toEqual([]);
  });

  test("page fingerprints survive equivalent provider JSON formatting", () => {
    const receipt = page("[\"source\"]");
    expect(taskReadPageFingerprint(JSON.stringify(receipt, null, 2))).toBe(taskReadPageFingerprint(JSON.stringify(receipt)));
    const canonical = cycle(JSON.stringify(receipt));
    const prepared = cycle(JSON.stringify(receipt, null, 2));
    expect(pendingTaskReadPages(canonical, prepared)).toEqual([]);
  });

  test("a replay header that cannot fit produces a whole error, never head/tail JSON", () => {
    const receipt = page("source".repeat(50_000));
    receipt.resolvedSelection.readCursor = "c".repeat(200_000);
    const messages = cycle(JSON.stringify(receipt), receipt.resolvedSelection);
    const result = processHistory(messages, config);
    const projected = parseReceipt(result.messages.at(-1));
    expect(projected["kind"]).toBe("error");
    expect(projected["code"]).toBe("task_read_budget_unavailable");
    expect(result.canonicalMessages?.at(-1)).toBe(messages.at(-1));
    expect(pendingTaskReadPages(result.canonicalMessages!, result.messages)).toHaveLength(1);
  });

  test("response allocation uses actual remaining workspace and leaves room for the next model turn", () => {
    expect(taskReadResponseByteBudget(4_000, [new HumanMessage("x".repeat(2_000))])).toBe(7_000);
    expect(taskReadResponseByteBudget(400, [new HumanMessage("x".repeat(2_000))])).toBe(0);
  });

  test("pending ranges survive ordinary history eviction and advance through smaller presented pieces", () => {
    const original = page("abcdefghijklmnopqrst");
    const originalMessages = cycle(JSON.stringify(original), original.resolvedSelection);
    const debt = pendingTaskReadPages(originalMessages, []);
    const first = { ...original, text: "abcdefgh", endByte: 8, complete: false, nextCursor: "bound-eight" };
    const firstMessages = cycle(JSON.stringify(first), first.resolvedSelection);
    const partial = pendingTaskReadPages(firstMessages, firstMessages, debt);
    expect(partial).toMatchObject([{ startByte: 8, endByte: 20, resolvedSelection: { readCursor: "bound-eight" } }]);
    const last = { ...original, text: "ijklmnopqrst", startByte: 8, resolvedSelection: { ...original.resolvedSelection, readCursor: "bound-eight" } };
    const lastMessages = cycle(JSON.stringify(last), last.resolvedSelection);
    expect(pendingTaskReadPages(lastMessages, lastMessages, partial)).toEqual([]);
    const acknowledged = pendingTaskReadPages(originalMessages, lastMessages, partial);
    expect(acknowledged).toMatchObject([{ startByte: 20, endByte: 20 }]);
    expect(pendingTaskReadPages(originalMessages, [], acknowledged)).toEqual(acknowledged);
    expect(pendingTaskReadPages([], [], acknowledged)).toEqual([]);
  });

  test("unpaired, ambiguous, errored and mismatched receipts cannot publish or clear presentation debt", () => {
    const receipt = page("source bytes");
    const valid = cycle(JSON.stringify(receipt), receipt.resolvedSelection);
    const debt = pendingTaskReadPages(valid, []);
    const errored = cycle(JSON.stringify(receipt), receipt.resolvedSelection);
    (errored.at(-1) as ToolMessage).status = "error";
    const wrongTask = cycle(JSON.stringify(receipt), { ...receipt.resolvedSelection, taskId: "different-task" });
    const duplicate = new AIMessage({ content: "", tool_calls: [{ id: "read-call", name: "task", args: receipt.resolvedSelection }] });
    const invalid = [[valid.at(-1)!], [valid[0]!, valid[1]!, duplicate, valid[2]!], errored, wrongTask];
    for (const messages of invalid) {
      expect(pendingTaskReadPages(messages, [])).toEqual([]);
      expect(pendingTaskReadPages([], messages, debt)).toEqual(debt);
    }
  });
});
