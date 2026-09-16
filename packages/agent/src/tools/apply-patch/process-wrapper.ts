/**
 * D448 Phase 1.3 — constrained, runtime-neutral apply-patch process wrapper.
 *
 * This module deliberately does not spawn a process itself. A platform-owned
 * adapter must construct a sandbox and start the already-resolved Nautilo
 * binary. The wrapper owns the invariant input shape, cancellation handling,
 * and contract validation so adapters cannot
 * accidentally reintroduce shell, PATH, argv, or environment fallbacks.
 */

import {
  type ApplyPatchError,
  type ApplyPatchProcessOutput,
  validateApplyPatchProcessOutput,
  validateApplyPatchRequest,
} from "./contract";

export interface ApplyPatchSandboxAdapter<SandboxHandle> {
  /** Construct the required platform sandbox for this one authorized root. */
  createSandbox(input: { readonly root: string }): Promise<SandboxHandle> | SandboxHandle;
  /**
   * Start the product-owned binary. The wrapper supplies every field below;
   * callers can never select a shell, argv, environment, or alternate cwd.
   */
  start(
    sandbox: SandboxHandle,
    input: {
      readonly binaryPath: string;
      readonly argv: readonly [];
      readonly cwd: string;
      readonly env: Readonly<Record<string, never>>;
      readonly stdin: string;
    },
  ): Promise<ApplyPatchStartedProcess> | ApplyPatchStartedProcess;
  /** Terminate the complete child process tree, not just its immediate parent. */
  terminateProcessTree(
    sandbox: SandboxHandle,
    process: ApplyPatchStartedProcess,
  ): Promise<void> | void;
  /** Release the platform sandbox and any temporary state for this invocation. */
  cleanupSandbox(sandbox: SandboxHandle): Promise<void> | void;
}

export interface ApplyPatchStartedProcess {
  readonly completed: Promise<ApplyPatchAdapterCompletion>;
}

