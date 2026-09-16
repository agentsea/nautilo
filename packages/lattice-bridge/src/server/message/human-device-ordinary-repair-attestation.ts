import { sha256 } from "@noble/hashes/sha2.js";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1 } from
  "@nautilo/lattice-crypto/wire";
import type { PostgresJsBridgeConnection } from "@nautilo/db";

import {
  conversationOrdinaryRepairIdentityDigest,
  type ConversationOrdinaryRepairProductStorePort,
} from "../../message/conversation-repository.ts";
import {
  type MessagePayloadV2,
} from "../../message/message-payload-v2.ts";
import {
  humanDeviceOrdinaryRepairPayloadDigestV2,
  humanDeviceOrdinaryRepairSigningDigestV2,
  humanDeviceOrdinaryRepairSigningDigestV3,
  type HumanDeviceOrdinaryRepairAttestation,
} from "../../message/human-device-ordinary-repair-attestation-v2.ts";
import { withCurrentHumanDeviceSigningAuthority } from
  "../device/postgres-current-human-device-signing-authority.ts";

export async function publishHumanDeviceOrdinaryRepairV2(input: Readonly<{
  crypto: LatticeCrypto;
  restricted: PostgresJsBridgeConnection;
  product: ConversationOrdinaryRepairProductStorePort;
  authority: Readonly<{ userId: string; humanActorId: string }>;
  attestation: HumanDeviceOrdinaryRepairAttestation;
  payload: MessagePayloadV2;
  now: number;
  currentNamespaceAccessRevision?: number;
}>): Promise<"applied" | "replayed" | "missing" | "stale" | "conflict" | "unauthorized"> {
  const value = input.attestation;
  const fields = Object.keys(value).sort();
  const expectedFields = [
    "authorRole", "createdAt", "cryptoObjectId", "deadlineAt", "editRevision",
    "hostAuthorizationRevision", "issuedAt", "messageId", "namespaceAccessRevision",
    "namespaceId", "namespaceKeyGeneration", "operationId", "payloadDigest",
    "policyRevision", "purpose", "readerDeviceId",
    "readerDeviceSigningKeyGeneration", "roomId", "sessionId", "signature",
    "subjectHumanId", "version",
    ...(value.version === 3 ? ["keyClass"] : []),
  ].sort();
  const counters = [
    value.policyRevision, value.readerDeviceSigningKeyGeneration,
    value.hostAuthorizationRevision, value.namespaceAccessRevision,
    value.namespaceKeyGeneration, value.messageId, value.editRevision,
    value.createdAt, value.issuedAt, value.deadlineAt,
  ];
  if (fields.length !== expectedFields.length
    || fields.some((field, index) => field !== expectedFields[index])
    || (value.version !== 2 && value.version !== 3) || value.purpose !== "human_device_ordinary_repair"
    || (value.version === 3 && value.keyClass !== "human" && value.keyClass !== "ai")
    || value.subjectHumanId !== input.authority.humanActorId
    || counters.some((counter) => !Number.isSafeInteger(counter) || counter < 0)
    || value.policyRevision < 1 || value.readerDeviceSigningKeyGeneration < 1
    || value.messageId < 1 || value.deadlineAt <= value.issuedAt
    || value.deadlineAt - value.issuedAt
      > HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_TTL_MS_V1
    || value.payloadDigest.length !== 32 || value.signature.length !== 64
    || input.now < value.issuedAt || input.now >= value.deadlineAt
    || input.payload.role !== value.authorRole) return "unauthorized";
  const actualPayloadDigest = humanDeviceOrdinaryRepairPayloadDigestV2(input.payload);
  try {
    if (actualPayloadDigest.length !== value.payloadDigest.length
      || !actualPayloadDigest.every((byte, index) => byte === value.payloadDigest[index])) {
      return "unauthorized";
    }
    const { signature } = value;
    const keyClass = value.version === 2 ? "human" : value.keyClass;
    const signed = value.version === 2 ? humanDeviceOrdinaryRepairSigningDigestV2(value)
      : humanDeviceOrdinaryRepairSigningDigestV3(value);
    try {
      const published = await withCurrentHumanDeviceSigningAuthority(
        input.restricted,
        {
          subjectUserId: input.authority.userId,
          subjectHumanId: value.subjectHumanId,
          humanActorId: input.authority.humanActorId,
          deviceId: value.readerDeviceId,
          deviceSigningKeyGeneration: value.readerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: value.hostAuthorizationRevision,
        },
        async (publicKey) => {
          if (!input.crypto.verify(publicKey, signed, signature)) return "unauthorized" as const;
          const repairIdentityDigest = conversationOrdinaryRepairIdentityDigest({
            sessionId: value.sessionId,
            messageId: value.messageId,
            revision: value.editRevision,
            cryptoObjectId: value.cryptoObjectId,
            namespaceId: value.namespaceId,
            namespaceAccessRevision: value.namespaceAccessRevision,
            namespaceKeyGeneration: value.namespaceKeyGeneration,
            keyClass,
            publisherKind: "device_attested",
            publisherId: value.readerDeviceId,
            policyRevision: value.policyRevision,
          });
          const attestationDigest = sha256(new Uint8Array([...signed, ...signature]));
          try {
            return await input.product.restoreOrdinaryExistingRepresentation({
              sessionId: value.sessionId,
              messageId: value.messageId,
              revision: value.editRevision,
              cryptoObjectId: value.cryptoObjectId,
              expectedNamespaceId: value.namespaceId,
              expectedKeyClass: keyClass,
              expectedNamespaceAccessRevision: value.namespaceAccessRevision,
              expectedNamespaceKeyGeneration: value.namespaceKeyGeneration,
              ...(input.currentNamespaceAccessRevision === undefined ? {} : {
                currentNamespaceAccessRevision: input.currentNamespaceAccessRevision,
              }),
              expectedAuthorRole: value.authorRole,
              expectedCreatedAt: value.createdAt,
              content: input.payload.content,
              toolCalls: input.payload.role === "system"
                ? input.payload.sensitiveMetadata === undefined ? null : JSON.stringify(input.payload.sensitiveMetadata)
                : input.payload.toolCalls === undefined ? null : JSON.stringify(input.payload.toolCalls),
              toolName: input.payload.toolName ?? null,
              authorityActorId: input.authority.humanActorId,
              repairIdentityDigest,
              attestationDigest,
              publisher: { kind: "device_attested", id: value.readerDeviceId },
              publicationPolicy: {
                expectedRevision: value.policyRevision,
                representation: "ordinary_and_protected",
              },
            });
          } finally {
            repairIdentityDigest.fill(0);
            attestationDigest.fill(0);
          }
        },
      );
      return published ?? "unauthorized";
    } finally {
      signed.fill(0);
    }
  } finally {
    actualPayloadDigest.fill(0);
  }
}
