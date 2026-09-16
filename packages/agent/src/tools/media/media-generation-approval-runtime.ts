import { createHash } from "node:crypto";
import { withMediaGenerationDefault } from "../../config/media-generation-models";
import {
  MEDIA_GENERATION_APPROVAL_REVISION,
  MEDIA_GENERATION_APPROVAL_VERSION,
  MEDIA_GENERATION_PREPARED_VERSION,
  MEDIA_GENERATION_PROMPT_SUMMARY_MAX_CHARS,
  isMediaGenerationPreparedApproval,
  type MediaGenerationApproval,
  type MediaGenerationApprovalBinding,
  type MediaGenerationApprovalPreview,
  type MediaGenerationApprovalOrigin,
  type MediaGenerationPreparedApproval,
  type MediaGenerationToolName,
} from "@nautilo/types";
import {
  MediaGenerationValidationError,
  mediaGenerationKindForModel,
  normalizeMediaGenerationIntent,
  normalizeMediaGenerationRequest,
  type NormalizedMediaGenerationIntent,
  type NormalizedMediaGenerationRequest,
} from "../../media-generation/contracts";

export interface MediaGenerationApprovalActorContext {
  readonly userId: string;
  readonly roomId: string;
  /** Exact initiating Genie. Required so durable completion can wake the same agent. */
  readonly agentId: string;
}

export interface GenieToolMediaGenerationPreparationInput {
  readonly request: NormalizedMediaGenerationIntent;
  readonly toolName: MediaGenerationToolName;
  readonly approvalId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly laneKey: string;
  readonly toolCallId: string;
}

export interface VideoAppMediaGenerationPreparationInput {
  readonly request: NormalizedMediaGenerationIntent;
  readonly approvalId: string;
  readonly origin: Extract<MediaGenerationApprovalOrigin, { readonly kind: "video_app" }>;
}

export type MediaGenerationPreparationInput =
  | GenieToolMediaGenerationPreparationInput
  | VideoAppMediaGenerationPreparationInput;

type ResolvedMediaGenerationPreparationInput =
  | (Omit<GenieToolMediaGenerationPreparationInput, "request"> & {
      readonly request: NormalizedMediaGenerationRequest;
    })
  | (Omit<VideoAppMediaGenerationPreparationInput, "request"> & {
      readonly request: NormalizedMediaGenerationRequest;
    });

export interface MediaGenerationSubmitInput {
  readonly prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>;
  readonly approvalId: string;
  readonly receiptId: string;
  readonly digest: string;
  readonly quoteDigest: string;
  readonly revision: number;
  /** Required only for the closed genie_tool origin. */
  readonly toolCallId?: string | undefined;
}

export type MediaGenerationCardState =
  | "queued"
  | "generating"
  | "downloading"
  | "saving"
  | "ready"
  | "needs-action"
  | "failed"
  | "unknown"
  | "cleanup-pending";

export interface MediaGenerationSafeResult {
  readonly kind: "generated_media";
  readonly version: 1;
  /** Opaque Nautilo receipt. Omitted only when no durable receipt can be trusted. */
  readonly receiptId?: string;
  /** True = acknowledged; false = provably not started; null = admission outcome unknown. */
  readonly queueStarted: boolean | null;
  readonly mediaKind: "video" | "audio";
  readonly state: MediaGenerationCardState;
  readonly model: string;
  readonly promptSummary: string;
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  readonly progress?: Readonly<{
    elapsedSeconds?: number;
    estimatedSeconds?: number;
    message?: string;
  }>;
  readonly artifact?: Readonly<{
    artifactId: string;
    path: string;
    zone: "workspace";
    mime: string;
    bytes: number;
  }>;
  readonly failure?: Readonly<{
    code: string;
    message: string;
    creditsRefunded?: boolean;
  }>;
  readonly recoveryActions: readonly Readonly<{
    actionId: string;
    kind: "wait" | "retry_same_receipt" | "revise_prompt" | "switch_model" | "repair_venice" | "fresh_generation";
    label: string;
    newSpend: boolean;
  }>[];
}

export type MediaGenerationPreparationResult =
  | { readonly ok: true; readonly prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest> }
  | { readonly ok: false; readonly code:
      | "target_unavailable"
      | "request_invalid"
      | "quote_unavailable"
      | "quote_rejected"
      | "quote_binding_failed"
      | "quote_reservation_failed";
      readonly recovery: string };

