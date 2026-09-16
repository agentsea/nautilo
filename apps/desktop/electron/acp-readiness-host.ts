import {
  HERMES_ACP_REVIEWED_VERSION,
  classifyHermesAcpReadiness,
  type HermesAcpHostReadinessEvidence,
} from "@nautilo/acp-host";
import type {
  RelayAcpHostPort,
  RelayAcpHostTransport,
  RelayAcpReadinessCommand,
  RelayAcpSession,
} from "@nautilo/relay";
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";

/** Locked Task 1.4 launch-family probes; never derive these from a request. */
export const HERMES_ACP_VERSION_ARGS = Object.freeze(["acp", "--version"] as const);
export const HERMES_ACP_CHECK_ARGS = Object.freeze(["-p", "nautilo-acp", "acp", "--check"] as const);
const MAX_HOST_PATH_ENTRIES = 32;
const MAX_HOST_PATH_ENTRY_BYTES = 4 * 1024;
const MAX_HOST_PATH_BYTES = MAX_HOST_PATH_ENTRIES * (MAX_HOST_PATH_ENTRY_BYTES + 1);
const MAX_PROBE_ENV_VALUE_BYTES = 4 * 1024;

export type HermesAcpNativeProbeResult =
  | Readonly<{ state: "output"; stdout: Uint8Array }>
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "authentication_required" }>
  | Readonly<{ state: "unavailable" }>;

/**
 * Electron-only authority. Its implementation owns reviewed executable
 * discovery/identity checks; callers can request only the two frozen probes.
 */
export interface HermesAcpNativeProbe {
  run(input: Readonly<{
    executableBasename: "hermes";
    args: readonly string[];
    timeoutMs: 3_000 | 5_000;
    maxOutputBytes: 4_096;
    shell: false;
  }>): Promise<HermesAcpNativeProbeResult>;
}

/**
 * The only built-in desktop resolver. It examines a bounded host PATH inside
 * Electron, accepts one executable named exactly `hermes`, and never receives
 * a path, argv, environment, or credential from the server or renderer.
 */
export function createElectronHermesAcpNativeProbe(): HermesAcpNativeProbe {
  return {
    async run(input): Promise<HermesAcpNativeProbeResult> {
      const admission = await resolveReviewedHermesExecutable();
      if (admission === null) return { state: "missing" };
      return runStaticProbe(admission.executable, input, probeEnvironment(admission.pathEntries));
    },
  };
}

/**
 * Relay-v13 endpoint for exactly one compiled registration. It never starts
 * `hermes acp`: version/check are bounded local readiness probes only.
 */
export class ElectronHermesAcpReadinessHost implements RelayAcpHostPort {
  private session: RelayAcpSession | null = null;
  private transport: RelayAcpHostTransport | null = null;
  private readonly readinessInFlight = new Map<string, Promise<ReturnType<typeof classifyHermesAcpReadiness>["state"]>>();

  constructor(private readonly probe: HermesAcpNativeProbe) {}

  isReady(): boolean { return true; }

  /** Content-free local readiness for owner UI and Ready aggregation. */
  readiness(): Promise<ReturnType<typeof classifyHermesAcpReadiness>["state"]> {
    return this.inspectReadiness();
  }

  onRegistered(session: RelayAcpSession, transport: RelayAcpHostTransport): void {
    this.session = session;
    this.transport = transport;
  }

  onDisconnected(): void {
    this.session = null;
    this.transport = null;
  }

  async onReadiness(message: RelayAcpReadinessCommand): Promise<void> {
    const session = this.session;
    const transport = this.transport;
    if (!session || !sameSession(session, message.scope) || message.registrationId !== "hermes-acp") return;
    const state = await this.readinessFor(session);
    // A disconnect/re-register while a local probe runs must never receive a
    // stale answer. The later exact retry starts a fresh session-scoped probe.
    if (this.session !== session || this.transport !== transport || !sameSession(session, message.scope)) return;
    transport?.send({
      type: "relay:acp-readiness-result",
      requestId: message.requestId,
      scope: message.scope,
      registrationId: "hermes-acp",
      state,
    });
  }

