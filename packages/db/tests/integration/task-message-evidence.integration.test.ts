import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  agents, getSharedDirectDb, __resetSharedDirectDbForTests, eq, readTaskRunMessageMappingCounts,
  recordTaskRunMessageAssociationInTx, readProtectedTaskTranscriptManifestInTx, sessionMessages, sessions,
  sql, taskRunMessageAssociations, taskRuns, tasks, users,
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
