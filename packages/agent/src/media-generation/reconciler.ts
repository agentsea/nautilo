import type {
  ClaimedMediaGeneration,
  MediaGenerationSafeFailure,
  MediaGenerationScope,
  MediaGenerationState,
} from "@nautilo/db";
import {
  LOCKED_VENICE_MEDIA_MODEL_FACTS,
  VENICE_MEDIA_MODELS,
  mediaGenerationKindForModel,
  type VeniceMediaModel,
} from "./contracts";
import {
  MediaArtifactWriteError,
  writeStagedMediaArtifact,
  type CommittedMediaArtifactIdentity,
  type MediaArtifactIndexCommitter,
  type SupportedGeneratedMediaMimeType,
  type WrittenStagedMediaArtifact,
} from "./artifact-writer";
import {
  VeniceMediaLifecycleError,
  type VeniceAcceptedMediaWork,
  type VeniceArtifactCommitProof,
  type VeniceMediaLifecycleAdapter,
  type VeniceRetrieveResult,
} from "./venice-lifecycle";
import type { MediaGenerationFailure, MediaGenerationRecoveryAction } from "./errors";

const FIRST_WAVE_MODELS = new Set<string>(Object.values(VENICE_MEDIA_MODELS));
const DEFAULT_BATCH = 4;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_CLEANUP_RETRY_MS = 60_000;
const MAX_PUBLIC_DURATION_SECONDS = 2_147_483_647;

type ClaimState = "queued" | "retrieving" | "saving" | "ready";
type Claim = ClaimedMediaGeneration & { readonly state: ClaimState };

export interface MediaGenerationReconcilerRepository {
  claimDue(input: Readonly<{ workerId: string; now: Date; batch: number }>): Promise<readonly ClaimedMediaGeneration[]>;
  readClaimed(input: MediaGenerationScope & Readonly<{ receiptId: string; workerId: string }>): Promise<ClaimedMediaGeneration | null>;
  renew(input: MediaGenerationScope & Readonly<{
    receiptId: string;
    workerId: string;
    expectedRevision: number;
    state: MediaGenerationState;
    now: Date;
  }>): Promise<ClaimedMediaGeneration | null>;
  transition(input: MediaGenerationScope & Readonly<{
    receiptId: string;
    workerId: string;
    expectedRevision: number;
    from: ClaimState;
    to: "retrieving" | "saving" | "ready" | "needs_action" | "failed" | "unknown";
    now: Date;
    safeFailure?: MediaGenerationSafeFailure | null;
    artifactInternalId?: string;
    nextAttemptAt?: Date;
    terminalAt?: Date | null;
  }>): Promise<ClaimedMediaGeneration | null>;
  reschedule(input: MediaGenerationScope & Readonly<{
    receiptId: string;
    workerId: string;
    expectedRevision: number;
    state: "queued" | "retrieving" | "saving";
    safeFailure: MediaGenerationSafeFailure;
    processingTiming?: Readonly<{ elapsedSeconds?: number; estimatedSeconds?: number }>;
    nextAttemptAt: Date;
    now: Date;
  }>): Promise<boolean>;
  rescheduleCleanup(input: MediaGenerationScope & Readonly<{
    receiptId: string;
    workerId: string;
    expectedRevision: number;
    safeFailure: MediaGenerationSafeFailure;
    nextAttemptAt: Date;
    now: Date;
  }>): Promise<boolean>;
  completeCleanup(input: MediaGenerationScope & Readonly<{
    receiptId: string;
    workerId: string;
    expectedRevision: number;
    now: Date;
  }>): Promise<boolean>;
}

/**
 * The committer must be idempotent by receipt and attach the artifact only to
 * the exact claimed namespace. `findCommitted` is the restart seam after a
 * crash or lease loss between index commit and receipt CAS.
 */
export interface MediaGenerationArtifactCustody {
  committerFor(claim: Claim): MediaArtifactIndexCommitter;
  findCommitted(claim: Claim): Promise<CommittedMediaArtifactIdentity | null>;
}

