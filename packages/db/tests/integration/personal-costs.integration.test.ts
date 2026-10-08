import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  attachSurplusRequestReceipt,
  agents,
  beginPersonalLlmAttempt,
  beginSurplusLlmAttempt,
  classifySurplusLlmAttemptRecovery,
  createDirectDb,
  ensureDatabase,
  eq,
  getCostsSummary,
  getPersonalCostsSummary,
  inArray,
  insertProviderCostEventWith,
  llmUsageEvents,
  listPendingSurplusAttempts,
  personalProviderCredentials,
  providerCostEvents,
  providerCostIdempotencyKey,
  providerCostRequestReference,
  requeueBlockedPersonalSurplusAttempts,
  reconcileSurplusLlmAttemptCost,
  settlePersonalLlmAttempt,
  settleProviderCostEventWith,
  settleSurplusLlmAttempt,
  tasks,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const FIXTURE_PREFIX = "personal-costs-integration";
const attemptIds: string[] = [];
const providerCostKeys: string[] = [];
const userIds: string[] = [];
const agentIds: string[] = [];
const taskIds: string[] = [];
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

async function createTask(ownerId: string): Promise<string> {
  const [agent] = await db.insert(agents).values({
    handle: `${FIXTURE_PREFIX}-${randomUUID()}`,
  }).returning({ id: agents.id });
  if (!agent) throw new Error("Personal costs fixture Agent was not created");
  agentIds.push(agent.id);
  const [task] = await db.insert(tasks).values({
    ownerId,
    requestorId: ownerId,
    agentId: agent.id,
    prompt: `${FIXTURE_PREFIX} content-free attribution fixture`,
  }).returning({ id: tasks.id });
  if (!task) throw new Error("Personal costs fixture Task was not created");
  taskIds.push(task.id);
  return task.id;
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
  if (providerCostKeys.length > 0) {
    await db?.delete(providerCostEvents).where(
      inArray(providerCostEvents.idempotencyKey, providerCostKeys),
    );
  }
  if (taskIds.length > 0) {
    await db?.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (agentIds.length > 0) {
    await db?.delete(agents).where(inArray(agents.id, agentIds));
  }
  for (const userId of userIds) {
    await db?.delete(users).where(eq(users.id, userId));
  }
  await db?.end();
});

