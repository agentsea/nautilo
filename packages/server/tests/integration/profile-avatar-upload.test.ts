import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import sharp from "sharp";
import { resolveNautiloRootDir } from "@nautilo/config";
import {
  actors,
  agents,
  createDirectDb,
  db,
  ensureDatabase,
  eq,
  profiles,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { profileAvatarRoutes } from "../../src/routes/profile-avatar";

// `11111111-...` is the shared "fixture user" UUID used by ~6 other test
// files in this directory (chat-route-http, ws-publisher, rooms-routes,
// sessions-guest-leak, setup-status-deploy-consumed, plus this one).
// Sharing it intentionally — it's the test-cruft fixture commons, prepped
// once and reused across files. Bun runs test files in parallel but each
// test FILE's beforeAll/afterEach is sequential within itself, and the
// `id`-keyed UPDATEs we do don't conflict cross-file because each file
// resets state in its own afterEach. (Earlier I changed this UUID to a
// D207-private one, which broke the test because some shared seed row
// the unit-runner expects didn't get re-inserted.)
const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
// M132 — the agent-avatar route resolves the subject's personal agent
// (actors mirror) and the profile is agent-keyed. Stable fixture UUID.
const TEST_AGENT_ID = "11111111-2222-4111-8111-111111111111";
const uploadedDir = join(resolveNautiloRootDir(), "profile-avatars", "uploaded");
const generatedDir = join(resolveNautiloRootDir(), "profile-avatars", "generated");

const AGENT_AVATAR_PRESET = { kind: "preset" as const, id: "shell" };

let poolDb: ReturnType<typeof createDirectDb>;

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  poolDb = createDirectDb(1);
  await poolDb.delete(profiles).where(eq(profiles.userId, TEST_USER_ID));
  await poolDb.delete(actors).where(eq(actors.agentId, TEST_AGENT_ID));
  await poolDb.delete(agents).where(eq(agents.id, TEST_AGENT_ID));
  await poolDb.delete(users).where(eq(users.id, TEST_USER_ID));
  await poolDb.insert(users).values({
    id: TEST_USER_ID,
    name: "D208 avatar upload unit",
    email: "d208-avatar-upload@test.local",
    handle: "d208avatar",
  });
  // M132 — personal agent + actors mirror so the agent-avatar route can
  // resolve the subject's agent, and the agent-keyed profile FK is valid.
  await poolDb.insert(agents).values({
    id: TEST_AGENT_ID,
    handle: "d208avatar-agent",
  }).onConflictDoNothing();
  await poolDb.insert(actors).values({
    ownerId: TEST_USER_ID,
    displayName: "Jeannie actor",
    kind: "agent",
    agentId: TEST_AGENT_ID,
  });
  await poolDb.insert(profiles).values({
    userId: TEST_USER_ID,
    agentId: TEST_AGENT_ID,
    name: "Jeannie",
    avatarRef: AGENT_AVATAR_PRESET,
  });
});

afterAll(async () => {
  await poolDb.delete(profiles).where(eq(profiles.userId, TEST_USER_ID));
  await poolDb.delete(actors).where(eq(actors.agentId, TEST_AGENT_ID));
  await poolDb.delete(agents).where(eq(agents.id, TEST_AGENT_ID));
  await poolDb.delete(users).where(eq(users.id, TEST_USER_ID));
  await poolDb.end();
});

function makeUploadApp(sessionUserId: string | null = TEST_USER_ID) {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.register(multipart);
  profileAvatarRoutes(app, { ownerId: TEST_USER_ID });
  app.addHook("preHandler", async (request) => {
    (request as { sessionUserId?: string | null }).sessionUserId = sessionUserId;
  });
  return app;
}

async function postAvatar(
  app: Awaited<ReturnType<typeof makeUploadApp>>,
  bytes: Buffer | Uint8Array,
  mime: string,
  url = "/api/profile/avatar",
) {
  const fd = new FormData();
  fd.set("file", new Blob([bytes], { type: mime }), "avatar.bin");
  return app.inject({
    method: "POST",
    url,
    payload: fd,
  });
}

