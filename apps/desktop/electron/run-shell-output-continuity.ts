import { randomBytes } from "node:crypto";

import {
  redactRunShellOutputBuffer,
  runShellRedactionForLength,
} from "@nautilo/relay";

export { knownRunShellSecretValues } from "@nautilo/relay";

export type RunShellOutputOwnerBinding = {
  readonly instanceId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string | null;
};

export type RunShellOutputArtifactReference = {
  version: 1;
  reference: string;
  expiresAt: string;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
};

export type RunShellOutputArtifactResult = {
  version: 1;
  reference: string;
  stdout: string;
  stderr: string;
  offsetBytes: number;
  nextOffsetBytes: number | null;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  expiresAt: string;
  deleted: boolean;
};

export type RunShellOutputArtifactSearchMatch = {
  stream: Stream;
  matchOffsetBytes: number;
  artifactOffsetBytes: number;
  matchBytes: number;
  contextOffsetBytes: number;
  context: string;
};

export type RunShellOutputArtifactSearchResult = {
  version: 1;
  operation: "search";
  reference: string;
  matches: RunShellOutputArtifactSearchMatch[];
  totalMatches: number;
  matchesTruncated: boolean;
  capturedBytes: number;
  totalBytes: number;
  truncated: boolean;
  expiresAt: string;
};

export type RetainedOutputArtifactDispatchResult =
  | { readonly ok: true; readonly result: RunShellOutputArtifactResult | RunShellOutputArtifactSearchResult }
  | { readonly ok: false; readonly reason: "invalid" | "unavailable" | "not_found" };

export const RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES = 1024 * 1024;
const RUN_SHELL_OUTPUT_ARTIFACT_TOTAL_BYTES = 8 * 1024 * 1024;
const RUN_SHELL_OUTPUT_ARTIFACT_TTL_MS = 10 * 60 * 1000;
export const RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES = 16 * 1024;
const RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_MATCHES = 20;
const RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_CONTEXT_BYTES = 1024;
const RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_CONTEXT_TOTAL_BYTES = 16 * 1024;
const RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_RESPONSE_BYTES = 16 * 1024;
const RUN_SHELL_INLINE_CAPTURE_BYTES = 16 * 1024;
const RUN_SHELL_OUTPUT_ARTIFACT_MAX_ENTRIES = 16;
const RUN_SHELL_OUTPUT_ARTIFACT_BLOCK_BYTES = 64 * 1024;
// A pending candidate is deliberately bounded.  Ordinary output is streamed as
// soon as it cannot be the prefix of a secret, while malformed/unbounded
// credential-shaped output becomes conservative redaction rather than an
// unbounded in-memory buffer.
const GENERIC_CANDIDATE_MAX_BYTES = 8 * 1024;
type Stream = "stdout" | "stderr";

type OpenSensitiveCandidate = {
  readonly start: number;
  readonly kind: "line" | "pem";
};

const STATIC_SECRET_PREFIXES = [
  "ghp_", "gho_", "ghu_", "ghs_", "ghr_",
  "sk-", "akia", "asia", "aiza", "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-",
  "sk_live_", "rk_live_", "npm_", "hf_", "authorization",
  "api_key", "api-key", "access_key", "access-key", "authorization",
  "credential", "cookie", "password", "passwd", "private_key", "private-key",
  "secret", "token", "session",
  "postgres://", "postgresql://", "mysql://", "mariadb://", "mongodb://",
  "mongodb+srv://", "redis://", "rediss://", "amqp://", "amqps://",
  "-----begin ",
] as const;

function suffixPrefixStart(input: Buffer, literal: string): number | null {
  const text = input.toString("latin1").toLowerCase();
  const value = literal.toLowerCase();
  const largest = Math.min(text.length, value.length - 1);
  for (let length = largest; length > 0; length -= 1) {
    if (text.endsWith(value.slice(0, length))) return text.length - length;
  }
  return null;
}

