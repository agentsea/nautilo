import { beforeEach, expect, mock, test } from "bun:test";
import type { PersistedJobRecord } from "@nautilo/db";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { OrdinaryContentAccessRecoveryCoordinate, OrdinaryContentAccessRecoveryDeps } from "@nautilo/agent";
import { InMemoryLaneLock } from "../../src/lane-lock";
import { permissiveMaintenanceGate } from "../../src/maintenance-controller";

const agent = await import("@nautilo/agent");
const expected: OrdinaryContentAccessRecoveryCoordinate = {
  originalJobId: "job", graphThreadId: "thread", laneKey: "lane", roomId: "room",
  humanUserId: "human", humanActorId: "actor", agentId: "agent", checkpointId: "checkpoint",
  turnId: "turn", toolCallId: "share",
};
let latest: OrdinaryContentAccessRecoveryCoordinate | null = expected;
let resume: (signal?: AbortSignal) => Promise<void> = async () => {};
const read = mock(async () => latest);
const continued = mock(async (_expected: unknown, _deps: unknown, _processor: unknown, signal?: AbortSignal) => resume(signal));
mock.module("@nautilo/agent", () => ({ ...agent,
  readOrdinaryContentAccessRecovery: read,
  resumeOrdinaryContentAccessRecovery: continued,
}));
const { JobManager } = await import("../../src/job-manager");

const authority = createAcceptedInvocationAuthority("human");
const deps: OrdinaryContentAccessRecoveryDeps = { ordinaryContentAccessForState: () => ({ mode: "plaintext_only" }) };
const processor = { process() {}, flush() {} };
function harness() {
  const lock = new InMemoryLaneLock();
  let job: PersistedJobRecord = { id: "job", ownerId: "human", requestorId: "human",
    laneKey: "lane", type: "foreground", status: "failed",
    input: { graphThreadId: "thread", turnId: "turn", roomId: "room", agentId: "agent" },
    result: null, message: null, createdAt: new Date(), startedAt: new Date(), completedAt: new Date() };
  const manager = new JobManager({ laneLock: lock, readRecoveryJob: async () => job,
    maintenanceGate: permissiveMaintenanceGate, persist: async () => { throw new Error("Recovery must not persist another Job"); },
    updateStatus: async () => { throw new Error("Recovery must not change original Job"); } });
  return { manager, lock, setJob(change: Partial<PersistedJobRecord>) { job = { ...job, ...change }; } };
}
beforeEach(() => { latest = expected; resume = async () => {}; read.mockClear(); continued.mockClear(); });

test("fork recovery proves stored parent/checkpoint metadata after restart, without reviving the original Job", async () => {
  const f = harness();
  const fork = { ...expected, graphThreadId: "fork-checkpoint", executionOwner: {
    kind: "fork" as const, parentThreadId: "thread", transcriptThreadId: "thread" } };
  latest = fork;
  const input = { graphThreadId: "thread", turnId: "turn", roomId: "room", agentId: "agent",
    forkRun: { mode: "fork", parentThreadId: "thread", transcriptThreadId: "thread", forkThreadId: "fork-checkpoint", checkpointThreadId: "fork-checkpoint", sequence: 1 } };
  f.setJob({ input });
  expect(await f.manager.runOrdinaryContentAccessRecovery(fork, deps, processor, authority)).toBe("completed");
  f.setJob({ input: { ...input, forkRun: { ...input.forkRun, transcriptThreadId: "foreign" } } });
  expect(await f.manager.discoverOrdinaryContentAccessRecovery(fork, deps, authority)).toBeNull();
  expect(continued).toHaveBeenCalledTimes(1);
});

test("discovery admits failed and original completed approval Jobs, rejects durable cancellation and unrelated identity", async () => {
  const f = harness();
  expect(await f.manager.discoverOrdinaryContentAccessRecovery(expected, deps, authority)).toEqual(expected);
  f.setJob({ status: "completed" });
  expect(await f.manager.discoverOrdinaryContentAccessRecovery(expected, deps, authority)).toEqual(expected);
  for (const status of ["cancelled", "timed_out", "running", "queued"] as const) {
    f.setJob({ status });
    expect(await f.manager.discoverOrdinaryContentAccessRecovery(expected, deps, authority)).toBeNull();
  }
  f.setJob({ status: "failed", requestorId: "other" });
  expect(await f.manager.discoverOrdinaryContentAccessRecovery(expected, deps, authority)).toBeNull();
  expect(continued).not.toHaveBeenCalled();
});

test("busy is nonqueuing; latest checkpoint is reread while same thread lock is held", async () => {
  const f = harness();
  const held = await f.lock.tryAcquire("thread");
  if (!held.acquired) throw new Error("fixture lock failed");
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("busy");
  expect(read).not.toHaveBeenCalled();
  await held.release();
  let locked = false;
  read.mockImplementationOnce(async () => {
    locked = !(await f.lock.tryAcquire("thread")).acquired;
    return { ...expected, checkpointId: "newer" };
  });
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("unavailable");
  expect(locked).toBe(true);
  expect(continued).not.toHaveBeenCalled();
  const released = await f.lock.tryAcquire("thread");
  expect(released.acquired).toBe(true);
  if (released.acquired) await released.release();
});

test("duplicates cannot execute together; successful exact recovery registers ephemeral lifecycle and releases lock", async () => {
  const f = harness();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  resume = async () => { entered.resolve(); await finish.promise; latest = null; };
  const first = f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority);
  await entered.promise;
  expect(f.manager.getActiveJobIdsForRoom("room")).toHaveLength(1);
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("busy");
  finish.resolve();
  expect(await first).toBe("completed");
  expect(f.manager.getActiveJobIdsForRoom("room")).toHaveLength(0);
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("unavailable");
  expect(continued).toHaveBeenCalledTimes(1);
});

test("unknown outcome propagates exact-retry requirement and releases lock for explicit second request", async () => {
  const f = harness();
  resume = async () => { throw new agent.OrdinaryContentAccessRetryRequiredError(); };
  const error = await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(agent.OrdinaryContentAccessRetryRequiredError);
  resume = async () => {};
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("completed");
  expect(continued).toHaveBeenCalledTimes(2);
});

test("Room Stop aborts the exact ephemeral recovery and releases its lock", async () => {
  const f = harness();
  const entered = Promise.withResolvers<void>();
  resume = async (signal) => {
    entered.resolve();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => {
      latest = null; // Actual graph saves AbortError, not the recoverable typed error.
      reject(new DOMException("Stopped", "AbortError"));
    }, { once: true }));
  };
  const run = f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority);
  await entered.promise;
  await f.manager.stopRoom("room");
  const error = await run.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(DOMException);
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("unavailable");
  expect(f.manager.getActiveJobIdsForRoom("room")).toHaveLength(0);
});

test("Stop during asynchronous validation is not erased by recovery acceptance", async () => {
  const f = harness();
  read.mockImplementationOnce(async () => { await f.manager.stopRoom("room"); return expected; });
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("unavailable");
  expect(continued).not.toHaveBeenCalled();
  // A later explicit request may retry the still-failed operation; Stop did
  // not cancel any live Job or turn this historical failed Job into cancelled.
  expect(await f.manager.runOrdinaryContentAccessRecovery(expected, deps, processor, authority)).toBe("completed");
});
