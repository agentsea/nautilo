/**
 * D420 — maintenance lease + work-acceptance ledger on live Postgres.
 *
 * Covers the `queries/maintenance.ts` state machine (fail-closed
 * transitions, cross-owner refusal, lease renewal + hard-expiry recovery,
 * concurrent-enter serialization via FOR UPDATE) and the
 * `queries/work-acceptances.ts` ledger (insert before enqueue, link
 * coalesced group to one Job at dispatch, terminalize un-started
 * acceptances). Requires migration 0099 applied to the target instance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ensureDatabase,
  createDirectDb,
  eq,
  sql,
  users,
  jobs,
  enterDrainingWith,
  transitionApplyingWith,
  renewLeaseWith,
  clearMaintenanceWith,
  recoverExpiredMaintenanceWith,
  getMaintenanceStateWith,
  MaintenanceTransitionError,
  insertAcceptanceWith,
  insertAcceptancesWith,
  linkAcceptancesToJobWith,
  terminalizeAcceptancesWith,
  terminalizeAllAcceptedWith,
  userCancelAcceptancesWith,
  getAcceptanceWith,
  countAcceptancesByStatusWith,
  listAcceptancesForJobWith,
  WORK_ACCEPTANCE_REASONS,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db!: ReturnType<typeof createDirectDb>;
let seededUserId: string | null = null;

/**
 * Asserts `p` rejects with an error matching `check`. Avoids the
 * `await expect().rejects` form so the `await-thenable` lint rule stays
 * satisfied in this file.
 */
async function expectRejects<T>(
  p: Promise<T>,
  check: (err: unknown) => void,
): Promise<void> {
  try {
    await p;
  } catch (err) {
    check(err);
    return;
  }
  throw new Error("expected promise to reject, but it resolved");
}

function isMaintenanceError(err: unknown): err is MaintenanceTransitionError {
  return err instanceof MaintenanceTransitionError;
}

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb(5);
});

afterAll(async () => {
  if (!db) return;
  // Reset the singleton + drop any leftover ledger rows so the scratch DB
  // is clean for the next run.
  try {
    await db.execute(sql`DELETE FROM work_acceptances`);
    await db.execute(
      sql`UPDATE server_maintenance SET state='normal', operation_id=NULL, lease_expires_at=NULL, hard_expires_at=NULL, updated_at=now() WHERE singleton_key='upgrade'`,
    );
  } catch {
    // ignore
  }
  if (seededUserId) {
    try {
      await db.delete(users).where(eq(users.id, seededUserId));
    } catch {
      // ignore
    }
  }
  await db.end();
});

beforeEach(async () => {
  // Each test starts from a clean `normal` lease + empty ledger.
  await db.execute(sql`DELETE FROM work_acceptances`);
  await db.execute(
    sql`UPDATE server_maintenance SET state='normal', operation_id=NULL, lease_expires_at=NULL, hard_expires_at=NULL, updated_at=now() WHERE singleton_key='upgrade'`,
  );
});

/** Seed a user to satisfy the jobs.owner_id / requestor_id FKs. */
async function seedUser(): Promise<string> {
  if (!db) throw new Error("D420 integration DB was not initialized");
  const [u] = await db
    .insert(users)
    .values({
      name: `d420-${Date.now().toString(36)}`,
      email: `d420-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@test.local`,
    })
    .returning({ id: users.id });
  if (!u) throw new Error("seed user failed");
  seededUserId = u.id;
  return u.id;
}

/** Insert a minimal jobs row and return its id (for acceptance linkage). */
async function seedJob(userId: string): Promise<string> {
  const [j] = await db
    .insert(jobs)
    .values({
      ownerId: userId,
      requestorId: userId,
      type: "foreground",
      status: "queued",
    })
    .returning({ id: jobs.id });
  if (!j) throw new Error("seed job failed");
  return j.id;
}

const DURATIONS = { leaseMs: 60_000, hardMs: 120_000 };

