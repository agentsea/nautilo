import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@nautilo/db/schema";
import {
  createPostgresJsCanonicalBridgeConnection,
  compareAndSwapEncryptionTransitionPolicy,
  conversationHumanPeerShadowOperations,
  getEncryptionTransitionPolicy,
  cryptoObjects as cryptoObjectsTable,
  encryptionTransitionPolicy,
  namespaceDomainKeyBindings,
  namespaceDomainKeyHeads,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessageOrdinaryRepairs,
  sessionMessages,
  sessions,
} from "@nautilo/db";
import {
  bindConversationProductCanonicalTransactionRunner,
  loadPostgresForegroundMessageRepairSources,
  PostgresConversationProductStore,
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresExecutor,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";
import { deriveHumanMessageEditCryptoObjectIdV1 } from "@nautilo/lattice-crypto/wire";
import { deriveLiveShadowMessageCryptoObjectIdV1 } from "../../src/message/conversation-repository.ts";
import type { CanonicalTranscriptTx } from "@nautilo/trust";
import { fingerprintNamespaceGenerationAudience, humanId } from "@nautilo/lattice-crypto";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

type CallerContext = Readonly<{
  userId: string;
  agentId: string;
}>;

type ProductFixture = Readonly<{
  ownerId: string;
  requesterId: string;
  humanActorId: string;
  agentActorId: string;
  agentId: string;
  namespaceId: string;
  roomId: string;
  sessionId: string;
}>;

const adminUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL",
);
const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const agentUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL",
);

let admin: SqlClient;
let originalSuitePolicy: Awaited<ReturnType<typeof getEncryptionTransitionPolicy>>;
const fixtures: ProductFixture[] = [];
const cryptoObjects = new Set<string>();

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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

function sqlClient(url: string, maximumConnections = 8): SqlClient {
  return postgres(url, {
    max: maximumConnections,
    prepare: false,
    onnotice: () => undefined,
  });
}

function executor(
  client: SqlExecutor,
  beforeQuery?: (statement: string) => void,
): ConversationProductPostgresExecutor {
  return {
    async query<Row extends ConversationProductDatabaseRow =
      ConversationProductDatabaseRow>(
      statement: string,
      parameters: readonly ConversationProductPostgresScalar[] = [],
    ): Promise<readonly Row[]> {
      beforeQuery?.(statement);
      const rows = await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      );
      return rows as unknown as readonly Row[];
    },
  };
}

function connection(
  client: SqlClient,
  context?: CallerContext,
  beforeQuery?: (statement: string) => void,
): ConversationProductPostgresConnection {
  return {
    ...executor(client, beforeQuery),
    transaction: <Result>(
      callback: (
        transaction: ConversationProductPostgresExecutor,
      ) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ): Promise<Result> =>
      client.begin(
        `isolation level ${options.isolationLevel}`,
        async (transaction) => {
          if (context !== undefined) {
            await transaction.unsafe(
              `SELECT set_config(
                        'app.current_user_id',
                        $1,
                        true
                      ),
                      set_config(
                        'app.current_agent_id',
                        $2,
                        true
                      )`,
              [context.userId, context.agentId],
            );
          }
          return callback(executor(transaction, beforeQuery));
        },
      ) as unknown as Promise<Result>,
  };
}

function canonicalConnection(
  client: SqlClient,
  context?: CallerContext,
): ConversationProductCanonicalTransactionConnection {
  const database = createPostgresJsCanonicalBridgeConnection(drizzle(client, { schema }));
  return {
    transaction: <Result>(
      callback: (
        transaction: CanonicalTranscriptTx,
        executor: ConversationProductPostgresExecutor,
      ) => Promise<Result>,
      options: Readonly<{
        isolationLevel: ConversationProductPostgresIsolationLevel;
      }>,
    ): Promise<Result> =>
      database.transaction(
        async (transaction, bridgeExecutor) => {
          if (context !== undefined) {
            await transaction.execute(sql`
              SELECT set_config(
                       'app.current_user_id',
                       ${context.userId},
                       true
                     ),
                     set_config(
                       'app.current_agent_id',
                       ${context.agentId},
                       true
                     )
            `);
          }
          return callback(transaction, bridgeExecutor);
        },
        { isolationLevel: options.isolationLevel },
      ),
  };
}

async function productStore(
  client: SqlClient,
  context?: CallerContext,
  beforeQuery?: (statement: string) => void,
): Promise<PostgresConversationProductStore> {
  const handle = await verifyConversationProductPostgresHandle(
    connection(client, context, beforeQuery),
  );
  return new PostgresConversationProductStore(
    handle,
    bindConversationProductCanonicalTransactionRunner(
      handle,
      canonicalConnection(client, context),
    ),
  );
}

function digest(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected operation to reject");
}

