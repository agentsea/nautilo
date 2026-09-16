import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type {
  BindingOpenScope,
  BindingIdentityScope,
  BindingScope,
  CodexHostStatus,
  CodexStableErrorCode,
  ProfileLaunchScope,
  ProfileScope,
  RelayCodexBindingCommandResponse,
  RelayCodexBindingOpenCommandResponse,
  RelayCodexClientMessage,
  RelayCodexHostTransport,
  RelayCodexHostPort,
  RelayCodexProfileCommandResponse,
  RelayCodexServerMessage,
  RelayCodexSession,
  TurnScope,
  WorkspaceReceipt as RelayWorkspaceReceipt,
} from "@nautilo/relay";
import { CODEX_STREAMED_COMPLETION_PROTOCOL_VERSION } from "@nautilo/relay";
import type {
  DecodedServerNotification,
  EnabledServerRequestMethod,
  ServerRequestContext,
  ServerRequestParamsMap,
  ServerRequestResponseMap,
  ThreadItemProjection,
} from "@nautilo/codex-app-server";
import type {
  AppServerClientFactory,
  BoundThread,
  ChildIdentity,
  CodexBindingStore,
  CurrentFolderSnapshot,
  HostClock,
  HostFilesystem,
  ProfileHomeRemovalFilesystem,
  HostTimer,
  BindingOpenReservation,
  BindingRebindReservation,
  PersistedBindingRecord,
  ProcessHost,
  RuntimeProvider,
  TurnTerminalWaiter,
  WorkspaceReceipt,
  OpaqueHandle,
} from "@nautilo/codex-app-server-host/internal";
import {
  CodexProfileHomeRegistry,
  CodexProfileSupervisor,
  CodexServiceDirectory,
  CodexRelayHostPort as SharedCodexRelayHostPort,
  CodexWorkspaceReceiptAuthority,
  sameReservationAuthority,
  toRelayWorkspaceReceipt,
} from "@nautilo/codex-app-server-host/internal";
import { CodexHostError } from "@nautilo/codex-app-server-host";
import { createNodeProcessHost, nodeProfileHomeRemovalFilesystem } from "@nautilo/codex-app-server-host/node";
import {
  ElectronCodexController,
  ElectronCodexControllerError,
  type ElectronCodexAdminPort,
  type ElectronCodexControllerOptions,
} from "./codex-controller.ts";
import {
  dispatchCodexHumanServerRequest,
  type CodexHumanRelayResponse,
  type CodexHumanRequestMethod,
  type ProjectedCodexHumanRequest,
} from "./codex-request-proxy.ts";
import { ElectronCodexRequestBroker } from "./codex-request-broker.ts";
import type { ElectronCodexTurnTerminalTracker } from "./codex-turn-terminal.ts";

/** Minimal per-session callback authority needed to construct typed clients. */
export interface ElectronCodexClientCallbackBuilderInput {
  readonly isCurrent: (child: ChildIdentity) => boolean;
  readonly onClientFault: (child: ChildIdentity) => Promise<void>;
  readonly onNotification: (
    child: ChildIdentity,
    notification: DecodedServerNotification,
  ) => Promise<void>;
  readonly onServerRequest: <M extends EnabledServerRequestMethod>(
    child: ChildIdentity,
    method: M,
    params: ServerRequestParamsMap[M],
    context: ServerRequestContext,
  ) => Promise<ServerRequestResponseMap[M]>;
}

type CodexCommand = Extract<RelayCodexServerMessage, { readonly type: "relay:codex-command" }>;
type CodexCancel = Extract<RelayCodexServerMessage, { readonly type: "relay:codex-cancel" }>;

type ElectronCodexHumanRequestDispatcher = <M extends CodexHumanRequestMethod>(input: {
  readonly child: ChildIdentity;
  readonly binding: PersistedBindingRecord;
  readonly method: M;
  readonly params: ServerRequestParamsMap[M];
  readonly context: ServerRequestContext;
  readonly projected: ProjectedCodexHumanRequest;
}) => Promise<CodexHumanRelayResponse>;

