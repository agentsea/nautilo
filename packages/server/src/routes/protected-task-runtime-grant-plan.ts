import { createHash, timingSafeEqual } from "node:crypto";

import {
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
} from "@nautilo/lattice-crypto/wire";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  copyTaskScopeMemoryBinding,
  type ParkedTaskRuntimeCurrentRoutingFacts,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";
import type {
  AcceptProtectedTaskRunOutputBindingInput,
  AcceptProtectedTaskRunOutputBindingResult,
  ProtectedTaskRunOutputDestination,
  ParkedProtectedTaskAdditionalAuthority,
  ProtectedTaskRunOutputBinding,
} from "@nautilo/db";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  taskRuntimeStableIdempotencyKey,
  taskRuntimeStableRoutingDigest,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type TaskRuntimeGrantClaimPlan,
  type TaskRuntimeGrantStableIdentity,
  type ProtectedTaskPredispatchPlan,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import type {
  CurrentProtectedTaskMemoryPolicy,
} from "./current-protected-task-memory-authority";
import {
  createProtectedTaskRuntimeRecipientRequestPlan,
} from "./protected-task-runtime-recipient-request-plan";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Compare locked routing with durable park evidence, independently of old grants. */
export function createParkedTaskRuntimeRoutingValidator(input: Readonly<{
  expected: ParkedProtectedTaskAdditionalAuthority;
  output: ProtectedTaskRunOutputBinding;
  /** Current canonical Wide envelope's private write target, not content custody. */
  widePrivateNamespaceId: string | null;
}>): (facts: ParkedTaskRuntimeCurrentRoutingFacts) => boolean {
  const { expected, output } = input;
  const widePrivateNamespaceId = input.widePrivateNamespaceId;
  const taskRunId = expected.occurrence.run.id;
  const storedDigest = expected.proof.continuation.stableRoutingDigest;
  if (!(storedDigest instanceof Uint8Array) || storedDigest.length !== 32
    || (widePrivateNamespaceId !== null && !UUID.test(widePrivateNamespaceId))
    || output.taskRunId !== taskRunId
    || output.bindingId !== `task-run-output:${taskRunId}`
    || output.resultOperationId !== `task-run-result:${taskRunId}`
    || output.resultObjectId !== expected.priorJob.reference.resultObjectId
    || output.destinationRoomId !== expected.occurrence.task.callingRoomId
    || (output.destinationRoomId === null
      ? output.deliveryMode !== "none" || output.destinationNamespaceId !== null
      : output.deliveryMode === "none"
        || output.destinationNamespaceId === null
        || !UUID.test(output.destinationNamespaceId))) {
    throw new TypeError("Parked Task original routing evidence is unavailable");
  }
  const digest = storedDigest.slice();
  const outputRoomId = output.destinationRoomId;
  const outputNamespaceId = output.destinationNamespaceId;
  return facts => {
    if (facts.taskRunId !== taskRunId
      || (facts.memoryMode === "wide" && widePrivateNamespaceId === null)) return false;
    const widePrimaryWriteNamespaceId = facts.memoryMode === "wide"
      ? facts.wideBringBack && outputNamespaceId !== null
        ? outputNamespaceId
        : widePrivateNamespaceId
      : null;
    const current = taskRuntimeStableRoutingDigest({
      ...facts,
      startedAt: facts.startedAt.getTime(),
      requiredNamespaceFingerprint: Buffer.from(
        facts.requiredNamespaceFingerprint,
      ).toString("base64url"),
      outputRoomId,
      outputNamespaceId,
      widePrimaryWriteNamespaceId,
    });
    try {
      return timingSafeEqual(digest, current);
    } finally {
      current.fill(0);
    }
  };
}

export type ProtectedTaskRuntimeNamespaceAuthorityFact = Readonly<{
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  expectedDomainEpoch: number;
  expectedAuthorizationRevision: number;
}>;

export type ProtectedTaskRuntimeMemoryPolicy =
  CurrentProtectedTaskMemoryPolicy;

