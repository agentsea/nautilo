/**
 * M201 — topology-aware Collabora origins (R1), the coolwsd admin-path deny
 * helper (R3), and the single-replica boot guard (R4).
 *
 * Pure-helper unit tests: no DB, no running server. `@nautilo/config` is
 * mocked deterministically (server port 3001, collabora host port 9981) so
 * the "override unset" defaults are stable regression locks; `@nautilo/logger`
 * is mocked to capture `warn` calls for the replica guard.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as actualConfig from "@nautilo/config";

const STUB_INSTANCE = {
  server: { port: 3001, host: "127.0.0.1", url: "http://127.0.0.1:3001" },
};
const STUB_COLLABORA_PORT = 9981;

// Spread the real module so all the other config exports the wopi/broker
// import graph pulls in (e.g. `__resetResolvedInstanceForTests`) keep working;
// override only the two the origin helpers consume.
mock.module("@nautilo/config", () => ({
  ...actualConfig,
  resolveInstance: () => STUB_INSTANCE,
  collaboraHostPort: () => STUB_COLLABORA_PORT,
}));

const warnCalls: string[] = [];
mock.module("@nautilo/logger", () => ({
  warn: (msg: string) => {
    warnCalls.push(msg);
  },
  info: () => undefined,
  error: () => undefined,
  debug: () => undefined,
}));

const {
  collaboraEngineHttpUrl,
  collaboraUpstreamOrigin,
  collaboraUpstreamWsOrigin,
  isCoolwsdAdminPath,
} = await import("../../src/routes/office-proxy");
const { wopiCallbackOrigin, collaboraEngineOrigin, warnOfficeSingleReplica } =
  await import("../../src/routes/wopi");
const { collaboraWsOrigin } = await import("../../src/lib/office-session-broker");

const ENGINE = "NAUTILO_COLLABORA_ENGINE_URL";
const CALLBACK = "NAUTILO_WOPI_CALLBACK_ORIGIN";
const WS = "NAUTILO_COLLABORA_WS_ORIGIN";

afterEach(() => {
  delete process.env[ENGINE];
  delete process.env[CALLBACK];
  delete process.env[WS];
  warnCalls.length = 0;
});

describe("M201 R1 — collabora engine URL (server → engine: proxy + discovery)", () => {
  test("defaults to the dev localhost-published port when the override is unset", () => {
    expect(collaboraEngineHttpUrl()).toBe(`http://127.0.0.1:${STUB_COLLABORA_PORT}`);
    expect(collaboraUpstreamOrigin()).toBe(`http://127.0.0.1:${STUB_COLLABORA_PORT}`);
    // wopi.ts discovery keeps its historical `localhost` literal — same host,
    // same override key, functionally identical.
    expect(collaboraEngineOrigin()).toBe(`http://localhost:${STUB_COLLABORA_PORT}`);
  });

  test("honors NAUTILO_COLLABORA_ENGINE_URL and strips a trailing slash", () => {
    process.env[ENGINE] = "http://collabora:9980/";
    expect(collaboraEngineHttpUrl()).toBe("http://collabora:9980");
    expect(collaboraUpstreamOrigin()).toBe("http://collabora:9980");
    expect(collaboraEngineOrigin()).toBe("http://collabora:9980");
  });

  test("maps http→ws and https→wss for the upstream WS origin", () => {
    expect(collaboraUpstreamWsOrigin()).toBe(`ws://127.0.0.1:${STUB_COLLABORA_PORT}`);
    process.env[ENGINE] = "https://office.example.com";
    expect(collaboraUpstreamWsOrigin()).toBe("wss://office.example.com");
  });
});

describe("M201 R1 — WOPI callback origin (engine → server)", () => {
  test("defaults to host.docker.internal on the server port when unset", () => {
    expect(wopiCallbackOrigin()).toBe(
      `http://host.docker.internal:${STUB_INSTANCE.server.port}`,
    );
  });

  test("honors NAUTILO_WOPI_CALLBACK_ORIGIN and strips a trailing slash", () => {
    process.env[CALLBACK] = "http://nautilo-server:3001/";
    expect(wopiCallbackOrigin()).toBe("http://nautilo-server:3001");
  });
});

describe("M201 R1 — agent broker upstream-WS Origin header", () => {
  test("defaults to the loopback server origin when unset", () => {
    expect(collaboraWsOrigin()).toBe(`http://127.0.0.1:${STUB_INSTANCE.server.port}`);
  });

  test("honors NAUTILO_COLLABORA_WS_ORIGIN", () => {
    process.env[WS] = "https://office.example.com";
    expect(collaboraWsOrigin()).toBe("https://office.example.com");
  });
});

describe("M201 R3 — coolwsd admin path deny", () => {
  test("flags the admin console + adminws path variants", () => {
    expect(isCoolwsdAdminPath("/adminws")).toBe(true);
    expect(isCoolwsdAdminPath("/adminws/")).toBe(true);
    // nginx/Apache reverse-proxy templates route the admin WS under /cool.
    expect(isCoolwsdAdminPath("/cool/adminws")).toBe(true);
    expect(isCoolwsdAdminPath("/admin")).toBe(true);
    expect(isCoolwsdAdminPath("/admin/console")).toBe(true);
    expect(isCoolwsdAdminPath("/browser/dist/admin/admin.html")).toBe(true);
  });

  test("does not flag normal engine asset / doc-WS / discovery paths", () => {
    expect(isCoolwsdAdminPath("/browser/dist/cool.html")).toBe(false);
    expect(isCoolwsdAdminPath("/cool/0/ws")).toBe(false);
    expect(isCoolwsdAdminPath("/hosting/discovery")).toBe(false);
    expect(isCoolwsdAdminPath("/nw-strip.css")).toBe(false);
  });
});

describe("M201 R4 — single-replica boot guard", () => {
  test("warns loudly + UNSUPPORTED when NAUTILO_SERVER_REPLICAS > 1", () => {
    warnOfficeSingleReplica({ NAUTILO_SERVER_REPLICAS: "3" } as NodeJS.ProcessEnv);
    expect(
      warnCalls.some(
        (m) => m.includes("UNSUPPORTED under") && m.includes("NAUTILO_SERVER_REPLICAS=3"),
      ),
    ).toBe(true);
  });

  test("emits the always-on single-replica note when replicas is unset or 1", () => {
    warnOfficeSingleReplica({} as NodeJS.ProcessEnv);
    expect(warnCalls.some((m) => m.includes("office runs single-replica"))).toBe(true);
    warnCalls.length = 0;
    warnOfficeSingleReplica({ NAUTILO_SERVER_REPLICAS: "1" } as NodeJS.ProcessEnv);
    expect(warnCalls.some((m) => m.includes("office runs single-replica"))).toBe(true);
  });
});
