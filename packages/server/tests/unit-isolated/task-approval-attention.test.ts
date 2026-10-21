import { beforeEach, expect, mock, test } from "bun:test";
import Fastify from "fastify";
import type { Task, TaskRun } from "@nautilo/db";
import {
  bindEncryptionDataOperationOwner,
  type LiveShadowEncryptionTransitionPolicy,
} from "@nautilo/lattice-bridge";
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
let authorizedRepresentation: Task["contentRepresentation"] | undefined;
let nondelegatedRepresentation: Task["contentRepresentation"] | undefined;
let protectNondelegatedDuringReplay = false;
let removeNondelegatedDuringReplay = false;
let findCount = 0;
let failPolicyRevalidation = false;
let policyRevalidations = 0;
const query = mock(async () => rows);
const find = mock(async (_db: unknown, taskId: string, threadId: string) => {
  findCount++;
  if (removeNondelegatedDuringReplay && findCount > 1) return undefined;
  const value = rows.find(candidate => candidate.task.id === taskId
    && candidate.run.graphThreadId === threadId);
  return value === undefined ? undefined : { ...value,
    task: nondelegatedRepresentation === undefined ? value.task
      : { ...value.task, contentRepresentation: nondelegatedRepresentation } };
});
const authorize = mock(async (input: { taskId: string; threadId: string; sessionUserId: string }) => {
  const row = rows.find(value => value.task.id === input.taskId && value.run.graphThreadId === input.threadId);
  return row && allowed && canonicalRecipient(row.task) === input.sessionUserId
    ? { ok: true as const, ...row, task: authorizedRepresentation === undefined
      ? row.task : { ...row.task, contentRepresentation: authorizedRepresentation } }
    : { ok: false as const, status: 403, error: "source unavailable" };
});
mock.module("@nautilo/db", () => ({ ...actualDb, listAwaitingTaskRunsForOwner: query,
  findAwaitingTaskRunForApproval: find }));
mock.module("@nautilo/runtime", () => ({ ...actualRuntime,
  taskApprovalRecipient: canonicalRecipient, authorizeTaskApprovalResume: authorize,
  replayTaskInterruptEvents: async (ctx: Parameters<typeof actualInterrupt.replayTaskInterruptEvents>[0]) => {
    replayed++;
    if (revokeDuringReplay) allowed = false;
    if (protectNondelegatedDuringReplay) nondelegatedRepresentation = "protected";
    return canonicalReplay(ctx, async () => [{ type: "identity.challenge", mode: "enrollPin",
      threadId: "graph", laneKey: "task:task", userId: "management-owner" } as ServerEvent]);
  },
}));
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => ({}) }));
const { tasksRoutes } = await import("../../src/routes/tasks");
function row(localExecutionDelegation: unknown = delegation,
  contentRepresentation: Task["contentRepresentation"] = "ordinary") {
  return { task: { id: "task", ownerId: "management-owner", requestorId: "requestor", agentId: "agent", targetRoomId: null,
    localExecutionDelegation, contentRepresentation } as Task,
  run: { id: "run", graphThreadId: "graph" } as TaskRun };
}
beforeEach(() => { rows = [row()]; allowed = true; replayed = 0; revokeDuringReplay = false;
  authorizedRepresentation = undefined; nondelegatedRepresentation = undefined;
  protectNondelegatedDuringReplay = false; removeNondelegatedDuringReplay = false;
  findCount = 0; failPolicyRevalidation = false; policyRevalidations = 0;
  query.mockClear(); find.mockClear(); authorize.mockClear(); });
