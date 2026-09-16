/**
 * M051 + M072: validates the new /health extension and the /api/health/modes
 * sibling. Existing /health contract (status, authRequired, enrolled)
 * must be preserved — today's callers depend on the existing fields.
 * Post-M072: `authMode` is removed; Logto discovery fields are always strings.
 */
import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "../../src/routes/health";

interface HealthResponse {
  status: string;
  authRequired: boolean;
  enrolled: boolean;
  logtoEndpoint: string;
  logtoWorkbenchAppId: string;
  logtoTuiAppId: string;
  logtoTuiLoopbackAppId: string;
  logtoDesktopAppId: string;
  relayPairingContractVersion: number;
  logtoMobileAppId: string;
  logtoMobileWebAppId: string;
  logtoResource: string;
  serverUrl: string;
  workbenchUrl: string;
  passwordRecoveryDriver: string;
  deploymentIdentity: string;
  maintenanceState?: "normal" | "draining" | "applying";
}

const LOGTO_ENV_KEYS = [
  "LOGTO_ENDPOINT",
  "LOGTO_ISSUER",
  "LOGTO_JWKS_URI",
  "LOGTO_RESOURCE",
  "LOGTO_WORKBENCH_APP_ID",
  "LOGTO_TUI_APP_ID",
  "LOGTO_TUI_LOOPBACK_APP_ID",
  "LOGTO_DESKTOP_APP_ID",
  "LOGTO_MOBILE_APP_ID",
  "LOGTO_MOBILE_WEB_APP_ID",
  "LOGTO_M2M_APP_ID",
  "LOGTO_M2M_APP_SECRET",
  "NAUTILO_PUBLIC_BASE_URL",
  "NAUTILO_HOSTING_MODE",
  "NAUTILO_PASSWORD_RECOVERY_DRIVER",
  "NAUTILO_DEPLOYMENT_ID",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of LOGTO_ENV_KEYS) {
    snap[k] = process.env[k];
  }
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of LOGTO_ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function makeHealthApp(deploymentIdentity?: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  healthRoutes(app, { deploymentIdentity });
  await app.ready();
  return app;
}

