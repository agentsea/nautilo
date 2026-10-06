import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  runDurableHierarchySleep,
  type DurableSleepClaim,
  type DurableSleepOrganizerView,
  type DurableSleepSemanticPort,
} from "@nautilo/reflection";
import {
  PostgresSemanticWorkStore,
  createHmacRecordSemanticCommitmentPort,
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
} from "@nautilo/reflection-bridge/server";

import { createReflectionOrganizationAttemptOpener } from "../../src/reflection/organization-attempt";
import { ReflectionSemanticWorker } from "../../src/reflection/semantic-sleep-worker";
import { createRecordProductPostgresConnection } from "../../src/stenographer/native-record-publication";
import {
  closeDirectDb,
  getDirectDb,
} from "./helpers";

const connectionString = process.env["NAUTILO_REFLECTION_LIVENESS_TEST_DATABASE_URL"];
const describePostgres = connectionString === undefined ? describe.skip : describe;
if (connectionString !== undefined && !/test|cruft|qa/iu.test(connectionString)) {
  throw new Error("Reflection liveness integration refuses a non-test-looking database URL");
}

const SEMANTIC: DurableSleepSemanticPort = {
  resolveParentConflict: async () => ({ status: "not_applicable" }),
  ensureAuthority: async () => ({ status: "ready" }),
  ensureSearchProjection: async () => ({ status: "ready" }),
  loadOrganizerView: async () => ({
    status: "unavailable",
    failureCode: "candidate_unavailable",
  }),
  resolveDependencyLoss: async () => ({ status: "not_applicable" }),
  invokeOrganizer: async () => "{}",
  applyProposal: async () => ({
    status: "unavailable",
    failureCode: "publication_unavailable",
  }),
};

