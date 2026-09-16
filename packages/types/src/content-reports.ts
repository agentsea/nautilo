import { z } from "zod";

export const CONTENT_REPORT_REASONS = [
  "abuse_hate_harassment",
  "sexual_exploitative",
  "violence_threats",
  "spam_scam",
  "other",
] as const;

export const CONTENT_REPORT_REASON_LABELS = {
  abuse_hate_harassment: "Abuse, hate, or harassment",
  sexual_exploitative: "Sexual or exploitative",
  violence_threats: "Violence or threats",
  spam_scam: "Spam or scam",
  other: "Other",
} as const satisfies Record<ContentReportReason, string>;

export const contentReportReasonSchema = z.enum(CONTENT_REPORT_REASONS);
export type ContentReportReason = z.infer<typeof contentReportReasonSchema>;

export const contentReportTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    roomId: z.string().uuid(),
    messageId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("person"),
    roomId: z.string().uuid(),
    userId: z.string().uuid(),
  }),
]);
export type ContentReportTarget = z.infer<typeof contentReportTargetSchema>;

export const createContentReportRequestSchema = z.object({
  id: z.string().uuid(),
  target: contentReportTargetSchema,
  reason: contentReportReasonSchema,
  comment: z.string().trim().max(500).optional(),
});
export type CreateContentReportRequest = z.infer<
  typeof createContentReportRequestSchema
>;

export const createContentReportResponseSchema = z.object({
  id: z.string().uuid(),
  receivedAt: z.string().datetime(),
});
export type CreateContentReportResponse = z.infer<
  typeof createContentReportResponseSchema
>;

export const contentReportAttachmentPreviewSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
});

export const contentReportSchema = z.object({
  id: z.string().uuid(),
  reporter: z.object({
    userId: z.string().uuid(),
    displayName: z.string(),
    handle: z.string().nullable(),
  }),
  roomId: z.string().uuid(),
  target: z.discriminatedUnion("type", [
    z.object({ type: z.literal("message"), messageId: z.number().int().positive() }),
    z.object({ type: z.literal("person"), userId: z.string().uuid() }),
  ]),
  reason: contentReportReasonSchema,
  comment: z.string().nullable(),
  preview: z.object({
    text: z.string().nullable(),
    displayName: z.string().nullable(),
    handle: z.string().nullable(),
    attachments: z.array(contentReportAttachmentPreviewSchema),
  }),
  status: z.enum(["open", "closed"]),
  createdAt: z.string().datetime(),
  sourceAvailable: z.boolean(),
  closedBy: z
    .object({
      userId: z.string().uuid(),
      displayName: z.string(),
      handle: z.string().nullable(),
    })
    .nullable(),
  closedAt: z.string().datetime().nullable(),
});
export type ContentReportDto = z.infer<typeof contentReportSchema>;

export const contentReportListQuerySchema = z.object({
  status: z.enum(["open", "closed"]).default("open"),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).optional(),
});
export type ContentReportListQuery = z.infer<typeof contentReportListQuerySchema>;

export const contentReportListResponseSchema = z.object({
  reports: z.array(contentReportSchema),
  nextCursor: z.string().nullable(),
});
export type ContentReportListResponse = z.infer<
  typeof contentReportListResponseSchema
>;

export const contentReportAdminActionSchema = z.object({
  action: z.enum(["close", "delete_message_and_close"]),
});
export type ContentReportAdminAction = z.infer<
  typeof contentReportAdminActionSchema
>;
