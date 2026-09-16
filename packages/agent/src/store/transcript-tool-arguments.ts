import { sanitizeToolArgsForEvent } from "../utils/tool-argument-redaction";

const MAX_TRANSCRIPT_TOOL_CALLS = 64;
const MAX_SERIALIZED_TRANSCRIPT_TOOL_CALLS_CHARS = 1_048_576;

export function redactTranscriptToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const safe = sanitizeToolArgsForEvent(args);
  return safe && typeof safe === "object" && !Array.isArray(safe)
    ? safe as Record<string, unknown>
    : {};
}

function sanitizedSerializedArgs(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return redactTranscriptToolArgs(value as Record<string, unknown>);
  }
  if (typeof value !== "string" || value.length > 65_536) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return JSON.stringify(redactTranscriptToolArgs(parsed as Record<string, unknown>));
  } catch {
    // A malformed provider envelope is not safe display data. Never preserve
    // its raw string as a fallback because it can itself contain credentials.
    return {};
  }
}

function sanitizeTranscriptToolCall(
  call: { args?: unknown; [key: string]: unknown },
): Record<string, unknown> {
  const projected = sanitizeToolArgsForEvent(call);
  const output: Record<string, unknown> = projected && typeof projected === "object" && !Array.isArray(projected)
    ? projected as Record<string, unknown>
    : {};
  if ("args" in call) output["args"] = sanitizedSerializedArgs(call.args);
  if ("arguments" in call) {
    output["arguments"] = sanitizedSerializedArgs(call["arguments"]);
  }
  const providerFunction = call["function"];
  if (providerFunction && typeof providerFunction === "object" && !Array.isArray(providerFunction)) {
    const fn = providerFunction as Record<string, unknown>;
    const projectedFunction = output["function"];
    output["function"] = {
      ...(projectedFunction && typeof projectedFunction === "object" && !Array.isArray(projectedFunction)
        ? projectedFunction as Record<string, unknown>
        : {}),
      ...(Object.prototype.hasOwnProperty.call(fn, "arguments")
        ? { arguments: sanitizedSerializedArgs(fn["arguments"]) }
        : {}),
    };
  }
  return output;
}

function transcriptToolCallIdentity(
  call: { args?: unknown; [key: string]: unknown },
): Record<string, unknown> {
  const identity: Record<string, unknown> = {};
  for (const key of ["id", "call_id", "name", "type"] as const) {
    const value = call[key];
    if (typeof value === "string") identity[key] = value.slice(0, 4_096);
  }
  const providerFunction = call["function"];
  if (providerFunction && typeof providerFunction === "object" && !Array.isArray(providerFunction)) {
    const name = (providerFunction as Record<string, unknown>)["name"];
    if (typeof name === "string") identity["function"] = { name: name.slice(0, 4_096) };
  }
  identity["args"] = {};
  return identity;
}

export function serializeTranscriptToolCalls(
  calls: readonly { args?: unknown; [key: string]: unknown }[],
): string {
  const boundedCalls = calls.slice(0, MAX_TRANSCRIPT_TOOL_CALLS);
  const serialized = JSON.stringify(boundedCalls.map(sanitizeTranscriptToolCall));
  if (serialized.length <= MAX_SERIALIZED_TRANSCRIPT_TOOL_CALLS_CHARS) return serialized;
  // Preserve FIFO correlation identity when pathological display arguments
  // exceed the durable sidecar budget; execution/checkpoint state is separate.
  return JSON.stringify(boundedCalls.map(transcriptToolCallIdentity));
}

/** Sanitizes legacy rows at the response boundary as well as new writes. */
export function sanitizeSerializedTranscriptToolCalls(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const calls = parsed.slice(0, MAX_TRANSCRIPT_TOOL_CALLS).filter(
      (call): call is { args?: unknown; [key: string]: unknown } =>
        Boolean(call) && typeof call === "object" && !Array.isArray(call),
    );
    return calls.length > 0 ? serializeTranscriptToolCalls(calls) : null;
  } catch {
    return null;
  }
}
