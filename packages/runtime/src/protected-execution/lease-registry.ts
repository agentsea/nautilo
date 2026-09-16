import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  destroyProtectedInvocationCapability,
  inspectProtectedInvocationCapability,
  type ProtectedInvocationCapability,
  type ProtectedInvocationCapabilityDescription,
  type ProtectedInvocationLease,
} from "@nautilo/lattice-bridge";

export const MAX_LIVE_PROTECTED_INVOCATIONS = 256;
export const MAX_PROTECTED_CHILD_INVOCATIONS = 16;
const MAX_PROTECTED_SWEEP_INTERVAL_MS = 30_000;

export interface ProtectedInvocationCapabilityPort {
  readonly inspect: (
    capability: ProtectedInvocationCapability,
  ) => ProtectedInvocationCapabilityDescription | null;
  readonly destroy: (capability: ProtectedInvocationCapability) => void;
}

const bridgeCapabilityPort: ProtectedInvocationCapabilityPort = Object.freeze({
  inspect: inspectProtectedInvocationCapability,
  destroy: destroyProtectedInvocationCapability,
});

type LeaseEntry = {
  readonly capability: ProtectedInvocationCapability;
  readonly description: ProtectedInvocationCapabilityDescription;
  readonly effectiveExpiresAt: number;
  readonly parentLease: ProtectedInvocationLease | null;
  readonly childLeases: Set<ProtectedInvocationLease>;
  status: "ready" | "running";
};

export type ProtectedInvocationRegistrationReason =
  | "capability_invalid"
  | "capability_expired"
  | "capability_in_use"
  | "lease_id_invalid"
  | "process_capacity"
  | "parent_unavailable"
  | "child_capacity"
  | "child_scope_widened"
  | "registry_closed";

export type ProtectedInvocationRegistration =
  | Readonly<{
    readonly status: "registered";
    readonly lease: ProtectedInvocationLease;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedInvocationRegistrationReason;
  }>;

export type ProtectedInvocationRunReason =
  | "lease_unavailable"
  | "lease_expired"
  | "lease_in_use"
  | "lease_cancelled"
  | "execution_failed";

export type ProtectedInvocationRunResult<Value> =
  | Readonly<{
    readonly status: "executed";
    readonly value: Value;
  }>
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: ProtectedInvocationRunReason;
  }>;

export interface ProtectedInvocationLeaseRegistryOptions {
  readonly capabilityPort?: ProtectedInvocationCapabilityPort;
  readonly createLeaseId?: () => string;
  readonly now?: () => number;
  readonly startSweep?: boolean;
  readonly sweepIntervalMs?: number;
}

function unavailableRegistration(
  reason: ProtectedInvocationRegistrationReason,
): ProtectedInvocationRegistration {
  return Object.freeze({ status: "unavailable", reason });
}

function unavailableRun(
  reason: ProtectedInvocationRunReason,
): ProtectedInvocationRunResult<never> {
  return Object.freeze({ status: "unavailable", reason });
}

function isCanonicalIds(values: readonly string[]): boolean {
  if (!Array.isArray(values) || values.length === 0) return false;
  return values.every((value, index) =>
    typeof value === "string"
    && value.length > 0
    && (index === 0 || values[index - 1]! < value)
  );
}

function isDescription(
  value: ProtectedInvocationCapabilityDescription,
): boolean {
  return typeof value.invocationId === "string"
    && value.invocationId.length > 0
    && typeof value.grantId === "string"
    && value.grantId.length > 0
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt >= 0
    && Number.isSafeInteger(value.issuedAt)
    && value.issuedAt >= 0
    && value.issuedAt < value.expiresAt
    && typeof value.issuingHumanId === "string"
    && value.issuingHumanId.length > 0
    && typeof value.issuingDeviceId === "string"
    && value.issuingDeviceId.length > 0
    && typeof value.recipientAgentId === "string"
    && value.recipientAgentId.length > 0
    && typeof value.recipientKeyId === "string"
    && value.recipientKeyId.length > 0
    && isCanonicalIds(value.namespaceIds)
    && isCanonicalIds(value.domainIds);
}

