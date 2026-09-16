import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";

import {
  conversationSharedAgentShadowExecutions,
  createDirectDb,
  createPostgresJsBridgeConnection,
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  LatticeCrypto,
  humanAiReadableLiveShadowExecutionInputSetDigest,
} from "@nautilo/lattice-crypto";

import { PostgresSharedAgentLiveShadowPlanner } from
  "../../src/server/message/postgres-shared-agent-live-shadow-plan.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  verifyConversationProductPostgresHandle,
} from "../../src/server/message/postgres-conversation-product-store.ts";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

type Fixture = Readonly<{
  userId: string;
  agentId: string;
  humanActorId: string;
  agentActorId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
  operationId: string;
  invocationId: string;
  executionId: string;
  deviceId: string;
  clientActionSessionId: string;
  policyRevision: number;
}>;

const adminUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const crypto = new LatticeCrypto();
const fixtures: Fixture[] = [];
let admin: SqlClient;
let product: SqlClient;
let productionProduct: ReturnType<typeof createDirectDb>;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

function sqlClient(url: string): SqlClient {
  return postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
}

function detachRows<Row extends PostgresJsBridgeRow>(
  rows: readonly Record<string, unknown>[],
): readonly Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(
    ([name, value]) => [
      name,
      value instanceof Uint8Array ? value.slice() : value,
    ],
  )) as Row);
}

function executor(client: SqlExecutor): PostgresJsBridgeExecutor {
  return Object.freeze({
    query: async <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
      statement: string,
      parameters: readonly PostgresJsBridgeScalar[] = [],
    ): Promise<readonly Row[]> => detachRows<Row>(await client.unsafe(
      statement,
      parameters.map((value) => value instanceof Date
        ? value.toISOString()
        : value) as unknown as postgres.ParameterOrJSON<never>[],
    )),
  });
}

