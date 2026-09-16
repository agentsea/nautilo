import {
  and,
  eq,
  rooms,
  sessionMessageCryptoRevisions,
  sessionMessages,
  sessions,
  sql,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type { BackgroundReflectionSemanticInputBindingV2 } from
  "@nautilo/lattice-crypto/background";

import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
} from "../storage/postgres-lattice-storage.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

type MessageRole = "user" | "assistant" | "tool" | "system";

export interface ProtectedReflectionMessageMetadata {
  readonly messageId: number;
  readonly logicalSourceRef: `message:${number}`;
  readonly sessionId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly namespaceAccessRevision: number;
  readonly editRevision: number;
  readonly role: MessageRole;
  readonly inputBinding: BackgroundReflectionSemanticInputBindingV2 &
    Readonly<{ objectType: "nautilo-message-v2" }>;
}

export type ProtectedReflectionMessageMetadataResult =
  | Readonly<{
      status: "available";
      metadata: ProtectedReflectionMessageMetadata;
    }>
  | Readonly<{
      status: "missing" | "changed" | "waiting" | "unavailable";
    }>;

type MessageLookup =
  | Readonly<{
      kind: "message";
      messageId: number;
      roomId: string;
      namespaceId: string;
      observedRevision?: string;
    }>
  | Readonly<{
      kind: "object";
      objectId: string;
      namespaceId: string;
    }>;

function validMessageId(value: number): boolean {
  return Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_POSTGRES_INTEGER;
}

function revision(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_POSTGRES_INTEGER
    ? parsed
    : null;
}

function validRole(value: unknown): value is MessageRole {
  return value === "user"
    || value === "assistant"
    || value === "tool"
    || value === "system";
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Content-free current Message lookup for protected Reflection planning.
 * Lattice still owns object-head, Namespace-authority, and plaintext checks.
 */
export class PostgresProtectedReflectionMessageMetadata {
  constructor(
    private readonly product: Pick<PostgresJsBridgeConnection, "query">,
  ) {}

  async resolveMessage(input: Readonly<{
    messageId: number;
    roomId: string;
    namespaceId: string;
    observedRevision?: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedReflectionMessageMetadataResult> {
    input.signal?.throwIfAborted();
    if (
      !validMessageId(input.messageId)
      || !UUID.test(input.roomId)
      || !UUID.test(input.namespaceId)
      || (input.observedRevision !== undefined
        && revision(input.observedRevision) === null)
    ) return { status: "unavailable" };
    const result = await this.#resolve({
      kind: "message",
      messageId: input.messageId,
      roomId: input.roomId,
      namespaceId: input.namespaceId,
      ...(input.observedRevision === undefined
        ? {}
        : { observedRevision: input.observedRevision }),
    });
    input.signal?.throwIfAborted();
    return result;
  }

  async resolveMessageObject(input: Readonly<{
    objectId: string;
    namespaceId: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedReflectionMessageMetadata | null> {
    input.signal?.throwIfAborted();
    if (!PORTABLE.test(input.objectId) || !UUID.test(input.namespaceId)) {
      return null;
    }
    const result = await this.#resolve({
      kind: "object",
      objectId: input.objectId,
      namespaceId: input.namespaceId,
    });
    input.signal?.throwIfAborted();
    return result.status === "available" ? result.metadata : null;
  }

  async #resolve(
    lookup: MessageLookup,
  ): Promise<ProtectedReflectionMessageMetadataResult> {
    const rows = await executeTypedCryptoQuery(
      this.product,
      cryptoTypedDb.select({
        messageId: sessionMessages.id,
        sessionId: sessionMessages.sessionId,
        editRevision: sessionMessages.editRevision,
        role: sessionMessages.role,
        productCryptoObjectId: sessionMessages.cryptoObjectId,
        roomId: sessions.roomId,
        currentNamespaceId: rooms.namespaceId,
        namespaceAccessRevision: rooms.namespaceAccessRevision,
        lifecycle_object_id: sql<string | null>`${sessionMessageCryptoRevisions.cryptoObjectId}`
          .as("lifecycle_object_id"),
        lifecycleNamespaceId:
          sessionMessageCryptoRevisions.namespaceIdAtAllocation,
        payloadVersion: sessionMessageCryptoRevisions.payloadVersion,
        keyClass: sessionMessageCryptoRevisions.keyClass,
        completion: sessionMessageCryptoRevisions.completion,
        disposition: sessionMessageCryptoRevisions.disposition,
      })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .innerJoin(rooms, eq(rooms.id, sessions.roomId))
        .leftJoin(sessionMessageCryptoRevisions, and(
          eq(
            sessionMessageCryptoRevisions.sessionId,
            sessionMessages.sessionId,
          ),
          eq(sessionMessageCryptoRevisions.messageId, sessionMessages.id),
          eq(
            sessionMessageCryptoRevisions.editRevision,
            sessionMessages.editRevision,
          ),
        ))
        .where(lookup.kind === "message"
          ? eq(sessionMessages.id, lookup.messageId)
          : eq(sessionMessages.cryptoObjectId, lookup.objectId))
        .limit(2),
    );
    if (rows.length === 0) return { status: "missing" };
    if (rows.length !== 1) return { status: "unavailable" };
    const row = rows[0]!;
    if (
      !validMessageId(row.id)
      || typeof row.session_id !== "string"
      || !UUID.test(row.session_id)
      || typeof row.room_id !== "string"
      || !UUID.test(row.room_id)
      || typeof row.namespace_id !== "string"
      || !UUID.test(row.namespace_id)
      || !nonnegativeInteger(row.namespace_access_revision)
      || !nonnegativeInteger(row.edit_revision)
      || !validRole(row.role)
    ) return { status: "unavailable" };
    if (lookup.kind === "message") {
      if (
        row.id !== lookup.messageId
        || row.room_id !== lookup.roomId
        || row.namespace_id !== lookup.namespaceId
      ) return { status: "changed" };
      if (
        lookup.observedRevision !== undefined
        && row.edit_revision !== revision(lookup.observedRevision)
      ) return { status: "changed" };
    } else if (row.namespace_id !== lookup.namespaceId) {
      return { status: "changed" };
    }
    if (
      row.crypto_object_id === null
      || row.lifecycle_object_id === null
      || row.completion === "pending"
      || row.disposition === "active"
    ) return { status: "waiting" };
    if (
      typeof row.crypto_object_id !== "string"
      || typeof row.lifecycle_object_id !== "string"
      || row.crypto_object_id !== row.lifecycle_object_id
      || (lookup.kind === "object"
        && row.crypto_object_id !== lookup.objectId)
      || row.namespace_id_at_allocation !== row.namespace_id
      || row.payload_version !== 2
      || row.key_class !== "ai"
      || row.completion !== "complete"
      || row.disposition !== "mapped"
    ) return { status: "unavailable" };
    return {
      status: "available",
      metadata: Object.freeze({
        messageId: row.id,
        logicalSourceRef: `message:${row.id}` as const,
        sessionId: row.session_id,
        roomId: row.room_id,
        namespaceId: row.namespace_id,
        namespaceAccessRevision: row.namespace_access_revision,
        editRevision: row.edit_revision,
        role: row.role,
        inputBinding: Object.freeze({
          objectId: row.crypto_object_id,
          namespaceId: row.namespace_id,
          objectType: "nautilo-message-v2" as const,
        }),
      }),
    };
  }
}
