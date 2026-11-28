import {
  and,
  asc,
  encryptionTransitionPolicy,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  reflectionRecordAuthorityReconciliations,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPublications,
  reflectionRecords,
  reflectionDerivedRecoveryCursorKeySql,
  reflectionRecordSemanticWork,
  users,
} from "@nautilo/db";

import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresHandle,
} from "./product-postgres";

export interface DerivedRecordLineageRepairResult {
  readonly requeued: number;
  readonly scanned?: number;
  readonly nextCursor?: string;
}

/**
 * Re-arm pre-dispatch dependency checks on generated Records in place. This
 * command never opens payload or source text, changes a Record, binds a model,
 * or creates a billable generation. The ordinary worker remains the sole
 * owner of source access, authority, cycle, and publication revalidation.
 */
export async function repairBlockedDerivedRecordLineage(input: Readonly<{
  handle: RecordProductPostgresHandle;
  now: Date;
  observedThrough: Date;
  authorizedBy: string;
  page?: Readonly<{ after: string | null; limit: number }>;
}>): Promise<DerivedRecordLineageRepairResult> {
  assertVerifiedRecordProductPostgresHandle(input.handle);
  const now = input.now;
  const observedThrough = input.observedThrough;
  if (
    !(now instanceof Date)
    || !(observedThrough instanceof Date)
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(observedThrough.getTime())
    || observedThrough >= now
  ) throw new RangeError("derived Record repair timestamps are invalid");
  if (input.authorizedBy.trim().length === 0) {
    throw new TypeError("derived Record repair authorizer is invalid");
  }
  if (input.page !== undefined && (
    !Number.isSafeInteger(input.page.limit)
    || input.page.limit < 1
    || (input.page.after !== null
      && !/^derived:[0-9a-f]{64}$/.test(input.page.after))
  )) {
    throw new RangeError("derived Record repair page is invalid");
  }

  return input.handle.transaction(async (tx) => {
    const policy = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({
        mode: encryptionTransitionPolicy.mode,
      }).from(encryptionTransitionPolicy).limit(2).for("share"));
    if (policy.length !== 1 || policy[0]?.mode !== "plaintext_only") {
      return { requeued: 0 };
    }
    const operator = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.select({ id: users.id }).from(users).where(and(
        eq(users.id, input.authorizedBy),
        isNull(users.disabledAt),
      )).limit(2).for("share"));
    if (operator.length !== 1) {
      throw new Error("Derived Record repair authorizer is unavailable");
    }

    const ordinaryHead = recordProductTypedDb.select({
      recordId: reflectionRecordPayloadRepresentationHeads.recordId,
    }).from(reflectionRecordPayloadRepresentationHeads).where(and(
      eq(
        reflectionRecordPayloadRepresentationHeads.recordId,
        reflectionRecords.recordId,
      ),
      eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
    ));
    const protectedHead = recordProductTypedDb.select({
      recordId: reflectionRecordPayloadRepresentationHeads.recordId,
    }).from(reflectionRecordPayloadRepresentationHeads).where(and(
      eq(
        reflectionRecordPayloadRepresentationHeads.recordId,
        reflectionRecords.recordId,
      ),
      eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
    ));
    const pendingPublication = recordProductTypedDb.select({
      recordId: reflectionRecordPublications.recordId,
    }).from(reflectionRecordPublications).where(and(
      eq(reflectionRecordPublications.recordId, reflectionRecords.recordId),
      ne(reflectionRecordPublications.state, "complete"),
    ));
    const pendingReconciliation = recordProductTypedDb.select({
      recordId: reflectionRecordAuthorityReconciliations.recordId,
    }).from(reflectionRecordAuthorityReconciliations).where(and(
      eq(
        reflectionRecordAuthorityReconciliations.recordId,
        reflectionRecords.recordId,
      ),
      ne(reflectionRecordAuthorityReconciliations.state, "complete"),
    ));
    const eligibility = and(
      eq(reflectionRecords.recordId, reflectionRecordSemanticWork.recordId),
      eq(reflectionRecordSemanticWork.state, "quarantined"),
      eq(reflectionRecordSemanticWork.stage, "organization"),
      eq(reflectionRecordSemanticWork.changeReason, "dependency_lost"),
      eq(reflectionRecordSemanticWork.failureCode, "candidate_unavailable"),
      // Dependency revalidation also returns a plain candidate hold when
      // an upstream projection or exact source binding was unavailable.
      or(
        eq(reflectionRecordSemanticWork.failureDetail, "candidate_selection_invalid"),
        isNull(reflectionRecordSemanticWork.failureDetail),
      ),
      isNull(reflectionRecordSemanticWork.manualRecoveryId),
      lte(reflectionRecordSemanticWork.updatedAt, observedThrough),
      lt(reflectionRecordSemanticWork.updatedAt, now),
      isNull(reflectionRecordSemanticWork.claimGeneration),
      isNull(reflectionRecordSemanticWork.leaseToken),
      isNull(reflectionRecordSemanticWork.leaseExpiresAt),
      isNull(reflectionRecordSemanticWork.acceptedModelBinding),
      isNull(reflectionRecordSemanticWork.organizerProposalCheckpoint),
      eq(reflectionRecords.lifecycle, "current"),
      eq(reflectionRecords.disposition, "available"),
      gt(reflectionRecords.structuralHeight, 0),
      eq(reflectionRecords.producerPolicyVersion, "candidate-policy-v1"),
      exists(ordinaryHead),
      notExists(protectedHead),
      notExists(pendingPublication),
      notExists(pendingReconciliation),
    );
    const cursorKey = reflectionDerivedRecoveryCursorKeySql(
      reflectionRecordSemanticWork.recordId,
    );
    const candidateQuery = recordProductTypedDb.select({
      recordId: reflectionRecordSemanticWork.recordId,
      cursor: cursorKey.as("cursor"),
    }).from(reflectionRecordSemanticWork).innerJoin(
      reflectionRecords,
      eq(reflectionRecords.recordId, reflectionRecordSemanticWork.recordId),
    ).where(and(
      eligibility,
      input.page?.after
        ? gt(cursorKey, input.page.after)
        : undefined,
    )).orderBy(asc(cursorKey), asc(reflectionRecordSemanticWork.recordId)).for(
      "update",
      { of: reflectionRecordSemanticWork },
    );
    const candidates = await executeTypedRecordProductQuery(
      tx,
      input.page === undefined
        ? candidateQuery
        : candidateQuery.limit(input.page.limit),
    );
    if (candidates.length === 0) {
      return input.page === undefined
        ? { requeued: 0 }
        : { requeued: 0, scanned: 0 };
    }
    const candidateIds = candidates.map(candidate => candidate.record_id);
    const queued = await executeTypedRecordProductQuery(tx,
      recordProductTypedDb.update(reflectionRecordSemanticWork).set({
        recoverAfter: now,
        updatedAt: now,
      }).from(reflectionRecords).where(and(
        eligibility,
        inArray(reflectionRecordSemanticWork.recordId, candidateIds),
      )).returning({ recordId: reflectionRecordSemanticWork.recordId }));
    if (input.page === undefined) return { requeued: queued.length };
    const nextCursor = candidates.length === input.page.limit
      ? candidates.at(-1)?.cursor
      : undefined;
    return {
      requeued: queued.length,
      scanned: candidates.length,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }, { isolationLevel: "serializable" });
}
