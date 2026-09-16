import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { OrdinaryContentAccessRetryRequiredError, type OrdinaryContentAccessRecoveryCoordinate } from "@nautilo/agent";
import { botThreadId } from "@nautilo/runtime";
import { ordinaryContentAccessRecoveryRoutes, type OrdinaryContentAccessRecoveryRouteDeps } from "../../src/routes/ordinary-content-access-recovery";

const roomId = "10000000-0000-4000-8000-000000000001";
const human = "10000000-0000-4000-8000-000000000002";
const actor = "10000000-0000-4000-8000-000000000003";
const agentId = "10000000-0000-4000-8000-000000000004";
const jobId = "10000000-0000-4000-8000-000000000005";
const url = `/api/rooms/${roomId}/content-access-recovery`;
const body = { originalJobId: jobId, checkpointId: "checkpoint", turnId: "turn", toolCallId: "call", agentId };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function harness(options: { member?: boolean; multiHuman?: boolean; authenticated?: boolean; mode?: "plaintext_only" | "encrypted_only"; staleJob?: boolean } = {}) {
  const app = Fastify(); apps.push(app);
  const observedBodies: unknown[] = [];
  app.addHook("preHandler", async (request) => {
    observedBodies.push(request.body);
    if (options.authenticated !== false) { request.sessionUserId = human; request.sessionActorId = actor; }
  });
  const thread = options.multiHuman ? botThreadId(roomId, agentId) : "canonical-direct-thread";
  const found: OrdinaryContentAccessRecoveryCoordinate = { ...body, graphThreadId: thread, laneKey: "canonical-lane",
    roomId, humanUserId: human, humanActorId: actor };
  const discover = mock<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["manager"]>["discoverOrdinaryContentAccessRecovery"]>(async () => found);
  const run = mock<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["manager"]>["runOrdinaryContentAccessRecovery"]>(async () => "completed");
  const latestJob = mock<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["latestJob"]>>(async () => ({ id: jobId, requestorId: options.staleJob ? "someone-else" : human,
    laneKey: "canonical-lane", input: { graphThreadId: thread, agentId, roomId } }));
  const admit = mock<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["assertCanInvokeAgent"]>>(async () => {});
  const processor = mock<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["processor"]>>(() => ({ process() {}, flush() {} }));
  const select = mock<OrdinaryContentAccessRecoveryRouteDeps["ordinaryContentAccessForState"]>(() => ({ mode: "plaintext_only" }));
  const forkPage = mock<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["forkPage"]>>(async () => ({ jobs: [], nextCursor: null }));
  ordinaryContentAccessRecoveryRoutes(app, {
    ordinaryContentAccessForState: select,
    manager: { discoverOrdinaryContentAccessRecovery: discover, runOrdinaryContentAccessRecovery: run },
    roomDetail: async () => options.member === false ? null : ({ id: roomId, kind: "private", graphThreadId: "canonical-direct-thread",
      members: [{ kind: "user" }, { kind: "agent", agentId }, ...(options.multiHuman ? [{ kind: "user" }] : [])],
    } as Awaited<ReturnType<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["roomDetail"]>>>),
    latestJob, forkPage, assertCanInvokeAgent: admit,
    policy: async () => ({ mode: options.mode ?? "plaintext_only" } as Awaited<ReturnType<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["policy"]>>>),
    processor,
  });
  return { app, discover, run, latestJob, forkPage, admit, processor, found, thread, select, observedBodies };
}

