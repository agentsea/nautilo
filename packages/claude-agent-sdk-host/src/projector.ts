import type { AccountInfo, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES,
  CLAUDE_RELAY_MAX_TEXT_BYTES,
  type RelayClaudeAccount,
  type RelayClaudeModel,
} from "@nautilo/relay";
import type { ClaudeExecutionObservation } from "./contracts";

const providers = new Set(["firstParty", "bedrock", "vertex", "foundry", "anthropicAws", "anthropicGoogleCloud", "mantle", "gateway"]);

/** Existing discovery account projection; execution never exposes account facts. */
export function projectAccountInfo(account: AccountInfo): RelayClaudeAccount {
  const projected = {
    state: "connected",
    ...textField("email", own(account, "email"), CLAUDE_RELAY_MAX_TEXT_BYTES),
    ...textField("organization", own(account, "organization"), CLAUDE_RELAY_MAX_TEXT_BYTES),
    ...textField("subscriptionType", own(account, "subscriptionType"), CLAUDE_RELAY_MAX_TEXT_BYTES),
    ...textField("tokenSource", own(account, "tokenSource"), CLAUDE_RELAY_MAX_TEXT_BYTES),
    ...textField("apiKeySource", own(account, "apiKeySource"), CLAUDE_RELAY_MAX_TEXT_BYTES),
    ...(providers.has(own(account, "apiProvider") as string) ? { apiProvider: own(account, "apiProvider") as RelayClaudeAccount["apiProvider"] } : {}),
  } as RelayClaudeAccount;
  return Object.freeze(projected);
}

/** Existing discovery catalog projection. Invalid entries make completeness false. */
export function projectSupportedModels(models: readonly ModelInfo[]): readonly RelayClaudeModel[] {
  if (!Array.isArray(models)) return Object.freeze([]);
  const result: RelayClaudeModel[] = [];
  for (const model of models) {
    const id = text(own(model, "value"), CLAUDE_RELAY_MAX_TEXT_BYTES);
    const displayName = text(own(model, "displayName"), CLAUDE_RELAY_MAX_TEXT_BYTES);
    const description = text(own(model, "description"), CLAUDE_RELAY_MAX_TEXT_BYTES);
    if (id === null || displayName === null || description === null) continue;
    const resolvedModel = text(own(model, "resolvedModel"), CLAUDE_RELAY_MAX_TEXT_BYTES);
    result.push(Object.freeze({
      id,
      displayName,
      description,
      ...(resolvedModel === null ? {} : { resolvedModel }),
      ...(typeof own(model, "supportsEffort") === "boolean" ? { supportsEffort: own(model, "supportsEffort") as boolean } : {}),
      ...(typeof own(model, "supportsAdaptiveThinking") === "boolean" ? { supportsAdaptiveThinking: own(model, "supportsAdaptiveThinking") as boolean } : {}),
      ...(typeof own(model, "supportsFastMode") === "boolean" ? { supportsFastMode: own(model, "supportsFastMode") as boolean } : {}),
      ...(typeof own(model, "supportsAutoMode") === "boolean" ? { supportsAutoMode: own(model, "supportsAutoMode") as boolean } : {}),
    }));
  }
  return Object.freeze(result);
}

/** Unknown messages are ignored. A malformed relevant message returns null. */
export type ProjectedClaudeExecutionObservation =
  | Exclude<ClaudeExecutionObservation, Readonly<{ kind: "result"; outcome: "succeeded" }>>
  /** Internal boundary used to validate the SDK result against only the final
   * root assistant message. It is never relayed as a public observation. */
  | Readonly<{ kind: "output_message_started" }>
  | Readonly<{ kind: "result"; outcome: "succeeded"; candidate: string }>;

