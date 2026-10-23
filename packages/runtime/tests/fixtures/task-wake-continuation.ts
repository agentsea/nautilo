import {
  jobs, tasks, taskRuns, protectedTaskRunOutputBindings, protectedTaskWakeContinuationReceipts,
  protectedTaskRunWakeJobId, protectedTaskRunWakeOperationId, protectedTaskRunOutputBindingId,
  protectedTaskSemanticAuthorityRequirementsDigest, withCurrentProtectedTaskWakeContinuation,
  type ProtectedTaskWakeContinuationReceipt, type VerifiedProtectedTaskWakeContinuation,
} from "@nautilo/db";
import type { BackgroundAuthorizationTaskRuntimeRecordV3 } from "../../src/protected-execution/background-authorization/repository";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "10000000-0000-4000-8000-000000000002";
const ROOM = "10000000-0000-4000-8000-000000000003";
export const WAKE_DESTINATION = "f0000000-0000-4000-8000-000000000001";
export function canonicalWakeRecord(record: BackgroundAuthorizationTaskRuntimeRecordV3): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const namespaces = record.authoritySet.namespaceRequirements.map((n, i) => ({ ...n,
    namespaceId: `a0000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` }));
  const primaryIndex = record.authoritySet.namespaceRequirements.findIndex(n => n.namespaceId === record.snapshot.namespaceId);
  const workId = protectedTaskRunWakeJobId(RUN);
  return { ...record, snapshot: { ...record.snapshot, namespaceId: namespaces[primaryIndex]!.namespaceId,
    workId, requestId: `task-wake-authorization:${workId}` },
  authoritySet: { ...record.authoritySet, namespaceRequirements: namespaces } };
}
export function wakeReceipt(record: BackgroundAuthorizationTaskRuntimeRecordV3,
  destinationNamespaceId = WAKE_DESTINATION): ProtectedTaskWakeContinuationReceipt {
  const retainedSourceNamespaceIds = record.authoritySet.namespaceRequirements
    .filter(n => n.operations.join(",") === "decrypt,encrypt").map(n => n.namespaceId);
  const semanticAuthorityRequirements = [
    ...retainedSourceNamespaceIds.map(namespaceId => ({ namespaceId, operations: ["decrypt"] as const })),
    { namespaceId: destinationNamespaceId, operations: ["encrypt"] as const },
  ];
  return { wakeJobId: record.snapshot.workId, segment: record.snapshot.recipientGeneration + 1,
    taskId: TASK, taskRunId: RUN, bindingId: protectedTaskRunOutputBindingId(RUN),
    wakeOperationId: protectedTaskRunWakeOperationId(RUN), priorRecipientGeneration: record.snapshot.recipientGeneration,
    wakeAuthorizationRequestId: record.snapshot.requestId, additionalAuthorizationRequestId: "task.memory.projection:test",
    interruptId: "interrupt:test", operationId: "operation:test", requestDigest: new Uint8Array(32).fill(1),
    requiredAuthorityDigest: protectedTaskSemanticAuthorityRequirementsDigest(semanticAuthorityRequirements),
    semanticAuthorityRequirements, retainedSourceNamespaceIds, sourceEnvelopeDigest: new Uint8Array(32).fill(3),
    initialPolicyRevision: record.expectedPolicyRevision, initialAgentAuthorizationRevision: 1,
    destinationRoomId: ROOM, destinationNamespaceId, destinationAuthorityDigest: new Uint8Array(32).fill(4),
    checkpointThreadId: `protected-task-wake:${record.snapshot.workId}`, checkpointContract: "encrypted_langgraph_v1",
    expectedCheckpointCount: 1, checkpointOrderedDigest: new Uint8Array(32).fill(5),
    expectedBlobCount: 0, blobOrderedDigest: new Uint8Array(32).fill(6),
    expectedPendingWriteCount: 0, pendingWriteOrderedDigest: new Uint8Array(32).fill(7), sealedAt: new Date(1_800_000_000_000) };
}

/** Real callback-scoped DB proof owner over closed canonical product rows; no proof branding seam. */
export async function withWakeProof<Value>(receipt: ProtectedTaskWakeContinuationReceipt,
  use: (proof: VerifiedProtectedTaskWakeContinuation) => Promise<Value> | Value,
  priorReceipt: ProtectedTaskWakeContinuationReceipt | null = null): Promise<Value> {
  const source = "a0000000-0000-4000-8000-000000000001";
  const resultObjectId = "task-run-result:v1:" + "b".repeat(64);
  const rows = new Map<unknown, unknown[]>([
    [tasks, [{ id: TASK, ownerId: "owner", requestorId: "owner", contentRepresentation: "protected",
      cryptoMappingState: "verified", contentRevision: 1, cryptoObjectId: "definition", contentNamespaceId: source }]],
    [taskRuns, [{ id: RUN, taskId: TASK, status: "completed", completedAt: receipt.sealedAt,
      resultRepresentation: "protected", resultCryptoMappingState: "verified", resultRevision: 1,
      resultCryptoObjectId: resultObjectId, resultContentNamespaceId: source }]],
    [protectedTaskRunOutputBindings, [{ taskRunId: RUN, bindingId: receipt.bindingId, wakeOperationId: receipt.wakeOperationId,
      wakeJobId: receipt.wakeJobId, wakeScheduledAt: receipt.sealedAt, completedAt: receipt.sealedAt,
      destinationRoomId: ROOM, destinationNamespaceId: source, resultObjectId }]],
    [jobs, [{ id: receipt.wakeJobId, ownerId: "owner", requestorId: "owner", roomId: ROOM, laneKey: `room:${ROOM}`,
      type: "foreground", status: "queued", startedAt: null, completedAt: null, result: null, message: null, metadata: {},
      input: { kind: "protected_task_delivery_v1", taskId: TASK, taskRunId: RUN, bindingId: receipt.bindingId,
        resultObjectId, wakeOperationId: receipt.wakeOperationId } }]],
  ]);
  let receiptQueries = 0;
  const tx = { select() { return { from(table: unknown) {
    let rowLimit: number | undefined;
    const priorQuery = table === protectedTaskWakeContinuationReceipts && ++receiptQueries % 3 === 0;
    const query = { where() { return query; }, orderBy() { return query; },
      limit(value: number) { rowLimit = value; return query; }, for() { return query; },
      then(resolve: (value: unknown[]) => unknown) {
        const values = table === protectedTaskWakeContinuationReceipts
          ? priorQuery ? priorReceipt === null ? [] : [priorReceipt] : [receipt] : rows.get(table) ?? [];
        return Promise.resolve(resolve(rowLimit === undefined ? values : values.slice(0, rowLimit)));
      } };
    return query;
  } }; } } as unknown as Parameters<typeof withCurrentProtectedTaskWakeContinuation>[0];
  const result = await withCurrentProtectedTaskWakeContinuation(tx, { wakeJobId: receipt.wakeJobId,
    segment: receipt.segment, wakeAuthorizationRequestId: receipt.wakeAuthorizationRequestId,
    priorRecipientGeneration: receipt.priorRecipientGeneration, jobState: "queued" }, async proof => ({ value: await use(proof) }));
  if (result === null) throw new Error("Canonical wake proof fixture was rejected");
  return result.value;
}
