import {
  AcpHostRuntime,
  AcpHostRuntimeError,
  AcpPermissionUnsupportedError,
  AcpSemanticRelay,
  AcpTurnFaultOwner,
  AcpTurnSettlementGate,
  ACP_CANCELLATION_TERMINAL_WAIT_MS,
  ACP_TOTAL_TEARDOWN_TIMEOUT_MS,
  OPENCODE_ACP_INITIALIZE_TIMEOUT_MS,
  createAcpStableV1LiveSessionConnector,
  createNodeAcpProcessTreeAdapter,
  createNodeAcpSpawnAdapter,
  type AcpCanonicalLaunchAdmission,
  type AcpHostScope,
  type AcpLiveTurnRequest,
  type AcpProcessScope,
  type AcpRelayFrame,
} from "@nautilo/acp-host";
import type {
  AcpBindingScope,
  AcpExecutionScope,
  AcpSocketScope,
  RelayAcpHostPort,
  RelayAcpHostTransport,
  RelayAcpContainCommand,
  RelayAcpPrepareCommand,
  RelayAcpReadinessCommand,
  RelayAcpSession,
  RelayAcpStartCommand,
} from "@nautilo/relay";
import { OPENCODE_ACP_RELAY_PROTOCOL_VERSION } from "@nautilo/relay";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { normalize } from "node:path";
import {
  createOpenCodeAcpLaunchEnvironment,
  resolveReviewedOpenCodeLaunchAdmission,
} from "./opencode-acp-readiness-host";

/**
 * A quiet turn enters a local, privacy-safe possibly-stalled observation
 * state after this much time without exact process, byte, or protocol
 * movement. It is deliberately not a maximum turn duration or kill switch:
 * productive long-running work has no absolute expiry.
 */
const ACP_TURN_STALL_TIMEOUT_MS = 2 * 60_000;
const ACP_TURN_OBSERVATION_INTERVAL_MS = 10_000;
const ACP_PREPARE_START_WINDOW_MS = 60_000;
const ACP_RELAY_DELIVERY_MARGIN_MS = 5_000;
/** Opaque execution authority covers prepare, launch, cancel grace, and containment. */
export const ACP_EXECUTION_RECEIPT_LIFETIME_MS = ACP_PREPARE_START_WINDOW_MS + OPENCODE_ACP_INITIALIZE_TIMEOUT_MS +
  ACP_CANCELLATION_TERMINAL_WAIT_MS + ACP_TOTAL_TEARDOWN_TIMEOUT_MS +
  ACP_RELAY_DELIVERY_MARGIN_MS;
const MAX_PREPARED_RECEIPTS = 32;
/** Mirrors the runtime's reviewed child cap, including pre-session handshakes. */
const MAX_ACTIVE_STARTS = 4;
const MAX_CONTAINMENT_REFS = 128;
/** Permission requests remain host-owned and never enter a Nautilo request lane. */
const OPENCODE_ACP_EXECUTION_CAPABILITIES = Object.freeze({ requests: "unsupported" as const });
type OpenCodeAcpTerminalFailureDiagnostic =
  | "opencode-acp terminal_failure=end_turn_without_candidate"
  | "opencode-acp terminal_failure=max_tokens"
  | "opencode-acp terminal_failure=max_turn_requests"
  | "opencode-acp terminal_failure=refusal"
  | "opencode-acp terminal_failure=unowned_cancelled";
type OpenCodeAcpStartMarker = "accepted" | "launch_admitted" | "initialized" | "session_started" | "prompt_admitted";
type OpenCodeAcpStartFailureDiagnostic = `opencode-acp start_failure_after=${OpenCodeAcpStartMarker}`;
type OpenCodeAcpTurnHealthDiagnostic = "opencode-acp turn_health=possibly_stalled" | "opencode-acp turn_health=healthy";

export type ElectronOpenCodeAcpTurnClock = Readonly<{
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}>;
export type ElectronOpenCodeAcpTurnLimits = Readonly<{ stallTimeoutMs?: number; observationIntervalMs?: number }>;

export type ElectronOpenCodeAcpCurrentFolder = Readonly<{ path: string; revision: number }>;
export type ElectronOpenCodeAcpCurrentFolderAuthority = Readonly<{
  currentFolder(): ElectronOpenCodeAcpCurrentFolder | null;
}>;

type PreparedWorkspace = Readonly<{
  socket: AcpSocketScope;
  binding: AcpBindingScope;
  receipt: AcpExecutionScope["workspace"];
  selectionPath: string;
  path: string;
  revision: number;
  startBy: number;
  /** Monotonic Electron socket epoch; runtime generations restart on reconnect. */
  epoch: number;
}>;
type OpenCodeStartCommand = Extract<RelayAcpStartCommand, { registrationId: "opencode-acp" }>;
type StartIntent = Readonly<{ prepared: PreparedWorkspace; message: OpenCodeStartCommand }>;
type TurnHealthWatchdog = Readonly<{ progress(): void; close(): void }>;
type ProjectionGate = Readonly<{ published: Promise<void>; publish(): void; cancel(): void }>;
type Containment = Readonly<{ scope: AcpExecutionScope; process: AcpProcessScope; epoch: number; contain(): Promise<void> }>;
export type ElectronOpenCodeAcpRuntimeFactory = (input: Readonly<{
  resolveLaunch(bindingId: string): Promise<AcpCanonicalLaunchAdmission>;
  turnFor(bindingId: string, generation: number): AcpLiveTurnRequest | undefined;
  initializeTimeoutMs: typeof OPENCODE_ACP_INITIALIZE_TIMEOUT_MS;
}>) => AcpHostRuntime<number>;

