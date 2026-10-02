import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { getAllKeyDefinitions } from "@nautilo/config-guard";
import {
  createDirectDb,
  ensureDatabase,
  eq,
  getPersonalProviderCredential,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createPersonalProviderCustody } from "@nautilo/operator-secrets";
import { personalProviderCredentialRoutes } from "../../src/routes/personal-provider-credentials";

const SENTINEL = "personal-credential-integration-secret";
let db: DirectDatabase;
let app: FastifyInstance;
let userA: string;
let userB: string;

function responseBody(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function auth(userId: string): Record<string, string> {
  return { "x-test-user": userId };
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  const created = await db.insert(users).values([
    { name: `personal-credential-api-a-${randomUUID()}` },
    { name: `personal-credential-api-b-${randomUUID()}` },
  ]).returning({ id: users.id });
  if (created.length !== 2) throw new Error("Unable to create credential integration users");
  userA = created[0]!.id;
  userB = created[1]!.id;

  const custody = createPersonalProviderCustody();
  app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const header = request.headers["x-test-user"];
    request.sessionUserId = typeof header === "string" ? header : null;
  });
  personalProviderCredentialRoutes(app, {
    getDb: () => db,
    getPolicy: async () => ({ allowPersonalProviderKeys: true }),
    getCapabilities: async () => ["use_personal_provider_credentials"],
    readCustody: async () => custody,
    validate: async () => ({ status: "accepted" }),
    auditEvent: () => undefined,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  if (db) {
    for (const userId of [userA, userB]) {
      if (userId) await db.delete(users).where(eq(users.id, userId));
    }
    await db.end();
  }
});

describe("personal credential API with migrated database", () => {
  test("personal providers follow the server registry without its server-owned gateways", async () => {
    const registry = getAllKeyDefinitions().filter((provider) =>
      provider.id !== "gateway" && provider.id !== "nautilo-gateway");
    for (const provider of ["gateway", "nautilo-gateway"] as const) {
      const response = await app.inject({
        method: "PUT", url: `/api/account/provider-credentials/${provider}`,
        headers: auth(userB), payload: { apiKey: SENTINEL },
      });
      expect(response.statusCode).toBe(422);
      expect(await getPersonalProviderCredential(db, userB, provider)).toBeNull();
    }
    for (const provider of registry) {
      const response = await app.inject({
        method: "PUT", url: `/api/account/provider-credentials/${provider.id}`,
        headers: auth(userB), payload: { apiKey: SENTINEL },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(SENTINEL);
    }
    const listed = await app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(userB),
    });
    const body = responseBody(listed);
    const providers = body["providers"] as Array<{ id: string; personalCapabilities: string[] }>;
    expect(providers.map((provider) => provider.id)).toEqual(registry.map((provider) => provider.id));
    expect(providers.filter((provider) => provider.personalCapabilities.includes("chat"))
      .map((provider) => provider.id).sort())
      .toEqual(["anthropic", "fireworks", "google", "openai", "openrouter", "venice"]);
    expect((body["credentials"] as unknown[]).length).toBe(registry.length);
    expect(listed.body).not.toContain(SENTINEL);
    expect(listed.body).not.toContain("ciphertextBase64");
    // Remove this user's keys so the existing conflict tests start from their
    // own revision instead of depending on another scenario's receipts.
    for (const provider of registry) {
      const response = await app.inject({
        method: "DELETE", url: `/api/account/provider-credentials/${provider.id}`,
        headers: auth(userB), payload: { expectedRevision: 1 },
      });
      expect(response.statusCode).toBe(200);
    }
  });
  test("persists one owner's encrypted key, safe metadata, revision status, and deletion", async () => {
    const created = await app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(userA), payload: { apiKey: SENTINEL },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = responseBody(created);
    expect(createdBody["committed"]).toBe(true);
    expect((createdBody["credential"] as { masked: string }).masked).toBe("personal...");
    expect(created.body).not.toContain(SENTINEL);
    const row = await getPersonalProviderCredential(db, userA, "openai");
    expect(row).not.toBeNull();
    expect(row!.envelope.ciphertextBase64).not.toContain(SENTINEL);
    expect(row!.validationStatus).toBe("unverified");

    const listed = await app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(userA),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(SENTINEL);
    expect(listed.body).not.toContain("ciphertextBase64");
    expect((responseBody(listed)["credentials"] as unknown[]).length).toBe(1);
    expect((responseBody(listed)["credentials"] as { masked: string }[])[0]?.masked)
      .toBe("personal...");

    const validated = await app.inject({
      method: "POST", url: "/api/account/provider-credentials/openai/validate",
      headers: auth(userA), payload: { expectedRevision: 1 },
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.body).toContain('"validationStatus":"accepted"');
    expect((responseBody(validated)["credential"] as { masked: string }).masked).toBe("personal...");

    const replaced = await app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(userA), payload: { apiKey: "replacement-integration-secret", expectedRevision: 1 },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).toContain('"validationStatus":"unverified"');
    expect(replaced.body).toContain('"revision":2');
    expect((responseBody(replaced)["credential"] as { masked: string }).masked).toBe("replacem...");
    expect((await getPersonalProviderCredential(db, userA, "openai"))?.validatedAt).toBeNull();

    const deleted = await app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(userA), payload: { expectedRevision: 2 },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await getPersonalProviderCredential(db, userA, "openai")).toBeNull();
    const repeated = await app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(userA), payload: { expectedRevision: 2 },
    });
    expect(repeated.statusCode).toBe(200);
  });

  test("forged owner fields fail and concurrent replacements keep one revision", async () => {
    const created = await app.inject({
      method: "PUT", url: "/api/account/provider-credentials/anthropic",
      headers: auth(userB), payload: { apiKey: "b-only-key" },
    });
    expect(created.statusCode).toBe(200);
    const forged = await app.inject({
      method: "PUT", url: "/api/account/provider-credentials/anthropic",
      headers: auth(userA), payload: { apiKey: "forged", userId: userB },
    });
    expect(forged.statusCode).toBe(422);
    expect(await getPersonalProviderCredential(db, userA, "anthropic")).toBeNull();
    expect((await getPersonalProviderCredential(db, userB, "anthropic"))?.revision).toBe(1);

    const responses = await Promise.all(["first", "second"].map((value) => app.inject({
      method: "PUT", url: "/api/account/provider-credentials/anthropic",
      headers: auth(userB), payload: { apiKey: `b-${value}`, expectedRevision: 1 },
    })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const current = await getPersonalProviderCredential(db, userB, "anthropic");
    expect(current?.revision).toBe(2);
    expect(current?.validationStatus).toBe("unverified");
  });
});
