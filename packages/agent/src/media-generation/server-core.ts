/**
 * D525 paid media-generation composition core.
 *
 * This module is deliberately injectable and server-only. It binds one exact
 * quote to one durable local receipt, then lets only a DB-minted admission
 * proof reach the Venice queue adapter. Provider topology never crosses the
 * public result boundary.
 */
import { createHash } from "node:crypto";
import type {
  CreateMediaGenerationInput,
  MediaGenerationAdmissionProof,
  MediaGenerationAdmissionRefusal,
  MediaGenerationRequestPayload,
  MediaGenerationSafeFailure,
  MediaGenerationSafeSnapshot,
  MediaGenerationScope,
  MediaGenerationState,
} from "@nautilo/db";
import type { MediaGenerationPreparedApproval } from "@nautilo/types";
import {
  createUnboundMediaGenerationFailure,
  createMediaGenerationPreparedApproval,
  verifyMediaGenerationPreparedApproval,
  type MediaGenerationApprovalActorContext,
  type MediaGenerationApprovalRuntime,
  type MediaGenerationPreparationInput,
  type MediaGenerationPreparationResult,
  type MediaGenerationSafeResult,
  type MediaGenerationSubmitInput,
} from "../tools/media/media-generation-approval-runtime";
import {
  MediaGenerationValidationError,
  mediaGenerationKindForModel,
  normalizeMediaGenerationRequest as normalizeResolvedRequest,
  quoteEndpointFor,
  toVeniceQuotePricingRequest,
  type NormalizedMediaGenerationRequest,
  type VeniceQuotePricingRequest,
} from "./contracts";
import { VeniceQuoteLifecycleError } from "./quote";
import {
  classifyVeniceMediaFailure,
  type MediaGenerationFailure,
  type MediaGenerationRecoveryAction,
} from "./errors";
import {
  VeniceMediaLifecycleError,
  type VeniceAcceptedMediaWork,
} from "./venice-lifecycle";
import { assertCanUseServerProviderCredentials } from "@nautilo/trust";

const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1_000;
const MAX_PREPARATIONS = 256;

export interface MediaGenerationCoreReceipt {
  readonly receiptId: string;
  readonly ownerId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly initiatingAgentId: string | null;
  readonly initiatingThreadId: string | null;
  readonly state: MediaGenerationState;
  readonly revision: number;
  readonly approvalDigest: string;
  readonly quoteDigest: string;
  readonly providerAccountFingerprint: string;
  readonly requestPayload: MediaGenerationRequestPayload;
  readonly quotedUsdMicros: number;
  readonly safeFailure: MediaGenerationSafeFailure | null;
}

/**
 * Production implementations must use the D525 DB repository. In particular,
 * `recordRefused` must be an exact proof-bound CAS out of `admitting`; a known
 * provider refusal must never be written through the admission-unknown path.
 */
export interface MediaGenerationCoreRepository {
  find(scope: MediaGenerationScope, receiptId: string): Promise<MediaGenerationCoreReceipt | null>;
  reserve(input: CreateMediaGenerationInput): Promise<MediaGenerationCoreReceipt>;
  beginAdmission(
    scope: MediaGenerationScope,
    receiptId: string,
    expectedRevision: number,
  ): Promise<MediaGenerationAdmissionProof | null>;
  recordAccepted(
    proof: MediaGenerationAdmissionProof,
    providerQueueId: string,
  ): Promise<MediaGenerationCoreReceipt | null>;
  recordUnknown(
    proof: MediaGenerationAdmissionProof,
    failure: MediaGenerationSafeFailure,
  ): Promise<MediaGenerationCoreReceipt | null>;
  recordRefused(
    proof: MediaGenerationAdmissionProof,
    refusal: MediaGenerationAdmissionRefusal,
  ): Promise<MediaGenerationCoreReceipt | null>;
}

export interface ExactMediaGenerationQuotePort {
  quote(input: Readonly<{
    endpoint: "/video/quote" | "/audio/quote";
    pricingRequest: VeniceQuotePricingRequest;
  }>): Promise<Readonly<{ amountUsdMicros: number }>>;
}

export interface VeniceMediaAdmissionPort {
  queueVeniceMediaGeneration(
    proof: MediaGenerationAdmissionProof,
    actor: MediaGenerationApprovalActorContext,
  ): Promise<VeniceAcceptedMediaWork>;
}