function lastMatchStart(text: string, expression: RegExp): number | null {
  const match = expression.exec(text);
  return match === null ? null : match.index;
}

function openGenericCandidate(input: Buffer): OpenSensitiveCandidate | null {
  const text = input.toString("latin1");
  const candidates: OpenSensitiveCandidate[] = [];
  const line = [
    /(?:^|[^A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9_]*)$/i,
    /(?:^|[^A-Za-z0-9_-])(sk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]*)$/i,
    /(?:^|[^A-Za-z0-9_-])(AIza[0-9A-Za-z_-]*)$/i,
    /(?:^|[^A-Za-z0-9-])(xox[baprs]-[A-Za-z0-9-]*)$/i,
    /(?:^|[^A-Za-z0-9_])((?:sk|rk)_live_[A-Za-z0-9]*)$/i,
    /(?:^|[^A-Za-z0-9])(AKIA|ASIA)[A-Z0-9]*$/,
    /(?:^|[^A-Za-z0-9_])(npm_[A-Za-z0-9]*)$/i,
    /(?:^|[^A-Za-z0-9_])(hf_[A-Za-z0-9]*)$/i,
    /(?:^|[^0-9])(\d{1,12}(?::[A-Za-z0-9_-]*)?)$/,
    /authorization\s*:\s*(?:bearer|basic)\s*[^\s,;]*$/i,
    /["']?(?:api[_-]?key|access[_-]?key|auth(?:orization)?|credential|cookie|password|passwd|private[_-]?key|secret|token|session)["']?\s*[:=]\s*["']?[^"'\s,}\]]*$/i,
    /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp(?:s)?):\/\/[^:\s/@]*:[^@/\s]*$/i,
    /authorization\s*$/i,
    /["']?(?:api[_-]?key|access[_-]?key|auth(?:orization)?|credential|cookie|password|passwd|private[_-]?key|secret|token|session)["']?\s*$/i,
    /(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp(?:s)?):\/\/[^\s]*$/i,
  ];
  for (const expression of line) {
    const start = lastMatchStart(text, expression);
    if (start !== null) candidates.push({ start, kind: "line" });
  }
  const pemHeader = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ig;
  let pemMatch: RegExpExecArray | null;
  let lastPemStart: number | null = null;
  while ((pemMatch = pemHeader.exec(text)) !== null) lastPemStart = pemMatch.index;
  if (lastPemStart !== null) {
    const afterHeader = text.slice(lastPemStart);
    if (!/-----END [A-Z0-9 ]*PRIVATE KEY-----/i.test(afterHeader)) {
      candidates.push({ start: lastPemStart, kind: "pem" });
    }
  } else {
    const pemStart = lastMatchStart(
      text,
      /-----BEGIN [A-Z0-9 ]*(?:-|PRIVATE KEY-*)?$/i,
    );
    if (pemStart !== null) candidates.push({ start: pemStart, kind: "pem" });
  }
  for (const literal of STATIC_SECRET_PREFIXES) {
    const start = suffixPrefixStart(input, literal);
    if (start !== null) candidates.push({ start, kind: "line" });
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) => candidate.start < earliest.start ? candidate : earliest);
}

function exactSecretPrefixStart(input: Buffer, secrets: readonly Buffer[]): number | null {
  let start: number | null = null;
  for (const secret of secrets) {
    const largest = Math.min(input.length, secret.length - 1);
    for (let length = largest; length > 0; length -= 1) {
      if (input.subarray(input.length - length).equals(secret.subarray(0, length))) {
        const candidate = input.length - length;
        start = start === null ? candidate : Math.min(start, candidate);
        break;
      }
    }
  }
  return start;
}

function lineTerminator(input: Buffer): number {
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index] ?? 0;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d ||
      byte === 0x2c || byte === 0x3b || byte === 0x22 || byte === 0x27 ||
      byte === 0x7d || byte === 0x5d) return index;
  }
  return -1;
}

