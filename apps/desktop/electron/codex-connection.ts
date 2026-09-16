import type {
  RelayCodexHostPort,
  RelayCodexHostTransport,
  RelayCodexServerMessage,
  RelayCodexSession,
} from "@nautilo/relay";

type CodexCommand = Extract<RelayCodexServerMessage, { readonly type: "relay:codex-command" }>;
type CodexCancel = Extract<RelayCodexServerMessage, { readonly type: "relay:codex-cancel" }>;
type CodexCredit = Extract<RelayCodexServerMessage, { readonly type: "relay:codex-credit" }>;
type CodexRequestResponse = Extract<RelayCodexServerMessage, { readonly type: "relay:codex-request-response" }>;

export interface ManagedElectronCodexHost extends RelayCodexHostPort {
  /** Publishes the current redacted host projection after a local lifecycle change. */
  refreshStatus?(): void;
  /** Read-only local lifecycle fence for relay replacement. */
  hasActiveWork(): Promise<boolean>;
  shutdown(): Promise<void>;
}

export type CodexRelayRefreshResult = "acked" | "deferred" | "failed";

/**
 * Redacted lifecycle projection intended for the human renderer. It carries
 * no account, runtime, workspace, process, or error-detail information.
 */
export type ElectronCodexConnectionState =
  | "disabled"
  | "enabling"
  | "enabled"
  | "disabling"
  | "faulted";

export interface ElectronCodexConnectionStatus {
  readonly state: ElectronCodexConnectionState;
  /** True only when the current enabled generation reports itself ready. */
  readonly ready: boolean;
  /** Outcome of the most recent capability reconciliation, if one ran. */
  readonly relayReconciliation: CodexRelayRefreshResult | null;
}

export interface ElectronCodexConnectionOptions {
  /** Reconciles the relay's advertised capability after a real state change. */
  readonly refreshRelay: (reason: string) => Promise<CodexRelayRefreshResult>;
}

export type ElectronCodexHostFactory = () => ManagedElectronCodexHost | Promise<ManagedElectronCodexHost>;

interface ActiveHost {
  readonly generation: number;
  readonly host: ManagedElectronCodexHost;
}

/**
 * Stable relay-facing port for the optional Codex connection.
 *
 * The object exists for the desktop lifetime, while its real Electron host is
 * created only after an explicit enable. Disable/shutdown close admission
 * synchronously and serialize teardown behind any in-flight enable.
 */
export class ElectronCodexConnection implements RelayCodexHostPort {
  private desiredEnabled = false;
  private closed = false;
  private intentGeneration = 0;
  private generation = 0;
  private active: ActiveHost | null = null;
  private lifecycle = Promise.resolve();
  private enablePromise: Promise<void> | null = null;
  private disablePromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private finalShutdownSettled = false;
  private terminalFault: Error | null = null;
  private uncertainHost: ManagedElectronCodexHost | null = null;
  private relayReconciliation: CodexRelayRefreshResult | null = null;

  constructor(private readonly options: ElectronCodexConnectionOptions) {}

  isReady(): boolean {
    const active = this.current();
    return active !== null && active.host.isReady?.() === true;
  }

  /** A failed local activity read is deliberately treated as active. */
  async hasActiveWork(): Promise<boolean> {
    const active = this.current();
    if (!active) return false;
    try {
      return await active.host.hasActiveWork();
    } catch {
      return true;
    }
  }

  /**
   * Immutable, renderer-safe lifecycle snapshot. The state is derived from
   * the same synchronous admission fences used by relay delegation, so a
   * superseding disable/re-enable is visible before queued teardown runs.
   */
  status(): ElectronCodexConnectionStatus {
    const state = this.lifecycleState();
    return Object.freeze({
      state,
      ready: state === "enabled" && this.isReady(),
      relayReconciliation: this.relayReconciliation,
    });
  }

