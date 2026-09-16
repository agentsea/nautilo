import {
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceId,
} from "@nautilo/lattice-crypto";
import {
  MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN,
  MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS,
} from "../device/additional-device-enrollment.ts";

export const MAX_ACTIVE_DOMAINS_PER_DEVICE = 256;
export const MAX_NAMESPACES_PER_DOMAIN_TRANSITION = 256;
export const MAX_FANOUT_ROWS_PER_OPERATION = 4_096;
export const MAX_FANOUT_PAYLOAD_BYTES = 67_108_864;

export type DeviceFanoutMethod = "device_approval" | "recovery";
export type DeviceFanoutOperationState =
  | "requested"
  | "awaiting_target_device"
  | "awaiting_committer"
  | "preparing_domain"
  | "awaiting_delivery"
  | "ready_to_activate"
  | "activating"
  | "active"
  | "failed"
  | "cancelled";
export type DeviceFanoutDomainState =
  | "awaiting_committer"
  | "preparing"
  | "awaiting_delivery"
  | "ready_to_activate"
  | "active"
  | "failed";
export type DeviceFanoutNamespaceState =
  | "pending"
  | "prepared"
  | "active"
  | "failed";

export interface DeviceFanoutNamespacePlan {
  readonly namespaceId: string;
  readonly expectedAccessRevision: number;
  readonly expectedBindingHash: Uint8Array;
}

export interface DeviceFanoutDomainPlan {
  readonly domainId: string;
  readonly expectedEpoch: number;
  readonly targetEpoch: number;
  readonly expectedAuthorizationRevision: number;
  readonly expectedParticipantDigest: Uint8Array;
  readonly committerDeviceId: string | null;
  readonly namespaces: readonly DeviceFanoutNamespacePlan[];
}

export interface DeviceFanoutPlan {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly method: DeviceFanoutMethod;
  readonly humanId: string;
  readonly targetDeviceId: string;
  readonly expectedDeviceRevision: number;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly inventoryRevision: number;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly authorizationArtifactHash: Uint8Array;
  readonly recoveryReadinessDigest: Uint8Array | null;
  readonly fanoutRowCount: number;
  readonly aggregatePayloadBytes: number;
  readonly domains: readonly DeviceFanoutDomainPlan[];
}

export interface DeviceFanoutDomainProgress {
  readonly domainId: string;
  readonly state: DeviceFanoutDomainState;
  readonly namespaces: readonly {
    readonly namespaceId: string;
    readonly state: DeviceFanoutNamespaceState;
  }[];
}

export interface DeviceFanoutProgress {
  readonly operationId: string;
  readonly state: DeviceFanoutOperationState;
  readonly domains: readonly DeviceFanoutDomainProgress[];
}

export type DeviceActivationGate =
  | { readonly ready: true }
  | {
    readonly ready: false;
    readonly reason:
      | "device_changed"
      | "custody_changed"
      | "recovery_changed"
      | "inventory_changed"
      | "authorization_changed"
      | "domains_incomplete"
      | "namespaces_incomplete"
      | "delivery_incomplete"
      | "challenge_consumed"
      | "active_device_limit";
  };

