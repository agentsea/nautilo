import { randomBytes } from "node:crypto";
import type { DesktopProvider } from "./contracts.ts";

/**
 * The locally-attested portion of a Computer use invocation.  This deliberately
 * mirrors the relay binding without accepting a model supplied context id.
 */
export interface ComputerUseContextScope {
  /** Server-issued opaque context for this admitted computer-use run. */
  readonly computerUseContextId: string;
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  /** Exact Electron-selected route that issued the server binding. */
  readonly provider: DesktopProvider;
  /** Opaque local route revision; provider state is never inferred from a context. */
  readonly providerGeneration: string;
  readonly originHumanId: string;
  readonly originRunId: string;
  readonly originAgentId: string;
  readonly lineageId: string;
  readonly serverBindingId: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
  readonly desktopSessionId: string;
}

export interface ComputerUseTargetEvidence {
  readonly kind: "app" | "window" | "element" | "screen";
  readonly appLabel?: string;
  readonly windowLabel?: string;
  readonly role?: string;
  /** A content-free precondition for a one-shot editable AX element. */
  readonly valueCondition?: "fresh_document_empty_or_unreadable";
  /** The only semantic mutation authorized by this role-selected target. */
  readonly action?: "set_value" | "scroll" | "click" | "right_click" | "double_click";
  readonly focused?: boolean;
  /** Observed application visibility; only app targets carry this fact. */
  readonly hidden?: boolean;
  readonly bounds?: Readonly<{ x: number; y: number; width: number; height: number }>;
}

/** Provider-only exact target data. This must never cross the tool boundary. */
export interface ComputerUseProviderTarget {
  readonly provider: "cua";
  /**
   * The one native operation this opaque target may authorize.
   */
  readonly operation: "focus" | "observe_only" | "type_text" | "set_value" | "scroll" | "click" | "right_click" | "double_click";
  readonly app?: string;
  readonly pid?: number;
  /** Exact provider bundle identifier, retained host-side only. */
  readonly bundleId?: string;
  readonly windowId?: number;
  readonly windowIndex?: number;
  /** Exact Cua AX capability. It is private host state, never receipt data. */
  readonly elementToken?: string;
  /** Private exact-window/selected-text-area frame signature; never a semantic target or receipt field. */
  readonly scrollFrameSignature?: Readonly<{
    window: Readonly<{ x: number; y: number; w: number; h: number }>;
    textArea: Readonly<{ x: number; y: number; w: number; h: number }>;
  }>;
  /** Set only by the atomic appeared-window handoff, never inferred by title. */
  readonly freshAppeared?: boolean;
}

export type ComputerUseScreenSnapshotMetadata =
  | Readonly<{
    format: "png";
    nativeDimensions: Readonly<{ width: number; height: number }>;
    presentedDimensions: Readonly<{ width: number; height: number }>;
    display: Readonly<{ coordinateSpace: "desktop_pixels"; origin: Readonly<{ x: number; y: number }> }>;
  }>
  | Readonly<{
    format: "png";
    dimensions: Readonly<{ width: number; height: number }>;
    coordinateSpace: "window_snapshot_pixels";
  }>;

/** Host-only provider geometry for an opaque screen snapshot capability. */
export type ComputerUseProviderScreenSnapshot =
  | Readonly<{ provider: "cua"; kind: "desktop"; nativeWidth: number; nativeHeight: number; screenWidth: number; screenHeight: number; scaleFactor: number }>
  | Readonly<{ provider: "cua"; kind: "window"; pid: number; windowId: number; width: number; height: number }>;

export interface RegisteredComputerScreenSnapshot {
  readonly reference: string;
  readonly evidence: Readonly<{ kind: "screen" }>;
  readonly metadata: ComputerUseScreenSnapshotMetadata;
}

export interface ComputerUseScreenSnapshotInput {
  readonly pngBytes: Uint8Array;
  readonly metadata: ComputerUseScreenSnapshotMetadata;
  readonly providerSnapshot: ComputerUseProviderScreenSnapshot;
}

export interface ComputerUseContextRegistryOptions {
  readonly clock?: () => number;
  readonly randomId?: () => string;
  readonly ttlMs?: number;
  readonly maxContexts?: number;
  /**
   * Compatibility override for each target class. Production defaults retain
   * 100 windows plus 64 separately-accounted apps.
   */
  readonly maxTargetsPerContext?: number;
}

/**
 * A provider bound can leave part of a desktop uninspected.  This is retained
 * with continuations so a later page never incorrectly upgrades a limited
 * first observation to "complete".
 */
export interface ComputerUseObservationCoverage {
  readonly uninspectedApplications: number;
  readonly knownUninspectedWindows: number;
  readonly windowCountExact: boolean;
}

export interface RegisteredComputerTarget {
  readonly reference: string;
  readonly evidence: ComputerUseTargetEvidence;
}

export type ContextRegistryResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: "not_found" | "expired" | "fenced" | "scope_mismatch" | "replay_forbidden" | "refresh_conflict" | "capacity_exhausted" | "external_interference" | "invalid" };

