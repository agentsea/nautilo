import { sep } from "node:path";
import { CodexBindingRegistry, sameChild } from "./binding-registry";
import {
  CodexHostError,
  type AppServerClient,
  type AppServerClientFactory,
  type AppServerAccountProjection,
  type AppServerChatgptLogin,
  type AppServerUsageProjection,
  type AccountSupervisorRequest,
  type BindingRequest,
  type BindingRebindRequest,
  type BindingOpenReservation,
  type BindingRebindReservation,
  type BindingResumeRequest,
  type BoundThread,
  type ChildIdentity,
  type CodexBindingStore,
  type CodexSupervisorFault,
  type HostClock,
  type HostTimer,
  type HostTimerHandle,
  type ManagedChildProcess,
  type ProcessHost,
  type PersistedBindingRecord,
  type ProfileHome,
  type ProfileHomeRemovalContext,
  type ProfileRemovalRequest,
  type ProfileRemovalTurnCoordinator,
  type RuntimeLease,
  type RuntimeProvider,
  type SupervisorRequest,
  type TurnTerminalWaiter,
} from "./contracts";
import { CodexProfileHomeRegistry } from "./profile-homes";
import { CodexServiceDirectory } from "./service-directory";
import { CodexWorkspaceReceiptAuthority } from "./workspace-receipts";

export const DEFAULT_IDLE_REAP_MS = 30 * 60 * 1000;
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_INTERRUPT_GRACE_MS = 2 * 1000;
/** Bounds the whole destructive removal admission, including third-party seams. */
export const DEFAULT_PROFILE_REMOVAL_TIMEOUT_MS = 15 * 1000;
export const DEFAULT_PATH_DELIMITER = process.platform === "win32" ? ";" : ":";
const MAX_CHILD_ENV_ENTRIES = 128;
const MAX_CHILD_ENV_VALUE_BYTES = 32 * 1024;
const MAX_RUNTIME_PATH_ENTRIES = 32;
const MAX_RUNTIME_PATH_ENTRY_BYTES = 4 * 1024;

export interface CodexProfileSupervisorOptions {
  readonly workspaces: CodexWorkspaceReceiptAuthority;
  readonly homes: CodexProfileHomeRegistry;
  /** Verified host-configured cwd for account-only work; never a workspace. */
  readonly serviceDirectory: CodexServiceDirectory;
  readonly runtimes: RuntimeProvider;
  readonly processes: ProcessHost;
  readonly clients: AppServerClientFactory;
  readonly bindings: CodexBindingStore;
  readonly clock: HostClock;
  readonly timer: HostTimer;
  readonly idleReapMs?: number;
  readonly initializeTimeoutMs?: number;
  readonly interruptGraceMs?: number;
  /** Total wall-clock budget for one destructive profile-removal attempt. */
  readonly profileRemovalTimeoutMs?: number;
  readonly maxBindings?: number;
  readonly maxProfiles?: number;
  readonly environment?: Readonly<Record<string, string>>;
  /** Injectable only for tests; defaults to the host platform separator. */
  readonly pathDelimiter?: string;
  readonly turnTerminal: TurnTerminalWaiter;
  readonly onFault: (fault: CodexSupervisorFault) => Promise<void> | void;
  /** Deliberately absent until a host can prove exact turn cancellation. */
  readonly removalTurnCoordinator?: ProfileRemovalTurnCoordinator | undefined;
}

interface ChildRecord {
  readonly profileKey: string;
  readonly identity: ChildIdentity;
  readonly process: ManagedChildProcess;
  readonly client: AppServerClient;
  readonly lease: RuntimeLease;
  readonly bindings: CodexBindingRegistry;
  readonly serviceCwd: string;
  readonly profileHomePath: string;
  readonly profileRootPath: string;
  readonly runtimeCanonicalPaths: readonly string[];
  threadOperations: number;
  readonly threadDrainWaiters: Set<() => void>;
  accountRpcs: number;
  readonly accountDrainWaiters: Set<() => void>;
  accountMutationTail: Promise<void>;
  idleTimer: HostTimerHandle | undefined;
  stopping: Promise<boolean> | undefined;
  draining: boolean;
  terminal: boolean;
  exited: boolean;
  leaseReleased: boolean;
  exitFinalizer: Promise<void> | undefined;
  processUncertain: boolean;
  stopGeneration: number;
  /** One reviewed turn per profile makes whole-tree Stop non-collateral. */
  activeTurn: boolean;
  activeTurnId: string | null;
}

/** Resources that have crossed spawn but have not yet become a child record. */
interface StartingRecord {
  readonly key: string;
  readonly allowRemoval: boolean;
  lease: RuntimeLease | undefined;
  process: ManagedChildProcess | undefined;
  client: AppServerClient | undefined;
  identity: ChildIdentity | undefined;
  abandoned: boolean;
  clientClosed: boolean;
  leaseReleased: boolean;
  /** Once true, this exact spawned process was proven gone; never signal it again. */
  processContained: boolean;
  processUncertain: boolean;
  containment: Promise<void> | undefined;
}

interface RemovalAttempt {
  readonly generation: number;
  readonly expired: Promise<never>;
  rejectExpired: (error: CodexHostError) => void;
  timer: HostTimerHandle | undefined;
  revoked: boolean;
  committed: boolean;
}

interface RemovalRecord {
  readonly key: string;
  readonly requested: ProfileRemovalRequest;
  readonly home: ProfileHome;
  child: ChildIdentity | undefined;
  context: ProfileHomeRemovalContext | undefined;
  processUncertain: boolean;
  operation: Promise<void> | undefined;
  attempt: RemovalAttempt | undefined;
  attemptGeneration: number;
}

/** One slot per profile/host. Generation mismatch drains then replaces; it never runs both. */
export class CodexProfileSupervisor {
  private readonly children = new Map<string, ChildRecord>();
  private readonly starting = new Map<string, Promise<ChildRecord>>();
  private readonly startingRecords = new Map<string, StartingRecord>();
  /** Permanent profile gates: a failed destructive operation must never admit a successor. */
  private readonly removals = new Map<string, RemovalRecord>();
  /** Reservation happens before thread/start, not after it returns. */
  private readonly openingBindings = new Map<string, Promise<BoundThread>>();
  private readonly nextGeneration = new Map<string, number>();
  private readonly idleReapMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly interruptGraceMs: number;
  private readonly profileRemovalTimeoutMs: number;
  private readonly maxProfiles: number;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly pathDelimiter: string;
  private closed = false;
  private shutdownPromise: Promise<void> | undefined;
  private admitted = 0;
  private admissionDrained: (() => void) | undefined;

  constructor(private readonly options: CodexProfileSupervisorOptions) {
    this.idleReapMs = options.idleReapMs ?? DEFAULT_IDLE_REAP_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.interruptGraceMs = options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    this.profileRemovalTimeoutMs = options.profileRemovalTimeoutMs ?? DEFAULT_PROFILE_REMOVAL_TIMEOUT_MS;
    this.maxProfiles = options.maxProfiles ?? 4;
    this.environment = validatedEnvironment(options.environment ?? {});
    this.pathDelimiter = options.pathDelimiter ?? DEFAULT_PATH_DELIMITER;
    if (!this.pathDelimiter || this.pathDelimiter.includes("\0")) throw new Error("pathDelimiter must be non-empty");
    if (this.idleReapMs <= 0 || this.initializeTimeoutMs <= 0 || this.interruptGraceMs <= 0 || this.profileRemovalTimeoutMs <= 0) throw new Error("Supervisor time limits must be positive");
  }