const plainPolicy: LiveShadowEncryptionTransitionPolicy = {
  mode: "plaintext_only",
  shadowBehavior: "fallback",
};
async function read(
  user: string,
  policy: LiveShadowEncryptionTransitionPolicy = plainPolicy,
) {
  const app = Fastify();
  app.addHook("preHandler", async request => { request.sessionUserId = user; });
  tasksRoutes(app, {
    observer: { kick() {} },
    contentOwner: bindEncryptionDataOperationOwner({
      policy: {
        resolve: async () => ({ policy, revalidationToken: 1 }),
        revalidate: async () => {
          policyRevalidations += 1;
          if (failPolicyRevalidation && policyRevalidations > 1) {
            throw new Error("policy changed");
          }
        },
      },
    }),
  });
  try { return await app.inject({ method: "GET", url: "/api/tasks/pending-attention" }); }
  finally { await app.close(); }
}
test("Plain reads ordinary attention without a protected runtime prerequisite", async () => {
  const response = await read("requestor");
  expect(response.statusCode).toBe(200);
  expect(response.json<ServerEvent[]>()).toMatchObject([
    { userId: "requestor", taskId: "task", taskRunId: "run", origin: "task" },
  ]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(replayed).toBe(1);
  expect(policyRevalidations).toBeGreaterThan(0);
});
test("Strict and Full reject ordinary attention before any query or checkpoint read", async () => {
  for (const policy of [
    { mode: "shadow_encryption", shadowBehavior: "strict" },
    { mode: "encrypted_only", shadowBehavior: "fallback" },
  ] as const) {
    const response = await read("requestor", policy);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: string }>()).toEqual({
      error: "task_content_unavailable",
    });
  }
  expect(query).not.toHaveBeenCalled();
  expect(find).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
  expect(replayed).toBe(0);
});
test("Fallback retains the legal ordinary attention read", async () => {
  const response = await read("requestor", {
    mode: "shadow_encryption",
    shadowBehavior: "fallback",
  });
  expect(response.statusCode).toBe(200);
  expect(response.json<ServerEvent[]>()).toMatchObject([{ taskId: "task", taskRunId: "run" }]);
  expect(query).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(replayed).toBe(1);
});
test("a failed policy revalidation discards attention without repeating access", async () => {
  failPolicyRevalidation = true;
  const response = await read("requestor");
  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain("taskRunId");
  expect(query).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(replayed).toBe(1);
});
test("requester-private checkpoint attention freshly admits source before and after replay", async () => {
  const response = await read("requestor");
  expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.json<ServerEvent[]>()).toMatchObject([{ userId: "requestor", taskId: "task", taskRunId: "run", origin: "task" }]);
  expect(query).toHaveBeenCalledWith({}, "requestor", { approvalRecipient: true });
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(replayed).toBe(1);
});
test("management owner, malformed descriptor and lost source receive no requesting-Human prompt", async () => {
  expect((await read("management-owner")).json<ServerEvent[]>()).toEqual([]); expect(replayed).toBe(0);
  rows = [row({ ...delegation, humanUserId: "management-owner" })];
  expect((await read("requestor")).json<ServerEvent[]>()).toEqual([]); expect(replayed).toBe(0);
  rows = [row()]; allowed = false;
  expect((await read("requestor")).json<ServerEvent[]>()).toEqual([]); expect(replayed).toBe(0);
  allowed = true; revokeDuringReplay = true;
  expect((await read("requestor")).json<ServerEvent[]>()).toEqual([]); expect(replayed).toBe(1);
});
test("ordinary Task approval projection remains management-owner scoped", async () => {
  rows = [row(null)];
  expect((await read("management-owner")).json<ServerEvent[]>()).toMatchObject([{ userId: "management-owner" }]);
  expect(authorize).not.toHaveBeenCalled();
  expect(find).toHaveBeenCalledTimes(2);
  expect((await read("requestor")).json<ServerEvent[]>()).toEqual([]);
});
test("legacy attention never opens dual or protected Task checkpoints", async () => {
  for (const representation of ["dual", "protected"] as const) {
    rows = [row(delegation, representation)];
    expect((await read("requestor")).json<ServerEvent[]>()).toEqual([]);
  }
  expect(authorize).not.toHaveBeenCalled();
  expect(replayed).toBe(0);

  rows = [row()];
  authorizedRepresentation = "protected";
  expect((await read("requestor")).json<ServerEvent[]>()).toEqual([]);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(replayed).toBe(0);
});
test("ordinary nondelegated attention is withheld after a concurrent representation change", async () => {
  rows = [row(null)];
  protectNondelegatedDuringReplay = true;
  expect((await read("management-owner")).json<ServerEvent[]>()).toEqual([]);
  expect(find).toHaveBeenCalledTimes(2);
  expect(replayed).toBe(1);
});
test("ordinary nondelegated attention is withheld when the awaiting row disappears", async () => {
  rows = [row(null)];
  removeNondelegatedDuringReplay = true;
  expect((await read("management-owner")).json<ServerEvent[]>()).toEqual([]);
  expect(find).toHaveBeenCalledTimes(2);
  expect(replayed).toBe(1);
});
