import { describe, expect, test } from "bun:test";
import {
  DELIVERY_LEASE_TTL_MS,
  DELIVERY_MAXIMUM_ATTEMPTS,
  claimDeliveryWorkLease,
  deliveryRetryDelayMs,
  nautiloActorId,
  nautiloUserId,
  type DeliveryWorkLease,
  type TranslationResult,
} from "../../src/index.ts";
import {
  allHumansHaveOperationCapacity,
} from "../../src/server/delivery/postgres-human-operation-capacity.ts";
import type {
  CryptoPostgresExecutor,
  InitialDeviceBootstrapRepository,
} from "../../src/server/index.ts";
import {
  MemoryDeviceLifecycleRepository,
} from "../../src/testing/index.ts";

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function shuffled<T>(input: readonly T[], seed: number): T[] {
  const result = [...input];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

const USER_ID = valueOf(
  nautiloUserId("10000000-0000-4000-8000-000000000001"),
);
const HUMAN_ACTOR_ID = valueOf(
  nautiloActorId("20000000-0000-4000-8000-000000000001"),
);

function bootstrapBeginInput(
  index: number,
  idempotencyKey = `bootstrap_${index}`,
): Parameters<InitialDeviceBootstrapRepository["begin"]>[0] {
  const byte = (index % 250) + 1;
  return {
    request: {
      userId: USER_ID,
      humanActorId: HUMAN_ACTOR_ID,
      deviceId: `device_${index}`,
      clientKind: "browser",
      installationLineageDigest: new Uint8Array(32).fill(0x11),
      signingPublicKey: new Uint8Array(32).fill(byte),
      encryptionPublicKey: new Uint8Array(32).fill(byte + 1),
      recoveryKeyId: "recovery_1",
      recoveryPublicKey: new Uint8Array(32).fill(0x21),
      context: {
        kind: "preparation",
        authorityId: "preparation_1",
      },
      idempotencyKey,
    },
    authorizationDigest: new Uint8Array(32).fill(0x31),
    challengeId: `bootstrap_${byte.toString(16).padStart(64, "0")}`,
    challengeHash: new Uint8Array(32).fill(byte),
    publicFingerprint: new Uint8Array(32).fill(byte + 1),
    signingPublicKeyDigest: new Uint8Array(32).fill(byte + 2),
    encryptionPublicKeyDigest: new Uint8Array(32).fill(byte + 3),
    recoveryPublicKeyDigest: new Uint8Array(32).fill(0x41),
    issuedAt: 1_000,
    expiresAt: 301_000,
  };
}

class LockRecordingExecutor implements CryptoPostgresExecutor {
  readonly lockKeys: string[] = [];

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("pg_advisory_xact_lock")) {
      this.lockKeys.push(String(parameters[0]));
    }
    return Promise.resolve([]);
  }
}

function availableLease(seed: number): DeliveryWorkLease {
  return {
    workId: `operation_${seed}/domain_ab`,
    state: "awaiting_committer",
    leaseOwner: null,
    leaseExpiresAt: null,
    retryCount: 0,
    retryAt: 0,
    failureCode: null,
  };
}

describe("adversarial coordination schedule properties", () => {
  test("every concurrent first-bootstrap schedule admits exactly one candidate", async () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const width = 2 + (seed % 15);
      const repository = new MemoryDeviceLifecycleRepository();
      const inputs = shuffled(
        Array.from({ length: width }, (_, index) =>
          bootstrapBeginInput(index + 1)
        ),
        seed,
      );
      const results = await Promise.all(
        inputs.map((input) => repository.begin(input)),
      );
      expect(
        results.filter((result) => result.status === "created"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "stale_state"),
      ).toHaveLength(width - 1);
      expect(repository.publicSnapshot()).toMatchObject({
        custodyState: "initializing",
        everInitialized: false,
        activeDeviceCount: 0,
        challengeStatus: "pending",
      });
    }
  });

  test("exact bootstrap retries converge on the original challenge", async () => {
    for (let seed = 1; seed <= 128; seed += 1) {
      const repository = new MemoryDeviceLifecycleRepository();
      const input = bootstrapBeginInput(seed, "bootstrap_retry");
      const width = 2 + (seed % 15);
      const results = await Promise.all(
        Array.from({ length: width }, () => repository.begin(input)),
      );
      expect(
        results.filter((result) => result.status === "created"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "duplicate"),
      ).toHaveLength(width - 1);
      expect(new Set(results.map((result) =>
        "challengeId" in result ? result.challengeId : result.status
      ))).toEqual(new Set([input.challengeId]));
    }
  });

  test("all participant permutations acquire one canonical Human lock order", async () => {
    const humans = Array.from(
      { length: 16 },
      (_, index) => `human_${String(index + 1).padStart(2, "0")}`,
    );
    const expected = humans.map((human) =>
      `crypto-human-operation-capacity/${human}`
    );
    for (let seed = 1; seed <= 256; seed += 1) {
      const executor = new LockRecordingExecutor();
      expect(await allHumansHaveOperationCapacity(
        executor,
        shuffled([...humans, humans[seed % humans.length]!], seed),
      )).toBe(true);
      expect(executor.lockKeys).toEqual(expected);
    }
  });

  test("lease theft is impossible before expiry and deterministic at expiry", () => {
    for (let seed = 1; seed <= 512; seed += 1) {
      const now = seed * 10_000;
      const held = claimDeliveryWorkLease({
        work: availableLease(seed),
        workerId: "worker_a",
        now,
      });
      expect(held.leaseExpiresAt).toBe(now + DELIVERY_LEASE_TTL_MS);
      expect(() => claimDeliveryWorkLease({
        work: held,
        workerId: "worker_b",
        now: now + DELIVERY_LEASE_TTL_MS - 1,
      })).toThrow("not claimable");
      expect(claimDeliveryWorkLease({
        work: held,
        workerId: "worker_b",
        now: now + DELIVERY_LEASE_TTL_MS,
      }).leaseOwner).toBe("worker_b");
    }
  });

  test("retry jitter is stable and bounded for every admitted attempt", () => {
    for (let seed = 1; seed <= 512; seed += 1) {
      for (
        let retryCount = 0;
        retryCount < DELIVERY_MAXIMUM_ATTEMPTS;
        retryCount += 1
      ) {
        const workId = `operation_${seed}/domain_ab`;
        const first = deliveryRetryDelayMs(workId, retryCount);
        const second = deliveryRetryDelayMs(workId, retryCount);
        expect(first).toBe(second);
        expect(first).toBeGreaterThanOrEqual(1_000);
        expect(first).toBeLessThanOrEqual(300_000);
      }
    }
  });
});
