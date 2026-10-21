/** Production composition for durable direct or marketplace media admission. */
import {
  VENICE_API_V1_BASE,
  VeniceMediaLifecycleAdapter,
  VeniceMediaLifecycleError,
  SurplusMediaLifecycleAdapter,
  VeniceQuoteLifecycleError,
  classifyVeniceMediaFailure,
  createMediaGenerationServerCore,
  resolveSurplusMediaRoute,
  sanitizeVeniceProviderCode,
  readBoundedMediaJson,
  setMediaGenerationApprovalRuntime,
  type ExactMediaGenerationQuotePort,
  type MediaGenerationFailure,
  type MediaGenerationApprovalRuntime,
  type MediaGenerationCoreReceipt,
  type MediaGenerationCoreRepository,
  type MediaGenerationApprovalActorContext,
  type VeniceMediaAdmissionPort,
  type VeniceMediaFetch,
} from "@nautilo/agent";
import type { DurableServiceFundingBinding } from "@nautilo/types";
import {
  actors,
  and,
  beginMediaGenerationAdmission,
  createMediaGeneration,
  eq,
  findMediaGeneration,
  isNull,
  markMediaGenerationAdmissionUnknown,
  recordMediaGenerationAccepted,
  recordMediaGenerationAdmissionRefused,
  roomMembers,
  rooms,
  type CreateMediaGenerationInput,
  type DirectDatabase,
  type MediaGeneration,
  type MediaGenerationAdmissionProof,
  type MediaGenerationAdmissionRefusal,
  type MediaGenerationSafeFailure,
  type MediaGenerationScope,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { providerAccountFingerprint } from "../lib/provider-catalog-cache";
import { MEDIA_PRESPEND_TIMEOUT_MS, openMediaFunding } from "../lib/media-funding";
import { runWithDurableServiceFunding } from "../lib/service-funding";
import {
  beginServerProviderCostAttempt,
  settleServerProviderCostAttempt,
} from "../costs/provider-cost-recorder";
import { getServerDirectDb } from "../lib/server-direct-db";
import { getUserCapabilities } from "@nautilo/trust";
import { resolveMediaReferenceNamespaces } from "./reference-scope";
import {
  resolveApprovedReferenceMediaUrls,
  resolveMediaGenerationReferenceRequest,
} from "./reference-request";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const VENICE_DELIVERY_HOSTS_ENV = "NAUTILO_VENICE_MEDIA_SIGNED_DELIVERY_HOSTS";
const SURPLUS_DELIVERY_HOSTS_ENV = "NAUTILO_SURPLUS_MEDIA_SIGNED_DELIVERY_HOSTS";
const DEFAULT_QUOTE_MAX_ATTEMPTS = 3;
const MAX_QUOTE_RETRY_DELAY_MS = 2_000;
const RETRYABLE_QUOTE_STATUSES = new Set([429, 500, 502, 503, 504]);

export type VeniceQuoteDiagnostic = Readonly<{
  outcome: "retrying" | "failed";
  attempt: number;
  maxAttempts: number;
  endpoint: "/video/quote" | "/audio/quote";
  model: string;
  failureCode: string;
  transportKind?: "network" | "timeout";
  status?: number;
  providerCode?: string;
  requestId?: string;
}>;

function coreReceipt(row: MediaGeneration): MediaGenerationCoreReceipt {
  if (row.ownerId === null) {
    throw new Error("anonymized media receipt is not available to an account-scoped runtime");
  }
  return {
    receiptId: row.receiptId,
    ownerId: row.ownerId,
    roomId: row.roomId,
    namespaceId: row.namespaceId,
    initiatingAgentId: row.initiatingAgentId,
    initiatingThreadId: row.initiatingThreadId,
    state: row.state,
    revision: row.revision,
    approvalDigest: row.approvalDigest,
    quoteDigest: row.quoteDigest,
    provider: row.provider,
    providerAccountFingerprint: row.providerAccountFingerprint,
    ...(row.fundingBinding ? { fundingBinding: row.fundingBinding } : {}),
    requestPayload: row.requestPayload,
    quotedUsdMicros: row.quotedUsdMicros,
    safeFailure: row.safeFailure,
  };
}

export interface MediaGenerationDbOperations {
  readonly find: typeof findMediaGeneration;
  readonly create: typeof createMediaGeneration;
  readonly beginAdmission: typeof beginMediaGenerationAdmission;
  readonly recordAccepted: typeof recordMediaGenerationAccepted;
  readonly recordUnknown: typeof markMediaGenerationAdmissionUnknown;
  readonly recordRefused: typeof recordMediaGenerationAdmissionRefused;
}

const DEFAULT_DB_OPERATIONS: MediaGenerationDbOperations = {
  find: findMediaGeneration,
  create: createMediaGeneration,
  beginAdmission: beginMediaGenerationAdmission,
  recordAccepted: recordMediaGenerationAccepted,
  recordUnknown: markMediaGenerationAdmissionUnknown,
  recordRefused: recordMediaGenerationAdmissionRefused,
};

/** Exact adapter over the proof-bound D525 repository functions. */
export function createMediaGenerationDbRepository(
  db: DirectDatabase,
  operations: MediaGenerationDbOperations = DEFAULT_DB_OPERATIONS,
): MediaGenerationCoreRepository {
  return {
    async find(scope, receiptId) {
      const row = await operations.find(db, scope, receiptId);
      return row ? coreReceipt(row) : null;
    },
    async reserve(input: CreateMediaGenerationInput) {
      const existing = await operations.find(db, input, input.receiptId);
      if (existing) return coreReceipt(existing);
      try {
        return coreReceipt(await operations.create(db, input));
      } catch (error) {
        // A concurrent replay can win the deterministic receipt insert. Re-read
        // exact scope before deciding whether the original error is recoverable.
        const raced = await operations.find(db, input, input.receiptId);
        if (raced) return coreReceipt(raced);
        throw error;
      }
    },
    beginAdmission(scope, receiptId, expectedRevision) {
      return operations.beginAdmission(db, { ...scope, receiptId, expectedRevision });
    },
    async recordAccepted(proof: MediaGenerationAdmissionProof, providerQueueId: string) {
      const row = await operations.recordAccepted(db, proof, providerQueueId);
      return row ? coreReceipt(row) : null;
    },
    async recordUnknown(proof: MediaGenerationAdmissionProof, failure: MediaGenerationSafeFailure) {
      const row = await operations.recordUnknown(db, proof, failure);
      return row ? coreReceipt(row) : null;
    },
    async recordRefused(proof: MediaGenerationAdmissionProof, refusal: MediaGenerationAdmissionRefusal) {
      const row = await operations.recordRefused(db, proof, refusal);
      return row ? coreReceipt(row) : null;
    },
  };
}

/**
 * Re-prove one authenticated Human's current Room write boundary. This uses
 * the canonical user Actor + room_members edge + rooms.human_actor_ids; the
 * legacy rooms.owner_id field is deliberately not an authority shortcut.
 */
export async function resolveMediaGenerationWritableScope(
  db: DirectDatabase,
  actor: MediaGenerationApprovalActorContext,
  getCapabilities: (userId: string) => Promise<readonly string[]> = getUserCapabilities,
): Promise<MediaGenerationScope> {
  if (!(await getCapabilities(actor.userId)).includes("use_media_generation")) {
    throw new Error("media generation capability is not currently granted");
  }
  const humanActors = await db
    .select({ id: actors.id })
    .from(actors)
    .where(and(eq(actors.ownerId, actor.userId), eq(actors.kind, "user")))
    .limit(2);
  if (humanActors.length !== 1 || !humanActors[0]) {
    throw new Error("media generation requires one authenticated human actor");
  }
  const humanActorId = humanActors[0].id;
  const memberships = await db
    .select({
      roomId: rooms.id,
      namespaceId: rooms.namespaceId,
      kind: rooms.kind,
      humanActorIds: rooms.humanActorIds,
    })
    .from(rooms)
    .innerJoin(
      roomMembers,
      and(eq(roomMembers.roomId, rooms.id), eq(roomMembers.actorId, humanActorId)),
    )
    .where(and(eq(rooms.id, actor.roomId), isNull(rooms.archivedAt)))
    .limit(2);
  const membership = memberships.length === 1 ? memberships[0] : undefined;
  if (!membership || membership.kind === "task" || membership.kind === "access" ||
      !membership.humanActorIds.includes(humanActorId)) {
    throw new Error("media generation Room is not currently writable by this human");
  }
  return {
    ownerId: actor.userId,
    roomId: membership.roomId,
    namespaceId: membership.namespaceId,
  };
}

function exactQuoteMicros(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !("quote" in value)) {
    throw new Error("invalid Venice quote response");
  }
  const quote = (value as { quote?: unknown }).quote;
  if (typeof quote !== "number" || !Number.isFinite(quote) || quote < 0) {
    throw new Error("invalid Venice quote response");
  }
  const scaled = quote * 1_000_000;
  const micros = Math.round(scaled);
  if (!Number.isSafeInteger(micros) || micros > MAX_POSTGRES_INTEGER ||
      Math.abs(scaled - micros) > Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4) {
    throw new Error("Venice quote exceeds USD-micros precision");
  }
  return micros;
}

