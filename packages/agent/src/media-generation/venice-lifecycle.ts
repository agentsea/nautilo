import { VENICE_API_V1_BASE } from "../providers/venice-api";
import type { MediaGenerationAdmissionProof } from "@nautilo/db";
import {
  mediaGenerationKindForModel,
  type MediaGenerationKind,
  type VeniceMediaModel,
} from "./contracts";
import {
  classifyVeniceMediaFailure,
  sanitizeVeniceProviderCode,
  type MediaGenerationFailure,
} from "./errors";

/**
 * Venice's paid media API is deliberately a separate lifecycle from its quote
 * endpoints. These constants are private transport coordinates, never tool
 * names or user-visible result data.
 */
const VENICE_MEDIA_QUEUE_ENDPOINTS = {
  video: "/video/queue",
  music: "/audio/queue",
} as const;

const VENICE_MEDIA_RETRIEVE_ENDPOINTS = {
  video: "/video/retrieve",
  music: "/audio/retrieve",
} as const;

const VENICE_MEDIA_COMPLETE_ENDPOINTS = {
  video: "/video/complete",
  music: "/audio/complete",
} as const;

const RETRIEVE_BASE_DELAY_MS = 5_000;
const RETRIEVE_MAX_DELAY_MS = 60_000;
const MAX_RETRIEVE_SCHEDULE_ATTEMPT = 30;

export type VeniceQueuePayload =
  | { model: "seedance-2-5-text-to-video-basic"; prompt: string; duration: string; aspect_ratio: string; resolution: string; audio: boolean }
  | { model: "seedance-2-5-reference-to-video-basic"; prompt: string; duration: string; aspect_ratio: string; resolution: string; audio: boolean; reference_image_urls?: string[]; reference_video_urls?: string[] }
  | { model: "minimax-h3-enhanced-text-to-video"; prompt: string; duration: string; aspect_ratio: string; resolution: string }
  | { model: "sonilo-v1-1-music"; prompt: string; duration_seconds: number }
  | { model: "minimax-music-v26"; prompt: string; lyrics_prompt?: string; force_instrumental: boolean };

export type VeniceAcceptedMediaWork = Readonly<{
  /** The same opaque local receipt supplied by the DB-minted admission proof. */
  receiptId: string;
  model: VeniceMediaModel;
  kind: MediaGenerationKind;
  /** Provider-only queue coordinate. Never serialize this into a tool result. */
  providerQueueId: string;
  /** Provider-only short-lived URL from a private video queue response. */
  signedDeliveryUrl?: string;
}>;

export type VeniceArtifactCommitProof = Readonly<{
  /** Must match the accepted receipt; artifact storage issues this only after durable index commit. */
  receiptId: string;
  artifactInternalId: string;
  artifactRevision: number;
  state: "durably_committed";
}>;

export type VeniceRetrieveSchedule = Readonly<{
  delayMs: number;
  nextAttemptAt: Date;
}>;

export type VeniceProcessingResult = Readonly<{
  state: "processing";
  receiptId: string;
  estimatedExecutionMs?: number;
  executionDurationMs?: number;
  schedule: VeniceRetrieveSchedule;
}>;

export type VeniceBinaryResult = Readonly<{
  state: "binary";
  receiptId: string;
  contentType: string | null;
  body: ReadableStream<Uint8Array>;
}>;

export type VeniceSignedDeliveryResult = Readonly<{
  state: "signed_delivery";
  receiptId: string;
  /** Internal server-only URL, validated immediately before the download lane uses it. */
  signedDeliveryUrl: string;
}>;

export type VeniceRetrieveResult = VeniceProcessingResult | VeniceBinaryResult | VeniceSignedDeliveryResult;

