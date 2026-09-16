import { z } from "zod";

const portableId = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const productId = z.string().uuid().refine((value) => value === value.toLowerCase());
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bytes = z.string().min(1).max(89_478_486)
  .regex(/^[A-Za-z0-9_-]+$/u).refine((value) => value.length % 4 !== 1);
const hash = bytes.length(43);
const signingPublicKey = bytes.length(43);
const encryptionPublicKey = bytes.length(87);
export const PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE = 12;
export const PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS = 256;

export const protectedAdditionalDeviceBeginRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  clientKind: z.enum(["browser", "electron"]),
  installationLineageDigestBase64url: hash,
  deviceGeneration: z.literal(1),
  signingPublicKeyBase64url: signingPublicKey,
  encryptionPublicKeyBase64url: encryptionPublicKey,
  idempotencyKey: portableId,
}).strict();

export const protectedAdditionalDeviceEnrollmentV1Schema = z.object({
  formatVersion: z.literal(1),
  operationId: portableId,
  challengeId: portableId,
  userId: productId,
  humanActorId: productId,
  deviceId: portableId,
  clientKind: z.enum(["browser", "electron"]),
  installationLineageDigestBase64url: hash,
  deviceGeneration: z.literal(1),
  signingPublicKeyBase64url: signingPublicKey,
  encryptionPublicKeyBase64url: encryptionPublicKey,
  method: z.literal("device_approval"),
  idempotencyKey: portableId,
  authorizationEvidenceDigestBase64url: hash,
  authorizationDigestBase64url: hash,
  expectedCustodyRevision: counter,
  expectedRecoveryGeneration: counter,
  inventoryRevision: counter,
  inventoryCount: counter.max(4_096),
  inventoryDigestBase64url: hash,
  deviceRevision: z.literal(0),
  status: z.literal("pending"),
  issuedAt: counter,
  expiresAt: counter,
}).strict().superRefine((value, refinement) => {
  if (value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > 300_000) {
    refinement.addIssue({ code: "custom", message: "Enrollment expiry is invalid" });
  }
});

const providerHead = z.object({
  providerId: portableId,
  domainId: portableId,
  epoch: counter,
  stateHashBase64url: hash,
}).strict();

const namespaceSource = z.object({
  namespaceId: portableId,
  accessRevision: counter,
  bindingHashBase64url: hash,
  bindingProofBytesBase64url: z.array(bytes).min(1).max(4_096),
  humanEnvelopeBytesBase64url: bytes,
  aiEnvelopeBytesBase64url: bytes,
}).strict();

const domainPlan = z.object({
  domainId: portableId,
  expectedHead: providerHead,
  authorizationRevision: counter,
  participantDigestBase64url: hash,
  rosterBytesBase64url: bytes,
  committerDeviceId: portableId,
  committerSigningPublicKeyBase64url: signingPublicKey,
  namespaces: z.array(namespaceSource).max(256),
}).strict();

const domainPage = z.object({
  start: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
  end: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
  nextStart: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS).nullable(),
  pageDigestBase64url: hash,
}).strict().superRefine((value, refinement) => {
  if (
    value.end < value.start
    || value.end - value.start > PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE
    || (value.nextStart !== null && value.nextStart !== value.end)
  ) {
    refinement.addIssue({ code: "custom", message: "Domain page range is invalid" });
  }
});

export const protectedAdditionalDevicePlanV1Schema = z.object({
  formatVersion: z.literal(1),
  progress: z.enum([
    "approval_required",
    "transfer_ready",
    "awaiting_target",
  ]).optional(),
  enrollment: protectedAdditionalDeviceEnrollmentV1Schema,
  domains: z.array(domainPlan).min(1).max(12),
}).strict();

export const protectedAdditionalDeviceBeginRequestV2Schema =
  protectedAdditionalDeviceBeginRequestV1Schema.extend({
    requestVersion: z.literal(2),
    pageStart: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
  }).strict();

export const protectedAdditionalDevicePlanPageRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  deviceId: portableId,
  pageStart: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
}).strict();

