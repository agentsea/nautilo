import { randomUUID } from "node:crypto";

import type { PostgresJsBridgeConnection } from "@nautilo/db";
import type {
  TaskRuntimeCancellationResultProof,
  TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  claimTaskRuntimeBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  markBackgroundAuthorizationRunning,
  parseBackgroundAuthorizationRecord,
  sameBackgroundAuthorizationRecord,
  sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
} from "@nautilo/runtime";
import type { ProtectedTaskCancellationAuthorityPort } from
  "./protected-task-cancellation-authority";
import type { ProtectedTaskCancellationPlan } from
  "./protected-task-cancellation-plan";
import type { ProtectedTaskCancellationPublication } from
  "./protected-task-cancellation-publication";
import {
  acceptedTaskRuntimeRecord,
  copyProtectedTaskRuntimeAuthority,
  destroyAcceptedTaskRuntimeRecord,
  destroyProtectedTaskRuntimeAuthority,
} from "./task-runtime-current-authority";

type Repository = Pick<
  BackgroundAuthorizationTaskRuntimeReplacementRepository,
  "get" | "compareAndSwap"
>;

export type ProtectedTaskCancellationClaimInput = Readonly<{
  plan: ProtectedTaskCancellationPlan;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  /** Caller-owned connection. It remains usable after authority callbacks release their locks. */
  restricted: PostgresJsBridgeConnection;
  signal: AbortSignal;
}>;

export type ProtectedTaskCancellationClaimDependencies = Readonly<{
  authority: ProtectedTaskCancellationAuthorityPort;
  recipients: Pick<TaskRuntimeRecipientRegistry,
    "withOpenedCancellationResultGrant" | "delete">;
  repository(restricted: PostgresJsBridgeConnection): Promise<Repository>;
  publish: ProtectedTaskCancellationPublication;
  now?: () => number;
  claimId?: () => string;
}>;

function cancellationRecord(
  record: BackgroundAuthorizationRecord | null,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record !== null
    && record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.workKind === "task.cancel_result"
    && record.purpose === "task.cancel_result";
}

function exactPlan(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  plan: ProtectedTaskCancellationPlan,
): boolean {
  return cancellationRecord(record) && cancellationRecord(plan.initialRecord)
    && plan.intent.taskStatus === "cancelled"
    && plan.intent.runStatus === "cancelled"
    && plan.intent.resultRevision === 2
    && record.snapshot.requestId === plan.initialRecord.snapshot.requestId
    && record.snapshot.workId === plan.intent.taskRunId
    && record.snapshot.namespaceId === plan.intent.contentNamespaceId
    && record.expectedPolicyRevision === plan.intent.policyRevision
    && record.idempotencyKey === plan.initialRecord.idempotencyKey
    && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord);
}

function exactRunningRecord(
  current: BackgroundAuthorizationRecord | null,
  expected: BackgroundAuthorizationTaskRuntimeRecordV3,
  claimId: string,
  now: number,
): current is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return Number.isSafeInteger(now)
    && expected.snapshot.claimExpiresAt !== null
    && now >= expected.snapshot.updatedAt
    && now < expected.snapshot.claimExpiresAt
    && cancellationRecord(current)
    && current.snapshot.state === "running"
    && current.snapshot.claimId === claimId
    && current.snapshot.claimExpiresAt === expected.snapshot.claimExpiresAt
    && current.snapshot.recipientGeneration
      === expected.snapshot.recipientGeneration
    && current.snapshot.requestRevision === expected.snapshot.requestRevision
    && sameBackgroundAuthorizationRecord(current, expected);
}

/**
 * Claims and publishes only the fixed stopped-Task result. It never constructs
 * an execution occurrence, Job, model input, or executor.
 */
