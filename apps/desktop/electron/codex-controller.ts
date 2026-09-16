import type {
  CodexAccountCommand,
  CodexProfileCommand,
  CodexRuntimeCommand,
  CodexStableErrorCode,
  CodexSafeAccountPlan,
  HostScope,
  ProfileLaunchScope,
  ProfileScope,
  RelayCodexSession,
  CodexHostStatus,
} from "@nautilo/relay";
import type {
  ChildIdentity,
  CodexSupervisorFault,
  ProfileHome,
  ProfileIdentity,
} from "@nautilo/codex-app-server-host/internal";
import {
  type CodexRuntimeGenerationAuthority,
} from "./codex-runtime/facade.ts";
import type { CodexRuntimeInstallState } from "./codex-runtime/contracts.ts";
import { CODEX_REVIEWED_RUNTIME_ARTIFACT_REF } from "@nautilo/relay";

type AdminCommand = CodexRuntimeCommand | CodexProfileCommand | CodexAccountCommand;
type AdminResult =
  | { readonly kind: "runtime_status"; readonly state: "absent" | "installing" | "ready" | "incompatible" | "draining" | "failed"; readonly runtimeGeneration?: number; readonly installRef?: string }
  | { readonly kind: "profile_status"; readonly state: "created"; readonly profileHandle: string; readonly profileGeneration: number; readonly homeHandle: string }
  | { readonly kind: "profile_status"; readonly state: "removed"; readonly profileHandle: string; readonly profileGeneration: number }
  | { readonly kind: "login_started"; readonly loginRef: string; readonly state: "waiting_for_browser" }
  | { readonly kind: "account_status"; readonly state: "signed_in" | "signed_out" | "reauth_required"; readonly accountGeneration: number; readonly accountEmail?: string | null; readonly planType?: CodexSafeAccountPlan | null }
  | { readonly kind: "account_usage_status"; readonly value: ElectronCodexUsageProjection }
  | { readonly kind: "model_catalog_status"; readonly value: ElectronCodexModelCatalogProjection }
  | { readonly kind: "rejected"; readonly code: CodexStableErrorCode };
type AccountState = "signed_in" | "signed_out" | "reauth_required";

/** Local, credential-free account projection accepted from the one host supervisor. */
export interface ElectronCodexAccountProjection {
  readonly state: "signed_in" | "signed_out" | "unsupported";
  readonly requiresOpenaiAuth: boolean;
  readonly email?: string | null | undefined;
  readonly planType?: CodexSafeAccountPlan | undefined;
}

/** Local, bounded usage projection. This is deliberately not an app-server envelope. */
export interface ElectronCodexUsageProjection {
  readonly summary: {
    readonly lifetimeTokens: string | null;
    readonly peakDailyTokens: string | null;
    readonly longestRunningTurnSec: string | null;
    readonly currentStreakDays: string | null;
    readonly longestStreakDays: string | null;
  };
  readonly daily: readonly { readonly startDate: string; readonly tokens: string }[];
  readonly observedAt: string;
  readonly freshness: "live" | "cached" | "stale";
}

export interface ElectronCodexModelCatalogProjection {
  readonly models: readonly {
    readonly id: string;
    readonly model: string;
    readonly displayName: string;
    readonly description: string;
    readonly isDefault: boolean;
  }[];
}

/** Runtime paths and source-specific details remain behind this Electron-main port. */
export interface ElectronCodexRuntimePort {
  inspect(input?: { readonly signal?: AbortSignal }): Promise<{
    readonly state: "absent" | "ready" | "incompatible" | "failed";
    readonly fingerprint?: string;
    readonly handle?: string;
    readonly source?: "external" | "managed";
    readonly version?: string;
    readonly compatibility?: CodexHostStatus["compatibility"];
    readonly features?: CodexHostStatus["features"];
    readonly compatibilityDiagnostics?: NonNullable<CodexHostStatus["runtime"]>["compatibilityDiagnostics"];
  }>;
  install(input: {
    readonly artifactRef: string;
    readonly signal: AbortSignal;
    readonly onState?: (state: CodexRuntimeInstallState) => void;
  }): Promise<{
    readonly state: "ready" | "incompatible" | "failed";
    readonly fingerprint?: string;
    readonly handle?: string;
    readonly source?: "external" | "managed";
    readonly version?: string;
    readonly compatibility?: CodexHostStatus["compatibility"];
    readonly features?: CodexHostStatus["features"];
    readonly compatibilityDiagnostics?: NonNullable<CodexHostStatus["runtime"]>["compatibilityDiagnostics"];
  }>;
  /** Acquisition only admits verified candidates; product activation explicitly selects one exact ledger handle. */
  revalidateForActivation?(handle: string, fingerprint: string): Promise<boolean>;
  activate?(handle: string): Promise<{
    readonly state: "ready" | "incompatible" | "failed";
    readonly fingerprint?: string;
    readonly handle?: string;
    readonly source?: "external" | "managed";
    readonly version?: string;
    readonly compatibility?: CodexHostStatus["compatibility"];
    readonly features?: CodexHostStatus["features"];
    readonly compatibilityDiagnostics?: NonNullable<CodexHostStatus["runtime"]>["compatibilityDiagnostics"];
  }>;
  rollback?(): Promise<{
    readonly state: "ready" | "incompatible" | "failed";
    readonly fingerprint?: string;
    readonly handle?: string;
    readonly source?: "external" | "managed";
    readonly version?: string;
    readonly compatibility?: CodexHostStatus["compatibility"];
    readonly features?: CodexHostStatus["features"];
    readonly compatibilityDiagnostics?: NonNullable<CodexHostStatus["runtime"]>["compatibilityDiagnostics"];
  } | null>;
}

