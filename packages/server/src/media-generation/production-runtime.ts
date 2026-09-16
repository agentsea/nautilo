/** D525 production composition for paid Venice media admission. */
import {
  VENICE_API_V1_BASE,
  VeniceMediaLifecycleAdapter,
  VeniceQuoteLifecycleError,
  classifyVeniceMediaFailure,
  createMediaGenerationServerCore,
  resolveProviderKey,
  sanitizeVeniceProviderCode,
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
import { getServerDirectDb } from "../lib/server-direct-db";
import {
  resolveApprovedReferenceMediaUrls,
  resolveMediaGenerationReferenceRequest,
} from "./reference-request";

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const DELIVERY_HOSTS_ENV = "NAUTILO_VENICE_MEDIA_SIGNED_DELIVERY_HOSTS";
const DEFAULT_QUOTE_MAX_ATTEMPTS = 3;
const DEFAULT_QUOTE_ATTEMPT_TIMEOUT_MS = 30_000;
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
    providerAccountFingerprint: row.providerAccountFingerprint,
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
): Promise<MediaGenerationScope> {
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
    body = await response.json();
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
  const attemptTimeoutMs = input.attemptTimeoutMs ?? DEFAULT_QUOTE_ATTEMPT_TIMEOUT_MS;
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
          body = contentType === "application/json" ? await response.json() : undefined;
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

function signedDeliveryHostsFromEnvironment(): readonly string[] {
  const configured = process.env[DELIVERY_HOSTS_ENV]?.trim();
  if (!configured) return [];
  return [...new Set(configured.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

export interface CreateProductionMediaGenerationRuntimeOptions {
  readonly apiKey: string;
  readonly db?: DirectDatabase;
  readonly fetchImpl?: VeniceMediaFetch;
  readonly signedDeliveryAllowedHosts?: readonly string[];
  /** Focused test seam; production always uses the proof-bound DB functions. */
  readonly dbOperations?: MediaGenerationDbOperations;
}

export function createProductionMediaGenerationRuntime(
  options: CreateProductionMediaGenerationRuntimeOptions,
): MediaGenerationApprovalRuntime {
  const db = options.db ?? getServerDirectDb();
  const lifecycle = new VeniceMediaLifecycleAdapter({
    apiKey: options.apiKey,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    signedDeliveryAllowedHosts: options.signedDeliveryAllowedHosts ?? [],
    resolveReferenceMediaUrls: (proof) => resolveApprovedReferenceMediaUrls(db, proof),
  });
  const directRetrievalAdmission: VeniceMediaAdmissionPort = {
    async queueVeniceMediaGeneration(proof) {
      const accepted = await lifecycle.queueVeniceMediaGeneration(proof);
      // The first-wave models are anonymized/direct-retrieval. A signed URL
      // cannot be persisted by the current receipt schema, so accepting it
      // would make restart-safe retrieval impossible. A generic throw is
      // intentionally classified by the core as ambiguous admission.
      if (accepted.signedDeliveryUrl !== undefined) {
        throw new Error("unexpected Venice media delivery mode");
      }
      return accepted;
    },
  };
  return createMediaGenerationServerCore({
    repository: createMediaGenerationDbRepository(db, options.dbOperations ?? DEFAULT_DB_OPERATIONS),
    quotes: createExactVeniceMediaQuotePort({
      apiKey: options.apiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),
    venice: directRetrievalAdmission,
    resolveScope: (actor) => resolveMediaGenerationWritableScope(db, actor),
    resolveRequest: (scope, request) => resolveMediaGenerationReferenceRequest(db, scope, request),
    providerAccountFingerprint: providerAccountFingerprint(options.apiKey),
  });
}

export interface InstallProductionMediaGenerationRuntimeOptions {
  readonly resolveKey?: () => string | null;
  readonly db?: DirectDatabase;
  readonly fetchImpl?: VeniceMediaFetch;
  readonly signedDeliveryAllowedHosts?: readonly string[];
  readonly dbOperations?: MediaGenerationDbOperations;
}

/** Reset-first installation keeps missing credentials fail-closed. */
export function installProductionMediaGenerationRuntime(
  options: InstallProductionMediaGenerationRuntimeOptions = {},
): boolean {
  setMediaGenerationApprovalRuntime(null);
  const apiKey = (options.resolveKey ?? (() => resolveProviderKey("venice")))()?.trim();
  if (!apiKey) return false;
  setMediaGenerationApprovalRuntime(createProductionMediaGenerationRuntime({
    apiKey,
    ...(options.db ? { db: options.db } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.dbOperations ? { dbOperations: options.dbOperations } : {}),
    signedDeliveryAllowedHosts: options.signedDeliveryAllowedHosts ?? signedDeliveryHostsFromEnvironment(),
  }));
  return true;
}

export function resetProductionMediaGenerationRuntime(): void {
  setMediaGenerationApprovalRuntime(null);
}
