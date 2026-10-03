import { describe, expect, test } from "bun:test";
import {
  parseServerProviderPolicyUpdateBodyForTests,
  serverProviderPolicyRoutes,
  type ServerProviderPolicyRouteDeps,
} from "../../src/routes/server-provider-policy";

type Handler = (
  request: {
    sessionUserId?: string;
    body?: unknown;
    ip: string;
    headers: Record<string, string>;
  },
  reply: {
    code(status: number): unknown;
    send(body: unknown): unknown;
  },
) => Promise<unknown>;

function routeHarness(deps: ServerProviderPolicyRouteDeps = {}) {
  const handlers = new Map<string, Handler>();
  const app = {
    get(path: string, handler: Handler) {
      handlers.set(`GET ${path}`, handler);
    },
    post(path: string, handler: Handler) {
      handlers.set(`POST ${path}`, handler);
    },
  };
  serverProviderPolicyRoutes(app as never, deps);

  return async (method: "GET" | "POST", request: Parameters<Handler>[0]) => {
    let status = 200;
    let body: unknown;
    const reply = {
      code(next: number) {
        status = next;
        return this;
      },
      send(next: unknown) {
        body = next;
        return next;
      },
    };
    await handlers.get(`${method} /api/admin/server-provider-policy`)!(request, reply);
    return { status, body };
  };
}

const requestBase = { ip: "127.0.0.1", headers: {} };

describe("server-provider-policy update validation", () => {
  test("accepts either field or both as a nonempty partial update", () => {
    expect(parseServerProviderPolicyUpdateBodyForTests({
      allowPersonalProviderKeys: true,
    })).toEqual({ ok: true, patch: { allowPersonalProviderKeys: true } });
    expect(parseServerProviderPolicyUpdateBodyForTests({
      fundingPreference: "server_first",
    })).toEqual({ ok: true, patch: { fundingPreference: "server_first" } });
    expect(parseServerProviderPolicyUpdateBodyForTests({
      allowPersonalProviderKeys: false,
      fundingPreference: "personal_first",
    })).toEqual({
      ok: true,
      patch: { allowPersonalProviderKeys: false, fundingPreference: "personal_first" },
    });
  });

  test.each([
    { label: "null", body: null },
    { label: "array", body: [] },
    { label: "empty object", body: {} },
    { label: "string value", body: { allowPersonalProviderKeys: "true" } },
    { label: "null value", body: { allowPersonalProviderKeys: null } },
    { label: "invalid funding preference", body: { fundingPreference: "automatic" } },
    { label: "unknown extra field", body: { allowPersonalProviderKeys: false, extra: true } },
    { label: "unknown field", body: { unknown: false } },
  ])("rejects malformed or non-strict body: $label", ({ body }) => {
    expect(parseServerProviderPolicyUpdateBodyForTests(body).ok).toBe(false);
  });
});

