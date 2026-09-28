import { createHash } from "node:crypto";

import {
  authorizationRevision,
  createDomainForegroundAuthorizationPlan,
  cryptoDeviceId,
  humanId,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  createTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
  DOMAIN_FOREGROUND_AUTHORIZATION_MAX_TTL_MS_V2,
  destroyDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type TaskRuntimeGrantClaimPlan,
  type ProtectedTaskPredispatchPlan,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type ProtectedTaskRuntimeNamespaceAuthorityFact = Readonly<{
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
  expectedDomainEpoch: number;
  expectedAuthorizationRevision: number;
}>;

export type ProtectedTaskRuntimeGrantPlanBuilderDependencies = Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  recipientTtlMs: number;
  predispatch(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<ProtectedTaskPredispatchPlan>;
  resolveNamespaceAuthority(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    predispatch: ProtectedTaskPredispatchPlan;
    namespaceIds: readonly string[];
  }>): Promise<Readonly<{
    /** Current requester-private Room anchoring the protected Task definition. */
    sourceRoomId: string;
    sourceNamespaceId: string;
    facts: readonly ProtectedTaskRuntimeNamespaceAuthorityFact[];
  }>>;
  prepareExecution(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    predispatch: ProtectedTaskPredispatchPlan;
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

function sameOccurrence(
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

function namespaceInventory(plan: ProtectedTaskPredispatchPlan): Readonly<{
  namespaceIds: readonly string[];
  operations(namespaceId: string): readonly ("decrypt" | "encrypt")[];
}> {
  const { envelope } = plan.memory;
  const contentNamespaceId = plan.occurrence.task.contentNamespaceId;
  if (envelope.memoryMode === "scope") {
    // Scope records can retain additional Namespaces dynamically. They are not
    // ambient authority for this initial grant: each read must acquire current
    // operation-time authority. The envelope exposes only its proven origin,
    // which is required here together with the protected Task definition.
    const originNamespaceId = "originWritableNamespaceId" in envelope
      ? envelope.originWritableNamespaceId
      : null;
    if (typeof originNamespaceId !== "string" || originNamespaceId.length === 0) {
      throw new TypeError("Protected Task Scope Memory origin is unavailable");
    }
    return Object.freeze({
      namespaceIds: Object.freeze([...new Set([
        contentNamespaceId,
        originNamespaceId,
      ])].sort()),
      operations: () => Object.freeze(["decrypt", "encrypt"] as const),
    });
  }
  const readable = new Set(envelope.readableNamespaces);
  const encryptable = new Set([
    ...envelope.mutableNamespaces,
    ...envelope.writableNamespaces,
  ]);
  readable.add(contentNamespaceId);
  encryptable.add(contentNamespaceId);
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

function canonicalAuthority(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  inventory: ReturnType<typeof namespaceInventory>;
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
    if (!sameOccurrence(occurrence, prepared.occurrence)) {
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
    const inventory = namespaceInventory(prepared);
    const resolvedAuthority = await dependencies.resolveNamespaceAuthority({
      occurrence,
      predispatch: prepared,
      namespaceIds: inventory.namespaceIds,
    });
    if (!UUID.test(resolvedAuthority.sourceRoomId)
      || resolvedAuthority.sourceNamespaceId
        !== occurrence.task.contentNamespaceId) {
      throw new TypeError("Protected Task source Room authority is unavailable");
    }
    const authority = canonicalAuthority({
      occurrence,
      inventory,
      facts: resolvedAuthority.facts,
    });
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
    const initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = Object.freeze({
      snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
        requestId,
        workId: occurrence.run.id,
        namespaceId: occurrence.task.contentNamespaceId,
        now: createdAt,
      }),
      workIdentityHash: createHash("sha256").update(JSON.stringify({
        taskId: occurrence.task.id,
        taskRunId: occurrence.run.id,
        scheduleKind: occurrence.task.scheduleKind,
        sourceRoomId: resolvedAuthority.sourceRoomId,
        targetRoomId: prepared.target.roomId,
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
        namespaces: authority.namespaces,
        domains: authority.domains,
      })).digest(),
      idempotencyKey: `task-run:${occurrence.run.id}`,
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
    if (!sameOccurrence(occurrence, prepared.occurrence)
      || prepared.scheduling.roomId !== prepared.target.roomId) {
      throw new TypeError("Protected Task execution preparation changed predispatch");
    }

    return Object.freeze({
      initialRecord,
      reference,
      scheduling: prepared.scheduling,
      executor: execution.executor,
      startProtectedTaskRun: dependencies.startProtectedTaskRun,
      recipientAttempt: ({ record, now: attemptAt }) => {
        if (record.snapshot.requestId !== requestId
          || record.snapshot.workId !== occurrence.run.id
          || record.expectedPolicyRevision !== authority.policyRevision
          || record.idempotencyKey !== initialRecord.idempotencyKey
          || !sameBytes(record.workIdentityHash, initialRecord.workIdentityHash)) {
          throw new TypeError("Protected Task recipient record is not exact");
        }
        const expiresAt = attemptAt + dependencies.recipientTtlMs;
        if (!Number.isSafeInteger(attemptAt) || attemptAt < createdAt
          || !Number.isSafeInteger(expiresAt)) {
          throw new TypeError("Protected Task recipient deadline is invalid");
        }
        return Object.freeze({
          recipientKeyId:
            `task-runtime:${occurrence.run.id}:${record.snapshot.recipientGeneration}`,
          expiresAt,
        });
      },
      buildRequest: ({ record, attempt, binding, authority: current }) => {
        const issuedAt = attempt.expiresAt - dependencies.recipientTtlMs;
        const currentDomains = [...current.domains]
          .sort((left, right) => left.domainId.localeCompare(right.domainId));
        if (record.snapshot.requestId !== requestId
          || record.snapshot.workId !== occurrence.run.id
          || record.idempotencyKey !== initialRecord.idempotencyKey
          || !sameBytes(record.workIdentityHash, initialRecord.workIdentityHash)
          || attempt.requestId !== requestId
          || attempt.workId !== occurrence.run.id
          || attempt.recipientGeneration !== record.snapshot.recipientGeneration
          || attempt.recipientKeyId
            !== `task-runtime:${occurrence.run.id}:${attempt.recipientGeneration}`
          || binding.userId !== occurrence.task.requestorId
          || current.device.userId !== binding.userId
          || current.device.humanActorId !== binding.humanActorId
          || current.device.deviceId !== binding.deviceId
          || current.sourceRoomId !== resolvedAuthority.sourceRoomId
          || current.policyRevision !== authority.policyRevision
          || !sameRequirements(current.namespaceRequirements, authority.namespaces)
          || currentDomains.length !== authority.domains.length
          || currentDomains.some((domain, index) => {
            const expected = authority.domains[index];
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
        const grant = createDomainForegroundAuthorizationPlan(
          dependencies.crypto,
          {
            authorizationId: requestId,
            policyRevision: authority.policyRevision,
            sessionId: `task-run:${occurrence.run.id}`,
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
            operations: ["decrypt", "encrypt"],
            issuedAt,
            deadlineAt: attempt.expiresAt,
            maximumSecretBytes:
              DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
            domains: currentDomains,
          },
        );
        try {
          return createTaskRuntimeBackgroundAuthorizationRequestV1({
            requestId,
            workId: occurrence.run.id,
            workKind: "task.execute",
            workPurpose: "task.execute",
            recipientGeneration: attempt.recipientGeneration,
            episodeId: grant.sessionId,
            sourceRoomId: current.sourceRoomId,
            recipientKeyId: attempt.recipientKeyId,
            recipientPublicKey: attempt.recipientPublicKey,
            authorizationPlan: grant,
            issuedAt,
            deadlineAt: attempt.expiresAt,
          });
        } finally {
          destroyDomainForegroundAuthorizationPlanV2(grant);
        }
      },
      openTransientInput: execution.openTransientInput,
      publishResult: dependencies.publishResult,
      ...(execution.modelAttribution === undefined
        ? {}
        : { modelAttribution: execution.modelAttribution }),
    });
  };
}
