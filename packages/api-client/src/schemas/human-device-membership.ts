import { z } from "zod";

import { protectedAdditionalDeviceEnrollmentV1Schema } from
  "./protected-additional-device";

const portableId = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const uuid = z.string().uuid().refine((value) => value === value.toLowerCase());
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// Base64url expansion of the canonical 3,145,728-byte transition maximum.
export const HUMAN_DEVICE_MEMBERSHIP_MAX_BASE64URL_BYTES_V1 = 4_194_304;
const bytes = z.string().min(1)
  .max(HUMAN_DEVICE_MEMBERSHIP_MAX_BASE64URL_BYTES_V1)
  .regex(/^[A-Za-z0-9_-]+$/u).refine((value) => value.length % 4 !== 1);
const hash = bytes.length(43);

export const humanDeviceMembershipStatusRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  afterSequence: counter.optional(),
}).strict();

const humanDeviceGroupHeadV1Schema = z.object({
  headBytesBase64url: bytes,
  sequence: counter,
}).strict();

const humanDeviceGroupCommitV1Schema = z.object({
  sequence: counter,
  transitionBytesBase64url: bytes,
}).strict();

const personalAuthorityV1Schema = z.object({
  roomId: uuid,
  namespaceId: uuid,
}).strict();

export const humanDeviceMembershipStatusV1Schema = z.object({
  formatVersion: z.literal(1),
  serverInstanceId: uuid,
  humanId: uuid,
  deviceId: portableId,
  deviceGeneration: counter.min(1),
  deviceRevision: counter,
  membershipState: z.enum([
    "absent",
    "unbound",
    "pending",
    "welcome_pending",
    "catching_up",
    "current",
    "stale",
    "removed",
  ]),
  personalAuthority: personalAuthorityV1Schema.nullable(),
  head: humanDeviceGroupHeadV1Schema.nullable(),
  welcome: z.object({
    operationId: portableId,
    sequence: counter,
    transitionBytesBase64url: bytes,
    welcomeBytesBase64url: bytes,
  }).strict().nullable(),
  targetJoin: z.object({
    operationId: portableId,
    requestBytesBase64url: bytes,
  }).strict().nullable(),
  commits: z.array(humanDeviceGroupCommitV1Schema).max(64),
  nextSequence: counter.nullable(),
}).strict();

export const humanDeviceMembershipInitialRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  headBytesBase64url: bytes,
  rosterBytesBase64url: bytes,
}).strict();

export const humanDeviceMembershipBeginRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  clientKind: z.enum(["browser", "electron"]),
  installationLineageDigestBase64url: hash,
  deviceGeneration: z.literal(1),
  signingPublicKeyBase64url: bytes.length(43),
  encryptionPublicKeyBase64url: bytes.length(87),
  idempotencyKey: portableId,
}).strict();

export const humanDeviceMembershipBeginV1Schema = z.object({
  formatVersion: z.literal(1),
  enrollment: protectedAdditionalDeviceEnrollmentV1Schema,
  serverInstanceId: uuid,
  head: humanDeviceGroupHeadV1Schema,
  personalAuthority: personalAuthorityV1Schema.nullable(),
}).strict();

export const humanDeviceMembershipJoinRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  requestBytesBase64url: bytes,
}).strict();

export const humanDeviceMembershipPendingRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  approverDeviceId: portableId,
  afterOperationId: portableId.optional(),
}).strict();

export const humanDeviceMembershipRosterRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  currentDeviceId: portableId,
}).strict();

export const humanDeviceMembershipRosterV1Schema = z.object({
  formatVersion: z.literal(1),
  currentDeviceId: portableId,
  currentMemberCount: counter.min(1),
  devices: z.array(z.object({
    deviceId: portableId,
    clientKind: z.enum(["browser", "electron", "tui"]),
    deviceGeneration: counter.min(1),
    deviceRevision: counter,
    membershipState: z.enum([
      "pending",
      "welcome_pending",
      "catching_up",
      "current",
      "stale",
      "removed",
    ]),
    isCurrentDevice: z.boolean(),
    canRemove: z.boolean(),
    publicFingerprintBase64url: hash,
    membershipEvidence: z.object({
      lineageGeneration: counter.min(1),
      epoch: counter,
      securityRevision: counter.min(1),
      acknowledgedSequence: counter,
      headDigestBase64url: hash,
    }).strict().nullable(),
    admissionEvidence: z.object({
      lastProvedAt: counter,
      expiresAt: counter,
    }).strict().nullable(),
    domainKeyCoverage: z.object({
      acknowledged: counter,
      required: counter,
    }).strict().refine(
      (value) => value.acknowledged <= value.required,
      { message: "Acknowledged Domain-key coverage exceeds required coverage" },
    ),
    deliveryEvidence: z.object({
      acknowledgedSequence: counter,
      highWatermark: counter,
      blocked: z.object({
        sequence: counter,
        operationId: portableId,
        at: counter,
        reason: portableId,
      }).strict().nullable(),
    }).strict().refine(
      (value) => value.acknowledgedSequence <= value.highWatermark,
      { message: "Acknowledged delivery sequence exceeds high-watermark" },
    ),
    createdAt: counter,
    lastSeenAt: counter.nullable(),
    revokedAt: counter.nullable(),
  }).strict()),
}).strict();

