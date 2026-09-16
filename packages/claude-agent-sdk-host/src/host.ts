import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_EXECUTION_MAX_QUEUED_EVENTS,
  CLAUDE_EXECUTION_MAX_PROMPT_BYTES,
  CLAUDE_EXECUTION_MAX_TEXT_BYTES,
  CLAUDE_RELAY_PROTOCOL_VERSION,
  parseRelayClaudeFactMessage,
  type RelayClaudeFact,
} from "@nautilo/relay";
import {
  CLAUDE_AGENT_SDK_VERSION,
  isReviewedClaudeCodeVersion,
  type ClaudeAgentSdkHostOptions,
  type ClaudeCanUseTool,
  type ClaudeDiscoveryRequest,
  type ClaudeExecutionObservation,
  type ClaudeInteraction,
  type ClaudeInteractionDecision,
  type ClaudeInterruptOutcome,
  type ClaudeLaunchHandle,
  type ClaudeLaunchRequest,
  type ClaudeSteerOutcome,
  type ResolvedClaudeExecutable,
} from "./contracts";
import { projectAccountInfo, projectClaudeExecutionMessage, projectSupportedModels } from "./projector";
import { projectClaudePermissionDetail } from "./permission-detail";
export const REQUIRED_CLAUDE_RUNTIME_FEATURES = Object.freeze([
  "accountInfo",
  "supportedModels",
  "interrupt",
  "switchModelsOnFlag",
] as const);
export class ClaudeAgentSdkHost {
  readonly #options: ClaudeAgentSdkHostOptions;
  #active: Active | null = null;
  #factSequence = 0;
  public constructor(options: ClaudeAgentSdkHostOptions) {
    this.#options = options;
  }
  public async launch(request: ClaudeLaunchRequest): Promise<ClaudeLaunchHandle> {
    const launch = captureLaunch(request);
    if (launch === null || this.#active !== null) return unavailableHandle();
    let executable: ResolvedClaudeExecutable | null;
    try {
      executable = await this.#options.executableResolver.resolve();
    } catch {
      return unavailableHandle();
    }
    if (executable === null || !isReviewedClaudeRuntime(executable)) return unavailableHandle();
    const input = new ClaudeInputQueue();
    const observations = new ObservationQueue();
    const active: Active = {
      input,
      observations,
      query: null as never,
      closed: false,
      ended: false,
      resultSeen: false,
      interruptRequested: false,
      outputParts: [],
      interruptPromise: undefined,
      steerPromise: undefined,
    };
    const canUseTool: ClaudeCanUseTool = async (toolName, rawInput, rawOptions): Promise<PermissionResult> =>
      this.#authorizeTool(active, toolName, rawInput, rawOptions, launch.workingDirectory);
    let queryPort: QueryPort | null;
    try {
      const created = this.#options.sdk.query({
        prompt: input,
        options: {
          cwd: launch.workingDirectory,
          model: launch.model,
          pathToClaudeCodeExecutable: executable.path,
          persistSession: false,
          includePartialMessages: true,
          settings: { switchModelsOnFlag: false },
          disallowedTools: ["Task"],
          canUseTool,
        },
      });
      queryPort = captureQuery(created);
    } catch {
      input.close();
      return unavailableHandle();
    }
    if (queryPort === null) {
      input.close();
      return unavailableHandle();
    }
    active.query = queryPort;
    this.#active = active;
    void this.#observe(active);
    try {
      input.push({
        type: "user",
        message: { role: "user", content: launch.prompt },
        parent_tool_use_id: null,
        uuid: crypto.randomUUID(),
      });
      input.close();
    } catch {
      this.#close(active);
      return unavailableHandle();
    }
    return Object.freeze({
      available: true,
      observations,
      interrupt: () => this.#interrupt(active),
      steer: (prompt: string) => this.#steer(active, prompt),
      close: () => this.#close(active),
    });
  }
  public async discover(request: ClaudeDiscoveryRequest): Promise<boolean> {
    const workingDirectory = completeText(own(request, "workingDirectory"));
    const signal = own(request, "signal");
    if (workingDirectory === null || signal !== undefined && !isSignal(signal) || aborted(signal)) return false;
    let executable: ResolvedClaudeExecutable | null;
    try {
      executable = await this.#options.executableResolver.resolve();
    } catch {
      return false;
    }
    if (aborted(signal)) return false;
    if (executable === null) {
      this.#emit({ kind: "runtime", state: "unavailable" });
      return false;
    }
    let queryPort: QueryPort | null;
    const input = new ClaudeInputQueue();
    try {
      queryPort = captureQuery(this.#options.sdk.query({
        prompt: input,
        options: {
          cwd: workingDirectory,
          pathToClaudeCodeExecutable: executable.path,
          settings: { switchModelsOnFlag: false },
        },
      }));
    } catch {
      this.#emitFailure();
      return false;
    }
    if (queryPort === null) {
      this.#emitFailure();
      return false;
    }
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      input.close();
      try { queryPort?.close(); } catch { /* discovery cleanup is local only */ }
    };
    try {
      const [account, models] = await Promise.all([queryPort.accountInfo(), queryPort.supportedModels()]);
      if (aborted(signal) || !Array.isArray(models)) return false;
      const catalog = projectSupportedModels(models);
      const qualified = isReviewedClaudeRuntime(executable);
      if (!this.#emit({ kind: "runtime", state: "ready", version: executable.version, executionQualified: qualified })) return false;
      if (!this.#emit({ kind: "model_catalog", models: catalog, complete: catalog.length === models.length })) return false;
      if (emptyAccount(account)) return this.#emit({ kind: "account_state", state: "disconnected" }) && false;
      return this.#emit({ kind: "account", account: projectAccountInfo(account as never) }) && catalog.length === models.length;
    } catch {
      if (!aborted(signal)) this.#emitFailure();
      return false;
    } finally {
      close();
    }
  }
  async #observe(active: Active): Promise<void> {
    let settlement: "eof" | "rejected" = "eof";
    try {
      for (;;) {
        const next = await active.query.next();
        if (next.done) break;
        const projected = projectClaudeExecutionMessage(next.value);
        if (projected === null || this.#active !== active) {
          settlement = "rejected";
          break;
        }
        for (const observation of projected) {
          if (observation.kind === "output_message_started") {
            active.outputParts.length = 0;
            continue;
          }
          if (observation.kind === "output_delta") {
            if (active.resultSeen || active.closed) {
              settlement = "rejected";
              break;
            }
            if (!active.closed && !active.observations.push(observation)) {
              settlement = "rejected";
              break;
            }
            active.outputParts.push(observation.text);
            continue;
          }
          if (observation.kind === "result") {
            if (active.resultSeen || active.closed) {
              settlement = "rejected";
              break;
            }
            active.resultSeen = true;
            if (observation.outcome === "succeeded") {
              if (active.outputParts.join("") !== observation.candidate) {
                settlement = "rejected";
                break;
              }
              if (!active.closed && !active.observations.push({ kind: "result", outcome: "succeeded" })) {
                settlement = "rejected";
              }
              continue;
            }
          }
          if (!active.closed && !active.observations.push(observation)) {
            settlement = "rejected";
            break;
          }
        }
        if (settlement === "rejected") break;
      }
    } catch {
      settlement = "rejected";
    } finally {
      active.ended = true;
      active.input.close();
      active.observations.settle(Object.freeze({
        kind: "settled",
        settlement,
        afterResult: active.resultSeen,
      }));
      if (this.#active === active) this.#active = null;
    }
  }
  async #authorizeTool(
    active: Active,
    rawToolName: string,
    rawInput: Record<string, unknown>,
    rawOptions: Parameters<ClaudeCanUseTool>[2],
    cwd: string,
  ): Promise<PermissionResult> {
    const toolUseID = text(own(rawOptions, "toolUseID"), 320);
    const signal = own(rawOptions, "signal");
    const agentID = own(rawOptions, "agentID");
    const toolName = text(rawToolName, 160);
    if (toolUseID === null || !isSignal(signal) || agentID !== undefined || toolName === null || stale(active, signal)) return deny(toolUseID ?? undefined);
    const question = toolName === "AskUserQuestion" ? captureQuestion(rawInput) : null;
    if (question === false) return deny(toolUseID);
    const interaction: ClaudeInteraction = question === null
      ? Object.freeze({
        kind: "permission",
        interactionRef: crypto.randomUUID(),
        toolName,
        scope: "root",
        allowSession: false,
        detail: projectClaudePermissionDetail(toolName, rawInput, cwd),
      })
      : Object.freeze({
        kind: "question",
        interactionRef: crypto.randomUUID(),
        scope: "root",
        questions: question.questions,
      });
    const authority = this.#options.interactionAuthority;
    if (authority === undefined) return deny(toolUseID);
    let decision: ClaudeInteractionDecision;
    try {
      decision = await authority(interaction, signal);
    } catch {
      return deny(toolUseID);
    }
    if (stale(active, signal)) return deny(toolUseID);
    if (question === null) return decision.kind === "allow_once" ? allow(toolUseID) : deny(toolUseID);
    const answers = decision.kind === "answers" ? acceptedAnswers(decision.answers, question) : null;
    return answers === null ? deny(toolUseID) : allow(toolUseID, Object.freeze({ questions: question.official, answers }));
  }
  #interrupt(active: Active): Promise<ClaudeInterruptOutcome> {
    if (this.#active !== active || active.ended) return Promise.resolve(uncertain());
    if (active.interruptPromise !== undefined) return active.interruptPromise;
    active.interruptRequested = true;
    active.interruptPromise = Promise.resolve()
      .then(() => active.query.interrupt())
      .then((receipt) => acknowledgedReceipt(receipt) ? acknowledged() : uncertain())
      .catch(() => uncertain());
    return active.interruptPromise;
  }
  #steer(active: Active, prompt: string): Promise<ClaudeSteerOutcome> {
    if (!this.#canSteer(active) || active.steerPromise !== undefined) {
      return Promise.resolve(rejectedSteer());
    }
    const captured = contentText(prompt, CLAUDE_EXECUTION_MAX_PROMPT_BYTES);
    if (captured === null) return Promise.resolve(rejectedSteer());
    const steering = Promise.resolve()
      .then(() => {
        if (!this.#canSteer(active)) throw new Error("CLAUDE_STEER_UNAVAILABLE");
        return active.query.streamInput(oneMessage(captured));
      })
      // A fulfilled streamInput call means the provider consumed this exact
      // message. The Query may legitimately finish immediately afterward;
      // rechecking local liveness here would turn a delivered steer into a
      // false rejection.
      .then(() => acceptedSteer())
      .catch(() => rejectedSteer())
      .finally(() => {
        if (active.steerPromise === steering) active.steerPromise = undefined;
      });
    active.steerPromise = steering;
    return steering;
  }
  #canSteer(active: Active): boolean {
    return this.#active === active && !active.closed && !active.ended && !active.resultSeen && !active.interruptRequested;
  }
  #close(active: Active): void {
    if (active.closed) return;
    active.closed = true;
    active.input.close();
    try { active.query.close(); } catch { /* local close has no execution meaning */ }
  }
  #emit(fact: RelayClaudeFact): boolean {
    const parsed = parseRelayClaudeFactMessage({
      type: "relay:claude-fact",
      version: CLAUDE_RELAY_PROTOCOL_VERSION,
      eventSequence: ++this.#factSequence,
      fact,
    });
    if (!parsed.ok) return false;
    try {
      this.#options.onFact(parsed.value.fact);
      return true;
    } catch {
      return false;
    }
  }
  #emitFailure(): void {
    this.#emit({ kind: "host_failure", code: "CLAUDE_SDK_FAILURE" });
  }
}
export function isReviewedClaudeRuntime(executable: ResolvedClaudeExecutable): boolean {
  return isReviewedClaudeCodeVersion(executable.version) &&
    REQUIRED_CLAUDE_RUNTIME_FEATURES.every((feature) => executable.features[feature]);
}
interface QueryPort {
  readonly next: () => Promise<IteratorResult<unknown>>;
  readonly interrupt: () => Promise<unknown>;
  readonly streamInput: (input: AsyncIterable<SDKUserMessage>) => Promise<unknown>;
  readonly close: () => void;
  readonly accountInfo: () => Promise<unknown>;
  readonly supportedModels: () => Promise<unknown>;
}
interface Active {
  readonly input: ClaudeInputQueue;
  readonly observations: ObservationQueue;
  query: QueryPort;
  closed: boolean;
  ended: boolean;
  resultSeen: boolean;
  interruptRequested: boolean;
  readonly outputParts: string[];
  interruptPromise: Promise<ClaudeInterruptOutcome> | undefined;
  steerPromise: Promise<ClaudeSteerOutcome> | undefined;
}
interface QuestionView {
  readonly text: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly allowOther: true;
  readonly options: readonly Readonly<{ label: string; description: string }>[];
}
interface Question {
  readonly questions: readonly QuestionView[];
  readonly official: readonly Readonly<{ question: string; header: string; multiSelect: boolean; options: readonly Readonly<{ label: string; description: string }>[] }>[];
}
function captureLaunch(value: ClaudeLaunchRequest): Readonly<{ prompt: string; workingDirectory: string; model: string }> | null {
  const prompt = contentText(own(value, "prompt"), CLAUDE_EXECUTION_MAX_PROMPT_BYTES);
  const workingDirectory = completeText(own(value, "workingDirectory"));
  const model = text(own(value, "model"), CLAUDE_EXECUTION_MAX_TEXT_BYTES);
  return prompt === null || workingDirectory === null || model === null ? null : Object.freeze({ prompt, workingDirectory, model });
}
function captureQuery(value: unknown): QueryPort | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const iterator: unknown = Reflect.get(value, Symbol.asyncIterator);
    const interrupt: unknown = Reflect.get(value, "interrupt");
    const streamInput: unknown = Reflect.get(value, "streamInput");
    const close: unknown = Reflect.get(value, "close");
    const accountInfo: unknown = Reflect.get(value, "accountInfo");
    const supportedModels: unknown = Reflect.get(value, "supportedModels");
    if (typeof iterator !== "function" || typeof interrupt !== "function" || typeof streamInput !== "function" || typeof close !== "function" ||
      typeof accountInfo !== "function" || typeof supportedModels !== "function") return null;
    const source: unknown = Reflect.apply(iterator, value, []);
    if (typeof source !== "object" || source === null) return null;
    const next: unknown = Reflect.get(source, "next");
    if (typeof next !== "function") return null;
    return Object.freeze({
      next: () => Promise.resolve(Reflect.apply(next, source, [])).then(iteratorResult),
      interrupt: () => Promise.resolve(Reflect.apply(interrupt, value, [])),
      streamInput: (input: AsyncIterable<SDKUserMessage>) => Promise.resolve(Reflect.apply(streamInput, value, [input])),
      close: () => { Reflect.apply(close, value, []); },
      accountInfo: () => Promise.resolve(Reflect.apply(accountInfo, value, [])),
      supportedModels: () => Promise.resolve(Reflect.apply(supportedModels, value, [])),
    });
  } catch {
    return null;
  }
}
function iteratorResult(value: unknown): IteratorResult<unknown> {
  const done = own(value, "done");
  if (typeof done !== "boolean") throw new Error("invalid iterator");
  return done ? { done: true, value: undefined as never } : { done: false, value: own(value, "value") };
}
function captureQuestion(input: unknown): Question | null | false {
  if (own(input, "questions") === undefined) return null;
  const rawQuestions = own(input, "questions");
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) return false;
  const questions: Array<{
    text: string; header: string; multiSelect: boolean; allowOther: true;
    options: readonly Readonly<{ label: string; description: string }>[];
  }> = [];
  const official: Array<Readonly<{ question: string; header: string; multiSelect: boolean; options: readonly Readonly<{ label: string; description: string }>[] }>> = [];
  const seen = new Set<string>();
  for (const raw of rawQuestions) {
    const question = contentText(own(raw, "question"), 4 * 1024);
    const header = contentText(own(raw, "header"), 320);
    const multiSelect = own(raw, "multiSelect");
    const rawOptions = own(raw, "options");
    if (question === null || header === null || typeof multiSelect !== "boolean" || seen.has(question) ||
      !Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 4) return false;
    seen.add(question);
    const labels = new Set<string>();
    const options: Array<Readonly<{ label: string; description: string }>> = [];
    for (const rawOption of rawOptions) {
      const label = contentText(own(rawOption, "label"), 4 * 1024);
      const description = contentText(own(rawOption, "description"), 4 * 1024);
      if (label === null || description === null || labels.has(label)) return false;
      labels.add(label);
      options.push(Object.freeze({ label, description }));
    }
    const frozenOptions = Object.freeze(options);
    questions.push(Object.freeze({ text: question, header, multiSelect, allowOther: true, options: frozenOptions }));
    official.push(Object.freeze({ question, header, multiSelect, options: frozenOptions }));
  }
  return Object.freeze({ questions: Object.freeze(questions), official: Object.freeze(official) });
}
function acceptedAnswers(value: Readonly<Record<string, string>>, question: Question): Readonly<Record<string, string>> | null {
  try {
    const keys = Object.keys(value);
    if (keys.length !== question.questions.length || keys.some((key) => !question.questions.some((item) => item.text === key))) return null;
    const answers = Object.create(null) as Record<string, string>;
    for (const key of keys) {
      const answer = contentText(Object.getOwnPropertyDescriptor(value, key)?.value, 4 * 1024);
      if (answer === null) return null;
      answers[key] = answer;
    }
    return Object.freeze(answers);
  } catch {
    return null;
  }
}
function acknowledgedReceipt(value: unknown): boolean {
  const queued = own(value, "still_queued");
  return Array.isArray(queued) && queued.length === 0;
}
function stale(active: Active, signal: AbortSignal): boolean {
  return active.closed || active.ended || active.interruptRequested || aborted(signal);
}
function allow(toolUseID: string, updatedInput?: Record<string, unknown>): PermissionResult {
  return Object.freeze({
    behavior: "allow",
    toolUseID,
    decisionClassification: "user_temporary",
    ...(updatedInput === undefined ? {} : { updatedInput }),
  });
}
function deny(toolUseID: string | undefined): PermissionResult {
  return Object.freeze({
    behavior: "deny",
    message: "Nautilo denied this action",
    ...(toolUseID === undefined ? {} : { toolUseID }),
    decisionClassification: "user_reject",
  });
}
function acknowledged(): ClaudeInterruptOutcome {
  return Object.freeze({ outcome: "acknowledged" });
}
function uncertain(): ClaudeInterruptOutcome {
  return Object.freeze({ outcome: "uncertain" });
}
function acceptedSteer(): ClaudeSteerOutcome { return Object.freeze({ outcome: "accepted" }); }
function rejectedSteer(): ClaudeSteerOutcome { return Object.freeze({ outcome: "rejected" }); }
function oneMessage(prompt: string): AsyncIterable<SDKUserMessage> {
  const message: SDKUserMessage = Object.freeze({
    type: "user",
    message: Object.freeze({ role: "user", content: prompt }),
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
  });
  let delivered = false;
  return Object.freeze({
    [Symbol.asyncIterator]: (): AsyncIterator<SDKUserMessage> => Object.freeze({
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (delivered) return Promise.resolve({ done: true, value: undefined as never });
        delivered = true;
        return Promise.resolve({ done: false, value: message });
      },
    }),
  });
}
function unavailableHandle(): ClaudeLaunchHandle {
  const observations = new ObservationQueue();
  observations.settle(Object.freeze({ kind: "settled", settlement: "rejected", afterResult: false }));
  return Object.freeze({ available: false, observations, interrupt: () => Promise.resolve(uncertain()), steer: () => Promise.resolve(rejectedSteer()), close: () => undefined });
}
function own(value: unknown, key: string): unknown {
  try {
    if (typeof value !== "object" || value === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined || !("value" in descriptor) ? undefined : descriptor.value;
  } catch {
    return undefined;
  }
}
function text(value: unknown, maximum: number): string | null {
  const captured = contentText(value, maximum);
  if (captured === null) return null;
  for (const character of captured) {
    const point = character.codePointAt(0);
    if (point !== undefined && point < 32) return null;
  }
  return captured;
}
// Human/provider content is not an identifier. Preserve ordinary whitespace
// exactly while retaining the existing well-formedness and payload boundary.
function contentText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !wellFormed(value)) return null;
  if (new TextEncoder().encode(value).byteLength > maximum) return null;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && ((point < 32 && point !== 9 && point !== 10 && point !== 13) || point === 127)) return null;
  }
  return value;
}
function completeText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value)) return null;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point < 32 || point === 127)) return null;
  }
  return value;
}
function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function isSignal(value: unknown): value is AbortSignal {
  try {
    return typeof value === "object" && value !== null && typeof Reflect.get(value, "aborted") === "boolean";
  } catch {
    return false;
  }
}
function aborted(signal: AbortSignal | undefined): boolean {
  try { return signal?.aborted === true; } catch { return true; }
}
function emptyAccount(value: unknown): boolean {
  return ["email", "organization", "subscriptionType", "tokenSource", "apiKeySource", "apiProvider"].every((key) => own(value, key) === undefined);
}
class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  #messages: SDKUserMessage[] = [];
  #waiter: ((value: IteratorResult<SDKUserMessage>) => void) | undefined;
  #closed = false;
  push(message: SDKUserMessage): void {
    if (this.#closed) throw new Error("input closed");
    const waiter = this.#waiter;
    if (waiter === undefined) this.#messages.push(message);
    else {
      this.#waiter = undefined;
      waiter({ done: false, value: message });
    }
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ done: true, value: undefined as never });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message !== undefined) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined as never });
        return new Promise((resolve) => { this.#waiter = resolve; });
      },
    };
  }
}
class ObservationQueue implements AsyncIterable<ClaudeExecutionObservation> {
  #messages: ClaudeExecutionObservation[] = [];
  #waiter: ((value: IteratorResult<ClaudeExecutionObservation>) => void) | undefined;
  #closed = false;
  #used = false;
  push(observation: ClaudeExecutionObservation): boolean {
    if (this.#closed) return false;
    const frozen = Object.freeze({ ...observation }) as ClaudeExecutionObservation;
    if (this.#messages.length >= CLAUDE_EXECUTION_MAX_QUEUED_EVENTS) return false;
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter({ done: false, value: frozen });
    } else {
      this.#messages.push(frozen);
    }
    return true;
  }
  settle(observation: ClaudeExecutionObservation): void {
    if (!this.#closed) this.push(observation);
    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ done: true, value: undefined as never });
  }
  [Symbol.asyncIterator](): AsyncIterator<ClaudeExecutionObservation> {
    if (this.#used) return { next: () => Promise.resolve({ done: true, value: undefined as never }) };
    this.#used = true;
    return {
      next: () => {
        const message = this.#messages.shift();
        if (message !== undefined) return Promise.resolve({ done: false, value: message });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined as never });
        return new Promise((resolve) => { this.#waiter = resolve; });
      },
    };
  }
}
export const CLAUDE_AGENT_SDK_LIBRARY_VERSION = CLAUDE_AGENT_SDK_VERSION;
export const defaultClaudeAgentSdk = Object.freeze({ query });
