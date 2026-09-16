/**
 * D452 v18 Claude execution transport.
 *
 * This is deliberately only the current Desktop socket transport. It does
 * not own an execution broker, ordering ledger, replay cache, or terminal
 * lifecycle. The injected Desktop host owns those local concerns.
 */
import { claudePermissionDetailSchema, type ClaudePermissionDetail } from "@nautilo/types";
export { claudePermissionDetailSchema, type ClaudePermissionDetail } from "@nautilo/types";
export const CLAUDE_EXECUTION_PROTOCOL_VERSION = 18 as const;
export const CLAUDE_PERMISSION_DETAIL_PROTOCOL_VERSION = 20 as const;
export const CLAUDE_EXECUTION_MAX_FRAME_BYTES = 128 * 1024;
export const CLAUDE_EXECUTION_MAX_PROMPT_BYTES = 16 * 1024;
export const CLAUDE_EXECUTION_MAX_TEXT_BYTES = 320;
export const CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES = 48 * 1024;
/** One shared transient backpressure boundary at both local queue hops. */
export const CLAUDE_EXECUTION_MAX_QUEUED_EVENTS = 32;
export const CLAUDE_EXECUTION_MAX_QUESTIONS = 4;
export const CLAUDE_EXECUTION_MAX_OPTIONS = 4;

export type RelayClaudeExecutionSocketScope = Readonly<{
  relayId: string;
  relaySessionId: string;
  desktopSessionId: string;
  pairingGenerationRef: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
}>;

export type RelayClaudeExecutionResponse =
  | Readonly<{ kind: "allow_once" }>
  | Readonly<{ kind: "deny" }>
  | Readonly<{ kind: "answers"; answers: Readonly<Record<string, readonly string[]>> }>;

export type RelayClaudeExecutionCommand = Readonly<{
  type: "relay:claude-execution-command";
  scope: RelayClaudeExecutionSocketScope;
  executionRef: string;
  action:
    | Readonly<{ kind: "start"; prompt: string; model: string }>
    | Readonly<{ kind: "steer"; steerRef: string; prompt: string }>
    | Readonly<{ kind: "respond"; interactionRef: string; response: RelayClaudeExecutionResponse }>
    | Readonly<{ kind: "interrupt" }>;
}>;

export type RelayClaudeExecutionQuestion = Readonly<{
  questionRef: string;
  header: string;
  text: string;
  multiSelect: boolean;
  allowOther: true;
  options: readonly Readonly<{ optionRef: string; label: string; description: string }>[];
}>;

export type RelayClaudeExecutionInteraction =
  | Readonly<{
      kind: "permission";
      interactionRef: string;
      toolName: string;
      allowSession: false;
      detail?: ClaudePermissionDetail;
    }>
  | Readonly<{
      kind: "question";
      interactionRef: string;
      questions: readonly RelayClaudeExecutionQuestion[];
    }>;

export type RelayClaudeExecutionEvent =
  | Readonly<{ kind: "started" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{
      kind: "activity";
      activity: "setup" | "hook" | "tool";
      state: "started" | "progress" | "completed" | "requested";
      toolName?: string;
    }>
  /** Display-only observation; it is never selected-model admission authority. */
  | Readonly<{ kind: "initialized"; claudeCodeVersion: string; servingModel: string }>
  | Readonly<{ kind: "output_delta"; text: string }>
  | Readonly<{
      kind: "result";
      outcome: "success" | "failed" | "interrupted";
      text: string | null;
    }>
  | Readonly<{ kind: "settled"; outcome: "eof" | "rejected" }>
  | Readonly<{ kind: "interaction"; interaction: RelayClaudeExecutionInteraction }>
  | Readonly<{ kind: "interaction_accepted"; interactionRef: string }>
  | Readonly<{ kind: "interaction_rejected"; interactionRef: string }>
  | Readonly<{ kind: "steer_receipt"; steerRef: string; outcome: "accepted" | "rejected" }>
  | Readonly<{ kind: "interrupt_receipt"; outcome: "acknowledged" | "uncertain" }>;

export type RelayClaudeExecutionDesktopEvent = Readonly<{
  type: "relay:claude-execution-event";
  scope: RelayClaudeExecutionSocketScope;
  executionRef: string;
  event: RelayClaudeExecutionEvent;
}>;

export type ClaudeExecutionParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: "CLAUDE_EXECUTION_FRAME_INVALID" }>;

