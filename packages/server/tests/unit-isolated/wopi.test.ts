/**
 * D362 Phase 2/3 — focused unit tests for the quarantined WOPI module.
 *
 * Covers:
 *   - token store: issue → validate ok; wrong artifactId → reject;
 *     expired → reject.
 *   - CheckFileInfo returns `UserCanWrite:false` (read-only token) /
 *     `UserCanWrite:true` (writable token) and rejects a missing
 *     access token.
 *   - PutFile: validates the write grant, persists bytes, bumps
 *     revision, emits the workspace change event.
 *   - Lock family: LOCK → 200; conflicting LOCK → 409 + `X-WOPI-Lock`;
 *     UNLOCK with correct lock → 200.
 *   - Autosave debounce: a burst of `X-WOPI-IsAutosave:true` PutFile
 *     calls coalesces to a single revision bump; a user-initiated save
 *     flushes immediately.
 *
 * Mocks `@nautilo/db` so the tests don't need a live database; the
 * artifact lookup contract is asserted via the mock call shape. The
 * `eventBus` from `@nautilo/runtime` is the real one — tests subscribe
 * to it directly to assert the change event.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import * as actualDb from "@nautilo/db";
import * as actualTrust from "@nautilo/trust";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent, WorkspaceArtifactChangedEvent } from "@nautilo/types";

const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const NS_READ = "ns-readable-aaaa";
const NS_WRITE = "ns-writable-bbbb";

type ArtifactRow = {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string | null;
  size: number | null;
  storageUri: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

function fakeArtifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: ARTIFACT_ID,
    artifactId: "ext-artifact-id",
    path: "notes/sample.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    size: 2048,
    storageUri: "file:///tmp/does-not-matter/sample-bytes",
    revision: 3,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

const findArtifactMock = mock(
  async (params: {
    internalId: string;
    readableNamespaceIds: string[];
  }): Promise<ArtifactRow | null> => {
    // The token's `readableNamespaces` OR `writableNamespaces` are both
    // passed through `readableNamespaceIds` (the DB helper is namespace-
    // agnostic; the route picks which grant to pass). Accept the row
    // when EITHER the readable OR writable test namespace is present.
    if (
      params.internalId === ARTIFACT_ID &&
      (params.readableNamespaceIds.includes(NS_READ) ||
        params.readableNamespaceIds.includes(NS_WRITE))
    ) {
      return fakeArtifactRow();
    }
    return null;
  },
);

const bumpRevisionMock = mock(
  async (params: {
    id: string;
    size: number;
    mimeType?: string;
  }): Promise<ArtifactRow> => {
    return fakeArtifactRow({
      revision: 4,
      size: params.size,
      updatedAt: new Date(),
    });
  },
);

// Spread the real `@nautilo/db` so all the re-exports `@nautilo/trust`
// pulls in (`notInArray`, `eq`, etc.) keep working, then override just
// the functions wopi.ts actually calls.
mock.module("@nautilo/db", () => ({
  ...actualDb,
  findArtifactByInternalIdForNamespaces: findArtifactMock,
  bumpArtifactRevision: bumpRevisionMock,
}));

mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  assertCanWriteArtifacts: mock(async () => {}),
}));

const {
  wopiRoutes,
  issueWopiToken,
  validateWopiToken,
  __resetWopiTokenStoreForTests,
  __resetWopiLockStoreForTests,
  __resetWopiAutosaveThrottleForTests,
} = await import("../../src/routes/wopi");

function nsEnvelope(): MemoryAccessEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: "owner-1",
    actorId: "actor-1",
    agentId: "agent-1",
    roomId: "room-1",
    readableNamespaces: [NS_READ],
    mutableNamespaces: [NS_WRITE],
    writableNamespaces: [NS_WRITE],
    toolPolicy: {},
  };
}

function makeApp(
  envelope: MemoryAccessEnvelope | null,
  sessionUserId = "user-1",
  validateAdmissionProvenance?: (
    provenance: import("../../src/routes/wopi").WopiAdmissionProvenance,
  ) => Promise<boolean>,
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.memoryEnvelope = envelope;
    request.sessionUserId = sessionUserId;
  });
  wopiRoutes(app, validateAdmissionProvenance
    ? { validateAdmissionProvenance }
    : undefined);
  return app;
}

describe("wopi token store", () => {
  beforeEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
    findArtifactMock.mockClear();
    bumpRevisionMock.mockClear();
  });
  afterEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
  });

  test("issue → validate ok for the bound artifactId", () => {
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    const record = validateWopiToken(token, ARTIFACT_ID);
    expect(record).not.toBeNull();
    expect(record?.artifactId).toBe(ARTIFACT_ID);
    expect(record?.userId).toBe("user-1");
  });

  test("validate rejects a token presented for a different artifactId", () => {
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    const record = validateWopiToken(token, "22222222-2222-4222-8222-222222222222");
    expect(record).toBeNull();
  });

  test("validate rejects an expired token", () => {
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    // Advance the clock past the 8h TTL by mocking Date.now for the
    // validate call only. We stub, then restore immediately.
    const realNow = Date.now;
    const fakeNow = realNow() + 9 * 60 * 60 * 1000;
    Date.now = () => fakeNow;
    try {
      const record = validateWopiToken(token, ARTIFACT_ID);
      expect(record).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test("validate rejects undefined / empty tokens", () => {
    expect(validateWopiToken(undefined, ARTIFACT_ID)).toBeNull();
    expect(validateWopiToken("", ARTIFACT_ID)).toBeNull();
  });
});

describe("wopi CheckFileInfo route", () => {
  beforeEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
    findArtifactMock.mockClear();
    bumpRevisionMock.mockClear();
  });
  afterEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
  });

  test("rejects a missing access_token with 401", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({ method: "GET", url: `/wopi/files/${ARTIFACT_ID}` });
    expect(res.statusCode).toBe(401);
  });

  test("rejects an invalid access_token with 401", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "GET",
      url: `/wopi/files/${ARTIFACT_ID}?access_token=not-a-real-token`,
    });
    expect(res.statusCode).toBe(401);
  });

  test("rejects delegated Human access after device provenance becomes stale", async () => {
    const provenance = {
      kind: "human_device" as const,
      userId: "user-1",
      humanActorId: "actor-1",
      deviceId: "browser-1",
      deviceGeneration: 1,
      serverInstanceId: "server-1",
      lineageGeneration: 1,
      epoch: 1,
      securityRevision: 1,
      headDigest: new Uint8Array(32),
    };
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
      provenance,
    });
    const validate = mock(async () => false);
    const app = makeApp(nsEnvelope(), "user-1", validate);
    const res = await app.inject({
      method: "GET",
      url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(401);
    expect(validate).toHaveBeenCalledWith(provenance);
    await app.close();
  });

  test("returns UserCanWrite:false for a valid token", async () => {
    const app = makeApp(nsEnvelope());
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    const res = await app.inject({
      method: "GET",
      url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["UserCanWrite"]).toBe(false);
    expect(body["SupportsUpdate"]).toBe(false);
    expect(body["SupportsLocks"]).toBe(true);
    expect(body["BaseFileName"]).toBe("sample.docx");
    expect(body["Version"]).toBe("3");
    expect(body["UserId"]).toBe("user-1");
  });

  test("returns UserCanWrite:true when the token has the artifact's namespace as mutable", async () => {
    const app = makeApp(nsEnvelope());
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      writableNamespaces: [NS_WRITE],
      mutableNamespaces: [NS_WRITE],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    const res = await app.inject({
      method: "GET",
      url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["UserCanWrite"]).toBe(true);
    expect(body["SupportsUpdate"]).toBe(true);
    expect(body["SupportsLocks"]).toBe(true);
  });

  test("UserCanWrite stays false when writableNamespaces is set but mutableNamespaces is empty (write gate uses mutable set)", async () => {
    // Regression guard for the C1 fix: the WOPI write gate must consume
    // `mutableNamespaces`, NOT `writableNamespaces`. A token with the
    // narrow attachment-target set (`writableNamespaces=[NS_WRITE]`)
    // but an EMPTY mutation set must still report `UserCanWrite:false`.
    const app = makeApp(nsEnvelope());
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      writableNamespaces: [NS_WRITE],
      // mutableNamespaces intentionally omitted → defaults to [].
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    const res = await app.inject({
      method: "GET",
      url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["UserCanWrite"]).toBe(false);
    expect(body["SupportsUpdate"]).toBe(false);
  });

  test("returns 404 when the artifact is not visible to the token's namespaces", async () => {
    const app = makeApp(nsEnvelope());
    const { token } = issueWopiToken(ARTIFACT_ID, {
      // Token grants a namespace the mock does NOT consider readable,
      // so findArtifactByInternalIdForNamespaces returns null.
      readableNamespaces: ["ns-other"],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    const res = await app.inject({
      method: "GET",
      url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("wopi-token mint route", () => {
  beforeEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
    findArtifactMock.mockClear();
    bumpRevisionMock.mockClear();
  });
  afterEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
  });

  test("mints a token + wopiSrc for an artifact the envelope can read", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: "/api/office/wopi-token",
      payload: { artifactId: ARTIFACT_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { token: string; wopiSrc: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    // wopiSrc is the container→host callback origin (config-derived server
    // port), not a hardcoded host:port — coolwsd reaches the host via
    // host.docker.internal (matches the compose aliasgroup).
    expect(body.wopiSrc).toMatch(
      new RegExp(`^http://host\\.docker\\.internal:\\d+/wopi/files/${ARTIFACT_ID}$`),
    );
  });

  test("401 when no envelope (not authenticated)", async () => {
    const app = makeApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/office/wopi-token",
      payload: { artifactId: ARTIFACT_ID },
    });
    expect(res.statusCode).toBe(401);
  });

  test("404 when the artifact is not in the caller's readable namespaces", async () => {
    const envelope: MemoryAccessEnvelope = {
      memoryMode: "namespace",
      ownerId: "owner-1",
      actorId: "actor-1",
      agentId: "agent-1",
      roomId: "room-1",
      readableNamespaces: ["ns-other"],
      mutableNamespaces: ["ns-other"],
      writableNamespaces: ["ns-other"],
      toolPolicy: {},
    };
    const app = makeApp(envelope);
    const res = await app.inject({
      method: "POST",
      url: "/api/office/wopi-token",
      payload: { artifactId: ARTIFACT_ID },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Phase 3 — PutFile / Lock / Autosave ──────────────────────────────
//
// The new write-path tests use a real on-disk temp file (under the OS
// tmpdir) so the `fsWriteFile` in `persistArtifactBytes` actually has
// somewhere to land. The `storageUri` on the fake row points at that
// temp file; `bumpArtifactRevision` is mocked so we don't need a live
// DB. The `eventBus` is the real one — we subscribe during a test to
// assert the workspace change event fires (or doesn't, for the
// throttled autosave case).

async function makeTempArtifactFile(initialBytes: Buffer): Promise<{
  storageUri: string;
  absPath: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "wopi-put-"));
  const absPath = join(dir, "sample.docx");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(absPath, initialBytes);
  return {
    storageUri: `file://${absPath}`,
    absPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Issue a write-capable token (readable=NS_READ, writable=NS_WRITE, mutable=NS_WRITE). */
