import { describe, expect, test } from "bun:test";
import { LatticeCrypto, namespaceId } from "@nautilo/lattice-crypto";

import {
  humanMemoryRepairPayloadDigestV1,
  prepareHumanMemoryRepairAttestationV1,
} from "../../src/memory/human-memory-repair-attestation.ts";
import { encodeMemoryPayloadV1 } from "../../src/memory/memory-payload-v1.ts";
import { deriveMemoryCryptoObjectIdV1, fingerprintRequiredMemoryNamespaces } from
  "../../src/memory/memory-repository.ts";
import {
  authenticateHumanMemoryRepresentationRepairSource,
  publishPostgresHumanMemoryRepresentationRepair,
} from "../../src/server/memory/postgres-human-memory-representation-repair.ts";
import type { ForegroundMemoryRepairSource } from
  "../../src/server/memory/postgres-foreground-memory-repair.ts";
import { foregroundMemoryRepairCommitment } from
  "../../src/server/memory/postgres-foreground-memory-repair.ts";

const MEMORY_ID = "10000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_B = "10000000-0000-4000-8000-000000000003";
const payload = { formatVersion: 1 as const, type: "preference", content: "tea" };
const bytes = (fill: number) => new Uint8Array(32).fill(fill);

function source(direction: "ordinary_to_protected" | "protected_to_ordinary"):
  ForegroundMemoryRepairSource {
  return Object.freeze({
    memory: Object.freeze({
      representation: direction === "ordinary_to_protected"
        ? "ordinary" as const : "structural" as const,
      id: MEMORY_ID,
      type: direction === "ordinary_to_protected" ? payload.type : null,
      content: direction === "ordinary_to_protected" ? payload.content : null,
      importance: 0.5,
      tier: 1 as const,
      createdAt: new Date(100),
    }),
    expectedContentRevision: 3,
    targetContentRevision: direction === "ordinary_to_protected" ? 4 : 3,
    existingObjectId: direction === "ordinary_to_protected"
      ? null : deriveMemoryCryptoObjectIdV1({ memoryId: MEMORY_ID, contentRevision: 3 }),
    expectedAccessRevision: 0,
    accessNamespaceIds: [NAMESPACE_ID],
    createdAt: 100,
    plaintextBytes: direction === "ordinary_to_protected"
      ? encodeMemoryPayloadV1(payload) : null,
    requestCommitment: bytes(9),
  });
}

function fixture(direction: "ordinary_to_protected" | "protected_to_ordinary") {
  const crypto = new LatticeCrypto({
    bytes: (length) => new Uint8Array(length).fill(7),
  });
  const signer = crypto.generateSigningKeyPair();
  const repairSource = source(direction);
  const attestation = prepareHumanMemoryRepairAttestationV1(crypto, {
    version: 1,
    purpose: "human_memory_representation_repair",
    direction,
    operationId: "repair-1",
    policyRevision: 4,
    subjectHumanId: "human-1",
    deviceId: "device-1",
    deviceSigningKeyGeneration: 2,
    hostAuthorizationRevision: 3,
    memoryId: MEMORY_ID,
    expectedContentRevision: repairSource.expectedContentRevision,
    targetContentRevision: repairSource.targetContentRevision,
    expectedCryptoAccessRevision: repairSource.expectedAccessRevision,
    cryptoObjectId: deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID,
      contentRevision: repairSource.targetContentRevision,
    }),
    requiredNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces([NAMESPACE_ID]),
    currentAuthorityEntries: [Object.freeze({
      namespaceId: namespaceId(NAMESPACE_ID),
      namespaceAccessRevision: 18,
      keyGeneration: 19,
      headDigest: bytes(12), publicationDigest: bytes(13),
      publicationSetDigest: bytes(14), audienceFingerprint: bytes(15),
    })],
    namespaces: [Object.freeze({
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 8,
      namespaceKeyGeneration: 9,
      headDigest: bytes(2), publicationDigest: bytes(3),
      publicationSetDigest: bytes(4), audienceFingerprint: bytes(5),
      envelopeHash: bytes(6),
    })],
    payloadHash: bytes(7), accessManifestHash: bytes(8),
    authoredPayloadDigest: humanMemoryRepairPayloadDigestV1(payload),
    issuedAt: 100, deadlineAt: 200,
    signingPrivateKey: signer.privateKey,
    signingPublicKey: signer.publicKey,
  });
  return { crypto, repairSource, attestation, signerPublicKey: signer.publicKey };
}

