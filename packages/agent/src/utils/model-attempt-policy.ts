import { modelSupportsFeature } from "@nautilo/model-capabilities";

/**
 * D563 — the policy resolved for one *actual* provider attempt.  The numbers
 * below intentionally retain the legacy behaviour for this migration stage;
 * they are not model-catalog authority.
 */
export const TEMPORARY_LEGACY_FIRST_PROGRESS_MS = 60_000;
export const TEMPORARY_LEGACY_REASONING_FIRST_PROGRESS_MS = 180_000;

export type ModelAttemptPolicyProvenance = Readonly<{
  kind: "temporary_legacy" | "caller_override";
  id: string;
  version: string;
}>;

export interface ResolvedModelAttemptPolicy {
  /** Unique for every actual `model.invoke`, including same-model retries. */
  readonly attemptId: string;
  readonly modelId: string;
  readonly firstProgressMs: number;
  readonly progressIdleMs: number;
  readonly absoluteMs?: number;
  /** Field-level provenance is required while a caller overrides only absoluteMs. */
  readonly provenance: Readonly<{
    firstProgress: ModelAttemptPolicyProvenance;
    progressIdle: ModelAttemptPolicyProvenance;
    /** Absent when the attempt deliberately has no wall-clock deadline. */
    absolute?: ModelAttemptPolicyProvenance;
  }>;
}

let nextAttemptSequence = 0;

/**
 * This is intentionally process-local rather than a user-visible identifier.
 * The only contract is that a late stream event from one `model.invoke` can
 * never be mistaken for the next, including a same-model retry.
 */
export function createModelAttemptId(): string {
  nextAttemptSequence += 1;
  return `model-attempt-${Date.now().toString(36)}-${nextAttemptSequence.toString(36)}`;
}

export function resolveModelAttemptPolicy(
  modelId: string,
  options: {
    readonly providerTimeoutMs?: number;
    readonly callerSuppliedProviderTimeout?: boolean;
    /** Caller workload policy; changes initial silence only, not the idle timer. */
    readonly firstProgressTimeoutMs?: number;
    /** Internal deterministic-test seam; retains temporary-legacy provenance. */
    readonly firstProgressMsOverride?: number;
    readonly attemptId?: string;
  } = {},
): ResolvedModelAttemptPolicy {
  const supportsReasoning = modelSupportsFeature(modelId, "reasoning");
  const catalogProgressMs = supportsReasoning
    ? TEMPORARY_LEGACY_REASONING_FIRST_PROGRESS_MS
    : TEMPORARY_LEGACY_FIRST_PROGRESS_MS;
  const progressMs = options.firstProgressMsOverride ?? catalogProgressMs;
  const hasCallerAbsolute = options.callerSuppliedProviderTimeout === true && options.providerTimeoutMs !== undefined;
  const absoluteMs = hasCallerAbsolute ? options.providerTimeoutMs : undefined;
  const temporary = Object.freeze({ kind: "temporary_legacy" as const, id: "D264/D331", version: "2026-08" });
  const absolute = hasCallerAbsolute
    ? { kind: "caller_override" as const, id: "invoke_options.providerTimeoutMs", version: "1" }
    : undefined;
  return Object.freeze({
    attemptId: options.attemptId ?? createModelAttemptId(),
    modelId,
    firstProgressMs: options.firstProgressTimeoutMs ?? progressMs,
    progressIdleMs: progressMs,
    ...(absoluteMs === undefined ? {} : { absoluteMs }),
    provenance: Object.freeze({
      firstProgress: options.firstProgressTimeoutMs === undefined ? temporary
        : Object.freeze({ kind: "caller_override" as const, id: "invoke_options.firstProgressTimeoutMs", version: "1" }),
      progressIdle: temporary,
      ...(absolute ? { absolute: Object.freeze(absolute) } : {}),
    }),
  });
}

export type ModelAttemptTimeoutKind =
  | "first_progress_timeout"
  | "progress_idle_timeout"
  | "absolute_timeout";

export type ModelAttemptTerminalOutcome =
  | Readonly<{ kind: "completed" }>
  | Readonly<{ kind: "parent_aborted" }>
  | Readonly<{
      kind: "timeout";
      timeoutKind: ModelAttemptTimeoutKind;
      elapsedMs: number;
      visibleOutput: boolean;
      partialState: boolean;
      abortRequested: true;
      safeToFallback: boolean;
    }>;

export interface ModelAttemptProgressSink {
  readonly attemptId: string;
  reportMeaningfulProgress(attemptId: string): boolean;
}

export interface ModelAttemptSupervisorOptions {
  readonly parentSignal?: AbortSignal;
  readonly now?: () => number;
  readonly isVisibleOutput?: () => boolean;
  readonly onTimeout: (outcome: Extract<ModelAttemptTerminalOutcome, { kind: "timeout" }>) => Error;
}

/**
 * The sole foreground model-attempt timer owner. Runtime supplies semantic
 * observations through the attempt-bound sink; it does not own a clock,
 * abort controller, or terminal path.
 */
