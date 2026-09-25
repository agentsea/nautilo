import type { ServerEvent, JobStatus } from "@nautilo/types";
import type { JobPublicationPolicy, PersistJobPayload } from "@nautilo/db";
import { runWithTurn, log } from "@nautilo/logger";
import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";
import {
  toFriendlyError,
  friendlyMessageWithCode,
  toGraphBudgetOutcome,
  toNoProgressOutcomeFromError,
  formatNoProgressLogToken,
  type FriendlyErrorCategory,
} from "@nautilo/agent";
import { eventBus } from "./event-bus";
import {
  isForegroundContextPreparationWaitingError,
} from "./conversation/foreground-context-preparation";
import { getCurrentLiveShadowTurnContext } from "./conversation/live-shadow-turn-context";
import type { FullEncryptionDurableJobInputReferenceV1 } from
  "./foreground-turn-lifecycle";
import {
  assertProtectedTaskJobReferenceV1,
  type ProtectedTaskJobReferenceV1,
} from "./tasks/protected-task-job-reference";

const FOREGROUND_CONTEXT_PREPARATION_FALLBACK_RETRY_WINDOW_MS = 30_000;
const FOREGROUND_CONTEXT_PREPARATION_RETRY_MAX_DELAY_MS = 1_000;
const FULL_JOB_CANCELLED_MESSAGE = "Protected operation cancelled";
const FULL_JOB_FAILED_MESSAGE = "Protected operation failed";
const FULL_JOB_PROTECTED_HISTORY_UNAVAILABLE_MESSAGE =
  "Encrypted history is not available for this turn yet";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type FullEncryptionDurableJobInputReference =
  | FullEncryptionDurableJobInputReferenceV1
  | ProtectedTaskJobReferenceV1;

function assertFullEncryptionDurableJobInputReference(
  value: FullEncryptionDurableJobInputReference,
): void {
  if (value.kind === "protected_task_run_v1") {
    assertProtectedTaskJobReferenceV1(value);
    return;
  }
  if (
    Object.keys(value).sort().join(",")
      !== "kind,operationId,policyRevision,roomId"
    || value.kind !== "full_encryption_foreground_operation_v1"
    || typeof value.operationId !== "string"
    || value.operationId.length < 1
    || !Number.isSafeInteger(value.policyRevision)
    || value.policyRevision < 1
    || !UUID.test(value.roomId)
  ) throw new TypeError("Full encryption durable Job reference is invalid");
}

async function waitForForegroundContextRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export type JobExecutor = (
  input: Record<string, unknown>,
  jobId: string,
  laneKey: string | null,
  signal: AbortSignal
) => AsyncGenerator<ServerEvent>;

export interface JobConfig {
  ownerId: string;
  requestorId: string;
  laneKey: string | null;
  type: "foreground" | "background";
  input: Record<string, unknown>;
  /** Trusted, ephemeral identity used only to reconcile room-scoped UI lifecycle. */
  lifecycleIdentity?: Readonly<{
    turnId: string;
    authorAgentId: string;
  }>;
  /** Full-only durable projection; `input` remains transient executor state. */
  durableInputReference?: FullEncryptionDurableJobInputReference;
  durableInputDisposition?: "full";
  /** Privacy-only sink policy for ephemeral work that has no durable input row. */
  ephemeralSinkDisposition?: "full";
  executor: JobExecutor;
  persist: (payload: PersistJobPayload) => Promise<string>;
  updateStatus: (
    jobId: string,
    status: JobStatus,
    fields?: { message?: string; result?: Record<string, unknown> },
    publicationPolicy?: JobPublicationPolicy,
  ) => Promise<void>;
}

export class Job {
  private _id: string | null = null;
  private _status: JobStatus = "queued";
  private abortController: AbortController | null = null;
  /** Persisted/emitted on cancellation, including planned server shutdown. */
  private cancellationMessage = "Cancelled by user";
  private cancellationCause: "cancelled" | "process_lost" = "cancelled";
  private config: JobConfig;

