import { protectedTaskDefinitionSupportsPolicy } from "@nautilo/db";
import { createHash } from "node:crypto";
import {
  discoverParkedProtectedTaskAdditionalAuthority, discoverAcceptedParkedProtectedTaskHumanContinuation,
  discoverParkedProtectedTaskCheckpointContinuation,
  getEncryptionTransitionPolicy,
  getProtectedTaskRunOutputBinding,
  type DirectDatabase, type ParkedProtectedTaskAdditionalAuthority,
  type ParkedProtectedTaskCheckpointContinuation,
  type ParkedProtectedTaskHumanContinuation,
  type ProtectedTaskRunOutputBinding,
} from "@nautilo/db";
import type { ParkedTaskRuntimeCurrentRoutingFacts, VerifiedTaskDefinitionAccessLineage } from "@nautilo/lattice-bridge/server";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3, taskRuntimeStableIdempotencyKey,
  type BackgroundAuthorizationTaskRuntimeRecordV3, type TaskRuntimeGrantStableIdentity,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import {
  canonicalProtectedTaskRuntimeAuthority, createParkedTaskRuntimeRoutingValidator,
  protectedTaskRuntimeNamespaceInventory, sameProtectedTaskRuntimeOccurrence,
  type ProtectedTaskRuntimeNamespaceAuthorityFact,
} from "./protected-task-runtime-grant-plan";
import {
  createProtectedTaskRuntimeParkedMemoryPlanResolver,
  type ParkedProtectedTaskRuntimeMemoryPlan,
} from "./protected-task-runtime-parked-memory-plan";

export type ParkedProtectedTaskContinuation =
  | ParkedProtectedTaskAdditionalAuthority
  | ParkedProtectedTaskCheckpointContinuation
  | ParkedProtectedTaskHumanContinuation;

export async function discoverParkedProtectedTaskContinuation(
  db: DirectDatabase,
  input: Readonly<{ taskRunId: string }>,
): Promise<ParkedProtectedTaskContinuation | null> {
  return await discoverParkedProtectedTaskAdditionalAuthority(db, input)
    ?? await discoverParkedProtectedTaskCheckpointContinuation(db, input)
    ?? await discoverAcceptedParkedProtectedTaskHumanContinuation(db, input);
}

function isCheckpointContinuation(
  expected: ParkedProtectedTaskContinuation,
): expected is ParkedProtectedTaskCheckpointContinuation {
  return !("acceptance" in expected) && "stableRoutingDigest" in expected;
}

export type ParkedTaskRuntimePlanDependencies = Readonly<{
  db: DirectDatabase;
  resolveMemory: ReturnType<typeof createProtectedTaskRuntimeParkedMemoryPlanResolver>;
  discover: typeof discoverParkedProtectedTaskContinuation;
  readAccessLineage?(expected: ParkedProtectedTaskContinuation, requesterHumanId: string): Promise<VerifiedTaskDefinitionAccessLineage | null>;
  readOutput: typeof getProtectedTaskRunOutputBinding;
  readPolicy: (db: DirectDatabase) => Promise<Pick<Awaited<ReturnType<
    typeof getEncryptionTransitionPolicy
  >>, "mode" | "shadowBehavior" | "revision">>;
}>;

export type ParkedTaskRuntimeAuthorizationPlan = Readonly<{
  expected: ParkedProtectedTaskContinuation;
  output: ProtectedTaskRunOutputBinding;
  policy: Awaited<ReturnType<ParkedTaskRuntimePlanDependencies["readPolicy"]>>;
  memory: ParkedProtectedTaskRuntimeMemoryPlan;
  inventory: ReturnType<typeof namespaceInventory>;
  validateCurrentRouting(facts: ParkedTaskRuntimeCurrentRoutingFacts): boolean;
}>;

function sameRoutingPlan(
  plan: ParkedProtectedTaskRuntimeMemoryPlan,
  current: ParkedTaskRuntimeCurrentRoutingFacts,
): boolean {
  const routing = plan.routing;
  return routing.taskId === current.taskId && routing.taskRunId === current.taskRunId
    && routing.requesterUserId === current.requestorId
    && routing.agentId === current.agentId
    && routing.sourceRoomId === current.sourceRoomId
    && routing.sourceNamespaceId === current.contentNamespaceId
    && routing.targetRoomId === current.targetRoomId
    && routing.memoryMode === current.memoryMode && routing.scopeId === current.scopeId
    && routing.wideBringBack === current.wideBringBack
    && routing.targetUserIds.length === current.targetUserIds.length
    && routing.targetUserIds.every((id, index) => id === current.targetUserIds[index]);
}

