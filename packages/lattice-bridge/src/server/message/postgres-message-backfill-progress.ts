import { messageBackfillFailures, sql } from "@nautilo/db";

import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresExecutor,
} from "./postgres-conversation-product-store.ts";
import { messageBackfillCandidateProjection } from
  "./postgres-message-backfill-discovery.ts";

export interface MessageBackfillProgressAggregate {
  readonly eligible: number;
  readonly pending: number;
  readonly alreadyAuthenticated: number;
  readonly independentlyParityVerified: number;
  readonly claimedRepairing: number;
  readonly repairedAndVerified: number;
  readonly unsupported: number;
  readonly failed: number;
}

export interface MessageBackfillProgressClaim {
  readonly action: "encrypt" | "verify" | "restore";
  readonly messageId: number;
  readonly sessionId: string;
  readonly revision: number;
  readonly sourceRoomId: string;
  readonly namespaceId: string;
  readonly role: string;
  readonly cryptoObjectId: string;
  readonly sourceRevision: number | null;
}

function count(row: ConversationProductDatabaseRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Message backfill ${key} must be a nonnegative integer`);
  }
  return value;
}

/**
 * Count current repair work without returning Message identifiers or content.
 * The candidate subquery is the same membership- and lifecycle-scoped
 * projection used by discovery; PostgreSQL reduces the complete corpus to one
 * aggregate row before it crosses the product boundary.
 */
export async function readMessageBackfillProgressAggregate(
  executor: ConversationProductPostgresExecutor,
  input: Readonly<{
    subjectHumanId: string;
    policyRevision: number;
    claimed?: MessageBackfillProgressClaim;
  }>,
): Promise<MessageBackfillProgressAggregate> {
  if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision <= 0) {
    throw new RangeError("Message backfill policy revision must be positive");
  }
  const candidate = messageBackfillCandidateProjection({
    subjectHumanId: input.subjectHumanId,
  }).as("message_backfill_progress_candidate");
  const candidateAlias = sql.identifier("message_backfill_progress_candidate");
  const candidateField = (name: string) =>
    sql`${candidateAlias}.${sql.identifier(name)}`;

  // This is exactly classifyMessageBackfillState(...).action === "none" for
  // the canonical projection. An exact lifecycle join makes coordinate
  // mismatch appear as a missing lifecycle, which is likewise stale_mapping.
  const noWork = sql<boolean>`(
    ${candidateField("supported_topology")} = TRUE
    AND ${candidateField("crypto_object_id")} IS NOT NULL
    AND ${candidateField("lifecycle_session_id")} IS NOT NULL
    AND ${candidateField("lifecycle_crypto_object_id")}
      IS NOT DISTINCT FROM ${candidateField("crypto_object_id")}
    AND ${candidateField("completion")} = 'complete'
    AND ${candidateField("disposition")} = 'mapped'
    AND ${candidateField("parity_status")} IN (
      'server_verified', 'client_verified',
      'server_authenticated', 'client_authenticated'
    )
    AND ${candidateField("ordinary_present")} = TRUE
    AND (
      ${candidateField("ordinary_restoration_accepted")} = TRUE
      OR ${candidateField("parity_status")} IN ('server_verified', 'client_verified')
    )
  )`;

  const validMapping = sql<boolean>`(
    ${candidateField("supported_topology")} = TRUE
    AND ${candidateField("crypto_object_id")} IS NOT NULL
    AND ${candidateField("lifecycle_session_id")} IS NOT NULL
    AND ${candidateField("lifecycle_crypto_object_id")}
      IS NOT DISTINCT FROM ${candidateField("crypto_object_id")}
    AND ${candidateField("completion")} = 'complete'
    AND ${candidateField("disposition")} = 'mapped'
  )`;

  const classifierFailure = sql<boolean>`(
    ${candidateField("supported_topology")} = FALSE
    OR CASE
      WHEN ${candidateField("crypto_object_id")} IS NULL THEN
        ${candidateField("ordinary_present")} = FALSE
        OR (
          ${candidateField("lifecycle_session_id")} IS NOT NULL
          AND NOT (
            ${candidateField("completion")} = 'pending'
            AND ${candidateField("disposition")} = 'active'
            AND ${candidateField("repair_identity_present")} = TRUE
          )
        )
      ELSE
        ${candidateField("lifecycle_session_id")} IS NULL
        OR ${candidateField("lifecycle_crypto_object_id")}
          IS DISTINCT FROM ${candidateField("crypto_object_id")}
        OR ${candidateField("completion")} IS DISTINCT FROM 'complete'
        OR ${candidateField("disposition")} IS DISTINCT FROM 'mapped'
        OR ${candidateField("parity_status")} IS NULL
        OR ${candidateField("parity_status")} NOT IN (
          'server_verified', 'client_verified',
          'server_authenticated', 'client_authenticated'
        )
    END
  )`;

  const currentCachedFailure = sql<boolean>`(
    ${messageBackfillFailures.messageId} IS NOT NULL
    AND ${messageBackfillFailures.editRevision} = ${candidateField("edit_revision")}
    AND ${messageBackfillFailures.namespaceAccessRevision}
      = ${candidateField("namespace_access_revision")}
    AND ${messageBackfillFailures.policyRevision} = ${input.policyRevision}
    AND ${messageBackfillFailures.cryptoObjectId}
      IS NOT DISTINCT FROM ${candidateField("crypto_object_id")}
    AND (
      ${candidateField("role")} <> 'tool'
      OR ${messageBackfillFailures.sourceRevision}
        = ${candidateField("message_source_revision")}
    )
    AND ${messageBackfillFailures.reason} <> 'unsupported'
  )`;

  const claimedCryptoMatches = input.claimed === undefined
    ? sql<boolean>`FALSE`
    : input.claimed.action === "encrypt" ? sql<boolean>`(
        ${candidateField("crypto_object_id")} IS NULL
        OR ${candidateField("crypto_object_id")}
          IS NOT DISTINCT FROM ${input.claimed.cryptoObjectId}
      )`
    : sql<boolean>`${candidateField("crypto_object_id")}
        IS NOT DISTINCT FROM ${input.claimed.cryptoObjectId}`;

  // PostgreSQL cannot infer a parameter type from `$n IS NULL`. Render claim
  // nullability as a SQL constant and bind only a concrete Tool generation.
  const claimedSourceMatches = input.claimed === undefined
    ? sql<boolean>`FALSE`
    : input.claimed.role === "tool"
      ? input.claimed.sourceRevision === null
        ? sql<boolean>`FALSE`
        : sql<boolean>`${candidateField("message_source_revision")}
            = ${input.claimed.sourceRevision}`
      : input.claimed.sourceRevision === null
        ? sql<boolean>`TRUE`
        : sql<boolean>`FALSE`;

  const claimedRepairing = input.claimed === undefined
    ? sql<number>`0::double precision`
    : sql<number>`COUNT(*) FILTER (WHERE
        NOT ${noWork}
        AND ${candidateField("supported_topology")} = TRUE
        AND NOT ${classifierFailure}
        AND NOT ${currentCachedFailure}
        AND ${candidateField("message_id")} = ${input.claimed.messageId}
        AND ${candidateField("session_id")} = ${input.claimed.sessionId}
        AND ${candidateField("edit_revision")} = ${input.claimed.revision}
        AND ${candidateField("source_room_id")} = ${input.claimed.sourceRoomId}
        AND ${candidateField("namespace_id")} = ${input.claimed.namespaceId}
        AND ${candidateField("role")} = ${input.claimed.role}
        AND ${claimedCryptoMatches}
        AND ${claimedSourceMatches}
      )::double precision`;

  const rows = await executeTypedConversationProductQuery(
    executor,
    conversationProductTypedDb.select({
      eligible: sql<number>`COUNT(*) FILTER (
        WHERE ${candidateField("supported_topology")} = TRUE
      )::double precision`.as("eligible"),
      pending: sql<number>`COUNT(*) FILTER (
        WHERE NOT ${noWork}
      )::double precision`
        .as("pending"),
      already_authenticated: sql<number>`COUNT(*) FILTER (WHERE
        ${validMapping}
        AND ${candidateField("parity_status")} IN (
          'server_authenticated', 'client_authenticated'
        )
      )::double precision`.as("already_authenticated"),
      independently_parity_verified: sql<number>`COUNT(*) FILTER (WHERE
        ${validMapping}
        AND ${candidateField("parity_status")} IN (
          'server_verified', 'client_verified'
        )
      )::double precision`.as("independently_parity_verified"),
      claimed_repairing: claimedRepairing.as("claimed_repairing"),
      repaired_and_verified: sql<number>`COUNT(*) FILTER (WHERE
        ${validMapping}
        AND ${candidateField("ordinary_present")} = TRUE
        AND (
          ${candidateField("repair_identity_present")} = TRUE
          OR ${candidateField("ordinary_restoration_accepted")} = TRUE
        )
        AND ${candidateField("parity_status")} IN (
          'server_verified', 'client_verified'
        )
      )::double precision`.as("repaired_and_verified"),
      unsupported: sql<number>`COUNT(*) FILTER (
        WHERE ${candidateField("supported_topology")} = FALSE
      )::double precision`.as("unsupported"),
      failed: sql<number>`COUNT(*) FILTER (
        WHERE NOT ${noWork}
          AND ${candidateField("supported_topology")} = TRUE
          AND (${classifierFailure} OR ${currentCachedFailure})
      )::double precision`.as("failed"),
    }).from(candidate).leftJoin(
      messageBackfillFailures,
      sql`${messageBackfillFailures.messageId} = ${candidateField("message_id")}`,
    ),
  );
  const row = rows[0];
  if (row === undefined || rows.length !== 1) {
    throw new TypeError("Message backfill progress aggregate must return one row");
  }
  return Object.freeze({
    eligible: count(row, "eligible"),
    pending: count(row, "pending"),
    alreadyAuthenticated: count(row, "already_authenticated"),
    independentlyParityVerified: count(
      row,
      "independently_parity_verified",
    ),
    claimedRepairing: count(row, "claimed_repairing"),
    repairedAndVerified: count(row, "repaired_and_verified"),
    unsupported: count(row, "unsupported"),
    failed: count(row, "failed"),
  });
}
