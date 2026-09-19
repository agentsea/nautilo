import {
  findSingleBrowserUsePageTargetAtOrigin,
  resolveBrowserUseCdpWebSocketUrl,
} from "./cdp-navigator";

/**
 * Semantic commands supported by the pinned agent-browser transport for a
 * Browser Use managed browser. The router and operation runtime enforce
 * origin and actor authority; this is not a model-facing tool registration.
 * File transfer, tabs/frames/dialogs, coordinate gestures and screenshots are
 * outside this direct-control surface.
 */
export const DIRECT_CONNECTED_WEB_BROWSER_TOOLS = [
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_open",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_hover",
  "browser_double_click",
  "browser_drag",
  "browser_select",
  "browser_set_checked",
  "browser_scroll",
  "browser_scroll_into_view",
  "browser_wait",
  "browser_read",
  "browser_get",
] as const;

export type DirectConnectedWebBrowserTool =
  (typeof DIRECT_CONNECTED_WEB_BROWSER_TOOLS)[number];

export interface DirectBrowserControlIdentity {
  /** Server-only operation identity; never projected to the model or client. */
  readonly operationId: string;
  /** Server-only ConnectedWebAccount identity. */
  readonly accountId: string;
  /** Monotonically rotated by the future durable operation authority. */
  readonly controlEpoch: number;
}

export interface DirectBrowserControlBrowser {
  /** Browser Use V4 browser identifier, retained only by the server. */
  readonly browserId: string;
  /** Browser Use HTTPS discovery capability, never argv or output. */
  readonly cdpUrl: string;
}

export interface DirectBrowserControlCommand {
  readonly toolName: DirectConnectedWebBrowserTool;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Small, bounded feedback from one semantic browser command. */
export interface DirectBrowserControlCommandResult {
  /** Sanitized command output; never includes CDP/provider coordinates. */
  readonly text: string;
  /** The harness retained only its configured safe stdout prefix. */
  readonly truncated: boolean;
}

export interface DirectBrowserControlObservation {
  readonly snapshot: string;
  readonly refs: Readonly<Record<string, { readonly role: string; readonly name: string }>>;
}

export interface DirectBrowserControlProvider {
  /**
   * Browser Use is authoritative for lifecycle. Closing an attached CDP client
   * is not a stop and cannot be substituted for this call.
   */
  stopBrowser(browserId: string): Promise<unknown>;
}

export interface DirectBrowserControlHarness {
  /**
   * The production harness supplies `agentBrowserCdpArgv` from @nautilo/relay.
   * Its argv must contain no provider/config/CDP capability.
   */
  buildArgv(input: {
    readonly toolName: DirectConnectedWebBrowserTool;
    readonly args: Readonly<Record<string, unknown>>;
    readonly session: string;
  }): readonly string[];
  /**
   * Start exactly one command in the dedicated operation/account/epoch
   * session. `AGENT_BROWSER_CDP` is the only place this adapter supplies the
   * resolved bearer capability. The production implementation must construct
   * an allowlisted environment and must not inherit ambient `AGENT_BROWSER_*`
   * variables or any provider API key.
   */
  invoke(input: {
    readonly argv: readonly string[];
    readonly environment: Readonly<{ AGENT_BROWSER_CDP: string }>;
    /** Caller-provisioned, operation-private agent-browser daemon directory. */
    readonly socketDirectory: string;
    /** Caller-provisioned operation-private HOME/state directory. */
    readonly homeDirectory: string;
    readonly signal?: AbortSignal;
  }): Promise<DirectBrowserControlCommandResult>;
  /** Private structured snapshot path used by the server decision loop. */
  observe?(input: {
    readonly session: string;
    readonly environment: Readonly<{ AGENT_BROWSER_CDP: string }>;
    readonly socketDirectory: string;
    readonly homeDirectory: string;
    readonly signal?: AbortSignal;
  }): Promise<DirectBrowserControlObservation>;
  /** Server-only bootstrap. The CDP target id never reaches a model result. */
  bindPinnedTarget?(input: {
    readonly targetId: string;
    readonly session: string;
    readonly environment: Readonly<{ AGENT_BROWSER_CDP: string }>;
    readonly socketDirectory: string;
    readonly homeDirectory: string;
  }): Promise<void>;
  /** Reads the pinned tab URL for an internal origin assertion only. */
  readPinnedUrl?(input: {
    readonly session: string;
    readonly environment: Readonly<{ AGENT_BROWSER_CDP: string }>;
    readonly socketDirectory: string;
    readonly homeDirectory: string;
  }): Promise<string>;
  /** Closes every daemon in this operation-private socket directory. */
  closePrivateDaemons?(input: {
    readonly socketDirectory: string;
    readonly homeDirectory: string;
  }): Promise<void>;
}

export interface DirectBrowserControlDependencies {
  readonly provider: DirectBrowserControlProvider;
  readonly harness: DirectBrowserControlHarness;
  /** Durable store CAS; it must reject another driver or an old epoch. */
  readonly isCurrentControlEpoch: (identity: DirectBrowserControlIdentity) => Promise<boolean>;
  /** The canonical HTTPS discovery → same-host WSS validator. */
  readonly resolveCdpWebSocketUrl?: (cdpUrl: string, timeoutMs: number) => Promise<string>;
  /** Exact-target discovery over the already validated Browser Use WSS. */
  readonly findPageTargetAtOrigin?: (websocketUrl: string, origin: string, timeoutMs: number) => Promise<string>;
  /** Transport deadline for one discovery request, never an operation deadline. */
  readonly discoveryTimeoutMs?: number;
}

export interface DirectBrowserControlCleanupResult {
  readonly status: "stopped" | "cleanup_unresolved";
}

export class DirectBrowserControlError extends Error {
  constructor(
    readonly code: "stale_control" | "unsupported_tool" | "unavailable" | "closed",
    /** Internal cleanup proof for bootstrap failures; never projected. */
    readonly cleanup?: DirectBrowserControlCleanupResult,
    readonly detail?: string,
  ) {
    super("direct browser control unavailable");
    this.name = "DirectBrowserControlError";
  }
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const SESSION_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,119})$/iu;

