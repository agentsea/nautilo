/**
 * D447 — mutable activation state for a single tools-node invocation.
 *
 * The caller persists the two snapshots into the current-turn projection and
 * cross-turn leases. This handle deliberately has no knowledge of policy,
 * catalog eligibility, or whether a renewal is authorized: callers invoke
 * `renew` only after their own eligibility checks.
 */

/** Prevent a long-lived checkpoint from growing an unbounded tool schema set. */
export const MAX_ACTIVATED_TOOL_NAMES = 32;

/** The persisted config contract limits retention to this many owner turns. */
const MAX_ACTIVATED_TOOL_IDLE_TURNS = 20;

/** D447 — canonical cross-turn residency record. */
export interface ActivatedToolLease {
  name: string;
  idleTurns: number;
}

export interface ActivatedToolLeaseAdvanceInput {
  /** Current graph-turn projection. `undefined` is treated as empty. */
  names?: readonly string[];
  /**
   * Cross-turn metadata. `undefined` deliberately differs from `[]`: it
   * identifies a name-only legacy checkpoint eligible for one-time migration.
   */
  leases?: readonly ActivatedToolLease[] | undefined;
  /** Persisted sentinel that survives LangGraph's `[]` default for leases. */
  initialized?: boolean | undefined;
  agedForTurnId?: string;
  turnId: string;
  retentionTurns?: number;
  maxSize?: number;
}

export interface ActivatedToolLeaseAdvanceResult {
  names: string[];
  leases: ActivatedToolLease[];
  agedForTurnId: string;
  initialized: boolean;
}

export interface ActivatedToolsHandle {
  /** Adds current selection and an age-zero lease; false means capacity/full input rejection. */
  add(name: string): boolean;
  /** Renews one concrete lease; false means capacity/full input rejection. */
  renew(name: string): boolean;
  remove(name: string): void;
  clear(): void;
  snapshotNames(): string[];
  snapshotLeases(): ActivatedToolLease[];
  /** @deprecated Use `snapshotNames`; retained for existing callers. */
  snapshot(): string[];
}

function normalizedCapacity(maxSize: number): number {
  return Number.isFinite(maxSize) ? Math.max(0, Math.floor(maxSize)) : 0;
}

function normalizedName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedIdleTurns(value: unknown, maxIdleTurns: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), maxIdleTurns);
}

function isLease(value: unknown): value is { name?: unknown; idleTurns?: unknown } {
  return typeof value === "object" && value !== null;
}

/** Normalize a caller-provided retention count to the public contract range. */
function normalizeActivationRetentionTurns(retentionTurns = 3): number {
  return Number.isFinite(retentionTurns)
    ? Math.min(Math.max(0, Math.floor(retentionTurns)), MAX_ACTIVATED_TOOL_IDLE_TURNS)
    : 3;
}

