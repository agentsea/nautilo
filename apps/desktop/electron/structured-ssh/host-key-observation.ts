import { isCanonicalSshHost, isSshFingerprint, type SshHostTrustTarget } from "./contracts.ts";
import { SYSTEM_OPENSSH_PATHS, type RunStructuredSshProcessInput, runStructuredSshProcess, type StructuredSshProcessResult } from "./process-runner.ts";
import { validateSystemAgentPublicKey } from "./system-agent.ts";

const SCAN_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
const SCAN_TIMEOUT_MS = 5_000;
const SCAN_MAX_OUTPUT_BYTES = 16 * 1024;
const SCAN_MAX_LINES = 64;
const SCAN_MAX_IGNORED_LINES = 32;
const SCAN_MAX_LINE_BYTES = 8 * 1024;

export type SshHostKeyObservationReason =
  | "invalid_request"
  | "scan_failed"
  | "scan_timed_out"
  | "scan_aborted"
  | "scan_output_limited"
  | "scanner_output_invalid"
  | "host_key_missing"
  | "host_key_changed"
  | "host_key_ambiguous";

export interface SshHostKeyObservationRequest {
  readonly target: SshHostTrustTarget;
  readonly approvedFingerprint: string;
  readonly signal: AbortSignal;
}

/** Electron-local only. This observation neither writes nor establishes trust. */
export interface SshObservedHostKey {
  readonly fingerprint: string;
  readonly publicKey: string;
  readonly knownHostsLine: string;
}

export type SshHostKeyObservationResult =
  | { readonly ok: true; readonly data: SshObservedHostKey }
  | { readonly ok: false; readonly reason: SshHostKeyObservationReason };

export type SshHostKeyCandidateResult =
  | { readonly ok: true; readonly fingerprints: readonly string[] }
  | { readonly ok: false; readonly reason: SshHostKeyObservationReason };

export interface SshPreferredHostKey {
  readonly fingerprint: string;
  readonly algorithm: "ssh-ed25519" | "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521" | "ssh-rsa";
}

export type SshPreferredHostKeyResult =
  | { readonly ok: true; readonly data: SshPreferredHostKey }
  | { readonly ok: false; readonly reason: SshHostKeyObservationReason };

export interface ObserveSshHostKeyDependencies {
  readonly run?: (input: RunStructuredSshProcessInput) => Promise<StructuredSshProcessResult>;
}

function validTarget(value: unknown): value is SshHostTrustTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && Object.prototype.hasOwnProperty.call(record, "host")
    && Object.prototype.hasOwnProperty.call(record, "port")
    && isCanonicalSshHost(record["host"])
    && typeof record["port"] === "number"
    && Number.isSafeInteger(record["port"])
    && record["port"] >= 1
    && record["port"] <= 65_535;
}

function validAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object"
    && value !== null
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}

function hostToken(target: SshHostTrustTarget): string {
  return target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
}

function ignoredLine(line: string): boolean {
  // ssh-keyscan emits informational lines with '#'. A tolerated raw protocol
  // banner is also discarded; neither can enter the returned observation.
  return /^#[^\r\n]{0,1024}$/.test(line)
    || /^SSH-[A-Za-z0-9._-]{1,64}(?: [^\r\n]{0,256})?$/.test(line);
}

function parseObservationOutput(stdout: string, approvedFingerprint: string): SshHostKeyObservationResult {
  const lines = stdout.split("\n");
  if (lines.length > SCAN_MAX_LINES + 1) return { ok: false, reason: "scanner_output_invalid" };
  const fingerprints = new Set<string>();
  let matching: SshObservedHostKey | undefined;
  let keyLines = 0;
  let ignoredLines = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > SCAN_MAX_LINE_BYTES || /\r|\0/.test(line)) return { ok: false, reason: "scanner_output_invalid" };
    if (ignoredLine(line)) {
      ignoredLines += 1;
      if (ignoredLines > SCAN_MAX_IGNORED_LINES) return { ok: false, reason: "scanner_output_invalid" };
      continue;
    }
    // The scanner's host label and any trailing comment are untrusted. We
    // validate only the exact algorithm/blob pair and recreate all output.
    const fields = line.split(" ");
    if (fields.length < 3 || fields.some((field) => field.length === 0)) return { ok: false, reason: "scanner_output_invalid" };
    const validated = validateSystemAgentPublicKey(`${fields[1]!} ${fields[2]!}`);
    if (validated === null) return { ok: false, reason: "scanner_output_invalid" };
    keyLines += 1;
    if (fingerprints.has(validated.fingerprint)) return { ok: false, reason: "host_key_ambiguous" };
    fingerprints.add(validated.fingerprint);
    if (validated.fingerprint === approvedFingerprint) {
      matching = {
        fingerprint: validated.fingerprint,
        publicKey: validated.canonical,
        // Set after parsing to ensure only the input target names this host.
        knownHostsLine: "",
      };
    }
  }
  if (keyLines === 0) return { ok: false, reason: "host_key_missing" };
  if (matching === undefined) return { ok: false, reason: "host_key_changed" };
  return { ok: true, data: matching };
}