export const protectedAdditionalDevicePlanV2Schema = z.object({
  formatVersion: z.literal(2),
  progress: z.enum([
    "approval_required",
    "transfer_ready",
    "awaiting_target",
  ]).optional(),
  enrollment: protectedAdditionalDeviceEnrollmentV1Schema,
  approver: z.object({
    deviceId: portableId,
    signingPublicKeyBase64url: signingPublicKey,
  }).strict(),
  personalAuthority: z.object({
    roomId: productId,
    namespaceId: productId,
  }).strict().nullable(),
  domainCount: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
  page: domainPage,
  domains: z.array(domainPlan).max(PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE),
}).strict().superRefine((value, refinement) => {
  if (
    value.page.end > value.domainCount
    || value.page.end - value.page.start !== value.domains.length
    || (value.page.nextStart === null) !== (value.page.end === value.domainCount)
  ) {
    refinement.addIssue({ code: "custom", message: "Domain page is incomplete" });
  }
});

const deviceJoinPackage = z.object({
  formatVersion: z.literal(1),
  providerId: portableId,
  domainId: portableId,
  humanId: productId,
  deviceId: portableId,
  expectedEpoch: counter,
  expectedProviderHeadHashBase64url: hash,
  generation: z.literal(1),
  packageId: portableId,
  packageHashBase64url: hash,
  keyPackageBytesBase64url: bytes,
  createdAt: counter,
  expiresAt: counter,
  signatureBase64url: bytes,
}).strict();

export const protectedAdditionalDeviceJoinPackagesRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  packages: z.array(deviceJoinPackage).min(1).max(12),
}).strict();

export const protectedAdditionalDeviceJoinPackagesRequestV2Schema =
  protectedAdditionalDeviceJoinPackagesRequestV1Schema.extend({
    requestVersion: z.literal(2),
    packages: z.array(deviceJoinPackage)
      .max(PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE),
  }).strict();

const additionalDeviceApprovalManifest = z.object({
  formatVersion: z.literal(1),
  operationId: portableId,
  humanId: productId,
  targetDeviceId: portableId,
  issuerDeviceId: portableId,
  expectedDeviceRevision: z.literal(0),
  expectedCustodyRevision: counter,
  expectedRecoveryGeneration: counter,
  inventoryRevision: counter,
  inventoryCount: counter.max(4_096),
  inventoryDigestBase64url: hash,
  approvalHashBase64url: hash,
  signatureBase64url: bytes,
}).strict();

const transitionSubmission = z.object({
  domainId: portableId,
  claim: z.object({
    state: z.enum(["awaiting_committer", "preparing"]),
    workerId: portableId,
    retryCount: counter,
    leaseExpiresAt: counter,
  }).strict(),
  providerSubmissionBytesBase64url: bytes,
  namespaceSubmissionBytesBase64url: bytes,
}).strict();

const transitionSubmissionV2 = z.object({
  domainId: portableId,
  providerSubmissionBytesBase64url: bytes,
  namespaceSubmissionBytesBase64url: bytes,
}).strict();

export const protectedAdditionalDeviceApprovalRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  approverDeviceId: portableId,
  approvalBytesBase64url: bytes,
  manifest: additionalDeviceApprovalManifest,
}).strict();

export const protectedAdditionalDeviceApprovalResponseV1Schema = z.object({
  formatVersion: z.literal(1),
  status: z.enum(["admitted", "duplicate", "syncing"]),
  operationId: portableId,
  targetDeviceId: portableId,
  completedDomains: counter,
  requiredDomains: counter,
}).strict();

export const protectedAdditionalDeviceTransitionPlanRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  approverDeviceId: portableId,
}).strict();

export const protectedAdditionalDeviceTransitionPlanRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  approverDeviceId: portableId,
  pageStart: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
}).strict();

export const protectedAdditionalDeviceTransitionPlanV1Schema = z.object({
  formatVersion: z.literal(1),
  operationId: portableId,
  targetDeviceId: portableId,
  domains: z.array(z.object({
    plan: domainPlan,
    claim: z.object({
      state: z.enum(["awaiting_committer", "preparing"]),
      workerId: portableId,
      retryCount: counter,
      leaseExpiresAt: counter,
    }).strict(),
    joinPackageBytesBase64url: bytes,
  }).strict()).min(1).max(12),
}).strict();