describe("/health extension (M051)", () => {
  const instances: FastifyInstance[] = [];
  let envSnap: Record<string, string | undefined> = {};

  afterEach(async () => {
    restoreEnv(envSnap);
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  test("preserves existing { status, authRequired, enrolled } contract", async () => {
    envSnap = snapshotEnv();
    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as HealthResponse & Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.authRequired).toBe("boolean");
    expect(typeof body.enrolled).toBe("boolean");
    expect("authMode" in body).toBe(false);
  });

  test("exposes only the immutable image deployment identity", async () => {
    envSnap = snapshotEnv();
    const app = await makeHealthApp("image-contract-hash");
    instances.push(app);

    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;

    expect(body.deploymentIdentity).toBe("image-contract-hash");
  });

  test("exposes the payload-free durable maintenance state when supplied", async () => {
    envSnap = snapshotEnv();
    const app = Fastify({ logger: false });
    healthRoutes(app, { getMaintenanceState: () => "normal" });
    await app.ready();
    instances.push(app);

    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.maintenanceState).toBe("normal");
  });

  test("prefers the immutable image build identity over the auth-contract fallback", async () => {
    envSnap = snapshotEnv();
    process.env["NAUTILO_DEPLOYMENT_ID"] = "sha-immutable-image";
    const app = await makeHealthApp();
    instances.push(app);

    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.deploymentIdentity).toBe("sha-immutable-image");
  });

  test("omits authMode; logto fields are empty strings when env unset", async () => {
    envSnap = snapshotEnv();
    delete process.env["LOGTO_ENDPOINT"];
    delete process.env["LOGTO_WORKBENCH_APP_ID"];
    delete process.env["LOGTO_TUI_APP_ID"];
    delete process.env["LOGTO_TUI_LOOPBACK_APP_ID"];
    delete process.env["LOGTO_RESOURCE"];
    delete process.env["LOGTO_DESKTOP_APP_ID"];
    delete process.env["LOGTO_MOBILE_APP_ID"];
    delete process.env["LOGTO_MOBILE_WEB_APP_ID"];

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse & Record<string, unknown>;
    expect("authMode" in body).toBe(false);
    expect(body.logtoEndpoint).toBe("");
    expect(body.logtoWorkbenchAppId).toBe("");
    expect(body.logtoTuiAppId).toBe("");
    expect(body.logtoTuiLoopbackAppId).toBe("");
    expect(body.logtoDesktopAppId).toBe("");
    expect(body.relayPairingContractVersion).toBe(2);
    expect(body.logtoMobileAppId).toBe("");
    expect(body.logtoMobileWebAppId).toBe("");
    expect(body.logtoResource).toBe("");
    expect(typeof body.serverUrl).toBe("string");
    expect(typeof body.workbenchUrl).toBe("string");
    expect(body.passwordRecoveryDriver).toBe("oss_relay");
  });

  test("logtoDesktopAppId populated from LOGTO_DESKTOP_APP_ID env (M055)", async () => {
    envSnap = snapshotEnv();
    process.env["LOGTO_ENDPOINT"] = "http://localhost:3301";
    process.env["LOGTO_WORKBENCH_APP_ID"] = "wb";
    process.env["LOGTO_TUI_APP_ID"] = "tui";
    process.env["LOGTO_TUI_LOOPBACK_APP_ID"] = "tui-loopback";
    process.env["LOGTO_DESKTOP_APP_ID"] = "desktop-abc123";
    process.env["LOGTO_MOBILE_APP_ID"] = "mobile-abc123";
    process.env["LOGTO_MOBILE_WEB_APP_ID"] = "mobile-web-abc123";
    process.env["LOGTO_RESOURCE"] = "https://api.example.test";

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.logtoDesktopAppId).toBe("desktop-abc123");
    expect(body.logtoMobileAppId).toBe("mobile-abc123");
    expect(body.logtoMobileWebAppId).toBe("mobile-web-abc123");
    expect(body.logtoTuiLoopbackAppId).toBe("tui-loopback");
  });

  test("missing LOGTO_TUI_LOOPBACK_APP_ID yields empty string (M102)", async () => {
    envSnap = snapshotEnv();
    delete process.env["LOGTO_TUI_LOOPBACK_APP_ID"];

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.logtoTuiLoopbackAppId).toBe("");
  });

  test("missing LOGTO_DESKTOP_APP_ID yields empty string (M055)", async () => {
    envSnap = snapshotEnv();
    delete process.env["LOGTO_DESKTOP_APP_ID"];

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.logtoDesktopAppId).toBe("");
  });

  test("missing LOGTO_MOBILE_APP_ID yields empty string (M199)", async () => {
    envSnap = snapshotEnv();
    delete process.env["LOGTO_MOBILE_APP_ID"];

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.logtoMobileAppId).toBe("");
  });

  test("missing LOGTO_MOBILE_WEB_APP_ID yields empty string (D515)", async () => {
    envSnap = snapshotEnv();
    delete process.env["LOGTO_MOBILE_WEB_APP_ID"];

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.logtoMobileWebAppId).toBe("");
  });

  test("logtoResource populated from LOGTO_RESOURCE env (M054)", async () => {
    envSnap = snapshotEnv();
    process.env["LOGTO_ENDPOINT"] = "http://localhost:3301";
    process.env["LOGTO_WORKBENCH_APP_ID"] = "wb-resource";
    process.env["LOGTO_TUI_APP_ID"] = "tui-resource";
    process.env["LOGTO_RESOURCE"] = "https://api.example.test";

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.logtoResource).toBe("https://api.example.test");
  });

  test("missing LOGTO_RESOURCE yields empty string (M054)", async () => {
    envSnap = snapshotEnv();
    delete process.env["LOGTO_RESOURCE"];

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse;
    expect(body.logtoResource).toBe("");
  });

  test("logto fields populated from process.env", async () => {
    envSnap = snapshotEnv();
    process.env["LOGTO_ENDPOINT"] = "http://localhost:3301";
    process.env["LOGTO_WORKBENCH_APP_ID"] = "wb-test";
    process.env["LOGTO_TUI_APP_ID"] = "tui-test";

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse & Record<string, unknown>;
    expect("authMode" in body).toBe(false);
    expect(body.logtoEndpoint).toBe("http://localhost:3301");
    expect(body.logtoWorkbenchAppId).toBe("wb-test");
    expect(body.logtoTuiAppId).toBe("tui-test");
    expect(body.serverUrl).toMatch(/^http/);
    expect(body.workbenchUrl).toMatch(/^http/);
  });

  test("public base URL overrides local instance URLs for remote deployments", async () => {
    envSnap = snapshotEnv();
    process.env["NAUTILO_PUBLIC_BASE_URL"] = "https://nautilo.example.test/";

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse & Record<string, unknown>;

    expect(body.serverUrl).toBe("https://nautilo.example.test");
    expect(body.workbenchUrl).toBe("https://nautilo.example.test");
  });

  test("missing LOGTO_ENDPOINT yields empty string for that field", async () => {
    envSnap = snapshotEnv();
    delete process.env["LOGTO_ENDPOINT"];
    process.env["LOGTO_WORKBENCH_APP_ID"] = "wb-x";
    process.env["LOGTO_TUI_APP_ID"] = "tui-x";

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(res.body) as HealthResponse & Record<string, unknown>;
    expect("authMode" in body).toBe(false);
    expect(body.logtoEndpoint).toBe("");
    expect(body.logtoWorkbenchAppId).toBe("wb-x");
  });
});

describe("/api/health/modes (M051)", () => {
  const instances: FastifyInstance[] = [];
  let envSnap: Record<string, string | undefined> = {};

  afterEach(async () => {
    restoreEnv(envSnap);
    await Promise.all(instances.splice(0).map((app) => app.close()));
  });

  test("returns ModeReport for localhost requests", async () => {
    envSnap = snapshotEnv();
    process.env["LOGTO_ENDPOINT"] = "http://localhost:3301";
    process.env["LOGTO_M2M_APP_SECRET"] = "supersecret-1234567890abcdef";

    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({ method: "GET", url: "/api/health/modes" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      entries: { envVar: string; value: string | null; redacted: boolean }[];
    };

    const endpoint = body.entries.find((e) => e.envVar === "LOGTO_ENDPOINT");
    expect(endpoint?.value).toBe("http://localhost:3301");

    const secret = body.entries.find(
      (e) => e.envVar === "LOGTO_M2M_APP_SECRET",
    );
    expect(secret?.redacted).toBe(true);
    expect(secret?.value).not.toBe("supersecret-1234567890abcdef");
    expect((body as Record<string, unknown>)["authMode"]).toBeUndefined();
  });

  test("403 for non-localhost callers", async () => {
    envSnap = snapshotEnv();
    const app = await makeHealthApp();
    instances.push(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/health/modes",
      remoteAddress: "10.0.0.5",
    });
    expect(res.statusCode).toBe(403);
  });
});
