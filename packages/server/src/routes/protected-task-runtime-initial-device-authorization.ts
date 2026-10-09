import type { TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  matchesCurrentTaskRuntimeAuthority,
  matchesStenographerRequestAdmission,
} from "@nautilo/lattice-bridge/server";
import {
  sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BindTaskRuntimeRecipientResult,
  type ProtectedTaskOccurrence,
  type TaskRuntimeGrantClaimPlan,
  type TaskRuntimeRecipientAuthorityPort,
} from "@nautilo/runtime";

import type { createProductionBackgroundAuthorizationComposition } from
  "./background-authorization-composition";
import type {
  ProtectedTaskRuntimeRecipientAuthorityPort,
} from "./protected-task-runtime-recipient-authority";

type DeviceHooks = Required<Pick<NonNullable<Parameters<
  typeof createProductionBackgroundAuthorizationComposition
>[0]>, "bindTaskRecipient" | "withTaskAuthority" | "isTaskRecipientActive">>;

type InitialClaim = Readonly<{
  bindAwaitingRecipientForDevice(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    binding: Readonly<{
      userId: string;
      humanActorId: string;
      deviceId: string;
    }>;
    withCurrentAuthority: TaskRuntimeRecipientAuthorityPort;
  }>): Promise<BindTaskRuntimeRecipientResult>;
}>;

export type ProtectedTaskRuntimeInitialDeviceAuthorizationInput = Readonly<{
  recipients: TaskRuntimeRecipientRegistry;
  claim: InitialClaim;
  plan(occurrence: ProtectedTaskOccurrence): Promise<TaskRuntimeGrantClaimPlan>;
  resolveOccurrence(input: Readonly<{
    taskRunId: string;
    authorizationRequestId: string;
  }>): Promise<ProtectedTaskOccurrence | null>;
  /** Canonical native authority owner, supporting awaiting and bound phases. */
  withRecipientAuthority: ProtectedTaskRuntimeRecipientAuthorityPort;
  now?: () => number;
}>;

type ResolvedInitial = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  plan: TaskRuntimeGrantClaimPlan;
}>;

function exactInitialPlan(
  occurrence: ProtectedTaskOccurrence,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  plan: TaskRuntimeGrantClaimPlan,
): boolean {
  const stable = plan.stableIdentity;
  return occurrence.run.jobId === null
    && occurrence.run.status === "awaiting"
    && plan.reference.executionSegment === 1
    && plan.reference.resumeAcceptanceId === undefined
    && plan.reference.resumeContinuationFingerprint === undefined
    && stable.executionSegment === 1
    && stable.resumeContinuationFingerprint === null
    && stable.taskId === occurrence.task.id
    && stable.taskRunId === occurrence.run.id
    && stable.ownerId === occurrence.task.ownerId
    && stable.requestorId === occurrence.task.requestorId
    && stable.agentId === occurrence.task.agentId
    && stable.callingRoomId === occurrence.task.callingRoomId
    && stable.scheduleKind === occurrence.task.scheduleKind
    && stable.graphThreadId === occurrence.run.graphThreadId
    && stable.startedAt === occurrence.run.startedAt.getTime()
    && stable.contentRepresentation === occurrence.task.contentRepresentation
    && stable.contentNamespaceId === occurrence.task.contentNamespaceId
    && stable.contentRevision === occurrence.task.contentRevision
    && stable.contentObjectId === occurrence.task.cryptoObjectId
    && stable.contentAccessRevision === occurrence.task.cryptoAccessRevision
    && plan.reference.taskId === occurrence.task.id
    && plan.reference.taskRunId === occurrence.run.id
    && plan.reference.authorizationRequestId === record.snapshot.requestId
    && plan.initialRecord.snapshot.requestId === record.snapshot.requestId
    && plan.initialRecord.snapshot.workId === occurrence.run.id
    && sameTaskRuntimeAuthorityPlan(record, plan.initialRecord);
}

