import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import {
  createDirectDb,
  deriveDefaultServerName,
  ensureDatabase,
  eq,
  materializeDefaultServerProfileOnce,
  serverProfile,
  upsertServerProfile,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { SERVER_ICON_PRESET_IDS } from "@nautilo/types";
import { resolvePublicServerUrl } from "../../src/lib/public-urls";

const getUserCapabilitiesMock = mock(
  async (_userId: string): Promise<string[]> => ["manage_server_operations"],
);
const getProfileMock = mock(async () => ({ onboardingCompleted: false }));

const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: getUserCapabilitiesMock,
}));

const actualAgent = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...actualAgent,
  getProfile: getProfileMock,
}));

import {
  __setPinProviderForTests,
  setupStatusRoutes,
} from "../../src/routes/setup-status";
import { serverIconRoutes } from "../../src/routes/server-icon";
import { serverProfileRoutes } from "../../src/routes/server-profile";

const ADMIN_USER_ID = "22222222-1111-4111-8111-111111111111";
const MEMBER_USER_ID = "22222222-2222-4111-8111-111111111111";
const serverIconBlobDir = join(resolveNautiloRootDir(), "server-icon");
const writtenBlobIds: string[] = [];

let poolDb: ReturnType<typeof createDirectDb>;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  __setPinProviderForTests({ isEnrolled: async () => false } as never);
  await ensureDatabase();
  poolDb = createDirectDb(1);
});

afterAll(async () => {
  __setPinProviderForTests(undefined);
  await poolDb.delete(serverProfile).where(eq(serverProfile.id, "server"));
  await poolDb.end();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function resetServerProfile(): Promise<void> {
  await poolDb.delete(serverProfile).where(eq(serverProfile.id, "server"));
}

beforeEach(resetServerProfile);

afterEach(async () => {
  getUserCapabilitiesMock.mockImplementation(async () => ["manage_server_operations"]);
  await resetServerProfile();
  for (const blobId of writtenBlobIds.splice(0)) {
    const path = join(serverIconBlobDir, `${blobId}.png`);
    if (existsSync(path)) unlinkSync(path);
  }
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeSetupStatusApp(sessionUserId: string | null = null) {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = sessionUserId;
  });
  setupStatusRoutes(app);
  apps.push(app);
  return app;
}

function makeProfileApp(sessionUserId: string | null) {
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = sessionUserId;
  });
  app.register(multipart);
  serverProfileRoutes(app);
  serverIconRoutes(app);
  apps.push(app);
  return app;
}

async function postIcon(
  app: FastifyInstance,
  bytes: Buffer,
  mime: string,
) {
  const fd = new FormData();
  fd.set("file", new Blob([bytes], { type: mime }), "icon.bin");
  return app.inject({
    method: "POST",
    url: "/api/server/icon",
    payload: fd,
  });
}

describe("GET /api/setup/status serverProfile (D280)", () => {
  test("pre-auth includes name and icon; members-only description omitted", async () => {
    await upsertServerProfile(poolDb, {
      name: "Test Server",
      description: "Secret desc",
      descriptionVisibility: "members",
    });
    await materializeDefaultServerProfileOnce(poolDb, { randomIndex: () => 0 });

    const app = makeSetupStatusApp(null);
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { serverProfile?: Record<string, unknown> };
    expect(body.serverProfile).toEqual({
      name: "Test Server",
      icon: { kind: "preset", id: SERVER_ICON_PRESET_IDS[0] },
    });
    expect(body.serverProfile?.["description"]).toBeUndefined();
  });

  test("pre-auth includes description when visibility is public", async () => {
    await upsertServerProfile(poolDb, {
      name: "Public Server",
      description: "Public desc",
      descriptionVisibility: "public",
    });

    const app = makeSetupStatusApp(null);
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    const body = JSON.parse(res.body) as { serverProfile?: Record<string, unknown> };
    expect(body.serverProfile?.["description"]).toBe("Public desc");
  });

  test("authenticated viewer sees members-only description", async () => {
    await upsertServerProfile(poolDb, {
      name: "Member Server",
      description: "Members desc",
      descriptionVisibility: "members",
    });

    const app = makeSetupStatusApp(ADMIN_USER_ID);
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    const body = JSON.parse(res.body) as {
      serverProfile?: Record<string, unknown>;
      viewer?: Record<string, unknown>;
    };
    expect(body.viewer).toBeDefined();
    expect(body.serverProfile?.["description"]).toBe("Members desc");
  });

  test("unconfigured fallback uses derived default name and brand preset icon", async () => {
    await resetServerProfile();
    await materializeDefaultServerProfileOnce(poolDb, { randomIndex: () => 1 });
    const app = makeSetupStatusApp(null);
    const res = await app.inject({ method: "GET", url: "/api/setup/status" });
    const body = JSON.parse(res.body) as { serverProfile?: Record<string, unknown> };
    const instance = resolveInstance();
    const expectedName = deriveDefaultServerName({
      host: resolvePublicServerUrl(instance),
      instanceId: instance.instanceId,
    });
    expect(body.serverProfile?.["name"]).toBe(expectedName);
    expect(typeof body.serverProfile?.["name"]).toBe("string");
    expect((body.serverProfile?.["name"] as string).length).toBeGreaterThan(0);
    const icon = body.serverProfile?.["icon"] as { kind?: string; id?: string };
    expect(icon.kind).toBe("preset");
    expect(SERVER_ICON_PRESET_IDS.some((id) => id === icon.id)).toBe(true);
  });
});