function isCurrentTool(value: string): value is DirectConnectedWebBrowserTool {
  return (DIRECT_CONNECTED_WEB_BROWSER_TOOLS as readonly string[]).includes(value);
}

function validIdentity(identity: DirectBrowserControlIdentity): boolean {
  return identity.operationId.length > 0
    && identity.accountId.length > 0
    && Number.isSafeInteger(identity.controlEpoch)
    && identity.controlEpoch >= 1;
}

function validDiscoveryTimeout(timeoutMs: number | undefined): timeoutMs is number {
  return typeof timeoutMs === "number" && Number.isInteger(timeoutMs) && timeoutMs > 0;
}

/**
 * A non-shareable direct-control lease. It holds no provider coordinates in
 * its public results and stops the exact Browser Use browser on every terminal
 * path it owns. Future operation persistence, hosted takeover, origin gates,
 * and model-tool routing are intentionally outside this adapter.
 */
export class DirectBrowserControlSession {
  private closed = false;
  private commandInFlight = false;
  private cleanup: Promise<DirectBrowserControlCleanupResult> | null = null;

  constructor(
    private readonly identity: DirectBrowserControlIdentity,
    private readonly browserId: string,
    private readonly websocketUrl: string,
    private readonly allowedOrigin: string,
    private readonly session: string,
    private readonly socketDirectory: string,
    private readonly homeDirectory: string,
    private readonly deps: DirectBrowserControlDependencies,
  ) {}

  /** Server-only invariant check; its URL is never returned. */
  async assertPinnedOrigin(): Promise<void> {
    if (!this.deps.harness.readPinnedUrl) throw new DirectBrowserControlError("unavailable");
    const current = await this.deps.harness.readPinnedUrl({
      session: this.session,
      environment: { AGENT_BROWSER_CDP: this.websocketUrl },
      socketDirectory: this.socketDirectory,
      homeDirectory: this.homeDirectory,
    });
    try {
      if (new URL(current).origin !== this.allowedOrigin) {
        throw new DirectBrowserControlError("unavailable");
      }
    } catch (error) {
      if (error instanceof DirectBrowserControlError) throw error;
      throw new DirectBrowserControlError("unavailable");
    }
  }