function invalidQuoteResponseFailure(): MediaGenerationFailure {
  return Object.freeze({
    code: "VENICE_QUOTE_INVALID_RESPONSE",
    phase: "quote",
    retrySafe: true,
    stateChanged: false,
    completionCertainty: "not_started",
    chargeCertainty: "not_charged",
    recoveryActions: ["wait", "contact_support"] as const,
    message: "Venice returned an invalid exact quote after safe retries. Try again later; no generation was started.",
  });
}

function quoteRequestId(response: Response): string | undefined {
  const value = response.headers.get("x-request-id") ?? response.headers.get("x-venice-request-id");
  if (value === null) return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(normalized) ? normalized : undefined;
}

async function quoteProviderCode(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await readBoundedMediaJson(response);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const nested = record["error"];
  const error = nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : record;
  return sanitizeVeniceProviderCode(error["code"] ?? error["type"]);
}

function retryAfterMs(response: Response, attempt: number): number {
  const fallback = attempt === 1 ? 150 : 500;
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_QUOTE_RETRY_DELAY_MS, Math.round(seconds * 1_000));
  }
  const at = Date.parse(value);
  return Number.isFinite(at)
    ? Math.min(MAX_QUOTE_RETRY_DELAY_MS, Math.max(0, at - Date.now()))
    : fallback;
}

