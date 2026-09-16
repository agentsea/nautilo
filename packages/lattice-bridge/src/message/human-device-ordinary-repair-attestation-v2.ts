import { sha256 } from "@noble/hashes/sha2.js";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { ConversationAuthorRole } from "./conversation-repository.ts";
import { encodeMessagePayloadV2, type MessagePayloadV2 } from "./message-payload-v2.ts";

const DOMAIN = "nautilo/conversation/human-device-ordinary-repair-attestation/v2";
const encoder = new TextEncoder();

export interface HumanDeviceOrdinaryRepairAttestationV2 {
  readonly version: 2;
  readonly purpose: "human_device_ordinary_repair";
  readonly operationId: string;
  readonly policyRevision: number;
  readonly subjectHumanId: string;
  readonly readerDeviceId: string;
  readonly readerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly namespaceKeyGeneration: number;
  readonly sessionId: string;
  readonly messageId: number;
  readonly editRevision: number;
  readonly cryptoObjectId: string;
  readonly authorRole: ConversationAuthorRole;
  readonly createdAt: number;
  readonly payloadDigest: Uint8Array;
  readonly issuedAt: number;
  readonly deadlineAt: number;
  readonly signature: Uint8Array;
}

export type HumanDeviceOrdinaryRepairAttestationUnsignedV2 =
  Omit<HumanDeviceOrdinaryRepairAttestationV2, "signature">;

/** V2 signed bytes remain Human-only. V3 explicitly binds the retained class. */
export interface HumanDeviceOrdinaryRepairAttestationV3
  extends Omit<HumanDeviceOrdinaryRepairAttestationV2, "version"> {
  readonly version: 3;
  readonly keyClass: "human" | "ai";
}
export type HumanDeviceOrdinaryRepairAttestation =
  HumanDeviceOrdinaryRepairAttestationV2 | HumanDeviceOrdinaryRepairAttestationV3;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function humanDeviceOrdinaryRepairSigningDigestV2(
  value: HumanDeviceOrdinaryRepairAttestationUnsignedV2,
): Uint8Array {
  return sha256(encoder.encode(JSON.stringify([DOMAIN, ...signingFields(value)])));
}

function signingFields(value: Omit<HumanDeviceOrdinaryRepairAttestation, "signature">) {
  return [value.version, value.purpose, value.operationId,
    value.policyRevision, value.subjectHumanId, value.readerDeviceId,
    value.readerDeviceSigningKeyGeneration, value.hostAuthorizationRevision,
    value.roomId, value.namespaceId, value.namespaceAccessRevision,
    value.namespaceKeyGeneration, value.sessionId, value.messageId,
    value.editRevision, value.cryptoObjectId, value.authorRole, value.createdAt,
    hex(value.payloadDigest), value.issuedAt, value.deadlineAt,
  ];
}

export function humanDeviceOrdinaryRepairSigningDigestV3(
  value: Omit<HumanDeviceOrdinaryRepairAttestationV3, "signature">,
): Uint8Array {
  if (value.keyClass !== "human" && value.keyClass !== "ai") throw new TypeError("Ordinary repair key class is invalid");
  return sha256(encoder.encode(JSON.stringify([
    "nautilo/conversation/human-device-ordinary-repair-attestation/v3",
    ...signingFields(value), value.keyClass,
  ])));
}

export function humanDeviceOrdinaryRepairPayloadDigestV2(
  payload: MessagePayloadV2,
): Uint8Array {
  const bytes = encodeMessagePayloadV2(payload);
  try { return sha256(bytes); } finally { bytes.fill(0); }
}

export function prepareHumanDeviceOrdinaryRepairAttestationV2(
  crypto: LatticeCrypto,
  input: Omit<HumanDeviceOrdinaryRepairAttestationUnsignedV2,
    "version" | "purpose" | "payloadDigest"> & Readonly<{
      payload: MessagePayloadV2;
      signingPrivateKey: Uint8Array;
    }>,
): HumanDeviceOrdinaryRepairAttestationV2 {
  const { payload, signingPrivateKey, ...coordinates } = input;
  const unsigned = Object.freeze({
    version: 2 as const,
    purpose: "human_device_ordinary_repair" as const,
    ...coordinates,
    payloadDigest: humanDeviceOrdinaryRepairPayloadDigestV2(payload),
  });
  const digest = humanDeviceOrdinaryRepairSigningDigestV2(unsigned);
  try {
    return Object.freeze({ ...unsigned, signature: crypto.sign(signingPrivateKey, digest) });
  } finally { digest.fill(0); }
}

export function prepareHumanDeviceOrdinaryRepairAttestationV3(
  crypto: LatticeCrypto,
  input: Omit<HumanDeviceOrdinaryRepairAttestationV3,
    "version" | "purpose" | "payloadDigest" | "signature"> & Readonly<{
      payload: MessagePayloadV2;
      signingPrivateKey: Uint8Array;
    }>,
): HumanDeviceOrdinaryRepairAttestationV3 {
  const { payload, signingPrivateKey, ...coordinates } = input;
  const unsigned = Object.freeze({ version: 3 as const,
    purpose: "human_device_ordinary_repair" as const, ...coordinates,
    payloadDigest: humanDeviceOrdinaryRepairPayloadDigestV2(payload) });
  const digest = humanDeviceOrdinaryRepairSigningDigestV3(unsigned);
  try { return Object.freeze({ ...unsigned, signature: crypto.sign(signingPrivateKey, digest) }); }
  finally { digest.fill(0); }
}