/** Account calls are delegated to the already-created host supervisor only. */
export interface ElectronCodexControllerServices {
  actorId(): string | null;
  createProfile(identity: ProfileIdentity): Promise<ProfileHome>;
  ensure(scope: ProfileLaunchScope): Promise<ChildIdentity>;
  removeProfile(input: { readonly scope: ProfileLaunchScope; readonly home: ProfileHome; readonly existingChild?: ChildIdentity }): Promise<void>;
  startChatgptLogin(child: ChildIdentity): Promise<{ readonly upstreamLoginId: string; readonly authUrl: string }>;
  cancelLogin(child: ChildIdentity, upstreamLoginId: string): Promise<void>;
  readAccount(child: ChildIdentity): Promise<ElectronCodexAccountProjection>;
  readUsage?(child: ChildIdentity): Promise<ElectronCodexUsageProjection>;
  listModels(child: ChildIdentity): Promise<ElectronCodexModelCatalogProjection>;
  logout(child: ChildIdentity): Promise<void>;
}

/** Injectable so expiry cleanup is deterministic in tests and Electron-owned in production. */
export interface ElectronCodexTimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ElectronCodexControllerOptions {
  readonly runtime: ElectronCodexRuntimePort;
  /** Host-reviewed authority; relay supplied refs are never accepted by default. */
  readonly artifactAuthority: { readonly artifactRef: string } | { readonly allows: (artifactRef: string) => boolean };
  readonly openExternal: (url: string) => Promise<void>;
  readonly now: () => number;
  readonly mintId: () => string;
  readonly loginTtlMs?: number;
  readonly timer?: ElectronCodexTimerPort;
  /** Best-effort, bounded status nudge for the currently attached host only. */
  readonly onStatusChange?: () => void;
}

export interface ElectronCodexAdminPort {
  enable(session: RelayCodexSession): Promise<void>;
  detach(): Promise<void>;
  close(): Promise<void>;
  ensureProfileChild(scope: ProfileLaunchScope): Promise<ChildIdentity>;
  execute(scope: HostScope | ProfileScope | ProfileLaunchScope, command: AdminCommand): Promise<AdminResult>;
}

interface RuntimeLedgerEntry {
  readonly handle: string;
  readonly fingerprint: string;
  readonly compatibility: NonNullable<CodexHostStatus["compatibility"]>;
  readonly features: NonNullable<CodexHostStatus["features"]>;
  readonly source: "external" | "managed";
  readonly version?: string;
  readonly compatibilityDiagnostics?: NonNullable<CodexHostStatus["runtime"]>["compatibilityDiagnostics"];
}
interface SelectedRuntime { readonly generation: number; readonly handle: string; }
interface InstallRecord {
  readonly abort: AbortController;
  readonly epoch: number;
  rawDone: Promise<void>;
  installation: CodexRuntimeInstallState | undefined;
}
interface ProfileRecord {
  readonly actorId: string;
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly home: ProfileHome;
  removing: boolean;
  removed: boolean;
  serviceEpoch: string | undefined;
  liveChild: ChildIdentity | undefined;
  accountGeneration: number | undefined;
  accountState: AccountState;
}
interface LoginRecord {
  readonly socket: RelayCodexSession;
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly child: ChildIdentity;
  readonly serviceEpoch: string;
  readonly upstreamLoginId: string;
  readonly expiresAt: number;
  timer: unknown;
}

/**
 * Electron-main controller for the v8 product admin surface. It owns only
 * opaque ledgers and admission state; runtime files, credentials, URLs and
 * app-server envelopes never leave its injected local ports.
 */
export class ElectronCodexController implements ElectronCodexAdminPort, CodexRuntimeGenerationAuthority {
  private readonly loginTtlMs: number;
  private readonly timer: ElectronCodexTimerPort;
  private tail = Promise.resolve();
  private adminEpoch = 0;
  private activeInspection: Readonly<{ abort: AbortController; epoch: number }> | undefined;
  private attached: Readonly<{ session: RelayCodexSession; epoch: string; services: ElectronCodexControllerServices }> | undefined;
  private closed = false;
  private runtimeGeneration = 0;
  private selectedRuntime: SelectedRuntime | undefined;
  private lastRuntimeState: "absent" | "ready" | "incompatible" | "failed" = "absent";
  private lastRuntimeSource: "external" | "managed" | undefined;
  private lastRuntimeVersion: string | undefined;
  private lastCompatibilityDiagnostics: NonNullable<CodexHostStatus["runtime"]>["compatibilityDiagnostics"] | undefined;
  private readonly runtimes = new Map<number, RuntimeLedgerEntry>();
  private readonly installs = new Map<string, InstallRecord>();
  /** One current terminal lifecycle receipt; never a progress/event history. */
  private lastInstallation: CodexRuntimeInstallState | undefined;
  private lastInstallationVersion: string | undefined;
  private readonly profiles = new Map<string, ProfileRecord>();
  private readonly logins = new Map<string, LoginRecord>();

  constructor(private readonly options: ElectronCodexControllerOptions) {
    this.loginTtlMs = options.loginTtlMs ?? 5 * 60 * 1000;
    this.timer = options.timer ?? systemTimer;
    if (!Number.isFinite(this.loginTtlMs) || this.loginTtlMs <= 0) throw new Error("loginTtlMs must be positive");
  }

  /** A service port is valid only for this authenticated relay attachment. */
  attach(session: RelayCodexSession, services: ElectronCodexControllerServices): Promise<void> {
    return this.serial(() => {
      if (this.closed) throw new Error("codex_controller_closed");
      if (this.attached) throw new ControllerError("CODEX_CONTEXT_STALE");
      this.attached = Object.freeze({ session, epoch: this.options.mintId(), services });
      return Promise.resolve();
    });
  }

  enable(session: RelayCodexSession): Promise<void> {
    return this.serial(() => {
      if (this.closed || !this.attached || !sameSocket(this.attached.session, session)) throw new ControllerError("CODEX_CONTEXT_STALE");
      return Promise.resolve();
    });
  }