export class ModelAttemptSupervisor implements ModelAttemptProgressSink {
  readonly attemptId: string;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly isVisibleOutput: () => boolean;
  private readonly parentSignal: AbortSignal | undefined;
  private readonly onParentAbort: (() => void) | undefined;
  private startedAt: number | null = null;
  private sawMeaningfulProgress = false;
  private settled = false;
  private firstProgressTimer: ReturnType<typeof setTimeout> | undefined;
  private progressIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private absoluteTimer: ReturnType<typeof setTimeout> | undefined;
  private terminalOutcome: ModelAttemptTerminalOutcome | undefined;
  private terminalReject: ((error: Error) => void) | undefined;

  constructor(
    readonly policy: ResolvedModelAttemptPolicy,
    private readonly options: ModelAttemptSupervisorOptions,
  ) {
    this.attemptId = policy.attemptId;
    this.signal = this.controller.signal;
    this.now = options.now ?? (() => Date.now());
    this.isVisibleOutput = options.isVisibleOutput ?? (() => false);
    this.parentSignal = options.parentSignal;
    if (this.parentSignal) {
      this.onParentAbort = () => {
        // Settle the parent-cancellation outcome before aborting the provider.
        // A cooperative provider may reject synchronously from its abort
        // listener; cancellation must win that race just as a typed timeout
        // does in timeout(), below.
        this.finish({ kind: "parent_aborted" });
        this.controller.abort(this.parentSignal?.reason);
      };
      if (this.parentSignal.aborted) this.onParentAbort();
      else this.parentSignal.addEventListener("abort", this.onParentAbort, { once: true });
    }
  }

  start(): void {
    if (this.settled || this.startedAt !== null) return;
    this.startedAt = this.now();
    this.firstProgressTimer = setTimeout(
      () => this.timeout("first_progress_timeout"),
      this.policy.firstProgressMs,
    );
    if (this.policy.absoluteMs !== undefined) {
      this.absoluteTimer = setTimeout(
        () => this.timeout("absolute_timeout"),
        this.policy.absoluteMs,
      );
    }
  }

  reportMeaningfulProgress(attemptId: string): boolean {
    if (this.settled || attemptId !== this.attemptId) return false;
    if (!this.sawMeaningfulProgress) {
      this.sawMeaningfulProgress = true;
      if (this.firstProgressTimer) clearTimeout(this.firstProgressTimer);
      this.firstProgressTimer = undefined;
    }
    if (this.progressIdleTimer) clearTimeout(this.progressIdleTimer);
    this.progressIdleTimer = setTimeout(
      () => this.timeout("progress_idle_timeout"),
      this.policy.progressIdleMs,
    );
    return true;
  }

  async race<T>(work: Promise<T>): Promise<T> {
    this.start();
    const terminal = new Promise<never>((_, reject) => {
      const terminalError = this.terminalOutcome === undefined
        ? undefined
        : this.errorForTerminalOutcome(this.terminalOutcome);
      if (terminalError) reject(terminalError);
      else this.terminalReject = reject;
    });
    try {
      return await Promise.race([work, terminal]);
    } finally {
      this.finish({ kind: "completed" });
    }
  }

  dispose(): void {
    this.finish({ kind: "completed" });
  }

  private timeout(timeoutKind: ModelAttemptTimeoutKind): void {
    if (this.settled || this.startedAt === null) return;
    const visibleOutput = this.isVisibleOutput();
    // Settle the typed terminal first. A cooperative provider may reject
    // synchronously in its abort listener; resolving first guarantees callers
    // observe the structured timeout rather than a raw AbortError race.
    this.finish({
      kind: "timeout",
      timeoutKind,
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      visibleOutput,
      partialState: this.sawMeaningfulProgress,
      abortRequested: true,
      safeToFallback: !visibleOutput,
    });
    this.controller.abort();
  }

  private finish(outcome: ModelAttemptTerminalOutcome): void {
    if (this.settled) return;
    this.settled = true;
    if (this.firstProgressTimer) clearTimeout(this.firstProgressTimer);
    if (this.progressIdleTimer) clearTimeout(this.progressIdleTimer);
    if (this.absoluteTimer) clearTimeout(this.absoluteTimer);
    this.firstProgressTimer = undefined;
    this.progressIdleTimer = undefined;
    this.absoluteTimer = undefined;
    if (this.parentSignal && this.onParentAbort) this.parentSignal.removeEventListener("abort", this.onParentAbort);
    this.terminalOutcome = outcome;
    const terminalError = this.errorForTerminalOutcome(outcome);
    if (terminalError) this.terminalReject?.(terminalError);
  }

  private errorForTerminalOutcome(outcome: ModelAttemptTerminalOutcome): Error | undefined {
    if (outcome.kind === "completed") return undefined;
    if (outcome.kind === "timeout") return this.options.onTimeout(outcome);
    // Preserve parent cancellation as cancellation rather than reclassifying
    // it as a provider timeout. This also releases a non-cooperative model
    // promise that ignores AbortSignal.
    return this.parentSignal?.reason instanceof Error
      ? this.parentSignal.reason
      : new Error("Model attempt aborted by parent signal");
  }
}

