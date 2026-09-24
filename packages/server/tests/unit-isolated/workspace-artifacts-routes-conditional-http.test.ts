import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { unzipSync } from "fflate";
import type { OutgoingHttpHeaders } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { Artifact, ArtifactListKeyset } from "@nautilo/db";
import { ArtifactWriteDeniedError, type NamespaceMemoryEnvelope } from "@nautilo/trust";
import type { ServerEvent } from "@nautilo/types";
import {
  PRIVATE_NO_STORE_CACHE_CONTROL,
  VARY_AUTHORIZATION,
} from "../../src/http/conditional-http";
import {
  bumpWorkspaceArtifactListGenerationForNamespaces,
  clearWorkspaceArtifactListGenerationForTests,
} from "../../src/lib/workspace-artifact-list-generation";
import type { WorkspaceArtifactsRouteService } from "../../src/routes/workspace-artifacts";

const listArtifactsForNamespaces = mock(async () => [
  {
    id: "row-1",
    artifactId: "artifact-1",
    path: "notes/a.md",
    mimeType: "text/markdown",
    size: 12,
    revision: 1,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
]);
const PAGED_ROW_ID = "10000000-0000-4000-8000-000000000001";
const listArtifactPageForNamespaces = mock(async (): Promise<{
  artifacts: Artifact[];
  next: ArtifactListKeyset | null;
}> => ({
  artifacts: [{
    id: PAGED_ROW_ID,
    artifactId: "artifact-paged",
    path: "notes/paged.md",
    mimeType: "text/markdown",
    size: 24,
    storageUri: "file:///fixture/paged.md",
    revision: 2,
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  }],
  next: null,
}));

const getNamespacesForArtifactIds = mock(async () => new Map([["row-1", ["ns-a"]]]));
const findArtifactByInternalIdForNamespaces = mock(async () => null as {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string;
  size: number;
  storageUri: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
} | null);
const getArtifactNamespaces = mock(async () => [] as string[]);
let persistedState: {
  namespaceId: string;
  agentId: string;
  artifactId: string;
  key: string;
  value: unknown;
  updatedAt: Date;
} | null = null;
const getArtifactStateForNamespaces = mock(async () => persistedState);
const setArtifactState = mock(async (params: Omit<NonNullable<typeof persistedState>, "updatedAt">) => {
  persistedState = { ...params, updatedAt: new Date("2026-01-02T00:00:00.000Z") };
  return persistedState;
});
const serverEventHandlers = new Set<(event: ServerEvent) => void>();
const eventBusOn = mock((handler: (event: ServerEvent) => void) => {
  serverEventHandlers.add(handler);
});
const eventBusOff = mock((handler: (event: ServerEvent) => void) => {
  serverEventHandlers.delete(handler);
});
const eventBusEmit = mock((event: ServerEvent) => {
  for (const handler of serverEventHandlers) handler(event);
});
const insertArtifact = mock(async (input: {
  artifactId: string;
  path: string;
  storageUri: string;
  mimeType?: string;
  size: number;
}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  ...input,
  revision: 1,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  deletedAt: null,
}));
const attachArtifactToNamespace = mock(async () => {});

mock.module("@nautilo/db", () => ({
  listArtifactPageForNamespaces,
  listArtifactsForNamespaces,
  getNamespacesForArtifactIds,
  attachArtifactToNamespace,
  findArtifactByInternalIdForNamespaces,
  findArtifactByPathForNamespaces: mock(async () => null),
  getArtifactNamespaces,
  getArtifactStateForNamespaces,
  insertArtifact,
  markArtifactDeleted: mock(async () => null),
  setArtifactState,
  appendPendingArtifactEvent: mock(async () => ({})),
  findOpenPingTask: mock(async () => null),
  updateArtifactPath: mock(async () => null),
}));

mock.module("@nautilo/runtime", () => ({
  eventBus: { on: eventBusOn, off: eventBusOff, emit: eventBusEmit },
  createTask: mock(async () => {}),
  getTaskObserver: mock(() => null),
}));

