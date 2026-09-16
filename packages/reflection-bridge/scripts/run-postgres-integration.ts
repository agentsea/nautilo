import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { invocationAudienceIsEligible } from "@nautilo/reflection/authority";
import type { DurableRecordEnvelope } from "@nautilo/reflection/durable";
import { RECORD_SEARCH_POLICY_V1 } from "@nautilo/reflection/search";

import {
  createHmacRecordRequestCommitmentPort,
  DualModeRecordRepository,
  PostgresAuthorityProjectionStore,
  PostgresAuthorityFilteredRecordSearchStore,
  PostgresCrossRoomOrganizerStore,
  PostgresOrdinaryStenographerRecordPublisher,
  PostgresRecordProductStore,
  PostgresRecordSearchProjectionStore,
  PostgresSameRoomOrganizerStore,
  PostgresSemanticWorkStore,
  createHmacRecordSemanticCommitmentPort,
  readOrdinaryStenographerJournalEventsWithHandle,
  verifyRecordProductPostgresHandle,
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresScalar,
} from "../src/server/index";

const connectionString = process.env["NAUTILO_REFLECTION_BRIDGE_TEST_DATABASE_URL"];
if (connectionString === undefined || connectionString.trim().length === 0) {
  throw new Error(
    "NAUTILO_REFLECTION_BRIDGE_TEST_DATABASE_URL is required for the explicit disposable PostgreSQL suite",
  );
}
if (!/test|cruft|qa/iu.test(connectionString)) {
  throw new Error("Reflection bridge integration refuses a non-test-looking database URL");
}

const client = postgres(connectionString, { max: 3, prepare: false });
const STENOGRAPHER_INTEGRATION_POLICY_VERSION = "integration-stenographer-v1";

function executor(sql: postgres.Sql): RecordProductPostgresExecutor {
  let queryOrdinal = 0;
  return {
    async query<Row>(statement: string, parameters: readonly RecordProductPostgresScalar[] = []) {
      queryOrdinal += 1;
      try {
        return await sql.unsafe(statement, [...parameters] as never[]) as unknown as readonly Row[];
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          && typeof error.code === "string"
          ? error.code
          : "unknown";
        const position = typeof error === "object" && error !== null && "position" in error
          && typeof error.position === "string"
          ? error.position
          : "unknown";
        const routine = typeof error === "object" && error !== null && "routine" in error
          && typeof error.routine === "string"
          ? error.routine
          : "unknown";
        process.stderr.write(
          `[reflection-bridge-integration] PostgreSQL query ${queryOrdinal} failed (${code}, position ${position}, routine ${routine})\n`,
        );
        throw error;
      }
    },
  };
}

const connection: RecordProductPostgresConnection = {
  ...executor(client),
  async transaction<Result>(
    callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
    options: Readonly<{
      isolationLevel: "serializable" | "read committed";
    }>,
  ): Promise<Result> {
    return await client.begin(
      options.isolationLevel === "serializable" ? "ISOLATION LEVEL SERIALIZABLE" : "ISOLATION LEVEL READ COMMITTED",
      async (transaction) => callback(executor(transaction)),
    ) as Result;
  },
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertAuthorityQueryPlans(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
  input: Readonly<{
    recordId: string;
    terminalLeafHandle: string;
    accessNamespaceId: string;
  }>,
): Promise<void> {
  await handle.transaction(async (transaction) => {
    await transaction.query("SET LOCAL enable_seqscan = off");
    const cases: readonly Readonly<{
      sql: string;
      parameters: readonly RecordProductPostgresScalar[];
      expectedIndex: string;
    }>[] = [
      {
        sql: `EXPLAIN (COSTS OFF)
          SELECT record_id, closure_generation
            FROM reflection_record_authority_closure
           WHERE terminal_leaf_handle = $1`,
        parameters: [input.terminalLeafHandle],
        expectedIndex: "idx_reflection_record_authority_closure_reverse",
      },
      {
        sql: `EXPLAIN (COSTS OFF)
          SELECT record_id, projection_generation, alternative_ordinal
            FROM reflection_record_authority_alternatives
           WHERE access_namespace_id = $1
             AND includes_public_boundary = true`,
        parameters: [input.accessNamespaceId],
        expectedIndex: "idx_reflection_record_authority_alternative_eligibility",
      },
      {
        sql: `EXPLAIN (COSTS OFF)
          SELECT reconciliation_id
            FROM reflection_record_authority_reconciliations
           WHERE state IN ('pending', 'leased')
             AND next_attempt_at <= now()
           ORDER BY state, next_attempt_at, created_at`,
        parameters: [],
        expectedIndex: "idx_reflection_record_authority_reconciliation_due",
      },
      {
        sql: `EXPLAIN (COSTS OFF)
          SELECT disposition
            FROM reflection_record_authority_blocks
           WHERE terminal_leaf_handle = $1`,
        parameters: [input.terminalLeafHandle],
        expectedIndex: "uq_reflection_record_authority_blocks_leaf",
      },
    ];
    for (const value of cases) {
      const rows = await transaction.query(value.sql, value.parameters);
      const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
      assert(plan.includes(value.expectedIndex), `authority query plan missed ${value.expectedIndex}`);
    }

    const recordRows = await transaction.query(
      `EXPLAIN (COSTS OFF)
         SELECT terminal_leaf_handle
           FROM reflection_record_authority_closure
          WHERE record_id = $1 AND closure_generation = 2`,
      [input.recordId],
    );
    const recordPlan = recordRows.map((row) => row["QUERY PLAN"]).join("\n");
    assert(
      recordPlan.includes("reflection_record_authority_closure_pkey")
        || recordPlan.includes("idx_reflection_record_authority_closure_record"),
      "authority record closure query missed its bounded index",
    );
  }, { isolationLevel: "read committed" });
}

async function assertAuthoritySecurity(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
): Promise<void> {
  const tableNames = [
    "reflection_record_authority_closure",
    "reflection_record_authority_projections",
    "reflection_record_authority_alternatives",
    "reflection_record_authority_changes",
    "reflection_record_authority_reconciliations",
    "reflection_record_authority_blocks",
  ] as const;
  const rows = await handle.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            has_table_privilege('nautilo', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS product_dml,
            has_table_privilege('nautilo_agent', c.oid, 'SELECT') AS agent_select,
            has_table_privilege('nautilo_crypto', c.oid, 'SELECT') AS crypto_select,
            has_table_privilege('public', c.oid, 'SELECT') AS public_select
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [tableNames],
  );
  assert(rows.length === tableNames.length, "authority security inventory is incomplete");
  for (const row of rows) {
    assert(row["relrowsecurity"] === true, "authority table is missing RLS");
    assert(row["relforcerowsecurity"] === true, "authority table is missing FORCE RLS");
    assert(row["product_dml"] === true, "product role is missing authority DML");
    assert(row["agent_select"] === false, "agent role can scan authority state");
    assert(row["crypto_select"] === false, "crypto role can scan authority state");
    assert(row["public_select"] === false, "PUBLIC can scan authority state");
  }

  const forbiddenColumns = await handle.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND column_name = ANY($2::text[])`,
    [
      tableNames,
      [
        "statement", "source_id", "source_revision", "anchor_ref", "query_text",
        "semantic_label", "embedding", "payload", "key_bytes", "grant_bytes",
      ],
    ],
  );
  assert(forbiddenColumns.length === 0, "authority tables expose protected semantic columns");
}

async function assertSearchProjectionSecurity(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
): Promise<void> {
  const rows = await handle.query(
    `SELECT c.relrowsecurity, c.relforcerowsecurity,
            has_table_privilege('nautilo', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS product_dml,
            has_table_privilege('nautilo_agent', c.oid, 'SELECT') AS agent_select,
            has_table_privilege('nautilo_crypto', c.oid, 'SELECT') AS crypto_select,
            has_table_privilege('public', c.oid, 'SELECT') AS public_select
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'reflection_record_search_projections'`,
  );
  assert(rows.length === 1, "search projection security inventory is incomplete");
  const row = rows[0]!;
  assert(row["relrowsecurity"] === true, "search projection is missing RLS");
  assert(row["relforcerowsecurity"] === true, "search projection is missing FORCE RLS");
  assert(row["product_dml"] === true, "product role is missing search-projection DML");
  assert(row["agent_select"] === false, "agent role can scan search projections");
  assert(row["crypto_select"] === false, "crypto role can scan search projections");
  assert(row["public_select"] === false, "PUBLIC can scan search projections");
}

async function assertSemanticWorkSecurity(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
): Promise<void> {
  const tableNames = [
    "reflection_record_semantic_work",
    "reflection_record_semantic_work_admissions",
    "reflection_record_dependency_change_repairs",
    "reflection_record_source_change_repairs",
    "reflection_record_source_dependency_index",
  ] as const;
  const rows = await handle.query(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            has_table_privilege('nautilo', c.oid, 'SELECT,INSERT,UPDATE') AS product_write,
            has_table_privilege('nautilo_agent', c.oid, 'SELECT') AS agent_select,
            has_table_privilege('nautilo_crypto', c.oid, 'SELECT') AS crypto_select,
            has_table_privilege('public', c.oid, 'SELECT') AS public_select
       FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [tableNames],
  );
  assert(rows.length === tableNames.length, "semantic-work security inventory is incomplete");
  for (const row of rows) {
    assert(row["relrowsecurity"] === true, "semantic-work table is missing RLS");
    assert(row["relforcerowsecurity"] === true, "semantic-work table is missing FORCE RLS");
    assert(row["product_write"] === true, "product role is missing semantic-work writes");
    assert(row["agent_select"] === false, "agent role can scan semantic-work state");
    assert(row["crypto_select"] === false, "crypto role can scan semantic-work state");
    assert(row["public_select"] === false, "PUBLIC can scan semantic-work state");
  }

  const forbiddenColumns = await handle.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND column_name = ANY($2::text[])`,
    [
      tableNames,
      [
        "statement", "source_id", "source_revision", "anchor_ref", "query_text",
        "semantic_label", "embedding", "payload", "key_bytes", "grant_bytes",
      ],
    ],
  );
  assert(forbiddenColumns.length === 0, "semantic-work tables expose protected semantic columns");
}

async function settleSyntheticIntegrationReceipts(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
): Promise<void> {
  await handle.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE reflection_record_authority_reconciliations
          SET state = 'quarantined', failure_code = 'mapping_conflict',
              next_attempt_at = NULL, lease_token = NULL,
              lease_expires_at = NULL, updated_at = now()
        WHERE record_id LIKE 'integration:%'
          AND state IN ('pending', 'leased')`,
    );
  }, { isolationLevel: "serializable" });
}

async function assertDisposableReflectionDatabase(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
): Promise<void> {
  const rows = await handle.query<{ database_name: string; product_records: string }>(
    `SELECT current_database() AS database_name,
            count(*) FILTER (
              WHERE record_id NOT LIKE 'integration:%'
                AND producer_policy_version <> $1
            )::text AS product_records
       FROM reflection_records`,
    [STENOGRAPHER_INTEGRATION_POLICY_VERSION],
  );
  const row = rows[0];
  assert(row !== undefined, "disposable database identity is unavailable");
  assert(
    row.product_records === "0",
    `reflection integration refuses populated database ${row.database_name}`,
  );
}

async function settleSyntheticSemanticWork(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
): Promise<void> {
  await handle.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE reflection_record_semantic_work
          SET state = 'quarantined', claim_generation = NULL,
              lease_token = NULL, lease_expires_at = NULL,
              next_attempt_at = NULL, failure_code = 'retry_exhausted',
              quarantine_round = quarantine_round + 1,
              recover_after = now() + interval '7 days',
              completed_at = NULL, updated_at = greatest(updated_at, now())
        WHERE (
          record_id LIKE 'integration:%'
          OR record_id IN (
            SELECT record_id FROM reflection_records
             WHERE producer_policy_version = $1
          )
        )
          AND state IN ('due', 'claimed', 'checkpointed', 'deferred')`,
      [STENOGRAPHER_INTEGRATION_POLICY_VERSION],
    );
  }, { isolationLevel: "serializable" });
}

