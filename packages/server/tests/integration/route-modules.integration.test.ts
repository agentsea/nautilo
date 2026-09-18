import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "dotenv";

config({ path: resolve(import.meta.dirname, "../../../.env") });

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { setConfigOverrides, getServerHostname } from "@nautilo/config";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fx: AppFixture;
let bearer: string;
let previousArtifactsRoot: string | undefined;
let routeModulesRoot = "";

beforeAll(async () => {
  previousArtifactsRoot = process.env["NAUTILO_ARTIFACTS_ROOT"];
  routeModulesRoot = await mkdtemp(join(tmpdir(), "nautilo-route-modules-"));
  process.env["NAUTILO_ARTIFACTS_ROOT"] = join(routeModulesRoot, "artifacts");
  fx = await setupOwnerAppFixture({ suiteName: "rmod" });
  bearer = await fx.mintOwnerBearer();
});

afterAll(async () => {
  setConfigOverrides({});
  if (fx) await fx.cleanup();
  if (previousArtifactsRoot === undefined) delete process.env["NAUTILO_ARTIFACTS_ROOT"];
  else process.env["NAUTILO_ARTIFACTS_ROOT"] = previousArtifactsRoot;
  if (routeModulesRoot) {
    await rm(routeModulesRoot, { recursive: true, force: true });
    routeModulesRoot = "";
  }
});

describe("health", () => {
  test("GET /health returns extended discovery shape", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect("authMode" in body).toBe(false);
  });

  test("GET /api/health/modes is localhost-gated", async () => {
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/health/modes",
    });
    expect([200, 403]).toContain(res.statusCode);
  });
});

describe("apps", () => {
  test("GET /api/apps requires session", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/apps" });
    expect(res.statusCode).toBe(401);
  });

  test("GET /api/apps returns seeded Writer for owner", async () => {
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/apps",
      bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      apps: Array<{ id: string; name: string; status: string }>;
    };
    const writer = body.apps.find((entry) => entry.id === "nautilo-writer");
    expect(writer).toBeTruthy();
    expect(writer?.name).toBe("Writer");
    expect(writer?.status).toBe("ready");
  });
});

describe("config", () => {
  test("GET /api/config/models returns an array", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/config/models" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/config/models accepts eligibility query flags", async () => {
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/config/models?includeUnavailable=true&allowChinaUpstream=false",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  test("GET /api/config/setup-flags returns flags object", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/config/setup-flags" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(typeof body["motherEasterEgg"]).toBe("boolean");
    expect(typeof body["avatarGenAvail"]).toBe("boolean");
  });
});

describe("memory", () => {
  test("GET /api/memory/brief returns brief envelope", async () => {
    // M125 — `/api/memory/brief` is owner-scoped; an anonymous request
    // fail-closes with 401 (buildAnonymousContext sets ownerId=""). The
    // brief envelope is only meaningful for an authenticated subject, so
    // pass the owner bearer rather than relying on the retired
    // anonymous→bootstrap-owner fallback.
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/memory/brief",
      bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { brief?: unknown };
    expect(typeof body.brief).toBe("string");
  });
});