  constructor(config: JobConfig) {
    this.config = config;
  }

  private hasFullSinkDisposition(): boolean {
    return this.config.durableInputDisposition === "full"
      || this.config.ephemeralSinkDisposition === "full";
  }

  private lifecycleIdentity(): Readonly<{
    turnId?: string;
    authorAgentId?: string;
  }> {
    return this.config.lifecycleIdentity ?? {};
  }

  get id(): string {
    if (!this._id) throw new Error("Job not yet persisted");
    return this._id;
  }

  get status(): JobStatus {
    return this._status;
  }

  get type() {
    return this.config.type;
  }

  get laneKey() {
    return this.config.laneKey;
  }

  get input(): Record<string, unknown> {
    return this.config.input;
  }

  isRunning(): boolean {
    return this._status === "queued" || this._status === "running";
  }

  isTerminal(): boolean {
    return (
      this._status === "completed" ||
      this._status === "failed" ||
      this._status === "timed_out" ||
      this._status === "cancelled"
    );
  }

  async persist(): Promise<void> {
    if (
      (this.config.durableInputDisposition === "full")
        !== (this.config.durableInputReference !== undefined)
    ) throw new TypeError("Full encryption Job requires a trusted durable reference");
    if (this.config.durableInputReference !== undefined) {
      assertFullEncryptionDurableJobInputReference(
        this.config.durableInputReference,
      );
    }
    // M042B: extract roomId from input when present. Non-string /
    // absent values store NULL (guest, background, legacy callers).
    const durableInput = this.config.durableInputReference ?? this.config.input;
    const rawRoomId =
      this.config.durableInputReference?.kind === "full_encryption_foreground_operation_v1"
        ? this.config.durableInputReference.roomId
        : this.config.input["roomId"];
    const roomId = typeof rawRoomId === "string" && rawRoomId ? rawRoomId : null;

    this._id = await this.config.persist({
      ownerId: this.config.ownerId,
      requestorId: this.config.requestorId,
      laneKey: this.config.laneKey,
      roomId,
      type: this.config.type,
      input: durableInput,
      ...(this.config.durableInputReference === undefined
        ? {}
        : {
          publicationPolicy: {
            expectedRevision: this.config.durableInputReference.policyRevision,
            representation: "protected_only" as const,
          },
        }),
    });
  }

  async execute(authorizationSignal?: AbortSignal): Promise<void> {
    return this.executeWithInput(this.config.input, authorizationSignal);
  }

  /**
   * Execute one protected Task Job with content reconstructed inside its live
   * authorization callback. The durable/in-memory scheduling input remains
   * content-free; only the executor receives `input`.
   */
  async executeProtectedTask(
    input: Record<string, unknown>,
    authorizationSignal?: AbortSignal,
  ): Promise<void> {
    if (this.config.durableInputReference?.kind !== "protected_task_run_v1") {
      throw new TypeError("Protected Task execution requires its durable Job reference");
    }
    return this.executeWithInput(input, authorizationSignal);
  }

