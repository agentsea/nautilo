import type { LatticeStorage } from "@nautilo/lattice-crypto";
import type {
  ConversationProtectedAgentReadBatch,
  ConversationProtectedProductReadAuthorization,
  ConversationProtectedProductReadPort,
  ConversationProtectedProductReadRecord,
} from "../../message/conversation-repository.ts";
import {
  assertVerifiedConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresHandle,
} from "./postgres-conversation-product-store.ts";

const MAXIMUM_READ_BATCH = 256;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

type ProtectedMessageRole = "user" | "assistant" | "tool" | "system";
type ProtectedMessageKeyClass = "ai" | "human";

export type ConversationProtectedMessageDtoV2 = Readonly<{
  readonly dtoVersion: 2;
  readonly projection: Readonly<{
    readonly messageId: string;
    readonly logicalMessageKey?: string;
    readonly sessionId: string;
    readonly roomId: string;
    readonly namespaceId: string;
    readonly role: ProtectedMessageRole;
    readonly createdAt: string;
    readonly editedAt?: string;
    readonly editRevision: number;
    readonly replyToMessageId?: string;
    readonly subthreadRoomId?: string;
    readonly replyCount?: number;
    readonly lastReplyAt?: string;
    readonly summaryRevision?: number;
    readonly sourceUserId?: string;
    readonly authorAgentId?: string;
  }>;
  readonly protectedPayload:
    | Readonly<{
      readonly status: "encrypted";
      readonly cryptoObjectId: string;
      readonly payloadVersion: 2;
      readonly keyClass: ProtectedMessageKeyClass;
      readonly encryptedPayloadBytesBase64url: string;
      readonly accessManifestBytesBase64url: string;
      readonly namespaceEnvelopeBytesBase64url: string;
    }>
    | Readonly<{
      readonly status: "pending";
      readonly reason: "shadow_pending" | "backfill_pending";
    }>
    | Readonly<{
      readonly status: "unavailable";
      readonly reason:
        | "unsupported_version"
        | "corrupt"
        | "lost_key_material";
      readonly cryptoObjectId?: string;
    }>;
}>;

export type ConversationProtectedProductReadOperation =
  | Readonly<{
    readonly kind: "page";
    readonly authorization: ConversationProtectedProductReadAuthorization;
    readonly sessionId: string;
    readonly beforeMessageId?: number;
    readonly limit: number;
  }>
  | Readonly<{
    readonly kind: "around";
    readonly authorization: ConversationProtectedProductReadAuthorization;
    readonly sessionId: string;
    readonly messageId: number;
    readonly radius: number;
  }>
  | Readonly<{
    readonly kind: "agent_transcript";
    readonly authorization: ConversationProtectedProductReadAuthorization;
    readonly sessionId: string;
    readonly namespaceId: string;
    readonly upToMessageId?: number;
    readonly limit: number;
  }>;

export type ConversationProtectedProductReadAuthority = Readonly<{
  readonly sessionId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly expectedAccessRevision: number;
  readonly expectedPolicyRevision: number;
}>;

export type ResolveConversationProtectedProductReadAuthorization = (
  operation: ConversationProtectedProductReadOperation,
) =>
  | ConversationProtectedProductReadAuthority
  | null
  | Promise<ConversationProtectedProductReadAuthority | null>;

export type ConversationProtectedCryptoReadPort = Pick<
  LatticeStorage,
  "getObject" | "getObjectAccessState"
>;

export interface PostgresConversationProtectedReadOptions {
  readonly product: ConversationProductPostgresHandle;
  readonly crypto: ConversationProtectedCryptoReadPort;
  readonly authorize: ResolveConversationProtectedProductReadAuthorization;
}

type ProductReadRecord =
  ConversationProtectedProductReadRecord<ConversationProtectedMessageDtoV2>;

function assertUuid(label: string, value: string): void {
  if (!UUID.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertPortable(label: string, value: string): void {
  if (
    !PORTABLE_ID.test(value)
    || new TextEncoder().encode(value).length > 128
  ) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertCounter(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} is invalid`);
  }
}

function assertPositiveInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is out of bounds`);
  }
}

function assertLimit(limit: number): void {
  assertPositiveInteger("Conversation protected read limit", limit);
  if (limit > MAXIMUM_READ_BATCH) {
    throw new RangeError("Conversation protected read limit is out of bounds");
  }
}