export interface MediaGenerationReconcilerDependencies {
  readonly repository: MediaGenerationReconcilerRepository;
  readonly lifecycle: Pick<VeniceMediaLifecycleAdapter, "retrieve" | "complete">;
  readonly artifacts: MediaGenerationArtifactCustody;
  readonly serverArtifactRoot: string;
  readonly maxBytesFor: (claim: Claim) => number;
  readonly now?: () => Date;
  readonly retryDelayMs?: number;
  readonly cleanupRetryDelayMs?: number;
}

export type MediaGenerationReconcileSummary = Readonly<{
  claimed: number;
  completed: number;
  rescheduled: number;
  lostLease: number;
  terminal: number;
}>;

function scope(claim: ClaimedMediaGeneration): MediaGenerationScope {
  return { ownerId: claim.ownerId, roomId: claim.roomId, namespaceId: claim.namespaceId };
}

function isClaim(value: ClaimedMediaGeneration | null): value is Claim {
  return value !== null && (value.state === "queued" || value.state === "retrieving" ||
    value.state === "saving" || value.state === "ready");
}

function acceptedForFirstWave(claim: Claim): VeniceAcceptedMediaWork | null {
  if (!FIRST_WAVE_MODELS.has(claim.providerModel) || claim.providerQueueId === null) return null;
  const model = claim.providerModel as VeniceMediaModel;
  if (claim.kind !== mediaGenerationKindForModel(model)) return null;
  // These four public models retrieve bytes directly. Do not invent or retain
  // a signed-delivery URL; a JSON COMPLETED result therefore fails closed.
  return Object.freeze({
    receiptId: claim.receiptId,
    model,
    kind: claim.kind,
    providerQueueId: claim.providerQueueId,
  });
}

function outputMime(claim: Claim, contentType: string | null): SupportedGeneratedMediaMimeType | null {
  if (!FIRST_WAVE_MODELS.has(claim.providerModel)) return null;
  const expected = LOCKED_VENICE_MEDIA_MODEL_FACTS[claim.providerModel as VeniceMediaModel].outputMime;
  return contentType === expected ? expected : null;
}

function recoveryAction(action: MediaGenerationRecoveryAction): MediaGenerationSafeFailure["recoveryActions"][number] {
  switch (action) {
    case "revise_request": return "revise";
    case "switch_model": return "switch_model";
    case "repair_credentials":
    case "repair_billing":
    case "review_access":
    case "provider_consent":
    case "contact_support": return "repair_account";
    case "start_new_generation": return "start_fresh";
    case "refresh_catalog": return "revise";
    case "retry_admission":
    case "retry_retrieval":
    case "retry_download":
    case "retry_persistence":
    case "retry_cleanup":
    case "wait": return "retry_same_receipt";
  }
}

function safeFailure(failure: MediaGenerationFailure): MediaGenerationSafeFailure {
  return {
    code: failure.code,
    phase: failure.phase === "persistence" ? "save"
      : failure.phase === "admission" ? "queue"
        : failure.phase === "validation" ? "reconcile" : failure.phase,
    retrySafe: failure.retrySafe,
    stateChanged: failure.stateChanged,
    completionCertainty: failure.completionCertainty === "accepted" ? "accepted"
      : failure.completionCertainty === "unknown" ? "unknown"
        : failure.completionCertainty === "unavailable" ? "unknown" : "not_started",
    chargeCertainty: failure.chargeCertainty === "charged_or_committed" ? "charged" : failure.chargeCertainty,
    recoveryActions: [...new Set(failure.recoveryActions.map(recoveryAction))],
    ...(failure.creditsRefunded === undefined ? {} : { creditsRefunded: failure.creditsRefunded }),
  };
}

function operationalFailure(input: Readonly<{
  code: string;
  phase: "retrieve" | "download" | "save" | "cleanup" | "reconcile";
  retrySafe: boolean;
  recoveryActions: MediaGenerationSafeFailure["recoveryActions"];
}>): MediaGenerationSafeFailure {
  return {
    ...input,
    stateChanged: true,
    completionCertainty: "accepted",
    chargeCertainty: "charged",
  };
}

