export const DELIVERY_LEASE_TTL_MS = 30_000;
export const DELIVERY_LEASE_HEARTBEAT_MS = 10_000;
export const DELIVERY_MAXIMUM_ATTEMPTS = 8;
export const DELIVERY_RETRY_BASE_MS = 1_000;
export const DELIVERY_RETRY_CAP_MS = 300_000;

export type DeliveryWorkState =
  | "awaiting_committer"
  | "preparing"
  | "awaiting_delivery"
  | "ready_to_activate"
  | "active"
  | "failed";

export interface DeliveryWorkLease {
  readonly workId: string;
  readonly state: DeliveryWorkState;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly retryCount: number;
  readonly retryAt: number;
  readonly failureCode: string | null;
}

function counter(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a safe nonnegative counter`);
  }
}

function portable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)
  ) {
    throw new TypeError(`${label} must be a portable identifier`);
  }
}

function assertLease(work: DeliveryWorkLease): void {
  portable("Delivery work id", work.workId);
  counter("Delivery retry count", work.retryCount);
  counter("Delivery retry time", work.retryAt);
  if (work.retryCount > DELIVERY_MAXIMUM_ATTEMPTS) {
    throw new RangeError("Delivery retry count exceeds its bound");
  }
  if ((work.leaseOwner === null) !== (work.leaseExpiresAt === null)) {
    throw new Error("Delivery lease owner and expiry must be coherent");
  }
  if (work.leaseOwner !== null) {
    portable("Delivery lease owner", work.leaseOwner);
    counter("Delivery lease expiry", work.leaseExpiresAt!);
  }
  if (work.failureCode !== null) {
    portable("Delivery failure code", work.failureCode);
  }
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function deliveryRetryDelayMs(
  workId: string,
  retryCount: number,
): number {
  portable("Delivery work id", workId);
  counter("Delivery retry count", retryCount);
  const exponent = Math.min(retryCount, 30);
  const base = Math.min(
    DELIVERY_RETRY_CAP_MS,
    DELIVERY_RETRY_BASE_MS * (2 ** exponent),
  );
  const jitterBound = Math.floor(base / 5);
  const jitter = jitterBound === 0
    ? 0
    : stableHash(`${workId}/${retryCount}`) % (jitterBound + 1);
  return Math.min(DELIVERY_RETRY_CAP_MS, base + jitter);
}

export function deliveryRetryAtMs(
  workId: string,
  retryCount: number,
  lastFailureAt: number,
): number {
  counter("Delivery retry count", retryCount);
  counter("Delivery failure time", lastFailureAt);
  return retryCount === 0
    ? lastFailureAt
    : lastFailureAt + deliveryRetryDelayMs(workId, retryCount - 1);
}

export function claimDeliveryWorkLease(input: {
  readonly work: DeliveryWorkLease;
  readonly workerId: string;
  readonly now: number;
}): DeliveryWorkLease {
  assertLease(input.work);
  portable("Delivery worker id", input.workerId);
  counter("Delivery claim time", input.now);
  if (
    input.work.state === "active"
    || input.work.state === "failed"
    || input.work.retryCount >= DELIVERY_MAXIMUM_ATTEMPTS
    || input.now < input.work.retryAt
    || (
      input.work.leaseExpiresAt !== null
      && input.now < input.work.leaseExpiresAt
    )
  ) {
    throw new Error("Delivery work is not claimable");
  }
  return Object.freeze({
    ...input.work,
    leaseOwner: input.workerId,
    leaseExpiresAt: input.now + DELIVERY_LEASE_TTL_MS,
  });
}

export function heartbeatDeliveryWorkLease(input: {
  readonly work: DeliveryWorkLease;
  readonly workerId: string;
  readonly now: number;
}): DeliveryWorkLease {
  assertLease(input.work);
  counter("Delivery heartbeat time", input.now);
  if (
    input.work.leaseOwner !== input.workerId
    || input.work.leaseExpiresAt === null
    || input.now >= input.work.leaseExpiresAt
  ) {
    throw new Error("Delivery heartbeat requires the current live owner");
  }
  return Object.freeze({
    ...input.work,
    leaseExpiresAt: input.now + DELIVERY_LEASE_TTL_MS,
  });
}

export function failDeliveryWorkLease(input: {
  readonly work: DeliveryWorkLease;
  readonly workerId: string;
  readonly now: number;
  readonly failureCode: string;
  readonly transient: boolean;
}): DeliveryWorkLease {
  assertLease(input.work);
  portable("Delivery failure code", input.failureCode);
  counter("Delivery failure time", input.now);
  if (
    input.work.leaseOwner !== input.workerId
    || input.work.leaseExpiresAt === null
    || input.now >= input.work.leaseExpiresAt
  ) {
    throw new Error("Delivery failure requires the current live owner");
  }
  const retryCount = input.work.retryCount + 1;
  const terminal = !input.transient
    || retryCount >= DELIVERY_MAXIMUM_ATTEMPTS;
  return Object.freeze({
    ...input.work,
    state: terminal ? "failed" as const : input.work.state,
    leaseOwner: null,
    leaseExpiresAt: null,
    retryCount,
    retryAt: terminal
      ? input.now
      : deliveryRetryAtMs(input.work.workId, retryCount, input.now),
    failureCode: terminal && input.transient
      ? "maximum_attempts_reached"
      : input.failureCode,
  });
}
