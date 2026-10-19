import { AsyncLocalStorage } from "node:async_hooks";

import type { ForegroundChatFundingSession } from "@nautilo/agent";
import type { ProtectedTaskAdditionalAuthorityResumeBindingV1 } from
  "@nautilo/agent";
import type { ProtectedTaskWakeScheduling } from "@nautilo/db";
import type { TaskRunResultPayloadV1 } from "@nautilo/lattice-bridge";
import {
  assertAuthenticTaskRuntimeWakeForegroundEvidence,
  hasTaskRuntimeTemporarySigner,
  type TaskRuntimeWakeForegroundEvidence,
} from "@nautilo/lattice-crypto";
import type { MemoryAccessEnvelope, RoomParticipant } from "@nautilo/trust";
import type { ProtectedTaskWakeExecutionCustody } from
  "./protected-task-wake-execution-candidate";
import type { ProtectedTaskWakeCheckpointBinding } from
  "./protected-task-wake-execution-candidate";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WAKE_JOB_INPUT_FIELDS = new Set([
  "activeMiniApp", "actorRole", "agentId", "artifactRefs",
  "attachmentTextBlocks", "autoApprove", "currentFolder",
  "currentFolderRelayId", "focusedResources", "graphThreadId",
  "liveMiniAppSession", "message", "multimodalImages", "ownerId",
  "requestorId", "roomId", "roomRoster", "securityAuditIp",
  "securityAuditUserAgent", "threadId", "turnId", "verifiedOrdinaryOrigin",
  "voiceMode", "workspacePath",
]);

/**
 * Request-local source for one authenticated protected Task result wake.
 * Result plaintext and funding custody never enter the durable Job input.
 */
export type ProtectedTaskWakeForegroundSource = Readonly<{
  evidence: TaskRuntimeWakeForegroundEvidence;
  scheduling: ProtectedTaskWakeScheduling;
  result: TaskRunResultPayloadV1;
  /** The raw delivery path already published the result as a Room Message. */
  resultMessagePublished: boolean;
  actorRole: string;
  roomRoster: readonly RoomParticipant[];
  memoryAccessEnvelope: MemoryAccessEnvelope;
  subthread: Readonly<{
    parentRoomId: string;
    anchorMessageId: number;
  }> | null;
  fundingSession: ForegroundChatFundingSession | null;
  checkpointBinding: ProtectedTaskWakeCheckpointBinding;
  continuation?: Readonly<{
    segment: number;
    checkpointThreadId: string;
    resume: ProtectedTaskAdditionalAuthorityResumeBindingV1;
  }>;
}>;

const custodyStorage = new AsyncLocalStorage<ProtectedTaskWakeExecutionCustody>();

/** Dedicated encrypted checkpoint lane; the Room graph thread stays transcript-only. */
export function protectedTaskWakeCheckpointThreadId(wakeJobId: string): string {
  if (!UUID.test(wakeJobId)) {
    throw new TypeError("Protected Task wake checkpoint Job id is invalid");
  }
  return `protected-task-wake:${wakeJobId}`;
}

/** Bind callback-scoped park authority around executor iteration only. */
export function runWithProtectedTaskWakeExecutionCustody<Value>(
  custody: ProtectedTaskWakeExecutionCustody,
  work: () => Promise<Value>,
): Promise<Value> {
  if (typeof custody?.park !== "function") {
    throw new TypeError("Protected Task wake execution custody is invalid");
  }
  const state = { active: true };
  const scoped = Object.freeze({
    async park(
      input: Parameters<ProtectedTaskWakeExecutionCustody["park"]>[0],
    ) {
      if (!state.active) {
        throw new TypeError("Protected Task wake execution custody escaped");
      }
      const result = await custody.park(input);
      if (!state.active) {
        throw new TypeError("Protected Task wake execution custody escaped");
      }
      return result;
    },
  });
  return custodyStorage.run(scoped, async () => {
    try {
      return await work();
    } finally {
      state.active = false;
    }
  });
}

export function getCurrentProtectedTaskWakeExecutionCustody():
  ProtectedTaskWakeExecutionCustody | undefined {
  return custodyStorage.getStore();
}