function pemTerminatorEnd(input: Buffer): number | null {
  const match = /-----END [A-Z0-9 ]*PRIVATE KEY-----/i.exec(input.toString("latin1"));
  return match === null ? null : match.index + match[0].length;
}

/** Stateful byte redactor that withholds a suffix so secrets cannot cross frames. */
class RunShellStreamRedactor {
  private pending = Buffer.alloc(0);
  private openCandidate: "line" | "pem" | null = null;

  constructor(private readonly secrets: readonly Buffer[]) {
  }

  push(chunk: Buffer): { readonly bytes: Buffer; readonly consumedRawBytes: number } {
    if (chunk.length === 0) return { bytes: Buffer.alloc(0), consumedRawBytes: 0 };
    let combined = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    this.pending = Buffer.alloc(0);
    const output: Buffer[] = [];
    let consumedRawBytes = 0;
    for (;;) {
      if (this.openCandidate !== null) {
        if (this.openCandidate === "pem") {
          const end = pemTerminatorEnd(combined);
          if (end === null) {
            output.push(runShellRedactionForLength(combined.length));
            consumedRawBytes += combined.length;
            break;
          }
          output.push(runShellRedactionForLength(end));
          consumedRawBytes += end;
          combined = combined.subarray(end);
          this.openCandidate = null;
          if (combined.length === 0) break;
          continue;
        }
        const terminator = lineTerminator(combined);
        if (terminator < 0) {
          output.push(runShellRedactionForLength(combined.length));
          consumedRawBytes += combined.length;
          break;
        }
        output.push(runShellRedactionForLength(terminator));
        consumedRawBytes += terminator;
        combined = combined.subarray(terminator);
        this.openCandidate = null;
        if (combined.length === 0) break;
        continue;
      }

      const exactStart = exactSecretPrefixStart(combined, this.secrets);
      const generic = openGenericCandidate(combined);
      const cut = [exactStart, generic?.start]
        .filter((value): value is number => value !== null && value !== undefined)
        .reduce((minimum, value) => Math.min(minimum, value), combined.length);
      if (cut === combined.length) {
        output.push(redactRunShellOutputBuffer(combined, this.secrets));
        consumedRawBytes += combined.length;
        break;
      }
      if (cut > 0) {
        // Generic redaction is length preserving, so scan the complete frame
        // before emitting its safe prefix. A trailing `-` can be the start of
        // another PEM header while the preceding bytes already contain a
        // complete private-key block.
        output.push(redactRunShellOutputBuffer(combined, this.secrets).subarray(0, cut));
        consumedRawBytes += cut;
        combined = combined.subarray(cut);
      }
      if (combined.length >= GENERIC_CANDIDATE_MAX_BYTES && generic?.start === cut) {
        this.openCandidate = generic.kind;
        continue;
      }
      this.pending = Buffer.from(combined);
      break;
    }
    return { bytes: Buffer.concat(output), consumedRawBytes };
  }

  finish(): { readonly bytes: Buffer; readonly consumedRawBytes: number } {
    const raw = this.pending;
    this.pending = Buffer.alloc(0);
    if (this.openCandidate !== null) {
      this.openCandidate = null;
      return { bytes: runShellRedactionForLength(raw.length), consumedRawBytes: raw.length };
    }
    return {
      bytes: redactRunShellOutputBuffer(raw, this.secrets),
      consumedRawBytes: raw.length,
    };
  }

  redactComplete(text: string): string {
    return redactRunShellOutputBuffer(Buffer.from(text, "utf8"), this.secrets).toString("utf8");
  }
}

