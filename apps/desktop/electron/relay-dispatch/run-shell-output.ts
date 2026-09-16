import { Buffer } from "node:buffer";

import type { DesktopShellResult, RelayDispatchRequest } from "@nautilo/relay";

import {
  RunShellOutputArtifactStore,
  RunShellSanitizedOutputCapture,
  knownRunShellSecretValues,
} from "../run-shell-output-continuity.ts";
import type { DesktopDispatchDecision } from "./router.ts";

const RUN_SHELL_PROGRESS_CHUNK_BYTES = 4 * 1024;
const RUN_SHELL_PROGRESS_PENDING_BYTES = 8 * 1024;
const RUN_SHELL_PROGRESS_INTERVAL_MS = 100;

/**
 * Keep pipe drainage independent from websocket/render throughput. The
 * bounded coalescer never awaits or throws in a child `data` listener.
 */
export function createRunShellProgressReporter(
  report: RelayDispatchRequest["reportRunShellProgress"],
): {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  finish(): void;
} {
  type Stream = "stdout" | "stderr";
  type Pending = { start: number; end: number; bytes: Buffer; dropped: number };
  const offsets: Record<Stream, number> = { stdout: 0, stderr: 0 };
  const pending: Record<Stream, Pending | null> = {
    stdout: null,
    stderr: null,
  };
  const startedAt = Date.now();
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let nextFlushAt = 0;

  const safeUtf8PrefixLength = (bytes: Buffer): number => {
    if (bytes.length === 0) return 0;
    let start = bytes.length - 1;
    while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
    const leading = bytes[start]!;
    const width =
      leading < 0x80
        ? 1
        : leading >= 0xc2 && leading <= 0xdf
          ? 2
          : leading >= 0xe0 && leading <= 0xef
            ? 3
            : leading >= 0xf0 && leading <= 0xf4
              ? 4
              : 1;
    let candidate = start + width <= bytes.length ? bytes.length : start;
    while (candidate > 0) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, candidate),
        );
        return candidate;
      } catch {
        candidate -= 1;
        while (candidate > 0 && ((bytes[candidate] ?? 0) & 0xc0) === 0x80)
          candidate -= 1;
      }
    }
    return 0;
  };

  const emit = (stream: Stream, item: Pending): void => {
    if (report === undefined) return;
    try {
      report({
        version: 1,
        sequence: sequence++,
        stream,
        offsetBytes: item.start,
        endOffsetBytes: item.end,
        text: item.bytes.toString("utf8"),
        ...(item.dropped > 0 ? { droppedBytes: item.dropped } : {}),
        elapsedMs: Date.now() - startedAt,
        phase: "running",
      });
    } catch {
      // Progress is best effort and cannot alter execution or drainage.
    }
  };

  const schedule = (): void => {
    if (
      closed ||
      timer !== null ||
      (pending.stdout === null && pending.stderr === null)
    )
      return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, RUN_SHELL_PROGRESS_INTERVAL_MS);
  };

  const flush = (force = false): void => {
    if (closed) return;
    const now = Date.now();
    if (!force && now < nextFlushAt) {
      schedule();
      return;
    }
    nextFlushAt = now + RUN_SHELL_PROGRESS_INTERVAL_MS;
    for (const stream of ["stdout", "stderr"] as const) {
      const item = pending[stream];
      if (item === null) continue;
      const candidate = item.bytes.subarray(0, RUN_SHELL_PROGRESS_CHUNK_BYTES);
      const safeLength = safeUtf8PrefixLength(candidate);
      if (safeLength === 0 && !force) continue;
      const sent = candidate.subarray(0, safeLength);
      const rest = item.bytes.subarray(safeLength);
      const sentEnd = item.start + sent.length;
      if (rest.length > 0 && (!force || safeLength > 0)) {
        pending[stream] = {
          start: sentEnd,
          end: item.end,
          bytes: rest,
          dropped: item.dropped,
        };
        emit(stream, {
          start: item.start,
          end: sentEnd,
          bytes: sent,
          dropped: 0,
        });
      } else {
        pending[stream] = null;
        emit(stream, {
          start: item.start,
          end: item.end,
          bytes: sent,
          dropped: item.dropped + item.bytes.length - sent.length,
        });
      }
    }
    schedule();
  };

  const append = (stream: Stream, chunk: Buffer): void => {
    if (closed || chunk.length === 0) return;
    const start = offsets[stream];
    offsets[stream] += chunk.length;
    const existing = pending[stream];
    if (existing === null) {
      const kept = chunk.subarray(0, RUN_SHELL_PROGRESS_PENDING_BYTES);
      pending[stream] = {
        start,
        end: start + chunk.length,
        bytes: kept,
        dropped: chunk.length - kept.length,
      };
    } else {
      const room = Math.max(
        0,
        RUN_SHELL_PROGRESS_PENDING_BYTES - existing.bytes.length,
      );
      const kept = chunk.subarray(0, room);
      pending[stream] = {
        start: existing.start,
        end: existing.end + chunk.length,
        bytes:
          kept.length === 0
            ? existing.bytes
            : Buffer.concat([existing.bytes, kept]),
        dropped: existing.dropped + chunk.length - kept.length,
      };
    }
    flush();
  };

  return {
    stdout: (chunk) => append("stdout", chunk),
    stderr: (chunk) => append("stderr", chunk),
    finish: () => {
      if (timer !== null) clearTimeout(timer);
      while (pending.stdout !== null || pending.stderr !== null) flush(true);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      closed = true;
    },
  };
}

