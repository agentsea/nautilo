import { describe, expect, test } from "bun:test";

import {
  listProtectedTaskActivationParkedIntegrityCandidates,
  PROTECTED_TASK_ACTIVATION_PARKED_PAGE_LIMIT,
} from "../../src/queries/protected-task-activation-parked-integrity";
import { protectedTaskSemanticAuthorityRequirementsDigest } from
  "../../src/queries/protected-task-execution-receipts";
import { protectedTaskRunWakeJobId } from
  "../../src/queries/protected-task-output-binding-identities";

const ids = {
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  job: "30000000-0000-4000-8000-000000000003",
  user: "40000000-0000-4000-8000-000000000004",
  namespace: "50000000-0000-4000-8000-000000000005",
  room: "60000000-0000-4000-8000-000000000006",
  foreground: "70000000-0000-4000-8000-000000000007",
  destinationRoom: "80000000-0000-4000-8000-000000000008",
  destination: "90000000-0000-4000-8000-000000000009",
};
const parkedAt = new Date("2042-06-07T08:00:00.000Z");
const digest = new Uint8Array(32).fill(7);

function row() {
  return {
    task: {
      id: ids.task, requestorId: ids.user, scheduleKind: "now", status: "awaiting",
      contentRepresentation: "protected", contentNamespaceId: ids.namespace,
      contentRevision: 1, cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
      cryptoAccessRevision: 0, cryptoRequiredNamespaceFingerprint: digest,
      cryptoMappingState: "verified",
    },
    run: {
      id: ids.run, taskId: ids.task, jobId: ids.job, graphThreadId: "thread-1",
      status: "awaiting", resultText: null, completedAt: null, lastError: null,
      resultRepresentation: "ordinary", resultContentNamespaceId: null,
      resultRevision: 0, resultCryptoObjectId: null, resultCryptoAccessRevision: 0,
      resultCryptoRequiredNamespaceFingerprint: null,
      resultCryptoMappingState: "unmapped",
    },
    job: {
      id: ids.job, ownerId: ids.user, requestorId: ids.user,
      laneKey: `task:${ids.task}`, type: "foreground", status: "completed",
      input: {
        kind: "protected_task_run_v1", taskId: ids.task, taskRunId: ids.run,
        inputObjectId: `task-definition:v1:${"a".repeat(64)}`,
        resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
        authorizationRequestId: `task-run-authorization:${ids.run}`,
        policyRevision: 7, executionSegment: 1,
      },
      result: null, message: null, startedAt: new Date(parkedAt.getTime() - 1000),
      completedAt: parkedAt,
      parkReceipt: {
        version: 1, taskId: ids.task, taskRunId: ids.run, jobId: ids.job,
        graphThreadId: "thread-1", generation: 0, executionSegment: 1,
        interrupts: [], parkedAt: parkedAt.toISOString(),
      },
    },
    segment: {
      taskRunId: ids.run, executionSegment: 1, jobId: ids.job,
      route: "native_langgraph_v1",
      transcriptContract: "protected_message_associations_v1",
      expectedTranscriptAssociationCount: 2,
      transcriptAssociationDigest: digest,
      checkpointContract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1, checkpointDigest: digest,
      expectedCheckpointBlobCount: 2, checkpointBlobDigest: digest,
      expectedPendingWriteCount: 0, pendingWriteDigest: digest,
      sealedAt: parkedAt,
    },
  };
}