async function retireSyntheticIntegrationRecords(
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>,
): Promise<void> {
  await handle.transaction(async (transaction) => {
    await transaction.query(
      `UPDATE reflection_records
          SET disposition = 'purged', updated_at = greatest(updated_at, now())
        WHERE (record_id LIKE 'integration:%' OR producer_policy_version = $1)
          AND disposition = 'available'`,
      [STENOGRAPHER_INTEGRATION_POLICY_VERSION],
    );
  }, { isolationLevel: "serializable" });
}

async function assertOrdinaryStenographerPublication(input: Readonly<{
  handle: Awaited<ReturnType<typeof verifyRecordProductPostgresHandle>>;
  ownerId: string;
  humanActorId: string;
}>): Promise<void> {
  const agentRows = await input.handle.query(
    `SELECT id::text AS actor_id
       FROM actors
      WHERE kind = 'agent'
      ORDER BY created_at, id
      LIMIT 1`,
  );
  const agentActorId = agentRows[0]?.["actor_id"];
  assert(typeof agentActorId === "string", "integration database has no Agent actor");

  const namespaceId = randomUUID();
  const roomId = randomUUID();
  const sessionId = randomUUID();
  const firstBatchId = randomUUID();
  const firstLeaseToken = randomUUID();
  const firstNow = new Date("2000-01-02T00:00:00.000Z");
  const firstMessageRows = await input.handle.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO namespaces (id, scope, label)
       VALUES ($1, 'integration', $2)`,
      [namespaceId, `stenographer-integration:${namespaceId}`],
    );
    await transaction.query(
      `INSERT INTO rooms (
         id, owner_id, type, label, graph_thread_id, namespace_id,
         human_actor_ids, kind
       ) VALUES ($1, $2, 'shared', $3, $4, $5, $6::uuid[], 'private')`,
      [
        roomId,
        input.ownerId,
        `Stenographer integration ${roomId}`,
        `stenographer-integration:${roomId}`,
        namespaceId,
        `{${input.humanActorId}}`,
      ],
    );
    await transaction.query(
      `INSERT INTO room_members (room_id, actor_id, room_role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [roomId, input.humanActorId, agentActorId],
    );
    await transaction.query(
      `INSERT INTO sessions (id, thread_id, owner_id, room_id, message_count)
       VALUES ($1, $2, $3, $4, 1)`,
      [sessionId, `stenographer-integration:${sessionId}`, input.ownerId, roomId],
    );
    const messages = await transaction.query(
      `INSERT INTO session_messages (
         session_id, role, content, fingerprint, created_at, human_turn_id
       ) VALUES ($1, 'user', $2, $3, $4, $5)
       RETURNING id`,
      [
        sessionId,
        "Disposable Stenographer PostgreSQL integration message.",
        `stenographer-integration:${randomUUID()}`,
        firstNow,
        `stenographer-integration:${randomUUID()}`,
      ],
    );
    const messageId = messages[0]?.["id"];
    assert(typeof messageId === "number", "Stenographer integration message insert failed");
    await transaction.query(
      `INSERT INTO room_journal_state (
         room_id, last_processed_message_id, extractor_version,
         historical_backfill_status, lease_token, lease_expires_at
       ) VALUES ($1, 0, $4, 'not_needed', $2, $3)`,
      [
        roomId,
        firstLeaseToken,
        new Date(firstNow.getTime() + 60_000),
        STENOGRAPHER_INTEGRATION_POLICY_VERSION,
      ],
    );
    await transaction.query(
      `INSERT INTO room_journal_batches (
         id, room_id, from_message_id_exclusive,
         through_message_id_inclusive, extractor_version, status,
         attempt_count, started_at, lane, observation_publication_version
       ) VALUES ($1, $2, 0, $3, $5, 'running', 1, $4, 'live', 1)`,
      [firstBatchId, roomId, messageId, firstNow, STENOGRAPHER_INTEGRATION_POLICY_VERSION],
    );
    return messages;
  }, { isolationLevel: "serializable" });
  const firstMessageId = firstMessageRows[0]?.["id"];
  assert(typeof firstMessageId === "number", "Stenographer integration message is unavailable");

  const publisher = new PostgresOrdinaryStenographerRecordPublisher({
    handle: input.handle,
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    commitment: createHmacRecordRequestCommitmentPort(randomBytes(32)),
  });
  const first = await publisher.publishExtraction({
    claim: {
      batchId: firstBatchId,
      roomId,
      leaseToken: firstLeaseToken,
      lane: "live",
      fromMessageIdExclusive: 0,
      throughMessageIdInclusive: firstMessageId,
      rebuildGeneration: null,
    },
    transition: {
      statusUpdates: [],
      inserts: [{
        batchLocalOrdinal: 0,
        sequence: 1,
        kind: "decision",
        statement: "The disposable integration Room recorded a decision.",
        sourceMessageIds: [firstMessageId],
        status: "active",
        supersedesEventId: null,
        resolvesEventId: null,
      }],
      foldedBatchLocalOrdinals: [],
      nextSequence: 2,
    },
    operationCount: 1,
    modelId: "integration:stenographer",
    extractorVersion: STENOGRAPHER_INTEGRATION_POLICY_VERSION,
    now: firstNow,
  });
  assert(
    first.published && first.eventsWritten === 1,
    "ordinary Stenographer event publication failed",
  );

  const firstState = await input.handle.query(
    `SELECT state.last_processed_message_id, state.lease_token,
            state.extraction_failure_count,
            batch.status, batch.observation_publication_version,
            batch.operation_count,
            event.id::text AS event_id, event.record_id::text AS record_id,
            event.projection_kind
       FROM room_journal_state state
       JOIN room_journal_batches batch ON batch.id = $2
       JOIN room_events event ON event.source_batch_id = batch.id
      WHERE state.room_id = $1`,
    [roomId, firstBatchId],
  );
  const firstRow = firstState[0];
  assert(
    firstRow?.["last_processed_message_id"] === firstMessageId
      && firstRow["lease_token"] === null
      && firstRow["extraction_failure_count"] === 0
      && firstRow["status"] === "completed"
      && firstRow["observation_publication_version"] === 2
      && firstRow["operation_count"] === 1
      && firstRow["event_id"] === firstRow["record_id"]
      && firstRow["projection_kind"] === "native",
    "ordinary Stenographer event publication did not atomically finalize",
  );
  const firstRecordId = firstRow?.["record_id"];
  assert(typeof firstRecordId === "string", "ordinary Stenographer Record is unavailable");
  await input.handle.transaction(async (transaction) => {
    await transaction.query(
      "SELECT set_config('nautilo.stenographer_writer_version', '2', true)",
    );
    await transaction.query(
      `UPDATE reflection_records
          SET lifecycle = 'superseded',
              processing_generation = processing_generation + 1,
              updated_at = greatest(updated_at, now())
        WHERE record_id = $1`,
      [firstRecordId],
    );
    await transaction.query(
      `UPDATE room_events SET status = 'superseded' WHERE id = $1`,
      [firstRecordId],
    );
  }, { isolationLevel: "serializable" });
  const evolvedJournal = await readOrdinaryStenographerJournalEventsWithHandle(
    input.handle,
    { roomId },
  );
  assert(
    evolvedJournal.length === 1
      && evolvedJournal[0]?.id === firstRecordId
      && evolvedJournal[0].statement
        === "The disposable integration Room recorded a decision.",
    "ordinary Stenographer Journal rejected an independently processed Record",
  );

  const secondBatchId = randomUUID();
  const secondLeaseToken = randomUUID();
  const secondNow = new Date(firstNow.getTime() + 1_000);
  const secondMessageRows = await input.handle.transaction(async (transaction) => {
    const messages = await transaction.query(
      `INSERT INTO session_messages (
         session_id, role, content, fingerprint, created_at, human_turn_id
       ) VALUES ($1, 'user', $2, $3, $4, $5)
       RETURNING id`,
      [
        sessionId,
        "Disposable zero-operation Stenographer message.",
        `stenographer-integration:${randomUUID()}`,
        secondNow,
        `stenographer-integration:${randomUUID()}`,
      ],
    );
    const messageId = messages[0]?.["id"];
    assert(typeof messageId === "number", "Stenographer zero-operation message insert failed");
    await transaction.query(
      `UPDATE room_journal_state
          SET lease_token = $2, lease_expires_at = $3, updated_at = $4
        WHERE room_id = $1`,
      [roomId, secondLeaseToken, new Date(secondNow.getTime() + 60_000), secondNow],
    );
    await transaction.query(
      `INSERT INTO room_journal_batches (
         id, room_id, from_message_id_exclusive,
         through_message_id_inclusive, extractor_version, status,
         attempt_count, started_at, lane, observation_publication_version
       ) VALUES ($1, $2, $3, $4, $6, 'running', 1, $5, 'live', 1)`,
      [
        secondBatchId,
        roomId,
        firstMessageId,
        messageId,
        secondNow,
        STENOGRAPHER_INTEGRATION_POLICY_VERSION,
      ],
    );
    return messages;
  }, { isolationLevel: "serializable" });
  const secondMessageId = secondMessageRows[0]?.["id"];
  assert(typeof secondMessageId === "number", "Stenographer zero-operation message is unavailable");
  const second = await publisher.publishExtraction({
    claim: {
      batchId: secondBatchId,
      roomId,
      leaseToken: secondLeaseToken,
      lane: "live",
      fromMessageIdExclusive: firstMessageId,
      throughMessageIdInclusive: secondMessageId,
      rebuildGeneration: null,
    },
    transition: {
      statusUpdates: [],
      inserts: [],
      foldedBatchLocalOrdinals: [],
      nextSequence: 2,
    },
    operationCount: 0,
    modelId: "integration:stenographer",
    extractorVersion: STENOGRAPHER_INTEGRATION_POLICY_VERSION,
    now: secondNow,
  });
  assert(
    second.published && second.eventsWritten === 0,
    "ordinary Stenographer zero-operation publication failed",
  );
  const secondState = await input.handle.query(
    `SELECT state.last_processed_message_id, state.lease_token,
            state.extraction_failure_count,
            batch.status, batch.observation_publication_version,
            batch.operation_count,
            (SELECT count(*)::integer FROM room_events WHERE room_id = $1) AS event_count
       FROM room_journal_state state
       JOIN room_journal_batches batch ON batch.id = $2
      WHERE state.room_id = $1`,
    [roomId, secondBatchId],
  );
  const secondRow = secondState[0];
  assert(
    secondRow?.["last_processed_message_id"] === secondMessageId
      && secondRow["lease_token"] === null
      && secondRow["extraction_failure_count"] === 0
      && secondRow["status"] === "completed"
      && secondRow["observation_publication_version"] === 2
      && secondRow["operation_count"] === 0
      && secondRow["event_count"] === 1,
    "ordinary Stenographer zero-operation publication did not atomically finalize",
  );
}