function terminalState(failure: MediaGenerationFailure): "needs_action" | "failed" | "unknown" {
  if (failure.completionCertainty === "unknown") return "unknown";
  if (failure.recoveryActions.some((action) => action === "repair_credentials" || action === "repair_billing" ||
    action === "review_access" || action === "provider_consent")) return "needs_action";
  return "failed";
}

function nextAttempt(now: Date, delayMs: number): Date {
  return new Date(now.getTime() + delayMs);
}

/**
 * Venice reports milliseconds. Persist only bounded whole seconds so a
 * malformed provider value cannot poison the durable public projection. Floor
 * rather than round upward: a displayed duration must never overstate the
 * provider's elapsed or typical-time evidence.
 */
function publicSeconds(milliseconds: number | undefined): number | undefined {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  const seconds = Math.floor(milliseconds / 1_000);
  return Number.isSafeInteger(seconds) && seconds <= MAX_PUBLIC_DURATION_SECONDS ? seconds : undefined;
}

function monotonicElapsedSeconds(previous: number | null, observed: number | undefined): number | undefined {
  if (observed === undefined) return undefined;
  return previous === null ? observed : Math.max(previous, observed);
}

function validIdentity(identity: CommittedMediaArtifactIdentity): boolean {
  return identity.artifactInternalId.trim() !== "" && identity.artifactId.trim() !== "" &&
    Number.isSafeInteger(identity.artifactRevision) && identity.artifactRevision >= 0;
}

/**
 * Restart-safe first-wave reconciler. It has no queue dependency by design:
 * accepted provider work can only be resumed under its existing receipt.
 */
export class MediaGenerationReconciler {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly cleanupRetryDelayMs: number;

  constructor(private readonly deps: MediaGenerationReconcilerDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_MS;
    this.cleanupRetryDelayMs = deps.cleanupRetryDelayMs ?? DEFAULT_CLEANUP_RETRY_MS;
  }

  async runOnce(input: Readonly<{ workerId: string; batch?: number }>): Promise<MediaGenerationReconcileSummary> {
    const counters = { claimed: 0, completed: 0, rescheduled: 0, lostLease: 0, terminal: 0 };
    const claims = await this.deps.repository.claimDue({
      workerId: input.workerId,
      now: this.now(),
      batch: input.batch ?? DEFAULT_BATCH,
    });
    counters.claimed = claims.length;
    for (const candidate of claims) {
      let outcome: "completed" | "rescheduled" | "lostLease" | "terminal";
      try {
        outcome = await this.process(candidate, input.workerId);
      } catch {
        // A malformed/failed receipt must not stall unrelated claimed work.
        // Do not expose the exception (it may originate in provider/storage
        // internals); leave this receipt fenced by its lease for later repair.
        outcome = "lostLease";
      }
      counters[outcome] += 1;
    }
    return counters;
  }

  private async reread(candidate: ClaimedMediaGeneration, workerId: string): Promise<Claim | null> {
    const current = await this.deps.repository.readClaimed({ ...scope(candidate), receiptId: candidate.receiptId, workerId });
    return isClaim(current) ? current : null;
  }

  private async renew(claim: Claim, workerId: string): Promise<Claim | null> {
    const renewed = await this.deps.repository.renew({
      ...scope(claim), receiptId: claim.receiptId, workerId,
      expectedRevision: claim.revision, state: claim.state, now: this.now(),
    });
    return isClaim(renewed) ? renewed : null;
  }

  private async transition(
    claim: Claim,
    workerId: string,
    to: "retrieving" | "saving" | "ready" | "needs_action" | "failed" | "unknown",
    extra: Readonly<{ safeFailure?: MediaGenerationSafeFailure; artifactInternalId?: string }> = {},
  ): Promise<ClaimedMediaGeneration | null> {
    return this.deps.repository.transition({
      ...scope(claim), receiptId: claim.receiptId, workerId,
      expectedRevision: claim.revision, from: claim.state, to, now: this.now(), ...extra,
      ...(to === "needs_action" || to === "failed" || to === "unknown" ? { terminalAt: this.now() } : {}),
    });
  }

