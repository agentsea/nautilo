import { z } from "zod";

const portableId = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const productId = z.string().uuid().refine((value) => value === value.toLowerCase());
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const bytes = z.string().min(1).max(1_398_102)
  .regex(/^[A-Za-z0-9_-]+$/u).refine((value) => value.length % 4 !== 1);
const hash = bytes.length(43);

export const protectedInitialDeviceBeginRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  clientKind: z.enum(["browser", "electron"]),
  installationLineageDigestBase64url: hash,
  signingPublicKeyBase64url: bytes,
  encryptionPublicKeyBase64url: bytes,
  recoveryKeyId: portableId,
  recoveryPublicKeyBase64url: bytes,
  idempotencyKey: portableId,
}).strict();

const context = z.object({
  kind: z.literal("preparation"),
  authorityId: portableId,
}).strict();

export const protectedInitialDeviceChallengeV1Schema =
  protectedInitialDeviceBeginRequestV1Schema.omit({ requestVersion: true })
    .extend({
      formatVersion: z.literal(1),
      userId: productId,
      humanActorId: productId,
      context,
      challengeId: portableId,
      authorizationEvidenceDigestBase64url: hash,
      authorizationDigestBase64url: hash,
      issuedAt: counter,
      expiresAt: counter,
    }).strict().superRefine((value, refinement) => {
      if (value.expiresAt <= value.issuedAt
        || value.expiresAt - value.issuedAt > 300_000) {
        refinement.addIssue({ code: "custom", message: "Challenge expiry is invalid" });
      }
    });

export const protectedInitialDeviceCompleteRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  challenge: protectedInitialDeviceChallengeV1Schema,
  recoveryArchiveBytesBase64url: bytes,
  deviceProofBase64url: bytes,
}).strict();

export const protectedInitialDeviceReceiptRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  challengeId: portableId,
  publicFingerprintBase64url: hash,
}).strict();

export const protectedInitialDeviceReceiptV1Schema = z.object({
  formatVersion: z.literal(1),
  status: z.literal("active"),
  humanActorId: productId,
  deviceId: portableId,
  recoveryKeyId: portableId,
  recoveryGeneration: z.literal(1),
  deviceRevision: z.literal(1),
  custodyRevision: z.literal(1),
  auditRef: z.string().regex(/^bootstrap_[0-9a-f]{32}$/u),
  committedAt: counter,
}).strict();

const providerHead = z.object({
  providerId: portableId,
  domainId: portableId,
  epoch: z.literal(0),
  stateHashBase64url: hash,
}).strict();

export const protectedInitialHumanDomainPlanRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
}).strict();

export const protectedInitialHumanDomainPlanResponseV1Schema =
  z.discriminatedUnion("status", [
    z.object({
      formatVersion: z.literal(1),
      status: z.literal("planned"),
      operationId: portableId,
      humanId: productId,
      deviceId: portableId,
      domainId: portableId,
      currentDomainHead: z.null(),
      activeDeviceIds: z.array(portableId).length(1),
      trustedDeviceRevision: counter,
      trustedHostAuthorizationRevision: counter,
      deliveryHighWatermark: counter,
    }).strict(),
    z.object({
      formatVersion: z.literal(1),
      status: z.literal("active"),
      humanId: productId,
      deviceId: portableId,
      domainId: portableId,
      providerId: portableId,
      epoch: counter,
      stateHashBase64url: hash,
      trustedDeviceRevision: counter,
      trustedHostAuthorizationRevision: counter,
      deliveryHighWatermark: counter,
    }).strict(),
    z.object({
      formatVersion: z.literal(1),
      status: z.literal("unavailable"),
      reason: z.enum([
        "device_unavailable",
        "existing_domain_requires_delivery",
        "multiple_active_devices_require_fanout",
        "stale_identity",
      ]),
      migration: z.object({
        trustedDeviceRevision: counter,
        trustedHostAuthorizationRevision: counter,
        deliveryHighWatermark: counter,
      }).strict().optional(),
    }).strict(),
  ]);

export const protectedInitialHumanDomainRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  submission: z.object({
    formatVersion: z.literal(1),
    operationId: portableId,
    targetDomainId: portableId,
    participants: z.array(productId).length(1),
    participantDigestBase64url: hash,
    committerDeviceId: portableId,
    committerHumanId: productId,
    initialProviderHead: providerHead,
    initialRosterBytesBase64url: bytes,
    additions: z.tuple([]),
    chainDigestBase64url: hash,
    signatureBase64url: bytes,
  }).strict(),
}).strict();

export const protectedInitialHumanDomainReceiptV1Schema = z.object({
  formatVersion: z.literal(1),
  status: z.literal("active"),
  operationId: portableId,
  humanId: productId,
  deviceId: portableId,
  domainId: portableId,
  providerId: portableId,
  epoch: z.literal(0),
  stateHashBase64url: hash,
  rosterHashBase64url: hash,
  submissionDigestBase64url: hash,
  committedAt: counter,
}).strict();

export type ProtectedInitialDeviceBeginRequestV1 = z.infer<
  typeof protectedInitialDeviceBeginRequestV1Schema
>;
export type ProtectedInitialDeviceChallengeV1 = z.infer<
  typeof protectedInitialDeviceChallengeV1Schema
>;
export type ProtectedInitialDeviceCompleteRequestV1 = z.infer<
  typeof protectedInitialDeviceCompleteRequestV1Schema
>;
export type ProtectedInitialDeviceReceiptRequestV1 = z.infer<
  typeof protectedInitialDeviceReceiptRequestV1Schema
>;
export type ProtectedInitialDeviceReceiptV1 = z.infer<
  typeof protectedInitialDeviceReceiptV1Schema
>;
export type ProtectedInitialHumanDomainRequestV1 = z.infer<
  typeof protectedInitialHumanDomainRequestV1Schema
>;
export type ProtectedInitialHumanDomainPlanRequestV1 = z.infer<
  typeof protectedInitialHumanDomainPlanRequestV1Schema
>;
export type ProtectedInitialHumanDomainPlanResponseV1 = z.infer<
  typeof protectedInitialHumanDomainPlanResponseV1Schema
>;
export type ProtectedInitialHumanDomainReceiptV1 = z.infer<
  typeof protectedInitialHumanDomainReceiptV1Schema
>;