describe("D420 maintenance lease — singleton + state machine", () => {
  test("getState seeds the singleton row on first read and reports normal", async () => {
    // Wipe the singleton to prove ensureSingletonRow re-creates it.
    await db.execute(sql`DELETE FROM server_maintenance`);
    const snap = await getMaintenanceStateWith(db);
    expect(snap.state).toBe("normal");
    expect(snap.operationId).toBeNull();
    expect(snap.leaseExpiresAt).toBeNull();
    expect(snap.hardExpiresAt).toBeNull();
  });

  test("enterDraining: normal → draining with lease + hard expiry stamped", async () => {
    const op1 = randomUUID();
    const before = Date.now();
    const snap = await enterDrainingWith(db, op1, DURATIONS, new Date(before));
    expect(snap.state).toBe("draining");
    expect(snap.operationId).toBe(op1);
    expect(snap.leaseExpiresAt?.getTime()).toBe(before + DURATIONS.leaseMs);
    expect(snap.hardExpiresAt?.getTime()).toBe(before + DURATIONS.hardMs);
  });

  test("enterDraining fails closed when a live lease is held by another op", async () => {
    const op1 = randomUUID();
    const op2 = randomUUID();
    await enterDrainingWith(db, op1, DURATIONS);
    await expectRejects(enterDrainingWith(db, op2, DURATIONS), (err) => {
      expect(isMaintenanceError(err)).toBe(true);
      expect((err as MaintenanceTransitionError).code).toBe("in_progress");
    });
    // The original owner is untouched.
    const snap = await getMaintenanceStateWith(db);
    expect(snap.operationId).toBe(op1);
    expect(snap.state).toBe("draining");
  });

  test("transitionApplying: draining → applying for the owning op only", async () => {
    const op1 = randomUUID();
    await enterDrainingWith(db, op1, DURATIONS);
    const snap = await transitionApplyingWith(db, op1);
    expect(snap.state).toBe("applying");
    expect(snap.operationId).toBe(op1);
  });

  test("transitionApplying refuses a cross-owner op", async () => {
    const op1 = randomUUID();
    const op2 = randomUUID();
    await enterDrainingWith(db, op1, DURATIONS);
    await expectRejects(transitionApplyingWith(db, op2), (err) => {
      expect((err as MaintenanceTransitionError).code).toBe("not_owner");
    });
  });

  test("transitionApplying refuses from normal (invalid transition)", async () => {
    const op1 = randomUUID();
    await expectRejects(transitionApplyingWith(db, op1), (err) => {
      expect((err as MaintenanceTransitionError).code).toBe("invalid_transition");
    });
  });

  test("transitionApplying refuses when the lease has expired", async () => {
    const op1 = randomUUID();
    const past = new Date(Date.now() - 120_000);
    await enterDrainingWith(db, op1, { leaseMs: 60_000, hardMs: 120_000 }, past);
    await expectRejects(transitionApplyingWith(db, op1), (err) => {
      expect((err as MaintenanceTransitionError).code).toBe("lease_expired");
    });
  });

  test("renewLease extends the soft lease, capped at the hard expiry", async () => {
    const op1 = randomUUID();
    const t0 = new Date();
    await enterDrainingWith(db, op1, { leaseMs: 60_000, hardMs: 90_000 }, t0);
    // Renew 80s after enter → proposed lease = t0+80+60 = t0+140 > hard (t0+90).
    const t1 = new Date(t0.getTime() + 80_000);
    const snap = await renewLeaseWith(db, op1, 60_000, t1);
    // Capped at hard expiry t0+90s.
    expect(snap.leaseExpiresAt?.getTime()).toBe(t0.getTime() + 90_000);
    expect(snap.hardExpiresAt?.getTime()).toBe(t0.getTime() + 90_000);
  });

  test("renewLease refuses a cross-owner op and an expired hard ceiling", async () => {
    const op1 = randomUUID();
    const op2 = randomUUID();
    const op3 = randomUUID();
    // Part A: a live lease held by op1; op2 (cross-owner) cannot renew it.
    await enterDrainingWith(db, op1, DURATIONS);
    await expectRejects(renewLeaseWith(db, op2, 60_000), (err) => {
      expect((err as MaintenanceTransitionError).code).toBe("not_owner");
    });
    // Release op1 so op3 can claim its own (expired) lease.
    await clearMaintenanceWith(db, op1);

    // Part B: op3 holds a lease whose hard expiry is already past; renewal
    // is refused (the lease must be recovered, not renewed).
    const past = new Date(Date.now() - 200_000);
    await enterDrainingWith(db, op3, { leaseMs: 60_000, hardMs: 90_000 }, past);
    await expectRejects(renewLeaseWith(db, op3, 60_000), (err) => {
      expect((err as MaintenanceTransitionError).code).toBe("hard_expired");
    });
  });

  test("clearMaintenance returns to normal for the owning op; cross-owner refused", async () => {
    const op1 = randomUUID();
    const op2 = randomUUID();
    await enterDrainingWith(db, op1, DURATIONS);
    await expectRejects(clearMaintenanceWith(db, op2), (err) => {
      expect((err as MaintenanceTransitionError).code).toBe("not_owner");
    });
    const snap = await clearMaintenanceWith(db, op1);
    expect(snap.state).toBe("normal");
    expect(snap.operationId).toBeNull();
    expect(snap.leaseExpiresAt).toBeNull();
    expect(snap.hardExpiresAt).toBeNull();
  });

  test("clearMaintenance on an already-normal lease is an idempotent no-op", async () => {
    const op1 = randomUUID();
    const snap = await clearMaintenanceWith(db, op1);
    expect(snap.state).toBe("normal");
  });
});

