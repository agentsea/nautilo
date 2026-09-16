import { access } from "node:fs/promises";
import { ensureAppOperationContext } from "./app-operation-id";
import { createAppToolHost, handleHostRpc, HostOperationError } from "./app-tool-host";
import {
  validateCurrentFolderRelativePath,
  validateWorkspaceLogicalPath,
} from "./app-tool-target";
import { getLiveAppSessionExtension, isDirectMutationLiveReviewExtension } from "./live-review-extension-registry";
import type {
  AppDirectMutationGateFailure,
  AppToolCompletedHostMutation,
  AppToolCurrentFileIdentityResolver,
  AppToolInvokeRequest,
  AppToolInvokeResult,
  AppToolWorkspaceArtifactResolver,
} from "./app-tool-types";
import {
  APP_TOOL_WORKER_SCRIPT,
  type ParentLine,
  type WorkerInvokePayload,
  type WorkerLine,
} from "./app-tool-worker";

export const APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS = 10_000;
const APP_TOOL_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const APP_TOOL_MAX_MESSAGE_BYTES = APP_TOOL_DEFAULT_MAX_BYTES;
const APP_TOOL_MAX_ERROR_CHARS = 4_096;
const APP_TOOL_MAX_RPC_CALLS = 64;

export type AppToolRunnerLimits = Readonly<{
  maxMessageBytes: number;
}>;

export type AppToolJsonLine = Readonly<{
  line: string;
  bytes: number;
}>;

export type AppToolRunnerOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  workerScriptPath?: string;
  spawnWorker?: typeof spawnAppToolWorker;
  /** Override stdin/stdout/result size limits (tests only; production defaults to 50 MiB). */
  maxMessageBytes?: number;
  liveReviewArtifactId?: AppToolWorkspaceArtifactResolver;
  liveReviewCurrentFileIdentity?: AppToolCurrentFileIdentityResolver;
};

export function resolveAppToolRunnerLimits(
  options: Pick<AppToolRunnerOptions, "maxMessageBytes"> = {},
): AppToolRunnerLimits {
  return { maxMessageBytes: options.maxMessageBytes ?? APP_TOOL_MAX_MESSAGE_BYTES };
}

function boundErrorMessage(message: string): string {
  if (message.length <= APP_TOOL_MAX_ERROR_CHARS) return message;
  return `${message.slice(0, APP_TOOL_MAX_ERROR_CHARS)}…`;
}

/**
 * The worker protocol is JSON Lines. Its limit applies to the bytes actually
 * sent over the pipe, including JSON escaping and the record delimiter.
 */
export function serializeAppToolJsonLine(envelope: unknown): AppToolJsonLine {
  const line = `${JSON.stringify(envelope)}\n`;
  return { line, bytes: Buffer.byteLength(line, "utf8") };
}

export type AppToolJsonLinePushResult = Readonly<{
  lines: readonly Buffer[];
  oversized: boolean;
}>;

/**
 * Accumulates binary JSON Lines without repeatedly copying a growing partial
 * line. A pending line is joined only once, when its LF delimiter arrives.
 */
export class AppToolJsonLineAccumulator {
  private chunks: Buffer[] = [];
  private pendingBytes = 0;

  constructor(private readonly maxLineBytes: number) {}

  get pendingChunkCount(): number {
    return this.chunks.length;
  }

  push(value: Uint8Array): AppToolJsonLinePushResult {
    const chunk = Buffer.from(value);
    const lines: Buffer[] = [];
    let offset = 0;

    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline >= 0 ? newline : chunk.byteLength;
      const segment = chunk.subarray(offset, end);
      if (this.pendingBytes + segment.byteLength + 1 > this.maxLineBytes) {
        return { lines, oversized: true };
      }
      if (segment.byteLength > 0) {
        this.chunks.push(segment);
        this.pendingBytes += segment.byteLength;
      }
      if (newline < 0) break;

      lines.push(this.completeLine());
      offset = newline + 1;
    }

    return { lines, oversized: false };
  }

  private completeLine(): Buffer {
    const line =
      this.chunks.length === 0
        ? Buffer.alloc(0)
        : this.chunks.length === 1
          ? this.chunks[0]!
          : Buffer.concat(this.chunks, this.pendingBytes);
    this.chunks = [];
    this.pendingBytes = 0;
    return line;
  }
}

class AppToolWireCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppToolWireCapacityError";
  }
}

function parseDirectMutationFailure(error: string): AppDirectMutationGateFailure | null {
  try {
    const parsed = JSON.parse(error) as Record<string, unknown>;
    if (
      parsed["ok"] === false &&
      parsed["status"] === "use_edit_open_writer" &&
      parsed["code"] === "use_edit_open_writer" &&
      parsed["message"] ===
        "This document has an active mini-app editing session. Use that app’s live editing tools in the tab where it is open, or close that editor before editing the saved file."
    ) {
      return parsed as AppDirectMutationGateFailure;
    }
  } catch {
    // Ordinary handler error.
  }
  return null;
}