/** Host-only services; tests inject fakes and never start a real Codex process. */
export interface ElectronCodexHostServices {
  mintWorkspace(): Promise<{ readonly local: WorkspaceReceipt; readonly wire: RelayWorkspaceReceipt }>;
  resolveWorkspace(scope: ProfileLaunchScope, receipt: RelayWorkspaceReceipt): Promise<WorkspaceReceipt>;
  invalidateWorkspaces(): void;
  /** Account-only child admission deliberately does not resolve a working directory. */
  ensure(scope: ProfileLaunchScope): Promise<ChildIdentity>;
  /** One controller delegates account/admin work to this service's supervisor. */
  readonly admin?: ElectronCodexAdminPort;
  open(scope: BindingOpenScope, input: Extract<CodexCommand["command"], { readonly kind: "open_binding" }>): Promise<BoundThread>;
  resume(scope: BindingScope): Promise<BoundThread>;
  release(scope: BindingScope): Promise<void>;
  rebind(scope: BindingIdentityScope, workspace: RelayWorkspaceReceipt, generation: number): Promise<BoundThread>;
  start(
    scope: BindingScope,
    input: {
      readonly text: string;
      readonly clientUserMessageId: string;
      readonly collaborationMode: "work" | "plan";
    },
  ): Promise<{ readonly turnId: string }>;
  interrupt(scope: TurnScope): Promise<void>;
  steer(
    scope: TurnScope,
    input: { readonly text: string; readonly actorRef: string },
  ): Promise<void>;
  setNotificationSink(
    sink: (
      child: ChildIdentity,
      binding: PersistedBindingRecord,
      notification: DecodedServerNotification,
    ) => void,
  ): void;
  setRequestSink(dispatcher: ElectronCodexHumanRequestDispatcher): void;
  drain(scope: ProfileScope): Promise<void>;
  /** Read-only lifecycle fence; no host path or binding detail crosses this seam. */
  hasActiveWork(): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface ElectronCodexHostOptions {
  readonly currentActorId: () => string | null;
  readonly createServices: (session: RelayCodexSession) => Promise<ElectronCodexHostServices>;
  readonly status: () => Omit<CodexHostStatus, "workspace">;
}

export interface ElectronCodexHostServiceFactoryOptions {
  readonly actorId: () => string | null;
  /** Optional convenience default read when each new Codex thread opens. */
  readonly currentFolder: () => Readonly<{ path: string; revision: number }> | null;
  /** Existing always-available Genie Workspace; not a filesystem grant. */
  readonly defaultWorkingDirectory: string;
  readonly profileHomesRoot: string;
  readonly profileHomesTrustedParent: string;
  /** One private cwd authority shared by the service factory's one supervisor. */
  readonly serviceDirectory?: CodexServiceDirectory;
  readonly bindingStateFile: string;
  readonly hmacKey: Uint8Array | string;
  readonly filesystem?: HostFilesystem;
  /** Must be paired with a custom HostFilesystem; default Node fs gets Node removal. */
  readonly removalFilesystem?: ProfileHomeRemovalFilesystem;
  readonly clock: HostClock;
  readonly timer: HostTimer;
  readonly runtimes: RuntimeProvider;
  readonly processes?: ProcessHost;
  readonly clients?: AppServerClientFactory;
  /** Late-bound once per supervisor so callbacks can never target a successor. */
  readonly createClients?: (callbacks: ElectronCodexClientCallbackBuilderInput) => AppServerClientFactory;
  /** Existing/test waiter seam. Production creates one tracker per service session. */
  readonly turnTerminal?: TurnTerminalWaiter;
  readonly createTurnTerminal?: () => ElectronCodexTurnTerminalTracker;
  readonly currentUid: () => number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly onFault?: ConstructorParameters<typeof CodexProfileSupervisor>[0]["onFault"];
  readonly bindingPersistence?: CodexBindingPersistence;
  /** Optional C1 product controller; omitted means all v8 admin commands fail closed. */
  readonly controller?: Omit<ElectronCodexControllerOptions, "services">;
  /** Exact persistent controller used by both runtime authority and this host. */
  readonly controllerInstance?: ElectronCodexController;
}

/**
 * Production-capable composition seam. It performs no runtime discovery,
 * installation, or launch until an authenticated relay command is admitted.
 */
export function createElectronCodexHostServiceFactory(
  options: ElectronCodexHostServiceFactoryOptions,
): ElectronCodexHostOptions["createServices"] {
  if (Boolean(options.clients) === Boolean(options.createClients)) {
    throw new Error("exactly one of clients or createClients is required");
  }
  if (options.controller && options.controllerInstance) {
    throw new Error("controller and controllerInstance are mutually exclusive");
  }
  const filesystem = options.filesystem ?? nodeCodexHostFilesystem;
  const removalFilesystem = options.removalFilesystem ?? (options.filesystem ? undefined : nodeProfileHomeRemovalFilesystem);
  // These registries and the controller outlive one relay socket. A reconnect
  // receives a fresh supervisor port but retains product profile/runtime IDs.
  const homes = new CodexProfileHomeRegistry({
    rootPath: options.profileHomesRoot,
    trustedParentPath: options.profileHomesTrustedParent,
    filesystem,
    currentUid: options.currentUid,
    ...(removalFilesystem ? { removalFilesystem } : {}),
  });
  const serviceDirectory = options.serviceDirectory ?? new CodexServiceDirectory({
    path: join(options.profileHomesTrustedParent, "codex-service"),
    trustedParentPath: options.profileHomesTrustedParent,
    filesystem,
    currentUid: options.currentUid,
  });
  const controller = options.controllerInstance ?? (options.controller && new ElectronCodexController(options.controller));
  return async (session) => {
    const terminalTracker = options.createTurnTerminal?.();
    const turnTerminal = terminalTracker ?? options.turnTerminal;
    if (!turnTerminal) throw new Error("Codex turn terminal waiter is required");
    const snapshots = {
      read(): Promise<CurrentFolderSnapshot> {
        const actorId = options.actorId();
        if (!actorId) return Promise.reject(new CodexHostError("WORKSPACE_UNAVAILABLE", "Authenticated actor is unavailable"));
        return Promise.resolve({
          actorId,
          relayId: session.relayId,
          relaySessionId: session.relaySessionId,
          desktopSessionId: session.desktopSessionId,
          pairingGenerationRef: session.pairingGenerationRef,
          capabilityRevision: session.capabilityRevision,
          // This legacy v8 receipt now correlates the paired host session. It
          // deliberately uses the stable Genie Workspace, not Current Folder.
          revision: 0,
          selectedPath: options.defaultWorkingDirectory,
        });
      },
    };
    const workspaces = new CodexWorkspaceReceiptAuthority({
      snapshots,
      filesystem,
      clock: options.clock,
      hmacKey: options.hmacKey,
    });
    const bindings = new AtomicJsonCodexBindingStore(options.bindingStateFile, options.bindingPersistence);
    const callbackBinding = createSupervisorClientCallbackBinding();
    const clients = options.clients ?? options.createClients!(callbackBinding.callbacks);
    const supervisor = new CodexProfileSupervisor({
      workspaces,
      homes,
      serviceDirectory,
      runtimes: options.runtimes,
      processes: options.processes ?? createNodeProcessHost(),
      clients,
      bindings,
      clock: options.clock,
      timer: options.timer,
      turnTerminal,
      onFault: options.onFault ?? (() => undefined),
      ...(options.environment ? { environment: options.environment } : {}),
    });
    callbackBinding.bind(supervisor);
    let receipt: WorkspaceReceipt | null = null;
    const resolve = async (wire: RelayWorkspaceReceipt): Promise<WorkspaceReceipt> => {
      if (!receipt || !sameWireReceipt(toRelayWorkspaceReceipt(receipt), wire)) {
        throw new CodexHostError("WORKSPACE_STALE", "Workspace receipt is stale");
      }
      await workspaces.resolve(receipt);
      return receipt;
    };
    const workingDirectories = {
      async resolve(requested: string | undefined): Promise<string> {
        const candidate = requested ?? options.currentFolder()?.path ?? options.defaultWorkingDirectory;
        if (!candidate || !isAbsolute(candidate) || candidate.includes("\0") || Buffer.byteLength(candidate, "utf8") > 4096) {
          throw new CodexHostError("WORKSPACE_UNAVAILABLE", "Codex working directory must be an absolute local path");
        }
        try {
          const canonical = await filesystem.realpath(candidate);
          const inspected = await filesystem.stat(canonical);
          if (!inspected.isDirectory || inspected.isSymbolicLink) throw new Error("not_directory");
          return canonical;
        } catch (error) {
          if (error instanceof CodexHostError) throw error;
          throw new CodexHostError("WORKSPACE_UNAVAILABLE", "Codex working directory is unavailable on the selected Desktop");
        }
      },
    };
    const relay = new SharedCodexRelayHostPort(supervisor, {
      resolve: async (_scope, wire) => {
        const workspace = await resolve(wire);
        return { actorId: workspace.actorId, workspace };
      },
    }, workingDirectories);
    callbackBinding.bindNotifications(async (child, notification) => {
      const threadId = notificationThreadId(notification);
      if (!threadId) return;
      const binding = await supervisor.bindingForThread(child, threadId);
      if (!binding) return;
      if (
        notification.method === "turn/completed"
        && binding.threadId === notification.params.threadId
      ) {
        terminalTracker?.observe({
          child,
          binding,
          turnId: notification.params.turn.id,
        });
      }
      callbackBinding.deliver(child, binding, notification);
      if (notification.method === "turn/completed") {
        await supervisor.completeTurn(child, binding.bindingId);
      }
    });
    callbackBinding.bindRequests(async (child, method, params, context) => {
      return dispatchCodexHumanServerRequest(
        method,
        params,
        context,
        async (request) => {
          // Resolve the binding only from the exact generated request thread;
          // no active-turn heuristic exists.
          const binding = await supervisor.bindingForThread(
            child,
            request.projected.threadId,
          );
          if (!binding) throw new Error("Codex request thread is not bound");
          return callbackBinding.deliverRequest(child, binding, request);
        },
      );
    });
    const accountEnsure = async (scope: ProfileLaunchScope): Promise<ChildIdentity> => {
      const actorId = options.actorId();
      if (!actorId) throw new CodexHostError("WORKSPACE_UNAVAILABLE", "Authenticated actor is unavailable");
      return supervisor.ensure({
        profile: { actorId, profileHandle: scope.profileHandle as OpaqueHandle, profileGeneration: scope.profileGeneration },
        accountGeneration: scope.accountGeneration,
        runtimeGeneration: scope.runtimeGeneration,
      });
    };
    if (controller) {
      await controller.attach(session, {
        actorId: options.actorId,
        createProfile: (identity) => homes.ensure(identity),
        ensure: accountEnsure,
        removeProfile: async ({ scope, home, existingChild }) => {
          const actorId = options.actorId();
          if (!actorId || home.identity.actorId !== actorId) throw new CodexHostError("WORKSPACE_UNAVAILABLE", "Authenticated actor is unavailable");
          await supervisor.removeProfile({
            profile: { actorId, profileHandle: scope.profileHandle as OpaqueHandle, profileGeneration: scope.profileGeneration },
            accountGeneration: scope.accountGeneration,
            runtimeGeneration: scope.runtimeGeneration,
            home,
            ...(existingChild ? { existingChild } : {}),
          });
        },
        startChatgptLogin: (child) => supervisor.startChatgptLogin(child),
        cancelLogin: async (child, upstreamLoginId) => { await supervisor.cancelLogin(child, upstreamLoginId); },
        readAccount: (child) => supervisor.readAccount(child),
        readUsage: async (child) => {
          const value = await supervisor.readUsage(child);
          return {
            summary: {
              lifetimeTokens: value.lifetimeTokens ?? null,
              peakDailyTokens: value.peakDailyTokens ?? null,
              longestRunningTurnSec: value.longestRunningTurnSec ?? null,
              currentStreakDays: value.currentStreakDays ?? null,
              longestStreakDays: value.longestStreakDays ?? null,
            },
            daily: value.dailyUsage,
            observedAt: new Date(options.clock.now()).toISOString(),
            freshness: "live" as const,
          };
        },
        listModels: (child) => supervisor.listModels(child),
        logout: (child) => supervisor.logout(child),
      });
    }
    return {
      async mintWorkspace() {
        receipt = await workspaces.mint();
        return { local: receipt, wire: toRelayWorkspaceReceipt(receipt) };
      },
      resolveWorkspace: (_scope, wire) => resolve(wire),
      invalidateWorkspaces() { receipt = null; workspaces.invalidateAll(); },
      ensure: (scope) => accountEnsure(scope),
      ...(controller ? { admin: controller } : {}),
      open: (scope, input) => relay.open(scope, input),
      resume: (scope) => relay.resume(scope),
      release: (scope) => relay.release(scope),
      rebind: (scope, wire, generation) => relay.rebind(scope, wire, generation),
      start: (scope, input) => relay.start(scope, input),
      interrupt: (scope) => relay.interrupt(scope),
      steer: (scope, input) => relay.steer(scope, input),
      setNotificationSink: (sink) => callbackBinding.setSink(sink),
      setRequestSink: (sink) => callbackBinding.setRequestSink(sink),
      drain: (scope) => {
        const actorId = options.actorId();
        if (!actorId) throw new CodexHostError("WORKSPACE_STALE", "Authenticated actor is unavailable");
        return supervisor.drain(childFromScope(scope, actorId));
      },
      hasActiveWork: () => supervisor.hasActiveWork(),
      shutdown: async () => {
        terminalTracker?.close();
        await supervisor.shutdown();
      },
    };
  };
}

function createSupervisorClientCallbackBinding(): {
  readonly callbacks: ElectronCodexClientCallbackBuilderInput;
  bind(supervisor: CodexProfileSupervisor): void;
  bindNotifications(
    listener: (
      child: ChildIdentity,
      notification: DecodedServerNotification,
    ) => Promise<void>,
  ): void;
  bindRequests(
    listener: <M extends EnabledServerRequestMethod>(
      child: ChildIdentity,
      method: M,
      params: ServerRequestParamsMap[M],
      context: ServerRequestContext,
    ) => Promise<ServerRequestResponseMap[M]>,
  ): void;
  setSink(
    sink: (
      child: ChildIdentity,
      binding: PersistedBindingRecord,
      notification: DecodedServerNotification,
    ) => void,
  ): void;
  setRequestSink(sink: ElectronCodexHumanRequestDispatcher): void;
  deliver(
    child: ChildIdentity,
    binding: PersistedBindingRecord,
    notification: DecodedServerNotification,
  ): void;
  deliverRequest: <M extends CodexHumanRequestMethod>(
    child: ChildIdentity,
    binding: PersistedBindingRecord,
    request: {
      readonly method: M;
      readonly params: ServerRequestParamsMap[M];
      readonly context: ServerRequestContext;
      readonly projected: ProjectedCodexHumanRequest;
    },
  ) => Promise<CodexHumanRelayResponse>;
} {
  let exactSupervisor: CodexProfileSupervisor | undefined;
  let notificationListener:
    | ((child: ChildIdentity, notification: DecodedServerNotification) => Promise<void>)
    | undefined;
  let sink:
    | ((
        child: ChildIdentity,
        binding: PersistedBindingRecord,
        notification: DecodedServerNotification,
      ) => void)
    | undefined;
  let requestListener:
    | (<M extends EnabledServerRequestMethod>(
        child: ChildIdentity,
        method: M,
        params: ServerRequestParamsMap[M],
        context: ServerRequestContext,
      ) => Promise<ServerRequestResponseMap[M]>)
    | undefined;
  let requestSink: ElectronCodexHumanRequestDispatcher | undefined;
  let bound = false;
  const callbacks: ElectronCodexClientCallbackBuilderInput = Object.freeze({
    isCurrent: (child: ChildIdentity) => exactSupervisor?.isCurrentChild(child) ?? false,
    onClientFault: async (child: ChildIdentity) => {
      await exactSupervisor?.onClientFault(child);
    },
    onNotification: async (
      child: ChildIdentity,
      notification: DecodedServerNotification,
    ) => {
      await notificationListener?.(child, notification);
    },
    onServerRequest: async <M extends EnabledServerRequestMethod>(child: ChildIdentity, method: M, params: ServerRequestParamsMap[M], context: ServerRequestContext) => {
      if (!requestListener) throw new Error("Codex request listener is unavailable");
      return requestListener(child, method, params, context);
    },
  });
  return {
    callbacks,
    bind(supervisor) {
      if (bound) throw new Error("Codex supervisor callback binding is already set");
      bound = true;
      exactSupervisor = supervisor;
    },
    bindNotifications(listener) {
      if (notificationListener) {
        throw new Error("Codex notification listener is already bound");
      }
      notificationListener = listener;
    },
    bindRequests(listener) {
      if (requestListener) throw new Error("Codex request listener is already bound");
      requestListener = listener;
    },
    setSink(next) {
      sink = next;
    },
    setRequestSink(next) {
      requestSink = next;
    },
    deliver(child, binding, notification) {
      sink?.(child, binding, notification);
    },
    async deliverRequest<M extends CodexHumanRequestMethod>(child: ChildIdentity, binding: PersistedBindingRecord, request: {
      readonly method: M;
      readonly params: ServerRequestParamsMap[M];
      readonly context: ServerRequestContext;
      readonly projected: ProjectedCodexHumanRequest;
    }) {
      if (!requestSink) throw new Error("Codex request sink is unavailable");
      return requestSink({ child, binding, ...request });
    },
  };
}

function notificationThreadId(
  notification: DecodedServerNotification,
): string | null {
  if ("threadId" in notification.params) return notification.params.threadId;
  if (
    notification.method === "thread/started" &&
    notification.params.thread.id
  ) {
    return notification.params.thread.id;
  }
  return null;
}

function notificationTurnId(
  notification: DecodedServerNotification,
): string | null {
  switch (notification.method) {
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/completed":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/started":
    case "thread/tokenUsage/updated":
    case "turn/diff/updated":
      return notification.params.turnId;
    case "turn/completed":
    case "turn/started":
      return notification.params.turn.id;
    default:
      return null;
  }
}

/**
 * Electron-owned relay-v8 adapter. It has no Tool dispatch or Nautilo sandbox
 * surface; Codex-native posture is handled inside the shared host package.
 */
export class ElectronCodexHost implements RelayCodexHostPort {
  private session: RelayCodexSession | null = null;
  private transport: RelayCodexHostTransport | null = null;
  private services: ElectronCodexHostServices | null = null;
  private persistentAdmin: ElectronCodexAdminPort | null = null;
  private workspace: RelayWorkspaceReceipt | null = null;
  private closed = false;
  private failed = false;
  private lifecycle = Promise.resolve();
  private registrationEpoch = 0;
  private pendingRegistration: Readonly<{
    session: RelayCodexSession;
    transport: RelayCodexHostTransport;
    ready: Promise<void>;
    epoch: number;
  }> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private registrationFailed = false;
  private pendingAdmissionWaiters = 0;
  private readonly eventSequences = new Map<string, number>();
  private readonly requestBroker: ElectronCodexRequestBroker;