  detach(): Promise<void> {
    // Fence before joining the serial tail. An inspection may be holding that
    // tail while probing a native runtime; it must see cancellation instead of
    // making relay detach wait behind an obsolete probe.
    const { attached, logins } = this.fenceAdminWork();
    // Cancellation is best-effort upstream cleanup. It cannot be allowed to
    // turn a detached local lifecycle transition into an unbounded wait.
    if (attached) for (const login of logins)
      void attached.services.cancelLogin(login.child, login.upstreamLoginId).catch(() => undefined);
    return this.serial(() => Promise.resolve());
  }

  close(): Promise<void> {
    this.closed = true;
    const { attached, logins } = this.fenceAdminWork();
    for (const install of this.installs.values()) install.abort.abort();
    this.installs.clear();
    this.notifyStatusChange();
    this.profiles.clear();
    if (attached) for (const login of logins)
      void attached.services.cancelLogin(login.child, login.upstreamLoginId).catch(() => undefined);
    return this.serial(() => Promise.resolve());
  }

  execute(scope: HostScope | ProfileScope | ProfileLaunchScope, command: AdminCommand): Promise<AdminResult> {
    const commandEpoch = this.adminEpoch;
    return this.serial(async () => {
      // Commands captured before detach/close must not revive against a later
      // attachment, even when the relay reconnects with identical scope data.
      if (commandEpoch !== this.adminEpoch) return rejected("CODEX_CAPABILITY_UNAVAILABLE");
      try {
        this.assertEnabled(scope);
        switch (command.kind) {
          case "runtime_inspect": return await this.inspectRuntime(commandEpoch);
          case "runtime_install": return this.startInstall(command.artifactRef);
          case "runtime_cancel_install": return await this.cancelInstall(command.installRef, commandEpoch);
          case "runtime_activate": return await this.activateRuntime(command.runtimeGeneration, commandEpoch);
          case "runtime_rollback": return await this.rollbackRuntime(commandEpoch);
          case "runtime_remove": return rejected("CODEX_CAPABILITY_UNAVAILABLE");
          case "profile_create": return this.createProfile(command.profileHandle, command.profileGeneration);
          case "profile_remove": return await this.removeProfile(scope as ProfileLaunchScope, command.profileHandle, command.profileGeneration);
          case "account_login_start": return await this.startLogin(scope as ProfileScope);
          case "account_login_cancel": return await this.cancelAccountLogin(scope as ProfileScope, command.loginRef);
          case "account_read": return await this.accountStatus(scope as ProfileScope);
          case "account_logout": return await this.logout(scope as ProfileScope);
          case "account_rate_limits_read": return rejected("CODEX_CAPABILITY_UNAVAILABLE");
          case "account_usage_read": return await this.usage(scope as ProfileScope);
          case "model_list": return {
            kind: "model_catalog_status",
            value: await this.models(scope as ProfileScope),
          };
          default: return rejected("CODEX_CAPABILITY_UNAVAILABLE");
        }
      } catch (error) {
        return rejected(errorCode(error));
      }
    });
  }

  private async models(scope: ProfileScope): Promise<ElectronCodexModelCatalogProjection> {
    const attached = this.requireAttached();
    const profile = this.requireProfile(scope);
    const child = profile.liveChild;
    if (!child || !sameChildScope(child, scope)) {
      throw new ControllerError("CODEX_GENERATION_STALE");
    }
    return attached.services.listModels(child);
  }

  /** Host calls this for `ensure_profile_child`; it has no workspace dependency. */
  ensureProfileChild(scope: ProfileLaunchScope): Promise<ChildIdentity> {
    const commandEpoch = this.adminEpoch;
    return this.serial(async () => {
      this.assertAdminEpoch(commandEpoch);
      this.assertEnabled(scope);
      const attached = this.requireAttached();
      const profile = this.requireProfile(scope);
      const child = await attached.services.ensure(scope);
      this.assertAdminEpoch(commandEpoch);
      if (child.profile.actorId !== profile.actorId || !sameChildScope(child, scope)) throw new ControllerError("CODEX_GENERATION_STALE");
      if (!profile.liveChild || !sameChild(profile.liveChild, child)) profile.serviceEpoch = attached.epoch;
      profile.liveChild = child;
      profile.accountGeneration = child.accountGeneration;
      return child;
    });
  }

  /**
   * Projects an exact supervisor fault into the product ledger. A stale fault
   * can never clear a successor (or a sibling profile), and account state is
   * retained so the next explicit ensure may rehydrate the same profile.
   */
  onSupervisorFault(fault: CodexSupervisorFault): Promise<boolean> {
    return this.serial(() => {
      const child = fault.child;
      const profile = this.profiles.get(profileKey(child.profile.actorId, child.profile.profileHandle));
      if (!profile?.liveChild || !sameChild(profile.liveChild, child)) return Promise.resolve(false);
      profile.liveChild = undefined;
      profile.serviceEpoch = undefined;
      this.claimProfileLogins(profile);
      return Promise.resolve(true);
    });
  }

  /** Supervisor-only lookup: only the product-selected generation has a handle. */
  resolveRuntimeHandleForGeneration(generation: number): string | null {
    if (this.closed || !this.attached || this.selectedRuntime?.generation !== generation) return null;
    return this.selectedRuntime.handle;
  }

  /** Backward-compatible product authority name used by existing composition. */
  selectedRuntimeHandleForGeneration(generation: number): string | null {
    return this.resolveRuntimeHandleForGeneration(generation);
  }

