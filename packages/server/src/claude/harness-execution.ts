import type {
  HarnessAttribution,
  HarnessExecutionOutput,
  HarnessRequestResponse,
  HarnessTaskExecutionAdmission,
  InMemoryRelayRegistry,
} from "@nautilo/runtime";
import {
  CLAUDE_EXECUTION_MAX_PROMPT_BYTES,
  CLAUDE_EXECUTION_MAX_TEXT_BYTES,
} from "@nautilo/relay";
import type {
  RelayClaudeExecutionEvent,
  RelayClaudeExecutionQuestion,
  RelayClaudeExecutionResponse,
  RelayClaudeExecutionSocketScope,
} from "@nautilo/relay";
import {
  assertAcceptedInvocationAuthoritySubject,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";

/** Server-private extension created only after Claude Connections admission. */
export interface ClaudeHarnessExecutionAdmission extends HarnessTaskExecutionAdmission {
  readonly claude: Readonly<{
    profileRef: string;
    catalogModelId: string;
    selectedModel: string;
    scope: RelayClaudeExecutionSocketScope;
  }>;
}

type RelayPort = Pick<InMemoryRelayRegistry, "openClaudeExecution">;
type ClaudeExecutionOpenResult = ReturnType<RelayPort["openClaudeExecution"]>;
type ClaudeExecutionControl = Extract<ClaudeExecutionOpenResult, { ok: true }>['control'];

export interface ClaudeHarnessExecutionOptions {
  readonly relay: RelayPort;
}

type ResultOutcome = "success" | "failed" | "interrupted";
type PendingRequest = {
  ownerId: string;
  interactionRef: string;
  kind: "permission_selection_required" | "user_input_required";
  responding: boolean;
  approvalDetailShown: boolean;
  questions: readonly RelayClaudeExecutionQuestion[] | null;
};

type StopWaiter = {
  readonly promise: Promise<true>;
  readonly resolve: (value: true) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
};

type ActiveExecution = {
  readonly admission: ClaudeHarnessExecutionAdmission;
  readonly control: ClaudeExecutionControl;
  readonly requests: Map<string, PendingRequest>;
  stop: StopWaiter | null;
  interrupt: Promise<"acknowledged" | "uncertain"> | null;
  started: boolean;
  terminal: boolean;
  result: Readonly<{ outcome: ResultOutcome; text: string | null }> | null;
  settlement: "eof" | "rejected" | null;
  interruptAcknowledged: boolean;
  userStopConfirmed: boolean;
  readonly outputParts: string[];
};

/**
 * Thin server projection of one current-socket Claude execution. It is not a
 * legacy HarnessExecution: Claude uses the provider-private C1 admission and
 * the Runtime owns the relay control lifetime.
 */
export class ClaudeHarnessExecution {
  readonly #activeByTask = new Map<string, ActiveExecution>();

  constructor(private readonly options: ClaudeHarnessExecutionOptions) {}

  hasLiveRequest(requestId: string, ownerId: string): boolean {
    for (const active of this.#activeByTask.values()) {
      const request = active.requests.get(requestId);
      if (request && request.ownerId === ownerId && !request.responding && !active.terminal &&
        active.result === null && active.settlement === null) return true;
    }
    return false;
  }

  async respond(
    response: HarnessRequestResponse,
    invocationAuthority: AcceptedInvocationAuthority,
  ): Promise<void> {
    assertAcceptedInvocationAuthoritySubject(invocationAuthority, response.ownerId);
    const active = this.#activeForRequest(response.requestId, response.ownerId);
    if (active === null) throw new TypeError("Claude request is unavailable");
    const request = active.requests.get(response.requestId);
    if (!request || request.responding || request.kind !== response.kind) {
      throw new TypeError("Claude request is unavailable");
    }
    const wire = responseFor(request, response);
    if (wire === null) throw new TypeError("Claude request response is invalid");
    active.requests.set(response.requestId, { ...request, responding: true });
    try {
      const result = await active.control.respond(request.interactionRef, wire);
      if (result !== "accepted") throw new TypeError("Claude request response was rejected");
    } finally {
      // This local request has one reply attempt whether Desktop accepts it,
      // rejects it, or the current socket is lost.
      active.requests.delete(response.requestId);
    }
  }

  /** Admit durable Human cancellation independently of provider containment. */
  stopActiveTask(taskId: string): Promise<boolean> {
    const active = this.#activeByTask.get(taskId);
    if (active === undefined) return Promise.resolve(false);
    // Like Codex, start containment once but do not gate canonical Task
    // cancellation on it. #settle still requires the actual provider facts
    // before reporting user_stop; uncertainty is never containment success.
    void this.#beginStop(active).catch(() => undefined);
    return Promise.resolve(true);
  }

  /** Delivers one direction only to the exact active, nonterminal root Query. */
  async steerActiveTask(input: {
    readonly taskId: string;
    readonly ownerId: string;
    readonly roomId: string;
    readonly profileRef: string;
    readonly catalogModelId: string;
    readonly selectedModel: string;
    readonly text: string;
  }): Promise<boolean> {
    const active = this.#activeByTask.get(input.taskId);
    if (active === undefined || !this.#matchesSteerAdmission(active, input)) return false;
    try {
      await active.control.steer(input.text);
    } catch (error) {
      if (this.#activeByTask.get(input.taskId) !== active || !this.#matchesSteerAdmission(active, input)) return false;
      throw error;
    }
    return true;
  }

  async *start(admission: ClaudeHarnessExecutionAdmission): AsyncIterable<HarnessExecutionOutput> {
    if (!isAdmitted(admission)) {
      yield terminal(admission, null, "failed", "invalid_request");
      return;
    }
    if (this.#activeByTask.has(admission.taskId)) {
      yield terminal(admission, null, "failed", "unavailable");
      return;
    }
    // A queued Task can be cancelled before its provider boundary. It has no
    // Claude terminal fact and must not fabricate one here.
    if (admission.abortSignal.aborted) return;

    let opened: ClaudeExecutionOpenResult;
    try {
      opened = this.options.relay.openClaudeExecution({
        relayId: admission.claude.scope.relayId,
        userId: admission.ownerId,
        prompt: admission.prompt,
        model: admission.claude.selectedModel,
        expectedScope: admission.claude.scope,
      });
    } catch {
      yield terminal(admission, null, "failed", "upstream_failure");
      return;
    }
    if (!opened.ok) {
      yield terminal(admission, null, "failed", opened.error === "CLAUDE_EXECUTION_INVALID" ? "invalid_request" : "unavailable");
      return;
    }

    const active: ActiveExecution = {
      admission,
      control: opened.control,
      requests: new Map(),
      stop: null,
      interrupt: null,
      started: false,
      terminal: false,
      result: null,
      settlement: null,
      interruptAcknowledged: false,
      userStopConfirmed: false,
      outputParts: [],
    };
    this.#activeByTask.set(admission.taskId, active);
    const onAbort = () => { void this.#beginStop(active).catch(() => undefined); };
    admission.abortSignal.addEventListener("abort", onAbort, { once: true });
    if (admission.abortSignal.aborted) onAbort();

    try {
      while (!active.terminal) {
        let event: RelayClaudeExecutionEvent | null;
        try {
          event = await active.control.next();
        } catch {
          this.#bestEffortInterrupt(active);
          yield this.#finish(active, "failed", "process_lost");
          return;
        }
        if (event === null) {
          this.#bestEffortInterrupt(active);
          yield this.#finish(active, "failed", "process_lost");
          return;
        }
        const output = await this.#project(active, event);
        for (const item of output) yield item;
      }
    } finally {
      admission.abortSignal.removeEventListener("abort", onAbort);
      if (this.#activeByTask.get(admission.taskId) === active) this.#activeByTask.delete(admission.taskId);
      active.requests.clear();
      this.#rejectStop(active, "CLAUDE_EXECUTION_STOP_UNAVAILABLE");
    }
  }

  #project(active: ActiveExecution, event: RelayClaudeExecutionEvent): readonly HarnessExecutionOutput[] | Promise<readonly HarnessExecutionOutput[]> {
    if (!active.started) {
      if (event.kind === "unavailable") return [this.#finish(active, "failed", "unavailable")];
      if (event.kind !== "started") return this.#lost(active);
      active.started = true;
      return [];
    }
    if (active.result !== null && event.kind !== "settled") return this.#lost(active);
    if (active.settlement !== null && event.kind !== "result") return this.#lost(active);
    if (event.kind === "activity") return [progress(active, "Claude Code activity")];
    if (event.kind === "initialized") return [progress(active, "Claude Code initialized")];
    if (event.kind === "output_delta") {
      if (event.text.length === 0) return [];
      active.outputParts.push(event.text);
      return [outputDelta(active, event.text)];
    }
    if (event.kind === "interaction") return this.#installRequest(active, event);
    if (event.kind === "result") {
      if (active.result !== null) return this.#lost(active);
      if (active.settlement !== null && (
        active.stop === null || active.settlement !== "rejected" || event.outcome !== "interrupted"
      )) return this.#lost(active);
      active.requests.clear();
      active.result = { outcome: event.outcome, text: event.text };
      return active.settlement === null ? [] : this.#settle(active, active.settlement);
    }
    if (event.kind !== "settled") return this.#lost(active);
    if (active.settlement !== null) return this.#lost(active);
    if (active.result === null && (active.stop === null || event.outcome !== "rejected")) {
      return this.#lost(active);
    }
    if (active.result === null) active.requests.clear();
    active.settlement = event.outcome;
    return this.#settle(active, event.outcome);
  }

  async #settle(active: ActiveExecution, outcome: "eof" | "rejected"): Promise<readonly HarnessExecutionOutput[]> {
    const result = active.result;
    if (result === null) return [];
    const resultText = active.outputParts.join("");
    if (result.outcome === "success" && outcome === "eof" && result.text === null && resultText.length > 0) {
      this.#rejectStop(active, "CLAUDE_EXECUTION_STOP_UNAVAILABLE");
      active.terminal = true;
      return [assistantCompleted(active, resultText), terminal(active.admission, active.control.executionRef, "completed")];
    }
    if (result.outcome === "failed") return [this.#finish(active, "failed", "upstream_failure")];
    if (result.outcome !== "interrupted" || outcome !== "rejected") {
      return [this.#finish(active, "failed", "upstream_failure")];
    }

    // The Runtime settles this shared receipt on stream retirement. Waiting
    // here preserves every acknowledged/result/rejected arrival order without
    // ever awaiting best-effort containment on a loss path.
    if (active.stop !== null && active.interrupt !== null) await active.interrupt.catch(() => undefined);
    if (this.#confirmStop(active)) {
      active.terminal = true;
      return [terminal(active.admission, active.control.executionRef, "interrupted", "user_stop")];
    }
    return [this.#finish(active, "failed", "upstream_failure")];
  }

  #installRequest(
    active: ActiveExecution,
    event: Extract<RelayClaudeExecutionEvent, { kind: "interaction" }>,
  ): readonly HarnessExecutionOutput[] {
    if (active.stop !== null) return [];
    const interaction = event.interaction;
    if ([...active.requests.values()].some((request) => request.interactionRef === interaction.interactionRef)) {
      return this.#lost(active);
    }
    const requestId = interaction.interactionRef;
    const request: PendingRequest = {
      ownerId: active.admission.ownerId,
      interactionRef: interaction.interactionRef,
      kind: interaction.kind === "permission" ? "permission_selection_required" : "user_input_required",
      responding: false,
      approvalDetailShown: interaction.kind === "permission" && interaction.detail?.state === "shown",
      questions: interaction.kind === "question" ? interaction.questions : null,
    };
    active.requests.set(requestId, request);
    const attribution = attributionFor(active, interaction.interactionRef);
    if (interaction.kind === "permission") {
      return [Object.freeze({
        kind: "permission_selection_required" as const,
        requestId,
        vendorRequestId: interaction.interactionRef,
        attribution,
        ownerId: active.admission.ownerId,
        expiresAt: null,
        options: Object.freeze([
          Object.freeze({ id: "allow_once", label: "Allow once", semanticHint: null }),
          Object.freeze({ id: "deny", label: "Deny", semanticHint: null }),
        ]),
        tool: Object.freeze({ title: interaction.toolName, kind: null }),
        detail: interaction.detail ?? { state: "withheld", reason: "incompatible" } as const,
      })];
    }
    return [Object.freeze({
      kind: "user_input_required" as const,
      requestId,
      vendorRequestId: interaction.interactionRef,
      attribution,
      ownerId: active.admission.ownerId,
      expiresAt: null,
      questions: Object.freeze(interaction.questions.map((question) => Object.freeze({
        id: question.questionRef,
        header: question.header,
        prompt: question.text,
        secret: false,
        multiSelect: question.multiSelect,
        allowOther: true,
        options: Object.freeze(question.options.map((option) => Object.freeze({
          id: option.optionRef,
          label: option.label,
          description: option.description,
        }))),
      }))),
      autoResolutionMs: null,
    })];
  }

  #activeForRequest(requestId: string, ownerId: string): ActiveExecution | null {
    for (const active of this.#activeByTask.values()) {
      const request = active.requests.get(requestId);
      if (request?.ownerId === ownerId && !active.terminal && active.result === null && active.settlement === null) return active;
    }
    return null;
  }

  #beginStop(active: ActiveExecution): Promise<true> {
    if (active.stop !== null) return active.stop.promise;
    if (active.terminal) return Promise.reject(new Error("CLAUDE_EXECUTION_STOP_UNAVAILABLE"));
    let resolve: (value: true) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<true>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
    const stop: StopWaiter = { promise, resolve, reject, settled: false };
    active.stop = stop;
    active.requests.clear();
    try {
      active.interrupt = Promise.resolve(active.control.interrupt());
      void active.interrupt.then(
        (outcome) => {
          if (outcome !== "acknowledged") this.#rejectStop(active, "CLAUDE_EXECUTION_STOP_UNCERTAIN");
          else {
            active.interruptAcknowledged = true;
            this.#confirmStop(active);
          }
        },
        () => this.#rejectStop(active, "CLAUDE_EXECUTION_STOP_UNAVAILABLE"),
      );
    } catch {
      this.#rejectStop(active, "CLAUDE_EXECUTION_STOP_UNAVAILABLE");
    }
    return promise;
  }

  #confirmStop(active: ActiveExecution): boolean {
    const stop = active.stop;
    if (!stop || !active.interruptAcknowledged || active.settlement !== "rejected" || active.result?.outcome !== "interrupted") return false;
    if (active.userStopConfirmed) return true;
    if (stop.settled) return false;
    stop.settled = true;
    active.userStopConfirmed = true;
    stop.resolve(true);
    return true;
  }

  #rejectStop(active: ActiveExecution, code: string): void {
    const stop = active.stop;
    if (!stop || stop.settled) return;
    stop.settled = true;
    stop.reject(new Error(code));
  }

  #matchesSteerAdmission(
    active: ActiveExecution,
    input: Readonly<{
      taskId: string;
      ownerId: string;
      roomId: string;
      profileRef: string;
      catalogModelId: string;
      selectedModel: string;
    }>,
  ): boolean {
    const admission = active.admission;
    return active.started && !active.terminal && active.result === null && active.settlement === null && active.stop === null &&
      admission.taskId === input.taskId && admission.ownerId === input.ownerId && admission.roomId === input.roomId &&
      admission.requesterId === admission.ownerId && admission.parentTaskId === null && admission.source === "room" &&
      admission.claude.profileRef === input.profileRef && admission.claude.catalogModelId === input.catalogModelId &&
      admission.claude.selectedModel === input.selectedModel;
  }

  #bestEffortInterrupt(active: ActiveExecution): void {
    try { void active.control.interrupt().catch(() => undefined); } catch { /* stream loss owns the terminal */ }
  }

  #lost(active: ActiveExecution): readonly HarnessExecutionOutput[] {
    this.#bestEffortInterrupt(active);
    return [this.#finish(active, "failed", "process_lost")];
  }

  #finish(
    active: ActiveExecution,
    status: "failed" | "interrupted",
    code: "process_lost" | "unavailable" | "upstream_failure" | "user_stop",
  ): HarnessExecutionOutput {
    active.terminal = true;
    this.#rejectStop(active, "CLAUDE_EXECUTION_STOP_UNAVAILABLE");
    return terminal(active.admission, active.control.executionRef, status, code);
  }
}

