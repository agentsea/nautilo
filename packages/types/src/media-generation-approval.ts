/** D525 — public and checkpoint-private shapes for one paid media approval. */

export const MEDIA_GENERATION_APPROVAL_VERSION = "media-generation-approval-v1" as const;
export const MEDIA_GENERATION_PREPARED_VERSION = "media-generation-prepared-v1" as const;
export const MEDIA_GENERATION_APPROVAL_REVISION = 1 as const;
export const MEDIA_GENERATION_PROMPT_SUMMARY_MAX_CHARS = 160;

export type MediaGenerationToolName = "generate_video" | "generate_music";
export type MediaGenerationApprovalKind = "video" | "music";

/**
 * The authority that created a paid-media approval.  This is deliberately a
 * closed union: a first-party Video request is not a synthetic Genie turn and
 * cannot borrow the tool-call namespace.
 */
export type MediaGenerationApprovalOrigin =
  | Readonly<{
      kind: "genie_tool";
      threadId: string;
      turnId: string;
      laneKey: string;
      toolCallId: string;
      toolName: MediaGenerationToolName;
    }>
  | Readonly<{
      kind: "video_app";
      /** Public Workspace artifact identity, never an internal row id. */
      projectArtifactId: string;
      /** Caller-supplied idempotency identity, scoped by the server route. */
      requestId: string;
    }>;

export type MediaGenerationApprovalModel =
  | "seedance-2-5-text-to-video-basic"
  | "seedance-2-5-reference-to-video-basic"
  | "minimax-h3-enhanced-text-to-video"
  | "sonilo-v1-1-music"
  | "minimax-music-v26";

export interface MediaGenerationPromptPreview {
  readonly characterCount: number;
  readonly summary: string;
  readonly truncated: boolean;
}

/** Exact authorized bytes for a visual approval, never a URL or storage locator. */
export interface MediaGenerationReferenceContent {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
}

export interface MediaGenerationApprovalPreview {
  readonly mediaKind: MediaGenerationApprovalKind;
  readonly model: MediaGenerationApprovalModel;
  /** Server-selected, model-specific values only. Prompt, lyrics, filenames, and provider data are excluded. */
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  /** Ordered authorized Workspace references; no bytes, storage URI, or internal DB id. */
  readonly referenceImages?: readonly Readonly<{
    index: number;
    artifactId: string;
    label: string;
    content?: MediaGenerationReferenceContent;
  }>[];
  readonly referenceVideos?: readonly Readonly<{ index: number; artifactId: string; label: string; durationSeconds: number; content?: MediaGenerationReferenceContent }>[];
  readonly referenceAudios?: readonly Readonly<{ index: number; artifactId: string; label: string; durationSeconds: number; content?: MediaGenerationReferenceContent }>[];
  readonly prompt: MediaGenerationPromptPreview;
  readonly quote: { readonly currency: "USD"; readonly amountMicros: number; readonly display: string };
  readonly spendNotice: "Approving starts a paid generation using this exact quote.";
}

/** Public, secret-free approval projection carried over realtime. */
export interface MediaGenerationApproval {
  readonly version: typeof MEDIA_GENERATION_APPROVAL_VERSION;
  readonly digest: string;
  readonly quoteDigest: string;
  readonly revision: typeof MEDIA_GENERATION_APPROVAL_REVISION;
  readonly expiresAt: string;
  readonly preview: MediaGenerationApprovalPreview;
}

/** Checkpoint-private identity binding. Never project this object to a client or model. */
export interface MediaGenerationApprovalBinding {
  readonly userId: string;
  readonly roomId: string;
  readonly origin: MediaGenerationApprovalOrigin;
  /** Genie-only compatibility mirrors. Never populated for video_app. */
  readonly threadId?: string;
  readonly turnId?: string;
  readonly laneKey?: string;
  readonly toolCallId?: string;
  readonly toolName?: MediaGenerationToolName;
  readonly approvalId: string;
  /** Stable server-local receipt reserved before paid admission; never public. */
  readonly receiptId: string;
  readonly approvalDigest: string;
  readonly quoteDigest: string;
  readonly revision: typeof MEDIA_GENERATION_APPROVAL_REVISION;
  readonly expiresAt: string;
}

/** Trusted tool arguments checkpointed after preparation replaces the model's proposal. */
export interface MediaGenerationPreparedApproval<TRequest = unknown> {
  readonly version: typeof MEDIA_GENERATION_PREPARED_VERSION;
  readonly binding: MediaGenerationApprovalBinding;
  readonly request: TRequest;
  readonly quoteUsdMicros: number;
  readonly preview: MediaGenerationApprovalPreview;
}

