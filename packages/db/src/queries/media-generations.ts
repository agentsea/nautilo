/** D525 durable media lifecycle repository. DB rows are canonical; callers publish notifications separately. */
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import {
  mediaGenerations,
  type MediaGeneration,
  type MediaGenerationKind,
  type MediaGenerationNormalizedSettings,
  type MediaGenerationRequestPayload,
  type MediaGenerationSafeFailure,
  type MediaGenerationSafeSnapshot,
  type MediaGenerationState,
} from "../schema/media-generations";

export const MEDIA_GENERATION_CLAIM_LEASE_MS = 60_000;
export const MEDIA_GENERATION_CLAIM_BATCH_MAX = 32;
export const MEDIA_GENERATION_RECONCILABLE_STATES = ["queued", "retrieving", "saving"] as const;
const MAX_PUBLIC_DURATION_SECONDS = 2_147_483_647;

export type MediaGenerationTx = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

export interface MediaGenerationScope {
  readonly ownerId: string;
  readonly roomId: string;
  readonly namespaceId: string;
}

export interface CreateMediaGenerationInput extends MediaGenerationScope {
  readonly receiptId: string;
  readonly initiatingAgentId: string | null;
  readonly initiatingThreadId: string | null;
  readonly kind: MediaGenerationKind;
  readonly providerModel: string;
  readonly providerAccountFingerprint: string;
  readonly approvalDigest: string;
  readonly quoteDigest: string;
  readonly safeSnapshot: MediaGenerationSafeSnapshot;
  readonly requestPayload: MediaGenerationRequestPayload;
  readonly quotedUsdMicros: number;
  readonly retainUntil?: Date | null;
}

export interface MediaGenerationTransitionInput extends MediaGenerationScope {
  readonly receiptId: string;
  readonly expectedRevision: number;
  readonly from: MediaGenerationState;
  readonly to: MediaGenerationState;
  readonly safeFailure?: MediaGenerationSafeFailure | null;
  readonly artifactInternalId?: string;
  readonly nextAttemptAt?: Date;
  readonly terminalAt?: Date | null;
}

/** Safe, provider-derived timing evidence. `estimatedSeconds` is a typical/P80 duration, never time remaining. */
export interface MediaGenerationProcessingTiming {
  readonly elapsedSeconds?: number;
  readonly estimatedSeconds?: number;
}

export interface ClaimedMediaGeneration {
  readonly receiptId: string;
  readonly ownerId: string;
  /** Nullable only for receipts without an Agent initiator; never infer owner authorship. */
  readonly initiatingAgentId?: string | null;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly state: MediaGenerationState;
  readonly revision: number;
  readonly kind: MediaGenerationKind;
  readonly providerModel: string;
  /** Server-only provider coordinate. Never project this into a card or tool result. */
  readonly providerQueueId: string | null;
  /** Last validated provider timing, needed to keep elapsed display monotonic across worker restarts. */
  readonly providerExecutionSeconds: number | null;
  /** Last validated provider P80 duration; presentation labels this as typical time. */
  readonly providerAverageExecutionSeconds: number | null;
  readonly artifactInternalId: string | null;
  readonly cleanupState: "pending" | "completed";
}

export interface ClaimedMediaGenerationCompletionWake extends MediaGenerationScope {
  readonly receiptId: string;
  readonly revision: number;
  readonly kind: MediaGenerationKind;
  readonly initiatingAgentId: string;
  readonly initiatingThreadId: string;
  readonly claimedAt: Date;
}

const claimedMediaGenerationColumns = {
  receiptId: mediaGenerations.receiptId,
  ownerId: mediaGenerations.ownerId,
  initiatingAgentId: mediaGenerations.initiatingAgentId,
  roomId: mediaGenerations.roomId,
  namespaceId: mediaGenerations.namespaceId,
  state: mediaGenerations.state,
  revision: mediaGenerations.revision,
  kind: mediaGenerations.kind,
  providerModel: mediaGenerations.providerModel,
  providerQueueId: mediaGenerations.providerQueueId,
  providerExecutionSeconds: mediaGenerations.providerExecutionSeconds,
  providerAverageExecutionSeconds: mediaGenerations.providerAverageExecutionSeconds,
  artifactInternalId: mediaGenerations.artifactInternalId,
  cleanupState: mediaGenerations.cleanupState,
};

const TRANSITIONS: Readonly<Record<MediaGenerationState, readonly MediaGenerationState[]>> = {
  prequeue: ["needs_action", "failed"],
  // Admission terminal edges require the DB-minted proof and use the
  // dedicated refusal/unknown functions below, never the generic CAS.
  admitting: [],
  queued: ["retrieving", "needs_action", "failed", "unknown"],
  retrieving: ["saving", "needs_action", "failed", "unknown"],
  saving: ["ready", "needs_action", "failed", "unknown"],
  ready: [],
  needs_action: [],
  failed: [],
  unknown: ["needs_action"],
};

const mediaGenerationAdmissionProofBrand: unique symbol = Symbol(
  "mediaGenerationAdmissionProof",
);

/**
 * Only `beginMediaGenerationAdmission` can construct this branded, random-
 * token-bearing value. The provider adapter requires it before queue I/O.
 */
