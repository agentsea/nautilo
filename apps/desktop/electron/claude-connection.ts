import {
  ClaudeAgentSdkHost,
  defaultClaudeAgentSdk,
  type ClaudeDiscoveryRequest,
  type ClaudeExecutableResolver,
} from "@nautilo/claude-agent-sdk-host";
import {
  CLAUDE_CONNECTION_PROTOCOL_VERSION,
  parseRelayClaudeConnectionDiscoveryResult,
  type RelayClaudeConnectionAccount,
  type RelayClaudeConnectionCatalog,
  type RelayClaudeConnectionDiscoverCommand,
  type RelayClaudeConnectionHostPort,
  type RelayClaudeConnectionHostTransport,
  type RelayClaudeConnectionRuntime,
  type RelayClaudeConnectionScope,
  type RelayClaudeConnectionSession,
  type RelayClaudeAccount,
  type RelayClaudeFact,
} from "@nautilo/relay";
import { createAmbientClaudeExecutableResolver } from "./claude-executable-resolver";

/**
 * Electron's discovery-only Claude adapter. It owns no provider account,
 * profile, Task, credential, prompt, or filesystem state: those never cross
 * this seam. Each relay command gets one fresh parked SDK discovery attempt.
 */
export class ElectronClaudeConnectionHost implements RelayClaudeConnectionHostPort {
  #session: RelayClaudeConnectionSession | null = null;
  #transport: RelayClaudeConnectionHostTransport | null = null;
  #active: ActiveDiscovery | null = null;
  readonly #createHost: (onFact: (fact: RelayClaudeFact) => void) => ClaudeDiscoveryHost;
  readonly #resolver: ClaudeExecutableResolver;
  readonly #workingDirectory: () => string;

  constructor(input: Readonly<{
    workingDirectory: () => string;
    executableResolver?: ClaudeExecutableResolver;
    createHost?: (onFact: (fact: RelayClaudeFact) => void) => ClaudeDiscoveryHost;
  }>) {
    this.#workingDirectory = input.workingDirectory;
    this.#resolver = input.executableResolver ?? createAmbientClaudeExecutableResolver();
    this.#createHost = input.createHost ?? ((onFact) => new ClaudeAgentSdkHost({
      executableResolver: this.#resolver,
      sdk: defaultClaudeAgentSdk,
      onFact,
    }));
  }

  /** The compiled port is present; discovery owns current runtime truth. */
  isReady(): boolean { return true; }

  onRegistered(session: RelayClaudeConnectionSession, transport: RelayClaudeConnectionHostTransport): void {
    this.#abortActive();
    this.#session = freezeSession(session);
    this.#transport = transport;
  }

  onDisconnected(): void {
    this.#abortActive();
    this.#session = null;
    this.#transport = null;
  }

  onDiscover(message: RelayClaudeConnectionDiscoverCommand): void {
    const session = this.#session;
    const transport = this.#transport;
    if (session === null || transport === null || !sameScope(session, message.scope)) return;
    // A direct/reentrant caller must never overlap a live SDK query. The
    // client already rejects correlation replays; this contains the local
    // side too before the newer discovery begins.
    this.#abortActive();
    const active: ActiveDiscovery = {
      command: freezeCommand(message),
      session,
      transport,
      controller: new AbortController(),
      facts: new DiscoveryFacts(),
    };
    this.#active = active;
    let host: ClaudeDiscoveryHost;
    try {
      host = this.#createHost((fact) => this.#recordFact(active, fact));
    } catch {
      active.facts.record({ kind: "host_failure", code: "CLAUDE_SDK_FAILURE" });
      this.#complete(active);
      return;
    }
    void this.#discover(active, host);
  }

  async #discover(active: ActiveDiscovery, host: ClaudeDiscoveryHost): Promise<void> {
    try {
      await host.discover({
        workingDirectory: this.#workingDirectory(),
        signal: active.controller.signal,
      });
    } catch {
      active.facts.record({ kind: "host_failure", code: "CLAUDE_SDK_FAILURE" });
    }
    this.#complete(active);
  }

  #complete(active: ActiveDiscovery): void {
    if (!this.#isCurrent(active) || active.controller.signal.aborted) return;
    try {
      const result = parseRelayClaudeConnectionDiscoveryResult({
        type: "relay:claude-connection-discovery-result",
        version: CLAUDE_CONNECTION_PROTOCOL_VERSION,
        correlationId: active.command.correlationId,
        scope: active.command.scope,
        profileRef: active.command.profileRef,
        ...active.facts.resultFields(),
      });
      if (result !== null && this.#isCurrent(active)) active.transport.send(result);
    } catch {
      // The socket transport is an untrusted lifecycle seam. A throwing stale
      // sender must not strand this local discovery or surface an unhandled
      // rejection from the WebSocket callback path.
    } finally {
      if (this.#active === active) this.#active = null;
    }
  }

  #recordFact(active: ActiveDiscovery, fact: RelayClaudeFact): void {
    if (!this.#isCurrent(active) || active.controller.signal.aborted) return;
    active.facts.record(fact);
  }

  #isCurrent(active: ActiveDiscovery): boolean {
    return this.#active === active && this.#session === active.session && this.#transport === active.transport &&
      sameScope(active.session, active.command.scope);
  }

  #abortActive(): void {
    const active = this.#active;
    if (active === null) return;
    this.#active = null;
    active.controller.abort();
  }
}

