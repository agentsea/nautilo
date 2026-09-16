import type {
  ProtectedAgentBackgroundMessageRevisionReader,
  ProtectedAgentBackgroundMessageRevisionReference,
  VerifiedAgentBackgroundMessageRevisionContent,
} from "../../memory/agent-background-revision-reader.ts";
import {
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
} from "../../message/conversation-repository.ts";
import type {
  VerifiedStoredConversationCryptoRead,
} from "../storage/postgres-conversation-crypto-completion.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresTransaction,
} from "./postgres-conversation-product-store.ts";
import {
  and,
  eq,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  sql,
} from "@nautilo/db";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

type MessageRole = VerifiedAgentBackgroundMessageRevisionContent["role"];

type ProductSnapshot = Readonly<{
  productId: string;
  productRevision: number;
  objectId: string;
  namespaceId: string;
  role: MessageRole;
}>;

function oneOrNull(
  rows: readonly ConversationProductDatabaseRow[],
  label: string,
): ConversationProductDatabaseRow | null {
  if (rows.length > 1) throw new Error(`${label} returned duplicate rows`);
  return rows[0] ?? null;
}

function text(row: ConversationProductDatabaseRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function nullableText(
  row: ConversationProductDatabaseRow,
  name: string,
): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError(`${name} is not text`);
  return value;
}

function integer(row: ConversationProductDatabaseRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`${name} is not an integer`);
  }
  return value;
}

function role(row: ConversationProductDatabaseRow): MessageRole {
  const value = text(row, "role");
  if (
    value !== "user"
    && value !== "assistant"
    && value !== "tool"
    && value !== "system"
  ) throw new TypeError("Background Message role is invalid");
  return value;
}

function messageId(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_POSTGRES_INTEGER
    ? parsed
    : null;
}

function validReference(
  reference: ProtectedAgentBackgroundMessageRevisionReference,
): boolean {
  return UUID.test(reference.subjectUserId)
    && UUID.test(reference.agentId)
    && messageId(reference.productId) !== null
    && Number.isSafeInteger(reference.productRevision)
    && reference.productRevision >= 0
    && reference.productRevision <= MAX_POSTGRES_INTEGER
    && PORTABLE.test(reference.objectId)
    && UUID.test(reference.selectedNamespaceId);
}

function equalSnapshot(
  left: ProductSnapshot,
  right: ProductSnapshot,
): boolean {
  return left.productId === right.productId
    && left.productRevision === right.productRevision
    && left.objectId === right.objectId
    && left.namespaceId === right.namespaceId
    && left.role === right.role;
}

function wipe(read: VerifiedStoredConversationCryptoRead | null): void {
  read?.payloadBytes.fill(0);
  read?.objectAccessManifestBytes.fill(0);
  read?.namespaceEnvelopeBytes.fill(0);
}

/**
 * Binds signed background Message coordinates to the current product mapping
 * before and after restricted crypto verification. No plaintext Message
 * column is selected, and all opaque byte ownership is explicit.
 */
