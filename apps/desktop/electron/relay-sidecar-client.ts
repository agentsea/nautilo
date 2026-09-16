import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  RELAY_HOST_COMPONENT,
  RELAY_HOST_PROTOCOL_VERSION,
  RelayHostFrameDecoder,
  encodeRelayHostFrame,
  type RelayAcpSession,
  type RelayCapabilities,
  type RelayClaudeConnectionSession,
  type RelayClaudeExecutionSession,
  type RelayClient,
  type RelayClientOptions,
  type RelayCodexSession,
  type RelayDesktopTopology,
  type RelayDispatchRequest,
  type RelayHostCallbackMessage,
  type RelayHostChildMessage,
  type RelayHostCommandResultMessage,
  type RelayHostEventMessage,
  type RelayHostPortEventMessage,
  type RelayHostReadyMessage,
  type RelayStatus,
} from "@nautilo/relay";

const RELAY_HOST_START_TIMEOUT_MS = 10_000;
const RELAY_DESKTOP_HOST_EXPECTED_VERSION = "1.0.0";

// Sequence ownership follows Electron's process lifetime, like desktopSessionId.
// Neither a crashed child nor a freshly constructed sidecar client may restart
// below a revision already acknowledged for a still-active workstation session.
// This scalar carries no permission or identity; server acknowledgement and the
// exact Human/server/pairing/profile/grant checks remain independent authority.
let desktopCapabilityRevision = -1;

function reserveDesktopCapabilityRevision(initial: number): number {
  const revision = Math.max(initial, desktopCapabilityRevision + 1);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Desktop Relay capability revision is invalid");
  }
  desktopCapabilityRevision = revision;
  return revision;
}

function retainDesktopCapabilityRevision(revision: number | null): void {
  if (revision !== null) desktopCapabilityRevision = Math.max(desktopCapabilityRevision, revision);
}

interface RelayHostProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode: number | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

type PendingRequest = Readonly<{
  expected: "initialized" | "command-result";
  resolve(message: RelayHostCommandResultMessage | Extract<RelayHostChildMessage, { kind: "initialized" }>): void;
  reject(reason?: unknown): void;
}>;

type RelaySnapshot = Readonly<{
  status: RelayStatus;
  relayId: string;
  topology: RelayDesktopTopology | null;
  acknowledgedCapabilityRevision: number | null;
}>;

export interface DesktopRelaySidecarClientOptions extends RelayClientOptions {
  readonly executablePath: string;
  readonly executableArguments?: readonly string[];
  readonly expectedHostVersion?: string;
  readonly spawnHost?: (command: string, args: readonly string[]) => RelayHostProcess;
  readonly reportHostError?: (message: string) => void;
}

export interface DesktopRelayHostLaunch {
  readonly executablePath: string;
  readonly executableArguments: readonly [string];
  readonly hostVersion: string;
}

