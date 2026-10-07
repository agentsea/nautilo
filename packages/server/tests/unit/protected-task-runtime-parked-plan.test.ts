import { expect, test } from "bun:test";
import type {
  ParkedProtectedTaskAdditionalAuthority,
  ProtectedTaskRunOutputBinding,
} from "@nautilo/db";
import type { ParkedTaskRuntimeCurrentRoutingFacts } from
  "@nautilo/lattice-bridge/server";
import { taskRuntimeStableRoutingDigest } from "@nautilo/runtime";

import type { ParkedProtectedTaskRuntimeMemoryPlan } from
  "../../src/routes/protected-task-runtime-parked-memory-plan";
import { createParkedTaskRuntimeAuthorizationPlanResolver } from
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