  private readinessFor(session: RelayAcpSession): Promise<ReturnType<typeof classifyHermesAcpReadiness>["state"]> {
    const key = readinessKey(session);
    const existing = this.readinessInFlight.get(key);
    if (existing) return existing;
    const probe = this.inspectReadiness().finally(() => this.readinessInFlight.delete(key));
    this.readinessInFlight.set(key, probe);
    return probe;
  }

  private async inspectReadiness(): Promise<ReturnType<typeof classifyHermesAcpReadiness>["state"]> {
    const version = await this.probe.run({
      executableBasename: "hermes",
      args: HERMES_ACP_VERSION_ARGS,
      timeoutMs: 3_000,
      maxOutputBytes: 4_096,
      shell: false,
    });
    const evidence = await this.evidenceFrom(version);
    return classifyHermesAcpReadiness(evidence).state;
  }

  private async evidenceFrom(version: HermesAcpNativeProbeResult): Promise<HermesAcpHostReadinessEvidence> {
    if (version.state === "missing") return { executableBasename: "hermes", versionOutput: null, preflight: "missing" };
    if (version.state !== "output") return { executableBasename: "hermes", versionOutput: null, preflight: "unavailable" };
    if (!isReviewedVersion(version.stdout)) return { executableBasename: "hermes", versionOutput: version.stdout, preflight: "unavailable" };
    const check = await this.probe.run({
      executableBasename: "hermes",
      args: HERMES_ACP_CHECK_ARGS,
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      shell: false,
    });
    return {
      executableBasename: "hermes",
      versionOutput: version.stdout,
      preflight: check.state === "authentication_required"
        ? "authentication_required"
        : check.state === "output" ? "passed" : check.state,
    };
  }
}

function isReviewedVersion(output: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
    return text === HERMES_ACP_REVIEWED_VERSION || text === `${HERMES_ACP_REVIEWED_VERSION}\n`;
  } catch {
    return false;
  }
}
function sameSession(left: RelayAcpSession, right: RelayAcpSession): boolean {
  return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId
    && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef
    && left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}
function readinessKey(session: RelayAcpSession): string {
  return [session.relayId, session.relaySessionId, session.desktopSessionId, session.pairingGenerationRef, session.selectedProtocolVersion, session.capabilityRevision].join("\u0000");
}

async function resolveReviewedHermesExecutable(): Promise<Readonly<{
  executable: string;
  pathEntries: readonly string[];
}> | null> {
  // Reading this value is local discovery only. It is never retained or sent
  // anywhere, and caller-supplied PATH/configuration is deliberately absent.
  const entries = safePathEntries(process.env["PATH"]);
  for (const entry of entries) {
    if (!isAbsolute(entry) || entry.length === 0) continue;
    const candidate = join(entry, "hermes");
    try {
      const real = await fs.realpath(candidate);
      const stat = await fs.stat(real);
      if (basename(candidate) !== "hermes" || !stat.isFile()) continue;
      await fs.access(real, fsConstants.X_OK);
      return { executable: real, pathEntries: entries };
    } catch {
      // A missing/non-executable candidate is indistinguishable from absence.
    }
  }
  return null;
}

/**
 * Exact launch-time admission. Discovery, version and check all operate on
 * one canonical executable; callers must not reuse a prior readiness result.
 */
export async function resolveReviewedHermesLaunchAdmission(): Promise<Readonly<{
  executable: string;
  pathEntries: readonly string[];
}> | null> {
  const resolved = await resolveReviewedHermesExecutable();
  if (!resolved) return null;
  const environment = createHermesAcpLaunchEnvironment(resolved.pathEntries);
  const version = await runStaticProbe(resolved.executable, {
    executableBasename: "hermes", args: HERMES_ACP_VERSION_ARGS, timeoutMs: 3_000, maxOutputBytes: 4_096, shell: false,
  }, environment);
  if (version.state !== "output" || !isReviewedVersion(version.stdout)) return null;
  const check = await runStaticProbe(resolved.executable, {
    executableBasename: "hermes", args: HERMES_ACP_CHECK_ARGS, timeoutMs: 5_000, maxOutputBytes: 4_096, shell: false,
  }, environment);
  return check.state === "output" ? resolved : null;
}