  private async process(candidate: ClaimedMediaGeneration, workerId: string): Promise<"completed" | "rescheduled" | "lostLease" | "terminal"> {
    let claim = await this.reread(candidate, workerId);
    if (claim === null) return "lostLease";
    if (claim.state === "ready") return this.cleanup(claim, workerId);

    const accepted = acceptedForFirstWave(claim);
    if (accepted === null) {
      const failure = operationalFailure({
        code: "VENICE_ACCEPTED_RECEIPT_INVALID", phase: "reconcile", retrySafe: false,
        recoveryActions: ["repair_account"],
      });
      const terminal = await this.transition(claim, workerId, "needs_action", { safeFailure: failure });
      return terminal === null ? "lostLease" : "terminal";
    }

    if (claim.state === "queued") {
      const retrieving = await this.transition(claim, workerId, "retrieving");
      if (!isClaim(retrieving) || retrieving.state !== "retrieving") return "lostLease";
      claim = retrieving;
    }

    if (claim.state === "saving") {
      const recovered = await this.findCommitted(claim, workerId);
      if (recovered.outcome !== "none") return recovered.outcome;
      claim = recovered.claim;
    }

    const beforeRetrieve = await this.renew(claim, workerId);
    if (beforeRetrieve === null) return "lostLease";
    claim = beforeRetrieve;

    let retrieved: VeniceRetrieveResult;
    try {
      // The DB deliberately has no durable attempt counter. Use one fixed,
      // conservative capped cadence tier across restarts; claim revision is a
      // CAS token and must never be misrepresented as polling history.
      retrieved = await this.deps.lifecycle.retrieve({ accepted, attempt: 4 });
    } catch (error) {
      return this.handleFailure(claim, workerId, error);
    }

    const afterRetrieve = await this.renew(claim, workerId);
    if (afterRetrieve === null) return "lostLease";
    claim = afterRetrieve;

    if (retrieved.state === "processing") {
      if (claim.state === "ready") return "lostLease";
      const failure = operationalFailure({
        code: "VENICE_PROCESSING", phase: "retrieve", retrySafe: true,
        recoveryActions: ["retry_same_receipt"],
      });
      const elapsedSeconds = monotonicElapsedSeconds(
        claim.providerExecutionSeconds,
        publicSeconds(retrieved.executionDurationMs),
      );
      const estimatedSeconds = publicSeconds(retrieved.estimatedExecutionMs);
      const ok = await this.deps.repository.reschedule({
        ...scope(claim), receiptId: claim.receiptId, workerId,
        expectedRevision: claim.revision, state: claim.state, safeFailure: failure,
        processingTiming: {
          ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
          ...(estimatedSeconds === undefined ? {} : { estimatedSeconds }),
        },
        nextAttemptAt: retrieved.schedule.nextAttemptAt, now: this.now(),
      });
      return ok ? "rescheduled" : "lostLease";
    }

    // First-wave models must return bytes directly. The lifecycle cannot
    // produce signed_delivery without an accepted signed URL; if an injected
    // implementation does, fail closed and preserve the same receipt.
    if (retrieved.state === "signed_delivery") {
      const terminal = await this.transition(claim, workerId, "needs_action", { safeFailure: operationalFailure({
        code: "VENICE_SIGNED_DELIVERY_UNEXPECTED", phase: "download", retrySafe: false,
        recoveryActions: ["repair_account"],
      }) });
      return terminal === null ? "lostLease" : "terminal";
    }

    const mimeType = outputMime(claim, retrieved.contentType);
    if (mimeType === null) {
      await retrieved.body.cancel().catch(() => undefined);
      return this.reschedule(claim, workerId, operationalFailure({
        code: "VENICE_MEDIA_MIME_UNEXPECTED", phase: "save", retrySafe: true,
        recoveryActions: ["retry_same_receipt"],
      }));
    }

    if (claim.state !== "saving") {
      const saving = await this.transition(claim, workerId, "saving");
      if (!isClaim(saving) || saving.state !== "saving") return "lostLease";
      claim = saving;
    }
    return this.persist(claim, workerId, retrieved.body, mimeType);
  }

