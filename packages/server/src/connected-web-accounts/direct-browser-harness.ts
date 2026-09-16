import { agentBrowserCdpArgv } from "@nautilo/relay";
import { stripInvisibleUnicode } from "@nautilo/security";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DirectBrowserControlCommandResult,
  DirectBrowserControlHarness,
} from "./direct-browser-control";

const AGENT_BROWSER_VERSION = "0.35.2";
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDOUT_BYTES = 96 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 24 * 1024;
const SERVER_VENDOR_ROOT = fileURLToPath(new URL("../../vendor/agent-browser", import.meta.url));

type AgentBrowserPlatformKey = "darwin-arm64" | "darwin-x64" | "linux-arm64" | "linux-x64";

interface AgentBrowserArtifact {
  readonly sha256: string;
  readonly sizeMin: number;
}

interface AgentBrowserManifest {
  readonly "agent-browser": {
    readonly version: string;
    readonly binaryName: string;
    readonly artifacts: Partial<Record<AgentBrowserPlatformKey, AgentBrowserArtifact>>;
  };
}

export class DirectBrowserHarnessError extends Error {
  constructor(readonly code: "unavailable" | "timeout" | "failed") {
    super("direct browser harness unavailable");
    this.name = "DirectBrowserHarnessError";
  }
}

