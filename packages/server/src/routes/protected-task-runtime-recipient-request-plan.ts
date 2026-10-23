import {
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
  createTaskRuntimeBackgroundAuthorizationRequestV2,
  createTaskRuntimeBackgroundAuthorizationRequestV3,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV2,
  type TaskRuntimeBackgroundAuthorizationRequestV3,
  type TaskRuntimePublicationWorkBindingV3,
} from "@nautilo/lattice-crypto/background";
import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
  destroyDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  isTaskExecutionWorkKind,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskOccurrence,
  type TaskRuntimeGrantStableIdentity,
  type TaskRuntimeRecipientRequestPlan,
} from "@nautilo/runtime";
import type { ProtectedTaskOutputReadIntent } from "./protected-task-output-read-product";
import type { ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ProtectedTaskRuntimeRecipientCanonicalAuthority = Readonly<{
  policyRevision: number;
  namespaces:
    BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["namespaceRequirements"];
  domains:
    BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["domainRequirements"];
}>;

type ProtectedTaskRecipientRequestPlanBaseInput = Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  sourceRoomId: string;
  authority: ProtectedTaskRuntimeRecipientCanonicalAuthority;
  createdAt: number;
  recipientTtlMs: number;
}>;

export type ProtectedTaskRuntimeRecipientRequestPlanInput =
  ProtectedTaskRecipientRequestPlanBaseInput & Readonly<{
    occurrence: ProtectedTaskOccurrence;
    executionIdentity: Pick<TaskRuntimeGrantStableIdentity, "executionSegment">;
  }>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameRequirements(
  current: readonly Readonly<{
    ordinal: number;
    namespaceId: string;
    domainId: string;
    operations: readonly ("decrypt" | "encrypt")[];
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
  }>[],
  expected: BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["namespaceRequirements"],
): boolean {
  return current.length === expected.length && current.every((value, index) => {
    const other = expected[index];
    return other !== undefined
      && value.ordinal === other.ordinal
      && value.namespaceId === other.namespaceId
      && value.domainId === other.domainId
      && value.expectedAccessRevision === other.expectedAccessRevision
      && value.expectedPolicyRevision === other.expectedPolicyRevision
      && value.operations.join(",") === other.operations.join(",");
  });
}

function sameDomains(
  current: ProtectedTaskRuntimeRecipientCanonicalAuthority["domains"],
  expected: BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["domainRequirements"],
): boolean {
  return current.length === expected.length && current.every((value, index) => {
    const other = expected[index];
    return other !== undefined
      && value.ordinal === other.ordinal
      && value.domainId === other.domainId
      && value.expectedEpoch === other.expectedEpoch
      && value.expectedAuthorizationRevision
        === other.expectedAuthorizationRevision;
  });
}

