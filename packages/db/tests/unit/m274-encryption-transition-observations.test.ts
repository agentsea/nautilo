import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  consumeEncryptionTransitionObservationAdmission,
  ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_MAX_TTL_MS,
  issueEncryptionTransitionObservationAdmission,
  planEncryptionTransitionObservation,
  validateEncryptionTransitionObservationBounds,
} from "../../src/utils/encryption-transition-observations";

describe("M274 bounded encryption transition observations", () => {
  const bounds = {
    bucketWidthMs: 90_000,
    retentionMs: 900_000,
    storageLimitRows: 317,
    latencyUpperBoundsMs: [25, 120, 775] as const,
  };

  test("validates explicit bounds for deterministic projection helpers", () => {
    expect(validateEncryptionTransitionObservationBounds(bounds)).toEqual(bounds);
    for (const invalid of [
      { ...bounds, bucketWidthMs: 0 },
      { ...bounds, retentionMs: 89_999 },
      { ...bounds, storageLimitRows: 0 },
      { ...bounds, latencyUpperBoundsMs: [25, 25] },
      { ...bounds, latencyUpperBoundsMs: [120, 25] },
    ]) expect(() => validateEncryptionTransitionObservationBounds(invalid)).toThrow();
  });

  test("derives deterministic time and measured latency buckets", () => {
    expect(planEncryptionTransitionObservation(
      new Date("2026-08-14T06:01:45.555Z"),
      120,
      bounds,
    )).toEqual({
      bucketStartedAt: new Date("2026-08-14T06:01:30.000Z"),
      bucketWidthMs: 90_000,
      latencyBucket: 1,
      retentionCutoff: new Date("2026-08-14T05:46:45.555Z"),
    });
    expect(planEncryptionTransitionObservation(
      new Date("2026-08-14T06:01:45.555Z"),
      776,
      bounds,
    ).latencyBucket).toBe(3);
  });

  test("rejects invalid clocks and latency instead of creating corrupt rows", () => {
    expect(() => planEncryptionTransitionObservation(
      new Date(Number.NaN),
      1,
      bounds,
    )).toThrow();
    expect(() => planEncryptionTransitionObservation(new Date(), -1, bounds)).toThrow();
  });

  test("records cumulative epoch totals before pruning bounded latency buckets", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-observations.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const totals = source.indexOf("insert(encryptionTransitionOutcomeTotals)");
    const prune = source.indexOf("delete(encryptionTransitionObservationBuckets)");
    expect(totals).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(totals);
    expect(source).toContain(
      "ne(encryptionTransitionOutcomeTotals.policyRevision, policy.revision)",
    );
  });

  test("bounds admission lifetime before touching PostgreSQL", () => {
    let transactionCalls = 0;
    const db = {
      transaction: () => {
        transactionCalls += 1;
        throw new Error("must not run");
      },
    } as never;
    const now = new Date("2026-08-14T06:00:00.000Z");
    expect(issueEncryptionTransitionObservationAdmission(db, {
      family: "memory",
      operation: "update",
      now,
      expiresAt: new Date(
        now.getTime() + ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_MAX_TTL_MS + 1,
      ),
    })).rejects.toThrow("outside the bounded lifetime");
    expect(transactionCalls).toBe(0);
  });

  test("admits Memory read observation issuance before entering storage", async () => {
    const reachedTransaction = new Error("reached observation storage");
    const db = { transaction: () => { throw reachedTransaction; } } as never;
    const now = new Date("2026-08-14T06:00:00.000Z");
    let caught: unknown;
    try {
      await issueEncryptionTransitionObservationAdmission(db, {
        family: "memory", operation: "read", now,
        expiresAt: new Date(now.getTime() + 1_000),
        memoryReadBinding: {
          subjectHumanId: "human:1",
          memoryId: "11111111-1111-4111-8111-111111111111",
          cryptoObjectId: "nautilo-memory-v1:11111111-1111-4111-8111-111111111111:1",
          contentRevision: 1,
          cryptoAccessRevision: 0,
        },
      });
    } catch (error) { caught = error; }
    expect(caught).toBe(reachedTransaction);
  });

  test("never accepts client-issued verified numerator outcomes", () => {
    let transactionCalls = 0;
    const db = {
      transaction: () => {
        transactionCalls += 1;
        throw new Error("must not run");
      },
    } as never;
    expect(consumeEncryptionTransitionObservationAdmission(db, {
      token: new Uint8Array(32),
      outcome: "verified",
      reason: "none",
      observedAt: new Date("2026-08-14T06:00:01.000Z"),
    })).rejects.toThrow("only unavailable or failed");
    expect(transactionCalls).toBe(0);
  });

  test("prunes expired and prior-epoch admissions before capacity accounting", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-observations.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const reconcile = source.indexOf(
      "await reconcileExpiredAdmissionsInTransaction(tx, policy, now)",
    );
    const count = source.indexOf(
      "const [countRow] = await tx.select({ count: count() })",
    );
    expect(reconcile).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(reconcile);
    expect(source.slice(reconcile, count)).toContain(
      "encryptionTransitionObservationAdmissions.policyRevision",
    );
  });

  test("terminalizes expired attempts before deleting bearer admissions", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-observations.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const start = source.indexOf(
      "async function reconcileExpiredAdmissionsInTransaction",
    );
    const end = source.indexOf(
      "export async function reconcileExpiredEncryptionTransitionObservationAdmissions",
    );
    const boundary = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(boundary).toContain("await recordObservationInTransaction");
    expect(boundary).toContain(
      "outcome: \"unavailable\"",
    );
    expect(boundary).toContain("? \"unsupported_operation\"");
    expect(boundary).toContain(": \"client_observation_expired\"");
    expect(boundary.indexOf("await recordObservationInTransaction"))
      .toBeLessThan(boundary.indexOf(
        "await tx.delete(encryptionTransitionObservationAdmissions)",
      ));
    expect(boundary).toContain("observedAt: admission.expiresAt");
  });

  test("trusted consumption binds the admission's exact family and operation", () => {
    const source = readFileSync(
      new URL(
        "../../src/utils/encryption-transition-observations.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("admission.family !== trustedExpected.family");
    expect(source).toContain(
      "admission.operation !== trustedExpected.operation",
    );
    expect(source).toContain(
      "reason: unsupported ? \"unsupported_operation\" : \"integrity_failure\"",
    );
    expect(source).toContain("expectedFamily: EncryptionTransitionFamily");
    expect(source).toContain("expectedOperation: EncryptionTransitionOperation");
    const consume = source.indexOf(
      "const consumed = await tx.delete(encryptionTransitionObservationAdmissions)",
    );
    const project = source.indexOf(
      "await recordObservationInTransaction(tx, policy",
      consume,
    );
    expect(consume).toBeGreaterThan(-1);
    expect(project).toBeGreaterThan(consume);
    expect(source).toContain(
      "input.observedAt.getTime() - admission.createdAt.getTime()",
    );
    const consumeBoundary = source.slice(
      source.indexOf("async function consumeObservationAdmission"),
      source.indexOf("export function consumeEncryptionTransitionObservationAdmission"),
    );
    expect(consumeBoundary).not.toContain("input.latencyMs");
    expect(consumeBoundary).not.toContain("status: \"replayed\"");
    const lookup = consumeBoundary.indexOf(
      "tx.select().from(encryptionTransitionObservationAdmissions)",
    );
    expect(consumeBoundary.indexOf(
      "reconcileExpiredAdmissionsInTransaction(tx, policy, input.observedAt)",
    )).toBeLessThan(lookup);
  });
});