  constructor(private readonly options: ElectronCodexHostOptions) {
    this.requestBroker = new ElectronCodexRequestBroker({
      session: () => this.session,
      transport: () => this.transport,
    });
  }

  isReady(): boolean { return !this.closed && !this.failed && this.options.currentActorId() !== null; }

  onRegistered(session: RelayCodexSession, transport: RelayCodexHostTransport): Promise<void> {
    if (!this.isReady()) return Promise.resolve();
    this.requestBroker.cancelAll();
    const epoch = ++this.registrationEpoch;
    this.registrationFailed = false;
    const previous = this.detachServices();
    this.workspace = null;
    this.session = null;
    this.transport = null;
    const ready = this.queueLifecycle(async () => {
      if (previous) await this.stopServices(previous, false);
      if (this.closed || this.failed || epoch !== this.registrationEpoch || !this.options.currentActorId()) return;
      let services: ElectronCodexHostServices;
      try {
        services = await this.options.createServices(session);
      } catch (error) {
        if (!this.closed && epoch === this.registrationEpoch && this.options.currentActorId()) {
          this.registrationFailed = true;
          if (this.pendingAdmissionWaiters === 0) this.failed = true;
        }
        throw error;
      }
      if (this.closed || epoch !== this.registrationEpoch || !this.options.currentActorId()) {
        services.invalidateWorkspaces();
        await this.stopServices(services, this.closed);
        return;
      }
      this.session = session;
      this.transport = transport;
      this.services = services;
      services.setNotificationSink((child, binding, notification) => {
        this.forwardNotification(child, binding, notification);
      });
      services.setRequestSink((request) => this.requestBroker.request(request));
      if (services.admin) this.persistentAdmin = services.admin;
      try {
        await services.admin?.enable(session);
        this.workspace = (await services.mintWorkspace()).wire;
        this.sendStatus({ state: "bound", receipt: this.workspace });
      } catch {
        this.workspace = null;
        this.sendStatus({ state: "unavailable" });
      }
    });
    const pending = { session, transport, ready, epoch };
    this.pendingRegistration = pending;
    void ready.then(() => {
      if (this.pendingRegistration === pending) this.pendingRegistration = null;
    }, () => {
      if (this.failed && this.pendingRegistration === pending) this.pendingRegistration = null;
    });
    return ready;
  }

