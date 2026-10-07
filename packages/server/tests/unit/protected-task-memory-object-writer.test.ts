import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  deriveMemoryCryptoObjectIdV1,
  MEMORY_OBJECT_TYPE,
  type PreparedTaskRuntimeAgentObject,
} from "@nautilo/lattice-bridge";
import type {
  ConversationProductCanonicalTransactionRunner,
  CurrentTaskRuntimeAuthority,
} from "@nautilo/lattice-bridge/server";
import type {
  BackgroundAuthorizationTaskRuntimeRecordV3,
  ProtectedTaskJobReferenceV1,
  ProtectedTaskRunningOccurrence,
} from "@nautilo/runtime";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";

import {
  persistProtectedTaskMemoryObject,
  persistProtectedTaskMemoryObjectUnderHeld,
  taskMemoryWriteAuthorityMatchesEvidence,
  type ProtectedTaskMemoryObjectWriterInput,
} from "../../src/routes/protected-task-memory-object-writer";
import type {
  HeldProtectedTaskMemoryAuthority,
} from "../../src/routes/current-protected-task-memory-authority";

const NOW = 2_220_000_000_000;
const USER_ID = "10000000-0000-4000-8000-000000000001";
const HUMAN_ID = "20000000-0000-4000-8000-000000000002";
const DEVICE_ID = "30000000-0000-4000-8000-000000000003";
const AGENT_ID = "40000000-0000-4000-8000-000000000004";
const TASK_ID = "50000000-0000-4000-8000-000000000005";
const RUN_ID = "60000000-0000-4000-8000-000000000006";
const JOB_ID = "70000000-0000-4000-8000-000000000007";
const ROOM_ID = "80000000-0000-4000-8000-000000000008";
const NAMESPACE_A = "90000000-0000-4000-8000-000000000009";
const NAMESPACE_B = "a0000000-0000-4000-8000-00000000000a";
const DOMAIN_A = "b0000000-0000-4000-8000-00000000000b";
const DOMAIN_B = "c0000000-0000-4000-8000-00000000000c";
const MEMORY_ID = "d0000000-0000-4000-8000-00000000000d";
const INPUT_OBJECT_ID = `task-definition:v1:${"a".repeat(64)}`;
const RESULT_OBJECT_ID = `task-run-result:v1:${"b".repeat(64)}`;
const REQUEST_ID = `task-run-authorization:${RUN_ID}`;

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const domains = [
    {
      domainId: DOMAIN_A,
      sourceNamespaceId: NAMESPACE_A,
      participantDigest: bytes(0x11),
      participantCount: 2,
      keyClass: "ai" as const,
      domainKeyGeneration: 3,
      authorizationRevision: authorizationRevision(5),
      headDigest: bytes(0x12),
      activeNamespaceBindingSetDigest: bytes(0x13),
      activeNamespaceBindingCount: 2,
    },
    {
      domainId: DOMAIN_B,
      sourceNamespaceId: NAMESPACE_B,
      participantDigest: bytes(0x21),
      participantCount: 1,
      keyClass: "ai" as const,
      domainKeyGeneration: 7,
      authorizationRevision: authorizationRevision(9),
      headDigest: bytes(0x22),
      activeNamespaceBindingSetDigest: bytes(0x23),
      activeNamespaceBindingCount: 1,
    },
  ];
  const namespaces = [
    {
      ordinal: 0,
      namespaceId: NAMESPACE_A,
      domainId: DOMAIN_A,
      operations: ["decrypt", "encrypt"] as const,
      expectedAccessRevision: 4,
      expectedPolicyRevision: 17,
    },
    {
      ordinal: 1,
      namespaceId: NAMESPACE_B,
      domainId: DOMAIN_B,
      operations: ["encrypt"] as const,
      expectedAccessRevision: 8,
      expectedPolicyRevision: 17,
    },
  ];
  const plan = createDomainForegroundAuthorizationPlan(crypto, {
    authorizationId: REQUEST_ID,
    policyRevision: 17,
    sessionId: `task-run:${RUN_ID}`,
    roomId: ROOM_ID,
    subjectHumanId: humanId(HUMAN_ID),
    committerDeviceId: cryptoDeviceId(DEVICE_ID),
    committerDeviceSigningGeneration: 3,
    hostAuthorizationRevision: authorizationRevision(19),
    recipientKind: "runtime",
    recipientPrincipalId: "nautilo_task_runtime",
    recipientAuthorizationRevision: authorizationRevision(23),
    recipientRuntimeGeneration: 4,
    recipientKeyId: "task-memory-recipient-key",
    operations: ["decrypt", "encrypt"],
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
    maximumSecretBytes: 8_192,
    domains,
  });
  const request = createTaskRuntimeBackgroundAuthorizationRequestV1({
    requestId: REQUEST_ID,
    workId: RUN_ID,
    workKind: "task.execute",
    workPurpose: "task.execute",
    recipientGeneration: 4,
    episodeId: plan.sessionId,
    sourceRoomId: plan.roomId,
    recipientKeyId: plan.recipientKeyId,
    recipientPublicKey: recipient.publicKey,
    authorizationPlan: plan,
    issuedAt: NOW,
    deadlineAt: NOW + 60_000,
  });
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: REQUEST_ID,
    workId: RUN_ID,
    claimId: "task-memory-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 4,
    recipientKeyId: plan.recipientKeyId,
    authorizationDigest: bytes(0x61),
    policyRevision: 17,
    episodeId: plan.sessionId,
    sourceRoomId: plan.roomId,
    hostAuthorizationRevision: 19,
    recipientAuthorizationRevision: 23,
    result: {
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1,
      objectId: RESULT_OBJECT_ID,
      signerAgentId: AGENT_ID,
      namespace: {
        namespaceId: NAMESPACE_A,
        domainId: DOMAIN_A,
        operations: ["encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 17,
      },
    },
    domainRequirements: domains,
    namespaceRequirements: namespaces,
  };
  const occurrence: ProtectedTaskRunningOccurrence = {
    task: {
      id: TASK_ID,
      ownerId: USER_ID,
      requestorId: USER_ID,
      agentId: AGENT_ID,
      callingRoomId: ROOM_ID,
      scheduleKind: "now",
      contentRepresentation: "protected",
      contentNamespaceId: NAMESPACE_A,
      contentRevision: 2,
      cryptoObjectId: INPUT_OBJECT_ID,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: bytes(0x71),
    },
    run: {
      id: RUN_ID,
      taskId: TASK_ID,
      jobId: JOB_ID,
      graphThreadId: `task:${TASK_ID}:${RUN_ID}`,
      status: "running",
      startedAt: new Date(NOW - 1_000),
    },
  };
  const reference: ProtectedTaskJobReferenceV1 = {
    kind: "protected_task_run_v1",
    taskId: TASK_ID,
    taskRunId: RUN_ID,
    inputObjectId: INPUT_OBJECT_ID,
    resultObjectId: RESULT_OBJECT_ID,
    authorizationRequestId: REQUEST_ID,
    policyRevision: 17,
    executionSegment: 1,
  };
  const record = {
    snapshot: {
      formatVersion: 3,
      credentialSubject: {
        kind: "runtime",
        runtimeKind: "task",
        runtimeVersion: 1,
      },
      requestId: REQUEST_ID,
      workId: RUN_ID,
      state: "running",
      descriptorDigest: "11".repeat(32),
      recipientGeneration: 4,
      recipient: {
        recipientKeyId: plan.recipientKeyId,
        recipientPublicKey: Buffer.from(recipient.publicKey).toString("base64url"),
        expiresAt: NOW + 60_000,
      },
      acceptedResponse: {
        kind: "runtime",
        responseDigest: "61".repeat(32),
        credentialDigest: "61".repeat(32),
        issuingHumanId: HUMAN_ID,
        issuingDeviceId: DEVICE_ID,
        recipientGeneration: 4,
        acceptedAt: NOW,
      },
      claimId: "task-memory-claim",
      claimExpiresAt: NOW + 60_000,
    },
    descriptorBytes: encodeTaskRuntimeBackgroundAuthorizationRequestV1(request),
    workKind: "task.execute",
    purpose: "task.execute",
    expectedPolicyRevision: 17,
    authoritySet: {
      namespaceRequirements: namespaces,
      domainRequirements: domains.map((domain, ordinal) => ({
        ordinal,
        domainId: domain.domainId,
        expectedEpoch: domain.domainKeyGeneration,
        expectedAuthorizationRevision: domain.authorizationRevision,
      })),
    },
    acceptedMaterial: {
      responseBytes: bytes(0x62),
      credentialId: plan.authorizationId,
      issuingDeviceAuthorizationRevision: plan.hostAuthorizationRevision,
      issuerSigningPublicKeyHash: bytes(0x63),
      authorizationExpiresAt: NOW + 60_000,
    },
  } as unknown as BackgroundAuthorizationTaskRuntimeRecordV3;
  const authority: CurrentTaskRuntimeAuthority = {
    device: {
      userId: USER_ID,
      humanActorId: HUMAN_ID,
      deviceId: DEVICE_ID,
      deviceGeneration: 3,
      serverInstanceId: "e0000000-0000-4000-8000-00000000000e",
      lineageGeneration: 1,
      epoch: 1,
      securityRevision: authorizationRevision(19),
      headDigest: bytes(0x72),
      signingPublicKey: signing.publicKey,
    },
    plan,
    domains,
    namespaceRequirements: namespaces,
    policyRevision: 17,
  };
  recipient.privateKey.fill(0);
  return {
    crypto,
    evidenceInput,
    occurrence,
    reference,
    record,
    request,
    authority,
  };
}

