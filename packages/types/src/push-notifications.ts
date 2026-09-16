/**
 * D468 — versioned, content-free Mobile push-installation wire contract.
 *
 * Expo push tokens and revoke proofs are capability material.  This module
 * bounds their wire representation, but intentionally does not log, persist,
 * or derive either value.  Server persistence stores an encrypted token and
 * only a digest of the revoke proof.
 */
import { z } from "zod";

export const MOBILE_PUSH_INSTALLATION_VERSION = 1 as const;
export const MOBILE_PUSH_ENVELOPE_VERSION = 1 as const;

const opaqueUuidSchema = z.string().uuid();
const isoTimestampSchema = z.string().datetime({ offset: true });
const boundedOpaqueSecretSchema = z.string().min(32).max(512);

/** Expo documents token strings as opaque; keep enough room for future forms. */
const expoPushTokenSchema = z
  .string()
  .min(16)
  .max(2_048)
  .regex(/^ExponentPushToken\[[^\]\r\n]{1,2000}\]$|^ExpoPushToken\[[^\]\r\n]{1,2000}\]$/, "invalid Expo push token");

export const mobilePushPlatformSchema = z.enum(["ios", "android"]);
export type MobilePushPlatform = z.infer<typeof mobilePushPlatformSchema>;

/** Device-local permission truth projected to the server; never inferred. */
export const mobilePushPermissionSchema = z.enum([
  "granted",
  "denied",
  "undetermined",
]);
export type MobilePushPermission = z.infer<typeof mobilePushPermissionSchema>;

export const mobilePushBindingStateSchema = z.enum([
  "active",
  "disabled",
  "revoked",
  "unavailable",
]);
export type MobilePushBindingState = z.infer<typeof mobilePushBindingStateSchema>;

/**
 * The raw proof is delivered once when a binding is created.  It authorizes
 * only revocation of this exact binding; the server stores a domain-separated
 * digest, never this value.
 */
export const mobilePushRevokeProofSchema = boundedOpaqueSecretSchema;

/**
 * Register/rotate one server-scoped push binding. `installationId` is the
 * stable public app/device identity. `bindingId` is random per server and is
 * the only routing identity allowed inside a push envelope.
 */
export const mobilePushInstallationRegisterRequestSchema = z
  .object({
    version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION),
    installationId: opaqueUuidSchema,
    bindingId: opaqueUuidSchema,
    platform: mobilePushPlatformSchema,
    expoPushToken: expoPushTokenSchema,
    enabled: z.literal(true),
    tokenGeneration: z.number().int().positive().max(2_147_483_647),
    appVersion: z.string().trim().min(1).max(128),
    permission: z.literal("granted"),
    revokeProof: mobilePushRevokeProofSchema,
  })
  .strict();
export type MobilePushInstallationRegisterRequest = z.infer<
  typeof mobilePushInstallationRegisterRequestSchema
>;

/** An authenticated disable keeps no plaintext token in the response. */
export const mobilePushInstallationDisableRequestSchema = z
  .object({
    version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION),
    installationId: opaqueUuidSchema,
    bindingId: opaqueUuidSchema,
    enabled: z.literal(false),
    tokenGeneration: z.number().int().positive().max(2_147_483_647),
    permission: mobilePushPermissionSchema,
  })
  .strict();
export type MobilePushInstallationDisableRequest = z.infer<
  typeof mobilePushInstallationDisableRequestSchema
>;

/**
 * Installation-local app-badge policy, synchronized independently from token
 * registration so an updated app remains compatible with older servers.
 */
export const mobilePushInstallationBadgePreferenceRequestSchema = z
  .object({
    version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION),
    bindingId: opaqueUuidSchema,
    tokenGeneration: z.number().int().positive().max(2_147_483_647),
    enabled: z.boolean(),
  })
  .strict();
export type MobilePushInstallationBadgePreferenceRequest = z.infer<
  typeof mobilePushInstallationBadgePreferenceRequestSchema
>;

export const mobilePushInstallationBadgePreferenceResponseSchema = z
  .object({
    version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION),
    bindingId: opaqueUuidSchema,
    tokenGeneration: z.number().int().positive().max(2_147_483_647),
    enabled: z.boolean(),
  })
  .strict();
