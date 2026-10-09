import {
  createRelayClient,
  createWorkspaceGuard,
  createOpenHueHandler,
  handleFsDispatch,
  LOCAL_FILE_EXECUTION_UNSUPPORTED,
  RelayAuthenticationRequiredError,
  type OpenHueExecutor,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type WorkspaceGuard,
} from "@nautilo/relay";
import { createRelayMcpHost } from "@nautilo/mcp-client";
import { applyInstanceArgFromArgv, stripInstancePairFromArgv } from "@nautilo/config";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { log, warn, error } from "@nautilo/logger";
import * as path from "node:path";
import {
  resolveRelayDataDir,
  resolveRelayServerUrl,
  resolveRelayUserHome,
} from "./bootstrap";
import {
  createKeyringRelayCredentialStore,
  RelayCredentialStorageError,
  RelayPairingRequiredError,
} from "./credential-store";
import {
  assertSafeRelayHttpEndpoint,
  pairStandaloneRelay,
  RelayPairingError,
} from "./pairing";

// Headless relay defaults to $PWD when unset. Unlike the Electron
// relay we don't fall back to ~/.nautilo/home/workspace/ — invoking
// `nautilo-relay` from a terminal strongly implies "act on THIS dir".
const WORKSPACE = process.env["NAUTILO_WORKSPACE"] ?? process.cwd();

// D060 Sprint 1 G5.4.c — per-relay paths for the envelope the server
// Policy Resolver builds. Reporting these at registration lets the
// server construct a sandbox profile tailored to THIS relay's
// filesystem layout. The server never invents relay paths; we own
// this side of the contract.
//
// `NAUTILO_TOOLS_BIN` is a filesystem-layout hint, NOT a policy-
// affecting env var (G5.6 taxonomy): it tells the sandbox where to
// bind its read-only tools-bin mount. The sandbox still enforces
// read-only + workspace containment regardless of this path.

function resolveToolsBin(): string {
  const override = process.env["NAUTILO_TOOLS_BIN"];
  if (override !== undefined && override.length > 0) return override;
  // Bun-launched headless relay: process.execPath is the bun binary;
  // its dirname is the standard bin dir (e.g. /usr/local/bin,
  // /opt/homebrew/bin, ~/.bun/bin). That\u0027s the right shape — unlike
  // the Electron relay which needs a different heuristic.
  return path.dirname(process.execPath);
}

const TOOLS_BIN = resolveToolsBin();

export type RelayEntrypointCommand = "pair" | null;

/** Supports both `bun src/index.ts pair` and a Bun-compiled `nautilo-relay pair`. */
export function resolveRelayEntrypointCommand(argv: string[]): RelayEntrypointCommand {
  const stripped = stripInstancePairFromArgv(argv);
  let args = stripped.slice(1);
  if (args[0] !== undefined && /\.[cm]?[jt]s$/.test(args[0])) args = args.slice(1);
  if (args.length === 0) return null;
  if (args.length === 1 && args[0] === "pair") return "pair";
  throw new Error("Usage: nautilo-relay [--instance <id>] [pair]");
}

/**
 * Resolves the OpenHue executable without exposing a shell or accepting
 * caller-provided command text. An explicit binary override wins; otherwise
 * use the relay tools bin, then let the user's PATH resolve `openhue`.
 */