describe("POST /api/server/profile (D280)", () => {
  test("401 without session", async () => {
    const app = makeProfileApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/server/profile",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(401);
  });

  test("403 for session without manage_server_operations", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => []);
    const app = makeProfileApp(MEMBER_USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/server/profile",
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(403);
  });

  test("200 for session with manage_server_operations", async () => {
    const app = makeProfileApp(ADMIN_USER_ID);
    const res = await app.inject({
      method: "POST",
      url: "/api/server/profile",
      payload: { name: "My Server", description: "Hello", reviewed: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      serverProfile?: { name?: string; description?: string; reviewedAt?: string };
    };
    expect(body.serverProfile?.name).toBe("My Server");
    expect(body.serverProfile?.description).toBe("Hello");
    expect(body.serverProfile?.reviewedAt).toMatch(/^20/);

    const statusApp = makeSetupStatusApp(ADMIN_USER_ID);
    const status = await statusApp.inject({ method: "GET", url: "/api/setup/status" });
    const statusBody = JSON.parse(status.body) as {
      serverProfile?: { reviewedAt?: string | null };
    };
    expect(statusBody.serverProfile?.reviewedAt).toBe(body.serverProfile?.reviewedAt);
  });
});

describe("POST /api/server/icon + GET /api/server/icon (D280)", () => {
  test("401 without session", async () => {
    const app = makeProfileApp(null);
    const input = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const res = await postIcon(app, input, "image/png");
    expect(res.statusCode).toBe(401);
  });

  test("403 for session without manage_server_operations", async () => {
    getUserCapabilitiesMock.mockImplementation(async () => []);
    const app = makeProfileApp(MEMBER_USER_ID);
    const input = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();
    const res = await postIcon(app, input, "image/png");
    expect(res.statusCode).toBe(403);
  });

  test("icon upload round-trips with public cache headers", async () => {
    const input = await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .png()
      .toBuffer();

    const app = makeProfileApp(ADMIN_USER_ID);
    const uploadRes = await postIcon(app, input, "image/png");
    expect(uploadRes.statusCode).toBe(200);
    const uploadBody = JSON.parse(uploadRes.body) as {
      serverProfile?: { icon?: { blobId?: string } };
    };
    const blobId = uploadBody.serverProfile?.icon?.blobId;
    expect(typeof blobId).toBe("string");
    writtenBlobIds.push(blobId!);

    const iconRes = await app.inject({ method: "GET", url: "/api/server/icon" });
    expect(iconRes.statusCode).toBe(200);
    expect(iconRes.headers["cache-control"]).toBe("public, max-age=86400");
    expect(iconRes.headers.etag).toBe(`"${blobId}"`);
    expect(iconRes.headers.vary).toBeUndefined();
    expect(iconRes.headers["cache-control"]?.includes("private")).toBe(false);

    const meta = await sharp(Buffer.from(iconRes.rawPayload)).metadata();
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  test("default preset icon is served with public cache headers", async () => {
    await resetServerProfile();
    await materializeDefaultServerProfileOnce(poolDb, { randomIndex: () => 1 });
    const app = makeProfileApp(ADMIN_USER_ID);
    const iconRes = await app.inject({ method: "GET", url: "/api/server/icon" });
    expect(iconRes.statusCode).toBe(200);
    expect(iconRes.headers["cache-control"]).toBe("public, max-age=86400");
    expect(iconRes.headers.etag).toBe(`"${SERVER_ICON_PRESET_IDS[1]}"`);
    expect(iconRes.headers.vary).toBeUndefined();
  });
});