/** Server implementation owns exact quoting and paid submission. */
export interface MediaGenerationApprovalRuntime {
  prepare(
    ctx: MediaGenerationApprovalActorContext,
    input: MediaGenerationPreparationInput,
  ): Promise<MediaGenerationPreparationResult>;
  submit(
    ctx: MediaGenerationApprovalActorContext,
    input: MediaGenerationSubmitInput,
  ): Promise<MediaGenerationSafeResult>;
}

let runtime: MediaGenerationApprovalRuntime | null = null;
const preparations = new Map<string, {
  readonly intentDigest: string;
  readonly promise: Promise<MediaGenerationPreparationResult>;
}>();
const MAX_PREPARATIONS = 256;

export function setMediaGenerationApprovalRuntime(value: MediaGenerationApprovalRuntime | null): void {
  runtime = value;
  preparations.clear();
}

export function getMediaGenerationApprovalRuntime(): MediaGenerationApprovalRuntime {
  if (!runtime) {
    throw new Error("media generation approval runtime is not registered");
  }
  return runtime;
}

/** Registration probe. Unlike the getter, this is safe during process boot. */
export function hasMediaGenerationApprovalRuntime(): boolean {
  return runtime !== null;
}

export function resetMediaGenerationApprovalRuntimeForTests(): void {
  setMediaGenerationApprovalRuntime(null);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function redactLinks(value: string): string {
  return value.replace(/(?:https?:\/\/|www\.|data:|blob:)\S*/giu, "[link omitted]");
}

function promptPreview(prompt: string): MediaGenerationApprovalPreview["prompt"] {
  const summary = redactLinks(prompt).replace(/\s+/gu, " ").trim();
  return {
    characterCount: prompt.length,
    summary: summary.slice(0, MEDIA_GENERATION_PROMPT_SUMMARY_MAX_CHARS),
    truncated: summary.length > MEDIA_GENERATION_PROMPT_SUMMARY_MAX_CHARS,
  };
}

function referenceLabel(path: string): string {
  const label = path.split("/").filter(Boolean).at(-1) ?? "Workspace image";
  return redactLinks(label).replace(/[\r\n\0]/gu, "").trim().slice(0, 160) || "Workspace image";
}

function safeSettings(request: NormalizedMediaGenerationRequest): MediaGenerationApprovalPreview["settings"] {
  switch (request.model) {
    case "seedance-2-5-text-to-video-basic":
      return {
        durationSeconds: request.durationSeconds,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        audio: request.audio,
      };
    case "seedance-2-5-reference-to-video-basic":
      return {
        durationSeconds: request.durationSeconds,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
        audio: request.audio,
        ...(request.referenceImages.length ? { referenceImages: request.referenceImages.length } : {}),
        ...(request.referenceVideos?.length ? { referenceVideos: request.referenceVideos.length,
          referenceVideoSeconds: request.referenceVideos.reduce((sum, ref) => sum + ref.durationSeconds, 0) } : {}),
      };
    case "minimax-h3-enhanced-text-to-video":
      return {
        durationSeconds: request.durationSeconds,
        aspectRatio: request.aspectRatio,
        resolution: request.resolution,
      };
    case "sonilo-v1-1-music":
      return { durationSeconds: request.durationSeconds };
    case "minimax-music-v26":
      return { forceInstrumental: request.forceInstrumental };
  }
}

const LOCAL_RECEIPT = /^mg_[A-Za-z0-9_-]{16,128}$/;
const UNSAFE_TEXT = /(?:https?:\/\/|data:|blob:|queue[_ -]?id|signed[_ -]?url|download[_ -]?url)/iu;

function isSafeCardText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= max &&
    (allowEmpty || value.trim().length > 0) && !/[\r\n\0]/u.test(value) && !UNSAFE_TEXT.test(value);
}

