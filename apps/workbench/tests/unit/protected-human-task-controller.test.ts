import { expect, test } from "bun:test";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
} from "@nautilo/lattice-bridge";
import type {
  TaskContentSummaryV1,
  TaskDetail,
  TaskRunSummary,
} from "@nautilo/types";
import {
  openProtectedTaskById,
  listProtectedScheduledTasks,
  readWorkbenchTaskForViewer,
  readWorkbenchTaskRunResultForViewer,
  type WorkbenchProtectedHumanTaskController,
} from "../../src/lib/protected-human-task-controller";
import { apiClient } from "../../src/lib/api";

function operationOwner(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
  shadowBehavior: "fallback" | "strict" = "fallback",
) {
  return bindEncryptionDataOperationOwner({ policy: {
    resolve: async () => ({
      policy: { mode, shadowBehavior },
      revalidationToken: 1,
    }),
    revalidate: async () => {},
  } });
}

async function expectFailureClass(
  operation: Promise<unknown>,
  failureClass: "recoverable_availability" | "key_waiting" | "integrity"
    | "authority" | "unsupported",
): Promise<void> {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ failureClass });
}

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
          retainedHistoricalError: null,
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
      }, retainedHistoricalError: "Provider unavailable before protection" } };
    },
  } as WorkbenchProtectedHumanTaskController;

  const rows = await listProtectedScheduledTasks(controller);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    availability: "opened",
    prompt: "private schedule",
    retainedHistoricalError: "Provider unavailable before protection",
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
    open: async (task: TaskContentSummaryV1) => {
      openCalls += 1;
      expect(task).toEqual(waiting);
      throw new ClassifiedDataOperationError(
        "key_waiting",
        "Task repair is waiting for Device authority",
      );
    },
  } as unknown as WorkbenchProtectedHumanTaskController;

  expect(await listProtectedScheduledTasks(controller)).toEqual([{
    availability: "unavailable",
    task: waiting,
    reason: "waiting_for_authorization",
  }]);
  expect(openCalls).toBe(1);
});

test("Plain viewer preserves the exact legacy detail request and skips protected custody", async () => {
  const originalGetTask = apiClient.getTask;
  const originalGetTaskContent = apiClient.getTaskContentV1;
  const calls: string[] = [];
  const ordinaryDetail = { task: { id: "task-1", status: "running" }, runs: [] } as never;
  apiClient.getTask = (async (taskId: string) => {
    calls.push(`legacy-detail:${taskId}`);
    return ordinaryDetail;
  }) as typeof apiClient.getTask;
  apiClient.getTaskContentV1 = (async () => {
    calls.push("content-classification");
    throw new Error("Plain must not classify protected content");
  }) as typeof apiClient.getTaskContentV1;
  const protectedController = {
    open: async () => {
      calls.push("protected-open");
      throw new Error("Plain must not open protected content");
    },
  } as unknown as WorkbenchProtectedHumanTaskController;
  try {
    const read = await readWorkbenchTaskForViewer({
      owner: operationOwner("plaintext_only"), taskId: "task-1",
      protectedController,
    });
    expect(read).toEqual({ representation: "ordinary", detail: ordinaryDetail });
    expect(calls).toEqual(["legacy-detail:task-1"]);
  } finally {
    apiClient.getTask = originalGetTask;
    apiClient.getTaskContentV1 = originalGetTaskContent;
  }
});

test("Fallback viewer reads protected first and uses legacy only for an eligible failure", async () => {
  const originalGetTask = apiClient.getTask;
  const originalGetTaskContent = apiClient.getTaskContentV1;
  const calls: string[] = [];
  const ordinaryDetail = { task: { id: "task-1", status: "running" }, runs: [] } as never;
  const safeRun = {
    id: "40000000-0000-4000-8000-000000000001",
    status: "completed",
    modelId: "model-1",
    startedAt: "2026-10-09T10:00:00.000Z",
    completedAt: "2026-10-09T10:01:00.000Z",
    content: { dtoVersion: 1, status: "unavailable", reason: "unsupported_client" },
  } as const;
  let classification: "ordinary" | "protected" = "protected";
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
  let repairFailure = false;
  const protectedController = {
    open: async (task: TaskContentSummaryV1) => {
      calls.push("protected-open");
      if (repairFailure) {
        throw new ClassifiedDataOperationError(
          "key_waiting",
          "Task repair is waiting for Device authority",
        );
      }
      const openedTask = task.content.status === "ordinary"
        ? {
            ...task,
            content: {
              dtoVersion: 1 as const,
              status: "protected" as const,
              objectId: "object:2",
              contentRevision: 2,
              cryptoAccessRevision: 0,
            },
          }
        : task;
      return { task: openedTask, content: { status: "protected" as const, payload: {
        formatVersion: 1 as const, prompt: "private", expectedOutput: null,
        protectedMetadata: {},
      }, retainedHistoricalError: null } };
    },
  } as WorkbenchProtectedHumanTaskController;
  try {
    const owner = operationOwner("shadow_encryption", "fallback");
    const protectedRead = await readWorkbenchTaskForViewer({
      owner, taskId: "task-1", protectedController,
    });
    expect(protectedRead.representation).toBe("protected");
    expect(calls).toEqual(["content-classification", "protected-open"]);

    calls.length = 0;
    classification = "ordinary";
    expect(await readWorkbenchTaskForViewer({
      owner, taskId: "task-1", protectedController,
    })).toMatchObject({
      representation: "protected",
      opened: {
        task: {
          content: { status: "protected", contentRevision: 2 },
        },
      },
    });
    expect(calls).toEqual(["content-classification", "protected-open"]);

    calls.length = 0;
    repairFailure = true;
    expect(await readWorkbenchTaskForViewer({
      owner, taskId: "task-1", protectedController,
    })).toEqual({ representation: "ordinary", detail: ordinaryDetail });
    expect(calls).toEqual([
      "content-classification",
      "protected-open",
      "legacy-detail",
    ]);

    calls.length = 0;
    repairFailure = false;
    classification = "protected";
    expect(await readWorkbenchTaskForViewer({
      owner, taskId: "task-1",
    })).toEqual({ representation: "ordinary", detail: ordinaryDetail });
    expect(calls).toEqual(["content-classification", "legacy-detail"]);
  } finally {
    apiClient.getTask = originalGetTask;
    apiClient.getTaskContentV1 = originalGetTaskContent;
  }
});