describe("D420 maintenance lease — hard-expiry recovery (R10)", () => {
  test("recoverExpired reclaims an abandoned applying lease past hard expiry", async () => {
    const op1 = randomUUID();
    const past = new Date(Date.now() - 200_000);
    await enterDrainingWith(db, op1, { leaseMs: 60_000, hardMs: 90_000 }, past);
    await transitionApplyingWith(db, op1, new Date(Date.now() - 150_000));

    const res = await recoverExpiredMaintenanceWith(db);
    expect(res.recovered).toBe(true);
    expect(res.snapshot.state).toBe("normal");
    expect(res.snapshot.operationId).toBeNull();
  });

  test("recoverExpired is a no-op while the lease is still live", async () => {
    const op1 = randomUUID();
    await enterDrainingWith(db, op1, DURATIONS);
    const res = await recoverExpiredMaintenanceWith(db);
    expect(res.recovered).toBe(false);
    expect(res.snapshot.state).toBe("draining");
  });

  test("enterDraining reclaims an expired lease and claims it for a new op", async () => {
    const op1 = randomUUID();
    const op2 = randomUUID();
    const past = new Date(Date.now() - 200_000);
    await enterDrainingWith(db, op1, { leaseMs: 60_000, hardMs: 90_000 }, past);
    // op1 abandoned; op2 enters after hard expiry.
    const snap = await enterDrainingWith(db, op2, DURATIONS);
    expect(snap.state).toBe("draining");
    expect(snap.operationId).toBe(op2);
  });
});

describe("D420 maintenance lease — concurrent ownership serialization", () => {
  test("two concurrent enterDraining calls: exactly one wins, one fails closed", async () => {
    const opA: string = randomUUID();
    const opB: string = randomUUID();
    const [a, b] = await Promise.allSettled([
      enterDrainingWith(db, opA, DURATIONS),
      enterDrainingWith(db, opB, DURATIONS),
    ]);
    const wins = [a, b].filter((r) => r.status === "fulfilled");
    const fails = [a, b].filter(
      (r) => r.status === "rejected" && r.reason instanceof MaintenanceTransitionError,
    );
    expect(wins.length).toBe(1);
    expect(fails.length).toBe(1);
    const snap = await getMaintenanceStateWith(db);
    expect(snap.state).toBe("draining");
    const winner =
      a.status === "fulfilled"
        ? a.value
        : (b as PromiseFulfilledResult<typeof snap>).value;
    const winnerOpId = winner.operationId;
    expect(winnerOpId).not.toBeNull();
    expect([opA, opB]).toContain(winnerOpId as string);
  });
});