function requiredString(
  row: ConversationProductDatabaseRow,
  key: string,
): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Conversation protected read ${key} is invalid`);
  }
  return value;
}

function nullableString(
  row: ConversationProductDatabaseRow,
  key: string,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Conversation protected read ${key} is invalid`);
  }
  return value;
}

function requiredInteger(
  row: ConversationProductDatabaseRow,
  key: string,
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`Conversation protected read ${key} is invalid`);
  }
  return value;
}

function nullableInteger(
  row: ConversationProductDatabaseRow,
  key: string,
): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`Conversation protected read ${key} is invalid`);
  }
  return value;
}

function requiredDate(
  row: ConversationProductDatabaseRow,
  key: string,
): Date {
  const value = row[key];
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value)
    ? new Date(value)
    : null;
  if (parsed === null || !Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Conversation protected read ${key} is invalid`);
  }
  return parsed;
}

function nullableDate(
  row: ConversationProductDatabaseRow,
  key: string,
): Date | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value)
    ? new Date(value)
    : null;
  if (parsed === null || !Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Conversation protected read ${key} is invalid`);
  }
  return parsed;
}

function role(row: ConversationProductDatabaseRow): ProtectedMessageRole {
  const value = requiredString(row, "role");
  if (
    value !== "user"
    && value !== "assistant"
    && value !== "tool"
    && value !== "system"
  ) {
    throw new TypeError("Conversation protected read role is invalid");
  }
  return value;
}

function keyClass(
  row: ConversationProductDatabaseRow,
): ProtectedMessageKeyClass | null {
  const value = nullableString(row, "key_class");
  if (value === null) return null;
  if (value !== "ai" && value !== "human") {
    throw new TypeError("Conversation protected read key class is invalid");
  }
  return value;
}

function encoded(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new TypeError("Conversation protected crypto bytes are invalid");
  }
  return Buffer.from(bytes).toString("base64url");
}

function projection(
  row: ConversationProductDatabaseRow,
  authority: Pick<
    ConversationProtectedProductReadAuthority,
    "sessionId" | "roomId" | "namespaceId"
  >,
): ConversationProtectedMessageDtoV2["projection"] {
  const messageId = requiredInteger(row, "message_id");
  assertPositiveInteger("Conversation message ID", messageId);
  const sessionId = requiredString(row, "session_id");
  const roomId = requiredString(row, "room_id");
  const namespaceId = requiredString(row, "namespace_id");
  if (
    sessionId !== authority.sessionId
    || roomId !== authority.roomId
    || namespaceId !== authority.namespaceId
  ) {
    throw new TypeError(
      "Conversation protected product row escaped its authorized coordinates",
    );
  }
  const messageRole = role(row);
  const fingerprint = nullableString(row, "fingerprint");
  const createdAt = requiredDate(row, "created_at");
  const editedAt = nullableDate(row, "edited_at");
  const editRevision = requiredInteger(row, "edit_revision");
  assertCounter("Conversation edit revision", editRevision);
  const replyToMessageId = nullableInteger(row, "reply_to_message_id");
  const subthreadRoomId = nullableString(row, "subthread_room_id");
  const replyCount = requiredInteger(row, "reply_count");
  const lastReplyAt = nullableDate(row, "last_reply_at");
  const summaryRevision = requiredInteger(row, "summary_revision");
  assertCounter("Conversation reply count", replyCount);
  assertCounter("Conversation summary revision", summaryRevision);
  const sourceUserId = requiredString(row, "source_user_id");
  const authorAgentId = nullableString(row, "author_agent_id");
  assertUuid("Conversation source User ID", sourceUserId);
  if (authorAgentId !== null) {
    assertUuid("Conversation author Agent ID", authorAgentId);
  }
  if (replyToMessageId !== null) {
    assertPositiveInteger("Conversation reply target", replyToMessageId);
  }
  if (subthreadRoomId !== null) {
    assertUuid("Conversation Subthread Room ID", subthreadRoomId);
  }
  return Object.freeze({
    messageId: String(messageId),
    logicalMessageKey: messageRole === "user" && fingerprint !== null
      ? `turn:${fingerprint}`
      : `row:${messageId}`,
    sessionId,
    roomId,
    namespaceId,
    role: messageRole,
    createdAt: createdAt.toISOString(),
    ...(editedAt === null ? {} : { editedAt: editedAt.toISOString() }),
    editRevision,
    ...(replyToMessageId === null
      ? {}
      : { replyToMessageId: String(replyToMessageId) }),
    ...(subthreadRoomId === null ? {} : { subthreadRoomId }),
    replyCount,
    ...(lastReplyAt === null
      ? {}
      : { lastReplyAt: lastReplyAt.toISOString() }),
    summaryRevision,
    ...(messageRole === "user"
      ? { sourceUserId }
      : messageRole === "system" || authorAgentId === null
      ? {}
      : { authorAgentId }),
  });
}