  onDisconnected(): void {
    this.requestBroker.cancelAll();
    this.registrationEpoch += 1;
    const services = this.detachServices();
    this.workspace = null;
    this.session = null;
    this.transport = null;
    this.eventSequences.clear();
    if (services) void this.queueLifecycle(() => this.stopServices(services, false)).catch(() => undefined);
  }

  async onCommand(message: CodexCommand): Promise<void> {
    const pending = this.pendingRegistration;
    if (pending && sameSessionScope(message.scope, pending.session)) {
      this.pendingAdmissionWaiters += 1;
      try {
        await pending.ready;
      } catch {
        this.sendRejected(message, "CODEX_CHILD_START_FAILED", pending.transport);
        this.pendingAdmissionWaiters -= 1;
        if (
          this.registrationFailed
          && pending.epoch === this.registrationEpoch
          && this.pendingRegistration === pending
          && this.pendingAdmissionWaiters === 0
        ) {
          this.failed = true;
          if (this.pendingRegistration === pending) this.pendingRegistration = null;
        }
        return;
      }
      this.pendingAdmissionWaiters -= 1;
      if (!this.isCurrent(message.scope) || !this.services) {
        this.sendRejected(message, "CODEX_CONTEXT_STALE", pending.transport);
        return;
      }
    }
    if (!this.isCurrent(message.scope)) return;
    if (!this.services) {
      this.sendRejected(message, "CODEX_CONTEXT_STALE");
      return;
    }
    try {
      await this.handleCommand(message);
    } catch (error) {
      const code = stableCode(error);
      // Bounded Electron-main diagnostic only: never log scopes, command
      // payloads, account/runtime handles, workspace paths, or model output.
      console.warn("[desktop][d453] Codex command rejected", {
        kind: message.command.kind,
        stableCode: code,
      });
      this.sendRejected(message, code);
    }
  }

  async onCancel(message: CodexCancel): Promise<void> {
    const pending = this.pendingRegistration;
    if (pending && sameSessionScope(message.scope, pending.session)) {
      await pending.ready.catch(() => undefined);
    }
    if (!this.isCurrent(message.scope) || !this.services) return;
    this.requestBroker.cancelTurn(message.scope);
    try { await this.services.interrupt(message.scope); } catch { /* exact stale generation is already terminal */ }
  }

  onCredit(): void { /* Event credit accounting lands with turn streaming. */ }
  onRequestResponse(message: Extract<RelayCodexServerMessage, { readonly type: "relay:codex-request-response" }>): void {
    this.requestBroker.respond(message);
  }

  /** Re-publishes only the current redacted projection for this live socket. */
  refreshStatus(): void {
    this.sendStatus(this.workspace ? { state: "bound", receipt: this.workspace } : { state: "unavailable" });
  }

