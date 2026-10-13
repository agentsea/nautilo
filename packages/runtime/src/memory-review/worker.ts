import { MEMORY_REVIEW_AUTOMATIC_RETRY_CODES } from "@nautilo/types";
import type { BaseMessage } from "@langchain/core/messages";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { MemoryOperationBinding } from "@nautilo/types";
import {
  invokeChatModelWithFallback,
  MemoryReviewError,
  prepareMemoryReview,
  type MemoryReviewOptions,
  type MemoryReviewPreparation,
  type PreparedMemoryReview,
} from "@nautilo/agent";
import {
  BackgroundAttemptCancelledError,
  BackgroundAttemptUnavailableError,
  runBackgroundAttempt,
  type BackgroundAccessSession,
  type BackgroundAttemptIdentity,
  type BackgroundAttemptObservation,
} from "../background-processing/attempt";
import { runBackgroundModelInvocation } from "../background-processing/model-invocation";

/** Content-free durable claim; transcript bodies are loaded only after access. */
export interface MemoryReviewClaim {
  workId: string;
  attemptId: string;
  priorAttemptIds?: readonly string[];
  knownNonusableAttemptIds?: readonly string[];
  ownerId: string;
  actorId: string;
  agentId: string;
  roomId: string;
  threadId: string;
  scopeId: string | null;
  turnIds: string[];
  sourceIds: number[];
  leaseUntil: Date;
}

export interface MemoryReviewInput {
  messages: BaseMessage[];
  memoryAccessEnvelope: MemoryReviewOptions["memoryAccessEnvelope"];
  assistantName?: string;
  soulFile?: string;
  /** Undefined means at least one persisted model input lacks trusted complete evidence. */
  modelExposureDependencies?: readonly DurableModelExposureDependency[];
}

export interface AdmittedMemoryReviewModel {
  modelId: string;
  invokeModel: NonNullable<MemoryReviewOptions["invokeModel"]>;
  assertCurrent(): Promise<void>;
  onModelExposure?: NonNullable<MemoryReviewOptions["onModelExposure"]>;
  resolveMemoryExposureDependencies?: NonNullable<MemoryReviewOptions["resolveMemoryExposureDependencies"]>;
}

export type MemoryReviewPhase = "reconciliation" | "access" | "input" | "model" | "publication";
export type MemoryReviewPublicationState = "published" | "not_published" | "unknown";

function attemptFailureReason(error: unknown, phase: MemoryReviewPhase): string {
  if (error instanceof MemoryReviewError) return error.code;
  if (error instanceof BackgroundAttemptCancelledError) return "cancelled";
  if (error instanceof BackgroundAttemptUnavailableError) return "execution_unavailable";
  if (phase === "publication" || phase === "reconciliation") return "publication_uncertain";
  return phase === "model" ? "provider_failed" : "authority_or_source_unavailable";
}


function retryableMemoryFailure(reason: string): boolean {
  return (MEMORY_REVIEW_AUTOMATIC_RETRY_CODES as readonly string[]).includes(reason);
}

export interface MemoryReviewRepository {
  claimNext(input: { now: Date }): Promise<MemoryReviewClaim | null>;
  assertCurrent(claim: MemoryReviewClaim): Promise<void>;
  load(claim: MemoryReviewClaim): Promise<MemoryReviewInput>;
  modelReplaySafety?(claim: MemoryReviewClaim): Promise<"allow" | "block_unknown">;
  /** Freezes the first service model accepted for every coalesced turn. */
  getAcceptedModelOperation?(claim: MemoryReviewClaim): Promise<MemoryOperationBinding | null>;
  bindModelOperation?(claim: MemoryReviewClaim, resolve: (legacyServiceModelId?: string) => Promise<MemoryOperationBinding>): Promise<MemoryOperationBinding>;
  bindServiceModel?(claim: MemoryReviewClaim, resolveModelId: () => string): Promise<string>;
  /** Unknown outcome must remain non-executable until its durable receipt resolves. */
  reconcile(claim: MemoryReviewClaim): Promise<MemoryReviewPublicationState>;
  publish(input: {
    claim: MemoryReviewClaim;
    proposal: PreparedMemoryReview;
    modelId: string;
    now: Date;
    durationMs: number;
  }): Promise<MemoryReviewPublicationState>;
  fail(input: { claim: MemoryReviewClaim; phase: MemoryReviewPhase; reason: string; retryable: boolean; now: Date }): Promise<void>;
  /** Retries delivery only, never the model or committed Memory writes. */
  drainEffects(input: { now: Date }): Promise<void>;
}

