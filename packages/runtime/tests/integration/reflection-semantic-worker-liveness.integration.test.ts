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
