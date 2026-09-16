import {
  classifyOpenCodeAcpReadiness,
  parseOpenCodeAcpVersionOutput,
  type OpenCodeAcpHostReadinessEvidence,
} from "@nautilo/acp-host";
import type {
  RelayAcpHostPort,
  RelayAcpHostTransport,
  RelayAcpReadinessCommand,
  RelayAcpSession,
} from "@nautilo/relay";
import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { createHermesAcpLaunchEnvironment } from "./acp-readiness-host";

export const OPENCODE_ACP_VERSION_ARGS = Object.freeze(["--version"] as const);
const MAX_PATH_ENTRIES = 32;
const MAX_PATH_ENTRY_BYTES = 4 * 1024;
const MAX_PATH_BYTES = MAX_PATH_ENTRIES * (MAX_PATH_ENTRY_BYTES + 1);

export type OpenCodeAcpNativeProbeResult =
  | Readonly<{ state: "output"; stdout: Uint8Array }>
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "unavailable" }>;

export interface OpenCodeAcpNativeProbe {
  run(input: Readonly<{
    executableBasename: "opencode";
    args: typeof OPENCODE_ACP_VERSION_ARGS;
    timeoutMs: 3_000;
    maxOutputBytes: 4_096;
    shell: false;
  }>): Promise<OpenCodeAcpNativeProbeResult>;
}

/** OpenCode's native installer uses this fixed owner-local location. */
export function createElectronOpenCodeAcpNativeProbe(): OpenCodeAcpNativeProbe {
  return {
    async run(input): Promise<OpenCodeAcpNativeProbeResult> {
      if (input.executableBasename !== "opencode" || input.args !== OPENCODE_ACP_VERSION_ARGS
        || input.timeoutMs !== 3_000 || input.maxOutputBytes !== 4_096 || input.shell !== false) {
        return { state: "unavailable" };
      }
      const resolved = await resolveOpenCodeExecutable();
      if (resolved === null) return { state: "missing" };
      return runVersionProbe(resolved.executable, createHermesAcpLaunchEnvironment(resolved.pathEntries));
    },
  };
}

/** Readiness only: no provider/model/config/account inspection and no ACP launch. */
export class ElectronOpenCodeAcpReadinessHost implements RelayAcpHostPort {
  #session: RelayAcpSession | null = null;
  #transport: RelayAcpHostTransport | null = null;
  #inFlight: Promise<ReturnType<typeof classifyOpenCodeAcpReadiness>["state"]> | null = null;

  constructor(private readonly probe: OpenCodeAcpNativeProbe) {}

  isReady(): boolean { return true; }

  onRegistered(session: RelayAcpSession, transport: RelayAcpHostTransport): void {
    this.#session = session;
    this.#transport = transport;
  }

  onDisconnected(): void {
    this.#session = null;
    this.#transport = null;
    this.#inFlight = null;
  }

  async onReadiness(message: RelayAcpReadinessCommand): Promise<void> {
    const session = this.#session;
    const transport = this.#transport;
    if (!session || !transport || message.registrationId !== "opencode-acp" || !sameSession(session, message.scope)) return;
    const state = await this.#readiness();
    if (this.#session !== session || this.#transport !== transport || !sameSession(session, message.scope)) return;
    transport.send({
      type: "relay:acp-readiness-result",
      requestId: message.requestId,
      scope: message.scope,
      registrationId: "opencode-acp",
      state,
    });
  }

  #readiness(): Promise<ReturnType<typeof classifyOpenCodeAcpReadiness>["state"]> {
    if (this.#inFlight !== null) return this.#inFlight;
    const probe = this.#inspect().finally(() => {
      if (this.#inFlight === probe) this.#inFlight = null;
    });
    this.#inFlight = probe;
    return probe;
  }

  async #inspect(): Promise<ReturnType<typeof classifyOpenCodeAcpReadiness>["state"]> {
    const result = await this.probe.run({
      executableBasename: "opencode",
      args: OPENCODE_ACP_VERSION_ARGS,
      timeoutMs: 3_000,
      maxOutputBytes: 4_096,
      shell: false,
    });
    if (result.state !== "output") return result.state;
    const evidence: OpenCodeAcpHostReadinessEvidence = {
      executableBasename: "opencode",
      versionOutput: result.stdout,
      preflight: "passed",
    };
    return classifyOpenCodeAcpReadiness(evidence).state;
  }
}

