/**
 * D420 — runtime maintenance authority (Wave 2 task 2.1.1 runtime seam).
 *
 * Wraps the {@link queries/maintenance.ts} store layer with the lease
 * policy: default renewable lease + hard expiry durations, a injectable
 * clock, and typed fail-closed operations. This is the seam the later
 * operator API (task 2.2.2) and drain polling (task 2.2.2) will call; it
 * deliberately owns NO HTTP route, NO polling loop, NO ingress gate, and
 * NO timeout-cancellation policy — those are later Wave 2 tasks.
 *
 * Fail-closed contract: every mutating operation requires the owning
 * `operationId` and refuses invalid / cross-owner / expired transitions
 * by throwing {@link MaintenanceTransitionError}. Abandoned or restored
 * `applying` state returns to `normal` via {@link recoverExpired} once
 * the hard expiry passes — recovering a dead CLI or a restored snapshot
 * without operator intervention (R10).
 */
import { randomUUID } from "node:crypto";
import {
  enterDrainingWith,
  transitionApplyingWith,
  renewLeaseWith,
  clearMaintenanceWith,
  recoverExpiredMaintenanceWith,
  getMaintenanceStateWith,
  MaintenanceTransitionError,
  type MaintenanceLeaseDurations,
  type MaintenanceSnapshot,
} from "@nautilo/db";
import type { DirectDatabase } from "@nautilo/db";
import type { MaintenanceActiveState } from "@nautilo/types";

/**
 * The maintenance store operations the controller drives. Injectable so
 * unit tests can run fail-closed / lease-math assertions without a live
 * DB; production wires the real `@nautilo/db` `*With` functions.
 */
export interface MaintenanceOps {
  enterDraining: typeof enterDrainingWith;
  transitionApplying: typeof transitionApplyingWith;
  renewLease: typeof renewLeaseWith;
  clearMaintenance: typeof clearMaintenanceWith;
  recoverExpired: typeof recoverExpiredMaintenanceWith;
  getState: typeof getMaintenanceStateWith;
}

const defaultOps: MaintenanceOps = {
  enterDraining: enterDrainingWith,
  transitionApplying: transitionApplyingWith,
  renewLease: renewLeaseWith,
  clearMaintenance: clearMaintenanceWith,
  recoverExpired: recoverExpiredMaintenanceWith,
  getState: getMaintenanceStateWith,
};

/**
 * Soft lease window for an owning drain/apply operation. Sized so a CLI
 * that finishes drain and then spends several minutes on pre-apply work
 * (source image build, backup prep) can still transition to `applying`
 * without renew — renew currently only runs inside the drain poll loop.
 */
export const DEFAULT_MAINTENANCE_LEASE_MS = 25 * 60_000;
/**
 * R10 — hard recovery ceiling. An abandoned CLI or a restored
 * `applying` snapshot is reclaimed once this elapses without renewal.
 * Generous by design: it must outlive any realistic drain + snapshot +
 * replace + health window so a healthy upgrade never self-aborts.
 */
export const DEFAULT_MAINTENANCE_HARD_MS = 30 * 60_000;

export interface MaintenanceControllerOptions {
  /** Direct DB handle (pool or tx). Required — no internal default pool. */
  db: DirectDatabase;
  /** Soft lease window; defaults to {@link DEFAULT_MAINTENANCE_LEASE_MS}. */
  leaseMs?: number;
  /** Hard recovery ceiling; defaults to {@link DEFAULT_MAINTENANCE_HARD_MS}. */
  hardMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Injectable store ops for hermetic unit tests. */
  ops?: MaintenanceOps;
}

export interface EnterDrainOptions {
  /** Owning operation id; generated when omitted. */
  operationId?: string;
  /** Per-call lease override (ms). */
  leaseMs?: number;
  /** Per-call hard-ceiling override (ms). */
  hardMs?: number;
}

export interface RenewOptions {
  /** Per-call lease override (ms). */
  leaseMs?: number;
}

export interface RecoverResult {
  recovered: boolean;
  snapshot: MaintenanceSnapshot;
}

export class MaintenanceController {
  private readonly handle: DirectDatabase;
  private readonly defaultLeaseMs: number;
  private readonly defaultHardMs: number;
  private readonly now: () => Date;
  private readonly ops: MaintenanceOps;

