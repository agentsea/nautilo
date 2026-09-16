import {
  cryptoDeviceId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeDeviceTransferApprovalV2,
  deviceTransferApprovalSigningBytesV2,
} from "@nautilo/lattice-crypto/wire";
import {
  assertPendingAdditionalDeviceEnrollment,
  type PendingAdditionalDeviceEnrollment,
} from "./additional-device-enrollment.ts";
import {
  assertDeviceFanoutPlan,
  type DeviceFanoutDomainPlan,
  type DeviceFanoutPlan,
} from "../delivery/device-fanout.ts";
import {
  chunkOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
  type OpaqueDeliveryArtifactChunk,
} from "../delivery/opaque-artifact.ts";

export const ADDITIONAL_DEVICE_APPROVAL_MANIFEST_FORMAT_VERSION = 1 as const;

export interface AdditionalDeviceApprovalManifest {
  readonly formatVersion:
    typeof ADDITIONAL_DEVICE_APPROVAL_MANIFEST_FORMAT_VERSION;
  readonly operationId: string;
  readonly humanId: string;
  readonly targetDeviceId: string;
  readonly issuerDeviceId: string;
  readonly expectedDeviceRevision: 0;
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly inventoryRevision: number;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly approvalHash: Uint8Array;
  readonly signature: Uint8Array;
}

export interface VerifiedAdditionalDeviceApproval {
  readonly manifest: AdditionalDeviceApprovalManifest;
  readonly plan: DeviceFanoutPlan;
  readonly artifactChunks: readonly OpaqueDeliveryArtifactChunk[];
  readonly serializedArtifactChunks: readonly Uint8Array[];
}

const verifiedAdditionalDeviceApprovals = new WeakMap<object, Uint8Array>();

/**
 * Keep structural look-alikes from crossing the verification boundary.
 *
 * This is intentionally not part of the package's public barrel: callers must
 * obtain the exact process-local result of verifyAdditionalDeviceApproval.
 */
export function assertVerifiedAdditionalDeviceApproval(
  value: VerifiedAdditionalDeviceApproval,
  crypto: Pick<LatticeCrypto, "hash">,
): void {
  const expected = (
    typeof value === "object" && value !== null
      ? verifiedAdditionalDeviceApprovals.get(value)
      : undefined
  );
  if (expected === undefined) {
    throw new TypeError(
      "Device fanout approval was not cryptographically verified",
    );
  }
  let current: Uint8Array;
  try {
    current = verifiedAdditionalDeviceApprovalDigest(value, crypto);
  } catch {
    throw new TypeError(
      "Device fanout approval was not cryptographically verified",
    );
  }
  if (!equalBytes(expected, current)) {
    throw new TypeError(
      "Device fanout approval was not cryptographically verified",
    );
  }
}

export type ResolveActiveApprovingDevice = (
  humanId: string,
  deviceId: string,
) => {
  readonly state: "active";
  readonly signingPublicKey: Uint8Array;
} | null;

function u32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Additional-device approval counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Additional-device approval counter is unsafe");
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

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function hash(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new RangeError(`${label} must be exactly 32 bytes`);
  }
}

function verifiedAdditionalDeviceApprovalDigest(
  approval: VerifiedAdditionalDeviceApproval,
  crypto: Pick<LatticeCrypto, "hash">,
): Uint8Array {
  const plan = approval.plan;
  const parts: Uint8Array[] = [
    text("nautilo/lattice-bridge/verified-additional-device-approval/v1"),
    frame(additionalDeviceApprovalManifestSigningBytes(approval.manifest)),
    frame(approval.manifest.signature),
    text(plan.operationId),
    text(plan.method),
    text(plan.humanId),
    text(plan.targetDeviceId),
    u64(plan.expectedDeviceRevision),
    u64(plan.expectedCustodyRevision),
    u64(plan.expectedRecoveryGeneration),
    u64(plan.inventoryRevision),
    u32(plan.inventoryCount),
    frame(plan.inventoryDigest),
    frame(plan.authorizationArtifactHash),
    u32(plan.fanoutRowCount),
    u64(plan.aggregatePayloadBytes),
    u32(plan.domains.length),
  ];
  for (const domain of plan.domains) {
    parts.push(
      text(domain.domainId),
      u64(domain.expectedEpoch),
      u64(domain.targetEpoch),
      u64(domain.expectedAuthorizationRevision),
      frame(domain.expectedParticipantDigest),
      text(domain.committerDeviceId ?? ""),
      u32(domain.namespaces.length),
    );
    for (const namespace of domain.namespaces) {
      parts.push(
        text(namespace.namespaceId),
        u64(namespace.expectedAccessRevision),
        frame(namespace.expectedBindingHash),
      );
    }
  }
  parts.push(u32(approval.serializedArtifactChunks.length));
  for (const serialized of approval.serializedArtifactChunks) {
    parts.push(frame(crypto.hash(serialized)));
  }
  return crypto.hash(concat(parts));
}

