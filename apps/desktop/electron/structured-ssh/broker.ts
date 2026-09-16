import { homedir } from "node:os";
import * as path from "node:path";

import {
  RELAY_SSH_DEFAULT_TIMEOUT_SECONDS,
  type DesktopShellOutputArtifactReference,
  type RelayDispatchRequest,
  type RelayRunShellOwnerBinding,
  type RelaySshApprovedRequestV1,
} from "@nautilo/relay";

import {
  knownRunShellSecretValues,
  RunShellOutputArtifactStore,
  RunShellSanitizedOutputCapture,
} from "../run-shell-output-continuity.ts";

import {
  matchesSshCapabilitySubject,
  parseSshCapability,
  parseSshInvocationSubject,
  type SshCapability,
  type SshHostTrustRecord,
  type SshInvocationSubject,
  type SshOperation,
} from "./contracts.ts";
import {
  createStructuredSshHostTrustBundle,
  type StructuredSshHostTrustBundle,
} from "./identity-confinement.ts";
import {
  resolveStructuredSshCopyPath,
  type StructuredSshCopyConfinementResult,
} from "./copy-confinement.ts";
import {
  observeSshHostKey,
  type SshHostKeyObservationResult,
} from "./host-key-observation.ts";
import {
  OPEN_SSH_PLAN_MAX_IDENTITY_FILES,
  type OpenSshDestinationPlan,
} from "./open-ssh-plan.ts";
import {
  SYSTEM_OPENSSH_PATHS,
  runStructuredSshProcess,
  type RunStructuredSshProcessInput,
  type StructuredSshProcessResult,
} from "./process-runner.ts";
import {
  createStructuredSshExecProgressReporter,
  createStructuredSshTransferProgressReporter,
} from "./progress.ts";

const OPERATION_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REMOTE_COMMAND_BYTES = 4 * 1024;
const MAX_LOCAL_IDENTITY_PATH_BYTES = 4 * 1024;
const PROCESS_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });

export type StructuredSshBrokerFailure =
  | "invalid_request"
  | "aborted"
  | "operation_unsupported"
  | "capability_invalid"
  | "capability_revision_mismatch"
  | "capability_subject_mismatch"
  | "capability_disabled"
  | "capability_not_authorized"
  | "identity_source_unavailable"
  | "host_trust_unavailable"
  | "host_not_trusted"
  | "host_key_unavailable"
  | "host_key_changed"
  | "host_key_ambiguous"
  | "confinement_failed"
  | "copy_path_unavailable"
  | "copy_path_not_authorized"
  | "copy_transfer_limited"
  | "ssh_spawn_failed"
  | "ssh_timed_out"
  /** Copy/auth lanes still fail closed if their bounded diagnostics overflow. */
  | "ssh_output_limited"
  | "ssh_exit_nonzero"
  | "ssh_runner_failed"
  | "cleanup_failed";

/**
 * The caller resolves this directly from the app-local trust store. It is
 * intentionally a narrow handoff because the current store has no read-by-
 * target API suitable for the broker yet.
 */
export type StructuredSshPinnedHostTrustResult =
  | { readonly ok: true; readonly record: SshHostTrustRecord }
  | { readonly ok: false };

export interface StructuredSshBrokerInputs {
  /** Already exact-parsed and approved by the relay boundary. */
  readonly plan: OpenSshDestinationPlan;
  /** Fresh Electron-local capability authorization, never a target grant. */
  readonly capability: SshCapability;
  /** Electron-local SshCapabilityStore revision resolved by the caller. */
  readonly sshCapabilityRevision: number;
  /** Authenticated invocation provenance supplied by the relay dispatch path. */
  readonly subject: SshInvocationSubject;
  /** App-owned support directory for the transient pinned known_hosts file. */
  readonly appDataDirectory: string;
  /** Electron's always-provisioned Nautilo Workspace; never Current Folder. */
  readonly workspaceRoot: string;
  readonly signal: AbortSignal;
}

