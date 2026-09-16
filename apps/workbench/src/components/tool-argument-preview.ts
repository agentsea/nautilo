/** Canonical, bounded display boundary for untrusted tool arguments. */

import {
  projectTaskTranscriptToolArgs,
  projectTaskTranscriptToolResult,
} from "@nautilo/types";

const REDACTED = "[redacted]";
const OMITTED = "[omitted]";
const MAX_DEPTH = 5;
const MAX_OBJECT_ENTRIES = 64;
const MAX_ARRAY_ITEMS = 64;
const MAX_STRING_CHARS = 4_096;
const MAX_PREVIEW_ARGS = 3;
const MAX_PREVIEW_VALUE_CHARS = 40;
const MAX_SERIALIZED_ARGS_CHARS = 65_536;
const MAX_DISPLAY_KEY_CHARS = 128;
const MAX_DISPLAY_NAME_CHARS = 256;
const MAX_PROJECTED_NODES = 512;
const BEARER_CREDENTIAL = /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const JWT_LIKE_CREDENTIAL = /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\b/g;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSensitiveToolArgumentKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized === "auth" ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("apikey") ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized === "cursor" ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("passphrase") ||
    normalized.includes("privatekey") ||
    normalized === "cookie" ||
    normalized.endsWith("cookie") ||
    normalized === "pin" ||
    normalized === "approvalpin" ||
    normalized === "adminpin" ||
    normalized === "ownerpin" ||
    normalized === "securitypin" ||
    normalized === "otp"
  );
}

function isToolCardCapabilityKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return isSensitiveToolArgumentKey(key) || normalized === "nextcursor";
}

/**
 * Legacy provider summaries sometimes embed credentials in a generic string
 * field (not under a secret-bearing key). Remove explicit credential forms;
 * opaque capabilities such as cursors are handled by their field names so
 * legitimate document ids, hashes, paths, and prose are not guessed secret.
 */
export function redactCredentialMaterialForDisplay(value: string): string {
  return value
    .replace(BEARER_CREDENTIAL, "Bearer [redacted]")
    .replace(JWT_LIKE_CREDENTIAL, REDACTED);
}

function boundedString(value: string): string {
  const bounded = value.length <= MAX_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_STRING_CHARS - 1)}…`;
  return redactCredentialMaterialForDisplay(bounded);
}

function boundedLabel(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function ownDataProperty(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  return "value" in descriptor ? descriptor.value : OMITTED;
}

function redactValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  budget: { remaining: number },
  sensitiveKeyMode: "redact" | "omit",
): unknown {
  if (budget.remaining <= 0) return OMITTED;
  budget.remaining -= 1;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : OMITTED;
  if (typeof value === "bigint") return boundedString(String(value));
  if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) {
    return OMITTED;
  }
  if (ancestors.has(value)) return OMITTED;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthValue = ownDataProperty(value, "length");
      const length = typeof lengthValue === "number" && Number.isSafeInteger(lengthValue)
        ? Math.max(0, lengthValue)
        : 0;
      const next: unknown[] = [];
      for (let index = 0; index < Math.min(length, MAX_ARRAY_ITEMS); index += 1) {
        next.push(redactValue(
          ownDataProperty(value, index),
          depth + 1,
          ancestors,
          budget,
          sensitiveKeyMode,
        ));
      }
      if (length > MAX_ARRAY_ITEMS) next.push(OMITTED);
      return next;
    }

    const next: Record<string, unknown> = {};
    const keys: string[] = [];
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      if (keys.length > MAX_OBJECT_ENTRIES) break;
    }
    for (const key of keys.slice(0, MAX_OBJECT_ENTRIES)) {
      if (sensitiveKeyMode === "omit" && isToolCardCapabilityKey(key)) continue;
      const displayKey = boundedLabel(key, MAX_DISPLAY_KEY_CHARS);
      const item = ownDataProperty(value, key);
      Object.defineProperty(next, displayKey, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: isSensitiveToolArgumentKey(key)
        ? REDACTED
        : redactValue(item, depth + 1, ancestors, budget, sensitiveKeyMode),
      });
    }
    if (keys.length > MAX_OBJECT_ENTRIES) next["…"] = OMITTED;
    return next;
  } catch {
    return OMITTED;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Returns a new JSON-like projection. Callers must never render, title,
 * announce, or stringify the source arguments after crossing this boundary.
 */
export function redactToolArgsForDisplay(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactValue(
    args,
    0,
    new WeakSet<object>(),
    { remaining: MAX_PROJECTED_NODES },
    "redact",
  );
  return typeof redacted === "object" && redacted !== null && !Array.isArray(redacted)
    ? redacted as Record<string, unknown>
    : {};
}

/**
 * Tool cards are durable disclosure surfaces, not approval forms. Omit
 * capability-bearing fields completely so an expanded historical card does
 * not teach the credential/cursor contract or fill the UI with placeholders.
 */
function omitToolCapabilityFieldsForDisplay(value: unknown): unknown {
  return redactValue(
    value,
    0,
    new WeakSet<object>(),
    { remaining: MAX_PROJECTED_NODES },
    "omit",
  );
}

export function projectToolArgsForCardDisplay(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return projectTaskTranscriptToolArgs(args);
}

/**
 * Projects a raw tool result for card/transcript display. JSON results retain
 * useful receipt data while capability fields are recursively omitted. Plain
 * text is left legible but explicit Bearer/JWT credentials are still removed.
 */
export function projectToolResultTextForDisplay(
  result: string | undefined,
): string | undefined {
  return projectTaskTranscriptToolResult(result);
}

export function projectToolResultForDisplay(result: unknown): unknown {
  if (typeof result === "string") return projectToolResultTextForDisplay(result);
  if (result === undefined) return undefined;
  return omitToolCapabilityFieldsForDisplay(result);
}

/** Parse a transport summary without ever falling back to displaying it raw. */
export function parseSerializedToolArgsForDisplay(
  serialized: string | undefined,
): Record<string, unknown> {
  if (!serialized || serialized.length > MAX_SERIALIZED_ARGS_CHARS) return {};
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return redactToolArgsForDisplay(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

export function formatToolDisplayName(
  tool: { name: string; args: Record<string, unknown> },
): string {
  if (tool.name !== "file") return boundedLabel(tool.name, MAX_DISPLAY_NAME_CHARS);
  let command: unknown = OMITTED;
  try {
    command = ownDataProperty(tool.args, "command");
  } catch {
    // A hostile proxy is not a reason to expose or fail the approval surface.
  }
  return boundedLabel(
    typeof command === "string" ? `${tool.name}.${command}` : tool.name,
    MAX_DISPLAY_NAME_CHARS,
  );
}

function previewValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return OMITTED;
  }
}

/** A compact approval preview built exclusively from redacted arguments. */
export function formatToolPreview(
  tool: { name: string; args: Record<string, unknown> },
): string {
  const safeArgs = redactToolArgsForDisplay(tool.args);
  const displayName = formatToolDisplayName({ name: tool.name, args: safeArgs });
  const args = Object.entries(safeArgs)
    .filter(([key]) => !(tool.name === "file" && key === "command"))
    .slice(0, MAX_PREVIEW_ARGS)
    .map(([key, value]) => {
      const serialized = previewValue(value);
      const bounded = serialized.length > MAX_PREVIEW_VALUE_CHARS
        ? `${serialized.slice(0, MAX_PREVIEW_VALUE_CHARS - 3)}…`
        : serialized;
      return `${boundedLabel(key, MAX_DISPLAY_KEY_CHARS)}: ${bounded}`;
    })
    .join(", ");
  return args ? `${displayName}(${args})` : displayName;
}
