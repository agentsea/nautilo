import { describe, expect, test } from "bun:test";
import {
  bindConversationProductCanonicalTransactionRunner,
  PostgresConversationProductStore,
  verifyConversationProductPostgresHandle,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresIsolationLevel,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import {
  deriveLiveShadowMessageCryptoObjectIdV1,
  deriveMessageCryptoObjectIdV2,
} from "@nautilo/lattice-bridge";
import { deriveHumanMessageEditCryptoObjectIdV1 } from "@nautilo/lattice-crypto/wire";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: Query[] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  transactionCount = 0;
  readonly #results: unknown[][];
  readonly #transactionErrors: Error[];

  constructor(results: unknown[][], transactionErrors: Error[] = []) {
    this.#results = [...results];
    this.#transactionErrors = [...transactionErrors];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    const result = this.#results.shift();
    if (result === undefined) {
      throw new Error(`Unexpected SQL: ${statement}`);
    }
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    this.transactionCount += 1;
    this.isolationLevels.push(options.isolationLevel);
    const error = this.#transactionErrors.shift();
    if (error !== undefined) return Promise.reject(error);
    return callback(this);
  }
}

class FailingCanonicalConnection
  implements ConversationProductCanonicalTransactionConnection
{
  transaction<Result>(
    _callback: (
      transaction: CanonicalTranscriptTx,
      executor: ConversationProductPostgresConnection,
    ) => Promise<Result>,
  ): Promise<Result> {
    return Promise.reject(new Error("Unexpected canonical transaction"));
  }
}

type CanonicalOperation = "execute" | "select" | "insert" | "update"
  | "delete";
type CanonicalStep = Readonly<{
  operation: CanonicalOperation;
  result: unknown;
}>;

class ScriptedCanonicalConnection
  implements ConversationProductCanonicalTransactionConnection
{
  readonly events: string[] = [];
  readonly insertedValues: unknown[] = [];
  readonly updatedValues: unknown[] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #steps: CanonicalStep[];

  constructor(
    steps: readonly CanonicalStep[],
    private readonly role: "nautilo" | "nautilo_agent",
    private readonly policyMode: "plaintext_only" | "shadow_encryption" | "encrypted_only" = "shadow_encryption",
  ) {
    this.#steps = [...steps];
  }

  transaction<Result>(
    callback: (
      transaction: CanonicalTranscriptTx,
      executor: ConversationProductPostgresConnection,
    ) => Promise<Result>,
    options: Readonly<{isolationLevel: ConversationProductPostgresIsolationLevel}>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    let identityPending = true;
    let publicationPolicyReadPending = false;
    const take = (operation: CanonicalOperation): unknown => {
      const step = this.#steps.shift();
      expect(step?.operation).toBe(operation);
      this.events.push(operation);
      return step?.result;
    };
    const chain = (result: unknown): unknown => {
      const insertedValues = this.insertedValues;
      const updatedValues = this.updatedValues;
      const query = {
        from(): unknown {
          return query;
        },
        innerJoin(): unknown {
          return query;
        },
        leftJoin(): unknown {
          return query;
        },
        where(): unknown {
          return query;
        },
        orderBy(): unknown {
          return query;
        },
        for(): unknown {
          return query;
        },
        values(value: unknown): unknown {
          insertedValues.push(value);
          return query;
        },
        set(value: unknown): unknown {
          updatedValues.push(value);
          return query;
        },
        onConflictDoNothing(): unknown {
          return query;
        },
        onConflictDoUpdate(): unknown {
          return query;
        },
        limit(): unknown {
          return query;
        },
        returning(): Promise<unknown> {
          return Promise.resolve(result);
        },
        then(
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ): Promise<unknown> {
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    };
    const transaction = {
      execute: (): Promise<unknown> => {
        if (identityPending) {
          identityPending = false;
          return Promise.resolve([{
            current_user: this.role,
            session_user: this.role,
          }]);
        }
        // Canonical transcript mutations acquire the shared publication fence
        // before their pre-existing scripted Room work. Keep this structural
        // policy read out of each behavior-specific step list.
        if (this.#steps[0]?.operation !== "execute") {
          publicationPolicyReadPending = true;
          return Promise.resolve([]);
        }
        return Promise.resolve(take("execute"));
      },
      select: (): unknown => {
        if (publicationPolicyReadPending) {
          publicationPolicyReadPending = false;
          return chain([{ mode: this.policyMode, revision: 1 }]);
        }
        return chain(take("select"));
      },
      insert: (): unknown => chain(take("insert")),
      update: (): unknown => chain(take("update")),
      delete: (): unknown => chain(take("delete")),
    } as unknown as CanonicalTranscriptTx;
    const executor = new ScriptedConnection([[{current_user: this.role, session_user: this.role}]]);
    return callback(transaction, executor);
  }

  assertExhausted(): void {
    expect(this.#steps).toEqual([]);
  }
}

const roleRow = {
  current_user: "nautilo_agent",
  session_user: "nautilo_agent",
};
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID_2 = "10000000-0000-4000-8000-000000000011";
const ROOM_ID = "10000000-0000-4000-8000-000000000002";
const PARENT_ROOM_ID = "10000000-0000-4000-8000-000000000000";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000003";
const AGENT_ID = "10000000-0000-4000-8000-000000000013";
const OTHER_AGENT_ID = "10000000-0000-4000-8000-000000000015";
const HUMAN_ACTOR_ID = "10000000-0000-4000-8000-000000000014";
const LEASE_ID = "10000000-0000-4000-8000-000000000004";
const OTHER_LEASE_ID = "10000000-0000-4000-8000-000000000005";
const NOW = "2027-01-15T08:00:00.000Z";
const LEASE_EXPIRES = "2027-01-15T08:01:00.000Z";
const allocationRoomResults = (
  parentRoomId: string | null = null,
): unknown[][] => [
  [{id: ROOM_ID, parent_room_id: parentRoomId}],
  ...[...new Set([ROOM_ID, parentRoomId ?? ROOM_ID])].sort()
    .map(id => [{id}]),
];
const canonicalAppendFacts = {
  toolCalls: null,
  toolName: null,
  fingerprint: null,
  humanTurnId: null,
  transcriptOrigin: "main" as const,
  parentThreadId: null,
  scopeId: null,
  metadata: null,
  subthreadRoomId: null,
  replyToMessageId: null,
  notificationContext: {
    mentionedHumanUserIds: [],
    causalHumanUserId: null,
    causalHumanTurnId: null,
  },
  structuralProjection: {
    notificationEligibility: "eligible" as const,
    subthreadReplyClassification: "counted" as const,
  },
};

function digest(fill = 0x31): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function lifecycleRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence: 1,
    session_id: SESSION_ID,
    message_id: 11,
    edit_revision: 0,
    room_id: ROOM_ID,
    namespace_id_at_allocation: NAMESPACE_ID,
    crypto_object_id:
      "message:v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    object_id_scheme: "message_v2",
    representation_mode: "shadow_encryption",
    publication_policy_revision: null,
    shadow_operation_id: null,
    human_peer_shadow_operation_id: null,
    shared_agent_shadow_operation_id: null,
    shared_agent_shadow_execution_id: null,
    shadow_transcript_ordinal: null,
    shadow_reserved_created_at: null,
    shadow_stream_id: null,
    shadow_stream_start_digest: null,
    shadow_stream_terminal_digest: null,
    shadow_streamed_text_digest: null,
    shadow_durable_event_digest: null,
    payload_version: 2,
    key_class: "ai",
    author_role: "assistant",
    subthread_reply_classification: "counted",
    completion: "pending",
    disposition: "active",
    parity_status: "pending",
    attempt_count: 0,
    next_attempt_at: NOW,
    failure_code: null,
    lease_token: null,
    lease_expires_at: null,
    lease_is_live: true,
    append_idempotency_key: "append_1",
    allocation_request_digest: digest(),
    repair_identity_digest: null,
    repair_publisher_kind: null,
    repair_publisher_id: null,
    repair_publisher_human_id: null,
    repair_source_revision: null,
    repair_source_digest: null,
    repair_attestation_digest: null,
    terminal_operation_id: null,
    terminal_operation_group_id: null,
    terminal_operation_type: null,
    terminal_expected_revision: null,
    terminal_request_digest: null,
    quarantine_lease_token: null,
    delete_was_unread: null,
    delete_orphaned_turn_id: null,
    delete_root_parent_room_id: null,
    delete_root_anchor_message_id: null,
    delete_root_reply_count: null,
    delete_root_last_reply_at: null,
    delete_root_summary_revision: null,
    ...overrides,
  };
}

function messageJoinRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...lifecycleRow(),
    current_message_id: 11,
    current_message_session_id: SESSION_ID,
    current_message_role: "assistant",
    current_message_content: "hello",
    current_message_edit_revision: 0,
    current_message_crypto_object_id: null,
    ...overrides,
  };
}

async function storeWithResults(
  results: unknown[][],
  role: "nautilo" | "nautilo_agent" = "nautilo_agent",
  canonicalSteps: readonly CanonicalStep[] = [],
  policyMode: "plaintext_only" | "shadow_encryption" | "encrypted_only" = "shadow_encryption",
): Promise<{
  connection: ScriptedConnection;
  canonical: ScriptedCanonicalConnection;
  store: PostgresConversationProductStore;
}> {
  const connection = new ScriptedConnection([[
    { current_user: role, session_user: role },
  ], ...results]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  const canonical = new ScriptedCanonicalConnection(canonicalSteps, role, policyMode);
  const canonicalRunner =
    bindConversationProductCanonicalTransactionRunner(
      handle,
      canonical,
    );
  return {
    connection,
    canonical,
    store: new PostgresConversationProductStore(handle, canonicalRunner),
  };
}

function allSql(connection: ScriptedConnection): string {
  return connection.queries.map((query) => query.statement).join("\n");
}

test("publication authority uses serializable transactionOnce without nested ownership or escaped lifetime", async () => {
  const {store, canonical} = await storeWithResults([]);
  let escaped: (() => Promise<unknown>) | undefined;
  expect(await store.withAuthorizedExistingRepresentationPublication({
    sessionId: SESSION_ID, messageId: 11, revision: 0,
    publicationPolicy: {expectedRevision: 1, representation: "ordinary_and_protected"},
    prepareAuthority: async connection => {
      escaped = () => connection.transactionOnce(async () => true, {isolationLevel: "serializable"});
      expect(await escaped()).toBe(true);
      expect(canonical.events).toEqual([]);
      return null;
    },
    use: async () => {throw new Error("Absent authority cannot publish");},
    disposeAuthority: () => {throw new Error("No authority was acquired");},
  })).toBeNull();
  expect(canonical.isolationLevels).toEqual(["serializable"]);
  if (escaped === undefined) throw new Error("Missing scoped connection");
  expect((await rejectedError(escaped())).message).toContain("transaction is closed");
});

test("publication never automatically replays a failed serializable callback", async () => {
  const {store, canonical} = await storeWithResults([], "nautilo_agent", [
    {operation: "select", result: [{roomId: ROOM_ID, parentRoomId: null}]},
    {operation: "execute", result: []},
    {operation: "select", result: [{id: 11}]},
  ]);
  const conflict = Object.assign(new Error("serialization failure after immutable publication"), {code: "40001"});
  let calls = 0;
  let disposed = 0;
  expect(await rejectedError(store.withAuthorizedExistingRepresentationPublication({
    sessionId: SESSION_ID, messageId: 11, revision: 0,
    publicationPolicy: {expectedRevision: 1, representation: "ordinary_and_protected"},
    prepareAuthority: async connection => {
      expect(canonical.events).toEqual([]);
      return connection.transactionOnce(async () => true, {isolationLevel: "serializable"});
    },
    use: async () => {calls++; throw conflict;},
    disposeAuthority: () => {disposed++;},
  }))).toBe(conflict);
  expect(calls).toBe(1);
  expect(disposed).toBe(1);
  expect(canonical.isolationLevels).toEqual(["serializable"]);
  canonical.assertExhausted();
});

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected operation to reject");
}