/** Normalize checkpoint/input state to the durable activation capacity. */
export function normalizeActivatedToolNames(
  names: readonly string[] = [],
  maxSize = MAX_ACTIVATED_TOOL_NAMES,
): string[] {
  const capacity = normalizedCapacity(maxSize);
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const name of Array.isArray(names) ? names : []) {
    const trimmed = normalizedName(name);
    if (trimmed && !seen.has(trimmed) && normalized.length < capacity) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

/**
 * The activation checkpoint is owner-scoped even when a LangGraph thread is
 * shared. Catalog selection must therefore never read it as guest authority.
 */
export function selectedActivatedToolNamesForActor(
  actorRole: string | null | undefined,
  names: readonly string[] = [],
  maxSize = MAX_ACTIVATED_TOOL_NAMES,
): string[] {
  return actorRole === "guest" ? [] : normalizeActivatedToolNames(names, maxSize);
}

/** Normalize a checkpoint lease list to deterministic names, ages, and cap. */
export function normalizeActivatedToolLeases(
  leases: readonly ActivatedToolLease[] = [],
  maxSize = MAX_ACTIVATED_TOOL_NAMES,
): ActivatedToolLease[] {
  const capacity = normalizedCapacity(maxSize);
  const normalized: ActivatedToolLease[] = [];
  const seen = new Set<string>();

  for (const lease of Array.isArray(leases) ? leases : []) {
    if (!isLease(lease)) continue;
    const name = normalizedName(lease.name);
    if (name && !seen.has(name) && normalized.length < capacity) {
      seen.add(name);
      normalized.push({
        name,
        idleTurns: normalizedIdleTurns(lease.idleTurns, MAX_ACTIVATED_TOOL_IDLE_TURNS),
      });
    }
  }

  return normalized;
}

/**
 * Keeps a checkpoint activation snapshot within both the durable capacity and
 * the current actor's catalog-eligible set. This is intentionally applied
 * before persisting automatic selections: a shared graph thread must not
 * retain a name that this actor was not allowed to expose.
 */
export function normalizeEligibleActivatedToolNames(
  names: readonly string[] = [],
  eligibleNames: ReadonlySet<string>,
  maxSize = MAX_ACTIVATED_TOOL_NAMES,
): string[] {
  return normalizeActivatedToolNames(
    names.filter((name) => eligibleNames.has(name.trim())),
    maxSize,
  );
}

/**
 * Deterministically adds automatic intent selections after retained manual
 * activations. The single normalizer is the capacity authority for prompt,
 * provider, and next-node state.
 */
export function mergeEligibleActivatedToolNames(
  activatedNames: readonly string[] = [],
  intentNames: readonly string[] = [],
  eligibleNames: ReadonlySet<string>,
  maxSize = MAX_ACTIVATED_TOOL_NAMES,
): string[] {
  return normalizeEligibleActivatedToolNames(
    [...activatedNames, ...intentNames],
    eligibleNames,
    maxSize,
  );
}

/**
 * Advance cross-turn residency for one owner foreground turn.
 *
 * New turns age and prune leases, then rebuild the current-turn projection
 * from survivors. Repeating a turn preserves the existing current projection
 * so explicit activation and intent selection survive internal graph loops.
 * A missing initialization sentinel migrates a legacy name-only checkpoint at
 * age zero and stamps the turn without aging. The sentinel is needed because
 * LangGraph supplies `[]` for an absent lease channel, which would otherwise
 * erase the difference between legacy data and an explicit deactivation.
 */
export function advanceActivatedToolLeases(
  input: ActivatedToolLeaseAdvanceInput,
): ActivatedToolLeaseAdvanceResult {
  const capacity = normalizedCapacity(input.maxSize ?? MAX_ACTIVATED_TOOL_NAMES);
  const retentionTurns = normalizeActivationRetentionTurns(input.retentionTurns);
  const names = normalizeActivatedToolNames(input.names, capacity);
  const turnId = typeof input.turnId === "string" ? input.turnId : "";
  const agedForTurnId = typeof input.agedForTurnId === "string" ? input.agedForTurnId : "";
  const initialized = input.initialized === true;

  if (!initialized) {
    const leases = normalizeActivatedToolLeases(
      names.map((name) => ({ name, idleTurns: 0 })),
      capacity,
    );
    return {
      names: leases.map((lease) => lease.name),
      leases,
      agedForTurnId: turnId,
      initialized: true,
    };
  }

  // Stored ages are globally bounded at 20, independently of a runtime
  // retention setting that may later be lowered. Prune before the same-turn
  // early return so an over-age checkpoint can never reappear unchanged.
  const normalizedLeases = normalizeActivatedToolLeases(input.leases ?? [], capacity);
  const leases = normalizedLeases
    .filter((lease) => lease.idleTurns <= retentionTurns);
  const expiredNames = new Set(
    normalizedLeases
      .filter((lease) => lease.idleTurns > retentionTurns)
      .map((lease) => lease.name),
  );
  if (agedForTurnId === turnId) {
    return {
      names: names.filter((name) => !expiredNames.has(name)),
      leases,
      agedForTurnId,
      initialized: true,
    };
  }

  const advancedLeases = leases
    .map((lease) => ({ ...lease, idleTurns: lease.idleTurns + 1 }))
    .filter((lease) => lease.idleTurns <= retentionTurns);

  return {
    names: advancedLeases.map((lease) => lease.name),
    leases: advancedLeases,
    agedForTurnId: turnId,
    initialized: true,
  };
}

export function createActivatedToolsHandle(
  initial: readonly string[] = [],
  maxSize = MAX_ACTIVATED_TOOL_NAMES,
  initialLeases: readonly ActivatedToolLease[] = [],
  retentionTurns = MAX_ACTIVATED_TOOL_IDLE_TURNS,
): ActivatedToolsHandle {
  const capacity = normalizedCapacity(maxSize);
  // The handle retains the caller's configured count for its construction
  // contract, while persisted age normalization remains globally bounded.
  normalizeActivationRetentionTurns(retentionTurns);
  const names = new Set(normalizeActivatedToolNames(initial, capacity));
  const leases = normalizeActivatedToolLeases(initialLeases, capacity);

  const addOrRenew = (rawName: string): boolean => {
    const name = normalizedName(rawName);
    if (!name || (!names.has(name) && names.size >= capacity)) return false;

    const index = leases.findIndex((lease) => lease.name === name);
    if (index < 0 && leases.length >= capacity) return false;

    names.add(name);
    if (index >= 0) leases[index] = { name, idleTurns: 0 };
    else leases.push({ name, idleTurns: 0 });
    return true;
  };

  return {
    add(name: string) {
      return addOrRenew(name);
    },
    renew(name: string) {
      return addOrRenew(name);
    },
    remove(name: string) {
      const trimmed = normalizedName(name);
      names.delete(trimmed);
      const index = leases.findIndex((lease) => lease.name === trimmed);
      if (index >= 0) leases.splice(index, 1);
    },
    clear() {
      names.clear();
      leases.splice(0, leases.length);
    },
    snapshotNames() {
      return [...names];
    },
    snapshotLeases() {
      return leases.map((lease) => ({ ...lease }));
    },
    snapshot() {
      return [...names];
    },
  };
}
