import { beforeEach, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { Task, TaskRun } from "@nautilo/db";
import type { ServerEvent } from "@nautilo/types";
const actualDb = await import("@nautilo/db");
const actualRuntime = await import("@nautilo/runtime");
const actualInterrupt = await import("../../../runtime/src/tasks/emit-task-interrupt");
const canonicalRecipient = actualInterrupt.taskApprovalRecipient;
const canonicalReplay = actualInterrupt.replayTaskInterruptEvents;
const delegation = { version: 1 as const, humanUserId: "requestor", agentId: "agent", sourceRoomId: "source",
  sourceConversationId: "thread", rootTaskId: "task", projectGrantId: "grant", ceiling: "basic" as const, profile: null,
  target: { instanceId: "", relayId: "relay", pairingGeneration: "pair", serverOrigin: "https://server.invalid", serverFingerprint: "fingerprint" } };
let rows: Array<{ task: Task; run: TaskRun }> = [];
let allowed = true;
let replayed = 0;
let revokeDuringReplay = false;
const query = mock(async () => rows);
const authorize = mock(async (input: { taskId: string; threadId: string; sessionUserId: string }) => {
  const row = rows.find(value => value.task.id === input.taskId && value.run.graphThreadId === input.threadId);
  return row && allowed && canonicalRecipient(row.task) === input.sessionUserId
    ? { ok: true as const, ...row } : { ok: false as const, status: 403, error: "source unavailable" };
});
mock.module("@nautilo/db", () => ({ ...actualDb, listAwaitingTaskRunsForOwner: query }));
mock.module("@nautilo/runtime", () => ({ ...actualRuntime,
  taskApprovalRecipient: canonicalRecipient, authorizeTaskApprovalResume: authorize,
  replayTaskInterruptEvents: async (ctx: Parameters<typeof actualInterrupt.replayTaskInterruptEvents>[0]) => {
    replayed++;
    if (revokeDuringReplay) allowed = false;
    return canonicalReplay(ctx, async () => [{ type: "identity.challenge", mode: "enrollPin",
      threadId: "graph", laneKey: "task:task", userId: "management-owner" } as ServerEvent]);
  },
}));
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => ({}) }));
const { tasksRoutes } = await import("../../src/routes/tasks");
function row(localExecutionDelegation: unknown = delegation) {
  return { task: { id: "task", ownerId: "management-owner", requestorId: "requestor", agentId: "agent", targetRoomId: null,
    localExecutionDelegation } as Task, run: { id: "run", graphThreadId: "graph" } as TaskRun };
}
beforeEach(() => { rows = [row()]; allowed = true; replayed = 0; revokeDuringReplay = false; query.mockClear(); authorize.mockClear(); });
async function read(user: string) {
  const app = Fastify();
  app.addHook("preHandler", async request => { request.sessionUserId = user; });
  tasksRoutes(app, { observer: { kick() {} }, contentOwner: {} as Parameters<typeof tasksRoutes>[1]["contentOwner"] });
  try { return await app.inject({ method: "GET", url: "/api/tasks/pending-attention" }); }
  finally { await app.close(); }
}
test("requester-private checkpoint attention freshly admits source before and after replay", async () => {
  const response = await read("requestor");
  expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json()).toMatchObject([{ userId: "requestor", taskId: "task", taskRunId: "run", origin: "task" }]);
  expect(query).toHaveBeenCalledWith({}, "requestor", { approvalRecipient: true });
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(replayed).toBe(1);
});
test("management owner, malformed descriptor and lost source receive no requesting-Human prompt", async () => {
  expect((await read("management-owner")).json()).toEqual([]); expect(replayed).toBe(0);
  rows = [row({ ...delegation, humanUserId: "management-owner" })];
  expect((await read("requestor")).json()).toEqual([]); expect(replayed).toBe(0);
  rows = [row()]; allowed = false;
  expect((await read("requestor")).json()).toEqual([]); expect(replayed).toBe(0);
  allowed = true; revokeDuringReplay = true;
  expect((await read("requestor")).json()).toEqual([]); expect(replayed).toBe(1);
});
test("ordinary Task approval projection remains management-owner scoped", async () => {
  rows = [row(null)];
  expect((await read("management-owner")).json()).toMatchObject([{ userId: "management-owner" }]);
  expect(authorize).not.toHaveBeenCalled();
  expect((await read("requestor")).json()).toEqual([]);
});
