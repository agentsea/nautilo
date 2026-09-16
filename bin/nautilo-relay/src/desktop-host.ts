import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import {
  RELAY_HOST_COMPONENT,
  RELAY_HOST_PROTOCOL_VERSION,
  createRelayClient,
  readRelayHostFrames,
  writeRelayHostFrame,
  type RelayAcpHostTransport,
  type RelayAdvertisedMcpTool,
  type RelayCapabilities,
  type RelayClaudeConnectionHostTransport,
  type RelayClaudeExecutionHostTransport,
  type RelayClient,
  type RelayCodexHostTransport,
  type RelayDispatchRequest,
  type RelayDispatchResult,
  type RelayHostCallback,
  type RelayHostCallbackEventMessage,
  type RelayHostCallbackResultMessage,
  type RelayHostChildMessage,
  type RelayHostCommandMessage,
  type RelayHostInitializeMessage,
  type RelayHostParentMessage,
  type RelayHostPortEvent,
  type RelayMcpConfigureOperation,
  type RelayMcpFailure,
  type RelayMcpHost,
  type RelayMcpServerConfig,
  type RelaySshPrepareFailureCode,
  type RelaySshPrepareRequestV1,
  type RelaySshPrepareResponseV1,
  type RelaySshResolutionFailure,
} from "@nautilo/relay";

const RELAY_DESKTOP_HOST_VERSION = "1.0.0";

type HostInitializePayload = Readonly<{
  serverUrl: string;
  userId: string;
  relayId: string;
  token?: string;
  capabilities: RelayCapabilities;
  desktopSessionId: string;
  initialCapabilityRevision: number;
  runShellOwnerInstanceId: string;
  browserPageOwnerInstanceId: string;
  ports: Readonly<{
    mcp: boolean;
    sshPrepare: boolean;
    codex: boolean;
    acp: boolean;
    acpRegistrations: readonly ("hermes-acp" | "opencode-acp")[];
    claudeConnection: boolean;
    claudeExecution: boolean;
  }>;
}>;