function isSafeCardResult(value: unknown): value is MediaGenerationSafeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  const allowed = new Set([
    "kind", "version", "receiptId", "queueStarted", "mediaKind", "state", "model",
    "promptSummary", "settings", "progress", "artifact", "failure", "recoveryActions",
  ]);
  if (Object.keys(card).some((key) => !allowed.has(key))) return false;
  if (card["kind"] !== "generated_media" || card["version"] !== 1) return false;
  if (card["queueStarted"] !== true && card["queueStarted"] !== false && card["queueStarted"] !== null) return false;
  if (card["mediaKind"] !== "video" && card["mediaKind"] !== "audio") return false;
  if (!isSafeCardText(card["model"], 256) || !isSafeCardText(card["promptSummary"], MEDIA_GENERATION_PROMPT_SUMMARY_MAX_CHARS, true)) return false;
  const receiptId = card["receiptId"];
  if (receiptId !== undefined && (typeof receiptId !== "string" || !LOCAL_RECEIPT.test(receiptId))) return false;
  if ((card["queueStarted"] === true || card["queueStarted"] === null) && receiptId === undefined) return false;
  const states = new Set<MediaGenerationCardState>([
    "queued", "generating", "downloading", "saving", "ready", "needs-action",
    "failed", "unknown", "cleanup-pending",
  ]);
  if (typeof card["state"] !== "string" || !states.has(card["state"] as MediaGenerationCardState)) return false;
  if (card["queueStarted"] === null && card["state"] !== "unknown") return false;
  if (card["queueStarted"] === false && card["state"] !== "failed" && card["state"] !== "needs-action") return false;
  if (card["queueStarted"] === true && card["state"] === "unknown") return false;
  const settings = card["settings"];
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
  for (const [key, setting] of Object.entries(settings as Record<string, unknown>)) {
    if (!key || /(?:queue|receipt|provider|url|raw)/iu.test(key)) return false;
    if (typeof setting === "string" ? !isSafeCardText(setting, 128, true)
      : typeof setting === "number" ? !Number.isFinite(setting)
        : typeof setting !== "boolean") return false;
  }
  if (!Array.isArray(card["recoveryActions"])) return false;
  // The initial submit result carries no server-minted recovery handles. They
  // arrive from the authorized durable-status endpoint on later revisions.
  if (card["recoveryActions"].length !== 0) return false;
  const failure = card["failure"];
  const requiresFailure = card["state"] === "needs-action" || card["state"] === "failed" || card["state"] === "unknown";
  if (requiresFailure !== (failure !== undefined)) return false;
  if (failure !== undefined) {
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) return false;
    const record = failure as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["code", "message", "creditsRefunded"].includes(key))) return false;
    if (!isSafeCardText(record["code"], 128) || !isSafeCardText(record["message"], 280)) return false;
    if (record["creditsRefunded"] !== undefined && typeof record["creditsRefunded"] !== "boolean") return false;
  }
  // Initial submit cannot truthfully carry artifact/progress bytes or paths.
  return card["artifact"] === undefined && card["progress"] === undefined;
}

function mediaKindForTool(toolName: MediaGenerationToolName): "video" | "audio" {
  return toolName === "generate_video" ? "video" : "audio";
}

function originForPreparation(input: MediaGenerationPreparationInput): MediaGenerationApprovalOrigin {
  return "origin" in input
    ? input.origin
    : {
        kind: "genie_tool",
        threadId: input.threadId,
        turnId: input.turnId,
        laneKey: input.laneKey,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
      };
}

function mediaKindForOrigin(origin: MediaGenerationApprovalOrigin): "video" | "audio" {
  return origin.kind === "video_app" ? "video" : mediaKindForTool(origin.toolName);
}

export function createUnboundMediaGenerationFailure(input: {
  readonly toolName: MediaGenerationToolName;
  readonly code: string;
  readonly message: string;
}): MediaGenerationSafeResult {
  return {
    kind: "generated_media",
    version: 1,
    queueStarted: false,
    mediaKind: mediaKindForTool(input.toolName),
    state: "failed",
    model: "unavailable",
    promptSummary: "",
    settings: {},
    failure: { code: input.code, message: input.message },
    recoveryActions: [],
  };
}

function rejectedRuntimeResult(
  input: MediaGenerationSubmitInput,
  code: string,
  message: string,
): MediaGenerationSafeResult {
  const prepared = input.prepared;
  return {
    kind: "generated_media",
    version: 1,
    receiptId: prepared.binding.receiptId,
    // A malformed submit result cannot prove whether provider admission
    // happened. Fence new spend until the durable receipt is reconciled.
    queueStarted: null,
    mediaKind: mediaKindForOrigin(prepared.binding.origin),
    state: "unknown",
    model: prepared.preview.model,
    promptSummary: prepared.preview.prompt.summary,
    settings: prepared.preview.settings,
    failure: { code, message },
    recoveryActions: [],
  };
}

