import { afterAll, describe, expect, test } from "bun:test";
import Fastify from "fastify";
import {
  serverProviderPolicyRoutes,
  type ServerProviderPolicyRouteDeps,
} from "../../src/routes/server-provider-policy";

const app = Fastify({ logger: false });
app.decorateRequest("sessionUserId", null);
app.addHook("onRequest", async (request) => {
  const user = request.headers["x-test-user"];
  request.sessionUserId = typeof user === "string" ? user : null;
});

let stored: {
  allowPersonalProviderKeys: boolean;
  fundingPreference: "personal_first" | "server_first";
} = {
  allowPersonalProviderKeys: true,
  fundingPreference: "server_first",
};
const auditEvents: Record<string, unknown>[] = [];
const deps: ServerProviderPolicyRouteDeps = {
  getCapabilities: async (userId) => {
    if (userId === "manager") return ["manage_server_settings"];
    if (userId === "reader") return ["read_server_settings"];
    return [];
  },
  getDb: () => ({}) as never,
  getPolicy: async () => stored,
  upsertPolicy: async (_db, patch) => {
    const previous = stored;
    stored = { ...stored, ...patch };
    return { previous, effective: stored };
  },
  auditEvent: (_request, event) => { auditEvents.push(event); },
};
serverProviderPolicyRoutes(app, deps);

afterAll(async () => {
  await app.close();
});

describe("server provider policy HTTP route", () => {
  test("enforces auth and preserves funding priority across a legacy switch-only write", async () => {
    const anonymous = await app.inject({
      method: "GET",
      url: "/api/admin/server-provider-policy",
    });
    expect(anonymous.statusCode).toBe(401);

    const reader = await app.inject({
      method: "GET",
      url: "/api/admin/server-provider-policy",
      headers: { "x-test-user": "reader" },
    });
    expect(reader.statusCode).toBe(200);
    expect(reader.json<unknown>()).toEqual({
      allowPersonalProviderKeys: true,
      fundingPreference: "server_first",
    });

    const deniedWrite = await app.inject({
      method: "POST",
      url: "/api/admin/server-provider-policy",
      headers: { "x-test-user": "reader" },
      payload: { allowPersonalProviderKeys: false },
    });
    expect(deniedWrite.statusCode).toBe(403);

    const legacyWrite = await app.inject({
      method: "POST",
      url: "/api/admin/server-provider-policy",
      headers: { "x-test-user": "manager" },
      payload: { allowPersonalProviderKeys: false },
    });
    expect(legacyWrite.statusCode).toBe(200);
    expect(legacyWrite.json<unknown>()).toEqual({
      allowPersonalProviderKeys: false,
      fundingPreference: "server_first",
    });
    expect(stored).toEqual({
      allowPersonalProviderKeys: false,
      fundingPreference: "server_first",
    });
    expect(auditEvents.at(-1)).toMatchObject({
      previous: true,
      effective: false,
      previousFundingPreference: "server_first",
      effectiveFundingPreference: "server_first",
    });
  });

  test("accepts a funding-only update and rejects unknown fields", async () => {
    const update = await app.inject({
      method: "POST",
      url: "/api/admin/server-provider-policy",
      headers: { "x-test-user": "manager" },
      payload: { fundingPreference: "personal_first" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json<unknown>()).toEqual({
      allowPersonalProviderKeys: false,
      fundingPreference: "personal_first",
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/admin/server-provider-policy",
      headers: { "x-test-user": "manager" },
      payload: { fundingPreference: "server_first", unknown: true },
    });
    expect(invalid.statusCode).toBe(422);
    expect(stored.fundingPreference).toBe("personal_first");
  });
});
