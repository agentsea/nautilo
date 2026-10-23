import { describe, expect, test } from "bun:test";

import type {
  LiveShadowEncryptionTransitionPolicy,
  ProtectedTaskActivationProductReadiness,
} from "@nautilo/db";
import type { CryptoPostgresHandle } from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import type { ProtectedTaskActivationCryptoReadiness } from
  "../../src/routes/protected-task-activation-crypto-readiness";
import {
  createProtectedTaskActivationReadinessAssertion,
  type ProtectedTaskActivationOperationalReadiness,
  type ProtectedTaskActivationReadinessContext,
} from "../../src/routes/protected-task-activation-readiness";

const NOW = new Date("2042-06-07T08:09:10.000Z");
const transaction = {} as CanonicalTranscriptTx;
const restricted = {} as CryptoPostgresHandle;
const policy: LiveShadowEncryptionTransitionPolicy = {
  mode: "shadow_encryption",
  shadowBehavior: "strict",
  revision: 7,
  shadowEncryptionStartedAt: new Date("2042-01-01T00:00:00.000Z"),
  updatedAt: new Date("2042-06-01T00:00:00.000Z"),
};

function product(): ProtectedTaskActivationProductReadiness {
  return {
    definitions: {
      total: 4n, exactMapped: 2n, deferredNested: 1n,
      blockers: {
        ordinarySupported: 0n, artifactDependentCandidates: 0n,
        invalidCurrentMapping: 0n, pendingRevisions: 0n,
        completeUnmappedRevisions: 0n, quarantinedRevisions: 0n,
        staleMappingRevisions: 0n,
      },
    },
    results: {
      terminal: 5n, contentBearing: 4n, exactMapped: 2n,
      noContent: 1n, deferredNested: 1n,
      blockers: {
        ordinarySupported: 0n, artifactDependentCandidates: 0n,
        invalidCurrentMapping: 0n, pendingRevisions: 0n,
        completeUnmappedRevisions: 0n, quarantinedRevisions: 0n,
        staleMappingRevisions: 0n,
      },
    },
    operations: {
      blockers: { activeBackfillClaims: 0n, incompleteOutputBindings: 0n },
    },
  };
}

const emptyCounts = () => ({
  total: 0n,
  mapped: 0n,
  blockers: {
    missingProductReceipt: 0n,
    pendingProductReceipt: 0n,
    completeUnmappedProductReceipt: 0n,
    quarantinedProductReceipt: 0n,
    staleMappingProductReceipt: 0n,
    invalidProductReceipt: 0n,
  },
});

function crypto(): ProtectedTaskActivationCryptoReadiness {
  return {
    observedAt: new Date(NOW),
    objects: {
      definition: { ...emptyCounts(), total: 1n, mapped: 1n },
      result: { ...emptyCounts(), total: 1n, mapped: 1n },
      historical: emptyCounts(),
    },
    staging: {
      cancellation: emptyCounts(),
      result_message: emptyCounts(),
      terminal_message: emptyCounts(),
      historical: emptyCounts(),
    },
  };
}

function operational(): ProtectedTaskActivationOperationalReadiness {
  return {
    policyRevision: 7,
    maintenance: {
      state: "draining",
      operationId: "5ad4c005-8a25-45aa-a61f-22ef34245a2c",
      leaseExpiresAt: new Date("2042-06-07T08:10:10.000Z"),
      hardExpiresAt: new Date("2042-06-07T08:20:10.000Z"),
    },
    activity: {
      runningForegroundJobs: 0,
      runningBackgroundJobs: 0,
      queuedTurns: 0,
      bufferedLanes: 0,
      acceptedWork: 0,
      runningTaskRuns: 0,
      claimedTasks: 0,
    },
    persistence: {
      protectedTaskBackedJobs: 4n,
      protectedJobContentViolations: 0n,
      parkedJobsRequiringIntegrityProof: 2n,
    },
  };
}

function context(
  overrides: Partial<ProtectedTaskActivationReadinessContext> = {},
): ProtectedTaskActivationReadinessContext {
  return {
    transaction,
    current: policy,
    requested: { expectedRevision: 7, targetMode: "encrypted_only" },
    restricted,
    now: NOW,
    readOperational: () => Promise.resolve(operational()),
    assertCurrentMountedCapabilities: () => Promise.resolve(),
    inspectParkedExecutionIntegrity: ({ expectedJobs }) => Promise.resolve({
      status: "verified", verifiedJobs: expectedJobs,
    }),
    ...overrides,
  };
}

