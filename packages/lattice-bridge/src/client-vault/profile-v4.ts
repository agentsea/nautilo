import {
  verifyHistoricalAgentRuntimeSignerPublication,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeAgentRuntimeSignerPublicationV1,
  decodeDeviceTransferApprovalV2,
  decodeProcessorSignerAuthorizationV1,
  deviceTransferApprovalSigningBytesV2,
  verifyHistoricalProcessorSignerAuthorizationV1,
  type AgentRuntimeObjectSignerPrincipalV1,
  type ProcessorSignerAuthorizationAuthorityContextV1,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV3,
  createClientProfileObjectAccessAnchorPortOwner,
  createClientDeviceProfileV3Candidate,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
  type ClientDomainProviderSnapshotV3,
  type OpenedClientDeviceProfileV3,
} from "./profile-v3.ts";
import type {
  ClientProfileCoordinates,
  ClientProfilePublicState,
  ClientProfileVault,
} from "./types.ts";
import { CLIENT_PROFILE_VAULT_MAX_BYTES } from "./types.ts";
import {
  decodeSharedHumanDomainTrustAcceptanceV1,
  verifySharedHumanDomainTrustAcceptanceV1,
  type SharedHumanDomainTrustedDeviceV1,
} from "../delivery/shared-human-domain-trust.ts";

export const CLIENT_DEVICE_PROFILE_V4_DOMAIN =
  "nautilo/client-device-profile/v4" as const;
export const CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE = 512 as const;
export const CLIENT_DEVICE_PROFILE_V4_MAX_BYTES = CLIENT_PROFILE_VAULT_MAX_BYTES;

const HASH_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export interface ClientAgentRuntimeSignerEvidenceV4 {
  readonly kind: "agent_runtime_publication";
  readonly agentId: string;
  readonly authorizationRevision: number;
  readonly runtimeGeneration: number;
  readonly signerKeyId: string;
  readonly managerHumanId: string;
  readonly managerAuthorizationRevision: number;
  readonly managerDeviceId: string;
  readonly evidenceBytes: Uint8Array;
  readonly issuingPublicKey: Uint8Array;
  readonly evidenceHash: Uint8Array;
}

export interface ClientProcessorSignerEvidenceV4 {
  readonly kind: "processor_authorization";
  readonly authorizationId: string;
  readonly processorKind: "stenographer";
  readonly processorVersion: 1;
  readonly signerKeyId: string;
  readonly issuingHumanId: string;
  readonly issuingDeviceId: string;
  readonly issuingDeviceAuthorizationRevision: number;
  readonly evidenceBytes: Uint8Array;
  readonly issuingPublicKey: Uint8Array;
  readonly evidenceHash: Uint8Array;
}

/**
 * Durable proof of the two Human-device signing keys that participated in an
 * explicitly compared additional-device transfer. The signed approval binds
 * the target key digest; its issuer signature binds the approving key.
 */
export interface ClientHumanDeviceTransferSignerEvidenceV4 {
  readonly kind: "human_device_transfer_approval";
  readonly humanId: string;
  readonly targetDeviceId: string;
  readonly issuerDeviceId: string;
  readonly approvalBytes: Uint8Array;
  readonly targetSigningPublicKey: Uint8Array;
  readonly issuerSigningPublicKey: Uint8Array;
  readonly evidenceHash: Uint8Array;
}

/**
 * Local first-contact acceptance of one complete shared-Domain device chain.
 * The acceptance is signed by this profile's device and pins every peer key;
 * later provider/Namespace history resolves only from these sealed bytes.
 */
export interface ClientSharedHumanDomainSignerEvidenceV4 {
  readonly kind: "shared_human_domain_trust";
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly acceptedByHumanId: string;
  readonly acceptedByDeviceId: string;
  readonly acceptanceBytes: Uint8Array;
  readonly devices: readonly SharedHumanDomainTrustedDeviceV1[];
  readonly evidenceHash: Uint8Array;
}

export type ClientSignerEvidenceV4 =
  | ClientAgentRuntimeSignerEvidenceV4
  | ClientProcessorSignerEvidenceV4
  | ClientHumanDeviceTransferSignerEvidenceV4
  | ClientSharedHumanDomainSignerEvidenceV4;

export interface ClientObjectAccessSignerResolversV4 {
  readonly resolveAgentRuntimeSignerPublicKey: (
    principal: AgentRuntimeObjectSignerPrincipalV1,
  ) => Uint8Array | null;
  readonly resolveProcessorSignerAuthorizationBytes: (
    input: Readonly<{ authorizationId: string; authorizationHash: Uint8Array }>,
  ) => Uint8Array | null;
  readonly resolveHistoricalProcessorIssuingDevicePublicKey: (
    context: ProcessorSignerAuthorizationAuthorityContextV1,
  ) => Uint8Array | null;
  readonly resolveHistoricalHumanDeviceSigningPublicKey: (
    input: Readonly<{ humanId: string; deviceId: string }>,
  ) => Uint8Array | null;
}

export interface OpenedClientDeviceProfileV4 {
  readonly formatVersion: 4;
  readonly baseProfile: OpenedClientDeviceProfileV3;
  readonly humanDeviceGroupSnapshot: ClientDomainProviderSnapshotV3 | null;
  readonly signerEvidence: readonly ClientSignerEvidenceV4[];
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("Client profile v4 counter is invalid");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Client profile v4 counter is unsafe");
  }
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function frame(value: Uint8Array): Uint8Array {
  return concat([u32(value.length), value]);
}

function text(value: string): Uint8Array {
  return frame(new TextEncoder().encode(value));
}

function portable(label: string, value: string): string {
  if (typeof value !== "string" || !PORTABLE.test(value)) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
  return value;
}

