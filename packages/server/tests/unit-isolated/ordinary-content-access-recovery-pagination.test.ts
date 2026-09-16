import { afterEach, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { botThreadId } from "@nautilo/runtime";
import type { DirectDatabase } from "@nautilo/db";
import type { OrdinaryContentAccessRecoveryRouteDeps } from "../../src/routes/ordinary-content-access-recovery";

const room = "10000000-0000-4000-8000-000000000001";
const user = "10000000-0000-4000-8000-000000000002";
const actor = "10000000-0000-4000-8000-000000000003";
const agent = "10000000-0000-4000-8000-000000000004";
const peerAgent = "10000000-0000-4000-8000-000000000005";
let rows: { id: string; requestorId: string; laneKey: string; input: Record<string, unknown> }[] = [];
let queries = 0;
const limits: number[] = [];
const database = { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async (limit: number) => {
  queries++; limits.push(limit); return rows.slice(0, limit);
} }) }) }) }) } as unknown as DirectDatabase;
mock.module("../../src/lib/server-direct-db", () => ({ getServerDirectDb: () => database }));
mock.module("../../src/content-access/preview-key", () => ({ resolveContentAccessPreviewKey: () => Buffer.alloc(32, 7) }));
const { ordinaryContentAccessRecoveryRoutes } = await import("../../src/routes/ordinary-content-access-recovery");
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); rows = []; queries = 0; limits.length = 0; });
function appFor(userId = user, roomId = room, reverse = false) {
  const app = Fastify(); apps.push(app);
  app.addHook("preHandler", async (request) => { request.sessionUserId = userId; request.sessionActorId = actor; });
  ordinaryContentAccessRecoveryRoutes(app, {
    ordinaryContentAccessForState: () => ({ mode: "plaintext_only" }),
    latestJob: async () => null,
    roomDetail: async () => ({ id: roomId, graphThreadId: "parent", kind: "group",
      members: [{ kind: "user" }, ...((reverse ? [peerAgent, agent] : [agent, peerAgent]).map((agentId) => ({ kind: "agent", agentId })))],
    } as Awaited<ReturnType<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["roomDetail"]>>>),
    policy: async () => ({ mode: "plaintext_only" } as Awaited<ReturnType<NonNullable<OrdinaryContentAccessRecoveryRouteDeps["policy"]>>>),
    assertCanInvokeAgent: async () => {},
    manager: { discoverOrdinaryContentAccessRecovery: async () => null, runOrdinaryContentAccessRecovery: async () => "completed" },
  });
  return app;
}
function seed() {
  const parent = botThreadId(room, agent);
  rows = Array.from({ length: 51 }, (_, i) => ({ id: `20000000-0000-4000-8000-${String(999 - i).padStart(12, "0")}`,
    requestorId: user, laneKey: parent, input: { roomId: room, agentId: agent, graphThreadId: parent,
      forkRun: { mode: "fork", parentThreadId: parent, transcriptThreadId: parent, checkpointThreadId: `fork-${i}`, forkThreadId: `fork-${i}` } } }));
}
async function firstCursor() {
  seed();
  const response = await appFor().inject({ method: "GET", url: `/api/rooms/${room}/content-access-recovery` });
  expect(response.statusCode).toBe(200);
  const page = response.json<{ recoveries: unknown[]; nextCursor: string }>();
  expect(page.recoveries).toEqual([]); expect(page.nextCursor).toBeString();
  return page.nextCursor;
}
test("50-candidate lossless page, deleted anchor and reordered roster retain continuation", async () => {
  const cursor = await firstCursor();
  expect(limits).toEqual([51]); expect(queries).toBe(1);
  rows = []; // Includes deletion of the anchor: no lookup/retention requirement.
  const response = await appFor(user, room, true).inject({ method: "GET", url: `/api/rooms/${room}/content-access-recovery?cursor=${encodeURIComponent(cursor)}` });
  expect(response.statusCode).toBe(200);
  expect(response.json<unknown>()).toEqual({ recoveries: [], nextCursor: null });
  expect(queries).toBe(2); // Exactly one page read, no anchor query.
});
test("tampered and cross-Human/Room positions fail closed before page reads", async () => {
  const cursor = await firstCursor();
  const other = "10000000-0000-4000-8000-000000000099";
  for (const [humanId, roomId, token] of [[user, room, `${cursor.slice(0, -3)}zzz`], [other, room, cursor], [user, other, cursor]]) {
    const response = await appFor(humanId, roomId).inject({ method: "GET", url: `/api/rooms/${roomId}/content-access-recovery?cursor=${encodeURIComponent(token!)}` });
    expect(response.statusCode).toBe(400);
    expect(response.json<unknown>()).toEqual({ error: "recovery_cursor_invalid", restartDiscovery: true });
  }
  expect(queries).toBe(1);
});