export function additionalDeviceApprovalManifestSigningBytes(
  manifest: Omit<AdditionalDeviceApprovalManifest, "signature">,
): Uint8Array {
  cryptoDeviceId(manifest.targetDeviceId);
  cryptoDeviceId(manifest.issuerDeviceId);
  hash("Additional-device inventory digest", manifest.inventoryDigest);
  hash("Additional-device approval hash", manifest.approvalHash);
  return concat([
    text("nautilo/lattice-bridge/additional-device-approval/v1"),
    u32(manifest.formatVersion),
    text(manifest.operationId),
    text(manifest.humanId),
    text(manifest.targetDeviceId),
    text(manifest.issuerDeviceId),
    u64(manifest.expectedDeviceRevision),
    u64(manifest.expectedCustodyRevision),
    u64(manifest.expectedRecoveryGeneration),
    u64(manifest.inventoryRevision),
    u32(manifest.inventoryCount),
    frame(manifest.inventoryDigest),
    frame(manifest.approvalHash),
  ]);
}

export function createAdditionalDeviceApprovalManifest(input: {
  readonly crypto: LatticeCrypto;
  readonly enrollment: PendingAdditionalDeviceEnrollment;
  readonly approvalBytes: Uint8Array;
  readonly issuerDeviceId: string;
  readonly issuerSigningPrivateKey: Uint8Array;
}): AdditionalDeviceApprovalManifest {
  assertPendingAdditionalDeviceEnrollment(input.enrollment);
  if (input.enrollment.method !== "device_approval") {
    throw new Error("Recovery enrollment cannot use device approval");
  }
  if (!(input.approvalBytes instanceof Uint8Array)) {
    throw new TypeError("Device approval artifact must be bytes");
  }
  cryptoDeviceId(input.issuerDeviceId);
  const unsigned = Object.freeze({
    formatVersion: ADDITIONAL_DEVICE_APPROVAL_MANIFEST_FORMAT_VERSION,
    operationId: input.enrollment.operationId,
    humanId: input.enrollment.humanActorId,
    targetDeviceId: input.enrollment.deviceId,
    issuerDeviceId: input.issuerDeviceId,
    expectedDeviceRevision: 0 as const,
    expectedCustodyRevision: input.enrollment.expectedCustodyRevision,
    expectedRecoveryGeneration:
      input.enrollment.expectedRecoveryGeneration,
    inventoryRevision: input.enrollment.inventoryRevision,
    inventoryCount: input.enrollment.inventoryCount,
    inventoryDigest: Uint8Array.from(input.enrollment.inventoryDigest),
    approvalHash: input.crypto.hash(input.approvalBytes),
  });
  return Object.freeze({
    ...unsigned,
    signature: input.crypto.sign(
      input.issuerSigningPrivateKey,
      additionalDeviceApprovalManifestSigningBytes(unsigned),
    ),
  });
}