export type MobilePushInstallationBadgePreferenceResponse = z.infer<
  typeof mobilePushInstallationBadgePreferenceResponseSchema
>;

/** Proof-only revocation is deliberately narrower than authenticated revoke. */
export const mobilePushInstallationProofRevokeRequestSchema = z
  .object({
    version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION),
    bindingId: opaqueUuidSchema,
    revokeProof: mobilePushRevokeProofSchema,
  })
  .strict();
export type MobilePushInstallationProofRevokeRequest = z.infer<
  typeof mobilePushInstallationProofRevokeRequestSchema
>;

export const mobilePushInstallationStatusSchema = z
  .object({
    version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION),
    installationId: opaqueUuidSchema,
    bindingId: opaqueUuidSchema,
    platform: mobilePushPlatformSchema,
    enabled: z.boolean(),
    tokenGeneration: z.number().int().positive().max(2_147_483_647),
    permission: mobilePushPermissionSchema,
    state: mobilePushBindingStateSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type MobilePushInstallationStatus = z.infer<typeof mobilePushInstallationStatusSchema>;

/** Fixed-copy test intent; no title/body or arbitrary payload can enter here. */
export const mobilePushInstallationTestRequestSchema = z
  .object({ version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION) })
  .strict();
export type MobilePushInstallationTestRequest = z.infer<
  typeof mobilePushInstallationTestRequestSchema
>;

export const mobilePushInstallationTestResponseSchema = z
  .object({
    accepted: z.literal(true),
    notificationId: opaqueUuidSchema,
  })
  .strict();
export type MobilePushInstallationTestResponse = z.infer<
  typeof mobilePushInstallationTestResponseSchema
>;

/** Exact errors which callers can handle without inferring server state. */
export const mobilePushInstallationErrorCodeSchema = z.enum([
  "invalid_push_installation",
  "push_unavailable",
  "stale_push_token_generation",
  "push_installation_revoked",
  "push_revoke_proof_invalid",
  "push_permission_denied",
  "push_test_rate_limited",
]);
export type MobilePushInstallationErrorCode = z.infer<
  typeof mobilePushInstallationErrorCodeSchema
>;

/** Facts every opaque notification envelope carries, regardless of intent. */
const mobilePushEnvelopeBaseSchema = z.object({
  version: z.literal(MOBILE_PUSH_ENVELOPE_VERSION),
  notificationId: opaqueUuidSchema,
  bindingId: opaqueUuidSchema,
  occurredAt: isoTimestampSchema,
});

/**
 * Opaque payload only. Visible copy is a closed mapping by `kind`, never
 * server-authored text. Target-bearing branches re-fetch authority before
 * navigation. A user-requested test is deliberately target-free: inventing a
 * Room/message identity for it would create replayable false application
 * truth when the notification is opened.
 */
export const mobilePushEnvelopeV1Schema = z.discriminatedUnion("kind", [
  mobilePushEnvelopeBaseSchema.extend({
    kind: z.literal("important_message"),
    roomId: opaqueUuidSchema,
    topLevelRoomId: opaqueUuidSchema,
    // Canonical `session_messages.id` is a positive integer, not a UUID.
    messageId: z.number().int().positive().max(2_147_483_647),
  }).strict(),
  mobilePushEnvelopeBaseSchema.extend({
    kind: z.literal("needs_you"),
    roomId: opaqueUuidSchema,
    topLevelRoomId: opaqueUuidSchema,
    attentionRequestId: opaqueUuidSchema,
  }).strict(),
  mobilePushEnvelopeBaseSchema.extend({
    kind: z.literal("test"),
  }).strict(),
]);
export type MobilePushEnvelopeV1 = z.infer<typeof mobilePushEnvelopeV1Schema>;

/** Bounded offline cleanup record: no URL-authenticated bearer may be stored. */
export const mobilePushRevokeTombstoneSchema = z
  .object({
    version: z.literal(MOBILE_PUSH_INSTALLATION_VERSION),
    serverUrl: z.string().url().max(2_048),
    bindingId: opaqueUuidSchema,
    revokeProof: mobilePushRevokeProofSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();
export type MobilePushRevokeTombstone = z.infer<typeof mobilePushRevokeTombstoneSchema>;