test("Fallback viewer accepts the nested owner's ordinary outcome only through the outer owner", async () => {
  const originalGetTask = apiClient.getTask;
  const originalGetTaskContent = apiClient.getTaskContentV1;
  const calls: string[] = [];
  const detail = { task: { id: "task-1", status: "running" }, runs: [] } as never;
  apiClient.getTask = (async () => {
    calls.push("legacy-detail");
    return detail;
  }) as typeof apiClient.getTask;
  apiClient.getTaskContentV1 = (async () => {
    calls.push("content-classification");
    return {
      task: { id: "task-1", status: "running" },
      definition: { dtoVersion: 1, status: "protected", objectId: "object:1",
        contentRevision: 1, cryptoAccessRevision: 0 },
      runs: [],
    } as never;
  }) as typeof apiClient.getTaskContentV1;
  const protectedController = {
    open: async (task: TaskContentSummaryV1) => {
      calls.push("protected-open:ordinary");
      return { task, content: { status: "ordinary" as const, prompt: "plain",
        expectedOutput: null, lastError: null } };
    },
  } as WorkbenchProtectedHumanTaskController;
  try {
    expect(await readWorkbenchTaskForViewer({
      owner: operationOwner("shadow_encryption", "fallback"),
      taskId: "task-1",
      protectedController,
    })).toEqual({ representation: "ordinary", detail });
    expect(calls).toEqual([
      "content-classification",
      "protected-open:ordinary",
      "legacy-detail",
    ]);

    for (const owner of [
      operationOwner("shadow_encryption", "strict"),
      operationOwner("encrypted_only"),
    ]) {
      calls.length = 0;
      await expectFailureClass(readWorkbenchTaskForViewer({
        owner, taskId: "task-1", protectedController,
      }), "recoverable_availability");
      expect(calls).toEqual([
        "content-classification",
        "protected-open:ordinary",
      ]);
    }
  } finally {
    apiClient.getTask = originalGetTask;
    apiClient.getTaskContentV1 = originalGetTaskContent;
  }
});

test("Strict and Full viewers never use the legacy detail fallback", async () => {
  const originalGetTask = apiClient.getTask;
  const originalGetTaskContent = apiClient.getTaskContentV1;
  let legacyReads = 0;
  apiClient.getTask = (async () => {
    legacyReads += 1;
    throw new Error("legacy detail must stay closed");
  }) as typeof apiClient.getTask;
  apiClient.getTaskContentV1 = (async () => ({
    task: { id: "task-1", status: "running" },
    definition: { dtoVersion: 1, status: "ordinary", prompt: "plain",
      expectedOutput: null, lastError: null },
    runs: [],
  }) as never) as typeof apiClient.getTaskContentV1;
  try {
    for (const owner of [
      operationOwner("shadow_encryption", "strict"),
      operationOwner("encrypted_only"),
    ]) {
      await expectFailureClass(
        readWorkbenchTaskForViewer({ owner, taskId: "task-1" }),
        "key_waiting",
      );
    }
    expect(legacyReads).toBe(0);
  } finally {
    apiClient.getTask = originalGetTask;
    apiClient.getTaskContentV1 = originalGetTaskContent;
  }
});