export function verifyAdditionalDeviceApproval(input: {
  readonly crypto: LatticeCrypto;
  readonly enrollment: PendingAdditionalDeviceEnrollment;
  readonly approvalBytes: Uint8Array;
  readonly manifest: AdditionalDeviceApprovalManifest;
  readonly domains: readonly DeviceFanoutDomainPlan[];
  readonly resolveActiveApprovingDevice: ResolveActiveApprovingDevice;
}): VerifiedAdditionalDeviceApproval {
  assertPendingAdditionalDeviceEnrollment(input.enrollment);
  if (input.enrollment.method !== "device_approval") {
    throw new Error("Recovery enrollment cannot use device approval");
  }
  if (
    typeof input.manifest !== "object"
    || input.manifest === null
    || input.manifest.formatVersion
      !== ADDITIONAL_DEVICE_APPROVAL_MANIFEST_FORMAT_VERSION
    || !(input.manifest.signature instanceof Uint8Array)
    || input.manifest.signature.length !== 64
  ) {
    throw new TypeError("Additional-device approval manifest is malformed");
  }
  const approval = decodeDeviceTransferApprovalV2(input.approvalBytes);
  const approvalHash = input.crypto.hash(input.approvalBytes);
  const enrollment = input.enrollment;
  if (
    input.manifest.operationId !== enrollment.operationId
    || input.manifest.humanId !== enrollment.humanActorId
    || input.manifest.targetDeviceId !== enrollment.deviceId
    || input.manifest.expectedDeviceRevision !== 0
    || input.manifest.expectedCustodyRevision
      !== enrollment.expectedCustodyRevision
    || input.manifest.expectedRecoveryGeneration
      !== enrollment.expectedRecoveryGeneration
    || input.manifest.inventoryRevision !== enrollment.inventoryRevision
    || input.manifest.inventoryCount !== enrollment.inventoryCount
    || !equalBytes(input.manifest.inventoryDigest, enrollment.inventoryDigest)
    || !equalBytes(input.manifest.approvalHash, approvalHash)
  ) {
    throw new Error(
      "Additional-device approval does not match its pending operation",
    );
  }
  const approver = input.resolveActiveApprovingDevice(
    enrollment.humanActorId,
    input.manifest.issuerDeviceId,
  );
  if (
    approver === null
    || approver.state !== "active"
    || !(approver.signingPublicKey instanceof Uint8Array)
    || approver.signingPublicKey.length !== 32
    || !input.crypto.verify(
      approver.signingPublicKey,
      additionalDeviceApprovalManifestSigningBytes(input.manifest),
      input.manifest.signature,
    )
  ) {
    throw new Error("Additional-device approving device is not authorized");
  }
  if (
    approval.humanId !== humanId(enrollment.humanActorId)
    || approval.targetDeviceId !== enrollment.deviceId
    || approval.pendingDeviceRevision !== enrollment.deviceRevision
    || approval.issuerDeviceId !== input.manifest.issuerDeviceId
    || approval.inventoryRevision !== enrollment.inventoryRevision
    || approval.inventoryCount !== enrollment.inventoryCount
    || !equalBytes(approval.inventoryDigest, enrollment.inventoryDigest)
    || !equalBytes(
      approval.encryptionPublicKeyDigest,
      input.crypto.hash(enrollment.encryptionPublicKey),
    )
    || !equalBytes(
      approval.signingPublicKeyDigest,
      input.crypto.hash(enrollment.signingPublicKey),
    )
    || !input.crypto.verify(
      approver.signingPublicKey,
      deviceTransferApprovalSigningBytesV2(approval),
      approval.signature,
    )
  ) {
    throw new Error("Core device-transfer approval is not authorized");
  }
  if (
    approval.joinIntents.length !== input.domains.length
    || approval.joinIntents.some((intent, index) => {
      const domain = input.domains[index];
      return domain === undefined
        || intent.domainId !== domain.domainId
        || intent.domainEpoch !== domain.expectedEpoch
        || intent.committerDeviceId !== domain.committerDeviceId;
    })
  ) {
    throw new Error("Device approval Domain inventory is stale");
  }
  const artifactChunks = chunkOpaqueDeliveryArtifact({
    crypto: input.crypto,
    kind: "device_transfer",
    operationId: enrollment.operationId,
    recipientDeviceId: enrollment.deviceId,
    artifactBytes: input.approvalBytes,
  });
  const serializedArtifactChunks = Object.freeze(
    artifactChunks.map((chunk) =>
      serializeOpaqueDeliveryArtifactChunk(chunk, input.crypto)
    ),
  );
  const plan: DeviceFanoutPlan = Object.freeze({
    formatVersion: 1,
    operationId: enrollment.operationId,
    method: "device_approval",
    humanId: enrollment.humanActorId,
    targetDeviceId: enrollment.deviceId,
    expectedDeviceRevision: enrollment.deviceRevision,
    expectedCustodyRevision: enrollment.expectedCustodyRevision,
    expectedRecoveryGeneration: enrollment.expectedRecoveryGeneration,
    inventoryRevision: enrollment.inventoryRevision,
    inventoryCount: enrollment.inventoryCount,
    inventoryDigest: Uint8Array.from(enrollment.inventoryDigest),
    authorizationArtifactHash: approvalHash,
    recoveryReadinessDigest: null,
    fanoutRowCount: artifactChunks.length,
    aggregatePayloadBytes: serializedArtifactChunks.reduce(
      (total, bytes) => total + bytes.length,
      0,
    ),
    domains: Object.freeze([...input.domains]),
  });
  assertDeviceFanoutPlan(plan);
  const verified = Object.freeze({
    manifest: Object.freeze({
      ...input.manifest,
      inventoryDigest: Uint8Array.from(input.manifest.inventoryDigest),
      approvalHash: Uint8Array.from(input.manifest.approvalHash),
      signature: Uint8Array.from(input.manifest.signature),
    }),
    plan,
    artifactChunks,
    serializedArtifactChunks,
  });
  verifiedAdditionalDeviceApprovals.set(
    verified,
    verifiedAdditionalDeviceApprovalDigest(verified, input.crypto),
  );
  return verified;
}
