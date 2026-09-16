import { z } from "zod";

import { protectedMessageDtoV2Schema } from "./protected-message";

export const LIVE_SHADOW_MESSAGE_REALTIME_VERSION_V1 = 1 as const;
export const FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2 = 2 as const;
const base64url = z.string().min(1).max(4_350_000)
  .regex(/^[A-Za-z0-9_-]+$/);
const portable = z.string().min(1).max(256);
const lane = z.string().startsWith("room:");
const digest = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);

const startSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shadow_stream_start"),
  laneKey: lane,
  operationId: portable,
  transcriptOrdinal: z.number().int().positive(),
  streamStartBytesBase64url: base64url,
});

const frameSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shadow_stream_frame"),
  laneKey: lane,
  operationId: portable,
  transcriptOrdinal: z.number().int().positive(),
  ordinaryChunk: z.string().max(65_536),
  frameBytesBase64url: base64url,
  done: z.boolean(),
});

const durableSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shadow_durable"),
  laneKey: lane,
  operationId: portable,
  policyRevision: z.number().int().positive(),
  transcriptOrdinal: z.number().int().positive(),
  ordinaryPayloadBytesBase64url: base64url,
  protectedMessage: protectedMessageDtoV2Schema,
  durableEventDigestBase64url: digest,
});

const humanPeerDurableSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.human_peer_shadow"),
  laneKey: lane,
  operationId: portable,
  policyRevision: z.number().int().positive(),
  transcriptOrdinal: z.number().int().positive(),
  logicalMessageKey: portable,
  planBytesBase64url: base64url,
  requestBytesBase64url: base64url,
  ordinaryPayloadBytesBase64url: base64url,
  protectedMessage: protectedMessageDtoV2Schema,
  protectedMessageDigestBase64url: digest,
  senderDeviceSigningPublicKeyBase64url: base64url,
  durableEventDigestBase64url: digest,
});

const sharedAgentHumanDurableSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shared_agent_shadow"),
  laneKey: lane,
  operationId: portable,
  policyRevision: z.number().int().positive(),
  transcriptOrdinal: z.number().int().positive(),
  logicalMessageKey: portable,
  planBytesBase64url: base64url,
  requestBytesBase64url: base64url,
  ordinaryPayloadBytesBase64url: base64url,
  protectedMessage: protectedMessageDtoV2Schema,
  protectedMessageDigestBase64url: digest,
  senderDeviceSigningPublicKeyBase64url: base64url,
  durableEventDigestBase64url: digest,
});

const sharedAgentAuthorizationRequiredSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shared_agent_authorization_required"),
  laneKey: lane,
  userId: portable,
  roomId: portable,
  executionId: portable,
  clientActionSessionId: portable,
  deadlineAt: z.number().int().nonnegative(),
  authorizationScheme: z.literal("runtime_foreground_v1").optional(),
  planBytesBase64url: base64url.optional(),
  ordinaryPayloadBytesBase64url: base64url.optional(),
  authorizationPlanBytesBase64url: base64url.optional(),
  sourceHumanPlanBytesBase64url: base64url.optional(),
  recipientPublicKeyBase64url: base64url.optional(),
});

const runtimeInvocationAuthorizationRequiredSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.runtime_invocation_authorization_required"),
  laneKey: lane,
  userId: portable,
  roomId: portable,
  invocationId: portable,
  clientActionSessionId: portable,
  deadlineAt: z.number().int().nonnegative(),
  authorizationScheme: z.literal("runtime_foreground_v1"),
  authorizationPlanBytesBase64url: base64url,
  sourceHumanPlanBytesBase64url: base64url,
  recipientPublicKeyBase64url: base64url,
});

const sharedAgentStreamStartSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shared_agent_stream_start"),
  laneKey: lane,
  operationId: portable,
  transcriptOrdinal: z.number().int().positive(),
  planBytesBase64url: base64url,
  streamStartBytesBase64url: base64url,
});

const sharedAgentStreamFrameSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shared_agent_stream_frame"),
  laneKey: lane,
  operationId: portable,
  transcriptOrdinal: z.number().int().positive(),
  ordinaryChunk: z.string().max(65_536),
  frameBytesBase64url: base64url,
  done: z.boolean(),
});