export const protectedAdditionalDeviceTransitionPlanV2Schema = z.object({
  formatVersion: z.literal(2),
  operationId: portableId,
  targetDeviceId: portableId,
  domainCount: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
  page: domainPage,
  domains: z.array(z.object({
    plan: domainPlan,
    joinPackageBytesBase64url: bytes,
  }).strict()).max(PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE),
}).strict().superRefine((value, refinement) => {
  if (
    value.page.end > value.domainCount
    || value.page.end - value.page.start !== value.domains.length
    || (value.page.nextStart === null) !== (value.page.end === value.domainCount)
  ) {
    refinement.addIssue({ code: "custom", message: "Transition page is incomplete" });
  }
});

export const protectedAdditionalDeviceTransitionsRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  approverDeviceId: portableId,
  transitions: z.array(transitionSubmission).min(1).max(12),
}).strict();

export const protectedAdditionalDeviceTransitionsRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  approverDeviceId: portableId,
  inventoryRevision: counter,
  inventoryCount: counter.max(4_096),
  inventoryDigestBase64url: hash,
  domainCount: counter.max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
  transitions: z.array(transitionSubmissionV2)
    .max(PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS),
}).strict().superRefine((value, refinement) => {
  if (value.transitions.length !== value.domainCount) {
    refinement.addIssue({
      code: "custom",
      message: "Transition campaign is incomplete",
    });
  }
});

export const protectedAdditionalDevicePendingListRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  approverDeviceId: portableId,
}).strict();

export const protectedAdditionalDevicePendingListV1Schema = z.object({
  formatVersion: z.literal(1),
  pending: z.array(protectedAdditionalDevicePlanV1Schema).max(4),
}).strict();

export const protectedAdditionalDevicePendingListRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  approverDeviceId: portableId,
}).strict();

export const protectedAdditionalDevicePendingListV2Schema = z.object({
  formatVersion: z.literal(2),
  pending: z.array(protectedAdditionalDevicePlanV2Schema).max(4),
}).strict();

const deliveryMessage = z.object({
  messageId: portableId,
  operationId: portableId,
  domainId: portableId.nullable(),
  recipientSequence: counter,
  kind: z.enum(["device_transfer", "public_state"]),
  formatVersion: z.literal(1),
  payloadHashBase64url: hash,
  payloadBytesBase64url: bytes,
  createdAt: counter,
  expiresAt: counter,
}).strict();

export const protectedAdditionalDeviceDeliveriesRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  requestId: portableId,
  humanId: productId,
  deviceId: portableId,
  expectedDeviceRevision: counter,
  minimumHighWatermark: counter,
  maximumMessages: z.number().int().min(1).max(4_096),
  maximumPayloadBytes: z.number().int().min(1_048_616).max(64 * 1_048_576),
  issuedAt: counter,
  expiresAt: counter,
  signatureBase64url: bytes,
}).strict().superRefine((value, refinement) => {
  if (value.expiresAt <= value.issuedAt
    || value.expiresAt - value.issuedAt > 300_000) {
    refinement.addIssue({ code: "custom", message: "Delivery proof expiry is invalid" });
  }
});

export const protectedAdditionalDeviceDeliveriesV1Schema = z.object({
  formatVersion: z.literal(1),
  operationId: portableId,
  deviceId: portableId,
  highWatermark: counter,
  messages: z.array(deliveryMessage).max(4_096),
}).strict();

export const protectedAdditionalDeviceAcknowledgementRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  messageId: portableId,
  recipientSequence: counter,
  payloadHashBase64url: hash,
  processedRevision: counter,
  acknowledgedAt: counter,
  acknowledgementDigestBase64url: hash,
  signatureBase64url: bytes,
}).strict();

export const protectedAdditionalDeviceActivationRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
}).strict();

export const protectedAdditionalDeviceActivationV1Schema = z.object({
  formatVersion: z.literal(1),
  status: z.enum(["active", "syncing"]),
  syncReason: z.enum([
    "delivery_pending",
    "current_domain_sync_required",
  ]).optional(),
  operationId: portableId,
  deviceId: portableId,
  deviceRevision: counter.nullable(),
  custodyRevision: counter.nullable(),
}).strict().superRefine((value, refinement) => {
  if ((value.status === "syncing") !== (value.syncReason !== undefined)) {
    refinement.addIssue({
      code: "custom",
      message: "Additional-device synchronization reason is inconsistent",
    });
  }
});

