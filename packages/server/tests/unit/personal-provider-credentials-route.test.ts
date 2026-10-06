import { afterEach, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import {
  type PersonalProviderCredentialRecord,
  type PersonalProviderId,
} from "@nautilo/db";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
import {
  PERSONAL_PROVIDER_KEY_CATALOGUE,
  orderProviderKeys,
} from "@nautilo/types";
import {
  personalProviderCredentialRoutes,
  type PersonalProviderCredentialRouteDeps,
} from "../../src/routes/personal-provider-credentials";
import { PERSONAL_CHAT_PROVIDER_IDS } from "../../src/lib/model-funding";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const CREATED_AT = new Date("2026-09-28T10:00:00.000Z");
const UPDATED_AT = new Date("2026-09-28T10:01:00.000Z");
const SENTINEL = "sk-personal-sentinel-never-disclose";
const ORIGINAL_GATEWAY_BASE_URL = process.env["NAUTILO_GATEWAY_BASE_URL"];

type AuditEvent = Parameters<NonNullable<PersonalProviderCredentialRouteDeps["auditEvent"]>>[1];
type ValidationResult = Awaited<ReturnType<NonNullable<PersonalProviderCredentialRouteDeps["validate"]>>>;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  if (ORIGINAL_GATEWAY_BASE_URL === undefined) {
    delete process.env["NAUTILO_GATEWAY_BASE_URL"];
  } else {
    process.env["NAUTILO_GATEWAY_BASE_URL"] = ORIGINAL_GATEWAY_BASE_URL;
  }
});

function key(userId: string, provider: PersonalProviderId): string {
  return `${userId}:${provider}`;
}