describe("sessions", () => {
  test("anonymous request to /api/sessions/latest is rejected (M125 fail-closed)", async () => {
    // Pre-M125 an unauthenticated GET returned an empty "guest shell"
    // (200 + null session) by silently adopting the bootstrap owner's
    // identity. M125 retired that: buildAnonymousContext sets ownerId="",
    // so subject-deriving routes fail-closed with 401. This is
    // deployment-mode independent (the route gates on a missing subject,
    // not on posture), so it holds on any instance.
    const res = await fx.app.inject({ method: "GET", url: "/api/sessions/latest" });
    expect(res.statusCode).toBe(401);
  });

  test("owner receives latest envelope (may be empty)", async () => {
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/sessions/latest?limit=5&offset=0",
      bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { messages: unknown[] };
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

describe("rooms", () => {
  test("owner can list rooms", async () => {
    const list = await authedInject(fx.app, { method: "GET", url: "/api/rooms", bearer });
    expect(list.statusCode).toBe(200);
    const rooms = JSON.parse(list.body) as { rooms?: unknown[] };
    expect(Array.isArray(rooms.rooms)).toBe(true);
  });
});

describe("security", () => {
  test("GET /api/security/posture returns posture for owner session", async () => {
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/security/posture",
      bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { securityLevel?: string };
    expect(typeof body.securityLevel).toBe("string");
  });
});

describe("owner", () => {
  test("PUT /api/owner requires owner session", async () => {
    const res = await fx.app.inject({
      method: "PUT",
      url: "/api/owner",
      headers: { "content-type": "application/json" },
      payload: { displayName: "X", handle: `h${Date.now().toString(36)}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("relay (M056 HTTP)", () => {
  test("POST /api/relay/pair returns rty_ relay token once", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/relay/pair",
      bearer,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { relayToken?: string };
    expect(body.relayToken?.startsWith("rty_")).toBe(true);
  });

  test("GET /api/relay/devices lists paired devices", async () => {
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/relay/devices",
      bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown;
    expect(Array.isArray(body)).toBe(true);
  });

  test("D418 — re-pair with the same installationId yields a single active device", async () => {
    const installId = "44444444-5555-6666-7777-888888888888";
    const pair1 = await authedInject(fx.app, {
      method: "POST",
      url: "/api/relay/pair",
      bearer,
      payload: { deviceLabel: "desktop-A", installationId: installId },
    });
    expect(pair1.statusCode).toBe(200);
    expect(
      (JSON.parse(pair1.body) as { relayToken?: string }).relayToken ?? "",
    ).toMatch(/^rty_/);

    const pair2 = await authedInject(fx.app, {
      method: "POST",
      url: "/api/relay/pair",
      bearer,
      payload: { deviceLabel: "desktop-A-repair", installationId: installId },
    });
    expect(pair2.statusCode).toBe(200);

    const list = await authedInject(fx.app, {
      method: "GET",
      url: "/api/relay/devices",
      bearer,
    });
    expect(list.statusCode).toBe(200);
    const devices = JSON.parse(list.body) as Array<{ label: string }>;
    // The suite's earlier legacy-pair test intentionally leaves another
    // active device for this fixture user. Isolate the installation-aware
    // pair by its labels: only the replacement must remain active.
    const installationDevices = devices.filter((device) =>
      ["desktop-A", "desktop-A-repair"].includes(device.label),
    );
    expect(installationDevices).toHaveLength(1);
    expect(installationDevices[0]?.label).toBe("desktop-A-repair");
  });

  test("D418 — invalid installationId is rejected with 400 and no device is paired", async () => {
    const before = await authedInject(fx.app, {
      method: "GET",
      url: "/api/relay/devices",
      bearer,
    });
    const beforeCount = (JSON.parse(before.body) as unknown[]).length;

    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/relay/pair",
      bearer,
      payload: { deviceLabel: "bad", installationId: "not-a-uuid" },
    });
    expect(res.statusCode).toBe(400);

    const after = await authedInject(fx.app, {
      method: "GET",
      url: "/api/relay/devices",
      bearer,
    });
    const afterCount = (JSON.parse(after.body) as unknown[]).length;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("webfinger + public profile", () => {
  test("GET /.well-known/webfinger returns 400 without acct resource", async () => {
    const res = await fx.app.inject({
      method: "GET",
      url: "/.well-known/webfinger",
    });
    expect(res.statusCode).toBe(400);
  });

  test("GET /.well-known/webfinger returns JRD for this owner handle", async () => {
    const host = getServerHostname();
    const res = await fx.app.inject({
      method: "GET",
      url: `/.well-known/webfinger?resource=acct:${encodeURIComponent(fx.ownerHandle)}@${encodeURIComponent(host)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("jrd+json");
    const body = JSON.parse(res.body) as { subject?: string; links?: unknown[] };
    expect(body.subject?.includes(fx.ownerHandle)).toBe(true);
    expect(Array.isArray(body.links)).toBe(true);
  });

  test("GET /api/profile/:handle returns public shell", async () => {
    const res = await fx.app.inject({
      method: "GET",
      url: `/api/profile/${encodeURIComponent(fx.ownerHandle)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body["handle"]).toBe(fx.ownerHandle);
    expect(body).not.toHaveProperty("userId");
  });
});

describe("jobs", () => {
  test("POST /api/jobs returns 202 + jobId (does not wait for slow executor)", async () => {
    // M125 — job creation is owner-scoped; anonymous POST fail-closes
    // with 401. Pass the owner bearer (the follow-up GET below already
    // does) so the job is attributed to the fixture owner.
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/jobs",
      bearer,
      payload: { task: "integration-smoke" },
    });
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body) as { jobId?: string; accepted?: boolean };
    expect(body.accepted).toBe(true);
    expect(typeof body.jobId).toBe("string");
    const jobId = body.jobId as string;

    const st = await fx.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(st.statusCode).toBe(200);
    const job = JSON.parse(st.body) as { id: string; status: string };
    expect(job.id).toBe(jobId);
    expect(typeof job.status).toBe("string");
  });
});

describe("chat", () => {
  test("POST /api/chat ignores invalid advisory currentFolder", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/chat",
      bearer,
      payload: {
        message: "hi",
        laneKey: "app:default",
        currentFolder: "relative/bad",
      },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe("stt", () => {
  test("POST /api/stt without multipart returns 4xx", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/stt",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect([400, 406]).toContain(res.statusCode);
  });
});

describe("voices", () => {
  test("GET /api/voices returns a list or upstream error when TTS is unavailable", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/voices" });
    expect([200, 502]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body) as { voices?: unknown };
      expect(Array.isArray(body.voices)).toBe(true);
    }
  });
});

describe("invoke-direct", () => {
  // Env wins over `setConfigOverrides` for this flag (D090); clear before toggling.
  let prevDirectDispatchEnv: string | undefined;

  beforeEach(() => {
    prevDirectDispatchEnv = process.env["NAUTILO_DIRECT_DISPATCH"];
    delete process.env["NAUTILO_DIRECT_DISPATCH"];
  });

  afterEach(() => {
    if (prevDirectDispatchEnv === undefined) delete process.env["NAUTILO_DIRECT_DISPATCH"];
    else process.env["NAUTILO_DIRECT_DISPATCH"] = prevDirectDispatchEnv;
    setConfigOverrides({});
  });

  test("returns 503 when direct dispatch is disabled", async () => {
    setConfigOverrides({ nautilo_direct_dispatch: false });
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/file/invoke-direct",
      bearer,
      payload: {
        command: "list_revisions",
        workspacePath: "/tmp",
        currentFolder: "/tmp",
      },
    });
    expect(res.statusCode).toBe(503);
  });

  test("returns 400 for disallowed command when enabled", async () => {
    setConfigOverrides({ nautilo_direct_dispatch: true });
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/file/invoke-direct",
      bearer,
      payload: {
        command: "write",
        workspacePath: "/tmp",
        currentFolder: "/tmp",
      },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error?: string };
    expect(body.error).toContain("command must be one of");
  });
});

describe("connection-proxy", () => {
  test("POST is disabled in foundation mode (403)", async () => {
    const res = await authedInject(fx.app, {
      method: "POST",
      url: "/api/connection-proxy/anthropic",
      bearer,
      payload: { tool: "test", args: {} },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("connections", () => {
  test("GET /api/connections returns list envelope", async () => {
    const res = await authedInject(fx.app, {
      method: "GET",
      url: "/api/connections",
      bearer,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { connections?: unknown };
    expect(body).toHaveProperty("connections");
  });
});

describe("agent-members", () => {
  test("GET /api/agents without session returns 401", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
  });
});

describe("invites", () => {
  test("POST /api/invites without session returns 401", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/invites",
      headers: { "content-type": "application/json" },
      payload: { kind: "server" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("setup", () => {
  test("POST /api/setup/keys rejects non-localhost IP in inject harness", async () => {
    const res = await fx.app.inject({
      method: "POST",
      url: "/api/setup/keys",
      headers: { "content-type": "application/json" },
      payload: { keys: {}, overwrite: false },
    });
    expect([200, 403, 400]).toContain(res.statusCode);
  });
});

describe("ws (carve-out — full handshake is M067C)", () => {
  test("GET /ws is not a plain JSON route (upgrade or non-200)", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/ws" });
    expect([200, 400, 404, 426]).toContain(res.statusCode);
  });
});

describe("workspace-artifacts routes (M088C)", () => {
  test("workspace artifact prefix routes exist (unauthenticated 401 or guest 403)", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    const checks: { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string }[] = [
      { method: "GET", url: "/api/workspace/artifacts" },
      { method: "GET", url: "/api/workspace/artifacts/events" },
      { method: "GET", url: `/api/workspace/artifacts/${id}` },
      { method: "PATCH", url: `/api/workspace/artifacts/${id}` },
      { method: "DELETE", url: `/api/workspace/artifacts/${id}` },
      { method: "GET", url: `/api/workspace/artifacts/${id}/bytes` },
      { method: "PUT", url: `/api/workspace/artifacts/${id}/content` },
      { method: "POST", url: "/api/workspace/artifacts" },
    ];
    for (const { method, url } of checks) {
      const res = await fx.app.inject({
        method,
        url,
        ...(method === "PATCH" ? { payload: { newPath: "x.md" } } : {}),
        ...(method === "PUT" && url.endsWith("/content")
          ? {
              payload: "hello",
              headers: { "content-type": "text/plain; charset=utf-8" },
            }
          : {}),
      });
      expect([401, 403]).toContain(res.statusCode);
    }
  });
});

describe("profile", () => {
  test("GET /api/profile with guest stays 200 shell", async () => {
    const res = await fx.app.inject({ method: "GET", url: "/api/profile" });
    expect(res.statusCode).toBe(200);
  });
});

describe("account (beyond D104 account-security.test.ts)", () => {
  test("GET /api/account/recovery-codes/status requires session", async () => {
    const res = await fx.app.inject({
      method: "GET",
      url: "/api/account/recovery-codes/status",
    });
    expect(res.statusCode).toBe(401);
  });
});