export type ProtectedAdditionalDeviceBeginRequestV1 = z.infer<
  typeof protectedAdditionalDeviceBeginRequestV1Schema
>;
export type ProtectedAdditionalDeviceEnrollmentV1 = z.infer<
  typeof protectedAdditionalDeviceEnrollmentV1Schema
>;
export type ProtectedAdditionalDevicePlanV1 = z.infer<
  typeof protectedAdditionalDevicePlanV1Schema
>;
export type ProtectedAdditionalDeviceJoinPackagesRequestV1 = z.infer<
  typeof protectedAdditionalDeviceJoinPackagesRequestV1Schema
>;
export type ProtectedAdditionalDeviceApprovalRequestV1 = z.infer<
  typeof protectedAdditionalDeviceApprovalRequestV1Schema
>;
export type ProtectedAdditionalDeviceApprovalResponseV1 = z.infer<
  typeof protectedAdditionalDeviceApprovalResponseV1Schema
>;
export type ProtectedAdditionalDeviceTransitionPlanRequestV1 = z.infer<
  typeof protectedAdditionalDeviceTransitionPlanRequestV1Schema
>;
export type ProtectedAdditionalDeviceTransitionPlanV1 = z.infer<
  typeof protectedAdditionalDeviceTransitionPlanV1Schema
>;
export type ProtectedAdditionalDeviceTransitionsRequestV1 = z.infer<
  typeof protectedAdditionalDeviceTransitionsRequestV1Schema
>;
export type ProtectedAdditionalDevicePendingListRequestV1 = z.infer<
  typeof protectedAdditionalDevicePendingListRequestV1Schema
>;
export type ProtectedAdditionalDevicePendingListV1 = z.infer<
  typeof protectedAdditionalDevicePendingListV1Schema
>;
export type ProtectedAdditionalDeviceDeliveriesRequestV1 = z.infer<
  typeof protectedAdditionalDeviceDeliveriesRequestV1Schema
>;
export type ProtectedAdditionalDeviceDeliveriesV1 = z.infer<
  typeof protectedAdditionalDeviceDeliveriesV1Schema
>;
export type ProtectedAdditionalDeviceAcknowledgementRequestV1 = z.infer<
  typeof protectedAdditionalDeviceAcknowledgementRequestV1Schema
>;
export type ProtectedAdditionalDeviceActivationRequestV1 = z.infer<
  typeof protectedAdditionalDeviceActivationRequestV1Schema
>;
export type ProtectedAdditionalDeviceActivationV1 = z.infer<
  typeof protectedAdditionalDeviceActivationV1Schema
>;
export type ProtectedAdditionalDeviceBeginRequestV2 = z.infer<
  typeof protectedAdditionalDeviceBeginRequestV2Schema
>;
export type ProtectedAdditionalDevicePlanPageRequestV2 = z.infer<
  typeof protectedAdditionalDevicePlanPageRequestV2Schema
>;
export type ProtectedAdditionalDevicePlanV2 = z.infer<
  typeof protectedAdditionalDevicePlanV2Schema
>;
export type ProtectedAdditionalDeviceJoinPackagesRequestV2 = z.infer<
  typeof protectedAdditionalDeviceJoinPackagesRequestV2Schema
>;
export type ProtectedAdditionalDeviceTransitionPlanRequestV2 = z.infer<
  typeof protectedAdditionalDeviceTransitionPlanRequestV2Schema
>;
export type ProtectedAdditionalDeviceTransitionPlanV2 = z.infer<
  typeof protectedAdditionalDeviceTransitionPlanV2Schema
>;
export type ProtectedAdditionalDeviceTransitionsRequestV2 = z.infer<
  typeof protectedAdditionalDeviceTransitionsRequestV2Schema
>;
export type ProtectedAdditionalDevicePendingListRequestV2 = z.infer<
  typeof protectedAdditionalDevicePendingListRequestV2Schema
>;
export type ProtectedAdditionalDevicePendingListV2 = z.infer<
  typeof protectedAdditionalDevicePendingListV2Schema
>;