export function createMediaGenerationPreparedApproval(input: {
  readonly actor: MediaGenerationApprovalActorContext;
  readonly preparation: MediaGenerationPreparationInput | ResolvedMediaGenerationPreparationInput;
  /** Reserved server-local id. The preparer must return the same id on replay. */
  readonly receiptId: string;
  readonly quoteUsdMicros: number;
  readonly expiresAt: string;
}): MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest> {
  if (!/^mg_[A-Za-z0-9_-]{16,128}$/.test(input.receiptId)) throw new Error("invalid local media receipt id");
  if (!Number.isSafeInteger(input.quoteUsdMicros) || input.quoteUsdMicros < 0) throw new Error("invalid exact media quote");
  const expires = new Date(input.expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.toISOString() !== input.expiresAt) {
    throw new Error("invalid media approval expiry");
  }
  const actor = input.actor;
  const normalizedRequest = normalizeMediaGenerationRequest(input.preparation.request);
  const preparation: ResolvedMediaGenerationPreparationInput = "origin" in input.preparation
    ? { ...input.preparation, request: normalizedRequest }
    : { ...input.preparation, request: normalizedRequest };
  const origin = originForPreparation(preparation);
  const expectedKind = origin.kind === "video_app" ? "video" : origin.toolName === "generate_video" ? "video" : "music";
  if (mediaGenerationKindForModel(preparation.request.model) !== expectedKind) {
    throw new Error("media tool and normalized request kind disagree");
  }
  const quoteDigest = digest({ currency: "USD", amountMicros: input.quoteUsdMicros });
  const identity = {
    userId: actor.userId,
    roomId: actor.roomId,
    origin,
    approvalId: preparation.approvalId,
    receiptId: input.receiptId,
    quoteDigest,
    revision: MEDIA_GENERATION_APPROVAL_REVISION,
    expiresAt: input.expiresAt,
  } as const;
  const approvalDigest = digest({ identity, request: preparation.request, quoteUsdMicros: input.quoteUsdMicros });
  const binding: MediaGenerationApprovalBinding = origin.kind === "genie_tool"
    ? {
        ...identity,
        threadId: origin.threadId,
        turnId: origin.turnId,
        laneKey: origin.laneKey,
        toolCallId: origin.toolCallId,
        toolName: origin.toolName,
        approvalDigest,
      }
    : { ...identity, approvalDigest };
  const preview: MediaGenerationApprovalPreview = {
    mediaKind: expectedKind,
    model: preparation.request.model,
    settings: safeSettings(preparation.request),
    ...(preparation.request.model === "seedance-2-5-reference-to-video-basic"
      ? {
          ...(preparation.request.referenceVideos?.length ? { referenceVideos: preparation.request.referenceVideos.map((reference, index) => ({
            index: index + 1, artifactId: reference.artifactId, label: referenceLabel(reference.path), durationSeconds: reference.durationSeconds,
            content: { sha256: reference.sha256, sizeBytes: reference.sizeBytes, mimeType: reference.mimeType },
          })) } : {}),
          referenceImages: preparation.request.referenceImages.map((reference, index) => ({
            index: index + 1,
            artifactId: reference.artifactId,
            label: referenceLabel(reference.path),
            content: { sha256: reference.sha256, sizeBytes: reference.sizeBytes, mimeType: reference.mimeType },
          })),
        }
      : {}),
    prompt: promptPreview(preparation.request.prompt),
    quote: {
      currency: "USD",
      amountMicros: input.quoteUsdMicros,
      display: `USD ${Math.floor(input.quoteUsdMicros / 1_000_000)}.${String(input.quoteUsdMicros % 1_000_000).padStart(6, "0")}`,
    },
    spendNotice: "Approving starts a paid generation using this exact quote.",
  };
  return {
    version: MEDIA_GENERATION_PREPARED_VERSION,
    binding,
    request: preparation.request,
    quoteUsdMicros: input.quoteUsdMicros,
    preview,
  };
}

export function mediaGenerationApprovalFromPrepared(
  prepared: MediaGenerationPreparedApproval,
): MediaGenerationApproval {
  return {
    version: MEDIA_GENERATION_APPROVAL_VERSION,
    digest: prepared.binding.approvalDigest,
    quoteDigest: prepared.binding.quoteDigest,
    revision: prepared.binding.revision,
    expiresAt: prepared.binding.expiresAt,
    preview: prepared.preview,
  };
}