function wakeRow() {
  const wakeJobId = protectedTaskRunWakeJobId(ids.run);
  const wakeDigest = new Uint8Array(32).fill(8);
  const requirements = [
    { namespaceId: ids.foreground, operations: ["decrypt"] },
    { namespaceId: ids.destination, operations: ["encrypt"] },
  ] as const;
  return {
    task: {
      id: ids.task, ownerId: ids.user, requestorId: ids.user,
      contentRepresentation: "protected", contentNamespaceId: ids.namespace,
      contentRevision: 1, cryptoObjectId: `task-definition:v1:${"a".repeat(64)}`,
      cryptoMappingState: "verified",
    },
    run: {
      id: ids.run, taskId: ids.task, status: "completed", completedAt: parkedAt,
      resultRepresentation: "protected", resultContentNamespaceId: ids.namespace,
      resultRevision: 1, resultCryptoObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      resultCryptoMappingState: "verified",
    },
    binding: {
      taskRunId: ids.run, bindingId: `task-run-output:${ids.run}`,
      deliveryMode: "wake", destinationRoomId: ids.room,
      destinationNamespaceId: ids.foreground, resultRevision: 1,
      resultOperationId: `task-run-result:${ids.run}`,
      resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
      messageOperationId: null,
      wakeOperationId: `task-run-delivery-wake:${ids.run}`,
      acceptedPolicyRevision: 7, acceptedAt: parkedAt,
      resultTerminalAt: parkedAt, resultAttachedAt: parkedAt,
      messageId: null, messagePublishedAt: null, wakeJobId,
      wakeScheduledAt: parkedAt, completedAt: parkedAt,
    },
    job: {
      id: wakeJobId, ownerId: ids.user, requestorId: ids.user, roomId: ids.room,
      laneKey: `room:${ids.room}`, type: "foreground", status: "queued",
      startedAt: null, completedAt: null, result: null, message: null, metadata: {},
      input: {
        kind: "protected_task_delivery_v1", taskId: ids.task,
        taskRunId: ids.run, bindingId: `task-run-output:${ids.run}`,
        resultObjectId: `task-run-result:v1:${"b".repeat(64)}`,
        wakeOperationId: `task-run-delivery-wake:${ids.run}`,
      },
    },
    receipt: {
      wakeJobId, segment: 1, taskId: ids.task, taskRunId: ids.run,
      bindingId: `task-run-output:${ids.run}`,
      wakeOperationId: `task-run-delivery-wake:${ids.run}`,
      priorRecipientGeneration: 0,
      wakeAuthorizationRequestId: `task-wake-authorization:${wakeJobId}`,
      additionalAuthorizationRequestId: "task.memory.projection:request",
      interruptId: "interrupt:projection:1", operationId: "memory:projection:1",
      requestDigest: wakeDigest,
      requiredAuthorityDigest:
        protectedTaskSemanticAuthorityRequirementsDigest(requirements),
      semanticAuthorityRequirements: requirements,
      retainedSourceNamespaceIds: [ids.foreground],
      sourceEnvelopeDigest: wakeDigest,
      initialPolicyRevision: 7, initialAgentAuthorizationRevision: 4,
      destinationRoomId: ids.destinationRoom,
      destinationNamespaceId: ids.destination,
      destinationAuthorityDigest: wakeDigest,
      checkpointThreadId: `protected-task-wake:${wakeJobId}`,
      checkpointContract: "encrypted_langgraph_v1",
      expectedCheckpointCount: 1, checkpointOrderedDigest: wakeDigest,
      expectedBlobCount: 2, blobOrderedDigest: wakeDigest,
      expectedPendingWriteCount: 0, pendingWriteOrderedDigest: wakeDigest,
      sealedAt: parkedAt,
    },
  };
}

function transaction(executionRows: unknown[], wakeRows: unknown[] = []) {
  const events: string[] = [];
  const chain = (rows: unknown[]) => {
    const value: Record<string, unknown> = {};
    for (const method of ["innerJoin", "leftJoin", "where", "orderBy"] as const) {
      value[method] = (..._args: unknown[]) => {
        events.push(method);
        return value;
      };
    }
    value["limit"] = async (limit: number) => {
      events.push(`limit:${limit}`);
      return rows;
    };
    return value;
  };
  return {
    tx: { select: (selection: Record<string, unknown>) => ({
      from: () => Object.keys(selection).includes("receipt")
        ? chain(wakeRows)
        : Object.keys(selection).length === 1
          ? chain([])
          : chain(executionRows),
    }) },
    events,
  };
}

