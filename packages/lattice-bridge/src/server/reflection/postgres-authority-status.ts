import {
  and,
  backgroundCryptoAuthorizationRequests,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  reflectionRecordAuthorityReconciliations,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import type { ReflectionProtectedAuthorityStatus } from "@nautilo/types";

import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

const REFLECTION_AUTHORITY_WORK_KINDS = [
  "reflection.authority_reproject",
  "reflection.publication_reconcile",
] as const;
const ACTIVE_STATES = [
  "awaiting_recipient",
  "awaiting_device",
  "grant_ready",
  "claimed",
  "running",
  "publication_reconciliation",
] as const;
const COUNT = sql<string>`COUNT(*)::text`.as("count");

function exactCount(value: unknown): string {
  const text = typeof value === "bigint" ? value.toString() : value;
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/u.test(text)) {
    throw new TypeError("Invalid Reflection authority status count");
  }
  return text;
}

function add(left: string, right: unknown): string {
  return (BigInt(left) + BigInt(exactCount(right))).toString();
}

/** Aggregate-only PR1 health. Product receipts and the restricted crypto
 * request ledger stay on their separate database authorities. */
export async function readPostgresReflectionAuthorityStatus(input: Readonly<{
  product: DirectDatabase;
  crypto: CryptoPostgresHandle;
  now: Date;
  since: Date;
  until: Date;
}>): Promise<ReflectionProtectedAuthorityStatus> {
  assertVerifiedCryptoPostgresHandle(input.crypto);
  const { now, since, until } = input;
  if (
    ![now, since, until].every((value) => Number.isFinite(value.getTime()))
    || since > until
    || until > now
  ) {
    throw new TypeError("Invalid Reflection authority status window");
  }

  const request = backgroundCryptoAuthorizationRequests;
  const currentRows = await executeTypedCryptoQuery(
    input.crypto,
    cryptoTypedDb.select({ state: request.state, count: COUNT })
      .from(request)
      .where(and(
        eq(request.formatVersion, 2),
        eq(request.credentialSubjectKind, "processor"),
        eq(request.processorKind, "reflection"),
        inArray(request.workKind, REFLECTION_AUTHORITY_WORK_KINDS),
        inArray(request.state, ACTIVE_STATES),
      ))
      .groupBy(request.state),
  );
  const terminalRows = await executeTypedCryptoQuery(
    input.crypto,
    cryptoTypedDb.select({ count: COUNT })
      .from(request)
      .where(and(
        eq(request.formatVersion, 2),
        eq(request.credentialSubjectKind, "processor"),
        eq(request.processorKind, "reflection"),
        inArray(request.workKind, REFLECTION_AUTHORITY_WORK_KINDS),
        inArray(request.state, ["cancelled", "terminal_failure"]),
        gte(request.finishedAt, since),
        lte(request.finishedAt, until),
      )),
  );

  const receipt = reflectionRecordAuthorityReconciliations;
  const [receiptRow] = await input.product.select({
    verified_authority: sql<string>`COUNT(*) FILTER (
      WHERE ${receipt.state} = 'complete'
      AND ${isNotNull(receipt.targetCryptoObjectId)}
      AND ${isNotNull(receipt.targetRepresentationGeneration)}
      AND ${isNotNull(receipt.targetAccessNamespaceIds)}
      AND ${isNotNull(receipt.targetAudienceSetCommitment)}
    )::text`,
    reconciliation_pending: sql<string>`COUNT(*) FILTER (
      WHERE ${receipt.state} IN ('crypto_complete', 'attached')
      AND ${isNotNull(receipt.targetCryptoObjectId)}
      AND ${isNotNull(receipt.targetRepresentationGeneration)}
      AND ${isNotNull(receipt.targetAccessNamespaceIds)}
      AND ${isNotNull(receipt.targetAudienceSetCommitment)}
    )::text`,
    retirement_pending: sql<string>`COUNT(*) FILTER (WHERE
      ${isNotNull(receipt.targetCryptoObjectId)}
      AND ${isNotNull(receipt.targetRepresentationGeneration)}
      AND ((
      ${receipt.state} = 'complete'
      AND ${isNotNull(receipt.targetAccessNamespaceIds)}
      AND ${isNotNull(receipt.targetAudienceSetCommitment)}
      AND ${isNotNull(receipt.formerCryptoObjectId)}
      AND ${isNull(receipt.formerCryptoRetiredAt)}
    ) OR (
      ${receipt.state} = 'quarantined'
      AND ${isNull(receipt.targetCryptoRetiredAt)}
    )))::text`,
    terminal_or_stale: sql<string>`COUNT(*) FILTER (
      WHERE ${receipt.state} = 'quarantined'
      AND ${isNotNull(receipt.targetCryptoObjectId)}
      AND ${isNotNull(receipt.targetRepresentationGeneration)}
    )::text`,
    verified_authority_window: sql<string>`COUNT(*) FILTER (WHERE
      ${receipt.state} = 'complete'
      AND ${isNotNull(receipt.targetCryptoObjectId)}
      AND ${isNotNull(receipt.targetRepresentationGeneration)}
      AND ${isNotNull(receipt.targetAccessNamespaceIds)}
      AND ${isNotNull(receipt.targetAudienceSetCommitment)}
      AND ${gte(receipt.completedAt, since)}
      AND ${lte(receipt.completedAt, until)}
    )::text`,
    stale_window: sql<string>`COUNT(*) FILTER (WHERE
      ${receipt.state} = 'quarantined'
      AND ${isNotNull(receipt.targetCryptoObjectId)}
      AND ${isNotNull(receipt.targetRepresentationGeneration)}
      AND ${gte(receipt.updatedAt, since)}
      AND ${lte(receipt.updatedAt, until)}
    )::text`,
  }).from(receipt);
  if (receiptRow === undefined) {
    throw new TypeError("Reflection authority receipt aggregate is absent");
  }

  const current = {
    awaitingRecipient: "0",
    awaitingEligibleDeviceAndKeys: "0",
    readyOrRunning: "0",
    reconciliationPending: exactCount(receiptRow.reconciliation_pending),
    retirementPending: exactCount(receiptRow.retirement_pending),
    verifiedAuthority: exactCount(receiptRow.verified_authority),
    terminalOrStale: exactCount(receiptRow.terminal_or_stale),
  };
  for (const row of currentRows) {
    if (row.state === "awaiting_recipient") {
      current.awaitingRecipient = add(current.awaitingRecipient, row.count);
    } else if (row.state === "awaiting_device") {
      current.awaitingEligibleDeviceAndKeys = add(
        current.awaitingEligibleDeviceAndKeys,
        row.count,
      );
    } else if (
      row.state === "grant_ready"
      || row.state === "claimed"
      || row.state === "running"
    ) {
      current.readyOrRunning = add(current.readyOrRunning, row.count);
    } else if (row.state === "publication_reconciliation") {
      current.reconciliationPending = add(
        current.reconciliationPending,
        row.count,
      );
    } else {
      throw new TypeError("Invalid Reflection authority queue state");
    }
  }

  const requestTerminal = terminalRows[0] === undefined
    ? "0"
    : exactCount(terminalRows[0].count);
  return {
    dtoVersion: 1,
    scope: "authority_maintenance_only",
    current,
    last24h: {
      verifiedAuthority: exactCount(receiptRow.verified_authority_window),
      terminalOrStale: add(requestTerminal, receiptRow.stale_window),
    },
  };
}