const MODELS = new Set<MediaGenerationApprovalModel>([
  "seedance-2-5-text-to-video-basic",
  "seedance-2-5-reference-to-video-basic",
  "minimax-h3-enhanced-text-to-video",
  "sonilo-v1-1-music",
  "minimax-music-v26",
]);
const DIGEST = /^[a-f0-9]{64}$/;
const SAFE_SETTING_KEYS = new Set([
  "durationSeconds", "aspectRatio", "resolution", "audio", "forceInstrumental", "referenceImages", "referenceVideos", "referenceVideoSeconds", "referenceAudios", "referenceAudioSeconds",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function validExpiresAt(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function containsUrl(value: string): boolean {
  return /(?:https?:\/\/|www\.|data:|blob:)/iu.test(value);
}

function validReferenceContent(value: unknown, kind: "image" | "video" | "audio"): boolean {
  if (value === undefined) return true; // Older pending approvals have no visual binding.
  const content = record(value);
  return !!content && exactKeys(content, ["sha256", "sizeBytes", "mimeType"]) &&
    typeof content["sha256"] === "string" && DIGEST.test(content["sha256"]) &&
    Number.isSafeInteger(content["sizeBytes"]) && Number(content["sizeBytes"]) > 0 &&
    typeof content["mimeType"] === "string" && (kind === "video"
      ? ["video/mp4", "video/quicktime"].includes(content["mimeType"])
      : kind === "audio" ? ["audio/mpeg", "audio/wav", "audio/x-wav"].includes(content["mimeType"])
      : ["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"].includes(content["mimeType"]));
}

export function isMediaGenerationApprovalPreview(value: unknown): value is MediaGenerationApprovalPreview {
  const preview = record(value);
  if (!preview || !hasOnlyKeys(preview, ["mediaKind", "model", "settings", "referenceImages", "referenceVideos", "referenceAudios", "prompt", "quote", "spendNotice"]) ||
      ![6, 7, 8, 9].includes(Object.keys(preview).length)) return false;
  if (preview["mediaKind"] !== "video" && preview["mediaKind"] !== "music") return false;
  if (typeof preview["model"] !== "string" || !MODELS.has(preview["model"] as MediaGenerationApprovalModel)) return false;
  const settings = record(preview["settings"]);
  if (!settings || Object.keys(settings).length > SAFE_SETTING_KEYS.size) return false;
  for (const [key, setting] of Object.entries(settings)) {
    if (!SAFE_SETTING_KEYS.has(key)) return false;
    if (typeof setting !== "string" && typeof setting !== "number" && typeof setting !== "boolean") return false;
    if (typeof setting === "string" && (setting.length > 32 || containsUrl(setting))) return false;
    if (key === "durationSeconds" && (!Number.isSafeInteger(setting) || (setting as number) < 1 || (setting as number) > 600)) return false;
    if ((key === "referenceVideos" || key === "referenceAudios") && (!Number.isSafeInteger(setting) || (setting as number) < 1 || (setting as number) > 10)) return false;
    if ((key === "referenceVideoSeconds" || key === "referenceAudioSeconds") && (typeof setting !== "number" || !Number.isFinite(setting) || setting < 2 || setting > 30)) return false;
    if (key === "referenceImages" && (!Number.isSafeInteger(setting) || (setting as number) < 1 || (setting as number) > 30)) return false;
    if ((key === "aspectRatio" || key === "resolution") &&
      (typeof setting !== "string" || !/^[A-Za-z0-9:]{1,8}$/.test(setting))) return false;
    if ((key === "audio" || key === "forceInstrumental") && typeof setting !== "boolean") return false;
  }
  const prompt = record(preview["prompt"]);
  if (!prompt || !exactKeys(prompt, ["characterCount", "summary", "truncated"])) return false;
  if (!Number.isSafeInteger(prompt["characterCount"]) || (prompt["characterCount"] as number) < 1) return false;
  if (typeof prompt["summary"] !== "string" || prompt["summary"].length > MEDIA_GENERATION_PROMPT_SUMMARY_MAX_CHARS || containsUrl(prompt["summary"])) return false;
  if ((prompt["characterCount"] as number) < prompt["summary"].length) return false;
  if (typeof prompt["truncated"] !== "boolean") return false;
  const quote = record(preview["quote"]);
  if (!quote || !exactKeys(quote, ["currency", "amountMicros", "display"]) || quote["currency"] !== "USD") return false;
  if (!Number.isSafeInteger(quote["amountMicros"]) || (quote["amountMicros"] as number) < 0) return false;
  if (typeof quote["display"] !== "string" || !/^USD [0-9]+\.[0-9]{6}$/.test(quote["display"])) return false;
  const amountMicros = quote["amountMicros"] as number;
  const expectedDisplay = `USD ${Math.floor(amountMicros / 1_000_000)}.${String(amountMicros % 1_000_000).padStart(6, "0")}`;
  if (quote["display"] !== expectedDisplay) return false;
  const model = preview["model"] as MediaGenerationApprovalModel;
  const referenceImages = preview["referenceImages"];
  if (model === "seedance-2-5-reference-to-video-basic") {
    if (!Array.isArray(referenceImages) || referenceImages.length > 30 ||
        referenceImages.some((reference, index) => {
          const item = record(reference);
          return !item || !exactKeys(item, ["index", "artifactId", "label", ...(item["content"] === undefined ? [] : ["content"])]) || !validReferenceContent(item["content"], "image") || item["index"] !== index + 1 ||
            typeof item["artifactId"] !== "string" || item["artifactId"].length < 1 || item["artifactId"].length > 256 ||
            typeof item["label"] !== "string" || item["label"].length < 1 || item["label"].length > 160 || containsUrl(item["label"]);
        })) return false;
    const videos = preview["referenceVideos"];
    if (videos !== undefined && (!Array.isArray(videos) || videos.length < 1 || videos.length > 10 ||
        videos.some((reference, index) => {
          const item = record(reference);
          return !item || !exactKeys(item, ["index", "artifactId", "label", "durationSeconds", ...(item["content"] === undefined ? [] : ["content"])]) || !validReferenceContent(item["content"], "video") || item["index"] !== index + 1 ||
            typeof item["artifactId"] !== "string" || item["artifactId"].length < 1 || item["artifactId"].length > 256 ||
            typeof item["label"] !== "string" || item["label"].length < 1 || item["label"].length > 160 || containsUrl(item["label"]) ||
            typeof item["durationSeconds"] !== "number" || !Number.isFinite(item["durationSeconds"]) || item["durationSeconds"] < 2 || item["durationSeconds"] > 30;
        }))) return false;
    const audios = preview["referenceAudios"];
    if (audios !== undefined && (!Array.isArray(audios) || audios.length < 1 || audios.length > 10 ||
        audios.some((reference, index) => {
          const item = record(reference);
          return !item || !exactKeys(item, ["index", "artifactId", "label", "durationSeconds", ...(item["content"] === undefined ? [] : ["content"])]) || !validReferenceContent(item["content"], "audio") || item["index"] !== index + 1 ||
            typeof item["artifactId"] !== "string" || item["artifactId"].length < 1 || item["artifactId"].length > 256 ||
            typeof item["label"] !== "string" || item["label"].length < 1 || item["label"].length > 160 || containsUrl(item["label"]) ||
            typeof item["durationSeconds"] !== "number" || !Number.isFinite(item["durationSeconds"]) || item["durationSeconds"] < 2 || item["durationSeconds"] > 30;
        }))) return false;
    if (!referenceImages.length && !(Array.isArray(videos) && videos.length)) return false;
    if (referenceImages.length !== (settings["referenceImages"] ?? 0)) return false;
    if (Array.isArray(videos) && (videos.length !== settings["referenceVideos"] ||
        videos.reduce<number>((sum, ref: unknown) => sum + Number(record(ref)?.["durationSeconds"]), 0) !== settings["referenceVideoSeconds"])) return false;
    if (videos === undefined && (settings["referenceVideos"] !== undefined || settings["referenceVideoSeconds"] !== undefined)) return false;
    if (Array.isArray(audios) && (audios.length !== settings["referenceAudios"] ||
        audios.reduce<number>((sum, ref: unknown) => sum + Number(record(ref)?.["durationSeconds"]), 0) !== settings["referenceAudioSeconds"])) return false;
    if (audios === undefined && (settings["referenceAudios"] !== undefined || settings["referenceAudioSeconds"] !== undefined)) return false;
  } else if (referenceImages !== undefined || preview["referenceVideos"] !== undefined || preview["referenceAudios"] !== undefined) return false;
  const mediaKind = preview["mediaKind"];
  if ((model === "seedance-2-5-text-to-video-basic" || model === "seedance-2-5-reference-to-video-basic" || model === "minimax-h3-enhanced-text-to-video") !== (mediaKind === "video")) return false;
  const keys = Object.keys(settings).sort().join(",");
  if (model === "seedance-2-5-text-to-video-basic" && keys !== "aspectRatio,audio,durationSeconds,resolution") return false;
  if (model === "seedance-2-5-reference-to-video-basic" &&
      Object.keys(settings).filter(key => !["referenceImages", "referenceVideos", "referenceVideoSeconds", "referenceAudios", "referenceAudioSeconds"].includes(key)).sort().join(",") !== "aspectRatio,audio,durationSeconds,resolution") return false;
  if (model === "minimax-h3-enhanced-text-to-video" && keys !== "aspectRatio,durationSeconds,resolution") return false;
  if (model === "sonilo-v1-1-music" && keys !== "durationSeconds") return false;
  if (model === "minimax-music-v26" && keys !== "forceInstrumental") return false;
  const duration = settings["durationSeconds"];
  if ((model === "seedance-2-5-text-to-video-basic" || model === "seedance-2-5-reference-to-video-basic") &&
    (typeof duration !== "number" || duration < 4 || duration > 30 ||
      !["480p", "720p", "1080p"].includes(settings["resolution"] as string))) return false;
  if (model === "minimax-h3-enhanced-text-to-video" &&
    (typeof duration !== "number" || duration < 5 || duration > 15 ||
      !["768P", "2K"].includes(settings["resolution"] as string))) return false;
  if (model === "sonilo-v1-1-music" &&
    (typeof duration !== "number" || duration < 1 || duration > 600)) return false;
  if ((model === "seedance-2-5-text-to-video-basic" || model === "seedance-2-5-reference-to-video-basic" || model === "minimax-h3-enhanced-text-to-video") &&
    !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(settings["aspectRatio"] as string)) return false;
  return preview["spendNotice"] === "Approving starts a paid generation using this exact quote.";
}

export function isMediaGenerationApproval(value: unknown): value is MediaGenerationApproval {
  const approval = record(value);
  return approval !== null &&
    exactKeys(approval, ["version", "digest", "quoteDigest", "revision", "expiresAt", "preview"]) &&
    approval["version"] === MEDIA_GENERATION_APPROVAL_VERSION &&
    typeof approval["digest"] === "string" && DIGEST.test(approval["digest"]) &&
    typeof approval["quoteDigest"] === "string" && DIGEST.test(approval["quoteDigest"]) &&
    approval["revision"] === MEDIA_GENERATION_APPROVAL_REVISION &&
    validExpiresAt(approval["expiresAt"]) &&
    isMediaGenerationApprovalPreview(approval["preview"]);
}

export function isMediaGenerationPreparedApproval(value: unknown): value is MediaGenerationPreparedApproval {
  const prepared = record(value);
  if (!prepared || !exactKeys(prepared, ["version", "binding", "request", "quoteUsdMicros", "preview"])) return false;
  if (prepared["version"] !== MEDIA_GENERATION_PREPARED_VERSION || !record(prepared["request"])) return false;
  if (!Number.isSafeInteger(prepared["quoteUsdMicros"]) || (prepared["quoteUsdMicros"] as number) < 0) return false;
  if (!isMediaGenerationApprovalPreview(prepared["preview"])) return false;
  const binding = record(prepared["binding"]);
  if (!binding) return false;
  const baseKeys = ["userId", "roomId", "origin", "approvalId", "receiptId", "approvalDigest", "quoteDigest", "revision", "expiresAt"];
  const origin = record(binding["origin"]);
  if (!origin || typeof origin["kind"] !== "string") return false;
  if (origin["kind"] === "genie_tool") {
    if (!exactKeys(binding, [...baseKeys, "threadId", "turnId", "laneKey", "toolCallId", "toolName"]) ||
        !exactKeys(origin, ["kind", "threadId", "turnId", "laneKey", "toolCallId", "toolName"])) return false;
    for (const key of ["threadId", "turnId", "laneKey", "toolCallId"] as const) {
      if (!boundedIdentity(binding[key]) || binding[key] !== origin[key]) return false;
    }
    if (binding["toolName"] !== origin["toolName"] ||
        (origin["toolName"] !== "generate_video" && origin["toolName"] !== "generate_music")) return false;
  } else if (origin["kind"] === "video_app") {
    if (!exactKeys(binding, baseKeys) || !exactKeys(origin, ["kind", "projectArtifactId", "requestId"]) ||
        !boundedIdentity(origin["projectArtifactId"]) || !boundedIdentity(origin["requestId"])) return false;
  } else return false;
  for (const key of ["userId", "roomId", "approvalId"] as const) {
    if (!boundedIdentity(binding[key])) return false;
  }
  if (typeof binding["receiptId"] !== "string" || !/^mg_[A-Za-z0-9_-]{16,128}$/.test(binding["receiptId"])) return false;
  if (typeof binding["approvalDigest"] !== "string" || !DIGEST.test(binding["approvalDigest"])) return false;
  if (typeof binding["quoteDigest"] !== "string" || !DIGEST.test(binding["quoteDigest"])) return false;
  return binding["revision"] === MEDIA_GENERATION_APPROVAL_REVISION && validExpiresAt(binding["expiresAt"]);
}