function buildWorkerPayload(request: AppToolInvokeRequest): WorkerInvokePayload {
  return {
    bundlePath: request.bundlePath,
    modulePath: request.tool.module,
    handler: request.tool.handler,
    args: request.args,
    ...(request.platformGate ? { platformGate: request.platformGate } : {}),
  };
}

export function normalizeAppToolMutationPath(
  surface: "workspace" | "currentFolder",
  value: string,
): string | null {
  const validated = surface === "workspace"
    ? validateWorkspaceLogicalPath(value)
    : validateCurrentFolderRelativePath(value);
  if (!validated.ok) return null;
  return "path" in validated ? validated.path : validated.relativePath;
}

function completedHostMutation(
  method: string,
  args: unknown[],
  value: unknown,
): AppToolCompletedHostMutation | null {
  if (method === "document.createFromAction") {
    const input = args[1];
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        !value || typeof value !== "object" || Array.isArray(value)) return null;
    const options = input as Record<string, unknown>;
    const created = value as Record<string, unknown>;
    const mutation = completedHostMutation("document.createDocument", [{
      surface: options["targetSurface"], path: options["filename"],
    }], { ok: true, artifactPath: created["displayPath"],
      sha256: created["sha256"], byteLength: created["byteLength"] });
    return mutation ? { ...mutation, method } : null;
  }
  if (method !== "document.createDocument" && method !== "document.createRasterFromSvg") {
    return null;
  }
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const target = input as Record<string, unknown>;
  if (
    (target["surface"] !== "workspace" && target["surface"] !== "currentFolder") ||
    typeof target["path"] !== "string"
  ) {
    return null;
  }
  const normalizedPath = normalizeAppToolMutationPath(target["surface"], target["path"]);
  if (normalizedPath === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (receipt["ok"] === true) {
    if (
      typeof receipt["artifactPath"] !== "string" ||
      typeof receipt["sha256"] !== "string" ||
      typeof receipt["byteLength"] !== "number" ||
      !Number.isSafeInteger(receipt["byteLength"]) ||
      receipt["byteLength"] < 0
    ) {
      return null;
    }
    return {
      method,
      target: { surface: target["surface"], path: normalizedPath },
      receipt: {
        ok: true,
        artifactPath: receipt["artifactPath"],
        sha256: receipt["sha256"],
        byteLength: receipt["byteLength"],
      },
    };
  }

  if (
    receipt["ok"] !== false ||
    receipt["stateChanged"] !== true ||
    receipt["retrySafe"] !== false ||
    typeof receipt["code"] !== "string" ||
    typeof receipt["message"] !== "string" ||
    (receipt["displayPath"] !== undefined && typeof receipt["displayPath"] !== "string") ||
    (receipt["bytesWritten"] !== undefined &&
      (typeof receipt["bytesWritten"] !== "number" ||
        !Number.isSafeInteger(receipt["bytesWritten"]) ||
        receipt["bytesWritten"] < 0)) ||
    (receipt["metadataConfirmed"] !== undefined && receipt["metadataConfirmed"] !== false)
  ) return null;

  return {
    method,
    target: { surface: target["surface"], path: normalizedPath },
    receipt: {
      ok: false,
      code: receipt["code"],
      message: receipt["message"],
      ...(receipt["displayPath"] !== undefined
        ? { displayPath: receipt["displayPath"] }
        : {}),
      ...(receipt["bytesWritten"] !== undefined
        ? { bytesWritten: receipt["bytesWritten"] }
        : {}),
      ...(receipt["metadataConfirmed"] !== undefined
        ? { metadataConfirmed: false as const }
        : {}),
      stateChanged: true,
      retrySafe: false,
    },
  };
}