mock.module("@nautilo/agent", () => ({
  envelopeFactsForArtifacts: mock(() => ({ ok: true })),
  userSaveWorkspaceArtifact: mock(async () => ({ ok: false, code: "error", message: "stub" })),
  applyWorkspaceArtifactTextPatch: mock(async () => ({
    ok: false,
    rejection: { kind: "unsupported", reason: "stub" },
  })),
}));

const apps: FastifyInstance[] = [];

type TestMemoryEnvelope = {
  readonly memoryMode: "namespace";
  readonly ownerId: string;
  readonly actorId: string;
  readonly agentId: string;
  readonly roomId: string;
  readonly readableNamespaces: readonly string[];
  readonly mutableNamespaces: readonly string[];
  readonly writableNamespaces: readonly string[];
  readonly toolPolicy: Record<string, unknown>;
};

const ENVELOPE_A: TestMemoryEnvelope = {
  memoryMode: "namespace",
  ownerId: "owner-1",
  actorId: "actor-1",
  agentId: "agent-1",
  roomId: "room-1",
  readableNamespaces: ["ns-a"],
  mutableNamespaces: ["ns-a"],
  writableNamespaces: ["ns-a"],
  toolPolicy: {},
};

const ENVELOPE_B: TestMemoryEnvelope = {
  ...ENVELOPE_A,
  actorId: "actor-2",
};

function encryptionPolicy(mode: "plaintext_only" | "shadow_encryption" | "encrypted_only") {
  return {
    mode,
    shadowBehavior: "fallback" as const,
    revision: 1,
    shadowEncryptionStartedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function installEnvelopePreHandler(
  app: FastifyInstance,
  envelope: TestMemoryEnvelope,
  sessionUserId = envelope.ownerId,
): void {
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", (request, _reply, done) => {
    request.memoryEnvelope = envelope as never;
    request.sessionUserId = sessionUserId;
    done();
  });
}

async function makeApp(
  envelope: TestMemoryEnvelope = ENVELOPE_A,
  assertCanWriteArtifacts: NonNullable<
    WorkspaceArtifactsRouteService["assertCanWriteArtifacts"]
  > = async () => {},
  overrides: WorkspaceArtifactsRouteService = {},
  sessionUserId = envelope.ownerId,
): Promise<FastifyInstance> {
  const { workspaceArtifactsRoutes } = await import("../../src/routes/workspace-artifacts");
  const app = Fastify({ logger: false });
  installEnvelopePreHandler(app, envelope, sessionUserId);
  await app.register(multipart);
  workspaceArtifactsRoutes(app, { assertCanWriteArtifacts, ...overrides });
  await app.ready();
  apps.push(app);
  return app;
}

function expectConditionalHeaders(res: { headers: OutgoingHttpHeaders }): void {
  expect(res.headers["etag"]).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
  expect(res.headers["vary"]).toBe(VARY_AUTHORIZATION);
  expect(res.headers["cache-control"]).toBe(PRIVATE_NO_STORE_CACHE_CONTROL);
}