describe("D420 work-acceptance ledger — payload-free lifecycle", () => {
  test("insertAcceptance creates an accepted row with no payload columns", async () => {
    const id = await insertAcceptanceWith(db, "foreground");
    const row = await getAcceptanceWith(db, id);
    expect(row?.status).toBe("accepted");
    expect(row?.kind).toBe("foreground");
    expect(row?.jobId).toBeNull();
    expect(row?.dispatchedAt).toBeNull();
    expect(row?.cancelledAt).toBeNull();
    expect(row?.cancellationReason).toBeNull();
    expect(row?.acceptedAt).toBeInstanceOf(Date);
  });

  test("insertAcceptances bulk-creates N rows", async () => {
    const ids = await insertAcceptancesWith(db, "system_report_back", 3);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(await countAcceptancesByStatusWith(db, "accepted")).toBe(3);
  });

  test("linkAcceptancesToJob marks the coalesced group dispatched + linked to one Job", async () => {
    const userId = await seedUser();
    const jobId = await seedJob(userId);
    const ids = await insertAcceptancesWith(db, "foreground", 3);

    const linked = await linkAcceptancesToJobWith(db, ids, jobId);
    expect(linked).toBe(3);

    const rows = await listAcceptancesForJobWith(db, jobId);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.status).toBe("dispatched");
      expect(r.jobId).toBe(jobId);
      expect(r.dispatchedAt).toBeInstanceOf(Date);
    }
    expect(await countAcceptancesByStatusWith(db, "accepted")).toBe(0);
  });

  test("linkAcceptancesToJob is idempotent: a second link touches nothing", async () => {
    const userId = await seedUser();
    const jobId = await seedJob(userId);
    const ids = await insertAcceptancesWith(db, "foreground", 2);
    await linkAcceptancesToJobWith(db, ids, jobId);
    const second = await linkAcceptancesToJobWith(db, ids, jobId);
    expect(second).toBe(0);
  });

  test("terminalizeAcceptances marks un-started acceptances maintenance_cancelled with a bounded reason", async () => {
    const ids = await insertAcceptancesWith(db, "foreground", 2);
    const n = await terminalizeAcceptancesWith(db, ids, WORK_ACCEPTANCE_REASONS.maintenanceDrain);
    expect(n).toBe(2);
    for (const id of ids) {
      const r = await getAcceptanceWith(db, id);
      expect(r?.status).toBe("maintenance_cancelled");
      expect(r?.cancelledAt).toBeInstanceOf(Date);
      expect(r?.cancellationReason).toBe(WORK_ACCEPTANCE_REASONS.maintenanceDrain);
      expect(r?.jobId).toBeNull();
    }
  });

  test("terminalizeAcceptances leaves already-dispatched rows untouched", async () => {
    const userId = await seedUser();
    const jobId = await seedJob(userId);
    const ids = await insertAcceptancesWith(db, "foreground", 2);
    await linkAcceptancesToJobWith(db, ids, jobId);
    const n = await terminalizeAcceptancesWith(db, ids, WORK_ACCEPTANCE_REASONS.plannedShutdown);
    expect(n).toBe(0);
    for (const id of ids) {
      const r = await getAcceptanceWith(db, id);
      expect(r?.status).toBe("dispatched");
    }
  });

  test("terminalizeAllAccepted sweeps every un-started acceptance (the 2.2.3 seam)", async () => {
    const userId = await seedUser();
    const jobId = await seedJob(userId);
    const dispatched = await insertAcceptancesWith(db, "foreground", 1);
    await linkAcceptancesToJobWith(db, dispatched, jobId);
    await insertAcceptancesWith(db, "foreground", 3); // accepted, un-started

    const n = await terminalizeAllAcceptedWith(db, WORK_ACCEPTANCE_REASONS.maintenanceDrain);
    expect(n).toBe(3);
    expect(await countAcceptancesByStatusWith(db, "accepted")).toBe(0);
    expect(await countAcceptancesByStatusWith(db, "maintenance_cancelled")).toBe(3);
    expect(await countAcceptancesByStatusWith(db, "dispatched")).toBe(1);
  });

  test("CHECK constraint rejects an invalid kind", async () => {
    await expectRejects(
      db.execute(
        sql`INSERT INTO work_acceptances (kind, status) VALUES ('bogus', 'accepted')`,
      ) as unknown as Promise<unknown>,
      () => {},
    );
  });

  test("CHECK constraint rejects an invalid status", async () => {
    await expectRejects(
      db.execute(
        sql`INSERT INTO work_acceptances (kind, status) VALUES ('foreground', 'bogus')`,
      ) as unknown as Promise<unknown>,
      () => {},
    );
  });
});

