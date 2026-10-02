import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDirectDb,
  createPersonalProviderCredentialIdentity,
  ensureDatabase,
  eq,
  getCostsSummary,
  getPersonalProviderCredential,
  insertPersonalProviderCredential,
  llmUsageEvents,
  users,
  type DirectDatabase,
  type PersonalProviderId,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createPersonalProviderCustody,
  decryptPersonalProviderCredential,
  encryptPersonalProviderCredential,
} from "@nautilo/operator-secrets";
import {
  resolveModelFunding,
  withAdmittedPersonalProviderKey,
  type ModelFundingDeps,
} from "../../src/lib/model-funding";

let db: DirectDatabase;
const userIds: string[] = [];
const usageIds: string[] = [];
const custody = createPersonalProviderCustody();

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  const created = await db.insert(users).values([
    { name: `funding-a-${randomUUID()}` },
    { name: `funding-b-${randomUUID()}` },
  ]).returning({ id: users.id });
  userIds.push(...created.map((entry) => entry.id));
});

afterAll(async () => {
  if (!db) return;
  for (const id of usageIds) await db.delete(llmUsageEvents).where(eq(llmUsageEvents.id, id));
  for (const id of userIds) await db.delete(users).where(eq(users.id, id));
  await db.end();
});

describe("model funding with migrated personal credential and usage tables", () => {
  test("two Humans keep their own key and exact payer/credential revision across DB boundaries", async () => {
    const credentials = [];
    for (const [index, userId] of userIds.entries()) {
      const identity = createPersonalProviderCredentialIdentity();
      const secret = `synthetic-key-${index}`;
      const inserted = await insertPersonalProviderCredential(db, {
        identity,
        userId,
        provider: "openrouter",
        envelope: encryptPersonalProviderCredential(custody, secret, {
          id: identity.id, revision: identity.revision,
          userId, provider: "openrouter",
        }),
      });
      expect(inserted.status).toBe("created");
      credentials.push({ identity, secret });
    }

    const deps: ModelFundingDeps = {
      getPolicy: async () => ({ allowPersonalProviderKeys: true }),
      getCapabilities: async () => ["use_personal_provider_credentials", "use_server_provider_credentials"],
      getCredential: (userId, provider) => getPersonalProviderCredential(db, userId, provider),
      serverRoute: () => "openrouter",
      readCustody: async () => custody,
      decrypt: decryptPersonalProviderCredential,
    };
    const decisions = await Promise.all(userIds.map((humanUserId) => resolveModelFunding({
      humanUserId, modelId: "openrouter:synthetic/model", workload: "foreground_text_chat",
    }, deps)));

    for (const [index, decision] of decisions.entries()) {
      expect(decision.kind).toBe("personal");
      if (decision.kind !== "personal") throw new Error("Expected personal funding");
      expect(decision.credentialId).toBe(credentials[index]!.identity.id);
      expect(decision.providerRoute).toBe("openrouter");
      expect(await withAdmittedPersonalProviderKey(decision, (key) => key, deps))
        .toBe(credentials[index]!.secret);
      const id = randomUUID();
      usageIds.push(id);
      await db.insert(llmUsageEvents).values({
        id,
        userId: decision.humanUserId,
        callType: "chat",
        provider: "openrouter",
        model: decision.modelId,
        inputTokens: 5, outputTokens: 3,
        estimatedCostUsd: "0.01000000",
        fundingKind: decision.kind,
        payerHumanId: decision.payerHumanId,
        providerRoute: decision.providerRoute,
        credentialId: decision.credentialId,
        credentialRevision: decision.credentialRevision,
      });
    }

    const rows = await db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, usageIds[0]!));
    expect(rows[0]).toMatchObject({
      userId: userIds[0], payerHumanId: userIds[0], fundingKind: "personal",
      providerRoute: "openrouter", credentialId: credentials[0]!.identity.id,
      credentialRevision: 1,
    });
    expect(JSON.stringify(rows[0])).not.toContain(credentials[0]!.secret);
    expect(decisions[0]).not.toEqual(decisions[1]);
  });

  test("administrator totals exclude personal usage but retain server, service, and legacy rows", async () => {
    const occurredAt = new Date("2050-01-01T12:00:00.000Z");
    const cases = [
      { fundingKind: "server" as const, providerRoute: "managed-gateway" },
      { fundingKind: "service" as const, providerRoute: "openrouter" },
      { fundingKind: null, providerRoute: null },
    ];
    for (const entry of cases) {
      const id = randomUUID();
      usageIds.push(id);
      await db.insert(llmUsageEvents).values({
        id, occurredAt, userId: userIds[0], callType: "chat", provider: "openrouter",
        model: "openrouter:synthetic/model", inputTokens: 5, outputTokens: 3,
        estimatedCostUsd: "0.02000000", ...entry,
      });
    }
    const summary = await getCostsSummary({
      sinceIso: "2050-01-01T00:00:00.000Z",
      untilIso: "2050-01-02T00:00:00.000Z",
    });
    expect(summary.totals.calls).toBe(3);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(0.06);

    // A personal classification without payer and credential metadata must
    // fail in PostgreSQL, including when a caller bypasses the typed helper.
    const malformedId = randomUUID();
    usageIds.push(malformedId);
    let rejected = false;
    try {
      await db.insert(llmUsageEvents).values({
        id: malformedId, occurredAt, userId: userIds[0], callType: "chat", provider: "openrouter",
        model: "openrouter:synthetic/model", estimatedCostUsd: "0.02000000",
        fundingKind: "personal", providerRoute: "openrouter",
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(await db.select({ id: llmUsageEvents.id }).from(llmUsageEvents)
      .where(eq(llmUsageEvents.id, malformedId))).toEqual([]);
  });

  test("both priorities send the exact exclusive or overlap key and persist the admitted payer", async () => {
    const [created] = await db.insert(users).values({
      name: `funding-matrix-${randomUUID()}`,
    }).returning({ id: users.id });
    if (!created) throw new Error("Expected synthetic funding user");
    userIds.push(created.id);

    const personalSecrets = new Map<string, string>([
      ["anthropic", "synthetic-personal-anthropic"],
      ["openrouter", "synthetic-personal-openrouter"],
    ] as const);
    for (const [provider, secret] of personalSecrets) {
      const identity = createPersonalProviderCredentialIdentity();
      const inserted = await insertPersonalProviderCredential(db, {
        identity,
        userId: created.id,
        provider: provider as PersonalProviderId,
        envelope: encryptPersonalProviderCredential(custody, secret, {
          id: identity.id,
          revision: identity.revision,
          userId: created.id,
          provider,
        }),
      });
      expect(inserted.status).toBe("created");
    }

    const serverSecrets = new Map([
      ["fireworks", "synthetic-server-fireworks"],
      ["openrouter", "synthetic-server-openrouter"],
    ]);
    const models = [
      {
        id: "anthropic:synthetic/personal-only",
        providerRoute: "anthropic",
        expected: { personal_first: "personal", server_first: "personal" },
      },
      {
        id: "openrouter:synthetic/overlap",
        providerRoute: "openrouter",
        expected: { personal_first: "personal", server_first: "server" },
      },
      {
        id: "fireworks:synthetic/server-only",
        providerRoute: "fireworks",
        expected: { personal_first: "server", server_first: "server" },
      },
    ] as const;

    for (const fundingPreference of ["personal_first", "server_first"] as const) {
      const deps: ModelFundingDeps = {
        getPolicy: async () => ({ allowPersonalProviderKeys: true, fundingPreference }),
        getCapabilities: async () => [
          "use_personal_provider_credentials",
          "use_server_provider_credentials",
        ],
        getCredential: (userId, provider) => getPersonalProviderCredential(db, userId, provider),
        serverRoute: (modelId) => modelId.startsWith("openrouter:")
          ? "openrouter"
          : modelId.startsWith("fireworks:") ? "fireworks" : null,
        readCustody: async () => custody,
        decrypt: decryptPersonalProviderCredential,
      };

      for (const entry of models) {
        const decision = await resolveModelFunding({
          humanUserId: created.id,
          modelId: entry.id,
          workload: "foreground_text_chat",
        }, deps);
        expect(decision.kind).toBe(entry.expected[fundingPreference]);

        const boundaryCalls: Array<{ key: string; providerRoute: string }> = [];
        const invokeFakeProvider = async (key: string) => {
          boundaryCalls.push({ key, providerRoute: decision.providerRoute });
          return "synthetic-response";
        };
        if (decision.kind === "personal") {
          await withAdmittedPersonalProviderKey(decision, invokeFakeProvider, deps);
        } else {
          const serverKey = serverSecrets.get(decision.providerRoute);
          if (!serverKey) throw new Error("Missing synthetic server key");
          await invokeFakeProvider(serverKey);
        }
        const expectedBoundaryKey = decision.kind === "personal"
          ? personalSecrets.get(entry.providerRoute)
          : serverSecrets.get(entry.providerRoute);
        if (!expectedBoundaryKey) throw new Error("Missing expected synthetic boundary key");
        expect(boundaryCalls).toEqual([{
          key: expectedBoundaryKey,
          providerRoute: entry.providerRoute,
        }]);

        const usageId = randomUUID();
        usageIds.push(usageId);
        await db.insert(llmUsageEvents).values({
          id: usageId,
          userId: created.id,
          callType: "chat",
          provider: entry.providerRoute,
          model: entry.id,
          inputTokens: 2,
          outputTokens: 1,
          estimatedCostUsd: "0.00100000",
          fundingKind: decision.kind,
          providerRoute: decision.providerRoute,
          ...(decision.kind === "personal"
            ? {
                payerHumanId: decision.payerHumanId,
                credentialId: decision.credentialId,
                credentialRevision: decision.credentialRevision,
              }
            : {}),
        });
        const [usage] = await db.select().from(llmUsageEvents)
          .where(eq(llmUsageEvents.id, usageId));
        expect(usage).toMatchObject({
          fundingKind: decision.kind,
          providerRoute: entry.providerRoute,
          ...(decision.kind === "personal"
            ? {
                payerHumanId: created.id,
                credentialId: decision.credentialId,
                credentialRevision: decision.credentialRevision,
              }
            : {
                payerHumanId: null,
                credentialId: null,
                credentialRevision: null,
              }),
        });
        expect(JSON.stringify(usage)).not.toContain(boundaryCalls[0]!.key);
      }
    }
  });
});
