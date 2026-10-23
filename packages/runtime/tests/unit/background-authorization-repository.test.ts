import { canonicalWakeRecord, wakeReceipt, withWakeProof, WAKE_DESTINATION } from "../fixtures/task-wake-continuation";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type {
  VerifiedAgentBackgroundAuthorizationDeviceResponse,
  VerifiedAgentBackgroundAuthorizationDeviceResponseV2,
  VerifiedProcessorBackgroundAuthorizationDeviceResponse,
} from "@nautilo/lattice-bridge";
import {
  BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  cancelBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequestV2,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  markBackgroundAuthorizationPublicationReconciliation,
  scheduleBackgroundAuthorizationPublicationRetry,
  claimBackgroundAuthorizationRequest,
} from "../../src/protected-execution/background-authorization/lifecycle";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2 } from
  "@nautilo/lattice-crypto/wire";
import { BACKGROUND_AUTHORIZATION_BYTE_LIMITS } from "@nautilo/db/schema";
import {
  createBackgroundAuthorizationResponseV2,
  encodeTaskRuntimeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2,
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  verifyBackgroundAuthorizationResponseV2,
} from "@nautilo/lattice-crypto/background";
import {
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
  BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS,
  BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS,
  BackgroundAuthorizationRepositoryConflictError,
  InMemoryBackgroundAuthorizationRepository,
  buildDeferredUnstartedTaskRuntimeRequest,
  buildUnclaimedTaskRuntimeAuthorityReplacement,
  buildUnclaimedTaskCancellationAuthorityReplacement,
  buildUnclaimedTaskTerminalMessageAuthorityReplacement,
  buildUnclaimedTaskOutputReadAuthorityReplacement,
  buildParkedTaskWakeAuthorityReplacement,
  buildAcceptedBackgroundAuthorizationResponse,
  assertBackgroundAuthorizationCasSuccessor,
  parseBackgroundAuthorizationRecord,
  isTaskExecutionWorkKind,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationAgentRecordV2,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationVerifiedRuntimeResponseV3,
  type BackgroundAuthorizationVerifiedRuntimeResponseV4,
} from "../../src/protected-execution/background-authorization/repository";

const START = 1_700_000_000_000;
const RECIPIENT_PUBLIC_KEY =
  Buffer.from(new Uint8Array(65).fill(0x42)).toString("base64url");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function taskRuntimeRecordV3(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const descriptorBytes = new Uint8Array([0x31, 0x32, 0x33]);
  const initial = createBackgroundAuthorizationTaskRuntimeRequestV3({
    requestId: "task_runtime_request_v3",
    workId: "10000000-0000-4000-8000-000000000907",
    namespaceId: "task_runtime_namespace_a",
    now: START,
  });
  const snapshot = attachBackgroundAuthorizationRecipient(initial, {
    recipientGeneration: 0,
    recipientKeyId: "task_runtime_recipient_key_v3",
    recipientPublicKey: RECIPIENT_PUBLIC_KEY,
    descriptorDigest: digest(descriptorBytes),
    expiresAt: START + 60_000,
    now: START + 1,
  });
  return {
    snapshot: snapshot as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    workIdentityHash: new Uint8Array(32).fill(0x75),
    idempotencyKey: `task-runtime-stable-v1:${initial.workId}:${"a".repeat(43)}`,
    workKind: "task.execute",
    purpose: "task.execute",
    domainId: "task_runtime_domain_a",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 9,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 3,
    descriptorBytes,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [{
        ordinal: 0,
        namespaceId: "task_runtime_namespace_a",
        domainId: "task_runtime_domain_a",
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 4,
        expectedPolicyRevision: 3,
      }],
      domainRequirements: [{
        ordinal: 0,
        domainId: "task_runtime_domain_a",
        expectedEpoch: 9,
        expectedAuthorizationRevision: 7,
      }],
    },
  };
}

function taskRuntimePublicationRecordV3(
  workKind: "task.cancel_result" | "task.deliver_message"
    | "task.deliver_result" | "task.delivery_wake",
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const record = taskRuntimeRecordV3();
  return {
    ...record,
    workKind,
    purpose: workKind,
    idempotencyKey: `task-publication:${workKind}:${record.snapshot.workId}`,
    authoritySet: {
      ...record.authoritySet,
      namespaceRequirements: record.authoritySet.namespaceRequirements.map(
        requirement => ({
          ...requirement,
          operations: workKind === "task.cancel_result"
              || workKind === "task.deliver_message"
            ? ["encrypt"] as const
            : requirement.operations,
        }),
      ),
    },
  };
}

function taskRuntimeAwaitingRecipientV3():
  BackgroundAuthorizationTaskRuntimeRecordV3 {
  const record = taskRuntimeRecordV3();
  return {
    ...record,
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: record.snapshot.requestId,
      workId: record.snapshot.workId,
      namespaceId: record.snapshot.namespaceId,
      now: START,
    }),
    descriptorBytes: null,
  };
}

