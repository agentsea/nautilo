import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskOperationRequestV1 } from
  "../../electron/task-operation-ipc";

const taskId = "91000000-0000-4000-8000-000000000001";
const summary = {
  id: taskId,
  parentTaskId: null,
  depth: 0,
  status: "pending",
  preset: "task",
  scheduleKind: "cron",
  nextFireAt: null,
  callingRoomId: null,
  content: {
    dtoVersion: 1,
    status: "protected",
    objectId: `task:v1:${taskId}:1`,
    contentRevision: 1,
    cryptoAccessRevision: 0,
  },
};
const payload = {
  formatVersion: 1,
  prompt: "private prompt",
  expectedOutput: null,
  protectedMetadata: {},
};

describe("Desktop Task operation IPC", () => {
  test("accepts bounded product intent while Electron main retains crypto custody", () => {
    expect(parseTaskOperationRequestV1({ version: 1, operation: "list" }))
      .toEqual({ version: 1, operation: "list" });
    expect(parseTaskOperationRequestV1({
      version: 1, operation: "open", task: summary,
    }).operation).toBe("open");
    expect(parseTaskOperationRequestV1({
      version: 1, operation: "create", payload, task: {},
    }).operation).toBe("create");
    expect(parseTaskOperationRequestV1({
      version: 1, operation: "update", current: summary, payload, task: {},
    }).operation).toBe("update");
  });

  test("rejects prepared ciphertext, extra fields, and malformed plaintext", () => {
    expect(() => parseTaskOperationRequestV1({
      version: 1, operation: "create", prepared: { encryptedPayload: "ciphertext" },
    })).toThrow();
    expect(() => parseTaskOperationRequestV1({
      version: 1, operation: "list", prompt: "plaintext",
    })).toThrow();
    expect(() => parseTaskOperationRequestV1({
      version: 1, operation: "create",
      payload: { ...payload, prompt: "" },
      task: {},
    })).toThrow();
    expect(() => parseTaskOperationRequestV1({
      version: 1, operation: "update", current: { ...summary, id: "not-a-uuid" },
      payload, task: {},
    })).toThrow();
  });

  test("main handler gates the sender and delegates every protected operation", () => {
    const main = readFileSync(join(import.meta.dir, "../../electron/main.ts"), "utf8");
    const preload = readFileSync(join(import.meta.dir, "../../electron/preload.ts"), "utf8");
    const start = main.indexOf('ipcMain.handle("foregroundShadow:task:operateV1"');
    const end = main.indexOf('ipcMain.handle("foregroundShadow:memory:list"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = main.slice(start, end);
    expect(handler).toContain("parseTaskOperationRequestV1(raw)");
    expect(handler).toContain("foregroundShadowControllerForSender(e)");
    expect(handler).toContain("controller.taskList");
    expect(handler).toContain("controller.taskOpen");
    expect(handler).toContain("controller.taskCreate");
    expect(handler).toContain("controller.taskUpdate");
    expect(preload).toContain('ipcRenderer.invoke("foregroundShadow:task:operateV1", request)');
  });
});