async function readHumanAvatarRef() {
  const [row] = await db
    .select({ humanAvatarRef: users.humanAvatarRef })
    .from(users)
    .where(eq(users.id, TEST_USER_ID))
    .limit(1);
  return row?.humanAvatarRef ?? null;
}

async function readProfileAvatarRef() {
  const [row] = await db
    .select({ avatarRef: profiles.avatarRef })
    .from(profiles)
    .where(eq(profiles.userId, TEST_USER_ID))
    .limit(1);
  return row?.avatarRef ?? null;
}

describe("POST /api/profile/avatar upload", () => {
  const instances: Awaited<ReturnType<typeof makeUploadApp>>[] = [];
  const writtenBlobIds: string[] = [];

  afterEach(async () => {
    await poolDb
      .update(users)
      .set({ humanAvatarRef: null })
      .where(eq(users.id, TEST_USER_ID));
    await poolDb
      .update(profiles)
      .set({ avatarRef: AGENT_AVATAR_PRESET })
      .where(eq(profiles.userId, TEST_USER_ID));
    for (const blobId of writtenBlobIds.splice(0)) {
      const path = join(uploadedDir, `${blobId}.png`);
      if (existsSync(path)) unlinkSync(path);
    }
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  // Post-write reads use neon-http `db` to match the production handler write path.
  test("happy path — valid 512×512 PNG is re-encoded and persisted", async () => {
    const input = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: { r: 220, g: 40, b: 40 },
      },
    })
      .png()
      .toBuffer();

    const app = makeUploadApp();
    instances.push(app);

    const res = await postAvatar(app, input, "image/png");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { avatar?: { kind?: string; blobId?: string } };
    expect(body.avatar?.kind).toBe("uploaded");
    expect(typeof body.avatar?.blobId).toBe("string");
    writtenBlobIds.push(body.avatar!.blobId!);

    const outPath = join(uploadedDir, `${body.avatar!.blobId}.png`);
    expect(existsSync(outPath)).toBe(true);

    const output = readFileSync(outPath);
    expect(Buffer.compare(output, input)).not.toBe(0);

    const meta = await sharp(output).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
    expect(meta.format).toBe("png");

    expect(await readHumanAvatarRef()).toEqual({
      kind: "uploaded",
      blobId: body.avatar!.blobId,
    });
  });

  // Post-write reads use neon-http `db` to match the production handler write path.
  test("regression — POST does NOT mutate profiles.avatar_ref", async () => {
    await poolDb
      .update(profiles)
      .set({ avatarRef: AGENT_AVATAR_PRESET })
      .where(eq(profiles.userId, TEST_USER_ID));

    const input = await sharp({
      create: {
        width: 128,
        height: 128,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();

    const app = makeUploadApp();
    instances.push(app);

    expect(await readProfileAvatarRef()).toEqual(AGENT_AVATAR_PRESET);

    const res = await postAvatar(app, input, "image/png");
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { avatar?: { blobId?: string } };
    writtenBlobIds.push(body.avatar!.blobId!);

    expect(await readProfileAvatarRef()).toEqual(AGENT_AVATAR_PRESET);
    expect(await readHumanAvatarRef()).toEqual({
      kind: "uploaded",
      blobId: body.avatar!.blobId,
    });
  });

  test("wrong mime — image/gif returns unsupported_mime", async () => {
    const gifBytes = Buffer.from("GIF89a", "ascii");
    const app = makeUploadApp();
    instances.push(app);

    const res = await postAvatar(app, gifBytes, "image/gif");

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "unsupported_mime" });
  });

  test("too big — 6 MB payload returns too_large", async () => {
    const oversized = Buffer.alloc(6 * 1024 * 1024, 1);
    const app = makeUploadApp();
    instances.push(app);

    const res = await postAvatar(app, oversized, "image/png");

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "too_large" });
  });

  test("bad decode — text bytes labeled image/png returns decode_failed", async () => {
    const app = makeUploadApp();
    instances.push(app);

    const res = await postAvatar(app, Buffer.from("definitely-not-a-png", "utf8"), "image/png");

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "decode_failed" });
  });

  test("oversized dimensions — 9000×9000 PNG returns dimensions_too_large", async () => {
    // The dimension gate is set to 8192 px (defense-in-depth against
    // decompression bombs). Real phone photos sit well below that, so we
    // need a synthetic >8K image to trigger the gate.
    const huge = await sharp({
      create: {
        width: 9000,
        height: 9000,
        channels: 3,
        background: { r: 10, g: 10, b: 200 },
      },
    })
      .png()
      .toBuffer();

    const app = makeUploadApp();
    instances.push(app);

    const res = await postAvatar(app, huge, "image/png");

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "dimensions_too_large" });
  });

  /**
   * D243 — read-path variant selector + lazy backfill. Builds on the same
   * `makeUploadApp` harness; the GET path needs `policyContext.actorRole`
   * set to "owner" so `resolveVisibleAvatar` returns the seeded generated
   * blob instead of falling through to the SHELL fallback used by guests.
   */
  function makeOwnerReadApp() {
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    app.decorateRequest("policyContext", null);
    app.register(multipart);
    profileAvatarRoutes(app, { ownerId: TEST_USER_ID });
    app.addHook("preHandler", async (request) => {
      (request as { sessionUserId?: string | null }).sessionUserId = TEST_USER_ID;
      (request as { policyContext?: { actorRole: string } }).policyContext = {
        actorRole: "owner",
      };
    });
    return app;
  }

  async function seedGeneratedAvatarOnDisk(width = 1024, height = 1024): Promise<string> {
    mkdirSync(generatedDir, { recursive: true });
    const blobId = `d243-test-${randomUUID()}`;
    const original = await sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 50, b: 150 } },
    })
      .png()
      .toBuffer();
    writeFileSync(join(generatedDir, `${blobId}.png`), original);
    return blobId;
  }

  function cleanupGeneratedBlob(blobId: string): void {
    const original = join(generatedDir, `${blobId}.png`);
    const thumbWebp = join(generatedDir, `${blobId}.thumb.webp`);
    const thumbPng = join(generatedDir, `${blobId}.thumb.png`); // legacy pre-Phase-5
    if (existsSync(original)) unlinkSync(original);
    if (existsSync(thumbWebp)) unlinkSync(thumbWebp);
    if (existsSync(thumbPng)) unlinkSync(thumbPng);
  }

  test("D243 — GET /api/profile/avatar returns the thumbnail by default for generated avatars", async () => {
    const blobId = await seedGeneratedAvatarOnDisk();
    // Pre-derive the thumb so this test isolates the variant-selector
    // contract from the lazy-backfill contract (covered by the next test).
    // D243 Phase 5 — derivative is WebP.
    const thumbBytes = await sharp(join(generatedDir, `${blobId}.png`))
      .resize(256, 256, { fit: "cover", position: "center" })
      .webp({ quality: 82 })
      .toBuffer();
    writeFileSync(join(generatedDir, `${blobId}.thumb.webp`), thumbBytes);

    await poolDb
      .update(profiles)
      .set({ avatarRef: { kind: "generated", blobId } })
      .where(eq(profiles.userId, TEST_USER_ID));

    const app = makeOwnerReadApp();
    instances.push(app);

    try {
      const res = await app.inject({ method: "GET", url: "/api/profile/avatar" });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/webp");
      expect(res.headers["etag"]).toBe(`"${blobId}.thumb"`);

      const body = Buffer.from(res.rawPayload);
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(256);
      expect(meta.height).toBe(256);
      // Bytes match the thumb on disk, not the 1024² original.
      expect(Buffer.compare(body, thumbBytes)).toBe(0);
    } finally {
      cleanupGeneratedBlob(blobId);
    }
  });

  test("D243 — GET /api/profile/avatar?size=full returns the 1024² original (cherished source)", async () => {
    const blobId = await seedGeneratedAvatarOnDisk();
    const originalBytes = readFileSync(join(generatedDir, `${blobId}.png`));

    await poolDb
      .update(profiles)
      .set({ avatarRef: { kind: "generated", blobId } })
      .where(eq(profiles.userId, TEST_USER_ID));

    const app = makeOwnerReadApp();
    instances.push(app);

    try {
      const res = await app.inject({ method: "GET", url: "/api/profile/avatar?size=full" });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.headers["etag"]).toBe(`"${blobId}.full"`);

      const body = Buffer.from(res.rawPayload);
      const meta = await sharp(body).metadata();
      expect(meta.width).toBe(1024);
      expect(meta.height).toBe(1024);
      expect(Buffer.compare(body, originalBytes)).toBe(0);
    } finally {
      cleanupGeneratedBlob(blobId);
    }
  });

  test("D243 — legacy generated avatar (no thumb on disk) is lazy-backfilled on first read", async () => {
    // Seed only the original — simulates a pre-Stack-42 generated avatar
    // landing on a freshly-upgraded server.
    const blobId = await seedGeneratedAvatarOnDisk();
    const thumbPath = join(generatedDir, `${blobId}.thumb.webp`);
    expect(existsSync(thumbPath)).toBe(false);

    await poolDb
      .update(profiles)
      .set({ avatarRef: { kind: "generated", blobId } })
      .where(eq(profiles.userId, TEST_USER_ID));

    const app = makeOwnerReadApp();
    instances.push(app);

    try {
      const res = await app.inject({ method: "GET", url: "/api/profile/avatar" });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/webp");
      expect(res.headers["etag"]).toBe(`"${blobId}.thumb"`);

      // Thumb now exists on disk for all subsequent reads to serve directly.
      expect(existsSync(thumbPath)).toBe(true);
      const persistedThumb = readFileSync(thumbPath);
      const meta = await sharp(persistedThumb).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(256);
      expect(meta.height).toBe(256);

      // Body returned to the client equals the freshly-derived thumb.
      const body = Buffer.from(res.rawPayload);
      expect(Buffer.compare(body, persistedThumb)).toBe(0);
    } finally {
      cleanupGeneratedBlob(blobId);
    }
  });

  test("D243 — uploaded avatars ignore ?size=full because they have no full variant on disk", async () => {
    // Upload happens through the existing path; resulting file is 256² already.
    const input = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 30, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();

    const uploadApp = makeUploadApp();
    instances.push(uploadApp);
    const postRes = await postAvatar(uploadApp, input, "image/png");
    expect(postRes.statusCode).toBe(200);
    const postBody = JSON.parse(postRes.body) as { avatar?: { blobId?: string } };
    const blobId = postBody.avatar!.blobId!;
    writtenBlobIds.push(blobId);

    // Make this user's agent avatar point at the uploaded blob so the GET
    // route can resolve it via profile.avatarRef.
    await poolDb
      .update(profiles)
      .set({ avatarRef: { kind: "uploaded", blobId } })
      .where(eq(profiles.userId, TEST_USER_ID));

    const readApp = makeOwnerReadApp();
    instances.push(readApp);

    const defaultRes = await readApp.inject({ method: "GET", url: "/api/profile/avatar" });
    const fullRes = await readApp.inject({ method: "GET", url: "/api/profile/avatar?size=full" });

    expect(defaultRes.statusCode).toBe(200);
    expect(fullRes.statusCode).toBe(200);
    // Both responses serve the same single uploaded file. ETag carries
    // `.full` because the variant selector collapses to the original for
    // `kind: "uploaded"`.
    expect(defaultRes.headers["etag"]).toBe(`"${blobId}.full"`);
    expect(fullRes.headers["etag"]).toBe(`"${blobId}.full"`);
    expect(Buffer.compare(Buffer.from(defaultRes.rawPayload), Buffer.from(fullRes.rawPayload))).toBe(0);
  });

  test("EXIF stripped — JPEG with orientation metadata yields PNG without EXIF", async () => {
    const input = await sharp({
      create: {
        width: 400,
        height: 200,
        channels: 3,
        background: { r: 90, g: 180, b: 90 },
      },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const inputMeta = await sharp(input).metadata();
    expect(inputMeta.orientation).toBe(6);

    const app = makeUploadApp();
    instances.push(app);

    const res = await postAvatar(app, input, "image/jpeg");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { avatar?: { blobId?: string } };
    writtenBlobIds.push(body.avatar!.blobId!);

    const outPath = join(uploadedDir, `${body.avatar!.blobId}.png`);
    const outMeta = await sharp(readFileSync(outPath)).metadata();
    expect(outMeta.exif).toBeUndefined();
    expect(outMeta.orientation).toBeUndefined();
    expect(outMeta.format).toBe("png");
  });
});