export function resolveDesktopRelayHostLaunch(options: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string | null;
  readonly devVendorRoot: string;
  readonly architecture?: string;
}): DesktopRelayHostLaunch {
  if (options.isPackaged && options.resourcesPath === null) {
    throw new Error("Packaged Relay Host resource root is unavailable");
  }
  const architecture = options.architecture ?? process.arch;
  const resources = options.isPackaged ? options.resourcesPath! : dirname(options.devVendorRoot);
  const hostRoot = options.isPackaged ? join(resources, "tools-relay-host") : options.devVendorRoot;
  const runtime = resolve(resources, "bun", architecture, "bun");
  const script = resolve(hostRoot, "nautilo-relay-host.js");
  const manifestPath = resolve(hostRoot, "manifest.json");
  try {
    if (!statSync(runtime).isFile()) throw new Error("runtime is not a file");
    accessSync(runtime, constants.X_OK);
    if (!statSync(script).isFile() || !statSync(manifestPath).isFile()) throw new Error("host resources are not files");
    const bytes = readFileSync(script);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const exact = Object.keys(manifest).sort().join(",") === [
      "bytes", "hostVersion", "packageVersion", "protocolVersion", "schemaVersion", "script", "sha256",
    ].sort().join(",");
    if (!exact || manifest["schemaVersion"] !== 1 || manifest["script"] !== "nautilo-relay-host.js"
      || manifest["protocolVersion"] !== RELAY_HOST_PROTOCOL_VERSION
      || typeof manifest["hostVersion"] !== "string" || manifest["hostVersion"].length === 0
      || typeof manifest["packageVersion"] !== "string" || manifest["packageVersion"].length === 0
      || manifest["bytes"] !== bytes.byteLength
      || manifest["sha256"] !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error("Relay Host manifest mismatch");
    }
    return {
      executablePath: runtime,
      executableArguments: [script],
      hostVersion: manifest["hostVersion"],
    };
  } catch {
    throw new Error(`Managed Relay Host runtime is unavailable or invalid: ${hostRoot}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relayStatus(value: unknown): value is RelayStatus {
  return value === "connecting" || value === "connected" || value === "disconnected" || value === "error";
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function parseTopology(value: unknown): RelayDesktopTopology | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "relayId",
    "relaySessionId",
    "pairingGeneration",
    "desktopSessionId",
    "selectedProtocolVersion",
    "capabilityRevision",
  ])) return null;
  if (!nonEmptyString(value["relayId"]) || !nonEmptyString(value["relaySessionId"])
    || !nonEmptyString(value["pairingGeneration"]) || !nonEmptyString(value["desktopSessionId"])
    || !Number.isSafeInteger(value["selectedProtocolVersion"])
    || Number(value["selectedProtocolVersion"]) < 1
    || !Number.isSafeInteger(value["capabilityRevision"])
    || Number(value["capabilityRevision"]) < 0) return null;
  return value as unknown as RelayDesktopTopology;
}

function snapshot(value: unknown): RelaySnapshot | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "status",
    "relayId",
    "topology",
    "acknowledgedCapabilityRevision",
  ]) || !relayStatus(value["status"]) || !nonEmptyString(value["relayId"])) return null;
  const topologyValue = value["topology"];
  const revision = value["acknowledgedCapabilityRevision"];
  const parsedTopology = topologyValue === null ? null : parseTopology(topologyValue);
  if ((topologyValue !== null && parsedTopology === null)
    || (revision !== null && (!Number.isSafeInteger(revision) || Number(revision) < 0))
    || (parsedTopology !== null && revision !== parsedTopology.capabilityRevision)) return null;
  return {
    status: value["status"],
    relayId: value["relayId"],
    topology: parsedTopology,
    acknowledgedCapabilityRevision: revision as number | null,
  };
}

function callbackError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > 0 ? value : "relay_host_parent_callback_failed";
}

function defaultSpawn(command: string, args: readonly string[]): RelayHostProcess {
  return spawn(command, [...args], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

/**
 * Electron's narrow proxy for a separately executing RelayClient. It owns no
 * server socket and exposes no generic child RPC: every child callback maps to
 * one existing typed RelayClient port.
 */
class DesktopRelaySidecarClient implements RelayClient {
  readonly #options: DesktopRelaySidecarClientOptions;
  readonly #spawnHost: NonNullable<DesktopRelaySidecarClientOptions["spawnHost"]>;
  readonly #relayId: string;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #activeCallbacks = new Map<string, AbortController>();
  readonly #mcpTools = new Map<string, readonly unknown[]>();
  #child: RelayHostProcess | null = null;
  #generation: string | null = null;
  #decoder: RelayHostFrameDecoder | null = null;
  #readyWaiter: { resolve(message: RelayHostReadyMessage): void; reject(reason?: unknown): void } | null = null;
  #launching: Promise<void> | null = null;
  #writeTail: Promise<void> = Promise.resolve();
  #status: RelayStatus = "disconnected";
  #topology: RelayDesktopTopology | null = null;
  #acknowledgedCapabilityRevision: number | null = null;
  #desiredConnected = false;
  #replacementConsumed = false;
  #intentionalClose = false;

  constructor(options: DesktopRelaySidecarClientOptions) {
    this.#options = options;
    this.#spawnHost = options.spawnHost ?? defaultSpawn;
    this.#relayId = options.relayId ?? randomUUID();
    options.mcpHost?.onToolsChanged((serverName, tools) => {
      this.#mcpTools.set(serverName, tools);
      void this.#sendMcpTools(serverName, tools);
    });
  }

  async connect(): Promise<void> {
    this.#desiredConnected = true;
    await this.#ensureChild();
    const response = await this.#command("connect");
    this.#applySnapshot(response.payload);
  }

  async disconnect(): Promise<void> {
    this.#desiredConnected = false;
    this.#intentionalClose = true;
    const launching = this.#launching;
    if (launching !== null) {
      const launchingChild = this.#child;
      const launchingGeneration = this.#generation;
      if (launchingChild !== null && launchingGeneration !== null) {
        this.#hostFailed(
          launchingChild,
          launchingGeneration,
          new Error("Relay Host startup was cancelled"),
        );
        launchingChild.stdin.end();
        if (launchingChild.exitCode === null) launchingChild.kill("SIGTERM");
      }
      await launching.catch(() => undefined);
      this.#setDisconnected();
      return;
    }
    const child = this.#child;
    if (child === null) {
      this.#setDisconnected();
      return;
    }
    try {
      const response = await this.#command("disconnect");
      this.#applySnapshot(response.payload);
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
      this.#setDisconnected();
    }
  }

  getStatus(): RelayStatus { return this.#status; }
  getRelayId(): string { return this.#relayId; }
  getDesktopTopology(): RelayDesktopTopology | null { return this.#topology; }
  getAcknowledgedCapabilityRevision(): number | null { return this.#acknowledgedCapabilityRevision; }

  async updateCapabilities(capabilities: RelayCapabilities): Promise<void> {
    const response = await this.#command("update-capabilities", capabilities);
    this.#applySnapshot(response.payload);
  }

  async #ensureChild(): Promise<void> {
    if (this.#launching !== null) return await this.#launching;
    if (this.#child !== null) return;
    const launch = this.#launch();
    this.#launching = launch;
    try { await launch; } finally { this.#launching = null; }
  }

  async #launch(): Promise<void> {
    const initialCapabilityRevision = reserveDesktopCapabilityRevision(this.#options.initialCapabilityRevision ?? 0);
    const generation = randomUUID();
    const child = this.#spawnHost(this.#options.executablePath, this.#options.executableArguments ?? []);
    this.#child = child;
    this.#generation = generation;
    this.#decoder = new RelayHostFrameDecoder();
    this.#intentionalClose = false;
    child.stdout.on("data", (chunk: string | Uint8Array) => this.#receive(child, generation, chunk));
    child.stderr.on("data", () => { /* drain without forwarding child/provider prose */ });
    child.once("error", (error) => this.#hostFailed(child, generation, error));
    child.once("close", (code, signal) => this.#hostFailed(
      child,
      generation,
      new Error(`Relay Host exited (${code ?? signal ?? "unknown"})`),
    ));

    try {
      const ready = await this.#withStartTimeout(new Promise<RelayHostReadyMessage>((resolve, reject) => {
        this.#readyWaiter = { resolve, reject };
      }));
      if (ready.component !== RELAY_HOST_COMPONENT
        || ready.hostVersion !== (this.#options.expectedHostVersion ?? RELAY_DESKTOP_HOST_EXPECTED_VERSION)) {
        throw new Error("Relay Host identity/version mismatch");
      }
      const requestId = randomUUID();
      const initialized = this.#awaitResponse(requestId, "initialized");
      await this.#send({
        protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
        kind: "initialize",
        requestId,
        generation,
        nonce: ready.nonce,
        payload: {
          serverUrl: this.#options.serverUrl,
          userId: this.#options.userId,
          relayId: this.#relayId,
          ...(this.#options.token === undefined ? {} : { token: this.#options.token }),
          capabilities: this.#options.capabilities,
          desktopSessionId: this.#options.desktopSessionId,
          initialCapabilityRevision,
          runShellOwnerInstanceId: this.#options.runShellOwnerInstanceId ?? "",
          browserPageOwnerInstanceId: this.#options.browserPageOwnerInstanceId ?? "",
          ports: {
            mcp: this.#options.mcpHost !== undefined,
            sshPrepare: this.#options.onSshPrepare !== undefined,
            codex: this.#options.codexHostPort !== undefined,
            acp: this.#options.acpHostPort !== undefined,
            acpRegistrations: this.#options.acpHostPort?.registrations?.() ?? [],
            claudeConnection: this.#options.claudeConnectionHostPort !== undefined,
            claudeExecution: this.#options.claudeExecutionHostPort !== undefined,
          },
        },
      });
      const response = await this.#withStartTimeout(initialized);
      if (!response.ok) throw new Error(response.error ?? "Relay Host initialization failed");
      this.#applySnapshot(response.payload);
      for (const [serverName, tools] of this.#mcpTools) await this.#sendMcpTools(serverName, tools);
    } catch (error) {
      this.#intentionalClose = true;
      this.#hostFailed(child, generation, error);
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
      throw error;
    }
  }

  async #withStartTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Relay Host startup timed out")), RELAY_HOST_START_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #command(command: "connect" | "disconnect" | "update-capabilities", payload?: unknown): Promise<RelayHostCommandResultMessage> {
    await this.#ensureChild();
    const generation = this.#generation;
    if (generation === null) throw new Error("Relay Host is unavailable");
    const requestId = randomUUID();
    const result = this.#awaitResponse(requestId, "command-result");
    await this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "command",
      requestId,
      generation,
      command,
      ...(payload === undefined ? {} : { payload }),
    });
    const response = await result;
    if (response.kind !== "command-result") throw new Error("Relay Host returned the wrong response kind");
    if (!response.ok) throw new Error(response.error ?? `Relay Host ${command} failed`);
    return response;
  }

  #awaitResponse(requestId: string, expected: PendingRequest["expected"]): Promise<RelayHostCommandResultMessage | Extract<RelayHostChildMessage, { kind: "initialized" }>> {
    if (this.#pending.has(requestId)) return Promise.reject(new Error("Relay Host request ID collision"));
    return new Promise((resolve, reject) => this.#pending.set(requestId, { expected, resolve, reject }));
  }

  #receive(child: RelayHostProcess, generation: string, chunk: string | Uint8Array): void {
    if (child !== this.#child || generation !== this.#generation || this.#decoder === null) return;
    try {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk);
      for (const message of this.#decoder.push(bytes)) this.#routeMessage(child, generation, message as RelayHostChildMessage);
    } catch (error) {
      this.#hostFailed(child, generation, error);
      child.kill("SIGTERM");
    }
  }

  #routeMessage(child: RelayHostProcess, generation: string, message: RelayHostChildMessage): void {
    if (message.kind === "ready") {
      const waiter = this.#readyWaiter;
      this.#readyWaiter = null;
      if (waiter === null) return this.#hostFailed(child, generation, new Error("Unexpected Relay Host ready frame"));
      waiter.resolve(message);
      return;
    }
    if (message.generation !== generation) return;
    if (message.kind === "initialized" || message.kind === "command-result") {
      const pending = this.#pending.get(message.requestId);
      if (pending === undefined || pending.expected !== message.kind) return;
      this.#pending.delete(message.requestId);
      pending.resolve(message);
      return;
    }
    if (message.kind === "callback") {
      if (this.#activeCallbacks.has(message.requestId)) {
        this.#hostFailed(child, generation, new Error("Relay Host callback ID collision"));
        child.kill("SIGTERM");
        return;
      }
      void this.#handleCallback(message);
      return;
    }
    if (message.kind === "callback-cancelled") {
      this.#activeCallbacks.get(message.requestId)?.abort();
      this.#activeCallbacks.delete(message.requestId);
      return;
    }
    if (message.kind === "event") this.#handleEvent(message);
    else if (message.kind === "port-event") void this.#handlePortEvent(message);
  }

  async #handleCallback(message: RelayHostCallbackMessage): Promise<void> {
    if (message.generation !== this.#generation) return;
    const callbackGeneration = message.generation;
    const controller = new AbortController();
    this.#activeCallbacks.set(message.requestId, controller);
    try {
      let payload: unknown;
      if (message.callback === "capabilities") {
        payload = this.#options.getCapabilities
          ? await this.#options.getCapabilities()
          : this.#options.capabilities;
      } else if (message.callback === "dispatch") {
        if (!isRecord(message.payload) || typeof message.payload["toolName"] !== "string"
          || typeof message.payload["correlationId"] !== "string") throw new Error("Relay Host dispatch payload invalid");
        const request = message.payload as RelayDispatchRequest;
        const bridged: RelayDispatchRequest = {
          ...request,
          ...(request.toolName === "security_scan"
            ? { reportSecurityScanProgress: (progress) => { void this.#callbackEvent(callbackGeneration, message.requestId, "security-scan-progress", progress); } }
            : {}),
          ...(request.toolName === "run_shell"
            ? { reportRunShellProgress: (progress) => { void this.#callbackEvent(callbackGeneration, message.requestId, "run-shell-progress", progress); } }
            : {}),
          ...(request.toolName === "ssh" && request.executionClass === "structured-ssh"
            ? { reportStructuredSshProgress: (progress) => { void this.#callbackEvent(callbackGeneration, message.requestId, "structured-ssh-progress", progress); } }
            : {}),
        };
        payload = await this.#options.onDispatch(bridged, controller.signal);
      } else if (message.callback === "ssh-prepare") {
        if (this.#options.onSshPrepare === undefined) throw new Error("Structured SSH preparation is unavailable");
        payload = await this.#options.onSshPrepare(message.payload as never, controller.signal);
      } else if (message.callback === "mcp-configure") {
        if (!isRecord(message.payload) || !Array.isArray(message.payload["servers"])) throw new Error("MCP configure payload invalid");
        await this.#options.mcpHost?.configure(message.payload["servers"] as never);
      } else if (message.callback === "mcp-preflight") {
        if (!isRecord(message.payload) || this.#options.mcpHost?.preflight === undefined) throw new Error("MCP preflight unavailable");
        payload = await this.#options.mcpHost.preflight(message.payload["server"] as never);
      } else if (message.callback === "mcp-configure-with-outcome") {
        if (!isRecord(message.payload) || !Array.isArray(message.payload["servers"])
          || this.#options.mcpHost?.configureWithOutcome === undefined) throw new Error("MCP configure unavailable");
        payload = await this.#options.mcpHost.configureWithOutcome(
          message.payload["servers"] as never,
          message.payload["operation"] as never,
        );
      } else if (message.callback === "mcp-dispatch") {
        if (!isRecord(message.payload) || typeof message.payload["toolName"] !== "string"
          || !isRecord(message.payload["args"]) || this.#options.mcpHost === undefined) throw new Error("MCP dispatch payload invalid");
        payload = await this.#options.mcpHost.dispatch(message.payload["toolName"], message.payload["args"]);
      } else if (message.callback === "mcp-stop") {
        await this.#options.mcpHost?.stop?.();
      }
      await this.#callbackResult(callbackGeneration, message.requestId, true, payload);
    } catch (error) {
      await this.#callbackResult(callbackGeneration, message.requestId, false, undefined, callbackError(error));
    } finally {
      this.#activeCallbacks.delete(message.requestId);
    }
  }

  #handleEvent(message: RelayHostEventMessage): void {
    if (message.event === "status" && relayStatus(message.payload)) {
      this.#status = message.payload;
      this.#options.onStatusChange?.(message.payload);
      if (message.payload !== "connected") this.#acknowledgedCapabilityRevision = null;
    } else if (message.event === "topology") {
      const parsed = message.payload === null ? null : parseTopology(message.payload);
      if (message.payload !== null && (parsed === null
        || parsed.relayId !== this.#relayId
        || parsed.desktopSessionId !== this.#options.desktopSessionId)) {
        throw new Error("Relay Host topology event invalid");
      }
      this.#topology = parsed;
      this.#acknowledgedCapabilityRevision = this.#topology?.capabilityRevision ?? null;
      retainDesktopCapabilityRevision(this.#acknowledgedCapabilityRevision);
      this.#options.onDesktopTopologyChange?.(this.#topology);
    } else if (message.event === "authentication-required") {
      if (message.payload !== undefined) throw new Error("Relay Host authentication event invalid");
      void Promise.resolve(this.#options.onAuthenticationRequired?.()).catch(() => undefined);
    } else {
      throw new Error("Relay Host event payload invalid");
    }
  }

  async #handlePortEvent(message: RelayHostPortEventMessage): Promise<void> {
    const send = (transport: "codex" | "acp" | "claude-connection" | "claude-execution") => ({
      send: (payload: never) => this.#sendTransport(message.generation, transport, payload),
    });
    try {
      if (message.event === "codex-registered") await this.#options.codexHostPort?.onRegistered?.(message.payload as RelayCodexSession, send("codex"));
      else if (message.event === "codex-command") await this.#options.codexHostPort?.onCommand?.(message.payload as never);
      else if (message.event === "codex-cancel") await this.#options.codexHostPort?.onCancel?.(message.payload as never);
      else if (message.event === "codex-credit") await this.#options.codexHostPort?.onCredit?.(message.payload as never);
      else if (message.event === "codex-request-response") await this.#options.codexHostPort?.onRequestResponse?.(message.payload as never);
      else if (message.event === "codex-disconnected") this.#options.codexHostPort?.onDisconnected?.();
      else if (message.event === "acp-registered") await this.#options.acpHostPort?.onRegistered?.(message.payload as RelayAcpSession, send("acp"));
      else if (message.event === "acp-readiness") await this.#options.acpHostPort?.onReadiness?.(message.payload as never);
      else if (message.event === "acp-prepare") await this.#options.acpHostPort?.onPrepare?.(message.payload as never);
      else if (message.event === "acp-start") await this.#options.acpHostPort?.onStart?.(message.payload as never);
      else if (message.event === "acp-contain") await this.#options.acpHostPort?.onContain?.(message.payload as never);
      else if (message.event === "acp-disconnected") await this.#options.acpHostPort?.onDisconnected?.();
      else if (message.event === "claude-connection-registered") this.#options.claudeConnectionHostPort?.onRegistered(message.payload as RelayClaudeConnectionSession, send("claude-connection"));
      else if (message.event === "claude-connection-discover") this.#options.claudeConnectionHostPort?.onDiscover(message.payload as never);
      else if (message.event === "claude-connection-disconnected") await this.#options.claudeConnectionHostPort?.onDisconnected?.();
      else if (message.event === "claude-execution-registered") this.#options.claudeExecutionHostPort?.onRegistered(message.payload as RelayClaudeExecutionSession, send("claude-execution"));
      else if (message.event === "claude-execution-command") await this.#options.claudeExecutionHostPort?.onCommand(message.payload as never);
      else if (message.event === "claude-execution-disconnected") await this.#options.claudeExecutionHostPort?.onDisconnected?.();
    } catch {
      // A Desktop host adapter cannot destabilize the Relay transport.
    }
  }

  #sendTransport(expectedGeneration: string, transport: "codex" | "acp" | "claude-connection" | "claude-execution", payload: unknown): boolean {
    const child = this.#child;
    const generation = this.#generation;
    if (child === null || generation === null || generation !== expectedGeneration || child.exitCode !== null) return false;
    try {
      return child.stdin.write(encodeRelayHostFrame({
        protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
        kind: "transport-send",
        generation,
        transport,
        payload,
      }));
    } catch {
      return false;
    }
  }

  #callbackResult(generation: string, requestId: string, ok: boolean, payload?: unknown, error?: string): Promise<void> {
    if (generation !== this.#generation) return Promise.resolve();
    return this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "callback-result",
      generation,
      requestId,
      ok,
      ...(payload === undefined ? {} : { payload }),
      ...(error === undefined ? {} : { error }),
    });
  }

  #callbackEvent(generation: string, requestId: string, event: "run-shell-progress" | "structured-ssh-progress" | "security-scan-progress", payload: unknown): Promise<void> {
    if (generation !== this.#generation) return Promise.resolve();
    return this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "callback-event",
      generation,
      requestId,
      event,
      payload,
    });
  }

  #sendMcpTools(serverName: string, tools: readonly unknown[]): Promise<void> {
    const generation = this.#generation;
    if (generation === null || this.#child === null) return Promise.resolve();
    return this.#send({
      protocolVersion: RELAY_HOST_PROTOCOL_VERSION,
      kind: "mcp-tools-changed",
      generation,
      serverName,
      payload: tools,
    });
  }

  #send(message: Parameters<typeof encodeRelayHostFrame>[0]): Promise<void> {
    const child = this.#child;
    if (child === null || child.exitCode !== null) return Promise.reject(new Error("Relay Host is unavailable"));
    const frame = encodeRelayHostFrame(message);
    const next = this.#writeTail.then(async () => {
      if (child !== this.#child || child.exitCode !== null) throw new Error("Relay Host generation retired");
      if (child.stdin.write(frame)) return;
      await new Promise<void>((resolve, reject) => {
        child.stdin.once("drain", resolve);
        child.stdin.once("error", reject);
      });
    });
    this.#writeTail = next.catch(() => undefined);
    return next;
  }

  #applySnapshot(value: unknown): void {
    const parsed = snapshot(value);
    if (parsed === null || parsed.relayId !== this.#relayId
      || (parsed.topology !== null && (parsed.topology.relayId !== this.#relayId
        || parsed.topology.desktopSessionId !== this.#options.desktopSessionId))) {
      throw new Error("Relay Host snapshot invalid");
    }
    this.#status = parsed.status;
    this.#topology = parsed.topology;
    this.#acknowledgedCapabilityRevision = parsed.acknowledgedCapabilityRevision;
    retainDesktopCapabilityRevision(this.#acknowledgedCapabilityRevision);
  }

  #hostFailed(child: RelayHostProcess, generation: string, error: unknown): void {
    if (child !== this.#child || generation !== this.#generation) return;
    const failedDuringLaunch = this.#launching !== null;
    this.#child = null;
    this.#generation = null;
    this.#decoder = null;
    this.#readyWaiter?.reject(error);
    this.#readyWaiter = null;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const controller of this.#activeCallbacks.values()) controller.abort();
    this.#activeCallbacks.clear();
    this.#setDisconnected();
    this.#options.reportHostError?.(callbackError(error));
    if (this.#desiredConnected && !this.#intentionalClose && !failedDuringLaunch && !this.#replacementConsumed) {
      this.#replacementConsumed = true;
      queueMicrotask(() => {
        void this.#ensureChild()
          .then(() => this.#command("connect"))
          .then((response) => this.#applySnapshot(response.payload))
          .catch((failure) => this.#options.reportHostError?.(callbackError(failure)));
      });
    }
  }

  #setDisconnected(): void {
    const wasDisconnected = this.#status === "disconnected" && this.#topology === null;
    this.#status = "disconnected";
    this.#topology = null;
    this.#acknowledgedCapabilityRevision = null;
    if (!wasDisconnected) {
      this.#options.onStatusChange?.("disconnected");
      this.#options.onDesktopTopologyChange?.(null);
      try { this.#options.codexHostPort?.onDisconnected?.(); } catch { /* isolated */ }
      try { void Promise.resolve(this.#options.acpHostPort?.onDisconnected?.()).catch(() => undefined); } catch { /* isolated */ }
      try { void Promise.resolve(this.#options.claudeConnectionHostPort?.onDisconnected?.()).catch(() => undefined); } catch { /* isolated */ }
      try { void Promise.resolve(this.#options.claudeExecutionHostPort?.onDisconnected?.()).catch(() => undefined); } catch { /* isolated */ }
    }
  }
}

export function createDesktopRelaySidecarClient(options: DesktopRelaySidecarClientOptions): RelayClient {
  if (options.executablePath.length === 0 || options.executablePath.includes("\0")) {
    throw new Error("Relay Host executable path is invalid");
  }
  return new DesktopRelaySidecarClient(options);
}
