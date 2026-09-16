import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  ProcessorTransformRecipientRegistry,
  accessRevision,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptObjectPayload,
  humanId,
  namespaceId,
  objectId,
  sealNamespaceKeyring,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type ProcessorTransformObjectPort,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  backgroundWorkDescriptorDigestV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  encodeMessagePayloadV2,
  fulfillProcessorBackgroundAuthorizationRequest,
  verifyCurrentBackgroundAuthorizationDeviceResponse,
  type BackgroundAuthorizationDeviceAuthority,
  type BackgroundAuthorizationDeviceFulfillment,
  type ProtectedJournalProductReadBatch,
  type VerifiedProcessorBackgroundAuthorizationDeviceResponse,
} from "@nautilo/lattice-bridge";
import {
  createProtectedJournalAgentContentOpener,
} from "@nautilo/lattice-bridge/server";

import {
  BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequest,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationGrantReady,
  markBackgroundAuthorizationRunning,
  type BackgroundAuthorizationRequestSnapshot,
} from "../../src/protected-execution/background-authorization/lifecycle";
import {
  BackgroundAuthorizationProcessorCredentialClaimPort,
} from "../../src/protected-execution/background-authorization/processor-credential-claim-port";
import {
  InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
} from "../../src/protected-execution/background-authorization/repository";
import {
  ProtectedStenographerBackgroundCoordinator,
} from "../../src/stenographer/protected-stenographer-background-coordinator";
import {
  createProtectedForegroundJournalReader,
} from "../../src/stenographer/protected-journal-reader";
import {
  decodeProtectedJournalAttachmentPlanV1,
  type ProtectedJournalAttachmentPlanV1,
} from "../../src/stenographer/protected-journal-output-planner";
import {
  fingerprintProtectedStenographerSourceBindings,
  type ProtectedStenographerSourceBinding,
} from "../../src/stenographer/protected-source-loader";
import {
  runProtectedStenographerExtraction,
  type ProtectedStenographerExtractionPublicationPort,
  type ProtectedStenographerExtractionWork,
} from "../../src/stenographer/protected-stenographer-extraction";
import {
  createProtectedStenographerPublicationFence,
} from "../../src/stenographer/protected-stenographer-publication-reconciliation";

const NOW = 1_800_000_000_000;
const ROOM_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "20000000-0000-4000-8000-000000000001";
const BATCH_ID = "30000000-0000-4000-8000-000000000001";
const EVENT_ID = "40000000-0000-4000-8000-000000000001";
const INPUT_OBJECT_ID = "journal-message-41";
const OUTPUT_OBJECT_ID = "journal-event-1";
const CREATED_AT = "2027-01-15T08:01:00.000Z";
const SECRET_SOURCE = "Remember the cobalt launch code.";
const SECRET_EVENT = "The launch code color is cobalt.";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function containsSecret(value: unknown): boolean {
  const secrets = [
    SECRET_SOURCE,
    SECRET_EVENT,
    "provider leaked raw prompt",
  ];
  const needles = secrets.map((secret) => new TextEncoder().encode(secret));
  const encodedSecrets = secrets.flatMap((secret) => [
    Buffer.from(secret).toString("hex"),
    Buffer.from(secret).toString("base64"),
    Buffer.from(secret).toString("base64url"),
  ]);
  const seen = new Set<object>();
  const scan = (candidate: unknown): boolean => {
    if (typeof candidate === "string") {
      return secrets.some((secret) => candidate.includes(secret))
        || encodedSecrets.some((secret) => candidate.includes(secret));
    }
    if (candidate instanceof Uint8Array) {
      return needles.some((needle) => containsBytes(candidate, needle));
    }
    if (candidate instanceof Error) {
      return scan(candidate.message)
        || scan(candidate.stack)
        || scan(candidate.cause);
    }
    if (candidate === null || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (candidate instanceof Map) {
      return [...candidate].some(([key, entry]) => scan(key) || scan(entry));
    }
    if (candidate instanceof Set) {
      return [...candidate].some(scan);
    }
    if (Array.isArray(candidate)) return candidate.some(scan);
    return Reflect.ownKeys(candidate).some((key) =>
      scan(key) || scan(Reflect.get(candidate, key))
    );
  };
  return scan(value);
}

function containsBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
): boolean {
  outer:
  for (
    let offset = 0;
    offset <= haystack.length - needle.length;
    offset += 1
  ) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

type DeviceFixture = Readonly<{
  authority: BackgroundAuthorizationDeviceAuthority;
  crypto: LatticeCrypto;
}>;

function device(
  crypto: LatticeCrypto,
  descriptor: BackgroundWorkDescriptorV1,
  suffix: string,
  aiRoot: Uint8Array,
): DeviceFixture {
  const signing = crypto.generateSigningKeyPair();
  return Object.freeze({
    crypto,
    authority: Object.freeze({
      humanId: humanId(`human-${suffix}`),
      humanState: "active",
      deviceId: cryptoDeviceId(`device-${suffix}`),
      deviceHumanId: humanId(`human-${suffix}`),
      deviceState: "active",
      deviceAuthorizationRevision: authorizationRevision(17),
      deviceSigningPublicKey: signing.publicKey,
      deviceSigningPrivateKey: signing.privateKey,
      namespaceId: descriptor.namespaceId,
      namespaceState: "active",
      membershipHumanId: humanId(`human-${suffix}`),
      membershipState: "active",
      namespaceAccessRevision: descriptor.expectedNamespaceAccessRevision,
      policyRevision: descriptor.expectedPolicyRevision,
      domainId: descriptor.domainId,
      domainState: "active",
      domainEpoch: descriptor.expectedDomainEpoch,
      processorKind: "stenographer",
      processorVersion: 1,
      processorState: "active",
      processorAuthorizationRevision: authorizationRevision(19),
      aiRoot,
    }),
  });
}

async function descriptorFor(
  attempt: Readonly<{
    requestId: string;
    workId: string;
    namespaceId: string;
    recipientGeneration: number;
    recipientKeyId: string;
    recipientPublicKey: Uint8Array;
    expiresAt: number;
  }>,
  issuedAt = NOW,
): Promise<BackgroundWorkDescriptorV1> {
  await Promise.resolve();
  return Object.freeze({
    formatVersion: 1,
    requestId: attempt.requestId,
    recipientGeneration: attempt.recipientGeneration,
    workKind: "stenographer.extraction",
    workId: attempt.workId,
    namespaceId: namespaceId(attempt.namespaceId),
    domainId: cryptoDomainId("domain-room-1"),
    subject: Object.freeze({
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(19),
    }),
    purpose: "journal.extract",
    operations: Object.freeze(["decrypt", "encrypt"] as const),
    source: Object.freeze({
      kind: "journal_range",
      startSequence: 41,
      endSequence: 41,
      rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(0x41),
    }),
    inputObjectIds: Object.freeze([objectId(INPUT_OBJECT_ID)]),
    outputObjectIds: Object.freeze([objectId(OUTPUT_OBJECT_ID)]),
    outputObjectMetadata: Object.freeze([Object.freeze({
      objectId: objectId(OUTPUT_OBJECT_ID),
      objectType: "nautilo.reflection.record.v1",
      createdAt: unixTimestamp(Date.parse(CREATED_AT)),
    })]),
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 1,
    maximumPlaintextBytes: 128 * 1_024,
    maximumCiphertextBytes: 256 * 1_024,
    expectedDomainEpoch: domainEpoch(7),
    expectedNamespaceAccessRevision: accessRevision(0),
    expectedPolicyRevision: authorizationRevision(13),
    recipientKeyId: attempt.recipientKeyId,
    recipientPublicKey: attempt.recipientPublicKey,
    issuedAt,
    notBefore: issuedAt,
    expiresAt: attempt.expiresAt,
    idempotencyId: `idempotency-${attempt.requestId}`,
  });
}

function durableRecord(
  descriptor: BackgroundWorkDescriptorV1,
  descriptorBytes: Uint8Array,
  descriptorHash: Uint8Array,
): BackgroundAuthorizationRecord {
  const initial = initialRecord(descriptor.requestId, descriptor.workId);
  const snapshot = attachBackgroundAuthorizationRecipient(
    initial.snapshot,
    {
      recipientGeneration: descriptor.recipientGeneration,
      descriptorDigest: hex(descriptorHash),
      recipientKeyId: descriptor.recipientKeyId,
      recipientPublicKey:
        Buffer.from(descriptor.recipientPublicKey).toString("base64url"),
      expiresAt: descriptor.expiresAt,
      now: NOW + 1,
    },
  );
  return Object.freeze({
    ...initial,
    snapshot,
    descriptorBytes,
  });
}

function initialRecord(
  requestId: string,
  workId: string,
): BackgroundAuthorizationRecord {
  return Object.freeze({
    snapshot: createBackgroundAuthorizationRequest({
      requestId,
      workId,
      namespaceId: NAMESPACE_ID,
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: 19,
      },
      now: NOW,
    }),
    workIdentityHash: sha256(
      new TextEncoder().encode(`${NAMESPACE_ID}:${workId}`),
    ),
    idempotencyKey: `idempotency-${requestId}`,
    workKind: "stenographer.extraction",
    purpose: "journal.extract",
    domainId: "domain-room-1",
    processorAuthorizationRevision: 19,
    expectedDomainEpoch: 7,
    expectedNamespaceAccessRevision: 0,
    expectedPolicyRevision: 13,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  });
}