  async invoke(command: DirectBrowserControlCommand, signal?: AbortSignal): Promise<DirectBrowserControlCommandResult> {
    if (this.closed) throw new DirectBrowserControlError("closed");
    if (!isCurrentTool(command.toolName)) throw new DirectBrowserControlError("unsupported_tool");
    if (this.commandInFlight) throw new DirectBrowserControlError("stale_control");
    if (!await this.deps.isCurrentControlEpoch(this.identity)) {
      throw new DirectBrowserControlError("stale_control");
    }

    this.commandInFlight = true;
    try {
      await this.assertPinnedOrigin();
      const argv = this.deps.harness.buildArgv({
        toolName: command.toolName,
        args: command.args,
        session: this.session,
      });
      if (argv.some((token) => token === "--cdp" || token === "--provider" || token === "--config")) {
        throw new DirectBrowserControlError("unavailable");
      }
      const result = await this.deps.harness.invoke({
        argv,
        environment: { AGENT_BROWSER_CDP: this.websocketUrl },
        socketDirectory: this.socketDirectory,
        homeDirectory: this.homeDirectory,
        ...(signal === undefined ? {} : { signal }),
      });
      await this.assertPinnedOrigin();
      return result;
    } catch (error) {
      await this.close();
      if (error instanceof DirectBrowserControlError) throw error;
      const detail = typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string"
        ? error.detail : undefined;
      throw new DirectBrowserControlError("unavailable", undefined, detail);
    } finally {
      this.commandInFlight = false;
    }
  }


  async observe(signal?: AbortSignal): Promise<{ readonly observation: DirectBrowserControlObservation; readonly pageUrl: string }> {
    if (this.closed) throw new DirectBrowserControlError("closed");
    if (this.commandInFlight || !await this.deps.isCurrentControlEpoch(this.identity)) {
      throw new DirectBrowserControlError("stale_control");
    }
    this.commandInFlight = true;
    try {
      await this.assertPinnedOrigin();
      if (!this.deps.harness.observe) throw new DirectBrowserControlError("unavailable");
      const observation = await this.deps.harness.observe({
        session: this.session,
        environment: { AGENT_BROWSER_CDP: this.websocketUrl },
        socketDirectory: this.socketDirectory,
        homeDirectory: this.homeDirectory,
        ...(signal === undefined ? {} : { signal }),
      });
      const pageUrl = await this.readPinnedUrl();
      return { observation, pageUrl };
    } finally {
      this.commandInFlight = false;
    }
  }

  private async readPinnedUrl(): Promise<string> {
    if (!this.deps.harness.readPinnedUrl) throw new DirectBrowserControlError("unavailable");
    const pageUrl = await this.deps.harness.readPinnedUrl({
      session: this.session,
      environment: { AGENT_BROWSER_CDP: this.websocketUrl },
      socketDirectory: this.socketDirectory,
      homeDirectory: this.homeDirectory,
    });
    if (new URL(pageUrl).origin !== this.allowedOrigin) throw new DirectBrowserControlError("stale_control");
    return new URL(pageUrl).href;
  }

  /** Concurrent closes share an attempt; unresolved cleanup remains retryable. */
  async close(): Promise<DirectBrowserControlCleanupResult> {
    if (this.cleanup !== null) return this.cleanup;
    this.closed = true;
    this.cleanup = (async () => {
      let harnessStopped = false;
      try {
        if (!this.deps.harness.closePrivateDaemons) throw new Error("unavailable");
        await this.deps.harness.closePrivateDaemons({
          socketDirectory: this.socketDirectory,
          homeDirectory: this.homeDirectory,
        });
        harnessStopped = true;
      } catch {
        // The provider stop below still revokes the browser capability. Keep
        // durable direct ownership fenced until restart recovery also proves
        // the private daemon is gone.
      }
      let browserStopped = false;
      try {
        await this.deps.provider.stopBrowser(this.browserId);
        browserStopped = true;
      } catch {
        // Exact stopped proof is owned by the provider adapter wrapper.
      }
      return { status: harnessStopped && browserStopped ? "stopped" : "cleanup_unresolved" };
    })();
    const result = await this.cleanup;
    if (result.status !== "stopped") this.cleanup = null;
    return result;
  }
}