  constructor(opts: MaintenanceControllerOptions) {
    if (!opts.db) throw new Error("MaintenanceController requires a db handle");
    this.handle = opts.db;
    this.defaultLeaseMs = opts.leaseMs ?? DEFAULT_MAINTENANCE_LEASE_MS;
    this.defaultHardMs = opts.hardMs ?? DEFAULT_MAINTENANCE_HARD_MS;
    this.now = opts.now ?? (() => new Date());
    this.ops = opts.ops ?? defaultOps;
  }

  /** Current lease durations resolved for a call (per-call overrides win). */
  private durationsFor(opts: {
    leaseMs?: number;
    hardMs?: number;
  }): MaintenanceLeaseDurations {
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
    const hardMs = opts.hardMs ?? this.defaultHardMs;
    return { leaseMs, hardMs };
  }

  /**
   * Read the current maintenance snapshot. A hard-expired active lease is
   * reclaimed under the store's row lock before returning so abandoned CLI
   * state cannot block admission forever when no later upgrade attempts to
   * claim the row.
   */
  async getState(): Promise<MaintenanceSnapshot> {
    const snapshot = await this.ops.getState(this.handle);
    const now = this.now();
    const hardExpired =
      snapshot.state !== "normal" &&
      snapshot.hardExpiresAt !== null &&
      snapshot.hardExpiresAt.getTime() <= now.getTime();
    if (!hardExpired) return snapshot;
    return (await this.ops.recoverExpired(this.handle, now)).snapshot;
  }

  /**
   * `normal → draining`. Claims the lease for `operationId` (generated when
   * omitted), stamps lease + hard expiry. Fails closed if a live lease is
   * held by another operation; reclaims an expired lease first.
   */
  async enterDraining(opts: EnterDrainOptions = {}): Promise<MaintenanceSnapshot> {
    const operationId = opts.operationId ?? randomUUID();
    return this.ops.enterDraining(
      this.handle,
      operationId,
      this.durationsFor(opts),
      this.now(),
    );
  }

  /** `draining → applying`. Owning operation + live lease required. */
  async transitionApplying(operationId: string): Promise<MaintenanceSnapshot> {
    return this.ops.transitionApplying(this.handle, operationId, this.now());
  }

  /**
   * Renew the soft lease (capped at the hard ceiling). Owning operation +
   * unpassed hard ceiling required.
   */
  async renewLease(operationId: string, opts: RenewOptions = {}): Promise<MaintenanceSnapshot> {
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
    return this.ops.renewLease(this.handle, operationId, leaseMs, this.now());
  }

  /**
   * Release the lease back to `normal`. Called on both a healthy
   * completion and an explicit cancel. Owning operation required unless
   * already `normal` (idempotent no-op).
   */
  async complete(operationId: string): Promise<MaintenanceSnapshot> {
    return this.ops.clearMaintenance(this.handle, operationId, this.now());
  }

  /** Alias of {@link complete} for the explicit-cancel operator verb. */
  async cancel(operationId: string): Promise<MaintenanceSnapshot> {
    return this.complete(operationId);
  }

  /**
   * Reclaim an abandoned / restored lease past its hard expiry. The escape
   * hatch for a dead CLI or a restored `applying` snapshot (R10). Safe to
   * call on every status read or boot.
   */
  async recoverExpired(): Promise<RecoverResult> {
    return this.ops.recoverExpired(this.handle, this.now());
  }

  /** Convenience: is the server currently draining or applying? */
  async isActive(): Promise<boolean> {
    const s = await this.getState();
    return s.state !== "normal";
  }
}

export { MaintenanceTransitionError };

/**
 * D420 (Wave 2 task 2.2.1) — typed, retryable rejection thrown by the
 * maintenance gate when NEW executable work is refused because the durable
 * maintenance state is active (`draining` or `applying`). Carries the
 * machine-readable `code`/`retryable`/`maintenanceState` HTTP/API callers
 * poll on; the server renders it as a 503 {@link MaintenanceRejectionResponse}.
 *
 * Already-accepted work continuation paths present an
 * {@link MaintenanceAcceptanceAuthority} to the gate and never see this error.
 */