function extractionWork(
  bindings: readonly ProtectedStenographerSourceBinding[],
  requestId: string,
  workIdentityFill: number,
  descriptorFill: number,
): ProtectedStenographerExtractionWork {
  return Object.freeze({
    requestId,
    workId: `work-${requestId}`,
    workIdentityHash: new Uint8Array(32).fill(workIdentityFill),
    descriptorHash: new Uint8Array(32).fill(descriptorFill),
    sourceBindingFingerprint:
      fingerprintProtectedStenographerSourceBindings(bindings),
    requiresContentRecheck: bindings.some((binding) =>
      binding.kind === "message"
      && binding.source === "current"
      && binding.role === "assistant"
      && binding.conversationalBoundary
    ),
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    sourceBatchId: BATCH_ID,
    rebuildGeneration: 0,
    fromMessageIdExclusive: 40,
    throughMessageIdInclusive: 41,
    extractorVersion: "m241-v1",
    createdAt: CREATED_AT,
    bindings,
    outputSlots: Object.freeze([{
      eventId: EVENT_ID,
      objectId: OUTPUT_OBJECT_ID,
    }]),
  });
}

function advanceRetryAttemptToRunning(
  snapshot: BackgroundAuthorizationRequestSnapshot,
  generation: number,
  at: number,
): BackgroundAuthorizationRequestSnapshot {
  const descriptorDigest = "ab".repeat(32);
  const recipientKeyId = `retry-recipient-${generation}`;
  const recipientPublicKey =
    Buffer.from(new Uint8Array(65).fill(generation + 1))
      .toString("base64url");
  const expiresAt = at + 300_000;
  return markBackgroundAuthorizationRunning(
    claimBackgroundAuthorizationRequest(
      markBackgroundAuthorizationGrantReady(
        attachBackgroundAuthorizationRecipient(snapshot, {
          recipientGeneration: generation,
          descriptorDigest,
          recipientKeyId,
          recipientPublicKey,
          expiresAt,
          now: at,
        }),
        {
          kind: "processor",
          requestId: snapshot.requestId,
          descriptorDigest,
          recipientKeyId,
          recipientPublicKey,
          expiresAt,
          responseDigest: "cd".repeat(32),
          credentialDigest: "ef".repeat(32),
          issuingHumanId: "human-alice",
          issuingDeviceId: "device-alice",
          recipientGeneration: generation,
          now: at + 1,
        },
      ),
      `claim-${generation}`,
      at + 2,
      at + 120_000,
    ),
    at + 2,
  );
}

async function fulfillAndVerify(
  crypto: LatticeCrypto,
  descriptor: BackgroundWorkDescriptorV1,
  current: BackgroundAuthorizationDeviceAuthority,
  verificationTime = NOW + 2,
): Promise<Readonly<{
  fulfillment: BackgroundAuthorizationDeviceFulfillment;
  verified: VerifiedProcessorBackgroundAuthorizationDeviceResponse;
}>> {
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const descriptorHash =
    backgroundWorkDescriptorDigestV1(crypto, descriptor);
  const fulfillment =
    await fulfillProcessorBackgroundAuthorizationRequest({
      crypto,
      request: {
        formatVersion: 1,
        descriptorBytes,
        descriptorHash,
      },
      resolveCurrentAuthority: () => Promise.resolve(current),
    });
  const verified =
    await verifyCurrentBackgroundAuthorizationDeviceResponse({
      crypto,
      expected: {
        kind: "processor",
        requestId: descriptor.requestId,
        recipientGeneration: descriptor.recipientGeneration,
        descriptorHash,
        recipientKeyId: descriptor.recipientKeyId,
        recipientPublicKey: descriptor.recipientPublicKey,
      },
      responseBytes: fulfillment.responseBytes,
      signerAuthorizationBytes: fulfillment.signerAuthorizationBytes,
      now: verificationTime,
      resolveCurrentIssuingDevicePublicKey: ({ context }) => {
        const deviceId = (context as { issuingDeviceId?: string })
          .issuingDeviceId;
        return deviceId === current.deviceId
          ? current.deviceSigningPublicKey
          : null;
      },
    });
  return Object.freeze({ fulfillment, verified });
}

class ContentFreePublicationHarness
implements ProtectedStenographerExtractionPublicationPort {
  readonly durable: unknown[] = [];
  readonly productObjects = new Map<string, string>();
  attachmentPlan: ProtectedJournalAttachmentPlanV1 | null = null;
  reservedAttachmentPlanBytes: Uint8Array | null = null;
  cryptoCommitted = false;
  crashAfterCrypto = false;
  rebuildGeneration = 0;
  tombstonePending = false;
  tombstoned = false;

  async reserve(reservation: Parameters<
    ProtectedStenographerExtractionPublicationPort["reserve"]
  >[0]) {
    expect(sha256(reservation.attachmentPlanBytes))
      .toEqual(reservation.attachmentPlanHash);
    this.reservedAttachmentPlanBytes = reservation.attachmentPlanBytes.slice();
    this.durable.push({
      publicationId: reservation.publicationId,
      requestId: reservation.requestId,
      workId: reservation.workId,
      workIdentityHash: hex(reservation.workIdentityHash),
      descriptorHash: hex(reservation.descriptorHash),
      roomId: reservation.roomId,
      namespaceId: reservation.namespaceId,
      sourceBatchId: reservation.sourceBatchId,
      rebuildGeneration: reservation.rebuildGeneration,
      attachmentPlanVersion: reservation.attachmentPlanVersion,
      attachmentPlanHash: hex(reservation.attachmentPlanHash),
      outputObjectCount: reservation.outputObjectCount,
    });
    return "reserved" as const;
  }

  async markCryptoCommitted(commit: Parameters<
    ProtectedStenographerExtractionPublicationPort["markCryptoCommitted"]
  >[0]) {
    this.cryptoCommitted = true;
    this.durable.push({
      publicationId: commit.publicationId,
      descriptorHash: hex(commit.descriptorHash),
      attachmentPlanHash: hex(commit.attachmentPlanHash),
      outputObjectIds: [...commit.outputObjectIds],
      state: "crypto_committed",
    });
    return this.crashAfterCrypto ? "lost" as const : "marked" as const;
  }

  async attach(attachment: Parameters<
    ProtectedStenographerExtractionPublicationPort["attach"]
  >[0]) {
    this.attachmentPlan = attachment.attachmentPlan;
    attachment.attachmentPlan.events.forEach((event) => {
      this.productObjects.set(event.eventId, event.objectId);
    });
    this.durable.push({
      publicationId: attachment.publicationId,
      attachmentPlanHash: hex(attachment.attachmentPlanHash),
      outputObjectIds: [...attachment.outputObjectIds],
      state: "attached",
    });
    return "attached" as const;
  }

  reconcileFromDurableReceipt(): void {
    if (!this.cryptoCommitted) {
      throw new Error("cannot attach a product mapping before crypto commit");
    }
    if (this.reservedAttachmentPlanBytes === null) {
      throw new Error("durable reserved attachment plan is missing");
    }
    const plan = decodeProtectedJournalAttachmentPlanV1(
      this.reservedAttachmentPlanBytes,
    );
    this.attachmentPlan = plan;
    plan.events.forEach((event) => {
      this.productObjects.set(event.eventId, event.objectId);
    });
  }

  invalidateForRebuild(
    nextGeneration: number,
  ): "stale" | "superseded" | "tombstone_pending" {
    if (
      !Number.isSafeInteger(nextGeneration)
      || nextGeneration <= this.rebuildGeneration
    ) {
      return "stale";
    }
    this.rebuildGeneration = nextGeneration;
    if (!this.cryptoCommitted) return "superseded";
    this.tombstonePending = true;
    return "tombstone_pending";
  }

  confirmTombstone(): void {
    if (!this.tombstonePending) {
      throw new Error("tombstone was not requested");
    }
    this.productObjects.clear();
    this.tombstonePending = false;
    this.tombstoned = true;
  }
}

