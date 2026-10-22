import { sql, type SQL } from "drizzle-orm";
import { QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import { actors } from "../../src/schema/trust";
import { tasks } from "../../src/schema/tasks";
import { taskRuns } from "../../src/schema/task-runs";
import { assertApprovalSelectionsAreContentFree } from "../fixtures/protected-approval-projection";
import { describe, expect, test } from "bun:test";

import type { DirectDatabase } from "../../src/config/direct-database";
import { protectedTaskRunResultObjectId } from
  "../../src/queries/protected-task-output-binding-identities";
import {
  listProtectedTaskPendingAttentionCandidates,
  readProtectedTaskPendingAttentionCandidate,
  resolveParkedProtectedTaskHumanContinuationAcceptance,
  sealProtectedTaskHumanApprovalPolicy,
} from "../../src/queries/tasks";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  requestor: "50000000-0000-4000-8000-000000000005",
  humanActor: "60000000-0000-4000-8000-000000000006",
  agent: "70000000-0000-4000-8000-000000000007",
  namespace: "80000000-0000-4000-8000-000000000008",
  room: "90000000-0000-4000-8000-000000000009",
};
const viewer = { userId: ids.requestor, humanActorId: ids.humanActor };
const graphThreadId = `subagent:${ids.task}:${ids.run}`;
const startedAt = new Date("2026-10-09T09:00:00.000Z");
const parkedAt = new Date("2026-10-09T09:05:00.000Z");
const stableRoutingDigest = new Uint8Array(32).fill(6);
const definitionObjectId = "task-definition:v1:pending-attention";

function row() {
  const reference = {
    kind: "protected_task_run_v1",
    taskId: ids.task,
    taskRunId: ids.run,
    inputObjectId: definitionObjectId,
    resultObjectId: protectedTaskRunResultObjectId(ids.task, ids.run),
    authorizationRequestId: `task-run-authorization:${ids.run}`,
    policyRevision: 4,
    executionSegment: 2,
    resumeAcceptanceId: "acceptance:previous",
  };
  const interrupts = [
    { id: "interrupt:approval", kind: "approval", requestId: "approval:1" },
    { id: "interrupt:identity", kind: "identity", requestId: "identity:1" },
    { id: "interrupt:reply", kind: "await_reply" },
  ];
  return {
    task: {
      id: ids.task,
      ownerId: ids.owner,
      requestorId: ids.requestor,
      agentId: ids.agent,
      callingRoomId: ids.room,
      scheduleKind: "one_shot",
      status: "awaiting",
      contentRepresentation: "protected",
      contentNamespaceId: ids.namespace,
      contentRevision: 3,
      cryptoObjectId: definitionObjectId,
      cryptoAccessRevision: 5,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(7),
      cryptoMappingState: "verified",
      contentPristine: true,
      targetRoomId: ids.room,
      targetUserIds: [ids.requestor],
      localExecutionDelegation: {
        version: 1,
        humanUserId: ids.requestor,
        agentId: ids.agent,
        sourceRoomId: ids.room,
        sourceConversationId: "conversation:1",
        rootTaskId: ids.task,
        target: {
          instanceId: "desktop:1",
          relayId: "relay:1",
          pairingGeneration: "generation:1",
          serverOrigin: "https://nautilo.test",
          serverFingerprint: "fingerprint:1",
        },
        projectGrantId: "project-grant:1",
        ceiling: "basic",
        profile: null,
      },
    },
    run: {
      id: ids.run,
      taskId: ids.task,
      jobId: ids.job,
      graphThreadId,
      status: "awaiting",
      startedAt,
      pristine: true,
    },
    job: {
      id: ids.job,
      ownerId: ids.requestor,
      requestorId: ids.requestor,
      laneKey: `task:${ids.task}`,
      type: "foreground",
      status: "completed",
      startedAt: new Date("2026-10-09T09:00:01.000Z"),
      completedAt: parkedAt,
      reference,
      parkReceipt: {
        version: 1,
        taskId: ids.task,
        taskRunId: ids.run,
        jobId: ids.job,
        graphThreadId,
        generation: 3,
        executionSegment: 2,
        interrupts,
        parkedAt: parkedAt.toISOString(),
        stableRoutingDigest:
          Buffer.from(stableRoutingDigest).toString("base64url"),
      },
      acceptanceReceipt: null,
      pristine: true,
    },
    segment: {
      taskRunId: ids.run,
      executionSegment: 2,
      jobId: ids.job,
      route: "native_langgraph_v1",
      transcriptContract: "protected_message_associations_v1",
      expectedTranscriptAssociationCount: 2,
      transcriptAssociationDigest: new Uint8Array(32).fill(8),
      checkpointContract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 3,
      checkpointDigest: new Uint8Array(32).fill(9),
      expectedCheckpointBlobCount: 2,
      checkpointBlobDigest: new Uint8Array(32).fill(10),
      expectedPendingWriteCount: 1,
      pendingWriteDigest: new Uint8Array(32).fill(11),
      sealedAt: parkedAt,
    },
    human: {
      humanActorId: ids.humanActor,
      userId: ids.requestor,
      kind: "user",
      disabledAt: null,
    },
  };
}