function parseCandidateOutput(stdout: string): SshHostKeyCandidateResult {
  const lines = stdout.split("\n");
  if (lines.length > SCAN_MAX_LINES + 1) return { ok: false, reason: "scanner_output_invalid" };
  const fingerprints = new Set<string>();
  let keyLines = 0;
  let ignoredLines = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > SCAN_MAX_LINE_BYTES || /\r|\0/.test(line)) return { ok: false, reason: "scanner_output_invalid" };
    if (ignoredLine(line)) {
      ignoredLines += 1;
      if (ignoredLines > SCAN_MAX_IGNORED_LINES) return { ok: false, reason: "scanner_output_invalid" };
      continue;
    }
    const fields = line.split(" ");
    if (fields.length < 3 || fields.some((field) => field.length === 0)) return { ok: false, reason: "scanner_output_invalid" };
    const validated = validateSystemAgentPublicKey(`${fields[1]!} ${fields[2]!}`);
    if (validated === null || fingerprints.has(validated.fingerprint)) return { ok: false, reason: "scanner_output_invalid" };
    fingerprints.add(validated.fingerprint);
    keyLines += 1;
  }
  return keyLines === 0
    ? { ok: false, reason: "host_key_missing" }
    : { ok: true, fingerprints: [...fingerprints].sort() };
}

function preferredAlgorithmRank(algorithm: SshPreferredHostKey["algorithm"]): number {
  // OpenSSH's modern default is ed25519. ECDSA curves are the deterministic
  // fallback in increasing curve size, followed by RSA; this is preference,
  // not a trust assertion, and the Human sees the resulting fingerprint.
  return algorithm === "ssh-ed25519" ? 0
    : algorithm === "ecdsa-sha2-nistp256" ? 1
      : algorithm === "ecdsa-sha2-nistp384" ? 2
        : algorithm === "ecdsa-sha2-nistp521" ? 3
          : 4;
}

/** Deterministically prefer modern ed25519, then safe supported fallbacks. */
export function selectPreferredSshHostKey(candidates: readonly SshPreferredHostKey[]): SshPreferredHostKey | null {
  if (candidates.length === 0) return null;
  const unique = new Map<string, SshPreferredHostKey>();
  for (const candidate of candidates) {
    if (!isSshFingerprint(candidate.fingerprint) || !["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"].includes(candidate.algorithm)) return null;
    if (unique.has(candidate.fingerprint)) return null;
    unique.set(candidate.fingerprint, candidate);
  }
  return [...unique.values()].sort((left, right) =>
    preferredAlgorithmRank(left.algorithm) - preferredAlgorithmRank(right.algorithm)
      || left.fingerprint.localeCompare(right.fingerprint),
  )[0]!;
}

function parsePreferredCandidateOutput(stdout: string): SshPreferredHostKeyResult {
  const lines = stdout.split("\n");
  if (lines.length > SCAN_MAX_LINES + 1) return { ok: false, reason: "scanner_output_invalid" };
  const candidates: SshPreferredHostKey[] = [];
  let ignoredLines = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > SCAN_MAX_LINE_BYTES || /\r|\0/.test(line)) return { ok: false, reason: "scanner_output_invalid" };
    if (ignoredLine(line)) {
      if (++ignoredLines > SCAN_MAX_IGNORED_LINES) return { ok: false, reason: "scanner_output_invalid" };
      continue;
    }
    const fields = line.split(" ");
    if (fields.length < 3 || fields.some((field) => field.length === 0)) return { ok: false, reason: "scanner_output_invalid" };
    const validated = validateSystemAgentPublicKey(`${fields[1]!} ${fields[2]!}`);
    if (validated === null) return { ok: false, reason: "scanner_output_invalid" };
    const algorithm = validated.canonical.split(" ", 1)[0] as SshPreferredHostKey["algorithm"];
    candidates.push({ algorithm, fingerprint: validated.fingerprint });
  }
  const selected = selectPreferredSshHostKey(candidates);
  return selected === null
    ? { ok: false, reason: candidates.length === 0 ? "host_key_missing" : "scanner_output_invalid" }
    : { ok: true, data: selected };
}

