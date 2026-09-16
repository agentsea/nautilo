import {
  and,
  eq,
  exists,
  inArray,
  memories,
  memoryNamespaces,
} from "@nautilo/db";
import { namespaceId, type LatticeCrypto } from "@nautilo/lattice-crypto";
import type { MemoryNativeNamespaceAuthorityEntryV1 } from
  "@nautilo/lattice-crypto/wire";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import {
  assertHumanMemoryRepairAttestationV1,
  humanMemoryRepairAttestationSigningDigestV1,
  humanMemoryRepairPayloadDigestV1,
  type HumanMemoryRepairAttestationV1,
} from "../../memory/human-memory-repair-attestation.ts";
import type { MemoryPayloadV1 } from "../../memory/memory-payload-v1.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
} from "../../memory/memory-repository.ts";
import {
  attachPostgresForegroundMemoryRepair,
  foregroundMemoryRepairCommitment,
  restorePostgresForegroundMemoryOrdinary,
  type ForegroundMemoryRepairSource,
} from "./postgres-foreground-memory-repair.ts";
import type {
  ConversationProductCanonicalTransactionRunner,
} from "../message/postgres-conversation-product-store.ts";

export type HumanMemoryRepresentationRepairResult =
  | "repaired"
  | "replayed"
  | "conflict"
  | "unauthorized"
  | "waiting_for_authority";

export interface HumanMemoryRepairNativeAuthorityResolver {
  withCurrent<Result>(input: Readonly<{
    subjectUserId: string;
    subjectHumanId: string;
    humanActorId: string;
    deviceId: string;
    deviceSigningKeyGeneration: number;
    hostAuthorizationRevision: number;
    namespaces: readonly MemoryNativeNamespaceAuthorityEntryV1[];
  }>, publish: () => Promise<Result>): Promise<Result | null>;
}

type HumanMemoryRepresentationRepairCommon = Readonly<{
  crypto: LatticeCrypto;
  canonical: ConversationProductCanonicalTransactionRunner;
  committerSigningPublicKey: Uint8Array;
  authority: Readonly<{
    userId: string;
    humanId: string;
    humanActorId: string;
    readableNamespaceIds: readonly string[];
  }>;
  source: ForegroundMemoryRepairSource;
  payload: MemoryPayloadV1;
  nativeAuthority: HumanMemoryRepairNativeAuthorityResolver;
  now: number;
}>;

export type PublishPostgresHumanMemoryRepresentationRepairInput =
  | HumanMemoryRepresentationRepairCommon & Readonly<{
    attestation: HumanMemoryRepairAttestationV1 & Readonly<{
      direction: "ordinary_to_protected";
    }>;
    completeForward(attestation: HumanMemoryRepairAttestationV1): Promise<boolean>;
  }>
  | HumanMemoryRepresentationRepairCommon & Readonly<{
    attestation: HumanMemoryRepairAttestationV1 & Readonly<{
      direction: "protected_to_ordinary";
    }>;
    verifyReverse(attestation: HumanMemoryRepairAttestationV1): Promise<boolean>;
  }>;

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function currentReadableSource(
  transaction: CanonicalTranscriptTx,
  source: ForegroundMemoryRepairSource,
  readableNamespaceIds: readonly string[],
): Promise<boolean> {
  if (readableNamespaceIds.length === 0) return false;
  const rows = await transaction.select({ id: memories.id }).from(memories)
    .where(and(
      eq(memories.id, source.memory.id),
      eq(memories.contentRevision, source.expectedContentRevision),
      exists(transaction.select({ id: memoryNamespaces.memoryId })
        .from(memoryNamespaces).where(and(
          eq(memoryNamespaces.memoryId, memories.id),
          inArray(memoryNamespaces.namespaceId, [...readableNamespaceIds]),
        ))),
    )).limit(2);
  return rows.length === 1;
}

