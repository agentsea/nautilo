import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import {
  actors,
  agents,
  createDirectDb,
  ensureDatabase,
  eq,
  nautiloInstanceIdentity,
  ownedPhotoEntries,
  profiles,
  sql,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createPhotoLibraryCursorCodec } from "../../src/photo-library/photo-library-cursor";
import { AgentPhotoLibraryReadService } from "../../src/lib/agent-photo-library-read-service";
import { AgentPhotoLibraryError } from "../../src/lib/agent-photo-library-service";
import {
  agentPhotoLibraryRoutes,
  type AgentPhotoLibraryRouteDeps,
} from "../../src/routes/agent-photo-library";

type Db = ReturnType<typeof createDirectDb>;
let db: Db;
let serverInstanceId: string;
let nowMs = Date.now();
const cleanup: Array<{ userId: string; agentId: string }> = [];

function responseJson<T>(response: { body: string }): T {
  return JSON.parse(response.body) as unknown as T;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(8);
  const [identity] = await db.select().from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
  if (!identity) throw new Error("missing test Server identity");
  serverInstanceId = identity.serverInstanceId;
}, 30_000);

afterAll(async () => {
  for (const fixture of cleanup) {
    await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, fixture.agentId));
    await db.delete(profiles).where(eq(profiles.agentId, fixture.agentId));
    await db.delete(actors).where(eq(actors.agentId, fixture.agentId));
    await db.delete(agents).where(eq(agents.id, fixture.agentId));
    await db.delete(users).where(eq(users.id, fixture.userId));
  }
  await db.end();
});

async function fixture() {
  const nonce = randomUUID();
  const [user] = await db.insert(users).values({
    name: "D487 read owner", email: `d487-read-${nonce}@test.invalid`, handle: `d487r${nonce.replaceAll("-", "").slice(0, 12)}`,
  }).returning({ id: users.id });
  const [agent] = await db.insert(agents).values({ handle: `d487-read-agent-${nonce}` }).returning({ id: agents.id });
  if (!user || !agent) throw new Error("fixture insert failed");
  cleanup.push({ userId: user.id, agentId: agent.id });
  await db.insert(actors).values({ ownerId: user.id, kind: "agent", agentId: agent.id, displayName: "D487 Read" });
  const [profile] = await db.insert(profiles).values({ userId: user.id, agentId: agent.id, avatarRef: null }).returning({ id: profiles.id });
  if (!profile) throw new Error("profile insert failed");
  return { userId: user.id, agentId: agent.id, profileId: profile.id };
}

async function entry(input: { userId: string; agentId: string; ordinal: number; deleted?: boolean }) {
  const createdAt = new Date(nowMs - input.ordinal * 1000);
  const blobId = `d487-read-${randomUUID()}`;
  const [row] = await db.insert(ownedPhotoEntries).values({
    serverInstanceId, ownerUserId: input.userId, subjectKind: "agent", agentId: input.agentId,
    avatarKind: "uploaded", blobId, source: "upload", origin: "mobile", operationId: randomUUID(),
    requestFingerprint: "a".repeat(64), mediaMimeType: "image/png", mediaByteSize: 12, mediaSha256: "b".repeat(64),
    createdAt, deletedAt: input.deleted ? createdAt : null, purgeAfter: input.deleted ? new Date(createdAt.getTime() + 86_400_000) : null,
  }).returning();
  if (!row) throw new Error("entry insert failed");
  return row;
}