export interface ClaudeDiscoveryHost {
  discover(request: ClaudeDiscoveryRequest): Promise<boolean>;
}

type ActiveDiscovery = {
  readonly command: RelayClaudeConnectionDiscoverCommand;
  readonly session: RelayClaudeConnectionSession;
  readonly transport: RelayClaudeConnectionHostTransport;
  readonly controller: AbortController;
  readonly facts: DiscoveryFacts;
};

/** Maps only the SDK host's closed discovery facts to the closed v17 result. */
class DiscoveryFacts {
  #runtime: RelayClaudeConnectionRuntime | null = null;
  #account: RelayClaudeConnectionAccount | null = null;
  #catalog: RelayClaudeConnectionCatalog | null = null;

  record(fact: RelayClaudeFact): void {
    switch (fact.kind) {
      case "runtime":
        this.#runtime = fact.state === "ready"
          ? { state: "ready", version: fact.version, executionQualified: fact.executionQualified }
          : fact.state === "unavailable" ? { state: "unavailable" }
          : fact.version === undefined ? { state: "incompatible" } : { state: "incompatible", version: fact.version };
        return;
      case "account":
        if (!hasAccountFact(fact.account)) {
          this.#account = { state: "unavailable" };
          return;
        }
        {
          const { state: _state, ...account } = fact.account;
          this.#account = { state: "connected", ...account };
        }
        return;
      case "account_state":
        this.#account = fact.state === "disconnected" ? { state: "disconnected" } : { state: "unavailable" };
        return;
      case "model_catalog":
        this.#catalog = fact.complete
          ? { state: "complete", complete: true, models: fact.models }
          : { state: "incomplete", complete: false, models: fact.models };
        return;
      case "host_failure":
        this.#runtime = { state: "failure" };
        return;
      default:
        return;
    }
  }

  resultFields(): Readonly<{
    runtime: RelayClaudeConnectionRuntime;
    account: RelayClaudeConnectionAccount;
    catalog: RelayClaudeConnectionCatalog;
  }> {
    return {
      runtime: this.#runtime ?? { state: "failure" },
      account: this.#account ?? { state: "unavailable" },
      catalog: this.#catalog ?? { state: "unavailable", complete: false, models: [] },
    };
  }
}

function hasAccountFact(account: RelayClaudeAccount): boolean {
  return account.apiProvider !== undefined || account.email !== undefined || account.organization !== undefined ||
    account.subscriptionType !== undefined || account.tokenSource !== undefined || account.apiKeySource !== undefined;
}

function sameScope(left: RelayClaudeConnectionScope, right: RelayClaudeConnectionScope): boolean {
  return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId &&
    left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef &&
    left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}

function freezeSession(session: RelayClaudeConnectionSession): RelayClaudeConnectionSession {
  return Object.freeze({ ...session });
}

function freezeCommand(command: RelayClaudeConnectionDiscoverCommand): RelayClaudeConnectionDiscoverCommand {
  return Object.freeze({ ...command, scope: Object.freeze({ ...command.scope }) });
}