export function authenticateHumanMemoryRepresentationRepairSource(input: Readonly<{
  crypto: LatticeCrypto;
  authority: Readonly<{
    humanId: string;
    humanActorId: string;
    readableNamespaceIds: readonly string[];
  }>;
  source: ForegroundMemoryRepairSource;
  attestation: HumanMemoryRepairAttestationV1;
  payload: MemoryPayloadV1;
  now: number;
}>): boolean {
  const value = input.attestation;
  try {
    assertHumanMemoryRepairAttestationV1(value);
  } catch {
    return false;
  }
  const namespaceIds = value.namespaces.map((entry) => entry.namespaceId);
  const requiredFingerprint = fingerprintRequiredMemoryNamespaces(
    input.source.accessNamespaceIds,
  );
  const payloadDigest = humanMemoryRepairPayloadDigestV1(input.payload);
  const forwardReplay = value.direction === "ordinary_to_protected"
    && input.source.completedRepairReceipt === true
    && input.source.plaintextBytes !== null
    && input.source.existingObjectId === value.cryptoObjectId
    && value.targetContentRevision === input.source.targetContentRevision;
  const replayCommitment = forwardReplay
    ? foregroundMemoryRepairCommitment({
      crypto: input.crypto,
      memoryId: value.memoryId,
      expectedContentRevision: value.expectedContentRevision,
      targetContentRevision: value.targetContentRevision,
      objectId: value.cryptoObjectId,
      requiredNamespaceFingerprint: requiredFingerprint,
      plaintextBytes: input.source.plaintextBytes,
    })
    : null;
  try {
    return input.source.accessNamespaceIds.some((namespaceId) =>
      input.authority.readableNamespaceIds.includes(namespaceId)
    )
      && ((input.now >= value.issuedAt && input.now < value.deadlineAt)
        || (forwardReplay && replayCommitment !== null
          && equal(replayCommitment, input.source.requestCommitment)))
      && value.subjectHumanId === input.authority.humanId
      && value.memoryId === input.source.memory.id
      && (value.expectedContentRevision === input.source.expectedContentRevision
        || (forwardReplay
          && value.expectedContentRevision <= value.targetContentRevision))
      && value.targetContentRevision === input.source.targetContentRevision
      && value.expectedCryptoAccessRevision === input.source.expectedAccessRevision
      && value.cryptoObjectId === deriveMemoryCryptoObjectIdV1({
        memoryId: input.source.memory.id,
        contentRevision: input.source.targetContentRevision,
      })
      && exactStrings(namespaceIds, input.source.accessNamespaceIds)
      && equal(value.requiredNamespaceFingerprint, requiredFingerprint)
      && equal(value.authoredPayloadDigest, payloadDigest)
      && (input.source.memory.type === null
        || input.source.memory.type === input.payload.type)
      && (input.source.memory.content === null
        || input.source.memory.content === input.payload.content)
      && (value.direction === "ordinary_to_protected"
        ? input.source.plaintextBytes !== null
          && (input.source.existingObjectId === null
            || input.source.existingObjectId === value.cryptoObjectId)
        : input.source.existingObjectId === value.cryptoObjectId
          && (input.source.plaintextBytes === null
            || (input.source.memory.type === input.payload.type
              && input.source.memory.content === input.payload.content)));
  } finally {
    requiredFingerprint.fill(0);
    payloadDigest.fill(0);
    replayCommitment?.fill(0);
  }
}

/**
 * Authenticate a device-opened Human repair and keep current device authority
 * held until the fenced product commit has resolved. The native resolver is
 * the existing Human Domain-v2 authority owner; it must compare every digest
 * in the supplied tuple while this callback is active.
 */
export async function publishPostgresHumanMemoryRepresentationRepair(
  input: PublishPostgresHumanMemoryRepresentationRepairInput,
): Promise<HumanMemoryRepresentationRepairResult> {
  const value = input.attestation;
  if (!authenticateHumanMemoryRepresentationRepairSource(input)) {
    return "unauthorized";
  }

  const signingDigest = humanMemoryRepairAttestationSigningDigestV1(value);
  try {
    const result = await input.nativeAuthority.withCurrent({
        subjectUserId: input.authority.userId,
        subjectHumanId: value.subjectHumanId,
        humanActorId: input.authority.humanActorId,
        deviceId: value.deviceId,
        deviceSigningKeyGeneration: value.deviceSigningKeyGeneration,
        hostAuthorizationRevision: value.hostAuthorizationRevision,
        namespaces: value.currentAuthorityEntries.map((entry) =>
          Object.freeze({ ...entry, namespaceId: namespaceId(entry.namespaceId) })
        ),
      }, async () => {
        if (!input.crypto.verify(input.committerSigningPublicKey,
          signingDigest, value.signature)) {
          return "unauthorized" as const;
        }
        if ("completeForward" in input) {
            if (input.attestation.direction !== "ordinary_to_protected") {
              return "unauthorized" as const;
            }
            if (input.source.completedRepairReceipt !== true
              && !await input.completeForward(input.attestation)) {
              return "waiting_for_authority" as const;
            }
            const attached = await attachPostgresForegroundMemoryRepair({
              canonical: input.canonical,
              expectedPolicyRevision: value.policyRevision,
              authorizeSource: (transaction) =>
                currentReadableSource(transaction, input.source,
                  input.authority.readableNamespaceIds),
              source: input.source,
              objectId: value.cryptoObjectId,
              requestCommitment: input.source.requestCommitment,
            });
            return attached === "attached" ? "repaired" as const : attached;
          }
          if (input.attestation.direction !== "protected_to_ordinary"
            || !await input.verifyReverse(input.attestation)) {
            return "unauthorized" as const;
          }
          const restored = await restorePostgresForegroundMemoryOrdinary({
            canonical: input.canonical,
            source: input.source,
            objectId: value.cryptoObjectId,
            type: input.payload.type,
            content: input.payload.content,
            expectedPolicyRevision: value.policyRevision,
            authorizeSource: (transaction) =>
              currentReadableSource(transaction, input.source,
                input.authority.readableNamespaceIds),
          });
          return restored === "restored" ? "repaired" as const : restored;
      });
    return result ?? "unauthorized";
  } finally {
    signingDigest.fill(0);
  }
}