  async ensure(request: AccountSupervisorRequest): Promise<ChildIdentity> {
    return this.admit(async () => {
      const record = await this.ensureRecord(request);
      if (this.removals.has(profileKey(request))) throw new CodexHostError("CHILD_GENERATION_STALE", "Profile removal is in progress");
      await this.scheduleIfIdle(record);
      return record.identity;
    });
  }

  /** Exact-current-child account methods intentionally require no workspace receipt. */
  async startChatgptLogin(child: ChildIdentity): Promise<AppServerChatgptLogin> {
    return this.accountRpc(child, true, (client) => client.startChatgptLogin());
  }

  async cancelLogin(child: ChildIdentity, upstreamLoginId: string): Promise<{ readonly cancelled: boolean }> {
    return this.accountRpc(child, true, (client) => client.cancelLogin(upstreamLoginId));
  }

  async readAccount(child: ChildIdentity): Promise<AppServerAccountProjection> {
    return this.accountRpc(child, false, (client) => client.readAccount());
  }

  async readUsage(child: ChildIdentity): Promise<AppServerUsageProjection> {
    return this.accountRpc(child, false, (client) => client.readUsage());
  }

  async listModels(child: ChildIdentity): Promise<import("./contracts").AppServerModelCatalog> {
    return this.accountRpc(child, false, (client) => client.listModels());
  }

  async logout(child: ChildIdentity): Promise<void> {
    await this.accountRpc(child, true, (client) => client.logout());
  }

  /** Dedicated destructive path; it never treats ordinary drain as sufficient proof. */
  async removeProfile(request: ProfileRemovalRequest): Promise<void> {
    return this.admit(async () => {
      const key = profileKey(request);
      if (!sameProfile(request.home.identity, request.profile)) throw new CodexHostError("PROFILE_HOME_INVALID", "Removal home authority changed");
      let removal = this.removals.get(key);
      if (removal) {
        if (!sameRemovalRequest(removal.requested, request)) throw new CodexHostError("CHILD_GENERATION_STALE", "Profile removal authority changed");
        if (removal.operation) return removal.operation;
      } else {
        removal = { key, requested: request, home: request.home, child: undefined, context: undefined, processUncertain: false, operation: undefined, attempt: undefined, attemptGeneration: 0 };
        this.removals.set(key, removal);
      }
      if (removal.processUncertain) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Profile process group is not proven gone");
      const operation = this.runRemovalAttempt(removal);
      removal.operation = operation;
      try { await operation; }
      finally { if (removal.operation === operation) removal.operation = undefined; }
    });
  }

  async open(request: SupervisorRequest, binding: BindingRequest): Promise<BoundThread> {
    return this.admit(async () => {
      const record = await this.ensureRecord(request);
      return this.withThreadOperation(record, async () => {
        const reservation = await record.bindings.reserveOpen(binding);
        if (reservation.kind === "existing") {
          await this.revalidateBindingWorkspace(request, binding);
          this.assertWorkingDirectoryDisjoint(record, binding.workingDirectory);
          this.assertCurrentRecord(record);
          return reservation.binding;
        }
        const reservationKey = `${profileKey(record.identity)}\u0000${record.identity.childGeneration}\u0000${binding.bindingId}`;
        const pending = this.openingBindings.get(reservationKey);
        if (pending) return pending;
        if (reservation.kind === "pending") throw new CodexHostError("BINDING_UNCERTAIN", "Prior binding open is awaiting recovery");
        const opening = this.openNewBinding(record, request, reservation.reservation);
        this.openingBindings.set(reservationKey, opening);
        try { return await opening; } finally { this.openingBindings.delete(reservationKey); }
      });
    });
  }

  async resume(request: SupervisorRequest, binding: BindingResumeRequest): Promise<BoundThread> {
    return this.admit(async () => {
      const record = await this.ensureRecord(request);
      return this.withThreadOperation(record, async () => {
        this.cancelIdle(record);
        const persisted = await record.bindings.matchResume(binding);
        const routing = await this.revalidateBindingWorkspace(request, binding);
        const workingDirectory = persisted.workingDirectory ?? routing.rootPath;
        this.assertWorkingDirectoryDisjoint(record, workingDirectory);
        this.assertCurrentRecord(record);
        this.assertOpen();
        const resumed = await record.client.resumeThread({ threadId: persisted.threadId, cwd: workingDirectory, model: persisted.model });
        this.assertCurrentRecord(record);
        if (resumed.cwd !== workingDirectory) throw new CodexHostError("WORKSPACE_STALE", "Codex app-server resumed outside its bound working directory");
        return { bindingId: persisted.bindingId, bindingGeneration: persisted.bindingGeneration, threadId: persisted.threadId, child: persisted.child };
      });
    });
  }

  async rebind(request: SupervisorRequest, binding: BindingRebindRequest): Promise<BoundThread> {
    return this.admit(async () => {
      const record = await this.ensureRecord(request);
      return this.withThreadOperation(record, async () => {
        this.cancelIdle(record);
        const persisted = await record.bindings.get(binding.bindingId, record.identity);
        if (binding.threadId !== persisted.threadId || binding.taskId !== persisted.taskId || binding.jobId !== persisted.jobId || binding.bindingGeneration !== persisted.bindingGeneration) {
          throw new CodexHostError("CHILD_GENERATION_STALE", "Rebind thread authority changed");
        }
        const reserved = await record.bindings.reserveRebind(binding, persisted);
        const reservationKey = `${profileKey(record.identity)}\u0000${record.identity.childGeneration}\u0000rebind\u0000${binding.bindingId}`;
        const pending = this.openingBindings.get(reservationKey);
        if (pending) return pending;
        if (reserved.kind === "pending") throw new CodexHostError("BINDING_UNCERTAIN", "Prior binding rebind is awaiting recovery");
        const work = this.completeRebind(record, request, persisted, reserved.reservation);
        this.openingBindings.set(reservationKey, work);
        try { return await work; } finally { this.openingBindings.delete(reservationKey); }
      });
    });
  }
  private async completeRebind(record: ChildRecord, request: SupervisorRequest, persisted: Awaited<ReturnType<CodexBindingRegistry["get"]>>, reservation: BindingRebindReservation): Promise<BoundThread> {
    let called = false;
    try {
      const routing = await this.revalidateRebindWorkspace(request, reservation);
      const workingDirectory = persisted.workingDirectory ?? routing.rootPath;
      this.assertWorkingDirectoryDisjoint(record, workingDirectory);
      this.assertCurrentRecord(record);
      this.assertOpen();
      called = true;
      const resumed = await record.client.resumeThread({ threadId: persisted.threadId, cwd: workingDirectory, model: persisted.model });
      this.assertCurrentRecord(record);
      if (resumed.cwd !== workingDirectory) throw new CodexHostError("WORKSPACE_STALE", "Codex app-server resumed outside its bound working directory");
      const rebound = await record.bindings.completeRebind(reservation, persisted);
      return rebound;
    } catch (error) {
      if (!called) await record.bindings.abortRebind(reservation);
      throw error;
    }
  }

  async startTurn(
    request: SupervisorRequest,
    binding: BindingResumeRequest,
    input: {
      readonly text: string;
      readonly clientUserMessageId: string;
      readonly collaborationMode: "work" | "plan";
    },
  ): Promise<{ readonly turnId: string }> {
    return this.admit(async () => {
      const record = await this.ensureRecord(request);
      return this.withThreadOperation(record, async () => {
        this.cancelIdle(record);
        if (record.activeTurn) {
          throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex profile already has an active turn");
        }
        record.activeTurn = true;
        let activityRecorded = false;
        try {
          const persisted = await record.bindings.matchResume(binding);
          await this.revalidateBindingWorkspace(request, binding);
          this.assertCurrentRecord(record);
          await record.bindings.updateActivity(binding.bindingId, {
            activeTurns: persisted.activeTurns + 1,
          });
          activityRecorded = true;
          const started = await record.client.startTurn({
            threadId: persisted.threadId,
            text: input.text,
            clientUserMessageId: input.clientUserMessageId,
            collaborationMode: input.collaborationMode,
          });
          record.activeTurnId = started.turnId;
          return started;
        } catch (error) {
          record.activeTurn = false;
          record.activeTurnId = null;
          if (activityRecorded) {
            const current = await record.bindings.get(binding.bindingId, record.identity);
            await record.bindings.updateActivity(binding.bindingId, {
              activeTurns: Math.max(0, current.activeTurns - 1),
            });
          }
          throw error;
        }
      });
    });
  }

