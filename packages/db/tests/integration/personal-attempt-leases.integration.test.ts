import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PERSONAL_LLM_ATTEMPT_LEASE_MS,
  and,
  beginPersonalLlmAttempt,
  createDirectDb,
  ensureDatabase,
  eq,
  inArray,
  interruptExpiredPersonalLlmAttempts,
  interruptPersonalLlmAttemptsByOwner,
  isNotNull,
  llmUsageEvents,
  lte,
  ne,
  notInArray,
  renewPersonalLlmAttemptLeases,
  settlePersonalLlmAttempt,
  users,
  type DirectDatabase,
  type LlmUsageEvent,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const FIXTURE_PREFIX = "personal-attempt-leases-integration";
const HISTORICAL_NOW = new Date("2000-01-01T00:00:00.000Z");
const HISTORICAL_LIVE_LEASE = new Date(HISTORICAL_NOW.getTime() + 30_000);
const HISTORICAL_EXPIRED_LEASE = new Date(HISTORICAL_NOW.getTime() - 1_000);

let db: DirectDatabase;
const attemptIds: string[] = [];
const userIds: string[] = [];

function attemptId(): string {
  const id = randomUUID();
  attemptIds.push(id);
  return id;
}

async function createUser(label: string): Promise<string> {
  const [row] = await db.insert(users).values({
    name: `${FIXTURE_PREFIX}:${label}:${randomUUID()}`,
  }).returning({ id: users.id });
  if (!row) throw new Error("Personal attempt lease fixture user was not created");
  userIds.push(row.id);
  return row.id;
}

function beginInput(input: {
  id: string;
  ownerToken: string;
  userId: string;
  credentialId?: string;
}) {
  return {
    id: input.id,
    ownerToken: input.ownerToken,
    userId: input.userId,
    callType: "chat",
    provider: "openai",
    model: "openai:test-model",
    providerRoute: "openai",
    credentialId: input.credentialId ?? randomUUID(),
    credentialRevision: 3,
    endpoint: "/v1/responses",
    metadata: { fixture: FIXTURE_PREFIX },
  };
}

function directAttemptValues(input: {
  id: string;
  userId: string;
  credentialId?: string;
  ownerToken?: string | null;
  leaseExpiresAt?: Date | null;
}) {
  return {
    id: input.id,
    userId: input.userId,
    callType: "chat",
    provider: "openai",
    model: "openai:test-model",
    endpoint: "/v1/responses",
    providerRoute: "openai",
    fundingKind: "personal" as const,
    payerHumanId: input.userId,
    credentialId: input.credentialId ?? randomUUID(),
    credentialRevision: 3,
    attemptOutcome: "in_progress" as const,
    costState: "pending" as const,
    estimatedCostUsd: "0.00000000",
    actualCostUsd: null,
    attemptOwnerToken: input.ownerToken ?? null,
    attemptLeaseExpiresAt: input.leaseExpiresAt ?? null,
    metadata: { fixture: FIXTURE_PREFIX },
  };
}

async function readAttempt(id: string): Promise<LlmUsageEvent> {
  const [row] = await db.select().from(llmUsageEvents).where(eq(llmUsageEvents.id, id));
  if (!row) throw new Error(`Personal attempt lease fixture ${id} was not found`);
  return row;
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
  db = createDirectDb(4);
});

afterAll(async () => {
  if (attemptIds.length > 0) {
    await db?.delete(llmUsageEvents).where(inArray(llmUsageEvents.id, attemptIds));
  }
  if (userIds.length > 0) {
    await db?.delete(users).where(inArray(users.id, userIds));
  }
  await db?.end();
});