  enable(createHost: ElectronCodexHostFactory): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex connection is shut down"));
    if (this.terminalFault) return Promise.reject(this.terminalFault);
    if (this.desiredEnabled && this.enablePromise) return this.enablePromise;
    const intent = ++this.intentGeneration;
    this.desiredEnabled = true;
    const operation = this.queue(async () => {
      if (this.terminalFault) throw this.terminalFault;
      if (this.closed || !this.desiredEnabled || intent !== this.intentGeneration || this.active) return;
      let host: ManagedElectronCodexHost;
      try {
        host = await createHost();
      } catch (error) {
        if (!this.closed && intent === this.intentGeneration) this.desiredEnabled = false;
        throw error;
      }
      if (this.closed || !this.desiredEnabled || intent !== this.intentGeneration) {
        await this.shutdownHost(host);
        return;
      }
      const active = { generation: ++this.generation, host };
      this.active = active;
      try {
        await this.refreshRelay("codex connection enabled");
      } catch (error) {
        if (this.active === active) this.active = null;
        if (intent === this.intentGeneration) {
          this.desiredEnabled = false;
          this.generation += 1;
        }
        try {
          await this.shutdownHost(host);
        } catch {
          // Preserve the reconciliation failure for this operation. The
          // shutdown failure has terminal-faulted the lifecycle, so every
          // later enable still rejects rather than replacing an uncertain
          // process.
        }
        throw error;
      }
    });
    this.enablePromise = operation;
    void operation.finally(() => {
      if (this.enablePromise === operation) this.enablePromise = null;
    }).catch(() => undefined);
    return operation;
  }

  disable(): Promise<void> {
    if (this.closed) return this.shutdownPromise ?? Promise.resolve();
    if (this.terminalFault) return Promise.reject(this.terminalFault);
    if (this.disablePromise) return this.disablePromise;
    this.desiredEnabled = false;
    this.intentGeneration += 1;
    this.generation += 1;
    const operation = this.queue(async () => {
      const active = this.active;
      if (!active) return;
      let refreshError: unknown;
      try {
        // Keep the old host only for the relay's lifecycle disconnect while
        // capability reconciliation removes Codex from the active socket.
        await this.refreshRelay("codex connection disabled");
      } catch (error) {
        refreshError = error;
      } finally {
        if (this.active === active) this.active = null;
      }
      let shutdownError: unknown;
      try {
        await this.shutdownHost(active.host);
      } catch (error) {
        shutdownError = error;
      }
      if (refreshError !== undefined) throw asError(refreshError, "Codex relay refresh failed");
      if (shutdownError !== undefined) throw asError(shutdownError, "Codex host shutdown failed");
    });
    this.disablePromise = operation;
    void operation.finally(() => {
      if (this.disablePromise === operation) this.disablePromise = null;
    }).catch(() => undefined);
    return operation;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.desiredEnabled = false;
    this.intentGeneration += 1;
    this.generation += 1;
    this.shutdownPromise = this.queue(async () => {
      const active = this.detach();
      if (active) await this.shutdownHost(active.host);
      if (this.terminalFault) throw this.terminalFault;
    });
    void this.shutdownPromise.finally(() => {
      this.finalShutdownSettled = true;
    }).catch(() => undefined);
    return this.shutdownPromise;
  }

  onRegistered(session: RelayCodexSession, transport: RelayCodexHostTransport): void | Promise<void> {
    const active = this.current();
    return active?.host.onRegistered?.(session, transport);
  }

  onCommand(message: CodexCommand): void | Promise<void> {
    const active = this.current();
    return active?.host.onCommand?.(message);
  }

  onCancel(message: CodexCancel): void | Promise<void> {
    const active = this.current();
    return active?.host.onCancel?.(message);
  }

  onCredit(message: CodexCredit): void | Promise<void> {
    const active = this.current();
    return active?.host.onCredit?.(message);
  }

  onRequestResponse(message: CodexRequestResponse): void | Promise<void> {
    const active = this.current();
    return active?.host.onRequestResponse?.(message);
  }

  onDisconnected(): void {
    // Disable fences commands/readiness immediately, but the old relay may
    // still deliver its lifecycle disconnect while reconciliation is pending.
    const active = this.active;
    active?.host.onDisconnected?.();
  }

  private current(): ActiveHost | null {
    const active = this.active;
    return !this.closed
      && this.terminalFault === null
      && this.uncertainHost === null
      && this.desiredEnabled
      && active?.generation === this.generation
      ? active
      : null;
  }

  private detach(): ActiveHost | null {
    const active = this.active;
    this.active = null;
    return active;
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const operation = this.lifecycle.then(work);
    this.lifecycle = operation.catch(() => undefined);
    return operation;
  }

  private async refreshRelay(reason: string): Promise<void> {
    let result: CodexRelayRefreshResult;
    try {
      result = await this.options.refreshRelay(reason);
    } catch (error) {
      this.relayReconciliation = "failed";
      throw error;
    }
    this.relayReconciliation = result;
    if (result === "failed") {
      throw new Error(`Codex relay refresh failed: ${reason}`);
    }
  }

  private lifecycleState(): ElectronCodexConnectionState {
    if (this.terminalFault || this.uncertainHost) return "faulted";
    if (this.shutdownPromise && !this.finalShutdownSettled) return "disabling";
    if (this.closed) return "disabled";
    if (this.disablePromise && !this.desiredEnabled) return "disabling";
    if (this.enablePromise) return "enabling";
    return this.current() ? "enabled" : "disabled";
  }

  private async shutdownHost(host: ManagedElectronCodexHost): Promise<void> {
    try {
      await host.shutdown();
    } catch (error) {
      const fault = asError(error, "Codex host shutdown failed");
      this.terminalFault ??= fault;
      this.uncertainHost ??= host;
      this.desiredEnabled = false;
      this.intentGeneration += 1;
      this.generation += 1;
      throw fault;
    }
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
