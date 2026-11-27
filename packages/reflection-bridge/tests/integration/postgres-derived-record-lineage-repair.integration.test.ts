import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  actors, agents, createDirectDb, createPostgresJsCanonicalBridgeConnection, eq, inArray,
  namespaces, reflectionRecordDependencies, reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations, reflectionRecordPublications, reflectionRecords,
  reflectionRecordSemanticWork, roomEvents, roomJournalBatches,
  roomJournalState, roomMembers, rooms, sessionMessages, sessions, sql, users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import { verifyRecordProductPostgresHandle } from "../../src/server";
import { repairBlockedDerivedRecordLineage }
  from "../../src/server/postgres-derived-record-lineage-repair";
import { encodeDurableRecordEnvelope } from "../../src/server/record-mapping";

type Db = ReturnType<typeof createDirectDb>;
let db: Db;
const BASE = new Date("1971-02-03T04:05:06.000Z");

beforeAll(() => { bootstrapTestDbInstance(); db = createDirectDb(4); });
afterAll(async () => { await db?.end(); });

function fingerprint(id: number, revision: number, content: string) {
  return `sha256:${createHash("sha256").update(JSON.stringify([
    "nautilo/stenographer/message-observation/v1", id, revision, content,
  ]), "utf8").digest("hex")}`;
}

function envelope(input: Readonly<{
  recordRef: string; children: readonly string[]; height: number;
  roomId: string; namespaceId: string;
  message?: Readonly<{id: number; revision: number; content: string}>;
}>): DurableRecordEnvelope {
  const source = input.message === undefined ? [] : [{
    sourceKind: "message", logicalSourceRef: `message:${input.message.id}`,
    observedRevision: String(input.message.revision),
    observedContentFingerprint: fingerprint(
      input.message.id,
      input.message.revision,
      input.message.content,
    ),
    terminalAuthorityLeafHandle: input.namespaceId, authorityBearing: true,
  }];
  return {
    recordRef: input.recordRef, lifecycle: "current", structuralHeight: input.height,
    processingGeneration: 1,
    semantic: {
      observedContentFingerprint: `fixture:${input.recordRef}`, posture: "derived",
      statement: "Source-backed derived Record repair fixture.", sourceDependencies: source,
      anchors: [{kind: "room", anchorRef: input.roomId, role: "origin"}],
      childRecordRefs: input.children,
      producer: {producerRef: input.height === 0 ? "stenographer" : "organizer",
        policyVersion: input.height === 0 ? "derived-repair-source-v1" : "candidate-policy-v1"},
      terminalAuthorityLeafHandles: [input.namespaceId],
      modelExposureDependencies: source.map(item => ({
          kind: "source" as const, sourceKind: item.sourceKind,
          logicalSourceRef: item.logicalSourceRef, observedRevision: item.observedRevision,
          observedContentFingerprint: item.observedContentFingerprint,
          terminalAuthorityLeafHandle: item.terminalAuthorityLeafHandle,
        })),
    },
  };
}

