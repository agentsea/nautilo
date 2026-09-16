import { Buffer } from "node:buffer";

export const RUN_SHELL_DEFAULT_TIMEOUT_MS = 60_000;
export const RUN_SHELL_MIN_TIMEOUT_MS = 1_000;
export const RUN_SHELL_MAX_TIMEOUT_MS = 14_400_000;

const REDACTION_MARKER = Buffer.from("[REDACTED]", "utf8");
const SECRET_ENV_NAME =
  /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|authorization|credential|cookie|session)/i;

/** Stable timeout admissibility shared by every local run_shell executor. */
export function admitRunShellTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(
    Math.max(timeoutMs ?? RUN_SHELL_DEFAULT_TIMEOUT_MS, RUN_SHELL_MIN_TIMEOUT_MS),
    RUN_SHELL_MAX_TIMEOUT_MS,
  );
}

/**
 * Values resident in the local host environment are the only plaintext
 * secrets the Relay can truthfully know. Short/common values are excluded to
 * avoid destroying ordinary compiler and test output.
 */
export function knownRunShellSecretValues(
  env: NodeJS.ProcessEnv = process.env,
): readonly Buffer[] {
  const unique = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (
      !SECRET_ENV_NAME.test(name) ||
      typeof value !== "string" ||
      Buffer.byteLength(value, "utf8") < 6 ||
      Buffer.byteLength(value, "utf8") > 4096
    ) continue;
    unique.add(value);
  }
  return [...unique]
    .map((value) => Buffer.from(value, "utf8"))
    .sort((left, right) => right.length - left.length);
}

/** Length-preserving marker keeps byte offsets truthful across progress lanes. */
export function runShellRedactionForLength(length: number): Buffer {
  if (length <= REDACTION_MARKER.length)
    return REDACTION_MARKER.subarray(0, length);
  return Buffer.concat([
    REDACTION_MARKER,
    Buffer.alloc(length - REDACTION_MARKER.length, 0x2a),
  ]);
}

function replaceKnownSecrets(input: Buffer, secrets: readonly Buffer[]): Buffer {
  if (input.length === 0 || secrets.length === 0) return Buffer.from(input);
  const parts: Buffer[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    let nextIndex = -1;
    let nextSecret: Buffer | null = null;
    for (const secret of secrets) {
      const index = input.indexOf(secret, cursor);
      if (
        index >= 0 &&
        (nextIndex < 0 ||
          index < nextIndex ||
          (index === nextIndex && secret.length > (nextSecret?.length ?? 0)))
      ) {
        nextIndex = index;
        nextSecret = secret;
      }
    }
    if (nextIndex < 0 || nextSecret === null) {
      parts.push(input.subarray(cursor));
      break;
    }
    if (nextIndex > cursor) parts.push(input.subarray(cursor, nextIndex));
    parts.push(runShellRedactionForLength(nextSecret.length));
    cursor = nextIndex + nextSecret.length;
  }
  return Buffer.concat(parts);
}

function replaceCredentialShapes(input: Buffer): Buffer {
  if (input.length === 0) return Buffer.alloc(0);
  const text = input.toString("latin1");
  const spans: Array<{ start: number; end: number }> = [];
  const mark = (expression: RegExp, secretGroup: number | null): void => {
    for (const match of text.matchAll(expression)) {
      if (match.index === undefined) continue;
      if (secretGroup === null) {
        spans.push({ start: match.index, end: match.index + match[0].length });
        continue;
      }
      const secret = match[secretGroup];
      if (typeof secret !== "string" || secret.length === 0) continue;
      if (secret.startsWith("[REDACTED")) continue;
      const relativeStart = match[0].lastIndexOf(secret);
      if (relativeStart < 0) continue;
      spans.push({
        start: match.index + relativeStart,
        end: match.index + relativeStart + secret.length,
      });
    }
  };

  mark(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    null,
  );
  mark(
    /((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp(?:s)?):\/\/[^:\s/@]+:)([^@/\s]+)(@)/gi,
    2,
  );
  mark(/(authorization\s*:\s*(?:bearer|basic)\s+)([^\s,;]+)/gi, 2);
  mark(
    /((?:["']?authorization["']?\s*[:=]\s*)["']?)(?!(?:bearer|basic)\s+)([^"'\s,}\]]+)/gi,
    2,
  );
  mark(
    /((?:["']?(?:api[_-]?key|access[_-]?key|auth(?!orization)|credential|cookie|password|passwd|private[_-]?key|secret|token|session)["']?\s*[:=]\s*)["']?)([^"'\s,}\]]+)/gi,
    2,
  );
  mark(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, null);
  mark(/\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,}\b/g, null);
  mark(/\bAIza[0-9A-Za-z_-]{35}\b/g, null);
  mark(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, null);
  mark(/\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g, null);
  mark(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, null);
  mark(/\bnpm_[A-Za-z0-9]{20,}\b/g, null);
  mark(/\bhf_[A-Za-z0-9]{20,}\b/g, null);
  mark(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, null);

  if (spans.length === 0) return Buffer.from(input);
  spans.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous !== undefined && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  const output = Buffer.from(input);
  for (const span of merged) {
    runShellRedactionForLength(span.end - span.start).copy(output, span.start);
  }
  return output;
}

/** Complete-buffer redaction used directly by headless and by Desktop's stream spine. */
export function redactRunShellOutputBuffer(
  input: Buffer,
  secrets: readonly Buffer[] = knownRunShellSecretValues(),
): Buffer {
  return replaceCredentialShapes(replaceKnownSecrets(input, secrets));
}

export function redactRunShellOutputText(
  input: string,
  secrets: readonly Buffer[] = knownRunShellSecretValues(),
): string {
  return redactRunShellOutputBuffer(Buffer.from(input, "utf8"), secrets).toString(
    "utf8",
  );
}
