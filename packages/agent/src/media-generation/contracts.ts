import { createHash } from "node:crypto";
import { z } from "zod";
import {
  validateWorkspaceLogicalPath,
  WORKSPACE_LOGICAL_PATH_MAX_CHARS,
  VENICE_REFERENCE_AUDIO_MAX_BYTES,
  VENICE_REFERENCE_AUDIO_SIZE_WARNING,
  VENICE_REFERENCE_VIDEO_MAX_BYTES,
  VENICE_REFERENCE_VIDEO_SIZE_WARNING,
} from "@nautilo/types";

export const VENICE_MEDIA_MODELS = {
  seedance: "seedance-2-5-text-to-video-basic",
  seedanceReference: "seedance-2-5-reference-to-video-basic",
  minimaxH3: "minimax-h3-enhanced-text-to-video",
  sonilo: "sonilo-v1-1-music",
  minimaxMusic: "minimax-music-v26",
} as const;

export type VeniceMediaModel = (typeof VENICE_MEDIA_MODELS)[keyof typeof VENICE_MEDIA_MODELS];
export type MediaGenerationKind = "video" | "music";

const VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;
const SEEDANCE_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const MINIMAX_H3_RESOLUTIONS = ["768P", "2K"] as const;

const localReceiptSchema = z.string().trim().regex(/^mg_[A-Za-z0-9_-]{16,128}$/);
const filenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((value) => !/[\\/\0\r\n]/.test(value), "Filename must not contain a path or newline.");

const commonSchema = z.object({
  prompt: z.string().trim().min(1),
  filename: filenameSchema.optional(),
}).strict();

const referenceImageIntentSchema = z.object({
  path: z.string().min(1).max(WORKSPACE_LOGICAL_PATH_MAX_CHARS).superRefine((path, ctx) => {
    const checked = validateWorkspaceLogicalPath(path);
    if (!checked.ok) ctx.addIssue({ code: "custom", message: checked.reason });
  }),
}).strict();

