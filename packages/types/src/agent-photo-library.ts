import { z } from "zod";

const decimalRevisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const uuidSchema = z.string().uuid();

export const agentPhotoAvatarRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preset"), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal("uploaded"), blobId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("generated"), blobId: z.string().min(1) }),
]);

export const agentPhotoLibraryScopeSchema = z.strictObject({
  serverInstanceId: uuidSchema,
  viewerUserId: uuidSchema,
  agentId: uuidSchema,
  selectionRevision: decimalRevisionSchema,
  libraryRevision: decimalRevisionSchema,
});

export type AgentPhotoLibraryScopeDto = z.infer<typeof agentPhotoLibraryScopeSchema>;

export const agentPhotoLibraryEntrySchema = z.strictObject({
  id: uuidSchema,
  source: z.enum([
    "upload",
    "generation",
    "bundle_import",
    "legacy_backfill",
    "operator_adoption",
  ]),
  origin: z.enum([
    "workbench",
    "mobile",
    "desktop_wizard",
    "cli_setup",
    "manage_avatar",
    "bundle_import",
    "legacy_backfill",
    "operator_adoption",
  ]),
  createdAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
  purgeAfter: z.string().datetime({ offset: true }).nullable(),
  isCurrent: z.boolean(),
  media: z.strictObject({
    thumbnailUrl: z.string().startsWith("/api/profile/agent-photo-library/"),
    fullUrl: z.string().startsWith("/api/profile/agent-photo-library/").optional(),
  }),
});

export type AgentPhotoLibraryEntryDto = z.infer<typeof agentPhotoLibraryEntrySchema>;

export const agentPhotoLibraryCurrentSchema = z.strictObject({
  avatarRef: agentPhotoAvatarRefSchema.nullable(),
  entryId: uuidSchema.nullable(),
  lastUndoableRevisionId: uuidSchema.nullable(),
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryCurrentDto = z.infer<typeof agentPhotoLibraryCurrentSchema>;

export const agentPhotoLibraryCurrentResponseSchema = z.strictObject({
  current: agentPhotoLibraryCurrentSchema,
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryCurrentResponse = z.infer<
  typeof agentPhotoLibraryCurrentResponseSchema
>;

export const agentPhotoLibraryListResponseSchema = z.strictObject({
  entries: z.array(agentPhotoLibraryEntrySchema),
  nextCursor: z.string().min(1).nullable(),
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryListResponse = z.infer<
  typeof agentPhotoLibraryListResponseSchema
>;

export const agentPhotoLibraryPresetSchema = z.strictObject({
  id: z.string().min(1),
  thumbnailUrl: z.string().startsWith("/api/onboarding/images/avatars/"),
});

export const agentPhotoLibraryPresetsResponseSchema = z.strictObject({
  presets: z.array(agentPhotoLibraryPresetSchema),
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryPresetsResponse = z.infer<
  typeof agentPhotoLibraryPresetsResponseSchema
>;

export const agentPhotoLibraryEntryResponseSchema = z.strictObject({
  entry: agentPhotoLibraryEntrySchema,
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryEntryResponse = z.infer<
  typeof agentPhotoLibraryEntryResponseSchema
>;

export const agentPhotoLibraryCreateEntrySchema = z.strictObject({
  id: uuidSchema,
  source: z.enum(["upload", "generation", "bundle_import"]),
  origin: z.enum([
    "workbench",
    "mobile",
    "desktop_wizard",
    "cli_setup",
    "manage_avatar",
    "bundle_import",
  ]),
  createdAt: z.string().datetime({ offset: true }),
  media: z.strictObject({
    thumbnailUrl: z.string().startsWith("/api/profile/agent-photo-library/"),
    fullUrl: z.string().startsWith("/api/profile/agent-photo-library/"),
  }),
});

export const agentPhotoLibraryCreateResponseSchema = z.strictObject({
  operation: z.literal("create"),
  entryIds: z.array(uuidSchema).min(1).max(4),
  entries: z.array(agentPhotoLibraryCreateEntrySchema).min(1).max(4),
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryCreateResponse = z.infer<
  typeof agentPhotoLibraryCreateResponseSchema
>;

export const agentPhotoLibrarySelectionResponseSchema = z.strictObject({
  operation: z.enum(["select", "undo"]),
  changed: z.boolean(),
  currentAvatarRef: agentPhotoAvatarRefSchema.nullable(),
  currentEntryId: uuidSchema.nullable(),
  revisionId: uuidSchema.nullable(),
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibrarySelectionResponse = z.infer<
  typeof agentPhotoLibrarySelectionResponseSchema
>;

export const agentPhotoLibraryEntryLifecycleResponseSchema = z.strictObject({
  operation: z.enum(["delete", "restore"]),
  changed: z.literal(true),
  entryId: uuidSchema,
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryEntryLifecycleResponse = z.infer<
  typeof agentPhotoLibraryEntryLifecycleResponseSchema
>;

export const agentPhotoSelectionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entry"), entryId: uuidSchema }),
  z.strictObject({ kind: z.literal("preset"), presetId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("clear") }),
]);

export type AgentPhotoSelectionTargetDto = z.infer<typeof agentPhotoSelectionTargetSchema>;

export const agentPhotoLibraryErrorCodeSchema = z.enum([
  "authentication_required",
  "deleted_library_capacity_reached",
  "idempotency_mismatch",
  "invalid_cursor",
  "invalid_photo_request",
  "library_capacity_reached",
  "offline",
  "operation_incomplete",
  "photo_blob_missing",
  "photo_deleted",
  "photo_forbidden",
  "photo_library_unavailable",
  "photo_not_found",
  "selection_conflict",
  "stale_library_revision",
  "stale_viewer_scope",
  "undo_conflict",
]);

export type AgentPhotoLibraryErrorCodeDto = z.infer<
  typeof agentPhotoLibraryErrorCodeSchema
>;

export const agentPhotoLibraryCurrentStateSchema = z.strictObject({
  avatarRef: agentPhotoAvatarRefSchema.nullable(),
  entryId: uuidSchema.nullable(),
  scope: agentPhotoLibraryScopeSchema,
});

export type AgentPhotoLibraryCurrentStateDto = z.infer<
  typeof agentPhotoLibraryCurrentStateSchema
>;

export const agentPhotoLibraryErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: agentPhotoLibraryErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    scope: agentPhotoLibraryScopeSchema.optional(),
    current: agentPhotoLibraryCurrentStateSchema.optional(),
  }),
});

export type AgentPhotoLibraryErrorEnvelope = z.infer<
  typeof agentPhotoLibraryErrorEnvelopeSchema
>;

export type AgentPhotoSelectionOriginDto =
  | "workbench"
  | "mobile"
  | "desktop_wizard"
  | "cli_setup"
  | "manage_avatar"
  | "bundle_import";
