import { describe, expect, test } from "bun:test";
import type { LatticeStorage } from "@nautilo/lattice-crypto";
import {
  createPostgresConversationProtectedReadPort,
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ResolveConversationProtectedProductReadAuthorization,
} from "@nautilo/lattice-bridge/server";
import type {
  ConversationProtectedProductReadAuthorization,
} from "@nautilo/lattice-bridge";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly queries: Query[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    const result = this.#results.shift();
    if (result === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    return callback(this);
  }
}

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const ROOM_ID = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "10000000-0000-4000-8000-000000000003";
const DOMAIN_ID = "domain-protected-read";
const USER_ID = "10000000-0000-4000-8000-000000000004";
const ACTOR_ID = "10000000-0000-4000-8000-000000000005";
const OBJECT_ID =
  "message:v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const roleRow = {
  current_user: "nautilo",
  session_user: "nautilo",
};
const authorization =
  Object.freeze({}) as ConversationProtectedProductReadAuthorization;

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 11,
    session_id: SESSION_ID,
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    role: "user",
    created_at: new Date("2027-01-15T08:00:00.000Z"),
    edited_at: null,
    edit_revision: 0,
    fingerprint: "human-turn-11",
    reply_to_message_id: null,
    subthread_room_id: null,
    reply_count: 0,
    last_reply_at: null,
    summary_revision: 0,
    source_user_id: USER_ID,
    author_agent_id: null,
    author_actor_id: ACTOR_ID,
    author_handle: "alice",
    author_display_name: "Alice",
    crypto_object_id: OBJECT_ID,
    lifecycle_object_id: OBJECT_ID,
    payload_version: 2,
    key_class: "ai",
    completion: "complete",
    disposition: "mapped",
    parity_status: "client_verified",
    ...overrides,
  };
}

function resolver(
  overrides: Partial<Awaited<ReturnType<
    ResolveConversationProtectedProductReadAuthorization
  >>> = {},
): ResolveConversationProtectedProductReadAuthorization {
  return async () => ({
    sessionId: SESSION_ID,
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    domainId: DOMAIN_ID,
    expectedAccessRevision: 7,
    expectedPolicyRevision: 9,
    ...overrides,
  });
}

function cryptoStorage(
  overrides: Partial<Pick<
    LatticeStorage,
    "getObject" | "getObjectAccessState"
  >> = {},
): Pick<LatticeStorage, "getObject" | "getObjectAccessState"> {
  return {
    getObject: async () => ({
      objectId: OBJECT_ID,
      payloadBytes: new Uint8Array([1, 2, 3]),
    }),
    getObjectAccessState: async () => ({
      head: {
        objectId: OBJECT_ID,
        accessRevision: 0,
        manifestHash: new Uint8Array(32).fill(1),
        manifestBytes: new Uint8Array([4, 5, 6]),
      },
      namespaceEnvelopes: [{
        namespaceId: NAMESPACE_ID,
        envelopeHash: new Uint8Array(32).fill(2),
        envelopeBytes: new Uint8Array([7, 8, 9]),
      }],
    }),
    ...overrides,
  };
}

