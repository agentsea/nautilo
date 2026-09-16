import { describe, expect, test } from "bun:test";

import { createTaskRoomHandoffController, taskRoomHandoffTarget, type TaskRoomHandoffTarget } from "./task-room-handoff";

const TASK_A = "b487068d-9720-4f0f-a7a0-e84d9e4bff54";
const TASK_B = "6f1b16fb-b1a6-46c8-a3ca-690c4d87931b";
const ROOM_A = "db598925-a465-4b0a-b3c8-9f7c6cffc011";
const ROOM_B = "db598925-a465-4b0a-b3c8-9f7c6cffc012";

const target = (patch: Partial<TaskRoomHandoffTarget> = {}): TaskRoomHandoffTarget => ({
  serverId: "server-a", serverUrl: "https://a.example", userId: "owner-a", actorId: "actor-a", viewerEpoch: 1, taskId: TASK_A, targetRoomId: ROOM_A, ...patch,
});
const authorized = (input: TaskRoomHandoffTarget) => ({ roomId: input.targetRoomId, sessionUserId: input.userId, sessionActorId: input.actorId });
const authorizedApi = (calls?: string[]) => ({
  getRoom: async (input: TaskRoomHandoffTarget) => { calls?.push(`room:${input.targetRoomId}`); return { id: input.targetRoomId }; },
  whoami: async (input: TaskRoomHandoffTarget) => { calls?.push(`whoami:${input.userId}:${input.actorId}`); return { sessionUserId: input.userId, sessionActorId: input.actorId }; },
});
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };

describe("Task Room handoff", () => {
  test("admits only an awaiting exact target without competing Task attention", () => {
    const input = { detailTarget: target(), taskStatus: "awaiting", targetRoomId: ROOM_A, attentionPending: false };
    expect(taskRoomHandoffTarget(input)).toMatchObject({ targetRoomId: ROOM_A, taskId: TASK_A });
    for (const patch of [
      { taskStatus: "running" },
      { taskStatus: "completed" },
      { targetRoomId: null },
      { targetRoomId: "foreign" },
      { attentionPending: true },
      { detailTarget: null },
    ]) expect(taskRoomHandoffTarget({ ...input, ...patch })).toBeNull();
  });

  test("requires the exact member Room and fresh matching session before one navigation target", async () => {
    const controller = createTaskRoomHandoffController(); const calls: string[] = [];
    controller.setTarget(target());
    const result = await controller.authorize(authorizedApi(calls));
    expect(result).toEqual({ status: "navigate", target: target() });
    expect(calls).toEqual([`room:${ROOM_A}`, "whoami:owner-a:actor-a"]);
    expect(controller.getState()).toMatchObject({ phase: "authorized", error: null });
  });

  test("never retains Room bytes or an affordance after absent, foreign, or session-mismatched authorization", async () => {
    let whoamiCalls = 0;
    const missing = createTaskRoomHandoffController(); missing.setTarget(target());
    expect(await missing.authorize({ getRoom: async () => { throw Object.assign(new Error("not found"), { status: 404 }); }, whoami: async () => { whoamiCalls += 1; return { sessionUserId: "owner-a", sessionActorId: "actor-a" }; } })).toEqual({ status: "unavailable" });
    expect(whoamiCalls).toBe(0);
    for (const api of [
      { getRoom: async () => ({ id: ROOM_B }), whoami: async () => ({ sessionUserId: "owner-a", sessionActorId: "actor-a" }) },
      { getRoom: async () => ({ id: ROOM_A }), whoami: async () => ({ sessionUserId: "owner-b", sessionActorId: "actor-b" }) },
    ]) {
      const controller = createTaskRoomHandoffController(); controller.setTarget(target());
      expect(await controller.authorize(api)).toEqual({ status: "unavailable" });
      expect(controller.getState()).toEqual({ target: target(), phase: "unavailable", error: null });
      expect(JSON.stringify(controller.getState())).not.toContain("not found");
    }
  });

  test("scope, Task, or Room changes synchronously fence a late authorization", async () => {
    const pending = deferred<ReturnType<typeof authorized>>(); const controller = createTaskRoomHandoffController();
    controller.setTarget(target());
    const old = controller.authorize({ getRoom: async () => ({ id: ROOM_A }), whoami: async () => pending.promise.then((receipt) => ({ sessionUserId: receipt.sessionUserId, sessionActorId: receipt.sessionActorId })) });
    controller.setTarget(target({ taskId: TASK_B, targetRoomId: ROOM_B, viewerEpoch: 2, userId: "owner-b", actorId: "actor-b" }));
    pending.resolve(authorized(target()));
    expect(await old).toEqual({ status: "ignored" });
    expect(controller.getState()).toMatchObject({ target: { taskId: TASK_B, targetRoomId: ROOM_B, viewerEpoch: 2 }, phase: "idle" });
  });

  test("open repeats one fresh preflight, suppresses rapid taps, and fails closed after membership revocation", async () => {
    const controller = createTaskRoomHandoffController(); const press = deferred<ReturnType<typeof authorized>>(); const sequence: string[] = []; let calls = 0;
    controller.setTarget(target());
    await controller.authorize(authorizedApi(sequence));
    const api = { getRoom: async (next: TaskRoomHandoffTarget) => {
      sequence.push("room");
      calls += 1;
      return calls === 1 ? press.promise.then((receipt) => ({ id: receipt.roomId })) : { id: next.targetRoomId };
    }, whoami: async (next: TaskRoomHandoffTarget) => { sequence.push("whoami"); return { sessionUserId: next.userId, sessionActorId: next.actorId }; } };
    const first = controller.open(api);
    expect(await controller.open(api)).toEqual({ status: "ignored" });
    expect(calls).toBe(1);
    press.resolve(authorized(target()));
    expect((await first).status).toBe("navigate");
    expect(sequence).toEqual([`room:${ROOM_A}`, "whoami:owner-a:actor-a", "room", "whoami"]);

    expect(await controller.open({ getRoom: async () => { throw Object.assign(new Error("revoked"), { status: 404 }); }, whoami: async () => ({ sessionUserId: "owner-a", sessionActorId: "actor-a" }) })).toEqual({ status: "unavailable" });
    expect(controller.getState()).toMatchObject({ phase: "unavailable", error: "Room unavailable." });
  });

  test("a synchronous router failure leaves the authorized retry target and generic recovery intact", async () => {
    const controller = createTaskRoomHandoffController(); controller.setTarget(target());
    await controller.authorize(authorizedApi());
    controller.reportNavigationFailure();
    expect(controller.getState()).toMatchObject({ phase: "authorized", error: "Room unavailable." });
    expect((await controller.open(authorizedApi())).status).toBe("navigate");
  });

  test("a target change after an open preflight resolves but before routing makes that receipt inert", async () => {
    const controller = createTaskRoomHandoffController(); controller.setTarget(target());
    await controller.authorize(authorizedApi());
    const result = await controller.open(authorizedApi());
    if (result.status !== "navigate") throw new Error("expected authorized handoff");
    controller.setTarget(target({ taskId: TASK_B, targetRoomId: ROOM_B }));
    expect(controller.mayNavigate(result.target)).toBeFalse();
  });
});