export class ElectronAcpReadinessRouter implements RelayAcpHostPort {
  constructor(private readonly hosts: Readonly<Record<"hermes-acp" | "opencode-acp", RelayAcpHostPort>>) {}
  isReady(): boolean { return Object.values(this.hosts).every((host) => host.isReady?.() === true); }
  async onRegistered(session: RelayAcpSession, transport: RelayAcpHostTransport): Promise<void> {
    for (const host of Object.values(this.hosts)) {
      const result = host.onRegistered?.(session, transport);
      if (result && typeof result === "object" && "then" in result) await result;
    }
  }
  async onDisconnected(): Promise<void> {
    await Promise.all(Object.values(this.hosts).map(async (host) => { await host.onDisconnected?.(); }));
  }
  onReadiness(message: RelayAcpReadinessCommand): void | Promise<void> {
    return this.hosts[message.registrationId].onReadiness?.(message);
  }
}

async function resolveOpenCodeExecutable(): Promise<Readonly<{ executable: string; pathEntries: readonly string[] }> | null> {
  const pathEntries = safePathEntries(process.env["PATH"]);
  const candidates = [join(homedir(), ".opencode", "bin", "opencode"), ...pathEntries.map((entry) => join(entry, "opencode"))];
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      const stat = await fs.stat(real);
      if (basename(candidate) !== "opencode" || !stat.isFile()) continue;
      await fs.access(real, fsConstants.X_OK);
      return { executable: real, pathEntries };
    } catch {
      // Missing/non-executable candidates are the single safe absence state.
    }
  }
  return null;
}

/** Launch-time authority re-resolves the executable and exact reviewed version;
 * no readiness cache, configuration, provider, model, or account state enters
 * execution admission. */
export async function resolveReviewedOpenCodeLaunchAdmission(): Promise<Readonly<{
  executable: string;
  pathEntries: readonly string[];
}> | null> {
  const resolved = await resolveOpenCodeExecutable();
  if (!resolved) return null;
  const result = await runVersionProbe(
    resolved.executable,
    createOpenCodeAcpLaunchEnvironment(resolved.pathEntries),
  );
  return result.state === "output" && parseOpenCodeAcpVersionOutput(result.stdout) !== null
    ? resolved
    : null;
}

export function createOpenCodeAcpLaunchEnvironment(
  pathEntries: readonly string[],
): Readonly<Record<string, string>> {
  return createHermesAcpLaunchEnvironment(pathEntries);
}

function runVersionProbe(executable: string, env: Readonly<Record<string, string>>): Promise<OpenCodeAcpNativeProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let forced = false;
    let output = new Uint8Array(0);
    let teardownTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: OpenCodeAcpNativeProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...OPENCODE_ACP_VERSION_ARGS], {
        env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish({ state: "unavailable" });
      return;
    }
    const terminate = () => {
      if (forced || settled) return;
      forced = true;
      signalProbe(child, "SIGTERM");
      killTimer = setTimeout(() => signalProbe(child, "SIGKILL"), 100);
      teardownTimer = setTimeout(() => finish({ state: "unavailable" }), 250);
    };
    const timer = setTimeout(terminate, 3_000);
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(error.code === "ENOENT" ? { state: "missing" } : { state: "unavailable" });
    });
    child.stdout?.on("data", (chunk: Uint8Array) => {
      if (output.byteLength + chunk.byteLength > 4_096) { terminate(); return; }
      const next = new Uint8Array(output.byteLength + chunk.byteLength);
      next.set(output);
      next.set(chunk, output.byteLength);
      output = next;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (teardownTimer !== null) clearTimeout(teardownTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      finish(!forced && code === 0 ? { state: "output", stdout: output } : { state: "unavailable" });
    });
  });
}

function safePathEntries(raw: string | undefined): readonly string[] {
  if (typeof raw !== "string" || raw.includes("\0") || Buffer.byteLength(raw) > MAX_PATH_BYTES) return [];
  return raw.split(delimiter).filter((entry) => isAbsolute(entry) && !entry.includes("\0")
    && Buffer.byteLength(entry) <= MAX_PATH_ENTRY_BYTES).slice(0, MAX_PATH_ENTRIES);
}

function signalProbe(child: ReturnType<typeof spawn>, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try { process.kill(-child.pid, signal); return; } catch { /* fall through */ }
  }
  try { child.kill(signal); } catch { /* unavailable remains fail closed */ }
}

function sameSession(left: RelayAcpSession, right: RelayAcpSession): boolean {
  return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId
    && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef
    && left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}
