import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  decodeProviderRosterV2,
  providerPublicTransitionDigestV2,
  redactProviderWelcomeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  MAX_FANOUT_PAYLOAD_BYTES,
  MAX_FANOUT_ROWS_PER_OPERATION,
} from "./device-fanout.ts";
import {
  chunkOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
} from "./opaque-artifact.ts";
import {
  decodeNamespaceTransitionSubmission,
  namespaceTransitionCandidatesDigest,
  serializeNamespaceTransitionSubmission,
  type NamespaceTransitionSubmission,
  type VerifiedNamespaceTransitionSubmission,
} from "./namespace-transition-submission.ts";
import {
  decodeProviderTransitionSubmission,
  serializeProviderTransitionSubmission,
  type ProviderTransitionSubmission,
  type VerifiedProviderTransitionSubmission,
} from "./provider-transition-submission.ts";

export const DOMAIN_TRANSITION_DELIVERY_FORMAT_VERSION = 1 as const;
export const DOMAIN_TRANSITION_DELIVERY_MAX_BYTES = 67_108_864;
export const DOMAIN_TRANSITION_DELIVERY_TTL_MS =
  90 * 24 * 60 * 60 * 1_000;

export interface DomainTransitionDeliveryArtifact {
  readonly formatVersion:
    typeof DOMAIN_TRANSITION_DELIVERY_FORMAT_VERSION;
  readonly providerSubmission: ProviderTransitionSubmission;
  readonly namespaceSubmission: NamespaceTransitionSubmission;
}