function portableId(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function counter(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe nonnegative counter`);
  }
}

function hash(label: string, value: Uint8Array | null): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function assertCanonicalUnique(
  label: string,
  values: readonly string[],
): void {
  for (let index = 1; index < values.length; index++) {
    if (compareUtf8(values[index - 1]!, values[index]!) >= 0) {
      throw new Error(`${label} must be unique and canonically ordered`);
    }
  }
}

export function assertDeviceFanoutPlan(plan: DeviceFanoutPlan): void {
  if (
    typeof plan !== "object"
    || plan === null
    || plan.formatVersion !== 1
  ) {
    throw new TypeError("Device fanout plan is malformed");
  }
  portableId("Device fanout operation id", plan.operationId);
  humanId(plan.humanId);
  cryptoDeviceId(plan.targetDeviceId);
  if (plan.method !== "device_approval" && plan.method !== "recovery") {
    throw new TypeError("Device fanout method is unsupported");
  }
  for (const [label, value] of [
    ["Device fanout device revision", plan.expectedDeviceRevision],
    ["Device fanout custody revision", plan.expectedCustodyRevision],
    ["Device fanout recovery generation", plan.expectedRecoveryGeneration],
    ["Device fanout inventory revision", plan.inventoryRevision],
    ["Device fanout inventory count", plan.inventoryCount],
    ["Device fanout row count", plan.fanoutRowCount],
    ["Device fanout payload bytes", plan.aggregatePayloadBytes],
  ] as const) {
    counter(label, value);
  }
  if (
    plan.inventoryCount > MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS
    || plan.fanoutRowCount > MAX_FANOUT_ROWS_PER_OPERATION
    || plan.aggregatePayloadBytes > MAX_FANOUT_PAYLOAD_BYTES
    || plan.domains.length > MAX_ACTIVE_DOMAINS_PER_DEVICE
  ) {
    throw new RangeError("Device fanout plan exceeds a finite bound");
  }
  hash("Device fanout inventory digest", plan.inventoryDigest);
  hash(
    "Device fanout authorization artifact hash",
    plan.authorizationArtifactHash,
  );
  if (plan.method === "recovery") {
    hash(
      "Device fanout recovery readiness digest",
      plan.recoveryReadinessDigest,
    );
  } else if (plan.recoveryReadinessDigest !== null) {
    throw new TypeError(
      "Approval fanout cannot carry recovery readiness evidence",
    );
  }
  assertCanonicalUnique(
    "Device fanout Domains",
    plan.domains.map((domain) => domain.domainId),
  );
  for (const domain of plan.domains) {
    cryptoDomainId(domain.domainId);
    counter("Device fanout expected epoch", domain.expectedEpoch);
    counter("Device fanout target epoch", domain.targetEpoch);
    counter(
      "Device fanout authorization revision",
      domain.expectedAuthorizationRevision,
    );
    if (domain.targetEpoch !== domain.expectedEpoch + 1) {
      throw new Error("Device fanout Domain epoch must advance exactly once");
    }
    hash(
      "Device fanout participant digest",
      domain.expectedParticipantDigest,
    );
    if (domain.committerDeviceId === null) {
      if (plan.method !== "recovery") {
        throw new Error("Approval fanout requires a live Domain committer");
      }
    } else {
      cryptoDeviceId(domain.committerDeviceId);
    }
    if (
      domain.namespaces.length > MAX_NAMESPACES_PER_DOMAIN_TRANSITION
    ) {
      throw new RangeError("Device fanout Domain has too many Namespaces");
    }
    assertCanonicalUnique(
      "Device fanout Namespaces",
      domain.namespaces.map((item) => item.namespaceId),
    );
    for (const item of domain.namespaces) {
      namespaceId(item.namespaceId);
      counter(
        "Device fanout Namespace access revision",
        item.expectedAccessRevision,
      );
      hash(
        "Device fanout Namespace binding hash",
        item.expectedBindingHash,
      );
    }
  }
}

export function createDeviceFanoutProgress(
  plan: DeviceFanoutPlan,
): DeviceFanoutProgress {
  assertDeviceFanoutPlan(plan);
  return Object.freeze({
    operationId: plan.operationId,
    state: "awaiting_committer",
    domains: Object.freeze(plan.domains.map((domain) =>
      Object.freeze({
        domainId: domain.domainId,
        state: "awaiting_committer" as const,
        namespaces: Object.freeze(domain.namespaces.map((item) =>
          Object.freeze({
            namespaceId: item.namespaceId,
            state: "pending" as const,
          })
        )),
      })
    )),
  });
}

export function deriveDeviceFanoutOperationState(
  domains: readonly DeviceFanoutDomainProgress[],
): DeviceFanoutOperationState {
  if (domains.some((domain) => domain.state === "failed")) return "failed";
  if (domains.every((domain) => domain.state === "active")) {
    return "ready_to_activate";
  }
  if (
    domains.some((domain) =>
      domain.state === "awaiting_delivery"
      || domain.state === "ready_to_activate"
    )
  ) {
    return "awaiting_delivery";
  }
  if (domains.some((domain) => domain.state === "preparing")) {
    return "preparing_domain";
  }
  return "awaiting_committer";
}

export function evaluateDeviceActivationGate(input: {
  readonly plan: DeviceFanoutPlan;
  readonly device: {
    readonly state: "pending" | "active" | "revoked" | "rejected";
    readonly revision: number;
  };
  readonly custodyRevision: number;
  readonly recoveryGeneration: number;
  readonly inventoryRevision: number;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly authorizationArtifactHash: Uint8Array;
  readonly domainProgress: readonly DeviceFanoutDomainProgress[];
  readonly requiredDeliveryCount: number;
  readonly acknowledgedDeliveryCount: number;
  readonly challengeStatus: "pending" | "consumed" | "invalidated";
  readonly activeDeviceCount: number;
}): DeviceActivationGate {
  assertDeviceFanoutPlan(input.plan);
  if (
    input.device.state !== "pending"
    || input.device.revision !== input.plan.expectedDeviceRevision
  ) return { ready: false, reason: "device_changed" };
  if (input.custodyRevision !== input.plan.expectedCustodyRevision) {
    return { ready: false, reason: "custody_changed" };
  }
  if (input.recoveryGeneration !== input.plan.expectedRecoveryGeneration) {
    return { ready: false, reason: "recovery_changed" };
  }
  if (
    input.inventoryRevision !== input.plan.inventoryRevision
    || input.inventoryCount !== input.plan.inventoryCount
    || !equalBytes(input.inventoryDigest, input.plan.inventoryDigest)
  ) return { ready: false, reason: "inventory_changed" };
  if (
    !equalBytes(
      input.authorizationArtifactHash,
      input.plan.authorizationArtifactHash,
    )
  ) return { ready: false, reason: "authorization_changed" };
  if (
    input.domainProgress.length !== input.plan.domains.length
    || input.domainProgress.some((domain) => domain.state !== "active")
  ) return { ready: false, reason: "domains_incomplete" };
  if (
    input.domainProgress.some((domain) =>
      domain.namespaces.some((item) => item.state !== "active")
    )
  ) return { ready: false, reason: "namespaces_incomplete" };
  if (
    !Number.isSafeInteger(input.requiredDeliveryCount)
    || input.requiredDeliveryCount < 0
    || input.acknowledgedDeliveryCount !== input.requiredDeliveryCount
  ) return { ready: false, reason: "delivery_incomplete" };
  if (input.challengeStatus !== "pending") {
    return { ready: false, reason: "challenge_consumed" };
  }
  if (input.activeDeviceCount >= MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN) {
    return { ready: false, reason: "active_device_limit" };
  }
  return { ready: true };
}