  async bindingForThread(
    child: ChildIdentity,
    threadId: string,
  ): Promise<PersistedBindingRecord | undefined> {
    const record = this.getExactChild(child);
    return record.bindings.getByThread(threadId);
  }

  async completeTurn(
    child: ChildIdentity,
    bindingId: BindingRequest["bindingId"],
  ): Promise<void> {
    const record = this.getExactChild(child);
    record.activeTurn = false;
    record.activeTurnId = null;
    const current = await record.bindings.get(bindingId, child);
    await record.bindings.updateActivity(bindingId, {
      activeTurns: Math.max(0, current.activeTurns - 1),
    });
    await this.scheduleIfIdle(record);
  }

  async interrupt(child: ChildIdentity, bindingId: BindingRequest["bindingId"], turnId: string): Promise<void> {
    const record = this.getExactChild(child);
    const binding = await record.bindings.get(bindingId, child);
    if (record.activeTurnId && record.activeTurnId !== turnId) {
      throw new CodexHostError("CHILD_GENERATION_STALE", "Codex turn authority changed");
    }
    // Upstream `turn/completed: interrupted` is semantic state, not proof
    // that a detached command group is absent. The profile child admits one
    // active turn, so Stop owns and contains its complete process tree.
    record.activeTurn = false;
    record.activeTurnId = null;
    record.draining = true;
    await record.bindings.updateActivity(bindingId, {
      activeTurns: Math.max(0, binding.activeTurns - 1),
    });
    const contained = await this.forceStop(record);
    if (!contained) {
      throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex turn process containment is uncertain");
    }
  }

  async steer(
    child: ChildIdentity,
    bindingId: BindingRequest["bindingId"],
    turnId: string,
    input: { readonly text: string; readonly clientUserMessageId: string },
  ): Promise<void> {
    const record = this.getExactChild(child);
    const binding = await record.bindings.get(bindingId, child);
    if (binding.activeTurns < 1) {
      throw new CodexHostError("BINDING_UNCERTAIN", "Codex binding has no active turn");
    }
    await record.client.steerThread({
      threadId: binding.threadId,
      turnId,
      text: input.text,
      clientUserMessageId: input.clientUserMessageId,
    });
  }

  async updateBindingActivity(child: ChildIdentity, bindingId: BindingRequest["bindingId"], activity: Pick<Awaited<ReturnType<CodexBindingRegistry["get"]>>, "activeTurns" | "pendingRequests" | "outstandingRpcs">): Promise<void> {
    const record = this.getExactChild(child);
    await record.bindings.get(bindingId, child);
    await record.bindings.updateActivity(bindingId, activity);
    await this.scheduleIfIdle(record);
  }

  async releaseBinding(child: ChildIdentity, bindingId: BindingRequest["bindingId"]): Promise<void> {
    const record = this.getExactChild(child);
    await record.bindings.get(bindingId, child);
    await record.bindings.remove(bindingId);
    await this.scheduleIfIdle(record);
  }

  /**
   * Removes an unreachable host binding only when its full immutable resume
   * authority still belongs to this exact current child. This is used for a
   * server-side persistence CAS loss after host-first open.
   */
  async releaseBindingExact(child: ChildIdentity, binding: BindingResumeRequest): Promise<void> {
    const record = this.getExactChild(child);
    const persisted = await record.bindings.matchResume(binding);
    await record.bindings.remove(persisted.bindingId);
    await this.scheduleIfIdle(record);
  }

  async drain(child: ChildIdentity): Promise<void> { await this.stop(this.getExactChild(child)); }
  /** Read-only activity fence for local lifecycle decisions such as relay refresh. */
  async hasActiveWork(): Promise<boolean> {
    if (this.closed) return false;
    // A binding/open/child start can be in the interval before its durable
    // activity counters exist. Treat every local admission as active so a
    // Current Folder refresh cannot tear down that in-flight operation.
    if (
      this.admitted > 0 ||
      this.openingBindings.size > 0 ||
      this.starting.size > 0 ||
      this.startingRecords.size > 0
    ) return true;
    try {
      const states = await Promise.all(
        [...this.children.values()]
          .filter((record) => !record.terminal && !record.draining && !record.stopping)
          .map((record) => record.bindings.isIdle()),
      );
      return states.some((idle) => !idle);
    } catch {
      // An uninspectable local binding must not authorize killing its child.
      return true;
    }
  }
  /** Read-only callback seam; stale, stopping, removed, and closed children are false. */
  isCurrentChild(child: ChildIdentity): boolean {
    if (this.closed) return false;
    try {
      const record = this.getExactChild(child);
      return !record.draining && !record.stopping;
    } catch {
      return false;
    }
  }
  /** Factory callback seam: a transport fault can only stop its exact current child. */
  async onClientFault(child: ChildIdentity): Promise<void> {
    // Claim exact fault ownership synchronously. In particular, do not join an
    // intentional drain/removal/shutdown stop and then misclassify its result
    // as a transport crash. A second exact fault observes this claim too.
    if (this.closed) return;
    const key = profileKey(child);
    if (this.removals.has(key)) return;
    const record = this.children.get(key);
    if (!record || record.terminal || record.draining || record.stopping || !sameChild(record.identity, child)) return;
    record.draining = true;
    const owner = ++record.stopGeneration;
    const stopping = this.stopRecord(record, false, owner);
    record.stopping = stopping;
    const gone = await stopping;
    if (!this.ownsStop(record, owner) || record.stopping !== stopping) return;
    await this.fault(gone ? { kind: "child_crashed", child } : { kind: "process_group_uncertain", child });
  }
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async ensureRecord(request: AccountSupervisorRequest): Promise<ChildRecord> {
    this.assertOpen();
    const key = profileKey(request);
    if (this.removals.has(key)) throw new CodexHostError("CHILD_GENERATION_STALE", "Profile removal is in progress");
    const existing = this.children.get(key);
    if (existing) {
      if (existing.stopping && !existing.terminal) { await existing.stopping; return this.ensureRecord(request); }
      if (!existing.terminal && sameRequestedGeneration(existing.identity, request)) { this.cancelIdle(existing); return existing; }
      if (!existing.terminal) { await this.stop(existing); return this.ensureRecord(request); }
      if (!existing.leaseReleased || existing.processUncertain) {
        throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Prior Codex child has not been proven contained");
      }
    }
    const pending = this.starting.get(key);
    if (pending) {
      const record = await pending;
      if (sameRequestedGeneration(record.identity, request)) return record;
      await this.stop(record);
      return this.ensureRecord(request);
    }
    if (this.children.size + this.starting.size >= this.maxProfiles) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex profile host capacity reached");
    this.assertOpen();
    const starting = this.newStartingRecord(key);
    const start = this.start(request, key, starting);
    this.assertOpen();
    this.starting.set(key, start);
    this.startingRecords.set(key, starting);
    try { return await start; } finally {
      if (this.starting.get(key) === start) this.starting.delete(key);
      if (this.startingRecords.get(key) === starting) this.startingRecords.delete(key);
    }
  }