type PendingParentCallback = Readonly<{
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  onEvent?: ((event: RelayHostCallbackEventMessage) => void) | undefined;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  return required.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    && keys.every((key) => allowed.has(key));
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function stringOrEmpty(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0");
}

function parseInitializePayload(value: unknown): HostInitializePayload {
  if (!isRecord(value) || !exact(value, [
    "serverUrl", "userId", "relayId", "capabilities", "desktopSessionId",
    "initialCapabilityRevision", "runShellOwnerInstanceId",
    "browserPageOwnerInstanceId", "ports",
  ], ["token"])) throw new Error("relay_host_initialize_invalid");
  if (!string(value["serverUrl"]) || !string(value["userId"]) || !string(value["relayId"])
    || !string(value["desktopSessionId"]) || !stringOrEmpty(value["runShellOwnerInstanceId"])
    || !stringOrEmpty(value["browserPageOwnerInstanceId"])
    || (value["token"] !== undefined && !string(value["token"]))
    || !Number.isSafeInteger(value["initialCapabilityRevision"])
    || Number(value["initialCapabilityRevision"]) < 0
    || !isRecord(value["capabilities"]) || !isRecord(value["ports"])) {
    throw new Error("relay_host_initialize_invalid");
  }
  const ports = value["ports"];
  if (!exact(ports, ["mcp", "sshPrepare", "codex", "acp", "acpRegistrations", "claudeConnection", "claudeExecution"])
    || typeof ports["mcp"] !== "boolean" || typeof ports["codex"] !== "boolean"
    || typeof ports["sshPrepare"] !== "boolean"
    || typeof ports["acp"] !== "boolean" || typeof ports["claudeConnection"] !== "boolean"
    || typeof ports["claudeExecution"] !== "boolean" || !Array.isArray(ports["acpRegistrations"])
    || !ports["acpRegistrations"].every((item) => item === "hermes-acp" || item === "opencode-acp")) {
    throw new Error("relay_host_initialize_invalid");
  }
  return value as unknown as HostInitializePayload;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 0 ? text : "relay_host_operation_failed";
}

function abortError(): Error {
  const error = new Error("Relay Host callback was cancelled");
  error.name = "AbortError";
  return error;
}

/** Electron-free owner of the RelayClient and server WebSocket. */
export class DesktopRelayHost {
  readonly #nonce = randomUUID();
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #pendingParentCallbacks = new Map<string, PendingParentCallback>();
  readonly #hostedMcpTools = new Set<string>();
  readonly #hostedMcpToolsByServer = new Map<string, readonly RelayAdvertisedMcpTool[]>();
  readonly #transports: {
    codex?: RelayCodexHostTransport;
    acp?: RelayAcpHostTransport;
    claudeConnection?: RelayClaudeConnectionHostTransport;
    claudeExecution?: RelayClaudeExecutionHostTransport;
  } = {};
  #generation: string | null = null;
  #client: RelayClient | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  #closed = false;
  #mcpToolsListener: ((serverName: string, tools: RelayAdvertisedMcpTool[]) => void) | null = null;

  constructor(options: { input: Readable; output: Writable }) {
    this.#input = options.input;
    this.#output = options.output;
  }

  async run(): Promise<void> {
    await this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "ready",
      component: RELAY_HOST_COMPONENT,
      hostVersion: RELAY_DESKTOP_HOST_VERSION,
      nonce: this.#nonce,
    });
    const work = new Set<Promise<void>>();
    try {
      for await (const raw of readRelayHostFrames(this.#input)) {
        const message = raw as RelayHostParentMessage;
        if (message.kind !== "initialize" && message.generation !== this.#generation) continue;
        if (message.kind === "callback-result") {
          this.#settleCallback(message);
          continue;
        }
        if (message.kind === "callback-event") {
          this.#pendingParentCallbacks.get(message.requestId)?.onEvent?.(message);
          continue;
        }
        if (message.kind === "mcp-tools-changed") {
          this.#receiveMcpTools(message.serverName, message.payload);
          continue;
        }
        if (message.kind === "transport-send") {
          this.#receiveTransport(message.transport, message.payload);
          continue;
        }
        if (message.kind === "cancel-callback") {
          const pending = this.#pendingParentCallbacks.get(message.requestId);
          if (pending !== undefined) {
            this.#pendingParentCallbacks.delete(message.requestId);
            pending.reject(abortError());
          }
          continue;
        }
        const task = this.#handle(message).catch(() => undefined);
        work.add(task);
        void task.finally(() => work.delete(task));
      }
    } finally {
      this.#closed = true;
      for (const pending of this.#pendingParentCallbacks.values()) pending.reject(new Error("Relay Host pipe closed"));
      this.#pendingParentCallbacks.clear();
      await this.#client?.disconnect().catch(() => undefined);
      await Promise.allSettled([...work]);
      await this.#writeTail.catch(() => undefined);
    }
  }

  async #handle(message: RelayHostParentMessage): Promise<void> {
    if (message.kind === "initialize") {
      await this.#initialize(message);
      return;
    }
    if (message.kind !== "command") return;
    if (this.#generation === null || message.generation !== this.#generation || this.#client === null) {
      await this.#commandResult(message, false, undefined, "relay_host_generation_stale");
      return;
    }
    try {
      if (message.command === "connect") await this.#client.connect();
      else if (message.command === "disconnect") await this.#client.disconnect();
      else if (message.command === "update-capabilities") {
        if (!isRecord(message.payload)) throw new Error("relay_host_capabilities_invalid");
        await this.#client.updateCapabilities(message.payload as RelayCapabilities);
      }
      await this.#commandResult(message, true, this.#snapshot());
    } catch (error) {
      await this.#commandResult(message, false, this.#snapshot(), errorText(error));
    }
  }

  async #initialize(message: RelayHostInitializeMessage): Promise<void> {
    if (this.#generation !== null || message.nonce !== this.#nonce) {
      await this.#send({
        protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
        kind: "initialized",
        generation: message.generation,
        requestId: message.requestId,
        ok: false,
        error: "relay_host_initialize_rejected",
      });
      return;
    }
    try {
      const payload = parseInitializePayload(message.payload);
      this.#generation = message.generation;
      const mcpHost = payload.ports.mcp ? this.#createMcpProxy() : undefined;
      this.#client = createRelayClient({
        serverUrl: payload.serverUrl,
        userId: payload.userId,
        relayId: payload.relayId,
        ...(payload.token === undefined ? {} : { token: payload.token }),
        capabilities: payload.capabilities,
        desktopSessionId: payload.desktopSessionId,
        initialCapabilityRevision: payload.initialCapabilityRevision,
        runShellOwnerInstanceId: payload.runShellOwnerInstanceId,
        browserPageOwnerInstanceId: payload.browserPageOwnerInstanceId,
        getCapabilities: async () => await this.#callParent("capabilities") as RelayCapabilities,
        onDispatch: async (request, signal) => await this.#dispatch(request, signal),
        ...(payload.ports.sshPrepare
          ? { onSshPrepare: async (request: RelaySshPrepareRequestV1, signal: AbortSignal) => await this.#sshPrepare(request, signal) }
          : {}),
        onStatusChange: (status) => { void this.#event("status", status); },
        onDesktopTopologyChange: (topology) => { void this.#event("topology", topology); },
        onAuthenticationRequired: () => this.#event("authentication-required"),
        ...(mcpHost === undefined ? {} : { mcpHost }),
        ...(payload.ports.codex ? { codexHostPort: this.#codexPort() } : {}),
        ...(payload.ports.acp ? { acpHostPort: this.#acpPort(payload.ports.acpRegistrations) } : {}),
        ...(payload.ports.claudeConnection ? { claudeConnectionHostPort: this.#claudeConnectionPort() } : {}),
        ...(payload.ports.claudeExecution ? { claudeExecutionHostPort: this.#claudeExecutionPort() } : {}),
      });
      await this.#send({
        protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
        kind: "initialized",
        generation: message.generation,
        requestId: message.requestId,
        ok: true,
        payload: this.#snapshot(),
      });
    } catch (error) {
      this.#client = null;
      this.#generation = null;
      await this.#send({
        protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
        kind: "initialized",
        generation: message.generation,
        requestId: message.requestId,
        ok: false,
        error: errorText(error),
      });
    }
  }

  #snapshot(): unknown {
    const client = this.#client;
    return client === null ? null : {
      status: client.getStatus(),
      relayId: client.getRelayId(),
      topology: client.getDesktopTopology(),
      acknowledgedCapabilityRevision: client.getAcknowledgedCapabilityRevision(),
    };
  }

  async #commandResult(message: RelayHostCommandMessage, ok: boolean, payload?: unknown, error?: string): Promise<void> {
    await this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "command-result",
      generation: message.generation,
      requestId: message.requestId,
      ok,
      ...(payload === undefined ? {} : { payload }),
      ...(error === undefined ? {} : { error }),
    });
  }

  async #event(event: "status" | "topology" | "authentication-required", payload?: unknown): Promise<void> {
    if (this.#generation === null || this.#closed) return;
    await this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "event",
      generation: this.#generation,
      event,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async #portEvent(event: RelayHostPortEvent, payload?: unknown): Promise<void> {
    if (this.#generation === null || this.#closed) return;
    await this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "port-event",
      generation: this.#generation,
      event,
      ...(payload === undefined ? {} : { payload }),
    });
  }

  async #callParent(callback: RelayHostCallback, payload?: unknown, signal?: AbortSignal, onEvent?: PendingParentCallback["onEvent"]): Promise<unknown> {
    if (this.#generation === null || this.#closed) throw new Error("Relay Host is not initialized");
    if (signal?.aborted) throw abortError();
    const requestId = randomUUID();
    if (this.#pendingParentCallbacks.has(requestId)) {
      throw new Error("Relay Host callback ID collision");
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pendingParentCallbacks.set(requestId, { resolve, reject, onEvent });
    });
    // Cancellation requests cleanup; it does not establish the effect of an
    // admitted Computer Use operation. Keep its callback until the authority
    // owner returns the final receipt (or the inherited pipe is retired).
    // This is an execution-class rule, not a catalogue/tool-name allowlist.
    const retainSettlementOnAbort = callback === "dispatch" && isRecord(payload) &&
      payload["executionClass"] === "computer_use";
    const cancel = () => {
      const pending = this.#pendingParentCallbacks.get(requestId);
      if (pending === undefined) return;
      if (!retainSettlementOnAbort) this.#pendingParentCallbacks.delete(requestId);
      void this.#send({
        protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
        kind: "callback-cancelled",
        generation: this.#generation!,
        requestId,
      });
      if (!retainSettlementOnAbort) pending.reject(abortError());
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.#send({
        protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
        kind: "callback",
        generation: this.#generation,
        requestId,
        callback,
        ...(payload === undefined ? {} : { payload }),
      });
      return await promise;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.#pendingParentCallbacks.delete(requestId);
    }
  }

  #settleCallback(message: RelayHostCallbackResultMessage): void {
    if (message.generation !== this.#generation) return;
    const pending = this.#pendingParentCallbacks.get(message.requestId);
    if (pending === undefined) return;
    this.#pendingParentCallbacks.delete(message.requestId);
    if (message.ok) pending.resolve(message.payload);
    else pending.reject(new Error(message.error ?? "Relay Host parent callback failed"));
  }

  async #dispatch(request: RelayDispatchRequest, signal: AbortSignal): Promise<RelayDispatchResult> {
    return await this.#callParent("dispatch", request, signal, (event) => {
      if (event.event === "run-shell-progress") request.reportRunShellProgress?.(event.payload as never);
      else if (event.event === "security-scan-progress") request.reportSecurityScanProgress?.(event.payload as never);
      else request.reportStructuredSshProgress?.(event.payload as never);
    }) as RelayDispatchResult;
  }

  async #sshPrepare(request: RelaySshPrepareRequestV1, signal: AbortSignal): Promise<
    | { readonly ok: true; readonly response: RelaySshPrepareResponseV1 }
    | { readonly ok: false; readonly errorCode: RelaySshPrepareFailureCode; readonly failure?: RelaySshResolutionFailure }
  > {
    return await this.#callParent("ssh-prepare", request, signal) as never;
  }

  #createMcpProxy(): RelayMcpHost {
    return {
      configure: async (servers) => { await this.#callParent("mcp-configure", { servers }); },
      preflight: async (server) => await this.#callParent("mcp-preflight", { server }) as never,
      configureWithOutcome: async (servers, operation) => await this.#callParent(
        "mcp-configure-with-outcome", { servers, operation },
      ) as never,
      has: (toolName) => this.#hostedMcpTools.has(toolName),
      dispatch: async (toolName, args) => await this.#callParent("mcp-dispatch", { toolName, args }) as RelayDispatchResult,
      onToolsChanged: (listener) => { this.#mcpToolsListener = listener; },
      stop: async () => { await this.#callParent("mcp-stop"); },
    };
  }

  #receiveMcpTools(serverName: string, payload: unknown): void {
    if (!Array.isArray(payload)) return;
    const tools = payload.filter((tool): tool is RelayAdvertisedMcpTool => isRecord(tool) && string(tool["name"]));
    this.#hostedMcpToolsByServer.set(serverName, tools);
    this.#hostedMcpTools.clear();
    for (const serverTools of this.#hostedMcpToolsByServer.values()) {
      for (const tool of serverTools) this.#hostedMcpTools.add(tool.name);
    }
    this.#mcpToolsListener?.(serverName, tools);
  }

  #codexPort() {
    return {
      isReady: () => true,
      onRegistered: (session: unknown, transport: RelayCodexHostTransport) => {
        this.#transports.codex = transport;
        void this.#portEvent("codex-registered", session);
      },
      onCommand: (payload: unknown) => this.#portEvent("codex-command", payload),
      onCancel: (payload: unknown) => this.#portEvent("codex-cancel", payload),
      onCredit: (payload: unknown) => this.#portEvent("codex-credit", payload),
      onRequestResponse: (payload: unknown) => this.#portEvent("codex-request-response", payload),
      onDisconnected: () => { delete this.#transports.codex; void this.#portEvent("codex-disconnected"); },
    };
  }

  #acpPort(registrations: HostInitializePayload["ports"]["acpRegistrations"]) {
    return {
      isReady: () => true,
      registrations: () => registrations,
      onRegistered: (session: unknown, transport: RelayAcpHostTransport) => {
        this.#transports.acp = transport;
        void this.#portEvent("acp-registered", session);
      },
      onReadiness: (payload: unknown) => this.#portEvent("acp-readiness", payload),
      onPrepare: (payload: unknown) => this.#portEvent("acp-prepare", payload),
      onStart: (payload: unknown) => this.#portEvent("acp-start", payload),
      onContain: (payload: unknown) => this.#portEvent("acp-contain", payload),
      onDisconnected: () => { delete this.#transports.acp; void this.#portEvent("acp-disconnected"); },
    };
  }

  #claudeConnectionPort() {
    return {
      isReady: () => true,
      onRegistered: (session: unknown, transport: RelayClaudeConnectionHostTransport) => {
        this.#transports.claudeConnection = transport;
        void this.#portEvent("claude-connection-registered", session);
      },
      onDiscover: (payload: unknown) => { void this.#portEvent("claude-connection-discover", payload); },
      onDisconnected: () => { delete this.#transports.claudeConnection; void this.#portEvent("claude-connection-disconnected"); },
    };
  }

  #claudeExecutionPort() {
    return {
      isReady: () => true,
      onRegistered: (session: unknown, transport: RelayClaudeExecutionHostTransport) => {
        this.#transports.claudeExecution = transport;
        void this.#portEvent("claude-execution-registered", session);
      },
      onCommand: (payload: unknown) => this.#portEvent("claude-execution-command", payload),
      onDisconnected: () => { delete this.#transports.claudeExecution; void this.#portEvent("claude-execution-disconnected"); },
    };
  }

  #receiveTransport(transport: "codex" | "acp" | "claude-connection" | "claude-execution", payload: unknown): void {
    if (transport === "codex") this.#transports.codex?.send(payload as never);
    else if (transport === "acp") this.#transports.acp?.send(payload as never);
    else if (transport === "claude-connection") this.#transports.claudeConnection?.send(payload as never);
    else this.#transports.claudeExecution?.send(payload as never);
  }

  #send(message: RelayHostChildMessage): Promise<void> {
    const next = this.#writeTail.then(() => writeRelayHostFrame(this.#output, message));
    this.#writeTail = next.catch(() => undefined);
    return next;
  }
}

export type {
  HostInitializePayload,
  RelayMcpConfigureOperation,
  RelayMcpFailure,
  RelayMcpServerConfig,
};
