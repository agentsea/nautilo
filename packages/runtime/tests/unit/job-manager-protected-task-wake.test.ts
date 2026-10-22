import { describe, expect, test } from "bun:test";
import {
  protectedTaskRunOutputBindingId, protectedTaskRunResultObjectId,
  protectedTaskRunWakeJobId, protectedTaskRunWakeOperationId,
} from "@nautilo/db";
import type { ServerEvent } from "@nautilo/types";
import { Job } from "../../src/job";
import { JobManager, getCurrentAcceptedInvocationAuthority, getCurrentAcceptedWorkAuthority } from "../../src/job-manager";
import { getAcceptedInvocationAuthorityOrigin, getAcceptedInvocationAuthoritySubject } from "@nautilo/trust";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { eventBus } from "../../src/event-bus";
import {
  protectedTaskWakeParked,
  type AdoptProtectedTaskWakeJobInput,
  type ProtectedTaskWakeExecutionCandidate,
} from
  "../../src/tasks/protected-task-wake-execution-candidate";
import { getCurrentProtectedTaskWakeExecutionCustody } from
  "../../src/tasks/protected-task-wake-foreground-context";

const USER = "10000000-0000-4000-8000-000000000001";
const AGENT = "10000000-0000-4000-8000-000000000002";
const ROOM = "10000000-0000-4000-8000-000000000003";
const TASK = "10000000-0000-4000-8000-000000000004";
const RUN = "10000000-0000-4000-8000-000000000005";
const RUN2 = "10000000-0000-4000-8000-000000000006";
const THREAD = `room:${ROOM}:bot:${AGENT}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(runId = RUN) {
  const events: string[] = [];
  const signal = new AbortController();
  const released = deferred();
  let custodyActive = false;
  const candidate: ProtectedTaskWakeExecutionCandidate = {
    start: async jobId => { events.push(`start:${jobId}`); return { status: "started" }; },
    run: async work => {
      events.push("custody");
      custodyActive = true;
      try {
        return await work({ message: "PRIVATE WAKE" }, signal.signal, {
          park: async () => {
            if (!custodyActive) throw new Error("park escaped wake custody");
            events.push("park");
            return { status: "parked" };
          },
        });
      }
      finally { custodyActive = false; }
    },
    settle: async (_jobId, requested) => {
      if (!custodyActive) throw new Error("settlement escaped wake custody");
      events.push(`settle:${requested}`);
      return { kind: "transitioned", status: requested };
    },
    onIneligible: () => { events.push("released"); released.resolve(); },
  };
  const reference = { kind: "protected_task_delivery_v1" as const,
    bindingId: protectedTaskRunOutputBindingId(runId), taskId: TASK, taskRunId: runId,
    resultObjectId: protectedTaskRunResultObjectId(TASK, runId),
    wakeOperationId: protectedTaskRunWakeOperationId(runId) };
  const input: AdoptProtectedTaskWakeJobInput = {
    reference,
    scheduling: { taskId: TASK, taskRunId: runId, jobId: protectedTaskRunWakeJobId(runId),
      ownerId: USER, requestorId: USER, agentId: AGENT, roomId: ROOM,
      namespaceId: ROOM, sessionId: ROOM, sessionOwnerId: USER,
      graphThreadId: THREAD, laneKey: `room:${ROOM}`, reference, jobState: "queued" },
    candidate,
    executor: async function* (transient, jobId, laneKey, executionSignal) {
      expect(transient).toEqual({ message: "PRIVATE WAKE" });
      expect(jobId).toBe(protectedTaskRunWakeJobId(runId));
      expect(laneKey).toBe(`room:${ROOM}`);
      expect(executionSignal.aborted).toBe(false);
      events.push("effect");
      yield { type: "message.tokens", laneKey: `room:${ROOM}`, content: "PRIVATE RESULT", chunkSequence: 1, done: true };
    },
  };
  return {
    input,
    candidate,
    events,
    signal,
    released,
    isCustodyActive: () => custodyActive,
  };
}

function manager(options: ConstructorParameters<typeof JobManager>[0] = {}) {
  const forbidden: string[] = [];
  const deny = (name: string) => async () => { forbidden.push(name); throw new Error(`Unexpected ${name}`); };
  const value = new JobManager({ laneLock: new InMemoryLaneLock(), ...options,
    persist: deny("persist"), updateStatus: deny("status"),
    startProtectedTaskJob: deny("task-start"), settleProtectedTaskJobTerminal: deny("task-terminal"),
    taskStopSink: deny("task-stop"), invocationTaskStop: deny("invocation-task-stop"),
    acceptanceSinks: { insertAcceptance: deny("accept"), linkAcceptancesToJob: deny("link"),
      terminalizeAllAcceptedWork: deny("terminalize"), userCancelAcceptedWork: deny("cancel-acceptance") },
  });
  return { value, forbidden };
}

async function drained(value: JobManager): Promise<void> {
  for (let step = 0; step < 100; step++) {
    if (value.getActiveJobIdsForRoom(ROOM).length === 0 && value.getForegroundWorkSummary().queuedTurns === 0) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("Wake did not drain");
}

describe("adopted protected wake Job", () => {
  test("retains only the exact durable reference and suppresses generic plaintext sinks", async () => {
    const state = fixture();
    const observed: ServerEvent[] = [];
    const listener = (event: ServerEvent) => observed.push(event);
    eventBus.on(listener);
    try {
      const job = Job.adoptPersisted(state.input);
      expect(job.id).toBe(state.input.scheduling.jobId);
      expect(job.input).toEqual(state.input.reference);
      expect(Object.isFrozen(job.input)).toBe(true);
      await job.executeProtectedTaskWake();
      expect(job.status).toBe("completed");
      expect(state.events).toEqual(["custody", `start:${job.id}`, "effect", "settle:completed", "released"]);
      expect(observed.filter(event => event.type !== "job.status")).toEqual([]);
      expect(JSON.stringify(observed)).not.toContain("PRIVATE");
      expect(await job.persist().catch((error: unknown) => error)).toBeInstanceOf(TypeError);
      expect(await job.execute().catch((error: unknown) => error)).toBeInstanceOf(TypeError);
    } finally { eventBus.off(listener); }
  });

  for (const mode of ["stale", "unknown", "aborted"] as const) {
    test(`has no effects when start is ${mode}`, async () => {
      const state = fixture();
      if (mode === "aborted") state.signal.abort();
      else state.candidate.start = async () => {
        state.events.push("start-attempt");
        if (mode === "unknown") throw new Error("lost response");
        return { status: "stale" };
      };
      const job = Job.adoptPersisted(state.input);
      await job.executeProtectedTaskWake();
      expect(state.events).not.toContain("effect");
      expect(state.events.filter(event => event.startsWith("settle:")))
        .toEqual([]);
      expect(state.events.at(-1)).toBe("released");
    });
  }

  test("does not retry execution or relabel an uncertain completion response", async () => {
    const state = fixture();
    state.candidate.settle = async (_jobId, status) => {
      expect(state.isCustodyActive()).toBe(true);
      state.events.push(`settle:${status}`);
      throw new Error("response lost");
    };
    const job = Job.adoptPersisted(state.input);
    expect(await job.executeProtectedTaskWake().catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(state.events.filter(event => event.startsWith("settle:"))).toEqual(["settle:completed"]);
    expect(state.events.filter(event => event === "effect")).toHaveLength(1);
  });

  test("parks inside authenticated custody without terminal settlement", async () => {
    const state = fixture();
    const job = Job.adoptPersisted({
      ...state.input,
      executor: async function* () {
        const custody = getCurrentProtectedTaskWakeExecutionCustody();
        expect(custody).toBeDefined();
        await custody!.park({} as never);
        yield* [];
        throw protectedTaskWakeParked();
      },
    });
    await job.executeProtectedTaskWake();
    expect(job.status).toBe("queued");
    expect(state.events).toEqual([
      "custody", `start:${job.id}`, "park", "released",
    ]);
    expect(state.events.filter(event => event.startsWith("settle:"))).toEqual([]);
    expect(getCurrentProtectedTaskWakeExecutionCustody()).toBeUndefined();
  });

  test("rejects a second callback without repeating start, effects, or settlement", async () => {
    const state = fixture();
    const original = state.candidate.run;
    state.candidate.run = async work => original(async (transient, signal, custody) => {
      const result = await work(transient, signal, custody);
      expect(await work(transient, signal, custody).catch((error: unknown) => error))
        .toBeInstanceOf(Error);
      return result;
    });
    const job = Job.adoptPersisted(state.input);
    await job.executeProtectedTaskWake();
    expect(job.status).toBe("completed");
    expect(state.events.filter(event => event.startsWith("start:"))).toHaveLength(1);
    expect(state.events.filter(event => event === "effect")).toHaveLength(1);
    expect(state.events.filter(event => event.startsWith("settle:")))
      .toEqual(["settle:completed"]);
  });

  test("authorization abort during the start CAS settles only after start ownership is proved", async () => {
    const state = fixture();
    state.candidate.start = async () => {
      state.signal.abort();
      return { status: "started" };
    };
    const job = Job.adoptPersisted(state.input);
    await job.executeProtectedTaskWake();
    expect(state.events).toEqual(["custody", "settle:failed", "released"]);
    expect(job.status).toBe("failed");
  });

  test("does not claim completion when custody catches an executor failure", async () => {
    const state = fixture();
    const original = state.candidate.run;
    state.candidate.run = async work => {
      try { return await original(work); }
      catch { return undefined as never; }
    };
    const job = Job.adoptPersisted({ ...state.input,
      executor: async function* () { yield* []; throw new Error("PRIVATE provider error"); },
    });
    await job.executeProtectedTaskWake();
    expect(state.events).toContain("settle:failed");
    expect(state.events).not.toContain("settle:completed");
  });

  test("does not relabel durable completion when authorization aborts after the callback", async () => {
    const state = fixture();
    const original = state.candidate.run;
    state.candidate.run = async work => {
      const result = await original(work);
      state.signal.abort();
      return result;
    };
    const job = Job.adoptPersisted(state.input);
    await job.executeProtectedTaskWake();
    expect(job.status).toBe("completed");
    expect(state.events.filter(event => event.startsWith("settle:")))
      .toEqual(["settle:completed"]);
  });

  test("does not settle again when custody fails after durable completion", async () => {
    const state = fixture();
    const original = state.candidate.run;
    state.candidate.run = async work => {
      await original(work);
      throw new Error("custody close failed");
    };
    const job = Job.adoptPersisted(state.input);
    await job.executeProtectedTaskWake();
    expect(job.status).toBe("completed");
    expect(state.events.filter(event => event.startsWith("settle:")))
      .toEqual(["settle:completed"]);
  });

  test("honors exact existing terminal truth and rejects a failed settlement", async () => {
    for (const rejected of [false, true]) {
      const state = fixture();
      state.candidate.settle = async () => {
        expect(state.isCustodyActive()).toBe(true);
        return rejected ? { kind: "rejected" }
          : { kind: "existing_terminal", status: "cancelled" };
      };
      const job = Job.adoptPersisted(state.input);
      const failure = await job.executeProtectedTaskWake().catch((error: unknown) => error);
      if (rejected) expect(failure).toBeInstanceOf(Error);
      expect(job.status).toBe(rejected ? "running" : "cancelled");
    }
  });

  test("settles an admitted cancellation while authenticated custody is live", async () => {
    const state = fixture();
    const entered = deferred();
    state.candidate.settle = async (_jobId, requested) => {
      expect(state.isCustodyActive()).toBe(true);
      state.events.push(`settle:${requested}`);
      return { kind: "existing_terminal", status: "cancelled" };
    };
    const job = Job.adoptPersisted({
      ...state.input,
      executor: async function* (_input, _jobId, _laneKey, executionSignal) {
        state.events.push("effect");
        entered.resolve();
        await new Promise<void>(resolve => {
          if (executionSignal.aborted) resolve();
          else executionSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield* [];
      },
    });
    const execution = job.executeProtectedTaskWake();
    await entered.promise;
    await job.cancel();
    await execution;
    expect(job.status).toBe("cancelled");
    expect(state.events.filter(event => event.startsWith("settle:")))
      .toEqual(["settle:failed"]);
  });

  test("rejects substituted stable identity, reference fields and ordinary execution references", () => {
    const { input } = fixture();
    for (const changed of [
      { ...input, scheduling: { ...input.scheduling, jobId: RUN } },
      { ...input, reference: { ...input.reference, wakeOperationId: "different" } },
      { ...input, reference: { ...input.reference, taskId: RUN2 } },
      { ...input, reference: { ...input.reference, resultObjectId: "different" } },
      { ...input, reference: { ...input.reference, message: "PRIVATE" } },
      { ...input, reference: { ...input.reference, kind: "protected_task_run_v1" } },
      { ...input, scheduling: { ...input.scheduling, laneKey: `task:${TASK}` } },
    ]) expect(() => Job.adoptPersisted(changed as AdoptProtectedTaskWakeJobInput)).toThrow(TypeError);
  });
});

describe("protected wake FIFO adoption", () => {
  test("waits behind an ordinary main turn and adopts its own stable Job without another insert", async () => {
    const state = fixture();
    const entered = deferred();
    const gate = deferred();
    const persisted: unknown[] = [];
    const value = new JobManager({ laneLock: new InMemoryLaneLock(),
      persist: async payload => { persisted.push(payload); return "ordinary-job"; },
      updateStatus: async () => {},
    });
    await value.createSystemForegroundJob(USER, USER, `room:${ROOM}`, {
      roomId: ROOM, graphThreadId: THREAD, agentId: AGENT, message: "ordinary",
    }, async function* () { entered.resolve(); await gate.promise; yield* []; });
    await entered.promise;
    await value.adoptProtectedTaskWakeJob(state.input);
    expect(state.events).toEqual([]);
    gate.resolve();
    await state.released.promise;
    await drained(value);
    expect(persisted).toHaveLength(1);
    expect(state.events).toContain(`start:${state.input.scheduling.jobId}`);
    expect(state.events).toContain("effect");
  });

  test("deduplicates stable Job ownership and serializes wake turns without generic persistence or acceptance", async () => {
    const first = fixture();
    const second = fixture(RUN2);
    const gate = deferred();
    const entered = deferred();
    const original = first.input.executor;
    const firstInput = { ...first.input, executor: async function* (...args: Parameters<typeof original>) {
      entered.resolve(); await gate.promise; yield* original(...args);
    } };
    const { value, forbidden } = manager();
    expect((await value.adoptProtectedTaskWakeJob(firstInput)).status).toBe("adopted");
    await entered.promise;
    const duplicate = fixture();
    expect((await value.adoptProtectedTaskWakeJob(duplicate.input)).status).toBe("existing");
    expect(duplicate.events).toEqual(["released"]);
    expect((await value.adoptProtectedTaskWakeJob(firstInput)).status).toBe("existing");
    expect(first.events).not.toContain("released");
    await value.adoptProtectedTaskWakeJob(second.input);
    expect(second.events).toEqual([]);
    gate.resolve();
    await second.released.promise;
    await drained(value);
    expect(first.events.filter(event => event === "effect")).toHaveLength(1);
    expect(second.events).toContain("effect");
    expect(forbidden).toEqual([]);
  });

  test("preserves FIFO completion while a stale busy-lock response is still in flight", async () => {
    const first = fixture();
    const second = fixture(RUN2);
    const entered = deferred();
    const finish = deferred();
    const busy = deferred();
    const returnBusy = deferred();
    const releasedLock = deferred();
    const base = new InMemoryLaneLock();
    let observedBusy = false;
    const value = new JobManager({ laneLock: {
      acquire: base.acquire.bind(base),
      tryAcquire: async thread => {
        const lock = await base.tryAcquire(thread);
        if (!lock.acquired && !observedBusy) {
          observedBusy = true; busy.resolve(); await returnBusy.promise;
        }
        if (!lock.acquired) return lock;
        return { ...lock, release: async () => { await lock.release(); releasedLock.resolve(); } };
      },
    } });
    await value.adoptProtectedTaskWakeJob({ ...first.input,
      executor: async function* () { entered.resolve(); await finish.promise; yield* []; },
    });
    await entered.promise;
    await value.adoptProtectedTaskWakeJob(second.input);
    await busy.promise;
    finish.resolve();
    await releasedLock.promise;
    await Promise.resolve();
    returnBusy.resolve();
    await second.released.promise;
    await drained(value);
    expect(second.events).toContain("effect");
  });

  test("Room Stop releases queued wake without changing its terminal Task or invoking model", async () => {
    const state = fixture();
    const lock = new InMemoryLaneLock();
    const held = await lock.tryAcquire(THREAD);
    if (!held.acquired) throw new Error("fixture lock missing");
    const forbidden: string[] = [];
    // Hold an ordinary main turn using the same scheduler lock instance.
    const runtime = new JobManager({ laneLock: lock, persist: async () => { throw new Error("persist"); },
      taskStopSink: async () => { forbidden.push("task-stop"); } });
    await runtime.adoptProtectedTaskWakeJob(state.input);
    await runtime.stopRoom(ROOM);
    await state.released.promise;
    await held.release();
    expect(state.events).toEqual(["released"]);
    expect(forbidden).toEqual([]);
    expect(runtime.getForegroundWorkSummary().queuedTurns).toBe(0);
  });

  test("refuses uncertain running Jobs after restart", async () => {
    const state = fixture();
    const { value, forbidden } = manager();
    expect((await value.adoptProtectedTaskWakeJob({ ...state.input,
      scheduling: { ...state.input.scheduling, jobState: "running" } })).status).toBe("ineligible");
    expect(state.events).toEqual(["released"]);
    expect(forbidden).toEqual([]);
  });
});


describe("protected wake invocation authority", () => {
  test("binds custody and async execution to requester and original Task, not Session owner or transient input", async () => {
    const state = fixture();
    const checks: unknown[] = [];
    const assertAuthority = () => {
      const authority = getCurrentAcceptedInvocationAuthority();
      expect(authority).toBeDefined();
      expect(getAcceptedInvocationAuthoritySubject(authority!)).toBe(USER);
      expect(getAcceptedInvocationAuthorityOrigin(authority!)).toEqual({ originTaskId: TASK });
      expect(getCurrentAcceptedWorkAuthority()).toBeUndefined();
    };
    const original = state.candidate.run;
    state.candidate.run = async work => {
      assertAuthority();
      return original(async (_input, signal, custody) => work({ taskId: RUN2, roomId: RUN2,
        requestorId: RUN2, originTaskId: RUN2 }, signal, custody));
    };
    const { value, forbidden } = manager({ checkInvocationAccess: async input => {
      checks.push(input); return true;
    } });
    await value.adoptProtectedTaskWakeJob({ ...state.input,
      scheduling: { ...state.input.scheduling, ownerId: RUN2, sessionOwnerId: RUN2 },
      executor: async function* () { await Promise.resolve(); assertAuthority(); yield* []; },
    });
    await state.released.promise;
    await drained(value);
    expect(checks).toEqual(Array.from({ length: 2 }, () => ({ humanUserId: USER,
      roomId: ROOM, originTaskId: TASK })));
    expect(forbidden).toEqual([]);
    expect(getCurrentAcceptedInvocationAuthority()).toBeUndefined();
    await value.reconcileAllInvocationAccess();
    expect(checks).toHaveLength(2);
  });

  for (const unavailable of [false, true]) {
    test(`dispatch invocation ${unavailable ? "failure" : "revocation"} releases queued custody without start or effects`, async () => {
      const state = fixture();
      const { value, forbidden } = manager({ checkInvocationAccess: async () => {
        if (unavailable) throw new Error("authority unavailable");
        return false;
      } });
      await value.adoptProtectedTaskWakeJob(state.input);
      await state.released.promise;
      await drained(value);
      expect(state.events).toEqual(["released"]);
      expect(forbidden).toEqual([]);
    });
  }

  test("rechecks invocation after custody opens and before the durable start", async () => {
    const state = fixture();
    let checks = 0;
    const { value, forbidden } = manager({ checkInvocationAccess: async () => ++checks === 1 });
    await value.adoptProtectedTaskWakeJob(state.input);
    await state.released.promise;
    await drained(value);
    expect(state.events).toEqual(["custody", "released"]);
    expect(forbidden).toEqual([]);
  });

  test("reconciliation retains allowed queued wakes and releases only the revoked requester", async () => {
    const state = fixture();
    const lock = new InMemoryLaneLock();
    const held = await lock.tryAcquire(THREAD);
    if (!held.acquired) throw new Error("fixture lock missing");
    let allowed = true;
    const { value, forbidden } = manager({ laneLock: lock, checkInvocationAccess: async () => allowed });
    try {
      await value.adoptProtectedTaskWakeJob(state.input);
      await value.reconcileInvocationAccess(RUN2);
      await value.reconcileAllInvocationAccess();
      expect(value.getForegroundWorkSummary().queuedTurns).toBe(1);
      expect(state.events).toEqual([]);
      allowed = false;
      await value.reconcileAllInvocationAccess();
      await state.released.promise;
      expect(state.events).toEqual(["released"]);
      expect(value.getForegroundWorkSummary().queuedTurns).toBe(0);
      expect(forbidden).toEqual([]);
    } finally { await held.release(); }
  });

  test("revocation during an uncertain completion never relabels or retries terminal settlement", async () => {
    const state = fixture();
    const settling = deferred();
    const response = deferred();
    let allowed = true;
    state.candidate.settle = async (_id, requested) => {
      state.events.push(`settle:${requested}`);
      settling.resolve();
      await response.promise;
      throw new Error("completion response lost");
    };
    const { value, forbidden } = manager({ checkInvocationAccess: async () => allowed });
    await value.adoptProtectedTaskWakeJob(state.input);
    await settling.promise;
    const job = value.getJob(state.input.scheduling.jobId)!;
    allowed = false;
    const reconciliation = value.reconcileAllInvocationAccess().catch((error: unknown) => error);
    response.resolve();
    expect(await reconciliation).toBeInstanceOf(Error);
    await state.released.promise;
    await drained(value);
    expect(job.status).toBe("running");
    expect(state.events.filter(event => event.startsWith("settle:"))).toEqual(["settle:completed"]);
    expect(state.events.filter(event => event === "effect")).toHaveLength(1);
    expect(forbidden).toEqual([]);
  });

  test("running revocation aborts only wake custody and preserves exact terminal settlement despite concurrent Room Stop", async () => {
    const state = fixture();
    const entered = deferred();
    let allowed = true;
    let observedAbort = false;
    state.candidate.settle = async (_id, requested) => {
      expect(state.isCustodyActive()).toBe(true);
      state.events.push(`settle:${requested}`);
      return { kind: "existing_terminal", status: "completed" };
    };
    const { value, forbidden } = manager({ checkInvocationAccess: async () => allowed });
    await value.adoptProtectedTaskWakeJob({ ...state.input,
      executor: async function* (_input, _id, _lane, signal) {
        entered.resolve();
        await new Promise<void>(resolve => signal.addEventListener("abort", () => {
          observedAbort = true; resolve();
        }, { once: true }));
        yield* [];
      },
    });
    await entered.promise;
    const job = value.getJob(state.input.scheduling.jobId)!;
    allowed = false;
    await Promise.all([value.reconcileAllInvocationAccess(), value.stopRoom(ROOM)]);
    await drained(value);
    expect(observedAbort).toBe(true);
    expect(job.status).toBe("completed");
    expect(state.events.filter(event => event.startsWith("settle:"))).toEqual(["settle:failed"]);
    expect(state.events.filter(event => event === "released")).toHaveLength(1);
    expect(forbidden).toEqual([]);
  });
});
