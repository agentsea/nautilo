import type { CodexCollaborationMode } from "@nautilo/codex-app-server";

/**
 * This package is a host-lifecycle boundary. It deliberately does not import
 * Nautilo's Tool sandbox, Seatbelt, or Developer Workstation grants: those do
 * not govern Codex-native work. The host only proves the paired workspace and
 * owns app-server child lifecycle.
 */

export type OpaqueHandle = string & { readonly __opaqueHandle: unique symbol };

export interface HostClock {
  now(): number;
}

export interface HostTimer {
  setTimeout(callback: () => void, delayMs: number): HostTimerHandle;
  clearTimeout(timer: HostTimerHandle): void;
}

export interface HostTimerHandle { readonly __hostTimerHandle: unique symbol; }

export interface WorkspaceIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface CurrentFolderSnapshot {
  readonly actorId: string;
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGenerationRef: string;
  readonly capabilityRevision: number;
  readonly revision: number;
  /** Host-local only. Never placed in WorkspaceReceipt. */
  readonly selectedPath: string;
}

export interface CurrentFolderSnapshotSource {
  read(): Promise<CurrentFolderSnapshot>;
}

export interface HostFileStat {
  readonly mode: number;
  readonly uid: number;
  readonly dev: number;
  readonly ino: number;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/** Minimal asynchronous filesystem port. Node/Electron adapters sit outside tests. */
export interface HostFilesystem {
  lstat(path: string): Promise<HostFileStat>;
  stat(path: string): Promise<HostFileStat>;
  realpath(path: string): Promise<string>;
  /** Returns true only when this call created the final target directory. */
  mkdir(path: string, options: { readonly recursive: boolean; readonly mode: number }): Promise<boolean>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, contents: string, options: { readonly mode: number; readonly flag: "wx" | "w" }): Promise<void>;
  readFile(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface WorkspaceReceipt {
  /** Opaque and host-minted. It carries no path or reversible path encoding. */
  readonly handle: OpaqueHandle;
  readonly actorId: string;
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGenerationRef: string;
  readonly capabilityRevision: number;
  readonly revision: number;
  /** Host-keyed stale-detection value, never a path encoding. */
  readonly fingerprint: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ResolvedWorkspace {
  readonly receipt: WorkspaceReceipt;
  /** Internal launch-only value. Do not serialize beyond the paired host. */
  readonly rootPath: string;
  /** Host-local identity of the selected alias before realpath resolution. */
  readonly selectedAliasIdentity: WorkspaceIdentity;
  readonly identity: WorkspaceIdentity;
}

export interface ProfileIdentity {
  readonly actorId: string;
  readonly profileHandle: OpaqueHandle;
  readonly profileGeneration: number;
}

export interface ProfileHome {
  readonly identity: ProfileIdentity;
  readonly handle: OpaqueHandle;
  readonly identityFingerprint: string;
}

/** A verified private Nautilo-owned cwd for account-only app-server work. */
export interface ServiceDirectory {
  /** Opaque host-local identity; never serialize the backing path. */
  readonly handle: OpaqueHandle;
  readonly identityFingerprint: string;
}

/**
 * Deliberately narrow destructive seam. Its implementation may remove only the
 * exact path already revalidated by CodexProfileHomeRegistry; it is never a
 * general filesystem API exposed to product code.
 */
export interface ProfileHomeRemovalFilesystem {
  /**
   * The adapter must lstat the exact path and marker again, compare every
   * expected field, then remove that directory without following symlinks.
   */
  removeOwnedProfileHome(input: ProfileHomeRemovalSpec): Promise<void>;
}

export interface ProfileHomeRemovalSpec {
  readonly path: string;
  readonly containmentRoot: string;
  readonly expectedDevice: number;
  readonly expectedInode: number;
  readonly expectedIdentity: ProfileIdentity;
  readonly expectedIdentityFingerprint: string;
  readonly markerName: ".nautilo-codex-profile.json";
  readonly expectedMarker: {
    readonly schemaVersion: 1;
    readonly actorId: string;
    readonly profileHandle: string;
    readonly profileGeneration: number;
    readonly homeIdentityFingerprint: string;
  };
  /** Async drain proof used while the adapter is still in its reversible phase. */
  readonly assertAuthorized: () => Promise<void>;
  /**
   * Synchronous exact-attempt assertion for the final destructive syscall edge.
   * No await may intervene between this check and issuing that syscall.
   */
  readonly assertAuthorizedNow: () => void;
  /**
   * Irreversibly disarms the attempt timeout. Adapters call it only after all
   * bounded/reversible work is complete and immediately before marker/root
   * removal; after this point the caller must not receive a timeout result.
   */
  readonly commitDestruction: () => void;
}

/** The removal coordinator proves this exact child generation has been drained. */
export interface ProfileHomeRemovalGate {
  /** Re-checkable asynchronous proof for the reversible phase. */
  assertDrained(child: ChildIdentity): Promise<void>;
  /** Synchronous proof at the final syscall edge; never performs I/O. */
  assertDrainedNow(child: ChildIdentity): void;
  /** Disarms the caller's timeout once destructive completion is committed. */
  commitDestruction(): void;
}

export interface ProfileHomeRemovalContext {
  readonly drainedChild: ChildIdentity;
  readonly serviceDirectoryPath: string;
  readonly runtimeCanonicalPaths: readonly string[];
}

/** Optional host-owned cancellation seam. No product path may imply it exists. */
export interface ProfileRemovalTurnCoordinator {
  cancelAndWait(input: {
    readonly child: ChildIdentity;
    readonly bindings: readonly PersistedBindingRecord[];
  }): Promise<void>;
}

export interface ProfileRemovalRequest extends AccountSupervisorRequest {
  readonly home: ProfileHome;
  /** Controller-proven exact live child when one is still attached. */
  readonly existingChild?: ChildIdentity | undefined;
}

export interface RuntimeIdentity {
  readonly runtimeGeneration: number;
  readonly accountGeneration: number;
}

export interface ChildIdentity extends RuntimeIdentity {
  readonly profile: ProfileIdentity;
  readonly childGeneration: number;
}

export interface RuntimeLease {
  release(): Promise<void>;
}

export interface RuntimeLaunchSpec {
  /** Private verified runtime entrypoint, supplied only by the runtime manager. */
  readonly executablePath: string;
  readonly args: readonly string[];
  /** Internal verified runtime companion search paths. Not a public product DTO. */
  readonly pathEntries?: readonly string[] | undefined;
  readonly runtimeGeneration: number;
}

export interface RuntimeProvider {
  acquire(generation: number): Promise<{ readonly launch: RuntimeLaunchSpec; readonly lease: RuntimeLease }>;
}

export interface SpawnSpec {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The adapter must start an isolated process group/session where supported. */
  readonly detached: boolean;
}

export interface ManagedChildProcess {
  readonly pid: number;
  readonly stdio: ChildStdio;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
  /** Repeatable probe; false means alive or unsupported/uncertain, never proven gone. */
  isProcessGroupGone(): Promise<boolean>;
  sendInterrupt(): Promise<void>;
  signalProcessGroup(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export interface ChildStdio {
  readonly stdin: { write(chunk: Uint8Array | string): Promise<void>; end(): Promise<void> };
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
}

export interface ProcessHost {
  spawn(spec: SpawnSpec): Promise<ManagedChildProcess>;
}

/** A deliberately tiny seam over the typed app-server client. */
export interface AppServerClient {
  initialize(): Promise<{ readonly codexHome: string }>;
  /** Fixed official ChatGPT flow. No API key or auth-token input is accepted. */
  startChatgptLogin(): Promise<AppServerChatgptLogin>;
  /** Accepts only the host-local upstream ID returned by startChatgptLogin. */
  cancelLogin(upstreamLoginId: string): Promise<{ readonly cancelled: boolean }>;
  readAccount(): Promise<AppServerAccountProjection>;
  readUsage(): Promise<AppServerUsageProjection>;
  /** Picker-visible models returned by this exact initialized app-server child. */
  listModels(): Promise<AppServerModelCatalog>;
  logout(): Promise<void>;
  startThread(input: AppServerStartThreadInput): Promise<{ readonly threadId: string; readonly cwd: string }>;
  resumeThread(input: AppServerResumeThreadInput): Promise<{ readonly cwd: string }>;
  startTurn(input: {
    readonly threadId: string;
    readonly text: string;
    readonly clientUserMessageId: string;
    /** Required so a prior Plan turn cannot silently change a later Work turn. */
    readonly collaborationMode: CodexCollaborationMode;
  }): Promise<{ readonly turnId: string }>;
  steerThread(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly text: string;
    readonly clientUserMessageId: string;
  }): Promise<void>;
  interruptThread(input: { readonly threadId: string; readonly turnId: string }): Promise<void>;
  close(): Promise<void>;
}

export interface AppServerModelCatalogEntry {
  readonly id: string;
  readonly model: string;
  readonly displayName: string;
  readonly description: string;
  readonly isDefault: boolean;
}

export interface AppServerModelCatalog {
  readonly models: readonly AppServerModelCatalogEntry[];
}

/**
 * Host-internal only. Electron validates and opens authUrl, then retains this
 * upstream ID behind an expiring opaque Nautilo login reference.
 */
export interface AppServerChatgptLogin {
  readonly upstreamLoginId: string;
  readonly authUrl: string;
}

/**
 * Bounded credential-free account status. The provider email is display-only
 * identity for the owning user's Connections UI; auth files and tokens stay
 * private to the isolated CODEX_HOME.
 */
export interface AppServerAccountProjection {
  readonly state: "signed_in" | "signed_out" | "unsupported";
  readonly requiresOpenaiAuth: boolean;
  readonly email?: string | null | undefined;
  readonly planType?: AppServerPlanType | undefined;
}

export type AppServerPlanType =
  | "free" | "go" | "plus" | "pro" | "prolite" | "team" | "business"
  | "enterprise" | "ent26" | "edu" | "unknown"
  | "self_serve_business_usage_based" | "enterprise_cbp_usage_based";

/** Bounded provider usage projection; no account identifiers or auth material. */
export interface AppServerUsageProjection {
  readonly lifetimeTokens?: string | undefined;
  readonly peakDailyTokens?: string | undefined;
  readonly longestRunningTurnSec?: string | undefined;
  readonly currentStreakDays?: string | undefined;
  readonly longestStreakDays?: string | undefined;
  readonly dailyUsage: readonly { readonly startDate: string; readonly tokens: string }[];
}

/** Codex-native permissions posture. This is not a Nautilo sandbox policy. */
export type CodexNativePosture =
  | { readonly kind: "codex_default" }
  | { readonly kind: "prompted_workspace" }
  | { readonly kind: "full_access_headless" };

export interface AppServerStartThreadInput {
  /** Host-local resolved working directory. Never trusted as filesystem authority. */
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly posture: CodexNativePosture;
}

export interface AppServerResumeThreadInput {
  readonly threadId: string;
  /** Immutable host-local working directory selected when the thread opened. */
  readonly cwd: string;
  readonly model?: string | undefined;
}

export interface AppServerClientFactory {
  connect(child: ManagedChildProcess, identity: ChildIdentity): Promise<AppServerClient>;
}

export interface BindingRequest {
  readonly bindingId: OpaqueHandle;
  readonly bindingGeneration: number;
  readonly workspace: WorkspaceReceipt;
  readonly taskId: string;
  readonly jobId: string;
  /** Canonical host-local cwd. It is context, not Nautilo filesystem authority. */
  readonly workingDirectory: string;
  /** Present for resume/rebind and must be identical to the persisted thread. */
  readonly threadId?: string;
  readonly model?: string | undefined;
  readonly posture: CodexNativePosture;
}

/** Relay resume carries authority already assigned by thread/start, not mutable launch options. */
export interface BindingResumeRequest {
  readonly bindingId: OpaqueHandle;
  readonly bindingGeneration: number;
  readonly workspace: WorkspaceReceipt;
  readonly taskId: string;
  readonly jobId: string;
  readonly threadId: string;
}

export interface BindingRebindRequest {
  readonly bindingId: OpaqueHandle;
  readonly bindingGeneration: number;
  readonly taskId: string;
  readonly jobId: string;
  readonly threadId: string;
  readonly successorWorkspace: WorkspaceReceipt;
  readonly nextBindingGeneration: number;
}

export interface BoundThread {
  readonly bindingId: OpaqueHandle;
  readonly bindingGeneration: number;
  readonly threadId: string;
  readonly child: ChildIdentity;
}

export interface PersistedBindingRecord extends BoundThread {
  /** Full receipt identity, never a workspace path. */
  readonly workspace: WorkspaceReceipt;
  readonly taskId: string;
  readonly jobId: string;
  /** Immutable cwd selected when this Codex thread was opened. */
  readonly workingDirectory?: string;
  readonly model?: string | undefined;
  readonly posture: CodexNativePosture;
  readonly activeTurns: number;
  readonly pendingRequests: number;
  readonly outstandingRpcs: number;
}

export interface BindingOpenReservation extends Omit<BindingRequest, "threadId"> {
  readonly child: ChildIdentity;
  readonly reservationId: string;
  readonly state: "opening";
}
export interface BindingRebindReservation extends BindingRebindRequest {
  readonly child: ChildIdentity;
  /** Immutable completed authority being replaced; never supplied by relay. */
  readonly current: PersistedBindingRecord;
  readonly reservationId: string;
  readonly state: "rebinding";
}

/** A host adapter supplies durable storage; in-memory is only a test/default seam. */
export interface CodexBindingStore {
  get(bindingId: OpaqueHandle): Promise<PersistedBindingRecord | undefined>;
  list(child: ChildIdentity): Promise<readonly PersistedBindingRecord[]>;
  beginOpen(reservation: BindingOpenReservation): Promise<"started" | "same_pending" | "conflict">;
  completeOpen(reservation: BindingOpenReservation, record: PersistedBindingRecord): Promise<boolean>;
  abortOpen(reservation: BindingOpenReservation): Promise<void>;
  beginRebind(reservation: BindingRebindReservation, expected: PersistedBindingRecord): Promise<"started" | "same_pending" | "conflict">;
  completeRebind(reservation: BindingRebindReservation, expected: PersistedBindingRecord, next: PersistedBindingRecord): Promise<boolean>;
  abortRebind(reservation: BindingRebindReservation): Promise<void>;
  update(record: PersistedBindingRecord): Promise<void>;
  remove(bindingId: OpaqueHandle): Promise<void>;
}

/** Account-only child admission: profile and verified runtime, no workspace authority. */
export interface AccountSupervisorRequest extends RuntimeIdentity {
  readonly profile: ProfileIdentity;
}

/** Thread admission adds an opaque paired-host routing receipt. */
export interface SupervisorRequest extends AccountSupervisorRequest {
  readonly workspace: WorkspaceReceipt;
}

export interface TurnTerminalWaiter {
  wait(input: { readonly child: ChildIdentity; readonly binding: BoundThread; readonly turnId: string; readonly timeoutMs: number }): Promise<boolean>;
}

export type CodexSupervisorFault =
  | { readonly kind: "process_group_uncertain"; readonly child: ChildIdentity }
  | { readonly kind: "child_crashed"; readonly child: ChildIdentity };

export class CodexHostError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_STALE"
      | "WORKSPACE_UNAVAILABLE"
      | "PROFILE_HOME_INVALID"
      | "PROFILE_HOME_UNAVAILABLE"
      | "SUPERVISOR_UNAVAILABLE"
      | "CHILD_GENERATION_STALE"
      | "BINDING_LIMIT_REACHED"
      | "BINDING_UNCERTAIN"
      | "CALLBACK_MANIFEST_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "CodexHostError";
  }
}
