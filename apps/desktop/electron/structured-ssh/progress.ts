import type { RelayDispatchRequest, RelayStructuredSshProgressObservation } from "@nautilo/relay";

type Stream = "stdout" | "stderr";
type Report = RelayDispatchRequest["reportStructuredSshProgress"];

const MAX_TEXT_BYTES = 4 * 1024;
const FLUSH_INTERVAL_MS = 100;

function validUtf8PrefixLength(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  // A valid UTF-8 sequence is at most four bytes wide. Probe only the tail
  // needed to distinguish an incomplete final code point from malformed
  // interior data; malformed data is dropped rather than turning a 64 KiB
  // bounded process output into quadratic decoder work.
  for (let length = bytes.length; length >= Math.max(0, bytes.length - 3); length -= 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      return length;
    } catch {
      // Keep trying shorter prefixes. This is bounded at the 4 KiB frame cap.
    }
  }
  return 0;
}

function matchingLiteral(bytes: Buffer, offset: number, literals: readonly Buffer[]): Buffer | undefined {
  return literals.find((literal) =>
    literal.length > 0 && offset + literal.length <= bytes.length && bytes.subarray(offset, offset + literal.length).equals(literal),
  );
}

/**
 * One execution-bound observation lane. It intentionally has no artifact or
 * continuation handle: D500 output remains bounded under the existing 64 KiB
 * runner policy until a separately designed continuation contract exists.
 */
