import type {
  ProtectedAdditionalDeviceActivationV1,
  ProtectedAdditionalDeviceApprovalRequestV1,
  ProtectedAdditionalDeviceApprovalResponseV1,
  ProtectedAdditionalDeviceAcknowledgementRequestV1,
  ProtectedAdditionalDeviceBeginRequestV2,
  ProtectedAdditionalDevicePendingListV2,
  ProtectedAdditionalDevicePlanV1,
  ProtectedAdditionalDevicePlanV2,
  ProtectedAdditionalDeviceTransitionPlanV2,
  ProtectedAdditionalDeviceTransitionsRequestV2,
  ProtectedAdditionalDeviceDeliveriesRequestV1,
  ProtectedAdditionalDeviceDeliveriesV1,
} from "@nautilo/api-client/browser";
import { PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE } from
  "@nautilo/api-client/browser";
import {
  DeviceProviderStateVault,
  LatticeCrypto,
  OpenMlsGroupProvider,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  prepareDomainEpochAdvance,
  prepareDeviceTransfer,
  restoreSealedProviderState,
  unixTimestamp,
  verifyNamespaceBindingProof,
} from "@nautilo/lattice-crypto";
import type {
  ProviderPublicHeadV2,
  SealedProviderStateV2,
} from "@nautilo/lattice-crypto/wire";
import {
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  addClientSharedHumanDomainSignerEvidenceV4,
  addClientHumanDeviceTransferSignerEvidenceV4,
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
  updateClientDeviceProfileV4,
} from "../client-vault/profile-v4.ts";
import {
  createSharedHumanDomainTrustAcceptanceV1,
  encodeSharedHumanDomainTrustAcceptanceV1,
  type SharedHumanDomainTrustedDeviceV1,
} from "../delivery/shared-human-domain-trust.ts";
import {
  addClientDomainProviderSnapshot,
  destroyOpenedClientDeviceProfileV3,
  updateClientDeviceProfileV3,
  withClientDomainRoots,
} from "../client-vault/profile-v3.ts";
import { withSoleFoundingDeviceHistoricalCommitterV4 } from
  "../client-vault/sole-founding-device-historical-committer-v4.ts";
import {
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV1,
} from "../client-vault/profile-v2.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../client-vault/types.ts";
import {
  DEVICE_JOIN_PACKAGE_TTL_MS,
  createDeviceJoinPackage,
  type DeviceJoinPackageEnvelope,
} from "../delivery/device-join-package.ts";
import {
  createAdditionalDeviceApprovalManifest,
} from "./additional-device-approval.ts";
import type { PendingAdditionalDeviceEnrollment } from
  "./additional-device-enrollment.ts";
import {
  createNamespaceTransitionSubmission,
  serializeNamespaceTransitionSubmission,
  verifyNamespaceTransitionSubmission,
} from "../delivery/namespace-transition-submission.ts";
import {
  createProviderTransitionSubmission,
  serializeProviderTransitionSubmission,
  verifyProviderTransitionSubmission,
} from "../delivery/provider-transition-submission.ts";
import {
  createDeviceDeliveryFetchProof,
  DEVICE_DELIVERY_FETCH_MAX_MESSAGES,
  DEVICE_DELIVERY_FETCH_MAX_PAYLOAD_BYTES,
  DEVICE_DELIVERY_FETCH_PROOF_TTL_MS,
} from "../delivery/device-delivery-fetch.ts";
import {
  createDeliveryAcknowledgementProof,
  deliveryAcknowledgementDigest,
} from
  "../delivery/delivery-acknowledgement.ts";
import {
  decodeOpaqueDeliveryArtifactChunk,
  reassembleOpaqueDeliveryArtifact,
} from "../delivery/opaque-artifact.ts";
import { decodeDomainTransitionDeliveryArtifact } from
  "../delivery/domain-transition-delivery.ts";
import { ingestClientKeyringDeliveryHistory } from
  "../delivery/client-keyring-delivery.ts";
import { writeClientNamespaceKeyrings } from
  "./client-namespace-keyring.ts";
import { advanceAndActivateClientTrustedDeviceAuthorityRevision } from
  "./trusted-device-authority-revision.ts";
import {
  createAdditionalDeviceTransitionCampaignJournal,
  createAdditionalDeviceTargetPlanJournal,
  type AdditionalDeviceTransitionCampaignIndex,
  type AdditionalDeviceTransitionCampaignVault,
  type AdditionalDeviceTargetPlanIndex,
} from "./additional-device-transition-journal.ts";

export interface AdditionalDeviceClientApiPort {
  beginProtectedAdditionalDeviceV2(
    input: ProtectedAdditionalDeviceBeginRequestV2,
  ): Promise<ProtectedAdditionalDevicePlanV2>;
  loadProtectedAdditionalDevicePlanPageV2(
    operationId: string,
    input: Readonly<{ requestVersion: 2; deviceId: string; pageStart: number }>,
  ): Promise<ProtectedAdditionalDevicePlanV2>;
  publishProtectedAdditionalDeviceJoinPackagesV2(
    operationId: string,
    input: Readonly<{
      requestVersion: 2;
      deviceId: string;
      packages: readonly EncodedDeviceJoinPackage[];
    }>,
  ): Promise<Readonly<{ status: "published" | "duplicate" }>>;
  activateProtectedAdditionalDevice(
    operationId: string,
    input: Readonly<{ requestVersion: 1; deviceId: string }>,
  ): Promise<ProtectedAdditionalDeviceActivationV1>;
  listProtectedAdditionalDevicePendingV2(input: Readonly<{
    requestVersion: 2;
    approverDeviceId: string;
  }>): Promise<ProtectedAdditionalDevicePendingListV2>;
  approveProtectedAdditionalDevice(
    operationId: string,
    input: ProtectedAdditionalDeviceApprovalRequestV1,
  ): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
  planProtectedAdditionalDeviceTransitionsV2(
    operationId: string,
    input: Readonly<{
      requestVersion: 2;
      approverDeviceId: string;
      pageStart: number;
    }>,
  ): Promise<ProtectedAdditionalDeviceTransitionPlanV2>;
  submitProtectedAdditionalDeviceTransitionsV2(
    operationId: string,
    input: ProtectedAdditionalDeviceTransitionsRequestV2,
  ): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
  loadProtectedAdditionalDeviceDeliveries(
    operationId: string,
    input: ProtectedAdditionalDeviceDeliveriesRequestV1,
  ): Promise<ProtectedAdditionalDeviceDeliveriesV1>;
  acknowledgeProtectedAdditionalDeviceDelivery(
    operationId: string,
    input: ProtectedAdditionalDeviceAcknowledgementRequestV1,
  ): Promise<Readonly<{ status: "acknowledged" | "duplicate" }>>;
}

export interface EncodedDeviceJoinPackage {
  readonly formatVersion: 1;
  readonly providerId: string;
  readonly domainId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly expectedEpoch: number;
  readonly expectedProviderHeadHashBase64url: string;
  readonly generation: 1;
  readonly packageId: string;
  readonly packageHashBase64url: string;
  readonly keyPackageBytesBase64url: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly signatureBase64url: string;
}

export interface PendingAdditionalDeviceJoinState {
  readonly domainId: string;
  readonly expectedHead: ProviderPublicHeadV2;
  readonly localState: SealedProviderStateV2;
  readonly package: EncodedDeviceJoinPackage;
}

export interface PendingAdditionalDeviceClientState {
  readonly formatVersion: 1;
  readonly revision: 1 | 2 | 3;
  readonly idempotencyKey: string;
  readonly coordinates: ClientProfileCoordinates;
  readonly clientKind: "browser" | "electron";
  readonly installationLineageDigest: Uint8Array;
  readonly profileBytes: Uint8Array;
  readonly operationId: string | null;
  readonly joins: readonly PendingAdditionalDeviceJoinState[];
  readonly syncVerificationCode?: string;
  readonly syncReason?: AdditionalDeviceSyncReason;
}

export type AdditionalDeviceSyncReason =
  | "delivery_pending"
  | "current_domain_sync_required"
  | "personal_authority_required"
  ;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

/**
 * Short public comparison code. It is not an authentication secret: the Human
 * compares the independently derived value on the target and approver so the
 * server cannot substitute either device signing key before keyring transfer.
 */
export function deriveAdditionalDeviceVerificationCode(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  operationId: string;
  humanId: string;
  targetDeviceId: string;
  targetSigningPublicKey: Uint8Array;
  approverDeviceId: string;
  approverSigningPublicKey: Uint8Array;
}>): string {
  if (input.targetSigningPublicKey.length !== 32
    || input.approverSigningPublicKey.length !== 32) {
    throw new TypeError("Additional-device comparison keys are invalid");
  }
  const context = new TextEncoder().encode([
    "nautilo/additional-device-verification/v1",
    input.operationId,
    input.humanId,
    input.targetDeviceId,
    input.approverDeviceId,
  ].join("\0"));
  const framed = new Uint8Array(
    context.length + input.targetSigningPublicKey.length
      + input.approverSigningPublicKey.length,
  );
  framed.set(context);
  framed.set(input.targetSigningPublicKey, context.length);
  framed.set(input.approverSigningPublicKey,
    context.length + input.targetSigningPublicKey.length);
  const digest = input.crypto.hash(framed);
  try {
    const value = Array.from(digest.subarray(0, 9), (byte) =>
      byte.toString(16).padStart(2, "0").toUpperCase()
    ).join("");
    return value.match(/.{1,6}/gu)!.join("-");
  } finally {
    context.fill(0);
    framed.fill(0);
    digest.fill(0);
  }
}

export function deriveAdditionalDeviceJoinPackageId(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  operationId: string;
  domainId: string;
}>): string {
  const context = new TextEncoder().encode([
    "nautilo/additional-device-join-package-id/v1",
    input.operationId,
    input.domainId,
  ].join("\0"));
  const digest = input.crypto.hash(context);
  try {
    return `join:${hex(digest)}`;
  } finally {
    context.fill(0);
    digest.fill(0);
  }
}

type CompleteAdditionalDevicePlan = ProtectedAdditionalDevicePlanV1 & Readonly<{
  approver: Readonly<{
    deviceId: string;
    signingPublicKeyBase64url: string;
  }>;
  personalAuthority: ProtectedAdditionalDevicePlanV2["personalAuthority"];
}>;

function plannedApprover(input: Readonly<{
  plan: CompleteAdditionalDevicePlan;
}>): Readonly<{ deviceId: string; signingPublicKey: Uint8Array }> {
  const signingPublicKey = decode(
    input.plan.approver.signingPublicKeyBase64url,
  );
  try {
    if (input.plan.domains.some((domain) => {
      const candidate = decode(domain.committerSigningPublicKeyBase64url);
      try {
        return domain.committerDeviceId !== input.plan.approver.deviceId
          || !equalBytes(candidate, signingPublicKey);
      } finally {
        candidate.fill(0);
      }
    })) throw new TypeError("Additional-device approver changed across Domains");
    return Object.freeze({
      deviceId: input.plan.approver.deviceId,
      signingPublicKey: signingPublicKey.slice(),
    });
  } finally {
    signingPublicKey.fill(0);
  }
}

function assertPlanAccount(
  plan: ProtectedAdditionalDevicePlanV1,
  coordinates: ClientProfileCoordinates,
): void {
  if (plan.enrollment.userId !== coordinates.userId
    || plan.enrollment.humanActorId !== coordinates.humanActorId) {
    throw new TypeError("Additional-device account was substituted");
  }
}

function assertTargetPlan(input: Readonly<{
  plan: ProtectedAdditionalDevicePlanV1;
  state: PendingAdditionalDeviceClientState;
  profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>;
}>): void {
  assertPlanAccount(input.plan, input.state.coordinates);
  const enrollment = input.plan.enrollment;
  const lineage = decode(enrollment.installationLineageDigestBase64url);
  const signingPublicKey = decode(enrollment.signingPublicKeyBase64url);
  const encryptionPublicKey = decode(enrollment.encryptionPublicKeyBase64url);
  try {
    const local = input.profile.baseProfile.baseProfile;
    if (enrollment.deviceId !== input.state.coordinates.deviceId
      || enrollment.clientKind !== input.state.clientKind
      || enrollment.idempotencyKey !== input.state.idempotencyKey
      || !equalBytes(lineage, input.state.installationLineageDigest)
      || !equalBytes(signingPublicKey, local.signingPublicKey)
      || !equalBytes(encryptionPublicKey, local.encryptionPublicKey)) {
      throw new TypeError("Additional-device target plan was substituted");
    }
  } finally {
    lineage.fill(0);
    signingPublicKey.fill(0);
    encryptionPublicKey.fill(0);
  }
}

/**
 * Pins the exact two-device Domain transition into each local profile. live Shadow
 * deliberately supports one additional device; broader inventories remain a
 * later device-management concern rather than trusting server device rows.
 */
export async function addAdditionalDeviceDomainSignerEvidenceV4(input: Readonly<{
  crypto: LatticeCrypto;
  profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>;
  humanId: string;
  domainId: string;
  domainEpoch: number;
  participantDigest: Uint8Array;
  providerTransitionDigest: Uint8Array;
  peerDeviceId: string;
  peerSigningPublicKey: Uint8Array;
  acceptedAt: number;
}>): Promise<Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>> {
  const local = input.profile.baseProfile.baseProfile;
  if (local.deviceId === input.peerDeviceId) {
    throw new TypeError("Additional-device Domain peer must be distinct");
  }
  const devices: readonly SharedHumanDomainTrustedDeviceV1[] = Object.freeze([
    Object.freeze({
      humanId: input.humanId,
      deviceId: local.deviceId,
      deviceGeneration: 1,
      signingPublicKey: local.signingPublicKey,
    }),
    Object.freeze({
      humanId: input.humanId,
      deviceId: input.peerDeviceId,
      deviceGeneration: 1,
      signingPublicKey: input.peerSigningPublicKey,
    }),
  ]);
  const trust = createSharedHumanDomainTrustAcceptanceV1({
    crypto: input.crypto,
    domainId: input.domainId,
    domainEpoch: input.domainEpoch,
    participantDigest: input.participantDigest,
    targetSubmissionDigest: input.providerTransitionDigest,
    devices,
    acceptedByHumanId: input.humanId,
    acceptedByDeviceId: local.deviceId,
    acceptedAt: input.acceptedAt,
    acceptingSigningPrivateKey: local.signingPrivateKey,
  });
  const acceptanceBytes = encodeSharedHumanDomainTrustAcceptanceV1(
    trust.acceptance,
  );
  try {
    return await addClientSharedHumanDomainSignerEvidenceV4({
      crypto: input.crypto,
      profile: input.profile,
      acceptanceBytes,
      devices,
    });
  } finally {
    acceptanceBytes.fill(0);
    trust.acceptance.participantDigest.fill(0);
    trust.acceptance.targetSubmissionDigest.fill(0);
    trust.acceptance.deviceInventoryDigest.fill(0);
    trust.acceptance.signature.fill(0);
    trust.devices.forEach((entry) => entry.signingPublicKey.fill(0));
  }
}

