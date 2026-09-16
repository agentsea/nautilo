import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type {
  VerifiedAdditionalDeviceApproval,
} from "../device/additional-device-approval.ts";
import {
  assertVerifiedAdditionalDeviceApproval,
} from "../device/additional-device-approval.ts";
import {
  assertDeviceFanoutPlan,
  type DeviceFanoutPlan,
} from "./device-fanout.ts";
import {
  serializeOpaqueDeliveryArtifactChunk,
} from "./opaque-artifact.ts";

export const DEVICE_FANOUT_DELIVERY_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEVICE_FANOUT_OUTBOX_MAX_BYTES = 4_096;

export interface DeviceFanoutDeliveryMessage {
  readonly messageId: string;
  readonly kind: "device_transfer";
  readonly recipientDeviceId: string;
  readonly formatVersion: 1;
  readonly payloadHash: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface DeviceFanoutAdmissionOutbox {
  readonly outboxId: string;
  readonly eventType: "device_fanout_admitted";
  readonly idempotencyKey: string;
  readonly payloadBytes: Uint8Array;
}

export interface DeviceFanoutAdmission {
  readonly plan: DeviceFanoutPlan;
  readonly sourceDeviceId: string;
  readonly messages: readonly DeviceFanoutDeliveryMessage[];
  readonly aggregatePayloadBytes: number;
  readonly createdAt: number;
  readonly outbox: DeviceFanoutAdmissionOutbox;
}

const verifiedDeviceFanoutAdmissions =
  new WeakMap<object, DeviceFanoutAdmission>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function plansEqual(left: DeviceFanoutPlan, right: DeviceFanoutPlan): boolean {
  return left.formatVersion === right.formatVersion
    && left.operationId === right.operationId
    && left.method === right.method
    && left.humanId === right.humanId
    && left.targetDeviceId === right.targetDeviceId
    && left.expectedDeviceRevision === right.expectedDeviceRevision
    && left.expectedCustodyRevision === right.expectedCustodyRevision
    && left.expectedRecoveryGeneration === right.expectedRecoveryGeneration
    && left.inventoryRevision === right.inventoryRevision
    && left.inventoryCount === right.inventoryCount
    && equalBytes(left.inventoryDigest, right.inventoryDigest)
    && equalBytes(
      left.authorizationArtifactHash,
      right.authorizationArtifactHash,
    )
    && (
      left.recoveryReadinessDigest === null
        ? right.recoveryReadinessDigest === null
        : right.recoveryReadinessDigest !== null
          && equalBytes(
            left.recoveryReadinessDigest,
            right.recoveryReadinessDigest,
          )
    )
    && left.fanoutRowCount === right.fanoutRowCount
    && left.aggregatePayloadBytes === right.aggregatePayloadBytes
    && left.domains.length === right.domains.length
    && left.domains.every((domain, domainIndex) => {
      const other = right.domains[domainIndex];
      return other !== undefined
        && domain.domainId === other.domainId
        && domain.expectedEpoch === other.expectedEpoch
        && domain.targetEpoch === other.targetEpoch
        && domain.expectedAuthorizationRevision
          === other.expectedAuthorizationRevision
        && equalBytes(
          domain.expectedParticipantDigest,
          other.expectedParticipantDigest,
        )
        && domain.committerDeviceId === other.committerDeviceId
        && domain.namespaces.length === other.namespaces.length
        && domain.namespaces.every((namespace, namespaceIndex) => {
          const otherNamespace = other.namespaces[namespaceIndex];
          return otherNamespace !== undefined
            && namespace.namespaceId === otherNamespace.namespaceId
            && namespace.expectedAccessRevision
              === otherNamespace.expectedAccessRevision
            && equalBytes(
              namespace.expectedBindingHash,
              otherNamespace.expectedBindingHash,
            );
        });
    });
}

function snapshotPlan(plan: DeviceFanoutPlan): DeviceFanoutPlan {
  return Object.freeze({
    ...plan,
    inventoryDigest: Uint8Array.from(plan.inventoryDigest),
    authorizationArtifactHash:
      Uint8Array.from(plan.authorizationArtifactHash),
    recoveryReadinessDigest: plan.recoveryReadinessDigest === null
      ? null
      : Uint8Array.from(plan.recoveryReadinessDigest),
    domains: Object.freeze(plan.domains.map((domain) =>
      Object.freeze({
        ...domain,
        expectedParticipantDigest:
          Uint8Array.from(domain.expectedParticipantDigest),
        namespaces: Object.freeze(domain.namespaces.map((namespace) =>
          Object.freeze({
            ...namespace,
            expectedBindingHash:
              Uint8Array.from(namespace.expectedBindingHash),
          })
        )),
      })
    )),
  });
}

function snapshotAdmission(
  admission: DeviceFanoutAdmission,
): DeviceFanoutAdmission {
  return Object.freeze({
    ...admission,
    plan: snapshotPlan(admission.plan),
    messages: Object.freeze(admission.messages.map((message) =>
      Object.freeze({
        ...message,
        payloadHash: Uint8Array.from(message.payloadHash),
        payloadBytes: Uint8Array.from(message.payloadBytes),
      })
    )),
    outbox: Object.freeze({
      ...admission.outbox,
      payloadBytes: Uint8Array.from(admission.outbox.payloadBytes),
    }),
  });
}

function admissionsEqual(
  left: DeviceFanoutAdmission,
  right: DeviceFanoutAdmission,
): boolean {
  return plansEqual(left.plan, right.plan)
    && left.sourceDeviceId === right.sourceDeviceId
    && left.aggregatePayloadBytes === right.aggregatePayloadBytes
    && left.createdAt === right.createdAt
    && left.messages.length === right.messages.length
    && left.messages.every((message, index) => {
      const other = right.messages[index];
      return other !== undefined
        && message.messageId === other.messageId
        && message.kind === other.kind
        && message.recipientDeviceId === other.recipientDeviceId
        && message.formatVersion === other.formatVersion
        && equalBytes(message.payloadHash, other.payloadHash)
        && equalBytes(message.payloadBytes, other.payloadBytes)
        && message.createdAt === other.createdAt
        && message.expiresAt === other.expiresAt;
    })
    && left.outbox.outboxId === right.outbox.outboxId
    && left.outbox.eventType === right.outbox.eventType
    && left.outbox.idempotencyKey === right.outbox.idempotencyKey
    && equalBytes(left.outbox.payloadBytes, right.outbox.payloadBytes);
}

/**
 * Persistence-boundary provenance guard. Only the exact output of
 * createDeviceFanoutAdmission can cross into the server repository.
 */
export function assertVerifiedDeviceFanoutAdmission(
  value: DeviceFanoutAdmission,
): void {
  const snapshot = typeof value === "object" && value !== null
    ? verifiedDeviceFanoutAdmissions.get(value)
    : undefined;
  if (snapshot === undefined || !admissionsEqual(value, snapshot)) {
    throw new TypeError(
      "Device fanout admission was not cryptographically verified",
    );
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Device fanout timestamp must be nonnegative");
  }
}

export function createDeviceFanoutAdmission(input: {
  readonly crypto: LatticeCrypto;
  readonly approval: VerifiedAdditionalDeviceApproval;
  readonly now: number;
}): DeviceFanoutAdmission {
  assertTimestamp(input.now);
  const { approval } = input;
  assertVerifiedAdditionalDeviceApproval(approval, input.crypto);
  assertDeviceFanoutPlan(approval.plan);
  if (
    approval.plan.method !== "device_approval"
    || approval.manifest.operationId !== approval.plan.operationId
    || approval.manifest.humanId !== approval.plan.humanId
    || approval.manifest.targetDeviceId !== approval.plan.targetDeviceId
    || !equalBytes(
      approval.manifest.approvalHash,
      approval.plan.authorizationArtifactHash,
    )
    || approval.artifactChunks.length
      !== approval.serializedArtifactChunks.length
  ) {
    throw new Error("Device fanout approval is inconsistent");
  }

  const expiresAt = input.now + DEVICE_FANOUT_DELIVERY_TTL_MS;
  const messages = approval.artifactChunks.map((chunk, index) => {
    const serialized = approval.serializedArtifactChunks[index];
    if (
      serialized === undefined
      || !equalBytes(
        serialized,
        serializeOpaqueDeliveryArtifactChunk(chunk, input.crypto),
      )
      || chunk.kind !== "device_transfer"
      || chunk.operationId !== approval.plan.operationId
      || chunk.recipientDeviceId !== approval.plan.targetDeviceId
    ) {
      throw new Error("Device fanout serialized chunk is invalid");
    }
    const payloadHash = input.crypto.hash(serialized);
    return Object.freeze({
      messageId: `delivery_${hex(payloadHash)}`,
      kind: "device_transfer" as const,
      recipientDeviceId: approval.plan.targetDeviceId,
      formatVersion: 1 as const,
      payloadHash,
      payloadBytes: Uint8Array.from(serialized),
      createdAt: input.now,
      expiresAt,
    });
  });
  const aggregatePayloadBytes = messages.reduce(
    (total, message) => total + message.payloadBytes.length,
    0,
  );
  if (
    messages.length !== approval.plan.fanoutRowCount
    || aggregatePayloadBytes !== approval.plan.aggregatePayloadBytes
  ) {
    throw new Error("Device fanout accounting does not match its plan");
  }
  const outboxPayload = new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    eventType: "device_fanout_admitted",
    operationId: approval.plan.operationId,
    targetDeviceId: approval.plan.targetDeviceId,
    fanoutRowCount: messages.length,
    aggregatePayloadBytes,
  }));
  if (
    outboxPayload.length < 1
    || outboxPayload.length > DEVICE_FANOUT_OUTBOX_MAX_BYTES
  ) {
    throw new RangeError("Device fanout outbox payload is out of bounds");
  }
  const outboxDigest = input.crypto.hash(new Uint8Array([
    ...new TextEncoder().encode("device_fanout_admitted"),
    ...approval.plan.authorizationArtifactHash,
  ]));
  const admission = Object.freeze({
    plan: approval.plan,
    sourceDeviceId: approval.manifest.issuerDeviceId,
    messages: Object.freeze(messages),
    aggregatePayloadBytes,
    createdAt: input.now,
    outbox: Object.freeze({
      outboxId: `outbox_${hex(outboxDigest)}`,
      eventType: "device_fanout_admitted" as const,
      idempotencyKey: `fanout_${hex(outboxDigest)}`,
      payloadBytes: outboxPayload,
    }),
  });
  verifiedDeviceFanoutAdmissions.set(admission, snapshotAdmission(admission));
  return admission;
}
