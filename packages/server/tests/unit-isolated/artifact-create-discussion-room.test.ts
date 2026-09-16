/**
 * D442 Phase 4.2 — server-side contract spike for "Start a new
 * conversation" from an artifact (`POST /api/workspace/artifacts/:id/
 * discussion-rooms`).
 *
 * Hermetic Fastify inject: `@nautilo/db.findArtifactByInternalIdForNamespaces`
 * is mocked (404 gate), and `createDiscussionRoomForArtifact`,
 * `findPersonalAgentsForUser`, and `findAgentActorForAgent` are injected
 * via the route service seam so the contract can be exercised without a
 * DB. Pins: auth gates, readable-artifact gate (404 indistinguishable),
 * server-side personal-agent resolution (no client-supplied agent),
 * arg wiring to the atomic helper, response shape `{ id, label, kind }`,
 * and label defaulting/truncation.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  createDiscussionRoomForArtifact,
  type CreateDiscussionRoomForArtifactInput,
  type Database,
} from "@nautilo/db";
import * as actualDb from "@nautilo/db";
import { setWorkspaceArtifactListNamespaceResolverForTests } from "../../src/lib/workspace-artifact-list-generation";

// ─── Route-level mocks ──────────────────────────────────────────────────
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

// Successful room creation emits workspace.artifact.changed. The production
// invalidation subscriber resolves the artifact's namespaces asynchronously;
// keep that fire-and-forget path hermetic too, rather than racing a real DB
// connection after the route response. This file owns its Bun process, so the
// process-scoped resolver cannot leak into another test file.
setWorkspaceArtifactListNamespaceResolverForTests(async (internalIds) =>
  new Map(internalIds.map((id) => [id, ["ns-readable"]])),
);

const { workspaceArtifactsRoutes } = await import("../../src/routes/workspace-artifacts");

const apps: FastifyInstance[] = [];

type Env = Record<string, unknown> | null;

interface SeamDeps {
  createFn: typeof createDiscussionRoomForArtifact;
  personalAgents: Array<{ agentId: string; handle: string; displayName: string }>;
  agentActor: { id: string; displayName: string; agentId: string } | null;
}

function makeApp(env: Env, deps: SeamDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.addHook("preHandler", (request, _reply, done) => {
    (request as { memoryEnvelope: unknown }).memoryEnvelope = env;
    done();
  });
  workspaceArtifactsRoutes(app, {
    createDiscussionRoomForArtifact: deps.createFn,
    findPersonalAgentsForUser: mock(async () => deps.personalAgents),
    findAgentActorForAgent: mock(async () => deps.agentActor),
    // This route contract is otherwise fully hermetic. Capability denial and
    // typed 403 behavior are covered by workspace-artifacts-routes.test.ts;
    // keep these D442 cases focused on discussion-room semantics.
    assertCanWriteArtifacts: mock(async () => {}),
  });
  apps.push(app);
  return app;
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

const createdRoom = { id: "room-new", label: "q3.md", kind: "private" };

function defaultDeps(over: Partial<SeamDeps> = {}): SeamDeps {
  return {
    createFn: mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom),
    personalAgents: [{ agentId: "agent-personal", handle: "genie", displayName: "Genie" }],
    agentActor: { id: "agent-actor-1", displayName: "Genie", agentId: "agent-personal" },
    ...over,
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  findArtifactByInternalIdForNamespacesMock.mockClear();
  findCalls.length = 0;
});

describe("POST /api/workspace/artifacts/:id/discussion-rooms", () => {
  test("401 when no memory envelope", async () => {
    const app = makeApp(null, defaultDeps());
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
    });
    expect(res.statusCode).toBe(401);
  });

  test("501 for scope memory envelope", async () => {
    const app = makeApp(
      {
        memoryMode: "scope",
        ownerId: "owner-1",
        actorId: "actor-1",
        agentId: "agent-1",
        roomId: "r",
        scopeId: "s",
        toolPolicy: {},
      },
      defaultDeps(),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
    });
    expect(res.statusCode).toBe(501);
  });

  test("403 when envelope has no agentId", async () => {
    const app = makeApp(nsEnv({ agentId: "" }), defaultDeps());
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
    });
    expect(res.statusCode).toBe(403);
  });

  test("404 when artifact is not readable for the viewer (no create)", async () => {
    const createFn = mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom);
    const app = makeApp(nsEnv(), defaultDeps({ createFn }));
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-other/discussion-rooms",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
    expect(createFn.mock.calls.length).toBe(0);
  });

  test("400 no_default_agent when caller has no personal agent", async () => {
    const createFn = mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom);
    const app = makeApp(
      nsEnv(),
      defaultDeps({ createFn, personalAgents: [] }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "no_default_agent", code: "no_default_agent" });
    expect(createFn.mock.calls.length).toBe(0);
  });

  test("500 agent_resolution_failed when agent actor lookup misses", async () => {
    const createFn = mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom);
    const app = makeApp(
      nsEnv(),
      defaultDeps({ createFn, agentActor: null }),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: "agent_resolution_failed",
      code: "agent_resolution_failed",
    });
    expect(createFn.mock.calls.length).toBe(0);
  });

  test("happy path: 201, returns { id, label, kind }, wires args server-side", async () => {
    const createFn = mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom);
    const app = makeApp(nsEnv(), defaultDeps({ createFn }));
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
      payload: { label: "Project Q3" },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual(createdRoom);
    expect(findCalls[0]).toEqual({ internalId: "art-1", readableNamespaceIds: ["ns-readable"] });
    expect(createFn.mock.calls[0]?.[0]).toEqual({
      ownerUserId: "owner-1",
      ownerActorId: "actor-1",
      agentActorId: "agent-actor-1",
      label: "Project Q3",
      artifactInternalId: "art-1",
    });
  });

  test("label defaults to artifact path basename when body omits label", async () => {
    const createFn = mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom);
    const app = makeApp(nsEnv(), defaultDeps({ createFn }));
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
    });
    expect(res.statusCode).toBe(201);
    expect(createFn.mock.calls[0]?.[0]?.label).toBe("q3.md");
  });

  test("label truncates to 80 chars", async () => {
    const createFn = mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom);
    const app = makeApp(nsEnv(), defaultDeps({ createFn }));
    const longLabel = "x".repeat(120);
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
      payload: { label: longLabel },
    });
    expect(res.statusCode).toBe(201);
    expect(createFn.mock.calls[0]?.[0]?.label.length).toBe(80);
  });

  test("client-supplied agent is ignored — agent resolved from caller's session", async () => {
    const createFn = mock(async (_input: CreateDiscussionRoomForArtifactInput) => createdRoom);
    const app = makeApp(nsEnv(), defaultDeps({ createFn }));
    // A malicious client tries to inject an agentId into the body; the
    // route must ignore it and resolve the personal agent server-side.
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
      payload: { label: "L", agentId: "attacker-agent", agentActorId: "attacker-actor" },
    });
    expect(res.statusCode).toBe(201);
    expect(createFn.mock.calls[0]?.[0]?.agentActorId).toBe("agent-actor-1");
  });

  test("helper throw → 500, no client-facing namespace leak", async () => {
    const createFn = mock(async () => {
      throw new Error("namespace insert failed");
    });
    const app = makeApp(nsEnv(), defaultDeps({ createFn }));
    const res = await app.inject({
      method: "POST",
      url: "/api/workspace/artifacts/art-1/discussion-rooms",
    });
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body).toEqual({ error: "Failed to create discussion room" });
    // No namespace id leaks in the error body.
    expect(JSON.stringify(body)).not.toContain("namespace");
  });
});

// ─── DB helper shape + transaction behavior (stub conn) ────────────────
// Pure unit test: `createDiscussionRoomForArtifact` runs every step
// inside ONE `conn.transaction(fn)` call and propagates any step
// failure, so the single-tx atomicity contract holds. Real ROLLBACK
// verification against Postgres lives in the integration suite (same
// convention as the `listDiscussionRoomsForArtifact` shape test).

interface TxRecorder {
  steps: string[];
  failOn: string | null;
}

function buildStubConn(opts: { failOn?: string | null } = {}): {
  conn: Database;
  rec: TxRecorder;
} {
  const rec: TxRecorder = { steps: [], failOn: opts.failOn ?? null };
  const maybeFail = (label: string): Promise<unknown> => {
    rec.steps.push(label);
    if (rec.failOn === label) return Promise.reject(new Error(`fail:${label}`));
    return Promise.resolve(undefined);
  };
  // The helper issues exactly four `tx.insert(...)` calls in a fixed
  // order: namespaces → rooms → roomMembers → artifactNamespaces. The
  // stub distinguishes them by call index (the table object identity is
  // not available without the real schema). Each returns the chain
  // shape the helper actually drives.
  let insertCount = 0;
  const tx = {
    insert(_table: unknown) {
      const idx = insertCount++;
      if (idx === 0) {
        // namespaces: .values(...).returning(...) → promise of [{ id }]
        return {
          values: () => ({
            returning: () => {
              rec.steps.push("namespace");
              if (rec.failOn === "namespace") {
                return Promise.reject(new Error("fail:namespace"));
              }
              return Promise.resolve([{ id: "ns-new" }]);
            },
          }),
        };
      }
      if (idx === 1) {
        // rooms: .values(...) → promise
        return { values: () => maybeFail("room") };
      }
      if (idx === 2) {
        // roomMembers: .values(...) → promise
        return { values: () => maybeFail("members") };
      }
      // artifactNamespaces: .values(...).onConflictDoNothing() → promise
      return {
        values: () => ({
          onConflictDoNothing: () => maybeFail("artifact_namespaces:onConflict"),
        }),
      };
    },
  } as unknown as Database;
  const conn = {
    transaction: async <T>(fn: (txdb: Database) => Promise<T>): Promise<T> => {
      return await fn(tx);
    },
  } as unknown as Database;
  return { conn, rec };
}

describe("createDiscussionRoomForArtifact (db helper, stub conn)", () => {
  test("happy path: runs namespace→room→members→artifact_namespaces in one tx", async () => {
    const { conn, rec } = buildStubConn();
    const out = await createDiscussionRoomForArtifact(
      {
        ownerUserId: "owner-1",
        ownerActorId: "actor-1",
        agentActorId: "agent-actor-1",
        label: "q3.md",
        artifactInternalId: "art-1",
      },
      conn,
    );
    expect(typeof out.id).toBe("string");
    expect(out.label).toBe("q3.md");
    expect(out.kind).toBe("private");
    expect(rec.steps).toEqual(["namespace", "room", "members", "artifact_namespaces:onConflict"]);
  });

  test("failure on the artifact attach step propagates (tx would roll back)", async () => {
    const { conn, rec } = buildStubConn({ failOn: "artifact_namespaces:onConflict" });
    let caught: unknown;
    try {
      await createDiscussionRoomForArtifact(
        {
          ownerUserId: "owner-1",
          ownerActorId: "actor-1",
          agentActorId: "agent-actor-1",
          label: "q3.md",
          artifactInternalId: "art-1",
        },
        conn,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // The earlier steps ran inside the SAME transaction; in a real DB the
    // thrown error aborts the tx and rolls back the namespace/room/members
    // inserts. The stub proves the steps share one tx and the error
    // propagates rather than leaving a partial commit.
    expect(rec.steps).toContain("namespace");
    expect(rec.steps).toContain("room");
    expect(rec.steps).toContain("members");
  });

  test("failure on the namespace step propagates before any later step", async () => {
    const { conn, rec } = buildStubConn({ failOn: "namespace" });
    let caught: unknown;
    try {
      await createDiscussionRoomForArtifact(
        {
          ownerUserId: "owner-1",
          ownerActorId: "actor-1",
          agentActorId: "agent-actor-1",
          label: "q3.md",
          artifactInternalId: "art-1",
        },
        conn,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(rec.steps).toEqual(["namespace"]);
    // No room/members/attach steps ran.
    expect(rec.steps).not.toContain("room");
  });
});