test("Fallback viewer does not use legacy detail after integrity or authority failure", async () => {
  const originalGetTask = apiClient.getTask;
  const originalGetTaskContent = apiClient.getTaskContentV1;
  let legacyReads = 0;
  apiClient.getTask = (async () => {
    legacyReads += 1;
    throw new Error("legacy detail must stay closed");
  }) as typeof apiClient.getTask;
  try {
    for (const reason of ["integrity_failure", "authority_changed"] as const) {
      apiClient.getTaskContentV1 = (async () => ({
        task: { id: "task-1", status: "running" },
        definition: { dtoVersion: 1, status: "unavailable", reason },
        runs: [],
      }) as never) as typeof apiClient.getTaskContentV1;
      await expectFailureClass(readWorkbenchTaskForViewer({
        owner: operationOwner("shadow_encryption", "fallback"),
        taskId: "task-1",
      }), reason === "integrity_failure" ? "integrity" : "authority");
    }
    expect(legacyReads).toBe(0);
  } finally {
    apiClient.getTask = originalGetTask;
    apiClient.getTaskContentV1 = originalGetTaskContent;
  }
});

const ordinaryRun = {
  id: "run-plain",
  status: "completed",
  modelId: "model-plain",
  resultText: "ordinary result",
  lastError: null,
  startedAt: "2026-10-09T10:00:00.000Z",
  completedAt: "2026-10-09T10:01:00.000Z",
} satisfies TaskRunSummary;
const ordinaryDetail = {
  task: { id: "task-plain" },
  runs: [ordinaryRun],
} as TaskDetail;

test("Plain result presentation returns the real legacy run without protected crypto", async () => {
  let protectedReads = 0;
  const controller = {
    openResult: async () => {
      protectedReads += 1;
      throw new Error("Plain must not enter protected result custody");
    },
  } as unknown as WorkbenchProtectedHumanTaskController;

  expect(await readWorkbenchTaskRunResultForViewer({
    owner: operationOwner("plaintext_only"),
    taskId: "task-plain",
    taskRunId: "run-plain",
    agentId: "agent-plain",
    ordinaryDetail,
    protectedController: controller,
  })).toEqual({ representation: "ordinary", run: ordinaryRun });
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
    owner: operationOwner("encrypted_only"),
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

test("Fallback result uses a real ordinary sibling after an eligible protected failure", async () => {
  const controller = {
    openResult: async () => ({
      status: "unavailable" as const,
      reason: "result_not_protected" as const,
    }),
  } as unknown as WorkbenchProtectedHumanTaskController;
  expect(await readWorkbenchTaskRunResultForViewer({
    owner: operationOwner("shadow_encryption", "fallback"),
    taskId: "task-plain",
    taskRunId: "run-plain",
    agentId: "agent-plain",
    ordinaryDetail,
    protectedController: controller,
  })).toEqual({ representation: "ordinary", run: ordinaryRun });
});

test("Fallback result preserves precise unprotected status when no ordinary sibling exists", async () => {
  const controller = {
    openResult: async () => ({
      status: "unavailable" as const,
      reason: "result_not_protected" as const,
    }),
  } as unknown as WorkbenchProtectedHumanTaskController;
  expect(await readWorkbenchTaskRunResultForViewer({
    owner: operationOwner("shadow_encryption", "fallback"),
    taskId: "task-protected",
    taskRunId: "run-protected",
    agentId: "agent-protected",
    protectedController: controller,
  })).toEqual({
    representation: "protected",
    result: { status: "unavailable", reason: "result_not_protected" },
  });
});

test("Strict and Full result reads never use an ordinary sibling", async () => {
  let ordinaryResultReads = 0;
  const detail = Object.freeze({
    ...ordinaryDetail,
    get runs() {
      ordinaryResultReads += 1;
      return [ordinaryRun];
    },
  }) as TaskDetail;
  const controller = {
    openResult: async () => ({
      status: "unavailable" as const,
      reason: "result_not_protected" as const,
    }),
  } as unknown as WorkbenchProtectedHumanTaskController;
  for (const owner of [
    operationOwner("shadow_encryption", "strict"),
    operationOwner("encrypted_only"),
  ]) {
    await expectFailureClass(readWorkbenchTaskRunResultForViewer({
      owner,
      taskId: "task-plain",
      taskRunId: "run-plain",
      agentId: "agent-plain",
      ordinaryDetail: detail,
      protectedController: controller,
    }), "recoverable_availability");
  }
  expect(ordinaryResultReads).toBe(0);
});

test("Fallback result preserves structured integrity and authority outcomes without ordinary fallback", async () => {
  for (const reason of ["integrity_failure", "authority_changed"] as const) {
    let ordinaryResultReads = 0;
    const detail = Object.freeze({
      ...ordinaryDetail,
      get runs() {
        ordinaryResultReads += 1;
        return [ordinaryRun];
      },
    }) as TaskDetail;
    const controller = {
      openResult: async () => ({ status: "unavailable" as const, reason }),
    } as unknown as WorkbenchProtectedHumanTaskController;
    expect(await readWorkbenchTaskRunResultForViewer({
      owner: operationOwner("shadow_encryption", "fallback"),
      taskId: "task-plain",
      taskRunId: "run-plain",
      agentId: "agent-plain",
      ordinaryDetail: detail,
      protectedController: controller,
    })).toEqual({
      representation: "protected",
      result: { status: "unavailable", reason },
    });
    expect(ordinaryResultReads).toBe(0);
  }
});
