import { lstat, mkdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  CuaSupervisor,
  isPinnedCuaBundleIdentifier,
  type CuaDesktopCaptureResult,
  type CuaDesktopClickResult,
  type CuaPixelClickOptions,
  type CuaWindowCaptureResult,
  type CuaWindowTraversalEffort,
  type CuaCaptureDiagnostic,
  type CuaContextToolCallResult,
  type CuaContextToolName,
  type CuaBrowserToolName,
  type CuaContextStartResult,
  type CuaSupervisorHealth,
} from "./native-cua-supervisor.js";
import type { ComputerUseContextScope } from "./native-context-registry.js";

/** Content-free host lifecycle; a healthy driver is deliberately not a route admission. */
export type CuaLifecycle =
  | "not_installed"
  | "installed"
  | "starting"
  | "healthy"
  | "unhealthy";

export type CuaLifecycleStatus = Readonly<{ lifecycle: CuaLifecycle }>;

/**
 * Content-free notification for consumers that anchored authority to an
 * successful readiness-check generation. The old token is cleared before this reaches a
 * listener, so no callback can observe it as still usable.
 */
export type CuaCheckedGenerationInvalidation = Readonly<{
  readonly generation: string;
  readonly reason: "supervisor_invalidated" | "provider_malformed" | "host_permissions_changed";
}>;

type RuntimeDirectoryStat = Readonly<{
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
  mode: number;
  uid: number;
}>;

export interface CuaMainLifecycleFilesystem {
  mkdir(path: string, options: Readonly<{ recursive: true; mode: number }>): Promise<unknown>;
  lstat(path: string): Promise<RuntimeDirectoryStat>;
  realpath(path: string): Promise<string>;
}