describe("Postgres conversation product store", () => {
  test("accepts only directly authenticated ordinary roles", async () => {
    for (const role of ["nautilo", "nautilo_agent"]) {
      const connection = new ScriptedConnection([[
        { current_user: role, session_user: role },
      ]]);
      expect(
        await verifyConversationProductPostgresHandle(connection),
      ).toBeDefined();
    }

    for (const identity of [
      { current_user: "nautilo_crypto", session_user: "nautilo_crypto" },
      { current_user: "nautilo_agent", session_user: "nautilo" },
      { current_user: "nautilo", session_user: "postgres" },
    ]) {
      const connection = new ScriptedConnection([[identity]]);
      expect(
        (await rejectedError(
          verifyConversationProductPostgresHandle(connection),
        )).message,
      ).toMatch(/authenticate directly as nautilo or nautilo_agent/i);
    }

    const forged = new ScriptedConnection(
      [],
    ) as unknown as ConversationProductPostgresHandle;
    expect(() =>
      new PostgresConversationProductStore(
        forged,
        {} as ConversationProductCanonicalTransactionRunner,
      )
    ).toThrow(
      /verified ordinary product Postgres handle/i,
    );

    const raw = new ScriptedConnection([[roleRow]]);
    const handle = await verifyConversationProductPostgresHandle(raw);
    const otherRaw = new ScriptedConnection([[roleRow]]);
    const otherHandle = await verifyConversationProductPostgresHandle(otherRaw);
    const otherRunner = bindConversationProductCanonicalTransactionRunner(
      otherHandle,
      new ScriptedCanonicalConnection([], "nautilo_agent"),
    );
    expect(() => new PostgresConversationProductStore(handle, otherRunner))
      .toThrow(/exact verified product handle/i);
    const wrongRoleRunner =
      bindConversationProductCanonicalTransactionRunner(
        handle,
        new ScriptedCanonicalConnection([], "nautilo"),
      );
    const store = new PostgresConversationProductStore(
      handle,
      wrongRoleRunner,
    );
    expect(
      (await rejectedError(store.appendAllocated({
        ...canonicalAppendFacts,
        sessionId: SESSION_ID,
        idempotencyKey: "wrong-canonical-role",
        content: "must not mutate",
        keyClass: "ai",
        authorRole: "assistant",
        requestDigest: digest(),
      }))).message,
    ).toMatch(/canonical conversation transaction.*verified ordinary/i);
  });

  test("allocates lifecycle before the narrow shadow message and replays by Session-scoped digest", async () => {
    const row = lifecycleRow({
      subthread_reply_classification: "excluded",
    });
    const allocated = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{ valid: true }] },
      { operation: "select", result: [{ valid: true }] },
      { operation: "select", result: [] },
      { operation: "execute", result: [{ id: 11 }] },
      {
        operation: "select",
        result: [{ namespace_id: NAMESPACE_ID }],
      },
      { operation: "insert", result: [row] },
      { operation: "insert", result: [{ id: 11 }] },
      {
        operation: "select",
        result: [{
          role: "assistant",
          content: "hello",
          replyToMessageId: null,
          transcriptOrigin: "main",
          metadata: null,
          roomId: ROOM_ID,
          sessionOwnerId: "owner-1",
          roomKind: "private",
        }],
      },
      { operation: "select", result: [{ messageCount: 0 }] },
      { operation: "update", result: [] },
    ]);
    expect(await allocated.store.appendAllocated({
      ...canonicalAppendFacts,
      toolCalls: "[{\"name\":\"search\"}]",
      toolName: "search",
      fingerprint: "turn-fingerprint-1",
      humanTurnId: "human-turn-1",
      transcriptOrigin: "subagent",
      parentThreadId: "parent-thread-1",
      scopeId: "scope-1",
      metadata: { originatedBy: "task", confidential: true },
      subthreadRoomId: ROOM_ID,
      replyToMessageId: 7,
      structuralProjection: {
        notificationEligibility: "excluded",
        subthreadReplyClassification: "excluded",
      },
      sessionId: SESSION_ID,
      idempotencyKey: "append_1",
      content: "hello",
      keyClass: "ai",
      authorRole: "assistant",
      requestDigest: digest(),
    })).toMatchObject({
      status: "allocated",
      lifecycle: {
        messageId: 11,
        revision: 0,
        nextAttemptAt: new Date(NOW),
      },
    });
    expect(allocated.canonical.events).toEqual([
      "execute",
      "select",
      "select",
      "execute",
      "select",
      "select",
      "select",
      "execute",
      "select",
      "insert",
      "insert",
      "select",
      "select",
      "update",
    ]);
    allocated.canonical.assertExhausted();
    expect(allocated.canonical.insertedValues).toContainEqual(
      expect.objectContaining({
        id: 11,
        sessionId: SESSION_ID,
        toolCalls: "[{\"name\":\"search\"}]",
        toolName: "search",
        fingerprint: "turn-fingerprint-1",
        humanTurnId: "human-turn-1",
        transcriptOrigin: "subagent",
        parentThreadId: "parent-thread-1",
        scopeId: "scope-1",
        metadata: { originatedBy: "task", confidential: true },
        subthreadRoomId: ROOM_ID,
        replyToMessageId: 7,
      }),
    );

    const replayed = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [row] },
    ]);
    expect(await replayed.store.appendAllocated({
      ...canonicalAppendFacts,
      sessionId: SESSION_ID,
      idempotencyKey: "append_1",
      content: "hello",
      keyClass: "ai",
      authorRole: "assistant",
      requestDigest: digest(),
    })).toMatchObject({ status: "replayed" });
    expect(replayed.canonical.events).toEqual(["execute", "select"]);

    const conflict = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [row] },
    ]);
    expect(await conflict.store.appendAllocated({
      ...canonicalAppendFacts,
      sessionId: SESSION_ID,
      idempotencyKey: "append_1",
      content: "changed",
      keyClass: "ai",
      authorRole: "assistant",
      requestDigest: digest(0x32),
    })).toEqual({ status: "conflict" });
  });

  test("atomically appends the exact reserved Human live row and advances its turn receipt", async () => {
    const operationId = "20000000-0000-4000-8000-000000000001";
    const createdAt = Date.parse("2027-01-15T08:00:00.000Z");
    const cryptoObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
      operationId,
      sessionId: SESSION_ID,
      messageId: 917,
      revision: 0,
      transcriptOrdinal: 1,
      authorRole: "user",
    });
    const row = lifecycleRow({
      message_id: 917,
      crypto_object_id: cryptoObjectId,
      object_id_scheme: "live_shadow_v1",
      shadow_operation_id: operationId,
      shadow_transcript_ordinal: 1,
      shadow_reserved_created_at: new Date(createdAt),
      author_role: "user",
      subthread_reply_classification: "excluded",
      append_idempotency_key: operationId,
      allocation_request_digest: digest(0x41),
    });
    const setup = await storeWithResults([], "nautilo", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{ namespace_id: NAMESPACE_ID }] },
      {
        operation: "select",
        result: [{
          operation_id: operationId,
          state: "planned",
          session_id: SESSION_ID,
          room_id: ROOM_ID,
          human_message_id: 917,
          human_message_created_at: new Date(createdAt),
          namespace_id: NAMESPACE_ID,
          plan_digest: digest(0x43),
          plan_bytes: null,
          human_request_digest: null,
          human_request_bytes: null,
          grant_digest: null,
        }],
      },
      { operation: "insert", result: [row] },
      { operation: "update", result: [{ operationId }] },
      { operation: "insert", result: [{ id: 917 }] },
      {
        operation: "select",
        result: [{
          roomId: ROOM_ID,
          sessionOwnerId: "owner-1",
          roomKind: "private",
        }],
      },
      {
        operation: "select",
        result: [
          { actorId: HUMAN_ACTOR_ID, kind: "user", userId: "owner-1" },
          { actorId: AGENT_ID, kind: "agent", userId: null },
        ],
      },
      { operation: "insert", result: [] },
      { operation: "select", result: [{ messageCount: 8 }] },
      { operation: "update", result: [] },
    ]);

    const result = await setup.store.appendAllocated({
      ...canonicalAppendFacts,
      sessionId: SESSION_ID,
      idempotencyKey: operationId,
      content: "exact opened text",
      keyClass: "ai",
      authorRole: "user",
      humanTurnId: operationId,
      structuralProjection: {
        notificationEligibility: "eligible",
        subthreadReplyClassification: "excluded",
      },
      requestDigest: digest(0x41),
      liveShadow: {
        operationId,
        reservedMessageId: 917,
        createdAt,
        transcriptOrdinal: 1,
        cryptoObjectId,
        planDigest: digest(0x43),
        planBytes: new Uint8Array(262_145).fill(0x43),
        requestBytes: new Uint8Array(524_289).fill(0x41),
        grantDigest: digest(0x42),
      },
    });

    expect(result).toMatchObject({
      status: "allocated",
      lifecycle: {
        messageId: 917,
        authorRole: "user",
        objectIdScheme: "live_shadow_v1",
        shadowOperationId: operationId,
        shadowTranscriptOrdinal: 1,
      },
    });
    expect(setup.canonical.insertedValues).toContainEqual(
      expect.objectContaining({
        id: 917,
        sessionId: SESSION_ID,
        content: "exact opened text",
        humanTurnId: operationId,
        createdAt: new Date(createdAt),
      }),
    );
    setup.canonical.assertExhausted();
  });

  test("rechecks the exact append receipt after a collision-only lock on every replay", async () => {
    const row = lifecycleRow();
    const canonicalSteps: CanonicalStep[] = [];
    for (let replay = 0; replay < 100; replay += 1) {
      canonicalSteps.push(
        { operation: "execute", result: [] },
        { operation: "select", result: [row] },
      );
    }
    const setup = await storeWithResults(
      [],
      "nautilo_agent",
      canonicalSteps,
    );

    for (let replay = 0; replay < 100; replay += 1) {
      await setup.store.appendAllocated({
        ...canonicalAppendFacts,
        sessionId: SESSION_ID,
        idempotencyKey: "append_1",
        content: "hello",
        keyClass: "ai",
        authorRole: "assistant",
        requestDigest: digest(),
      });
    }

    expect(setup.canonical.events).toHaveLength(200);
    expect(setup.canonical.events.every((event, index) =>
      event === (index % 2 === 0 ? "execute" : "select")
    )).toBe(true);
    setup.canonical.assertExhausted();
  });

  test.each(["ai", "human"] as const)("allocates and exactly replays %s existing representations for every immutable author role", async (keyClass) => {
    for (const role of ["user", "assistant", "tool", "system"] as const) {
      const humanTurnId = role === "user" ? `turn-${role}` : null;
      const source = {
        message_id: 11,
        session_id: SESSION_ID,
        role,
        human_turn_id: humanTurnId,
        edit_revision: 0,
        crypto_object_id: null,
        subthread_room_id: null,
        room_id: ROOM_ID,
        agent_id: AGENT_ID,
        namespace_id: NAMESPACE_ID,
      };
      const receipt = lifecycleRow({
        crypto_object_id: deriveMessageCryptoObjectIdV2({
          sessionId: SESSION_ID,
          messageId: 11,
          revision: 0,
        }),
        author_role: role,
        key_class: keyClass,
        append_idempotency_key: `existing-representation-${role}`,
        repair_identity_digest: digest(0x42),
      });
      const allocated = await storeWithResults([
        ...allocationRoomResults(), [source], [], [receipt],
      ], "nautilo");
      expect(allocated.store.allocateExistingRepresentation({
        publisher: { kind: "human_device", humanActorId: HUMAN_ACTOR_ID },
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        operationId: `existing-representation-${role}`,
        expectedKeyClass: keyClass,
        expectedNamespaceId: NAMESPACE_ID,
        expectedAuthorRole: role,
        expectedAuthorHumanTurnId: humanTurnId,
        expectedSessionAgentId: AGENT_ID,
        requestDigest: digest(),
        repairIdentityDigest: digest(0x42),
      })).resolves.toMatchObject({
        status: "allocated",
        lifecycle: { authorRole: role, keyClass },
      });
      expect(allSql(allocated.connection)).not.toContain(
        "INSERT INTO session_messages",
      );
      expect(allSql(allocated.connection)).toContain(
        'inner join "room_members"',
      );
      expect(allSql(allocated.connection)).toContain(
        '"actors"."kind"',
      );
      expect(allSql(allocated.connection)).toContain(
        '"actors"."owner_id" = app_current_user_id()',
      );
      expect(allocated.connection.queries[3]?.parameters).toContain(
        HUMAN_ACTOR_ID,
      );
      expect(allocated.connection.isolationLevels).toEqual(["read committed"]);

      const replaySource = {
        ...source,
        crypto_object_id: receipt["crypto_object_id"],
      };
      const replayed = await storeWithResults([
        ...allocationRoomResults(), [replaySource], [receipt],
      ], "nautilo");
      expect(replayed.store.allocateExistingRepresentation({
        publisher: { kind: "human_device", humanActorId: HUMAN_ACTOR_ID },
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        operationId: `existing-representation-${role}`,
        expectedKeyClass: keyClass,
        expectedNamespaceId: NAMESPACE_ID,
        expectedAuthorRole: role,
        expectedAuthorHumanTurnId: humanTurnId,
        expectedSessionAgentId: AGENT_ID,
        requestDigest: digest(),
        repairIdentityDigest: digest(0x42),
      })).resolves.toMatchObject({ status: "replayed" });
      expect(allSql(replayed.connection)).not.toContain(
        "INSERT INTO session_message_crypto_revisions",
      );

      const resumedAfterAuthorityChange = await storeWithResults([
        ...allocationRoomResults(),
        [source],
        [receipt],
      ], "nautilo");
      expect(resumedAfterAuthorityChange.store.allocateExistingRepresentation({
        publisher: { kind: "human_device", humanActorId: HUMAN_ACTOR_ID },
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        operationId: `existing-representation-${role}-fresh-authority`,
        expectedKeyClass: keyClass,
        expectedNamespaceId: NAMESPACE_ID,
        expectedAuthorRole: role,
        expectedAuthorHumanTurnId: humanTurnId,
        expectedSessionAgentId: AGENT_ID,
        requestDigest: digest(),
        repairIdentityDigest: digest(0x43),
      })).resolves.toMatchObject({
        status: "replayed",
        lifecycle: { repairIdentityDigest: digest(0x42) },
      });
    }
  });

  test("uses Room-first existing-representation allocation for both Human and Runtime publishers", async () => {
    const source = {
      message_id: 11,
      session_id: SESSION_ID,
      role: "assistant",
      human_turn_id: null,
      edit_revision: 0,
      crypto_object_id: null,
      subthread_room_id: null,
      room_id: ROOM_ID,
      agent_id: AGENT_ID,
      namespace_id: NAMESPACE_ID,
    };
    for (const fixture of [
      {role: "nautilo" as const,
        publisher: {kind: "human_device" as const, humanActorId: HUMAN_ACTOR_ID}},
      {role: "nautilo_agent" as const,
        publisher: {kind: "foreground_runtime" as const, agentId: AGENT_ID}},
    ]) {
      const receipt = lifecycleRow({
        crypto_object_id: deriveMessageCryptoObjectIdV2({
          sessionId: SESSION_ID,
          messageId: 11,
          revision: 0,
        }),
        author_role: "assistant",
        append_idempotency_key: `room-first-${fixture.role}`,
        repair_identity_digest: digest(0x42),
      });
      const setup = await storeWithResults([
        ...allocationRoomResults(PARENT_ROOM_ID), [source], [], [receipt],
      ], fixture.role);
      expect(setup.store.allocateExistingRepresentation({
        publisher: fixture.publisher,
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        operationId: `room-first-${fixture.role}`,
        expectedNamespaceId: NAMESPACE_ID,
        expectedAuthorRole: "assistant",
        expectedAuthorHumanTurnId: null,
        expectedSessionAgentId: AGENT_ID,
        requestDigest: digest(),
        repairIdentityDigest: digest(0x42),
      })).resolves.toMatchObject({status: "allocated"});

      expect(setup.connection.isolationLevels).toEqual(["read committed"]);
      expect(setup.connection.queries.length).toBeGreaterThanOrEqual(7);
      expect(setup.connection.queries[1]?.statement).toContain('from "sessions"');
      expect(setup.connection.queries[1]?.statement).toContain('inner join "rooms"');
      for (const [index, roomId] of [PARENT_ROOM_ID, ROOM_ID].entries()) {
        const lock = setup.connection.queries[index + 2];
        expect(lock?.statement).toContain('from "rooms"');
        expect(lock?.statement.toLowerCase()).toContain("for update");
        expect(lock?.parameters).toContain(roomId);
      }
      expect(setup.connection.queries[4]?.statement).toContain('from "session_messages"');
      expect(setup.connection.queries[4]?.statement.toLowerCase()).toContain("for update");
    }
  });

  test("requires current Human membership in the exact Message Room", async () => {
    const setup = await storeWithResults([
      ...allocationRoomResults(), [],
    ], "nautilo");
    expect(setup.store.allocateExistingRepresentation({
      publisher: { kind: "human_device", humanActorId: HUMAN_ACTOR_ID },
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      operationId: "existing-representation-not-current-member",
      expectedNamespaceId: NAMESPACE_ID,
      expectedAuthorRole: "assistant",
      expectedAuthorHumanTurnId: null,
      expectedSessionAgentId: AGENT_ID,
      requestDigest: digest(),
      repairIdentityDigest: digest(0x42),
    })).resolves.toEqual({ status: "missing" });
    expect(allSql(setup.connection)).not.toContain(
      "INSERT INTO session_message_crypto_revisions",
    );
  });

  test("allocates another Agent Session's existing representation under a foreground Room member Agent", async () => {
    const source = {
      message_id: 11,
      session_id: SESSION_ID,
      role: "assistant",
      human_turn_id: null,
      edit_revision: 0,
      crypto_object_id: null,
      subthread_room_id: null,
      room_id: ROOM_ID,
      agent_id: OTHER_AGENT_ID,
      namespace_id: NAMESPACE_ID,
    };
    const receipt = lifecycleRow({
      crypto_object_id: deriveMessageCryptoObjectIdV2({
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
      }),
      author_role: "assistant",
      repair_identity_digest: digest(0x42),
    });
    const setup = await storeWithResults([
      ...allocationRoomResults(), [source], [], [receipt],
    ], "nautilo_agent");
    expect(await setup.store.allocateExistingRepresentation({
      publisher: { kind: "foreground_runtime", agentId: AGENT_ID },
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      operationId: "foreground-message-repair-11",
      expectedNamespaceId: NAMESPACE_ID,
      expectedAuthorRole: "assistant",
      expectedAuthorHumanTurnId: null,
      expectedSessionAgentId: OTHER_AGENT_ID,
      requestDigest: digest(),
      repairIdentityDigest: digest(0x42),
    })).toMatchObject({
      status: "allocated",
      lifecycle: {
        authorRole: "assistant",
        repairIdentityDigest: digest(0x42),
      },
    });
    expect(allSql(setup.connection)).toContain('app_agent_in_room("rooms"."id")');
    expect(allSql(setup.connection)).toContain(
      'app_current_agent_id() = $2::uuid',
    );
    expect(allSql(setup.connection)).not.toContain(
      '"sessions"."agent_id" = app_current_agent_id()',
    );
    expect(setup.connection.queries[3]?.parameters).toContain(AGENT_ID);
    expect(setup.connection.isolationLevels).toEqual(["read committed"]);
  });

  test("existing representation allocation rejects author, provenance, Namespace, and publisher-role substitution", async () => {
    const source = {
      message_id: 11,
      session_id: SESSION_ID,
      role: "assistant",
      human_turn_id: null,
      edit_revision: 0,
      crypto_object_id: null,
      subthread_room_id: null,
      room_id: ROOM_ID,
      agent_id: AGENT_ID,
      namespace_id: NAMESPACE_ID,
    };
    for (const changed of [
      { expectedAuthorRole: "tool" as const },
      { expectedSessionAgentId: SESSION_ID_2 },
      { expectedNamespaceId: ROOM_ID },
    ]) {
      const setup = await storeWithResults([
        ...allocationRoomResults(), [source],
      ], "nautilo");
      expect(setup.store.allocateExistingRepresentation({
        publisher: { kind: "human_device", humanActorId: HUMAN_ACTOR_ID },
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        operationId: "existing-representation-substitution",
        expectedNamespaceId: NAMESPACE_ID,
        expectedAuthorRole: "assistant",
        expectedAuthorHumanTurnId: null,
        expectedSessionAgentId: AGENT_ID,
        requestDigest: digest(),
        repairIdentityDigest: digest(0x42),
        ...changed,
      })).resolves.toEqual({ status: "stale" });
    }

    const inventedHumanTurn = await storeWithResults([], "nautilo");
    expect(inventedHumanTurn.store.allocateExistingRepresentation({
      publisher: { kind: "human_device", humanActorId: HUMAN_ACTOR_ID },
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      operationId: "existing-representation-human-turn-substitution",
      expectedNamespaceId: NAMESPACE_ID,
      expectedAuthorRole: "assistant",
      expectedAuthorHumanTurnId: "invented-turn",
      expectedSessionAgentId: AGENT_ID,
      requestDigest: digest(),
      repairIdentityDigest: digest(0x42),
    })).rejects.toThrow(/only a user Message/i);

    const agent = await storeWithResults([
      ...allocationRoomResults(), [],
    ], "nautilo_agent");
    expect(agent.store.allocateExistingRepresentation({
      publisher: { kind: "foreground_runtime", agentId: AGENT_ID },
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      operationId: "existing-representation-agent-role",
      expectedNamespaceId: NAMESPACE_ID,
      expectedAuthorRole: "assistant",
      expectedAuthorHumanTurnId: null,
      expectedSessionAgentId: AGENT_ID,
      requestDigest: digest(),
      repairIdentityDigest: digest(0x42),
    })).resolves.toEqual({ status: "missing" });
  });

  test("strictly hydrates one current revision and resolves Namespace only through Session to Room", async () => {
    const setup = await storeWithResults([
      [messageJoinRow()],
      [{ namespace_id: NAMESPACE_ID }],
    ]);
    expect(await setup.store.getRevision(11, 0)).toMatchObject({
      message: {
        messageId: 11,
        content: "hello",
        revision: 0,
        cryptoObjectId: null,
      },
      lifecycle: {
        messageId: 11,
        roomId: ROOM_ID,
        namespaceIdAtAllocation: NAMESPACE_ID,
      },
    });
    expect(await setup.store.resolveCurrentNamespace(SESSION_ID)).toBe(
      NAMESPACE_ID,
    );
    const sql = allSql(setup.connection).replaceAll('"', "").toLowerCase();
    expect(sql).toContain("left join session_messages");
    expect(sql).toContain(
      "session_messages.edit_revision = session_message_crypto_revisions.edit_revision",
    );
    expect(sql).toContain("inner join rooms");
    expect(sql).not.toContain("session_messages.namespace_id");
  });

  test("reads current revision mapping without projecting ordinary Message fields", async () => {
    const setup = await storeWithResults([[messageJoinRow({
      completion: "complete",
      disposition: "mapped",
      parity_status: "server_verified",
      next_attempt_at: null,
      crypto_object_id: "message:v2:protected-current",
      current_message_crypto_object_id: "message:v2:protected-current",
    })]]);

    expect(await setup.store.getRevisionMapping(SESSION_ID, 11, 0)).toMatchObject({
      lifecycle: {
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        disposition: "mapped",
        completion: "complete",
      },
      message: {
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        authorRole: "assistant",
        cryptoObjectId: "message:v2:protected-current",
      },
    });
    const selection = setup.connection.queries[1]!.statement.split(" from ")[0]!;
    expect(selection).not.toContain('"content"');
    expect(selection).not.toContain('"tool_calls"');
    expect(selection).not.toContain('"tool_name"');
    expect(setup.connection.queries[1]!.statement).not.toContain("limit");
  });

  test("rejects an impossible persisted delete reply count/timestamp pair", async () => {
    const setup = await storeWithResults([[
      messageJoinRow({
        disposition: "hard_delete",
        next_attempt_at: null,
        terminal_operation_id: "delete-incoherent-root",
        terminal_operation_type: "delete",
        terminal_expected_revision: 0,
        terminal_request_digest: digest(0x71),
        delete_was_unread: true,
        delete_root_parent_room_id: ROOM_ID,
        delete_root_anchor_message_id: 41,
        delete_root_reply_count: 1,
        delete_root_last_reply_at: null,
        delete_root_summary_revision: 3,
        current_message_id: null,
      }),
    ]]);

    expect(setup.store.getRevision(11, 0)).rejects.toThrow(
      /root summary timestamp is incoherent/i,
    );
  });

  test("marks completion idempotently and refuses a lost lease or parity rewrite", async () => {
    const objectId = String(lifecycleRow()["crypto_object_id"]);
    const applied = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [lifecycleRow({ lease_token: LEASE_ID, lease_expires_at: LEASE_EXPIRES })] },
      { operation: "update", result: [lifecycleRow({
        completion: "complete",
        parity_status: "server_verified",
        lease_token: LEASE_ID,
        lease_expires_at: LEASE_EXPIRES,
      })] },
    ]);
    expect(await applied.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_verified",
      leaseToken: LEASE_ID,
    })).toBe("applied");
    expect(applied.canonical.events).toEqual(["select", "update"]);

    const duplicate = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [lifecycleRow({
        completion: "complete",
        parity_status: "server_verified",
      })] },
    ]);
    expect(await duplicate.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_verified",
      leaseToken: null,
      publicationPolicy: { expectedRevision: 1, representation: "ordinary_and_protected" },
    })).toBe("duplicate");

    const lost = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [lifecycleRow({
        lease_token: OTHER_LEASE_ID,
        lease_expires_at: LEASE_EXPIRES,
      })] },
    ]);
    expect(await lost.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_verified",
      leaseToken: LEASE_ID,
    })).toBe("conflict");
  });

  test("fences prepared completion before its lifecycle lock and rejects stale policy", async () => {
    const objectId = String(lifecycleRow()["crypto_object_id"]);
    const exact = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [lifecycleRow({
        lease_token: LEASE_ID,
        lease_expires_at: LEASE_EXPIRES,
      })] },
      { operation: "update", result: [lifecycleRow({
        completion: "complete",
        parity_status: "server_verified",
      })] },
    ]);
    expect(await exact.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_verified",
      leaseToken: LEASE_ID,
      publicationPolicy: {
        expectedRevision: 1,
        representation: "ordinary_and_protected",
      },
    })).toBe("applied");
    expect(exact.canonical.events).toEqual(["select", "update"]);

    const stale = await storeWithResults([], "nautilo_agent");
    expect(stale.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_authenticated",
      leaseToken: null,
      publicationPolicy: {
        expectedRevision: 2,
        representation: "protected_only",
      },
    })).rejects.toThrow(/policy revision 2 is stale/i);
    expect(stale.canonical.events).toEqual([]);
  });

  test("requires exact foreground repair publication to verify Human-authored history", async () => {
    const objectId = String(lifecycleRow()["crypto_object_id"]);
    const pendingRepair = lifecycleRow({
      author_role: "user",
      repair_identity_digest: digest(0x42),
    });
    const missingEvidence = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [pendingRepair] },
    ]);
    expect(missingEvidence.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_verified",
      leaseToken: null,
    })).rejects.toThrow(/server-authenticated AI revisions/i);

    const attestationDigest = digest(0x55);
    const completedRepair = lifecycleRow({
      author_role: "user",
      repair_identity_digest: digest(0x42),
      repair_publisher_kind: "foreground_runtime",
      repair_publisher_id: "runtime-signer-1",
      repair_attestation_digest: attestationDigest,
      completion: "complete",
      parity_status: "server_verified",
    });
    const applied = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [pendingRepair] },
      { operation: "update", result: [completedRepair] },
    ]);
    expect(await applied.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_verified",
      leaseToken: null,
      repairPublication: {
        publisherKind: "foreground_runtime",
        publisherId: "runtime-signer-1",
        attestationDigest,
      },
      publicationPolicy: { expectedRevision: 1, representation: "ordinary_and_protected" },
    })).toBe("applied");

    const replay = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [completedRepair] },
    ]);
    expect(await replay.store.markCryptoComplete({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId: objectId,
      parityStatus: "server_verified",
      leaseToken: null,
      repairPublication: {
        publisherKind: "foreground_runtime",
        publisherId: "runtime-signer-1",
        attestationDigest,
      },
      publicationPolicy: { expectedRevision: 1, representation: "ordinary_and_protected" },
    })).toBe("duplicate");
  });

  test("publishes mapping with exact revision and current Namespace CAS, persisting every lost decision", async () => {
    const objectId = String(lifecycleRow()["crypto_object_id"]);
    const applied = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [{
        message_id: 11,
        session_id: SESSION_ID,
        edit_revision: 0,
        crypto_object_id: null,
      }] },
      { operation: "select", result: [lifecycleRow({
        completion: "complete",
        lease_token: LEASE_ID,
        lease_expires_at: LEASE_EXPIRES,
      })] },
      { operation: "select", result: [{ namespace_id: NAMESPACE_ID }] },
      { operation: "update", result: [{ message_id: 11 }] },
      { operation: "update", result: [lifecycleRow({
        completion: "complete",
        disposition: "mapped",
        next_attempt_at: null,
        lease_token: null,
        lease_expires_at: null,
      })] },
    ]);
    expect(await applied.store.compareAndSwapCryptoMapping({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      expectedNamespaceId: NAMESPACE_ID,
      cryptoObjectId: objectId,
      leaseToken: LEASE_ID,
    })).toBe("applied");
    expect(applied.canonical.events).toEqual([
      "select", "select", "select", "update", "update",
    ]);

    const wrongNamespace = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [{
        message_id: 11,
        session_id: SESSION_ID,
        edit_revision: 0,
        crypto_object_id: null,
      }] },
      { operation: "select", result: [lifecycleRow({
        completion: "complete",
        lease_token: LEASE_ID,
        lease_expires_at: LEASE_EXPIRES,
      })] },
      { operation: "select", result: [{ namespace_id: "10000000-0000-4000-8000-000000000099" }] },
      { operation: "update", result: [lifecycleRow({
        completion: "complete",
        disposition: "stale_mapping",
        failure_code: "mapping_conflict",
        next_attempt_at: null,
        lease_token: null,
        lease_expires_at: null,
      })] },
    ]);
    expect(await wrongNamespace.store.compareAndSwapCryptoMapping({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      expectedNamespaceId: NAMESPACE_ID,
      cryptoObjectId: objectId,
      leaseToken: LEASE_ID,
    })).toBe("wrong_namespace");
    expect(wrongNamespace.canonical.events).toEqual([
      "select", "select", "select", "update",
    ]);

    const lost = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [{
        message_id: 11,
        session_id: SESSION_ID,
        edit_revision: 0,
        crypto_object_id: null,
      }] },
      { operation: "select", result: [lifecycleRow({
        lease_token: OTHER_LEASE_ID,
        lease_expires_at: LEASE_EXPIRES,
      })] },
    ]);
    expect(await lost.store.compareAndSwapCryptoMapping({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      expectedNamespaceId: NAMESPACE_ID,
      cryptoObjectId: objectId,
      leaseToken: LEASE_ID,
    })).toBe("lease_lost");
  });

  test("edits atomically and replays the original global receipt after later mutations", async () => {
    const previous = lifecycleRow({
      completion: "complete",
      disposition: "mapped",
      next_attempt_at: null,
    });
    const next = lifecycleRow({
      sequence: 2,
      edit_revision: 1,
      crypto_object_id:
        "message:v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      append_idempotency_key: null,
      allocation_request_digest: digest(0x42),
      edit_group_size: 1,
    });
    const allocated = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          messageId: 11,
          sessionId: SESSION_ID,
          role: "assistant",
          fingerprint: null,
          editRevision: 0,
          ownerId: "owner-1",
          roomId: ROOM_ID,
        }],
      },
      { operation: "update", result: [{ messageId: 11 }] },
      { operation: "insert", result: [] },
      { operation: "select", result: [previous] },
      { operation: "update", result: [{ sequence: 1 }] },
      { operation: "insert", result: [next] },
    ]);
    expect(await allocated.store.editAllocated({
      messageId: 11,
      operationId: "operation_edit_1",
      expectedRevision: 0,
      content: "edited",
      subthreadReplyClassification: "counted",
      requestDigest: digest(0x42),
    })).toMatchObject({
      status: "allocated",
      lifecycles: [{ revision: 1, disposition: "active" }],
    });
    expect(allocated.canonical.events).toEqual([
      "execute",
      "select",
      "select",
      "execute",
      "select",
      "update",
      "insert",
      "select",
      "update",
      "insert",
    ]);
    allocated.canonical.assertExhausted();

    const terminalReceipt = lifecycleRow({
      disposition: "superseded",
      next_attempt_at: null,
      terminal_operation_id: "operation_edit_1",
      terminal_operation_group_id: "operation_edit_1",
      terminal_operation_type: "edit",
      terminal_expected_revision: 0,
      terminal_request_digest: digest(0x42),
    });
    const replayed = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [terminalReceipt] },
      { operation: "select", result: [next] },
    ]);
    expect(await replayed.store.editAllocated({
      messageId: 11,
      operationId: "operation_edit_1",
      expectedRevision: 0,
      content: "edited",
      subthreadReplyClassification: "counted",
      requestDigest: digest(0x42),
    })).toMatchObject({
      status: "replayed",
      lifecycles: [{ revision: 1 }],
    });
    expect(replayed.canonical.events).toEqual([
      "execute",
      "select",
      "select",
    ]);
  });

  test("publishes a Full Human edit as one authenticated protected revision", async () => {
    const operationId = "human-edit:v1:30000000-0000-4000-8000-000000000319";
    const objectId = deriveHumanMessageEditCryptoObjectIdV1({
      operationId,
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 1,
    });
    const previous = lifecycleRow({
      key_class: "human",
      author_role: "user",
      completion: "complete",
      disposition: "mapped",
      parity_status: "client_authenticated",
      representation_mode: "full_encryption",
      publication_policy_revision: 1,
      object_id_scheme: "live_shadow_v1",
      human_peer_shadow_operation_id: "human-peer-origin-edit-1",
      shadow_transcript_ordinal: 1,
      shadow_reserved_created_at: NOW,
      next_attempt_at: null,
    });
    const next = lifecycleRow({
      sequence: 2,
      edit_revision: 1,
      crypto_object_id: objectId,
      object_id_scheme: "human_message_edit_v1",
      key_class: "human",
      author_role: "user",
      completion: "complete",
      disposition: "mapped",
      parity_status: "client_authenticated",
      representation_mode: "full_encryption",
      publication_policy_revision: 1,
      human_peer_shadow_operation_id: "human-peer-origin-edit-1",
      append_idempotency_key: null,
      next_attempt_at: null,
    });
    const allocated = await storeWithResults([], "nautilo", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{
        messageId: 11,
        sessionId: SESSION_ID,
        role: "user",
        fingerprint: "logical-full-edit-1",
        editRevision: 0,
        ownerId: "owner-1",
        roomId: ROOM_ID,
      }] },
      { operation: "select", result: [{
        messageId: 11,
        sessionId: SESSION_ID,
        role: "user",
        editRevision: 0,
      }] },
      { operation: "select", result: [{
        namespace_id: NAMESPACE_ID,
        namespace_access_revision: 1,
        human_actor_ids: [HUMAN_ACTOR_ID],
      }] },
      { operation: "update", result: [{ messageId: 11 }] },
      { operation: "insert", result: [] },
      { operation: "select", result: [previous] },
      { operation: "update", result: [{ sequence: 1 }] },
      { operation: "insert", result: [next] },
    ], "encrypted_only");
    expect(allocated.store.publishProtectedEdit({
      messageId: 11,
      operationId: "human-edit:v1:30000000-0000-4000-8000-000000000320",
      expectedRevision: 0,
      requestDigest: digest(0x73),
      policyRevision: 1,
      lockCryptoAuthority: () => Promise.resolve(),
      targets: [{
        sessionId: SESSION_ID,
        messageId: 11,
        namespaceId: NAMESPACE_ID,
        cryptoObjectId: objectId,
        keyClass: "human",
        namespaceAccessRevision: 1,
        namespaceKeyGeneration: 1,
        namespaceAudienceFingerprint: digest(0x74),
      }],
    })).rejects.toThrow(/object coordinates disagree/i);
    expect(await allocated.store.publishProtectedEdit({
      messageId: 11,
      operationId,
      expectedRevision: 0,
      requestDigest: digest(0x73),
      policyRevision: 1,
      lockCryptoAuthority: () => Promise.resolve(),
      targets: [{
        sessionId: SESSION_ID,
        messageId: 11,
        namespaceId: NAMESPACE_ID,
        cryptoObjectId: objectId,
        keyClass: "human",
        namespaceAccessRevision: 1,
        namespaceKeyGeneration: 1,
        // This compatibility projection is a retained-authority digest in the
        // current planner, not the canonical Room audience fingerprint. Room
        // membership is fenced by the exact Namespace access revision.
        namespaceAudienceFingerprint: digest(0x74),
      }],
    })).toMatchObject({
      status: "allocated",
      committedProjection: {
        logicalMessageKey: "turn:logical-full-edit-1",
      },
      lifecycles: [{
        revision: 1,
        completion: "complete",
        disposition: "mapped",
        parityStatus: "client_authenticated",
        representationMode: "full_encryption",
        humanPeerShadowOperationId: "human-peer-origin-edit-1",
        shadowTranscriptOrdinal: null,
        shadowReservedCreatedAt: null,
      }],
    });
    allocated.canonical.assertExhausted();
  });

  test("allocates and exactly replays every physical Human-turn sibling", async () => {
    const previousOne = lifecycleRow({
      key_class: "human",
      author_role: "user",
    });
    const previousTwo = lifecycleRow({
      sequence: 2,
      session_id: SESSION_ID_2,
      message_id: 12,
      crypto_object_id:
        "message:v2:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      key_class: "human",
      author_role: "user",
    });
    const nextOne = lifecycleRow({
      sequence: 3,
      edit_revision: 1,
      crypto_object_id:
        "message:v2:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      key_class: "human",
      author_role: "user",
      append_idempotency_key: null,
      allocation_request_digest: digest(0x4a),
      edit_group_size: 2,
    });
    const nextTwo = lifecycleRow({
      sequence: 4,
      session_id: SESSION_ID_2,
      message_id: 12,
      edit_revision: 1,
      crypto_object_id:
        "message:v2:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      key_class: "human",
      author_role: "user",
      append_idempotency_key: null,
      allocation_request_digest: digest(0x4a),
      edit_group_size: 2,
    });
    const allocated = await storeWithResults([], "nautilo", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          messageId: 11,
          sessionId: SESSION_ID,
          role: "user",
          fingerprint: "logical-human-turn",
          editRevision: 0,
          ownerId: "owner-1",
          roomId: ROOM_ID,
        }],
      },
      {
        operation: "select",
        result: [
          {
            messageId: 12,
            sessionId: SESSION_ID_2,
            role: "user",
            editRevision: 0,
          },
          {
            messageId: 11,
            sessionId: SESSION_ID,
            role: "user",
            editRevision: 0,
          },
        ],
      },
      {
        operation: "update",
        result: [{ messageId: 11 }, { messageId: 12 }],
      },
      { operation: "insert", result: [] },
      { operation: "select", result: [previousOne, previousTwo] },
      { operation: "update", result: [{ sequence: 1 }] },
      { operation: "insert", result: [nextOne] },
      { operation: "update", result: [{ sequence: 2 }] },
      { operation: "insert", result: [nextTwo] },
    ]);
    const request = {
      messageId: 11,
      operationId: "operation-human-group-edit",
      expectedRevision: 0,
      content: "edited logical Human turn",
      subthreadReplyClassification: "counted" as const,
      requestDigest: digest(0x4a),
    };
    expect(await allocated.store.editAllocated(request)).toMatchObject({
      status: "allocated",
      lifecycles: [
        { messageId: 11, revision: 1 },
        { messageId: 12, revision: 1 },
      ],
    });
    allocated.canonical.assertExhausted();

    const receipt = lifecycleRow({
      key_class: "human",
      author_role: "user",
      disposition: "superseded",
      next_attempt_at: null,
      terminal_operation_id: request.operationId,
      terminal_operation_group_id: request.operationId,
      terminal_operation_type: "edit",
      terminal_expected_revision: 0,
      terminal_request_digest: request.requestDigest,
    });
    const replayed = await storeWithResults([], "nautilo", [
      { operation: "execute", result: [] },
      { operation: "select", result: [receipt] },
      { operation: "select", result: [nextOne, nextTwo] },
    ]);
    expect(await replayed.store.editAllocated(request)).toMatchObject({
      status: "replayed",
      lifecycles: [
        { messageId: 11, revision: 1 },
        { messageId: 12, revision: 1 },
      ],
    });
    replayed.canonical.assertExhausted();
  });

  test("hard delete preserves and replays its receipt after removing the product row", async () => {
    const current = lifecycleRow({
      completion: "complete",
      disposition: "mapped",
      next_attempt_at: null,
    });
    const deleted = lifecycleRow({
      completion: "complete",
      disposition: "hard_delete",
      next_attempt_at: null,
      terminal_operation_id: "operation_delete_1",
      terminal_operation_type: "delete",
      terminal_expected_revision: 0,
      terminal_request_digest: digest(0x52),
      delete_was_unread: true,
      delete_orphaned_turn_id: "turn-delete-1",
    });
    const currentMessage = {
        message_id: 11,
        session_id: SESSION_ID,
        room_id: ROOM_ID,
        edit_revision: 0,
        role: "assistant",
        content: "hello",
        read_at: null,
        fingerprint: "turn-delete-1",
        originated_by: null,
        subthread_room_id: null,
    };
    const setup = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ room_id: ROOM_ID }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [currentMessage] },
      { operation: "select", result: [] },
      { operation: "execute", result: [current] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          roomId: ROOM_ID,
          sessionId: SESSION_ID,
          editRevision: 0,
          readAt: null,
          fingerprint: "turn-delete-1",
          role: "assistant",
          content: "hello",
          metadata: null,
          subthreadRoomId: null,
        }],
      },
      { operation: "select", result: [] },
      { operation: "delete", result: [] },
      { operation: "update", result: [] },
      { operation: "select", result: [] },
      { operation: "update", result: [deleted] },
    ]);
    expect(await setup.store.hardDelete({
      messageId: 11,
      operationId: "operation_delete_1",
      expectedRevision: 0,
      requestDigest: digest(0x52),
    })).toMatchObject({
      status: "deleted",
      lifecycle: { disposition: "hard_delete" },
      effects: {
        roomId: ROOM_ID,
        wasUnread: true,
        orphanedTurnId: "turn-delete-1",
        rootSummary: null,
      },
    });
    expect(setup.canonical.events).toEqual([
      "execute",
      "select",
      "select",
      "execute",
      "select",
      "select",
      "execute",
      "select",
      "execute",
      "select",
      "select",
      "delete",
      "update",
      "select",
      "update",
    ]);
    setup.canonical.assertExhausted();

    const replay = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [deleted] },
    ]);
    expect(await replay.store.hardDelete({
      messageId: 11,
      operationId: "operation_delete_1",
      expectedRevision: 0,
      requestDigest: digest(0x52),
    })).toMatchObject({
      status: "replayed",
      effects: {
        roomId: ROOM_ID,
        wasUnread: true,
        orphanedTurnId: "turn-delete-1",
        rootSummary: null,
      },
    });
    expect(replay.canonical.events).toEqual(["execute", "select"]);
  });

  test("bounds agent authority to AI-authored mutation and server parity", async () => {
    const invalidProjection = await storeWithResults([]);
    expect(
      (await rejectedError(invalidProjection.store.appendAllocated({
        ...canonicalAppendFacts,
        structuralProjection: {
          notificationEligibility: "plaintext-derived" as never,
          subthreadReplyClassification: "counted",
        },
        sessionId: SESSION_ID,
        idempotencyKey: "invalid-structural-projection",
        content: "must not transact",
        keyClass: "ai",
        authorRole: "assistant",
        requestDigest: digest(),
      }))).message,
    ).toMatch(/notification eligibility is invalid/i);
    expect(invalidProjection.connection.transactionCount).toBe(0);

    const rejectedAppend = await storeWithResults([]);
    expect(
      (await rejectedError(rejectedAppend.store.appendAllocated({
        ...canonicalAppendFacts,
        sessionId: SESSION_ID,
        idempotencyKey: "human-agent-append",
        content: "human",
        keyClass: "human",
        authorRole: "user",
        requestDigest: digest(),
      }))).message,
    ).toMatch(/nautilo_agent.*AI-authored/i);
    expect(rejectedAppend.connection.transactionCount).toBe(0);

    const humanMessage = {
      message_id: 11,
      session_id: SESSION_ID,
      room_id: ROOM_ID,
      edit_revision: 0,
      role: "user",
      content: "human",
      read_at: null,
      fingerprint: "turn-human",
      originated_by: null,
      subthread_room_id: null,
      crypto_object_id: null,
    };
    const humanLifecycle = lifecycleRow({
      key_class: "human",
      author_role: "user",
    });
    const rejectedEdit = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      {
        operation: "select",
        result: [{
          messageId: 11,
          sessionId: SESSION_ID,
          role: "user",
          fingerprint: "turn-human",
          editRevision: 0,
          ownerId: "owner-1",
          roomId: ROOM_ID,
        }],
      },
      {
        operation: "select",
        result: [{
          messageId: 11,
          sessionId: SESSION_ID,
          role: "user",
          editRevision: 0,
        }],
      },
      { operation: "update", result: [{ messageId: 11 }] },
      { operation: "insert", result: [] },
      { operation: "select", result: [humanLifecycle] },
    ]);
    expect(
      (await rejectedError(rejectedEdit.store.editAllocated({
        messageId: 11,
        operationId: "agent-human-edit",
        expectedRevision: 0,
        content: "forbidden",
        subthreadReplyClassification: "counted",
        requestDigest: digest(),
      }))).message,
    ).toMatch(/nautilo_agent.*Human-(?:authored|authorized)/i);

    const rejectedDelete = await storeWithResults([], "nautilo_agent", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ room_id: ROOM_ID }] },
      { operation: "execute", result: [] },
      { operation: "select", result: [humanMessage] },
    ]);
    expect(
      (await rejectedError(rejectedDelete.store.hardDelete({
        messageId: 11,
        operationId: "agent-human-delete",
        expectedRevision: 0,
        requestDigest: digest(),
      }))).message,
    ).toMatch(/nautilo_agent.*Human-(?:authored|authorized)/i);

    const rejectedParity = await storeWithResults([]);
    expect(
      (await rejectedError(rejectedParity.store.markCryptoComplete({
        sessionId: SESSION_ID,
        messageId: 11,
        revision: 0,
        cryptoObjectId: String(lifecycleRow()["crypto_object_id"]),
        parityStatus: "client_verified",
        leaseToken: null,
      }))).message,
    ).toMatch(/nautilo_agent.*server-authenticated/i);
    expect(rejectedParity.connection.transactionCount).toBe(0);

    const appAppend = await storeWithResults([], "nautilo", [
      { operation: "execute", result: [] },
      { operation: "select", result: [] },
      { operation: "select", result: [{ roomId: ROOM_ID }] },
      { operation: "execute", result: [] },
      { operation: "execute", result: [{ id: 11 }] },
      {
        operation: "select",
        result: [{ namespace_id: NAMESPACE_ID }],
      },
      { operation: "insert", result: [humanLifecycle] },
      { operation: "insert", result: [{ id: 11 }] },
      {
        operation: "select",
        result: [{
          role: "user",
          content: "human",
          replyToMessageId: null,
          transcriptOrigin: "main",
          metadata: null,
          roomId: ROOM_ID,
          sessionOwnerId: "owner-1",
          roomKind: "private",
        }],
      },
      { operation: "select", result: [] },
      { operation: "insert", result: [] },
      { operation: "select", result: [{ messageCount: 0 }] },
      { operation: "update", result: [] },
    ]);
    expect(await appAppend.store.appendAllocated({
      ...canonicalAppendFacts,
      sessionId: SESSION_ID,
      idempotencyKey: "human-app-append",
      content: "human",
      keyClass: "human",
      authorRole: "user",
      requestDigest: digest(),
    })).toMatchObject({ status: "allocated" });
  });

  test("retries deadlocks and wraps both reads in caller-context transactions", async () => {
    const deadlock = Object.assign(new Error("deadlock"), { code: "40P01" });
    const wrappedDeadlock = new Error("Drizzle query failed", {
      cause: deadlock,
    });
    const connection = new ScriptedConnection(
      [[roleRow], [{ namespace_id: NAMESPACE_ID }]],
      [wrappedDeadlock],
    );
    const handle = await verifyConversationProductPostgresHandle(connection);
    const store = new PostgresConversationProductStore(
      handle,
      bindConversationProductCanonicalTransactionRunner(
        handle,
        new FailingCanonicalConnection(),
      ),
    );
    expect(await store.resolveCurrentNamespace(SESSION_ID)).toBe(NAMESPACE_ID);
    expect(connection.transactionCount).toBe(2);
    expect(connection.isolationLevels).toEqual([
      "read committed",
      "read committed",
    ]);

    const reads = await storeWithResults([
      [messageJoinRow()],
      [{ namespace_id: NAMESPACE_ID }],
    ]);
    await reads.store.getRevision(11, 0);
    await reads.store.resolveCurrentNamespace(SESSION_ID);
    expect(reads.connection.isolationLevels).toEqual([
      "read committed",
      "read committed",
    ]);
  });

  test("claims fairly with SKIP LOCKED and returns current message only for the claimed revision", async () => {
    const claimed = messageJoinRow({
      lease_token: LEASE_ID,
      lease_expires_at: LEASE_EXPIRES,
    });
    const setup = await storeWithResults([
      [claimed],
    ]);
    expect(await setup.store.claimReconciliationCandidates({
      leaseToken: LEASE_ID,
      limit: 2,
    })).toHaveLength(1);
    const sql = allSql(setup.connection);
    expect(sql).toContain("FOR UPDATE OF lifecycle SKIP LOCKED");
    expect(sql).toContain(
      "ORDER BY lifecycle.next_attempt_at, lifecycle.sequence",
    );
    expect(sql).toContain("lifecycle.next_attempt_at <= CURRENT_TIMESTAMP");
    expect(sql).toContain("lifecycle.repair_identity_digest IS NULL");
    expect(sql).toContain("lifecycle.representation_mode");
    expect(sql).toContain("lifecycle.publication_policy_revision");
    expect(sql).toContain("lifecycle.lease_expires_at <= CURRENT_TIMESTAMP");
    expect(sql).toContain("lease_expires_at = CURRENT_TIMESTAMP");
    expect(sql).toContain("+ $2 * interval '1 second'");
    expect(sql).toContain("LIMIT $3");
    expect(setup.connection.queries.at(-1)?.parameters).toEqual([
      LEASE_ID,
      60,
      2,
    ]);
    expect(setup.connection.isolationLevels).toEqual(["read committed"]);
  });

  test("releases failed claims with deterministic backoff and quarantines the eighth attempt", async () => {
    const retry = lifecycleRow({
      attempt_count: 1,
      failure_code: "storage_transient",
      next_attempt_at: "2027-01-15T08:00:01.000Z",
    });
    const setup = await storeWithResults([
      [retry],
    ]);
    expect(await setup.store.failReconciliationClaim({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      leaseToken: LEASE_ID,
      failureCode: "storage_transient",
    })).toMatchObject({
      attemptCount: 1,
      disposition: "active",
      failureCode: "storage_transient",
    });
    const sql = allSql(setup.connection).replaceAll('"', "");
    expect(sql).toContain(
      "attempt_count = session_message_crypto_revisions.attempt_count + 1",
    );
    expect(sql).toContain("THEN 'quarantined'");
    expect(sql).toContain("THEN 'retry_exhausted'");
    expect(sql).toContain("interval '1 millisecond'");
    expect(sql).toMatch(/lease_expires_at\s*> CURRENT_TIMESTAMP/);
    expect(sql).toContain("ELSE CURRENT_TIMESTAMP");

    const exhausted = lifecycleRow({
      attempt_count: 8,
      disposition: "quarantined",
      failure_code: "retry_exhausted",
      next_attempt_at: null,
      lease_token: null,
      lease_expires_at: null,
    });
    const finalAttempt = await storeWithResults([
      [exhausted],
    ]);
    expect(await finalAttempt.store.failReconciliationClaim({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      leaseToken: LEASE_ID,
      failureCode: "storage_transient",
    })).toMatchObject({
      attemptCount: 8,
      disposition: "quarantined",
      failureCode: "retry_exhausted",
      nextAttemptAt: null,
    });
  });

  test("quarantines only a live exact claim and clears all scheduling authority", async () => {
    const active = lifecycleRow({
      lease_token: LEASE_ID,
      lease_expires_at: LEASE_EXPIRES,
    });
    const quarantined = lifecycleRow({
      disposition: "quarantined",
      failure_code: "crypto_mismatch",
      next_attempt_at: null,
      lease_token: null,
      lease_expires_at: null,
      quarantine_lease_token: LEASE_ID,
    });
    const setup = await storeWithResults([
      [active],
      [quarantined],
      [quarantined],
      [quarantined],
    ]);
    expect(await setup.store.quarantineRevision({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      leaseToken: LEASE_ID,
      failureCode: "crypto_mismatch",
    })).toBe("applied");
    const sql = allSql(setup.connection).replaceAll('"', "");
    expect(sql).toContain("update session_message_crypto_revisions set");
    expect(sql).toContain("disposition =");
    expect(sql).toContain("next_attempt_at =");
    expect(sql).toContain("lease_token =");
    expect(sql).toContain("quarantine_lease_token =");
    expect(sql).toContain("lease_expires_at > CURRENT_TIMESTAMP");
    expect(await setup.store.quarantineRevision({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      leaseToken: LEASE_ID,
      failureCode: "crypto_mismatch",
    })).toBe("duplicate");
    expect(await setup.store.quarantineRevision({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      leaseToken: LEASE_ID,
      failureCode: "namespace_mismatch",
    })).toBe("conflict");
  });

  test("restores an ordinary Message through the canonical Agent CAS", async () => {
    const cryptoObjectId = lifecycleRow()["crypto_object_id"] as string;
    const repairIdentityDigest = digest(0x51);
    const attestationDigest = digest(0x52);
    const setup = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [{roomId: ROOM_ID, parentRoomId: null}] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{
        message_id: 11,
        session_id: SESSION_ID,
        role: "assistant",
        content: null,
        tool_calls: null,
        tool_name: null,
        edit_revision: 0,
        crypto_object_id: cryptoObjectId,
        created_at: NOW,
        namespace_id: NAMESPACE_ID,
        namespace_access_revision: 1,
        namespace_key_generation: 1,
      }] },
      { operation: "select", result: [lifecycleRow({
        completion: "complete",
        disposition: "mapped",
        next_attempt_at: null,
      })] },
      { operation: "select", result: [] },
      { operation: "update", result: [{ message_id: 11 }] },
      { operation: "insert", result: [{ message_id: 11 }] },
    ]);

    expect(await setup.store.restoreOrdinaryExistingRepresentation({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId,
      expectedNamespaceId: NAMESPACE_ID,
      expectedKeyClass: "ai",
      expectedNamespaceAccessRevision: 1,
      expectedNamespaceKeyGeneration: 1,
      expectedAuthorRole: "assistant",
      expectedCreatedAt: new Date(NOW).getTime(),
      content: "restored agent answer",
      toolCalls: null,
      toolName: null,
      authorityActorId: AGENT_ID,
      repairIdentityDigest,
      attestationDigest,
      publisher: { kind: "authenticated_runtime", id: "runtime-signer" },
      publicationPolicy: {
        expectedRevision: 1,
        representation: "ordinary_and_protected",
      },
    })).toBe("applied");
    expect(setup.canonical.events).toEqual([
      "select", "execute",
      "select", "select", "select", "update", "insert",
    ]);
    setup.canonical.assertExhausted();
  });

  test("replays only an exact ordinary repair receipt and rejects stale policy before Message locking", async () => {
    const cryptoObjectId = lifecycleRow()["crypto_object_id"] as string;
    const repairIdentityDigest = digest(0x61);
    const attestationDigest = digest(0x62);
    const input = {
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId,
      expectedNamespaceId: NAMESPACE_ID,
      expectedKeyClass: "ai" as const,
      expectedNamespaceAccessRevision: 1,
      expectedNamespaceKeyGeneration: 1,
      expectedAuthorRole: "assistant" as const,
      expectedCreatedAt: new Date(NOW).getTime(),
      content: "restored agent answer",
      toolCalls: null,
      toolName: null,
      authorityActorId: AGENT_ID,
      repairIdentityDigest,
      attestationDigest,
      publisher: { kind: "authenticated_runtime" as const, id: "runtime-signer" },
      publicationPolicy: {
        expectedRevision: 1,
        representation: "ordinary_and_protected" as const,
      },
    };
    const replay = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [{roomId: ROOM_ID, parentRoomId: null}] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{
        message_id: 11,
        session_id: SESSION_ID,
        role: "assistant",
        content: input.content,
        tool_calls: null,
        tool_name: null,
        edit_revision: 0,
        crypto_object_id: cryptoObjectId,
        created_at: NOW,
        namespace_id: NAMESPACE_ID,
        namespace_access_revision: 1,
        namespace_key_generation: 1,
      }] },
      { operation: "select", result: [lifecycleRow({
        completion: "complete",
        disposition: "mapped",
        next_attempt_at: null,
      })] },
      { operation: "select", result: [{
        repair_identity_digest: repairIdentityDigest,
        attestation_digest: attestationDigest,
        publisher_kind: "authenticated_runtime",
        publisher_id: "runtime-signer",
        policy_revision: 1,
        expected_key_class: "ai",
        authority_actor_id: AGENT_ID,
        crypto_object_id: cryptoObjectId,
      }] },
    ]);
    expect(await replay.store.restoreOrdinaryExistingRepresentation(input))
      .toBe("replayed");
    expect(replay.canonical.events).toEqual(["select", "execute", "select", "select", "select"]);

    const secondReader = await storeWithResults([], "nautilo_agent", [
      { operation: "select", result: [{roomId: ROOM_ID, parentRoomId: null}] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{
        message_id: 11,
        session_id: SESSION_ID,
        role: "assistant",
        content: input.content,
        tool_calls: null,
        tool_name: null,
        edit_revision: 0,
        crypto_object_id: cryptoObjectId,
        created_at: NOW,
        namespace_id: NAMESPACE_ID,
        namespace_access_revision: 1,
      }] },
      { operation: "select", result: [lifecycleRow({
        completion: "complete",
        disposition: "mapped",
        next_attempt_at: null,
      })] },
      { operation: "select", result: [{
        repair_identity_digest: repairIdentityDigest,
        attestation_digest: attestationDigest,
        publisher_kind: "authenticated_runtime",
        publisher_id: "runtime-signer",
        policy_revision: 1,
        expected_key_class: "ai",
        authority_actor_id: AGENT_ID,
        crypto_object_id: cryptoObjectId,
      }] },
    ]);
    expect(await secondReader.store.restoreOrdinaryExistingRepresentation({
      ...input,
      repairIdentityDigest: digest(0x63),
      publisher: { ...input.publisher, id: "later-runtime-signer" },
    })).toBe("replayed");
    expect(secondReader.canonical.events).toEqual([
      "select", "execute", "select", "select", "select",
    ]);

    const stale = await storeWithResults([], "nautilo_agent");
    expect((await rejectedError(
      stale.store.restoreOrdinaryExistingRepresentation({
        ...input,
        publicationPolicy: { ...input.publicationPolicy, expectedRevision: 2 },
      }),
    )).message).toMatch(/revision 2 is stale; current revision is 1/);
    expect(stale.canonical.events).toEqual([]);
  });
});

