import { z } from "zod";

const action = z.enum(["ban", "kick", "timeout", "mute", "lift"]);
export const moderationPolicySchema = z.object({ enabled: z.boolean(), joinsPaused: z.boolean(), approvalRequired: z.boolean(), revision: z.number().int().positive() });
export const moderationPolicyUpdateSchema = moderationPolicySchema.extend({ auditRecorded: z.boolean() });
export const moderationPersonSchema = z.object({ person: z.object({
  userId: z.string().uuid(), displayName: z.string(), roomId: z.string().uuid().nullable(), targetRevision: z.string(),
  allowedActions: z.array(action), protectedTarget: z.boolean(),
}), restrictions: z.array(z.object({ id: z.string().uuid(), targetUserId: z.string().uuid().nullable(), displayName: z.string().nullable(),
  roomId: z.string().uuid().nullable(), kind: z.enum(["access", "participation"]), reason: z.string().nullable(),
  startsAt: z.string(), expiresAt: z.string().nullable(), revision: z.number().int().positive(),
})) });
export const moderationReceiptSchema = z.object({ operationId: z.string().uuid(), action, roomId: z.string().uuid().nullable(),
  restrictionId: z.string().uuid().nullable(), createdAt: z.string(), expiresAt: z.string().nullable(), committed: z.literal(true),
  messageCleanup: z.enum(["not_requested", "pending", "complete"]).optional(),
  replayed: z.boolean(), auditRecorded: z.boolean(), converged: z.boolean(),
});
export const enrollmentStatusSchema = z.object({ required: z.boolean(), paused: z.boolean(),
  state: z.enum(["not_requested", "pending", "approved", "rejected", "completed"]), message: z.string().nullable(), revision: z.number().int().nonnegative(),
});
export const enrollmentPageSchema = z.object({ items: z.array(z.object({
  inviteId: z.string().uuid(), userId: z.string().uuid(), displayName: z.string(), handle: z.string().nullable(), message: z.string(),
  state: z.enum(["pending", "approved", "rejected"]), revision: z.number().int().positive(),
})), next: z.object({ inviteId: z.string().uuid(), userId: z.string().uuid() }).nullable() });

export const moderationPeopleSchema = z.object({ items: z.array(z.object({
  userId: z.string().uuid(), displayName: z.string(), handle: z.string().nullable(),
})), next: z.string().uuid().nullable() });
