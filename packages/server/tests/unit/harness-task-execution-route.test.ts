import { describe, expect, test } from "bun:test";
import type {
  ForegroundExecutionRoute,
  TaskExecutionRouteFacts,
} from "@nautilo/runtime";
import {
  TaskHarnessExecutionRouteFailure,
  TaskHarnessExecutionRouteProviderFailure,
  TaskHarnessExecutionRouter,
  type PersistedTaskHarnessRoute,
  type TaskHarnessExecutionRouteRegistration,
} from "../../src/harness/task-execution-route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const ROOM = "55555555-5555-4555-8555-555555555555";

const facts: TaskExecutionRouteFacts = {
  taskId: TASK,
  taskRunId: RUN,
  parentTaskId: null,
  ownerId: OWNER,
  requestorId: OWNER,
  agentId: AGENT,
  roomId: ROOM,
  laneKey: "room:test",
  graphThreadId: "room:test:agent",
};

const route: ForegroundExecutionRoute = {
  async *executor() {},
  coalescing: "separate",
  contention: "serialize",
  modelAttribution: "external",
};

function persisted(
  overrides: Partial<PersistedTaskHarnessRoute> = {},
): PersistedTaskHarnessRoute {
  return {
    id: TASK,
    ownerId: OWNER,
    requestorId: OWNER,
    agentId: AGENT,
    parentTaskId: null,
    targetRoomId: ROOM,
    execution: { version: 1, harnessId: "codex", source: "genie" },
    ...overrides,
  };
}

function registration(
  harnessId: string,
  calls: string[],
  selected: ForegroundExecutionRoute | null = route,
): TaskHarnessExecutionRouteRegistration {
  return {
    harnessId,
    createSelector: () => {
      calls.push(`factory:${harnessId}`);
      return {
        select: (input) => {
          calls.push(`select:${input.descriptor.harnessId}`);
          return selected ?? undefined;
        },
      };
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<TaskHarnessExecutionRouteFailure> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(TaskHarnessExecutionRouteFailure);
    return error as TaskHarnessExecutionRouteFailure;
  }
}

async function caughtFailure(promise: Promise<unknown>): Promise<Error & { code: string }> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return error as Error & { code: string };
    }
    throw error;
  }
}

describe("TaskHarnessExecutionRouter", () => {
  test("bypasses a canonical Native Task without constructing any provider selector", async () => {
    const calls: string[] = [];
    const router = new TaskHarnessExecutionRouter({
      tasks: { getTask: async () => persisted({ execution: null }) },
      registrations: [registration("codex", calls)],
    });

    expect(await router.select(facts)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("selects only the exact registered harness after canonical fact equality", async () => {
    const calls: string[] = [];
    const selectedFacts: TaskExecutionRouteFacts[] = [];
    const codex = registration("codex", calls);
    codex.createSelector = () => ({
      select: (input) => {
        calls.push(`select:${input.descriptor.harnessId}`);
        selectedFacts.push(input.facts);
        expect(input.descriptor).toEqual({ version: 1, harnessId: "codex", source: "genie" });
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.facts)).toBe(true);
        expect(Object.isFrozen(input.descriptor)).toBe(true);
        return route;
      },
    });
    const router = new TaskHarnessExecutionRouter({
      tasks: { getTask: async () => persisted() },
      registrations: [codex, registration("hermes-acp", calls)],
    });

    expect(await router.select(facts)).toBe(route);
    expect(selectedFacts).toEqual([facts]);
    expect(calls).toEqual(["select:codex"]);
  });

  test("rejects malformed descriptors and browser-shaped extra execution keys", async () => {
    const calls: string[] = [];
    const unsafeDescriptor = {
      version: 1,
      harnessId: "codex",
      source: "genie",
      workingDirectory: "/browser/chosen/path",
      profileId: "browser-profile",
      executable: "browser-command",
    };
    const router = new TaskHarnessExecutionRouter({
      tasks: {
        getTask: async () => persisted({
          execution: unsafeDescriptor as unknown as PersistedTaskHarnessRoute["execution"],
        }),
      },
      registrations: [registration("codex", calls)],
    });

    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_DESCRIPTOR_INVALID");
    expect(calls).toEqual([]);
  });

  test("fails explicitly for an unknown harness instead of falling back", async () => {
    const calls: string[] = [];
    const router = new TaskHarnessExecutionRouter({
      tasks: {
        getTask: async () => persisted({
          execution: { version: 1, harnessId: "unreviewed", source: "genie" },
        }),
      },
      registrations: [registration("codex", calls)],
    });

    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_UNKNOWN");
    expect(calls).toEqual([]);
  });

  test("rejects forged canonical facts before provider selection", async () => {
    const calls: string[] = [];
    const router = new TaskHarnessExecutionRouter({
      tasks: { getTask: async () => persisted() },
      registrations: [registration("codex", calls)],
    });

    const forgedFacts = { ...facts, roomId: "forged-room" };
    expect((await rejection(router.select(forgedFacts))).code).toBe("TASK_HARNESS_FACTS_MISMATCH");
    expect(calls).toEqual([]);
  });

  test("constructs only the exact selected provider lazily", async () => {
    const calls: string[] = [];
    const router = new TaskHarnessExecutionRouter({
      tasks: { getTask: async () => persisted() },
      registrations: [registration("codex", calls), registration("hermes-acp", calls)],
    });

    await router.select(facts);
    await router.select(facts);
    expect(calls).toEqual(["factory:codex", "select:codex", "select:codex"]);
  });

  test("does not silently fall back when the selected provider declines to route", async () => {
    const calls: string[] = [];
    const router = new TaskHarnessExecutionRouter({
      tasks: { getTask: async () => persisted() },
      registrations: [registration("codex", calls, null)],
    });

    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_ROUTE_UNAVAILABLE");
    expect(calls).toEqual(["factory:codex", "select:codex"]);
  });

  test("collapses provider selection errors to the bounded generic vocabulary", async () => {
    const router = new TaskHarnessExecutionRouter({
      tasks: { getTask: async () => persisted() },
      registrations: [{
        harnessId: "codex",
        createSelector: () => ({
          select: () => {
            throw new Error("private host path and upstream response");
          },
        }),
      }],
    });

    const error = await rejection(router.select(facts));
    expect(error.code).toBe("TASK_HARNESS_ROUTE_UNAVAILABLE");
    expect(error.message).toBe("TASK_HARNESS_ROUTE_UNAVAILABLE");
    expect(error.cause).toBeUndefined();
  });

  test("preserves only an exact registration-allowlisted bounded provider code", async () => {
    for (const [publicFailureCodes, expected] of [
      [["CODEX_NOT_ENABLED"], "CODEX_NOT_ENABLED"],
      [[], "TASK_HARNESS_ROUTE_UNAVAILABLE"],
    ] as const) {
      const router = new TaskHarnessExecutionRouter({
        tasks: { getTask: async () => persisted() },
        registrations: [{
          harnessId: "codex",
          publicFailureCodes,
          createSelector: () => ({
            select: () => {
              throw new TaskHarnessExecutionRouteProviderFailure("CODEX_NOT_ENABLED");
            },
          }),
        }],
      });

      const error = await caughtFailure(router.select(facts));
      expect(error.code).toBe(expected);
      expect(error.message).toBe(expected);
      expect(error.cause).toBeUndefined();
      expect(error).toBeInstanceOf(
        expected === "CODEX_NOT_ENABLED"
          ? TaskHarnessExecutionRouteProviderFailure
          : TaskHarnessExecutionRouteFailure,
      );
    }
  });
});