test.each([
  {keyClass: "human", previous: "device_attested", incoming: "device_attested"},
  {keyClass: "ai", previous: "device_attested", incoming: "device_attested"},
  {keyClass: "ai", previous: "authenticated_runtime", incoming: "device_attested"},
  {keyClass: "ai", previous: "device_attested", incoming: "authenticated_runtime"},
] as const)("authorized publishers converge on exact restored source %j without rewriting first receipt", async ({keyClass, previous, incoming}) => {
  const cryptoObjectId = lifecycleRow()["crypto_object_id"] as string;
  const input = {
    sessionId: SESSION_ID, messageId: 11, revision: 0, cryptoObjectId,
    expectedNamespaceId: NAMESPACE_ID, expectedKeyClass: keyClass,
    expectedNamespaceAccessRevision: 1, expectedNamespaceKeyGeneration: 1,
    currentNamespaceAccessRevision: 3,
    expectedAuthorRole: "system" as const, expectedCreatedAt: new Date(NOW).getTime(),
    content: "restored system body", toolCalls: JSON.stringify({ reason: "summary" }), toolName: null,
    authorityActorId: incoming === "device_attested" ? HUMAN_ACTOR_ID : AGENT_ID, repairIdentityDigest: digest(0x64), attestationDigest: digest(0x65),
    publisher: { kind: incoming, id: "other-authorized-device" },
    publicationPolicy: { expectedRevision: 1, representation: "ordinary_and_protected" as const },
  };
  for (const changed of [false, true]) {
    const setup = await storeWithResults([], incoming === "device_attested" ? "nautilo" : "nautilo_agent", [
      { operation: "select", result: [{roomId: ROOM_ID, parentRoomId: null}] },
      { operation: "execute", result: [] },
      { operation: "select", result: [{
        message_id: 11, session_id: SESSION_ID, role: "system", content: input.content,
        tool_calls: input.toolCalls, tool_name: null, edit_revision: 0, crypto_object_id: cryptoObjectId,
        created_at: NOW, namespace_id: NAMESPACE_ID, namespace_access_revision: 3,
      }] },
      { operation: "select", result: [lifecycleRow({ key_class: keyClass, author_role: "system",
        completion: "complete", disposition: "mapped", next_attempt_at: null })] },
      ...(changed ? [] : [{ operation: "select" as const, result: [{
        repair_identity_digest: digest(0x61), attestation_digest: digest(0x62),
        publisher_kind: previous, publisher_id: "first-authorized-publisher", policy_revision: 1,
        expected_key_class: keyClass, authority_actor_id: HUMAN_ACTOR_ID, crypto_object_id: cryptoObjectId,
      }] }]),
    ]);
    expect(await setup.store.restoreOrdinaryExistingRepresentation({ ...input,
      content: changed ? "substituted" : input.content })).toBe(changed ? "conflict" : "replayed");
    expect(setup.canonical.events).toEqual(changed ? ["select", "execute", "select", "select"] : ["select", "execute", "select", "select", "select"]);
    setup.canonical.assertExhausted();
  }
});