export interface CuaHealthSupervisor {
  refreshHealth(signal?: AbortSignal): Promise<
    | { readonly ok: true; readonly health: CuaSupervisorHealth }
    | { readonly ok: false; readonly code: string }
  >;
  /** Existing-generation seam; none of these methods may create or refresh a child. */
  existingHealthyGeneration(): string | null;
  subscribeInvalidation(listener: () => void): () => void;
  callContextTool(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    name: CuaContextToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaContextToolCallResult>;
  startBrowserContext(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<CuaContextStartResult>;
  callBrowserTool(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    sessionId: string,
    name: CuaBrowserToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult>;
  /** Narrow launch/window seams; generic daemon calls cannot substitute. */
  launchApplication(
    scope: ComputerUseContextScope, expectedGeneration: string, bundleId: string, signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult>;
  getWindowState(
    scope: ComputerUseContextScope, expectedGeneration: string, pid: number, windowId: number, query?: string, signal?: AbortSignal, effort?: CuaWindowTraversalEffort,
  ): Promise<CuaContextToolCallResult>;
  captureWindowState(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    pid: number,
    windowId: number,
    signal?: AbortSignal,
    effort?: CuaWindowTraversalEffort,
  ): Promise<CuaWindowCaptureResult>;
  captureDesktopState(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    signal?: AbortSignal,
  ): Promise<CuaDesktopCaptureResult>;
  awaitOutstandingOperations(scope: ComputerUseContextScope, expectedGeneration: string, requestSignal?: AbortSignal): Promise<void>;
  clickDesktop(
    scope: ComputerUseContextScope,
    expectedGeneration: string,
    x: number,
    y: number,
    signal?: AbortSignal,
    options?: CuaPixelClickOptions,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaDesktopClickResult>;
  endContextLease(scope: ComputerUseContextScope, generation: string, sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * The only future adapter port. Its generation was minted by a successful
 * startup or manual readiness check; calling it cannot turn an installed driver into a route.
 */
export interface CuaCheckedContextPort {
  readonly generation: string;
  /** Synchronously withdraw this checked token after semantic output drift. */
  invalidateCheckedGeneration?(): void;
  callContextTool(
    scope: ComputerUseContextScope,
    name: CuaContextToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaContextToolCallResult>;
  startBrowserContext(
    scope: ComputerUseContextScope,
    signal?: AbortSignal,
  ): Promise<CuaContextStartResult>;
  callBrowserTool(
    scope: ComputerUseContextScope,
    sessionId: string,
    name: CuaBrowserToolName,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult>;
  /** Narrow launch/window seams; every checked port provides both. */
  launchApplication(
    scope: ComputerUseContextScope, bundleId: string, signal?: AbortSignal,
  ): Promise<CuaContextToolCallResult>;
  getWindowState(
    scope: ComputerUseContextScope, pid: number, windowId: number, query?: string, signal?: AbortSignal, effort?: CuaWindowTraversalEffort,
  ): Promise<CuaContextToolCallResult>;
  captureWindowState(
    scope: ComputerUseContextScope,
    pid: number,
    windowId: number,
    signal?: AbortSignal,
    effort?: CuaWindowTraversalEffort,
  ): Promise<CuaWindowCaptureResult>;
  /** Dedicated path-free capture; cannot create, refresh, or restart Cua. */
  captureDesktopState(
    scope: ComputerUseContextScope,
    signal?: AbortSignal,
  ): Promise<CuaDesktopCaptureResult>;
  /** Wait until every already-admitted provider operation for this exact context has actually settled. */
  awaitOutstandingOperations(scope: ComputerUseContextScope, requestSignal?: AbortSignal): Promise<void>;
  clickDesktop(
    scope: ComputerUseContextScope,
    x: number,
    y: number,
    signal?: AbortSignal,
    options?: CuaPixelClickOptions,
    onProviderDispatch?: () => boolean | Promise<boolean>,
  ): Promise<CuaDesktopClickResult>;
  endContextLease(scope: ComputerUseContextScope, generation: string, sessionId: string): Promise<void>;
}

export interface CuaMainLifecycleOptions {
  /** Exact attested Host-owned driver path. No PATH or socket is accepted. */
  readonly binaryPath?: string;
  readonly platform?: string;
  readonly isPackaged?: boolean;
  readonly resourcesPath?: string;
  /** Host-owned trusted runtime root. */
  readonly userDataPath: string;
  /** Build-bound responsible host identity expected by the embedded child. */
  readonly hostBundleId?: string;
  readonly expectedUid?: number;
  /** Test override; production resolves the current OS user's home. */
  readonly userHomePath?: string;
  readonly filesystem?: CuaMainLifecycleFilesystem;
  readonly onCaptureDiagnostic?: (event: CuaCaptureDiagnostic) => void;
  readonly createSupervisor?: (
    binaryPath: string,
    runtimeDir: string,
    expectedUid: number,
    hostBundleId: string,
  ) => CuaHealthSupervisor;
}

export function resolvePackagedCuaDriverPath(options: Readonly<{ platform: string; isPackaged: boolean; resourcesPath: string }>): string | null {
  if (options.platform !== "darwin" || !options.isPackaged || !isAbsolute(options.resourcesPath)) return null;
  return join(options.resourcesPath, "tools-cua", "cua-driver");
}

/** Creates and attests only the app-owned leaf inside Electron's tuple-scoped root. */
export async function ensureCuaRuntimeDirectory(
  userDataPath: string,
  expectedUid: number,
  filesystem: CuaMainLifecycleFilesystem = { mkdir, lstat, realpath },
): Promise<string> {
  if (!isAbsolute(userDataPath)) throw new Error("cua runtime requires an absolute Electron userData root");
  // Darwin's AF_UNIX sockaddr path is limited to 104 bytes. Tuple-scoped
  // Electron userData paths routinely exceed the remaining budget once the
  // supervisor appends its opaque generation socket name. Keep only a
  // content-free tuple digest in a short, current-user-only leaf; the
  // supervisor re-attests this directory and every socket inode before use.
  const tupleDigest = createHash("sha256").update(userDataPath).digest("hex").slice(0, 24);
  const requestedDir = join("/tmp", `nautilo-cua-${tupleDigest}`);
  await filesystem.mkdir(requestedDir, { recursive: true, mode: 0o700 });
  // Attest the requested final leaf before resolving Darwin's /tmp link. A
  // deterministic leaf must never be allowed to become a symlink into an
  // attacker-chosen safe-looking target merely because that target passes the
  // canonical-path checks below.
  const requestedStat = await filesystem.lstat(requestedDir);
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory() || (requestedStat.mode & 0o777) !== 0o700 || requestedStat.uid !== expectedUid) {
    throw new Error("cua runtime directory is not a private current-user directory");
  }
  // Darwin's /tmp is a symlink to /private/tmp. Every path derived from this
  // directory (sockets, capture files) crosses the daemon boundary and comes
  // back in provider responses; a daemon that canonicalizes would otherwise
  // echo a path that fails exact equality against the one we sent. Hand out
  // only the canonical form so sent and echoed paths can never diverge on
  // symlink resolution alone.
  const runtimeDir = await filesystem.realpath(requestedDir);
  const canonicalStat = await filesystem.lstat(runtimeDir);
  if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory() || (canonicalStat.mode & 0o777) !== 0o700 || canonicalStat.uid !== expectedUid) {
    throw new Error("cua runtime directory is not a private current-user directory");
  }
  return runtimeDir;
}

/** The package resource is never searched for or repaired at runtime. */
export async function attestPackagedCuaDriver(
  binaryPath: string,
  filesystem: Pick<CuaMainLifecycleFilesystem, "lstat"> = { lstat },
): Promise<boolean> {
  try {
    const stat = await filesystem.lstat(binaryPath);
    return !stat.isSymbolicLink() && stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Main-process owner for the optional packaged Cua child. It is intentionally
 * independent from provider routing: no call here makes Cua executable for a
 * Genie, advertises a relay capability, or creates a Computer Use session.
 */
export class CuaMainLifecycle {
  private readonly binaryPath: string | null;
  private readonly expectedUid: number;
  private readonly hostBundleId: string;
  private readonly filesystem: CuaMainLifecycleFilesystem;
  private readonly createSupervisor: NonNullable<CuaMainLifecycleOptions["createSupervisor"]>;
  private supervisor: CuaHealthSupervisor | null = null;
  private lifecycle: CuaLifecycle;
  private checking: Promise<CuaLifecycleStatus> | null = null;
  private checkingAbort: AbortController | null = null;
  /** One host-permission transition owns child retirement and fresh attestation. */
  private reconcilingHostPermissions: Promise<CuaLifecycleStatus> | null = null;
  /**
   * A supervisor whose child could not be proven reaped. It deliberately
   * fences every successor: spawning a new daemon would violate the embedded
   * driver's single-owner lifecycle after an uncertain cleanup failure.
   */
  private retiredSupervisorFence: CuaHealthSupervisor | null = null;
  private checkedGeneration: string | null = null;
  /** Bumped by child/socket loss so a Check can never publish a stale token. */
  private invalidationRevision = 0;
  private unsubscribeInvalidation: (() => void) | null = null;
  private readonly checkedGenerationInvalidationListeners = new Set<
    (event: CuaCheckedGenerationInvalidation) => void
  >();
  private closed = false;

  constructor(private readonly options: CuaMainLifecycleOptions) {
    if (options.binaryPath !== undefined && !isAbsolute(options.binaryPath)) {
      throw new Error("cua lifecycle requires an absolute driver path");
    }
    this.binaryPath = options.binaryPath ?? (
      options.platform === undefined || options.isPackaged === undefined || options.resourcesPath === undefined
        ? null
        : resolvePackagedCuaDriverPath({
          platform: options.platform,
          isPackaged: options.isPackaged,
          resourcesPath: options.resourcesPath,
        })
    );
    this.lifecycle = this.binaryPath === null ? "not_installed" : "installed";
    const uid = options.expectedUid ?? process.getuid?.();
    if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) {
      throw new Error("cua lifecycle requires the current-user uid");
    }
    this.expectedUid = uid;
    this.filesystem = options.filesystem ?? { mkdir, lstat, realpath };
    this.hostBundleId = options.hostBundleId ?? "com.nautilo.desktop";
    // This is a build-bound host identity passed to the daemon command line,
    // not an arbitrary installed-app identifier. Keep its established 255
    // code-unit containment in addition to the shared CFBundle syntax check.
    if (!isPinnedCuaBundleIdentifier(this.hostBundleId) || this.hostBundleId.length > 255) {
      throw new Error("cua lifecycle requires a valid build-bound host bundle id");
    }
    const userHomePath = options.userHomePath ?? homedir();
    this.createSupervisor = options.createSupervisor ?? ((binaryPath, runtimeDir, expectedUid, hostBundleId) =>
      new CuaSupervisor({
        binaryPath,
        runtimeDir,
        expectedUid,
        hostBundleId,
        userHomePath,
        ...(options.onCaptureDiagnostic === undefined ? {} : { onCaptureDiagnostic: options.onCaptureDiagnostic }),
      }));
  }

  /** Local snapshot only: this never creates, starts, or refreshes a daemon. */
  status(): CuaLifecycleStatus {
    return { lifecycle: this.lifecycle };
  }

  /**
   * Returns only the port tied to the latest successful lifecycle readiness check. It is a
   * read-only lookup: no status, adapter, or relay caller can start Cua.
   */
  checkedContextPort(): CuaCheckedContextPort | null {
    const supervisor = this.supervisor;
    const generation = this.checkedGeneration;
    if (this.closed || this.lifecycle !== "healthy" || supervisor === null || generation === null
      || supervisor.existingHealthyGeneration() !== generation) return null;
    return {
      generation,
      invalidateCheckedGeneration: () => {
        if (this.checkedGeneration !== generation) return;
        this.invalidationRevision += 1;
        this.lifecycle = "unhealthy";
        this.invalidateCheckedGeneration("provider_malformed");
      },
      callContextTool: (scope, name, args, signal, onProviderDispatch) => supervisor.callContextTool(scope, generation, name, args, signal, onProviderDispatch),
      startBrowserContext: (scope, signal) => supervisor.startBrowserContext(scope, generation, signal),
      callBrowserTool: (scope, sessionId, name, args, signal) => supervisor.callBrowserTool(scope, generation, sessionId, name, args, signal),
      launchApplication: (scope, bundleId, signal) => supervisor.launchApplication(scope, generation, bundleId, signal),
      getWindowState: (scope, pid, windowId, query, signal, effort) => supervisor.getWindowState(scope, generation, pid, windowId, query, signal, effort),
      captureWindowState: (scope, pid, windowId, signal, effort) => supervisor.captureWindowState(scope, generation, pid, windowId, signal, effort),
      captureDesktopState: (scope, signal) => supervisor.captureDesktopState(scope, generation, signal),
      awaitOutstandingOperations: (scope, requestSignal) => supervisor.awaitOutstandingOperations(scope, generation, requestSignal),
      clickDesktop: (scope, x, y, signal, options, onProviderDispatch) => supervisor.clickDesktop(scope, generation, x, y, signal, options, onProviderDispatch),
      endContextLease: (scope, leaseGeneration, sessionId) => supervisor.endContextLease(scope, leaseGeneration, sessionId),
    };
  }

  /**
   * Subscribe to loss of an already readiness-check-minted generation. This is a
   * synchronous local signal only; it neither checks nor starts Cua.
   */
  subscribeCheckedGenerationInvalidation(
    listener: (event: CuaCheckedGenerationInvalidation) => void,
  ): () => void {
    this.checkedGenerationInvalidationListeners.add(listener);
    return () => this.checkedGenerationInvalidationListeners.delete(listener);
  }

  private invalidateCheckedGeneration(reason: CuaCheckedGenerationInvalidation["reason"]): void {
    const generation = this.checkedGeneration;
    this.checkedGeneration = null;
    if (generation === null) return;
    const event = { generation, reason } as const;
    for (const listener of this.checkedGenerationInvalidationListeners) {
      try { listener(event); } catch { /* lifecycle invalidation cannot be blocked by a consumer */ }
    }
  }

  /** Automatic host startup path; it shares the exact checked-generation gate. */
  startup(): Promise<CuaLifecycleStatus> {
    return this.check();
  }

  /** Starts if necessary and performs fresh health; manual Check reuses it. */
  check(): Promise<CuaLifecycleStatus> {
    if (this.closed) return Promise.resolve(this.status());
    if (this.retiredSupervisorFence !== null) return Promise.resolve(this.status());
    // Do not let a manual Check race a host-permission transition and mint a
    // new child between its old-child retirement and fresh post-TCC check.
    if (this.reconcilingHostPermissions !== null) return this.reconcilingHostPermissions;
    return this.startCheck();
  }

  private startCheck(): Promise<CuaLifecycleStatus> {
    if (this.closed) return Promise.resolve(this.status());
    if (this.checking !== null) return this.checking;
    const abort = new AbortController();
    this.checkingAbort = abort;
    const pending = this.checkInternal(abort.signal).finally(() => {
      if (this.checking === pending) this.checking = null;
      if (this.checkingAbort === abort) this.checkingAbort = null;
    });
    this.checking = pending;
    return pending;
  }

  /**
   * Reconcile a responsible-host Accessibility or Screen Recording grant
   * transition. The embedded Cua contract requires destroying clients and the
   * daemon before reconnecting: a child that queried TCC before the user
   * changed the grant may retain the old result. This touches no TCC state; the
   * caller has already observed the host-owned OS permission change.
   *
   * Invalidation is deliberately synchronous and precedes child shutdown, so
   * route consumers can never issue more work through the prior checked
   * generation while cleanup is in flight. A durable Human grant remains
   * outside this lifecycle; only this provider generation is withdrawn.
   */
  reconcileHostPermissions(): Promise<CuaLifecycleStatus> {
    if (this.closed || this.binaryPath === null) return Promise.resolve(this.status());
    if (this.retiredSupervisorFence !== null) return Promise.resolve(this.status());
    if (this.reconcilingHostPermissions !== null) return this.reconcilingHostPermissions;

    const pending = this.reconcileHostPermissionsInternal().finally(() => {
      if (this.reconcilingHostPermissions === pending) this.reconcilingHostPermissions = null;
    });
    this.reconcilingHostPermissions = pending;
    return pending;
  }

  private async reconcileHostPermissionsInternal(): Promise<CuaLifecycleStatus> {
    // Make the old route unusable before asking the child to stop. Bumping the
    // revision also prevents an aborted in-flight Check from publishing its
    // pre-transition generation after it settles.
    this.invalidationRevision += 1;
    this.lifecycle = "unhealthy";
    this.invalidateCheckedGeneration("host_permissions_changed");

    this.checkingAbort?.abort();
    await this.checking?.catch(() => {});

    // Detach before awaiting cleanup. A late invalidation from this retired
    // child cannot affect its successor, and a concurrent shutdown can safely
    // observe that the lifecycle no longer owns this supervisor.
    const retiredSupervisor = this.supervisor;
    this.supervisor = null;
    const unsubscribeInvalidation = this.unsubscribeInvalidation;
    this.unsubscribeInvalidation = null;
    unsubscribeInvalidation?.();
    try {
      await retiredSupervisor?.shutdown();
    } catch {
      // The supervisor itself fences failed cleanup. Preserve an unhealthy
      // state and never create another child whose predecessor may be live.
      this.retiredSupervisorFence = retiredSupervisor;
      return this.status();
    }

    if (this.closed) return this.status();
    // Bypass check()'s reconciliation coalescer only for the owned terminal
    // fresh check. Other callers still coalesce on this transition promise.
    return this.startCheck();
  }

  private async checkInternal(signal: AbortSignal): Promise<CuaLifecycleStatus> {
    if (this.binaryPath === null) return this.status();
    this.lifecycle = "starting";
    this.invalidateCheckedGeneration("supervisor_invalidated");
    const checkInvalidationRevision = this.invalidationRevision;
    try {
      // Before first use, `installed` means only that this build has the
      // expected resource location. This exact regular/executable-file check
      // upgrades it to an operable embedded artifact; no PATH or dev fallback
      // exists if it is absent or unsafe.
      if (!await attestPackagedCuaDriver(this.binaryPath, this.filesystem)) {
        this.lifecycle = "not_installed";
        return this.status();
      }
      if (this.supervisor === null) {
        const runtimeDir = await ensureCuaRuntimeDirectory(
          this.options.userDataPath,
          this.expectedUid,
          this.filesystem,
        );
        this.supervisor = this.createSupervisor(
          this.binaryPath,
          runtimeDir,
          this.expectedUid,
          this.hostBundleId,
        );
        this.unsubscribeInvalidation = this.supervisor.subscribeInvalidation(() => {
          this.invalidationRevision += 1;
          this.invalidateCheckedGeneration("supervisor_invalidated");
          if (!this.closed) this.lifecycle = "unhealthy";
        });
      }
      const result = await this.supervisor.refreshHealth(signal);
      const generation = result.ok && result.health.permission === "ready" && result.health.health === "ready"
        ? this.supervisor.existingHealthyGeneration()
        : null;
      this.checkedGeneration = checkInvalidationRevision === this.invalidationRevision
        && generation !== null && /^cua_[A-Za-z0-9_-]{32}$/.test(generation) ? generation : null;
      this.lifecycle = this.checkedGeneration === null ? "unhealthy" : "healthy";
    } catch {
      this.checkedGeneration = null;
      this.lifecycle = "unhealthy";
    }
    return this.status();
  }

  /** Idempotent host teardown; a check in flight settles before its child is stopped. */
  async shutdown(): Promise<void> {
    this.closed = true;
    this.invalidateCheckedGeneration("supervisor_invalidated");
    this.checkingAbort?.abort();
    await this.checking?.catch(() => {});
    // A permission reconciliation may have detached a child before its
    // shutdown finished. Wait for it so app teardown cannot leave that child
    // running after this lifecycle returns.
    await this.reconcilingHostPermissions?.catch(() => {});
    // Attempt every owned cleanup even if an earlier supervisor refuses to
    // reap. A failure still surfaces to the app owner rather than pretending
    // teardown completed, while the retained fence prevents replacement.
    let cleanupFailure: unknown = null;
    try {
      await this.retiredSupervisorFence?.shutdown();
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await this.supervisor?.shutdown();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure instanceof Error) throw cleanupFailure;
    if (cleanupFailure !== null) {
      throw new Error("cua child cleanup failed with a non-error rejection");
    }
    this.unsubscribeInvalidation?.();
    this.unsubscribeInvalidation = null;
  }
}