export function createSanitizedRunShellObservation(
  req: RelayDispatchRequest,
  store: RunShellOutputArtifactStore | undefined,
  additionalSecrets: readonly Buffer[] = [],
) {
  const progress = createRunShellProgressReporter(req.reportRunShellProgress);
  const draft =
    req.runShellOwnerBinding === undefined
      ? undefined
      : store?.createDraft(req.runShellOwnerBinding);
  const capture = new RunShellSanitizedOutputCapture(
    [...knownRunShellSecretValues(), ...additionalSecrets],
    (stream, bytes, rawBytes) => {
      if (bytes.length > 0) progress[stream](bytes);
      draft?.append(stream, bytes, rawBytes);
    },
  );
  let finished = false;
  let artifactCommitted = false;
  return {
    stdout: (chunk: Buffer) => capture.append("stdout", chunk),
    stderr: (chunk: Buffer) => capture.append("stderr", chunk),
    finish: () => {
      if (finished) return;
      capture.finish();
      progress.finish();
      finished = true;
    },
    result: (
      disposition: Omit<
        DesktopShellResult,
        | "version"
        | "stdout"
        | "stderr"
        | "stdoutTruncated"
        | "stderrTruncated"
        | "outputArtifact"
      >,
    ): DesktopShellResult => {
      capture.finish();
      progress.finish();
      finished = true;
      const stdout = capture.result("stdout");
      const stderr = capture.result("stderr");
      return {
        version: 1,
        ...disposition,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    },
    attachArtifact: (result: DesktopShellResult): DesktopShellResult => {
      const outputArtifact =
        (result.stdoutTruncated || result.stderrTruncated) &&
        draft !== undefined &&
        !artifactCommitted
          ? draft.commit()
          : undefined;
      artifactCommitted ||= outputArtifact !== undefined;
      return outputArtifact === undefined
        ? result
        : { ...result, outputArtifact };
    },
  };
}

/** Retained output is a pure read lane before any shell authority is prepared. */
export async function dispatchRunShellOutput(input: {
  readonly request: RelayDispatchRequest;
  readonly outputArtifactStore?: RunShellOutputArtifactStore | undefined;
}): Promise<DesktopDispatchDecision> {
  await Promise.resolve();
  const { request: req, outputArtifactStore } = input;
  if (req.toolName !== "run_shell" || req.args["output_artifact"] === undefined)
    return { handled: false };
  const request = req.args["output_artifact"];
  const record =
    typeof request === "object" && request !== null && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : null;
  const unavailable = (): DesktopDispatchDecision => ({
    handled: true,
    result: {
      status: "error",
      errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_UNAVAILABLE",
      error:
        "run_shell output continuation is unavailable on this relay session",
    },
  });
  const notFound = (): DesktopDispatchDecision => ({
    handled: true,
    result: {
      status: "error",
      errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_NOT_FOUND",
      error:
        "run_shell output continuation is unavailable, expired, or belongs to another session",
    },
  });
  const invalid = (
    error = "run_shell output continuation request is invalid",
  ): DesktopDispatchDecision => ({
    handled: true,
    result: {
      status: "error",
      errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_REQUEST_INVALID",
      error,
    },
  });
  if (record?.["operation"] === "search") {
    const allowedKeys = new Set([
      "reference",
      "operation",
      "query",
      "max_matches",
      "context_bytes",
    ]);
    const query = record["query"];
    const maxMatches =
      record["max_matches"] === undefined ? 20 : record["max_matches"];
    const contextBytes =
      record["context_bytes"] === undefined ? 256 : record["context_bytes"];
    if (
      Object.keys(req.args).length !== 1 ||
      typeof record["reference"] !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record["reference"]) ||
      Object.keys(record).some((key) => !allowedKeys.has(key)) ||
      typeof query !== "string" ||
      query.length === 0 ||
      query.length > 1024 ||
      Buffer.byteLength(query, "utf8") > 1024 ||
      typeof maxMatches !== "number" ||
      !Number.isSafeInteger(maxMatches) ||
      maxMatches < 1 ||
      maxMatches > 20 ||
      typeof contextBytes !== "number" ||
      !Number.isSafeInteger(contextBytes) ||
      contextBytes < 0 ||
      contextBytes > 1024
    )
      return invalid("run_shell output continuation search request is invalid");
    if (
      req.runShellOwnerBinding === undefined ||
      outputArtifactStore === undefined
    )
      return unavailable();
    const result = outputArtifactStore.search({
      reference: record["reference"],
      owner: req.runShellOwnerBinding,
      query: Buffer.from(query, "utf8"),
      maxMatches,
      contextBytes,
    });
    return result === null
      ? notFound()
      : { handled: true, result: { status: "ok", result } };
  }
  const allowedKeys = new Set([
    "reference",
    "offset_bytes",
    "max_bytes",
    "delete_after_read",
  ]);
  if (
    Object.keys(req.args).length !== 1 ||
    record === null ||
    typeof record["reference"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record["reference"]) ||
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    (record["delete_after_read"] !== undefined &&
      typeof record["delete_after_read"] !== "boolean") ||
    req.args["command"] !== undefined ||
    req.args["git"] !== undefined ||
    req.args["execution"] !== undefined
  )
    return invalid();
  if (
    req.runShellOwnerBinding === undefined ||
    outputArtifactStore === undefined
  )
    return unavailable();
  const offsetBytes =
    record["offset_bytes"] === undefined ? 0 : record["offset_bytes"];
  const maxBytes =
    record["max_bytes"] === undefined ? 16 * 1024 : record["max_bytes"];
  if (
    typeof offsetBytes !== "number" ||
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 0 ||
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    return invalid("run_shell output continuation paging values are invalid");
  const result = outputArtifactStore.read({
    reference: record["reference"],
    owner: req.runShellOwnerBinding,
    deleteAfterRead: record["delete_after_read"] === true,
    offsetBytes,
    maxBytes,
  });
  return result === null
    ? notFound()
    : { handled: true, result: { status: "ok", result } };
}
