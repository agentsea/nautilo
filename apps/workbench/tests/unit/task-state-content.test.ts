import { describe, expect, test } from "bun:test";
import type { TaskContentListV1, TaskContentSummaryV1 } from "@nautilo/types";
import { ApiError, NautiloApiClient, type NautiloApiFetch } from "@nautilo/api-client/browser";

import {
  listTaskStateSummaries,
  ordinaryTaskSummariesFromContentV1,
  taskStateRecordsFromContentV1,
} from "../../src/contexts/task-state/task-state-content";
import { createTaskStateStore } from "../../src/contexts/task-state/task-state-store";

function lifecycle(id: string): Omit<TaskContentSummaryV1, "content"> {
  return {
    id,
    parentTaskId: null,
    depth: 0,
    status: "running",
    preset: "in_background",
    scheduleKind: "now",
    nextFireAt: null,
    callingRoomId: null,
    agentId: "agent-1",
    agentName: "Genie",
    targetRoomId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    requestedModelId: null,
    lastModelId: null,
  };
}

describe("Workbench Task content-v1 seed adapter", () => {
  test("preserves the existing Plain summary shape exactly", () => {
    const row: TaskContentSummaryV1 = {
      ...lifecycle("ordinary-task"),
      content: {
        dtoVersion: 1,
        status: "ordinary",
        promptPreview: "  exact Plain preview  ",
        lastError: "plain failure text",
      },
    };

    expect(ordinaryTaskSummariesFromContentV1([row])).toEqual([{
      ...lifecycle("ordinary-task"),
      prompt: "  exact Plain preview  ",
      lastError: "plain failure text",
    }]);
  });

  test("keeps protected lifecycle in the canonical store without Plain fields", async () => {
    const rows: TaskContentListV1 = [{
      ...lifecycle("ordinary-task"),
      content: {
        dtoVersion: 1,
        status: "ordinary",
        promptPreview: "ordinary sibling remains visible",
        lastError: null,
      },
    }, {
      ...lifecycle("protected-task"),
      content: {
        dtoVersion: 1,
        status: "protected",
        objectId: "task-definition:v1:" + "a".repeat(64),
        contentRevision: 1,
        cryptoAccessRevision: 0,
      },
    }];
    const store = createTaskStateStore({
      listActiveTasks: async () => taskStateRecordsFromContentV1(rows),
    });

    await store.seed("mount");

    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().taskMap["ordinary-task"]).toMatchObject({
      prompt: "ordinary sibling remains visible",
      status: "running",
    });
    expect(store.getSnapshot().taskMap["protected-task"]).toMatchObject({
      id: "protected-task",
      status: "running",
      content: { status: "protected" },
    });
    expect("prompt" in store.getSnapshot().taskMap["protected-task"]).toBe(false);
    expect("lastError" in store.getSnapshot().taskMap["protected-task"]).toBe(false);
    expect(store.getSnapshot().runningSubagentsMap["ordinary-task"]).toBeDefined();
    expect(store.getSnapshot().runningSubagentsMap["protected-task"]).toMatchObject({
      prompt: "Encrypted Task",
      status: "running",
    });
    expect(store.getSnapshot().tasks.map((task) => task.id)).toEqual(["ordinary-task"]);
  });

  test("does not turn unavailable protected content into an untitled Plain Task", () => {
    const rows: TaskContentListV1 = [{
      ...lifecycle("waiting-task"),
      content: {
        dtoVersion: 1,
        status: "unavailable",
        reason: "waiting_for_authorization",
      },
    }];

    expect(ordinaryTaskSummariesFromContentV1(rows)).toEqual([]);
  });

  test("preserves protected lifecycle through reconnect, terminal receipt, and viewer clear", async () => {
    let status = "running";
    const protectedRow = (): TaskContentSummaryV1 => ({
      ...lifecycle("protected-task"),
      status,
      content: {
        dtoVersion: 1,
        status: "unavailable",
        reason: "waiting_for_authorization",
      },
    });
    const store = createTaskStateStore({
      seedSuppressAfterMountMs: 0,
      listActiveTasks: async () => taskStateRecordsFromContentV1([protectedRow()]),
    });

    await store.seed("mount");
    expect(store.getSnapshot().runningSubagentsMap["protected-task"]?.status).toBe("running");

    store.applyWsEvent({
      type: "task.completed",
      taskId: "protected-task",
      taskRunId: "run-1",
      status: "completed",
      ownerId: "owner",
    });
    expect(store.getSnapshot().runningSubagentsMap["protected-task"]?.status).toBe("done");

    status = "completed";
    await store.seed("ws-open");
    expect(store.getSnapshot().taskMap["protected-task"]?.status).toBe("completed");
    expect(store.getSnapshot().runningSubagentsMap["protected-task"]?.status).toBe("done");

    store.clearForViewerChange();
    expect(store.getSnapshot().taskMap["protected-task"]).toBeUndefined();
    expect(store.getSnapshot().runningSubagentsMap["protected-task"]).toBeUndefined();
  });

  test("admits protected fired lifecycle after its canonical refresh", async () => {
    let resolveRows!: (rows: ReturnType<typeof taskStateRecordsFromContentV1>) => void;
    const rows = new Promise<ReturnType<typeof taskStateRecordsFromContentV1>>((resolve) => {
      resolveRows = resolve;
    });
    let calls = 0;
    const store = createTaskStateStore({
      listActiveTasks: async () => calls++ === 0 ? [] : rows,
    });
    await store.seed("mount");

    store.applyWsEvent({
      type: "task.fired",
      taskId: "protected-task",
      taskRunId: "run-1",
      laneKey: "task:protected-task",
      ownerId: "owner",
    });
    resolveRows(taskStateRecordsFromContentV1([{
      ...lifecycle("protected-task"),
      content: {
        dtoVersion: 1,
        status: "protected",
        objectId: "task-definition:v1:" + "c".repeat(64),
        contentRevision: 1,
        cryptoAccessRevision: 0,
      },
    }]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(store.getSnapshot().taskMap["protected-task"]).toBeDefined();
    expect(store.getSnapshot().runningSubagentsMap["protected-task"]).toMatchObject({
      taskRunId: "run-1",
      status: "running",
    });
  });

  test("uses content-v1 in a protected-capable mode and retains mixed lifecycle", async () => {
    const ordinaryId = "91000000-0000-4000-8000-000000000001";
    const protectedId = "91000000-0000-4000-8000-000000000002";
    const fetchImpl: NautiloApiFetch = async () => new Response(JSON.stringify([{
      ...lifecycle(ordinaryId),
      agentId: "agent-1",
      content: {
        dtoVersion: 1,
        status: "ordinary",
        promptPreview: "decoded Plain preview",
        lastError: null,
      },
    }, {
      ...lifecycle(protectedId),
      agentId: "agent-1",
      content: {
        dtoVersion: 1,
        status: "protected",
        objectId: "task-definition:v1:" + "b".repeat(64),
        contentRevision: 1,
        cryptoAccessRevision: 0,
      },
    }]), { headers: { "content-type": "application/json" } });
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("session-token");

    const summaries = await listTaskStateSummaries(client, "shadow_encryption");

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      id: ordinaryId,
      prompt: "decoded Plain preview",
      lastError: null,
    });
  });

  test("selects the legacy endpoint directly in Plain", async () => {
    let contentCalls = 0;
    let legacyCalls = 0;
    const expected = [{
      ...lifecycle("legacy-task"), prompt: "legacy Plain row", lastError: null,
    }];
    const client: Parameters<typeof listTaskStateSummaries>[0] = {
      listTaskContentV1: async () => { contentCalls += 1; return []; },
      listTasks: async () => { legacyCalls += 1; return expected; },
    } as Parameters<typeof listTaskStateSummaries>[0];

    expect(await listTaskStateSummaries(client, "plaintext_only")).toEqual(expected);
    expect(legacyCalls).toBe(1);
    expect(contentCalls).toBe(0);
  });

  test("Plain recovers mixed stored Tasks only on the exact legacy compatibility error", async () => {
    let contentCalls = 0;
    const rows: TaskContentListV1 = [{
      ...lifecycle("ordinary-task"),
      content: { dtoVersion: 1, status: "ordinary",
        promptPreview: "ordinary remains visible", lastError: null },
    }, {
      ...lifecycle("protected-task"),
      content: { dtoVersion: 1, status: "unavailable",
        reason: "waiting_for_authorization" },
    }];
    const client: Parameters<typeof listTaskStateSummaries>[0] = {
      listTasks: async () => {
        throw new ApiError(409, "task_content_requires_current_client");
      },
      listTaskContentV1: async () => { contentCalls += 1; return rows; },
    } as Parameters<typeof listTaskStateSummaries>[0];

    expect(await listTaskStateSummaries(client, "plaintext_only"))
      .toEqual(taskStateRecordsFromContentV1(rows));
    expect(contentCalls).toBe(1);

    for (const error of [
      new ApiError(409, "different_conflict"),
      new ApiError(401, "session_expired"),
    ]) {
      const denied: Parameters<typeof listTaskStateSummaries>[0] = {
        listTasks: async () => { throw error; },
        listTaskContentV1: async () => { contentCalls += 1; return rows; },
      } as Parameters<typeof listTaskStateSummaries>[0];
      await listTaskStateSummaries(denied, "plaintext_only").then(
        () => { throw new Error("expected the legacy list error"); },
        caught => { expect(caught).toBe(error); },
      );
    }
    expect(contentCalls).toBe(1);
  });

  test("selects content-v1 directly in protected-capable modes", async () => {
    for (const mode of ["shadow_encryption", "encrypted_only"] as const) {
      let contentCalls = 0;
      let legacyCalls = 0;
      const client: Parameters<typeof listTaskStateSummaries>[0] = {
        listTaskContentV1: async () => { contentCalls += 1; return []; },
        listTasks: async () => { legacyCalls += 1; return []; },
      } as Parameters<typeof listTaskStateSummaries>[0];

      expect(await listTaskStateSummaries(client, mode)).toEqual([]);
      expect(contentCalls).toBe(1);
      expect(legacyCalls).toBe(0);
    }
  });

  test("protected-capable modes fall back only when content-v1 is absent", async () => {
    for (const mode of ["shadow_encryption", "encrypted_only"] as const) {
      for (const missingStatus of [404, 405, 501]) {
        let legacyCalls = 0;
        const expected = [{
          ...lifecycle("legacy-task"), prompt: "legacy Plain row", lastError: null,
        }];
        const client: Parameters<typeof listTaskStateSummaries>[0] = {
          listTaskContentV1: async () => {
            throw Object.assign(new Error(`HTTP ${missingStatus}`), { status: missingStatus });
          },
          listTasks: async () => { legacyCalls += 1; return expected; },
        } as Parameters<typeof listTaskStateSummaries>[0];

        expect(await listTaskStateSummaries(client, mode)).toEqual(expected);
        expect(legacyCalls).toBe(1);
      }

      for (const error of [
        Object.assign(new Error("unauthorized"), { status: 401 }),
        Object.assign(new Error("conflict"), { status: 409 }),
        new Error("schema"),
      ]) {
        let legacyCalls = 0;
        const client: Parameters<typeof listTaskStateSummaries>[0] = {
          listTaskContentV1: async () => { throw error; },
          listTasks: async () => { legacyCalls += 1; return []; },
        } as Parameters<typeof listTaskStateSummaries>[0];

        await listTaskStateSummaries(client, mode).then(
          () => { throw new Error("expected content-v1 failure"); },
          caught => { expect(caught).toBe(error); },
        );
        expect(legacyCalls).toBe(0);
      }
    }
  });

  test("does not probe either endpoint before policy is known", async () => {
    let calls = 0;
    const client: Parameters<typeof listTaskStateSummaries>[0] = {
      listTaskContentV1: async () => { calls += 1; return []; },
      listTasks: async () => { calls += 1; return []; },
    } as Parameters<typeof listTaskStateSummaries>[0];

    expect(await listTaskStateSummaries(client, "unknown")).toEqual([]);
    expect(calls).toBe(0);
  });
});