function snapshotEnvelope(value: MemoryAccessEnvelope): MemoryAccessEnvelope {
  const toolPolicy = Object.freeze({ ...value.toolPolicy });
  if (value.memoryMode === "scope") {
    return Object.freeze({ ...value, toolPolicy });
  }
  const readableNamespaces = [...value.readableNamespaces];
  const mutableNamespaces = [...value.mutableNamespaces];
  const writableNamespaces = [...value.writableNamespaces];
  Object.freeze(readableNamespaces);
  Object.freeze(mutableNamespaces);
  Object.freeze(writableNamespaces);
  return Object.freeze({ ...value, readableNamespaces, mutableNamespaces,
    writableNamespaces, toolPolicy });
}

function snapshotRoster(value: readonly RoomParticipant[]): readonly RoomParticipant[] {
  return Object.freeze(value.map(participant => Object.freeze({ ...participant,
    ...(participant.agentAvatar == null
      ? {} : { agentAvatar: Object.freeze({ ...participant.agentAvatar }) }),
  })));
}

function assertResult(
  result: TaskRunResultPayloadV1,
): void {
  if (result.formatVersion !== 1
    || typeof result.resultText !== "string" && result.resultText !== null
    || typeof result.lastError !== "string" && result.lastError !== null
    || (result.resultText === null) === (result.lastError === null)) {
    throw new TypeError("Protected Task wake result is invalid");
  }
}

