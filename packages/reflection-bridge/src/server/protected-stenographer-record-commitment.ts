import { createHmac } from "node:crypto";

export interface ProtectedStenographerRecordCommitmentInput {
  readonly descriptorCommitment: Uint8Array;
  readonly eventId: string;
  readonly objectId: string;
  readonly sourceBatchId: string;
  readonly batchLocalOrdinal: number;
}

export interface ProtectedStenographerRecordCommitmentPort {
  commit(input: ProtectedStenographerRecordCommitmentInput): Uint8Array;
}

/**
 * Server-keyed, content-free commitment for one native protected observation.
 * The descriptor digest is an input to the MAC, never the stored commitment.
 */
export function createHmacProtectedStenographerRecordCommitmentPort(
  key: Uint8Array,
): ProtectedStenographerRecordCommitmentPort {
  if (key.byteLength < 32) {
    throw new TypeError("Protected Stenographer Record commitment key is too short");
  }
  const ownedKey = key.slice();
  return Object.freeze({
    commit(input: ProtectedStenographerRecordCommitmentInput): Uint8Array {
      if (input.descriptorCommitment.byteLength !== 32) {
        throw new TypeError("Protected Stenographer descriptor commitment is invalid");
      }
      if (
        !Number.isSafeInteger(input.batchLocalOrdinal)
        || input.batchLocalOrdinal < 0
      ) {
        throw new TypeError("Protected Stenographer ordinal is invalid");
      }
      const hmac = createHmac("sha256", ownedKey);
      for (const value of [
        "nautilo/stenographer/protected-record-replay/v1",
        input.sourceBatchId,
        String(input.batchLocalOrdinal),
        input.eventId,
        input.objectId,
      ]) {
        const bytes = Buffer.from(value, "utf8");
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(bytes.byteLength);
        hmac.update(length);
        hmac.update(bytes);
      }
      hmac.update(input.descriptorCommitment);
      return Uint8Array.from(hmac.digest());
    },
  });
}