function emitQuoteDiagnostic(
  diagnostic: VeniceQuoteDiagnostic,
  sink?: (diagnostic: VeniceQuoteDiagnostic) => void,
): void {
  if (sink) {
    sink(diagnostic);
    return;
  }
  warn("[media-generation] exact quote attempt failed", diagnostic);
}

/** Pricing-only HTTP lane. Creative prompt and lyrics are absent by contract. */
export function createExactVeniceMediaQuotePort(input: {
  readonly apiKey: string;
  readonly fetchImpl?: VeniceMediaFetch;
  readonly maxAttempts?: number;
  readonly attemptTimeoutMs?: number;
  readonly sleepImpl?: (delayMs: number) => Promise<void>;
  readonly onDiagnostic?: (diagnostic: VeniceQuoteDiagnostic) => void;
}): ExactMediaGenerationQuotePort {
  if (!input.apiKey.trim()) throw new Error("Venice media quote requires a configured key");
  const maxAttempts = input.maxAttempts ?? DEFAULT_QUOTE_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > DEFAULT_QUOTE_MAX_ATTEMPTS) {
    throw new Error(`Venice media quote maxAttempts must be between 1 and ${DEFAULT_QUOTE_MAX_ATTEMPTS}`);
  }
  const attemptTimeoutMs = input.attemptTimeoutMs ?? MEDIA_PRESPEND_TIMEOUT_MS;
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 60_000) {
    throw new Error("Venice media quote attemptTimeoutMs must be between 1 and 60000");
  }
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const sleepImpl = input.sleepImpl ?? ((delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  return {
    async quote(request) {
      const model = request.pricingRequest.model;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, attemptTimeoutMs);
        try {
          response = await fetchImpl(`${VENICE_API_V1_BASE}${request.endpoint}`, {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${input.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request.pricingRequest),
            signal: controller.signal,
          });
        } catch {
          clearTimeout(timeout);
          const failure = classifyVeniceMediaFailure({ phase: "quote", transportFailure: true });
          const retrying = attempt < maxAttempts;
          emitQuoteDiagnostic({
            outcome: retrying ? "retrying" : "failed",
            attempt,
            maxAttempts,
            endpoint: request.endpoint,
            model,
            failureCode: failure.code,
            transportKind: timedOut ? "timeout" : "network",
          }, input.onDiagnostic);
          if (!retrying) throw new VeniceQuoteLifecycleError(failure);
          await sleepImpl(attempt === 1 ? 150 : 500);
          continue;
        }

        const requestId = quoteRequestId(response);
        if (!response.ok) {
          const providerCode = await quoteProviderCode(response);
          clearTimeout(timeout);
          const failure = classifyVeniceMediaFailure({
            phase: "quote",
            status: response.status,
            ...(providerCode === undefined ? {} : { code: providerCode }),
          });
          const retrying = RETRYABLE_QUOTE_STATUSES.has(response.status) && attempt < maxAttempts;
          emitQuoteDiagnostic({
            outcome: retrying ? "retrying" : "failed",
            attempt,
            maxAttempts,
            endpoint: request.endpoint,
            model,
            failureCode: failure.code,
            status: response.status,
            ...(providerCode === undefined ? {} : { providerCode }),
            ...(requestId === undefined ? {} : { requestId }),
          }, input.onDiagnostic);
          if (!retrying) throw new VeniceQuoteLifecycleError(failure);
          await sleepImpl(retryAfterMs(response, attempt));
          continue;
        }

        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        let body: unknown;
        try {
          body = contentType === "application/json" ? await readBoundedMediaJson(response) : undefined;
          const amountUsdMicros = exactQuoteMicros(body);
          clearTimeout(timeout);
          return { amountUsdMicros };
        } catch {
          clearTimeout(timeout);
          const failure = invalidQuoteResponseFailure();
          const retrying = attempt < maxAttempts;
          emitQuoteDiagnostic({
            outcome: retrying ? "retrying" : "failed",
            attempt,
            maxAttempts,
            endpoint: request.endpoint,
            model,
            failureCode: failure.code,
            status: response.status,
            ...(requestId === undefined ? {} : { requestId }),
          }, input.onDiagnostic);
          if (!retrying) throw new VeniceQuoteLifecycleError(failure);
          await sleepImpl(attempt === 1 ? 150 : 500);
        }
      }
      throw new Error("unreachable Venice quote retry state");
    },
  };
}