export class MaintenanceDrainError extends Error {
  readonly code = "maintenance_draining" as const;
  readonly retryable = true as const;
  readonly maintenanceState: MaintenanceActiveState;
  readonly statusCode = 503 as const;
  readonly publicError = "Service Unavailable" as const;
  constructor(state: MaintenanceActiveState, message?: string) {
    super(
      message ??
        `Server is in maintenance (${state}); new work is not being accepted. Retry shortly.`,
    );
    this.name = "MaintenanceDrainError";
    this.maintenanceState = state;
  }
}

/**
 * D420 — opaque authority carried through asynchronous conductor / task
 * continuation paths so the gate cannot reject a turn that was accepted
 * BEFORE drain began. Only an ingress that has just passed
 * {@link MaintenanceGate.assertAcceptingNewWork} mints one via
 * {@link createMaintenanceAcceptanceAuthority}; the brand makes it impossible
 * to forge by accident at a call site. The gate treats its presence as
 * "this work was accepted before drain; permit continuation."
 */
export interface MaintenanceAcceptanceAuthority {
  readonly __brand: "D420-accepted-before-drain";
}

/** Mint an authority token. Call ONLY after a successful acceptance check. */
export function createMaintenanceAcceptanceAuthority(): MaintenanceAcceptanceAuthority {
  return { __brand: "D420-accepted-before-drain" } as MaintenanceAcceptanceAuthority;
}

/**
 * D420 — the executable-work admission gate. This is the single seam every
 * NEW executable ingress (HTTP send, background job start, Task claim /
 * scheduled dispatch, coalescer enqueue) consults BEFORE work is persisted or
 * accepted. Continuation paths pass an {@link MaintenanceAcceptanceAuthority}
 * to bypass, so already-accepted work finishes during drain.
 *
 * `assertAcceptingNewWork` throws {@link MaintenanceDrainError} when the
 * durable state is active and no authority is presented. `isAcceptingWork` is
 * the non-throwing variant for pollers (the Task observer) that simply skip a
 * tick instead of surfacing an error.
 */
export interface MaintenanceGate {
  assertAcceptingNewWork(authority?: MaintenanceAcceptanceAuthority): Promise<void>;
  isAcceptingWork(): Promise<boolean>;
}

/**
 * D420 — hermetic default gate. Always accepts; never reads a DB. Used as the
 * `JobManager` constructor default so runtime unit tests stay DB-free, and as
 * the runtime singleton default before `setMaintenanceGate` wires production
 * at boot. Production NEVER runs against this gate: `createApp` installs a
 * {@link ProductionMaintenanceGate} before any route can accept work.
 */
export const permissiveMaintenanceGate: MaintenanceGate = {
  assertAcceptingNewWork: () => Promise.resolve(),
  isAcceptingWork: () => Promise.resolve(true),
};

/**
 * D420 — production gate backed by a real {@link MaintenanceController}.
 * `createApp` constructs that controller with the server's direct DB handle
 * before registering executable ingress. State-read failures propagate: an
 * unreadable durable state MUST NOT turn into an implicit permission to start
 * work during a drain.
 */
export class ProductionMaintenanceGate implements MaintenanceGate {
  constructor(private readonly controller: Pick<MaintenanceController, "getState">) {}

  async assertAcceptingNewWork(authority?: MaintenanceAcceptanceAuthority): Promise<void> {
    if (authority) return;
    const snapshot = await this.controller.getState();
    if (snapshot.state !== "normal") throw new MaintenanceDrainError(snapshot.state);
  }

  async isAcceptingWork(): Promise<boolean> {
    return (await this.controller.getState()).state === "normal";
  }
}

/**
 * D420 — runtime-wide gate singleton. Defaults to permissive (hermetic tests,
 * pre-boot). `createApp` calls {@link setMaintenanceGate} with a
 * {@link ProductionMaintenanceGate} at boot, before any route or the Task
 * observer can accept work. The `jobManager` singleton and the server dispatch
 * path resolve the gate at call time via {@link getMaintenanceGate}, so the
 * boot wiring takes effect for them without reconstructing the singleton.
 */
let runtimeMaintenanceGate: MaintenanceGate = permissiveMaintenanceGate;

export function getMaintenanceGate(): MaintenanceGate {
  return runtimeMaintenanceGate;
}

export function setMaintenanceGate(gate: MaintenanceGate): void {
  runtimeMaintenanceGate = gate;
}
