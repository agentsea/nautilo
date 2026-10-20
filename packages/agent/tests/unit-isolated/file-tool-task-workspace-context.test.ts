import { describe, expect, mock, test } from "bun:test";
import { runWithTurn } from "@nautilo/logger";
import type { DispatchContext } from "../../src/tools/file/dispatch";

const dispatched: DispatchContext[] = [];
mock.module("../../src/tools/file/dispatch", () => ({
  dispatchFileCommand: async (_args: unknown, context: DispatchContext) => {
    dispatched.push(context);
    return "dispatched";
  },
}));
const { createFileTool } = await import("../../src/tools/file/file-tool");

const envelope = {
  memoryMode: "namespace" as const,
  ownerId: "owner-1", actorId: "human-1", agentId: "agent-1",
  roomId: "workspace-room", readableNamespaces: ["workspace-namespace"],
  mutableNamespaces: ["workspace-namespace"], writableNamespaces: ["workspace-namespace"],
  toolPolicy: {},
};
function taskContext() {
  return {
    ownerId: "owner-1", agentId: "agent-1", roomId: "",
    callingRoomId: "different-calling-room",
    currentTaskId: "task-1", currentTaskRunId: "run-1",
    memoryAccessEnvelope: envelope,
  };
}
async function write(context: Record<string, unknown>, path = "report.md") {
  await runWithTurn("task-turn", () => createFileTool(context).invoke({
    command: "write", zone: "workspace", path, content: "synthetic output",
  }, { configurable: { fileToolMutationRequestId: `call:${path}` } }));
  return dispatched.at(-1)!;
}

describe("background Task file workspace context", () => {
  test("Markdown and CSV writes use the authorized envelope room without changing the transcript or envelope", async () => {
    const context = taskContext();
    for (const path of ["report.md", "candidates.csv"]) {
      const result = await write(context, path);
      expect(result.roomId).toBe("workspace-room");
      expect(result.memoryAccessEnvelope).toBe(envelope);
      expect(result.turnId).toBe("task-turn");
      expect(result.mutationRequestId).toBeTruthy();
    }
    expect(context.roomId).toBe("");
    expect(context.callingRoomId).toBe("different-calling-room");
  });

  test("preserves an explicit foreground or Task room", async () => {
    expect((await write({ ...taskContext(), roomId: "explicit-room" })).roomId).toBe("explicit-room");
  });

  test("does not infer a workspace room without both durable Task identities", async () => {
    for (const missing of ["currentTaskId", "currentTaskRunId"]) {
      expect((await write({ ...taskContext(), [missing]: "" })).roomId).toBeUndefined();
    }
  });

  test("rejects cross-owner and cross-agent envelopes rather than using the calling room", async () => {
    for (const mismatch of ["ownerId", "agentId"]) {
      expect((await write({ ...taskContext(), memoryAccessEnvelope: { ...envelope, [mismatch]: "other" } })).roomId).toBeUndefined();
    }
  });

  test("does not promote scope-only or missing authority to Room authority", async () => {
    for (const memoryAccessEnvelope of [null, { ...envelope, roomId: "" }, { ...envelope, memoryMode: "scope", scopeId: "scope-1" }]) {
      expect((await write({ ...taskContext(), memoryAccessEnvelope })).roomId).toBeUndefined();
    }
  });
});