  private async findCommitted(claim: Claim, workerId: string): Promise<
    | { outcome: "none"; claim: Claim }
    | { outcome: "completed" | "rescheduled" | "lostLease" | "terminal" }
  > {
    let identity: CommittedMediaArtifactIdentity | null;
    try {
      identity = await this.deps.artifacts.findCommitted(claim);
    } catch {
      return { outcome: await this.reschedule(claim, workerId, operationalFailure({
        code: "MEDIA_ARTIFACT_INDEX_AMBIGUOUS", phase: "save", retrySafe: true,
        recoveryActions: ["retry_same_receipt"],
      })) };
    }
    if (identity === null) return { outcome: "none", claim };
    if (!validIdentity(identity)) {
      return { outcome: await this.reschedule(claim, workerId, operationalFailure({
        code: "MEDIA_ARTIFACT_INDEX_INVALID", phase: "save", retrySafe: false,
        recoveryActions: ["repair_account"],
      })) };
    }
    const ready = await this.transition(claim, workerId, "ready", { artifactInternalId: identity.artifactInternalId });
    if (!isClaim(ready) || ready.state !== "ready") return { outcome: "lostLease" };
    return { outcome: await this.cleanup(ready, workerId, identity) };
  }

  private async persist(
    claim: Claim,
    workerId: string,
    stream: ReadableStream<Uint8Array>,
    mimeType: SupportedGeneratedMediaMimeType,
  ): Promise<"completed" | "rescheduled" | "lostLease" | "terminal"> {
    const beforeWrite = await this.renew(claim, workerId);
    if (beforeWrite === null) return "lostLease";
    claim = beforeWrite;
    let written: WrittenStagedMediaArtifact;
    try {
      written = await writeStagedMediaArtifact({
        receiptId: claim.receiptId,
        mimeType,
        stream,
        serverArtifactRoot: this.deps.serverArtifactRoot,
        maxBytes: this.deps.maxBytesFor(claim),
        indexCommitter: this.deps.artifacts.committerFor(claim),
      });
    } catch (error) {
      const code = error instanceof MediaArtifactWriteError ? error.code : "MEDIA_ARTIFACT_STORAGE";
      return this.reschedule(claim, workerId, operationalFailure({
        code, phase: "save", retrySafe: true, recoveryActions: ["retry_same_receipt"],
      }));
    }
    const afterWrite = await this.renew(claim, workerId);
    if (afterWrite === null) return "lostLease";
    claim = afterWrite;
    const ready = await this.transition(claim, workerId, "ready", { artifactInternalId: written.artifactInternalId });
    if (!isClaim(ready) || ready.state !== "ready") return "lostLease";
    return this.cleanup(ready, workerId, written);
  }

