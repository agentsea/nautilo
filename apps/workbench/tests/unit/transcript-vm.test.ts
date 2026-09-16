import { describe, expect, test } from "bun:test";
import type { TaskDetail, TaskRunTranscriptMessage } from "@nautilo/types";
import { taskDetailToVMs, taskRunToVMs } from "../../src/modes/rooms/subagents/transcript-vm";

function wire(partial: Partial<TaskRunTranscriptMessage> & Pick<TaskRunTranscriptMessage, "role">): TaskRunTranscriptMessage {
  return {
    content: "",
    toolName: null,
    toolCalls: null,
    createdAt: "2026-06-15T12:00:00.000Z",
    ...partial,
  };
}

describe("taskRunToVMs", () => {
  test("passthrough user and system text rows", () => {
    const out = taskRunToVMs([
      wire({ role: "user", content: "hello", createdAt: "2026-06-15T11:00:00.000Z" }),
      wire({ role: "system", content: "sys note", createdAt: "2026-06-15T11:00:01.000Z" }),
    ]);
    expect(out).toEqual([
      { key: "run:source:0:user", role: "user", content: "hello", createdAt: "2026-06-15T11:00:00.000Z" },
      { key: "run:source:1:system", role: "system", content: "sys note", createdAt: "2026-06-15T11:00:01.000Z" },
    ]);
  });

  test("assistant text row with non-empty content", () => {
    const out = taskRunToVMs([
      wire({
        role: "assistant",
        content: "On it.",
        createdAt: "2026-06-15T11:00:04.000Z",
      }),
    ]);
    expect(out).toEqual([
      { key: "run:source:0:assistant", role: "assistant", content: "On it.", createdAt: "2026-06-15T11:00:04.000Z" },
    ]);
  });

  test("pairs assistant toolCalls with matching recorded result identity and outcome", () => {
    const out = taskRunToVMs([
      wire({
        role: "assistant",
        content: "",
        toolCalls: [{ name: "run_shell", args: { command: "bun test" }, id: "c1" }],
        createdAt: "2026-06-15T11:00:09.000Z",
      }),
      wire({
        role: "tool",
        toolName: "run_shell",
        content: "all passed",
        toolCallId: "c1",
        toolStatus: "success",
        createdAt: "2026-06-15T11:00:10.000Z",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      key: "run:source:0:call:0:c1",
      role: "tool",
      content: "run_shell",
      toolName: "run_shell",
      args: { command: "bun test" },
      resultText: "all passed",
      toolCallId: "c1",
      toolStatus: "success",
      createdAt: "2026-06-15T11:00:09.000Z",
    });
  });

  test("running tool call with no following tool row omits resultText", () => {
    const out = taskRunToVMs([
      wire({
        role: "assistant",
        content: "",
        toolCalls: [{ name: "read_file", args: { path: "a.ts" }, id: "c1" }],
        createdAt: "2026-06-15T11:00:09.000Z",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.resultText).toBeUndefined();
    expect(out[0]?.toolName).toBe("read_file");
  });

  test("multiple tool calls pair by exact identity despite reversed receipt order", () => {
    const out = taskRunToVMs([
      wire({
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "read_file", args: { path: "a.ts" }, id: "c1" },
          { name: "run_shell", args: { command: "ls" }, id: "c2" },
        ],
        createdAt: "2026-06-15T11:00:09.000Z",
      }),
      wire({
        role: "tool",
        toolName: "run_shell",
        content: "out.txt",
        toolCallId: "c2",
        toolStatus: "success",
        createdAt: "2026-06-15T11:00:10.000Z",
      }),
      wire({
        role: "tool",
        toolName: "read_file",
        content: "file body",
        toolCallId: "c1",
        createdAt: "2026-06-15T11:00:11.000Z",
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.toolName).toBe("read_file");
    expect(out[0]?.resultText).toBe("file body");
    expect(out[1]?.toolName).toBe("run_shell");
    expect(out[1]?.resultText).toBe("out.txt");
    expect(out[0]?.toolStatus).toBeUndefined();
    expect(out[1]?.toolStatus).toBe("success");
  });

  test("orphan tool row not consumed by a preceding call becomes fallback", () => {
    const out = taskRunToVMs([
      wire({
        role: "tool",
        toolName: null,
        content: "unexpected result",
        createdAt: "2026-06-15T11:00:05.000Z",
      }),
    ]);
    expect(out).toEqual([
      {
        key: "run:source:0:orphan-tool",
        role: "tool",
        content: "unexpected result",
        toolName: "tool",
        args: {},
        resultText: "unexpected result",
        createdAt: "2026-06-15T11:00:05.000Z",
      },
    ]);
  });

  test("assistant row with both content and toolCalls emits both", () => {
    const out = taskRunToVMs([
      wire({
        role: "assistant",
        content: "Checking now.",
        toolCalls: [{ name: "grep", args: { pattern: "foo" }, id: "c1" }],
        createdAt: "2026-06-15T11:00:08.000Z",
      }),
      wire({
        role: "tool",
        toolName: "grep",
        content: "match",
        toolCallId: "c1",
        createdAt: "2026-06-15T11:00:09.000Z",
      }),
    ]);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"]);
    expect(out[0]?.content).toBe("Checking now.");
    expect(out[1]?.resultText).toBe("match");
  });

  test("stable keys distinguish same-timestamp rows and survive receipt arrival and appended progress", () => {
    const prefix = [wire({ role: "user", content: "Audit" }), wire({ role: "assistant", content: "Inspecting two files", toolCalls: [
      { id: "first", name: "file", args: { command: "read", path: "a.ts" } },
      { id: "second", name: "file", args: { command: "read", path: "b.ts" } },
    ] })];
    const pending = taskRunToVMs(prefix);
    const refreshed = taskRunToVMs([...prefix.map((message) => ({ ...message })),
      wire({ role: "tool", toolName: "file", toolCallId: "second", toolStatus: "success", content: "B source" }),
      wire({ role: "tool", toolName: "file", toolCallId: "first", toolStatus: "success", content: "A source" }),
      wire({ role: "assistant", content: "Saved the cross-file trace" }),
    ]);
    const keys = pending.map((message) => message.key);
    expect(new Set(keys).size).toBe(pending.length);
    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
    expect(refreshed.slice(0, pending.length).map((message) => message.key)).toEqual(keys);
    expect(refreshed[2]?.resultText).toBe("A source");
    expect(refreshed[3]?.resultText).toBe("B source");
    expect(refreshed.at(-1)?.key).not.toBeOneOf(keys);
  });

  test("preserves chronological order across mixed rows", () => {
    const out = taskRunToVMs([
      wire({ role: "user", content: "go", createdAt: "t1" }),
      wire({ role: "assistant", content: "ok", createdAt: "t2" }),
      wire({
        role: "assistant",
        content: "",
        toolCalls: [{ name: "run_shell", args: {}, id: "c1" }],
        createdAt: "t3",
      }),
      wire({ role: "tool", toolName: "run_shell", toolCallId: "c1", content: "done", createdAt: "t4" }),
      wire({ role: "assistant", content: "finished", createdAt: "t5" }),
    ]);
    expect(out.map((m) => m.content)).toEqual(["go", "ok", "run_shell", "finished"]);
    expect(out[2]?.resultText).toBe("done");
  });

  test("known call identity never borrows a legacy result when names differ", () => {
    const out = taskRunToVMs([
      wire({
        role: "assistant",
        content: "",
        toolCalls: [{ name: "read_file", args: {}, id: "c1" }],
        createdAt: "t1",
      }),
      wire({
        role: "tool",
        toolName: "other_tool",
        content: "payload",
        createdAt: "t2",
      }),
    ]);
    expect(out[0]?.toolName).toBe("read_file");
    expect(out).toHaveLength(2);
    expect(out[0]?.resultText).toBeUndefined();
    expect(out[1]).toMatchObject({ toolName: "other_tool", args: {}, resultText: "payload" });
    expect(out.map((message) => message.toolStatus)).toEqual([undefined, undefined]);
  });

  test("legacy results remain visible and unknown beside known calls even when names match", () => {
    const out = taskRunToVMs([
      wire({ role: "assistant", toolCalls: [{ name: "file", args: { command: "read", path: "a.ts" }, id: "known" }] }),
      wire({ role: "tool", toolName: "file", content: "Success-shaped legacy output" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ toolName: "file", args: { command: "read", path: "a.ts" } });
    expect(out[0]?.resultText).toBeUndefined();
    expect(out[1]).toMatchObject({ toolName: "file", args: {}, resultText: "Success-shaped legacy output" });
    expect(out.map((message) => message.toolStatus)).toEqual([undefined, undefined]);
  });

  test("fully ID-less legacy history retains display-only pairing without inventing success", () => {
    const out = taskRunToVMs([
      wire({ role: "assistant", toolCalls: [{ name: "read_file", args: { path: "legacy.ts" }, id: null }] }),
      wire({ role: "tool", toolName: "other_tool", content: "legacy payload" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toolName: "read_file", args: { path: "legacy.ts" }, resultText: "legacy payload" });
    expect(out[0]?.toolCallId).toBeUndefined();
    expect(out[0]?.toolStatus).toBeUndefined();
  });
});

describe("taskDetailToVMs", () => {
  test("uses the last run transcript", () => {
    const detail: TaskDetail = {
      task: {
        id: "task-1",
        status: "running",
        preset: "default",
        prompt: "work",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        expectedOutput: null,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        scopeId: null,
        toolsMode: "all",
        toolsWhitelist: [],
        parentTaskId: null,
        depth: 0,
        selectionProfile: "balanced",
        selectionSpec: null,
        createdAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T10:00:00.000Z",
      },
      runs: [
        {
          id: "run-1",
          status: "completed",
          modelId: "m1",
          resultText: null,
          lastError: null,
          startedAt: "2026-06-15T10:00:00.000Z",
          completedAt: "2026-06-15T10:01:00.000Z",
          transcript: [
            wire({ role: "user", content: "first run", createdAt: "t-old" }),
          ],
        },
        {
          id: "run-2",
          status: "running",
          modelId: "m2",
          resultText: null,
          lastError: null,
          startedAt: "2026-06-15T11:00:00.000Z",
          completedAt: null,
          transcript: [
            wire({ role: "user", content: "latest run", createdAt: "t-new" }),
          ],
        },
      ],
    };
    const out = taskDetailToVMs(detail);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe("latest run");
  });

  test("returns empty when there are no runs", () => {
    const detail: TaskDetail = {
      task: {
        id: "task-1",
        status: "pending",
        preset: "default",
        prompt: "work",
        scheduleKind: "now",
        nextFireAt: null,
        callingRoomId: null,
        expectedOutput: null,
        cron: null,
        runAt: null,
        timezone: "UTC",
        targetChat: "orphan",
        resultDelivery: "wake",
        useScope: false,
        scopeId: null,
        toolsMode: "all",
        toolsWhitelist: [],
        parentTaskId: null,
        depth: 0,
        selectionProfile: "balanced",
        selectionSpec: null,
        createdAt: "2026-06-15T10:00:00.000Z",
        updatedAt: "2026-06-15T10:00:00.000Z",
      },
      runs: [],
    };
    expect(taskDetailToVMs(detail)).toEqual([]);
  });
});
