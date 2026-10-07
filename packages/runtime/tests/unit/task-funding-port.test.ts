import { afterEach, describe, expect, test } from "bun:test";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { Task, TaskRun } from "@nautilo/db";
import {
  PersonalDirectFundingUnavailableError,
  PersonalModelFundingUnavailableError,
  type ForegroundChatFundingSession,
} from "@nautilo/agent";
import { assertTaskFundingAdmission, installTaskFundingPort, openTaskFundingSession,
  TaskFundingError, taskFundingFailureCode, uninstallTaskFundingPort } from "../../src/task-funding-port";

const task = { id: "task", requestorId: "human", fundingMode: "caller" } as Task;
const run = { id: "run", taskId: "task", modelId: "openai:model", jobId: "job", graphThreadId: "thread",
  fundingBinding: { kind: "server", providerRoute: "openai" }, fundingPredecessorRunId: null } as TaskRun;
const session: ForegroundChatFundingSession = {
  kind: "server", recheckAttempt: async () => {},
  runAttempt: async (_model, callback) => callback({ usageFunding: { kind: "server", humanUserId: "human", providerRoute: "openai" } }),
};
const invocation = () => ({ task, run, authority: createAcceptedInvocationAuthority("human", { originTaskId: task.id }),
  requestorId: "human", modelId: "openai:model", jobId: "job", graphThreadId: "thread" });

afterEach(uninstallTaskFundingPort);

describe("trusted native Task funding port", () => {
  test("legacy definitions stay server-funded while missing caller composition fails closed", async () => {
    expect(await assertTaskFundingAdmission({ ...task, fundingMode: "legacy_server" })).toBeNull();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(assertTaskFundingAdmission(task)).rejects.toMatchObject({ code: "funding_source_changed" });
  });

  test("fresh and continued admissions carry their canonical predecessor", async () => {
    const predecessors: unknown[] = [];
    installTaskFundingPort({ prepareCreation: async () => true,
      admit: async (_task, prior) => { predecessors.push(prior); return { modelId: "openai:model", binding: { kind: "server", providerRoute: "openai" } }; },
      openSession: async () => session });
    await assertTaskFundingAdmission(task);
    await assertTaskFundingAdmission(task, run);
    expect(predecessors).toEqual([undefined, run]);
    expect(await openTaskFundingSession(invocation())).toBe(session);
  });

  test("serialized identity cannot replace opaque authority or the exact run", async () => {
    let calls = 0;
    installTaskFundingPort({ prepareCreation: async () => true,
      admit: async () => ({ modelId: "openai:model", binding: { kind: "server", providerRoute: "openai" } }),
      openSession: async () => { calls++; return session; } });
    const base = invocation();
    for (const patch of [
      { authority: undefined }, { authority: createAcceptedInvocationAuthority("human") },
      { authority: createAcceptedInvocationAuthority("human", { originTaskId: "other" }) }, { authority: createAcceptedInvocationAuthority("other") },
      { requestorId: "other" }, { modelId: "openai:other" }, { jobId: "other" },
      { graphThreadId: "other" }, { run: { ...run, taskId: "other" } },
    ]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
      await expect(openTaskFundingSession({ ...base, ...patch })).rejects.toBeInstanceOf(Error);
    }
    expect(calls).toBe(0);
  });

  test("wake resolves another Room model through the trusted Task session", async () => {
    const opens: unknown[] = [];
    installTaskFundingPort({ prepareCreation: async () => true,
      admit: async () => ({ modelId: "openai:model", binding: { kind: "server", providerRoute: "openai" } }),
      openSession: async (...args) => { opens.push(args); return session; } });
    await openTaskFundingSession({ ...invocation(), modelId: "anthropic:room", wake: true });
    expect(opens).toEqual([[task, run, "anthropic:room", true]]);
  });

  test("funding interruption reasons survive provider wrappers without exposing their text", () => {
    const wrapped = new Error("sensitive upstream context", { cause: new TaskFundingError("personal_credential_stale") });
    expect(taskFundingFailureCode(wrapped)).toBe("personal_credential_stale");
    expect(taskFundingFailureCode(new Error("sensitive upstream context"))).toBeNull();
    expect(taskFundingFailureCode({ code: "arbitrary provider text" })).toBeNull();
  });

  test("personal safe-fallback terminal errors retain the existing paused-repair reason", () => {
    expect(taskFundingFailureCode(new PersonalDirectFundingUnavailableError()))
      .toBe("personal_credential_missing");
    expect(taskFundingFailureCode(new PersonalModelFundingUnavailableError()))
      .toBe("personal_credential_missing");
  });
});
