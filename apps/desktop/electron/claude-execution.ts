import { randomUUID } from "node:crypto";
import {
  ClaudeAgentSdkHost,
  defaultClaudeAgentSdk,
  type ClaudeExecutionObservation,
  type ClaudeInteraction,
  type ClaudeInteractionAuthority,
  type ClaudeInteractionDecision,
  type ClaudeLaunchHandle,
  type ClaudeLaunchRequest,
  type ClaudeExecutableResolver,
} from "@nautilo/claude-agent-sdk-host";
import {
  CLAUDE_EXECUTION_PROTOCOL_VERSION,
  CLAUDE_PERMISSION_DETAIL_PROTOCOL_VERSION,
  parseRelayClaudeExecutionDesktopEvent,
  type RelayClaudeExecutionCommand,
  type RelayClaudeExecutionDesktopEvent,
  type RelayClaudeExecutionHostPort,
  type RelayClaudeExecutionHostTransport,
  type RelayClaudeExecutionInteraction,
  type RelayClaudeExecutionResponse,
  type RelayClaudeExecutionSession,
} from "@nautilo/relay";
import { createAmbientClaudeExecutableResolver } from "./claude-executable-resolver";
import {
  createCurrentFolderClaudeLeaseProvider,
  hasCurrentFolderSelection,
  type CurrentFolderClaudeLease,
  type CurrentFolderClaudeLeaseProvider,
  type CurrentFolderSelection,
} from "./current-folder-claude-lease";

type ClaudeExecutionSdkHost = Readonly<{
  launch(request: ClaudeLaunchRequest): Promise<ClaudeLaunchHandle>;
}>;

type PendingInteraction = Readonly<{
  interactionRef: string;
  decision: (value: ClaudeInteractionDecision) => void;
  questionAnswers: ReadonlyMap<string, Readonly<{ text: string; multiSelect: boolean; options: ReadonlyMap<string, string> }>> | null;
  signal: AbortSignal;
  approvalDetailShown: boolean;
}>;

type ActiveExecution = {
  readonly executionRef: string;
  readonly session: RelayClaudeExecutionSession;
  readonly transport: RelayClaudeExecutionHostTransport;
  readonly lease: CurrentFolderClaudeLease;
  readonly started: Deferred<boolean>;
  handle: ClaudeLaunchHandle | null;
  pending: PendingInteraction | null;
  interrupt: Promise<void> | null;
  interruptIntent: boolean;
  steerPending: boolean;
  settled: boolean;
  closed: boolean;
};

type StartingExecution = {
  readonly token: symbol;
  readonly executionRef: string;
  interruptIntent: boolean;
};

/** One current Desktop Query; relay and server own no local SDK resources. */
export class ElectronClaudeExecutionHost implements RelayClaudeExecutionHostPort {
  #session: RelayClaudeExecutionSession | null = null;
  #transport: RelayClaudeExecutionHostTransport | null = null;
  #active: ActiveExecution | null = null;
  #starting: StartingExecution | null = null;
  #lastExecutionRef: string | null = null;
  #lastExecutionReceiptCurrent = false;
  readonly #currentFolder: () => CurrentFolderSelection | null;
  readonly #leases: CurrentFolderClaudeLeaseProvider;
  readonly #createHost: (authority: ClaudeInteractionAuthority) => ClaudeExecutionSdkHost;