  private async cleanup(
    claim: Claim,
    workerId: string,
    committed?: CommittedMediaArtifactIdentity | WrittenStagedMediaArtifact,
  ): Promise<"completed" | "rescheduled" | "lostLease" | "terminal"> {
    if (claim.state !== "ready") return "lostLease";
    if (claim.cleanupState === "completed") return "completed";
    const accepted = acceptedForFirstWave(claim);
    if (accepted === null || claim.artifactInternalId === null) {
      const ok = await this.deps.repository.rescheduleCleanup({
        ...scope(claim), receiptId: claim.receiptId, workerId, expectedRevision: claim.revision,
        safeFailure: operationalFailure({
          code: "VENICE_READY_RECEIPT_INVALID", phase: "cleanup", retrySafe: false,
          recoveryActions: ["repair_account"],
        }),
        nextAttemptAt: nextAttempt(this.now(), this.cleanupRetryDelayMs), now: this.now(),
      });
      return ok ? "rescheduled" : "lostLease";
    }

    let identity = committed;
    if (identity === undefined) {
      try {
        identity = await this.deps.artifacts.findCommitted(claim) ?? undefined;
      } catch {
        identity = undefined;
      }
    }
    if (identity === undefined || !validIdentity(identity) || identity.artifactInternalId !== claim.artifactInternalId) {
      const ok = await this.deps.repository.rescheduleCleanup({
        ...scope(claim), receiptId: claim.receiptId, workerId, expectedRevision: claim.revision,
        safeFailure: operationalFailure({
          code: "MEDIA_ARTIFACT_COMMIT_PROOF_UNAVAILABLE", phase: "cleanup", retrySafe: true,
          recoveryActions: ["retry_same_receipt"],
        }),
        nextAttemptAt: nextAttempt(this.now(), this.cleanupRetryDelayMs), now: this.now(),
      });
      return ok ? "rescheduled" : "lostLease";
    }
    const beforeCleanup = await this.renew(claim, workerId);
    if (beforeCleanup === null) return "lostLease";
    claim = beforeCleanup;
    const commitProof: VeniceArtifactCommitProof = {
      receiptId: claim.receiptId,
      artifactInternalId: identity.artifactInternalId,
      artifactRevision: identity.artifactRevision,
      state: "durably_committed",
    };
    try {
      await this.deps.lifecycle.complete({ accepted, commitProof });
    } catch (error) {
      const failure = error instanceof VeniceMediaLifecycleError
        ? safeFailure(error.failure)
        : operationalFailure({
          code: "VENICE_CLEANUP_RETRY", phase: "cleanup", retrySafe: true,
          recoveryActions: ["retry_same_receipt"],
        });
      const ok = await this.deps.repository.rescheduleCleanup({
        ...scope(claim), receiptId: claim.receiptId, workerId, expectedRevision: claim.revision,
        safeFailure: failure, nextAttemptAt: nextAttempt(this.now(), this.cleanupRetryDelayMs), now: this.now(),
      });
      return ok ? "rescheduled" : "lostLease";
    }
    const afterCleanup = await this.renew(claim, workerId);
    if (afterCleanup === null) return "lostLease";
    const completed = await this.deps.repository.completeCleanup({
      ...scope(afterCleanup), receiptId: afterCleanup.receiptId, workerId,
      expectedRevision: afterCleanup.revision, now: this.now(),
    });
    return completed ? "completed" : "lostLease";
  }

  private async handleFailure(
    claim: Claim,
    workerId: string,
    error: unknown,
  ): Promise<"completed" | "rescheduled" | "lostLease" | "terminal"> {
    if (!(error instanceof VeniceMediaLifecycleError)) {
      return this.reschedule(claim, workerId, operationalFailure({
        code: "VENICE_RETRIEVE_RETRY", phase: "retrieve", retrySafe: true,
        recoveryActions: ["retry_same_receipt"],
      }));
    }
    const failure = safeFailure(error.failure);
    if (error.failure.retrySafe && error.failure.completionCertainty === "accepted") {
      return this.reschedule(claim, workerId, failure);
    }
    const state = terminalState(error.failure);
    const terminal = await this.transition(claim, workerId, state, { safeFailure: failure });
    return terminal === null ? "lostLease" : "terminal";
  }

  private async reschedule(
    claim: Claim,
    workerId: string,
    failure: MediaGenerationSafeFailure,
  ): Promise<"rescheduled" | "lostLease"> {
    if (claim.state === "ready") {
      const ok = await this.deps.repository.rescheduleCleanup({
        ...scope(claim), receiptId: claim.receiptId, workerId, expectedRevision: claim.revision,
        safeFailure: failure, nextAttemptAt: nextAttempt(this.now(), this.cleanupRetryDelayMs), now: this.now(),
      });
      return ok ? "rescheduled" : "lostLease";
    }
    const ok = await this.deps.repository.reschedule({
      ...scope(claim), receiptId: claim.receiptId, workerId, expectedRevision: claim.revision,
      state: claim.state, safeFailure: failure,
      nextAttemptAt: nextAttempt(this.now(), this.retryDelayMs), now: this.now(),
    });
    return ok ? "rescheduled" : "lostLease";
  }
}