describe("personal cost attempts and account isolation", () => {
  test("merges model and service costs for one Task after payer isolation", async () => {
    const payerHumanId = await createUser("cross-ledger-task-owner");
    const otherPayerHumanId = await createUser("cross-ledger-task-other");
    const taskId = await createTask(payerHumanId);
    const modelAttemptId = attemptId();
    await beginPersonalLlmAttempt({
      id: modelAttemptId,
      userId: payerHumanId,
      taskId,
      callType: "decision",
      provider: "openai",
      model: "openai:gpt-5.5",
      providerRoute: "openai",
      credentialId: randomUUID(),
      credentialRevision: 1,
      endpoint: "/v1/responses",
    });
    await settlePersonalLlmAttempt({
      attemptId: modelAttemptId,
      outcome: "succeeded",
      costState: "actual",
      estimatedCostUsd: 0.9,
      actualCostUsd: 0.4,
    });

    const insertService = async (input: {
      label: string;
      payerHumanId: string;
      evidenceState: "actual" | "estimated" | "unknown";
      actualCostUsd?: string;
      estimatedCostUsd?: string;
      attemptOutcome: "succeeded" | "failed";
    }) => {
      const idempotencyKey = providerCostIdempotencyKey(
        `${FIXTURE_PREFIX}:cross-ledger-task:${input.label}:${randomUUID()}`,
      );
      providerCostKeys.push(idempotencyKey);
      await insertProviderCostEventWith(db, {
        userId: input.payerHumanId,
        taskId,
        provider: "tavily",
        operation: "search",
        workload: "deep_research",
        fundingKind: "personal",
        payerHumanId: input.payerHumanId,
        providerRoute: "tavily",
        credentialId: randomUUID(),
        credentialRevision: 1,
        evidenceState: input.evidenceState,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        actualCostUsd: input.actualCostUsd ?? null,
        attemptOutcome: input.attemptOutcome,
        idempotencyKey,
      });
    };
    await insertService({
      label: "estimated",
      payerHumanId,
      evidenceState: "estimated",
      estimatedCostUsd: "0.125",
      attemptOutcome: "succeeded",
    });
    await insertService({
      label: "unknown",
      payerHumanId,
      evidenceState: "unknown",
      attemptOutcome: "failed",
    });
    await insertService({
      label: "other-payer",
      payerHumanId: otherPayerHumanId,
      evidenceState: "actual",
      actualCostUsd: "9",
      attemptOutcome: "succeeded",
    });

    const summary = await getPersonalCostsSummary({
      payerHumanId,
      range: {
        sinceIso: new Date(Date.now() - 60_000).toISOString(),
        untilIso: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(summary.byTask).toHaveLength(1);
    expect(summary.byTask[0]).toEqual({
      taskId,
      calls: 1,
      providerOperations: 2,
      unknownProviderOperations: 1,
      estimatedCostUsd: 0.125,
      actualCostUsd: 0.4,
      totalCostUsd: 0.525,
      pendingAttempts: 0,
      unknownAttempts: 0,
    });
  });

  test("settles service lifecycle and monetary evidence independently on one fenced row", async () => {
    const payerHumanId = await createUser("service-lifecycle-owner");
    const otherPayerHumanId = await createUser("service-lifecycle-other");
    const taskId = await createTask(payerHumanId);
    const credentialId = randomUUID();
    const idempotencyKey = providerCostIdempotencyKey(
      `${FIXTURE_PREFIX}:service-lifecycle:${randomUUID()}`,
    );
    providerCostKeys.push(idempotencyKey);
    const attempt = {
      userId: payerHumanId,
      taskId,
      provider: "tavily",
      operation: "search",
      workload: "deep_research",
      fundingKind: "personal" as const,
      payerHumanId,
      providerRoute: "tavily",
      credentialId,
      credentialRevision: 1,
      attemptOutcome: "unknown" as const,
      evidenceState: "unknown" as const,
      idempotencyKey,
    };
    await insertProviderCostEventWith(db, attempt);
    await settleProviderCostEventWith(db, {
      ...attempt,
      attemptOutcome: "failed",
      failureCode: "provider_request_failed",
    });
    await settleProviderCostEventWith(db, {
      ...attempt,
      attemptOutcome: "failed",
      failureCode: "provider_request_failed",
      evidenceState: "estimated",
      estimatedCostUsd: "0.008",
      pricingVersion: "test-price-v1",
      measuredUnits: 1,
      unitType: "credit",
    });
    const actualSettlement = {
      ...attempt,
      attemptOutcome: "failed" as const,
      failureCode: "provider_request_failed",
      evidenceState: "actual" as const,
      estimatedCostUsd: "0.999",
      actualCostUsd: "0",
      pricingVersion: "test-price-v2",
      measuredUnits: 2,
      unitType: "credit",
    };
    await settleProviderCostEventWith(db, actualSettlement);
    await settleProviderCostEventWith(db, actualSettlement);

    const [stored] = await db.select().from(providerCostEvents).where(
      eq(providerCostEvents.idempotencyKey, idempotencyKey),
    );
    expect(stored).toMatchObject({
      taskId,
      workload: "deep_research",
      attemptOutcome: "failed",
      failureCode: "provider_request_failed",
      evidenceState: "actual",
      estimatedCostUsd: "0.00800000",
      actualCostUsd: "0.00000000",
      pricingVersion: "test-price-v1",
      measuredUnits: "1.00000000",
      unitType: "credit",
    });

    const otherKey = providerCostIdempotencyKey(
      `${FIXTURE_PREFIX}:service-lifecycle-other:${randomUUID()}`,
    );
    providerCostKeys.push(otherKey);
    await insertProviderCostEventWith(db, {
      userId: otherPayerHumanId,
      taskId,
      provider: "tavily",
      operation: "search",
      workload: "deep_research",
      fundingKind: "personal",
      payerHumanId: otherPayerHumanId,
      providerRoute: "tavily",
      credentialId: randomUUID(),
      credentialRevision: 1,
      attemptOutcome: "succeeded",
      evidenceState: "actual",
      actualCostUsd: "9",
      idempotencyKey: otherKey,
    });

    const summary = await getPersonalCostsSummary({
      payerHumanId,
      range: {
        sinceIso: new Date(Date.now() - 60_000).toISOString(),
        untilIso: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(summary.totals).toMatchObject({
      providerOperations: 1,
      unknownProviderOperations: 0,
      totalCostUsd: 0,
    });
    expect(summary.byTask).toHaveLength(1);
    expect(summary.byTask[0]).toMatchObject({
      taskId,
      calls: 0,
      providerOperations: 1,
      unknownProviderOperations: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalCostUsd: 0,
    });
    expect(summary.serviceOperations).toEqual({
      operations: 1,
      succeeded: 0,
      failed: 1,
      cancelled: 0,
      interrupted: 0,
      unknown: 0,
      legacy: 0,
    });
    expect(summary.serviceRecovery).toEqual({ attempts: [] });
  });

  test("persists only safe service receipt references and projects unresolved recovery", async () => {
    const payerHumanId = await createUser("service-receipt-reference-owner");
    const taskId = await createTask(payerHumanId);
    const idempotencyKey = providerCostIdempotencyKey(
      `${FIXTURE_PREFIX}:service-receipt-reference:${randomUUID()}`,
    );
    providerCostKeys.push(idempotencyKey);
    const attempt = {
      userId: payerHumanId,
      taskId,
      provider: "tavily",
      operation: "search",
      workload: "deep_research",
      fundingKind: "personal" as const,
      payerHumanId,
      providerRoute: "tavily",
      credentialId: randomUUID(),
      credentialRevision: 1,
      attemptOutcome: "unknown" as const,
      evidenceState: "unknown" as const,
      idempotencyKey,
    };
    await insertProviderCostEventWith(db, attempt);

    const [opened] = await db.select().from(providerCostEvents).where(
      eq(providerCostEvents.idempotencyKey, idempotencyKey),
    );
    expect(opened?.requestReference).toBeNull();

    const rawReceiptId = `private-tavily-request-${randomUUID()}`;
    const requestReference = providerCostRequestReference(rawReceiptId);
    if (requestReference === null) throw new Error("missing safe provider request reference");
    await settleProviderCostEventWith(db, {
      ...attempt,
      attemptOutcome: "succeeded",
      requestReference,
    });

    const unresolved = await getPersonalCostsSummary({
      payerHumanId,
      range: {
        sinceIso: new Date(Date.now() - 60_000).toISOString(),
        untilIso: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const serviceRecovery = unresolved.serviceRecovery;
    if (serviceRecovery === undefined) throw new Error("missing service recovery summary");
    expect(serviceRecovery.attempts).toHaveLength(1);
    expect(serviceRecovery.attempts[0]).toMatchObject({
      provider: "tavily",
      operation: "search",
      attemptOutcome: "succeeded",
      requestReference,
      taskId,
    });
    expect(JSON.stringify(unresolved)).not.toContain(rawReceiptId);

    const estimatedSettlement = {
      ...attempt,
      attemptOutcome: "succeeded" as const,
      evidenceState: "estimated" as const,
      estimatedCostUsd: "0.008",
      pricingVersion: "test-price-v1",
      measuredUnits: 1,
      unitType: "credit",
    };
    // A later settlement without a receipt must preserve the safe reference.
    await settleProviderCostEventWith(db, estimatedSettlement);
    const [settled] = await db.select().from(providerCostEvents).where(
      eq(providerCostEvents.idempotencyKey, idempotencyKey),
    );
    expect(settled).toMatchObject({
      attemptOutcome: "succeeded",
      evidenceState: "estimated",
      requestReference,
    });
    expect(JSON.stringify(settled)).not.toContain(rawReceiptId);

    const conflict = await settleProviderCostEventWith(db, {
      ...estimatedSettlement,
      requestReference: providerCostRequestReference("different-provider-request"),
    }).then(() => null, (error: unknown) => error);
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toBe(
      "Provider cost attempt settlement conflicts with durable state",
    );
    const [afterConflict] = await db.select().from(providerCostEvents).where(
      eq(providerCostEvents.idempotencyKey, idempotencyKey),
    );
    expect(afterConflict?.requestReference).toBe(requestReference);
  });

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

  test("accepts an exact ordinary direct settlement replay without weakening terminal evidence", async () => {
    const payerHumanId = await createUser("direct-settlement-replay");
    const id = attemptId();
    const settledAt = new Date("2026-10-06T10:00:00.000Z");
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
    const settlement = {
      attemptId: id,
      outcome: "succeeded" as const,
      costState: "estimated" as const,
      inputTokens: 120,
      outputTokens: 30,
      estimatedCostUsd: 0.0015,
      pricingVersion: "integration-price-v1",
      settledAt,
    };
    await settlePersonalLlmAttempt(settlement);
    await settlePersonalLlmAttempt(settlement);
    await expectRejected(() => settlePersonalLlmAttempt({
      ...settlement,
      outcome: "failed",
      failureCode: "provider_refused",
    }));
    const [row] = await db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
    expect(row).toMatchObject({
      attemptOutcome: "succeeded",
      costState: "estimated",
      estimatedCostUsd: "0.00150000",
      failureCode: null,
      settledAt,
      totalTokens: 150,
    });
  });

  test("terminal settlement preserves an actual cost recovered before a pending completion", async () => {
    const payerHumanId = await createUser("surplus-recovery-race");
    const id = attemptId();
    const requestId = `req-${randomUUID()}`;
    await beginSurplusLlmAttempt({
      id,
      userId: payerHumanId,
      payerHumanId,
      callType: "chat",
      provider: "venice",
      model: "venice:openai-gpt-55",
      endpoint: "/v1/chat/completions",
      fundingKind: "personal",
      credentialId: randomUUID(),
      credentialRevision: 1,
    });
    await attachSurplusRequestReceipt({ attemptId: id, providerRequestId: requestId });
    const queued = (await listPendingSurplusAttempts({
      updatedBefore: new Date(Date.now() + 60_000),
    })).find((row) => row.id === id);
    if (!queued) throw new Error("Surplus recovery race fixture was not listed");
    expect(await reconcileSurplusLlmAttemptCost({
      attemptId: id,
      providerRequestId: requestId,
      expectedUpdatedAtToken: queued.updatedAtToken,
      actualCostUsd: 0.000283,
    })).toBe(true);
    await settleSurplusLlmAttempt({
      attemptId: id,
      providerRequestId: requestId,
      outcome: "succeeded",
      costState: "pending",
      inputTokens: 11,
      outputTokens: 17,
    });
    const [row] = await db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
    expect(row).toMatchObject({
      attemptOutcome: "succeeded",
      costState: "actual",
      recoveryState: null,
      actualCostUsd: "0.00028300",
      inputTokens: 11,
      outputTokens: 17,
      totalTokens: 28,
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
    const taskId = await createTask(payer);
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
      estimatedCostUsd: 0.005568,
      actualCostUsd: 0.003929,
    });
    const unknownId = attemptId();
    await beginSurplusLlmAttempt({
      id: unknownId,
      userId: payer,
      payerHumanId: payer,
      taskId,
      callType: "chat",
      provider: "anthropic",
      model: "anthropic:claude-sonnet-4-6",
      endpoint: "/v1/chat/completions",
      fundingKind: "personal",
      credentialId: randomUUID(),
      credentialRevision: 1,
    });
    await settleSurplusLlmAttempt({
      attemptId: unknownId,
      providerRequestId: `req-${randomUUID()}`,
      outcome: "succeeded",
      costState: "unknown",
      estimatedCostUsd: 0.007,
    });
    const zeroActualId = attemptId();
    await beginSurplusLlmAttempt({
      id: zeroActualId,
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
      attemptId: zeroActualId,
      outcome: "succeeded",
      costState: "actual",
      estimatedCostUsd: 0.004,
      actualCostUsd: 0,
    });
    const providerCredentialId = randomUUID();
    for (const [label, evidence] of Object.entries({
      actual: {
        evidenceState: "actual" as const,
        estimatedCostUsd: "0.00080000",
        actualCostUsd: "0.00060000",
      },
      estimated: {
        evidenceState: "estimated" as const,
        estimatedCostUsd: "0.00120000",
      },
      unknown: { evidenceState: "unknown" as const },
      zero: {
        evidenceState: "actual" as const,
        estimatedCostUsd: "0.00070000",
        actualCostUsd: "0.00000000",
      },
    })) {
      const idempotencyKey = providerCostIdempotencyKey(`${FIXTURE_PREFIX}:${label}:${randomUUID()}`);
      providerCostKeys.push(idempotencyKey);
      await insertProviderCostEventWith(db, {
        userId: payer,
        provider: "tavily",
        operation: "search",
        fundingKind: "personal",
        payerHumanId: payer,
        providerRoute: "tavily",
        credentialId: providerCredentialId,
        credentialRevision: 1,
        idempotencyKey,
        ...evidence,
      });
    }
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
      calls: 4,
      providerOperations: 4,
      unknownProviderOperations: 1,
      unknownAttempts: 1,
    });
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(0.0032, 8);
    expect(summary.totals.actualCostUsd).toBeCloseTo(0.004529, 8);
    expect(summary.totals.totalCostUsd).toBeCloseTo(0.007729, 8);
    expect(summary.byModel.map((row) => row.model)).toEqual([
      "anthropic:claude-sonnet-4-6",
    ]);
    expect(summary.byModel[0]).toMatchObject({
      provider: "anthropic",
      calls: 4,
      estimatedCostUsd: 0.002,
      actualCostUsd: 0.003929,
      totalCostUsd: 0.005929,
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
      operations: 3,
      unknownOperations: 1,
      estimatedCostUsd: 0,
      actualCostUsd: 0.003929,
      totalCostUsd: 0.003929,
    });
    expect(summary.byProvider.find((row) => row.provider === "tavily")).toMatchObject({
      provider: "tavily",
      operation: "search",
      operations: 4,
      unknownOperations: 1,
      estimatedCostUsd: 0.0012,
      actualCostUsd: 0.0006,
      totalCostUsd: 0.0018,
    });
    expect(summary.byTask).toEqual([{
      taskId,
      calls: 1,
      providerOperations: 0,
      unknownProviderOperations: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
      totalCostUsd: 0,
      pendingAttempts: 0,
      unknownAttempts: 1,
    }]);
    expect(summary.recovery.attempts).toHaveLength(1);
    expect(summary.recovery.attempts[0]).toMatchObject({
      attemptId: unknownId,
      status: "pending",
      reason: "awaiting_provider_receipt",
      providerRoute: "surplus",
      repairAction: "wait_for_receipt",
      taskId,
    });
    expect(summary.recovery.attempts[0]?.requestReference).toMatch(/^req_[0-9a-f]{12}$/);
    expect(summary.recovery.attempts[0]?.requestReference).not.toContain("req-");
    expect(summary.serviceOperations).toEqual({
      operations: 4,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
      unknown: 0,
      legacy: 4,
    });
    expect(summary.serviceRecovery?.attempts).toEqual([expect.objectContaining({
      provider: "tavily",
      operation: "search",
      workload: null,
      attemptOutcome: null,
      failureCode: null,
      taskId: null,
    })]);
    expect(summary.timeSeries).toHaveLength(1);
    expect(summary.timeSeries[0]?.estimatedCostUsd).toBeCloseTo(0.0032, 8);
    expect(summary.timeSeries[0]?.actualCostUsd).toBeCloseTo(0.004529, 8);
    expect(summary.timeSeries[0]?.totalCostUsd).toBeCloseTo(0.007729, 8);
  });

  test("admin costs show current estimates and only non-personal recovery diagnostics", async () => {
    const occurredAt = new Date("2099-04-02T12:00:00.000Z");
    const range = {
      sinceIso: "2099-04-02T00:00:00.000Z",
      untilIso: "2099-04-03T00:00:00.000Z",
    };
    const actualId = attemptId();
    await beginSurplusLlmAttempt({
      id: actualId,
      occurredAt,
      callType: "chat",
      provider: "openai",
      model: "openai:gpt-5.5",
      endpoint: "/v1/chat/completions",
      fundingKind: "server",
    });
    await settleSurplusLlmAttempt({
      attemptId: actualId,
      outcome: "succeeded",
      costState: "actual",
      estimatedCostUsd: 0.9,
      actualCostUsd: 0.4,
    });
    const estimatedId = attemptId();
    await beginSurplusLlmAttempt({
      id: estimatedId,
      occurredAt,
      callType: "chat",
      provider: "openai",
      model: "openai:gpt-5.5",
      endpoint: "/v1/chat/completions",
      fundingKind: "server",
    });
    await settleSurplusLlmAttempt({
      attemptId: estimatedId,
      outcome: "succeeded",
      costState: "estimated",
      estimatedCostUsd: 0.2,
    });
    const unresolvedServerId = attemptId();
    await beginSurplusLlmAttempt({
      id: unresolvedServerId,
      occurredAt,
      callType: "chat",
      provider: "openai",
      model: "openai:gpt-5.5",
      endpoint: "/v1/chat/completions",
      fundingKind: "server",
    });
    await settleSurplusLlmAttempt({
      attemptId: unresolvedServerId,
      providerRequestId: `req-${randomUUID()}`,
      outcome: "succeeded",
      costState: "unknown",
    });
    const personalPayer = await createUser("admin-diagnostic-personal");
    const unresolvedPersonalId = attemptId();
    await beginSurplusLlmAttempt({
      id: unresolvedPersonalId,
      occurredAt,
      userId: personalPayer,
      payerHumanId: personalPayer,
      callType: "chat",
      provider: "openai",
      model: "openai:gpt-5.5",
      endpoint: "/v1/chat/completions",
      fundingKind: "personal",
      credentialId: randomUUID(),
      credentialRevision: 1,
    });
    await settleSurplusLlmAttempt({
      attemptId: unresolvedPersonalId,
      outcome: "succeeded",
      costState: "unknown",
    });

    for (const [label, evidence] of Object.entries({
      actual: {
        evidenceState: "actual" as const,
        estimatedCostUsd: "0.80000000",
        actualCostUsd: "0.30000000",
      },
      estimated: {
        evidenceState: "estimated" as const,
        estimatedCostUsd: "0.10000000",
      },
    })) {
      const idempotencyKey = providerCostIdempotencyKey(
        `${FIXTURE_PREFIX}:admin-current:${label}:${randomUUID()}`,
      );
      providerCostKeys.push(idempotencyKey);
      await insertProviderCostEventWith(db, {
        occurredAt,
        provider: "tavily",
        operation: "search",
        fundingKind: "server",
        providerRoute: "tavily",
        idempotencyKey,
        ...evidence,
      });
    }

    const summary = await getCostsSummary(range);
    expect(summary.totals.estimatedCostUsd).toBeCloseTo(0.3, 8);
    expect(summary.totals.actualCostUsd).toBeCloseTo(0.7, 8);
    expect(summary.totals.totalCostUsd).toBeCloseTo(1, 8);
    expect(summary.recovery.attempts.map((attempt) => attempt.attemptId)).toContain(
      unresolvedServerId,
    );
    expect(summary.recovery.attempts.map((attempt) => attempt.attemptId)).not.toContain(
      unresolvedPersonalId,
    );
  });

  test("a current replacement key requeues old blocked receipts only for its payer", async () => {
    const payerHumanId = await createUser("requeue-owner");
    const oldCredentialId = randomUUID();
    const currentCredentialId = randomUUID();
    const currentCredentialRevision = 4;
    await db.insert(personalProviderCredentials).values({
      id: currentCredentialId,
      userId: payerHumanId,
      provider: "surplus",
      revision: currentCredentialRevision,
      formatVersion: 1,
      keyId: randomUUID(),
      nonceBase64: "fixture-nonce",
      ciphertextBase64: "fixture-ciphertext",
      authTagBase64: "fixture-auth-tag",
    });
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
      credentialId: oldCredentialId,
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
      credentialId: oldCredentialId,
      credentialRevision: 3,
    })).toBe(0);
    expect(await requeueBlockedPersonalSurplusAttempts({
      payerHumanId: await createUser("requeue-other"),
      credentialId: currentCredentialId,
      credentialRevision: currentCredentialRevision,
    })).toBe(0);
    expect(await requeueBlockedPersonalSurplusAttempts({
      payerHumanId,
      credentialId: currentCredentialId,
      credentialRevision: currentCredentialRevision,
    })).toBe(1);
    const [requeued] = await db.select({
      recoveryState: llmUsageEvents.recoveryState,
      failureCode: llmUsageEvents.failureCode,
    }).from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
    expect(requeued).toEqual({ recoveryState: "retryable", failureCode: null });
    const [attempt] = await db.select({
      payerHumanId: llmUsageEvents.payerHumanId,
      credentialId: llmUsageEvents.credentialId,
      credentialRevision: llmUsageEvents.credentialRevision,
    }).from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
    expect(attempt).toEqual({
      payerHumanId,
      credentialId: oldCredentialId,
      credentialRevision: 3,
    });
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
