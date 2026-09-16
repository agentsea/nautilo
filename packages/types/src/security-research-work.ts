import { z } from "zod";
import { securityScanStableIdSchema } from "./security-scan";

export const researchWorkRoleSchema = z.enum(["coordinator", "investigator", "reviewer"]);
export const researchWorkSchema = z.strictObject({
  taskId: z.string().min(1), taskRunId: z.string().min(1),
  role: researchWorkRoleSchema, unitRecordId: securityScanStableIdSchema.nullable(),
  handoffRecordId: securityScanStableIdSchema,
  seedRecordIds: z.array(securityScanStableIdSchema),
  coordinatorRecordId: securityScanStableIdSchema.optional(),
  reportDraftRef: z.string().min(1).optional(),
  resultRevision: z.number().int().positive().optional(),
  reviewedState: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  reviewedUnitRecordId: securityScanStableIdSchema.nullable().optional(),
  reviewDecision: z.enum(["accepted", "follow_up"]).optional(),
});
export const researchHandoffReceiptSchema = z.strictObject({
  ok: z.literal(true), operation: z.literal("handoff"), work: researchWorkSchema,
});
export const researchHandoffErrorSchema = z.strictObject({
  ok: z.literal(false), operation: z.literal("handoff"),
  error: z.strictObject({ code: z.literal("research_handoff_invalid"), message: z.string().min(1), retryable: z.literal(false) }),
});
export const researchHandoffResultSchema = z.discriminatedUnion("ok", [researchHandoffReceiptSchema, researchHandoffErrorSchema]);
export type ResearchWork = z.infer<typeof researchWorkSchema>;