export interface MediaGenerationAdmissionProof extends MediaGenerationScope {
  readonly receiptId: string;
  readonly revision: number;
  readonly admissionToken: string;
  readonly kind: MediaGenerationKind;
  readonly providerModel: string;
  readonly requestPayload: MediaGenerationRequestPayload;
  readonly [mediaGenerationAdmissionProofBrand]: true;
}

export interface MediaGenerationAdmissionRefusal {
  readonly state: "failed" | "needs_action";
  readonly safeFailure: MediaGenerationSafeFailure;
}

function assertNonempty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must be nonempty`);
}

function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("expectedRevision must be a nonnegative safe integer");
}

function assertSafeTimestamp(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return value;
}

function assertScope(scope: MediaGenerationScope): void {
  assertNonempty(scope.ownerId, "ownerId");
  assertNonempty(scope.roomId, "roomId");
  assertNonempty(scope.namespaceId, "namespaceId");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPublicDurationSeconds(value: unknown): value is number {
  return isNonnegativeSafeInteger(value) && value <= MAX_PUBLIC_DURATION_SECONDS;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeSettingToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:+-]{1,64}$/u.test(value);
}

function hasExactRecoveryActions(
  value: unknown,
  expected: readonly MediaGenerationSafeFailure["recoveryActions"][number][],
): boolean {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((action, index) => action === expected[index]);
}

/**
 * Admission can terminate without a provider receipt only for closed,
 * deterministic classifier outcomes. Anything ambiguous must use the
 * separate unknown-admission fence so it can never authorize a second queue.
 */
function assertDeterministicAdmissionRefusal(
  refusal: MediaGenerationAdmissionRefusal,
): void {
  const failure: unknown = refusal.safeFailure;
  if (!isPlainRecord(failure) || !hasOnlyKeys(failure, [
    "code", "phase", "retrySafe", "stateChanged", "completionCertainty",
    "chargeCertainty", "recoveryActions", "creditsRefunded",
  ])) {
    throw new Error("admission refusal must contain classified safe facts only");
  }
  if (failure["phase"] !== "queue" || failure["stateChanged"] !== false ||
      failure["completionCertainty"] !== "not_started") {
    throw new Error("ambiguous provider admission must use the unknown fence");
  }

  if (refusal.state === "needs_action" &&
      failure["code"] === "VENICE_NEEDS_CONSENT" &&
      failure["retrySafe"] === false &&
      failure["chargeCertainty"] === "not_charged" &&
      failure["creditsRefunded"] === undefined &&
      hasExactRecoveryActions(failure["recoveryActions"], ["repair_account", "switch_model"])) {
    return;
  }

  if (refusal.state === "needs_action" &&
      (failure["code"] === "VENICE_AUTHENTICATION" || failure["code"] === "VENICE_BILLING") &&
      failure["retrySafe"] === true &&
      failure["chargeCertainty"] === "not_charged" &&
      failure["creditsRefunded"] === undefined &&
      hasExactRecoveryActions(failure["recoveryActions"], ["repair_account"])) {
    return;
  }

  if (refusal.state === "needs_action" &&
      failure["code"] === "VENICE_ACCESS" &&
      failure["retrySafe"] === false &&
      failure["chargeCertainty"] === "not_charged" &&
      failure["creditsRefunded"] === undefined &&
      hasExactRecoveryActions(failure["recoveryActions"], ["repair_account", "switch_model"])) {
    return;
  }

  const creditsRefunded = failure["creditsRefunded"];
  if (refusal.state === "failed" &&
      failure["code"] === "VENICE_CONTENT_POLICY" &&
      failure["retrySafe"] === false &&
      (creditsRefunded === undefined || typeof creditsRefunded === "boolean") &&
      failure["chargeCertainty"] === (creditsRefunded === true ? "refunded" : "unknown") &&
      hasExactRecoveryActions(failure["recoveryActions"], ["revise", "switch_model"])) {
    return;
  }


  if (refusal.state === "failed" &&
      (failure["code"] === "VENICE_INVALID_REQUEST" ||
       failure["code"] === "VENICE_PAYLOAD_TOO_LARGE" ||
       failure["code"] === "VENICE_UNSUPPORTED_MEDIA") &&
      failure["retrySafe"] === false &&
      failure["chargeCertainty"] === "not_charged" &&
      creditsRefunded === undefined &&
      hasExactRecoveryActions(failure["recoveryActions"], ["revise"])) {
    return;
  }

  if (refusal.state === "failed" &&
      (failure["code"] === "VENICE_RATE_LIMITED" || failure["code"] === "VENICE_CAPACITY") &&
      failure["retrySafe"] === true &&
      failure["chargeCertainty"] === "not_charged" &&
      creditsRefunded === undefined &&
      hasExactRecoveryActions(failure["recoveryActions"], ["start_fresh"])) {
    return;
  }
  throw new Error("unsupported deterministic admission refusal");
}

/** Reject structural widening before a JSON receipt reaches the DB backstop. */
export function assertMediaGenerationSafeSnapshot(
  snapshot: MediaGenerationSafeSnapshot,
): void {
  const value: unknown = snapshot;
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["version", "normalizedSettings", "inputSummary"]) || value["version"] !== 1) {
    throw new Error("safeSnapshot must be a version 1 normalized settings summary");
  }
  const normalizedSettings = value["normalizedSettings"];
  assertNormalizedSettings(normalizedSettings, "safeSnapshot.normalizedSettings");
  const inputSummary = value["inputSummary"];
  if (!isPlainRecord(inputSummary) || !hasOnlyKeys(inputSummary, ["promptCharacters", "lyricsCharacters", "referenceImageCount"]) || !isNonnegativeSafeInteger(inputSummary["promptCharacters"]) ||
      (inputSummary["lyricsCharacters"] !== undefined && !isNonnegativeSafeInteger(inputSummary["lyricsCharacters"])) ||
      (inputSummary["referenceImageCount"] !== undefined && (!isPositiveSafeInteger(inputSummary["referenceImageCount"]) || inputSummary["referenceImageCount"] > 30))) {
    throw new Error("safeSnapshot.inputSummary must contain counts only");
  }
}

function assertNormalizedSettings(value: unknown, label: string): asserts value is MediaGenerationNormalizedSettings {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["durationSeconds", "resolution", "aspectRatio", "audioEnabled", "instrumental"])) {
    throw new Error(`${label} contains an unsafe field`);
  }
  if ((value["durationSeconds"] !== undefined && !isPositiveSafeInteger(value["durationSeconds"])) ||
      (value["resolution"] !== undefined && !isSafeSettingToken(value["resolution"])) ||
      (value["aspectRatio"] !== undefined && !isSafeSettingToken(value["aspectRatio"])) ||
      (value["audioEnabled"] !== undefined && typeof value["audioEnabled"] !== "boolean") ||
      (value["instrumental"] !== undefined && typeof value["instrumental"] !== "boolean")) {
    throw new Error(`${label} has an invalid value`);
  }
}

/** Ensure internal resume input is closed and cannot carry provider topology or secret fields. */
export function assertMediaGenerationRequestPayload(
  requestPayload: MediaGenerationRequestPayload,
  providerModel: string,
): void {
  const value: unknown = requestPayload;
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["version", "model", "prompt", "lyrics", "referenceImages", "referenceVideos", "normalizedSettings"]) || value["version"] !== 1 ||
      typeof value["model"] !== "string" || value["model"] !== providerModel || !isSafeSettingToken(value["model"]) ||
      typeof value["prompt"] !== "string" || (value["lyrics"] !== undefined && typeof value["lyrics"] !== "string")) {
    throw new Error("requestPayload must be an exact approved v1 request");
  }
  const referenceImages = value["referenceImages"];
  if (referenceImages !== undefined && (!Array.isArray(referenceImages) || referenceImages.length > 30 ||
      referenceImages.some((reference) => !isPlainRecord(reference) || !hasOnlyKeys(reference, [
        "path", "artifactId", "artifactInternalId", "revision", "mimeType", "sizeBytes", "sha256",
      ]) || typeof reference["path"] !== "string" || reference["path"].length < 1 || reference["path"].length > 512 ||
        typeof reference["artifactId"] !== "string" || reference["artifactId"].length < 1 || reference["artifactId"].length > 256 ||
        typeof reference["artifactInternalId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(reference["artifactInternalId"]) ||
        !isPositiveSafeInteger(reference["revision"]) || typeof reference["mimeType"] !== "string" ||
        !["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"].includes(reference["mimeType"]) ||
        !isPositiveSafeInteger(reference["sizeBytes"]) || reference["sizeBytes"] > 30 * 1024 * 1024 ||
        typeof reference["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(reference["sha256"])))) {
    throw new Error("requestPayload.referenceImages must contain exact immutable Artifact bindings");
  }
  const videos = value["referenceVideos"];
  if (videos !== undefined) {
    if (!Array.isArray(videos) || videos.length > 10) throw new Error("Invalid reference video bindings");
    let totalVideoSeconds = 0;
    for (const video of videos) {
      if (!isPlainRecord(video) || !hasOnlyKeys(video, ["path", "artifactId", "artifactInternalId", "revision", "mimeType", "sizeBytes", "sha256", "durationSeconds"]) ||
          typeof video["durationSeconds"] !== "number" || !Number.isFinite(video["durationSeconds"]) || video["durationSeconds"] < 2 || video["durationSeconds"] > 30 ||
          !["video/mp4", "video/quicktime"].includes(String(video["mimeType"])) ||
          !isPositiveSafeInteger(video["sizeBytes"]) || video["sizeBytes"] > 50 * 1024 * 1024) throw new Error("Invalid reference video binding");
      if (typeof video["path"] !== "string" || video["path"].length < 1 || video["path"].length > 512 ||
          typeof video["artifactId"] !== "string" || video["artifactId"].length < 1 || video["artifactId"].length > 256 ||
          typeof video["artifactInternalId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(video["artifactInternalId"]) ||
          !isPositiveSafeInteger(video["revision"]) || typeof video["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(video["sha256"])) throw new Error("Invalid immutable video identity");
      totalVideoSeconds += video["durationSeconds"];
    }
    if (totalVideoSeconds > 30) throw new Error("Reference video duration exceeds provider limit");
  }
  if (providerModel === "seedance-2-5-reference-to-video-basic" &&
      !(Array.isArray(referenceImages) && referenceImages.length) && !(Array.isArray(videos) && videos.length)) throw new Error("Reference media missing");
  if (providerModel !== "seedance-2-5-reference-to-video-basic" && (referenceImages !== undefined || videos !== undefined)) throw new Error("References require reference model");
  assertNormalizedSettings(value["normalizedSettings"], "requestPayload.normalizedSettings");
}

function scopeWhere(scope: MediaGenerationScope, receiptId: string) {
  return and(
    eq(mediaGenerations.receiptId, receiptId),
    eq(mediaGenerations.ownerId, scope.ownerId),
    eq(mediaGenerations.roomId, scope.roomId),
    eq(mediaGenerations.namespaceId, scope.namespaceId),
  );
}

function claimedWhere(input: MediaGenerationScope & {
  readonly receiptId: string;
  readonly workerId: string;
  readonly expectedRevision: number;
  readonly state: MediaGenerationState;
}, now: Date) {
  return and(
    scopeWhere(input, input.receiptId),
    eq(mediaGenerations.claimOwner, input.workerId),
    gt(mediaGenerations.claimExpiresAt, now),
    eq(mediaGenerations.revision, input.expectedRevision),
    eq(mediaGenerations.state, input.state),
  );
}

function assertClaimInput(input: MediaGenerationScope & {
  readonly receiptId: string;
  readonly workerId: string;
  readonly expectedRevision: number;
  readonly state: MediaGenerationState;
}): void {
  assertScope(input);
  assertNonempty(input.receiptId, "receiptId");
  assertNonempty(input.workerId, "workerId");
  assertRevision(input.expectedRevision);
}

/** Create the local receipt before a queue request can be issued. */
export async function createMediaGeneration(
  db: DirectDatabase,
  input: CreateMediaGenerationInput,
): Promise<MediaGeneration> {
  assertScope(input);
  for (const [value, label] of [[input.receiptId, "receiptId"], [input.providerModel, "providerModel"], [input.providerAccountFingerprint, "providerAccountFingerprint"], [input.approvalDigest, "approvalDigest"], [input.quoteDigest, "quoteDigest"]] as const) assertNonempty(value, label);
  if ((input.initiatingAgentId === null) !== (input.initiatingThreadId === null)) {
    throw new Error("initiatingAgentId and initiatingThreadId must both be present or both be absent");
  }
  if (input.initiatingAgentId !== null) assertNonempty(input.initiatingAgentId, "initiatingAgentId");
  if (input.initiatingThreadId !== null) assertNonempty(input.initiatingThreadId, "initiatingThreadId");
  if (!Number.isSafeInteger(input.quotedUsdMicros) || input.quotedUsdMicros < 0) throw new Error("quotedUsdMicros must be a nonnegative safe integer");
  assertMediaGenerationSafeSnapshot(input.safeSnapshot);
  assertMediaGenerationRequestPayload(input.requestPayload, input.providerModel);
  const [row] = await db.insert(mediaGenerations).values({ ...input }).returning();
  if (!row) throw new Error("media generation receipt insert returned no row");
  return row;
}

/** Exact scope lookup; provider coordinates remain on the internal row only. */
export async function findMediaGeneration(
  db: DirectDatabase,
  scope: MediaGenerationScope,
  receiptId: string,
): Promise<MediaGeneration | null> {
  assertScope(scope); assertNonempty(receiptId, "receiptId");
  const rows = await db.select().from(mediaGenerations).where(scopeWhere(scope, receiptId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Durably fence provider admission before any network dispatch. The random
 * proof is minted here, never supplied by a tool/model caller.
 */
export async function beginMediaGenerationAdmission(
  db: DirectDatabase,
  input: MediaGenerationScope & { readonly receiptId: string; readonly expectedRevision: number },
): Promise<MediaGenerationAdmissionProof | null> {
  assertScope(input); assertNonempty(input.receiptId, "receiptId"); assertRevision(input.expectedRevision);
  const admissionToken = randomUUID();
  const now = new Date();
  const [row] = await db.update(mediaGenerations).set({
    state: "admitting",
    admissionToken,
    admissionStartedAt: now,
    revision: input.expectedRevision + 1,
    updatedAt: now,
  }).where(and(
    scopeWhere(input, input.receiptId),
    eq(mediaGenerations.state, "prequeue"),
    eq(mediaGenerations.revision, input.expectedRevision),
    isNull(mediaGenerations.admissionToken),
    isNull(mediaGenerations.providerQueueId),
  )).returning({
    kind: mediaGenerations.kind,
    providerModel: mediaGenerations.providerModel,
    requestPayload: mediaGenerations.requestPayload,
  });
  if (!row) return null;
  return {
    ownerId: input.ownerId,
    roomId: input.roomId,
    namespaceId: input.namespaceId,
    receiptId: input.receiptId,
    revision: input.expectedRevision + 1,
    admissionToken,
    kind: row.kind,
    providerModel: row.providerModel,
    requestPayload: row.requestPayload,
    [mediaGenerationAdmissionProofBrand]: true,
  };
}

/** Persist provider acceptance only for the exact durable admission proof. */
export async function recordMediaGenerationAccepted(
  db: DirectDatabase,
  proof: MediaGenerationAdmissionProof,
  providerQueueId: string,
): Promise<MediaGeneration | null> {
  if (proof[mediaGenerationAdmissionProofBrand] !== true) {
    throw new Error("provider acceptance requires a DB-minted admission proof");
  }
  assertNonempty(providerQueueId, "providerQueueId");
  const now = new Date();
  const [row] = await db.update(mediaGenerations).set({
    state: "queued",
    providerQueueId,
    acceptedAt: now,
    revision: proof.revision + 1,
    updatedAt: now,
  }).where(and(
    scopeWhere(proof, proof.receiptId),
    eq(mediaGenerations.state, "admitting"),
    eq(mediaGenerations.revision, proof.revision),
    eq(mediaGenerations.admissionToken, proof.admissionToken),
    isNull(mediaGenerations.providerQueueId),
  )).returning();
  return row ?? null;
}

/**
 * Persist a deterministic provider refusal against the exact DB-minted
 * admission proof. The immutable proof remains on the terminal row for audit;
 * no provider body, topology, or queue coordinate is accepted here.
 */
export async function recordMediaGenerationAdmissionRefused(
  db: DirectDatabase,
  proof: MediaGenerationAdmissionProof,
  refusal: MediaGenerationAdmissionRefusal,
): Promise<MediaGeneration | null> {
  if (proof[mediaGenerationAdmissionProofBrand] !== true) {
    throw new Error("provider refusal requires a DB-minted admission proof");
  }
  assertDeterministicAdmissionRefusal(refusal);
  const now = new Date();
  const [row] = await db.update(mediaGenerations).set({
    state: refusal.state,
    safeFailure: refusal.safeFailure,
    terminalAt: now,
    revision: proof.revision + 1,
    claimOwner: null,
    claimExpiresAt: null,
    updatedAt: now,
  }).where(and(
    scopeWhere(proof, proof.receiptId),
    eq(mediaGenerations.state, "admitting"),
    eq(mediaGenerations.revision, proof.revision),
    eq(mediaGenerations.admissionToken, proof.admissionToken),
    isNull(mediaGenerations.providerQueueId),
  )).returning();
  return row ?? null;
}

/** Fence an indeterminate provider call; this state is never queue-claimable. */
export async function markMediaGenerationAdmissionUnknown(
  db: DirectDatabase,
  proof: MediaGenerationAdmissionProof,
  safeFailure: MediaGenerationSafeFailure,
): Promise<MediaGeneration | null> {
  if (proof[mediaGenerationAdmissionProofBrand] !== true) {
    throw new Error("unknown admission requires a DB-minted admission proof");
  }
  const now = new Date();
  const [row] = await db.update(mediaGenerations).set({
    state: "unknown",
    safeFailure,
    terminalAt: now,
    revision: proof.revision + 1,
    updatedAt: now,
  }).where(and(
    scopeWhere(proof, proof.receiptId),
    eq(mediaGenerations.state, "admitting"),
    eq(mediaGenerations.revision, proof.revision),
    eq(mediaGenerations.admissionToken, proof.admissionToken),
    isNull(mediaGenerations.providerQueueId),
  )).returning();
  return row ?? null;
}

/** Atomic legal lifecycle CAS. A stale or illegal transition returns null. */
export async function transitionMediaGeneration(
  db: DirectDatabase,
  input: MediaGenerationTransitionInput,
): Promise<MediaGeneration | null> {
  assertScope(input); assertNonempty(input.receiptId, "receiptId"); assertRevision(input.expectedRevision);
  if (!TRANSITIONS[input.from].includes(input.to)) throw new Error(`illegal media generation transition ${input.from} -> ${input.to}`);
  const now = new Date();
  const [row] = await db.update(mediaGenerations).set({
    state: input.to,
    revision: input.expectedRevision + 1,
    ...(input.safeFailure === undefined ? {} : { safeFailure: input.safeFailure }),
    ...(input.artifactInternalId === undefined ? {} : { artifactInternalId: input.artifactInternalId }),
    ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: assertSafeTimestamp(input.nextAttemptAt, "nextAttemptAt") }),
    ...(input.terminalAt === undefined ? {} : { terminalAt: input.terminalAt === null ? null : assertSafeTimestamp(input.terminalAt, "terminalAt") }),
    ...(input.to === "ready" ? { readyAt: now } : {}),
    claimOwner: null,
    claimExpiresAt: null,
    updatedAt: now,
  }).where(and(scopeWhere(input, input.receiptId), eq(mediaGenerations.state, input.from), eq(mediaGenerations.revision, input.expectedRevision))).returning();
  return row ?? null;
}

/** Mark provider cleanup complete only after an already-ready durable artifact. */
export async function completeMediaGenerationCleanup(
  db: DirectDatabase,
  input: MediaGenerationScope & { readonly receiptId: string; readonly expectedRevision: number },
): Promise<MediaGeneration | null> {
  assertScope(input); assertNonempty(input.receiptId, "receiptId"); assertRevision(input.expectedRevision);
  const now = new Date();
  const [row] = await db.update(mediaGenerations).set({ cleanupState: "completed", cleanupCompletedAt: now, revision: input.expectedRevision + 1, claimOwner: null, claimExpiresAt: null, updatedAt: now })
    .where(and(scopeWhere(input, input.receiptId), eq(mediaGenerations.state, "ready"), eq(mediaGenerations.cleanupState, "pending"), eq(mediaGenerations.revision, input.expectedRevision))).returning();
  return row ?? null;
}

/**
 * Internal restart-worker read. It intentionally excludes requestPayload and
 * safeSnapshot: worker resume needs durable provider/artifact coordinates,
 * not creative text or a public presentation projection.
 */
export async function readClaimedMediaGeneration(
  db: DirectDatabase,
  input: MediaGenerationScope & { readonly receiptId: string; readonly workerId: string },
): Promise<ClaimedMediaGeneration | null> {
  assertScope(input); assertNonempty(input.receiptId, "receiptId"); assertNonempty(input.workerId, "workerId");
  const now = new Date();
  const rows = await db.select(claimedMediaGenerationColumns).from(mediaGenerations).where(and(
    scopeWhere(input, input.receiptId),
    eq(mediaGenerations.claimOwner, input.workerId),
    gt(mediaGenerations.claimExpiresAt, now),
  )).limit(1);
  return rows[0] as ClaimedMediaGeneration | undefined ?? null;
}

/** Extend a live worker lease while preserving state and advancing its CAS revision. */
export async function renewMediaGenerationClaim(
  db: DirectDatabase,
  input: MediaGenerationScope & {
    readonly receiptId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly state: MediaGenerationState;
    readonly now: Date;
  },
): Promise<ClaimedMediaGeneration | null> {
  assertClaimInput(input);
  const now = assertSafeTimestamp(input.now, "claim renewal time");
  const expiresAt = new Date(now.getTime() + MEDIA_GENERATION_CLAIM_LEASE_MS);
  const [row] = await db.update(mediaGenerations).set({
    claimExpiresAt: expiresAt,
    revision: input.expectedRevision + 1,
    updatedAt: now,
  }).where(claimedWhere(input, now)).returning(claimedMediaGenerationColumns);
  return row as ClaimedMediaGeneration | undefined ?? null;
}

/**
 * Advance one claimed receipt while retaining its live lease through download,
 * staged persistence, and post-commit provider cleanup. Terminal outcomes
 * release the lease; ready retains it so `/complete` can be attempted before
 * another worker observes pending cleanup.
 */
export async function transitionClaimedMediaGeneration(
  db: DirectDatabase,
  input: MediaGenerationTransitionInput & { readonly workerId: string; readonly now: Date },
): Promise<ClaimedMediaGeneration | null> {
  const claimedInput = { ...input, state: input.from };
  assertClaimInput(claimedInput);
  if (!TRANSITIONS[input.from].includes(input.to)) throw new Error(`illegal media generation transition ${input.from} -> ${input.to}`);
  const now = assertSafeTimestamp(input.now, "claimed transition time");
  const retainsClaim = input.to === "retrieving" || input.to === "saving" || input.to === "ready";
  const [row] = await db.update(mediaGenerations).set({
    state: input.to,
    revision: input.expectedRevision + 1,
    ...(input.safeFailure === undefined ? {} : { safeFailure: input.safeFailure }),
    ...(input.artifactInternalId === undefined ? {} : { artifactInternalId: input.artifactInternalId }),
    ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: assertSafeTimestamp(input.nextAttemptAt, "nextAttemptAt") }),
    ...(input.terminalAt === undefined ? {} : { terminalAt: input.terminalAt === null ? null : assertSafeTimestamp(input.terminalAt, "terminalAt") }),
    ...(input.to === "ready" ? { readyAt: now } : {}),
    ...(retainsClaim ? {} : { claimOwner: null, claimExpiresAt: null }),
    updatedAt: now,
  }).where(claimedWhere(claimedInput, now)).returning(claimedMediaGenerationColumns);
  return row as ClaimedMediaGeneration | undefined ?? null;
}

/** Retry an accepted provider receipt without changing its lifecycle state. */
export async function rescheduleClaimedMediaGeneration(
  db: DirectDatabase,
  input: MediaGenerationScope & {
    readonly receiptId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly state: "queued" | "retrieving" | "saving";
    readonly safeFailure: MediaGenerationSafeFailure;
    /** Persist only sanitized whole-second provider timing; omitted values preserve earlier observations. */
    readonly processingTiming?: MediaGenerationProcessingTiming;
    readonly nextAttemptAt: Date;
    readonly now: Date;
  },
): Promise<boolean> {
  assertClaimInput(input);
  const now = assertSafeTimestamp(input.now, "reschedule time");
  const timing = input.processingTiming;
  if (timing?.elapsedSeconds !== undefined && !isPublicDurationSeconds(timing.elapsedSeconds)) {
    throw new Error("processing elapsedSeconds must be a bounded nonnegative integer");
  }
  if (timing?.estimatedSeconds !== undefined && !isPublicDurationSeconds(timing.estimatedSeconds)) {
    throw new Error("processing estimatedSeconds must be a bounded nonnegative integer");
  }
  const rows = await db.update(mediaGenerations).set({
    safeFailure: input.safeFailure,
    ...(timing?.elapsedSeconds === undefined ? {} : { providerExecutionSeconds: timing.elapsedSeconds }),
    ...(timing?.estimatedSeconds === undefined ? {} : { providerAverageExecutionSeconds: timing.estimatedSeconds }),
    nextAttemptAt: assertSafeTimestamp(input.nextAttemptAt, "nextAttemptAt"),
    revision: input.expectedRevision + 1,
    claimOwner: null,
    claimExpiresAt: null,
    updatedAt: now,
  }).where(claimedWhere(input, now)).returning({ id: mediaGenerations.id });
  return rows.length === 1;
}

/** Keep a locally-ready artifact playable while safely retrying provider cleanup. */
export async function rescheduleClaimedMediaGenerationCleanup(
  db: DirectDatabase,
  input: MediaGenerationScope & {
    readonly receiptId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly safeFailure: MediaGenerationSafeFailure;
    readonly nextAttemptAt: Date;
    readonly now: Date;
  },
): Promise<boolean> {
  const claimedInput = { ...input, state: "ready" as const };
  assertClaimInput(claimedInput);
  const now = assertSafeTimestamp(input.now, "cleanup reschedule time");
  const rows = await db.update(mediaGenerations).set({
    safeFailure: input.safeFailure,
    nextAttemptAt: assertSafeTimestamp(input.nextAttemptAt, "nextAttemptAt"),
    revision: input.expectedRevision + 1,
    claimOwner: null,
    claimExpiresAt: null,
    updatedAt: now,
  }).where(and(
    claimedWhere(claimedInput, now),
    eq(mediaGenerations.cleanupState, "pending"),
  )).returning({ id: mediaGenerations.id });
  return rows.length === 1;
}

/** Mark cleanup complete only while the worker still owns the ready receipt. */
export async function completeClaimedMediaGenerationCleanup(
  db: DirectDatabase,
  input: MediaGenerationScope & {
    readonly receiptId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly now: Date;
  },
): Promise<MediaGeneration | null> {
  const claimedInput = { ...input, state: "ready" as const };
  assertClaimInput(claimedInput);
  const now = assertSafeTimestamp(input.now, "cleanup completion time");
  const [row] = await db.update(mediaGenerations).set({
    cleanupState: "completed",
    cleanupCompletedAt: now,
    safeFailure: null,
    revision: input.expectedRevision + 1,
    claimOwner: null,
    claimExpiresAt: null,
    updatedAt: now,
  }).where(and(
    claimedWhere(claimedInput, now),
    eq(mediaGenerations.cleanupState, "pending"),
  )).returning();
  return row ?? null;
}

/**
 * Atomically claims due accepted work and ready cleanup. Claims do not expose
 * cross-owner rows to callers; each claimed item still needs an exact scoped
 * re-read before work begins.
 */
export async function claimDueMediaGenerations(
  db: DirectDatabase,
  input: { readonly workerId: string; readonly now: Date; readonly batch?: number },
): Promise<readonly ClaimedMediaGeneration[]> {
  assertNonempty(input.workerId, "workerId");
  const now = assertSafeTimestamp(input.now, "claim time");
  const batch = input.batch ?? 1;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > MEDIA_GENERATION_CLAIM_BATCH_MAX) throw new Error(`batch must be between 1 and ${MEDIA_GENERATION_CLAIM_BATCH_MAX}`);
  const expiresAt = new Date(now.getTime() + MEDIA_GENERATION_CLAIM_LEASE_MS);
  return db.transaction(async (tx) => {
    const candidates = await tx.select({ id: mediaGenerations.id }).from(mediaGenerations).where(and(
      // Account deletion nulls owner only after the accepted receipt is fully
      // terminal, so an anonymized row must never re-enter provider work.
      isNotNull(mediaGenerations.ownerId),
      or(inArray(mediaGenerations.state, MEDIA_GENERATION_RECONCILABLE_STATES), and(eq(mediaGenerations.state, "ready"), eq(mediaGenerations.cleanupState, "pending"))),
      lte(mediaGenerations.nextAttemptAt, now),
      or(isNull(mediaGenerations.claimExpiresAt), lte(mediaGenerations.claimExpiresAt, now)),
    )).orderBy(mediaGenerations.nextAttemptAt, mediaGenerations.createdAt).limit(batch).for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    const rows = await tx.update(mediaGenerations).set({
      claimOwner: input.workerId,
      claimExpiresAt: expiresAt,
      revision: sql`${mediaGenerations.revision} + 1`,
      updatedAt: now,
    })
      .where(inArray(mediaGenerations.id, candidates.map((candidate) => candidate.id)))
      .returning(claimedMediaGenerationColumns);
    return rows as ClaimedMediaGeneration[];
  });
}

/** Release a still-owned lease while retaining the same accepted provider receipt. */
export async function releaseMediaGenerationClaim(
  db: DirectDatabase,
  input: MediaGenerationScope & {
    readonly receiptId: string;
    readonly workerId: string;
    readonly expectedRevision: number;
    readonly nextAttemptAt: Date;
    readonly now: Date;
  },
): Promise<boolean> {
  assertScope(input); assertNonempty(input.receiptId, "receiptId"); assertNonempty(input.workerId, "workerId"); assertRevision(input.expectedRevision);
  const now = assertSafeTimestamp(input.now, "claim release time");
  const rows = await db.update(mediaGenerations).set({
    claimOwner: null,
    claimExpiresAt: null,
    nextAttemptAt: assertSafeTimestamp(input.nextAttemptAt, "nextAttemptAt"),
    revision: input.expectedRevision + 1,
    updatedAt: now,
  }).where(and(
    scopeWhere(input, input.receiptId),
    eq(mediaGenerations.claimOwner, input.workerId),
    eq(mediaGenerations.revision, input.expectedRevision),
    gt(mediaGenerations.claimExpiresAt, now),
  )).returning({ id: mediaGenerations.id });
  return rows.length === 1;
}

export const MEDIA_GENERATION_COMPLETION_WAKE_LEASE_MS = 60_000;

/** Claim ready-receipt completion wakes with a restart-safe, bounded lease. */
export async function claimDueMediaGenerationCompletionWakes(
  db: DirectDatabase,
  input: { readonly now: Date; readonly batch?: number },
): Promise<readonly ClaimedMediaGenerationCompletionWake[]> {
  const now = assertSafeTimestamp(input.now, "completion wake claim time");
  const batch = input.batch ?? 4;
  if (!Number.isSafeInteger(batch) || batch < 1 || batch > MEDIA_GENERATION_CLAIM_BATCH_MAX) {
    throw new Error(`batch must be between 1 and ${MEDIA_GENERATION_CLAIM_BATCH_MAX}`);
  }
  const staleBefore = new Date(now.getTime() - MEDIA_GENERATION_COMPLETION_WAKE_LEASE_MS);
  return db.transaction(async (tx) => {
    const candidates = await tx.select({ id: mediaGenerations.id }).from(mediaGenerations).where(and(
      eq(mediaGenerations.state, "ready"),
      isNull(mediaGenerations.completionWakeDeliveredAt),
      isNotNull(mediaGenerations.initiatingAgentId),
      isNotNull(mediaGenerations.initiatingThreadId),
      or(isNull(mediaGenerations.completionWakeClaimedAt), lte(mediaGenerations.completionWakeClaimedAt, staleBefore)),
    )).orderBy(mediaGenerations.readyAt, mediaGenerations.createdAt).limit(batch).for("update", { skipLocked: true });
    if (candidates.length === 0) return [];
    const rows = await tx.update(mediaGenerations).set({
      completionWakeClaimedAt: now,
      revision: sql`${mediaGenerations.revision} + 1`,
      updatedAt: now,
    }).where(inArray(mediaGenerations.id, candidates.map(({ id }) => id))).returning({
      receiptId: mediaGenerations.receiptId,
      ownerId: mediaGenerations.ownerId,
      roomId: mediaGenerations.roomId,
      namespaceId: mediaGenerations.namespaceId,
      revision: mediaGenerations.revision,
      kind: mediaGenerations.kind,
      initiatingAgentId: mediaGenerations.initiatingAgentId,
      initiatingThreadId: mediaGenerations.initiatingThreadId,
      claimedAt: mediaGenerations.completionWakeClaimedAt,
    });
    return rows.filter((row): row is ClaimedMediaGenerationCompletionWake =>
      row.initiatingAgentId !== null && row.initiatingThreadId !== null && row.claimedAt !== null);
  });
}

/** Mark a completion wake delivered only after the foreground job was accepted. */
export async function completeMediaGenerationCompletionWake(
  db: DirectDatabase,
  input: ClaimedMediaGenerationCompletionWake & { readonly now: Date },
): Promise<boolean> {
  const now = assertSafeTimestamp(input.now, "completion wake delivery time");
  const rows = await db.update(mediaGenerations).set({
    completionWakeDeliveredAt: now,
    revision: input.revision + 1,
    updatedAt: now,
  }).where(and(
    scopeWhere(input, input.receiptId),
    eq(mediaGenerations.state, "ready"),
    eq(mediaGenerations.revision, input.revision),
    eq(mediaGenerations.completionWakeClaimedAt, input.claimedAt),
    isNull(mediaGenerations.completionWakeDeliveredAt),
  )).returning({ id: mediaGenerations.id });
  return rows.length === 1;
}

/** Release a failed wake attempt so the next worker pass can retry immediately. */
export async function releaseMediaGenerationCompletionWake(
  db: DirectDatabase,
  input: ClaimedMediaGenerationCompletionWake & { readonly now: Date },
): Promise<boolean> {
  const now = assertSafeTimestamp(input.now, "completion wake release time");
  const rows = await db.update(mediaGenerations).set({
    completionWakeClaimedAt: null,
    revision: input.revision + 1,
    updatedAt: now,
  }).where(and(
    scopeWhere(input, input.receiptId),
    eq(mediaGenerations.state, "ready"),
    eq(mediaGenerations.revision, input.revision),
    eq(mediaGenerations.completionWakeClaimedAt, input.claimedAt),
    isNull(mediaGenerations.completionWakeDeliveredAt),
  )).returning({ id: mediaGenerations.id });
  return rows.length === 1;
}