  /** Immutable, relay-safe projection of this controller's exact ledgers. */
  status(): Omit<CodexHostStatus, "workspace"> {
    const selected = this.selectedRuntime && this.runtimes.get(this.selectedRuntime.generation);
    const install = this.installs.entries().next().value;
    const profiles = [...this.profiles.values()]
      .filter((profile) => !profile.removed && profile.accountGeneration !== undefined)
      .sort((left, right) => left.profileHandle.localeCompare(right.profileHandle))
      .map((profile) => Object.freeze({
        profileHandle: profile.profileHandle,
        profileGeneration: profile.profileGeneration,
        accountGeneration: profile.accountGeneration!,
        state: profile.removing ? "draining" as const : this.hasLiveLogin(profile) ? "busy" as const : profile.accountState,
        ...(profile.liveChild ? { childGeneration: profile.liveChild.childGeneration } : {}),
      }));
    const activeInstall = install && { ref: install[0], record: install[1] };
    if (activeInstall) return Object.freeze({
      state: "runtime_unavailable" as const,
      runtime: {
        state: "installing" as const,
        source: "managed" as const,
        installRef: activeInstall.ref,
        // The manager emits terminal states just before its promise settles.
        // Never publish one beneath an active `installing` runtime arm.
        ...(
          activeInstall.record.installation && !isTerminalInstallation(activeInstall.record.installation)
            ? { installation: activeInstall.record.installation }
            : {}
        ),
      },
      ...(profiles.length ? { profiles: Object.freeze(profiles) } : {}),
    });
    if (this.lastInstallation && !selected) return Object.freeze({
      state: "runtime_unavailable" as const,
      runtime: {
        state: this.lastInstallation.phase === "failed"
          ? "failed" as const
          : this.lastInstallation.phase === "cancelled"
            ? "absent" as const
            : "ready" as const,
        source: "managed" as const,
        ...(this.lastInstallationVersion ? { version: this.lastInstallationVersion } : {}),
        installation: this.lastInstallation,
      },
      ...(profiles.length ? { profiles: Object.freeze(profiles) } : {}),
    });
    if (selected) return Object.freeze({
      state: selected.compatibility === "limited" ? "limited" as const : "ready" as const,
      compatibility: selected.compatibility,
      features: Object.freeze({ ...selected.features }),
      runtimeGeneration: this.selectedRuntime!.generation,
      runtime: {
        state: "ready" as const,
        source: selected.source,
        ...(selected.version ? { version: selected.version } : {}),
        ...(selected.compatibilityDiagnostics
          ? { compatibilityDiagnostics: selected.compatibilityDiagnostics }
          : {}),
      },
      ...(profiles.length ? { profiles: Object.freeze(profiles) } : {}),
    });
    const runtime = {
      state: this.lastRuntimeState,
      ...(this.lastRuntimeSource ? { source: this.lastRuntimeSource } : {}),
      ...(this.lastRuntimeVersion ? { version: this.lastRuntimeVersion } : {}),
      ...(this.lastCompatibilityDiagnostics
        ? { compatibilityDiagnostics: this.lastCompatibilityDiagnostics }
        : {}),
    };
    return Object.freeze({
      state: this.lastRuntimeState === "incompatible" ? "runtime_incompatible" as const : "runtime_unavailable" as const,
      runtime,
      ...(profiles.length ? { profiles: Object.freeze(profiles) } : {}),
    });
  }

  private async inspectRuntime(commandEpoch: number): Promise<AdminResult> {
    this.assertAdminEpoch(commandEpoch);
    const inspection = Object.freeze({ abort: new AbortController(), epoch: commandEpoch });
    this.activeInspection = inspection;
    try {
      const inspected = await this.options.runtime.inspect({ signal: inspection.abort.signal });
      this.assertActiveInspection(inspection);
      this.lastRuntimeState = inspected.state;
      this.lastRuntimeSource = inspected.source;
      this.lastRuntimeVersion = inspected.version;
      this.lastCompatibilityDiagnostics = inspected.compatibilityDiagnostics;
      const generation = inspected.state === "ready" && inspected.fingerprint && inspected.handle && inspected.compatibility && inspected.features && inspected.source
        ? this.recordRuntime(inspected.fingerprint, inspected.handle, inspected.compatibility, inspected.features, inspected.source, inspected.version, inspected.compatibilityDiagnostics)
        : undefined;
      // Enabling the Codex connection is the durable user intent. A fresh
      // Electron controller must therefore restore a successfully inspected,
      // compatibility-approved runtime without asking the user to repeat a
      // second "Use this Codex" ceremony after every restart. Reuse the exact
      // activation path so the newly observed handle/fingerprint is
      // revalidated (and, where supported, activated) before selection.
      // Failed revalidation remains a detected candidate only.
      if (generation !== undefined) {
        await this.activateRuntime(generation, commandEpoch);
      }
      this.notifyStatusChange();
      return this.runtimeStatus(inspected.state === "ready" ? "ready" : inspected.state, generation);
    } catch (error) {
      if (inspection.abort.signal.aborted || inspection.epoch !== this.adminEpoch || this.closed || !this.attached)
        throw new ControllerError("CODEX_CAPABILITY_UNAVAILABLE");
      throw error;
    } finally {
      if (this.activeInspection === inspection) this.activeInspection = undefined;
    }
  }

