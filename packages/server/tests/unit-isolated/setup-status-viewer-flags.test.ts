/**
 * D125 Phase 2 — `/api/setup/status` viewer gating flags.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const pinEnrolledMock = mock(async () => false);

const accountSecurityMock = mock(async () => null as { requiresPasswordChange: boolean } | null);

const realDb = await import("@nautilo/db");
mock.module("@nautilo/db", () => ({
  ...realDb,
  hasUnredeemedClaimInvite: async () => false,
  // D219 — route calls hasClaimedOwner now; keep the hasAdminUser alias too.
  hasClaimedOwner: async () => true,
  hasAdminUser: async () => true,
  getAccountSecurityRowByUserId: accountSecurityMock,
}));

const realAgent = await import("@nautilo/agent");
mock.module("@nautilo/agent", () => ({
  ...realAgent,
  getProfile: async () => ({ onboardingCompleted: false }),
}));

const viewerRowMock = mock(async () => ({
  serverRole: "admin" as const,
  name: "user",
  handle: "user",
}));

mock.module("../../src/lib/server-direct-db.ts", () => ({
  getServerDirectDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [await viewerRowMock()],
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
import {
  __setPinProviderForTests,
  __setSetupStatusCapabilityResolverForTests,
  setupStatusRoutes,
} from "../../src/routes/setup-status";

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

function minimalInstanceJson() {
  const projectName = "nautilo-d125-status";
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
  });
}

describe("GET /api/setup/status viewer flags (D125)", () => {
  let home: string;
  let root: string;
  const prevHome = process.env["HOME"];
  const prevInstance = process.env["NAUTILO_INSTANCE_ID"];
  const prevOpenai = process.env["OPENAI_API_KEY"];
  const prevElevenLabs = process.env["ELEVENLABS_API_KEY"];
  const prevTavily = process.env["TAVILY_API_KEY"];
  const prevCloudConvert = process.env["CLOUDCONVERT_API_KEY"];
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    clearTmp();
    __resetResolvedInstanceForTests();
    pinEnrolledMock.mockReset();
    pinEnrolledMock.mockResolvedValue(false);
    accountSecurityMock.mockReset();
    accountSecurityMock.mockResolvedValue({ requiresPasswordChange: true });
    __setPinProviderForTests({
      isEnrolled: () => pinEnrolledMock(),
    } as never);
    __setSetupStatusCapabilityResolverForTests(async () => [
      "manage_server_settings",
      "invoke_agents",
    ]);
    viewerRowMock.mockReset();
    viewerRowMock.mockResolvedValue({
      serverRole: "admin",
      name: "user",
      handle: "user",
    });

    home = mkdtempSync(join(tmpdir(), "nautilo-d125-status-"));
    tmpDirs.push(home);
    root = join(home, ".nautilo");
    mkdirSync(root, { recursive: true });
    process.env["HOME"] = home;
    delete process.env["NAUTILO_HOME"];
    delete process.env["NAUTILO_INSTANCE_ID"];
    process.env["OPENAI_API_KEY"] = "sk-proj-123456789012345678901234";
    delete process.env["ELEVENLABS_API_KEY"];
    delete process.env["TAVILY_API_KEY"];
    delete process.env["CLOUDCONVERT_API_KEY"];
    writeFileSync(join(root, "instance.json"), `${JSON.stringify(minimalInstanceJson())}\n`, "utf8");
    __resetResolvedInstanceForTests();
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
    if (prevElevenLabs !== undefined) process.env["ELEVENLABS_API_KEY"] = prevElevenLabs;
    else delete process.env["ELEVENLABS_API_KEY"];
    if (prevTavily !== undefined) process.env["TAVILY_API_KEY"] = prevTavily;
    else delete process.env["TAVILY_API_KEY"];
    if (prevCloudConvert !== undefined) process.env["CLOUDCONVERT_API_KEY"] = prevCloudConvert;
    else delete process.env["CLOUDCONVERT_API_KEY"];
    __setPinProviderForTests(undefined);
    __setSetupStatusCapabilityResolverForTests(undefined);
    clearTmp();
  });

  async function makeApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.decorateRequest("sessionUserId", null);
    app.addHook("preHandler", async (request) => {
      const mode = request.headers["x-test-session"];
      request.sessionUserId = mode === "user" ? USER_ID : null;
    });
    setupStatusRoutes(app);
    await app.ready();
    apps.push(app);
    return app;
  }

  test("sessioned viewer payload includes pinEnrolled, handleAutoGenerated, passwordWasTemp", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { "x-test-session": "user" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      viewer?: {
        pinEnrolled: boolean;
        handleAutoGenerated: boolean;
        passwordWasTemp: boolean | null;
        canInvokeAgents: boolean;
      };
    };
    expect(body.viewer).toMatchObject({
      pinEnrolled: false,
      handleAutoGenerated: true,
      passwordWasTemp: true,
      canInvokeAgents: true,
    });
  });

  test("admin provider managers get API-key recovery without owner settings authority", async () => {
    __setSetupStatusCapabilityResolverForTests(async () => ["manage_connection_providers"]);
    const { getAllKeyDefinitions } = await import("@nautilo/config-guard");
    const saved = new Map(getAllKeyDefinitions().map(({ envVar }) => [envVar, process.env[envVar]]));
    try {
      for (const key of saved.keys()) delete process.env[key];
      const res = await (await makeApp()).inject({
        method: "GET", url: "/api/setup/status",
        headers: { "x-test-session": "user" },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({
        setupState: "server-needs-keys",
        viewer: { canManageServerSettings: false },
        recommendedSetupSurface: { kind: "workbench-admin", url: "/admin#provider-credentials" },
        claimInvitePathHint: null,
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("handleAutoGenerated is false when handle diverges from slugified name", async () => {
    viewerRowMock.mockResolvedValue({
      serverRole: "admin",
      name: "user",
      handle: "test-user",
    });
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { "x-test-session": "user" },
    });
    const body = JSON.parse(res.body) as {
      viewer?: { handleAutoGenerated: boolean };
    };
    expect(body.viewer?.handleAutoGenerated).toBe(false);
  });

  test("pinEnrolled reflects PinChallengeProvider.isEnrolled", async () => {
    pinEnrolledMock.mockResolvedValue(true);
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { "x-test-session": "user" },
    });
    const body = JSON.parse(res.body) as { viewer?: { pinEnrolled: boolean } };
    expect(body.viewer?.pinEnrolled).toBe(true);
  });

  test("passwordWasTemp is null when account security row is missing", async () => {
    accountSecurityMock.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { "x-test-session": "user" },
    });
    const body = JSON.parse(res.body) as {
      viewer?: { passwordWasTemp: boolean | null };
    };
    expect(body.viewer?.passwordWasTemp).toBe(null);
  });

  test("projects only redacted secondary-provider capability booleans to an authenticated viewer", async () => {
    const elevenLabsCanary = "sk_d508_elevenlabs_capability_canary";
    const tavilyCanary = "tvly-d508-capability-canary";
    const cloudConvertCanary = `${"a".repeat(70)}.${"b".repeat(70)}.${"c".repeat(70)}`;
    process.env["ELEVENLABS_API_KEY"] = elevenLabsCanary;
    process.env["TAVILY_API_KEY"] = tavilyCanary;
    process.env["CLOUDCONVERT_API_KEY"] = cloudConvertCanary;

    const app = await makeApp();
    const user = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { "x-test-session": "user" },
    });
    const guest = await app.inject({ method: "GET", url: "/api/setup/status" });
    const body = JSON.parse(user.body) as {
      providers?: {
        hasLlm: boolean;
        hasVoice?: boolean;
        hasSearch?: boolean;
        hasConversion?: boolean;
        managedByCloud: boolean;
      };
    };
    const guestBody = JSON.parse(guest.body) as { providers?: unknown };

    expect(user.statusCode).toBe(200);
    expect(body.providers).toEqual({
      hasLlm: true,
      hasVoice: true,
      hasSearch: true,
      hasConversion: true,
      managedByCloud: false,
    });
    expect(user.body).not.toContain(elevenLabsCanary);
    expect(user.body).not.toContain(tavilyCanary);
    expect(user.body).not.toContain(cloudConvertCanary);
    expect(guest.statusCode).toBe(200);
    expect(guestBody.providers).toBeUndefined();
  });
});
