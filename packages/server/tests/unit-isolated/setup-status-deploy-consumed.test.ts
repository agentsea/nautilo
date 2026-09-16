/**
 * M091 Phase 3 — `deployConfigConsumedAt` on GET `/api/setup/status`.
 *
 * Stubs DB + direct-db reads so the route stays hermetic; exercises real
 * `readDeployConfigConsumedAt(resolveNautiloRootDir())` wiring.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

const realDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...realDb,
  hasUnredeemedClaimInvite: async () => false,
  // D219 — route now calls hasClaimedOwner; keep hasAdminUser alias mocked too.
  hasClaimedOwner: async () => true,
  hasAdminUser: async () => true,
}));

const realAgent = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  getProfile: async () => ({ onboardingCompleted: false }),
}));

mock.module("../../src/lib/server-direct-db.ts", () => ({
  getServerDirectDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ serverRole: "admin", name: "user", handle: "user" }],
        }),
      }),
    }),
  }),
}));

import {
  __resetResolvedInstanceForTests,
  deriveComposeContainerBundle,
  InstanceJsonSchema,
} from "@nautilo/config";
import { __setPinProviderForTests, setupStatusRoutes } from "../../src/routes/setup-status";

const tmpDirs: string[] = [];

function clearTmp(): void {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
}

function minimalInstanceJson(deploy?: string) {
  const projectName = "nautilo-m091-status";
  return InstanceJsonSchema.parse({
    schemaVersion: 1,
    instanceId: "",
    server: { host: "localhost", port: 3001, url: "http://localhost:3001" },
    workbench: { port: 3002, url: "http://localhost:3002" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:5434/nautilo",
      neonProxyPort: 5433,
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5435, corePort: 3003, adminPort: 3004 },
    compose: {
      projectName,
      containers: deriveComposeContainerBundle(projectName),
    },
    hostname: {
      federated: "nautilo.local",
      mdns: "nautilo.local",
      tlsSan: "nautilo.local",
      caddyAuthHost: "auth.nautilo.local",
      caddyAuthAdminHost: "auth-admin.nautilo.local",
    },
    deploymentMode: "local-self-host",
    ...(deploy !== undefined ? { deployConfigConsumedAt: deploy } : {}),
  });
}

describe("GET /api/setup/status deployConfigConsumedAt (M091)", () => {
  let home: string;
  let root: string;
  const prevHome = process.env["HOME"];
  const prevInstance = process.env["NAUTILO_INSTANCE_ID"];
  const prevOpenai = process.env["OPENAI_API_KEY"];
  const prevPublicBaseUrl = process.env["NAUTILO_PUBLIC_BASE_URL"];
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    clearTmp();
    __resetResolvedInstanceForTests();
    home = mkdtempSync(join(tmpdir(), "nautilo-ss-m091-"));
    tmpDirs.push(home);
    root = join(home, ".nautilo");
    mkdirSync(root, { recursive: true });
    process.env["HOME"] = home;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    delete process.env["NAUTILO_PUBLIC_BASE_URL"];
    process.env["OPENAI_API_KEY"] = "sk-proj-123456789012345678901234";
    __setPinProviderForTests({
      isEnrolled: async () => false,
    } as never);
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
    __resetResolvedInstanceForTests();
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    if (prevInstance !== undefined) process.env["NAUTILO_INSTANCE_ID"] = prevInstance;
    else delete process.env["NAUTILO_INSTANCE_ID"];
    if (prevOpenai !== undefined) process.env["OPENAI_API_KEY"] = prevOpenai;
    else delete process.env["OPENAI_API_KEY"];
    if (prevPublicBaseUrl !== undefined) process.env["NAUTILO_PUBLIC_BASE_URL"] = prevPublicBaseUrl;
    else delete process.env["NAUTILO_PUBLIC_BASE_URL"];
    __setPinProviderForTests(undefined);
    clearTmp();
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      const mode = request.headers["x-test-session"];
      request.sessionUserId =
        mode === "user" ? "11111111-1111-4111-8111-111111111111" : null;
    });
    setupStatusRoutes(app);
    await app.ready();
    apps.push(app);
    return app;
  }

  test("guest and sessioned callers see the same deployConfigConsumedAt (null when absent)", async () => {
    writeFileSync(join(root, "instance.json"), `${JSON.stringify(minimalInstanceJson())}\n`, "utf8");
    __resetResolvedInstanceForTests();

    const app = await makeApp();
    const guest = await app.inject({
      method: "GET",
      url: "/api/setup/status",
    });
    const user = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { "x-test-session": "user" },
    });
    const g = JSON.parse(guest.body) as { deployConfigConsumedAt?: string | null };
    const u = JSON.parse(user.body) as { deployConfigConsumedAt?: string | null };
    expect(guest.statusCode).toBe(200);
    expect(user.statusCode).toBe(200);
    expect(g.deployConfigConsumedAt).toBe(null);
    expect(u.deployConfigConsumedAt).toBe(null);
    expect(g.deployConfigConsumedAt).toBe(u.deployConfigConsumedAt);
  });

  test("surfaces literal ISO string when instance.json is stamped", async () => {
    const iso = "2026-05-13T18:00:00.000Z";
    writeFileSync(
      join(root, "instance.json"),
      `${JSON.stringify(minimalInstanceJson(iso))}\n`,
      "utf8",
    );
    __resetResolvedInstanceForTests();

    const app = await makeApp();
    const guest = await app.inject({ method: "GET", url: "/api/setup/status" });
    const user = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { "x-test-session": "user" },
    });
    const g = JSON.parse(guest.body) as { deployConfigConsumedAt?: string | null };
    const u = JSON.parse(user.body) as { deployConfigConsumedAt?: string | null };
    expect(guest.statusCode).toBe(200);
    expect(user.statusCode).toBe(200);
    expect(g.deployConfigConsumedAt).toBe(iso);
    expect(u.deployConfigConsumedAt).toBe(iso);
  });

  test("public base URL drives serverUrl and recommended setup surfaces", async () => {
    writeFileSync(join(root, "instance.json"), `${JSON.stringify(minimalInstanceJson())}\n`, "utf8");
    process.env["NAUTILO_PUBLIC_BASE_URL"] = "https://nautilo.example.test/";
    __resetResolvedInstanceForTests();

    const app = await makeApp();
    const guest = await app.inject({ method: "GET", url: "/api/setup/status" });
    const body = JSON.parse(guest.body) as {
      serverUrl?: string;
      recommendedSetupSurface?: { kind: string; url: string | null };
    };

    expect(guest.statusCode).toBe(200);
    expect(body.serverUrl).toBe("https://nautilo.example.test");
    expect(body.recommendedSetupSurface).toEqual({
      kind: "workbench-admin",
      url: "https://nautilo.example.test",
    });
  });
});
