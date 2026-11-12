import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { getAllKeyDefinitions } from "@nautilo/config-guard";
import { orderProviderKeys } from "@nautilo/types";
import {
  createDirectDb,
  ensureDatabase,
  eq,
  getPersonalProviderCredential,
  personalProviderCredentials,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import { personalProviderCredentialRoutes } from "../../src/routes/personal-provider-credentials";

const SENTINEL = "personal-credential-integration-secret";
const MINDSWAPPER_KEY = `ngw_${"a".repeat(43)}`;
const MINDSWAPPER_REPLACEMENT_KEY = `ngw_${"b".repeat(43)}`;
const MINDSWAPPER_DESTINATION = "https://personal-mindswapper.example/v1";
const MINDSWAPPER_REPLACEMENT_DESTINATION = "https://personal-mindswapper.example/tenant/v1";
const originalApprovedDestinations = process.env["MINDSWAPPER_APPROVED_BASE_URLS"];
const validationCalls: Array<{ provider: string; apiKey: string; destination: string | null }> = [];
let db: DirectDatabase;
let app: FastifyInstance;
let custody: PersonalProviderCustody;
let userA: string;
let userB: string;
let allowPersonalProviderKeys = true;

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

  custody = createPersonalProviderCustody();
  app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const header = request.headers["x-test-user"];
    request.sessionUserId = typeof header === "string" ? header : null;
  });
  personalProviderCredentialRoutes(app, {
    getDb: () => db,
    getPolicy: async () => ({ allowPersonalProviderKeys, fundingPreference: "personal_first" }),
    getCapabilities: async () => ["use_personal_provider_credentials"],
    readCustody: async () => custody,
    validate: async (provider, apiKey, _signal, destination) => {
      validationCalls.push({ provider, apiKey, destination: destination ?? null });
      return { status: "accepted" };
    },
    auditEvent: () => undefined,
  });
  await app.ready();
});

