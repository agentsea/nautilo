import { z } from "zod";
import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE } from "./api";

export const BOLTER_ORIGIN = "https://bolter.chat" as const;
const opaqueId = z.string().min(1).refine(value => value.trim() === value && !/\s/u.test(value)
  && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
const revision = z.number().int().nonnegative();
export const bolterStatusReasonSchema = z.enum([
  "desktop_required", "desktop_offline", "desktop_selection_required", "runtime_unavailable",
  "qualification_required", "mode_unsupported", "authentication_required", "identity_unconfirmed",
  "identity_selection_required", "receiver_unavailable", "authority_changed", "delivery_uncertain",
  "unsupported_content", "invalid_request", "not_found", "conflict", "operation_cancelled",
]);
export type BolterStatusReason = z.infer<typeof bolterStatusReasonSchema>;
export const bolterReceiverStateSchema = z.enum(["stopped", "starting", "running", "listening"]);
export type BolterReceiverState = z.infer<typeof bolterReceiverStateSchema>;
export const bolterDeliveryStateSchema = z.enum(["pending", "publishing", "published", "uncertain", "cancelled"]);
export type BolterDeliveryState = z.infer<typeof bolterDeliveryStateSchema>;

/** Browser-safe projections omit credentials, filesystem homes, and transport authority. */
export const bolterConnectionSummarySchema = z.object({
  id: z.uuid(), revision, displayName: z.string(),
  identity: z.object({ label: z.string(), providerAgentId: opaqueId }).strict().nullable(),
  device: z.object({ relayId: opaqueId, label: z.string() }).strict(),
  status: z.enum(["qualification_required", "needs_auth", "auth_pending", "connected", "offline", "paused", "revoked"]),
  receiver: bolterReceiverStateSchema, canCreateRoom: z.boolean(), reason: bolterStatusReasonSchema.optional(),
}).strict();
export type BolterConnectionSummary = z.infer<typeof bolterConnectionSummarySchema>;
export const bolterConversationChoiceSchema = z.object({
  /** Ephemeral server-issued selection reference, tied to a current observation. */
  id: opaqueId, label: z.string(), chatId: opaqueId, threadRootId: opaqueId.nullable(),
}).strict();
export type BolterConversationChoice = z.infer<typeof bolterConversationChoiceSchema>;
export const bolterRoomLinkSummarySchema = z.object({
  id: z.uuid(), revision, roomId: z.uuid(), roomName: z.string(), agentId: z.uuid(), connectionId: z.uuid(),
  conversationLabel: z.string(), chatId: opaqueId, threadRootId: opaqueId.nullable(),
  providerAgentId: opaqueId, identityLabel: z.string(), canManage: z.boolean(), canSend: z.boolean(), canAttach: z.boolean().optional(), status: z.enum(["active", "paused", "revoked"]), receiver: bolterReceiverStateSchema,
  outboundPolicy: z.literal("causal_replies_and_reviewed_messages"),
  delivery: z.object({ pending: z.number().int().nonnegative(), uncertain: z.number().int().nonnegative() }).strict(),
  reason: bolterStatusReasonSchema.optional(),
}).strict();
export type BolterRoomLinkSummary = z.infer<typeof bolterRoomLinkSummarySchema>;
export const bolterConnectionsResponseSchema = z.object({
  connections: z.array(bolterConnectionSummarySchema),
  desktops: z.array(z.object({ relayId: opaqueId, label: z.string() }).strict()),
  availability: z.object({ state: z.enum(["available", "desktop_required", "qualification_required", "mode_unsupported"]),
    reason: bolterStatusReasonSchema.optional() }).strict(),
}).strict();
export type BolterConnectionsResponse = z.infer<typeof bolterConnectionsResponseSchema>;

/** Login links are transient display data and must remain on the provider's exact origin. */
export const bolterAuthLinkSchema = z.object({
  url: z.url().refine(value => { const url = new URL(value); return url.origin === BOLTER_ORIGIN && !url.username && !url.password; }),
  code: z.string().min(1),
}).strict();
export const bolterOperationResponseSchema = z.object({
  operationId: z.uuid(), status: z.enum(["pending", "auth_pending", "completed", "unavailable"]),
  auth: bolterAuthLinkSchema.optional(), connection: bolterConnectionSummarySchema.optional(),
  reason: bolterStatusReasonSchema.optional(),
}).strict();
export type BolterOperationResponse = z.infer<typeof bolterOperationResponseSchema>;
export const bolterConnectRequestSchema = z.object({ relayId: opaqueId.optional() }).strict();
export const bolterConnectionUpdateSchema = z.object({ expectedRevision: revision, enabled: z.boolean() }).strict();
export const bolterRevisionRequestSchema = z.object({ expectedRevision: revision }).strict();
export const bolterCreateRoomRequestSchema = z.object({
  choiceId: opaqueId, agentId: z.uuid(), name: z.string().trim().min(1), modelSponsorshipAccepted: z.literal(true),
}).strict();
export const bolterBindingUpdateSchema = z.object({ expectedRevision: revision, state: z.enum(["active", "paused", "revoked"]) }).strict();
export const bolterReviewedMessageRequestSchema = z.object({
  expectedRevision: revision, requestId: z.uuid(), content: z.string().min(1),
  attachmentIds: z.array(z.uuid()).max(MAX_CHAT_ATTACHMENTS_PER_MESSAGE).refine(ids => new Set(ids).size === ids.length).optional(),
}).strict();
/** Exact file selection covered by the explicit share fingerprint. */
export const bolterAttachmentDescriptorSchema = z.object({
  id: z.uuid(), filename: z.string().min(1), mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type BolterAttachmentDescriptor = z.infer<typeof bolterAttachmentDescriptorSchema>;
/** Private Relay data; file bytes never enter ordinary model tool arguments. */
export const bolterAttachmentPayloadSchema = bolterAttachmentDescriptorSchema.extend({ base64: z.string() }).strict();
export type BolterAttachmentPayload = z.infer<typeof bolterAttachmentPayloadSchema>;
export const bolterReviewedMessageResponseSchema = z.object({
  messageId: z.number().int().positive(), outboxId: z.uuid(), state: bolterDeliveryStateSchema,
}).strict();
export const bolterConversationsResponseSchema = z.object({
  status: z.enum(["available", "unavailable"]), conversations: z.array(bolterConversationChoiceSchema), reason: bolterStatusReasonSchema.optional(),
}).strict();
export const bolterDeliverySummarySchema = bolterReviewedMessageResponseSchema.extend({ createdAt: z.iso.datetime({ offset: true }), requestId: z.uuid().nullable() }).strict();
export type BolterConnectRequest = z.infer<typeof bolterConnectRequestSchema>;
export type BolterConnectionUpdate = z.infer<typeof bolterConnectionUpdateSchema>;
export type BolterRevisionRequest = z.infer<typeof bolterRevisionRequestSchema>;
export type BolterCreateRoomRequest = z.infer<typeof bolterCreateRoomRequestSchema>;
export type BolterBindingUpdate = z.infer<typeof bolterBindingUpdateSchema>;
export type BolterReviewedMessageRequest = z.infer<typeof bolterReviewedMessageRequestSchema>;
export type BolterReviewedMessageResponse = z.infer<typeof bolterReviewedMessageResponseSchema>;
export type BolterConversationsResponse = z.infer<typeof bolterConversationsResponseSchema>;
export type BolterDeliverySummary = z.infer<typeof bolterDeliverySummarySchema>;
export const bolterDeliverySelectionSchema = z.object({ outboxId: z.uuid().optional(), requestId: z.uuid().optional() }).strict();
export type BolterDeliverySelection = z.infer<typeof bolterDeliverySelectionSchema>;
export const bolterCreateRoomResponseSchema = z.object({ roomId: z.uuid(), link: bolterRoomLinkSummarySchema }).strict();
export const bolterRoomLinkResponseSchema = z.object({ link: bolterRoomLinkSummarySchema.nullable() }).strict();
export const bolterDeliveriesResponseSchema = z.object({ deliveries: z.array(bolterDeliverySummarySchema) }).strict();
export type BolterCreateRoomResponse = z.infer<typeof bolterCreateRoomResponseSchema>;
export type BolterRoomLinkResponse = z.infer<typeof bolterRoomLinkResponseSchema>;
export type BolterDeliveriesResponse = z.infer<typeof bolterDeliveriesResponseSchema>;

/** Qualified adapter observations; process existence alone never proves authentication or listening. */
export const bolterConnectionObservationSchema = z.object({
  runtime: z.enum(["unavailable", "qualification_required", "qualified"]),
  authentication: z.enum(["unknown", "required", "pending", "confirmed"]),
  identity: z.object({ providerAgentId: opaqueId, label: z.string(), identityFingerprint: z.string().regex(/^[0-9a-f]{64}$/u) }).strict().nullable(),
  receiver: bolterReceiverStateSchema,
  attachments: z.boolean().optional(),
  reason: bolterStatusReasonSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.authentication === "confirmed" && (value.runtime !== "qualified" || !value.identity))
    || (value.receiver === "listening" && (value.runtime !== "qualified" || value.authentication !== "confirmed"))) {
    context.addIssue({ code: "custom", message: "confirmed state requires qualified identity evidence" });
  }
});
export type BolterConnectionObservation = z.infer<typeof bolterConnectionObservationSchema>;

/** Normalized adapter data, deliberately not the unqualified provider JSON contract. */
export const bolterReceivedMessageSchema = z.object({
  type: z.literal("message"), messageId: opaqueId, chatId: opaqueId, threadRootId: opaqueId.nullable(),
  senderId: opaqueId, senderType: z.enum(["user", "anima", "system"]), senderLabel: z.string().optional(),
  content: z.string(), createdAt: z.iso.datetime({ offset: true }), addressed: z.boolean(), truncated: z.boolean(), redelivered: z.boolean(),
}).strict();
export type BolterReceivedMessage = z.infer<typeof bolterReceivedMessageSchema>;

/** Private transport payload. The Relay envelope supplies authenticated current-session authority. */
export const bolterNativeCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), operationId: z.uuid(), connectionId: z.uuid(), homeHandle: opaqueId }).strict(),
  z.object({ action: z.literal("cancel_connect"), operationId: z.uuid() }).strict(),
  ...(["check", "list_conversations", "start_receiver", "pause", "revoke"] as const).map(action =>
    z.object({ action: z.literal(action), connectionId: z.uuid(), generation: z.number().int().positive() }).strict()),
  z.object({ action: z.literal("send"), connectionId: z.uuid(), generation: z.number().int().positive(), outboxId: z.uuid(),
    bindingId: z.uuid(), bindingRevision: revision }).strict(),
]);
export type BolterNativeCommand = z.infer<typeof bolterNativeCommandSchema>;
export const bolterNativeResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observation"), observation: bolterConnectionObservationSchema }).strict(),
  z.object({ kind: z.literal("auth_pending"), auth: bolterAuthLinkSchema }).strict(),
  z.object({ kind: z.literal("conversations"), conversations: z.array(z.object({ label: z.string(), chatId: opaqueId, threadRootId: opaqueId.nullable() }).strict()) }).strict(),
  z.object({ kind: z.literal("sent"), receipt: z.object({ messageId: opaqueId, chatId: opaqueId, threadRootId: opaqueId.nullable() }).strict() }).strict(),
  z.object({ kind: z.literal("uncertain") }).strict(),
  /** For send, unavailable proves no provider dispatch occurred. */
  z.object({ kind: z.literal("unavailable"), reason: bolterStatusReasonSchema }).strict(),
]);
export type BolterNativeResult = z.infer<typeof bolterNativeResultSchema>;

export const bolterRoomLinksResponseSchema = z.object({ links: z.array(bolterRoomLinkSummarySchema) }).strict();
export type BolterRoomLinksResponse = z.infer<typeof bolterRoomLinksResponseSchema>;