function unavailablePayload(
  reason: "unsupported_version" | "corrupt" | "lost_key_material",
  cryptoObjectId: string | null,
): ConversationProtectedMessageDtoV2["protectedPayload"] {
  return Object.freeze({
    status: "unavailable" as const,
    reason,
    ...(cryptoObjectId === null ? {} : { cryptoObjectId }),
  });
}

async function protectedPayload(
  row: ConversationProductDatabaseRow,
  namespaceId: string,
  crypto: ConversationProtectedCryptoReadPort,
): Promise<ConversationProtectedMessageDtoV2["protectedPayload"]> {
  const mappedObjectId = nullableString(row, "crypto_object_id");
  const lifecycleObjectId = nullableString(row, "lifecycle_object_id");
  const completion = nullableString(row, "completion");
  const disposition = nullableString(row, "disposition");
  const parity = nullableString(row, "parity_status");
  const payloadVersion = nullableInteger(row, "payload_version");
  const objectKeyClass = keyClass(row);

  if (lifecycleObjectId === null) {
    if (mappedObjectId !== null) {
      return unavailablePayload("corrupt", mappedObjectId);
    }
    return Object.freeze({
      status: "pending",
      reason: "backfill_pending",
    });
  }
  assertPortable("Conversation crypto object ID", lifecycleObjectId);
  if (
    completion === "pending"
    && mappedObjectId === null
    && disposition === "active"
    && parity === "pending"
  ) {
    return Object.freeze({
      status: "pending",
      reason: "shadow_pending",
    });
  }
  if (
    completion !== "complete"
    || mappedObjectId === null
    || mappedObjectId !== lifecycleObjectId
    || disposition !== "mapped"
  ) {
    return unavailablePayload("corrupt", lifecycleObjectId);
  }
  if (payloadVersion !== 2) {
    return unavailablePayload("unsupported_version", lifecycleObjectId);
  }
  if (objectKeyClass === null) {
    return unavailablePayload("corrupt", lifecycleObjectId);
  }

  let object;
  let access;
  try {
    [object, access] = await Promise.all([
      crypto.getObject(lifecycleObjectId),
      crypto.getObjectAccessState(lifecycleObjectId),
    ]);
  } catch {
    return unavailablePayload("corrupt", lifecycleObjectId);
  }
  if (
    object === null
    || access === null
    || object.objectId !== lifecycleObjectId
    || access.head.objectId !== lifecycleObjectId
  ) {
    return unavailablePayload("corrupt", lifecycleObjectId);
  }
  const envelopes = access.namespaceEnvelopes.filter(
    (candidate) => candidate.namespaceId === namespaceId,
  );
  if (envelopes.length !== 1) {
    return unavailablePayload("lost_key_material", lifecycleObjectId);
  }
  try {
    return Object.freeze({
      status: "encrypted" as const,
      cryptoObjectId: lifecycleObjectId,
      payloadVersion: 2 as const,
      keyClass: objectKeyClass,
      encryptedPayloadBytesBase64url: encoded(object.payloadBytes),
      accessManifestBytesBase64url: encoded(access.head.manifestBytes),
      namespaceEnvelopeBytesBase64url: encoded(
        envelopes[0]!.envelopeBytes,
      ),
    });
  } catch {
    return unavailablePayload("corrupt", lifecycleObjectId);
  }
}

async function record(
  row: ConversationProductDatabaseRow,
  authority: ConversationProtectedProductReadAuthority,
  crypto: ConversationProtectedCryptoReadPort,
): Promise<ProductReadRecord> {
  const actorId = requiredString(row, "author_actor_id");
  const handle = requiredString(row, "author_handle");
  const displayName = requiredString(row, "author_display_name");
  assertUuid("Conversation author Actor ID", actorId);
  assertPortable("Conversation author handle", handle);
  return Object.freeze({
    dto: await projectConversationProtectedMessageDtoV2(
      row,
      authority,
      crypto,
    ),
    author: Object.freeze({ actorId, handle, displayName }),
  });
}

/**
 * Project one already-selected durable product row through the canonical V2
 * protected DTO logic. The Room-page composer owns selection and current
 * Domain authority; this helper deliberately performs neither another product
 * query nor retired authorization.
 */