export interface MemoryReviewWorkerDeps {
  repository: MemoryReviewRepository;
  /** Current enabled, maintenance and ordinary/protected availability admission. */
  checkAvailable(): Promise<boolean>;
  resolveModelId?(): string;
  /** Trusted personal/service admission seam; implementations must retain their own live fences. */
  admitModel?(claim: MemoryReviewClaim, input: MemoryReviewInput, assertCurrent: () => Promise<void>): Promise<AdmittedMemoryReviewModel | null>;
  openAccess?(identity: BackgroundAttemptIdentity, signal: AbortSignal, claim: MemoryReviewClaim): Promise<BackgroundAccessSession>;
  prepare?: typeof prepareMemoryReview;
  invokeModel?: NonNullable<MemoryReviewOptions["invokeModel"]>;
  observeAttempt?(observation: BackgroundAttemptObservation): void | Promise<void>;
  now?: () => Date;
  onError?(phase: "poll" | "effects", error: unknown): void;
}

/** One polling owner; the repository owns cadence, admission, retry and receipts. */
export class MemoryReviewWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = true;

  constructor(
    private readonly deps: MemoryReviewWorkerDeps,
    private readonly policy: { scanIntervalMs: number; shutdownWaitMs: number },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), this.policy.scanIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  /** Configuration changes and Retry wake the same coalesced normal polling path. */
  wake(): void {
    if (this.stopped || this.inFlight) return;
    const controller = new AbortController();
    this.controller = controller;
    const run = this.runOnce(controller.signal)
      .catch((error: unknown) => { this.reportError("poll", error); })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
        if (this.controller === controller) this.controller = null;
      });
    this.inFlight = run;
  }

  private now(): Date { return (this.deps.now ?? (() => new Date()))(); }

  private reportError(phase: "poll" | "effects", error: unknown): void {
    try { this.deps.onError?.(phase, error); } catch { /* diagnostics do not drive retry */ }
  }

  private async runOnce(signal: AbortSignal): Promise<void> {
    // Pause concerns new reviews, not delivery of already committed effects.
    try { await this.deps.repository.drainEffects({ now: this.now() }); }
    catch (error) { this.reportError("effects", error); }
    if (this.stopped || !(await this.deps.checkAvailable())) return;
    const claim = await this.deps.repository.claimNext({ now: this.now() });
    if (!claim) return;
    let phase: MemoryReviewPhase = "reconciliation";
    const startedAt = performance.now();
    try {
      const previous = await this.deps.repository.reconcile(claim);
      if (previous === "published") return;
      if (previous === "unknown") {
        await this.fail(claim, phase, "publication_uncertain", false);
        return;
      }
      phase = "access";
      await runBackgroundAttempt<BackgroundAttemptObservation["outcome"]>({
        identity: { family: "memory", stage: "review", workId: claim.workId, attemptId: claim.attemptId },
        signal,
        observe: (observation) => this.deps.observeAttempt?.(observation),
        checkAvailable: () => this.deps.checkAvailable(),
        openAccess: async (identity, accessSignal) => {
          const access = await this.deps.openAccess?.(identity, accessSignal, claim);
          return {
            assertCurrent: async () => {
              await this.deps.repository.assertCurrent(claim);
              await access?.assertCurrent();
            },
            close: async () => { await access?.close(); },
          };
        },
        classifyResult: (outcome) => outcome,
        run: async (context): Promise<BackgroundAttemptObservation["outcome"]> => {
          phase = "input";
          const input = await this.deps.repository.load(claim);
          await context.assertCurrent();
          if (await this.deps.repository.modelReplaySafety?.(claim) === "block_unknown") {
            await this.fail(claim, "model", "provider_outcome_unknown", false);
            return "failed";
          }
          phase = "model";
          const admittedByPort = this.deps.admitModel
            ? await this.deps.admitModel(claim, input, () => context.assertCurrent())
            : null;
          const admitted: AdmittedMemoryReviewModel = admittedByPort
            ?? await this.admitServiceModel(claim, () => context.assertCurrent());
          const invokeModel: NonNullable<MemoryReviewOptions["invokeModel"]> = async (invocation) => {
            await context.assertCurrent();
            await admitted.assertCurrent();
            return admitted.invokeModel(invocation);
          };
          const prepared: MemoryReviewPreparation = await (this.deps.prepare ?? prepareMemoryReview)(input.messages, {
            memoryAccessEnvelope: input.memoryAccessEnvelope,
            ...(input.assistantName === undefined ? {} : { assistantName: input.assistantName }),
            ...(input.soulFile === undefined ? {} : { soulFile: input.soulFile }),
            modelId: admitted.modelId,
            workId: claim.workId,
            attemptId: claim.attemptId,
            signal: context.signal,
            invokeModel,
            ...(input.modelExposureDependencies === undefined ? {} : { modelExposureDependencies: input.modelExposureDependencies }),
            ...(admitted.resolveMemoryExposureDependencies === undefined ? {} : { resolveMemoryExposureDependencies: admitted.resolveMemoryExposureDependencies }),
            onModelExposure: async (snapshots) => {
              await context.assertCurrent();
              await admitted.assertCurrent();
              await admitted.onModelExposure?.(snapshots);
            },
          });
          if (prepared.status === "failed") {
            await this.fail(claim, phase, prepared.reason, retryableMemoryFailure(prepared.reason));
            return prepared.reason === "cancelled" ? "cancelled"
              : prepared.reason === "memory_unavailable" || prepared.reason === "model_unavailable" ? "unavailable" : "failed";
          }
          phase = "publication";
          const published = await context.publish(async () => {
            await admitted.assertCurrent();
            return this.deps.repository.publish({
              claim,
              proposal: prepared.proposal,
              modelId: prepared.modelId,
              now: this.now(),
              durationMs: performance.now() - startedAt,
            });
          });
          if (published !== "published") {
            await this.fail(claim, phase, published === "unknown" ? "publication_uncertain" : "source_or_lease_changed", false);
            return published === "unknown" ? "failed" : "unavailable";
          }
          return "completed";
        },
      });
    } catch (error) {
      const reason = attemptFailureReason(error, phase);
      await this.fail(claim, phase, reason, retryableMemoryFailure(reason));
    }
    try { await this.deps.repository.drainEffects({ now: this.now() }); }
    catch (error) { this.reportError("effects", error); }
  }

  private fail(claim: MemoryReviewClaim, phase: MemoryReviewPhase, reason: string, retryable: boolean): Promise<void> {
    return this.deps.repository.fail({ claim, phase, reason, retryable, now: this.now() });
  }

  private async admitServiceModel(claim: MemoryReviewClaim, assertCurrent: () => Promise<void>) {
    const modelId = this.deps.repository.bindServiceModel
      ? await this.deps.repository.bindServiceModel(claim, () => this.resolveServiceModelId())
      : this.resolveServiceModelId();
    const invokeModel = this.createServiceInvoker(claim);
    return {
      modelId,
      invokeModel,
      assertCurrent: async () => {
        await assertCurrent();
        if (!(await this.deps.checkAvailable())) throw new BackgroundAttemptUnavailableError();
      },
    };
  }

  private resolveServiceModelId(): string {
    const resolved = this.deps.resolveModelId?.();
    if (!resolved) throw new MemoryReviewError("model_unavailable");
    return resolved;
  }

  private createServiceInvoker(claim: MemoryReviewClaim): NonNullable<MemoryReviewOptions["invokeModel"]> {
    return (input) => runBackgroundModelInvocation({
      usage: {
        callType: "memory_review", userId: null, roomId: claim.roomId,
        metadata: { workId: claim.workId, attemptId: claim.attemptId, agentId: claim.agentId },
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      invoke: async (signal) => {
        const invocation = { ...input, ...(signal === undefined ? {} : { signal }) };
        if (this.deps.invokeModel) return this.deps.invokeModel(invocation);
        const { response } = await invokeChatModelWithFallback(
          invocation.messages,
          invocation.tools,
          invocation.modelId,
          claim.ownerId,
          claim.agentId,
          `room:${claim.roomId}`,
          invocation.signal ? { signal: invocation.signal } : undefined,
          {
            serverFundedService: "shared_memory_maintenance",
            modelFallbackMode: "none",
            sameModelRetryMode: "none",
            useOpenAIResponsesApi: true,
            reasoningOutput: invocation.modelId.startsWith("openai:"),
          },
        );
        return response;
      },
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const active = this.inFlight;
    if (!active) return;
    const controller = this.controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([active, new Promise<void>((resolve) => {
        timeout = setTimeout(() => { controller?.abort(); resolve(); }, this.policy.shutdownWaitMs);
        timeout.unref?.();
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
}
