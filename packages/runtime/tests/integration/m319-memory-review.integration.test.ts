import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { findResumedMemoryReviewAdmission } from "../../src/memory-review/admission";
import { randomUUID } from "node:crypto";
import {
  actors, agents, rooms, roomMembers, namespaces, sessions, sessionMessages, users,
  groups, groupMembers, memoryReviewTurns, memoryReviewReceipts, memoryReviewModelRecoveries, llmUsageEvents,
  admitMemoryReviewSourceInTx, markMemoryReviewTurnInTx, getSharedDirectDb, eq, sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { appendTranscriptMessages, withSerializableAgentTrustContext, type PreparedMemoryReview } from "@nautilo/agent";
import { initPolicyResolver, type NamespaceMemoryEnvelope } from "@nautilo/trust";
import { PostgresMemoryReviewRepository } from "../../src/memory-review/repository";
import { recoverMemoryReviewTurnsAtStartup } from "../../src/memory-review/startup-recovery";
import { createIntegrationStubPolicyResolver } from "./integration-stub-policy";
import { createTestUser, createTestRoom, getDirectDb, closeDirectDb } from "./helpers";

// This suite mutates only its UUID-scoped synthetic fixture on the explicit test instance.
const instanceId = process.env["NAUTILO_INSTANCE_ID"]?.trim();
if (!instanceId || !/(?:^|[-_])(tests?|qa|cruft)(?:$|[-_])/iu.test(instanceId)) throw new Error("M319 integration requires an explicit test, tests, qa, or cruft instance");
const db = getDirectDb();
let userId = "";
let agentId = "";
let roomId = "";
let namespaceId = "";
let actorId = "";
let sessionId = "";
const threadId = `m319-integration:${randomUUID()}`;
let envelope: NamespaceMemoryEnvelope;
// Exercise recovery through the runtime product role even when a suite uses
// a separate direct connection for fixtures.
const repo = new PostgresMemoryReviewRepository({ threshold: () => 2, leaseMs: 120_000, retryMs: 15_000, retentionMs: 86_400_000, retentionBatchSize: 10, assertAvailable: async () => {} }, getSharedDirectDb());

beforeAll(async () => {
  bootstrapTestDbInstance();
  const pending = await db.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM memory_review_turns WHERE receipt_id IS NULL`);
  if (pending[0]?.count) throw new Error("M319 global-claim integration refuses pre-existing pending Memory work; preserve it and use an idle clone");
  ({ userId } = await createTestUser(`m319-${randomUUID()}`));
  ({ roomId } = await createTestRoom(userId));
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
  namespaceId = room!.namespaceId;
  const [actor] = await db.select().from(actors).where(eq(actors.ownerId, userId));
  actorId = actor!.id;
  await db.update(rooms).set({ humanActorIds: [actorId] }).where(eq(rooms.id, roomId));
  const [agent] = await db.insert(agents).values({ handle: `m319-${randomUUID()}` }).returning();
  agentId = agent!.id;
  const [agentActor] = await db.insert(actors).values({ ownerId: userId, kind: "agent", agentId, displayName: "M319 integration Agent" }).returning();
  await db.insert(roomMembers).values({ roomId, actorId: agentActor!.id, roomRole: "member" });
  const [contributors] = await db.select().from(groups).where(eq(groups.type, "contributors"));
  if (!contributors) throw new Error("M319 fixture requires existing canonical contributors group");
  await db.insert(groupMembers).values({ userId, groupId: contributors.id, grantedBy: actorId });
  const [session] = await db.insert(sessions).values({ threadId, ownerId: userId, agentId, roomId }).returning();
  sessionId = session!.id;
  envelope = { ownerId: userId, actorId, agentId, roomId, toolPolicy: {}, readableNamespaces: [namespaceId], mutableNamespaces: [namespaceId], writableNamespaces: [namespaceId] };
  initPolicyResolver({ ...createIntegrationStubPolicyResolver(userId), buildEnvelope: async () => envelope });
});

afterAll(async () => {
  if (userId) {
    if (roomId) await db.delete(llmUsageEvents).where(eq(llmUsageEvents.roomId, roomId));
    await db.delete(memoryReviewReceipts).where(eq(memoryReviewReceipts.ownerId, userId));
    await db.delete(memoryReviewTurns).where(eq(memoryReviewTurns.ownerId, userId));
    if (sessionId) { await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, sessionId)); await db.delete(sessions).where(eq(sessions.id, sessionId)); }
    await db.delete(groupMembers).where(eq(groupMembers.userId, userId));
    if (roomId) { await db.delete(roomMembers).where(eq(roomMembers.roomId, roomId)); await db.delete(rooms).where(eq(rooms.id, roomId)); }
    await db.delete(actors).where(eq(actors.ownerId, userId));
    if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
    if (namespaceId) await db.delete(namespaces).where(eq(namespaces.id, namespaceId));
    await db.delete(users).where(eq(users.id, userId));
  }
  await closeDirectDb();
});

async function admit(turnId: string) {
  await db.transaction(async (tx) => {
    const [message] = await tx.insert(sessionMessages).values({ sessionId, role: "user", content: "Synthetic Memory review evidence", humanTurnId: turnId }).returning();
    const admission = { sessionId, threadId, ownerId: userId, actorId, agentId, roomId, accessScope: "namespace", checkpointThreadId: threadId, turnId, existingSourceMessageIds: [message!.id] };
    await admitMemoryReviewSourceInTx(tx, admission);
    await admitMemoryReviewSourceInTx(tx, admission);
    await markMemoryReviewTurnInTx(tx, { threadId, agentId, turnId, state: "completed" });
  });
}

describe("M319 durable Memory processing on PostgreSQL", () => {
  test("replayed admission counts once, concurrent claims have one winner, and no-change publishes receipt plus coverage", async () => {
    const resumedTurnId = randomUUID();
    await admit(resumedTurnId); await admit(randomUUID());
    const checkpointThreadId = `${threadId}:fork:1`;
    await db.update(memoryReviewTurns).set({ checkpointThreadId, state: "awaiting", completedAt: null }).where(eq(memoryReviewTurns.turnId, resumedTurnId));
    const lookup = { checkpointThreadId, turnId: resumedTurnId, threadId, transcriptOwnerId: userId, agentId };
    const resumed = await findResumedMemoryReviewAdmission(lookup);
    expect(resumed).toBeDefined();
    expect(await findResumedMemoryReviewAdmission({ ...lookup, checkpointThreadId: "wrong-checkpoint" })).toBeUndefined();
    expect(await findResumedMemoryReviewAdmission({ ...lookup, transcriptOwnerId: randomUUID() })).toBeUndefined();
    expect(await repo.claimNext({ now: new Date() })).toBeNull();
    const appended = await appendTranscriptMessages(threadId, userId, "owner", [new AIMessage("Synthetic resumed assistant evidence")], {
      agentId, roomId, humanTurnId: resumedTurnId,
      memoryReview: { ownerId: resumed!.ownerId, actorId: resumed!.actorId,
        accessScope: resumed!.accessScope, checkpointThreadId: resumed!.checkpointThreadId },
    });
    expect(appended.insertedCount).toBe(1);
    const [pendingResume] = await db.select().from(memoryReviewTurns).where(eq(memoryReviewTurns.id, resumed!.id));
    expect(pendingResume!.hasHuman).toBe(1);
    expect(pendingResume!.sourceIds).toHaveLength(2);
    expect(pendingResume!.sourceIds).toContain(Number(appended.insertedRows[0]!.id));
    expect(pendingResume!.state).toBe("pending");
    expect(await repo.claimNext({ now: new Date() })).toBeNull();
    await db.transaction(tx => markMemoryReviewTurnInTx(tx, { threadId, agentId, turnId: resumedTurnId, reviewTurnId: resumed!.id, state: "awaiting" }));
    expect(await repo.claimNext({ now: new Date() })).toBeNull();
    await db.transaction(tx => markMemoryReviewTurnInTx(tx, { threadId, agentId, turnId: resumedTurnId, reviewTurnId: resumed!.id, state: "completed" }));
    const turns = await db.select().from(memoryReviewTurns).where(eq(memoryReviewTurns.ownerId, userId));
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.hasHuman)).toEqual([1, 1]);
    const contenders = await Promise.all([repo.claimNext({ now: new Date() }), repo.claimNext({ now: new Date() })]);
    const claims = contenders.filter((claim) => claim !== null);
    expect(claims).toHaveLength(1);
    let claim = claims[0]!;
    expect(claim.ownerId).toBe(userId);
    await repo.load(claim);
    const proposal: PreparedMemoryReview = { envelope, speakerUserId: userId, operations: [], snapshots: [] };
    // A terminal-receipt write failure must roll back coverage in the same transaction.
    await db.insert(memoryReviewReceipts).values({ id: claim.attemptId, workId: claim.workId, actorId, ownerId: userId, agentId, modelId: "integration:collision", outcome: "failed", counts: { created: 0, replaced: 0, promoted: 0, demoted: 0 }, effects: [], durationMs: 0 });
    expect(await repo.publish({ claim, proposal, modelId: "integration:no-model-call", now: new Date(), durationMs: 0 }).then(() => false, () => true)).toBe(true);
    const rolledBack = await db.select().from(memoryReviewTurns).where(eq(memoryReviewTurns.ownerId, userId));
    expect(rolledBack.every((turn) => turn.receiptId === null && turn.state === "completed")).toBe(true);
    const failedClaim = claim;
    const failedAt = new Date();
    await repo.fail({ claim, phase: "publication", reason: "publication_uncertain", retryable: false, now: failedAt });
    expect(await repo.claimNext({ now: failedAt })).toBeNull();
    const recovered = await repo.claimNext({ now: new Date(failedAt.getTime() + 15_001) });
    expect(recovered).not.toBeNull();
    claim = recovered!;
    expect(claim.workId).toBe(failedClaim.workId);
    expect(claim.attemptId).not.toBe(failedClaim.attemptId);
    expect(await repo.reconcile(claim)).toBe("not_published");
    // The row-lock/attempt rotation prevents a delayed old publisher from committing.
    expect(await repo.publish({ claim: failedClaim, proposal, modelId: "integration:stale", now: new Date(), durationMs: 0 }).then(() => false, () => true)).toBe(true);
    // Also recover uncertain rows written by earlier servers without a retry time.
    await repo.fail({ claim, phase: "reconciliation", reason: "publication_uncertain", retryable: false, now: failedAt });
    await db.update(memoryReviewTurns).set({ retryAt: null }).where(eq(memoryReviewTurns.ownerId, userId));
    const legacyRecovery = await repo.claimNext({ now: failedAt });
    expect(legacyRecovery).not.toBeNull();
    claim = legacyRecovery!;
    expect(await repo.reconcile(claim)).toBe("not_published");
    await repo.load(claim);
    expect(await repo.publish({ claim, proposal, modelId: "integration:no-model-call", now: new Date(), durationMs: 0 })).toBe("published");
    const [receipt] = await db.select().from(memoryReviewReceipts).where(eq(memoryReviewReceipts.id, claim.attemptId));
    expect(receipt!.counts).toEqual({ created: 0, replaced: 0, promoted: 0, demoted: 0 });
    expect(receipt!.effects).toEqual([]);
    const covered = await db.select().from(memoryReviewTurns).where(eq(memoryReviewTurns.ownerId, userId));
    expect(covered.every((turn) => turn.state === "covered" && turn.receiptId === receipt!.id)).toBe(true);
    expect(await findResumedMemoryReviewAdmission(lookup)).toBeUndefined();
    expect(await repo.reconcile({ ...claim, attemptId: randomUUID() })).toBe("published");
    // Simulate a lost acknowledgement after commit: recording the apparent
    // failure cannot uncover completed turns or schedule a duplicate review.
    await repo.fail({ claim, phase: "publication", reason: "publication_uncertain", retryable: false, now: new Date() });
    expect(await repo.reconcile(claim)).toBe("published");
    expect(await repo.claimNext({ now: new Date() })).toBeNull();
  });

  test("an exact operator recovery reuses the work identity and publishes once after reading settled history", async () => {
    await admit(randomUUID());
    await admit(randomUUID());
    const now = new Date();
    const previous = await repo.claimNext({ now });
    if (!previous) throw new Error("expected original review claim");
    const request = { workId: previous.workId, headTurnId: previous.turnIds[0]!, authorizedBy: userId, now };
    const model = "fixture:recovery";
    await repo.bindServiceModel(previous, () => model);
    expect(await repo.requestModelRecovery(request)).toBe("blocked");
    await repo.fail({ claim: previous, phase: "model", reason: "provider_outcome_unknown", retryable: false, now });

    // The ledger can belong to an older invocation, because the latest failed
    // lease may have been assigned only to detect the unresolved result.
    const priorWireAttemptId = randomUUID();
    const [wire] = await db.insert(llmUsageEvents).values({
      roomId, callType: "memory_review", model, provider: "fixture",
      fundingKind: "service", providerRoute: "surplus", providerRequestId: randomUUID(),
      endpoint: "/v1/chat/completions",
      attemptOutcome: "succeeded", costState: "pending",
      metadata: { workId: previous.workId, attemptId: priorWireAttemptId },
    }).returning({ id: llmUsageEvents.id });
    expect(await repo.requestModelRecovery(request)).toBe("blocked");
    await db.update(llmUsageEvents).set({ costState: "actual", actualCostUsd: "0.01" })
      .where(eq(llmUsageEvents.id, wire!.id));
    expect(await repo.requestModelRecovery({ ...request, headTurnId: previous.turnIds[1]! })).toBe("blocked");
    expect((await Promise.all([repo.requestModelRecovery(request), repo.requestModelRecovery(request)])).sort())
      .toEqual(["already_requested", "queued"]);
    await Promise.resolve(expect(withSerializableAgentTrustContext({ userId, agentId }, tx =>
      tx.update(memoryReviewModelRecoveries).set({ spentAt: now }).where(eq(memoryReviewModelRecoveries.workId, previous.workId)),
    )).rejects.toThrow());

    const next = (await Promise.all([repo.claimNext({ now }), repo.claimNext({ now })]))
      .filter(claim => claim !== null);
    expect(next).toHaveLength(1);
    const claim = next[0]!;
    expect(claim).toMatchObject({ workId: previous.workId, turnIds: previous.turnIds, modelRecovery: "authorized" });
    expect(claim.attemptId).not.toBe(previous.attemptId);
    expect(await repo.reconcile(claim)).toBe("not_published");
    expect(await repo.modelReplaySafety(claim)).toBe("allow");
    expect(await repo.bindServiceModel(claim, () => "changed-default")).toBe(model);
    expect(await repo.claimNext({ now: new Date(claim.leaseUntil.getTime() + 1) })).toBeNull();

    await repo.load(claim);
    const proposal: PreparedMemoryReview = { envelope, speakerUserId: userId, operations: [], snapshots: [] };
    expect(await repo.publish({ claim, proposal, modelId: model, now, durationMs: 0 })).toBe("published");
    await repo.fail({ claim, phase: "publication", reason: "publication_uncertain", retryable: false, now });
    expect(await repo.reconcile(claim)).toBe("published");
    const receipts = await db.select({ outcome: memoryReviewReceipts.outcome }).from(memoryReviewReceipts)
      .where(eq(memoryReviewReceipts.workId, previous.workId));
    expect(receipts.filter(receipt => receipt.outcome === "published")).toHaveLength(1);
    expect(await repo.requestModelRecovery(request)).toBe("blocked");
    expect(await repo.claimNext({ now })).toBeNull();
  });

  test("startup reconciles a stale checkpoint barrier and review advances through it", async () => {
    const awaitingTurnId = randomUUID();
    const newerTurnId = randomUUID();
    await admit(awaitingTurnId);
    await admit(newerTurnId);
    await admit(randomUUID());
    const now = new Date();
    const [barrier] = await db.update(memoryReviewTurns).set({
      state: "awaiting", completedAt: null, updatedAt: new Date(now.getTime() - 1_000),
    }).where(eq(memoryReviewTurns.turnId, awaitingTurnId)).returning({ id: memoryReviewTurns.id });
    if (!barrier) throw new Error("expected the fixture checkpoint barrier");
    expect(await repo.claimNext({ now })).toBeNull();

    const reconciled = await recoverMemoryReviewTurnsAtStartup({
      db: getSharedDirectDb(), bootCutoff: now, pageSize: 1,
      isTurnActive: (turnId) => turnId !== awaitingTurnId,
      checkAvailable: async () => true,
      readCheckpoint: (checkpointThreadId) => {
        expect(checkpointThreadId).toBe(threadId);
        return Promise.resolve({
          checkpoint: { channel_values: { turnId: newerTurnId } },
          pendingWrites: [],
        });
      },
    });
    expect(reconciled).toEqual({ recovered: 1, unavailable: false });
    const [interrupted] = await db.select({ state: memoryReviewTurns.state })
      .from(memoryReviewTurns).where(eq(memoryReviewTurns.id, barrier.id));
    expect(interrupted?.state).toBe("interrupted");

    const claim = await repo.claimNext({ now: new Date() });
    if (!claim) throw new Error("expected review to advance past the stale checkpoint");
    expect(claim.turnIds).toHaveLength(3);
    expect(claim.turnIds[0]).toBe(barrier.id);
    await repo.load(claim);
    const proposal: PreparedMemoryReview = { envelope, speakerUserId: userId, operations: [], snapshots: [] };
    expect(await repo.publish({
      claim, proposal, modelId: "fixture:checkpoint", now: new Date(), durationMs: 0,
    })).toBe("published");
    expect(await repo.claimNext({ now: new Date() })).toBeNull();
  });

  test("Agent guard observes disabled users and its role cannot rewrite publication receipts", async () => {
    const trust = { userId, agentId };
    const guard = () => withSerializableAgentTrustContext(trust, (tx) => tx.execute<{ active: boolean }>(sql`SELECT app_memory_review_actor_is_active() AS active`));
    expect((await guard())[0]!.active).toBe(true);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    try { expect((await guard())[0]!.active).toBe(false); }
    finally { await db.update(users).set({ disabledAt: null }).where(eq(users.id, userId)); }
    expect(await withSerializableAgentTrustContext(trust, (tx) => tx.execute(sql`UPDATE memory_review_receipts SET delivered=0 WHERE owner_id=${userId}::uuid`)).then(() => false, () => true)).toBe(true);
    expect(await withSerializableAgentTrustContext(trust, (tx) => tx.execute(sql`SELECT email FROM users WHERE id=${userId}::uuid`)).then(() => false, () => true)).toBe(true);
  });
});