export interface MediaGenerationServerCoreDependencies {
  readonly repository: MediaGenerationCoreRepository;
  readonly quotes: ExactMediaGenerationQuotePort;
  readonly venice: VeniceMediaAdmissionPort;
  readonly resolveScope: (
    actor: MediaGenerationApprovalActorContext,
  ) => Promise<MediaGenerationScope>;
  /** Resolve model-authored Workspace paths to immutable, scope-bound media facts before quote/approval. */
  readonly resolveRequest?: (
    scope: MediaGenerationScope,
    request: MediaGenerationPreparationInput["request"],
    actor: MediaGenerationApprovalActorContext,
  ) => Promise<NormalizedMediaGenerationRequest>;
  /** One-way account discriminator, never the Venice key. */
  readonly providerAccountFingerprint: string;
  readonly now?: () => Date;
  readonly approvalTtlMs?: number;
  readonly assertCanUseServerProviderCredentials?: typeof assertCanUseServerProviderCredentials;
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

function stableReceiptId(
  actor: MediaGenerationApprovalActorContext,
  input: MediaGenerationPreparationInput,
): string {
  return `mg_${digest({
    userId: actor.userId,
    roomId: actor.roomId,
    origin: "origin" in input
      ? input.origin
      : {
          kind: "genie_tool",
          threadId: input.threadId,
          turnId: input.turnId,
          laneKey: input.laneKey,
          toolCallId: input.toolCallId,
          toolName: input.toolName,
        },
    approvalId: input.approvalId,
  })}`;
}

function normalizedSettings(
  request: NormalizedMediaGenerationRequest,
): MediaGenerationRequestPayload["normalizedSettings"] {
  switch (request.model) {
    case "seedance-2-5-text-to-video-basic":
      return {
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        audioEnabled: request.audio,
      };
    case "seedance-2-5-reference-to-video-basic":
      return {
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
        audioEnabled: request.audio,
      };
    case "minimax-h3-enhanced-text-to-video":
      return {
        durationSeconds: request.durationSeconds,
        resolution: request.resolution,
        aspectRatio: request.aspectRatio,
      };
    case "sonilo-v1-1-music":
      return { durationSeconds: request.durationSeconds };
    case "minimax-music-v26":
      return { instrumental: request.forceInstrumental };
  }
}

function requestPayload(request: NormalizedMediaGenerationRequest): MediaGenerationRequestPayload {
  return {
    version: 1,
    model: request.model,
    prompt: request.prompt,
    ...("lyrics" in request && request.lyrics !== undefined ? { lyrics: request.lyrics } : {}),
    ...(request.model === "seedance-2-5-reference-to-video-basic"
      ? {
          referenceImages: request.referenceImages,
          ...(request.referenceVideos?.length ? { referenceVideos: request.referenceVideos } : {}),
          ...(request.referenceAudios?.length ? { referenceAudios: request.referenceAudios } : {}),
        }
      : {}),
    normalizedSettings: normalizedSettings(request),
  };
}

function safeSnapshot(request: NormalizedMediaGenerationRequest): MediaGenerationSafeSnapshot {
  return {
    version: 1,
    normalizedSettings: normalizedSettings(request),
    inputSummary: {
      promptCharacters: request.prompt.length,
      ...("lyrics" in request && request.lyrics !== undefined
        ? { lyricsCharacters: request.lyrics.length }
        : {}),
      ...(request.model === "seedance-2-5-reference-to-video-basic"
        ? (request.referenceImages.length ? { referenceImageCount: request.referenceImages.length } : {})
        : {}),
    },
  };
}

function exactReceiptMatchesPrepared(
  receipt: MediaGenerationCoreReceipt,
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
  providerAccountFingerprint: string,
  actor: MediaGenerationApprovalActorContext,
): boolean {
  const origin = prepared.binding.origin;
  const expectedAgentId = origin.kind === "genie_tool" ? actor.agentId : null;
  const expectedThreadId = origin.kind === "genie_tool" ? origin.threadId : null;
  return receipt.receiptId === prepared.binding.receiptId &&
    receipt.initiatingAgentId === expectedAgentId &&
    receipt.initiatingThreadId === expectedThreadId &&
    receipt.approvalDigest === prepared.binding.approvalDigest &&
    receipt.quoteDigest === prepared.binding.quoteDigest &&
    receipt.providerAccountFingerprint === providerAccountFingerprint &&
    receipt.quotedUsdMicros === prepared.quoteUsdMicros &&
    canonical(receipt.requestPayload) === canonical(requestPayload(prepared.request));
}

function assertScope(
  actor: MediaGenerationApprovalActorContext,
  scope: MediaGenerationScope,
): void {
  if (scope.ownerId !== actor.userId || scope.roomId !== actor.roomId || actor.agentId.trim() === "" || scope.namespaceId.trim() === "") {
    throw new Error("media generation scope does not match the authenticated actor");
  }
}

function recoveryAction(
  action: MediaGenerationRecoveryAction,
): MediaGenerationSafeFailure["recoveryActions"][number] {
  switch (action) {
    case "revise_request": return "revise";
    case "switch_model": return "switch_model";
    case "retry_admission":
    case "retry_retrieval":
    case "retry_download":
    case "retry_persistence":
    case "retry_cleanup":
    case "wait": return "retry_same_receipt";
    case "start_new_generation": return "start_fresh";
    case "refresh_catalog": return "revise";
    case "repair_credentials":
    case "repair_billing":
    case "review_access":
    case "provider_consent":
    case "contact_support": return "repair_account";
  }
}

function dbSafeFailure(failure: MediaGenerationFailure): MediaGenerationSafeFailure {
  const recoveryActions: MediaGenerationSafeFailure["recoveryActions"] =
    failure.code === "VENICE_RATE_LIMITED" || failure.code === "VENICE_CAPACITY"
      ? ["start_fresh"]
      : [...new Set(failure.recoveryActions.map(recoveryAction))];
  return {
    code: failure.code,
    phase: "queue",
    retrySafe: failure.retrySafe,
    stateChanged: failure.stateChanged,
    completionCertainty: failure.completionCertainty === "accepted"
      ? "accepted"
      : failure.completionCertainty === "unknown"
        ? "unknown"
        : "not_started",
    chargeCertainty: failure.chargeCertainty === "charged_or_committed"
      ? "charged"
      : failure.chargeCertainty,
    recoveryActions,
    ...(failure.creditsRefunded === undefined
      ? {}
      : { creditsRefunded: failure.creditsRefunded }),
  };
}

function mediaKind(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
): "video" | "audio" {
  return prepared.preview.mediaKind === "video" ? "video" : "audio";
}

function boundFailureResult(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
  input: {
    readonly queueStarted: false | null;
    readonly state: "needs-action" | "failed" | "unknown";
    readonly code: string;
    readonly message: string;
    readonly creditsRefunded?: boolean;
  },
): MediaGenerationSafeResult {
  return {
    kind: "generated_media",
    version: 1,
    receiptId: prepared.binding.receiptId,
    queueStarted: input.queueStarted,
    mediaKind: mediaKind(prepared),
    state: input.state,
    model: prepared.preview.model,
    promptSummary: prepared.preview.prompt.summary,
    settings: prepared.preview.settings,
    failure: {
      code: input.code,
      message: input.message,
      ...(input.creditsRefunded === undefined
        ? {}
        : { creditsRefunded: input.creditsRefunded }),
    },
    recoveryActions: [],
  };
}

function unavailableResult(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
): MediaGenerationSafeResult {
  return boundFailureResult(prepared, {
    queueStarted: null,
    state: "unknown",
    code: "VENICE_ADMISSION_RECONCILIATION_REQUIRED",
    message: "Check this generation's status before requesting another paid generation.",
  });
}

function notStartedUnavailableResult(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
): MediaGenerationSafeResult {
  return boundFailureResult(prepared, {
    queueStarted: false,
    state: "failed",
    code: "MEDIA_ADMISSION_UNAVAILABLE",
    message: "No generation was started. Check the provider connection before trying again.",
  });
}

function refusedResult(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
  failure: Pick<MediaGenerationSafeFailure, "code" | "creditsRefunded"> & { readonly message?: string },
  state: "failed" | "needs-action",
): MediaGenerationSafeResult {
  return boundFailureResult(prepared, {
    queueStarted: false,
    state,
    code: failure.code,
    message: failure.message ?? (state === "needs-action"
      ? "Venice requires an account action before this generation can continue."
      : "Venice refused this generation. Revise it before trying again."),
    ...(failure.creditsRefunded === undefined
      ? {}
      : { creditsRefunded: failure.creditsRefunded }),
  });
}

function deterministicRefusal(
  failure: MediaGenerationFailure,
  safeFailure: MediaGenerationSafeFailure,
): MediaGenerationAdmissionRefusal | null {
  if (failure.completionCertainty !== "not_started" || failure.stateChanged) return null;
  if (failure.code === "VENICE_CONTENT_POLICY" ||
      failure.code === "VENICE_INVALID_REQUEST" ||
      failure.code === "VENICE_PAYLOAD_TOO_LARGE" ||
      failure.code === "VENICE_UNSUPPORTED_MEDIA" ||
      failure.code === "VENICE_RATE_LIMITED" ||
      failure.code === "VENICE_CAPACITY") {
    return { state: "failed", safeFailure };
  }
  if (failure.code === "VENICE_NEEDS_CONSENT" ||
      failure.code === "VENICE_AUTHENTICATION" ||
      failure.code === "VENICE_BILLING" ||
      failure.code === "VENICE_ACCESS") {
    return { state: "needs_action", safeFailure };
  }
  return null;
}

function providerFailureMessage(failure: MediaGenerationFailure): string {
  if (failure.code === "VENICE_RATE_LIMITED" || failure.code === "VENICE_CAPACITY") {
    return "Venice is busy. Wait, then request a fresh quote and approve a new generation.";
  }
  return failure.message;
}

function refusalWriteFailedResult(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
): MediaGenerationSafeResult {
  return boundFailureResult(prepared, {
    queueStarted: false,
    state: "failed",
    code: "MEDIA_DURABLE_REFUSAL_WRITE_FAILED",
    message: "No generation was started, but Nautilo could not durably record the refusal. Check status before requesting a fresh quote.",
  });
}

function queuedResult(
  prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>,
): MediaGenerationSafeResult {
  return {
    kind: "generated_media",
    version: 1,
    receiptId: prepared.binding.receiptId,
    queueStarted: true,
    mediaKind: mediaKind(prepared),
    state: "queued",
    model: prepared.request.model,
    promptSummary: prepared.preview.prompt.summary,
    settings: prepared.preview.settings,
    recoveryActions: [],
  };
}

function isAcceptedState(state: MediaGenerationState): boolean {
  return state === "queued" || state === "retrieving" || state === "saving" || state === "ready";
}

/**
 * Creates the approval runtime registered by the server. Preparation is
 * memoized before quote I/O, and submission always re-reads the durable row
 * before attempting admission, so graph replay cannot spend twice. Preparation
 * replay is process-local by design: after a restart the checkpointed prepared
 * approval is authoritative; if that checkpoint was not committed, the same
 * deterministic receipt fails closed and the caller must request a fresh
 * approval. No paid admission has occurred at that point.
 */
export function createMediaGenerationServerCore(
  dependencies: MediaGenerationServerCoreDependencies,
): MediaGenerationApprovalRuntime {
  const now = dependencies.now ?? (() => new Date());
  const approvalTtlMs = dependencies.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const assertServerFunding = dependencies.assertCanUseServerProviderCredentials
    ?? assertCanUseServerProviderCredentials;
  if (!Number.isSafeInteger(approvalTtlMs) || approvalTtlMs <= 0) {
    throw new Error("media generation approval TTL must be a positive safe integer");
  }
  if (!/^[a-f0-9]{16,128}$/u.test(dependencies.providerAccountFingerprint)) {
    throw new Error("media generation provider account fingerprint is invalid");
  }

  const preparations = new Map<string, {
    readonly intentDigest: string;
    readonly promise: Promise<MediaGenerationPreparationResult>;
  }>();

  async function prepareOnce(
    actor: MediaGenerationApprovalActorContext,
    input: MediaGenerationPreparationInput,
  ): Promise<MediaGenerationPreparationResult> {
    let scope: MediaGenerationScope;
    try {
      scope = await dependencies.resolveScope(actor);
      assertScope(actor, scope);
    } catch {
      return {
        ok: false,
        code: "target_unavailable",
        recovery: "The target Room is unavailable. No generation was started.",
      };
    }

    const receiptId = stableReceiptId(actor, input);
    let request: NormalizedMediaGenerationRequest;
    try {
      request = dependencies.resolveRequest
        ? await dependencies.resolveRequest(scope, input.request, actor)
        : normalizeResolvedRequest(input.request);
    } catch (error) {
      return {
        ok: false,
        code: "request_invalid",
        recovery: error instanceof MediaGenerationValidationError
          ? `${error.message} No generation was started.`
          : "One or more reference images are unavailable or incompatible. Re-select them and try again; no generation was started.",
      };
    }
    let amountUsdMicros: number;
    await assertServerFunding(actor.userId, "media_generation_quote");
    try {
      const quote = await dependencies.quotes.quote({
        endpoint: quoteEndpointFor(request),
        pricingRequest: toVeniceQuotePricingRequest(request),
      });
      amountUsdMicros = quote.amountUsdMicros;
      if (!Number.isSafeInteger(amountUsdMicros) || amountUsdMicros < 0) {
        throw new Error("invalid exact media quote");
      }
    } catch (error) {
      if (error instanceof VeniceQuoteLifecycleError) {
        const quoteTemporarilyUnavailable = error.failure.code === "VENICE_QUOTE_UNAVAILABLE" ||
          error.failure.code === "VENICE_RATE_LIMITED" ||
          error.failure.code === "VENICE_QUOTE_INVALID_RESPONSE";
        return {
          ok: false,
          code: quoteTemporarilyUnavailable ? "quote_unavailable" : "quote_rejected",
          recovery: error.failure.message,
        };
      }
      return {
        ok: false,
        code: "quote_unavailable",
        recovery: "The exact quote is unavailable. Try again later; no generation was started.",
      };
    }

    let prepared: MediaGenerationPreparedApproval<NormalizedMediaGenerationRequest>;
    try {
      prepared = createMediaGenerationPreparedApproval({
        actor,
        preparation: { ...input, request },
        receiptId,
        quoteUsdMicros: amountUsdMicros,
        expiresAt: new Date(now().getTime() + approvalTtlMs).toISOString(),
      });
    } catch {
      return {
        ok: false,
        code: "quote_binding_failed",
        recovery: "The exact quote could not be bound safely. No generation was started.",
      };
    }
    const origin = prepared.binding.origin;
    const reservation: CreateMediaGenerationInput = {
      ...scope,
      receiptId,
      initiatingAgentId: origin.kind === "genie_tool" ? actor.agentId : null,
      initiatingThreadId: origin.kind === "genie_tool" ? origin.threadId : null,
      kind: mediaGenerationKindForModel(request.model),
      providerModel: request.model,
      providerAccountFingerprint: dependencies.providerAccountFingerprint,
      approvalDigest: prepared.binding.approvalDigest,
      quoteDigest: prepared.binding.quoteDigest,
      safeSnapshot: safeSnapshot(request),
      requestPayload: requestPayload(request),
      quotedUsdMicros: amountUsdMicros,
    };

    try {
      const receipt = await dependencies.repository.reserve(reservation);
      if (!exactReceiptMatchesPrepared(receipt, prepared, dependencies.providerAccountFingerprint, actor) || receipt.state !== "prequeue") {
        return {
          ok: false,
          code: "quote_binding_failed",
          recovery: "The durable quote changed. Request a fresh generation; no new generation was started.",
        };
      }
    } catch {
      return {
        ok: false,
        code: "quote_reservation_failed",
        recovery: "The quote could not be reserved safely. Try again; no generation was started.",
      };
    }
    return { ok: true, prepared };
  }

  async function prepare(
    actor: MediaGenerationApprovalActorContext,
    input: MediaGenerationPreparationInput,
  ): Promise<MediaGenerationPreparationResult> {
    const intentDigest = digest({ actor, input });
    const preparationKey = digest({
      userId: actor.userId,
      roomId: actor.roomId,
      approvalId: input.approvalId,
    });
    const existing = preparations.get(preparationKey);
    if (existing) {
      if (existing.intentDigest !== intentDigest) {
        return {
          ok: false,
          code: "request_invalid",
          recovery: "This approval changed while it was being prepared. Request a fresh generation.",
        };
      }
      return existing.promise;
    }
    const promise = prepareOnce(actor, input);
    preparations.set(preparationKey, { intentDigest, promise });
    if (preparations.size > MAX_PREPARATIONS) {
      preparations.delete(preparations.keys().next().value as string);
    }
    return promise;
  }

  async function submit(
    actor: MediaGenerationApprovalActorContext,
    input: MediaGenerationSubmitInput,
  ): Promise<MediaGenerationSafeResult> {
    const prepared = input.prepared;
    const binding = prepared.binding;
    if (!verifyMediaGenerationPreparedApproval(prepared, {
      userId: actor.userId,
      roomId: actor.roomId,
      origin: binding.origin,
      approvalId: input.approvalId,
      receiptId: input.receiptId,
      digest: input.digest,
      quoteDigest: input.quoteDigest,
      revision: input.revision,
      now: now(),
    })) {
      return createUnboundMediaGenerationFailure({
        toolName: binding.origin.kind === "genie_tool" ? binding.origin.toolName : "generate_video",
        code: "MEDIA_APPROVAL_STALE",
        message: "This media approval is stale or no longer matches the prepared request.",
      });
    }

    let scope: MediaGenerationScope;
    try {
      scope = await dependencies.resolveScope(actor);
      assertScope(actor, scope);
    } catch {
      return notStartedUnavailableResult(prepared);
    }

    let receipt: MediaGenerationCoreReceipt | null;
    try {
      receipt = await dependencies.repository.find(scope, binding.receiptId);
    } catch {
      return notStartedUnavailableResult(prepared);
    }
    if (!receipt || !exactReceiptMatchesPrepared(receipt, prepared, dependencies.providerAccountFingerprint, actor)) {
      return createUnboundMediaGenerationFailure({
        toolName: binding.origin.kind === "genie_tool" ? binding.origin.toolName : "generate_video",
        code: "MEDIA_RECEIPT_MISMATCH",
        message: "The durable media receipt no longer matches this approval.",
      });
    }
    if (isAcceptedState(receipt.state)) return queuedResult(prepared);
    if (receipt.state === "admitting" || receipt.state === "unknown") return unavailableResult(prepared);
    if (receipt.state === "failed" || receipt.state === "needs_action") {
      return refusedResult(prepared, receipt.safeFailure ?? { code: "VENICE_GENERATION_REFUSED" },
        receipt.state === "needs_action" ? "needs-action" : "failed");
    }
    if (receipt.state !== "prequeue") return unavailableResult(prepared);

    await assertServerFunding(actor.userId, "media_generation_submit");
    let proof: MediaGenerationAdmissionProof | null;
    try {
      proof = await dependencies.repository.beginAdmission(scope, receipt.receiptId, receipt.revision);
    } catch {
      return notStartedUnavailableResult(prepared);
    }
    if (!proof) {
      try {
        const raced = await dependencies.repository.find(scope, receipt.receiptId);
        if (raced && exactReceiptMatchesPrepared(raced, prepared, dependencies.providerAccountFingerprint, actor)) {
          if (isAcceptedState(raced.state)) return queuedResult(prepared);
          if (raced.state === "prequeue") return notStartedUnavailableResult(prepared);
          if (raced.state === "failed" || raced.state === "needs_action") {
            return refusedResult(prepared, raced.safeFailure ?? { code: "VENICE_GENERATION_REFUSED" },
              raced.state === "needs_action" ? "needs-action" : "failed");
          }
        }
      } catch {
        // The durable non-prequeue state still prevents another queue call.
      }
      return unavailableResult(prepared);
    }

    try {
      const accepted = await dependencies.venice.queueVeniceMediaGeneration(proof, actor);
      if (accepted.receiptId !== proof.receiptId || accepted.model !== proof.providerModel ||
          accepted.kind !== proof.kind || accepted.providerQueueId.trim() === "") {
        const unknown = classifyVeniceMediaFailure({ phase: "admission", transportFailure: true });
        await dependencies.repository.recordUnknown(proof, dbSafeFailure(unknown));
        return unavailableResult(prepared);
      }
      const recorded = await dependencies.repository.recordAccepted(proof, accepted.providerQueueId);
      return recorded ? queuedResult(prepared) : unavailableResult(prepared);
    } catch (error) {
      const failure = error instanceof VeniceMediaLifecycleError
        ? error.failure
        : classifyVeniceMediaFailure({ phase: "admission", transportFailure: true });
      const safeFailure = dbSafeFailure(failure);
      try {
        if (failure.completionCertainty === "unknown" || failure.stateChanged) {
          await dependencies.repository.recordUnknown(proof, safeFailure);
          return unavailableResult(prepared);
        }
        const refusal = deterministicRefusal(failure, safeFailure);
        if (!refusal) {
          return unavailableResult(prepared);
        }
        const recorded = await dependencies.repository.recordRefused(proof, refusal);
        if (!recorded) return refusalWriteFailedResult(prepared);
        return refusedResult(prepared, {
          code: safeFailure.code,
          message: providerFailureMessage(failure),
          ...(safeFailure.creditsRefunded === undefined
            ? {}
            : { creditsRefunded: safeFailure.creditsRefunded }),
        }, refusal.state === "needs_action" ? "needs-action" : "failed");
      } catch {
        // `admitting` remains a durable no-requeue fence if the outcome write
        // itself is unavailable. Reconciliation must decide the next action.
        return failure.completionCertainty === "not_started"
          ? refusalWriteFailedResult(prepared)
          : unavailableResult(prepared);
      }
    }
  }

  return { prepare, submit };
}
