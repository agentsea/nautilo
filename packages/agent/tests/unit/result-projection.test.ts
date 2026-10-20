import { z } from "zod";
import { describe, expect, test, spyOn } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { projectToolResults, withResultReader } from "../../src/tools/result-reader/result-projection";
import { resultVersion, resultReferenceSchema } from "../../src/tools/result-reader/result-window";
import { resolveRetainedResult, type ResultReaderContext } from "../../src/tools/result-reader/read-tool-result";
import * as store from "../../src/store/session-store";

const parseReceipt = (text: string) => z.object({ kind: z.string(), outcome: z.string().optional(), reference: resultReferenceSchema.optional(), read: z.object({ reference: resultReferenceSchema, operation: z.string(), path: z.array(z.string()).optional(), offset: z.number().optional() }) }).parse(JSON.parse(text));

async function rejects(promise: Promise<unknown>, message: string) {
  const error: unknown = await promise.then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

const source = JSON.stringify({ rows: ["first", "x".repeat(20000), "last"] });
const message = new ToolMessage({ name: "officecli", tool_call_id: "call", content: source, status: "success" });
const ctx: ResultReaderContext = { userId: "owner", agentId: "agent", roomId: "room", resultReaderThreadId: "thread", taskReadMessages: [message] };

describe("retained output presentation", () => {
  test("projection leaves canonical bytes untouched and reference reads the complete result", async () => {
    const projected = projectToolResults([message], 2000)[0]!;
    const receipt = parseReceipt(projected.content as string);
    expect(receipt.outcome).toBe("success");
    expect(receipt.read.operation).toBe("inspect");
    expect(message.content).toBe(source);
    expect(await resolveRetainedResult(receipt.reference!, ctx)).toBe(source);
    expect(projectToolResults([projected], 10)[0]).toBe(projected);
  });
  test("overflow presentation preserves an unsuccessful producer outcome", () => {
    const failed = new ToolMessage({ name: "officecli", tool_call_id: "failed", content: source, status: "error" });
    const projection = projectToolResults([failed], 2000)[0]!;
    expect(parseReceipt(projection.content as string).outcome).toBe("error");
    expect(failed.content).toBe(source);
  });
  test("saved call reread after state reload uses the current execution authority", async () => {
    const lookup = spyOn(store, "readExecutionToolResult").mockResolvedValue({ content: source, toolName: "officecli" });
    try {
      expect(await resolveRetainedResult({ kind: "call", callId: "call", sourceVersion: resultVersion(source) }, { ...ctx, taskReadMessages: [] })).toBe(source);
      expect(lookup).toHaveBeenCalledWith({ ownerId: "owner", agentId: "agent", graphThreadId: "thread", callId: "call" });
    } finally { lookup.mockRestore(); }
  });
  test("missing, modified, protected and cross-room results fail explicitly", async () => {
    const lookup = spyOn(store, "readExecutionToolResult").mockResolvedValue(null);
    try {
      const reference = { kind: "call" as const, callId: "call", sourceVersion: resultVersion(source) };
      await rejects(resolveRetainedResult(reference, { ...ctx, taskReadMessages: [] }), "unavailable");
      await rejects(resolveRetainedResult({ ...reference, sourceVersion: resultVersion("different") }, ctx), "changed");
      await rejects(resolveRetainedResult(reference, { ...ctx, fullEncryptionOnly: true }), "authority");
      await rejects(resolveRetainedResult({ kind: "room", roomId: "other", messageId: 1, sourceVersion: reference.sourceVersion }, ctx), "another Room");
    } finally { lookup.mockRestore(); }
  });
  test("old reader pages refer to the original source without nesting result files", () => {
    const reference = { kind: "call" as const, callId: "call", sourceVersion: resultVersion(source) };
    const page = new ToolMessage({ name: "read_tool_result", tool_call_id: "read", content: JSON.stringify({ reference, path: ["rows"], startByte: 25, text: source }) });
    const receipt = parseReceipt(projectToolResults([page], 2000)[0]!.content as string);
    expect(receipt.kind).toBe("replay");
    expect(receipt.read).toEqual({ reference, operation: "read", path: ["rows"], offset: 25 });
  });
  test("only output-producing whitelists acquire the reader dependency", () => {
    expect(withResultReader([])).toEqual([]);
    expect(withResultReader(["officecli", "file"])).toEqual(["officecli", "file", "read_tool_result"]);
    expect(withResultReader(["security_scan"])).toEqual(["security_scan"]);
  });
});
