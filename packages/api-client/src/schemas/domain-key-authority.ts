import { z } from "zod";

const portableId = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const keyClass = z.enum(["human", "ai"]);
const bytes = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u);
const sha256Bytes = bytes.max(43);
const counter = z.number().int().nonnegative().safe();
const positiveCounter = z.number().int().positive().safe();

const unavailableReason = z.enum([
  "domain_unavailable",
  "device_unavailable",
  "authority_inconsistent",
  "head_unavailable",
  "recipient_unavailable",
  "recipient_sync_required",
  "request_unavailable",
  "bundle_unavailable",
]);

export const domainKeyAuthorityPlanRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
}).strict();

export const domainKeyAuthorityPlanResponseV2Schema =
  z.discriminatedUnion("status", [
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("create_required"),
      domainId: portableId,
      participantDigestBase64url: sha256Bytes,
      participantCount: positiveCounter,
      keyClass,
      domainKeyGeneration: positiveCounter,
      authorizationRevision: positiveCounter,
      previousHeadDigestBase64url: sha256Bytes.nullable(),
      issuerHumanId: portableId,
      issuerDeviceId: portableId,
      issuerDeviceSigningGeneration: positiveCounter,
      issuerSigningPublicKeyBase64url: bytes.max(683),
      recipientEncryptionPublicKeyBase64url: bytes.max(683),
      recipientPublicKeyDigestBase64url: sha256Bytes,
      recoveryKeyId: portableId,
      recoveryKeyGeneration: positiveCounter,
      recoveryPublicKeyBase64url: bytes.max(683),
      recoveryPublicKeyDigestBase64url: sha256Bytes,
      issuedAt: counter,
      deadlineAt: positiveCounter,
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("ready"),
      domainId: portableId,
      participantDigestBase64url: sha256Bytes,
      participantCount: positiveCounter,
      keyClass,
      domainKeyGeneration: positiveCounter,
      authorizationRevision: positiveCounter,
      headDigestBase64url: sha256Bytes,
      headBytesBase64url: bytes.max(10_923),
      issuerSigningPublicKeyBase64url: bytes.max(683),
      recipientDeviceSigningGeneration: positiveCounter,
      recipientDeviceRevision: counter,
      recipientEnvelope: z.object({
        envelopeBytesBase64url: bytes.max(21_846),
        envelopeDigestBase64url: sha256Bytes,
        issuerSigningPublicKeyBase64url: bytes.max(683),
      }).strict().nullable(),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("unavailable"),
      reason: unavailableReason,
    }).strict(),
  ]).superRefine((value, context) => {
    if (value.status !== "create_required") return;
    const genesis = value.domainKeyGeneration === 1
      && value.authorizationRevision === 1
      && value.previousHeadDigestBase64url === null;
    const successor = value.domainKeyGeneration > 1
      && value.authorizationRevision > 1
      && value.previousHeadDigestBase64url !== null;
    if (!genesis && !successor) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Domain key predecessor coordinates are incoherent",
      });
    }
  });

export const domainKeyAuthorityPublishRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
  operationId: portableId,
  idempotencyKey: portableId,
  headBytesBase64url: bytes.max(10_923),
  envelopeBytesBase64url: bytes.max(21_846),
  authorizationBytesBase64url: bytes.max(43_691),
  recoveryEnvelopeBytesBase64url: bytes.max(21_846),
  recoveryAuthorizationBytesBase64url: bytes.max(43_691),
}).strict();

export const domainKeyAuthorityPublishResponseV2Schema = z.object({
  responseVersion: z.literal(2),
  status: z.enum(["published", "replayed"]),
  operationId: portableId,
  domainId: portableId,
  keyClass,
  domainKeyGeneration: positiveCounter,
  authorizationRevision: positiveCounter,
  headDigestBase64url: sha256Bytes,
  envelopeDigestBase64url: sha256Bytes,
  recoveryEnvelopeDigestBase64url: sha256Bytes,
}).strict();

export const domainKeyRecipientRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
  requestId: portableId,
  idempotencyKey: portableId,
  requestBytesBase64url: bytes.max(10_923),
}).strict();

export const domainKeyRecipientRequestResponseV2Schema = z.object({
  responseVersion: z.literal(2),
  status: z.enum(["requested", "replayed", "already_delivered"]),
  requestId: portableId,
  requestDigestBase64url: sha256Bytes,
}).strict();

export const domainKeyPendingRequestListV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
  limit: z.number().int().min(1).max(32).optional(),
}).strict();