  /** Conservative local answer used only to defer relay replacement. */
  async hasActiveWork(): Promise<boolean> {
    const services = this.services;
    if (!services) return false;
    try {
      return await services.hasActiveWork();
    } catch {
      return true;
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.requestBroker.cancelAll();
    this.registrationEpoch += 1;
    const services = this.detachServices();
    this.workspace = null;
    this.session = null;
    this.transport = null;
    this.shutdownPromise = services
      ? this.queueLifecycle(() => this.stopServices(services, true))
      : this.persistentAdmin
        ? this.queueLifecycle(() => this.persistentAdmin!.close())
        : this.lifecycle;
    return this.shutdownPromise;
  }

  private async handleCommand(message: CodexCommand): Promise<void> {
    const services = this.services!;
    const command = message.command;
    switch (command.kind) {
      case "ensure_profile_child": {
        const scope = message.scope as ProfileLaunchScope;
        const child = services.admin
          ? await services.admin.ensureProfileChild(scope)
          : await services.ensure(scope);
        const response: RelayCodexProfileCommandResponse = { type: "relay:codex-command-response", commandId: message.commandId, scope: { ...scope, childGeneration: child.childGeneration }, result: { kind: "child_ready" } };
        // Publish the child generation before acknowledging the correlated
        // command so the server's next authority read cannot observe an older
        // status snapshot.
        this.sendStatus(this.workspace ? { state: "bound", receipt: this.workspace } : { state: "unavailable" });
        this.send(response);
        return;
      }
      case "open_binding": {
        const scope = message.scope as BindingOpenScope;
        const bound = await services.open(scope, command);
        const response: RelayCodexBindingCommandResponse = { type: "relay:codex-command-response", commandId: message.commandId, scope: { ...scope, threadId: bound.threadId }, result: { kind: "binding_ready" } };
        this.send(response);
        return;
      }
      case "resume_binding": {
        const scope = message.scope as BindingScope;
        await services.resume(scope);
        const response: RelayCodexBindingCommandResponse = { type: "relay:codex-command-response", commandId: message.commandId, scope, result: { kind: "binding_ready" } };
        this.send(response);
        return;
      }
      case "release_binding": {
        const scope = message.scope as BindingScope;
        await services.release(scope);
        const response: RelayCodexBindingCommandResponse = { type: "relay:codex-command-response", commandId: message.commandId, scope, result: { kind: "binding_released" } };
        this.send(response);
        return;
      }
      case "rebind_binding": {
        const scope = message.scope as BindingIdentityScope;
        const bound = await services.rebind(scope, command.successorWorkspace, command.nextBindingGeneration);
        const response: RelayCodexBindingCommandResponse = { type: "relay:codex-command-response", commandId: message.commandId, scope: { ...scope, bindingGeneration: bound.bindingGeneration, workspace: command.successorWorkspace }, result: { kind: "binding_rebound" } };
        this.send(response);
        return;
      }
      case "start_turn": {
        const scope = message.scope as BindingScope;
        const started = await services.start(scope, {
          text: command.userText,
          clientUserMessageId: command.turnInputRef,
          // Missing is the deployed v8 Work representation; the typed client
          // still emits explicit generated Default bytes upstream.
          collaborationMode: command.collaborationMode ?? "work",
        });
        const turnScope: TurnScope = {
          ...scope,
          turnId: started.turnId,
        };
        this.send({
          type: "relay:codex-command-response",
          commandId: message.commandId,
          scope: turnScope,
          result: { kind: "turn_started" },
        });
        return;
      }
      case "interrupt_turn": {
        const scope = message.scope as TurnScope;
        await services.interrupt(scope);
        this.send({ type: "relay:codex-command-response", commandId: message.commandId, scope, result: { kind: "interrupted" } });
        return;
      }
      case "steer_turn": {
        const scope = message.scope as TurnScope;
        await services.steer(scope, {
          text: command.userText,
          actorRef: command.actorRef,
        });
        this.send({
          type: "relay:codex-command-response",
          commandId: message.commandId,
          scope,
          result: { kind: "accepted" },
        });
        return;
      }
      case "drain_profile":
      case "terminate_child": {
        const scope = message.scope as ProfileScope;
        await services.drain(scope);
        const response: RelayCodexProfileCommandResponse = { type: "relay:codex-command-response", commandId: message.commandId, scope, result: { kind: command.kind === "drain_profile" ? "drained" : "terminated" } };
        this.send(response);
        return;
      }
      case "runtime_inspect":
      case "runtime_install":
      case "runtime_cancel_install":
      case "runtime_activate":
      case "runtime_rollback":
      case "runtime_remove":
      case "profile_create":
      case "profile_remove":
      case "account_login_start":
      case "account_login_cancel":
      case "account_read":
      case "account_logout":
      case "account_rate_limits_read":
      case "account_usage_read":
      case "model_list": {
        const result = services.admin
          ? await services.admin.execute(message.scope, command)
          : { kind: "rejected" as const, code: "CODEX_CAPABILITY_UNAVAILABLE" as const };
        // Account/profile commands mutate the controller projection. Publish
        // that exact state before acknowledging so a correlated server caller
        // can immediately perform the next authority check without observing
        // the previous snapshot.
        this.sendStatus(this.workspace ? { state: "bound", receipt: this.workspace } : { state: "unavailable" });
        this.send({ type: "relay:codex-command-response", commandId: message.commandId, scope: message.scope, result } as RelayCodexProfileCommandResponse);
        return;
      }
      default:
        this.sendRejected(message, "CODEX_CAPABILITY_UNAVAILABLE");
    }
  }

  private sendStatus(workspace: CodexHostStatus["workspace"]): void {
    const session = this.session;
    if (!session) return;
    this.send({
      type: "relay:codex-status",
      socket: {
        relayId: session.relayId,
        relaySessionId: session.relaySessionId,
        desktopSessionId: session.desktopSessionId,
        pairingGenerationRef: session.pairingGenerationRef,
        selectedProtocolVersion: session.selectedProtocolVersion,
      },
      capabilityRevision: session.capabilityRevision,
      status: { ...this.options.status(), workspace },
    });
  }

  private forwardNotification(
    child: ChildIdentity,
    binding: PersistedBindingRecord,
    notification: DecodedServerNotification,
  ): void {
    const session = this.session;
    if (!session || !this.transport) return;
    if (notificationThreadId(notification) !== binding.threadId) return;
    const turnId = notificationTurnId(notification);
    if (!turnId) return;
    const base = {
      ...session,
      profileHandle: child.profile.profileHandle,
      profileGeneration: child.profile.profileGeneration,
      accountGeneration: child.accountGeneration,
      runtimeGeneration: child.runtimeGeneration,
      childGeneration: child.childGeneration,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      taskId: binding.taskId,
      jobId: binding.jobId,
      threadId: binding.threadId,
      workspace: toRelayWorkspaceReceipt(binding.workspace),
      turnId,
      eventId: randomUUID(),
    } as const;
    const eventSequence = this.nextEventSequence(child);
    switch (notification.method) {
      case "turn/started":
        this.send({
          type: "relay:codex-event",
          scope: base,
          eventSequence,
          event: { kind: "turn_status", state: "running" },
        });
        return;
      case "item/agentMessage/delta":
        for (const [index, text] of relayTextChunks(
          notification.params.delta,
          session.selectedProtocolVersion,
        ).entries()) {
          const sequence = index === 0
            ? eventSequence
            : this.nextEventSequence(child);
          this.send({
            type: "relay:codex-event",
            scope: {
              ...base,
              ...(index === 0 ? {} : { eventId: randomUUID() }),
              itemId: notification.params.itemId,
            },
            eventSequence: sequence,
            event: {
              kind: "message_delta",
              text,
              sequence,
            },
          });
        }
        return;
      case "item/commandExecution/outputDelta":
        this.send({
          type: "relay:codex-event",
          scope: { ...base, itemId: notification.params.itemId },
          eventSequence,
          event: {
            kind: "command_summary",
            summary: boundedSummary(
              `Command output\n${notification.params.delta}`,
              4096,
            ),
            sequence: eventSequence,
          },
        });
        return;
      case "item/commandExecution/terminalInteraction":
        this.send({
          type: "relay:codex-event",
          scope: { ...base, itemId: notification.params.itemId },
          eventSequence,
          event: {
            kind: "command_summary",
            // Never relay terminal stdin; it can contain credentials or other
            // secrets. Byte count still gives the user truthful liveness.
            summary: `Terminal input sent (${Buffer.byteLength(notification.params.stdin, "utf8")} bytes)`,
            sequence: eventSequence,
          },
        });
        return;
      case "item/fileChange/outputDelta":
        this.send({
          type: "relay:codex-event",
          scope: { ...base, itemId: notification.params.itemId },
          eventSequence,
          event: {
            kind: "patch_summary",
            summary: boundedSummary(
              `File change output\n${notification.params.delta}`,
              4096,
            ),
            sequence: eventSequence,
          },
        });
        return;
      case "item/fileChange/patchUpdated":
        this.send({
          type: "relay:codex-event",
          scope: { ...base, itemId: notification.params.itemId },
          eventSequence,
          event: {
            kind: "patch_summary",
            summary: boundedSummary(
              `Patch updated\n${summarizeFileChanges(notification.params.changes)}`,
              4096,
            ),
            sequence: eventSequence,
          },
        });
        return;
      case "item/completed":
        if (notification.params.item.type === "agentMessage") {
          if (notification.params.item.text.trim().length === 0) return;
          this.send({
            type: "relay:codex-event",
            scope: { ...base, itemId: notification.params.item.id },
            eventSequence,
            event: {
              kind: "assistant_item_completed",
              text: completedAssistantText(
                notification.params.item.text,
                session.selectedProtocolVersion,
              ),
              phase: notification.params.item.phase,
              sequence: eventSequence,
            },
          });
        } else if (notification.params.item.type === "commandExecution") {
          this.send({
            type: "relay:codex-event",
            scope: { ...base, itemId: notification.params.item.id },
            eventSequence,
            event: {
              kind: "command_summary",
              summary: boundedSummary(
                summarizeCompletedCommand(notification.params.item),
                4096,
              ),
              sequence: eventSequence,
            },
          });
        } else if (notification.params.item.type === "fileChange") {
          this.send({
            type: "relay:codex-event",
            scope: { ...base, itemId: notification.params.item.id },
            eventSequence,
            event: {
              kind: "patch_summary",
              summary: boundedSummary(
                `File changes ${notification.params.item.status}\n${summarizeFileChanges(notification.params.item.changes)}`,
                4096,
              ),
              sequence: eventSequence,
            },
          });
        }
        return;
      case "item/started":
        if (notification.params.item.type === "commandExecution") {
          this.send({
            type: "relay:codex-event",
            scope: { ...base, itemId: notification.params.item.id },
            eventSequence,
            event: {
              kind: "command_summary",
              summary: boundedSummary(
                `Command started\n${notification.params.item.command}\n${notification.params.item.cwd}`,
                4096,
              ),
              sequence: eventSequence,
            },
          });
        } else if (notification.params.item.type === "fileChange") {
          this.send({
            type: "relay:codex-event",
            scope: { ...base, itemId: notification.params.item.id },
            eventSequence,
            event: {
              kind: "patch_summary",
              summary: boundedSummary(
                `File change started\n${summarizeFileChanges(notification.params.item.changes)}`,
                4096,
              ),
              sequence: eventSequence,
            },
          });
        } else {
          this.send({
            type: "relay:codex-event",
            scope: base,
            eventSequence,
            event: {
              kind: "progress",
              phase: "thinking",
              sequence: eventSequence,
            },
          });
        }
        return;
      case "turn/completed": {
        const state =
          notification.params.turn.status === "completed"
            ? "completed"
            : notification.params.turn.status === "interrupted"
              ? "interrupted"
              : notification.params.turn.status === "failed"
                ? "failed"
                : "uncertain";
        const code = terminalCode(state);
        this.send({
          type: "relay:codex-event",
          scope: base,
          eventSequence,
          event: {
            kind: "turn_completed",
            status: state,
            itemsView: notification.params.turn.itemsView,
            assistantItems: boundedCompletedAssistantItems(
              notification.params.turn.items,
              session.selectedProtocolVersion,
            ),
            ...(code ? { code } : {}),
          },
        });
        return;
      }
      default:
        return;
    }
  }

  private nextEventSequence(child: ChildIdentity): number {
    const key = `${child.profile.profileHandle}\u0000${child.childGeneration}`;
    const next = (this.eventSequences.get(key) ?? 0) + 1;
    this.eventSequences.set(key, next);
    return next;
  }

  private sendRejected(message: CodexCommand, code: CodexStableErrorCode, transport = this.transport): void {
    const scope = message.command.kind === "rebind_binding"
      ? {
          ...message.scope,
          bindingGeneration: message.command.nextBindingGeneration,
          workspace: message.command.successorWorkspace,
        }
      : message.scope;
    const response = { type: "relay:codex-command-response", commandId: message.commandId, scope, result: { kind: "rejected", code } } as RelayCodexBindingOpenCommandResponse;
    transport?.send(response);
  }

  private send(message: RelayCodexClientMessage): void { this.transport?.send(message); }
  private isCurrent(scope: CodexCommand["scope"]): boolean {
    const session = this.session;
    return !!session && scope.relayId === session.relayId && scope.relaySessionId === session.relaySessionId &&
      scope.desktopSessionId === session.desktopSessionId && scope.pairingGenerationRef === session.pairingGenerationRef &&
      scope.capabilityRevision === session.capabilityRevision &&
      scope.selectedProtocolVersion === session.selectedProtocolVersion;
  }

  private detachServices(): ElectronCodexHostServices | null {
    const services = this.services;
    this.services = null;
    services?.invalidateWorkspaces();
    return services;
  }

  private queueLifecycle(work: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(work);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async stopServices(services: ElectronCodexHostServices, final: boolean): Promise<void> {
    let stage: "admin" | "supervisor" = "admin";
    try {
      let adminFailure: Error | undefined;
      try {
        if (services.admin) {
          if (final) await services.admin.close();
          else await services.admin.detach();
        }
      } catch (error) {
        adminFailure = error instanceof Error
          ? error
          : new Error("Codex admin cleanup failed", { cause: error });
      }
      // An admin-controller fault must never strand the session supervisor.
      stage = "supervisor";
      await services.shutdown();
      if (adminFailure !== undefined) {
        stage = "admin";
        throw adminFailure instanceof Error ? adminFailure : new Error("Codex admin cleanup failed");
      }
    } catch (error) {
      this.failed = true;
      // Local main-process diagnostic only. Keep the payload closed and
      // redacted: cleanup errors may otherwise carry private filesystem or
      // account context. This distinguishes controller detach from process
      // containment without weakening the fail-closed host fence.
      console.warn("[desktop][d453] Codex service cleanup failed", {
        final,
        stage,
        errorName: error instanceof Error ? error.name : typeof error,
        stableCode: stableCode(error),
      });
      throw error;
    }
  }
}

function stableCode(error: unknown): CodexStableErrorCode {
  if (error instanceof ElectronCodexControllerError) return error.code;
  // The host package is consumed through both its public and internal entry
  // points. A bundled Error can therefore cross this boundary without
  // preserving constructor identity. Read only the closed, non-secret code
  // vocabulary; never reflect arbitrary messages or fields into the relay.
  const hostCode = error instanceof CodexHostError
    ? error.code
    : error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
  if (hostCode) {
    switch (hostCode) {
      case "WORKSPACE_STALE": return "CODEX_WORKSPACE_STALE";
      case "WORKSPACE_UNAVAILABLE": return "CODEX_CONTEXT_STALE";
      case "CHILD_GENERATION_STALE": return "CODEX_GENERATION_STALE";
      case "PROFILE_HOME_INVALID":
      case "PROFILE_HOME_UNAVAILABLE": return "CODEX_PROFILE_UNAVAILABLE";
      case "BINDING_LIMIT_REACHED": return "CODEX_QUEUE_FULL";
      case "BINDING_UNCERTAIN": return "CODEX_UNCERTAIN_SIDE_EFFECT";
      case "SUPERVISOR_UNAVAILABLE": return "CODEX_CHILD_START_FAILED";
    }
  }
  return "CODEX_CONTEXT_INVALID";
}

function childFromScope(scope: ProfileScope, actorId: string): ChildIdentity {
  return {
    profile: {
      actorId,
      profileHandle: scope.profileHandle as OpaqueHandle,
      profileGeneration: scope.profileGeneration,
    },
    accountGeneration: scope.accountGeneration,
    runtimeGeneration: scope.runtimeGeneration,
    childGeneration: scope.childGeneration,
  };
}

function sameWireReceipt(left: RelayWorkspaceReceipt, right: RelayWorkspaceReceipt): boolean {
  return left.workspaceRef === right.workspaceRef && left.revision === right.revision &&
    left.fingerprint === right.fingerprint && left.issuedAt === right.issuedAt &&
    left.expiresAt === right.expiresAt;
}

function sameSessionScope(scope: CodexCommand["scope"], session: RelayCodexSession): boolean {
  return scope.relayId === session.relayId && scope.relaySessionId === session.relaySessionId &&
    scope.desktopSessionId === session.desktopSessionId &&
    scope.pairingGenerationRef === session.pairingGenerationRef &&
    scope.capabilityRevision === session.capabilityRevision &&
    scope.selectedProtocolVersion === session.selectedProtocolVersion;
}

function boundedSummary(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && new TextEncoder().encode(value.slice(0, end)).byteLength > maxBytes - 3) {
    end -= 1;
  }
  return `${value.slice(0, end)}...`;
}

type CommandExecutionItem = Extract<ThreadItemProjection, { readonly type: "commandExecution" }>;
type FileChangeItem = Extract<ThreadItemProjection, { readonly type: "fileChange" }>;

function summarizeCompletedCommand(item: CommandExecutionItem): string {
  const result = [
    `Command ${item.status}`,
    item.command,
    `cwd: ${item.cwd}`,
  ];
  if (item.exitCode !== null) result.push(`exit: ${item.exitCode}`);
  if (item.durationMs !== null) result.push(`duration: ${item.durationMs}ms`);
  if (item.aggregatedOutput?.trim()) result.push("", item.aggregatedOutput);
  return result.join("\n");
}

function summarizeFileChanges(changes: FileChangeItem["changes"]): string {
  if (changes.length === 0) return "(no file paths reported)";
  return changes
    .map((change) => {
      if (change.kind.type === "update" && change.kind.move_path) {
        return `update ${change.path} → ${change.kind.move_path}`;
      }
      return `${change.kind.type} ${change.path}`;
    })
    .join("\n");
}

const COMPLETED_ASSISTANT_ITEM_MAX_BYTES = 16 * 1024;
const COMPLETED_ASSISTANT_ITEMS_MAX_BYTES = 48 * 1024;

function supportsStreamedCompletion(protocolVersion: number): boolean {
  return protocolVersion >= CODEX_STREAMED_COMPLETION_PROTOCOL_VERSION;
}

function completedAssistantText(
  value: string,
  protocolVersion: number,
): string | null {
  if (
    supportsStreamedCompletion(protocolVersion) &&
    new TextEncoder().encode(value).byteLength > COMPLETED_ASSISTANT_ITEM_MAX_BYTES
  ) {
    return null;
  }
  return boundedSummary(value, COMPLETED_ASSISTANT_ITEM_MAX_BYTES);
}

function relayTextChunks(value: string, protocolVersion: number): readonly string[] {
  if (!supportsStreamedCompletion(protocolVersion)) {
    return [boundedSummary(value, COMPLETED_ASSISTANT_ITEM_MAX_BYTES)];
  }
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const encoder = new TextEncoder();
  for (const codePoint of value) {
    const bytes = encoder.encode(codePoint).byteLength;
    if (currentBytes > 0 && currentBytes + bytes > COMPLETED_ASSISTANT_ITEM_MAX_BYTES) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Preserve the trailing authoritative candidates in observed order. This is a
 * bounded semantic projection, never a serialized app-server turn object.
 */
function boundedCompletedAssistantItems(
  items: readonly ThreadItemProjection[],
  protocolVersion: number,
): readonly {
  readonly itemId: string;
  readonly text: string | null;
  readonly phase: "commentary" | "final_answer" | null;
}[] {
  const selected: Array<{
    readonly itemId: string;
    readonly text: string | null;
    readonly phase: "commentary" | "final_answer" | null;
  }> = [];
  let retainedBytes = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (selected.length >= 32) break;
    const item = items[index]!;
    if (item.type !== "agentMessage" || item.text.trim().length === 0) continue;
    let text = completedAssistantText(item.text, protocolVersion);
    let nextBytes = text === null ? 0 : new TextEncoder().encode(text).byteLength;
    if (selected.length > 0 && retainedBytes + nextBytes > COMPLETED_ASSISTANT_ITEMS_MAX_BYTES) {
      if (!supportsStreamedCompletion(protocolVersion)) break;
      text = null;
      nextBytes = 0;
    }
    selected.push({ itemId: item.id, text, phase: item.phase });
    retainedBytes += nextBytes;
  }
  return selected.reverse();
}

function terminalCode(
  state: "completed" | "failed" | "interrupted" | "uncertain",
): CodexStableErrorCode | undefined {
  if (state === "failed") return "CODEX_UPSTREAM_FAILURE";
  if (state === "interrupted") return "CODEX_CANCELLED";
  if (state === "uncertain") return "CODEX_UNCERTAIN_SIDE_EFFECT";
  return undefined;
}

/** Node filesystem adapter for the shared host; paths never leave Electron. */
export const nodeCodexHostFilesystem = {
  async lstat(path: string) { const value = await lstat(path); return fileStat(value); },
  async stat(path: string) { const value = await stat(path); return fileStat(value); },
  realpath,
  async mkdir(path: string, options: { readonly recursive: boolean; readonly mode: number }) {
    await mkdir(path, options);
    // `fs.promises.mkdir(..., { recursive: false })` resolves `undefined` on
    // success. The host port's boolean instead means this exact call created
    // the final directory (an EEXIST race rejects above).
    return true;
  },
  async chmod(path: string, mode: number) { await chmod(path, mode); },
  writeFile: (path: string, contents: string, options: { readonly mode: number; readonly flag: "wx" | "w" }) => writeFile(path, contents, options).then(() => undefined),
  readFile: (path: string) => readFile(path, "utf8"),
  unlink,
  rename,
} satisfies HostFilesystem;

export interface CodexBindingPersistence {
  mkdir(path: string, options: { readonly recursive: true; readonly mode: number }): Promise<unknown>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string, options: { readonly mode: number; readonly flag: "wx" }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeCodexBindingPersistence: CodexBindingPersistence = {
  mkdir,
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, contents, options) => writeFile(path, contents, options).then(() => undefined),
  rename,
  unlink,
} satisfies CodexBindingPersistence;

function fileStat(value: Awaited<ReturnType<typeof lstat>>) {
  return {
    mode: Number(value.mode),
    uid: Number(value.uid),
    dev: Number(value.dev),
    ino: Number(value.ino),
    isDirectory: value.isDirectory(),
    isSymbolicLink: value.isSymbolicLink(),
  };
}

/**
 * Durable local binding store. Writes are serialized and atomically renamed;
 * only opaque identifiers and path-free receipts are persisted.
 */
export class AtomicJsonCodexBindingStore implements CodexBindingStore {
  private mutation = Promise.resolve();
  constructor(
    private readonly filePath: string,
    private readonly persistence: CodexBindingPersistence = nodeCodexBindingPersistence,
  ) {}

  async get(bindingId: OpaqueHandle): Promise<PersistedBindingRecord | undefined> { return (await this.load()).records[bindingId]; }
  async list(child: ChildIdentity): Promise<readonly PersistedBindingRecord[]> {
    return Object.values((await this.load()).records).filter((record) => sameChild(record.child, child));
  }
  beginOpen(value: BindingOpenReservation) {
    assertValidReservation(value);
    return this.lock((state) => state.records[value.bindingId] ? "conflict" as const : reserve(state, value));
  }
  beginRebind(value: BindingRebindReservation, expected: PersistedBindingRecord) {
    assertValidReservation(value);
    assertValidRecord(expected);
    return this.lock((state) => {
      if (!sameRecord(state.records[expected.bindingId], expected)) return "conflict" as const;
      return reserve(state, value);
    });
  }
  completeOpen(value: BindingOpenReservation, record: PersistedBindingRecord) {
    assertValidReservation(value);
    assertValidRecord(record);
    return this.complete(value, undefined, record);
  }
  completeRebind(value: BindingRebindReservation, expected: PersistedBindingRecord, record: PersistedBindingRecord) {
    assertValidReservation(value);
    assertValidRecord(expected);
    assertValidRecord(record);
    return this.complete(value, expected, record);
  }
  abortOpen(value: BindingOpenReservation) { assertValidReservation(value); return this.abort(value); }
  abortRebind(value: BindingRebindReservation) { assertValidReservation(value); return this.abort(value); }
  update(record: PersistedBindingRecord) {
    assertValidRecord(record);
    return this.lock((state) => { if (!state.records[record.bindingId]) throw new Error("binding unavailable"); state.records[record.bindingId] = record; });
  }
  remove(bindingId: OpaqueHandle) { return this.lock((state) => { delete state.records[bindingId]; delete state.reservations[bindingId]; }); }

  private complete(value: BindingOpenReservation | BindingRebindReservation, expected: PersistedBindingRecord | undefined, record: PersistedBindingRecord) {
    return this.lock((state) => {
      if (state.reservations[value.bindingId]?.reservationId !== value.reservationId) return false;
      if (expected && !sameRecord(state.records[expected.bindingId], expected)) return false;
      delete state.reservations[value.bindingId];
      state.records[record.bindingId] = record;
      return true;
    });
  }
  private abort(value: BindingOpenReservation | BindingRebindReservation) {
    return this.lock((state) => { if (state.reservations[value.bindingId]?.reservationId === value.reservationId) delete state.reservations[value.bindingId]; });
  }
  private async load(): Promise<BindingState> {
    try {
      const parsed: unknown = JSON.parse(await this.persistence.readFile(this.filePath));
      if (isBindingState(parsed)) return parsed;
      const migrated = migrateRetiredCallbackState(parsed);
      if (!migrated) throw new Error("invalid_codex_binding_state");
      await this.save(migrated);
      return migrated;
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return emptyBindingState();
      throw error;
    }
  }
  private lock<T>(work: (state: BindingState) => T | Promise<T>): Promise<T> {
    const result = this.mutation.then(async () => { const state = await this.load(); const value = await work(state); await this.save(state); return value; });
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }
  private async save(state: BindingState): Promise<void> {
    if (!isBindingState(state)) throw new Error("invalid_codex_binding_state");
    await this.persistence.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await this.persistence.writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await this.persistence.rename(temp, this.filePath);
    } catch (error) {
      await this.persistence.unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}

interface BindingState {
  readonly schemaVersion: 1;
  records: Record<string, PersistedBindingRecord>;
  reservations: Record<string, BindingOpenReservation | BindingRebindReservation>;
}
const emptyBindingState = (): BindingState => ({ schemaVersion: 1, records: {}, reservations: {} });

/**
 * D453 briefly persisted a callback manifest before that out-of-scope bridge
 * was removed. Canonical state is otherwise unchanged, so migrate only that
 * one retired key at its three former typed positions and revalidate the
 * entire result before rewriting it. Unknown keys and malformed authority
 * remain fail-closed.
 */
function migrateRetiredCallbackState(value: unknown): BindingState | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["schemaVersion", "records", "reservations"]) ||
    value["schemaVersion"] !== 1 || !isPlainRecord(value["records"]) || !isPlainRecord(value["reservations"])) return null;
  let changed = false;
  const withoutCallbacks = (candidate: unknown): unknown => {
    if (!isPlainRecord(candidate) || !("callbacks" in candidate)) return candidate;
    const { callbacks: _retired, ...rest } = candidate;
    changed = true;
    return rest;
  };
  const records = Object.fromEntries(Object.entries(value["records"]).map(([key, record]) => [key, withoutCallbacks(record)]));
  const reservations = Object.fromEntries(Object.entries(value["reservations"]).map(([key, reservation]) => {
    const stripped = withoutCallbacks(reservation);
    if (!isPlainRecord(stripped) || stripped["state"] !== "rebinding") return [key, stripped];
    const current = withoutCallbacks(stripped["current"]);
    return [key, { ...stripped, current }];
  }));
  const migrated: unknown = { schemaVersion: 1, records, reservations };
  return changed && isBindingState(migrated) ? migrated : null;
}

function isBindingState(value: unknown): value is BindingState {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["schemaVersion", "records", "reservations"]) ||
    value["schemaVersion"] !== 1 || !isPlainRecord(value["records"]) || !isPlainRecord(value["reservations"])) return false;
  return Object.entries(value["records"]).every(([key, record]) => isPersistedRecord(record, key)) &&
    Object.entries(value["reservations"]).every(([key, reservation]) => isReservation(reservation, key));
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
function reserve(state: BindingState, value: BindingOpenReservation | BindingRebindReservation): "started" | "same_pending" | "conflict" {
  const existing = state.reservations[value.bindingId];
  if (!existing) { state.reservations[value.bindingId] = value; return "started"; }
  return sameReservationAuthority(existing, value) ? "same_pending" : "conflict";
}
function sameRecord(left: PersistedBindingRecord | undefined, right: PersistedBindingRecord): boolean { return !!left && canonicalJson(left) === canonicalJson(right); }
function sameChild(left: ChildIdentity, right: ChildIdentity): boolean { return canonicalJson(left) === canonicalJson(right); }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
function isPersistedRecord(value: unknown, key: string): boolean {
  const required = ["bindingId", "bindingGeneration", "threadId", "child", "workspace", "taskId", "jobId", "posture", "activeTurns", "pendingRequests", "outstandingRpcs"];
  if (!isPlainRecord(value) || !hasExactKeys(value, required, ["model", "workingDirectory"]) ||
    value["bindingId"] !== key || !isOpaqueText(value["bindingId"]) || !isOpaqueText(value["threadId"]) ||
    !isOpaqueText(value["taskId"]) || !isOpaqueText(value["jobId"]) ||
    !isGeneration(value["bindingGeneration"], true) || !isChild(value["child"]) ||
    !isWorkspaceReceipt(value["workspace"]) || (value["workingDirectory"] !== undefined && !isBoundedText(value["workingDirectory"], 4096, false)) || !isGeneration(value["activeTurns"], true) ||
    !isGeneration(value["pendingRequests"], true) || !isGeneration(value["outstandingRpcs"], true)) return false;
  return (value["model"] === undefined || isModel(value["model"])) &&
    isPosture(value["posture"]);
}
function isReservation(value: unknown, key: string): boolean {
  if (!isPlainRecord(value) || value["bindingId"] !== key || !isOpaqueText(value["bindingId"]) ||
    !isOpaqueText(value["reservationId"]) || (value["state"] !== "opening" && value["state"] !== "rebinding") ||
    !isGeneration(value["bindingGeneration"], true) || !isChild(value["child"]) ||
    !isOpaqueText(value["taskId"]) || !isOpaqueText(value["jobId"])) return false;
  if (value["state"] === "opening") {
    const required = ["bindingId", "bindingGeneration", "workspace", "taskId", "jobId", "workingDirectory", "posture", "child", "reservationId", "state"];
    return hasExactKeys(value, required, ["model"]) && isWorkspaceReceipt(value["workspace"]) &&
      isBoundedText(value["workingDirectory"], 4096, false) &&
      (value["model"] === undefined || isModel(value["model"])) &&
      isPosture(value["posture"]);
  }
  const required = ["bindingId", "bindingGeneration", "taskId", "jobId", "threadId", "successorWorkspace", "nextBindingGeneration", "child", "current", "reservationId", "state"];
  if (!hasExactKeys(value, required) || !isOpaqueText(value["threadId"]) ||
    !isWorkspaceReceipt(value["successorWorkspace"]) || !isGeneration(value["nextBindingGeneration"]) ||
    !isPersistedRecord(value["current"], key)) return false;
  const current = value["current"];
  return isPlainRecord(current) && current["bindingGeneration"] === value["bindingGeneration"] &&
    current["taskId"] === value["taskId"] && current["jobId"] === value["jobId"] &&
    current["threadId"] === value["threadId"] && sameChild(current["child"] as ChildIdentity, value["child"] as ChildIdentity);
}
function isChild(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ["profile", "accountGeneration", "runtimeGeneration", "childGeneration"]) &&
    isPlainRecord(value["profile"]) && hasExactKeys(value["profile"], ["actorId", "profileHandle", "profileGeneration"]) &&
    isOpaqueText(value["profile"]["actorId"]) && isOpaqueText(value["profile"]["profileHandle"]) &&
    isGeneration(value["profile"]["profileGeneration"], true) && isGeneration(value["accountGeneration"], true) &&
    isGeneration(value["runtimeGeneration"], true) && isGeneration(value["childGeneration"], true);
}
function isWorkspaceReceipt(value: unknown): boolean {
  const keys = ["handle", "actorId", "relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef", "capabilityRevision", "revision", "fingerprint", "issuedAt", "expiresAt"];
  return isPlainRecord(value) && hasExactKeys(value, keys) && isOpaqueText(value["handle"]) &&
    isOpaqueText(value["actorId"]) && isOpaqueText(value["relayId"]) && isOpaqueText(value["relaySessionId"]) &&
    isOpaqueText(value["desktopSessionId"]) && isOpaqueText(value["pairingGenerationRef"]) &&
    isBoundedText(value["fingerprint"], 512, false) && isGeneration(value["capabilityRevision"], true) &&
    isGeneration(value["revision"], true) && typeof value["issuedAt"] === "number" &&
    Number.isFinite(value["issuedAt"]) && typeof value["expiresAt"] === "number" &&
    Number.isFinite(value["expiresAt"]) && value["expiresAt"] > value["issuedAt"];
}
function isGeneration(value: unknown, allowZero = false): boolean {
  return Number.isSafeInteger(value) && (value as number) >= (allowZero ? 0 : 1);
}
function isPosture(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ["kind"]) &&
    (value["kind"] === "codex_default" || value["kind"] === "prompted_workspace" || value["kind"] === "full_access_headless");
}
function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}
function isOpaqueText(value: unknown): value is string { return isBoundedText(value, 512, false); }
function isModel(value: unknown): value is string {
  if (!isBoundedText(value, 512, false) || /\s/.test(value)) return false;
  return [...value].every((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && point > 31 && point !== 127;
  });
}
function isBoundedText(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) &&
    !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}
