import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  attachSurplusRequestReceipt,
  beginPersonalLlmAttempt,
  beginSurplusLlmAttempt,
  classifySurplusLlmAttemptRecovery,
  createDirectDb,
  ensureDatabase,
  eq,
  getPersonalCostsSummary,
  inArray,
  llmUsageEvents,
  listPendingSurplusAttempts,
  requeueBlockedPersonalSurplusAttempts,
  reconcileSurplusLlmAttemptCost,
  settlePersonalLlmAttempt,
  settleSurplusLlmAttempt,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const FIXTURE_PREFIX = "personal-costs-integration";
const attemptIds: string[] = [];
const userIds: string[] = [];
let db: DirectDatabase;

async function createUser(label: string): Promise<string> {
  const [row] = await db.insert(users).values({
    name: `${FIXTURE_PREFIX}:${label}:${randomUUID()}`,
  }).returning({ id: users.id });
  if (!row) throw new Error("Personal costs fixture user was not created");
  userIds.push(row.id);
  return row.id;
}

function attemptId(): string {
  const id = randomUUID();
  attemptIds.push(id);
  return id;
}

async function expectRejected(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error("Expected database operation to reject");
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(2);
});

afterAll(async () => {
  if (attemptIds.length > 0) {
    await db?.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, attemptIds));
  }
  for (const userId of userIds) {
    await db?.delete(users).where(eq(users.id, userId));
  }
  await db?.end();
});

