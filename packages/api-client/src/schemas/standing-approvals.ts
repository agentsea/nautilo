import { z } from "zod";

/** M037 — standing command approval row (`listCommandApprovals`). */
export const commandApprovalRowSchema = z.object({
  id: z.string(),
  scope: z.enum(["room", "server"]),
  roomId: z.string().nullable(),
  roomLabel: z.string().nullable(),
  toolPattern: z.string(),
  label: z.string(),
  approvalKind: z.enum(["tool", "capability"]),
  capabilitySlug: z.string().nullable(),
  active: z.boolean(),
  createdAt: z.string(),
});

export const standingApprovalsListSchema = z.object({
  approvals: z.array(commandApprovalRowSchema),
});

export type CommandApprovalRow = z.infer<typeof commandApprovalRowSchema>;
export type StandingApprovalsListResponse = z.infer<typeof standingApprovalsListSchema>;