/**
 * Electron's v15 OpenCode ACP execution owner. The relay sees receipt and semantic
 * facts only; this class retains paths, executable discovery, environment,
 * process groups, stdio and raw ACP in the main process.
 */
export class ElectronOpenCodeAcpExecutionHost implements RelayAcpHostPort {
  #session: RelayAcpSession | null = null;
  #transport: RelayAcpHostTransport | null = null;
  #prepared = new Map<string, PreparedWorkspace>();
  #starts = new Map<string, StartIntent>();
  #processes = new Map<string, AcpProcessScope>();
  #semantics = new Map<string, AcpSemanticRelay>();
  #executionCapabilities = new Map<string, { requests: "supported" | "unsupported" }>();
  #projectionGates = new Map<string, ProjectionGate>();
  #attemptedGenerations = new Map<string, number>();
  #deadlines = new Map<string, TurnHealthWatchdog>();
  #containments = new Map<string, Containment>();
  #containmentRefs = new Map<string, string>();
  /** Bounded, non-content launch progress retained only until start settles. */
  #startMarkers = new Map<string, OpenCodeAcpStartMarker>();
  #epoch = 0;
  #cleanup: Promise<boolean> | null = null;
  #runtime: AcpHostRuntime<number>;

  constructor(
    private readonly currentFolders: ElectronOpenCodeAcpCurrentFolderAuthority,
    options: Readonly<{
      runtime?: AcpHostRuntime<number>;
      runtimeFactory?: () => AcpHostRuntime<number>;
      createRuntime?: ElectronOpenCodeAcpRuntimeFactory;
      now?: () => number;
      mintId?: () => string;
      readiness?: RelayAcpHostPort;
      onAvailabilityChanged?: (ready: boolean) => void;
      launchAdmission?: () => Promise<AcpCanonicalLaunchAdmission>;
      terminalFailureDiagnostic?: (message: OpenCodeAcpTerminalFailureDiagnostic) => void;
      startFailureDiagnostic?: (message: OpenCodeAcpStartFailureDiagnostic) => void;
      turnHealthDiagnostic?: (message: OpenCodeAcpTurnHealthDiagnostic) => void;
      turnClock?: ElectronOpenCodeAcpTurnClock;
      turnLimits?: ElectronOpenCodeAcpTurnLimits;
    }> = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#mintId = options.mintId ?? randomUUID;
    this.#readiness = options.readiness;
    this.#onAvailabilityChanged = options.onAvailabilityChanged;
    this.#launchAdmission = options.launchAdmission;
    this.#terminalFailureDiagnostic = options.terminalFailureDiagnostic ?? ((message) => console.warn(message));
    this.#startFailureDiagnostic = options.startFailureDiagnostic ?? ((message) => console.warn(message));
    this.#turnHealthDiagnostic = options.turnHealthDiagnostic ?? ((message) => console.warn(message));
    this.#turnClock = options.turnClock ?? nodeTurnClock;
    this.#turnLimits = resolveTurnLimits(options.turnLimits);
    this.#runtimeFactory = options.runtimeFactory ?? (() => (options.createRuntime?.({
      resolveLaunch: (bindingId) => this.#resolveLaunch(bindingId),
      turnFor: (bindingId, generation) => this.#turnFor(bindingId, generation),
      initializeTimeoutMs: OPENCODE_ACP_INITIALIZE_TIMEOUT_MS,
    }) ?? new AcpHostRuntime({
      launches: { resolveAndRevalidate: (request) => this.#resolveLaunch(request.bindingId) },
      processes: createNodeAcpSpawnAdapter(),
      processTree: createNodeAcpProcessTreeAdapter(),
      readiness: createAcpStableV1LiveSessionConnector((request) => this.#turnFor(request.bindingId, request.generation)),
      initializeTimeoutMs: OPENCODE_ACP_INITIALIZE_TIMEOUT_MS,
    })));
    this.#runtime = options.runtime ?? this.#runtimeFactory();
  }

  readonly #now: () => number;
  readonly #mintId: () => string;
  readonly #readiness: RelayAcpHostPort | undefined;
  readonly #onAvailabilityChanged: ((ready: boolean) => void) | undefined;
  readonly #launchAdmission: (() => Promise<AcpCanonicalLaunchAdmission>) | undefined;
  readonly #terminalFailureDiagnostic: (message: OpenCodeAcpTerminalFailureDiagnostic) => void;
  readonly #startFailureDiagnostic: (message: OpenCodeAcpStartFailureDiagnostic) => void;
  readonly #turnHealthDiagnostic: (message: OpenCodeAcpTurnHealthDiagnostic) => void;
  readonly #turnClock: ElectronOpenCodeAcpTurnClock;
  readonly #turnLimits: Readonly<{ stallTimeoutMs: number; observationIntervalMs: number }>;
  readonly #runtimeFactory: () => AcpHostRuntime<number>;

  /** Do not advertise a runnable host while a prior socket's groups are unproven. */
  isReady(): boolean { return this.#cleanup === null; }

  onRegistered(session: RelayAcpSession, transport: RelayAcpHostTransport): void {
    if (session.selectedProtocolVersion < OPENCODE_ACP_RELAY_PROTOCOL_VERSION) {
      void this.onDisconnected();
      return;
    }
    this.#epoch += 1;
    this.#session = session;
    this.#transport = transport;
    this.#prepared.clear();
    this.#starts.clear();
    this.#processes.clear();
    this.#attemptedGenerations.clear();
    this.#semantics.clear();
    this.#executionCapabilities.clear();
    this.#containments.clear();
    this.#containmentRefs.clear();
    this.#startMarkers.clear();
    this.#cancelProjectionGates();
    this.#sequences.clear();
    this.#closeDeadlines();
    void this.#readiness?.onRegistered?.(session, transport);
  }

  async onDisconnected(): Promise<void> {
    const runtime = this.#runtime;
    this.#session = null;
    this.#transport = null;
    this.#prepared.clear();
    this.#starts.clear();
    this.#processes.clear();
    this.#attemptedGenerations.clear();
    this.#semantics.clear();
    this.#executionCapabilities.clear();
    this.#containments.clear();
    this.#containmentRefs.clear();
    this.#startMarkers.clear();
    this.#cancelProjectionGates();
    this.#sequences.clear();
    this.#closeDeadlines();
    const readinessCleanup = Promise.resolve(this.#readiness?.onDisconnected?.()).catch(() => undefined);
    // AcpHostRuntime is intentionally terminal after shutdown. Rotate only
    // this Electron-owned host runtime; old children remain contained and a
    // re-paired socket cannot inherit their binding state.
    this.#runtime = this.#runtimeFactory();
    const cleanup = runtime.shutdown();
    this.#cleanup = cleanup;
    void cleanup.then((safe) => {
      if (this.#cleanup === cleanup && safe) {
        this.#cleanup = null;
        try {
          this.#onAvailabilityChanged?.(true);
        } catch {
          // Availability notification is advisory and cannot revive an unsafe host.
        }
      }
    }).catch(() => undefined);
    await Promise.all([cleanup, readinessCleanup]);
  }

  onReadiness(message: RelayAcpReadinessCommand): void | Promise<void> {
    if (message.registrationId !== "opencode-acp" || !this.#acceptsSocket(message.scope)) return;
    if (this.currentFolders.currentFolder() === null) {
      this.#send({
        type: "relay:acp-readiness-result",
        requestId: message.requestId,
        registrationId: "opencode-acp",
        scope: message.scope,
        state: "unavailable",
      });
      return;
    }
    return this.#readiness?.onReadiness?.(message);
  }

  onContain(message: RelayAcpContainCommand): void {
    if (message.registrationId !== "opencode-acp" || message.code !== "upstream_failure" ||
      !this.#acceptsSocket(message.scope.socket)) return;
    const containment = this.#containments.get(message.process.connectionId);
    if (!containment || containment.epoch !== this.#epoch ||
      !sameExecutionScopes(message.scope, containment.scope) || !sameProcess(message.process, containment.process)) return;
    const fingerprint = JSON.stringify({ scope: message.scope, process: message.process, code: message.code });
    const prior = this.#containmentRefs.get(message.containmentRef);
    if (prior !== undefined && prior !== fingerprint) return;
    if (prior !== undefined) return;
    if (this.#containmentRefs.size >= MAX_CONTAINMENT_REFS) {
      const oldest = this.#containmentRefs.keys().next().value;
      if (typeof oldest === "string") this.#containmentRefs.delete(oldest);
    }
    this.#containmentRefs.set(message.containmentRef, fingerprint);
    void containment.contain().catch(() => undefined);
  }

  async onPrepare(message: RelayAcpPrepareCommand): Promise<void> {
    if (this.#cleanup || !this.#acceptsSocket(message.scope) || message.registrationId !== "opencode-acp") return;
    this.#prunePrepared();
    if (this.#prepared.size >= MAX_PREPARED_RECEIPTS || this.#bindingOccupied(message.binding.bindingId)) return;
    const folder = this.currentFolders.currentFolder();
    if (!folder) return;
    const path = await canonicalDirectory(folder.path);
    if (!path || this.#cleanup || !this.#acceptsSocket(message.scope) || !this.#sameFolder(folder)) return;
    const now = this.#now();
    const prepared: PreparedWorkspace = Object.freeze({
      socket: message.scope,
      binding: message.binding,
      receipt: Object.freeze({
        workspaceReceiptId: this.#mintId(),
        workspaceRevision: String(folder.revision),
        workspaceFingerprint: this.#mintId(),
        workspaceExpiresAt: new Date(now + ACP_EXECUTION_RECEIPT_LIFETIME_MS).toISOString(),
      }),
      selectionPath: folder.path,
      path,
      revision: folder.revision,
      startBy: now + ACP_PREPARE_START_WINDOW_MS,
      epoch: this.#epoch,
    });
    this.#prepared.set(prepared.receipt.workspaceReceiptId, prepared);
    this.#send({
      type: "relay:acp-prepared",
      requestId: message.requestId,
      registrationId: "opencode-acp",
      scope: message.scope,
      binding: message.binding,
      workspace: prepared.receipt,
    });
  }

  async onStart(message: RelayAcpStartCommand): Promise<void> {
    if (this.#cleanup || !this.#acceptsSocket(message.scope.socket) || message.registrationId !== "opencode-acp") return;
    this.#prunePrepared();
    const prepared = this.#prepared.get(message.scope.workspace.workspaceReceiptId);
    if (!prepared || !sameExecutionScope(message.scope, prepared) || !this.#prepareLive(prepared)) return;
    if (this.#bindingOccupied(message.scope.binding.bindingId) || this.#starts.size >= MAX_ACTIVE_STARTS) return;
    this.#starts.set(message.scope.binding.bindingId, Object.freeze({ prepared, message }));
    this.#prepared.delete(prepared.receipt.workspaceReceiptId);
    const runtime = this.#runtime;
    this.#recordStartMarker(message.scope.binding.bindingId, prepared.epoch, "accepted");
    let status;
    let startFailed = false;
    try {
      status = await runtime.start({ bindingId: message.scope.binding.bindingId, registrationId: "opencode-acp" });
    } catch {
      startFailed = true;
      this.#starts.delete(message.scope.binding.bindingId);
      const marker = this.#takeStartMarker(message.scope.binding.bindingId, prepared.epoch);
      if (marker) {
        try {
          this.#startFailureDiagnostic(`opencode-acp start_failure_after=${marker}`);
        } catch {
          // This bounded local diagnostic cannot change start containment.
        }
      }
      const attempted = this.#attemptedGenerations.get(bindingEpochKey(message.scope.binding.bindingId, prepared.epoch));
      if (attempted !== undefined) this.#discardProcess(message.scope.binding.bindingId, attempted, prepared.epoch);
      // AcpHostRuntime settles its exact child before rejecting start. A
      // cleanup-uncertain rejection is not reportable: withdraw this socket's
      // host rather than pretending a process-less start failure is safe.
      const runtimeState = (runtime as Readonly<{ status?: (bindingId: string) => Readonly<{ state: string }> }>).status
        ?.call(runtime, message.scope.binding.bindingId)?.state;
      if (runtimeState === "cleanup_uncertain") {
        void this.onDisconnected();
        return;
      }
      if (marker && prepared.epoch === this.#epoch && this.#acceptsSocket(message.scope.socket)) {
        this.#emitStartFailed(message.scope, marker);
      }
      return;
    } finally {
      if (!startFailed) this.#clearStartMarker(message.scope.binding.bindingId, prepared.epoch);
    }
    this.#starts.delete(message.scope.binding.bindingId);
    if (status.state !== "ready" || prepared.epoch !== this.#epoch || !this.#acceptsSocket(message.scope.socket)) {
      this.#discardProcess(message.scope.binding.bindingId, status.generation, prepared.epoch);
      await runtime.stop(message.scope.binding.bindingId, status.generation).catch(() => undefined);
      return;
    }
    const binding = runtime.binding(message.scope.binding.bindingId, status.generation);
    if (!binding.turn) {
      this.#discardProcess(message.scope.binding.bindingId, status.generation, prepared.epoch);
      await runtime.stop(message.scope.binding.bindingId, status.generation).catch(() => undefined);
      return;
    }
    await this.#observeOneTurn(message, status.generation, prepared.epoch, runtime, binding, binding.turn.bind(binding));
  }

  #turnFor(bindingId: string, generation: number): AcpLiveTurnRequest | undefined {
    const intent = this.#starts.get(bindingId);
    if (!intent || !this.#prepareLive(intent.prepared)) return undefined;
    const { message } = intent;
    let semantic: AcpSemanticRelay | undefined;
    const projectionGate = createProjectionGate();
    return {
      prompt: message.prompt,
      // Autonomous and interactive alter only permission posture. Omitting a
      // mode lets the owner's configured primary/current OpenCode mode govern.
      ...(message.executionProfile === "plan" ? { sessionModeId: "plan" } : {}),
      onNegotiated: () => {
        this.#recordStartMarker(bindingId, intent.prepared.epoch, "initialized");
        this.#recordProtocolProgress(bindingId, generation, intent);
      },
      onSessionStarted: ({ sessionId, capabilities }) => {
        this.#recordStartMarker(bindingId, intent.prepared.epoch, "session_started");
        this.#recordProtocolProgress(bindingId, generation, intent);
        const process: AcpProcessScope = Object.freeze({
          connectionId: this.#mintId(), processGeneration: generation, acpSessionId: sessionId,
          turnGeneration: 1, turnRef: this.#mintId(),
        });
        semantic = new AcpSemanticRelay({
          scope: toHostScope(message.scope), process, roomId: null, capabilities,
          mintRequestId: this.#mintId,
          onTerminalFailure: (reason) => {
            try {
              this.#terminalFailureDiagnostic(
                `opencode-acp terminal_failure=${reason}` as OpenCodeAcpTerminalFailureDiagnostic,
              );
            } catch {
              // This bounded local diagnostic cannot change terminal truth.
            }
          },
          emit: (frame) => {
            // A late operation from a shut-down runtime can settle after a
            // successor reused its local generation. It has no transport
            // authority or shared-watchdog authority in the new socket epoch.
            if (
              intent.prepared.epoch !== this.#epoch ||
              !this.#acceptsSocket(message.scope.socket)
            ) return;
            if (frame.payload.kind !== "terminal") {
              if (this.#processes.get(processKey(bindingId, generation, intent.prepared.epoch)) !== process) return;
              this.#recordProtocolProgress(bindingId, generation, intent);
              this.#deadlines.get(process.connectionId)?.progress();
            }
            return this.#emitSemantic(message.scope, process, OPENCODE_ACP_EXECUTION_CAPABILITIES, frame.payload);
          },
        });
        this.#processes.set(processKey(bindingId, generation, intent.prepared.epoch), process);
        this.#attemptedGenerations.set(bindingEpochKey(bindingId, intent.prepared.epoch), generation);
        this.#semantics.set(process.connectionId, semantic);
        this.#executionCapabilities.set(process.connectionId, OPENCODE_ACP_EXECUTION_CAPABILITIES);
        this.#projectionGates.set(process.connectionId, projectionGate);
      },
      onPromptAdmitted: () => {
        this.#recordStartMarker(bindingId, intent.prepared.epoch, "prompt_admitted");
        this.#recordProtocolProgress(bindingId, generation, intent);
      },
      onEvent: async (event) => {
        try { await projectionGate.published; } catch { return; }
        this.#recordProtocolProgress(bindingId, generation, intent);
        const process = this.#processes.get(processKey(bindingId, generation, intent.prepared.epoch));
        if (process) this.#deadlines.get(process.connectionId)?.progress();
        await semantic?.project(event);
      },
      onStopping: () => {
        const process = this.#processes.get(processKey(bindingId, generation, intent.prepared.epoch));
        if (process && semantic) semantic.beginStop(process);
      },
      onPermission: (request) => {
        if (message.executionProfile !== "autonomous") {
          throw new AcpPermissionUnsupportedError();
        }
        const allowOnce = request.options.filter((option) => option.kind === "allow_once");
        if (allowOnce.length !== 1) throw new AcpPermissionUnsupportedError();
        return { outcome: "selected", optionId: allowOnce[0]!.optionId };
      },
    };
  }

  async #observeOneTurn(
    message: OpenCodeStartCommand,
    generation: number,
    epoch: number,
    runtime: AcpHostRuntime<number>,
    binding: NonNullable<ReturnType<AcpHostRuntime<number>["binding"]>>,
    turn: NonNullable<ReturnType<AcpHostRuntime<number>["binding"]>["turn"]>,
  ): Promise<void> {
    try {
      const process = this.#processes.get(processKey(message.scope.binding.bindingId, generation, epoch));
      if (!process) throw new Error("ACP process binding is unavailable");
      const semantic = this.#semantics.get(process.connectionId);
      if (!semantic) throw new Error("ACP semantic binding is unavailable");
      const owner = new AcpTurnFaultOwner({
        process,
        relay: semantic,
        settlement: new AcpTurnSettlementGate(process),
        teardown: async (scope) => {
          if (scope.processGeneration === generation) await runtime.stop(message.scope.binding.bindingId, generation).catch(() => undefined);
        },
      });
      const operation = turn();
      this.#containments.set(process.connectionId, Object.freeze({
        scope: message.scope,
        process,
        epoch,
        contain: () => this.#deadlineFault({
          process, settlement: owner.options.settlement, relay: semantic, binding, operation, runtime,
          bindingId: message.scope.binding.bindingId, generation, epoch,
        }),
      }));
      const deadline = this.#armHealthWatchdog(
        () => this.#deadlineFault({
        process, settlement: owner.options.settlement, relay: semantic, binding, operation, runtime,
        bindingId: message.scope.binding.bindingId, generation, epoch,
        }),
        () => runtime.health(message.scope.binding.bindingId, generation),
        (state) => {
          if (epoch !== this.#epoch || !this.#acceptsSocket(message.scope.socket)) return;
          if (this.#processes.get(processKey(message.scope.binding.bindingId, generation, epoch)) !== process) return;
          this.#emitRuntimeStatus(message.scope, process, OPENCODE_ACP_EXECUTION_CAPABILITIES, state);
        },
      );
      this.#deadlines.set(process.connectionId, deadline);
      const capabilities = this.#executionCapabilities.get(process.connectionId);
      if (!capabilities) throw new Error("ACP capability binding is unavailable");
      this.#emitStarted(message.scope, process, capabilities);
      this.#projectionGates.get(process.connectionId)?.publish();
      this.#projectionGates.delete(process.connectionId);
      await owner.observe(process, operation);
    } finally {
      this.#discardProcess(message.scope.binding.bindingId, generation, epoch);
      await runtime.stop(message.scope.binding.bindingId, generation).catch(() => undefined);
    }
  }

  #discardProcess(bindingId: string, generation: number, epoch: number): void {
    const key = processKey(bindingId, generation, epoch);
    const process = this.#processes.get(key);
    if (process) {
      this.#deadlines.get(process.connectionId)?.close();
      this.#deadlines.delete(process.connectionId);
      this.#semantics.delete(process.connectionId);
      this.#containments.delete(process.connectionId);
      this.#executionCapabilities.delete(process.connectionId);
      this.#projectionGates.get(process.connectionId)?.cancel();
      this.#projectionGates.delete(process.connectionId);
      this.#sequences.delete(process.connectionId);
    }
    this.#processes.delete(key);
    const bindingKey = bindingEpochKey(bindingId, epoch);
    if (this.#attemptedGenerations.get(bindingKey) === generation) this.#attemptedGenerations.delete(bindingKey);
  }

  #recordStartMarker(bindingId: string, epoch: number, marker: OpenCodeAcpStartMarker): void {
    const intent = this.#starts.get(bindingId);
    if (!intent || intent.prepared.epoch !== epoch) return;
    this.#startMarkers.set(bindingEpochKey(bindingId, epoch), marker);
  }

  #recordProtocolProgress(bindingId: string, generation: number, intent: StartIntent): void {
    if (intent.prepared.epoch !== this.#epoch || !this.#acceptsSocket(intent.message.scope.socket)) return;
    // Production runtimes always implement the additive health API. The
    // optional shape keeps a failed or legacy test/runtime stub from turning
    // harmless protocol projection into a start failure.
    (this.#runtime as Readonly<{ recordProtocolProgress?: (id: string, currentGeneration: number) => void }>)
      .recordProtocolProgress?.(bindingId, generation);
  }

  #takeStartMarker(bindingId: string, epoch: number): OpenCodeAcpStartMarker | undefined {
    const key = bindingEpochKey(bindingId, epoch);
    const marker = this.#startMarkers.get(key);
    this.#startMarkers.delete(key);
    return marker;
  }

  #clearStartMarker(bindingId: string, epoch: number): void {
    this.#startMarkers.delete(bindingEpochKey(bindingId, epoch));
  }

  #closeDeadlines(): void {
    for (const deadline of this.#deadlines.values()) deadline.close();
    this.#deadlines.clear();
  }

  #cancelProjectionGates(): void {
    for (const gate of this.#projectionGates.values()) gate.cancel();
    this.#projectionGates.clear();
  }

  #bindingOccupied(bindingId: string): boolean {
    const prefix = `${this.#epoch}\u0000${bindingId}\u0000`;
    return this.#starts.has(bindingId) || this.#attemptedGenerations.has(bindingEpochKey(bindingId, this.#epoch)) ||
      [...this.#processes.keys()].some((key) => key.startsWith(prefix));
  }

  async #deadlineFault(input: Readonly<{
    process: AcpProcessScope;
    settlement: AcpTurnSettlementGate;
    relay: AcpSemanticRelay;
    binding: NonNullable<ReturnType<AcpHostRuntime<number>["binding"]>>;
    operation: Promise<Awaited<ReturnType<NonNullable<ReturnType<AcpHostRuntime<number>["binding"]>["turn"]>>>>;
    runtime: AcpHostRuntime<number>;
    bindingId: string;
    generation: number;
    epoch: number;
  }>): Promise<void> {
    if (!input.settlement.settleFault(input.process)) return;
    // Deadline containment follows the locked cancellation ordering once.
    // It never grants user-Stop terminal semantics: the eventual result is
    // ignored and this host publishes one sanitized upstream failure below.
    const stopWrite = input.binding.close().catch(() => undefined);
    await this.#waitForCancellation(stopWrite, input.operation);
    await input.runtime.stop(input.bindingId, input.generation).catch(() => undefined);
    await input.relay.fail("upstream_failure").catch(() => undefined);
  }

  async #waitForCancellation(stopWrite: Promise<void>, operation: Promise<unknown>): Promise<void> {
    let handle: unknown;
    try {
      await Promise.race([
        Promise.all([stopWrite, operation.then(() => undefined, () => undefined)]).then(() => undefined),
        new Promise<void>((resolve) => { handle = this.#turnClock.setTimeout(resolve, 10_000); }),
      ]);
    } finally {
      if (handle !== undefined) this.#turnClock.clearTimeout(handle);
    }
  }

  #armHealthWatchdog(
    expireTurn: () => Promise<void>,
    sample: () => Promise<Awaited<ReturnType<AcpHostRuntime<number>["health"]>>>,
    emitStatus: (state: "possibly_stalled" | "healthy") => void,
  ): TurnHealthWatchdog {
    let closed = false;
    let possiblyStalledHandle: unknown;
    let observationHandle: unknown;
    let prior: string | undefined;
    let possiblyStalled = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (possiblyStalledHandle !== undefined) this.#turnClock.clearTimeout(possiblyStalledHandle);
      if (observationHandle !== undefined) this.#turnClock.clearTimeout(observationHandle);
    };
    const expire = (): void => {
      if (closed) return;
      close();
      // A deadline is host containment, never a user Stop. The settlement
      // gate synchronously fences any late prompt result before teardown.
      void expireTurn().catch(() => undefined);
    };
    const progress = (): void => {
      if (closed) return;
      if (possiblyStalledHandle !== undefined) this.#turnClock.clearTimeout(possiblyStalledHandle);
      if (possiblyStalled) {
        possiblyStalled = false;
        try { this.#turnHealthDiagnostic("opencode-acp turn_health=healthy"); } catch { /* diagnostics are advisory */ }
        try { emitStatus("healthy"); } catch { /* status emission is advisory until the exact turn closes */ }
      }
      possiblyStalledHandle = this.#turnClock.setTimeout(() => {
        if (closed || possiblyStalled) return;
        possiblyStalled = true;
        try { this.#turnHealthDiagnostic("opencode-acp turn_health=possibly_stalled"); } catch { /* diagnostics are advisory */ }
        try { emitStatus("possibly_stalled"); } catch { /* status emission is advisory until the exact turn closes */ }
      }, this.#turnLimits.stallTimeoutMs);
    };
    const observe = (): void => {
      if (closed) return;
      void sample().then((snapshot) => {
        if (closed) return;
        // Group existence by itself is not liveness. A missing/exited exact
        // generation is instead an immediate containment condition.
        if (!snapshot.groupPresent || snapshot.exited) {
          expire();
          return;
        }
        const movement = `${snapshot.stdoutBytes}\u0000${snapshot.stderrBytes}\u0000${snapshot.protocolEvents}\u0000${snapshot.processCount}\u0000${snapshot.descendantCount}\u0000${snapshot.cpuTimeMs}`;
        if (prior !== undefined && movement !== prior) progress();
        prior = movement;
        observationHandle = this.#turnClock.setTimeout(observe, this.#turnLimits.observationIntervalMs);
      }).catch(() => {
        // `AcpHostRuntime.health` converts optional observer failures to an
        // unavailable metadata signal. A rejection here therefore means this
        // exact generation is no longer sampleable (for example, it exited
        // and was settled), not merely that an optional signal was absent.
        expire();
      });
    };
    progress();
    observationHandle = this.#turnClock.setTimeout(observe, this.#turnLimits.observationIntervalMs);
    return Object.freeze({ progress, close });
  }

  async #resolveLaunch(bindingId: string): Promise<AcpCanonicalLaunchAdmission> {
    const prepared = this.#starts.get(bindingId)?.prepared;
    if (!prepared || !this.#prepareLive(prepared)) throw new AcpHostRuntimeError("unavailable", "ACP workspace receipt is unavailable");
    const folder = this.currentFolders.currentFolder();
    if (!folder || folder.revision !== prepared.revision || folder.path !== prepared.selectionPath) {
      throw new AcpHostRuntimeError("unavailable", "ACP workspace receipt is stale");
    }
    const canonical = await canonicalDirectory(folder.path);
    if (canonical !== prepared.path) throw new AcpHostRuntimeError("unavailable", "ACP workspace receipt is stale");
    const admission = this.#launchAdmission
      ? await this.#launchAdmission()
      : await resolveReviewedOpenCodeLaunchAdmission().then((executable) => executable === null ? null : Object.freeze({ executablePath: executable.executable, cwd: canonical, environment: createOpenCodeAcpLaunchEnvironment(executable.pathEntries) }));
    // Discovery/probes may take seconds. The workspace authority is checked
    // again immediately before spawn admission, not just before probing.
    const finalFolder = this.currentFolders.currentFolder();
    if (!finalFolder || finalFolder.revision !== prepared.revision || finalFolder.path !== prepared.selectionPath) {
      throw new AcpHostRuntimeError("unavailable", "ACP workspace receipt is stale");
    }
    const finalCanonical = await canonicalDirectory(finalFolder.path);
    if (finalCanonical !== prepared.path) throw new AcpHostRuntimeError("unavailable", "ACP workspace receipt is stale");
    if (!admission || admission.cwd !== finalCanonical) throw new AcpHostRuntimeError("unavailable", "ACP workspace receipt is stale");
    this.#recordStartMarker(bindingId, prepared.epoch, "launch_admitted");
    return admission;
  }

  #prepareLive(prepared: PreparedWorkspace): boolean {
    return prepared.startBy > this.#now() && Date.parse(prepared.receipt.workspaceExpiresAt) > this.#now() && this.#sameFolder({ path: prepared.selectionPath, revision: prepared.revision });
  }

  #prunePrepared(): void {
    for (const [id, prepared] of this.#prepared) {
      if (!this.#prepareLive(prepared)) this.#prepared.delete(id);
    }
  }

  #sameFolder(expected: ElectronOpenCodeAcpCurrentFolder): boolean {
    const current = this.currentFolders.currentFolder();
    return current?.path === expected.path && current.revision === expected.revision;
  }

  #acceptsSocket(scope: AcpSocketScope): boolean { return this.#session !== null && sameSocket(this.#session, scope); }

  #send(message: Parameters<RelayAcpHostTransport["send"]>[0]): void {
    if (!this.#transport?.send(message)) throw new Error("ACP relay transport is unavailable");
  }

  #emitStarted(scope: AcpExecutionScope, process: AcpProcessScope, capabilities: { requests: "supported" | "unsupported" }): void {
    this.#send({ type: "relay:acp-started", registrationId: "opencode-acp", scope, process, capabilities, eventId: this.#mintId(), eventSequence: 1 });
  }

  #emitStartFailed(scope: AcpExecutionScope, stage: OpenCodeAcpStartMarker): void {
    this.#send({ type: "relay:acp-start-failed", registrationId: "opencode-acp", scope, stage });
  }

  #emitSemantic(scope: AcpExecutionScope, process: AcpProcessScope, capabilities: { requests: "supported" | "unsupported" }, payload: AcpRelayFrame["payload"]): void {
    // AcpSemanticRelay already bounds and canonicalizes payloads; this is only
    // the final v15 typed frame projection and never forwards raw ACP data.
    const event = { eventId: this.#mintId(), eventSequence: this.#nextSequence(process) };
    if (payload.kind === "terminal") {
      this.#send({ type: "relay:acp-terminal", registrationId: "opencode-acp", scope, process, status: payload.status, ...(payload.code === undefined ? {} : { code: payload.code }), ...event });
      return;
    }
    if (payload.kind === "permission_selection_required") {
      throw new Error("ACP permissions are not enabled");
    }
    this.#send({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process, capabilities, payload: payload.kind === "command_summary"
      ? { kind: payload.kind, vendorItemId: payload.attribution.vendorItemId, commands: payload.commands }
      : { kind: payload.kind, vendorItemId: payload.attribution.vendorItemId, text: payload.text }, ...event });
  }

  #emitRuntimeStatus(scope: AcpExecutionScope, process: AcpProcessScope, capabilities: { requests: "supported" | "unsupported" }, state: "possibly_stalled" | "healthy"): void {
    // Health is advisory. Reserve its sequence locally only after the relay
    // accepted this exact synchronous frame, so a rejected progress update
    // cannot create a gap that faults the next authoritative semantic/terminal.
    const key = process.connectionId;
    const eventSequence = (this.#sequences.get(key) ?? 1) + 1;
    this.#send({ type: "relay:acp-semantic", registrationId: "opencode-acp", scope, process, capabilities, payload: { kind: "runtime_status", state }, eventId: this.#mintId(), eventSequence });
    this.#sequences.set(key, eventSequence);
  }

  #sequences = new Map<string, number>();
  #nextSequence(process: AcpProcessScope): number {
    const key = process.connectionId;
    const next = (this.#sequences.get(key) ?? 1) + 1;
    this.#sequences.set(key, next);
    return next;
  }
}