export function createProtectedTaskCancellationClaim(
  dependencies: ProtectedTaskCancellationClaimDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const createClaimId = dependencies.claimId ?? randomUUID;

  return async (
    input: ProtectedTaskCancellationClaimInput,
  ): Promise<BackgroundAuthorizationTaskRuntimeRecordV3 | null> => {
    const selected = parseBackgroundAuthorizationRecord(input.record);
    if (!cancellationRecord(selected)
      || selected.snapshot.state !== "grant_ready"
      || !exactPlan(selected, input.plan)
      || selected.descriptorBytes === null) return null;
    const accepted = acceptedTaskRuntimeRecord(selected);
    if (accepted === null) return null;
    const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
      selected.descriptorBytes,
    );
    if (request === null) {
      destroyAcceptedTaskRuntimeRecord(accepted);
      return null;
    }
    const recipient = selected.snapshot.recipient;
    const material = selected.acceptedMaterial;
    const namespace = selected.authoritySet.namespaceRequirements[0];
    const domain = selected.authoritySet.domainRequirements[0];
    const claimId = createClaimId();
    const lifecycle: {
      publicAuthority: ReturnType<typeof copyProtectedTaskRuntimeAuthority> | null;
      runningRecord: BackgroundAuthorizationTaskRuntimeRecordV3 | null;
    } = { publicAuthority: null, runningRecord: null };
    try {
      if (recipient === null || material === null || namespace === undefined
        || domain === undefined
        || selected.authoritySet.namespaceRequirements.length !== 1
        || selected.authoritySet.domainRequirements.length !== 1
        || namespace.ordinal !== 0 || domain.ordinal !== 0
        || namespace.domainId !== domain.domainId
        || namespace.operations.length !== 1
        || namespace.operations[0] !== "encrypt"
        || request.requestId !== selected.snapshot.requestId
        || request.workId !== input.plan.intent.taskRunId
        || request.workKind !== "task.cancel_result"
        || request.workPurpose !== "task.cancel_result"
        || request.sourceRoomId !== input.plan.sourceRoomId
        || request.recipientGeneration !== selected.snapshot.recipientGeneration
        || request.recipientKeyId !== recipient.recipientKeyId
        || request.deadlineAt !== recipient.expiresAt
        || accepted.requestId !== request.requestId
        || accepted.recipientGeneration !== request.recipientGeneration
        || accepted.recipientKeyId !== request.recipientKeyId) return null;
      input.signal.throwIfAborted();
      const subject = Object.freeze({
        userId: input.plan.intent.requesterUserId,
        humanActorId: accepted.issuingHumanId,
        deviceId: accepted.issuingDeviceId,
      });
      let scopedRepository: Repository | null = null;
      const assertScopedRunning = async () => {
        input.signal.throwIfAborted();
        const expected = lifecycle.runningRecord;
        const repository = scopedRepository;
        if (expected === null || repository === null
          || !exactRunningRecord(
            await repository.get(expected.snapshot.requestId),
            expected,
            claimId,
            now(),
          )) throw new Error("Cancellation result claim is no longer current");
      };
      const held = await dependencies.authority.withAccepted({
        intent: input.plan.intent,
        subject,
        accepted,
        restricted: input.restricted,
        signal: input.signal,
        validateBeforeCommit: async () => {
          input.signal.throwIfAborted();
          // The owner invokes this once before lending its scoped connection.
          if (lifecycle.runningRecord !== null) await assertScopedRunning();
        },
        use: async (current, _product, restricted) => {
          scopedRepository = await dependencies.repository(restricted);
          const loaded = await scopedRepository.get(selected.snapshot.requestId);
          if (!cancellationRecord(loaded)
            || loaded.snapshot.state !== "grant_ready"
            || !sameBackgroundAuthorizationRecord(loaded, selected)) return null;
          const claimedAt = now();
          if (!Number.isSafeInteger(claimedAt)
            || claimedAt < request.issuedAt
            || claimedAt >= request.deadlineAt
            || claimedAt >= recipient.expiresAt
            || claimedAt >= material.authorizationExpiresAt) return null;
          const claimed = parseBackgroundAuthorizationRecord({
            ...loaded,
            snapshot: claimTaskRuntimeBackgroundAuthorizationRequest(
              loaded.snapshot,
              { claimId, now: claimedAt,
                requestDeadlineAt: request.deadlineAt,
                authorizationExpiresAt: material.authorizationExpiresAt },
            ),
          });
          if (!cancellationRecord(claimed)) {
            throw new TypeError("Cancellation claim changed credential family");
          }
          const claimedResult = await scopedRepository.compareAndSwap({
            expectedRequestRevision: loaded.snapshot.requestRevision,
            next: claimed,
          });
          if (claimedResult.status !== "updated"
            || !sameBackgroundAuthorizationRecord(claimedResult.record, claimed)) return null;
          const runningAt = now();
          if (!Number.isSafeInteger(runningAt)
            || runningAt < claimedAt
            || claimed.snapshot.claimExpiresAt === null
            || runningAt >= claimed.snapshot.claimExpiresAt) {
            throw new Error("Cancellation result claim expired before start");
          }
          const running = parseBackgroundAuthorizationRecord({
            ...claimed,
            snapshot: markBackgroundAuthorizationRunning(
              claimed.snapshot,
              runningAt,
            ),
          });
          if (!cancellationRecord(running)) {
            throw new TypeError("Cancellation start changed credential family");
          }
          const runningResult = await scopedRepository.compareAndSwap({
            expectedRequestRevision: claimed.snapshot.requestRevision,
            next: running,
          });
          if (runningResult.status !== "updated"
            || !sameBackgroundAuthorizationRecord(runningResult.record, running)) {
            throw new Error("Cancellation result start could not be recorded");
          }
          lifecycle.runningRecord = running;
          await assertScopedRunning();
          lifecycle.publicAuthority = copyProtectedTaskRuntimeAuthority(current, false);
          return true;
        },
      });
      const runningRecord = lifecycle.runningRecord;
      const publicAuthority = lifecycle.publicAuthority;
      if (held !== true || runningRecord === null || publicAuthority === null) return null;

      const rootRepository = await dependencies.repository(input.restricted);
      const assertCurrentClaim = async () => {
        input.signal.throwIfAborted();
        if (!exactRunningRecord(
          await rootRepository.get(runningRecord.snapshot.requestId),
          runningRecord,
          claimId,
          now(),
        )) throw new Error("Cancellation result claim is no longer current");
      };
      await assertCurrentClaim();
      const claimExpiresAt = runningRecord.snapshot.claimExpiresAt;
      if (claimExpiresAt === null) {
        throw new Error("Cancellation result claim expiry is unavailable");
      }
      const proof: TaskRuntimeCancellationResultProof = Object.freeze({
        taskId: input.plan.intent.taskId,
        taskRunId: input.plan.intent.taskRunId,
        contentRevision: 2,
        objectId: input.plan.intent.resultObjectId,
        signerAgentId: input.plan.intent.agentId,
        namespace: Object.freeze({
          namespaceId: namespace.namespaceId,
          domainId: namespace.domainId,
          operations: Object.freeze(["encrypt"] as const),
          expectedAccessRevision: namespace.expectedAccessRevision,
          expectedPolicyRevision: namespace.expectedPolicyRevision,
        }),
      });
      const opened = await dependencies.recipients.withOpenedCancellationResultGrant({
        requestId: request.requestId,
        workId: request.workId,
        recipientGeneration: runningRecord.snapshot.recipientGeneration,
        recipientKeyId: request.recipientKeyId,
        claimId,
        claimExpiresAt,
        authorizationBytes: material.responseBytes,
        current: publicAuthority.foreground,
        currentNamespaceRequirements: publicAuthority.namespaceRequirements,
        result: proof,
        signal: input.signal,
        operation: async (domains, signal, evidence) => {
          await assertCurrentClaim();
          await dependencies.publish({
            plan: input.plan,
            record: runningRecord,
            domains,
            evidence,
            signal,
            assertCurrentClaim,
          });
        },
      });
      if (opened.status !== "opened") {
        throw new Error("Cancellation result authorization could not be opened");
      }
      await assertCurrentClaim();
      const completedAt = now();
      if (!Number.isSafeInteger(completedAt)
        || runningRecord.snapshot.claimExpiresAt === null
        || completedAt < runningRecord.snapshot.updatedAt
        || completedAt >= runningRecord.snapshot.claimExpiresAt) {
        throw new Error("Cancellation result claim expired before completion");
      }
      const completed = parseBackgroundAuthorizationRecord({
        ...runningRecord,
        snapshot: completeBackgroundAuthorizationRequest(
          runningRecord.snapshot,
          completedAt,
        ),
        finishedAt: completedAt,
      });
      if (!cancellationRecord(completed)) {
        throw new TypeError("Cancellation completion changed credential family");
      }
      let stored: BackgroundAuthorizationRecord | null;
      try {
        const result = await rootRepository.compareAndSwap({
          expectedRequestRevision: runningRecord.snapshot.requestRevision,
          next: completed,
        });
        stored = result.status === "updated" ? result.record : result.current;
      } catch {
        stored = await rootRepository.get(completed.snapshot.requestId);
      }
      if (!cancellationRecord(stored)
        || !sameBackgroundAuthorizationRecord(stored, completed)) {
        throw new Error("Cancellation result completion could not be recorded");
      }
      dependencies.recipients.delete(
        completed.snapshot.requestId,
        completed.snapshot.recipientGeneration,
      );
      return completed;
    } finally {
      if (lifecycle.publicAuthority !== null) {
        destroyProtectedTaskRuntimeAuthority(lifecycle.publicAuthority);
      }
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
      destroyAcceptedTaskRuntimeRecord(accepted);
    }
  };
}