beforeEach(() => {
  clearWorkspaceArtifactListGenerationForTests();
  listArtifactsForNamespaces.mockClear();
  listArtifactPageForNamespaces.mockClear();
  getNamespacesForArtifactIds.mockClear();
  findArtifactByInternalIdForNamespaces.mockClear();
  findArtifactByInternalIdForNamespaces.mockImplementation(async () => null);
  getArtifactNamespaces.mockClear();
  getArtifactNamespaces.mockImplementation(async () => []);
  getArtifactStateForNamespaces.mockClear();
  insertArtifact.mockClear();
  attachArtifactToNamespace.mockClear();
  attachArtifactToNamespace.mockImplementation(async () => {});
  setArtifactState.mockClear();
  persistedState = null;
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("GET /api/workspace/artifacts conditional HTTP (M213 Phase 8/11)", () => {
  test("returns conditional headers on 200 after auth", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts" });
    expect(res.statusCode).toBe(200);
    expectConditionalHeaders(res);
    const body = JSON.parse(res.body) as { artifacts: unknown[] };
    expect(body.artifacts).toHaveLength(1);
    expect(listArtifactsForNamespaces).toHaveBeenCalled();
    expect(listArtifactPageForNamespaces).not.toHaveBeenCalled();
    expect(Object.keys(body)).toEqual(["artifacts"]);
  });

  test("plaintext opt-in admits a Human-only Room envelope and hides unreadable attachments", async () => {
    getNamespacesForArtifactIds.mockImplementationOnce(async () => new Map([
      [PAGED_ROW_ID, ["ns-a", "ns-hidden"]],
    ]));
    const app = await makeApp(
      { ...ENVELOPE_A, agentId: "" },
      async () => {},
      {
        loadEncryptionPolicy: async () => encryptionPolicy("plaintext_only"),
        now: () => new Date("2026-02-01T00:00:00.000Z"),
      },
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/workspace/artifacts?pagination=keyset_v1&limit=50",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ artifacts: unknown[]; nextCursor: null }>()).toEqual({
      artifacts: [expect.objectContaining({
        id: PAGED_ROW_ID,
        namespaceIds: ["ns-a"],
      })],
      nextCursor: null,
    });
    expect(listArtifactPageForNamespaces).toHaveBeenCalledWith({
      readableNamespaceIds: ["ns-a"],
      limit: 50,
      snapshotAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(listArtifactsForNamespaces).not.toHaveBeenCalled();
  });

  test("legacy Human-only and encrypted opt-in behavior remain gated", async () => {
    const humanOnly = { ...ENVELOPE_A, agentId: "" };
    const legacy = await makeApp(humanOnly, async () => {}, {
      loadEncryptionPolicy: async () => encryptionPolicy("shadow_encryption"),
    });
    expect((await legacy.inject({ url: "/api/workspace/artifacts" })).statusCode).toBe(403);

    const encrypted = await makeApp(ENVELOPE_A, async () => {}, {
      loadEncryptionPolicy: async () => encryptionPolicy("shadow_encryption"),
    });
    const paged = await encrypted.inject({
      url: "/api/workspace/artifacts?pagination=keyset_v1",
    });
    expect(paged.statusCode).toBe(409);
    expect(paged.json()).toMatchObject({ code: "artifact_list_pagination_unavailable" });
    expect(listArtifactPageForNamespaces).not.toHaveBeenCalled();
    expect((await encrypted.inject({ url: "/api/workspace/artifacts" })).statusCode).toBe(200);
  });

  test("plaintext Human reads reject a session that does not own the Room envelope", async () => {
    const app = await makeApp(
      { ...ENVELOPE_A, agentId: "" },
      async () => {},
      { loadEncryptionPolicy: async () => encryptionPolicy("plaintext_only") },
      "different-user",
    );

    expect((await app.inject({ url: "/api/workspace/artifacts" })).statusCode).toBe(403);
    expect((await app.inject({
      url: "/api/workspace/artifacts?pagination=keyset_v1",
    })).statusCode).toBe(403);
    expect((await app.inject({
      url: "/api/workspace/artifacts/by-public-id/artifact-paged",
    })).statusCode).toBe(403);
    expect((await app.inject({
      url: `/api/workspace/artifacts/${PAGED_ROW_ID}`,
    })).statusCode).toBe(403);
    expect((await app.inject({
      url: `/api/workspace/artifacts/${PAGED_ROW_ID}/bytes`,
    })).statusCode).toBe(403);
    expect(listArtifactsForNamespaces).not.toHaveBeenCalled();
    expect(listArtifactPageForNamespaces).not.toHaveBeenCalled();
  });

  test("plaintext Human Room context can list and resolve exact Artifact identities", async () => {
    const humanOnly = { ...ENVELOPE_A, agentId: "" };
    const artifact = {
      id: PAGED_ROW_ID,
      artifactId: "artifact-paged",
      path: "notes/paged.md",
      mimeType: "text/markdown",
      size: 24,
      storageUri: `file://${join(tmpdir(), `missing-${randomUUID()}.md`)}`,
      revision: 2,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    };
    findArtifactByInternalIdForNamespaces.mockImplementation(async () => artifact);
    getArtifactNamespaces.mockImplementation(async () => ["ns-a", "ns-hidden"]);
    const app = await makeApp(humanOnly, async () => {}, {
      loadEncryptionPolicy: async () => encryptionPolicy("plaintext_only"),
      findArtifactByIdForNamespaces: async () => artifact,
    });

    const list = await app.inject({ url: "/api/workspace/artifacts" });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ artifacts: unknown[] }>().artifacts).toHaveLength(1);
    expect(listArtifactsForNamespaces).toHaveBeenCalledWith({
      readableNamespaceIds: ["ns-a"],
      limit: 500,
    });

    const publicDetail = await app.inject({
      url: "/api/workspace/artifacts/by-public-id/artifact-paged",
    });
    expect(publicDetail.statusCode).toBe(200);
    expect(publicDetail.json()).toMatchObject({
      id: PAGED_ROW_ID,
      artifactId: "artifact-paged",
      namespaceIds: ["ns-a"],
    });

    const detail = await app.inject({ url: `/api/workspace/artifacts/${PAGED_ROW_ID}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ id: PAGED_ROW_ID, artifactId: "artifact-paged" });

    const bytes = await app.inject({ url: `/api/workspace/artifacts/${PAGED_ROW_ID}/bytes` });
    expect(bytes.statusCode).toBe(404);
    expect(bytes.json<unknown>()).toEqual({
      error: "Artifact bytes are unavailable",
      code: "artifact_bytes_unavailable",
    });
  });

  test("plaintext Human SSE reauthorizes the same actor and Room before delivery", async () => {
    const humanOnly = { ...ENVELOPE_A, agentId: "" };
    const artifact = {
      id: PAGED_ROW_ID,
      artifactId: "artifact-paged",
      path: "notes/paged.md",
      mimeType: "text/markdown",
      size: 24,
      storageUri: "file:///fixture/paged.md",
      revision: 2,
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    };
    findArtifactByInternalIdForNamespaces.mockImplementation(async () => artifact);
    const buildCurrentEnvelope = mock(async (
      _actorId: string,
      _agentId: string | undefined,
      _roomId: string,
    ) => humanOnly as never);
    const app = await makeApp(humanOnly, async () => {}, {
      loadEncryptionPolicy: async () => encryptionPolicy("plaintext_only"),
      buildCurrentEnvelope,
    });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const controller = new AbortController();
    const pending = fetch(`${base}/api/workspace/artifacts/events`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    setTimeout(() => eventBusEmit({
      type: "workspace.artifact.changed",
      id: artifact.id,
      artifactId: artifact.artifactId,
      path: artifact.path,
      reloadRequired: true,
    }), 20);

    const response = await pending;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    const firstValue = first.value as unknown;
    expect(firstValue).toBeInstanceOf(Uint8Array);
    const second = await reader.read();
    const secondValue = second.value as unknown;
    expect(secondValue).toBeInstanceOf(Uint8Array);
    const decoder = new TextDecoder();
    const delivered = decoder.decode(
      firstValue instanceof Uint8Array ? firstValue : undefined,
    ) + decoder.decode(secondValue instanceof Uint8Array ? secondValue : undefined);
    expect(delivered).toContain(`"id":"${PAGED_ROW_ID}"`);
    expect(buildCurrentEnvelope).toHaveBeenCalledWith(
      ENVELOPE_A.actorId,
      undefined,
      ENVELOPE_A.roomId,
    );
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  test("continuation binds the snapshot and rejects invalidated scope", async () => {
    listArtifactPageForNamespaces.mockImplementationOnce(async () => ({
      artifacts: [],
      next: {
        createdAt: "2026-01-01T00:00:00.123456Z",
        id: PAGED_ROW_ID,
        snapshotAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    }));
    const app = await makeApp(ENVELOPE_A, async () => {}, {
      loadEncryptionPolicy: async () => encryptionPolicy("plaintext_only"),
      now: () => new Date("2026-02-01T00:00:00.000Z"),
    });
    const first = await app.inject({ url: "/api/workspace/artifacts?pagination=keyset_v1" });
    const cursor = first.json<{ nextCursor: string }>().nextCursor;
    expect(typeof cursor).toBe("string");

    await app.inject({
      url: `/api/workspace/artifacts?pagination=keyset_v1&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(listArtifactPageForNamespaces).toHaveBeenLastCalledWith({
      readableNamespaceIds: ["ns-a"],
      limit: 500,
      snapshotAt: new Date("2026-02-01T00:00:00.000Z"),
      after: { createdAt: "2026-01-01T00:00:00.123456Z", id: PAGED_ROW_ID },
    });

    bumpWorkspaceArtifactListGenerationForNamespaces(["ns-a"]);
    const stale = await app.inject({
      url: `/api/workspace/artifacts?pagination=keyset_v1&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "stale_artifact_list_cursor" });
  });

  test("does not publish a page when encryption policy changes during its read", async () => {
    let reads = 0;
    const app = await makeApp(ENVELOPE_A, async () => {}, {
      loadEncryptionPolicy: async () => ({
        ...encryptionPolicy("plaintext_only"), revision: ++reads,
      }),
    });
    const response = await app.inject({ url: "/api/workspace/artifacts?pagination=keyset_v1" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "artifact_list_pagination_unavailable" });
    expect(response.json()).not.toHaveProperty("artifacts");
  });

  test("rejects malformed opt-in cursors before querying a page", async () => {
    const app = await makeApp(ENVELOPE_A, async () => {}, {
      loadEncryptionPolicy: async () => encryptionPolicy("plaintext_only"),
    });
    const response = await app.inject({
      url: "/api/workspace/artifacts?pagination=keyset_v1&cursor=not-a-cursor",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_artifact_list_cursor" });
    expect(listArtifactPageForNamespaces).not.toHaveBeenCalled();
  });

  test.each(["2026-99-01T00:00:00.123456Z", "2026-02-30T00:00:00.123456Z"])(
    "rejects impossible keyset timestamp %s before querying", async (createdAt) => {
      const app = await makeApp(ENVELOPE_A, async () => {}, {
        loadEncryptionPolicy: async () => encryptionPolicy("plaintext_only"),
      });
      const cursor = Buffer.from(JSON.stringify({
        v: 1, scope: "scope", snapshotAt: "2026-03-01T00:00:00.000Z",
        createdAt, id: PAGED_ROW_ID,
      })).toString("base64url");
      const response = await app.inject({
        url: `/api/workspace/artifacts?pagination=keyset_v1&cursor=${cursor}`,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "invalid_artifact_list_cursor" });
      expect(listArtifactPageForNamespaces).not.toHaveBeenCalled();
    },
  );

  test("returns empty 304 with conditional headers when If-None-Match matches", async () => {
    const app = await makeApp();
    const first = await app.inject({ method: "GET", url: "/api/workspace/artifacts" });
    const etag = first.headers["etag"] as string;

    const second = await app.inject({
      method: "GET",
      url: "/api/workspace/artifacts",
      headers: { "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
    expectConditionalHeaders(second);
    expect(second.headers["etag"]).toBe(etag);
  });

  test("does not return 304 across different viewers sharing scope and projection", async () => {
    const appA = await makeApp(ENVELOPE_A);
    const appB = await makeApp(ENVELOPE_B);

    const resA = await appA.inject({ method: "GET", url: "/api/workspace/artifacts" });
    const etagA = resA.headers["etag"] as string;

    const crossScope = await appB.inject({
      method: "GET",
      url: "/api/workspace/artifacts",
      headers: { "if-none-match": etagA },
    });
    expect(crossScope.statusCode).toBe(200);
    expect(crossScope.headers["etag"]).not.toBe(etagA);
  });

  test("namespace invalidation rejects stale If-None-Match", async () => {
    const app = await makeApp();
    const before = await app.inject({ method: "GET", url: "/api/workspace/artifacts" });
    const etagBefore = before.headers["etag"] as string;

    bumpWorkspaceArtifactListGenerationForNamespaces(["ns-a"]);

    const after = await app.inject({ method: "GET", url: "/api/workspace/artifacts" });
    expect(after.headers["etag"]).not.toBe(etagBefore);

    const stale304 = await app.inject({
      method: "GET",
      url: "/api/workspace/artifacts",
      headers: { "if-none-match": etagBefore },
    });
    expect(stale304.statusCode).toBe(200);
    expect(stale304.body).not.toBe("");
  });

  test("401 before conditional handling when envelope is absent", async () => {
    const { workspaceArtifactsRoutes } = await import("../../src/routes/workspace-artifacts");
    const app = Fastify({ logger: false });
    workspaceArtifactsRoutes(app);
    await app.ready();
    apps.push(app);

    const res = await app.inject({ method: "GET", url: "/api/workspace/artifacts" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["etag"]).toBeUndefined();
  });

  test("missing artifact bytes return a bounded 404 before streaming", async () => {
    findArtifactByInternalIdForNamespaces.mockImplementation(async () => ({
      id: "row-missing",
      artifactId: "artifact-missing",
      path: "artifacts/missing.md",
      mimeType: "text/markdown",
      size: 42,
      storageUri: `file://${join(tmpdir(), `missing-${randomUUID()}.md`)}`,
      revision: 1,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      deletedAt: null,
    }));
    const app = await makeApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/workspace/artifacts/row-missing/bytes",
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      error: "Artifact bytes are unavailable",
      code: "artifact_bytes_unavailable",
    });
  });
});

