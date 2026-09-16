/**
 * M054 — `getHealth()` return type contract.
 *
 * The workbench bootstrap (`apps/workbench/src/main.tsx`) reads
 * `health.logtoEndpoint` + `health.logtoWorkbenchAppId`
 * + `health.logtoResource` to decide whether to wrap the app in
 * `<LogtoProvider>`. Older M042-era callers depend on `status` /
 * `authRequired` / `enrolled`. Both surfaces must coexist on the
 * same `HealthResponse` type — these tests pin the shape so a
 * future refactor doesn't drop fields.
 *
 * Pure unit test: stubs `fetch`, never hits the network.
 *
 * M071 1B.8: `NautiloApiClient("http://127.0.0.1:3001")` below is a fixed
 * fixture URL for the stubbed client instance, not runtime resolution.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient, type HealthResponse } from "../../src/client";

const realFetch = globalThis.fetch;

function stubFetch(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("getHealth() return type (M051 + M054)", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const client = new NautiloApiClient("http://127.0.0.1:3001");

  test("accepts the legacy {status, authRequired, enrolled} shape unchanged", async () => {
    stubFetch({ status: "ok", authRequired: true, enrolled: false });
    const result: HealthResponse = await client.getHealth();
    expect(result.status).toBe("ok");
    expect(result.authRequired).toBe(true);
    expect(result.enrolled).toBe(false);
    // M051 / M054 fields default to undefined when older servers
    // don't populate them — UI code must defensively check.
    expect(result.logtoResource).toBeUndefined();
    expect(result.maintenanceState).toBeUndefined();
  });

  test("accepts the M051+M054+M055 logto discovery shape", async () => {
    stubFetch({
      status: "ok",
      authRequired: false,
      enrolled: false,
      logtoEndpoint: "http://localhost:3301",
      logtoWorkbenchAppId: "wb-x",
      logtoTuiAppId: "tui-x",
      logtoTuiLoopbackAppId: "tui-lb-x",
      logtoDesktopAppId: "desk-x",
      logtoMobileAppId: "mob-x",
      logtoResource: "https://api.nautilo.local",
      serverUrl: "http://localhost:3001",
      workbenchUrl: "http://localhost:3000",
      maintenanceState: "applying",
    });
    const result: HealthResponse = await client.getHealth();
    expect(result.logtoEndpoint).toBe("http://localhost:3301");
    expect(result.logtoWorkbenchAppId).toBe("wb-x");
    expect(result.logtoTuiAppId).toBe("tui-x");
    expect(result.logtoTuiLoopbackAppId).toBe("tui-lb-x");
    expect(result.logtoDesktopAppId).toBe("desk-x");
    expect(result.logtoMobileAppId).toBe("mob-x");
    expect(result.logtoResource).toBe("https://api.nautilo.local");
    expect(result.serverUrl).toBe("http://localhost:3001");
    expect(result.workbenchUrl).toBe("http://localhost:3000");
    expect(result.maintenanceState).toBe("applying");
  });

  test("accepts null logto discovery fields when not configured", async () => {
    stubFetch({
      status: "ok",
      authRequired: true,
      enrolled: true,
      logtoEndpoint: null,
      logtoWorkbenchAppId: null,
      logtoTuiAppId: null,
      logtoResource: null,
    });
    const result = await client.getHealth();
    expect(result.logtoEndpoint).toBeNull();
    expect(result.logtoResource).toBeNull();
  });

  test("non-2xx throws", async () => {
    stubFetch({ error: "boom" }, 503);
    let threw = false;
    try {
      await client.getHealth();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
