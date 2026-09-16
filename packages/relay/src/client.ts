import { isSecurityScanProgress } from "./security-scan-progress";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import {
  parseRelayClaudeExecutionCapability,
  type RelayCapabilities,
} from "./types";
import type {
  RelayClientMessage,
  DesktopAutomationInvocationBinding,
  RelayServerMessage,
  RelayDispatchRequest,
  RelayDispatchResult,
  RelayMcpConfigureOperation,
  RelayMcpConfigureResultMessage,
  RelayMcpFailure,
  RelayMcpPreflightMessage,
  RelayMcpPreflightResultMessage,
  RelaySshPrepareFailureCode,
  RelaySshResolutionFailure,
  RelaySshInvocationSubjectV1,
  RelaySshPrepareRequestV1,
  RelaySshPrepareResponseV1,
  RelayStatus,
  RelayMcpServerConfig,
} from "./protocol";
import {
  parseRelayDesktopFilesystemGrantRequest,
  parseDesktopAutomationInvocationBinding,
  parseComputerUseHostDispatchRequest,
  parseRelaySshDispatchBinding,
  parseRelaySshPrepareRequest,
  parseRelaySshPrepareResponse,
  projectRelayCapabilitiesForProtocol,
  RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSION,
  RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION,
  RELAY_MCP_TRUTH_PROTOCOL_VERSION,
  RELAY_MCP_DISPATCH_PROVENANCE_PROTOCOL_VERSION,
  RELAY_SSH_PREPARE_PROTOCOL_VERSION,
  RELAY_RUN_SHELL_PROGRESS_PROTOCOL_VERSION,
  RELAY_BROWSER_PAGE_CONTINUATION_PROTOCOL_VERSION,
  RELAY_BROWSER_PAGE_SNAPSHOT_REFERENCE_PROTOCOL_VERSION,
  RELAY_RUN_SHELL_PROGRESS_MAX_TEXT_BYTES,
  RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION,
  RELAY_STRUCTURED_SSH_CONTINUATION_PROTOCOL_VERSION,
  RELAY_STRUCTURED_SSH_PROGRESS_MAX_TEXT_BYTES,
} from "./protocol";
import {
  parseRelayCodexJsonFrame,
  isRelayCodexCommandResponseForCommand,
  isCodexRelayProtocolVersion,
  type RelayCodexClientMessage,
  type RelayCodexCommandMessage,
  type RelayCodexServerMessage,
  type RelayRegisteredV8,
} from "./codex-protocol";
import {
  OPENCODE_ACP_RELAY_PROTOCOL_VERSION,
  parseRelayAcpJsonFrame,
  type AcpRegistrationId,
  type AcpSocketScope,
  type RelayAcpClientMessage,
  type RelayAcpReadinessCommand,
  type RelayAcpPrepareCommand,
  type RelayAcpStartCommand,
  type RelayAcpContainCommand,
} from "./acp-protocol";
import {
  CLAUDE_CONNECTION_PROTOCOL_VERSION,
  parseRelayClaudeConnectionDiscoverCommand,
  parseRelayClaudeConnectionDiscoveryResult,
  type RelayClaudeConnectionDiscoverCommand,
  type RelayClaudeConnectionDiscoveryResult,
  type RelayClaudeConnectionScope,
} from "./claude-connection-protocol";
import {
  CLAUDE_EXECUTION_PROTOCOL_VERSION,
  parseRelayClaudeExecutionCommand,
  parseRelayClaudeExecutionDesktopEvent,
  type RelayClaudeExecutionCommand,
  type RelayClaudeExecutionDesktopEvent,
  type RelayClaudeExecutionSocketScope,
} from "./claude-execution-protocol";
import {
  HEARTBEAT_INTERVAL_MS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  CODEX_RELAY_MAX_REPLAY_ENTRIES,
  CODEX_RELAY_REPLAY_CACHE_TTL_MS,
  RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE,
  RELAY_TOKEN_AUTH_CLOSE_CODE,
} from "./constants";

/** Terminal registration failure. A fresh client requires a newly paired token. */
export class RelayAuthenticationRequiredError extends Error {
  constructor() {
    super("Relay pairing is missing, invalid, or revoked");
    this.name = "RelayAuthenticationRequiredError";
  }
}

/** A tool discovered on a hosted MCP server, advertised back to the server. */
export interface RelayAdvertisedMcpTool {
  name: string;
  description?: string | undefined;
  inputSchema: unknown;
  /** MCP tool hints (readOnlyHint/destructiveHint/…) for server impact derivation. */
  annotations?: Record<string, unknown> | undefined;
}

/**
 * D384 Phase 5 — relay-side MCP hosting seam. The binary (headless
 * `bin/nautilo-relay` or Electron) constructs an `McpClientManager`-backed
 * adapter and passes it in; the shared relay client owns the wire protocol
 * (`relay:configure-mcp` in, `relay:advertise-mcp-tools` out) and routes
 * dispatches for hosted MCP tools here instead of `onDispatch`. Keeping the
 * adapter injected means `@nautilo/relay` never depends on
 * `@nautilo/mcp-client`.
 */
export interface RelayMcpHost {
  /** Reconcile the set of MCP servers to host (server→relay). Idempotent. */
  configure(servers: RelayMcpServerConfig[]): void | Promise<void>;
  /** D503 v12: local-only prerequisite report. It never returns env values. */
  preflight?(server: RelayMcpServerConfig): Promise<{
    status: "ready" | "blocked";
    machineLabel: string;
    launcher: "present" | "missing" | "not-applicable";
    environment: readonly { name: string; present: boolean }[];
    failure?: RelayMcpFailure | undefined;
  }>;
  /** D503 v12: reconcile the fleet and report the exact target outcome. */
  configureWithOutcome?(
    servers: RelayMcpServerConfig[],
    operation: RelayMcpConfigureOperation,
  ): Promise<{
    state: "connected" | "failed" | "stopped";
    toolNames: readonly string[];
    failure?: RelayMcpFailure | undefined;
  }>;
  /** True if `toolName` is a currently-hosted MCP tool (dispatch routing). */
  has(toolName: string): boolean;
  /** Execute a hosted MCP tool call. Never throws — returns an error result. */
  dispatch(toolName: string, args: Record<string, unknown>): Promise<RelayDispatchResult>;
  /**
   * Register a listener invoked whenever a hosted server's advertised tool
   * set changes (initial connect, `tools/list_changed`, or teardown → `[]`).
   * The client turns each callback into a `relay:advertise-mcp-tools` frame.
   */
  onToolsChanged(
    listener: (serverName: string, tools: RelayAdvertisedMcpTool[]) => void,
  ): void;
  /** Stop hosted local MCP processes on relay WebSocket loss when supported. */
  stop?(): Promise<void>;
}

/** D453 host seam. It deliberately has no generic dispatch/sandbox surface. */
export interface RelayCodexSession {
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly pairingGenerationRef: string;
  readonly desktopSessionId: string;
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
}

/** D516 — server-acknowledged topology exposed only to Electron main. */
export interface RelayDesktopTopology {
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
}

export interface RelayCodexHostTransport {
  /** Returns false until the v8 acknowledgement has established this session. */
  send(message: RelayCodexClientMessage): boolean;
}

export interface RelayCodexHostPort {
  /** Electron supplies this only after its real host implementation is ready. */
  isReady?(): boolean;
  onRegistered?(
    session: RelayCodexSession,
    transport: RelayCodexHostTransport,
  ): void | Promise<void>;
  onCommand?(message: Extract<RelayCodexServerMessage, { type: "relay:codex-command" }>): void | Promise<void>;
  onCancel?(message: Extract<RelayCodexServerMessage, { type: "relay:codex-cancel" }>): void | Promise<void>;
  onCredit?(message: Extract<RelayCodexServerMessage, { type: "relay:codex-credit" }>): void | Promise<void>;
  onRequestResponse?(message: Extract<RelayCodexServerMessage, { type: "relay:codex-request-response" }>): void | Promise<void>;
  onDisconnected?(): void;
}

/** D452 v14 Electron ACP seam. It carries typed commands and semantic data only. */
export type RelayAcpSession = AcpSocketScope;
export interface RelayAcpHostTransport {
  send(message: RelayAcpClientMessage): boolean;
}
export interface RelayAcpHostPort {
  isReady?(): boolean;
  /** Current canonical built-in subset advertised by this host. */
  registrations?(): readonly AcpRegistrationId[];
  onRegistered?(session: RelayAcpSession, transport: RelayAcpHostTransport): void | Promise<void>;
  onReadiness?(message: RelayAcpReadinessCommand): void | Promise<void>;
  onPrepare?(message: RelayAcpPrepareCommand): void | Promise<void>;
  onStart?(message: RelayAcpStartCommand): void | Promise<void>;
  onContain?(message: RelayAcpContainCommand): void | Promise<void>;
  onDisconnected?(): void | Promise<void>;
}

/** D452 v17 — injected Electron-only Claude Connections discovery seam. */
export type RelayClaudeConnectionSession = RelayClaudeConnectionScope;
export interface RelayClaudeConnectionHostTransport {
  send(message: RelayClaudeConnectionDiscoveryResult): boolean;
}
export interface RelayClaudeConnectionHostPort {
  isReady(): boolean;
  /** Synchronous installation closes the registered→discover race. */
  onRegistered(session: RelayClaudeConnectionSession, transport: RelayClaudeConnectionHostTransport): void;
  onDiscover(message: RelayClaudeConnectionDiscoverCommand): void;
  onDisconnected?(): void | Promise<void>;
}

/** D452 v18 — injected Desktop-local Claude execution forwarding seam. */
export type RelayClaudeExecutionSession = RelayClaudeExecutionSocketScope;
export interface RelayClaudeExecutionHostTransport {
  send(message: RelayClaudeExecutionDesktopEvent): boolean;
}
export interface RelayClaudeExecutionHostPort {
  isReady(): boolean;
  onRegistered(session: RelayClaudeExecutionSession, transport: RelayClaudeExecutionHostTransport): void;
  onCommand(message: RelayClaudeExecutionCommand): void | Promise<void>;
  onDisconnected?(): void | Promise<void>;
}

