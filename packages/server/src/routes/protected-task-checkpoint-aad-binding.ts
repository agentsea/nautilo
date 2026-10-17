import {
  parseProtectedTaskCheckpointAadBinding,
  type ParkedProtectedTaskAdditionalAuthority,
  type ProtectedTaskCheckpointAadBinding,
} from "@nautilo/db";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { parseDomainForegroundAuthorizationPlanV2, destroyDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import {
  isTaskExecutionWorkKind,
  isTaskRuntimeStableIdempotencyKey,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
} from "@nautilo/runtime";

/**
 * Requires canonical parked Job/segment reproof. The caller must also reprove
 * the physical manifest before any saver opens these coordinates.
 * Old accepted metadata selects ciphertext AAD, never current execution or keys.
 */
export async function resolveProtectedTaskCheckpointAadBinding(
  expected: Pick<ParkedProtectedTaskAdditionalAuthority, "occurrence" | "priorJob">,
  repository: Pick<BackgroundAuthorizationRepository, "get">,
): Promise<ProtectedTaskCheckpointAadBinding | null> {
  const crypto = new LatticeCrypto();
  const { priorJob, occurrence } = expected;
  if (priorJob.id !== occurrence.run.jobId
    || occurrence.run.taskId !== occurrence.task.id
    || priorJob.reference.taskId !== occurrence.task.id
    || priorJob.reference.taskRunId !== occurrence.run.id) return null;
  if (priorJob.checkpointAadBinding !== undefined) {
    const binding = parseProtectedTaskCheckpointAadBinding(priorJob.checkpointAadBinding);
    return binding !== null && binding.namespaceId === occurrence.task.contentNamespaceId
      && binding.policyRevision <= priorJob.reference.policyRevision ? binding : null;
  }
  const raw = await repository.get(priorJob.reference.authorizationRequestId);
  if (raw === null) return null;
  let record: ReturnType<typeof parseBackgroundAuthorizationRecord>;
  try { record = parseBackgroundAuthorizationRecord(raw); } catch { return null; }
  if (record.snapshot.formatVersion !== 3 || record.authoritySet === undefined
    || record.snapshot.credentialSubject.kind !== "runtime"
    || record.snapshot.credentialSubject.runtimeKind !== "task"
    || record.snapshot.credentialSubject.runtimeVersion !== 1
    || record.snapshot.state !== "completed" || record.acceptedMaterial === null
    || record.finishedAt !== priorJob.parkedAt.getTime()
    || record.snapshot.updatedAt !== priorJob.parkedAt.getTime()
    || record.snapshot.requestId !== priorJob.reference.authorizationRequestId
    || record.snapshot.workId !== occurrence.run.id
    || record.snapshot.recipientGeneration !== priorJob.generation
    || record.snapshot.namespaceId !== occurrence.task.contentNamespaceId
    || record.expectedPolicyRevision !== priorJob.reference.policyRevision
    || !isTaskExecutionWorkKind(record.workKind) || record.purpose !== record.workKind
    || !isTaskRuntimeStableIdempotencyKey(record.idempotencyKey, occurrence.run.id)
    || record.descriptorBytes === null) return null;
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
    crypto,
    record.descriptorBytes,
  );
  if (request === null) return null;
  const plan = parseDomainForegroundAuthorizationPlanV2(request.authorizationPlanBytes);
  try {
    if (request.requestId !== record.snapshot.requestId || request.workId !== occurrence.run.id
      || request.workKind !== record.workKind || request.workPurpose !== record.purpose
      || request.recipientGeneration !== priorJob.generation
      || plan === null || plan.policyRevision !== record.expectedPolicyRevision
      || !plan.domains.some(domain => domain.domainId === record.domainId
        && domain.domainKeyGeneration === record.expectedDomainEpoch)) return null;
    const matches = record.authoritySet.namespaceRequirements.filter(
      requirement => requirement.namespaceId === occurrence.task.contentNamespaceId,
    );
    const primary = matches[0];
    if (matches.length !== 1 || primary === undefined
      || primary.domainId !== record.domainId
      || primary.expectedAccessRevision !== record.expectedNamespaceAccessRevision
      || primary.expectedPolicyRevision !== record.expectedPolicyRevision
      || primary.operations.length !== 2 || primary.operations[0] !== "decrypt"
      || primary.operations[1] !== "encrypt") return null;
    return parseProtectedTaskCheckpointAadBinding({ version: 1,
      namespaceId: primary.namespaceId, domainId: primary.domainId,
      namespaceAccessRevision: primary.expectedAccessRevision,
      policyRevision: primary.expectedPolicyRevision });
  } finally {
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
  }
}