const sharedAgentOutputDurableSchema = z.strictObject({
  wireVersion: z.literal(1),
  type: z.literal("message.shared_agent_output_shadow"),
  laneKey: lane,
  operationId: portable,
  policyRevision: z.number().int().positive(),
  transcriptOrdinal: z.number().int().positive(),
  planBytesBase64url: base64url,
  ordinaryPayloadBytesBase64url: base64url,
  protectedMessage: protectedMessageDtoV2Schema,
  durableEventDigestBase64url: digest,
});

export const liveShadowMessageRealtimeEventV1Schema = z.discriminatedUnion(
  "type",
  [
    startSchema,
    frameSchema,
    durableSchema,
    humanPeerDurableSchema,
    sharedAgentHumanDurableSchema,
    sharedAgentAuthorizationRequiredSchema,
    runtimeInvocationAuthorizationRequiredSchema,
    sharedAgentStreamStartSchema,
    sharedAgentStreamFrameSchema,
    sharedAgentOutputDurableSchema,
  ],
);

export type LiveShadowMessageRealtimeEventV1 = z.infer<
  typeof liveShadowMessageRealtimeEventV1Schema
>;

export function parseLiveShadowMessageRealtimeEventV1(
  value: unknown,
): LiveShadowMessageRealtimeEventV1 {
  return liveShadowMessageRealtimeEventV1Schema.parse(value);
}

// Full encryption deliberately reuses the established event identifiers while
// changing the wire version. Deriving these strict schemas from their Shadow
// counterparts keeps all coordinates and cryptographic evidence aligned, and
// makes an accidentally supplied ordinary sibling a validation error.
export const fullEncryptionStreamStartEventV2Schema = startSchema.extend({
  wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
});

export const fullEncryptionStreamFrameEventV2Schema = frameSchema.omit({
  ordinaryChunk: true,
}).extend({
  wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
});

export const fullEncryptionDurableEventV2Schema = durableSchema.omit({
  ordinaryPayloadBytesBase64url: true,
}).extend({
  wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
});

export const fullEncryptionHumanPeerDurableEventV2Schema =
  humanPeerDurableSchema.omit({
    ordinaryPayloadBytesBase64url: true,
  }).extend({
    wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
  });

export const fullEncryptionSharedAgentHumanDurableEventV2Schema =
  sharedAgentHumanDurableSchema.omit({
    ordinaryPayloadBytesBase64url: true,
  }).extend({
    wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
  });

export const fullEncryptionSharedAgentStreamStartEventV2Schema =
  sharedAgentStreamStartSchema.extend({
    wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
  });

export const fullEncryptionSharedAgentStreamFrameEventV2Schema =
  sharedAgentStreamFrameSchema.omit({
    ordinaryChunk: true,
  }).extend({
    wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
  });

export const fullEncryptionSharedAgentOutputDurableEventV2Schema =
  sharedAgentOutputDurableSchema.omit({
    ordinaryPayloadBytesBase64url: true,
  }).extend({
    wireVersion: z.literal(FULL_ENCRYPTION_MESSAGE_REALTIME_VERSION_V2),
  });

export const fullEncryptionMessageRealtimeContentEventV2Schema =
  z.discriminatedUnion("type", [
    fullEncryptionStreamStartEventV2Schema,
    fullEncryptionStreamFrameEventV2Schema,
    fullEncryptionDurableEventV2Schema,
    fullEncryptionHumanPeerDurableEventV2Schema,
    fullEncryptionSharedAgentHumanDurableEventV2Schema,
    fullEncryptionSharedAgentStreamStartEventV2Schema,
    fullEncryptionSharedAgentStreamFrameEventV2Schema,
    fullEncryptionSharedAgentOutputDurableEventV2Schema,
  ]);

export type FullEncryptionMessageRealtimeContentEventV2 = z.infer<
  typeof fullEncryptionMessageRealtimeContentEventV2Schema
>;

export function parseFullEncryptionMessageRealtimeContentEventV2(
  value: unknown,
): FullEncryptionMessageRealtimeContentEventV2 {
  return fullEncryptionMessageRealtimeContentEventV2Schema.parse(value);
}