export type ProtectedTaskRuntimeGrantPlanBuilderDependencies = Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  recipientTtlMs: number;
  predispatch(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<ProtectedTaskPredispatchPlan>;
  resolveScopeMemoryInventory?(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    predispatch: ProtectedTaskPredispatchPlan;
  }>): Promise<TaskScopeMemoryBinding>;
  resolveNamespaceAuthority(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    predispatch: ProtectedTaskPredispatchPlan;
    namespaceIds: readonly string[];
    scopeMemory?: TaskScopeMemoryBinding;
  }>): Promise<Readonly<{
    /** Current requester-private Room anchoring the protected Task definition. */
    sourceRoomId: string;
    sourceNamespaceId: string;
    /** Process-local policy selected under the same revision fence. */
    policy: ProtectedTaskRuntimeMemoryPolicy;
    facts: readonly ProtectedTaskRuntimeNamespaceAuthorityFact[];
  }>>;
  resolveOutputDestination(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<ProtectedTaskRunOutputDestination | null>;
  acceptOutputBinding(
    input: AcceptProtectedTaskRunOutputBindingInput,
  ): Promise<AcceptProtectedTaskRunOutputBindingResult>;
  prepareExecution(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    predispatch: ProtectedTaskPredispatchPlan;
    policy: ProtectedTaskRuntimeMemoryPolicy;
    reference: TaskRuntimeGrantClaimPlan["reference"];
    /** Server-derived original routing commitment for a later atomic park. */
    stableRoutingDigest: Uint8Array;
    scopeMemory?: TaskScopeMemoryBinding;
    /** Exact committed preimage; retained only for fixed Scope execution admission. */
    scopeWorkIdentity?: string;
  }>): Promise<Readonly<{
    executor: TaskRuntimeGrantClaimPlan["executor"];
    openTransientInput: TaskRuntimeGrantClaimPlan["openTransientInput"];
    modelAttribution?: "external";
  }>>;
  startProtectedTaskRun: TaskRuntimeGrantClaimPlan["startProtectedTaskRun"];
  publishResult: TaskRuntimeGrantClaimPlan["publishResult"];
  now?: () => number;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function sameProtectedTaskRuntimeOccurrence(
  left: ProtectedTaskOccurrence,
  right: ProtectedTaskOccurrence,
): boolean {
  return left.task.id === right.task.id
    && left.task.ownerId === right.task.ownerId
    && left.task.requestorId === right.task.requestorId
    && left.task.agentId === right.task.agentId
    && left.task.callingRoomId === right.task.callingRoomId
    && left.task.scheduleKind === right.task.scheduleKind
    && left.task.contentRepresentation === right.task.contentRepresentation
    && left.task.contentNamespaceId === right.task.contentNamespaceId
    && left.task.contentRevision === right.task.contentRevision
    && left.task.cryptoObjectId === right.task.cryptoObjectId
    && left.task.cryptoAccessRevision === right.task.cryptoAccessRevision
    && sameBytes(
      left.task.cryptoRequiredNamespaceFingerprint,
      right.task.cryptoRequiredNamespaceFingerprint,
    )
    && left.run.id === right.run.id
    && left.run.taskId === right.run.taskId
    && left.run.jobId === right.run.jobId
    && left.run.graphThreadId === right.run.graphThreadId
    && left.run.status === right.run.status
    && left.run.startedAt.getTime() === right.run.startedAt.getTime();
}