function toHostScope(scope: AcpExecutionScope): AcpHostScope {
  return Object.freeze({ ...scope.socket, ...scope.binding, ...scope.workspace });
}
async function canonicalDirectory(candidate: string): Promise<string | null> {
  try {
    const real = await fs.realpath(candidate);
    if (normalize(real) !== real || !(await fs.stat(real)).isDirectory()) return null;
    return real;
  } catch { return null; }
}
function sameSocket(left: AcpSocketScope, right: AcpSocketScope): boolean {
  return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef && left.selectedProtocolVersion === right.selectedProtocolVersion && left.capabilityRevision === right.capabilityRevision;
}
function sameBinding(left: AcpBindingScope, right: AcpBindingScope): boolean {
  return left.bindingId === right.bindingId && left.bindingGeneration === right.bindingGeneration && left.ownerId === right.ownerId && left.taskId === right.taskId && left.taskRunId === right.taskRunId && left.jobId === right.jobId && left.profileId === right.profileId && left.profileGeneration === right.profileGeneration && left.postureId === right.postureId && left.postureGeneration === right.postureGeneration;
}
function sameWorkspace(left: AcpExecutionScope["workspace"], right: AcpExecutionScope["workspace"]): boolean { return left.workspaceReceiptId === right.workspaceReceiptId && left.workspaceRevision === right.workspaceRevision && left.workspaceFingerprint === right.workspaceFingerprint && left.workspaceExpiresAt === right.workspaceExpiresAt; }
function sameExecutionScope(scope: AcpExecutionScope, prepared: PreparedWorkspace): boolean { return sameSocket(scope.socket, prepared.socket) && sameBinding(scope.binding, prepared.binding) && sameWorkspace(scope.workspace, prepared.receipt); }
function sameExecutionScopes(left: AcpExecutionScope, right: AcpExecutionScope): boolean { return sameSocket(left.socket, right.socket) && sameBinding(left.binding, right.binding) && sameWorkspace(left.workspace, right.workspace); }
function sameProcess(left: AcpProcessScope, right: AcpProcessScope): boolean { return left.connectionId === right.connectionId && left.processGeneration === right.processGeneration && left.acpSessionId === right.acpSessionId && left.turnGeneration === right.turnGeneration && left.turnRef === right.turnRef; }
function bindingEpochKey(bindingId: string, epoch: number): string { return `${epoch}\u0000${bindingId}`; }
function processKey(bindingId: string, generation: number, epoch: number): string { return `${bindingEpochKey(bindingId, epoch)}\u0000${generation}`; }

const nodeTurnClock: ElectronOpenCodeAcpTurnClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function resolveTurnLimits(input: ElectronOpenCodeAcpTurnLimits | undefined): Readonly<{ stallTimeoutMs: number; observationIntervalMs: number }> {
  const stallTimeoutMs = input?.stallTimeoutMs ?? ACP_TURN_STALL_TIMEOUT_MS;
  const observationIntervalMs = input?.observationIntervalMs ?? ACP_TURN_OBSERVATION_INTERVAL_MS;
  if (
    !Number.isSafeInteger(stallTimeoutMs) || !Number.isSafeInteger(observationIntervalMs) ||
    stallTimeoutMs < 1 || observationIntervalMs < 1 || observationIntervalMs > stallTimeoutMs
  ) throw new Error("ACP turn deadline limits are invalid");
  return Object.freeze({ stallTimeoutMs, observationIntervalMs });
}

function createProjectionGate(): ProjectionGate {
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const published = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Cancellation may race before `onEvent` observes the gate.
  void published.catch(() => undefined);
  return Object.freeze({
    published,
    publish: () => { if (!settled) { settled = true; resolve(); } },
    cancel: () => { if (!settled) { settled = true; reject(new Error("ACP projection was cancelled")); } },
  });
}
