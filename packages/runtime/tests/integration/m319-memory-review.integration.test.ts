import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { findResumedMemoryReviewAdmission } from "../../src/memory-review/admission";
import { randomUUID } from "node:crypto";
import {
  actors, agents, rooms, roomMembers, namespaces, sessions, sessionMessages, users,
  groups, groupMembers, memoryReviewTurns, memoryReviewReceipts,
  admitMemoryReviewSourceInTx, markMemoryReviewTurnInTx, eq, sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { appendTranscriptMessages, withSerializableAgentTrustContext, type PreparedMemoryReview } from "@nautilo/agent";
import { initPolicyResolver, type NamespaceMemoryEnvelope } from "@nautilo/trust";
import { PostgresMemoryReviewRepository } from "../../src/memory-review/repository";
import { createIntegrationStubPolicyResolver } from "./integration-stub-policy";
import { createTestUser, createTestRoom, getDirectDb, closeDirectDb } from "./helpers";

// This suite mutates only its UUID-scoped synthetic fixture on the approved clone.
const instanceId = process.env["NAUTILO_INSTANCE_ID"]?.trim();
if (!instanceId || !/(?:^|[-_])(test|qa|cruft)(?:$|[-_])/iu.test(instanceId)) throw new Error("M319 integration requires an explicit test, qa, or cruft instance");
const db = getDirectDb();
let userId = "";
let agentId = "";
let roomId = "";
let namespaceId = "";
let actorId = "";
let sessionId = "";
const threadId = `m319-integration:${randomUUID()}`;
let envelope: NamespaceMemoryEnvelope;
const repo = new PostgresMemoryReviewRepository({ threshold: () => 2, leaseMs: 120_000, retryMs: 15_000, retentionMs: 86_400_000, retentionBatchSize: 10, assertAvailable: async () => {} }, db);

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