/** Build the exact recipient attempt and wire request for one Task segment. */
export function createProtectedTaskRuntimeRecipientRequestPlan(
  input: ProtectedTaskRuntimeRecipientRequestPlanInput,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV1
    | TaskRuntimeBackgroundAuthorizationRequestV2
>, "recipientAttempt" | "buildRequest"> {
  if (input.occurrence.run.taskId !== input.occurrence.task.id
    || !Number.isSafeInteger(input.executionIdentity.executionSegment)
    || input.executionIdentity.executionSegment < 1) {
    throw new TypeError("Protected Task recipient occurrence is not exact");
  }
  const common = {
    ...input,
    workId: input.occurrence.run.id,
    requesterUserId: input.occurrence.task.requestorId,
    publication: "execution",
  } as const;
  if (!isTaskExecutionWorkKind(input.initialRecord.workKind)) {
    return createRecipientRequestPlan(common);
  }
  return createRecipientRequestPlan({
    ...common,
    initialExecution: Object.freeze({
      taskId: input.occurrence.task.id,
      taskRunId: input.occurrence.run.id,
      inputObjectId: input.occurrence.task.cryptoObjectId,
      resultObjectId: deriveTaskContentCryptoObjectIdV1({
        kind: "run_result",
        taskId: input.occurrence.task.id,
        taskRunId: input.occurrence.run.id,
        contentRevision: 1,
      }),
      agentId: input.occurrence.task.agentId,
      executionSegment: input.executionIdentity.executionSegment,
    }),
  });
}

/** A stopped result receives its own request; it never becomes an occurrence. */
export function createProtectedTaskCancellationRecipientRequestPlan(
  input: ProtectedTaskRecipientRequestPlanBaseInput & Readonly<{
    intent: ProtectedTaskCancellationOutputIntent;
  }>,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
>, "recipientAttempt" | "buildRequest"> {
  const { intent, initialRecord, authority } = input;
  const namespace = authority.namespaces[0];
  if (intent.taskStatus !== "cancelled" || intent.runStatus !== "cancelled"
    || intent.resultRevision !== 2
    || intent.policyRevision !== authority.policyRevision
    || initialRecord.snapshot.namespaceId !== intent.contentNamespaceId
    || authority.namespaces.length !== 1 || authority.domains.length !== 1
    || namespace?.namespaceId !== intent.contentNamespaceId
    || namespace.domainId !== authority.domains[0]?.domainId
    || namespace.operations.length !== 1 || namespace.operations[0] !== "encrypt") {
    throw new TypeError("Protected Task cancellation recipient authority is not exact");
  }
  return createRecipientRequestPlan({
    ...input,
    workId: intent.taskRunId,
    requesterUserId: intent.requesterUserId,
    publication: "cancellation",
    publicationWork: Object.freeze({
      kind: "task.cancel_result",
      taskId: intent.taskId,
      taskRunId: intent.taskRunId,
      contentRevision: 2,
      workIdentityHash: initialRecord.workIdentityHash.slice(),
    }),
    signerAgentId: intent.agentId,
  });
}

/** One terminal Message gets a fresh, write-only destination grant. */
export function createProtectedTaskTerminalMessageRecipientRequestPlan(
  input: ProtectedTaskRecipientRequestPlanBaseInput & Readonly<{
    taskRunId: string;
    taskId: string;
    agentId: string;
    messageObjectId: string;
    requesterUserId: string;
    destinationNamespaceId: string;
  }>,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
>, "recipientAttempt" | "buildRequest"> {
  const { initialRecord, authority } = input;
  const namespace = authority.namespaces[0];
  if (initialRecord.workKind !== "task.deliver_message"
    || initialRecord.purpose !== "task.deliver_message"
    || initialRecord.snapshot.namespaceId !== input.destinationNamespaceId
    || authority.namespaces.length !== 1 || authority.domains.length !== 1
    || namespace?.namespaceId !== input.destinationNamespaceId
    || namespace.domainId !== authority.domains[0]?.domainId
    || namespace.operations.length !== 1 || namespace.operations[0] !== "encrypt") {
    throw new TypeError("Protected Task terminal Message recipient authority is not exact");
  }
  return createRecipientRequestPlan({ ...input, workId: input.taskRunId,
    publication: "terminal_message", signerAgentId: input.agentId,
    publicationWork: Object.freeze({
      kind: "task.deliver_message",
      taskId: input.taskId,
      taskRunId: input.taskRunId,
      contentRevision: 2,
      messageObjectId: input.messageObjectId,
      workIdentityHash: initialRecord.workIdentityHash.slice(),
    }) });
}

/** Fresh result reads name the actual delivery Session, never the old Task execution episode. */
export function createProtectedTaskOutputReadRecipientRequestPlan(
  input: ProtectedTaskRecipientRequestPlanBaseInput & Readonly<{
    intent: ProtectedTaskOutputReadIntent;
    foregroundNamespaceIds: readonly string[];
    additionalMutationDestination?: Readonly<{ roomId: string; namespaceId: string; semanticDigest: string }>;
  }>,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
>, "recipientAttempt" | "buildRequest"> {
  const { intent, initialRecord, authority, foregroundNamespaceIds } = input;
  const wake = intent.invocation.kind === "wake";
  const workKind = wake ? "task.delivery_wake" : "task.deliver_result";
  const workId = intent.invocation.kind === "wake" ? intent.invocation.jobId : intent.result.taskRunId;
  const requestId = wake ? `task-wake-authorization:${workId}`
    : `task-run-delivery-result-authorization:${workId}`;
  const extra = input.additionalMutationDestination;
  const ids = [...new Set([intent.contentNamespaceId, ...foregroundNamespaceIds,
    ...(extra === undefined ? [] : [extra.namespaceId])])].sort();
  if (extra !== undefined && (!wake || !UUID.test(extra.roomId) || !UUID.test(extra.namespaceId)
      || !/^[0-9a-f]{64}$/u.test(extra.semanticDigest) || extra.namespaceId === intent.contentNamespaceId
      || foregroundNamespaceIds.includes(extra.namespaceId))
    || initialRecord.workKind !== workKind || initialRecord.purpose !== workKind
    || initialRecord.snapshot.requestId !== requestId || initialRecord.snapshot.workId !== workId
    || initialRecord.snapshot.namespaceId !== intent.contentNamespaceId
    || intent.expectedPolicyRevision !== authority.policyRevision
    || input.sourceRoomId !== intent.invocation.roomId
    || foregroundNamespaceIds.length < 1
    || foregroundNamespaceIds.some((id, index) => !UUID.test(id)
      || index > 0 && foregroundNamespaceIds[index - 1]! >= id)
    || !wake && foregroundNamespaceIds.length !== 1
    || authority.namespaces.length !== ids.length
    || authority.namespaces.some((n, index) => {
      const foreground = foregroundNamespaceIds.includes(n.namespaceId);
      const expectedOperations = [
        ...(n.namespaceId === intent.contentNamespaceId || wake && foreground ? ["decrypt"] : []),
        ...(foreground || extra?.namespaceId === n.namespaceId ? ["encrypt"] : []),
      ];
      return n.ordinal !== index || n.namespaceId !== ids[index]
        || n.expectedPolicyRevision !== authority.policyRevision
        || n.operations.join(",") !== expectedOperations.join(",");
    })) throw new TypeError("Protected Task result-read recipient authority is not exact");
  return createRecipientRequestPlan({ ...input, workId,
    requesterUserId: intent.requesterUserId, publication: "result_read",
    episodeId: intent.invocation.sessionId, signerAgentId: intent.agentId,
    publicationWork: Object.freeze(intent.invocation.kind === "wake" ? {
      kind: "task.delivery_wake",
      taskId: intent.result.taskId,
      taskRunId: intent.result.taskRunId,
      contentRevision: intent.result.contentRevision,
      jobId: intent.invocation.jobId,
      workIdentityHash: initialRecord.workIdentityHash.slice(),
    } : {
      kind: "task.deliver_result",
      taskId: intent.result.taskId,
      taskRunId: intent.result.taskRunId,
      contentRevision: 1,
      workIdentityHash: initialRecord.workIdentityHash.slice(),
    }) });
}

type RecipientRequestPlanInput =
  ProtectedTaskRecipientRequestPlanBaseInput & Readonly<{
    workId: string;
    requesterUserId: string;
    publication: "execution" | "cancellation" | "terminal_message" | "result_read";
    episodeId?: string;
  }>;

type InitialExecutionSignerBinding = Readonly<{
  taskId: string;
  taskRunId: string;
  inputObjectId: string;
  resultObjectId: string;
  agentId: string;
  executionSegment: number;
}>;

function createRecipientRequestPlan(
  input: RecipientRequestPlanInput & Readonly<{
    initialExecution: InitialExecutionSignerBinding;
    publicationWork?: undefined;
    signerAgentId?: undefined;
  }>,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV1
    | TaskRuntimeBackgroundAuthorizationRequestV2
>, "recipientAttempt" | "buildRequest">;
function createRecipientRequestPlan(
  input: RecipientRequestPlanInput & Readonly<{
    initialExecution?: undefined;
    publicationWork: TaskRuntimePublicationWorkBindingV3;
    signerAgentId: string;
  }>,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
>, "recipientAttempt" | "buildRequest">;
function createRecipientRequestPlan(
  input: RecipientRequestPlanInput & Readonly<{
    initialExecution?: undefined;
    publicationWork?: undefined;
    signerAgentId?: undefined;
  }>,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV1
>, "recipientAttempt" | "buildRequest">;
function createRecipientRequestPlan(
  input: RecipientRequestPlanInput & Readonly<{
    initialExecution?: InitialExecutionSignerBinding | undefined;
    publicationWork?: TaskRuntimePublicationWorkBindingV3 | undefined;
    signerAgentId?: string | undefined;
  }>,
): Pick<TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV1
    | TaskRuntimeBackgroundAuthorizationRequestV2
    | TaskRuntimeBackgroundAuthorizationRequestV3
>, "recipientAttempt" | "buildRequest"> {
  const { initialRecord, workId, requesterUserId } = input;
  const crypto = input.crypto;
  const requestId = initialRecord.snapshot.requestId;
  const workKind = initialRecord.workKind;
  const writeOnly = input.publication === "cancellation" || input.publication === "terminal_message";
  const recipientPrefix = input.publication === "cancellation" ? "task-cancellation-runtime"
    : input.publication === "terminal_message" ? "task-delivery-runtime"
    : input.publication === "result_read" ? "task-output-read-runtime" : "task-runtime";
  const sourceRoomId = input.sourceRoomId;
  const policyRevision = input.authority.policyRevision;
  const createdAt = input.createdAt;
  const recipientTtlMs = input.recipientTtlMs;
  const idempotencyKey = initialRecord.idempotencyKey;
  const workIdentityHash = initialRecord.workIdentityHash.slice();
  const namespaces = Object.freeze(input.authority.namespaces.map(value =>
    Object.freeze({ ...value, operations: Object.freeze([...value.operations]) })));
  const domains = Object.freeze(input.authority.domains.map(value =>
    Object.freeze({ ...value })));

  if (workKind !== "task.execute" && workKind !== "task.approval_resume"
    && workKind !== "task.await_reply_resume" && workKind !== "task.cancel_result"
    && workKind !== "task.deliver_message" && workKind !== "task.deliver_result"
    && workKind !== "task.delivery_wake") {
    workIdentityHash.fill(0);
    throw new TypeError("Protected Task recipient work kind is invalid");
  }

  if (typeof crypto.hash !== "function"
    || !UUID.test(sourceRoomId)
    || !Number.isSafeInteger(createdAt) || createdAt < 0
    || !Number.isSafeInteger(recipientTtlMs) || recipientTtlMs < 1
    || recipientTtlMs > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2
    || (input.publication === "cancellation" ? workKind !== "task.cancel_result"
      : input.publication === "terminal_message" ? workKind !== "task.deliver_message"
      : input.publication === "result_read" ? workKind !== "task.deliver_result" && workKind !== "task.delivery_wake"
      : workKind !== "task.execute" && workKind !== "task.approval_resume"
        && workKind !== "task.await_reply_resume")
    || input.publication === "result_read" && !UUID.test(input.episodeId ?? "")
    || initialRecord.purpose !== workKind
    || initialRecord.snapshot.workId !== workId
    || initialRecord.expectedPolicyRevision !== policyRevision
    || !Number.isSafeInteger(policyRevision) || policyRevision < 1
    || idempotencyKey.length === 0
    || workIdentityHash.length !== 32
    || !sameRequirements(
      namespaces,
      initialRecord.authoritySet.namespaceRequirements,
    )
    || !sameDomains(domains, initialRecord.authoritySet.domainRequirements)) {
    workIdentityHash.fill(0);
    throw new TypeError("Protected Task recipient plan is not exact");
  }

  return Object.freeze({
    recipientAttempt: ({ record, now: attemptAt }) => {
      if (record.snapshot.requestId !== requestId
        || record.snapshot.workId !== workId
        || record.workKind !== workKind || record.purpose !== workKind
        || record.expectedPolicyRevision !== policyRevision
        || record.idempotencyKey !== idempotencyKey
        || !sameBytes(record.workIdentityHash, workIdentityHash)) {
        throw new TypeError("Protected Task recipient record is not exact");
      }
      const expiresAt = attemptAt + recipientTtlMs;
      if (!Number.isSafeInteger(attemptAt) || attemptAt < createdAt
        || !Number.isSafeInteger(expiresAt)) {
        throw new TypeError("Protected Task recipient deadline is invalid");
      }
      const signerAgentId = input.initialExecution?.agentId ?? input.signerAgentId;
      return Object.freeze({
        recipientKeyId:
          `${recipientPrefix}:${workId}:${record.snapshot.recipientGeneration}`,
        expiresAt,
        ...(signerAgentId === undefined ? {} : { signerAgentId }),
      });
    },
    buildRequest: ({ record, attempt, binding, authority: current }) => {
      const issuedAt = attempt.expiresAt - recipientTtlMs;
      const currentDomains = [...current.domains]
        .sort((left, right) => left.domainId.localeCompare(right.domainId));
      if (record.snapshot.requestId !== requestId
        || record.snapshot.workId !== workId
        || record.workKind !== workKind || record.purpose !== workKind
        || record.idempotencyKey !== idempotencyKey
        || !sameBytes(record.workIdentityHash, workIdentityHash)
        || attempt.requestId !== requestId
        || attempt.workId !== workId
        || attempt.recipientGeneration !== record.snapshot.recipientGeneration
        || attempt.recipientKeyId
          !== `${recipientPrefix}:${workId}:${attempt.recipientGeneration}`
        || binding.userId !== requesterUserId
        || current.device.userId !== binding.userId
        || current.device.humanActorId !== binding.humanActorId
        || current.device.deviceId !== binding.deviceId
        || current.sourceRoomId !== sourceRoomId
        || current.policyRevision !== policyRevision
        || !sameRequirements(current.namespaceRequirements, namespaces)
        || currentDomains.length !== domains.length
        || currentDomains.some((domain, index) => {
          const expected = domains[index];
          return expected === undefined
            || domain.domainId !== expected.domainId
            || domain.domainKeyGeneration !== expected.expectedEpoch
            || domain.authorizationRevision
              !== expected.expectedAuthorizationRevision;
        })
        || !Number.isSafeInteger(issuedAt)
        || issuedAt < createdAt
        || issuedAt >= attempt.expiresAt) {
        throw new TypeError("Protected Task request authority is not exact");
      }
      const grant = createDomainForegroundAuthorizationPlan(crypto, {
        authorizationId: requestId,
        policyRevision,
        sessionId: input.publication === "result_read" ? input.episodeId! : `task-run:${workId}`,
        roomId: current.sourceRoomId,
        subjectHumanId: humanId(binding.humanActorId),
        committerDeviceId: cryptoDeviceId(binding.deviceId),
        committerDeviceSigningGeneration: current.device.deviceGeneration,
        hostAuthorizationRevision:
          authorizationRevision(current.device.securityRevision),
        recipientKind: "runtime",
        recipientPrincipalId: "nautilo_task_runtime",
        recipientAuthorizationRevision: authorizationRevision(0),
        recipientRuntimeGeneration: attempt.recipientGeneration,
        recipientKeyId: attempt.recipientKeyId,
        operations: writeOnly ? ["encrypt"] : ["decrypt", "encrypt"],
        issuedAt,
        deadlineAt: attempt.expiresAt,
        maximumSecretBytes: DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
        domains: currentDomains,
      });
      try {
        const baseRequest = createTaskRuntimeBackgroundAuthorizationRequestV1({
          requestId,
          workId,
          workKind,
          workPurpose: workKind,
          recipientGeneration: attempt.recipientGeneration,
          episodeId: grant.sessionId,
          sourceRoomId: current.sourceRoomId,
          recipientKeyId: attempt.recipientKeyId,
          recipientPublicKey: attempt.recipientPublicKey,
          authorizationPlan: grant,
          issuedAt,
          deadlineAt: attempt.expiresAt,
        });
        if (input.initialExecution === undefined && input.publicationWork === undefined) return baseRequest;
        const signer = attempt.signer;
        let signingPublicKeyHash: Uint8Array | undefined;
        try {
          const expectedSignerAgentId = input.initialExecution?.agentId
            ?? input.signerAgentId;
          if (signer === undefined || expectedSignerAgentId === undefined
            || signer.agentId !== expectedSignerAgentId
            || signer.runtimeGeneration !== 0) {
            throw new TypeError("Protected Task temporary signer is unavailable");
          }
          signingPublicKeyHash = crypto.hash(current.device.signingPublicKey);
          const authority = {
            baseRequest,
            signer,
            deviceGroupHead: Object.freeze({
              serverInstanceId: current.device.serverInstanceId,
              lineageGeneration: current.device.lineageGeneration,
              epoch: current.device.epoch,
              headDigest: current.device.headDigest,
              signingPublicKeyHash,
            }),
            namespaceRequirements: current.namespaceRequirements,
          };
          if (input.initialExecution === undefined) {
            return createTaskRuntimeBackgroundAuthorizationRequestV3(crypto, {
              ...authority,
              work: input.publicationWork!,
            });
          }
          return createTaskRuntimeBackgroundAuthorizationRequestV2(crypto, {
            ...authority,
            work: Object.freeze({
              taskId: input.initialExecution.taskId,
              taskRunId: input.initialExecution.taskRunId,
              inputObjectId: input.initialExecution.inputObjectId,
              resultObjectId: input.initialExecution.resultObjectId,
              executionSegment: input.initialExecution.executionSegment,
              workIdentityHash: workIdentityHash.slice(),
            }),
          });
        } finally {
          signingPublicKeyHash?.fill(0);
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(baseRequest);
        }
      } finally {
        destroyDomainForegroundAuthorizationPlanV2(grant);
      }
    },
  });
}