interface TargetRecord {
  readonly evidence: ComputerUseTargetEvidence;
  readonly providerTarget: ComputerUseProviderTarget;
}

interface ScreenSnapshotRecord {
  readonly evidence: Readonly<{ kind: "screen" }>;
  readonly metadata: ComputerUseScreenSnapshotMetadata;
  readonly providerSnapshot: ComputerUseProviderScreenSnapshot;
  readonly pngBytes: Buffer;
}

interface ContextRecord {
  readonly scope: ComputerUseContextScope;
  readonly createdAt: number;
  readonly expiresAt: number;
  /**
   * Replaced as one map when a launched application's windows are refreshed.
   * References issued before that refresh intentionally become stale; the app
   * capability itself remains the stable authority anchor for the refresh.
   */
  targets: Map<string, TargetRecord>;
  screenSnapshot: Readonly<{ reference: string; record: ScreenSnapshotRecord }> | null;
  readonly continuations: Map<string, readonly string[]>;
  /** Private launch-set accounting: retained candidates may be capped at 100. */
  applicationWindowCounts: Map<string, number>;
  /** Monotonic per-app revision prevents concurrent refreshes from revoking a newer result. */
  applicationWindowRevisions: Map<string, number>;
  readonly coverage: ComputerUseObservationCoverage | null;
  replayForbidden: boolean;
  /** Private monotonic Human-input epoch, never projected outside main. */
  humanInputEpochMilliseconds: number | null;
}

/**
 * Five minutes matches the Electron at-most-once invocation cache.  A target
 * reference is capability-like and must not outlive the retry/receipt window.
 */
const DEFAULT_TTL_MS = 5 * 60_000;
/**
 * Bounded local capability memory. The five-minute expiry is coupled to the
 * mutation idempotency window; a live context is never evicted to make room.
 */
const DEFAULT_MAX_CONTEXTS = 32;
/**
 * A context deliberately retains distinct bounded target classes: the
 * established 100 exact windows, plus up to 64 exact applications for
 * targeted application/window refresh. App references never consume window
 * capacity or evict a live window capability.
 */
const DEFAULT_MAX_WINDOW_TARGETS = 100;
const DEFAULT_MAX_APP_TARGETS = 64;

function sameScope(left: ComputerUseContextScope, right: ComputerUseContextScope): boolean {
  return left.computerUseContextId === right.computerUseContextId
    && left.installationEpoch === right.installationEpoch
    && left.grantGeneration === right.grantGeneration
    && left.provider === right.provider
    && left.providerGeneration === right.providerGeneration
    && left.originHumanId === right.originHumanId
    && left.originRunId === right.originRunId
    && left.originAgentId === right.originAgentId
    && left.lineageId === right.lineageId
    && left.serverBindingId === right.serverBindingId
    && left.relayId === right.relayId
    && left.pairingGeneration === right.pairingGeneration
    && left.desktopSessionId === right.desktopSessionId;
}

function sameAuthority(left: ComputerUseContextScope, right: Pick<ComputerUseContextScope, "installationEpoch" | "grantGeneration">): boolean {
  return left.installationEpoch === right.installationEpoch && left.grantGeneration === right.grantGeneration;
}