const referenceImageBindingSchema = referenceImageIntentSchema.extend({
  artifactId: z.string().trim().min(1).max(256),
  artifactInternalId: z.string().uuid(),
  revision: z.number().int().positive(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"]),
  sizeBytes: z.number().int().positive().max(30 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

// Venice Seedance 2.5 R2V image/video/audio contract, verified 2026-09-16:
// https://docs.venice.ai/guides/media/seedance-2-0#multimodal-input-limits
const referenceVideoBindingSchema = referenceImageBindingSchema.extend({
  mimeType: z.enum(["video/mp4", "video/quicktime"]),
  sizeBytes: z.number().int().positive().max(VENICE_REFERENCE_VIDEO_MAX_BYTES, VENICE_REFERENCE_VIDEO_SIZE_WARNING),
  durationSeconds: z.number().finite().min(2).max(30),
});

const referenceAudioBindingSchema = referenceImageBindingSchema.extend({
  mimeType: z.enum(["audio/mpeg", "audio/wav", "audio/x-wav"]),
  sizeBytes: z.number().int().positive().max(VENICE_REFERENCE_AUDIO_MAX_BYTES, VENICE_REFERENCE_AUDIO_SIZE_WARNING),
  durationSeconds: z.number().finite().min(2).max(30),
});

const seedanceSchema = commonSchema.extend({
  model: z.literal(VENICE_MEDIA_MODELS.seedance),
  prompt: z.string().trim().min(1).max(15_000),
  durationSeconds: z.number().int().min(4).max(30).default(5),
  aspectRatio: z.enum(VIDEO_RATIOS).default("16:9"),
  resolution: z.enum(SEEDANCE_RESOLUTIONS).default("720p"),
  audio: z.boolean().default(true),
});

const seedanceReferenceIntentSchema = commonSchema.extend({
  model: z.literal(VENICE_MEDIA_MODELS.seedanceReference),
  prompt: z.string().trim().min(1).max(15_000),
  durationSeconds: z.number().int().min(4).max(30).default(10),
  aspectRatio: z.enum(VIDEO_RATIOS).default("16:9"),
  resolution: z.enum(SEEDANCE_RESOLUTIONS).default("720p"),
  audio: z.boolean().default(true),
  referenceImages: z.array(referenceImageIntentSchema).max(30).default([]),
  referenceVideos: z.array(referenceImageIntentSchema).max(10).optional(),
  referenceAudios: z.array(referenceImageIntentSchema).max(10).optional(),
});

const seedanceReferenceBoundSchema = seedanceReferenceIntentSchema.omit({ referenceImages: true, referenceVideos: true, referenceAudios: true }).extend({
  referenceImages: z.array(referenceImageBindingSchema).max(30),
  referenceVideos: z.array(referenceVideoBindingSchema).max(10).optional(),
  referenceAudios: z.array(referenceAudioBindingSchema).max(10).optional(),
});

const minimaxH3Schema = commonSchema.extend({
  model: z.literal(VENICE_MEDIA_MODELS.minimaxH3),
  prompt: z.string().trim().min(1).max(7_000),
  durationSeconds: z.number().int().min(5).max(15).default(5),
  aspectRatio: z.enum(VIDEO_RATIOS).default("16:9"),
  resolution: z.enum(MINIMAX_H3_RESOLUTIONS).default("768P"),
});

const soniloSchema = commonSchema.extend({
  model: z.literal(VENICE_MEDIA_MODELS.sonilo),
  prompt: z.string().trim().min(1).max(4_096),
  durationSeconds: z.number().int().min(1).max(600).default(90),
});

const minimaxMusicSchema = commonSchema.extend({
  model: z.literal(VENICE_MEDIA_MODELS.minimaxMusic),
  prompt: z.string().trim().min(10).max(300),
  lyrics: z.string().trim().min(1).max(1_000).optional(),
  forceInstrumental: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.forceInstrumental && value.lyrics) {
    ctx.addIssue({ code: "custom", message: "Instrumental music cannot include lyrics.", path: ["lyrics"] });
  }
});

const requestSchema = z.discriminatedUnion("model", [
  seedanceSchema,
  seedanceReferenceBoundSchema,
  minimaxH3Schema,
  soniloSchema,
  minimaxMusicSchema,
]);

const intentSchema = z.discriminatedUnion("model", [
  seedanceSchema,
  seedanceReferenceIntentSchema,
  minimaxH3Schema,
  soniloSchema,
  minimaxMusicSchema,
]);

export type MediaGenerationReferenceVideoBinding = z.infer<typeof referenceVideoBindingSchema>;
export type MediaGenerationReferenceAudioBinding = z.infer<typeof referenceAudioBindingSchema>;
export type MediaGenerationReferenceImageBinding = z.infer<typeof referenceImageBindingSchema>;
export type NormalizedMediaGenerationIntent = z.infer<typeof intentSchema>;

export type NormalizedMediaGenerationRequest =
  | { model: typeof VENICE_MEDIA_MODELS.seedance; prompt: string; filename?: string | undefined; durationSeconds: number; aspectRatio: (typeof VIDEO_RATIOS)[number]; resolution: (typeof SEEDANCE_RESOLUTIONS)[number]; audio: boolean }
  | { model: typeof VENICE_MEDIA_MODELS.seedanceReference; prompt: string; filename?: string | undefined; durationSeconds: number; aspectRatio: (typeof VIDEO_RATIOS)[number]; resolution: (typeof SEEDANCE_RESOLUTIONS)[number]; audio: boolean; referenceImages: MediaGenerationReferenceImageBinding[]; referenceVideos?: MediaGenerationReferenceVideoBinding[] | undefined; referenceAudios?: MediaGenerationReferenceAudioBinding[] | undefined }
  | { model: typeof VENICE_MEDIA_MODELS.minimaxH3; prompt: string; filename?: string | undefined; durationSeconds: number; aspectRatio: (typeof VIDEO_RATIOS)[number]; resolution: (typeof MINIMAX_H3_RESOLUTIONS)[number] }
  | { model: typeof VENICE_MEDIA_MODELS.sonilo; prompt: string; filename?: string | undefined; durationSeconds: number }
  | { model: typeof VENICE_MEDIA_MODELS.minimaxMusic; prompt: string; filename?: string | undefined; lyrics?: string | undefined; forceInstrumental: boolean };

/** Dated fallback facts; live catalog data supersedes them when it is available. */
export const LOCKED_VENICE_MEDIA_MODEL_FACTS = {
  [VENICE_MEDIA_MODELS.seedance]: { kind: "video", outputMime: "video/mp4", anonymized: true, audio: "configurable" },
  [VENICE_MEDIA_MODELS.seedanceReference]: { kind: "video", outputMime: "video/mp4", anonymized: true, audio: "configurable", references: ["image", "video", "audio"] },
  [VENICE_MEDIA_MODELS.minimaxH3]: { kind: "video", outputMime: "video/mp4", anonymized: true, audio: "forced_on" },
  [VENICE_MEDIA_MODELS.sonilo]: { kind: "music", outputMime: "audio/mp4", outputExtension: "m4a", anonymized: true, audio: "instrumental" },
  [VENICE_MEDIA_MODELS.minimaxMusic]: { kind: "music", outputMime: "audio/mpeg", outputExtension: "mp3", anonymized: true, audio: "lyrics_or_instrumental" },
} as const;

export class MediaGenerationValidationError extends Error {
  readonly code = "MEDIA_GENERATION_INVALID_REQUEST" as const;
  readonly validChoices: readonly string[];

  constructor(message: string, validChoices: readonly string[] = []) {
    super(message);
    this.name = "MediaGenerationValidationError";
    this.validChoices = validChoices;
  }
}

function modelChoices(model: unknown): readonly string[] {
  switch (model) {
    case VENICE_MEDIA_MODELS.seedance:
      return ["duration 4–30 seconds", "480p, 720p, or 1080p", ...VIDEO_RATIOS, "audio on or off"];
    case VENICE_MEDIA_MODELS.seedanceReference:
      return ["Up to 30 Workspace images, 10 videos, and 10 MP3/WAV audio references (audio and video 2–30 seconds each, 30 seconds total per kind)", "At least one image or video reference", "duration 4–30 seconds", "480p, 720p, or 1080p", ...VIDEO_RATIOS, "audio on or off"];
    case VENICE_MEDIA_MODELS.minimaxH3:
      return ["duration 5–15 seconds", "768P or 2K", ...VIDEO_RATIOS, "audio is provider-managed"];
    case VENICE_MEDIA_MODELS.sonilo:
      return ["duration 1–600 seconds", "instrumental music only"];
    case VENICE_MEDIA_MODELS.minimaxMusic:
      return ["prompt 10–300 characters", "lyrics up to 1,000 characters", "instrumental on or off"];
    default:
      return Object.values(VENICE_MEDIA_MODELS);
  }
}

function normalizeEmptyModelAuthoredMusicFields(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (value["model"] !== VENICE_MEDIA_MODELS.sonilo && value["model"] !== VENICE_MEDIA_MODELS.minimaxMusic) return input;
  const normalized = { ...value };
  if (typeof normalized["lyrics"] === "string" && normalized["lyrics"].trim().length === 0) {
    delete normalized["lyrics"];
  }
  if (normalized["model"] === VENICE_MEDIA_MODELS.sonilo && normalized["forceInstrumental"] === true) {
    // Sonilo is inherently instrumental, so this carries no additional intent.
    delete normalized["forceInstrumental"];
  }
  return normalized;
}

function normalizeVideoGenerationEnvelope(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  if (value["action"] !== undefined && value["action"] !== "generate") return input;
  const model = value["model"];
  if (model !== VENICE_MEDIA_MODELS.seedance &&
    model !== VENICE_MEDIA_MODELS.seedanceReference &&
    model !== VENICE_MEDIA_MODELS.minimaxH3) return input;
  const normalized = { ...value };
  if (normalized["action"] === "generate") delete normalized["action"];
  if (model === VENICE_MEDIA_MODELS.seedance || model === VENICE_MEDIA_MODELS.minimaxH3) {
    if (Array.isArray(normalized["referenceImages"]) && normalized["referenceImages"].length === 0) {
      delete normalized["referenceImages"];
    }
    if (Array.isArray(normalized["referenceVideos"]) && normalized["referenceVideos"].length === 0) {
      delete normalized["referenceVideos"];
    }
    if (Array.isArray(normalized["referenceAudios"]) && normalized["referenceAudios"].length === 0) {
      delete normalized["referenceAudios"];
    }
  }
  return normalized;
}

function assertActionableModelIntent(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const value = input as Record<string, unknown>;
  if (value["model"] === VENICE_MEDIA_MODELS.sonilo) {
    if (typeof value["lyrics"] === "string" && value["lyrics"].trim().length > 0) {
      throw new MediaGenerationValidationError(
        "Sonilo creates instrumental music and cannot use lyrics. Choose MiniMax Music to preserve the requested lyrics.",
        modelChoices(value["model"]),
      );
    }
    if (value["forceInstrumental"] === false) {
      throw new MediaGenerationValidationError(
        "Sonilo creates instrumental music only. Choose MiniMax Music when vocals are requested.",
        modelChoices(value["model"]),
      );
    }
  }
  if (value["model"] === VENICE_MEDIA_MODELS.minimaxMusic && value["durationSeconds"] !== undefined) {
    throw new MediaGenerationValidationError(
      "MiniMax Music does not accept a requested duration. Remove durationSeconds or choose Sonilo to preserve the duration.",
      modelChoices(value["model"]),
    );
  }
}

/**
 * Validate and fill the first-wave defaults before any provider or quote call.
 * This deliberately accepts only text-to-video/music inputs; reference media,
 * editing, TTS, and sound effects belong to later explicitly-scoped work.
 */
export function normalizeMediaGenerationRequest(input: unknown): NormalizedMediaGenerationRequest {
  const parsed = requestSchema.safeParse(input);
  if (parsed.success) {
    assertReferenceInputs(parsed.data);
    return parsed.data as NormalizedMediaGenerationRequest;
  }

  const model = input && typeof input === "object" ? (input as Record<string, unknown>)["model"] : undefined;
  const message = parsed.error.issues[0]?.message ?? "The media generation request is invalid.";
  throw new MediaGenerationValidationError(message, modelChoices(model));
}

function assertReferenceInputs(value: { model: string; referenceImages?: readonly unknown[] | undefined; referenceVideos?: readonly { path: string; durationSeconds?: number }[] | undefined; referenceAudios?: readonly { path: string; durationSeconds?: number }[] | undefined }): void {
  if (value.model !== VENICE_MEDIA_MODELS.seedanceReference) return;
  if (!value.referenceImages?.length && !value.referenceVideos?.length) {
    throw new MediaGenerationValidationError("Attach at least one image or video reference.");
  }
  if ((value.referenceVideos ?? []).reduce((sum, ref) => sum + (ref.durationSeconds ?? 0), 0) > 30) {
    throw new MediaGenerationValidationError("Seedance accepts at most 30 seconds of reference video in total. Choose shorter clips.");
  }
  if ((value.referenceAudios ?? []).reduce((sum, ref) => sum + (ref.durationSeconds ?? 0), 0) > 30) {
    throw new MediaGenerationValidationError("Seedance accepts at most 30 seconds of reference audio in total. Choose shorter clips.");
  }
}

/** Model-authored tool intent. Internal artifact bindings are deliberately rejected here. */
export function normalizeMediaGenerationIntent(input: unknown): NormalizedMediaGenerationIntent {
  assertActionableModelIntent(input);
  const parsed = intentSchema.safeParse(normalizeVideoGenerationEnvelope(normalizeEmptyModelAuthoredMusicFields(input)));
  if (parsed.success) { assertReferenceInputs(parsed.data); return parsed.data; }
  const model = input && typeof input === "object" ? (input as Record<string, unknown>)["model"] : undefined;
  const message = parsed.error.issues[0]?.message ?? "The media generation request is invalid.";
  throw new MediaGenerationValidationError(message, modelChoices(model));
}

export function mediaGenerationKindForModel(model: VeniceMediaModel): MediaGenerationKind {
  return model === VENICE_MEDIA_MODELS.seedance || model === VENICE_MEDIA_MODELS.seedanceReference || model === VENICE_MEDIA_MODELS.minimaxH3 ? "video" : "music";
}

/**
 * Quote pricing inputs, deliberately distinct from the future queue payload.
 * Creative prompt, lyrics, and instrumental direction must never be copied here.
 */
export type VeniceQuotePricingRequest =
  | { model: typeof VENICE_MEDIA_MODELS.seedance; duration: string; aspect_ratio: string; resolution: string; audio: boolean }
  | { model: typeof VENICE_MEDIA_MODELS.seedanceReference; duration: string; aspect_ratio: string; resolution: string; audio: boolean; reference_video_total_duration?: number }
  | { model: typeof VENICE_MEDIA_MODELS.minimaxH3; duration: string; aspect_ratio: string; resolution: string }
  | { model: typeof VENICE_MEDIA_MODELS.sonilo; duration_seconds: number }
  | { model: typeof VENICE_MEDIA_MODELS.minimaxMusic };

/** Builds the documented pricing-only `/video/quote` or `/audio/quote` payload. It never queues work. */
export function toVeniceQuotePricingRequest(request: NormalizedMediaGenerationRequest): VeniceQuotePricingRequest {
  switch (request.model) {
    case VENICE_MEDIA_MODELS.seedance:
    case VENICE_MEDIA_MODELS.seedanceReference:
      return {
        model: request.model, duration: `${request.durationSeconds}s`,
        aspect_ratio: request.aspectRatio, resolution: request.resolution, audio: request.audio,
        ...(request.model === VENICE_MEDIA_MODELS.seedanceReference && request.referenceVideos?.length
          ? { reference_video_total_duration: request.referenceVideos.reduce((sum, ref) => sum + ref.durationSeconds, 0) } : {}),
      };
    case VENICE_MEDIA_MODELS.minimaxH3:
      return {
        model: request.model, duration: `${request.durationSeconds}s`,
        aspect_ratio: request.aspectRatio, resolution: request.resolution,
      };
    case VENICE_MEDIA_MODELS.sonilo:
      return { model: request.model, duration_seconds: request.durationSeconds };
    case VENICE_MEDIA_MODELS.minimaxMusic:
      return { model: request.model };
  }
}

export function quoteEndpointFor(request: NormalizedMediaGenerationRequest): "/video/quote" | "/audio/quote" {
  return mediaGenerationKindForModel(request.model) === "video" ? "/video/quote" : "/audio/quote";
}

/** A private approval binding; keep this out of normal tool output because it contains prompt-derived data. */
export function mediaGenerationApprovalDigest(request: NormalizedMediaGenerationRequest, quoteUsd: number): string {
  return createHash("sha256").update(JSON.stringify({ request, quoteUsd })).digest("hex");
}

export type MediaGenerationPublicReceipt = {
  generationId: string;
  kind: MediaGenerationKind;
  model: VeniceMediaModel;
  status: "quoted" | "queued" | "generating" | "downloading" | "saving" | "ready" | "needs_action" | "failed" | "unknown" | "cleanup_pending";
};

/** Validates the opaque local identifier and exposes no Venice queue ID, URL, or provider response. */
export function publicMediaGenerationReceipt(receipt: MediaGenerationPublicReceipt): MediaGenerationPublicReceipt {
  const generationId = localReceiptSchema.safeParse(receipt.generationId);
  if (!generationId.success) throw new MediaGenerationValidationError("Generation receipt is malformed.");
  return { ...receipt, generationId: generationId.data };
}