describe("protected Task activation readiness assertion", () => {
  test("uses the held transaction for every current proof", async () => {
    const calls: string[] = [];
    const assertReady = createProtectedTaskActivationReadinessAssertion({
      readProduct: current => {
        expect(current).toBe(transaction);
        calls.push("product");
        return Promise.resolve(product());
      },
      readCrypto: input => {
        expect(input.transaction).toBe(transaction);
        expect(input.restricted).toBe(restricted);
        calls.push("crypto");
        return Promise.resolve(crypto());
      },
    });
    await assertReady(context({
      readOperational: input => {
        expect(input.transaction).toBe(transaction);
        expect(input.policyRevision).toBe(7);
        calls.push("operational");
        return Promise.resolve(operational());
      },
      assertCurrentMountedCapabilities: input => {
        expect(input.transaction).toBe(transaction);
        expect(input.policyRevision).toBe(7);
        expect(input.targetMode).toBe("encrypted_only");
        calls.push("capabilities");
        return Promise.resolve();
      },
      inspectParkedExecutionIntegrity: input => {
        expect(input.transaction).toBe(transaction);
        expect(input.expectedJobs).toBe(2n);
        expect(input.now).toBe(NOW);
        calls.push("parked");
        return Promise.resolve({ status: "verified", verifiedJobs: 2n });
      },
    }));
    expect(calls).toEqual([
      "product", "crypto", "operational", "capabilities", "parked",
    ]);
  });

  test("rejects stale policy and non-Full use before inventory reads", async () => {
    let reads = 0;
    const assertReady = createProtectedTaskActivationReadinessAssertion({
      readProduct: () => { reads += 1; return Promise.resolve(product()); },
      readCrypto: () => { reads += 1; return Promise.resolve(crypto()); },
    });
    await Promise.resolve(expect(assertReady(context({
      requested: { expectedRevision: 6, targetMode: "encrypted_only" },
    }))).rejects.toMatchObject({ reason: "policy_not_current" }));
    await Promise.resolve(expect(assertReady(context({
      requested: { expectedRevision: 7, targetMode: "shadow_encryption" },
    }))).rejects.toMatchObject({ reason: "full_not_requested" }));
    expect(reads).toBe(0);
  });

  test("treats definition and result Artifact candidates as blockers", async () => {
    for (const family of ["definitions", "results"] as const) {
      const current = product();
      const blocked = {
        ...current,
        [family]: {
          ...current[family],
          blockers: {
            ...current[family].blockers,
            artifactDependentCandidates: 1n,
          },
        },
      } as ProtectedTaskActivationProductReadiness;
      const assertReady = createProtectedTaskActivationReadinessAssertion({
        readProduct: () => Promise.resolve(blocked),
        readCrypto: () => Promise.resolve(crypto()),
      });
      await Promise.resolve(expect(assertReady(context())).rejects.toMatchObject({
        reason: "product_not_ready",
      }));
    }
  });

  test("requires the exact live leased drain and all seven zero counters", async () => {
    const assertReady = createProtectedTaskActivationReadinessAssertion({
      readProduct: () => Promise.resolve(product()),
      readCrypto: () => Promise.resolve(crypto()),
    });
    const expired = operational();
    await Promise.resolve(expect(assertReady(context({
      readOperational: () => Promise.resolve({
        ...expired,
        maintenance: { ...expired.maintenance, leaseExpiresAt: new Date(NOW) },
      }),
    }))).rejects.toMatchObject({ reason: "maintenance_not_drained" }));
    const active = operational();
    await Promise.resolve(expect(assertReady(context({
      readOperational: () => Promise.resolve({
        ...active,
        activity: { ...active.activity, claimedTasks: 1 },
      }),
    }))).rejects.toMatchObject({ reason: "maintenance_not_drained" }));
  });

  test("requires real mounted capability and parked-integrity inspections", async () => {
    const assertReady = createProtectedTaskActivationReadinessAssertion({
      readProduct: () => Promise.resolve(product()),
      readCrypto: () => Promise.resolve(crypto()),
    });
    await Promise.resolve(expect(assertReady(context({
      assertCurrentMountedCapabilities: () => Promise.reject(
        new Error("protected Task runtime not mounted"),
      ),
    }))).rejects.toMatchObject({ reason: "runtime_not_ready" }));
    await Promise.resolve(expect(assertReady(context({
      inspectParkedExecutionIntegrity: () => Promise.resolve({
        status: "verified", verifiedJobs: 1n,
      }),
    }))).rejects.toMatchObject({ reason: "persistence_not_ready" }));
  });

  test("rejects Job violations before opening physical checkpoint readers", async () => {
    let integrityReads = 0;
    const assertReady = createProtectedTaskActivationReadinessAssertion({
      readProduct: () => Promise.resolve(product()),
      readCrypto: () => Promise.resolve(crypto()),
    });
    const value = operational();
    await Promise.resolve(expect(assertReady(context({
      readOperational: () => Promise.resolve({
        ...value,
        persistence: { ...value.persistence, protectedJobContentViolations: 1n },
      }),
      inspectParkedExecutionIntegrity: () => {
        integrityReads += 1;
        return Promise.resolve({ status: "verified", verifiedJobs: 2n });
      },
    }))).rejects.toMatchObject({ reason: "persistence_not_ready" }));
    expect(integrityReads).toBe(0);
  });
});