/** Initial awaiting-run device hooks; parked continuation routing is excluded. */
export function createProtectedTaskRuntimeInitialDeviceAuthorization(
  input: ProtectedTaskRuntimeInitialDeviceAuthorizationInput,
): DeviceHooks {
  const now = input.now ?? Date.now;
  const recipients = input.recipients;

  const isTaskRecipientActive: DeviceHooks["isTaskRecipientActive"] = record => {
    const recipient = record.snapshot.recipient;
    return recipient !== null && recipients.hasAttempt({
      requestId: record.snapshot.requestId,
      workId: record.snapshot.workId,
      recipientGeneration: record.snapshot.recipientGeneration,
      recipientKeyId: recipient.recipientKeyId,
    });
  };

  const resolveInitial = async (
    record: BackgroundAuthorizationTaskRuntimeRecordV3,
  ): Promise<ResolvedInitial | null> => {
    if (record.snapshot.formatVersion !== 3
      || record.snapshot.credentialSubject.kind !== "runtime"
      || record.snapshot.credentialSubject.runtimeKind !== "task"
      || record.snapshot.credentialSubject.runtimeVersion !== 1) return null;
    const occurrence = await input.resolveOccurrence({
      taskRunId: record.snapshot.workId,
      authorizationRequestId: record.snapshot.requestId,
    });
    if (occurrence === null || occurrence.run.jobId !== null) return null;
    const plan = await input.plan(occurrence);
    return exactInitialPlan(occurrence, record, plan)
      ? Object.freeze({ occurrence, plan })
      : null;
  };

  return Object.freeze({
    isTaskRecipientActive,
    bindTaskRecipient: async operation => {
      if (!matchesStenographerRequestAdmission(
        operation.admission,
        operation.device,
        now(),
      )) return null;
      const resolved = await resolveInitial(operation.record);
      if (resolved === null
        || operation.record.snapshot.state !== "awaiting_recipient") return null;
      const binding = Object.freeze({
        userId: operation.subject.userId,
        humanActorId: operation.subject.humanActorId,
        deviceId: operation.subject.deviceId,
      });
      return input.claim.bindAwaitingRecipientForDevice({
        occurrence: resolved.occurrence,
        binding,
        withCurrentAuthority: input.withRecipientAuthority,
      });
    },
    withTaskAuthority: async operation => {
      const resolved = await resolveInitial(operation.record);
      if (resolved === null
        || !isTaskRecipientActive(operation.record)
        || !["awaiting_device", "grant_ready"]
          .includes(operation.record.snapshot.state)) return null;
      const binding = Object.freeze({
        userId: operation.subject.userId,
        humanActorId: operation.subject.humanActorId,
        deviceId: operation.subject.deviceId,
      });
      return input.withRecipientAuthority({
        occurrence: resolved.occurrence,
        record: operation.record,
        binding,
        targetRoomId: resolved.plan.stableIdentity.targetRoomId,
        ...(resolved.plan.scopeMemory === undefined
          ? {}
          : { scopeMemory: resolved.plan.scopeMemory }),
        phase: "bound",
        restricted: operation.restricted,
        validateBeforeCommit: current => {
          const recipient = operation.record.snapshot.recipient;
          return recipient !== null
            && now() < recipient.expiresAt
            && matchesStenographerRequestAdmission(
              operation.admission,
              current.device,
              now(),
            );
        },
        use: async current => {
          if (!matchesStenographerRequestAdmission(
            operation.admission,
            current.device,
            now(),
          )) return null;
          const descriptor = operation.record.descriptorBytes;
          if (descriptor === null) return null;
          const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
            descriptor,
          );
          if (request === null) return null;
          const plan = parseDomainForegroundAuthorizationPlanV2(
            request.authorizationPlanBytes,
          );
          if (plan === null) {
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
            return null;
          }
          try {
            const recipient = operation.record.snapshot.recipient;
            if (recipient === null
              || request.requestId !== operation.record.snapshot.requestId
              || request.workId !== resolved.occurrence.run.id
              || request.recipientGeneration
                !== operation.record.snapshot.recipientGeneration
              || request.recipientKeyId !== recipient.recipientKeyId
              || request.sourceRoomId !== current.sourceRoomId
              || request.sourceRoomId !== plan.roomId
              || !matchesCurrentTaskRuntimeAuthority({
                request,
                plan,
                subject: operation.subject,
                admission: operation.admission,
                device: current.device,
                namespaces: current.namespaceRequirements,
                domainRequirements:
                  operation.record.authoritySet.domainRequirements,
                domains: current.domains,
                policyRevision: current.policyRevision,
                now: now(),
              })) return null;
            const value = await operation.use(
              request,
              plan,
              current.domains,
              current.device,
              current.restricted,
            );
            if (now() >= request.deadlineAt
              || !matchesStenographerRequestAdmission(
                operation.admission,
                current.device,
                now(),
              )) {
              throw new Error(
                "Initial Task device authority expired before commit",
              );
            }
            return value;
          } finally {
            destroyDomainForegroundAuthorizationPlanV2(plan);
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
          }
        },
      });
    },
  });
}