export interface RelayClientOptions {
  serverUrl: string;
  userId: string;
  capabilities: RelayCapabilities;
  relayId?: string;
  token?: string;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  onDispatch: (
    request: RelayDispatchRequest,
    signal: AbortSignal,
  ) => Promise<RelayDispatchResult>;
  /** D500 v13: Electron-local preparation of one exact SSH operation. */
  onSshPrepare?: (
    request: RelaySshPrepareRequestV1,
    signal: AbortSignal,
  ) => Promise<
    | { readonly ok: true; readonly response: RelaySshPrepareResponseV1 }
    | { readonly ok: false; readonly errorCode: RelaySshPrepareFailureCode; readonly failure?: RelaySshResolutionFailure | undefined }
  >;
  onStatusChange?: (status: RelayStatus) => void;
  /** Called once when the server rejects or revokes this client's token. */
  onAuthenticationRequired?: () => void | Promise<void>;
  /** D384 Phase 5 — optional relay-side MCP host (see {@link RelayMcpHost}). */
  mcpHost?: RelayMcpHost;
  /**
   * D418 protocol v7 — per Electron main-process-launch identity. When
   * provided, the register frame carries it and `updateCapabilities` is
   * enabled. Omitted by the headless relay, which cannot advertise
   * desktop-session capability state.
   */
  desktopSessionId?: string;
  /**
   * D418 protocol v7 — starting monotonic revision advertised at register.
   * Each `updateCapabilities` call sends a strictly greater revision.
   * Defaults to 0.
   */
  initialCapabilityRevision?: number;
  /**
   * D418 reconnect/session split-brain fix — dynamic capability source used
   * to build the `relay:register` frame on EVERY connect (initial AND
   * reconnect). When provided, the register frame advertises the CURRENT
   * capability state (including the live advisory grant / profile binding
   * snapshots) instead of the frozen `capabilities` value captured at
   * client construction. This is what prevents a reconnect from
   * re-registering frozen pre-activation capabilities and overwriting the
   * server relay registry's profile snapshot with null while a Full
   * Workstation session remains active. The desktop relay wires this to its
   * shared capability builder; the headless relay omits it and registers
   * the static `capabilities` value, byte-for-byte pre-D418. A throw is
   * treated as "use the static `capabilities` fallback" so a builder fault
   * never blocks registration.
   */
  getCapabilities?: () => RelayCapabilities | Promise<RelayCapabilities>;
  /** D516 — cleared on socket loss; never contains grant, PIN, or policy data. */
  onDesktopTopologyChange?: (topology: RelayDesktopTopology | null) => void;
  /** Optional Electron-owned Codex host. Headless callers omit this. */
  codexHostPort?: RelayCodexHostPort;
  /** Optional Electron-owned built-in ACP readiness host. */
  acpHostPort?: RelayAcpHostPort;
  /** D452 v17 — no SDK dependency here; Electron injects the host when available. */
  claudeConnectionHostPort?: RelayClaudeConnectionHostPort;
  /** D452 v18 — distinct from discovery; Desktop owns its active execution. */
  claudeExecutionHostPort?: RelayClaudeExecutionHostPort;
  /** Electron-local instance identity for D502 continuation owner binding. */
  runShellOwnerInstanceId?: string;
  /** Electron-local instance identity for D504 browser-page continuation. */
  browserPageOwnerInstanceId?: string;
}

