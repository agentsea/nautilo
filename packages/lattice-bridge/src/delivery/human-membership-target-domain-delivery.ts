import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  redactProviderWelcomeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  chunkOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
} from "./opaque-artifact.ts";
import {
  decodeProviderTransitionSubmission,
  serializeProviderTransitionSubmission,
  type ProviderTransitionSubmission,
} from "./provider-transition-submission.ts";
import type {
  VerifiedHumanMembershipTargetDomain,
} from "./human-membership-target-domain.ts";

export const HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_FORMAT_VERSION = 1;
export const HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_TTL_MS =
  90 * 24 * 60 * 60 * 1_000;

export interface HumanMembershipTargetDomainDeliveryArtifact {
  readonly formatVersion:
    typeof HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_FORMAT_VERSION;
  readonly providerSubmission: ProviderTransitionSubmission;
}

export interface HumanMembershipTargetDomainDeliveryMessage {
  readonly messageId: string;
  readonly operationId: string;
  readonly recipientDeviceId: string;
  readonly payloadHash: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

class Reader {
  #offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Target Domain delivery artifact is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getUint32(this.#offset);
    this.#offset += 4;
    return value;
  }

  frame(): Uint8Array {
    const length = this.u32();
    if (length < 1 || this.#offset + length > this.bytes.length) {
      throw new RangeError("Target Domain delivery frame is invalid");
    }
    const value = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return value;
  }

  finish(): void {
    if (this.#offset !== this.bytes.length) {
      throw new RangeError("Target Domain delivery has trailing bytes");
    }
  }
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.length);
  output.set(u32(bytes.length));
  output.set(bytes, 4);
  return output;
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

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function serializeHumanMembershipTargetDomainDeliveryArtifact(
  artifact: HumanMembershipTargetDomainDeliveryArtifact,
): Uint8Array {
  if (
    artifact.formatVersion
      !== HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_FORMAT_VERSION
  ) {
    throw new TypeError("Target Domain delivery version is unsupported");
  }
  return concat([
    frame(new TextEncoder().encode(
      "nautilo/lattice-bridge/human-membership-target-domain-delivery/v1",
    )),
    u32(artifact.formatVersion),
    frame(serializeProviderTransitionSubmission(
      artifact.providerSubmission,
    )),
  ]);
}

export function decodeHumanMembershipTargetDomainDeliveryArtifact(
  bytes: Uint8Array,
): HumanMembershipTargetDomainDeliveryArtifact {
  const reader = new Reader(bytes);
  const domain = new TextDecoder("utf-8", { fatal: true }).decode(
    reader.frame(),
  );
  const formatVersion = reader.u32();
  const providerSubmission = decodeProviderTransitionSubmission(
    reader.frame(),
  );
  reader.finish();
  if (
    domain
      !== "nautilo/lattice-bridge/human-membership-target-domain-delivery/v1"
    || formatVersion
      !== HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_FORMAT_VERSION
  ) {
    throw new TypeError("Target Domain delivery artifact is unsupported");
  }
  return Object.freeze({ formatVersion, providerSubmission });
}

export function createHumanMembershipTargetDomainDelivery(input: {
  readonly crypto: LatticeCrypto;
  readonly verified: VerifiedHumanMembershipTargetDomain;
  readonly now: number;
}): readonly HumanMembershipTargetDomainDeliveryMessage[] {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError("Target Domain delivery time is invalid");
  }
  const messages: HumanMembershipTargetDomainDeliveryMessage[] = [];
  for (const addition of input.verified.additions) {
    const targetDeviceId = addition.provider.transition.targetDeviceId;
    for (const recipient of addition.provider.nextRoster) {
      const providerSubmission = recipient.deviceId === targetDeviceId
        ? addition.joinPackage.deviceId === targetDeviceId
          ? addition.providerSubmission
          : null
        : {
          ...addition.providerSubmission,
          transition: redactProviderWelcomeV2(
            addition.provider.transition,
          ),
        };
      if (providerSubmission === null) {
        throw new Error("Target Domain Welcome target is inconsistent");
      }
      const artifactBytes =
        serializeHumanMembershipTargetDomainDeliveryArtifact({
          formatVersion:
            HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_FORMAT_VERSION,
          providerSubmission,
        });
      for (const chunk of chunkOpaqueDeliveryArtifact({
        crypto: input.crypto,
        kind: "target_domain_bootstrap",
        operationId: input.verified.submission.operationId,
        recipientDeviceId: recipient.deviceId,
        artifactBytes,
      })) {
        const payloadBytes = serializeOpaqueDeliveryArtifactChunk(
          chunk,
          input.crypto,
        );
        const payloadHash = input.crypto.hash(payloadBytes);
        messages.push(Object.freeze({
          messageId: `delivery_${hex(payloadHash)}`,
          operationId: input.verified.submission.operationId,
          recipientDeviceId: recipient.deviceId,
          payloadHash,
          payloadBytes,
          createdAt: input.now,
          expiresAt:
            input.now + HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_TTL_MS,
        }));
      }
    }
  }
  return Object.freeze(messages);
}
