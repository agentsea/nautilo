/**
 * @nautilo/mcp-client — relay-side MCP host adapter (D384 Phase 5, 5.1.1).
 *
 * Wraps an {@link McpClientManager} in the {@link RelayMcpHost} seam that the
 * shared relay client (`@nautilo/relay`) drives. Both relay binaries (headless
 * `bin/nautilo-relay` and Electron) construct one of these and pass it as
 * `createRelayClient({ mcpHost })`. The adapter:
 *   - `configure(servers)` → maps the wire configs to {@link McpServerConfig}
 *     and `reconcile`s the manager (idempotent add/update/remove);
 *   - tracks `toolName → serverName` from `mcp:tools-changed` so `has()` can
 *     answer dispatch-routing questions and the relay client can emit
 *     `relay:advertise-mcp-tools`;
 *   - `dispatch()` runs through the manager's resilience policy and NEVER
 *     throws (graceful degradation — returns an error result).
 *
 * The `@nautilo/relay` import is TYPE-ONLY: no runtime edge, no cycle
 * (`@nautilo/relay` never imports `@nautilo/mcp-client`).
 */
import type {
  RelayAdvertisedMcpTool,
  RelayMcpConfigureOperation,
  RelayMcpFailure,
  RelayMcpHost,
  RelayMcpLauncherStatus,
  RelayMcpServerConfig,
} from "@nautilo/relay";
import { accessSync, constants, existsSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { McpClientManager, type McpClientManagerOptions } from "./manager.ts";
import { inspectEnvPassthrough } from "./resolve-auth.ts";
import type { McpResolvedAuth, McpServerConfig } from "./types.ts";

export interface RelayMcpHostOptions {
  /** Relay id — stamps `host = "relay-<id>"` on mapped configs (metadata). */
  relayId: string;
  /**
   * Relay-tier auth resolver (5.1.4). Resolves secrets on the USER's machine
   * (env passthrough → `~/.nautilo/relay/vault.enc`), never the server vault.
   * Omit to use the manager default (`resolveMcpAuth`).
   */
  authResolver?: (
    cfg: McpServerConfig,
    scope: "spawn" | "headers",
  ) => McpResolvedAuth;
  /** Injected manager (tests). Defaults to a fresh {@link McpClientManager}. */
  manager?: McpClientManager;
  /**
   * Richer env baseline for stdio child spawns (see `buildSpawnEnv`). The
   * relay runs ON the user's machine, so passing their real shell env here
   * (PATH, JAVA_HOME, ANDROID_HOME, …) is Claude Desktop/Cursor parity —
   * without it, GUI-launched Electron gives MCP children a stripped env and
   * toolchain-dependent servers (e.g. maestro → JVM) fail to start.
   */
  spawnEnvBase?: Record<string, string>;
  /** Optional Human-readable Desktop label. Defaults to the local hostname. */
  machineLabel?: string;
}

/** A relay MCP host plus its backing manager + a stop() for LIFO shutdown. */
export interface RelayMcpHostHandle extends RelayMcpHost {
  readonly manager: McpClientManager;
  stop(): Promise<void>;
}

type RelayMcpPreflightReport = Awaited<ReturnType<NonNullable<RelayMcpHost["preflight"]>>>;

function safeMachineLabel(value: string): string {
  const compact = value.replace(/[\r\n\t]+/g, " ").trim();
  const maxBytes = 160;
  if (Buffer.byteLength(compact, "utf8") <= maxBytes) {
    return compact.length > 0 ? compact : "This Desktop";
  }
  const bytes = Buffer.from(compact, "utf8");
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end -= 1;
  const truncated = bytes.subarray(0, end).toString("utf8").trim();
  return truncated.length > 0 ? truncated : "This Desktop";
}

function effectiveSpawnEnv(base?: Record<string, string>): Record<string, string> {
  return { ...process.env, ...(base ?? {}) } as Record<string, string>;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the launcher only; this never executes or downloads anything. */
function inspectLauncher(cfg: McpServerConfig, spawnEnvBase?: Record<string, string>): RelayMcpLauncherStatus {
  if (cfg.transportKind !== "stdio") return "not-applicable";
  const command = (cfg.transport as { command?: unknown }).command;
  if (typeof command !== "string" || command.length === 0) return "missing";
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command) && isExecutable(command) ? "present" : "missing";
  }
  const env = effectiveSpawnEnv(spawnEnvBase);
  const directories = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      if (isExecutable(join(directory, `${command}${extension}`))) return "present";
    }
  }
  return "missing";
}

function failure(code: RelayMcpFailure["code"]): RelayMcpFailure {
  return { code };
}

function classifyConfigureFailure(error: unknown): RelayMcpFailure {
  const detail = error instanceof Error ? error.message : "";
  if (/timed?\s*out|timeout/i.test(detail)) {
    return failure("discovery_timeout");
  }
  if (/enoent|spawn|not found/i.test(detail)) {
    return failure("spawn_failed");
  }
  if (/initialize|json-rpc|protocol|tools\/list/i.test(detail)) {
    return failure("protocol_failed");
  }
  return failure("internal");
}