describe("Human Workspace Artifact creation observers", () => {
  async function withArtifactRoot(run: () => Promise<void>): Promise<void> {
    const previous = process.env["NAUTILO_ARTIFACTS_ROOT"];
    const root = await mkdtemp(join(tmpdir(), "m323-artifact-create-"));
    process.env["NAUTILO_ARTIFACTS_ROOT"] = root;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
      else process.env["NAUTILO_ARTIFACTS_ROOT"] = previous;
      await rm(root, { recursive: true, force: true });
    }
  }

  test("upload observes the attached Artifact once with Human provenance", async () => {
    await withArtifactRoot(async () => {
      const facts: unknown[] = [];
      const app = await makeApp(ENVELOPE_A, async () => {}, {
        onArtifactCreated: async (fact) => { facts.push(fact); },
      });
      const body = new FormData();
      body.set("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
      body.set("path", "notes.txt");

      const response = await app.inject({
        method: "POST",
        url: "/api/workspace/artifacts",
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(facts).toEqual([{
        artifactInternalId: "11111111-1111-4111-8111-111111111111",
        namespaceId: "ns-a",
        actor: { kind: "human", userId: "owner-1" },
        occurrenceKey: "artifact.added:create:11111111-1111-4111-8111-111111111111",
      }]);
    });
  });

  test("Office New contains observer failure after successful attachment", async () => {
    await withArtifactRoot(async () => {
      const app = await makeApp(ENVELOPE_A, async () => {}, {
        onArtifactCreated: async () => { throw new Error("feed unavailable"); },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/office/new",
        payload: { kind: "writer", name: "Observer isolation" },
      });

      expect(response.statusCode).toBe(200);
      expect(attachArtifactToNamespace).toHaveBeenCalledTimes(1);
    });
  });

  test("failed Office attachment emits no creation fact", async () => {
    await withArtifactRoot(async () => {
      attachArtifactToNamespace.mockImplementationOnce(async () => {
        throw new Error("attach failed");
      });
      const facts: unknown[] = [];
      const app = await makeApp(ENVELOPE_A, async () => {}, {
        onArtifactCreated: async (fact) => { facts.push(fact); },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/office/new",
        payload: { kind: "writer", name: "Failed attachment" },
      });

      expect(response.statusCode).toBe(500);
      expect(facts).toEqual([]);
    });
  });
});

describe("PUT /api/workspace/artifacts/:id/state/:key recovery transport", () => {
  const artifact = {
    id: "row-recovery",
    artifactId: "artifact-recovery",
    path: "designs/recovery.design.html",
    mimeType: "text/html",
    size: 12,
    storageUri: "file:///tmp/recovery.design.html",
    revision: 7,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  };

  beforeEach(() => {
    findArtifactByInternalIdForNamespaces.mockImplementation(async () => artifact);
    getArtifactNamespaces.mockImplementation(async () => ["ns-a"]);
  });

  test("preserves an exact recovery envelope above Fastify's default JSON limit", async () => {
    const app = await makeApp();
    const content = `<main>${"recovery-byte".repeat(90_000)}</main>`;
    const value = {
      scope: `artifact:${artifact.id}`,
      content,
      exact: true,
      base: { sha256: "a".repeat(64), revision: artifact.revision },
    };
    expect(Buffer.byteLength(JSON.stringify({ value }), "utf8")).toBeGreaterThan(1024 * 1024);

    const put = await app.inject({
      method: "PUT",
      url: `/api/workspace/artifacts/${artifact.id}/state/design-draft-recovery`,
      payload: { value },
    });

    expect(put.statusCode).toBe(200);
    expect(setArtifactState).toHaveBeenCalledWith({
      namespaceId: "ns-a",
      agentId: ENVELOPE_A.agentId,
      artifactId: artifact.artifactId,
      key: "design-draft-recovery",
      value,
    });
    expect((JSON.parse(put.body) as { value: unknown }).value).toEqual(value);
  });

  test("retains write authorization before persisting a large recovery envelope", async () => {
    const app = await makeApp(ENVELOPE_A, async (input) => {
      throw new ArtifactWriteDeniedError(input);
    });
    const value = { content: "recovery-byte".repeat(90_000) };

    const response = await app.inject({
      method: "PUT",
      url: `/api/workspace/artifacts/${artifact.id}/state/design-draft-recovery`,
      payload: { value },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toEqual({
      error: "write_artifacts_required",
      code: "write_artifacts_required",
      capability: "write_artifacts",
    });
    expect(setArtifactState).not.toHaveBeenCalled();
  });
});


describe("current Artifact download authority", () => {
  const DOWNLOAD_ENVELOPE = {
    ...ENVELOPE_A,
    readableNamespaces: [...ENVELOPE_A.readableNamespaces],
    writableNamespaces: [...ENVELOPE_A.writableNamespaces],
    mutableNamespaces: [...ENVELOPE_A.mutableNamespaces],
    toolPolicy: {},
  } satisfies NamespaceMemoryEnvelope;
  async function withDownload(run: (bytes: Buffer) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "artifact-download-"));
    const bytes = Buffer.alloc(256 * 1024, 65);
    const path = join(root, "file.txt");
    await writeFile(path, bytes);
    findArtifactByInternalIdForNamespaces.mockImplementation(async () => ({
      id: "download-row", artifactId: "download-artifact", path: "file.txt",
      mimeType: "text/plain", size: bytes.length, storageUri: `file://${path}`,
      revision: 1, createdAt: new Date(), updatedAt: new Date(), deletedAt: null,
    }));
    try { await run(bytes); } finally { await rm(root, { recursive: true, force: true }); }
  }

  test("full and range downloads retain ordinary byte semantics after current checks", async () => {
    await withDownload(async bytes => {
      const app = await makeApp(DOWNLOAD_ENVELOPE, async () => {}, { buildCurrentEnvelope: async () => DOWNLOAD_ENVELOPE });
      const full = await app.inject({ url: "/api/workspace/artifacts/download-row/bytes" });
      expect(full.statusCode).toBe(200);
      expect(full.rawPayload).toEqual(bytes);
      const range = await app.inject({ url: "/api/workspace/artifacts/download-row/bytes", headers: { range: "bytes=7-23" } });
      expect(range.statusCode).toBe(206);
      expect(range.rawPayload).toEqual(bytes.subarray(7, 24));
      expect(range.headers["content-range"]).toBe(`bytes 7-23/${bytes.length}`);
      const archive = await app.inject({ method: "POST", url: "/api/workspace/artifacts/export", payload: { ids: ["download-row"] } });
      expect(archive.statusCode).toBe(200);
      expect(Buffer.from(unzipSync(archive.rawPayload)["file.txt"]!).equals(bytes)).toBe(true);
    });
  });

  test("withdrawal before publication rejects bytes without committing success headers", async () => {
    await withDownload(async () => {
      const app = await makeApp(DOWNLOAD_ENVELOPE, async () => {}, { buildCurrentEnvelope: async () => ({ ...DOWNLOAD_ENVELOPE, readableNamespaces: [] }) });
      const result = await app.inject({ url: "/api/workspace/artifacts/download-row/bytes" });
      expect(result.statusCode).toBe(403);
      expect(result.json()).toMatchObject({ code: "artifact_access_withdrawn" });
      expect(result.headers["content-type"]).toContain("application/json");
    });
  });

  test("a streaming withdrawal aborts the response instead of delivering the remaining bytes", async () => {
    await withDownload(async () => {
      let checks = 0;
      const app = await makeApp(DOWNLOAD_ENVELOPE, async () => {}, {
        buildCurrentEnvelope: async () => ++checks < 3 ? DOWNLOAD_ENVELOPE : { ...DOWNLOAD_ENVELOPE, readableNamespaces: [] },
      });
      await Promise.resolve(expect(Promise.resolve(app.inject({ url: "/api/workspace/artifacts/download-row/bytes" }))).rejects.toThrow());
      expect(checks).toBe(3);
    });
  });

  test("ZIP publication rechecks after file reads and sends no archive after withdrawal", async () => {
    await withDownload(async () => {
      let checks = 0;
      const app = await makeApp(DOWNLOAD_ENVELOPE, async () => {}, {
        buildCurrentEnvelope: async () => ++checks === 1 ? DOWNLOAD_ENVELOPE : { ...DOWNLOAD_ENVELOPE, readableNamespaces: [] },
      });
      const result = await app.inject({ method: "POST", url: "/api/workspace/artifacts/export", payload: { ids: ["download-row"] } });
      expect(result.statusCode).toBe(403);
      expect(result.headers["content-type"]).toContain("application/json");
      expect(checks).toBe(2);
    });
  });

  test("a different Human envelope cannot substitute for the requesting Human", async () => {
    await withDownload(async () => {
      const app = await makeApp(DOWNLOAD_ENVELOPE, async () => {}, { buildCurrentEnvelope: async () => ({ ...DOWNLOAD_ENVELOPE, ownerId: "another-human" }) });
      expect((await app.inject({ url: "/api/workspace/artifacts/download-row/bytes" })).statusCode).toBe(403);
    });
  });

  test("missing or failed current-authority composition cannot use the old envelope", async () => {
    await withDownload(async () => {
      const missing = await makeApp();
      expect((await missing.inject({ url: "/api/workspace/artifacts/download-row/bytes" })).statusCode).toBe(503);
      const failed = await makeApp(DOWNLOAD_ENVELOPE, async () => {}, { buildCurrentEnvelope: async () => { throw new Error("Unavailable"); } });
      expect((await failed.inject({ url: "/api/workspace/artifacts/download-row/bytes" })).statusCode).toBe(503);
    });
  });

  test("detaching the Artifact after admission denies delivery even if the Room stays readable", async () => {
    await withDownload(async () => {
      const app = await makeApp(DOWNLOAD_ENVELOPE, async () => {}, {
        buildCurrentEnvelope: async () => {
          findArtifactByInternalIdForNamespaces.mockImplementation(async () => null);
          return DOWNLOAD_ENVELOPE;
        },
      });
      expect((await app.inject({ url: "/api/workspace/artifacts/download-row/bytes" })).statusCode).toBe(403);
    });
  });
});
