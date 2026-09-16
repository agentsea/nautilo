/** Bounded, non-mutating projection for tool arguments leaving execution state. */

const REDACTED = "[REDACTED TOOL ARG]";
const OMITTED = "[omitted]";
const MAX_DEPTH = 5;
const MAX_ENTRIES = 64;
const MAX_STRING_CHARS = 4_096;
const MAX_KEY_CHARS = 128;
const MAX_PROJECTED_NODES = 512;
const BEARER_CREDENTIAL = /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi;
const JWT_LIKE_CREDENTIAL = /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\b/g;

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function boundedKey(key: string): string {
  return key.length <= MAX_KEY_CHARS
    ? key
    : `${key.slice(0, MAX_KEY_CHARS - 1)}…`;
}

function ownDataProperty(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  return "value" in descriptor ? descriptor.value : OMITTED;
}

export function isSensitiveToolArgumentKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized === "auth" ||
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
    normalized === "value" ||
    normalized === "cookie" ||
    normalized.endsWith("cookie") ||
    normalized === "pin" ||
    normalized === "approvalpin" ||
    normalized === "adminpin" ||
    normalized === "ownerpin" ||
    normalized === "securitypin" ||
    normalized === "otp";
}

export function redactCredentialMaterialForEvent(value: string): string {
  return value
    .replace(BEARER_CREDENTIAL, "Bearer [REDACTED TOOL ARG]")
    .replace(JWT_LIKE_CREDENTIAL, REDACTED);
}

function projectValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  omitSensitive: boolean,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0) return OMITTED;
  budget.remaining -= 1;
  if (typeof value === "string") {
    const bounded = value.length <= MAX_STRING_CHARS
      ? value
      : `${value.slice(0, MAX_STRING_CHARS - 1)}…`;
    return redactCredentialMaterialForEvent(bounded);
  }
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : OMITTED;
  if (depth >= MAX_DEPTH || typeof value !== "object" || value === null) return OMITTED;
  if (ancestors.has(value)) return OMITTED;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthValue = ownDataProperty(value, "length");
      const length = typeof lengthValue === "number" && Number.isSafeInteger(lengthValue)
        ? Math.max(0, lengthValue)
        : 0;
      const output: unknown[] = [];
      for (let index = 0; index < Math.min(length, MAX_ENTRIES); index += 1) {
        output.push(projectValue(
          ownDataProperty(value, index),
          depth + 1,
          ancestors,
          omitSensitive,
          budget,
        ));
      }
      if (length > MAX_ENTRIES) output.push(OMITTED);
      return output;
    }
    const output: Record<string, unknown> = {};
    const keys: string[] = [];
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      if (keys.length > MAX_ENTRIES) break;
    }
    for (const key of keys.slice(0, MAX_ENTRIES)) {
      const item = ownDataProperty(value, key);
      const outputKey = boundedKey(key);
      if (isSensitiveToolArgumentKey(key)) {
        if (!omitSensitive) {
          Object.defineProperty(output, outputKey, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: REDACTED,
          });
        }
        continue;
      }
      Object.defineProperty(output, outputKey, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: projectValue(item, depth + 1, ancestors, omitSensitive, budget),
      });
    }
    if (keys.length > MAX_ENTRIES) output["…"] = OMITTED;
    return output;
  } catch {
    return OMITTED;
  } finally {
    ancestors.delete(value);
  }
}

function projectRecord(
  args: Record<string, unknown>,
  omitSensitive: boolean,
): Record<string, unknown> {
  const projected = projectValue(
    args,
    0,
    new WeakSet<object>(),
    omitSensitive,
    { remaining: MAX_PROJECTED_NODES },
  );
  return projected && typeof projected === "object" && !Array.isArray(projected)
    ? projected as Record<string, unknown>
    : {};
}

/** Canonical foreground/subagent telemetry projection. */
export function sanitizeToolArgsForEvent(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  return projectValue(
    args,
    0,
    new WeakSet<object>(),
    false,
    { remaining: MAX_PROJECTED_NODES },
  );
}

/** Compact progress summaries omit credential fields instead of advertising them. */
export function omitSensitiveToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return projectRecord(args, true);
}