describe("direct personal attempt lease lifecycle", () => {
  test("prewires owner and lease from database time before inference", async () => {
    const userId = await createUser("prewire");
    const id = attemptId();
    const ownerToken = randomUUID();
    const credentialId = randomUUID();

    await beginPersonalLlmAttempt(beginInput({ id, ownerToken, userId, credentialId }));

    const row = await readAttempt(id);
    expect(row.attemptOwnerToken).toBe(ownerToken);
    if (!row.attemptLeaseExpiresAt) throw new Error("Expected the attempt lease to be prewired");
    expect(row.attemptLeaseExpiresAt.getTime() - row.occurredAt.getTime())
      .toBe(PERSONAL_LLM_ATTEMPT_LEASE_MS);
    expect(row).toMatchObject({
      userId,
      payerHumanId: userId,
      credentialId,
      credentialRevision: 3,
      attemptOutcome: "in_progress",
      costState: "pending",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerRequestId: null,
      actualCostUsd: null,
    });
  });

  test("enforces the owner-token and lease pair invariant", async () => {
    const userId = await createUser("owner-pair");
    const leaseWithoutOwnerId = attemptId();
    const ownerWithoutLeaseId = attemptId();

    await expectRejected(() => db.insert(llmUsageEvents).values(directAttemptValues({
      id: leaseWithoutOwnerId,
      userId,
      leaseExpiresAt: HISTORICAL_LIVE_LEASE,
    })));
    await expectRejected(() => db.insert(llmUsageEvents).values(directAttemptValues({
      id: ownerWithoutLeaseId,
      userId,
      ownerToken: randomUUID(),
    })));
  });

  test("renews only the exact live owner and denies settlement by another token", async () => {
    const userId = await createUser("exact-owner");
    const id = attemptId();
    const ownerToken = randomUUID();
    const wrongToken = randomUUID();
    await beginPersonalLlmAttempt(beginInput({ id, ownerToken, userId }));
    const initial = await readAttempt(id);
    if (!initial.attemptLeaseExpiresAt) throw new Error("Expected the attempt lease to be prewired");
    const renewalNow = new Date(initial.attemptLeaseExpiresAt.getTime() - 30_000);

    expect(await renewPersonalLlmAttemptLeases({ ownerToken: wrongToken, now: renewalNow })).toBe(0);
    expect(await renewPersonalLlmAttemptLeases({ ownerToken, now: renewalNow })).toBe(1);
    expect((await readAttempt(id)).attemptLeaseExpiresAt?.getTime())
      .toBe(renewalNow.getTime() + PERSONAL_LLM_ATTEMPT_LEASE_MS);

    await expectRejected(() => settlePersonalLlmAttempt({
      attemptId: id,
      ownerToken: wrongToken,
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0,
    }));
    expect((await readAttempt(id)).attemptOutcome).toBe("in_progress");
  });

  test("expiry and shutdown interrupt without losing payer or credential provenance", async () => {
    const userId = await createUser("interruptions");
    const expiredId = attemptId();
    const shutdownId = attemptId();
    const legacyId = attemptId();
    const expiredOwner = randomUUID();
    const shutdownOwner = randomUUID();
    const expiredCredential = randomUUID();
    const shutdownCredential = randomUUID();
    await beginPersonalLlmAttempt(beginInput({
      id: expiredId,
      ownerToken: expiredOwner,
      userId,
      credentialId: expiredCredential,
    }));
    await beginPersonalLlmAttempt(beginInput({
      id: shutdownId,
      ownerToken: shutdownOwner,
      userId,
      credentialId: shutdownCredential,
    }));
    await db.update(llmUsageEvents).set({
      attemptLeaseExpiresAt: HISTORICAL_EXPIRED_LEASE,
    }).where(eq(llmUsageEvents.id, expiredId));
    await db.insert(llmUsageEvents).values(directAttemptValues({ id: legacyId, userId }));

    // The expiry API is intentionally global. A historical injected clock plus
    // this preflight guarantees the test cannot sweep a non-fixture row.
    const foreignExpired = await db.select({ id: llmUsageEvents.id }).from(llmUsageEvents).where(and(
      eq(llmUsageEvents.fundingKind, "personal"),
      ne(llmUsageEvents.providerRoute, "surplus"),
      eq(llmUsageEvents.attemptOutcome, "in_progress"),
      isNotNull(llmUsageEvents.attemptOwnerToken),
      isNotNull(llmUsageEvents.attemptLeaseExpiresAt),
      lte(llmUsageEvents.attemptLeaseExpiresAt, HISTORICAL_NOW),
      notInArray(llmUsageEvents.id, attemptIds),
    )).limit(1);
    expect(foreignExpired).toEqual([]);

    expect(await interruptExpiredPersonalLlmAttempts({ now: HISTORICAL_NOW })).toBe(1);
    expect(await interruptPersonalLlmAttemptsByOwner({ ownerToken: shutdownOwner })).toBe(1);

    const expired = await readAttempt(expiredId);
    const shutdown = await readAttempt(shutdownId);
    for (const [row, failureCode, credentialId] of [
      [expired, "attempt_owner_expired", expiredCredential],
      [shutdown, "attempt_owner_shutdown", shutdownCredential],
    ] as const) {
      expect(row).toMatchObject({
        userId,
        payerHumanId: userId,
        credentialId,
        credentialRevision: 3,
        attemptOutcome: "interrupted",
        costState: "unknown",
        failureCode,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        providerRequestId: null,
        actualCostUsd: null,
      });
    }
    expect(await readAttempt(legacyId)).toMatchObject({
      attemptOwnerToken: null,
      attemptLeaseExpiresAt: null,
      attemptOutcome: "in_progress",
      costState: "pending",
    });

    await settlePersonalLlmAttempt({
      attemptId: shutdownId,
      ownerToken: shutdownOwner,
      outcome: "succeeded",
      costState: "actual",
      actualCostUsd: 0.0125,
      providerRequestId: `fixture-request-${randomUUID()}`,
      inputTokens: 11,
      outputTokens: 7,
    });
    expect(await readAttempt(shutdownId)).toMatchObject({
      attemptOutcome: "interrupted",
      failureCode: "attempt_owner_shutdown",
      costState: "actual",
      actualCostUsd: "0.01250000",
      inputTokens: 11,
      outputTokens: 7,
      totalTokens: 18,
      payerHumanId: userId,
      credentialId: shutdownCredential,
    });
  });

  test("renews and drains more than one page without touching another owner", async () => {
    const userId = await createUser("paged-owner");
    const ownerToken = randomUUID();
    const replicaToken = randomUUID();
    const ownerIds = Array.from({ length: 205 }, () => attemptId());
    const replicaIds = Array.from({ length: 3 }, () => attemptId());
    await db.insert(llmUsageEvents).values([
      ...ownerIds.map((id) => directAttemptValues({
        id,
        userId,
        ownerToken,
        leaseExpiresAt: HISTORICAL_LIVE_LEASE,
      })),
      ...replicaIds.map((id) => directAttemptValues({
        id,
        userId,
        ownerToken: replicaToken,
        leaseExpiresAt: HISTORICAL_LIVE_LEASE,
      })),
    ]);

    const renewalPages: number[] = [];
    for (;;) {
      const count = await renewPersonalLlmAttemptLeases({
        ownerToken,
        limit: 100,
        now: HISTORICAL_NOW,
      });
      renewalPages.push(count);
      if (count === 0) break;
    }
    expect(renewalPages).toEqual([100, 100, 5, 0]);

    const drainPages: number[] = [];
    for (;;) {
      const count = await interruptPersonalLlmAttemptsByOwner({
        ownerToken,
        limit: 100,
        now: HISTORICAL_NOW,
      });
      drainPages.push(count);
      if (count === 0) break;
    }
    expect(drainPages).toEqual([100, 100, 5, 0]);

    const ownerRows = await db.select({
      outcome: llmUsageEvents.attemptOutcome,
      failureCode: llmUsageEvents.failureCode,
    }).from(llmUsageEvents).where(inArray(llmUsageEvents.id, ownerIds));
    expect(ownerRows).toHaveLength(205);
    expect(ownerRows.every((row) => row.outcome === "interrupted"
      && row.failureCode === "attempt_owner_shutdown")).toBe(true);

    const replicaRows = await db.select({
      outcome: llmUsageEvents.attemptOutcome,
      leaseExpiresAt: llmUsageEvents.attemptLeaseExpiresAt,
    }).from(llmUsageEvents).where(inArray(llmUsageEvents.id, replicaIds));
    expect(replicaRows).toHaveLength(3);
    expect(replicaRows.every((row) => row.outcome === "in_progress"
      && row.leaseExpiresAt?.getTime() === HISTORICAL_LIVE_LEASE.getTime())).toBe(true);
  });
});