export interface ModelStreamProgress {
  readonly meaningful: boolean;
  /** Present only when the chunk contained an output-token counter. */
  readonly outputTokens?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function contentHasMeaningfulProgress(content: unknown): boolean {
  if (nonEmpty(content)) return true;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const p = record(part);
    return !!p && (nonEmpty(p["text"]) || nonEmpty(p["content"]) || nonEmpty(p["reasoning_content"]) || nonEmpty(p["thinking"]));
  });
}

function toolDeltaHasMeaningfulProgress(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const e = record(entry);
    return !!e && (nonEmpty(e["name"]) || nonEmpty(e["args"]) || nonEmpty(e["arguments"]));
  });
}

function outputTokensFrom(chunk: Record<string, unknown>): number | undefined {
  const metadata = record(chunk["usage_metadata"]) ?? record(chunk["response_metadata"]);
  if (!metadata) return undefined;
  const output = metadata["output_tokens"] ?? metadata["completion_tokens"] ?? metadata["generated_tokens"];
  return typeof output === "number" && Number.isFinite(output) && output >= 0 ? output : undefined;
}

function reasoningHasMeaningfulProgress(value: Record<string, unknown> | undefined): boolean {
  if (!value) return false;
  if (nonEmpty(value["reasoning_content"]) || nonEmpty(value["reasoning"]) || nonEmpty(value["thinking"])) return true;
  const details = value["reasoning_details"];
  return Array.isArray(details) && details.some((item) => {
    const detail = record(item);
    if (!detail) return false;
    if (detail["type"] === "reasoning.text") return nonEmpty(detail["text"]);
    if (detail["type"] === "reasoning.summary") return nonEmpty(detail["summary"]);
    return detail["type"] === "reasoning.encrypted" && nonEmpty(detail["data"]) && detail["data"] !== "[REDACTED]";
  });
}

/**
 * Normalize provider/LangChain stream shapes into one deliberately narrow
 * definition of progress. Empty chunks, pings, repeated tool metadata, and
 * unchanged usage counters do not keep a model attempt alive.
 */
export function classifyModelStreamProgress(event: unknown, outputTokensHighWaterMark?: number): ModelStreamProgress {
  const eventRecord = record(event);
  const data = record(eventRecord?.["data"]);
  const rawChunk = data?.["chunk"];
  if (nonEmpty(rawChunk)) return { meaningful: true };
  const chunk = record(rawChunk);
  if (!chunk) return { meaningful: false };

  const delta = record(chunk["delta"]);
  const outputTokens = outputTokensFrom(chunk);
  const usageAdvanced = outputTokens !== undefined && outputTokens > (outputTokensHighWaterMark ?? 0);
  const meaningful =
    contentHasMeaningfulProgress(chunk["content"]) ||
    contentHasMeaningfulProgress(delta?.["content"]) ||
    reasoningHasMeaningfulProgress(chunk) ||
    reasoningHasMeaningfulProgress(delta) ||
    reasoningHasMeaningfulProgress(record(chunk["additional_kwargs"])) ||
    reasoningHasMeaningfulProgress(record(delta?.["additional_kwargs"])) ||
    // `tool_calls` is often a repeated aggregate. Only LangChain's streaming
    // `tool_call_chunks` is a delta without an additional fingerprint ledger.
    toolDeltaHasMeaningfulProgress(chunk["tool_call_chunks"]) ||
    toolDeltaHasMeaningfulProgress(delta?.["tool_call_chunks"]) ||
    usageAdvanced;
  return outputTokens === undefined ? { meaningful } : { meaningful, outputTokens };
}

/** Extract the exact attempted model from the event metadata, otherwise use the legacy caller context. */
export function modelIdFromStreamEvent(event: unknown, legacyModelId: string): string {
  const ev = record(event);
  const data = record(ev?.["data"]);
  const candidates = [
    record(ev?.["metadata"]),
    record(data?.["metadata"]),
    ev,
  ];
  for (const candidate of candidates) {
    const modelId = candidate?.["model_id"] ?? candidate?.["modelId"];
    if (typeof modelId === "string" && modelId.trim()) return modelId;
  }
  return legacyModelId;
}

/** Extract our attempt-bound invocation metadata. Missing IDs are never guessed. */
export function modelAttemptIdFromStreamEvent(event: unknown): string | undefined {
  const ev = record(event);
  const data = record(ev?.["data"]);
  const candidates = [record(ev?.["metadata"]), record(data?.["metadata"]), ev];
  for (const candidate of candidates) {
    const attemptId = candidate?.["model_attempt_id"] ?? candidate?.["modelAttemptId"];
    if (typeof attemptId === "string" && attemptId.trim()) return attemptId;
  }
  return undefined;
}