export type VeniceMediaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface VeniceMediaLifecycleConfig {
  readonly apiKey: string;
  readonly fetchImpl?: VeniceMediaFetch;
  /**
   * Explicit operator allowlist for provider-issued signed delivery hosts.
   * Signed URLs carry query signatures, so the complete URL is never logged
   * or made public. An empty allowlist rejects direct delivery URLs.
   */
  readonly signedDeliveryAllowedHosts?: readonly string[];
  readonly now?: () => Date;
  /** Server-only exact Artifact resolver. Returned data URLs are used once and never persisted. */
  readonly resolveReferenceMediaUrls?: (proof: MediaGenerationAdmissionProof) => Promise<{ images: readonly string[]; videos: readonly string[] }>;
  readonly resolveReferenceImageUrls?: (
    proof: MediaGenerationAdmissionProof,
  ) => Promise<readonly string[]>;
}

export class VeniceMediaLifecycleError extends Error {
  readonly receiptId: string;
  readonly failure: MediaGenerationFailure;

  constructor(receiptId: string, failure: MediaGenerationFailure) {
    super(failure.message);
    this.name = "VeniceMediaLifecycleError";
    this.receiptId = receiptId;
    this.failure = failure;
  }
}

function proofModelOrThrow(proof: MediaGenerationAdmissionProof): VeniceMediaModel {
  const payloadModel = proof.requestPayload.model;
  if (proof.providerModel !== payloadModel ||
      (payloadModel !== "seedance-2-5-text-to-video-basic" && payloadModel !== "seedance-2-5-reference-to-video-basic" && payloadModel !== "minimax-h3-enhanced-text-to-video" &&
        payloadModel !== "sonilo-v1-1-music" && payloadModel !== "minimax-music-v26")) {
    throw new Error("DB admission proof has an unsupported or mismatched provider model");
  }
  const model = payloadModel as VeniceMediaModel;
  if (proof.kind !== mediaGenerationKindForModel(model)) {
    throw new Error("DB admission proof kind does not match its provider model");
  }
  return model;
}

function integerSetting(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`DB admission proof is missing approved ${label}`);
  }
  return value;
}

function stringSetting(value: unknown, label: string): string {
  if (!isNonemptyString(value)) throw new Error(`DB admission proof is missing approved ${label}`);
  return value;
}

function booleanSetting(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`DB admission proof is missing approved ${label}`);
  return value;
}

/**
 * Compile the provider-private queue body from the exact DB-minted approved
 * payload. This accepts no caller-supplied creative args and deliberately is
 * not the pricing-only quote shape.
 */
export function toVeniceQueuePayload(
  proof: MediaGenerationAdmissionProof,
  referenceImageUrls?: readonly string[],
  referenceVideoUrls?: readonly string[],
): VeniceQueuePayload {
  const model = proofModelOrThrow(proof);
  const { prompt, lyrics, normalizedSettings } = proof.requestPayload;
  switch (model) {
    case "seedance-2-5-text-to-video-basic":
      return {
        model,
        prompt,
        duration: `${integerSetting(normalizedSettings.durationSeconds, "duration")}s`,
        aspect_ratio: stringSetting(normalizedSettings.aspectRatio, "aspect ratio"),
        resolution: stringSetting(normalizedSettings.resolution, "resolution"),
        audio: booleanSetting(normalizedSettings.audioEnabled, "audio setting"),
      };
    case "seedance-2-5-reference-to-video-basic":
      if ((!referenceImageUrls?.length && !referenceVideoUrls?.length) ||
          (referenceImageUrls?.length ?? 0) !== (proof.requestPayload.referenceImages?.length ?? 0) ||
          (referenceVideoUrls?.length ?? 0) !== (proof.requestPayload.referenceVideos?.length ?? 0) ||
          (referenceImageUrls?.length ?? 0) > 30 || (referenceVideoUrls?.length ?? 0) > 10 ||
          referenceImageUrls?.some((url) => !url.startsWith("data:image/")) ||
          referenceVideoUrls?.some((url) => !url.startsWith("data:video/"))) {
        throw new Error("reference media must be resolved by the server before queue submission");
      }
      return {
        model,
        prompt,
        duration: `${integerSetting(normalizedSettings.durationSeconds, "duration")}s`,
        aspect_ratio: stringSetting(normalizedSettings.aspectRatio, "aspect ratio"),
        resolution: stringSetting(normalizedSettings.resolution, "resolution"),
        audio: booleanSetting(normalizedSettings.audioEnabled, "audio setting"),
        ...(referenceImageUrls?.length ? { reference_image_urls: [...referenceImageUrls] } : {}),
        ...(referenceVideoUrls?.length ? { reference_video_urls: [...referenceVideoUrls] } : {}),
      };
    case "minimax-h3-enhanced-text-to-video":
      return {
        model,
        prompt,
        duration: `${integerSetting(normalizedSettings.durationSeconds, "duration")}s`,
        aspect_ratio: stringSetting(normalizedSettings.aspectRatio, "aspect ratio"),
        resolution: stringSetting(normalizedSettings.resolution, "resolution"),
      };
    case "sonilo-v1-1-music":
      return { model, prompt, duration_seconds: integerSetting(normalizedSettings.durationSeconds, "duration") };
    case "minimax-music-v26":
      return {
        model,
        prompt,
        ...(lyrics === undefined ? {} : { lyrics_prompt: lyrics }),
        force_instrumental: booleanSetting(normalizedSettings.instrumental, "instrumental setting"),
      };
  }
}