  private async executeWithInput(
    executorInput: Record<string, unknown>,
    authorizationSignal?: AbortSignal,
  ): Promise<void> {
    if (!this._id) throw new Error("Must call persist() before execute()");
    // A delayed foreground candidate must never revive a cancelled Job.
    if (this.isTerminal()) return;

    this.abortController = new AbortController();
    const protectedSession = getCurrentLiveShadowTurnContext()?.session;
    const failProtectedCancellation = () => protectedSession?.fail(
      "agent_input",
      authorizationSignal?.aborted === true ? "protected_unavailable" : this.cancellationCause,
    );
    this.abortController.signal.addEventListener("abort", failProtectedCancellation, { once: true });
    const cancelForAuthorization = () => {
      this.cancellationMessage =
        "Encryption authorization expired or changed. Please try again.";
      this.abortController?.abort();
    };
    authorizationSignal?.addEventListener(
      "abort",
      cancelForAuthorization,
      { once: true },
    );
    if (authorizationSignal?.aborted === true) cancelForAuthorization();

    try {
      await this.setStatus("running");

      // D082 PR B — safety-net AsyncLocalStorage rebind for any job
      // whose input carries a `turnId`. Today the only such caller is
      // the `/api/chat` route, which already wraps in `runWithTurn`
      // before `createForegroundJob(...)` — so the context inherits
      // through the fire-and-forget `void job.execute()` chain and
      // this wrap is technically redundant for that path. We keep it
      // explicitly for non-chat callers that might create foreground
      // jobs with a turnId but without their own wrap (future job
      // sources, internal tooling). Jobs without an inbound turnId
      // (legacy callers, background jobs) fall through unchanged.
      const turnIdRaw = executorInput["turnId"];
      const turnId =
        typeof turnIdRaw === "string" && turnIdRaw ? turnIdRaw : undefined;

      if (turnId) {
        await runWithTurn(turnId, () => this.runExecutor(executorInput));
      } else {
        await this.runExecutor(executorInput);
      }
    } finally {
      this.abortController.signal.removeEventListener("abort", failProtectedCancellation);
      authorizationSignal?.removeEventListener(
        "abort",
        cancelForAuthorization,
      );
    }
  }

  /**
   * Extracted from `execute()` so TypeScript keeps the non-null
   * narrowing on `this._id` and `this.abortController` without
   * losing it across a closure boundary — cleaner than sprinkling
   * `as string` / `as AbortController` casts.
   *
   * Precondition: `execute()` has already assigned `_id` (via
   * `persist()`) and `abortController` (via the `new` above).
   */
  private async runExecutor(executorInput: Record<string, unknown>): Promise<void> {
    const id = this._id;
    const abortController = this.abortController;
    if (!id || !abortController) {
      throw new Error("runExecutor called without id / abortController");
    }

    try {
      let waitingSince: number | null = null;
      let retryCount = 0;
      let contextPreparationNoticeVisible = false;
      const setContextPreparationNotice = (visible: boolean): void => {
        if (contextPreparationNoticeVisible === visible) return;
        contextPreparationNoticeVisible = visible;
        eventBus.emit({
          type: "job.progress",
          kind: "foreground-context",
          jobId: id,
          phase: "Preparing encrypted context",
          detail: visible ? "waiting" : "ready",
          ...(this.config.laneKey ? { laneKey: this.config.laneKey } : {}),
        });
      };
      while (true) {
        try {
          abortController.signal.throwIfAborted();
          const events = this.config.executor(
            executorInput,
            id,
            this.config.laneKey,
            abortController.signal,
          );

          for await (const event of events) {
            if (this._status === "cancelled") return;
            setContextPreparationNotice(false);
            // Protected Task provider/model output must enter its protected
            // result publisher. Generic executor events are not a reviewed
            // content sink, so this foundation drops them fail-closed.
            if (this.config.durableInputReference?.kind !== "protected_task_run_v1") {
              eventBus.emit(event);
            }
          }
          setContextPreparationNotice(false);
          break;
        } catch (error) {
          if (!isForegroundContextPreparationWaitingError(error)) throw error;
          const now = Date.now();
          waitingSince ??= now;
          const retryDeadline = error.authorizationDeadlineAt
            ?? waitingSince
              + FOREGROUND_CONTEXT_PREPARATION_FALLBACK_RETRY_WINDOW_MS;
          if (
            abortController.signal.aborted
            || now >= retryDeadline
          ) throw error.enforcement;
          setContextPreparationNotice(true);
          retryCount += 1;
          const delayMs = Math.min(
            100 * 2 ** Math.min(retryCount - 1, 4),
            FOREGROUND_CONTEXT_PREPARATION_RETRY_MAX_DELAY_MS,
          );
          await waitForForegroundContextRetry(
            delayMs,
            abortController.signal,
          );
        }
      }

      if (this._status === "cancelled") return;
      await this.setStatus("completed");
    } catch (err) {
      if (abortController.signal.aborted || this._status === "cancelled") {
        await this.setStatus("cancelled", { message: this.cancellationMessage });
        return;
      }

      // D141 Phase 1 — translate at the single user-facing chokepoint.
      // Every agent-thrown error funnels through this catch on its way
      // to the `job.status: failed` ServerEvent. Previously `err.message`
      // was forwarded verbatim, so raw upstream-provider blobs (e.g.
      // Google JSON-RPC `tools[0].function_declarations[…]` schema dumps)
      // leaked into the chat bubble. The friendly translator collapses
      // any error shape into one of seven user-visible categories with a
      // one-line human sentence; the friendly sentence + stable category
      // are safe to ride on the room-scoped event because they contain
      // zero echoed user content.
      //
      // PRIVACY: the raw `formatProviderError` blob is deliberately NOT
      // emitted on the WS event. `job.status` is routed by `laneKey`
      // ("room:<uuid>") and broadcast to every member of a multi-user
      // room; upstream provider `error.message` can echo prompt content
      // or model output and would cross-user-leak. The raw blob lives
      // in `server.log` (a) via `formatProviderError` at
      // `chat-model-invocation.ts:219` and (b) via the `[nautilo/job]`
      // line below. A future user-scoped error-details event (Stack 17
      // / D141-P3) can carry the blob to the request originator only.
      // See ISSUE-D141 §"Locked Decisions" LD-8.
      // ISSUE-D141 §LD-9 — stable MDL00x code rides on the
      // user-visible message (bracket-suffix) and as a structured
      // `code=` token on the server-log line. The code is the shared
      // vocabulary token bridging chat (`"... [MDL003]"`) ↔ server.log
      // (`rg "MDL003"`) ↔ issue titles / chat transcripts. No new
      // wire-protocol field on `JobStatusEvent` — the bracket lives
      // inside `message` so the workbench renderer needs zero change.
      await this.fail(err);
    }
  }

