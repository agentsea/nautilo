import type { ProtectedTaskPendingAttentionCandidate } from "@nautilo/db";

export const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  requestor: "50000000-0000-4000-8000-000000000005",
  actor: "60000000-0000-4000-8000-000000000006",
  agent: "70000000-0000-4000-8000-000000000007",
  room: "80000000-0000-4000-8000-000000000008",
  namespace: "90000000-0000-4000-8000-000000000009",
};
export const startedAt = new Date("2026-10-09T10:00:00.000Z");
const parkedAt = new Date("2026-10-09T10:05:00.000Z");

export function candidate(
  overrides: Partial<ProtectedTaskPendingAttentionCandidate> = {},
): ProtectedTaskPendingAttentionCandidate {
  return Object.freeze({
    occurrence: Object.freeze({
      task: Object.freeze({
        id: ids.task,
        ownerId: ids.owner,
        requestorId: ids.requestor,
        agentId: ids.agent,
        callingRoomId: ids.room,
        targetRoomId: ids.room,
        scheduleKind: "one_shot" as const,
        status: "awaiting" as const,
        contentNamespaceId: ids.namespace,
        contentRevision: 7,
        contentRepresentation: "protected" as const,
        cryptoObjectId: "task-definition:v1:object",
        cryptoAccessRevision: 11,
        cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(2),
        cryptoMappingState: "verified" as const,
      }),
      run: Object.freeze({
        id: ids.run,
        taskId: ids.task,
        jobId: ids.job,
        graphThreadId: `subagent:${ids.task}:${ids.run}`,
        status: "awaiting" as const,
        startedAt,
      }),
    }),
    priorJob: Object.freeze({
      id: ids.job,
      generation: 4,
      parkedAt,
      interrupts: Object.freeze([
        Object.freeze({
          id: "interrupt:approval",
          kind: "approval" as const,
          requestId: "approval:request",
        }),
        Object.freeze({ id: "interrupt:reply", kind: "await_reply" as const }),
      ]),
      reference: Object.freeze({
        kind: "protected_task_run_v1" as const,
        taskId: ids.task,
        taskRunId: ids.run,
        inputObjectId: "task-definition:v1:object",
        resultObjectId: "task-run-result:v1:object",
        authorizationRequestId: "authorization:1",
        policyRevision: 3,
        executionSegment: 2,
      }),
    }),
    stableRoutingDigest: new Uint8Array(32).fill(1),
    pendingAttentionInterrupts: Object.freeze([
      Object.freeze({
        id: "interrupt:approval",
        kind: "approval" as const,
        requestId: "approval:request",
      }),
    ]),
    checkpointManifest: Object.freeze({
      contract: "encrypted_langgraph_v1" as const,
      expectedCheckpointCount: 3,
      checkpointOrderedDigest: new Uint8Array(32).fill(3),
      expectedBlobCount: 2,
      blobOrderedDigest: new Uint8Array(32).fill(4),
      expectedPendingWriteCount: 1,
      pendingWriteOrderedDigest: new Uint8Array(32).fill(5),
    }),
    ...overrides,
  });
}
