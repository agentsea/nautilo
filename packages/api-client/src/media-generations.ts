import { z } from "zod";

/**
 * D525 Phase 3.1 — browser/client-safe generation-status contract.
 *
 * This is intentionally a projection, not a Venice response or a database
 * row. Provider queue coordinates, delivery URLs, request text, reference
 * locators, filesystem paths, and provider bodies do not have a place in this
 * DTO. Media bytes continue to flow only through the authenticated Artifact
 * APIs after the receipt reaches `ready`.
 */

function isNotUrl(value: string): boolean {
  return !/^(?:https?:|data:|blob:)/iu.test(value);
}

function isSafeStatusMessage(value: string): boolean {
  return isNotUrl(value)
    && !/[\r\n\0]/u.test(value)
    // A JSON/provider-body-shaped value is never safe display text. Keep
    // server classification text short and human-facing instead.
    && !value.includes("{")
    && !value.includes("}")
    && !value.includes("[")
    && !value.includes("]")
    && !/(?:api[_ -]?key|authorization|provider[_ -]?(?:queue|body|response)|queue[_ -]?id|signed[_ -]?url|download[_ -]?url|raw[_ -]?body)/iu.test(value);
}

const safeStatusMessageSchema = z.string().min(1).max(280).refine(
  isSafeStatusMessage,
  "Status message must be bounded safe text.",
);

const opaqueIdSchema = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u)
  .refine(isNotUrl, "Opaque identifiers cannot be URLs.");
const opaqueActionHandleSchema = z.string().min(16).max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);
const nonNegativeIntegerSchema = z.number().int().min(0).max(2_147_483_647);
const positiveIntegerSchema = nonNegativeIntegerSchema.min(1);
const modelIdSchema = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u)
  .refine(isNotUrl, "Model id cannot be a URL.");
const mimeSchema = z.string().min(3).max(128)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u);

function isLogicalWorkspacePath(value: string): boolean {
  return !value.startsWith("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.split("/").some((segment) => segment === "..")
    && isNotUrl(value);
}

const workspacePathSchema = z.string().min(1).max(1_024)
  .refine(isLogicalWorkspacePath, "Artifact path must be a logical Workspace path.");

export const mediaGenerationKindSchema = z.enum(["video", "audio"]);
export const mediaGenerationStateSchema = z.enum([
  "queued",
  "submitting",
  "generating",
  "downloading",
  "saving",
  "ready",
  "needs-action",
  "failed",
  "unknown",
  "cleanup-pending",
]);
export const mediaGenerationProgressPhaseSchema = z.enum([
  "queued",
  "submitting",
  "generating",
  "downloading",
  "saving",
]);
export const mediaGenerationRecoveryKindSchema = z.enum([
  "wait",
  "retry_same_receipt",
  "revise_prompt",
  "switch_model",
  "repair_venice",
  "fresh_generation",
]);

const normalizedSettingsSchema = z.object({
  durationSeconds: positiveIntegerSchema.optional(),
  resolution: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:+-]+$/u).optional(),
  aspectRatio: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:+-]+$/u).optional(),
  audioEnabled: z.boolean().optional(),
  instrumental: z.boolean().optional(),
}).strict();

const progressSchema = z.object({
  phase: mediaGenerationProgressPhaseSchema,
  elapsedSeconds: nonNegativeIntegerSchema.optional(),
  estimatedSeconds: nonNegativeIntegerSchema.optional(),
  message: safeStatusMessageSchema.optional(),
}).strict();

const artifactSchema = z.object({
  /** Authenticated Workspace-artifact external identity, never an internal row id. */
  artifactId: opaqueIdSchema,
  path: workspacePathSchema,
  zone: z.literal("workspace"),
  mime: mimeSchema,
  bytes: positiveIntegerSchema,
}).strict();

const failureSchema = z.object({
  code: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/u),
  message: safeStatusMessageSchema,
  phase: z.enum(["quote", "queue", "retrieve", "download", "save", "cleanup", "reconcile"]),
  retrySafe: z.boolean(),
  stateChanged: z.boolean(),
  completionCertainty: z.enum(["not_started", "accepted", "unknown", "complete"]),
  chargeCertainty: z.enum(["not_charged", "charged", "unknown", "refunded"]),
  creditsRefunded: z.boolean().optional(),
}).strict();

