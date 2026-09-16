import { describe, expect, test } from "bun:test";
import {
  DELIVERY_LEASE_HEARTBEAT_MS,
  DELIVERY_LEASE_TTL_MS,
  DELIVERY_MAXIMUM_ATTEMPTS,
  claimDeliveryWorkLease,
  deliveryRetryAtMs,
  deliveryRetryDelayMs,
  failDeliveryWorkLease,
  heartbeatDeliveryWorkLease,
  type DeliveryWorkLease,
} from "../../src/index.ts";

function available(
  overrides: Partial<DeliveryWorkLease> = {},
): DeliveryWorkLease {
  return {
    workId: "operation_1/domain_ab",
    state: "awaiting_committer",
    leaseOwner: null,
    leaseExpiresAt: null,
    retryCount: 0,
    retryAt: 0,
    failureCode: null,
    ...overrides,
  };
}

describe("delivery worker lease policy", () => {
  test("claims for thirty seconds and renews only for the current live owner", () => {
    const claimed = claimDeliveryWorkLease({
      work: available(),
      workerId: "worker_a",
      now: 10_000,
    });
    expect(claimed).toMatchObject({
      leaseOwner: "worker_a",
      leaseExpiresAt: 10_000 + DELIVERY_LEASE_TTL_MS,
    });
    expect(() => heartbeatDeliveryWorkLease({
      work: claimed,
      workerId: "worker_b",
      now: 10_000 + DELIVERY_LEASE_HEARTBEAT_MS,
    })).toThrow("owner");
    expect(heartbeatDeliveryWorkLease({
      work: claimed,
      workerId: "worker_a",
      now: 10_000 + DELIVERY_LEASE_HEARTBEAT_MS,
    }).leaseExpiresAt).toBe(
      10_000 + DELIVERY_LEASE_HEARTBEAT_MS + DELIVERY_LEASE_TTL_MS,
    );
  });

  test("permits deterministic lease theft only after exact expiry", () => {
    const held = available({
      leaseOwner: "worker_a",
      leaseExpiresAt: 40_000,
    });
    expect(() => claimDeliveryWorkLease({
      work: held,
      workerId: "worker_b",
      now: 39_999,
    })).toThrow("not claimable");
    expect(claimDeliveryWorkLease({
      work: held,
      workerId: "worker_b",
      now: 40_000,
    }).leaseOwner).toBe("worker_b");
  });

  test("uses deterministic bounded backoff and terminates after eight attempts", () => {
    const delays = Array.from(
      { length: DELIVERY_MAXIMUM_ATTEMPTS },
      (_, retryCount) => deliveryRetryDelayMs("operation_1/domain_ab", retryCount),
    );
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
    expect(delays.every((delay) => delay <= 300_000)).toBe(true);
    expect(deliveryRetryDelayMs("operation_1/domain_ab", 4)).toBe(delays[4]!);
    expect(deliveryRetryAtMs("operation_1/domain_ab", 1, 50_000)).toBe(
      50_000 + delays[0]!,
    );

    let work = claimDeliveryWorkLease({
      work: available(),
      workerId: "worker_a",
      now: 10_000,
    });
    for (let attempt = 1; attempt <= DELIVERY_MAXIMUM_ATTEMPTS; attempt++) {
      work = failDeliveryWorkLease({
        work,
        workerId: "worker_a",
        now: 10_000 + attempt,
        failureCode: "transient_provider_failure",
        transient: true,
      });
      expect(work.retryCount).toBe(attempt);
      if (attempt < DELIVERY_MAXIMUM_ATTEMPTS) {
        expect(work.state).not.toBe("failed");
        work = claimDeliveryWorkLease({
          work,
          workerId: "worker_a",
          now: work.retryAt,
        });
      }
    }
    expect(work).toMatchObject({
      state: "failed",
      retryCount: DELIVERY_MAXIMUM_ATTEMPTS,
      leaseOwner: null,
      leaseExpiresAt: null,
      failureCode: "maximum_attempts_reached",
    });
  });
});
