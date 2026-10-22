import { z } from "zod";
import {
  codexRequestEventSchema,
  codexRequestResponseSchema,
  codexPermissionSelectionResponseSchema,
} from "@nautilo/types";
import { liveShadowMessagePlanRequestV1Schema } from "./live-shadow-message";

export const protectedTaskExternalRequestBindingSchema = z.object({
  clientActionSessionId: liveShadowMessagePlanRequestV1Schema.shape.clientActionSessionId,
  authorizationDeviceId: liveShadowMessagePlanRequestV1Schema.shape.clientDeviceId,
}).strict();
const unavailable = z.object({ status: z.literal("unavailable") }).strict();
export const protectedTaskExternalRequestListSchema = z.union([
  unavailable,
  z.object({ status: z.literal("ready"), requests: z.array(z.object({
    requestId: z.string().min(1), taskId: z.string().uuid(), taskRunId: z.string().uuid(),
    jobId: z.string().uuid(), roomId: z.string().uuid(), ownerId: z.string().uuid(),
    state: z.literal("available"),
  }).strict()) }).strict(),
]);
export const protectedTaskExternalRequestPlanBodySchema = protectedTaskExternalRequestBindingSchema.extend({
  requestId: z.string().min(1),
});
export const protectedTaskExternalRequestPlanSchema = z.union([
  unavailable,
  z.object({ status: z.literal("authorization_required"), challengeId: z.string().uuid(),
    authorizationPlanBytesBase64url: z.string().min(1), recipientPublicKeyBase64url: z.string().min(1),
    deadlineAt: z.number().int().nonnegative(), requestDeadlineAt: z.number().int().nonnegative(), roomId: z.string().uuid(),
  }).strict(),
]);
export const protectedTaskExternalRequestReadBodySchema = protectedTaskExternalRequestBindingSchema.extend({
  challengeId: z.string().uuid(), authorizationBytesBase64url: z.string().min(1),
});
export const protectedTaskExternalRequestReadSchema = z.union([
  unavailable,
  z.object({ status: z.literal("read"), event: codexRequestEventSchema,
    responseCapability: z.string().uuid(),
  }).strict(),
]);
export const protectedTaskExternalRequestRespondBodySchema = protectedTaskExternalRequestBindingSchema.extend({
  responseCapability: z.string().uuid(), requestId: z.string().min(1),
  response: z.union([codexRequestResponseSchema, codexPermissionSelectionResponseSchema]),
});
export const protectedTaskExternalRequestRespondSchema = z.union([
  unavailable, z.object({ status: z.literal("responded") }).strict(),
]);

export type ProtectedTaskExternalRequestBinding = z.infer<typeof protectedTaskExternalRequestBindingSchema>;
export type ProtectedTaskExternalRequestList = z.infer<typeof protectedTaskExternalRequestListSchema>;
export type ProtectedTaskExternalRequestPlanBody = z.infer<typeof protectedTaskExternalRequestPlanBodySchema>;
export type ProtectedTaskExternalRequestPlan = z.infer<typeof protectedTaskExternalRequestPlanSchema>;
export type ProtectedTaskExternalRequestReadBody = z.infer<typeof protectedTaskExternalRequestReadBodySchema>;
export type ProtectedTaskExternalRequestRead = z.infer<typeof protectedTaskExternalRequestReadSchema>;
export type ProtectedTaskExternalRequestRespondBody = z.infer<typeof protectedTaskExternalRequestRespondBodySchema>;
export type ProtectedTaskExternalRequestRespond = z.infer<typeof protectedTaskExternalRequestRespondSchema>;
