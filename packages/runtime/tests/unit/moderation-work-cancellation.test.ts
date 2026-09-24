import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { WORK_ACCEPTANCE_REASONS, type PersistJobPayload } from "@nautilo/db";
import { Job, type JobExecutor } from "../../src/job";
import { JobManager, type WorkAcceptanceSinks } from "../../src/job-manager";
import { InMemoryLaneLock } from "../../src/lane-lock";
import type { ForegroundTurnCandidate } from "../../src/foreground-turn-lifecycle";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error("Expected runtime state was not reached");
}
function harness(options: {
  persist?: (payload: PersistJobPayload) => Promise<string>;
  invocationTaskStop?: (input: { humanUserId: string; taskId: string; taskRunId: string }) => Promise<void>;
  cancel?: WorkAcceptanceSinks["userCancelAcceptedWork"];
  check?: (input: { humanUserId: string; roomId?: string; taskId?: string; originRoomId?: string; originTaskId?: string }) => Promise<boolean>;
  laneLock?: InMemoryLaneLock;
  link?: WorkAcceptanceSinks["linkAcceptancesToJob"];
} = {}) {
  const denied = new Set<string>();
  const started: Array<{ message: string; signal: AbortSignal }> = [];
  const statuses: Array<{ jobId: string; status: string }> = [];
  const cancelled: Array<{ ids: readonly string[]; reason: string }> = [];
  const release = Promise.withResolvers<void>();
  cleanups.push(() => release.resolve());
  const timers = new Map<number, () => void>(); let timer = 0;
  let acceptance = 0;
  const manager = new JobManager({
    laneLock: options.laneLock ?? new InMemoryLaneLock(),
    persist: options.persist ?? (async () => randomUUID()),
    updateStatus: async (jobId, status) => { statuses.push({ jobId, status }); },
    checkInvocationAccess: options.check ?? (async ({ humanUserId, roomId }) => !denied.has(humanUserId) && !denied.has(`${humanUserId}:${roomId}`)),
    ...(options.invocationTaskStop ? { invocationTaskStop: options.invocationTaskStop } : {}),
    setTimer: ((fn: () => void) => { const id = ++timer; timers.set(id, fn); return id; }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout,
    acceptanceSinks: {
      insertAcceptance: async () => `acceptance-${++acceptance}`,
      linkAcceptancesToJob: options.link ?? (async ids => ids.length),
      terminalizeAllAcceptedWork: async () => 0,
      userCancelAcceptedWork: options.cancel ?? (async (ids, reason) => { cancelled.push({ ids, reason }); return ids.length; }),
    },
  });
  const executor: JobExecutor = async function* (input, _jobId, _lane, signal) {
    started.push({ message: String(input["message"]), signal });
    await release.promise;
    yield* [];
  };
  const room = randomUUID(), thread = randomUUID();
  const send = (human: string, message: string, opts: { room?: string; taskId?: string; taskRunId?: string; candidate?: ForegroundTurnCandidate } = {}) => {
    const roomId = opts.room ?? room;
    return manager.createForegroundJob("shared-agent-owner", human, `room:${roomId}:user:${human}`, {
      message, roomId, graphThreadId: opts.room ? randomUUID() : thread, turnId: randomUUID(),
      requestorId: human, ...opts,
    }, executor, undefined, { executor, coalescing: "coalesce", contention: "serialize" }, undefined, opts.candidate);
  };
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
  return { manager, send, flush, denied, started, statuses, cancelled, release, room, thread };
}

test("withdrawal cancels one initiating Human while another continues on the same thread", async () => {
  const h = harness();
  await h.send("target", "target active"); h.flush();
  await until(() => h.started.length === 1);
  await h.send("peer", "peer queued"); h.flush();
  await h.send("target", "target buffered one");
  await h.send("target", "target buffered two");
  h.denied.add("target");
  await h.manager.reconcileInvocationAccess("target");
  expect(h.started[0]!.signal.aborted).toBe(true);
  expect(h.cancelled.flatMap(row => row.ids)).toEqual(["acceptance-3", "acceptance-4"]);
  expect(h.cancelled[0]!.reason).toBe(WORK_ACCEPTANCE_REASONS.accessWithdrawn);
  h.flush(); h.release.resolve();
  await until(() => h.started.length === 2);
  expect(h.started[1]!.message).toBe("peer queued");
  expect(h.started[1]!.signal.aborted).toBe(false);
});

test("Room withdrawal preserves the same Human's work in another Room", async () => {
  const h = harness();
  await h.send("target", "denied room"); h.flush();
  await h.send("target", "other room", { room: randomUUID() }); h.flush();
  await until(() => h.started.length === 2);
  h.denied.add(`target:${h.room}`);
  await h.manager.reconcileInvocationAccess("target");
  expect(h.started.find(row => row.message === "denied room")!.signal.aborted).toBe(true);
  expect(h.started.find(row => row.message === "other room")!.signal.aborted).toBe(false);
});

test("current readmission prevents an old receipt from cancelling new work", async () => {
  const h = harness();
  await h.send("target", "readmitted"); h.flush();
  await until(() => h.started.length === 1);
  await h.manager.reconcileInvocationAccess("target");
  expect(h.started[0]!.signal.aborted).toBe(false);
  expect(h.cancelled).toHaveLength(0);
});

test("independent work owners reconcile shared authority without a receipt winner", async () => {
  const denied = new Set<string>();
  const first = harness({ check: async ({ humanUserId }) => !denied.has(humanUserId) });
  const second = harness({ check: async ({ humanUserId }) => !denied.has(humanUserId) });
  await first.send("target", "first worker"); first.flush();
  await second.send("target", "second worker"); second.flush();
  await second.send("peer", "unrelated worker", { room: randomUUID() }); second.flush();
  await until(() => first.started.length === 1 && second.started.length === 2);
  denied.add("target");
  await first.manager.reconcileAllInvocationAccess();
  expect(first.started[0]!.signal.aborted).toBe(true);
  expect(second.started[0]!.signal.aborted).toBe(false);
  await second.manager.reconcileAllInvocationAccess();
  expect(second.started.find(row => row.message === "second worker")!.signal.aborted).toBe(true);
  expect(second.started.find(row => row.message === "unrelated worker")!.signal.aborted).toBe(false);
});

test("one failed Human check cannot shelter another Human from the process sweep", async () => {
  let reconcile = false;
  const h = harness({ check: async ({ humanUserId }) => {
    if (!reconcile) return true;
    if (humanUserId === "unavailable") throw new Error("Fixture lookup failed");
    return false;
  } });
  await h.send("unavailable", "lookup unavailable"); h.flush();
  await h.send("target", "must cancel", { room: randomUUID() }); h.flush();
  await until(() => h.started.length === 2);
  reconcile = true;
  await Promise.resolve(expect(h.manager.reconcileAllInvocationAccess()).rejects.toThrow("Fixture lookup failed"));
  expect(h.started.find(row => row.message === "must cancel")!.signal.aborted).toBe(true);
});

test("a continuation cannot replace its opaque Room origin with a new Job Room", async () => {
  const source = randomUUID(), delivery = randomUUID();
  const observed: Array<unknown> = [];
  const h = harness({ check: async input => { observed.push(input); return input.originRoomId !== source; } });
  let executed = false;
  await h.manager.runResumeJobLifecycle({ humanUserId: "target", roomId: delivery,
    laneKey: `room:${delivery}`, graphThreadId: randomUUID() }, async () => { executed = true; },
  createAcceptedInvocationAuthority("target", { originRoomId: source }));
  expect(executed).toBe(false);
  expect(observed).toEqual([expect.objectContaining({ roomId: delivery, originRoomId: source })]);
});

test("background acceptance retains an inherited Task origin", async () => {
  const originTaskId = randomUUID();
  const observed: unknown[] = [];
  const h = harness({ check: async input => { observed.push(input); return false; } });
  const job = await h.manager.createBackgroundJob("owner", "target", { message: "Synthetic background" },
    undefined, createAcceptedInvocationAuthority("target", { originTaskId }));
  await until(() => job.isTerminal());
  expect(observed).toEqual([expect.objectContaining({ originTaskId })]);
});

test("queued merged work is removed without stopping its thread's active peer", async () => {
  const h = harness();
  await h.send("peer", "peer active"); h.flush();
  await until(() => h.started.length === 1);
  await h.send("target", "queued one"); await h.send("target", "queued two"); h.flush();
  await until(() => h.manager.getExecutableJobWorkSummary().queuedTurns === 1);
  h.denied.add("target"); await h.manager.reconcileInvocationAccess("target");
  expect(h.manager.getExecutableJobWorkSummary().queuedTurns).toBe(0);
  expect(h.started[0]!.signal.aborted).toBe(false);
  expect(h.cancelled.flatMap(row => row.ids)).toEqual(["acceptance-2", "acceptance-3"]);
});

test("withdrawal during Job persistence prevents execution", async () => {
  const persisted = Promise.withResolvers<string>();
  let persisting = false;
  const h = harness({ persist: async () => { persisting = true; return persisted.promise; } });
  await h.send("target", "persist race"); h.flush();
  await until(() => persisting);
  h.denied.add("target"); await h.manager.reconcileInvocationAccess("target");
  persisted.resolve(randomUUID());
  await until(() => h.statuses.some(row => row.status === "cancelled"));
  expect(h.started).toHaveLength(0);
});

test("a delayed foreground candidate checks access immediately before execution", async () => {
  const ready = Promise.withResolvers<void>();
  let armed = false;
  const h = harness();
  await h.send("target", "delayed", { candidate: {
    onMainTurn: () => {}, onIneligible: () => {},
    runMainTurn: async (_turn, execute) => { armed = true; await ready.promise; return execute(); },
  } }); h.flush();
  await until(() => armed);
  h.denied.add("target"); ready.resolve();
  await until(() => h.statuses.some(row => row.status === "cancelled"));
  expect(h.started).toHaveLength(0);
});

test("queued ledger failures are retried even after readmission", async () => {
  let fail = true; const receipts: string[] = [];
  const h = harness({ cancel: async ids => { if (fail) throw new Error("ledger unavailable"); receipts.push(...ids); return ids.length; } });
  await h.send("target", "buffered"); h.denied.add("target");
  await Promise.resolve(expect(h.manager.reconcileInvocationAccess("target")).rejects.toThrow("ledger unavailable"));
  h.denied.clear(); fail = false;
  await h.manager.reconcileInvocationAccess("target");
  expect(receipts).toEqual(["acceptance-1"]);
  h.flush(); expect(h.started).toHaveLength(0);
});

test("Task work delegates the exact Human and run; a failed lifecycle write remains retryable", async () => {
  const requests: unknown[] = []; let fail = true;
  const h = harness({ invocationTaskStop: async input => { requests.push(input); if (fail) throw new Error("Task unavailable"); } });
  await h.send("target", "Task", { taskId: "task", taskRunId: "run" }); h.flush();
  await until(() => h.started.length === 1);
  h.denied.add("target");
  await Promise.resolve(expect(h.manager.reconcileInvocationAccess("target")).rejects.toThrow("Task unavailable"));
  fail = false; await h.manager.reconcileInvocationAccess("target");
  expect(requests).toEqual(Array(2).fill({ humanUserId: "target", taskId: "task", taskRunId: "run" }));
  expect(h.started[0]!.signal.aborted).toBe(true);
});

test("approval resume cannot execute after the Human loses access", async () => {
  const h = harness(); h.denied.add("target"); let resumed = false;
  await h.manager.runResumeJobLifecycle({
    humanUserId: "target", laneKey: `room:${h.room}`, roomId: h.room, graphThreadId: h.thread,
  }, async () => { resumed = true; }, createAcceptedInvocationAuthority("target"));
  expect(resumed).toBe(false);
});

test("authority lookup failure fails closed before execution", async () => {
  const h = harness({ check: async () => { throw new Error("authority unavailable"); } });
  await h.send("target", "unavailable"); h.flush();
  await until(() => h.statuses.some(row => row.status === "cancelled"));
  expect(h.started).toHaveLength(0);
});

test("Job execution cannot revive a cancellation before its controller exists", async () => {
  let executed = false;
  const job = new Job({ ownerId: "owner", requestorId: "target", laneKey: null, type: "foreground", input: {},
    persist: async () => randomUUID(), updateStatus: async () => {},
    executor: async function* () { executed = true; yield* []; },
  });
  await job.persist(); await job.cancel(); await job.execute();
  expect(executed).toBe(false); expect(job.status).toBe("cancelled");
});


test("a ledger link already in flight cannot revive cancelled work after readmission", async () => {
  const linked = Promise.withResolvers<number>(); let linking = false;
  const h = harness({ link: async () => { linking = true; return linked.promise; } });
  await h.send("target", "link race"); h.flush(); await until(() => linking);
  h.denied.add("target"); await h.manager.reconcileInvocationAccess("target");
  h.denied.clear(); linked.resolve(1);
  await until(() => h.statuses.some(row => row.status === "cancelled"));
  expect(h.started).toHaveLength(0);
});

test("a cancelled Job retries a failed durable status write", async () => {
  let writes = 0;
  const job = new Job({ ownerId: "owner", requestorId: "target", laneKey: null, type: "foreground", input: {},
    persist: async () => randomUUID(), updateStatus: async () => { if (++writes === 1) throw new Error("status unavailable"); },
    executor: async function* () { yield* []; },
  });
  await job.persist(); await Promise.resolve(expect(job.cancel()).rejects.toThrow("status unavailable"));
  await job.cancel(); expect(writes).toBe(2); expect(job.status).toBe("cancelled");
});


test("background work checks current authority after persistence", async () => {
  const h = harness(); h.denied.add("target");
  const job = await h.manager.createBackgroundJob("shared-agent-owner", "target", { type: "slow", roomId: h.room });
  await until(() => job.isTerminal());
  expect(job.status).toBe("cancelled");
  expect(h.statuses.some(row => row.status === "running")).toBe(false);
});

test("failed queued Task cancellation does not shelter a different active job", async () => {
  const h = harness({ invocationTaskStop: async () => { throw new Error("Task unavailable"); } });
  await h.send("target", "active"); h.flush(); await until(() => h.started.length === 1);
  await h.send("target", "blocked Task", { taskId: "task", taskRunId: "run" });
  h.denied.add("target");
  await Promise.resolve(expect(h.manager.reconcileInvocationAccess("target")).rejects.toThrow("Task unavailable"));
  expect(h.started[0]!.signal.aborted).toBe(true);
});

test("a newer send on the same buffered lane is preserved across a withdrawal query", async () => {
  const checked = Promise.withResolvers<boolean>();
  let checking = false;
  const h = harness({ check: async () => { if (!checking) { checking = true; return checked.promise; } return true; } });
  await h.send("target", "old acceptance");
  const reconcile = h.manager.reconcileInvocationAccess("target");
  await until(() => checking);
  await h.send("target", "readmitted acceptance");
  checked.resolve(false); await reconcile;
  h.flush(); await until(() => h.started.length === 1);
  expect(h.started[0]!.message).toBe("readmitted acceptance");
  expect(h.cancelled.flatMap(row => row.ids)).toEqual(["acceptance-1"]);
});