export const domainKeyPendingRequestListResponseV2Schema = z.object({
  responseVersion: z.literal(2),
  requests: z.array(z.object({
    requestId: portableId,
    requestBytesBase64url: bytes.max(10_923),
    requestDigestBase64url: sha256Bytes,
    domainId: portableId,
    keyClass,
    domainKeyGeneration: positiveCounter,
    authorizationRevision: positiveCounter,
    headDigestBase64url: sha256Bytes,
    recipientHumanId: portableId,
    recipientDeviceId: portableId,
    recipientDeviceGeneration: positiveCounter,
    recipientSigningPublicKeyBase64url: bytes.max(683),
    recipientEncryptionPublicKeyBase64url: bytes.max(683),
    recipientPublicKeyDigestBase64url: sha256Bytes,
  }).strict()).max(32),
}).strict();

export const domainKeyPendingSourceListV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  limit: z.number().int().min(1).max(32).optional(),
}).strict();

export const domainKeyPendingSourceListResponseV2Schema = z.object({
  responseVersion: z.literal(2),
  work: z.array(z.object({
    sourceRoomId: z.string().uuid(),
    namespaceId: z.string().uuid(),
    keyClass,
  }).strict()).max(32),
}).strict();

export const domainKeyRecipientFulfilRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
  requestId: portableId,
  authorizationBytesBase64url: bytes.max(43_691),
}).strict();

export const domainKeyRecipientFulfilResponseV2Schema = z.object({
  responseVersion: z.literal(2),
  status: z.enum(["fulfilled", "replayed", "lost_race"]),
  requestId: portableId,
  envelopeDigestBase64url: sha256Bytes,
  authorizationDigestBase64url: sha256Bytes,
}).strict();

export const domainKeyEnvelopeFetchRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
  recipientKind: z.enum(["device", "recovery"]).optional(),
  recoveryKeyId: portableId.optional(),
  recoveryKeyGeneration: positiveCounter.optional(),
}).strict().superRefine((value, context) => {
  const recovery = value.recipientKind === "recovery";
  if (recovery !== (value.recoveryKeyId !== undefined)
    || recovery !== (value.recoveryKeyGeneration !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Recovery-envelope coordinates are incomplete",
    });
  }
});

export const domainKeyEnvelopeFetchResponseV2Schema =
  z.discriminatedUnion("status", [
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("ready"),
      requestDigestBase64url: sha256Bytes.nullable(),
      envelopeBytesBase64url: bytes.max(21_846),
      envelopeDigestBase64url: sha256Bytes,
      issuerSigningPublicKeyBase64url: bytes.max(683),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      status: z.enum(["pending", "unavailable"]),
    }).strict(),
  ]);

export const domainKeyEnvelopeAcknowledgeRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
  acknowledgementBytesBase64url: bytes.max(10_923),
}).strict();

export const domainKeyEnvelopeAcknowledgeResponseV2Schema = z.object({
  responseVersion: z.literal(2),
  status: z.enum(["acknowledged", "replayed"]),
  acknowledgementDigestBase64url: sha256Bytes,
}).strict();

export const domainNamespaceBundlePlanRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
}).strict();

export const domainNamespaceBundlePlanResponseV2Schema =
  z.discriminatedUnion("status", [
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("create_required"),
      domainId: portableId,
      participantDigestBase64url: sha256Bytes,
      participantCount: positiveCounter,
      keyClass,
      domainKeyGeneration: positiveCounter,
      domainAuthorizationRevision: positiveCounter,
      domainHeadDigestBase64url: sha256Bytes,
      namespaceId: z.string().uuid(),
      namespaceAccessRevision: counter,
      namespaceCurrentGeneration: z.literal(0),
      bundleRevision: z.literal(1),
      retainedGenerationCount: z.literal(1),
      previousBindingDigestBase64url: z.null(),
      issuerHumanId: portableId,
      issuerDeviceId: portableId,
      issuerDeviceSigningGeneration: positiveCounter,
      issuerSigningPublicKeyBase64url: bytes.max(683),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("replace_required"),
      domainId: portableId,
      participantDigestBase64url: sha256Bytes,
      participantCount: positiveCounter,
      keyClass,
      domainKeyGeneration: positiveCounter,
      domainAuthorizationRevision: positiveCounter,
      domainHeadDigestBase64url: sha256Bytes,
      namespaceId: z.string().uuid(),
      namespaceAccessRevision: counter,
      namespaceCurrentGeneration: counter,
      bundleRevision: positiveCounter,
      retainedGenerationCount: positiveCounter,
      advanceGeneration: z.boolean(),
      previousBindingDigestBase64url: sha256Bytes,
      sourceBindingBytesBase64url: bytes.max(699_051),
      sourceBindingDigestBase64url: sha256Bytes,
      sourceIssuerSigningPublicKeyBase64url: bytes.max(683),
      sourceEnvelopeBytesBase64url: bytes.max(21_846),
      sourceEnvelopeDigestBase64url: sha256Bytes,
      sourceEnvelopeIssuerSigningPublicKeyBase64url: bytes.max(683),
      sourceRecipientDeviceSigningGeneration: positiveCounter,
      issuerHumanId: portableId,
      issuerDeviceId: portableId,
      issuerDeviceSigningGeneration: positiveCounter,
      issuerSigningPublicKeyBase64url: bytes.max(683),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("ready"),
      domainId: portableId,
      keyClass,
      bindingBytesBase64url: bytes.max(699_051),
      bindingDigestBase64url: sha256Bytes,
      issuerSigningPublicKeyBase64url: bytes.max(683),
    }).strict(),
    z.object({
      responseVersion: z.literal(2),
      status: z.literal("unavailable"),
      reason: unavailableReason,
    }).strict(),
  ]);