describe("ordinary content access exact recovery HTTP boundary", () => {
  test("discovery projects content-free coordinate and resolves exact canonical Room thread", async () => {
    const f = harness();
    const response = await f.app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json<unknown>()).toEqual({ recoveries: [body], nextCursor: null });
    expect(f.latestJob.mock.calls[0]).toEqual([roomId, f.thread]);
    expect(f.run).not.toHaveBeenCalled();
    expect(response.body).not.toContain("canonical-lane");
    expect(response.body).not.toContain(actor);
  });

  test("Fastify keeps GET bodyless while POST parses the shared coordinate body", async () => {
    const f = harness();
    const getResponse = await f.app.inject({
      method: "GET",
      url: `${url}?cursor=opaque-cursor`,
      payload: { ignored: "synthetic plaintext must not reach the handler" },
    });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json<unknown>()).toEqual({ recoveries: [], nextCursor: null });
    expect(f.observedBodies[0]).toBeUndefined();
    expect(f.forkPage.mock.calls[0]?.[3]).toBe("opaque-cursor");

    const postResponse = await f.app.inject({ method: "POST", url, payload: body });
    expect(postResponse.statusCode).toBe(200);
    expect(postResponse.json<unknown>()).toEqual({ outcome: "completed" });
    expect(f.observedBodies[1]).toEqual(body);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  test("multi-Human Room uses existing per-Agent locator, never requested graph thread", async () => {
    const f = harness({ multiHuman: true });
    expect((await f.app.inject({ method: "GET", url: `${url}?graphThreadId=other` })).statusCode).toBe(400);
    const response = await f.app.inject({ method: "GET", url });
    expect(response.json<unknown>()).toEqual({ recoveries: [body], nextCursor: null });
    expect(f.latestJob.mock.calls[0]).toEqual([roomId, botThreadId(roomId, agentId)]);
    expect((await f.app.inject({ method: "POST", url, payload: { ...body, graphThreadId: "other" } })).statusCode).toBe(400);
    expect(f.run).not.toHaveBeenCalled();
  });

  test("fork metadata supplies exact checkpoint and parent transcript; empty recovery pages keep continuation", async () => {
    const f = harness();
    f.latestJob.mockResolvedValue(null);
    f.forkPage.mockResolvedValue({ jobs: [{ id: jobId, requestorId: human, laneKey: "canonical-lane",
      input: { graphThreadId: f.thread, roomId, agentId, forkRun: { mode: "fork", parentThreadId: f.thread,
        transcriptThreadId: f.thread, checkpointThreadId: "fork-exact", forkThreadId: "fork-exact" } } }], nextCursor: "opaque-next" });
    f.discover.mockImplementation(async (scope) => ({ ...scope, checkpointId: "checkpoint", turnId: "turn", toolCallId: "call" }));
    expect((await f.app.inject({ method: "GET", url })).json<unknown>()).toEqual({ recoveries: [body], nextCursor: "opaque-next" });
    expect(f.discover.mock.calls[0]?.[0]).toMatchObject({ graphThreadId: "fork-exact",
      executionOwner: { kind: "fork", parentThreadId: f.thread, transcriptThreadId: f.thread } });
    expect((await f.app.inject({ method: "POST", url, payload: body })).json<unknown>()).toEqual({ outcome: "completed" });
    expect(f.processor.mock.calls[0]?.[0].threadId).toBe(f.thread);
    f.discover.mockResolvedValue(null);
    expect((await f.app.inject({ method: "GET", url: `${url}?cursor=opaque-next` })).json<unknown>()).toEqual({ recoveries: [], nextCursor: "opaque-next" });
    expect(f.forkPage.mock.calls.at(-1)?.[3]).toBe("opaque-next");
  });

  test("POST exact identity uses existing processor and truthful completed/busy/unavailable outcomes", async () => {
    const f = harness();
    for (const outcome of ["completed", "busy", "unavailable"] as const) {
      f.run.mockResolvedValueOnce(outcome);
      const response = await f.app.inject({ method: "POST", url, payload: body });
      expect(response.statusCode).toBe(200);
      expect(response.json<unknown>()).toEqual({ outcome });
    }
    expect(f.run.mock.calls[0]?.[0]).toEqual(f.found);
    expect(f.processor.mock.calls[0]?.[0]).toMatchObject({ threadId: f.thread, ownerId: human,
      humanTurnId: "turn", causalHumanUserId: human, agentId, roomId });
    expect(f.admit.mock.calls[0]?.[0]).toEqual({ humanUserId: human, roomId, agentId, origin: "foreground_resume" });
  });

  test("mismatched checkpoint, turn, call, Job and Agent never run", async () => {
    const f = harness();
    for (const field of ["checkpointId", "turnId", "toolCallId", "originalJobId", "agentId"] as const) {
      const value = field === "originalJobId" || field === "agentId" ? actor : "other";
      const response = await f.app.inject({ method: "POST", url, payload: { ...body, [field]: value } });
      expect(response.json<unknown>()).toEqual({ outcome: "unavailable" });
    }
    expect(f.run).not.toHaveBeenCalled();
  });

  test("current principal/membership/policy and latest Job owner fail closed", async () => {
    expect((await harness({ authenticated: false }).app.inject({ method: "GET", url })).statusCode).toBe(401);
    expect((await harness({ member: false }).app.inject({ method: "GET", url })).statusCode).toBe(404);
    for (const options of [{ mode: "encrypted_only" as const }, { staleJob: true }]) {
      const f = harness(options);
      expect((await f.app.inject({ method: "GET", url })).json<unknown>()).toEqual({ recoveries: [], nextCursor: null });
      expect((await f.app.inject({ method: "POST", url, payload: body })).json<unknown>()).toEqual({ outcome: "unavailable" });
      expect(f.run).not.toHaveBeenCalled();
    }
  });

  test("unknown outcome retains exact retry; infrastructure errors never expose private details", async () => {
    const f = harness();
    f.run.mockRejectedValueOnce(new OrdinaryContentAccessRetryRequiredError());
    expect((await f.app.inject({ method: "POST", url, payload: body })).json<unknown>()).toEqual({ outcome: "retry_required" });
    f.run.mockRejectedValueOnce(new Error("private token and content"));
    const response = await f.app.inject({ method: "POST", url, payload: body });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private token");
  });

  test("canonical mode drift stops resumed graph instead of protected plaintext fallback", async () => {
    const f = harness();
    f.select.mockReturnValue({ mode: "unchanged" });
    f.run.mockImplementationOnce(async (_coordinate, graphDeps) => {
      await graphDeps.ordinaryContentAccessForState({} as Parameters<typeof graphDeps.ordinaryContentAccessForState>[0]);
      return "completed";
    });
    expect((await f.app.inject({ method: "POST", url, payload: body })).json<unknown>()).toEqual({ outcome: "unavailable" });
  });
});
