import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import type { DirectDatabase, Task, TaskRun } from "@nautilo/db";
import type { LocalExecutionDelegation } from "@nautilo/types";
import { setRelayRegistry, type ToolRelayRegistry } from "@nautilo/agent";
import { prepareTaskLocalExecutionTarget } from "../../src/tasks/task-run-executor";
import { createDelegatedLocalExecutionPort, isTaskLocalExecutionTargetAvailable,
  type DelegatedTaskIdentity } from "../../src/tasks/local-execution-delegation";

const delegation: LocalExecutionDelegation = { version: 1, humanUserId: "human", agentId: "agent",
  sourceRoomId: "room", sourceConversationId: "conversation", rootTaskId: "task", projectGrantId: "grant",
  ceiling: "basic", profile: null, target: { instanceId: "", relayId: "original-mac", pairingGeneration: "original-pairing",
    serverOrigin: "https://server.example", serverFingerprint: "fingerprint" } };
function fixture() {
  let task = { id: "task", ownerId: "owner", requestorId: "human", agentId: "agent", callingRoomId: "room",
    parentTaskId: null, targetRoomId: "task-room", scheduleKind: "now", status: "running",
    localExecutionDelegation: structuredClone(delegation), contentRepresentation: "ordinary", contentRevision: 0 } as Task;
  const run = { id: "original-run", taskId: task.id, jobId: "job", graphThreadId: "thread", status: "running" } as TaskRun;
  let allowed = true;
  let sourceCheck: (() => Promise<void>) | undefined;
  const controller = new AbortController();
  const port = createDelegatedLocalExecutionPort({ taskId: task.id, taskRunId: run.id, humanUserId: "human", agentId: "agent",
    signal: controller.signal, readTask: async () => structuredClone(task), readRun: async () => run,
    assertSource: async () => { if (!allowed) throw new Error("source withdrawn"); await sourceCheck?.(); } });
  const parked: { task: Task; run: TaskRun; jobId: string; phase: "cold" | "checkpoint" }[] = [];
  const input = { db: {} as DirectDatabase, task, run, jobId: "job", signal: controller.signal, phase: "cold" as "cold" | "checkpoint" };
  const deps = { readTask: async () => structuredClone(task), resolvePort: async () => port, targetAvailable: () => false,
    park: async (_db: DirectDatabase, observed: typeof parked[number]) => { parked.push(observed); return true; } };
  return { input, deps, parked, port, controller, revoke: () => { allowed = false; },
    setTask: (patch: Partial<DelegatedTaskIdentity>) => { task = { ...task, ...patch }; },
    onSource: (work: () => Promise<void>) => { sourceCheck = work; } };
}