function terminationReason(result: StructuredSshProcessResult): SshHostKeyObservationReason | null {
  if (result.termination === "timed_out") return "scan_timed_out";
  if (result.termination === "aborted") return "scan_aborted";
  if (result.termination === "stdout_limit" || result.termination === "stderr_limit") return "scan_output_limited";
  if (result.termination !== "exited" || result.code !== 0) return "scan_failed";
  return null;
}

/**
 * Observe one already-approved host fingerprint through fixed Apple
 * ssh-keyscan. Scanner labels, comments, and stderr are never trusted or
 * returned. The caller still must explicitly establish trust elsewhere.
 */
export async function observeSshHostKey(
  request: SshHostKeyObservationRequest,
  dependencies: ObserveSshHostKeyDependencies = {},
): Promise<SshHostKeyObservationResult> {
  if (!validTarget(request.target) || !isSshFingerprint(request.approvedFingerprint) || !validAbortSignal(request.signal)) return { ok: false, reason: "invalid_request" };
  const run = dependencies.run ?? runStructuredSshProcess;
  const result = await run({
    executable: SYSTEM_OPENSSH_PATHS.sshKeyscan,
    argv: ["-T", "5", "-p", String(request.target.port), request.target.host],
    env: SCAN_ENVIRONMENT,
    timeoutMs: SCAN_TIMEOUT_MS,
    maxStdoutBytes: SCAN_MAX_OUTPUT_BYTES,
    maxStderrBytes: SCAN_MAX_OUTPUT_BYTES,
    signal: request.signal,
  });
  const failed = terminationReason(result);
  if (failed !== null) return { ok: false, reason: failed };
  const parsed = parseObservationOutput(result.stdout, request.approvedFingerprint);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    data: {
      fingerprint: parsed.data.fingerprint,
      publicKey: parsed.data.publicKey,
      knownHostsLine: `${hostToken(request.target)} ${parsed.data.publicKey}`,
    },
  };
}

/**
 * Human setup discovery only. It deliberately returns fingerprints, not key
 * bytes or scanner output; `observeSshHostKey` scans again after the Human
 * chooses one, immediately before trust can be persisted.
 */
export async function discoverSshHostKeyCandidates(
  target: SshHostTrustTarget,
  dependencies: ObserveSshHostKeyDependencies = {},
): Promise<SshHostKeyCandidateResult> {
  if (!validTarget(target)) return { ok: false, reason: "invalid_request" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS + 250);
  try {
    const run = dependencies.run ?? runStructuredSshProcess;
    const result = await run({
      executable: SYSTEM_OPENSSH_PATHS.sshKeyscan,
      argv: ["-T", "5", "-p", String(target.port), target.host],
      env: SCAN_ENVIRONMENT,
      timeoutMs: SCAN_TIMEOUT_MS,
      maxStdoutBytes: SCAN_MAX_OUTPUT_BYTES,
      maxStderrBytes: SCAN_MAX_OUTPUT_BYTES,
      signal: controller.signal,
    });
    const failed = terminationReason(result);
    if (failed !== null) return { ok: false, reason: failed };
    return parseCandidateOutput(result.stdout);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Preparation-only discovery of one deterministic preferred key. It returns
 * no key bytes or scanner labels; dispatch scans the exact approved pin again.
 */
export async function discoverPreferredSshHostKey(
  target: SshHostTrustTarget,
  dependencies: ObserveSshHostKeyDependencies = {},
): Promise<SshPreferredHostKeyResult> {
  if (!validTarget(target)) return { ok: false, reason: "invalid_request" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS + 250);
  try {
    const run = dependencies.run ?? runStructuredSshProcess;
    const result = await run({
      executable: SYSTEM_OPENSSH_PATHS.sshKeyscan,
      argv: ["-T", "5", "-p", String(target.port), target.host],
      env: SCAN_ENVIRONMENT,
      timeoutMs: SCAN_TIMEOUT_MS,
      maxStdoutBytes: SCAN_MAX_OUTPUT_BYTES,
      maxStderrBytes: SCAN_MAX_OUTPUT_BYTES,
      signal: controller.signal,
    });
    const failed = terminationReason(result);
    if (failed !== null) return { ok: false, reason: failed };
    return parsePreferredCandidateOutput(result.stdout);
  } finally {
    clearTimeout(timeout);
  }
}