function counter(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe nonnegative counter`);
  }
  return value;
}

function exact(label: string, value: Uint8Array, length?: number): Uint8Array {
  if (
    !(value instanceof Uint8Array)
    || (length !== undefined && value.length !== length)
  ) throw new RangeError(`${label} has invalid bytes`);
  return value.slice();
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function copyHumanDeviceGroupSnapshot(
  value: ClientDomainProviderSnapshotV3 | null,
): ClientDomainProviderSnapshotV3 | null {
  if (value == null) return null;
  return Object.freeze({
    providerId: portable("Human-device provider", value.providerId),
    domainId: portable("Human-device group", value.domainId),
    epoch: counter("Human-device group epoch", value.epoch),
    stateHash: exact("Human-device group state hash", value.stateHash, HASH_BYTES),
    ciphertext: exact("Human-device group state", value.ciphertext),
  });
}

function destroyHumanDeviceGroupSnapshot(
  value: ClientDomainProviderSnapshotV3 | null,
): void {
  value?.stateHash.fill(0);
  value?.ciphertext.fill(0);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasProfileDomain(bytes: Uint8Array, domain: string): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return false;
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  if (length !== domain.length || 4 + length > bytes.length) return false;
  return new TextDecoder().decode(bytes.subarray(4, 4 + length)) === domain;
}

function evidenceKey(value: ClientSignerEvidenceV4): string {
  if (value.kind === "agent_runtime_publication") {
    return `${value.kind}:${value.agentId}:${String(value.authorizationRevision)}:${String(value.runtimeGeneration)}:${value.signerKeyId}`;
  }
  if (value.kind === "processor_authorization") {
    return `${value.kind}:${value.authorizationId}`;
  }
  if (value.kind === "shared_human_domain_trust") {
    return `${value.kind}:${value.domainId}:${String(value.domainEpoch)}:${value.acceptedByDeviceId}`;
  }
  return `${value.kind}:${value.humanId}:${value.targetDeviceId}:${value.issuerDeviceId}:${hex(value.evidenceHash)}`;
}

function destroyEvidence(value: ClientSignerEvidenceV4): void {
  if (value.kind === "human_device_transfer_approval") {
    value.approvalBytes.fill(0);
    value.targetSigningPublicKey.fill(0);
    value.issuerSigningPublicKey.fill(0);
  } else if (value.kind === "shared_human_domain_trust") {
    value.acceptanceBytes.fill(0);
    value.devices.forEach((entry) => entry.signingPublicKey.fill(0));
  } else {
    value.evidenceBytes.fill(0);
    value.issuingPublicKey.fill(0);
  }
  value.evidenceHash.fill(0);
}

function sharedDomainEvidenceFromBytes(input: Readonly<{
  crypto: LatticeCrypto;
  acceptanceBytes: Uint8Array;
  devices: readonly SharedHumanDomainTrustedDeviceV1[];
  evidenceHash: Uint8Array;
}>): ClientSharedHumanDomainSignerEvidenceV4 {
  const acceptanceBytes = exact(
    "Shared Human Domain acceptance",
    input.acceptanceBytes,
  );
  const evidenceHash = exact(
    "Shared Human Domain evidence hash",
    input.evidenceHash,
    HASH_BYTES,
  );
  let acceptance: ReturnType<
    typeof decodeSharedHumanDomainTrustAcceptanceV1
  > | undefined;
  let authenticated: ReturnType<
    typeof verifySharedHumanDomainTrustAcceptanceV1
  > | undefined;
  try {
    if (!equalBytes(input.crypto.hash(acceptanceBytes), evidenceHash)) {
      throw new TypeError("Shared Human Domain evidence hash does not match");
    }
    acceptance = decodeSharedHumanDomainTrustAcceptanceV1(acceptanceBytes);
    authenticated = verifySharedHumanDomainTrustAcceptanceV1({
      crypto: input.crypto,
      acceptance,
      devices: input.devices,
    });
    return Object.freeze({
      kind: "shared_human_domain_trust" as const,
      domainId: acceptance.domainId,
      domainEpoch: acceptance.domainEpoch,
      acceptedByHumanId: acceptance.acceptedByHumanId,
      acceptedByDeviceId: acceptance.acceptedByDeviceId,
      acceptanceBytes,
      devices: Object.freeze(authenticated.devices.map((entry) =>
        Object.freeze({ ...entry, signingPublicKey: entry.signingPublicKey.slice() })
      )),
      evidenceHash,
    });
  } catch (error) {
    acceptanceBytes.fill(0);
    evidenceHash.fill(0);
    throw error;
  } finally {
    if (acceptance !== undefined) {
      acceptance.participantDigest.fill(0);
      acceptance.targetSubmissionDigest.fill(0);
      acceptance.deviceInventoryDigest.fill(0);
      acceptance.signature.fill(0);
    }
    authenticated?.acceptance.participantDigest.fill(0);
    authenticated?.acceptance.targetSubmissionDigest.fill(0);
    authenticated?.acceptance.deviceInventoryDigest.fill(0);
    authenticated?.acceptance.signature.fill(0);
    authenticated?.devices.forEach((entry) => entry.signingPublicKey.fill(0));
  }
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function destroyDeviceTransferApproval(value: ReturnType<
  typeof decodeDeviceTransferApprovalV2
>): void {
  value.encryptionPublicKeyDigest.fill(0);
  value.signingPublicKeyDigest.fill(0);
  value.inventoryDigest.fill(0);
  value.signature.fill(0);
  value.packages.forEach((entry) => {
    entry.encryptionPublicKeyDigest.fill(0);
    entry.signingPublicKeyDigest.fill(0);
    entry.bindingHash.fill(0);
    entry.ciphertext.fill(0);
  });
}

function destroyVerifiedProcessorAuthorization(value: Readonly<{
  authorization: Readonly<{
    issuerSigningPublicKeyHash: Uint8Array;
    signer: Readonly<{ workDescriptorHash: Uint8Array }>;
    signerPublicKey: Uint8Array;
    workDescriptorHash: Uint8Array;
    credentialHash: Uint8Array;
    signature: Uint8Array;
  }>;
  authorizationBytes: Uint8Array;
  authorizationHash: Uint8Array;
}>): void {
  value.authorization.issuerSigningPublicKeyHash.fill(0);
  value.authorization.signer.workDescriptorHash.fill(0);
  value.authorization.signerPublicKey.fill(0);
  value.authorization.workDescriptorHash.fill(0);
  value.authorization.credentialHash.fill(0);
  value.authorization.signature.fill(0);
  value.authorizationBytes.fill(0);
  value.authorizationHash.fill(0);
}

function agentEvidenceFromBytes(input: Readonly<{
  crypto: LatticeCrypto;
  evidenceBytes: Uint8Array;
  issuingPublicKey: Uint8Array;
  evidenceHash: Uint8Array;
}>): ClientAgentRuntimeSignerEvidenceV4 {
  const evidenceBytes = exact("Agent signer publication", input.evidenceBytes);
  const issuingPublicKey = exact(
    "Agent signer publication manager public key",
    input.issuingPublicKey,
    PUBLIC_KEY_BYTES,
  );
  const evidenceHash = exact(
    "Agent signer publication hash",
    input.evidenceHash,
    HASH_BYTES,
  );
  try {
    if (!equalBytes(input.crypto.hash(evidenceBytes), evidenceHash)) {
      throw new TypeError("Agent signer publication hash does not match");
    }
    const publication = decodeAgentRuntimeSignerPublicationV1(evidenceBytes);
    if (!verifyHistoricalAgentRuntimeSignerPublication({
      crypto: input.crypto,
      publication,
      resolveHistoricalManagerAuthority: (context) =>
        context.agentId === publication.agentId
          && context.authorizationRevision === publication.authorizationRevision
          && context.runtimeGeneration === publication.runtimeGeneration
          && context.signerKeyId === publication.signerKeyId
          && context.managerHumanId === publication.managerHumanId
          && context.managerAuthorizationRevision
            === publication.managerAuthorizationRevision
          && context.managerDeviceId === publication.managerDeviceId
          ? issuingPublicKey
          : null,
    })) throw new TypeError("Agent signer publication is not authentic");
    return Object.freeze({
      kind: "agent_runtime_publication" as const,
      agentId: publication.agentId,
      authorizationRevision: publication.authorizationRevision,
      runtimeGeneration: publication.runtimeGeneration,
      signerKeyId: publication.signerKeyId,
      managerHumanId: publication.managerHumanId,
      managerAuthorizationRevision: publication.managerAuthorizationRevision,
      managerDeviceId: publication.managerDeviceId,
      evidenceBytes,
      issuingPublicKey,
      evidenceHash,
    });
  } catch (error) {
    evidenceBytes.fill(0);
    issuingPublicKey.fill(0);
    evidenceHash.fill(0);
    throw error;
  }
}

function processorEvidenceFromBytes(input: Readonly<{
  crypto: LatticeCrypto;
  evidenceBytes: Uint8Array;
  issuingPublicKey: Uint8Array;
  evidenceHash: Uint8Array;
}>): ClientProcessorSignerEvidenceV4 {
  const evidenceBytes = exact(
    "Processor signer authorization",
    input.evidenceBytes,
  );
  const issuingPublicKey = exact(
    "Processor signer authorization issuer public key",
    input.issuingPublicKey,
    PUBLIC_KEY_BYTES,
  );
  const evidenceHash = exact(
    "Processor signer authorization hash",
    input.evidenceHash,
    HASH_BYTES,
  );
  try {
    if (!equalBytes(input.crypto.hash(evidenceBytes), evidenceHash)) {
      throw new TypeError("Processor signer authorization hash does not match");
    }
    const decoded = decodeProcessorSignerAuthorizationV1(evidenceBytes);
    const verified = verifyHistoricalProcessorSignerAuthorizationV1(
      input.crypto,
      {
        authorizationBytes: evidenceBytes,
        resolveHistoricalIssuingDevicePublicKey: (context) =>
          context.id === decoded.id
            && context.issuingHumanId === decoded.issuingHumanId
            && context.issuingDeviceId === decoded.issuingDeviceId
            && context.issuingDeviceAuthorizationRevision
              === decoded.issuingDeviceAuthorizationRevision
            ? issuingPublicKey
            : null,
      },
    );
    const result = Object.freeze({
      kind: "processor_authorization" as const,
      authorizationId: decoded.id,
      processorKind: decoded.processorKind,
      processorVersion: decoded.processorVersion,
      signerKeyId: decoded.signer.signerKeyId,
      issuingHumanId: decoded.issuingHumanId,
      issuingDeviceId: decoded.issuingDeviceId,
      issuingDeviceAuthorizationRevision:
        decoded.issuingDeviceAuthorizationRevision,
      evidenceBytes,
      issuingPublicKey,
      evidenceHash,
    });
    destroyVerifiedProcessorAuthorization(verified);
    return result;
  } catch (error) {
    evidenceBytes.fill(0);
    issuingPublicKey.fill(0);
    evidenceHash.fill(0);
    throw error;
  }
}

function humanDeviceTransferEvidenceFromBytes(input: Readonly<{
  crypto: LatticeCrypto;
  approvalBytes: Uint8Array;
  targetSigningPublicKey: Uint8Array;
  issuerSigningPublicKey: Uint8Array;
  evidenceHash: Uint8Array;
}>): ClientHumanDeviceTransferSignerEvidenceV4 {
  const approvalBytes = exact("Human device-transfer approval", input.approvalBytes);
  const targetSigningPublicKey = exact(
    "Human device-transfer target signing public key",
    input.targetSigningPublicKey,
    PUBLIC_KEY_BYTES,
  );
  const issuerSigningPublicKey = exact(
    "Human device-transfer issuer signing public key",
    input.issuerSigningPublicKey,
    PUBLIC_KEY_BYTES,
  );
  const evidenceHash = exact(
    "Human device-transfer evidence hash",
    input.evidenceHash,
    HASH_BYTES,
  );
  let approval: ReturnType<typeof decodeDeviceTransferApprovalV2> | undefined;
  const targetDigest = input.crypto.hash(targetSigningPublicKey);
  try {
    if (!equalBytes(input.crypto.hash(approvalBytes), evidenceHash)) {
      throw new TypeError("Human device-transfer approval hash does not match");
    }
    approval = decodeDeviceTransferApprovalV2(approvalBytes);
    if (!equalBytes(approval.signingPublicKeyDigest, targetDigest)
      || !input.crypto.verify(
        issuerSigningPublicKey,
        deviceTransferApprovalSigningBytesV2(approval),
        approval.signature,
      )) {
      throw new TypeError("Human device-transfer signer evidence is not authentic");
    }
    return Object.freeze({
      kind: "human_device_transfer_approval" as const,
      humanId: approval.humanId,
      targetDeviceId: approval.targetDeviceId,
      issuerDeviceId: approval.issuerDeviceId,
      approvalBytes,
      targetSigningPublicKey,
      issuerSigningPublicKey,
      evidenceHash,
    });
  } catch (error) {
    approvalBytes.fill(0);
    targetSigningPublicKey.fill(0);
    issuerSigningPublicKey.fill(0);
    evidenceHash.fill(0);
    throw error;
  } finally {
    targetDigest.fill(0);
    if (approval) destroyDeviceTransferApproval(approval);
  }
}

function verifyCoordinates(
  expected: ClientSignerEvidenceV4,
  actual: ClientSignerEvidenceV4,
): void {
  const coordinatesMatch = expected.kind === actual.kind
    && evidenceKey(expected) === evidenceKey(actual)
    && (expected.kind === "agent_runtime_publication"
      ? actual.kind === "agent_runtime_publication"
        && expected.managerHumanId === actual.managerHumanId
        && expected.managerAuthorizationRevision
          === actual.managerAuthorizationRevision
        && expected.managerDeviceId === actual.managerDeviceId
      : expected.kind === "processor_authorization"
        ? actual.kind === "processor_authorization"
        && expected.processorKind === actual.processorKind
        && expected.processorVersion === actual.processorVersion
        && expected.signerKeyId === actual.signerKeyId
        && expected.issuingHumanId === actual.issuingHumanId
        && expected.issuingDeviceId === actual.issuingDeviceId
        && expected.issuingDeviceAuthorizationRevision
          === actual.issuingDeviceAuthorizationRevision
        : expected.kind === "shared_human_domain_trust"
          ? actual.kind === "shared_human_domain_trust"
          && expected.domainId === actual.domainId
          && expected.domainEpoch === actual.domainEpoch
          && expected.acceptedByHumanId === actual.acceptedByHumanId
          && expected.acceptedByDeviceId === actual.acceptedByDeviceId
          : actual.kind === "human_device_transfer_approval"
            && expected.humanId === actual.humanId
            && expected.targetDeviceId === actual.targetDeviceId
            && expected.issuerDeviceId === actual.issuerDeviceId);
  if (!coordinatesMatch) {
    throw new TypeError("Client signer evidence coordinates were substituted");
  }
}

function authenticateEvidence(
  crypto: LatticeCrypto,
  value: ClientSignerEvidenceV4,
): ClientSignerEvidenceV4 {
  const result = value.kind === "agent_runtime_publication"
    ? agentEvidenceFromBytes({
      crypto,
      evidenceBytes: value.evidenceBytes,
      issuingPublicKey: value.issuingPublicKey,
      evidenceHash: value.evidenceHash,
    })
    : value.kind === "processor_authorization"
    ? processorEvidenceFromBytes({
      crypto,
      evidenceBytes: value.evidenceBytes,
      issuingPublicKey: value.issuingPublicKey,
      evidenceHash: value.evidenceHash,
    })
    : value.kind === "human_device_transfer_approval"
    ? humanDeviceTransferEvidenceFromBytes({
      crypto,
      approvalBytes: value.approvalBytes,
      targetSigningPublicKey: value.targetSigningPublicKey,
      issuerSigningPublicKey: value.issuerSigningPublicKey,
      evidenceHash: value.evidenceHash,
    })
    : sharedDomainEvidenceFromBytes({
      crypto,
      acceptanceBytes: value.acceptanceBytes,
      devices: value.devices,
      evidenceHash: value.evidenceHash,
    });
  try {
    verifyCoordinates(value, result);
    return result;
  } catch (error) {
    destroyEvidence(result);
    throw error;
  }
}

function canonicalEvidence(
  crypto: LatticeCrypto,
  values: readonly ClientSignerEvidenceV4[],
): readonly ClientSignerEvidenceV4[] {
  if (!Array.isArray(values as unknown)) {
    throw new TypeError("Client signer evidence must be an array");
  }
  if (values.length > CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE) {
    throw new RangeError("Client signer evidence inventory exceeds its bound");
  }
  const result: ClientSignerEvidenceV4[] = [];
  try {
    for (const value of values) {
      result.push(authenticateEvidence(crypto, value));
    }
    result.sort((left, right) => compare(evidenceKey(left), evidenceKey(right)));
  } catch (error) {
    result.forEach(destroyEvidence);
    throw error;
  }
  if (result.some((entry, index) => index > 0
    && evidenceKey(result[index - 1]!) === evidenceKey(entry))) {
    result.forEach(destroyEvidence);
    throw new TypeError("Client signer evidence must be canonical and unique");
  }
  return Object.freeze(result);
}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  u32(): number {
    if (this.offset + 4 > this.bytes.length) {
      throw new RangeError("Client profile v4 is truncated");
    }
    const value = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getUint32(this.offset);
    this.offset += 4;
    return value;
  }
  u64(): number {
    if (this.offset + 8 > this.bytes.length) {
      throw new RangeError("Client profile v4 is truncated");
    }
    const value = Number(new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    ).getBigUint64(this.offset));
    this.offset += 8;
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Client profile v4 counter is unsafe");
    }
    return value;
  }
  frame(max: number = CLIENT_DEVICE_PROFILE_V4_MAX_BYTES): Uint8Array {
    const length = this.u32();
    if (length > max || this.offset + length > this.bytes.length) {
      throw new RangeError("Client profile v4 frame is invalid");
    }
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  text(): string {
    const bytes = this.frame(128);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  finish(): void {
    if (this.offset !== this.bytes.length) {
      throw new RangeError("Client profile v4 has trailing bytes");
    }
  }
}

function encodeEvidence(value: ClientSignerEvidenceV4): Uint8Array[] {
  if (value.kind === "agent_runtime_publication") {
    return [
      text(value.kind),
      text(value.agentId),
      u64(value.authorizationRevision),
      u64(value.runtimeGeneration),
      text(value.signerKeyId),
      text(value.managerHumanId),
      u64(value.managerAuthorizationRevision),
      text(value.managerDeviceId),
      frame(value.evidenceBytes),
      frame(value.issuingPublicKey),
      frame(value.evidenceHash),
    ];
  }
  if (value.kind === "human_device_transfer_approval") {
    return [
      text(value.kind),
      text(value.humanId),
      text(value.targetDeviceId),
      text(value.issuerDeviceId),
      frame(value.approvalBytes),
      frame(value.targetSigningPublicKey),
      frame(value.issuerSigningPublicKey),
      frame(value.evidenceHash),
    ];
  }
  if (value.kind === "shared_human_domain_trust") {
    return [
      text(value.kind),
      text(value.domainId),
      u64(value.domainEpoch),
      text(value.acceptedByHumanId),
      text(value.acceptedByDeviceId),
      frame(value.acceptanceBytes),
      u32(value.devices.length),
      ...value.devices.flatMap((entry) => [
        text(entry.humanId),
        text(entry.deviceId),
        u64(entry.deviceGeneration),
        frame(entry.signingPublicKey),
      ]),
      frame(value.evidenceHash),
    ];
  }
  return [
    text(value.kind),
    text(value.authorizationId),
    text(value.processorKind),
    u32(value.processorVersion),
    text(value.signerKeyId),
    text(value.issuingHumanId),
    text(value.issuingDeviceId),
    u64(value.issuingDeviceAuthorizationRevision),
    frame(value.evidenceBytes),
    frame(value.issuingPublicKey),
    frame(value.evidenceHash),
  ];
}

export function withClientObjectAccessSignerResolversV4<Value>(input: Readonly<{
  crypto: LatticeCrypto;
  profile: OpenedClientDeviceProfileV4;
  operation: (resolvers: ClientObjectAccessSignerResolversV4) => Value;
}>): Value {
  const authenticated = canonicalEvidence(
    input.crypto,
    input.profile.signerEvidence,
  );
  const agentKeys: Uint8Array[] = [];
  const humanKeys: Uint8Array[] = [];
  try {
    const agents = new Map<string, Uint8Array>();
    const processors = new Map<string, ClientProcessorSignerEvidenceV4>();
    const humans = new Map<string, Uint8Array>();
    for (const entry of authenticated) {
      if (entry.kind === "agent_runtime_publication") {
        const publication = decodeAgentRuntimeSignerPublicationV1(
          entry.evidenceBytes,
        );
        const key = publication.signerPublicKey.slice();
        agentKeys.push(key);
        agents.set(
          `${publication.agentId}:${String(publication.runtimeGeneration)}:${publication.signerKeyId}`,
          key,
        );
      } else if (entry.kind === "processor_authorization") {
        processors.set(entry.authorizationId, entry);
      } else if (entry.kind === "human_device_transfer_approval") {
          for (const [deviceId, publicKey] of [[
            entry.targetDeviceId,
            entry.targetSigningPublicKey,
          ], [entry.issuerDeviceId, entry.issuerSigningPublicKey]] as const) {
            const mapKey = `${entry.humanId}:${deviceId}`;
            const current = humans.get(mapKey);
            if (current !== undefined && !equalBytes(current, publicKey)) {
              throw new TypeError("Human device signer evidence collided");
            }
            if (current === undefined) {
              const owned = publicKey.slice();
              humanKeys.push(owned);
              humans.set(mapKey, owned);
            }
          }
      } else {
        for (const device of entry.devices) {
          const mapKey = `${device.humanId}:${device.deviceId}`;
          const current = humans.get(mapKey);
          if (current !== undefined
            && !equalBytes(current, device.signingPublicKey)) {
            throw new TypeError("Human device signer evidence collided");
          }
          if (current === undefined) {
            const owned = device.signingPublicKey.slice();
            humanKeys.push(owned);
            humans.set(mapKey, owned);
          }
        }
      }
    }
    return input.operation(Object.freeze({
      resolveAgentRuntimeSignerPublicKey: (
        principal: AgentRuntimeObjectSignerPrincipalV1,
      ) =>
        agents.get(
          `${principal.agentId}:${String(principal.runtimeGeneration)}:${principal.signerKeyId}`,
        ) ?? null,
      resolveProcessorSignerAuthorizationBytes: (
        evidence: Readonly<{
          authorizationId: string;
          authorizationHash: Uint8Array;
        }>,
      ) => {
        const entry = processors.get(evidence.authorizationId);
        if (
          entry === undefined
          || !equalBytes(entry.evidenceHash, evidence.authorizationHash)
        ) return null;
        return entry.evidenceBytes;
      },
      resolveHistoricalProcessorIssuingDevicePublicKey: (
        context: ProcessorSignerAuthorizationAuthorityContextV1,
      ) => {
        const entry = [...processors.values()].find((candidate) =>
          candidate.issuingHumanId === context.issuingHumanId
          && candidate.issuingDeviceId === context.issuingDeviceId
          && candidate.issuingDeviceAuthorizationRevision
            === context.issuingDeviceAuthorizationRevision
        );
        if (entry === undefined) return null;
        return entry.issuingPublicKey;
      },
      resolveHistoricalHumanDeviceSigningPublicKey: ({ humanId, deviceId }: Readonly<{
        humanId: string;
        deviceId: string;
      }>) =>
        humans.get(`${humanId}:${deviceId}`) ?? null,
    }));
  } finally {
    agentKeys.forEach((bytes) => bytes.fill(0));
    humanKeys.forEach((bytes) => bytes.fill(0));
    authenticated.forEach(destroyEvidence);
  }
}

export function destroyOpenedClientDeviceProfileV4(
  profile: OpenedClientDeviceProfileV4,
): void {
  destroyOpenedClientDeviceProfileV3(profile.baseProfile);
  destroyHumanDeviceGroupSnapshot(profile.humanDeviceGroupSnapshot);
  profile.signerEvidence.forEach(destroyEvidence);
}

export function encodeClientDeviceProfileV4(
  input: OpenedClientDeviceProfileV4,
): Uint8Array {
  const baseBytes = encodeClientDeviceProfileV3(input.baseProfile);
  const snapshot = copyHumanDeviceGroupSnapshot(
    input.humanDeviceGroupSnapshot,
  );
  const parts: Uint8Array[] = [
    text(CLIENT_DEVICE_PROFILE_V4_DOMAIN),
    frame(baseBytes),
    u32(snapshot === null ? 0 : 1),
    ...(snapshot === null ? [] : [
      text(snapshot.providerId),
      text(snapshot.domainId),
      u64(snapshot.epoch),
      frame(snapshot.stateHash),
      frame(snapshot.ciphertext),
    ]),
    u32(input.signerEvidence.length),
  ];
  try {
    if (input.signerEvidence.length > CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE) {
      throw new RangeError("Client signer evidence inventory exceeds its bound");
    }
    let previous = "";
    for (const evidence of input.signerEvidence) {
      const key = evidenceKey(evidence);
      if (previous !== "" && compare(previous, key) >= 0) {
        throw new TypeError("Client signer evidence must use canonical ordering");
      }
      previous = key;
      parts.push(...encodeEvidence(evidence));
    }
    const bytes = concat(parts);
    if (bytes.length > CLIENT_DEVICE_PROFILE_V4_MAX_BYTES) {
      bytes.fill(0);
      throw new RangeError("Client profile v4 exceeds its byte bound");
    }
    return bytes;
  } finally {
    baseBytes.fill(0);
    destroyHumanDeviceGroupSnapshot(snapshot);
    parts.forEach((part) => part.fill(0));
  }
}

function decodeEvidence(reader: Reader): ClientSignerEvidenceV4 {
  const kind = reader.text();
  if (kind === "agent_runtime_publication") {
    return Object.freeze({
      kind,
      agentId: portable("Agent", reader.text()),
      authorizationRevision: counter("Agent authorization revision", reader.u64()),
      runtimeGeneration: counter("Runtime generation", reader.u64()),
      signerKeyId: portable("Runtime signer key", reader.text()),
      managerHumanId: portable("Runtime manager Human", reader.text()),
      managerAuthorizationRevision: counter(
        "Runtime manager authorization revision",
        reader.u64(),
      ),
      managerDeviceId: portable("Runtime manager device", reader.text()),
      evidenceBytes: reader.frame(),
      issuingPublicKey: reader.frame(PUBLIC_KEY_BYTES),
      evidenceHash: reader.frame(HASH_BYTES),
    });
  }
  if (kind === "processor_authorization") {
    const authorizationId = reader.text();
    const processorKind = reader.text();
    const processorVersion = reader.u32();
    if (processorKind !== "stenographer" || processorVersion !== 1) {
      throw new TypeError("Processor signer evidence kind is unsupported");
    }
    return Object.freeze({
      kind,
      authorizationId: portable("Processor authorization", authorizationId),
      processorKind,
      processorVersion,
      signerKeyId: portable("Processor signer key", reader.text()),
      issuingHumanId: portable("Processor issuing Human", reader.text()),
      issuingDeviceId: portable("Processor issuing device", reader.text()),
      issuingDeviceAuthorizationRevision: counter(
        "Processor issuing device authorization revision",
        reader.u64(),
      ),
      evidenceBytes: reader.frame(),
      issuingPublicKey: reader.frame(PUBLIC_KEY_BYTES),
      evidenceHash: reader.frame(HASH_BYTES),
    });
  }
  if (kind === "human_device_transfer_approval") {
    return Object.freeze({
      kind,
      humanId: portable("Human device-transfer Human", reader.text()),
      targetDeviceId: portable("Human device-transfer target", reader.text()),
      issuerDeviceId: portable("Human device-transfer issuer", reader.text()),
      approvalBytes: reader.frame(),
      targetSigningPublicKey: reader.frame(PUBLIC_KEY_BYTES),
      issuerSigningPublicKey: reader.frame(PUBLIC_KEY_BYTES),
      evidenceHash: reader.frame(HASH_BYTES),
    });
  }
  if (kind === "shared_human_domain_trust") {
    const domainId = portable("Shared Human Domain", reader.text());
    const domainEpoch = counter("Shared Human Domain epoch", reader.u64());
    const acceptedByHumanId = portable(
      "Shared Human Domain accepting Human",
      reader.text(),
    );
    const acceptedByDeviceId = portable(
      "Shared Human Domain accepting device",
      reader.text(),
    );
    const acceptanceBytes = reader.frame();
    const deviceCount = reader.u32();
    if (deviceCount < 2 || deviceCount > 256) {
      acceptanceBytes.fill(0);
      throw new RangeError("Shared Human Domain device count is out of bounds");
    }
    const devices: SharedHumanDomainTrustedDeviceV1[] = [];
    try {
      for (let index = 0; index < deviceCount; index += 1) {
        devices.push(Object.freeze({
          humanId: portable("Shared Human Domain Human", reader.text()),
          deviceId: portable("Shared Human Domain device", reader.text()),
          deviceGeneration: counter(
            "Shared Human Domain device generation",
            reader.u64(),
          ),
          signingPublicKey: reader.frame(PUBLIC_KEY_BYTES),
        }));
      }
      return Object.freeze({
        kind,
        domainId,
        domainEpoch,
        acceptedByHumanId,
        acceptedByDeviceId,
        acceptanceBytes,
        devices: Object.freeze(devices),
        evidenceHash: reader.frame(HASH_BYTES),
      });
    } catch (error) {
      acceptanceBytes.fill(0);
      devices.forEach((entry) => entry.signingPublicKey.fill(0));
      throw error;
    }
  }
  throw new TypeError("Client signer evidence kind is unsupported");
}

export async function authenticateClientDeviceProfileV4(input: Readonly<{
  crypto: LatticeCrypto;
  profileBytes: Uint8Array;
  expectedDeviceId: string;
}>): Promise<OpenedClientDeviceProfileV4> {
  if (
    !(input.profileBytes instanceof Uint8Array)
    || input.profileBytes.length < 1
    || input.profileBytes.length > CLIENT_DEVICE_PROFILE_V4_MAX_BYTES
  ) throw new RangeError("Client profile v4 bytes are invalid");
  const reader = new Reader(input.profileBytes);
  if (reader.text() !== CLIENT_DEVICE_PROFILE_V4_DOMAIN) {
    throw new TypeError("Client profile v4 is unavailable");
  }
  const baseBytes = reader.frame();
  let baseProfile: OpenedClientDeviceProfileV3 | undefined;
  let humanDeviceGroupSnapshot: ClientDomainProviderSnapshotV3 | null = null;
  let evidence: readonly ClientSignerEvidenceV4[] = [];
  try {
    baseProfile = await authenticateClientDeviceProfileV3({
      crypto: input.crypto,
      profileBytes: baseBytes,
      expectedDeviceId: input.expectedDeviceId,
    });
    const snapshotCount = reader.u32();
    if (snapshotCount > 1) {
      throw new RangeError("Human-device group snapshot count is invalid");
    }
    if (snapshotCount === 1) {
      const providerId = portable("Human-device provider", reader.text());
      const domainId = portable("Human-device group", reader.text());
      const epoch = counter("Human-device group epoch", reader.u64());
      const stateHashFrame = reader.frame(HASH_BYTES);
      const ciphertextFrame = reader.frame();
      try {
        humanDeviceGroupSnapshot = Object.freeze({
          providerId,
          domainId,
          epoch,
          stateHash: exact(
            "Human-device group state hash",
            stateHashFrame,
            HASH_BYTES,
          ),
          ciphertext: exact("Human-device group state", ciphertextFrame),
        });
      } finally {
        stateHashFrame.fill(0);
        ciphertextFrame.fill(0);
      }
    }
    const count = reader.u32();
    if (count > CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE) {
      throw new RangeError("Client signer evidence inventory exceeds its bound");
    }
    const decoded: ClientSignerEvidenceV4[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        decoded.push(decodeEvidence(reader));
      }
      reader.finish();
      evidence = canonicalEvidence(input.crypto, decoded);
    } finally {
      decoded.forEach(destroyEvidence);
    }
    const result = Object.freeze({
      formatVersion: 4 as const,
      baseProfile,
      humanDeviceGroupSnapshot,
      signerEvidence: evidence,
    });
    const canonicalBytes = encodeClientDeviceProfileV4(result);
    try {
      if (!equalBytes(canonicalBytes, input.profileBytes)) {
        throw new TypeError("Client profile v4 bytes are noncanonical");
      }
    } finally {
      canonicalBytes.fill(0);
    }
    return result;
  } catch (error) {
    if (baseProfile) destroyOpenedClientDeviceProfileV3(baseProfile);
    destroyHumanDeviceGroupSnapshot(humanDeviceGroupSnapshot);
    evidence.forEach(destroyEvidence);
    throw error;
  } finally {
    baseBytes.fill(0);
  }
}

export async function createClientDeviceProfileV4Candidate(input: Readonly<{
  crypto: LatticeCrypto;
  currentProfileBytes: Uint8Array;
  expectedDeviceId: string;
  v1Migration?: Readonly<{
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
    deliveryHighWatermark: number;
  }>;
}>): Promise<OpenedClientDeviceProfileV4> {
  if (hasProfileDomain(input.currentProfileBytes, CLIENT_DEVICE_PROFILE_V4_DOMAIN)) {
    throw new TypeError("Client profile is already v4; use the v4 update lifecycle");
  }
  const baseProfile = hasProfileDomain(
    input.currentProfileBytes,
    "nautilo/client-device-profile/v3",
  )
    ? await authenticateClientDeviceProfileV3({
      crypto: input.crypto,
      profileBytes: input.currentProfileBytes,
      expectedDeviceId: input.expectedDeviceId,
    })
    : await createClientDeviceProfileV3Candidate({
      crypto: input.crypto,
      currentProfileBytes: input.currentProfileBytes,
      expectedDeviceId: input.expectedDeviceId,
      ...(input.v1Migration === undefined
        ? {}
        : { v1Migration: input.v1Migration }),
    });
  return Object.freeze({
    formatVersion: 4 as const,
    baseProfile,
    humanDeviceGroupSnapshot: null,
    signerEvidence: Object.freeze([]),
  });
}

export async function addClientSignerEvidenceV4(input: Readonly<{
  crypto: LatticeCrypto;
  profile: OpenedClientDeviceProfileV4;
  evidence: Readonly<{
    kind: "agent_runtime_publication" | "processor_authorization";
    evidenceBytes: Uint8Array;
    issuingPublicKey: Uint8Array;
  }>;
}>): Promise<OpenedClientDeviceProfileV4> {
  const evidenceHash = input.crypto.hash(input.evidence.evidenceBytes);
  let next: ClientSignerEvidenceV4 | undefined;
  try {
    next = input.evidence.kind === "agent_runtime_publication"
      ? agentEvidenceFromBytes({
        crypto: input.crypto,
        evidenceBytes: input.evidence.evidenceBytes,
        issuingPublicKey: input.evidence.issuingPublicKey,
        evidenceHash,
      })
      : processorEvidenceFromBytes({
        crypto: input.crypto,
        evidenceBytes: input.evidence.evidenceBytes,
        issuingPublicKey: input.evidence.issuingPublicKey,
        evidenceHash,
      });
    const current = input.profile.signerEvidence.find((entry) =>
      evidenceKey(entry) === evidenceKey(next!)
    );
    if (current !== undefined) {
      if (
        current.kind === "human_device_transfer_approval"
        || current.kind !== next.kind
        || !equalBytes(current.evidenceHash, next.evidenceHash)
        || !equalBytes(current.issuingPublicKey, next.issuingPublicKey)
      ) throw new TypeError("Client signer evidence collision was detected");
      destroyEvidence(next);
      next = undefined;
    }
    const candidateEvidence = canonicalEvidence(
      input.crypto,
      current === undefined
        ? [...input.profile.signerEvidence, next!]
        : input.profile.signerEvidence,
    );
    const baseBytes = encodeClientDeviceProfileV3(input.profile.baseProfile);
    let baseProfile: OpenedClientDeviceProfileV3 | undefined;
    try {
      baseProfile = await authenticateClientDeviceProfileV3({
        crypto: input.crypto,
        profileBytes: baseBytes,
        expectedDeviceId: input.profile.baseProfile.baseProfile.deviceId,
      });
      const result = Object.freeze({
        formatVersion: 4 as const,
        baseProfile,
        humanDeviceGroupSnapshot: copyHumanDeviceGroupSnapshot(
          input.profile.humanDeviceGroupSnapshot,
        ),
        signerEvidence: candidateEvidence,
      });
      const bytes = encodeClientDeviceProfileV4(result);
      bytes.fill(0);
      return result;
    } catch (error) {
      if (baseProfile) destroyOpenedClientDeviceProfileV3(baseProfile);
      candidateEvidence.forEach(destroyEvidence);
      throw error;
    } finally {
      baseBytes.fill(0);
    }
  } finally {
    evidenceHash.fill(0);
    if (next !== undefined) destroyEvidence(next);
  }
}

/** Adds the exact signed transfer approved after the local comparison-code check. */
export async function addClientHumanDeviceTransferSignerEvidenceV4(
  input: Readonly<{
    crypto: LatticeCrypto;
    profile: OpenedClientDeviceProfileV4;
    approvalBytes: Uint8Array;
    targetSigningPublicKey: Uint8Array;
    issuerSigningPublicKey: Uint8Array;
  }>,
): Promise<OpenedClientDeviceProfileV4> {
  const evidenceHash = input.crypto.hash(input.approvalBytes);
  let next: ClientHumanDeviceTransferSignerEvidenceV4 | undefined;
  try {
    next = humanDeviceTransferEvidenceFromBytes({
      crypto: input.crypto,
      approvalBytes: input.approvalBytes,
      targetSigningPublicKey: input.targetSigningPublicKey,
      issuerSigningPublicKey: input.issuerSigningPublicKey,
      evidenceHash,
    });
    const current = input.profile.signerEvidence.find((entry) =>
      evidenceKey(entry) === evidenceKey(next!)
    );
    if (current !== undefined) {
      if (current.kind !== "human_device_transfer_approval"
        || !equalBytes(current.evidenceHash, next.evidenceHash)
        || !equalBytes(
          current.targetSigningPublicKey,
          next.targetSigningPublicKey,
        )
        || !equalBytes(
          current.issuerSigningPublicKey,
          next.issuerSigningPublicKey,
        )) {
        throw new TypeError("Human device signer evidence collided");
      }
      destroyEvidence(next);
      next = undefined;
    }
    const candidateEvidence = canonicalEvidence(
      input.crypto,
      current === undefined
        ? [...input.profile.signerEvidence, next!]
        : input.profile.signerEvidence,
    );
    const baseBytes = encodeClientDeviceProfileV3(input.profile.baseProfile);
    let baseProfile: OpenedClientDeviceProfileV3 | undefined;
    try {
      baseProfile = await authenticateClientDeviceProfileV3({
        crypto: input.crypto,
        profileBytes: baseBytes,
        expectedDeviceId: input.profile.baseProfile.baseProfile.deviceId,
      });
      const result = Object.freeze({
        formatVersion: 4 as const,
        baseProfile,
        humanDeviceGroupSnapshot: copyHumanDeviceGroupSnapshot(
          input.profile.humanDeviceGroupSnapshot,
        ),
        signerEvidence: candidateEvidence,
      });
      const bytes = encodeClientDeviceProfileV4(result);
      bytes.fill(0);
      return result;
    } catch (error) {
      if (baseProfile) destroyOpenedClientDeviceProfileV3(baseProfile);
      candidateEvidence.forEach(destroyEvidence);
      throw error;
    } finally {
      baseBytes.fill(0);
    }
  } finally {
    evidenceHash.fill(0);
    if (next !== undefined) destroyEvidence(next);
  }
}

/**
 * Pins the complete first-contact device inventory for one shared Human
 * Domain. The acceptance must be signed by this profile's local device.
 */
export async function addClientSharedHumanDomainSignerEvidenceV4(
  input: Readonly<{
    crypto: LatticeCrypto;
    profile: OpenedClientDeviceProfileV4;
    acceptanceBytes: Uint8Array;
    devices: readonly SharedHumanDomainTrustedDeviceV1[];
  }>,
): Promise<OpenedClientDeviceProfileV4> {
  const evidenceHash = input.crypto.hash(input.acceptanceBytes);
  let next: ClientSharedHumanDomainSignerEvidenceV4 | undefined;
  try {
    next = sharedDomainEvidenceFromBytes({
      crypto: input.crypto,
      acceptanceBytes: input.acceptanceBytes,
      devices: input.devices,
      evidenceHash,
    });
    if (next.acceptedByDeviceId
      !== input.profile.baseProfile.baseProfile.deviceId) {
      throw new TypeError(
        "Shared Human Domain trust must be accepted by the local device",
      );
    }
    const current = input.profile.signerEvidence.find((entry) =>
      evidenceKey(entry) === evidenceKey(next!)
    );
    if (current !== undefined) {
      if (current.kind !== "shared_human_domain_trust"
        || !equalBytes(current.evidenceHash, next.evidenceHash)
        || current.devices.length !== next.devices.length
        || current.devices.some((entry, index) => {
          const candidate = next!.devices[index];
          return candidate === undefined
            || entry.humanId !== candidate.humanId
            || entry.deviceId !== candidate.deviceId
            || entry.deviceGeneration !== candidate.deviceGeneration
            || !equalBytes(entry.signingPublicKey, candidate.signingPublicKey);
        })) {
        throw new TypeError("Shared Human Domain signer evidence collided");
      }
      destroyEvidence(next);
      next = undefined;
    }
    const candidateEvidence = canonicalEvidence(
      input.crypto,
      current === undefined
        ? [...input.profile.signerEvidence, next!]
        : input.profile.signerEvidence,
    );
    const baseBytes = encodeClientDeviceProfileV3(input.profile.baseProfile);
    let baseProfile: OpenedClientDeviceProfileV3 | undefined;
    try {
      baseProfile = await authenticateClientDeviceProfileV3({
        crypto: input.crypto,
        profileBytes: baseBytes,
        expectedDeviceId: input.profile.baseProfile.baseProfile.deviceId,
      });
      const result = Object.freeze({
        formatVersion: 4 as const,
        baseProfile,
        humanDeviceGroupSnapshot: copyHumanDeviceGroupSnapshot(
          input.profile.humanDeviceGroupSnapshot,
        ),
        signerEvidence: candidateEvidence,
      });
      const bytes = encodeClientDeviceProfileV4(result);
      bytes.fill(0);
      return result;
    } catch (error) {
      if (baseProfile) destroyOpenedClientDeviceProfileV3(baseProfile);
      candidateEvidence.forEach(destroyEvidence);
      throw error;
    } finally {
      baseBytes.fill(0);
    }
  } finally {
    evidenceHash.fill(0);
    if (next !== undefined) destroyEvidence(next);
  }
}

/**
 * Produces one detached authenticated v4 candidate while replacing only its
 * nested v3 state. Signer evidence is preserved byte-for-byte.
 */
export async function updateClientDeviceProfileV4(input: Readonly<{
  crypto: LatticeCrypto;
  profile: OpenedClientDeviceProfileV4;
  baseProfile: OpenedClientDeviceProfileV3;
}>): Promise<OpenedClientDeviceProfileV4> {
  const candidateBytes = encodeClientDeviceProfileV4(Object.freeze({
    formatVersion: 4 as const,
    baseProfile: input.baseProfile,
    humanDeviceGroupSnapshot: input.profile.humanDeviceGroupSnapshot,
    signerEvidence: input.profile.signerEvidence,
  }));
  try {
    return await authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes: candidateBytes,
      expectedDeviceId: input.profile.baseProfile.baseProfile.deviceId,
    });
  } finally { candidateBytes.fill(0); }
}

export async function stageAndActivateClientDeviceProfileV4(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  stageId: string;
  generation: number;
  publicState: ClientProfilePublicState;
  candidate: OpenedClientDeviceProfileV4;
}>): Promise<void> {
  const candidateBytes = encodeClientDeviceProfileV4(input.candidate);
  let authenticated: OpenedClientDeviceProfileV4 | undefined;
  try {
    authenticated = await authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes: candidateBytes,
      expectedDeviceId: input.coordinates.deviceId,
    });
    await input.vault.stageProfile({
      coordinates: input.coordinates,
      stageId: input.stageId,
      generation: input.generation,
      profileBytes: candidateBytes,
      publicState: input.publicState,
    });
    await input.vault.activateProfile(input.coordinates, input.stageId);
  } finally {
    candidateBytes.fill(0);
    if (authenticated) destroyOpenedClientDeviceProfileV4(authenticated);
  }
}

/** Current-profile rollback-anchor custody preserving the complete V4 profile. */
export function createClientProfileObjectAccessAnchorPortV4(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  createStageId(): string;
}>) {
  return createClientProfileObjectAccessAnchorPortOwner({
    ...input,
    authenticate: (profileBytes) => authenticateClientDeviceProfileV4({
      crypto: input.crypto, profileBytes,
      expectedDeviceId: input.coordinates.deviceId,
    }),
    anchors: (profile) => profile.baseProfile.objectAccessAnchors,
    encode: (profile, objectAccessAnchors) => encodeClientDeviceProfileV4(
      Object.freeze({ ...profile, baseProfile: Object.freeze({
        ...profile.baseProfile, objectAccessAnchors,
      }) }),
    ),
    destroy: destroyOpenedClientDeviceProfileV4,
  });
}
