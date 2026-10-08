import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { createTaskLocalExecutionAdmission, createDelegatedLocalExecutionPort, type DelegatedTaskIdentity } from "../../src/tasks/local-execution-delegation";
import type { LocalExecutionDelegation } from "@nautilo/types";
const delegation: LocalExecutionDelegation = { version: 1, humanUserId: "human", agentId: "agent", sourceRoomId: "room",
  sourceConversationId: "conversation", rootTaskId: "root", projectGrantId: "grant", ceiling: "basic", profile: null,
  target: { instanceId: "", relayId: "relay", pairingGeneration: "pairing", serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } };
const root: DelegatedTaskIdentity = { id: "root", ownerId: "owner", requestorId: "human", agentId: "agent", callingRoomId: "room",
  parentTaskId: null, targetRoomId: "task-room", scheduleKind: "now", status: "completed", localExecutionDelegation: delegation, contentRepresentation: "ordinary", contentRevision: 0 };
function fixture() {
  const rows = new Map<string, DelegatedTaskIdentity>([["root", structuredClone(root)], ["child", { ...root, id: "child", parentTaskId: "root", status: "running" }]]);
  let allowed = true;
  const port = createTaskLocalExecutionAdmission({ taskId: "child", taskRunId: "run", humanUserId: "human", agentId: "agent",
    signal: new AbortController().signal, readTask: async id => structuredClone(rows.get(id)),
    readRun: async () => ({ id: "run", taskId: "child", status: "running" }), assertSource: async () => { if (!allowed) throw new Error("source revoked"); } });
  return { rows, port, revoke: () => { allowed = false; } };
}
test("canonical lineage permits later runs after normal parent completion", async () => {
  const f = fixture(); expect(await f.port.withAdmission(async source => source.projectGrantId)).toBe("grant");
});
test("definition changes and parent cancellation deny before execution", async () => {
  for (const patch of [{ localExecutionDelegation: null }, { status: "cancelled" as const }, { parentTaskId: "child" }]) {
    const f = fixture(); f.rows.set("root", { ...root, ...patch }); let calls = 0;
    await rejects(f.port.withAdmission(async () => { calls++; }), /UNAVAILABLE/); expect(calls).toBe(0);
  }
});
test("post-effect source loss aborts retained work and suppresses its result", async () => {
  const f = fixture(); let observed: AbortSignal | undefined;
  await rejects(f.port.withAdmission(async (_source, signal) => { observed = signal; f.revoke(); return "private bytes"; }), /source revoked/);
  expect(observed?.aborted).toBe(true);
});
test("transport failure is not converted into a process deadline", async () => {
  const f = fixture(); await rejects(f.port.withAdmission(async () => { throw new Error("receipt lost"); }), /receipt lost/);
  expect(f.port.signal.aborted).toBe(false);
});

test("definition changed during source admission is denied before dispatch", async () => {
  let current = { ...root, status: "running" as const };
  let calls = 0;
  const port = createTaskLocalExecutionAdmission({ taskId: "root", taskRunId: "run", humanUserId: "human", agentId: "agent",
    signal: new AbortController().signal, readTask: async () => structuredClone(current),
    readRun: async () => ({ id: "run", taskId: "root", status: "running" }),
    assertSource: async () => { current = { ...current, contentRevision: current.contentRevision + 1 }; },
  });
  await rejects(port.withAdmission(async () => { calls++; }), /UNAVAILABLE/);
  expect(calls).toBe(0);
});

test("pending recurring definition retains only its exact running occurrence", async () => {
  const f = fixture(); const child = f.rows.get("child")!;
  f.rows.set("child", { ...child, scheduleKind: "cron", status: "pending" });
  expect(await f.port.withAdmission(async () => "allowed")).toBe("allowed");
  f.rows.set("child", { ...child, scheduleKind: "one_shot", status: "pending" });
  await rejects(f.port.withAdmission(async () => "unexpected"), /UNAVAILABLE/);
});
test("transport failure keeps its error but independently confirmed revocation aborts", async () => {
  const f = fixture(); await rejects(f.port.withAdmission(async () => { f.revoke(); throw new Error("receipt lost"); }), /receipt lost/);
  expect(f.port.signal.aborted).toBe(true);
});

test("nested work preserves original source while executing in its parent Task Room", async () => {
  const f = fixture();
  f.rows.set("child", { ...f.rows.get("child")!, callingRoomId: "task-room" });
  expect(await f.port.withAdmission(async descriptor => descriptor.sourceRoomId)).toBe("room");
  f.rows.set("root", { ...f.rows.get("root")!, targetRoomId: "unrelated-room" });
  await rejects(f.port.withAdmission(async () => "unexpected"), /UNAVAILABLE/);
});

test("each ancestor descriptor matches its own canonical Human and Agent", async () => {
  for (const patch of [{ agentId: "wrong-agent" }, { humanUserId: "wrong-human" }]) {
    const f = fixture();
    f.rows.set("root", { ...root, localExecutionDelegation: { ...delegation, ...patch } });
    await rejects(f.port.withAdmission(async () => "unexpected"), /UNAVAILABLE/);
  }
});