class BoundedStreamCapture {
  private complete = Buffer.alloc(0);
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private overflowed = false;
  private readonly headBudget = Math.floor(RUN_SHELL_INLINE_CAPTURE_BYTES / 2);
  private readonly tailBudget = RUN_SHELL_INLINE_CAPTURE_BYTES - this.headBudget;

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (!this.overflowed) {
      const complete = Buffer.concat([this.complete, chunk]);
      if (complete.length <= RUN_SHELL_INLINE_CAPTURE_BYTES) {
        this.complete = complete;
        return;
      }
      this.overflowed = true;
      this.head = Buffer.from(complete.subarray(0, this.headBudget));
      this.tail = Buffer.from(complete.subarray(complete.length - this.tailBudget));
      this.complete = Buffer.alloc(0);
      return;
    }
    const retained = Buffer.concat([this.tail, chunk]);
    this.tail = Buffer.from(retained.subarray(Math.max(0, retained.length - this.tailBudget)));
  }

  finalize(): { readonly text: string; readonly truncated: boolean } {
    if (!this.overflowed) return { text: this.complete.toString("utf8"), truncated: false };
    const omitted = Math.max(0, this.totalBytes - this.head.length - this.tail.length);
    return {
      text: `${this.head.toString("utf8")}\n…[${omitted} bytes truncated by Nautilo]…\n${this.tail.toString("utf8")}`,
      truncated: true,
    };
  }
}

/** One sanitization spine feeding provisional progress, final inline text and retention. */
export class RunShellSanitizedOutputCapture {
  private readonly redactors: Record<Stream, RunShellStreamRedactor>;
  private readonly inline: Record<Stream, BoundedStreamCapture> = {
    stdout: new BoundedStreamCapture(),
    stderr: new BoundedStreamCapture(),
  };
  private readonly utf8Decoders = {
    stdout: new TextDecoder("utf-8"),
    stderr: new TextDecoder("utf-8"),
  };
  private finished = false;

  constructor(
    secrets: readonly Buffer[],
    private readonly onSanitized: (stream: Stream, bytes: Buffer, rawBytes: number) => void,
  ) {
    this.redactors = {
      stdout: new RunShellStreamRedactor(secrets),
      stderr: new RunShellStreamRedactor(secrets),
    };
  }

  append(stream: Stream, raw: Buffer): void {
    if (this.finished) return;
    const value = this.redactors[stream].push(raw);
    this.consume(stream, value.bytes, value.consumedRawBytes);
  }

  finish(): void {
    if (this.finished) return;
    for (const stream of ["stdout", "stderr"] as const) {
      const value = this.redactors[stream].finish();
      this.consume(stream, value.bytes, value.consumedRawBytes);
      const tail = Buffer.from(this.utf8Decoders[stream].decode(), "utf8");
      if (tail.length > 0) this.consumeNormalized(stream, tail, 0);
    }
    this.finished = true;
  }

  result(stream: Stream): { readonly text: string; readonly truncated: boolean } {
    this.finish();
    return this.inline[stream].finalize();
  }

  private consume(stream: Stream, bytes: Buffer, rawBytes: number): void {
    if (bytes.length === 0 && rawBytes === 0) return;
    const normalized = Buffer.from(
      this.utf8Decoders[stream].decode(bytes, { stream: true }),
      "utf8",
    );
    this.consumeNormalized(stream, normalized, rawBytes);
  }

  private consumeNormalized(stream: Stream, bytes: Buffer, rawBytes: number): void {
    if (bytes.length > 0) this.inline[stream].append(bytes);
    this.onSanitized(stream, bytes, rawBytes);
  }
}

type ArtifactEntry = {
  readonly owner: RunShellOutputOwnerBinding;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly capturedBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly expiresAtMs: number;
  readonly timer: ReturnType<typeof setTimeout>;
};

function sameOwner(left: RunShellOutputOwnerBinding, right: RunShellOutputOwnerBinding): boolean {
  return left.instanceId === right.instanceId &&
    left.userId === right.userId &&
    left.relayId === right.relayId &&
    left.desktopSessionId === right.desktopSessionId;
}

