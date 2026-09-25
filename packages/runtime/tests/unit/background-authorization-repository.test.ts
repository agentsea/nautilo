import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type {
  VerifiedAgentBackgroundAuthorizationDeviceResponse,
  VerifiedAgentBackgroundAuthorizationDeviceResponseV2,
  VerifiedProcessorBackgroundAuthorizationDeviceResponse,
} from "@nautilo/lattice-bridge";
import {
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  cancelBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequestV2,
  createBackgroundAuthorizationTaskRuntimeRequestV3,
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
  encodeBackgroundWorkDescriptorV2,
  MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
  MAX_BACKGROUND_WORK_DESCRIPTOR_WIRE_BYTES_V2,
  verifyBackgroundAuthorizationResponseV2,
} from "@nautilo/lattice-crypto/background";
import {
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
  BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS,
  BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS,
  BackgroundAuthorizationRepositoryConflictError,
  InMemoryBackgroundAuthorizationRepository,
  buildAcceptedBackgroundAuthorizationResponse,
  assertBackgroundAuthorizationCasSuccessor,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationAgentRecordV2,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationVerifiedRuntimeResponseV3,
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
    idempotencyKey: "task_runtime_idempotency_v3",
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
    expect(() => parseBackgroundAuthorizationRecord({
      ...record,
      workKind: "task.approval_resume",
      purpose: "task.approval_resume",
    })).toThrow(
      "Task Runtime authorization requires an exact Task work purpose",
    );
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

  test("keeps durable Reflection carrier limits in parity without widening legacy descriptors", () => {
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.descriptor)).toBe(
      MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.processorResponse)).toBe(
      MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(Number(BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS.processor)).toBe(
      MAX_BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_BYTES_V2,
    );
    expect(BACKGROUND_AUTHORIZATION_BYTE_LIMITS.runtimeResponse).toBe(
      DOMAIN_FOREGROUND_AUTHORIZATION_MAX_WIRE_BYTES_V2,
    );
    expect(BACKGROUND_AUTHORIZATION_RESPONSE_WIRE_LIMITS.runtime).toBe(
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
