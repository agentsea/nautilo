import { expect, test } from "bun:test";
import type { TaskContentSummaryV1 } from "@nautilo/types";
import {
  openProtectedTaskById,
  listProtectedScheduledTasks,
  readWorkbenchTaskForViewer,
  readWorkbenchTaskRunResultForViewer,
  type WorkbenchProtectedHumanTaskController,
} from "../../src/lib/protected-human-task-controller";
import { apiClient } from "../../src/lib/api";

test("protected Task open resolves its separate projection before exact read", async () => {
  const calls: string[] = [];
  const task = {
    id: "30000000-0000-4000-8000-000000000248",
    content: { status: "protected" },
  } as TaskContentSummaryV1;
  const controller = {
    list: async () => { calls.push("protected-list"); return [task]; },
    open: async (selected: TaskContentSummaryV1) => {
      calls.push(`protected-open:${selected.id}`);
      return {
        task: selected,
        content: {
          status: "protected" as const,
          payload: {
            formatVersion: 1 as const,
            prompt: "private prompt",
            expectedOutput: null,
            protectedMetadata: {},
          },
        },
      };
    },
  } as WorkbenchProtectedHumanTaskController;

  const opened = await openProtectedTaskById(controller, task.id);
  expect(opened.content.status).toBe("protected");
  expect(calls).toEqual([
    "protected-list",
    `protected-open:${task.id}`,
  ]);
});

test("protected scheduled rows stay separate and open their protected definitions", async () => {
  const calls: string[] = [];
  const scheduled = {
    id: "30000000-0000-4000-8000-000000000248",
    scheduleKind: "cron",
    cron: "0 9 * * *",
    content: { status: "protected" },
  } as TaskContentSummaryV1;
  const immediate = {
    ...scheduled,
    id: "30000000-0000-4000-8000-000000000249",
    scheduleKind: "now",
  } as TaskContentSummaryV1;
  const controller = {
    list: async () => { calls.push("protected-list"); return [scheduled, immediate]; },
    open: async (task: TaskContentSummaryV1) => {
      calls.push(`protected-open:${task.id}`);
      return { task, content: { status: "protected" as const, payload: {
        formatVersion: 1 as const, prompt: "private schedule",
        expectedOutput: null, protectedMetadata: {},
      } } };
    },
  } as WorkbenchProtectedHumanTaskController;

  const rows = await listProtectedScheduledTasks(controller);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    availability: "opened",
    prompt: "private schedule",
  });
  expect(calls).toEqual([
    "protected-list",
    `protected-open:${scheduled.id}`,
  ]);
});

test("protected scheduled rows remain visible while device authorization is pending", async () => {
  const waiting = {
    id: "30000000-0000-4000-8000-000000000250",
    scheduleKind: "cron",
    cron: "0 9 * * *",
    content: {
      dtoVersion: 1,
      status: "unavailable",
      reason: "waiting_for_authorization",
    },
  } as TaskContentSummaryV1;
  let openCalls = 0;
  const controller = {
    list: async () => [waiting],
    open: async () => {
      openCalls += 1;
      throw new Error("unavailable Task must not be opened");
    },
  } as unknown as WorkbenchProtectedHumanTaskController;

  expect(await listProtectedScheduledTasks(controller)).toEqual([{
    availability: "unavailable",
    task: waiting,
    reason: "waiting_for_authorization",
  }]);
  expect(openCalls).toBe(0);
});