test.each(["applied", "restored", "stale", "replayed"] as const)("exact independent parity update preserves restoration provenance: %s", async (scenario) => {
  const cryptoObjectId = lifecycleRow()["crypto_object_id"] as string;
  const setup = await storeWithResults([], "nautilo", [
      { operation: "select", result: [{roomId: ROOM_ID, parentRoomId: null}] },
      { operation: "execute", result: [] },
    { operation: "select", result: [{ message_id: 11, edit_revision: 0,
      crypto_object_id: cryptoObjectId, namespace_id: NAMESPACE_ID,
      namespace_access_revision: 3, ordinary_present: scenario !== "stale" }] },
    ...(scenario === "stale" ? [] : [{ operation: "select" as const,
      result: scenario === "restored" ? [{ message_id: 11 }] : [] }]),
    ...((scenario === "stale" || scenario === "restored") ? [] : [
      { operation: "select" as const, result: [{ completion: "complete", disposition: "mapped",
        crypto_object_id: cryptoObjectId, key_class: "human",
        parity_status: scenario === "replayed" ? "client_verified" : "client_authenticated" }] },
      ...(scenario === "applied" ? [{ operation: "update" as const, result: [{ message_id: 11 }] }] : []),
    ]),
  ]);
  expect(await setup.store.acceptIndependentMessageParity({ sessionId: SESSION_ID, messageId: 11,
    revision: 0, cryptoObjectId, expectedNamespaceId: NAMESPACE_ID,
    expectedKeyClass: "human", expectedNamespaceAccessRevision: 3, authorityActorId: HUMAN_ACTOR_ID,
    publicationPolicy: { expectedRevision: 1, representation: "ordinary_and_protected" },
  })).toBe(scenario);
  setup.canonical.assertExhausted();
});