  private newStartingRecord(key: string, allowRemoval = false): StartingRecord {
    return { key, allowRemoval, lease: undefined, process: undefined, client: undefined, identity: undefined, abandoned: false, clientClosed: false, leaseReleased: false, processContained: false, processUncertain: false, containment: undefined };
  }

  private async start(request: AccountSupervisorRequest, key: string, starting: StartingRecord): Promise<ChildRecord> {
    let lease: RuntimeLease | undefined;
    let process: ManagedChildProcess | undefined;
    let client: AppServerClient | undefined;
    let identity: ChildIdentity | undefined;
    try {
      const home = await this.options.homes.ensure(request.profile);
      const homePath = await this.options.homes.resolveForLaunch(home);
      const profileRootPath = await this.options.homes.resolveRootForSafety();
      const acquired = await this.options.runtimes.acquire(request.runtimeGeneration);
      lease = acquired.lease;
      starting.lease = lease;
      if (acquired.launch.runtimeGeneration !== request.runtimeGeneration) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Runtime provider returned a different generation");
      const runtimeCanonicalPaths = Object.freeze([acquired.launch.executablePath, ...(acquired.launch.pathEntries ?? [])]);
      const serviceDirectory = await this.options.serviceDirectory.ensure();
      // Final async revalidation immediately before spawn.
      const serviceCwd = await this.options.serviceDirectory.resolveForLaunch(serviceDirectory, [homePath, profileRootPath, ...runtimeCanonicalPaths]);
      this.assertStartingAvailable(starting);
      this.assertOpen();
      identity = this.childIdentity(request, key);
      starting.identity = identity;
      process = await this.options.processes.spawn({ executablePath: acquired.launch.executablePath, args: acquired.launch.args, cwd: serviceCwd, env: this.childEnvironment(homePath, acquired.launch.pathEntries), detached: true });
      starting.process = process;
      if (starting.abandoned) { await this.containStarting(starting); throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex child start was abandoned"); }
      client = await this.options.clients.connect(process, identity);
      starting.client = client;
      if (starting.abandoned) { await this.containStarting(starting); throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex child start was abandoned"); }
      const initialized = await this.withTimeout(client.initialize(), this.initializeTimeoutMs, "Codex app-server initialization timed out");
      if (initialized.codexHome !== homePath) throw new CodexHostError("PROFILE_HOME_INVALID", "Codex app-server initialized with a different profile home");
      // A public start which crossed spawn before the gate was installed may
      // finish initialization, but it is never returned to its caller: ensure
      // checks the gate after `ensureRecord`. Publishing the exact record lets
      // the removal attempt own/logout that already-spawned child.
      if (this.closed || starting.abandoned) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex supervisor is shut down");
      const record: ChildRecord = {
        profileKey: key, identity, process, client, lease,
        bindings: new CodexBindingRegistry(identity, this.options.bindings, this.options.maxBindings),
        serviceCwd, profileHomePath: homePath, profileRootPath, runtimeCanonicalPaths,
        threadOperations: 0, threadDrainWaiters: new Set(),
        accountRpcs: 0, accountDrainWaiters: new Set(), accountMutationTail: Promise.resolve(),
        idleTimer: undefined, stopping: undefined, draining: false, terminal: false, exited: false, leaseReleased: false, exitFinalizer: undefined, processUncertain: false, stopGeneration: 0, activeTurn: false, activeTurnId: null,
      };
      this.children.set(key, record);
      void process.exited.then(() => { record.exited = true; return this.onExit(record); }).catch(() => undefined);
      return record;
    } catch (error) {
      if (starting.abandoned || this.closed) {
        await this.containStarting(starting);
      } else {
        if (client) await this.closeQuietly(client);
        const groupGone = process ? await this.terminateProcess(process) : true;
        if (lease && groupGone) await this.releaseQuietly(lease);
        else if (lease && identity) await this.fault({ kind: "process_group_uncertain", child: identity });
      }
      if (error instanceof CodexHostError) throw error;
      throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Could not start Codex app-server child");
    }
  }

  private assertStartingAvailable(starting: StartingRecord): void {
    if (starting.abandoned || this.closed || (!starting.allowRemoval && this.removals.has(starting.key))) {
      throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex child start is no longer admitted");
    }
  }

  /**
   * Start can be stuck in a third-party initialize/connect promise after spawn.
   * Containment owns only resources already observed, and every later observed
   * resource re-enters here before it could be admitted to `children`.
   */
  private async containStarting(starting: StartingRecord): Promise<void> {
    starting.abandoned = true;
    const prior = starting.containment ?? Promise.resolve();
    const work = prior.then(async () => {
      const client = starting.client;
      if (client && !starting.clientClosed) {
        starting.clientClosed = true;
        await this.boundedQuietly(this.closeQuietly(client));
      }
      const process = starting.process;
      let gone = !process || starting.processContained;
      if (process && !starting.processContained) {
        gone = await this.forceTerminateProcess(process);
        if (gone) starting.processContained = true;
      }
      if (!gone) {
        starting.processUncertain = true;
        // The start can cross spawn after a removal timeout has already
        // abandoned its key. Preserve that late uncertainty on the permanent
        // removal record as well; no successor may be launched over it.
        const removal = this.removals.get(starting.key);
        if (removal) removal.processUncertain = true;
        if (starting.identity) await this.boundedQuietly(this.fault({ kind: "process_group_uncertain", child: starting.identity }));
        return;
      }
      if (starting.lease && !starting.leaseReleased) {
        starting.leaseReleased = true;
        await this.boundedQuietly(this.releaseQuietly(starting.lease));
      }
    });
    starting.containment = work.catch(() => undefined);
    await starting.containment;
  }

  private async runRemovalAttempt(removal: RemovalRecord): Promise<void> {
    const attempt = this.newRemovalAttempt(removal);
    removal.attempt = attempt;
    try {
      await this.removeProfileRecord(removal, attempt);
    } finally {
      if (attempt.timer !== undefined) this.options.timer.clearTimeout(attempt.timer);
      if (removal.attempt === attempt) removal.attempt = undefined;
      // If process.exited ran while this attempt owned the record, its first
      // callback intentionally stood down. Re-enter exact singleflight after
      // ownership clears; without this an active-work failure could strand a
      // dead child and its lease behind the permanent gate.
      const record = this.children.get(removal.key);
      if (record?.exited) void this.onExit(record).catch(() => undefined);
    }
  }

  private newRemovalAttempt(removal: RemovalRecord): RemovalAttempt {
    let rejectExpired!: (error: CodexHostError) => void;
    const attempt: RemovalAttempt = {
      generation: ++removal.attemptGeneration,
      expired: new Promise<never>((_resolve, reject) => { rejectExpired = reject; }),
      rejectExpired,
      timer: undefined,
      revoked: false,
      committed: false,
    };
    attempt.timer = this.options.timer.setTimeout(() => {
      if (removal.attempt !== attempt || attempt.revoked || attempt.committed) return;
      attempt.revoked = true;
      attempt.rejectExpired(new CodexHostError("SUPERVISOR_UNAVAILABLE", "Profile removal timed out"));
      // Do not wait for a possibly wedged dependency: it no longer owns this
      // child, but exact-child containment is still worthwhile.
      void this.containExpiredRemoval(removal, attempt);
    }, this.profileRemovalTimeoutMs);
    return attempt;
  }

  private assertCurrentAttempt(removal: RemovalRecord, attempt: RemovalAttempt): void {
    if (attempt.revoked || removal.attempt !== attempt || this.removals.get(removal.key) !== removal) {
      throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Profile removal attempt expired or was replaced");
    }
  }

  private async removalPhase<T>(removal: RemovalRecord, attempt: RemovalAttempt, work: Promise<T>): Promise<T> {
    this.assertCurrentAttempt(removal, attempt);
    const value = await Promise.race([work, attempt.expired]);
    this.assertCurrentAttempt(removal, attempt);
    return value;
  }

  private async containExpiredRemoval(removal: RemovalRecord, attempt: RemovalAttempt): Promise<void> {
    if (removal.attempt !== attempt || !attempt.revoked) return;
    // A timeout may race a start before it has published a ChildRecord. The
    // permanent key gate owns that exact starting slot too: abandon it now so
    // a late connect/initialize can only be contained, never published.
    const starting = this.startingRecords.get(removal.key);
    if (starting && this.starting.has(removal.key)) {
      starting.abandoned = true;
      await this.containStarting(starting);
      if (starting.processUncertain) removal.processUncertain = true;
    }
    const child = removal.child;
    const record = child ? this.children.get(removal.key) : undefined;
    if (!record || !child || !sameChild(record.identity, child)) return;
    // stop() is exact-record singleflight. It cannot affect a successor since
    // the permanent removal gate prevents one while this record is retained.
    try {
      const gone = await this.forceStop(record, false);
      if (!gone) removal.processUncertain = true;
    } catch { /* timeout containment is best effort only */ }
  }

  private async removeProfileRecord(removal: RemovalRecord, attempt: RemovalAttempt): Promise<void> {
    this.assertCurrentAttempt(removal, attempt);
    let record: ChildRecord | undefined;
    const pending = this.starting.get(removal.key);
    if (pending) {
      try { record = await this.removalPhase(removal, attempt, pending); }
      catch (error) {
        // A public start that observes the removal gate must fail stale; it is
        // not a process uncertainty, so the removal-only start may continue.
        if (!(error instanceof CodexHostError) || error.code !== "CHILD_GENERATION_STALE") throw error;
      }
      if (!record) this.assertCurrentAttempt(removal, attempt);
      if (record && !sameRequestedGeneration(record.identity, removal.requested)) {
        throw new CodexHostError("CHILD_GENERATION_STALE", "A successor child was started during removal");
      }
    }
    if (!record) {
      const current = this.children.get(removal.key);
      if (current && !current.terminal) {
        if (!sameRequestedGeneration(current.identity, removal.requested)) {
          throw new CodexHostError("CHILD_GENERATION_STALE", "Removal cannot drain a successor child");
        }
        if (removal.requested.existingChild && !sameChild(current.identity, removal.requested.existingChild)) {
          throw new CodexHostError("CHILD_GENERATION_STALE", "Controller child authority changed");
        }
        record = current;
      }
    }
    if (!record && removal.context) {
      this.assertCurrentAttempt(removal, attempt); // before registry deletion
      await this.removalPhase(removal, attempt, this.options.homes.removeAfterDrain(removal.home, removal.context, this.removalGate(removal, attempt)));
      return;
    }
    if (!record) record = await this.removalPhase(removal, attempt, this.ensureRemovalRecord(removal.requested));
    this.assertCurrentAttempt(removal, attempt);
    removal.child = record.identity;
    record.draining = true;
    this.cancelIdle(record);
    await this.removalPhase(removal, attempt, this.waitForRecordOperations(record));
    const before = await this.removalPhase(removal, attempt, this.options.bindings.list(record.identity));
    if (hasActiveBindingWork(before)) {
      const coordinator = this.options.removalTurnCoordinator;
      if (!coordinator) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Active profile work has no removal coordinator");
      await this.removalPhase(removal, attempt, coordinator.cancelAndWait({ child: record.identity, bindings: before }));
      const after = await this.removalPhase(removal, attempt, this.options.bindings.list(record.identity));
      if (hasActiveBindingWork(after)) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Active profile work did not drain");
    }
    if (await this.removalPhase(removal, attempt, record.process.isProcessGroupGone())) {
      await this.discardGoneWithoutLogout(removal, record, attempt);
      throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Profile exited before official logout");
    }
    // The permanent gate rejects every new account RPC. This direct, serialized
    // logout is the sole permitted final account action for the exact child.
    try {
      this.assertCurrentAttempt(removal, attempt); // before official logout
      await this.removalPhase(removal, attempt, record.client.logout());
    }
    catch {
      this.assertCurrentAttempt(removal, attempt);
      if (await this.removalPhase(removal, attempt, record.process.isProcessGroupGone())) {
        await this.discardGoneWithoutLogout(removal, record, attempt);
        throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Profile exited during official logout");
      }
      throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Profile logout failed");
    }
    this.assertCurrentAttempt(removal, attempt); // before terminalization
    record.terminal = true;
    await this.removalPhase(removal, attempt, this.closeQuietly(record.client));
    const gone = await this.removalPhase(removal, attempt, this.terminateProcess(record.process));
    if (!gone) {
      removal.processUncertain = true;
      await this.removalPhase(removal, attempt, this.fault({ kind: "process_group_uncertain", child: record.identity }));
      throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Profile process group is not proven gone");
    }
    await this.completeProvenRemoval(removal, record, attempt);
  }

  private async completeProvenRemoval(removal: RemovalRecord, record: ChildRecord, attempt: RemovalAttempt): Promise<void> {
    this.assertCurrentAttempt(removal, attempt); // before terminalization
    record.terminal = true;
    this.cancelIdle(record);
    await this.removalPhase(removal, attempt, this.closeQuietly(record.client));
    this.assertCurrentAttempt(removal, attempt);
    if (this.children.get(removal.key) === record) this.children.delete(removal.key);
    await this.removalPhase(removal, attempt, this.releaseRecord(record));
    this.assertCurrentAttempt(removal, attempt); // before proof creation
    removal.context = { drainedChild: record.identity, serviceDirectoryPath: record.serviceCwd, runtimeCanonicalPaths: record.runtimeCanonicalPaths };
    this.assertCurrentAttempt(removal, attempt); // before registry deletion
    await this.removalPhase(removal, attempt, this.options.homes.removeAfterDrain(removal.home, removal.context, this.removalGate(removal, attempt)));
  }

  /** A dead child cannot prove its official logout; retain home and gate for a fresh retry. */
  private async discardGoneWithoutLogout(removal: RemovalRecord, record: ChildRecord, attempt: RemovalAttempt): Promise<void> {
    this.assertCurrentAttempt(removal, attempt); // before terminalization
    record.terminal = true;
    this.cancelIdle(record);
    await this.removalPhase(removal, attempt, this.closeQuietly(record.client));
    this.assertCurrentAttempt(removal, attempt);
    if (this.children.get(removal.key) === record) this.children.delete(removal.key);
    await this.removalPhase(removal, attempt, this.releaseRecord(record));
    this.assertCurrentAttempt(removal, attempt);
    removal.child = undefined;
    removal.context = undefined;
  }

  private async ensureRemovalRecord(request: AccountSupervisorRequest): Promise<ChildRecord> {
    const key = profileKey(request);
    const existing = this.children.get(key);
    if (existing) {
      if (!sameRequestedGeneration(existing.identity, request)) throw new CodexHostError("CHILD_GENERATION_STALE", "Removal cannot launch over a successor child");
      if (!existing.terminal) return existing;
      if (!existing.leaseReleased || existing.processUncertain) {
        throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Prior Codex child has not been proven contained");
      }
    }
    const pending = this.starting.get(key);
    if (pending) return pending;
    if (this.children.size + this.starting.size >= this.maxProfiles) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex profile host capacity reached");
    const starting = this.newStartingRecord(key, true);
    const start = this.start(request, key, starting);
    this.starting.set(key, start);
    this.startingRecords.set(key, starting);
    try { return await start; } finally {
      if (this.starting.get(key) === start) this.starting.delete(key);
      if (this.startingRecords.get(key) === starting) this.startingRecords.delete(key);
    }
  }

  private async waitForRecordOperations(record: ChildRecord): Promise<void> {
    if (record.threadOperations > 0) await new Promise<void>((resolve) => record.threadDrainWaiters.add(resolve));
    if (record.accountRpcs > 0) await new Promise<void>((resolve) => record.accountDrainWaiters.add(resolve));
  }

  private removalGate(removal: RemovalRecord, attempt: RemovalAttempt) {
    return {
      assertDrained: (child: ChildIdentity) => {
        this.assertRemovalGateNow(removal, attempt, child);
        return Promise.resolve();
      },
      assertDrainedNow: (child: ChildIdentity) => {
        this.assertRemovalGateNow(removal, attempt, child);
      },
      commitDestruction: () => {
        this.assertRemovalGateNow(removal, attempt, removal.context?.drainedChild);
        // This is the last synchronous point before marker/root removal. It
        // clears the timeout so a successful final syscall cannot later be
        // reported to the caller as a timed-out operation.
        attempt.committed = true;
        if (attempt.timer !== undefined) {
          this.options.timer.clearTimeout(attempt.timer);
          attempt.timer = undefined;
        }
      },
    };
  }
  private assertRemovalGateNow(removal: RemovalRecord, attempt: RemovalAttempt, child: ChildIdentity | undefined): void {
        if (!child) throw new CodexHostError("CHILD_GENERATION_STALE", "Removal proof changed");
        this.assertCurrentAttempt(removal, attempt);
        if (!removal.context || !sameChild(removal.context.drainedChild, child) || !sameChild(removal.child ?? child, child)) {
          throw new CodexHostError("CHILD_GENERATION_STALE", "Removal proof changed");
        }
        if (this.removals.get(removal.key) !== removal || this.children.has(removal.key) || this.starting.has(removal.key)) {
          throw new CodexHostError("CHILD_GENERATION_STALE", "Profile removal gate is no longer exclusive");
        }
        if (removal.processUncertain) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Process group proof is uncertain");
  }

  private childIdentity(request: AccountSupervisorRequest, key: string): ChildIdentity {
    const childGeneration = (this.nextGeneration.get(key) ?? 0) + 1;
    this.nextGeneration.set(key, childGeneration);
    return Object.freeze({ profile: request.profile, accountGeneration: request.accountGeneration, runtimeGeneration: request.runtimeGeneration, childGeneration });
  }
  private childEnvironment(homePath: string, pathEntries: readonly string[] | undefined): Readonly<Record<string, string>> {
    if (!pathEntries || pathEntries.length === 0) return Object.freeze({ ...this.environment, CODEX_HOME: homePath });
    if (pathEntries.length > MAX_RUNTIME_PATH_ENTRIES) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Runtime supplied too many PATH entries");
    const entries = pathEntries.map((entry) => {
      if (!entry || entry.includes("\0") || Buffer.byteLength(entry, "utf8") > MAX_RUNTIME_PATH_ENTRY_BYTES) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Runtime supplied an invalid PATH entry");
      return entry;
    });
    const baseline = this.environment["PATH"];
    return Object.freeze({ ...this.environment, PATH: baseline ? `${entries.join(this.pathDelimiter)}${this.pathDelimiter}${baseline}` : entries.join(this.pathDelimiter), CODEX_HOME: homePath });
  }
  private async revalidateBindingWorkspace(request: SupervisorRequest, binding: Pick<BindingRequest, "workspace">) {
    const workspace = request.workspace;
    if (!binding.workspace || !sameReceipt(workspace, binding.workspace)) throw new CodexHostError("WORKSPACE_STALE", "Binding workspace does not match launch receipt");
    return this.options.workspaces.resolve(binding.workspace);
  }
  private async revalidateRebindWorkspace(request: SupervisorRequest, binding: BindingRebindRequest) {
    const workspace = request.workspace;
    if (!binding.successorWorkspace || !sameReceipt(workspace, binding.successorWorkspace)) throw new CodexHostError("WORKSPACE_STALE", "Binding workspace does not match rebind receipt");
    return this.options.workspaces.resolve(binding.successorWorkspace);
  }
  private async openNewBinding(record: ChildRecord, request: SupervisorRequest, reservation: BindingOpenReservation): Promise<BoundThread> {
    let called = false;
    try {
      await this.revalidateBindingWorkspace(request, reservation);
      this.assertWorkingDirectoryDisjoint(record, reservation.workingDirectory);
      this.assertCurrentRecord(record);
      this.cancelIdle(record);
      this.assertOpen();
      called = true;
      const started = await record.client.startThread({ cwd: reservation.workingDirectory, model: reservation.model, posture: reservation.posture });
      this.assertCurrentRecord(record);
      if (!started.threadId || started.cwd !== reservation.workingDirectory) throw new CodexHostError("WORKSPACE_STALE", "Codex app-server did not bind the requested working directory");
      const result = await record.bindings.completeOpen(reservation, started.threadId);
      return result;
    } catch (error) {
      if (!called) await record.bindings.abortOpen(reservation);
      throw error;
    }
  }
  private async onExit(record: ChildRecord): Promise<void> {
    const removal = this.removals.get(record.profileKey);
    // Normal stop/fault ownership already terminalized this record. Only a
    // retained profile-removal gate needs the special post-failure cleanup.
    if (!removal && record.terminal) return;
    if (record.stopping) {
      await record.stopping.catch(() => false);
      if (removal && removal.child && sameChild(removal.child, record.identity)) {
        removal.child = undefined;
        removal.context = undefined;
      }
      return;
    }
    // An in-flight attempt owns its exact child through its next checkpoint.
    // A failed/expired attempt does not: finalise this exact record once while
    // preserving the profile gate and home for a fresh official-login retry.
    if (removal?.attempt && !removal.attempt.revoked) return;
    if (record.exitFinalizer) return record.exitFinalizer;
    record.exitFinalizer = this.finalizeExitedRecord(record, removal);
    return record.exitFinalizer;
  }

  private async finalizeExitedRecord(record: ChildRecord, removal: RemovalRecord | undefined): Promise<void> {
    try {
      if (record.terminal && record.leaseReleased) return;
      record.terminal = true;
      this.cancelIdle(record);
      await this.boundedQuietly(this.closeQuietly(record.client));
      let gone = await this.withTimeout(record.process.isProcessGroupGone(), this.interruptGraceMs, "Exit probe timed out").catch(() => false);
      if (!gone) gone = await this.forceTerminateProcess(record.process);
      if (gone) {
        if (this.children.get(record.profileKey) === record) this.children.delete(record.profileKey);
        await this.releaseRecord(record);
        if (removal && removal.child && sameChild(removal.child, record.identity)) { removal.child = undefined; removal.context = undefined; }
        await this.boundedQuietly(this.fault({ kind: "child_crashed", child: record.identity }));
      } else {
        if (removal) removal.processUncertain = true;
        await this.boundedQuietly(this.fault({ kind: "process_group_uncertain", child: record.identity }));
      }
    } catch {
      if (removal) removal.processUncertain = true;
      await this.boundedQuietly(this.fault({ kind: "process_group_uncertain", child: record.identity }));
    }
  }
  private getExactChild(identity: ChildIdentity): ChildRecord {
    if (this.removals.has(profileKey(identity))) throw new CodexHostError("CHILD_GENERATION_STALE", "Profile removal is in progress");
    const record = this.children.get(profileKey(identity));
    if (!record || record.terminal || !sameChild(record.identity, identity)) throw new CodexHostError("CHILD_GENERATION_STALE", "Codex child generation is unavailable");
    return record;
  }
  private assertCurrentRecord(record: ChildRecord): void {
    if (this.removals.has(record.profileKey) || record.terminal || this.children.get(record.profileKey) !== record) {
      throw new CodexHostError("CHILD_GENERATION_STALE", "Codex child generation is unavailable");
    }
  }
  private acquireThreadOperation(record: ChildRecord): () => void {
    if (this.removals.has(record.profileKey) || record.draining || record.terminal || this.children.get(record.profileKey) !== record) {
      throw new CodexHostError("CHILD_GENERATION_STALE", "Codex child generation is unavailable");
    }
    record.threadOperations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      record.threadOperations = Math.max(0, record.threadOperations - 1);
      if (record.threadOperations === 0) {
        for (const resolve of record.threadDrainWaiters) resolve();
        record.threadDrainWaiters.clear();
      }
    };
  }
  private async withThreadOperation<T>(record: ChildRecord, work: () => Promise<T>): Promise<T> {
    const release = this.acquireThreadOperation(record);
    try { return await work(); }
    finally {
      try { await this.scheduleIfIdle(record, true); }
      finally { release(); }
    }
  }
  private assertWorkingDirectoryDisjoint(record: ChildRecord, workingDirectory: string): void {
    try { this.options.serviceDirectory.assertDisjoint(record.serviceCwd, [workingDirectory]); }
    catch { throw new CodexHostError("WORKSPACE_UNAVAILABLE", "Working directory overlaps protected Codex host storage"); }
    for (const protectedPath of [record.profileHomePath, record.profileRootPath, ...record.runtimeCanonicalPaths]) {
      if (pathsOverlap(workingDirectory, protectedPath)) throw new CodexHostError("WORKSPACE_UNAVAILABLE", "Working directory overlaps protected Codex host storage");
    }
  }
  private async accountRpc<T>(child: ChildIdentity, mutating: boolean, work: (client: AppServerClient) => Promise<T>): Promise<T> {
    return this.admit(async () => {
      if (this.removals.has(profileKey(child))) throw new CodexHostError("CHILD_GENERATION_STALE", "Profile removal is in progress");
      const record = this.getExactChild(child);
      this.cancelIdle(record);
      record.accountRpcs += 1;
      let releaseMutation: (() => void) | undefined;
      try {
        if (mutating) {
          const prior = record.accountMutationTail;
          const slot = new Promise<void>((resolve) => { releaseMutation = resolve; });
          record.accountMutationTail = prior.catch(() => undefined).then(() => slot);
          await prior.catch(() => undefined);
          this.assertCurrentRecord(record);
        }
        const result = await work(record.client);
        this.assertCurrentRecord(record);
        return result;
      } finally {
        releaseMutation?.();
        record.accountRpcs = Math.max(0, record.accountRpcs - 1);
        if (record.accountRpcs === 0) {
          for (const resolve of record.accountDrainWaiters) resolve();
          record.accountDrainWaiters.clear();
        }
        if (!record.terminal) await this.scheduleIfIdle(record);
      }
    });
  }
  private async scheduleIfIdle(record: ChildRecord, ownThreadLease = false): Promise<void> {
    if (record.terminal || record.draining) return;
    if (record.accountRpcs > 0) return;
    if (record.threadOperations > (ownThreadLease ? 1 : 0)) return;
    if (!(await record.bindings.isIdle())) return;
    if (record.terminal || record.draining || record.accountRpcs > 0 || record.threadOperations > (ownThreadLease ? 1 : 0)) return;
    this.cancelIdle(record);
    record.idleTimer = this.options.timer.setTimeout(() => {
      void record.bindings.isIdle().then((idle) => { if (idle && record.accountRpcs === 0 && record.threadOperations === 0) return this.stop(record); return undefined; });
    }, this.idleReapMs);
  }
  private cancelIdle(record: ChildRecord): void { if (record.idleTimer !== undefined) { this.options.timer.clearTimeout(record.idleTimer); record.idleTimer = undefined; } }
  private async stop(record: ChildRecord, reportUncertain = true): Promise<boolean> {
    if (record.stopping) return record.stopping;
    record.draining = true;
    const owner = ++record.stopGeneration;
    record.stopping = this.stopRecord(record, reportUncertain, owner);
    return record.stopping;
  }
  /** Timeout/shutdown containment never waits on product RPC drain waiters. */
  private async forceStop(record: ChildRecord, reportUncertain = true): Promise<boolean> {
    if (record.stopping) {
      const settled = await this.withTimeout(record.stopping, this.profileRemovalTimeoutMs, "Normal stop timed out").then(() => true, () => false);
      if (settled) return record.stopping;
      // A prior ordinary stop may be waiting on product drain work forever.
      // Supersede it with exact terminal containment; late normal cleanup is
      // harmless because terminal/release state is singleflight guarded.
      const owner = ++record.stopGeneration;
      const forced = this.forceStopRecord(record, reportUncertain, owner);
      record.stopping = forced;
      return forced;
    }
    record.draining = true;
    const owner = ++record.stopGeneration;
    record.stopping = this.forceStopRecord(record, reportUncertain, owner);
    return record.stopping;
  }
  private ownsStop(record: ChildRecord, owner: number): boolean { return record.stopGeneration === owner; }
  private async delegateStop(record: ChildRecord, owner: number): Promise<boolean> {
    if (this.ownsStop(record, owner)) return false;
    const successor = record.stopping;
    return successor ? successor.catch(() => false) : false;
  }
  private async forceStopRecord(record: ChildRecord, reportUncertain: boolean, owner: number): Promise<boolean> {
    if (!this.ownsStop(record, owner)) return this.delegateStop(record, owner);
    record.terminal = true;
    this.cancelIdle(record);
    let groupExited: boolean;
    try { groupExited = await this.forceTerminateProcess(record.process, () => this.ownsStop(record, owner)); }
    catch (error) {
      if (error instanceof StopSuperseded) return this.delegateStop(record, owner);
      throw error;
    }
    if (!this.ownsStop(record, owner)) return this.delegateStop(record, owner);
    // The process-tree adapter freezes ancestry at the first TERM edge. Do not
    // close the protocol client first: EOF can let the app-server root exit and
    // reparent independently detached tool groups before they are captured.
    await this.boundedQuietly(this.closeQuietly(record.client));
    if (!this.ownsStop(record, owner)) return this.delegateStop(record, owner);
    if (groupExited && this.children.get(record.profileKey) === record) this.children.delete(record.profileKey);
    if (groupExited) await this.releaseRecord(record);
    else {
      record.processUncertain = true;
      if (reportUncertain) void this.boundedQuietly(this.fault({ kind: "process_group_uncertain", child: record.identity }));
    }
    return groupExited;
  }
  private async stopRecord(record: ChildRecord, reportUncertain: boolean, owner: number): Promise<boolean> {
    if (record.threadOperations > 0) await new Promise<void>((resolve) => { record.threadDrainWaiters.add(resolve); });
    if (!this.ownsStop(record, owner)) return this.delegateStop(record, owner);
    record.terminal = true;
    this.cancelIdle(record);
    let groupExited: boolean;
    try { groupExited = await this.terminateProcess(record.process, () => this.ownsStop(record, owner)); }
    catch (error) {
      if (error instanceof StopSuperseded) return this.delegateStop(record, owner);
      throw error;
    }
    if (!this.ownsStop(record, owner)) return this.delegateStop(record, owner);
    await this.closeQuietly(record.client);
    if (!this.ownsStop(record, owner)) return this.delegateStop(record, owner);
    if (groupExited && this.children.get(record.profileKey) === record) this.children.delete(record.profileKey);
    if (groupExited) await this.releaseRecord(record);
    else {
      record.processUncertain = true;
      if (reportUncertain) await this.fault({ kind: "process_group_uncertain", child: record.identity });
    }
    return groupExited;
  }
  private async terminateProcess(process: ManagedChildProcess, stillOwns: () => boolean = () => true): Promise<boolean> {
    if (!stillOwns()) throw new StopSuperseded();
    // The Node adapter freezes and captures the complete descendant tree at
    // this first TERM edge. Never let a graceful root exit happen first: a
    // detached command could be reparented and become unprovable.
    await settleQuietly(process.signalProcessGroup("SIGTERM"));
    if (!stillOwns()) throw new StopSuperseded();
    await this.waitForExit(process, this.interruptGraceMs);
    if (!stillOwns()) throw new StopSuperseded();
    if (await process.isProcessGroupGone()) return true;
    if (!stillOwns()) throw new StopSuperseded();
    await settleQuietly(process.signalProcessGroup("SIGKILL"));
    if (!stillOwns()) throw new StopSuperseded();
    await this.waitForExit(process, this.interruptGraceMs);
    if (!stillOwns()) throw new StopSuperseded();
    return process.isProcessGroupGone();
  }
  private async forceTerminateProcess(process: ManagedChildProcess, stillOwns: () => boolean = () => true): Promise<boolean> {
    const limit = Math.max(1, this.interruptGraceMs);
    if (!stillOwns()) throw new StopSuperseded();
    await this.withTimeout(settleQuietly(process.signalProcessGroup("SIGTERM")), limit, "Process termination timed out").catch(() => undefined);
    if (!stillOwns()) throw new StopSuperseded();
    if (await this.withTimeout(process.isProcessGroupGone(), limit, "Process probe timed out").catch(() => false)) return true;
    if (!stillOwns()) throw new StopSuperseded();
    await this.withTimeout(settleQuietly(process.signalProcessGroup("SIGKILL")), limit, "Process kill timed out").catch(() => undefined);
    if (!stillOwns()) throw new StopSuperseded();
    return this.withTimeout(process.isProcessGroupGone(), limit, "Process probe timed out").catch(() => false);
  }
  private async withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: HostTimerHandle | undefined;
    try { return await Promise.race([work, new Promise<T>((_resolve, reject) => { timer = this.options.timer.setTimeout(() => reject(new CodexHostError("SUPERVISOR_UNAVAILABLE", message)), timeoutMs); })]); }
    finally { if (timer !== undefined) this.options.timer.clearTimeout(timer); }
  }
  private async waitForExit(process: ManagedChildProcess, timeoutMs: number): Promise<boolean> {
    let timer: HostTimerHandle | undefined;
    try {
      const exited = process.exited.then(() => true);
      await Promise.resolve();
      return await Promise.race([exited, new Promise<boolean>((resolve) => { timer = this.options.timer.setTimeout(() => resolve(false), timeoutMs); })]);
    } finally { if (timer !== undefined) this.options.timer.clearTimeout(timer); }
  }
  private async closeQuietly(client: AppServerClient): Promise<void> { await settleQuietly(client.close()); }
  private async boundedQuietly(work: Promise<void>): Promise<void> {
    await this.withTimeout(work, this.interruptGraceMs, "Terminal cleanup timed out").catch(() => undefined);
  }
  private async releaseRecord(record: ChildRecord): Promise<void> {
    if (record.leaseReleased) return;
    record.leaseReleased = true;
    await this.boundedQuietly(this.releaseQuietly(record.lease));
  }
  private async releaseQuietly(lease: RuntimeLease): Promise<void> { await settleQuietly(lease.release()); }
  private assertOpen(): void { if (this.closed) throw new CodexHostError("SUPERVISOR_UNAVAILABLE", "Codex supervisor is shut down"); }
  private async admit<T>(work: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.admitted += 1;
    try { return await work(); }
    finally {
      this.admitted -= 1;
      if (this.admitted === 0) this.admissionDrained?.();
    }
  }
  private async shutdownInternal(): Promise<void> {
    if (this.admitted > 0) await this.withTimeout(new Promise<void>((resolve) => { this.admissionDrained = resolve; }), this.profileRemovalTimeoutMs, "Admission shutdown timed out").catch(() => undefined);
    await this.withTimeout(Promise.allSettled([...this.openingBindings.values()]), this.profileRemovalTimeoutMs, "Opening binding shutdown timed out").catch(() => undefined);
    // Do not merely stop waiting for a start. A process may already have been
    // spawned and be stuck in connect/initialize; mark it abandoned first so
    // every late resource arrival is force-contained rather than admitted.
    const pendingStarts = [...this.startingRecords.values()];
    for (const starting of pendingStarts) starting.abandoned = true;
    // containStarting owns whole-operation bounds for close, process
    // escalation, and lease release. A shorter outer cleanup bound would let
    // shutdown return between those bounded stages.
    await Promise.all(pendingStarts.map((starting) => this.containStarting(starting)));
    await this.withTimeout(Promise.allSettled([...this.starting.values()]), this.profileRemovalTimeoutMs, "Child start shutdown timed out").catch(() => undefined);
    await Promise.all([...this.children.values()].map((child) => this.forceStop(child)));
  }
  private async fault(fault: CodexSupervisorFault): Promise<void> { try { await this.options.onFault(fault); } catch { /* fault projection must not tear down another profile */ } }
}