function issueWriteToken(artifactId: string = ARTIFACT_ID): string {
  const { token } = issueWopiToken(artifactId, {
    readableNamespaces: [NS_READ],
    writableNamespaces: [NS_WRITE],
    mutableNamespaces: [NS_WRITE],
    ownerId: "owner-1",
    userId: "user-1",
    userFriendlyName: "User One",
  });
  return token;
}

describe("wopi PutFile route", () => {
  beforeEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
    findArtifactMock.mockClear();
    bumpRevisionMock.mockClear();
  });
  afterEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
  });

  test("401 when no access_token is presented", async () => {
    const app = makeApp(nsEnvelope());
    const res = await app.inject({
      method: "POST",
      url: `/wopi/files/${ARTIFACT_ID}/contents`,
      headers: { "x-wopi-override": "PUT", "content-type": "application/octet-stream" },
      payload: Buffer.from("hi"),
    });
    expect(res.statusCode).toBe(401);
  });

  test("403 when the token has no writable namespace for the artifact", async () => {
    const app = makeApp(nsEnvelope());
    const { token } = issueWopiToken(ARTIFACT_ID, {
      readableNamespaces: [NS_READ],
      // No writableNamespaces — read-only token.
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });
    const res = await app.inject({
      method: "POST",
      url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`,
      headers: { "x-wopi-override": "PUT", "content-type": "application/octet-stream" },
      payload: Buffer.from("hi"),
    });
    expect(res.statusCode).toBe(403);
  });

  test("400 when X-WOPI-Override is not PUT", async () => {
    const app = makeApp(nsEnvelope());
    const token = issueWriteToken();
    const res = await app.inject({
      method: "POST",
      url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`,
      headers: { "x-wopi-override": "LOCK", "content-type": "application/octet-stream" },
      payload: Buffer.from("hi"),
    });
    expect(res.statusCode).toBe(400);
  });

  test("persists bytes + bumps revision + emits change event with a valid write token", async () => {
    const tmp = await makeTempArtifactFile(Buffer.from("initial"));
    try {
      // Override the mock to return our temp-file-backed row for BOTH
      // the readable lookup (NS_READ) and the writability lookup
      // (NS_WRITE). The default mock returns a fixed storageUri that
      // doesn't exist on disk; we need the row to point at our temp
      // file so the `fsWriteFile` actually lands somewhere.
      findArtifactMock.mockImplementation(
        async (params: {
          internalId: string;
          readableNamespaceIds: string[];
        }): Promise<ArtifactRow | null> => {
          if (
            params.internalId === ARTIFACT_ID &&
            (params.readableNamespaceIds.includes(NS_READ) ||
              params.readableNamespaceIds.includes(NS_WRITE))
          ) {
            return fakeArtifactRow({ storageUri: tmp.storageUri, revision: 3 });
          }
          return null;
        },
      );

      const app = makeApp(nsEnvelope());
      const token = issueWriteToken();

      const captured: { event: WorkspaceArtifactChangedEvent | null } = { event: null };
      const handler = (e: ServerEvent): void => {
        if (e.type === "workspace.artifact.changed" && e.id === ARTIFACT_ID) {
          captured.event = e;
        }
      };
      eventBus.on(handler);
      try {
        const newBytes = Buffer.from("edited-by-collabora", "utf8");
        const res = await app.inject({
          method: "POST",
          url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`,
          headers: {
            "x-wopi-override": "PUT",
            "content-type": "application/octet-stream",
            // User-initiated save → flush immediately.
            "x-wopi-ismodifiedbyuser": "true",
          },
          payload: newBytes,
        });
        expect(res.statusCode).toBe(200);
        // X-WOPI-ItemVersion carries the post-bump revision.
        expect(res.headers["x-wopi-itemversion"]).toBe("4");

        // bumpArtifactRevision was called once with the new size.
        expect(bumpRevisionMock.mock.calls.length).toBe(1);
        expect(bumpRevisionMock.mock.calls[0]?.[0]?.size).toBe(newBytes.byteLength);

        // Bytes landed on disk.
        const onDisk = await readFile(tmp.absPath);
        expect(onDisk.equals(newBytes)).toBe(true);

        // Change event fired so other clients refresh via SSE.
        expect(captured.event).not.toBeNull();
        expect(captured.event?.id).toBe(ARTIFACT_ID);
      } finally {
        eventBus.off(handler);
      }
    } finally {
      await tmp.cleanup();
    }
  });
});

describe("wopi lock family", () => {
  beforeEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
    findArtifactMock.mockClear();
    bumpRevisionMock.mockClear();
  });
  afterEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
  });

  test("LOCK then conflicting LOCK → 409 with X-WOPI-Lock; UNLOCK with correct lock → 200", async () => {
    const app = makeApp(nsEnvelope());
    const token = issueWriteToken();
    const authedUrl = (op: string) =>
      `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}&op=${op}`;

    // First LOCK succeeds.
    const lockRes = await app.inject({
      method: "POST",
      url: authedUrl("lock"),
      headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "lock-aaa" },
    });
    expect(lockRes.statusCode).toBe(200);

    // Conflicting LOCK with a different lock id → 409 + X-WOPI-Lock: lock-aaa.
    const conflictRes = await app.inject({
      method: "POST",
      url: authedUrl("lock"),
      headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "lock-bbb" },
    });
    expect(conflictRes.statusCode).toBe(409);
    expect(conflictRes.headers["x-wopi-lock"]).toBe("lock-aaa");

    // UNLOCK with the correct lock → 200.
    const unlockRes = await app.inject({
      method: "POST",
      url: authedUrl("unlock"),
      headers: { "x-wopi-override": "UNLOCK", "x-wopi-lock": "lock-aaa" },
    });
    expect(unlockRes.statusCode).toBe(200);

    // After unlock, a fresh LOCK with a new id succeeds (no stale 409).
    const relockRes = await app.inject({
      method: "POST",
      url: authedUrl("lock"),
      headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "lock-ccc" },
    });
    expect(relockRes.statusCode).toBe(200);
  });

  test("UNLOCK with the wrong lock id → 409 with X-WOPI-Lock", async () => {
    const app = makeApp(nsEnvelope());
    const token = issueWriteToken();
    const url = `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`;

    const lockRes = await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "lock-aaa" },
    });
    expect(lockRes.statusCode).toBe(200);

    const badUnlock = await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "UNLOCK", "x-wopi-lock": "lock-wrong" },
    });
    expect(badUnlock.statusCode).toBe(409);
    expect(badUnlock.headers["x-wopi-lock"]).toBe("lock-aaa");
  });

  test("GET_LOCK reports the current lock (or empty when unlocked)", async () => {
    const app = makeApp(nsEnvelope());
    const token = issueWriteToken();
    const url = `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`;

    const empty = await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "GET_LOCK" },
    });
    expect(empty.statusCode).toBe(200);
    // No lock held → header is the empty string.
    expect(empty.headers["x-wopi-lock"] ?? "").toBe("");

    await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "lock-xyz" },
    });

    const held = await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "GET_LOCK" },
    });
    expect(held.statusCode).toBe(200);
    expect(held.headers["x-wopi-lock"]).toBe("lock-xyz");
  });

  test("REFRESH_LOCK on a held lock extends the TTL; on a missing lock → 404", async () => {
    const app = makeApp(nsEnvelope());
    const token = issueWriteToken();
    const url = `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`;

    const missingRefresh = await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "REFRESH_LOCK", "x-wopi-lock": "lock-aaa" },
    });
    expect(missingRefresh.statusCode).toBe(404);

    await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "LOCK", "x-wopi-lock": "lock-aaa" },
    });
    const refreshRes = await app.inject({
      method: "POST",
      url,
      headers: { "x-wopi-override": "REFRESH_LOCK", "x-wopi-lock": "lock-aaa" },
    });
    expect(refreshRes.statusCode).toBe(200);
  });
});

describe("wopi PutFile autosave debounce", () => {
  beforeEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
    findArtifactMock.mockClear();
    bumpRevisionMock.mockClear();
  });
  afterEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
  });

  test("a burst of X-WOPI-IsAutosave:true saves coalesces to one revision bump; user save flushes", async () => {
    const tmp = await makeTempArtifactFile(Buffer.from("initial"));
    try {
      findArtifactMock.mockImplementation(
        async (params: {
          internalId: string;
          readableNamespaceIds: string[];
        }): Promise<ArtifactRow | null> => {
          if (
            params.internalId === ARTIFACT_ID &&
            (params.readableNamespaceIds.includes(NS_READ) ||
              params.readableNamespaceIds.includes(NS_WRITE))
          ) {
            return fakeArtifactRow({ storageUri: tmp.storageUri, revision: 3 });
          }
          return null;
        },
      );

      const app = makeApp(nsEnvelope());
      const token = issueWriteToken();

      const autosave = (payload: Buffer) =>
        app.inject({
          method: "POST",
          url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`,
          headers: {
            "x-wopi-override": "PUT",
            "content-type": "application/octet-stream",
            "x-wopi-isautosave": "true",
          },
          payload,
        });

      // Burst of 3 autosaves within the debounce window. Only the first
      // should bump the revision; the next two persist bytes but skip
      // the bump + change event.
      const r1 = await autosave(Buffer.from("a1"));
      const r2 = await autosave(Buffer.from("a2"));
      const r3 = await autosave(Buffer.from("a3"));
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(200);

      // Exactly one revision bump for the 3-autosave burst.
      expect(bumpRevisionMock.mock.calls.length).toBe(1);

      // The LAST autosave's bytes are what's on disk (always persisted).
      const onDisk = await readFile(tmp.absPath);
      expect(onDisk.equals(Buffer.from("a3"))).toBe(true);

      // A user-initiated save (`X-WOPI-IsModifiedByUser:true`) flushes
      // immediately — second bump.
      const userSave = await app.inject({
        method: "POST",
        url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`,
        headers: {
          "x-wopi-override": "PUT",
          "content-type": "application/octet-stream",
          "x-wopi-isautosave": "true",
          "x-wopi-ismodifiedbyuser": "true",
        },
        payload: Buffer.from("user-save"),
      });
      expect(userSave.statusCode).toBe(200);
      expect(bumpRevisionMock.mock.calls.length).toBe(2);

      const onDisk2 = await readFile(tmp.absPath);
      expect(onDisk2.equals(Buffer.from("user-save"))).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  });
});

// ─── C1 — cross-room EDIT gate uses `mutableNamespaces` ───────────────
//
// Regression suite for the D362 C1 fix. The artifact is attached to
// `NS_A` (the room where it was created). A human opening it from a
// different room `NS_B` mints a token whose `writableNamespaces` is the
// narrow attachment-target set `[NS_B]` (by design — that's where THEIR
// new artifacts would attach), but whose `mutableNamespaces` follows
// the superset rule and includes both `[NS_A, NS_B]`. The WOPI write
// gate (CheckFileInfo `UserCanWrite` + PutFile 403) must consume
// `mutableNamespaces`, so cross-room edit succeeds (matching the
// agent's `apply_patch` path). The negative case proves an artifact in
// a namespace NOT in `mutableNamespaces` stays read-only — private
// stays private.

const NS_A = "ns-owned-aaaa";
const NS_B = "ns-currentroom-bbbb";

describe("wopi cross-room edit gate (C1 fix)", () => {
  beforeEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
    findArtifactMock.mockClear();
    bumpRevisionMock.mockClear();
  });
  afterEach(() => {
    __resetWopiTokenStoreForTests();
    __resetWopiLockStoreForTests();
    __resetWopiAutosaveThrottleForTests();
  });

  // The artifact is attached to NS_A only. The mock returns the row iff
  // the lookup's namespace set includes NS_A — modelling the DB's
  // `artifactNamespaces.namespaceId IN (...)` join.
  function mockArtifactAttachedToNsA(): void {
    findArtifactMock.mockImplementation(
      async (params: {
        internalId: string;
        readableNamespaceIds: string[];
      }): Promise<ArtifactRow | null> => {
        if (
          params.internalId === ARTIFACT_ID &&
          params.readableNamespaceIds.includes(NS_A)
        ) {
          return fakeArtifactRow();
        }
        return null;
      },
    );
  }

  test("POSITIVE: artifact in NS_A, token writable=[NS_B] but mutable=[NS_A,NS_B] → UserCanWrite:true + PutFile 200", async () => {
    mockArtifactAttachedToNsA();
    const tmp = await makeTempArtifactFile(Buffer.from("initial"));
    try {
      // Override the mock to also return the temp-file-backed row so the
      // PutFile persist path has a real on-disk target. The artifact is
      // still "attached to NS_A" — the lookup accepts any set containing
      // NS_A.
      findArtifactMock.mockImplementation(
        async (params: {
          internalId: string;
          readableNamespaceIds: string[];
        }): Promise<ArtifactRow | null> => {
          if (
            params.internalId === ARTIFACT_ID &&
            params.readableNamespaceIds.includes(NS_A)
          ) {
            return fakeArtifactRow({ storageUri: tmp.storageUri, revision: 3 });
          }
          return null;
        },
      );

      const app = makeApp(nsEnvelope());
      const { token } = issueWopiToken(ARTIFACT_ID, {
        // Read sees both rooms (superset rule) → lookup succeeds.
        readableNamespaces: [NS_A, NS_B],
        // Narrow attachment-target set for the current room — by design.
        writableNamespaces: [NS_B],
        // Broad mutation set (== readable under the current model) —
        // this is what the write gate must consume.
        mutableNamespaces: [NS_A, NS_B],
        ownerId: "owner-1",
        userId: "user-1",
        userFriendlyName: "User One",
      });

      // CheckFileInfo: UserCanWrite:true because NS_A ∈ mutableNamespaces.
      const infoRes = await app.inject({
        method: "GET",
        url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
      });
      expect(infoRes.statusCode).toBe(200);
      const infoBody = JSON.parse(infoRes.body) as Record<string, unknown>;
      expect(infoBody["UserCanWrite"]).toBe(true);
      expect(infoBody["SupportsUpdate"]).toBe(true);

      // PutFile: 200 because the mutable set contains the artifact's
      // owning namespace NS_A.
      const newBytes = Buffer.from("cross-room-edit", "utf8");
      const putRes = await app.inject({
        method: "POST",
        url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`,
        headers: {
          "x-wopi-override": "PUT",
          "content-type": "application/octet-stream",
          "x-wopi-ismodifiedbyuser": "true",
        },
        payload: newBytes,
      });
      expect(putRes.statusCode).toBe(200);
      const onDisk = await readFile(tmp.absPath);
      expect(onDisk.equals(newBytes)).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  });

  test("NEGATIVE: artifact in NS_A, mutable=[NS_B] only (NS_A not in mutable) → UserCanWrite:false + PutFile 403", async () => {
    mockArtifactAttachedToNsA();
    const app = makeApp(nsEnvelope());
    const { token } = issueWopiToken(ARTIFACT_ID, {
      // Read still sees NS_A (superset rule) → CheckFileInfo lookup
      // succeeds and the route returns 200 with the file metadata.
      readableNamespaces: [NS_A, NS_B],
      writableNamespaces: [NS_B],
      // Mutable set does NOT include NS_A — the artifact's owning
      // namespace is outside the mutation grant. This is the "private
      // stays private" half: a token whose mutation scope excludes the
      // artifact's namespace cannot edit it.
      mutableNamespaces: [NS_B],
      ownerId: "owner-1",
      userId: "user-1",
      userFriendlyName: "User One",
    });

    // CheckFileInfo: lookup with readableNamespaces finds the row, but
    // the write gate (mutable=[NS_B]) does not contain NS_A →
    // UserCanWrite:false.
    const infoRes = await app.inject({
      method: "GET",
      url: `/wopi/files/${ARTIFACT_ID}?access_token=${encodeURIComponent(token)}`,
    });
    expect(infoRes.statusCode).toBe(200);
    const infoBody = JSON.parse(infoRes.body) as Record<string, unknown>;
    expect(infoBody["UserCanWrite"]).toBe(false);
    expect(infoBody["SupportsUpdate"]).toBe(false);

    // PutFile: read lookup succeeds (row found), but the write gate
    // rejects → 403. No bytes persisted.
    const putRes = await app.inject({
      method: "POST",
      url: `/wopi/files/${ARTIFACT_ID}/contents?access_token=${encodeURIComponent(token)}`,
      headers: {
        "x-wopi-override": "PUT",
        "content-type": "application/octet-stream",
        "x-wopi-ismodifiedbyuser": "true",
      },
      payload: Buffer.from("should-not-persist"),
    });
    expect(putRes.statusCode).toBe(403);
    expect(bumpRevisionMock.mock.calls.length).toBe(0);
  });
});
