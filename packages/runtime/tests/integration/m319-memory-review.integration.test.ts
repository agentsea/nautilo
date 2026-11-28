import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { findResumedMemoryReviewAdmission } from "../../src/memory-review/admission";
import { randomUUID } from "node:crypto";
import {
  actors, agents, rooms, roomMembers, namespaces, profiles, sessions, sessionMessages, users,
  compareAndSwapEncryptionTransitionPolicy, cryptoObjects, getEncryptionTransitionPolicy,
  groups, groupMembers, memoryReviewTurns, memoryReviewReceipts, memoryReviewModelRecoveries, llmUsageEvents,
  admitMemoryReviewSourceInTx, markMemoryReviewTurnInTx, retryFailedMemoryReviews,
  getSharedDirectDb, eq, inArray, sql,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { appendTranscriptMessages, withSerializableAgentTrustContext, type PreparedMemoryReview } from "@nautilo/agent";
import { deleteMessageHardInTx, editCanonicalTranscriptMessageInTx, initPolicyResolver, type NamespaceMemoryEnvelope } from "@nautilo/trust";
import { PostgresMemoryReviewRepository } from "../../src/memory-review/repository";
import { MemoryReviewWorker, type MemoryReviewClaim } from "../../src/memory-review/worker";
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
const policy = { threshold: () => 2, leaseMs: 120_000, retryMs: 15_000, retentionMs: 86_400_000, retentionBatchSize: 10, assertAvailable: async () => {} };
const repo = new PostgresMemoryReviewRepository(policy, getSharedDirectDb());

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
  return db.transaction(async (tx) => {
    const [message] = await tx.insert(sessionMessages).values({ sessionId, role: "user", content: "Synthetic Memory review evidence", humanTurnId: turnId }).returning();
    const admission = { sessionId, threadId, ownerId: userId, actorId, agentId, roomId, accessScope: "namespace", checkpointThreadId: threadId, turnId, existingSourceMessageIds: [message!.id] };
    await admitMemoryReviewSourceInTx(tx, admission);
    await admitMemoryReviewSourceInTx(tx, admission);
    await markMemoryReviewTurnInTx(tx, { threadId, agentId, turnId, state: "completed" });
    return message!.id;
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
    await repo.beginModelRecoveryDispatch(claim);
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

  test("a resumed turn revokes an unsent recovery reservation and allows fresh consent", async () => {
    const resumedTurnId = randomUUID();
    await admit(resumedTurnId);
    await admit(randomUUID());
    const previous = await repo.claimNext({ now: new Date() });
    if (!previous) throw new Error("expected original review claim");
    const modelId = "openai:gpt-5.6-sol";
    const accepted = {
      version: 1 as const, kind: "service" as const, role: "memoryReview" as const, modelId,
      inputCommitment: `hmac-sha256:${"a".repeat(43)}`,
    };
    await repo.bindModelOperation(previous, async () => accepted);
    await db.insert(llmUsageEvents).values({
      roomId, callType: "memory_review", model: modelId, provider: "openai",
      fundingKind: "service", providerRoute: "surplus", providerRequestId: randomUUID(),
      endpoint: "/v1/chat/completions", attemptOutcome: "succeeded", costState: "actual",
      actualCostUsd: "0.01", metadata: { workId: previous.workId, attemptId: previous.attemptId },
    });
    await repo.fail({ claim: previous, phase: "model", reason: "provider_outcome_unknown", retryable: false, now: new Date() });
    const request = () => repo.requestModelRecovery({
      workId: previous.workId, headTurnId: previous.turnIds[0]!, authorizedBy: userId, now: new Date(),
    });
    expect(await request()).toBe("queued");
    const reserved = await repo.claimNext({ now: new Date() });
    if (!reserved) throw new Error("expected a reserved review claim");
    expect(await request()).toBe("already_requested");

    const appended = await appendTranscriptMessages(threadId, userId, "owner", [new AIMessage("Synthetic resumed review evidence")], {
      agentId, roomId, humanTurnId: resumedTurnId,
      memoryReview: { ownerId: userId, actorId, accessScope: "namespace", checkpointThreadId: threadId },
    });
    expect(appended.insertedCount).toBe(1);
    await Promise.resolve(expect(repo.beginModelRecoveryDispatch(reserved)).rejects.toThrow("lease_lost"));
    await repo.fail({ claim: reserved, phase: "model", reason: "source_or_lease_changed", retryable: false, now: new Date() });
    expect(await request()).toBe("blocked");
    await db.transaction(tx => markMemoryReviewTurnInTx(tx, {
      threadId, agentId, turnId: resumedTurnId, reviewTurnId: previous.turnIds[0]!, state: "completed",
    }));
    expect(await repo.claimNext({ now: new Date() })).toBeNull();
    const [firstReservation] = await db.select().from(memoryReviewModelRecoveries)
      .where(eq(memoryReviewModelRecoveries.workId, previous.workId));
    expect(firstReservation).toMatchObject({ spentAt: null, recoveryAttemptId: reserved.attemptId });

    expect(await request()).toBe("queued");
    const renewed = await repo.claimNext({ now: new Date() });
    if (!renewed) throw new Error("expected a renewed review claim");
    expect(renewed.turnIds).toEqual(reserved.turnIds);
    expect(renewed.sourceIds).toContain(Number(appended.insertedRows[0]!.id));
    expect(renewed.attemptId).not.toBe(reserved.attemptId);
    const refreshed = { ...accepted, inputCommitment: `hmac-sha256:${"b".repeat(43)}` };
    expect(await repo.bindModelOperation(renewed, async (legacyModelId, priorBinding) => {
      expect(legacyModelId).toBeUndefined();
      expect(priorBinding).toEqual(accepted);
      return refreshed;
    })).toEqual(refreshed);
    expect(await repo.modelReplaySafety(renewed)).toBe("allow");
    await repo.load(renewed);
    await repo.beginModelRecoveryDispatch(renewed);
    await Promise.resolve(expect(repo.beginModelRecoveryDispatch(renewed)).rejects.toThrow("dispatch authorization changed"));
    expect(await request()).toBe("already_requested");
    expect(await repo.claimNext({ now: new Date(renewed.leaseUntil.getTime() + 1) })).toBeNull();
    const proposal: PreparedMemoryReview = { envelope, speakerUserId: userId, operations: [], snapshots: [] };
    expect(await repo.publish({ claim: renewed, proposal, modelId, now: new Date(), durationMs: 0 })).toBe("published");
  });

  test.each([
    ["unchanged", "none"],
    ["before claim", "edit"], ["before claim", "delete"],
    ["before claim", "edit under legacy approval"],
    ["at dispatch", "edit"], ["at dispatch", "delete"],
    ["at dispatch", "edit covered predecessor"],
    ["at dispatch", "edit with incomplete exposure"], ["at dispatch", "protected edit"],
  ] as const)("old Memory approval at the provider boundary: %s / %s", async (timing, change) => {
    // load() also includes the last covered turn in the prompt.
    const priorTurn = randomUUID();
    const priorMessage = await admit(priorTurn);
    await db.update(memoryReviewTurns).set({ state: "covered", receiptId: randomUUID() })
      .where(eq(memoryReviewTurns.turnId, priorTurn));
    const firstTurn = randomUUID();
    const secondTurn = randomUUID();
    const protectedObjectId = randomUUID();
    const messageId = await admit(firstTurn);
    await admit(secondTurn);
    const model = "fixture:memory-source-consent";
    const previous = await repo.claimNext({ now: new Date() });
    if (!previous) throw new Error("expected a failed review fixture");
    try {
      if (change === "edit with incomplete exposure") {
        // Historical reviews can omit exposure metadata for profile content.
        await db.insert(profiles).values({ agentId, userId, soulFile: "Synthetic source consent fixture" });
      }
      await repo.bindServiceModel(previous, () => model);
      await db.insert(llmUsageEvents).values({
        roomId, callType: "memory_review", model, provider: "fixture", fundingKind: "service",
        providerRoute: "surplus", endpoint: "/v1/responses", providerRequestId: randomUUID(),
        attemptOutcome: "succeeded", costState: "actual", actualCostUsd: "0.01",
        metadata: { workId: previous.workId, attemptId: previous.attemptId },
      });
      await repo.fail({ claim: previous, phase: "model", reason: "provider_outcome_unknown", retryable: false, now: new Date() });
      const request = () => repo.requestModelRecovery({
        workId: previous.workId, headTurnId: previous.turnIds[0]!, authorizedBy: userId, now: new Date(),
      });
      expect(await request()).toBe("queued");

      if (change === "edit under legacy approval") {
        // An unspent grant restored from before the source-fingerprint migration.
        await db.update(memoryReviewModelRecoveries).set({ sourceRevisionFingerprint: null })
          .where(eq(memoryReviewModelRecoveries.workId, previous.workId));
      }
      const verifyWorker = async (activeDb: NonNullable<ConstructorParameters<typeof PostgresMemoryReviewRepository>[1]>) => {
        let mutationCount = 0;
        const mutate = async () => {
          if (change === "delete") {
            await activeDb.transaction(tx => deleteMessageHardInTx(tx, messageId));
          } else if (change === "protected edit") {
            await activeDb.transaction(async tx => {
              const prior = await getEncryptionTransitionPolicy(tx);
              const shadow = await compareAndSwapEncryptionTransitionPolicy(tx, {
                expectedRevision: prior.revision, targetMode: "shadow_encryption", targetShadowBehavior: "fallback",
              });
              await tx.insert(cryptoObjects).values({ objectId: protectedObjectId, payloadHash: Buffer.alloc(32), payloadBytes: Buffer.from([1]) });
              const result = await editCanonicalTranscriptMessageInTx(tx, {
                messageId, expectedRevision: 0, content: null,
                protectedTargets: [{ messageId, sessionId, cryptoObjectId: protectedObjectId }],
                publicationPolicy: { representation: "protected_only", expectedRevision: shadow.revision },
              });
              if (result === null) throw new Error("expected a committed protected edit");
              await compareAndSwapEncryptionTransitionPolicy(tx, {
                expectedRevision: shadow.revision, targetMode: prior.mode, targetShadowBehavior: prior.shadowBehavior,
              });
            });
          } else {
            const result = await activeDb.transaction(tx => editCanonicalTranscriptMessageInTx(tx, {
              messageId: change === "edit covered predecessor" ? priorMessage : messageId,
              expectedRevision: 0, content: "Edited after operator approval", clearCryptoObjectId: true,
            }));
            if (result === null) throw new Error("expected a committed canonical edit");
          }
          mutationCount++;
        };
        if (timing === "before claim") await mutate();
        const scanned = Promise.withResolvers<void>();
        let incompleteExposure = false;
        class RecoveryRepository extends PostgresMemoryReviewRepository {
          override async claimNext(input: Parameters<PostgresMemoryReviewRepository["claimNext"]>[0]) {
            try { return await super.claimNext(input); } finally { scanned.resolve(); }
          }
          override async beginModelRecoveryDispatch(claim: MemoryReviewClaim, signal?: AbortSignal) {
            // This is after the worker's last ordinary source/lease checks.
            if (timing === "at dispatch") await mutate();
            await super.beginModelRecoveryDispatch(claim, signal);
          }
          override async load(claim: MemoryReviewClaim) {
            const input = await super.load(claim);
            incompleteExposure = input.modelExposureDependencies === undefined;
            return input;
          }
        }
        let providerCalls = 0;
        const repository = new RecoveryRepository(policy, activeDb);
        const worker = new MemoryReviewWorker({
          repository,
          checkAvailable: async () => true, resolveModelId: () => model,
          prepare: async (messages, options) => {
            await options.invokeModel!({ modelId: model, messages, tools: [] });
            return { status: "prepared", turns: 2, modelId: model,
              proposal: { envelope, speakerUserId: userId, operations: [], snapshots: [] } };
          },
          invokeModel: async (_invocation, beforeProviderDispatch) => {
            if (!beforeProviderDispatch) throw new Error("missing provider dispatch guard");
            await beforeProviderDispatch();
            providerCalls++;
            if (change !== "none") throw new Error("stale input reached the counting provider");
            return new AIMessage("Nothing to save.");
          },
        }, { scanIntervalMs: 60_000, shutdownWaitMs: 10_000 });
        worker.start();
        try { await scanned.promise; } finally { await worker.stop(); }
        const unchanged = change === "none";
        expect(mutationCount).toBe(unchanged ? 0 : 1);
        expect(providerCalls).toBe(unchanged ? 1 : 0);
        if (change === "edit with incomplete exposure") expect(incompleteExposure).toBe(true);
        const [grant] = await activeDb.select().from(memoryReviewModelRecoveries)
          .where(eq(memoryReviewModelRecoveries.workId, previous.workId));
        expect(grant).toBeDefined();
        expect(grant!.spentAt !== null).toBe(unchanged);
        expect(grant!.sourceChangedAt !== null).toBe(!unchanged);
        expect(await repository.claimNext({ now: new Date() })).toBeNull();
      };
      if (change === "protected edit") {
        // Exercise the protected writer and recovery spend on PostgreSQL. Roll
        // back their enclosing fixture so ciphertext and policy changes expire together.
        const rollback = new Error("protected fixture verified");
        try {
          await db.transaction(async tx => {
            await verifyWorker(tx);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      } else {
        await verifyWorker(getSharedDirectDb());
      }
    } finally {
      await db.delete(memoryReviewTurns).where(inArray(memoryReviewTurns.turnId, [priorTurn, firstTurn, secondTurn]));
      if (change === "edit with incomplete exposure") await db.delete(profiles).where(eq(profiles.agentId, agentId));
    }
  });

  test("two unusable results remain exactly retryable for each service provider route", async () => {
    const routes = [
      { providerRoute: "openai", provider: "openai", model: "openai:gpt-5.6-sol" },
      { providerRoute: "venice", provider: "venice", model: "venice:z-ai-glm-5-3" },
      { providerRoute: "surplus", provider: "openai", model: "openai:gpt-5.6-sol" },
    ] as const;

    for (const route of routes) {
      await admit(randomUUID());
      await admit(randomUUID());
      let claim = await repo.claimNext({ now: new Date() });
      if (!claim) throw new Error(`expected initial ${route.providerRoute} review claim`);
      await repo.bindServiceModel(claim, () => route.model);
      let oldestReceiptId = "";

      for (const [index, reason] of (["invalid_proposal", "iteration_exhausted"] as const).entries()) {
        if (index > 0) expect(await repo.modelReplaySafety(claim)).toBe("allow");
        await db.insert(llmUsageEvents).values({
          roomId, callType: "memory_review", model: route.model, provider: route.provider,
          fundingKind: "service", providerRoute: route.providerRoute, providerRequestId: randomUUID(),
          endpoint: "/v1/chat/completions", attemptOutcome: "succeeded",
          costState: route.providerRoute === "surplus" ? "actual" : "estimated",
          ...(route.providerRoute === "surplus" ? { actualCostUsd: "0.01" } : { estimatedCostUsd: "0.01" }),
          metadata: { workId: claim.workId, attemptId: claim.attemptId },
        });
        if (index === 0) oldestReceiptId = claim.attemptId;
        await repo.fail({ claim, phase: "model", reason, retryable: false, now: new Date() });
        expect(await retryFailedMemoryReviews(db)).toEqual({ requested: 1 });
        const next = await repo.claimNext({ now: new Date() });
        if (!next) throw new Error(`expected retry after ${route.providerRoute} ${reason}`);
        expect(next.workId).toBe(claim.workId);
        claim = next;
      }

      const pruneAt = new Date();
      await db.update(memoryReviewReceipts).set({
        createdAt: new Date(pruneAt.getTime() - 2 * 86_400_000),
      }).where(eq(memoryReviewReceipts.id, oldestReceiptId));
      await repo.drainEffects({ now: pruneAt });
      const retained = await db.select({ id: memoryReviewReceipts.id }).from(memoryReviewReceipts)
        .where(eq(memoryReviewReceipts.id, oldestReceiptId));
      expect(retained).toEqual([{ id: oldestReceiptId }]);

      expect(await repo.modelReplaySafety(claim)).toBe("allow");
      expect(await repo.bindServiceModel(claim, () => "changed-default")).toBe(route.model);
      await repo.load(claim);
      const proposal: PreparedMemoryReview = { envelope, speakerUserId: userId, operations: [], snapshots: [] };
      expect(await repo.publish({ claim, proposal, modelId: route.model, now: new Date(), durationMs: 0 }))
        .toBe("published");
    }
  });

  test("a newly configured service model gets one exact rejected-review recovery", async () => {
    await admit(randomUUID());
    await admit(randomUUID());
    const now = new Date();
    const originalModel = "openai:gpt-5.6-luna";
    const previouslyTriedModel = "anthropic:claude-haiku-5-5";
    const replacementModel = "openai:gpt-5.6-sol";
    const original = await repo.claimNext({ now });
    if (!original) throw new Error("expected original review claim");
    const accepted = {
      version: 1 as const, kind: "service" as const, role: "memoryReview" as const,
      modelId: originalModel, inputCommitment: `hmac-sha256:${"c".repeat(43)}`,
    };
    await repo.bindModelOperation(original, async () => accepted);
    await db.insert(llmUsageEvents).values({
      roomId, callType: "memory_review", model: originalModel, provider: "openai",
      fundingKind: "service", providerRoute: "openai", endpoint: "/v1/responses",
      attemptOutcome: "succeeded", costState: "estimated", estimatedCostUsd: "0.01",
      metadata: { workId: original.workId, attemptId: original.attemptId },
    });
    await repo.fail({ claim: original, phase: "model", reason: "invalid_proposal", retryable: false, now });

    expect(await repo.claimNext({ now, currentServiceModelId: originalModel })).toBeNull();
    await db.insert(llmUsageEvents).values({
      roomId, callType: "memory_review", model: previouslyTriedModel, provider: "anthropic",
      fundingKind: "service", providerRoute: "anthropic", endpoint: "/v1/messages",
      attemptOutcome: "failed", failureCode: "provider_refused", costState: "unknown",
      metadata: { workId: original.workId, attemptId: randomUUID() },
    });
    expect(await repo.claimNext({ now, currentServiceModelId: previouslyTriedModel })).toBeNull();

    const recovery = await repo.claimNext({ now, currentServiceModelId: replacementModel });
    if (!recovery) throw new Error("expected automatic model-change recovery");
    expect(recovery).toMatchObject({
      workId: original.workId, turnIds: original.turnIds, automaticModelRecovery: true,
    });
    expect(await repo.bindModelOperation(recovery, async () => {
      throw new Error("the recovered binding must already be frozen");
    })).toEqual({ ...accepted, modelId: replacementModel });
    expect(await repo.modelReplaySafety(recovery)).toBe("allow");
    await repo.load(recovery);
    expect(await repo.publish({
      claim: recovery,
      proposal: { envelope, speakerUserId: userId, operations: [], snapshots: [] },
      modelId: replacementModel, now: new Date(), durationMs: 0,
    })).toBe("published");
  });

  test("a proven pre-service refusal bypasses remaining backoff on config change", async () => {
    await admit(randomUUID());
    await admit(randomUUID());
    const now = new Date();
    const refusedModel = "openai:gpt-5.6-luna";
    const replacementModel = "anthropic:claude-haiku-5-5";
    const original = await repo.claimNext({ now });
    if (!original) throw new Error("expected refused review claim");
    await repo.bindServiceModel(original, () => refusedModel);
    await db.insert(llmUsageEvents).values({
      roomId, callType: "memory_review", model: refusedModel, provider: "openai",
      fundingKind: "service", providerRoute: "openai", endpoint: "/v1/responses",
      attemptOutcome: "failed", failureCode: "provider_refused", costState: "unknown",
      metadata: { workId: original.workId, attemptId: original.attemptId },
    });
    await repo.fail({ claim: original, phase: "model", reason: "provider_failed", retryable: true, now });
    const failed = await db.select({ retryAt: memoryReviewTurns.retryAt }).from(memoryReviewTurns)
      .where(eq(memoryReviewTurns.id, original.turnIds[0]!));
    expect(failed[0]?.retryAt).toEqual(new Date(now.getTime() + 15_000));
    expect(await repo.claimNext({ now, currentServiceModelId: refusedModel })).toBeNull();

    // The exact failed receipt must survive normal retention while this work
    // still depends on it as the evidence for changing models.
    await repo.drainEffects({ now: new Date(now.getTime() + 2 * 86_400_000) });
    const recovery = await repo.claimNext({ now, currentServiceModelId: replacementModel });
    if (!recovery) throw new Error("expected refused review model-change recovery");
    expect(recovery.automaticModelRecovery).toBe(true);
    expect(await repo.bindServiceModel(recovery, () => refusedModel)).toBe(replacementModel);
    await repo.load(recovery);
    expect(await repo.publish({
      claim: recovery,
      proposal: { envelope, speakerUserId: userId, operations: [], snapshots: [] },
      modelId: replacementModel, now: new Date(), durationMs: 0,
    })).toBe("published");
  });

  test.each(["unchanged model", "previously refused replacement"] as const)(
    "a proven pre-service refusal keeps ordinary scheduled retry with %s", async (configuration) => {
    await admit(randomUUID());
    await admit(randomUUID());
    const now = new Date();
    const refusedModel = "openai:gpt-5.6-luna";
    const original = await repo.claimNext({ now });
    if (!original) throw new Error("expected scheduled-refusal review claim");
    await repo.bindServiceModel(original, () => refusedModel);
    await db.insert(llmUsageEvents).values({
      roomId, callType: "memory_review", model: refusedModel, provider: "openai",
      fundingKind: "service", providerRoute: "openai", endpoint: "/v1/responses",
      attemptOutcome: "failed", failureCode: "provider_refused", costState: "unknown",
      metadata: { workId: original.workId, attemptId: original.attemptId },
    });
    await repo.fail({ claim: original, phase: "model", reason: "provider_failed", retryable: true, now });
    expect(await repo.claimNext({
      now: new Date(now.getTime() + 14_999), currentServiceModelId: refusedModel,
    })).toBeNull();

    const currentModel = configuration === "unchanged model" ? refusedModel : "venice:test-model";
    if (currentModel !== refusedModel) {
      await db.insert(llmUsageEvents).values({
        roomId, callType: "memory_review", model: currentModel, provider: "venice",
        fundingKind: "service", providerRoute: "venice", endpoint: "/v1/chat/completions",
        attemptOutcome: "failed", failureCode: "provider_refused", costState: "unknown",
        metadata: { workId: original.workId, attemptId: randomUUID() },
      });
    }
    const retry = await repo.claimNext({
      now: new Date(now.getTime() + 15_001), currentServiceModelId: currentModel,
    });
    if (!retry) throw new Error("expected same-model scheduled retry");
    expect(retry.automaticModelRecovery).toBeUndefined();
    expect(await repo.bindServiceModel(retry, () => "unexpected-model")).toBe(refusedModel);
    await repo.load(retry);
    expect(await repo.publish({
      claim: retry,
      proposal: { envelope, speakerUserId: userId, operations: [], snapshots: [] },
      modelId: refusedModel, now: new Date(), durationMs: 0,
    })).toBe("published");
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

  test("Agent guard observes disabled users and only the server can record failed review receipts", async () => {
    const trust = { userId, agentId };
    const guard = () => withSerializableAgentTrustContext(trust, (tx) => tx.execute<{ active: boolean }>(sql`SELECT app_memory_review_actor_is_active() AS active`));
    expect((await guard())[0]!.active).toBe(true);
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, userId));
    try { expect((await guard())[0]!.active).toBe(false); }
    finally { await db.update(users).set({ disabledAt: null }).where(eq(users.id, userId)); }
    const receiptInsert = withSerializableAgentTrustContext(trust, (tx) => tx.insert(memoryReviewReceipts).values({
      id: randomUUID(), workId: randomUUID(), actorId, ownerId: userId, agentId, modelId: "",
      outcome: "failed", phase: "model", code: "invalid_proposal",
      counts: { created: 0, replaced: 0, promoted: 0, demoted: 0 }, effects: [], durationMs: 0,
    }));
    const denied = await receiptInsert.catch((error: unknown) => error);
    if (!(denied instanceof Error) || !(denied.cause instanceof Error)) {
      throw new Error("expected failed-receipt authority rejection");
    }
    expect(denied.cause).toMatchObject({ code: "42501" });
    expect(denied.cause.message).toContain("row-level security");
    expect(await withSerializableAgentTrustContext(trust, (tx) => tx.execute(sql`UPDATE memory_review_receipts SET delivered=0 WHERE owner_id=${userId}::uuid`)).then(() => false, () => true)).toBe(true);
    expect(await withSerializableAgentTrustContext(trust, (tx) => tx.execute(sql`SELECT email FROM users WHERE id=${userId}::uuid`)).then(() => false, () => true)).toBe(true);
  });

});