/** Recomputes both digests, so forged checkpoint args fail before submission. */
export function verifyMediaGenerationPreparedApproval(
  prepared: unknown,
  expected: {
    readonly userId: string;
    readonly roomId: string;
    readonly approvalId: string;
    readonly receiptId: string;
    readonly digest: string;
    readonly quoteDigest: string;
    readonly revision: number;
    readonly now?: Date;
  } & (
    | Readonly<{ origin: MediaGenerationApprovalOrigin }>
    | Readonly<{ threadId: string; turnId: string; laneKey: string; toolCallId: string; toolName: MediaGenerationToolName }>
  ),
): prepared is MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest> {
  if (!isMediaGenerationPreparedApproval(prepared)) return false;
  let request: NormalizedMediaGenerationRequest;
  try {
    request = normalizeMediaGenerationRequest(prepared.request);
  } catch {
    return false;
  }
  if (canonical(request) !== canonical(prepared.request)) return false;
  const binding = prepared.binding;
  const expectedOrigin: MediaGenerationApprovalOrigin = "origin" in expected
    ? expected.origin
    : {
        kind: "genie_tool",
        threadId: expected.threadId,
        turnId: expected.turnId,
        laneKey: expected.laneKey,
        toolCallId: expected.toolCallId,
        toolName: expected.toolName,
      };
  if (
    binding.userId !== expected.userId || binding.roomId !== expected.roomId ||
    canonical(binding.origin) !== canonical(expectedOrigin) || binding.approvalId !== expected.approvalId ||
    binding.receiptId !== expected.receiptId ||
    binding.approvalDigest !== expected.digest || binding.quoteDigest !== expected.quoteDigest ||
    binding.revision !== expected.revision || binding.revision !== MEDIA_GENERATION_APPROVAL_REVISION ||
    new Date(binding.expiresAt).getTime() <= (expected.now ?? new Date()).getTime()
  ) return false;
  const quoteDigest = digest({ currency: "USD", amountMicros: prepared.quoteUsdMicros });
  if (quoteDigest !== binding.quoteDigest) return false;
  // Genie compatibility mirrors are not approval identity: the closed origin
  // already carries those exact graph coordinates. Keeping the digest over
  // this common base makes video_app and genie_tool equally verifiable.
  const identity = {
    userId: binding.userId,
    roomId: binding.roomId,
    origin: binding.origin,
    approvalId: binding.approvalId,
    receiptId: binding.receiptId,
    quoteDigest: binding.quoteDigest,
    revision: binding.revision,
    expiresAt: binding.expiresAt,
  };
  const approvalDigest = digest({ identity, request, quoteUsdMicros: prepared.quoteUsdMicros });
  return approvalDigest === binding.approvalDigest &&
    prepared.preview.quote.amountMicros === prepared.quoteUsdMicros &&
    prepared.preview.model === request.model &&
    prepared.preview.mediaKind === mediaGenerationKindForModel(request.model);
}