function profileKey(identity: Pick<ChildIdentity, "profile">): string { return [identity.profile.actorId, identity.profile.profileHandle].join("\u0000"); }
function sameProfile(left: ChildIdentity["profile"], right: ChildIdentity["profile"]): boolean { return left.actorId === right.actorId && left.profileHandle === right.profileHandle && left.profileGeneration === right.profileGeneration; }
function sameRequestedGeneration(child: ChildIdentity, request: AccountSupervisorRequest): boolean { return child.profile.profileGeneration === request.profile.profileGeneration && child.accountGeneration === request.accountGeneration && child.runtimeGeneration === request.runtimeGeneration; }
function sameRemovalRequest(left: ProfileRemovalRequest, right: ProfileRemovalRequest): boolean {
  return sameRequestedGeneration({ profile: left.profile, accountGeneration: left.accountGeneration, runtimeGeneration: left.runtimeGeneration, childGeneration: 0 }, right)
    && left.home.handle === right.home.handle && left.home.identityFingerprint === right.home.identityFingerprint;
}
function hasActiveBindingWork(bindings: readonly import("./contracts").PersistedBindingRecord[]): boolean {
  return bindings.some((binding) => binding.activeTurns > 0 || binding.pendingRequests > 0 || binding.outstandingRpcs > 0);
}
function sameReceipt(left: BindingRequest["workspace"], right: BindingRequest["workspace"]): boolean { return left.handle === right.handle && left.revision === right.revision && left.fingerprint === right.fingerprint && left.relayId === right.relayId && left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef && left.capabilityRevision === right.capabilityRevision && left.expiresAt === right.expiresAt; }
function pathsOverlap(left: string, right: string): boolean { return pathWithin(left, right) || pathWithin(right, left); }
function pathWithin(root: string, candidate: string): boolean { return root === sep ? candidate.startsWith(sep) : candidate === root || candidate.startsWith(`${root}${sep}`); }
async function settleQuietly(work: Promise<void>): Promise<void> { try { await work; } catch { /* terminal child state */ } }
class StopSuperseded extends Error {}
function validatedEnvironment(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entries = Object.entries(environment);
  if (entries.length > MAX_CHILD_ENV_ENTRIES) throw new Error("environment has too many entries");
  for (const [key, value] of entries) {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_CHILD_ENV_VALUE_BYTES) throw new Error("environment contains an invalid entry");
  }
  return Object.freeze(Object.fromEntries(entries));
}