test.each(["human_device", "foreground_runtime"] as const)("commits exact pending %s manifest reservation without claiming crypto completion", async publisherKind => {
  const pending = lifecycleRow({repair_identity_digest: digest(0x41), repair_publisher_kind: "human_device",
    repair_publisher_id: "prior-device", repair_publisher_human_id: HUMAN_ACTOR_ID, repair_attestation_digest: digest(0x42)});
  const setup = await storeWithResults([], publisherKind === "human_device" ? "nautilo" : "nautilo_agent", [
    {operation: "select", result: [pending]}, {operation: "update", result: [{messageId: 11}]},
  ]);
  const repairPublication = publisherKind === "human_device"
    ? {publisherKind, publisherId: "new-device", publisherHumanId: HUMAN_ACTOR_ID, attestationDigest: digest(0x43)}
    : {publisherKind, publisherId: "new-runtime", attestationDigest: digest(0x43)};
  expect(await setup.store.reserveExistingRepresentationPublication({sessionId: SESSION_ID, messageId: 11, revision: 0,
    cryptoObjectId: pending["crypto_object_id"] as string, sourceDigest: digest(), repairPublication,
    publicationPolicy: {expectedRevision: 1, representation: "ordinary_and_protected"}})).toBe("reserved");
  expect(setup.canonical.updatedValues[0]).toMatchObject({repairPublisherKind: publisherKind,
    repairPublisherHumanId: publisherKind === "human_device" ? HUMAN_ACTOR_ID : null});
  expect(setup.canonical.updatedValues[0]).not.toHaveProperty("completion");
  expect(setup.canonical.updatedValues[0]).not.toHaveProperty("parityStatus");
  setup.canonical.assertExhausted();
});