export function protectedTaskRuntimeNamespaceInventory(
  plan: Pick<ProtectedTaskPredispatchPlan, "memory" | "occurrence">,
  outputDestination: ProtectedTaskRunOutputDestination | null,
  scopeMemory?: TaskScopeMemoryBinding,
): Readonly<{
  namespaceIds: readonly string[];
  operations(namespaceId: string): readonly ("decrypt" | "encrypt")[];
}> {
  const { envelope } = plan.memory;
  const contentNamespaceId = plan.occurrence.task.contentNamespaceId;
  if (envelope.memoryMode === "scope") {
    if (scopeMemory === undefined) {
      throw new TypeError("Protected Task Scope Memory inventory is unavailable");
    }
    const readable = new Set(scopeMemory.readableNamespaceIds);
    const encryptable = new Set([
      scopeMemory.originWritableNamespaceId,
      contentNamespaceId,
      ...(outputDestination === null ? [] : [outputDestination.namespaceId]),
    ]);
    readable.add(contentNamespaceId);
    if (outputDestination !== null) readable.add(outputDestination.namespaceId);
    return Object.freeze({
      namespaceIds: Object.freeze([...new Set([
        ...readable,
        ...encryptable,
      ])].sort()),
      operations: (namespaceId: string) => Object.freeze([
        ...(readable.has(namespaceId) ? ["decrypt" as const] : []),
        ...(encryptable.has(namespaceId) ? ["encrypt" as const] : []),
      ]),
    });
  }
  const readable = new Set(envelope.readableNamespaces);
  const encryptable = new Set([
    ...envelope.mutableNamespaces,
    ...envelope.writableNamespaces,
  ]);
  readable.add(contentNamespaceId);
  encryptable.add(contentNamespaceId);
  if (outputDestination !== null) {
    readable.add(outputDestination.namespaceId);
    encryptable.add(outputDestination.namespaceId);
  }
  const namespaceIds = Object.freeze([...new Set([
    ...readable,
    ...encryptable,
  ])].sort());
  return Object.freeze({
    namespaceIds,
    operations: (namespaceId: string) => Object.freeze([
      ...(readable.has(namespaceId) ? ["decrypt" as const] : []),
      ...(encryptable.has(namespaceId) ? ["encrypt" as const] : []),
    ]),
  });
}

export function canonicalProtectedTaskRuntimeAuthority(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  inventory: ReturnType<typeof protectedTaskRuntimeNamespaceInventory>;
  facts: readonly ProtectedTaskRuntimeNamespaceAuthorityFact[];
}>): Readonly<{
  policyRevision: number;
  namespaces: BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["namespaceRequirements"];
  domains: BackgroundAuthorizationTaskRuntimeRecordV3["authoritySet"]["domainRequirements"];
}> {
  const { facts, inventory, occurrence } = input;
  if (facts.length !== inventory.namespaceIds.length) {
    throw new TypeError("Protected Task Namespace authority inventory is incomplete");
  }
  const ordered = [...facts].sort((left, right) =>
    left.namespaceId.localeCompare(right.namespaceId));
  if (ordered.some((fact, index) =>
    fact.namespaceId !== inventory.namespaceIds[index]
    || !Number.isSafeInteger(fact.expectedAccessRevision)
    || fact.expectedAccessRevision < 0
    || !Number.isSafeInteger(fact.expectedPolicyRevision)
    || fact.expectedPolicyRevision < 1
    || !Number.isSafeInteger(fact.expectedDomainEpoch)
    || fact.expectedDomainEpoch < 1
    || !Number.isSafeInteger(fact.expectedAuthorizationRevision)
    || fact.expectedAuthorizationRevision < 0
    || fact.domainId.length === 0
  )) throw new TypeError("Protected Task Namespace authority inventory is invalid");
  const policyRevision = ordered[0]?.expectedPolicyRevision;
  if (policyRevision === undefined
    || ordered.some((fact) => fact.expectedPolicyRevision !== policyRevision)) {
    throw new TypeError("Protected Task policy authority is not canonical");
  }
  const content = ordered.find((fact) =>
    fact.namespaceId === occurrence.task.contentNamespaceId);
  if (content === undefined) {
    throw new TypeError("Protected Task content authority is stale");
  }
  const namespaces = Object.freeze(ordered.map((fact, ordinal) => Object.freeze({
    ordinal,
    namespaceId: fact.namespaceId,
    domainId: fact.domainId,
    operations: inventory.operations(fact.namespaceId),
    expectedAccessRevision: fact.expectedAccessRevision,
    expectedPolicyRevision: fact.expectedPolicyRevision,
  })));
  const byDomain = new Map<string, ProtectedTaskRuntimeNamespaceAuthorityFact>();
  for (const fact of ordered) {
    const existing = byDomain.get(fact.domainId);
    if (existing !== undefined
      && (existing.expectedDomainEpoch !== fact.expectedDomainEpoch
        || existing.expectedAuthorizationRevision
          !== fact.expectedAuthorizationRevision)) {
      throw new TypeError("Protected Task domain authority is inconsistent");
    }
    byDomain.set(fact.domainId, fact);
  }
  const domains = Object.freeze([...byDomain.values()]
    .sort((left, right) => left.domainId.localeCompare(right.domainId))
    .map((fact, ordinal) => Object.freeze({
      ordinal,
      domainId: fact.domainId,
      expectedEpoch: fact.expectedDomainEpoch,
      expectedAuthorizationRevision: fact.expectedAuthorizationRevision,
    })));
  return Object.freeze({ policyRevision, namespaces, domains });
}