function snapshotDescription(
  value: ProtectedInvocationCapabilityDescription,
): ProtectedInvocationCapabilityDescription | null {
  if (!isDescription(value)) return null;
  if (
    value.namespaceIds.length > MAX_LIVE_PROTECTED_INVOCATIONS
    || value.domainIds.length > MAX_LIVE_PROTECTED_INVOCATIONS
  ) {
    return null;
  }
  return Object.freeze({
    invocationId: value.invocationId,
    grantId: value.grantId,
    expiresAt: value.expiresAt,
    issuedAt: value.issuedAt,
    issuingHumanId: value.issuingHumanId,
    issuingDeviceId: value.issuingDeviceId,
    recipientAgentId: value.recipientAgentId,
    recipientKeyId: value.recipientKeyId,
    namespaceIds: Object.freeze([...value.namespaceIds]),
    domainIds: Object.freeze([...value.domainIds]),
  });
}

function isSubset(
  child: readonly string[],
  parent: readonly string[],
): boolean {
  const parentValues = new Set(parent);
  return child.every((value) => parentValues.has(value));
}

export class ProtectedInvocationLeaseRegistry {
  readonly #capabilityPort: ProtectedInvocationCapabilityPort;
  readonly #createLeaseId: () => string;
  readonly #now: () => number;
  readonly #entries = new Map<ProtectedInvocationLease, LeaseEntry>();
  readonly #registeredCapabilities = new WeakSet<object>();
  readonly #currentLeaseStorage =
    new AsyncLocalStorage<ProtectedInvocationLease>();
  readonly #timer: ReturnType<typeof setInterval> | null;
  readonly #leaseIds = new Set<string>();
  #closed = false;

  constructor(options: ProtectedInvocationLeaseRegistryOptions = {}) {
    this.#capabilityPort = options.capabilityPort ?? bridgeCapabilityPort;
    this.#createLeaseId = options.createLeaseId ?? randomUUID;
    this.#now = options.now ?? Date.now;

    const sweepIntervalMs =
      options.sweepIntervalMs ?? MAX_PROTECTED_SWEEP_INTERVAL_MS;
    if (
      !Number.isSafeInteger(sweepIntervalMs)
      || sweepIntervalMs <= 0
      || sweepIntervalMs > MAX_PROTECTED_SWEEP_INTERVAL_MS
    ) {
      throw new TypeError(
        "Protected invocation sweep interval must be within 1..30000ms",
      );
    }
    if (options.startSweep === false) {
      this.#timer = null;
    } else {
      this.#timer = setInterval(() => {
        this.sweep();
      }, sweepIntervalMs);
      this.#timer.unref?.();
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  register(input: Readonly<{
    readonly capability: ProtectedInvocationCapability;
    readonly executionDeadline?: number;
    readonly parentLease?: ProtectedInvocationLease;
  }>): ProtectedInvocationRegistration {
    if (this.#closed) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("registry_closed");
    }
    this.sweep();

    const inspected = this.#capabilityPort.inspect(input.capability);
    if (inspected === null) {
      return unavailableRegistration("capability_invalid");
    }
    const description = snapshotDescription(inspected);
    if (description === null) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("capability_invalid");
    }
    if (this.#registeredCapabilities.has(input.capability)) {
      return unavailableRegistration("capability_in_use");
    }