async function createFixture(): Promise<ProductFixture> {
  const fixture = Object.freeze({
    ownerId: randomUUID(),
    requesterId: randomUUID(),
    humanActorId: randomUUID(),
    agentActorId: randomUUID(),
    agentId: randomUUID(),
    namespaceId: randomUUID(),
    roomId: randomUUID(),
    sessionId: randomUUID(),
  });
  fixtures.push(fixture);
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `INSERT INTO users (id, name)
       VALUES ($1, 'Conversation fixture owner'),
              ($2, 'Conversation fixture requester')`,
      [fixture.ownerId, fixture.requesterId],
    );
    await transaction.unsafe(
      `INSERT INTO agents (id, handle)
       VALUES ($1, $2)`,
      [fixture.agentId, `conversation-${fixture.agentId}`],
    );
    await transaction.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind, agent_id
       ) VALUES
         ($1, $2, 'Conversation fixture human', 'verified', 'user', NULL),
         ($3, $4, 'Conversation fixture agent', 'verified', 'agent', $5)`,
      [
        fixture.humanActorId,
        fixture.ownerId,
        fixture.agentActorId,
        fixture.requesterId,
        fixture.agentId,
      ],
    );
    await transaction.unsafe(
      `INSERT INTO namespaces (id, scope, label)
       VALUES ($1, 'room', 'Conversation fixture Namespace')`,
      [fixture.namespaceId],
    );
    await transaction.unsafe(
      `INSERT INTO rooms (
         id, owner_id, type, label, graph_thread_id, namespace_id,
         human_actor_ids, kind, created_by
       ) VALUES (
         $1, $2, 'private', 'Conversation fixture Room', $3, $4,
         ARRAY[$5::uuid], 'private', $5
       )`,
      [
        fixture.roomId,
        fixture.ownerId,
        `conversation:${fixture.roomId}`,
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
        `conversation:${fixture.sessionId}`,
        fixture.requesterId,
        fixture.agentId,
        fixture.roomId,
      ],
    );
  });
  return fixture;
}

async function cleanupFixture(fixture: ProductFixture): Promise<void> {
  await admin.begin(async (transaction) => {
    await transaction.unsafe(
      `DELETE FROM session_messages WHERE session_id = $1`,
      [fixture.sessionId],
    );
    await transaction.unsafe(
      `DELETE FROM sessions WHERE id = $1`,
      [fixture.sessionId],
    );
    await transaction.unsafe(
      `DELETE FROM rooms WHERE id = $1`,
      [fixture.roomId],
    );
    await transaction.unsafe(
      `DELETE FROM namespace_domain_key_heads WHERE namespace_id = $1`,
      [fixture.namespaceId],
    );
    await transaction.unsafe(
      `DELETE FROM namespace_domain_key_bindings WHERE namespace_id = $1`,
      [fixture.namespaceId],
    );
    await transaction.unsafe(
      `DELETE FROM namespaces WHERE id = $1`,
      [fixture.namespaceId],
    );
    await transaction.unsafe(
      `DELETE FROM actors WHERE id IN ($1, $2)`,
      [fixture.humanActorId, fixture.agentActorId],
    );
    await transaction.unsafe(
      `DELETE FROM agents WHERE id = $1`,
      [fixture.agentId],
    );
    await transaction.unsafe(
      `DELETE FROM users WHERE id IN ($1, $2)`,
      [fixture.ownerId, fixture.requesterId],
    );
  });
}

beforeAll(async () => {
  admin = sqlClient(adminUrl, 1);
  // Ordinary-path fixtures must declare their baseline instead of inheriting
  // whatever mode a populated disposable QA clone was last testing.
  const db = drizzle(admin) as Parameters<typeof compareAndSwapEncryptionTransitionPolicy>[0];
  originalSuitePolicy = await getEncryptionTransitionPolicy(db);
  await compareAndSwapEncryptionTransitionPolicy(db, {
    expectedRevision: originalSuitePolicy.revision,
    targetMode: "shadow_encryption",
    targetShadowBehavior: "fallback",
  });
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await cleanupFixture(fixture);
  }
  for (const objectId of cryptoObjects) {
    await admin.unsafe(
      `DELETE FROM crypto_objects WHERE object_id = $1`,
      [objectId],
    );
  }
  cryptoObjects.clear();
});

afterAll(async () => {
  try {
    if (originalSuitePolicy) {
      const db = drizzle(admin) as Parameters<typeof compareAndSwapEncryptionTransitionPolicy>[0];
      const current = await getEncryptionTransitionPolicy(db);
      await compareAndSwapEncryptionTransitionPolicy(db, {
        expectedRevision: current.revision,
        targetMode: originalSuitePolicy.mode,
        targetShadowBehavior: originalSuitePolicy.shadowBehavior,
      });
    }
  } finally {
    await admin.end();
  }
});

describe("Postgres conversation product store", () => {
  test("serializes prepared completion and mapping behind the policy fence", async () => {
    const fixture = await createFixture();
    const client = sqlClient(agentUrl);
    const adminDb = drizzle(admin);
    const [original] = await adminDb.select({ mode: encryptionTransitionPolicy.mode,
      shadowBehavior: encryptionTransitionPolicy.shadowBehavior,
      shadowEncryptionStartedAt: encryptionTransitionPolicy.shadowEncryptionStartedAt,
    }).from(encryptionTransitionPolicy).where(eq(encryptionTransitionPolicy.id, "server"));
    if (original === undefined) throw new Error("Missing transition policy");
    try {
      const [policy] = await adminDb.update(encryptionTransitionPolicy).set({
        mode: "shadow_encryption",
        revision: sql`${encryptionTransitionPolicy.revision} + 1`,
        shadowEncryptionStartedAt: sql`coalesce(${encryptionTransitionPolicy.shadowEncryptionStartedAt}, CURRENT_TIMESTAMP)`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"))
        .returning({ revision: encryptionTransitionPolicy.revision });
      if (policy === undefined) throw new Error("Missing updated policy");
      const store = await productStore(client, {
        userId: fixture.requesterId, agentId: fixture.agentId,
      });
      const allocation = await store.appendAllocated({
        ...canonicalAppendFacts,
        sessionId: fixture.sessionId,
        idempotencyKey: `policy-race-${randomUUID()}`,
        content: "policy race",
        keyClass: "ai",
        authorRole: "assistant",
        requestDigest: digest(0xa1),
        publicationPolicy: {
          expectedRevision: policy.revision,
          representation: "ordinary_and_protected",
        },
      });
      if (allocation.status === "conflict") {
        throw new Error("Unexpected allocation conflict");
      }

      let completion!: Promise<unknown>;
      await adminDb.transaction(async (transaction) => {
        await transaction.update(encryptionTransitionPolicy).set({
          revision: sql`${encryptionTransitionPolicy.revision} + 1`, updatedAt: sql`CURRENT_TIMESTAMP`,
        }).where(eq(encryptionTransitionPolicy.id, "server"));
        completion = store.markCryptoComplete({
          sessionId: fixture.sessionId,
          messageId: allocation.lifecycle.messageId,
          revision: 0,
          cryptoObjectId: allocation.lifecycle.cryptoObjectId,
          parityStatus: "server_verified",
          leaseToken: null,
          publicationPolicy: {
            expectedRevision: policy.revision,
            representation: "ordinary_and_protected",
          },
        });
        void completion.catch(() => undefined);
      });
      expect(completion).rejects.toThrow(/policy revision .* stale/i);

      const [current] = await adminDb.select({ revision: encryptionTransitionPolicy.revision })
        .from(encryptionTransitionPolicy).where(eq(encryptionTransitionPolicy.id, "server"));
      if (current === undefined) throw new Error("Missing current policy");
      expect(store.compareAndSwapCryptoMapping({
        sessionId: fixture.sessionId,
        messageId: allocation.lifecycle.messageId,
        revision: 0,
        expectedNamespaceId: fixture.namespaceId,
        cryptoObjectId: allocation.lifecycle.cryptoObjectId,
        leaseToken: null,
        publicationPolicy: {
          expectedRevision: policy.revision,
          representation: "ordinary_and_protected",
        },
      })).rejects.toThrow(/policy revision .* stale/i);
    } finally {
      await client.end();
      await adminDb.update(encryptionTransitionPolicy).set({ mode: original.mode,
        shadowBehavior: original.shadowBehavior,
        shadowEncryptionStartedAt: original.shadowEncryptionStartedAt,
        revision: sql`${encryptionTransitionPolicy.revision} + 1`, updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
    }
  });

  test("attaches another Room Agent's exact Message through foreground membership", async () => {
    const fixture = await createFixture();
    const sourceAgentId = randomUUID();
    const sourceAgentActorId = randomUUID();
    const sourceSessionId = randomUUID();
    await admin.begin(async (transaction) => {
      await transaction.unsafe(
        `INSERT INTO agents (id, handle) VALUES ($1, $2)`,
        [sourceAgentId, `conversation-source-${sourceAgentId}`],
      );
      await transaction.unsafe(
        `INSERT INTO actors (
           id, owner_id, display_name, trust_state, kind, agent_id
         ) VALUES ($1, $2, 'Conversation source agent', 'verified', 'agent', $3)`,
        [sourceAgentActorId, fixture.ownerId, sourceAgentId],
      );
      await transaction.unsafe(
        `INSERT INTO room_members (
           room_id, actor_id, room_role, agent_response_mode
         ) VALUES ($1, $2, 'member', 'active')`,
        [fixture.roomId, sourceAgentActorId],
      );
      await transaction.unsafe(
        `INSERT INTO sessions (
           id, thread_id, owner_id, persona_id, agent_id, room_id, channel
         ) VALUES ($1, $2, $3, 'owner', $4, $5, 'integration')`,
        [
          sourceSessionId,
          `conversation:${sourceSessionId}`,
          fixture.ownerId,
          sourceAgentId,
          fixture.roomId,
        ],
      );
    });
    const adminDb = drizzle(admin);
    const [originalPolicy] = await adminDb.select({
      mode: encryptionTransitionPolicy.mode,
      shadowBehavior: encryptionTransitionPolicy.shadowBehavior,
      shadowEncryptionStartedAt:
        encryptionTransitionPolicy.shadowEncryptionStartedAt,
    }).from(encryptionTransitionPolicy).where(eq(
      encryptionTransitionPolicy.id,
      "server",
    ));
    if (originalPolicy === undefined) throw new Error("Missing transition policy");
    const [repairPolicy] = await adminDb.update(encryptionTransitionPolicy).set({
      mode: "shadow_encryption",
      revision: sql`${encryptionTransitionPolicy.revision} + 1`,
      shadowEncryptionStartedAt:
        sql`coalesce(${encryptionTransitionPolicy.shadowEncryptionStartedAt}, CURRENT_TIMESTAMP)`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    }).where(eq(encryptionTransitionPolicy.id, "server")).returning({
      revision: encryptionTransitionPolicy.revision,
    });
    if (repairPolicy === undefined) throw new Error("Missing updated policy");
    const client = sqlClient(agentUrl);
    try {
      const [message] = await admin.unsafe<{
        id: number;
      }[]>(
        `INSERT INTO session_messages (
           session_id, role, content, human_turn_id
         ) VALUES ($1, 'user', 'ordinary foreground history', $2)
         RETURNING id`,
        [sourceSessionId, `turn-${randomUUID()}`],
      );
      if (message === undefined) throw new Error("Message fixture missing");
      const store = await productStore(client, {
        userId: fixture.requesterId,
        agentId: fixture.agentId,
      });
      const [source] = await loadPostgresForegroundMessageRepairSources({
        product: await verifyConversationProductPostgresHandle(
          connection(client, {
            userId: fixture.requesterId,
            agentId: fixture.agentId,
          }),
        ),
        readableNamespaceIds: [fixture.namespaceId],
        messageIds: [message.id],
      });
      expect(source).toMatchObject({
        messageId: message.id,
        sessionId: sourceSessionId,
        roomId: fixture.roomId,
        namespaceId: fixture.namespaceId,
        revision: 0,
        authorRole: "user",
        sessionAgentId: sourceAgentId,
        mappedCryptoObjectId: null,
        payload: { role: "user", content: "ordinary foreground history" },
      });
      const requestDigest = digest(0x91);
      const repairIdentityDigest = digest(0x92);
      const allocation = await store.allocateExistingRepresentation({
        sessionId: sourceSessionId,
        messageId: message.id,
        revision: 0,
        publisher: {
          kind: "foreground_runtime",
          agentId: fixture.agentId,
        },
        operationId: `foreground-repair-${randomUUID()}`,
        expectedNamespaceId: fixture.namespaceId,
        expectedAuthorRole: "user",
        expectedAuthorHumanTurnId: source!.authorHumanTurnId,
        expectedSessionAgentId: sourceAgentId,
        requestDigest,
        repairIdentityDigest,
      });
      expect(allocation.status).toBe("allocated");
      if (allocation.status !== "allocated") {
        throw new Error(`Unexpected repair allocation: ${allocation.status}`);
      }
      expect(await store.claimReconciliationCandidates({
        leaseToken: randomUUID(),
        limit: 8,
      })).toEqual([]);
      cryptoObjects.add(allocation.lifecycle.cryptoObjectId);
      await admin.unsafe(
        `INSERT INTO crypto_objects (object_id, payload_hash, payload_bytes)
         VALUES ($1, $2, $3)`,
        [
          allocation.lifecycle.cryptoObjectId,
          digest(0x93),
          new Uint8Array([0x02]),
        ],
      );
      expect(await store.markCryptoComplete({
        sessionId: sourceSessionId,
        messageId: message.id,
        revision: 0,
        cryptoObjectId: allocation.lifecycle.cryptoObjectId,
        parityStatus: "server_verified",
        leaseToken: null,
        repairPublication: {
          publisherKind: "foreground_runtime",
          publisherId: "m311-integration-signer",
          attestationDigest: digest(0x94),
        },
        publicationPolicy: {
          expectedRevision: repairPolicy.revision,
          representation: "ordinary_and_protected",
        },
      })).toBe("applied");
      expect(await store.compareAndSwapCryptoMapping({
        sessionId: sourceSessionId,
        messageId: message.id,
        revision: 0,
        expectedNamespaceId: fixture.namespaceId,
        cryptoObjectId: allocation.lifecycle.cryptoObjectId,
        leaseToken: null,
        publicationPolicy: {
          expectedRevision: repairPolicy.revision,
          representation: "ordinary_and_protected",
        },
      })).toBe("applied");
      expect((await loadPostgresForegroundMessageRepairSources({
        product: await verifyConversationProductPostgresHandle(
          connection(client, {
            userId: fixture.requesterId,
            agentId: fixture.agentId,
          }),
        ),
        readableNamespaceIds: [fixture.namespaceId],
        messageIds: [message.id],
      }))[0]).toMatchObject({
        messageId: message.id,
        mappedCryptoObjectId: allocation.lifecycle.cryptoObjectId,
      });
      expect((await loadPostgresForegroundMessageRepairSources({
        product: await verifyConversationProductPostgresHandle(
          connection(client, {
            userId: fixture.requesterId,
            agentId: fixture.agentId,
          }),
        ),
        readableNamespaceIds: [fixture.namespaceId],
        messageIds: [message.id],
        representationMode: "protected-only",
      }))[0]).toMatchObject({
        messageId: message.id,
        mappedCryptoObjectId: allocation.lifecycle.cryptoObjectId,
        payload: null,
      });
    } finally {
      await client.end();
      await adminDb.update(encryptionTransitionPolicy).set({
        mode: originalPolicy.mode,
        shadowBehavior: originalPolicy.shadowBehavior,
        shadowEncryptionStartedAt: originalPolicy.shadowEncryptionStartedAt,
        revision: sql`${encryptionTransitionPolicy.revision} + 1`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      await admin.begin(async (transaction) => {
        await transaction.unsafe(
          `DELETE FROM session_messages WHERE session_id = $1`,
          [sourceSessionId],
        );
        await transaction.unsafe(`DELETE FROM sessions WHERE id = $1`, [sourceSessionId]);
        await transaction.unsafe(
          `DELETE FROM room_members WHERE room_id = $1 AND actor_id = $2`,
          [fixture.roomId, sourceAgentActorId],
        );
        await transaction.unsafe(`DELETE FROM actors WHERE id = $1`, [sourceAgentActorId]);
        await transaction.unsafe(`DELETE FROM agents WHERE id = $1`, [sourceAgentId]);
      });
    }
  });

  test("serializes concurrent response-loss replay before allocating an int4 message ID", async () => {
    const fixture = await createFixture();
    const statements: string[] = [];
    const client = sqlClient(appUrl, 12);
    try {
      const store = await productStore(
        client,
        undefined,
        (statement) => {
          statements.push(statement);
        },
      );
      const input = {
        ...canonicalAppendFacts,
        sessionId: fixture.sessionId,
        idempotencyKey: `append-${randomUUID()}`,
        content: "concurrent response-loss replay",
        keyClass: "ai" as const,
        authorRole: "assistant" as const,
        requestDigest: digest(0x31),
      };

      const outcomes = await Promise.all(
        Array.from(
          { length: 24 },
          () => store.appendAllocated(input),
        ),
      );
      expect(
        outcomes.filter(({ status }) => status === "allocated"),
      ).toHaveLength(1);
      expect(
        outcomes.filter(({ status }) => status === "replayed"),
      ).toHaveLength(23);
      const messageIds = new Set(
        outcomes.flatMap((outcome) =>
          outcome.status === "conflict" ? [] : [outcome.lifecycle.messageId]
        ),
      );
      expect(messageIds.size).toBe(1);

      expect(await store.appendAllocated(input)).toMatchObject({
        status: "replayed",
      });
      expect(await store.appendAllocated({
        ...input,
        content: "conflicting replay",
        requestDigest: digest(0x32),
      })).toEqual({ status: "conflict" });
      expect(statements.join("\n")).not.toMatch(
        /SET\s+(?:LOCAL\s+)?ROLE|RESET\s+ROLE/i,
      );

      const counts = await admin.unsafe<{
        lifecycle_count: string;
        message_count: string;
      }[]>(
        `SELECT
           (
             SELECT count(*)::text
               FROM session_message_crypto_revisions
              WHERE session_id = $1
           ) AS lifecycle_count,
           (
             SELECT count(*)::text
               FROM session_messages
              WHERE session_id = $1
           ) AS message_count`,
        [fixture.sessionId],
      );
      expect(counts[0]).toMatchObject({
        lifecycle_count: "1",
        message_count: "1",
      });
    } finally {
      await client.end();
    }
  });

  test("completes and maps one revision, then preserves edit and delete receipts", async () => {
    const fixture = await createFixture();
    const client = sqlClient(appUrl);
    try {
      const store = await productStore(client);
      const append = await store.appendAllocated({
        ...canonicalAppendFacts,
        sessionId: fixture.sessionId,
        idempotencyKey: `append-${randomUUID()}`,
        content: "plaintext shadow",
        keyClass: "ai",
        authorRole: "assistant",
        requestDigest: digest(0x41),
      });
      if (append.status !== "allocated") {
        throw new Error(`Unexpected append status: ${append.status}`);
      }
      const { lifecycle } = append;
      cryptoObjects.add(lifecycle.cryptoObjectId);
      await admin.unsafe(
        `INSERT INTO crypto_objects (
           object_id, payload_hash, payload_bytes
         ) VALUES ($1, $2, $3)`,
        [
          lifecycle.cryptoObjectId,
          digest(0x42),
          new Uint8Array([0x01]),
        ],
      );

      expect(await store.markCryptoComplete({
        sessionId: fixture.sessionId,
        messageId: lifecycle.messageId,
        revision: 0,
        cryptoObjectId: lifecycle.cryptoObjectId,
        parityStatus: "server_verified",
        leaseToken: null,
      })).toBe("applied");
      expect(await store.compareAndSwapCryptoMapping({
        sessionId: fixture.sessionId,
        messageId: lifecycle.messageId,
        revision: 0,
        expectedNamespaceId: fixture.namespaceId,
        cryptoObjectId: lifecycle.cryptoObjectId,
        leaseToken: null,
      })).toBe("applied");
      expect(await store.getRevision(lifecycle.messageId, 0)).toMatchObject({
        message: { cryptoObjectId: lifecycle.cryptoObjectId },
        lifecycle: {
          completion: "complete",
          disposition: "mapped",
          parityStatus: "server_verified",
        },
      });

      const editInput = {
        messageId: lifecycle.messageId,
        operationId: `edit-${randomUUID()}`,
        expectedRevision: 0,
        content: "edited plaintext shadow",
        subthreadReplyClassification: "counted" as const,
        requestDigest: digest(0x43),
      };
      expect(await store.editAllocated(editInput)).toMatchObject({
        status: "allocated",
        lifecycles: [{ revision: 1, disposition: "active" }],
      });
      expect(await store.editAllocated(editInput)).toMatchObject({
        status: "replayed",
        lifecycles: [{ revision: 1 }],
      });

      const deleteInput = {
        messageId: lifecycle.messageId,
        operationId: `delete-${randomUUID()}`,
        expectedRevision: 1,
        requestDigest: digest(0x44),
      };
      expect(await store.hardDelete(deleteInput)).toMatchObject({
        status: "deleted",
        lifecycle: { revision: 1, disposition: "hard_delete" },
      });
      expect(await store.hardDelete(deleteInput)).toMatchObject({
        status: "replayed",
        lifecycle: { revision: 1, disposition: "hard_delete" },
      });
      const rows = await admin.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count
           FROM session_messages
          WHERE session_id = $1`,
        [fixture.sessionId],
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await client.end();
    }
  });

  test("allocates, completes, and replays every physical Human edit sibling", async () => {
    const fixture = await createFixture();
    const siblingSessionId = randomUUID();
    const client = sqlClient(appUrl);
    try {
      await admin.unsafe(
        `INSERT INTO sessions (
           id, thread_id, owner_id, persona_id, agent_id, room_id, channel
         ) VALUES ($1, $2, $3, 'owner', $4, $5, 'integration')`,
        [
          siblingSessionId,
          `conversation:${siblingSessionId}`,
          fixture.requesterId,
          fixture.agentId,
          fixture.roomId,
        ],
      );
      const store = await productStore(client);
      const fingerprint = `human-sibling-${randomUUID()}`;
      const appendInput = {
        ...canonicalAppendFacts,
        content: "Human logical turn",
        keyClass: "human" as const,
        authorRole: "user" as const,
        fingerprint,
      };
      const first = await store.appendAllocated({
        ...appendInput,
        sessionId: fixture.sessionId,
        idempotencyKey: `human-first-${randomUUID()}`,
        requestDigest: digest(0x45),
      });
      const sibling = await store.appendAllocated({
        ...appendInput,
        sessionId: siblingSessionId,
        idempotencyKey: `human-sibling-${randomUUID()}`,
        requestDigest: digest(0x46),
      });
      if (first.status === "conflict" || sibling.status === "conflict") {
        throw new Error("Unexpected Human append conflict");
      }

      const editInput = {
        messageId: first.lifecycle.messageId,
        operationId: `human-group-edit-${randomUUID()}`,
        expectedRevision: 0,
        content: "Edited Human logical turn",
        subthreadReplyClassification: "counted" as const,
        requestDigest: digest(0x47),
      };
      const edited = await store.editAllocated(editInput);
      expect(edited).toMatchObject({ status: "allocated" });
      if (!("lifecycles" in edited)) {
        throw new Error("Human logical edit omitted its allocations");
      }
      expect(edited.lifecycles.map(({ messageId }) => messageId)).toEqual([
        first.lifecycle.messageId,
        sibling.lifecycle.messageId,
      ].sort((left, right) => left - right));
      for (const lifecycle of edited.lifecycles) {
        cryptoObjects.add(lifecycle.cryptoObjectId);
        await admin.unsafe(
          `INSERT INTO crypto_objects (
             object_id, payload_hash, payload_bytes
           ) VALUES ($1, $2, $3)`,
          [lifecycle.cryptoObjectId, digest(0x48), new Uint8Array([0x03])],
        );
        expect(await store.markCryptoComplete({
          sessionId: lifecycle.sessionId,
          messageId: lifecycle.messageId,
          revision: lifecycle.revision,
          cryptoObjectId: lifecycle.cryptoObjectId,
          parityStatus: "client_verified",
          leaseToken: null,
        })).toBe("applied");
        expect(await store.compareAndSwapCryptoMapping({
          sessionId: lifecycle.sessionId,
          messageId: lifecycle.messageId,
          revision: lifecycle.revision,
          expectedNamespaceId: fixture.namespaceId,
          cryptoObjectId: lifecycle.cryptoObjectId,
          leaseToken: null,
        })).toBe("applied");
      }

      const replay = await store.editAllocated(editInput);
      expect(replay).toMatchObject({ status: "replayed" });
      if (!("lifecycles" in replay)) {
        throw new Error("Human edit replay omitted its allocations");
      }
      expect(replay.lifecycles).toHaveLength(2);
      expect(replay.lifecycles.every(
        ({ completion, disposition }) =>
          completion === "complete" && disposition === "mapped",
      )).toBe(true);
    } finally {
      await admin.unsafe(
        `DELETE FROM session_messages WHERE session_id = $1`,
        [siblingSessionId],
      );
      await admin.unsafe(
        `DELETE FROM sessions WHERE id = $1`,
        [siblingSessionId],
      );
      await client.end();
    }
  });

  test("publishes an exact two-target Full Human edit atomically and replays it", async () => {
    const fixture = await createFixture();
    const siblingSessionId = randomUUID();
    const client = sqlClient(appUrl);
    const policyDb = drizzle(admin) as Parameters<typeof compareAndSwapEncryptionTransitionPolicy>[0];
    const fixtureDb = drizzle(admin);
    let fullPolicyRevision: number | null = null;
    try {
      await fixtureDb.insert(sessions).values({
        id: siblingSessionId,
        threadId: `conversation:${siblingSessionId}`,
        ownerId: fixture.requesterId,
        personaId: "owner",
        agentId: fixture.agentId,
        roomId: fixture.roomId,
        channel: "integration",
      });
      const store = await productStore(client);
      const fingerprint = `full-human-edit-${randomUUID()}`;
      const append = async (sessionId: string, fill: number) => {
        const [reservation] = await admin<{ message_id: number }[]>`
          SELECT nextval(
            pg_get_serial_sequence('session_messages', 'id')
          )::integer AS message_id
        `;
        if (reservation === undefined) throw new Error("Missing Message reservation");
        const originOperationId = `full-edit-origin-${randomUUID()}`;
        const createdAt = new Date();
        const originCryptoObjectId = deriveLiveShadowMessageCryptoObjectIdV1({
          operationId: originOperationId,
          sessionId,
          messageId: reservation.message_id,
          revision: 0,
          transcriptOrdinal: 1,
          authorRole: "user",
        });
        cryptoObjects.add(originCryptoObjectId);
        await fixtureDb.insert(cryptoObjectsTable).values({
          objectId: originCryptoObjectId,
          payloadHash: digest(fill + 1),
          payloadBytes: new Uint8Array([fill]),
        });
        await fixtureDb.insert(conversationHumanPeerShadowOperations).values({
          operationId: originOperationId,
          clientIdempotencyKey: `full-edit-origin-request-${randomUUID()}`,
          policyRevision: 1,
          sessionId,
          roomId: fixture.roomId,
          humanMessageId: reservation.message_id,
          humanMessageCreatedAt: createdAt,
          transcriptOrdinal: 1,
          subjectHumanId: fixture.humanActorId,
          committerDeviceId: `full-edit-device-${fill}`,
          committerDeviceSigningKeyGeneration: 0,
          hostAuthorizationRevision: 0,
          namespaceId: fixture.namespaceId,
          namespaceAccessRevision: 0,
          namespaceKeyGeneration: 0,
          namespaceHeadDigest: digest(fill + 2),
          namespacePublicationDigest: digest(fill + 3),
          namespacePublicationSetDigest: digest(fill + 4),
          namespaceAudienceFingerprint: digest(fill + 5),
          cryptoObjectId: originCryptoObjectId,
          attemptCoordinate: `full-edit-origin-attempt-${randomUUID()}`,
          planDigest: digest(fill + 6),
          planBytes: new Uint8Array([fill + 1]),
          deadlineAt: new Date(createdAt.getTime() + 60_000),
          createdAt,
          updatedAt: createdAt,
        });
        const result = await store.appendAllocated({
          ...canonicalAppendFacts,
          sessionId,
          idempotencyKey: `full-edit-source-${randomUUID()}`,
          content: "ordinary sibling that Full must clear",
          keyClass: "human",
          authorRole: "user",
          humanTurnId: originOperationId,
          fingerprint,
          requestDigest: digest(fill),
          humanPeerLiveShadow: {
            operationId: originOperationId,
            reservedMessageId: reservation.message_id,
            createdAt: createdAt.getTime(),
            transcriptOrdinal: 1,
            cryptoObjectId: originCryptoObjectId,
            planDigest: digest(fill + 6),
            planBytes: new Uint8Array([fill + 1]),
            requestBytes: new Uint8Array([fill + 2]),
          },
        });
        if (result.status === "conflict") throw new Error("Unexpected append conflict");
        expect(await store.markCryptoComplete({
          sessionId, messageId: result.lifecycle.messageId, revision: 0,
          cryptoObjectId: result.lifecycle.cryptoObjectId,
          parityStatus: "client_verified", leaseToken: null,
        })).toBe("applied");
        expect(await store.compareAndSwapCryptoMapping({
          sessionId, messageId: result.lifecycle.messageId, revision: 0,
          expectedNamespaceId: fixture.namespaceId,
          cryptoObjectId: result.lifecycle.cryptoObjectId, leaseToken: null,
        })).toBe("applied");
        return result.lifecycle;
      };
      const first = await append(fixture.sessionId, 0x61);
      const second = await append(siblingSessionId, 0x63);
      const currentPolicy = await getEncryptionTransitionPolicy(policyDb);
      const full = await compareAndSwapEncryptionTransitionPolicy(policyDb, {
        expectedRevision: currentPolicy.revision,
        targetMode: "encrypted_only",
        targetShadowBehavior: currentPolicy.shadowBehavior,
      });
      fullPolicyRevision = full.revision;
      const [roomAuthority] = await fixtureDb.select({
        namespace_access_revision: rooms.namespaceAccessRevision,
        human_actor_ids: rooms.humanActorIds,
      }).from(rooms).where(eq(rooms.id, fixture.roomId));
      if (roomAuthority === undefined) throw new Error("Missing Full edit Room authority");
      const operationId = `human-edit:v1:${randomUUID()}`;
      const targetsForOperation = (candidateOperationId: string, revision: number) =>
        [first, second].map((lifecycle) => ({
        sessionId: lifecycle.sessionId,
        messageId: lifecycle.messageId,
        namespaceId: fixture.namespaceId,
        cryptoObjectId: deriveHumanMessageEditCryptoObjectIdV1({
          operationId: candidateOperationId,
          sessionId: lifecycle.sessionId, messageId: lifecycle.messageId, revision,
        }),
        keyClass: "human" as const,
        namespaceAccessRevision: Number(roomAuthority.namespace_access_revision),
        namespaceKeyGeneration: 0,
        namespaceAudienceFingerprint: fingerprintNamespaceGenerationAudience([
          ...roomAuthority.human_actor_ids.map(humanId).sort(),
        ]),
      }));
      const targets = targetsForOperation(operationId, 1);
      for (const [index, target] of targets.entries()) {
        cryptoObjects.add(target.cryptoObjectId);
        await fixtureDb.insert(cryptoObjectsTable).values({
          objectId: target.cryptoObjectId,
          payloadHash: digest(0x70 + index),
          payloadBytes: new Uint8Array([0x70 + index]),
        });
      }
      const request = {
        messageId: first.messageId, operationId, expectedRevision: 0,
        requestDigest: digest(0x65), policyRevision: full.revision, targets,
        lockCryptoAuthority: () => Promise.resolve(),
      };
      expect(store.publishProtectedEdit({
        ...request,
        operationId,
        targets: targets.map((target) => ({
          ...target, namespaceAccessRevision: target.namespaceAccessRevision + 1,
        })),
      })).rejects.toThrow(/Namespace authority is stale/i);
      const beforePublish = await fixtureDb.select({
        edit_revision: sessionMessages.editRevision,
      }).from(sessionMessages).where(inArray(
        sessionMessages.id, [first.messageId, second.messageId],
      ));
      expect(beforePublish.every((row) => row.edit_revision === 0)).toBe(true);
      const published = await store.publishProtectedEdit(request);
      expect(published).toMatchObject({
        status: "allocated", lifecycles: [{ revision: 1 }, { revision: 1 }],
        committedProjection: { logicalMessageKey: `turn:${fingerprint}` },
      });
      const rows = await fixtureDb.select({
        id: sessionMessages.id,
        content: sessionMessages.content,
        tool_calls: sessionMessages.toolCalls,
        tool_name: sessionMessages.toolName,
        edit_revision: sessionMessages.editRevision,
        crypto_object_id: sessionMessages.cryptoObjectId,
      }).from(sessionMessages).where(inArray(
        sessionMessages.id, [first.messageId, second.messageId],
      )).orderBy(sessionMessages.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.content === null && row.tool_calls === null
        && row.tool_name === null && row.edit_revision === 1)).toBe(true);
      expect(new Set(rows.map((row) => row.crypto_object_id))).toEqual(
        new Set(targets.map((target) => target.cryptoObjectId)),
      );
      expect(await store.publishProtectedEdit(request)).toMatchObject({
        status: "replayed",
        committedProjection: { logicalMessageKey: `turn:${fingerprint}` },
      });

      const losingOperationId = `human-edit:v1:${randomUUID()}`;
      const losingTargets = targetsForOperation(losingOperationId, 2);
      for (const [index, target] of losingTargets.entries()) {
        cryptoObjects.add(target.cryptoObjectId);
        await fixtureDb.insert(cryptoObjectsTable).values({
          objectId: target.cryptoObjectId,
          payloadHash: digest(0x78 + index),
          payloadBytes: new Uint8Array([0x78 + index]),
        });
      }
      const conflict = await store.publishProtectedEdit({
        ...request, operationId: losingOperationId,
        requestDigest: digest(0x66), expectedRevision: 1,
        targets: losingTargets.slice(0, 1),
      });
      expect(conflict).toEqual({ status: "conflict" });
      const unchanged = await fixtureDb.select({
        id: sessionMessages.id,
        edit_revision: sessionMessages.editRevision,
      }).from(sessionMessages).where(inArray(
        sessionMessages.id, [first.messageId, second.messageId],
      )).orderBy(sessionMessages.id);
      expect(unchanged.every((row) => row.edit_revision === 1)).toBe(true);

      const winningOperationId = `human-edit:v1:${randomUUID()}`;
      const winningTargets = targetsForOperation(winningOperationId, 2);
      const competingOperationId = `human-edit:v1:${randomUUID()}`;
      const competingTargets = targetsForOperation(competingOperationId, 2);
      for (const [index, target] of [...winningTargets, ...competingTargets].entries()) {
        cryptoObjects.add(target.cryptoObjectId);
        await fixtureDb.insert(cryptoObjectsTable).values({
          objectId: target.cryptoObjectId,
          payloadHash: digest(0x7a + index),
          payloadBytes: new Uint8Array([0x7a + index]),
        });
      }
      const winningRequest = {
        ...request,
        operationId: winningOperationId,
        expectedRevision: 1,
        requestDigest: digest(0x68),
        targets: winningTargets,
      };
      const competingRequest = {
        ...request,
        operationId: competingOperationId,
        expectedRevision: 1,
        requestDigest: digest(0x69),
        targets: competingTargets,
      };
      const concurrentResults = await Promise.all([
        store.publishProtectedEdit(winningRequest),
        store.publishProtectedEdit(competingRequest),
      ]);
      expect(concurrentResults.filter((result) => result.status === "allocated")).toHaveLength(1);
      expect(concurrentResults.filter((result) =>
        result.status === "stale" || result.status === "conflict"
      )).toHaveLength(1);
      const acceptedRequest = concurrentResults[0]?.status === "allocated"
        ? winningRequest
        : competingRequest;
      expect(await store.publishProtectedEdit(acceptedRequest)).toMatchObject({ status: "replayed" });

      const beforeStale = await getEncryptionTransitionPolicy(policyDb);
      await compareAndSwapEncryptionTransitionPolicy(policyDb, {
        expectedRevision: beforeStale.revision,
        targetMode: "shadow_encryption", targetShadowBehavior: "fallback",
      });
      const staleOperationId = `human-edit:v1:${randomUUID()}`;
      expect(store.publishProtectedEdit({
        ...request, operationId: staleOperationId,
        expectedRevision: 2, requestDigest: digest(0x67),
        targets: targetsForOperation(staleOperationId, 3),
      })).rejects.toThrow(/policy revision .* stale/i);
    } finally {
      if (fullPolicyRevision !== null) {
        const current = await getEncryptionTransitionPolicy(policyDb);
        if (current.mode !== "shadow_encryption") {
          await compareAndSwapEncryptionTransitionPolicy(policyDb, {
            expectedRevision: current.revision,
            targetMode: "shadow_encryption", targetShadowBehavior: "fallback",
          });
        }
      }
      await fixtureDb.delete(sessionMessages).where(eq(sessionMessages.sessionId, siblingSessionId));
      await fixtureDb.delete(sessions).where(eq(sessions.id, siblingSessionId));
      await client.end();
    }
  });

  test("rejects protected Subthread and reply anchors from another Room", async () => {
    const fixture = await createFixture();
    const other = await createFixture();
    const client = sqlClient(appUrl);
    try {
      const [otherMessage] = await admin.unsafe<{ id: number }[]>(
        `INSERT INTO session_messages (session_id, role, content)
         VALUES ($1, 'user', 'foreign reply target')
         RETURNING id`,
        [other.sessionId],
      );
      if (otherMessage === undefined) throw new Error("Foreign reply target");
      const store = await productStore(client);
      expect(
        (await rejectedError(store.appendAllocated({
          ...canonicalAppendFacts,
          sessionId: fixture.sessionId,
          idempotencyKey: `foreign-subthread-${randomUUID()}`,
          content: "must not cross the Room",
          keyClass: "ai",
          authorRole: "assistant",
          subthreadRoomId: other.roomId,
          requestDigest: digest(0x49),
        }))).message,
      ).toMatch(/Subthread does not belong/i);
      expect(
        (await rejectedError(store.appendAllocated({
          ...canonicalAppendFacts,
          sessionId: fixture.sessionId,
          idempotencyKey: `foreign-reply-${randomUUID()}`,
          content: "must not quote across the Room",
          keyClass: "ai",
          authorRole: "assistant",
          replyToMessageId: otherMessage.id,
          requestDigest: digest(0x4a),
        }))).message,
      ).toMatch(/reply target is outside/i);

      const [counts] = await admin.unsafe<{
        message_count: string;
        lifecycle_count: string;
      }[]>(
        `SELECT
           (
             SELECT count(*)::text
               FROM session_messages
              WHERE session_id = $1
           ) AS message_count,
           (
             SELECT count(*)::text
               FROM session_message_crypto_revisions
              WHERE session_id = $1
           ) AS lifecycle_count`,
        [fixture.sessionId],
      );
      expect(counts).toEqual({
        message_count: "0",
        lifecycle_count: "0",
      });
    } finally {
      await client.end();
    }
  });

  test("admits only the member Agent even beside a valid Human Room member", async () => {
    const fixture = await createFixture();
    const foreign = await createFixture();
    const memberClient = sqlClient(agentUrl);
    const outsiderClient = sqlClient(agentUrl);
    const sameRoomAgentClient = sqlClient(agentUrl);
    const sameRoomAgentId = randomUUID();
    const sameRoomAgentActorId = randomUUID();
    try {
      const memberContext = {
        userId: fixture.requesterId,
        agentId: fixture.agentId,
      };
      const member = await productStore(memberClient, memberContext);
      const allocation = await member.appendAllocated({
        ...canonicalAppendFacts,
        sessionId: fixture.sessionId,
        idempotencyKey: `agent-${randomUUID()}`,
        content: "agent-authored shadow",
        keyClass: "ai",
        authorRole: "assistant",
        requestDigest: digest(0x51),
      });
      expect(allocation).toMatchObject({ status: "allocated" });
      if (allocation.status === "conflict") {
        throw new Error("Unexpected member append conflict");
      }
      await admin.unsafe(
        `INSERT INTO agents (id, handle)
         VALUES ($1, $2)`,
        [sameRoomAgentId, `conversation-other-${sameRoomAgentId}`],
      );
      await admin.unsafe(
        `INSERT INTO actors (
           id, owner_id, display_name, trust_state, kind, agent_id
         ) VALUES (
           $1, $2, 'Other same-Room Agent', 'verified', 'agent', $3
         )`,
        [sameRoomAgentActorId, fixture.requesterId, sameRoomAgentId],
      );
      await admin.unsafe(
        `INSERT INTO room_members (
           room_id, actor_id, room_role, agent_response_mode
         ) VALUES ($1, $2, 'member', 'active')`,
        [fixture.roomId, sameRoomAgentActorId],
      );
      const sameRoomAgent = await productStore(sameRoomAgentClient, {
        userId: fixture.requesterId,
        agentId: sameRoomAgentId,
      });
      expect(
        rejectedError(sameRoomAgent.appendAllocated({
          ...canonicalAppendFacts,
          sessionId: fixture.sessionId,
          idempotencyKey: `wrong-session-agent-${randomUUID()}`,
          content: "same Room is not the same Session Agent",
          keyClass: "ai",
          authorRole: "assistant",
          requestDigest: digest(0x50),
        })),
      ).resolves.toBeInstanceOf(Error);
      const mismatchedSessionObjectId =
        `message:v2:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`;
      const mismatchedSessionResult = await memberClient.begin(
        async (transaction) => {
          await transaction.unsafe(
            `SELECT set_config('app.current_user_id', $1, true),
                    set_config('app.current_agent_id', $2, true)`,
            [memberContext.userId, memberContext.agentId],
          );
          await transaction.unsafe(
            `INSERT INTO session_message_crypto_revisions (
               session_id, message_id, edit_revision, room_id,
               namespace_id_at_allocation, crypto_object_id,
               payload_version, key_class, author_role,
               append_idempotency_key, allocation_request_digest,
               repair_identity_digest,
               completion, disposition, parity_status, attempt_count,
               next_attempt_at
             ) VALUES (
               $1, $2, 0, $3, $4, $5, 2, 'ai', 'user', $6, $7, $8,
               'pending', 'active', 'pending', 0, CURRENT_TIMESTAMP
             )`,
            [
              foreign.sessionId,
              2_000_000 + Math.floor(Math.random() * 1_000_000),
              fixture.roomId,
              fixture.namespaceId,
              mismatchedSessionObjectId,
              `mismatched-session-room-${randomUUID()}`,
              digest(0x58),
              digest(0x59),
            ],
          );
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      // A repair identity permits Hive-Mind repair of another Agent's Message;
      // it must never let the caller relabel an unrelated Session as a Room it
      // can access. Clean defensively so this test also fails legibly against
      // a schema missing the session↔Room policy predicate.
      await admin.unsafe(
        `DELETE FROM session_message_crypto_revisions
          WHERE crypto_object_id = $1`,
        [mismatchedSessionObjectId],
      );
      expect(mismatchedSessionResult).toBeInstanceOf(Error);
      for (const forbidden of [
        { keyClass: "human", authorRole: "assistant", parity: "pending" },
        { keyClass: "ai", authorRole: "user", parity: "pending" },
        {
          keyClass: "ai",
          authorRole: "assistant",
          parity: "client_verified",
        },
      ] as const) {
        expect(
          rejectedError(memberClient.begin(async (transaction) => {
            await transaction.unsafe(
              `SELECT set_config('app.current_user_id', $1, true),
                      set_config('app.current_agent_id', $2, true)`,
              [memberContext.userId, memberContext.agentId],
            );
            await transaction.unsafe(
              `INSERT INTO session_message_crypto_revisions (
                 session_id, message_id, edit_revision, room_id,
                 namespace_id_at_allocation, crypto_object_id,
                 payload_version, key_class, author_role,
                 append_idempotency_key, allocation_request_digest,
                 completion, disposition, parity_status, attempt_count,
                 next_attempt_at, crypto_completed_at
               ) VALUES (
                 $1, $2, 0, $3, $4, $5, 2, $6, $7, $8, $9,
                 $10, 'active', $11, 0, CURRENT_TIMESTAMP, $12
               )`,
              [
                fixture.sessionId,
                1_000_000 + Math.floor(Math.random() * 1_000_000),
                fixture.roomId,
                fixture.namespaceId,
                `message:v2:${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
                forbidden.keyClass,
                forbidden.authorRole,
                `direct-${randomUUID()}`,
                digest(0x5a),
                forbidden.parity === "client_verified"
                  ? "complete"
                  : "pending",
                forbidden.parity,
                forbidden.parity === "client_verified" ? new Date() : null,
              ],
            );
          }) as unknown as Promise<unknown>),
        ).resolves.toBeInstanceOf(Error);
      }

      const outsider = await productStore(outsiderClient, {
        // The Human branch is valid; the unrelated Agent branch must still
        // fail rather than borrowing the Human's Room membership.
        userId: fixture.ownerId,
        agentId: randomUUID(),
      });
      expect(
        (await rejectedError(outsider.appendAllocated({
          ...canonicalAppendFacts,
          sessionId: fixture.sessionId,
          idempotencyKey: `outsider-${randomUUID()}`,
          content: "must remain invisible",
          keyClass: "ai",
          authorRole: "assistant",
          requestDigest: digest(0x52),
        }))).message,
      ).toBeTruthy();
      expect(
        await outsider.getRevision(allocation.lifecycle.messageId, 0),
      ).toBeNull();
      expect(
        rejectedError(outsider.editAllocated({
          messageId: allocation.lifecycle.messageId,
          operationId: `outsider-edit-${randomUUID()}`,
          expectedRevision: 0,
          content: "must remain invisible",
          subthreadReplyClassification: "counted",
          requestDigest: digest(0x53),
        })),
      ).resolves.toBeInstanceOf(Error);
      expect(await outsider.hardDelete({
        messageId: allocation.lifecycle.messageId,
        operationId: `outsider-delete-${randomUUID()}`,
        expectedRevision: 0,
        requestDigest: digest(0x54),
      })).toEqual({ status: "missing" });
      const unchanged = await admin.unsafe<{ content: string }[]>(
        `SELECT content
           FROM session_messages
          WHERE id = $1`,
        [allocation.lifecycle.messageId],
      );
      expect(Array.from(unchanged)).toEqual([
        { content: "agent-authored shadow" },
      ]);
    } finally {
      await admin.unsafe(
        `DELETE FROM room_members WHERE actor_id = $1`,
        [sameRoomAgentActorId],
      );
      await admin.unsafe(
        `DELETE FROM actors WHERE id = $1`,
        [sameRoomAgentActorId],
      );
      await admin.unsafe(
        `DELETE FROM agents WHERE id = $1`,
        [sameRoomAgentId],
      );
      await Promise.all([
        memberClient.end(),
        outsiderClient.end(),
        sameRoomAgentClient.end(),
      ]);
    }
  });

  test("concurrent mapping with edit or delete follows one message-then-lifecycle lock order", async () => {
    const client = sqlClient(appUrl, 12);
    try {
      for (const mutation of ["edit", "delete"] as const) {
        const fixture = await createFixture();
        const store = await productStore(client);
        const append = await store.appendAllocated({
          ...canonicalAppendFacts,
          sessionId: fixture.sessionId,
          idempotencyKey: `lock-order-${mutation}-${randomUUID()}`,
          content: `lock order ${mutation}`,
          keyClass: "ai",
          authorRole: "assistant",
          requestDigest: digest(mutation === "edit" ? 0x71 : 0x72),
        });
        if (append.status === "conflict") {
          throw new Error("Unexpected lock-order append conflict");
        }
        const lifecycle = append.lifecycle;
        cryptoObjects.add(lifecycle.cryptoObjectId);
        await admin.unsafe(
          `INSERT INTO crypto_objects (
             object_id, payload_hash, payload_bytes
           ) VALUES ($1, $2, $3)`,
          [
            lifecycle.cryptoObjectId,
            digest(0x73),
            new Uint8Array([0x02]),
          ],
        );
        expect(await store.markCryptoComplete({
          sessionId: fixture.sessionId,
          messageId: lifecycle.messageId,
          revision: 0,
          cryptoObjectId: lifecycle.cryptoObjectId,
          parityStatus: "server_verified",
          leaseToken: null,
        })).toBe("applied");

        const mapping = store.compareAndSwapCryptoMapping({
          sessionId: fixture.sessionId,
          messageId: lifecycle.messageId,
          revision: 0,
          expectedNamespaceId: fixture.namespaceId,
          cryptoObjectId: lifecycle.cryptoObjectId,
          leaseToken: null,
        });
        const terminal = mutation === "edit"
          ? store.editAllocated({
            messageId: lifecycle.messageId,
            operationId: `lock-edit-${randomUUID()}`,
            expectedRevision: 0,
            content: "edited after the lock race",
            subthreadReplyClassification: "counted",
            requestDigest: digest(0x74),
          })
          : store.hardDelete({
            messageId: lifecycle.messageId,
            operationId: `lock-delete-${randomUUID()}`,
            expectedRevision: 0,
            requestDigest: digest(0x75),
          });

        const [mappingResult, terminalResult] = await Promise.all([
          mapping,
          terminal,
        ]);
        expect(["applied", "stale", "missing"]).toContain(mappingResult);
        if (mutation === "edit") {
          expect(terminalResult).toMatchObject({
            status: "allocated",
            lifecycles: [{ revision: 1 }],
          });
          expect(
            await store.getRevision(lifecycle.messageId, 0),
          ).toMatchObject({
            message: null,
            lifecycle: { disposition: "superseded" },
          });
        } else {
          expect(terminalResult).toMatchObject({
            status: "deleted",
            lifecycle: { disposition: "hard_delete" },
          });
          expect(
            await store.getRevision(lifecycle.messageId, 0),
          ).toMatchObject({
            message: null,
            lifecycle: { disposition: "hard_delete" },
          });
        }
      }
    } finally {
      await client.end();
    }
  });

  test("claims due rows once with SKIP LOCKED and applies bounded retry state", async () => {
    const fixture = await createFixture();
    const client = sqlClient(appUrl);
    try {
      const store = await productStore(client);
      const allocations = [];
      for (let index = 0; index < 3; index += 1) {
        const allocation = await store.appendAllocated({
          ...canonicalAppendFacts,
          sessionId: fixture.sessionId,
          idempotencyKey: `claim-${index}-${randomUUID()}`,
          content: `claim candidate ${index}`,
          keyClass: "ai",
          authorRole: "assistant",
          requestDigest: digest(0x61 + index),
        });
        if (allocation.status !== "allocated") {
          throw new Error(`Unexpected append status: ${allocation.status}`);
        }
        allocations.push(allocation.lifecycle);
      }
      const leaseToken = randomUUID();
      const claimed = await store.claimReconciliationCandidates({
        leaseToken,
        limit: 2,
      });
      expect(claimed.map(({ lifecycle }) => lifecycle.messageId)).toEqual(
        allocations.slice(0, 2).map(({ messageId }) => messageId),
      );

      const first = claimed[0];
      if (first === undefined) throw new Error("Expected a claimed revision");
      expect(await store.failReconciliationClaim({
        sessionId: first.lifecycle.sessionId,
        messageId: first.lifecycle.messageId,
        revision: first.lifecycle.revision,
        leaseToken,
        failureCode: "storage_transient",
      })).toMatchObject({
        attemptCount: 1,
        disposition: "active",
        failureCode: "storage_transient",
      });
      const secondClaim = await store.claimReconciliationCandidates({
        leaseToken: randomUUID(),
        limit: 3,
      });
      const third = allocations[2];
      if (third === undefined) throw new Error("Expected a third allocation");
      expect(secondClaim.map(({ lifecycle }) => lifecycle.messageId)).toEqual([
        third.messageId,
      ]);
    } finally {
      await client.end();
    }
  });

  test("loads and restores a Full-origin Message through the current Agent in Shadow", async () => {
    const fixture = await createFixture();
    const agentClient = sqlClient(agentUrl);
    const adminDb = drizzle(admin);
    const [originalPolicy] = await adminDb.select({
      mode: encryptionTransitionPolicy.mode,
      revision: encryptionTransitionPolicy.revision,
      shadowBehavior: encryptionTransitionPolicy.shadowBehavior,
      shadowEncryptionStartedAt:
        encryptionTransitionPolicy.shadowEncryptionStartedAt,
    }).from(encryptionTransitionPolicy).where(
      eq(encryptionTransitionPolicy.id, "server"),
    );
    if (originalPolicy === undefined) throw new Error("Missing transition policy");
    const cryptoObjectId = `message:v2:${
      randomUUID().replaceAll("-", "").padEnd(64, "0")
    }`;
    cryptoObjects.add(cryptoObjectId);
    try {
      const [policy] = await adminDb.update(encryptionTransitionPolicy).set({
        mode: "shadow_encryption",
        revision: sql`${encryptionTransitionPolicy.revision} + 1`,
        shadowEncryptionStartedAt:
          sql`coalesce(${encryptionTransitionPolicy.shadowEncryptionStartedAt}, CURRENT_TIMESTAMP)`,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server")).returning({
        revision: encryptionTransitionPolicy.revision,
      });
      if (policy === undefined) throw new Error("Missing updated policy");
      const createdAt = new Date("2027-01-15T08:00:00.000Z");
      const repairIdentityDigest = digest(0xb1);
      const attestationDigest = digest(0xb2);
      const [roomAuthority] = await adminDb.select({
        namespaceAccessRevision: rooms.namespaceAccessRevision,
      }).from(rooms).where(eq(rooms.id, fixture.roomId));
      if (roomAuthority === undefined) throw new Error("Missing Room authority");
      const namespaceAccessRevision = roomAuthority.namespaceAccessRevision;
      const [message] = await adminDb.transaction(async (transaction) => {
        const domainId = `domain:${fixture.namespaceId}`;
        const bindingOperationId = `binding:${fixture.namespaceId}`;
        const domainHeadDigest = digest(0xa1);
        const retainedAuthoritySetDigest = digest(0xa2);
        const bindingDigest = digest(0xa3);
        const now = new Date();
        await transaction.insert(namespaceDomainKeyBindings).values({
          operationId: bindingOperationId, idempotencyKey: bindingOperationId,
          namespaceId: fixture.namespaceId, domainId, keyClass: "ai",
          domainKeyGeneration: 1, domainAuthorizationRevision: 1,
          domainHeadDigest, namespaceAccessRevision, namespaceCurrentGeneration: 1,
          bundleRevision: 1, retainedGenerationCount: 1,
          retainedAuthoritySetDigest, previousBindingDigest: null, bindingDigest,
          plaintextDigest: digest(0xa6), ciphertextDigest: digest(0xa7),
          bindingBytes: new Uint8Array([0x01]), issuerHumanId: fixture.humanActorId,
          issuerDeviceId: `device:${fixture.humanActorId}`,
          issuerDeviceSigningGeneration: 1, state: "active", createdAt: now,
          updatedAt: now, deadlineAt: new Date(now.getTime() + 3_600_000), activatedAt: now,
        });
        await transaction.insert(namespaceDomainKeyHeads).values({
          namespaceId: fixture.namespaceId, keyClass: "ai", domainId,
          domainKeyGeneration: 1, domainAuthorizationRevision: 1, domainHeadDigest,
          namespaceAccessRevision, namespaceCurrentGeneration: 1, bundleRevision: 1,
          retainedGenerationCount: 1, retainedAuthoritySetDigest, bindingDigest,
          bindingOperationId, activatedAt: now,
        });
        await transaction.insert(cryptoObjectsTable).values({
          objectId: cryptoObjectId, payloadHash: digest(0xa4),
          payloadBytes: new Uint8Array([0x01]),
        });
        const inserted = await transaction.insert(sessionMessages).values({
          sessionId: fixture.sessionId, role: "user", content: null,
          toolCalls: null, toolName: null, cryptoObjectId, createdAt, editRevision: 0,
        }).returning({ id: sessionMessages.id });
        const current = inserted[0];
        if (current === undefined) throw new Error("Missing inserted Message");
        await transaction.insert(sessionMessageCryptoRevisions).values({
          sessionId: fixture.sessionId, messageId: current.id, editRevision: 0,
          roomId: fixture.roomId, namespaceIdAtAllocation: fixture.namespaceId,
          cryptoObjectId, objectIdScheme: "message_v2", representationMode: "full_encryption",
          publicationPolicyRevision: policy.revision, payloadVersion: 2, keyClass: "ai",
          authorRole: "user", subthreadReplyClassification: "counted",
          appendIdempotencyKey: `full-human:${fixture.sessionId}:${current.id}`,
          allocationRequestDigest: digest(0xa5), completion: "complete",
          disposition: "mapped", parityStatus: "client_authenticated", attemptCount: 0,
          nextAttemptAt: null, cryptoCompletedAt: now,
        });
        return inserted;
      });
      if (message === undefined) throw new Error("Missing inserted Message");
      const mixedRows: Array<{
        id: number;
        role: "assistant" | "tool";
        cryptoObjectId: string;
      }> = await adminDb.transaction(async (transaction) => {
        const rows: Array<{
          id: number;
          role: "assistant" | "tool";
          cryptoObjectId: string;
        }> = [];
        for (const role of ["assistant", "tool", "assistant"] as const) {
          const objectId = `message:v2:${
            randomUUID().replaceAll("-", "").padEnd(64, "0")
          }`;
          cryptoObjects.add(objectId);
          await transaction.insert(cryptoObjectsTable).values({
            objectId,
            payloadHash: digest(0xc1 + rows.length),
            payloadBytes: new Uint8Array([0x01]),
          });
          const [inserted] = await transaction.insert(sessionMessages).values({
            sessionId: fixture.sessionId,
            role,
            content: null,
            toolCalls: null,
            toolName: null,
            cryptoObjectId: objectId,
            createdAt: new Date(createdAt.getTime() + rows.length + 1),
            editRevision: 0,
          }).returning({ id: sessionMessages.id });
          if (inserted === undefined) throw new Error("Missing mixed Message");
          await transaction.insert(sessionMessageCryptoRevisions).values({
            sessionId: fixture.sessionId,
            messageId: inserted.id,
            editRevision: 0,
            roomId: fixture.roomId,
            namespaceIdAtAllocation: fixture.namespaceId,
            cryptoObjectId: objectId,
            objectIdScheme: "message_v2",
            representationMode: "full_encryption",
            publicationPolicyRevision: policy.revision,
            payloadVersion: 2,
            keyClass: "ai",
            authorRole: role,
            subthreadReplyClassification: "counted",
            appendIdempotencyKey:
              `full-mixed:${fixture.sessionId}:${inserted.id}`,
            allocationRequestDigest: digest(0xd1 + rows.length),
            completion: "complete",
            disposition: "mapped",
            parityStatus: "server_authenticated",
            attemptCount: 0,
            nextAttemptAt: null,
            cryptoCompletedAt: new Date(),
          });
          rows.push({ id: inserted.id, role, cryptoObjectId: objectId });
        }
        return rows;
      });
      const store = await productStore(agentClient, {
        userId: fixture.requesterId,
        agentId: fixture.agentId,
      });
      const selected = await loadPostgresForegroundMessageRepairSources({
        product: await verifyConversationProductPostgresHandle(
          connection(agentClient, {
            userId: fixture.requesterId,
            agentId: fixture.agentId,
          }),
        ),
        readableNamespaceIds: [fixture.namespaceId],
        messageIds: [message.id, ...mixedRows.map((row) => row.id)],
        representationMode: "ordinary-and-protected",
      });
      expect(selected).toHaveLength(4);
      expect(selected[0]).toMatchObject({
        messageId: message.id,
        mappedCryptoObjectId: cryptoObjectId,
        payload: null,
      });
      for (let index = 0; index < mixedRows.length; index += 1) {
        const row = mixedRows[index]!;
        expect(selected[index + 1]).toMatchObject({
          messageId: row.id,
          authorRole: row.role,
          mappedCryptoObjectId: row.cryptoObjectId,
          payload: null,
        });
      }
      const request = {
        sessionId: fixture.sessionId,
        messageId: message.id,
        revision: 0,
        cryptoObjectId,
        expectedNamespaceId: fixture.namespaceId,
        expectedKeyClass: "ai" as const,
        expectedNamespaceAccessRevision: namespaceAccessRevision,
        expectedNamespaceKeyGeneration: 1,
        expectedAuthorRole: "user" as const,
        expectedCreatedAt: createdAt.getTime(),
        content: "restored Human message",
        toolCalls: null,
        toolName: null,
        authorityActorId: fixture.agentId,
        repairIdentityDigest,
        attestationDigest,
        publisher: {
          kind: "authenticated_runtime" as const,
          id: `runtime:${fixture.agentId}`,
        },
        publicationPolicy: {
          expectedRevision: policy.revision,
          representation: "ordinary_and_protected" as const,
        },
      };
      expect(await store.restoreOrdinaryExistingRepresentation(request))
        .toBe("applied");
      // The protected mapping was pre-existing, but this invocation performed
      // an ordinary reverse materialization. The foreground repairer therefore
      // reports this read as `repaired`, not `existing`; the durable lifecycle
      // itself remains unchanged below.
      expect(await store.restoreOrdinaryExistingRepresentation(request))
        .toBe("replayed");
      expect(await store.restoreOrdinaryExistingRepresentation({
        ...request,
        repairIdentityDigest: digest(0xb6),
        publisher: {
          ...request.publisher,
          id: `later-runtime:${fixture.agentId}`,
        },
      })).toBe("replayed");
      expect(await store.restoreOrdinaryExistingRepresentation({
        ...request,
        attestationDigest: digest(0xb3),
      })).toBe("replayed");
      expect(await store.restoreOrdinaryExistingRepresentation({
        ...request,
        content: "different ordinary bytes",
      })).toBe("conflict");
      // Independently authenticated publishers converge on the same ordinary
      // bytes without replacing the first restoration witness or upgrading
      // historical authentication into independent comparison evidence.
      const [retainedReceipt] = await adminDb.select()
        .from(sessionMessageOrdinaryRepairs)
        .where(eq(sessionMessageOrdinaryRepairs.messageId, message.id));
      expect(retainedReceipt).toBeDefined();
      expect(Array.from(retainedReceipt!.attestationDigest))
        .toEqual(Array.from(attestationDigest));
      expect(Array.from(retainedReceipt!.repairIdentityDigest))
        .toEqual(Array.from(repairIdentityDigest));
      const [retainedLifecycle] = await adminDb.select({
        cryptoObjectId: sessionMessageCryptoRevisions.cryptoObjectId,
        parityStatus: sessionMessageCryptoRevisions.parityStatus,
      }).from(sessionMessageCryptoRevisions)
        .where(eq(sessionMessageCryptoRevisions.messageId, message.id));
      expect(retainedLifecycle).toEqual({
        cryptoObjectId,
        parityStatus: "client_authenticated",
      });

      const agentConnection = canonicalConnection(agentClient, {
        userId: fixture.requesterId,
        agentId: fixture.agentId,
      });
      const deniedUpdate = agentConnection.transaction((transaction) =>
        transaction.update(sessionMessageOrdinaryRepairs).set({
          publisherId: "tampered",
        }).where(eq(sessionMessageOrdinaryRepairs.sessionId, fixture.sessionId))
          .returning({ messageId: sessionMessageOrdinaryRepairs.messageId }),
      { isolationLevel: "read committed" });
      expect((await rejectedError(deniedUpdate)).cause).toMatchObject({
        code: "42501",
      });
      const deniedDelete = agentConnection.transaction((transaction) =>
        transaction.delete(sessionMessageOrdinaryRepairs).where(
          eq(sessionMessageOrdinaryRepairs.sessionId, fixture.sessionId),
        ).returning({ messageId: sessionMessageOrdinaryRepairs.messageId }),
      { isolationLevel: "read committed" });
      expect((await rejectedError(deniedDelete)).cause).toMatchObject({
        code: "42501",
      });

      const deniedMapping = agentConnection.transaction((transaction) =>
        transaction.insert(sessionMessageOrdinaryRepairs).values({
          sessionId: fixture.sessionId, messageId: message.id, editRevision: 1,
          cryptoObjectId, expectedKeyClass: "ai", authorityActorId: fixture.agentId,
          repairIdentityDigest: digest(0xb4), attestationDigest: digest(0xb5),
          publisherKind: "authenticated_runtime", publisherId: `runtime:${fixture.agentId}`,
          policyRevision: policy.revision,
        }),
      { isolationLevel: "read committed" });
      expect(deniedMapping).rejects.toThrow();

      const requiredReceiptFields = [
        "repair_identity_digest",
        "attestation_digest",
        "publisher_kind",
        "publisher_id",
        "policy_revision",
      ] as const;
      const receiptEntries = [
        { column: "session_id", value: fixture.sessionId },
        { column: "message_id", value: message.id },
        { column: "edit_revision", value: 0 },
        { column: "crypto_object_id", value: cryptoObjectId },
        { column: "expected_key_class", value: "ai" },
        { column: "authority_actor_id", value: fixture.agentId },
        { column: "repair_identity_digest", value: digest(0xb1) },
        { column: "attestation_digest", value: digest(0xb2) },
        { column: "publisher_kind", value: "authenticated_runtime" },
        { column: "publisher_id", value: `runtime:${fixture.agentId}` },
        { column: "policy_revision", value: policy.revision },
      ] as const;
      for (const missing of requiredReceiptFields) {
        const retained = receiptEntries.flatMap((entry) =>
          entry.column === missing ? [] : [entry]
        );
        const placeholders = retained.map((_, index) => `$${index + 1}`);
        const insertion = admin.unsafe(
          `INSERT INTO session_message_ordinary_repairs (${
            retained.map(({ column }) => column).join(", ")
          }) VALUES (${placeholders.join(", ")})`,
          retained.map(({ value }) => value),
        );
        expect((await rejectedError(insertion)).message).toContain(missing);
      }
    } finally {
      await adminDb.update(encryptionTransitionPolicy).set({
        mode: originalPolicy.mode,
        revision: sql`${encryptionTransitionPolicy.revision} + 1`,
        shadowBehavior: originalPolicy.shadowBehavior,
        shadowEncryptionStartedAt: originalPolicy.shadowEncryptionStartedAt,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(encryptionTransitionPolicy.id, "server"));
      await agentClient.end();
    }
  });
});


test("pending Tool source resumes after predecessor edit without rewriting allocation audit or accepted evidence", async () => {
  const fixture = await createFixture();
  const client = sqlClient(appUrl);
  const db = drizzle(admin);
  try {
    const [message] = await db.insert(sessionMessages).values({sessionId: fixture.sessionId,
      role: "tool", content: "Tool result", toolName: "lookup"}).returning({id: sessionMessages.id});
    if (!message) throw new Error("Missing Tool fixture");
    const store = await productStore(client, {userId: fixture.ownerId, agentId: fixture.agentId});
    const input = {publisher: {kind: "human_device" as const, humanActorId: fixture.humanActorId},
      sessionId: fixture.sessionId, messageId: message.id, revision: 0,
      operationId: `repair:${randomUUID()}`, expectedNamespaceId: fixture.namespaceId,
      expectedKeyClass: "ai" as const, expectedAuthorRole: "tool" as const,
      expectedAuthorHumanTurnId: null, expectedSessionAgentId: fixture.agentId,
      requestDigest: digest(0xe1), repairIdentityDigest: digest(0xe2)};
    const allocated = await store.allocateExistingRepresentation(input);
    if (allocated.status !== "allocated") throw new Error(`Unexpected allocation ${allocated.status}`);
    const objectId = allocated.lifecycle.cryptoObjectId;
    // A real predecessor edit changes canonical Tool correlation without editing the target.
    const [predecessor] = await db.insert(sessionMessages).values({sessionId: fixture.sessionId,
      role: "assistant", content: "", toolCalls: JSON.stringify([{id: "original", name: "lookup", args: {}}]),
      createdAt: new Date(Date.now() - 60_000)}).returning({id: sessionMessages.id});
    if (!predecessor) throw new Error("Missing predecessor fixture");
    await db.update(sessionMessages).set({editRevision: 1,
      toolCalls: JSON.stringify([{id: "edited", name: "lookup", args: {}}])}).where(eq(sessionMessages.id, predecessor.id));
    const [source] = await db.select({revision: sessions.messageSourceRevision}).from(sessions).where(eq(sessions.id, fixture.sessionId));
    if (!source) throw new Error("Missing Session fixture");
    const [policy] = await db.select({revision: encryptionTransitionPolicy.revision}).from(encryptionTransitionPolicy);
    if (!policy) throw new Error("Missing policy fixture");
    const coordinates = {sessionId: fixture.sessionId, messageId: message.id, revision: 0, cryptoObjectId: objectId};
    expect(await store.withExistingRepresentationPublication({...coordinates,
      publicationPolicy: {expectedRevision: policy.revision, representation: "ordinary_and_protected"},
      use: async current => {
        const objects = await db.select({id: cryptoObjectsTable.objectId}).from(cryptoObjectsTable).where(eq(cryptoObjectsTable.objectId, objectId));
        expect(objects).toHaveLength(0);
        return current.refreshPendingToolRepairSource({...coordinates, sourceRevision: source.revision, sourceDigest: digest(0xe3)});
      },
    })).toBe("refreshed");
    const replayed = await store.allocateExistingRepresentation({...input, requestDigest: digest(0xe3)});
    expect(replayed.status).toBe("replayed");
    const retained = await store.getRevision(message.id, 0);
    expect(retained?.lifecycle).toMatchObject({cryptoObjectId: objectId,
      allocationRequestDigest: digest(0xe1), repairSourceDigest: digest(0xe3), repairSourceRevision: source.revision});
    expect(retained?.message?.revision).toBe(0);
    expect(await store.refreshPendingToolRepairSource({...coordinates, sourceRevision: source.revision - 1, sourceDigest: digest(0xe4)})).toBe("conflict");
    // The SQL guard independently freezes the replacement source after publication.
    await db.update(sessionMessageCryptoRevisions).set({completion: "complete", cryptoCompletedAt: new Date(),
      parityStatus: "client_authenticated", repairPublisherKind: "human_device", repairPublisherId: "fixture-device",
      repairPublisherHumanId: fixture.humanActorId, repairAttestationDigest: digest(0xe5),
    }).where(eq(sessionMessageCryptoRevisions.messageId, message.id));
    expect(await store.refreshPendingToolRepairSource({...coordinates, sourceRevision: source.revision, sourceDigest: digest(0xe4)})).toBe("conflict");
    const productDb = drizzle(client);
    const rejection = await rejectedError(Promise.resolve(productDb.update(sessionMessageCryptoRevisions).set({repairSourceRevision: source.revision + 1,
      repairSourceDigest: digest(0xe4)}).where(eq(sessionMessageCryptoRevisions.messageId, message.id))));
    expect(rejection.cause).toMatchObject({code: "23514"});
  } finally {await client.end();}
});

test("authorized publication keeps fresh authority on its serializable Agent transaction and releases cancellation locks", async () => {
  const fixture = await createFixture();
  const client = sqlClient(agentUrl, 1);
  const db = drizzle(admin);
  try {
    const [message] = await db.insert(sessionMessages).values({sessionId: fixture.sessionId,
      role: "assistant", content: "Scoped publication"}).returning({id: sessionMessages.id});
    const [policy] = await db.select({revision: encryptionTransitionPolicy.revision}).from(encryptionTransitionPolicy);
    if (!message || !policy) throw new Error("Missing publication fixture");
    const store = await productStore(client, {userId: fixture.ownerId, agentId: fixture.agentId});
    const controller = new AbortController();
    let disposed = false;
    let escaped: (() => Promise<unknown>) | undefined;
    expect((await rejectedError(store.withAuthorizedExistingRepresentationPublication({
      sessionId: fixture.sessionId, messageId: message.id, revision: 0, signal: controller.signal,
      publicationPolicy: {expectedRevision: policy.revision, representation: "ordinary_and_protected"},
      prepareAuthority: async connection => {
        // Match the canonical authority's transactionOnce contract. A max-one
        // Agent pool cannot open a second transaction while this callback owns it.
        const [before] = await connection.transactionOnce(current => current.query(
          "SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation",
        ), {isolationLevel: "serializable"});
        expect(before?.["isolation"]).toBe("serializable");
        await connection.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [fixture.roomId]);
        // Authority has acquired Room locks, but the publication Message lock
        // must not precede it. Another owner can still lock that Message now.
        await db.transaction(async other => {
          expect(await other.select({id: sessionMessages.id}).from(sessionMessages)
            .where(eq(sessionMessages.id, message.id)).for("update", {noWait: true})).toHaveLength(1);
        });
        escaped = () => connection.transactionOnce(async current => {
          const [after] = await current.query("SELECT pg_backend_pid() AS pid");
          expect(after?.["pid"]).toBe(before?.["pid"]);
          await current.query("SELECT id FROM rooms WHERE id = $1 FOR UPDATE", [fixture.roomId]);
        }, {isolationLevel: "serializable"});
        return Object.freeze({revalidate: escaped});
      },
      use: async (_current, authority) => {
        await authority.revalidate();
        controller.abort(new Error("cancel scoped publication"));
        return true;
      },
      disposeAuthority: () => {disposed = true;},
    }))).message).toContain("cancel scoped publication");
    expect(disposed).toBe(true);
    if (escaped === undefined) throw new Error("Missing scoped authority");
    expect(await rejectedError(escaped())).toBeInstanceOf(Error);
    await db.transaction(async released => {
      expect(await released.select({id: rooms.id}).from(rooms).where(eq(rooms.id, fixture.roomId))
        .for("update", {noWait: true})).toHaveLength(1);
      expect(await released.select({id: sessionMessages.id}).from(sessionMessages)
        .where(eq(sessionMessages.id, message.id)).for("update", {noWait: true})).toHaveLength(1);
    });
  } finally {await client.end();}
});

test("Runtime allocation waiting on a Room leaves its Message available to the Room lock owner", async () => {
  const fixture = await createFixture();
  const client = sqlClient(agentUrl, 1);
  const db = drizzle(admin);
  let signalBlocked!: () => void;
  const reachedRoomDependency = new Promise<void>(resolve => {signalBlocked = resolve;});
  let pending: ReturnType<PostgresConversationProductStore["allocateExistingRepresentation"]> | undefined;
  try {
    const [message] = await db.insert(sessionMessages).values({sessionId: fixture.sessionId,
      role: "assistant", content: "Room-first allocation"}).returning({id: sessionMessages.id});
    if (!message) throw new Error("Missing allocation fixture");
    const store = await productStore(client, {userId: fixture.ownerId, agentId: fixture.agentId}, statement => {
      // Observe the attempt to acquire the Room dependency, including the old
      // late FK acquisition, without allowing the competing Room owner to wait.
      if ((statement.includes('from "rooms"') && statement.includes("for update"))
        || statement.startsWith('insert into "session_message_crypto_revisions"')) signalBlocked();
    });
    await db.transaction(async locked => {
      await locked.select({id: rooms.id}).from(rooms).where(eq(rooms.id, fixture.roomId)).for("update");
      pending = store.allocateExistingRepresentation({publisher: {kind: "foreground_runtime", agentId: fixture.agentId},
        sessionId: fixture.sessionId, messageId: message.id, revision: 0, operationId: `room-order:${randomUUID()}`,
        expectedNamespaceId: fixture.namespaceId, expectedAuthorRole: "assistant", expectedAuthorHumanTurnId: null,
        expectedSessionAgentId: fixture.agentId, requestDigest: digest(0xe6), repairIdentityDigest: digest(0xe7)});
      await Promise.race([reachedRoomDependency, pending.then(() => {
        throw new Error("Allocation completed while another transaction owned the Room");
      })]);
      const rows = await locked.select({id: sessionMessages.id}).from(sessionMessages)
        .where(eq(sessionMessages.id, message.id)).for("update", {noWait: true});
      expect(rows).toEqual([{id: message.id}]);
    });
    expect(await pending).toMatchObject({status: "allocated"});
  } finally {
    if (pending !== undefined) await Promise.allSettled([pending]);
    await client.end();
  }
});

test("a publisher transaction predating a competing allocation preserves lifecycle timestamp order", async () => {
  const fixture = await createFixture();
  const earlier = sqlClient(appUrl, 1), allocator = sqlClient(appUrl, 1);
  const db = drizzle(admin);
  try {
    const [message] = await db.insert(sessionMessages).values({sessionId: fixture.sessionId,
      role: "tool", content: "Result", toolName: "lookup"}).returning({id: sessionMessages.id});
    if (!message) throw new Error("Missing Tool fixture");
    const context = {userId: fixture.ownerId, agentId: fixture.agentId};
    const allocatingStore = await productStore(allocator, context);
    const handle = await verifyConversationProductPostgresHandle(connection(earlier, context));
    await canonicalConnection(earlier, context).transaction(async (transaction, transactionExecutor) => {
      // Establish the losing transaction's clock before the competing INSERT.
      await transaction.execute(sql`SELECT CURRENT_TIMESTAMP`);
      const allocation = await allocatingStore.allocateExistingRepresentation({publisher: {kind: "human_device", humanActorId: fixture.humanActorId},
        sessionId: fixture.sessionId, messageId: message.id, revision: 0, operationId: `repair:${randomUUID()}`,
        expectedNamespaceId: fixture.namespaceId, expectedKeyClass: "ai", expectedAuthorRole: "tool",
        expectedAuthorHumanTurnId: null, expectedSessionAgentId: fixture.agentId,
        requestDigest: digest(0xf1), repairIdentityDigest: digest(0xf2)});
      if (allocation.status !== "allocated") throw new Error(`Unexpected allocation ${allocation.status}`);
      const resumed = new PostgresConversationProductStore(handle, bindConversationProductCanonicalTransactionRunner(handle, {
        transaction: callback => callback(transaction, transactionExecutor),
      }));
      const [policy] = await transaction.select({revision: encryptionTransitionPolicy.revision}).from(encryptionTransitionPolicy);
      if (!policy) throw new Error("Missing policy");
      expect(await resumed.reserveExistingRepresentationPublication({sessionId: fixture.sessionId, messageId: message.id,
        revision: 0, cryptoObjectId: allocation.lifecycle.cryptoObjectId, sourceDigest: digest(0xf1),
        publicationPolicy: {expectedRevision: policy.revision, representation: "ordinary_and_protected"},
        repairPublication: {publisherKind: "human_device", publisherId: "timestamp-test-device",
          publisherHumanId: fixture.humanActorId, attestationDigest: digest(0xf3)},
      })).toBe("reserved");
      const [row] = await transaction.select({created: sessionMessageCryptoRevisions.createdAt,
        updated: sessionMessageCryptoRevisions.updatedAt}).from(sessionMessageCryptoRevisions)
        .where(eq(sessionMessageCryptoRevisions.messageId, message.id));
      expect(row!.updated.getTime()).toBeGreaterThanOrEqual(row!.created.getTime());
    }, {isolationLevel: "read committed"});
  } finally {await earlier.end(); await allocator.end();}
});