test("original offline target parks before model, preserving the observed Task and Run", async () => {
  const f = fixture(); let modelCalls = 0;
  const prepared = await prepareTaskLocalExecutionTarget(f.input, f.deps);
  if (prepared.kind === "ready") modelCalls++;
  expect(prepared.kind).toBe("parked"); expect(modelCalls).toBe(0); expect(f.parked).toHaveLength(1);
  expect(f.parked[0]).toMatchObject({ task: { id: "task", localExecutionDelegation: delegation },
    run: { id: "original-run", graphThreadId: "thread" }, jobId: "job", phase: "cold" });
});
test("checkpoint continuation is explicitly parked as checkpoint, never classified cold by empty output", async () => {
  const f = fixture(); f.input.phase = "checkpoint";
  expect((await prepareTaskLocalExecutionTarget(f.input, f.deps)).kind).toBe("parked");
  expect(f.parked[0]).toMatchObject({ phase: "checkpoint", run: { id: "original-run", graphThreadId: "thread" } });
});
test("source denial or mutation during admission never becomes reconnect authorization", async () => {
  const f = fixture(); f.revoke();
  await rejects(prepareTaskLocalExecutionTarget(f.input, f.deps), /Saved Mac, project, or source access/); expect(f.parked).toHaveLength(0);
  const edited = fixture(); edited.onSource(async () => { edited.setTask({ localExecutionDelegation: null }); });
  await rejects(prepareTaskLocalExecutionTarget(edited.input, edited.deps), /Saved Mac, project, or source access/); expect(edited.parked).toHaveLength(0);
});
test("exact available target returns the freshly admitted port without parking", async () => {
  const f = fixture();
  expect(await prepareTaskLocalExecutionTarget(f.input, { ...f.deps, targetAvailable: () => true }))
    .toEqual({ kind: "ready", port: f.port }); expect(f.parked).toHaveLength(0);
});
test("tasks without delegation preserve ordinary cloud execution", async () => {
  const f = fixture(); f.input.task = { ...f.input.task, localExecutionDelegation: null };
  expect(await prepareTaskLocalExecutionTarget(f.input, { ...f.deps, resolvePort: async () => undefined })).toEqual({ kind: "ready" });
  expect(f.parked).toHaveLength(0);
});
test("Stop or definition CAS loss wins without generic failure terminalization", async () => {
  const f = fixture();
  expect(await prepareTaskLocalExecutionTarget(f.input, { ...f.deps, park: async () => false })).toEqual({ kind: "superseded" });
  f.controller.abort(new Error("Human stopped"));
  await rejects(prepareTaskLocalExecutionTarget(f.input, f.deps), /Human stopped/); expect(f.parked).toHaveLength(0);
});
test("awaited checks cannot mutate the frozen original snapshot handed to the CAS", async () => {
  const f = fixture();
  const prepared = await prepareTaskLocalExecutionTarget(f.input, { ...f.deps, resolvePort: async () => {
    f.input.task = { ...f.input.task, localExecutionDelegation: null }; return f.port;
  } });
  expect(prepared.kind).toBe("parked"); expect(f.parked[0]!.task.localExecutionDelegation).toEqual(delegation);
});
test("reconnect requires original Human, Mac, pairing and fresh supported Desktop contract", () => {
  let pairing = "original-pairing"; let user = "human"; let version = 28; let fresh = true; let present = true;
  const registry = { getCapabilities: (id: string) => present && id === "original-mac" ? {
    profile: "desktop-agent", canExecuteLocal: true, canDelegateLocalExecution: true,
    localExecution: { version: 1, generation: "host-generation", pipe: true, pty: true, capacity: 1024 } } : null,
    getUserId: () => user, getPairingGeneration: () => pairing, getProtocolVersion: () => version,
    isRelayHeartbeatFresh: () => fresh, getDesktopSessionId: () => "current-desktop",
    getLocalExecutionPairingGeneration: () => "projected-pairing",
  } as unknown as ToolRelayRegistry;
  setRelayRegistry(registry);
  try {
    expect(isTaskLocalExecutionTargetAvailable(delegation)).toBe(true);
    pairing = "replacement-pairing"; expect(isTaskLocalExecutionTargetAvailable(delegation)).toBe(false); pairing = "original-pairing";
    user = "another-human"; expect(isTaskLocalExecutionTargetAvailable(delegation)).toBe(false); user = "human";
    version = 27; expect(isTaskLocalExecutionTargetAvailable(delegation)).toBe(false); version = 28;
    fresh = false; expect(isTaskLocalExecutionTargetAvailable(delegation)).toBe(false); fresh = true;
    present = false; expect(isTaskLocalExecutionTargetAvailable(delegation)).toBe(false);
    expect(isTaskLocalExecutionTargetAvailable({ ...delegation, target: { ...delegation.target, relayId: "alternate-mac" } })).toBe(false);
  } finally { setRelayRegistry(null); }
});


test("withdrawn saved delegation cannot silently become cloud-only model execution", async () => {
  const f = fixture();
  await rejects(prepareTaskLocalExecutionTarget(f.input, { ...f.deps, resolvePort: async () => undefined }), /Saved Mac, project, or source access/);
  expect(f.parked).toHaveLength(0);
});
test("available target does not admit an older queued definition after a fresh canonical edit", async () => {
  const f = fixture();
  await rejects(prepareTaskLocalExecutionTarget(f.input, { ...f.deps, targetAvailable: () => true,
    readTask: async () => ({ ...f.input.task, prompt: "changed while queued" }) }), /Saved Mac, project, or source access/);
  expect(f.parked).toHaveLength(0);
});