const recoveryActionSchema = z.object({
  /** Server-minted opaque handle, scoped to this receipt/revision/action. */
  actionId: opaqueActionHandleSchema,
  kind: mediaGenerationRecoveryKindSchema,
  /** Server-selected label, never a provider error body or URL. */
  label: z.string().min(1).max(160).refine(
    (value) => isNotUrl(value) && !/[\r\n\0]/u.test(value),
    "Recovery label must be bounded safe text.",
  ),
  /** Fresh work is the only action that can create new paid work. */
  newSpend: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const fresh = value.kind === "fresh_generation";
  if (fresh !== value.newSpend) {
    ctx.addIssue({
      code: "custom",
      message: fresh
        ? "fresh_generation must declare new spend"
        : "only fresh_generation may declare new spend",
      path: ["newSpend"],
    });
  }
});

/** Closed, versioned API projection. Unknown keys are a hard parse failure. */
export const mediaGenerationStatusDtoV1Schema = z.object({
  dtoVersion: z.literal(1),
  /** Opaque Nautilo receipt — never a provider request/queue identifier. */
  receiptId: opaqueIdSchema,
  revision: nonNegativeIntegerSchema,
  mediaKind: mediaGenerationKindSchema,
  state: mediaGenerationStateSchema,
  modelId: modelIdSchema,
  settings: normalizedSettingsSchema,
  progress: progressSchema.optional(),
  artifact: artifactSchema.optional(),
  failure: failureSchema.optional(),
  recoveryActions: z.array(recoveryActionSchema).max(16),
}).strict().superRefine((value, ctx) => {
  const artifactAllowed = value.state === "ready" || value.state === "cleanup-pending";
  if (artifactAllowed !== (value.artifact !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "artifact is present exactly when state is ready",
      path: ["artifact"],
    });
  }
  const failureRequired = value.state === "needs-action" || value.state === "failed" || value.state === "unknown";
  if (failureRequired !== (value.failure !== undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "terminal recovery states carry a safe failure exactly once",
      path: ["failure"],
    });
  }
  if (value.progress && value.progress.phase !== value.state) {
    ctx.addIssue({ code: "custom", message: "progress phase must match state", path: ["progress", "phase"] });
  }
  const actionIds = new Set<string>();
  for (const [index, action] of value.recoveryActions.entries()) {
    if (actionIds.has(action.actionId)) {
      ctx.addIssue({ code: "custom", message: "recovery action ids must be unique", path: ["recoveryActions", index, "actionId"] });
    }
    actionIds.add(action.actionId);
  }
});