/**
 * Resolve the Browser Use discovery capability and claim an in-memory direct
 * control session. If setup fails after Browser Use has created the browser,
 * stop it before returning a redacted error.
 */
export async function createDirectBrowserControlSession(input: {
  readonly identity: DirectBrowserControlIdentity;
  readonly browser: DirectBrowserControlBrowser;
  /** Durable connected-account origin. */
  readonly allowedOrigin: string;
  /** Dedicated operation/account/control-epoch session, never `default`. */
  readonly harnessSession: string;
  /** Provisioned server-private directory for the attached agent-browser daemon. */
  readonly socketDirectory: string;
  /** Provisioned server-private HOME so agent-browser state cannot cross operations. */
  readonly homeDirectory: string;
}, deps: DirectBrowserControlDependencies): Promise<DirectBrowserControlSession> {
  const browserId = input.browser.browserId;
  const canStop = browserId.length > 0;
  try {
    if (!validIdentity(input.identity) || !canStop || input.browser.cdpUrl.length === 0 || !SESSION_NAME.test(input.harnessSession)
      || input.socketDirectory.length === 0 || input.homeDirectory.length === 0
      || !deps.harness.bindPinnedTarget || !deps.harness.readPinnedUrl || !deps.harness.closePrivateDaemons) {
      throw new DirectBrowserControlError("unavailable");
    }
    const allowedOrigin = new URL(input.allowedOrigin);
    if (allowedOrigin.origin !== input.allowedOrigin
      || (allowedOrigin.protocol !== "https:" && allowedOrigin.protocol !== "http:")) {
      throw new DirectBrowserControlError("unavailable");
    }
    if (!await deps.isCurrentControlEpoch(input.identity)) {
      throw new DirectBrowserControlError("stale_control");
    }
    const timeoutMs = validDiscoveryTimeout(deps.discoveryTimeoutMs)
      ? deps.discoveryTimeoutMs
      : DEFAULT_DISCOVERY_TIMEOUT_MS;
    const resolve = deps.resolveCdpWebSocketUrl
      ?? ((cdpUrl: string, deadlineMs: number) => resolveBrowserUseCdpWebSocketUrl(cdpUrl, deadlineMs));
    const websocketUrl = await resolve(input.browser.cdpUrl, timeoutMs);
    if (!websocketUrl.startsWith("wss://")) throw new DirectBrowserControlError("unavailable");
    const findTarget = deps.findPageTargetAtOrigin
      ?? ((url: string, origin: string, deadlineMs: number) => findSingleBrowserUsePageTargetAtOrigin(url, origin, deadlineMs));
    const targetId = await findTarget(websocketUrl, input.allowedOrigin, timeoutMs);
    await deps.harness.bindPinnedTarget({
      targetId,
      session: input.harnessSession,
      environment: { AGENT_BROWSER_CDP: websocketUrl },
      socketDirectory: input.socketDirectory,
      homeDirectory: input.homeDirectory,
    });
    const session = new DirectBrowserControlSession(
      input.identity,
      browserId,
      websocketUrl,
      input.allowedOrigin,
      input.harnessSession,
      input.socketDirectory,
      input.homeDirectory,
      deps,
    );
    await session.assertPinnedOrigin();
    return session;
  } catch (error) {
    let harnessStopped = false;
    if (deps.harness.closePrivateDaemons) {
      await deps.harness.closePrivateDaemons({
        socketDirectory: input.socketDirectory,
        homeDirectory: input.homeDirectory,
      }).then(() => { harnessStopped = true; }).catch(() => undefined);
    }
    let browserStopped = false;
    if (canStop) await deps.provider.stopBrowser(browserId)
      .then(() => { browserStopped = true; })
      .catch(() => undefined);
    const cleanup = { status: harnessStopped && browserStopped ? "stopped" : "cleanup_unresolved" } as const;
    if (error instanceof DirectBrowserControlError) throw new DirectBrowserControlError(error.code, cleanup);
    throw new DirectBrowserControlError("unavailable", cleanup);
  }
}
