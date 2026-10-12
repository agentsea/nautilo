import type { MediaGenerationAdmissionProof } from "@nautilo/db";
import type { MediaGenerationFailure } from "./errors";
import {
  VeniceMediaLifecycleError,
  scheduleVeniceRetrieve,
  type VeniceAcceptedMediaWork,
  type VeniceArtifactCommitProof,
  type VeniceBinaryResult,
  type VeniceMediaFetch,
  type VeniceRetrieveResult,
} from "./venice-lifecycle";

const SURPLUS_API_BASE = "https://api.surplusintelligence.ai";

export const SURPLUS_MEDIA_ROUTES = Object.freeze({
  "seedance-2-5-text-to-video-basic": "venice-seedance-2-5-text-to-video-basic",
  "minimax-h3-enhanced-text-to-video": "venice-minimax-h3-enhanced-text-to-video",
  "minimax-music-v26": "venice-minimax-music-v26",
} as const);

export type SurplusEligibleMediaModel = keyof typeof SURPLUS_MEDIA_ROUTES;

/** Exact qualified mapping only. Missing means the operation must stay direct. */
export function resolveSurplusMediaRoute(modelId: string): string | null {
  return Object.prototype.hasOwnProperty.call(SURPLUS_MEDIA_ROUTES, modelId)
    ? SURPLUS_MEDIA_ROUTES[modelId as SurplusEligibleMediaModel]
    : null;
}

const SURPLUS_MEDIA_FACTS = Object.freeze({
  "seedance-2-5-text-to-video-basic": { kind: "video", outputMime: "video/mp4" },
  "minimax-h3-enhanced-text-to-video": { kind: "video", outputMime: "video/mp4" },
  "minimax-music-v26": { kind: "music", outputMime: "audio/mpeg" },
} as const);

function routeFacts(modelId: string) {
  return Object.prototype.hasOwnProperty.call(SURPLUS_MEDIA_FACTS, modelId)
    ? SURPLUS_MEDIA_FACTS[modelId as SurplusEligibleMediaModel]
    : undefined;
}

function integerSetting(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`approved ${label} is incomplete`);
  }
  return value;
}

function stringSetting(value: unknown, label: string): string {
  if (!nonempty(value)) throw new Error(`approved ${label} is incomplete`);
  return value;
}

function booleanSetting(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`approved ${label} is incomplete`);
  return value;
}

function queuePayload(proof: MediaGenerationAdmissionProof, route: string): Record<string, unknown> {
  const settings = proof.requestPayload.normalizedSettings;
  switch (proof.providerModel) {
    case "seedance-2-5-text-to-video-basic":
      return {
        model: route,
        prompt: proof.requestPayload.prompt,
        duration: `${integerSetting(settings.durationSeconds, "video duration")}s`,
        aspect_ratio: stringSetting(settings.aspectRatio, "video aspect ratio"),
        resolution: stringSetting(settings.resolution, "video resolution"),
        audio: booleanSetting(settings.audioEnabled, "video audio setting"),
      };
    case "minimax-h3-enhanced-text-to-video":
      return {
        model: route,
        prompt: proof.requestPayload.prompt,
        duration: `${integerSetting(settings.durationSeconds, "video duration")}s`,
        aspect_ratio: stringSetting(settings.aspectRatio, "video aspect ratio"),
        resolution: stringSetting(settings.resolution, "video resolution"),
      };
    case "minimax-music-v26":
      return {
        model: route,
        prompt: proof.requestPayload.prompt,
        ...(proof.requestPayload.lyrics === undefined ? {} : { lyrics_prompt: proof.requestPayload.lyrics }),
        force_instrumental: booleanSetting(settings.instrumental, "music instrumental setting"),
      };
    default:
      throw new Error("approved marketplace media model is unsupported");
  }
}

