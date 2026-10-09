import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Fastify, { type FastifyInstance } from "fastify";
import { fetchSurplusSettlement, surplusCredentialFingerprint } from "@nautilo/agent";
import {
  attachSurplusRequestReceipt,
  beginSurplusLlmAttempt,
  classifySurplusLlmAttemptRecovery,
  createDirectDb,
  ensureDatabase,
  eq,
  getPersonalCostsSummary,
  inArray,
  listPendingSurplusAttempts,
  llmUsageEvents,
  personalProviderCredentials,
  reconcileSurplusLlmAttemptCost,
  users,
  type DirectDatabase,
  type SurplusPendingAttempt,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createPersonalProviderCustody } from "@nautilo/operator-secrets";
import { resolvePersonalSurplusReceiptCredential } from "../../src/lib/personal-provider-custody";
import { createSurplusCostRecovery } from "../../src/lib/surplus-cost-reconciliation";
import { personalProviderCredentialRoutes } from "../../src/routes/personal-provider-credentials";

const INITIAL_KEY = "synthetic-surplus-recovery-key";
const REPLACEMENT_KEY = "synthetic-surplus-recovery-replacement-key";
const ACTUAL_COST_MICRO = 283;
const PROVIDER = "venice";
const SURPLUS_MODEL_ID = "openai-gpt-55";

let db: DirectDatabase;
let app: FastifyInstance;
let userId = "";
const attemptIds: string[] = [];
const custody = createPersonalProviderCustody();

function auth(): Record<string, string> {
  return { "x-test-user": userId };
}

