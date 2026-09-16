import { describe, expect, test } from "bun:test";

import type { DurableSleepClaim } from "@nautilo/reflection";
import type { DurableRecordPublication } from "@nautilo/reflection/durable";

import {
  admitSemanticWorkWithinTransaction,
  createHmacRecordSemanticCommitmentPort,
  PostgresSemanticWorkStore,
} from "../../src/server/postgres-semantic-work-store";
import {
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
} from "../../src/server/product-postgres";

type Query = Readonly<{
  statement: string;
  parameters?: readonly RecordProductPostgresScalar[];
}>;

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

function publication(
  predecessor = false,
  structuralHeight = 0,
): DurableRecordPublication {
  return {
    record: {
      recordRef: "record:new",
      lifecycle: "current",
      structuralHeight,
      processingGeneration: 1,
      semantic: {
        observedContentFingerprint: "sha256:record",
        posture: "derived",
        statement: "not persisted in semantic work",
        sourceDependencies: [{
          sourceKind: "memory",
          logicalSourceRef: "memory:private-value",
          observedRevision: "2",
          observedContentFingerprint: "sha256:memory",
          terminalAuthorityLeafHandle: "namespace:private",
          authorityBearing: true,
        }],
        anchors: [],
        childRecordRefs: [],
        producer: { producerRef: "organizer", policyVersion: "v1" },
        terminalAuthorityLeafHandles: ["namespace:private"],
      },
    },
    ...(predecessor
      ? { predecessor: { recordRef: "record:old", relation: "supersedes" as const } }
      : {}),
    idempotencyKey: "publication:one",
    publicationBindingRef: "binding:one",
  };
}

async function verifiedConnection(
  query: RecordProductPostgresConnection["query"],
): Promise<Readonly<{
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>;
  queries: Query[];
}>> {
  const queries: Query[] = [];
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly RecordProductPostgresScalar[],
    ) {
      if (statement.startsWith("SELECT current_user")) {
        return [{
          current_role: "nautilo",
          session_role: "nautilo",
        }] as unknown as Row[];
      }
      queries.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
      return query<Row>(statement, parameters);
    },
    async transaction<Result>(callback: (tx: RecordProductPostgresExecutor) => Promise<Result>) {
      return callback(connection);
    },
  };
  return { handle: await verifyRecordProductPostgresHandle(connection), queries };
}

describe("PostgreSQL semantic work commitments and admission", () => {
  test("uses domain-separated stable HMACs without exposing source identity", () => {
    const commitments = createHmacRecordSemanticCommitmentPort(
      new Uint8Array(32).fill(17),
    );
    const first = commitments.sourceDependency({
      sourceKind: "memory",
      logicalSourceRef: "memory:private-value",
    });
    const replay = commitments.sourceDependency({
      sourceKind: "memory",
      logicalSourceRef: "memory:private-value",
    });
    const changed = commitments.sourceDependency({
      sourceKind: "memory",
      logicalSourceRef: "memory:other",
    });
    expect(first).toEqual(replay);
    expect(first).not.toEqual(changed);
    expect(first.byteLength).toBe(32);
    expect(new TextDecoder().decode(first)).not.toContain("private-value");
    expect(commitments.sourceChange({
      sourceKind: "memory",
      logicalSourceRef: "memory:private-value",
      changeRef: "revision:2",
    })).not.toEqual(first);
    expect(commitments.recordChange({
      recordRef: "record:private-value",
      changeRef: "superseded:record:new",
    })).not.toEqual(first);
    expect(Buffer.from(commitments.publication({ publication: publication() })).toString("hex"))
      .toBe("8b4c2538a55f5f55d9ec04385e28b95f7ba96830904ee2d775f86a5ea6a40e3d");
    expect(commitments.promotionBootstrap({
      recordRef: "record:one",
      processingGeneration: 1,
    })).not.toEqual(commitments.bootstrap({
      recordRef: "record:one",
      processingGeneration: 1,
    }));
    expect(commitments.candidatePolicyRecovery({
      recordRef: "record:one",
      processingGeneration: 1,
      policyVersion: "authority-aware-parent-normalization-v1",
    })).not.toEqual(commitments.bootstrap({
      recordRef: "record:one",
      processingGeneration: 1,
    }));
    const parents = [
      { recordRef: "record:parent-b", processingGeneration: 2 },
      { recordRef: "record:parent-a", processingGeneration: 1 },
    ];
    const conflict = commitments.parentConflict({
      childRecordRef: "record:child",
      parents,
    });
    expect(conflict).toEqual(commitments.parentConflict({
      childRecordRef: "record:child",
      parents: [...parents].reverse(),
    }));
    expect(commitments.parentConflictRebuild({
      childRecordRef: "record:child",
      supportRecordRef: "record:support",
      parents,
    })).not.toEqual(conflict);
  });

  test("replays exact changes and assigns one next generation per distinct change", async () => {
    const receipts = new Map<string, number>();
    let generation: number | undefined;
    let reason = "created";
    let state = "due";
    let lastWorkMutationParameters: readonly RecordProductPostgresScalar[] = [];
    let lastWorkMutationStatement = "";
    const tx: RecordProductPostgresExecutor = {
      async query<Row extends RecordProductPostgresRow>(
        statement: string,
        parameters?: readonly RecordProductPostgresScalar[],
      ) {
        if (statement.includes("pg_advisory_xact_lock")) return [];
        const normalized = normalizedSql(statement);
        if (normalized.includes("select assigned_generation")) {
          const commitment = Buffer.from(parameters?.[1] as Uint8Array).toString("hex");
          const assigned = receipts.get(commitment);
          return (assigned === undefined ? [] : [{ assigned_generation: assigned }]) as unknown as Row[];
        }
        if (normalized.includes("select generation") && normalized.includes("for update")) {
          return (generation === undefined ? [] : [{ generation, change_reason: reason, state }]) as unknown as Row[];
        }
        if (normalized.includes("insert into reflection_record_semantic_work_admissions")) {
          const commitment = Buffer.from(parameters?.[1] as Uint8Array).toString("hex");
          receipts.set(commitment, parameters?.[2] as number);
          return [];
        }
        if (normalized.includes("insert into reflection_record_semantic_work")) {
          generation = parameters?.[1] as number;
          reason = parameters?.find((value) => typeof value === "string" && [
            "scheduled_review", "created", "revised", "dependency_lost", "parent_conflict",
          ].includes(value)) as string;
          return [];
        }
        if (normalized.includes("update reflection_record_semantic_work")) {
          generation = parameters?.find((value) => typeof value === "number") as number;
          lastWorkMutationStatement = normalized;
          lastWorkMutationParameters = parameters ?? [];
          reason = parameters?.find((value) => typeof value === "string" && [
            "scheduled_review", "created", "revised", "dependency_lost", "parent_conflict",
          ].includes(value)) as string;
          state = "due";
          return [];
        }
        throw new Error(`unexpected SQL: ${statement}`);
      },
    };
    const now = new Date("2026-08-14T10:00:00.000Z");
    const firstCommitment = new Uint8Array(32).fill(1);
    const nextCommitment = new Uint8Array(32).fill(2);
    expect(await admitSemanticWorkWithinTransaction(tx, {
      recordRef: "record:one",
      changeReason: "created",
      admissionCommitment: firstCommitment,
      now,
    })).toEqual({ admitted: true, generation: 1 });
    expect(await admitSemanticWorkWithinTransaction(tx, {
      recordRef: "record:one",
      changeReason: "created",
      admissionCommitment: firstCommitment,
      now,
    })).toEqual({ admitted: false, generation: 1 });
    expect(await admitSemanticWorkWithinTransaction(tx, {
      recordRef: "record:one",
      changeReason: "dependency_lost",
      admissionCommitment: nextCommitment,
      now,
    })).toEqual({ admitted: true, generation: 2 });
    expect(generation).toBe(2);
    expect(await admitSemanticWorkWithinTransaction(tx, {
      recordRef: "record:one",
      changeReason: "scheduled_review",
      admissionCommitment: new Uint8Array(32).fill(3),
      now,
      notBefore: new Date(now.getTime() + 5 * 60 * 1_000),
    })).toEqual({ admitted: true, generation: 3 });
    expect(reason).toBe("dependency_lost");
    expect(lastWorkMutationStatement).toContain("ordinary_fallback_reason =");
    expect(lastWorkMutationParameters).toContain("dependency_lost");
    expect(lastWorkMutationParameters).not.toContain("scheduled_review");
  });
});