function relabelTaskRuntimeRecord(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  ordinal: number,
  updatedAt: number,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const workId = `10000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
  const terminal = ["completed", "cancelled", "terminal_failure"]
    .includes(record.snapshot.state);
  return {
    ...record,
    snapshot: {
      ...record.snapshot,
      requestId: `task_runtime_cancellation_${ordinal}`,
      workId,
      updatedAt,
    },
    workIdentityHash: new Uint8Array(32).fill(ordinal),
    idempotencyKey: `task-runtime-stable-v1:${workId}:${String.fromCharCode(96 + ordinal).repeat(43)}`,
    finishedAt: terminal ? updatedAt : null,
  };
}

function settlementTaskRuntimeRecord(
  ordinal: number,
  workKind:
    | "task.execute"
    | "task.dispatch"
    | "task.approval_resume"
    | "task.await_reply_resume"
    | "task.cancel_result",
  record = taskRuntimeRecordV3(),
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return {
    ...record,
    snapshot: {
      ...record.snapshot,
      requestId: `task_runtime_settlement_${ordinal}`,
    },
    workIdentityHash: new Uint8Array(32).fill(ordinal),
    idempotencyKey:
      `task-runtime-stable-v1:${record.snapshot.workId}:${String.fromCharCode(96 + ordinal).repeat(43)}`,
    workKind,
    purpose: workKind,
  };
}

function verifiedTaskRuntimeResponseV3(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): BackgroundAuthorizationVerifiedRuntimeResponseV3 {
  const responseBytes = new Uint8Array([0x41, 0x42, 0x43]);
  const responseHash = Uint8Array.from(Buffer.from(
    digest(responseBytes),
    "hex",
  ));
  return {
    formatVersion: 3,
    kind: "runtime",
    requestId: record.snapshot.requestId,
    descriptorHash: Uint8Array.from(Buffer.from(
      record.snapshot.descriptorDigest!,
      "hex",
    )),
    descriptorBytes: record.descriptorBytes!,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: record.snapshot.recipient!.recipientKeyId,
    recipientPublicKey: Uint8Array.from(Buffer.from(
      record.snapshot.recipient!.recipientPublicKey,
      "base64url",
    )),
    workId: record.snapshot.workId,
    workKind: record.workKind,
    purpose: record.purpose,
    authoritySet: record.authoritySet,
    responseBytes,
    responseHash,
    authorizationId: "task_runtime_authorization_v3",
    authorizationHash: responseHash.slice(),
    issuingHumanId: "task_runtime_human",
    issuingDeviceId: "task_runtime_device",
    issuingDeviceAuthorizationRevision: 11,
    issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x44),
    issuedAt: START,
    expiresAt: record.snapshot.recipient!.expiresAt,
  };
}

function verifiedTaskRuntimeResponseV4(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): BackgroundAuthorizationVerifiedRuntimeResponseV4 {
  const authorizationBytes = new Uint8Array([0x51, 0x52, 0x53, 0x54]);
  const certificateBytes = new Uint8Array([0x61, 0x62, 0x63]);
  const responseBytes = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
    authorizationBytes,
    certificateBytes,
  });
  return {
    ...verifiedTaskRuntimeResponseV3(record),
    formatVersion: 4,
    responseBytes,
    responseHash: Uint8Array.from(Buffer.from(digest(responseBytes), "hex")),
    authorizationBytes,
    authorizationHash: Uint8Array.from(Buffer.from(
      digest(authorizationBytes),
      "hex",
    )),
    certificateBytes,
  };
}

function initialRecord(
  requestId = "request_1",
  workIdentityFill = 1,
): BackgroundAuthorizationRecord {
  const workIdentityHash = new Uint8Array(32);
  new DataView(workIdentityHash.buffer).setUint32(0, workIdentityFill);
  return {
    snapshot: createBackgroundAuthorizationRequest({
      requestId,
      workId: `work_${requestId}`,
      namespaceId: "namespace_room_1",
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: 7,
      },
      now: START,
    }),
    workIdentityHash,
    idempotencyKey: `idempotency_${requestId}`,
    workKind: "stenographer.extraction",
    purpose: "journal.extract",
    domainId: "domain_alice_bob",
    processorAuthorizationRevision: 7,
    expectedDomainEpoch: 9,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 3,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  };
}

function withRecipient(
  record: BackgroundAuthorizationRecord,
  descriptorBytes = new Uint8Array([1, 2, 3]),
): BackgroundAuthorizationRecord {
  return {
    ...record,
    snapshot: attachBackgroundAuthorizationRecipient(record.snapshot, {
      descriptorDigest: digest(descriptorBytes),
      recipientKeyId: `recipient_${record.snapshot.requestId}`,
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      expiresAt: START + 300_000,
      now: START + 1,
    }),
    descriptorBytes,
  };
}

function withResponse(
  record: BackgroundAuthorizationRecord,
  device: string,
): BackgroundAuthorizationRecord {
  const responseBytes = new TextEncoder().encode(`response:${device}`);
  return {
    ...record,
    snapshot: markBackgroundAuthorizationGrantReady(record.snapshot, {
      kind: "processor",
      requestId: record.snapshot.requestId,
      descriptorDigest: record.snapshot.descriptorDigest!,
      recipientKeyId: record.snapshot.recipient!.recipientKeyId,
      recipientPublicKey: record.snapshot.recipient!.recipientPublicKey,
      expiresAt: record.snapshot.recipient!.expiresAt,
      responseDigest: digest(responseBytes),
      credentialDigest: digest(
        new TextEncoder().encode(`credential:${device}`),
      ),
      issuingHumanId: "human_alice",
      issuingDeviceId: device,
      recipientGeneration: record.snapshot.recipientGeneration,
      now: START + 2,
    }),
    acceptedMaterial: {
      responseBytes,
      credentialId: `credential_${device}`,
      issuingDeviceAuthorizationRevision: 11,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x33),
      authorizationExpiresAt: START + 300_000,
    },
  };
}

function verifiedResponse(
  device = "device_alice",
  record = withRecipient(initialRecord()),
): VerifiedProcessorBackgroundAuthorizationDeviceResponse {
  const responseBytes = new TextEncoder().encode(`response:${device}`);
  const credentialHash = new Uint8Array(32).fill(
    device === "device_alice" ? 0x44 : 0x45,
  );
  return {
    kind: "processor",
    requestId: record.snapshot.requestId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: record.snapshot.recipient!.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(0x42),
    descriptorHash: Uint8Array.from(
      Buffer.from(record.snapshot.descriptorDigest!, "hex"),
    ),
    workId: record.snapshot.workId,
    workKind: record.workKind,
    purpose: record.purpose,
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: 7,
    },
    responseHash: Uint8Array.from(
      Buffer.from(digest(responseBytes), "hex"),
    ),
    responseBytes,
    credentialId: `credential_${device}`,
    credentialHash,
    issuingHumanId: "human_alice",
    issuingDeviceId: device,
    issuingDeviceAuthorizationRevision: 11 as never,
    issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x33),
    namespaceId: record.snapshot.namespaceId,
    domainId: record.domainId,
    domainEpoch: record.expectedDomainEpoch!,
    namespaceAccessRevision: record.expectedNamespaceAccessRevision,
    policyRevision: record.expectedPolicyRevision,
    issuedAt: START,
    notBefore: START,
    expiresAt: START + 300_000,
    signerAuthorization: {
      authorizationId: `authorization_${device}`,
      processorKind: "stenographer",
      processorVersion: 1,
      workId: record.snapshot.workId,
      namespaceId: record.snapshot.namespaceId,
      domainId: record.domainId,
      domainEpoch: record.expectedDomainEpoch!,
      namespaceAccessRevision: record.expectedNamespaceAccessRevision,
      policyRevision: record.expectedPolicyRevision,
      processorAuthorizationRevision: record.processorAuthorizationRevision!,
      issuingHumanId: "human_alice",
      issuingDeviceId: device,
      issuingDeviceAuthorizationRevision: 11,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x33),
      signerKeyId: `signer_${device}`,
      signerPublicKey: new Uint8Array(32).fill(0x55),
      authorizationHash: new Uint8Array(32).fill(
        device === "device_alice" ? 0x66 : 0x67,
      ),
      credentialHash,
      authorizationBytes: new Uint8Array([0x77]),
      issuedAt: START,
      expiresAt: START + 300_000,
    },
  };
}

function initialAgentRecord(): BackgroundAuthorizationRecord {
  const base = initialRecord();
  return {
    ...base,
    snapshot: createBackgroundAuthorizationRequest({
      requestId: "request_agent",
      workId: "work_agent",
      namespaceId: "namespace_room_1",
      credentialSubject: {
        kind: "agent",
        agentId: "agent_genie",
        runtimeGeneration: 12,
        authorizationRevision: 13,
      },
      now: START,
    }),
    workIdentityHash: new Uint8Array(32).fill(0x71),
    idempotencyKey: "idempotency_agent",
    workKind: "memory.review",
    purpose: "memory.review",
    processorAuthorizationRevision: null,
  };
}

function initialAgentRecordV2(): BackgroundAuthorizationAgentRecordV2 {
  return {
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId: "request_agent_v2",
      workId: "work_agent_v2",
      namespaceId: "namespace_a",
      credentialSubject: {
        kind: "agent",
        agentId: "agent_genie",
        runtimeGeneration: 12,
        authorizationRevision: 31,
      },
      now: START,
    }),
    workIdentityHash: new Uint8Array(32).fill(0x73),
    idempotencyKey: "idempotency_agent_v2",
    workKind: "memory.review",
    purpose: "memory.review",
    domainId: "domain_ab",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 9,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 3,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
    authoritySet: {
      namespaceRequirements: [
        {
          ordinal: 0,
          namespaceId: "namespace_a",
          domainId: "domain_ab",
          operations: ["decrypt"],
          expectedAccessRevision: 4,
          expectedPolicyRevision: 3,
        },
        {
          ordinal: 1,
          namespaceId: "namespace_b",
          domainId: "domain_bc",
          operations: ["decrypt", "encrypt"],
          expectedAccessRevision: 7,
          expectedPolicyRevision: 8,
        },
      ],
      domainRequirements: [
        {
          ordinal: 0,
          domainId: "domain_ab",
          expectedEpoch: 9,
          expectedAgentAuthorizationRevision: 17,
        },
        {
          ordinal: 1,
          domainId: "domain_bc",
          expectedEpoch: 10,
          expectedAgentAuthorizationRevision: 23,
        },
      ],
    },
  };
}

function verifiedAgentResponse(
  record: BackgroundAuthorizationRecord,
): VerifiedAgentBackgroundAuthorizationDeviceResponse {
  const responseBytes = new Uint8Array([8, 9]);
  return {
    kind: "agent",
    requestId: record.snapshot.requestId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: record.snapshot.recipient!.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(0x42),
    descriptorHash: Uint8Array.from(
      Buffer.from(record.snapshot.descriptorDigest!, "hex"),
    ),
    workId: record.snapshot.workId,
    workKind: record.workKind,
    purpose: record.purpose,
    subject: {
      kind: "agent",
      agentId: "agent_genie",
      runtimeGeneration: 12,
      authorizationRevision: 13,
    },
    responseHash: Uint8Array.from(Buffer.from(digest(responseBytes), "hex")),
    responseBytes,
    credentialId: "grant_agent",
    credentialHash: new Uint8Array(32).fill(0x72),
    issuingHumanId: "human_alice",
    issuingDeviceId: "device_alice",
    issuingDeviceAuthorizationRevision: 11 as never,
    issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x33),
    namespaceId: record.snapshot.namespaceId,
    domainId: record.domainId,
    domainEpoch: record.expectedDomainEpoch!,
    namespaceAccessRevision: record.expectedNamespaceAccessRevision,
    policyRevision: record.expectedPolicyRevision,
    issuedAt: START,
    notBefore: START,
    expiresAt: record.snapshot.recipient!.expiresAt,
  };
}

function verifiedAgentResponseV2(
  record: BackgroundAuthorizationAgentRecordV2,
): VerifiedAgentBackgroundAuthorizationDeviceResponseV2 {
  const responseBytes = new Uint8Array([10, 11, 12]);
  return {
    formatVersion: 2,
    kind: "agent",
    requestId: record.snapshot.requestId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: record.snapshot.recipient!.recipientKeyId,
    recipientPublicKey: new Uint8Array(65).fill(0x42),
    descriptorHash: Uint8Array.from(
      Buffer.from(record.snapshot.descriptorDigest!, "hex"),
    ),
    workId: record.snapshot.workId,
    workKind: record.workKind,
    purpose: record.purpose,
    responseHash: Uint8Array.from(Buffer.from(digest(responseBytes), "hex")),
    responseBytes,
    credentialId: "grant_agent_v2",
    credentialHash: new Uint8Array(32).fill(0x74),
    issuingHumanId: "human_alice",
    issuingDeviceId: "device_alice",
    issuingDeviceAuthorizationRevision: 11 as never,
    issuerSigningPublicKeyHash: new Uint8Array(32).fill(0x33),
    anchorNamespaceId: record.snapshot.namespaceId,
    anchorDomainId: record.domainId,
    grantScope: ["human_alice"],
    inputBindings: [],
    outputSlots: [],
    namespaceRequirements: record.authoritySet.namespaceRequirements.map(
      ({ ordinal: _ordinal, ...requirement }) => ({
        ...requirement,
        namespaceId: requirement.namespaceId as never,
        domainId: requirement.domainId as never,
        expectedAccessRevision: requirement.expectedAccessRevision as never,
        expectedPolicyRevision: requirement.expectedPolicyRevision as never,
      }),
    ),
    domainRequirements: record.authoritySet.domainRequirements.map(
      ({ ordinal: _ordinal, ...requirement }) => ({
        ...requirement,
        domainId: requirement.domainId as never,
        expectedEpoch: requirement.expectedEpoch as never,
        expectedAgentAuthorizationRevision:
          requirement.expectedAgentAuthorizationRevision as never,
      }),
    ),
    issuedAt: START,
    notBefore: START,
    expiresAt: record.snapshot.recipient!.expiresAt,
    subject: {
      kind: "agent",
      agentId: "agent_genie",
      runtimeGeneration: 12,
      authorizationRevision: 31,
    },
  };
}

describe("background authorization repository contract", () => {
  test.each(["task.deliver_result", "task.delivery_wake"] as const)(
    "%s requires exact Runtime V3 custody and cannot become execution authority", workKind => {
      const record = { ...taskRuntimeRecordV3(), workKind, purpose: workKind };
      expect(parseBackgroundAuthorizationRecord(record)).toMatchObject({ workKind, purpose: workKind });
      expect(isTaskExecutionWorkKind(workKind)).toBe(false);
      expect(() => parseBackgroundAuthorizationRecord({ ...record, purpose: "task.execute" })).toThrow();
      expect(() => parseBackgroundAuthorizationRecord({ ...initialAgentRecordV2(), workKind, purpose: workKind }))
        .toThrow("Runtime custody");
    },
  );
  test("accepts only an exact verified v3 Task Runtime response", async () => {
    const record = taskRuntimeRecordV3();
    expect(parseBackgroundAuthorizationRecord({
      ...record,
      workKind: "task.dispatch",
      purpose: "task.dispatch",
    })).toMatchObject({
      workKind: "task.dispatch",
      purpose: "task.dispatch",
    });
    expect(parseBackgroundAuthorizationRecord({
      ...record,
      workKind: "task.await_reply_resume",
      purpose: "task.await_reply_resume",
    })).toMatchObject({
      workKind: "task.await_reply_resume",
      purpose: "task.await_reply_resume",
    });
    expect(parseBackgroundAuthorizationRecord({
      ...record,
      workKind: "task.approval_resume",
      purpose: "task.approval_resume",
    })).toMatchObject({
      workKind: "task.approval_resume",
      purpose: "task.approval_resume",
    });
    const cancellation = {
      ...record, workKind: "task.cancel_result" as const, purpose: "task.cancel_result" as const,
      authoritySet: { ...record.authoritySet, namespaceRequirements:
        record.authoritySet.namespaceRequirements.map(value => ({ ...value, operations: ["encrypt"] as const })) },
    };
    expect(parseBackgroundAuthorizationRecord(cancellation)).toMatchObject({
      workKind: "task.cancel_result", purpose: "task.cancel_result",
    });
    expect(isTaskExecutionWorkKind("task.cancel_result")).toBe(false);
    const delivery = { ...cancellation, workKind: "task.deliver_message" as const, purpose: "task.deliver_message" as const };
    expect(parseBackgroundAuthorizationRecord(delivery)).toMatchObject({ workKind: "task.deliver_message", purpose: "task.deliver_message" });
    expect(isTaskExecutionWorkKind("task.deliver_message")).toBe(false);
    expect(() => parseBackgroundAuthorizationRecord({ ...delivery, authoritySet: record.authoritySet })).toThrow("write-only");
    expect(() => parseBackgroundAuthorizationRecord({ ...delivery, purpose: "task.execute" })).toThrow();
    expect(() => parseBackgroundAuthorizationRecord({ ...cancellation,
      authoritySet: record.authoritySet,
    })).toThrow("write-only");
    expect(() => parseBackgroundAuthorizationRecord({ ...cancellation,
      purpose: "task.execute",
    })).toThrow();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    expect((await repository.create(record)).status).toBe("created");

    const response = verifiedTaskRuntimeResponseV3(record);
    const accepted = await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    });
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("expected acceptance");
    expect(accepted.record.snapshot).toMatchObject({
      formatVersion: 3,
      workId: record.snapshot.workId,
      state: "grant_ready",
      acceptedResponse: {
        kind: "runtime",
        recipientGeneration: 0,
      },
    });
    expect(accepted.record.acceptedMaterial).toMatchObject({
      credentialId: response.authorizationId,
      authorizationExpiresAt: response.expiresAt,
    });
    expect((await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 3,
    })).status).toBe("duplicate");

    const other = taskRuntimeRecordV3();
    expect(() => buildAcceptedBackgroundAuthorizationResponse(
      other,
      {
        ...verifiedTaskRuntimeResponseV3(other),
        recipientGeneration: 1,
      },
      START + 2,
    )).toThrow("does not match current durable authorization");
    expect(() => buildAcceptedBackgroundAuthorizationResponse(
      other,
      {
        ...verifiedTaskRuntimeResponseV3(other),
        authoritySet: {
          ...other.authoritySet,
          domainRequirements: [{
            ...other.authoritySet.domainRequirements[0]!,
            expectedAuthorizationRevision: 8,
          }],
        },
      },
      START + 2,
    )).toThrow("does not match current durable authorization");
  });

  test.each(["task.execute", "task.approval_resume", "task.await_reply_resume"] as const)(
    "accepts an exact verified v4 %s response with split durable digests", async workKind => {
    const record = { ...taskRuntimeRecordV3(), workKind, purpose: workKind };
    const response = verifiedTaskRuntimeResponseV4(record);
    const expectedResponseBytes = response.responseBytes.slice();
    const repository = new InMemoryBackgroundAuthorizationRepository();
    expect((await repository.create(record)).status).toBe("created");

    const accepted = await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    });
    expect(accepted.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("expected acceptance");
    expect(accepted.record.snapshot.acceptedResponse).toMatchObject({
      responseDigest: digest(response.responseBytes),
      credentialDigest: digest(response.authorizationBytes),
    });
    expect(accepted.record.snapshot.acceptedResponse?.responseDigest)
      .not.toBe(accepted.record.snapshot.acceptedResponse?.credentialDigest);
    expect(accepted.record.acceptedMaterial?.responseBytes)
      .toEqual(expectedResponseBytes);
    expect(accepted.record.acceptedMaterial?.responseBytes)
      .not.toBe(response.responseBytes);
    expect((await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 3,
    })).status).toBe("duplicate");

    response.responseBytes.fill(0);
    response.authorizationBytes.fill(0);
    response.certificateBytes.fill(0);
    expect(accepted.record.acceptedMaterial?.responseBytes)
      .toEqual(expectedResponseBytes);
    expect(parseBackgroundAuthorizationRecord(accepted.record).acceptedMaterial
      ?.responseBytes).toEqual(expectedResponseBytes);
  });

  test.each([
    "task.cancel_result",
    "task.deliver_message",
    "task.deliver_result",
    "task.delivery_wake",
  ] as const)(
    "accepts and round-trips an exact verified v4 %s publication response",
    async workKind => {
      const record = taskRuntimePublicationRecordV3(workKind);
      const response = verifiedTaskRuntimeResponseV4(record);
      const expectedResponseBytes = response.responseBytes.slice();
      const repository = new InMemoryBackgroundAuthorizationRepository();
      expect((await repository.create(record)).status).toBe("created");

      const accepted = await repository.acceptVerifiedResponse({
        response,
        acceptedAt: START + 2,
      });
      expect(accepted.status).toBe("accepted");
      if (accepted.status !== "accepted") throw new Error("expected acceptance");
      expect(accepted.record).toMatchObject({ workKind, purpose: workKind });
      expect(accepted.record.snapshot.acceptedResponse).toMatchObject({
        responseDigest: digest(response.responseBytes),
        credentialDigest: digest(response.authorizationBytes),
      });
      expect(accepted.record.acceptedMaterial?.responseBytes)
        .toEqual(expectedResponseBytes);
      expect(parseBackgroundAuthorizationRecord(accepted.record).acceptedMaterial
        ?.responseBytes).toEqual(expectedResponseBytes);
      expect((await repository.acceptVerifiedResponse({
        response,
        acceptedAt: START + 3,
      })).status).toBe("duplicate");
    },
  );

  test("rejects mismatched or stale verified v4 Task execute responses", () => {
    const record = taskRuntimeRecordV3();
    const response = verifiedTaskRuntimeResponseV4(record);
    const alternateAuthorization = new Uint8Array([0x71]);
    const alternateCertificate = new Uint8Array([0x72]);
    const alternateWrapper = encodeTaskRuntimeBackgroundAuthorizationResponseV2({
      authorizationBytes: alternateAuthorization,
      certificateBytes: response.certificateBytes,
    });
    const reject = (
      candidate: BackgroundAuthorizationVerifiedRuntimeResponseV4,
      acceptedAt = START + 2,
      candidateRecord = record,
    ) => expect(() => buildAcceptedBackgroundAuthorizationResponse(
      candidateRecord,
      candidate,
      acceptedAt,
    )).toThrow("does not match current durable authorization");

    reject({
      ...response,
      responseBytes: alternateWrapper,
      responseHash: Uint8Array.from(Buffer.from(digest(alternateWrapper), "hex")),
    });
    reject({ ...response, authorizationBytes: alternateAuthorization });
    reject({ ...response, certificateBytes: alternateCertificate });
    reject({ ...response, responseHash: new Uint8Array(32).fill(0x73) });
    reject({ ...response, authorizationHash: new Uint8Array(32).fill(0x74) });
    reject({ ...response, descriptorBytes: new Uint8Array([0x75]) });
    reject(response, response.expiresAt);

    reject({ ...response, workKind: "task.approval_resume", purpose: "task.approval_resume" });
    reject({ ...response, purpose: "task.approval_resume" });
    for (const workKind of ["task.dispatch"] as const) {
      const excluded = {
        ...record,
        workKind,
        purpose: workKind,
      };
      expect(parseBackgroundAuthorizationRecord(excluded).workKind).toBe(workKind);
      reject(verifiedTaskRuntimeResponseV4(excluded), START + 2, excluded);
    }
  });

  test.each(["task.execute", "task.approval_resume", "task.await_reply_resume"] as const)(
    "gives exactly one winner to Task inventory replacement versus claim (%s)", async workKind => {
    const waiting = { ...taskRuntimeRecordV3(), workKind, purpose: workKind };
    const response = verifiedTaskRuntimeResponseV3(waiting);
    const replacement: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...waiting,
      snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
        requestId: waiting.snapshot.requestId,
        workId: waiting.snapshot.workId,
        namespaceId: waiting.snapshot.namespaceId,
        now: START + 3,
      }),
      workIdentityHash: new Uint8Array(32).fill(0x76),
      descriptorBytes: null,
      acceptedMaterial: null,
      authoritySet: {
        ...waiting.authoritySet,
        namespaceRequirements: [
          ...waiting.authoritySet.namespaceRequirements,
          {
            ordinal: 1,
            namespaceId: "z_scope_inventory_namespace",
            domainId: waiting.domainId,
            operations: ["decrypt"],
            expectedAccessRevision: 8,
            expectedPolicyRevision: waiting.expectedPolicyRevision,
          },
        ],
      },
    };
    const readyRepository = async () => {
      const repository = new InMemoryBackgroundAuthorizationRepository();
      await repository.create(waiting);
      const accepted = await repository.acceptVerifiedResponse({
        response,
        acceptedAt: START + 2,
      });
      if (accepted.status !== "accepted") throw new Error("grant not ready");
      return {
        repository,
        ready: accepted.record as BackgroundAuthorizationTaskRuntimeRecordV3,
      };
    };

    const claimFirst = await readyRepository();
    const claimed = {
      ...claimFirst.ready,
      snapshot: claimBackgroundAuthorizationRequest(
        claimFirst.ready.snapshot,
        "inventory-race-claim",
        START + 3,
        START + 30_000,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    expect((await claimFirst.repository.compareAndSwap({
      expectedRequestRevision: claimFirst.ready.snapshot.requestRevision,
      next: claimed,
    })).status).toBe("updated");
    const lostReplacement = await claimFirst.repository
      .replaceUnclaimedTaskRuntimeAuthority({
        expected: claimFirst.ready,
        replacement,
        now: START + 3,
      });
    expect(lostReplacement).toMatchObject({
      status: "stale",
      current: { snapshot: { state: "claimed" } },
    });

    const replacementFirst = await readyRepository();
    const wonReplacement = await replacementFirst.repository
      .replaceUnclaimedTaskRuntimeAuthority({
        expected: replacementFirst.ready,
        replacement,
        now: START + 3,
      });
    expect(wonReplacement).toMatchObject({
      status: "replaced",
      record: {
        snapshot: {
          state: "awaiting_recipient",
          recipientGeneration: 1,
          requestRevision: replacementFirst.ready.snapshot.requestRevision + 1,
        },
        descriptorBytes: null,
        acceptedMaterial: null,
      },
    });
    expect((await replacementFirst.repository.compareAndSwap({
      expectedRequestRevision: replacementFirst.ready.snapshot.requestRevision,
      next: {
        ...replacementFirst.ready,
        snapshot: claimBackgroundAuthorizationRequest(
          replacementFirst.ready.snapshot,
          "inventory-race-losing-claim",
          START + 3,
          START + 30_000,
        ),
      },
    })).status).toBe("stale");
  });

  test.each(["task.execute", "task.approval_resume", "task.await_reply_resume"] as const)(
    "defers an exact unstarted Task request once without spending its retry budget (%s)", async workKind => {
    const waiting = { ...taskRuntimeRecordV3(), workKind, purpose: workKind };
    const accepted = buildAcceptedBackgroundAuthorizationResponse(
      waiting,
      verifiedTaskRuntimeResponseV3(waiting),
      START + 2,
    ).next as BackgroundAuthorizationTaskRuntimeRecordV3;
    const claimed: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...accepted,
      snapshot: {
        ...claimBackgroundAuthorizationRequest(
          accepted.snapshot,
          "task-runtime-deferral-claim",
          START + 3,
          START + 30_000,
        ),
        retryCount: BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
        lastRetryReason: "provider_transient_failure",
      } as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const running: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...claimed,
      snapshot: markBackgroundAuthorizationRunning(
        claimed.snapshot,
        START + 4,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const next = buildDeferredUnstartedTaskRuntimeRequest({
      expected: running,
      now: START + 5,
    });
    expect(next).toMatchObject({
      snapshot: {
        state: "awaiting_recipient",
        recipientGeneration: running.snapshot.recipientGeneration + 1,
        requestRevision: running.snapshot.requestRevision + 1,
        descriptorDigest: null,
        recipient: null,
        acceptedResponse: null,
        claimId: null,
        claimExpiresAt: null,
        retryCount: BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
        lastRetryReason: "stale_authority",
        nextAttemptAt: START + 5,
      },
      descriptorBytes: null,
      acceptedMaterial: null,
    });

    const repository = new InMemoryBackgroundAuthorizationRepository();
    expect((await repository.create(running)).status).toBe("created");
    expect(await repository.deferUnstartedTaskRuntimeRequest({
      expected: running,
      now: START + 5,
    })).toEqual({ status: "deferred", record: next });
    expect(await repository.deferUnstartedTaskRuntimeRequest({
      expected: running,
      now: START + 5,
    })).toEqual({ status: "exact_replay", record: next });
    expect(await repository.deferUnstartedTaskRuntimeRequest({
      expected: running,
      now: START + 6,
    })).toEqual({ status: "stale", current: next });
  });

  test("refuses an unversioned Task identity at the replacement boundary", () => {
    const expected = {
      ...taskRuntimeRecordV3(),
      idempotencyKey: "legacy-task-runtime-request",
    };
    const replacement = {
      ...expected,
      snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
        requestId: expected.snapshot.requestId,
        workId: expected.snapshot.workId,
        namespaceId: expected.snapshot.namespaceId,
        now: START + 3,
      }),
      descriptorBytes: null,
    };
    expect(() => buildUnclaimedTaskRuntimeAuthorityReplacement({
      expected,
      replacement,
      now: START + 3,
    })).toThrow("changed stable work identity");
  });

  test("accepts only the exact semantic Reflection V2 work-purpose pairs", () => {
    const pairs = [
      ["reflection.search_projection", "record.search_projection"],
      ["reflection.organization", "record.organize"],
      ["reflection.dependency_rewrite", "record.dependency_rewrite"],
    ] as const;

    const semanticRecord = (
      workKind: (typeof pairs)[number][0],
      purpose: (typeof pairs)[number][1],
      ordinal: number,
    ): BackgroundAuthorizationRecord => ({
      snapshot: createBackgroundAuthorizationRequestV2({
        requestId: `request_semantic_${ordinal}`,
        workId: `work_semantic_${ordinal}`,
        namespaceId: "namespace_room_1",
        credentialSubject: {
          kind: "processor",
          processorKind: "reflection",
          processorVersion: 1,
        },
        now: START,
      }),
      workIdentityHash: new Uint8Array(32).fill(ordinal + 1),
      idempotencyKey: `idempotency_semantic_${ordinal}`,
      workKind,
      purpose,
      domainId: "domain_alice_bob",
      processorAuthorizationRevision: null,
      expectedDomainEpoch: null,
      expectedNamespaceAccessRevision: 4,
      expectedPolicyRevision: 3,
      descriptorBytes: null,
      acceptedMaterial: null,
      finishedAt: null,
    });

    for (const [ordinal, [workKind, purpose]] of pairs.entries()) {
      expect(parseBackgroundAuthorizationRecord(
        semanticRecord(workKind, purpose, ordinal),
      )).toMatchObject({ workKind, purpose });
    }
    expect(() => parseBackgroundAuthorizationRecord(
      semanticRecord(
        "reflection.search_projection",
        "record.dependency_rewrite",
        pairs.length,
      ),
    )).toThrow("Invalid background work kind/purpose");
  });

  test("keeps durable carrier limits in parity without widening legacy formats", () => {
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor)).toBe(
      MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.processorResponse)).toBe(
      MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS.processor)).toBe(
      MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.runtimeResponse)).toBe(
      MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS.runtime)).toBe(
      MAX_TASK_RUNTIME_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyRuntimeResponse).toBe(
      DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
    );
    expect(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor).toBe(
      MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
    );
    expect(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyDescriptor).toBeLessThan(
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor,
    );
    expect(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.agentResponse).toBe(
      16 * 1_024 * 1_024 + 128 * 1_024 + 4 * 1_024,
    );
  });

  test("stores one exact canonical v2 authority set without changing v1 records", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const v1 = initialAgentRecord();
    const v2 = initialAgentRecordV2();

    expect((await repository.create(v1)).record).not.toHaveProperty(
      "authoritySet",
    );
    expect((await repository.create(v2)).record).toEqual(v2);
    expect((await repository.create(v2)).status).toBe("existing");

    const changedAuthority = {
      ...v2,
      authoritySet: {
        ...v2.authoritySet,
        namespaceRequirements: v2.authoritySet.namespaceRequirements.map(
          (requirement, index) => index === 0
            ? requirement
            : { ...requirement, expectedPolicyRevision: 9 },
        ),
      },
    } satisfies BackgroundAuthorizationAgentRecordV2;
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.create(changedAuthority)).rejects.toEqual(
      new BackgroundAuthorizationRepositoryConflictError("create_conflict"),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: {
        ...changedAuthority,
        snapshot: attachBackgroundAuthorizationRecipient(v2.snapshot, {
          descriptorDigest: digest(new Uint8Array([1, 2, 3])),
          recipientKeyId: "recipient_agent_v2",
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          expiresAt: START + 300_000,
          now: START + 1,
        }),
        descriptorBytes: new Uint8Array([1, 2, 3]),
      },
    })).rejects.toThrow("CAS cannot change immutable work authority");

    for (const [index, authoritySet] of [
      {
        ...v2.authoritySet,
        namespaceRequirements: [...v2.authoritySet.namespaceRequirements]
          .reverse(),
      },
      {
        ...v2.authoritySet,
        domainRequirements: v2.authoritySet.domainRequirements.slice(0, 1),
      },
      {
        ...v2.authoritySet,
        namespaceRequirements: [
          ...v2.authoritySet.namespaceRequirements,
          {
            ...v2.authoritySet.namespaceRequirements[1]!,
            ordinal: 2,
            namespaceId: "namespace_c",
            domainId: "domain_extra",
          },
        ],
      },
    ].entries()) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(repository.create({
        ...v2,
        snapshot: {
          ...v2.snapshot,
          requestId: `bad_${index}`,
        },
        idempotencyKey: `bad_${index}`,
        authoritySet,
      } as BackgroundAuthorizationAgentRecordV2)).rejects.toThrow(TypeError);
    }
  });

  test("create is an exact idempotent replay and rejects identity collisions", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const record = initialRecord();

    expect((await repository.create(record)).status).toBe("created");
    expect((await repository.create(record)).status).toBe("existing");

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.create({
      ...initialRecord("request_conflict", 1),
      idempotencyKey: record.idempotencyKey,
    })).rejects.toEqual(
      new BackgroundAuthorizationRepositoryConflictError("create_conflict"),
    );
  });

  test("rejects secret-shaped extension fields and product-policy TTL drift", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.create({
      ...initialRecord(),
      recipientPrivateKey: new Uint8Array(32),
    } as BackgroundAuthorizationRecord)).rejects.toThrow(
      "unknown or missing fields",
    );

    const initial = initialRecord();
    const descriptorBytes = new Uint8Array([1, 2, 3]);
    const excessive = {
      ...initial,
      snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
        descriptorDigest: digest(descriptorBytes),
        recipientKeyId: "recipient_1",
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: START + 300_002,
        now: START + 1,
      }),
      descriptorBytes,
    };
    await repository.create(initial);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: excessive,
    })).rejects.toThrow("Recipient lifetime exceeds product policy");
  });

  test("generic CAS cannot bypass verified response acceptance", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialRecord();
    await repository.create(initial);
    const recipient = withRecipient(initial);
    expect(await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    })).toMatchObject({ status: "updated" });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.compareAndSwap({
      expectedRequestRevision: 1,
      next: withResponse(recipient, "device_alice"),
    })).rejects.toThrow("atomic repository operation");
    expect((await repository.get("request_1"))?.snapshot.state).toBe(
      "awaiting_device",
    );
  });

  test("verified processor acceptance atomically selects one response and its signer evidence", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialRecord();
    const recipient = withRecipient(initial);
    await repository.create(initial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });

    const alice = verifiedResponse("device_alice");
    const bob = verifiedResponse("device_bob");
    const results = await Promise.all([
      repository.acceptVerifiedResponse({
        response: alice,
        acceptedAt: START + 2,
      }),
      repository.acceptVerifiedResponse({
        response: bob,
        acceptedAt: START + 2,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "accepted",
      "lost",
    ]);
    expect(await repository.acceptVerifiedResponse({
      response: alice,
      acceptedAt: START + 3,
    })).toMatchObject({ status: "duplicate" });
  });

  test("acceptance cross-checks every duplicated descriptor authority coordinate", () => {
    const current = withRecipient(initialRecord());
    const valid = verifiedResponse();
    const mutations: readonly [
      string,
      VerifiedProcessorBackgroundAuthorizationDeviceResponse,
    ][] = [
      ["request", { ...valid, requestId: "request_other" }],
      ["work", { ...valid, workId: "work_other" }],
      ["kind", { ...valid, workKind: "stenographer.rebuild" }],
      ["purpose", { ...valid, purpose: "journal.rebuild" }],
      ["Namespace", { ...valid, namespaceId: "namespace_other" }],
      ["Domain", { ...valid, domainId: "domain_other" }],
      ["epoch", { ...valid, domainEpoch: 10 }],
      ["access revision", { ...valid, namespaceAccessRevision: 5 }],
      ["policy revision", { ...valid, policyRevision: 4 }],
      ["generation", { ...valid, recipientGeneration: 1 }],
      ["recipient id", { ...valid, recipientKeyId: "recipient_other" }],
      ["recipient key", {
        ...valid,
        recipientPublicKey: new Uint8Array(65).fill(0x43),
      }],
      ["descriptor digest", {
        ...valid,
        descriptorHash: new Uint8Array(32).fill(0x44),
      }],
      ["processor revision", {
        ...valid,
        subject: { ...valid.subject, authorizationRevision: 8 },
      }],
    ];
    for (const [label, response] of mutations) {
      expect(() =>
        buildAcceptedBackgroundAuthorizationResponse(
          current,
          response,
          START + 2,
        )
      ).toThrow(`Verified response does not match current durable authorization`);
      expect(label.length).toBeGreaterThan(0);
    }
    expect(() =>
      buildAcceptedBackgroundAuthorizationResponse(
        current,
        {
          ...valid,
          signerAuthorization: {
            ...valid.signerAuthorization,
            expiresAt: START + 300_001,
          },
        },
        START + 2,
      )
    ).toThrow("signer evidence");
  });

  test("Agent acceptance binds Agent identity/generation/revision without signer evidence", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialAgentRecord();
    const recipient = withRecipient(initial);
    const valid = verifiedAgentResponse(recipient);
    for (const subject of [
      { ...valid.subject, agentId: "agent_other" },
      { ...valid.subject, runtimeGeneration: 14 },
      { ...valid.subject, authorizationRevision: 15 },
    ]) {
      expect(() =>
        buildAcceptedBackgroundAuthorizationResponse(
          recipient,
          { ...valid, subject },
          START + 2,
        )
      ).toThrow("does not match current durable authorization");
    }
    await repository.create(initial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });
    expect(await repository.acceptVerifiedResponse({
      response: valid,
      acceptedAt: START + 2,
    })).toMatchObject({ status: "accepted" });
  });

  test("acceptance rejects unknown versioned responses instead of treating them as legacy v1", () => {
    const legacyWaiting = withRecipient(initialAgentRecord());
    const legacy = verifiedAgentResponse(legacyWaiting);
    expect(() => buildAcceptedBackgroundAuthorizationResponse(
      legacyWaiting,
      { ...legacy, formatVersion: 3 } as unknown as typeof legacy,
      START + 2,
    )).toThrow("Unsupported verified response format or subject kind");

    const v2Initial = initialAgentRecordV2();
    const descriptorBytes = new Uint8Array([1, 2, 3]);
    const v2Waiting = {
      ...v2Initial,
      snapshot: attachBackgroundAuthorizationRecipient(v2Initial.snapshot, {
        descriptorDigest: digest(descriptorBytes),
        recipientKeyId: "recipient_agent_v2",
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: START + 300_000,
        now: START + 1,
      }),
      descriptorBytes,
    } as BackgroundAuthorizationAgentRecordV2;
    const v2 = verifiedAgentResponseV2(v2Waiting);
    expect(() => buildAcceptedBackgroundAuthorizationResponse(
      v2Waiting,
      { ...v2, kind: "unknown" } as unknown as typeof v2,
      START + 2,
    )).toThrow("Unsupported verified response format or subject kind");
  });

  test("Agent v2 acceptance requires the exact complete durable authority set", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialAgentRecordV2();
    const descriptorBytes = new Uint8Array([1, 2, 3]);
    const waiting = {
      ...initial,
      snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
        descriptorDigest: digest(descriptorBytes),
        recipientKeyId: "recipient_agent_v2",
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: START + 300_000,
        now: START + 1,
      }),
      descriptorBytes,
    } as BackgroundAuthorizationAgentRecordV2;
    await repository.create(initial);
    await repository.compareAndSwap({ expectedRequestRevision: 0, next: waiting });
    const response = verifiedAgentResponseV2(waiting);

    expect(await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    })).toMatchObject({
      status: "accepted",
      record: { snapshot: { state: "grant_ready", formatVersion: 2 } },
    });

    const secondRepository = new InMemoryBackgroundAuthorizationRepository();
    await secondRepository.create(initial);
    await secondRepository.compareAndSwap({
      expectedRequestRevision: 0,
      next: waiting,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(secondRepository.acceptVerifiedResponse({
      response: {
        ...response,
        domainRequirements: response.domainRequirements.slice(0, 1),
      },
      acceptedAt: START + 2,
    })).rejects.toThrow(
      "Verified response does not match current durable authorization",
    );
  });

  test("Agent v2 reuses restart, duplicate-response, claim, and completion semantics", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialAgentRecordV2();
    const descriptorBytes = new Uint8Array([4, 5, 6]);
    const waiting = {
      ...initial,
      snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
        descriptorDigest: digest(descriptorBytes),
        recipientKeyId: "recipient_agent_v2_restart",
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: START + 300_000,
        now: START + 1,
      }),
      descriptorBytes,
    } as BackgroundAuthorizationAgentRecordV2;
    await repository.create(initial);
    expect((await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: waiting,
    })).status).toBe("updated");

    const response = verifiedAgentResponseV2(waiting);
    const accepted = await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    });
    expect(accepted.status).toBe("accepted");
    expect((await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 3,
    })).status).toBe("duplicate");

    const restarted = await repository.get(initial.snapshot.requestId);
    if (restarted === null) throw new Error("v2 request disappeared");
    expect(restarted).toHaveProperty("authoritySet", initial.authoritySet);
    const claimed = {
      ...restarted,
      snapshot: claimBackgroundAuthorizationRequest(
        restarted.snapshot,
        "claim_agent_v2_restart",
        START + 4,
        START + 60_000,
      ),
    } as BackgroundAuthorizationAgentRecordV2;
    const running = {
      ...claimed,
      snapshot: markBackgroundAuthorizationRunning(
        claimed.snapshot,
        START + 5,
      ),
    } as BackgroundAuthorizationAgentRecordV2;
    const completed = {
      ...running,
      snapshot: completeBackgroundAuthorizationRequest(
        running.snapshot,
        START + 6,
      ),
      finishedAt: START + 6,
    } as BackgroundAuthorizationAgentRecordV2;
    for (const next of [claimed, running, completed]) {
      expect((await repository.compareAndSwap({
        expectedRequestRevision: next.snapshot.requestRevision - 1,
        next,
      })).status).toBe("updated");
    }
    expect((await repository.get(initial.snapshot.requestId))).toMatchObject({
      snapshot: { formatVersion: 2, state: "completed" },
      authoritySet: initial.authoritySet,
    });
  });

  test("Stenographer acceptance retains its narrower response wire ceiling", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialRecord();
    const recipient = withRecipient(initial);
    await repository.create(initial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });
    const response = verifiedResponse();
    const responseBytes = new Uint8Array(
      BACKGROUND_AUTHORIZATION_BYTE_LIMITS.legacyProcessorResponse + 1,
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.acceptVerifiedResponse({
      response: {
        ...response,
        responseBytes,
        responseHash: Uint8Array.from(
          Buffer.from(digest(responseBytes), "hex"),
        ),
      },
      acceptedAt: START + 2,
    })).rejects.toThrow("Background response exceeds its byte boundary");
  });

  test("signer-evidence conflict rolls back processor response acceptance", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const firstInitial = initialRecord();
    const firstRecipient = withRecipient(firstInitial);
    await repository.create(firstInitial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: firstRecipient,
    });
    expect(await repository.acceptVerifiedResponse({
      response: verifiedResponse(),
      acceptedAt: START + 2,
    })).toMatchObject({ status: "accepted" });

    const secondInitial = initialRecord("request_2", 2);
    const secondRecipient = withRecipient(secondInitial);
    await repository.create(secondInitial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: secondRecipient,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.acceptVerifiedResponse({
      response: verifiedResponse("device_alice", secondRecipient),
      acceptedAt: START + 2,
    })).rejects.toEqual(
      new BackgroundAuthorizationRepositoryConflictError(
        "signer_evidence_conflict",
      ),
    );
    expect((await repository.get("request_2"))?.snapshot.state).toBe(
      "awaiting_device",
    );
  });

  test("recipient loss may clear accepted material only while advancing generation", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialRecord();
    const recipient = withRecipient(initial);
    await repository.create(initial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });
    const acceptance = await repository.acceptVerifiedResponse({
      response: verifiedResponse(),
      acceptedAt: START + 2,
    });
    if (acceptance.status !== "accepted") throw new Error("expected acceptance");

    // A same-generation caller cannot strip already accepted authority.
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.compareAndSwap({
      expectedRequestRevision: acceptance.record.snapshot.requestRevision,
      next: {
        ...acceptance.record,
        snapshot: {
          ...acceptance.record.snapshot,
          acceptedResponse: null,
          descriptorDigest: null,
          state: "awaiting_recipient",
          recipient: null,
          requestRevision:
            acceptance.record.snapshot.requestRevision + 1,
          updatedAt: START + 3,
        },
        descriptorBytes: null,
        acceptedMaterial: null,
      },
    })).rejects.toThrow("immutable");

    const retriedSnapshot = advanceBackgroundAuthorizationGeneration(
      acceptance.record.snapshot,
      {
        reason: "recipient_lost",
        now: START + 3,
        nextAttemptAt: START + 4,
      },
    );
    const retry = await repository.compareAndSwap({
      expectedRequestRevision: acceptance.record.snapshot.requestRevision,
      next: {
        ...acceptance.record,
        snapshot: retriedSnapshot,
        descriptorBytes: null,
        acceptedMaterial: null,
      },
    });
    expect(retry).toMatchObject({
      status: "updated",
      record: {
        snapshot: {
          state: "awaiting_recipient",
          recipientGeneration: 1,
          acceptedResponse: null,
        },
        descriptorBytes: null,
        acceptedMaterial: null,
      },
    });
  });

  test("recipient attachment cannot reset execution retries or forge a generation", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialRecord();
    await repository.create(initial);
    const waiting = withRecipient(initial);
    await repository.compareAndSwap({ expectedRequestRevision: 0, next: waiting });
    const retry = {
      ...waiting,
      snapshot: advanceBackgroundAuthorizationGeneration(waiting.snapshot, {
        reason: "provider_transient_failure", now: START + 2, nextAttemptAt: START + 3,
      }),
      descriptorBytes: null,
    };
    await repository.compareAndSwap({ expectedRequestRevision: 1, next: retry });
    const replacement = {
      ...retry,
      descriptorBytes: waiting.descriptorBytes,
      snapshot: attachBackgroundAuthorizationRecipient(retry.snapshot, {
        descriptorDigest: waiting.snapshot.descriptorDigest!,
        recipientGeneration: retry.snapshot.recipientGeneration,
        recipientKeyId: "replacement-recipient",
        recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        expiresAt: START + 300_000,
        now: START + 3,
      }),
    };
    for (const forged of [
      { ...replacement.snapshot, retryCount: 0, lastRetryReason: null },
      { ...replacement.snapshot, recipientGeneration: 2 },
      { ...replacement.snapshot, lastRetryReason: "recipient_lost" as const },
    ]) {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(repository.compareAndSwap({
        expectedRequestRevision: retry.snapshot.requestRevision,
        next: { ...replacement, snapshot: forged },
      })).rejects.toThrow("retry history");
    }
    expect(await repository.get(initial.snapshot.requestId)).toEqual(retry);
    expect((await repository.compareAndSwap({
      expectedRequestRevision: retry.snapshot.requestRevision, next: replacement,
    })).status).toBe("updated");
  });

  test("publication reconciliation can change retry history only through its canonical retry", () => {
    const accepted = withResponse(withRecipient(initialRecord()), "device_1");
    const running = markBackgroundAuthorizationRunning(
      claimBackgroundAuthorizationRequest(accepted.snapshot, "claim_1", START + 3, START + 30_000),
      START + 4,
    );
    const current = {
      ...accepted,
      snapshot: markBackgroundAuthorizationPublicationReconciliation(running, START + 5),
    };
    const next = {
      ...current,
      snapshot: scheduleBackgroundAuthorizationPublicationRetry(current.snapshot, {
        now: START + 6, nextAttemptAt: START + 20,
      }),
    };
    expect(() => assertBackgroundAuthorizationCasSuccessor(
      current, current.snapshot.requestRevision, next,
    )).not.toThrow();
    expect(() => assertBackgroundAuthorizationCasSuccessor(
      current, current.snapshot.requestRevision,
      { ...next, snapshot: { ...next.snapshot, retryCount: 0 } },
    )).toThrow("publication retry history");
  });

  test("stale CAS returns restart-readable current state without overwriting it", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialRecord();
    const recipient = withRecipient(initial);
    await repository.create(initial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });

    const stale = await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });
    expect(stale).toMatchObject({
      status: "stale",
      current: {
        snapshot: { requestRevision: 1, state: "awaiting_device" },
      },
    });
    expect((await repository.get("request_1"))?.snapshot).toEqual(
      recipient.snapshot,
    );
  });

  test("eligible scans are time-aware, deterministic, and bounded", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(initialRecord("request_b", 2));
    await repository.create(initialRecord("request_a", 1));

    const eligible = await repository.listEligible({ now: START, limit: 1 });
    expect(eligible).toHaveLength(1);
    expect(eligible[0]?.snapshot.requestId).toBe("request_a");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.listEligible({
      now: START,
      limit: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH + 1,
    })).rejects.toThrow("Eligible-list limit");
  });

  test("awaiting-device discovery is watermark-frozen and keyset paged", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    let identityFill = 30;
    const awaiting = (
      requestId: string,
      updatedAt: number,
      expiresAt = START + 300_000,
    ) => {
      const initial = initialRecord(requestId, identityFill++);
      const descriptorBytes = new Uint8Array([1, 2, 3]);
      return {
        ...initial,
        snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
          descriptorDigest: digest(descriptorBytes),
          recipientKeyId: `recipient_${requestId}`,
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          expiresAt,
          now: updatedAt,
        }),
        descriptorBytes,
      };
    };
    for (const record of [
      awaiting("request_b", START + 2),
      awaiting("request_a", START + 2),
      awaiting("request_c", START + 3),
      awaiting("request_future", START + 5),
      awaiting("request_expired", START + 1, START + 4),
      initialRecord("request_no_descriptor", 20),
      withResponse(awaiting("request_ready", START + 1), "device_1"),
    ]) await repository.create(record);

    const first = await repository.listAwaitingDevicePage({
      now: START + 4,
      throughUpdatedAt: START + 3,
      limit: 2,
    });
    expect(first.records.map((record) => record.snapshot.requestId)).toEqual([
      "request_a",
      "request_b",
    ]);
    expect(first.continuation).toEqual({
      updatedAt: START + 2,
      requestId: "request_b",
    });

    const last = await repository.listAwaitingDevicePage({
      now: START + 4,
      throughUpdatedAt: START + 3,
      after: first.continuation!,
      limit: 2,
    });
    expect(last.records.map((record) => record.snapshot.requestId)).toEqual([
      "request_c",
    ]);
    expect(last.continuation).toBeNull();
    expect(await repository.listAwaitingDevicePage({
      now: START + 4,
      throughUpdatedAt: START + 3,
      after: { updatedAt: START + 3, requestId: "request_c" },
      limit: 2,
    })).toEqual({ records: [], continuation: null });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(repository.listAwaitingDevicePage({
      now: START,
      throughUpdatedAt: START,
      after: { updatedAt: START + 1, requestId: "request_a" },
      limit: 1,
    })).rejects.toThrow("cursor exceeds watermark");
  });

  test.each(["task.execute", "task.approval_resume", "task.await_reply_resume"] as const)(
    "Task Runtime cancellation discovery includes active and explicitly cancelled records only (%s)", async workKind => {
    const awaitingRecipient = { ...taskRuntimeAwaitingRecipientV3(), workKind, purpose: workKind };
    const awaitingDevice = { ...taskRuntimeRecordV3(), workKind, purpose: workKind };
    const grantReady = buildAcceptedBackgroundAuthorizationResponse(
      awaitingDevice,
      verifiedTaskRuntimeResponseV3(awaitingDevice),
      START + 2,
    ).next as BackgroundAuthorizationTaskRuntimeRecordV3;
    const claimed: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...grantReady,
      snapshot: claimBackgroundAuthorizationRequest(
        grantReady.snapshot,
        "task_runtime_cancellation_claim",
        START + 3,
        START + 60_000,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const running: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...claimed,
      snapshot: markBackgroundAuthorizationRunning(
        claimed.snapshot,
        START + 4,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const publication: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...running,
      snapshot: markBackgroundAuthorizationPublicationReconciliation(
        running.snapshot,
        START + 5,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    };
    const completed: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...running,
      snapshot: completeBackgroundAuthorizationRequest(
        running.snapshot,
        START + 5,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      finishedAt: START + 5,
    };
    const cancelled: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...running,
      snapshot: cancelBackgroundAuthorizationRequest(
        running.snapshot,
        "cancelled",
        START + 5,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      finishedAt: START + 5,
    };
    const superseded: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...awaitingDevice,
      snapshot: cancelBackgroundAuthorizationRequest(
        awaitingDevice.snapshot,
        "superseded",
        START + 5,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      finishedAt: START + 5,
    };
    const failed: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...running,
      snapshot: failBackgroundAuthorizationRequest(
        running.snapshot,
        "integrity_failure",
        START + 5,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      finishedAt: START + 5,
    };
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const included = [
      awaitingRecipient,
      awaitingDevice,
      grantReady,
      claimed,
      running,
      publication,
      cancelled,
    ].map((record, index) =>
      relabelTaskRuntimeRecord(record, index + 1, START + index + 1)
    );
    const excluded = [completed, failed, superseded]
      .map((record, index) =>
        relabelTaskRuntimeRecord(record, index + 10, START + index + 10)
      );
    for (const record of [...included, ...excluded]) {
      await repository.create(record);
    }
    await repository.create(initialRecord("other_kind", 40));

    const first = await repository.listTaskRuntimeCancellationPage({
      throughUpdatedAt: START + 20,
      limit: 3,
    });
    expect(first.candidates.map((candidate) => candidate.requestId)).toEqual([
      "task_runtime_cancellation_1",
      "task_runtime_cancellation_2",
      "task_runtime_cancellation_3",
    ]);
    expect(first.continuation).toEqual({
      updatedAt: START + 3,
      requestId: "task_runtime_cancellation_3",
    });
    const second = await repository.listTaskRuntimeCancellationPage({
      throughUpdatedAt: START + 20,
      after: first.continuation!,
      limit: 4,
    });
    expect(second.candidates.map((candidate) => candidate.requestId)).toEqual([
      "task_runtime_cancellation_4",
      "task_runtime_cancellation_5",
      "task_runtime_cancellation_6",
      "task_runtime_cancellation_7",
    ]);
    expect(second.continuation).toEqual({
      updatedAt: START + 7,
      requestId: "task_runtime_cancellation_7",
    });
    expect(await repository.listTaskRuntimeCancellationPage({
      throughUpdatedAt: START + 6,
      after: { updatedAt: START + 6, requestId: "task_runtime_cancellation_6" },
      limit: 1,
    })).toEqual({ candidates: [], continuation: null });

    const invalidLimit = repository.listTaskRuntimeCancellationPage({
      throughUpdatedAt: START,
      limit: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH + 1,
    });
    const failure = await invalidLimit.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toContain("page limit");
  });

  test("settles every prior Task Runtime execution authority and replays terminal inventory", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const kinds = [
      "task.execute",
      "task.dispatch",
      "task.approval_resume",
      "task.await_reply_resume",
    ] as const;
    const records = kinds.map((kind, index) =>
      settlementTaskRuntimeRecord(index + 1, kind)
    );
    const completedSource = settlementTaskRuntimeRecord(
      5,
      "task.execute",
    );
    const completed = {
      ...completedSource,
      snapshot: completeBackgroundAuthorizationRequest(
        markBackgroundAuthorizationRunning(
          claimBackgroundAuthorizationRequest(
            buildAcceptedBackgroundAuthorizationResponse(
              completedSource,
              verifiedTaskRuntimeResponseV3(completedSource),
              START + 2,
            ).next.snapshot,
            "task_runtime_settlement_claim",
            START + 3,
            START + 30_000,
          ),
          START + 4,
        ),
        START + 5,
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      acceptedMaterial: buildAcceptedBackgroundAuthorizationResponse(
        completedSource,
        verifiedTaskRuntimeResponseV3(completedSource),
        START + 2,
      ).next.acceptedMaterial,
      finishedAt: START + 5,
    } satisfies BackgroundAuthorizationTaskRuntimeRecordV3;
    for (const record of [...records, completed]) await repository.create(record);

    const settled = await repository.settleTaskRuntimeExecutionAuthorities({
      workId: records[0]!.snapshot.workId,
      namespaceId: records[0]!.snapshot.namespaceId,
      now: START + 10,
    });
    expect(settled).toEqual({
      status: "settled",
      transitioned: 4,
      alreadyTerminal: 1,
      recipients: [1, 2, 3, 4, 5].map((ordinal) => ({
        requestId: `task_runtime_settlement_${ordinal}`,
        recipientGeneration: 0,
      })),
    });
    for (const record of records) {
      expect((await repository.get(record.snapshot.requestId))?.snapshot)
        .toMatchObject({ state: "cancelled", terminalReason: "cancelled" });
    }
    expect(await repository.settleTaskRuntimeExecutionAuthorities({
      workId: records[0]!.snapshot.workId,
      namespaceId: records[0]!.snapshot.namespaceId,
      now: START + 11,
    })).toEqual({
      status: "settled",
      transitioned: 0,
      alreadyTerminal: 5,
      recipients: settled.recipients,
    });
  });

  test("settlement accepts zero prior requests and leaves cancellation publication untouched", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const base = settlementTaskRuntimeRecord(1, "task.execute");
    expect(await repository.settleTaskRuntimeExecutionAuthorities({
      workId: base.snapshot.workId,
      namespaceId: base.snapshot.namespaceId,
      now: START + 1,
    })).toEqual({
      status: "settled",
      transitioned: 0,
      alreadyTerminal: 0,
      recipients: [],
    });
    const cancellation = {
      ...settlementTaskRuntimeRecord(2, "task.cancel_result"),
      authoritySet: {
        ...base.authoritySet,
        namespaceRequirements: base.authoritySet.namespaceRequirements.map(
          (requirement) => ({ ...requirement, operations: ["encrypt"] as const }),
        ),
      },
    } satisfies BackgroundAuthorizationTaskRuntimeRecordV3;
    await repository.create(cancellation);
    await repository.settleTaskRuntimeExecutionAuthorities({
      workId: base.snapshot.workId,
      namespaceId: base.snapshot.namespaceId,
      now: START + 2,
    });
    expect(await repository.get(cancellation.snapshot.requestId)).toEqual(
      cancellation,
    );
  });

  test("settlement rejects a conflicting Namespace atomically", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const valid = settlementTaskRuntimeRecord(1, "task.execute");
    const conflictBase = settlementTaskRuntimeRecord(
      2,
      "task.approval_resume",
    );
    const conflict = {
      ...conflictBase,
      snapshot: {
        ...conflictBase.snapshot,
        namespaceId: "task_runtime_namespace_conflict",
      },
      domainId: "task_runtime_domain_conflict",
      authoritySet: {
        namespaceRequirements: [{
          ...conflictBase.authoritySet.namespaceRequirements[0]!,
          namespaceId: "task_runtime_namespace_conflict",
          domainId: "task_runtime_domain_conflict",
        }],
        domainRequirements: [{
          ...conflictBase.authoritySet.domainRequirements[0]!,
          domainId: "task_runtime_domain_conflict",
        }],
      },
    } satisfies BackgroundAuthorizationTaskRuntimeRecordV3;
    await repository.create(valid);
    await repository.create(conflict);

    expect(await repository.settleTaskRuntimeExecutionAuthorities({
      workId: valid.snapshot.workId,
      namespaceId: valid.snapshot.namespaceId,
      now: START + 10,
    })).toEqual({ status: "conflict", recipients: [] });
    expect(await repository.get(valid.snapshot.requestId)).toEqual(valid);
    expect(await repository.get(conflict.snapshot.requestId)).toEqual(conflict);
  });

  test("terminal pruning honors the 30-day boundary and 256-row cap", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const now = START + BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS + 10;
    for (let index = 0; index < 258; index += 1) {
      const initial = initialRecord(`request_${index}`, index + 1);
      const cancelled = cancelBackgroundAuthorizationRequest(
        initial.snapshot,
        "cancelled",
        START + 1,
      );
      await repository.create(initial);
      await repository.compareAndSwap({
        expectedRequestRevision: 0,
        next: {
          ...initial,
          snapshot: cancelled,
          finishedAt: START + 1,
        },
      });
    }

    expect(await repository.pruneTerminal({ now })).toBe(256);
    expect(await repository.pruneTerminal({ now })).toBe(2);
  });

  test("processor signer evidence is writable only through verified acceptance", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    expect("appendProcessorSignerEvidence" in repository).toBeFalse();
    const initial = initialRecord();
    const recipient = withRecipient(initial);
    await repository.create(initial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });
    const response = verifiedResponse();
    expect(await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    })).toMatchObject({ status: "accepted" });
    expect(await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 3,
    })).toMatchObject({ status: "duplicate" });
  });

  test("completed state remains readable and cannot be changed by stale work", async () => {
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const initial = initialRecord();
    const recipient = withRecipient(initial);
    await repository.create(initial);
    await repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: recipient,
    });
    const acceptance = await repository.acceptVerifiedResponse({
      response: verifiedResponse(),
      acceptedAt: START + 2,
    });
    if (acceptance.status !== "accepted") throw new Error("expected acceptance");
    const ready = acceptance.record;
    const claimed = {
      ...ready,
      snapshot: claimBackgroundAuthorizationRequest(
        ready.snapshot,
        "claim_1",
        START + 3,
        START + 60_000,
      ),
    };
    const running = {
      ...claimed,
      snapshot: markBackgroundAuthorizationRunning(
        claimed.snapshot,
        START + 4,
      ),
    };
    const completedAt = START + 5;
    const completed = {
      ...running,
      snapshot: completeBackgroundAuthorizationRequest(
        running.snapshot,
        completedAt,
      ),
      finishedAt: completedAt,
    };
    for (const next of [claimed, running, completed]) {
      expect((await repository.compareAndSwap({
        expectedRequestRevision: next.snapshot.requestRevision - 1,
        next,
      })).status).toBe("updated");
    }
    expect((await repository.get("request_1"))?.snapshot.state).toBe(
      "completed",
    );
  });

  test("accepts a crypto-verified current Stenographer response and retains public processor v2 evidence", async () => {
    const crypto = new LatticeCrypto();
    const device = crypto.generateSigningKeyPair();
    const recipient = await crypto.generateEncryptionKeyPair();
    const descriptor = {
      formatVersion: 2 as const,
      requestId: "request_processor_v2",
      recipientGeneration: 0,
      workKind: "stenographer.extraction" as const,
      workId: "work_processor_v2",
      anchorNamespaceId: "namespace_room_1",
      anchorDomainId: "domain_alice_bob",
      subject: {kind: "processor" as const, processorKind: "stenographer" as const, processorVersion: 1 as const},
      operations: ["decrypt" as const, "encrypt" as const],
      purpose: "journal.extract" as const,
      authority: {
        serverId: "server_1",
        roomId: "room_1",
        namespaceId: "namespace_room_1",
        namespaceAccessRevision: 4,
        namespaceKeyGeneration: 2,
        namespaceHeadDigest: new Uint8Array(32).fill(0x11),
        domainId: "domain_alice_bob",
        domainKeyGeneration: 3,
        domainAuthorizationRevision: 5,
        domainHeadDigest: new Uint8Array(32).fill(0x12),
        bundleRevision: 6,
        bundleDigest: new Uint8Array(32).fill(0x13),
      },
      policyRevision: 3,
      source: {
        kind: "stenographer_work" as const,
        startSequence: 1,
        endSequence: 2,
        rebuildGeneration: 0,
        fingerprint: new Uint8Array(32).fill(0x14),
      },
      inputBindings: ["message_1", "message_2"].map(objectId => ({objectId, namespaceId: "namespace_room_1"})),
      outputSlots: [{
        objectId: "reflection_1",
        objectType: "nautilo.reflection.record.v1" as const,
        createdAt: START,
        namespaceIds: ["namespace_room_1"],
      }],
      maximumPlaintextBytes: 512 * 1_024,
      maximumCiphertextBytes: 1_024 * 1_024 + 40,
      recipientKeyId: "recipient_processor_v2",
      recipientPublicKey: recipient.publicKey,
      issuedAt: START,
      notBefore: START,
      expiresAt: START + 300_000,
      idempotencyId: "idempotency_processor_v2",
    };
    const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
    const issuer = {
      humanId: "human_alice",
      deviceId: "device_alice",
      deviceGeneration: 2,
      serverInstanceId: "server_1",
      lineageGeneration: 3,
      epoch: 4,
      securityRevision: 11,
      headDigest: new Uint8Array(32).fill(0x21),
      signingPublicKeyHash: crypto.hash(device.publicKey),
    };
    const responseBytes = await createBackgroundAuthorizationResponseV2(
      crypto,
      {
        credentialId: "credential_processor_v2",
        descriptorBytes,
        issuer,
        issuerSigningPrivateKey: device.privateKey,
        domainKey: new Uint8Array(32).fill(0x31),
      },
    );
    const verified = await verifyBackgroundAuthorizationResponseV2(crypto, {
      responseBytes,
      now: START + 2,
      resolveCurrentIssuer: () => device.publicKey,
    });
    const initial: BackgroundAuthorizationRecord = {
      snapshot: createBackgroundAuthorizationRequestV2({
        requestId: descriptor.requestId,
        workId: descriptor.workId,
        namespaceId: descriptor.authority.namespaceId,
        credentialSubject: {
          kind: "processor",
          processorKind: "stenographer",
          processorVersion: 1,
        },
        now: START,
      }),
      workIdentityHash: new Uint8Array(32).fill(0x41),
      idempotencyKey: descriptor.idempotencyId,
      workKind: descriptor.workKind,
      purpose: descriptor.purpose,
      domainId: descriptor.authority.domainId,
      processorAuthorizationRevision: null,
      expectedDomainEpoch: null,
      expectedNamespaceAccessRevision:
        descriptor.authority.namespaceAccessRevision,
      expectedPolicyRevision: descriptor.policyRevision,
      descriptorBytes: null,
      acceptedMaterial: null,
      finishedAt: null,
    };
    const waiting: BackgroundAuthorizationRecord = {
      ...initial,
      snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
        descriptorDigest: digest(descriptorBytes),
        recipientKeyId: descriptor.recipientKeyId,
        recipientPublicKey: Buffer.from(recipient.publicKey).toString(
          "base64url",
        ),
        expiresAt: descriptor.expiresAt,
        now: START + 1,
      }),
      descriptorBytes,
    };
    const response = { ...verified, formatVersion: 2 as const, kind: "processor" as const };
    const built = buildAcceptedBackgroundAuthorizationResponse(
      waiting,
      response,
      START + 2,
    );
    expect(built.next).toMatchObject({
      snapshot: { formatVersion: 2, credentialSubject: {kind: "processor"}, state: "grant_ready" },
      expectedDomainEpoch: null,
      processorAuthorizationRevision: null,
      acceptedMaterial: { issuingDeviceAuthorizationRevision: 11 },
    });
    expect(built.signerEvidence).toMatchObject({
      formatVersion: 2,
      domainEpoch: null,
      processorAuthorizationRevision: null,
      authorizationBytes: verified.signerAuthorizationBytes,
      workDescriptorBytes: descriptorBytes,
    });

    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(initial);
    await repository.compareAndSwap({ expectedRequestRevision: 0, next: waiting });
    expect(await repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    })).toMatchObject({
      status: "accepted",
      record: { snapshot: { formatVersion: 2, credentialSubject: {kind: "processor"}, state: "grant_ready" } },
    });
  });
});


function cancellationReplacementFixture(): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const initial = taskRuntimeAwaitingRecipientV3();
  return {
    ...initial,
    snapshot: { ...initial.snapshot,
      requestId: `task-run-cancellation-result-authorization:${initial.snapshot.workId}` },
    idempotencyKey: `task-cancellation:${"a".repeat(64)}`,
    workKind: "task.cancel_result", purpose: "task.cancel_result",
    authoritySet: { ...initial.authoritySet, namespaceRequirements:
      initial.authoritySet.namespaceRequirements.map(value => ({ ...value, operations: ["encrypt"] })) },
  };
}

function terminalMessageReplacementFixture():
BackgroundAuthorizationTaskRuntimeRecordV3 {
  const initial = taskRuntimeAwaitingRecipientV3();
  return {
    ...initial,
    snapshot: {
      ...initial.snapshot,
      requestId:
        `task-run-delivery-message-authorization:${initial.snapshot.workId}`,
    },
    idempotencyKey: `task-delivery-message:${"d".repeat(64)}`,
    workKind: "task.deliver_message",
    purpose: "task.deliver_message",
    authoritySet: {
      ...initial.authoritySet,
      namespaceRequirements: initial.authoritySet.namespaceRequirements.map(
        value => ({ ...value, operations: ["encrypt"] }),
      ),
    },
  };
}

function refreshedCancellationPlan(initial: BackgroundAuthorizationTaskRuntimeRecordV3): BackgroundAuthorizationTaskRuntimeRecordV3 {
  return { ...initial, workIdentityHash: new Uint8Array(32).fill(0x79),
    expectedDomainEpoch: initial.expectedDomainEpoch + 1,
    authoritySet: { ...initial.authoritySet, domainRequirements:
      initial.authoritySet.domainRequirements.map(value => ({ ...value,
        expectedEpoch: value.expectedEpoch + 1, expectedAuthorizationRevision: value.expectedAuthorizationRevision + 1 })) } };
}

function cancellationPlanAtPolicy(
  initial: BackgroundAuthorizationTaskRuntimeRecordV3,
  policyRevision: number,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const refreshed = refreshedCancellationPlan(initial);
  return { ...refreshed, expectedPolicyRevision: policyRevision,
    authoritySet: { ...refreshed.authoritySet, namespaceRequirements:
      refreshed.authoritySet.namespaceRequirements.map(value => ({ ...value,
        expectedPolicyRevision: policyRevision })) } };
}

test.each(["awaiting_recipient", "awaiting_device", "grant_ready"] as const)(
  "replaces only the exact unclaimed cancellation authority from %s", async state => {
    const initial = cancellationReplacementFixture();
    let expected = initial;
    if (state !== "awaiting_recipient") {
      const descriptorBytes = new Uint8Array([1, 2, 3]);
      expected = { ...initial, descriptorBytes,
        snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
          recipientGeneration: 0, recipientKeyId: "cancellation-recipient",
          recipientPublicKey: RECIPIENT_PUBLIC_KEY, descriptorDigest: digest(descriptorBytes),
          expiresAt: START + 60_000, now: START + 1,
        }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
    }
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(expected);
    if (state === "grant_ready") {
      const result = await repository.acceptVerifiedResponse({
        response: verifiedTaskRuntimeResponseV3(expected), acceptedAt: START + 2,
      });
      if (result.status !== "accepted") throw new Error("expected cancellation response");
      expected = result.record as BackgroundAuthorizationTaskRuntimeRecordV3;
    }
    const replacement = refreshedCancellationPlan(initial);
    const next = buildUnclaimedTaskCancellationAuthorityReplacement({ expected, replacement, now: START + 3 });
    expect(repository.compareAndSwap({ expectedRequestRevision: expected.snapshot.requestRevision, next }))
      .rejects.toThrow();
    expect(await repository.replaceUnclaimedTaskCancellationAuthority({ expected, replacement, now: START + 3 }))
      .toEqual({ status: "replaced", record: next });
    expect(next.snapshot).toMatchObject({ state: "awaiting_recipient", recipientGeneration: 1,
      requestRevision: expected.snapshot.requestRevision + 1, recipient: null, acceptedResponse: null });
    expect(next.descriptorBytes).toBeNull();
    expect(next.acceptedMaterial).toBeNull();
    expect(next.expectedDomainEpoch).toBe(replacement.expectedDomainEpoch);
    expect(await repository.replaceUnclaimedTaskCancellationAuthority({ expected, replacement, now: START + 4 }))
      .toMatchObject({ status: "stale" });
    expect(() => buildUnclaimedTaskRuntimeAuthorityReplacement({ expected, replacement, now: START + 3 })).toThrow();
  });

test("cancellation replacement permits only monotonic policy drift", () => {
  const expected = cancellationReplacementFixture();
  const replacement = cancellationPlanAtPolicy(expected, expected.expectedPolicyRevision + 1);
  const next = buildUnclaimedTaskCancellationAuthorityReplacement({ expected, replacement, now: START + 4 });
  expect(next.expectedPolicyRevision).toBe(expected.expectedPolicyRevision + 1);
  expect(next.authoritySet.namespaceRequirements[0]?.expectedPolicyRevision)
    .toBe(expected.expectedPolicyRevision + 1);
  expect(() => buildUnclaimedTaskCancellationAuthorityReplacement({ expected,
    replacement: cancellationPlanAtPolicy(expected, expected.expectedPolicyRevision - 1),
    now: START + 4 })).toThrow();
});

test("cancellation replacement refuses execution, identity drift, and claimed work", () => {
  const expected = cancellationReplacementFixture();
  const replacement = refreshedCancellationPlan(expected);
  const reject = (old: BackgroundAuthorizationTaskRuntimeRecordV3, next: BackgroundAuthorizationTaskRuntimeRecordV3) =>
    expect(() => buildUnclaimedTaskCancellationAuthorityReplacement({ expected: old, replacement: next, now: START + 4 })).toThrow();
  reject(taskRuntimeAwaitingRecipientV3(), replacement);
  reject(expected, taskRuntimeAwaitingRecipientV3());
  reject(expected, { ...replacement, idempotencyKey: `task-cancellation:${"b".repeat(64)}` });
  reject({ ...expected, idempotencyKey: "task-cancellation:invalid" }, { ...replacement, idempotencyKey: "task-cancellation:invalid" });
  reject(expected, { ...replacement, snapshot: { ...replacement.snapshot, workId: "other-run" } });
  reject(expected, { ...replacement, snapshot: { ...replacement.snapshot, namespaceId: "other-namespace" } });
  reject(expected, { ...replacement, expectedPolicyRevision: replacement.expectedPolicyRevision + 1 });
  reject(expected, { ...replacement, snapshot: { ...replacement.snapshot, recipientGeneration: 1 } });
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  const waiting: BackgroundAuthorizationTaskRuntimeRecordV3 = { ...expected, descriptorBytes,
    snapshot: attachBackgroundAuthorizationRecipient(expected.snapshot, {
      recipientGeneration: 0, recipientKeyId: "cancel-recipient", recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      descriptorDigest: digest(descriptorBytes), expiresAt: START + 60_000, now: START + 1,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
  const ready = buildAcceptedBackgroundAuthorizationResponse(waiting, verifiedTaskRuntimeResponseV3(waiting), START + 2).next;
  if (ready.snapshot.formatVersion !== 3) throw new Error("expected runtime");
  const claimed = { ...ready, snapshot: claimBackgroundAuthorizationRequest(ready.snapshot,
    "cancel-claim", START + 3, START + 30_000) } as BackgroundAuthorizationTaskRuntimeRecordV3;
  reject(claimed, replacement);
  reject({ ...claimed, snapshot: markBackgroundAuthorizationRunning(claimed.snapshot, START + 4) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] }, replacement);
});

test.each(["awaiting_recipient", "awaiting_device", "grant_ready"] as const)(
  "replaces only exact unclaimed terminal Message authority from %s",
  async state => {
    const initial = terminalMessageReplacementFixture();
    let expected = initial;
    if (state !== "awaiting_recipient") {
      const descriptorBytes = new Uint8Array([4, 5, 6]);
      expected = {
        ...initial,
        descriptorBytes,
        snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
          recipientGeneration: 0,
          recipientKeyId: "terminal-message-recipient",
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          descriptorDigest: digest(descriptorBytes),
          expiresAt: START + 60_000,
          now: START + 1,
        }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      };
    }
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(expected);
    if (state === "grant_ready") {
      const result = await repository.acceptVerifiedResponse({
        response: verifiedTaskRuntimeResponseV3(expected),
        acceptedAt: START + 2,
      });
      if (result.status !== "accepted") {
        throw new Error("expected terminal Message response");
      }
      expected = result.record as BackgroundAuthorizationTaskRuntimeRecordV3;
    }
    const replacement = cancellationPlanAtPolicy(
      initial,
      initial.expectedPolicyRevision + 1,
    );
    const next = buildUnclaimedTaskTerminalMessageAuthorityReplacement({
      expected,
      replacement,
      now: START + 3,
    });
    expect(repository.compareAndSwap({
      expectedRequestRevision: expected.snapshot.requestRevision,
      next,
    })).rejects.toThrow();
    expect(await repository.replaceUnclaimedTaskTerminalMessageAuthority({
      expected,
      replacement,
      now: START + 3,
    })).toEqual({ status: "replaced", record: next });
    expect(next.snapshot).toMatchObject({
      state: "awaiting_recipient",
      recipientGeneration: 1,
      requestRevision: expected.snapshot.requestRevision + 1,
      recipient: null,
      acceptedResponse: null,
    });
    expect(next.descriptorBytes).toBeNull();
    expect(next.acceptedMaterial).toBeNull();
    expect(next.expectedPolicyRevision)
      .toBe(initial.expectedPolicyRevision + 1);
    expect(next.snapshot.requestId).toBe(initial.snapshot.requestId);
    expect(next.snapshot.workId).toBe(initial.snapshot.workId);
    expect(next.snapshot.namespaceId).toBe(initial.snapshot.namespaceId);
    expect(next.idempotencyKey).toBe(initial.idempotencyKey);
  },
);

test("terminal Message replacement rejects other families and identity drift", () => {
  const expected = terminalMessageReplacementFixture();
  const replacement = cancellationPlanAtPolicy(
    expected,
    expected.expectedPolicyRevision + 1,
  );
  const reject = (
    old: BackgroundAuthorizationTaskRuntimeRecordV3,
    next: BackgroundAuthorizationTaskRuntimeRecordV3,
  ) => expect(() => buildUnclaimedTaskTerminalMessageAuthorityReplacement({
    expected: old,
    replacement: next,
    now: START + 4,
  })).toThrow();

  reject(cancellationReplacementFixture(), replacement);
  reject(expected, cancellationPlanAtPolicy(
    cancellationReplacementFixture(),
    expected.expectedPolicyRevision + 1,
  ));
  reject(expected, {
    ...replacement,
    idempotencyKey: `task-delivery-message:${"e".repeat(64)}`,
  });
  reject(expected, {
    ...replacement,
    snapshot: { ...replacement.snapshot, requestId:
      `task-run-delivery-message-authorization:other-run` },
  });
  reject(expected, {
    ...replacement,
    snapshot: { ...replacement.snapshot, workId: "other-run" },
  });
  reject(expected, {
    ...replacement,
    snapshot: { ...replacement.snapshot, namespaceId: "other-namespace" },
  });
  reject(expected, {
    ...replacement,
    expectedPolicyRevision: expected.expectedPolicyRevision - 1,
    authoritySet: {
      ...replacement.authoritySet,
      namespaceRequirements: replacement.authoritySet.namespaceRequirements
        .map(value => ({ ...value,
          expectedPolicyRevision: expected.expectedPolicyRevision - 1 })),
    },
  });
  expect(() => buildUnclaimedTaskCancellationAuthorityReplacement({
    expected,
    replacement,
    now: START + 4,
  })).toThrow();
  expect(() => buildUnclaimedTaskRuntimeAuthorityReplacement({
    expected,
    replacement,
    now: START + 4,
  })).toThrow();
});

test("terminal Message replacement rejects claimed, running, and completed work", () => {
  const initial = terminalMessageReplacementFixture();
  const descriptorBytes = new Uint8Array([7, 8, 9]);
  const waiting: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...initial,
    descriptorBytes,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      recipientGeneration: 0,
      recipientKeyId: "terminal-message-recipient",
      recipientPublicKey: RECIPIENT_PUBLIC_KEY,
      descriptorDigest: digest(descriptorBytes),
      expiresAt: START + 60_000,
      now: START + 1,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
  };
  const ready = buildAcceptedBackgroundAuthorizationResponse(
    waiting,
    verifiedTaskRuntimeResponseV3(waiting),
    START + 2,
  ).next as BackgroundAuthorizationTaskRuntimeRecordV3;
  const claimed = {
    ...ready,
    snapshot: claimBackgroundAuthorizationRequest(
      ready.snapshot,
      "terminal-message-claim",
      START + 3,
      START + 30_000,
    ),
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const running = {
    ...claimed,
    snapshot: markBackgroundAuthorizationRunning(
      claimed.snapshot,
      START + 4,
    ),
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const completed = {
    ...running,
    snapshot: completeBackgroundAuthorizationRequest(
      running.snapshot,
      START + 5,
    ),
    finishedAt: START + 5,
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const replacement = cancellationPlanAtPolicy(
    initial,
    initial.expectedPolicyRevision + 1,
  );
  for (const record of [claimed, running, completed]) {
    expect(() => buildUnclaimedTaskTerminalMessageAuthorityReplacement({
      expected: record,
      replacement,
      now: START + 6,
    })).toThrow();
  }
});


function outputReadReplacementFixture(wake = false, merged = false): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const initial = taskRuntimeAwaitingRecipientV3();
  const workId = "10000000-0000-4000-8000-000000000101";
  const primary = initial.authoritySet.namespaceRequirements[0]!;
  const namespaces = merged ? [{ ...primary, operations: ["decrypt", "encrypt"] as const }]
    : [{ ...primary, ordinal: 0, namespaceId: "a_foreground_namespace",
      operations: wake ? ["decrypt", "encrypt"] as const : ["encrypt"] as const },
    { ...primary, ordinal: 1, operations: ["decrypt"] as const }];
  return { ...initial,
    snapshot: { ...initial.snapshot, workId, requestId: wake
      ? `task-wake-authorization:${workId}` : `task-run-delivery-result-authorization:${workId}` },
    idempotencyKey: `task-output-read:${"e".repeat(64)}`,
    workKind: wake ? "task.delivery_wake" : "task.deliver_result",
    purpose: wake ? "task.delivery_wake" : "task.deliver_result",
    authoritySet: { ...initial.authoritySet, namespaceRequirements: namespaces },
  };
}

async function outputReadAtState(wake: boolean, state: "awaiting_recipient" | "awaiting_device" | "grant_ready", merged = false, canonical = false) {
  const initial = canonical ? canonicalWakeRecord(outputReadReplacementFixture(wake, merged)) : outputReadReplacementFixture(wake, merged);
  let expected = initial;
  if (state !== "awaiting_recipient") {
    const descriptorBytes = new Uint8Array([3, 4, 5]);
    expected = { ...initial, descriptorBytes,
      snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
        recipientGeneration: 0, recipientKeyId: "output-read-recipient", recipientPublicKey: RECIPIENT_PUBLIC_KEY,
        descriptorDigest: digest(descriptorBytes), expiresAt: START + 60_000, now: START + 1,
      }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
  }
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(expected);
  if (state === "grant_ready") {
    const accepted = await repository.acceptVerifiedResponse({ response: verifiedTaskRuntimeResponseV3(expected), acceptedAt: START + 2 });
    if (accepted.status !== "accepted") throw new Error("Expected output read grant");
    expected = accepted.record as BackgroundAuthorizationTaskRuntimeRecordV3;
  }
  return { initial, expected, repository };
}

for (const wake of [false, true]) {
  test.each(["awaiting_recipient", "awaiting_device", "grant_ready"] as const)(
    `${wake ? "wake" : "raw result"} authority refresh replaces only unclaimed %s`, async state => {
      const { initial, expected, repository } = await outputReadAtState(wake, state);
      const replacement = cancellationPlanAtPolicy(initial, initial.expectedPolicyRevision + 1);
      const next = buildUnclaimedTaskOutputReadAuthorityReplacement({ expected, replacement, now: START + 3 });
      expect(next.snapshot).toMatchObject({ state: "awaiting_recipient", requestId: expected.snapshot.requestId,
        workId: expected.snapshot.workId, namespaceId: expected.snapshot.namespaceId,
        recipientGeneration: expected.snapshot.recipientGeneration + 1, requestRevision: expected.snapshot.requestRevision + 1,
        recipient: null, acceptedResponse: null, claimId: null, claimExpiresAt: null });
      expect(next.expectedPolicyRevision).toBe(initial.expectedPolicyRevision + 1);
      expect(next.expectedDomainEpoch).toBe(initial.expectedDomainEpoch + 1);
      expect(next.descriptorBytes).toBeNull(); expect(next.acceptedMaterial).toBeNull(); expect(next.finishedAt).toBeNull();
      expect(await repository.replaceUnclaimedTaskOutputReadAuthority({ expected, replacement, now: START + 3 }))
        .toEqual({ status: "replaced", record: next });
      expect(await repository.replaceUnclaimedTaskOutputReadAuthority({ expected, replacement, now: START + 4 }))
        .toMatchObject({ status: "stale", current: next });
      expect(() => buildUnclaimedTaskRuntimeAuthorityReplacement({ expected, replacement, now: START + 3 })).toThrow();
      expect(() => buildUnclaimedTaskCancellationAuthorityReplacement({ expected, replacement, now: START + 3 })).toThrow();
      expect(() => buildUnclaimedTaskTerminalMessageAuthorityReplacement({ expected, replacement, now: START + 3 })).toThrow();
    });

  test(`${wake ? "wake" : "raw"} shared primary foreground role is explicit and can retain current policy`, () => {
    const expected = outputReadReplacementFixture(wake, true);
    const replacement = refreshedCancellationPlan(expected);
    const next = buildUnclaimedTaskOutputReadAuthorityReplacement({ expected, replacement, now: START + 2 });
    expect(next.expectedPolicyRevision).toBe(expected.expectedPolicyRevision);
    expect(next.authoritySet.namespaceRequirements).toHaveLength(1);
    expect(next.authoritySet.namespaceRequirements[0]?.operations).toEqual(["decrypt", "encrypt"]);
    expect(next.authoritySet.domainRequirements).toHaveLength(1);
  });

  test(`${wake ? "wake" : "raw"} replacement cannot race past a winning claim or become ordinary CAS`, async () => {
    const f = await outputReadAtState(wake, "grant_ready");
    const replacement = cancellationPlanAtPolicy(f.initial, f.initial.expectedPolicyRevision + 1);
    const claimed = { ...f.expected, snapshot: claimBackgroundAuthorizationRequest(f.expected.snapshot,
      "output-read-claim", START + 3, START + 30_000) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
    expect((await f.repository.compareAndSwap({ expectedRequestRevision: f.expected.snapshot.requestRevision, next: claimed })).status).toBe("updated");
    expect(await f.repository.replaceUnclaimedTaskOutputReadAuthority({ expected: f.expected, replacement, now: START + 4 }))
      .toMatchObject({ status: "stale", current: { snapshot: { state: "claimed" } } });
    expect(() => buildUnclaimedTaskOutputReadAuthorityReplacement({ expected: claimed, replacement, now: START + 4 })).toThrow();
    const running = { ...claimed, snapshot: markBackgroundAuthorizationRunning(claimed.snapshot, START + 4) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
    expect(() => buildUnclaimedTaskOutputReadAuthorityReplacement({ expected: running, replacement, now: START + 5 })).toThrow();
    const completed = { ...running, snapshot: completeBackgroundAuthorizationRequest(running.snapshot, START + 5) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"], finishedAt: START + 5 };
    expect(() => buildUnclaimedTaskOutputReadAuthorityReplacement({ expected: completed, replacement, now: START + 6 })).toThrow();
    const reconciliation = { ...running, snapshot: markBackgroundAuthorizationPublicationReconciliation(running.snapshot, START + 5) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
    expect(() => buildUnclaimedTaskOutputReadAuthorityReplacement({ expected: reconciliation, replacement, now: START + 6 })).toThrow();
    const fresh = await outputReadAtState(wake, "grant_ready");
    const replaced = await fresh.repository.replaceUnclaimedTaskOutputReadAuthority({ expected: fresh.expected, replacement, now: START + 3 });
    expect(replaced.status).toBe("replaced");
    expect((await fresh.repository.compareAndSwap({ expectedRequestRevision: fresh.expected.snapshot.requestRevision,
      next: { ...fresh.expected, snapshot: claimBackgroundAuthorizationRequest(fresh.expected.snapshot,
        "losing-output-read-claim", START + 3, START + 30_000) } })).status).toBe("stale");
    const forged = buildUnclaimedTaskOutputReadAuthorityReplacement({ expected: f.initial, replacement, now: START + 3 });
    const ordinary = new InMemoryBackgroundAuthorizationRepository(); await ordinary.create(f.initial);
    expect(await ordinary.compareAndSwap({ expectedRequestRevision: f.initial.snapshot.requestRevision, next: forged })
      .catch((error: unknown) => error)).toBeInstanceOf(Error);
  });
}

test("result-read replacement rejects identity, policy rollback, anchors and unsupported partitions", () => {
  for (const wake of [false, true]) {
    const expected = outputReadReplacementFixture(wake);
    const replacement = refreshedCancellationPlan(expected);
    const reject = (next: BackgroundAuthorizationTaskRuntimeRecordV3, old = expected) =>
      expect(() => buildUnclaimedTaskOutputReadAuthorityReplacement({ expected: old, replacement: next, now: START + 5 })).toThrow();
    reject(cancellationPlanAtPolicy(expected, expected.expectedPolicyRevision - 1));
    reject({ ...replacement, workKind: wake ? "task.deliver_result" : "task.delivery_wake", purpose: wake ? "task.deliver_result" : "task.delivery_wake" });
    reject({ ...replacement, idempotencyKey: `task-output-read:${"f".repeat(64)}` });
    reject({ ...replacement, idempotencyKey: "task-output-read:invalid" }, { ...expected, idempotencyKey: "task-output-read:invalid" });
    reject({ ...replacement, snapshot: { ...replacement.snapshot, requestId: "other-request" } });
    reject({ ...replacement, snapshot: { ...replacement.snapshot, workId: "other-work" } });
    reject({ ...replacement, snapshot: { ...replacement.snapshot, namespaceId: "a_foreground_namespace" } });
    reject({ ...replacement, snapshot: { ...replacement.snapshot, recipientGeneration: 1 } });
    reject({ ...replacement, descriptorBytes: new Uint8Array([1]) });
    reject({ ...replacement, expectedNamespaceAccessRevision: replacement.expectedNamespaceAccessRevision + 1 });
    reject({ ...replacement, expectedDomainEpoch: replacement.expectedDomainEpoch + 1 });
    reject({ ...replacement, authoritySet: { ...replacement.authoritySet, domainRequirements: [] } });
    const replaceOperations = (index: number, operations: readonly ("decrypt" | "encrypt")[]) => ({ ...replacement,
      authoritySet: { ...replacement.authoritySet, namespaceRequirements: replacement.authoritySet.namespaceRequirements.map((n, i) =>
        i === index ? { ...n, operations } : n) } });
    reject(replaceOperations(1, ["encrypt"]));
    reject(replaceOperations(0, []));
    reject(replaceOperations(0, ["decrypt"]));
    reject(replaceOperations(0, ["decrypt", "encrypt", "encrypt"]));
    reject(replaceOperations(0, wake ? ["encrypt"] : ["decrypt", "encrypt"]));
    reject({ ...replacement, authoritySet: { ...replacement.authoritySet, namespaceRequirements:
      replacement.authoritySet.namespaceRequirements.map((n, i) => i === 0 ? { ...n, expectedPolicyRevision: n.expectedPolicyRevision + 1 } : n) } });
    if (!wake) reject({ ...replacement, authoritySet: { ...replacement.authoritySet, namespaceRequirements: [
      ...replacement.authoritySet.namespaceRequirements,
      { ...replacement.authoritySet.namespaceRequirements[0]!, ordinal: 2, namespaceId: "z_extra_namespace" },
    ] } });
    reject(replacement, taskRuntimeAwaitingRecipientV3());
    reject(replacement, terminalMessageReplacementFixture());
    reject(replacement, cancellationReplacementFixture());
  }
});

async function wakeParkFixture(merged = false) {
  const fixture = await outputReadAtState(true, "grant_ready", merged, true);
  const claimed = {
    ...fixture.expected,
    snapshot: claimBackgroundAuthorizationRequest(
      fixture.expected.snapshot,
      "wake-claim",
      START + 3,
      START + 30_000,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
  };
  expect((await fixture.repository.compareAndSwap({
    expectedRequestRevision: fixture.expected.snapshot.requestRevision,
    next: claimed,
  })).status).toBe("updated");
  const running = {
    ...claimed,
    snapshot: markBackgroundAuthorizationRunning(
      claimed.snapshot,
      START + 4,
    ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
  };
  expect((await fixture.repository.compareAndSwap({
    expectedRequestRevision: claimed.snapshot.requestRevision,
    next: running,
  })).status).toBe("updated");
  const destinationNamespaceId = WAKE_DESTINATION;
  const base = cancellationPlanAtPolicy(
    fixture.initial,
    fixture.initial.expectedPolicyRevision + 1,
  );
  const template = base.authoritySet.namespaceRequirements.at(-1)!;
  const replacement = {
    ...base,
    authoritySet: {
      ...base.authoritySet,
      namespaceRequirements: [
        ...base.authoritySet.namespaceRequirements,
        {
          ...template,
          ordinal: base.authoritySet.namespaceRequirements.length,
          namespaceId: destinationNamespaceId,
          operations: ["encrypt"] as const,
        },
      ],
    },
  } as BackgroundAuthorizationTaskRuntimeRecordV3;
  const receipt = wakeReceipt(running);
  return { ...fixture, running, replacement, receipt };
}

describe("parked Task wake authority", () => {
  test.each([false, true])(
    "rotates the exact running grant and supports merged primary foreground=%s",
    async merged => {
      const fixture = await wakeParkFixture(merged);
      await withWakeProof(fixture.receipt, async proof => {
      const next = buildParkedTaskWakeAuthorityReplacement({
        expected: fixture.running,
        replacement: fixture.replacement,
        proof,
        now: START + 5,
      });
      expect(next.snapshot).toMatchObject({
        state: "awaiting_recipient",
        recipientGeneration: fixture.receipt.segment,
        recipient: null,
        acceptedResponse: null,
        claimId: null,
      });
      expect(next.acceptedMaterial).toBeNull();
      expect(next.authoritySet.namespaceRequirements.at(-1)).toMatchObject({
        namespaceId: fixture.receipt.destinationNamespaceId,
        operations: ["encrypt"],
      });
      expect(await fixture.repository.parkTaskWakeForAdditionalAuthority({
        expected: fixture.running,
        replacement: fixture.replacement,
        proof,
        now: START + 5,
      })).toEqual({ status: "parked", record: next });
      expect(await fixture.repository.parkTaskWakeForAdditionalAuthority({
        expected: fixture.running,
        replacement: fixture.replacement,
        proof,
        now: START + 5,
      })).toEqual({ status: "exact_replay", record: next });
      });
    },
  );

  test("rejects destination widening, generation substitution, and proof expiry", async () => {
    const fixture = await wakeParkFixture();
    await withWakeProof(fixture.receipt, async proof => {
    const destination = fixture.replacement.authoritySet.namespaceRequirements.at(-1)!;
    expect(() => buildParkedTaskWakeAuthorityReplacement({
      expected: fixture.running,
      replacement: {
        ...fixture.replacement,
        authoritySet: {
          ...fixture.replacement.authoritySet,
          namespaceRequirements: fixture.replacement.authoritySet.namespaceRequirements
            .map((value, index, values) => index === values.length - 1
              ? { ...value, operations: ["decrypt", "encrypt"] }
              : value),
        },
      },
      proof,
      now: START + 5,
    })).toThrow("changed authority");
    expect(() => buildParkedTaskWakeAuthorityReplacement({
      expected: fixture.running,
      replacement: fixture.replacement,
      proof: { ...proof, receipt: { ...fixture.receipt,
        priorRecipientGeneration: fixture.receipt.priorRecipientGeneration + 1 } },
      now: START + 5,
    })).toThrow();
    expect(destination.operations).toEqual(["encrypt"]);
    });
    const escaped = await withWakeProof(fixture.receipt, proof => proof);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun asynchronous assertion typing
    await expect(fixture.repository.parkTaskWakeForAdditionalAuthority({
      expected: fixture.running, replacement: fixture.replacement, proof: escaped, now: START + 5,
    })).rejects.toThrow("not current");
    expect(await fixture.repository.get(fixture.running.snapshot.requestId)).toEqual(fixture.running);
  });

  test("renews only an expired pre-start recipient under the latest parked proof", async () => {
    const fixture = await wakeParkFixture();
    await withWakeProof(fixture.receipt, async proof => {
    const parked = await fixture.repository.parkTaskWakeForAdditionalAuthority({
      expected: fixture.running,
      replacement: fixture.replacement,
      proof,
      now: START + 5,
    });
    if (parked.status !== "parked") throw new Error("park fixture failed");
    const descriptorBytes = new Uint8Array([8, 9, 10]);
    const awaitingDevice: BackgroundAuthorizationTaskRuntimeRecordV3 = {
      ...parked.record,
      snapshot: attachBackgroundAuthorizationRecipient(
        parked.record.snapshot,
        {
          recipientGeneration: parked.record.snapshot.recipientGeneration,
          recipientKeyId: "renewal-recipient",
          recipientPublicKey: RECIPIENT_PUBLIC_KEY,
          descriptorDigest: digest(descriptorBytes),
          expiresAt: START + 10,
          now: START + 6,
        },
      ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      descriptorBytes,
    };
    expect((await fixture.repository.compareAndSwap({
      expectedRequestRevision: parked.record.snapshot.requestRevision,
      next: awaitingDevice,
    })).status).toBe("updated");
    expect(await fixture.repository.renewParkedTaskWakeRecipient({
      expected: awaitingDevice,
      proof,
      now: START + 9,
    })).toEqual({ status: "not_due", record: awaitingDevice });
    const renewed = await fixture.repository.renewParkedTaskWakeRecipient({
      expected: awaitingDevice,
      proof,
      now: START + 10,
    });
    expect(renewed).toMatchObject({
      status: "rotated",
      releasedRecipientGeneration: fixture.receipt.segment,
      record: {
        snapshot: {
          state: "awaiting_recipient",
          recipientGeneration: fixture.receipt.segment + 1,
          recipient: null,
          acceptedResponse: null,
          lastRetryReason: "attempt_expired",
        },
        descriptorBytes: null,
        acceptedMaterial: null,
      },
    });
    const current = await fixture.repository.get(
      fixture.running.snapshot.requestId,
    );
    expect(current).toEqual(renewed.status === "rotated"
      ? renewed.record : null);
    });
  });
});

test("genuine queued wake receipt permits current policy and Domain refresh without broadening its partition", async () => {
  const f = await wakeParkFixture();
  await withWakeProof(f.receipt, async proof => {
    const parked = await f.repository.parkTaskWakeForAdditionalAuthority({ expected: f.running,
      replacement: f.replacement, proof, now: START + 5 });
    if (parked.status !== "parked") throw new Error("park fixture failed");
    const replacement = cancellationPlanAtPolicy(f.replacement, f.replacement.expectedPolicyRevision + 1);
    const renewed = await f.repository.renewParkedTaskWakeRecipient({ expected: parked.record, replacement,
      proof, now: START + 6 });
    expect(renewed.status).toBe("rotated");
    if (renewed.status !== "rotated") throw new Error("renew fixture failed");
    expect(renewed.record.snapshot.recipientGeneration).toBe(parked.record.snapshot.recipientGeneration + 1);
    expect(renewed.record.expectedPolicyRevision).toBe(replacement.expectedPolicyRevision);
    expect(renewed.record.expectedDomainEpoch).toBe(replacement.expectedDomainEpoch);
    expect(renewed.record.authoritySet.namespaceRequirements.at(-1)?.operations).toEqual(["encrypt"]);
    expect(renewed.record.idempotencyKey).toBe(f.running.idempotencyKey);
    expect(await f.repository.renewParkedTaskWakeRecipient({ expected: renewed.record, replacement,
      proof, now: START + 7 })).toMatchObject({ status: "inactive", record: renewed.record });
    for (const bad of [
      cancellationPlanAtPolicy(f.replacement, f.receipt.initialPolicyRevision),
      { ...replacement, authoritySet: { ...replacement.authoritySet,
        namespaceRequirements: replacement.authoritySet.namespaceRequirements.map(n =>
          n.namespaceId === f.receipt.destinationNamespaceId ? { ...n, operations: ["decrypt", "encrypt"] as const } : n) } },
      { ...replacement, snapshot: { ...replacement.snapshot, namespaceId: f.receipt.destinationNamespaceId } },
    ]) {
      const result = await Promise.allSettled([f.repository.renewParkedTaskWakeRecipient({
        expected: renewed.record, replacement: bad, proof, now: START + 8 })]);
      expect(result[0]?.status).toBe("rejected");
      expect(await f.repository.get(f.running.snapshot.requestId)).toEqual(renewed.record);
    }
  });
});

test("a second park replaces the prior sealed destination only through authentic continuation lineage", async () => {
  const f = await wakeParkFixture();
  const first = await withWakeProof(f.receipt, proof => f.repository.parkTaskWakeForAdditionalAuthority({
    expected: f.running, replacement: f.replacement, proof, now: START + 5 }));
  if (first.status !== "parked") throw new Error("Expected first park");
  // A queued policy refresh advances generation without changing immutable receipt lineage.
  const refreshedPlan = cancellationPlanAtPolicy(f.replacement, f.replacement.expectedPolicyRevision + 1);
  const renewed = await withWakeProof(f.receipt, proof => f.repository.renewParkedTaskWakeRecipient({
    expected: first.record, replacement: refreshedPlan, proof, now: START + 5 }));
  if (renewed.status !== "rotated") throw new Error("Expected queued authority refresh");
  const descriptorBytes = new Uint8Array([5, 6, 7]);
  const waiting: BackgroundAuthorizationTaskRuntimeRecordV3 = { ...renewed.record, descriptorBytes,
    snapshot: attachBackgroundAuthorizationRecipient(renewed.record.snapshot, {
      recipientGeneration: renewed.record.snapshot.recipientGeneration, recipientKeyId: "second-wake-recipient",
      recipientPublicKey: RECIPIENT_PUBLIC_KEY, descriptorDigest: digest(descriptorBytes),
      expiresAt: START + 60_000, now: START + 6,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"] };
  expect((await f.repository.compareAndSwap({ expectedRequestRevision: renewed.record.snapshot.requestRevision,
    next: waiting })).status).toBe("updated");
  const accepted = await f.repository.acceptVerifiedResponse({ response: verifiedTaskRuntimeResponseV3(waiting), acceptedAt: START + 7 });
  if (accepted.status !== "accepted") throw new Error("Expected second grant");
  const claimed = { ...accepted.record, snapshot: claimBackgroundAuthorizationRequest(accepted.record.snapshot,
    "second-wake-claim", START + 8, START + 30_000) } as BackgroundAuthorizationTaskRuntimeRecordV3;
  expect((await f.repository.compareAndSwap({ expectedRequestRevision: accepted.record.snapshot.requestRevision, next: claimed })).status).toBe("updated");
  const running = { ...claimed, snapshot: markBackgroundAuthorizationRunning(claimed.snapshot, START + 9) } as BackgroundAuthorizationTaskRuntimeRecordV3;
  expect((await f.repository.compareAndSwap({ expectedRequestRevision: claimed.snapshot.requestRevision, next: running })).status).toBe("updated");
  const destination = "e0000000-0000-4000-8000-000000000001";
  const receipt = { ...wakeReceipt(running, destination), initialPolicyRevision: f.receipt.initialPolicyRevision };
  const replacement: BackgroundAuthorizationTaskRuntimeRecordV3 = { ...refreshedPlan,
    workIdentityHash: new Uint8Array(32).fill(0x81),
    authoritySet: { ...refreshedPlan.authoritySet, namespaceRequirements: refreshedPlan.authoritySet.namespaceRequirements
      .map(n => n.namespaceId === WAKE_DESTINATION ? { ...n, namespaceId: destination } : n) } };
  await withWakeProof(receipt, proof => {
    expect(() => buildParkedTaskWakeAuthorityReplacement({ expected: running, replacement, proof, now: START + 10 }))
      .toThrow("changed authority");
  });
  await withWakeProof(receipt, async proof => {
    const next = buildParkedTaskWakeAuthorityReplacement({ expected: running, replacement, proof, now: START + 10 });
    expect(next.snapshot.recipientGeneration).toBe(receipt.segment);
    expect(next.idempotencyKey).toBe(f.running.idempotencyKey);
    expect(next.authoritySet.namespaceRequirements.at(-1)?.namespaceId).toBe(destination);
    expect(next.authoritySet.namespaceRequirements.some(n => n.namespaceId === WAKE_DESTINATION)).toBe(false);
    expect(() => buildParkedTaskWakeAuthorityReplacement({ expected: running, replacement,
      proof: { ...proof }, now: START + 10 })).toThrow("not current");
    expect(await f.repository.parkTaskWakeForAdditionalAuthority({ expected: running, replacement, proof, now: START + 10 }))
      .toEqual({ status: "parked", record: next });
  }, f.receipt);
});