  constructor(input: Readonly<{
    currentFolder: () => CurrentFolderSelection | null;
    leaseProvider?: CurrentFolderClaudeLeaseProvider;
    executableResolver?: ClaudeExecutableResolver;
    createHost?: (authority: ClaudeInteractionAuthority) => ClaudeExecutionSdkHost;
  }>) {
    this.#currentFolder = input.currentFolder;
    this.#leases = input.leaseProvider ?? createCurrentFolderClaudeLeaseProvider({ currentFolder: input.currentFolder });
    const resolver = input.executableResolver ?? createAmbientClaudeExecutableResolver();
    this.#createHost = input.createHost ?? ((interactionAuthority) => new ClaudeAgentSdkHost({
      executableResolver: resolver,
      sdk: defaultClaudeAgentSdk,
      onFact: () => undefined,
      interactionAuthority,
    }));
  }

  isReady(): boolean { return hasCurrentFolderSelection(this.#currentFolder); }

  onRegistered(session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): void {
    this.#starting = null;
    this.#lastExecutionRef = null;
    void this.#teardown(this.#active);
    this.#session = freezeSession(session);
    this.#transport = transport;
  }

  onDisconnected(): void {
    this.#starting = null;
    this.#lastExecutionRef = null;
    this.#session = null;
    this.#transport = null;
    void this.#teardown(this.#active);
  }
  onCurrentFolderChanged(): void { this.#starting = null; this.#lastExecutionReceiptCurrent = false; void this.#teardown(this.#active); }

  onCommand(command: RelayClaudeExecutionCommand): void {
    const session = this.#session;
    const transport = this.#transport;
    if (session === null || transport === null || !sameScope(session, command.scope)) return;
    if (command.action.kind === "start") {
      if (this.#lastExecutionRef === command.executionRef || this.#active !== null || this.#starting !== null) { this.#sendUnavailable(command.executionRef, session, transport); return; }
      const token = Symbol("claude-start");
      this.#lastExecutionRef = command.executionRef;
      this.#lastExecutionReceiptCurrent = true;
      this.#starting = { token, executionRef: command.executionRef, interruptIntent: false };
      void this.#start(command, session, transport, token).catch(() => {
        if (this.#starting?.token === token) { this.#starting = null; this.#sendUnavailable(command.executionRef, session, transport); }
      });
      return;
    }
    const active = this.#active;
    if (command.action.kind === "interrupt" && active === null && this.#starting?.executionRef === command.executionRef) {
      this.#starting.interruptIntent = true;
      return;
    }
    if (command.action.kind === "steer") {
      if (active === null || !this.#sameActive(active, command.executionRef, session, transport)) {
        this.#sendSteerRejected(command.executionRef, command.action.steerRef, session, transport);
        return;
      }
      void this.#steer(active, command.action.steerRef, command.action.prompt);
      return;
    }
    if (active === null || !this.#sameActive(active, command.executionRef, session, transport)) return;
    if (command.action.kind === "interrupt") {
      void this.#interrupt(active);
      return;
    }
    void this.#respond(active, command.action.interactionRef, command.action.response);
  }

  async #start(
    command: RelayClaudeExecutionCommand,
    session: RelayClaudeExecutionSession,
    transport: RelayClaudeExecutionHostTransport,
    token: symbol,
  ): Promise<void> {
    if (command.action.kind !== "start") return;
    const action = command.action;
    let lease: CurrentFolderClaudeLease | null = null;
    try { lease = await this.#leases.acquire(); } catch { this.#clearStarting(token, command.executionRef, session, transport); return; }
    if (!this.#isStarting(token, session, transport)) { if (lease !== null) await lease.close(); return; }
    const valid = lease !== null && await this.#validateLease(lease);
    if (lease === null || !valid || !this.#isStarting(token, session, transport)) {
      if (lease !== null) await lease.close();
      if (this.#starting?.token === token) this.#starting = null;
      this.#sendUnavailable(command.executionRef, session, transport);
      return;
    }
    const started = deferred<boolean>();
    const starting = this.#starting;
    if (starting?.token !== token) { await lease.close(); return; }
    const active: ActiveExecution = {
      executionRef: command.executionRef,
      session,
      transport,
      lease,
      started,
      handle: null,
      pending: null,
      interrupt: null, interruptIntent: starting.interruptIntent,
      steerPending: false,
      settled: false,
      closed: false,
    };
    if (!this.#isStarting(token, session, transport)) { await lease.close(); return; }
    this.#active = active;
    this.#starting = null;
    let host: ClaudeExecutionSdkHost;
    try {
      host = this.#createHost((interaction, signal) => this.#interaction(active, interaction, signal));
      const handle = await host.launch({
        prompt: action.prompt,
        model: action.model,
        workingDirectory: lease.workingDirectory,
      });
      if (!this.#isCurrent(active)) { try { handle.close(); } catch { /* stale local cleanup */ } return; }
      active.handle = handle;
    } catch {
      await this.#unavailable(active);
      return;
    }
    if (!this.#isCurrent(active) || !(await this.#validateLease(lease)) || !active.handle.available) {
      await this.#unavailable(active);
      return;
    }
    if (!(await this.#emit(active, { kind: "started" }))) {
      await this.#teardown(active);
      return;
    }
    started.resolve(true);
    if (active.interruptIntent) void this.#interrupt(active);
    void this.#forward(active);
  }

  async #forward(active: ActiveExecution): Promise<void> {
    const handle = active.handle;
    if (handle === null) return;
    try {
      for await (const observation of handle.observations) {
        if (!this.#isCurrent(active) || !(await this.#validateLease(active.lease))) break;
        const event = eventFor(observation);
        if (event === null || !(await this.#emit(active, event))) break;
        if (event.kind === "settled") active.settled = true;
      }
    } catch {
      // The SDK iterator settles its own observed result/rejection facts.
    } finally {
      await this.#teardown(active);
    }
  }

  async #interaction(
    active: ActiveExecution,
    interaction: ClaudeInteraction,
    signal: AbortSignal,
  ): Promise<ClaudeInteractionDecision> {
    if (signal.aborted || !this.#isCurrent(active)) return deny();
    if (!(await this.#validateLease(active.lease))) { await this.#teardown(active); return deny(); }
    if (!(await active.started.promise) || signal.aborted || active.pending !== null || !this.#isCurrent(active)) return deny();
    if (!(await this.#validateLease(active.lease))) { await this.#teardown(active); return deny(); }
    let projected = interactionFor(interaction);
    if (projected === null) return deny();
    if (projected.interaction.kind === "permission") {
      if (active.session.selectedProtocolVersion < CLAUDE_PERMISSION_DETAIL_PROTOCOL_VERSION) {
        // Old peers retain their original wire shape, but cannot authorize a
        // hidden action on this updated host.
        const { kind, interactionRef, toolName, allowSession } = projected.interaction;
        projected = { ...projected, interaction: { kind, interactionRef, toolName, allowSession } };
      } else if (!parseRelayClaudeExecutionDesktopEvent({ type: "relay:claude-execution-event", scope: active.session, executionRef: active.executionRef, event: { kind: "interaction", interaction: projected.interaction } })) {
        projected = { ...projected, interaction: { ...projected.interaction, detail: { state: "withheld", reason: "frame_limit" } } };
      }
    }
    const decision = deferred<ClaudeInteractionDecision>();
    const pending: PendingInteraction = {
      interactionRef: projected.interactionRef,
      decision: (value) => decision.resolve(value),
      questionAnswers: projected.questionAnswers, signal,
      approvalDetailShown: projected.interaction.kind === "permission" && projected.interaction.detail?.state === "shown",
    };
    active.pending = pending;
    const onAbort = () => { if (active.pending === pending) active.pending = null; decision.resolve(deny()); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (signal.aborted || active.pending !== pending || !(await this.#emit(active, { kind: "interaction", interaction: projected.interaction }))) {
      active.pending = null;
      decision.resolve(deny());
    }
    try { return await decision.promise; } finally {
      signal.removeEventListener("abort", onAbort);
      if (active.pending === pending) active.pending = null;
    }
  }

  async #respond(active: ActiveExecution, interactionRef: string, response: RelayClaudeExecutionResponse): Promise<void> {
    const pending = active.pending;
    if (pending === null || pending.interactionRef !== interactionRef) {
      await this.#emit(active, { kind: "interaction_rejected", interactionRef });
      return;
    }
    active.pending = null;
    if (pending.signal.aborted || !this.#isCurrent(active) || !(await this.#validateLease(active.lease)) || !this.#isCurrent(active)) {
      pending.decision(deny());
      await this.#teardown(active);
      return;
    }
    const decision = decisionFor(pending, response);
    if (decision === null) {
      pending.decision(deny());
      await this.#emit(active, { kind: "interaction_rejected", interactionRef });
      return;
    }
    if (!pending.signal.aborted && this.#isCurrent(active) && await this.#emit(active, { kind: "interaction_accepted", interactionRef }) && !pending.signal.aborted && this.#isCurrent(active)) pending.decision(decision);
    else pending.decision(deny());
  }

  async #interrupt(active: ActiveExecution): Promise<void> {
    if (!this.#isCurrent(active) || !(await this.#validateLease(active.lease))) { await this.#teardown(active); return; }
    if (active.interrupt !== null) return active.interrupt;
    if (active.handle === null) { active.interruptIntent = true; return; }
    active.interrupt = (async () => {
      const handle = active.handle;
      if (handle === null) return;
      const receipt = await handle.interrupt();
      if (this.#isCurrent(active) && await this.#validateLease(active.lease)) {
        await this.#emit(active, { kind: "interrupt_receipt", outcome: receipt.outcome });
      }
    })().catch(() => undefined);
    return active.interrupt;
  }

  async #steer(active: ActiveExecution, steerRef: string, prompt: string): Promise<void> {
    if (active.steerPending) {
      await this.#emit(active, { kind: "steer_receipt", steerRef, outcome: "rejected" });
      return;
    }
    active.steerPending = true;
    try {
      const handle = active.handle;
      if (handle === null || !this.#isCurrent(active) || !(await this.#validateLease(active.lease)) || !this.#isCurrent(active)) {
        await this.#emit(active, { kind: "steer_receipt", steerRef, outcome: "rejected" });
        return;
      }
      let outcome: Awaited<ReturnType<ClaudeLaunchHandle["steer"]>>;
      try {
        outcome = await handle.steer(prompt);
      } catch {
        outcome = { outcome: "rejected" };
      }
      // Settlement closes the process/lease, not an already-admitted command's
      // delivery fact. This receipt grants no new execution authority. Only the
      // same socket and last execution may report it; folder changes and a
      // successor invalidate that eligibility without retaining SDK resources.
      const leaseValid = this.#isCurrent(active) && await this.#validateLease(active.lease);
      if (!this.#lastExecutionReceiptCurrent || this.#lastExecutionRef !== active.executionRef || !this.#stillRegistered(active.session, active.transport)) return;
      // Re-evaluate settlement after validation: EOF may close the lease while
      // validation is awaiting. Do not introduce another await before sending.
      if (active.settled || (leaseValid && this.#isCurrent(active))) {
        try {
          const sent = active.transport.send({ type: "relay:claude-execution-event", scope: active.session, executionRef: active.executionRef,
            event: { kind: "steer_receipt", steerRef, outcome: outcome.outcome } });
          if (!sent) void this.#teardown(active);
        } catch { void this.#teardown(active); }
      }
    } finally {
      active.steerPending = false;
    }
  }

  async #unavailable(active: ActiveExecution): Promise<void> {
    if (this.#isCurrent(active)) await this.#emit(active, { kind: "unavailable" });
    await this.#teardown(active);
  }

  #sendUnavailable(executionRef: string, session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): void {
    if (!this.#stillRegistered(session, transport)) return;
    try { transport.send({ type: "relay:claude-execution-event", scope: session, executionRef, event: { kind: "unavailable" } }); } catch { /* local denial only */ }
  }

  #sendSteerRejected(executionRef: string, steerRef: string, session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): void {
    if (!this.#stillRegistered(session, transport)) return;
    try { transport.send({ type: "relay:claude-execution-event", scope: session, executionRef, event: { kind: "steer_receipt", steerRef, outcome: "rejected" } }); } catch { /* local denial only */ }
  }

  async #emit(active: ActiveExecution, event: RelayClaudeExecutionDesktopEvent["event"]): Promise<boolean> {
    if (!this.#isCurrent(active) || !(await this.#validateLease(active.lease)) || !this.#isCurrent(active)) {
      void this.#teardown(active);
      return false;
    }
    try {
      const sent = active.transport.send({
        type: "relay:claude-execution-event",
        scope: active.session,
        executionRef: active.executionRef,
        event,
      });
      if (!sent) void this.#teardown(active);
      return sent;
    } catch {
      void this.#teardown(active);
      return false;
    }
  }

  async #teardown(active: ActiveExecution | null): Promise<void> {
    if (active === null || active.closed) return;
    active.closed = true;
    if (this.#active === active) this.#active = null;
    active.started.resolve(false);
    const pending = active.pending;
    active.pending = null;
    pending?.decision(deny());
    try { active.handle?.close(); } catch { /* local close is not provider terminal truth */ }
    await active.lease.close();
  }

  #isCurrent(active: ActiveExecution): boolean {
    return !active.closed && this.#active === active && this.#stillRegistered(active.session, active.transport);
  }

  async #validateLease(lease: CurrentFolderClaudeLease): Promise<boolean> {
    try { return await lease.validate(); } catch { return false; }
  }

  #sameActive(active: ActiveExecution, executionRef: string, session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): boolean {
    return active.executionRef === executionRef && active.session === session && active.transport === transport && this.#isCurrent(active);
  }

  #stillRegistered(session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): boolean {
    return this.#session === session && this.#transport === transport && sameScope(session, this.#session);
  }
  #isStarting(token: symbol, session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): boolean { return this.#starting?.token === token && this.#stillRegistered(session, transport); }
  #clearStarting(token: symbol, executionRef: string, session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): void { if (this.#starting?.token === token) { this.#starting = null; this.#sendUnavailable(executionRef, session, transport); } }
}

function interactionFor(interaction: ClaudeInteraction): Readonly<{
  interaction: RelayClaudeExecutionInteraction;
  interactionRef: string;
  questionAnswers: PendingInteraction["questionAnswers"];
}> | null {
  if (interaction.kind === "permission") {
    const wire: RelayClaudeExecutionInteraction = { kind: "permission" as const, interactionRef: interaction.interactionRef, toolName: interaction.toolName, allowSession: false as const, detail: interaction.detail ?? { state: "withheld", reason: "unsupported" } };
    return Object.freeze({
      interaction: wire,
      interactionRef: interaction.interactionRef,
      questionAnswers: null,
    });
  }
  const questions = interaction.questions.map((question) => {
    const questionRef = randomUUID();
    return {
      questionRef,
      header: question.header,
      text: question.text,
      multiSelect: question.multiSelect,
      allowOther: true as const,
      options: question.options.map((option) => ({ optionRef: randomUUID(), label: option.label, description: option.description })),
    };
  });
  if (questions.length === 0) return null;
  const answers = new Map<string, Readonly<{ text: string; multiSelect: boolean; options: ReadonlyMap<string, string> }>>();
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const source = interaction.questions[index];
    if (!question || !source) return null;
    answers.set(question.questionRef, Object.freeze({ text: source.text, multiSelect: source.multiSelect, options: new Map(question.options.map((option, optionIndex) => [option.optionRef, source.options[optionIndex]?.label ?? ""])) }));
  }
  const wire: RelayClaudeExecutionInteraction = Object.freeze({ kind: "question" as const, interactionRef: interaction.interactionRef, questions });
  return Object.freeze({
    interaction: wire,
    interactionRef: interaction.interactionRef,
    questionAnswers: answers,
  });
}

function decisionFor(pending: PendingInteraction, response: RelayClaudeExecutionResponse): ClaudeInteractionDecision | null {
  if (pending.questionAnswers === null) return response.kind === "allow_once" && pending.approvalDetailShown ? { kind: "allow_once" } : response.kind === "deny" ? deny() : null;
  if (response.kind !== "answers" || Object.keys(response.answers).length !== pending.questionAnswers.size) return null;
  const answers = {} as Record<string, string>;
  for (const [questionRef, source] of pending.questionAnswers) {
    const selected = response.answers[questionRef];
    if (!selected || selected.length === 0 || (!source.multiSelect && selected.length !== 1) || new Set(selected).size !== selected.length) return null;
    const values: string[] = [];
    let other = false;
    for (const value of selected) {
      const label = source.options.get(value);
      if (label !== undefined) values.push(label);
      else if (!other && validOther(value) && !uuidLike(value)) { other = true; values.push(value); }
      else return null;
    }
    answers[source.text] = values.join(", ");
  }
  return Object.freeze({ kind: "answers", answers: Object.freeze(answers) });
}

function eventFor(observation: ClaudeExecutionObservation): RelayClaudeExecutionDesktopEvent["event"] | null {
  if (observation.kind === "activity") return { kind: "activity", activity: observation.activity, state: observation.state, ...(observation.toolName === undefined ? {} : { toolName: observation.toolName }) };
  if (observation.kind === "initialized") return { kind: "initialized", claudeCodeVersion: observation.claudeCodeVersion, servingModel: observation.model };
  if (observation.kind === "output_delta") return { kind: "output_delta", text: observation.text };
  if (observation.kind === "result") return { kind: "result", outcome: observation.outcome === "succeeded" ? "success" : observation.outcome, text: null };
  if (observation.kind === "settled") return { kind: "settled", outcome: observation.settlement };
  return null;
}

function validOther(value: string): boolean { return value.length > 0 && Buffer.byteLength(value, "utf8") <= 320 && !containsControl(value); }
function uuidLike(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function deny(): ClaudeInteractionDecision { return Object.freeze({ kind: "deny" }); }
function freezeSession(session: RelayClaudeExecutionSession): RelayClaudeExecutionSession { return Object.freeze({ ...session }); }
function sameScope(left: RelayClaudeExecutionSession, right: RelayClaudeExecutionSession | null): boolean {
  return right !== null && left.relayId === right.relayId && left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef && left.selectedProtocolVersion >= CLAUDE_EXECUTION_PROTOCOL_VERSION && left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}
type Deferred<T> = { readonly promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function containsControl(value: string): boolean { return Array.from(value).some((character) => { const codePoint = character.codePointAt(0); return codePoint !== undefined && ((codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) || codePoint === 127); }); }
