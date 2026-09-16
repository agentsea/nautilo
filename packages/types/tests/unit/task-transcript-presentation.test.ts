import { describe, expect, test } from "bun:test";
import {
  projectTaskTranscriptToolArgs,
  projectTaskTranscriptToolResult,
  taskRunTranscriptToPresentation,
} from "../../src/task-transcript-presentation";
import type { TaskRunTranscriptMessage } from "../../src/task-api";

const row = (partial: Partial<TaskRunTranscriptMessage> & Pick<TaskRunTranscriptMessage, "role">): TaskRunTranscriptMessage => ({ content: "", toolName: null, toolCalls: null, createdAt: "2026-08-21T00:00:00.000Z", ...partial });

describe("D547 task transcript projection", () => {
  test("pairs durable results and gives identified/null calls stable distinct keys", () => {
    const projected = taskRunTranscriptToPresentation([
      row({ role: "assistant", content: "before", toolCalls: [{ name: "read", id: "read-call", args: { token: "no" } }, { name: "write", id: "write-call", args: {} }, { name: "none", id: null, args: {} }] }),
      row({ role: "tool", toolName: "write", toolCallId: "write-call", content: "written" }),
      row({ role: "tool", toolName: "read", toolCallId: "read-call", content: "read" }),
      row({ role: "tool", toolName: "orphan", content: "receipt" }),
      row({ role: "system", content: "Desktop compatibility" }),
    ], "run-x");
    expect(projected.map((item) => item.content)).toEqual(["before", "read", "write", "none", "Desktop compatibility"]);
    expect(projected.map((item) => item.key)).toEqual(["run-x:source:0:assistant", "run-x:source:0:call:0:read-call", "run-x:source:0:call:1:write-call", "run-x:source:0:call:2:none", "run-x:source:4:system"]);
    expect(projected[1]?.resultText).toBe("read");
    expect(projected[2]?.resultText).toBe("written");
    expect(projected[3]?.resultText).toBe("receipt");
    expect(projected[1]?.args).toEqual({});
  });

  test("redacts credentials/capabilities and fails closed for hostile or malformed values", () => {
    const source: Record<string, unknown> = { nested: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz", cursor: "opaque", finite: 1, nan: Number.NaN }, text: "eyJabcdefgh.eyJabcdefgh.abcdefgh" };
    const safe = projectTaskTranscriptToolArgs(source);
    expect(safe).toEqual({ nested: { finite: 1, nan: "[omitted]" }, text: "[redacted]" });
    expect(source["nested"]).not.toEqual(safe["nested"]);
    const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
    expect(projectTaskTranscriptToolArgs(cyclic)).toEqual({ self: "[omitted]" });
    expect(projectTaskTranscriptToolResult('{"cursor":"unterminated"')).toBe("[structured result could not be safely previewed]");
    expect(projectTaskTranscriptToolResult("Bearer abcdefghijklmnopqrstuvwxyz")).toBe("Bearer [redacted]");
    const oversized = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`p${index}`, "x".repeat(4_096)]));
    expect(projectTaskTranscriptToolArgs(oversized)).toEqual({});
  });

  test("prefers exact later names, falls back once, bounds hostile structures, and never calls raw getters", () => {
    const projected = taskRunTranscriptToPresentation([
      row({ role: "assistant", toolCalls: [{ name: "read", id: null, args: {} }, { name: "write", id: null, args: {} }] }),
      row({ role: "tool", toolName: "write", content: "W" }),
      row({ role: "tool", toolName: "other", content: "R" }),
      row({ role: "tool", toolName: "orphan", content: "O" }),
    ], "run");
    expect(projected.map((item) => [item.toolName, item.resultText])).toEqual([["read", "W"], ["write", "R"], ["orphan", "O"]]);
    let reads = 0;
    const hostile = {} as Record<string, unknown>;
    Object.defineProperty(hostile, "secret", { enumerable: true, get() { reads += 1; return "leak"; } });
    expect(projectTaskTranscriptToolArgs(hostile)).toEqual({});
    expect(reads).toBe(0);
    const depth = { child: { child: { child: { child: { child: { child: "no" } } } } } };
    expect(JSON.stringify(projectTaskTranscriptToolArgs(depth))).toContain("[omitted]");
    expect(projectTaskTranscriptToolResult("x".repeat(262_145))).toBe("[result too large to preview]");
    expect(projectTaskTranscriptToolArgs({ token: "raw", list: Array.from({ length: 80 }, () => "x") })).not.toHaveProperty("token");
  });
});


