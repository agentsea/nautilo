import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { CapabilityFundingSession } from "@nautilo/agent";
import type { PersonalCapabilityPreferences } from "@nautilo/types";
import {
  personalCapabilityPreferenceRoutes,
  type PersonalCapabilityPreferenceRouteDeps,
} from "../../src/routes/personal-capability-preferences";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const MODEL = "openrouter:model-a";
const apps: FastifyInstance[] = [];

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function harness(input: { missingCredentials?: boolean } = {}) {
  const rows = new Map<string, PersonalCapabilityPreferences>();
  const writes: Array<{ humanId: string; expectedRevision: number; overrides: unknown }> = [];
  let openedSessions = 0;
  const db = {} as ReturnType<NonNullable<PersonalCapabilityPreferenceRouteDeps["getDb"]>>;
  const deps: PersonalCapabilityPreferenceRouteDeps = {
    getDb: () => db,
    getPreferences: async (_db, humanId) => rows.get(humanId) ?? { revision: 0, overrides: {} },
    replacePreferences: async (_db, request) => {
      writes.push(request);
      const current = rows.get(request.humanId) ?? { revision: 0, overrides: {} };
      if (current.revision !== request.expectedRevision) {
        return { status: "conflict", currentRevision: current.revision };
      }
      const preferences = { revision: current.revision + 1, overrides: request.overrides };
      rows.set(request.humanId, preferences);
      return { status: "updated", preferences };
    },
    listModels: () => [{ modelId: MODEL, displayName: "Model A", provider: "openrouter" }],
    openSession: async (humanId) => {
      openedSessions += 1;
      return {
        fundingPreference: "personal_first",
        session: {
          humanUserId: humanId,
          resolveModel: async () => {
            if (input.missingCredentials) throw Object.assign(new Error("secret-free"), { code: "personal_credential_missing" });
            return { modelId: MODEL, preferenceRevision: rows.get(humanId)?.revision ?? 0 };
          },
          openModel: async () => {
            if (input.missingCredentials) throw Object.assign(new Error("secret-free"), { code: "personal_credential_missing" });
            return { binding: { kind: "server", providerRoute: "openrouter" }, fundingSession: {} as never };
          },
          openService: async () => { throw new Error("not used"); },
        } as CapabilityFundingSession,
      };
    },
  };
  const app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const user = request.headers["x-test-user"];
    request.sessionUserId = typeof user === "string" ? user : null;
  });
  personalCapabilityPreferenceRoutes(app, deps);
  apps.push(app);
  await app.ready();
  return { app, rows, writes, openedSessionCount: () => openedSessions };
}

function parse(response: { body: string }) {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("personal capability preference routes", () => {
  test("requires authentication and scopes every read to the session Human", async () => {
    const source = await harness();
    source.rows.set(USER_A, { revision: 1, overrides: { decision: MODEL } });
    source.rows.set(USER_B, { revision: 4, overrides: {} });
    expect((await source.app.inject({ method: "GET", url: "/api/account/capability-preferences" })).statusCode).toBe(401);
    const response = await source.app.inject({ method: "GET", url: "/api/account/capability-preferences", headers: { "x-test-user": USER_A } });
    expect(response.statusCode).toBe(200);
    expect(parse(response)).toMatchObject({ revision: 1, overrides: { decision: MODEL }, fundingPreference: "personal_first" });
    expect(JSON.stringify(parse(response))).not.toContain(USER_B);
  });

  test("keeps inherited defaults sparse and exposes effective readiness", async () => {
    const source = await harness({ missingCredentials: true });
    const response = await source.app.inject({ method: "GET", url: "/api/account/capability-preferences", headers: { "x-test-user": USER_A } });
    const body = parse(response);
    expect(body["overrides"]).toEqual({});
    const capabilities = body["capabilities"] as Array<Record<string, unknown>>;
    expect(capabilities).toHaveLength(7);
    expect(capabilities[0]).toMatchObject({
      selection: { source: "inherited", modelId: null, displayName: "Automatic" },
      readiness: { status: "missing-credentials" },
    });
  });

  test("projects the admitted funding source and route", async () => {
    const source = await harness();
    const response = await source.app.inject({ method: "GET", url: "/api/account/capability-preferences", headers: { "x-test-user": USER_A } });
    const capability = (parse(response)["capabilities"] as Array<Record<string, unknown>>)[0];
    expect(capability).toMatchObject({
      selection: { modelId: MODEL },
      readiness: { status: "ready", fundingSource: "server", providerRoute: "openrouter" },
      options: [expect.objectContaining({
        readiness: { status: "ready", reason: null, fundingSource: "server", providerRoute: "openrouter" },
      })],
    });
    expect(source.openedSessionCount()).toBe(1);
  });

  test("saves compatible choices without requiring ready credentials and resets by omission", async () => {
    const source = await harness({ missingCredentials: true });
    const saved = await source.app.inject({
      method: "PUT", url: "/api/account/capability-preferences", headers: { "x-test-user": USER_A },
      payload: { expectedRevision: 0, overrides: { webSearchSynthesis: MODEL } },
    });
    expect(saved.statusCode).toBe(200);
    expect(parse(saved)).toMatchObject({ revision: 1, overrides: { webSearchSynthesis: MODEL } });
    const reset = await source.app.inject({
      method: "PUT", url: "/api/account/capability-preferences", headers: { "x-test-user": USER_A },
      payload: { expectedRevision: 1, overrides: {} },
    });
    expect(reset.statusCode).toBe(200);
    expect(parse(reset)).toMatchObject({ revision: 2, overrides: {} });
  });

  test("rejects unknown roles/models and reports CAS conflicts", async () => {
    const source = await harness();
    source.rows.set(USER_A, { revision: 2, overrides: {} });
    for (const overrides of [{ embeddings: MODEL }, { decision: "openai:not-signed" }]) {
      const response = await source.app.inject({
        method: "PUT", url: "/api/account/capability-preferences", headers: { "x-test-user": USER_A },
        payload: { expectedRevision: 2, overrides },
      });
      expect(response.statusCode).toBe(422);
    }
    const conflict = await source.app.inject({
      method: "PUT", url: "/api/account/capability-preferences", headers: { "x-test-user": USER_A },
      payload: { expectedRevision: 1, overrides: {} },
    });
    expect(conflict.statusCode).toBe(409);
    expect(parse(conflict)).toEqual({ error: "capability_preference_conflict", currentRevision: 2 });
  });
});