  private startInstall(artifactRef: string): AdminResult {
    if (artifactRef !== CODEX_REVIEWED_RUNTIME_ARTIFACT_REF || !isApprovedArtifact(this.options.artifactAuthority, artifactRef))
      return rejected("CODEX_CAPABILITY_UNAVAILABLE");
    const current = this.installs.entries().next().value;
    if (current) return { kind: "runtime_status", state: "installing", installRef: current[0] };
    const installRef = this.mintInstallRef();
    if (!installRef) return rejected("CODEX_CONTEXT_INVALID");
    const abort = new AbortController();
    // Register before invoking the async manager: it may synchronously emit
    // `resolving` before its first await.
    const record: InstallRecord = {
      abort,
      epoch: this.adminEpoch,
      rawDone: Promise.resolve(),
      installation: undefined,
    };
    this.installs.set(installRef, record);
    this.lastInstallation = undefined;
    this.lastInstallationVersion = undefined;
    record.rawDone = this.options.runtime.install({
      artifactRef,
      signal: abort.signal,
      onState: (installation) => {
        if (
          this.closed ||
          abort.signal.aborted ||
          record.epoch !== this.adminEpoch ||
          this.installs.get(installRef) !== record
        ) return;
        record.installation = installation;
        // Terminal states are retained now and published by settlement after
        // the active InstallRecord has been removed.
        if (!isTerminalInstallation(installation)) this.notifyStatusChange();
      },
    }).then(
      (installed) => {
        void this.serial(() => {
          if (
            this.closed ||
            abort.signal.aborted ||
            record.epoch !== this.adminEpoch ||
            this.installs.get(installRef) !== record
          ) return Promise.resolve();
          this.lastRuntimeState = installed.state;
          this.lastRuntimeSource = installed.source;
          this.lastRuntimeVersion = installed.version;
          this.lastCompatibilityDiagnostics = installed.compatibilityDiagnostics;
          if (isTerminalInstallation(record.installation)) this.lastInstallation = record.installation;
          this.lastInstallationVersion = installed.version;
          if (
            installed.state === "ready" &&
            installed.fingerprint &&
            installed.handle &&
            installed.compatibility &&
            installed.features &&
            installed.source
          ) {
            this.recordRuntime(
              installed.fingerprint,
              installed.handle,
              installed.compatibility,
              installed.features,
              installed.source,
              installed.version,
              installed.compatibilityDiagnostics,
            );
          }
          if (this.installs.get(installRef) === record) this.installs.delete(installRef);
          this.notifyStatusChange();
          return Promise.resolve();
        });
      },
      () => {
        void this.serial(() => {
          if (!this.closed && record.epoch === this.adminEpoch && this.installs.get(installRef) === record) {
            this.lastRuntimeState = "failed";
            this.lastRuntimeSource = "managed";
            this.lastRuntimeVersion = undefined;
            this.lastCompatibilityDiagnostics = undefined;
            if (isTerminalInstallation(record.installation)) this.lastInstallation = record.installation;
            this.installs.delete(installRef);
            this.notifyStatusChange();
          }
          return Promise.resolve();
        });
      },
    );
    return { kind: "runtime_status", state: "installing", installRef };
  }

  private async cancelInstall(installRef: string, commandEpoch: number): Promise<AdminResult> {
    const install = this.installs.get(installRef);
    if (!install) return rejected("CODEX_CORRELATION_REPLAY");
    this.installs.delete(installRef);
    const prior = install.installation;
    this.lastInstallation = Object.freeze({
      phase: "cancelled",
      receivedBytes: prior?.receivedBytes ?? 0,
      totalBytes: prior?.totalBytes ?? 0,
      canCancel: false,
      code: "CODEX_RUNTIME_CANCELLED",
    });
    this.lastInstallationVersion = undefined;
    this.lastRuntimeState = "absent";
    this.lastRuntimeSource = undefined;
    this.lastRuntimeVersion = undefined;
    this.notifyStatusChange();
    install.abort.abort();
    await install.rawDone;
    this.assertAdminEpoch(commandEpoch);
    return this.selectedRuntime
      ? this.runtimeStatus("ready", this.selectedRuntime.generation)
      : { kind: "runtime_status", state: "absent" };
  }

  private async activateRuntime(generation: number, commandEpoch: number): Promise<AdminResult> {
    const entry = this.runtimes.get(generation);
    if (!entry) return rejected("CODEX_RUNTIME_UNAVAILABLE");
    if (!this.options.runtime.revalidateForActivation || !(await this.options.runtime.revalidateForActivation(entry.handle, entry.fingerprint))) {
      return rejected("CODEX_RUNTIME_UNAVAILABLE");
    }
    this.assertAdminEpoch(commandEpoch);
    if (this.options.runtime.activate) {
      const activated = await this.options.runtime.activate(entry.handle);
      if (activated.state !== "ready" || activated.handle !== entry.handle || activated.fingerprint !== entry.fingerprint || activated.compatibility !== entry.compatibility || !sameFeatures(activated.features, entry.features)) return rejected("CODEX_RUNTIME_UNAVAILABLE");
    }
    this.assertAdminEpoch(commandEpoch);
    this.selectedRuntime = { generation, handle: entry.handle };
    this.lastRuntimeState = "ready";
    this.notifyStatusChange();
    return this.runtimeStatus("ready", generation);
  }

  private async rollbackRuntime(commandEpoch: number): Promise<AdminResult> {
    if (!this.options.runtime.rollback) return rejected("CODEX_CAPABILITY_UNAVAILABLE");
    let rolledBack: Awaited<ReturnType<NonNullable<ElectronCodexRuntimePort["rollback"]>>>;
    try { rolledBack = await this.options.runtime.rollback(); }
    catch { return rejected("CODEX_RUNTIME_UNAVAILABLE"); }
    this.assertAdminEpoch(commandEpoch);
    if (!rolledBack || rolledBack.state !== "ready" || !rolledBack.fingerprint || !rolledBack.handle || !rolledBack.compatibility || !rolledBack.features)
      return rejected("CODEX_RUNTIME_UNAVAILABLE");
    // A rollback is a durable active-record change even when bytes match an
    // earlier runtime. Do not make it alias an old product generation.
    if (!rolledBack.source) return rejected("CODEX_RUNTIME_UNAVAILABLE");
    const generation = this.recordRuntime(rolledBack.fingerprint, rolledBack.handle, rolledBack.compatibility, rolledBack.features, rolledBack.source, rolledBack.version, rolledBack.compatibilityDiagnostics, true);
    this.selectedRuntime = { generation, handle: rolledBack.handle };
    this.notifyStatusChange();
    return this.runtimeStatus("ready", generation);
  }

