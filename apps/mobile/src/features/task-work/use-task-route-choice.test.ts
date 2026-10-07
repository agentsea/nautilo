import { describe, expect, mock, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";

mock.module("expo-router", () => ({ useFocusEffect: () => {} }));
mock.module("@/lib/api", () => ({ getApiClient: () => { throw new Error("unused"); } }));
mock.module("@/providers/realtime", () => ({ useRealtime: () => ({ subscribe: () => () => {} }) }));

const { listPlainTaskWork } = await import("./use-task-work");
const { readPlainTaskDetail } = await import("./use-task-detail");

describe("plaintext-only Mobile Task routing", () => {
  test("list calls the legacy endpoint directly", async () => {
    let legacyCalls = 0;
    let contentCalls = 0;
    const client = {
      listTasks: async (query: unknown) => {
        legacyCalls += 1;
        expect(query).toEqual({ includeTerminal: true, recentTerminalLimit: 5 });
        return [];
      },
      listTaskContentV1: async () => { contentCalls += 1; return []; },
    };

    await listPlainTaskWork(client as Parameters<typeof listPlainTaskWork>[0]);

    expect(legacyCalls).toBe(1);
    expect(contentCalls).toBe(0);
  });

  test("detail calls the legacy endpoint directly", async () => {
    let legacyCalls = 0;
    let contentCalls = 0;
    const client = {
      getTask: async (taskId: string) => {
        legacyCalls += 1;
        expect(taskId).toBe("task-1");
        return { task: { id: taskId }, runs: [] };
      },
      getTaskContentV1: async () => { contentCalls += 1; return {}; },
    };

    await readPlainTaskDetail(
      client as unknown as Parameters<typeof readPlainTaskDetail>[0],
      "task-1",
    );

    expect(legacyCalls).toBe(1);
    expect(contentCalls).toBe(0);
  });

  test("mixed stored Tasks fall back to lifecycle-safe list and detail only on the exact 409", async () => {
    let listFallbacks = 0;
    let detailFallbacks = 0;
    const client = {
      listTasks: async () => {
        throw new ApiError(409, "task_content_requires_current_client");
      },
      listTaskContentV1: async () => {
        listFallbacks += 1;
        return [{ id: "protected-task", content: {
          dtoVersion: 1, status: "unavailable", reason: "waiting_for_authorization",
        } }];
      },
      getTask: async () => {
        throw new ApiError(409, "task_content_requires_current_client");
      },
      getTaskContentV1: async () => {
        detailFallbacks += 1;
        return { task: { id: "protected-task" },
          definition: { dtoVersion: 1, status: "unavailable",
            reason: "waiting_for_authorization" }, runs: [] };
      },
    };
    expect((await listPlainTaskWork(client as unknown as Parameters<typeof listPlainTaskWork>[0]))[0])
      .toMatchObject({ id: "protected-task", content: { status: "unavailable" } });
    expect(await readPlainTaskDetail(
      client as unknown as Parameters<typeof readPlainTaskDetail>[0], "protected-task",
    )).toMatchObject({ definition: { status: "unavailable" } });
    expect(listFallbacks).toBe(1);
    expect(detailFallbacks).toBe(1);
  });

  test("other legacy failures do not probe content-v1", async () => {
    for (const error of [
      new ApiError(409, "different_conflict"),
      new ApiError(401, "session_expired"),
    ]) {
      let fallbackCalls = 0;
      const client = {
        listTasks: async () => { throw error; },
        listTaskContentV1: async () => { fallbackCalls += 1; return []; },
        getTask: async () => { throw error; },
        getTaskContentV1: async () => { fallbackCalls += 1; return {}; },
      };
      await listPlainTaskWork(
        client as unknown as Parameters<typeof listPlainTaskWork>[0],
      ).then(
        () => { throw new Error("expected the legacy list error"); },
        caught => { expect(caught).toBe(error); },
      );
      await readPlainTaskDetail(
        client as unknown as Parameters<typeof readPlainTaskDetail>[0], "ordinary-task",
      ).then(
        () => { throw new Error("expected the legacy detail error"); },
        caught => { expect(caught).toBe(error); },
      );
      expect(fallbackCalls).toBe(0);
    }
  });
});