    const now = this.#now();
    const requestedDeadline = input.executionDeadline ?? description.expiresAt;
    if (
      !Number.isSafeInteger(requestedDeadline)
      || requestedDeadline < 0
    ) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("capability_invalid");
    }

    let parentEntry: LeaseEntry | null = null;
    let parentLease: ProtectedInvocationLease | null = null;
    if (input.parentLease !== undefined) {
      parentLease = input.parentLease;
      parentEntry = this.#entries.get(parentLease) ?? null;
      if (parentEntry === null || parentEntry.effectiveExpiresAt <= now) {
        this.#capabilityPort.destroy(input.capability);
        return unavailableRegistration("parent_unavailable");
      }
      if (
        parentEntry.childLeases.size >= MAX_PROTECTED_CHILD_INVOCATIONS
      ) {
        this.#capabilityPort.destroy(input.capability);
        return unavailableRegistration("child_capacity");
      }
      if (
        !isSubset(
          description.namespaceIds,
          parentEntry.description.namespaceIds,
        )
        || !isSubset(
          description.domainIds,
          parentEntry.description.domainIds,
        )
      ) {
        this.#capabilityPort.destroy(input.capability);
        return unavailableRegistration("child_scope_widened");
      }
    }

    const effectiveExpiresAt = Math.min(
      description.expiresAt,
      requestedDeadline,
      parentEntry?.effectiveExpiresAt ?? Number.MAX_SAFE_INTEGER,
    );
    if (effectiveExpiresAt <= now) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("capability_expired");
    }
    if (this.#entries.size >= MAX_LIVE_PROTECTED_INVOCATIONS) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("process_capacity");
    }

    const leaseId = this.#createLeaseId();
    if (
      typeof leaseId !== "string"
      || leaseId.length === 0
      || this.#leaseIds.has(leaseId)
    ) {
      this.#capabilityPort.destroy(input.capability);
      return unavailableRegistration("lease_id_invalid");
    }
    const lease = Object.freeze({
      invocationId: description.invocationId,
      leaseId,
    }) as ProtectedInvocationLease;
    const entry: LeaseEntry = {
      capability: input.capability,
      description,
      effectiveExpiresAt,
      parentLease,
      childLeases: new Set(),
      status: "ready",
    };
    this.#entries.set(lease, entry);
    this.#registeredCapabilities.add(input.capability);
    this.#leaseIds.add(leaseId);
    parentEntry?.childLeases.add(lease);
    return Object.freeze({ status: "registered", lease });
  }

  async run<Value>(
    lease: ProtectedInvocationLease,
    execute: () => Value | PromiseLike<Value>,
    options: Readonly<{ readonly signal?: AbortSignal }> = {},
  ): Promise<ProtectedInvocationRunResult<Value>> {
    const entry = this.#entries.get(lease);
    if (entry === undefined) return unavailableRun("lease_unavailable");
    if (entry.effectiveExpiresAt <= this.#now()) {
      this.#remove(lease);
      return unavailableRun("lease_expired");
    }
    if (entry.status === "running") return unavailableRun("lease_in_use");
    if (options.signal?.aborted === true) {
      this.#remove(lease);
      return unavailableRun("lease_cancelled");
    }

    entry.status = "running";
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      this.#remove(lease);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      let value: Value;
      try {
        value = await this.#currentLeaseStorage.run(
          lease,
          execute,
        );
      } catch {
        if (cancelled || !this.#entries.has(lease)) {
          return unavailableRun("lease_cancelled");
        }
        return unavailableRun("execution_failed");
      }
      if (cancelled || !this.#entries.has(lease)) {
        return unavailableRun("lease_cancelled");
      }
      return Object.freeze({ status: "executed", value });
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      this.#remove(lease);
    }
  }

  currentLease(): ProtectedInvocationLease | null {
    const lease = this.#currentLeaseStorage.getStore();
    if (lease === undefined) return null;
    const entry = this.#entries.get(lease);
    return entry?.status === "running" ? lease : null;
  }

  currentCapability(): ProtectedInvocationCapability | null {
    const lease = this.currentLease();
    if (lease === null) return null;
    return this.#entries.get(lease)?.capability ?? null;
  }

  describe(
    lease: ProtectedInvocationLease,
  ): ProtectedInvocationCapabilityDescription | null {
    return this.#entries.get(lease)?.description ?? null;
  }

  release(lease: ProtectedInvocationLease): boolean {
    return this.#remove(lease);
  }

  sweep(): number {
    const sizeBefore = this.#entries.size;
    const now = this.#now();
    for (const [lease, entry] of this.#entries) {
      if (entry.effectiveExpiresAt <= now) this.#remove(lease);
    }
    return sizeBefore - this.#entries.size;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    for (const lease of [...this.#entries.keys()]) {
      this.#remove(lease);
    }
  }

  #remove(lease: ProtectedInvocationLease): boolean {
    const entry = this.#entries.get(lease);
    if (entry === undefined) return false;
    for (const childLease of [...entry.childLeases]) {
      this.#remove(childLease);
    }
    this.#entries.delete(lease);
    this.#leaseIds.delete(lease.leaseId);
    if (entry.parentLease !== null) {
      this.#entries.get(entry.parentLease)?.childLeases.delete(lease);
    }
    this.#capabilityPort.destroy(entry.capability);
    return true;
  }
}

export type {
  ProtectedInvocationCapability,
  ProtectedInvocationCapabilityDescription,
  ProtectedInvocationLease,
};