const encoder = new TextEncoder();
const scopeKeys = [
  "relayId",
  "relaySessionId",
  "desktopSessionId",
  "pairingGenerationRef",
  "selectedProtocolVersion",
  "capabilityRevision",
] as const;

type CapturedRecord = Readonly<Record<string, unknown> & {
  type?: unknown;
  scope?: unknown;
  executionRef?: unknown;
  action?: unknown;
  relayId?: unknown;
  relaySessionId?: unknown;
  desktopSessionId?: unknown;
  pairingGenerationRef?: unknown;
  selectedProtocolVersion?: unknown;
  capabilityRevision?: unknown;
  kind?: unknown;
  prompt?: unknown;
  model?: unknown;
  interactionRef?: unknown;
  steerRef?: unknown;
  response?: unknown;
  answers?: unknown;
  activity?: unknown;
  state?: unknown;
  toolName?: unknown;
  claudeCodeVersion?: unknown;
  servingModel?: unknown;
  outcome?: unknown;
  text?: unknown;
  event?: unknown;
  interaction?: unknown;
  allowSession?: unknown;
  questions?: unknown;
  questionRef?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  allowOther?: unknown;
  options?: unknown;
  optionRef?: unknown;
  label?: unknown;
  description?: unknown;
  detail?: unknown;
}>;

