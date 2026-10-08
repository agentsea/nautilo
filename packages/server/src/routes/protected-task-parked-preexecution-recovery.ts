import {
  recoverUnstartedParkedProtectedTaskRun,
  type DirectDatabase,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "@nautilo/db";
import {
  sameTaskRuntimeAuthorityPlan,
  sameBackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeDeferralRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import { classifyProtectedTaskPreexecutionAuthorization } from "./protected-task-preexecution-recovery";

/** The DB owner invokes grant deferral only after durable non-execution proof. */
export function createProtectedTaskParkedPreexecutionRecovery(input: Readonly<{
  db: DirectDatabase;
  repository: Pick<BackgroundAuthorizationTaskRuntimeDeferralRepository,
    "get" | "deferUnstartedTaskRuntimeRequest">;
  now(): number;
}>, recover = recoverUnstartedParkedProtectedTaskRun) {
  const recoverImmediate = async (
    start: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
    claimed: BackgroundAuthorizationTaskRuntimeRecordV3,
  ): Promise<boolean> => {
    const expected = structuredClone(claimed);
    const pinned = structuredClone(start);
    if (expected.snapshot.state !== "claimed"
      || expected.snapshot.claimId === null
      || expected.snapshot.requestId !== pinned.jobReference.authorizationRequestId
      || expected.snapshot.workId !== pinned.taskRunId
      || expected.expectedPolicyRevision !== pinned.jobReference.policyRevision) return false;
    const result = await recover(input.db, pinned, new Date(input.now()), async () => {
      const current = await input.repository.get(expected.snapshot.requestId);
      if (current === null || current.snapshot.formatVersion !== 3
        || current.authoritySet === undefined) return false;
      const taskRecord = current as BackgroundAuthorizationTaskRuntimeRecordV3;
      if (taskRecord.idempotencyKey !== expected.idempotencyKey
        || !sameTaskRuntimeAuthorityPlan(taskRecord, expected)
        || taskRecord.finishedAt !== null) return false;
      // A lost crypto response can precede the product reset. The canonical
      // deferral retains the work identity and advances only its recipient.
      const snapshot = taskRecord.snapshot;
      if (snapshot.state === "awaiting_recipient") {
        return snapshot.recipientGeneration === expected.snapshot.recipientGeneration + 1
          && snapshot.retryCount === expected.snapshot.retryCount
          && snapshot.lastRetryReason === "stale_authority"
          && snapshot.nextAttemptAt === snapshot.updatedAt
          && snapshot.recipient === null && snapshot.acceptedResponse === null
          && snapshot.claimId === null && snapshot.claimExpiresAt === null
          && snapshot.descriptorDigest === null
          && taskRecord.descriptorBytes === null && taskRecord.acceptedMaterial === null;
      }
      if ((snapshot.state !== "claimed" && snapshot.state !== "running")
        || snapshot.claimId !== expected.snapshot.claimId
        || snapshot.recipientGeneration !== expected.snapshot.recipientGeneration) return false;
      const deferred = await input.repository.deferUnstartedTaskRuntimeRequest({
        expected: taskRecord, now: input.now(),
      });
      return deferred.status === "deferred" || deferred.status === "exact_replay";
    });
    // Even if reset must be retried, ordinary Job failure cannot overwrite the
    // exact cancellation that has already proved no execution took place.
    return result.status !== "stale";
  };
  const recoverDiscovered = async (
    start: StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
    options: Readonly<{ immediate: boolean }>,
  ): Promise<Readonly<{ cancelled: boolean; reset: boolean; failed: boolean }>> => {
    const pinned = structuredClone(start);
    const selected = await input.repository.get(pinned.jobReference.authorizationRequestId);
    const observedAt = input.now();
    const classification = selected === null ? null
      : classifyProtectedTaskPreexecutionAuthorization(pinned, selected, observedAt);
    if (classification === null || selected === null
      || (classification === "active" && !options.immediate)) {
      return { cancelled: false, reset: false, failed: false };
    }
    const expected = selected as BackgroundAuthorizationTaskRuntimeRecordV3;
    const result = await recover(input.db, pinned, new Date(observedAt), async () => {
      if (classification === "deferred") {
        const current = await input.repository.get(expected.snapshot.requestId);
        return current !== null && sameBackgroundAuthorizationRecord(current, expected);
      }
      const deferred = await input.repository.deferUnstartedTaskRuntimeRequest({
        expected, now: input.now(),
      });
      return deferred.status === "deferred" || deferred.status === "exact_replay";
    });
    return {
      cancelled: result.status !== "stale",
      reset: result.status === "recovered" || result.status === "exact_replay",
      failed: result.status === "cancelled",
    };
  };
  return Object.assign(recoverImmediate, { recoverDiscovered });
}