describe("Wave 10 dormant background-encryption scenario", () => {
  test("keeps an offline request durable, accepts one valid device race winner, and rejects a lost process generation", async () => {
    let clock = NOW;
    const crypto = new LatticeCrypto(
      seededRng(24_100),
      { now: () => clock },
    );
    const aiRoot = new Uint8Array(32).fill(0x72);
    const repository = new InMemoryBackgroundAuthorizationRepository();
    const registry = new ProcessorTransformRecipientRegistry({
      crypto,
      now: () => clock,
    });
    await repository.create(initialRecord(
      "request-offline",
      "work-offline",
    ));
    const deviceKeys = new Map<string, Uint8Array>();
    let preparedDescriptor: BackgroundWorkDescriptorV1 | null = null;
    const coordinatorFor = (
      recipients: ProcessorTransformRecipientRegistry,
    ) => new ProtectedStenographerBackgroundCoordinator({
      repository,
      recipients,
      descriptors: {
        create: async ({ attempt }) => {
          const descriptor = await descriptorFor(attempt, clock);
          preparedDescriptor = descriptor;
          const descriptorBytes =
            encodeBackgroundWorkDescriptorV1(descriptor);
          return {
            descriptorBytes,
            descriptorHash:
              backgroundWorkDescriptorDigestV1(crypto, descriptor),
          };
        },
      },
      responses: {
        verify: ({ record, responseBytes, signerAuthorizationBytes, now }) =>
          verifyCurrentBackgroundAuthorizationDeviceResponse({
            crypto,
            expected: {
              kind: "processor",
              requestId: record.snapshot.requestId,
              recipientGeneration: record.snapshot.recipientGeneration,
              descriptorHash: Uint8Array.from(
                Buffer.from(record.snapshot.descriptorDigest!, "hex"),
              ),
              recipientKeyId: record.snapshot.recipient!.recipientKeyId,
              recipientPublicKey: Uint8Array.from(
                Buffer.from(
                  record.snapshot.recipient!.recipientPublicKey,
                  "base64url",
                ),
              ),
            },
            responseBytes,
            signerAuthorizationBytes,
            now,
            resolveCurrentIssuingDevicePublicKey: ({ context }) =>
              deviceKeys.get(
                (context as { issuingDeviceId: string }).issuingDeviceId,
              ) ?? null,
          }),
      },
      transformMaterial: {
        loadAccepted: () => Promise.resolve({
          status: "loaded" as const,
          material: {
            signerAuthorizationBytes: new Uint8Array([1]),
            resolveCurrentIssuerPublicKey: () => null,
            resolveHistoricalNamespaceCommitter: () => null,
            resolveCurrentSignerIssuingDevicePublicKey: () => null,
            claims: {
              claimExactCredential: () => Promise.resolve("claimed"),
            },
            objects: {
              loadNamespaceKeyring: () =>
                Promise.reject(new Error("lost recipient must fail first")),
              openInput: () =>
                Promise.reject(new Error("lost recipient must fail first")),
              publishOutputs: () =>
                Promise.reject(new Error("lost recipient must fail first")),
            },
          },
        }),
      },
      execution: {
        executeWork: () =>
          Promise.reject(new Error("not used in this path")),
        reconcilePublication: () => Promise.resolve("pending"),
      },
      now: () => clock,
      recipientKeyId: (record) =>
        `recipient-offline-${record.snapshot.recipientGeneration}`,
      claimId: () => "claim-offline",
      nextAttemptAt: (_record, _reason, now) => now,
    });

    await repository.create(initialRecord(
      "request-expired-recipient",
      "work-expired-recipient",
    ));
    await repository.create(initialRecord(
      "request-restart-before-response",
      "work-restart-before-response",
    ));
    expect(
      await coordinatorFor(registry).prepareRecipient(
        "request-restart-before-response",
      ),
    ).toMatchObject({
      status: "device_authorization_required",
      recipientGeneration: 0,
    });
    const restartedBeforeResponse =
      new ProcessorTransformRecipientRegistry({
        crypto,
        now: () => clock,
      });
    expect(
      await coordinatorFor(restartedBeforeResponse).prepareRecipient(
        "request-restart-before-response",
      ),
    ).toEqual({status: "not_due"});
    expect(
      await repository.get("request-restart-before-response"),
    ).toMatchObject({
      snapshot: {
        state: "awaiting_device",
        recipientGeneration: 0,
        lastRetryReason: null,
      },
    });
    restartedBeforeResponse.close();

    expect(
      await coordinatorFor(registry).prepareRecipient(
        "request-expired-recipient",
      ),
    ).toMatchObject({
      status: "device_authorization_required",
      recipientGeneration: 0,
    });
    clock = NOW + 300_000;
    expect(
      await coordinatorFor(registry).prepareRecipient(
        "request-expired-recipient",
      ),
    ).toMatchObject({
      status: "device_authorization_required",
      recipientGeneration: 1,
    });
    expect(await repository.get("request-expired-recipient")).toMatchObject({
      snapshot: {
        state: "awaiting_device",
        recipientGeneration: 1,
        retryCount: 0,
        lastRetryReason: "attempt_expired",
      },
    });

    clock = NOW;
    expect(await coordinatorFor(registry).prepareRecipient("request-offline"))
      .toMatchObject({
        status: "device_authorization_required",
        recipientGeneration: 0,
      });
    if (preparedDescriptor === null) {
      throw new Error("prepared descriptor missing");
    }
    const descriptor: BackgroundWorkDescriptorV1 = preparedDescriptor;
    const created = await repository.get("request-offline");
    if (created === null) throw new Error("durable request missing");

    expect(created.snapshot.state).toBe("awaiting_device");
    expect((await repository.listEligible({
      now: NOW + 60_000,
      limit: 16,
    })).map((record) => record.snapshot.requestId)).toEqual([]);
    expect((await repository.listEligible({
      now: NOW + 300_000,
      limit: 16,
    })).map((record) => record.snapshot.requestId))
      .toEqual([
        "request-offline",
        "request-restart-before-response",
      ]);
    expect(containsSecret(created)).toBe(false);

    const alice = device(crypto, descriptor, "alice", aiRoot);
    const bob = device(crypto, descriptor, "bob", aiRoot);
    deviceKeys.set(
      alice.authority.deviceId,
      alice.authority.deviceSigningPublicKey,
    );
    deviceKeys.set(
      bob.authority.deviceId,
      bob.authority.deviceSigningPublicKey,
    );
    const [aliceResponse, bobResponse] = await Promise.all([
      fulfillAndVerify(crypto, descriptor, alice.authority),
      fulfillAndVerify(crypto, descriptor, bob.authority),
    ]);
    const winners = await Promise.all([
      coordinatorFor(registry).acceptDeviceResponse({
        requestId: descriptor.requestId,
        responseBytes: aliceResponse.fulfillment.responseBytes,
        signerAuthorizationBytes:
          aliceResponse.fulfillment.signerAuthorizationBytes,
      }),
      coordinatorFor(registry).acceptDeviceResponse({
        requestId: descriptor.requestId,
        responseBytes: bobResponse.fulfillment.responseBytes,
        signerAuthorizationBytes:
          bobResponse.fulfillment.signerAuthorizationBytes,
      }),
    ]);
    expect(winners.filter((result) => result.status === "accepted"))
      .toHaveLength(1);
    expect(winners.filter((result) => result.status === "lost"))
      .toHaveLength(1);
    expect((await repository.get("request-offline"))?.snapshot.state)
      .toBe("grant_ready");
    expect(containsSecret(await repository.get("request-offline"))).toBe(false);

    registry.close();
    const accepted = await repository.get("request-offline");
    if (accepted === null) throw new Error("accepted request missing");
    const acceptedDeviceId =
      accepted.snapshot.acceptedResponse?.issuingDeviceId;
    clock = NOW + 4;
    expect(await coordinatorFor(registry).run("request-offline"))
      .toEqual({status: "not_ready"});
    expect(await repository.get("request-offline")).toEqual(accepted);
    clock = NOW + 300_000;
    expect(await coordinatorFor(registry).run("request-offline"))
      .toEqual({
        status: "retry_scheduled",
        recipientGeneration: 1,
        reason: "recipient_lost",
      });
    const oldResponse = acceptedDeviceId === alice.authority.deviceId
      ? aliceResponse.fulfillment
      : bobResponse.fulfillment;
    expect(await coordinatorFor(registry).acceptDeviceResponse({
      requestId: descriptor.requestId,
      responseBytes: oldResponse.responseBytes,
      signerAuthorizationBytes: oldResponse.signerAuthorizationBytes,
    })).toEqual({ status: "lost" });

    const restarted = new ProcessorTransformRecipientRegistry({
      crypto,
      now: () => clock,
    });
    clock = NOW + 300_005;
    expect(await coordinatorFor(restarted).prepareRecipient("request-offline"))
      .toMatchObject({
        status: "device_authorization_required",
        recipientGeneration: 1,
      });
    const replacementCandidate =
      preparedDescriptor as BackgroundWorkDescriptorV1 | null;
    if (
      replacementCandidate === null
      || replacementCandidate.recipientGeneration !== 1
    ) {
      throw new Error("replacement descriptor missing");
    }
    const replacementDescriptor: BackgroundWorkDescriptorV1 =
      replacementCandidate;
    expect(await repository.get("request-offline")).toMatchObject({
      snapshot: {
        state: "awaiting_device",
        recipientGeneration: 1,
      },
    });
    const replacementDevice =
      device(crypto, replacementDescriptor, "alice-restarted", aiRoot);
    deviceKeys.set(
      replacementDevice.authority.deviceId,
      replacementDevice.authority.deviceSigningPublicKey,
    );
    const replacementResponse = await fulfillAndVerify(
      crypto,
      replacementDescriptor,
      replacementDevice.authority,
      NOW + 300_007,
    );
    clock = NOW + 300_008;
    expect(await coordinatorFor(restarted).acceptDeviceResponse({
      requestId: replacementDescriptor.requestId,
      responseBytes: replacementResponse.fulfillment.responseBytes,
      signerAuthorizationBytes:
        replacementResponse.fulfillment.signerAuthorizationBytes,
    })).toEqual({
      status: "accepted",
    });
    expect(await repository.get("request-offline")).toMatchObject({
      snapshot: {
        recipientGeneration: 1,
        state: "grant_ready",
      },
    });
    restarted.close();
  });

  test("reconciles a real crypto-first crash before a current foreground Agent reads the encrypted event", async () => {
    const crypto = new LatticeCrypto(
      seededRng(24_101),
      { now: () => NOW },
    );
    const aiRoot = new Uint8Array(32).fill(0x72);
    const registry = new ProcessorTransformRecipientRegistry({
      crypto,
      now: () => NOW + 2,
    });
    const attempt = await registry.createAttempt({
      requestId: "request-extract",
      workId: "work-extract",
      namespaceId: NAMESPACE_ID,
      recipientGeneration: 0,
      recipientKeyId: "recipient-extract-0",
      expiresAt: NOW + 300_000,
    });
    if (attempt.status !== "created") throw new Error("recipient setup failed");
    const descriptor = await descriptorFor(attempt.attempt);
    const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
    const descriptorHash =
      backgroundWorkDescriptorDigestV1(crypto, descriptor);
    const current = device(crypto, descriptor, "alice", aiRoot).authority;
    const fulfillment =
      await fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: {
          formatVersion: 1,
          descriptorBytes,
          descriptorHash,
        },
        resolveCurrentAuthority: () => Promise.resolve(current),
      });

    const keyrings = createInitialNamespaceKeyrings(
      crypto,
      descriptor.namespaceId,
    );
    const keyringEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: aiRoot,
      keyring: keyrings.ai,
      metadata: {
        domainId: descriptor.domainId,
        domainEpoch: descriptor.expectedDomainEpoch,
        previousBindingHash: null,
        committerDeviceId: current.deviceId,
      },
      committerSigningPrivateKey: current.deviceSigningPrivateKey,
      resolveCurrentCommitter: () => current.deviceSigningPublicKey,
    });
    const namespaceKey = keyrings.ai.generations.find(
      (generation) => generation.generation === keyrings.ai.currentGeneration,
    )!.key;
    const messagePlaintext = encodeMessagePayloadV2({
      role: "user",
      content: SECRET_SOURCE,
    });
    const encryptedMessage = encryptObjectPayload(crypto, {
      objectId: objectId(INPUT_OBJECT_ID),
      keyClass: "ai",
      objectType: "room_message",
      createdAt: unixTimestamp(NOW),
    }, messagePlaintext);
    messagePlaintext.fill(0);
    const messageEnvelope = wrapObjectDekForNamespace(
      crypto,
      namespaceKey,
      {
        objectId: objectId(INPUT_OBJECT_ID),
        namespaceId: descriptor.namespaceId,
        keyClass: "ai",
        keyGeneration: keyrings.ai.currentGeneration,
        bindingRevisionAtWrap:
          descriptor.expectedNamespaceAccessRevision,
      },
      encryptedMessage.dek,
    );
    encryptedMessage.dek.fill(0);

    const cryptoObjects = new Map<string, Readonly<{
      payloadBytes: Uint8Array;
      envelopeBytes: Uint8Array;
      manifestBytes: Uint8Array;
    }>>();
    const objectPort: ProcessorTransformObjectPort = {
      loadNamespaceKeyring: () =>
        Promise.resolve({ envelope: keyringEnvelope }),
      openInput: ({ objectId: exactObjectId }) => {
        expect(exactObjectId).toBe(INPUT_OBJECT_ID);
        return Promise.resolve({
          payload: encryptedMessage.payload,
          envelope: messageEnvelope,
        });
      },
      publishOutputs: async (publication) => {
        expect(await publication.authorizeCommit()).toBe(NOW + 2);
        for (const output of publication.outputs) {
          cryptoObjects.set(output.objectId, Object.freeze({
            payloadBytes: output.payloadBytes.slice(),
            envelopeBytes: output.envelopeBytes.slice(),
            manifestBytes: output.manifestBytes.slice(),
          }));
        }
      },
    };
    const publication = new ContentFreePublicationHarness();
    publication.crashAfterCrypto = true;
    const repository = new InMemoryBackgroundAuthorizationRepository();
    await repository.create(
      durableRecord(descriptor, descriptorBytes, descriptorHash),
    );
    const bindings: ProtectedStenographerSourceBinding[] = [{
      kind: "message",
      objectId: INPUT_OBJECT_ID,
      source: "current",
      messageId: 41,
      editRevision: 0,
      createdAt: new Date(CREATED_AT),
      participantId: "human-alice",
      role: "user",
      conversationalBoundary: true,
    }];
    const coordinator = new ProtectedStenographerBackgroundCoordinator({
      repository,
      recipients: registry,
      descriptors: {
        create: () => Promise.reject(new Error("already prepared")),
      },
      responses: {
        verify: ({ record, responseBytes, signerAuthorizationBytes, now }) =>
          verifyCurrentBackgroundAuthorizationDeviceResponse({
            crypto,
            expected: {
              kind: "processor",
              requestId: record.snapshot.requestId,
              recipientGeneration: record.snapshot.recipientGeneration,
              descriptorHash: Uint8Array.from(
                Buffer.from(record.snapshot.descriptorDigest!, "hex"),
              ),
              recipientKeyId: record.snapshot.recipient!.recipientKeyId,
              recipientPublicKey: Uint8Array.from(
                Buffer.from(
                  record.snapshot.recipient!.recipientPublicKey,
                  "base64url",
                ),
              ),
            },
            responseBytes,
            signerAuthorizationBytes,
            now,
            resolveCurrentIssuingDevicePublicKey: () =>
              current.deviceSigningPublicKey,
          }),
      },
      transformMaterial: {
        loadAccepted: () => Promise.resolve({
          status: "loaded" as const,
          material: {
            signerAuthorizationBytes:
              fulfillment.signerAuthorizationBytes.slice(),
            resolveCurrentIssuerPublicKey: () =>
              current.deviceSigningPublicKey,
            resolveHistoricalNamespaceCommitter: () =>
              current.deviceSigningPublicKey,
            resolveCurrentSignerIssuingDevicePublicKey: () =>
              current.deviceSigningPublicKey,
            claims:
              new BackgroundAuthorizationProcessorCredentialClaimPort(
                repository,
              ),
            objects: objectPort,
          },
        }),
      },
      execution: {
        executeWork: async ({ capability, record, signal }) =>
          runProtectedStenographerExtraction({
            capability,
            signal,
            work: {
            requestId: descriptor.requestId,
            workId: descriptor.workId,
            workIdentityHash: sha256(
              new TextEncoder().encode("exact-work-identity"),
            ),
            descriptorHash: Uint8Array.from(
              Buffer.from(record.snapshot.descriptorDigest!, "hex"),
            ),
            sourceBindingFingerprint:
              fingerprintProtectedStenographerSourceBindings(bindings),
            requiresContentRecheck: false,
            roomId: ROOM_ID,
            namespaceId: NAMESPACE_ID,
            sourceBatchId: BATCH_ID,
            rebuildGeneration: 0,
            fromMessageIdExclusive: 40,
            throughMessageIdInclusive: 41,
            extractorVersion: "m241-v1",
            createdAt: CREATED_AT,
            bindings,
            outputSlots: [{
              eventId: EVENT_ID,
              objectId: OUTPUT_OBJECT_ID,
            }],
          },
          resolveParticipantDisplays: () =>
            Promise.resolve([{
              participantId: "human-alice",
              displayLabel: "Alice",
            }]),
          invokeModel: (prompt) => {
            expect(prompt).toContain(SECRET_SOURCE);
            return Promise.resolve(JSON.stringify({
              operations: [{
                op: "append",
                kind: "fact",
                statement: SECRET_EVENT,
                sourceMessageIds: ["M1"],
              }],
            }));
          },
          publication,
          }),
        reconcilePublication: () => {
          if (!cryptoObjects.has(OUTPUT_OBJECT_ID)) {
            return Promise.resolve("stale");
          }
          publication.reconcileFromDurableReceipt();
          return Promise.resolve("completed");
        },
      },
      now: () => NOW + 2,
      recipientKeyId: () => "unused-recipient",
      claimId: () => "claim-extract",
      nextAttemptAt: (_record, _reason, now) => now,
    });
    expect(await coordinator.acceptDeviceResponse({
      requestId: descriptor.requestId,
      responseBytes: fulfillment.responseBytes,
      signerAuthorizationBytes: fulfillment.signerAuthorizationBytes,
    })).toEqual({ status: "accepted" });
    const acceptedBeforeRun = await repository.get(descriptor.requestId);
    if (acceptedBeforeRun === null) {
      throw new Error("accepted durable request missing");
    }
    expect(await coordinator.run(descriptor.requestId))
      .toEqual({ status: "reconciliation_pending" });
    expect((await repository.get(descriptor.requestId))?.snapshot.state)
      .toBe("publication_reconciliation");
    expect(publication.productObjects.size).toBe(0);

    const restartRepository =
      new InMemoryBackgroundAuthorizationRepository();
    const restartedAt = NOW + 2 + 120_000;
    const interruptedClaim = claimBackgroundAuthorizationRequest(
      acceptedBeforeRun.snapshot,
      "claim-extract",
      NOW + 2,
      NOW + 2 + 120_000,
    );
    await restartRepository.create({
      ...acceptedBeforeRun,
      snapshot: markBackgroundAuthorizationRunning(
        interruptedClaim,
        NOW + 2,
      ),
    });
    const restartedRegistry = new ProcessorTransformRecipientRegistry({
      crypto,
      now: () => restartedAt,
    });
    let restartedReconciliations = 0;
    let restartedExecutions = 0;
    const publicationFence =
      createProtectedStenographerPublicationFence(restartRepository);
    const restartedCoordinator =
      new ProtectedStenographerBackgroundCoordinator({
        repository: restartRepository,
        recipients: restartedRegistry,
        descriptors: {
          create: () => Promise.reject(new Error("already prepared")),
        },
        responses: {
          verify: () => Promise.reject(new Error("already accepted")),
        },
        transformMaterial: {
          loadAccepted: () => Promise.resolve({
            status: "loaded" as const,
            material: {
              signerAuthorizationBytes: new Uint8Array([1]),
              resolveCurrentIssuerPublicKey: () => null,
              resolveHistoricalNamespaceCommitter: () => null,
              resolveCurrentSignerIssuingDevicePublicKey: () => null,
              claims: {
                claimExactCredential: () =>
                  Promise.reject(new Error(
                    "restart reconciliation must not reclaim authority",
                  )),
              },
              objects: {
                loadNamespaceKeyring: () =>
                  Promise.reject(new Error(
                    "restart reconciliation must not open content",
                  )),
                openInput: () =>
                  Promise.reject(new Error(
                    "restart reconciliation must not open content",
                  )),
                publishOutputs: () =>
                  Promise.reject(new Error(
                    "restart reconciliation must not publish twice",
                  )),
              },
            },
          }),
        },
        execution: {
          executeWork: () => {
            restartedExecutions += 1;
            return Promise.reject(new Error(
              "restart reconciliation must not call the model",
            ));
          },
          reconcilePublication: async (record) => {
            restartedReconciliations += 1;
            expect(await publicationFence.fence({
              record,
              now: new Date(restartedAt),
            })).toBe("fenced");
            expect(
              (await restartRepository.get(descriptor.requestId))
                ?.snapshot.state,
            ).toBe("publication_reconciliation");
            publication.reconcileFromDurableReceipt();
            return "completed";
          },
        },
        now: () => restartedAt,
        recipientKeyId: () => "unused-recipient",
        claimId: () => "unused-claim",
        nextAttemptAt: (_record, _reason, now) => now,
      });
    expect(await restartedCoordinator.run(descriptor.requestId))
      .toEqual({ status: "completed" });
    expect(restartedReconciliations).toBe(1);
    expect(restartedExecutions).toBe(0);
    expect(
      (await restartRepository.get(descriptor.requestId))?.snapshot,
    ).toMatchObject({
      state: "completed",
      recipientGeneration: 0,
    });
    restartedRegistry.close();

    const noCommitRepository =
      new InMemoryBackgroundAuthorizationRepository();
    await noCommitRepository.create({
      ...acceptedBeforeRun,
      snapshot: markBackgroundAuthorizationRunning(
        interruptedClaim,
        NOW + 2,
      ),
    });
    const noCommitRecipients = new ProcessorTransformRecipientRegistry({
      crypto,
      now: () => restartedAt,
    });
    const noCommitFence =
      createProtectedStenographerPublicationFence(noCommitRepository);
    const runningWithoutCommit = await noCommitRepository.get(
      descriptor.requestId,
    );
    if (runningWithoutCommit === null) {
      throw new Error("uncommitted restart fixture is missing");
    }
    expect(await noCommitFence.fence({
      record: runningWithoutCommit,
      now: new Date(restartedAt),
    })).toBe("fenced");
    expect(
      (await noCommitRepository.get(descriptor.requestId))?.snapshot.state,
    ).toBe("publication_reconciliation");
    const noCommitCoordinator =
      new ProtectedStenographerBackgroundCoordinator({
        repository: noCommitRepository,
        recipients: noCommitRecipients,
        descriptors: {
          create: () => Promise.reject(new Error("must not recreate early")),
        },
        responses: {
          verify: () => Promise.reject(new Error("must not verify response")),
        },
        transformMaterial: {
          loadAccepted: () =>
            Promise.reject(new Error("must not reopen a lost recipient")),
        },
        execution: {
          executeWork: () =>
            Promise.reject(new Error("must not rerun the model")),
          reconcilePublication: () => Promise.resolve("not_started"),
        },
        now: () => restartedAt,
        recipientKeyId: () => "unused-recipient",
        claimId: () => "unused-claim",
        nextAttemptAt: (_record, _reason, now) => now,
      });
    expect(await noCommitCoordinator.run(descriptor.requestId)).toEqual({
      status: "retry_scheduled",
      recipientGeneration: 1,
      reason: "claim_expired",
    });
    expect(
      (await noCommitRepository.get(descriptor.requestId))?.snapshot,
    ).toMatchObject({
      state: "awaiting_recipient",
      recipientGeneration: 1,
      lastRetryReason: "claim_expired",
    });
    noCommitRecipients.close();

    expect(await coordinator.run(descriptor.requestId))
      .toEqual({ status: "completed" });
    expect((await repository.get(descriptor.requestId))?.snapshot.state)
      .toBe("completed");

    const providerAttempt = await registry.createAttempt({
      requestId: "request-provider-failure",
      workId: "work-provider-failure",
      namespaceId: NAMESPACE_ID,
      recipientGeneration: 0,
      recipientKeyId: "recipient-provider-0",
      expiresAt: NOW + 300_000,
    });
    if (providerAttempt.status !== "created") {
      throw new Error("provider-failure recipient setup failed");
    }
    const providerDescriptor = await descriptorFor(providerAttempt.attempt);
    const providerDescriptorBytes =
      encodeBackgroundWorkDescriptorV1(providerDescriptor);
    const providerDescriptorHash =
      backgroundWorkDescriptorDigestV1(crypto, providerDescriptor);
    await repository.create(durableRecord(
      providerDescriptor,
      providerDescriptorBytes,
      providerDescriptorHash,
    ));
    const providerFulfillment =
      await fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: {
          formatVersion: 1,
          descriptorBytes: providerDescriptorBytes,
          descriptorHash: providerDescriptorHash,
        },
        resolveCurrentAuthority: () => Promise.resolve(current),
      });
    const providerPublication = new ContentFreePublicationHarness();
    const providerCoordinator =
      new ProtectedStenographerBackgroundCoordinator({
        repository,
        recipients: registry,
        descriptors: {
          create: () => Promise.reject(new Error("already prepared")),
        },
        responses: {
          verify: ({ record, responseBytes, signerAuthorizationBytes, now }) =>
            verifyCurrentBackgroundAuthorizationDeviceResponse({
              crypto,
              expected: {
                kind: "processor",
                requestId: record.snapshot.requestId,
                recipientGeneration: record.snapshot.recipientGeneration,
                descriptorHash: Uint8Array.from(
                  Buffer.from(record.snapshot.descriptorDigest!, "hex"),
                ),
                recipientKeyId: record.snapshot.recipient!.recipientKeyId,
                recipientPublicKey: Uint8Array.from(
                  Buffer.from(
                    record.snapshot.recipient!.recipientPublicKey,
                    "base64url",
                  ),
                ),
              },
              responseBytes,
              signerAuthorizationBytes,
              now,
              resolveCurrentIssuingDevicePublicKey: () =>
                current.deviceSigningPublicKey,
            }),
        },
        transformMaterial: {
          loadAccepted: () => Promise.resolve({
            status: "loaded" as const,
            material: {
              signerAuthorizationBytes:
                providerFulfillment.signerAuthorizationBytes.slice(),
              resolveCurrentIssuerPublicKey: () =>
                current.deviceSigningPublicKey,
              resolveHistoricalNamespaceCommitter: () =>
                current.deviceSigningPublicKey,
              resolveCurrentSignerIssuingDevicePublicKey: () =>
                current.deviceSigningPublicKey,
              claims:
                new BackgroundAuthorizationProcessorCredentialClaimPort(
                  repository,
                ),
              objects: objectPort,
            },
          }),
        },
        execution: {
          executeWork: ({ capability, record, signal }) =>
            runProtectedStenographerExtraction({
              capability,
              signal,
              work: {
                ...extractionWork(
                  bindings,
                  providerDescriptor.requestId,
                  7,
                  8,
                ),
                workId: providerDescriptor.workId,
                descriptorHash: Uint8Array.from(
                  Buffer.from(record.snapshot.descriptorDigest!, "hex"),
                ),
              },
              resolveParticipantDisplays: () =>
                Promise.resolve([{
                  participantId: "human-alice",
                  displayLabel: "Alice",
                }]),
              invokeModel: () =>
                Promise.reject(new Error(
                  `provider leaked raw prompt: ${SECRET_SOURCE}`,
                )),
              publication: providerPublication,
            }),
          reconcilePublication: () => Promise.resolve("pending"),
        },
        now: () => NOW + 2,
        recipientKeyId: () => "unused-recipient",
        claimId: () => "claim-provider",
        nextAttemptAt: (_record, _reason, now) => now,
      });
    expect(await providerCoordinator.acceptDeviceResponse({
      requestId: providerDescriptor.requestId,
      responseBytes: providerFulfillment.responseBytes,
      signerAuthorizationBytes:
        providerFulfillment.signerAuthorizationBytes,
    })).toEqual({ status: "accepted" });
    expect(await providerCoordinator.run(providerDescriptor.requestId))
      .toEqual({
        status: "retry_scheduled",
        recipientGeneration: 1,
        reason: "provider_transient_failure",
      });
    expect(await repository.get(providerDescriptor.requestId)).toMatchObject({
      snapshot: {
        state: "awaiting_recipient",
        retryCount: 1,
        lastRetryReason: "provider_transient_failure",
      },
      descriptorBytes: null,
      acceptedMaterial: null,
    });
    expect(providerPublication.durable).toEqual([]);
    expect(containsSecret(await repository.get(providerDescriptor.requestId)))
      .toBe(false);

    const replayAttempt = await registry.createAttempt({
      requestId: "request-replayed-before-publication",
      workId: "work-replayed-before-publication",
      namespaceId: NAMESPACE_ID,
      recipientGeneration: 0,
      recipientKeyId: "recipient-replayed-0",
      expiresAt: NOW + 300_000,
    });
    if (replayAttempt.status !== "created") {
      throw new Error("credential-replay recipient setup failed");
    }
    const replayDescriptor = await descriptorFor(replayAttempt.attempt);
    const replayDescriptorBytes =
      encodeBackgroundWorkDescriptorV1(replayDescriptor);
    const replayDescriptorHash =
      backgroundWorkDescriptorDigestV1(crypto, replayDescriptor);
    await repository.create(durableRecord(
      replayDescriptor,
      replayDescriptorBytes,
      replayDescriptorHash,
    ));
    const replayFulfillment =
      await fulfillProcessorBackgroundAuthorizationRequest({
        crypto,
        request: {
          formatVersion: 1,
          descriptorBytes: replayDescriptorBytes,
          descriptorHash: replayDescriptorHash,
        },
        resolveCurrentAuthority: () => Promise.resolve(current),
      });
    let replayReconciliations = 0;
    const replayCoordinator =
      new ProtectedStenographerBackgroundCoordinator({
        repository,
        recipients: registry,
        descriptors: {
          create: () => Promise.reject(new Error("already prepared")),
        },
        responses: {
          verify: ({ record, responseBytes, signerAuthorizationBytes, now }) =>
            verifyCurrentBackgroundAuthorizationDeviceResponse({
              crypto,
              expected: {
                kind: "processor",
                requestId: record.snapshot.requestId,
                recipientGeneration: record.snapshot.recipientGeneration,
                descriptorHash: Uint8Array.from(
                  Buffer.from(record.snapshot.descriptorDigest!, "hex"),
                ),
                recipientKeyId: record.snapshot.recipient!.recipientKeyId,
                recipientPublicKey: Uint8Array.from(
                  Buffer.from(
                    record.snapshot.recipient!.recipientPublicKey,
                    "base64url",
                  ),
                ),
              },
              responseBytes,
              signerAuthorizationBytes,
              now,
              resolveCurrentIssuingDevicePublicKey: () =>
                current.deviceSigningPublicKey,
            }),
        },
        transformMaterial: {
          loadAccepted: () => Promise.resolve({
            status: "loaded" as const,
            material: {
              signerAuthorizationBytes:
                replayFulfillment.signerAuthorizationBytes.slice(),
              resolveCurrentIssuerPublicKey: () =>
                current.deviceSigningPublicKey,
              resolveHistoricalNamespaceCommitter: () =>
                current.deviceSigningPublicKey,
              resolveCurrentSignerIssuingDevicePublicKey: () =>
                current.deviceSigningPublicKey,
              claims: {
                // Models restart after the durable one-run credential claim
                // committed but before any product publication was reserved.
                claimExactCredential: () =>
                  Promise.resolve("already_claimed"),
              },
              objects: objectPort,
            },
          }),
        },
        execution: {
          executeWork: () =>
            Promise.reject(new Error("crash before publication reservation")),
          reconcilePublication: () => {
            replayReconciliations += 1;
            return Promise.resolve("not_started");
          },
        },
        now: () => NOW + 2,
        recipientKeyId: () => "unused-recipient",
        claimId: () => "claim-replayed",
        nextAttemptAt: (_record, _reason, now) => now,
      });
    expect(await replayCoordinator.acceptDeviceResponse({
      requestId: replayDescriptor.requestId,
      responseBytes: replayFulfillment.responseBytes,
      signerAuthorizationBytes:
        replayFulfillment.signerAuthorizationBytes,
    })).toEqual({ status: "accepted" });
    expect(await replayCoordinator.run(replayDescriptor.requestId))
      .toEqual({
        status: "retry_scheduled",
        recipientGeneration: 1,
        reason: "recipient_lost",
      });
    expect(replayReconciliations).toBe(1);
    expect(await repository.get(replayDescriptor.requestId)).toMatchObject({
      snapshot: {
        state: "awaiting_recipient",
        recipientGeneration: 1,
      },
      descriptorBytes: null,
      acceptedMaterial: null,
    });

    expect(containsSecret(publication.durable)).toBe(false);
    expect(cryptoObjects.has(OUTPUT_OBJECT_ID)).toBe(true);
    const storedEvent = cryptoObjects.get(OUTPUT_OBJECT_ID);
    if (storedEvent === undefined) throw new Error("crypto output missing");
    const semanticBytes = new TextEncoder().encode(SECRET_EVENT);
    expect([
      storedEvent.payloadBytes,
      storedEvent.envelopeBytes,
      storedEvent.manifestBytes,
    ].some((bytes) => containsBytes(bytes, semanticBytes))).toBe(false);

    const plan = publication.attachmentPlan;
    if (plan === null || plan.events[0] === undefined) {
      throw new Error("attached plan missing");
    }
    const event = plan.events[0];
    const batch: ProtectedJournalProductReadBatch = {
      roomId: plan.roomId,
      namespaceId: plan.namespaceId,
      domainId: descriptor.domainId,
      rebuildGeneration: plan.rebuildGeneration,
      expectedAccessRevision: descriptor.expectedNamespaceAccessRevision,
      expectedPolicyRevision: descriptor.expectedPolicyRevision,
      rollup: null,
      events: [{
        kind: "event",
        cryptoObjectId: event.objectId,
        rebuildGeneration: plan.rebuildGeneration,
        status: "active",
        payloadFormat: "record_v1",
        recordMetadata: {
          lifecycle: "current",
          structuralHeight: 0,
          processingGeneration: plan.rebuildGeneration + 1,
        },
        binding: {
          eventId: event.eventId,
          roomId: plan.roomId,
          namespaceId: plan.namespaceId,
          sequence: event.sequence,
          kind: event.kind,
          supersedesEventId: event.supersedesEventId,
          resolvesEventId: event.resolvesEventId,
          sourceMessageIds: event.sourceMessageIds,
          sourceBatchId: event.sourceBatchId,
          batchLocalOrdinal: event.batchLocalOrdinal,
          extractorVersion: event.extractorVersion,
          createdAt: event.createdAt,
        },
      }],
    };
    const currentSession = Object.freeze({
      sessionId: "current-agent-session",
    });
    const contentOpener = createProtectedJournalAgentContentOpener({
      crypto,
      authority: {
        execute: async (input) => {
          if (
            input.authorizationSession !== currentSession
            || input.namespaceId !== NAMESPACE_ID
            || input.domainId !== descriptor.domainId
            || input.expectedAccessRevision
              !== descriptor.expectedNamespaceAccessRevision
            || input.expectedPolicyRevision
              !== descriptor.expectedPolicyRevision
          ) {
            return {
              status: "unavailable" as const,
              reason: "authorization_unavailable" as const,
            };
          }
          const controller = new AbortController();
          return {
            status: "executed" as const,
            value: await input.execute({
              material: {
                namespaceId: NAMESPACE_ID,
                domainId: descriptor.domainId,
                accessRevision:
                  descriptor.expectedNamespaceAccessRevision,
                agentAuthorizationRevision:
                  descriptor.expectedPolicyRevision,
                currentGeneration: keyrings.ai.currentGeneration,
                generations: keyrings.ai.generations.map((generation) => ({
                  generation: generation.generation,
                  key: generation.key,
                })),
              },
              signal: controller.signal,
              assertActive: () => {
                if (controller.signal.aborted) {
                  throw new Error("foreground session expired");
                }
              },
            }),
          };
        },
      },
      verifiedObjects: {
        verify: ({ objectId: requestedObjectId }) => {
          const stored = cryptoObjects.get(requestedObjectId);
          if (stored === undefined) return Promise.resolve(null);
          return Promise.resolve({
            objectId: requestedObjectId,
            namespaceId: NAMESPACE_ID,
            domainId: descriptor.domainId,
            workId: descriptor.workId,
            rebuildGeneration: 0,
            outputOrdinal: 0,
            authorizedOutputObjectIds: [OUTPUT_OBJECT_ID],
            publisherNamespaceAccessRevision:
              descriptor.expectedNamespaceAccessRevision,
            payloadBytes: stored.payloadBytes.slice(),
            namespaceEnvelopeBytes: stored.envelopeBytes.slice(),
          });
        },
      },
    });
    const reader = createProtectedForegroundJournalReader({
      productReads: { readCurrent: () => Promise.resolve(batch) },
      contentOpener,
    });
    const foreground = await reader.withCurrentJournal({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      maximumEvents: 16,
      maximumContextBytes: 4_096,
      productReadAuthorization: Object.freeze({}) as never,
      authorization: currentSession as never,
      entrypointId: "foreground.main",
      execute: (journal) => journal,
    });
    expect(foreground).toMatchObject({
      status: "executed",
      value: {
        events: [{ statement: SECRET_EVENT }],
      },
    });
    expect(await reader.withCurrentJournal({
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      maximumEvents: 16,
      maximumContextBytes: 4_096,
      productReadAuthorization: Object.freeze({}) as never,
      authorization: Object.freeze({
        sessionId: "expired-agent-session",
      }) as never,
      entrypointId: "foreground.main",
      execute: (journal) => journal,
    })).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    expect(JSON.stringify(batch)).not.toContain(SECRET_EVENT);
    expect(publication.invalidateForRebuild(0)).toBe("stale");
    expect(publication.invalidateForRebuild(1)).toBe("tombstone_pending");
    expect(publication.productObjects.size).toBe(1);
    publication.confirmTombstone();
    expect(publication.productObjects.size).toBe(0);
    expect(containsSecret(publication)).toBe(false);
  });

  test("sanitizes provider failure and bounds retry generations", async () => {
    const bindings: ProtectedStenographerSourceBinding[] = [{
      kind: "message",
      objectId: INPUT_OBJECT_ID,
      source: "current",
      messageId: 41,
      editRevision: 0,
      createdAt: new Date(CREATED_AT),
      participantId: "human-alice",
      role: "user",
      conversationalBoundary: true,
    }];
    const publication = new ContentFreePublicationHarness();
    const openedPlaintext = encodeMessagePayloadV2({
      role: "user",
      content: SECRET_SOURCE,
    });
    const noPublicationPrefixes: number[] = [];
    const failed = await runProtectedStenographerExtraction({
      signal: new AbortController().signal,
      capability: {
        openInputs: () => Promise.resolve([{
          objectId: INPUT_OBJECT_ID,
          plaintext: openedPlaintext,
        }]),
        publishOutputs: (outputs) => {
          noPublicationPrefixes.push(outputs.length);
          return Promise.resolve();
        },
      },
      work: extractionWork(
        bindings,
        "request-provider-failure",
        1,
        2,
      ),
      resolveParticipantDisplays: () =>
        Promise.resolve([{
          participantId: "human-alice",
          displayLabel: "Alice",
        }]),
      invokeModel: () =>
        Promise.reject(new Error(
          `provider leaked raw prompt: ${SECRET_SOURCE}`,
        )),
      publication,
    });
    expect(failed).toEqual({
      status: "rejected",
      reason: "provider_failure",
    });
    expect(publication.durable).toEqual([]);
    expect(noPublicationPrefixes).toEqual([0]);
    expect(openedPlaintext.every((byte) => byte === 0)).toBe(true);

    let retry = advanceRetryAttemptToRunning(
      createBackgroundAuthorizationRequest({
        requestId: "request-retry",
        workId: "work-retry",
        namespaceId: NAMESPACE_ID,
        credentialSubject: {
          kind: "processor",
          processorKind: "stenographer",
          processorVersion: 1,
          authorizationRevision: 19,
        },
        now: NOW,
      }),
      0,
      NOW + 1,
    );
    for (
      let count = 0;
      count < BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT;
      count += 1
    ) {
      const retryAt = retry.updatedAt + 1;
      retry = advanceBackgroundAuthorizationGeneration(retry, {
        reason: "provider_transient_failure",
        now: retryAt,
        nextAttemptAt: retryAt,
      });
      retry = advanceRetryAttemptToRunning(
        retry,
        count + 1,
        retryAt + 1,
      );
    }
    expect(retry.retryCount).toBe(BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT);
    expect(() => advanceBackgroundAuthorizationGeneration(retry, {
      reason: "provider_transient_failure",
      now: retry.updatedAt + 1,
      nextAttemptAt: retry.updatedAt + 1,
    })).toThrow("counter_exhausted");
    const terminal = failBackgroundAuthorizationRequest(
      retry,
      "retry_limit_exhausted",
      retry.updatedAt + 2,
    );
    expect(terminal).toMatchObject({
      state: "terminal_failure",
      terminalReason: "retry_limit_exhausted",
    });
    expect(containsSecret(terminal)).toBe(false);
  });

  test("terminalizes missing durable signer evidence as an integrity failure", async () => {
    const crypto = new LatticeCrypto(
      seededRng(24_102),
      { now: () => NOW + 3 },
    );
    const recipients = new ProcessorTransformRecipientRegistry({
      crypto,
      now: () => NOW + 3,
    });
    const initial = initialRecord(
      "request-missing-signer-evidence",
      "work-missing-signer-evidence",
    );
    let durable: BackgroundAuthorizationRecord = {
      ...initial,
      snapshot: advanceRetryAttemptToRunning(initial.snapshot, 0, NOW + 1),
      descriptorBytes: new Uint8Array([1]),
      acceptedMaterial: {
        responseBytes: new Uint8Array([2]),
        credentialId: "credential-missing-evidence",
        issuingDeviceAuthorizationRevision: 1,
        issuerSigningPublicKeyHash: new Uint8Array(32).fill(3),
        authorizationExpiresAt: NOW + 300_000,
      },
    };
    // This process owns the live attempt; a different process must wait for
    // the claim lease instead of examining or invalidating the owner's work.
    expect((await recipients.createAttempt({
      requestId: durable.snapshot.requestId,
      workId: durable.snapshot.workId,
      namespaceId: durable.snapshot.namespaceId,
      recipientGeneration: durable.snapshot.recipientGeneration,
      recipientKeyId: durable.snapshot.recipient!.recipientKeyId,
      expiresAt: durable.snapshot.recipient!.expiresAt,
    })).status).toBe("created");
    const repository: BackgroundAuthorizationRepository = {
      create: () => Promise.reject(new Error("not used")),
      get: () => Promise.resolve(durable),
      compareAndSwap: ({ expectedRequestRevision, next }) => {
        if (
          durable.snapshot.requestRevision !== expectedRequestRevision
        ) {
          return Promise.resolve({
            status: "stale",
            current: durable,
          });
        }
        durable = next;
        return Promise.resolve({ status: "updated", record: durable });
      },
      acceptVerifiedResponse: () =>
        Promise.reject(new Error("not used")),
      listEligible: () => Promise.resolve([]),
      listAwaitingDevicePage: () => Promise.resolve({
        records: [],
        continuation: null,
      }),
      pruneTerminal: () => Promise.resolve(0),
    };
    const coordinator = new ProtectedStenographerBackgroundCoordinator({
      repository,
      recipients,
      descriptors: {
        create: () => Promise.reject(new Error("not used")),
      },
      responses: {
        verify: () => Promise.reject(new Error("not used")),
      },
      transformMaterial: {
        loadAccepted: () =>
          Promise.resolve({ status: "integrity_failure" as const }),
      },
      execution: {
        executeWork: () => Promise.reject(new Error("not used")),
        reconcilePublication: () => Promise.resolve("not_started"),
      },
      now: () => NOW + 3,
      recipientKeyId: () => "not-used",
      claimId: () => "not-used",
      nextAttemptAt: (_record, _reason, now) => now,
    });

    expect(await coordinator.run(initial.snapshot.requestId)).toEqual({
      status: "terminal",
      reason: "integrity_failure",
    });
    expect(durable).toMatchObject({
      snapshot: {
        state: "terminal_failure",
        terminalReason: "integrity_failure",
      },
      finishedAt: NOW + 3,
    });
    recipients.close();
  });
});