/** Snapshot and bind all non-secret foreground facts to genuine live evidence. */
export function snapshotProtectedTaskWakeForegroundSource(
  value: ProtectedTaskWakeForegroundSource,
): ProtectedTaskWakeForegroundSource {
  assertAuthenticTaskRuntimeWakeForegroundEvidence(value.evidence);
  const evidence = value.evidence;
  const scheduling = Object.freeze({ ...value.scheduling,
    reference: Object.freeze({ ...value.scheduling.reference }) });
  const result = Object.freeze({ ...value.result });
  const envelope = snapshotEnvelope(value.memoryAccessEnvelope);
  const roster = snapshotRoster(value.roomRoster);
  const subthread = value.subthread === null
    ? null : Object.freeze({ ...value.subthread });
  const continuation = value.continuation === undefined
    ? undefined
    : Object.freeze({
        segment: value.continuation.segment,
        checkpointThreadId: value.continuation.checkpointThreadId,
        resume: Object.freeze({
          ...value.continuation.resume,
          requestDigest: value.continuation.resume.requestDigest.slice(),
          requiredAuthorityDigest:
            value.continuation.resume.requiredAuthorityDigest.slice(),
        }),
      });
  const checkpointBinding = Object.freeze({
    retainedSourceNamespaceIds: Object.freeze([
      ...value.checkpointBinding.retainedSourceNamespaceIds,
    ]),
    sourceEnvelopeDigest: value.checkpointBinding.sourceEnvelopeDigest.slice(),
    initialPolicyRevision: value.checkpointBinding.initialPolicyRevision,
    initialAgentAuthorizationRevision:
      value.checkpointBinding.initialAgentAuthorizationRevision,
  });
  const currentNamespaceIds = evidence.namespaceRequirements
    .map(requirement => requirement.namespaceId).sort();
  const certifiedSigner = hasTaskRuntimeTemporarySigner(evidence);
  const reference = evidence.invocation.reference;
  assertResult(result);
  const sourceKeys = Object.keys(value).sort().join(",");
  if (sourceKeys !== "actorRole,checkpointBinding,evidence,fundingSession,memoryAccessEnvelope,result,resultMessagePublished,roomRoster,scheduling,subthread"
    && sourceKeys !== "actorRole,checkpointBinding,continuation,evidence,fundingSession,memoryAccessEnvelope,result,resultMessagePublished,roomRoster,scheduling,subthread"
    || Object.keys(scheduling).sort().join(",")
      !== "agentId,graphThreadId,jobId,jobState,laneKey,namespaceId,ownerId,reference,requestorId,roomId,sessionId,sessionOwnerId,taskId,taskRunId"
    || Object.keys(scheduling.reference).sort().join(",")
      !== "bindingId,kind,resultObjectId,taskId,taskRunId,wakeOperationId"
    || evidence.invocation.kind !== "wake"
    || evidence.invocation.jobId !== scheduling.jobId
    || evidence.invocation.roomId !== scheduling.roomId
    || evidence.invocation.sessionId !== scheduling.sessionId
    || evidence.invocation.operationId !== reference.wakeOperationId
    || evidence.sourceRoomId !== scheduling.roomId
    || evidence.episodeId !== scheduling.sessionId
    || evidence.signerAgentId !== scheduling.agentId
    || reference.taskId !== scheduling.taskId
    || reference.taskRunId !== scheduling.taskRunId
    || scheduling.reference.kind !== reference.kind
    || reference.bindingId !== scheduling.reference.bindingId
    || reference.resultObjectId !== scheduling.reference.resultObjectId
    || reference.wakeOperationId !== scheduling.reference.wakeOperationId
    || !evidence.namespaceRequirements.some(namespace =>
      namespace.namespaceId === scheduling.namespaceId)
    || scheduling.ownerId !== scheduling.requestorId
    || scheduling.laneKey !== `room:${scheduling.roomId}`
    || scheduling.jobState !== "queued" && scheduling.jobState !== "running"
    || scheduling.graphThreadId.length === 0
    || typeof value.resultMessagePublished !== "boolean"
    || typeof value.actorRole !== "string" || value.actorRole.length === 0
    || Object.keys(checkpointBinding).sort().join(",")
      !== "initialAgentAuthorizationRevision,initialPolicyRevision,retainedSourceNamespaceIds,sourceEnvelopeDigest"
    || checkpointBinding.sourceEnvelopeDigest.length !== 32
    || checkpointBinding.retainedSourceNamespaceIds.length === 0
    || checkpointBinding.retainedSourceNamespaceIds.some((id, index, all) =>
      !UUID.test(id) || index > 0 && all[index - 1]! >= id)
    || checkpointBinding.retainedSourceNamespaceIds.join(",")
      !== currentNamespaceIds.join(",")
    || !Number.isSafeInteger(checkpointBinding.initialPolicyRevision)
    || checkpointBinding.initialPolicyRevision < 1
    || !Number.isSafeInteger(
      checkpointBinding.initialAgentAuthorizationRevision,
    )
    || checkpointBinding.initialAgentAuthorizationRevision < 0
    || checkpointBinding.initialAgentAuthorizationRevision === 0
      && !certifiedSigner
    || (continuation === undefined
      ? checkpointBinding.initialPolicyRevision !== evidence.policyRevision
      : checkpointBinding.initialPolicyRevision > evidence.policyRevision)
    || envelope.ownerId !== scheduling.requestorId
    || envelope.actorId !== evidence.requesterHumanId
    || envelope.agentId !== scheduling.agentId
    || (subthread === null
      ? envelope.roomId !== scheduling.roomId
      : (Object.keys(subthread).sort().join(",") !== "anchorMessageId,parentRoomId"
        || !UUID.test(subthread.parentRoomId)
        || subthread.parentRoomId === scheduling.roomId
        || !Number.isSafeInteger(subthread.anchorMessageId)
        || subthread.anchorMessageId < 1
        || envelope.roomId !== subthread.parentRoomId))
    || !roster.some(member => member.kind === "user"
      && member.userId === scheduling.requestorId
      && member.actorId === evidence.requesterHumanId)
    || !roster.some(member => member.kind === "agent"
      && member.agentId === scheduling.agentId)
    || continuation !== undefined && (
      Object.keys(continuation).sort().join(",")
        !== "checkpointThreadId,resume,segment"
      || !Number.isSafeInteger(continuation.segment)
      || continuation.segment < 1
      || continuation.segment > evidence.recipientGeneration
      || continuation.checkpointThreadId
        !== protectedTaskWakeCheckpointThreadId(scheduling.jobId)
      || Object.keys(continuation.resume).sort().join(",")
        !== "authorizationRequestId,effectDisposition,interruptId,operationId,requestDigest,requiredAuthorityDigest"
      || continuation.resume.effectDisposition !== "not_started_v1"
      || typeof continuation.resume.interruptId !== "string"
      || continuation.resume.interruptId.length === 0
      || typeof continuation.resume.authorizationRequestId !== "string"
      || continuation.resume.authorizationRequestId.length === 0
      || typeof continuation.resume.operationId !== "string"
      || continuation.resume.operationId.length === 0
      || continuation.resume.requestDigest.length !== 32
      || continuation.resume.requiredAuthorityDigest.length !== 32
    )) {
    throw new TypeError("Protected Task wake foreground source is invalid");
  }
  return Object.freeze({ evidence, scheduling, result,
    resultMessagePublished: value.resultMessagePublished,
    actorRole: value.actorRole, roomRoster: roster, subthread,
    memoryAccessEnvelope: envelope, fundingSession: value.fundingSession,
    checkpointBinding,
    ...(continuation === undefined ? {} : { continuation }) });
}