test.each([false, true])("Runtime may complete only exact reserved device proof without rewriting Human column (changed %s)", async changed => {
  const pending = lifecycleRow({author_role: "user", repair_identity_digest: digest(0x41), repair_publisher_kind: "human_device",
    repair_publisher_id: "prior-device", repair_publisher_human_id: HUMAN_ACTOR_ID, repair_attestation_digest: digest(0x42)});
  const setup = await storeWithResults([], "nautilo_agent", [
    {operation: "select", result: [pending]}, ...(changed ? [] : [{operation: "update" as const, result: [pending]}]),
  ]);
  expect(await setup.store.markCryptoComplete({sessionId: SESSION_ID, messageId: 11, revision: 0,
    cryptoObjectId: pending["crypto_object_id"] as string, parityStatus: "client_authenticated", leaseToken: null,
    repairPublication: {publisherKind: "human_device", publisherId: "prior-device", publisherHumanId: HUMAN_ACTOR_ID,
      attestationDigest: digest(changed ? 0x44 : 0x42)},
    publicationPolicy: {expectedRevision: 1, representation: "ordinary_and_protected"}})).toBe(changed ? "conflict" : "applied");
  if (!changed) expect(setup.canonical.updatedValues[0]).not.toHaveProperty("repairPublisherHumanId");
  setup.canonical.assertExhausted();
});