  private recordRuntime(
    fingerprint: string,
    handle: string,
    compatibility: NonNullable<CodexHostStatus["compatibility"]>,
    features: NonNullable<CodexHostStatus["features"]>,
    source: "external" | "managed",
    version: string | undefined,
    compatibilityDiagnostics?: NonNullable<CodexHostStatus["runtime"]>["compatibilityDiagnostics"],
    freshGeneration = false,
  ): number {
    if (!freshGeneration) for (const [generation, value] of this.runtimes) {
      if (value.fingerprint === fingerprint) {
        // A revalidation may mint a replacement opaque handle for unchanged
        // bytes. Keep the product generation, but ledger it until activation
        // explicitly selects that exact fresh handle.
        this.runtimes.set(generation, { fingerprint, handle, compatibility, features: Object.freeze({ ...features }), source, ...(version ? { version } : {}), ...(compatibilityDiagnostics ? { compatibilityDiagnostics } : {}) });
        return generation;
      }
    }
    const generation = ++this.runtimeGeneration;
    this.runtimes.set(generation, { fingerprint, handle, compatibility, features: Object.freeze({ ...features }), source, ...(version ? { version } : {}), ...(compatibilityDiagnostics ? { compatibilityDiagnostics } : {}) });
    return generation;
  }

  private runtimeStatus(state: "absent" | "ready" | "incompatible" | "failed", generation?: number): AdminResult {
    const activeGeneration = generation ?? this.runtimeGeneration;
    if (state === "ready" && activeGeneration > 0) return { kind: "runtime_status", state, runtimeGeneration: activeGeneration };
    return { kind: "runtime_status", state };
  }

  private async createProfile(profileHandle: string, profileGeneration: number): Promise<AdminResult> {
    const attached = this.requireAttached();
    const actorId = attached.services.actorId();
    if (!actorId) throw new ControllerError("CODEX_PROFILE_UNAVAILABLE");
    const key = profileKey(actorId, profileHandle);
    const existing = this.profiles.get(key);
    if (existing && existing.profileGeneration !== profileGeneration) return rejected("CODEX_CAPABILITY_UNAVAILABLE");
    if (existing) {
      if (existing.removed || existing.removing) return rejected("CODEX_PROFILE_UNAVAILABLE");
      return { kind: "profile_status", state: "created", profileHandle, profileGeneration, homeHandle: existing.home.handle };
    }
    const home = await attached.services.createProfile({ actorId, profileHandle: profileHandle as ProfileIdentity["profileHandle"], profileGeneration });
    if (home.identity.actorId !== actorId || home.identity.profileHandle !== profileHandle || home.identity.profileGeneration !== profileGeneration || !home.handle) {
      throw new ControllerError("CODEX_PROFILE_UNAVAILABLE");
    }
    const profile = {
      actorId, profileHandle, profileGeneration, home, removing: false, removed: false, serviceEpoch: undefined, liveChild: undefined,
      // v8 profile_create has no account generation. Zero is the only
      // truthful initial generation and makes first-child/login admission
      // reachable; ensure/account responses may advance it later.
      accountGeneration: 0, accountState: "signed_out" as AccountState,
    };
    this.profiles.set(key, profile);
    return { kind: "profile_status", state: "created", profileHandle, profileGeneration, homeHandle: profile.home.handle };
  }

  private async removeProfile(scope: ProfileLaunchScope, profileHandle: string, profileGeneration: number): Promise<AdminResult> {
    const attached = this.requireAttached();
    const actorId = attached.services.actorId();
    if (!actorId || scope.profileHandle !== profileHandle || scope.profileGeneration !== profileGeneration) throw new ControllerError("CODEX_PROFILE_UNAVAILABLE");
    const profile = this.profiles.get(profileKey(actorId, profileHandle));
    if (!profile || profile.profileGeneration !== profileGeneration || profile.home.identity.actorId !== actorId || profile.home.identity.profileHandle !== profileHandle || profile.home.identity.profileGeneration !== profileGeneration) throw new ControllerError("CODEX_PROFILE_UNAVAILABLE");
    if (profile.removed) return { kind: "profile_status", state: "removed", profileHandle, profileGeneration };
    // This assignment is intentionally before the first await: every normal
    // profile operation queued after this command is rejected, including login.
    profile.removing = true;
    const liveChild = profile.liveChild && sameChildScope(profile.liveChild, scope) ? profile.liveChild : undefined;
    this.purgeProfileLogins(profile);
    await attached.services.removeProfile({ scope, home: profile.home, ...(liveChild ? { existingChild: liveChild } : {}) });
    profile.liveChild = undefined;
    profile.serviceEpoch = undefined;
    profile.removing = false;
    profile.removed = true;
    return { kind: "profile_status", state: "removed", profileHandle, profileGeneration };
  }

  private async startLogin(scope: ProfileScope): Promise<AdminResult> {
    const { profile, child } = this.exactChild(scope);
    const serviceEpoch = profile.serviceEpoch;
    if (!serviceEpoch) throw new ControllerError("CODEX_GENERATION_STALE");
    const services = this.requireAttached().services;
    const login = await services.startChatgptLogin(child);
    if (!isOfficialLoginUrl(login.authUrl)) {
      await services.cancelLogin(child, login.upstreamLoginId).catch(() => undefined);
      throw new ControllerError("CODEX_CONTEXT_INVALID");
    }
    try {
      await this.options.openExternal(login.authUrl);
    } catch {
      await services.cancelLogin(child, login.upstreamLoginId).catch(() => undefined);
      throw new ControllerError("CODEX_CONTEXT_INVALID");
    }
    const loginRef = this.mintLoginRef();
    if (!loginRef) {
      await services.cancelLogin(child, login.upstreamLoginId).catch(() => undefined);
      throw new ControllerError("CODEX_CONTEXT_INVALID");
    }
    const record: LoginRecord = {
      socket: this.requireAttached().session, profileHandle: profile.profileHandle, profileGeneration: profile.profileGeneration,
      child, serviceEpoch, upstreamLoginId: login.upstreamLoginId,
      expiresAt: this.options.now() + this.loginTtlMs,
      timer: undefined,
    };
    this.logins.set(loginRef, record);
    record.timer = this.timer.setTimeout(() => {
      void this.serial(() => this.expireLogin(loginRef, record));
    }, this.loginTtlMs);
    return { kind: "login_started", loginRef, state: "waiting_for_browser" };
  }