/** Union semantic operations with the freshly resolved base, never old grant inventory. */
function namespaceInventory(
  expected: ParkedProtectedTaskContinuation,
  plan: ParkedProtectedTaskRuntimeMemoryPlan,
) {
  const base = protectedTaskRuntimeNamespaceInventory({
    occurrence: expected.occurrence,
    memory: plan.resolution,
  }, plan.routing.outputRoomId === null ? null : {
    roomId: plan.routing.outputRoomId,
    namespaceId: plan.routing.outputNamespaceId!,
  }, plan.scopeMemory);
  const operations = new Map<string, Set<"decrypt" | "encrypt">>();
  for (const namespaceId of base.namespaceIds) {
    operations.set(namespaceId, new Set(base.operations(namespaceId)));
  }
  for (const requirement of "acceptance" in expected
    || isCheckpointContinuation(expected)
    ? [] : expected.proof.continuation.semanticAuthorityRequirements) {
    const current = operations.get(requirement.namespaceId) ?? new Set<"decrypt" | "encrypt">();
    for (const operation of requirement.operations) current.add(operation);
    operations.set(requirement.namespaceId, current);
  }
  if ("acceptance" in expected && expected.acceptance.response.kind === "await_reply") {
    const namespaceId = expected.acceptance.response.message.namespaceId;
    const current = operations.get(namespaceId) ?? new Set<"decrypt" | "encrypt">();
    current.add("decrypt");
    operations.set(namespaceId, current);
  }
  return Object.freeze({
    namespaceIds: Object.freeze([...operations.keys()].sort()),
    operations: (namespaceId: string) => Object.freeze([
      ...(operations.get(namespaceId)?.has("decrypt") ? ["decrypt" as const] : []),
      ...(operations.get(namespaceId)?.has("encrypt") ? ["encrypt" as const] : []),
    ]),
  });
}

/** Content-free discovery shared by preparation and device grant phases. */
export function createParkedTaskRuntimeAuthorizationPlanResolver(
  dependencies: ParkedTaskRuntimePlanDependencies,
): (input: Readonly<{
  taskRunId: string;
  authorizationRequestId?: string;
  occurrence?: ProtectedTaskOccurrence;
}>) => Promise<ParkedTaskRuntimeAuthorizationPlan | null> {
  const { db, discover, readPolicy, readOutput, resolveMemory } = dependencies;
  return async input => {
    const pinned = structuredClone(input);
    if (pinned.occurrence?.run.jobId === null) return null;
    const discovered = await discover(db, { taskRunId: pinned.taskRunId });
    if (discovered === null
      || (pinned.authorizationRequestId !== undefined
        && discovered.authorizationRequestId !== pinned.authorizationRequestId)
      || (pinned.occurrence !== undefined
        && !sameProtectedTaskRuntimeOccurrence(pinned.occurrence, discovered.occurrence))) return null;
    const expected = structuredClone(discovered);
    const policy = Object.freeze({ ...await readPolicy(db) });
    if (policy.mode === "plaintext_only"
      || !protectedTaskDefinitionSupportsPolicy(expected.occurrence.task.contentRepresentation, policy.mode)) return null;
    const loadedOutput = await readOutput(db, expected.occurrence.run.id);
    if (loadedOutput === undefined) return null;
    const output = structuredClone(loadedOutput);
    const discoveredPlan = await resolveMemory({ expected: structuredClone(expected), output: structuredClone(output) });
    if (discoveredPlan === null) return null;
    const memory = structuredClone(discoveredPlan);
    const inventory = namespaceInventory(expected, memory);
    const accessLineage = await dependencies.readAccessLineage?.(expected, memory.routing.requesterHumanId);
    const validateRouting = createParkedTaskRuntimeRoutingValidator({
      expected, output, widePrivateNamespaceId: memory.routing.widePrivateNamespaceId,
      ...(accessLineage == null ? {} : { accessLineage }),
    });
    return Object.freeze({ expected, output, policy, memory, inventory,
      validateCurrentRouting: (facts: ParkedTaskRuntimeCurrentRoutingFacts) =>
        sameRoutingPlan(memory, facts) && validateRouting(facts),
    });
  };
}