test("normal completion permits retained reads and refuses new input without revoking an existing command", async () => {
  let task = { ...root, status: "running" as DelegatedTaskIdentity["status"] };
  let runStatus: "running" | "completed" = "running";
  const port = createDelegatedLocalExecutionPort({ taskId: "root", taskRunId: "run", humanUserId: "human", agentId: "agent",
    signal: new AbortController().signal, readTask: async () => structuredClone(task),
    readRun: async () => ({ id: "run", taskId: "root", status: runStatus }), assertSource: async () => {},
  });
  expect(await port.withAdmission("start", async () => {
    task = { ...task, status: "completed" }; runStatus = "completed";
    return "running-command";
  })).toBe("running-command");
  expect(await port.withAdmission("read", async () => "retained output")).toBe("retained output");
  await rejects(port.withAdmission("input", async () => "unexpected"), /UNAVAILABLE/);
  expect(port.signal.aborted).toBe(false);
  task = { ...task, status: "cancelled" };
  await rejects(port.withAdmission("read", async () => "unexpected"), /UNAVAILABLE/);
  expect(port.signal.aborted).toBe(true);
});


test("retained source watches explicit revocation after normal completion and releases its listener", async () => {
  let task = { ...root, status: "running" as DelegatedTaskIdentity["status"] };
  let status: "running" | "awaiting" | "completed" = "running";
  let changed: (() => void) | undefined;
  let subscriptions = 0;
  const port = createDelegatedLocalExecutionPort({ taskId: "root", taskRunId: "run", humanUserId: "human", agentId: "agent",
    signal: new AbortController().signal, readTask: async () => structuredClone(task),
    readRun: async () => ({ id: "run", taskId: "root", status }), assertSource: async () => {},
    subscribeChanges: callback => { subscriptions++; changed = callback; return () => { subscriptions--; changed = undefined; }; },
  });
  let release: (() => void) | undefined;
  await port.withAdmission("start", async () => { release = port.retain!(); });
  expect(subscriptions).toBe(1);
  task = { ...task, status: "awaiting" }; status = "awaiting";
  changed!();
  await port.withAdmission("read", async () => undefined);
  expect(port.signal.aborted).toBe(false);
  await rejects(port.withAdmission("input", async () => "unexpected"), /UNAVAILABLE/);
  expect(port.signal.aborted).toBe(false);
  task = { ...task, status: "completed" }; status = "completed";
  changed!();
  await port.withAdmission("read", async () => undefined);
  expect(port.signal.aborted).toBe(false);
  const aborted = new Promise<void>(resolve => port.signal.addEventListener("abort", () => resolve(), { once: true }));
  task = { ...task, localExecutionDelegation: null }; changed!();
  await aborted;
  expect(subscriptions).toBe(0);
  release!();
  expect(subscriptions).toBe(0);
});

test("failed admission and unretained reads do not leave source subscriptions", async () => {
  let count = 0;
  const port = createDelegatedLocalExecutionPort({ taskId: "missing", taskRunId: "run", humanUserId: "human", agentId: "agent",
    signal: new AbortController().signal, readTask: async () => undefined, readRun: async () => undefined,
    assertSource: async () => {}, subscribeChanges: () => { count++; return () => { count--; }; },
  });
  await rejects(port.withAdmission("start", async () => "unexpected"), /UNAVAILABLE/);
  expect(count).toBe(0);
});

test("a later automatic offline wait preserves retained work but Human Pause revokes it", async () => {
  for (const waitingAncestor of [false, true]) {
    let autoWait = false;
    let humanPaused = false;
    let changed: (() => void) | undefined;
    const own = waitingAncestor ? { ...root, id: "child", parentTaskId: "root", status: "completed" as const } : root;
    const read = (id: string): DelegatedTaskIdentity => {
      const value = id === "root" ? root : own;
      return { ...value, status: autoWait && id === "root" ? "paused" : value.status,
        lastError: humanPaused ? "Paused by Human" : autoWait ? "Automatic wait" : null };
    };
    const port = createDelegatedLocalExecutionPort({ taskId: own.id, taskRunId: "old-run", humanUserId: "human", agentId: "agent",
      signal: new AbortController().signal, readTask: async id => read(id),
      readRun: async () => ({ id: "old-run", taskId: own.id, status: "completed" }), assertSource: async () => {},
      readAutomaticOfflineWait: async id => autoWait && !humanPaused && id === "root" ? { taskRunId: "new-run" } : null,
      subscribeChanges: check => { changed = check; return () => { changed = undefined; }; },
    });
    const release = port.retain!();
    autoWait = true; changed!();
    expect(await port.withAdmission("read", async () => "retained")).toBe("retained");
    expect(port.signal.aborted).toBe(false);
    await rejects(port.withAdmission("input", async () => "unexpected"), /UNAVAILABLE/);
    expect(port.signal.aborted).toBe(false);
    const aborted = new Promise<void>(resolve => port.signal.addEventListener("abort", () => resolve(), { once: true }));
    humanPaused = true; changed!(); await aborted;
    expect(port.signal.aborted).toBe(true); release();
  }
});
