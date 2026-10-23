import { expect, test } from "bun:test";
import type {
  ParkedProtectedTaskAdditionalAuthority,
  ParkedProtectedTaskCheckpointContinuation,
  ProtectedTaskRunOutputBinding,
} from "@nautilo/db";
import type { ParkedTaskRuntimeCurrentRoutingFacts } from
  "@nautilo/lattice-bridge/server";
import { taskRuntimeStableRoutingDigest } from "@nautilo/runtime";

import type { ParkedProtectedTaskRuntimeMemoryPlan } from
  "../../src/routes/protected-task-runtime-parked-memory-plan";
import {
  createParkedTaskRuntimeAuthorizationPlanResolver,
  createParkedTaskRuntimeAuthorizationRecord,
} from
  "../../src/routes/protected-task-runtime-parked-plan";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const JOB = "60000000-0000-4000-8000-000000000006";
const CONTENT = "70000000-0000-4000-8000-000000000007";
const MEMORY = "80000000-0000-4000-8000-000000000008";
const SOURCE = "90000000-0000-4000-8000-000000000009";
const TARGET = "a0000000-0000-4000-8000-00000000000a";
const NOW = 1_700_000_000_000;
const INPUT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT = `task-run-result:v1:${"b".repeat(64)}`;
const REQUEST = "task-run-authorization:v2:parked-plan";
const CHECKPOINT_FINGERPRINT = Buffer.alloc(32, 4).toString("base64url");
const CHECKPOINT_REQUEST =
  `task-checkpoint-continuation:${RUN}:2:${CHECKPOINT_FINGERPRINT}`;

function fixture() {
  const facts: ParkedTaskRuntimeCurrentRoutingFacts = {
    taskId: TASK,
    taskRunId: RUN,
    ownerId: USER,
    requestorId: USER,
    agentId: AGENT,
    callingRoomId: SOURCE,
    scheduleKind: "now",
    graphThreadId: "task-thread",
    startedAt: new Date(NOW),
    sourceRoomId: SOURCE,
    targetRoomId: TARGET,
    targetUserIds: [USER],
    memoryMode: "namespace",
    wideBringBack: false,
    scopeId: null,
    contentRepresentation: "dual",
    contentNamespaceId: CONTENT,
    contentRevision: 1,
    contentObjectId: INPUT,
    contentAccessRevision: 0,
    requiredNamespaceFingerprint: new Uint8Array(32).fill(1),
  };
  const expected = {
    occurrence: {
      task: {
        id: TASK,
        ownerId: USER,
        requestorId: USER,
        agentId: AGENT,
        callingRoomId: SOURCE,
        scheduleKind: "now",
        status: "awaiting",
        contentRepresentation: "dual",
        contentNamespaceId: CONTENT,
        contentRevision: 1,
        cryptoObjectId: INPUT,
        cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint:
          facts.requiredNamespaceFingerprint,
      },
      run: {
        id: RUN,
        taskId: TASK,
        jobId: JOB,
        graphThreadId: facts.graphThreadId,
        status: "awaiting",
        startedAt: new Date(NOW),
      },
    },
    priorJob: { reference: { resultObjectId: RESULT } },
    proof: {
      continuation: {
        stableRoutingDigest: taskRuntimeStableRoutingDigest({
          ...facts,
          startedAt: NOW,
          requiredNamespaceFingerprint: Buffer.from(
            facts.requiredNamespaceFingerprint,
          ).toString("base64url"),
          outputRoomId: SOURCE,
          outputNamespaceId: CONTENT,
          widePrimaryWriteNamespaceId: null,
        }),
        semanticAuthorityRequirements: [],
      },
    },
    authorizationRequestId: REQUEST,
    continuationFingerprint: Buffer.alloc(32, 2).toString("base64url"),
    nextExecutionSegment: 2,
  } as unknown as ParkedProtectedTaskAdditionalAuthority;
  const output = {
    taskRunId: RUN,
    bindingId: `task-run-output:${RUN}`,
    resultOperationId: `task-run-result:${RUN}`,
    resultObjectId: RESULT,
    destinationRoomId: SOURCE,
    destinationNamespaceId: CONTENT,
    deliveryMode: "raw",
    acceptedPolicyRevision: 7,
  } as ProtectedTaskRunOutputBinding;
  const memory: ParkedProtectedTaskRuntimeMemoryPlan = {
    routing: {
      taskId: TASK,
      taskRunId: RUN,
      requesterUserId: USER,
      requesterHumanId: HUMAN,
      agentId: AGENT,
      sourceRoomId: SOURCE,
      sourceNamespaceId: CONTENT,
      targetRoomId: TARGET,
      targetUserIds: [USER],
      memoryMode: "namespace",
      scopeId: null,
      targetChat: "new_in_namespace",
      wideBringBack: false,
      widePrivateNamespaceId: null,
      outputRoomId: SOURCE,
      outputNamespaceId: CONTENT,
    },
    resolution: {
      mode: "namespace",
      authorityStatus: "exact",
      provenance: "target_users_namespace",
      envelope: {
        memoryMode: "namespace",
        ownerId: USER,
        actorId: HUMAN,
        agentId: AGENT,
        roomId: TARGET,
        readableNamespaces: [MEMORY],
        mutableNamespaces: [MEMORY],
        writableNamespaces: [MEMORY],
        toolPolicy: {},
      },
    },
  };
  return { facts, expected, output, memory };
}

