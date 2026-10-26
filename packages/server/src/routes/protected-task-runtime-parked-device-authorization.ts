import { createProtectedTaskRuntimeMappedHeadReplan, type ProtectedTaskRuntimeMappedHeadReplan } from "./protected-task-runtime-mapped-head-replan";
import { createProtectedTaskRuntimeAccessLineageReader } from "./protected-task-runtime-access-lineage";
import {
  getEncryptionTransitionPolicy, createPostgresJsBridgeConnection, getSharedDirectCryptoDb,
  getProtectedTaskRunOutputBinding,
  type DirectDatabase, type PostgresJsBridgeConnection,
} from "@nautilo/db";
import { LatticeCrypto, type TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  parseDomainForegroundAuthorizationPlanV2, destroyDomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";
import {
  matchesCurrentTaskRuntimeAuthority, matchesStenographerRequestAdmission,
  verifyCryptoPostgresHandle, withParkedTaskRuntimeRecipientAuthority, withParkedTaskRuntimeNamespaceAuthority,
  type InitialTaskRuntimeRecipientAuthority, type ParkedTaskRuntimeCurrentRoutingFacts,
} from "@nautilo/lattice-bridge/server";
import {
  attachExactTaskRuntimeRecipient, sameTaskRuntimeAuthorityPlan,
  PostgresBackgroundAuthorizationRepository, TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
} from "@nautilo/runtime";
import type { PolicyResolver } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { createHumanProductTransactionContext } from "./human-message-product-store";
import type { createProductionBackgroundAuthorizationComposition } from "./background-authorization-composition";
import { createProtectedTaskRuntimeParkedMemoryPlanResolver } from "./protected-task-runtime-parked-memory-plan";
import {
  createParkedTaskRuntimeAuthorizationPlanResolver,
  discoverParkedProtectedTaskContinuation, createParkedTaskRuntimeAuthorizationRecord,
  type ParkedTaskRuntimeAuthorizationPlan,
} from "./protected-task-runtime-parked-plan";
import { createProtectedTaskRuntimeRecipientRequestPlan } from "./protected-task-runtime-recipient-request-plan";

type DeviceHooks = Required<Pick<NonNullable<Parameters<
  typeof createProductionBackgroundAuthorizationComposition
>[0]>, "bindTaskRecipient" | "withTaskAuthority" | "isTaskRecipientActive">>;
type DeviceInput = Parameters<DeviceHooks["withTaskAuthority"]>[0];
type Dependencies = Readonly<{
  db: DirectDatabase;
  crypto: LatticeCrypto;
  serverScope: string;
  now: () => number;
  resolvePlan: ReturnType<typeof createParkedTaskRuntimeAuthorizationPlanResolver>;
  productContext: typeof createHumanProductTransactionContext;
  withRecipientAuthority: typeof withParkedTaskRuntimeRecipientAuthority;
  withNamespaceAuthority: typeof withParkedTaskRuntimeNamespaceAuthority;
  mappedHeadReplan: ProtectedTaskRuntimeMappedHeadReplan;
  repository(connection: PostgresJsBridgeConnection): Promise<BackgroundAuthorizationTaskRuntimeReplacementRepository>;
  attach: typeof attachExactTaskRuntimeRecipient;
}>;

type HeldPlan = Readonly<{
  resolved: ParkedTaskRuntimeAuthorizationPlan;
  current: InitialTaskRuntimeRecipientAuthority;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  canonical: ReturnType<typeof createParkedTaskRuntimeAuthorizationRecord>;
  repository: BackgroundAuthorizationTaskRuntimeReplacementRepository;
  restricted: PostgresJsBridgeConnection;
}>;

/** Only parked segment grants; ordinary processor and initial Task transport stay separate. */
export function createProtectedTaskRuntimeParkedDeviceAuthorization(
  input: Readonly<{ resolver: PolicyResolver; recipients: TaskRuntimeRecipientRegistry }>,
  overrides: Partial<Dependencies> = {},
): DeviceHooks {
  const db = overrides.db ?? getServerDirectDb();
  const crypto = overrides.crypto ?? new LatticeCrypto();
  const recipients = input.recipients;
  const dependencies: Dependencies = {
    db, crypto,
    serverScope: overrides.serverScope
      ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001"),
    now: overrides.now ?? Date.now,
    resolvePlan: overrides.resolvePlan ?? createParkedTaskRuntimeAuthorizationPlanResolver({
      db, discover: discoverParkedProtectedTaskContinuation,
      readAccessLineage: createProtectedTaskRuntimeAccessLineageReader({ db, crypto,
        restricted: () => createPostgresJsBridgeConnection(getSharedDirectCryptoDb()) }),
      readOutput: getProtectedTaskRunOutputBinding, readPolicy: getEncryptionTransitionPolicy,
      resolveMemory: createProtectedTaskRuntimeParkedMemoryPlanResolver({ db, resolver: input.resolver }),
    }),
    productContext: overrides.productContext ?? createHumanProductTransactionContext,
    withRecipientAuthority: overrides.withRecipientAuthority ?? withParkedTaskRuntimeRecipientAuthority,
    withNamespaceAuthority: overrides.withNamespaceAuthority ?? withParkedTaskRuntimeNamespaceAuthority,
    mappedHeadReplan: overrides.mappedHeadReplan ?? createProtectedTaskRuntimeMappedHeadReplan({
      db, crypto, recipients, now: overrides.now ?? Date.now,
      serverScope: overrides.serverScope ?? (process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001"),
    }),
    repository: overrides.repository ?? (async connection =>
      new PostgresBackgroundAuthorizationRepository(await verifyCryptoPostgresHandle(connection))),
    attach: overrides.attach ?? attachExactTaskRuntimeRecipient,
  };
  const isTaskRecipientActive: DeviceHooks["isTaskRecipientActive"] = record => {
    const recipient = record.snapshot.recipient;
    return recipient !== null && recipients.hasAttempt({
      requestId: record.snapshot.requestId, workId: record.snapshot.workId,
      recipientGeneration: record.snapshot.recipientGeneration, recipientKeyId: recipient.recipientKeyId,
    });
  };
  const replanMappedHead = async (operation: Pick<DeviceInput, "record" | "admission" | "restricted">): Promise<boolean> => {
    if (!["awaiting_recipient", "awaiting_device"].includes(operation.record.snapshot.state)) return true;
    const coordinates = { taskRunId: operation.record.snapshot.workId, authorizationRequestId: operation.record.snapshot.requestId };
    const resolved = await dependencies.resolvePlan(coordinates);
    if (resolved === null) return false;
    return await dependencies.mappedHeadReplan({ occurrence: resolved.expected.occurrence,
      record: operation.record, admission: operation.admission, restricted: operation.restricted,
      resolvePlan: async () => {
        const current = await dependencies.resolvePlan(coordinates);
        if (current === null) return null;
        const { expected, memory, inventory, policy } = current;
        const occurrence = expected.occurrence;
        const product = await dependencies.productContext(occurrence.task.requestorId, db);
        let routing: ParkedTaskRuntimeCurrentRoutingFacts | null = null;
        return dependencies.withNamespaceAuthority({ runner: product.canonicalRunner, restricted: operation.restricted,
          crypto, serverScope: dependencies.serverScope, taskId: occurrence.task.id,
          requesterUserId: occurrence.task.requestorId, requesterHumanId: memory.routing.requesterHumanId,
          agentId: occurrence.task.agentId, contentNamespaceId: occurrence.task.contentNamespaceId,
          sourceRoomId: memory.routing.sourceRoomId, targetRoomId: memory.routing.targetRoomId,
          namespaceIds: inventory.namespaceIds, expectedPolicyRevision: policy.revision,
          ...(memory.scopeMemory === undefined ? {} : { scopeMemory: memory.scopeMemory }),
          ...(memory.expectedNamespaceParticipants === undefined ? {} : { expectedNamespaceParticipants: memory.expectedNamespaceParticipants }),
          expected, authorizationRequestId: expected.authorizationRequestId,
          validateCurrentRouting: facts => {
            if (!current.validateCurrentRouting(facts)) return false;
            routing = structuredClone(facts); return true;
          },
          use: authority => {
            if (routing === null) throw new TypeError("Task current routing is unavailable");
            const plan = createParkedTaskRuntimeAuthorizationRecord(current, routing, authority.facts, dependencies.now());
            return Promise.resolve({ occurrence, stableIdentity: plan.stableIdentity, initialRecord: plan.initialRecord });
          },
        });
      } }) === "unchanged";
  };

  const withHeldPlan = async <Value>(
    operation: Pick<DeviceInput, "subject" | "admission" | "restricted" | "record">,
    use: (held: HeldPlan) => Promise<Value | null>,
  ): Promise<Value | null> => {
    const selected = structuredClone(operation.record);
    const subject = structuredClone(operation.subject);
    const admission = structuredClone(operation.admission);
    const restricted = operation.restricted;
    const resolved = await dependencies.resolvePlan({
      taskRunId: selected.snapshot.workId, authorizationRequestId: selected.snapshot.requestId,
    });
    if (resolved === null || subject.userId !== resolved.expected.occurrence.task.requestorId
      || subject.humanActorId !== resolved.memory.routing.requesterHumanId
      || selected.expectedPolicyRevision !== resolved.policy.revision
      || resolved.inventory.namespaceIds.length !== selected.authoritySet.namespaceRequirements.length
      || resolved.inventory.namespaceIds.some((id, index) =>
        id !== selected.authoritySet.namespaceRequirements[index]?.namespaceId)) return null;
    const { expected, memory } = resolved;
    const occurrence = expected.occurrence;
    const product = await dependencies.productContext(subject.userId, db);
    let routing: ParkedTaskRuntimeCurrentRoutingFacts | null = null;
    return dependencies.withRecipientAuthority({
      runner: product.canonicalRunner, restricted, crypto, serverScope: dependencies.serverScope,
      taskId: occurrence.task.id, requesterUserId: subject.userId,
      requesterHumanId: subject.humanActorId, agentId: occurrence.task.agentId,
      contentNamespaceId: occurrence.task.contentNamespaceId,
      sourceRoomId: memory.routing.sourceRoomId, targetRoomId: memory.routing.targetRoomId,
      expectedPolicyRevision: resolved.policy.revision, deviceId: subject.deviceId,
      namespaceIds: resolved.inventory.namespaceIds,
      namespaceRequirements: selected.authoritySet.namespaceRequirements,
      domainRequirements: selected.authoritySet.domainRequirements,
      ...(memory.scopeMemory === undefined ? {} : { scopeMemory: memory.scopeMemory }),
      ...(memory.expectedNamespaceParticipants === undefined ? {} : {
        expectedNamespaceParticipants: memory.expectedNamespaceParticipants,
      }),
      expected, authorizationRequestId: expected.authorizationRequestId,
      validateCurrentRouting: facts => {
        if (!resolved.validateCurrentRouting(facts)) return false;
        routing = structuredClone(facts);
        return true;
      },
      use: async (current, heldRestricted) => {
        if (routing === null || !matchesStenographerRequestAdmission(admission, current.device, dependencies.now())) return null;
        const facts = current.namespaceRequirements.map(namespace => {
          const domain = current.domains.find(value => value.domainId === namespace.domainId);
          if (domain === undefined) throw new TypeError("Parked Task current Domain is missing");
          return { namespaceId: namespace.namespaceId, domainId: namespace.domainId,
            expectedAccessRevision: namespace.expectedAccessRevision,
            expectedPolicyRevision: current.policyRevision,
            expectedDomainEpoch: domain.domainKeyGeneration,
            expectedAuthorizationRevision: domain.authorizationRevision };
        });
        const canonical = createParkedTaskRuntimeAuthorizationRecord(resolved, routing, facts, dependencies.now());
        if (selected.idempotencyKey !== canonical.initialRecord.idempotencyKey
          || !sameTaskRuntimeAuthorityPlan(selected, canonical.initialRecord)) return null;
        const repository = await dependencies.repository(heldRestricted);
        const record = await repository.get(selected.snapshot.requestId);
        if (record === null || record.snapshot.formatVersion !== 3
          || record.snapshot.credentialSubject.kind !== "runtime"
          || record.snapshot.credentialSubject.runtimeKind !== "task"
          || record.snapshot.credentialSubject.runtimeVersion !== 1
          || record.snapshot.requestRevision !== selected.snapshot.requestRevision
          || record.idempotencyKey !== canonical.initialRecord.idempotencyKey
          || !sameTaskRuntimeAuthorityPlan(record as BackgroundAuthorizationTaskRuntimeRecordV3, canonical.initialRecord)) return null;
        const value = await use({ resolved, current, record: record as BackgroundAuthorizationTaskRuntimeRecordV3,
          canonical, repository, restricted: heldRestricted });
        if (!matchesStenographerRequestAdmission(admission, current.device, dependencies.now())) {
          throw new Error("Parked Task device admission expired before commit");
        }
        return value;
      },
    });
  };
  return {
    isTaskRecipientActive,
    bindTaskRecipient: async operation => {
      operation = { ...operation, subject: structuredClone(operation.subject), admission: structuredClone(operation.admission),
        record: structuredClone(operation.record), device: structuredClone(operation.device) };
      if (!await replanMappedHead(operation)) return null;
      const binding = Object.freeze({ userId: operation.subject.userId,
        humanActorId: operation.subject.humanActorId, deviceId: operation.subject.deviceId });
      const attached: { value: Awaited<ReturnType<typeof attachExactTaskRuntimeRecipient>> } = { value: null };
      try {
        return await withHeldPlan(operation, async held => {
          const callbacks = createProtectedTaskRuntimeRecipientRequestPlan({
            crypto, occurrence: held.resolved.expected.occurrence,
            executionIdentity: held.canonical.stableIdentity,
            initialRecord: held.canonical.initialRecord, sourceRoomId: held.current.sourceRoomId,
            authority: held.canonical.authority, createdAt: held.record.snapshot.createdAt,
            recipientTtlMs: TASK_RUNTIME_AUTHORIZATION_ABSOLUTE_LIMIT_MS,
          });
          const bound = await dependencies.attach({
            occurrence: held.resolved.expected.occurrence, selected: held.record,
            plan: { initialRecord: held.canonical.initialRecord, ...callbacks,
              ...(held.resolved.memory.scopeMemory === undefined ? {} : { scopeMemory: held.resolved.memory.scopeMemory }) },
            binding, authority: held.current,
            repository: held.repository, recipients, now: dependencies.now,
          });
          attached.value = bound;
          if (bound !== null && dependencies.now() >= bound.record.snapshot.recipient!.expiresAt) {
            throw new Error("Parked Task recipient expired before commit");
          }
          return bound;
        });
      } catch (error) {
        if (attached.value !== null) recipients.delete(
          attached.value.record.snapshot.requestId, attached.value.record.snapshot.recipientGeneration,
        );
        throw error;
      }
    },
    withTaskAuthority: async operation => {
      operation = { ...operation, subject: structuredClone(operation.subject), admission: structuredClone(operation.admission),
        record: structuredClone(operation.record) };
      if (!await replanMappedHead(operation)) return null;
      const subject = structuredClone(operation.subject);
      const admission = structuredClone(operation.admission);
      const use = operation.use;
      return withHeldPlan({ ...operation, subject, admission }, async held => {
        const { record, current } = held;
        if (!isTaskRecipientActive(record) || record.descriptorBytes === null
          || !["awaiting_device", "grant_ready"].includes(record.snapshot.state)) return null;
        const request = decodeTaskRuntimeBackgroundAuthorizationRequestBase(
          crypto,
          record.descriptorBytes,
        );
        if (request === null) return null;
        const plan = parseDomainForegroundAuthorizationPlanV2(request.authorizationPlanBytes);
        if (plan === null) { destroyTaskRuntimeBackgroundAuthorizationRequestV1(request); return null; }
        try {
          const recipient = record.snapshot.recipient;
          const digest = crypto.hash(record.descriptorBytes);
          const exactDigest = Buffer.from(digest).toString("hex") === record.snapshot.descriptorDigest;
          digest.fill(0);
          if (!exactDigest || recipient === null
            || request.requestId !== record.snapshot.requestId || request.workId !== record.snapshot.workId
            || request.workKind !== record.workKind || request.workPurpose !== record.purpose
            || request.recipientGeneration !== record.snapshot.recipientGeneration
            || request.recipientKeyId !== recipient.recipientKeyId
            || Buffer.from(request.recipientPublicKey).toString("base64url") !== recipient.recipientPublicKey
            || request.deadlineAt !== recipient.expiresAt
            || request.sourceRoomId !== current.sourceRoomId || request.sourceRoomId !== plan.roomId
            || !matchesCurrentTaskRuntimeAuthority({
              request, plan, subject, admission,
              device: current.device, namespaces: record.authoritySet.namespaceRequirements,
              domainRequirements: record.authoritySet.domainRequirements, domains: current.domains,
              policyRevision: current.policyRevision, now: dependencies.now(),
            })) return null;
          const value = await use(request, plan, current.domains, current.device, held.restricted);
          if (dependencies.now() >= request.deadlineAt) {
            throw new Error("Parked Task authorization expired before commit");
          }
          return value;
        } finally {
          destroyDomainForegroundAuthorizationPlanV2(plan);
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
        }
      });
    },
  };
}