function connection(client: SqlClient): PostgresJsBridgeConnection {
  const transact = <Result>(
    callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
    options?: Readonly<{ isolationLevel: "serializable" | "read committed" }>,
  ): Promise<Result> => options === undefined
    ? client.begin((transaction) => callback(executor(transaction))) as
      unknown as Promise<Result>
    : client.begin(
      `isolation level ${options.isolationLevel}`,
      (transaction) => callback(executor(transaction)),
    ) as unknown as Promise<Result>;
  return Object.freeze({
    ...executor(client),
    transaction: transact,
    transactionOnce: transact,
  });
}

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function createFixture(options: Readonly<{
  mismatchedInputDigest?: boolean;
}> = {}): Promise<Fixture> {
  const fixture = Object.freeze({
    userId: randomUUID(),
    agentId: randomUUID(),
    humanActorId: randomUUID(),
    agentActorId: randomUUID(),
    namespaceId: randomUUID(),
    roomId: randomUUID(),
    sessionId: randomUUID(),
    operationId: `human-${randomUUID()}`,
    invocationId: `invocation-${randomUUID()}`,
    executionId: `resume-${randomUUID()}`,
    deviceId: `device-${randomUUID()}`,
    clientActionSessionId: `action-${randomUUID()}`,
    policyRevision: 17,
  });
  fixtures.push(fixture);
  const now = new Date();
  const deadline = new Date(now.getTime() + 60_000);
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'Resume causal owner')`,
      [fixture.userId],
    );
    await transaction.unsafe(
      `INSERT INTO agents (id, handle) VALUES ($1, $2)`,
      [fixture.agentId, `resume-causal-${fixture.agentId}`],
    );
    await transaction.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind, agent_id
       ) VALUES
         ($1, $2, 'Resume causal Human', 'verified', 'user', NULL),
         ($3, $2, 'Resume causal Agent', 'verified', 'agent', $4)`,
      [
        fixture.humanActorId,
        fixture.userId,
        fixture.agentActorId,
        fixture.agentId,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO namespaces (id, scope, label)
       VALUES ($1, 'room', 'Resume causal Namespace')`,
      [fixture.namespaceId],
    );
    await transaction.unsafe(
      `INSERT INTO rooms (
         id, owner_id, type, label, graph_thread_id, namespace_id,
         human_actor_ids, kind, created_by
       ) VALUES (
         $1, $2, 'private', 'Resume causal Room', $3, $4,
         ARRAY[$5::uuid], 'private', $5
       )`,
      [
        fixture.roomId,
        fixture.userId,
        `resume-causal:${fixture.roomId}`,
        fixture.namespaceId,
        fixture.humanActorId,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO room_members (
         room_id, actor_id, room_role, agent_response_mode
       ) VALUES
         ($1, $2, 'admin', NULL),
         ($1, $3, 'member', 'active')`,
      [fixture.roomId, fixture.humanActorId, fixture.agentActorId],
    );
    await transaction.unsafe(
      `INSERT INTO sessions (
         id, thread_id, owner_id, persona_id, agent_id, room_id, channel
       ) VALUES ($1, $2, $3, 'owner', $4, $5, 'integration')`,
      [
        fixture.sessionId,
        `resume-causal:${fixture.sessionId}`,
        fixture.userId,
        fixture.agentId,
        fixture.roomId,
      ],
    );
    const [message] = await transaction.unsafe<{ id: number }[]>(
      `INSERT INTO session_messages (
         session_id, role, content, human_turn_id, transcript_origin,
         created_at, delivered_at
       ) VALUES ($1, 'user', 'Authenticated causal input', $2, 'main', $3, $3)
       RETURNING id`,
      [fixture.sessionId, fixture.operationId, now.toISOString()],
    );
    if (message === undefined) throw new Error("Causal Human message missing");
    const coordinates = Object.freeze([{
      operationId: fixture.operationId,
      messageId: Number(message.id),
      inputOrdinal: 1,
    }]);
    const inputSetDigest =
      humanAiReadableLiveShadowExecutionInputSetDigest(crypto, coordinates);
    const storedInputSetDigest = options.mismatchedInputDigest === true
      ? digest(0xff)
      : inputSetDigest;
    await transaction.unsafe(
      `INSERT INTO conversation_shared_agent_shadow_operations (
         operation_id, client_idempotency_key, policy_revision,
         session_id, room_id, agent_id, human_message_id,
         human_message_created_at, transcript_ordinal, subject_human_id,
         committer_device_id, committer_device_signing_key_generation,
         host_authorization_revision, namespace_id,
         namespace_access_revision, namespace_key_generation,
         namespace_head_digest, namespace_publication_digest,
         namespace_publication_set_digest, namespace_audience_fingerprint,
         participant_human_count, protected_participant_human_count,
         plaintext_participant_human_count, protected_recipient_device_count,
         crypto_object_id, attempt_coordinate, plan_digest, plan_bytes,
         human_request_digest, human_request_bytes,
         protected_message_digest, final_event_digest,
         state, conductor_state, conductor_reason, conductor_resolved_at,
         deadline_at, human_verified_at, terminal_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, 1, $9, $10, 1, 1, $11, 0, 0,
         $12, $13, $14, $15, 1, 1, 0, 1,
         $16, $17, $18, decode('01', 'hex'),
         $19, decode('02', 'hex'), $20, $21,
         'published', 'selected', 'selected_for_execution', $8,
         $22, $8, $8, $8, $8
       )`,
      [
        fixture.operationId,
        `request-${randomUUID()}`,
        fixture.policyRevision,
        fixture.sessionId,
        fixture.roomId,
        null,
        message.id,
        now.toISOString(),
        fixture.humanActorId,
        fixture.deviceId,
        fixture.namespaceId,
        digest(0x11),
        digest(0x12),
        digest(0x13),
        digest(0x14),
        `human-object-${randomUUID()}`,
        `attempt-${randomUUID()}`,
        digest(0x15),
        digest(0x16),
        digest(0x17),
        digest(0x18),
        deadline.toISOString(),
      ],
    );
    await transaction.unsafe(
      `INSERT INTO conversation_shared_agent_shadow_invocations (
         invocation_id, policy_revision, session_id, room_id,
         invoking_human_id, invoking_device_id, authorization_device_id,
         client_action_session_id, input_count, input_set_digest,
         authorization_disposition, authorization_digest,
         authorization_session_reference, state, deadline_at,
         authorized_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $6, $7, 1, $8,
         'establish', $9, $10, 'running', $11, $12, $12, $12
       )`,
      [
        fixture.invocationId,
        fixture.policyRevision,
        fixture.sessionId,
        fixture.roomId,
        fixture.humanActorId,
        fixture.deviceId,
        fixture.clientActionSessionId,
        storedInputSetDigest,
        digest(0x19),
        `authorization-${randomUUID()}`,
        deadline.toISOString(),
        now.toISOString(),
      ],
    );
    await transaction.unsafe(
      `INSERT INTO conversation_shared_agent_shadow_executions (
         execution_id, invocation_id, policy_revision, session_id, room_id,
         agent_id, invoking_human_id, invoking_device_id,
         authorization_device_id, client_action_session_id, execution_kind,
         input_count, input_set_digest, state, deadline_at,
         authorized_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $8, $9,
         'resume', 1, $10, 'running', $11, $12, $12, $12
       )`,
      [
        fixture.executionId,
        fixture.invocationId,
        fixture.policyRevision,
        fixture.sessionId,
        fixture.roomId,
        fixture.agentId,
        fixture.humanActorId,
        fixture.deviceId,
        fixture.clientActionSessionId,
        storedInputSetDigest,
        deadline.toISOString(),
        now.toISOString(),
      ],
    );
    await transaction.unsafe(
      `INSERT INTO conversation_shared_agent_shadow_execution_inputs (
         execution_id, input_ordinal, human_operation_id, message_id
       ) VALUES ($1, 1, $2, $3)`,
      [fixture.executionId, fixture.operationId, message.id],
    );
    inputSetDigest.fill(0);
  });
  return fixture;
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `DELETE FROM session_messages WHERE session_id = $1`,
      [fixture.sessionId],
    );
    await transaction.unsafe(
      `DELETE FROM sessions WHERE id = $1`,
      [fixture.sessionId],
    );
    await transaction.unsafe(`DELETE FROM rooms WHERE id = $1`, [fixture.roomId]);
    await transaction.unsafe(
      `DELETE FROM namespaces WHERE id = $1`,
      [fixture.namespaceId],
    );
    await transaction.unsafe(
      `DELETE FROM actors WHERE id IN ($1, $2)`,
      [fixture.humanActorId, fixture.agentActorId],
    );
    await transaction.unsafe(`DELETE FROM agents WHERE id = $1`, [fixture.agentId]);
    await transaction.unsafe(`DELETE FROM users WHERE id = $1`, [fixture.userId]);
  });
}

