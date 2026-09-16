/**
 * D103 — main-process updater policy.
 *
 * This module deliberately knows nothing about Electron windows, menus,
 * preload IPC, or the live Bunny feed. The eventual main.ts integration is
 * responsible for deciding whether an official packaged build may enable the
 * production feed, and for adapting Electron's autoUpdater/dialog APIs to
 * these small interfaces. Keeping that boundary here makes the policy fully
 * testable without booting Electron and prevents renderer/server input from
 * gaining updater authority.
 */

const DEFAULT_STARTUP_DELAY_MS = 60_000;
const DEFAULT_PERIODIC_CHECK_MS = 6 * 60 * 60 * 1_000;

const MAX_VERSION_LENGTH = 64;

export type UpdateCheckSource = "startup" | "periodic" | "manual";

export type UpdaterDisabledReason =
  | "development"
  | "unpackaged"
  | "unsigned"
  | "test"
  | "feed-not-configured";

export type SanitizedUpdate = Readonly<{ version: string }>;

export type UpdaterErrorPhase = "check" | "download" | "install" | "invalid-update";

export type SanitizedUpdaterError = Readonly<{
  phase: UpdaterErrorPhase;
  message: string;
}>;

export type UpdateState =
  | Readonly<{ kind: "disabled"; reason: UpdaterDisabledReason }>
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "checking"; source: UpdateCheckSource }>
  | Readonly<{ kind: "available"; update: SanitizedUpdate }>
  | Readonly<{ kind: "downloading"; update: SanitizedUpdate; percent: number }>
  | Readonly<{ kind: "ready"; update: SanitizedUpdate }>
  | Readonly<{ kind: "error"; error: SanitizedUpdaterError }>
  | Readonly<{ kind: "installing"; update: SanitizedUpdate }>;

/**
 * The only state shape intended for a future Workbench projection. It omits
 * provider data, feed configuration, error detail, and installation control;
 * the renderer can render the rail affordance but cannot acquire authority.
 */
export type SanitizedUpdateStatus =
  | Readonly<{ kind: "hidden" }>
  | Readonly<{ kind: "available"; version: string }>
  | Readonly<{ kind: "downloading"; version: string; percent: number }>
  | Readonly<{ kind: "ready"; version: string }>
  | Readonly<{ kind: "installing"; version: string }>;

export type UpdaterEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

/** Minimal `electron-updater` facade. Main.ts owns the concrete adapter. */
export interface ElectronUpdaterFacade {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: UpdaterEvent, listener: (...args: unknown[]) => void): void;
  removeListener(event: UpdaterEvent, listener: (...args: unknown[]) => void): void;
}

export interface UpdaterTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface UpdateControllerUi {
  /** Native Later / Download dialog. It receives only a validated version. */
  showAvailable(update: SanitizedUpdate): Promise<"later" | "download"> | "later" | "download";
  /** Native Cancel / Restart & Update dialog. */
  showReady(update: SanitizedUpdate): Promise<"later" | "restart"> | "later" | "restart";
  /** Only invoked for a manual successful check; background checks stay quiet. */
  showNoUpdate(): void;
  /** Receives a generic error with no URL, filesystem path, or provider text. */
  showError(error: SanitizedUpdaterError): void;
}

export interface UpdateControllerOptions {
  updater: ElectronUpdaterFacade;
  timers: UpdaterTimers;
  ui: UpdateControllerUi;
  /**
   * This is the production-feed authority gate. Main computes it from its
   * packaged/signed/test/build configuration; no IPC, server, environment, or
   * renderer value reaches this controller.
   */
  productionFeedEnabled: boolean;
  disabledReason?: UpdaterDisabledReason;
  startupDelayMs?: number;
  periodicCheckMs?: number;
  onStateChange?: (state: UpdateState) => void;
  /** Later Phase 4 wiring can run bounded cleanup before calling quit/install. */
  beforeInstall?: () => Promise<boolean> | boolean;
}