function reassembleDeviceTransferApproval(input: Readonly<{
  crypto: LatticeCrypto;
  operationId: string;
  recipientDeviceId: string;
  messages: readonly Readonly<{ payloadBytes: Uint8Array }>[];
}>): Uint8Array {
  const chunks = input.messages.map((message) =>
    decodeOpaqueDeliveryArtifactChunk(message.payloadBytes, input.crypto)
  );
  try {
    if (chunks.some((chunk) =>
      chunk.kind !== "device_transfer"
      || chunk.operationId !== input.operationId
      || chunk.recipientDeviceId !== input.recipientDeviceId
    )) throw new TypeError("Additional-device approval delivery was substituted");
    return reassembleOpaqueDeliveryArtifact({ crypto: input.crypto, chunks });
  } finally {
    chunks.forEach((chunk) => {
      chunk.artifactHash.fill(0);
      chunk.payloadBytes.fill(0);
      chunk.chunkHash.fill(0);
    });
  }
}

/** Platform stores must seal records and compare complete canonical bytes. */
export interface PendingAdditionalDeviceClientStateVault {
  load(idempotencyKey: string): Promise<PendingAdditionalDeviceClientState | null>;
  create(value: PendingAdditionalDeviceClientState): Promise<
    "inserted" | "exact_duplicate" | "collision"
  >;
  compareAndSwap(input: Readonly<{
    expected: PendingAdditionalDeviceClientState;
    replacement: PendingAdditionalDeviceClientState;
  }>): Promise<boolean>;
  removeExact(value: PendingAdditionalDeviceClientState): Promise<boolean>;
}

export type AdditionalDeviceTargetProgress =
  | Readonly<{
    status: "waiting_for_approval" | "syncing";
    operationId: string;
    coordinates: ClientProfileCoordinates;
    verificationCode: string;
    syncReason?: AdditionalDeviceSyncReason;
  }>
  | Readonly<{
    status: "active";
    operationId: string;
    coordinates: ClientProfileCoordinates;
    deviceRevision: number;
  }>;

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) {
    throw new TypeError("Additional-device bytes are not canonical base64url");
  }
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  const result = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0)
  );
  if (encode(result) !== value) {
    result.fill(0);
    throw new TypeError("Additional-device bytes are not canonical base64url");
  }
  return result;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function exactCoordinates(input: Readonly<{
  serverScope: string;
  userId: string;
  humanActorId: string;
  deviceId: string;
  installationLineageDigest: Uint8Array;
}>): ClientProfileCoordinates {
  return Object.freeze({
    serverScope: input.serverScope,
    userId: input.userId,
    humanActorId: input.humanActorId,
    profileId: input.deviceId,
    deviceId: input.deviceId,
    installationLineageDigest: hex(input.installationLineageDigest),
  });
}

export function deriveAdditionalDeviceClientIdentity(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  serverScope: string;
  userId: string;
  humanActorId: string;
  installationId: string;
  clientKind: "browser" | "electron";
}>): Readonly<{
  coordinates: ClientProfileCoordinates;
  installationLineageDigest: Uint8Array;
  idempotencyKey: string;
}> {
  if (input.installationId.length < 1 || input.installationId.length > 64
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.installationId)) {
    throw new TypeError("Crypto installation identity is invalid");
  }
  const bytes = new TextEncoder().encode([
    "nautilo/client-installation-account/v1",
    input.clientKind,
    input.serverScope,
    input.userId,
    input.humanActorId,
    input.installationId,
  ].join("\0"));
  const installationLineageDigest = input.crypto.hash(bytes);
  bytes.fill(0);
  const identity = hex(installationLineageDigest);
  const deviceId = `crypto:${input.clientKind}:${identity}`;
  return Object.freeze({
    coordinates: exactCoordinates({
      ...input,
      deviceId,
      installationLineageDigest,
    }),
    installationLineageDigest,
    idempotencyKey: `additional-device:${input.clientKind}:${identity}`,
  });
}

function encodeJoinPackage(
  value: DeviceJoinPackageEnvelope,
): EncodedDeviceJoinPackage {
  return Object.freeze({
    formatVersion: 1,
    providerId: value.providerId,
    domainId: value.domainId,
    humanId: value.humanId,
    deviceId: value.deviceId,
    expectedEpoch: value.expectedEpoch,
    expectedProviderHeadHashBase64url:
      encode(value.expectedProviderHeadHash),
    generation: 1,
    packageId: value.packageId,
    packageHashBase64url: encode(value.packageHash),
    keyPackageBytesBase64url: encode(value.keyPackageBytes),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    signatureBase64url: encode(value.signature),
  });
}