test("re-arms exact deterministic work while fencing protected, pending, bound, and newer rows", async () => {
  const suffix = randomUUID();
  const rollback = new Error("rollback derived Record repair fixture");
  let ownerId = "";
  try {
    await createPostgresJsCanonicalBridgeConnection(db).transaction(async (tx, executor) => {
      const [owner] = await tx.insert(users).values({name: "Derived repair operator",
        email: `derived-repair-${suffix}@integration.test`}).returning({id: users.id});
      ownerId = owner!.id;
      const [human] = await tx.insert(actors).values({ownerId, displayName: "Repair Human",
        kind: "user"}).returning({id: actors.id});
      const [agent] = await tx.insert(agents).values({handle: `derived-repair-${suffix}`})
        .returning({id: agents.id});
      const [agentActor] = await tx.insert(actors).values({ownerId, displayName: "Repair Agent",
        kind: "agent", agentId: agent!.id}).returning({id: actors.id});
      const [namespace] = await tx.insert(namespaces).values({scope: "private",
        label: `derived-repair-${suffix}`}).returning({id: namespaces.id});
      const roomId = randomUUID();
      await tx.insert(rooms).values({id: roomId, ownerId, type: "private", label: "Repair",
        graphThreadId: `derived-repair:${suffix}`, namespaceId: namespace!.id,
        humanActorIds: [human!.id], createdBy: human!.id});
      await tx.insert(roomMembers).values([
        {roomId, actorId: human!.id, roomRole: "admin", joinedAt: BASE},
        {roomId, actorId: agentActor!.id, roomRole: "member", joinedAt: BASE},
      ]);
      const [session] = await tx.insert(sessions).values({threadId: `derived-repair:${suffix}`,
        ownerId, personaId: "owner", agentId: agent!.id, roomId, channel: "electron"})
        .returning({id: sessions.id});
      const content = "The original native message remains unchanged.";
      const [message] = await tx.insert(sessionMessages).values({sessionId: session!.id,
        role: "user", content, fingerprint: `derived-repair:${suffix}`, createdAt: BASE})
        .returning({id: sessionMessages.id, revision: sessionMessages.editRevision});
      await tx.insert(roomJournalState).values({roomId, extractorVersion: "derived-repair-v1",
        historicalBackfillStatus: "not_needed", createdAt: BASE, updatedAt: BASE});
      const [batch] = await tx.insert(roomJournalBatches).values({roomId,
        fromMessageIdExclusive: 0, throughMessageIdInclusive: message!.id,
        extractorVersion: "derived-repair-v1", observationPublicationVersion: 2,
        status: "completed", attemptCount: 1, operationCount: 1, completedAt: BASE,
        createdAt: BASE}).returning({id: roomJournalBatches.id});

      const ids = {source: randomUUID(), good: `derived-good-${suffix}`,
        pending: `derived-pending-${suffix}`,
        protected: `derived-protected-${suffix}`, bound: `derived-bound-${suffix}`,
        newer: `derived-newer-${suffix}`};
      const source = {id: message!.id, revision: message!.revision, content};
      const records = [
        envelope({recordRef: ids.source, children: [], height: 0, roomId,
          namespaceId: namespace!.id, message: source}),
        envelope({recordRef: ids.good, children: [ids.source],
          height: 2, roomId, namespaceId: namespace!.id}),
        envelope({recordRef: ids.pending, children: [ids.source], height: 1, roomId,
          namespaceId: namespace!.id}),
        envelope({recordRef: ids.protected, children: [ids.source], height: 1, roomId,
          namespaceId: namespace!.id}),
        envelope({recordRef: ids.bound, children: [ids.source], height: 1, roomId,
          namespaceId: namespace!.id}),
        envelope({recordRef: ids.newer, children: [ids.source], height: 1, roomId,
          namespaceId: namespace!.id}),
      ];
      await tx.insert(reflectionRecords).values(records.map(record => ({recordId: record.recordRef,
        lifecycle: "current" as const,
        structuralHeight: record.structuralHeight,
        producerPolicyVersion: record.semantic.producer.policyVersion,
        processingGeneration: 1,
        createdAt: BASE, updatedAt: BASE})));
      await tx.insert(reflectionRecordPayloadRepresentations).values(records.map(record => ({
        recordId: record.recordRef, representation: "ordinary" as const,
        representationGeneration: 1, plaintextPayloadBytes: encodeDurableRecordEnvelope(record),
        createdAt: BASE})));
      await tx.insert(reflectionRecordPayloadRepresentationHeads).values(records.map(record => ({
        recordId: record.recordRef, representation: "ordinary" as const,
        currentRepresentationGeneration: 1, updatedAt: BASE})));
      await tx.insert(reflectionRecordPayloadRepresentations).values({recordId: ids.protected,
        representation: "protected", representationGeneration: 1,
        cryptoObjectId: `derived-repair-protected:${suffix}`, createdAt: BASE});
      await tx.insert(reflectionRecordPayloadRepresentationHeads).values({recordId: ids.protected,
        representation: "protected", currentRepresentationGeneration: 1, updatedAt: BASE});
      await tx.insert(reflectionRecordPublications).values(records.map((record, index) => ({
        publicationId: `derived-repair:${suffix}:${index}`, recordId: record.recordRef,
        representation: "ordinary" as const, representationGeneration: 1,
        requestCommitment: new Uint8Array(32).fill(index + 1),
        publicationBindingRef: `derived-repair-binding:${suffix}:${index}`,
        state: "complete" as const, productAttachedAt: BASE, completedAt: BASE,
        createdAt: BASE, updatedAt: BASE})));
      await tx.insert(reflectionRecordPublications).values({
        publicationId: `derived-repair-pending:${suffix}`, recordId: ids.pending,
        representation: "protected", representationGeneration: 1,
        requestCommitment: new Uint8Array(32).fill(29),
        publicationBindingRef: `derived-repair-pending-binding:${suffix}`,
        reservedCryptoObjectId: `derived-repair-pending-object:${suffix}`,
        state: "reserved", createdAt: BASE, updatedAt: BASE,
      });
      await tx.insert(reflectionRecordDependencies).values([
        {parentRecordId: ids.good, childRecordId: ids.source},
        {parentRecordId: ids.pending, childRecordId: ids.source},
        {parentRecordId: ids.protected, childRecordId: ids.source},
        {parentRecordId: ids.bound, childRecordId: ids.source},
        {parentRecordId: ids.newer, childRecordId: ids.source},
      ]);
      const completeWork = (recordId: string) => ({recordId, generation: 1,
        completedGeneration: 1, changeReason: "created" as const,
        stage: "organization" as const, state: "complete" as const,
        completionOutcome: "completed" as const, dueSince: BASE, startedAt: BASE,
        completedAt: BASE, createdAt: BASE, updatedAt: BASE});
      const quarantinedWork = (recordId: string, overrides: Record<string, unknown> = {}) => ({
        recordId, generation: 8, changeReason: "dependency_lost" as const,
        stage: "organization" as const, state: "quarantined" as const,
        attemptCount: 8, quarantineRound: 8, recoverAfter: BASE,
        failureCode: "candidate_unavailable" as const,
        failureDetail: "candidate_selection_invalid" as const, dueSince: BASE,
        startedAt: BASE, createdAt: BASE, updatedAt: BASE, ...overrides,
      });
      await tx.insert(reflectionRecordSemanticWork).values([
        completeWork(ids.source), quarantinedWork(ids.good), quarantinedWork(ids.pending),
        quarantinedWork(ids.protected),
        quarantinedWork(ids.bound, {
          acceptedModelBinding: {version: 1, kind: "human", role: "memoryReflection",
            modelId: "openai:human", inputCommitment: `hmac-sha256:${"P".repeat(43)}`,
            humanUserId: ownerId, preferenceRevision: 1,
            funding: {kind: "personal", providerRoute: "openai",
              credentialId: randomUUID(), credentialRevision: 1}},
          acceptedModelBindingGeneration: 8,
        }),
        quarantinedWork(ids.newer, {updatedAt: new Date(BASE.getTime() + 90_000)}),
      ]);
      await tx.execute(sql`SELECT set_config('nautilo.stenographer_writer_version', '2', true)`);
      await tx.insert(roomEvents).values({id: ids.source, roomId, sequence: 1, kind: "fact",
        statement: null, status: "active", sourceMessageIds: [message!.id],
        sourceBatchId: batch!.id, batchLocalOrdinal: 0, extractorVersion: "derived-repair-v1",
        projectionKind: "native", recordId: ids.source, nativeAttachedAt: BASE, createdAt: BASE});

      const handle = await verifyRecordProductPostgresHandle({query: executor.query.bind(executor),
        transaction: use => use(executor)});
      const now = new Date(BASE.getTime() + 120_000);
      const observedThrough = new Date(BASE.getTime() + 60_000);
      const run = () => repairBlockedDerivedRecordLineage({handle,
        now, observedThrough, authorizedBy: ownerId});
      expect(await run()).toEqual({requeued: 1});
      const stored = await tx.select({id: reflectionRecords.recordId,
        lifecycle: reflectionRecords.lifecycle, generation: reflectionRecords.processingGeneration})
        .from(reflectionRecords).where(inArray(reflectionRecords.recordId, [
          ids.source, ids.good, ids.pending,
        ]));
      expect(new Map(stored.map(row => [row.id, row]))).toMatchObject(new Map([
        [ids.source, {lifecycle: "current", generation: 1}],
        [ids.good, {lifecycle: "current", generation: 1}],
        [ids.pending, {lifecycle: "current", generation: 1}],
      ]));
      const [good] = await tx.select().from(reflectionRecordSemanticWork)
        .where(eq(reflectionRecordSemanticWork.recordId, ids.good));
      expect(good).toMatchObject({generation: 8, state: "quarantined", recoverAfter: now,
        updatedAt: now});
      const [pending] = await tx.select().from(reflectionRecordSemanticWork)
        .where(eq(reflectionRecordSemanticWork.recordId, ids.pending));
      expect(pending).toMatchObject({generation: 8, state: "quarantined", recoverAfter: BASE,
        updatedAt: BASE});
      expect(await tx.select().from(roomEvents).where(eq(roomEvents.id, ids.source))).toHaveLength(1);
      expect(await tx.select().from(sessionMessages).where(eq(sessionMessages.id, message!.id))).toHaveLength(1);
      for (const recordId of [ids.pending, ids.protected, ids.bound]) {
        const [guarded] = await tx.select().from(reflectionRecordSemanticWork)
          .where(eq(reflectionRecordSemanticWork.recordId, recordId));
        expect(guarded).toMatchObject({generation: 8, state: "quarantined",
          recoverAfter: BASE, updatedAt: BASE});
      }
      const [newer] = await tx.select().from(reflectionRecordSemanticWork)
        .where(eq(reflectionRecordSemanticWork.recordId, ids.newer));
      expect(newer).toMatchObject({generation: 8, state: "quarantined",
        recoverAfter: BASE, updatedAt: new Date(BASE.getTime() + 90_000)});
      expect(await run()).toEqual({requeued: 0});
      throw rollback;
    }, {isolationLevel: "read committed"});
  } catch (error) {
    if (error !== rollback) throw error;
  }
  expect(await db.select().from(users).where(eq(users.id, ownerId))).toHaveLength(0);
});