try {
  const handle = await verifyRecordProductPostgresHandle(connection);
  // A test-looking URL is not sufficient: populated QA clones also contain
  // "qa" in their connection metadata. Refuse them before settling or
  // creating any synthetic rows. Repeated runs remain allowed because this
  // suite owns every integration:* Record.
  await assertDisposableReflectionDatabase(handle);
  // A failed prior run may have left a due test-owned authority receipt. Settle
  // that exact synthetic prefix so retries remain deterministic; Record
  // identities themselves are intentionally immutable.
  await settleSyntheticIntegrationReceipts(handle);
  await settleSyntheticSemanticWork(handle);
  await retireSyntheticIntegrationRecords(handle);
  const requiredTables = [
    "reflection_records",
    "reflection_record_authority_projections",
    "reflection_record_search_projections",
    "reflection_record_semantic_work",
    "reflection_record_semantic_work_admissions",
    "reflection_record_dependency_change_repairs",
    "reflection_record_source_change_repairs",
    "reflection_record_source_dependency_index",
  ] as const;
  const inventory = await handle.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [requiredTables],
  );
  if (inventory.length !== requiredTables.length) {
    throw new Error("required Reflection migrations are not installed on the disposable integration database");
  }
  const recordId = `integration:${randomUUID()}`;
  const integrationEmbeddingProvider = `integration-${randomUUID()}`;
  const record: DurableRecordEnvelope = {
    recordRef: recordId,
    semantic: {
      observedContentFingerprint: `fixture:${recordId}`,
      posture: "derived",
      statement: "Disposable PostgreSQL integration Record.",
      sourceDependencies: [{
        sourceKind: "fixture",
        logicalSourceRef: `source:${recordId}`,
        observedRevision: "revision:1",
        observedContentFingerprint: "sha256:fixture",
        terminalAuthorityLeafHandle: `leaf:${recordId}`,
        authorityBearing: true,
      }],
      anchors: [{ kind: "room", anchorRef: "room:integration", role: "origin" }],
      childRecordRefs: [],
      producer: { producerRef: "integration", policyVersion: "policy:v1" },
      terminalAuthorityLeafHandles: [`leaf:${recordId}`],
    },
    lifecycle: "current",
    structuralHeight: 0,
    processingGeneration: 1,
  };
  // Keep the synthetic row ahead of any populated-clone backlog without
  // mutating or draining real cloned work. The suite owns this timestamp.
  let semanticNow = new Date("2000-01-01T00:00:00.000Z");
  const semanticCommitments = createHmacRecordSemanticCommitmentPort(randomBytes(32));
  const semanticWork = new PostgresSemanticWorkStore({
    handle,
    commitments: semanticCommitments,
    clock: () => semanticNow,
    leaseMilliseconds: 1_000,
    retryMilliseconds: 1_000,
  });
  const semanticRepository = new DualModeRecordRepository({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    product: new PostgresRecordProductStore(handle, semanticWork),
    commitment: createHmacRecordRequestCommitmentPort(randomBytes(32)),
  });
  const repository = new DualModeRecordRepository({
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    product: new PostgresRecordProductStore(handle),
    commitment: createHmacRecordRequestCommitmentPort(randomBytes(32)),
  });

  async function forceLegacyFixtureLifecycle(
    recordRef: string,
    lifecycle: "current" | "stale",
  ): Promise<void> {
    await handle.query(
      `UPDATE reflection_records
          SET lifecycle = CASE WHEN $2::boolean THEN 'current' ELSE 'stale' END,
              processing_generation = processing_generation + 1,
              updated_at = now()
        WHERE record_id = $1`,
      [recordRef, lifecycle === "current"],
    );
  }

  async function publishForestFixture(input: Readonly<{
    name: string;
    childRecordRefs?: readonly string[];
    structuralHeight?: number;
    predecessor?: { readonly recordRef: string; readonly relation: "supersedes" | "resolves" };
  }>) {
    const recordRef = `integration:forest:${input.name}:${randomUUID()}`;
    const childRecordRefs = input.childRecordRefs ?? [];
    const fixture: DurableRecordEnvelope = {
      recordRef,
      semantic: {
        observedContentFingerprint: `fixture:${recordRef}`,
        posture: "derived",
        statement: `Forest integration fixture ${input.name}.`,
        sourceDependencies: [],
        anchors: [],
        childRecordRefs,
        producer: { producerRef: "integration", policyVersion: "m288" },
        terminalAuthorityLeafHandles: childRecordRefs.length === 0
          ? [`leaf:${recordRef}`]
          : childRecordRefs.map((child) => `leaf:${child}`).sort(),
      },
      lifecycle: "current",
      structuralHeight: input.structuralHeight ?? 0,
      processingGeneration: 1,
    };
    const result = await repository.publish({
      record: fixture,
      ...(input.predecessor === undefined ? {} : { predecessor: input.predecessor }),
      idempotencyKey: `publication:${recordRef}`,
      publicationBindingRef: "binding:integration:forest",
    });
    return { recordRef, fixture, result };
  }

  // Two transactions race for the same unparented child. The shared child
  // advisory lock makes one publication win and the other fail closed.
  const forestA = await publishForestFixture({ name: "a" });
  const forestB = await publishForestFixture({ name: "b" });
  const forestC = await publishForestFixture({ name: "c" });
  const forestD = await publishForestFixture({ name: "d" });
  const forestE = await publishForestFixture({ name: "e" });
  const forestF = await publishForestFixture({ name: "f" });
  const competingParentInputs = [
    { name: "race-ab", childRecordRefs: [forestA.recordRef, forestB.recordRef] },
    { name: "race-ac", childRecordRefs: [forestA.recordRef, forestC.recordRef] },
  ] as const;
  const competingParents = await Promise.all(competingParentInputs.map((value) =>
    publishForestFixture({ ...value, structuralHeight: 1 })
  ));
  const raceWinners = competingParents.filter((value) => value.result.status === "published");
  const raceLosers = competingParents.filter((value) =>
    value.result.status === "rejected" && value.result.reason === "structural_conflict"
  );
  assert(
    raceWinners.length === 1 && raceLosers.length === 1,
    "concurrent parent race did not produce exactly one structural winner",
  );
  const raceWinner = raceWinners[0]!;
  const raceWinnerChildren = raceWinner.fixture.semantic.childRecordRefs;
  const currentParentAfterRace = await handle.query(
    `SELECT parent.record_id
       FROM reflection_record_dependencies AS dependency
       JOIN reflection_records AS parent
         ON parent.record_id = dependency.parent_record_id
      WHERE dependency.child_record_id = $1
        AND parent.lifecycle = 'current'
        AND parent.disposition = 'available'`,
    [forestA.recordRef],
  );
  assert(
    currentParentAfterRace.length === 1
      && currentParentAfterRace[0]!['record_id'] === raceWinner.recordRef,
    "racing publications left a child with zero or multiple current parents",
  );

  const successor = await publishForestFixture({
    name: "successor",
    childRecordRefs: [...raceWinnerChildren, forestD.recordRef],
    structuralHeight: 1,
    predecessor: { recordRef: raceWinner.recordRef, relation: "supersedes" },
  });
  assert(successor.result.status === "published", "legal parent extension was rejected");
  const successorState = await handle.query(
    `SELECT record_id, lifecycle FROM reflection_records
      WHERE record_id = ANY($1::text[]) ORDER BY record_id`,
    [[raceWinner.recordRef, successor.recordRef]],
  );
  assert(
    successorState.some((row) => row["record_id"] === raceWinner.recordRef
      && row["lifecycle"] === "superseded")
      && successorState.some((row) => row["record_id"] === successor.recordRef
        && row["lifecycle"] === "current"),
    "parent extension did not atomically replace the predecessor lifecycle",
  );
  const historicalWinnerEdges = await handle.query(
    `SELECT child_record_id FROM reflection_record_dependencies
      WHERE parent_record_id = $1 ORDER BY child_record_id`,
    [raceWinner.recordRef],
  );
  assert(
    historicalWinnerEdges.length === raceWinnerChildren.length,
    "parent extension destroyed immutable predecessor evidence edges",
  );

  const wrapper = await publishForestFixture({
    name: "wrapper",
    childRecordRefs: [successor.recordRef, forestE.recordRef],
    structuralHeight: 2,
  });
  assert(wrapper.result.status === "published", "legal parent wrap was rejected");
  const secondWrapper = await publishForestFixture({
    name: "second-wrapper",
    childRecordRefs: [successor.recordRef, forestF.recordRef],
    structuralHeight: 2,
  });
  assert(
    secondWrapper.result.status === "rejected"
      && secondWrapper.result.reason === "structural_conflict"
      && secondWrapper.result.structuralReason === "child_parent_changed",
    "a current parent was allowed to acquire a second current parent",
  );

  // Construct one test-owned legacy violation through direct fixture mutation,
  // prove it is counted and blocks another publication, then let the durable
  // parent-conflict lane symmetrically retire and rebuild it.
  const legacyLeaf = await publishForestFixture({ name: "legacy-leaf" });
  const legacySiblingA = await publishForestFixture({ name: "legacy-a" });
  const legacySiblingB = await publishForestFixture({ name: "legacy-b" });
  const legacySiblingC = await publishForestFixture({ name: "legacy-c" });
  const legacyParentA = await publishForestFixture({
    name: "legacy-parent-a",
    childRecordRefs: [legacyLeaf.recordRef, legacySiblingA.recordRef],
    structuralHeight: 1,
  });
  assert(legacyParentA.result.status === "published", "legacy fixture parent A failed");
  assert((await repository.transitionLifecycle({
    recordRef: legacyParentA.recordRef,
    expectedProcessingGeneration: 1,
    from: "current",
    to: "stale",
  })).status === "transitioned", "legacy fixture parent A did not become stale");
  const legacyParentB = await publishForestFixture({
    name: "legacy-parent-b",
    childRecordRefs: [legacyLeaf.recordRef, legacySiblingB.recordRef],
    structuralHeight: 1,
  });
  assert(legacyParentB.result.status === "published", "legacy fixture parent B failed");
  const blockedLegacyRestore = await repository.transitionLifecycle({
    recordRef: legacyParentA.recordRef,
    expectedProcessingGeneration: 2,
    from: "stale",
    to: "current",
  });
  assert(
    blockedLegacyRestore.status === "conflict",
    "canonical lifecycle restore recreated a second current parent",
  );
  await forceLegacyFixtureLifecycle(legacyParentA.recordRef, "current");
  const legacyViolationRows = await handle.query(
      `SELECT dependency.child_record_id
         FROM reflection_record_dependencies AS dependency
         JOIN reflection_records AS parent
           ON parent.record_id = dependency.parent_record_id
        WHERE dependency.child_record_id = $1
          AND parent.lifecycle = 'current'
          AND parent.disposition = 'available'
        GROUP BY dependency.child_record_id HAVING count(*) > 1`,
      [legacyLeaf.recordRef],
    );
  assert(legacyViolationRows.length === 1, "legacy multi-parent violation was not detectable");
  const legacyThird = await publishForestFixture({
      name: "legacy-parent-c",
      childRecordRefs: [legacyLeaf.recordRef, legacySiblingC.recordRef],
      structuralHeight: 1,
    });
  assert(
    legacyThird.result.status === "rejected"
      && legacyThird.result.reason === "structural_conflict"
      && legacyThird.result.structuralReason === "child_parent_changed",
    "legacy multi-parent state did not fail closed",
  );
  const conflictAdmission = await semanticWork.admitParentConflictsPage({ limit: 16 });
  assert(conflictAdmission.admitted === 1, "legacy parent conflict was not admitted");
  const conflictClaim = await semanticWork.claimNext(undefined, {
    includeOrganization: false,
  });
  assert(
    conflictClaim.status === "claimed"
      && conflictClaim.claim.recordRef === legacyLeaf.recordRef
      && conflictClaim.claim.changeReason === "parent_conflict",
    "legacy parent conflict did not receive highest-priority work",
  );
  if (conflictClaim.status !== "claimed") {
    throw new Error("legacy parent-conflict claim failed");
  }
  const conflictRepair = await semanticWork.resolveParentConflict({
    claim: conflictClaim.claim,
  });
  assert(
    conflictRepair.status === "applied"
      && conflictRepair.retiredParents === 2
      && conflictRepair.requeuedRecords === 3,
    "legacy parent conflict did not retire and requeue its complete support",
  );
  const repairedParents = await handle.query(
    `SELECT record_id, lifecycle
       FROM reflection_records
      WHERE record_id = ANY($1::text[])
      ORDER BY record_id`,
    [[legacyParentA.recordRef, legacyParentB.recordRef]],
  );
  assert(
    repairedParents.length === 2
      && repairedParents.every((row) => row["lifecycle"] === "resolved"),
    "legacy conflicting parents remained current after repair",
  );
  const repairedCurrentParents = await handle.query(
    `SELECT parent.record_id
       FROM reflection_record_dependencies AS dependency
       JOIN reflection_records AS parent
         ON parent.record_id = dependency.parent_record_id
      WHERE dependency.child_record_id = $1
        AND parent.lifecycle = 'current'
        AND parent.disposition = 'available'`,
    [legacyLeaf.recordRef],
  );
  assert(repairedCurrentParents.length === 0, "legacy child retained a current parent");
  const preservedLegacyEdges = await handle.query(
    `SELECT parent_record_id, child_record_id
       FROM reflection_record_dependencies
      WHERE parent_record_id = ANY($1::text[])`,
    [[legacyParentA.recordRef, legacyParentB.recordRef]],
  );
  assert(preservedLegacyEdges.length === 4, "legacy repair destroyed immutable evidence edges");
  const rebuildWork = await handle.query(
    `SELECT record_id, change_reason, state
       FROM reflection_record_semantic_work
      WHERE record_id = ANY($1::text[])
      ORDER BY record_id`,
    [[legacyLeaf.recordRef, legacySiblingA.recordRef, legacySiblingB.recordRef]],
  );
  assert(
    rebuildWork.length === 3
      && rebuildWork.filter((row) =>
        row["change_reason"] === "parent_conflict" && row["state"] === "due"
      ).length === 1
      && rebuildWork.filter((row) =>
        row["change_reason"] === "revised" && row["state"] === "due"
      ).length === 2,
    "legacy support was not durably re-admitted for rebuild",
  );
  const obsoleteConflictClaim = await semanticWork.claimNext(undefined, {
    includeOrganization: false,
  });
  assert(
    obsoleteConflictClaim.status === "claimed"
      && obsoleteConflictClaim.claim.recordRef === legacyLeaf.recordRef
      && obsoleteConflictClaim.claim.changeReason === "parent_conflict",
    "resolved legacy conflict did not retain repair priority",
  );
  if (obsoleteConflictClaim.status !== "claimed") {
    throw new Error("obsolete parent-conflict claim failed");
  }
  assert(
    (await semanticWork.resolveParentConflict({
      claim: obsoleteConflictClaim.claim,
    })).status === "not_applicable",
    "resolved legacy conflict did not become a model-free no-op",
  );
  assert(
    (await semanticWork.complete({ claim: obsoleteConflictClaim.claim })).status
      === "accepted",
    "resolved legacy conflict could not complete at its admission stage",
  );
  const pendingLegacySupport = new Set([
    legacySiblingA.recordRef,
    legacySiblingB.recordRef,
  ]);
  for (let ordinal = 0; ordinal < 6; ordinal += 1) {
    const supportClaim = await semanticWork.claimNext();
    assert(
      supportClaim.status === "claimed"
        && pendingLegacySupport.has(supportClaim.claim.recordRef),
      "legacy support rebuild work escaped its fixture",
    );
    if (supportClaim.status !== "claimed") {
      throw new Error("legacy support rebuild claim failed");
    }
    if (supportClaim.claim.stage === "organization") {
      assert(
        (await semanticWork.complete({ claim: supportClaim.claim })).status
          === "accepted",
        "legacy support rebuild completion failed",
      );
      pendingLegacySupport.delete(supportClaim.claim.recordRef);
    } else {
      assert(
        (await semanticWork.checkpoint({
          claim: supportClaim.claim,
          completedStage: supportClaim.claim.stage,
        })).status === "accepted",
        "legacy support rebuild checkpoint failed",
      );
    }
  }
  assert(pendingLegacySupport.size === 0, "legacy support rebuild work did not drain");
  const rebuiltParent = await publishForestFixture({
    name: "legacy-rebuilt-parent",
    childRecordRefs: [legacyLeaf.recordRef, legacySiblingC.recordRef],
    structuralHeight: 1,
  });
  assert(
    rebuiltParent.result.status === "published",
    "repaired legacy child could not acquire one new current parent",
  );

  const publication = {
    record,
    idempotencyKey: `publication:${randomUUID()}`,
    publicationBindingRef: "binding:integration",
  };
  const published = await semanticRepository.publish(publication);
  if (published.status !== "published") throw new Error("ordinary Record publication failed");
  const replayed = await semanticRepository.publish(publication);
  if (replayed.status !== "replayed") throw new Error("ordinary Record replay failed");
  const read = await repository.read({ recordRef: recordId, readBindingRef: "read:integration" });
  if (read.status !== "available" || read.record.semantic.statement !== record.semantic.statement) {
    throw new Error("ordinary Record read failed");
  }

  const semanticRows = await handle.query(
    `SELECT work.generation, work.completed_generation, work.change_reason,
            work.stage, work.state,
            (SELECT count(*)::integer
               FROM reflection_record_semantic_work_admissions AS admission
              WHERE admission.record_id = work.record_id) AS admission_count,
            (SELECT count(*)::integer
               FROM reflection_record_source_dependency_index AS dependency
              WHERE dependency.record_id = work.record_id) AS dependency_count
       FROM reflection_record_semantic_work AS work
      WHERE work.record_id = $1`,
    [recordId],
  );
  assert(semanticRows.length === 1, "ordinary publication did not admit semantic work");
  assert(
    semanticRows[0]!["generation"] === 1
      && semanticRows[0]!["completed_generation"] === 0
      && semanticRows[0]!["change_reason"] === "created"
      && semanticRows[0]!["stage"] === "authority_projection"
      && semanticRows[0]!["state"] === "due"
      && semanticRows[0]!["admission_count"] === 1
      && semanticRows[0]!["dependency_count"] === 1,
    "ordinary publication semantic-work state is incoherent",
  );

  const authorityClaim = await semanticWork.claimNext();
  assert(
    authorityClaim.status === "claimed"
      && authorityClaim.claim.recordRef === recordId
      && authorityClaim.claim.stage === "authority_projection",
    "semantic authority stage was not leased",
  );
  if (authorityClaim.status !== "claimed") throw new Error("semantic authority claim failed");
  const firstClaimedAtEpochMs = authorityClaim.claim.timing?.firstClaimedAtEpochMs;
  assert(
    firstClaimedAtEpochMs === semanticNow.getTime(),
    "semantic first-claim coordinate was not recorded",
  );
  assert(
    (await semanticWork.checkpoint({
      claim: authorityClaim.claim,
      completedStage: "authority_projection",
    })).status === "accepted",
    "semantic authority checkpoint failed",
  );
  const restartedSemanticWork = new PostgresSemanticWorkStore({
    handle,
    commitments: semanticCommitments,
    clock: () => semanticNow,
    leaseMilliseconds: 1_000,
    retryMilliseconds: 1_000,
  });
  semanticNow = new Date(semanticNow.getTime() + 1_000);
  const searchClaim = await restartedSemanticWork.claimNext();
  assert(
    searchClaim.status === "claimed" && searchClaim.claim.stage === "search_projection",
    "semantic search stage did not resume after restart",
  );
  if (searchClaim.status !== "claimed") throw new Error("semantic search claim failed");
  assert(
    searchClaim.claim.timing?.firstClaimedAtEpochMs === firstClaimedAtEpochMs,
    "semantic first-claim coordinate did not survive restart",
  );
  assert(
    (await restartedSemanticWork.checkpoint({
      claim: searchClaim.claim,
      completedStage: "search_projection",
    })).status === "accepted",
    "semantic search checkpoint failed",
  );
  const organizationClaim = await semanticWork.claimNext();
  assert(
    organizationClaim.status === "claimed" && organizationClaim.claim.stage === "organization",
    "semantic organization stage was not leased",
  );
  if (organizationClaim.status !== "claimed") throw new Error("semantic organization claim failed");
  assert(
    organizationClaim.claim.timing?.firstClaimedAtEpochMs === firstClaimedAtEpochMs,
    "semantic first-claim coordinate changed across checkpoints",
  );
  assert(
    (await semanticWork.complete({ claim: organizationClaim.claim })).status === "accepted",
    "semantic organization completion failed",
  );

  // An abandoned lease represents interrupted work, not a fresh FIFO item.
  // It must be reclaimed before an attempt-zero due row so restart recovery
  // cannot sit behind a large bootstrap backlog.
  const expiredLeaseFixture = await publishForestFixture({ name: "expired-lease" });
  const freshDueFixture = await publishForestFixture({ name: "fresh-due" });
  const expiredLeaseToken = randomUUID();
  const expiredDueSince = new Date(semanticNow.getTime() - 1_000);
  const freshDueSince = new Date(semanticNow.getTime() - 2_000);
  await handle.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO reflection_record_semantic_work (
         record_id, generation, completed_generation, change_reason, stage,
         state, claim_generation, attempt_count, lease_token, lease_expires_at,
         due_since, started_at, created_at, updated_at
       ) VALUES ($1, 1, 0, 'created', 'authority_projection',
                 'claimed', 1, 1, $2, $3, $4, $4, $4, $4)`,
      [
        expiredLeaseFixture.recordRef,
        expiredLeaseToken,
        new Date(semanticNow.getTime() - 1),
        expiredDueSince,
      ],
    );
    await transaction.query(
      `INSERT INTO reflection_record_semantic_work (
         record_id, generation, completed_generation, change_reason, stage,
         state, attempt_count, next_attempt_at, due_since, created_at, updated_at
       ) VALUES ($1, 1, 0, 'created', 'authority_projection',
                 'due', 0, $2, $2, $2, $2)`,
      [freshDueFixture.recordRef, freshDueSince],
    );
  }, { isolationLevel: "read committed" });
  const reclaimedLease = await semanticWork.claimNext(undefined, {
    includeOrganization: false,
  });
  assert(
    reclaimedLease.status === "claimed"
      && reclaimedLease.claim.recordRef === expiredLeaseFixture.recordRef,
    "expired semantic lease was starved behind fresh due work",
  );
  if (reclaimedLease.status !== "claimed") {
    throw new Error("expired semantic lease reclaim failed");
  }
  assert(
    (await semanticWork.checkpoint({
      claim: reclaimedLease.claim,
      completedStage: "authority_projection",
    })).status === "accepted",
    "reclaimed semantic lease did not checkpoint",
  );
  await handle.query(
    `UPDATE reflection_record_semantic_work
        SET state = 'quarantined', claim_generation = NULL,
            lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = NULL, failure_code = 'retry_exhausted',
            quarantine_round = quarantine_round + 1,
            recover_after = now() + interval '7 days',
            completed_at = NULL, updated_at = greatest(updated_at, now())
      WHERE record_id = ANY($1::text[])
        AND state IN ('due', 'claimed', 'checkpointed', 'deferred')`,
    [[expiredLeaseFixture.recordRef, freshDueFixture.recordRef]],
  );

  // Simulate a populated clone whose derived parent completed before the
  // scheduled-review lane existed. The existing bounded bootstrap must admit
  // that parent once, then exclude its newly scheduled generation.
  const promotionRecordId = `integration:zzzz-promotion-${randomUUID()}`;
  const promotionRecord: DurableRecordEnvelope = {
    recordRef: promotionRecordId,
    semantic: {
      observedContentFingerprint: `fixture:${promotionRecordId}`,
      posture: "derived",
      statement: "Disposable parent awaiting one promotion review.",
      sourceDependencies: [],
      anchors: record.semantic.anchors,
      childRecordRefs: [recordId],
      producer: { producerRef: "integration", policyVersion: "policy:v1" },
      terminalAuthorityLeafHandles: record.semantic.terminalAuthorityLeafHandles,
    },
    lifecycle: "current",
    structuralHeight: 1,
    processingGeneration: 1,
  };
  const promotionPublication = await repository.publish({
    record: promotionRecord,
    idempotencyKey: `publication:${promotionRecordId}`,
    publicationBindingRef: "binding:integration",
  });
  assert(promotionPublication.status === "published", "promotion fixture publication failed");
  await handle.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO reflection_record_semantic_work (
         record_id, generation, completed_generation, change_reason, stage,
         state, attempt_count, due_since, completed_at, created_at, updated_at
       ) VALUES ($1, 1, 1, 'created', 'organization', 'complete', 0, $2, $2, $2, $2)`,
      [promotionRecordId, semanticNow],
    );
    await transaction.query(
      `INSERT INTO reflection_record_semantic_work_admissions (
         record_id, admission_commitment, assigned_generation, created_at
       ) VALUES ($1, $2, 1, $3)`,
      [promotionRecordId, randomBytes(32), semanticNow],
    );
  }, { isolationLevel: "read committed" });
  const promotionContinuation = promotionRecordId.slice(0, -1);
  assert((await semanticWork.bootstrapPage({
    limit: 1,
    continuation: promotionContinuation,
  })).admitted === 1, "existing parent promotion was not admitted");
  const promotionRows = await handle.query(
    `SELECT generation, completed_generation, change_reason, stage, state,
            next_attempt_at,
            (SELECT count(*)::integer
               FROM reflection_record_semantic_work_admissions AS admission
              WHERE admission.record_id = work.record_id) AS admission_count
       FROM reflection_record_semantic_work AS work
      WHERE work.record_id = $1`,
    [promotionRecordId],
  );
  assert(
    promotionRows.length === 1
      && promotionRows[0]!["generation"] === 2
      && promotionRows[0]!["completed_generation"] === 1
      && promotionRows[0]!["change_reason"] === "scheduled_review"
      && promotionRows[0]!["stage"] === "authority_projection"
      && promotionRows[0]!["state"] === "due"
      && promotionRows[0]!["admission_count"] === 2
      && (promotionRows[0]!["next_attempt_at"] as Date).getTime()
        === semanticNow.getTime() + 5 * 60 * 1_000,
    "existing parent promotion state is incoherent",
  );
  const candidateRecoveryRecordId =
    `integration:zzzy-candidate-recovery-${randomUUID()}`;
  const candidateRecoveryPublication = await semanticRepository.publish({
    record: {
      ...record,
      recordRef: candidateRecoveryRecordId,
      semantic: {
        ...record.semantic,
        observedContentFingerprint: `fixture:${candidateRecoveryRecordId}`,
        childRecordRefs: [],
      },
      structuralHeight: 0,
    },
    idempotencyKey: `publication:${candidateRecoveryRecordId}`,
    publicationBindingRef: "binding:integration",
  });
  assert(
    candidateRecoveryPublication.status === "published",
    "candidate-policy recovery fixture publication failed",
  );
  await handle.query(
    `UPDATE reflection_record_semantic_work
        SET state = 'quarantined', attempt_count = 8,
            quarantine_round = quarantine_round + 1,
            next_attempt_at = NULL, recover_after = now() + interval '7 days',
            failure_code = 'candidate_unavailable'
      WHERE record_id = $1`,
    [candidateRecoveryRecordId],
  );
  assert((await semanticWork.recoverCandidatePolicyQuarantinesPage({
    limit: 256,
    policyVersion: "authority-aware-parent-normalization-v1",
    continuation: "integration:zzzx",
  })).admitted === 1, "obsolete candidate quarantine was not recovered");
  await handle.query(
    `UPDATE reflection_record_semantic_work
        SET state = 'quarantined', attempt_count = 8,
            quarantine_round = quarantine_round + 1,
            next_attempt_at = NULL, recover_after = now() + interval '7 days',
            failure_code = 'candidate_unavailable'
      WHERE record_id = $1`,
    [candidateRecoveryRecordId],
  );
  assert((await semanticWork.recoverCandidatePolicyQuarantinesPage({
    limit: 256,
    policyVersion: "authority-aware-parent-normalization-v1",
    continuation: "integration:zzzx",
  })).admitted === 0, "candidate-policy recovery replay admitted twice");
  const promotionEligibilityRows = await handle.query(
    `SELECT count(*)::integer AS eligible
       FROM reflection_records AS record
       LEFT JOIN reflection_record_semantic_work AS work
         ON work.record_id = record.record_id
      WHERE record.record_id = $1
        AND record.disposition = 'available'
        AND (
          work.record_id IS NULL
          OR (
            record.lifecycle = 'current'
            AND record.structural_height > 0
            AND work.state = 'complete'
            AND work.change_reason <> 'scheduled_review'
          )
        )`,
    [promotionRecordId],
  );
  assert(
    promotionEligibilityRows[0]!["eligible"] === 0,
    "scheduled parent remained eligible for bootstrap replay",
  );

  // Build a three-hop native dependency chain without relying on model work.
  // Later lifecycle transitions prove that each changed child durably admits
  // only its direct parent, whose own transition reserves the following hop.
  const cascadeRecordIds = [
    promotionRecordId,
    `integration:zzzz-cascade-p2-${randomUUID()}`,
    `integration:zzzz-cascade-p3-${randomUUID()}`,
  ] as const;
  for (const [offset, cascadeRecordId] of cascadeRecordIds.slice(1).entries()) {
    const childRecordRef = cascadeRecordIds[offset]!;
    const cascadeRecord: DurableRecordEnvelope = {
      recordRef: cascadeRecordId,
      semantic: {
        observedContentFingerprint: `fixture:${cascadeRecordId}`,
        posture: "derived",
        statement: `Disposable cascade parent ${offset + 2}.`,
        sourceDependencies: [],
        anchors: record.semantic.anchors,
        childRecordRefs: [childRecordRef],
        producer: { producerRef: "integration", policyVersion: "policy:v1" },
        terminalAuthorityLeafHandles: record.semantic.terminalAuthorityLeafHandles,
      },
      lifecycle: "current",
      structuralHeight: offset + 2,
      processingGeneration: 1,
    };
    const cascadePublication = await semanticRepository.publish({
      record: cascadeRecord,
      idempotencyKey: `publication:${cascadeRecordId}`,
      publicationBindingRef: "binding:integration",
    });
    assert(cascadePublication.status === "published", "cascade fixture publication failed");
  }

  const sourceDependencyCommitment = semanticCommitments.sourceDependency(
    record.semantic.sourceDependencies[0]!,
  );
  const sourceChangeCommitment = semanticCommitments.sourceChange({
    sourceKind: record.semantic.sourceDependencies[0]!.sourceKind,
    logicalSourceRef: record.semantic.sourceDependencies[0]!.logicalSourceRef,
    changeRef: "revision:2",
  });
  assert((await semanticWork.admitSourceDependentsPage({
    sourceDependencyCommitment,
    sourceChangeCommitment,
    limit: 1,
  })).admitted === 1, "semantic dependency loss was not admitted");
  assert((await semanticWork.admitSourceDependentsPage({
    sourceDependencyCommitment,
    sourceChangeCommitment,
    limit: 1,
  })).admitted === 0, "semantic dependency-loss replay advanced work twice");
  const dependencyClaim = await semanticWork.claimNext();
  assert(
    dependencyClaim.status === "claimed"
      && dependencyClaim.claim.changeReason === "dependency_lost"
      && dependencyClaim.claim.stage === "authority_projection",
    "semantic dependency-loss work did not restart from authority",
  );
  if (dependencyClaim.status !== "claimed") throw new Error("semantic dependency claim failed");
  assert(
    (await semanticWork.defer({
      claim: dependencyClaim.claim,
      failureCode: "projection_unavailable",
    })).status === "deferred",
    "semantic retry deferral failed",
  );
  semanticNow = new Date(semanticNow.getTime() + 1_001);
  const retriedDependencyClaim = await restartedSemanticWork.claimNext();
  assert(
    retriedDependencyClaim.status === "claimed"
      && retriedDependencyClaim.claim.recordRef === recordId,
    "semantic deferred work did not resume after restart",
  );
  if (retriedDependencyClaim.status !== "claimed") throw new Error("semantic retry claim failed");
  assert(
    (await restartedSemanticWork.pause({ claim: retriedDependencyClaim.claim })).status === "accepted",
    "semantic retry pause failed",
  );
  await assertSemanticWorkSecurity(handle);

  const authority = new PostgresAuthorityProjectionStore(handle);
  const terminalLeafHandle = record.semantic.terminalAuthorityLeafHandles[0]!;
  assert(await authority.installInitialClosure({
    recordRef: recordId,
    closureGeneration: 1,
    terminalAuthorityLeafHandles: [terminalLeafHandle],
  }) === "installed", "initial authority closure was not installed");
  assert(await authority.installInitialClosure({
    recordRef: recordId,
    closureGeneration: 1,
    terminalAuthorityLeafHandles: [terminalLeafHandle],
  }) === "replayed", "initial authority closure replay failed");

  const accessNamespaceId = randomUUID();
  const accessRoomId = randomUUID();
  const humanRows = await handle.query(
    `SELECT actor.id AS actor_id, actor.owner_id
       FROM actors AS actor
       JOIN users AS human_user ON human_user.id = actor.owner_id
      WHERE actor.kind = 'user'
      ORDER BY actor.created_at, actor.id
      LIMIT 1`,
  );
  assert(humanRows.length === 1, "integration database has no canonical Human actor");
  const humanActorIdValue = humanRows[0]!["actor_id"];
  const ownerIdValue = humanRows[0]!["owner_id"];
  assert(
    typeof humanActorIdValue === "string" && typeof ownerIdValue === "string",
    "integration Human identity is malformed",
  );
  const humanActorId: string = humanActorIdValue;
  const ownerId: string = ownerIdValue;
  await assertOrdinaryStenographerPublication({
    handle,
    ownerId,
    humanActorId,
  });
  await handle.transaction(async (transaction) => {
    await transaction.query(
      `INSERT INTO namespaces (id, scope, label) VALUES ($1, 'integration', $2)`,
      [accessNamespaceId, `reflection-search:${recordId}`],
    );
    await transaction.query(
      `INSERT INTO rooms (
         id, owner_id, type, label, graph_thread_id, namespace_id,
         human_actor_ids, kind
       ) VALUES ($1, $2, 'shared', $3, $4, $5, $6::uuid[], 'access')`,
      [
        accessRoomId,
        ownerId,
        `Reflection search access ${recordId}`,
        `reflection-search:${accessRoomId}`,
        accessNamespaceId,
        `{${humanActorId}}`,
      ],
    );
  }, { isolationLevel: "serializable" });
  assert(await authority.applyProjectionCas({
    recordRef: recordId,
    expectedProjectionGeneration: 1,
    sourceChangeGeneration: 2,
    terminalAuthorityLeafHandles: [terminalLeafHandle],
    audienceSetCommitment: randomBytes(32),
    alternatives: [{
      accessNamespaceId,
      includesPublicBoundary: true,
      alternativeCommitment: randomBytes(32),
    }],
  }) === "applied", "ordinary authority projection CAS failed");
  const current = await authority.readCurrent(recordId);
  assert(
    current?.projectionGeneration === 2
      && current.processingState === "current"
      && current.alternatives.length === 1,
    "ordinary authority projection read failed",
  );

  const deterministicVector = Object.freeze(
    Array.from(
      { length: 1_536 },
      (_, index) => Math.fround((index + 1) / 1_537),
    ),
  );
  const searchProjection = new PostgresRecordSearchProjectionStore(handle);
  assert(await searchProjection.publish({
    recordRef: recordId,
    recordProcessingGeneration: 1,
    projectionVersion: 1,
    projectionGeneration: 1,
    embedding: {
      provenance: {
        provider: integrationEmbeddingProvider,
        canonicalModel: "deterministic-v1",
        dimensions: 1_536,
        contractVersion: 1,
      },
      vector: deterministicVector,
    },
  }) === "published", "search projection publication failed");
  const reusableProjection = await searchProjection.readCurrentEmbedding(recordId);
  assert(
    reusableProjection !== null
      && reusableProjection.recordProcessingGeneration === 1
      && reusableProjection.embedding.provenance.provider
        === integrationEmbeddingProvider
      && reusableProjection.embedding.vector.length === 1_536
      && reusableProjection.embedding.vector[0] === deterministicVector[0]
      && reusableProjection.embedding.vector[1_535] === deterministicVector[1_535],
    "Organizer search projection reuse failed",
  );
  const vectorRows = await handle.query(
    `SELECT vector_dims(embedding) AS dimensions,
            pg_column_size(embedding) AS external_payload_bytes,
            pg_column_size((embedding::text)::vector) AS datum_bytes
       FROM reflection_record_search_projections
      WHERE record_id = $1`,
    [recordId],
  );
  assert(vectorRows.length === 1, "search projection row is absent");
  assert(Number(vectorRows[0]!["dimensions"]) === 1_536, "search vector dimensions drifted");
  assert(
    Number(vectorRows[0]!["external_payload_bytes"])
      === RECORD_SEARCH_POLICY_V1.pgvectorExternalPayloadBytes,
    "search vector external payload is not 6,148 bytes",
  );
  assert(
    Number(vectorRows[0]!["datum_bytes"])
      === RECORD_SEARCH_POLICY_V1.pgvectorPayloadBytes,
    "search vector in-memory datum is not 6,152 bytes",
  );

  const exactSearch = new PostgresAuthorityFilteredRecordSearchStore(handle);
  for (const includesPublicBoundary of [false, true]) {
    const searched = await exactSearch.search({
      embedding: {
        provenance: {
          provider: integrationEmbeddingProvider,
          canonicalModel: "deterministic-v1",
          dimensions: 1_536,
          contractVersion: 1,
        },
        vector: deterministicVector,
      },
      invocationAudience: {
        humanRefs: [humanActorId],
        includesPublicBoundary,
      },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      limit: 1,
    });
    assert(searched.status === "available", "authority-filtered search was unavailable");
    assert(searched.coordinates[0]?.recordRef === recordId, "eligible Record was not ranked");
    assert(searched.coordinates[0]?.score === 1, "exact deterministic vector did not rank at one");
  }

  async function publishOrganizerCandidate(
    name: string,
    publicationBindingRef: string,
    childRecordRefs: readonly string[] = [],
    inheritedTerminalAuthorityLeafHandles: readonly string[] = [],
    embeddingProvider = integrationEmbeddingProvider,
    embeddingModel = "deterministic-v1",
  ): Promise<string> {
    const candidateId = `integration:organizer:${name}:${randomUUID()}`;
    const candidateLeaf = `leaf:${candidateId}`;
    const terminalAuthorityLeafHandles = childRecordRefs.length === 0
      ? [candidateLeaf]
      : [...inheritedTerminalAuthorityLeafHandles, candidateLeaf].sort();
    const candidate: DurableRecordEnvelope = {
      ...record,
      recordRef: candidateId,
      semantic: {
        ...record.semantic,
        observedContentFingerprint: `fixture:${candidateId}`,
        statement: `Organizer candidate ${name}`,
        sourceDependencies: [],
        childRecordRefs,
        terminalAuthorityLeafHandles,
      },
      structuralHeight: childRecordRefs.length === 0 ? 0 : 1,
    };
    const candidatePublication = await repository.publish({
      record: candidate,
      idempotencyKey: `publication:${randomUUID()}`,
      publicationBindingRef,
    });
    assert(candidatePublication.status === "published", `${name}: publication failed`);
    assert(await authority.installInitialClosure({
      recordRef: candidateId,
      closureGeneration: 1,
      terminalAuthorityLeafHandles,
    }) === "installed", `${name}: authority closure failed`);
    assert(await authority.applyProjectionCas({
      recordRef: candidateId,
      expectedProjectionGeneration: 1,
      sourceChangeGeneration: 2,
      terminalAuthorityLeafHandles,
      audienceSetCommitment: randomBytes(32),
      alternatives: [{
        accessNamespaceId,
        includesPublicBoundary: true,
        alternativeCommitment: randomBytes(32),
      }],
    }) === "applied", `${name}: authority projection failed`);
    assert(await searchProjection.publish({
      recordRef: candidateId,
      recordProcessingGeneration: 1,
      projectionVersion: 1,
      projectionGeneration: 1,
      embedding: {
        provenance: {
          provider: embeddingProvider,
          canonicalModel: embeddingModel,
          dimensions: 1_536,
          contractVersion: 1,
        },
        vector: deterministicVector,
      },
    }) === "published", `${name}: search projection failed`);
    return candidateId;
  }

  const exactRoomLeafId = await publishOrganizerCandidate(
    "exact-room-leaf",
    "binding:integration",
  );
  const exactRoomCandidateId = await publishOrganizerCandidate(
    "exact-room",
    "binding:integration",
    [exactRoomLeafId],
    [`leaf:${exactRoomLeafId}`],
  );
  const otherRoomCandidateId = await publishOrganizerCandidate(
    "other-room",
    "binding:other-room",
  );
  const organizerStore = new PostgresSameRoomOrganizerStore(handle);
  for (const includesPublicBoundary of [false, true]) {
    const ranked = await organizerStore.rank({
      embedding: {
        provenance: {
          provider: integrationEmbeddingProvider,
          canonicalModel: "deterministic-v1",
          dimensions: 1_536,
          contractVersion: 1,
        },
        vector: deterministicVector,
      },
      invocationAudience: { humanRefs: [humanActorId], includesPublicBoundary },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      publicationBindingRef: "binding:integration",
      changedRecordRef: exactRoomLeafId,
      intent: "attachment",
      limit: 8,
    });
    assert(ranked.status === "available", "exact-Room Organizer ranking was unavailable");
    const rankedRefs = new Set(ranked.coordinates.map((entry) => entry.recordRef));
    assert(rankedRefs.has(exactRoomCandidateId), "exact-Room candidate was not ranked");
    assert(!rankedRefs.has(otherRoomCandidateId), "other-Room candidate reached ranking");
    const topology = await organizerStore.topology({
      invocationAudience: { humanRefs: [humanActorId], includesPublicBoundary },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      publicationBindingRef: "binding:integration",
      changedRecordRef: exactRoomLeafId,
      intent: "attachment",
      rankedCoordinates: ranked.coordinates.filter(
        (entry) => entry.recordRef === exactRoomCandidateId,
      ),
    });
    assert(topology.status === "available", "exact-Room Organizer topology was unavailable");
    if (topology.status !== "available") {
      throw new Error("exact-Room Organizer topology was unavailable");
    }
    assert(
      topology.topology.changedAlreadyParented
        && topology.topology.normalizedRecordRefs.get(exactRoomLeafId)
          === exactRoomCandidateId,
      "same-Room changed Record was not normalized to its unique current parent",
    );
    assert(
      topology.topology.redundantRecordRefs.includes(exactRoomCandidateId),
      "changed Record ancestor/descendant candidate was not suppressed",
    );
    const selected = ranked.coordinates.find(
      (entry) => entry.recordRef === exactRoomCandidateId,
    );
    assert(selected !== undefined, "exact-Room generation coordinate is absent");
    assert((await organizerStore.fence({
      invocationAudience: { humanRefs: [humanActorId], includesPublicBoundary },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      publicationBindingRef: "binding:integration",
      coordinates: [selected],
    })).status === "current", "exact-Room Organizer final fence failed");
  }

  // A populated database may contain a pre-M288 multi-parent shape. Build one
  // with fully eligible/searchable test-owned parents and prove discovery
  // fails closed before any payload opening or model invocation.
  assert((await repository.transitionLifecycle({
    recordRef: exactRoomCandidateId,
    expectedProcessingGeneration: 1,
    from: "current",
    to: "stale",
  })).status === "transitioned", "Organizer legacy fixture did not become stale");
  const exactRoomLegacySibling = await publishOrganizerCandidate(
    "exact-room-legacy-sibling",
    "binding:integration",
  );
  await publishOrganizerCandidate(
    "exact-room-legacy-parent",
    "binding:integration",
    [exactRoomLeafId, exactRoomLegacySibling],
    [`leaf:${exactRoomLeafId}`, `leaf:${exactRoomLegacySibling}`],
  );
  await forceLegacyFixtureLifecycle(exactRoomCandidateId, "current");
  try {
    assert(await searchProjection.replace({
      expectedProjectionGeneration: 1,
      projection: {
        recordRef: exactRoomCandidateId,
        recordProcessingGeneration: 3,
        projectionVersion: 1,
        projectionGeneration: 2,
        embedding: {
          provenance: {
            provider: integrationEmbeddingProvider,
            canonicalModel: "deterministic-v1",
            dimensions: 1_536,
            contractVersion: 1,
          },
          vector: deterministicVector,
        },
      },
    }) === "replaced", "legacy Organizer projection refresh failed");
    const legacyOrganizerRank = await organizerStore.rank({
      embedding: {
        provenance: {
          provider: integrationEmbeddingProvider,
          canonicalModel: "deterministic-v1",
          dimensions: 1_536,
          contractVersion: 1,
        },
        vector: deterministicVector,
      },
      invocationAudience: { humanRefs: [humanActorId], includesPublicBoundary: true },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      publicationBindingRef: "binding:integration",
      changedRecordRef: exactRoomLeafId,
      intent: "attachment",
      limit: 16,
    });
    assert(legacyOrganizerRank.status === "available", "legacy Organizer rank failed");
    if (legacyOrganizerRank.status !== "available") {
      throw new Error("legacy Organizer rank failed");
    }
    assert(
      (await organizerStore.topology({
        invocationAudience: { humanRefs: [humanActorId], includesPublicBoundary: true },
        selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
        publicationBindingRef: "binding:integration",
        changedRecordRef: exactRoomLeafId,
        intent: "attachment",
        rankedCoordinates: legacyOrganizerRank.coordinates,
      })).status === "unavailable",
      "legacy multi-parent Organizer topology did not fail closed",
    );
  } finally {
    await forceLegacyFixtureLifecycle(exactRoomCandidateId, "stale");
  }

  type MappingShape = "valid" | "missing" | "duplicate" | "wrong-kind" | "malformed";
  async function createAccessMapping(shape: MappingShape): Promise<string> {
    const namespaceId = randomUUID();
    await handle.query(
      `INSERT INTO namespaces (id, scope, label) VALUES ($1, 'integration', $2)`,
      [namespaceId, `reflection-search-conformance:${namespaceId}`],
    );
    const roomCount = shape === "missing" ? 0 : shape === "duplicate" ? 2 : 1;
    for (let index = 0; index < roomCount; index += 1) {
      const roomId = randomUUID();
      const humanActorIds = shape === "malformed"
        ? `{${humanActorId},${humanActorId}}`
        : `{${humanActorId}}`;
      await handle.query(
        `INSERT INTO rooms (
           id, owner_id, type, label, graph_thread_id, namespace_id,
           human_actor_ids, kind
         ) VALUES ($1, $2, 'shared', $3, $4, $5, $6::uuid[], $7)`,
        [
          roomId,
          ownerId,
          `Reflection search conformance ${roomId}`,
          `reflection-search-conformance:${roomId}`,
          namespaceId,
          humanActorIds,
          shape === "wrong-kind" ? "private" : "access",
        ],
      );
    }
    return namespaceId;
  }

  const conformanceProvider = `integration-conformance-${randomUUID()}`;
  const conformanceModel = "deterministic-v1";
  type LogicalAlternative = Readonly<{
    humanRefs: readonly string[];
    includesPublicBoundary: boolean;
  }>;
  const conformanceFixtures: Array<Readonly<{
    recordRef: string;
    logicalAlternatives: readonly LogicalAlternative[] | null;
    stateEligible: boolean;
  }>> = [];
  async function publishConformanceFixture(input: Readonly<{
    name: string;
    accessNamespaces: readonly Readonly<{
      accessNamespaceId: string;
      includesPublicBoundary: boolean;
    }>[];
    logicalAlternatives: readonly LogicalAlternative[] | null;
    state?: "current" | "dirty" | "unavailable" | "blocked" | "purged";
  }>): Promise<void> {
    const fixtureRecordId = `integration:search:${input.name}:${randomUUID()}`;
    const fixtureRecord: DurableRecordEnvelope = {
      ...record,
      recordRef: fixtureRecordId,
      semantic: {
        ...record.semantic,
        observedContentFingerprint: `fixture:${fixtureRecordId}`,
        statement: `Search conformance ${input.name}`,
        terminalAuthorityLeafHandles: [`leaf:${fixtureRecordId}`],
      },
    };
    const fixturePublication = await repository.publish({
      record: fixtureRecord,
      idempotencyKey: `publication:${randomUUID()}`,
      publicationBindingRef: "binding:search-conformance",
    });
    assert(fixturePublication.status === "published", `${input.name}: Record publication failed`);
    const leaf = fixtureRecord.semantic.terminalAuthorityLeafHandles[0]!;
    assert(await authority.installInitialClosure({
      recordRef: fixtureRecordId,
      closureGeneration: 1,
      terminalAuthorityLeafHandles: [leaf],
    }) === "installed", `${input.name}: initial closure failed`);
    assert(await authority.applyProjectionCas({
      recordRef: fixtureRecordId,
      expectedProjectionGeneration: 1,
      sourceChangeGeneration: 2,
      terminalAuthorityLeafHandles: [leaf],
      audienceSetCommitment: randomBytes(32),
      alternatives: input.accessNamespaces.map((alternative) => ({
        ...alternative,
        alternativeCommitment: randomBytes(32),
      })),
      ...(input.state === "unavailable"
        ? { unavailableReason: "source_unavailable" as const }
        : {}),
    }) === "applied", `${input.name}: authority projection failed`);
    assert(await searchProjection.publish({
      recordRef: fixtureRecordId,
      recordProcessingGeneration: 1,
      projectionVersion: 1,
      projectionGeneration: 1,
      embedding: {
        provenance: {
          provider: conformanceProvider,
          canonicalModel: conformanceModel,
          dimensions: 1_536,
          contractVersion: 1,
        },
        vector: deterministicVector,
      },
    }) === "published", `${input.name}: search projection failed`);
    await handle.transaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO reflection_record_payload_representations (
           record_id, representation, representation_generation, payload_version,
           plaintext_payload_bytes, crypto_object_id
         ) VALUES ($1, 'protected', 1, 1, NULL, $2)`,
        [fixtureRecordId, `crypto:${randomUUID()}`],
      );
      await transaction.query(
        `INSERT INTO reflection_record_payload_representation_heads (
           record_id, representation, current_representation_generation
         ) VALUES ($1, 'protected', 1)`,
        [fixtureRecordId],
      );
    }, { isolationLevel: "serializable" });
    if (input.state === "dirty") {
      await handle.query(
        `UPDATE reflection_record_authority_projections
            SET processing_state = 'dirty', dirty_since = now(), updated_at = now()
          WHERE record_id = $1 AND current = true`,
        [fixtureRecordId],
      );
    } else if (input.state === "blocked" || input.state === "purged") {
      assert(await authority.block({
        blockRef: `record-block:${randomUUID()}`,
        recordRef: fixtureRecordId,
        disposition: input.state,
      }) === "applied", `${input.name}: authority block failed`);
    }
    conformanceFixtures.push({
      recordRef: fixtureRecordId,
      logicalAlternatives: input.logicalAlternatives,
      stateEligible: input.state !== "unavailable"
        && input.state !== "blocked"
        && input.state !== "purged",
    });
  }

  const validPrivateNamespace = await createAccessMapping("valid");
  const validPublicNamespace = await createAccessMapping("valid");
  const crossRoomMemoryNamespace = await createAccessMapping("valid");
  const publicMemoryRoomId = randomUUID();
  await handle.query(
    `INSERT INTO rooms (
       id, owner_id, type, label, graph_thread_id, namespace_id,
       human_actor_ids, kind
     ) VALUES ($1, $2, 'shared', $3, $4, $5, $6::uuid[], 'open')`,
    [
      publicMemoryRoomId,
      ownerId,
      `Reflection cross-Room public ${publicMemoryRoomId}`,
      `reflection-cross-room-public:${publicMemoryRoomId}`,
      crossRoomMemoryNamespace,
      `{${humanActorId}}`,
    ],
  );
  const crossRoomProvider = "openai";
  const crossRoomModel = `integration-cross-room-${randomUUID()}`;
  const changedCrossRoomBinding =
    `journal:namespace:${accessNamespaceId}:ordinary:v1`;
  const otherCrossRoomBinding =
    `journal:namespace:${validPrivateNamespace}:ordinary:v1`;
  const crossRoomChangedId = await publishOrganizerCandidate(
    "cross-room-changed",
    changedCrossRoomBinding,
    [],
    [],
    crossRoomProvider,
    crossRoomModel,
  );
  const sameBindingDecoyId = await publishOrganizerCandidate(
    "cross-room-same-binding-decoy",
    changedCrossRoomBinding,
    [],
    [],
    crossRoomProvider,
    crossRoomModel,
  );
  const crossBindingCandidateId = await publishOrganizerCandidate(
    "cross-room-other-binding",
    otherCrossRoomBinding,
    [],
    [],
    crossRoomProvider,
    crossRoomModel,
  );
  const crossBindingSiblingId = await publishOrganizerCandidate(
    "cross-room-other-binding-sibling",
    otherCrossRoomBinding,
    [],
    [],
    crossRoomProvider,
    crossRoomModel,
  );
  const crossBindingParentId = await publishOrganizerCandidate(
    "cross-room-other-binding-parent",
    otherCrossRoomBinding,
    [crossBindingCandidateId, crossBindingSiblingId],
    [`leaf:${crossBindingCandidateId}`, `leaf:${crossBindingSiblingId}`],
    crossRoomProvider,
    crossRoomModel,
  );
  const sameBindingCrossParentSeedId = await publishOrganizerCandidate(
    "same-binding-cross-parent-seed",
    changedCrossRoomBinding,
    [],
    [],
    crossRoomProvider,
    crossRoomModel,
  );
  const sameBindingCrossParentSiblingId = await publishOrganizerCandidate(
    "same-binding-cross-parent-sibling",
    otherCrossRoomBinding,
    [],
    [],
    crossRoomProvider,
    crossRoomModel,
  );
  const parentAcrossBindingId = await publishOrganizerCandidate(
    "parent-across-binding",
    otherCrossRoomBinding,
    [sameBindingCrossParentSeedId, sameBindingCrossParentSiblingId],
    [
      `leaf:${sameBindingCrossParentSeedId}`,
      `leaf:${sameBindingCrossParentSiblingId}`,
    ],
    crossRoomProvider,
    crossRoomModel,
  );
  const sameBindingRank = await organizerStore.rank({
    embedding: {
      provenance: {
        provider: crossRoomProvider,
        canonicalModel: crossRoomModel,
        dimensions: 1_536,
        contractVersion: 1,
      },
      vector: deterministicVector,
    },
    invocationAudience: { humanRefs: [humanActorId], includesPublicBoundary: true },
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    publicationBindingRef: changedCrossRoomBinding,
    changedRecordRef: crossRoomChangedId,
    intent: "attachment",
    limit: 16,
  });
  assert(sameBindingRank.status === "available", "cross-parent seed rank failed");
  if (sameBindingRank.status !== "available") {
    throw new Error("cross-parent seed rank failed");
  }
  const sameBindingSeedCoordinate = sameBindingRank.coordinates.find(
    (coordinate) => coordinate.recordRef === sameBindingCrossParentSeedId,
  );
  assert(sameBindingSeedCoordinate !== undefined, "cross-parent seed was not ranked");
  const crossParentTopology = await organizerStore.topology({
    invocationAudience: { humanRefs: [humanActorId], includesPublicBoundary: true },
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    publicationBindingRef: changedCrossRoomBinding,
    changedRecordRef: crossRoomChangedId,
    intent: "attachment",
    rankedCoordinates: [sameBindingSeedCoordinate],
  });
  assert(
    crossParentTopology.status === "available"
      && crossParentTopology.topology.authorityParentRecordRefs.includes(
        sameBindingCrossParentSeedId,
      ),
    "cross-binding parent poisoned same-binding topology",
  );
  const crossRoomMemoryId = randomUUID();
  await handle.query(
    `INSERT INTO memories (
       id, tier, type, content, content_revision, embedding,
       embedding_revision, embedding_provider, embedding_model,
       embedding_dimensions, embedding_contract_version
     ) VALUES (
       $1, 1, 'general', $2, 1, $3::vector(1536),
       1, $4, $5, 1536, 1
     )`,
    [
      crossRoomMemoryId,
      "Cross-Room integration Memory",
      `[${deterministicVector.join(",")}]`,
      crossRoomProvider,
      crossRoomModel,
    ],
  );
  await handle.query(
    `INSERT INTO memory_namespaces (memory_id, namespace_id)
     VALUES ($1, $2)`,
    [crossRoomMemoryId, crossRoomMemoryNamespace],
  );
  const crossRoomStore = new PostgresCrossRoomOrganizerStore(handle);
  const crossRoomDiscovery = await crossRoomStore.discover({
    embedding: {
      provenance: {
        provider: crossRoomProvider,
        canonicalModel: crossRoomModel,
        dimensions: 1_536,
        contractVersion: 1,
      },
      vector: deterministicVector,
    },
    invocationAudience: {
      humanRefs: [humanActorId],
      includesPublicBoundary: true,
    },
    selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
    changedRecordRef: crossRoomChangedId,
    changedPublicationBindingRef: changedCrossRoomBinding,
    authorityParentSeeds: [{
      recordRef: sameBindingCrossParentSeedId,
      score: sameBindingSeedCoordinate.score,
    }],
  });
  assert(
    crossRoomDiscovery.status === "available",
    `cross-Room discovery failed: ${crossRoomDiscovery.status === "unavailable"
      ? crossRoomDiscovery.reason
      : "unknown"}`,
  );
  if (crossRoomDiscovery.status !== "available") {
    throw new Error("cross-Room discovery was unavailable");
  }
  const crossRoomRecordRefs = new Set(crossRoomDiscovery.candidates.flatMap(
    (candidate) => candidate.kind === "record" ? [candidate.recordRef] : [],
  ));
  assert(
    crossRoomRecordRefs.has(crossBindingParentId),
    "cross-binding child Records were not normalized to their current parent",
  );
  assert(
    crossRoomRecordRefs.has(parentAcrossBindingId),
    "same-binding seed was not normalized to its cross-binding parent",
  );
  assert(
    crossRoomDiscovery.metrics.authorityParentsResolved === 1,
    "cross-binding parent resolution diagnostics were not recorded",
  );
  assert(
    !crossRoomRecordRefs.has(crossBindingCandidateId)
      && !crossRoomRecordRefs.has(crossBindingSiblingId),
    "cross-binding child escaped current-parent normalization",
  );
  assert(
    !crossRoomRecordRefs.has(sameBindingDecoyId),
    "same-binding Record escaped cross-Room exclusion",
  );
  assert(
    crossRoomDiscovery.candidates.some(
      (candidate) => candidate.kind === "memory"
        && candidate.memoryRef === crossRoomMemoryId,
    ),
    "cross-Room authored Memory was not selected",
  );
  assert(
    (await crossRoomStore.fence({
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      changed: crossRoomDiscovery.changed,
      candidates: crossRoomDiscovery.candidates,
    })).status === "current",
    "cross-Room exact generation fence failed",
  );
  const validPrivate = [{
    humanRefs: [humanActorId],
    includesPublicBoundary: false,
  }] as const;
  const validPublic = [{
    humanRefs: [humanActorId],
    includesPublicBoundary: true,
  }] as const;
  await publishConformanceFixture({
    name: "valid-private",
    accessNamespaces: [{ accessNamespaceId: validPrivateNamespace, includesPublicBoundary: false }],
    logicalAlternatives: validPrivate,
  });
  await publishConformanceFixture({
    name: "valid-public",
    accessNamespaces: [{ accessNamespaceId: validPublicNamespace, includesPublicBoundary: true }],
    logicalAlternatives: validPublic,
  });
  for (const state of ["dirty", "unavailable", "blocked", "purged"] as const) {
    const namespaceId = await createAccessMapping("valid");
    await publishConformanceFixture({
      name: state,
      accessNamespaces: [{ accessNamespaceId: namespaceId, includesPublicBoundary: true }],
      logicalAlternatives: validPublic,
      state,
    });
  }
  for (const shape of ["missing", "duplicate", "wrong-kind", "malformed"] as const) {
    const namespaceId = await createAccessMapping(shape);
    await publishConformanceFixture({
      name: shape,
      accessNamespaces: [{ accessNamespaceId: namespaceId, includesPublicBoundary: true }],
      logicalAlternatives: null,
    });
  }
  const mixedValidNamespace = await createAccessMapping("valid");
  const mixedMissingNamespace = await createAccessMapping("missing");
  await publishConformanceFixture({
    name: "valid-plus-missing",
    accessNamespaces: [
      { accessNamespaceId: mixedValidNamespace, includesPublicBoundary: true },
      { accessNamespaceId: mixedMissingNamespace, includesPublicBoundary: true },
    ],
    // `readExactSet` fails the whole pure M258 eligibility check here.
    logicalAlternatives: null,
  });
  const maximumNamespaces = [];
  for (let index = 0; index < 256; index += 1) {
    maximumNamespaces.push({
      accessNamespaceId: await createAccessMapping("valid"),
      includesPublicBoundary: true,
    });
  }
  await publishConformanceFixture({
    name: "maximum-alternatives",
    accessNamespaces: maximumNamespaces,
    logicalAlternatives: maximumNamespaces.map(() => ({
      humanRefs: [humanActorId],
      includesPublicBoundary: true,
    })),
  });

  const exactConformanceSearch = new PostgresAuthorityFilteredRecordSearchStore(handle);
  for (const includesPublicBoundary of [false, true]) {
    const invocationAudience = {
      humanRefs: [humanActorId],
      includesPublicBoundary,
    } as const;
    const expected = new Set(conformanceFixtures.filter((fixture) =>
      fixture.stateEligible
        && fixture.logicalAlternatives !== null
        && invocationAudienceIsEligible(invocationAudience, fixture.logicalAlternatives)
    ).map((fixture) => fixture.recordRef));
    for (const selectedRepresentation of ["ordinary", "protected"] as const) {
      const result = await exactConformanceSearch.search({
        embedding: {
          provenance: {
            provider: conformanceProvider,
            canonicalModel: conformanceModel,
            dimensions: 1_536,
            contractVersion: 1,
          },
          vector: deterministicVector,
        },
        invocationAudience,
        selection: { selectedRepresentation, migrationGeneration: 1 },
        limit: 64,
      });
      assert(result.status === "available", "authority conformance search was unavailable");
      const actual = new Set(result.coordinates.map((coordinate) => coordinate.recordRef));
      assert(
        actual.size === expected.size && [...actual].every((value) => expected.has(value)),
        `${selectedRepresentation}/${includesPublicBoundary ? "public" : "private"}: SQL eligibility diverged from pure M258 eligibility`,
      );
    }
  }

  await assertSearchProjectionSecurity(handle);
  await handle.transaction(async (transaction) => {
    await transaction.query("SET LOCAL enable_seqscan = off");
    const planRows = await transaction.query(
      `EXPLAIN (COSTS OFF)
       SELECT record_id
         FROM reflection_record_search_projections
        WHERE projection_version = 1
          AND embedding_contract_version = 1
          AND embedding_provider = 'integration'
          AND embedding_canonical_model = 'deterministic-v1'
          AND embedding_dimensions = 1536
        ORDER BY record_id`,
    );
    const plan = planRows.map((row) => row["QUERY PLAN"]).join("\n");
    assert(plan.includes("idx_reflection_record_search_projections_provenance"), "search provenance query missed its B-tree index");
  }, { isolationLevel: "read committed" });

  const change = {
    changeRef: `change:${randomUUID()}`,
    terminalAuthorityLeafHandle: terminalLeafHandle,
    sourceChangeGeneration: 3,
  };
  const admitted = await authority.admitSourceChange(change);
  assert(admitted.dirtyRecordCount === 1 && !admitted.replayed, "authority change admission failed");
  const replayedChange = await authority.admitSourceChange(change);
  assert(replayedChange.replayed, "authority change replay failed");
  const [claimed] = await authority.claimDueReconciliations(1);
  assert(claimed?.attemptCount === 1, "authority reconciliation lease failed");
  assert(await authority.deferReconciliation({
    recordRef: recordId,
    sourceChangeGeneration: 3,
    leaseToken: claimed.leaseToken,
    sealedCheckpoint: randomBytes(32),
    failureCode: "storage_transient",
    nextAttemptAt: new Date(0),
    terminal: false,
  }) === "deferred", "authority reconciliation defer failed");
  const [reclaimed] = await authority.claimDueReconciliations(1);
  assert(reclaimed?.attemptCount === 2, "authority reconciliation restart failed");
  assert(await authority.deferReconciliation({
    recordRef: recordId,
    sourceChangeGeneration: 3,
    leaseToken: reclaimed.leaseToken,
    failureCode: "mapping_conflict",
    nextAttemptAt: new Date(0),
    terminal: true,
  }) === "quarantined", "authority reconciliation quarantine failed");

  await assertAuthoritySecurity(handle);
  await assertAuthorityQueryPlans(handle, { recordId, terminalLeafHandle, accessNamespaceId });
  const health = await authority.readContentFreeHealth("ordinary");
  assert(health.dirtyCount >= 1 && health.maximumAttemptCount >= 2, "authority health is incomplete");

  const cascadeChangedRecordIds = [recordId, ...cascadeRecordIds.slice(0, 2)];
  for (const [offset, changedRecordId] of cascadeChangedRecordIds.entries()) {
    const transition = await semanticRepository.transitionLifecycle({
      recordRef: changedRecordId,
      expectedProcessingGeneration: 1,
      from: "current",
      to: "sunset",
    });
    assert(transition.status === "transitioned", "cascade fixture transition failed");
    const expectedParentRecordId = cascadeRecordIds[offset]!;
    const changeCommitment = semanticCommitments.recordChange({
      recordRef: changedRecordId,
      changeRef: "lifecycle:current:sunset:v2",
    });
    let parentAdmissionFound = false;
    for (let drainAttempt = 0; drainAttempt < 64; drainAttempt += 1) {
      const parentAdmission = await handle.query(
        `SELECT assigned_generation
           FROM reflection_record_semantic_work_admissions
          WHERE record_id = $1 AND admission_commitment = $2`,
        [expectedParentRecordId, changeCommitment],
      );
      if (parentAdmission.length === 1) {
        parentAdmissionFound = true;
        break;
      }
      const repaired = await semanticWork.repairRecordDependentsPage({ limit: 1 });
      assert(repaired.consumed === 1, "Record dependency repair queue ended before the fixture");
    }
    assert(
      parentAdmissionFound,
      "Record dependency cascade did not reach the expected next hop",
    );
  }
  const pendingFixtureRepairs = await handle.query(
    `SELECT changed_record_id
       FROM reflection_record_dependency_change_repairs
      WHERE changed_record_id = ANY($1::text[]) AND completed_at IS NULL`,
    [cascadeChangedRecordIds],
  );
  assert(
    pendingFixtureRepairs.length === 0,
    "completed fixture Record dependency repairs replayed",
  );

  assert(await authority.block({
    blockRef: `leaf-block:${randomUUID()}`,
    terminalAuthorityLeafHandle: terminalLeafHandle,
    disposition: "purged",
  }) === "applied", "authority leaf block failed");
  assert(await authority.isImmediatelyBlocked({
    recordRef: recordId,
    terminalAuthorityLeafHandles: [terminalLeafHandle],
  }) === "purged", "authority leaf block was not immediate");

  const blocked = await repository.block({ recordRef: recordId });
  if (blocked.status !== "blocked") throw new Error("ordinary Record block failed");
  const blockedRead = await repository.read({ recordRef: recordId, readBindingRef: "read:integration" });
  if (blockedRead.status !== "unavailable" || blockedRead.reason !== "blocked") {
    throw new Error("blocked Record remained readable");
  }
  const healthBeforeBlockedEnqueue = await semanticWork.health();
  await semanticWork.enqueue({
    logicalObjectRef: recordId,
    generation: 2,
    recordRef: recordId,
    changeReason: "revised",
  });
  const healthBeforePurge = await semanticWork.health();
  assert(
    healthBeforePurge.backlog === healthBeforeBlockedEnqueue.backlog,
    "blocked Record work entered the actionable semantic backlog",
  );
  const purged = await repository.purge({ recordRef: recordId });
  if (purged.status !== "purged") throw new Error("ordinary Record purge failed");
  const healthAfterPurge = await semanticWork.health();
  assert(
    healthAfterPurge.backlog === healthBeforePurge.backlog,
    "purged Record work remained in the actionable semantic backlog",
  );
  const remainingProjection = await handle.query(
    `SELECT 1 AS found FROM reflection_record_search_projections WHERE record_id = $1`,
    [recordId],
  );
  assert(remainingProjection.length === 0, "purge left an orphaned search projection");
  await settleSyntheticIntegrationReceipts(handle);
  await settleSyntheticSemanticWork(handle);
  await retireSyntheticIntegrationRecords(handle);
  process.stdout.write("reflection-bridge postgres integration preflight: PASS\n");
} finally {
  await client.end({ timeout: 5 });
}