function generationEndpoint(kind: "video" | "music", queueId?: string): string {
  const base = `${SURPLUS_API_BASE}/v1/${kind}/generations`;
  return queueId === undefined ? base : `${base}/${encodeURIComponent(queueId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function failure(input: Partial<MediaGenerationFailure> & Pick<MediaGenerationFailure, "code" | "phase">): MediaGenerationFailure {
  return Object.freeze({
    code: input.code,
    phase: input.phase,
    retrySafe: input.retrySafe ?? false,
    stateChanged: input.stateChanged ?? input.phase !== "admission",
    completionCertainty: input.completionCertainty ?? (input.phase === "admission" ? "not_started" : "accepted"),
    chargeCertainty: input.chargeCertainty ?? (input.phase === "admission" ? "not_charged" : "unknown"),
    ...(input.creditsRefunded === undefined ? {} : { creditsRefunded: input.creditsRefunded }),
    recoveryActions: input.recoveryActions ?? (["contact_support"] as const),
    message: input.message ?? "The marketplace media request could not continue.",
  });
}

function statusFailure(receiptId: string, status: number, phase: "admission" | "retrieve" | "download") {
  if (status === 401 || status === 403) {
    return new VeniceMediaLifecycleError(receiptId, failure({
      code: "SURPLUS_AUTHENTICATION",
      phase,
      retrySafe: true,
      stateChanged: phase !== "admission",
      completionCertainty: phase === "admission" ? "not_started" : "accepted",
      chargeCertainty: phase === "admission" ? "not_charged" : "unknown",
      recoveryActions: ["repair_credentials"],
      message: "The creating marketplace account is unavailable.",
    }));
  }
  if (status === 400 || status === 404 || status === 422) {
    return new VeniceMediaLifecycleError(receiptId, failure({
      code: phase === "admission" ? "SURPLUS_INVALID_REQUEST" : "SURPLUS_RESULT_EXPIRED",
      phase,
      retrySafe: false,
      stateChanged: phase !== "admission",
      completionCertainty: phase === "admission" ? "not_started" : "accepted",
      chargeCertainty: phase === "admission" ? "not_charged" : "unknown",
      recoveryActions: phase === "admission" ? ["revise_request"] : ["contact_support"],
      message: phase === "admission"
        ? "The marketplace rejected this media request before starting it."
        : "The marketplace result expired before Nautilo could capture it.",
    }));
  }
  return new VeniceMediaLifecycleError(receiptId, failure({
    code: status === 429 ? "SURPLUS_RATE_LIMITED" : "SURPLUS_UNAVAILABLE",
    phase,
    retrySafe: status === 429 || status >= 500,
    stateChanged: phase !== "admission",
    completionCertainty: phase === "admission" && status >= 500 ? "unknown" : phase === "admission" ? "not_started" : "accepted",
    chargeCertainty: phase === "admission" ? (status >= 500 ? "unknown" : "not_charged") : "unknown",
    recoveryActions: status === 429 || status >= 500 ? ["wait"] : ["contact_support"],
    message: "The marketplace media service is temporarily unavailable.",
  }));
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

function exactMicros(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{1,16}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function validateArtifactUrl(value: string, jobId: string, allowedHosts: readonly string[]): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  const allowed = new Set(["api.surplusintelligence.ai", ...allowedHosts.map((item) => item.trim().toLowerCase())]);
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443") || !allowed.has(host)) return undefined;
  if (host === "api.surplusintelligence.ai" &&
      !url.pathname.startsWith(`/v1/media/artifacts/${encodeURIComponent(jobId)}/`)) return undefined;
  return url.toString();
}

export interface SurplusMediaLifecycleConfig {
  readonly apiKey: string;
  readonly fetchImpl?: VeniceMediaFetch;
  readonly signedDeliveryAllowedHosts?: readonly string[];
  readonly now?: () => Date;
}

/** Async Surplus lifecycle for exact qualified generated-media routes. */
export class SurplusMediaLifecycleAdapter {
  private readonly fetchImpl: VeniceMediaFetch;
  private readonly now: () => Date;
  private readonly allowedHosts: readonly string[];

  constructor(private readonly config: SurplusMediaLifecycleConfig) {
    if (!config.apiKey.trim()) throw new Error("Surplus media lifecycle requires a configured API key");
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.now = config.now ?? (() => new Date());
    this.allowedHosts = config.signedDeliveryAllowedHosts ?? [];
  }

  private authHeaders(content = false): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(content ? { "Content-Type": "application/json" } : {}),
    };
  }

  async queueVeniceMediaGeneration(proof: MediaGenerationAdmissionProof): Promise<VeniceAcceptedMediaWork> {
    const route = resolveSurplusMediaRoute(proof.providerModel);
    const facts = routeFacts(proof.providerModel);
    if (proof.provider !== "surplus" || proof.fundingBinding.provider !== "surplus" ||
        proof.providerAccountFingerprint !== proof.fundingBinding.credentialFingerprint ||
        route === null || facts === undefined || facts.kind !== proof.kind ||
        proof.requestPayload.model !== proof.providerModel) {
      throw new VeniceMediaLifecycleError(proof.receiptId, failure({
        code: "SURPLUS_MEDIA_ROUTE_UNSUPPORTED", phase: "admission",
        recoveryActions: ["switch_model"],
        message: "This exact media model is not qualified for marketplace generation.",
      }));
    }
    const payload = queuePayload(proof, route);
    let response: Response;
    try {
      response = await this.fetchImpl(generationEndpoint(facts.kind), {
        method: "POST",
        redirect: "error",
        headers: { ...this.authHeaders(true), "Idempotency-Key": proof.receiptId },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new VeniceMediaLifecycleError(proof.receiptId, failure({
        code: "SURPLUS_ADMISSION_UNKNOWN", phase: "admission", retrySafe: false,
        completionCertainty: "unknown", chargeCertainty: "unknown", recoveryActions: ["wait"],
        message: "Marketplace admission may have started. Check this receipt before requesting another generation.",
      }));
    }
    if (!response.ok) throw statusFailure(proof.receiptId, response.status, "admission");
    const body = await json(response);
    if (!isRecord(body) || !nonempty(body["id"]) || body["kind"] !== facts.kind ||
        !["queued", "submitted", "processing", "running"].includes(String(body["status"]))) {
      throw new VeniceMediaLifecycleError(proof.receiptId, failure({
        code: "SURPLUS_ADMISSION_UNKNOWN", phase: "admission", retrySafe: false,
        completionCertainty: "unknown", chargeCertainty: "unknown", recoveryActions: ["wait"],
        message: "Marketplace admission returned an uncertain receipt. Check status before trying again.",
      }));
    }
    return Object.freeze({
      receiptId: proof.receiptId,
      model: proof.providerModel as VeniceAcceptedMediaWork["model"],
      kind: proof.kind,
      providerQueueId: body["id"].trim(),
    });
  }

  async retrieve(input: { readonly accepted: VeniceAcceptedMediaWork; readonly attempt: number }): Promise<VeniceRetrieveResult> {
    const facts = routeFacts(input.accepted.model);
    if (!facts || facts.kind !== input.accepted.kind) {
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
        code: "SURPLUS_MEDIA_ROUTE_UNSUPPORTED", phase: "retrieve", retrySafe: false,
        recoveryActions: ["contact_support"],
        message: "The marketplace receipt no longer matches a supported media route.",
      }));
    }
    let response: Response;
    try {
      response = await this.fetchImpl(
        generationEndpoint(facts.kind, input.accepted.providerQueueId),
        { method: "GET", redirect: "error", headers: this.authHeaders() },
      );
    } catch {
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
        code: "SURPLUS_RETRIEVE_RETRY", phase: "retrieve", retrySafe: true,
        recoveryActions: ["retry_retrieval"], message: "Marketplace status is temporarily unavailable.",
      }));
    }
    if (!response.ok) throw statusFailure(input.accepted.receiptId, response.status, "retrieve");
    const body = await json(response);
    if (!isRecord(body) || body["id"] !== input.accepted.providerQueueId || body["kind"] !== facts.kind) {
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
        code: "SURPLUS_STATUS_INVALID", phase: "retrieve", retrySafe: true,
        recoveryActions: ["retry_retrieval"], message: "Marketplace status could not be verified.",
      }));
    }
    if (body["status"] === "queued" || body["status"] === "submitted" || body["status"] === "processing" || body["status"] === "running") {
      return Object.freeze({
        state: "processing", receiptId: input.accepted.receiptId,
        schedule: scheduleVeniceRetrieve({ now: this.now(), attempt: input.attempt }),
      });
    }
    const usage = isRecord(body["usage"]) ? body["usage"] : undefined;
    const actualCostUsdMicros = usage?.["settlement_status"] === "captured" || usage?.["settlement_status"] === "confirmed"
      ? exactMicros(usage["buyer_cost_usdc"])
      : undefined;
    if (body["status"] === "failed" || body["status"] === "cancelled" || body["status"] === "canceled" || body["status"] === "expired") {
      const error = new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
        code: body["status"] === "cancelled" || body["status"] === "canceled" ? "SURPLUS_CANCELLED" : body["status"] === "expired" ? "SURPLUS_RESULT_EXPIRED" : "SURPLUS_GENERATION_FAILED",
        phase: "retrieve", retrySafe: false, chargeCertainty: actualCostUsdMicros === undefined ? "unknown" : "charged_or_committed",
        recoveryActions: body["status"] === "expired" ? ["contact_support"] : ["revise_request", "start_new_generation"],
        message: body["status"] === "cancelled" || body["status"] === "canceled" ? "The marketplace generation was cancelled." :
          body["status"] === "expired" ? "The marketplace result expired before it could be captured." : "The marketplace generation failed.",
      }));
      Object.assign(error, { actualCostUsdMicros });
      throw error;
    }
    const results = Array.isArray(body["results"]) ? body["results"] : [];
    const result = results.length === 1 && isRecord(results[0]) ? results[0] : undefined;
    if (body["status"] !== "succeeded" || !result || result["content_type"] !== facts.outputMime || !nonempty(result["url"])) {
      throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
        code: "SURPLUS_STATUS_INVALID", phase: "retrieve", retrySafe: true,
        recoveryActions: ["retry_retrieval"], message: "Marketplace completion could not be verified.",
      }));
    }
    const signedDeliveryUrl = validateArtifactUrl(result["url"], input.accepted.providerQueueId, this.allowedHosts);
    if (!signedDeliveryUrl) throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
      code: "SURPLUS_DELIVERY_UNSAFE", phase: "download", retrySafe: false,
      recoveryActions: ["contact_support"], message: "The marketplace returned an unsafe result location.",
    }));
    return Object.freeze({
      state: "signed_delivery", receiptId: input.accepted.receiptId, signedDeliveryUrl,
      ...(actualCostUsdMicros === undefined ? {} : { actualCostUsdMicros }),
    });
  }

  async downloadSignedDelivery(input: { readonly accepted: VeniceAcceptedMediaWork; readonly signedDeliveryUrl: string }): Promise<VeniceBinaryResult> {
    let current = validateArtifactUrl(input.signedDeliveryUrl, input.accepted.providerQueueId, this.allowedHosts);
    if (!current) throw statusFailure(input.accepted.receiptId, 400, "download");
    for (let hop = 0; hop < 4; hop += 1) {
      const url = new URL(current);
      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          method: "GET", redirect: "manual", credentials: "omit",
          headers: url.hostname === "api.surplusintelligence.ai" ? this.authHeaders() : {},
        });
      } catch {
        throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
          code: "SURPLUS_DOWNLOAD_RETRY", phase: "download", retrySafe: true,
          recoveryActions: ["retry_download"], message: "The marketplace result download was interrupted.",
        }));
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        current = location ? validateArtifactUrl(new URL(location, current).toString(), input.accepted.providerQueueId, this.allowedHosts) : undefined;
        if (!current) throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
          code: "SURPLUS_DELIVERY_UNSAFE", phase: "download", recoveryActions: ["contact_support"],
          message: "The marketplace result redirect was unsafe.",
        }));
        continue;
      }
      if (!response.ok) throw statusFailure(input.accepted.receiptId, response.status, "download");
      if (!response.body) throw statusFailure(input.accepted.receiptId, 503, "download");
      return Object.freeze({
        state: "binary", receiptId: input.accepted.receiptId,
        contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null,
        body: response.body,
      });
    }
    throw new VeniceMediaLifecycleError(input.accepted.receiptId, failure({
      code: "SURPLUS_DELIVERY_UNSAFE", phase: "download", recoveryActions: ["contact_support"],
      message: "The marketplace result used too many redirects.",
    }));
  }

  complete(input: { readonly accepted: VeniceAcceptedMediaWork; readonly commitProof: VeniceArtifactCommitProof }): Promise<void> {
    if (input.commitProof.state !== "durably_committed" || input.commitProof.receiptId !== input.accepted.receiptId) {
      throw new Error("complete requires a durable artifact commit proof for the same receipt");
    }
    // Surplus artifacts expire automatically. Local publication is the cleanup boundary.
    return Promise.resolve();
  }
}