/** Public, nonspending snapshot of the cheapest currently healthy media offer. */
function createSurplusMediaEstimatePort(input: {
  readonly fetchImpl?: VeniceMediaFetch;
  readonly attemptTimeoutMs?: number;
} = {}) {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const attemptTimeoutMs = input.attemptTimeoutMs ?? MEDIA_PRESPEND_TIMEOUT_MS;
  if (!Number.isSafeInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 60_000) {
    throw new Error("Surplus media estimate timeout must be between 1 and 60000ms");
  }
  return {
    async estimate(modelId: string): Promise<number> {
      const route = resolveSurplusMediaRoute(modelId);
      if (!route) throw new Error("marketplace media route is not qualified");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
      let body: unknown;
      try {
        const response = await fetchImpl(`https://api.surplusintelligence.ai/api/markets/${encodeURIComponent(route)}`, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          throw new Error("marketplace media estimate unavailable");
        }
        body = await readBoundedMediaJson(response);
      } finally {
        clearTimeout(timeout);
      }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          (body as Record<string, unknown>)["model"] !== route ||
          !Array.isArray((body as Record<string, unknown>)["offers"])) {
        throw new Error("marketplace media estimate is invalid");
      }
      const prices = ((body as Record<string, unknown>)["offers"] as unknown[]).flatMap((offer) => {
        if (!offer || typeof offer !== "object" || Array.isArray(offer)) return [];
        const row = offer as Record<string, unknown>;
        const price = row["media_unit_price"];
        return row["available"] === true && row["healthy"] === true && row["media_unit"] === "job" &&
          Number.isSafeInteger(price) && Number(price) >= 0
          ? [Number(price)]
          : [];
      });
      if (prices.length === 0) throw new Error("marketplace media estimate has no healthy offer");
      return Math.min(...prices);
    },
  };
}