function appFor(
  userId: string,
  agentId: string,
  options: {
    readonly resolvePersonalAgentId?: (input: { userId: string; effectiveAgentId: string | null }) => Promise<string | null>;
    readonly routeDeps?: Omit<AgentPhotoLibraryRouteDeps, "db" | "now" | "cursorCodec" | "resolvePersonalAgentId" | "blobExists" | "readMedia">;
  } = {},
) {
  const app = Fastify();
  app.register(multipart);
  app.decorateRequest("sessionUserId", null);
  app.addHook("onRequest", async (request) => {
    request.sessionUserId = request.headers["x-test-user"] === "none" ? null : userId;
    const effectiveAgentId = request.headers["x-test-agent"];
    if (typeof effectiveAgentId === "string" && effectiveAgentId.length > 0) {
      // The real auth pre-handler stamps this per-request envelope.  The
      // harness deliberately does the same rather than smuggling a selected
      // Agent through a route dependency, so this proves the route reads it.
      (request as unknown as { memoryEnvelope?: { agentId: string } }).memoryEnvelope = { agentId: effectiveAgentId };
    }
  });
  agentPhotoLibraryRoutes(app, {
    ...(options.routeDeps ?? {}),
    assertCanUseServerProviderCredentials:
      options.routeDeps?.assertCanUseServerProviderCredentials ?? (async () => {}),
    db,
    now: () => new Date(nowMs),
    cursorCodec: createPhotoLibraryCursorCodec("p".repeat(32), () => new Date(nowMs)),
    resolvePersonalAgentId: options.resolvePersonalAgentId ?? (async () => agentId),
    blobExists: () => true,
    readMedia: async () => ({ ok: true as const, bytes: Buffer.from("media"), contentType: "image/png" as const, etag: "test-media" }),
  });
  return app;
}

