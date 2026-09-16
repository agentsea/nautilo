/**
 * D445 Phase 3 — proportionate route/config integration.
 *
 * Boundary proved here:
 *   remote authenticated admin → production health/setup routes → real
 *   config-guard transaction → atomic temp env write + process reload →
 *   masked summary + real has-LLM transition + redacted audit.
 *
 * Deliberately not repeated:
 *   - setup-state recommendation is covered by setup-status.integration.test.ts
 *     and setup-status-deploy-consumed.test.ts;
 *   - /admin#provider-credentials gate/recovery UI is covered by first-run-gate*.test.tsx
 *     and keys-section-provider-recovery.test.tsx;
 *   - 401/403/loopback/bootstrap cases remain in setup-keys.test.ts and
 *     health-keys-auth.test.ts.
 *
 * The only mocked production dependency is getUserCapabilities. This file is
 * safe from Bun's sticky mock.module behavior because run-integration.sh runs
 * every integration test file in its own subprocess.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  check,
  computeHasLlmFromKeys,
  getAllKeyDefinitions,
  LOGTO_REQUIRED_KEYS,
  resetConfigGuardRateLimitForTests,
} from "@nautilo/config-guard";

const getUserCapabilitiesMock = mock(
  async (_userId: string): Promise<string[]> => ["manage_server_settings"],
);
const actualTrust = await import("@nautilo/trust");
mock.module("@nautilo/trust", () => ({
  ...actualTrust,
  getUserCapabilities: getUserCapabilitiesMock,
}));

const { healthRoutes } = await import("../../src/routes/health");
const { setupRoutes } = await import("../../src/routes/setup");

const ADMIN_USER_ID = "d445-remote-admin";
const REMOTE_ADDRESS = "203.0.113.77";
const SECRET = "sk-proj-d445-route-config-fixture-SENTINEL-9999";

let app: FastifyInstance | undefined;
let tempDir = "";
let envPath = "";
let auditPath = "";
let originalFetch: typeof globalThis.fetch | undefined;
let providerProbeCalls = 0;

const envSnapshot = new Map<string, string | undefined>();
const isolatedEnvKeys = [
  ...new Set([
    ...getAllKeyDefinitions().map((definition) => definition.envVar),
    ...LOGTO_REQUIRED_KEYS,
    "NAUTILO_DOTENV_PATH",
    "NAUTILO_BOOTSTRAP_TOKEN",
    "NAUTILO_HOSTING_MODE",
    "NAUTILO_INSTANCE_ID",
    "HOME",
    "USERPROFILE",
  ]),
];

beforeAll(async () => {
  for (const key of isolatedEnvKeys) envSnapshot.set(key, process.env[key]);

  tempDir = await mkdtemp(join(tmpdir(), "d445-route-config-"));
  envPath = join(tempDir, "instance.env");
  auditPath = join(tempDir, "config-audit.jsonl");
  await writeFile(envPath, "# D445 isolated config authority\n", "utf8");

  // Isolate config authority and any path migrations from the operator home.
  process.env["NAUTILO_DOTENV_PATH"] = envPath;
  process.env["NAUTILO_HOSTING_MODE"] = "local";
  process.env["HOME"] = tempDir;
  delete process.env["USERPROFILE"];
  delete process.env["NAUTILO_INSTANCE_ID"];
  delete process.env["NAUTILO_BOOTSTRAP_TOKEN"];
  for (const key of getAllKeyDefinitions().map((d) => d.envVar)) {
    delete process.env[key];
  }
  // Avoid ambient partial-Logto values tripping config-guard's unrelated
  // all-or-none OIDC invariant.
  for (const key of LOGTO_REQUIRED_KEYS) delete process.env[key];
  resetConfigGuardRateLimitForTests();

  const fetchBeforeStub = globalThis.fetch;
  originalFetch = fetchBeforeStub;
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (new URL(url).host === "api.openai.com") {
      providerProbeCalls += 1;
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${SECRET}`,
      );
      return new Response("{}", { status: 200 });
    }
    return fetchBeforeStub(input, init);
  }) as unknown as typeof globalThis.fetch;

  app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    request.sessionUserId = ADMIN_USER_ID;
  });
  healthRoutes(app);
  setupRoutes(app);
});

afterAll(async () => {
  const errors: unknown[] = [];
  try {
    if (app) await app.close();
  } catch (error) {
    errors.push(error);
  } finally {
    if (originalFetch) globalThis.fetch = originalFetch;
    for (const [key, value] of envSnapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigGuardRateLimitForTests();
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "D445 route/config cleanup failed");
  }
});

function remoteGet(url: string) {
  if (!app) throw new Error("D445 Fastify harness is not initialized");
  return app.inject({ method: "GET", url, remoteAddress: REMOTE_ADDRESS });
}

describe("D445 remote-owner route/config recovery", () => {
  test("persists one remote admin key and exposes only masked state", async () => {
    const realBefore = await check();
    expect(computeHasLlmFromKeys(realBefore.keys)).toBe(false);

    const summaryBefore = await remoteGet("/api/health/keys");
    expect(summaryBefore.statusCode).toBe(200);
    const openaiBefore = (
      JSON.parse(summaryBefore.body) as Array<{
        id: string;
        status: string;
        masked: string | null;
      }>
    ).find((key) => key.id === "openai");
    expect(openaiBefore).toMatchObject({ status: "missing", masked: null });

    if (!app) throw new Error("D445 Fastify harness is not initialized");
    const mutation = await app.inject({
      method: "POST",
      url: "/api/setup/keys",
      remoteAddress: REMOTE_ADDRESS,
      headers: { "content-type": "application/json" },
      payload: {
        keys: { OPENAI_API_KEY: SECRET },
        overwrite: true,
      },
    });
    expect(mutation.statusCode).toBe(200);
    expect(JSON.parse(mutation.body)).toMatchObject({
      success: true,
      applied: 1,
      details: [{ key: "OPENAI_API_KEY", action: "applied" }],
    });
    expect(mutation.body).not.toContain(SECRET);
    expect(providerProbeCalls).toBe(1);
    expect(process.env["OPENAI_API_KEY"]).toBe(SECRET);

    const summaryAfter = await remoteGet("/api/health/keys");
    expect(summaryAfter.statusCode).toBe(200);
    const openaiAfter = (
      JSON.parse(summaryAfter.body) as Array<{
        id: string;
        status: string;
        masked: string | null;
      }>
    ).find((key) => key.id === "openai");
    expect(openaiAfter?.status).toBe("present");
    expect(openaiAfter?.masked).toBeTruthy();
    expect(openaiAfter?.masked).not.toContain(SECRET);
    expect(summaryAfter.body).not.toContain(SECRET);

    const realAfter = await check();
    expect(computeHasLlmFromKeys(realAfter.keys)).toBe(true);

    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain("OPENAI_API_KEY");
    expect(audit).toContain('"result":"applied"');
    expect(audit).not.toContain(SECRET);
    expect((await readdir(join(tempDir, "config-snapshots"))).length).toBeGreaterThan(0);

    expect(getUserCapabilitiesMock).toHaveBeenCalledTimes(3);
    expect(
      getUserCapabilitiesMock.mock.calls.every(
        ([userId]) => userId === ADMIN_USER_ID,
      ),
    ).toBe(true);
  }, 60_000);
});