describe("PostgreSQL semantic work leases", () => {
  test("checks exact live claim metadata without reading payloads or changing work", async () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    let current = true;
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>() =>
      (current ? [{ record_id: "record:one" }] : []) as unknown as Row[]);
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });
    const claim: DurableSleepClaim = {
      logicalObjectRef: "record:one", recordRef: "record:one", generation: 3,
      changeReason: "revised", stage: "organization", leaseToken: "lease:one",
    };
    expect(await store.isClaimCurrent(claim)).toBe(true);
    current = false;
    expect(await store.isClaimCurrent(claim)).toBe(false);
    const query = value.queries[0]!;
    const statement = normalizedSql(query.statement);
    expect(statement).toContain(
      "from reflection_record_semantic_work inner join reflection_records",
    );
    expect(statement).toContain("select reflection_record_semantic_work.record_id");
    for (const column of ["record_id", "generation", "claim_generation", "lease_token", "state", "stage", "change_reason"]) {
      expect(statement).toContain(`reflection_record_semantic_work.${column} =`);
    }
    expect(statement).toContain("reflection_record_semantic_work.lease_expires_at >");
    expect(statement).toContain("reflection_records.disposition =");
    expect(query.parameters).toEqual(["record:one", 3, 3, "lease:one", "claimed", "organization", "revised", now.toISOString(), "available"]);
    expect(statement).not.toContain("for update");
    expect(value.queries).toHaveLength(2);
    expect(await store.isClaimCurrent({ ...claim, logicalObjectRef: "record:other" })).toBe(false);
    expect(value.queries).toHaveLength(2);
  });

  test("does not enter a publication callback for mismatched or stale claims", async () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>() =>
      [] as Row[]);
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });
    const claim: DurableSleepClaim = {
      logicalObjectRef: "record:one", recordRef: "record:one", generation: 3,
      changeReason: "revised", stage: "organization", leaseToken: "lease:one",
    };
    let callbacks = 0;
    const use = async () => {
      callbacks += 1;
      return "published";
    };

    expect(await store.withClaimPublicationFence(
      { ...claim, logicalObjectRef: "record:other" },
      use,
    )).toEqual({ status: "stale" });
    expect(value.queries).toEqual([]);
    expect(await store.withClaimPublicationFence(claim, use)).toEqual({ status: "stale" });
    expect(callbacks).toBe(0);
    expect(value.queries).toHaveLength(1);
  });

  test("locks the exact work row before entering a publication callback", async () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    const events: string[] = [];
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      if (normalizedSql(statement).startsWith("select")) {
        events.push("lock");
        return [{
          record_id: "record:one",
          lease_expires_at: new Date(now.getTime() + 30_000),
        }] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });
    const claim: DurableSleepClaim = {
      logicalObjectRef: "record:one", recordRef: "record:one", generation: 3,
      changeReason: "revised", stage: "organization", leaseToken: "lease:one",
    };

    expect(await store.withClaimPublicationFence(claim, async () => {
      events.push("callback");
      return "published";
    })).toEqual({ status: "current", value: "published" });
    expect(events).toEqual(["lock", "callback"]);
    expect(normalizedSql(value.queries[0]!.statement)).toContain(
      "for update of reflection_record_semantic_work",
    );
    expect(value.queries[0]!.parameters).toEqual([
      "record:one", 3, 3, "lease:one", "claimed", "organization", "revised",
      now.toISOString(), "available",
    ]);
  });

  test("rolls back publication when the captured lease expires during the callback", async () => {
    let now = new Date("2026-09-05T10:00:00.000Z");
    let persistedPublications = 0;
    const transactionEvents: string[] = [];
    const connection: RecordProductPostgresConnection = {
      async query<Row extends RecordProductPostgresRow>(statement: string) {
        if (statement.startsWith("SELECT current_user")) {
          return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as Row[];
        }
        throw new Error(`unexpected connection SQL: ${statement}`);
      },
      async transaction<Result>(
        callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
        options: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
      ): Promise<Result> {
        transactionEvents.push(`begin:${options.isolationLevel}`);
        let pendingPublications = persistedPublications;
        const tx: RecordProductPostgresExecutor = {
          async query<Row extends RecordProductPostgresRow>(statement: string) {
            if (normalizedSql(statement).startsWith("select")) {
              return [{
                record_id: "record:one",
                lease_expires_at: new Date(now.getTime() + 1_000),
              }] as unknown as Row[];
            }
            if (normalizedSql(statement).startsWith("insert into product_publications")) {
              pendingPublications += 1;
              return [] as Row[];
            }
            throw new Error(`unexpected transaction SQL: ${statement}`);
          },
        };
        try {
          const result = await callback(tx);
          persistedPublications = pendingPublications;
          transactionEvents.push("commit");
          return result;
        } catch (error) {
          transactionEvents.push("rollback");
          throw error;
        }
      },
    };
    const store = new PostgresSemanticWorkStore({
      handle: await verifyRecordProductPostgresHandle(connection),
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });
    const claim: DurableSleepClaim = {
      logicalObjectRef: "record:one", recordRef: "record:one", generation: 3,
      changeReason: "revised", stage: "organization", leaseToken: "lease:one",
    };

    expect(store.withClaimPublicationFence(claim, async (tx) => {
      await tx.query("INSERT INTO product_publications DEFAULT VALUES");
      now = new Date(now.getTime() + 2_000);
      return "published";
    })).rejects.toThrow("Reflection publication lease expired");
    expect(transactionEvents).toEqual(["begin:read committed", "rollback"]);
    expect(persistedPublications).toBe(0);
  });

  test("allows the fenced callback to advance its own work row", async () => {
    const now = new Date("2026-09-05T10:00:00.000Z");
    let lockReads = 0;
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("select")) {
        lockReads += 1;
        return [{
          record_id: "record:one",
          lease_expires_at: new Date(now.getTime() + 30_000),
        }] as unknown as Row[];
      }
      if (normalized.startsWith("update reflection_record_semantic_work")) return [] as Row[];
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });
    const claim: DurableSleepClaim = {
      logicalObjectRef: "record:one", recordRef: "record:one", generation: 3,
      changeReason: "revised", stage: "organization", leaseToken: "lease:one",
    };

    expect(await store.withClaimPublicationFence(claim, async (tx) => {
      await tx.query(
        "UPDATE reflection_record_semantic_work SET generation = generation + 1 WHERE record_id = $1",
        [claim.recordRef],
      );
      return "advanced";
    })).toEqual({ status: "current", value: "advanced" });
    expect(lockReads).toBe(1);
    expect(value.queries).toHaveLength(2);
  });

  test("claims one expired-or-due row and checkpoints the exact live lease", async () => {
    const now = new Date("2026-08-14T10:00:00.000Z");
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("update reflection_record_semantic_work")
        && !normalized.includes("returning")) return [];
      if (statement.includes("WITH candidate AS")) {
        return [{
          record_id: "record:one",
          generation: 3,
          change_reason: "revised",
          stage: "authority_projection",
          lease_token: "11111111-1111-4111-8111-111111111111",
          due_since: now,
          started_at: now,
        }] as unknown as Row[];
      }
      if (normalized.startsWith("update reflection_record_semantic_work")
        && normalized.includes("returning record_id")) {
        return [{ record_id: "record:one" }] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });
    const claimed = await store.claimNext(undefined, { includeOrganization: false });
    expect(claimed).toMatchObject({
      status: "claimed",
      claim: {
        logicalObjectRef: "record:one",
        generation: 3,
        recordRef: "record:one",
        stage: "authority_projection",
      },
    });
    if (claimed.status !== "claimed") throw new Error("expected claim");
    expect(await store.checkpoint({
      claim: claimed.claim,
      completedStage: "authority_projection",
    })).toMatchObject({ status: "accepted" });
    expect(claimed.claim.timing).toMatchObject({
      admittedAtEpochMs: now.getTime(),
      firstClaimedAtEpochMs: now.getTime(),
      claimedAtEpochMs: now.getTime(),
    });
    const claimSql = value.queries.find((query) => query.statement.includes("WITH candidate AS"));
    expect(claimSql?.statement).toContain("work.lease_expires_at <= $1");
    expect(normalizedSql(claimSql?.statement ?? "")).toContain(
      "when 'authority_projection' then 0 when 'search_projection' then 1 when 'organization' then 2 else 3 end <= $5::integer",
    );
    expect(normalizedSql(claimSql?.statement ?? "")).toContain(
      "when work.state = 'claimed' and work.lease_expires_at <= $1 then 0",
    );
    expect(normalizedSql(claimSql?.statement ?? "")).toContain(
      "when work.state = 'quarantined' then 2 else 1 end asc, work.attempt_count asc",
    );
    expect(normalizedSql(claimSql?.statement ?? "")).toContain(
      "when work.change_reason = 'parent_conflict' then 0 else 1 end asc",
    );
    expect(normalizedSql(claimSql?.statement ?? "")).toContain(
      "work.attempt_count asc, case work.change_reason when 'dependency_lost' then 2 when 'revised' then 1 else 0 end desc, work.due_since",
    );
    expect(normalizedSql(claimSql?.statement ?? "")).not.toContain(
      "when 'created' then",
    );
    // The legacy includeOrganization=false option remains a search-stage ceiling.
    expect(claimSql?.parameters?.[4]).toBe(1);
    expect(claimSql?.statement).toContain("FOR UPDATE OF work SKIP LOCKED");
    expect(normalizedSql(value.queries.find((query) =>
      normalizedSql(query.statement).startsWith("update reflection_record_semantic_work")
      && normalizedSql(query.statement).includes("attempt_count")
      && normalizedSql(query.statement).includes("quarantine_round")
    )?.statement ?? "")).toContain("record.disposition = 'available'");
    expect(normalizedSql(claimSql?.statement ?? "")).toContain(
      "started_at = coalesce(work.started_at, $1)",
    );
    expect(normalizedSql(value.queries.find((query) =>
      normalizedSql(query.statement).startsWith("update reflection_record_semantic_work")
        && normalizedSql(query.statement).includes("returning record_id")
    )?.statement ?? "")).toContain("lease_expires_at >");
  });

  test("pauses a live claim until an exact future retry without charging its attempt", async () => {
    const now = new Date("2026-08-14T10:00:00.000Z");
    const retryAt = now.getTime() + 15_000;
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => normalizedSql(statement).includes("returning record_id")
      ? [{ record_id: "record:waiting" }] as unknown as Row[]
      : [] as Row[]);
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(
        new Uint8Array(32).fill(3),
      ),
      clock: () => now,
    });
    const waitingClaim: DurableSleepClaim = {
      logicalObjectRef: "record:waiting",
      generation: 3,
      recordRef: "record:waiting",
      changeReason: "revised",
      stage: "authority_projection",
      leaseToken: "11111111-1111-4111-8111-111111111111",
    };

    expect(await store.pause({
      claim: waitingClaim,
      nextAttemptAt: retryAt,
    })).toMatchObject({ status: "accepted" });
    const pause = value.queries[0]!;
    const statement = normalizedSql(pause.statement);
    expect(statement).toContain("attempt_count = greatest(");
    expect(statement).toContain("attempt_count -");
    expect(statement).toContain("next_attempt_at =");
    expect(pause.parameters).toContain(new Date(retryAt).toISOString());
  });

  test("rejects malformed or non-future pause timestamps before SQL mutation", async () => {
    const now = new Date("2026-08-14T10:00:00.000Z");
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>() =>
      [] as Row[]);
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(
        new Uint8Array(32).fill(3),
      ),
      clock: () => now,
    });
    const waitingClaim: DurableSleepClaim = {
      logicalObjectRef: "record:waiting",
      generation: 3,
      recordRef: "record:waiting",
      changeReason: "revised",
      stage: "authority_projection",
      leaseToken: "11111111-1111-4111-8111-111111111111",
    };
    const pauseWithUncheckedTimestamp = store.pause.bind(store) as (input: {
      claim: DurableSleepClaim;
      nextAttemptAt: unknown;
    }) => Promise<unknown>;
    for (const nextAttemptAt of [
      Number.NaN,
      now.getTime(),
      8_640_000_000_000_001,
      "later",
    ]) {
      let rejection: unknown;
      try {
        await pauseWithUncheckedTimestamp({ claim: waitingClaim, nextAttemptAt });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(RangeError);
      expect((rejection as Error).message).toBe(
        "Semantic work next attempt must be a future bounded timestamp",
      );
    }
    expect(value.queries).toEqual([]);
  });

  test("claims through the exact admitted semantic stage", async () => {
    const observed: Query[] = [];
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly RecordProductPostgresScalar[],
    ) => {
      observed.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
      return [] as Row[];
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
    });

    expect(await store.claimNext(undefined, {
      maximumStage: "authority_projection",
    })).toEqual({ status: "empty" });

    const claimSql = observed.find((query) => query.statement.includes("WITH candidate AS"));
    expect(claimSql?.parameters?.[4]).toBe(0);
    expect(normalizedSql(claimSql?.statement ?? "")).toContain(
      "when 'authority_projection' then 0 when 'search_projection' then 1 when 'organization' then 2 else 3 end <= $5::integer",
    );
  });

  test.each([
    ["authority_projection", 0],
    ["search_projection", 1],
    ["organization", 2],
  ] as const)(
    "caps protected organization metadata at requested %s",
    async (maximumStage, maximumStageRank) => {
      const now = new Date("2026-09-11T10:00:00.000Z");
      const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
        statement: string,
      ) => {
        const normalized = normalizedSql(statement);
        if (normalized.startsWith("update reflection_record_semantic_work")
          && !normalized.includes("returning")) return [] as Row[];
        if (statement.includes("WITH candidate AS")) {
          return [{
            record_id: `record:${maximumStage}`,
            generation: 1,
            change_reason: "created",
            stage: maximumStage,
            lease_token: "33333333-3333-4333-8333-333333333333",
            due_since: now,
            started_at: now,
            execution_representation: "protected",
            execution_maximum_stage: maximumStageRank,
          }] as unknown as Row[];
        }
        throw new Error(`unexpected SQL: ${statement}`);
      });
      const store = new PostgresSemanticWorkStore({
        handle: value.handle,
        commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
        clock: () => now,
      });

      expect(await store.claimNext(undefined, {
        maximumStage,
        representationAdmission: {
          ordinary: "none",
          protected: "organization",
        },
      })).toMatchObject({
        status: "claimed",
        executionRepresentation: "protected",
        maximumStage,
        claim: { stage: maximumStage },
      });
      const claimSql = value.queries.find(query => query.statement.includes("WITH candidate AS"))!;
      expect(claimSql.parameters?.slice(4)).toEqual([
        maximumStageRank,
        "none",
        "organization",
      ]);
      expect(normalizedSql(claimSql.statement)).toContain(
        "least($5::integer, case when $7 = 'organization' then 2 else 0 end)",
      );
    },
  );

  test("admits protected organization only when explicitly requested", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>() =>
      [] as Row[]);
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
    });

    expect(store.claimNext(undefined, {
      representationAdmission: { ordinary: "any", protected: "organization" },
    })).rejects.toThrow("Invalid semantic work representation admission");
    await Promise.resolve();
    expect(value.queries).toEqual([]);

    expect(await store.claimNext(undefined, {
      representationAdmission: {
        ordinary: "none",
        protected: "authority_projection",
      },
    })).toEqual({ status: "empty" });
    const authoritySql = value.queries.find(query => query.statement.includes("WITH candidate AS"))!;
    expect(authoritySql.parameters?.slice(4)).toEqual([
      2,
      "none",
      "authority_projection",
    ]);
    expect(normalizedSql(authoritySql.statement)).toContain(
      "case when $7 = 'organization' then 2 else 0 end",
    );
  });

  test("claims mixed fallback cohorts atomically with disjoint stage ceilings", async () => {
    const now = new Date("2026-09-11T10:00:00.000Z");
    let claimIndex = 0;
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("update reflection_record_semantic_work")
        && !normalized.includes("returning")) return [] as Row[];
      if (!statement.includes("WITH candidate AS")) {
        throw new Error(`unexpected SQL: ${statement}`);
      }
      const rows = [
        {
          record_id: "record:protected",
          generation: 2,
          change_reason: "revised",
          stage: "authority_projection",
          lease_token: "11111111-1111-4111-8111-111111111111",
          due_since: now,
          started_at: now,
          execution_representation: "protected",
          execution_maximum_stage: 0,
        },
        {
          record_id: "record:ordinary",
          generation: 4,
          change_reason: "revised",
          stage: "search_projection",
          lease_token: "22222222-2222-4222-8222-222222222222",
          due_since: now,
          started_at: now,
          execution_representation: "ordinary",
          execution_maximum_stage: 2,
        },
      ];
      return [rows[claimIndex++]!] as unknown as Row[];
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });
    const options = {
      maximumStage: "organization" as const,
      representationAdmission: {
        ordinary: "without_protected_head" as const,
        protected: "authority_projection" as const,
      },
    };

    expect(await store.claimNext(undefined, options)).toMatchObject({
      status: "claimed",
      executionRepresentation: "protected",
      maximumStage: "authority_projection",
      claim: { recordRef: "record:protected", stage: "authority_projection" },
    });
    expect(await store.claimNext(undefined, options)).toMatchObject({
      status: "claimed",
      executionRepresentation: "ordinary",
      maximumStage: "organization",
      claim: { recordRef: "record:ordinary", stage: "search_projection" },
    });
    const claimSql = value.queries.find((query) => query.statement.includes("WITH candidate AS"))!;
    const normalized = normalizedSql(claimSql.statement);
    expect(claimSql.parameters?.slice(4)).toEqual([
      2,
      "without_protected_head",
      "authority_projection",
    ]);
    expect(normalized).toContain(
      "left join reflection_record_payload_representation_heads as protected_head",
    );
    expect(normalized).toContain("protected_head.representation = 'protected'");
    expect(normalized).toContain(
      "$6 = 'without_protected_head' and protected_head.record_id is null",
    );
    expect(normalized).toContain(
      "$7 in ('authority_projection', 'organization') and protected_head.record_id is not null",
    );
    expect(normalized).toContain(
      "end <= least($5::integer, case when $7 = 'organization' then 2 else 0 end)",
    );
    expect(claimSql.statement).toContain("FOR UPDATE OF work SKIP LOCKED");
  });

  test("lets ordinary-any admission claim Plain work despite a protected sibling", async () => {
    const now = new Date("2026-09-11T10:00:00.000Z");
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("update reflection_record_semantic_work")
        && !normalized.includes("returning")) return [] as Row[];
      if (statement.includes("WITH candidate AS")) {
        return [{
          record_id: "record:plain",
          generation: 1,
          change_reason: "created",
          stage: "organization",
          lease_token: "33333333-3333-4333-8333-333333333333",
          due_since: now,
          started_at: now,
          execution_representation: "ordinary",
          execution_maximum_stage: 2,
        }] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(3)),
      clock: () => now,
    });

    expect(await store.claimNext(undefined, {
      representationAdmission: { ordinary: "any", protected: "none" },
    })).toMatchObject({
      status: "claimed",
      executionRepresentation: "ordinary",
      maximumStage: "organization",
      claim: { recordRef: "record:plain", stage: "organization" },
    });
    const claimSql = value.queries.find((query) => query.statement.includes("WITH candidate AS"))!;
    expect(claimSql.parameters?.slice(4)).toEqual([2, "any", "none"]);
    expect(normalizedSql(claimSql.statement)).toContain(
      "$6 = 'any' and case work.stage",
    );
  });

  test("rejects a stale claim and quarantines exhausted work with a cooldown", async () => {
    let deferring = false;
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("update reflection_record_semantic_work")
        && normalized.includes("returning state")) {
        deferring = true;
        return [{ state: "quarantined" }] as unknown as Row[];
      }
      if (normalized.includes("completed_generation") && normalized.includes("returning")) {
        return [];
      }
      if (normalized.startsWith("select completed_generation")) {
        return [{ completed_generation: 2 }] as unknown as Row[];
      }
      if (normalized.includes("select generation")) {
        return [{ generation: 4 }] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(4)),
      clock: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    const claim = {
      logicalObjectRef: "record:one",
      generation: 3,
      recordRef: "record:one",
      changeReason: "revised" as const,
      stage: "organization" as const,
      leaseToken: "11111111-1111-4111-8111-111111111111",
    };
    expect(await store.complete({ claim })).toEqual({ status: "superseded" });
    expect(await store.defer({ claim, failureCode: "unexpected_failure" }))
      .toEqual({ status: "quarantined" });
    expect(deferring).toBeTrue();
    const deferSql = normalizedSql(value.queries.find((query) =>
      normalizedSql(query.statement).includes("returning state")
    )?.statement ?? "");
    expect(deferSql).toContain("recover_after = case");
    expect(deferSql).toContain("failure_code =");
  });

  test.each([
    "recoverable_availability",
    "key_waiting",
  ] as const)("persists an ordinary fallback completion reason: %s", async ordinaryFallbackReason => {
    const now = new Date("2026-09-12T10:00:00.000Z");
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (
        normalized.startsWith("update reflection_record_semantic_work")
        && normalized.includes("returning record_id")
      ) return [{record_id: "record:one"}] as unknown as Row[];
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(4)),
      clock: () => now,
    });
    const claim: DurableSleepClaim = {
      logicalObjectRef: "record:one",
      generation: 3,
      recordRef: "record:one",
      changeReason: "revised",
      stage: "organization",
      leaseToken: "11111111-1111-4111-8111-111111111111",
    };

    expect(await store.complete({claim, ordinaryFallbackReason}))
      .toMatchObject({status: "accepted"});
    const completion = value.queries[0]!;
    expect(normalizedSql(completion.statement)).toContain("ordinary_fallback_reason =");
    expect(completion.parameters).toContain(ordinaryFallbackReason);
  });

  test("reclaims an eligible quarantine in the same generation", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("update reflection_record_semantic_work")
        && !normalized.includes("returning")) return [];
      if (statement.includes("WITH candidate AS")) {
        return [{
          record_id: "record:recovered",
          generation: 7,
          change_reason: "created",
          stage: "organization",
          lease_token: "11111111-1111-4111-8111-111111111111",
          recovered_from_quarantine: true,
          due_since: new Date("2026-08-14T09:00:00.000Z"),
          started_at: new Date("2026-08-14T09:30:00.000Z"),
        }] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(8)),
      clock: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    const claimed = await store.claimNext();
    expect(claimed).toMatchObject({
      status: "claimed",
      claim: {
        recordRef: "record:recovered",
        generation: 7,
        recoveredFromQuarantine: true,
      },
    });
    const claimSql = value.queries.find((query) => query.statement.includes("WITH candidate AS"));
    expect(claimSql?.statement).toContain("work.recover_after <= $1");
    expect(claimSql?.statement).toContain("WHEN candidate.recovered_from_quarantine THEN 1");
  });

  test("completes an obsolete parent conflict at its admission stage", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (
        normalized.startsWith("update reflection_record_semantic_work")
        && normalized.includes("returning record_id")
      ) return [{ record_id: "record:child" }] as unknown as Row[];
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(9)),
      clock: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    expect(await store.complete({
      claim: {
        logicalObjectRef: "record:child",
        generation: 4,
        recordRef: "record:child",
        changeReason: "parent_conflict",
        stage: "authority_projection",
        leaseToken: "11111111-1111-4111-8111-111111111111",
      },
    })).toMatchObject({ status: "accepted" });
    const completionSql = normalizedSql(value.queries[0]?.statement ?? "");
    expect(completionSql).toContain("stage =");
    expect(completionSql).toContain("change_reason =");
    expect(completionSql).toContain("ordinary_fallback_reason =");
    expect(value.queries[0]?.parameters).not.toContain("recoverable_availability");
    expect(value.queries[0]?.parameters).not.toContain("key_waiting");
  });
});