function database(rows: readonly unknown[]): Pick<DirectDatabase, "select"> {
  return {
    select: (() => {
      const query = {
        from: () => query,
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => rows,
      };
      return query;
    }) as never,
  };
}

describe("protected Task pending-attention discovery", () => {
  test("returns detached protected metadata and excludes await-reply from dialogs", async () => {
    const page = await listProtectedTaskPendingAttentionCandidates(
      database([row()]),
      { viewer, limit: 1 },
    );
    expect(page.candidates).toHaveLength(1);
    const candidate = page.candidates[0]!;
    expect(candidate).toMatchObject({
      occurrence: {
        task: {
          id: ids.task,
          requestorId: ids.requestor,
          agentId: ids.agent,
          contentNamespaceId: ids.namespace,
          cryptoMappingState: "verified",
        },
        run: { id: ids.run, graphThreadId },
      },
      priorJob: { id: ids.job, generation: 3,
        reference: { executionSegment: 2, policyRevision: 4 } },
      pendingAttentionInterrupts: [
        { id: "interrupt:approval", kind: "approval", requestId: "approval:1" },
        { id: "interrupt:identity", kind: "identity", requestId: "identity:1" },
      ],
    });
    expect(candidate.priorJob.interrupts.map(value => value.kind)).toEqual([
      "approval", "identity", "await_reply",
    ]);
    expect(candidate.checkpointManifest).toEqual({
      contract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 3,
      checkpointOrderedDigest: new Uint8Array(32).fill(9),
      expectedBlobCount: 2,
      blobOrderedDigest: new Uint8Array(32).fill(10),
      expectedPendingWriteCount: 1,
      pendingWriteOrderedDigest: new Uint8Array(32).fill(11),
    });
    expect("prompt" in candidate.occurrence.task).toBe(false);
    expect(page.nextCursor).toEqual({ startedAt, taskRunId: ids.run });
  });

  test("exact read uses Task and Run coordinates and returns one current row", async () => {
    const candidate = await readProtectedTaskPendingAttentionCandidate(
      database([row()]),
      { viewer, taskId: ids.task, taskRunId: ids.run },
    );
    expect(candidate?.occurrence.run.id).toBe(ids.run);
    expect(await readProtectedTaskPendingAttentionCandidate(
      database([row(), row()]),
      { viewer, taskId: ids.task, taskRunId: ids.run },
    )).toBeNull();
  });

  test("preserves categorical approval authority on fresh park coordinates", async () => {
    const base = row();
    const interrupts = base.job.parkReceipt.interrupts.map(interrupt =>
      interrupt.kind === "approval" ? { ...interrupt,
        allowedVerbs: ["once", "deny"] as const } : interrupt);
    const current = { ...base, job: { ...base.job, parkReceipt: {
      ...base.job.parkReceipt, interrupts,
    } } };
    const candidate = await readProtectedTaskPendingAttentionCandidate(
      database([current]),
      { viewer, taskId: ids.task, taskRunId: ids.run },
    );
    expect(candidate?.pendingAttentionInterrupts[0]).toEqual({
      id: "interrupt:approval", kind: "approval", requestId: "approval:1",
      allowedVerbs: ["once", "deny"],
    });
  });

  test("fails closed for accepted, disabled, stale, running, reparked and non-native rows", async () => {
    const base = row();
    const staleRows: unknown[] = [
      { ...base, job: { ...base.job, acceptanceReceipt: {
        acceptanceId: "acceptance:current",
      } } },
      { ...base, job: { ...base.job, acceptanceReceipt: {
        consumedByJobId: "30000000-0000-4000-8000-000000000013",
      } } },
      { ...base, human: { ...base.human, disabledAt: new Date() } },
      { ...base, task: { ...base.task, cryptoMappingState: "stale" } },
      { ...base, run: { ...base.run, status: "running" } },
      { ...base, task: { ...base.task, status: "cancelled" } },
      { ...base, run: {
        ...base.run,
        jobId: "30000000-0000-4000-8000-000000000013",
      } },
      { ...base, segment: { ...base.segment, route: "codex_acp_v1" } },
    ];
    for (const value of staleRows) {
      const page = await listProtectedTaskPendingAttentionCandidates(
        database([value]),
        { viewer, limit: 2 },
      );
      expect(page.candidates).toEqual([]);
    }
  });

  test("requires the current canonical recipient and a dialog interrupt", async () => {
    const base = row();
    const wrongRecipient = {
      ...base,
      task: { ...base.task, localExecutionDelegation: null },
    };
    expect((await listProtectedTaskPendingAttentionCandidates(
      database([wrongRecipient]),
      { viewer, limit: 2 },
    )).candidates).toEqual([]);

    const interrupts = [{ id: "interrupt:reply", kind: "await_reply" }];
    const replyOnly = {
      ...base,
      job: {
        ...base.job,
        parkReceipt: { ...base.job.parkReceipt, interrupts },
      },
    };
    expect((await listProtectedTaskPendingAttentionCandidates(
      database([replyOnly]),
      { viewer, limit: 2 },
    )).candidates).toEqual([]);
  });

  test("rejects malformed viewer, page size and cursor coordinates", async () => {
    expect(listProtectedTaskPendingAttentionCandidates(database([]), {
      viewer: { ...viewer, humanActorId: "bad" },
      limit: 1,
    })).rejects.toThrow("viewer");
    expect(listProtectedTaskPendingAttentionCandidates(database([]), {
      viewer,
      limit: 0,
    })).rejects.toThrow("limit");
    expect(listProtectedTaskPendingAttentionCandidates(database([]), {
      viewer,
      limit: 1,
      after: { startedAt: new Date(Number.NaN), taskRunId: ids.run },
    })).rejects.toThrow("cursor");
  });
});