export interface StructuredSshBrokerDependencies {
  /** Returns only an existing app-local pin; it never reads or edits ~/.ssh. */
  readonly getPinnedHostTrust: (input: { readonly target: { readonly host: string; readonly port: number } }) => Promise<StructuredSshPinnedHostTrustResult>;
  readonly observeHostKey?: (input: { readonly target: { readonly host: string; readonly port: number }; readonly approvedFingerprint: string; readonly signal: AbortSignal }) => Promise<SshHostKeyObservationResult>;
  readonly createHostTrustBundle?: (input: Parameters<typeof createStructuredSshHostTrustBundle>[0]) => Promise<StructuredSshHostTrustBundle>;
  /** Electron-local process state only; never supplied through relay/model input. */
  readonly readDefaultAgentSocket?: () => string | undefined;
  /** Electron-local home resolution seam used only for identity expansion/redaction. */
  readonly readHomeDirectory?: () => string;
  readonly resolveCopyPath?: (input: {
    readonly operation: "copy-upload" | "copy-download";
    readonly localPath: string;
    readonly workspaceRoot: string;
  }) => Promise<StructuredSshCopyConfinementResult>;
  readonly run?: (input: RunStructuredSshProcessInput) => Promise<StructuredSshProcessResult>;
  /** Exact-operation observation callback installed by the negotiated relay client. */
  readonly reportProgress?: RelayDispatchRequest["reportStructuredSshProgress"];
  /** Private Desktop-session continuation authority; neither field crosses the wire. */
  readonly outputArtifactStore?: RunShellOutputArtifactStore | undefined;
  readonly outputArtifactOwner?: RelayRunShellOwnerBinding | undefined;
}

export type StructuredSshBrokerResult =
  | { readonly ok: true; readonly operation: "auth"; readonly authenticated: true; readonly sideEffectStarted: boolean; readonly retrySafe: boolean }
  | { readonly ok: true; readonly operation: "exec"; readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly stdoutTruncated: boolean; readonly stderrTruncated: boolean; readonly outputArtifact?: DesktopShellOutputArtifactReference | undefined; readonly sideEffectStarted: boolean; readonly retrySafe: boolean }
  | { readonly ok: true; readonly operation: "copy-upload" | "copy-download"; readonly bytes: number; readonly sideEffectStarted: boolean; readonly retrySafe: boolean }
  | { readonly ok: false; readonly operation: SshOperation; readonly reason: StructuredSshBrokerFailure; readonly sideEffectStarted: boolean; readonly retrySafe: boolean };

function validSignal(value: unknown): value is AbortSignal {
  return typeof value === "object" && value !== null && typeof (value as AbortSignal).aborted === "boolean" && typeof (value as AbortSignal).addEventListener === "function";
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 31 - 1;
}