describe("D487 owned Agent-photo read routes", () => {
  test("routes an effective selected owned Agent from the request envelope and rejects a foreign selection", async () => {
    const owner = await fixture();
    const foreign = await fixture();
    const [second] = await db.insert(agents).values({ handle: `d487-read-second-${randomUUID()}` }).returning({ id: agents.id });
    if (!second) throw new Error("second owned Agent insert failed");
    await db.insert(actors).values({ ownerId: owner.userId, kind: "agent", agentId: second.id, displayName: "D487 Read Second" });
    const [secondProfile] = await db.insert(profiles).values({ userId: owner.userId, agentId: second.id, avatarRef: null }).returning({ id: profiles.id });
    if (!secondProfile) throw new Error("second owned Agent profile insert failed");
    const secondEntry = await entry({ userId: owner.userId, agentId: second.id, ordinal: 0 });
    const resolverInputs: Array<{ userId: string; effectiveAgentId: string | null }> = [];
    const app = appFor(owner.userId, owner.agentId, {
      resolvePersonalAgentId: async (input) => {
        resolverInputs.push(input);
        if (input.userId !== owner.userId) return null;
        return input.effectiveAgentId === owner.agentId || input.effectiveAgentId === second.id
          ? input.effectiveAgentId
          : null;
      },
    });
    try {
      const selected = await app.inject({
        method: "GET",
        url: "/api/profile/agent-photo-library/current",
        headers: { "x-test-agent": second.id },
      });
      expect(selected.statusCode).toBe(200);
      const selectedBody = responseJson<{ current: { scope: { agentId: string }; entryId: string | null } }>(selected);
      expect(selectedBody.current.scope.agentId).toBe(second.id);
      expect(selectedBody.current.entryId).toBeNull();
      expect(resolverInputs[0]).toEqual({ userId: owner.userId, effectiveAgentId: second.id });

      const selectedList = await app.inject({
        method: "GET",
        url: "/api/profile/agent-photo-library",
        headers: { "x-test-agent": second.id },
      });
      expect(selectedList.statusCode).toBe(200);
      const selectedListBody = responseJson<{ entries: Array<{ id: string }>; scope: { agentId: string } }>(selectedList);
      expect(selectedListBody.entries.map((item) => item.id)).toEqual([secondEntry.id]);
      expect(selectedListBody.scope.agentId).toBe(second.id);

      const rejected = await app.inject({
        method: "GET",
        url: "/api/profile/agent-photo-library",
        headers: { "x-test-agent": foreign.agentId },
      });
      expect(rejected.statusCode).toBe(403);
      const rejectedBody = responseJson<{ error: { code: string }; entries?: unknown }>(rejected);
      expect(rejectedBody.error.code).toBe("photo_forbidden");
      expect(rejectedBody.entries).toBeUndefined();
    } finally {
      await app.close();
      await db.delete(ownedPhotoEntries).where(eq(ownedPhotoEntries.agentId, second.id));
      await db.delete(profiles).where(eq(profiles.id, secondProfile.id));
      await db.delete(actors).where(eq(actors.agentId, second.id));
      await db.delete(agents).where(eq(agents.id, second.id));
    }
  }, 20_000);

  test("uses scoped keyset cursors, hides original capabilities from lists, and rejects stale/tampered pages", async () => {
    const data = await fixture();
    const app = appFor(data.userId, data.agentId);
    try {
      await app.ready();
      await Promise.all(Array.from({ length: 25 }, (_, ordinal) => entry({ ...data, ordinal })));
      const first = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library?limit=24" });
      expect(first.statusCode).toBe(200);
      const firstBody = responseJson<{ entries: Array<{ id: string }>; nextCursor: string }>(first);
      expect(firstBody.entries).toHaveLength(24);
      expect(JSON.stringify(firstBody.entries)).not.toContain("blobId");
      expect(JSON.stringify(firstBody.entries)).not.toContain("fullUrl");
      const media = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library/entries/${String(firstBody.entries[0]!["id"])}/media?size=full` });
      expect(media.statusCode).toBe(200);
      const second = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library?limit=24&cursor=${encodeURIComponent(firstBody.nextCursor)}` });
      expect(responseJson<{ entries: unknown[] }>(second).entries).toHaveLength(1);
      const projectionMismatch = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library?projection=deleted&cursor=${encodeURIComponent(firstBody.nextCursor)}` });
      expect(projectionMismatch.statusCode).toBe(400);
      expect(responseJson<{ error: { code: string } }>(projectionMismatch).error.code).toBe("invalid_cursor");
      const tampered = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library?cursor=${encodeURIComponent(`${firstBody.nextCursor}x`)}` });
      expect(tampered.statusCode).toBe(400);
      expect(responseJson<{ error: { code: string } }>(tampered).error.code).toBe("invalid_cursor");
      await db.update(profiles).set({ avatarLibraryRevision: 1 }).where(eq(profiles.id, data.profileId));
      const stale = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library?cursor=${encodeURIComponent(firstBody.nextCursor)}` });
      expect(stale.statusCode).toBe(409);
      const staleBody = responseJson<{ error: { code: string; scope?: { libraryRevision: string } } }>(stale);
      expect(staleBody.error.code).toBe("stale_library_revision");
      expect(staleBody.error.scope?.libraryRevision).toBe("1");
      nowMs += 15 * 60 * 1000;
      const expired = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library?cursor=${encodeURIComponent(firstBody.nextCursor)}` });
      expect(expired.statusCode).toBe(400);
      await app.close();
    } finally {
      nowMs = Date.now();
    }
  }, 20_000);

  test("requires a session and treats a foreign entry as invisible", async () => {
    const owner = await fixture();
    const other = await fixture();
    const foreign = await entry({ ...other, ordinal: 0 });
    const app = appFor(owner.userId, owner.agentId);
    try {
      const unauthenticated = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library/current", headers: { "x-test-user": "none" } });
      expect(unauthenticated.statusCode).toBe(401);
      const hidden = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library/entries/${foreign.id}` });
      expect(hidden.statusCode).toBe(404);
      const hiddenMedia = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library/entries/${foreign.id}/media?size=full` });
      expect(hiddenMedia.statusCode).toBe(404);
      const malformed = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library/entries/not-a-uuid" });
      expect(malformed.statusCode).toBe(400);
      expect(responseJson<{ error: { code: string } }>(malformed).error.code).toBe("invalid_photo_request");
    } finally {
      await app.close();
    }
  }, 20_000);

  test("keeps catalogue reads usable when the legacy current custom photo is missing", async () => {
    const data = await fixture();
    const available = await entry({ ...data, ordinal: 0 });
    await db.update(profiles)
      .set({ avatarRef: { kind: "uploaded", blobId: `missing-${randomUUID()}` } })
      .where(eq(profiles.id, data.profileId));
    const app = appFor(data.userId, data.agentId);
    try {
      const current = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library/current" });
      expect(current.statusCode).toBe(404);
      expect(responseJson<{ error: { code: string } }>(current).error.code).toBe("photo_not_found");

      const recent = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library" });
      expect(recent.statusCode).toBe(200);
      const recentEntries = responseJson<{
        entries: Array<{ id: string; isCurrent: boolean }>;
      }>(recent).entries;
      expect(recentEntries.map(({ id, isCurrent }) => ({ id, isCurrent }))).toEqual([
        { id: available.id, isCurrent: false },
      ]);

      const deleted = await app.inject({
        method: "GET",
        url: "/api/profile/agent-photo-library?projection=deleted",
      });
      expect(deleted.statusCode).toBe(200);
      expect(responseJson<{ entries: unknown[] }>(deleted).entries).toEqual([]);

      const presets = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library/presets" });
      expect(presets.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }, 20_000);

  test("shows only recoverable deleted rows", async () => {
    const data = await fixture();
    const recoverable = await entry({ ...data, ordinal: 0, deleted: true });
    const expired = await entry({ ...data, ordinal: 1, deleted: true });
    const claimed = await entry({ ...data, ordinal: 2, deleted: true });
    await db.update(ownedPhotoEntries).set({ purgeAfter: new Date(nowMs - 1) }).where(eq(ownedPhotoEntries.id, expired.id));
    await db.update(ownedPhotoEntries).set({ gcClaimedAt: new Date(nowMs), gcClaimToken: randomUUID() }).where(eq(ownedPhotoEntries.id, claimed.id));
    const app = appFor(data.userId, data.agentId);
    try {
      const response = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library?projection=deleted" });
      expect(response.statusCode).toBe(200);
      expect(responseJson<{ entries: Array<{ id: string }> }>(response).entries.map((item) => item.id)).toEqual([recoverable.id]);
      const recoverableThumb = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library/entries/${recoverable.id}/media?size=thumb` });
      expect(recoverableThumb.statusCode).toBe(200);
      const recoverableFull = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library/entries/${recoverable.id}/media?size=full` });
      expect(recoverableFull.statusCode).toBe(410);
      expect(responseJson<{ error: { code: string } }>(recoverableFull).error.code).toBe("photo_deleted");
      for (const denied of [expired, claimed]) {
        const deniedThumb = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library/entries/${denied.id}/media?size=thumb` });
        expect(deniedThumb.statusCode).toBe(410);
        expect(responseJson<{ error: { code: string } }>(deniedThumb).error.code).toBe("photo_deleted");
      }
    } finally {
      await app.close();
    }
  }, 20_000);

  test("preserves PostgreSQL microsecond cursor boundaries without skipping a same-millisecond row", async () => {
    const data = await fixture();
    const lower = randomUUID();
    const higher = randomUUID();
    for (const [id, createdAt] of [[lower, "2030-01-02T03:04:05.123456Z"], [higher, "2030-01-02T03:04:05.123789Z"]] as const) {
      await db.execute(sql`
        insert into ${ownedPhotoEntries} (
          id, server_instance_id, owner_user_id, subject_kind, agent_id, avatar_kind,
          blob_id, source, origin, operation_id, request_fingerprint,
          media_mime_type, media_byte_size, media_sha256, created_at
        ) values (
          ${id}, ${serverInstanceId}, ${data.userId}, 'agent', ${data.agentId}, 'uploaded',
          ${`d487-read-${randomUUID()}`}, 'upload', 'mobile', ${randomUUID()}, ${"a".repeat(64)},
          'image/png', 12, ${"b".repeat(64)}, ${createdAt}::timestamptz
        )
      `);
    }
    const app = appFor(data.userId, data.agentId);
    try {
      const first = await app.inject({ method: "GET", url: "/api/profile/agent-photo-library?limit=1" });
      const firstBody = responseJson<{ entries: Array<{ id: string }>; nextCursor: string }>(first);
      expect(firstBody.entries.map((item) => item.id)).toEqual([higher]);
      const next = await app.inject({ method: "GET", url: `/api/profile/agent-photo-library?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}` });
      expect(responseJson<{ entries: Array<{ id: string }> }>(next).entries.map((item) => item.id)).toEqual([lower]);
    } finally {
      await app.close();
    }
  }, 20_000);

  test("reserves and produces a complete 1-4 generated batch with stable ordinals", async () => {
    const data = await fixture();
    const produced = [0, 1, 2, 3].map((ordinal) => Buffer.from(`photo-${ordinal}`));
    let received:
      | {
          slotCount: number;
          semantics: readonly { batchOrdinal?: number }[];
          candidates: readonly { kind: string; bytes: Buffer }[];
        }
      | undefined;
    const app = appFor(data.userId, data.agentId, {
      routeDeps: {
        createCoordinator: {
          produceStageAndFinalize: async (input) => {
            if (input.semantics[0]?.prompt === "capacity") {
              throw new AgentPhotoLibraryError({
                code: "library_capacity_reached",
                message: "The Agent photo library is full",
                retryable: false,
              });
            }
            const candidates = await input.produceCandidates({
              operationId: input.operationId,
              leaseToken: randomUUID(),
              expiresAt: new Date(nowMs + 60_000),
              signal: new AbortController().signal,
            });
            received = {
              slotCount: input.slotCount,
              semantics: input.semantics,
              candidates,
            };
            return {
              operation: "create" as const,
              entryIds: produced.map(() => randomUUID()),
              entries: produced.map((_bytes, ordinal) => ({
                id: randomUUID(),
                source: "generation",
                origin: "mobile",
                createdAt: new Date(nowMs + ordinal).toISOString(),
                media: { thumbnailUrl: `/thumb-${ordinal}`, fullUrl: `/full-${ordinal}` },
              })),
              scope: {
                serverInstanceId,
                viewerUserId: data.userId,
                agentId: data.agentId,
                selectionRevision: "0",
                libraryRevision: "4",
              },
            };
          },
        },
        getDefaultImageModel: () => ({
          id: "openai:test-image",
          apiModel: "test-image",
          displayName: "Test image",
          provider: "openai",
          enabled: true,
        }),
        resolveProviderKey: () => "test-key",
        composeAvatarPrompt: (prompt) => `policy:${prompt}`,
        generateImages: async (args) => ({
          bytes: produced,
          model: args.model,
          mime: "image/png",
        }),
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/profile/agent-photo-library/generate",
        headers: {
          "idempotency-key": randomUUID(),
          "x-agent-photo-origin": "mobile",
        },
        payload: { prompt: "warm", count: 4 },
      });
      expect(response.statusCode).toBe(201);
      expect(received?.slotCount).toBe(4);
      expect(received?.semantics.map((item) => item.batchOrdinal)).toEqual([0, 1, 2, 3]);
      expect(received?.candidates.map((item) => item.bytes.toString())).toEqual([
        "photo-0",
        "photo-1",
        "photo-2",
        "photo-3",
      ]);

      for (const count of [0, 5, 1.5, "4"] as const) {
        const invalid = await app.inject({
          method: "POST",
          url: "/api/profile/agent-photo-library/generate",
          headers: { "idempotency-key": randomUUID() },
          payload: { prompt: "warm", count },
        });
        expect(invalid.statusCode).toBe(400);
        expect(responseJson<{ error: { code: string } }>(invalid).error.code).toBe("invalid_photo_request");
      }

      const capacity = await app.inject({
        method: "POST",
        url: "/api/profile/agent-photo-library/generate",
        headers: { "idempotency-key": randomUUID() },
        payload: { prompt: "capacity", count: 1 },
      });
      expect(capacity.statusCode).toBe(409);
      expect(responseJson<{ error: { code: string } }>(capacity).error.code).toBe("library_capacity_reached");
    } finally {
      await app.close();
    }
  }, 20_000);

  test("binds real normalized upload facts before it hands bytes to the coordinator", async () => {
    const data = await fixture();
    const source = await sharp({ create: { width: 640, height: 320, channels: 4, background: "#7c3aed" } })
      .jpeg()
      .toBuffer();
    let received: {
      media: { mimeType: string; byteSize: number; sha256: string };
      bytes: Buffer;
    } | undefined;
    const app = appFor(data.userId, data.agentId, {
      routeDeps: {
        createCoordinator: {
          produceStageAndFinalize: async (input) => {
            const [candidate] = await input.produceCandidates({
              operationId: input.operationId,
              leaseToken: randomUUID(),
              expiresAt: new Date(nowMs + 60_000),
              signal: new AbortController().signal,
            });
            const media = input.semantics[0]?.media;
            if (!candidate || !media) throw new Error("expected normalized uploaded candidate and media facts");
            received = { media, bytes: candidate.bytes };
            return {
              operation: "create" as const,
              entryIds: [randomUUID()],
              entries: [{
                id: randomUUID(), source: "upload", origin: "mobile", createdAt: new Date(nowMs).toISOString(),
                media: { thumbnailUrl: "/thumb", fullUrl: "/full" },
              }],
              scope: { serverInstanceId, viewerUserId: data.userId, agentId: data.agentId, selectionRevision: "0", libraryRevision: "1" },
            };
          },
        },
      },
    });
    const boundary = `----nautilo-${randomUUID()}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="avatar.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      source,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/profile/agent-photo-library/upload",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "idempotency-key": randomUUID(),
          "x-agent-photo-origin": "mobile",
        },
        payload: body,
      });
      expect(response.statusCode).toBe(201);
      if (!received) throw new Error("upload did not reach the coordinator");
      expect(received.media).toEqual({
        mimeType: "image/png",
        byteSize: received.bytes.length,
        sha256: createHash("sha256").update(received.bytes).digest("hex"),
      });
      expect(await sharp(received.bytes).metadata()).toMatchObject({ format: "png", width: 256, height: 256 });
    } finally {
      await app.close();
    }
  }, 20_000);

  test("holds the active row through bounded media reading so a lifecycle update cannot race it", async () => {
    const data = await fixture();
    const active = await entry({ ...data, ordinal: 0 });
    const service = new AgentPhotoLibraryReadService({ db, blobExists: () => true });
    let signalRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const unblockRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const read = service.media({
      serverInstanceId,
      viewerUserId: data.userId,
      ownerUserId: data.userId,
      agentId: data.agentId,
    }, active.id, "full", async () => {
      signalRead();
      await unblockRead;
      return "bounded bytes";
    });
    await readStarted;
    let writerFinished = false;
    const writer = db.update(ownedPhotoEntries)
      .set({
        deletedAt: new Date(),
        purgeAfter: new Date(nowMs + 86_400_000),
        gcClaimedAt: new Date(),
        gcClaimToken: randomUUID(),
      })
      .where(eq(ownedPhotoEntries.id, active.id))
      .then(() => { writerFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writerFinished).toBe(false);
    releaseRead();
    await read;
    await writer;
    expect(writerFinished).toBe(true);
  }, 20_000);
});