export type UpdateCommandResult =
  | Readonly<{ accepted: true; coalesced: boolean }>
  | Readonly<{
      accepted: false;
      reason: "disabled" | "disposed" | "busy" | "not-available" | "not-ready";
    }>;

type ActiveCheck =
  | Readonly<{ generation: number; kind: "ordinary" }>
  | {
      generation: number;
      kind: "download-refresh";
      selected: SanitizedUpdate;
      observed: SanitizedUpdate | null;
      failed: boolean;
    };

type DownloadRefreshResult = Readonly<{
  result: UpdateCommandResult;
  replacement: SanitizedUpdate | null;
}>;

const CHECK_ERROR_MESSAGE = "Unable to check for updates. Please try again later.";
const DOWNLOAD_ERROR_MESSAGE = "Unable to download the update. Please try again later.";
const INSTALL_ERROR_MESSAGE = "Unable to install the update. Please try again later.";
const INVALID_UPDATE_MESSAGE = "The available update could not be verified.";

const VERSION_RE = /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/;

function toSanitizedVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = value.trim();
  if (version.length === 0 || version.length > MAX_VERSION_LENGTH) return null;
  if (!VERSION_RE.test(version)) return null;
  return version;
}

/**
 * Provider release objects are untrusted transport metadata. V1 exposes only
 * a bounded semantic version to native UI; release notes, URLs, paths, and
 * arbitrary provider fields never cross the main-process state boundary.
 */
export function sanitizeUpdateInfo(value: unknown): SanitizedUpdate | null {
  if (!value || typeof value !== "object") return null;
  const version = toSanitizedVersion((value as { version?: unknown }).version);
  return version ? { version } : null;
}