async function subject(input: {
  rows: unknown[][];
  authorize?: ResolveConversationProtectedProductReadAuthorization;
  storage?: Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
}) {
  const connection = new ScriptedConnection([[roleRow], ...input.rows]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return {
    connection,
    port: createPostgresConversationProtectedReadPort({
      product: handle,
      crypto: input.storage ?? cryptoStorage(),
      authorize: input.authorize ?? resolver(),
    }),
  };
}

describe("Postgres protected conversation reads", () => {
  test("returns an ascending protected page without selecting plaintext columns", async () => {
    const { connection, port } = await subject({
      rows: [[productRow()]],
    });

    const records = await port.readPage({
      authorization,
      sessionId: SESSION_ID,
      beforeMessageId: 20,
      limit: 10,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.dto).toEqual({
      dtoVersion: 2,
      projection: {
        messageId: "11",
        logicalMessageKey: "turn:human-turn-11",
        sessionId: SESSION_ID,
        roomId: ROOM_ID,
        namespaceId: NAMESPACE_ID,
        role: "user",
        createdAt: "2027-01-15T08:00:00.000Z",
        editRevision: 0,
        replyCount: 0,
        summaryRevision: 0,
        sourceUserId: USER_ID,
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: OBJECT_ID,
        payloadVersion: 2,
        keyClass: "ai",
        encryptedPayloadBytesBase64url: "AQID",
        accessManifestBytesBase64url: "BAUG",
        namespaceEnvelopeBytesBase64url: "BwgJ",
      },
    });
    expect(records[0]?.author).toEqual({
      actorId: ACTOR_ID,
      handle: "alice",
      displayName: "Alice",
    });
    const statement = connection.queries.at(-1)?.statement ?? "";
    expect(statement).not.toMatch(/\bcontent\b/i);
    expect(statement).not.toMatch(/\btool_calls\b/i);
    expect(statement).not.toMatch(/\bcontent_search\b/i);
    expect(statement).toContain("session_message_crypto_revisions");
  });

  test("returns pending and per-object unavailable placeholders without plaintext fallback", async () => {
    const { port } = await subject({
      rows: [[
        productRow({
          message_id: 10,
          crypto_object_id: null,
          lifecycle_object_id: "message:v2:pending",
          completion: "pending",
          disposition: "active",
          parity_status: "pending",
        }),
        productRow({ message_id: 11 }),
      ]],
      storage: cryptoStorage({
        getObjectAccessState: async () => null,
      }),
    });

    const records = await port.readPage({
      authorization,
      sessionId: SESSION_ID,
      limit: 10,
    });

    expect(records.map((record) => record.dto.protectedPayload)).toEqual([
      { status: "pending", reason: "shadow_pending" },
      {
        status: "unavailable",
        reason: "corrupt",
        cryptoObjectId: OBJECT_ID,
      },
    ]);
  });

  test("fails closed before SQL or crypto when request-bound authority is absent or mismatched", async () => {
    let cryptoReads = 0;
    const { connection, port } = await subject({
      rows: [],
      authorize: async () => null,
      storage: cryptoStorage({
        getObject: async () => {
          cryptoReads += 1;
          return null;
        },
      }),
    });

    const deniedPage = port.readPage({
      authorization,
      sessionId: SESSION_ID,
      limit: 10,
    });
    const pageError = await deniedPage.catch((error: unknown) => error);
    expect(pageError).toBeInstanceOf(Error);
    expect((pageError as Error).message).toContain("authorization");
    expect(connection.queries).toHaveLength(1);
    expect(cryptoReads).toBe(0);

    const mismatched = await subject({
      rows: [],
      authorize: resolver({ sessionId: "10000000-0000-4000-8000-000000000099" }),
    });
    const deniedTranscript = mismatched.port.readAgentTranscript({
      authorization,
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      limit: 10,
    });
    const transcriptError = await deniedTranscript.catch(
      (error: unknown) => error,
    );
    expect(transcriptError).toBeInstanceOf(Error);
    expect((transcriptError as Error).message).toContain("authorization");
    expect(mismatched.connection.queries).toHaveLength(1);
  });

  test("returns exact Agent authority coordinates and enforces around/up-to windows in SQL", async () => {
    const agent = await subject({ rows: [[productRow()]] });
    const batch = await agent.port.readAgentTranscript({
      authorization,
      sessionId: SESSION_ID,
      namespaceId: NAMESPACE_ID,
      upToMessageId: 11,
      limit: 10,
    });
    expect(batch).toMatchObject({
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      expectedAccessRevision: 7,
      expectedPolicyRevision: 9,
    });
    expect(agent.connection.queries.at(-1)?.parameters).toEqual([
      SESSION_ID,
      11,
      10,
    ]);

    const around = await subject({ rows: [[productRow()]] });
    const records = await around.port.readAround({
      authorization,
      sessionId: SESSION_ID,
      messageId: 11,
      radius: 2,
    });
    expect(records).toHaveLength(1);
    expect(around.connection.queries.at(-1)?.parameters).toEqual([
      SESSION_ID,
      11,
      3,
      2,
    ]);
  });
});