describe("protected Task activation parked integrity page", () => {
  test("returns a detached exact manifest from the current linked park", async () => {
    const source = row();
    const fixture = transaction([source]);
    const page = await listProtectedTaskActivationParkedIntegrityCandidates(
      fixture.tx as never,
      { limit: 2 },
    );
    expect(page.nextCursor).toBeNull();
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]).toMatchObject({
      taskId: ids.task, taskRunId: ids.run, jobId: ids.job,
      kind: "execution",
      graphThreadId: "thread-1", executionSegment: 1,
      acceptedPolicyRevision: 7,
      transcript: { expectedAssociationCount: 2 },
      checkpoint: { expectedCheckpointCount: 1, expectedBlobCount: 2 },
    });
    source.segment.checkpointDigest.fill(0);
    expect(page.candidates[0]!.checkpoint.checkpointOrderedDigest[0]).toBe(7);
    expect(fixture.events.filter(event => event === "limit:2")).toHaveLength(2);
  });

  test("uses a stable Job cursor for a full page", async () => {
    const page = await listProtectedTaskActivationParkedIntegrityCandidates(
      transaction([row()]).tx as never,
      { limit: 1 },
    );
    expect(page.nextCursor).toBe(ids.job);
    await Promise.resolve(expect(listProtectedTaskActivationParkedIntegrityCandidates(
      transaction([]).tx as never,
      { limit: PROTECTED_TASK_ACTIVATION_PARKED_PAGE_LIMIT + 1 },
    )).rejects.toThrow("cursor is malformed"));
    await Promise.resolve(expect(listProtectedTaskActivationParkedIntegrityCandidates(
      transaction([]).tx as never,
      { afterJobId: "bad" },
    )).rejects.toThrow("cursor is malformed"));
  });

  test("fails closed for malformed lifecycle, reference, park, or segment proof", async () => {
    for (const mutate of [
      (value: ReturnType<typeof row>) => {
        value.run.jobId = "60000000-0000-4000-8000-000000000099";
      },
      (value: ReturnType<typeof row>) => { value.job.input.executionSegment = 2; },
      (value: ReturnType<typeof row>) => { value.job.parkReceipt.generation = -1; },
      (value: ReturnType<typeof row>) => { value.segment = null as never; },
    ]) {
      const value = row();
      mutate(value);
      await Promise.resolve(expect(listProtectedTaskActivationParkedIntegrityCandidates(
        transaction([value]).tx as never,
        {},
      )).rejects.toThrow("proof is malformed"));
    }
  });

  test("returns the latest terminal-Run wake continuation manifest", async () => {
    const source = wakeRow();
    const page = await listProtectedTaskActivationParkedIntegrityCandidates(
      transaction([], [source]).tx as never,
      { limit: 2 },
    );
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0]).toMatchObject({
      kind: "wake_continuation", taskId: ids.task, taskRunId: ids.run,
      jobId: protectedTaskRunWakeJobId(ids.run), segment: 1,
      acceptedPolicyRevision: 7,
      checkpointThreadId:
        `protected-task-wake:${protectedTaskRunWakeJobId(ids.run)}`,
      checkpoint: { expectedCheckpointCount: 1 },
    });
    source.receipt.checkpointOrderedDigest.fill(0);
    expect(page.candidates[0]!.checkpoint.checkpointOrderedDigest[0]).toBe(8);
  });

  test("fails closed for a revived Run, terminal wake Job, or substituted manifest", async () => {
    for (const mutate of [
      (value: ReturnType<typeof wakeRow>) => { value.run.status = "running"; },
      (value: ReturnType<typeof wakeRow>) => { value.job.status = "completed"; },
      (value: ReturnType<typeof wakeRow>) => {
        value.receipt.checkpointThreadId = "protected-task-wake:substituted";
      },
      (value: ReturnType<typeof wakeRow>) => {
        value.receipt.destinationNamespaceId = ids.foreground;
      },
    ]) {
      const value = wakeRow();
      mutate(value);
      await Promise.resolve(expect(listProtectedTaskActivationParkedIntegrityCandidates(
        transaction([], [value]).tx as never,
        {},
      )).rejects.toThrow("parked wake activation proof is malformed"));
    }
  });
});