test.each(["refresh", "unchanged", "stale", "complete", "same_generation"] as const)("pending Tool source reconciliation: %s", async scenario => {
  const old = digest(0x61), current = scenario === "unchanged" ? old : digest(0x62);
  const pending = lifecycleRow({author_role: "tool", repair_identity_digest: digest(0x63),
    allocation_request_digest: old, repair_source_revision: scenario === "same_generation" ? 7 : null,
    repair_source_digest: scenario === "same_generation" ? old : null,
    ...(scenario === "complete" ? {completion: "complete", crypto_completed_at: new Date(), parity_status: "client_authenticated"} : {}),
  });
  const setup = await storeWithResults([], "nautilo", [
    {operation: "select", result: [{revision: scenario === "stale" ? 8 : 7}]},
    ...(scenario === "stale" ? [] : [{operation: "select" as const, result: [pending]}]),
    ...(scenario === "refresh" ? [{operation: "update" as const, result: []}] : []),
  ]);
  expect(await setup.store.refreshPendingToolRepairSource({sessionId: SESSION_ID, messageId: 11, revision: 0,
    cryptoObjectId: pending["crypto_object_id"] as string, sourceRevision: 7, sourceDigest: current,
  })).toBe(scenario === "refresh" || scenario === "unchanged" ? "refreshed" : "conflict");
  if (scenario === "refresh") {
    expect(setup.canonical.updatedValues[0]).toMatchObject({repairSourceRevision: 7, repairSourceDigest: current,
      repairPublisherKind: null, repairPublisherId: null, repairPublisherHumanId: null, repairAttestationDigest: null});
    expect(setup.canonical.updatedValues[0]).not.toHaveProperty("allocationRequestDigest");
    expect(setup.canonical.updatedValues[0]).not.toHaveProperty("cryptoObjectId");
  }
  setup.canonical.assertExhausted();
});