export const humanDeviceMembershipPendingV1Schema = z.object({
  formatVersion: z.literal(1),
  pending: z.array(z.object({
    operationId: portableId,
    targetDeviceId: portableId,
    targetClientKind: z.enum(["browser", "electron"]),
    targetDeviceGeneration: counter.min(1),
    targetSigningPublicKeyBase64url: bytes.length(43),
    requestBytesBase64url: bytes,
    createdAt: counter,
  }).strict()).max(64),
  nextOperationId: portableId.nullable(),
}).strict();

export const humanDeviceMembershipAddRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  committerDeviceId: portableId,
  transitionBytesBase64url: bytes,
  welcomeBytesBase64url: bytes,
}).strict();

export const humanDeviceMembershipRemoveRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  committerDeviceId: portableId,
  transitionBytesBase64url: bytes,
  pin: z.string().regex(/^\d{6,8}$/u),
}).strict();

export const humanDeviceMembershipRecoveryBeginRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  clientKind: z.enum(["browser", "electron"]),
  installationLineageDigestBase64url: hash,
  deviceGeneration: z.literal(1),
  signingPublicKeyBase64url: bytes.length(43),
  encryptionPublicKeyBase64url: bytes.length(87),
  idempotencyKey: portableId,
}).strict();

export const humanDeviceMembershipRecoveryBeginV1Schema = z.object({
  formatVersion: z.literal(1),
  operationId: portableId,
  challengeBytesBase64url: bytes,
  serverInstanceId: uuid,
  currentLineageGeneration: counter.min(1),
  nextLineageGeneration: counter.min(2),
  personalAuthority: personalAuthorityV1Schema.nullable(),
}).strict().superRefine((value, refinement) => {
  if (value.nextLineageGeneration !== value.currentLineageGeneration + 1) {
    refinement.addIssue({
      code: "custom",
      message: "Recovery lineage must advance exactly once",
    });
  }
});

export const humanDeviceMembershipRecoveryCompleteRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  challengeHashBase64url: hash,
  responseBase64url: hash,
  headBytesBase64url: bytes,
  rosterBytesBase64url: bytes,
}).strict();

export const humanDeviceMembershipAcknowledgementRequestV1Schema = z.object({
  requestVersion: z.literal(1),
  deviceId: portableId,
  sequence: counter,
  headDigestBase64url: hash,
  leafIndex: counter,
}).strict();

export const humanDeviceMembershipMutationV1Schema = z.object({
  formatVersion: z.literal(1),
  status: z.enum([
    "created",
    "published",
    "acknowledged",
    "duplicate",
  ]),
}).strict();

export type HumanDeviceMembershipStatusRequestV1 = z.infer<
  typeof humanDeviceMembershipStatusRequestV1Schema
>;
export type HumanDeviceMembershipStatusV1 = z.infer<
  typeof humanDeviceMembershipStatusV1Schema
>;
export type HumanDeviceMembershipInitialRequestV1 = z.infer<
  typeof humanDeviceMembershipInitialRequestV1Schema
>;
export type HumanDeviceMembershipBeginRequestV1 = z.infer<
  typeof humanDeviceMembershipBeginRequestV1Schema
>;
export type HumanDeviceMembershipBeginV1 = z.infer<
  typeof humanDeviceMembershipBeginV1Schema
>;
export type HumanDeviceMembershipJoinRequestV1 = z.infer<
  typeof humanDeviceMembershipJoinRequestV1Schema
>;
export type HumanDeviceMembershipPendingRequestV1 = z.infer<
  typeof humanDeviceMembershipPendingRequestV1Schema
>;
export type HumanDeviceMembershipPendingV1 = z.infer<
  typeof humanDeviceMembershipPendingV1Schema
>;
export type HumanDeviceMembershipRosterRequestV1 = z.infer<
  typeof humanDeviceMembershipRosterRequestV1Schema
>;
export type HumanDeviceMembershipRosterV1 = z.infer<
  typeof humanDeviceMembershipRosterV1Schema
>;
export type HumanDeviceMembershipAddRequestV1 = z.infer<
  typeof humanDeviceMembershipAddRequestV1Schema
>;
export type HumanDeviceMembershipRemoveRequestV1 = z.infer<
  typeof humanDeviceMembershipRemoveRequestV1Schema
>;
export type HumanDeviceMembershipRecoveryBeginRequestV1 = z.infer<
  typeof humanDeviceMembershipRecoveryBeginRequestV1Schema
>;
export type HumanDeviceMembershipRecoveryBeginV1 = z.infer<
  typeof humanDeviceMembershipRecoveryBeginV1Schema
>;
export type HumanDeviceMembershipRecoveryCompleteRequestV1 = z.infer<
  typeof humanDeviceMembershipRecoveryCompleteRequestV1Schema
>;
export type HumanDeviceMembershipAcknowledgementRequestV1 = z.infer<
  typeof humanDeviceMembershipAcknowledgementRequestV1Schema
>;
export type HumanDeviceMembershipMutationV1 = z.infer<
  typeof humanDeviceMembershipMutationV1Schema
>;