test("exact result IDs preserve reversed file outcomes and ambiguous IDs never borrow status", () => {
  const call = (id: string, path: string) => ({ id, name: "file", args: { command: "read", path } });
  const projected = taskRunTranscriptToPresentation([
    row({ role: "assistant", toolCalls: [call("a", "a.ts"), call("b", "b.ts")] }),
    row({ role: "tool", toolName: "file", toolCallId: "b", toolStatus: "error", content: "Investigation blocked" }),
    row({ role: "tool", toolName: "file", toolCallId: "a", toolStatus: "success", content: "Error: literal source" }),
  ]);
  expect(projected.map((item) => [item.args?.["path"], item.toolStatus, item.resultText])).toEqual([
    ["a.ts", "success", "Error: literal source"], ["b.ts", "error", "Investigation blocked"],
  ]);
  const ambiguous = taskRunTranscriptToPresentation([
    row({ role: "assistant", toolCalls: [call("same", "a.ts"), call("same", "b.ts")] }),
    row({ role: "tool", toolName: "file", toolCallId: "same", toolStatus: "error", content: "Blocked" }),
  ]);
  expect(ambiguous.slice(0, 2).map((item) => item.toolStatus)).toEqual([undefined, undefined]);
  expect(ambiguous[2]).toMatchObject({ args: {}, toolStatus: "error", resultText: "Blocked" });
  const legacy = taskRunTranscriptToPresentation([row({ role: "assistant", toolCalls: [call("old", "old.ts")] }),
    row({ role: "tool", toolName: "file", content: "Success-shaped legacy output" })]);
  expect(legacy[0]?.toolStatus).toBeUndefined();
});


test("sequentially reused IDs are globally ambiguous and known IDs cannot borrow legacy results", () => {
  const call = (path: string) => ({ id: "reused", name: "file", args: { command: "read", path } });
  const projected = taskRunTranscriptToPresentation([
    row({ role: "assistant", toolCalls: [call("first.ts")] }),
    row({ role: "tool", toolName: "file", toolCallId: "reused", toolStatus: "success", content: "first result" }),
    row({ role: "assistant", toolCalls: [call("second.ts")] }),
    row({ role: "tool", toolName: "file", toolCallId: "reused", toolStatus: "error", content: "second blocked" }),
    row({ role: "tool", toolName: "file", content: "legacy result" }),
  ]);
  const attempted = projected.filter((item) => item.args?.["path"]);
  expect(attempted.map((item) => item.resultText)).toEqual([undefined, undefined]);
  expect(attempted.map((item) => item.toolStatus)).toEqual([undefined, undefined]);
  expect(projected.filter((item) => item.resultText).map((item) => item.resultText)).toEqual(["first result", "second blocked", "legacy result"]);
  const unmatched = taskRunTranscriptToPresentation([
    row({ role: "assistant", toolCalls: [{ ...call("known.ts"), id: "unique" }] }),
    row({ role: "tool", toolName: "file", content: "unbound legacy result" }),
  ]);
  expect(unmatched[0]?.resultText).toBeUndefined();
  expect(unmatched[1]).toMatchObject({ args: {}, resultText: "unbound legacy result" });
});

test("duplicate conflicting receipts keep the attempted operation and both outcomes unknown", () => {
  for (const statuses of [["success", "error"], ["error", "success"]] as const) {
    const source = [
      row({ role: "assistant", toolCalls: [{ id: "read-one", name: "file", args: { command: "read", path: "tokens.ts" } }] }),
      row({ role: "tool", toolName: "file", toolCallId: "read-one", toolStatus: statuses[0], content: "first receipt" }),
      row({ role: "tool", toolName: "file", toolCallId: "read-one", toolStatus: statuses[1], content: "conflicting receipt" }),
    ];
    const projected = taskRunTranscriptToPresentation(source);
    expect(projected).toHaveLength(3);
    expect(projected.map((item) => item.toolStatus)).toEqual([undefined, undefined, undefined]);
    expect(projected[0]).toMatchObject({ args: { command: "read", path: "tokens.ts" } });
    expect(projected[0]?.resultText).toBeUndefined();
    expect(projected.slice(1).map((item) => [item.args, item.resultText])).toEqual([
      [{}, "first receipt"], [{}, "conflicting receipt"],
    ]);
    expect(source.slice(1).map((item) => item.toolStatus)).toEqual([...statuses]);
  }
});
