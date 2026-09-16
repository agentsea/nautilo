import {
  cryptoDeviceId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";

export const DELIVERY_ACKNOWLEDGEMENT_FORMAT_VERSION = 2 as const;

export interface DeliveryMessageReceiptTarget {
  readonly messageId: string;
  readonly recipientDeviceId: string;
  readonly recipientSequence: number;
  readonly payloadHash: Uint8Array;
}

export interface DeliveryAcknowledgementProof {
  readonly formatVersion: typeof DELIVERY_ACKNOWLEDGEMENT_FORMAT_VERSION;
  readonly messageId: string;
  readonly deviceId: string;
  readonly recipientSequence: number;
  readonly payloadHash: Uint8Array;
  readonly processedRevision: number;
  readonly acknowledgedAt: number;
  readonly signature: Uint8Array;
}

export interface VerifiedDeliveryAcknowledgement {
  readonly messageId: string;
  readonly deviceId: string;
  readonly recipientSequence: number;
  readonly payloadHash: Uint8Array;
  readonly processedRevision: number;
  readonly acknowledgementDigest: Uint8Array;
  readonly acknowledgedAt: number;
}

const verifiedDeliveryAcknowledgements =
  new WeakMap<object, VerifiedDeliveryAcknowledgement>();

export type ResolveAcknowledgingDevice = (
  deviceId: string,
) => {
  readonly state: "pending" | "active";
  readonly revision: number;
  readonly signingPublicKey: Uint8Array;
} | null;

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Delivery acknowledgement counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Delivery acknowledgement counter is unsafe");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function snapshotAcknowledgement(
  acknowledgement: VerifiedDeliveryAcknowledgement,
): VerifiedDeliveryAcknowledgement {
  return Object.freeze({
    ...acknowledgement,
    payloadHash: Uint8Array.from(acknowledgement.payloadHash),
    acknowledgementDigest:
      Uint8Array.from(acknowledgement.acknowledgementDigest),
  });
}

export function assertVerifiedDeliveryAcknowledgement(
  value: VerifiedDeliveryAcknowledgement,
): void {
  const snapshot = typeof value === "object" && value !== null
    ? verifiedDeliveryAcknowledgements.get(value)
    : undefined;
  if (
    snapshot === undefined
    || value.messageId !== snapshot.messageId
    || value.deviceId !== snapshot.deviceId
    || value.recipientSequence !== snapshot.recipientSequence
    || !equalBytes(value.payloadHash, snapshot.payloadHash)
    || value.processedRevision !== snapshot.processedRevision
    || !equalBytes(
      value.acknowledgementDigest,
      snapshot.acknowledgementDigest,
    )
    || value.acknowledgedAt !== snapshot.acknowledgedAt
  ) {
    throw new TypeError(
      "Delivery acknowledgement was not cryptographically verified",
    );
  }
}

function assertTarget(target: DeliveryMessageReceiptTarget): void {
  if (
    typeof target.messageId !== "string"
    || target.messageId.length < 1
    || target.messageId.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(target.messageId)
  ) {
    throw new TypeError("Delivery acknowledgement message id is invalid");
  }
  cryptoDeviceId(target.recipientDeviceId);
  if (
    !Number.isSafeInteger(target.recipientSequence)
    || target.recipientSequence < 1
  ) {
    throw new RangeError(
      "Delivery acknowledgement recipient sequence is invalid",
    );
  }
  if (
    !(target.payloadHash instanceof Uint8Array)
    || target.payloadHash.length !== 32
  ) {
    throw new RangeError("Delivery acknowledgement payload hash is invalid");
  }
}

export function deliveryAcknowledgementSigningBytes(
  proof: Omit<DeliveryAcknowledgementProof, "signature">,
): Uint8Array {
  return concat([
    text("nautilo/lattice-bridge/delivery-acknowledgement/v2"),
    u32(proof.formatVersion),
    text(proof.messageId),
    text(proof.deviceId),
    u64(proof.recipientSequence),
    frame(proof.payloadHash),
    u64(proof.processedRevision),
    u64(proof.acknowledgedAt),
  ]);
}

export function createDeliveryAcknowledgementProof(input: {
  readonly crypto: LatticeCrypto;
  readonly message: DeliveryMessageReceiptTarget;
  readonly processedRevision: number;
  readonly acknowledgedAt: number;
  readonly signingPrivateKey: Uint8Array;
}): DeliveryAcknowledgementProof {
  assertTarget(input.message);
  const unsigned = Object.freeze({
    formatVersion: DELIVERY_ACKNOWLEDGEMENT_FORMAT_VERSION,
    messageId: input.message.messageId,
    deviceId: input.message.recipientDeviceId,
    recipientSequence: input.message.recipientSequence,
    payloadHash: Uint8Array.from(input.message.payloadHash),
    processedRevision: input.processedRevision,
    acknowledgedAt: input.acknowledgedAt,
  });
  return Object.freeze({
    ...unsigned,
    signature: input.crypto.sign(
      input.signingPrivateKey,
      deliveryAcknowledgementSigningBytes(unsigned),
    ),
  });
}

export function deliveryAcknowledgementDigest(
  crypto: Pick<LatticeCrypto, "hash">,
  proof: DeliveryAcknowledgementProof,
): Uint8Array {
  const signingBytes = deliveryAcknowledgementSigningBytes(proof);
  const framedSignature = frame(proof.signature);
  try {
    return crypto.hash(concat([signingBytes, framedSignature]));
  } finally {
    signingBytes.fill(0);
    framedSignature.fill(0);
  }
}

export function verifyDeliveryAcknowledgementProof(input: {
  readonly crypto: LatticeCrypto;
  readonly proof: DeliveryAcknowledgementProof;
  readonly message: DeliveryMessageReceiptTarget;
  readonly resolveDevice: ResolveAcknowledgingDevice;
}): VerifiedDeliveryAcknowledgement {
  assertTarget(input.message);
  const proof = input.proof;
  if (
    proof.formatVersion !== DELIVERY_ACKNOWLEDGEMENT_FORMAT_VERSION
    || proof.messageId !== input.message.messageId
    || proof.deviceId !== input.message.recipientDeviceId
    || proof.recipientSequence !== input.message.recipientSequence
    || !equalBytes(proof.payloadHash, input.message.payloadHash)
  ) {
    throw new Error("Delivery acknowledgement does not match its message");
  }
  const device = input.resolveDevice(proof.deviceId);
  if (
    device === null
    || !["pending", "active"].includes(device.state)
    || proof.processedRevision !== device.revision + 1
  ) {
    throw new Error("Delivery acknowledgement revision is stale");
  }
  const signingBytes = deliveryAcknowledgementSigningBytes(proof);
  if (
    !(proof.signature instanceof Uint8Array)
    || proof.signature.length !== 64
    || !input.crypto.verify(
      device.signingPublicKey,
      signingBytes,
      proof.signature,
    )
  ) {
    throw new Error("Delivery acknowledgement signature is invalid");
  }
  const verified = Object.freeze({
    messageId: proof.messageId,
    deviceId: proof.deviceId,
    recipientSequence: proof.recipientSequence,
    payloadHash: Uint8Array.from(proof.payloadHash),
    processedRevision: proof.processedRevision,
    acknowledgementDigest: deliveryAcknowledgementDigest(input.crypto, proof),
    acknowledgedAt: proof.acknowledgedAt,
  });
  verifiedDeliveryAcknowledgements.set(
    verified,
    snapshotAcknowledgement(verified),
  );
  return verified;
}