describe("D420 work-acceptance ledger — user_cancelled (D349 user Stop)", () => {
  test("userCancelAcceptances terminalizes an exact ID-scoped set as user_cancelled", async () => {
    const ids = await insertAcceptancesWith(db, "foreground", 3);
    const n = await userCancelAcceptancesWith(db, ids, WORK_ACCEPTANCE_REASONS.userStop);
    expect(n).toBe(3);
    for (const id of ids) {
      const r = await getAcceptanceWith(db, id);
      expect(r?.status).toBe("user_cancelled");
      expect(r?.cancelledAt).toBeInstanceOf(Date);
      expect(r?.cancellationReason).toBe(WORK_ACCEPTANCE_REASONS.userStop);
      expect(r?.jobId).toBeNull();
    }
    expect(await countAcceptancesByStatusWith(db, "user_cancelled")).toBe(3);
  });

  test("userCancelAcceptances is idempotent: a second call on terminalized rows touches nothing", async () => {
    const ids = await insertAcceptancesWith(db, "foreground", 2);
    await userCancelAcceptancesWith(db, ids, WORK_ACCEPTANCE_REASONS.userStop);
    const second = await userCancelAcceptancesWith(db, ids, WORK_ACCEPTANCE_REASONS.userStop);
    expect(second).toBe(0);
  });

  test("userCancelAcceptances is ID-scoped: only the named rows terminalize", async () => {
    const target = await insertAcceptancesWith(db, "foreground", 2);
    const other = await insertAcceptancesWith(db, "foreground", 1);
    const n = await userCancelAcceptancesWith(db, target, WORK_ACCEPTANCE_REASONS.userStop);
    expect(n).toBe(2);
    expect((await getAcceptanceWith(db, other[0]!))?.status).toBe("accepted");
  });

  test("userCancelAcceptances leaves already-dispatched rows untouched", async () => {
    const userId = await seedUser();
    const jobId = await seedJob(userId);
    const ids = await insertAcceptancesWith(db, "foreground", 2);
    await linkAcceptancesToJobWith(db, ids, jobId);
    const n = await userCancelAcceptancesWith(db, ids, WORK_ACCEPTANCE_REASONS.userStop);
    expect(n).toBe(0);
    for (const id of ids) {
      expect((await getAcceptanceWith(db, id))?.status).toBe("dispatched");
    }
  });

  test("the maintenance sweep leaves user_cancelled rows untouched (R8 distinctness)", async () => {
    // Two user-Stop-discarded rows + one still-accepted row the maintenance
    // sweep should claim as maintenance_cancelled.
    const userStopped = await insertAcceptancesWith(db, "foreground", 2);
    await userCancelAcceptancesWith(db, userStopped, WORK_ACCEPTANCE_REASONS.userStop);
    await insertAcceptancesWith(db, "foreground", 1);

    const swept = await terminalizeAllAcceptedWith(db, WORK_ACCEPTANCE_REASONS.maintenanceDrain);
    expect(swept).toBe(1);
    // The user_cancelled rows are NOT relabeled as maintenance_cancelled.
    expect(await countAcceptancesByStatusWith(db, "user_cancelled")).toBe(2);
    expect(await countAcceptancesByStatusWith(db, "maintenance_cancelled")).toBe(1);
    expect(await countAcceptancesByStatusWith(db, "accepted")).toBe(0);
    for (const id of userStopped) {
      const r = await getAcceptanceWith(db, id);
      expect(r?.status).toBe("user_cancelled");
      expect(r?.cancellationReason).toBe(WORK_ACCEPTANCE_REASONS.userStop);
    }
  });

  test("user_cancelled is accepted by the widened status CHECK constraint", async () => {
    // Direct insert proves the migration-0100 constraint admits the new status.
    await db.execute(
      sql`INSERT INTO work_acceptances (kind, status) VALUES ('foreground', 'user_cancelled')`,
    );
    expect(await countAcceptancesByStatusWith(db, "user_cancelled")).toBeGreaterThanOrEqual(1);
  });
});