describe("PostgreSQL verified semantic completion", () => {
  test("settles the exact verified generation and clears its live scheduling state", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("select") && normalized.includes("for update")) {
        return [{ generation: 3, completed_generation: 1 }] as unknown as Row[];
      }
      if (normalized.startsWith("update reflection_record_semantic_work")) {
        return [] as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(11)),
    });

    await store.completeVerifiedGeneration({recordRef: "record:one", generation: 3});

    expect(value.queries).toHaveLength(2);
    const lock = normalizedSql(value.queries[0]!.statement);
    expect(lock).toContain("select generation, completed_generation");
    expect(lock).toContain("for update");
    const update = normalizedSql(value.queries[1]!.statement);
    for (const assignment of [
      "completed_generation =", "state =", "claim_generation =", "lease_token =",
      "lease_expires_at =", "next_attempt_at =", "quarantine_round =", "recover_after =",
      "failure_code =", "ordinary_fallback_reason =", "completed_at = now()",
      "updated_at = greatest(reflection_record_semantic_work.updated_at, now())",
    ]) expect(update).toContain(assignment);
    expect(update).toContain("where reflection_record_semantic_work.record_id =");
  });

  test("acknowledges a prior generation without disturbing newer scheduling", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("select") && normalized.includes("for update")) {
        return [{ generation: 5, completed_generation: 2 }] as unknown as Row[];
      }
      if (normalized.startsWith("update reflection_record_semantic_work")) {
        return [] as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(12)),
    });

    await store.completeVerifiedGeneration({recordRef: "record:one", generation: 3});

    const update = normalizedSql(value.queries[1]!.statement);
    expect(update).toContain("completed_generation =");
    expect(update).toContain("updated_at = greatest(reflection_record_semantic_work.updated_at, now())");
    for (const preserved of [
      "state =", "claim_generation =", "lease_token =", "lease_expires_at =",
      "next_attempt_at =", "quarantine_round =", "recover_after =", "failure_code =",
      "ordinary_fallback_reason =", "completed_at =",
    ]) expect(update).not.toContain(preserved);
  });

  test("replays an already completed generation without another mutation", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("select") && normalized.includes("for update")) {
        return [{ generation: 5, completed_generation: 3 }] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(13)),
    });

    await store.completeVerifiedGeneration({recordRef: "record:one", generation: 3});
    expect(value.queries).toHaveLength(1);
  });

  test("rejects absent, future, and malformed verified generations", async () => {
    let selected: RecordProductPostgresRow[] = [];
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      if (normalizedSql(statement).startsWith("select")) {
        return selected as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(14)),
    });

    expect(store.completeVerifiedGeneration({recordRef: "record:absent", generation: 1}))
      .rejects.toThrow("no matching source generation");
    selected = [{generation: 2, completed_generation: 1}];
    expect(store.completeVerifiedGeneration({recordRef: "record:one", generation: 3}))
      .rejects.toThrow("no matching source generation");
    expect(store.completeVerifiedGeneration({recordRef: "record:one", generation: 0}))
      .rejects.toThrow("must be positive");
  });

  test("ordinary completion accepts an exact generation already verified by recovery", async () => {
    const now = new Date("2026-09-12T10:00:00.000Z");
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("update reflection_record_semantic_work")) {
        return [] as Row[];
      }
      if (normalized.startsWith("select completed_generation")) {
        return [{completed_generation: 3}] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(15)),
      clock: () => now,
    });
    const claim: DurableSleepClaim = {
      logicalObjectRef: "record:one", recordRef: "record:one", generation: 3,
      changeReason: "revised", stage: "organization", leaseToken: "lease:expired",
    };

    expect(await store.complete({claim})).toMatchObject({status: "accepted"});
    expect(value.queries).toHaveLength(2);
    expect(normalizedSql(value.queries[1]!.statement))
      .toContain("select completed_generation");
  });
});