export function parseRelayClaudeExecutionCommand(
  value: unknown,
): RelayClaudeExecutionCommand | null {
  try {
    const record = exactRecord(value, ["type", "scope", "executionRef", "action"]);
    if (record === null || record.type !== "relay:claude-execution-command") return null;
    const scope = parseScope(record.scope);
    const executionRef = text(record.executionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const action = parseAction(record.action);
    if (scope === null || executionRef === null || action === null) return null;
    const parsed = freeze<RelayClaudeExecutionCommand>({ type: "relay:claude-execution-command", scope, executionRef, action });
    return frameWithinLimit(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseRelayClaudeExecutionDesktopEvent(
  value: unknown,
): RelayClaudeExecutionDesktopEvent | null {
  try {
    const record = exactRecord(value, ["type", "scope", "executionRef", "event"]);
    if (record === null || record.type !== "relay:claude-execution-event") return null;
    const scope = parseScope(record.scope);
    const executionRef = text(record.executionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const event = parseEvent(record.event);
    if (scope === null || executionRef === null || event === null) return null;
    if (event.kind === "interaction" && event.interaction.kind === "permission" && event.interaction.detail !== undefined && scope.selectedProtocolVersion < CLAUDE_PERMISSION_DETAIL_PROTOCOL_VERSION) return null;
    const parsed = freeze<RelayClaudeExecutionDesktopEvent>({ type: "relay:claude-execution-event", scope, executionRef, event });
    return frameWithinLimit(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseRelayClaudeExecutionJsonFrame(
  raw: string,
  direction: "server" | "client",
): ClaudeExecutionParseResult<RelayClaudeExecutionCommand | RelayClaudeExecutionDesktopEvent> {
  if (encoder.encode(raw).byteLength > CLAUDE_EXECUTION_MAX_FRAME_BYTES) return invalid();
  try {
    const value = JSON.parse(raw) as unknown;
    const parsed = direction === "server"
      ? parseRelayClaudeExecutionCommand(value)
      : parseRelayClaudeExecutionDesktopEvent(value);
    return parsed === null ? invalid() : { ok: true, value: parsed };
  } catch {
    return invalid();
  }
}

export function isRelayClaudeExecutionFrameType(value: string | null): boolean {
  return value === "relay:claude-execution-command" || value === "relay:claude-execution-event";
}

function parseScope(value: unknown): RelayClaudeExecutionSocketScope | null {
  const record = exactRecord(value, scopeKeys);
  if (record === null) return null;
  const relayId = text(record.relayId, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
  const relaySessionId = text(record.relaySessionId, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
  const desktopSessionId = text(record.desktopSessionId, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
  const pairingGenerationRef = text(record.pairingGenerationRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
  const selectedProtocolVersion = positiveInteger(record.selectedProtocolVersion);
  const capabilityRevision = nonNegativeInteger(record.capabilityRevision);
  if (
    relayId === null || relaySessionId === null || desktopSessionId === null || pairingGenerationRef === null ||
    selectedProtocolVersion === null || selectedProtocolVersion < CLAUDE_EXECUTION_PROTOCOL_VERSION ||
    capabilityRevision === null
  ) return null;
  return freeze({ relayId, relaySessionId, desktopSessionId, pairingGenerationRef, selectedProtocolVersion, capabilityRevision });
}

function parseAction(value: unknown): RelayClaudeExecutionCommand["action"] | null {
  const kind = recordKind(value);
  if (kind === null) return null;
  if (kind.kind === "start") {
    const record = exactRecord(value, ["kind", "prompt", "model"]);
    const prompt = record === null ? null : text(record.prompt, CLAUDE_EXECUTION_MAX_PROMPT_BYTES);
    const model = record === null ? null : text(record.model, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    return prompt === null || model === null ? null : freeze({ kind: "start", prompt, model });
  }
  if (kind.kind === "steer") {
    const record = exactRecord(value, ["kind", "steerRef", "prompt"]);
    const steerRef = record === null ? null : text(record.steerRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const prompt = record === null ? null : text(record.prompt, CLAUDE_EXECUTION_MAX_PROMPT_BYTES);
    return steerRef === null || prompt === null ? null : freeze({ kind: "steer", steerRef, prompt });
  }
  if (kind.kind === "interrupt") return exactRecord(value, ["kind"]) === null ? null : freeze({ kind: "interrupt" });
  if (kind.kind !== "respond") return null;
  const record = exactRecord(value, ["kind", "interactionRef", "response"]);
  const interactionRef = record === null ? null : text(record.interactionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
  const response = record === null ? null : parseResponse(record.response);
  return interactionRef === null || response === null ? null : freeze({ kind: "respond", interactionRef, response });
}

function parseResponse(value: unknown): RelayClaudeExecutionResponse | null {
  const kind = recordKind(value);
  if (kind === null) return null;
  if (kind.kind === "allow_once" || kind.kind === "deny") {
    return exactRecord(value, ["kind"]) === null ? null : freeze({ kind: kind.kind });
  }
  if (kind.kind !== "answers") return null;
  const record = exactRecord(value, ["kind", "answers"]);
  const answers = record === null ? null : parseAnswers(record.answers);
  return answers === null ? null : freeze({ kind: "answers", answers });
}

function parseAnswers(value: unknown): Readonly<Record<string, readonly string[]>> | null {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = ownDataKeys(value, CLAUDE_EXECUTION_MAX_QUESTIONS);
  if (keys === null || Array.isArray(value)) return null;
  const answers: Record<string, readonly string[]> = Object.create(null) as Record<string, readonly string[]>;
  for (const key of keys) {
    if (text(key, CLAUDE_EXECUTION_MAX_TEXT_BYTES) === null) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    const answer = parseStringArray(descriptor.value, CLAUDE_EXECUTION_MAX_OPTIONS + 1, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    if (answer === null) return null;
    Object.defineProperty(answers, key, { value: answer, enumerable: true });
  }
  return freeze(answers);
}

function parseEvent(value: unknown): RelayClaudeExecutionEvent | null {
  const kind = recordKind(value);
  if (kind === null) return null;
  if (kind.kind === "started" || kind.kind === "unavailable") {
    return exactRecord(value, ["kind"]) === null ? null : freeze({ kind: kind.kind });
  }
  if (kind.kind === "activity") {
    const record = exactRecordWithOptional(value, ["kind", "activity", "state"], ["toolName"]);
    if (
      record === null ||
      (record.activity !== "setup" && record.activity !== "hook" && record.activity !== "tool") ||
      (record.state !== "started" && record.state !== "progress" && record.state !== "completed" && record.state !== "requested")
    ) return null;
    if (record.toolName === undefined) return freeze({ kind: "activity", activity: record.activity, state: record.state });
    if (record.activity !== "tool") return null;
    const toolName = text(record.toolName, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    if (toolName === null) return null;
    return freeze({ kind: "activity", activity: record.activity, state: record.state, toolName });
  }
  if (kind.kind === "initialized") {
    const record = exactRecord(value, ["kind", "claudeCodeVersion", "servingModel"]);
    const claudeCodeVersion = record === null ? null : text(record.claudeCodeVersion, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const servingModel = record === null ? null : text(record.servingModel, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    return claudeCodeVersion === null || servingModel === null ? null : freeze({ kind: "initialized", claudeCodeVersion, servingModel });
  }
  if (kind.kind === "output_delta") {
    const record = exactRecord(value, ["kind", "text"]);
    const textValue = record === null ? null : outputDeltaText(record.text);
    return textValue === null ? null : freeze({ kind: "output_delta", text: textValue });
  }
  if (kind.kind === "result") return parseResult(value);
  if (kind.kind === "settled") {
    const record = exactRecord(value, ["kind", "outcome"]);
    return record !== null && (record.outcome === "eof" || record.outcome === "rejected")
      ? freeze({ kind: "settled", outcome: record.outcome }) : null;
  }
  if (kind.kind === "interaction") {
    const record = exactRecord(value, ["kind", "interaction"]);
    const interaction = record === null ? null : parseInteraction(record.interaction);
    return interaction === null ? null : freeze({ kind: "interaction", interaction });
  }
  if (kind.kind === "interaction_accepted" || kind.kind === "interaction_rejected") {
    const record = exactRecord(value, ["kind", "interactionRef"]);
    const interactionRef = record === null ? null : text(record.interactionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    return interactionRef === null ? null : freeze({ kind: kind.kind, interactionRef });
  }
  if (kind.kind === "steer_receipt") {
    const record = exactRecord(value, ["kind", "steerRef", "outcome"]);
    const steerRef = record === null ? null : text(record.steerRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    return steerRef === null || (record?.outcome !== "accepted" && record?.outcome !== "rejected")
      ? null : freeze({ kind: "steer_receipt", steerRef, outcome: record.outcome });
  }
  if (kind.kind === "interrupt_receipt") {
    const record = exactRecord(value, ["kind", "outcome"]);
    return record !== null && (record.outcome === "acknowledged" || record.outcome === "uncertain")
      ? freeze({ kind: "interrupt_receipt", outcome: record.outcome }) : null;
  }
  return null;
}

function parseResult(value: unknown): RelayClaudeExecutionEvent | null {
  const record = exactRecord(value, ["kind", "outcome", "text"]);
  if (record === null || (record.outcome !== "success" && record.outcome !== "failed" && record.outcome !== "interrupted")) return null;
  if (record.text !== null) return null;
  return freeze({ kind: "result", outcome: record.outcome, text: null });
}

function parseInteraction(value: unknown): RelayClaudeExecutionInteraction | null {
  const kind = recordKind(value);
  if (kind === null) return null;
  if (kind.kind === "permission") {
    const hasDetail = Object.hasOwn(value as object, "detail");
    const record = exactRecord(value, hasDetail ? ["kind", "interactionRef", "toolName", "allowSession", "detail"] : ["kind", "interactionRef", "toolName", "allowSession"]);
    const interactionRef = record === null ? null : text(record.interactionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const toolName = record === null ? null : text(record.toolName, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const detailRecord = hasDetail ? ownRecord(record?.detail) : null;
    const detail = hasDetail ? claudePermissionDetailSchema.safeParse(detailRecord) : null;
    return interactionRef === null || toolName === null || record?.allowSession !== false || (detail !== null && !detail.success)
      ? null : freeze({ kind: "permission", interactionRef, toolName, allowSession: false, ...(detail?.success ? { detail: detail.data } : {}) });
  }
  if (kind.kind !== "question") return null;
  const record = exactRecord(value, ["kind", "interactionRef", "questions"]);
  const interactionRef = record === null ? null : text(record.interactionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
  const questions = record === null ? null : parseQuestions(record.questions);
  return interactionRef === null || questions === null ? null : freeze({ kind: "question", interactionRef, questions });
}

function parseQuestions(value: unknown): readonly RelayClaudeExecutionQuestion[] | null {
  const entries = arrayEntries(value, CLAUDE_EXECUTION_MAX_QUESTIONS);
  if (entries === null || entries.length === 0) return null;
  const questions: RelayClaudeExecutionQuestion[] = [];
  for (const entry of entries) {
    const record = exactRecord(entry, ["questionRef", "header", "text", "multiSelect", "allowOther", "options"]);
    if (record === null || record.allowOther !== true || typeof record.multiSelect !== "boolean") return null;
    const questionRef = text(record.questionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const header = text(record.header, 4 * 1024);
    const questionText = text(record.text, 4 * 1024);
    const options = parseOptions(record.options);
    if (questionRef === null || header === null || questionText === null || options === null) return null;
    questions.push(freeze({ questionRef, header, text: questionText, multiSelect: record.multiSelect, allowOther: true, options }));
  }
  return freeze(questions);
}

function parseOptions(value: unknown): readonly Readonly<{ optionRef: string; label: string; description: string }>[] | null {
  const entries = arrayEntries(value, CLAUDE_EXECUTION_MAX_OPTIONS);
  if (entries === null || entries.length < 2) return null;
  const options: Readonly<{ optionRef: string; label: string; description: string }>[] = [];
  for (const entry of entries) {
    const record = exactRecord(entry, ["optionRef", "label", "description"]);
    const optionRef = record === null ? null : text(record.optionRef, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const label = record === null ? null : text(record.label, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    const description = record === null ? null : text(record.description, CLAUDE_EXECUTION_MAX_TEXT_BYTES);
    if (optionRef === null || label === null || description === null) return null;
    options.push(freeze({ optionRef, label, description }));
  }
  return freeze(options);
}

function recordKind(value: unknown): CapturedRecord | null {
  const record = ownRecord(value);
  if (record === null || typeof record.kind !== "string") return null;
  return record;
}

function exactRecord(value: unknown, expected: readonly string[]): CapturedRecord | null {
  const record = ownRecord(value);
  if (record === null) return null;
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key)) ? record : null;
}

function exactRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): CapturedRecord | null {
  const record = ownRecord(value);
  if (record === null) return null;
  const keys = Object.keys(record);
  return required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key)) ? record : null;
}

function ownRecord(value: unknown): CapturedRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = ownDataKeys(value, 8);
  if (keys === null) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  return Object.freeze(copy) as CapturedRecord;
}

function ownDataKeys(value: unknown, max: number): string[] | null {
  if (typeof value !== "object" || value === null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length > max || keys.some((key) => typeof key !== "string")) return null;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return null;
  }
  return keys as string[];
}

function arrayEntries(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") return null;
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return null;
  const entries: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return null;
    entries.push(descriptor.value);
  }
  return entries;
}

function parseStringArray(value: unknown, max: number, limit: number): readonly string[] | null {
  const entries = arrayEntries(value, max);
  if (entries === null) return null;
  const parsed: string[] = [];
  for (const entry of entries) {
    const item = text(entry, limit);
    if (item === null) return null;
    parsed.push(item);
  }
  return freeze(parsed);
}

function text(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes || !wellFormed(value) || value.includes("\0")) return null;
  return encoder.encode(value).byteLength <= maxBytes ? value : null;
}

function outputDeltaText(value: unknown): string | null {
  const result = text(value, CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES);
  if (result === null) return null;
  for (const character of result) {
    const point = character.codePointAt(0);
    if (point !== undefined && ((point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      (point >= 0x7f && point <= 0x9f))) return null;
  }
  return result;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function frameWithinLimit(value: unknown): boolean {
  try { return encoder.encode(JSON.stringify(value)).byteLength <= CLAUDE_EXECUTION_MAX_FRAME_BYTES; } catch { return false; }
}

function freeze<T>(value: T): T { return Object.freeze(value); }
function invalid(): ClaudeExecutionParseResult<never> { return { ok: false, error: "CLAUDE_EXECUTION_FRAME_INVALID" }; }