function queueEndpointForMedia(proof: MediaGenerationAdmissionProof): "/video/queue" | "/audio/queue" {
  return VENICE_MEDIA_QUEUE_ENDPOINTS[mediaGenerationKindForModel(proofModelOrThrow(proof))];
}

function retrieveEndpointForModel(model: VeniceMediaModel): "/video/retrieve" | "/audio/retrieve" {
  return VENICE_MEDIA_RETRIEVE_ENDPOINTS[mediaGenerationKindForModel(model)];
}

function completeEndpointForModel(model: VeniceMediaModel): "/video/complete" | "/audio/complete" {
  return VENICE_MEDIA_COMPLETE_ENDPOINTS[mediaGenerationKindForModel(model)];
}

function endpointUrl(endpoint: string): string {
  return `${VENICE_API_V1_BASE}${endpoint}`;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function safeErrorDetails(response: Response): Promise<{ code?: string; creditsRefunded?: boolean }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {};
  }
  if (!isRecord(body)) return {};
  const error = isRecord(body["error"]) ? body["error"] : body;
  const code = sanitizeVeniceProviderCode(error["code"] ?? error["type"]);
  return {
    ...(code === undefined ? {} : { code }),
    ...(typeof error["credits_refunded"] === "boolean" ? { creditsRefunded: error["credits_refunded"] } : {}),
  };
}

async function jsonBody(response: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function queueResponseOrUndefined(value: unknown, model: VeniceMediaModel): { queueId: string; signedDeliveryUrl?: string } | undefined {
  if (!isRecord(value) || value["model"] !== model || !isNonemptyString(value["queue_id"])) return undefined;
  const downloadUrl = value["download_url"];
  return {
    queueId: value["queue_id"].trim(),
    ...(downloadUrl === undefined ? {} : isNonemptyString(downloadUrl) ? { signedDeliveryUrl: downloadUrl.trim() } : {}),
  };
}

/**
 * Deterministic, capped retrieval cadence. The reconciler supplies the
 * attempt number; this helper never sleeps, queues, or declares a long job
 * terminal merely because it is still processing.
 */
export function scheduleVeniceRetrieve(input: {
  readonly now: Date;
  readonly attempt: number;
  readonly averageExecutionMs?: number;
  readonly executionDurationMs?: number;
}): VeniceRetrieveSchedule {
  if (!Number.isInteger(input.attempt) || input.attempt < 0 || input.attempt > MAX_RETRIEVE_SCHEDULE_ATTEMPT) {
    throw new Error(`retrieve attempt must be between 0 and ${MAX_RETRIEVE_SCHEDULE_ATTEMPT}`);
  }
  if (!Number.isFinite(input.now.getTime())) throw new Error("retrieve schedule requires a valid current time");
  const exponential = Math.min(RETRIEVE_MAX_DELAY_MS, RETRIEVE_BASE_DELAY_MS * 2 ** Math.min(input.attempt, 4));
  const remaining = input.averageExecutionMs === undefined || input.executionDurationMs === undefined
    ? 0
    : Math.max(0, input.averageExecutionMs - input.executionDurationMs);
  const delayMs = Math.min(RETRIEVE_MAX_DELAY_MS, Math.max(RETRIEVE_BASE_DELAY_MS, exponential, remaining));
  return Object.freeze({ delayMs, nextAttemptAt: new Date(input.now.getTime() + delayMs) });
}

function forbiddenIpLiteral(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]") return true;
  const octets = normalized.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/u.test(part))) {
    const values = octets.map(Number);
    if (values.some((value) => value > 255)) return true;
    const a = values[0] ?? -1;
    const b = values[1] ?? -1;
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
  }
  return normalized.includes(":");
}

