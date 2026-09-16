import {
  and,
  eq,
  sessionMessages,
} from "@nautilo/db";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import type { LatticeCrypto, LatticeStorage } from "@nautilo/lattice-crypto";
import {
  encodeProtectedMessageDtoV2,
  parseProtectedMessageDtoV2,
  type ProtectedMessageDtoV2,
} from "@nautilo/types";

import { encodeMessagePayloadV2 } from "../../message/message-payload-v2.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
} from "./postgres-conversation-product-store.ts";

export type HumanLiveShadowCommittedReplay =
  | Readonly<{
      status: "replayed";
      representationMode: "shadow_encryption";
      messageId: number;
      content: string;
      protectedMessage: ProtectedMessageDtoV2;
      jobId: string | null;
    }>
  | Readonly<{
      status: "replayed";
      representationMode: "full_encryption";
      messageId: number;
      protectedMessage: ProtectedMessageDtoV2;
      jobId: string | null;
    }>
  | Readonly<{ status: "absent" | "conflict" }>;

function one(rows: readonly PostgresJsBridgeRow[]): PostgresJsBridgeRow | null {
  return rows.length === 1 ? rows[0]! : null;
}

function text(row: PostgresJsBridgeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Live Shadow replay ${key} is invalid`);
  }
  return value;
}

function nullableText(row: PostgresJsBridgeRow, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function counter(row: PostgresJsBridgeRow, key: string, minimum = 0): number {
  const raw = row[key];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(?:0|[1-9]\d*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`Live Shadow replay ${key} is invalid`);
  }
  return value as number;
}

function bytes(row: PostgresJsBridgeRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError(`Live Shadow replay ${key} is invalid`);
  }
  return value.slice();
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function encoded(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Recover only a previously authenticated Human live publication. The exact
 * complete request/plan/Grant digests are durable; changed retry bytes never
 * acquire a new recipient or a second product append.
 */
export async function inspectPostgresHumanLiveShadowReplay(input: Readonly<{
  product: PostgresJsBridgeConnection;
  storage: Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
  crypto: LatticeCrypto;
  operationId: string;
  expectedContent: string;
  planBytes: Uint8Array;
  requestBytes: Uint8Array;
  grantBytes: Uint8Array;
}>): Promise<HumanLiveShadowCommittedReplay> {
  const row = one(await input.product.query(
    `/* m282_live_shadow_human_replay */
     SELECT t.operation_id, t.session_id, t.room_id, t.namespace_id,
            t.agent_id, t.human_message_id, t.human_message_created_at,
            t.plan_digest, t.human_request_digest, t.grant_digest, t.job_id,
            t.state, t.policy_revision, l.crypto_object_id, l.completion, l.disposition,
            l.parity_status, l.author_role, l.representation_mode,
            l.publication_policy_revision, sm.role,
            sm.edit_revision, sm.crypto_object_id AS mapped_object_id
       FROM conversation_shadow_turn_operations t
       JOIN session_message_crypto_revisions l
         ON l.shadow_operation_id = t.operation_id
        AND l.shadow_transcript_ordinal = 1
       JOIN session_messages sm
         ON sm.session_id = l.session_id
        AND sm.id = l.message_id
        AND sm.edit_revision = l.edit_revision
      WHERE t.operation_id = $1
      LIMIT 2`,
    [input.operationId],
  ));
  if (row === null) return Object.freeze({ status: "absent" as const });
  if (
    !["human_verified", "running", "completed", "client_verified", "fallback", "failed"]
      .includes(text(row, "state"))
    || text(row, "role") !== "user"
    || text(row, "author_role") !== "user"
    || counter(row, "edit_revision") !== 0
    || text(row, "completion") !== "complete"
    || text(row, "disposition") !== "mapped"
    || text(row, "mapped_object_id") !== text(row, "crypto_object_id")
  ) return Object.freeze({ status: "conflict" as const });
  const representationMode = text(row, "representation_mode");
  if (
    (representationMode === "shadow_encryption"
      && text(row, "parity_status") !== "client_verified")
    || (representationMode === "full_encryption"
      && (text(row, "parity_status") !== "client_authenticated"
        || counter(row, "publication_policy_revision", 1) !== counter(row, "policy_revision", 1)))
    || (representationMode !== "shadow_encryption" && representationMode !== "full_encryption")
  ) return Object.freeze({ status: "conflict" as const });
  if (representationMode === "shadow_encryption") {
    const ordinary = one(await executeTypedConversationProductQuery(
      input.product,
      conversationProductTypedDb.select({ content: sessionMessages.content })
        .from(sessionMessages).where(and(
          eq(sessionMessages.sessionId, text(row, "session_id")),
          eq(sessionMessages.id, counter(row, "human_message_id", 1)),
          eq(sessionMessages.editRevision, 0),
        )).limit(2),
    ));
    if (ordinary === null || text(ordinary, "content") !== input.expectedContent) {
      return Object.freeze({ status: "conflict" as const });
    }
  }

  const expected = [
    [bytes(row, "plan_digest"), input.crypto.hash(input.planBytes)],
    [bytes(row, "human_request_digest"), input.crypto.hash(input.requestBytes)],
    [bytes(row, "grant_digest"), input.crypto.hash(input.grantBytes)],
  ] as const;
  try {
    if (expected.some(([stored, actual]) => !equal(stored, actual))) {
      return Object.freeze({ status: "conflict" as const });
    }
  } finally {
    expected.forEach(([stored, actual]) => {
      stored.fill(0);
      actual.fill(0);
    });
  }

  const objectId = text(row, "crypto_object_id");
  const [object, access] = await Promise.all([
    input.storage.getObject(objectId),
    input.storage.getObjectAccessState(objectId),
  ]);
  if (
    object === null
    || access === null
    || object.objectId !== objectId
    || access.head.objectId !== objectId
  ) return Object.freeze({ status: "conflict" as const });
  const envelopes = access.namespaceEnvelopes.filter(
    (candidate) => candidate.namespaceId === text(row, "namespace_id"),
  );
  try {
    if (envelopes.length !== 1) {
      return Object.freeze({ status: "conflict" as const });
    }
    const protectedMessage = parseProtectedMessageDtoV2({
      dtoVersion: 2,
      projection: {
        messageId: String(counter(row, "human_message_id", 1)),
        sessionId: text(row, "session_id"),
        roomId: text(row, "room_id"),
        namespaceId: text(row, "namespace_id"),
        role: "user",
        createdAt: (row["human_message_created_at"] as Date).toISOString(),
        editRevision: 0,
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: objectId,
        payloadVersion: 2,
        keyClass: "ai",
        encryptedPayloadBytesBase64url: encoded(object.payloadBytes),
        accessManifestBytesBase64url: encoded(access.head.manifestBytes),
        namespaceEnvelopeBytesBase64url: encoded(envelopes[0]!.envelopeBytes),
      },
    });
    // Force the ordinary profile through the same canonical encoder used by
    // the original admission before exposing the replay.
    const ordinary = encodeMessagePayloadV2({
      role: "user",
      content: input.expectedContent,
    });
    const dtoBytes = new TextEncoder().encode(
      encodeProtectedMessageDtoV2(protectedMessage),
    );
    ordinary.fill(0);
    dtoBytes.fill(0);
    return representationMode === "full_encryption" ? Object.freeze({
      status: "replayed" as const,
      representationMode: "full_encryption" as const,
      messageId: counter(row, "human_message_id", 1),
      protectedMessage,
      jobId: nullableText(row, "job_id"),
    }) : Object.freeze({
      status: "replayed" as const,
      representationMode: "shadow_encryption" as const,
      messageId: counter(row, "human_message_id", 1),
      content: input.expectedContent,
      protectedMessage,
      jobId: nullableText(row, "job_id"),
    });
  } finally {
    object.payloadBytes.fill(0);
    access.head.manifestBytes.fill(0);
    access.namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
  }
}
