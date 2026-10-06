import { describe, expect, mock, test } from "bun:test";
import { ApiError } from "@nautilo/api-client/browser";

mock.module("expo-router", () => ({ useFocusEffect: () => {} }));
mock.module("@/lib/api", () => ({ getApiClient: () => { throw new Error("unused"); } }));

const {
  listPlainScheduledWork,
  readPlainScheduledWorkDetail,
} = await import("./use-scheduled-work");

describe("plaintext-only Mobile Scheduled Work routing", () => {
  test("uses the legacy list and detail endpoints directly", async () => {
    let legacyCalls = 0;
    let contentCalls = 0;
    const client = {
      listActiveTasks: async () => { legacyCalls += 1; return []; },
      listTaskContentV1: async () => { contentCalls += 1; return []; },
      getTask: async (taskId: string) => {
        legacyCalls += 1;
        return { task: { id: taskId }, runs: [] };
      },
      getTaskContentV1: async () => { contentCalls += 1; return {}; },
    };

    await listPlainScheduledWork(
      client as unknown as Parameters<typeof listPlainScheduledWork>[0],
    );
    await readPlainScheduledWorkDetail(
      client as unknown as Parameters<typeof readPlainScheduledWorkDetail>[0],
      "task-1",
    );

    expect(legacyCalls).toBe(2);
    expect(contentCalls).toBe(0);
  });

  test("falls back to content-v1 only for the exact mixed-storage conflict", async () => {
    let contentCalls = 0;
    const mixed = new ApiError(409, "task_content_requires_current_client");
    const client = {
      listActiveTasks: async () => { throw mixed; },
      listTaskContentV1: async () => { contentCalls += 1; return []; },
      getTask: async () => { throw mixed; },
      getTaskContentV1: async () => { contentCalls += 1; return { runs: [] }; },
    };

    await listPlainScheduledWork(
      client as unknown as Parameters<typeof listPlainScheduledWork>[0],
    );
    await readPlainScheduledWorkDetail(
      client as unknown as Parameters<typeof readPlainScheduledWorkDetail>[0],
      "task-1",
    );
    expect(contentCalls).toBe(2);

    for (const error of [
      new ApiError(409, "different_conflict"),
      new ApiError(401, "session_expired"),
    ]) {
      const denied = {
        listActiveTasks: async () => { throw error; },
        listTaskContentV1: async () => { contentCalls += 1; return []; },
        getTask: async () => { throw error; },
        getTaskContentV1: async () => { contentCalls += 1; return {}; },
      };
      await listPlainScheduledWork(
        denied as unknown as Parameters<typeof listPlainScheduledWork>[0],
      ).then(
        () => { throw new Error("expected the legacy list error"); },
        caught => { expect(caught).toBe(error); },
      );
      await readPlainScheduledWorkDetail(
        denied as unknown as Parameters<typeof readPlainScheduledWorkDetail>[0],
        "task-1",
      ).then(
        () => { throw new Error("expected the legacy detail error"); },
        caught => { expect(caught).toBe(error); },
      );
    }
    expect(contentCalls).toBe(2);
  });
});