export type MediaGenerationStatusDtoV1 = z.infer<typeof mediaGenerationStatusDtoV1Schema>;
const videoTakeIdSchema = z.string().regex(/^take_[A-Za-z0-9_-]{16,128}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const videoBriefDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
// Preserve the prompt for the canonical, model-specific request validator.
const videoPromptSchema = z.string().trim().min(1);
const videoShotIdSchema = z.union([
  z.literal("quick-brief"),
  z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u),
]);
const videoShotLabelSchema = z.string().min(1).superRefine((value, ctx) => {
  if (/[\r\n\0]/u.test(value)) {
    ctx.addIssue({ code: "custom", message: "Video shot label must not contain line breaks or null characters." });
  }
});
const videoModelSchema = z.enum(["seedance-2-5-text-to-video-basic", "seedance-2-5-reference-to-video-basic", "minimax-h3-enhanced-text-to-video"]);
const videoCatalogModelSchema = z.enum(["venice:seedance-2-5-text-to-video-basic", "venice:seedance-2-5-reference-to-video-basic", "venice:minimax-h3-enhanced-text-to-video"]);
const referenceContentBaseSchema = {
  sha256: digestSchema,
  sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const imageReferenceContentSchema = z.object({
  ...referenceContentBaseSchema,
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"]),
}).strict();
const videoReferenceContentSchema = z.object({
  ...referenceContentBaseSchema,
  mimeType: z.enum(["video/mp4", "video/quicktime"]),
}).strict();
const audioReferenceContentSchema = z.object({
  ...referenceContentBaseSchema,
  mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/x-wav"]),
}).strict();
const videoJobSchema = z.object({
  /** Catalog identity, resolved to the D525 provider request only by the server. */
  modelId: videoCatalogModelSchema,
  referenceImages: z.array(z.object({ path: z.string().min(1) }).strict()).max(30).optional(),
  referenceVideos: z.array(z.object({ path: z.string().min(1) }).strict()).max(10).optional(),
  referenceAudios: z.array(z.object({ path: z.string().min(1) }).strict()).max(10).optional(),
  prompt: videoPromptSchema,
  /** These are user requests, not iframe-owned defaults or capability rules. */
  durationSeconds: positiveIntegerSchema.optional(),
  aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
  resolution: z.enum(["480p", "720p", "1080p", "768P", "2K"]).optional(),
  audio: z.boolean().optional(),
}).strict();
const videoApprovalSchema = z.object({
  version: z.literal("media-generation-approval-v1"),
  digest: digestSchema,
  quoteDigest: digestSchema,
  revision: z.literal(1),
  expiresAt: z.string().datetime(),
  preview: z.object({
    mediaKind: z.literal("video"),
    model: videoModelSchema,
    settings: z.object({
      durationSeconds: positiveIntegerSchema,
      aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]),
      resolution: z.enum(["480p", "720p", "1080p", "768P", "2K"]),
      audio: z.boolean().optional(),
      referenceImages: positiveIntegerSchema.max(30).optional(),
      referenceVideos: positiveIntegerSchema.max(10).optional(),
      referenceVideoSeconds: z.number().min(2).max(30).optional(),
      referenceAudios: positiveIntegerSchema.max(10).optional(),
      referenceAudioSeconds: z.number().min(2).max(30).optional(),
    }).strict(),
    referenceImages: z.array(z.object({
      index: positiveIntegerSchema,
      artifactId: z.string(),
      label: z.string(),
      content: imageReferenceContentSchema.optional(),
    }).strict()).max(30).optional(),
    referenceVideos: z.array(z.object({
      index: positiveIntegerSchema,
      artifactId: z.string(),
      label: z.string(),
      durationSeconds: z.number().min(2).max(30),
      content: videoReferenceContentSchema.optional(),
    }).strict()).max(10).optional(),
    referenceAudios: z.array(z.object({
      index: positiveIntegerSchema,
      artifactId: z.string(),
      label: z.string(),
      durationSeconds: z.number().min(2).max(30),
      content: audioReferenceContentSchema.optional(),
    }).strict()).max(10).optional(),
    prompt: z.object({ characterCount: positiveIntegerSchema, summary: safeStatusMessageSchema, truncated: z.boolean() }).strict(),
    quote: z.object({ currency: z.literal("USD"), amountMicros: nonNegativeIntegerSchema, display: z.string().regex(/^USD [0-9]+\.[0-9]{6}$/u) }).strict(),
    spendNotice: z.literal("Approving starts a paid generation using this exact quote."),
  }).strict(),
}).strict();
export const videoGenerationPrepareRequestV1Schema = z.object({
  roomId: opaqueIdSchema,
  projectArtifactId: opaqueIdSchema,
  requestId: opaqueIdSchema,
  shotId: videoShotIdSchema,
  shotLabel: videoShotLabelSchema,
  briefDigest: videoBriefDigestSchema,
  documentRevision: nonNegativeIntegerSchema,
  job: videoJobSchema,
}).strict();
export type VideoGenerationPrepareRequestV1 = z.infer<typeof videoGenerationPrepareRequestV1Schema>;
export const videoGenerationReviewDtoV1Schema = z.object({
  takeId: videoTakeIdSchema,
  reviewHandle: opaqueActionHandleSchema,
  approval: videoApprovalSchema,
}).strict();
export type VideoGenerationReviewDtoV1 = z.infer<typeof videoGenerationReviewDtoV1Schema>;
export const videoGenerationSubmitDtoV1Schema = z.object({
  takeId: videoTakeIdSchema,
  queueStarted: z.boolean().nullable(),
  mediaKind: z.literal("video"),
  state: z.enum(["queued", "generating", "downloading", "saving", "ready", "needs-action", "failed", "unknown", "cleanup-pending"]),
  model: z.union([videoModelSchema, z.literal("unavailable")]),
  // A stale review is deliberately not reconstructed; it has no prompt to summarize.
  promptSummary: z.string().max(160).refine((value) => value.length === 0 || isSafeStatusMessage(value)),
  settings: z.object({
    durationSeconds: positiveIntegerSchema.optional(),
    aspectRatio: z.enum(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]).optional(),
    resolution: z.enum(["480p", "720p", "1080p", "768P", "2K"]).optional(),
    audio: z.boolean().optional(),
    referenceImages: positiveIntegerSchema.max(30).optional(),
    referenceVideos: positiveIntegerSchema.max(10).optional(),
    referenceVideoSeconds: z.number().min(2).max(30).optional(),
    referenceAudios: positiveIntegerSchema.max(10).optional(),
    referenceAudioSeconds: z.number().min(2).max(30).optional(),
  }).strict(),
  failure: z.object({ code: z.string().min(1).max(128), message: safeStatusMessageSchema, creditsRefunded: z.boolean().optional() }).strict().optional(),
  recoveryActions: z.array(recoveryActionSchema).max(16),
}).strict();
export type VideoGenerationSubmitDtoV1 = z.infer<typeof videoGenerationSubmitDtoV1Schema>;
/** Video project projection deliberately omits D525's private receipt handle. */
export const videoGenerationTakeStatusDtoV1Schema = z.object({
  takeId: videoTakeIdSchema,
  dtoVersion: z.literal(1),
  revision: nonNegativeIntegerSchema,
  mediaKind: mediaGenerationKindSchema,
  state: mediaGenerationStateSchema,
  modelId: modelIdSchema,
  settings: normalizedSettingsSchema,
  progress: progressSchema.optional(),
  artifact: artifactSchema.optional(),
  failure: failureSchema.optional(),
  recoveryActions: z.array(recoveryActionSchema).max(16),
}).strict().superRefine((value, ctx) => {
  const { takeId: _takeId, ...status } = value;
  const checked = mediaGenerationStatusDtoV1Schema.safeParse({ receiptId: "video-local-receipt", ...status });
  if (!checked.success) ctx.addIssue({ code: "custom", message: "Video take status must satisfy the safe media status invariants." });
});
export type VideoGenerationTakeStatusDtoV1 = z.infer<typeof videoGenerationTakeStatusDtoV1Schema>;
export const videoHostAttestationDtoV1Schema = z.object({
  attestationToken: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  expiresAt: z.string().datetime(),
}).strict();
export type VideoHostAttestationDtoV1 = z.infer<typeof videoHostAttestationDtoV1Schema>;
export const videoGenerationTakeListDtoV1Schema = z.object({
  takes: z.array(z.object({
    takeId: videoTakeIdSchema,
    shotId: videoShotIdSchema,
    shotLabel: videoShotLabelSchema,
    documentRevision: nonNegativeIntegerSchema,
  }).strict()),
}).strict();
export type VideoGenerationTakeListDtoV1 = z.infer<typeof videoGenerationTakeListDtoV1Schema>;
export type MediaGenerationState = z.infer<typeof mediaGenerationStateSchema>;
export type MediaGenerationRecoveryKind = z.infer<typeof mediaGenerationRecoveryKindSchema>;