/**
 * Signed delivery URLs are provider-private. This rejects non-HTTPS, userinfo,
 * fragments, nonstandard ports, IP literals, and hosts outside the explicit
 * operator allowlist before the download lane can fetch one.
 */
export function validateVeniceSignedDeliveryUrl(value: string, allowedHosts: readonly string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  const normalizedAllowedHosts = new Set(allowedHosts.map((candidate) => candidate.trim().toLowerCase()));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash ||
      (parsed.port !== "" && parsed.port !== "443") || forbiddenIpLiteral(host) || !normalizedAllowedHosts.has(host)) {
    return undefined;
  }
  return parsed.toString();
}

function malformedQueueFailure(): MediaGenerationFailure {
  // A 2xx response without a usable queue ID might still have admitted paid work.
  return classifyVeniceMediaFailure({ phase: "admission", transportFailure: true });
}

function unsafeDeliveryFailure(): MediaGenerationFailure {
  return classifyVeniceMediaFailure({ phase: "download", acceptedReceipt: true, unsafeDeliveryUrl: true });
}

/**
 * Private server-side Venice lifecycle adapter. It deliberately has no public
 * receipt projection, logging, DB mutation, artifact write, or tool surface.
 * The next lifecycle lane must provide the durable admission/commit proofs.
 */
export class VeniceMediaLifecycleAdapter {
  private readonly fetchImpl: VeniceMediaFetch;
  private readonly now: () => Date;
  private readonly signedDeliveryAllowedHosts: readonly string[];

  constructor(private readonly config: VeniceMediaLifecycleConfig) {
    if (!isNonemptyString(config.apiKey)) throw new Error("Venice media lifecycle requires a configured API key");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.now = config.now ?? (() => new Date());
    this.signedDeliveryAllowedHosts = config.signedDeliveryAllowedHosts ?? [];
  }

  private requestInit(body: unknown): RequestInit {
    return {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    };
  }