export const domainNamespaceBundlePublishRequestV2Schema = z.object({
  requestVersion: z.literal(2),
  serverId: portableId,
  clientDeviceId: portableId,
  keyClass,
  operationId: portableId,
  idempotencyKey: portableId,
  bindingBytesBase64url: bytes.max(699_051),
}).strict();

export const domainNamespaceBundlePublishResponseV2Schema = z.object({
  responseVersion: z.literal(2),
  status: z.enum(["published", "replayed"]),
  operationId: portableId,
  namespaceId: z.string().uuid(),
  domainId: portableId,
  keyClass,
  bindingDigestBase64url: sha256Bytes,
}).strict();

export type DomainKeyAuthorityPlanRequestV2 = z.infer<
  typeof domainKeyAuthorityPlanRequestV2Schema
>;
export type DomainKeyAuthorityPlanResponseV2 = z.infer<
  typeof domainKeyAuthorityPlanResponseV2Schema
>;
export type DomainKeyAuthorityPublishRequestV2 = z.infer<
  typeof domainKeyAuthorityPublishRequestV2Schema
>;
export type DomainKeyAuthorityPublishResponseV2 = z.infer<
  typeof domainKeyAuthorityPublishResponseV2Schema
>;
export type DomainKeyRecipientRequestV2 = z.infer<
  typeof domainKeyRecipientRequestV2Schema
>;
export type DomainKeyRecipientRequestResponseV2 = z.infer<
  typeof domainKeyRecipientRequestResponseV2Schema
>;
export type DomainKeyPendingRequestListV2 = z.infer<
  typeof domainKeyPendingRequestListV2Schema
>;
export type DomainKeyPendingRequestListResponseV2 = z.infer<
  typeof domainKeyPendingRequestListResponseV2Schema
>;
export type DomainKeyPendingSourceListV2 = z.infer<
  typeof domainKeyPendingSourceListV2Schema
>;
export type DomainKeyPendingSourceListResponseV2 = z.infer<
  typeof domainKeyPendingSourceListResponseV2Schema
>;
export type DomainKeyRecipientFulfilRequestV2 = z.infer<
  typeof domainKeyRecipientFulfilRequestV2Schema
>;
export type DomainKeyRecipientFulfilResponseV2 = z.infer<
  typeof domainKeyRecipientFulfilResponseV2Schema
>;
export type DomainKeyEnvelopeFetchRequestV2 = z.infer<
  typeof domainKeyEnvelopeFetchRequestV2Schema
>;
export type DomainKeyEnvelopeFetchResponseV2 = z.infer<
  typeof domainKeyEnvelopeFetchResponseV2Schema
>;
export type DomainKeyEnvelopeAcknowledgeRequestV2 = z.infer<
  typeof domainKeyEnvelopeAcknowledgeRequestV2Schema
>;
export type DomainKeyEnvelopeAcknowledgeResponseV2 = z.infer<
  typeof domainKeyEnvelopeAcknowledgeResponseV2Schema
>;
export type DomainNamespaceBundlePlanRequestV2 = z.infer<
  typeof domainNamespaceBundlePlanRequestV2Schema
>;
export type DomainNamespaceBundlePlanResponseV2 = z.infer<
  typeof domainNamespaceBundlePlanResponseV2Schema
>;
export type DomainNamespaceBundlePublishRequestV2 = z.infer<
  typeof domainNamespaceBundlePublishRequestV2Schema
>;
export type DomainNamespaceBundlePublishResponseV2 = z.infer<
  typeof domainNamespaceBundlePublishResponseV2Schema
>;