/** Reject every serialized substitute before foreground reads or model work. */
export function assertProtectedTaskWakeForegroundJobInput(input: Readonly<{
  source: ProtectedTaskWakeForegroundSource;
  jobInput: Readonly<Record<string, unknown>>;
  jobId: string;
  laneKey: string | null;
}>): void {
  const source = input.source;
  assertAuthenticTaskRuntimeWakeForegroundEvidence(source.evidence);
  const scheduling = source.scheduling;
  const arraysEmpty = ["attachmentTextBlocks", "multimodalImages", "retainedAttachmentIds",
    "mentionedHumanUserIds", "artifactRefs", "focusedResources"].every(key => {
      const value = input.jobInput[key];
      return value === undefined || Array.isArray(value) && value.length === 0;
    });
  if (input.jobId !== scheduling.jobId
    || Object.keys(input.jobInput).some(key => !WAKE_JOB_INPUT_FIELDS.has(key))
    || input.laneKey !== scheduling.laneKey
    || input.jobInput["ownerId"] !== scheduling.ownerId
    || input.jobInput["requestorId"] !== scheduling.requestorId
    || input.jobInput["agentId"] !== scheduling.agentId
    || input.jobInput["roomId"] !== scheduling.roomId
    || input.jobInput["graphThreadId"] !== scheduling.graphThreadId
    || input.jobInput["threadId"] !== scheduling.graphThreadId
    || input.jobInput["turnId"] !== source.evidence.invocation.operationId
    || typeof input.jobInput["message"] === "string" && input.jobInput["message"].length > 0
    || input.jobInput["causalHumanUserId"] !== undefined
    || input.jobInput["humanAlreadyPersisted"] === true
    || input.jobInput["metadata"] !== undefined
    || input.jobInput["voiceMode"] === true
    || input.jobInput["autoApprove"] === true
    || input.jobInput["actorRole"] !== undefined
      && input.jobInput["actorRole"] !== "guest"
    || input.jobInput["explicitlySelected"] === true
    || input.jobInput["verifiedOrdinaryOrigin"] != null
    || input.jobInput["activeMiniApp"] != null
    || input.jobInput["liveMiniAppSession"] != null
    || typeof input.jobInput["currentFolder"] === "string"
      && input.jobInput["currentFolder"].length > 0
    || typeof input.jobInput["currentFolderRelayId"] === "string"
      && input.jobInput["currentFolderRelayId"].length > 0
    || typeof input.jobInput["workspacePath"] === "string"
      && input.jobInput["workspacePath"].length > 0
    || typeof input.jobInput["securityAuditIp"] === "string"
      && input.jobInput["securityAuditIp"].length > 0
    || typeof input.jobInput["securityAuditUserAgent"] === "string"
      && input.jobInput["securityAuditUserAgent"].length > 0
    || input.jobInput["replyToMessageId"] != null
    || typeof input.jobInput["subthreadRoomId"] === "string"
      && input.jobInput["subthreadRoomId"].length > 0
    || typeof input.jobInput["subthreadParentRoomId"] === "string"
      && input.jobInput["subthreadParentRoomId"].length > 0
    || input.jobInput["memoryAccessEnvelope"] !== undefined
    || input.jobInput["roomRoster"] !== undefined
      && (!Array.isArray(input.jobInput["roomRoster"])
        || input.jobInput["roomRoster"].length > 0)
    || !arraysEmpty) {
    throw new TypeError("Protected Task wake serialized input was substituted");
  }
}