  /** One and only one provider-admission primitive; only the DB can mint its input proof. */
  async queueVeniceMediaGeneration(proof: MediaGenerationAdmissionProof): Promise<VeniceAcceptedMediaWork> {
    const model = proofModelOrThrow(proof);
    let referenceImageUrls: readonly string[] | undefined;
    let referenceVideoUrls: readonly string[] | undefined;
    if (model === "seedance-2-5-reference-to-video-basic") {
      try {
        if (this.config.resolveReferenceMediaUrls) {
          const resolved = await this.config.resolveReferenceMediaUrls(proof);
          referenceImageUrls = resolved.images; referenceVideoUrls = resolved.videos;
        } else { referenceImageUrls = await this.config.resolveReferenceImageUrls?.(proof); }
      } catch {
        throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({
          phase: "admission",
          status: 415,
        }));
      }
    }
    const queuePayload = toVeniceQueuePayload(proof, referenceImageUrls, referenceVideoUrls);
    let response: Response;
    try {
      response = await this.fetchImpl(endpointUrl(queueEndpointForMedia(proof)), this.requestInit(queuePayload));
    } catch {
      throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({ phase: "admission", transportFailure: true }));
    }
    if (!response.ok) {
      const details = await safeErrorDetails(response);
      throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({
        phase: "admission", status: response.status, ...details,
      }));
    }
    const accepted = queueResponseOrUndefined(await jsonBody(response), model);
    if (!accepted) throw new VeniceMediaLifecycleError(proof.receiptId, malformedQueueFailure());
    return Object.freeze({
      receiptId: proof.receiptId,
      model,
      kind: proof.kind,
      providerQueueId: accepted.queueId,
      ...(accepted.signedDeliveryUrl === undefined ? {} : { signedDeliveryUrl: accepted.signedDeliveryUrl }),
    });
  }

  /** Poll accepted work only; this method never invokes the queue endpoint. */
  async retrieve(input: { readonly accepted: VeniceAcceptedMediaWork; readonly attempt: number }): Promise<VeniceRetrieveResult> {
    const { accepted } = input;
    let response: Response;
    try {
      response = await this.fetchImpl(endpointUrl(retrieveEndpointForModel(accepted.model)), this.requestInit({
        model: accepted.model,
        queue_id: accepted.providerQueueId,
        delete_media_on_completion: false,
      }));
    } catch {
      throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({ phase: "retrieve", transportFailure: true, acceptedReceipt: true }));
    }
    if (!response.ok) {
      const details = await safeErrorDetails(response);
      throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({
        phase: "retrieve", status: response.status, acceptedReceipt: true, ...details,
      }));
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    if (contentType !== null && contentType !== "application/json") {
      if (response.body === null) throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({ phase: "retrieve", transportFailure: true, acceptedReceipt: true }));
      return Object.freeze({ state: "binary", receiptId: accepted.receiptId, contentType, body: response.body });
    }
    const body = await jsonBody(response);
    if (!isRecord(body)) throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({ phase: "retrieve", transportFailure: true, acceptedReceipt: true }));
    if (body["status"] === "PROCESSING") {
      const averageExecutionMs = safeNumber(body["average_execution_time"]);
      const executionDurationMs = safeNumber(body["execution_duration"]);
      return Object.freeze({
        state: "processing",
        receiptId: accepted.receiptId,
        ...(averageExecutionMs === undefined ? {} : { estimatedExecutionMs: averageExecutionMs }),
        ...(executionDurationMs === undefined ? {} : { executionDurationMs }),
        schedule: scheduleVeniceRetrieve({
          now: this.now(),
          attempt: input.attempt,
          ...(averageExecutionMs === undefined ? {} : { averageExecutionMs }),
          ...(executionDurationMs === undefined ? {} : { executionDurationMs }),
        }),
      });
    }
    if (body["status"] === "COMPLETED" && accepted.signedDeliveryUrl !== undefined) {
      const signedDeliveryUrl = validateVeniceSignedDeliveryUrl(accepted.signedDeliveryUrl, this.signedDeliveryAllowedHosts);
      if (signedDeliveryUrl === undefined) throw new VeniceMediaLifecycleError(accepted.receiptId, unsafeDeliveryFailure());
      return Object.freeze({ state: "signed_delivery", receiptId: accepted.receiptId, signedDeliveryUrl });
    }
    throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({ phase: "retrieve", transportFailure: true, acceptedReceipt: true }));
  }

  /** Download a validated provider-private signed delivery URL without forwarding credentials or redirects. */
  async downloadSignedDelivery(input: { readonly accepted: VeniceAcceptedMediaWork; readonly signedDeliveryUrl: string }): Promise<VeniceBinaryResult> {
    // The caller may only use the exact provider URL bound to this accepted
    // receipt; an allowlisted host is not by itself an authority to substitute
    // another object's signed URL.
    const signedDeliveryUrl = input.accepted.signedDeliveryUrl === input.signedDeliveryUrl
      ? validateVeniceSignedDeliveryUrl(input.signedDeliveryUrl, this.signedDeliveryAllowedHosts)
      : undefined;
    if (signedDeliveryUrl === undefined) throw new VeniceMediaLifecycleError(input.accepted.receiptId, unsafeDeliveryFailure());
    let response: Response;
    try {
      response = await this.fetchImpl(signedDeliveryUrl, { method: "GET", redirect: "error", credentials: "omit" });
    } catch {
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, classifyVeniceMediaFailure({ phase: "download", transportFailure: true, acceptedReceipt: true }));
    }
    if (!response.ok) {
      const details = await safeErrorDetails(response);
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, classifyVeniceMediaFailure({
        phase: "download", status: response.status, acceptedReceipt: true, ...details,
      }));
    }
    if (response.body === null) throw new VeniceMediaLifecycleError(input.accepted.receiptId, classifyVeniceMediaFailure({ phase: "download", transportFailure: true, acceptedReceipt: true }));
    return Object.freeze({
      state: "binary",
      receiptId: input.accepted.receiptId,
      contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null,
      body: response.body,
    });
  }

  /** Provider cleanup is impossible until the artifact lane proves the same receipt is durably indexed. */
  async complete(input: { readonly accepted: VeniceAcceptedMediaWork; readonly commitProof: VeniceArtifactCommitProof }): Promise<void> {
    if (input.commitProof.state !== "durably_committed" || input.commitProof.receiptId !== input.accepted.receiptId ||
        !isNonemptyString(input.commitProof.artifactInternalId) || !Number.isSafeInteger(input.commitProof.artifactRevision) || input.commitProof.artifactRevision < 0) {
      throw new Error("complete requires a durable artifact commit proof for the same receipt");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(endpointUrl(completeEndpointForModel(input.accepted.model)), this.requestInit({
        model: input.accepted.model,
        queue_id: input.accepted.providerQueueId,
      }));
    } catch {
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, classifyVeniceMediaFailure({ phase: "cleanup", transportFailure: true, acceptedReceipt: true }));
    }
    if (!response.ok) {
      // Some video models reject their own valid queue ID at /complete while
      // /retrieve still serves it. Use Venice's documented retrieve-and-delete
      // route only for that exact rejection and only after the commit gate above.
      const body = await jsonBody(response.clone());
      if (input.accepted.kind === "video" && response.status === 400 &&
          isRecord(body) && body["error"] === "Request ID is invalid.") {
        return this.completeVideoViaRetrieve(input.accepted);
      }
      const details = await safeErrorDetails(response);
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, classifyVeniceMediaFailure({
        phase: "cleanup", status: response.status, acceptedReceipt: true, ...details,
      }));
    }
    const body = await jsonBody(response);
    if (!isRecord(body) || body["success"] !== true) {
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, classifyVeniceMediaFailure({ phase: "cleanup", transportFailure: true, acceptedReceipt: true }));
    }
  }

  private async completeVideoViaRetrieve(accepted: VeniceAcceptedMediaWork): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(endpointUrl(VENICE_MEDIA_RETRIEVE_ENDPOINTS.video), this.requestInit({
        model: accepted.model, queue_id: accepted.providerQueueId, delete_media_on_completion: true,
      }));
    } catch {
      throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({ phase: "cleanup", transportFailure: true, acceptedReceipt: true }));
    }
    if (!response.ok) {
      const body = await jsonBody(response.clone());
      // A resumed cleanup can observe absence after deletion succeeded but the
      // response or local cleanup CAS was lost. Reject generic route/HTML 404s.
      if (response.status === 404 && isRecord(body) &&
          (body["code"] === "media_not_found" ||
           (typeof body["error"] === "string" && /^The .+ is not found\. Request id: \S+$/u.test(body["error"])))) return;
      const details = await safeErrorDetails(response);
      throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({
        phase: "cleanup", status: response.status, acceptedReceipt: true, ...details,
      }));
    }
    const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mime !== "video/mp4" || response.body === null) {
      await response.body?.cancel();
      throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({ phase: "cleanup", transportFailure: true, acceptedReceipt: true }));
    }
    // Finish the transfer so delete-on-completion can run. Discard chunks: the
    // authoritative copy already exists locally, and this is not a new take.
    const reader = response.body.getReader();
    let receivedBytes = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error("invalid cleanup response chunk");
        receivedBytes ||= value.byteLength > 0;
      }
      if (!receivedBytes) throw new Error("empty cleanup response");
    } catch {
      throw new VeniceMediaLifecycleError(accepted.receiptId, classifyVeniceMediaFailure({ phase: "cleanup", transportFailure: true, acceptedReceipt: true }));
    } finally {
      reader.releaseLock();
    }
  }
}
