import { ProtectedStenographerBackgroundCoordinator } from "../../src/stenographer/protected-stenographer-background-coordinator";
import { InMemoryBackgroundAuthorizationRepository } from "../../src/protected-execution/background-authorization/repository";
import { BackgroundAuthorizationProcessorCredentialClaimPort } from "../../src/protected-execution/background-authorization/processor-credential-claim-port";
import {
  prepareCurrentStenographerReconciliation,
  createCurrentStenographerReconciliationRecord,
  currentStenographerReconciliationDescriptor,
} from "../../src/stenographer/current-stenographer-publication-reconciliation";
import { encodeProtectedJournalAttachmentPlanV1 } from "../../src/stenographer/protected-journal-output-planner";
import type { ProtectedJournalPublicationRecord } from "../../src/stenographer/protected-publication-repository";
import { encodeEncryptedPayloadV2 } from "@nautilo/lattice-crypto/wire";
import { encryptObjectPayload, unixTimestamp } from "@nautilo/lattice-crypto";
import { scheduleBackgroundAuthorizationPublicationRetry } from "../../src/protected-execution/background-authorization/lifecycle";
import {
  createBackgroundAuthorizationResponseV2,
  verifyBackgroundAuthorizationResponseV2,
  publicationReconciliationFingerprintV2,
  decodeBackgroundProcessorWorkDescriptorV2,
  encodeBackgroundWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  ProcessorTransformRecipientRegistry,
  objectId,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import { decodeBackgroundWorkDescriptorV1 } from "@nautilo/lattice-crypto/wire";
import {
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES,
  ClassifiedDataOperationError,
} from "@nautilo/lattice-bridge";

import {
  attachBackgroundAuthorizationRecipient,
  cancelBackgroundAuthorizationRequest,
  claimBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationPublicationReconciliation,
  markBackgroundAuthorizationRunning,
} from "../../src/protected-execution/background-authorization/lifecycle";
import type { BackgroundAuthorizationRecord } from "../../src/protected-execution/background-authorization/repository";
import {
  createProtectedStenographerAuthorizationRecord,
  assertCancelledProtectedStenographerWorkIdentity,
  createCurrentProtectedStenographerAuthorizationRecord,
  createCurrentProtectedStenographerDescriptorFactory,
  currentExecutionPlanIdempotencyKey,
  currentExecutionPlanIdentity,
  createProtectedStenographerDescriptorFactory,
  recoverProtectedStenographerExecutionWork,
  type ProtectedStenographerDurableWorkRecoveryPort,
  type ProtectedStenographerRecoveredWork,
} from "../../src/stenographer/protected-stenographer-work-composition";
import { fingerprintProtectedStenographerSourceBindings } from "../../src/stenographer/protected-source-loader";
import type {
  ProtectedStenographerCompactionWorkClaim,
  ProtectedStenographerExtractionWorkClaim,
} from "../../src/stenographer/protected-stenographer-work-repository";

const NOW = 1_800_000_000_000;
const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const BATCH_ID = "30000000-0000-4000-8000-000000000001";
const INPUT_OBJECT_ID = "journal/message/41";
const OUTPUT_OBJECT_ID =
  `journal/event/${BATCH_ID}/slot-000`;

function extractionClaim(
  fingerprint?: Uint8Array,
): ProtectedStenographerExtractionWorkClaim {
  const bindings = Object.freeze([Object.freeze({
    kind: "message" as const,
    objectId: INPUT_OBJECT_ID,
    source: "current" as const,
    messageId: 41,
    editRevision: 0,
    createdAt: new Date(NOW - 1_000),
    participantId: "60000000-0000-4000-8000-000000000001",
    role: "user" as const,
    conversationalBoundary: true,
  })]);
  return Object.freeze({
    kind: "extraction",
    workKind: "stenographer.extraction",
    workId: BATCH_ID,
    sourceBatchId: BATCH_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    ownerId: "40000000-0000-4000-8000-000000000001",
    rebuildGeneration: 7,
    lane: "live",
    leaseToken: "50000000-0000-4000-8000-000000000001",
    leaseExpiresAt: new Date(NOW + 120_000),
    attemptCount: 1,
    fromMessageIdExclusive: 40,
    throughMessageIdInclusive: 41,
    trigger: "count",
    requiresContentRecheck: false,
    bindings,
    inputObjectIds: Object.freeze([INPUT_OBJECT_ID]),
    coveredRangeFingerprint: new Uint8Array(32).fill(0x2a),
    sourceBindingFingerprint: fingerprint
      ?? fingerprintProtectedStenographerSourceBindings(bindings),
    participantIds: Object.freeze([
      "60000000-0000-4000-8000-000000000001",
    ]),
    outputSlots: Object.freeze(Array.from(
      { length: 5 },
      (_, ordinal) => Object.freeze({
        eventId:
          `70000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`,
        objectId:
          `journal/event/${BATCH_ID}/slot-${String(ordinal).padStart(3, "0")}`,
      }),
    )),
    extractorVersion: "m241-v1",
    createdAt: new Date(NOW).toISOString(),
  });
}

function authority() {
  return Object.freeze({
    domainId: "domain-room-1",
    processorAuthorizationRevision: 19,
    expectedDomainEpoch: 7,
    expectedNamespaceAccessRevision: 11,
    expectedPolicyRevision: 13,
  });
}

function recovery(
  work: ProtectedStenographerRecoveredWork,
  calls: string[],
): ProtectedStenographerDurableWorkRecoveryPort {
  return Object.freeze({
    recoverExact: (
      { record }: Parameters<
        ProtectedStenographerDurableWorkRecoveryPort["recoverExact"]
      >[0],
    ) => {
      calls.push(record.snapshot.requestId);
      return Promise.resolve(Object.freeze({
        status: "recovered" as const,
        work,
      }));
    },
  });
}

function extractionWork(
  claim = extractionClaim(),
): ProtectedStenographerRecoveredWork {
  return Object.freeze({ claim, compactionModelId: null });
}

function compactionClaim(): ProtectedStenographerCompactionWorkClaim {
  const bindings = Object.freeze([
    Object.freeze({
      kind: "event" as const,
      objectId: "z-journal-event-source",
      status: "active" as const,
      binding: Object.freeze({
        eventId: "80000000-0000-4000-8000-000000000002",
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sequence: 2,
        kind: "fact" as const,
        supersedesEventId: null,
        resolvesEventId: null,
        sourceMessageIds: Object.freeze([21]),
        sourceBatchId: BATCH_ID,
        batchLocalOrdinal: 0,
        extractorVersion: "m241-v1",
        createdAt: new Date(NOW - 2_000).toISOString(),
      }),
    }),
    Object.freeze({
      kind: "event" as const,
      objectId: "a-journal-event-source",
      status: "active" as const,
      binding: Object.freeze({
        eventId: "80000000-0000-4000-8000-000000000005",
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        sequence: 5,
        kind: "decision" as const,
        supersedesEventId: null,
        resolvesEventId: null,
        sourceMessageIds: Object.freeze([41]),
        sourceBatchId: BATCH_ID,
        batchLocalOrdinal: 1,
        extractorVersion: "m241-v1",
        createdAt: new Date(NOW - 1_000).toISOString(),
      }),
    }),
  ]);
  return Object.freeze({
    kind: "compaction",
    workKind: "stenographer.compaction",
    workId: `stenographer-compaction/${ROOM_ID}/7/5`,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    ownerId: "40000000-0000-4000-8000-000000000001",
    rebuildGeneration: 7,
    leaseToken: "50000000-0000-4000-8000-000000000002",
    leaseExpiresAt: new Date(NOW + 120_000),
    attemptCount: 1,
    bindings,
    inputObjectIds: Object.freeze([
      "z-journal-event-source",
      "a-journal-event-source",
    ]),
    sourceBindingFingerprint:
      fingerprintProtectedStenographerSourceBindings(bindings),
    activeEventCount: 2,
    selectedEventCount: 2,
    hasDeferredMiddle: false,
    outputSlot: Object.freeze({
      rollupId: "90000000-0000-4000-8000-000000000001",
      objectId:
        "journal/rollup/90000000-0000-4000-8000-000000000001/slot-000",
    }),
    compactorVersion: "m241-v1",
    createdAt: new Date(NOW).toISOString(),
  });
}

function compactionWork(): ProtectedStenographerRecoveredWork {
  return Object.freeze({
    claim: compactionClaim(),
    compactionModelId: "stenographer-compaction-model",
  });
}

function currentAuthority() {
  return Promise.resolve(authority());
}

function preparedRecord(
  initial: BackgroundAuthorizationRecord,
  descriptorBytes: Uint8Array,
  descriptorHash: Uint8Array,
): BackgroundAuthorizationRecord {
  const descriptor = initial.snapshot.formatVersion === 2
      && initial.snapshot.credentialSubject.kind === "processor"
    ? decodeBackgroundProcessorWorkDescriptorV2(descriptorBytes) : decodeBackgroundWorkDescriptorV1(descriptorBytes);
  return Object.freeze({
    ...initial,
    snapshot: attachBackgroundAuthorizationRecipient(initial.snapshot, {
      recipientGeneration: 0,
      descriptorDigest: Buffer.from(descriptorHash).toString("hex"),
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey:
        Buffer.from(descriptor.recipientPublicKey).toString("base64url"),
      expiresAt: descriptor.expiresAt,
      now: NOW,
    }),
    descriptorBytes,
  });
}

describe("protected Stenographer restart-safe work composition", () => {
  test("builds the descriptor from a freshly recovered exact claim", async () => {
    const crypto = new LatticeCrypto(seededRng(24_101), {
      now: () => NOW,
    });
    const claim = extractionClaim();
    const calls: string[] = [];
    const initial = createProtectedStenographerAuthorizationRecord({
      requestId: "request-restart",
      idempotencyKey: "idempotency-request-restart",
      work: { claim, compactionModelId: null },
      authority: authority(),
      now: NOW,
    });
    const factory = createProtectedStenographerDescriptorFactory({
      crypto,
      recovery: recovery(extractionWork(claim), calls),
      resolveCurrentAuthority: currentAuthority,
      now: () => NOW,
    });

    const attempt = {
      requestId: initial.snapshot.requestId,
      workId: initial.snapshot.workId,
      namespaceId: initial.snapshot.namespaceId,
      recipientGeneration: 0,
      recipientKeyId: "recipient-request-restart-0",
      recipientPublicKey: new Uint8Array(65).fill(0x31),
      expiresAt: NOW + 60_000,
    };
    const encoded = await factory.create({
      record: initial,
      attempt,
    });
    const descriptor =
      decodeBackgroundWorkDescriptorV1(encoded.descriptorBytes);

    expect(calls).toEqual(["request-restart"]);
    expect(descriptor.requestId).toBe("request-restart");
    expect(descriptor.workKind).toBe("stenographer.extraction");
    expect(descriptor.source).toMatchObject({
      kind: "journal_range",
      startSequence: 41,
      endSequence: 41,
      rebuildGeneration: 7,
    });
    expect(
      Buffer.from(descriptor.source.fingerprint).toString("hex"),
    ).toBe(Buffer.from(claim.coveredRangeFingerprint).toString("hex"));
    expect(descriptor.inputObjectIds).toEqual([
      objectId(INPUT_OBJECT_ID),
    ]);
    expect(descriptor.outputObjectIds[0]).toBe(
      objectId(OUTPUT_OBJECT_ID),
    );
    expect(descriptor.outputObjectIds).toHaveLength(5);
    expect(descriptor.outputObjectMetadata.every(
      (metadata) =>
        metadata.objectType === "nautilo.reflection.record.v1",
    )).toBe(true);
    expect(descriptor.maximumPlaintextBytes).toBe(
      BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES,
    );
    expect(descriptor.maximumCiphertextBytes).toBe(
      BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES,
    );
  });

  test("reconstructs execution work after composition restart without a cache", async () => {
    const crypto = new LatticeCrypto(seededRng(24_102), {
      now: () => NOW,
    });
    const claim = extractionClaim();
    const initial = createProtectedStenographerAuthorizationRecord({
      requestId: "request-restart-recovery",
      idempotencyKey: "idempotency-request-restart-recovery",
      work: { claim, compactionModelId: null },
      authority: authority(),
      now: NOW,
    });
    const firstProcessCalls: string[] = [];
    const firstProcess = createProtectedStenographerDescriptorFactory({
      crypto,
      recovery: recovery(extractionWork(claim), firstProcessCalls),
      resolveCurrentAuthority: currentAuthority,
      now: () => NOW,
    });
    const descriptor = await firstProcess.create({
      record: initial,
      attempt: {
        requestId: initial.snapshot.requestId,
        workId: initial.snapshot.workId,
        namespaceId: initial.snapshot.namespaceId,
        recipientGeneration: 0,
        recipientKeyId: "recipient-request-restart-recovery-0",
        recipientPublicKey: new Uint8Array(65).fill(0x31),
        expiresAt: NOW + 60_000,
      },
    });
    const durable = preparedRecord(
      initial,
      descriptor.descriptorBytes,
      descriptor.descriptorHash,
    );

    // New port instance models a new process. The original factory and its
    // recovered claim are intentionally not available.
    const restartedProcessCalls: string[] = [];
    const recovered = await recoverProtectedStenographerExecutionWork({
      record: durable,
      recovery: recovery(extractionWork(claim), restartedProcessCalls),
      now: new Date(NOW + 1),
    });

    expect(firstProcessCalls).toEqual(["request-restart-recovery"]);
    expect(restartedProcessCalls).toEqual(["request-restart-recovery"]);
    expect(recovered.status).toBe("recovered");
    if (recovered.status !== "recovered") return;
    expect(recovered.work).toMatchObject({
      requestId: "request-restart-recovery",
      workId: BATCH_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sourceBatchId: BATCH_ID,
      rebuildGeneration: 7,
      fromMessageIdExclusive: 40,
      throughMessageIdInclusive: 41,
    });
    expect(recovered.claim.leaseToken).toBe(claim.leaseToken);
  });

  test("reconstructs reconciliation work after the expired recipient is discarded", async () => {
    const crypto = new LatticeCrypto(seededRng(24_108), {
      now: () => NOW,
    });
    const claim = extractionClaim();
    const initial = createProtectedStenographerAuthorizationRecord({
      requestId: "request-reconciliation-recovery",
      idempotencyKey: "idempotency-request-reconciliation-recovery",
      work: { claim, compactionModelId: null },
      authority: authority(),
      now: NOW,
    });
    const factory = createProtectedStenographerDescriptorFactory({
      crypto,
      recovery: recovery(extractionWork(claim), []),
      resolveCurrentAuthority: currentAuthority,
      now: () => NOW,
    });
    const encoded = await factory.create({
      record: initial,
      attempt: {
        requestId: initial.snapshot.requestId,
        workId: initial.snapshot.workId,
        namespaceId: initial.snapshot.namespaceId,
        recipientGeneration: 0,
        recipientKeyId: "recipient-request-reconciliation-recovery-0",
        recipientPublicKey: new Uint8Array(65).fill(0x31),
        expiresAt: NOW + 60_000,
      },
    });
    const prepared = preparedRecord(
      initial,
      encoded.descriptorBytes,
      encoded.descriptorHash,
    );
    const recipient = prepared.snapshot.recipient!;
    const responseBytes = new Uint8Array([1]);
    const responseDigest = createHash("sha256")
      .update(responseBytes)
      .digest("hex");
    const ready = markBackgroundAuthorizationGrantReady(prepared.snapshot, {
      kind: "processor",
      requestId: prepared.snapshot.requestId,
      descriptorDigest: prepared.snapshot.descriptorDigest!,
      recipientKeyId: recipient.recipientKeyId,
      recipientPublicKey: recipient.recipientPublicKey,
      expiresAt: recipient.expiresAt,
      responseDigest,
      credentialDigest: "22".repeat(32),
      issuingHumanId: "human-reconciliation",
      issuingDeviceId: "device-reconciliation",
      recipientGeneration: 0,
      now: NOW + 1,
    });
    const claimed = claimBackgroundAuthorizationRequest(
      ready,
      "claim-reconciliation",
      NOW + 2,
      NOW + 30_000,
    );
    const running = markBackgroundAuthorizationRunning(claimed, NOW + 3);
    const reconciliation = markBackgroundAuthorizationPublicationReconciliation(
      running,
      NOW + 30_001,
    );

    expect(reconciliation.recipient).toBeNull();
    expect((await recoverProtectedStenographerExecutionWork({
      record: {
        ...prepared,
        snapshot: reconciliation,
        acceptedMaterial: {
          responseBytes,
          credentialId: "credential-reconciliation",
          issuingDeviceAuthorizationRevision: 1,
          issuerSigningPublicKeyHash: new Uint8Array(32).fill(3),
          authorizationExpiresAt: recipient.expiresAt,
        },
      },
      recovery: recovery(extractionWork(claim), []),
      now: new Date(NOW + 30_002),
    })).status).toBe("recovered");
  });

  test("fails closed when recovered product work no longer matches the durable descriptor", async () => {
    const crypto = new LatticeCrypto(seededRng(24_103), {
      now: () => NOW,
    });
    const claim = extractionClaim();
    const initial = createProtectedStenographerAuthorizationRecord({
      requestId: "request-stale-recovery",
      idempotencyKey: "idempotency-request-stale-recovery",
      work: { claim, compactionModelId: null },
      authority: authority(),
      now: NOW,
    });
    const factory = createProtectedStenographerDescriptorFactory({
      crypto,
      recovery: recovery(extractionWork(claim), []),
      resolveCurrentAuthority: currentAuthority,
      now: () => NOW,
    });
    const descriptor = await factory.create({
      record: initial,
      attempt: {
        requestId: initial.snapshot.requestId,
        workId: initial.snapshot.workId,
        namespaceId: initial.snapshot.namespaceId,
        recipientGeneration: 0,
        recipientKeyId: "recipient-request-stale-recovery-0",
        recipientPublicKey: new Uint8Array(65).fill(0x31),
        expiresAt: NOW + 60_000,
      },
    });
    const durable = preparedRecord(
      initial,
      descriptor.descriptorBytes,
      descriptor.descriptorHash,
    );
    const staleClaim = extractionClaim(
      new Uint8Array(32).fill(0x99),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      recoverProtectedStenographerExecutionWork({
        record: durable,
        recovery: recovery(extractionWork(staleClaim), []),
        now: new Date(NOW + 1),
      }),
    ).rejects.toThrow("false source fingerprint");
  });

  test("preserves non-lexicographic compaction inputs across restart", async () => {
    const crypto = new LatticeCrypto(seededRng(24_104), {
      now: () => NOW,
    });
    const work = compactionWork();
    const initial = createProtectedStenographerAuthorizationRecord({
      requestId: "request-compaction-restart",
      idempotencyKey: "idempotency-request-compaction-restart",
      work,
      authority: authority(),
      now: NOW,
    });
    const factory = createProtectedStenographerDescriptorFactory({
      crypto,
      recovery: recovery(work, []),
      resolveCurrentAuthority: currentAuthority,
      now: () => NOW,
    });
    const attempt = await factory.create({
      record: initial,
      attempt: {
        requestId: initial.snapshot.requestId,
        workId: initial.snapshot.workId,
        namespaceId: initial.snapshot.namespaceId,
        recipientGeneration: 0,
        recipientKeyId: "recipient-request-compaction-restart-0",
        recipientPublicKey: new Uint8Array(65).fill(0x31),
        expiresAt: NOW + 60_000,
      },
    });
    const decoded =
      decodeBackgroundWorkDescriptorV1(attempt.descriptorBytes);
    expect(decoded.inputObjectIds).toEqual([
      objectId("z-journal-event-source"),
      objectId("a-journal-event-source"),
    ]);
    expect(decoded).toMatchObject({
      workKind: "stenographer.compaction",
      purpose: "journal.compact",
      source: {
        kind: "journal_range",
        startSequence: 2,
        endSequence: 5,
        rebuildGeneration: 7,
      },
    });
    const recovered = await recoverProtectedStenographerExecutionWork({
      record: preparedRecord(
        initial,
        attempt.descriptorBytes,
        attempt.descriptorHash,
      ),
      recovery: recovery(work, []),
      now: new Date(NOW + 1),
    });
    expect(recovered.status).toBe("recovered");
    if (recovered.status !== "recovered") return;
    expect(recovered.claim.kind).toBe("compaction");
    expect(recovered.work).toMatchObject({
      modelId: "stenographer-compaction-model",
      rollupId: "90000000-0000-4000-8000-000000000001",
      rebuildGeneration: 7,
    });
  });

  test("requires current authority and rejects substitution before recovery", async () => {
    const crypto = new LatticeCrypto(seededRng(24_105), {
      now: () => NOW,
    });
    const work = extractionWork();
    const initial = createProtectedStenographerAuthorizationRecord({
      requestId: "request-stale-authority",
      idempotencyKey: "idempotency-request-stale-authority",
      work,
      authority: authority(),
      now: NOW,
    });
    let recoveryCalls = 0;
    const exactRecovery: ProtectedStenographerDurableWorkRecoveryPort = {
      recoverExact: () => {
        recoveryCalls += 1;
        return Promise.resolve({ status: "recovered", work });
      },
    };
    const attempt = {
      requestId: initial.snapshot.requestId,
      workId: initial.snapshot.workId,
      namespaceId: initial.snapshot.namespaceId,
      recipientGeneration: 0,
      recipientKeyId: "recipient-request-stale-authority-0",
      recipientPublicKey: new Uint8Array(65).fill(0x31),
      expiresAt: NOW + 60_000,
    };
    const unavailable = createProtectedStenographerDescriptorFactory({
      crypto,
      recovery: exactRecovery,
      resolveCurrentAuthority: () => Promise.resolve(null),
      now: () => NOW,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(unavailable.create({ record: initial, attempt }))
      .rejects.toThrow("current crypto authority is unavailable");
    const substituted = createProtectedStenographerDescriptorFactory({
      crypto,
      recovery: exactRecovery,
      resolveCurrentAuthority: () => Promise.resolve({
        ...authority(),
        expectedPolicyRevision: 14,
      }),
      now: () => NOW,
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(substituted.create({ record: initial, attempt }))
      .rejects.toThrow("no longer matches");
    expect(recoveryCalls).toBe(0);
  });

  test("rejects unknown fields returned by the recovery port", () => {
    const claim = extractionClaim();
    expect(() => createProtectedStenographerAuthorizationRecord({
      requestId: "request-extra-field",
      idempotencyKey: "idempotency-request-extra-field",
      work: {
        claim,
        compactionModelId: null,
        unexpected: "not permitted",
      } as unknown as ProtectedStenographerRecoveredWork,
      authority: authority(),
      now: NOW,
    })).toThrow("contains unknown or missing fields");
  });

  test("rejects input inventory reorder away from binding order", () => {
    const claim = compactionClaim();
    expect(() => createProtectedStenographerAuthorizationRecord({
      requestId: "request-reordered-inputs",
      idempotencyKey: "idempotency-request-reordered-inputs",
      work: {
        claim: {
          ...claim,
          inputObjectIds: [...claim.inputObjectIds].reverse(),
        },
        compactionModelId: "stenographer-compaction-model",
      },
      authority: authority(),
      now: NOW,
    })).toThrow("input order does not match source bindings");
  });
});


describe("current Domain-key Stenographer work composition", () => {
  test("binds the derived processor v2 plan to every signed authority coordinate", () => {
    const work = extractionWork();
    const signedAuthority = {policyRevision: 13, namespace: {
      serverId: "https://nautilo.example", roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 11, namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(1), domainId: "domain-room-1",
      domainKeyGeneration: 4, domainAuthorizationRevision: 5,
      domainHeadDigest: new Uint8Array(32).fill(2), bundleRevision: 6,
      bundleDigest: new Uint8Array(32).fill(3),
    }};
    const baseline = createCurrentProtectedStenographerAuthorizationRecord({
      requestId: "authority-bound-request", work, authority: signedAuthority, now: NOW,
    });
    const otherRoomId = "10000000-0000-4000-8000-000000000099";
    const otherNamespaceId = "20000000-0000-4000-8000-000000000099";
    const cases = [
      ["policyRevision", work, {...signedAuthority, policyRevision: 14}],
      ["serverId", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        serverId: "https://other.nautilo.example"}}],
      ["roomId", extractionWork({...extractionClaim(), roomId: otherRoomId}),
        {...signedAuthority, namespace: {...signedAuthority.namespace, roomId: otherRoomId}}],
      ["namespaceId", extractionWork({...extractionClaim(), namespaceId: otherNamespaceId}),
        {...signedAuthority, namespace: {...signedAuthority.namespace, namespaceId: otherNamespaceId}}],
      ["namespaceAccessRevision", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        namespaceAccessRevision: 12}}],
      ["namespaceKeyGeneration", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        namespaceKeyGeneration: 4}}],
      ["namespaceHeadDigest", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        namespaceHeadDigest: new Uint8Array(32).fill(4)}}],
      ["domainId", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        domainId: "domain-room-2"}}],
      ["domainKeyGeneration", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        domainKeyGeneration: 5}}],
      ["domainAuthorizationRevision", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        domainAuthorizationRevision: 6}}],
      ["domainHeadDigest", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        domainHeadDigest: new Uint8Array(32).fill(5)}}],
      ["bundleRevision", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        bundleRevision: 7}}],
      ["bundleDigest", work, {...signedAuthority, namespace: {...signedAuthority.namespace,
        bundleDigest: new Uint8Array(32).fill(6)}}],
    ] as const;

    expect(baseline.idempotencyKey.length).toBeLessThanOrEqual(128);
    for (const [coordinate, changedWork, changedAuthority] of cases) {
      const changed = createCurrentProtectedStenographerAuthorizationRecord({
        requestId: "authority-bound-request", work: changedWork,
        authority: changedAuthority, now: NOW,
      });
      expect(changed.idempotencyKey, coordinate).not.toBe(baseline.idempotencyKey);
      expect(Buffer.from(changed.workIdentityHash).toString("hex"), coordinate)
        .not.toBe(Buffer.from(baseline.workIdentityHash).toString("hex"));
    }
  });

  test("rejects authority head and bundle drift at descriptor creation and recovery", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await crypto.generateEncryptionKeyPair();
    const work = extractionWork();
    const signedAuthority = {policyRevision: 13, namespace: {
      serverId: "https://nautilo.example", roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 11, namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(1), domainId: "domain-room-1",
      domainKeyGeneration: 4, domainAuthorizationRevision: 5,
      domainHeadDigest: new Uint8Array(32).fill(2), bundleRevision: 6,
      bundleDigest: new Uint8Array(32).fill(3),
    }};
    const initial = createCurrentProtectedStenographerAuthorizationRecord({
      requestId: "authority-drift-request", work, authority: signedAuthority, now: NOW,
    });
    const source = recovery(work, []);
    const attempt = {
      requestId: initial.snapshot.requestId, workId: work.claim.workId,
      namespaceId: NAMESPACE_ID, recipientGeneration: 0,
      recipientKeyId: "authority-drift-recipient", recipientPublicKey: recipient.publicKey,
      expiresAt: NOW + 300_000,
    };
    const changedNamespaces = [
      ["namespaceHeadDigest", {...signedAuthority.namespace,
        namespaceHeadDigest: new Uint8Array(32).fill(4)}],
      ["domainHeadDigest", {...signedAuthority.namespace,
        domainHeadDigest: new Uint8Array(32).fill(5)}],
      ["bundleRevision", {...signedAuthority.namespace, bundleRevision: 7}],
      ["bundleDigest", {...signedAuthority.namespace,
        bundleDigest: new Uint8Array(32).fill(6)}],
    ] as const;
    for (const [coordinate, namespace] of changedNamespaces) {
      const driftedFactory = createCurrentProtectedStenographerDescriptorFactory({
        crypto, recovery: source,
        resolveCurrentAuthority: () => Promise.resolve({policyRevision: 13, namespace}),
        now: () => NOW,
      });
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driftedFactory.create({record: initial, attempt}), coordinate)
        .rejects.toThrow("Current signed authority changed");
    }

    const encoded = await createCurrentProtectedStenographerDescriptorFactory({
      crypto, recovery: source, resolveCurrentAuthority: () => Promise.resolve(signedAuthority),
      now: () => NOW,
    }).create({record: initial, attempt});
    const descriptor = decodeBackgroundProcessorWorkDescriptorV2(encoded.descriptorBytes);
    for (const [coordinate, namespace] of changedNamespaces) {
      const descriptorBytes = encodeBackgroundWorkDescriptorV2({...descriptor, authority: namespace});
      const driftedRecord = preparedRecord(initial, descriptorBytes, crypto.hash(descriptorBytes));
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(recoverProtectedStenographerExecutionWork({
        record: driftedRecord, recovery: source, now: new Date(NOW + 1),
      }), coordinate).rejects.toThrow("Signed authority differs from current execution plan");
    }
    recipient.privateKey.fill(0);
  });

  test("recovers a retained v2 request through its original descriptor", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await crypto.generateEncryptionKeyPair();
    const work = extractionWork();
    const signedAuthority = {policyRevision: 13, namespace: {
      serverId: "https://nautilo.example", roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 11, namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(1), domainId: "domain-room-1",
      domainKeyGeneration: 4, domainAuthorizationRevision: 5,
      domainHeadDigest: new Uint8Array(32).fill(2), bundleRevision: 6,
      bundleDigest: new Uint8Array(32).fill(3),
    }};
    const current = createCurrentProtectedStenographerAuthorizationRecord({
      requestId: "retained-v2-request", work, authority: signedAuthority, now: NOW,
    });
    const oldIdentity = currentExecutionPlanIdentity({
      work, domainId: signedAuthority.namespace.domainId,
      expectedNamespaceAccessRevision: signedAuthority.namespace.namespaceAccessRevision,
      expectedPolicyRevision: signedAuthority.policyRevision,
    });
    const retained = {...current, workIdentityHash: oldIdentity,
      idempotencyKey: currentExecutionPlanIdempotencyKey(oldIdentity)};
    const source = recovery(work, []);
    const encoded = await createCurrentProtectedStenographerDescriptorFactory({
      crypto, recovery: source, resolveCurrentAuthority: () => Promise.resolve(signedAuthority),
      now: () => NOW,
    }).create({record: retained, attempt: {
      requestId: retained.snapshot.requestId, workId: work.claim.workId,
      namespaceId: NAMESPACE_ID, recipientGeneration: 0,
      recipientKeyId: "retained-v2-recipient", recipientPublicKey: recipient.publicKey,
      expiresAt: NOW + 300_000,
    }});
    const recovered = await recoverProtectedStenographerExecutionWork({
      record: preparedRecord(retained, encoded.descriptorBytes, encoded.descriptorHash),
      recovery: source, now: new Date(NOW + 1),
    });
    expect(retained.idempotencyKey).toStartWith("stenographer-processor-v2:");
    expect(recovered.status).toBe("recovered");
    if (recovered.status === "recovered") {
      expect(recovered.work.requestId).toBe("retained-v2-request");
      expect(recovered.work.workId).toBe(work.claim.workId);
      expect(recovered.work.namespaceId).toBe(work.claim.namespaceId);
    }
    recipient.privateKey.fill(0);
    oldIdentity.fill(0);
  });

  test("recovers exact extraction and compaction work with no legacy epoch or processor permission", async () => {
    const crypto = new LatticeCrypto();
    const recipient = await crypto.generateEncryptionKeyPair();
    for (const work of [extractionWork(), compactionWork()]) {
      const authority = {policyRevision: 13, namespace: {
        serverId: "https://nautilo.example", roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
        namespaceAccessRevision: 11, namespaceKeyGeneration: 3, namespaceHeadDigest: new Uint8Array(32).fill(1),
        domainId: "domain-room-1", domainKeyGeneration: 4, domainAuthorizationRevision: 5,
        domainHeadDigest: new Uint8Array(32).fill(2), bundleRevision: 6, bundleDigest: new Uint8Array(32).fill(3),
      }};
      const initial = createCurrentProtectedStenographerAuthorizationRecord({requestId: "current-request",
         work, authority, now: NOW});
      expect(initial.snapshot.formatVersion).toBe(2);
      expect(initial.snapshot.credentialSubject).not.toHaveProperty("authorizationRevision");
      expect(initial.expectedDomainEpoch).toBeNull();
      expect(initial.processorAuthorizationRevision).toBeNull();
      const source = recovery(work, []);
      const descriptors = createCurrentProtectedStenographerDescriptorFactory({crypto, recovery: source,
        resolveCurrentAuthority: () => Promise.resolve(authority), now: () => NOW});
      const result = await descriptors.create({record: initial, attempt: {
        requestId: initial.snapshot.requestId, workId: work.claim.workId, namespaceId: NAMESPACE_ID,
        recipientGeneration: 0, recipientKeyId: "current-recipient", recipientPublicKey: recipient.publicKey,
        expiresAt: NOW + 300_000,
      }});
      const descriptor = decodeBackgroundProcessorWorkDescriptorV2(result.descriptorBytes);
      expect(descriptor.authority).toEqual(authority.namespace);
      expect(descriptor.source.fingerprint).toEqual(work.claim.kind === "extraction"
        ? work.claim.coveredRangeFingerprint : work.claim.sourceBindingFingerprint);
      const record = preparedRecord(initial, result.descriptorBytes, result.descriptorHash);
      const executed = await recoverProtectedStenographerExecutionWork({record, recovery: source, now: new Date(NOW + 1)});
      expect(executed.status).toBe("recovered");
      for (const changed of [
        {...descriptor, authority: {...descriptor.authority, roomId: "other-room"}},
        {...descriptor, source: {...descriptor.source, endSequence: descriptor.source.endSequence + 1}},
        {...descriptor, outputSlots: descriptor.outputSlots.map((slot, index) => index === 0
          ? {...slot, objectId: "other-output"} : slot)},
      ]) {
        const descriptorBytes = encodeBackgroundWorkDescriptorV2(changed);
        const changedRecord = preparedRecord(initial, descriptorBytes, crypto.hash(descriptorBytes));
        const rejected = await recoverProtectedStenographerExecutionWork({record: changedRecord, recovery: source,
          now: new Date(NOW + 1)}).then(() => false, () => true);
        expect(rejected).toBe(true);
      }
    }
    recipient.privateKey.fill(0);
  });
});