export interface RelayClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): RelayStatus;
  getRelayId(): string;
  getDesktopTopology(): RelayDesktopTopology | null;
  /**
   * The capability revision last accepted by the active server socket.
   * This is null until registration is acknowledged, for headless relays,
   * and after socket loss or disconnect. It never exposes an in-flight send.
   */
  getAcknowledgedCapabilityRevision(): number | null;
  /**
   * D418 protocol v7 — atomically replace this relay's advertised capability
   * state on the server. Serializes and coalesces concurrent calls: only the
   * latest full `capabilities` object is sent, and partial capability state is
   * never merged. Resolves once the server acknowledges the applied revision.
   * Rejects if the server rejects the update or the socket is closed. No-op
   * (resolves immediately) when no `desktopSessionId` was configured.
   */
  updateCapabilities(capabilities: RelayCapabilities): Promise<void>;
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const relayId = options.relayId ?? randomUUID();
  const heartbeatMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const baseDelay = options.reconnectDelayMs ?? RECONNECT_BASE_DELAY_MS;
  const desktopSessionId = options.desktopSessionId;

  let ws: WebSocket | null = null;
  let status: RelayStatus = "disconnected";
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let intentionalDisconnect = false;
  let cancelPendingConnect: (() => void) | null = null;
  let nextSocketGeneration = 1;
  let activeSocketGeneration: number | null = null;
  // A close event is one local-MCP lifecycle boundary. Keep a bounded record
  // so an accidental duplicate event cannot enqueue a duplicate stop, while
  // every replacement socket still gets its own shutdown slot.
  const stoppedMcpHostSocketGenerations = new Set<number>();
  let negotiatedProtocolVersion = RELAY_MIN_SUPPORTED_PROTOCOL_VERSION;
  const pendingCancellers = new Map<string, AbortController>();
  // Never replay Codex work across a socket: the server gives every v8 socket
  // a fresh opaque session. The host receives a new transport only after ack.
  let authenticatedCodexSession: RelayCodexSession | null = null;
  let codexSession: RelayCodexSession | null = null;
  let acpSession: RelayAcpSession | null = null;
  let claudeConnectionSession: RelayClaudeConnectionSession | null = null;
  let claudeExecutionSession: RelayClaudeExecutionSession | null = null;
  let desktopTopology: RelayDesktopTopology | null = null;
  let registeredCapabilities = options.capabilities;
  type SocketRegistrationState = {
    revision: number | null;
    sent: boolean;
    acknowledged: boolean;
  };
  const isActiveSocket = (socket: WebSocket, socketGeneration: number): boolean =>
    ws === socket && activeSocketGeneration === socketGeneration;
  type CodexCacheEntry = {
    readonly fingerprint: string;
    readonly expiresAt: number;
    readonly command?: RelayCodexCommandMessage;
  };
  const inboundCodex = new Map<string, CodexCacheEntry>();
  const outboundCodex = new Map<string, CodexCacheEntry & { readonly message: RelayCodexClientMessage }>();
  const inboundAcpContainments = new Map<string, string>();
  type ClaudeDiscoveryEntry = {
    readonly fingerprint: string;
    readonly command: RelayClaudeConnectionDiscoverCommand;
    readonly expiresAt: number;
    result?: { readonly fingerprint: string; readonly message: RelayClaudeConnectionDiscoveryResult } | undefined;
  };
  const inboundClaudeDiscoveries = new Map<string, ClaudeDiscoveryEntry>();
  const pruneClaudeDiscoveries = () => {
    const now = Date.now();
    for (const [key, entry] of inboundClaudeDiscoveries) {
      if (entry.expiresAt <= now) inboundClaudeDiscoveries.delete(key);
    }
  };

  const clearCodexState = () => {
    inboundCodex.clear();
    outboundCodex.clear();
    inboundAcpContainments.clear();
  };
  const setDesktopTopology = (next: RelayDesktopTopology | null) => {
    const unchanged = desktopTopology !== null && next !== null
      && desktopTopology.relayId === next.relayId
      && desktopTopology.relaySessionId === next.relaySessionId
      && desktopTopology.pairingGeneration === next.pairingGeneration
      && desktopTopology.desktopSessionId === next.desktopSessionId
      && desktopTopology.selectedProtocolVersion === next.selectedProtocolVersion
      && desktopTopology.capabilityRevision === next.capabilityRevision;
    if (unchanged || (desktopTopology === null && next === null)) return;
    desktopTopology = next;
    try { options.onDesktopTopologyChange?.(next); } catch { /* observer only */ }
  };
  const pruneCodexState = () => {
    const now = Date.now();
    for (const [key, value] of inboundCodex) if (value.expiresAt <= now) inboundCodex.delete(key);
    for (const [key, value] of outboundCodex) if (value.expiresAt <= now) outboundCodex.delete(key);
  };
  const putCodex = <T>(map: Map<string, T>, key: string, value: T) => {
    if (map.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) {
      const oldest = map.keys().next().value;
      if (typeof oldest === "string") map.delete(oldest);
    }
    map.set(key, value);
  };
  const codexScopeKey = (scope: Record<string, unknown>) =>
    [
      "relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef",
      "selectedProtocolVersion", "capabilityRevision", "profileHandle",
      "profileGeneration", "accountGeneration", "runtimeGeneration",
      "childGeneration", "workspace", "bindingId", "bindingGeneration",
      "taskId", "jobId", "threadId", "turnId", "correlationId", "eventId",
      "itemId", "requestRef", "callRef",
    ]
      .filter((key) => Object.prototype.hasOwnProperty.call(scope, key))
      .map((key) => `${key}=${JSON.stringify(scope[key])}`)
      .join("&");
  const matchesCurrentCodexSocket = (scope: Record<string, unknown>) =>
    codexSession !== null &&
    scope["relayId"] === codexSession.relayId &&
    scope["relaySessionId"] === codexSession.relaySessionId &&
    scope["desktopSessionId"] === codexSession.desktopSessionId &&
    scope["pairingGenerationRef"] === codexSession.pairingGenerationRef &&
    scope["selectedProtocolVersion"] === codexSession.selectedProtocolVersion &&
    scope["capabilityRevision"] === codexSession.capabilityRevision;

  const matchesCurrentAcpSocket = (scope: Record<string, unknown>) =>
    acpSession !== null &&
    scope["relayId"] === acpSession.relayId &&
    scope["relaySessionId"] === acpSession.relaySessionId &&
    scope["desktopSessionId"] === acpSession.desktopSessionId &&
    scope["pairingGenerationRef"] === acpSession.pairingGenerationRef &&
    scope["selectedProtocolVersion"] === acpSession.selectedProtocolVersion &&
    scope["capabilityRevision"] === acpSession.capabilityRevision;
  const matchesCurrentClaudeConnectionSocket = (scope: Record<string, unknown>) =>
    claudeConnectionSession !== null &&
    scope["relayId"] === claudeConnectionSession.relayId &&
    scope["relaySessionId"] === claudeConnectionSession.relaySessionId &&
    scope["desktopSessionId"] === claudeConnectionSession.desktopSessionId &&
    scope["pairingGenerationRef"] === claudeConnectionSession.pairingGenerationRef &&
    scope["selectedProtocolVersion"] === claudeConnectionSession.selectedProtocolVersion &&
    scope["capabilityRevision"] === claudeConnectionSession.capabilityRevision;
  const matchesCurrentClaudeExecutionSocket = (scope: Record<string, unknown>) =>
    claudeExecutionSession !== null &&
    scope["relayId"] === claudeExecutionSession.relayId &&
    scope["relaySessionId"] === claudeExecutionSession.relaySessionId &&
    scope["desktopSessionId"] === claudeExecutionSession.desktopSessionId &&
    scope["pairingGenerationRef"] === claudeExecutionSession.pairingGenerationRef &&
    scope["selectedProtocolVersion"] === claudeExecutionSession.selectedProtocolVersion &&
    scope["capabilityRevision"] === claudeExecutionSession.capabilityRevision;
  const supportsCurrentAcpRegistration = (registrationId: string) =>
    registeredCapabilities.acp?.registrations.some((candidate) => candidate === registrationId) === true
    && (registrationId !== "opencode-acp"
      || (acpSession?.selectedProtocolVersion ?? 0) >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION);
  const supportsCurrentClaudeConnection = () =>
    registeredCapabilities.claude?.version === 1 &&
    registeredCapabilities.claude.hostKind === "electron" &&
    registeredCapabilities.claude.registrations.length === 1 &&
    registeredCapabilities.claude.registrations[0] === "claude-agent-sdk" &&
    (claudeConnectionSession?.selectedProtocolVersion ?? 0) >= CLAUDE_CONNECTION_PROTOCOL_VERSION;
  const supportsCurrentClaudeExecution = () =>
    registeredCapabilities.profile === "desktop-agent" &&
    parseRelayClaudeExecutionCapability(registeredCapabilities.claudeExecution).ok &&
    (claudeExecutionSession?.selectedProtocolVersion ?? 0) >= CLAUDE_EXECUTION_PROTOCOL_VERSION;
  // The server owns correlation UUIDs. A reuse on the same socket, even with
  // another profile, is a conflicting replay rather than fresh discovery.
  const claudeDiscoveryKey = (scope: RelayClaudeConnectionScope, correlationId: string) =>
    `${codexScopeKey(scope as unknown as Record<string, unknown>)}&correlationId=${JSON.stringify(correlationId)}`;

  const acpTransport: RelayAcpHostTransport = {
    send(message) {
      const socket = message.type === "relay:acp-started" || message.type === "relay:acp-start-failed" || message.type === "relay:acp-semantic" || message.type === "relay:acp-terminal"
        ? message.scope.socket
        : message.scope;
      if (status !== "connected" || !matchesCurrentAcpSocket(socket)
        || !supportsCurrentAcpRegistration(message.registrationId)) return false;
      const parsed = parseRelayAcpJsonFrame(JSON.stringify(message), "client");
      if (!parsed.ok) return false;
      send(parsed.value as RelayClientMessage);
      return true;
    },
  };

  const claudeConnectionTransport: RelayClaudeConnectionHostTransport = {
    send(message) {
      if (status !== "connected" || !supportsCurrentClaudeConnection()) return false;
      let parsed: RelayClaudeConnectionDiscoveryResult | null = null;
      let fingerprint = "";
      try {
        fingerprint = JSON.stringify(message);
        parsed = parseRelayClaudeConnectionDiscoveryResult(JSON.parse(fingerprint) as unknown);
      } catch {
        return false;
      }
      if (parsed === null || !matchesCurrentClaudeConnectionSocket(parsed.scope as unknown as Record<string, unknown>)) return false;
      pruneClaudeDiscoveries();
      const key = claudeDiscoveryKey(parsed.scope, parsed.correlationId);
      const pending = inboundClaudeDiscoveries.get(key);
      if (!pending || pending.command.correlationId !== parsed.correlationId || pending.command.profileRef !== parsed.profileRef) return false;
      if (pending.result !== undefined) {
        if (pending.result.fingerprint !== fingerprint) return false;
        send(pending.result.message as RelayClientMessage);
        return true;
      }
      inboundClaudeDiscoveries.set(key, { ...pending, result: { fingerprint, message: parsed } });
      send(parsed as RelayClientMessage);
      return true;
    },
  };

  const claudeExecutionTransport: RelayClaudeExecutionHostTransport = {
    send(message) {
      if (status !== "connected" || !supportsCurrentClaudeExecution()) return false;
      const parsed = parseRelayClaudeExecutionDesktopEvent(message);
      if (parsed === null || !matchesCurrentClaudeExecutionSocket(parsed.scope as unknown as Record<string, unknown>)) return false;
      try {
        send(parsed as RelayClientMessage);
        return true;
      } catch {
        deactivateClaudeExecutionHost();
        return false;
      }
    },
  };

  const codexTransport: RelayCodexHostTransport = {
    send(message) {
      reconcileCodexHost(registeredCapabilities);
      if (codexSession === null || status !== "connected") return false;
      const raw = JSON.stringify(message);
      const parsed = parseRelayCodexJsonFrame(raw, "client");
      if (!parsed.ok) return false;
      const socket = message.type === "relay:codex-status" ? message.socket : message.scope;
      const scoped = message.type === "relay:codex-status"
        ? { ...socket, capabilityRevision: message.capabilityRevision }
        : socket;
      if (!matchesCurrentCodexSocket(scoped as unknown as Record<string, unknown>)) return false;
      pruneCodexState();
      if (message.type === "relay:codex-command-response") {
        const key = `command:${message.commandId}`;
        const accepted = inboundCodex.get(key);
        if (
          !accepted?.command ||
          !isRelayCodexCommandResponseForCommand(accepted.command, message)
        ) return false;
        const prior = outboundCodex.get(key);
        if (prior) {
          if (prior.fingerprint !== raw) return false;
          send(prior.message as RelayClientMessage);
          return true;
        }
        putCodex(outboundCodex, key, {
          fingerprint: raw,
          message,
          expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS,
        });
      }
      send(parsed.value as RelayClientMessage);
      return true;
    },
  };

  // D418 protocol v7 — the issued revision stays monotonic across reconnects
  // because the server rejects stale/duplicate revisions. It is deliberately
  // separate from acknowledgedCapabilityRevision: callers may only observe
  // the latter as server truth.
  let issuedCapabilityRevision = options.initialCapabilityRevision ?? 0;
  let acknowledgedCapabilityRevision: number | null = null;
  interface PendingCapabilityUpdate {
    capabilities: RelayCapabilities;
    resolve: () => void;
    reject: (error: Error) => void;
  }
  let capabilityUpdateQueue: PendingCapabilityUpdate[] = [];
  let capabilityUpdateInFlight: Promise<void> | null = null;
  // Resolves the in-flight update once the matching ack arrives.
  let capabilityAckResolver: {
    revision: number;
    socketGeneration: number;
    capabilities: RelayCapabilities;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  function isCodexHostReady(): boolean {
    try {
      return options.codexHostPort?.isReady?.() === true;
    } catch {
      return false;
    }
  }

  function deactivateCodexHost(): void {
    const wasActive = codexSession !== null;
    codexSession = null;
    clearCodexState();
    if (wasActive) {
      try {
        options.codexHostPort?.onDisconnected?.();
      } catch {
        // A host callback cannot destabilize the relay transport.
      }
    }
  }

  function reconcileCodexHost(capabilities: RelayCapabilities): void {
    const authenticated = authenticatedCodexSession;
    const acknowledgedRevision = acknowledgedCapabilityRevision;
    if (
      authenticated === null ||
      acknowledgedRevision === null ||
      capabilities.codex?.hostKind !== "electron" ||
      !isCodexHostReady()
    ) {
      deactivateCodexHost();
      return;
    }
    const next = { ...authenticated, capabilityRevision: acknowledgedRevision };
    const unchanged = codexSession !== null &&
      codexSession.relaySessionId === next.relaySessionId &&
      codexSession.capabilityRevision === next.capabilityRevision;
    if (unchanged) return;
    codexSession = next;
    clearCodexState();
    try {
      const registered = options.codexHostPort?.onRegistered?.(next, codexTransport);
      if (registered && typeof registered === "object" && "then" in registered) {
        void registered.catch(() => undefined);
      }
    } catch {
      deactivateCodexHost();
    }
  }

  function reconcileAcpHost(capabilities: RelayCapabilities): void {
    const registered = authenticatedCodexSession;
    const acknowledgedRevision = acknowledgedCapabilityRevision;
    let ready = false;
    try { ready = options.acpHostPort?.isReady?.() === true; } catch { ready = false; }
    if (
      registered === null ||
      acknowledgedRevision === null ||
      capabilities.acp?.hostKind !== "electron" ||
      !ready
    ) {
      if (acpSession !== null) {
        acpSession = null;
        try { void Promise.resolve(options.acpHostPort?.onDisconnected?.()).catch(() => undefined); } catch { /* host callback is isolated */ }
      }
      return;
    }
    const next: RelayAcpSession = { ...registered, capabilityRevision: acknowledgedRevision };
    if (acpSession !== null && acpSession.relaySessionId === next.relaySessionId && acpSession.capabilityRevision === next.capabilityRevision) return;
    acpSession = next;
    try {
      const result = options.acpHostPort?.onRegistered?.(next, acpTransport);
      if (result && typeof result === "object" && "then" in result) void result.catch(() => undefined);
    } catch {
      acpSession = null;
    }
  }

  function deactivateClaudeConnectionHost(): void {
    const wasActive = claudeConnectionSession !== null;
    claudeConnectionSession = null;
    inboundClaudeDiscoveries.clear();
    if (wasActive) {
      try { void Promise.resolve(options.claudeConnectionHostPort?.onDisconnected?.()).catch(() => undefined); } catch { /* host callback is isolated */ }
    }
  }

  function reconcileClaudeConnectionHost(capabilities: RelayCapabilities): void {
    const authenticated = authenticatedCodexSession;
    const acknowledgedRevision = acknowledgedCapabilityRevision;
    const port = options.claudeConnectionHostPort;
    let ready = false;
    try { ready = port?.isReady() === true; } catch { ready = false; }
    if (
      authenticated === null ||
      acknowledgedRevision === null ||
      authenticated.selectedProtocolVersion < CLAUDE_CONNECTION_PROTOCOL_VERSION ||
      capabilities.claude?.version !== 1 ||
      capabilities.claude.hostKind !== "electron" ||
      capabilities.claude.registrations.length !== 1 ||
      capabilities.claude.registrations[0] !== "claude-agent-sdk" ||
      !ready
    ) {
      deactivateClaudeConnectionHost();
      return;
    }
    const next: RelayClaudeConnectionSession = Object.freeze({
      ...authenticated,
      capabilityRevision: acknowledgedRevision,
    });
    if (
      claudeConnectionSession !== null &&
      claudeConnectionSession.relaySessionId === next.relaySessionId &&
      claudeConnectionSession.capabilityRevision === next.capabilityRevision
    ) return;
    claudeConnectionSession = next;
    inboundClaudeDiscoveries.clear();
    try {
      port?.onRegistered(Object.freeze({ ...next }), claudeConnectionTransport);
    } catch {
      deactivateClaudeConnectionHost();
    }
  }

  function deactivateClaudeExecutionHost(): void {
    const wasActive = claudeExecutionSession !== null;
    claudeExecutionSession = null;
    if (wasActive) {
      try {
        void Promise.resolve(options.claudeExecutionHostPort?.onDisconnected?.()).catch(() => undefined);
      } catch {
        // An injected host cannot destabilize the socket.
      }
    }
  }

  function sameClaudeExecutionSession(
    left: RelayClaudeExecutionSession,
    right: RelayClaudeExecutionSession,
  ): boolean {
    return left.relayId === right.relayId &&
      left.relaySessionId === right.relaySessionId &&
      left.desktopSessionId === right.desktopSessionId &&
      left.pairingGenerationRef === right.pairingGenerationRef &&
      left.selectedProtocolVersion === right.selectedProtocolVersion &&
      left.capabilityRevision === right.capabilityRevision;
  }

  function reconcileClaudeExecutionHost(capabilities: RelayCapabilities): void {
    const authenticated = authenticatedCodexSession;
    const acknowledgedRevision = acknowledgedCapabilityRevision;
    const port = options.claudeExecutionHostPort;
    let ready = false;
    try { ready = port?.isReady() === true; } catch { ready = false; }
    if (
      authenticated === null ||
      acknowledgedRevision === null ||
      authenticated.selectedProtocolVersion < CLAUDE_EXECUTION_PROTOCOL_VERSION ||
      capabilities.profile !== "desktop-agent" ||
      !parseRelayClaudeExecutionCapability(capabilities.claudeExecution).ok ||
      !ready
    ) {
      deactivateClaudeExecutionHost();
      return;
    }
    const next: RelayClaudeExecutionSession = Object.freeze({
      ...authenticated,
      capabilityRevision: acknowledgedRevision,
    });
    if (claudeExecutionSession !== null && sameClaudeExecutionSession(claudeExecutionSession, next)) return;
    deactivateClaudeExecutionHost();
    claudeExecutionSession = next;
    try {
      port?.onRegistered(Object.freeze({ ...next }), claudeExecutionTransport);
    } catch {
      deactivateClaudeExecutionHost();
    }
  }

  function setStatus(next: RelayStatus) {
    if (next === status) return;
    status = next;
    options.onStatusChange?.(next);
  }

  let authenticationRequiredNotified = false;
  function markAuthenticationRequired(): void {
    setStatus("error");
    if (authenticationRequiredNotified) return;
    authenticationRequiredNotified = true;
    try {
      void Promise.resolve(options.onAuthenticationRequired?.()).catch(() => undefined);
    } catch {
      // A consumer callback cannot destabilize transport retirement.
    }
  }

  function send(msg: RelayClientMessage) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    if (msg.type !== "relay:heartbeat") {
      console.warn(`[relay] socket not open; dropped message type=${msg.type}`);
    }
  }

  function isBoundedMcpCorrelation(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 160;
  }

  function isValidMcpOperation(value: unknown): value is RelayMcpConfigureOperation {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const raw = value as Record<string, unknown>;
    return (
      isBoundedMcpCorrelation(raw["operationId"]) &&
      isBoundedMcpCorrelation(raw["digest"]) &&
      isBoundedMcpCorrelation(raw["targetName"]) &&
      (raw["phase"] === "start" || raw["phase"] === "rollback")
    );
  }

  function isValidMcpPreflight(msg: RelayMcpPreflightMessage): boolean {
    return (
      isBoundedMcpCorrelation(msg.requestId) &&
      isBoundedMcpCorrelation(msg.digest) &&
      typeof msg.server === "object" &&
      msg.server !== null &&
      isBoundedMcpCorrelation(msg.server.name)
    );
  }

  function unavailableMcpFailure(): RelayMcpFailure {
    return { code: "protocol_failed" };
  }

  const relayMcpFailureCodes = new Set<RelayMcpFailure["code"]>([
    "invalid_request",
    "missing_launcher",
    "missing_environment",
    "spawn_failed",
    "protocol_failed",
    "discovery_timeout",
    "empty_toolset",
    "internal",
  ]);

  /**
   * A relay host is local, but its result still crosses a trust boundary. Copy
   * only the fixed failure category into the frame: in particular, never let
   * an Error instance, its message, or an extension property traverse the
   * WebSocket by accident.
   */
  function safeMcpFailure(value: unknown): RelayMcpFailure | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { code: "internal" };
    }
    const code = (value as { code?: unknown }).code;
    return typeof code === "string" && relayMcpFailureCodes.has(code as RelayMcpFailure["code"])
      ? { code: code as RelayMcpFailure["code"] }
      : { code: "internal" };
  }

  let mcpHostOperationTail: Promise<void> = Promise.resolve();
  function serializeMcpHostOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = mcpHostOperationTail.then(operation, operation);
    mcpHostOperationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function handleMcpPreflight(msg: RelayMcpPreflightMessage): Promise<void> {
    if (negotiatedProtocolVersion < RELAY_MCP_TRUTH_PROTOCOL_VERSION || !isValidMcpPreflight(msg)) {
      return;
    }
    const host = options.mcpHost;
    const report = host?.preflight
      ? await serializeMcpHostOperation(() => host.preflight!(msg.server)).catch(() => ({
          status: "blocked" as const,
          machineLabel: "This Desktop",
          launcher: "not-applicable" as const,
          environment: [],
          failure: unavailableMcpFailure(),
        }))
      : {
          status: "blocked" as const,
          machineLabel: "This Desktop",
          launcher: "not-applicable" as const,
          environment: [],
          failure: unavailableMcpFailure(),
        };
    const reportFailure = safeMcpFailure(report.failure);
    const result: RelayMcpPreflightResultMessage = {
      type: "relay:mcp-preflight-result",
      requestId: msg.requestId,
      digest: msg.digest,
      targetName: msg.server.name,
      status: report.status,
      machineLabel: report.machineLabel,
      launcher: report.launcher,
      environment: report.environment.map((entry) => ({ name: entry.name, present: entry.present })),
      ...(reportFailure !== undefined ? { failure: reportFailure } : {}),
    };
    send(result);
  }

  async function handleMcpConfigure(
    servers: RelayMcpServerConfig[],
    operation: RelayMcpConfigureOperation,
  ): Promise<void> {
    const host = options.mcpHost;
    const outcome = host?.configureWithOutcome
      ? await serializeMcpHostOperation(() => host.configureWithOutcome!(servers, operation)).catch(() => ({
          state: "failed" as const,
          toolNames: [],
          failure: unavailableMcpFailure(),
        }))
      : {
          state: "failed" as const,
          toolNames: [],
          failure: unavailableMcpFailure(),
        };
    const outcomeFailure = safeMcpFailure(outcome.failure);
    const result: RelayMcpConfigureResultMessage = {
      type: "relay:mcp-configure-result",
      operationId: operation.operationId,
      digest: operation.digest,
      targetName: operation.targetName,
      state: outcome.state,
      toolNames: [...outcome.toolNames],
      ...(outcomeFailure !== undefined ? { failure: outcomeFailure } : {}),
    };
    send(result);
  }

  function stopHostedMcpsForSocketLoss(socketGeneration: number): void {
    const host = options.mcpHost;
    if (!host?.stop || stoppedMcpHostSocketGenerations.has(socketGeneration)) return;
    stoppedMcpHostSocketGenerations.add(socketGeneration);
    if (stoppedMcpHostSocketGenerations.size > 128) {
      const oldest = stoppedMcpHostSocketGenerations.values().next().value;
      if (typeof oldest === "number") stoppedMcpHostSocketGenerations.delete(oldest);
    }
    // This deliberately queues behind any reconnect configure. If that
    // reconnect socket then closes while an earlier stop is blocked, its stop
    // remains queued after configure and cannot be lost.
    void serializeMcpHostOperation(() => host.stop!()).catch(() => undefined);
  }

  function rejectMalformedDesktopFilesystemGrantRequest(correlationId: string, error: string): void {
    send({
      type: "relay:result",
      correlationId,
      status: "error",
      error: `Malformed Desktop Filesystem Grant request: ${error}`,
      errorCode: "DESKTOP_FILESYSTEM_GRANT_REQUEST_INVALID",
    });
  }

  function rejectMalformedSshDispatchBinding(correlationId: string): void {
    send({
      type: "relay:result",
      correlationId,
      status: "error",
      error: "Malformed structured SSH binding.",
      errorCode: "STRUCTURED_SSH_BINDING_INVALID",
    });
  }

  function rejectStaleSshDispatchBinding(correlationId: string): void {
    send({
      type: "relay:result",
      correlationId,
      status: "error",
      error: "Structured SSH socket topology is stale.",
      errorCode: "STRUCTURED_SSH_BINDING_STALE",
    });
  }

  function rejectMalformedDesktopAutomationBinding(correlationId: string): void {
    send({
      type: "relay:result",
      correlationId,
      status: "error",
      error: "Malformed desktop automation binding.",
      errorCode: "DESKTOP_AUTOMATION_BINDING_INVALID",
    });
  }

  function rejectStaleDesktopAutomationBinding(correlationId: string): void {
    send({
      type: "relay:result",
      correlationId,
      status: "error",
      error: "Desktop automation binding does not match this relay session.",
      errorCode: "DESKTOP_AUTOMATION_BINDING_STALE",
    });
  }

  function sendSshPrepareFailure(requestId: string, errorCode: RelaySshPrepareFailureCode, failure?: RelaySshResolutionFailure): void {
    send({ type: "relay:ssh-prepared", requestId, status: "error", errorCode, ...(failure === undefined ? {} : { failure }) });
  }

  function sameSshPrepareRequest(
    request: RelaySshPrepareRequestV1,
    response: RelaySshPrepareResponseV1,
  ): boolean {
    return request.requestId === response.requestId &&
      request.toolCallId === response.toolCallId &&
      request.approvedRequestDigest === response.approvedRequestDigest &&
      request.operation === response.operation &&
      request.subject.instanceId === response.subject.instanceId &&
      request.subject.userId === response.subject.userId &&
      request.subject.actorId === response.subject.actorId &&
      request.subject.actorRole === response.subject.actorRole &&
      request.subject.agentId === response.subject.agentId &&
      request.subject.executionEntrypoint === response.subject.executionEntrypoint &&
      request.subject.relayId === response.subject.relayId &&
      request.subject.relaySessionId === response.subject.relaySessionId &&
      request.subject.desktopSessionId === response.subject.desktopSessionId &&
      request.subject.pairingGenerationRef === response.subject.pairingGenerationRef &&
      request.subject.capabilityRevision === response.subject.capabilityRevision;
  }

  /** The SSH prepare/final seam is valid only for this authenticated socket. */
  function matchesAuthenticatedSshSocket(subject: RelaySshInvocationSubjectV1): boolean {
    const session = authenticatedCodexSession;
    const acknowledgedRevision = acknowledgedCapabilityRevision;
    return status === "connected" &&
      negotiatedProtocolVersion >= RELAY_SSH_PREPARE_PROTOCOL_VERSION &&
      session !== null &&
      acknowledgedRevision !== null &&
      subject.relayId === session.relayId &&
      subject.relaySessionId === session.relaySessionId &&
      subject.desktopSessionId === session.desktopSessionId &&
      subject.pairingGenerationRef === session.pairingGenerationRef &&
      subject.capabilityRevision === acknowledgedRevision;
  }

  /** D516 — desktop effects require the exact current local relay topology. */
  function matchesCurrentDesktopAutomationBinding(
    binding: DesktopAutomationInvocationBinding,
  ): boolean {
    const session = authenticatedCodexSession;
    return (
      status === "connected"
      && desktopSessionId !== undefined
      && session !== null
      && binding.originHumanId === options.userId
      && binding.relayId === relayId
      && binding.relayId === session.relayId
      && binding.desktopSessionId === desktopSessionId
      && binding.desktopSessionId === session.desktopSessionId
      && binding.pairingGeneration === session.pairingGenerationRef
    );
  }

  async function handleSshPrepare(msg: Extract<RelayServerMessage, { type: "relay:ssh-prepare" }>): Promise<void> {
    const rawRequestId = typeof msg.request === "object" && msg.request !== null
      ? (msg.request as { requestId?: unknown }).requestId
      : undefined;
    const parsed = parseRelaySshPrepareRequest(msg.request);
    if (!parsed.ok) {
      if (typeof rawRequestId === "string" && rawRequestId.length > 0 && rawRequestId.length <= 256) {
        sendSshPrepareFailure(rawRequestId, "invalid_request");
      }
      return;
    }
    if (negotiatedProtocolVersion < RELAY_SSH_PREPARE_PROTOCOL_VERSION || !options.onSshPrepare) {
      sendSshPrepareFailure(parsed.request.requestId, "prepare_unavailable");
      return;
    }
    if (!matchesAuthenticatedSshSocket(parsed.request.subject)) {
      sendSshPrepareFailure(parsed.request.requestId, "topology_mismatch");
      return;
    }
    const controller = new AbortController();
    let result: Awaited<ReturnType<NonNullable<RelayClientOptions["onSshPrepare"]>>>;
    try {
      result = await options.onSshPrepare(parsed.request, controller.signal);
    } catch {
      sendSshPrepareFailure(parsed.request.requestId, "prepare_unavailable");
      return;
    }
    if (!result.ok) {
      sendSshPrepareFailure(parsed.request.requestId, result.errorCode, result.failure);
      return;
    }
    const response = parseRelaySshPrepareResponse(result.response);
    if (!response.ok || !sameSshPrepareRequest(parsed.request, response.response)) {
      sendSshPrepareFailure(parsed.request.requestId, "preparation_unavailable");
      return;
    }
    send({ type: "relay:ssh-prepared", requestId: parsed.request.requestId, status: "ok", response: response.response });
  }

  // D384 Phase 5 — turn hosted-MCP tool-set changes into advertise frames.
  // Registered once; fires on connect, tools/list_changed, and teardown ([]).
  options.mcpHost?.onToolsChanged((serverName, tools) => {
    send({ type: "relay:advertise-mcp-tools", serverName, tools });
  });

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      send({ type: "relay:heartbeat", relayId });
    }, heartbeatMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect() {
    if (intentionalDisconnect) return;
    const jitter = Math.random() * 1000;
    const delay = Math.min(
      baseDelay * Math.pow(2, reconnectAttempt) + jitter,
      RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectInternal().catch(() => undefined);
    }, delay);
  }

  function cancelReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  // D418 protocol v7 — reject the in-flight capability update (if any) and
  // drain + reject any queued updates when the socket drops or the client
  // disconnects, so callers don't hang on acks that will never arrive.
  function abortCapabilityUpdates(error: Error): void {
    if (capabilityAckResolver !== null) {
      const r = capabilityAckResolver;
      capabilityAckResolver = null;
      r.reject(error);
    }
    const drained = capabilityUpdateQueue;
    capabilityUpdateQueue = [];
    for (const entry of drained) entry.reject(error);
  }

  // Serialize + coalesce capability updates. Only one update is ever in
  // flight; when multiple are queued, drain the queue and send only the
  // LATEST full capabilities. We never merge partial capability state —
  // each sent frame is a complete replacement drawn from a single caller's
  // `capabilities` argument. Setup (drain + ack resolver) is synchronous so
  // `abortCapabilityUpdates` can always observe and cancel the in-flight
  // update even if the socket closes before the async await yields.
  function pumpCapabilityUpdates(): void {
    if (capabilityUpdateInFlight !== null) return;
    if (capabilityUpdateQueue.length === 0) return;
    const batch = capabilityUpdateQueue;
    capabilityUpdateQueue = [];
    const latest = batch[batch.length - 1]!;
    issuedCapabilityRevision += 1;
    const revision = issuedCapabilityRevision;
    let resolveAck!: () => void;
    let rejectAck!: (error: Error) => void;
    const ackPromise = new Promise<void>((resolve, reject) => {
      resolveAck = resolve;
      rejectAck = reject;
    });
    capabilityAckResolver = {
      revision,
      socketGeneration: activeSocketGeneration ?? -1,
      capabilities: latest.capabilities,
      resolve: resolveAck,
      reject: rejectAck,
    };
    capabilityUpdateInFlight = (async () => {
      try {
        send({
          type: "relay:update-capabilities",
          relayId,
          desktopSessionId: desktopSessionId ?? "",
          capabilityRevision: revision,
          capabilities: projectRelayCapabilitiesForProtocol(
            latest.capabilities,
            negotiatedProtocolVersion,
          ),
        });
        await ackPromise;
        for (const entry of batch) entry.resolve();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const entry of batch) entry.reject(error);
      } finally {
        capabilityUpdateInFlight = null;
        if (capabilityUpdateQueue.length > 0 && status === "connected") {
          pumpCapabilityUpdates();
        }
      }
    })();
  }

  async function handleDispatch(msg: RelayServerMessage & { type: "relay:dispatch" }) {
    const parsedDesktopFilesystemGrantRequest =
      msg.desktopFilesystemGrantRequest === undefined
        ? undefined
        : parseRelayDesktopFilesystemGrantRequest(msg.desktopFilesystemGrantRequest);
    if (parsedDesktopFilesystemGrantRequest !== undefined && !parsedDesktopFilesystemGrantRequest.ok) {
      rejectMalformedDesktopFilesystemGrantRequest(msg.correlationId, parsedDesktopFilesystemGrantRequest.error);
      return;
    }
    const parsedSshBinding =
      msg.sshBinding === undefined
        ? undefined
        : parseRelaySshDispatchBinding(msg.sshBinding);
    if (parsedSshBinding !== undefined && !parsedSshBinding.ok) {
      rejectMalformedSshDispatchBinding(msg.correlationId);
      return;
    }
    const touchesStructuredSsh =
      msg.toolName === "ssh" ||
      msg.executionClass === "structured-ssh" ||
      msg.sshBinding !== undefined;
    if (
      touchesStructuredSsh &&
      (msg.toolName !== "ssh" ||
        msg.executionClass !== "structured-ssh" ||
        msg.approvalObtained !== true ||
        parsedSshBinding === undefined ||
        !parsedSshBinding.ok ||
        msg.args["operation"] !== parsedSshBinding.binding.operation)
    ) {
      rejectMalformedSshDispatchBinding(msg.correlationId);
      return;
    }
    // Prepare and final dispatch are both bound to this authenticated socket;
    // a reconnect, re-pair, or capability update must never reuse a prior
    // Electron-local preparation.
    if (touchesStructuredSsh) {
      // The prior shape gate establishes this tuple; keep the explicit guard
      // here so an edit cannot turn a missing binding into an unchecked final.
      if (parsedSshBinding === undefined || !parsedSshBinding.ok) {
        rejectMalformedSshDispatchBinding(msg.correlationId);
        return;
      }
      if (!matchesAuthenticatedSshSocket(parsedSshBinding.binding.subject)) {
        rejectStaleSshDispatchBinding(msg.correlationId);
        return;
      }
    }

    // The fixed computer_use class selects the one generic Computer Use lane.
    // Tool names remain opaque at this boundary: the admitted catalogue and
    // Electron's provider-owned operation descriptor decide whether a named
    // operation is executable. This means a future catalogue tool never
    // needs a client/router name-list edit.
    const parsedDesktopAutomationBinding =
      msg.desktopAutomationBinding === undefined
        ? undefined
        : parseDesktopAutomationInvocationBinding(msg.desktopAutomationBinding);
    if (parsedDesktopAutomationBinding !== undefined && !parsedDesktopAutomationBinding.ok) {
      rejectMalformedDesktopAutomationBinding(msg.correlationId);
      return;
    }
    const parsedComputerUseRequestRaw = msg.computerUseRequest === undefined
      ? undefined
      : parseComputerUseHostDispatchRequest(msg.computerUseRequest);
    if (parsedComputerUseRequestRaw === null) {
      rejectMalformedDesktopAutomationBinding(msg.correlationId);
      return;
    }
    const parsedComputerUseRequest = parsedComputerUseRequestRaw;
    const isComputerUseDispatch = msg.executionClass === "computer_use";
    if (isComputerUseDispatch
      && negotiatedProtocolVersion < RELAY_COMPUTER_USE_SEMANTIC_PROTOCOL_VERSION) {
      rejectMalformedDesktopAutomationBinding(msg.correlationId);
      return;
    }
    if (
      (isComputerUseDispatch && (parsedDesktopAutomationBinding === undefined || parsedComputerUseRequest === undefined))
      || (!isComputerUseDispatch && (parsedDesktopAutomationBinding !== undefined || parsedComputerUseRequest !== undefined))
    ) {
      rejectMalformedDesktopAutomationBinding(msg.correlationId);
      return;
    }
    if (
      parsedDesktopAutomationBinding !== undefined
      && !matchesCurrentDesktopAutomationBinding(parsedDesktopAutomationBinding.binding)
    ) {
      rejectStaleDesktopAutomationBinding(msg.correlationId);
      return;
    }

    const isBrowserPageRead = msg.toolName === "browser_read_page" || msg.toolName === "browser_research_read";
    const canContinueBrowserPageRead =
      isBrowserPageRead &&
      negotiatedProtocolVersion >= RELAY_BROWSER_PAGE_CONTINUATION_PROTOCOL_VERSION &&
      registeredCapabilities.canContinueBrowserPageRead === true;
    const canPublishBrowserPageReference =
      canContinueBrowserPageRead &&
      negotiatedProtocolVersion >= RELAY_BROWSER_PAGE_SNAPSHOT_REFERENCE_PROTOCOL_VERSION &&
      registeredCapabilities.canInspectBrowserPageSnapshot === true;
    const request: RelayDispatchRequest = {
      correlationId: msg.correlationId,
      toolName: msg.toolName,
      args: msg.args,
      timeout: msg.timeout,
      impact: msg.impact,
      approvalObtained: msg.approvalObtained,
      ...(msg.hostedBy !== undefined ? { hostedBy: msg.hostedBy } : {}),
      allowedRoots: msg.allowedRoots,
      ...(parsedDesktopFilesystemGrantRequest !== undefined
        ? { desktopFilesystemGrantRequest: parsedDesktopFilesystemGrantRequest.request }
        : {}),
      ...(parsedSshBinding !== undefined ? { sshBinding: parsedSshBinding.binding } : {}),
      ...(parsedDesktopAutomationBinding !== undefined
        ? { desktopAutomationBinding: parsedDesktopAutomationBinding.binding }
        : {}),
      ...(parsedComputerUseRequest !== undefined ? { computerUseRequest: parsedComputerUseRequest } : {}),
      workstationShellBinding: msg.workstationShellBinding,
      uncontainedHostCommandsSession: msg.uncontainedHostCommandsSession,
      sandboxProfile: msg.sandboxProfile,
      executionClass: msg.executionClass,
      ...(msg.toolName === "security_scan" ? {
        reportSecurityScanProgress: (progress) => {
          if (isSecurityScanProgress(progress)) send({ ...progress, type: "relay:security-scan-progress", correlationId: msg.correlationId });
        },
      } : {}),
      // D502: this is intentionally a run_shell-only local callback, not a
      // generic streaming hook. The Electron child supervisor remains free to
      // drain pipes while this best-effort websocket observation is coalesced.
      ...(msg.toolName === "run_shell" && negotiatedProtocolVersion >= RELAY_RUN_SHELL_PROGRESS_PROTOCOL_VERSION
        ? {
            runShellOwnerBinding: {
              instanceId: options.runShellOwnerInstanceId ?? "",
              userId: options.userId,
              relayId,
              desktopSessionId: desktopSessionId ?? null,
            },
            reportRunShellProgress: (progress) => {
              if (
                progress.version !== 1 ||
                !Number.isSafeInteger(progress.sequence) ||
                progress.sequence < 0 ||
                !Number.isSafeInteger(progress.offsetBytes) ||
                progress.offsetBytes < 0 ||
                !Number.isSafeInteger(progress.endOffsetBytes) ||
                progress.endOffsetBytes < progress.offsetBytes ||
                (progress.stream !== "stdout" && progress.stream !== "stderr") ||
                progress.phase !== "running" ||
                Buffer.byteLength(progress.text, "utf8") > RELAY_RUN_SHELL_PROGRESS_MAX_TEXT_BYTES
              ) {
                return;
              }
              send({
                type: "relay:run-shell-progress",
                correlationId: msg.correlationId,
                ...progress,
              });
            },
          }
        : {}),
      ...((msg.toolName === "structured_ssh_output" || msg.toolName === "ssh") &&
        negotiatedProtocolVersion >= RELAY_STRUCTURED_SSH_CONTINUATION_PROTOCOL_VERSION
        ? {
            structuredSshOutputOwnerBinding: {
              instanceId: options.runShellOwnerInstanceId ?? "",
              userId: options.userId,
              relayId,
              desktopSessionId: desktopSessionId ?? null,
            },
          }
        : {}),
      ...(canContinueBrowserPageRead
        ? {
            browserPageOwnerBinding: {
              instanceId: options.browserPageOwnerInstanceId ?? "",
              userId: options.userId,
              relayId,
              desktopSessionId: desktopSessionId ?? null,
            },
          }
        : {}),
      // D500 v15: Structured SSH has its own bounded observation channel. It
      // is deliberately not a generic process stream and only exists for an
      // exact already-authorized structured SSH dispatch on a negotiated peer.
      ...(msg.toolName === "ssh" && msg.executionClass === "structured-ssh" &&
        parsedSshBinding !== undefined && parsedSshBinding.binding.operation !== "auth" &&
        negotiatedProtocolVersion >= RELAY_STRUCTURED_SSH_PROGRESS_PROTOCOL_VERSION
        ? {
            reportStructuredSshProgress: (progress) => {
              if (
                progress.version !== 1 ||
                !Number.isSafeInteger(progress.sequence) || progress.sequence < 0 ||
                !Number.isSafeInteger(progress.elapsedMs) || progress.elapsedMs < 0 ||
                progress.operation !== parsedSshBinding.binding.operation ||
                (progress.operation === "exec" && progress.kind !== "exec-output") ||
                ((progress.operation === "copy-upload" || progress.operation === "copy-download") && progress.kind !== "transfer")
              ) return;
              if (progress.kind === "exec-output") {
                const textBytes = Buffer.byteLength(progress.text, "utf8");
                const droppedBytes = progress.droppedBytes ?? 0;
                if (
                  (progress.stream !== "stdout" && progress.stream !== "stderr") ||
                  !Number.isSafeInteger(progress.offsetBytes) || progress.offsetBytes < 0 ||
                  !Number.isSafeInteger(progress.endOffsetBytes) || progress.endOffsetBytes < progress.offsetBytes ||
                  progress.phase !== "running" ||
                  textBytes > RELAY_STRUCTURED_SSH_PROGRESS_MAX_TEXT_BYTES ||
                  !Number.isSafeInteger(droppedBytes) || droppedBytes < 0 ||
                  progress.endOffsetBytes !== progress.offsetBytes + textBytes + droppedBytes
                ) return;
              } else if (
                progress.kind !== "transfer" ||
                (progress.phase !== "starting" && progress.phase !== "transferring") ||
                !Number.isSafeInteger(progress.transferredBytes) || progress.transferredBytes < 0 ||
                (progress.totalBytes !== undefined &&
                  (!Number.isSafeInteger(progress.totalBytes) || progress.totalBytes < progress.transferredBytes))
              ) return;
              send({
                type: "relay:structured-ssh-progress",
                correlationId: msg.correlationId,
                ...progress,
              });
            },
          }
        : {}),
      ...(canPublishBrowserPageReference
        ? { browserPageSnapshotReferencePublication: true }
        : {}),
    };

    const ac = new AbortController();
    pendingCancellers.set(msg.correlationId, ac);
    const start = Date.now();

    // D384/D565 — hosted MCP tools route to the McpClientManager only when
    // v19 binds the request to this exact Relay. Tool-name discovery alone is
    // never dispatch authority and cannot shadow a built-in on current peers.
    // Pre-v19 compatibility retains the legacy name route until both peers
    // negotiate the provenance contract.
    const mcpHost = options.mcpHost;
    const hasHostedMcpTool = mcpHost?.has(request.toolName) === true;
    const requiresMcpProvenance =
      negotiatedProtocolVersion >= RELAY_MCP_DISPATCH_PROVENANCE_PROTOCOL_VERSION;
    if (
      request.hostedBy !== undefined &&
      (request.hostedBy !== relayId || !hasHostedMcpTool)
    ) {
      send({
        type: "relay:result",
        correlationId: msg.correlationId,
        status: "error",
        error: "Hosted MCP dispatch provenance is invalid or unavailable",
        durationMs: Date.now() - start,
      });
      pendingCancellers.delete(msg.correlationId);
      return;
    }
    if (
      hasHostedMcpTool &&
      (!requiresMcpProvenance || request.hostedBy === relayId)
    ) {
      try {
        const result = await mcpHost.dispatch(request.toolName, request.args);
        send({
          type: "relay:result",
          correlationId: msg.correlationId,
          status: result.status,
          result: result.result,
          error: result.error,
          errorCode: result.errorCode,
          durationMs: result.durationMs ?? Date.now() - start,
        });
      } catch (err) {
        send({
          type: "relay:result",
          correlationId: msg.correlationId,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - start,
        });
      } finally {
        pendingCancellers.delete(msg.correlationId);
      }
      return;
    }

    try {
      // The relay already owns one AbortController per correlation id. Pass
      // that existing cancellation authority into execution instead of
      // creating tool-specific cancellation machinery downstream.
      const result = await options.onDispatch(request, ac.signal);
      send({
        type: "relay:result",
        correlationId: msg.correlationId,
        status: result.status,
        result: result.result,
        error: result.error,
        errorCode: result.errorCode,
        networkDeniedDestination: result.networkDeniedDestination,
        durationMs: result.durationMs ?? Date.now() - start,
      });
    } catch (err) {
      send({
        type: "relay:result",
        correlationId: msg.correlationId,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    } finally {
      pendingCancellers.delete(msg.correlationId);
    }
  }

  function wsDataToString(data: WebSocket.Data): string {
    if (typeof data === "string") return data;
    if (data instanceof Buffer) return data.toString("utf8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
    return "";
  }

  function handleMessage(
    raw: WebSocket.Data,
    socket: WebSocket,
    socketGeneration: number,
    registration: SocketRegistrationState,
  ) {
    // A closed/replaced socket may still deliver buffered frames or finish an
    // async capability build. No frame from it may mutate active relay state.
    if (!isActiveSocket(socket, socketGeneration)) return;
    const wire = wsDataToString(raw);
    const codex = parseRelayCodexJsonFrame(wire, "server");
    if (codex.ok) {
      const port = options.codexHostPort;
      reconcileCodexHost(registeredCapabilities);
      if (codexSession === null || !port) return;
      if (
        codex.value.type !== "relay:codex-command" &&
        codex.value.type !== "relay:codex-cancel" &&
        codex.value.type !== "relay:codex-credit" &&
        codex.value.type !== "relay:codex-request-response"
      ) return;
      const serverMessage = codex.value;
      const scope = serverMessage.scope as unknown as Record<string, unknown>;
      if (!matchesCurrentCodexSocket(scope)) return;
      pruneCodexState();
      const identity = serverMessage.type === "relay:codex-command"
        ? `command:${serverMessage.commandId}`
        : `${serverMessage.type}:${codexScopeKey(scope)}`;
      const prior = inboundCodex.get(identity);
      if (prior) {
        if (prior.fingerprint !== wire) return;
        if (serverMessage.type === "relay:codex-command") {
          const response = outboundCodex.get(identity);
          if (response) send(response.message as RelayClientMessage);
        }
        return;
      }
      putCodex(inboundCodex, identity, {
        fingerprint: wire,
        expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS,
        ...(serverMessage.type === "relay:codex-command"
          ? { command: serverMessage }
          : {}),
      });
      switch (serverMessage.type) {
        case "relay:codex-command": void port.onCommand?.(serverMessage); break;
        case "relay:codex-cancel": void port.onCancel?.(serverMessage); break;
        case "relay:codex-credit": void port.onCredit?.(serverMessage); break;
        case "relay:codex-request-response": void port.onRequestResponse?.(serverMessage); break;
      }
      return;
    }
    const acp = parseRelayAcpJsonFrame(wire, "server");
    if (acp.ok) {
      reconcileAcpHost(registeredCapabilities);
      if (acp.value.type === "relay:acp-readiness" && matchesCurrentAcpSocket(acp.value.scope as unknown as Record<string, unknown>) && supportsCurrentAcpRegistration(acp.value.registrationId)) {
        try { void Promise.resolve(options.acpHostPort?.onReadiness?.(acp.value)).catch(() => undefined); } catch { /* host callback is isolated */ }
      } else if (acp.value.type === "relay:acp-prepare" && matchesCurrentAcpSocket(acp.value.scope as unknown as Record<string, unknown>) && supportsCurrentAcpRegistration(acp.value.registrationId)) {
        try { void Promise.resolve(options.acpHostPort?.onPrepare?.(acp.value)).catch(() => undefined); } catch { /* host callback is isolated */ }
      } else if (acp.value.type === "relay:acp-start" && matchesCurrentAcpSocket(acp.value.scope.socket as unknown as Record<string, unknown>) && supportsCurrentAcpRegistration(acp.value.registrationId)) {
        try { void Promise.resolve(options.acpHostPort?.onStart?.(acp.value)).catch(() => undefined); } catch { /* host callback is isolated */ }
      } else if (acp.value.type === "relay:acp-contain" && matchesCurrentAcpSocket(acp.value.scope.socket as unknown as Record<string, unknown>) && supportsCurrentAcpRegistration(acp.value.registrationId)) {
        const containmentKey = `${acp.value.registrationId}:${acp.value.containmentRef}`;
        const fingerprint = JSON.stringify({ registrationId: acp.value.registrationId, scope: acp.value.scope, process: acp.value.process, code: acp.value.code });
        const prior = inboundAcpContainments.get(containmentKey);
        if (prior !== undefined) {
          // Same opaque ref may retry byte-identically; a conflicting replay
          // is fail-closed and never reaches Electron containment ownership.
          if (prior !== fingerprint) return;
          return;
        }
        if (inboundAcpContainments.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) {
          const oldest = inboundAcpContainments.keys().next().value;
          if (typeof oldest === "string") inboundAcpContainments.delete(oldest);
        }
        inboundAcpContainments.set(containmentKey, fingerprint);
        try { void Promise.resolve(options.acpHostPort?.onContain?.(acp.value)).catch(() => undefined); } catch { /* host callback is isolated */ }
      }
      return;
    }
    let maybeClaudeExecution: RelayClaudeExecutionCommand | null = null;
    try { maybeClaudeExecution = parseRelayClaudeExecutionCommand(JSON.parse(wire) as unknown); } catch { /* generic handling below */ }
    if (maybeClaudeExecution !== null) {
      reconcileClaudeExecutionHost(registeredCapabilities);
      const port = options.claudeExecutionHostPort;
      if (
        !port || !supportsCurrentClaudeExecution() ||
        !matchesCurrentClaudeExecutionSocket(maybeClaudeExecution.scope as unknown as Record<string, unknown>)
      ) return;
      const session = claudeExecutionSession;
      try {
        void Promise.resolve(port.onCommand(maybeClaudeExecution)).catch(() => {
          if (session !== null && claudeExecutionSession === session) deactivateClaudeExecutionHost();
        });
      } catch {
        deactivateClaudeExecutionHost();
      }
      return;
    }
    let maybeClaudeDiscovery: RelayClaudeConnectionDiscoverCommand | null = null;
    try { maybeClaudeDiscovery = parseRelayClaudeConnectionDiscoverCommand(JSON.parse(wire) as unknown); } catch { /* generic handling below */ }
    if (maybeClaudeDiscovery !== null) {
      reconcileClaudeConnectionHost(registeredCapabilities);
      const port = options.claudeConnectionHostPort;
      if (!port || !supportsCurrentClaudeConnection() || !matchesCurrentClaudeConnectionSocket(maybeClaudeDiscovery.scope as unknown as Record<string, unknown>)) return;
      pruneClaudeDiscoveries();
      const key = claudeDiscoveryKey(maybeClaudeDiscovery.scope, maybeClaudeDiscovery.correlationId);
      const prior = inboundClaudeDiscoveries.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== wire) return;
        if (prior.result !== undefined) send(prior.result.message as RelayClientMessage);
        return;
      }
      if (inboundClaudeDiscoveries.size >= CODEX_RELAY_MAX_REPLAY_ENTRIES) {
        const completed = [...inboundClaudeDiscoveries.entries()].find(([, entry]) => entry.result !== undefined);
        if (completed === undefined) return;
        inboundClaudeDiscoveries.delete(completed[0]);
      }
      inboundClaudeDiscoveries.set(key, {
        fingerprint: wire,
        command: maybeClaudeDiscovery,
        expiresAt: Date.now() + CODEX_RELAY_REPLAY_CACHE_TTL_MS,
      });
      try {
        port.onDiscover(Object.freeze({
          ...maybeClaudeDiscovery,
          scope: Object.freeze({ ...maybeClaudeDiscovery.scope }),
        }));
      } catch { /* host callback is isolated */ }
      return;
    }
    let msg: RelayServerMessage;
    try {
      msg = JSON.parse(wire) as RelayServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "relay:registered": {
        // `relay:registered` implicitly acknowledges the complete register
        // frame. Its protocol shape has no capabilityRevision, so use the
        // exact value captured immediately before this socket sent that frame.
        if (
          !registration.sent ||
          registration.revision === null ||
          (msg.relayId !== relayId &&
            // Old headless fixtures predate relay-id echoing. They have no
            // acknowledged-revision projection, so retain their wire
            // compatibility without relaxing Desktop acknowledgement identity.
            !(desktopSessionId === undefined && msg.relayId === undefined))
        ) return;
        // A later registered frame can refresh a host session on the same
        // socket, but it cannot reset a capability update to the original
        // registration baseline.
        if (!registration.acknowledged) {
          registration.acknowledged = true;
          acknowledgedCapabilityRevision = desktopSessionId === undefined
            ? null
            : registration.revision;
        }
        negotiatedProtocolVersion =
          msg.protocolVersion ?? RELAY_MIN_SUPPORTED_PROTOCOL_VERSION;
        reconnectAttempt = 0;
        startHeartbeat();
        setStatus("connected");
        if (
          desktopSessionId !== undefined &&
          acknowledgedCapabilityRevision !== null &&
          isCodexRelayProtocolVersion((msg as Partial<RelayRegisteredV8>).selectedProtocolVersion) &&
          typeof (msg as Partial<RelayRegisteredV8>).relaySessionId === "string" &&
          typeof (msg as Partial<RelayRegisteredV8>).pairingGenerationRef === "string"
        ) {
          authenticatedCodexSession = {
            relayId: msg.relayId,
            relaySessionId: (msg as RelayRegisteredV8).relaySessionId,
            pairingGenerationRef: (msg as RelayRegisteredV8).pairingGenerationRef,
            desktopSessionId,
            selectedProtocolVersion: (msg as RelayRegisteredV8).selectedProtocolVersion,
            capabilityRevision: acknowledgedCapabilityRevision,
          };
          reconcileCodexHost(registeredCapabilities);
          reconcileAcpHost(registeredCapabilities);
          reconcileClaudeConnectionHost(registeredCapabilities);
          reconcileClaudeExecutionHost(registeredCapabilities);
        }
        if (
          desktopSessionId !== undefined &&
          acknowledgedCapabilityRevision !== null &&
          isCodexRelayProtocolVersion((msg as Partial<RelayRegisteredV8>).selectedProtocolVersion) &&
          typeof (msg as Partial<RelayRegisteredV8>).relaySessionId === "string" &&
          typeof (msg as Partial<RelayRegisteredV8>).pairingGenerationRef === "string"
        ) {
          setDesktopTopology({
            relayId: msg.relayId,
            relaySessionId: (msg as RelayRegisteredV8).relaySessionId,
            pairingGeneration: (msg as RelayRegisteredV8).pairingGenerationRef,
            desktopSessionId,
            selectedProtocolVersion: (msg as RelayRegisteredV8).selectedProtocolVersion,
            capabilityRevision: acknowledgedCapabilityRevision,
          });
        } else {
          setDesktopTopology(null);
        }
        break;
      }

      case "relay:dispatch":
        void handleDispatch(msg);
        break;

      case "relay:cancel": {
        const ac = pendingCancellers.get(msg.correlationId);
        if (ac) ac.abort();
        break;
      }

      case "relay:configure-mcp": {
        // D384 Phase 5 — server→relay: (re)configure the hosted MCP fleet.
        // Idempotent reconcile; the host emits advertise frames as tools come
        // up. Sent post-register for v3 relays and on mcp_servers mutations.
        // D503 v12 adds an optional correlated target outcome. The old
        // fire-and-forget behavior remains byte-for-byte available when the
        // operation envelope is absent or this relay negotiated v9–v11.
        if (
          msg.operation !== undefined &&
          negotiatedProtocolVersion >= RELAY_MCP_TRUTH_PROTOCOL_VERSION &&
          isValidMcpOperation(msg.operation)
        ) {
          void handleMcpConfigure(msg.servers, msg.operation);
          break;
        }
        const host = options.mcpHost;
        if (host) {
          void serializeMcpHostOperation(() => Promise.resolve(host.configure(msg.servers))).catch((err) => {
            console.error(
              `[relay] configure-mcp failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
        break;
      }

      case "relay:mcp-preflight":
        void handleMcpPreflight(msg);
        break;

      case "relay:ssh-prepare":
        void handleSshPrepare(msg);
        break;

      case "relay:error":
        if (msg.code === RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE) {
          markAuthenticationRequired();
          break;
        }
        console.error(`[relay] Server error: ${msg.message}`);
        break;

      case "relay:capabilities-updated": {
        // D418 protocol v7 — server ack for an in-flight update. Resolve or
        // reject the matching pending update; ignore stray acks (e.g. after a
        // reconnect that reset the in-flight state).
        const ack = msg;
        const resolver = capabilityAckResolver;
        if (
          resolver !== null &&
          resolver.socketGeneration === socketGeneration &&
          ack.relayId === relayId &&
          ack.capabilityRevision === resolver.revision
        ) {
          capabilityAckResolver = null;
          if (ack.status === "ok") {
            acknowledgedCapabilityRevision = resolver.revision;
            registeredCapabilities = resolver.capabilities;
            if (desktopTopology !== null) {
              setDesktopTopology({
                ...desktopTopology,
                capabilityRevision: resolver.revision,
              });
            }
            reconcileCodexHost(registeredCapabilities);
            reconcileAcpHost(registeredCapabilities);
            reconcileClaudeConnectionHost(registeredCapabilities);
            reconcileClaudeExecutionHost(registeredCapabilities);
            resolver.resolve();
          } else {
            resolver.reject(
              new Error(
                `relay update-capabilities rejected: ${ack.error ?? "unknown reason"}`,
              ),
            );
          }
        }
        break;
      }
    }
  }

  function connectInternal(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      setStatus("connecting");
      const wsUrl = options.serverUrl.replace(/^http/, "ws") + "/relay";
      const socketGeneration = nextSocketGeneration++;
      let socket: WebSocket;

      try {
        socket = new WebSocket(wsUrl);
        ws = socket;
        activeSocketGeneration = socketGeneration;
        acknowledgedCapabilityRevision = null;
      } catch (err) {
        setStatus("error");
        scheduleReconnect();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let resolved = false;
      let socketAuthenticationRequired = false;
      const markResolved = (): boolean => {
        if (resolved) return false;
        resolved = true;
        if (cancelPendingConnect === cancelThisConnect) cancelPendingConnect = null;
        return true;
      };
      const cancelThisConnect = (): void => {
        if (markResolved()) reject(new Error("Relay disconnect"));
      };
      cancelPendingConnect = cancelThisConnect;
      const registration: SocketRegistrationState = {
        revision: null,
        sent: false,
        acknowledged: false,
      };

      socket.on("open", () => {
        // D418 reconnect/session split-brain fix — advertise the CURRENT
        // capability state on every register (initial AND reconnect), not
        // the frozen `options.capabilities` captured at construction. A
        // reconnect that re-registered frozen pre-activation capabilities
        // would overwrite the server relay registry's profile snapshot with
        // null while a Full Workstation session stayed active, letting the
        // no-plan `run_shell` gate skip and dispatch an unbound generic
        // shell. The dynamic getter is async-capable; a throw falls back to
        // the static capabilities so a builder fault never blocks
        // registration. The headless relay omits the getter and registers
        // the static value, byte-for-byte pre-D418.
        void (async () => {
          let capabilities = options.capabilities;
          if (options.getCapabilities) {
            try {
              capabilities = await options.getCapabilities();
            } catch {
              capabilities = options.capabilities;
            }
          }
          // The builder may have awaited while this socket was replaced. Do
          // not let it mutate the replacement's capabilities or send through
          // the mutable global socket reference.
          if (
            !isActiveSocket(socket, socketGeneration) ||
            socket.readyState !== WebSocket.OPEN
          ) return;
          registeredCapabilities = capabilities;
          registration.revision = issuedCapabilityRevision;
          try {
            socket.send(JSON.stringify({
              type: "relay:register",
              relayId,
              userId: options.userId,
              capabilities: projectRelayCapabilitiesForProtocol(
                capabilities,
                RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
              ),
              // The legacy field is deliberately the safe compatibility floor:
              // a v9 server ignores the additive offer and registers normally.
              // Negotiation-aware servers select the highest common version.
              protocolVersion: RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
              protocolRange: {
                minimum: RELAY_MIN_SUPPORTED_PROTOCOL_VERSION,
                maximum: RELAY_PROTOCOL_VERSION,
              },
              capabilitiesByProtocolVersion: {
                [String(RELAY_PROTOCOL_VERSION)]: capabilities,
              },
              token: options.token,
              ...(desktopSessionId !== undefined ? { desktopSessionId } : {}),
              capabilityRevision: registration.revision,
            }));
            registration.sent = true;
          } catch (error) {
            if (!isActiveSocket(socket, socketGeneration)) return;
            if (markResolved()) {
              setStatus("error");
              reject(error instanceof Error ? error : new Error(String(error)));
            }
            // The close event owns active teardown and the one reconnect
            // schedule. Closing here turns a synchronous send failure into
            // that ordinary socket-loss path without an unhandled async throw.
            try { socket.close(); } catch { scheduleReconnect(); }
          }
        })();
      });

      socket.on("message", (data) => {
        if (!isActiveSocket(socket, socketGeneration)) return;
        if (!resolved) {
          let msg: RelayServerMessage;
          try {
            msg = JSON.parse(wsDataToString(data)) as RelayServerMessage;
          } catch {
            return;
          }
          if (msg.type === "relay:registered") {
            // Registration is an acknowledgement only after this exact socket
            // has successfully sent its register frame for this relay id.
            // Early/wrong frames are ignored, leaving this connect attempt
            // pending for the real acknowledgement.
            if (
              !registration.sent ||
              (msg.relayId !== relayId &&
                !(desktopSessionId === undefined && msg.relayId === undefined))
            ) return;
            handleMessage(data, socket, socketGeneration, registration);
            if (!registration.acknowledged) return;
            if (markResolved()) resolve();
            return;
          }
          if (msg.type === "relay:error") {
            markResolved();
            if (msg.code === RELAY_AUTHENTICATION_REQUIRED_ERROR_CODE) {
              socketAuthenticationRequired = true;
              markAuthenticationRequired();
              reject(new RelayAuthenticationRequiredError());
            } else {
              if (isActiveSocket(socket, socketGeneration)) setStatus("error");
              reject(new Error(msg.message));
            }
            return;
          }
        }
        handleMessage(data, socket, socketGeneration, registration);
      });

      socket.on("close", (code: number) => {
        const active = isActiveSocket(socket, socketGeneration);
        const tokenRejected = code === RELAY_TOKEN_AUTH_CLOSE_CODE || socketAuthenticationRequired;
        if (active && tokenRejected) markAuthenticationRequired();
        // Every socket generation owns one MCP loss notification, even if it
        // closes after a replacement became active.
        stopHostedMcpsForSocketLoss(socketGeneration);
        if (markResolved()) {
          reject(tokenRejected
            ? new RelayAuthenticationRequiredError()
            : new Error("WebSocket closed before registration"));
        }
        // A stale close must settle only its own connect attempt. It cannot
        // stop the replacement heartbeat, clear its hosts/topology/ack state,
        // or schedule another reconnect.
        if (!active) return;
        stopHeartbeat();
        pendingCancellers.forEach((ac) => ac.abort());
        pendingCancellers.clear();
        authenticatedCodexSession = null;
        deactivateCodexHost();
        deactivateClaudeConnectionHost();
        deactivateClaudeExecutionHost();
        if (acpSession !== null) {
          acpSession = null;
          try { void Promise.resolve(options.acpHostPort?.onDisconnected?.()).catch(() => undefined); } catch { /* isolated host callback */ }
        }
        setDesktopTopology(null);
        acknowledgedCapabilityRevision = null;
        abortCapabilityUpdates(
          new Error("WebSocket closed before capabilities-updated ack"),
        );
        setStatus(tokenRejected ? "error" : "disconnected");
        if (activeSocketGeneration === socketGeneration) activeSocketGeneration = null;
        if (ws === socket) ws = null;
        if (!tokenRejected) scheduleReconnect();
      });

      socket.on("error", (err) => {
        if (markResolved()) {
          if (isActiveSocket(socket, socketGeneration)) setStatus("error");
          reject(err);
        }
      });
    });
  }

  return {
    async connect() {
      intentionalDisconnect = false;
      reconnectAttempt = 0;
      authenticationRequiredNotified = false;
      await connectInternal();
    },

    async disconnect() {
      intentionalDisconnect = true;
      cancelReconnect();
      stopHeartbeat();
      pendingCancellers.forEach((ac) => ac.abort());
      pendingCancellers.clear();
      authenticatedCodexSession = null;
      deactivateCodexHost();
      deactivateClaudeConnectionHost();
      deactivateClaudeExecutionHost();
      if (acpSession !== null) {
        acpSession = null;
        try { await options.acpHostPort?.onDisconnected?.(); } catch { /* isolated host callback */ }
      }
      setDesktopTopology(null);
      acknowledgedCapabilityRevision = null;
      abortCapabilityUpdates(new Error("Relay disconnect"));
      const socketToClose = ws;
      const socketGenerationToClose = activeSocketGeneration;
      const cancelConnecting = cancelPendingConnect;
      cancelPendingConnect = null;
      cancelConnecting?.();
      if (socketGenerationToClose !== null) {
        stopHostedMcpsForSocketLoss(socketGenerationToClose);
      }
      let disconnectError: Error | null = null;
      if (socketToClose?.readyState === WebSocket.OPEN) {
        try {
          send({ type: "relay:disconnect", relayId });
        } catch (error) {
          disconnectError = error instanceof Error ? error : new Error(String(error));
        }
        try {
          socketToClose.close(1000, "Client disconnect");
        } catch (error) {
          disconnectError ??= error instanceof Error ? error : new Error(String(error));
        }
      } else if (socketToClose?.readyState === WebSocket.CONNECTING) {
        // `close()` is not reliable while ws is still establishing the TCP
        // connection. Terminating the exact owned socket guarantees its close
        // event settles the matching connect promise and cannot leave a raw
        // connection that later opens after this client was retired.
        try {
          socketToClose.terminate();
        } catch {
          try { socketToClose.close(); } catch { /* already unavailable */ }
        }
      }
      if (activeSocketGeneration === socketGenerationToClose) activeSocketGeneration = null;
      if (ws === socketToClose) ws = null;
      setStatus("disconnected");
      if (disconnectError !== null) throw disconnectError;
    },

    getStatus() {
      return status;
    },

    getRelayId() {
      return relayId;
    },

    getDesktopTopology() {
      return desktopTopology;
    },

    getAcknowledgedCapabilityRevision() {
      return desktopSessionId === undefined ? null : acknowledgedCapabilityRevision;
    },

    async updateCapabilities(capabilities: RelayCapabilities): Promise<void> {
      try {
        if (
          Object.hasOwn(capabilities, "claudeExecution") &&
          (capabilities.profile !== "desktop-agent" ||
            !parseRelayClaudeExecutionCapability(capabilities.claudeExecution).ok)
        ) throw new Error("invalid Claude execution capability");
      } catch (error) {
        throw error instanceof Error ? error : new Error("invalid Claude execution capability");
      }
      // Headless relays have no desktop session and cannot advertise
      // desktop-session capability state. Resolve immediately rather than
      // pretending to send an update the server would reject.
      if (desktopSessionId === undefined) return;
      if (status !== "connected") {
        throw new Error("relay is not connected");
      }
      return new Promise<void>((resolve, reject) => {
        capabilityUpdateQueue.push({ capabilities, resolve, reject });
        void pumpCapabilityUpdates();
      });
    },
  };
}