function compareNumericIdentifier(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

/** Compare the already-sanitized SemVer-compatible versions without provider metadata. */
function compareVersions(left: string, right: string): number {
  const splitVersion = (value: string): readonly [string, string | undefined] => {
    const buildIndex = value.indexOf("+");
    const withoutBuild = buildIndex === -1 ? value : value.slice(0, buildIndex);
    const prereleaseIndex = withoutBuild.indexOf("-");
    return prereleaseIndex === -1
      ? [withoutBuild, undefined]
      : [withoutBuild.slice(0, prereleaseIndex), withoutBuild.slice(prereleaseIndex + 1)];
  };
  const [leftCore, leftPrerelease] = splitVersion(left);
  const [rightCore, rightPrerelease] = splitVersion(right);
  const leftParts = leftCore.split(".");
  const rightParts = rightCore.split(".");
  const coreLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < coreLength; index += 1) {
    const comparison = compareNumericIdentifier(leftParts[index] ?? "0", rightParts[index] ?? "0");
    if (comparison !== 0) return comparison;
  }
  if (leftPrerelease === undefined || rightPrerelease === undefined) {
    if (leftPrerelease === rightPrerelease) return 0;
    return leftPrerelease === undefined ? 1 : -1;
  }
  const leftIdentifiers = leftPrerelease.split(".");
  const rightIdentifiers = rightPrerelease.split(".");
  const prereleaseLength = Math.max(leftIdentifiers.length, rightIdentifiers.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftIdentifier = leftIdentifiers[index];
    const rightIdentifier = rightIdentifiers[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier ? 0 : leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

/** Generic UI-safe error. Raw updater errors are intentionally not retained. */
export function sanitizeUpdaterError(phase: UpdaterErrorPhase): SanitizedUpdaterError {
  switch (phase) {
    case "check":
      return { phase, message: CHECK_ERROR_MESSAGE };
    case "download":
      return { phase, message: DOWNLOAD_ERROR_MESSAGE };
    case "install":
      return { phase, message: INSTALL_ERROR_MESSAGE };
    case "invalid-update":
      return { phase, message: INVALID_UPDATE_MESSAGE };
  }
}

function progressPercent(value: unknown): number {
  const raw = value && typeof value === "object" ? (value as { percent?: unknown }).percent : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function defaultTimers(): UpdaterTimers {
  return {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };
}

/**
 * Explicit, main-owned updater controller. Its public methods are suitable
 * for the future menu and native-dialog adapters; it neither accepts nor
 * exposes feed/channel/artifact authority.
 */
export class UpdateController {
  private readonly updater: ElectronUpdaterFacade;
  private readonly timers: UpdaterTimers;
  private readonly ui: UpdateControllerUi;
  private readonly enabled: boolean;
  private readonly disabledReason: UpdaterDisabledReason;
  private readonly startupDelayMs: number;
  private readonly periodicCheckMs: number;
  private readonly onStateChange: ((state: UpdateState) => void) | undefined;
  private readonly beforeInstall: (() => Promise<boolean> | boolean) | undefined;

  private state: UpdateState;
  private disposed = false;
  private schedulingStarted = false;
  private startupTimer: unknown = null;
  private periodicTimer: unknown = null;
  private checkInFlight: Promise<UpdateCommandResult> | null = null;
  private downloadInFlight: Promise<UpdateCommandResult> | null = null;
  private installInFlight: Promise<UpdateCommandResult> | null = null;
  private lastCheckSource: UpdateCheckSource | null = null;
  private noUpdateNotified = false;
  private availableDialogVersion: string | null = null;
  private readyDialogVersion: string | null = null;
  private availableDialogOpen = false;
  private readyDialogOpen = false;
  private errorNotified = false;
  private checkGeneration = 0;
  private activeCheck: ActiveCheck | null = null;

  private readonly listeners: Readonly<Record<UpdaterEvent, (...args: unknown[]) => void>>;

  constructor(options: UpdateControllerOptions) {
    this.updater = options.updater;
    this.timers = options.timers ?? defaultTimers();
    this.ui = options.ui;
    this.enabled = options.productionFeedEnabled;
    this.disabledReason = options.disabledReason ?? "feed-not-configured";
    this.startupDelayMs = options.startupDelayMs ?? DEFAULT_STARTUP_DELAY_MS;
    this.periodicCheckMs = options.periodicCheckMs ?? DEFAULT_PERIODIC_CHECK_MS;
    this.onStateChange = options.onStateChange;
    this.beforeInstall = options.beforeInstall;
    this.state = this.enabled ? { kind: "idle" } : { kind: "disabled", reason: this.disabledReason };

    this.listeners = {
      "checking-for-update": () => this.handleCheckingEvent(),
      "update-available": (info) => this.handleAvailableEvent(info),
      "update-not-available": () => this.handleNoUpdateEvent(),
      "download-progress": (progress) => this.handleProgressEvent(progress),
      "update-downloaded": (info) => this.handleReadyEvent(info),
      error: () => this.handleUpdaterErrorEvent(),
    };

    // A disabled controller must be completely inert. In particular, touching
    // electron-updater while Electron is unpackaged can initialize its
    // platform-specific implementation and abort Desktop smoke before the
    // first window is created.
    if (this.enabled) {
      // These are policy, not defaults: set them before registering listeners
      // or issuing a check so every enabled code path observes explicit
      // user-controlled behavior.
      this.updater.autoDownload = false;
      this.updater.autoInstallOnAppQuit = false;
      for (const event of Object.keys(this.listeners) as UpdaterEvent[]) {
        this.updater.on(event, this.listeners[event]);
      }
    }
  }

  /** Immutable snapshot suitable for a future sanitized renderer projection. */
  getState(): UpdateState {
    return this.state;
  }

  /** Narrow, renderer-safe rail status. Main remains the only action owner. */
  getSanitizedStatus(): SanitizedUpdateStatus {
    switch (this.state.kind) {
      case "available":
        return { kind: "available", version: this.state.update.version };
      case "downloading":
        return {
          kind: "downloading",
          version: this.state.update.version,
          percent: this.state.percent,
        };
      case "ready":
        return { kind: "ready", version: this.state.update.version };
      case "installing":
        return { kind: "installing", version: this.state.update.version };
      case "disabled":
      case "idle":
      case "checking":
      case "error":
        return { kind: "hidden" };
    }
  }

  /** Start the delayed startup check and periodic checks. Idempotent. */
  startScheduling(): boolean {
    if (!this.canOperate() || this.schedulingStarted) return false;
    this.schedulingStarted = true;
    this.startupTimer = this.timers.setTimeout(() => {
      this.startupTimer = null;
      void this.checkForUpdates("startup");
    }, this.startupDelayMs);
    this.periodicTimer = this.timers.setInterval(() => {
      void this.checkForUpdates("periodic");
    }, this.periodicCheckMs);
    return true;
  }

  /** Menu/native UI entry point. Never auto-downloads. */
  checkForUpdates(source: UpdateCheckSource = "manual"): Promise<UpdateCommandResult> {
    if (this.disposed) return Promise.resolve({ accepted: false, reason: "disposed" });
    if (!this.enabled) return Promise.resolve({ accepted: false, reason: "disabled" });
    if (this.checkInFlight) {
      return this.checkInFlight.then(() => ({ accepted: true, coalesced: true }));
    }
    // Discovery is deliberately quiet once an update is known. The
    // argument-free menu/rail entry point reopens that existing flow, and only
    // the explicit Download path below may perform an internal freshness check.
    if (
      this.state.kind === "available" ||
      this.state.kind === "downloading" ||
      this.state.kind === "ready" ||
      this.state.kind === "installing"
    ) {
      return Promise.resolve({ accepted: false, reason: "busy" });
    }

    this.lastCheckSource = source;
    this.noUpdateNotified = false;
    this.errorNotified = false;
    this.setState({ kind: "checking", source });
    const activeCheck: ActiveCheck = { generation: ++this.checkGeneration, kind: "ordinary" };
    this.activeCheck = activeCheck;
    const operation = this.updater
      .checkForUpdates()
      .then(() => ({ accepted: true, coalesced: false }) as const)
      .catch(() => {
        this.reportError("check");
        return { accepted: true, coalesced: false } as const;
      })
      .finally(() => {
        if (this.checkInFlight === operation) this.checkInFlight = null;
        if (this.activeCheck?.generation === activeCheck.generation) this.activeCheck = null;
      });
    this.checkInFlight = operation;
    return operation;
  }

  /** Argument-free native-menu entry point. */
  checkNow(): Promise<UpdateCommandResult> {
    return this.checkForUpdates("manual");
  }

  /**
   * Argument-free action for the native menu or rail. Known update states
   * reopen their native dialog; otherwise this performs a manual check.
   */
  openUpdateFlow(): void {
    if (this.state.kind === "available") {
      this.presentAvailableUpdate();
      return;
    }
    if (this.state.kind === "ready") {
      this.presentReadyUpdate();
      return;
    }
    void this.checkNow();
  }

  /** Explicit Download button entry point; refreshes the selected available version before transfer. */
  downloadUpdate(): Promise<UpdateCommandResult> {
    if (this.disposed) return Promise.resolve({ accepted: false, reason: "disposed" });
    if (!this.enabled) return Promise.resolve({ accepted: false, reason: "disabled" });
    if (this.downloadInFlight) {
      return this.downloadInFlight.then(() => ({ accepted: true, coalesced: true }));
    }
    if (this.state.kind !== "available") {
      return Promise.resolve({ accepted: false, reason: "not-available" });
    }

    const selected = this.state.update;
    const precedingCheck = this.checkInFlight;
    let replacement: SanitizedUpdate | null = null;
    const operation = Promise.resolve(precedingCheck)
      .then(() => this.refreshAndMaybeDownload(selected))
      .then((outcome) => {
        replacement = outcome.replacement;
        return outcome.result;
      })
      .finally(() => {
        if (this.downloadInFlight === operation) this.downloadInFlight = null;
        if (
          replacement &&
          !this.disposed &&
          this.state.kind === "available" &&
          this.state.update.version === replacement.version
        ) {
          this.presentAvailableDialog(replacement, false);
        }
      });
    this.downloadInFlight = operation;
    return operation;
  }

  /** Reopen the native available dialog from a menu/rail action without a new request. */
  presentAvailableUpdate(): boolean {
    if (this.state.kind !== "available" || this.disposed) return false;
    this.presentAvailableDialog(this.state.update, true);
    return true;
  }

  /** Reopen the ready dialog from a menu/rail action without a new request. */
  presentReadyUpdate(): boolean {
    if (this.state.kind !== "ready" || this.disposed) return false;
    this.presentReadyDialog(this.state.update, true);
    return true;
  }

  /**
   * Only an explicit ready-state confirmation reaches the install adapter.
   * The optional preparation seam is intentionally injected so Phase 4 owns
   * bounded cleanup rather than teaching the updater about application work.
   */
  installUpdate(): Promise<UpdateCommandResult> {
    if (this.disposed) return Promise.resolve({ accepted: false, reason: "disposed" });
    if (!this.enabled) return Promise.resolve({ accepted: false, reason: "disabled" });
    if (this.installInFlight || this.state.kind === "installing") {
      const inFlight = this.installInFlight;
      return inFlight
        ? inFlight.then(() => ({ accepted: true, coalesced: true }))
        : Promise.resolve({ accepted: true, coalesced: true });
    }
    if (this.state.kind !== "ready") {
      return Promise.resolve({ accepted: false, reason: "not-ready" });
    }

    const update = this.state.update;
    this.errorNotified = false;
    this.setState({ kind: "installing", update });
    const operation = Promise.resolve()
      .then(() => this.beforeInstall?.() ?? true)
      .then((mayInstall) => {
        if (!mayInstall) {
          this.setState({ kind: "ready", update });
          return { accepted: false, reason: "not-ready" } as const;
        }
        this.updater.quitAndInstall();
        return { accepted: true, coalesced: false } as const;
      })
      .catch(() => {
        this.reportError("install");
        return { accepted: true, coalesced: false } as const;
      })
      .finally(() => {
        if (this.installInFlight === operation) this.installInFlight = null;
      });
    this.installInFlight = operation;
    return operation;
  }

  /** Explicitly documents that an ordinary application quit never installs. */
  onOrdinaryQuit(): Readonly<{ installRequested: false }> {
    return { installRequested: false };
  }

  /** Release all timers and updater listeners. Events arriving afterwards are ignored. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.startupTimer !== null) this.timers.clearTimeout(this.startupTimer);
    if (this.periodicTimer !== null) this.timers.clearInterval(this.periodicTimer);
    this.startupTimer = null;
    this.periodicTimer = null;
    if (this.enabled) {
      for (const event of Object.keys(this.listeners) as UpdaterEvent[]) {
        this.updater.removeListener(event, this.listeners[event]);
      }
    }
  }

  private canOperate(): boolean {
    return this.enabled && !this.disposed;
  }

  private setState(state: UpdateState): void {
    if (this.disposed) return;
    this.state = state;
    try {
      this.onStateChange?.(state);
    } catch {
      // A UI projection must not change updater authority or break release UX.
    }
  }

  private handleCheckingEvent(): void {
    if (!this.canOperate()) return;
    // `checkForUpdates()` enters checking before invoking the provider. A late
    // provider event must not regress a known/downloaded/installing update.
    if (this.state.kind !== "checking") return;
  }

  private handleAvailableEvent(info: unknown): void {
    if (!this.canOperate()) return;
    const activeCheck = this.activeCheck;
    if (activeCheck?.kind === "download-refresh") {
      if (
        this.state.kind !== "available" ||
        this.state.update.version !== activeCheck.selected.version ||
        activeCheck.failed
      ) {
        return;
      }
      const update = sanitizeUpdateInfo(info);
      if (!update) {
        this.failDownloadRefresh(activeCheck, "invalid-update");
        return;
      }
      if (compareVersions(update.version, activeCheck.selected.version) < 0) return;
      if (!activeCheck.observed || compareVersions(update.version, activeCheck.observed.version) > 0) {
        activeCheck.observed = update;
      }
      return;
    }
    if (this.state.kind !== "checking") return;
    const update = sanitizeUpdateInfo(info);
    if (!update) {
      this.reportError("invalid-update");
      return;
    }
    this.setState({ kind: "available", update });
    this.presentAvailableDialog(update, false);
  }

  private handleNoUpdateEvent(): void {
    if (!this.canOperate()) return;
    const activeCheck = this.activeCheck;
    if (activeCheck?.kind === "download-refresh") {
      this.failDownloadRefresh(activeCheck, "check");
      return;
    }
    if (this.state.kind !== "checking") return;
    this.setState({ kind: "idle" });
    if (this.lastCheckSource === "manual" && !this.noUpdateNotified) {
      this.noUpdateNotified = true;
      try {
        this.ui.showNoUpdate();
      } catch {
        // Native-dialog availability must not alter a successful check result.
      }
    }
  }

  private handleProgressEvent(progress: unknown): void {
    if (!this.canOperate()) return;
    const update = this.state.kind === "downloading" ? this.state.update : null;
    if (!update) return;
    this.setState({ kind: "downloading", update, percent: progressPercent(progress) });
  }

  private handleReadyEvent(info: unknown): void {
    if (!this.canOperate()) return;
    if (this.state.kind !== "downloading") return;
    const selectedUpdate = this.state.update;
    const update = sanitizeUpdateInfo(info);
    if (!update || update.version !== selectedUpdate.version) {
      this.reportError("invalid-update");
      return;
    }
    this.setState({ kind: "ready", update });
    this.presentReadyDialog(update, false);
  }

  private handleUpdaterErrorEvent(): void {
    if (!this.canOperate()) return;
    const activeCheck = this.activeCheck;
    if (activeCheck?.kind === "download-refresh") {
      this.failDownloadRefresh(activeCheck, "check");
      return;
    }
    if (this.state.kind === "checking") this.reportError("check");
    else if (this.state.kind === "downloading") this.reportError("download");
  }

  private presentAvailableDialog(update: SanitizedUpdate, force: boolean): void {
    if (!force && this.availableDialogVersion === update.version) return;
    if (this.availableDialogOpen) return;
    this.availableDialogVersion = update.version;
    this.availableDialogOpen = true;
    let decision: Promise<"later" | "download"> | "later" | "download";
    try {
      decision = this.ui.showAvailable(update);
    } catch {
      this.availableDialogOpen = false;
      this.reportError("check");
      return;
    }
    void Promise.resolve(decision)
      .then((decision) => {
        if (this.disposed || this.state.kind !== "available" || this.state.update.version !== update.version) return;
        if (decision === "download") void this.downloadUpdate();
      })
      .catch(() => this.reportError("check"))
      .finally(() => {
        this.availableDialogOpen = false;
        if (
          !this.disposed &&
          this.state.kind === "available" &&
          this.state.update.version !== update.version
        ) {
          this.presentAvailableDialog(this.state.update, false);
        }
      });
  }

  private presentReadyDialog(update: SanitizedUpdate, force: boolean): void {
    if (!force && this.readyDialogVersion === update.version) return;
    if (this.readyDialogOpen) return;
    this.readyDialogVersion = update.version;
    this.readyDialogOpen = true;
    let decision: Promise<"later" | "restart"> | "later" | "restart";
    try {
      decision = this.ui.showReady(update);
    } catch {
      this.readyDialogOpen = false;
      this.reportError("install");
      return;
    }
    void Promise.resolve(decision)
      .then((decision) => {
        if (this.disposed || this.state.kind !== "ready" || this.state.update.version !== update.version) return;
        if (decision === "restart") void this.installUpdate();
      })
      .catch(() => this.reportError("install"))
      .finally(() => {
        this.readyDialogOpen = false;
      });
  }

  private async refreshAndMaybeDownload(selected: SanitizedUpdate): Promise<DownloadRefreshResult> {
    if (this.disposed) {
      return { result: { accepted: false, reason: "disposed" }, replacement: null };
    }
    if (this.state.kind !== "available" || this.state.update.version !== selected.version) {
      return { result: { accepted: false, reason: "not-available" }, replacement: null };
    }

    this.lastCheckSource = "manual";
    this.noUpdateNotified = false;
    this.errorNotified = false;
    const activeCheck: ActiveCheck = {
      generation: ++this.checkGeneration,
      kind: "download-refresh",
      selected,
      observed: null,
      failed: false,
    };
    this.activeCheck = activeCheck;
    const checkOperation = this.updater
      .checkForUpdates()
      .then(() => ({ accepted: true, coalesced: false }) as const)
      .catch(() => {
        this.failDownloadRefresh(activeCheck, "check");
        return { accepted: true, coalesced: false } as const;
      })
      .finally(() => {
        if (this.checkInFlight === checkOperation) this.checkInFlight = null;
        if (this.activeCheck?.generation === activeCheck.generation) this.activeCheck = null;
      });
    this.checkInFlight = checkOperation;
    await checkOperation;

    if (this.disposed) {
      return { result: { accepted: false, reason: "disposed" }, replacement: null };
    }
    if (activeCheck.failed || !activeCheck.observed) {
      if (!activeCheck.failed) this.reportError("check", true);
      return { result: { accepted: true, coalesced: false }, replacement: null };
    }
    if (this.state.kind !== "available" || this.state.update.version !== selected.version) {
      return { result: { accepted: false, reason: "not-available" }, replacement: null };
    }

    const comparison = compareVersions(activeCheck.observed.version, selected.version);
    if (comparison > 0) {
      this.setState({ kind: "available", update: activeCheck.observed });
      return {
        result: { accepted: true, coalesced: false },
        replacement: activeCheck.observed,
      };
    }
    if (comparison < 0) {
      this.reportError("invalid-update", true);
      return { result: { accepted: true, coalesced: false }, replacement: null };
    }

    this.errorNotified = false;
    this.setState({ kind: "downloading", update: selected, percent: 0 });
    const result = await this.updater
      .downloadUpdate()
      .then(() => ({ accepted: true, coalesced: false }) as const)
      .catch(() => {
        this.reportError("download");
        return { accepted: true, coalesced: false } as const;
      });
    return { result, replacement: null };
  }

  private failDownloadRefresh(
    activeCheck: Extract<ActiveCheck, { kind: "download-refresh" }>,
    phase: "check" | "invalid-update",
  ): void {
    if (activeCheck.failed) return;
    activeCheck.failed = true;
    this.reportError(phase, true);
  }

  private reportError(phase: UpdaterErrorPhase, preserveState = false): void {
    if (!this.canOperate()) return;
    const error = sanitizeUpdaterError(phase);
    if (!preserveState) this.setState({ kind: "error", error });
    if (this.errorNotified) return;
    // Background feed failures are non-fatal and should not interrupt work.
    const shouldShow = phase !== "check" || this.lastCheckSource === "manual";
    this.errorNotified = true;
    if (!shouldShow) return;
    try {
      this.ui.showError(error);
    } catch {
      // Error display failures are intentionally contained.
    }
  }
}