function credential(
  custody: PersonalProviderCustody,
  input: {
    userId: string;
    provider: PersonalProviderId;
    plaintext: string;
    id?: string;
    revision?: number;
    validationStatus?: PersonalProviderCredentialRecord["validationStatus"];
    validatedAt?: Date | null;
    destination?: string | null;
    receiptReadStatus?: PersonalProviderCredentialRecord["receiptReadStatus"];
  },
): PersonalProviderCredentialRecord {
  const id = input.id ?? "33333333-3333-4333-8333-333333333333";
  const revision = input.revision ?? 1;
  return {
    id,
    userId: input.userId,
    provider: input.provider,
    revision,
    validationStatus: input.validationStatus ?? "unverified",
    validatedAt: input.validatedAt ?? null,
    destination: input.destination ?? null,
    receiptReadStatus: input.receiptReadStatus ?? "unknown",
    envelope: encryptPersonalProviderCredential(custody, input.plaintext, {
      userId: input.userId,
      provider: input.provider,
      id,
      revision,
      destination: input.destination ?? null,
    }),
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

type HarnessOptions = {
  readonly custody?: PersonalProviderCustody;
  readonly records?: readonly PersonalProviderCredentialRecord[];
  readonly policy?: () => boolean | Promise<boolean>;
  readonly capabilities?: (userId: string) => readonly string[] | Promise<readonly string[]>;
  readonly validate?: (
    provider: PersonalProviderId,
    apiKey: string,
    destination: string | null,
  ) => Promise<ValidationResult>;
  readonly fail?: ReadonlySet<string>;
  readonly captureLogs?: boolean;
};

async function makeHarness(options: HarnessOptions = {}) {
  const custody = options.custody ?? createPersonalProviderCustody();
  const records = new Map<string, PersonalProviderCredentialRecord>();
  for (const record of options.records ?? []) records.set(key(record.userId, record.provider), record);
  const auditEvents: AuditEvent[] = [];
  const validatedSecrets: Array<{ provider: PersonalProviderId; apiKey: string }> = [];
  const validatedDestinations: Array<string | null> = [];
  const calls: string[] = [];
  const requeuedCredentials: Array<Readonly<{
    payerHumanId: string;
    credentialId: string;
    credentialRevision: number;
  }>> = [];
  const logLines: string[] = [];
  const db = {} as ReturnType<NonNullable<PersonalProviderCredentialRouteDeps["getDb"]>>;
  const fail = options.fail ?? new Set<string>();

  function maybeFail(name: string): void {
    calls.push(name);
    if (fail.has(name)) throw new Error(`${name} failed and echoed ${SENTINEL}`);
  }

  const deps: PersonalProviderCredentialRouteDeps = {
    getDb: () => db,
    getPolicy: async () => {
      maybeFail("policy");
      return { allowPersonalProviderKeys: await (options.policy?.() ?? true), fundingPreference: "personal_first" };
    },
    getCapabilities: async (userId) => {
      maybeFail("capabilities");
      return [...await (options.capabilities?.(userId) ?? ["use_personal_provider_credentials"])];
    },
    readCustody: async () => {
      maybeFail("custody");
      return custody;
    },
    getCredential: async (_db, userId, provider) => {
      maybeFail("get");
      return records.get(key(userId, provider)) ?? null;
    },
    listCredentials: async (_db, userId) => {
      maybeFail("list");
      return [...records.values()]
        .filter((record) => record.userId === userId)
        .sort((left, right) => left.provider.localeCompare(right.provider));
    },
    insertCredential: async (_db, input) => {
      maybeFail("insert");
      const recordKey = key(input.userId, input.provider);
      if (records.has(recordKey)) return { status: "already_exists" };
      const created: PersonalProviderCredentialRecord = {
        id: input.identity.id,
        userId: input.userId,
        provider: input.provider,
        revision: input.identity.revision,
        validationStatus: input.validationStatus ?? "unverified",
        validatedAt: input.validatedAt ?? null,
        destination: input.destination ?? null,
        receiptReadStatus: input.receiptReadStatus ?? "unknown",
        envelope: input.envelope,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      };
      records.set(recordKey, created);
      return { status: "created", credential: created };
    },
    replaceCredential: async (_db, input) => {
      maybeFail("replace");
      const recordKey = key(input.userId, input.provider);
      const current = records.get(recordKey);
      if (!current || current.id !== input.id) return { status: "not_found" };
      if (current.revision !== input.expectedRevision) {
        return { status: "conflict", currentRevision: current.revision };
      }
      const replacement: PersonalProviderCredentialRecord = {
        ...current,
        revision: input.expectedRevision + 1,
        validationStatus: input.validationStatus ?? "unverified",
        validatedAt: input.validatedAt ?? null,
        destination: input.destination === undefined
          ? current.destination
          : input.destination,
        receiptReadStatus: input.receiptReadStatus ?? "unknown",
        envelope: input.envelope,
        updatedAt: UPDATED_AT,
      };
      records.set(recordKey, replacement);
      return { status: "replaced", credential: replacement };
    },
    deleteCredential: async (_db, input) => {
      maybeFail("delete");
      const recordKey = key(input.userId, input.provider);
      const current = records.get(recordKey);
      if (!current || current.id !== input.id) return { status: "not_found" };
      if (current.revision !== input.expectedRevision) {
        return { status: "conflict", currentRevision: current.revision };
      }
      records.delete(recordKey);
      return { status: "deleted" };
    },
    setValidation: async (_db, input) => {
      maybeFail("setValidation");
      const current = records.get(key(input.userId, input.provider));
      if (!current || current.id !== input.id || current.revision !== input.expectedRevision) {
        return { status: "stale" };
      }
      const updated: PersonalProviderCredentialRecord = {
        ...current,
        validationStatus: input.status,
        validatedAt: input.validatedAt,
        receiptReadStatus: input.receiptReadStatus ?? current.receiptReadStatus,
        updatedAt: UPDATED_AT,
      };
      records.set(key(input.userId, input.provider), updated);
      return { status: "updated", credential: updated };
    },
    validate: async (provider, apiKey, _signal, destination) => {
      maybeFail("validate");
      validatedSecrets.push({ provider, apiKey });
      validatedDestinations.push(destination ?? null);
      return options.validate?.(provider, apiKey, destination ?? null) ?? {
        status: (PERSONAL_CHAT_PROVIDER_IDS as readonly string[]).includes(provider)
          ? "accepted"
          : "unverified",
        receiptReadStatus: "unknown",
      };
    },
    requeueBlockedSurplusAttempts: async (input) => {
      maybeFail("requeueBlockedSurplusAttempts");
      requeuedCredentials.push(input);
      return 0;
    },
    auditEvent: (_request, event) => {
      maybeFail("audit");
      auditEvents.push(event);
    },
  };

  const app = options.captureLogs
    ? Fastify({
      logger: {
        level: "info",
        stream: { write: (message: string) => { logLines.push(message); } },
      },
    })
    : Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const header = request.headers["x-test-user"];
    request.sessionUserId = typeof header === "string" && header !== "anonymous" ? header : null;
  });
  personalProviderCredentialRoutes(app, deps);
  apps.push(app);
  await app.ready();
  return {
    app, auditEvents, calls, custody, logLines, records,
    requeuedCredentials, validatedDestinations, validatedSecrets,
  };
}

function auth(userId = USER_A) {
  return { "x-test-user": userId };
}

