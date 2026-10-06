import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchSurplusSettlement, surplusCredentialFingerprint } from "@nautilo/agent";
import {
  __setLlmUsageDbForTests,
  attachSurplusRequestReceipt,
  beginSurplusLlmAttempt,
  classifySurplusLlmAttemptRecovery,
  createDirectDb,
  ensureDatabase,
  inArray,
  listPendingSurplusAttempts,
  llmUsageEvents,
  users,
  type DirectDatabase,
  type SurplusPendingAttempt,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createSurplusCostRecovery } from "../../src/lib/surplus-cost-reconciliation";

const ORIGINAL_KEY = "synthetic-server-surplus-original-key";
const REPLACEMENT_KEY = "synthetic-server-surplus-replacement-key";
const PROVIDER = "venice";
const MODEL = "openai-gpt-55";
const COST_MICRO = 283;
const ROLLBACK = new Error("rollback server Surplus receipt repair fixtures");

let db: DirectDatabase;

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

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
}, 120_000);

afterAll(async () => {
  __setLlmUsageDbForTests(null);
  await db?.end();
});

describe.serial("server Surplus receipt repair", () => {
  test("restart and key rotation retry only exact receipts without waking personal rows", async () => {
    try {
      await db.transaction(async (tx) => {
        __setLlmUsageDbForTests(tx);
        const [payer] = await tx.insert(users).values({
          name: `server-surplus-receipt-repair-${randomUUID()}`,
        }).returning({ id: users.id });
        if (!payer) throw new Error("Synthetic payer was not created");
        const payerId: string = payer.id;

        const attemptIds: string[] = [];
        const requestByAttempt = new Map<string, string>();
        async function createBlockedAttempt(input: {
          fundingKind: "personal" | "server" | "service";
          requestId: string;
          failureCode: "credential_fingerprint_mismatch" | "receipt_read_unauthorized";
        }): Promise<string> {
          const id = randomUUID();
          attemptIds.push(id);
          requestByAttempt.set(id, input.requestId);
          await beginSurplusLlmAttempt({
            id,
            userId: input.fundingKind === "personal" ? payerId : null,
            payerHumanId: input.fundingKind === "personal" ? payerId : null,
            callType: "chat",
            provider: PROVIDER,
            model: `${PROVIDER}:${MODEL}`,
            endpoint: "/v1/chat/completions",
            fundingKind: input.fundingKind,
            credentialId: input.fundingKind === "personal" ? randomUUID() : null,
            credentialRevision: input.fundingKind === "personal" ? 1 : null,
            metadata: {
              catalogModelId: `${PROVIDER}:${MODEL}`,
              surplusModelId: MODEL,
              surplusProviderPin: PROVIDER,
              surplusCredentialFingerprint: surplusCredentialFingerprint(ORIGINAL_KEY),
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
          if (!row) throw new Error("Synthetic receipt was not queued");
          expect(await classifySurplusLlmAttemptRecovery({
            attemptId: id,
            expectedUpdatedAtToken: row.updatedAtToken,
            recoveryState: "blocked_repair",
            failureCode: input.failureCode,
          })).toBe(true);
          return id;
        }

        const sameKeyId = await createBlockedAttempt({
          fundingKind: "server",
          requestId: `same-key-${randomUUID()}`,
          failureCode: "receipt_read_unauthorized",
        });
        const replacementId = await createBlockedAttempt({
          fundingKind: "service",
          requestId: `replacement-authorized-${randomUUID()}`,
          failureCode: "credential_fingerprint_mismatch",
        });
        const forbiddenId = await createBlockedAttempt({
          fundingKind: "server",
          requestId: `replacement-forbidden-${randomUUID()}`,
          failureCode: "credential_fingerprint_mismatch",
        });
        const missingId = await createBlockedAttempt({
          fundingKind: "service",
          requestId: `replacement-missing-${randomUUID()}`,
          failureCode: "credential_fingerprint_mismatch",
        });
        const personalId = await createBlockedAttempt({
          fundingKind: "personal",
          requestId: `personal-${randomUUID()}`,
          failureCode: "receipt_read_unauthorized",
        });

        const rows = async () => tx.select().from(llmUsageEvents)
          .where(inArray(llmUsageEvents.id, attemptIds));
        const requestFor = (attemptId: string) => {
          const requestId = requestByAttempt.get(attemptId);
          if (!requestId) throw new Error("Synthetic request binding is missing");
          return requestId;
        };

        let currentKey = ORIGINAL_KEY;
        let originalRestored = false;
        const reads: Array<{ key: string; requestId: string }> = [];
        const fetchImpl = (async (input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          const requestId = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
          const key = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length) ?? "";
          reads.push({ key, requestId });
          expect(init?.method).toBe("GET");
          expect(init?.redirect).toBe("error");
          if (requestId === requestFor(sameKeyId) && key === ORIGINAL_KEY) {
            return Response.json({
              request_id: requestId,
              provider: PROVIDER,
              settlement_status: "accrued",
              settlement_type: "credit",
              settlement_error: null,
              confirmed_at: "2026-10-06T10:00:00.000Z",
              buyer_cost_micro: COST_MICRO,
            });
          }
          if (requestId === requestFor(missingId) && key === ORIGINAL_KEY && originalRestored) {
            return Response.json({
              request_id: requestId,
              provider: PROVIDER,
              settlement_status: "accrued",
              settlement_type: "credit",
              settlement_error: null,
              confirmed_at: "2026-10-06T10:02:00.000Z",
              buyer_cost_micro: COST_MICRO,
            });
          }
          if (requestId === requestFor(replacementId) && key === REPLACEMENT_KEY) {
            return Response.json({
              request_id: requestId,
              provider: PROVIDER,
              settlement_status: "accrued",
              settlement_type: "credit",
              settlement_error: null,
              confirmed_at: "2026-10-06T10:01:00.000Z",
              buyer_cost_micro: COST_MICRO,
            });
          }
          if (requestId === requestFor(missingId)) return new Response(null, { status: 404 });
          return new Response(null, { status: 403 });
        }) as typeof fetch;

        const createRecovery = () => createSurplusCostRecovery({
          now: () => Date.now() + 120_000,
          list: async (input) => (await listPendingSurplusAttempts(input))
            .filter((row) => attemptIds.includes(row.id)),
          resolveServerCredential: () => currentKey,
          resolveCredential: (row: SurplusPendingAttempt) => {
            if (!attemptIds.includes(row.id) || row.fundingKind === "personal") {
              throw new Error("Recovery escaped the synthetic server receipt scope");
            }
            return {
              status: "available",
              apiKey: currentKey,
              receiptReadStatus: "unknown",
            };
          },
          fetchCost: (input) => fetchSurplusSettlement({ ...input, fetchImpl }),
        });

        const restartedWithOriginal = createRecovery();
        try {
          restartedWithOriginal.wake();
          await until(async () => {
            const current = await rows();
            expect(current.find((row) => row.id === sameKeyId)).toMatchObject({
              costState: "actual",
              actualCostUsd: "0.00028300",
              recoveryState: null,
            });
            expect(current.find((row) => row.id === replacementId)).toMatchObject({
              recoveryState: "blocked_repair",
              failureCode: "receipt_read_unauthorized",
            });
            expect(current.find((row) => row.id === forbiddenId)).toMatchObject({
              recoveryState: "blocked_repair",
              failureCode: "receipt_read_unauthorized",
            });
            expect(current.find((row) => row.id === missingId)).toMatchObject({
              recoveryState: "retryable",
              failureCode: "receipt_not_found",
            });
            expect(current.find((row) => row.id === personalId)).toMatchObject({
              recoveryState: "blocked_repair",
              failureCode: "receipt_read_unauthorized",
            });
          });
        } finally {
          await restartedWithOriginal.stop();
        }

        currentKey = REPLACEMENT_KEY;
        const restartedWithReplacement = createRecovery();
        try {
          restartedWithReplacement.wake();
          await until(async () => {
            const current = await rows();
            expect(current.find((row) => row.id === replacementId)).toMatchObject({
              costState: "actual",
              actualCostUsd: "0.00028300",
              recoveryState: null,
            });
            expect(current.find((row) => row.id === forbiddenId)).toMatchObject({
              costState: "pending",
              actualCostUsd: null,
              recoveryState: "blocked_repair",
              failureCode: "receipt_read_unauthorized",
            });
            expect(current.find((row) => row.id === missingId)).toMatchObject({
              costState: "pending",
              actualCostUsd: null,
              recoveryState: "blocked_repair",
              failureCode: "receipt_account_unproven",
            });
          });
          const readCount = reads.length;
          restartedWithReplacement.wake();
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(reads).toHaveLength(readCount);
        } finally {
          await restartedWithReplacement.stop();
        }

        currentKey = ORIGINAL_KEY;
        originalRestored = true;
        const restartedWithRestoredOriginal = createRecovery();
        try {
          restartedWithRestoredOriginal.wake();
          await until(async () => {
            const current = await rows();
            expect(current.find((row) => row.id === missingId)).toMatchObject({
              costState: "actual",
              actualCostUsd: "0.00028300",
              recoveryState: null,
            });
            expect(current.find((row) => row.id === forbiddenId)).toMatchObject({
              costState: "pending",
              actualCostUsd: null,
              recoveryState: "blocked_repair",
              failureCode: "receipt_read_unauthorized",
            });
          });
        } finally {
          await restartedWithRestoredOriginal.stop();
        }

        const finalRows = await rows();
        expect(finalRows.find((row) => row.id === personalId)).toMatchObject({
          fundingKind: "personal",
          payerHumanId: payerId,
          recoveryState: "blocked_repair",
        });
        for (const attemptId of [sameKeyId, replacementId, forbiddenId, missingId]) {
          expect(finalRows.find((row) => row.id === attemptId)).toMatchObject({
            payerHumanId: null,
            credentialId: null,
            credentialRevision: null,
          });
        }
        expect(finalRows.find((row) => row.id === replacementId)?.metadata).toMatchObject({
          surplusCredentialFingerprint: surplusCredentialFingerprint(ORIGINAL_KEY),
        });
        expect(reads.some((read) => read.requestId === requestFor(personalId))).toBe(false);

        throw ROLLBACK;
      });
    } catch (error) {
      if (error !== ROLLBACK) throw error;
    } finally {
      __setLlmUsageDbForTests(null);
    }
  }, 120_000);
});