export function projectClaudeExecutionMessage(message: unknown): readonly ProjectedClaudeExecutionObservation[] | null {
  const type = own(message, "type");
  if (type === "system") {
    const subtype = own(message, "subtype");
    if (subtype === "init") {
      const model = text(own(message, "model"), CLAUDE_RELAY_MAX_TEXT_BYTES);
      const claudeCodeVersion = text(own(message, "claude_code_version"), CLAUDE_RELAY_MAX_TEXT_BYTES);
      return model === null || claudeCodeVersion === null ? null : frozen([{ kind: "initialized", model, claudeCodeVersion }]);
    }
    if (subtype === "hook_started") return frozen([{ kind: "activity", activity: "hook", state: "started" }]);
    if (subtype === "hook_progress") return frozen([{ kind: "activity", activity: "hook", state: "progress" }]);
    if (subtype === "hook_response") return frozen([{ kind: "activity", activity: "hook", state: "completed" }]);
    return frozen([]);
  }
  if (type === "assistant") {
    if (own(message, "parent_tool_use_id") !== null) return frozen([]);
    const content = own(own(message, "message"), "content");
    if (!Array.isArray(content) || content.length > 128) return null;
    const result: ProjectedClaudeExecutionObservation[] = [];
    for (const block of content) {
      if (own(block, "type") !== "tool_use") continue;
      const toolName = text(own(block, "name"), 160);
      if (toolName === null) return null;
      result.push(Object.freeze({ kind: "activity", activity: "tool", state: "requested", toolName }));
    }
    return Object.freeze(result);
  }
  if (type === "stream_event") {
    // Partial messages form the lossless root-scoped output stream. The SDK's
    // result independently proves that the final assistant message is
    // complete and exact. Earlier assistant messages in the same turn (for
    // example, text before a tool request or a steer) remain visible but are
    // not part of result.result.
    if (own(message, "parent_tool_use_id") !== null) return frozen([]);
    const event = own(message, "event");
    if (own(event, "type") === "message_start") return frozen([{ kind: "output_message_started" }]);
    if (own(event, "type") !== "content_block_delta") return frozen([]);
    const delta = own(event, "delta");
    if (own(delta, "type") !== "text_delta") return frozen([]);
    const value = deltaText(own(delta, "text"));
    return value === null ? null : frozen([{ kind: "output_delta", text: value }]);
  }
  if (type === "tool_progress") {
    if (own(message, "parent_tool_use_id") !== null) return frozen([]);
    const toolName = text(own(message, "tool_name"), 160);
    return toolName === null ? null : frozen([{ kind: "activity", activity: "tool", state: "progress", toolName }]);
  }
  if (type !== "result") return frozen([]);
  const subtype = own(message, "subtype");
  const isError = own(message, "is_error");
  const terminalReason = own(message, "terminal_reason");
  if (typeof subtype !== "string" || typeof isError !== "boolean") return null;
  if (terminalReason === "aborted_streaming" || terminalReason === "aborted_tools") return frozen([{ kind: "result", outcome: "interrupted" }]);
  if (subtype !== "success" || isError) return frozen([{ kind: "result", outcome: "failed" }]);
  const candidate = resultText(own(message, "result"));
  return candidate === null ? null : frozen([{ kind: "result", outcome: "succeeded", candidate }]);
}

function frozen(values: readonly ProjectedClaudeExecutionObservation[]): readonly ProjectedClaudeExecutionObservation[] {
  return Object.freeze(values.map((value) => Object.freeze({ ...value }) as ProjectedClaudeExecutionObservation));
}

function textField<Key extends "email" | "organization" | "subscriptionType" | "tokenSource" | "apiKeySource">(
  key: Key,
  value: unknown,
  maximum: number,
): { readonly [Property in Key]?: string } {
  const result = text(value, maximum);
  return result === null ? {} : { [key]: result } as { readonly [Property in Key]: string };
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !wellFormed(value)) return null;
  if (new TextEncoder().encode(value).byteLength > maximum) return null;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point < 32 || point === 127)) return null;
  }
  return value;
}

function resultText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && wellFormed(value) ? value : null;
}

function deltaText(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES ||
    value.includes("\0") || !wellFormed(value)
  ) return null;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point !== undefined && ((point < 32 && point !== 9 && point !== 10 && point !== 13) ||
      (point >= 0x7f && point <= 0x9f))) return null;
  }
  return new TextEncoder().encode(value).byteLength <= CLAUDE_EXECUTION_MAX_OUTPUT_DELTA_BYTES ? value : null;
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