export async function spawnAppToolWorker(
  workerScriptPath: string,
  payload: WorkerInvokePayload,
  host: ReturnType<typeof createAppToolHost>,
  timeoutMs: number,
  limits: AppToolRunnerLimits = resolveAppToolRunnerLimits(),
): Promise<AppToolInvokeResult> {
  const payloadLine = serializeAppToolJsonLine(payload);
  if (payloadLine.bytes > limits.maxMessageBytes) {
    return { ok: false, error: "Invoke payload exceeds size limit.", code: "bounded" };
  }

  const bunExecutable = process.execPath;
  const proc = Bun.spawn([bunExecutable, workerScriptPath], {
    env: {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let settled = false;
  let rpcCount = 0;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  // One monotonic wall-clock deadline governs the worker. An admitted host RPC
  // is allowed to settle after expiry so its durable result can be reported,
  // but the child is killed at the deadline and cannot resume app code.
  const workerTimeoutMs = Math.max(0, timeoutMs);
  const executionStartedAt = performance.now();
  const completedHostMutations: AppToolCompletedHostMutation[] = [];

  const expireWorkerExecution = (): void => {
    if (timedOut || settled) return;
    timedOut = true;
    timeoutHandle = null;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };

  const armWorkerExecutionDeadline = (): void => {
    if (timedOut || settled) return;
    if (workerTimeoutMs <= 0) {
      expireWorkerExecution();
      return;
    }
    timeoutHandle = setTimeout(expireWorkerExecution, workerTimeoutMs);
  };

  const workerExecutionExpired = (): boolean => {
    if (timedOut) return true;
    if (
      timeoutHandle !== null &&
      performance.now() - executionStartedAt >= workerTimeoutMs
    ) {
      expireWorkerExecution();
    }
    return timedOut;
  };

  const timeoutFailure = (): AppToolInvokeResult => ({
    ok: false,
    error: "App tool handler timed out.",
    code: "timeout",
  });

  const finish = (result: AppToolInvokeResult): AppToolInvokeResult => {
    if (settled) return result;
    settled = true;
    const completedResult =
      !result.ok && completedHostMutations.length > 0
        ? { ...result, completedHostMutations: [...completedHostMutations] }
        : result;
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
    try {
      void proc.stdin.end();
    } catch {
      /* ignore */
    }
    return completedResult;
  };

  const writeToWorker = (line: ParentLine): void => {
    const encoded = serializeAppToolJsonLine(line);
    if (encoded.bytes > limits.maxMessageBytes) {
      throw new AppToolWireCapacityError("Host RPC response exceeds size limit.");
    }
    void proc.stdin.write(encoded.line);
  };

  void proc.stdin.write(payloadLine.line);

  armWorkerExecutionDeadline();

  try {
    const stdout = proc.stdout;
    if (!stdout) {
      return finish({ ok: false, error: "Worker stdout unavailable.", code: "runner" });
    }

    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    const lineAccumulator = new AppToolJsonLineAccumulator(limits.maxMessageBytes);

    while (true) {
      const { value, done } = await reader.read();
      if (workerExecutionExpired()) return finish(timeoutFailure());
      if (value) {
        const received = lineAccumulator.push(value);
        if (received.oversized) {
          return finish({
            ok: false,
            error: "Worker stdout line exceeds size limit.",
            code: "bounded",
          });
        }

        for (const lineBytes of received.lines) {
          if (workerExecutionExpired()) return finish(timeoutFailure());
          // Count the actual received JSON line, rather than parsed values:
          // this includes the envelope keys, JSON escaping, UTF-8 expansion,
          // and LF. The accumulator already enforced this byte budget.
          const line = decoder.decode(lineBytes);

          if (line.trim().length === 0) continue;

          let parsed: WorkerLine;
          try {
            parsed = JSON.parse(line) as WorkerLine;
          } catch {
            return finish({ ok: false, error: "Worker emitted invalid JSON.", code: "runner" });
          }

          if (parsed.type === "rpc") {
            if (workerExecutionExpired()) return finish(timeoutFailure());
            rpcCount += 1;
            if (rpcCount > APP_TOOL_MAX_RPC_CALLS) {
              return finish({
                ok: false,
                error: "Worker exceeded host RPC call limit.",
                code: "bounded",
              });
            }

            let rpcValue: unknown;
            let rpcError: unknown;
            let rpcSucceeded = false;
            try {
              rpcValue = await handleHostRpc(host, parsed.method, parsed.args ?? []);
              rpcSucceeded = true;
            } catch (error) {
              rpcError = error;
            }

            if (rpcSucceeded) {
              const mutation = completedHostMutation(
                parsed.method,
                parsed.args ?? [],
                rpcValue,
              );
              if (mutation) completedHostMutations.push(mutation);
            }
            if (workerExecutionExpired()) return finish(timeoutFailure());

            if (rpcSucceeded) {
              try {
                writeToWorker({ type: "rpc-res", id: parsed.id, ok: true, value: rpcValue });
              } catch (error) {
                if (error instanceof AppToolWireCapacityError) {
                  return finish({ ok: false, error: error.message, code: "bounded" });
                }
                throw error;
              }
            } else {
              const err = rpcError;
              const message =
                err instanceof HostOperationError || err instanceof Error ? err.message : String(err);
              try {
                writeToWorker({
                  type: "rpc-res",
                  id: parsed.id,
                  ok: false,
                  error: boundErrorMessage(message),
                });
              } catch (responseError) {
                if (responseError instanceof AppToolWireCapacityError) {
                  return finish({ ok: false, error: responseError.message, code: "bounded" });
                }
                throw responseError;
              }
            }

            continue;
          }

          if (parsed.type === "platform-failure") {
            const gate = payload.platformGate;
            if (
              !gate ||
              parsed.nonce !== gate.nonce ||
              parsed.failure.kind !== gate.kind ||
              parsed.failure.code !== "live_review_session_sentinel_mismatch" ||
              parsed.failure.status !== "session_closed"
            ) {
              return finish({
                ok: false,
                error: "Worker emitted an invalid platform failure.",
                code: "runner",
              });
            }
            return finish({
              ok: false,
              error: "Platform gate rejected app tool invocation.",
              code: "platform",
              platformFailure: parsed.failure,
            });
          }

          if (parsed.type === "result") {
            if (parsed.ok) {
              // The complete worker result envelope was already byte-bounded
              // above. Do not apply a conflicting second value-only limit.
              return finish({ ok: true, result: parsed.value });
            }
            const directMutationFailure = parseDirectMutationFailure(parsed.error);
            if (directMutationFailure) {
              return finish({
                ok: false,
                error: parsed.error,
                code: "direct_mutation",
                directMutationFailure,
              });
            }
            return finish({
              ok: false,
              error: boundErrorMessage(parsed.error),
              code: "handler",
            });
          }
        }
      }

      if (done) break;
    }

    if (workerExecutionExpired()) return finish(timeoutFailure());

    const exitCode = await proc.exited;
    if (workerExecutionExpired()) return finish(timeoutFailure());
    const stderrText = proc.stderr ? await new Response(proc.stderr).text() : "";
    const fallback =
      stderrText.trim().length > 0
        ? stderrText.trim()
        : `Worker exited with code ${exitCode} before returning a result.`;
    return finish({ ok: false, error: boundErrorMessage(fallback), code: "runner" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finish({ ok: false, error: boundErrorMessage(message), code: "runner" });
  } finally {
    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
  }
}

export async function invokeAppTool(
  request: AppToolInvokeRequest,
  options: AppToolRunnerOptions = {},
): Promise<AppToolInvokeResult> {
  const timeoutMs = options.timeoutMs ?? APP_TOOL_RUNNER_DEFAULT_TIMEOUT_MS;
  const invocationDeadline = performance.now() + Math.max(0, timeoutMs);
  const workerScriptPath = options.workerScriptPath ?? APP_TOOL_WORKER_SCRIPT;
  const spawnWorker = options.spawnWorker ?? spawnAppToolWorker;

  try {
    await access(request.bundlePath);
  } catch {
    return { ok: false, error: "Agent tool bundle is unavailable.", code: "runner" };
  }

  const invocationController = new AbortController();
  const abortInvocation = () => invocationController.abort();
  if (options.signal?.aborted) abortInvocation();
  options.signal?.addEventListener("abort", abortInvocation, { once: true });
  const host = createAppToolHost({
    invocation: { toolId: request.tool.id, signal: invocationController.signal, deadline: Date.now() + timeoutMs },
    appId: request.appId,
    appRoot: request.appRoot,
    appsRoot: request.appsRoot,
    sourceHash: request.sourceHash,
    manifest: request.manifest,
    context: ensureAppOperationContext(request.context, request.appId),
    ...(options.liveReviewArtifactId
      ? {
          liveReviewArtifactId: (
            target: { surface: "workspace"; path: string },
            context: AppToolInvokeRequest["context"],
          ) => options.liveReviewArtifactId!(target.path, context),
        }
      : {}),
    ...(options.liveReviewCurrentFileIdentity
      ? { liveReviewCurrentFileIdentity: options.liveReviewCurrentFileIdentity }
      : {}),
    ...(request.liveMutationBinding
      ? { liveMutationBinding: request.liveMutationBinding }
      : {}),
    remainingToolTimeMs: () => invocationDeadline - performance.now(),
  });

  const limits = resolveAppToolRunnerLimits(options);
  const payload = buildWorkerPayload(request);
  try {
    const result = await spawnWorker(workerScriptPath, payload, host, timeoutMs, limits);
    const extension = getLiveAppSessionExtension(request.appId);
    if (!result.ok && (result.code === "timeout" || result.code === "runner") && extension &&
        isDirectMutationLiveReviewExtension(extension) && extension.sessionCommands?.toolIds.includes(request.tool.id)) {
      // A lost worker result cannot prove that a dispatched UI action failed.
      // Do not turn it into an ordinary retryable tool error.
      return { ok: true, result: { status: "unknown", stateChanged: "unknown", retrySafe: false } };
    }
    return result;
  } finally {
    options.signal?.removeEventListener("abort", abortInvocation);
    invocationController.abort();
  }
}