function signedDeliveryHostsFromEnvironment(name: typeof VENICE_DELIVERY_HOSTS_ENV | typeof SURPLUS_DELIVERY_HOSTS_ENV): readonly string[] {
  const configured = process.env[name]?.trim();
  if (!configured) return [];
  return [...new Set(configured.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

export interface CreateProductionMediaGenerationRuntimeOptions {
  /** Legacy focused-test seam. Production opens the admitted durable binding per attempt. */
  readonly apiKey?: string;
  readonly db?: DirectDatabase;
  readonly fetchImpl?: VeniceMediaFetch;
  readonly veniceSignedDeliveryAllowedHosts?: readonly string[];
  readonly surplusSignedDeliveryAllowedHosts?: readonly string[];
  /** Focused test seam; production always uses the proof-bound DB functions. */
  readonly dbOperations?: MediaGenerationDbOperations;
  readonly openFunding?: typeof openMediaFunding;
  readonly runFunding?: typeof runWithDurableServiceFunding;
  readonly surplusEstimateUsdMicros?: (modelId: string) => Promise<number | null>;
  /** Focused-test seam. Production records the attempt before provider dispatch. */
  readonly beginCostAttempt?: typeof beginServerProviderCostAttempt;
  /** Focused-test seam. Production settles deterministic pre-admission failures. */
  readonly settleCostAttempt?: typeof settleServerProviderCostAttempt;
  /** Focused-test seam; production reads canonical current User capabilities. */
  readonly getCapabilities?: (userId: string) => Promise<readonly string[]>;
}

export function createProductionMediaGenerationRuntime(
  options: CreateProductionMediaGenerationRuntimeOptions,
): MediaGenerationApprovalRuntime {
  const db = options.db ?? getServerDirectDb();
  const runFunding = options.runFunding ?? runWithDurableServiceFunding;
  const legacyKey = options.apiKey?.trim();
  const beginCostAttempt = options.beginCostAttempt ?? (legacyKey
    ? () => Promise.resolve()
    : beginServerProviderCostAttempt);
  const settleCostAttempt = options.settleCostAttempt ?? (legacyKey
    ? () => Promise.resolve()
    : settleServerProviderCostAttempt);
  const withFunding = async <T>(
    binding: DurableServiceFundingBinding,
    intent: "spend" | "recover",
    callback: (attempt: { apiKey: string; usageFunding: import("@nautilo/agent").UsageFundingProvenance }) => Promise<T>,
  ): Promise<T> => {
    if (legacyKey) {
      if (binding.provider !== "venice" || binding.credentialFingerprint !== providerAccountFingerprint(legacyKey)) {
        throw new Error("legacy media funding changed");
      }
      return callback({ apiKey: legacyKey, usageFunding: { kind: "server", humanUserId: binding.humanUserId, providerRoute: "venice" } });
    }
    return runFunding(binding, intent, callback);
  };
  const surplusEstimateByBinding = new WeakMap<DurableServiceFundingBinding, number>();
  const estimateSurplus = async (binding: DurableServiceFundingBinding, modelId: string): Promise<number> => {
    const amountUsdMicros = await withFunding(binding, "spend", () =>
      options.surplusEstimateUsdMicros
        ? options.surplusEstimateUsdMicros(modelId)
        : createSurplusMediaEstimatePort({
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }).estimate(modelId));
    if (amountUsdMicros === null || !Number.isSafeInteger(amountUsdMicros) || amountUsdMicros < 0) {
      throw new Error("marketplace media estimate unavailable");
    }
    return amountUsdMicros;
  };
  const admitFunding = async (actor: MediaGenerationApprovalActorContext, request: import("@nautilo/agent").NormalizedMediaGenerationRequest) => {
    if (legacyKey) {
      return {
        humanUserId: actor.userId,
        provider: "venice" as const,
        binding: { kind: "server" as const, providerRoute: "venice" },
        credentialFingerprint: providerAccountFingerprint(legacyKey),
      };
    }
    const openFunding = options.openFunding ?? openMediaFunding;
    const modelId = `venice:${request.model}`;
    const family = request.model === "sonilo-v1-1-music" || request.model === "minimax-music-v26"
      ? "music" as const
      : "video" as const;
    const directOnly = request.model === "seedance-2-5-reference-to-video-basic"
      || resolveSurplusMediaRoute(request.model) === null;
    const surplusRequirements = request.model === "seedance-2-5-text-to-video-basic"
      ? {
          durationSeconds: request.durationSeconds,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          audio: request.audio,
        }
      : request.model === "minimax-h3-enhanced-text-to-video"
        ? {
            durationSeconds: request.durationSeconds,
            aspectRatio: request.aspectRatio,
            resolution: request.resolution,
          }
        : undefined;
    const admitted = await openFunding(actor.userId, modelId, family, {
      operation: "generate",
      ...(directOnly ? { directOnly: true } : {}),
      ...(surplusRequirements ? { surplusRequirements } : {}),
    });
    if (admitted.modelId !== modelId || admitted.family !== family ||
        admitted.funding.humanUserId !== actor.userId ||
        (directOnly && admitted.funding.provider === "surplus")) {
      throw new Error("media funding admission changed the requested route");
    }
    if (admitted.funding.provider !== "surplus") return admitted.funding;

    try {
      surplusEstimateByBinding.set(
        admitted.funding,
        await estimateSurplus(admitted.funding, request.model),
      );
      return admitted.funding;
    } catch {
      // The market snapshot is part of fresh admission. If it has no healthy
      // exact-model offer, quote the same model directly before any approval-
      // bound receipt is reserved. The funding owner may explicitly admit
      // the initiating Human's personal key if server direct is unavailable.
      const direct = await openFunding(actor.userId, modelId, family, {
        operation: "generate",
        prior: admitted.funding,
        transport: "direct",
      });
      const ownPersonalRecovery = admitted.funding.binding.kind === "server"
        && direct.funding.binding.kind === "personal" && direct.funding.provider === "venice"
        && direct.funding.binding.providerRoute === "venice";
      if (direct.modelId !== modelId || direct.family !== family || direct.funding.provider !== "venice" ||
          direct.funding.humanUserId !== actor.userId ||
          (direct.funding.binding.kind !== admitted.funding.binding.kind && !ownPersonalRecovery)) {
        throw new Error("marketplace media fallback changed the admitted request");
      }
      return direct.funding;
    }
  };
  const directRetrievalAdmission: VeniceMediaAdmissionPort = {
    async queueVeniceMediaGeneration(proof, actor) {
      try {
        return await withFunding(proof.fundingBinding, "spend", async ({ apiKey, usageFunding }) => {
          const assertCurrentQueueAuthority = async () => {
            try {
              const current = await resolveMediaGenerationWritableScope(db, actor, options.getCapabilities);
              if (current.ownerId !== proof.ownerId || current.roomId !== proof.roomId ||
                  current.namespaceId !== proof.namespaceId) throw new Error("media authority changed");
            } catch {
              throw new VeniceMediaLifecycleError(proof.receiptId, {
                code: "MEDIA_AUTHORITY_CHANGED", phase: "admission", retrySafe: false,
                stateChanged: false, completionCertainty: "not_started", chargeCertainty: "not_charged",
                recoveryActions: ["review_access"],
                message: "Media generation authority changed before dispatch. No provider request was sent.",
              });
            }
          };
          await assertCurrentQueueAuthority();
          await beginCostAttempt({
            identity: `media-generation:${proof.receiptId}`,
            usageFunding,
            userId: proof.ownerId,
            roomId: proof.roomId,
            agentId: actor.agentId,
            workload: "media_generation",
            provider: proof.provider,
            operation: "generate",
          });
          const lifecycle = proof.provider === "surplus"
            ? new SurplusMediaLifecycleAdapter({
                apiKey,
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                signedDeliveryAllowedHosts: options.surplusSignedDeliveryAllowedHosts ?? [],
              })
            : new VeniceMediaLifecycleAdapter({
                apiKey,
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                signedDeliveryAllowedHosts: options.veniceSignedDeliveryAllowedHosts ?? [],
                resolveReferenceMediaUrls: async (approved) => resolveApprovedReferenceMediaUrls(
                  db, approved, undefined, await resolveMediaReferenceNamespaces(approved, actor),
                ),
              });
          try {
            // Cost persistence is asynchronous too: recheck immediately before
            // the provider operation, after both funding and accounting opened.
            await assertCurrentQueueAuthority();
            const accepted = await lifecycle.queueVeniceMediaGeneration(proof);
            if (proof.provider === "venice" && accepted.signedDeliveryUrl !== undefined) {
              throw new VeniceMediaLifecycleError(proof.receiptId, {
                code: "VENICE_ADMISSION_DELIVERY_UNCERTAIN",
                phase: "admission",
                retrySafe: false,
                stateChanged: true,
                completionCertainty: "unknown",
                chargeCertainty: "unknown",
                recoveryActions: ["contact_support"],
                message: "Venice accepted the request with an unsupported delivery mode; Nautilo will not submit it again.",
              });
            }
            return accepted;
          } catch (error) {
            if (error instanceof VeniceMediaLifecycleError) {
              await settleCostAttempt({
                identity: `media-generation:${proof.receiptId}`,
                receiptId: proof.receiptId,
                usageFunding,
                userId: proof.ownerId,
                roomId: proof.roomId,
                agentId: actor.agentId,
                workload: "media_generation",
                provider: proof.provider,
                operation: "generate",
                evidenceState: "unknown",
                attemptOutcome: error.failure.completionCertainty === "not_started" ? "failed" : "unknown",
                failureCode: error.failure.code.toLowerCase(),
              }).catch(() => {
                // Accounting storage failure cannot change the provider outcome
                // or make an uncertain paid dispatch safe to submit again.
                warn("[media-generation] admission cost settlement unavailable; provider outcome preserved");
              });
            }
            throw error;
          }
        });
      } catch (error) {
        if (error instanceof VeniceMediaLifecycleError) throw error;
        throw new VeniceMediaLifecycleError(proof.receiptId, classifyVeniceMediaFailure({
          phase: "admission", status: 401,
        }));
      }
    },
  };
  return createMediaGenerationServerCore({
    repository: createMediaGenerationDbRepository(db, options.dbOperations ?? DEFAULT_DB_OPERATIONS),
    quotes: {
      async quote(request) {
        if (!request.fundingBinding || !request.provider) throw new Error("media quote funding is missing");
        if (request.provider === "surplus") {
          const amountUsdMicros = surplusEstimateByBinding.get(request.fundingBinding);
          if (amountUsdMicros === undefined) throw new Error("marketplace media estimate was not admitted");
          surplusEstimateByBinding.delete(request.fundingBinding);
          return { amountUsdMicros, kind: "estimate" };
        }
        return withFunding(request.fundingBinding, "spend", ({ apiKey }) =>
          createExactVeniceMediaQuotePort({
            apiKey,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }).quote(request));
      },
    },
    venice: directRetrievalAdmission,
    resolveScope: (actor) => resolveMediaGenerationWritableScope(db, actor, options.getCapabilities),
    resolveRequest: async (scope, request, actor) => resolveMediaGenerationReferenceRequest(db, scope, request, undefined,
      request.model === "seedance-2-5-reference-to-video-basic" ? await resolveMediaReferenceNamespaces(scope, actor) : [scope.namespaceId]),
    admitFunding,
  });
}

export interface InstallProductionMediaGenerationRuntimeOptions {
  readonly resolveKey?: () => string | null;
  readonly db?: DirectDatabase;
  readonly fetchImpl?: VeniceMediaFetch;
  readonly veniceSignedDeliveryAllowedHosts?: readonly string[];
  readonly surplusSignedDeliveryAllowedHosts?: readonly string[];
  readonly dbOperations?: MediaGenerationDbOperations;
  readonly openFunding?: typeof openMediaFunding;
  readonly runFunding?: typeof runWithDurableServiceFunding;
  readonly surplusEstimateUsdMicros?: (modelId: string) => Promise<number | null>;
  readonly beginCostAttempt?: typeof beginServerProviderCostAttempt;
  readonly settleCostAttempt?: typeof settleServerProviderCostAttempt;
  readonly getCapabilities?: (userId: string) => Promise<readonly string[]>;
}

/** Reset-first installation keeps missing credentials fail-closed. */
export function installProductionMediaGenerationRuntime(
  options: InstallProductionMediaGenerationRuntimeOptions = {},
): boolean {
  setMediaGenerationApprovalRuntime(null);
  const configuredKey = options.resolveKey?.()?.trim();
  setMediaGenerationApprovalRuntime(createProductionMediaGenerationRuntime({
    ...(configuredKey ? { apiKey: configuredKey } : {}),
    ...(options.db ? { db: options.db } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.dbOperations ? { dbOperations: options.dbOperations } : {}),
    ...(options.openFunding ? { openFunding: options.openFunding } : {}),
    ...(options.runFunding ? { runFunding: options.runFunding } : {}),
    ...(options.surplusEstimateUsdMicros ? { surplusEstimateUsdMicros: options.surplusEstimateUsdMicros } : {}),
    ...(options.beginCostAttempt ? { beginCostAttempt: options.beginCostAttempt } : {}),
    ...(options.settleCostAttempt ? { settleCostAttempt: options.settleCostAttempt } : {}),
    ...(options.getCapabilities ? { getCapabilities: options.getCapabilities } : {}),
    veniceSignedDeliveryAllowedHosts: options.veniceSignedDeliveryAllowedHosts ??
      signedDeliveryHostsFromEnvironment(VENICE_DELIVERY_HOSTS_ENV),
    surplusSignedDeliveryAllowedHosts: options.surplusSignedDeliveryAllowedHosts ??
      signedDeliveryHostsFromEnvironment(SURPLUS_DELIVERY_HOSTS_ENV),
  }));
  return true;
}

export function resetProductionMediaGenerationRuntime(): void {
  setMediaGenerationApprovalRuntime(null);
}
