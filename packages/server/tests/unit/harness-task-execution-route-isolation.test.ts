import { describe, expect, test } from "bun:test";
import type {
  ForegroundExecutionRoute,
  TaskExecutionRouteFacts,
} from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
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

function route(): ForegroundExecutionRoute {
  return {
    async *executor() {},
    coalescing: "separate",
    contention: "serialize",
    modelAttribution: "external",
  };
}

function persisted(
  harnessId: string | null = "fake-acp",
): PersistedTaskHarnessRoute {
  return {
    id: TASK,
    ownerId: OWNER,
    requestorId: OWNER,
    agentId: AGENT,
    parentTaskId: null,
    targetRoomId: ROOM,
    execution: harnessId
      ? { version: 1, harnessId, source: "genie" }
      : null,
  };
}

function routerFor(
  task: () => PersistedTaskHarnessRoute,
  registrations: readonly TaskHarnessExecutionRouteRegistration[],
): TaskHarnessExecutionRouter {
  return new TaskHarnessExecutionRouter({
    tasks: { getTask: async () => task() },
    registrations,
  });
}

async function rejection(promise: Promise<unknown>): Promise<Error & { code: string }> {
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

describe("TaskHarnessExecutionRouter isolated second provider", () => {
  test("selects the exact fake lazily and exposes only frozen canonical facts plus the descriptor", async () => {
    const calls: string[] = [];
    const fakePrivateAdmission = {
      profile: "/private/fake-profile",
      model: "fake-model",
      binding: { secretCallback: () => undefined },
    };
    const projectedEvents: ServerEvent[] = [];
    const fakeRoute: ForegroundExecutionRoute = {
      coalescing: "separate",
      contention: "serialize",
      modelAttribution: "external",
      async *executor(_input, jobId, laneKey) {
        // Provider-owned admission/projection can close over private state,
        // but only its bounded semantic event crosses the generic route.
        expect(fakePrivateAdmission.model).toBe("fake-model");
        fakePrivateAdmission.binding.secretCallback();
        const event = {
          type: "job.progress",
          jobId,
          phase: "fake_provider_running",
          ...(laneKey === null ? {} : { laneKey }),
        } satisfies ServerEvent;
        projectedEvents.push(event);
        yield event;
      },
    };
    const codexRoute = route();
    const router = routerFor(
      () => persisted("fake-acp"),
      [
        {
          harnessId: "fake-acp",
          createSelector: () => {
            calls.push("fake:factory");
            return {
              select: (input) => {
                calls.push("fake:select");
                expect(Object.keys(input).sort()).toEqual(["descriptor", "facts"]);
                expect(Object.keys(input.descriptor).sort()).toEqual([
                  "harnessId",
                  "source",
                  "version",
                ]);
                expect(Object.isFrozen(input)).toBe(true);
                expect(Object.isFrozen(input.facts)).toBe(true);
                expect(Object.isFrozen(input.descriptor)).toBe(true);
                expect(input.facts).toEqual(facts);
                expect(input.descriptor).toEqual({
                  version: 1,
                  harnessId: "fake-acp",
                  source: "genie",
                });
                expect((input as unknown as Record<string, unknown>)["profile"]).toBeUndefined();
                expect((input as unknown as Record<string, unknown>)["model"]).toBeUndefined();
                expect(fakePrivateAdmission.profile).toBe("/private/fake-profile");
                return fakeRoute;
              },
            };
          },
        },
        {
          harnessId: "codex",
          createSelector: () => {
            calls.push("codex:factory");
            return { select: () => codexRoute };
          },
        },
      ],
    );

    const selected = await router.select(facts);
    expect(selected).toBe(fakeRoute);
    expect(calls).toEqual(["fake:factory", "fake:select"]);
    const emitted: ServerEvent[] = [];
    for await (const event of selected!.executor(
      { taskId: TASK, taskRunId: RUN },
      "job-fake",
      facts.laneKey,
      new AbortController().signal,
    )) {
      emitted.push(event);
    }
    expect(emitted).toEqual([{
      type: "job.progress",
      jobId: "job-fake",
      phase: "fake_provider_running",
      laneKey: facts.laneKey,
    }]);
    expect(projectedEvents).toEqual(emitted);
    expect(JSON.stringify(emitted)).not.toContain(fakePrivateAdmission.profile);
    expect(JSON.stringify(emitted)).not.toContain(fakePrivateAdmission.model);
  });

  test("does not cache a failed fake factory and retries only that exact provider", async () => {
    let factoryAttempts = 0;
    const calls: string[] = [];
    const fakeRoute = route();
    const router = routerFor(
      () => persisted("fake-acp"),
      [
        {
          harnessId: "fake-acp",
          createSelector: () => {
            factoryAttempts += 1;
            calls.push(`fake:factory:${factoryAttempts}`);
            if (factoryAttempts === 1) throw new Error("temporary fake startup");
            return { select: () => fakeRoute };
          },
        },
        {
          harnessId: "codex",
          createSelector: () => {
            calls.push("codex:factory");
            return { select: () => route() };
          },
        },
      ],
    );

    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_SELECTOR_UNAVAILABLE");
    expect(await router.select(facts)).toBe(fakeRoute);
    expect(calls).toEqual(["fake:factory:1", "fake:factory:2"]);
  });

  test("contains a broken fake and permits its healthy Codex sibling to route afterward", async () => {
    let selected = "fake-acp";
    const calls: string[] = [];
    const codexRoute = route();
    const router = routerFor(
      () => persisted(selected),
      [
        {
          harnessId: "fake-acp",
          createSelector: () => {
            calls.push("fake:factory");
            throw new Error("fake private host startup failure");
          },
        },
        {
          harnessId: "codex",
          createSelector: () => {
            calls.push("codex:factory");
            return {
              select: () => {
                calls.push("codex:select");
                return codexRoute;
              },
            };
          },
        },
      ],
    );

    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_SELECTOR_UNAVAILABLE");
    selected = "codex";
    expect(await router.select(facts)).toBe(codexRoute);
    expect(calls).toEqual(["fake:factory", "codex:factory", "codex:select"]);
  });

  test("rejects duplicate and unknown exact IDs deterministically without constructing a sibling", async () => {
    const duplicate = (): void => {
      new TaskHarnessExecutionRouter({
        tasks: { getTask: async () => persisted() },
        registrations: [
          { harnessId: "fake-acp", createSelector: () => ({ select: () => route() }) },
          { harnessId: "fake-acp", createSelector: () => ({ select: () => route() }) },
        ],
      });
    };
    expect(duplicate).toThrow(TaskHarnessExecutionRouteFailure);
    expect(duplicate).toThrow("TASK_HARNESS_DUPLICATE_REGISTRATION");

    const calls: string[] = [];
    const router = routerFor(
      () => persisted("fake-missing"),
      [{
        harnessId: "codex",
        createSelector: () => {
          calls.push("codex:factory");
          return { select: () => route() };
        },
      }],
    );
    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_UNKNOWN");
    expect(calls).toEqual([]);
  });

  test("bypasses Native Tasks without constructing either fake or Codex", async () => {
    const calls: string[] = [];
    const router = routerFor(
      () => persisted(null),
      ["fake-acp", "codex"].map((harnessId) => ({
        harnessId,
        createSelector: () => {
          calls.push(`${harnessId}:factory`);
          return { select: () => route() };
        },
      })),
    );

    expect(await router.select(facts)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("never falls back when an exact fake declines or throws", async () => {
    const calls: string[] = [];
    let mode: "decline" | "throw" = "decline";
    const router = routerFor(
      () => persisted("fake-acp"),
      [
        {
          harnessId: "fake-acp",
          createSelector: () => ({
            select: () => {
              calls.push(`fake:${mode}`);
              if (mode === "throw") throw new Error("private fake detail");
              return undefined;
            },
          }),
        },
        {
          harnessId: "codex",
          createSelector: () => {
            calls.push("codex:factory");
            return { select: () => route() };
          },
        },
      ],
    );

    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_ROUTE_UNAVAILABLE");
    mode = "throw";
    expect((await rejection(router.select(facts))).code).toBe("TASK_HARNESS_ROUTE_UNAVAILABLE");
    expect(calls).toEqual(["fake:decline", "fake:throw"]);
  });

  test("exposes a fake public failure only when that exact registration allowlists it, without provider detail", async () => {
    const unsafeFailure = new TaskHarnessExecutionRouteProviderFailure("FAKE_NOT_READY");
    Object.assign(unsafeFailure, {
      cause: new Error("private fake cause"),
      detail: "private fake profile / path / callback",
    });
    const registration = (publicFailureCodes?: readonly string[]): TaskHarnessExecutionRouteRegistration => ({
      harnessId: "fake-acp",
      ...(publicFailureCodes ? { publicFailureCodes } : {}),
      createSelector: () => ({ select: () => { throw unsafeFailure; } }),
    });

    const unreviewed = routerFor(() => persisted("fake-acp"), [registration()]);
    const collapsed = await rejection(unreviewed.select(facts));
    expect(collapsed).toBeInstanceOf(TaskHarnessExecutionRouteFailure);
    expect(collapsed).toMatchObject({ code: "TASK_HARNESS_ROUTE_UNAVAILABLE" });
    expect(collapsed.message).toBe("TASK_HARNESS_ROUTE_UNAVAILABLE");
    expect(collapsed.cause).toBeUndefined();
    expect("detail" in collapsed).toBe(false);

    const allowlisted = routerFor(() => persisted("fake-acp"), [registration(["FAKE_NOT_READY"])]);
    const publicFailure = await rejection(allowlisted.select(facts));
    expect(publicFailure).toBeInstanceOf(TaskHarnessExecutionRouteProviderFailure);
    expect(publicFailure).not.toBe(unsafeFailure);
    expect(publicFailure).toMatchObject({ code: "FAKE_NOT_READY", message: "FAKE_NOT_READY" });
    expect(publicFailure.cause).toBeUndefined();
    expect("detail" in publicFailure).toBe(false);
  });
});