function decodeUtf8Page(
  input: Buffer,
  start: number,
  outputBudget: number,
): { readonly text: string; readonly end: number; readonly outputBytes: number } {
  const parts: string[] = [];
  let cursor = start;
  let outputBytes = 0;
  while (cursor < input.length) {
    const leading = input[cursor] ?? 0;
    const width = leading < 0x80 ? 1 :
      leading >= 0xc2 && leading <= 0xdf ? 2 :
      leading >= 0xe0 && leading <= 0xef ? 3 :
      leading >= 0xf0 && leading <= 0xf4 ? 4 : 1;
    const candidate = input.subarray(cursor, Math.min(input.length, cursor + width));
    let text: string;
    let consumed: number;
    try {
      if (candidate.length !== width) throw new TypeError("incomplete UTF-8");
      text = new TextDecoder("utf-8", { fatal: true }).decode(candidate);
      consumed = width;
    } catch {
      text = "�";
      consumed = 1;
    }
    const renderedBytes = Buffer.byteLength(text, "utf8");
    if (outputBytes + renderedBytes > outputBudget) break;
    parts.push(text);
    outputBytes += renderedBytes;
    cursor += consumed;
  }
  return { text: parts.join(""), end: cursor, outputBytes };
}

function utf8ContextRange(input: Buffer, start: number, end: number): { start: number; end: number } {
  let safeStart = Math.min(Math.max(start, 0), input.length);
  let safeEnd = Math.min(Math.max(end, safeStart), input.length);
  // Retained buffers are UTF-8-normalized, but context edges can still land
  // within a multibyte code point. Move only the returned boundary, never the
  // match offset (which remains the exact stream-local byte coordinate).
  while (safeStart > 0 && (input[safeStart]! & 0xc0) === 0x80) safeStart -= 1;
  while (safeEnd < input.length && (input[safeEnd]! & 0xc0) === 0x80) safeEnd += 1;
  return { start: safeStart, end: safeEnd };
}

function isValidUtf8(input: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input);
    return true;
  } catch {
    return false;
  }
}

/** Fixed-size retained blocks keep callback count independent from object count. */
class ArtifactBlockWriter {
  private readonly blocks: Buffer[] = [];
  private length = 0;

  append(input: Buffer, allowedBytes: number): number {
    const accepted = Math.min(input.length, Math.max(0, allowedBytes));
    let inputOffset = 0;
    while (inputOffset < accepted) {
      const blockOffset = this.length % RUN_SHELL_OUTPUT_ARTIFACT_BLOCK_BYTES;
      if (this.blocks.length === 0 || blockOffset === 0) {
        this.blocks.push(Buffer.allocUnsafe(RUN_SHELL_OUTPUT_ARTIFACT_BLOCK_BYTES));
      }
      const block = this.blocks[this.blocks.length - 1]!;
      const copied = Math.min(
        accepted - inputOffset,
        RUN_SHELL_OUTPUT_ARTIFACT_BLOCK_BYTES - blockOffset,
      );
      input.copy(block, blockOffset, inputOffset, inputOffset + copied);
      inputOffset += copied;
      this.length += copied;
    }
    return accepted;
  }

  snapshotAndClear(): Buffer {
    const output = Buffer.allocUnsafe(this.length);
    let outputOffset = 0;
    for (const block of this.blocks) {
      const copied = Math.min(block.length, this.length - outputOffset);
      if (copied <= 0) break;
      block.copy(output, outputOffset, 0, copied);
      block.fill(0);
      outputOffset += copied;
    }
    this.blocks.length = 0;
    this.length = 0;
    return output;
  }

  blockCount(): number {
    return this.blocks.length;
  }
}

export class RunShellOutputArtifactStore {
  private readonly entries = new Map<string, ArtifactEntry>();
  private retainedBytes = 0;
  private lastSearchCandidateMaterializations = 0;

  constructor(private readonly ttlMs = RUN_SHELL_OUTPUT_ARTIFACT_TTL_MS) {}