/** Build a request only from the current facts returned inside a held owner. */
export function createParkedTaskRuntimeAuthorizationRecord(
  resolved: ParkedTaskRuntimeAuthorizationPlan,
  facts: ParkedTaskRuntimeCurrentRoutingFacts,
  currentFacts: readonly ProtectedTaskRuntimeNamespaceAuthorityFact[],
  now: number,
) {
  if (!resolved.validateCurrentRouting(facts)) {
    throw new TypeError("Parked Task routing changed before request construction");
  }
  const { expected, output, memory: plan, inventory } = resolved;
  const occurrence = expected.occurrence;
  const authority = canonicalProtectedTaskRuntimeAuthority({ occurrence, inventory, facts: currentFacts });
  const content = authority.namespaces.find(value => value.namespaceId === occurrence.task.contentNamespaceId)!;
  const contentDomain = authority.domains.find(value => value.domainId === content.domainId)!;
  const workKind = "acceptance" in expected
    ? expected.acceptance.response.kind === "await_reply"
      ? "task.await_reply_resume" as const : "task.approval_resume" as const
    : "task.execute" as const;
  const stableIdentity: TaskRuntimeGrantStableIdentity = Object.freeze({
    ...facts, startedAt: facts.startedAt.getTime(),
    requiredNamespaceFingerprint: Buffer.from(facts.requiredNamespaceFingerprint).toString("base64url"),
    outputRoomId: output.destinationRoomId, outputNamespaceId: output.destinationNamespaceId,
    executionSegment: expected.nextExecutionSegment,
    ...("acceptance" in expected
      ? { resumeContinuationFingerprint: null,
          resumeAcceptanceId: expected.acceptance.acceptanceId,
          resumeWorkKind: expected.acceptance.response.kind === "await_reply"
            ? "task.await_reply_resume" as const : "task.approval_resume" as const }
      : { resumeContinuationFingerprint: expected.continuationFingerprint }),
  });
  const scopeWorkIdentity = JSON.stringify({
      taskId: occurrence.task.id, taskRunId: occurrence.run.id,
      scheduleKind: occurrence.task.scheduleKind,
      sourceRoomId: facts.sourceRoomId, targetRoomId: facts.targetRoomId,
      outputRoomId: output.destinationRoomId, outputNamespaceId: output.destinationNamespaceId,
      targetUserIds: [...facts.targetUserIds], memoryMode: facts.memoryMode,
      scopeId: facts.scopeId, inputObjectId: occurrence.task.cryptoObjectId,
      contentRevision: occurrence.task.contentRevision,
      fingerprint: stableIdentity.requiredNamespaceFingerprint,
      policyRevision: authority.policyRevision,
      ...(plan.scopeMemory === undefined ? {} : { scopeMemory: plan.scopeMemory }),
      ...(facts.memoryMode === "wide" ? { widePrimaryWriteNamespaceId:
        facts.wideBringBack && output.destinationNamespaceId !== null
          ? output.destinationNamespaceId : plan.routing.widePrivateNamespaceId } : {}),
      namespaces: authority.namespaces, domains: authority.domains,
      executionSegment: expected.nextExecutionSegment,
      ...("acceptance" in expected
      ? { resumeAcceptanceId: expected.acceptance.acceptanceId }
      : { resumeContinuationFingerprint: expected.continuationFingerprint }),
    });
  const initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = Object.freeze({
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: expected.authorizationRequestId, workId: occurrence.run.id,
      namespaceId: occurrence.task.contentNamespaceId, now,
    }),
    idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity),
    workIdentityHash: createHash("sha256").update(scopeWorkIdentity).digest(),
    workKind, purpose: workKind, domainId: content.domainId,
    processorAuthorizationRevision: null, expectedDomainEpoch: contentDomain.expectedEpoch,
    expectedNamespaceAccessRevision: content.expectedAccessRevision,
    expectedPolicyRevision: authority.policyRevision,
    descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
    authoritySet: Object.freeze({ namespaceRequirements: authority.namespaces,
      domainRequirements: authority.domains }),
  });
  return Object.freeze({ stableIdentity, initialRecord, authority, scopeWorkIdentity });
}