export function resolveOpenHueBinary(
  env: NodeJS.ProcessEnv = process.env,
  toolsBin = TOOLS_BIN,
  isExecutable: (candidate: string) => boolean = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string {
  const override = env["NAUTILO_OPENHUE_BIN"]?.trim();
  if (override) return override;

  const configuredToolsBin = env["NAUTILO_TOOLS_BIN"]?.trim();
  const candidateBins = [configuredToolsBin, toolsBin].filter(
    (bin): bin is string => Boolean(bin),
  );
  for (const bin of new Set(candidateBins)) {
    const candidate = path.join(bin, "openhue");
    if (isExecutable(candidate)) return candidate;
  }

  return "openhue";
}

/**
 * Executes a fixed OpenHue argv vector directly. `createOpenHueHandler`
 * supplies that vector from its typed action schema, so this executor never
 * receives user-supplied shell syntax or arbitrary argv.
 */
export const openHueExecutor: OpenHueExecutor = {
  async execute(binary, argv, options) {
    const child = Bun.spawn([binary, ...argv], {
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), options.timeoutMs);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return {
        stdout,
        stderr,
        exitCode: typeof exitCode === "number" ? exitCode : 1,
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};

export async function probeOpenHue(
  executor: OpenHueExecutor,
  binary: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const result = await executor.execute(binary, ["version"], {
      env,
      timeoutMs: 5_000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export type HeadlessTerminationRequest =
  | { readonly kind: "signal"; readonly signal: "SIGINT" | "SIGTERM" }
  | { readonly kind: "connect_failure"; readonly error: unknown }
  | { readonly kind: "authentication_required" };

export interface HeadlessTerminationPorts {
  readonly mcpHost: { readonly stop: () => Promise<void> };
  readonly client: { readonly disconnect: () => Promise<void> };
  readonly log: (message: string) => void;
  readonly reportError: (...args: unknown[]) => void;
  readonly exit: (code: number) => void;
}

/**
 * Entry-point-local, first-request-wins process termination. RelayClient keeps
 * sole ownership of transport lifecycle; this closure only orders teardown of
 * the two exact handles already composed by the headless entrypoint.
 */
export function createHeadlessTerminationCoordinator(
  ports: HeadlessTerminationPorts,
): (request: HeadlessTerminationRequest) => Promise<void> {
  let termination: Promise<void> | null = null;

  return (request) => {
    if (termination !== null) return termination;

    if (request.kind === "signal") {
      ports.log(`[relay] ${request.signal} received, disconnecting...`);
    } else if (request.kind === "authentication_required") {
      ports.reportError(
        "[relay] Pairing is missing, invalid, or revoked. Run `nautilo-relay pair` to continue.",
      );
    } else {
      ports.reportError("[relay] Failed to connect:", request.error);
    }

    termination = Promise.resolve().then(async () => {
      let firstTeardownError: unknown;
      let teardownFailed = false;
      try {
        await ports.mcpHost.stop();
      } catch (teardownError) {
        teardownFailed = true;
        firstTeardownError = teardownError;
      }
      try {
        await ports.client.disconnect();
      } catch (teardownError) {
        if (!teardownFailed) firstTeardownError = teardownError;
        teardownFailed = true;
      }

      if (teardownFailed) {
        ports.reportError("[relay] Failed to shut down:", firstTeardownError);
      }
      ports.exit(
        request.kind === "signal" && !teardownFailed ? 0 : 1,
      );
    });
    return termination;
  };
}

/** Headless relays intentionally expose no generic local execution surface. */
export interface DispatchHandlerOptions {
  /** Injected for focused dispatch tests. */
  readonly hueHandler?: (
    args: Record<string, unknown>,
  ) => Promise<RelayDispatchResult>;
}

export function makeDispatchHandler(
  baseGuard: WorkspaceGuard,
  options: DispatchHandlerOptions = {},
) {
  const hueHandler =
    options.hueHandler ??
    createOpenHueHandler({
      executor: openHueExecutor,
      binaryPath: resolveOpenHueBinary(),
    });

  return async function handleDispatch(
    req: RelayDispatchRequest,
    _signal?: AbortSignal,
  ): Promise<RelayDispatchResult> {
    // The headless relay has no Electron local desktop-filesystem-grant store,
    // so it can never validate a desktop-local grant or widen authority from
    // request-provided roots.
    if (req.desktopFilesystemGrantRequest !== undefined) {
      return {
        status: "error",
        errorCode: "DESKTOP_LOCAL_GRANT_REQUIRED",
        error:
          "Desktop Filesystem Grant requests require the Nautilo desktop app's local " +
          "grant store. The headless relay cannot validate Desktop Filesystem Grants " +
          "and will not widen filesystem authority from the server envelope.",
      };
    }

    const requestRoots = req.allowedRoots ?? [];
    const guard =
      requestRoots.length === 0
        ? baseGuard
        : createWorkspaceGuard({
            allowedRoots: [...baseGuard.roots, ...requestRoots],
          });

    if (req.executionClass === "fs") {
      return await handleFsDispatch(req, guard);
    }

    if (req.executionClass === "local-file") {
      return {
        status: "error",
        error:
          "Local file execution is not supported by the headless relay. " +
          "Connect the Nautilo desktop app for current/absolute file operations.",
        errorCode: LOCAL_FILE_EXECUTION_UNSUPPORTED,
      };
    }

    if (
      req.toolName === "extract_audio_from_video" ||
      req.toolName === "media_extract_start" ||
      req.toolName === "media_extract_chunk" ||
      req.toolName === "media_extract_finish" ||
      req.toolName === "media_extract_output_chunk"
    ) {
      return {
        status: "error",
        error:
          "Audio extraction is not supported by the headless relay. " +
          "Connect the Nautilo desktop app to run the fixed local media operation.",
        errorCode: LOCAL_FILE_EXECUTION_UNSUPPORTED,
      };
    }

    if (req.toolName === "hue_lights") {
      return await hueHandler(req.args);
    }

    if (req.toolName === "run_shell" || req.toolName === "terminal") {
      return {
        status: "error",
        errorCode: "LOCAL_EXECUTION_DESKTOP_UPGRADE_REQUIRED",
        error:
          "This legacy local execution interface has been retired. " +
          "Connect an up-to-date Nautilo Desktop and use exec_command and write_stdin. " +
          "No command or terminal action was run.",
      };
    }

    return { status: "error", error: `Unknown tool: ${req.toolName}` };
  };
}

async function main() {
  try {
    applyInstanceArgFromArgv(process.argv, process.env);
  } catch (e) {
    error("[relay]", e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  let command: RelayEntrypointCommand;
  try {
    command = resolveRelayEntrypointCommand(process.argv);
  } catch (commandError) {
    error("[relay]", commandError instanceof Error ? commandError.message : "Invalid command");
    process.exit(2);
  }

  const serverUrl = resolveRelayServerUrl();
  const dataDir = resolveRelayDataDir();
  try {
    assertSafeRelayHttpEndpoint(serverUrl);
  } catch (pairingError) {
    error("[relay]", pairingError instanceof Error ? pairingError.message : "Unsafe server endpoint");
    process.exit(2);
  }

  let credentialStore: Awaited<ReturnType<typeof createKeyringRelayCredentialStore>>;
  try {
    credentialStore = await createKeyringRelayCredentialStore({ serverUrl, dataDir });
  } catch {
    error("[relay] The operating-system credential store is unavailable.");
    process.exit(2);
  }

  if (command === "pair") {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const credential = await pairStandaloneRelay({
        store: credentialStore,
        signal: abortController.signal,
      });
      log(`[relay] Paired for ${credential.serverUrl}. The credential is stored in the operating-system keychain.`);
      return;
    } catch (pairingError) {
      const publicMessage = pairingError instanceof RelayPairingError ||
        pairingError instanceof RelayCredentialStorageError
        ? pairingError.message
        : "Relay pairing failed";
      error(`[relay] ${publicMessage}`);
      process.exit(2);
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }

  let credential;
  try {
    credential = await credentialStore.load();
  } catch (credentialError) {
    error(
      "[relay]",
      credentialError instanceof RelayCredentialStorageError
        ? credentialError.message
        : "Relay credential storage is unavailable",
    );
    process.exit(2);
  }
  if (credential === null) {
    const pairingRequired = new RelayPairingRequiredError();
    error(`[relay] ${pairingRequired.message}. Run \`nautilo-relay pair\` first.`);
    process.exit(2);
  }

  const guard = createWorkspaceGuard({ workspaceRoot: WORKSPACE });
  const userHome = resolveRelayUserHome(dataDir);
  const userId = credential.userId;

  log(`[relay] Starting headless relay`);
  log(`[relay] Server: ${serverUrl}`);
  log(`[relay] User: ${userId}`);
  log(`[relay] Workspace: ${guard.roots[0] ?? "<none>"}`);
  log(`[relay] userHome: ${userHome}`);
  log(`[relay] dataDir: ${dataDir}`);
  log(`[relay] toolsBin: ${TOOLS_BIN}`);

  const relayId = process.env["NAUTILO_RELAY_ID"]?.trim() || randomUUID();

  // D384 Phase 5 — relay-side MCP host. Keyless-first: no authResolver wired
  // yet (Layer 4 adds the relay-local ~/.nautilo/relay/vault.enc resolver), so
  // no-auth / env-passthrough MCPs work; an authRef throws until then.
  //
  // spawnEnvBase: the headless relay runs from the user's shell, so its own
  // env IS the user's env — pass it through as the MCP child baseline so
  // toolchain vars (JAVA_HOME, ANDROID_HOME, …) survive the SDK's safe-list
  // (local tier = user's machine = Claude Desktop/Cursor parity).
  const spawnEnvBase: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && !v.startsWith("()")) spawnEnvBase[k] = v;
  }
  const mcpHost = createRelayMcpHost({ relayId, spawnEnvBase });
  const openHueBinary = resolveOpenHueBinary();
  const hueAvailable = await probeOpenHue(openHueExecutor, openHueBinary);
  const hueHandler = createOpenHueHandler({
    executor: openHueExecutor,
    binaryPath: openHueBinary,
  });
  if (!hueAvailable) {
    warn(
      `[relay] OpenHue unavailable (${openHueBinary} version failed); ` +
        "Hue discovery and control capabilities are disabled.",
    );
  }

  const client = createRelayClient({
    serverUrl,
    relayId,
    userId,
    token: credential.relayToken,
    capabilities: {
      profile: "desktop-agent",
      canReadWorkspace: true,
      canWriteWorkspace: true,
      workspaceRoot: guard.roots[0],
      ...(hueAvailable
        ? { canDiscoverHue: true, canControlHue: true }
        : {}),
      allowedRoots: [...guard.roots],
      securityLevel: "standard",
      // D060 Sprint 1 G5.4.c — paths the server\u0027s Policy Resolver
      // uses to construct a sandboxProfile scoped to this relay.
      userHome,
      dataDir,
      toolsBin: TOOLS_BIN,
      // D384 Phase 5 — opt-in signal: this relay CAN host MCP servers (empty
      // until the server sends relay:configure-mcp). The server keys off
      // `mcpTools !== undefined` to decide whether to configure this relay.
      mcpTools: [],
    },
    onDispatch: makeDispatchHandler(guard, { hueHandler }),
    onStatusChange: (status) => {
      log(`[relay] Status: ${status}`);
    },
    onAuthenticationRequired: () => {
      void requireRepair();
    },
    mcpHost,
  });

  const terminate = createHeadlessTerminationCoordinator({
    mcpHost,
    client,
    log,
    reportError: error,
    exit: (code) => process.exit(code),
  });

  let repair: Promise<void> | null = null;
  function requireRepair(): Promise<void> {
    if (repair !== null) return repair;
    const next = credentialStore.clear()
      .catch(() => {
        error("[relay] The rejected credential could not be removed from the operating-system keychain.");
      })
      .then(() => terminate({ kind: "authentication_required" }));
    repair = next;
    return next;
  }

  process.once("SIGINT", () => {
    void terminate({ kind: "signal", signal: "SIGINT" });
  });

  process.once("SIGTERM", () => {
    void terminate({ kind: "signal", signal: "SIGTERM" });
  });

  try {
    await client.connect();
    log(`[relay] Connected as ${client.getRelayId()}`);
  } catch (err) {
    if (err instanceof RelayAuthenticationRequiredError) {
      await requireRepair();
    } else {
      await terminate({ kind: "connect_failure", error: err });
    }
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    error("[relay] Fatal:", err);
    process.exit(1);
  });
}