function patchRecoveredClaim(work: ProtectedStenographerRecoveredWork,
  patch: Partial<Pick<ProtectedStenographerRecoveredWork["claim"], "attemptCount" | "leaseToken" | "leaseExpiresAt" | "createdAt">>): ProtectedStenographerRecoveredWork {
  return work.compactionModelId === null
    ? {compactionModelId: null, claim: {...work.claim, ...patch}}
    : {compactionModelId: work.compactionModelId, claim: {...work.claim, ...patch}};
}

describe("cancelled current Stenographer metadata identity", () => {
  test("survives exact lease reacquisition without restoring descriptor authority", () => {
    for (const work of [extractionWork(), compactionWork()]) {
      const initial = createCurrentProtectedStenographerAuthorizationRecord({requestId: "cancelled-request",
         work, now: NOW, authority: {policyRevision: 13, namespace: {
          serverId: "server", roomId: ROOM_ID, namespaceId: NAMESPACE_ID, namespaceAccessRevision: 11,
          namespaceKeyGeneration: 3, namespaceHeadDigest: new Uint8Array(32), domainId: "domain", domainKeyGeneration: 4,
          domainAuthorizationRevision: 5, domainHeadDigest: new Uint8Array(32), bundleRevision: 6, bundleDigest: new Uint8Array(32)}}});
      const cancelled = {...initial, snapshot: cancelBackgroundAuthorizationRequest(initial.snapshot, "cancelled", NOW + 1), finishedAt: NOW + 1};
      const reacquired = patchRecoveredClaim(work, {attemptCount: work.claim.attemptCount + 1,
        leaseToken: "50000000-0000-4000-8000-000000000099", leaseExpiresAt: new Date(NOW + 300_000)});
      expect(() => assertCancelledProtectedStenographerWorkIdentity({record: cancelled, work: reacquired})).not.toThrow();
      expect(cancelled.snapshot.recipient).toBeNull(); expect(cancelled.descriptorBytes).toBeNull();
      expect(() => assertCancelledProtectedStenographerWorkIdentity({record: initial, work: reacquired})).toThrow("Cancelled unconsumed");
      expect(() => assertCancelledProtectedStenographerWorkIdentity({record: {...cancelled, workIdentityHash: new Uint8Array(32).fill(99)}, work: reacquired})).toThrow("durable identity");
      expect(() => assertCancelledProtectedStenographerWorkIdentity({record: cancelled,
        work: patchRecoveredClaim(reacquired, {createdAt: new Date(NOW + 1).toISOString()})})).toThrow("durable identity");
    }
  });
});

