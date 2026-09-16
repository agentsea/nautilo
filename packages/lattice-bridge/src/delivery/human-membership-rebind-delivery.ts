import {
  cryptoDeviceId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  assertVerifiedHumanMembershipRebindSubmission,
  serializeHumanMembershipRebindSubmission,
  type VerifiedHumanMembershipRebindSubmission,
} from "./human-membership-rebind-submission.ts";
import {
  MAX_FANOUT_PAYLOAD_BYTES,
  MAX_FANOUT_ROWS_PER_OPERATION,
} from "./device-fanout.ts";
import {
  chunkOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
} from "./opaque-artifact.ts";

export const HUMAN_MEMBERSHIP_REBIND_DELIVERY_TTL_MS =
  90 * 24 * 60 * 60 * 1_000;

export interface HumanMembershipRebindDeliveryMessage {
  readonly messageId: string;
  readonly operationId: string;
  readonly domainId: string;
  readonly kind: "binding_candidate";
  readonly recipientDeviceId: string;
  readonly formatVersion: 1;
  readonly payloadHash: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface HumanMembershipRebindDelivery {
  readonly operationId: string;
  readonly domainId: string;
  readonly messages: readonly HumanMembershipRebindDeliveryMessage[];
  readonly requiredAcknowledgementDeviceId: string;
  readonly fanoutRowCount: number;
  readonly aggregatePayloadBytes: number;
  readonly createdAt: number;
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left).compare(Buffer.from(right));
}

export function createHumanMembershipRebindDelivery(input: {
  readonly crypto: Pick<LatticeCrypto, "hash">;
  readonly submission: VerifiedHumanMembershipRebindSubmission;
  readonly recipientDeviceIds: readonly string[];
  readonly requiredAcknowledgementDeviceId: string;
  readonly now: number;
}): HumanMembershipRebindDelivery {
  assertVerifiedHumanMembershipRebindSubmission(input.submission);
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError("Human membership rebind delivery time is invalid");
  }
  const recipients = [...input.recipientDeviceIds]
    .map(cryptoDeviceId)
    .sort(compareUtf8);
  const requiredAcknowledgementDeviceId = cryptoDeviceId(
    input.requiredAcknowledgementDeviceId,
  );
  if (
    recipients.length < 1
    || new Set(recipients).size !== recipients.length
    || !recipients.includes(requiredAcknowledgementDeviceId)
  ) {
    throw new Error(
      "Human membership rebind recipients must be unique and include the required acknowledgement device",
    );
  }
  const artifactBytes = serializeHumanMembershipRebindSubmission(
    input.submission,
  );
  if (artifactBytes.length * recipients.length > MAX_FANOUT_PAYLOAD_BYTES) {
    throw new RangeError(
      "Human membership rebind delivery exceeds aggregate payload bounds",
    );
  }
  const messages: HumanMembershipRebindDeliveryMessage[] = [];
  let aggregatePayloadBytes = 0;
  const expiresAt = input.now + HUMAN_MEMBERSHIP_REBIND_DELIVERY_TTL_MS;
  for (const recipientDeviceId of recipients) {
    const chunks = chunkOpaqueDeliveryArtifact({
      crypto: input.crypto,
      kind: "membership_rebind",
      operationId: input.submission.operationId,
      recipientDeviceId,
      artifactBytes,
    });
    for (const chunk of chunks) {
      const payloadBytes = serializeOpaqueDeliveryArtifactChunk(
        chunk,
        input.crypto,
      );
      const payloadHash = input.crypto.hash(payloadBytes);
      aggregatePayloadBytes += payloadBytes.length;
      messages.push(Object.freeze({
        messageId: `delivery_${hex(payloadHash)}`,
        operationId: input.submission.operationId,
        domainId: input.submission.targetDomainId,
        kind: "binding_candidate",
        recipientDeviceId,
        formatVersion: 1,
        payloadHash,
        payloadBytes,
        createdAt: input.now,
        expiresAt,
      }));
    }
  }
  if (
    messages.length < 1
    || messages.length > MAX_FANOUT_ROWS_PER_OPERATION
    || aggregatePayloadBytes > MAX_FANOUT_PAYLOAD_BYTES
  ) {
    throw new RangeError(
      "Human membership rebind delivery exceeds operation fanout bounds",
    );
  }
  return Object.freeze({
    operationId: input.submission.operationId,
    domainId: input.submission.targetDomainId,
    messages: Object.freeze(messages),
    requiredAcknowledgementDeviceId,
    fanoutRowCount: messages.length,
    aggregatePayloadBytes,
    createdAt: input.now,
  });
}