function operationFor(request: RelaySshApprovedRequestV1): SshOperation | null {
  return request.toolName === "structured_ssh_auth"
    ? "auth"
    : request.toolName === "structured_ssh_exec"
      ? "exec"
      : request.toolName === "structured_ssh_copy_upload"
        ? "copy-upload"
        : request.toolName === "structured_ssh_copy_download"
          ? "copy-download"
          : null;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

/** Encode literal argv for the remote POSIX shell; it never feeds a local shell. */
export function encodeStructuredSshRemoteCommand(program: string, argv: readonly string[]): string | null {
  const command = [program, ...argv].map(quotePosix).join(" ");
  return Buffer.byteLength(command, "utf8") <= MAX_REMOTE_COMMAND_BYTES ? command : null;
}

function processFailure(operation: SshOperation, result: StructuredSshProcessResult): StructuredSshBrokerFailure | null {
  if (result.termination === "aborted") return "aborted";
  if (result.termination === "spawn_failed") return "ssh_spawn_failed";
  if (result.termination === "timed_out") return "ssh_timed_out";
  if (result.termination === "stdout_limit" || result.termination === "stderr_limit") return "ssh_output_limited";
  if (result.termination !== "exited" || result.code === null) return "ssh_exit_nonzero";
  // OpenSSH reserves 255 for a client/transport failure (including public-key
  // rejection). Other exec statuses are the remote program's ordinary result.
  // Treating 255 as a remote result made authentication failures look like a
  // successfully completed command with stderr.
  if (result.code === 255 || (operation !== "exec" && result.code !== 0)) return "ssh_exit_nonzero";
  return null;
}

function hostFailure(result: SshHostKeyObservationResult): StructuredSshBrokerFailure {
  if (result.ok) return "host_key_unavailable";
  if (result.reason === "host_key_changed") return "host_key_changed";
  if (result.reason === "host_key_ambiguous") return "host_key_ambiguous";
  if (result.reason === "scan_aborted") return "aborted";
  return "host_key_unavailable";
}

function failure(operation: SshOperation, reason: StructuredSshBrokerFailure, processStarted = false): StructuredSshBrokerResult {
  return { ok: false, operation, reason, sideEffectStarted: processStarted, retrySafe: !processStarted };
}

function capabilityAllows(capability: SshCapability, operation: SshOperation): boolean {
  return operation === "auth" ? capability.tools.auth
    : operation === "exec" ? capability.tools.exec
      : operation === "copy-upload" ? capability.tools.copyUpload
        : capability.tools.copyDownload;
}

function remoteHostToken(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function remoteCopyEndpoint(plan: OpenSshDestinationPlan, remotePath: string): string {
  return `${plan.destination.remoteUser}@${remoteHostToken(plan.destination.host)}:${remotePath}`;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeAbsoluteLocalPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 1
    && Buffer.byteLength(value, "utf8") <= MAX_LOCAL_IDENTITY_PATH_BYTES
    && path.isAbsolute(value)
    && path.normalize(value) === value
    && !/[\0\r\n\t %$'"\\]/.test(value);
}

/** Resolve the sole harmless OpenSSH shorthand without accepting token expansion. */
function resolvedIdentityFile(value: unknown, homeDirectory: string): string | null {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_LOCAL_IDENTITY_PATH_BYTES || /[\0\r\n\t %$'"\\]/.test(value)) return null;
  if (value.startsWith("~/") && value.slice(2).split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
  const candidate = value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : value;
  return safeAbsoluteLocalPath(candidate) ? candidate : null;
}

function literalRedactor(values: readonly (string | undefined)[]): (value: string) => string {
  const sensitive = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 1))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  return (value) => sensitive.reduce((redacted, secret) => redacted.split(secret).join("[local-path-redacted]"), value);
}

interface LaunchIdentityConfiguration {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  redactOutput(value: string): string;
}

/**
 * Reconstruct only sources observed by the fresh private plan. In particular,
 * `-F /dev/null` means no user Host/Match config is re-read at execution.
 */
function launchIdentityConfiguration(
  plan: OpenSshDestinationPlan,
  readDefaultAgentSocket: () => string | undefined,
  homeDirectory: string,
): LaunchIdentityConfiguration | null {
  if (!Array.isArray(plan.identitySources) || plan.identitySources.length > OPEN_SSH_PLAN_MAX_IDENTITY_FILES + 1) return null;
  const argv: string[] = [];
  let fileCount = 0;
  let agentSeen = false;
  let env: Readonly<Record<string, string>> = PROCESS_ENVIRONMENT;
  const sensitiveValues: string[] = [homeDirectory];
  for (const candidate of plan.identitySources) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const source = candidate as Record<string, unknown>;
    if (source["kind"] === "file") {
      if (!hasExactKeys(source, ["kind", "identityFile"]) || fileCount >= OPEN_SSH_PLAN_MAX_IDENTITY_FILES) return null;
      const identityFile = resolvedIdentityFile(source["identityFile"], homeDirectory);
      if (identityFile === null) return null;
      argv.push("-i", identityFile);
      sensitiveValues.push(identityFile);
      fileCount += 1;
    } else if (source["kind"] === "agent") {
      if (!hasExactKeys(source, ["kind", "identityAgent"]) || agentSeen) return null;
      agentSeen = true;
      if (source["identityAgent"] === null) {
        const socket = readDefaultAgentSocket();
        if (socket !== undefined) {
          if (!safeAbsoluteLocalPath(socket)) return null;
          env = Object.freeze({ ...PROCESS_ENVIRONMENT, SSH_AUTH_SOCK: socket });
          sensitiveValues.push(socket);
        }
      } else {
        if (!safeAbsoluteLocalPath(source["identityAgent"])) return null;
        argv.push("-o", `IdentityAgent=${source["identityAgent"]}`);
        sensitiveValues.push(source["identityAgent"]);
      }
    } else return null;
  }
  return { argv: Object.freeze(argv), env, redactOutput: literalRedactor(sensitiveValues) };
}

/**
 * Electron-local execution boundary for a managed SSH capability. The caller
 * supplies an already parsed request, a freshly resolved private OpenSSH plan,
 * and fresh capability/revision facts. No grant, selected key, ssh-add check,
 * app-written identity bundle, or system-agent requirement enters this lane.
 */
export async function runStructuredSshBroker(
  request: RelaySshApprovedRequestV1,
  input: StructuredSshBrokerInputs,
  dependencies: StructuredSshBrokerDependencies,
): Promise<StructuredSshBrokerResult> {
  const operation = operationFor(request);
  const fallbackOperation: SshOperation = request?.toolName === "structured_ssh_auth" ? "auth"
    : request?.toolName === "structured_ssh_copy_upload" ? "copy-upload"
      : request?.toolName === "structured_ssh_copy_download" ? "copy-download" : "exec";
  if (operation === null) return failure(fallbackOperation, "operation_unsupported");
  if (!validSignal(input.signal) || input.signal.aborted) return failure(operation, input.signal?.aborted ? "aborted" : "invalid_request");
  if (parseSshInvocationSubject(input.subject) === null || !validRevision(input.sshCapabilityRevision) || typeof input.appDataDirectory !== "string" || input.appDataDirectory.length === 0 || typeof input.workspaceRoot !== "string" || input.workspaceRoot.length === 0) {
    return failure(operation, "invalid_request");
  }
  if (parseSshCapability(input.capability) === null) return failure(operation, "capability_invalid");
  if (!matchesSshCapabilitySubject(input.capability.subject, input.subject)) return failure(operation, "capability_subject_mismatch");
  if (!input.capability.enabled || input.capability.revokedAt !== undefined) return failure(operation, "capability_disabled");
  if (!capabilityAllows(input.capability, operation)) return failure(operation, "capability_not_authorized");
  const readDefaultAgentSocket = dependencies.readDefaultAgentSocket ?? (() => process.env["SSH_AUTH_SOCK"]);
  const readHomeDirectory = dependencies.readHomeDirectory ?? homedir;
  let identities: LaunchIdentityConfiguration | null;
  let homeDirectory: string;
  try {
    homeDirectory = readHomeDirectory();
    identities = launchIdentityConfiguration(input.plan, readDefaultAgentSocket, homeDirectory);
  } catch { return failure(operation, "identity_source_unavailable"); }
  if (identities === null) return failure(operation, "identity_source_unavailable");
  const redactBrokerOutput = literalRedactor([homeDirectory, input.appDataDirectory, input.workspaceRoot]);

  const target = { host: input.plan.destination.host, port: input.plan.destination.port };
  let pinned: StructuredSshPinnedHostTrustResult;
  try { pinned = await dependencies.getPinnedHostTrust({ target }); } catch { return failure(operation, "host_trust_unavailable"); }
  if (input.signal.aborted) return failure(operation, "aborted");
  if (!pinned.ok) return failure(operation, "host_not_trusted");
  if (pinned.record.host !== target.host || pinned.record.port !== target.port || pinned.record.replacedAt !== undefined) return failure(operation, "host_not_trusted");

  const observeHostKey = dependencies.observeHostKey ?? ((value) => observeSshHostKey(value));
  let observed: SshHostKeyObservationResult;
  try { observed = await observeHostKey({ target, approvedFingerprint: pinned.record.hostKeyFingerprint, signal: input.signal }); } catch { return failure(operation, "host_key_unavailable"); }
  if (input.signal.aborted) return failure(operation, "aborted");
  if (!observed.ok) return failure(operation, hostFailure(observed));
  if (observed.data.fingerprint !== pinned.record.hostKeyFingerprint) return failure(operation, "host_key_changed");

  let copyPath: Extract<StructuredSshCopyConfinementResult, { readonly ok: true }> | undefined;
  let remoteCopyPath: string | undefined;
  if (operation === "copy-upload" || operation === "copy-download") {
    if (request.toolName !== "structured_ssh_copy_upload" && request.toolName !== "structured_ssh_copy_download") return failure(operation, "invalid_request");
    const resolveCopyPath = dependencies.resolveCopyPath ?? ((value) => resolveStructuredSshCopyPath(value));
    let resolved: StructuredSshCopyConfinementResult;
    try { resolved = await resolveCopyPath({ operation, localPath: request.args.localPath, workspaceRoot: input.workspaceRoot }); } catch { return failure(operation, "copy_path_unavailable"); }
    if (!resolved.ok) return failure(operation, "copy_path_not_authorized");
    copyPath = resolved;
    remoteCopyPath = request.args.remotePath;
  }

  const createHostTrustBundle = dependencies.createHostTrustBundle ?? createStructuredSshHostTrustBundle;
  let bundle: StructuredSshHostTrustBundle;
  try { bundle = await createHostTrustBundle({ appDataDirectory: input.appDataDirectory, target, knownHostsLine: observed.data.knownHostsLine }); } catch { return failure(operation, "confinement_failed"); }

  let processStarted = false;
  let outcome: StructuredSshBrokerResult = failure(operation, "confinement_failed");
  try {
    try { await bundle.validateForLaunch(); } catch { return failure(operation, "confinement_failed"); }
    if (input.signal.aborted) return failure(operation, "aborted");
    if (copyPath !== undefined && !(await copyPath.validateForLaunch())) return failure(operation, "copy_path_not_authorized");
    const command = request.toolName === "structured_ssh_auth" ? ":"
      : request.toolName === "structured_ssh_exec" ? encodeStructuredSshRemoteCommand(request.args.program, request.args.argv)
        : null;
    if (operation === "exec" && command === null) return failure(operation, "invalid_request");
    try { await bundle.validateForLaunch(); } catch { return failure(operation, "confinement_failed"); }
    if (input.signal.aborted) return failure(operation, "aborted");

    const execSensitiveValues = [
          homeDirectory,
          input.appDataDirectory,
          input.workspaceRoot,
          ...identities.argv.flatMap((value, index, argv) =>
            argv[index - 1] === "-i" ? [value]
              : value.startsWith("IdentityAgent=") ? [value.slice("IdentityAgent=".length)]
                : [],
          ),
          ...bundle.argv.flatMap((value) => {
            const matched = /^UserKnownHostsFile=(.+)$/u.exec(value);
            return matched === null ? [] : [matched[1]!];
          }),
          ...Object.values(identities.env).filter((value) => value.startsWith("/")),
        ];
    const execProgress = operation === "exec"
      ? createStructuredSshExecProgressReporter(dependencies.reportProgress, [])
      : undefined;
    const outputDraft = operation === "exec" && dependencies.outputArtifactOwner !== undefined
      ? dependencies.outputArtifactStore?.createDraft(dependencies.outputArtifactOwner)
      : undefined;
    const outputCapture = operation === "exec"
      ? new RunShellSanitizedOutputCapture(
          [
            ...knownRunShellSecretValues(),
            ...execSensitiveValues.filter((value) => value.length >= 2).map((value) => Buffer.from(value, "utf8")),
          ],
          (stream, bytes, rawBytes) => {
            if (bytes.length > 0) execProgress?.[stream](bytes);
            outputDraft?.append(stream, bytes, rawBytes);
          },
        )
      : undefined;
    let observedStdout = false;
    let observedStderr = false;
    const transferProgress = operation === "copy-upload" || operation === "copy-download"
      ? createStructuredSshTransferProgressReporter(operation, dependencies.reportProgress)
      : undefined;
    // SCP has no stable non-TTY byte-progress interface. The fixed runner
    // emits start only after child creation; final local verification below
    // is the only later transfer observation.
    const processInput: RunStructuredSshProcessInput = {
      executable: operation === "copy-upload" || operation === "copy-download" ? SYSTEM_OPENSSH_PATHS.scp : SYSTEM_OPENSSH_PATHS.ssh,
      argv: operation === "copy-upload"
        ? ["-F", "/dev/null", ...identities.argv, "-o", "IdentitiesOnly=yes", ...bundle.argv, "-P", String(target.port), copyPath!.path, remoteCopyEndpoint(input.plan, remoteCopyPath!)]
        : operation === "copy-download"
          ? ["-F", "/dev/null", ...identities.argv, "-o", "IdentitiesOnly=yes", ...bundle.argv, "-P", String(target.port), remoteCopyEndpoint(input.plan, remoteCopyPath!), copyPath!.path]
          : ["-F", "/dev/null", ...identities.argv, "-o", "IdentitiesOnly=yes", ...bundle.argv, "-T", "-p", String(target.port), "-l", input.plan.destination.remoteUser, "--", input.plan.destination.host, command!],
      env: identities.env,
      timeoutMs: (request.toolName === "structured_ssh_auth"
        ? RELAY_SSH_DEFAULT_TIMEOUT_SECONDS
        : request.args.timeoutSeconds) * 1_000,
      maxStdoutBytes: OPERATION_MAX_OUTPUT_BYTES,
      maxStderrBytes: OPERATION_MAX_OUTPUT_BYTES,
      ...(operation === "exec" ? { terminateOnOutputLimit: false } : {}),
      signal: input.signal,
      ...(execProgress === undefined ? {} : {
        onStdoutChunk: (chunk: Buffer) => {
          observedStdout = true;
          outputCapture?.append("stdout", chunk);
        },
        onStderrChunk: (chunk: Buffer) => {
          observedStderr = true;
          outputCapture?.append("stderr", chunk);
        },
      }),
      ...(transferProgress === undefined ? {} : {
        onStarted: () => transferProgress.starting(operation === "copy-upload" ? copyPath!.bytes : undefined),
      }),
    };
    const run = dependencies.run ?? runStructuredSshProcess;
    try {
      const process = await run(processInput);
      processStarted = process.processStarted;
      if (operation === "exec") {
        // Custom runners may return a bounded result without invoking chunk
        // observers. Never double-feed production chunks.
        if (!observedStdout && process.stdout.length > 0) outputCapture?.append("stdout", Buffer.from(process.stdout, "utf8"));
        if (!observedStderr && process.stderr.length > 0) outputCapture?.append("stderr", Buffer.from(process.stderr, "utf8"));
        outputCapture?.finish();
      }
      execProgress?.finish();
      // Custom test/integration runners may return an authoritative started
      // receipt without invoking the runner lifecycle seam. Backstop it here,
      // but never emit any transfer observation for a failed pre-spawn result.
      if (transferProgress !== undefined && process.processStarted) {
        transferProgress.starting(operation === "copy-upload" ? copyPath!.bytes : undefined);
      }
      const failed = processFailure(operation, process);
      if (failed !== null) outcome = failure(operation, failed, process.processStarted);
      else if (operation === "copy-upload" || operation === "copy-download") {
        const finalized = await copyPath!.validateAfterTransfer();
        if (finalized.ok) {
          // This is the exact verified local count and happens before the
          // canonical receipt. No intermediate bytes are inferred from SCP.
          transferProgress?.completed(finalized.bytes);
          outcome = { ok: true, operation, bytes: finalized.bytes, sideEffectStarted: process.processStarted, retrySafe: !process.processStarted };
        } else outcome = failure(operation, "copy_transfer_limited", process.processStarted);
      } else outcome = operation === "auth"
        ? { ok: true, operation: "auth", authenticated: true, sideEffectStarted: process.processStarted, retrySafe: !process.processStarted }
        : (() => {
            const stdout = outputCapture?.result("stdout") ?? { text: "", truncated: false };
            const stderr = outputCapture?.result("stderr") ?? { text: "", truncated: false };
            const shouldRetain = stdout.truncated || stderr.truncated;
            const outputArtifact = shouldRetain ? outputDraft?.commit() : undefined;
            if (!shouldRetain) outputDraft?.discard();
            return {
            ok: true,
            operation: "exec",
            exitCode: process.code!,
            stdout: redactBrokerOutput(identities.redactOutput(bundle.redactOutput(stdout.text))),
            stderr: redactBrokerOutput(identities.redactOutput(bundle.redactOutput(stderr.text))),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            ...(outputArtifact === undefined ? {} : { outputArtifact }),
            sideEffectStarted: process.processStarted,
            retrySafe: !process.processStarted,
          } as const;
          })();
    } catch {
      execProgress?.finish();
      outputCapture?.finish();
      outputDraft?.discard();
      processStarted = true;
      outcome = failure(operation, "ssh_runner_failed", true);
    }
  } finally {
    try { await bundle.cleanup(); } catch { outcome = failure(operation, "cleanup_failed", processStarted); }
  }
  return outcome;
}