function assertValidRecord(value: PersistedBindingRecord): void {
  if (!isPersistedRecord(value, value.bindingId)) throw new Error("invalid_codex_binding_record");
}
function assertValidReservation(value: BindingOpenReservation | BindingRebindReservation): void {
  if (!isReservation(value, value.bindingId)) {
    throw new Error(`invalid_codex_binding_reservation:${invalidReservationReason(value, value.bindingId)}`);
  }
}
/** Bounded shape-only diagnostic. It never includes authority-bearing values. */
function invalidReservationReason(value: unknown, key: unknown): string {
  if (!isPlainRecord(value)) return "shape";
  if (value["bindingId"] !== key || !isOpaqueText(value["bindingId"])) return "binding_id";
  if (!isOpaqueText(value["reservationId"])) return "reservation_id";
  if (value["state"] !== "opening" && value["state"] !== "rebinding") return "state";
  if (!isGeneration(value["bindingGeneration"], true)) return "binding_generation";
  if (!isChild(value["child"])) return "child";
  if (!isOpaqueText(value["taskId"])) return "task_id";
  if (!isOpaqueText(value["jobId"])) return "job_id";
  if (value["state"] === "opening") {
    const required = ["bindingId", "bindingGeneration", "workspace", "taskId", "jobId", "workingDirectory", "posture", "child", "reservationId", "state"];
    if (!hasExactKeys(value, required, ["model"])) return "opening_keys";
    if (!isWorkspaceReceipt(value["workspace"])) return "workspace";
    if (!isBoundedText(value["workingDirectory"], 4096, false)) return "working_directory";
    if (value["model"] !== undefined && !isModel(value["model"])) return "model";
    if (!isPosture(value["posture"])) return "posture";
    return "opening_contract";
  }
  const required = ["bindingId", "bindingGeneration", "taskId", "jobId", "threadId", "successorWorkspace", "nextBindingGeneration", "child", "current", "reservationId", "state"];
  if (!hasExactKeys(value, required)) return "rebind_keys";
  if (!isOpaqueText(value["threadId"])) return "thread_id";
  if (!isWorkspaceReceipt(value["successorWorkspace"])) return "successor_workspace";
  if (!isGeneration(value["nextBindingGeneration"])) return "next_binding_generation";
  if (!isPersistedRecord(value["current"], String(key))) return "current";
  return "rebind_contract";
}
function nodeCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String((error as { readonly code?: unknown }).code) : undefined; }