  createDraft(owner: RunShellOutputOwnerBinding) {
    const writers: Record<Stream, ArtifactBlockWriter> = {
      stdout: new ArtifactBlockWriter(),
      stderr: new ArtifactBlockWriter(),
    };
    let capturedBytes = 0;
    let totalBytes = 0;
    const append = (stream: Stream, bytes: Buffer, _consumedRawBytes: number) => {
      // Artifact cursors page the sanitized, UTF-8-normalized stream. Keep
      // totals in that same byte domain so malformed input expanded to U+FFFD
      // cannot produce capturedBytes > totalBytes or an invalid reference.
      totalBytes += bytes.length;
      if (bytes.length === 0 || capturedBytes >= RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES) return;
      const remaining = RUN_SHELL_OUTPUT_ARTIFACT_MAX_BYTES - capturedBytes;
      capturedBytes += writers[stream].append(bytes, remaining);
    };
    return {
      append,
      /** Narrow test observability for the callback-count memory invariant. */
      debugRetainedBlockCount: () => writers.stdout.blockCount() + writers.stderr.blockCount(),
      commit: (): RunShellOutputArtifactReference => {
        this.prune();
        while (
          this.entries.size >= RUN_SHELL_OUTPUT_ARTIFACT_MAX_ENTRIES ||
          this.retainedBytes + capturedBytes > RUN_SHELL_OUTPUT_ARTIFACT_TOTAL_BYTES
        ) {
          const oldest = this.entries.keys().next().value;
          if (typeof oldest !== "string") break;
          this.delete(oldest);
        }
        const reference = randomBytes(32).toString("base64url");
        const expiresAtMs = Date.now() + this.ttlMs;
        const timer = setTimeout(() => this.delete(reference), this.ttlMs);
        timer.unref();
        const entry: ArtifactEntry = {
          owner: { ...owner },
          stdout: writers.stdout.snapshotAndClear(),
          stderr: writers.stderr.snapshotAndClear(),
          capturedBytes,
          totalBytes,
          truncated: capturedBytes < totalBytes,
          expiresAtMs,
          timer,
        };
        this.entries.set(reference, entry);
        this.retainedBytes += capturedBytes;
        return {
          version: 1,
          reference,
          expiresAt: new Date(expiresAtMs).toISOString(),
          capturedBytes,
          totalBytes,
          truncated: entry.truncated,
        };
      },
      discard: (): void => {
        writers.stdout.snapshotAndClear().fill(0);
        writers.stderr.snapshotAndClear().fill(0);
        capturedBytes = 0;
        totalBytes = 0;
      },
    };
  }

  read(input: {
    readonly reference: string;
    readonly owner: RunShellOutputOwnerBinding;
    readonly deleteAfterRead: boolean;
    readonly offsetBytes: number;
    readonly maxBytes: number;
  }): RunShellOutputArtifactResult | null {
    this.prune();
    const entry = this.entries.get(input.reference);
    if (entry === undefined || !sameOwner(entry.owner, input.owner)) return null;
    const combinedBytes = entry.stdout.length + entry.stderr.length;
    const offsetBytes = Math.min(Math.max(input.offsetBytes, 0), combinedBytes);
    const pageBytes = Math.min(Math.max(input.maxBytes, 4), RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES);
    let cursor = offsetBytes;
    let remaining = pageBytes;
    let stdout = "";
    let stderr = "";
    if (cursor < entry.stdout.length && remaining > 0) {
      const page = decodeUtf8Page(entry.stdout, cursor, remaining);
      stdout = page.text;
      cursor = page.end;
      remaining -= page.outputBytes;
    }
    if (cursor >= entry.stdout.length && cursor < combinedBytes && remaining > 0) {
      const stderrOffset = cursor - entry.stdout.length;
      const page = decodeUtf8Page(entry.stderr, stderrOffset, remaining);
      stderr = page.text;
      cursor = entry.stdout.length + page.end;
    }
    const complete = cursor >= combinedBytes;
    const deleted = input.deleteAfterRead && complete;
    const result: RunShellOutputArtifactResult = {
      version: 1,
      reference: input.reference,
      stdout,
      stderr,
      offsetBytes,
      nextOffsetBytes: complete ? null : cursor,
      capturedBytes: entry.capturedBytes,
      totalBytes: entry.totalBytes,
      truncated: entry.truncated,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      deleted,
    };
    if (deleted) this.delete(input.reference);
    return result;
  }

