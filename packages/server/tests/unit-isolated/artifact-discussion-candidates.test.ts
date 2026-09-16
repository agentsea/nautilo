/**
 * D442 Phase 4.1 — server-side contract spike for artifact discussion-room
 * candidates.
 *
 * Two layers:
 *   1. `listDiscussionRoomsForArtifact` (db query) — pure shape test against
 *      a Drizzle-call stub. Integration coverage of the actual SQL lives in
 *      the workspace-artifacts integration suite (same convention as
 *      `get-namespaces-for-artifact-ids.test.ts`).
 *   2. `GET /api/workspace/artifacts/:id/discussion-rooms` (route) — hermetic
 *      Fastify inject with `@nautilo/db.findArtifactByInternalIdForNamespaces`
 *      mocked (404 gate) and `listDiscussionRoomsForArtifact` injected via the
 *      route service seam. Pins auth gates, arg wiring (readable namespaces +
 *      viewer actor), response shape, and stale/non-member denial pass-through.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  listDiscussionRoomsForArtifact,
  type ArtifactDiscussionRoomCandidate,
  type Database,
  type ListDiscussionRoomsForArtifactInput,
} from "@nautilo/db";
import * as actualDb from "@nautilo/db";

// ─── Route-level mocks ──────────────────────────────────────────────────
// `actualDb` is captured BEFORE `mock.module` registers, so it is the real
// module; the spread keeps every other export intact and only overrides the
// 404-gate lookup. Pattern lifted from `artifact-refs.test.ts`.

const findCalls: Array<{ internalId: string; readableNamespaceIds: string[] }> = [];
const findArtifactByInternalIdForNamespacesMock = mock(
  async ({
    internalId,
    readableNamespaceIds,
  }: {
    internalId: string;
    readableNamespaceIds: string[];
  }) => {
    findCalls.push({ internalId, readableNamespaceIds });
    if (internalId === "art-1" && readableNamespaceIds.includes("ns-readable")) {
      return {
        id: "art-1",
        artifactId: "ext-1",
        path: "notes/q3.md",
        mimeType: "text/markdown",
        size: 128,
        storageUri: "file:///artifacts/ext-1",
        revision: 1,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        deletedAt: null,
      };
    }
    return null;
  },
);

mock.module("@nautilo/db", () => ({
  ...actualDb,
  findArtifactByInternalIdForNamespaces: findArtifactByInternalIdForNamespacesMock,
}));

const { workspaceArtifactsRoutes } = await import("../../src/routes/workspace-artifacts");

const apps: FastifyInstance[] = [];

type Env = Record<string, unknown> | null;

function makeApp(env: Env, listFn: typeof listDiscussionRoomsForArtifact): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.addHook("preHandler", (request, _reply, done) => {
    (request as { memoryEnvelope: unknown }).memoryEnvelope = env;
    done();
  });
  workspaceArtifactsRoutes(app, { listDiscussionRoomsForArtifact: listFn });
  apps.push(app);
  return app;
}

type DiscussionRoomsArgs = ListDiscussionRoomsForArtifactInput;
type DiscussionRoomsResult = ArtifactDiscussionRoomCandidate[];

function discussionRoomsMock(rooms: DiscussionRoomsResult) {
  return mock(async (_params: DiscussionRoomsArgs) => rooms);
}

function nsEnv(over: Partial<Record<string, unknown>> = {}): Env {
  return {
    memoryMode: "namespace",
    ownerId: "owner-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-current",
    readableNamespaces: ["ns-readable"],
    mutableNamespaces: ["ns-readable"],
    writableNamespaces: ["ns-readable"],
    toolPolicy: {},
    ...over,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  findArtifactByInternalIdForNamespacesMock.mockClear();
  findCalls.length = 0;
});

// ─── Route contract ────────────────────────────────────────────────────

describe("GET /api/workspace/artifacts/:id/discussion-rooms", () => {
  test("401 when no memory envelope", async () => {
    const app = makeApp(null, discussionRoomsMock([]));
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-1/discussion-rooms" });
    expect(res.statusCode).toBe(401);
  });

  test("501 for scope memory envelope", async () => {
    const app = makeApp(
      { memoryMode: "scope", ownerId: "owner-1", actorId: "actor-1", agentId: "agent-1", roomId: "r", scopeId: "s", toolPolicy: {} },
      discussionRoomsMock([]),
    );
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-1/discussion-rooms" });
    expect(res.statusCode).toBe(501);
  });

  test("403 when envelope has no agentId", async () => {
    const app = makeApp(nsEnv({ agentId: "" }), discussionRoomsMock([]));
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-1/discussion-rooms" });
    expect(res.statusCode).toBe(403);
  });

  test("404 when artifact is not readable for the viewer", async () => {
    const listFn = discussionRoomsMock([{ id: "should-not-reach", label: "x", kind: "private" }]);
    const app = makeApp(nsEnv(), listFn);
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-other/discussion-rooms" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
    // The candidate query must NOT run when the artifact is not readable.
    expect(listFn.mock.calls.length).toBe(0);
  });

  test("happy path: returns rooms and wires readable namespaces + viewer actor", async () => {
    const listFn = discussionRoomsMock([{ id: "room-a", label: "Room A", kind: "private" }]);
    const app = makeApp(nsEnv(), listFn);
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-1/discussion-rooms" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ rooms: [{ id: "room-a", label: "Room A", kind: "private" }] });
    expect(findCalls[0]).toEqual({ internalId: "art-1", readableNamespaceIds: ["ns-readable"] });
    expect(listFn.mock.calls[0]?.[0]).toEqual({
      artifactInternalId: "art-1",
      readableNamespaceIds: ["ns-readable"],
      viewerActorId: "actor-1",
    });
  });

  test("authorization: query receives the envelope-readable set, not raw attached namespaces", async () => {
    const listFn = discussionRoomsMock([]);
    const app = makeApp(nsEnv({ readableNamespaces: ["ns-readable", "ns-broad"] }), listFn);
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-1/discussion-rooms" });
    expect(res.statusCode).toBe(200);
    // The route forwards exactly the envelope-readable namespace set; the DB
    // query (not the route) is what filters attached-vs-readable. This pins
    // that the route never passes unfiltered attached namespaces downstream.
    expect(listFn.mock.calls[0]?.[0]?.readableNamespaceIds).toEqual(["ns-readable", "ns-broad"]);
    expect(listFn.mock.calls[0]?.[0]?.readableNamespaceIds).not.toContain("ns-unreadable");
  });

  test("dedupe: route surfaces the query's already-deduped room list verbatim", async () => {
    const listFn = discussionRoomsMock([
      { id: "room-a", label: "Room A", kind: "private" },
      { id: "room-b", label: "Room B", kind: "group" },
    ]);
    const app = makeApp(nsEnv(), listFn);
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-1/discussion-rooms" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rooms: Array<{ id: string }> };
    expect(body.rooms.map((r) => r.id)).toEqual(["room-a", "room-b"]);
    // No duplicate room ids in the response.
    expect(new Set(body.rooms.map((r) => r.id)).size).toBe(body.rooms.length);
  });

  test("stale / non-member denial: query returns [] → route returns empty rooms", async () => {
    // Simulates the membership filter inside the DB query excluding every
    // candidate (viewer was removed from the backing rooms since the
    // envelope was minted, or the readable namespace has no room the viewer
    // is currently a member of).
    const listFn = discussionRoomsMock([]);
    const app = makeApp(nsEnv(), listFn);
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts/art-1/discussion-rooms" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ rooms: [] });
    expect(listFn.mock.calls[0]?.[0]?.viewerActorId).toBe("actor-1");
  });
});

// ─── DB query shape (stub conn) ──────────────────────────────────────────
// Pure shape test: the query builds a `selectDistinct().from().innerJoin()
// .innerJoin().where().orderBy()` chain and maps rows into `{ id, label,
// kind }`. SQL predicate coverage lives in the integration suite (same
// convention as `get-namespaces-for-artifact-ids.test.ts`).

interface StubRows {
  rows: Array<{ id: string; label: string; kind: string }>;
  captured: { calls: string[]; selectedFields?: string[] };
}

function buildStubConn(rows: Array<{ id: string; label: string; kind: string }>): {
  conn: Database;
  captured: StubRows["captured"];
} {
  const captured: StubRows["captured"] = { calls: [] };
  const terminal = Promise.resolve(rows);
  const chain: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["from", "innerJoin", "where"]) {
    chain[m] = (..._args: unknown[]) => {
      captured.calls.push(m);
      return chain;
    };
  }
  chain["orderBy"] = (..._args: unknown[]) => {
    captured.calls.push("orderBy");
    return terminal;
  };
  chain["limit"] = (..._args: unknown[]) => {
    captured.calls.push("limit");
    return terminal;
  };
  const conn = {
    selectDistinct(fields: unknown) {
      captured.calls.push("selectDistinct");
      captured.selectedFields =
        fields && typeof fields === "object" ? Object.keys(fields as Record<string, unknown>) : [];
      return chain;
    },
  } as unknown as Database;
  return { conn, captured };
}

describe("listDiscussionRoomsForArtifact (db query shape)", () => {
  test("empty readable namespaces → [] and no DB call", async () => {
    const { conn, captured } = buildStubConn([]);
    const out = await listDiscussionRoomsForArtifact(
      { artifactInternalId: "a1", readableNamespaceIds: [], viewerActorId: "act-1" },
      conn,
    );
    expect(out).toEqual([]);
    expect(captured.calls.length).toBe(0);
  });

  test("empty viewerActorId → [] and no DB call", async () => {
    const { conn, captured } = buildStubConn([]);
    const out = await listDiscussionRoomsForArtifact(
      { artifactInternalId: "a1", readableNamespaceIds: ["ns-1"], viewerActorId: "" },
      conn,
    );
    expect(out).toEqual([]);
    expect(captured.calls.length).toBe(0);
  });

  test("maps rows into { id, label, kind } and issues one round-trip", async () => {
    const { conn, captured } = buildStubConn([
      { id: "room-a", label: "Room A", kind: "private" },
      { id: "room-b", label: "Room B", kind: "group" },
    ]);
    const out = await listDiscussionRoomsForArtifact(
      { artifactInternalId: "a1", readableNamespaceIds: ["ns-1", "ns-2"], viewerActorId: "act-1" },
      conn,
    );
    expect(out).toEqual([
      { id: "room-a", label: "Room A", kind: "private" },
      { id: "room-b", label: "Room B", kind: "group" },
    ]);
    // The query fuses the three gates into a single SELECT: one
    // selectDistinct, one from, three innerJoins (including the Artifact row
    // needed to exclude protected mappings), one where, one orderBy.
    expect(captured.calls.filter((c) => c === "selectDistinct").length).toBe(1);
    expect(captured.calls.filter((c) => c === "from").length).toBe(1);
    expect(captured.calls.filter((c) => c === "innerJoin").length).toBe(3);
    expect(captured.calls.filter((c) => c === "where").length).toBe(1);
    expect(captured.calls.filter((c) => c === "orderBy").length).toBe(1);
    // PostgreSQL rejects SELECT DISTINCT ... ORDER BY rooms.created_at unless
    // the sort expression is projected. The query maps this private key back
    // out before returning the public room candidate.
    expect(captured.selectedFields).toEqual(["id", "label", "kind", "createdAt"]);
  });
});