/** Normalizes once and memoizes the exact checkpoint-bound quote preparation across graph replay. */
export function prepareMediaGenerationApproval(input: {
  readonly actor: MediaGenerationApprovalActorContext;
  readonly intent: unknown;
  readonly approvalId: string;
} & (
  | Readonly<{ toolName: MediaGenerationToolName; threadId: string; turnId: string; laneKey: string; toolCallId: string }>
  | Readonly<{ origin: Extract<MediaGenerationApprovalOrigin, { readonly kind: "video_app" }> }>
)): Promise<MediaGenerationPreparationResult> {
  // Compare the original intent before consulting mutable server defaults.
  // Replaying an unchanged approval must reuse its already quoted model.
  const intentDigest = digest(input);
  const existing = preparations.get(input.approvalId);
  if (existing) {
    if (existing.intentDigest !== intentDigest) {
      return Promise.resolve({
        ok: false,
        code: "request_invalid",
        recovery: "This approval changed while it was being prepared. Request a fresh generation.",
      });
    }
    return existing.promise;
  }
  let request: NormalizedMediaGenerationIntent;
  try {
    const intent = "origin" in input ? input.intent
      : withMediaGenerationDefault(input.toolName === "generate_music" ? "music" : "video", input.intent);
    request = normalizeMediaGenerationIntent(intent);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      code: "request_invalid",
      recovery: error instanceof MediaGenerationValidationError
        ? `${error.message} No generation was started.`
        : "Review the media settings and try again. No generation was started.",
    });
  }
  const kind = mediaGenerationKindForModel(request.model);
  const origin: MediaGenerationApprovalOrigin = "origin" in input
    ? input.origin
    : { kind: "genie_tool", threadId: input.threadId, turnId: input.turnId, laneKey: input.laneKey, toolCallId: input.toolCallId, toolName: input.toolName };
  if (mediaKindForOrigin(origin) !== (kind === "video" ? "video" : "audio")) {
    return Promise.resolve({
      ok: false,
      code: "request_invalid",
      recovery: "Choose a model supported by this media tool and try again. No generation was started.",
    });
  }
  // A server can boot legitimately without Venice configured. Preparation is
  // the no-spend boundary, so surface that state through its typed contract
  // instead of letting the strict runtime getter turn it into an HTTP 500.
  // Keep this after request/origin validation so malformed requests retain
  // their existing result, and do not cache it so runtime registration can
  // make an unchanged retry immediately eligible for a fresh quote.
  const approvalRuntime = runtime;
  if (!approvalRuntime) {
    return Promise.resolve({
      ok: false,
      code: "quote_unavailable",
      recovery: "Configure Venice for media generation, then request a fresh quote. No generation was started.",
    });
  }
  const preparation: MediaGenerationPreparationInput = origin.kind === "video_app"
    ? {
        // Workspace references are resolved by the server preparer before
        // quoting. The prepared approval still requires fully bound bytes.
        request,
        approvalId: input.approvalId,
        origin,
      }
    : {
        request,
        approvalId: input.approvalId,
        ...origin,
      };
  const promise = approvalRuntime.prepare(input.actor, preparation).then((result) => {
    if (!result.ok) return result;
    return verifyMediaGenerationPreparedApproval(result.prepared, {
      ...input.actor,
    origin: originForPreparation(preparation),
      approvalId: preparation.approvalId,
      receiptId: result.prepared.binding.receiptId,
      digest: result.prepared.binding.approvalDigest,
      quoteDigest: result.prepared.binding.quoteDigest,
      revision: result.prepared.binding.revision,
    }) ? result : {
      ok: false as const,
      code: "quote_unavailable" as const,
      recovery: "The exact quote could not be bound safely. Request a fresh quote.",
    };
  });
  preparations.set(input.approvalId, { intentDigest, promise });
  if (preparations.size > MAX_PREPARATIONS) preparations.delete(preparations.keys().next().value as string);
  return promise;
}

/**
 * Final fail-closed boundary immediately before the injected paid submit
 * port. The server submit implementation MUST be idempotent for the exact
 * receiptId + approval digest; this process-local layer does not pretend to
 * provide durable replay protection.
 */
export function submitMediaGenerationApproval(
  actor: MediaGenerationApprovalActorContext,
  input: MediaGenerationSubmitInput,
): Promise<MediaGenerationSafeResult> {
  const binding = input.prepared.binding;
  const submittedOrigin = binding.origin;
  const valid = verifyMediaGenerationPreparedApproval(input.prepared, {
    userId: actor.userId,
    roomId: actor.roomId,
    origin: binding.origin,
    approvalId: input.approvalId,
    receiptId: input.receiptId,
    digest: input.digest,
    quoteDigest: input.quoteDigest,
    revision: input.revision,
  });
  if (!valid) {
    return Promise.resolve(createUnboundMediaGenerationFailure({
      toolName: submittedOrigin.kind === "genie_tool" ? submittedOrigin.toolName : "generate_video",
      code: "APPROVAL_STALE",
      message: "This media approval is stale or does not match the prepared request. Request a fresh quote.",
    }));
  }
  return getMediaGenerationApprovalRuntime().submit(actor, input).then((result) => {
    if (isSafeCardResult(result) &&
      // A verified prepared submit always has a reserved durable receipt,
      // including deterministic refusal before provider acceptance.
      result.receiptId === input.receiptId &&
      result.mediaKind === mediaKindForOrigin(input.prepared.binding.origin) &&
      result.model === input.prepared.preview.model &&
      result.promptSummary === input.prepared.preview.prompt.summary &&
      canonical(result.settings) === canonical(input.prepared.preview.settings)) return result;
    return rejectedRuntimeResult(
      input,
      "SUBMISSION_RESULT_INVALID",
      "The generation result could not be verified safely. Check status before starting another generation.",
    );
  });
}