  search(input: {
    readonly reference: string;
    readonly owner: RunShellOutputOwnerBinding;
    readonly query: Buffer;
    readonly maxMatches: number;
    readonly contextBytes: number;
  }): RunShellOutputArtifactSearchResult | null {
    this.prune();
    const entry = this.entries.get(input.reference);
    if (entry === undefined || !sameOwner(entry.owner, input.owner)) return null;
    this.lastSearchCandidateMaterializations = 0;
    if (
      input.query.length === 0 || input.query.length > 1024 || !isValidUtf8(input.query) ||
      !Number.isSafeInteger(input.maxMatches) || input.maxMatches < 1 ||
      input.maxMatches > RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_MATCHES ||
      !Number.isSafeInteger(input.contextBytes) || input.contextBytes < 0 ||
      input.contextBytes > RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_CONTEXT_BYTES
    ) return null;

    const maxMatches = input.maxMatches;
    const contextBytes = input.contextBytes;
    const matches: RunShellOutputArtifactSearchMatch[] = [];
    let totalMatches = 0;
    let contextTotalBytes = 0;
    let matchesTruncated = false;
    let acceptingMatches = true;
    const resultWith = (
      nextMatches: RunShellOutputArtifactSearchMatch[],
      nextTotalMatches: number,
      nextMatchesTruncated: boolean,
    ): RunShellOutputArtifactSearchResult => ({
      version: 1,
      operation: "search",
      reference: input.reference,
      matches: nextMatches,
      totalMatches: nextTotalMatches,
      matchesTruncated: nextMatchesTruncated,
      capturedBytes: entry.capturedBytes,
      totalBytes: entry.totalBytes,
      truncated: entry.truncated,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
    });

    for (const stream of ["stdout", "stderr"] as const) {
      const output = entry[stream];
      let cursor = 0;
      for (;;) {
        const matchOffsetBytes = output.indexOf(input.query, cursor);
        if (matchOffsetBytes < 0) break;
        totalMatches += 1;
        if (!acceptingMatches) {
          cursor = matchOffsetBytes + input.query.length;
          continue;
        }
        if (matches.length >= maxMatches) {
          matchesTruncated = true;
          acceptingMatches = false;
          cursor = matchOffsetBytes + input.query.length;
          continue;
        }
        const matchBytes = input.query.length;
        const range = utf8ContextRange(
          output,
          Math.max(0, matchOffsetBytes - contextBytes),
          Math.min(output.length, matchOffsetBytes + matchBytes + contextBytes),
        );
        const contextLength = range.end - range.start;
        this.lastSearchCandidateMaterializations += 1;
        const candidate: RunShellOutputArtifactSearchMatch = {
          stream,
          matchOffsetBytes,
          artifactOffsetBytes: (stream === "stdout" ? 0 : entry.stdout.length) + matchOffsetBytes,
          matchBytes,
          contextOffsetBytes: range.start,
          context: output.subarray(range.start, range.end).toString("utf8"),
        };
        if (
          matches.length < maxMatches &&
          contextTotalBytes + contextLength <= RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_CONTEXT_TOTAL_BYTES &&
          Buffer.byteLength(JSON.stringify(resultWith([...matches, candidate], totalMatches, true)), "utf8") <= RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_RESPONSE_BYTES
        ) {
          matches.push(candidate);
          contextTotalBytes += contextLength;
        } else {
          matchesTruncated = true;
          acceptingMatches = false;
        }
        cursor = matchOffsetBytes + matchBytes;
      }
    }

    let finalTruncated = matchesTruncated || totalMatches > matches.length;
    while (
      Buffer.byteLength(JSON.stringify(resultWith(matches, totalMatches, finalTruncated)), "utf8") >
        RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_RESPONSE_BYTES &&
      matches.length > 0
    ) {
      matches.pop();
      finalTruncated = true;
    }
    return resultWith(matches, totalMatches, finalTruncated);
  }