function checkpointFixture() {
  const value = fixture();
  const routingDigest = value.expected.proof.continuation.stableRoutingDigest;
  const expected = {
    ...value.expected,
    priorJob: {
      id: JOB, generation: 2, parkedAt: new Date(NOW + 1),
      interrupts: Object.freeze([]),
      reference: {
        kind: "protected_task_run_v1" as const,
        taskId: TASK, taskRunId: RUN, inputObjectId: INPUT,
        resultObjectId: RESULT, authorizationRequestId: REQUEST,
        policyRevision: 7, executionSegment: 1,
      },
    },
    proof: {
      segment: {
        taskRunId: RUN, executionSegment: 1, jobId: JOB,
        route: "native_langgraph_v1" as const,
        transcriptContract: "protected_message_associations_v1" as const,
        expectedTranscriptAssociationCount: 0,
        transcriptAssociationDigest: new Uint8Array(32).fill(2),
        checkpointContract: "encrypted_langgraph_v1" as const,
        expectedCheckpointCount: 1,
        checkpointDigest: new Uint8Array(32).fill(3),
        expectedCheckpointBlobCount: 1,
        checkpointBlobDigest: new Uint8Array(32).fill(4),
        expectedPendingWriteCount: 0,
        pendingWriteDigest: new Uint8Array(32).fill(5),
        sealedAt: new Date(NOW + 1),
      },
      continuation: {
        taskRunId: RUN, executionSegment: 1, jobId: JOB,
        kind: "checkpoint_safe_v1" as const,
        reason: "manual_pause" as const,
        effectDisposition: "none_v1" as const,
        interruptId: null, operationId: null, requestDigest: null,
        requiredAuthorityDigest: null, stableRoutingDigest: null,
        semanticAuthorityRequirements: null,
        sealedAt: new Date(NOW + 1),
      },
    },
    stableRoutingDigest: routingDigest,
    authorizationRequestId: CHECKPOINT_REQUEST,
    continuationFingerprint: CHECKPOINT_FINGERPRINT,
    nextExecutionSegment: 2,
  } as unknown as ParkedProtectedTaskCheckpointContinuation;
  return { ...value, expected };
}

test("resolves a fresh parked plan and validates its committed routing", async () => {
  const value = fixture();
  const resolve = createParkedTaskRuntimeAuthorizationPlanResolver({
    db: {} as never,
    discover: async () => value.expected,
    readPolicy: async () => ({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: 7,
    }),
    readOutput: async () => value.output,
    resolveMemory: async () => value.memory,
  });
  const resolved = await resolve({
    taskRunId: RUN,
    authorizationRequestId: REQUEST,
  });
  expect(resolved?.expected.authorizationRequestId).toBe(REQUEST);
  expect(resolved?.validateCurrentRouting(value.facts)).toBe(true);
});

test("builds a checkpoint grant from the closed routing proof without semantic authority", async () => {
  const value = checkpointFixture();
  const resolve = createParkedTaskRuntimeAuthorizationPlanResolver({
    db: {} as never,
    discover: async () => value.expected,
    readPolicy: async () => ({
      mode: "shadow_encryption", shadowBehavior: "strict", revision: 7,
    }),
    readOutput: async () => value.output,
    resolveMemory: async () => value.memory,
  });
  const resolved = await resolve({ taskRunId: RUN,
    authorizationRequestId: CHECKPOINT_REQUEST });
  if (resolved === null) throw new Error("checkpoint plan missing");
  expect(resolved.validateCurrentRouting(value.facts)).toBe(true);
  const currentFacts = resolved.inventory.namespaceIds.map((namespaceId, index) => ({
    namespaceId, domainId: `domain:${index}`,
    expectedAccessRevision: 0, expectedPolicyRevision: 7,
    expectedDomainEpoch: 1, expectedAuthorizationRevision: 0,
  }));
  const record = createParkedTaskRuntimeAuthorizationRecord(
    resolved, value.facts, currentFacts, NOW,
  );
  expect(record.initialRecord).toMatchObject({
    workKind: "task.execute", purpose: "task.execute",
    snapshot: { requestId: CHECKPOINT_REQUEST, workId: RUN },
  });
  expect(record.stableIdentity).toMatchObject({
    executionSegment: 2,
    resumeContinuationFingerprint: CHECKPOINT_FINGERPRINT,
  });
  expect(resolved.inventory.namespaceIds).not.toContain("semantic:authority");
});

test("rejects an optional request-ID mismatch before policy or Memory reads", async () => {
  const value = fixture();
  let policyReads = 0;
  const resolve = createParkedTaskRuntimeAuthorizationPlanResolver({
    db: {} as never,
    discover: async () => value.expected,
    readPolicy: async () => {
      policyReads += 1;
      throw new Error("unexpected policy read");
    },
    readOutput: async () => { throw new Error("unexpected output read"); },
    resolveMemory: async () => { throw new Error("unexpected Memory read"); },
  });
  expect(await resolve({
    taskRunId: RUN,
    authorizationRequestId: `${REQUEST}:other`,
  })).toBeNull();
  expect(policyReads).toBe(0);
});

test("Plain policy rejects before output and Memory resolution", async () => {
  const value = fixture();
  const resolve = createParkedTaskRuntimeAuthorizationPlanResolver({
    db: {} as never,
    discover: async () => value.expected,
    readPolicy: async () => ({
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 8,
    }),
    readOutput: async () => { throw new Error("unexpected output read"); },
    resolveMemory: async () => { throw new Error("unexpected Memory read"); },
  });
  expect(await resolve({ taskRunId: RUN })).toBeNull();
});