export async function projectConversationProtectedMessageDtoV2(
  row: ConversationProductDatabaseRow,
  authority: Pick<
    ConversationProtectedProductReadAuthority,
    "sessionId" | "roomId" | "namespaceId"
  >,
  crypto: ConversationProtectedCryptoReadPort,
): Promise<ConversationProtectedMessageDtoV2> {
  return Object.freeze({
    dtoVersion: 2 as const,
    projection: projection(row, authority),
    protectedPayload: await protectedPayload(
      row,
      authority.namespaceId,
      crypto,
    ),
  });
}

const SELECT_PUBLIC_MESSAGE_PROJECTION = `
  SELECT sm.id::int AS message_id,
         sm.session_id::text AS session_id,
         s.room_id::text AS room_id,
         r.namespace_id::text AS namespace_id,
         sm.role,
         sm.created_at,
         sm.edited_at,
         sm.edit_revision::int AS edit_revision,
         sm.fingerprint,
         sm.reply_to_message_id::int AS reply_to_message_id,
         sm.subthread_room_id::text AS subthread_room_id,
         sm.reply_count::int AS reply_count,
         sm.last_reply_at,
         sm.summary_revision::int AS summary_revision,
         s.owner_id::text AS source_user_id,
         s.agent_id::text AS author_agent_id,
         author_actor.id::text AS author_actor_id,
         CASE WHEN sm.role = 'user'
              THEN author_user.handle
              ELSE author_agent.handle
          END AS author_handle,
         author_actor.display_name AS author_display_name,
         sm.crypto_object_id,
         lifecycle.crypto_object_id AS lifecycle_object_id,
         lifecycle.payload_version::int AS payload_version,
         lifecycle.key_class,
         lifecycle.completion,
         lifecycle.disposition,
         lifecycle.parity_status
    FROM session_messages AS sm
    JOIN sessions AS s ON s.id = sm.session_id
    JOIN rooms AS r ON r.id = s.room_id
    LEFT JOIN session_message_crypto_revisions AS lifecycle
      ON lifecycle.session_id = sm.session_id
     AND lifecycle.message_id = sm.id
     AND lifecycle.edit_revision = sm.edit_revision
    LEFT JOIN users AS author_user ON author_user.id = s.owner_id
    LEFT JOIN agents AS author_agent ON author_agent.id = s.agent_id
    LEFT JOIN actors AS author_actor
      ON (
        sm.role = 'user'
        AND author_actor.kind = 'user'
        AND author_actor.owner_id = s.owner_id
      ) OR (
        sm.role <> 'user'
        AND author_actor.kind = 'agent'
        AND author_actor.agent_id = s.agent_id
      )`;

function sortedRows(
  rows: readonly ConversationProductDatabaseRow[],
): readonly ConversationProductDatabaseRow[] {
  return [...rows].sort((left, right) => {
    const leftTime = requiredDate(left, "created_at").getTime();
    const rightTime = requiredDate(right, "created_at").getTime();
    return leftTime - rightTime
      || requiredInteger(left, "message_id")
        - requiredInteger(right, "message_id");
  });
}

function validatedAuthority(
  authority: ConversationProtectedProductReadAuthority | null,
  expected: Readonly<{
    readonly sessionId: string;
    readonly namespaceId?: string;
  }>,
): ConversationProtectedProductReadAuthority {
  if (
    authority === null
    || authority.sessionId !== expected.sessionId
    || (
      expected.namespaceId !== undefined
      && authority.namespaceId !== expected.namespaceId
    )
  ) {
    throw new Error("Conversation protected read authorization is unavailable");
  }
  assertUuid("Conversation authorized Session ID", authority.sessionId);
  assertUuid("Conversation authorized Room ID", authority.roomId);
  assertUuid("Conversation authorized Namespace ID", authority.namespaceId);
  assertPortable("Conversation authorized Domain ID", authority.domainId);
  assertCounter(
    "Conversation authorized access revision",
    authority.expectedAccessRevision,
  );
  assertCounter(
    "Conversation authorized policy revision",
    authority.expectedPolicyRevision,
  );
  return Object.freeze({ ...authority });
}

async function records(
  rows: readonly ConversationProductDatabaseRow[],
  authority: ConversationProtectedProductReadAuthority,
  crypto: ConversationProtectedCryptoReadPort,
): Promise<readonly ProductReadRecord[]> {
  return Object.freeze(
    await Promise.all(
      sortedRows(rows).map((row) => record(row, authority, crypto)),
    ),
  );
}