async function committedCurrentFixture(outputCount: 0 | 1 = 1) {
  const crypto = new LatticeCrypto();
  const recipient = await crypto.generateEncryptionKeyPair();
  const work = extractionWork();
  if (work.claim.kind !== "extraction")
    throw new Error("Expected extraction fixture");
  const authority = {
    policyRevision: 13,
    namespace: {
      serverId: "https://nautilo.example",
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 11,
      namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(1),
      domainId: "domain-room-1",
      domainKeyGeneration: 4,
      domainAuthorizationRevision: 5,
      domainHeadDigest: new Uint8Array(32).fill(2),
      bundleRevision: 6,
      bundleDigest: new Uint8Array(32).fill(3),
    },
  };
  const initial = createCurrentProtectedStenographerAuthorizationRecord({
    requestId: "original-request",

    work,
    authority,
    now: NOW,
  });
  const source = recovery(work, []);
  const encoded = await createCurrentProtectedStenographerDescriptorFactory({
    crypto,
    recovery: source,
    resolveCurrentAuthority: () => Promise.resolve(authority),
    now: () => NOW,
  }).create({
    record: initial,
    attempt: {
      requestId: initial.snapshot.requestId,
      workId: work.claim.workId,
      namespaceId: NAMESPACE_ID,
      recipientGeneration: 0,
      recipientKeyId: "original-recipient",
      recipientPublicKey: recipient.publicKey,
      expiresAt: NOW + 300_000,
    },
  });
  const awaiting = preparedRecord(
    initial,
    encoded.descriptorBytes,
    encoded.descriptorHash,
  );
  const r = awaiting.snapshot.recipient!;
  const ready = markBackgroundAuthorizationGrantReady(awaiting.snapshot, {
    kind: "processor",
    requestId: awaiting.snapshot.requestId,
    descriptorDigest: awaiting.snapshot.descriptorDigest!,
    recipientKeyId: r.recipientKeyId,
    recipientPublicKey: r.recipientPublicKey,
    expiresAt: r.expiresAt,
    responseDigest: createHash("sha256")
      .update(new Uint8Array([1]))
      .digest("hex"),
    credentialDigest: "22".repeat(32),
    issuingHumanId: "human",
    issuingDeviceId: "device",
    recipientGeneration: 0,
    now: NOW + 1,
  });
  const running = markBackgroundAuthorizationRunning(
    claimBackgroundAuthorizationRequest(ready, "claim", NOW + 2, NOW + 60_000),
    NOW + 3,
  );
  const original: BackgroundAuthorizationRecord = {
    ...awaiting,
    snapshot: markBackgroundAuthorizationPublicationReconciliation(
      running,
      NOW + 60_001,
    ),
    acceptedMaterial: {
      responseBytes: new Uint8Array([1]),
      credentialId: "original-credential",
      issuingDeviceAuthorizationRevision: 1,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(1),
      authorizationExpiresAt: NOW + 300_000,
    },
  };
  const descriptor = decodeBackgroundProcessorWorkDescriptorV2(encoded.descriptorBytes);
  const slot = descriptor.outputSlots[0]!;
  const planBytes = encodeProtectedJournalAttachmentPlanV1({
    kind: "extraction",
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    rebuildGeneration: work.claim.rebuildGeneration,
    sourceBatchId: BATCH_ID,
    statusUpdates: [],
    events:
      outputCount === 0
        ? []
        : [
            {
              eventId: work.claim.outputSlots[0]!.eventId,
              objectId: slot.objectId,
              sequence: 1,
              kind: "fact",
              status: "active",
              supersedesEventId: null,
              resolvesEventId: null,
              sourceMessageIds: [41],
              sourceBatchId: BATCH_ID,
              batchLocalOrdinal: 0,
              extractorVersion: work.claim.extractorVersion,
              createdAt: work.claim.createdAt,
            },
          ],
    foldedBatchLocalOrdinals: [],
    rollup: null,
  });
  const receipt: ProtectedJournalPublicationRecord = {
    publicationId: original.snapshot.requestId,
    requestId: original.snapshot.requestId,
    roomId: ROOM_ID,
    namespaceIdAtAllocation: NAMESPACE_ID,
    workId: original.snapshot.workId,
    sourceBatchId: BATCH_ID,
    rebuildGeneration: work.claim.rebuildGeneration,
    workIdentityHash: original.workIdentityHash,
    descriptorHash: encoded.descriptorHash,
    attachmentPlanVersion: 1,
    attachmentPlanBytes: planBytes,
    attachmentPlanHash: crypto.hash(planBytes),
    outputObjectCount: outputCount,
    state: "crypto_committed",
    leaseToken: null,
    leaseExpiresAt: null,
    retryCount: 0,
    maximumAttempts: 8,
    failureCode: null,
    lastFailureAt: null,
    cryptoCommittedAt: new Date(NOW + 10),
    attachedAt: null,
    tombstoneRequestedAt: null,
    tombstonedAt: null,
    lastAuditedAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
  const encrypted = encryptObjectPayload(
    crypto,
    {
      objectId: objectId(slot.objectId),
      keyClass: "ai",
      objectType: slot.objectType,
      createdAt: unixTimestamp(slot.createdAt),
    },
    new Uint8Array([1, 2, 3]),
  );
  encrypted.dek.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = new Uint8Array([9, 8, 7]);
  const calls: string[] = [];
  const options: Parameters<
    typeof prepareCurrentStenographerReconciliation
  >[0] = {
    original,
    publications: { get: async () => receipt },
    recovery: source,
    fence: {
      fence: async () => {
        calls.push("fence");
        return "fenced";
      },
    },
    committedTransforms: {
      verifyCommit: async () => {
        calls.push("commit");
        return {
          requestId: original.snapshot.requestId,
          workId: original.snapshot.workId,
          namespaceId: NAMESPACE_ID,
          descriptorHash: Uint8Array.from(encoded.descriptorHash),
          recipientGeneration: 0,
          claimId: "original-claim",
          outputObjectCount: outputCount,
          outputObjectIds: outputCount === 0 ? [] : [slot.objectId],
          authorizedOutputObjectIds: descriptor.outputSlots.map(
            (output) => output.objectId,
          ),
        };
      },
    },
    verifiedObjects: {
      verify: async () => {
        calls.push("verify-output");
        return {
          objectId: slot.objectId,
          namespaceId: NAMESPACE_ID,
          domainId: authority.namespace.domainId,
          workId: original.snapshot.workId,
          rebuildGeneration: work.claim.rebuildGeneration,
          outputOrdinal: 0,
          authorizedOutputObjectIds: descriptor.outputSlots.map(
            (output) => output.objectId,
          ),
          publisherNamespaceAccessRevision:
            authority.namespace.namespaceAccessRevision,
          payloadBytes,
          namespaceEnvelopeBytes: envelopeBytes,
        };
      },
    },
    now: new Date(NOW + 60_002),
    signal: new AbortController().signal,
  };
  return {
    crypto,
    work,
    authority,
    original,
    receipt,
    descriptor,
    options,
    recipient,
    calls,
    payloadBytes,
    envelopeBytes,
  };
}

describe("committed current result restart authorization", () => {
  test.each([0, 1] as const)(
    "derives a separate exact %s-output request without executing or republishing",
    async (count) => {
      const f = await committedCurrentFixture(count);
      const originalBytes = Uint8Array.from(f.original.descriptorBytes!);
      const prepared = await prepareCurrentStenographerReconciliation(
        f.options,
      );
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") throw new Error("missing plan");
      const fresh = createCurrentStenographerReconciliationRecord({
        crypto: f.crypto,
        prepared,
        authority: f.authority,
        requestId: "fresh-request",
        now: NOW + 60_010,
      });
      expect(fresh.snapshot.requestId).not.toBe(f.original.snapshot.requestId);
      expect(fresh.workKind).toBe("stenographer.publication_reconcile");
      const encoded = currentStenographerReconciliationDescriptor({
        crypto: f.crypto,
        prepared,
        authority: f.authority,
        record: fresh,
        attempt: {
          requestId: fresh.snapshot.requestId,
          workId: fresh.snapshot.workId,
          namespaceId: NAMESPACE_ID,
          recipientGeneration: 0,
          recipientKeyId: "fresh-recipient",
          recipientPublicKey: f.recipient.publicKey,
          expiresAt: NOW + 200_000,
        },
        now: NOW + 60_010,
      });
      const descriptor = decodeBackgroundProcessorWorkDescriptorV2(
        encoded.descriptorBytes,
      );
      expect(descriptor.outputSlots).toEqual([]);
      expect(descriptor.inputBindings).toHaveLength(count);
      expect(descriptor.source.fingerprint).toEqual(
        publicationReconciliationFingerprintV2(f.crypto, prepared.binding),
      );
      expect(f.original.descriptorBytes).toEqual(originalBytes);
      expect(f.calls).toEqual(
        count === 0 ? ["commit"] : ["commit", "verify-output"],
      );
      if (count === 1) {
        expect(f.payloadBytes.every((byte) => byte === 0)).toBe(true);
        expect(f.envelopeBytes.every((byte) => byte === 0)).toBe(true);
      }
      const rotated = {
        ...f.authority,
        policyRevision: 14,
        namespace: {
          ...f.authority.namespace,
          namespaceKeyGeneration: 4,
          domainKeyGeneration: 5,
          bundleRevision: 7,
        },
      };
      const replacement = createCurrentStenographerReconciliationRecord({
        crypto: f.crypto,
        prepared,
        authority: rotated,
        requestId: "rotated-request",
        now: NOW + 60_011,
      });
      expect(replacement.idempotencyKey).not.toBe(fresh.idempotencyKey);
      expect(replacement.workIdentityHash).not.toEqual(fresh.workIdentityHash);
    },
  );

  test("fences an expired publisher before proving its result; missing marker never requests body or model work", async () => {
    const f = await committedCurrentFixture();
    const result = await prepareCurrentStenographerReconciliation({
      ...f.options,
      original: {
        ...f.original,
        snapshot: { ...f.original.snapshot, state: "running" },
      },
      publications: { get: async () => ({ ...f.receipt, state: "reserved" }) },
      committedTransforms: {
        verifyCommit: async () => {
          f.calls.push("commit");
          return null;
        },
      },
      recovery: {
        recoverExact: () => {
          throw new Error("must not recover uncommitted model work");
        },
      },
    });
    expect(result).toEqual({ status: "pending" });
    expect(f.calls).toEqual(["fence", "commit"]);
  });

  test("rejects a substituted commit before output access", async () => {
    const f = await committedCurrentFixture();
    const error: unknown = await prepareCurrentStenographerReconciliation({
      ...f.options,
      committedTransforms: {
        verifyCommit: async (request) => ({
          ...(await f.options.committedTransforms.verifyCommit(request))!,
          outputObjectCount: 0,
          outputObjectIds: [],
        }),
      },
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(f.calls).toEqual(["commit"]);
  });

  test("keeps device reconciliation waits outside the execution failure budget", async () => {
    const f = await committedCurrentFixture(0);
    let snapshot = f.original.snapshot;
    for (let count = 0; count < 20; count++)
      snapshot = scheduleBackgroundAuthorizationPublicationRetry(snapshot, {
        now: NOW + 61_000 + count,
        nextAttemptAt: NOW + 61_001 + count,
      });
    expect(snapshot.state).toBe("publication_reconciliation");
    expect(snapshot.retryCount).toBe(f.original.snapshot.retryCount);
  });
});

async function currentZeroOutputCoordinatorFixture(acceptImmediately = true) {
  const f = await committedCurrentFixture(0);
  const plan = await prepareCurrentStenographerReconciliation(f.options);
  if (plan.status !== "ready") throw new Error("Expected committed fixture");
  const now = NOW + 60_010;
  let currentNow = now;
  let beforeLoad: (() => Promise<void>) | undefined;
  let beforeAttach: (() => Promise<void>) | undefined;
  let storedIntegrityFailure: ClassifiedDataOperationError | undefined;
  const fresh = createCurrentStenographerReconciliationRecord({
    crypto: f.crypto,
    prepared: plan,
    authority: f.authority,
    requestId: "fresh-coordinator",
    now,
  });
  const repository = new InMemoryBackgroundAuthorizationRepository();
  await repository.create(fresh);
  const recipients = new ProcessorTransformRecipientRegistry({
    crypto: f.crypto,
    now: () => currentNow,
  });
  const device = f.crypto.generateSigningKeyPair();
  let models = 0;
  let attachments = 0;
  let bodies = 0;
  const createCoordinator = (recipients: ProcessorTransformRecipientRegistry) => new ProtectedStenographerBackgroundCoordinator({
    repository,
    recipients,
    descriptors: {
      create: ({ record, attempt }) =>
        Promise.resolve(
          currentStenographerReconciliationDescriptor({
            crypto: f.crypto,
            prepared: plan,
            authority: f.authority,
            record,
            attempt,
            now: currentNow,
          }),
        ),
    },
    transformMaterial: {
      loadAccepted: async () => {
        await beforeLoad?.();
        return {
        status: "loaded",
        material: {
          formatVersion: 2,
          binding: plan.binding,
          claims: new BackgroundAuthorizationProcessorCredentialClaimPort(
            repository,
          ),
          resolveCurrentIssuer: async () => {
            if (storedIntegrityFailure !== undefined) {
              const record = await repository.get(fresh.snapshot.requestId);
              currentNow = record?.snapshot.claimExpiresAt ?? currentNow;
              throw storedIntegrityFailure;
            }
            return device.publicKey;
          },
          objects: {
            openInput: () => {
              bodies++;
              throw new Error("No output objects exist");
            },
            withNamespaceKey: () => {
              throw new Error("Empty commit opens no Namespace key");
            },
            attach: async ({ outputs, authorizeCommit }) => {
              await beforeAttach?.();
              expect(outputs).toEqual([]);
              await authorizeCommit();
              attachments++;
            },
          },
        },
        };
      },
    },
    execution: {
      executeWork: () => {
        models++;
        throw new Error("Model execution is forbidden");
      },
      reconcilePublication: async () =>
        attachments === 1 ? "completed" : "not_started",
    },
    now: () => currentNow,
    recipientKeyId: () => "fresh-key",
    claimId: () => "fresh-claim",
    nextAttemptAt: (_record, _reason, at) => at,
  });
  const coordinator = createCoordinator(recipients);
  try {
    expect(
      (await coordinator.prepareRecipient(fresh.snapshot.requestId)).status,
    ).toBe("device_authorization_required");
    const waiting = (await repository.get(fresh.snapshot.requestId))!;
    const responseBytes = await createBackgroundAuthorizationResponseV2(
      f.crypto,
      {
        credentialId: "fresh-credential",
        descriptorBytes: waiting.descriptorBytes!,
        issuerSigningPrivateKey: device.privateKey,
        domainKey: new Uint8Array(32).fill(4),
        issuer: {
          humanId: "human",
          deviceId: "device",
          deviceGeneration: 1,
          serverInstanceId: "instance",
          lineageGeneration: 1,
          epoch: 1,
          securityRevision: 1,
          headDigest: new Uint8Array(32).fill(7),
          signingPublicKeyHash: f.crypto.hash(device.publicKey),
        },
      },
    );
    const response = await verifyBackgroundAuthorizationResponseV2(f.crypto, {
      responseBytes,
      now,
      resolveCurrentIssuer: () => device.publicKey,
    });
    const acceptResponse = async () => {
      expect((await repository.acceptVerifiedResponse({
        response: { ...response, formatVersion: 2, kind: "processor" },
        acceptedAt: currentNow,
      })).status).toBe("accepted");
    };
    if (acceptImmediately) await acceptResponse();
    return {
      coordinator,
      acceptResponse,
      pauseAt: (phase: "claimed" | "running", wait: () => Promise<void>) => {
        if (phase === "claimed") beforeLoad = wait;
        else beforeAttach = wait;
      },
      setNow: (at: number) => { currentNow = at; },
      createPeer: () => {
        const recipients = new ProcessorTransformRecipientRegistry({
          crypto: f.crypto, now: () => currentNow,
        });
        return {recipients, coordinator: createCoordinator(recipients)};
      },
      repository,
      recipients,
      device,
      requestId: fresh.snapshot.requestId,
      models: () => models,
      bodies: () => bodies,
      attachments: () => attachments,
      failStoredEvidence: (failure: ClassifiedDataOperationError) => {
        storedIntegrityFailure = failure;
      },
    };
  } catch (cause) {
    recipients.close();
    device.privateKey.fill(0);
    throw cause;
  }
}

test("current coordinator consumes a fresh zero-output reconciliation grant without invoking its model worker", async () => {
  const f = await currentZeroOutputCoordinatorFixture();
  try {
    expect(f.models()).toBe(0);
    expect(f.attachments()).toBe(0);
    expect((await f.coordinator.run(f.requestId)).status).toBe("completed");
    expect((await f.repository.get(f.requestId))?.snapshot.state).toBe(
      "completed",
    );
    expect(f.models()).toBe(0);
    expect(f.bodies()).toBe(0);
    expect(f.attachments()).toBe(1);
    expect((await f.coordinator.run(f.requestId)).status).toBe("not_ready");
    expect(f.attachments()).toBe(1);
  } finally {
    f.recipients.close();
    f.device.privateKey.fill(0);
  }
});

test("current reconciliation rethrows corrupt stored evidence even when its claim expires during verification", async () => {
  const f = await currentZeroOutputCoordinatorFixture();
  const failure = new ClassifiedDataOperationError(
    "integrity",
    "corrupt stored processor evidence",
  );
  f.failStoredEvidence(failure);
  try {
    const error = await f.coordinator.run(f.requestId).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBe(failure);
    const record = await f.repository.get(f.requestId);
    expect(record?.snapshot.state).toBe("claimed");
    expect(record?.snapshot.recipientGeneration).toBe(0);
    expect(record?.snapshot.lastRetryReason).toBeNull();
    expect(record?.snapshot.retryCount).toBe(0);
    expect(f.models()).toBe(0);
    expect(f.bodies()).toBe(0);
    expect(f.attachments()).toBe(0);
  } finally {
    f.recipients.close();
    f.device.privateKey.fill(0);
  }
});


test("two servers preserve the owning recipient through device wait and accepted grant", async () => {
  const f = await currentZeroOutputCoordinatorFixture(false);
  const peer = f.createPeer();
  try {
    const waiting = await f.repository.get(f.requestId);
    for (let poll = 0; poll < 3; poll++) {
      expect(await peer.coordinator.prepareRecipient(f.requestId)).toEqual({status: "not_due"});
      expect((await f.coordinator.prepareRecipient(f.requestId)).status).toBe("device_authorization_required");
      expect(await f.repository.get(f.requestId)).toEqual(waiting);
    }
    await f.acceptResponse();
    const accepted = await f.repository.get(f.requestId);
    for (let poll = 0; poll < 3; poll++) {
      expect(await peer.coordinator.run(f.requestId)).toEqual({status: "not_ready"});
      expect(await f.repository.get(f.requestId)).toEqual(accepted);
    }
    expect(f.attachments()).toBe(0);
    expect((await f.coordinator.run(f.requestId)).status).toBe("completed");
    expect(f.attachments()).toBe(1);
    expect(f.models()).toBe(0);
  } finally {
    peer.recipients.close();
    f.recipients.close();
    f.device.privateKey.fill(0);
  }
});

test.each([false, true])("a restarted server takes over only at recipient expiry (accepted=%s)", async (accepted) => {
  const f = await currentZeroOutputCoordinatorFixture(accepted);
  const peer = f.createPeer();
  try {
    const original = (await f.repository.get(f.requestId))!;
    f.recipients.close();
    f.setNow(original.snapshot.recipient!.expiresAt - 1);
    expect(accepted ? await peer.coordinator.run(f.requestId)
      : await peer.coordinator.prepareRecipient(f.requestId)).toEqual({status: accepted ? "not_ready" : "not_due"});
    expect(await f.repository.get(f.requestId)).toEqual(original);
    f.setNow(original.snapshot.recipient!.expiresAt);
    if (accepted) {
      expect(await peer.coordinator.run(f.requestId)).toMatchObject({status: "retry_scheduled", recipientGeneration: 1});
    }
    expect(await peer.coordinator.prepareRecipient(f.requestId)).toMatchObject({status: "device_authorization_required", recipientGeneration: 1});
    expect((await f.repository.get(f.requestId))?.snapshot).toMatchObject({state: "awaiting_device", retryCount: 0});
    expect(f.attachments()).toBe(0);
    expect(f.models()).toBe(0);
  } finally {
    peer.recipients.close();
    f.recipients.close();
    f.device.privateKey.fill(0);
  }
});


test.each(["claimed", "running"] as const)("a previously queued peer preserves the owner's live %s lease", async (phase) => {
  const f = await currentZeroOutputCoordinatorFixture();
  const peer = f.createPeer();
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { entered = resolve; });
  f.pauseAt(phase, () => { entered(); return blocked; });
  const ownerRun = f.coordinator.run(f.requestId);
  try {
    await paused;
    const held = await f.repository.get(f.requestId);
    expect(held?.snapshot.state).toBe(phase);
    expect(await peer.coordinator.run(f.requestId)).toEqual({status: "not_ready"});
    expect(await f.repository.get(f.requestId)).toEqual(held);
    unblock();
    expect((await ownerRun).status).toBe("completed");
    expect(f.attachments()).toBe(1);
    expect(f.models()).toBe(0);
  } finally {
    unblock();
    await ownerRun;
    peer.recipients.close();
    f.recipients.close();
    f.device.privateKey.fill(0);
  }
});


test.each([false, true])("near-expiry grants honor the recipient deadline after material loading (expires=%s)", async (expires) => {
  const f = await currentZeroOutputCoordinatorFixture();
  try {
    const recipientExpiry = (await f.repository.get(f.requestId))!.snapshot.recipient!.expiresAt;
    f.setNow(recipientExpiry - 30_000);
    f.pauseAt("claimed", async () => {
      const claimed = (await f.repository.get(f.requestId))!;
      expect(claimed.snapshot.claimExpiresAt).toBe(recipientExpiry);
      f.setNow(recipientExpiry - (expires ? 0 : 10_000));
    });
    const result = await f.coordinator.run(f.requestId);
    expect(result.status).toBe(expires ? "retry_scheduled" : "completed");
    expect(f.attachments()).toBe(expires ? 0 : 1);
    expect(f.models()).toBe(0);
  } finally {
    f.recipients.close();
    f.device.privateKey.fill(0);
  }
});