/** Returns null for unknown keys, topology, invalid revision, or incoherent state shape. */
export function parseMediaGenerationStatusDtoV1(value: unknown): MediaGenerationStatusDtoV1 | null {
  const parsed = mediaGenerationStatusDtoV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** DB-only state vocabulary accepted by the server mapper, never sent to clients. */
export type DurableMediaGenerationState =
  | "prequeue"
  | "admitting"
  | "queued"
  | "retrieving"
  | "saving"
  | "ready"
  | "needs_action"
  | "failed"
  | "unknown";

export interface MediaGenerationStatusSourceV1 {
  readonly receiptId: string;
  readonly revision: number;
  readonly kind: "video" | "music";
  /** Catalog model id, not a provider queue or request id. */
  readonly modelId: string;
  readonly state: DurableMediaGenerationState;
  readonly settings: z.input<typeof normalizedSettingsSchema>;
  /** Durable local cleanup state; only `ready` + pending is card-visible. */
  readonly cleanupState: "pending" | "completed";
  /** Optional server-calculated, safe timing evidence. */
  readonly progress?: z.input<typeof progressSchema> | undefined;
  readonly artifact?: z.input<typeof artifactSchema> | undefined;
  readonly failure?: z.input<typeof failureSchema> | undefined;
  readonly recoveryActions: readonly z.input<typeof recoveryActionSchema>[];
}

function stateForSource(source: MediaGenerationStatusSourceV1): MediaGenerationState {
  switch (source.state) {
    case "prequeue":
    case "queued":
      return source.progress?.phase === "generating" ? "generating" : "queued";
    case "admitting":
      // The provider has not acknowledged a queue id yet. Calling this
      // "submitting" avoids falsely claiming the paid job is queued.
      return "submitting";
    case "retrieving":
      return source.progress?.phase === "generating" ? "generating" : "downloading";
    case "saving":
      return "saving";
    case "ready":
      return source.cleanupState === "pending" ? "cleanup-pending" : "ready";
    case "needs_action":
      return "needs-action";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
  }
}

function progressForSource(
  source: MediaGenerationStatusSourceV1,
  state: MediaGenerationState,
): z.input<typeof progressSchema> | undefined {
  if (state === "ready" || state === "cleanup-pending" || state === "needs-action" || state === "failed" || state === "unknown") return undefined;
  if (source.progress) return source.progress;
  return { phase: state };
}

/**
 * Maps a server-owned, already-authorized receipt projection to the closed
 * wire DTO. The final schema parse is intentional: a server mapper cannot
 * accidentally introduce an unsafe field or an incoherent ready/failure state.
 */
export function mapMediaGenerationStatusV1(
  source: MediaGenerationStatusSourceV1,
): MediaGenerationStatusDtoV1 {
  const state = stateForSource(source);
  const progress = progressForSource(source, state);
  if (state !== "ready" && state !== "cleanup-pending" && source.artifact !== undefined) {
    throw new Error("media generation artifact cannot be projected before an artifact-ready state");
  }
  if (state !== "needs-action" && state !== "failed" && state !== "unknown" && source.failure !== undefined) {
    throw new Error("media generation failure cannot be projected for an in-progress receipt");
  }
  const dto = {
    dtoVersion: 1 as const,
    receiptId: source.receiptId,
    revision: source.revision,
    mediaKind: source.kind === "music" ? "audio" as const : "video" as const,
    state,
    modelId: source.modelId,
    settings: source.settings,
    ...(progress ? { progress } : {}),
    ...((state === "ready" || state === "cleanup-pending") && source.artifact ? { artifact: source.artifact } : {}),
    ...((state === "needs-action" || state === "failed" || state === "unknown") && source.failure
      ? { failure: source.failure }
      : {}),
    recoveryActions: [...source.recoveryActions],
  };
  return mediaGenerationStatusDtoV1Schema.parse(dto);
}

/** Order an incoming update against the currently displayed receipt. */
export function compareMediaGenerationStatusRevision(
  current: Pick<MediaGenerationStatusDtoV1, "receiptId" | "revision">,
  incoming: Pick<MediaGenerationStatusDtoV1, "receiptId" | "revision">,
): "different_receipt" | "older" | "same" | "newer" {
  if (current.receiptId !== incoming.receiptId) return "different_receipt";
  if (incoming.revision < current.revision) return "older";
  if (incoming.revision > current.revision) return "newer";
  return "same";
}

/** Convenience guard for ignoring a delayed status event for the same receipt. */
export function isStaleMediaGenerationStatus(
  current: Pick<MediaGenerationStatusDtoV1, "receiptId" | "revision">,
  incoming: Pick<MediaGenerationStatusDtoV1, "receiptId" | "revision">,
): boolean {
  return compareMediaGenerationStatusRevision(current, incoming) === "older";
}
