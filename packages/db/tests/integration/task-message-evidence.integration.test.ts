import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  actors, agents, and, createDirectDb, cryptoObjects, getSharedDirectDb,
  __resetSharedDirectDbForTests, eq, namespaces, readTaskRunMessageMappingCounts,
  recordTaskRunMessageAssociationInTx, readProtectedTaskTranscriptManifestInTx,
  roomMembers, rooms, sessionMessages, sessions, sql,
  taskDefinitionCryptoRevisions, taskRunMessageAssociations, taskRuns, tasks,
  users,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof getSharedDirectDb>;
beforeAll(() => {
  bootstrapTestDbInstance();
  db = getSharedDirectDb();
});
afterAll(async () => { await __resetSharedDirectDbForTests(); });

test("Task Message evidence survives Message deletion and cannot be rewritten by product roles", async () => {
  const rollback = new Error("rollback isolated evidence fixture");
  try {
    await db.transaction(async tx => {
      const identity = await tx.execute(sql`SELECT current_user::text AS role`);
      expect(identity[0]?.["role"]).toBe("nautilo");
      const [owner] = await tx.insert(users).values({
        name: "Task evidence fixture", email: `task-evidence-${randomUUID()}@test.local`,
      }).returning();
      const [agent] = await tx.insert(agents).values({ handle: `task-evidence-${randomUUID()}` }).returning();
      const [task] = await tx.insert(tasks).values({
        ownerId: owner!.id, requestorId: owner!.id, agentId: agent!.id,
        prompt: "ordinary fixture; no cryptographic validity claimed", status: "paused",
      }).returning();
      const thread = `task-evidence:${randomUUID()}`;
      const [run] = await tx.insert(taskRuns).values({
        taskId: task!.id, graphThreadId: thread, status: "paused",
      }).returning();
      const [session] = await tx.insert(sessions).values({
        ownerId: owner!.id, agentId: agent!.id, threadId: thread,
      }).returning();
      const [message] = await tx.insert(sessionMessages).values({
        sessionId: session!.id, role: "assistant", content: "fixture body",
      }).returning();
      const input = {
        taskId: task!.id, taskRunId: run!.id, sessionId: session!.id,
        expectedThreadId: thread, messageId: message!.id,
        publishedRevision: 0, kind: "transcript" as const,
        publicationKey: `task-transcript:${run!.id}:fixture`,
      };
      expect(await recordTaskRunMessageAssociationInTx(tx, input)).toMatchObject({ status: "recorded" });
      expect(await recordTaskRunMessageAssociationInTx(tx, input)).toMatchObject({ status: "exact_replay" });
      expect(await recordTaskRunMessageAssociationInTx(tx, { ...input, publicationKey: "substitution" }))
        .toEqual({ status: "rejected", reason: "conflict" });
      expect(await readTaskRunMessageMappingCounts(tx, run!.id)).toEqual([{
        kind: "transcript", associatedCount: 1, presentMessageCount: 1,
        verifiedMappedCount: 0, verifiedShadowMappedCount: 0, verifiedFullMappedCount: 0,
        pendingOrStaleCount: 1, missingMessageCount: 0,
      }]);
      const manifestIdentity = {
        taskId: task!.id, taskRunId: run!.id, graphThreadId: thread,
      };
      const beforeDeletion = await readProtectedTaskTranscriptManifestInTx(
        tx, manifestIdentity,
      );
      expect(beforeDeletion.contract).toBe("protected_message_associations_v1");
      expect(beforeDeletion.expectedAssociationCount).toBe(1);
      expect(beforeDeletion.orderedDigest?.length).toBe(32);
      await tx.delete(sessionMessages).where(eq(sessionMessages.id, message!.id));
      expect(await readProtectedTaskTranscriptManifestInTx(tx, manifestIdentity))
        .toEqual(beforeDeletion);
      expect(await readTaskRunMessageMappingCounts(tx, run!.id)).toMatchObject([{
        associatedCount: 1, presentMessageCount: 0, missingMessageCount: 1,
      }]);
      const rows = await tx.execute(sql`SELECT
        has_table_privilege('nautilo', 'task_run_message_associations', 'SELECT') AS product_read,
        has_table_privilege('nautilo', 'task_run_message_associations', 'INSERT') AS product_insert,
        has_table_privilege('nautilo', 'task_run_message_associations', 'UPDATE') AS product_update,
        has_table_privilege('nautilo', 'task_run_message_associations', 'DELETE') AS product_delete,
        has_table_privilege('nautilo_agent', 'task_run_message_associations', 'SELECT') AS agent_read,
        has_table_privilege('nautilo_crypto', 'task_run_message_associations', 'SELECT') AS crypto_read`);
      expect(rows[0]).toMatchObject({
        product_read: true, product_insert: true, product_update: false,
        product_delete: true, agent_read: false, crypto_read: false,
      });
      for (const [statement, expectedCode] of [
        [
          sql`UPDATE task_run_message_associations SET publication_key = 'rewritten' WHERE task_run_id = ${run!.id}`,
          "42501",
        ],
        [
          sql`DELETE FROM task_run_message_associations WHERE task_run_id = ${run!.id}`,
          "23514",
        ],
      ] as const) {
        let deniedCode: unknown;
        try {
          await tx.transaction(async savepoint => { await savepoint.execute(statement); });
        } catch (error) {
          deniedCode = (error as { cause?: { code?: unknown } }).cause?.code;
        }
        expect(deniedCode).toBe(expectedCode);
      }
      await tx.delete(tasks).where(eq(tasks.id, task!.id));
      expect(await tx.select().from(taskRunMessageAssociations).where(eq(
        taskRunMessageAssociations.taskRunId,
        run!.id,
      ))).toEqual([]);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
});

test("hidden protected Task transcripts bind the canonical requester-private audience", async () => {
  const admin = createDirectDb(1);
  const rollback = new Error("rollback hidden Task transcript fixture");
  try {
    await admin.transaction(async tx => {
      const token = randomUUID();
      const [owner] = await tx.insert(users).values({
        name: "Hidden Task transcript fixture",
        email: `hidden-task-transcript-${token}@test.local`,
      }).returning();
      const [agent] = await tx.insert(agents).values({
        handle: `hidden-task-transcript-${token}`,
      }).returning();
      if (!owner || !agent) throw new Error("Missing transcript fixture identity");
      const [humanActor] = await tx.insert(actors).values({
        ownerId: owner.id,
        displayName: "Hidden Task transcript requester",
        kind: "user",
      }).returning();
      const [agentActor] = await tx.insert(actors).values({
        ownerId: owner.id,
        displayName: "Hidden Task transcript Agent",
        kind: "agent",
        agentId: agent.id,
      }).returning();
      const [contentNamespace, executionNamespace, wrongNamespace] = await tx.insert(namespaces)
        .values([{ scope: "private", label: `hidden-content-${token}` }, {
          scope: "private",
          label: `hidden-execution-${token}`,
        }, {
          scope: "private",
          label: `hidden-wrong-${token}`,
        }]).returning();
      if (!humanActor || !agentActor || !contentNamespace
        || !executionNamespace || !wrongNamespace) {
        throw new Error("Missing transcript fixture trust rows");
      }
      const threadId = `hidden-task-transcript:${token}`;
      const [executionRoom] = await tx.insert(rooms).values({
        ownerId: owner.id,
        type: "private",
        kind: "task",
        label: "Hidden Task execution",
        graphThreadId: `hidden-task-execution:${token}`,
        namespaceId: executionNamespace.id,
        humanActorIds: [],
      }).returning();
      const [sourceRoom] = await tx.insert(rooms).values({
        ownerId: owner.id,
        type: "private",
        kind: "private",
        label: "Hidden Task transcript source",
        graphThreadId: `hidden-task-source:${token}`,
        namespaceId: contentNamespace.id,
        humanActorIds: [humanActor.id],
      }).returning();
      const [wrongSourceRoom] = await tx.insert(rooms).values({
        ownerId: owner.id,
        type: "private",
        kind: "private",
        label: "Hidden Task wrong transcript source",
        graphThreadId: `hidden-task-wrong-source:${token}`,
        namespaceId: wrongNamespace.id,
        humanActorIds: [humanActor.id],
      }).returning();
      if (!executionRoom || !sourceRoom || !wrongSourceRoom) {
        throw new Error("Missing transcript fixture Rooms");
      }
      await tx.insert(roomMembers).values([{ roomId: sourceRoom.id, actorId: humanActor.id }, {
        roomId: sourceRoom.id,
        actorId: agentActor.id,
      }, {
        roomId: wrongSourceRoom.id,
        actorId: humanActor.id,
      }, {
        roomId: wrongSourceRoom.id,
        actorId: agentActor.id,
      }]);
      const [task] = await tx.insert(tasks).values({
        ownerId: owner.id,
        requestorId: owner.id,
        agentId: agent.id,
        targetRoomId: executionRoom.id,
        prompt: "",
        status: "running",
      }).returning();
      if (!task) throw new Error("Missing transcript fixture Task");
      const objectId = `task-definition:v1:${token.replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
      const fingerprint = new Uint8Array(32).fill(0x71);
      await tx.insert(cryptoObjects).values({
        objectId,
        payloadHash: new Uint8Array(32).fill(0x72),
        payloadBytes: new Uint8Array([1]),
      });
      await tx.insert(taskDefinitionCryptoRevisions).values({
        taskId: task.id,
        contentNamespaceId: contentNamespace.id,
        contentRevision: 1,
        operationId: `hidden-task-transcript:${task.id}`,
        requestDigest: new Uint8Array(32).fill(0x73),
        authorityFingerprint: new Uint8Array(32).fill(0x74),
        requesterHumanId: humanActor.id,
        anchorNamespaceId: contentNamespace.id,
        cryptoObjectId: objectId,
        representation: "protected",
        requiredNamespaceFingerprint: fingerprint,
        completion: "complete",
        disposition: "mapped",
        nextAttemptAt: null,
        cryptoCompletedAt: new Date(),
      });
      await tx.update(tasks).set({
        contentRepresentation: "protected",
        contentNamespaceId: contentNamespace.id,
        contentRevision: 1,
        cryptoObjectId: objectId,
        cryptoRequiredNamespaceFingerprint: fingerprint,
        cryptoMappingState: "verified",
      }).where(eq(tasks.id, task.id));
      const [run] = await tx.insert(taskRuns).values({
        taskId: task.id,
        graphThreadId: threadId,
        status: "running",
      }).returning();
      const [session] = await tx.insert(sessions).values({
        ownerId: owner.id,
        agentId: agent.id,
        threadId,
        roomId: sourceRoom.id,
      }).returning();
      if (!run || !session) throw new Error("Missing transcript fixture execution");
      const messages = await tx.insert(sessionMessages).values([41, 42, 43].map(index => ({
        sessionId: session.id,
        role: "assistant" as const,
        content: `structural transcript fixture ${index}`,
      }))).returning();
      if (messages.length !== 3) throw new Error("Missing transcript fixture Messages");
      const association = (index: number) => ({
        taskId: task.id,
        taskRunId: run.id,
        sessionId: session.id,
        expectedThreadId: threadId,
        messageId: messages[index]!.id,
        publishedRevision: 0,
        kind: "transcript" as const,
        publicationKey: `task-transcript:${run.id}:fixture:${index}`,
      });
      expect(await recordTaskRunMessageAssociationInTx(tx, association(0)))
        .toMatchObject({ status: "recorded" });

      for (const [index, mutate] of [
        [1, async (savepoint: typeof tx) => {
          await savepoint.delete(roomMembers).where(and(
            eq(roomMembers.roomId, sourceRoom.id),
            eq(roomMembers.actorId, agentActor.id),
          ));
        }],
        [2, async (savepoint: typeof tx) => {
          await savepoint.update(sessions).set({ roomId: wrongSourceRoom.id })
            .where(eq(sessions.id, session.id));
        }],
      ] as const) {
        const rejectRollback = new Error("rollback rejected audience mutation");
        try {
          await tx.transaction(async savepoint => {
            await mutate(savepoint);
            expect(await recordTaskRunMessageAssociationInTx(
              savepoint,
              association(index),
            )).toEqual({ status: "rejected", reason: "not_found" });
            throw rejectRollback;
          });
        } catch (error) {
          if (error !== rejectRollback) throw error;
        }
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await admin.end();
  }
});