function pendingEnrollment(
  plan: ProtectedAdditionalDevicePlanV1,
): PendingAdditionalDeviceEnrollment {
  const value = plan.enrollment;
  return Object.freeze({
    formatVersion: 1,
    operationId: value.operationId,
    challengeId: value.challengeId,
    userId: value.userId as never,
    humanActorId: value.humanActorId as never,
    deviceId: value.deviceId,
    clientKind: value.clientKind,
    installationLineageDigest:
      decode(value.installationLineageDigestBase64url),
    deviceGeneration: 1,
    signingPublicKey: decode(value.signingPublicKeyBase64url),
    encryptionPublicKey: decode(value.encryptionPublicKeyBase64url),
    method: "device_approval",
    idempotencyKey: value.idempotencyKey,
    authorizationEvidenceDigest:
      decode(value.authorizationEvidenceDigestBase64url),
    authorizationDigest: decode(value.authorizationDigestBase64url),
    expectedCustodyRevision: value.expectedCustodyRevision,
    expectedRecoveryGeneration: value.expectedRecoveryGeneration,
    inventoryRevision: value.inventoryRevision as never,
    inventoryCount: value.inventoryCount,
    inventoryDigest: decode(value.inventoryDigestBase64url),
    deviceRevision: 0,
    status: "pending",
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function destroyPendingEnrollment(value: PendingAdditionalDeviceEnrollment): void {
  value.installationLineageDigest.fill(0);
  value.signingPublicKey.fill(0);
  value.encryptionPublicKey.fill(0);
  value.authorizationEvidenceDigest.fill(0);
  value.authorizationDigest.fill(0);
  value.inventoryDigest.fill(0);
}

function destroyPendingAdditionalDeviceClientState(
  value: PendingAdditionalDeviceClientState | null,
): void {
  if (value === null) return;
  value.installationLineageDigest.fill(0);
  value.profileBytes.fill(0);
  for (const join of value.joins) {
    join.expectedHead.stateHash.fill(0);
    join.localState.ciphertext.fill(0);
  }
}

function clonePendingAdditionalDeviceClientState(
  value: PendingAdditionalDeviceClientState,
): PendingAdditionalDeviceClientState {
  const encoded = encodePendingState(value);
  try {
    return decodePendingState(encoded);
  } finally {
    encoded.fill(0);
  }
}

export function restartPendingAdditionalDeviceAttempt(
  value: PendingAdditionalDeviceClientState,
): PendingAdditionalDeviceClientState {
  return Object.freeze({
    formatVersion: 1,
    revision: 1,
    idempotencyKey: value.idempotencyKey,
    coordinates: value.coordinates,
    clientKind: value.clientKind,
    installationLineageDigest: value.installationLineageDigest.slice(),
    profileBytes: value.profileBytes.slice(),
    operationId: null,
    joins: Object.freeze([]),
  });
}

async function prepareBase(input: Readonly<{
  crypto: LatticeCrypto;
  idempotencyKey: string;
  serverScope: string;
  userId: string;
  humanActorId: string;
  deviceId: string;
  clientKind: "browser" | "electron";
  installationLineageDigest: Uint8Array;
}>): Promise<PendingAdditionalDeviceClientState> {
  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  let v1: Uint8Array | undefined;
  let candidate: Awaited<ReturnType<
    typeof createClientDeviceProfileV4Candidate
  >> | undefined;
  let profileBytes: Uint8Array | undefined;
  try {
    v1 = encodeClientDeviceProfileV1({
      deviceId: input.deviceId,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
    });
    candidate = await createClientDeviceProfileV4Candidate({
      crypto: input.crypto,
      currentProfileBytes: v1,
      expectedDeviceId: input.deviceId,
      v1Migration: {
        trustedDeviceRevision: 0,
        trustedHostAuthorizationRevision: 0,
        deliveryHighWatermark: 0,
      },
    });
    profileBytes = encodeClientDeviceProfileV4(candidate);
    return Object.freeze({
      formatVersion: 1,
      revision: 1,
      idempotencyKey: input.idempotencyKey,
      coordinates: exactCoordinates(input),
      clientKind: input.clientKind,
      installationLineageDigest: input.installationLineageDigest.slice(),
      profileBytes: profileBytes.slice(),
      operationId: null,
      joins: Object.freeze([]),
    });
  } finally {
    v1?.fill(0);
    profileBytes?.fill(0);
    if (candidate) destroyOpenedClientDeviceProfileV4(candidate);
    signing.privateKey.fill(0);
    encryption.privateKey.fill(0);
  }
}

function beginRequest(
  state: PendingAdditionalDeviceClientState,
  profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
): ProtectedAdditionalDeviceBeginRequestV2 {
  const base = profile.baseProfile.baseProfile;
  return {
    requestVersion: 2,
    deviceId: state.coordinates.deviceId,
    clientKind: state.clientKind,
    installationLineageDigestBase64url:
      encode(state.installationLineageDigest),
    deviceGeneration: 1,
    signingPublicKeyBase64url: encode(base.signingPublicKey),
    encryptionPublicKeyBase64url: encode(base.encryptionPublicKey),
    idempotencyKey: state.idempotencyKey,
    pageStart: 0,
  };
}

function verifyPlanPage(
  crypto: LatticeCrypto,
  page: ProtectedAdditionalDevicePlanV2,
): void {
  const binding = new TextEncoder().encode(JSON.stringify({
    operationId: page.enrollment.operationId,
    targetDeviceId: page.enrollment.deviceId,
    inventoryRevision: page.enrollment.inventoryRevision,
    inventoryCount: page.enrollment.inventoryCount,
    inventoryDigestBase64url: page.enrollment.inventoryDigestBase64url,
    domainCount: page.domainCount,
    approver: page.approver,
    personalAuthority: page.personalAuthority,
    start: page.page.start,
    end: page.page.end,
    domains: page.domains,
  }));
  const digest = crypto.hash(binding);
  try {
    if (encode(digest) !== page.page.pageDigestBase64url) {
      throw new TypeError("Additional-device plan page digest was substituted");
    }
  } finally {
    binding.fill(0);
    digest.fill(0);
  }
}

function assemblePersistedPlan(input: Readonly<{
  crypto: LatticeCrypto;
  pages: readonly ProtectedAdditionalDevicePlanV2[];
}>): CompleteAdditionalDevicePlan {
  const first = input.pages[0];
  if (first === undefined) throw new TypeError("Additional-device plan is empty");
  let expectedStart = 0;
  for (const page of input.pages) {
    verifyPlanPage(input.crypto, page);
    if (
      page.enrollment.operationId !== first.enrollment.operationId
      || page.enrollment.deviceId !== first.enrollment.deviceId
      || page.enrollment.inventoryRevision !== first.enrollment.inventoryRevision
      || page.enrollment.inventoryCount !== first.enrollment.inventoryCount
      || page.enrollment.inventoryDigestBase64url
        !== first.enrollment.inventoryDigestBase64url
      || page.domainCount !== first.domainCount
      || JSON.stringify(page.personalAuthority)
        !== JSON.stringify(first.personalAuthority)
      || page.page.start !== expectedStart
      || page.approver.deviceId !== first.approver.deviceId
      || page.approver.signingPublicKeyBase64url
        !== first.approver.signingPublicKeyBase64url
    ) throw new TypeError("Additional-device plan page was substituted");
    expectedStart = page.page.end;
  }
  if (input.pages.at(-1)!.page.nextStart !== null) {
    throw new TypeError("Additional-device plan inventory is incomplete");
  }
  const domains = input.pages.flatMap((page) => page.domains);
  if (
    domains.length !== first.domainCount
    || domains.some((domain, index) =>
      index > 0 && domains[index - 1]!.domainId >= domain.domainId
    )
  ) throw new TypeError("Additional-device plan inventory is incomplete");
  return Object.freeze({
    formatVersion: 1 as const,
    ...(first.progress === undefined ? {} : { progress: first.progress }),
    enrollment: first.enrollment,
    approver: first.approver,
    personalAuthority: first.personalAuthority,
    domains,
  });
}

async function assemblePlanWithPages(input: Readonly<{
  crypto: LatticeCrypto;
  api: AdditionalDeviceClientApiPort;
  deviceId: string;
  first: ProtectedAdditionalDevicePlanV2;
}>): Promise<Readonly<{
  plan: CompleteAdditionalDevicePlan;
  pages: readonly ProtectedAdditionalDevicePlanV2[];
}>> {
  const pages: ProtectedAdditionalDevicePlanV2[] = [input.first];
  let next = input.first.page.nextStart;
  while (next !== null) {
    const page = await input.api.loadProtectedAdditionalDevicePlanPageV2(
      input.first.enrollment.operationId,
      { requestVersion: 2, deviceId: input.deviceId, pageStart: next },
    );
    verifyPlanPage(input.crypto, page);
    if (page.page.start !== next) {
      throw new TypeError("Additional-device plan page was substituted");
    }
    pages.push(page);
    next = page.page.nextStart;
  }
  return Object.freeze({
    plan: assemblePersistedPlan({ crypto: input.crypto, pages }),
    pages: Object.freeze(pages),
  });
}

async function assemblePlan(input: Parameters<typeof assemblePlanWithPages>[0]) {
  return (await assemblePlanWithPages(input)).plan;
}

async function addJoins(input: Readonly<{
  crypto: LatticeCrypto;
  state: PendingAdditionalDeviceClientState;
  plan: ProtectedAdditionalDevicePlanV1;
  now: number;
}>): Promise<PendingAdditionalDeviceClientState> {
  const profile = await authenticateClientDeviceProfileV4({
    crypto: input.crypto,
    profileBytes: input.state.profileBytes,
    expectedDeviceId: input.state.coordinates.deviceId,
  });
  const joins: PendingAdditionalDeviceJoinState[] = [];
  try {
    if (input.plan.domains.length > 256) {
      throw new RangeError("Additional-device Domain inventory is out of bounds");
    }
    for (const domain of input.plan.domains) {
      const expectedHead = Object.freeze({
        providerId: domain.expectedHead.providerId,
        domainId: cryptoDomainId(domain.expectedHead.domainId),
        epoch: domainEpoch(domain.expectedHead.epoch),
        stateHash: decode(domain.expectedHead.stateHashBase64url),
      });
      const providerVault = DeviceProviderStateVault.fromKey(
        input.crypto,
        cryptoDeviceId(input.state.coordinates.deviceId),
        profile.baseProfile.providerStateSealingKey,
      );
      try {
        const provider = new OpenMlsGroupProvider(input.crypto, providerVault);
        await provider.initialize();
        const join = await provider.createJoinRequest({
          domainId: expectedHead.domainId,
          humanId: input.plan.enrollment.humanActorId as never,
          expectedHead,
        });
        const envelope = createDeviceJoinPackage({
          crypto: input.crypto,
          request: join.publicResult,
          generation: 1,
          packageId: deriveAdditionalDeviceJoinPackageId({
            crypto: input.crypto,
            operationId: input.plan.enrollment.operationId,
            domainId: domain.domainId,
          }),
          createdAt: input.now,
          expiresAt: input.now + DEVICE_JOIN_PACKAGE_TTL_MS,
          signingPrivateKey:
            profile.baseProfile.baseProfile.signingPrivateKey,
        });
        joins.push(Object.freeze({
          domainId: domain.domainId,
          expectedHead,
          localState: join.localState,
          package: encodeJoinPackage(envelope),
        }));
      } finally {
        providerVault.destroy();
      }
    }
    return Object.freeze({
      ...input.state,
      revision: 2 as const,
      operationId: input.plan.enrollment.operationId,
      joins: Object.freeze(joins),
    });
  } catch (error) {
    for (const join of joins) {
      join.expectedHead.stateHash.fill(0);
      join.localState.ciphertext.fill(0);
    }
    throw error;
  } finally {
    destroyOpenedClientDeviceProfileV4(profile);
  }
}

async function activateResumedAdditionalDeviceProfile(input: Readonly<{
  crypto: LatticeCrypto;
  profileVault: ClientProfileVault;
  state: PendingAdditionalDeviceClientState;
  operationId: string;
  deviceRevision: number;
}>): Promise<void> {
  const sameCoordinates = (candidate: ClientProfileCoordinates) =>
    candidate.serverScope === input.state.coordinates.serverScope
    && candidate.userId === input.state.coordinates.userId
    && candidate.humanActorId === input.state.coordinates.humanActorId
    && candidate.profileId === input.state.coordinates.profileId
    && candidate.deviceId === input.state.coordinates.deviceId
    && candidate.installationLineageDigest
      === input.state.coordinates.installationLineageDigest;
  const profiles = (await input.profileVault.listPublicProfiles()).filter(
    (candidate) => sameCoordinates(candidate.coordinates),
  );
  const active = profiles.filter((candidate) =>
    candidate.lifecycle === "active"
  );
  const staged = profiles.filter((candidate) =>
    candidate.lifecycle === "staged"
    && candidate.stageId === input.operationId
  );
  if (active.length > 1 || staged.length > 1) {
    throw new Error("Additional-device local profile custody is ambiguous");
  }
  const pending = await authenticateClientDeviceProfileV4({
    crypto: input.crypto,
    profileBytes: input.state.profileBytes,
    expectedDeviceId: input.state.coordinates.deviceId,
  });
  const verifyExactProfile = async (bytes: Uint8Array) => {
    const candidate = await authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes: bytes,
      expectedDeviceId: input.state.coordinates.deviceId,
    });
    try {
      if (
        !equalBytes(
          candidate.baseProfile.baseProfile.signingPublicKey,
          pending.baseProfile.baseProfile.signingPublicKey,
        )
        || !equalBytes(
          candidate.baseProfile.baseProfile.encryptionPublicKey,
          pending.baseProfile.baseProfile.encryptionPublicKey,
        )
      ) {
        throw new Error("Additional-device local profile identity was substituted");
      }
    } finally {
      destroyOpenedClientDeviceProfileV4(candidate);
    }
  };
  try {
    if (active.length === 0) {
      if (
        staged.length !== 1
        || input.profileVault.withOpenStagedProfile === undefined
      ) {
        throw new Error("Additional-device staged local profile is unavailable");
      }
      await input.profileVault.withOpenStagedProfile(
        input.state.coordinates,
        input.operationId,
        verifyExactProfile,
      );
      await input.profileVault.activateProfile(
        input.state.coordinates,
        input.operationId,
      );
    } else {
      await input.profileVault.withOpenProfile(
        input.state.coordinates,
        verifyExactProfile,
      );
    }
    await advanceAndActivateClientTrustedDeviceAuthorityRevision({
      crypto: input.crypto,
      vault: input.profileVault,
      coordinates: input.state.coordinates,
      trustedDeviceRevision: input.deviceRevision,
      createStageId: () => `${input.operationId}:authority`,
    });
  } finally {
    destroyOpenedClientDeviceProfileV4(pending);
  }
}

export function createAdditionalDeviceTargetClient(input: Readonly<{
  api: AdditionalDeviceClientApiPort;
  vault: PendingAdditionalDeviceClientStateVault;
  profileVault: ClientProfileVault;
  serverScope: string;
  userId: string;
  humanActorId: string;
  deviceId: string;
  clientKind: "browser" | "electron";
  installationLineageDigest: Uint8Array;
  idempotencyKey: string;
  transitionCampaignVault: AdditionalDeviceTransitionCampaignVault;
  personalAuthority?: Readonly<{
    ensure(anchor: NonNullable<
      ProtectedAdditionalDevicePlanV2["personalAuthority"]
    >): Promise<Readonly<{
      status: "ready" | "pending" | "unavailable";
    }>>;
  }>;
  crypto?: LatticeCrypto;
  now?(): number;
}>) {
  const crypto = input.crypto ?? new LatticeCrypto();
  const now = input.now ?? (() => Date.now());
  const targetPlans = createAdditionalDeviceTargetPlanJournal({
    vault: input.transitionCampaignVault,
    now,
  });

  async function unlockTargetPlans(): Promise<void> {
    const availability = await input.transitionCampaignVault.unlock();
    if (availability.status !== "available") {
      throw new Error(
        `Additional-device target plan custody is unavailable (${
          "reasonCode" in availability ? availability.reasonCode : availability.status
        })`,
      );
    }
  }

  async function removeTargetPlan(operationId: string): Promise<void> {
    const plan = (await targetPlans.list()).find((candidate) =>
      candidate.operationId === operationId
    );
    if (plan !== undefined && !await targetPlans.removeExact(plan)) {
      throw new Error("Additional-device target plan cleanup failed");
    }
  }

  async function ensurePersonalAuthority(
    plan: CompleteAdditionalDevicePlan,
  ): Promise<boolean> {
    if (plan.personalAuthority === null) return true;
    if (input.personalAuthority === undefined) return false;
    return (await input.personalAuthority.ensure(plan.personalAuthority)).status
      === "ready";
  }

  async function ensurePending(): Promise<PendingAdditionalDeviceClientState> {
    const existing = await input.vault.load(input.idempotencyKey);
    if (existing !== null) return existing;
    const candidate = await prepareBase({ crypto, ...input });
    const created = await input.vault.create(candidate);
    if (created === "collision") {
      destroyPendingAdditionalDeviceClientState(candidate);
      throw new Error("Additional-device pending custody collided");
    }
    if (created === "exact_duplicate") {
      destroyPendingAdditionalDeviceClientState(candidate);
      const reloaded = await input.vault.load(input.idempotencyKey);
      if (reloaded === null) throw new Error("Additional-device pending custody disappeared");
      return reloaded;
    }
    return candidate;
  }

  return Object.freeze({
    async hasPending(): Promise<boolean> {
      const state = await input.vault.load(input.idempotencyKey);
      try {
        return state !== null;
      } finally {
        if (state !== null) destroyPendingAdditionalDeviceClientState(state);
      }
    },
    async inspectPending(): Promise<Readonly<{
      status: "required" | "waiting_for_approval" | "syncing";
      operationId?: string;
      verificationCode?: string;
      syncReason?: AdditionalDeviceSyncReason;
    }> | null> {
      await unlockTargetPlans();
      const state = await input.vault.load(input.idempotencyKey);
      if (state === null) return null;
      try {
        if (state.revision === 3) {
          return Object.freeze({
            status: "syncing" as const,
            operationId: state.operationId!,
            verificationCode: state.syncVerificationCode!,
            ...(state.syncReason === undefined
              ? {}
              : { syncReason: state.syncReason }),
          });
        }
        if (state.revision === 2) {
          const plan = (await targetPlans.list()).find((candidate) =>
            candidate.operationId === state.operationId
          );
          return Object.freeze({
            status: "waiting_for_approval" as const,
            operationId: state.operationId!,
            ...(plan === undefined
              ? {}
              : { verificationCode: plan.verificationCode }),
          });
        }
        return Object.freeze({ status: "required" as const });
      } finally {
        destroyPendingAdditionalDeviceClientState(state);
      }
    },
    async continue(): Promise<AdditionalDeviceTargetProgress> {
      await unlockTargetPlans();
      let state = await ensurePending();
      let persistedState: PendingAdditionalDeviceClientState | null = null;
      try {
        if (state.revision === 3) {
          const activation = await input.api.activateProtectedAdditionalDevice(
            state.operationId!,
            { requestVersion: 1, deviceId: state.coordinates.deviceId },
          );
          if (activation.status !== "active") {
            const syncReason = activation.syncReason ?? "current_domain_sync_required";
            const replacement = state.syncReason === syncReason
              ? state
              : Object.freeze({
                ...state,
                syncReason,
              });
            if (replacement !== state
              && !await input.vault.compareAndSwap({
                expected: state,
                replacement,
              })) {
              throw new Error(
                "Additional-device synchronization state changed",
              );
            }
            return Object.freeze({
              status: "syncing" as const,
              operationId: state.operationId!,
              coordinates: state.coordinates,
              verificationCode: state.syncVerificationCode!,
              syncReason,
            });
          }
          const storedPlan = (await targetPlans.list()).find((candidate) =>
            candidate.operationId === state.operationId
          );
          if (storedPlan === undefined) {
            throw new Error("Additional-device personal authority plan disappeared");
          }
          const plan = await targetPlans.withPages(storedPlan, (pages) =>
            assemblePersistedPlan({ crypto, pages })
          );
          if (!await ensurePersonalAuthority(plan)) {
            const syncReason = "personal_authority_required" as const;
            const replacement = state.syncReason === syncReason
              ? state
              : Object.freeze({ ...state, syncReason });
            if (replacement !== state
              && !await input.vault.compareAndSwap({
                expected: state,
                replacement,
              })) {
              throw new Error(
                "Additional-device personal authority state changed",
              );
            }
            return Object.freeze({
              status: "syncing" as const,
              operationId: state.operationId!,
              coordinates: state.coordinates,
              verificationCode: state.syncVerificationCode!,
              syncReason,
            });
          }
          await removeTargetPlan(state.operationId!);
          if (!await input.vault.removeExact(state)) {
            throw new Error("Additional-device pending custody cleanup failed");
          }
          return Object.freeze({
            status: "active" as const,
            operationId: state.operationId!,
            coordinates: state.coordinates,
            deviceRevision: activation.deviceRevision!,
          });
        }
        const profile = await authenticateClientDeviceProfileV4({
          crypto,
          profileBytes: state.profileBytes,
          expectedDeviceId: input.deviceId,
        });
        let plan: CompleteAdditionalDevicePlan;
        let verificationCode: string;
        let targetPlanIndex: AdditionalDeviceTargetPlanIndex;
        let preservedFrozenPlanAfterRefreshFailure = false;
        let activation: Awaited<ReturnType<
          AdditionalDeviceClientApiPort["activateProtectedAdditionalDevice"]
        >> | undefined;
        try {
          const beginAndPersistPlan = async () => {
            const first = await input.api.beginProtectedAdditionalDeviceV2(
              beginRequest(state, profile),
            );
            const assembled = await assemblePlanWithPages({
              crypto,
              api: input.api,
              deviceId: state.coordinates.deviceId,
              first,
            });
            const freshPlan = assembled.plan;
            assertTargetPlan({ plan: freshPlan, state, profile });
            const approver = plannedApprover({ plan: freshPlan });
            let freshVerificationCode: string;
            try {
              freshVerificationCode = deriveAdditionalDeviceVerificationCode({
                crypto,
                operationId: freshPlan.enrollment.operationId,
                humanId: freshPlan.enrollment.humanActorId,
                targetDeviceId: freshPlan.enrollment.deviceId,
                targetSigningPublicKey:
                  profile.baseProfile.baseProfile.signingPublicKey,
                approverDeviceId: approver.deviceId,
                approverSigningPublicKey: approver.signingPublicKey,
              });
            } finally {
              approver.signingPublicKey.fill(0);
            }
            const freshIndex = await targetPlans.putBeforeMutation({
              operationId: freshPlan.enrollment.operationId,
              targetDeviceId: freshPlan.enrollment.deviceId,
              verificationCode: freshVerificationCode,
              pages: assembled.pages,
            });
            return Object.freeze({
              plan: freshPlan,
              verificationCode: freshVerificationCode,
              targetPlanIndex: freshIndex,
            });
          };
          const storedPlan = (await targetPlans.list()).find((candidate) =>
            candidate.targetDeviceId === state.coordinates.deviceId
            && (state.operationId === null
              || candidate.operationId === state.operationId)
          );
          if (
            storedPlan !== undefined
            && storedPlan.deliveryHighWatermark !== null
          ) {
            // Once a delivery manifest is durable, it is the target's recovery
            // anchor for replaying or finalizing an already-staged profile.
            // Replacing it with a fresh transport plan would forget which
            // ciphertexts were verified and acknowledged.
            targetPlanIndex = storedPlan;
            plan = await targetPlans.withPages(storedPlan, (pages) =>
              assemblePersistedPlan({ crypto, pages })
            );
            verificationCode = storedPlan.verificationCode;
          } else {
            // A pending operation may outlive its comparison challenge or its
            // exact Domain inventory. Re-read the idempotent server plan on
            // every pristine continuation. Do not discard the frozen plan
            // first: after the approver commits a populated Domain transition,
            // current server heads intentionally differ from the enrollment
            // inventory and cannot reconstruct the original signed campaign.
            try {
              const fresh = await beginAndPersistPlan();
              plan = fresh.plan;
              verificationCode = fresh.verificationCode;
              targetPlanIndex = fresh.targetPlanIndex;
              if (
                storedPlan !== undefined
                && storedPlan.operationId !== targetPlanIndex.operationId
              ) {
                await removeTargetPlan(storedPlan.operationId);
              }
            } catch (error) {
              if (storedPlan === undefined || state.revision === 1) throw error;
              targetPlanIndex = storedPlan;
              plan = await targetPlans.withPages(storedPlan, (pages) =>
                assemblePersistedPlan({ crypto, pages })
              );
              verificationCode = storedPlan.verificationCode;
              preservedFrozenPlanAfterRefreshFailure = true;
            }
          }
          assertTargetPlan({ plan, state, profile });
          const approver = plannedApprover({ plan });
          try {
            const expectedVerificationCode = deriveAdditionalDeviceVerificationCode({
              crypto,
              operationId: plan.enrollment.operationId,
              humanId: plan.enrollment.humanActorId,
              targetDeviceId: plan.enrollment.deviceId,
              targetSigningPublicKey:
                profile.baseProfile.baseProfile.signingPublicKey,
              approverDeviceId: approver.deviceId,
              approverSigningPublicKey: approver.signingPublicKey,
            });
            if (
              verificationCode !== expectedVerificationCode
              || targetPlanIndex.operationId !== plan.enrollment.operationId
            ) throw new TypeError("Additional-device target plan was substituted");
          } finally {
            approver.signingPublicKey.fill(0);
          }
        } finally {
          destroyOpenedClientDeviceProfileV4(profile);
        }
        const attemptNow = now();
        if (
          state.revision === 2
          && (
            state.operationId !== plan.enrollment.operationId
            || state.joins.length !== plan.domains.length
            || state.joins.some((join, index) =>
              join.domainId !== plan.domains[index]?.domainId
            )
            || (!preservedFrozenPlanAfterRefreshFailure
              && state.joins.some((join) =>
                join.package.expiresAt <= attemptNow
              ))
          )
        ) {
          const replacement = restartPendingAdditionalDeviceAttempt(state);
          if (!await input.vault.compareAndSwap({ expected: state, replacement })) {
            destroyPendingAdditionalDeviceClientState(replacement);
            destroyPendingAdditionalDeviceClientState(state);
            state = await input.vault.load(input.idempotencyKey) as
              PendingAdditionalDeviceClientState;
            if (state === null) {
              throw new Error("Additional-device pending custody disappeared");
            }
          } else {
            destroyPendingAdditionalDeviceClientState(state);
            state = replacement;
          }
        }
        if (state.revision === 1) {
          const replacement = await addJoins({
            crypto,
            state,
            plan,
            now: attemptNow,
          });
          if (!await input.vault.compareAndSwap({ expected: state, replacement })) {
            destroyPendingAdditionalDeviceClientState(replacement);
            destroyPendingAdditionalDeviceClientState(state);
            state = await input.vault.load(input.idempotencyKey) as
              PendingAdditionalDeviceClientState;
            if (state === null || state.revision !== 2) {
              throw new Error("Additional-device pending custody changed concurrently");
            }
          } else {
            destroyPendingAdditionalDeviceClientState(state);
            state = replacement;
          }
        }
        if (state.operationId !== plan.enrollment.operationId) {
          throw new TypeError("Additional-device operation was substituted");
        }
        try {
          const starts = state.joins.length === 0
            ? [0]
            : Array.from(
              { length: Math.ceil(
                state.joins.length
                  / PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE,
              ) },
              (_, index) =>
                index * PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE,
            );
          for (const start of starts) {
            await input.api.publishProtectedAdditionalDeviceJoinPackagesV2(
              state.operationId,
              {
                requestVersion: 2,
                deviceId: state.coordinates.deviceId,
                packages: state.joins.slice(
                  start,
                  start + PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE,
                ).map((join) => join.package),
              },
            );
          }
        } catch {
          // The server may have durably activated the device while the client
          // lost that response. In that case join publication is no longer an
          // admissible step, but exact activation replay is: use it to finish
          // local profile activation and pending-custody cleanup.
          try {
            activation = await input.api.activateProtectedAdditionalDevice(
              state.operationId,
              { requestVersion: 1, deviceId: state.coordinates.deviceId },
            );
          } catch (error) {
            // Production intentionally rejects activation before the existing
            // device has approved and admitted the target. That is the normal
            // first half of the comparison-code ceremony, not a failed setup.
            if (
              error instanceof Error
              && error.message === "additional_device_activation_unavailable"
            ) {
              return Object.freeze({
                status: "waiting_for_approval" as const,
                operationId: state.operationId,
                coordinates: state.coordinates,
                verificationCode,
              });
            }
            throw error;
          }
          if (activation.status !== "active") {
            return Object.freeze({
              status: "waiting_for_approval" as const,
              operationId: state.operationId,
              coordinates: state.coordinates,
              verificationCode,
            });
          }
        }
        // OpenMLS is allowed to consume or wipe the in-memory join state while
        // staging the target profile. Keep an owned snapshot of the exact
        // persisted revision for the final pending-vault compare-and-swap.
        persistedState = clonePendingAdditionalDeviceClientState(state);
        let localTransferStaged = false;
        activation ??= await input.api.activateProtectedAdditionalDevice(
          state.operationId,
          { requestVersion: 1, deviceId: state.coordinates.deviceId },
        );
        if (activation.status !== "active") {
          const staged = (await input.profileVault.listPublicProfiles()).find(
            (candidate) => candidate.lifecycle === "staged"
              && candidate.stageId === state.operationId
              && candidate.coordinates.deviceId === state.coordinates.deviceId,
          );
          if (staged !== undefined && targetPlanIndex.deliveryManifest.length === 0) {
            // The profile was staged before the delivery manifest became
            // durable, therefore no acknowledgement could have been sent.
            // Discard that orphan and rebuild from the still-complete queue.
            await input.profileVault.abortStagedProfile(
              state.coordinates,
              state.operationId,
            );
          } else if (staged !== undefined) {
            if (
              input.profileVault.withOpenStagedProfile === undefined
              || targetPlanIndex.deliveryHighWatermark === null
            ) throw new Error("Additional-device staged transfer is unavailable");
            await input.profileVault.withOpenStagedProfile(
              state.coordinates,
              state.operationId,
              async (stagedBytes) => {
                const stagedProfile = await authenticateClientDeviceProfileV4({
                  crypto,
                  profileBytes: stagedBytes,
                  expectedDeviceId: state.coordinates.deviceId,
                });
                try {
                  if (
                    stagedProfile.baseProfile.baseProfile.deliveryHighWatermark
                      !== targetPlanIndex.deliveryHighWatermark
                  ) throw new Error("Additional-device staged delivery watermark disagrees");
                } finally {
                  destroyOpenedClientDeviceProfileV4(stagedProfile);
                }
              },
            );
            const pendingProfile = await authenticateClientDeviceProfileV4({
              crypto,
              profileBytes: state.profileBytes,
              expectedDeviceId: state.coordinates.deviceId,
            });
            try {
              const issuedAt = now();
              const fetchProof = createDeviceDeliveryFetchProof({
                crypto,
                requestId: state.operationId,
                humanId: humanId(input.humanActorId),
                deviceId: cryptoDeviceId(input.deviceId),
                expectedDeviceRevision: activation.deviceRevision!,
                minimumHighWatermark:
                  pendingProfile.baseProfile.baseProfile.deliveryHighWatermark,
                maximumMessages: DEVICE_DELIVERY_FETCH_MAX_MESSAGES,
                maximumPayloadBytes: DEVICE_DELIVERY_FETCH_MAX_PAYLOAD_BYTES,
                issuedAt,
                expiresAt: issuedAt + DEVICE_DELIVERY_FETCH_PROOF_TTL_MS,
                signingPrivateKey:
                  pendingProfile.baseProfile.baseProfile.signingPrivateKey,
              });
              const delivery = await input.api.loadProtectedAdditionalDeviceDeliveries(
                state.operationId,
                {
                  requestVersion: 1,
                  requestId: fetchProof.requestId,
                  humanId: fetchProof.humanId,
                  deviceId: fetchProof.deviceId,
                  expectedDeviceRevision: fetchProof.expectedDeviceRevision,
                  minimumHighWatermark: fetchProof.minimumHighWatermark,
                  maximumMessages: fetchProof.maximumMessages,
                  maximumPayloadBytes: fetchProof.maximumPayloadBytes,
                  issuedAt: fetchProof.issuedAt,
                  expiresAt: fetchProof.expiresAt,
                  signatureBase64url: encode(fetchProof.signature),
                },
              );
              if (delivery.highWatermark !== targetPlanIndex.deliveryHighWatermark) {
                throw new Error("Additional-device delivery set changed after staging");
              }
              const manifest = new Map(targetPlanIndex.deliveryManifest.map(
                (message) => [message.messageId, message],
              ));
              let processedRevision = activation.deviceRevision!;
              for (const message of delivery.messages) {
                const expected = manifest.get(message.messageId);
                const payloadHash = decode(message.payloadHashBase64url);
                const payloadBytes = decode(message.payloadBytesBase64url);
                try {
                  const observedHash = crypto.hash(payloadBytes);
                  try {
                    if (
                      message.operationId !== state.operationId
                      || expected === undefined
                      || expected.recipientSequence !== message.recipientSequence
                      || expected.payloadHashBase64url
                        !== message.payloadHashBase64url
                      || !equalBytes(observedHash, payloadHash)
                    ) throw new Error("Additional-device delivery changed after staging");
                  } finally {
                    observedHash.fill(0);
                  }
                  const proof = createDeliveryAcknowledgementProof({
                    crypto,
                    message: {
                      messageId: message.messageId,
                      recipientDeviceId: input.deviceId,
                      recipientSequence: message.recipientSequence,
                      payloadHash,
                    },
                    processedRevision: ++processedRevision,
                    acknowledgedAt: now(),
                    signingPrivateKey:
                      pendingProfile.baseProfile.baseProfile.signingPrivateKey,
                  });
                  try {
                    await input.api.acknowledgeProtectedAdditionalDeviceDelivery(
                      state.operationId,
                      {
                        requestVersion: 1,
                        deviceId: proof.deviceId,
                        messageId: proof.messageId,
                        recipientSequence: proof.recipientSequence,
                        payloadHashBase64url: encode(proof.payloadHash),
                        processedRevision: proof.processedRevision,
                        acknowledgedAt: proof.acknowledgedAt,
                        acknowledgementDigestBase64url: encode(
                          deliveryAcknowledgementDigest(crypto, proof),
                        ),
                        signatureBase64url: encode(proof.signature),
                      },
                    );
                  } finally {
                    proof.payloadHash.fill(0);
                    proof.signature.fill(0);
                  }
                } finally {
                  payloadHash.fill(0);
                  payloadBytes.fill(0);
                }
              }
              activation = await input.api.activateProtectedAdditionalDevice(
                state.operationId,
                { requestVersion: 1, deviceId: state.coordinates.deviceId },
              );
              localTransferStaged = true;
            } finally {
              destroyOpenedClientDeviceProfileV4(pendingProfile);
            }
          }
        }
        if (activation.status !== "active" && !localTransferStaged) {
          const profile = await authenticateClientDeviceProfileV4({
            crypto,
            profileBytes: state.profileBytes,
            expectedDeviceId: state.coordinates.deviceId,
          });
          let candidateV3: Awaited<ReturnType<
            typeof updateClientDeviceProfileV3
          >> | undefined;
          let workingV3: Awaited<ReturnType<
            typeof updateClientDeviceProfileV3
          >> | undefined;
          let deliveredBase: Awaited<ReturnType<
            typeof ingestClientKeyringDeliveryHistory
          >> | undefined;
          let candidateV4: Awaited<ReturnType<
            typeof updateClientDeviceProfileV4
          >> | undefined;
          let candidateWithDomainEvidence: Awaited<ReturnType<
            typeof addAdditionalDeviceDomainSignerEvidenceV4
          >> | undefined;
          let candidateWithSignerEvidence: Awaited<ReturnType<
            typeof addClientHumanDeviceTransferSignerEvidenceV4
          >> | undefined;
          let candidateBytes: Uint8Array | undefined;
          let transferApprovalBytes: Uint8Array | undefined;
          let committerKeys: Map<string, Uint8Array> | undefined;
          let approverSigningPublicKey: Uint8Array | undefined;
          const domainTrustFacts: Array<{
            domainId: string;
            domainEpoch: number;
            participantDigest: Uint8Array;
            providerTransitionDigest: Uint8Array;
            peerDeviceId: string;
            peerSigningPublicKey: Uint8Array;
          }> = [];
          try {
            const issuedAt = now();
            const fetchProof = createDeviceDeliveryFetchProof({
              crypto,
              requestId: state.operationId,
              humanId: humanId(input.humanActorId),
              deviceId: cryptoDeviceId(input.deviceId),
              expectedDeviceRevision: activation.deviceRevision!,
              minimumHighWatermark:
                profile.baseProfile.baseProfile.deliveryHighWatermark,
              maximumMessages: DEVICE_DELIVERY_FETCH_MAX_MESSAGES,
              maximumPayloadBytes: DEVICE_DELIVERY_FETCH_MAX_PAYLOAD_BYTES,
              issuedAt,
              expiresAt: issuedAt + DEVICE_DELIVERY_FETCH_PROOF_TTL_MS,
              signingPrivateKey:
                profile.baseProfile.baseProfile.signingPrivateKey,
            });
            const delivery = await input.api.loadProtectedAdditionalDeviceDeliveries(
              state.operationId,
              {
                requestVersion: 1,
                requestId: fetchProof.requestId,
                humanId: fetchProof.humanId,
                deviceId: fetchProof.deviceId,
                expectedDeviceRevision: fetchProof.expectedDeviceRevision,
                minimumHighWatermark: fetchProof.minimumHighWatermark,
                maximumMessages: fetchProof.maximumMessages,
                maximumPayloadBytes: fetchProof.maximumPayloadBytes,
                issuedAt: fetchProof.issuedAt,
                expiresAt: fetchProof.expiresAt,
                signatureBase64url: encode(fetchProof.signature),
              },
            );
            if (delivery.messages.length === 0) {
              return Object.freeze({
                status: "syncing" as const,
                operationId: state.operationId,
                coordinates: state.coordinates,
                verificationCode,
              });
            }
            if (
              delivery.messages.at(-1)!.recipientSequence
                !== delivery.highWatermark
            ) throw new Error("Additional-device delivery set exceeds its complete bound");
            const messages = delivery.messages.map((message) => ({
              ...message,
              payloadHash: decode(message.payloadHashBase64url),
              payloadBytes: decode(message.payloadBytesBase64url),
            }));
            const publicMessages = messages.filter((message) =>
              message.kind === "public_state"
            );
            const transferMessages = messages.filter((message) =>
              message.kind === "device_transfer"
            ).map((message) => ({
              messageId: message.messageId,
              operationId: message.operationId,
              recipientSequence: message.recipientSequence,
              kind: "device_transfer" as const,
              formatVersion: 1 as const,
              payloadHash: message.payloadHash,
              payloadBytes: message.payloadBytes,
              createdAt: message.createdAt,
              expiresAt: message.expiresAt,
            }));
            const missingDomainPublicState = plan.domains.some((domain) =>
              !publicMessages.some((message) =>
                message.domainId === domain.domainId
              )
            );
            if (
              activation.syncReason === "delivery_pending"
              && (transferMessages.length < 1 || missingDomainPublicState)
            ) {
              return Object.freeze({
                status: "syncing" as const,
                operationId: state.operationId,
                coordinates: state.coordinates,
                verificationCode,
                syncReason: activation.syncReason,
              });
            }
            if (transferMessages.length < 1) {
              throw new Error("Additional-device keyring delivery is incomplete");
            }
            transferApprovalBytes = reassembleDeviceTransferApproval({
              crypto,
              operationId: state.operationId,
              recipientDeviceId: input.deviceId,
              messages: transferMessages,
            });
            committerKeys = new Map(plan.domains.map((domain) => [
              domain.domainId,
              decode(domain.committerSigningPublicKeyBase64url),
            ]));
            approverSigningPublicKey = decode(
              plan.approver.signingPublicKeyBase64url,
            );
            const enrollment = pendingEnrollment(plan);
            try {
              deliveredBase = await ingestClientKeyringDeliveryHistory({
                crypto,
                profile: profile.baseProfile.baseProfile,
                serverHighWatermark: transferMessages.at(-1)!.recipientSequence,
                messages: transferMessages,
                resolveAuthority: () => ({
                  pendingDevice: {
                    humanId: humanId(enrollment.humanActorId),
                    deviceId: cryptoDeviceId(enrollment.deviceId),
                    pendingDeviceRevision: pendingDeviceRevisionV2(0),
                    signingPublicKey: enrollment.signingPublicKey,
                    encryptionPublicKey: enrollment.encryptionPublicKey,
                  },
                  resolveTrustedPendingDevice: () => ({
                    humanId: humanId(enrollment.humanActorId),
                    deviceId: cryptoDeviceId(enrollment.deviceId),
                    pendingDeviceRevision: pendingDeviceRevisionV2(0),
                    encryptionPublicKeyDigest:
                      crypto.hash(enrollment.encryptionPublicKey),
                    signingPublicKeyDigest:
                      crypto.hash(enrollment.signingPublicKey),
                    status: "pending" as const,
                  }),
                  expectedInventory: plan.domains.flatMap((domain) =>
                    domain.namespaces.flatMap((namespace) => {
                      const proof = namespace.bindingProofBytesBase64url.map(
                        (value) => parseNamespaceBindingV2(decode(value)),
                      );
                      const head = verifyNamespaceBindingProof({
                        crypto,
                        anchor: null,
                        proof,
                        resolveHistoricalCommitter: (context) => {
                          const planned = plan.domains.find((candidate) =>
                            candidate.domainId === context.domainId
                          );
                          return planned === undefined
                            ? null
                            : committerKeys!.get(planned.domainId) ?? null;
                        },
                      });
                      return ["ai", "human"].map((keyClass) => ({
                        authorizedHumanId: humanId(enrollment.humanActorId),
                        trustedNamespaceHead: head,
                        keyClass: keyClass as "ai" | "human",
                      }));
                    })
                  ),
                  expectedDomains: plan.domains.map((domain) => ({
                    domainId: cryptoDomainId(domain.domainId),
                    domainEpoch: domainEpoch(domain.expectedHead.epoch),
                  })),
                  resolveTrustedInventoryCommitment: () => ({
                    humanId: humanId(enrollment.humanActorId),
                    inventoryRevision: deviceTransferInventoryRevisionV2(
                      enrollment.inventoryRevision,
                    ),
                    inventoryCount: enrollment.inventoryCount,
                    inventoryDigest: enrollment.inventoryDigest,
                  }),
                  resolveCurrentApprover: (context) =>
                    context.issuerDeviceId === plan.approver.deviceId
                      ? approverSigningPublicKey!
                      : null,
                  resolveCurrentDomainCommitter: (context) => {
                    const domain = plan.domains.find((candidate) =>
                      candidate.domainId === context.domainId
                      && candidate.committerDeviceId === context.committerDeviceId
                    );
                    return domain === undefined ? null
                      : committerKeys!.get(domain.domainId) ?? null;
                  },
                }),
              });
            } finally {
              destroyPendingEnrollment(enrollment);
            }
            // Device-transfer messages are created by the active Browser, not
            // by the target. Rebuild their authority with the exact committer
            // key from the signed plan rather than the target enrollment key.
            if (plan.domains.length > 0 && publicMessages.length < 1) {
              throw new Error("Additional-device public-state delivery is incomplete");
            }
            workingV3 = await updateClientDeviceProfileV3({
              crypto,
              profile: profile.baseProfile,
              baseProfile: deliveredBase,
            });
            const refreshedKeyrings = [] as typeof deliveredBase.keyringDeliveries[number][];
            {
              for (const domain of plan.domains) {
                const domainMessages = publicMessages.filter((message) =>
                  message.domainId === domain.domainId
                );
                const chunks = domainMessages.map((message) =>
                  decodeOpaqueDeliveryArtifactChunk(message.payloadBytes, crypto)
                );
                const artifactBytes = reassembleOpaqueDeliveryArtifact({
                  crypto,
                  chunks,
                });
                try {
                  const artifact = decodeDomainTransitionDeliveryArtifact(
                    artifactBytes,
                  );
                  const committerKey = committerKeys.get(domain.domainId);
                  if (committerKey === undefined) {
                    throw new Error("Additional-device committer key is missing");
                  }
                  const participantDigest = decode(
                    domain.participantDigestBase64url,
                  );
                  const rosterBytes = decode(domain.rosterBytesBase64url);
                  const currentStateHash = decode(
                    domain.expectedHead.stateHashBase64url,
                  );
                  const expectedNamespaces = domain.namespaces.map((namespace) => ({
                    namespaceId: namespace.namespaceId,
                    expectedAccessRevision: namespace.accessRevision,
                    expectedBindingHash: decode(namespace.bindingHashBase64url),
                  }));
                  try {
                    const verifiedProvider = verifyProviderTransitionSubmission({
                      crypto,
                      submission: artifact.providerSubmission,
                      expectation: {
                        operationId: state.operationId,
                        operationKind: "device_add",
                        domainId: domain.domainId,
                        targetHumanId: input.humanActorId,
                        targetDeviceId: input.deviceId,
                        expectedEpoch: domain.expectedHead.epoch,
                        targetEpoch: domain.expectedHead.epoch + 1,
                        expectedAuthorizationRevision:
                          domain.authorizationRevision,
                        expectedParticipantDigest: participantDigest,
                        committerDeviceId: domain.committerDeviceId,
                      },
                      currentProviderState: {
                        head: {
                          providerId: domain.expectedHead.providerId,
                          domainId: cryptoDomainId(domain.domainId),
                          epoch: domainEpoch(domain.expectedHead.epoch),
                          stateHash: currentStateHash,
                        },
                        rosterBytes,
                      },
                      resolveActiveCommitter: (deviceId) =>
                        deviceId === domain.committerDeviceId
                          ? { state: "active", humanId: input.humanActorId,
                            signingPublicKey: committerKey }
                          : null,
                      recipientDeviceId: input.deviceId,
                    });
                    verifyNamespaceTransitionSubmission({
                      crypto,
                      submission: artifact.namespaceSubmission,
                      operationId: state.operationId,
                      domainPlan: {
                        domainId: domain.domainId,
                        expectedEpoch: domain.expectedHead.epoch,
                        targetEpoch: domain.expectedHead.epoch + 1,
                        expectedAuthorizationRevision:
                          domain.authorizationRevision,
                        expectedParticipantDigest: participantDigest,
                        committerDeviceId: domain.committerDeviceId,
                        namespaces: expectedNamespaces,
                      },
                      providerTransitionDigest:
                        verifiedProvider.transitionDigest,
                      resolveActiveCommitter: () => ({
                        state: "active",
                        humanId: input.humanActorId,
                        signingPublicKey: committerKey,
                      }),
                    });
                    domainTrustFacts.push({
                      domainId: domain.domainId,
                      domainEpoch: verifiedProvider.transition.nextHead.epoch,
                      participantDigest: participantDigest.slice(),
                      providerTransitionDigest:
                        verifiedProvider.transitionDigest.slice(),
                      peerDeviceId: domain.committerDeviceId,
                      peerSigningPublicKey: committerKey.slice(),
                    });
                    const join = state.joins.find((candidate) =>
                      candidate.domainId === domain.domainId
                    );
                    if (join === undefined) {
                      throw new Error("Additional-device local join state is missing");
                    }
                    const providerVault = DeviceProviderStateVault.fromKey(
                      crypto,
                      cryptoDeviceId(input.deviceId),
                      workingV3.providerStateSealingKey,
                    );
                    try {
                      const provider = new OpenMlsGroupProvider(crypto, providerVault);
                      await provider.initialize();
                      const welcome = await provider.prepareWelcome({
                        joinState: join.localState,
                        publicResult: verifiedProvider.transition,
                      });
                      const applied = provider.activateWelcome({
                        candidate: welcome,
                        joinState: join.localState,
                      });
                      if (applied.status !== "applied") {
                        throw new Error(`Additional-device Welcome ${applied.status}`);
                      }
                      const next = await addClientDomainProviderSnapshot({
                        crypto,
                        profile: workingV3,
                        snapshot: applied.active,
                        expectedHead: verifiedProvider.transition.nextHead,
                      });
                      destroyOpenedClientDeviceProfileV3(workingV3);
                      workingV3 = next;
                      applied.active.ciphertext.fill(0);
                    } finally {
                      providerVault.destroy();
                    }
                    const sequence = domainMessages.at(-1)!.recipientSequence;
                    for (const candidate of artifact.namespaceSubmission.candidates) {
                      for (const current of deliveredBase.keyringDeliveries.filter(
                        (entry) => entry.namespaceId === candidate.nextHead.namespaceId,
                      )) {
                        refreshedKeyrings.push({
                          ...current,
                          deliverySequence: sequence,
                          domainEpoch: candidate.nextHead.domainEpoch,
                          accessRevision: candidate.nextHead.accessRevision,
                          bindingHash: candidate.nextHead.bindingHash,
                        });
                      }
                    }
                  } finally {
                    currentStateHash.fill(0);
                    expectedNamespaces.forEach((namespace) =>
                      namespace.expectedBindingHash.fill(0)
                    );
                    participantDigest.fill(0);
                    rosterBytes.fill(0);
                  }
                } finally {
                  artifactBytes.fill(0);
                  chunks.forEach((chunk) => {
                    chunk.artifactHash.fill(0);
                    chunk.payloadBytes.fill(0);
                    chunk.chunkHash.fill(0);
                  });
                }
              }
              if (refreshedKeyrings.length === 0) {
                candidateV3 = await updateClientDeviceProfileV3({
                  crypto,
                  profile: workingV3,
                  baseProfile: deliveredBase,
                });
              } else {
                const withCurrentKeyrings = writeClientNamespaceKeyrings({
                  profile: deliveredBase,
                  deliveryHighWatermark: delivery.highWatermark,
                  keyrings: refreshedKeyrings,
                });
                try {
                  candidateV3 = await updateClientDeviceProfileV3({
                    crypto,
                    profile: workingV3,
                    baseProfile: withCurrentKeyrings,
                  });
                } finally {
                  destroyOpenedClientDeviceProfile(withCurrentKeyrings);
                }
              }
              candidateV4 = await updateClientDeviceProfileV4({
                crypto,
                profile,
                baseProfile: candidateV3,
              });
              const approver = plannedApprover({ plan });
              try {
                let withDomainEvidence = candidateV4;
                for (const fact of domainTrustFacts) {
                  const next = await addAdditionalDeviceDomainSignerEvidenceV4({
                    crypto,
                    profile: withDomainEvidence,
                    humanId: input.humanActorId,
                    domainId: fact.domainId,
                    domainEpoch: fact.domainEpoch,
                    participantDigest: fact.participantDigest,
                    providerTransitionDigest: fact.providerTransitionDigest,
                    peerDeviceId: fact.peerDeviceId,
                    peerSigningPublicKey: fact.peerSigningPublicKey,
                    acceptedAt: now(),
                  });
                  if (withDomainEvidence !== candidateV4) {
                    destroyOpenedClientDeviceProfileV4(withDomainEvidence);
                  }
                  withDomainEvidence = next;
                }
                candidateWithDomainEvidence = withDomainEvidence === candidateV4
                  ? undefined : withDomainEvidence;
                candidateWithSignerEvidence =
                  await addClientHumanDeviceTransferSignerEvidenceV4({
                    crypto,
                    profile: withDomainEvidence,
                    approvalBytes: transferApprovalBytes,
                    targetSigningPublicKey:
                      profile.baseProfile.baseProfile.signingPublicKey,
                    issuerSigningPublicKey: approver.signingPublicKey,
                  });
              } finally {
                approver.signingPublicKey.fill(0);
              }
              candidateBytes = encodeClientDeviceProfileV4(
                candidateWithSignerEvidence,
              );
            }
            try {
              const availability = await input.profileVault.unlock();
              if (availability.status !== "available") {
                throw new Error("Additional-device profile vault is unavailable");
              }
              const stageId = state.operationId;
              await input.profileVault.stageProfile({
                coordinates: state.coordinates,
                stageId,
                generation: 1,
                profileBytes: candidateBytes,
                publicState: {
                  clientKind: input.clientKind,
                  publicFingerprint: hex(crypto.hash(new Uint8Array([
                    ...profile.baseProfile.baseProfile.signingPublicKey,
                    ...profile.baseProfile.baseProfile.encryptionPublicKey,
                  ]))),
                },
              });
              localTransferStaged = true;
              targetPlanIndex = await targetPlans.recordDeliveryManifest(
                targetPlanIndex,
                {
                  highWatermark: delivery.highWatermark,
                  messages: messages.map((message) => Object.freeze({
                    messageId: message.messageId,
                    recipientSequence: message.recipientSequence,
                    payloadHashBase64url: encode(message.payloadHash),
                  })),
                },
              );
              let processedRevision = activation.deviceRevision!;
              for (const message of messages) {
                const proof = createDeliveryAcknowledgementProof({
                  crypto,
                  message: {
                    messageId: message.messageId,
                    recipientDeviceId: input.deviceId,
                    recipientSequence: message.recipientSequence,
                    payloadHash: message.payloadHash,
                  },
                  processedRevision: ++processedRevision,
                  acknowledgedAt: now(),
                  signingPrivateKey:
                    profile.baseProfile.baseProfile.signingPrivateKey,
                });
                try {
                  await input.api.acknowledgeProtectedAdditionalDeviceDelivery(
                    state.operationId,
                    {
                      requestVersion: 1,
                      deviceId: proof.deviceId,
                      messageId: proof.messageId,
                      recipientSequence: proof.recipientSequence,
                      payloadHashBase64url: encode(proof.payloadHash),
                      processedRevision: proof.processedRevision,
                      acknowledgedAt: proof.acknowledgedAt,
                      acknowledgementDigestBase64url: encode(
                        deliveryAcknowledgementDigest(crypto, proof),
                      ),
                      signatureBase64url: encode(proof.signature),
                    },
                  );
                } finally {
                  proof.payloadHash.fill(0);
                  proof.signature.fill(0);
                }
              }
              activation = await input.api.activateProtectedAdditionalDevice(
                state.operationId,
                { requestVersion: 1, deviceId: state.coordinates.deviceId },
              );
            } finally {
              messages.forEach((message) => {
                message.payloadHash.fill(0);
                message.payloadBytes.fill(0);
              });
            }
          } finally {
            candidateBytes?.fill(0);
            transferApprovalBytes?.fill(0);
            if (candidateWithSignerEvidence) {
              destroyOpenedClientDeviceProfileV4(candidateWithSignerEvidence);
            }
            if (candidateWithDomainEvidence) {
              destroyOpenedClientDeviceProfileV4(candidateWithDomainEvidence);
            }
            if (candidateV4) destroyOpenedClientDeviceProfileV4(candidateV4);
            if (candidateV3) destroyOpenedClientDeviceProfileV3(candidateV3);
            if (typeof workingV3 !== "undefined") {
              destroyOpenedClientDeviceProfileV3(workingV3);
            }
            if (typeof deliveredBase !== "undefined") {
              destroyOpenedClientDeviceProfile(deliveredBase);
            }
            committerKeys?.forEach((key) => key.fill(0));
            approverSigningPublicKey?.fill(0);
            domainTrustFacts.forEach((fact) => {
              fact.participantDigest.fill(0);
              fact.providerTransitionDigest.fill(0);
              fact.peerSigningPublicKey.fill(0);
            });
            destroyOpenedClientDeviceProfileV4(profile);
          }
        }
        if (activation.status === "syncing" && localTransferStaged) {
          const syncReason = activation.syncReason ?? "current_domain_sync_required";
          await activateResumedAdditionalDeviceProfile({
            crypto,
            profileVault: input.profileVault,
            state,
            operationId: state.operationId,
            deviceRevision: activation.deviceRevision!,
          });
          const replacement: PendingAdditionalDeviceClientState =
            Object.freeze({
              ...state,
              revision: 3 as const,
              syncVerificationCode: verificationCode,
              syncReason,
            });
          if (!await input.vault.compareAndSwap({
            expected: persistedState,
            replacement,
          })) {
            destroyPendingAdditionalDeviceClientState(replacement);
            throw new Error("Additional-device Grant synchronization state changed");
          }
          return Object.freeze({
            status: "syncing" as const,
            operationId: state.operationId,
            coordinates: state.coordinates,
            verificationCode,
            syncReason,
          });
        }
        if (activation.status === "active") {
          await activateResumedAdditionalDeviceProfile({
            crypto,
            profileVault: input.profileVault,
            state,
            operationId: state.operationId,
            deviceRevision: activation.deviceRevision!,
          });
          const personalAuthorityReady = await ensurePersonalAuthority(plan);
          const replacement: PendingAdditionalDeviceClientState =
            Object.freeze({
              ...state,
              revision: 3 as const,
              syncVerificationCode: verificationCode,
              ...(personalAuthorityReady ? {} : {
                syncReason: "personal_authority_required" as const,
              }),
            });
          if (!await input.vault.compareAndSwap({
            expected: persistedState,
            replacement,
          })) {
            throw new Error("Additional-device cleanup state changed");
          }
          if (!personalAuthorityReady) {
            return Object.freeze({
              status: "syncing" as const,
              operationId: state.operationId,
              coordinates: state.coordinates,
              verificationCode,
              syncReason: "personal_authority_required" as const,
            });
          }
          await removeTargetPlan(state.operationId);
          if (!await input.vault.removeExact(replacement)) {
            throw new Error("Additional-device pending custody cleanup failed");
          }
          return Object.freeze({
            status: "active" as const,
            operationId: state.operationId,
            coordinates: state.coordinates,
            deviceRevision: activation.deviceRevision!,
          });
        }
        return Object.freeze({
            status: "syncing" as const,
            operationId: state.operationId,
            coordinates: state.coordinates,
            verificationCode,
        });
      } finally {
        destroyPendingAdditionalDeviceClientState(persistedState);
        destroyPendingAdditionalDeviceClientState(state);
      }
    },
  });
}

export type AdditionalDeviceApproverProgress =
  | Readonly<{ status: "no_pending_device" }>
  | Readonly<{
    status: "waiting_for_target" | "transition_ready";
    operationId: string;
    targetDeviceId: string;
  }>;

export type AdditionalDeviceApproverCandidate = Readonly<{
  enrollment: Readonly<{
    operationId: string;
    deviceId: string;
    clientKind: "browser" | "electron";
  }>;
  verificationCode?: string;
  progress:
    | "approval_required"
    | "transfer_ready"
    | "awaiting_target";
}>;

export function createAdditionalDeviceApproverClient(input: Readonly<{
  api: AdditionalDeviceClientApiPort;
  profileVault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  transitionCampaignVault: AdditionalDeviceTransitionCampaignVault;
  crypto?: LatticeCrypto;
  now?(): number;
}>) {
  const crypto = input.crypto ?? new LatticeCrypto();
  const now = input.now ?? (() => Date.now());
  const transitionCampaigns = createAdditionalDeviceTransitionCampaignJournal({
    vault: input.transitionCampaignVault,
    now,
  });

  async function unlockTransitionCampaigns(): Promise<void> {
    const availability = await input.transitionCampaignVault.unlock();
    if (availability.status !== "available") {
      throw new Error(
        `Additional-device transition custody is unavailable (${
          "reasonCode" in availability ? availability.reasonCode : availability.status
        })`,
      );
    }
  }

  async function activateTransitionCampaignProfile(
    campaign: AdditionalDeviceTransitionCampaignIndex,
  ): Promise<void> {
    const profiles = (await input.profileVault.listPublicProfiles()).filter(
      (candidate) =>
        candidate.coordinates.serverScope === input.coordinates.serverScope
        && candidate.coordinates.userId === input.coordinates.userId
        && candidate.coordinates.humanActorId === input.coordinates.humanActorId
        && candidate.coordinates.profileId === input.coordinates.profileId
        && candidate.coordinates.deviceId === input.coordinates.deviceId,
    );
    const expectedDigest = campaign.candidateProfileDigestBase64url;
    const verifyDigest = (bytes: Uint8Array): void => {
      const digest = crypto.hash(bytes);
      try {
        if (encode(digest) !== expectedDigest) {
          throw new Error("Additional-device staged profile disagrees with its campaign");
        }
      } finally {
        digest.fill(0);
      }
    };
    const staged = profiles.find((candidate) =>
      candidate.lifecycle === "staged"
      && candidate.stageId === `additional-device:${campaign.operationId}`
      && candidate.generation === campaign.candidateProfileGeneration
    );
    if (staged !== undefined) {
      if (input.profileVault.withOpenStagedProfile === undefined) {
        throw new Error("Additional-device staged profile cannot be opened");
      }
      await input.profileVault.withOpenStagedProfile(
        input.coordinates,
        staged.stageId!,
        verifyDigest,
      );
      await input.profileVault.activateProfile(input.coordinates, staged.stageId!);
      return;
    }
    const active = profiles.find((candidate) =>
      candidate.lifecycle === "active"
      && candidate.generation === campaign.candidateProfileGeneration
    );
    if (active === undefined) {
      throw new Error("Additional-device staged profile is unavailable");
    }
    await input.profileVault.withOpenProfile(input.coordinates, verifyDigest);
  }

  async function replayTransitionCampaign(
    campaign: AdditionalDeviceTransitionCampaignIndex,
  ): Promise<void> {
    await transitionCampaigns.withRequest(campaign, (request) =>
      input.api.submitProtectedAdditionalDeviceTransitionsV2(
        campaign.operationId,
        request,
      )
    );
    await activateTransitionCampaignProfile(campaign);
    if (!await transitionCampaigns.removeExact(campaign)) {
      throw new Error("Additional-device transition campaign cleanup failed");
    }
  }

  async function loadPendingPlans(): Promise<readonly CompleteAdditionalDevicePlan[]> {
    const pending = await input.api.listProtectedAdditionalDevicePendingV2({
      requestVersion: 2,
      approverDeviceId: input.coordinates.deviceId,
    });
    return Object.freeze(await Promise.all(pending.pending.map((first) =>
      assemblePlan({
        crypto,
        api: input.api,
        deviceId: input.coordinates.deviceId,
        first,
      })
    )));
  }

  async function loadTransitionPlan(
    operationId: string,
    pendingPlan: ProtectedAdditionalDevicePlanV1,
  ) {
    const domains: ProtectedAdditionalDeviceTransitionPlanV2["domains"][number][] = [];
    let pageStart = 0;
    for (;;) {
      const page = await input.api.planProtectedAdditionalDeviceTransitionsV2(
        operationId,
        {
          requestVersion: 2,
          approverDeviceId: input.coordinates.deviceId,
          pageStart,
        },
      );
      if (
        page.operationId !== operationId
        || page.targetDeviceId !== pendingPlan.enrollment.deviceId
        || page.domainCount !== pendingPlan.domains.length
        || page.page.start !== pageStart
        || page.domains.some((domain, index) =>
          JSON.stringify(domain.plan)
            !== JSON.stringify(pendingPlan.domains[pageStart + index])
        )
      ) throw new TypeError("Additional-device transition page was substituted");
      domains.push(...page.domains);
      if (page.page.nextStart === null) break;
      pageStart = page.page.nextStart;
    }
    return Object.freeze({
      operationId,
      targetDeviceId: pendingPlan.enrollment.deviceId,
      domains: Object.freeze(domains),
    });
  }

  async function prepareApproval(
    profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
    plan: CompleteAdditionalDevicePlan,
  ) {
    const enrollment = pendingEnrollment(plan);
    const target = Object.freeze({
      humanId: humanId(enrollment.humanActorId),
      deviceId: cryptoDeviceId(enrollment.deviceId),
      pendingDeviceRevision: pendingDeviceRevisionV2(0),
      encryptionPublicKey: enrollment.encryptionPublicKey,
      signingPublicKey: enrollment.signingPublicKey,
    });
    const trusted = Object.freeze({
      humanId: target.humanId,
      deviceId: target.deviceId,
      pendingDeviceRevision: target.pendingDeviceRevision,
      encryptionPublicKeyDigest: crypto.hash(target.encryptionPublicKey),
      signingPublicKeyDigest: crypto.hash(target.signingPublicKey),
      status: "pending" as const,
    });
    const sources: Parameters<typeof prepareDeviceTransfer>[0]["sources"][number][] = [];
    try {
      const visit = async (domainIndex: number): Promise<Awaited<
        ReturnType<typeof prepareDeviceTransfer>
      >> => {
        const domain = plan.domains[domainIndex];
        if (domain === undefined) {
          return prepareDeviceTransfer({
            crypto,
            pendingDevice: target,
            resolveTrustedPendingDevice: () => trusted,
            issuerDeviceId: cryptoDeviceId(input.coordinates.deviceId),
            issuerSigningPrivateKey:
              profile.baseProfile.baseProfile.signingPrivateKey,
            createdAt: unixTimestamp(now()),
            inventoryRevision:
              deviceTransferInventoryRevisionV2(enrollment.inventoryRevision),
            sources,
            currentDomains: plan.domains.map((candidate) => ({
              domainId: cryptoDomainId(candidate.domainId),
              domainEpoch: domainEpoch(candidate.expectedHead.epoch),
            })),
            resolveTrustedInventoryCommitment: () => Object.freeze({
              humanId: target.humanId,
              inventoryRevision:
                deviceTransferInventoryRevisionV2(enrollment.inventoryRevision),
              inventoryCount: enrollment.inventoryCount,
              inventoryDigest: enrollment.inventoryDigest,
            }),
            resolveCurrentApprover: () =>
              profile.baseProfile.baseProfile.signingPublicKey,
            resolveCurrentDomainCommitter: () =>
              profile.baseProfile.baseProfile.signingPublicKey,
          });
        }
        const expectedHead = Object.freeze({
          providerId: domain.expectedHead.providerId,
          domainId: cryptoDomainId(domain.domainId),
          epoch: domainEpoch(domain.expectedHead.epoch),
          stateHash: decode(domain.expectedHead.stateHashBase64url),
        });
        const historical = await withSoleFoundingDeviceHistoricalCommitterV4({
          crypto,
          profile,
          humanId: enrollment.humanActorId,
          expectedHead,
          operation: (resolveHistoricalCommitter) => withClientDomainRoots({
            crypto,
            profile: profile.baseProfile,
            expectedHead,
            operation: async (roots) => {
              for (const namespace of domain.namespaces) {
                const proof = namespace.bindingProofBytesBase64url.map(
                  (value) => parseNamespaceBindingV2(decode(value)),
                );
                const head = verifyNamespaceBindingProof({
                  crypto,
                  anchor: null,
                  proof,
                  resolveHistoricalCommitter,
                });
                if (
                  head.namespaceId !== namespace.namespaceId
                  || head.accessRevision !== namespace.accessRevision
                  || encode(head.bindingHash)
                    !== namespace.bindingHashBase64url
                ) throw new TypeError("Additional-device Namespace plan was substituted");
                sources.push({
                  authorizedHumanId: target.humanId,
                  trustedNamespaceHead: head,
                  keyClass: "human",
                  currentKeyringEnvelope: parseNamespaceKeyringEnvelopeV2(
                    decode(namespace.humanEnvelopeBytesBase64url),
                  ),
                  currentDomainRoot: roots.human,
                  resolveHistoricalCommitter,
                }, {
                  authorizedHumanId: target.humanId,
                  trustedNamespaceHead: head,
                  keyClass: "ai",
                  currentKeyringEnvelope: parseNamespaceKeyringEnvelopeV2(
                    decode(namespace.aiEnvelopeBytesBase64url),
                  ),
                  currentDomainRoot: roots.ai,
                  resolveHistoricalCommitter,
                });
              }
              return visit(domainIndex + 1);
            },
          }),
        });
        expectedHead.stateHash.fill(0);
        if (historical.status !== "ready") {
          throw new Error(`Additional-device approval unavailable (${historical.reason})`);
        }
        return historical.value;
      };
      return await visit(0);
    } finally {
      trusted.encryptionPublicKeyDigest.fill(0);
      trusted.signingPublicKeyDigest.fill(0);
      destroyPendingEnrollment(enrollment);
    }
  }

  return Object.freeze({
    async inspect(): Promise<readonly AdditionalDeviceApproverCandidate[]> {
      await unlockTransitionCampaigns();
      const localCampaigns = await transitionCampaigns.list();
      const pending = await loadPendingPlans();
      if (
        pending.length === 0
        && localCampaigns.length === 0
      ) {
        return Object.freeze([]);
      }
      return input.profileVault.withOpenProfile(
        input.coordinates,
        async (profileBytes) => {
          const profile = await authenticateClientDeviceProfileV4({
            crypto,
            profileBytes,
            expectedDeviceId: input.coordinates.deviceId,
          });
          try {
            const candidates: AdditionalDeviceApproverCandidate[] = pending.map((plan) => {
              assertPlanAccount(plan, input.coordinates);
              const approver = plannedApprover({ plan });
              const targetKey = decode(
                plan.enrollment.signingPublicKeyBase64url,
              );
              try {
                if (approver.deviceId !== input.coordinates.deviceId
                  || !equalBytes(
                    approver.signingPublicKey,
                    profile.baseProfile.baseProfile.signingPublicKey,
                  )) {
                  throw new TypeError(
                    "Additional-device plan named another approver",
                  );
                }
                return Object.freeze({
                  enrollment: Object.freeze({
                    operationId: plan.enrollment.operationId,
                    deviceId: plan.enrollment.deviceId,
                    clientKind: plan.enrollment.clientKind,
                  }),
                  progress: plan.progress ?? "approval_required",
                  verificationCode: deriveAdditionalDeviceVerificationCode({
                    crypto,
                    operationId: plan.enrollment.operationId,
                    humanId: plan.enrollment.humanActorId,
                    targetDeviceId: plan.enrollment.deviceId,
                    targetSigningPublicKey: targetKey,
                    approverDeviceId: input.coordinates.deviceId,
                    approverSigningPublicKey:
                      profile.baseProfile.baseProfile.signingPublicKey,
                  }),
                });
              } finally {
                approver.signingPublicKey.fill(0);
                targetKey.fill(0);
              }
            });
            for (const campaign of localCampaigns) {
              if (candidates.some((candidate) =>
                candidate.enrollment.operationId === campaign.operationId
              )) continue;
              candidates.push(Object.freeze({
                enrollment: Object.freeze({
                  operationId: campaign.operationId,
                  deviceId: campaign.targetDeviceId,
                  clientKind: campaign.targetClientKind,
                }),
                progress: "transfer_ready" as const,
                verificationCode: campaign.verificationCode,
              }));
            }
            return Object.freeze(candidates);
          } finally {
            destroyOpenedClientDeviceProfileV4(profile);
          }
        },
      );
    },
    async approve(
      operationId: string,
      verificationCode: string,
    ): Promise<AdditionalDeviceApproverProgress> {
      if ((await input.profileVault.unlock()).status !== "available") {
        throw new Error("Approving device profile vault is unavailable");
      }
      const pending = await loadPendingPlans();
      const plan = pending.find((candidate) =>
        candidate.enrollment.operationId === operationId
      );
      if (plan === undefined) return Object.freeze({ status: "no_pending_device" as const });
      assertPlanAccount(plan, input.coordinates);
      const activePublic = (await input.profileVault.listPublicProfiles())
        .find((candidate) => candidate.lifecycle === "active"
          && candidate.coordinates.serverScope === input.coordinates.serverScope
          && candidate.coordinates.profileId === input.coordinates.profileId
          && candidate.coordinates.deviceId === input.coordinates.deviceId);
      if (activePublic === undefined) {
        throw new Error("Approving device active profile is unavailable");
      }
      let signerEvidenceCandidateBytes: Uint8Array | undefined;
      await input.profileVault.withOpenProfile(
        input.coordinates,
        async (profileBytes) => {
          const profile = await authenticateClientDeviceProfileV4({
            crypto,
            profileBytes,
            expectedDeviceId: input.coordinates.deviceId,
          });
          let prepared: Awaited<ReturnType<typeof prepareDeviceTransfer>> | undefined;
          let enrollment: PendingAdditionalDeviceEnrollment | undefined;
          try {
            const approver = plannedApprover({ plan });
            const targetKey = decode(plan.enrollment.signingPublicKeyBase64url);
            try {
              const expected = deriveAdditionalDeviceVerificationCode({
                crypto,
                operationId: plan.enrollment.operationId,
                humanId: plan.enrollment.humanActorId,
                targetDeviceId: plan.enrollment.deviceId,
                targetSigningPublicKey: targetKey,
                approverDeviceId: input.coordinates.deviceId,
                approverSigningPublicKey:
                  profile.baseProfile.baseProfile.signingPublicKey,
              });
              if (approver.deviceId !== input.coordinates.deviceId
                || !equalBytes(approver.signingPublicKey,
                  profile.baseProfile.baseProfile.signingPublicKey)
                || verificationCode !== expected) {
                throw new Error("Additional-device comparison code did not match");
              }
            } finally {
              approver.signingPublicKey.fill(0);
              targetKey.fill(0);
            }
            prepared = await prepareApproval(profile, plan);
            enrollment = pendingEnrollment(plan);
            const manifest = createAdditionalDeviceApprovalManifest({
              crypto,
              enrollment,
              approvalBytes: prepared.approvalBytes,
              issuerDeviceId: input.coordinates.deviceId,
              issuerSigningPrivateKey:
                profile.baseProfile.baseProfile.signingPrivateKey,
            });
            try {
              await input.api.approveProtectedAdditionalDevice(operationId, {
                requestVersion: 1,
                approverDeviceId: input.coordinates.deviceId,
                approvalBytesBase64url: encode(prepared.approvalBytes),
                manifest: {
                  formatVersion: 1,
                  operationId: manifest.operationId,
                  humanId: manifest.humanId,
                  targetDeviceId: manifest.targetDeviceId,
                  issuerDeviceId: manifest.issuerDeviceId,
                  expectedDeviceRevision: 0,
                  expectedCustodyRevision: manifest.expectedCustodyRevision,
                  expectedRecoveryGeneration: manifest.expectedRecoveryGeneration,
                  inventoryRevision: manifest.inventoryRevision,
                  inventoryCount: manifest.inventoryCount,
                  inventoryDigestBase64url: encode(manifest.inventoryDigest),
                  approvalHashBase64url: encode(manifest.approvalHash),
                  signatureBase64url: encode(manifest.signature),
                },
              });
              const withEvidence =
                await addClientHumanDeviceTransferSignerEvidenceV4({
                  crypto,
                  profile,
                  approvalBytes: prepared.approvalBytes,
                  targetSigningPublicKey: enrollment.signingPublicKey,
                  issuerSigningPublicKey:
                    profile.baseProfile.baseProfile.signingPublicKey,
                });
              try {
                signerEvidenceCandidateBytes = encodeClientDeviceProfileV4(
                  withEvidence,
                );
              } finally {
                destroyOpenedClientDeviceProfileV4(withEvidence);
              }
            } finally {
              manifest.inventoryDigest.fill(0);
              manifest.approvalHash.fill(0);
              manifest.signature.fill(0);
            }
          } finally {
            prepared?.approvalBytes.fill(0);
            prepared?.activationCas.approvalHash.fill(0);
            prepared?.activationCas.expectedInventoryDigest.fill(0);
            prepared?.activationCas.expectedPendingEncryptionPublicKeyDigest.fill(0);
            prepared?.activationCas.expectedPendingSigningPublicKeyDigest.fill(0);
            if (enrollment) destroyPendingEnrollment(enrollment);
            destroyOpenedClientDeviceProfileV4(profile);
          }
        },
      );
      const signerStageId = `additional-device-signer:${operationId}`;
      try {
        await input.profileVault.stageProfile({
          coordinates: input.coordinates,
          stageId: signerStageId,
          generation: activePublic.generation + 1,
          profileBytes: signerEvidenceCandidateBytes!,
          publicState: activePublic.publicState,
        });
        await input.profileVault.activateProfile(
          input.coordinates,
          signerStageId,
        );
      } finally {
        signerEvidenceCandidateBytes?.fill(0);
      }
      return Object.freeze({
        status: plan.domains.length === 0
          ? "transition_ready" as const
          : "waiting_for_target" as const,
        operationId,
        targetDeviceId: plan.enrollment.deviceId,
      });
    },
    async advance(operationId: string): Promise<Readonly<{
      status: "submitted";
      operationId: string;
    }>> {
      if ((await input.profileVault.unlock()).status !== "available") {
        throw new Error("Approving device profile vault is unavailable");
      }
      await unlockTransitionCampaigns();
      const localCampaign = (await transitionCampaigns.list()).find(
        (candidate) => candidate.operationId === operationId,
      );
      if (localCampaign !== undefined) {
        await replayTransitionCampaign(localCampaign);
        return Object.freeze({ status: "submitted" as const, operationId });
      }
      const pending = await loadPendingPlans();
      const pendingPlan = pending.find((candidate) =>
        candidate.enrollment.operationId === operationId
      );
      if (pendingPlan === undefined) {
        throw new Error("Additional-device transition target is unavailable");
      }
      const orphanStage = (await input.profileVault.listPublicProfiles()).find(
        (candidate) => candidate.lifecycle === "staged"
          && candidate.stageId === `additional-device:${operationId}`
          && candidate.coordinates.serverScope === input.coordinates.serverScope
          && candidate.coordinates.profileId === input.coordinates.profileId
          && candidate.coordinates.deviceId === input.coordinates.deviceId,
      );
      if (orphanStage !== undefined) {
        // A campaign is sealed before its first server mutation. Therefore a
        // matching stage without a campaign can only be the safe pre-journal
        // crash window; discard it before preparing fresh exact bytes.
        await input.profileVault.abortStagedProfile(
          input.coordinates,
          orphanStage.stageId!,
        );
      }
      const transitionPlan = await loadTransitionPlan(operationId, pendingPlan);
      assertPlanAccount(pendingPlan, input.coordinates);
      const activePublic = (await input.profileVault.listPublicProfiles())
        .find((candidate) => candidate.lifecycle === "active"
          && candidate.coordinates.serverScope === input.coordinates.serverScope
          && candidate.coordinates.profileId === input.coordinates.profileId
          && candidate.coordinates.deviceId === input.coordinates.deviceId);
      if (activePublic === undefined) {
        throw new Error("Approving device active profile is unavailable");
      }
      let candidateBytes: Uint8Array | undefined;
      let campaignVerificationCode: string | undefined;
      const transitions: ProtectedAdditionalDeviceTransitionsRequestV2["transitions"] = [];
      await input.profileVault.withOpenProfile(input.coordinates, async (profileBytes) => {
        const original = await authenticateClientDeviceProfileV4({
          crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        let working = original;
        const targetSigningPublicKey = decode(
          pendingPlan.enrollment.signingPublicKeyBase64url,
        );
        try {
          campaignVerificationCode = deriveAdditionalDeviceVerificationCode({
            crypto,
            operationId,
            humanId: pendingPlan.enrollment.humanActorId,
            targetDeviceId: pendingPlan.enrollment.deviceId,
            targetSigningPublicKey,
            approverDeviceId: input.coordinates.deviceId,
            approverSigningPublicKey:
              original.baseProfile.baseProfile.signingPublicKey,
          });
          for (const domain of transitionPlan.domains) {
            const expectedHead = Object.freeze({
              providerId: domain.plan.expectedHead.providerId,
              domainId: cryptoDomainId(domain.plan.domainId),
              epoch: domainEpoch(domain.plan.expectedHead.epoch),
              stateHash: decode(domain.plan.expectedHead.stateHashBase64url),
            });
            const historical = await withSoleFoundingDeviceHistoricalCommitterV4({
              crypto,
              profile: working,
              humanId: input.coordinates.humanActorId,
              expectedHead,
              operation: async (resolveHistoricalCommitter) => {
                const v3 = working.baseProfile;
                const record = v3.activeProviderSnapshots.find((candidate) =>
                  candidate.domainId === domain.plan.domainId
                );
                if (record === undefined) {
                  throw new Error("Approving device Domain snapshot is unavailable");
                }
                const providerVault = DeviceProviderStateVault.fromKey(
                  crypto,
                  cryptoDeviceId(input.coordinates.deviceId),
                  v3.providerStateSealingKey,
                );
                const active = restoreSealedProviderState({
                  providerId: record.providerId,
                  domainId: cryptoDomainId(record.domainId),
                  deviceId: cryptoDeviceId(input.coordinates.deviceId),
                  revision: domainEpoch(record.epoch),
                  snapshotKind: "active",
                  ciphertext: record.ciphertext,
                });
                const provider = new OpenMlsGroupProvider(crypto, providerVault);
                let oldRoots: Awaited<ReturnType<typeof provider.exportDomainRoots>> | undefined;
                let nextRoots: Awaited<ReturnType<typeof provider.exportDomainRoots>> | undefined;
                let nextActive: SealedProviderStateV2 | undefined;
                try {
                  await provider.initialize();
                  const addition = await provider.prepareAdd({
                    active,
                    joinRequest: {
                      formatVersion: 2,
                      providerId: expectedHead.providerId,
                      domainId: expectedHead.domainId,
                      humanId: humanId(input.coordinates.humanActorId),
                      deviceId: cryptoDeviceId(transitionPlan.targetDeviceId),
                      expectedHead,
                      keyPackageBytes: decode(domain.joinPackageBytesBase64url),
                    },
                  });
                  const applied = provider.applyCandidate({
                    active,
                    candidate: addition.localCandidate,
                  });
                  if (applied.status !== "applied") {
                    throw new Error(`Additional-device provider transition ${applied.status}`);
                  }
                  nextActive = applied.active;
                  oldRoots = await provider.exportDomainRoots(active);
                  nextRoots = await provider.exportDomainRoots(nextActive);
                  const affected = domain.plan.namespaces.map((namespace) => ({
                    anchor: null,
                    proof: namespace.bindingProofBytesBase64url.map((value) =>
                      parseNamespaceBindingV2(decode(value))
                    ),
                    humanEnvelope: parseNamespaceKeyringEnvelopeV2(
                      decode(namespace.humanEnvelopeBytesBase64url),
                    ),
                    aiEnvelope: parseNamespaceKeyringEnvelopeV2(
                      decode(namespace.aiEnvelopeBytesBase64url),
                    ),
                  }));
                  const prepared = prepareDomainEpochAdvance({
                    crypto,
                    reason: "device_add",
                    domain: {
                      domainId: expectedHead.domainId,
                      oldEpoch: expectedHead.epoch,
                      nextEpoch: domainEpoch(Number(expectedHead.epoch) + 1),
                      oldHumanRoot: oldRoots.human,
                      oldAiRoot: oldRoots.ai,
                      nextHumanRoot: nextRoots.human,
                      nextAiRoot: nextRoots.ai,
                    },
                    affected,
                    committer: {
                      deviceId: cryptoDeviceId(input.coordinates.deviceId),
                      signingPrivateKey:
                        working.baseProfile.baseProfile.signingPrivateKey,
                    },
                    resolveHistoricalCommitter,
                    resolveSourceCommitter: () =>
                      working.baseProfile.baseProfile.signingPublicKey,
                    resolveTargetCommitter: () =>
                      working.baseProfile.baseProfile.signingPublicKey,
                  });
                  const participantDigest = decode(
                    domain.plan.participantDigestBase64url,
                  );
                  try {
                    const providerSubmission = createProviderTransitionSubmission({
                      crypto,
                      transition: addition.publicResult,
                      operationId,
                      committerDeviceId: input.coordinates.deviceId,
                      expectedAuthorizationRevision:
                        domain.plan.authorizationRevision,
                      expectedParticipantDigest: participantDigest,
                      signingPrivateKey:
                        working.baseProfile.baseProfile.signingPrivateKey,
                    });
                    const namespaceSubmission = createNamespaceTransitionSubmission({
                      crypto,
                      operationId,
                      committerDeviceId: input.coordinates.deviceId,
                      providerTransitionDigest:
                        providerSubmission.transitionDigest,
                      prepared,
                      signingPrivateKey:
                        working.baseProfile.baseProfile.signingPrivateKey,
                    });
                    const nextV3 = await addClientDomainProviderSnapshot({
                      crypto,
                      profile: working.baseProfile,
                      snapshot: nextActive,
                      expectedHead: addition.publicResult.nextHead,
                    });
                    const nextV4 = await updateClientDeviceProfileV4({
                      crypto,
                      profile: working,
                      baseProfile: nextV3,
                    });
                    let nextWithDomainEvidence: Awaited<ReturnType<
                      typeof addAdditionalDeviceDomainSignerEvidenceV4
                    >>;
                    try {
                      nextWithDomainEvidence =
                        await addAdditionalDeviceDomainSignerEvidenceV4({
                          crypto,
                          profile: nextV4,
                          humanId: input.coordinates.humanActorId,
                          domainId: domain.plan.domainId,
                          domainEpoch: addition.publicResult.nextHead.epoch,
                          participantDigest,
                          providerTransitionDigest:
                            providerSubmission.transitionDigest,
                          peerDeviceId: transitionPlan.targetDeviceId,
                          peerSigningPublicKey: targetSigningPublicKey,
                          acceptedAt: now(),
                        });
                    } finally {
                      destroyOpenedClientDeviceProfileV4(nextV4);
                    }
                    transitions.push({
                      domainId: domain.plan.domainId,
                      providerSubmissionBytesBase64url: encode(
                        serializeProviderTransitionSubmission(providerSubmission),
                      ),
                      namespaceSubmissionBytesBase64url: encode(
                        serializeNamespaceTransitionSubmission(namespaceSubmission),
                      ),
                    });
                    if (working !== original) {
                      destroyOpenedClientDeviceProfileV4(working);
                    }
                    working = nextWithDomainEvidence;
                  } finally {
                    participantDigest.fill(0);
                  }
                } finally {
                  oldRoots?.human.fill(0);
                  oldRoots?.ai.fill(0);
                  nextRoots?.human.fill(0);
                  nextRoots?.ai.fill(0);
                  active.ciphertext.fill(0);
                  nextActive?.ciphertext.fill(0);
                  providerVault.destroy();
                }
              },
            });
            expectedHead.stateHash.fill(0);
            if (historical.status !== "ready") {
              throw new Error(`Additional-device transition unavailable (${historical.reason})`);
            }
          }
          candidateBytes = encodeClientDeviceProfileV4(working);
        } finally {
          targetSigningPublicKey.fill(0);
          if (working !== original) destroyOpenedClientDeviceProfileV4(working);
          destroyOpenedClientDeviceProfileV4(original);
        }
      });
      const stageId = `additional-device:${operationId}`;
      try {
        await input.profileVault.stageProfile({
          coordinates: input.coordinates,
          stageId,
          generation: activePublic.generation + 1,
          profileBytes: candidateBytes!,
          publicState: activePublic.publicState,
        });
        const candidateDigest = crypto.hash(candidateBytes!);
        let campaign: AdditionalDeviceTransitionCampaignIndex;
        try {
          campaign = (await transitionCampaigns.putBeforeSend({
            operationId,
            targetDeviceId: pendingPlan.enrollment.deviceId,
            targetClientKind: pendingPlan.enrollment.clientKind,
            verificationCode: campaignVerificationCode!,
            candidateProfileDigestBase64url: encode(candidateDigest),
            candidateProfileGeneration: activePublic.generation + 1,
            request: {
              requestVersion: 2,
              approverDeviceId: input.coordinates.deviceId,
              inventoryRevision: pendingPlan.enrollment.inventoryRevision,
              inventoryCount: pendingPlan.enrollment.inventoryCount,
              inventoryDigestBase64url:
                pendingPlan.enrollment.inventoryDigestBase64url,
              domainCount: pendingPlan.domains.length,
              transitions,
            },
          })).index;
        } finally {
          candidateDigest.fill(0);
        }
        await replayTransitionCampaign(campaign);
      } finally {
        candidateBytes?.fill(0);
      }
      return Object.freeze({ status: "submitted" as const, operationId });
    },
  });
}

interface EncodedPendingAdditionalDeviceState {
  readonly formatVersion: 1;
  readonly revision: 1 | 2 | 3;
  readonly idempotencyKey: string;
  readonly coordinates: ClientProfileCoordinates;
  readonly clientKind: "browser" | "electron";
  readonly installationLineageDigestBase64url: string;
  readonly profileBytesBase64url: string;
  readonly operationId: string | null;
  readonly syncVerificationCode?: string;
  readonly syncReason?: AdditionalDeviceSyncReason;
  readonly joins: ReadonlyArray<Readonly<{
    domainId: string;
    expectedHead: Readonly<{
      providerId: string;
      domainId: string;
      epoch: number;
      stateHashBase64url: string;
    }>;
    localState: Readonly<{
      providerId: string;
      domainId: string;
      deviceId: string;
      revision: number;
      snapshotKind: "candidate";
      ciphertextBase64url: string;
    }>;
    package: EncodedDeviceJoinPackage;
  }>>;
}

function encodePendingState(value: PendingAdditionalDeviceClientState): Uint8Array {
  const encoded: EncodedPendingAdditionalDeviceState = {
    formatVersion: 1,
    revision: value.revision,
    idempotencyKey: value.idempotencyKey,
    coordinates: { ...value.coordinates },
    clientKind: value.clientKind,
    installationLineageDigestBase64url:
      encode(value.installationLineageDigest),
    profileBytesBase64url: encode(value.profileBytes),
    operationId: value.operationId,
    ...(value.syncVerificationCode === undefined
      ? {}
      : { syncVerificationCode: value.syncVerificationCode }),
    ...(value.syncReason === undefined
      ? {}
      : { syncReason: value.syncReason }),
    joins: value.joins.map((join) => ({
      domainId: join.domainId,
      expectedHead: {
        providerId: join.expectedHead.providerId,
        domainId: join.expectedHead.domainId,
        epoch: join.expectedHead.epoch,
        stateHashBase64url: encode(join.expectedHead.stateHash),
      },
      localState: {
        providerId: join.localState.providerId,
        domainId: join.localState.domainId,
        deviceId: join.localState.deviceId,
        revision: join.localState.revision,
        snapshotKind: "candidate",
        ciphertextBase64url: encode(join.localState.ciphertext),
      },
      package: { ...join.package },
    })),
  };
  return new TextEncoder().encode(JSON.stringify(encoded));
}

function decodePendingState(bytes: Uint8Array): PendingAdditionalDeviceClientState {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("Pending additional-device state is malformed");
  }
  const value = parsed as EncodedPendingAdditionalDeviceState;
  const joinsValue: unknown = value.joins;
  if (value.formatVersion !== 1
    || (value.revision !== 1 && value.revision !== 2 && value.revision !== 3)
    || !Array.isArray(joinsValue) || value.joins.length > 256
    || (value.revision === 1 && (value.operationId !== null
      || value.joins.length !== 0
      || value.syncVerificationCode !== undefined
      || value.syncReason !== undefined))
    || ((value.revision === 2 || value.revision === 3)
      && value.operationId === null)
    || (value.revision !== 3 && value.syncReason !== undefined)
    || (value.revision === 3
      && (typeof value.syncVerificationCode !== "string"
        || !/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/u.test(
          value.syncVerificationCode,
        )
        || (value.syncReason !== undefined
          && value.syncReason !== "delivery_pending"
          && value.syncReason !== "current_domain_sync_required"
          && value.syncReason !== "personal_authority_required")))) {
    throw new TypeError("Pending additional-device state is malformed");
  }
  const state: PendingAdditionalDeviceClientState = Object.freeze({
    formatVersion: 1,
    revision: value.revision,
    idempotencyKey: value.idempotencyKey,
    coordinates: Object.freeze({ ...value.coordinates }),
    clientKind: value.clientKind,
    installationLineageDigest:
      decode(value.installationLineageDigestBase64url),
    profileBytes: decode(value.profileBytesBase64url),
    operationId: value.operationId,
    ...(value.syncVerificationCode === undefined
      ? {}
      : { syncVerificationCode: value.syncVerificationCode }),
    ...(value.syncReason === undefined
      ? {}
      : { syncReason: value.syncReason }),
    joins: Object.freeze(value.joins.map((join) => Object.freeze({
      domainId: join.domainId,
      expectedHead: Object.freeze({
        providerId: join.expectedHead.providerId,
        domainId: cryptoDomainId(join.expectedHead.domainId),
        epoch: domainEpoch(join.expectedHead.epoch),
        stateHash: decode(join.expectedHead.stateHashBase64url),
      }),
      localState: restoreSealedProviderState({
        providerId: join.localState.providerId,
        domainId: cryptoDomainId(join.localState.domainId),
        deviceId: cryptoDeviceId(join.localState.deviceId),
        revision: domainEpoch(join.localState.revision),
        snapshotKind: "candidate",
        ciphertext: decode(join.localState.ciphertextBase64url),
      }),
      package: Object.freeze({ ...join.package }),
    }))),
  });
  const canonical = encodePendingState(state);
  try {
    if (new TextDecoder().decode(canonical) !== text) {
      destroyPendingAdditionalDeviceClientState(state);
      throw new TypeError("Pending additional-device state is noncanonical");
    }
  } finally { canonical.fill(0); }
  return state;
}

function pendingStateEqual(
  left: PendingAdditionalDeviceClientState,
  right: PendingAdditionalDeviceClientState,
): boolean {
  const a = encodePendingState(left);
  const b = encodePendingState(right);
  try {
    return a.length === b.length
      && a.every((byte, index) => byte === b[index]);
  } finally { a.fill(0); b.fill(0); }
}

/**
 * Reuses the platform's encrypted profile vault under two isolated staged
 * coordinates. Each next revision is durably staged before the prior one is
 * removed, so begin, join, and post-activation Grant sync have no secret-loss
 * window.
 */
export function createProfileVaultPendingAdditionalDeviceStateVault(input: Readonly<{
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  clientKind: "browser" | "electron";
  crypto?: LatticeCrypto;
}>): PendingAdditionalDeviceClientStateVault {
  const crypto = input.crypto ?? new LatticeCrypto();
  const temporaryCoordinates = (revision: 1 | 2 | 3): ClientProfileCoordinates =>
    Object.freeze({
      ...input.coordinates,
      profileId: `${input.coordinates.profileId}:additional-pending-${revision}`,
    });
  const publicState = (bytes: Uint8Array) => ({
    clientKind: input.clientKind,
    publicFingerprint: hex(crypto.hash(bytes)),
  });

  async function readRevision(
    revision: 1 | 2 | 3,
  ): Promise<PendingAdditionalDeviceClientState | null> {
    if (input.vault.withOpenStagedProfile === undefined) {
      throw new Error("Encrypted profile vault cannot resume staged custody");
    }
    const coordinates = temporaryCoordinates(revision);
    const record = (await input.vault.listPublicProfiles()).find((candidate) =>
      candidate.lifecycle === "staged"
      && candidate.coordinates.profileId === coordinates.profileId
      && candidate.coordinates.deviceId === coordinates.deviceId
    );
    if (record?.stageId === undefined) return null;
    return input.vault.withOpenStagedProfile(
      coordinates,
      record.stageId,
      (value) => decodePendingState(value),
    );
  }

  const result: PendingAdditionalDeviceClientStateVault = {
    async load(idempotencyKey: string) {
      const current = await readRevision(3)
        ?? await readRevision(2)
        ?? await readRevision(1);
      if (current !== null && current.idempotencyKey !== idempotencyKey) {
        destroyPendingAdditionalDeviceClientState(current);
        throw new Error("Pending additional-device identity collided");
      }
      return current;
    },
    async create(value: PendingAdditionalDeviceClientState) {
      if ((await input.vault.unlock()).status !== "available") {
        throw new Error("Additional-device pending vault is unavailable");
      }
      const existing = await readRevision(3)
        ?? await readRevision(2)
        ?? await readRevision(1);
      if (existing !== null) {
        try { return pendingStateEqual(existing, value)
          ? "exact_duplicate" as const : "collision" as const; }
        finally { destroyPendingAdditionalDeviceClientState(existing); }
      }
      const encoded = encodePendingState(value);
      try {
        await input.vault.stageProfile({
          coordinates: temporaryCoordinates(value.revision),
          stageId: value.idempotencyKey,
          generation: 1,
          profileBytes: encoded,
          publicState: publicState(encoded),
        });
      } finally { encoded.fill(0); }
      return "inserted" as const;
    },
    async compareAndSwap({ expected, replacement }: Readonly<{
      expected: PendingAdditionalDeviceClientState;
      replacement: PendingAdditionalDeviceClientState;
    }>) {
      const current = await readRevision(expected.revision);
      if (current === null) return false;
      try { if (!pendingStateEqual(current, expected)) return false; }
      finally { destroyPendingAdditionalDeviceClientState(current); }
      const encoded = encodePendingState(replacement);
      try {
        await input.vault.stageProfile({
          coordinates: temporaryCoordinates(replacement.revision),
          stageId: replacement.idempotencyKey,
          generation: 1,
          profileBytes: encoded,
          publicState: publicState(encoded),
        });
      } finally { encoded.fill(0); }
      await input.vault.forgetProfile(temporaryCoordinates(expected.revision));
      return true;
    },
    async removeExact(value: PendingAdditionalDeviceClientState) {
      const current = await readRevision(value.revision);
      if (current === null) return false;
      try { if (!pendingStateEqual(current, value)) return false; }
      finally { destroyPendingAdditionalDeviceClientState(current); }
      await input.vault.forgetProfile(temporaryCoordinates(1));
      await input.vault.forgetProfile(temporaryCoordinates(2));
      await input.vault.forgetProfile(temporaryCoordinates(3));
      return true;
    },
  };
  return Object.freeze(result);
}