async function until(assertion: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function createBlockedAttempt(input: {
  credentialId: string;
  credentialRevision: number;
  apiKey: string;
  requestId: string;
}): Promise<string> {
  const id = randomUUID();
  attemptIds.push(id);
  await beginSurplusLlmAttempt({
    id,
    userId,
    payerHumanId: userId,
    callType: "chat",
    provider: PROVIDER,
    model: `${PROVIDER}:${SURPLUS_MODEL_ID}`,
    endpoint: "/v1/chat/completions",
    fundingKind: "personal",
    credentialId: input.credentialId,
    credentialRevision: input.credentialRevision,
    metadata: {
      catalogModelId: `${PROVIDER}:${SURPLUS_MODEL_ID}`,
      surplusModelId: SURPLUS_MODEL_ID,
      surplusProviderPin: PROVIDER,
      surplusCredentialFingerprint: surplusCredentialFingerprint(input.apiKey),
    },
  });
  await attachSurplusRequestReceipt({
    attemptId: id,
    providerRequestId: input.requestId,
    servingProvider: PROVIDER,
  });
  const row = (await listPendingSurplusAttempts({
    updatedBefore: new Date(Date.now() + 60_000),
  })).find((candidate) => candidate.id === id);
  if (!row) throw new Error("Synthetic Surplus receipt was not queued");
  expect(await classifySurplusLlmAttemptRecovery({
    attemptId: id,
    expectedUpdatedAtToken: row.updatedAtToken,
    recoveryState: "blocked_repair",
    failureCode: "receipt_read_unauthorized",
  })).toBe(true);
  return id;
}

function recoveryWith(fetchImpl: typeof fetch) {
  return createSurplusCostRecovery({
    resolveServerCredential: () => null,
    requeueBlockedServer: async () => 0,
    now: () => Date.now() + 120_000,
    list: async (input) => (await listPendingSurplusAttempts(input))
      .filter((row) => attemptIds.includes(row.id)),
    classify: classifySurplusLlmAttemptRecovery,
    settle: reconcileSurplusLlmAttemptCost,
    resolveCredential: (row: SurplusPendingAttempt) => {
      if (row.payerHumanId !== userId) {
        throw new Error("Synthetic recovery received an attempt owned by another payer");
      }
      if (!row.payerHumanId || !row.credentialId || !row.credentialRevision) {
        return { status: "blocked_repair" as const, reason: "missing" as const };
      }
      return resolvePersonalSurplusReceiptCredential({
        userId: row.payerHumanId,
        credentialId: row.credentialId,
        credentialRevision: row.credentialRevision,
      }, {
        getDb: () => db,
        readCustody: async () => custody,
      });
    },
    fetchCost: (input) => fetchSurplusSettlement({ ...input, fetchImpl }),
  });
}

async function rowsById(ids: readonly string[]) {
  return db.select().from(llmUsageEvents).where(inArray(llmUsageEvents.id, [...ids]));
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
  const [user] = await db.insert(users).values({
    name: `personal-surplus-replacement-recovery-${randomUUID()}`,
  }).returning({ id: users.id });
  if (!user) throw new Error("Synthetic Surplus recovery user was not created");
  userId = user.id;

  app = Fastify({ logger: false });
  app.decorateRequest("sessionUserId", null);
  app.addHook("preHandler", async (request) => {
    const header = request.headers["x-test-user"];
    request.sessionUserId = typeof header === "string" ? header : null;
  });
  personalProviderCredentialRoutes(app, {
    getDb: () => db,
    getPolicy: async () => ({
      allowPersonalProviderKeys: true,
      fundingPreference: "personal_first",
    }),
    getCapabilities: async () => ["use_personal_provider_credentials"],
    readCustody: async () => custody,
    validate: async () => ({
      status: "accepted",
      receiptReadStatus: "unavailable",
    }),
    auditEvent: () => undefined,
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (db) {
    if (attemptIds.length > 0) {
      await db.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, attemptIds));
    }
    if (userId) {
      await db.delete(personalProviderCredentials)
        .where(eq(personalProviderCredentials.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
    await db.end();
  }
});

describe.serial("personal Surplus replacement receipt recovery", () => {
  test("settles exact authorized receipts once without rewriting their original payer or credential revision", async () => {
    const created = await app.inject({
      method: "PUT",
      url: "/api/account/provider-credentials/surplus",
      headers: auth(),
      payload: { apiKey: INITIAL_KEY },
    });
    expect(created.statusCode, created.body).toBe(200);
    const initialCredential = created.json<{
      credential: { id: string; revision: number };
    }>().credential;
    expect(initialCredential.revision).toBe(1);

    const sameSecretRequestId = `same-secret-${randomUUID()}`;
    const sameSecretAttemptId = await createBlockedAttempt({
      credentialId: initialCredential.id,
      credentialRevision: initialCredential.revision,
      apiKey: INITIAL_KEY,
      requestId: sameSecretRequestId,
    });

    const reentered = await app.inject({
      method: "PUT",
      url: "/api/account/provider-credentials/surplus",
      headers: auth(),
      payload: { apiKey: INITIAL_KEY, expectedRevision: 1 },
    });
    expect(reentered.statusCode, reentered.body).toBe(200);
    const reenteredCredential = reentered.json<{
      credential: { id: string; revision: number };
    }>().credential;
    expect(reenteredCredential).toMatchObject({ id: initialCredential.id, revision: 2 });
    expect((await rowsById([sameSecretAttemptId]))[0]?.recoveryState).toBe("retryable");

    const sameSecretReads: string[] = [];
    const sameSecretRecovery = recoveryWith((async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      sameSecretReads.push(url);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${INITIAL_KEY}`);
      expect(url).toBe(`https://api.surplusintelligence.ai/v1/requests/${sameSecretRequestId}`);
      return Response.json({
        request_id: sameSecretRequestId,
        provider: PROVIDER,
        settlement_status: "accrued",
        settlement_type: "credit",
        settlement_error: null,
        confirmed_at: "2026-10-06T10:00:00.000Z",
        buyer_cost_micro: ACTUAL_COST_MICRO,
      });
    }) as typeof fetch);
    try {
      sameSecretRecovery.wake();
      await until(async () => {
        expect((await rowsById([sameSecretAttemptId]))[0]?.costState).toBe("actual");
      });
      sameSecretRecovery.wake();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await sameSecretRecovery.stop();
    }
    expect(sameSecretReads).toHaveLength(1);

    const authorizedRequestId = `replacement-authorized-${randomUUID()}`;
    const unauthorizedRequestId = `replacement-unauthorized-${randomUUID()}`;
    const missingRequestId = `replacement-missing-${randomUUID()}`;
    const authorizedAttemptId = await createBlockedAttempt({
      credentialId: reenteredCredential.id,
      credentialRevision: reenteredCredential.revision,
      apiKey: INITIAL_KEY,
      requestId: authorizedRequestId,
    });
    const unauthorizedAttemptId = await createBlockedAttempt({
      credentialId: reenteredCredential.id,
      credentialRevision: reenteredCredential.revision,
      apiKey: INITIAL_KEY,
      requestId: unauthorizedRequestId,
    });
    const missingAttemptId = await createBlockedAttempt({
      credentialId: reenteredCredential.id,
      credentialRevision: reenteredCredential.revision,
      apiKey: INITIAL_KEY,
      requestId: missingRequestId,
    });

    const replaced = await app.inject({
      method: "PUT",
      url: "/api/account/provider-credentials/surplus",
      headers: auth(),
      payload: { apiKey: REPLACEMENT_KEY, expectedRevision: 2 },
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect(replaced.json<{ credential: { id: string; revision: number } }>().credential)
      .toMatchObject({ id: initialCredential.id, revision: 3 });
    const requeued = await rowsById([
      authorizedAttemptId,
      unauthorizedAttemptId,
      missingAttemptId,
    ]);
    expect(requeued).toHaveLength(3);
    expect(requeued.every((row) => row.recoveryState === "retryable")).toBe(true);

    const replacementReads: string[] = [];
    const replacementRecovery = recoveryWith((async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      replacementReads.push(url);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${REPLACEMENT_KEY}`);
      const requestId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      if (requestId === unauthorizedRequestId) return new Response(null, { status: 403 });
      if (requestId === missingRequestId) return new Response(null, { status: 404 });
      expect(requestId).toBe(authorizedRequestId);
      return Response.json({
        request_id: authorizedRequestId,
        provider: PROVIDER,
        settlement_status: "accrued",
        settlement_type: "credit",
        settlement_error: null,
        confirmed_at: "2026-10-06T10:01:00.000Z",
        buyer_cost_micro: ACTUAL_COST_MICRO,
      });
    }) as typeof fetch);
    try {
      replacementRecovery.wake();
      await until(async () => {
        const rows = await rowsById([
          authorizedAttemptId,
          unauthorizedAttemptId,
          missingAttemptId,
        ]);
        expect(rows.find((row) => row.id === authorizedAttemptId)).toMatchObject({
          costState: "actual",
          recoveryState: null,
        });
        expect(rows.find((row) => row.id === unauthorizedAttemptId)).toMatchObject({
          costState: "pending",
          actualCostUsd: null,
          recoveryState: "blocked_repair",
          failureCode: "receipt_read_unauthorized",
        });
        expect(rows.find((row) => row.id === missingAttemptId)).toMatchObject({
          costState: "pending",
          actualCostUsd: null,
          recoveryState: "blocked_repair",
          failureCode: "receipt_account_unproven",
        });
      });
    } finally {
      await replacementRecovery.stop();
    }
    expect(replacementReads).toHaveLength(3);

    const summary = await getPersonalCostsSummary({
      payerHumanId: userId,
      range: { sinceIso: new Date(0).toISOString(), untilIso: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(summary.recovery.attempts?.find((attempt) => attempt.attemptId === missingAttemptId)).toMatchObject({
      status: "blocked", reason: "receipt_account_unproven", repairAction: "check_receipt_access",
    });

    const allRows = await rowsById(attemptIds);
    expect(allRows).toHaveLength(4);
    expect(allRows.filter((row) => row.costState === "actual")).toHaveLength(2);
    expect(allRows.reduce(
      (sum, row) => sum + Number(row.actualCostUsd ?? 0),
      0,
    )).toBeCloseTo((ACTUAL_COST_MICRO * 2) / 1_000_000, 8);
    expect(allRows.find((row) => row.id === sameSecretAttemptId)).toMatchObject({
      payerHumanId: userId,
      credentialId: initialCredential.id,
      credentialRevision: 1,
      actualCostUsd: "0.00028300",
    });
    for (const attemptId of [authorizedAttemptId, unauthorizedAttemptId, missingAttemptId]) {
      expect(allRows.find((row) => row.id === attemptId)).toMatchObject({
        payerHumanId: userId,
        credentialId: initialCredential.id,
        credentialRevision: 2,
      });
    }
  });
});