export interface DomainTransitionDeliveryMessage {
  readonly messageId: string;
  readonly operationId: string;
  readonly domainId: string;
  readonly kind: "public_state";
  readonly recipientDeviceId: string;
  readonly formatVersion: 1;
  readonly payloadHash: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface DomainTransitionDelivery {
  readonly operationId: string;
  readonly domainId: string;
  readonly messages: readonly DomainTransitionDeliveryMessage[];
  readonly fanoutRowCount: number;
  readonly aggregatePayloadBytes: number;
  readonly createdAt: number;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

class ArtifactReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  u32(): number {
    if (this.#offset + 4 > this.bytes.length) {
      throw new RangeError("Domain transition artifact is truncated");
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
    if (
      length > DOMAIN_TRANSITION_DELIVERY_MAX_BYTES
      || this.#offset + length > this.bytes.length
    ) {
      throw new RangeError("Domain transition artifact frame is invalid");
    }
    const output = this.bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return output;
  }

  text(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.frame());
  }

  finish(): void {
    if (this.#offset !== this.bytes.length) {
      throw new RangeError("Domain transition artifact has trailing bytes");
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

export function serializeDomainTransitionDeliveryArtifact(
  artifact: DomainTransitionDeliveryArtifact,
): Uint8Array {
  if (
    typeof artifact !== "object"
    || artifact === null
    || Object.keys(artifact).sort().join(",")
      !== "formatVersion,namespaceSubmission,providerSubmission"
    || artifact.formatVersion !== DOMAIN_TRANSITION_DELIVERY_FORMAT_VERSION
  ) {
    throw new TypeError("Domain transition delivery artifact is malformed");
  }
  const providerBytes = serializeProviderTransitionSubmission(
    artifact.providerSubmission,
  );
  const namespaceBytes = serializeNamespaceTransitionSubmission(
    artifact.namespaceSubmission,
  );
  const bytes = concat([
    frame(
      new TextEncoder().encode(
        "nautilo/lattice-bridge/domain-transition-delivery/v1",
      ),
    ),
    u32(artifact.formatVersion),
    frame(providerBytes),
    frame(namespaceBytes),
  ]);
  if (bytes.length > DOMAIN_TRANSITION_DELIVERY_MAX_BYTES) {
    throw new RangeError("Domain transition delivery artifact exceeds limit");
  }
  return bytes;
}

export function decodeDomainTransitionDeliveryArtifact(
  bytes: Uint8Array,
): DomainTransitionDeliveryArtifact {
  if (
    !(bytes instanceof Uint8Array)
    || bytes.length < 1
    || bytes.length > DOMAIN_TRANSITION_DELIVERY_MAX_BYTES
  ) {
    throw new RangeError("Domain transition delivery bytes are invalid");
  }
  const reader = new ArtifactReader(bytes);
  if (
    reader.text()
      !== "nautilo/lattice-bridge/domain-transition-delivery/v1"
  ) {
    throw new TypeError("Domain transition delivery domain is invalid");
  }
  const formatVersion = reader.u32();
  const providerSubmission = decodeProviderTransitionSubmission(
    reader.frame(),
  );
  const namespaceSubmission = decodeNamespaceTransitionSubmission(
    reader.frame(),
  );
  reader.finish();
  if (formatVersion !== DOMAIN_TRANSITION_DELIVERY_FORMAT_VERSION) {
    throw new TypeError("Domain transition delivery version is invalid");
  }
  return Object.freeze({
    formatVersion,
    providerSubmission,
    namespaceSubmission,
  });
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function rosterMatches(
  left: readonly {
    readonly leafIndex: number;
    readonly humanId: string;
    readonly deviceId: string;
  }[],
  right: readonly {
    readonly leafIndex: number;
    readonly humanId: string;
    readonly deviceId: string;
  }[],
): boolean {
  return left.length === right.length
    && left.every((entry, index) => {
      const candidate = right[index];
      return candidate !== undefined
        && candidate.leafIndex === entry.leafIndex
        && candidate.humanId === entry.humanId
        && candidate.deviceId === entry.deviceId;
    });
}

export function createDomainTransitionDelivery(input: {
  readonly crypto: LatticeCrypto;
  readonly providerSubmission: ProviderTransitionSubmission;
  readonly verifiedProvider: VerifiedProviderTransitionSubmission;
  readonly namespaceSubmission: NamespaceTransitionSubmission;
  readonly verifiedNamespaces: VerifiedNamespaceTransitionSubmission;
  readonly now: number;
}): DomainTransitionDelivery {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new RangeError("Domain transition delivery time is invalid");
  }
  const transition = input.providerSubmission.transition;
  const nextRoster = decodeProviderRosterV2(
    transition.providerId,
    transition.rosterBytes,
  );
  const targetRoster = transition.operation === "remove"
    ? input.verifiedProvider.previousRoster
    : nextRoster;
  const target = targetRoster.find(
    (entry) => entry.deviceId === transition.targetDeviceId,
  );
  if (
    input.verifiedProvider.operationId
      !== input.providerSubmission.operationId
    || input.verifiedProvider.committerDeviceId
      !== input.providerSubmission.committerDeviceId
    || input.verifiedProvider.expectedAuthorizationRevision
      !== input.providerSubmission.expectedAuthorizationRevision
    || !equalBytes(
      input.verifiedProvider.expectedParticipantDigest,
      input.providerSubmission.expectedParticipantDigest,
    )
    || !equalBytes(
      input.verifiedProvider.transitionDigest,
      input.providerSubmission.transitionDigest,
    )
    || !equalBytes(
      providerPublicTransitionDigestV2(input.crypto, transition),
      input.verifiedProvider.transitionDigest,
    )
    || !rosterMatches(nextRoster, input.verifiedProvider.nextRoster)
    || target === undefined
    || target.leafIndex !== input.verifiedProvider.targetLeafIndex
    || input.namespaceSubmission.operationId
      !== input.providerSubmission.operationId
    || input.namespaceSubmission.domainId !== transition.domainId
    || input.namespaceSubmission.committerDeviceId
      !== input.providerSubmission.committerDeviceId
    || !equalBytes(
      input.namespaceSubmission.providerTransitionDigest,
      input.providerSubmission.transitionDigest,
    )
    || input.verifiedNamespaces.operationId
      !== input.namespaceSubmission.operationId
    || input.verifiedNamespaces.domainId
      !== input.namespaceSubmission.domainId
    || input.verifiedNamespaces.committerDeviceId
      !== input.namespaceSubmission.committerDeviceId
    || !equalBytes(
      input.verifiedNamespaces.providerTransitionDigest,
      input.namespaceSubmission.providerTransitionDigest,
    )
    || !equalBytes(
      input.verifiedNamespaces.candidatesDigest,
      input.namespaceSubmission.candidatesDigest,
    )
    || !equalBytes(
      namespaceTransitionCandidatesDigest(
        input.crypto,
        input.verifiedNamespaces.candidates,
      ),
      input.namespaceSubmission.candidatesDigest,
    )
  ) {
    throw new Error(
      "Domain transition delivery does not match its verified submissions",
    );
  }
  const expiresAt = input.now + DOMAIN_TRANSITION_DELIVERY_TTL_MS;
  const messages: DomainTransitionDeliveryMessage[] = [];
  for (const recipient of nextRoster) {
    const recipientSubmission = recipient.deviceId === transition.targetDeviceId
      ? input.providerSubmission
      : Object.freeze({
        ...input.providerSubmission,
        transition: redactProviderWelcomeV2(transition),
      });
    const recipientArtifactBytes = serializeDomainTransitionDeliveryArtifact({
      formatVersion: DOMAIN_TRANSITION_DELIVERY_FORMAT_VERSION,
      providerSubmission: recipientSubmission,
      namespaceSubmission: input.namespaceSubmission,
    });
    const chunks = chunkOpaqueDeliveryArtifact({
      crypto: input.crypto,
      kind: "domain_transition",
      operationId: input.providerSubmission.operationId,
      recipientDeviceId: recipient.deviceId,
      artifactBytes: recipientArtifactBytes,
    });
    for (const chunk of chunks) {
      const payloadBytes = serializeOpaqueDeliveryArtifactChunk(
        chunk,
        input.crypto,
      );
      const payloadHash = input.crypto.hash(payloadBytes);
      messages.push(Object.freeze({
        messageId: `delivery_${hex(payloadHash)}`,
        operationId: input.providerSubmission.operationId,
        domainId: transition.domainId,
        kind: "public_state",
        recipientDeviceId: recipient.deviceId,
        formatVersion: 1,
        payloadHash,
        payloadBytes,
        createdAt: input.now,
        expiresAt,
      }));
    }
  }
  const aggregatePayloadBytes = messages.reduce(
    (total, message) => total + message.payloadBytes.length,
    0,
  );
  if (
    messages.length < 1
    || messages.length > MAX_FANOUT_ROWS_PER_OPERATION
    || aggregatePayloadBytes > MAX_FANOUT_PAYLOAD_BYTES
  ) {
    throw new RangeError(
      "Provider transition delivery exceeds operation fanout bounds",
    );
  }
  return Object.freeze({
    operationId: input.providerSubmission.operationId,
    domainId: transition.domainId,
    messages: Object.freeze(messages),
    fanoutRowCount: messages.length,
    aggregatePayloadBytes,
    createdAt: input.now,
  });
}
