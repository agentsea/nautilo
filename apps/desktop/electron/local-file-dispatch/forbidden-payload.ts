/**
 * M206 — deep scan for forbidden execution fields in local office wire payloads.
 */

const FORBIDDEN_EXEC_KEYS = new Set([
  "argv",
  "readArgv",
  "executable",
  "commandLine",
  "shell",
  "script",
  "binary",
  "cmd",
]);

const FILE_READ_ENCODING_KEYS = new Set(["binary", "encoding"]);

/** Validate typed `file.read` encoding fields at the top level only. */
export function validateFileReadEncodingFields(args: Record<string, unknown>): string | null {
  if ("binary" in args && args["binary"] !== true) {
    return "file.read binary must be true when present";
  }
  if ("encoding" in args) {
    const encoding = args["encoding"];
    if (encoding !== "base64") {
      return "file.read encoding must be base64 when present";
    }
  }
  return null;
}

export function rejectForbiddenTopLevelArgs(
  args: Record<string, unknown>,
  opts?: { allowReadEncoding?: boolean },
): string | null {
  for (const [key] of Object.entries(args)) {
    if (opts?.allowReadEncoding && FILE_READ_ENCODING_KEYS.has(key)) continue;
    if (FORBIDDEN_EXEC_KEYS.has(key)) {
      const label = key;
      return `forbidden execution field: ${label}`;
    }
  }
  return null;
}

export function findForbiddenExecutionField(
  value: unknown,
  path = "",
): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenExecutionField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EXEC_KEYS.has(key)) {
      const label = path.length > 0 ? `${path}.${key}` : key;
      return `forbidden execution field: ${label}`;
    }
    const childPath = path.length > 0 ? `${path}.${key}` : key;
    const hit = findForbiddenExecutionField(child, childPath);
    if (hit) return hit;
  }
  return null;
}