async function waitForFirstPoll(worker: ReflectionSemanticWorker): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (worker.getHealth().lastPoll === null) {
    if (Date.now() >= deadline) throw new Error("Reflection worker did not finish its first poll");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function withIsolatedRecordProductTransaction<Result>(
  use: (input: Readonly<{
    handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>;
    executor: RecordProductPostgresExecutor;
  }>) => Promise<Result>,
): Promise<Result> {
  const db = getDirectDb();
  const rollback = new Error("rollback isolated reflection integration transaction");
  let result: Result | undefined;
  try {
    await db.$client.begin(async (transaction) => {
      const executor: RecordProductPostgresExecutor = {
        async query<Row extends RecordProductPostgresRow = RecordProductPostgresRow>(
          statement: string,
          parameters: readonly RecordProductPostgresScalar[] = [],
        ): Promise<readonly Row[]> {
          const serialized = parameters.map((parameter) =>
            parameter instanceof Date ? parameter.toISOString() : parameter
          );
          const rows = await transaction.unsafe(statement, serialized as never[]);
          return rows as unknown as readonly Row[];
        },
      };
      const connection: RecordProductPostgresConnection = {
        query: executor.query.bind(executor),
        async transaction(callback) {
          return callback(executor);
        },
      };
      result = await use({
        handle: await verifyRecordProductPostgresHandle(connection),
        executor,
      });
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result as Result;
}

async function assertNoEligibleParentConflict(
  executor: RecordProductPostgresExecutor,
  now: Date,
): Promise<void> {
  const rows = await executor.query(
    `SELECT work.record_id
       FROM reflection_record_semantic_work AS work
       JOIN reflection_records AS record ON record.record_id = work.record_id
      WHERE record.disposition = 'available'
        AND work.change_reason = 'parent_conflict'
        AND (
          (work.state IN ('due', 'checkpointed', 'deferred')
            AND work.next_attempt_at <= $1)
          OR (work.state = 'claimed' AND work.lease_expires_at <= $1)
          OR (work.state = 'quarantined' AND work.recover_after <= $1)
        )
      LIMIT 1`,
    [now],
  );
  if (rows.length !== 0) {
    throw new Error("Reflection fairness fixture has a competing parent-conflict row");
  }
}

afterAll(async () => {
  await closeDirectDb();
});

describePostgres("Reflection semantic worker PostgreSQL liveness", () => {
  test("one model request completes two independently leased organization items", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    const db = getDirectDb();
    const handle = await verifyRecordProductPostgresHandle(
      createRecordProductPostgresConnection(db),
    );
    const semanticWork = new PostgresSemanticWorkStore({
      handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(23)),
    });
    const fixturePrefix = `runtime-integration:reflection-batch:${randomUUID()}`;
    const recordRefs = [`${fixturePrefix}:one`, `${fixturePrefix}:two`];
    let batchCalls = 0;
    const admittedClaims: DurableSleepClaim[] = [];
    const openSessions = new Set<string>();
    const closedSessions: string[] = [];
    const observedOutcomes: string[] = [];
    const openOrganizationAttempt = createReflectionOrganizationAttemptOpener({
      checkAvailable: async () => true,
      assertClaimCurrent: claim => semanticWork.isClaimCurrent(claim),
      async openAccess(identity, signal, claim) {
        expect(identity).toMatchObject({ family: "reflection", stage: "organization",
          workId: `sleep:${claim.logicalObjectRef}:${claim.generation}`, attemptId: claim.leaseToken });
        expect(signal.aborted).toBe(false);
        expect(await semanticWork.isClaimCurrent(claim)).toBe(true);
        admittedClaims.push(claim);
        openSessions.add(claim.recordRef);
        return {
          async assertCurrent() { expect(openSessions.has(claim.recordRef)).toBe(true); },
          async close() { openSessions.delete(claim.recordRef); closedSessions.push(claim.recordRef); },
        };
      },
      observe(observation) { observedOutcomes.push(observation.outcome); },
    });
    const viewFor = (recordRef: string): DurableSleepOrganizerView => ({
      changed: {
        handle: "R1",
        snapshot: {
          recordRef,
          observedContentFingerprint: `fingerprint:${recordRef}`,
          posture: "derived",
          anchors: ["room:integration"],
          statement: `Evidence ${recordRef}`,
          sourceRefs: [],
          childRecordRefs: [],
          structuralHeight: 0,
          lifecycle: "current",
        },
        dependency: { kind: "record", recordRef },
      },
      candidates: [{
        handle: "R2",
        snapshot: {
          recordRef: `${recordRef}:neighbor`,
          observedContentFingerprint: `fingerprint:${recordRef}:neighbor`,
          posture: "derived",
          anchors: ["room:integration"],
          statement: `Neighbor ${recordRef}`,
          sourceRefs: [],
          childRecordRefs: [],
          structuralHeight: 0,
          lifecycle: "current",
        },
        dependency: { kind: "record", recordRef: `${recordRef}:neighbor` },
      }],
      existingParents: [],
      maxSelectedChildren: 2,
    });
    const semantic: DurableSleepSemanticPort = {
      ...SEMANTIC,
      openOrganizationAttempt,
      loadOrganizerView: async (claim) => {
        expect(openSessions.has(claim.recordRef)).toBe(true);
        return { status: "ready", view: viewFor(claim.recordRef) };
      },
      invokeOrganizerBatch: async (claims) => {
        expect(claims).toHaveLength(2);
        expect(claims.every(claim => openSessions.has(claim.recordRef))).toBe(true);
        for (const claim of claims) expect(await semanticWork.isClaimCurrent(claim)).toBe(true);
        batchCalls += 1;
        return JSON.stringify({
          answers: claims.map((_, index) => ({
            question: `Q${index + 1}`,
            proposal: { operation: "no_change" },
          })),
        });
      },
      applyProposal: async ({ claim }) => {
        expect(openSessions.has(claim.recordRef)).toBe(true);
        expect(await semanticWork.isClaimCurrent(claim)).toBe(true);
        return {
          status: "applied", operation: "no_change", replayed: false,
          usage: { modelCalls: 0, visitedRecords: 0, createdRecords: 0, traversalWork: 0 },
        };
      },
    };

    try {
      for (const recordRef of recordRefs) {
        await db.$client.unsafe(
          `INSERT INTO reflection_records (
             record_id, lifecycle, structural_height, producer_policy_version,
             processing_generation, payload_version, disposition
           ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1, 'available')`,
          [recordRef],
        );
        await db.$client.unsafe(
          `INSERT INTO reflection_record_semantic_work (
             record_id, generation, completed_generation, change_reason, stage,
             state, attempt_count, next_attempt_at, due_since
           ) VALUES ($1, 1, 0, 'created', 'organization', 'checkpointed', 0,
                     now(), '2001-01-01T00:00:00.000Z')`,
          [recordRef],
        );
      }

      const result = await runDurableHierarchySleep({
        work: semanticWork,
        semantic,
        budget: {
          maxWorkItems: 2,
          hierarchy: {
            maxModelCalls: 2,
            maxVisitedRecords: 32,
            maxCreatedRecords: 2,
            maxTraversalWork: 32,
            maxStatementCharacters: 800,
          },
        },
      });
      expect(batchCalls).toBe(1);
      expect(admittedClaims.map(claim => claim.recordRef).sort()).toEqual([...recordRefs].sort());
      expect(closedSessions.sort()).toEqual([...recordRefs].sort());
      expect(openSessions.size).toBe(0);
      expect(observedOutcomes).toEqual(["completed", "completed"]);
      for (const claim of admittedClaims) expect(await semanticWork.isClaimCurrent(claim)).toBe(false);
      expect(result).toMatchObject({
        completed: 2,
        usage: { modelCalls: 1 },
        diagnostics: { modelBatches: 1, modelBatchItems: 2 },
      });
      const rows = await db.$client.unsafe(
        `SELECT state, completed_generation
           FROM reflection_record_semantic_work
          WHERE record_id = ANY($1::text[])
          ORDER BY record_id`,
        [recordRefs],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((row) =>
        row["state"] === "complete" && row["completed_generation"] === 1)).toBe(true);
    } finally {
      await db.$client.unsafe(
        `UPDATE reflection_records
            SET disposition = 'purged', updated_at = greatest(updated_at, now())
          WHERE record_id = ANY($1::text[]) AND disposition = 'available'`,
        [recordRefs],
      );
    }
  }, 15_000);

  test("yielded work rotates behind an untouched peer without losing backlog age", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ handle, executor }) => {
      const admittedAt = new Date("1900-01-01T00:00:00.000Z");
      let now = admittedAt;
      const semanticWork = new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(29)),
        clock: () => now,
      });
      const fixturePrefix = `runtime-integration:reflection-fairness:${randomUUID()}`;
      const firstRecordRef = `${fixturePrefix}:first`;
      const secondRecordRef = `${fixturePrefix}:second`;
      const recordRefs = [firstRecordRef, secondRecordRef];

      await assertNoEligibleParentConflict(executor, now);
      for (const recordRef of recordRefs) {
        await executor.query(
          `INSERT INTO reflection_records (
             record_id, lifecycle, structural_height, producer_policy_version,
             processing_generation, payload_version, disposition,
             created_at, updated_at
           ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1,
                     'available', $2, $2)`,
          [recordRef, now.toISOString()],
        );
        await semanticWork.enqueue({
          logicalObjectRef: recordRef,
          generation: 1,
          recordRef,
          changeReason: "parent_conflict",
        });
        now = new Date(now.getTime() + 1);
      }

      const first = await semanticWork.claimNext();
      expect(first).toMatchObject({
        status: "claimed",
        claim: { recordRef: firstRecordRef },
      });
      if (first.status !== "claimed") throw new Error("expected first fairness claim");
      const preservedDueSince = first.claim.timing?.admittedAtEpochMs ?? Number.NaN;
      expect(preservedDueSince).toBe(admittedAt.getTime());

      now = new Date(now.getTime() + 1);
      expect(await semanticWork.pause({
        claim: first.claim,
        nextAttemptAt: now.getTime() + 1,
      })).toMatchObject({ status: "accepted" });
      now = new Date(now.getTime() + 1);

      const untouched = await semanticWork.claimNext();
      expect(untouched).toMatchObject({
        status: "claimed",
        claim: { recordRef: secondRecordRef },
      });
      if (untouched.status !== "claimed") throw new Error("expected untouched fairness claim");
      expect(await semanticWork.pause({
        claim: untouched.claim,
        nextAttemptAt: now.getTime() + 1,
      })).toMatchObject({ status: "accepted" });
      now = new Date(now.getTime() + 1);

      const rotated = await semanticWork.claimNext();
      expect(rotated).toMatchObject({
        status: "claimed",
        claim: { recordRef: firstRecordRef },
      });
      if (rotated.status !== "claimed") throw new Error("expected rotated fairness claim");
      expect(rotated.claim.timing?.admittedAtEpochMs).toBe(preservedDueSince);

      const [row] = await executor.query(
        `SELECT due_since FROM reflection_record_semantic_work WHERE record_id = $1`,
        [firstRecordRef],
      );
      expect(new Date(String(row?.["due_since"])).getTime()).toBe(preservedDueSince);
    });
  }, 15_000);

  test("a 610-second semantic lease stays current beyond two minutes and expires exactly", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ handle, executor }) => {
      const claimedAt = new Date("1900-01-02T00:00:00.000Z");
      const leaseMilliseconds = 600_000 + 10_000;
      let now = claimedAt;
      const semanticWork = new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(31)),
        clock: () => now,
        leaseMilliseconds,
      });
      const recordRef = `runtime-integration:reflection-lease:${randomUUID()}`;

      await assertNoEligibleParentConflict(executor, now);
      await executor.query(
        `INSERT INTO reflection_records (
           record_id, lifecycle, structural_height, producer_policy_version,
           processing_generation, payload_version, disposition,
           created_at, updated_at
         ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1,
                   'available', $2, $2)`,
        [recordRef, claimedAt.toISOString()],
      );
      await semanticWork.enqueue({
        logicalObjectRef: recordRef,
        generation: 1,
        recordRef,
        changeReason: "parent_conflict",
      });
      const claimed = await semanticWork.claimNext();
      expect(claimed).toMatchObject({
        status: "claimed",
        claim: { recordRef },
      });
      if (claimed.status !== "claimed") throw new Error("expected lease-boundary claim");

      now = new Date(claimedAt.getTime() + 120_001);
      expect(await semanticWork.isClaimCurrent(claimed.claim)).toBe(true);
      now = new Date(claimedAt.getTime() + leaseMilliseconds - 1);
      expect(await semanticWork.isClaimCurrent(claimed.claim)).toBe(true);
      now = new Date(claimedAt.getTime() + leaseMilliseconds);
      expect(await semanticWork.isClaimCurrent(claimed.claim)).toBe(false);
    });
  }, 15_000);

  test("legacy quarantine recovery is one same-generation policy attempt across restart", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ handle, executor }) => {
      let now = new Date("1900-01-03T00:00:00.000Z");
      const recordRef = `runtime-integration:reflection-policy:${randomUUID()}`;
      await assertNoEligibleParentConflict(executor, now);
      await executor.query(
        `INSERT INTO reflection_records (
           record_id, lifecycle, structural_height, producer_policy_version,
           processing_generation, payload_version, disposition, created_at, updated_at
         ) VALUES ($1, 'current', 1, 'runtime-integration', 1, 1, 'available', $2, $2)`,
        [recordRef, now],
      );
      await executor.query(
        `INSERT INTO reflection_record_semantic_work (
           record_id, generation, completed_generation, change_reason, stage, state,
           attempt_count, quarantine_round, recovery_policy_version, recover_after,
           failure_code, due_since, created_at, updated_at
         ) VALUES ($1, 4, 3, 'scheduled_review', 'authority_projection', 'quarantined',
                   8, 1, 0, $3, 'authority_unavailable', $2, $2, $2)`,
        [recordRef, now, new Date(now.getTime() + 86_400_000)],
      );
      const createStore = () => new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(41)),
        clock: () => now,
      });
      let store = createStore();
      let claimed = await store.claimNext();
      expect(claimed).toMatchObject({
        status: "claimed",
        claim: { recordRef, generation: 4, changeReason: "dependency_lost" },
      });
      if (claimed.status !== "claimed") throw new Error("expected legacy recovery claim");
      let row = (await executor.query(
        `SELECT generation, quarantine_round, recovery_policy_version, attempt_count
           FROM reflection_record_semantic_work WHERE record_id = $1`,
        [recordRef],
      ))[0];
      expect(row).toMatchObject({
        generation: 4,
        quarantine_round: 1,
        recovery_policy_version: 2,
        attempt_count: 1,
      });

      for (let expectedAttempt = 2; expectedAttempt <= 8; expectedAttempt += 1) {
        expect(await store.defer({
          claim: claimed.claim,
          failureCode: "authority_unavailable",
        })).toEqual({ status: "deferred" });
        const [scheduled] = await executor.query(
          `SELECT next_attempt_at FROM reflection_record_semantic_work WHERE record_id = $1`,
          [recordRef],
        );
        now = new Date(String(scheduled?.["next_attempt_at"]));
        claimed = await store.claimNext();
        expect(claimed).toMatchObject({
          status: "claimed",
          claim: { recordRef, generation: 4, changeReason: "dependency_lost" },
        });
        if (claimed.status !== "claimed") throw new Error("expected bounded retry claim");
        row = (await executor.query(
          `SELECT attempt_count FROM reflection_record_semantic_work WHERE record_id = $1`,
          [recordRef],
        ))[0];
        expect(row?.["attempt_count"]).toBe(expectedAttempt);
      }
      expect(await store.defer({
        claim: claimed.claim,
        failureCode: "authority_unavailable",
      })).toEqual({ status: "quarantined" });
      store = createStore();
      // Reconstructing the store must derive eligibility only from the durable
      // policy stamp and deadline; this transaction may share the clone with
      // unrelated eligible work, so never issue an unscoped claim here.
      expect(store).toBeInstanceOf(PostgresSemanticWorkStore);
      row = (await executor.query(
        `SELECT generation, quarantine_round, recovery_policy_version, recover_after,
                (recover_after <= $2 OR recovery_policy_version < 2) AS eligible
           FROM reflection_record_semantic_work WHERE record_id = $1`,
        [recordRef, now],
      ))[0];
      expect(row).toMatchObject({
        generation: 4,
        quarantine_round: 2,
        recovery_policy_version: 2,
        eligible: false,
      });
      expect(new Date(String(row?.["recover_after"])).getTime()).toBeGreaterThan(now.getTime());
    });
  }, 15_000);

  test("old eligible quarantine takes its turn before continuous fresh higher-priority arrivals", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ handle, executor }) => {
      let now = new Date("1900-01-04T00:00:00.000Z");
      const prefix = `runtime-integration:reflection-oldest:${randomUUID()}`;
      const oldRef = `${prefix}:old`;
      await assertNoEligibleParentConflict(executor, now);
      await executor.query(
        `INSERT INTO reflection_records (
           record_id, lifecycle, structural_height, producer_policy_version,
           processing_generation, payload_version, disposition, created_at, updated_at
         ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1, 'available', $2, $2)`,
        [oldRef, now],
      );
      await executor.query(
        `INSERT INTO reflection_record_semantic_work (
           record_id, generation, completed_generation, change_reason, stage, state,
           attempt_count, quarantine_round, recovery_policy_version, recover_after,
           failure_code, due_since, created_at, updated_at
         ) VALUES ($1, 2, 1, 'scheduled_review', 'authority_projection', 'quarantined',
                   8, 1, 0, $3, 'candidate_unavailable', $2, $2, $2)`,
        [oldRef, now, new Date(now.getTime() + 86_400_000)],
      );
      const store = new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(43)),
        clock: () => now,
      });
      for (let index = 0; index < 3; index += 1) {
        now = new Date(now.getTime() + 1);
        const freshRef = `${prefix}:fresh:${index}`;
        await executor.query(
          `INSERT INTO reflection_records (
             record_id, lifecycle, structural_height, producer_policy_version,
             processing_generation, payload_version, disposition, created_at, updated_at
           ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1, 'available', $2, $2)`,
          [freshRef, now],
        );
        await store.enqueue({
          logicalObjectRef: freshRef,
          generation: 1,
          recordRef: freshRef,
          changeReason: "parent_conflict",
        });
      }
      expect(await store.claimNext()).toMatchObject({
        status: "claimed",
        claim: { recordRef: oldRef, generation: 2 },
      });
    });
  }, 15_000);

  test("canonical lifecycle and topology settle missing-projection work before execution", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ handle, executor }) => {
      let now = new Date("1900-01-05T00:00:00.000Z");
      const prefix = `runtime-integration:reflection-settlement:${randomUUID()}`;
      const obsoleteRef = `${prefix}:obsolete`;
      const coveredRef = `${prefix}:covered`;
      const parentRef = `${prefix}:parent`;
      await assertNoEligibleParentConflict(executor, now);
      for (const [recordRef, lifecycle] of [
        [obsoleteRef, "superseded"],
        [coveredRef, "current"],
        [parentRef, "current"],
      ] as const) {
        await executor.query(
          `INSERT INTO reflection_records (
             record_id, lifecycle, structural_height, producer_policy_version,
             processing_generation, payload_version, disposition, created_at, updated_at
           ) VALUES ($1, $2, 0, 'runtime-integration', 1, 1, 'available', $3, $3)`,
          [recordRef, lifecycle, now],
        );
      }
      await executor.query(
        `INSERT INTO reflection_record_dependencies (parent_record_id, child_record_id)
         VALUES ($1, $2)`,
        [parentRef, coveredRef],
      );
      await executor.query(
        `INSERT INTO reflection_record_semantic_work (
           record_id, generation, completed_generation, change_reason, stage, state,
           attempt_count, next_attempt_at, due_since, created_at, updated_at
         ) VALUES
           ($1, 1, 0, 'revised', 'authority_projection', 'due', 0, $3, $3, $3, $3),
           ($2, 1, 0, 'created', 'authority_projection', 'due', 0, $3, $3, $3, $3)`,
        [obsoleteRef, coveredRef, now],
      );
      const store = new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(47)),
        clock: () => now,
      });
      const obsolete = await store.claimNext();
      expect(obsolete).toMatchObject({ status: "claimed", claim: { recordRef: obsoleteRef } });
      if (obsolete.status !== "claimed") throw new Error("expected obsolete claim");
      expect(await store.settleCurrentState({ claim: obsolete.claim })).toMatchObject({
        status: "settled",
        reason: "record_lifecycle_obsolete",
      });
      now = new Date(now.getTime() + 1);
      const covered = await store.claimNext();
      expect(covered).toMatchObject({ status: "claimed", claim: { recordRef: coveredRef } });
      if (covered.status !== "claimed") throw new Error("expected covered claim");
      expect(await store.settleCurrentState({ claim: covered.claim })).toMatchObject({
        status: "settled",
        reason: "already_covered",
      });
      const outcomes = await executor.query(
        `SELECT record_id, completion_outcome
           FROM reflection_record_semantic_work
          WHERE record_id = ANY($1::text[])
          ORDER BY record_id`,
        [[obsoleteRef, coveredRef]],
      );
      expect(outcomes.map(row => row["completion_outcome"]).sort()).toEqual([
        "already_covered",
        "record_lifecycle_obsolete",
      ]);
      const projections = await executor.query(
        `SELECT record_id FROM reflection_record_search_projections
          WHERE record_id = ANY($1::text[])`,
        [[obsoleteRef, coveredRef]],
      );
      expect(projections).toHaveLength(0);
    });
  }, 15_000);

  test("legacy completed projection receives one real refresh generation and completes at search", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ handle, executor }) => {
      let now = new Date("1900-01-06T00:00:00.000Z");
      const fixturePrefix = `zzzz-runtime-integration:reflection-projection-refresh:${randomUUID()}`;
      const recordRef = `${fixturePrefix}:target`;
      await assertNoEligibleParentConflict(executor, now);
      await executor.query(
        `INSERT INTO reflection_records (
           record_id, lifecycle, structural_height, producer_policy_version,
           processing_generation, payload_version, disposition, created_at, updated_at
         ) VALUES ($1, 'current', 1, 'runtime-integration', 1, 1, 'available', $2, $2)`,
        [recordRef, now],
      );
      await executor.query(
        `INSERT INTO reflection_record_semantic_work (
           record_id, generation, completed_generation, change_reason, stage, state,
           attempt_count, completion_outcome, due_since, completed_at, created_at, updated_at
         ) VALUES ($1, 1, 1, 'scheduled_review', 'organization', 'complete', 0,
                   'completed', $2, $2, $2, $2)`,
        [recordRef, now],
      );
      await executor.query(
        `INSERT INTO reflection_record_search_projections (
           record_id, record_processing_generation, projection_generation,
           embedding_provider, embedding_canonical_model, embedding_dimensions,
           embedding_contract_version, embedding, created_at, updated_at
         ) VALUES ($1, 1, 1, 'integration', 'integration', 1536, 1,
                   array_fill(0.1::real, ARRAY[1536])::vector, $2, $2)`,
        [recordRef, now],
      );
      const store = new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(53)),
        clock: () => now,
      });
      expect(await store.admitMissingRoomProjectionPage({
        limit: 1,
        policyVersion: "room-anchor-v1",
        continuation: fixturePrefix,
      })).toMatchObject({ admitted: 1 });
      let claim = await store.claimNext();
      expect(claim).toMatchObject({
        status: "claimed",
        claim: {
          recordRef,
          generation: 2,
          changeReason: "scheduled_review",
          projectionRefreshOnly: true,
        },
      });
      if (claim.status !== "claimed") throw new Error("expected projection authority claim");
      expect(await store.defer({
        claim: claim.claim,
        failureCode: "authority_unavailable",
      })).toEqual({ status: "deferred" });
      const [scheduled] = await executor.query(
        `SELECT next_attempt_at FROM reflection_record_semantic_work WHERE record_id = $1`,
        [recordRef],
      );
      now = new Date(String(scheduled?.["next_attempt_at"]));
      claim = await store.claimNext();
      expect(claim).toMatchObject({
        status: "claimed",
        claim: {
          recordRef,
          generation: 2,
          changeReason: "scheduled_review",
          projectionRefreshOnly: true,
        },
      });
      if (claim.status !== "claimed") throw new Error("expected retried projection authority claim");
      expect(await store.checkpoint({
        claim: claim.claim,
        completedStage: "authority_projection",
      })).toMatchObject({ status: "accepted" });
      claim = await store.claimNext();
      expect(claim).toMatchObject({
        status: "claimed",
        claim: { recordRef, generation: 2, stage: "search_projection", projectionRefreshOnly: true },
      });
      if (claim.status !== "claimed") throw new Error("expected projection search claim");
      expect(await store.checkpoint({
        claim: claim.claim,
        completedStage: "search_projection",
      })).toMatchObject({ status: "accepted" });
      const [row] = await executor.query(
        `SELECT generation, completed_generation, stage, state,
                projection_refresh_only, completion_outcome
           FROM reflection_record_semantic_work WHERE record_id = $1`,
        [recordRef],
      );
      expect(row).toMatchObject({
        generation: 2,
        completed_generation: 2,
        stage: "search_projection",
        state: "complete",
        projection_refresh_only: true,
        completion_outcome: "completed",
      });
      await executor.query(
        `DELETE FROM reflection_record_search_projections WHERE record_id = $1`,
        [recordRef],
      );
      expect(await store.admitMissingRoomProjectionPage({
        limit: 1,
        policyVersion: "room-anchor-v1",
        continuation: fixturePrefix,
      })).toMatchObject({ admitted: 1 });
      expect(await store.admitMissingRoomProjectionPage({
        limit: 1,
        policyVersion: "room-anchor-v1",
        continuation: fixturePrefix,
      })).toMatchObject({ admitted: 0 });
      const [readmitted] = await executor.query(
        `SELECT work.generation, work.completed_generation, work.state,
                work.projection_refresh_only, record.processing_generation
           FROM reflection_record_semantic_work AS work
           JOIN reflection_records AS record ON record.record_id = work.record_id
          WHERE work.record_id = $1`,
        [recordRef],
      );
      expect(readmitted).toMatchObject({
        generation: 3,
        completed_generation: 2,
        state: "due",
        projection_refresh_only: true,
        processing_generation: 1,
      });
    });
  }, 15_000);

  test("migration guard normalizes legacy completion and subsequent admission writes", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ executor }) => {
      const now = new Date("1900-01-07T00:00:00.000Z");
      const recordRef = `runtime-integration:reflection-legacy-writer:${randomUUID()}`;
      const leaseToken = randomUUID();
      await executor.query(
        `INSERT INTO reflection_records (
           record_id, lifecycle, structural_height, producer_policy_version,
           processing_generation, payload_version, disposition, created_at, updated_at
         ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1, 'available', $2, $2)`,
        [recordRef, now],
      );
      await executor.query(
        `INSERT INTO reflection_record_semantic_work (
           record_id, generation, completed_generation, change_reason, stage, state,
           claim_generation, attempt_count, lease_token, lease_expires_at,
           due_since, started_at, created_at, updated_at
         ) VALUES ($1, 1, 0, 'created', 'organization', 'claimed', 1, 1, $2, $3,
                   $4, $4, $4, $4)`,
        [recordRef, leaseToken, new Date(now.getTime() + 60_000), now],
      );
      // Deliberately mirrors the pre-migration writer: no additive diagnostic
      // or completion-outcome columns are named.
      await executor.query(
        `UPDATE reflection_record_semantic_work
            SET state = 'complete', completed_generation = generation,
                claim_generation = NULL, lease_token = NULL, lease_expires_at = NULL,
                next_attempt_at = NULL, quarantine_round = 0, recover_after = NULL,
                failure_code = NULL, ordinary_fallback_reason = NULL,
                completed_at = $2, updated_at = $2
          WHERE record_id = $1`,
        [recordRef, now],
      );
      let row = (await executor.query(
        `SELECT state, completion_outcome FROM reflection_record_semantic_work
          WHERE record_id = $1`,
        [recordRef],
      ))[0];
      expect(row).toMatchObject({ state: "complete", completion_outcome: "completed" });
      await executor.query(
        `UPDATE reflection_record_semantic_work
            SET generation = generation + 1, change_reason = 'revised',
                stage = 'authority_projection', state = 'due', claim_generation = NULL,
                attempt_count = 0, quarantine_round = 0, lease_token = NULL,
                lease_expires_at = NULL, next_attempt_at = $2, recover_after = NULL,
                failure_code = NULL, ordinary_fallback_reason = NULL,
                due_since = $2, started_at = NULL, completed_at = NULL, updated_at = $2
          WHERE record_id = $1`,
        [recordRef, new Date(now.getTime() + 1)],
      );
      row = (await executor.query(
        `SELECT generation, state, completion_outcome, failure_detail,
                waiting_reason, projection_refresh_only
           FROM reflection_record_semantic_work WHERE record_id = $1`,
        [recordRef],
      ))[0];
      expect(row).toMatchObject({
        generation: 2,
        state: "due",
        completion_outcome: null,
        failure_detail: null,
        waiting_reason: null,
        projection_refresh_only: false,
      });
    });
  }, 15_000);

  test.each([
    ["stage", "stage = 'authority_projection'"],
    ["lease", `lease_token = '${randomUUID()}'::uuid`],
    ["generation", "generation = generation + 2"],
  ] as const)("migration guard rejects unverified %s alteration", async (_kind, mutation) => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    await withIsolatedRecordProductTransaction(async ({ executor }) => {
      const now = new Date("1900-01-08T00:00:00.000Z");
      const recordRef = `runtime-integration:reflection-guard:${randomUUID()}`;
      await executor.query(
        `INSERT INTO reflection_records (
           record_id, lifecycle, structural_height, producer_policy_version,
           processing_generation, payload_version, disposition, created_at, updated_at
         ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1, 'available', $2, $2)`,
        [recordRef, now],
      );
      await executor.query(
        `INSERT INTO reflection_record_semantic_work (
           record_id, generation, completed_generation, change_reason, stage, state,
           attempt_count, next_attempt_at, due_since, created_at, updated_at
         ) VALUES ($1, 1, 0, 'created', 'organization', 'checkpointed', 0, $2, $2, $2, $2)`,
        [recordRef, now],
      );
      await Promise.resolve(expect(executor.query(
        `UPDATE reflection_record_semantic_work SET ${mutation} WHERE record_id = $1`,
        [recordRef],
      )).rejects.toThrow());
    });
  }, 15_000);

  test("a full bootstrap page cannot starve an expired lease or Sleep", async () => {
    if (connectionString === undefined) throw new Error("missing integration database URL");
    process.env["DB_DIRECT_CONNECTION"] = connectionString;
    const db = getDirectDb();
    const handle = await verifyRecordProductPostgresHandle(
      createRecordProductPostgresConnection(db),
    );
    await db.$client.unsafe(
      `UPDATE reflection_records
          SET disposition = 'purged', updated_at = greatest(updated_at, now())
        WHERE record_id LIKE 'runtime-integration:reflection-liveness:%'
          AND disposition = 'available'`,
    );
    const fixturePrefix = `runtime-integration:reflection-liveness:${randomUUID()}`;
    const missingRecordRefs = Array.from(
      { length: 17 },
      (_, index) => `${fixturePrefix}:missing:${index}`,
    );
    const expiredRecordRef = `${fixturePrefix}:expired`;
    const now = new Date("2001-01-01T00:00:00.000Z");
    const leaseToken = randomUUID();
    let worker: ReflectionSemanticWorker | undefined;

    try {
      for (const recordRef of [...missingRecordRefs, expiredRecordRef]) {
        await db.$client.unsafe(
          `INSERT INTO reflection_records (
             record_id, lifecycle, structural_height, producer_policy_version,
             processing_generation, payload_version, disposition,
             created_at, updated_at
           ) VALUES ($1, 'current', 0, 'runtime-integration', 1, 1,
                     'available', $2, $2)`,
          [recordRef, now.toISOString()],
        );
      }
      await db.$client.unsafe(
        `INSERT INTO reflection_record_semantic_work (
           record_id, generation, completed_generation, change_reason, stage,
           state, claim_generation, attempt_count, lease_token, lease_expires_at,
           due_since, started_at, created_at, updated_at
         ) VALUES ($1, 1, 0, 'created', 'authority_projection',
                   'claimed', 1, 1, $2, $3, $4, $4, $4, $4)`,
        [
          expiredRecordRef,
          leaseToken,
          new Date(now.getTime() - 1).toISOString(),
          new Date(now.getTime() - 1_000).toISOString(),
        ],
      );

      const semanticWork = new PostgresSemanticWorkStore({
        handle,
        commitments: createHmacRecordSemanticCommitmentPort(
          new Uint8Array(32).fill(19),
        ),
        clock: () => now,
      });
      worker = new ReflectionSemanticWorker({
        maintenanceGate: { isAcceptingWork: async () => true },
        work: semanticWork,
        semantic: SEMANTIC,
        budget: {
          maxWorkItems: 16,
          hierarchy: {
            maxModelCalls: 1,
            maxVisitedRecords: 16,
            maxCreatedRecords: 1,
            maxTraversalWork: 16,
            maxStatementCharacters: 800,
          },
        },
        bootstrap: {
          bootstrapPage: (input) => semanticWork.bootstrapPage(input),
        },
        readPressure: async () => {
          const health = await semanticWork.health();
          return {
            backlog: health.backlog,
            ready: health.ready,
            oldestDueAt: health.oldestDueAt,
          };
        },
      }, {
        scanIntervalMs: 60_000,
        catchUpIntervalMs: 1_000,
        pressure: { backlogGrowthPolls: 2, pressureProbeIntervalMs: 60_000 },
      });

      worker.start();
      await waitForFirstPoll(worker);
      expect(worker.getHealth()).toMatchObject({
        state: "cooldown",
        pauseReason: null,
        lastPoll: { claims: 16 },
      });
      const [expiredRow] = await db.$client.unsafe(
        `SELECT state, stage FROM reflection_record_semantic_work WHERE record_id = $1`,
        [expiredRecordRef],
      );
      expect(expiredRow?.["state"]).toBe("checkpointed");
      const expiredStage: unknown = expiredRow?.["stage"];
      if (typeof expiredStage !== "string") {
        throw new TypeError("expired semantic-work stage is not a string");
      }
      expect(["search_projection", "organization"]).toContain(
        expiredStage,
      );
      const [remainingRow] = await db.$client.unsafe(
        `SELECT count(*)::integer AS count
           FROM reflection_records AS record
           LEFT JOIN reflection_record_semantic_work AS work
             ON work.record_id = record.record_id
          WHERE record.record_id = ANY($1::text[]) AND work.record_id IS NULL`,
        [missingRecordRefs],
      );
      expect(remainingRow?.["count"]).toBe(1);
    } finally {
      await worker?.stop();
      await db.$client.unsafe(
        `UPDATE reflection_record_semantic_work
            SET state = 'quarantined', claim_generation = NULL,
                lease_token = NULL, lease_expires_at = NULL,
                next_attempt_at = NULL, failure_code = 'retry_exhausted',
                quarantine_round = quarantine_round + 1,
                recover_after = now() + interval '7 days',
                completed_at = NULL, updated_at = greatest(updated_at, now())
          WHERE record_id LIKE $1
            AND state IN ('due', 'claimed', 'checkpointed', 'deferred')`,
        [`${fixturePrefix}%`],
      );
      await db.$client.unsafe(
        `UPDATE reflection_records
            SET disposition = 'purged',
                updated_at = greatest(updated_at, now())
          WHERE record_id LIKE $1 AND disposition = 'available'`,
        [`${fixturePrefix}%`],
      );
    }
  }, 15_000);
});