describe("Postgres Human Memory representation repair source admission", () => {
  for (const direction of [
    "ordinary_to_protected", "protected_to_ordinary",
  ] as const) {
    test(`binds the selected ${direction} source and one readable attachment`, () => {
      const { crypto, repairSource, attestation } = fixture(direction);
      expect(authenticateHumanMemoryRepresentationRepairSource({
        crypto,
        authority: { humanId: "human-1", humanActorId: "actor-1",
          readableNamespaceIds: [NAMESPACE_ID] },
        source: repairSource, attestation, payload, now: 150,
      })).toBe(true);
      expect(authenticateHumanMemoryRepresentationRepairSource({
        crypto,
        authority: { humanId: "human-1", humanActorId: "actor-1",
          readableNamespaceIds: [] },
        source: repairSource, attestation, payload, now: 150,
      })).toBe(false);
      repairSource.plaintextBytes?.fill(0);
    });
  }

  test("rejects a changed ordinary source instead of repairing different bytes", () => {
    const { crypto, repairSource, attestation } = fixture("ordinary_to_protected");
    expect(authenticateHumanMemoryRepresentationRepairSource({
      crypto,
      authority: { humanId: "human-1", humanActorId: "actor-1",
        readableNamespaceIds: [NAMESPACE_ID] },
      source: repairSource, attestation,
      payload: { ...payload, content: "coffee" }, now: 150,
    })).toBe(false);
    repairSource.plaintextBytes?.fill(0);
  });

  test("accepts one selected source attached to multiple readable Namespaces", () => {
    const { crypto, repairSource, attestation } = fixture("ordinary_to_protected");
    const namespaces = [...attestation.namespaces, Object.freeze({
      ...attestation.namespaces[0]!, namespaceId: NAMESPACE_B,
    })];
    const multiSource = Object.freeze({
      ...repairSource,
      accessNamespaceIds: [NAMESPACE_ID, NAMESPACE_B],
    });
    expect(authenticateHumanMemoryRepresentationRepairSource({
      crypto,
      authority: { humanId: "human-1", humanActorId: "actor-1",
        readableNamespaceIds: [NAMESPACE_ID, NAMESPACE_B] },
      source: multiSource,
      attestation: Object.freeze({
        ...attestation,
        currentAuthorityEntries: [...attestation.currentAuthorityEntries,
          Object.freeze({
            ...attestation.currentAuthorityEntries[0]!,
            namespaceId: namespaceId(NAMESPACE_B),
          })],
        namespaces,
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_ID, NAMESPACE_B]),
      }),
      payload,
      now: 150,
    })).toBe(true);
    multiSource.plaintextBytes?.fill(0);
  });

  test("authenticates exact already-published forward and reverse retries", () => {
    for (const direction of [
      "ordinary_to_protected", "protected_to_ordinary",
    ] as const) {
      const { crypto, repairSource, attestation } = fixture(direction);
      const replaySource = Object.freeze({
        ...repairSource,
        existingObjectId: attestation.cryptoObjectId,
        ...(direction === "protected_to_ordinary" ? {
          memory: Object.freeze({
            ...repairSource.memory,
            representation: "ordinary" as const,
            type: payload.type,
            content: payload.content,
          }),
          plaintextBytes: encodeMemoryPayloadV1(payload),
        } : {}),
      });
      expect(authenticateHumanMemoryRepresentationRepairSource({
        crypto,
        authority: { humanId: "human-1", humanActorId: "actor-1",
          readableNamespaceIds: [NAMESPACE_ID] },
        source: replaySource, attestation, payload, now: 150,
      })).toBe(true);
      replaySource.plaintextBytes?.fill(0);
    }
  });

  test("recognizes a lost-response replay of a zero-to-one forward repair", () => {
    const { crypto, repairSource, attestation } = fixture("ordinary_to_protected");
    const replaySource = Object.freeze({
      ...repairSource,
      expectedContentRevision: 1,
      targetContentRevision: 1,
      existingObjectId: deriveMemoryCryptoObjectIdV1({
        memoryId: MEMORY_ID, contentRevision: 1,
      }),
      completedRepairReceipt: true as const,
      requestCommitment: foregroundMemoryRepairCommitment({
        crypto,
        memoryId: MEMORY_ID,
        expectedContentRevision: 0,
        targetContentRevision: 1,
        objectId: deriveMemoryCryptoObjectIdV1({
          memoryId: MEMORY_ID, contentRevision: 1,
        }),
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_ID]),
        plaintextBytes: repairSource.plaintextBytes!,
      }),
    });
    expect(authenticateHumanMemoryRepresentationRepairSource({
      crypto,
      authority: { humanId: "human-1", humanActorId: "actor-1",
        readableNamespaceIds: [NAMESPACE_ID] },
      source: replaySource,
      attestation: Object.freeze({
        ...attestation,
        expectedContentRevision: 0,
        targetContentRevision: 1,
        cryptoObjectId: replaySource.existingObjectId,
      }),
      payload,
      now: 150,
    })).toBe(true);
    replaySource.plaintextBytes?.fill(0);
  });

  test("replays an expired higher reserved revision only with its mapped receipt", () => {
    const { crypto, repairSource, attestation } = fixture("ordinary_to_protected");
    const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
      memoryId: MEMORY_ID, contentRevision: 4,
    });
    const fingerprint = fingerprintRequiredMemoryNamespaces([NAMESPACE_ID]);
    const replaySource = Object.freeze({
      ...repairSource,
      expectedContentRevision: 4,
      targetContentRevision: 4,
      existingObjectId: cryptoObjectId,
      completedRepairReceipt: true as const,
      requestCommitment: foregroundMemoryRepairCommitment({
        crypto,
        memoryId: MEMORY_ID,
        expectedContentRevision: 2,
        targetContentRevision: 4,
        objectId: cryptoObjectId,
        requiredNamespaceFingerprint: fingerprint,
        plaintextBytes: repairSource.plaintextBytes!,
      }),
    });
    const replayAttestation = Object.freeze({
      ...attestation,
      expectedContentRevision: 2,
      targetContentRevision: 4,
      cryptoObjectId,
    });
    const { completedRepairReceipt: _receipt, ...unreceiptedSource } = replaySource;
    expect(authenticateHumanMemoryRepresentationRepairSource({
      crypto,
      authority: { humanId: "human-1", humanActorId: "actor-1",
        readableNamespaceIds: [NAMESPACE_ID] },
      source: replaySource,
      attestation: replayAttestation,
      payload,
      now: 250,
    })).toBe(true);
    expect(authenticateHumanMemoryRepresentationRepairSource({
      crypto,
      authority: { humanId: "human-1", humanActorId: "actor-1",
        readableNamespaceIds: [NAMESPACE_ID] },
      source: unreceiptedSource,
      attestation: replayAttestation,
      payload,
      now: 250,
    })).toBe(false);
    fingerprint.fill(0);
    replaySource.requestCommitment.fill(0);
    replaySource.plaintextBytes?.fill(0);
  });

  test("expired committed replay revalidates canonically without publishing again", async () => {
    const { crypto, repairSource, attestation, signerPublicKey } =
      fixture("ordinary_to_protected");
    const replaySource = Object.freeze({
      ...repairSource,
      expectedContentRevision: attestation.targetContentRevision,
      existingObjectId: attestation.cryptoObjectId,
      completedRepairReceipt: true as const,
      requestCommitment: foregroundMemoryRepairCommitment({
        crypto,
        memoryId: MEMORY_ID,
        expectedContentRevision: attestation.expectedContentRevision,
        targetContentRevision: attestation.targetContentRevision,
        objectId: attestation.cryptoObjectId,
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces([NAMESPACE_ID]),
        plaintextBytes: repairSource.plaintextBytes!,
      }),
    });
    let completionCalls = 0;
    await publishPostgresHumanMemoryRepresentationRepair({
      crypto,
      canonical: {
        transaction: async () => {
          throw new Error("canonical replay revalidation reached");
        },
      } as never,
      committerSigningPublicKey: signerPublicKey,
      authority: { userId: "user-1", humanId: "human-1",
        humanActorId: "actor-1", readableNamespaceIds: [NAMESPACE_ID] },
      source: replaySource,
      payload,
      nativeAuthority: { withCurrent: async (_current, publish) => publish() },
      now: attestation.deadlineAt + 1,
      attestation: Object.freeze({
        ...attestation,
        direction: "ordinary_to_protected" as const,
      }),
      completeForward: async () => {
        completionCalls += 1;
        return true;
      },
    }).then(
      () => { throw new Error("expected canonical replay revalidation"); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message)
          .toBe("canonical replay revalidation reached");
      },
    );
    expect(completionCalls).toBe(0);
    replaySource.requestCommitment.fill(0);
    replaySource.plaintextBytes?.fill(0);
  });

  test("requires the signed device generation inside the held native lease", async () => {
    const { repairSource, attestation } = fixture("ordinary_to_protected");
    const crypto = new LatticeCrypto({
      bytes: (length) => new Uint8Array(length).fill(11),
    });
    const unrelated = crypto.generateSigningKeyPair();
    const acquiredGenerations: number[] = [];
    const result = await publishPostgresHumanMemoryRepresentationRepair({
      crypto,
      canonical: {} as never,
      committerSigningPublicKey: unrelated.publicKey,
      authority: { userId: "user-1", humanId: "human-1",
        humanActorId: "actor-1", readableNamespaceIds: [NAMESPACE_ID] },
      source: repairSource,
      payload,
      nativeAuthority: {
        withCurrent: async (current, publish) => {
          acquiredGenerations.push(current.deviceSigningKeyGeneration);
          return current.deviceSigningKeyGeneration
              === attestation.deviceSigningKeyGeneration
            ? publish() : null;
        },
      },
      now: 150,
      attestation: Object.freeze({
        ...attestation, direction: "ordinary_to_protected" as const,
      }),
      completeForward: async () => {
        throw new Error("invalid device signature reached persistence");
      },
    });
    expect(acquiredGenerations).toEqual([
      attestation.deviceSigningKeyGeneration,
    ]);
    expect(result).toBe("unauthorized");
    unrelated.privateKey.fill(0);
    repairSource.plaintextBytes?.fill(0);
  });
});
