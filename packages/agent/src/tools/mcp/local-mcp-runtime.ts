/**
 * D384 §5.4 — dependency-injection seam for the `manage_local_mcp` tool.
 *
 * The local-tier MCP config store + relay-ownership checks live in
 * `@nautilo/server` (`mcp/local-mcp-service.ts`). `@nautilo/agent` cannot
 * import `@nautilo/server` (server already depends on agent), so the server
 * wiring publishes a {@link LocalMcpToolRuntime} here at boot; the tool reads
 * it at invoke time. Tests inject a fake runtime via
 * {@link setLocalMcpToolRuntime}.
 *
 * Mirrors `tools/apps/mini-app-runtime.ts` + `tools/connections/runtime.ts`.
 */

import type {
  LocalMcpInstallModelIntent,
  LocalMcpInstallPrepared,
  LocalMcpInstallResult,
} from "@nautilo/types";

/** The acting human whose relay + config rows the verb operates on. */
export interface LocalMcpToolActorContext {
  /** Resolved acting user (ctx.ownerId ?? ctx.userId). */
  readonly userId: string;
}

/** Config for a `register` call. Secrets are NEVER passed here — only env
 *  variable NAMES (resolved on the user's machine at spawn, D384 §5.1.4). */
export interface LocalMcpRegisterInput {
  readonly name: string;
  readonly transportKind: "stdio" | "streamable-http" | "sse-legacy";
  /** Variant-only transport: `{command,args}` (stdio) or `{url,headers}`. */
  readonly transport: Record<string, unknown>;
  /**
   * Target relay id. Optional: when omitted the runtime uses the user's
   * single connected relay, or errors if they own zero / multiple.
   */
  readonly relayId?: string | undefined;
  /** Server-env variable NAMES to pass through at spawn (values never stored). */
  readonly envPassthrough?: readonly string[] | undefined;
  readonly namespaceId?: string | null | undefined;
  readonly includeTools?: readonly string[] | undefined;
  readonly excludeTools?: readonly string[] | undefined;
}

/** Public, secret-free summary of a local-tier `mcp_servers` row. */
export interface LocalMcpServerSummary {
  readonly name: string;
  readonly host: string;
  readonly enabled: boolean;
  readonly transportKind: string;
  readonly health?: string | undefined;
  readonly toolCount?: number | undefined;
}

export interface LocalMcpActionResult {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly server?: LocalMcpServerSummary | undefined;
  readonly servers?: readonly LocalMcpServerSummary[] | undefined;
  /** Populated on ambiguous `register` (multiple connected relays). */
  readonly connectedRelays?: readonly string[] | undefined;
  /**
   * Human-facing guidance the Genie should relay. `enable` already WAITS a
   * realistic budget for the relay to start the MCP and advertise its tools,
   * so on success `server.toolCount` is the real count and `note` is unset.
   * `note` is populated only when the state is genuinely not-yet-ready: the
   * relay is offline (starts on reconnect) or the wait timed out (slow
   * first-run install / bad command). In those cases re-check with `status`.
   */
  readonly note?: string | undefined;
}

/** Server-prepared, checkpoint-bound install proposal. Model args are not reused after approval. */
export interface LocalMcpInstallPreparationInput {
  readonly intent: LocalMcpInstallModelIntent;
  readonly approvalId: string;
  readonly threadId: string;
  readonly laneKey: string;
  readonly toolCallId: string;
  readonly checkpointKey: string;
}

export type LocalMcpInstallPreparationResult =
  | { readonly ok: true; readonly prepared: LocalMcpInstallPrepared }
  | { readonly ok: false; readonly result: LocalMcpInstallResult };

/**
 * Runtime surface implemented server-side and injected at boot. Every
 * method is scoped to the acting user; the impl hard-scopes to the user's
 * own relay (local tier) and refuses server-tier rows.
 */
export interface LocalMcpToolRuntime {
  /** The user's currently-connected, owned relay ids. */
  listConnectedRelays(ctx: LocalMcpToolActorContext): Promise<readonly string[]>;
  /** Create a relay-tier row (`enabled=false`); owner-gated. */
  register(
    ctx: LocalMcpToolActorContext,
    input: LocalMcpRegisterInput,
  ): Promise<LocalMcpActionResult>;
  /** Enable / disable an owned local-tier row (drives relay reconcile). */
  setEnabled(
    ctx: LocalMcpToolActorContext,
    input: { name: string; enabled: boolean; relayId?: string | undefined },
  ): Promise<LocalMcpActionResult>;
  /** Stop and permanently delete an owned local-tier row. */
  remove(
    ctx: LocalMcpToolActorContext,
    input: { name: string; relayId?: string | undefined },
  ): Promise<LocalMcpActionResult>;
  /** List the user's own local-tier rows. */
  list(ctx: LocalMcpToolActorContext): Promise<LocalMcpActionResult>;
  /** Live status (health + tool count) of one owned local-tier row. */
  status(
    ctx: LocalMcpToolActorContext,
    input: { name: string; relayId?: string | undefined },
  ): Promise<LocalMcpActionResult>;
  /**
   * Canonicalize + preflight an install before its approval is rendered.
   * The returned binding is opaque to the model and one-time at execution.
   */
  prepareInstall(
    ctx: LocalMcpToolActorContext,
    input: LocalMcpInstallPreparationInput,
  ): Promise<LocalMcpInstallPreparationResult>;
  /** Execute only an exact, previously prepared approval binding. */
  install(
    ctx: LocalMcpToolActorContext,
    input: {
      readonly prepared: LocalMcpInstallPrepared;
      readonly approvalId: string;
      readonly toolCallId: string;
      readonly digest: string;
    },
  ): Promise<LocalMcpInstallResult>;
}

let _localMcpToolRuntime: LocalMcpToolRuntime | null = null;

export function setLocalMcpToolRuntime(runtime: LocalMcpToolRuntime | null): void {
  _localMcpToolRuntime = runtime;
}

export function getLocalMcpToolRuntime(): LocalMcpToolRuntime {
  if (!_localMcpToolRuntime) {
    throw new Error(
      "manage_local_mcp runtime not set — call setLocalMcpToolRuntime() (server wiring / test setup) before the tool runs",
    );
  }
  return _localMcpToolRuntime;
}

export function resetLocalMcpToolRuntimeForTests(): void {
  _localMcpToolRuntime = null;
}