export interface DirectBrowserHarnessProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface DirectBrowserHarnessDependencies {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly vendorRoot?: string;
  readonly manifest?: unknown;
  readonly readManifest?: (path: string) => Promise<unknown>;
  readonly binaryExists?: (path: string) => Promise<boolean>;
  readonly spawn?: (input: {
    readonly command: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
  }) => DirectBrowserHarnessProcess;
  /** Per-command transport deadline, not a Connected Website operation deadline. */
  readonly commandTimeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

interface BoundedStream {
  readonly text: string;
  readonly truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function platformKey(platform: NodeJS.Platform, arch: string): AgentBrowserPlatformKey | null {
  if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
  if (platform === "darwin" && arch === "x64") return "darwin-x64";
  if (platform === "linux" && arch === "arm64") return "linux-arm64";
  if (platform === "linux" && arch === "x64") return "linux-x64";
  return null;
}

function parseManifest(value: unknown): AgentBrowserManifest | null {
  if (!isRecord(value) || !isRecord(value["agent-browser"])) return null;
  const entry = value["agent-browser"];
  if (entry["version"] !== AGENT_BROWSER_VERSION || entry["binaryName"] !== "agent-browser" || !isRecord(entry["artifacts"])) return null;
  const artifacts: Partial<Record<AgentBrowserPlatformKey, AgentBrowserArtifact>> = {};
  for (const key of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const) {
    const artifact = entry["artifacts"][key];
    if (!isRecord(artifact) || typeof artifact["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(artifact["sha256"])
      || typeof artifact["sizeMin"] !== "number" || !Number.isSafeInteger(artifact["sizeMin"]) || artifact["sizeMin"] < 10_000_000) {
      return null;
    }
    artifacts[key] = { sha256: artifact["sha256"], sizeMin: artifact["sizeMin"] };
  }
  return {
    "agent-browser": {
      version: AGENT_BROWSER_VERSION,
      binaryName: "agent-browser",
      artifacts,
    },
  };
}

function validLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * `browser_wait` legitimately permits up to 30 seconds in the semantic relay
 * contract. Preserve that requested wait and add the harness's independent
 * connection/daemon transport allowance; do not let a CLI wall clock preempt
 * a valid browser wait before it can report its result.
 */
export function directBrowserTransportDeadlineMs(argv: readonly string[], transportAllowanceMs: number): number {
  const commandIndex = argv.indexOf("--session") + 2;
  const command = argv[commandIndex];
  const rawMilliseconds = command === "wait" ? argv[commandIndex + 1] : undefined;
  const requestedWaitMs = typeof rawMilliseconds === "string" && /^\d+$/u.test(rawMilliseconds)
    ? Number(rawMilliseconds)
    : 0;
  // The mapper accepts 0 through 30,000. Treat malformed/untrusted argv as no
  // extension instead of allowing it to turn one command into an arbitrary
  // long-lived process.
  const boundedWaitMs = Number.isSafeInteger(requestedWaitMs) && requestedWaitMs >= 0 && requestedWaitMs <= 30_000
    ? requestedWaitMs
    : 0;
  return transportAllowanceMs + boundedWaitMs;
}

async function defaultManifestReader(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function defaultBinaryExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve only the server-vendored, checksum-pinned v0.35.2 artifact. The
 * vendor build performs the hash verification; runtime rechecks the manifest,
 * architecture key, and executable bit before it ever starts the binary.
 */
export async function resolveServerVendoredAgentBrowserBinary(
  dependencies: Pick<DirectBrowserHarnessDependencies, "platform" | "arch" | "vendorRoot" | "manifest" | "readManifest" | "binaryExists"> = {},
): Promise<string> {
  const key = platformKey(dependencies.platform ?? process.platform, dependencies.arch ?? process.arch);
  if (key === null) throw new DirectBrowserHarnessError("unavailable");
  const vendorRoot = dependencies.vendorRoot ?? SERVER_VENDOR_ROOT;
  const manifestValue = dependencies.manifest
    ?? await (dependencies.readManifest ?? defaultManifestReader)(join(vendorRoot, "manifest.json"));
  const manifest = parseManifest(manifestValue);
  const artifact = manifest?.["agent-browser"].artifacts[key];
  if (!artifact) throw new DirectBrowserHarnessError("unavailable");
  const binary = join(vendorRoot, key, manifest["agent-browser"].binaryName);
  if (!await (dependencies.binaryExists ?? defaultBinaryExists)(binary)) {
    throw new DirectBrowserHarnessError("unavailable");
  }
  return binary;
}

function validPrivateDirectory(value: string): boolean {
  return isAbsolute(value) && !value.includes("\0");
}

function sessionFromArgv(argv: readonly string[]): string | null {
  const index = argv.indexOf("--session");
  const session = index >= 0 ? argv[index + 1] : undefined;
  return typeof session === "string" && /^[a-z0-9](?:[a-z0-9_-]{0,119})$/iu.test(session)
    ? session
    : null;
}

/** agent-browser itself applies this Unix-domain socket bound before launch. */
function validSocketPathBudget(platform: NodeJS.Platform, socketDirectory: string, session: string): boolean {
  if (platform === "win32") return true;
  return Buffer.byteLength(join(socketDirectory, `${session}.sock`), "utf8") <= 103;
}

function validCdpCapability(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0;
  } catch {
    return false;
  }
}

function childEnvironment(input: {
  readonly cdpUrl?: string;
  readonly socketDirectory: string;
  readonly homeDirectory: string;
  readonly contentBoundaries?: boolean;
  readonly pinTab?: boolean;
}): Readonly<Record<string, string>> {
  return {
    HOME: input.homeDirectory,
    AGENT_BROWSER_SOCKET_DIR: input.socketDirectory,
    ...(input.cdpUrl === undefined ? {} : { AGENT_BROWSER_CDP: input.cdpUrl }),
    ...(input.contentBoundaries === true ? { AGENT_BROWSER_CONTENT_BOUNDARIES: "1" } : {}),
    ...(input.pinTab === true ? { AGENT_BROWSER_PIN_TAB: "1" } : {}),
  };
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedStream> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (retained < maxBytes) {
        const remaining = maxBytes - retained;
        const part = value.byteLength <= remaining ? value : value.subarray(0, remaining);
        chunks.push(part);
        retained += part.byteLength;
        if (value.byteLength > remaining) truncated = true;
      } else {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function sanitizeSuccessfulOutput(output: string, cdpUrl: string): string {
  const redacted = output
    .replaceAll(cdpUrl, "[redacted]")
    .replace(/wss:\/\/[^\s"'<>]+/gu, "[redacted]");
  const visible = stripInvisibleUnicode(redacted).text;
  return [...visible]
    .filter((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point === 9 || point === 10 || point === 13 || (point >= 32 && point !== 127);
    })
    .join("")
    .trim();
}

function defaultSpawn(input: {
  readonly command: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}): DirectBrowserHarnessProcess {
  const child = Bun.spawn([...input.command], {
    env: { ...input.environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: () => { child.kill(); },
  };
}

/**
 * A production-facing, dependency-injected adapter for one agent-browser CLI
 * command attached to a Browser Use browser. It is intentionally only a
 * harness: direct-operation authority, origin checks, and model routing stay
 * in their dedicated D568 layers.
 */
export function createServerDirectBrowserHarness(
  dependencies: DirectBrowserHarnessDependencies = {},
): DirectBrowserControlHarness {
  let binary: Promise<string> | null = null;
  const commandTimeoutMs = validLimit(dependencies.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  const maxStdoutBytes = validLimit(dependencies.maxStdoutBytes, DEFAULT_MAX_STDOUT_BYTES);
  const maxStderrBytes = validLimit(dependencies.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES);
  const resolveBinary = (): Promise<string> => {
    binary ??= resolveServerVendoredAgentBrowserBinary(dependencies);
    return binary;
  };

  const run = async (input: {
    readonly argv: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }): Promise<BoundedStream> => {
    const executable = await resolveBinary().catch(() => { throw new DirectBrowserHarnessError("unavailable"); });
    let child: DirectBrowserHarnessProcess;
    try {
      child = (dependencies.spawn ?? defaultSpawn)({
        command: [executable, ...input.argv],
        environment: input.environment,
      });
    } catch {
      throw new DirectBrowserHarnessError("unavailable");
    }
    let timedOut = false;
    let resolveTimeout: ((value: { readonly kind: "timed_out" }) => void) | null = null;
    const timed = new Promise<{ readonly kind: "timed_out" }>((resolve) => { resolveTimeout = resolve; });
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* process is already gone */ }
      resolveTimeout?.({ kind: "timed_out" });
    }, input.timeoutMs);
    try {
      const completion = Promise.all([
        readBounded(child.stdout, maxStdoutBytes),
        readBounded(child.stderr, maxStderrBytes),
        child.exited,
      ]).then(([stdout, stderr, exitCode]) => ({ kind: "completed" as const, stdout, stderr, exitCode }));
      const result = await Promise.race([completion, timed]);
      if (result.kind === "timed_out" || timedOut) {
        void completion.catch(() => undefined);
        throw new DirectBrowserHarnessError("timeout");
      }
      const { stdout, stderr, exitCode } = result;
      if (exitCode !== 0) {
        void stderr;
        throw new DirectBrowserHarnessError("failed");
      }
      return stdout;
    } catch (error) {
      if (error instanceof DirectBrowserHarnessError) throw error;
      throw new DirectBrowserHarnessError(timedOut ? "timeout" : "failed");
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    buildArgv: ({ toolName, args, session }) => agentBrowserCdpArgv(toolName, args as Record<string, unknown>, session),
    async invoke(input): Promise<DirectBrowserControlCommandResult> {
      const session = sessionFromArgv(input.argv);
      const platform = dependencies.platform ?? process.platform;
      if (!validCdpCapability(input.environment.AGENT_BROWSER_CDP)
        || !validPrivateDirectory(input.socketDirectory)
        || !validPrivateDirectory(input.homeDirectory)
        || session === null
        || !validSocketPathBudget(platform, input.socketDirectory, session)
        || input.argv.some((token) => token === "--cdp" || token === "--provider" || token === "--config")) {
        throw new DirectBrowserHarnessError("unavailable");
      }
      const effectiveCommandTimeoutMs = directBrowserTransportDeadlineMs(input.argv, commandTimeoutMs);
      const stdout = await run({
        argv: input.argv,
        environment: childEnvironment({
          cdpUrl: input.environment.AGENT_BROWSER_CDP,
          socketDirectory: input.socketDirectory,
          homeDirectory: input.homeDirectory,
          contentBoundaries: true,
          pinTab: true,
        }),
        timeoutMs: effectiveCommandTimeoutMs,
      });
      return { text: sanitizeSuccessfulOutput(stdout.text, input.environment.AGENT_BROWSER_CDP), truncated: stdout.truncated };
    },
    async bindPinnedTarget(input): Promise<void> {
      if (!validCdpCapability(input.environment.AGENT_BROWSER_CDP)
        || !validPrivateDirectory(input.socketDirectory)
        || !validPrivateDirectory(input.homeDirectory)
        || !/^[A-Za-z0-9_-]{1,128}$/u.test(input.targetId)
        || !/^[a-z0-9](?:[a-z0-9_-]{0,119})$/iu.test(input.session)
        || !validSocketPathBudget(dependencies.platform ?? process.platform, input.socketDirectory, input.session)) {
        throw new DirectBrowserHarnessError("unavailable");
      }
      await run({
        argv: ["--session", input.session, "--pin-tab", "tab", input.targetId],
        environment: childEnvironment({
          cdpUrl: input.environment.AGENT_BROWSER_CDP,
          socketDirectory: input.socketDirectory,
          homeDirectory: input.homeDirectory,
          pinTab: true,
        }),
        timeoutMs: commandTimeoutMs,
      });
    },
    async readPinnedUrl(input): Promise<string> {
      if (!validCdpCapability(input.environment.AGENT_BROWSER_CDP)
        || !validPrivateDirectory(input.socketDirectory)
        || !validPrivateDirectory(input.homeDirectory)
        || !/^[a-z0-9](?:[a-z0-9_-]{0,119})$/iu.test(input.session)
        || !validSocketPathBudget(dependencies.platform ?? process.platform, input.socketDirectory, input.session)) {
        throw new DirectBrowserHarnessError("unavailable");
      }
      const stdout = await run({
        argv: ["--session", input.session, "get", "url"],
        environment: childEnvironment({
          cdpUrl: input.environment.AGENT_BROWSER_CDP,
          socketDirectory: input.socketDirectory,
          homeDirectory: input.homeDirectory,
          pinTab: true,
        }),
        timeoutMs: commandTimeoutMs,
      });
      const url = stdout.text.trim();
      if (url.length === 0 || url.includes("\n") || url.includes("\r")) {
        throw new DirectBrowserHarnessError("failed");
      }
      return url;
    },
    async closePrivateDaemons(input): Promise<void> {
      if (!validPrivateDirectory(input.socketDirectory) || !validPrivateDirectory(input.homeDirectory)) {
        throw new DirectBrowserHarnessError("unavailable");
      }
      await run({
        // `close --all` inventories only AGENT_BROWSER_SOCKET_DIR and, unlike
        // a named ordinary command, never auto-starts a missing daemon. It
        // also force-cleans an unreachable daemon using its private pid file.
        argv: ["close", "--all"],
        environment: childEnvironment({
          socketDirectory: input.socketDirectory,
          homeDirectory: input.homeDirectory,
        }),
        timeoutMs: commandTimeoutMs,
      });
    },
  };
}
