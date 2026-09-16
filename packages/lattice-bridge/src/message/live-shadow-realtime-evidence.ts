import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  encodeProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "@nautilo/types";

const DOMAIN = new TextEncoder().encode(
  "nautilo/live-shadow-durable-event-evidence/v1",
);
const FULL_ENCRYPTION_DOMAIN_V2 = new TextEncoder().encode(
  "nautilo/full-encryption-durable-event-evidence/v2",
);
const MAX_FIELD_BYTES = 4_350_000;

export interface LiveShadowDurableEventEvidenceV1 {
  readonly operationId: string;
  readonly policyRevision: number;
  readonly transcriptOrdinal: number;
  readonly ordinaryPayloadBytes: Uint8Array;
  readonly protectedMessage: ProtectedMessageDtoV2;
}

export interface FullEncryptionDurableEventEvidenceV2 {
  readonly operationId: string;
  readonly policyRevision: number;
  readonly transcriptOrdinal: number;
  readonly protectedMessage: ProtectedMessageDtoV2;
}

function uint32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Live Shadow evidence integer is out of bounds");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function field(value: Uint8Array): Uint8Array {
  if (value.length > MAX_FIELD_BYTES) {
    throw new RangeError("Live Shadow evidence field exceeds its bound");
  }
  const length = uint32(value.length);
  const framed = new Uint8Array(length.length + value.length);
  framed.set(length, 0);
  framed.set(value, length.length);
  length.fill(0);
  return framed;
}

/**
 * Canonical content-bearing evidence for one correlated ordinary/protected
 * durable event. Every variable-width field is length framed, so no identity
 * substitution can preserve the same byte stream by moving delimiters.
 */
export function encodeLiveShadowDurableEventEvidenceV1(
  input: LiveShadowDurableEventEvidenceV1,
): Uint8Array {
  const encoder = new TextEncoder();
  const operationId = encoder.encode(input.operationId);
  const protectedDto = encoder.encode(
    encodeProtectedMessageDtoV2(input.protectedMessage),
  );
  const fields = [
    field(DOMAIN),
    field(operationId),
    field(uint32(input.policyRevision)),
    field(uint32(input.transcriptOrdinal)),
    field(input.ordinaryPayloadBytes),
    field(protectedDto),
  ];
  const size = fields.reduce((total, value) => total + value.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const value of fields) {
    bytes.set(value, offset);
    offset += value.length;
    value.fill(0);
  }
  operationId.fill(0);
  protectedDto.fill(0);
  return bytes;
}

export function liveShadowDurableEventDigestV1(
  crypto: Pick<LatticeCrypto, "hash">,
  input: LiveShadowDurableEventEvidenceV1,
): Uint8Array {
  const evidence = encodeLiveShadowDurableEventEvidenceV1(input);
  try {
    return crypto.hash(evidence);
  } finally {
    evidence.fill(0);
  }
}

/**
 * Canonical protected-only evidence for a Full encryption durable event.
 * The complete protected DTO binds structural identity and ciphertext while
 * the domain prevents a V1 Shadow event from being accepted as V2 evidence.
 */
export function encodeFullEncryptionDurableEventEvidenceV2(
  input: FullEncryptionDurableEventEvidenceV2,
): Uint8Array {
  const encoder = new TextEncoder();
  const operationId = encoder.encode(input.operationId);
  const protectedDto = encoder.encode(
    encodeProtectedMessageDtoV2(input.protectedMessage),
  );
  const fields = [
    field(FULL_ENCRYPTION_DOMAIN_V2),
    field(operationId),
    field(uint32(input.policyRevision)),
    field(uint32(input.transcriptOrdinal)),
    field(protectedDto),
  ];
  const size = fields.reduce((total, value) => total + value.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const value of fields) {
    bytes.set(value, offset);
    offset += value.length;
    value.fill(0);
  }
  operationId.fill(0);
  protectedDto.fill(0);
  return bytes;
}

export function fullEncryptionDurableEventDigestV2(
  crypto: Pick<LatticeCrypto, "hash">,
  input: FullEncryptionDurableEventEvidenceV2,
): Uint8Array {
  const evidence = encodeFullEncryptionDurableEventEvidenceV2(input);
  try {
    return crypto.hash(evidence);
  } finally {
    evidence.fill(0);
  }
}