function body(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe("personal provider credential routes", () => {
  test("projects the canonical server key registry without configuration internals", async () => {
    const harness = await makeHarness();
    const response = await harness.app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(),
    });

    expect(response.statusCode).toBe(200);
    const result = body(response);
    expect(result["credentials"]).toEqual([]);
    const providers = result["providers"] as Array<Record<string, unknown>>;
    const definitions = orderProviderKeys(PERSONAL_PROVIDER_KEY_CATALOGUE);
    expect(providers.map(({ id }) => id)).toEqual(definitions.map(({ id }) => id));
    expect(providers).toEqual(definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
      purpose: definition.purpose,
      ...(definition.signupUrl ? { signupUrl: definition.signupUrl } : {}),
      ...(definition.formatHint ? { formatHint: definition.formatHint } : {}),
      personalCapabilities: definition.personalCapabilities,
    })));
    const serializedProviders = JSON.stringify(providers);
    expect(serializedProviders).not.toContain("envVar");
    expect(serializedProviders).not.toContain("formatCheck");
    expect(serializedProviders).not.toContain("doctorHints");
    expect(providers.find(({ id }) => id === "openai")?.["purpose"]).toBe(
      "OpenAI text models; embeddings remain server-managed",
    );
    expect(providers.some(({ id }) => id === "gateway" || id === "nautilo-gateway")).toBe(false);
    const personalChatIds = definitions
      .filter(({ personalCapabilities }) => personalCapabilities.includes("chat"))
      .map(({ id }) => id);
    expect([...personalChatIds].sort()).toEqual(
      (PERSONAL_CHAT_PROVIDER_IDS as readonly string[])
        .filter((id) => definitions.some((definition) => definition.id === id))
        .sort(),
    );
    for (const definition of definitions) {
      expect(serializedProviders).not.toContain(definition.envVar);
    }
  });

  test("requires an authenticated Human before every operation", async () => {
    const harness = await makeHarness();
    const requests = [
      { method: "GET", url: "/api/account/provider-credentials" },
      { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: SENTINEL } },
      { method: "POST", url: "/api/account/provider-credentials/openai/validate", payload: { expectedRevision: 1 } },
      { method: "DELETE", url: "/api/account/provider-credentials/openai", payload: { expectedRevision: 1 } },
    ] as const;

    for (const request of requests) {
      const response = await harness.app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(body(response)).toEqual({
        error: "authentication_required", committed: false, retryable: false, repair: null,
      });
    }
    expect(harness.calls).toEqual([]);
  });

  test("reads the live server switch and capability for every operation", async () => {
    let enabled = false;
    let capable = true;
    const harness = await makeHarness({
      policy: () => enabled,
      capabilities: () => capable ? ["use_personal_provider_credentials"] : [],
    });

    const off = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(off.statusCode).toBe(404);
    expect(body(off)["error"]).toBe("personal_credentials_disabled");

    enabled = true;
    capable = false;
    const forbidden = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(body(forbidden)["error"]).toBe("personal_credentials_forbidden");

    capable = true;
    const created = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(created.statusCode).toBe(200);

    for (const request of [
      { method: "GET", url: "/api/account/provider-credentials" },
      { method: "POST", url: "/api/account/provider-credentials/openai/validate", payload: { expectedRevision: 1 } },
      { method: "DELETE", url: "/api/account/provider-credentials/openai", payload: { expectedRevision: 1 } },
    ] as const) {
      capable = false;
      const denied = await harness.app.inject({ ...request, headers: auth() });
      expect(denied.statusCode).toBe(403);
      capable = true;
      const admitted = await harness.app.inject({ ...request, headers: auth() });
      expect(admitted.statusCode).toBe(200);
    }
  });

  test("executes create, safe metadata, replace, validation, and idempotent delete", async () => {
    const harness = await makeHarness();
    const created = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(created.statusCode).toBe(200);
    expect(body(created)).toMatchObject({
      committed: true,
      credential: {
        provider: "openai", revision: 1, validationStatus: "accepted",
        receiptReadStatus: "unknown", destination: null,
        requiresReplacement: false, masked: "sk-perso...",
      },
    });
    const first = harness.records.get(key(USER_A, "openai"))!;
    expect(decryptPersonalProviderCredential(harness.custody, first.envelope, first)).toBe(SENTINEL);

    const listed = await harness.app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(),
    });
    expect(listed.statusCode).toBe(200);
    expect(body(listed)["credentials"]).toEqual([
      expect.objectContaining({ revision: 1, masked: "sk-perso..." }),
    ]);

    const replacementSecret = `${SENTINEL}-replacement`;
    const replaced = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: replacementSecret, expectedRevision: 1 },
    });
    expect(replaced.statusCode).toBe(200);
    expect(body(replaced)).toMatchObject({
      committed: true,
      credential: { revision: 2, masked: "sk-perso..." },
    });
    const second = harness.records.get(key(USER_A, "openai"))!;
    expect(second.id).toBe(first.id);
    expect(decryptPersonalProviderCredential(harness.custody, second.envelope, second)).toBe(replacementSecret);

    const validated = await harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/openai/validate",
      headers: auth(), payload: { expectedRevision: 2 },
    });
    expect(validated.statusCode).toBe(200);
    expect(body(validated)).toMatchObject({
      committed: false,
      credential: { revision: 2, validationStatus: "accepted", masked: "sk-perso..." },
    });
    expect(harness.validatedSecrets).toEqual([
      { provider: "openai", apiKey: SENTINEL },
      { provider: "openai", apiKey: replacementSecret },
      { provider: "openai", apiKey: replacementSecret },
    ]);

    const deleted = await harness.app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { expectedRevision: 2 },
    });
    expect(deleted.statusCode).toBe(200);
    expect(body(deleted)).toEqual({ deleted: true, committed: true });
    expect(harness.records.has(key(USER_A, "openai"))).toBe(false);

    const repeated = await harness.app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { expectedRevision: 2 },
    });
    expect(repeated.statusCode).toBe(200);
    expect(body(repeated)).toEqual({ deleted: true, committed: true });
    expect(harness.auditEvents.map((event) => event.action)).toEqual([
      "created", "replaced", "validated", "deleted",
    ]);

    const publicMaterial = [created.body, listed.body, replaced.body, validated.body, deleted.body, JSON.stringify(harness.auditEvents)].join("\n");
    expect(publicMaterial).not.toContain(SENTINEL);
    expect(publicMaterial).not.toContain(first.envelope.ciphertextBase64);
    expect(publicMaterial).not.toContain(second.envelope.ciphertextBase64);
    expect(harness.auditEvents.map((event) => ({
      actorId: event.actorId,
      provider: event.provider,
      credentialId: event.credentialId,
      revision: event.revision,
      action: event.action,
      validationStatus: event.validationStatus ?? null,
    }))).toEqual([
      { actorId: USER_A, provider: "openai", credentialId: first.id, revision: 1, action: "created", validationStatus: null },
      { actorId: USER_A, provider: "openai", credentialId: first.id, revision: 2, action: "replaced", validationStatus: null },
      { actorId: USER_A, provider: "openai", credentialId: first.id, revision: 2, action: "validated", validationStatus: "accepted" },
      { actorId: USER_A, provider: "openai", credentialId: first.id, revision: 2, action: "deleted", validationStatus: null },
    ]);
  });

  test("fully masks credentials too short for the canonical prefix preview", async () => {
    const harness = await makeHarness();
    const response = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/typesafe",
      headers: auth(), payload: { apiKey: "tiny" },
    });
    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({ credential: { masked: "********" } });
    expect(response.body).not.toContain("tiny");
  });

  test("stores a canonical non-chat provider without leaking it or granting chat capability", async () => {
    const harness = await makeHarness();
    const created = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/tavily",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain(SENTINEL);

    const saved = harness.records.get(key(USER_A, "tavily"))!;
    expect(decryptPersonalProviderCredential(harness.custody, saved.envelope, saved)).toBe(SENTINEL);

    const listed = await harness.app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(SENTINEL);
    const result = body(listed);
    expect(result["credentials"]).toEqual([
      expect.objectContaining({ provider: "tavily", validationStatus: "unverified" }),
    ]);
    expect((result["providers"] as Array<Record<string, unknown>>)
      .find(({ id }) => id === "tavily")?.["personalCapabilities"]).toEqual([]);
  });

  test("saves Surplus inference readiness while warning separately about receipt access", async () => {
    const harness = await makeHarness({
      validate: async (provider) => provider === "surplus"
        ? { status: "accepted", receiptReadStatus: "unavailable" }
        : { status: "unverified", receiptReadStatus: "unknown" },
    });
    const response = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/surplus",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      committed: true,
      credential: {
        provider: "surplus",
        validationStatus: "accepted",
        receiptReadStatus: "unavailable",
        destination: null,
        requiresReplacement: false,
      },
    });
    expect(response.body).not.toContain(SENTINEL);
    expect(harness.requeuedCredentials).toEqual([]);
  });

  test("requeues only the exact Surplus credential revision after receipt access is repaired", async () => {
    let validationCount = 0;
    const harness = await makeHarness({
      validate: async () => {
        validationCount += 1;
        return {
          status: "accepted",
          receiptReadStatus: validationCount === 1 ? "unavailable" : "available",
        };
      },
    });
    const saved = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/surplus",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(saved.statusCode).toBe(200);
    const savedCredential = body(saved)["credential"] as Record<string, unknown>;
    const credentialId = savedCredential["id"];
    if (typeof credentialId !== "string") {
      throw new Error("Saved credential response lacked an ID");
    }
    const validated = await harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/surplus/validate",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    expect(validated.statusCode).toBe(200);
    expect(harness.requeuedCredentials).toEqual([{
      payerHumanId: USER_A,
      credentialId,
      credentialRevision: 1,
    }]);
  });

  test("lists a legacy Gateway row, flags destination changes, and permits safe deletion", async () => {
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://gateway.example/tenant-a/v1///";
    const custody = createPersonalProviderCustody();
    const existing = credential(custody, {
      userId: USER_A,
      provider: "gateway",
      plaintext: SENTINEL,
      destination: "https://gateway.example/tenant-a/v1",
    });
    const harness = await makeHarness({ custody, records: [existing] });

    process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://gateway.example/tenant-b/v1";
    const listed = await harness.app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(),
    });
    const listedBody = body(listed);
    expect(listedBody).toMatchObject({
      credentials: [{
        provider: "gateway",
        destination: "https://gateway.example/tenant-a/v1",
        requiresReplacement: true,
      }],
    });
    const providerRows = listedBody["providers"] as Array<Record<string, unknown>>;
    expect(providerRows.some(({ id }) => id === "gateway")).toBe(false);
    const validation = await harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/gateway/validate",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    expect(validation.statusCode).toBe(422);
    expect(body(validation)).toEqual({
      error: "invalid_provider", committed: false, retryable: false, repair: null,
    });
    const deleted = await harness.app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/gateway",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    expect(deleted.statusCode).toBe(200);
    expect(harness.records.has(key(USER_A, "gateway"))).toBe(false);
  });

  test("does not replace a retained personal Gateway key", async () => {
    process.env["NAUTILO_GATEWAY_BASE_URL"] = "https://gateway.example/tenant-a/v1";
    const custody = createPersonalProviderCustody();
    const existing = credential(custody, {
      userId: USER_A, provider: "gateway", plaintext: `${SENTINEL}-old`,
      destination: "https://gateway.example/tenant-a/v1",
    });
    const harness = await makeHarness({
      custody,
      records: [existing],
    });
    const response = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/gateway",
      headers: auth(), payload: { apiKey: SENTINEL, expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(422);
    expect(body(response)).toEqual({
      error: "invalid_provider", committed: false, retryable: false, repair: null,
    });
    expect(harness.records.get(key(USER_A, "gateway"))).toEqual(existing);
    expect(harness.auditEvents).toEqual([]);
  });

  test("rejects new removed or unavailable providers while preserving revision conflict semantics", async () => {
    const harness = await makeHarness();
    for (const provider of ["nautilo-gateway", "gateway"] as const) {
      const response = await harness.app.inject({
        method: "PUT", url: `/api/account/provider-credentials/${provider}`,
        headers: auth(), payload: { apiKey: SENTINEL },
      });
      expect(response.statusCode).toBe(422);
      expect(body(response)).toEqual({
        error: "invalid_provider", committed: false, retryable: false, repair: null,
      });
    }

    const fencedRetry = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/xai",
      headers: auth(), payload: { apiKey: SENTINEL, expectedRevision: 1 },
    });
    expect(fencedRetry.statusCode).toBe(409);
    expect(body(fencedRetry)).toEqual({
      error: "credential_conflict", committed: false,
      retryable: false, repair: "reread_metadata",
    });
    expect(harness.records.size).toBe(0);
    expect(harness.auditEvents).toEqual([]);
  });

  test("keeps supported creation and retained-row replacement actor-scoped", async () => {
    for (const provider of ["xai", "together", "nautilo-gateway"] as const) {
      const custody = createPersonalProviderCustody();
      const existing = credential(custody, {
        userId: USER_A, provider, plaintext: `${SENTINEL}-old-${provider}`,
      });
      const harness = await makeHarness({ custody, records: [existing] });
      const replacementSecret = `${SENTINEL}-new-${provider}`;

      const response = await harness.app.inject({
        method: "PUT", url: `/api/account/provider-credentials/${provider}`,
        headers: auth(), payload: { apiKey: replacementSecret, expectedRevision: 1 },
      });

      expect(response.statusCode).toBe(200);
      expect(body(response)).toMatchObject({
        committed: true, credential: { provider, id: existing.id, revision: 2 },
      });
      const replaced = harness.records.get(key(USER_A, provider))!;
      expect(decryptPersonalProviderCredential(custody, replaced.envelope, replaced))
        .toBe(replacementSecret);
      expect(harness.auditEvents).toHaveLength(1);
      expect(harness.auditEvents[0]).toMatchObject({
        actorId: USER_A, provider, credentialId: existing.id, revision: 2, action: "replaced",
      });
    }

    const custody = createPersonalProviderCustody();
    const foreign = credential(custody, {
      userId: USER_B, provider: "xai", plaintext: `${SENTINEL}-foreign-xai`,
    });
    const foreignHarness = await makeHarness({ custody, records: [foreign] });
    const created = await foreignHarness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/xai",
      headers: auth(USER_A), payload: { apiKey: `${SENTINEL}-actor-a` },
    });
    expect(created.statusCode).toBe(200);
    expect(body(created)).toMatchObject({
      committed: true,
      credential: { provider: "xai", revision: 1 },
    });
    expect(foreignHarness.records.has(key(USER_A, "xai"))).toBe(true);
    expect(foreignHarness.records.get(key(USER_B, "xai"))).toEqual(foreign);
    expect(foreignHarness.auditEvents).toHaveLength(1);
  });

  test("derives ownership exclusively from the session and never probes another Human's row", async () => {
    const custody = createPersonalProviderCustody();
    const foreign = credential(custody, { userId: USER_B, provider: "openai", plaintext: `${SENTINEL}-foreign` });
    const harness = await makeHarness({ custody, records: [foreign] });

    const listed = await harness.app.inject({ method: "GET", url: "/api/account/provider-credentials", headers: auth(USER_A) });
    expect(body(listed)["credentials"]).toEqual([]);
    const validateMissing = await harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/openai/validate",
      headers: auth(USER_A), payload: { expectedRevision: 1 },
    });
    expect(validateMissing.statusCode).toBe(404);
    expect(harness.validatedSecrets).toEqual([]);
    const deleteMissing = await harness.app.inject({
      method: "DELETE", url: "/api/account/provider-credentials/openai",
      headers: auth(USER_A), payload: { expectedRevision: 1 },
    });
    expect(deleteMissing.statusCode).toBe(200);
    expect(harness.records.get(key(USER_B, "openai"))).toEqual(foreign);

    const forged = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(USER_A), payload: { apiKey: SENTINEL, userId: USER_B },
    });
    expect(forged.statusCode).toBe(422);
    expect(harness.records.get(key(USER_B, "openai"))).toEqual(foreign);
  });

  test("rejects unsupported providers and non-exact request bodies before custody or database access", async () => {
    const harness = await makeHarness();
    const requests = [
      { method: "PUT", url: "/api/account/provider-credentials/not-a-provider", payload: { apiKey: SENTINEL } },
      { method: "POST", url: "/api/account/provider-credentials/not-a-provider/validate", payload: { expectedRevision: 1 } },
      { method: "DELETE", url: "/api/account/provider-credentials/not-a-provider", payload: { expectedRevision: 1 } },
      { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: " " } },
      { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: SENTINEL, extra: true } },
      { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: SENTINEL, expectedRevision: 0 } },
      { method: "POST", url: "/api/account/provider-credentials/openai/validate", payload: { expectedRevision: 1, userId: USER_B } },
      { method: "DELETE", url: "/api/account/provider-credentials/openai", payload: { expectedRevision: 1.5 } },
    ] as const;
    for (const request of requests) {
      const before = harness.calls.length;
      const response = await harness.app.inject({ ...request, headers: auth() });
      expect(response.statusCode).toBe(422);
      expect(["invalid_provider", "invalid_credential_request"]).toContain(body(response)["error"] as string);
      expect(harness.calls.slice(before)).toEqual(["policy", "capabilities"]);
    }
    expect(harness.records.size).toBe(0);
  });

  test("reports reset-provenance rows as requiring replacement and permits re-enrollment without the lost key", async () => {
    const oldCustody = createPersonalProviderCustody();
    const resetCustody = { ...createPersonalProviderCustody(), resetFromKeyId: oldCustody.keyId };
    const oldRecord = credential(oldCustody, {
      userId: USER_A, provider: "anthropic", plaintext: `${SENTINEL}-lost`,
      validationStatus: "accepted", validatedAt: CREATED_AT,
    });
    const harness = await makeHarness({ custody: resetCustody, records: [oldRecord] });

    const listed = await harness.app.inject({ method: "GET", url: "/api/account/provider-credentials", headers: auth() });
    expect(listed.statusCode).toBe(200);
    expect(body(listed)).toMatchObject({ credentials: [{
      provider: "anthropic", revision: 1, validationStatus: "unverified",
      validatedAt: null, requiresReplacement: true, masked: null,
    }] });

    const blockedValidation = await harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/anthropic/validate",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    expect(blockedValidation.statusCode).toBe(409);
    expect(body(blockedValidation)).toEqual({
      error: "credential_reenrollment_required", committed: false,
      retryable: false, repair: "replace_credential",
    });
    expect(harness.validatedSecrets).toEqual([]);

    const replacementSecret = `${SENTINEL}-reenrolled`;
    const replaced = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/anthropic",
      headers: auth(), payload: { apiKey: replacementSecret, expectedRevision: 1 },
    });
    expect(replaced.statusCode).toBe(200);
    expect(body(replaced)).toMatchObject({
      credential: { revision: 2, requiresReplacement: false, masked: "sk-perso..." },
    });
    const current = harness.records.get(key(USER_A, "anthropic"))!;
    expect(current.envelope.keyId).toBe(resetCustody.keyId);
    expect(decryptPersonalProviderCredential(resetCustody, current.envelope, current)).toBe(replacementSecret);
  });

  test("fails closed with a custody-specific repair when the configured key cannot read a row", async () => {
    const originalCustody = createPersonalProviderCustody();
    const wrongCustody = createPersonalProviderCustody();
    const record = credential(originalCustody, { userId: USER_A, provider: "openai", plaintext: SENTINEL });
    const methods = [
      { method: "GET", url: "/api/account/provider-credentials" },
      { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: `${SENTINEL}-new`, expectedRevision: 1 } },
      { method: "POST", url: "/api/account/provider-credentials/openai/validate", payload: { expectedRevision: 1 } },
      { method: "DELETE", url: "/api/account/provider-credentials/openai", payload: { expectedRevision: 1 } },
    ] as const;
    for (const request of methods) {
      const harness = await makeHarness({ custody: wrongCustody, records: [record] });
      const response = await harness.app.inject({ ...request, headers: auth() });
      expect(response.statusCode).toBe(503);
      expect(body(response)).toEqual({
        error: "credential_custody_unavailable", committed: false,
        retryable: false, repair: "contact_operator",
      });
      expect(harness.records.get(key(USER_A, "openai"))).toEqual(record);
      expect(harness.validatedSecrets).toEqual([]);
      expect(JSON.stringify(body(response))).not.toContain(SENTINEL);
    }
  });

  test("classifies policy, capability, custody, and database failures without leaking causes", async () => {
    const custody = createPersonalProviderCustody();
    const record = credential(custody, { userId: USER_A, provider: "openai", plaintext: SENTINEL });
    const admissionFailures = [
      { fail: "policy", expected: "personal_credentials_unavailable" },
      { fail: "capabilities", expected: "personal_credentials_unavailable" },
      { fail: "custody", expected: "credential_custody_unavailable" },
    ] as const;
    for (const entry of admissionFailures) {
      const harness = await makeHarness({ custody, records: [record], fail: new Set([entry.fail]) });
      const response = await harness.app.inject({ method: "GET", url: "/api/account/provider-credentials", headers: auth() });
      expect(response.statusCode).toBe(503);
      expect(body(response)["error"]).toBe(entry.expected);
      expect(response.body).not.toContain(SENTINEL);
    }

    const dbFailures = [
      { fail: "list", method: "GET", url: "/api/account/provider-credentials", repair: "retry" },
      { fail: "get", method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: SENTINEL, expectedRevision: 1 }, repair: "reread_metadata" },
      { fail: "get", method: "POST", url: "/api/account/provider-credentials/openai/validate", payload: { expectedRevision: 1 }, repair: "retry_validation" },
      { fail: "get", method: "DELETE", url: "/api/account/provider-credentials/openai", payload: { expectedRevision: 1 }, repair: "reread_metadata" },
    ] as const;
    for (const entry of dbFailures) {
      const harness = await makeHarness({ custody, records: [record], fail: new Set([entry.fail]) });
      const response = await harness.app.inject({ ...entry, headers: auth() });
      expect(response.statusCode).toBe(503);
      expect(body(response)).toEqual({
        error: "personal_credentials_unavailable", committed: false,
        retryable: true, repair: entry.repair,
      });
      expect(response.body).not.toContain(SENTINEL);
    }
  });

  test("turns write conflicts into a non-committed reread response and preserves the prior record", async () => {
    const custody = createPersonalProviderCustody();
    const current = credential(custody, { userId: USER_A, provider: "openai", plaintext: SENTINEL, revision: 2 });
    const harness = await makeHarness({ custody, records: [current] });

    for (const request of [
      { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: `${SENTINEL}-new`, expectedRevision: 1 } },
      { method: "POST", url: "/api/account/provider-credentials/openai/validate", payload: { expectedRevision: 1 } },
      { method: "DELETE", url: "/api/account/provider-credentials/openai", payload: { expectedRevision: 1 } },
    ] as const) {
      const response = await harness.app.inject({ ...request, headers: auth() });
      expect(response.statusCode).toBe(409);
      expect(body(response)).toEqual({
        error: "credential_conflict", committed: false,
        retryable: false, repair: "reread_metadata",
      });
    }
    expect(harness.records.get(key(USER_A, "openai"))).toEqual(current);
    expect(harness.validatedSecrets).toEqual([]);
    expect(harness.auditEvents).toEqual([]);
  });

  test("does not publish a late validation result over a replacement revision", async () => {
    const custody = createPersonalProviderCustody();
    const original = credential(custody, { userId: USER_A, provider: "openai", plaintext: SENTINEL });
    const validation = deferred<ValidationResult>();
    let validationCalls = 0;
    const harness = await makeHarness({
      custody,
      records: [original],
      validate: () => {
        validationCalls += 1;
        return validationCalls === 1
          ? validation.promise
          : Promise.resolve({ status: "accepted", receiptReadStatus: "unknown" });
      },
    });

    const pending = harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/openai/validate",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    while (harness.validatedSecrets.length === 0) await Bun.sleep(1);
    const replaced = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: `${SENTINEL}-new`, expectedRevision: 1 },
    });
    expect(replaced.statusCode).toBe(200);
    validation.resolve({ status: "accepted", receiptReadStatus: "unknown" });

    const stale = await pending;
    expect(stale.statusCode).toBe(409);
    expect(body(stale)["error"]).toBe("credential_conflict");
    expect(harness.records.get(key(USER_A, "openai"))).toMatchObject({
      revision: 2, validationStatus: "accepted",
    });
    expect(harness.auditEvents.map((event) => event.action)).toEqual(["replaced"]);
  });

  test("rechecks policy and capability after provider validation and before publishing status", async () => {
    const custody = createPersonalProviderCustody();
    const record = credential(custody, { userId: USER_A, provider: "openai", plaintext: SENTINEL });

    for (const revoked of ["policy", "capability"] as const) {
      let enabled = true;
      let capable = true;
      const validation = deferred<ValidationResult>();
      const harness = await makeHarness({
        custody,
        records: [record],
        policy: () => enabled,
        capabilities: () => capable ? ["use_personal_provider_credentials"] : [],
        validate: () => validation.promise,
      });
      const pending = harness.app.inject({
        method: "POST", url: "/api/account/provider-credentials/openai/validate",
        headers: auth(), payload: { expectedRevision: 1 },
      });
      while (harness.validatedSecrets.length === 0) await Bun.sleep(1);
      if (revoked === "policy") enabled = false;
      else capable = false;
      validation.resolve({ status: "accepted" });

      const response = await pending;
      expect(response.statusCode).toBe(revoked === "policy" ? 404 : 403);
      expect(body(response)["error"]).toBe(
        revoked === "policy" ? "personal_credentials_disabled" : "personal_credentials_forbidden",
      );
      expect(harness.calls.filter((call) => call === "setValidation")).toEqual([]);
      expect(harness.records.get(key(USER_A, "openai"))).toMatchObject({ validationStatus: "unverified" });
      expect(harness.auditEvents).toEqual([]);
    }
  });

  test("sanitizes provider and persistence exceptions and never audits an uncommitted mutation", async () => {
    const custody = createPersonalProviderCustody();
    const record = credential(custody, { userId: USER_A, provider: "openai", plaintext: SENTINEL });
    const providerFailure = await makeHarness({
      custody,
      records: [record],
      validate: async () => { throw new Error(`provider echoed ${SENTINEL}`); },
    });
    const validation = await providerFailure.app.inject({
      method: "POST", url: "/api/account/provider-credentials/openai/validate",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    expect(validation.statusCode).toBe(503);
    expect(body(validation)).toEqual({
      error: "personal_credentials_unavailable", committed: false,
      retryable: true, repair: "retry_validation",
    });
    expect(validation.body).not.toContain(SENTINEL);
    expect(providerFailure.auditEvents).toEqual([]);

    const persistenceFailures = [
      {
        fail: "insert", records: [], repair: "reread_metadata",
        request: { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: SENTINEL } },
      },
      {
        fail: "replace", records: [record], repair: "reread_metadata",
        request: { method: "PUT", url: "/api/account/provider-credentials/openai", payload: { apiKey: `${SENTINEL}-new`, expectedRevision: 1 } },
      },
      {
        fail: "setValidation", records: [record], repair: "retry_validation",
        request: { method: "POST", url: "/api/account/provider-credentials/openai/validate", payload: { expectedRevision: 1 } },
      },
      {
        fail: "delete", records: [record], repair: "reread_metadata",
        request: { method: "DELETE", url: "/api/account/provider-credentials/openai", payload: { expectedRevision: 1 } },
      },
    ] as const;
    for (const scenario of persistenceFailures) {
      const harness = await makeHarness({
        custody, records: scenario.records, fail: new Set([scenario.fail]),
      });
      const response = await harness.app.inject({ ...scenario.request, headers: auth() });
      expect(response.statusCode).toBe(503);
      expect(body(response)).toEqual({
        error: "personal_credentials_unavailable", committed: false,
        retryable: true, repair: scenario.repair,
      });
      expect(response.body).not.toContain(SENTINEL);
      expect(harness.records.get(key(USER_A, "openai"))).toEqual(
        scenario.records.length === 0 ? undefined : record,
      );
      expect(harness.auditEvents).toEqual([]);
    }
  });

  test("keeps committed success truthful when the audit sink fails", async () => {
    const harness = await makeHarness({ fail: new Set(["audit"]) });
    const response = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: SENTINEL },
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({ committed: true, credential: { revision: 1 } });
    const saved = harness.records.get(key(USER_A, "openai"))!;
    expect(decryptPersonalProviderCredential(harness.custody, saved.envelope, saved)).toBe(SENTINEL);
    expect(harness.auditEvents).toEqual([]);
  });

  test("keeps a saved key after automatic validation fails so retry needs no new secret", async () => {
    let attempts = 0;
    const harness = await makeHarness({
      validate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(`provider outage echoed ${SENTINEL}`);
        return { status: "accepted", receiptReadStatus: "unknown" };
      },
    });
    const saved = await harness.app.inject({
      method: "PUT", url: "/api/account/provider-credentials/openai",
      headers: auth(), payload: { apiKey: SENTINEL },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(SENTINEL);
    expect(saved.body).toContain('"validationStatus":"unavailable"');
    const listed = await harness.app.inject({
      method: "GET", url: "/api/account/provider-credentials", headers: auth(),
    });
    expect(listed.body).toContain('"validationStatus":"unavailable"');
    const retried = await harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/openai/validate",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.body).toContain('"validationStatus":"accepted"');
    expect(harness.validatedSecrets).toEqual([
      { provider: "openai", apiKey: SENTINEL },
      { provider: "openai", apiKey: SENTINEL },
    ]);
  });

  test("keeps submitted keys and caught provider errors out of ordinary Fastify logs", async () => {
    const custody = createPersonalProviderCustody();
    const record = credential(custody, { userId: USER_A, provider: "openai", plaintext: SENTINEL });
    const harness = await makeHarness({
      custody,
      records: [record],
      captureLogs: true,
      validate: async () => { throw new Error(`provider echoed ${SENTINEL}`); },
    });
    const response = await harness.app.inject({
      method: "POST", url: "/api/account/provider-credentials/openai/validate",
      headers: auth(), payload: { expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(503);
    await harness.app.close();
    apps.splice(apps.indexOf(harness.app), 1);

    const logs = harness.logLines.join("\n");
    expect(logs).toBe("");
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain(record.envelope.ciphertextBase64);
  });
});