function changedAuthority(
  authority: CurrentTaskRuntimeAuthority,
  change: (copy: CurrentTaskRuntimeAuthority) => void,
): CurrentTaskRuntimeAuthority {
  const copy = structuredClone(authority);
  change(copy);
  return copy;
}

function set(
  value: object,
  key: string,
  replacement: unknown,
): void {
  (value as Record<string, unknown>)[key] = replacement;
}

describe("protected Task Memory object writer", () => {
  test("matches the complete grant Namespace and Domain authority", async () => {
    const value = await fixture();
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => {
        expect(taskMemoryWriteAuthorityMatchesEvidence(
          value.authority,
          evidence,
        )).toBeTrue();

        const substitutions: CurrentTaskRuntimeAuthority[] = [
          changedAuthority(value.authority, copy => set(copy, "policyRevision", 18)),
          changedAuthority(value.authority, copy => set(copy.plan, "authorizationId", "other-request")),
          changedAuthority(value.authority, copy => set(copy.plan, "sessionId", "other-session")),
          changedAuthority(value.authority, copy => set(copy.plan, "roomId", "other-room")),
          changedAuthority(value.authority, copy => set(copy.plan, "hostAuthorizationRevision", 20)),
          changedAuthority(value.authority, copy => set(copy.plan, "recipientKind", "human")),
          changedAuthority(value.authority, copy => set(copy.plan, "recipientPrincipalId", "other-runtime")),
          changedAuthority(value.authority, copy => set(copy.plan, "recipientAuthorizationRevision", 24)),
          changedAuthority(value.authority, copy => set(copy.plan, "recipientRuntimeGeneration", 5)),
          changedAuthority(value.authority, copy => set(copy.plan, "recipientKeyId", "other-key")),
          changedAuthority(value.authority, copy => set(copy, "namespaceRequirements", copy.namespaceRequirements.slice(0, 1))),
          ...[
            ["ordinal", 9],
            ["namespaceId", "other-namespace"],
            ["domainId", "other-domain"],
            ["expectedAccessRevision", 99],
            ["expectedPolicyRevision", 99],
            ["operations", ["decrypt"]],
          ].map(([key, replacement]) => changedAuthority(value.authority, copy => {
            set(copy.namespaceRequirements[1]!, key as string, replacement);
          })),
          changedAuthority(value.authority, copy => set(copy, "domains", copy.domains.slice(0, 1))),
          ...[
            ["keyClass", "human"],
            ["sourceNamespaceId", "other-namespace"],
            ["domainKeyGeneration", 99],
            ["authorizationRevision", 99],
            ["participantCount", 99],
            ["activeNamespaceBindingCount", 99],
            ["participantDigest", bytes(0x81)],
            ["headDigest", bytes(0x82)],
            ["activeNamespaceBindingSetDigest", bytes(0x83)],
          ].map(([key, replacement]) => changedAuthority(value.authority, copy => {
            set(copy.domains[1]!, key as string, replacement);
          })),
        ];
        for (const substituted of substitutions) {
          expect(taskMemoryWriteAuthorityMatchesEvidence(
            substituted,
            evidence,
          )).toBeFalse();
        }
      },
    });
  });

  test("rejects invalid entry and maps expired accepted authority to stale before database use", async () => {
    const value = await fixture();
    let databaseUse = 0;
    let now = NOW;
    const runner = {
      role: "nautilo",
      transaction: async () => {
        databaseUse += 1;
        throw new Error("database must not be used");
      },
    } as unknown as ConversationProductCanonicalTransactionRunner;
    const restricted: PostgresJsBridgeConnection = {
      query: async () => {
        databaseUse += 1;
        throw new Error("database must not be used");
      },
      transaction: async () => {
        databaseUse += 1;
        throw new Error("database must not be used");
      },
      transactionOnce: async () => {
        databaseUse += 1;
        throw new Error("database must not be used");
      },
    } as unknown as PostgresJsBridgeConnection;
    const input = (
      evidence: TaskRuntimeExecutionEvidence,
      record = value.record,
    ): ProtectedTaskMemoryObjectWriterInput => ({
      runner,
      restricted,
      crypto: value.crypto,
      serverScope: "https://nautilo.example",
      subject: {
        userId: USER_ID,
        humanActorId: HUMAN_ID,
        deviceId: DEVICE_ID,
      },
      occurrence: value.occurrence,
      record,
      request: value.request,
      evidence,
      jobId: JOB_ID,
      executionRoomId: ROOM_ID,
      reference: value.reference,
      now: () => now,
      signal: new AbortController().signal,
    });
    const expectedObjectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: 1,
    });
    const write = (preparedObjectId = expectedObjectId) => ({
      memoryId: MEMORY_ID,
      contentRevision: 1,
      operationId: "task-memory-write",
      prepared: Object.freeze({
        objectId: preparedObjectId,
        objectType: MEMORY_OBJECT_TYPE,
      }) as PreparedTaskRuntimeAgentObject,
    });

    await Promise.resolve(expect(persistProtectedTaskMemoryObject(
      input(value.evidenceInput as unknown as TaskRuntimeExecutionEvidence),
      write(),
    )).rejects.toBeInstanceOf(Error));

    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => now,
      execute: async (evidence) => {
        now = value.evidenceInput.expiresAt;
        await Promise.resolve(expect(persistProtectedTaskMemoryObject(
          input(evidence),
          write(),
        )).rejects.toBeInstanceOf(Error));
      },
    });

    now = NOW;
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: value.evidenceInput,
      signal: new AbortController().signal,
      now: () => now,
      execute: async (evidence) => {
        await Promise.resolve(expect(persistProtectedTaskMemoryObject(
          { ...input(evidence), runner: { ...runner, role: "nautilo_agent" } },
          write(),
        )).rejects.toThrow("requires the complete product role"));
        const wrongRecord = {
          ...value.record,
          snapshot: {
            ...value.record.snapshot,
            requestId: "other-request",
          },
        } as BackgroundAuthorizationTaskRuntimeRecordV3;
        await Promise.resolve(expect(persistProtectedTaskMemoryObject(
          input(evidence, wrongRecord),
          write(),
        )).rejects.toBeInstanceOf(Error));
        await Promise.resolve(expect(persistProtectedTaskMemoryObject(
          input(evidence),
          write(`${expectedObjectId}-wrong`),
        )).rejects.toThrow("Task Memory object coordinate is not exact"));

        const expiredAccepted = {
          ...value.record,
          acceptedMaterial: {
            ...value.record.acceptedMaterial!,
            authorizationExpiresAt: NOW,
          },
        } as BackgroundAuthorizationTaskRuntimeRecordV3;
        expect(await persistProtectedTaskMemoryObject(
          input(evidence, expiredAccepted),
          write(),
        )).toBe("stale");

        now = NOW - 1;
        await Promise.resolve(expect(persistProtectedTaskMemoryObject(
          input(evidence),
          write(),
        )).rejects.toBeInstanceOf(Error));
        now = NOW;

        const failure = new Error("authority runner failed");
        let failingRunnerUses = 0;
        const failingRunner = {
          role: "nautilo",
          transaction: async () => {
            failingRunnerUses += 1;
            throw failure;
          },
        } as unknown as ConversationProductCanonicalTransactionRunner;
        await Promise.resolve(expect(persistProtectedTaskMemoryObject(
          {...input(evidence), runner: failingRunner},
          write(),
        )).rejects.toBe(failure));
        expect(failingRunnerUses).toBe(1);
      },
    });
    expect(databaseUse).toBe(0);
  });

  test("refuses a fabricated held authority before object persistence", async () => {
    const fabricated = Object.freeze({
      policy: Object.freeze({
        mode: "encrypted_only",
        shadowBehavior: "strict",
        revision: 1,
      }),
      currentRuntime: Object.freeze({}),
      assertCurrent: async () => {},
    }) as unknown as HeldProtectedTaskMemoryAuthority;

    await Promise.resolve(expect(persistProtectedTaskMemoryObjectUnderHeld(
      fabricated,
      {
        memoryId: MEMORY_ID,
        contentRevision: 1,
        operationId: "task-memory-write",
        prepared: Object.freeze({}) as PreparedTaskRuntimeAgentObject,
      },
    )).rejects.toThrow("Task Memory authority is not active"));
  });
});