export function createPostgresConversationProtectedReadPort(
  options: PostgresConversationProtectedReadOptions,
): ConversationProtectedProductReadPort<ConversationProtectedMessageDtoV2> {
  assertVerifiedConversationProductPostgresHandle(options.product);
  if (typeof options.authorize !== "function") {
    throw new TypeError(
      "Conversation protected read authorization resolver is required",
    );
  }

  const port:
    ConversationProtectedProductReadPort<ConversationProtectedMessageDtoV2> = {
    async readPage(input) {
      assertUuid("Conversation requested Session ID", input.sessionId);
      assertLimit(input.limit);
      if (input.beforeMessageId !== undefined) {
        assertPositiveInteger(
          "Conversation page cursor",
          input.beforeMessageId,
        );
      }
      const operation = Object.freeze({
        kind: "page" as const,
        ...input,
      });
      const authority = validatedAuthority(
        await options.authorize(operation),
        { sessionId: input.sessionId },
      );
      const rows = await options.product.query(
        `${SELECT_PUBLIC_MESSAGE_PROJECTION}
          WHERE sm.session_id = $1::uuid
            AND ($2::int IS NULL OR sm.id < $2::int)
          ORDER BY sm.created_at DESC, sm.id DESC
          LIMIT $3::int`,
        [input.sessionId, input.beforeMessageId ?? null, input.limit],
      );
      return records(rows, authority, options.crypto);
    },

    async readAround(input) {
      assertUuid("Conversation requested Session ID", input.sessionId);
      assertPositiveInteger("Conversation around anchor", input.messageId);
      if (
        !Number.isSafeInteger(input.radius)
        || input.radius < 0
        || input.radius > MAXIMUM_READ_BATCH
      ) {
        throw new RangeError(
          "Conversation protected around radius is out of bounds",
        );
      }
      const operation = Object.freeze({
        kind: "around" as const,
        ...input,
      });
      const authority = validatedAuthority(
        await options.authorize(operation),
        { sessionId: input.sessionId },
      );
      const rows = await options.product.query(
        `WITH protected_window AS (
           (${SELECT_PUBLIC_MESSAGE_PROJECTION}
              WHERE sm.session_id = $1::uuid
                AND sm.id <= $2::int
              ORDER BY sm.created_at DESC, sm.id DESC
              LIMIT $3::int)
           UNION ALL
           (${SELECT_PUBLIC_MESSAGE_PROJECTION}
              WHERE sm.session_id = $1::uuid
                AND sm.id > $2::int
              ORDER BY sm.created_at ASC, sm.id ASC
              LIMIT $4::int)
         )
         SELECT * FROM protected_window
         ORDER BY created_at ASC, message_id ASC`,
        [input.sessionId, input.messageId, input.radius + 1, input.radius],
      );
      return records(rows, authority, options.crypto);
    },

    async readAgentTranscript(input): Promise<
      ConversationProtectedAgentReadBatch<ConversationProtectedMessageDtoV2>
    > {
      assertUuid("Conversation requested Session ID", input.sessionId);
      assertUuid("Conversation requested Namespace ID", input.namespaceId);
      assertLimit(input.limit);
      if (input.upToMessageId !== undefined) {
        assertPositiveInteger(
          "Conversation Agent transcript upper bound",
          input.upToMessageId,
        );
      }
      const operation = Object.freeze({
        kind: "agent_transcript" as const,
        ...input,
      });
      const authority = validatedAuthority(
        await options.authorize(operation),
        {
          sessionId: input.sessionId,
          namespaceId: input.namespaceId,
        },
      );
      const rows = await options.product.query(
        `${SELECT_PUBLIC_MESSAGE_PROJECTION}
          WHERE sm.session_id = $1::uuid
            AND ($2::int IS NULL OR sm.id <= $2::int)
          ORDER BY sm.created_at DESC, sm.id DESC
          LIMIT $3::int`,
        [input.sessionId, input.upToMessageId ?? null, input.limit],
      );
      return Object.freeze({
        sessionId: authority.sessionId,
        roomId: authority.roomId,
        namespaceId: authority.namespaceId,
        domainId: authority.domainId,
        expectedAccessRevision: authority.expectedAccessRevision,
        expectedPolicyRevision: authority.expectedPolicyRevision,
        messages: await records(rows, authority, options.crypto),
      });
    },
  };
  return Object.freeze(port);
}