  private async cancelAccountLogin(scope: ProfileScope, loginRef: string): Promise<AdminResult> {
    const login = this.claimLogin(loginRef); // claim before awaiting: a login ref is single-use.
    if (!login) return rejected("CODEX_CORRELATION_REPLAY");
    const profile = this.requireProfile(scope);
    if (login.expiresAt <= this.options.now()) {
      await this.requireAttached().services.cancelLogin(login.child, login.upstreamLoginId).catch(() => undefined);
      return rejected("CODEX_TIMEOUT");
    }
    if (!sameSocket(login.socket, scope) || login.profileHandle !== scope.profileHandle || login.profileGeneration !== scope.profileGeneration || login.serviceEpoch !== profile.serviceEpoch || !profile.liveChild || !sameChild(login.child, profile.liveChild) || !sameChildScope(login.child, scope)) {
      await this.requireAttached().services.cancelLogin(login.child, login.upstreamLoginId).catch(() => undefined);
      return rejected("CODEX_CONTEXT_STALE");
    }
    await this.requireAttached().services.cancelLogin(login.child, login.upstreamLoginId).catch(() => undefined);
    return this.accountStatus(scope);
  }

  private async accountStatus(scope: ProfileScope): Promise<AdminResult> {
    const { profile, child } = this.exactChild(scope);
    const result = accountResult(await this.requireAttached().services.readAccount(child), scope.accountGeneration);
    profile.accountGeneration = result.accountGeneration;
    profile.accountState = result.state;
    // A successful browser login is completed out-of-band. Once the
    // authoritative account read observes signed_in, its opaque login receipt
    // is spent: retaining it would keep the relay projection "busy" until TTL
    // and make the newly signed-in profile ineligible for user selection.
    if (result.state === "signed_in") this.claimProfileLogins(profile);
    return result;
  }

  private async logout(scope: ProfileScope): Promise<AdminResult> {
    const { profile, child } = this.exactChild(scope);
    this.purgeProfileLogins(profile);
    await this.requireAttached().services.logout(child);
    return this.accountStatus(scope);
  }

  private async usage(scope: ProfileScope): Promise<AdminResult> {
    const { child } = this.exactChild(scope);
    const attached = this.requireAttached();
    if (!attached.services.readUsage) return rejected("CODEX_CAPABILITY_UNAVAILABLE");
    return { kind: "account_usage_status", value: normalizeUsage(await attached.services.readUsage(child)) };
  }

  private exactChild(scope: ProfileScope): { readonly profile: ProfileRecord; readonly child: ChildIdentity } {
    const profile = this.requireProfile(scope);
    const child = profile.liveChild;
    if (!child || !sameChildScope(child, scope)) throw new ControllerError("CODEX_GENERATION_STALE");
    return { profile, child };
  }

  private requireProfile(scope: ProfileLaunchScope): ProfileRecord {
    const actorId = this.requireAttached().services.actorId();
    if (!actorId) throw new ControllerError("CODEX_PROFILE_UNAVAILABLE");
    const profile = this.profiles.get(profileKey(actorId, scope.profileHandle));
    if (!profile || profile.removing || profile.removed || profile.profileGeneration !== scope.profileGeneration) throw new ControllerError("CODEX_PROFILE_UNAVAILABLE");
    return profile;
  }

  private purgeProfileLogins(profile: ProfileRecord): void {
    const services = this.requireAttached().services;
    for (const login of this.claimProfileLogins(profile)) {
      // Claim synchronously so no ref can leak or replay; cancellation is
      // detached because an unresponsive upstream must not wedge removal.
      void services.cancelLogin(login.child, login.upstreamLoginId).catch(() => undefined);
    }
  }

  private claimProfileLogins(profile: ProfileRecord): readonly LoginRecord[] {
    return [...this.logins.entries()].flatMap(([ref, value]) => {
      if (
        value.profileHandle !== profile.profileHandle ||
        value.profileGeneration !== profile.profileGeneration
      ) {
        return [];
      }
      const login = this.claimLogin(ref);
      return login ? [login] : [];
    });
  }

  private assertEnabled(scope: HostScope): void {
    if (this.closed || !this.attached) throw new ControllerError("CODEX_CAPABILITY_UNAVAILABLE");
    if (!sameSocket(this.attached.session, scope)) throw new ControllerError("CODEX_CONTEXT_STALE");
  }

  private assertAdminEpoch(epoch: number): void {
    if (epoch !== this.adminEpoch || this.closed || !this.attached) throw new ControllerError("CODEX_CAPABILITY_UNAVAILABLE");
  }

  private assertActiveInspection(inspection: Readonly<{ abort: AbortController; epoch: number }>): void {
    if (this.activeInspection !== inspection || inspection.abort.signal.aborted) throw new ControllerError("CODEX_CAPABILITY_UNAVAILABLE");
    this.assertAdminEpoch(inspection.epoch);
  }

  /** Immediately invalidates old relay work; cleanup may safely join afterward. */
  private fenceAdminWork(): Readonly<{ attached: ElectronCodexController["attached"]; logins: readonly LoginRecord[] }> {
    const attached = this.attached;
    this.attached = undefined;
    this.adminEpoch += 1;
    this.activeInspection?.abort.abort();
    for (const install of this.installs.values()) install.abort.abort();
    this.installs.clear();
    this.lastInstallation = undefined;
    this.lastInstallationVersion = undefined;
    for (const profile of this.profiles.values()) {
      profile.liveChild = undefined;
      profile.serviceEpoch = undefined;
    }
    this.notifyStatusChange();
    return { attached, logins: this.claimAllLogins() };
  }