function responseFor(
  request: PendingRequest,
  response: HarnessRequestResponse,
): RelayClaudeExecutionResponse | null {
  if (request.kind === "permission_selection_required") {
    if (response.kind !== "permission_selection_required") return null;
    if (response.outcome.kind === "selected" && response.outcome.optionId === "allow_once" && request.approvalDetailShown) {
      return Object.freeze({ kind: "allow_once" });
    }
    if ((response.outcome.kind === "selected" && response.outcome.optionId === "deny") || response.outcome.kind === "cancelled") {
      return Object.freeze({ kind: "deny" });
    }
    return null;
  }
  return response.kind === "user_input_required" && request.questions !== null
    ? questionAnswers(request.questions, response.answers)
    : null;
}

function questionAnswers(
  questions: readonly RelayClaudeExecutionQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
): RelayClaudeExecutionResponse | null {
  const answerIds = Object.keys(answers);
  if (answerIds.length !== questions.length || questions.some((question) => !answerIds.includes(question.questionRef))) return null;
  const copied: Record<string, readonly string[]> = {};
  for (const question of questions) {
    const selected = answers[question.questionRef];
    if (!Array.isArray(selected) || selected.length === 0 || selected.length > question.options.length + 1) return null;
    const options = new Set(question.options.map((option) => option.optionRef));
    const unique = new Set<string>();
    const normalized: string[] = [];
    let otherCount = 0;
    for (const answer of selected) {
      if (!bounded(answer, CLAUDE_EXECUTION_MAX_TEXT_BYTES) || unique.has(answer)) return null;
      unique.add(answer);
      normalized.push(answer);
      if (!options.has(answer)) {
        if (!question.allowOther || looksUuid(answer) || ++otherCount > 1) return null;
      }
    }
    if (!question.multiSelect && selected.length !== 1) return null;
    Object.defineProperty(copied, question.questionRef, {
      value: Object.freeze(normalized), enumerable: true,
    });
  }
  return Object.freeze({ kind: "answers", answers: Object.freeze(copied) });
}

function looksUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isAdmitted(value: ClaudeHarnessExecutionAdmission): boolean {
  return value.requesterId === value.ownerId && value.source === "room" && value.parentTaskId === null &&
    bounded(value.roomId, CLAUDE_EXECUTION_MAX_TEXT_BYTES) && bounded(value.laneKey, CLAUDE_EXECUTION_MAX_TEXT_BYTES) &&
    bounded(value.taskId, CLAUDE_EXECUTION_MAX_TEXT_BYTES) && bounded(value.taskRunId, CLAUDE_EXECUTION_MAX_TEXT_BYTES) &&
    bounded(value.jobId, CLAUDE_EXECUTION_MAX_TEXT_BYTES) && bounded(value.ownerId, CLAUDE_EXECUTION_MAX_TEXT_BYTES) &&
    bounded(value.prompt, CLAUDE_EXECUTION_MAX_PROMPT_BYTES) && bounded(value.claude.profileRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES) &&
    bounded(value.claude.catalogModelId, CLAUDE_EXECUTION_MAX_TEXT_BYTES) && bounded(value.claude.selectedModel, CLAUDE_EXECUTION_MAX_TEXT_BYTES) &&
    bounded(value.claude.scope.relayId, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
}

function bounded(value: unknown, bytes: number): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && new TextEncoder().encode(value).byteLength <= bytes;
}

