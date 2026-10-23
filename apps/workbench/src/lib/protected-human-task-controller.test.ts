import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";
import type { TaskContentSummaryV1, TaskDetail } from "@nautilo/types";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
} from "@nautilo/lattice-bridge";

const getTask = mock(async (_taskId: string): Promise<TaskDetail> => ({
  task: { id: "task-1" },
  runs: [],
} as TaskDetail));
const getTaskContentV1 = mock(async (_taskId: string) => {
  throw new Error("Task content fixture is unset");
});

mock.module("./api", () => ({
  apiClient: { getTask, getTaskContentV1 },
}));

const {
  listProtectedScheduledTasks,
  readWorkbenchTaskForViewer,
} = await import("./protected-human-task-controller");

const ordinary = {
  id: "task-1",
  agentId: "agent-1",
  scheduleKind: "cron",
  content: {
    dtoVersion: 1,
    status: "ordinary",
    promptPreview: "stale",
    lastError: "source error",
  },
} as TaskContentSummaryV1;

const unavailable = {
  ...ordinary,
  content: {
    dtoVersion: 1,
    status: "unavailable",
    reason: "device_not_ready",
  },
} as TaskContentSummaryV1;

const repaired = {
  ...ordinary,
  content: {
    dtoVersion: 1,
    status: "protected",
    objectId: "task-definition:2",
    contentRevision: 2,
    cryptoAccessRevision: 0,
  },
} as TaskContentSummaryV1;

function owner(
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only",
) {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: () => Promise.resolve({
        policy: { mode, shadowBehavior: "fallback" as const },
        revalidationToken: 1,
      }),
      revalidate: () => Promise.resolve(),
    },
  });
}

function opened(task = repaired) {
  return Object.freeze({
    task,
    content: Object.freeze({
      status: "protected" as const,
      payload: Object.freeze({
        formatVersion: 1 as const,
        prompt: "repaired prompt",
        expectedOutput: "repaired output",
        protectedMetadata: {},
      }),
      retainedHistoricalError: "source error",
    }),
  });
}

beforeEach(() => {
  getTask.mockClear();
  getTaskContentV1.mockClear();
  getTask.mockImplementation(async () => ({
    task: { id: "task-1" },
    runs: [],
  } as TaskDetail));
});

describe("protected Human Task Workbench routing", () => {
  test("Shadow sends an ordinary classification through the controller repair before viewer fallback", async () => {
    getTaskContentV1.mockImplementation(async () => ({
      task: ordinary,
      definition: { dtoVersion: 1, status: "ordinary", prompt: "stale",
        expectedOutput: null, lastError: "source error" },
      runs: [{ id: "run-1" }],
    } as never));
    const seen: TaskContentSummaryV1[] = [];
    const result = await readWorkbenchTaskForViewer({
      owner: owner("shadow_encryption"),
      taskId: ordinary.id,
      protectedController: {
        open: async task => {
          seen.push(task);
          return opened();
        },
      } as never,
    });
    expect(result).toEqual({
      representation: "protected",
      opened: opened(),
      runs: [{ id: "run-1" }],
    });
    expect(seen).toEqual([{ ...ordinary, content: ordinary.content }]);
    expect(getTask).not.toHaveBeenCalled();
  });

  test("Plain performs one legacy read and never classifies or repairs protected content", async () => {
    const detail = { task: { id: ordinary.id }, runs: [] } as TaskDetail;
    getTask.mockImplementation(async () => detail);
    let opens = 0;
    const result = await readWorkbenchTaskForViewer({
      owner: owner("plaintext_only"),
      taskId: ordinary.id,
      protectedController: { open: async () => {
        opens += 1;
        return opened();
      } } as never,
    });
    expect(result).toEqual({ representation: "ordinary", detail });
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getTaskContentV1).not.toHaveBeenCalled();
    expect(opens).toBe(0);
  });

  test("Full lets the controller reject an ordinary classification without legacy fallback", async () => {
    getTaskContentV1.mockImplementation(async () => ({
      task: ordinary,
      definition: { dtoVersion: 1, status: "ordinary", prompt: "stale",
        expectedOutput: null, lastError: "source error" },
      runs: [],
    } as never));
    let opens = 0;
    const error = await readWorkbenchTaskForViewer({
      owner: owner("encrypted_only"),
      taskId: ordinary.id,
      protectedController: { open: async task => {
        opens += 1;
        expect(task.content.status).toBe("ordinary");
        throw new ClassifiedDataOperationError(
          "recoverable_availability",
          "Full cannot repair an ordinary Task",
        );
      } } as never,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ClassifiedDataOperationError);
    expect(opens).toBe(1);
    expect(getTask).not.toHaveBeenCalled();
  });

  test("scheduled Tasks use the repaired summary returned by controller open", async () => {
    const seen: TaskContentSummaryV1[] = [];
    const rows = await listProtectedScheduledTasks({
      list: async () => [unavailable],
      open: async task => {
        seen.push(task);
        return opened();
      },
    } as never);
    expect(seen).toEqual([unavailable]);
    expect(rows).toEqual([{
      availability: "opened",
      task: repaired,
      prompt: "repaired prompt",
      expectedOutput: "repaired output",
      retainedHistoricalError: "source error",
    }]);
  });

  test.each([
    new ClassifiedDataOperationError(
      "integrity",
      "repair proof was substituted",
    ),
    new ApiError(409, "task_content_integrity_failure"),
  ])("scheduled Tasks isolate one exact integrity failure and keep healthy peers", async failure => {
    const invalid = {
      ...unavailable,
      id: "invalid-task",
    } as TaskContentSummaryV1;
    const healthy = {
      ...repaired,
      id: "healthy-task",
      scheduleKind: "one_shot",
    } as TaskContentSummaryV1;
    const invalidBefore = structuredClone(invalid);
    const healthyBefore = structuredClone(healthy);
    const rows = await listProtectedScheduledTasks({
      list: async () => [invalid, healthy],
      open: async task => {
        if (task === invalid) throw failure;
        return opened(healthy);
      },
    } as never);
    expect(rows).toEqual([{
      availability: "unavailable",
      task: invalid,
      reason: "integrity_failure",
    }, {
      availability: "opened",
      task: healthy,
      prompt: "repaired prompt",
      expectedOutput: "repaired output",
      retainedHistoricalError: "source error",
    }]);
    expect(rows[0]?.task).toBe(invalid);
    expect(rows[1]?.task).toBe(healthy);
    expect(invalid).toEqual(invalidBefore);
    expect(healthy).toEqual(healthyBefore);
  });

  test.each([
    new Error("network unavailable"),
    new ClassifiedDataOperationError("authority", "authority changed"),
    new ApiError(403, "task_content_integrity_failure"),
    new ApiError(409, "task_content_changed"),
    new ApiError(500, "task_content_integrity_failure"),
  ])("scheduled Tasks propagate non-integrity row failures", async failure => {
    await expect(listProtectedScheduledTasks({
      list: async () => [unavailable],
      open: async () => { throw failure; },
    } as never)).rejects.toBe(failure);
  });

  test("scheduled Tasks propagate list failures before opening rows", async () => {
    const failure = new Error("list unavailable");
    let opens = 0;
    await expect(listProtectedScheduledTasks({
      list: async () => { throw failure; },
      open: async () => {
        opens += 1;
        return opened();
      },
    } as never)).rejects.toBe(failure);
    expect(opens).toBe(0);
  });
});