export function createStructuredSshExecProgressReporter(
  report: Report,
  sensitiveValues: readonly string[],
): { readonly stdout: (chunk: Buffer) => void; readonly stderr: (chunk: Buffer) => void; readonly finish: () => void } {
  type Pending = { start: number; end: number; text: Buffer; dropped: number };
  type State = { offset: number; raw: Buffer; pending: Pending | null };
  const literals = [...new Set(sensitiveValues.filter((value) => Buffer.byteLength(value, "utf8") > 1))]
    .map((value) => Buffer.from(value, "utf8"))
    .sort((left, right) => right.length - left.length || Buffer.compare(left, right));
  const retainBytes = Math.max(0, ...literals.map((literal) => literal.length - 1));
  const states: Record<Stream, State> = {
    stdout: { offset: 0, raw: Buffer.alloc(0), pending: null },
    stderr: { offset: 0, raw: Buffer.alloc(0), pending: null },
  };
  const startedAt = Date.now();
  let sequence = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextFlushAt = 0;

  const emit = (stream: Stream, pending: Pending): void => {
    if (report === undefined) return;
    try {
      const observation: RelayStructuredSshProgressObservation = {
        version: 1,
        sequence: sequence++,
        operation: "exec",
        kind: "exec-output",
        stream,
        offsetBytes: pending.start,
        endOffsetBytes: pending.end,
        text: pending.text.toString("utf8"),
        ...(pending.dropped > 0 ? { droppedBytes: pending.dropped } : {}),
        elapsedMs: Math.max(0, Date.now() - startedAt),
        phase: "running",
      };
      report(observation);
    } catch {
      // Reporting is observational. A relay/UI observer never controls pipes,
      // cancellation, retries, trust, approval, or the canonical result.
    }
  };

  const schedule = (): void => {
    if (!closed && timer === null && (states.stdout.pending !== null || states.stderr.pending !== null)) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, FLUSH_INTERVAL_MS);
    }
  };

  const flushStream = (stream: Stream, force: boolean): void => {
    const state = states[stream];
    const pending = state.pending;
    if (pending === null) return;
    const safeLength = validUtf8PrefixLength(pending.text);
    if (safeLength === 0 && !force) return;
    const text = pending.text.subarray(0, safeLength);
    const remainingText = pending.text.subarray(safeLength);
    if (remainingText.length > 0 && safeLength > 0) {
      const end = pending.start + text.length;
      emit(stream, { start: pending.start, end, text, dropped: 0 });
      state.pending = { start: end, end: pending.end, text: remainingText, dropped: pending.dropped };
      return;
    }
    state.pending = null;
    // An invalid/incomplete final UTF-8 sequence is evidence of omitted bytes,
    // never U+FFFD that would make the byte offsets untrue.
    emit(stream, {
      start: pending.start,
      end: pending.end,
      text,
      dropped: pending.dropped + pending.text.length - text.length,
    });
  };

  const flush = (force = false): void => {
    if (closed) return;
    const now = Date.now();
    if (!force && now < nextFlushAt) {
      schedule();
      return;
    }
    nextFlushAt = now + FLUSH_INTERVAL_MS;
    flushStream("stdout", force);
    flushStream("stderr", force);
    schedule();
  };

  const appendSanitized = (stream: Stream, source: Buffer, maximum: number): number => {
    if (maximum === 0) return 0;
    const state = states[stream];
    const safe: Buffer[] = [];
    let safeBytes = 0;
    let dropped = 0;
    let offset = 0;
    while (offset < maximum) {
      const literal = matchingLiteral(source, offset, literals);
      if (literal !== undefined) {
        dropped += literal.length;
        offset += literal.length;
      } else {
        safe.push(source.subarray(offset, offset + 1));
        safeBytes += 1;
        offset += 1;
      }
    }
    const start = state.offset;
    state.offset += offset;
    const safeText = Buffer.concat(safe, safeBytes);
    const existing = state.pending;
    // Keep each report within its frame bound. Flushing a full prior record
    // before appending preserves exact source-byte/drop accounting; no hidden
    // redaction gap is moved into a later record.
    if (existing !== null && existing.text.length + safeText.length > MAX_TEXT_BYTES) {
      flushStream(stream, true);
    }
    const pending = state.pending;
    if (pending === null) {
      // `maximum` is 4 KiB of ordinary source bytes; a literal may extend the
      // consumed source range but removes bytes, so display text is bounded.
      state.pending = {
        start,
        end: state.offset,
        text: safeText,
        dropped,
      };
    } else {
      state.pending = {
        start: pending.start,
        end: state.offset,
        text: Buffer.concat([pending.text, safeText]),
        dropped: pending.dropped + dropped,
      };
    }
    return offset;
  };

  const drain = (stream: Stream, final: boolean): void => {
    const state = states[stream];
    const maximum = final ? state.raw.length : Math.max(0, state.raw.length - retainBytes);
    const candidate = Math.min(MAX_TEXT_BYTES, maximum);
    const ready = validUtf8PrefixLength(state.raw.subarray(0, candidate));
    if (ready > 0) {
      const consumed = appendSanitized(stream, state.raw, ready);
      state.raw = state.raw.subarray(consumed);
    }
    if (final && state.raw.length > 0) {
      // Invalid byte sequences cannot safely become display text. Count them
      // as dropped without exposing their contents.
      const start = state.offset;
      state.offset += state.raw.length;
      const pending = state.pending;
      state.pending = pending === null
        ? { start, end: state.offset, text: Buffer.alloc(0), dropped: state.raw.length }
        : { ...pending, end: state.offset, dropped: pending.dropped + state.raw.length };
      state.raw = Buffer.alloc(0);
    }
  };

  const append = (stream: Stream, chunk: Buffer): void => {
    if (closed || chunk.length === 0) return;
    const state = states[stream];
    state.raw = state.raw.length === 0 ? Buffer.from(chunk) : Buffer.concat([state.raw, chunk]);
    drain(stream, false);
    flush();
  };

  return {
    stdout: (chunk) => append("stdout", chunk),
    stderr: (chunk) => append("stderr", chunk),
    finish: () => {
      if (closed) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      while (states.stdout.raw.length > 0 || states.stderr.raw.length > 0) {
        drain("stdout", true);
        drain("stderr", true);
        flush(true);
      }
      while (states.stdout.pending !== null || states.stderr.pending !== null) flush(true);
      closed = true;
    },
  };
}

/**
 * SCP does not expose a stable non-TTY byte-progress API. D500 therefore
 * reports only start and the locally verified final count; it never parses
 * presentation text or invents intermediate transfer progress.
 */
export function createStructuredSshTransferProgressReporter(
  operation: "copy-upload" | "copy-download",
  report: Report,
): { readonly starting: (totalBytes?: number) => void; readonly completed: (bytes: number) => void } {
  const startedAt = Date.now();
  let sequence = 0;
  let started = false;
  const emit = (phase: "starting" | "transferring", transferredBytes: number, totalBytes?: number): void => {
    if (report === undefined) return;
    try {
      const observation: RelayStructuredSshProgressObservation = {
        version: 1,
        sequence: sequence++,
        operation,
        kind: "transfer",
        phase,
        transferredBytes,
        ...(totalBytes === undefined ? {} : { totalBytes }),
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
      report(observation);
    } catch {
      // Progress observers have no authority over the transfer or its result.
    }
  };
  return {
    starting: (totalBytes) => {
      if (started) return;
      started = true;
      emit("starting", 0, totalBytes);
    },
    completed: (bytes) => {
      // A final count is never allowed to fabricate a prior transfer start.
      if (!started) return;
      emit("transferring", bytes, bytes);
    },
  };
}
