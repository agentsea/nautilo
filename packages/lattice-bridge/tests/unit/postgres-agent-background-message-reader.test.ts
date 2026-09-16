import { describe, expect, test } from "bun:test";

import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
} from "../../src/message/conversation-repository.ts";
import { PostgresAgentBackgroundMessageRevisionReader } from "../../src/server/message/postgres-agent-background-message-reader.ts";
import type { VerifiedStoredConversationCryptoRead } from "../../src/server/storage/postgres-conversation-crypto-completion.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly statements: string[] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    const result = this.#results.shift();
    if (result === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }

  assertExhausted(): void {
    expect(this.#results).toEqual([]);
  }
}

const USER_ID = "10000000-0000-4000-8000-000000000001";
const AGENT_ID = "10000000-0000-4000-8000-000000000002";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const OBJECT_ID = "conversation.message.17.0";

const identity = {
  current_user_id: USER_ID,
  current_agent_id: AGENT_ID,
};

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    product_id: "17",
    product_revision: 0,
    crypto_object_id: OBJECT_ID,
    role: "user",
    current_namespace_id: NAMESPACE_ID,
    namespace_id: NAMESPACE_ID,
    lifecycle_object_id: OBJECT_ID,
    payload_version: 2,
    key_class: "ai",
    completion: "complete",
    disposition: "mapped",
    ...overrides,
  };
}

function verified(
  payloadBytes: Uint8Array,
  envelopeBytes: Uint8Array,
  manifestBytes = new Uint8Array([9]),
): VerifiedStoredConversationCryptoRead {
  return Object.freeze({
    revision: Object.freeze({
      objectId: OBJECT_ID,
      namespaceId: NAMESPACE_ID,
      objectType: CONVERSATION_MESSAGE_OBJECT_TYPE,
      payloadVersion: CONVERSATION_MESSAGE_PAYLOAD_VERSION,
      keyClass: "ai",
    }),
    payloadBytes,
    objectAccessManifestBytes: manifestBytes,
    namespaceEnvelopeBytes: envelopeBytes,
  });
}

describe("Postgres background Message revision reader", () => {
  test("binds zero-based product revision to authenticated opaque bytes", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [productRow()],
      [identity],
      [productRow()],
    ]);
    const payloadBytes = new Uint8Array([1, 2]);
    const envelopeBytes = new Uint8Array([3, 4]);
    const manifestBytes = new Uint8Array([5, 6]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const reader = new PostgresAgentBackgroundMessageRevisionReader({
      handle,
      readCryptoRevision: () => Promise.resolve(
        verified(payloadBytes, envelopeBytes, manifestBytes),
      ),
    });

    const result = await reader.read({
      subjectUserId: USER_ID,
      agentId: AGENT_ID,
      productId: "17",
      productRevision: 0,
      objectId: OBJECT_ID,
      selectedNamespaceId: NAMESPACE_ID,
    });

    expect(result).toEqual({
      productId: "17",
      productRevision: 0,
      objectId: OBJECT_ID,
      namespaceId: NAMESPACE_ID,
      role: "user",
      payloadBytes,
      namespaceEnvelopeBytes: envelopeBytes,
    });
    expect(manifestBytes).toEqual(new Uint8Array(2));
    expect(payloadBytes).toEqual(new Uint8Array([1, 2]));
    expect(connection.statements.join("\n")).not.toMatch(
      /message_row\.(content|tool_calls)\b/,
    );
    expect(connection.isolationLevels).toEqual([
      "serializable",
      "serializable",
    ]);
    connection.assertExhausted();
  });

  test("wipes all crypto bytes when the product mapping changes", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo_agent", session_user: "nautilo_agent" }],
      [identity],
      [productRow()],
      [identity],
      [productRow({ crypto_object_id: "conversation.changed" })],
    ]);
    const payloadBytes = new Uint8Array([1]);
    const envelopeBytes = new Uint8Array([2]);
    const manifestBytes = new Uint8Array([3]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const reader = new PostgresAgentBackgroundMessageRevisionReader({
      handle,
      readCryptoRevision: () => Promise.resolve(
        verified(payloadBytes, envelopeBytes, manifestBytes),
      ),
    });

    expect(await reader.read({
      subjectUserId: USER_ID,
      agentId: AGENT_ID,
      productId: "17",
      productRevision: 0,
      objectId: OBJECT_ID,
      selectedNamespaceId: NAMESPACE_ID,
    })).toBeNull();
    expect(payloadBytes).toEqual(new Uint8Array(1));
    expect(envelopeBytes).toEqual(new Uint8Array(1));
    expect(manifestBytes).toEqual(new Uint8Array(1));
    connection.assertExhausted();
  });
});
