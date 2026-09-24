import { describe, expect, test } from "bun:test";
import type { TaskContentListV1, TaskContentSummaryV1 } from "@nautilo/types";
import { NautiloApiClient, type NautiloApiFetch } from "@nautilo/api-client/browser";

import {
  listTaskStateSummaries,
  ordinaryTaskSummariesFromContentV1,
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

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
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

  test("keeps an ordinary sibling visible when the owner also has protected content", async () => {
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
      listActiveTasks: async () => ordinaryTaskSummariesFromContentV1(rows),
    });

    await store.seed("mount");

    expect(store.getSnapshot().error).toBeNull();
    expect(store.getSnapshot().taskMap["ordinary-task"]).toMatchObject({
      prompt: "ordinary sibling remains visible",
      status: "running",
    });
    expect(store.getSnapshot().taskMap["protected-task"]).toBeUndefined();
    expect(store.getSnapshot().runningSubagentsMap["ordinary-task"]).toBeDefined();
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

  test("decodes the current API and preserves ordinary rows from a mixed response", async () => {
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

    const summaries = await listTaskStateSummaries(client);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: ordinaryId,
      prompt: "decoded Plain preview",
      lastError: null,
    });
  });

  test("falls back only when an older server does not expose content-v1", async () => {
    for (const missingStatus of [404, 405, 501]) {
      let legacyCalls = 0;
      const expected = [{
        ...lifecycle("legacy-task"), prompt: "legacy Plain row", lastError: null,
      }];
      const client: Parameters<typeof listTaskStateSummaries>[0] = {
        listTaskContentV1: async () => { throw httpError(missingStatus); },
        listTasks: async () => { legacyCalls += 1; return expected; },
      } as Parameters<typeof listTaskStateSummaries>[0];
      const result = await listTaskStateSummaries(client);
      expect(result).toEqual(expected);
      expect(legacyCalls).toBe(1);
    }

    for (const rejected of [httpError(401), httpError(403), httpError(409), new Error("schema")]) {
      let legacyCalls = 0;
      const client: Parameters<typeof listTaskStateSummaries>[0] = {
        listTaskContentV1: async () => { throw rejected; },
        listTasks: async () => { legacyCalls += 1; return []; },
      } as Parameters<typeof listTaskStateSummaries>[0];
      const outcome: unknown = await listTaskStateSummaries(client).then<unknown>(
        () => "resolved", (error: unknown) => error,
      );
      expect(outcome).toBe(rejected);
      expect(legacyCalls).toBe(0);
    }
  });
});