async function runStaticProbe(
  executable: string,
  input: Readonly<{
    executableBasename: "hermes";
    args: readonly string[];
    timeoutMs: 3_000 | 5_000;
    maxOutputBytes: 4_096;
    shell: false;
  }>,
  env: Readonly<Record<string, string>>,
): Promise<HermesAcpNativeProbeResult> {
  if (input.executableBasename !== "hermes" || input.shell !== false
    || (input.args !== HERMES_ACP_VERSION_ARGS && input.args !== HERMES_ACP_CHECK_ARGS)) {
    return { state: "unavailable" };
  }
  return new Promise((resolve) => {
    let settled = false;
    let forcedFailure = false;
    let teardownTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let output = new Uint8Array(0);
    const finish = (result: HermesAcpNativeProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(executable, [...input.args], {
        env,
        shell: false,
        windowsHide: true,
        // Own a Unix process group so the timeout/overflow teardown can
        // terminate the probe's direct descendants as one bounded unit.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish({ state: "unavailable" });
      return;
    }
    const finishAfterTeardown = () => {
      if (forcedFailure || settled) return;
      forcedFailure = true;
      terminateProbe(child, "SIGTERM");
      killTimer = setTimeout(() => terminateProbe(child, "SIGKILL"), 100);
      // A direct child normally closes immediately. A grace timer bounds the
      // pathological case while preserving deterministic readiness retries.
      teardownTimer = setTimeout(() => finish({ state: "unavailable" }), 250);
    };
    const timer = setTimeout(finishAfterTeardown, input.timeoutMs);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(error.code === "ENOENT" ? { state: "missing" } : { state: "unavailable" });
    });
    child.stdout.on("data", (chunk: Uint8Array) => {
      if (output.byteLength + chunk.byteLength > input.maxOutputBytes) {
        finishAfterTeardown();
        return;
      }
      const next = new Uint8Array(output.byteLength + chunk.byteLength);
      next.set(output);
      next.set(chunk, output.byteLength);
      output = next;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (teardownTimer !== null) clearTimeout(teardownTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (forcedFailure) {
        finish({ state: "unavailable" });
      } else if (code === 0) {
        finish({ state: "output", stdout: output });
      } else {
        // `hermes acp --check` documents dependency readiness, not an
        // authentication-status contract. Never infer auth from raw output.
        finish({ state: "unavailable" });
      }
    });
  });
}

function safePathEntries(raw: string | undefined): readonly string[] {
  if (
    typeof raw !== "string" || raw.includes("\0") ||
    Buffer.byteLength(raw, "utf8") > MAX_HOST_PATH_BYTES
  ) return [];
  const entries: string[] = [];
  for (const entry of raw.split(delimiter)) {
    if (entries.length === MAX_HOST_PATH_ENTRIES) break;
    if (!isAbsolute(entry) || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > MAX_HOST_PATH_ENTRY_BYTES) continue;
    entries.push(entry);
  }
  return entries;
}

export function createHermesAcpLaunchEnvironment(pathEntries: readonly string[]): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  const pathValue = pathEntries.join(delimiter);
  if (pathValue.length > 0) env["PATH"] = pathValue;
  const fallbacks = { HOME: homedir(), TMPDIR: tmpdir(), LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } as const;
  for (const key of ["HOME", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = process.env[key] ?? fallbacks[key];
    if (isSafeProbeEnvironmentValue(value)) env[key] = value;
  }
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "ComSpec"] as const) {
      const value = process.env[key];
      if (isSafeProbeEnvironmentValue(value)) env[key] = value;
    }
  }
  return Object.freeze(env);
}

function probeEnvironment(pathEntries: readonly string[]): Readonly<Record<string, string>> {
  return createHermesAcpLaunchEnvironment(pathEntries);
}

function isSafeProbeEnvironmentValue(value: string | undefined): value is string {
  return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_PROBE_ENV_VALUE_BYTES;
}

function terminateProbe(child: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
  }
  try { child.kill(signal); } catch { /* a failed teardown is still unavailable */ }
}