/**
 * Builds the exact V3 grant plan for one already-revalidated protected Task
 * occurrence. This composition is intentionally inert until its returned plan
 * is supplied to the Runtime claim owner.
 */
export function createProtectedTaskRuntimeGrantPlanBuilder(
  dependencies: ProtectedTaskRuntimeGrantPlanBuilderDependencies,
): (occurrence: ProtectedTaskOccurrence) => Promise<TaskRuntimeGrantClaimPlan> {
  const now = dependencies.now ?? Date.now;
  if (!Number.isSafeInteger(dependencies.recipientTtlMs)
    || dependencies.recipientTtlMs < 1
    || dependencies.recipientTtlMs
      > DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2) {
    throw new TypeError("Protected Task recipient TTL is invalid");
  }
  for (const required of [
    dependencies.prepareExecution,
    dependencies.resolveOutputDestination,
    dependencies.acceptOutputBinding,
    dependencies.startProtectedTaskRun,
    dependencies.publishResult,
  ]) {
    if (typeof required !== "function") {
      throw new TypeError("Protected Task execution sink is unavailable");
    }
  }

  return async occurrence => {
    if (occurrence.task.cryptoAccessRevision !== 0
      || occurrence.task.cryptoObjectId !== deriveTaskContentCryptoObjectIdV1({
        kind: "definition",
        taskId: occurrence.task.id,
        contentRevision: occurrence.task.contentRevision,
      })) {
      throw new TypeError("Protected Task definition coordinates are invalid");
    }
    const prepared = await dependencies.predispatch(occurrence);
    if (!sameProtectedTaskRuntimeOccurrence(occurrence, prepared.occurrence)) {
      throw new TypeError("Protected Task predispatch substituted its occurrence");
    }
    if (prepared.scheduling.ownerId !== occurrence.task.ownerId
      || prepared.scheduling.requestorId !== occurrence.task.requestorId
      || prepared.scheduling.agentId !== occurrence.task.agentId
      || prepared.scheduling.roomId !== prepared.target.roomId
      || prepared.scheduling.callingRoomId !== occurrence.task.callingRoomId
      || prepared.scheduling.graphThreadId !== occurrence.run.graphThreadId) {
      throw new TypeError("Protected Task predispatch scheduling is not exact");
    }
    const outputDestination = await dependencies.resolveOutputDestination(occurrence);
    if ((occurrence.task.callingRoomId === null) !== (outputDestination === null)
      || outputDestination !== null && (
        outputDestination.roomId !== occurrence.task.callingRoomId
        || !UUID.test(outputDestination.namespaceId)
      )) {
      throw new TypeError("Protected Task output destination is invalid");
    }
    let scopeMemory: TaskScopeMemoryBinding | undefined;
    if (prepared.memory.envelope.memoryMode === "scope") {
      const envelopeOrigin = "originWritableNamespaceId"
        in prepared.memory.envelope
        ? prepared.memory.envelope.originWritableNamespaceId
        : null;
      if (typeof envelopeOrigin !== "string") {
        throw new TypeError("Protected Task Scope Memory origin is unavailable");
      }
      const expectedScope = Object.freeze({
        taskId: occurrence.task.id,
        taskRunId: occurrence.run.id,
        requesterUserId: occurrence.task.requestorId,
        agentId: occurrence.task.agentId,
        contentNamespaceId: occurrence.task.contentNamespaceId,
        scopeId: prepared.memory.envelope.scopeId,
        memoryRoomId: prepared.memory.envelope.roomId,
        originWritableNamespaceId: envelopeOrigin,
      });
      if (dependencies.resolveScopeMemoryInventory === undefined) {
        throw new TypeError(
          "Protected Task Scope Memory inventory resolver is unavailable",
        );
      }
      scopeMemory = copyTaskScopeMemoryBinding(
        await dependencies.resolveScopeMemoryInventory({
          occurrence,
          predispatch: prepared,
        }),
      );
      if (scopeMemory.scopeId !== prepared.memory.envelope.scopeId
        || scopeMemory.memoryRoomId !== prepared.memory.envelope.roomId
        || scopeMemory.originWritableNamespaceId
          !== envelopeOrigin
        || occurrence.task.id !== expectedScope.taskId
        || occurrence.run.id !== expectedScope.taskRunId
        || occurrence.task.requestorId !== expectedScope.requesterUserId
        || occurrence.task.agentId !== expectedScope.agentId
        || occurrence.task.contentNamespaceId
          !== expectedScope.contentNamespaceId
        || prepared.memory.envelope.scopeId !== expectedScope.scopeId
        || prepared.memory.envelope.roomId !== expectedScope.memoryRoomId
        || ("originWritableNamespaceId" in prepared.memory.envelope
          ? prepared.memory.envelope.originWritableNamespaceId
          : null) !== expectedScope.originWritableNamespaceId) {
        throw new TypeError("Protected Task Scope Memory inventory is not exact");
      }
    }
    const inventory = protectedTaskRuntimeNamespaceInventory(
      prepared,
      outputDestination,
      scopeMemory,
    );
    const resolvedAuthority = await dependencies.resolveNamespaceAuthority({
      occurrence,
      predispatch: prepared,
      namespaceIds: inventory.namespaceIds,
      ...(scopeMemory === undefined ? {} : { scopeMemory }),
    });
    if (!UUID.test(resolvedAuthority.sourceRoomId)
      || resolvedAuthority.sourceNamespaceId
        !== occurrence.task.contentNamespaceId
      || resolvedAuthority.policy.revision < 1
      || !Number.isSafeInteger(resolvedAuthority.policy.revision)
      || (resolvedAuthority.policy.shadowBehavior !== "fallback"
        && resolvedAuthority.policy.shadowBehavior !== "strict")
      || (resolvedAuthority.policy.mode === "shadow_encryption"
        ? occurrence.task.contentRepresentation !== "dual"
        : resolvedAuthority.policy.mode === "encrypted_only"
          ? occurrence.task.contentRepresentation !== "protected"
          : true)) {
      throw new TypeError("Protected Task source Room authority is unavailable");
    }
    const authority = canonicalProtectedTaskRuntimeAuthority({
      occurrence,
      inventory,
      facts: resolvedAuthority.facts,
    });
    if (resolvedAuthority.policy.revision !== authority.policyRevision) {
      throw new TypeError("Protected Task policy authority is unavailable");
    }
    const contentAuthority = authority.namespaces.find((entry) =>
      entry.namespaceId === occurrence.task.contentNamespaceId)!;
    const contentDomain = authority.domains.find((entry) =>
      entry.domainId === contentAuthority.domainId)!;
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new TypeError("Protected Task grant clock is invalid");
    }
    const requestId = `task-run-authorization:${occurrence.run.id}`;
    const resultObjectId = deriveTaskContentCryptoObjectIdV1({
      kind: "run_result",
      taskId: occurrence.task.id,
      taskRunId: occurrence.run.id,
      contentRevision: 1,
    });
    const output = await dependencies.acceptOutputBinding({
      taskId: occurrence.task.id,
      taskRunId: occurrence.run.id,
      requiredPolicyRevision: authority.policyRevision,
      acceptedAt: new Date(createdAt),
      destination: outputDestination,
    });
    if (output.status === "rejected"
      || output.binding.taskRunId !== occurrence.run.id
      || output.binding.bindingId !== `task-run-output:${occurrence.run.id}`
      || (outputDestination === null
        ? output.binding.deliveryMode !== "none"
        : output.binding.deliveryMode !== "wake"
          && output.binding.deliveryMode !== "raw"
          && output.binding.deliveryMode !== "raw_and_wake")
      || output.binding.destinationRoomId !== (outputDestination?.roomId ?? null)
      || output.binding.destinationNamespaceId
        !== (outputDestination?.namespaceId ?? null)
      || output.binding.resultOperationId !== `task-run-result:${occurrence.run.id}`
      || output.binding.resultObjectId !== resultObjectId
      || output.binding.acceptedPolicyRevision !== authority.policyRevision) {
      throw new TypeError("Protected Task output binding is unavailable");
    }
    let widePrimaryWriteNamespaceId: string | null = null;
    if (prepared.memory.mode === "wide") {
      const envelope = prepared.memory.envelope;
      const primary = envelope.memoryMode === "scope"
        ? undefined
        : envelope.writableNamespaces[0];
      if (primary === undefined || !UUID.test(primary)
        || !inventory.namespaceIds.includes(primary)) {
        throw new TypeError(
          "Protected Task wide Memory write target is unavailable",
        );
      }
      widePrimaryWriteNamespaceId = primary;
    }
    const stableIdentity: TaskRuntimeGrantStableIdentity = Object.freeze({
      taskId: occurrence.task.id,
      taskRunId: occurrence.run.id,
      executionSegment: 1,
      resumeContinuationFingerprint: null,
      ownerId: occurrence.task.ownerId,
      requestorId: occurrence.task.requestorId,
      agentId: occurrence.task.agentId,
      callingRoomId: occurrence.task.callingRoomId,
      scheduleKind: occurrence.task.scheduleKind,
      graphThreadId: occurrence.run.graphThreadId,
      startedAt: occurrence.run.startedAt.getTime(),
      sourceRoomId: resolvedAuthority.sourceRoomId,
      targetRoomId: prepared.target.roomId,
      targetUserIds: Object.freeze(
        [...prepared.target.targetUserIds].sort(),
      ),
      outputRoomId: outputDestination?.roomId ?? null,
      outputNamespaceId: outputDestination?.namespaceId ?? null,
      memoryMode: prepared.memory.mode,
      scopeId: prepared.memory.envelope.memoryMode === "scope"
        ? prepared.memory.envelope.scopeId
        : null,
      contentRepresentation: occurrence.task.contentRepresentation,
      contentNamespaceId: occurrence.task.contentNamespaceId,
      contentRevision: occurrence.task.contentRevision,
      contentObjectId: occurrence.task.cryptoObjectId,
      contentAccessRevision: occurrence.task.cryptoAccessRevision,
      requiredNamespaceFingerprint: Buffer.from(
        occurrence.task.cryptoRequiredNamespaceFingerprint,
      ).toString("base64url"),
    });
    const workIdentity = JSON.stringify({
        taskId: occurrence.task.id,
        taskRunId: occurrence.run.id,
        scheduleKind: occurrence.task.scheduleKind,
        sourceRoomId: resolvedAuthority.sourceRoomId,
        targetRoomId: prepared.target.roomId,
        outputRoomId: outputDestination?.roomId ?? null,
        outputNamespaceId: outputDestination?.namespaceId ?? null,
        targetUserIds: [...prepared.target.targetUserIds].sort(),
        memoryMode: prepared.memory.mode,
        scopeId: prepared.memory.envelope.memoryMode === "scope"
          ? prepared.memory.envelope.scopeId : null,
        inputObjectId: occurrence.task.cryptoObjectId,
        contentRevision: occurrence.task.contentRevision,
        fingerprint: Buffer.from(
          occurrence.task.cryptoRequiredNamespaceFingerprint,
        ).toString("base64url"),
        policyRevision: authority.policyRevision,
        ...(scopeMemory === undefined ? {} : { scopeMemory }),
        ...(widePrimaryWriteNamespaceId === null ? {} : { widePrimaryWriteNamespaceId }),
        namespaces: authority.namespaces,
        domains: authority.domains,
      });
    const initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = Object.freeze({
      snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
        requestId,
        workId: occurrence.run.id,
        namespaceId: occurrence.task.contentNamespaceId,
        now: createdAt,
      }),
      workIdentityHash: createHash("sha256").update(workIdentity).digest(),
      idempotencyKey: taskRuntimeStableIdempotencyKey(stableIdentity),
      workKind: "task.execute",
      purpose: "task.execute",
      domainId: contentAuthority.domainId,
      processorAuthorizationRevision: null,
      expectedDomainEpoch: contentDomain.expectedEpoch,
      expectedNamespaceAccessRevision: contentAuthority.expectedAccessRevision,
      expectedPolicyRevision: authority.policyRevision,
      descriptorBytes: null,
      acceptedMaterial: null,
      finishedAt: null,
      authoritySet: Object.freeze({
        namespaceRequirements: authority.namespaces,
        domainRequirements: authority.domains,
      }),
    });
    const reference = Object.freeze({
      kind: "protected_task_run_v1" as const,
      taskId: occurrence.task.id,
      taskRunId: occurrence.run.id,
      inputObjectId: occurrence.task.cryptoObjectId,
      resultObjectId,
      authorizationRequestId: requestId,
      policyRevision: authority.policyRevision,
      executionSegment: 1,
    });
    const execution = await dependencies.prepareExecution(Object.freeze({
      occurrence,
      predispatch: prepared,
      policy: Object.freeze({ ...resolvedAuthority.policy }),
      reference,
      stableRoutingDigest: taskRuntimeStableRoutingDigest({
        ...stableIdentity,
        widePrimaryWriteNamespaceId,
      }),
      ...(scopeMemory === undefined ? {} : { scopeMemory, scopeWorkIdentity: workIdentity }),
    }));
    const executionKeys = execution !== null && typeof execution === "object"
      ? Object.keys(execution).sort().join(",")
      : "";
    if ((executionKeys !== "executor,openTransientInput"
        && executionKeys !== "executor,modelAttribution,openTransientInput")
      || typeof execution.executor !== "function"
      || typeof execution.openTransientInput !== "function"
      || (execution.modelAttribution !== undefined
        && execution.modelAttribution !== "external")) {
      throw new TypeError("Protected Task execution preparation is invalid");
    }
    // A preparation dependency may perform async route admission, but it may
    // not replace the already-authorized occurrence or its resolved target.
    if (!sameProtectedTaskRuntimeOccurrence(occurrence, prepared.occurrence)
      || prepared.scheduling.roomId !== prepared.target.roomId) {
      throw new TypeError("Protected Task execution preparation changed predispatch");
    }
    const recipientRequest = createProtectedTaskRuntimeRecipientRequestPlan({
      crypto: dependencies.crypto,
      occurrence,
      initialRecord,
      sourceRoomId: resolvedAuthority.sourceRoomId,
      authority,
      createdAt,
      recipientTtlMs: dependencies.recipientTtlMs,
    });

    return Object.freeze({
      stableIdentity,
      initialRecord,
      reference,
      scheduling: prepared.scheduling,
      ...(scopeMemory === undefined ? {} : { scopeMemory }),
      executor: execution.executor,
      startProtectedTaskRun: dependencies.startProtectedTaskRun,
      ...recipientRequest,
      openTransientInput: execution.openTransientInput,
      publishResult: dependencies.publishResult,
      ...(execution.modelAttribution === undefined
        ? {}
        : { modelAttribution: execution.modelAttribution }),
    });
  };
}