test("viewer preserves proven ordinary Tasks while gating protected reads by policy", async () => {
  const originalGetTask = apiClient.getTask;
  const originalGetTaskContent = apiClient.getTaskContentV1;
  const calls: string[] = [];
  const ordinaryDetail = { task: { id: "task-1", status: "running" }, runs: [] } as never;
  let classification: "ordinary" | "protected" = "ordinary";
  const safeRun = {
    id: "40000000-0000-4000-8000-000000000001",
    status: "completed",
    modelId: "model-1",
    startedAt: "2026-10-09T10:00:00.000Z",
    completedAt: "2026-10-09T10:01:00.000Z",
    content: { dtoVersion: 1, status: "unavailable", reason: "unsupported_client" },
  } as const;
  apiClient.getTask = (async () => {
    calls.push("legacy-detail");
    return ordinaryDetail;
  }) as typeof apiClient.getTask;
  apiClient.getTaskContentV1 = (async () => {
    calls.push("content-classification");
    return {
      task: { id: "task-1", status: "running" },
      definition: classification === "ordinary"
        ? { dtoVersion: 1, status: "ordinary", prompt: "plain",
            expectedOutput: null, lastError: null }
        : { dtoVersion: 1, status: "protected", objectId: "object:1",
            contentRevision: 1, cryptoAccessRevision: 0 },
      runs: [safeRun],
    } as never;
  }) as typeof apiClient.getTaskContentV1;
  const protectedController = {
    open: async (task: TaskContentSummaryV1) => {
      calls.push("protected-open");
      return { task, content: { status: "protected" as const, payload: {
        formatVersion: 1 as const, prompt: "private", expectedOutput: null,
        protectedMetadata: {},
      } } };
    },
  } as WorkbenchProtectedHumanTaskController;
  try {
    expect((await readWorkbenchTaskForViewer({
      mode: "plaintext_only", taskId: "task-1",
    })).representation).toBe("ordinary");
    expect(calls).toEqual(["legacy-detail"]);

    for (const mode of ["shadow_encryption", "encrypted_only"] as const) {
      calls.length = 0;
      expect((await readWorkbenchTaskForViewer({
        mode, taskId: "task-1", protectedController,
      })).representation).toBe("ordinary");
      expect(calls).toEqual(["content-classification", "legacy-detail"]);
    }

    calls.length = 0;
    classification = "protected";
    const protectedRead = await readWorkbenchTaskForViewer({
      mode: "shadow_encryption", taskId: "task-1", protectedController,
    });
    expect(protectedRead.representation).toBe("protected");
    if (protectedRead.representation !== "protected") {
      throw new Error("expected protected Task read");
    }
    expect(protectedRead.runs).toEqual([safeRun]);
    expect(calls).toEqual(["content-classification", "protected-open"]);
  } finally {
    apiClient.getTask = originalGetTask;
    apiClient.getTaskContentV1 = originalGetTaskContent;
  }
});

test("Plain result presentation never calls protected crypto", async () => {
  let protectedReads = 0;
  const controller = {
    openResult: async () => {
      protectedReads += 1;
      throw new Error("Plain must not enter protected result custody");
    },
  } as unknown as WorkbenchProtectedHumanTaskController;

  expect(await readWorkbenchTaskRunResultForViewer({
    mode: "plaintext_only",
    taskId: "task-plain",
    taskRunId: "run-plain",
    agentId: "agent-plain",
    protectedController: controller,
  })).toEqual({ representation: "ordinary" });
  expect(protectedReads).toBe(0);
});

test("protected result presentation preserves the exact Task, run, and Agent identity", async () => {
  const identities: unknown[] = [];
  const controller = {
    openResult: async (identity: unknown) => {
      identities.push(identity);
      return {
        status: "ready" as const,
        payload: {
          formatVersion: 1 as const,
          resultText: "private result",
          lastError: null,
        },
      };
    },
  } as unknown as WorkbenchProtectedHumanTaskController;

  expect(await readWorkbenchTaskRunResultForViewer({
    mode: "encrypted_only",
    taskId: "task-exact",
    taskRunId: "run-exact",
    agentId: "agent-exact",
    protectedController: controller,
  })).toEqual({
    representation: "protected",
    result: {
      status: "ready",
      payload: {
        formatVersion: 1,
        resultText: "private result",
        lastError: null,
      },
    },
  });
  expect(identities).toEqual([{
    taskId: "task-exact",
    taskRunId: "run-exact",
    agentId: "agent-exact",
  }]);
});

test("protected result presentation rejects unknown policy and absent custody", async () => {
  for (const input of [
    { mode: "unknown" as const, protectedController: undefined },
    { mode: "encrypted_only" as const, protectedController: undefined },
  ]) {
    await expect(readWorkbenchTaskRunResultForViewer({
      ...input,
      taskId: "task-1",
      taskRunId: "run-1",
      agentId: "agent-1",
    })).rejects.toMatchObject({ failureClass: "unsupported" });
  }
});