test("approval seal and resolver compile only closed categorical projections", async () => {
  const candidate = await readProtectedTaskPendingAttentionCandidate(database([row()]), {
    viewer, taskId: ids.task, taskRunId: ids.run,
  });
  if (candidate === null) throw new Error("Expected authentic parsed test candidate");
  const statements: string[] = [];
  const tx = {
    select: (selection: Record<string, SQL>) => ({
      from: (table: PgTable) => {
        let query = new QueryBuilder().select(selection).from(table).$dynamic();
        const execute = () => {
          statements.push(query.toSQL().sql);
          if (table === actors) return [row().human];
          if (table === tasks && Object.keys(selection).join() === "id") return [{ id: ids.task }];
          if (table === taskRuns) return [{ id: ids.run }];
          return [];
        };
        const chain = {
          innerJoin: (joined: PgTable) => { query = query.innerJoin(joined, sql`true`); return chain; },
          where: () => chain,
          limit: () => chain,
          for: async () => execute(),
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(execute()).then(resolve),
        };
        return chain;
      },
    }),
  };
  const db = { ...tx, transaction: async <T>(use: (transaction: typeof tx) => Promise<T>) => use(tx) } as unknown as DirectDatabase;
  expect(await sealProtectedTaskHumanApprovalPolicy(db, { viewer, candidate,
    policies: [{ interruptId: "interrupt:approval", requestId: "approval:1", allowedVerbs: ["once", "deny"] }],
  })).toEqual({ status: "rejected", reason: "not_found" });
  expect(await resolveParkedProtectedTaskHumanContinuationAcceptance(db, {
    taskId: ids.task, graphThreadId, acceptedBy: viewer,
    interrupt: { kind: "approval", requestId: "approval:1" },
  })).toEqual({ status: "no_match" });
  assertApprovalSelectionsAreContentFree(statements);
  const joined = statements.find(statement => statement.includes('inner join "jobs"'));
  expect(joined).toContain('jsonb_typeof("jobs"."input")');
  expect(joined).toContain('jsonb_build_object(');
});