  /** Terminalize a persisted Job when an opaque pre-executor candidate fails. */
  async fail(err: unknown): Promise<void> {
    if (this.isTerminal()) return;
    const friendly = toFriendlyError(err);
      // Stack 208 P0 — surface the typed internal graph-budget outcome distinctly
      // in telemetry (R9). `toFriendlyError` already produced the user-safe
      // sentence (graph-budget-specific, category `unknown` / `MDL007` so the
      // closed `JobStatusEvent.errorCategory` union in `@nautilo/types` is
      // untouched). Here we emit a structured `outcome=graph_budget_exceeded`
      // token on the server-log line so `rg "graph_budget_exceeded"` bridges
      // to the specific framework failure; the raw `detailsForLog` blob
      // (LangGraph troubleshooting URL + literal limit) rides the same line.
    const budgetOutcome = toGraphBudgetOutcome(err);
      // Stack 208 P2 — surface the no-progress breaker's typed outcome
      // distinctly in telemetry (R9). `toFriendlyError` already produced the
      // user-safe no-progress sentence (category `unknown` / `MDL007` so the
      // closed WS union is untouched). Here we emit a structured
      // `outcome=no_progress` token + sanitized tool/operation labels on the
      // server-log line so `rg "no_progress"` bridges to the failure. The
      // normalized error is deliberately excluded because it may contain
      // paths, user content, or secrets. The breaker threw `NoProgressError` at the
      // tools→pre_model seam; this is the single runtime catch site that
      // maps it.
    const noProgressOutcome = toNoProgressOutcomeFromError(err);
    log(this.hasFullSinkDisposition()
      ? `[nautilo/job] ${this.id} failed (code=${friendly.code} category=${friendly.category})`
      : `[nautilo/job] ${this.id} failed ` +
        `(code=${friendly.code} category=${friendly.category}` +
        `${budgetOutcome ? ` outcome=${budgetOutcome.kind} recursionLimit=${budgetOutcome.recursionLimit}` : ""}` +
        `${noProgressOutcome ? ` outcome=${noProgressOutcome.kind} ${formatNoProgressLogToken(noProgressOutcome)}` : ""}): ${friendly.detailsForLog}`);
    await this.setStatus("failed", {
      message: this.hasFullSinkDisposition()
        ? err instanceof StrictShadowEnforcementError
            && err.decision.reason === "missing_protected_sibling"
          ? `${FULL_JOB_PROTECTED_HISTORY_UNAVAILABLE_MESSAGE} [MDL007]`
          : `${FULL_JOB_FAILED_MESSAGE} [${friendly.code}]`
        : friendlyMessageWithCode(friendly),
      errorCategory: friendly.category,
    });
  }