  private notifyStatusChange(): void {
    try { this.options.onStatusChange?.(); } catch { /* Host publication is best effort. */ }
  }

  private requireAttached(): NonNullable<ElectronCodexController["attached"]> {
    if (this.closed || !this.attached) throw new ControllerError("CODEX_CAPABILITY_UNAVAILABLE");
    return this.attached;
  }

  private mintInstallRef(): string | undefined {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const ref = this.options.mintId();
      if (ref && !this.installs.has(ref)) return ref;
    }
    return undefined;
  }

  private mintLoginRef(): string | undefined {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const ref = this.options.mintId();
      if (ref && !this.logins.has(ref)) return ref;
    }
    return undefined;
  }

  private claimLogin(ref: string): LoginRecord | undefined {
    const login = this.logins.get(ref);
    if (!login) return undefined;
    this.logins.delete(ref);
    if (login.timer !== undefined) this.timer.clearTimeout(login.timer);
    login.timer = undefined;
    return login;
  }

  private claimAllLogins(): readonly LoginRecord[] {
    return [...this.logins.keys()].flatMap((ref) => {
      const login = this.claimLogin(ref);
      return login ? [login] : [];
    });
  }

  private hasLiveLogin(profile: ProfileRecord): boolean {
    return [...this.logins.values()].some((login) => login.profileHandle === profile.profileHandle && login.profileGeneration === profile.profileGeneration);
  }

  private async expireLogin(ref: string, expected: LoginRecord): Promise<void> {
    if (this.logins.get(ref) !== expected) return;
    const login = this.claimLogin(ref);
    const attached = this.attached;
    if (!login || !attached || login.serviceEpoch !== attached.epoch || !sameSocket(login.socket, attached.session)) return;
    await attached.services.cancelLogin(login.child, login.upstreamLoginId).catch(() => undefined);
    // Expiry changes the public profile projection from busy back to its
    // authoritative account state. Publish that transition even though the
    // upstream cancellation itself is best-effort.
    this.notifyStatusChange();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function isOfficialLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "auth.openai.com" || url.hostname === "chatgpt.com") &&
      (url.origin === "https://auth.openai.com" || url.origin === "https://chatgpt.com");
  } catch { return false; }
}

export class ElectronCodexControllerError extends Error {
  constructor(readonly code: CodexStableErrorCode) {
    super(code);
    this.name = "ElectronCodexControllerError";
  }
}
const ControllerError = ElectronCodexControllerError;
function rejected(code: CodexStableErrorCode): AdminResult { return { kind: "rejected", code }; }
function errorCode(error: unknown): CodexStableErrorCode { return error instanceof ControllerError ? error.code : "CODEX_CONTEXT_INVALID"; }
function profileKey(actorId: string, handle: string): string { return `${actorId}\u0000${handle}`; }
function sameSocket(left: RelayCodexSession, right: HostScope): boolean {
  return left.relayId === right.relayId && left.relaySessionId === right.relaySessionId && left.desktopSessionId === right.desktopSessionId && left.pairingGenerationRef === right.pairingGenerationRef && left.capabilityRevision === right.capabilityRevision && left.selectedProtocolVersion === right.selectedProtocolVersion;
}
function sameChild(left: ChildIdentity, right: ChildIdentity): boolean {
  return left.profile.actorId === right.profile.actorId && left.profile.profileHandle === right.profile.profileHandle && left.profile.profileGeneration === right.profile.profileGeneration && left.accountGeneration === right.accountGeneration && left.runtimeGeneration === right.runtimeGeneration && left.childGeneration === right.childGeneration;
}
function sameChildScope(child: ChildIdentity, scope: ProfileScope | ProfileLaunchScope): boolean {
  return child.profile.profileHandle === scope.profileHandle && child.profile.profileGeneration === scope.profileGeneration && child.accountGeneration === scope.accountGeneration && child.runtimeGeneration === scope.runtimeGeneration && ("childGeneration" in scope ? child.childGeneration === scope.childGeneration : true);
}
function isTerminalInstallation(
  value: CodexRuntimeInstallState | undefined,
): value is CodexRuntimeInstallState {
  return value?.phase === "ready" || value?.phase === "failed" || value?.phase === "cancelled";
}
function sameFeatures(
  left: CodexHostStatus["features"] | undefined,
  right: NonNullable<CodexHostStatus["features"]>,
): boolean {
  return Boolean(left
    && left.stableConversation === right.stableConversation
    && left.explicitSteer === right.explicitSteer
    && left.codexApprovals === right.codexApprovals
    && left.requestUserInput === right.requestUserInput
    && left.collaborationMode === right.collaborationMode);
}
function accountResult(value: ElectronCodexAccountProjection, accountGeneration: number): Extract<AdminResult, { readonly kind: "account_status" }> {
  // Codex documents requiresOpenaiAuth as a provider characteristic, not an
  // authentication-state flag. A managed ChatGPT account normally returns
  // both a populated account and requiresOpenaiAuth=true.
  const state: AccountState = value.state === "signed_in" ? "signed_in" : "signed_out";
  return {
    kind: "account_status",
    state,
    accountGeneration,
    // Provider identity is bounded separately from authentication material.
    ...(value.state === "signed_in"
      ? { accountEmail: value.email ?? null, planType: value.planType ?? null }
      : {}),
  };
}
function isApprovedArtifact(authority: ElectronCodexControllerOptions["artifactAuthority"], artifactRef: string): boolean {
  return "artifactRef" in authority ? authority.artifactRef === artifactRef : authority.allows(artifactRef);
}
function normalizeUsage(value: ElectronCodexUsageProjection): ElectronCodexUsageProjection {
  const newest = [...value.daily]
    .sort((left, right) => right.startDate.localeCompare(left.startDate))
    .slice(0, 31)
    .sort((left, right) => left.startDate.localeCompare(right.startDate));
  return { ...value, daily: newest };
}
const systemTimer: ElectronCodexTimerPort = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};