function defaultId(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Host-only, bounded context state. The model sees only dctx_/dtgt_/datgt_/
 * dsnap_/dcont_
 * references; provider identifiers remain in this registry until expiry.
 */
export class ComputerUseContextRegistry {
  private readonly contexts = new Map<string, ContextRecord>();
  /** In-flight observations reserve capacity before their provider boundary. */
  private readonly reservations = new Map<symbol, { readonly computerUseContextId: string }>();
  private readonly clock: () => number;
  private readonly randomId: () => string;
  private readonly ttlMs: number;
  private readonly maxContexts: number;
  private readonly maxWindowTargetsPerContext: number;
  private readonly maxAppTargetsPerContext: number;

  constructor(options: ComputerUseContextRegistryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.randomId = options.randomId ?? defaultId;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxContexts = options.maxContexts ?? DEFAULT_MAX_CONTEXTS;
    // Keep an explicit test/compatibility override deterministic while the
    // production default intentionally names the two independent budgets.
    this.maxWindowTargetsPerContext = options.maxTargetsPerContext ?? DEFAULT_MAX_WINDOW_TARGETS;
    this.maxAppTargetsPerContext = options.maxTargetsPerContext ?? DEFAULT_MAX_APP_TARGETS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0
      || !Number.isSafeInteger(this.maxContexts) || this.maxContexts <= 0
      || !Number.isSafeInteger(this.maxWindowTargetsPerContext) || this.maxWindowTargetsPerContext <= 0
      || !Number.isSafeInteger(this.maxAppTargetsPerContext) || this.maxAppTargetsPerContext <= 0) {
      throw new Error("computer-use context registry limits must be positive integers");
    }
  }

  private opaque(prefix: "dctx_" | "dtgt_" | "datgt_" | "detgt_" | "dsnap_" | "dcont_"): string {
    const suffix = this.randomId();
    if (!/^[A-Za-z0-9_-]{43}$/.test(suffix)) {
      throw new Error("computer-use context registry randomId must return 43 base64url characters");
    }
    return `${prefix}${suffix}`;
  }

  private isExpired(record: ContextRecord): boolean {
    return this.clock() >= record.expiresAt;
  }

  private dispose(record: ContextRecord): void {
    record.screenSnapshot?.record.pngBytes.fill(0);
  }

  private deleteContext(context: string): void {
    const record = this.contexts.get(context);
    if (record === undefined) return;
    this.contexts.delete(context);
    this.dispose(record);
  }

  /** Removes only expired data. Live capability references are never evicted. */
  cleanup(): void {
    for (const [id, record] of this.contexts) {
      if (this.isExpired(record)) this.deleteContext(id);
    }
  }

  /**
   * Reserve one future context before calling a provider. Reservations have no
   * time-based eviction: the owning observation always releases them in a
   * `finally`, so a live operation cannot be displaced by a later request.
   */
  reserveContext(scope: ComputerUseContextScope): ContextRegistryResult<{ readonly reservation: symbol }> {
    this.cleanup();
    const supersedesLiveContext = [...this.contexts.values()]
      .some((record) => record.scope.computerUseContextId === scope.computerUseContextId);
    if (this.contexts.size + this.reservations.size >= this.maxContexts && !supersedesLiveContext) {
      return { ok: false, code: "capacity_exhausted" };
    }
    const reservation = Symbol("computer-use-context");
    this.reservations.set(reservation, { computerUseContextId: scope.computerUseContextId });
    return { ok: true, data: { reservation } };
  }

  releaseContextReservation(reservation: symbol): void {
    this.reservations.delete(reservation);
  }

  createReserved(
    reservation: symbol,
    scope: ComputerUseContextScope,
    coverage: ComputerUseObservationCoverage | null = null,
  ): ContextRegistryResult<{ readonly context: string }> {
    const reserved = this.reservations.get(reservation);
    if (reserved === undefined || reserved.computerUseContextId !== scope.computerUseContextId) {
      return { ok: false, code: "invalid" };
    }
    this.reservations.delete(reservation);
    // A newer complete observation of this exact server-issued context wins
    // atomically. The old dctx/dtgt references become stale only after the new
    // provider result exists; a failed observation releases its reservation
    // and leaves every prior reference usable.
    for (const [context, record] of this.contexts) {
      if (record.scope.computerUseContextId === scope.computerUseContextId) this.deleteContext(context);
    }
    const context = this.opaque("dctx_");
    const now = this.clock();
    this.contexts.set(context, {
      scope,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      targets: new Map(),
      screenSnapshot: null,
      continuations: new Map(),
      applicationWindowCounts: new Map(),
      applicationWindowRevisions: new Map(),
      coverage,
      replayForbidden: false,
      humanInputEpochMilliseconds: null,
    });
    return { ok: true, data: { context } };
  }


  /**
   * Atomically commits a complete desktop observation. All opaque references,
   * target maps, and the defensive PNG copy are constructed before the prior
   * observation for the same server context is removed. A thrown/invalid
   * precommit leaves the prior context and its bytes untouched.
   */
  createReservedDesktopState(
    reservation: symbol,
    scope: ComputerUseContextScope,
    targets: readonly { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget }[],
    screenSnapshot: ComputerUseScreenSnapshotInput | null,
    coverage: ComputerUseObservationCoverage | null = null,
    continuationTargetRange: Readonly<{ start: number; end: number }> | null = null,
    humanInputEpochMilliseconds: number | null = null,
  ): ContextRegistryResult<{
    readonly context: string;
    readonly targets: readonly RegisteredComputerTarget[];
    readonly screenSnapshot: RegisteredComputerScreenSnapshot | null;
    readonly continuation: Readonly<{ reference: string }> | null;
  }> {
    const reserved = this.reservations.get(reservation);
    if (reserved === undefined || reserved.computerUseContextId !== scope.computerUseContextId) {
      return { ok: false, code: "invalid" };
    }
    const incomingApps = targets.filter((target) => target.evidence.kind === "app").length;
    const incomingWindows = targets.filter((target) => target.evidence.kind === "window").length;
    if (incomingApps > this.maxAppTargetsPerContext || incomingWindows > this.maxWindowTargetsPerContext) {
      return { ok: false, code: "invalid" };
    }

    if (humanInputEpochMilliseconds !== null && !Number.isFinite(humanInputEpochMilliseconds)) {
      return { ok: false, code: "invalid" };
    }
    const context = this.opaque("dctx_");
    const targetMap = new Map<string, TargetRecord>();
    const registeredTargets: RegisteredComputerTarget[] = [];
    for (const target of targets) {
      const reference = this.opaque(target.evidence.kind === "app" ? "datgt_" : target.evidence.kind === "element" ? "detgt_" : "dtgt_");
      if (targetMap.has(reference)) return { ok: false, code: "invalid" };
      targetMap.set(reference, { evidence: target.evidence, providerTarget: target.providerTarget });
      registeredTargets.push({ reference, evidence: target.evidence });
    }
    const snapshotReference = screenSnapshot === null ? null : this.opaque("dsnap_");
    if (continuationTargetRange !== null && (
      !Number.isSafeInteger(continuationTargetRange.start)
      || !Number.isSafeInteger(continuationTargetRange.end)
      || continuationTargetRange.start < 0
      || continuationTargetRange.end <= continuationTargetRange.start
      || continuationTargetRange.end > registeredTargets.length
    )) {
      return { ok: false, code: "invalid" };
    }
    const continuation = continuationTargetRange === null ? null : {
      reference: this.opaque("dcont_"),
      references: registeredTargets
        .slice(continuationTargetRange.start, continuationTargetRange.end)
        .map((target) => target.reference),
    };
    // Sensitive bytes are copied only after every fallible opaque reference
    // has been minted and every range validated.
    const snapshotRecord = screenSnapshot === null || snapshotReference === null ? null : {
      reference: snapshotReference,
      record: {
        evidence: { kind: "screen" } as const,
        metadata: "coordinateSpace" in screenSnapshot.metadata && screenSnapshot.metadata.coordinateSpace === "window_snapshot_pixels"
          ? { format: "png" as const, dimensions: { ...screenSnapshot.metadata.dimensions }, coordinateSpace: "window_snapshot_pixels" as const }
          : (() => {
            const desktop = screenSnapshot.metadata as Extract<ComputerUseScreenSnapshotMetadata, { readonly display: unknown }>;
            return {
            format: "png" as const,
            nativeDimensions: { ...desktop.nativeDimensions },
            presentedDimensions: { ...desktop.presentedDimensions },
            display: { coordinateSpace: "desktop_pixels" as const, origin: { ...desktop.display.origin } },
            };
          })(),
        providerSnapshot: { ...screenSnapshot.providerSnapshot },
        pngBytes: Buffer.from(screenSnapshot.pngBytes),
      },
    } satisfies Readonly<{ reference: string; record: ScreenSnapshotRecord }>;
    if (this.contexts.has(context)) {
      snapshotRecord?.record.pngBytes.fill(0);
      return { ok: false, code: "invalid" };
    }

    const now = this.clock();
    const record: ContextRecord = {
      scope,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      targets: targetMap,
      screenSnapshot: snapshotRecord,
      continuations: continuation === null
        ? new Map<string, readonly string[]>()
        : new Map<string, readonly string[]>([[continuation.reference, continuation.references]]),
      applicationWindowCounts: new Map(),
      applicationWindowRevisions: new Map(),
      coverage,
      replayForbidden: false,
      humanInputEpochMilliseconds,
    };
    this.contexts.set(context, record);
    this.reservations.delete(reservation);
    for (const [priorContext, prior] of this.contexts) {
      if (priorContext !== context && prior.scope.computerUseContextId === scope.computerUseContextId) {
        this.deleteContext(priorContext);
      }
    }
    return {
      ok: true,
      data: {
        context,
        targets: registeredTargets,
        screenSnapshot: snapshotRecord === null ? null : {
          reference: snapshotRecord.reference,
          evidence: snapshotRecord.record.evidence,
          metadata: snapshotRecord.record.metadata,
        },
        continuation: continuation === null ? null : { reference: continuation.reference },
      },
    };
  }

  /**
   * Atomically install the capability set minted by a successful app launch.
   * The provider call happens before this method; every fallible target mint
   * happens before the old context is withdrawn.  Consequently a failed
   * launch parse/commit never turns an earlier context into a dead reference.
   *
   * `windows` are retained privately for the subsequent app-scoped candidate
   * observation.  The caller decides whether the one unique window is placed
   * in its immediate receipt; this registry never leaks native identifiers.
   */
  createReservedLaunch(
    reservation: symbol,
    scope: ComputerUseContextScope,
    app: { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget },
    windows: readonly { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget }[],
    discoveredWindowCount: number = windows.length,
    humanInputEpochMilliseconds: number | null = null,
  ): ContextRegistryResult<{ readonly context: string; readonly app: RegisteredComputerTarget; readonly windows: readonly RegisteredComputerTarget[] }> {
    const reserved = this.reservations.get(reservation);
    const appTarget = app.providerTarget;
    if (reserved === undefined || reserved.computerUseContextId !== scope.computerUseContextId
      || app.evidence.kind !== "app" || app.evidence.appLabel === undefined
      || appTarget.provider !== "cua" || appTarget.operation !== "observe_only" || appTarget.pid === undefined || !Number.isSafeInteger(appTarget.pid) || appTarget.pid <= 0
      || appTarget.bundleId === undefined || appTarget.app !== app.evidence.appLabel
      || windows.some((window) => {
        const target = window.providerTarget;
        return window.evidence.kind !== "window" || window.evidence.appLabel !== app.evidence.appLabel
          || target.provider !== "cua" || target.operation !== "focus" || target.pid !== appTarget.pid
          || target.bundleId !== appTarget.bundleId || target.app !== appTarget.app || target.windowId === undefined || !Number.isSafeInteger(target.windowId) || target.windowId <= 0;
      })) {
      return { ok: false, code: "invalid" };
    }
    if (!Number.isSafeInteger(discoveredWindowCount) || discoveredWindowCount < windows.length
      || windows.length > this.maxWindowTargetsPerContext || this.maxAppTargetsPerContext < 1) {
      return { ok: false, code: "invalid" };
    }
    if (humanInputEpochMilliseconds !== null && !Number.isFinite(humanInputEpochMilliseconds)) {
      return { ok: false, code: "invalid" };
    }

    const context = this.opaque("dctx_");
    const targetMap = new Map<string, TargetRecord>();
    const appReference = this.opaque("datgt_");
    targetMap.set(appReference, { evidence: app.evidence, providerTarget: app.providerTarget });
    const registeredWindows: RegisteredComputerTarget[] = [];
    for (const window of windows) {
      const reference = this.opaque("dtgt_");
      if (targetMap.has(reference)) return { ok: false, code: "invalid" };
      targetMap.set(reference, { evidence: window.evidence, providerTarget: window.providerTarget });
      registeredWindows.push({ reference, evidence: window.evidence });
    }
    if (this.contexts.has(context)) return { ok: false, code: "invalid" };

    const now = this.clock();
    const next: ContextRecord = {
      scope,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      targets: targetMap,
      screenSnapshot: null,
      continuations: new Map(),
      applicationWindowCounts: new Map([[appReference, discoveredWindowCount]]),
      applicationWindowRevisions: new Map([[appReference, 0]]),
      coverage: null,
      replayForbidden: false,
      humanInputEpochMilliseconds,
    };
    // One map swap is the commit point. Only after it succeeds can the prior
    // same-server context be removed.
    this.contexts.set(context, next);
    this.reservations.delete(reservation);
    for (const [priorContext, prior] of this.contexts) {
      if (priorContext !== context && prior.scope.computerUseContextId === scope.computerUseContextId) {
        this.deleteContext(priorContext);
      }
    }
    return { ok: true, data: { context, app: { reference: appReference, evidence: app.evidence }, windows: registeredWindows } };
  }

  create(
    scope: ComputerUseContextScope,
    coverage: ComputerUseObservationCoverage | null = null,
  ): ContextRegistryResult<{ readonly context: string }> {
    const reserved = this.reserveContext(scope);
    return reserved.ok
      ? this.createReserved(reserved.data.reservation, scope, coverage)
      : reserved;
  }

  /**
   * Atomically mint the one post-mutation window capability from a complete
   * native-set delta.  It deliberately creates a new dctx_ and withdraws the
   * invoking context at the single map-swap point: a menu action is never
   * followed by a stale-baseline observation in the same context.
   */
  createAppearedWindowContext(
    scope: ComputerUseContextScope,
    humanInputEpochMilliseconds: number,
    app: { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget },
    window: { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget },
  ): ContextRegistryResult<{ readonly context: string; readonly app: RegisteredComputerTarget; readonly window: RegisteredComputerTarget }> {
    const appTarget = app.providerTarget;
    const target = window.providerTarget;
    if (!Number.isFinite(humanInputEpochMilliseconds)
      || app.evidence.kind !== "app" || app.evidence.appLabel === undefined || appTarget.provider !== "cua" || appTarget.operation !== "observe_only"
      || appTarget.pid === undefined || !Number.isSafeInteger(appTarget.pid) || appTarget.pid <= 0
      || appTarget.bundleId === undefined || appTarget.app !== app.evidence.appLabel
      || window.evidence.kind !== "window" || target.provider !== "cua" || target.operation !== "focus"
      || target.pid === undefined || !Number.isSafeInteger(target.pid) || target.pid <= 0
      || target.windowId === undefined || !Number.isSafeInteger(target.windowId) || target.windowId <= 0
      || target.pid !== appTarget.pid || target.bundleId !== appTarget.bundleId || target.app !== appTarget.app) {
      return { ok: false, code: "invalid" };
    }
    const context = this.opaque("dctx_");
    const appReference = this.opaque("datgt_");
    const reference = this.opaque("dtgt_");
    if (this.contexts.has(context)) return { ok: false, code: "invalid" };
    const now = this.clock();
    const targets = new Map<string, TargetRecord>([
      [appReference, { evidence: app.evidence, providerTarget: app.providerTarget }],
      [reference, { evidence: window.evidence, providerTarget: window.providerTarget }],
    ]);
    this.contexts.set(context, {
      scope,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      targets,
      screenSnapshot: null,
      continuations: new Map(),
      applicationWindowCounts: new Map([[appReference, 1]]),
      applicationWindowRevisions: new Map([[appReference, 0]]),
      coverage: null,
      replayForbidden: false,
      humanInputEpochMilliseconds,
    });
    for (const [priorContext, prior] of this.contexts) {
      if (priorContext !== context && prior.scope.computerUseContextId === scope.computerUseContextId) {
        this.deleteContext(priorContext);
      }
    }
    return { ok: true, data: {
      context,
      app: { reference: appReference, evidence: app.evidence },
      window: { reference, evidence: window.evidence },
    } };
  }

  /** Advance a context-private Human-input epoch or fence its entire run. */
  advanceHumanInputEpoch(
    context: string,
    scope: ComputerUseContextScope,
    currentEpochMilliseconds: number,
    changeToleranceMilliseconds: number,
  ): ContextRegistryResult<void> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (!Number.isFinite(currentEpochMilliseconds)
      || !Number.isFinite(changeToleranceMilliseconds) || changeToleranceMilliseconds < 0) {
      return { ok: false, code: "invalid" };
    }
    const prior = found.data.humanInputEpochMilliseconds;
    if (prior !== null && currentEpochMilliseconds > prior + changeToleranceMilliseconds) {
      for (const [candidateContext, candidate] of this.contexts) {
        if (candidate.scope.computerUseContextId === scope.computerUseContextId) this.deleteContext(candidateContext);
      }
      return { ok: false, code: "external_interference" };
    }
    found.data.humanInputEpochMilliseconds = currentEpochMilliseconds;
    return { ok: true, data: undefined };
  }

  private get(context: string, scope: ComputerUseContextScope): ContextRegistryResult<ContextRecord> {
    const record = this.contexts.get(context);
    if (record === undefined) return { ok: false, code: "not_found" };
    if (this.isExpired(record)) {
      this.deleteContext(context);
      return { ok: false, code: "expired" };
    }
    if (!sameScope(record.scope, scope)) return { ok: false, code: "scope_mismatch" };
    return { ok: true, data: record };
  }

  registerTargets(
    context: string,
    scope: ComputerUseContextScope,
    targets: readonly { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget }[],
  ): ContextRegistryResult<readonly RegisteredComputerTarget[]> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    const current = [...found.data.targets.values()];
    const currentApps = current.filter((target) => target.evidence.kind === "app").length;
    // Element capabilities are separately bounded by their owning window's
    // lifetime, not counted as windows.  Otherwise an AX text capability
    // would both exhaust the 100-window limit and receive a misleading dtgt_.
    const currentWindows = current.filter((target) => target.evidence.kind === "window").length;
    const incomingApps = targets.filter((target) => target.evidence.kind === "app").length;
    const incomingWindows = targets.filter((target) => target.evidence.kind === "window").length;
    if (currentApps + incomingApps > this.maxAppTargetsPerContext
      || currentWindows + incomingWindows > this.maxWindowTargetsPerContext) {
      return { ok: false, code: "invalid" };
    }
    const registered: RegisteredComputerTarget[] = [];
    for (const target of targets) {
      if (target.evidence.kind === "element") {
        // Every fresh get_window_state snapshot invalidates the prior Cua
        // element-token generation for this exact window. Retire any older
        // public detgt_ rather than leave a capability that can only stale.
        for (const [reference, existing] of found.data.targets) {
          if (existing.evidence.kind === "element"
            && existing.providerTarget.provider === target.providerTarget.provider
            && existing.providerTarget.pid === target.providerTarget.pid
            && existing.providerTarget.windowId === target.providerTarget.windowId) {
            found.data.targets.delete(reference);
          }
        }
      }
      const reference = this.opaque(
        target.evidence.kind === "app" ? "datgt_"
          : target.evidence.kind === "element" ? "detgt_"
            : "dtgt_",
      );
      found.data.targets.set(reference, { evidence: target.evidence, providerTarget: target.providerTarget });
      registered.push({ reference, evidence: target.evidence });
    }
    return { ok: true, data: registered };
  }

  /** Replace the one private image capability without disturbing its exact window target. */
  registerWindowSnapshot(
    context: string,
    scope: ComputerUseContextScope,
    snapshot: ComputerUseScreenSnapshotInput,
  ): ContextRegistryResult<RegisteredComputerScreenSnapshot> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (found.data.replayForbidden || !("coordinateSpace" in snapshot.metadata) || snapshot.metadata.coordinateSpace !== "window_snapshot_pixels"
      || snapshot.providerSnapshot.kind !== "window") return { ok: false, code: "invalid" };
    const reference = this.opaque("dsnap_");
    const record: ScreenSnapshotRecord = {
      evidence: { kind: "screen" },
      metadata: { format: "png", dimensions: { ...snapshot.metadata.dimensions }, coordinateSpace: "window_snapshot_pixels" },
      providerSnapshot: { ...snapshot.providerSnapshot },
      pngBytes: Buffer.from(snapshot.pngBytes),
    };
    found.data.screenSnapshot?.record.pngBytes.fill(0);
    found.data.screenSnapshot = { reference, record };
    return { ok: true, data: { reference, evidence: record.evidence, metadata: record.metadata } };
  }

  mintContinuation(
    context: string,
    scope: ComputerUseContextScope,
    references: readonly string[],
  ): ContextRegistryResult<{ readonly reference: string }> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (!references.every((reference) => found.data.targets.has(reference))) {
      return { ok: false, code: "invalid" };
    }
    const reference = this.opaque("dcont_");
    found.data.continuations.set(reference, [...references]);
    return { ok: true, data: { reference } };
  }

  redeemContinuation(
    context: string,
    scope: ComputerUseContextScope,
    continuation: string,
  ): ContextRegistryResult<{ readonly targets: readonly RegisteredComputerTarget[]; readonly coverage: ComputerUseObservationCoverage | null }> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    const references = found.data.continuations.get(continuation);
    if (references === undefined) return { ok: false, code: "not_found" };
    // Continuations are deliberately single-use. A caller which needs a later
    // page receives a newly minted continuation, so repeated redemption cannot
    // retain unbounded continuation state in a live context.
    found.data.continuations.delete(continuation);
    const targets: RegisteredComputerTarget[] = [];
    for (const reference of references) {
      const target = found.data.targets.get(reference);
      if (target === undefined) return { ok: false, code: "invalid" };
      targets.push({ reference, evidence: target.evidence });
    }
    return { ok: true, data: { targets, coverage: found.data.coverage } };
  }

  resolveTarget(
    context: string,
    scope: ComputerUseContextScope,
    reference: string,
  ): ContextRegistryResult<{ readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget }> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (found.data.replayForbidden) return { ok: false, code: "replay_forbidden" };
    const target = found.data.targets.get(reference);
    return target === undefined ? { ok: false, code: "not_found" } : { ok: true, data: target };
  }

  /** Whether this exact native window already owns an unconsumed AX token. */
  hasElementTargetForWindow(
    context: string,
    scope: ComputerUseContextScope,
    pid: number,
    windowId: number,
  ): ContextRegistryResult<boolean> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (found.data.replayForbidden) return { ok: false, code: "replay_forbidden" };
    for (const target of found.data.targets.values()) {
      if (target.evidence.kind === "element"
        && target.providerTarget.provider === "cua"
        && target.providerTarget.pid === pid
        && target.providerTarget.windowId === windowId) return { ok: true, data: true };
    }
    return { ok: true, data: false };
  }

  /** Claim one private AX token capability before its non-idempotent use. */
  claimElementTarget(
    context: string,
    scope: ComputerUseContextScope,
    reference: string,
  ): ContextRegistryResult<{ readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget }> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (found.data.replayForbidden) return { ok: false, code: "replay_forbidden" };
    const target = found.data.targets.get(reference);
    if (target === undefined || target.evidence.kind !== "element" || target.providerTarget.provider !== "cua"
      || (target.providerTarget.operation !== "type_text" && target.providerTarget.operation !== "set_value" && target.providerTarget.operation !== "scroll"
        && target.providerTarget.operation !== "click" && target.providerTarget.operation !== "right_click" && target.providerTarget.operation !== "double_click")
      || target.providerTarget.elementToken === undefined) {
      return { ok: false, code: "not_found" };
    }
    found.data.targets.delete(reference);
    return { ok: true, data: target };
  }

  /** Consume the one fresh-appeared eligibility before minting an AX writer. */
  claimFreshAppearedWindow(
    context: string,
    scope: ComputerUseContextScope,
    reference: string,
  ): ContextRegistryResult<void> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    const target = found.data.targets.get(reference);
    if (target === undefined || target.evidence.kind !== "window" || target.providerTarget.freshAppeared !== true) {
      return { ok: false, code: "not_found" };
    }
    found.data.targets.set(reference, {
      evidence: target.evidence,
      providerTarget: { ...target.providerTarget, freshAppeared: false },
    });
    return { ok: true, data: undefined };
  }

  /** Returns only windows from the already-selected app's launch context. */
  resolveApplicationWindows(
    context: string,
    scope: ComputerUseContextScope,
    appReference: string,
  ): ContextRegistryResult<Readonly<{ targets: readonly RegisteredComputerTarget[]; discovered: number; revision: number }>> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (found.data.replayForbidden) return { ok: false, code: "replay_forbidden" };
    const app = found.data.targets.get(appReference);
    if (app === undefined || app.evidence.kind !== "app" || app.providerTarget.provider !== "cua" || app.providerTarget.bundleId === undefined) {
      return { ok: false, code: "not_found" };
    }
    const windows: RegisteredComputerTarget[] = [];
    for (const [reference, target] of found.data.targets) {
      if (target.evidence.kind !== "window" || target.providerTarget.provider !== "cua") continue;
      if (target.providerTarget.bundleId === app.providerTarget.bundleId) {
        windows.push({ reference, evidence: target.evidence });
      }
    }
    return {
      ok: true,
      data: {
        targets: windows,
        discovered: found.data.applicationWindowCounts.get(appReference) ?? windows.length,
        revision: found.data.applicationWindowRevisions.get(appReference) ?? 0,
      },
    };
  }

  /**
   * Atomically replace only one launched application's retained window set.
   *
   * Cua can truthfully report a running process before AppKit has published an
   * ordinary window.  A later app-scoped observation therefore must not be a
   * frozen projection of the launch response.  The app reference stays stable
   * (it is the capability the caller presented); every old window reference is
   * withdrawn and freshly observed windows receive new opaque references.
   */
  refreshApplicationWindows(
    context: string,
    scope: ComputerUseContextScope,
    appReference: string,
    windows: readonly { readonly evidence: ComputerUseTargetEvidence; readonly providerTarget: ComputerUseProviderTarget }[],
    expectedRevision: number,
    discoveredWindowCount: number = windows.length,
  ): ContextRegistryResult<Readonly<{ targets: readonly RegisteredComputerTarget[]; discovered: number }>> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (found.data.replayForbidden) return { ok: false, code: "replay_forbidden" };
    const app = found.data.targets.get(appReference);
    if (app === undefined || app.evidence.kind !== "app" || app.providerTarget.provider !== "cua"
      || app.providerTarget.operation !== "observe_only" || app.providerTarget.pid === undefined
      || app.providerTarget.bundleId === undefined || app.providerTarget.app !== app.evidence.appLabel) {
      return { ok: false, code: "not_found" };
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || (found.data.applicationWindowRevisions.get(appReference) ?? 0) !== expectedRevision) {
      return { ok: false, code: "refresh_conflict" };
    }
    if (!Number.isSafeInteger(discoveredWindowCount) || discoveredWindowCount < windows.length
      || windows.length > this.maxWindowTargetsPerContext) return { ok: false, code: "invalid" };
    const bundleId = app.providerTarget.bundleId;
    const pid = app.providerTarget.pid;
    if (windows.some((window) => {
      const target = window.providerTarget;
      return window.evidence.kind !== "window" || window.evidence.appLabel !== app.evidence.appLabel
        || target.provider !== "cua" || target.operation !== "focus" || target.pid !== pid
        || target.bundleId !== bundleId || target.app !== app.evidence.appLabel
        || target.windowId === undefined || !Number.isSafeInteger(target.windowId) || target.windowId <= 0;
    })) return { ok: false, code: "invalid" };

    const nextTargets = new Map(found.data.targets);
    for (const [reference, target] of nextTargets) {
      if (target.evidence.kind === "window" && target.providerTarget.provider === "cua"
        && target.providerTarget.pid === pid && target.providerTarget.bundleId === bundleId) {
        nextTargets.delete(reference);
      }
    }
    const remainingWindowCount = [...nextTargets.values()].filter((target) => target.evidence.kind !== "app").length;
    if (remainingWindowCount + windows.length > this.maxWindowTargetsPerContext) return { ok: false, code: "invalid" };
    const registered: RegisteredComputerTarget[] = [];
    for (const window of windows) {
      const reference = this.opaque("dtgt_");
      if (nextTargets.has(reference)) return { ok: false, code: "invalid" };
      nextTargets.set(reference, { evidence: window.evidence, providerTarget: window.providerTarget });
      registered.push({ reference, evidence: window.evidence });
    }
    const nextCounts = new Map(found.data.applicationWindowCounts);
    nextCounts.set(appReference, discoveredWindowCount);
    const nextRevisions = new Map(found.data.applicationWindowRevisions);
    nextRevisions.set(appReference, expectedRevision + 1);
    // Both reference map and accounting become visible at one commit point.
    found.data.targets = nextTargets;
    found.data.applicationWindowCounts = nextCounts;
    found.data.applicationWindowRevisions = nextRevisions;
    return { ok: true, data: { targets: registered, discovered: discoveredWindowCount } };
  }

  resolveScreenSnapshot(
    context: string,
    scope: ComputerUseContextScope,
    reference: string,
  ): ContextRegistryResult<{
    readonly evidence: Readonly<{ kind: "screen" }>;
    readonly metadata: ComputerUseScreenSnapshotMetadata;
    readonly providerSnapshot: ComputerUseProviderScreenSnapshot;
    readonly pngBytes: Buffer;
  }> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    if (found.data.replayForbidden) return { ok: false, code: "replay_forbidden" };
    const snapshot = found.data.screenSnapshot;
    if (snapshot === null || snapshot.reference !== reference) return { ok: false, code: "not_found" };
    return {
      ok: true,
      data: {
        evidence: snapshot.record.evidence,
        metadata: snapshot.record.metadata,
        providerSnapshot: snapshot.record.providerSnapshot,
        pngBytes: Buffer.from(snapshot.record.pngBytes),
      },
    };
  }

  /** A timed-out/lost mutation may have happened. No action may reuse this context. */
  markUnknownCompletion(context: string, scope: ComputerUseContextScope): ContextRegistryResult<void> {
    const found = this.get(context, scope);
    if (!found.ok) return found;
    found.data.replayForbidden = true;
    return { ok: true, data: undefined };
  }

  /** Synchronous local revoke fence for every context in this exact authority generation. */
  fence(authority: Pick<ComputerUseContextScope, "installationEpoch" | "grantGeneration">): void {
    for (const [context, record] of this.contexts) {
      if (sameAuthority(record.scope, authority)) this.deleteContext(context);
    }
  }

  clear(): void {
    for (const context of [...this.contexts.keys()]) this.deleteContext(context);
    this.reservations.clear();
  }
}