test.each(["foreground_runtime", "human_device"] as const)(
  "M313 source refresh clears an absent %s reservation without replacing allocation identity",
  async publisherKind => {
    const allocationDigest = digest(0x71);
    const cryptoObjectId = deriveMessageCryptoObjectIdV2({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
    });
    const pending = lifecycleRow({
      author_role: "tool",
      crypto_object_id: cryptoObjectId,
      allocation_request_digest: allocationDigest,
      repair_identity_digest: digest(0x72),
      repair_publisher_kind: publisherKind,
      repair_publisher_id: publisherKind === "human_device"
        ? "prior-device"
        : "prior-runtime-signer",
      repair_publisher_human_id: publisherKind === "human_device"
        ? HUMAN_ACTOR_ID
        : null,
      repair_attestation_digest: digest(0x73),
    });
    const currentDigest = digest(0x74);
    const setup = await storeWithResults([], "nautilo", [
      { operation: "select", result: [{ revision: 7 }] },
      { operation: "select", result: [pending] },
      { operation: "update", result: [] },
    ]);

    expect(await setup.store.refreshPendingToolRepairSource({
      sessionId: SESSION_ID,
      messageId: 11,
      revision: 0,
      cryptoObjectId,
      sourceRevision: 7,
      sourceDigest: currentDigest,
    })).toBe("refreshed");
    expect(setup.canonical.updatedValues[0]).toMatchObject({
      repairSourceRevision: 7,
      repairSourceDigest: currentDigest,
      repairPublisherKind: null,
      repairPublisherId: null,
      repairPublisherHumanId: null,
      repairAttestationDigest: null,
    });
    expect(setup.canonical.updatedValues[0]).not.toHaveProperty(
      "allocationRequestDigest",
    );
    expect(setup.canonical.updatedValues[0]).not.toHaveProperty(
      "cryptoObjectId",
    );
    expect(pending["allocation_request_digest"]).toBe(allocationDigest);
    expect(pending["crypto_object_id"]).toBe(cryptoObjectId);
    setup.canonical.assertExhausted();
  },
);