beforeAll(() => {
  bootstrapTestDbInstance();
  admin = sqlClient(adminUrl);
  product = sqlClient(appUrl);
  const previous = process.env["DB_DIRECT_CONNECTION"];
  process.env["DB_DIRECT_CONNECTION"] = appUrl;
  try {
    productionProduct = createDirectDb(1);
  } finally {
    if (previous === undefined) delete process.env["DB_DIRECT_CONNECTION"];
    else process.env["DB_DIRECT_CONNECTION"] = previous;
  }
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await cleanupFixture(fixture);
});

afterAll(async () => {
  await productionProduct.end();
  await product.end();
  await admin.end();
});

describe("Postgres shared resume causal Human turn", () => {
  test("loads only the exact running resume input lineage and fails closed", async () => {
    const fixture = await createFixture();
    const planner = new PostgresSharedAgentLiveShadowPlanner(
      connection(product),
      connection(product),
      crypto,
      null,
      { serverId: `resume-causal-${randomUUID()}` },
    );
    const request = Object.freeze({
      executionId: fixture.executionId,
      sessionId: fixture.sessionId,
      roomId: fixture.roomId,
      agentId: fixture.agentId,
      subjectHumanId: fixture.humanActorId,
      subjectUserId: fixture.userId,
      policyRevision: fixture.policyRevision,
    });

    expect(await planner.loadResumeCausalHumanTurnId(request))
      .toBe(fixture.operationId);
    expect(await planner.loadResumeCausalHumanTurnId({
      ...request,
      sessionId: randomUUID(),
    })).toBeNull();
    expect(await planner.loadResumeCausalHumanTurnId({
      ...request,
      subjectHumanId: `human-${randomUUID()}`,
    })).toBeNull();
    expect(await planner.loadResumeCausalHumanTurnId({
      ...request,
      policyRevision: fixture.policyRevision + 1,
    })).toBeNull();

    const mismatched = await createFixture({ mismatchedInputDigest: true });
    expect(await planner.loadResumeCausalHumanTurnId({
      ...request,
      executionId: mismatched.executionId,
      sessionId: mismatched.sessionId,
      roomId: mismatched.roomId,
      agentId: mismatched.agentId,
      subjectHumanId: mismatched.humanActorId,
      subjectUserId: mismatched.userId,
      policyRevision: mismatched.policyRevision,
    })).toBeNull();
  });

  test("preserves PostgreSQL timestamp strings through the verified typed transport", async () => {
    const fixture = await createFixture();
    const handle = await verifyConversationProductPostgresHandle(
      createPostgresJsBridgeConnection(productionProduct),
    );
    const loadTimestamps = () => executeTypedConversationProductQuery(
      handle,
      conversationProductTypedDb.select({
        execution_created_at:
          sql`${conversationSharedAgentShadowExecutions.createdAt}`
            .as("execution_created_at"),
        execution_terminal_at:
          sql`${conversationSharedAgentShadowExecutions.terminalAt}`
            .as("execution_terminal_at"),
      }).from(conversationSharedAgentShadowExecutions).where(eq(
        conversationSharedAgentShadowExecutions.executionId,
        fixture.executionId,
      )).limit(2),
    );

    const [running] = await loadTimestamps();
    expect(typeof running?.["execution_created_at"]).toBe("string");
    expect(Number.isFinite(Date.parse(String(
      running?.["execution_created_at"],
    )))).toBeTrue();
    expect(running?.["execution_terminal_at"]).toBeNull();

    const terminalAt = new Date(Date.now() + 1_000);
    await admin.unsafe(
      `UPDATE conversation_shared_agent_shadow_executions
          SET state = 'completed', final_causal_event_digest = $2,
              terminal_at = $3, updated_at = $3
        WHERE execution_id = $1`,
      [fixture.executionId, digest(0x7a), terminalAt.toISOString()],
    );
    const [completed] = await loadTimestamps();
    expect(typeof completed?.["execution_created_at"]).toBe("string");
    expect(typeof completed?.["execution_terminal_at"]).toBe("string");
    const createdAtMillis = Date.parse(String(
      completed?.["execution_created_at"],
    ));
    const terminalAtMillis = Date.parse(String(
      completed?.["execution_terminal_at"],
    ));
    expect(Number.isFinite(createdAtMillis)).toBeTrue();
    expect(Number.isFinite(terminalAtMillis)).toBeTrue();
    expect(terminalAtMillis).toBeGreaterThanOrEqual(createdAtMillis);
  });
});