  private cancellationPersistencePending = false;

  async cancel(
    message = "Cancelled by user",
    cause: "cancelled" | "process_lost" = "cancelled",
  ): Promise<void> {
    if (this.isTerminal() && !this.cancellationPersistencePending) return;
    this.cancellationPersistencePending = true;
    this.cancellationCause = cause;
    const visibleMessage = this.hasFullSinkDisposition()
      ? FULL_JOB_CANCELLED_MESSAGE
      : message;
    this.cancellationMessage = visibleMessage;

    if (!this.abortController) {
      await this.setStatus("cancelled", {
        message: visibleMessage,
      });
      this.cancellationPersistencePending = false;
      return;
    }

    this._status = "cancelled";
    this.abortController.abort();
    await this.config.updateStatus(
      this.id,
      "cancelled",
      this.config.durableInputReference === undefined
        ? { message: visibleMessage }
        : undefined,
      this.publicationPolicy(),
    );
    this.cancellationPersistencePending = false;
    eventBus.emit({
      type: "job.status",
      jobId: this.id,
      status: "cancelled",
      message: visibleMessage,
      ...this.lifecycleIdentity(),
      ...(this.config.laneKey ? { laneKey: this.config.laneKey } : {}),
    });
  }

  private async setStatus(
    status: JobStatus,
    fields?: {
      message?: string;
      result?: Record<string, unknown>;
      /**
       * D141 Phase 1 — stable error-category tag for workbench renderer
       * styling. WS-event-only (not persisted). Zero user content;
       * safe to room-broadcast.
       */
      errorCategory?: FriendlyErrorCategory;
    }
  ): Promise<void> {
    this._status = status;
    // Persistence keeps the existing two-field shape (message + result).
    // `errorCategory` is WS-event-only so the DB schema does not change
    // in P1. P3 may add audit-log columns if needed.
    const persistFields = this.config.durableInputReference !== undefined
      ? undefined
      : fields
      ? (() => {
          const out: { message?: string; result?: Record<string, unknown> } = {};
          if (fields.message !== undefined) out.message = fields.message;
          if (fields.result !== undefined) out.result = fields.result;
          return out;
        })()
      : undefined;
    await this.config.updateStatus(
      this.id,
      status,
      persistFields,
      this.publicationPolicy(),
    );
    eventBus.emit({
      type: "job.status",
      jobId: this.id,
      status,
      message: fields?.message,
      ...this.lifecycleIdentity(),
      ...(fields?.errorCategory !== undefined
        ? { errorCategory: fields.errorCategory }
        : {}),
      ...(this.config.laneKey ? { laneKey: this.config.laneKey } : {}),
    });
  }

  private publicationPolicy(): JobPublicationPolicy | undefined {
    return this.config.durableInputReference === undefined
      ? undefined
      : {
        expectedRevision: this.config.durableInputReference.policyRevision,
        representation: "protected_only",
      };
  }
}