/** Map a wire config (server→relay) to the manager's {@link McpServerConfig}. */
export function mapRelayMcpConfig(
  relayId: string,
  s: RelayMcpServerConfig,
): McpServerConfig {
  return {
    name: s.name,
    host: `relay-${relayId}`,
    transportKind: s.transportKind,
    transport: s.transport as unknown as McpServerConfig["transport"],
    envPassthrough: s.envPassthrough ?? null,
    namespaceId: s.namespaceId ?? null,
    includeTools: s.includeTools ?? null,
    excludeTools: s.excludeTools ?? null,
    trustTier: (s.trustTier as McpServerConfig["trustTier"]) ?? null,
    enabled: true,
  };
}

export function createRelayMcpHost(
  options: RelayMcpHostOptions,
): RelayMcpHostHandle {
  const managerOpts: McpClientManagerOptions = {};
  if (options.authResolver) managerOpts.authResolver = options.authResolver;
  if (options.spawnEnvBase) managerOpts.spawnEnvBase = options.spawnEnvBase;
  const manager = options.manager ?? new McpClientManager(managerOpts);
  const relayId = options.relayId;
  const machineLabel = safeMachineLabel(options.machineLabel ?? hostname());
  let operationTail: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = operationTail.then(operation, operation);
    operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // toolName → serverName, maintained from mcp:tools-changed. Authoritative
  // enough for dispatch routing; manager.dispatch re-resolves the owner.
  const hostedTools = new Map<string, string>();

  return {
    manager,

    configure(servers: RelayMcpServerConfig[]) {
      const mapped = servers.map((s) => mapRelayMcpConfig(relayId, s));
      return serialize(() => manager.reconcile(mapped));
    },

    preflight(server: RelayMcpServerConfig) {
      return serialize<RelayMcpPreflightReport>(() => {
        const mapped = mapRelayMcpConfig(relayId, server);
        const environment = inspectEnvPassthrough(mapped, process.env, options.spawnEnvBase);
        const launcher = inspectLauncher(mapped, options.spawnEnvBase);
        if (launcher === "missing") {
          return Promise.resolve({
            status: "blocked" as const,
            machineLabel,
            launcher,
            environment,
            failure: failure("missing_launcher"),
          });
        }
        if (environment.some((entry) => !entry.present)) {
          return Promise.resolve({
            status: "blocked" as const,
            machineLabel,
            launcher,
            environment,
            failure: failure("missing_environment"),
          });
        }
        return Promise.resolve({
          status: "ready" as const,
          machineLabel,
          launcher,
          environment,
        });
      });
    },

    configureWithOutcome(
      servers: RelayMcpServerConfig[],
      operation: RelayMcpConfigureOperation,
    ) {
      return serialize(async () => {
        const targetPresent = servers.some((server) => server.name === operation.targetName);
        if (
          (operation.phase === "start" && !targetPresent) ||
          (operation.phase === "rollback" && targetPresent)
        ) {
          return {
            state: "failed" as const,
            toolNames: [],
            failure: failure("invalid_request"),
          };
        }
        const mapped = servers.map((server) => mapRelayMcpConfig(relayId, server));
        try {
          const outcome = await manager.reconcileTarget(mapped, operation.targetName);
          if (operation.phase === "rollback") {
            if (outcome.state === undefined || outcome.state === "disconnected") {
              return { state: "stopped" as const, toolNames: [] };
            }
            return {
              state: "failed" as const,
              toolNames: [],
              failure: failure("internal"),
            };
          }
          if (outcome.state === "connected") {
            const toolNames = outcome.tools.map((tool) => tool.name);
            return toolNames.length > 0
              ? { state: "connected" as const, toolNames }
              : {
                  state: "failed" as const,
                  toolNames: [],
                  failure: failure("empty_toolset"),
                };
          }
          return {
            state: "failed" as const,
            toolNames: [],
            failure: classifyConfigureFailure(manager.getSafeLastError(operation.targetName)),
          };
        } catch (error) {
          return {
            state: "failed" as const,
            toolNames: [],
            failure: classifyConfigureFailure(error),
          };
        }
      });
    },

    has(toolName: string) {
      return hostedTools.has(toolName);
    },

    async dispatch(toolName: string, args: Record<string, unknown>) {
      try {
        const text = await manager.dispatch(toolName, args);
        return { status: "ok" as const, result: text };
      } catch (err) {
        return {
          status: "error" as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    onToolsChanged(
      listener: (serverName: string, tools: RelayAdvertisedMcpTool[]) => void,
    ) {
      manager.on("mcp:tools-changed", (serverName, tools) => {
        // Drop this server's stale entries, then re-index the current set.
        for (const [name, srv] of hostedTools) {
          if (srv === serverName) hostedTools.delete(name);
        }
        const advertised: RelayAdvertisedMcpTool[] = tools.map((t) => {
          hostedTools.set(t.name, serverName);
          return {
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          };
        });
        listener(serverName, advertised);
      });
    },

    async stop() {
      await serialize(() => manager.stopAll());
    },
  };
}