/** Facts collected by the platform adapter; stderr is diagnostic-only. */
export interface ApplyPatchAdapterCompletion {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export interface RunApplyPatchProcessInput<SandboxHandle> {
  /** Pre-resolved, authorized execution root. */
  readonly root: string;
  /** Model-authored patch body; the wrapper validates it before sandbox creation. */
  readonly patch: string;
  /** Pre-resolved product-owned executable; this wrapper never resolves binaries. */
  readonly binaryPath: string;
  /** Trusted resolver handshake identity; never derived from child stdout. */
  readonly expectedRuntime: ApplyPatchRuntimeIdentity;
  readonly signal?: AbortSignal;
  readonly sandbox: ApplyPatchSandboxAdapter<SandboxHandle>;
}

export type ApplyPatchProcessWrapperResult =
  | {
      readonly ok: true;
      readonly process: ApplyPatchProcessOutput;
      /**
       * Strict native protocol facts. Phase 3 must add trusted pre/post byte
       * reconciliation and a diff before producing ApplyPatchChildExecutionReport.
       */
      readonly report: ApplyPatchNativeExecutionReport;
    }
  | {
      readonly ok: false;
      readonly error: ApplyPatchError;
      readonly process?: ApplyPatchProcessOutput;
    };

export type ApplyPatchNativeOperationKind = "add" | "update" | "move" | "delete";
export type ApplyPatchNativeOperationState = "applied" | "not_applied" | "unknown";
export type ApplyPatchNativeFailureKind = "parse" | "context" | "execution";

export interface ApplyPatchRuntimeIdentity {
  readonly protocol: string;
  readonly runtimeVersion: string;
  readonly upstreamRevision: string;
  readonly nautiloExtractionRevision: string;
}

export interface ApplyPatchNativeOperation {
  readonly kind: ApplyPatchNativeOperationKind;
  readonly path: string;
  readonly fromPath?: string;
}

export interface ApplyPatchNativeOperationStateReport extends ApplyPatchNativeOperation {
  readonly state: ApplyPatchNativeOperationState;
}

/** Exact native/apply-patch/src/protocol.rs response, narrowed for later trusted enrichment. */
export interface ApplyPatchNativeExecutionReport {
  readonly protocol: string;
  readonly runtimeVersion: string;
  readonly upstreamRevision: string;
  readonly nautiloExtractionRevision: string;
  readonly ok: boolean;
  readonly partial: boolean;
  readonly plannedPaths: readonly string[];
  readonly appliedPaths: readonly string[];
  readonly plannedOperations: readonly ApplyPatchNativeOperation[];
  readonly operationStates: readonly ApplyPatchNativeOperationStateReport[];
  /** Product-owned classification; unlike the free-form diagnostic, this is authoritative. */
  readonly failureKind?: ApplyPatchNativeFailureKind;
  /** Native diagnostic; never authoritative for public error classification. */
  readonly diagnostic?: string;
}

type CompletionRace =
  | { readonly kind: "completed"; readonly completion: ApplyPatchAdapterCompletion }
  | { readonly kind: "adapter_error" }
  | { readonly kind: "cancelled" };

function error(code: ApplyPatchError["code"], message: string, retryable = false): ApplyPatchError {
  return { code, message, retryable };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function processOutput(
  completion: ApplyPatchAdapterCompletion,
): ApplyPatchProcessOutput {
  return {
    stdout: completion.stdout,
    stderr: completion.stderr,
    exitCode: completion.exitCode,
    signal: completion.signal,
    cancelled: false,
  };
}

function interruptedProcessOutput(): ApplyPatchProcessOutput {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: "SIGKILL",
    cancelled: true,
  };
}

async function awaitCompletion(
  process: ApplyPatchStartedProcess,
  signal: AbortSignal | undefined,
): Promise<CompletionRace> {
  let removeAbortListener: (() => void) | undefined;
  const completed: Promise<CompletionRace> = process.completed
    .then((completion): CompletionRace => ({ kind: "completed", completion }))
    .catch((): CompletionRace => ({ kind: "adapter_error" }));
  const cancelled = new Promise<CompletionRace>((resolve) => {
    if (signal === undefined) return;
    const onAbort = () => resolve({ kind: "cancelled" });
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([completed, cancelled]);
  } finally {
    removeAbortListener?.();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseNativeOperation(value: unknown, stateRequired: boolean): ApplyPatchNativeOperation | ApplyPatchNativeOperationStateReport | null {
  if (!isRecord(value)) return null;
  const allowedKeys = stateRequired
    ? ["from_path", "kind", "path", "state"]
    : ["from_path", "kind", "path"];
  const absentSourceKeys = stateRequired ? ["kind", "path", "state"] : ["kind", "path"];
  if (!hasExactKeys(value, "from_path" in value ? allowedKeys : absentSourceKeys)) return null;
  const kind = value["kind"];
  const path = value["path"];
  const fromPath = value["from_path"];
  if (
    (kind !== "add" && kind !== "update" && kind !== "move" && kind !== "delete") ||
    typeof path !== "string" ||
    path.length === 0 ||
    (fromPath !== undefined && typeof fromPath !== "string") ||
    (kind === "move" && (typeof fromPath !== "string" || fromPath.length === 0)) ||
    (kind !== "move" && fromPath !== undefined)
  ) {
    return null;
  }
  const operation: ApplyPatchNativeOperation = { kind, path, ...(fromPath !== undefined ? { fromPath } : {}) };
  if (!stateRequired) return operation;
  const state = value["state"];
  if (state !== "applied" && state !== "not_applied" && state !== "unknown") return null;
  return { ...operation, state };
}

function sameOperation(
  operation: ApplyPatchNativeOperation,
  state: ApplyPatchNativeOperationStateReport,
): boolean {
  return operation.kind === state.kind && operation.path === state.path && operation.fromPath === state.fromPath;
}

function parseNativeExecutionReport(value: unknown): ApplyPatchNativeExecutionReport | null {
  if (!isRecord(value)) return null;
  const hasDiagnostic = "error" in value;
  const hasFailureKind = "failure_kind" in value;
  const requiredKeys = [
    "applied_paths",
    "nautilo_extraction_revision",
    "ok",
    "operation_states",
    "partial",
    "planned_operations",
    "planned_paths",
    "protocol",
    "runtime_version",
    "upstream_revision",
    ...(hasFailureKind ? ["failure_kind"] : []),
    ...(hasDiagnostic ? ["error"] : []),
  ];
  if (!hasExactKeys(value, requiredKeys)) return null;
  const protocol = value["protocol"];
  const runtimeVersion = value["runtime_version"];
  const upstreamRevision = value["upstream_revision"];
  const nautiloExtractionRevision = value["nautilo_extraction_revision"];
  const failureKind = value["failure_kind"];
  const diagnostic = value["error"];
  if (
    typeof protocol !== "string" || protocol.length === 0 ||
    typeof runtimeVersion !== "string" || runtimeVersion.length === 0 ||
    typeof upstreamRevision !== "string" || upstreamRevision.length === 0 ||
    typeof nautiloExtractionRevision !== "string" || nautiloExtractionRevision.length === 0 ||
    typeof value["ok"] !== "boolean" ||
    typeof value["partial"] !== "boolean" ||
    (failureKind !== undefined && failureKind !== "parse" && failureKind !== "context" && failureKind !== "execution") ||
    (diagnostic !== undefined && (typeof diagnostic !== "string" || diagnostic.length === 0)) ||
    !Array.isArray(value["planned_paths"]) ||
    !Array.isArray(value["applied_paths"]) ||
    !Array.isArray(value["planned_operations"]) ||
    !Array.isArray(value["operation_states"])
  ) {
    return null;
  }
  const plannedPaths = value["planned_paths"];
  const appliedPaths = value["applied_paths"];
  if (!plannedPaths.every((path) => typeof path === "string") || !appliedPaths.every((path) => typeof path === "string")) return null;
  const plannedOperations = value["planned_operations"].map((operation) => parseNativeOperation(operation, false));
  const operationStates = value["operation_states"].map((operation) => parseNativeOperation(operation, true));
  if (plannedOperations.some((operation) => operation === null) || operationStates.some((operation) => operation === null)) return null;
  const planned = plannedOperations as ApplyPatchNativeOperation[];
  const states = operationStates as ApplyPatchNativeOperationStateReport[];
  if (
    planned.length !== plannedPaths.length ||
    states.length !== planned.length ||
    planned.some((operation, index) => operation.path !== plannedPaths[index] || !sameOperation(operation, states[index]!)) ||
    appliedPaths.length !== states.filter((operation) => operation.state === "applied").length ||
    appliedPaths.some((path, index) => path !== states.filter((operation) => operation.state === "applied")[index]?.path)
  ) {
    return null;
  }
  if (
    (value["ok"] === true && (value["partial"] !== false || failureKind !== undefined || diagnostic !== undefined || states.some((state) => state.state !== "applied"))) ||
    (value["ok"] === false && (failureKind === undefined || diagnostic === undefined)) ||
    (value["partial"] === true && value["ok"] !== false)
  ) {
    return null;
  }
  return {
    protocol,
    runtimeVersion,
    upstreamRevision,
    nautiloExtractionRevision,
    ok: value["ok"],
    partial: value["partial"],
    plannedPaths,
    appliedPaths,
    plannedOperations: planned,
    operationStates: states,
    ...(failureKind !== undefined ? { failureKind } : {}),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  };
}

function classifyCompletedProcess(
  process: ApplyPatchProcessOutput,
  expectedRuntime: ApplyPatchRuntimeIdentity,
): ApplyPatchProcessWrapperResult {
  const validated = validateApplyPatchProcessOutput(process);
  if (!validated.ok) return { ok: false, error: validated.error, process };
  if (process.signal !== null) {
    return { ok: false, error: error("runtime_unavailable", "apply_patch runtime exited unexpectedly.", true), process };
  }
  let reportInput: unknown;
  try {
    reportInput = JSON.parse(process.stdout) as unknown;
  } catch {
    return { ok: false, error: error("runtime_corrupt", "apply_patch runtime returned an invalid structured report."), process };
  }
  const report = parseNativeExecutionReport(reportInput);
  if (report === null) {
    return { ok: false, error: error("runtime_corrupt", "apply_patch runtime returned an unknown structured report."), process };
  }
  if (
    report.protocol !== expectedRuntime.protocol ||
    report.runtimeVersion !== expectedRuntime.runtimeVersion ||
    report.upstreamRevision !== expectedRuntime.upstreamRevision ||
    report.nautiloExtractionRevision !== expectedRuntime.nautiloExtractionRevision
  ) {
    return { ok: false, error: error("runtime_corrupt", "apply_patch runtime identity did not match the resolved binary."), process };
  }
  if (process.exitCode === 0 && !report.ok) {
    return { ok: false, error: error("runtime_corrupt", "apply_patch runtime exit status conflicts with its report."), process };
  }
  if (process.exitCode !== 0 && report.ok) {
    return { ok: false, error: error("runtime_corrupt", "apply_patch runtime exit status conflicts with its report."), process };
  }
  if (!report.ok && !report.partial) {
    if (report.failureKind === "context") {
      return {
        ok: false,
        error: error(
          "reapply_required",
          "The target files did not match the patch context. Read the affected files again and construct a new patch.",
        ),
        process,
      };
    }
    if (report.failureKind === "execution") {
      return {
        ok: false,
        error: error(
          "runtime_unavailable",
          "apply_patch could not complete the patch in its private workspace.",
          true,
        ),
        process,
      };
    }
    return {
      ok: false,
      error: error("parse_error", "apply_patch runtime rejected the patch syntax."),
      process,
    };
  }
  return { ok: true, process, report };
}

/**
 * Run the already-resolved runtime under a required sandbox. This foundation
 * deliberately returns only process facts plus a schema-checked native report.
 * Phase 3's trusted pre/post reconciliation supplies a unifiedDiff before the
 * locked child/public normalizers can run.
 */
export async function runApplyPatchProcess<SandboxHandle>(
  input: RunApplyPatchProcessInput<SandboxHandle>,
): Promise<ApplyPatchProcessWrapperResult> {
  const request = validateApplyPatchRequest({ patch: input.patch });
  if (!request.ok) return request;
  if (input.signal?.aborted) {
    return { ok: false, error: error("cancelled", "apply_patch was cancelled.", true) };
  }
  if (hasUnpairedSurrogate(input.root) || hasUnpairedSurrogate(input.binaryPath)) {
    return { ok: false, error: error("runtime_unavailable", "apply_patch runtime path is invalid.") };
  }

  const stdin = JSON.stringify({ patch: request.request.patch });

  let sandbox: SandboxHandle;
  try {
    sandbox = await input.sandbox.createSandbox({ root: input.root });
  } catch {
    return { ok: false, error: error("runtime_unavailable", "apply_patch sandbox is unavailable.", true) };
  }

  let result: ApplyPatchProcessWrapperResult | undefined;
  try {
    if (input.signal?.aborted) {
      result = { ok: false, error: error("cancelled", "apply_patch was cancelled.", true) };
    } else {
      let process: ApplyPatchStartedProcess | undefined;
      try {
        process = await input.sandbox.start(sandbox, {
          binaryPath: input.binaryPath,
          argv: [],
          cwd: input.root,
          env: {},
          stdin,
        });
      } catch {
        result = { ok: false, error: error("runtime_unavailable", "apply_patch runtime could not start.", true) };
      }
      if (process !== undefined) {
        const race = await awaitCompletion(process, input.signal);
        if (race.kind === "adapter_error") {
          try {
            await input.sandbox.terminateProcessTree(sandbox, process);
            result = { ok: false, error: error("runtime_unavailable", "apply_patch runtime failed during execution.", true) };
          } catch {
            result = { ok: false, error: error("runtime_unavailable", "apply_patch runtime process tree could not be terminated.", true) };
          }
        } else if (race.kind === "completed") {
          result = classifyCompletedProcess(processOutput(race.completion), input.expectedRuntime);
        } else {
          try {
            await input.sandbox.terminateProcessTree(sandbox, process);
            const interrupted = interruptedProcessOutput();
            const validated = validateApplyPatchProcessOutput(interrupted);
            result = !validated.ok
              ? { ok: false, error: validated.error, process: interrupted }
              : { ok: false, error: error("runtime_unavailable", "apply_patch runtime interruption could not be validated.") };
          } catch {
            result = { ok: false, error: error("runtime_unavailable", "apply_patch runtime process tree could not be terminated.", true) };
          }
        }
      }
    }
  } catch {
    result = { ok: false, error: error("runtime_unavailable", "apply_patch runtime execution failed.", true) };
  }

  try {
    await input.sandbox.cleanupSandbox(sandbox);
  } catch {
    return { ok: false, error: error("runtime_unavailable", "apply_patch sandbox cleanup failed.", true) };
  }
  return result ?? { ok: false, error: error("runtime_unavailable", "apply_patch runtime execution did not produce an outcome.") };
}