function attributionFor(active: ActiveExecution, vendorItemId: string | null): HarnessAttribution {
  return Object.freeze({
    bindingId: active.admission.taskRunId,
    bindingGeneration: active.admission.jobId,
    taskId: active.admission.taskId,
    roomId: active.admission.roomId,
    vendorSessionId: active.control.executionRef,
    vendorTurnId: null,
    vendorItemId,
  });
}

function progress(active: ActiveExecution, message: string): HarnessExecutionOutput {
  return Object.freeze({ kind: "progress", attribution: attributionFor(active, null), message });
}

function assistantCompleted(active: ActiveExecution, text: string): HarnessExecutionOutput {
  return Object.freeze({ kind: "assistant_completed", attribution: attributionFor(active, null), text });
}

function outputDelta(active: ActiveExecution, text: string): HarnessExecutionOutput {
  return Object.freeze({ kind: "output_delta", attribution: attributionFor(active, null), text });
}

function terminal(
  admission: HarnessTaskExecutionAdmission,
  executionRef: string | null,
  status: "completed" | "failed" | "interrupted",
  code?: "invalid_request" | "process_lost" | "unavailable" | "upstream_failure" | "user_stop",
): HarnessExecutionOutput {
  return Object.freeze({
    kind: "terminal",
    attribution: Object.freeze({
      bindingId: admission.taskRunId,
      bindingGeneration: admission.jobId,
      taskId: admission.taskId,
      roomId: admission.roomId,
      vendorSessionId: executionRef,
      vendorTurnId: null,
      vendorItemId: null,
    }),
    status,
    ...(code === undefined ? {} : { code }),
  });
}