describe("server-provider-policy route", () => {
  test("requires authentication before any capability or storage access", async () => {
    let capabilityCalls = 0;
    let storageCalls = 0;
    const call = routeHarness({
      getCapabilities: async () => { capabilityCalls += 1; return []; },
      getPolicy: async () => {
        storageCalls += 1;
        return { allowPersonalProviderKeys: false, fundingPreference: "personal_first" };
      },
    });
    expect(await call("GET", requestBase)).toEqual({
      status: 401,
      body: { error: "Authentication required" },
    });
    expect(await call("POST", { ...requestBase, body: { allowPersonalProviderKeys: true } }))
      .toEqual({ status: 401, body: { error: "Authentication required" } });
    expect({ capabilityCalls, storageCalls }).toEqual({ capabilityCalls: 0, storageCalls: 0 });
  });

  test("allows either settings capability to read but only manage to write", async () => {
    const getDb = () => ({}) as never;
    const reader = routeHarness({
      getCapabilities: async () => ["read_server_settings"],
      getDb,
      getPolicy: async () => ({
        allowPersonalProviderKeys: false,
        fundingPreference: "personal_first",
      }),
    });
    expect(await reader("GET", { ...requestBase, sessionUserId: "reader" })).toEqual({
      status: 200,
      body: { allowPersonalProviderKeys: false, fundingPreference: "personal_first" },
    });
    expect(await reader("POST", {
      ...requestBase,
      sessionUserId: "reader",
      body: { allowPersonalProviderKeys: true },
    })).toEqual({ status: 403, body: { error: "admin only" } });

    const manager = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb,
      getPolicy: async () => ({
        allowPersonalProviderKeys: true,
        fundingPreference: "server_first",
      }),
    });
    expect(await manager("GET", { ...requestBase, sessionUserId: "manager" })).toEqual({
      status: 200,
      body: { allowPersonalProviderKeys: true, fundingPreference: "server_first" },
    });
  });

  test("rechecks current effective capabilities on every request", async () => {
    let allowed = true;
    const call = routeHarness({
      getCapabilities: async () => allowed ? ["read_server_settings"] : [],
      getDb: () => ({}) as never,
      getPolicy: async () => ({
        allowPersonalProviderKeys: false,
        fundingPreference: "personal_first",
      }),
    });
    const request = { ...requestBase, sessionUserId: "reader" };
    expect((await call("GET", request)).status).toBe(200);
    allowed = false;
    expect((await call("GET", request)).status).toBe(403);
  });

  test("rejects malformed writes before storage access", async () => {
    let storageCalls = 0;
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getPolicy: async () => {
        storageCalls += 1;
        return { allowPersonalProviderKeys: false, fundingPreference: "personal_first" };
      },
    });
    expect(await call("POST", {
      ...requestBase,
      sessionUserId: "manager",
      body: { allowPersonalProviderKeys: true, extra: false },
    })).toEqual({
      status: 422,
      body: { error: "only allowPersonalProviderKeys and fundingPreference are writable" },
    });
    expect(storageCalls).toBe(0);
  });

  test("persists on and off before responding and audits actor and effective values", async () => {
    let stored = {
      allowPersonalProviderKeys: false,
      fundingPreference: "personal_first" as "personal_first" | "server_first",
    };
    const writes: unknown[] = [];
    const events: Record<string, unknown>[] = [];
    let unprotectedReads = 0;
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => {
        unprotectedReads += 1;
        return stored;
      },
      upsertPolicy: async (_db, next) => {
        writes.push(next);
        const previous = stored;
        stored = { ...stored, ...next };
        return {
          previous,
          effective: stored,
        };
      },
      auditEvent: (_request, event) => { events.push(event); },
    });
    const request = { ...requestBase, sessionUserId: "manager" };
    expect(await call("POST", { ...request, body: { allowPersonalProviderKeys: true } }))
      .toEqual({
        status: 200,
        body: { allowPersonalProviderKeys: true, fundingPreference: "personal_first" },
      });
    expect(await call("POST", { ...request, body: { fundingPreference: "server_first" } }))
      .toEqual({
        status: 200,
        body: { allowPersonalProviderKeys: true, fundingPreference: "server_first" },
      });
    expect(await call("POST", { ...request, body: { allowPersonalProviderKeys: false } }))
      .toEqual({
        status: 200,
        body: { allowPersonalProviderKeys: false, fundingPreference: "server_first" },
      });
    expect(writes).toEqual([
      { allowPersonalProviderKeys: true },
      { fundingPreference: "server_first" },
      { allowPersonalProviderKeys: false },
    ]);
    expect(unprotectedReads).toBe(0);
    expect(events).toEqual([
      {
        kind: "server_provider_policy_changed",
        actorId: "manager",
        previous: false,
        effective: true,
        previousFundingPreference: "personal_first",
        effectiveFundingPreference: "personal_first",
      },
      {
        kind: "server_provider_policy_changed",
        actorId: "manager",
        previous: true,
        effective: true,
        previousFundingPreference: "personal_first",
        effectiveFundingPreference: "server_first",
      },
      {
        kind: "server_provider_policy_changed",
        actorId: "manager",
        previous: true,
        effective: false,
        previousFundingPreference: "server_first",
        effectiveFundingPreference: "server_first",
      },
    ]);
  });

  test("maps read and write failures to the stable unavailable response", async () => {
    const unavailable = { status: 503, body: { error: "server_provider_policy_unavailable" } };
    const readCall = routeHarness({
      getCapabilities: async () => ["read_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => { throw new Error("offline"); },
    });
    expect(await readCall("GET", { ...requestBase, sessionUserId: "reader" })).toEqual(unavailable);

    const writeCall = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => ({
        allowPersonalProviderKeys: false,
        fundingPreference: "personal_first",
      }),
      upsertPolicy: async () => { throw new Error("offline"); },
    });
    expect(await writeCall("POST", {
      ...requestBase,
      sessionUserId: "manager",
      body: { allowPersonalProviderKeys: true },
    })).toEqual(unavailable);
  });

  test("does not report or audit optimistic success when persistence fails", async () => {
    const events: Record<string, unknown>[] = [];
    const call = routeHarness({
      getCapabilities: async () => ["manage_server_settings"],
      getDb: () => ({}) as never,
      getPolicy: async () => ({
        allowPersonalProviderKeys: false,
        fundingPreference: "personal_first",
      }),
      upsertPolicy: async () => { throw new Error("write failed"); },
      auditEvent: (_request, event) => { events.push(event); },
    });
    expect(await call("POST", {
      ...requestBase,
      sessionUserId: "manager",
      body: { allowPersonalProviderKeys: true },
    })).toEqual({ status: 503, body: { error: "server_provider_policy_unavailable" } });
    expect(events).toEqual([]);
  });
});