afterEach(async () => {
  allowPersonalProviderKeys = true;
  validationCalls.length = 0;
  if (originalApprovedDestinations === undefined) delete process.env["MINDSWAPPER_APPROVED_BASE_URLS"];
  else process.env["MINDSWAPPER_APPROVED_BASE_URLS"] = originalApprovedDestinations;
  if (!db) return;
  for (const userId of [userA, userB]) {
    if (userId) await db.delete(personalProviderCredentials)
      .where(eq(personalProviderCredentials.userId, userId));
  }
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
  test("keeps policy-off cleanup owner-scoped and revision-fenced", async () => {
    allowPersonalProviderKeys = false;
    const empty = await app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(userA),
    });
    expect(empty.statusCode).toBe(200);
    expect(responseBody(empty)).toMatchObject({
      allowPersonalProviderKeys: false,
      credentials: [],
    });

    allowPersonalProviderKeys = true;
    for (const [userId, provider] of [[userA, "openai"], [userB, "anthropic"]] as const) {
      const created = await app.inject({
        method: "PUT", url: `/api/account/provider-credentials/${provider}`,
        headers: auth(userId), payload: { apiKey: `${SENTINEL}-${provider}` },
      });
      expect(created.statusCode).toBe(200);
    }

    allowPersonalProviderKeys = false;
    const listed = await app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(userA),
    });
    expect(listed.statusCode).toBe(200);
    expect(responseBody(listed)).toMatchObject({
      allowPersonalProviderKeys: false,
      credentials: [{ provider: "openai", revision: 1, masked: null }],
    });
    expect(listed.body).not.toContain(SENTINEL);
    expect(listed.body).not.toContain("ciphertextBase64");

    const stale = await app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(userA), payload: { expectedRevision: 2 },
    });
    expect(stale.statusCode).toBe(409);

    const foreign = await app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(userB), payload: { expectedRevision: 1 },
    });
    expect(foreign.statusCode).toBe(200);
    expect(await getPersonalProviderCredential(db, userA, "openai")).not.toBeNull();

    const deleted = await app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(userA), payload: { expectedRevision: 1 },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await getPersonalProviderCredential(db, userA, "openai")).toBeNull();
    expect(await getPersonalProviderCredential(db, userB, "anthropic")).not.toBeNull();

    for (const request of [
      {
        method: "PUT",
        url: "/api/account/provider-credentials/openai",
        payload: { apiKey: `${SENTINEL}-blocked` },
      },
      {
        method: "POST",
        url: "/api/account/provider-credentials/anthropic/validate",
        payload: { expectedRevision: 1 },
      },
    ] as const) {
      const response = await app.inject({ ...request, headers: auth(userB) });
      expect(response.statusCode).toBe(404);
      expect(responseBody(response)["error"]).toBe("personal_credentials_disabled");
    }
  });

  test("personal providers follow the server registry without its server-owned gateways", async () => {
    process.env["MINDSWAPPER_APPROVED_BASE_URLS"] = MINDSWAPPER_DESTINATION;
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
        headers: auth(userB),
        payload: provider.id === "mindswapper"
          ? { apiKey: MINDSWAPPER_KEY, destination: MINDSWAPPER_DESTINATION }
          : { apiKey: SENTINEL },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(SENTINEL);
    }
    const listed = await app.inject({
      method: "GET", url: "/api/account/provider-credentials?includeMindSwapper=1", headers: auth(userB),
    });
    const body = responseBody(listed);
    const providers = body["providers"] as Array<{ id: string; personalCapabilities: string[] }>;
    expect(providers.map((provider) => provider.id)).toEqual(orderProviderKeys(registry).map((provider) => provider.id));
    expect(providers.filter((provider) => provider.personalCapabilities.includes("chat"))
      .map((provider) => provider.id).sort())
      .toEqual(["anthropic", "fireworks", "google", "mindswapper", "openai", "openrouter", "surplus", "together", "venice", "xai"]);
    expect((body["credentials"] as unknown[]).length).toBe(registry.length);
    expect(listed.body).not.toContain(SENTINEL);
    expect(listed.body).not.toContain(MINDSWAPPER_KEY);
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

  test("rejects MindSwapper destinations before observing or storing the key", async () => {
    process.env["MINDSWAPPER_APPROVED_BASE_URLS"] = MINDSWAPPER_DESTINATION;
    for (const destination of [
      undefined,
      "http://personal-mindswapper.example/v1",
      MINDSWAPPER_DESTINATION + "?redirect=elsewhere",
      "https://other-mindswapper.example/v1",
      MINDSWAPPER_REPLACEMENT_DESTINATION,
    ]) {
      const response = await app.inject({
        method: "PUT", url: "/api/account/provider-credentials/mindswapper",
        headers: auth(userA),
        payload: { apiKey: MINDSWAPPER_KEY, ...(destination === undefined ? {} : { destination }) },
      });
      expect(response.statusCode).toBe(422);
      expect(responseBody(response)["error"]).toBe("credential_destination_unavailable");
      expect(response.body).not.toContain(MINDSWAPPER_KEY);
      expect(await getPersonalProviderCredential(db, userA, "mindswapper")).toBeNull();
    }
    expect(validationCalls).toEqual([]);
  });

  test("binds each Human's encrypted MindSwapper key to its approved destination and replacement revision", async () => {
    process.env["MINDSWAPPER_APPROVED_BASE_URLS"] =
      `${MINDSWAPPER_DESTINATION},${MINDSWAPPER_REPLACEMENT_DESTINATION}`;
    const url = "/api/account/provider-credentials/mindswapper";
    const created = await app.inject({
      method: "PUT", url, headers: auth(userA),
      payload: { apiKey: MINDSWAPPER_KEY, destination: "HTTPS://PERSONAL-MINDSWAPPER.example:443/v1/" },
    });
    expect(created.statusCode).toBe(200);
    expect(responseBody(created)).toMatchObject({
      committed: true,
      credential: {
        destination: MINDSWAPPER_DESTINATION, revision: 1,
        masked: "********", validationStatus: "accepted", requiresReplacement: false,
      },
    });
    expect(validationCalls).toEqual([
      { provider: "mindswapper", apiKey: MINDSWAPPER_KEY, destination: MINDSWAPPER_DESTINATION },
    ]);
    const initial = await getPersonalProviderCredential(db, userA, "mindswapper");
    expect(initial).not.toBeNull();
    expect(decryptPersonalProviderCredential(custody, initial!.envelope, initial!)).toBe(MINDSWAPPER_KEY);
    const [raw] = await db.select().from(personalProviderCredentials)
      .where(eq(personalProviderCredentials.id, initial!.id));
    expect(raw?.destination).toBe(MINDSWAPPER_DESTINATION);
    expect(JSON.stringify(raw)).not.toContain(MINDSWAPPER_KEY);
    expect(created.body).not.toContain(MINDSWAPPER_KEY);
    const checked = await app.inject({
      method: "POST", url: url + "/validate", headers: auth(userA), payload: { expectedRevision: 1 },
    });
    expect(checked.statusCode).toBe(200);
    expect(responseBody(checked)).toMatchObject({
      committed: false,
      credential: { revision: 1, destination: MINDSWAPPER_DESTINATION, validationStatus: "accepted", masked: "********" },
    });
    expect(validationCalls.at(-1)).toEqual({
      provider: "mindswapper", apiKey: MINDSWAPPER_KEY, destination: MINDSWAPPER_DESTINATION,
    });

    const otherListed = await app.inject({
      method: "GET", url: "/api/account/provider-credentials?includeMindSwapper=1", headers: auth(userB),
    });
    expect(responseBody(otherListed)["credentials"]).toEqual([]);
    const foreignValidation = await app.inject({
      method: "POST", url: url + "/validate", headers: auth(userB), payload: { expectedRevision: 1 },
    });
    expect(foreignValidation.statusCode).toBe(404);
    const foreignDeletion = await app.inject({
      method: "DELETE", url, headers: auth(userB), payload: { expectedRevision: 1 },
    });
    expect(foreignDeletion.statusCode).toBe(200);
    expect((await getPersonalProviderCredential(db, userA, "mindswapper"))?.revision).toBe(1);
    expect(validationCalls.length).toBe(2);

    const otherCreated = await app.inject({
      method: "PUT", url, headers: auth(userB),
      payload: { apiKey: MINDSWAPPER_REPLACEMENT_KEY, destination: MINDSWAPPER_REPLACEMENT_DESTINATION },
    });
    expect(otherCreated.statusCode).toBe(200);
    const other = await getPersonalProviderCredential(db, userB, "mindswapper");
    expect(other?.id).not.toBe(initial!.id);
    expect(other?.destination).toBe(MINDSWAPPER_REPLACEMENT_DESTINATION);

    process.env["MINDSWAPPER_APPROVED_BASE_URLS"] = MINDSWAPPER_REPLACEMENT_DESTINATION;
    const listed = await app.inject({
      method: "GET", url: "/api/account/provider-credentials?includeMindSwapper=1", headers: auth(userA),
    });
    expect(responseBody(listed)["credentials"]).toMatchObject([
      { destination: MINDSWAPPER_DESTINATION, revision: 1, requiresReplacement: true, masked: "********" },
    ]);
    expect(listed.body).not.toContain(MINDSWAPPER_KEY);
    expect(listed.body).not.toContain("ciphertextBase64");
    const revokedDestination = await app.inject({
      method: "POST", url: url + "/validate", headers: auth(userA), payload: { expectedRevision: 1 },
    });
    expect(revokedDestination.statusCode).toBe(409);
    expect(responseBody(revokedDestination)["error"]).toBe("credential_destination_changed");
    expect(validationCalls.length).toBe(3);

    const staleReplacement = await app.inject({
      method: "PUT", url, headers: auth(userA),
      payload: { apiKey: MINDSWAPPER_REPLACEMENT_KEY, destination: MINDSWAPPER_REPLACEMENT_DESTINATION, expectedRevision: 2 },
    });
    expect(staleReplacement.statusCode).toBe(409);
    expect(validationCalls.length).toBe(3);
    const replaced = await app.inject({
      method: "PUT", url, headers: auth(userA),
      payload: { apiKey: MINDSWAPPER_REPLACEMENT_KEY, destination: MINDSWAPPER_REPLACEMENT_DESTINATION, expectedRevision: 1 },
    });
    expect(replaced.statusCode).toBe(200);
    expect(responseBody(replaced)["credential"]).toMatchObject({
      id: initial!.id, destination: MINDSWAPPER_REPLACEMENT_DESTINATION,
      revision: 2, requiresReplacement: false, masked: "********",
    });
    const replacement = await getPersonalProviderCredential(db, userA, "mindswapper");
    expect(replacement?.envelope).not.toEqual(initial!.envelope);
    expect(decryptPersonalProviderCredential(custody, replacement!.envelope, replacement!))
      .toBe(MINDSWAPPER_REPLACEMENT_KEY);
    expect(validationCalls.at(-1)).toEqual({
      provider: "mindswapper", apiKey: MINDSWAPPER_REPLACEMENT_KEY, destination: MINDSWAPPER_REPLACEMENT_DESTINATION,
    });
    expect(replaced.body).not.toContain(MINDSWAPPER_REPLACEMENT_KEY);

    const staleDeletion = await app.inject({
      method: "DELETE", url, headers: auth(userA), payload: { expectedRevision: 1 },
    });
    expect(staleDeletion.statusCode).toBe(409);
    const deleted = await app.inject({
      method: "DELETE", url, headers: auth(userA), payload: { expectedRevision: 2 },
    });
    expect(deleted.statusCode).toBe(200);
    expect(await getPersonalProviderCredential(db, userA, "mindswapper")).toBeNull();
    expect(await getPersonalProviderCredential(db, userB, "mindswapper")).toEqual(other);
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
    expect(row!.validationStatus).toBe("accepted");
    expect(row!.validatedAt).not.toBeNull();

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
    expect(replaced.body).toContain('"validationStatus":"accepted"');
    expect(replaced.body).toContain('"revision":2');
    expect((responseBody(replaced)["credential"] as { masked: string }).masked).toBe("replacem...");
    expect((await getPersonalProviderCredential(db, userA, "openai"))?.validatedAt).not.toBeNull();

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
    expect(current?.validationStatus).toBe("accepted");
  });
});
