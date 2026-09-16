import { afterEach, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { setMaintenanceGate, permissiveMaintenanceGate, MaintenanceDrainError } from "@nautilo/runtime";
import { taskContentAccessRecoveryRoutes, type TaskContentAccessRecoveryRouteDeps } from "../../src/routes/task-content-access-recovery";
const human = "10000000-0000-4000-8000-000000000001";
const actor = "10000000-0000-4000-8000-000000000002";
const taskId = "10000000-0000-4000-8000-000000000003";
const taskRunId = "10000000-0000-4000-8000-000000000004";
const coordinate = { taskId, taskRunId, checkpointId: "checkpoint", toolCallId: "call" };
const url = `/api/tasks/${taskId}/content-access-recovery`;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
function harness(options: { authenticated?: boolean; own?: boolean; plaintext?: boolean } = {}) {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async (request) => { if (options.authenticated !== false) {
    request.sessionUserId = human; request.sessionActorId = actor;
  } });
  const discover = mock<NonNullable<TaskContentAccessRecoveryRouteDeps["discover"]>>(async () => coordinate);
  const run = mock<NonNullable<TaskContentAccessRecoveryRouteDeps["run"]>>(async () => "completed");
  const select = mock<TaskContentAccessRecoveryRouteDeps["ordinaryContentAccessForState"]>(async () => ({ mode: "plaintext_only" }));
  taskContentAccessRecoveryRoutes(app, { discover, run, ordinaryContentAccessForState: select,
    task: async () => ({ id: taskId, ownerId: options.own === false ? "other" : human, requestorId: human } as NonNullable<Awaited<ReturnType<NonNullable<TaskContentAccessRecoveryRouteDeps["task"]>>>>),
    policy: async () => ({ mode: options.plaintext === false ? "encrypted_only" : "plaintext_only" } as Awaited<ReturnType<NonNullable<TaskContentAccessRecoveryRouteDeps["policy"]>>>),
  });
  return { app, discover, run, select };
}
test("owner discovers content-free coordinate, no-store; exact POST awaits actual outcome", async () => {
  const f = harness();
  const response = await f.app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json<unknown>()).toEqual({ recovery: coordinate });
  for (const outcome of ["completed", "busy", "unavailable", "retry_required"] as const) {
    f.run.mockResolvedValueOnce(outcome);
    expect((await f.app.inject({ method: "POST", url, payload: coordinate })).json<unknown>()).toEqual({ outcome });
  }
});
test("auth, owner and canonical mode fences apply before execution", async () => {
  expect((await harness({ authenticated: false }).app.inject({ method: "GET", url })).statusCode).toBe(401);
  expect((await harness({ own: false }).app.inject({ method: "GET", url })).statusCode).toBe(404);
  const f = harness({ plaintext: false });
  expect((await f.app.inject({ method: "GET", url })).json<unknown>()).toEqual({ recovery: null });
  expect((await f.app.inject({ method: "POST", url, payload: coordinate })).json<unknown>()).toEqual({ outcome: "unavailable" });
  expect(f.run).not.toHaveBeenCalled(); expect(f.discover).not.toHaveBeenCalled();
});
test("strict coordinate excludes graph/principal/token and must match path", async () => {
  const f = harness();
  for (const payload of [{ ...coordinate, graphThreadId: "foreign" }, { ...coordinate, taskId: human },
    { ...coordinate, previewToken: "secret" }, { taskId, taskRunId }]) {
    expect((await f.app.inject({ method: "POST", url, payload })).statusCode).toBe(400);
  }
  expect(f.run).not.toHaveBeenCalled();
});
test("maintenance denies the new request before acceptance authority or continuation", async () => {
  const f = harness();
  setMaintenanceGate({ assertAcceptingNewWork: async () => { throw new MaintenanceDrainError("draining"); }, isAcceptingWork: async () => false });
  try {
    expect((await f.app.inject({ method: "POST", url, payload: coordinate })).statusCode).toBe(503);
    expect(f.run).not.toHaveBeenCalled();
  } finally { setMaintenanceGate(permissiveMaintenanceGate); }
});
test("graph mode drift fails closed and raw checkpoint errors never escape", async () => {
  const f = harness();
  f.select.mockImplementation(async () => ({ mode: "unchanged" }));
  f.run.mockImplementationOnce(async (_expected, _user, _authorities, deps) => {
    await deps.graph.ordinaryContentAccessForState({} as Parameters<typeof deps.graph.ordinaryContentAccessForState>[0]);
    return "completed";
  });
  expect((await f.app.inject({ method: "POST", url, payload: coordinate })).json<unknown>()).toEqual({ outcome: "unavailable" });
  f.run.mockRejectedValueOnce(new Error("private checkpoint token"));
  const response = await f.app.inject({ method: "POST", url, payload: coordinate });
  expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private checkpoint");
});