export class PostgresAgentBackgroundMessageRevisionReader
  implements ProtectedAgentBackgroundMessageRevisionReader {
  readonly #handle: ConversationProductPostgresHandle;
  readonly #readCryptoRevision: (
    objectId: string,
  ) => Promise<VerifiedStoredConversationCryptoRead | null>;

  constructor(input: Readonly<{
    handle: ConversationProductPostgresHandle;
    readCryptoRevision: (
      objectId: string,
    ) => Promise<VerifiedStoredConversationCryptoRead | null>;
  }>) {
    assertVerifiedConversationProductPostgresHandle(input.handle);
    if (input.handle.role !== "nautilo_agent") {
      throw new TypeError(
        "Background Message reader requires a direct nautilo_agent handle",
      );
    }
    if (typeof input.readCryptoRevision !== "function") {
      throw new TypeError("Background Message crypto reader is required");
    }
    this.#handle = input.handle;
    this.#readCryptoRevision = input.readCryptoRevision;
  }

  async #transaction<Value>(
    reference: ProtectedAgentBackgroundMessageRevisionReference,
    execute: (
      transaction: ConversationProductPostgresTransaction,
    ) => Promise<Value>,
  ): Promise<Value> {
    return this.#handle.transaction(async (transaction) => {
      const identity = oneOrNull(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          current_user_id: sql<string>`app_current_user_id()::text`.as("current_user_id"),
          current_agent_id: sql<string | null>`app_current_agent_id()::text`.as("current_agent_id"),
        }).from(sql`(values (1)) as identity_probe`).limit(2),
      ), "Background Message identity");
      if (
        identity === null
        || nullableText(identity, "current_user_id") !== reference.subjectUserId
        || nullableText(identity, "current_agent_id") !== reference.agentId
      ) throw new Error("Background Message product authority changed");
      return execute(transaction);
    }, { isolationLevel: "serializable" });
  }

  async #snapshot(
    reference: ProtectedAgentBackgroundMessageRevisionReference,
  ): Promise<ProductSnapshot | null> {
    const id = messageId(reference.productId);
    if (id === null) return null;
    return this.#transaction(reference, async (transaction) => {
      const row = oneOrNull(await executeTypedConversationProductQuery(
        transaction,
        conversationProductTypedDb.select({
          product_id: sql<string>`${sessionMessages.id}::text`.as("product_id"),
          product_revision: sql`${sessionMessages.editRevision}`
            .as("product_revision"),
          crypto_object_id: sessionMessages.cryptoObjectId,
          role: sessionMessages.role,
          current_namespace_id: sql<string>`${rooms.namespaceId}::text`
            .as("current_namespace_id"),
          namespace_id:
            sql<string>`${sessionMessageCryptoRevisions.namespaceIdAtAllocation}::text`
              .as("namespace_id"),
          lifecycle_object_id: sql`${sessionMessageCryptoRevisions.cryptoObjectId}`
            .as("lifecycle_object_id"),
          payload_version: sessionMessageCryptoRevisions.payloadVersion,
          key_class: sessionMessageCryptoRevisions.keyClass,
          completion: sessionMessageCryptoRevisions.completion,
          disposition: sessionMessageCryptoRevisions.disposition,
        }).from(sessionMessages)
          .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
          .innerJoin(rooms, eq(rooms.id, sessions.roomId))
          .innerJoin(sessionMessageCryptoRevisions, and(
            eq(
              sessionMessageCryptoRevisions.sessionId,
              sessionMessages.sessionId,
            ),
            eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
            eq(
              sessionMessageCryptoRevisions.editRevision,
              sessionMessages.editRevision,
            ),
          )).where(and(
            eq(sessionMessages.id, id),
            eq(sessionMessages.editRevision, reference.productRevision),
          )).limit(2),
      ), "Background Message product snapshot");
      if (
        row === null
        || text(row, "product_id") !== reference.productId
        || integer(row, "product_revision") !== reference.productRevision
        || nullableText(row, "crypto_object_id") !== reference.objectId
        || text(row, "lifecycle_object_id") !== reference.objectId
        || text(row, "current_namespace_id")
          !== reference.selectedNamespaceId
        || text(row, "namespace_id") !== reference.selectedNamespaceId
        || integer(row, "payload_version")
          !== CONVERSATION_MESSAGE_PAYLOAD_VERSION
        || text(row, "key_class") !== "ai"
        || text(row, "completion") !== "complete"
        || text(row, "disposition") !== "mapped"
      ) return null;
      return Object.freeze({
        productId: reference.productId,
        productRevision: reference.productRevision,
        objectId: reference.objectId,
        namespaceId: reference.selectedNamespaceId,
        role: role(row),
      });
    });
  }

  async read(
    reference: ProtectedAgentBackgroundMessageRevisionReference,
  ): Promise<VerifiedAgentBackgroundMessageRevisionContent | null> {
    if (!validReference(reference)) return null;
    const before = await this.#snapshot(reference);
    if (before === null) return null;
    let verified: VerifiedStoredConversationCryptoRead | null = null;
    let transferred = false;
    try {
      verified = await this.#readCryptoRevision(reference.objectId);
      if (
        verified === null
        || verified.revision.objectId !== reference.objectId
        || verified.revision.namespaceId !== reference.selectedNamespaceId
        || verified.revision.objectType !== CONVERSATION_MESSAGE_OBJECT_TYPE
        || verified.revision.payloadVersion
          !== CONVERSATION_MESSAGE_PAYLOAD_VERSION
        || verified.revision.keyClass !== "ai"
      ) return null;
      const after = await this.#snapshot(reference);
      if (after === null || !equalSnapshot(after, before)) return null;
      verified.objectAccessManifestBytes.fill(0);
      transferred = true;
      return Object.freeze({
        ...before,
        payloadBytes: verified.payloadBytes,
        namespaceEnvelopeBytes: verified.namespaceEnvelopeBytes,
      });
    } finally {
      if (verified !== null) {
        verified.objectAccessManifestBytes.fill(0);
        if (!transferred) wipe(verified);
      }
    }
  }
}