  /** Narrow test observability: dense scans must materialize only retained candidates. */
  debugSearchCandidateMaterializations(): number {
    return this.lastSearchCandidateMaterializations;
  }

  delete(reference: string): void {
    const entry = this.entries.get(reference);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    entry.stdout.fill(0);
    entry.stderr.fill(0);
    this.retainedBytes -= entry.capturedBytes;
    this.entries.delete(reference);
  }

  clear(): void {
    for (const reference of [...this.entries.keys()]) this.delete(reference);
  }

  private prune(): void {
    const now = Date.now();
    for (const [reference, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.delete(reference);
    }
  }
}

/**
 * Strict shared reader for Desktop-local retained output. The caller owns
 * tool-specific error codes; this function never starts a process and treats
 * the opaque reference as insufficient without the authenticated owner tuple.
 */
export function dispatchRetainedOutputArtifact(
  args: Record<string, unknown>,
  owner: RunShellOutputOwnerBinding | undefined,
  store: RunShellOutputArtifactStore | undefined,
): RetainedOutputArtifactDispatchResult {
  if (Object.keys(args).length !== 1) return { ok: false, reason: "invalid" };
  const request = args["output_artifact"];
  const record = typeof request === "object" && request !== null && !Array.isArray(request)
    ? request as Record<string, unknown>
    : null;
  if (record === null || typeof record["reference"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(record["reference"])) return { ok: false, reason: "invalid" };
  if (owner === undefined || store === undefined) return { ok: false, reason: "unavailable" };

  if (record["operation"] === "search") {
    const allowed = new Set(["reference", "operation", "query", "max_matches", "context_bytes"]);
    const query = record["query"];
    const maxMatches = record["max_matches"] === undefined ? 20 : record["max_matches"];
    const contextBytes = record["context_bytes"] === undefined ? 256 : record["context_bytes"];
    if (Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof query !== "string" || query.length === 0 || Buffer.byteLength(query, "utf8") > 1024 ||
      !Number.isSafeInteger(maxMatches) || (maxMatches as number) < 1 || (maxMatches as number) > 20 ||
      !Number.isSafeInteger(contextBytes) || (contextBytes as number) < 0 || (contextBytes as number) > 1024) {
      return { ok: false, reason: "invalid" };
    }
    const result = store.search({
      reference: record["reference"], owner, query: Buffer.from(query, "utf8"),
      maxMatches: maxMatches as number, contextBytes: contextBytes as number,
    });
    return result === null ? { ok: false, reason: "not_found" } : { ok: true, result };
  }

  const allowed = new Set(["reference", "offset_bytes", "max_bytes", "delete_after_read"]);
  const offsetBytes = record["offset_bytes"] === undefined ? 0 : record["offset_bytes"];
  const maxBytes = record["max_bytes"] === undefined ? RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES : record["max_bytes"];
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
    (record["delete_after_read"] !== undefined && typeof record["delete_after_read"] !== "boolean") ||
    !Number.isSafeInteger(offsetBytes) || (offsetBytes as number) < 0 ||
    !Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > RUN_SHELL_OUTPUT_ARTIFACT_PAGE_BYTES) {
    return { ok: false, reason: "invalid" };
  }
  const result = store.read({
    reference: record["reference"], owner,
    deleteAfterRead: record["delete_after_read"] === true,
    offsetBytes: offsetBytes as number, maxBytes: maxBytes as number,
  });
  return result === null ? { ok: false, reason: "not_found" } : { ok: true, result };
}