describe("PostgreSQL semantic work repair and publication", () => {
  test("bounds both conflict children and per-child parent fan-out", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      if (normalizedSql(statement).includes("with conflict_children as materialized")) {
        return [] as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(10)),
    });
    expect(await store.admitParentConflictsPage({ limit: 16 })).toEqual({
      admitted: 0,
    });
    const discovery = value.queries[0];
    expect(normalizedSql(discovery?.statement ?? "")).toContain(
      "having count(*) > 1 and count(*) <= $2",
    );
    expect(normalizedSql(discovery?.statement ?? "")).not.toContain(
      "join reflection_records as child",
    );
    expect(discovery?.parameters).toEqual([16, 32]);
  });

  test("accepts PostgreSQL bigint counters returned as decimal strings", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      if (normalizedSql(statement).includes("count(*) filter")) {
        return [{
          backlog: "906",
          ready: "127",
          claimed: "2",
          quarantined: "43",
          maximum_attempts: 8,
          oldest_due_at: "2026-08-14 09:00:00+00",
        }] as unknown as Row[];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(5)),
    });
    expect(await store.health()).toEqual({
      backlog: 906,
      ready: 127,
      claimed: 2,
      quarantined: 43,
      maximumAttempts: 8,
      oldestDueAt: new Date("2026-08-14T09:00:00.000Z"),
    });
    expect(normalizedSql(value.queries.at(-1)?.statement ?? "")).toContain(
      "inner join reflection_records",
    );
    expect(normalizedSql(value.queries.at(-1)?.statement ?? "")).toMatch(
      /reflection_records\.disposition = \$[0-9]+/u,
    );
  });

  test("reserves and restartably drains one bounded source-change cursor", async () => {
    const sourceChange = new Uint8Array(32).fill(7);
    const sourceDependency = new Uint8Array(32).fill(8);
    let reserved = false;
    let continuation: string | null = null;
    let completed = false;
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly RecordProductPostgresScalar[],
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.startsWith("insert into reflection_record_source_change_repairs")) {
        if (reserved) return [];
        reserved = true;
        return [{ source_change_commitment: sourceChange }] as unknown as Row[];
      }
      if (normalized.includes("from reflection_record_source_change_repairs")) {
        return (completed || !reserved ? [] : [{
          source_change_commitment: sourceChange,
          source_dependency_commitment: sourceDependency,
          continuation,
        }]) as unknown as Row[];
      }
      if (normalized.includes("from reflection_record_source_dependency_index")) {
        return (continuation === null
          ? [{ record_id: "record:a" }, { record_id: "record:b" }]
          : [{ record_id: "record:b" }]) as unknown as Row[];
      }
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (normalized.includes("select assigned_generation")) return [];
      if (normalized.includes("select generation") && normalized.includes("for update")) return [];
      if (normalized.includes("insert into reflection_record_semantic_work_admissions")) return [];
      if (normalized.includes("insert into reflection_record_semantic_work")) return [];
      if (normalized.startsWith("update reflection_record_source_change_repairs")
        && normalized.includes("set continuation")) {
        continuation = parameters?.[0] as string;
        return [];
      }
      if (normalized.startsWith("update reflection_record_source_change_repairs")
        && normalized.includes("set completed_at")) {
        completed = true;
        return [];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(6)),
    });
    expect(await store.reserveSourceRepair({
      sourceChangeCommitment: sourceChange,
      sourceDependencyCommitment: sourceDependency,
    })).toEqual({ reserved: true });
    expect(await store.reserveSourceRepair({
      sourceChangeCommitment: sourceChange,
      sourceDependencyCommitment: sourceDependency,
    })).toEqual({ reserved: false });
    expect(await store.repairSourceDependentsPage({ limit: 1 })).toEqual({
      consumed: 1,
      admitted: 1,
      pending: true,
    });
    expect(String(continuation)).toBe("record:a");
    expect(await store.repairSourceDependentsPage({ limit: 1 })).toEqual({
      consumed: 1,
      admitted: 1,
      pending: false,
    });
    expect(await store.repairSourceDependentsPage({ limit: 1 })).toEqual({
      consumed: 0,
      admitted: 0,
      pending: false,
    });
    expect(completed).toBeTrue();
  });

  test("restartably admits direct parents for one changed child Record", async () => {
    const changeCommitment = new Uint8Array(32).fill(11);
    let continuation: string | null = null;
    let completed = false;
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly RecordProductPostgresScalar[],
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.includes("from reflection_record_dependency_change_repairs")) {
        return completed ? [] : [{
          change_commitment: changeCommitment,
          changed_record_id: "record:child",
          continuation,
        }] as unknown as Row[];
      }
      if (normalized.includes("from reflection_record_dependencies")) {
        return (continuation === null
          ? [{ parent_record_id: "record:p1" }, { parent_record_id: "record:p2" }]
          : [{ parent_record_id: "record:p2" }]) as unknown as Row[];
      }
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (normalized.includes("select assigned_generation")) return [];
      if (normalized.includes("select generation") && normalized.includes("for update")) return [];
      if (normalized.includes("insert into reflection_record_semantic_work_admissions")) return [];
      if (normalized.includes("insert into reflection_record_semantic_work")) return [];
      if (normalized.startsWith("update reflection_record_dependency_change_repairs")
        && normalized.includes("set continuation")) {
        continuation = parameters?.[0] as string;
        return [];
      }
      if (normalized.startsWith("update reflection_record_dependency_change_repairs")
        && normalized.includes("set completed_at")) {
        completed = true;
        return [];
      }
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(6)),
    });
    expect(await store.repairRecordDependentsPage({ limit: 1 })).toEqual({
      consumed: 1,
      admitted: 1,
      pending: true,
    });
    expect(String(continuation)).toBe("record:p1");
    expect(await store.repairRecordDependentsPage({ limit: 1 })).toEqual({
      consumed: 1,
      admitted: 1,
      pending: false,
    });
    expect(await store.repairRecordDependentsPage({ limit: 1 })).toEqual({
      consumed: 0,
      admitted: 0,
      pending: false,
    });
    expect(completed).toBeTrue();
    const parentQuery = value.queries.find(({ statement }) =>
      normalizedSql(statement).includes("from reflection_record_dependencies")
    );
    expect(normalizedSql(parentQuery?.statement ?? "")).toContain(
      "reflection_record_dependencies.child_record_id",
    );
    expect(normalizedSql(parentQuery?.statement ?? "")).toContain(
      "select parent_record_id from reflection_record_dependencies",
    );
    expect(normalizedSql(parentQuery?.statement ?? "")).toContain(
      "union (select record_id from reflection_record_authority_dependencies",
    );
    expect(normalizedSql(parentQuery?.statement ?? "")).toContain(
      "reflection_record_authority_dependencies.dependency_record_id",
    );
    expect(normalizedSql(parentQuery?.statement ?? "")).toContain(
      "reflection_records.lifecycle",
    );
    expect(parentQuery?.parameters).toContain("record:child");
  });

  test("indexes cited and exposed sources and records in one publication transaction", async () => {
    const queries: Query[] = [];
    const sourceDependencies: string[] = [];
    const tx: RecordProductPostgresExecutor = {
      async query<Row extends RecordProductPostgresRow>(
        statement: string,
        parameters?: readonly RecordProductPostgresScalar[],
      ) {
        queries.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
        const normalized = normalizedSql(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [] as Row[];
        if (normalized.includes("select assigned_generation")) return [] as Row[];
        if (normalized.includes("select generation") && normalized.includes("for update")) {
          return [] as Row[];
        }
        if (normalized.includes("insert into reflection_record_semantic_work_admissions")) {
          return [] as Row[];
        }
        if (normalized.includes("insert into reflection_record_semantic_work")) return [] as Row[];
        if (normalized.includes("insert into reflection_record_source_dependency_index")) {
          return [] as Row[];
        }
        if (normalized.includes("insert into reflection_record_authority_dependencies")) {
          return [] as Row[];
        }
        throw new Error(`unexpected SQL: ${statement}`);
      },
    };
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>() =>
      [] as readonly Row[]
    );
    const base = publication();
    const exposed: DurableRecordPublication = {
      ...base,
      record: {
        ...base.record,
        semantic: {
          ...base.record.semantic,
          modelExposureDependencies: [
            {
              kind: "source",
              sourceKind: "memory",
              logicalSourceRef: "memory:uncited",
              observedRevision: "7",
              observedContentFingerprint: "sha256:uncited",
              terminalAuthorityLeafHandle: "namespace:uncited",
            },
            {
              kind: "record",
              recordRef: "record:uncited",
              observedProcessingGeneration: 4,
              terminalAuthorityLeafHandles: ["namespace:record-uncited"],
            },
          ],
        },
      },
    };
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: {
        sourceDependency(input: { logicalSourceRef: string }) {
          sourceDependencies.push(input.logicalSourceRef);
          return new Uint8Array(32).fill(sourceDependencies.length);
        },
        publication() {
          return new Uint8Array(32).fill(9);
        },
      } as never,
      clock: () => new Date("2026-09-11T10:00:00.000Z"),
    });

    await store.attachPublicationWithinTransaction(tx, exposed);
    expect(sourceDependencies).toEqual([
      "memory:private-value",
      "memory:uncited",
    ]);
    const sourceIndex = queries.find(query => normalizedSql(query.statement)
      .includes("insert into reflection_record_source_dependency_index"));
    expect(sourceIndex).toBeDefined();
    expect(sourceIndex?.parameters).toContain("record:new");
    const recordExposure = queries.find(query => normalizedSql(query.statement)
      .includes("insert into reflection_record_authority_dependencies"));
    expect(recordExposure).toBeDefined();
    expect(recordExposure?.parameters).toContainAllValues([
      "record:new",
      "record:uncited",
    ]);
  });

  test("installs source commitments and admits only the new head in one transaction", async () => {
    const queries: Query[] = [];
    const generations = new Map<string, number>();
    const tx: RecordProductPostgresExecutor = {
      async query<Row extends RecordProductPostgresRow>(
        statement: string,
        parameters?: readonly RecordProductPostgresScalar[],
      ) {
        queries.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
        const normalized = normalizedSql(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("select assigned_generation")) return [];
        if (normalized.includes("select generation") && normalized.includes("for update")) {
          const generation = generations.get(parameters?.[0] as string);
          return (generation === undefined ? [] : [{ generation }]) as unknown as Row[];
        }
        if (normalized.includes("insert into reflection_record_semantic_work_admissions")) {
          return [];
        }
        if (normalized.includes("insert into reflection_record_semantic_work")) {
          generations.set(parameters?.[0] as string, parameters?.[1] as number);
          return [];
        }
        if (statement.includes("reflection_record_source_dependency_index")) return [];
        if (statement.includes("reflection_record_dependency_change_repairs")) return [];
        throw new Error(`unexpected SQL: ${statement}`);
      },
    };
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>() =>
      [] as readonly Row[]
    );
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(5)),
      clock: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    await store.attachPublicationWithinTransaction(tx, publication(true));
    expect(queries.filter(({ statement }) =>
      normalizedSql(statement).includes("insert into reflection_record_semantic_work_admissions")
    )).toHaveLength(1);
    expect(generations).toEqual(new Map([["record:new", 1]]));
    expect(queries.some(({ statement }) =>
      statement.includes("reflection_record_source_dependency_index")
    )).toBeTrue();
    expect(queries.some(({ statement }) =>
      statement.includes("reflection_record_dependency_change_repairs")
    )).toBeTrue();
  });

  test("delays exactly one scheduled review for a derived head", async () => {
    const queries: Query[] = [];
    const tx: RecordProductPostgresExecutor = {
      async query<Row extends RecordProductPostgresRow>(
        statement: string,
        parameters?: readonly RecordProductPostgresScalar[],
      ) {
        queries.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
        const normalized = normalizedSql(statement);
        if (statement.includes("pg_advisory_xact_lock")) return [] as Row[];
        if (normalized.includes("select assigned_generation")) return [] as Row[];
        if (normalized.includes("select generation") && normalized.includes("for update")) {
          return [] as Row[];
        }
        if (normalized.includes("insert into reflection_record_semantic_work_admissions")) {
          return [] as Row[];
        }
        if (normalized.includes("insert into reflection_record_semantic_work")) return [] as Row[];
        if (statement.includes("reflection_record_source_dependency_index")) return [] as Row[];
        if (statement.includes("reflection_record_dependency_change_repairs")) return [] as Row[];
        throw new Error(`unexpected SQL: ${statement}`);
      },
    };
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>() =>
      [] as readonly Row[]
    );
    const now = new Date("2026-08-14T10:00:00.000Z");
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(5)),
      clock: () => now,
    });
    await store.attachPublicationWithinTransaction(tx, publication(true, 1));
    const workInsert = queries.find(({ statement }) =>
      normalizedSql(statement).includes("insert into reflection_record_semantic_work")
      && !normalizedSql(statement).includes("admissions")
    );
    expect(workInsert?.parameters).toContain("scheduled_review");
    expect(workInsert?.parameters).toContain("2026-08-14T10:05:00.000Z");
    expect(queries.filter(({ statement }) =>
      normalizedSql(statement).includes("insert into reflection_record_semantic_work_admissions")
    )).toHaveLength(1);
  });

  test("bounds bootstrap pages and returns a restart cursor without payload content", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly RecordProductPostgresScalar[],
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.includes("left join reflection_record_semantic_work")) {
        return [
          {
            record_id: "record:a",
            processing_generation: 2,
            structural_height: 0,
          },
          {
            record_id: "record:b",
            processing_generation: 1,
            structural_height: 1,
          },
        ] as unknown as Row[];
      }
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (normalized.includes("select assigned_generation")) return [];
      if (normalized.includes("select generation") && normalized.includes("for update")) return [];
      if (normalized.includes("insert into reflection_record_semantic_work_admissions")) return [];
      if (normalized.includes("insert into reflection_record_semantic_work")) return [];
      throw new Error(`unexpected SQL: ${statement} ${String(parameters)}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(6)),
    });
    expect(await store.bootstrapPage({ limit: 1 })).toEqual({
      admitted: 1,
      continuation: "record:a",
    });
    expect(() => store.bootstrapPage({ limit: 257 })).toThrow(RangeError);
    const bootstrapSql = value.queries.find((query) =>
      normalizedSql(query.statement).includes("left join reflection_record_semantic_work")
    );
    expect(bootstrapSql?.statement).not.toContain("payload");
    expect(normalizedSql(bootstrapSql?.statement ?? "")).toContain("state =");
    expect(normalizedSql(bootstrapSql?.statement ?? "")).toContain("change_reason <>");
    expect(bootstrapSql?.parameters).toContain(2);
  });

  test("re-admits obsolete candidate quarantines once per policy receipt", async () => {
    const value = await verifiedConnection(async <Row extends RecordProductPostgresRow>(
      statement: string,
    ) => {
      const normalized = normalizedSql(statement);
      if (normalized.includes("inner join reflection_record_semantic_work")) {
        return [
          {
            record_id: "record:a",
            processing_generation: 2,
            structural_height: 0,
          },
          {
            record_id: "record:b",
            processing_generation: 3,
            structural_height: 1,
          },
        ] as unknown as Row[];
      }
      if (statement.includes("pg_advisory_xact_lock")) return [];
      if (normalized.includes("select assigned_generation")) return [];
      if (normalized.includes("select generation") && normalized.includes("for update")) {
        return [{
          generation: 8,
          change_reason: "created",
          state: "quarantined",
        }] as unknown as Row[];
      }
      if (normalized.includes("insert into reflection_record_semantic_work_admissions")) return [];
      if (normalized.startsWith("update reflection_record_semantic_work")) return [];
      throw new Error(`unexpected SQL: ${statement}`);
    });
    const store = new PostgresSemanticWorkStore({
      handle: value.handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(9)),
      clock: () => new Date("2026-08-21T10:00:00.000Z"),
    });
    expect(await store.recoverCandidatePolicyQuarantinesPage({
      limit: 1,
      policyVersion: "authority-aware-parent-normalization-v1",
    })).toEqual({ admitted: 1, continuation: "record:a" });
    const recoverySql = value.queries.find((query) =>
      normalizedSql(query.statement).includes("inner join reflection_record_semantic_work")
    );
    expect(recoverySql?.statement).not.toContain("payload");
    expect(normalizedSql(recoverySql?.statement ?? "")).toContain("failure_code =");
    expect(recoverySql?.parameters).toContain("candidate_unavailable");
  });
});