describe("personal cost attempts and account isolation", () => {
  test("prewires and settles one direct personal attempt in place", async () => {
    const payerHumanId = await createUser("direct");
    const id = attemptId();
    const credentialId = randomUUID();
    await beginPersonalLlmAttempt({
      id,
      userId: payerHumanId,
      callType: "chat",
      provider: "anthropic",
      model: "anthropic:claude-sonnet-4-6",
      providerRoute: "anthropic",
      credentialId,
      credentialRevision: 1,
      endpoint: "/v1/messages",
    });
    await settlePersonalLlmAttempt({
      attemptId: id,
      outcome: "succeeded",
      costState: "estimated",
      inputTokens: 120,
      outputTokens: 30,
      estimatedCostUsd: 0.0015,
      pricingVersion: "integration-price-v1",
    });
    const rows = await db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payerHumanId,
      credentialId,
      credentialRevision: 1,
      attemptOutcome: "succeeded",
      costState: "estimated",
      estimatedCostUsd: "0.00150000",
      totalTokens: 150,
    });
  });

  test("late verified usage preserves an interrupted outcome and its failure evidence", async () => {
    const payerHumanId = await createUser("late-usage");
    const id = attemptId();
    const terminalAt = new Date("2026-10-05T10:00:00.000Z");
    await beginPersonalLlmAttempt({
      id,
      userId: payerHumanId,
      callType: "chat",
      provider: "anthropic",
      model: "anthropic:claude-sonnet-4-6",
      providerRoute: "anthropic",
      credentialId: randomUUID(),
      credentialRevision: 1,
      endpoint: "/v1/messages",
    });
    await settlePersonalLlmAttempt({
      attemptId: id,
      outcome: "interrupted",
      costState: "unknown",
      failureCode: "execution_interrupted",
      settledAt: terminalAt,
    });
    const lateSettlement = {
      attemptId: id,
      outcome: "interrupted" as const,
      costState: "estimated" as const,
      inputTokens: 80,
      outputTokens: 10,
      estimatedCostUsd: 0.0009,
      pricingVersion: "integration-price-v1",
      preserveOutcome: true,
    };
    await settlePersonalLlmAttempt(lateSettlement);
    await settlePersonalLlmAttempt(lateSettlement);
    const [row] = await db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
    expect(row).toMatchObject({
      attemptOutcome: "interrupted",
      costState: "estimated",
      estimatedCostUsd: "0.00090000",
      failureCode: "execution_interrupted",
      settledAt: terminalAt,
      totalTokens: 90,
    });
  });

  test("allows the same provider request id in separate personal accounts and preserves actual zero", async () => {
    const firstPayer = await createUser("surplus-zero-a");
    const secondPayer = await createUser("surplus-zero-b");
    const requestId = `req-${randomUUID()}`;
    const firstId = attemptId();
    const secondId = attemptId();
    const common = {
      callType: "chat",
      provider: "venice",
      model: "venice:openai-gpt-55",
      endpoint: "/v1/chat/completions",
      fundingKind: "personal" as const,
    };
    await beginSurplusLlmAttempt({
      ...common,
      id: firstId,
      userId: firstPayer,
      payerHumanId: firstPayer,
      credentialId: randomUUID(),
      credentialRevision: 1,
    });
    await beginSurplusLlmAttempt({
      ...common,
      id: secondId,
      userId: secondPayer,
      payerHumanId: secondPayer,
      credentialId: randomUUID(),
      credentialRevision: 1,
    });
    await attachSurplusRequestReceipt({ attemptId: firstId, providerRequestId: requestId });
    await attachSurplusRequestReceipt({ attemptId: secondId, providerRequestId: requestId });
    const queued = (await listPendingSurplusAttempts({
      updatedBefore: new Date(Date.now() + 60_000),
    })).find((row) => row.id === firstId);
    if (!queued) throw new Error("Queued Surplus attempt was not listed");
    expect(await reconcileSurplusLlmAttemptCost({
      attemptId: firstId,
      providerRequestId: requestId,
      expectedUpdatedAtToken: queued.updatedAtToken,
      actualCostUsd: 0,
    })).toBe(true);
    await settleSurplusLlmAttempt({
      attemptId: firstId,
      providerRequestId: requestId,
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0,
    });
    // Repeating the same terminal evidence updates the durable attempt rather
    // than creating a second cost row.
    await settleSurplusLlmAttempt({
      attemptId: firstId,
      providerRequestId: requestId,
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0,
    });

    const rows = await db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, firstId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ costState: "actual", actualCostUsd: "0.00000000" });

    const conflictingId = attemptId();
    await beginSurplusLlmAttempt({
      ...common,
      id: conflictingId,
      userId: firstPayer,
      payerHumanId: firstPayer,
      credentialId: randomUUID(),
      credentialRevision: 2,
    });
    await expectRejected(() => attachSurplusRequestReceipt({
      attemptId: conflictingId,
      providerRequestId: requestId,
    }));
  });

  test("aggregates only the session payer and excludes another Human and server spend", async () => {
    const payer = await createUser("aggregate-owner");
    const other = await createUser("aggregate-other");
    const since = new Date(Date.now() - 60_000).toISOString();
    const directId = attemptId();
    await beginPersonalLlmAttempt({
      id: directId,
      userId: payer,
      callType: "chat",
      provider: "anthropic",
      model: "anthropic:claude-sonnet-4-6",
      providerRoute: "anthropic",
      credentialId: randomUUID(),
      credentialRevision: 1,
      endpoint: "/v1/messages",
    });
    await settlePersonalLlmAttempt({
      attemptId: directId,
      outcome: "succeeded",
      costState: "estimated",
      inputTokens: 10,
      outputTokens: 5,
      estimatedCostUsd: 0.002,
      pricingVersion: "integration-price-v1",
    });
    const personalSurplusId = attemptId();
    await beginSurplusLlmAttempt({
      id: personalSurplusId,
      userId: payer,
      payerHumanId: payer,
      callType: "chat",
      provider: "anthropic",
      model: "anthropic:claude-sonnet-4-6",
      endpoint: "/v1/chat/completions",
      fundingKind: "personal",
      credentialId: randomUUID(),
      credentialRevision: 1,
    });
    await settleSurplusLlmAttempt({
      attemptId: personalSurplusId,
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0.001,
    });
    const otherId = attemptId();
    await beginPersonalLlmAttempt({
      id: otherId,
      userId: other,
      callType: "chat",
      provider: "openai",
      model: "openai:gpt-5.5",
      providerRoute: "openai",
      credentialId: randomUUID(),
      credentialRevision: 1,
      endpoint: "/v1/responses",
    });
    await settlePersonalLlmAttempt({
      attemptId: otherId,
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 9,
    });
    const serverId = attemptId();
    await beginSurplusLlmAttempt({
      id: serverId,
      callType: "chat",
      provider: "venice",
      model: "venice:openai-gpt-55",
      endpoint: "/v1/chat/completions",
      fundingKind: "server",
    });
    await settleSurplusLlmAttempt({
      attemptId: serverId,
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 7,
    });

    const summary = await getPersonalCostsSummary({
      payerHumanId: payer,
      range: { sinceIso: since, untilIso: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(summary.entry).toEqual({
      available: true,
      hasPersonalCredentials: false,
      hasHistory: true,
    });
    expect(summary.totals).toMatchObject({
      calls: 2,
      estimatedCostUsd: 0.002,
      actualCostUsd: 0.001,
      totalCostUsd: 0.003,
    });
    expect(summary.byModel.map((row) => row.model)).toEqual([
      "anthropic:claude-sonnet-4-6",
    ]);
    expect(summary.byModel[0]).toMatchObject({
      provider: "anthropic",
      calls: 2,
      totalCostUsd: 0.003,
    });
    expect(summary.byProvider.find((row) => row.provider === "anthropic")).toMatchObject({
      provider: "anthropic",
      operation: "chat",
      operations: 1,
      totalCostUsd: 0.002,
    });
    expect(summary.byProvider.find((row) => row.provider === "surplus")).toMatchObject({
      provider: "surplus",
      operation: "chat",
      operations: 1,
      totalCostUsd: 0.001,
    });
  });

  test("requeues blocked recovery only for the exact payer, credential, and revision", async () => {
    const payerHumanId = await createUser("requeue-owner");
    const credentialId = randomUUID();
    const id = attemptId();
    await beginSurplusLlmAttempt({
      id,
      userId: payerHumanId,
      payerHumanId,
      callType: "chat",
      provider: "venice",
      model: "venice:openai-gpt-55",
      endpoint: "/v1/chat/completions",
      fundingKind: "personal",
      credentialId,
      credentialRevision: 3,
    });
    const created = (await listPendingSurplusAttempts({
      updatedBefore: new Date(Date.now() + 60_000),
    })).find((row) => row.id === id);
    if (!created) throw new Error("Surplus recovery fixture was not created");
    expect(await classifySurplusLlmAttemptRecovery({
      attemptId: id,
      expectedUpdatedAtToken: created.updatedAtToken,
      recoveryState: "blocked_repair",
      failureCode: "receipt_read_unauthorized",
    })).toBe(true);

    expect(await requeueBlockedPersonalSurplusAttempts({
      payerHumanId,
      credentialId,
      credentialRevision: 2,
    })).toBe(0);
    expect(await requeueBlockedPersonalSurplusAttempts({
      payerHumanId: await createUser("requeue-other"),
      credentialId,
      credentialRevision: 3,
    })).toBe(0);
    expect(await requeueBlockedPersonalSurplusAttempts({
      payerHumanId,
      credentialId,
      credentialRevision: 3,
    })).toBe(1);
    const [requeued] = await db.select({
      recoveryState: llmUsageEvents.recoveryState,
      failureCode: llmUsageEvents.failureCode,
    }).from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
    expect(requeued).toEqual({ recoveryState: "retryable", failureCode: null });
  });

  test("database constraints reject incomplete personal attempt provenance", async () => {
    const payerHumanId = await createUser("constraint-owner");
    const id = attemptId();
    await expectRejected(() => db.insert(llmUsageEvents).values({
      id,
      userId: payerHumanId,
      payerHumanId,
      callType: "chat",
      provider: "anthropic",
      model: "anthropic:claude-sonnet-4-6",
      providerRoute: "anthropic",
      endpoint: "/v1/messages",
      fundingKind: "personal",
      attemptOutcome: "in_progress",
      costState: "pending",
      estimatedCostUsd: "0.00000000",
    }));
  });
});
