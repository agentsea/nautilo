import type {
  TaskOrdinaryFallbackCreatePlanV1,
  TaskOrdinaryFallbackUpdatePlanV1,
  TaskOrdinaryFallbackPlanCreateRequestV1,
  TaskOrdinaryFallbackPlanUpdateRequestV1,
  TaskOrdinaryFallbackPreparedCreateRequestV1,
  TaskOrdinaryFallbackPreparedUpdateRequestV1,
} from "@nautilo/api-client";
import { validateTaskModelSelectionForCreate } from "@nautilo/agent";
import {
  acquireEncryptionConsumptionFence,
  and,
  eq,
  getTaskByIdWithMutationVersion,
  humanCryptoDevices,
  lockProtectedTaskForegroundCreationIdentity,
  taskDefinitionCryptoRevisions,
  tasks,
  updateTaskIfCurrent,
  type DirectDatabase,
  type NewTask,
  type PostgresJsBridgeConnection,
  type Task,
} from "@nautilo/db";
import {
  createHumanTaskOrdinaryFallbackReplayAdmissionV1,
  decodeHumanTaskOrdinaryFallbackRequestV1,
  decodeTaskDefinitionContent,
  digestHumanTaskOrdinaryFallbackRequestV1,
  fingerprintHumanTaskOrdinaryFallbackContentV1,
  fingerprintHumanTaskOrdinaryFallbackPlanV1,
  fingerprintTaskOperationalFieldsV1,
  selectLiveEncryptionRepresentationPolicy,
  verifyHumanTaskOrdinaryFallbackRequestV1,
  type EncryptionDataOperationOwner,
  type DecodedTaskDefinitionContent,
  type HumanTaskOrdinaryFallbackPlanV1,
  type HumanTaskOrdinaryFallbackRequestV1,
} from "@nautilo/lattice-bridge";
import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withCurrentHumanDeviceSigningAuthority,
} from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import { HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1 } from
  "@nautilo/lattice-crypto/wire";
import {
  createTask,
  createHumanApiTaskCreationProvenance,
  getPlaintextTaskCreationAdmission,
} from "@nautilo/runtime";
import type {
  TaskContentSummaryV1,
  TaskCreateResponse,
} from "@nautilo/types";
import { classifyProtectedTaskMetadataV1, reconstructProtectedTaskMetadataV1 } from "@nautilo/types";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { decodeCanonicalBase64url } from "../lib/canonical-base64url";
import { prepareProtectedTaskScope } from "./protected-task-scope-creation";
import {
  deterministicTaskId,
  parseRunAt,
  ProtectedTaskRouteError,
  resolveOwnedProtectedTaskAuthority,
  taskCreateInput,
  taskUpdatePatch,
  toolsFields,
  validateCreateShape,
  validateSchedule,
  type ProtectedTaskRouteAuthority,
} from "./task-protected-composition";
import { toTaskContentSummaryV1 } from "./tasks";

type Source = Task & Readonly<{ mutationVersion: string }>;
type ProductTransaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
type Prepared = TaskOrdinaryFallbackPreparedCreateRequestV1
  | TaskOrdinaryFallbackPreparedUpdateRequestV1;

export function importTaskOrdinaryFallbackSubmissionV1(input: Readonly<{
  authority: ProtectedTaskRouteAuthority;
  prepared: Prepared;
  operation: "create" | "update";
}>): Readonly<{
  wire: Uint8Array;
  contentBytes: Uint8Array;
  request: HumanTaskOrdinaryFallbackRequestV1;
  requestDigest: Uint8Array;
  content: DecodedTaskDefinitionContent;
}> {
  const wire = bytes(input.prepared.signedOrdinaryFallbackRequestBytesBase64url);
  const contentBytes = bytes(input.prepared.ordinaryPayloadBytesBase64url);
  try {
    const request = decodeHumanTaskOrdinaryFallbackRequestV1(wire);
    const requestDigest = digestHumanTaskOrdinaryFallbackRequestV1(wire);
    const content = decodeTaskDefinitionContent(contentBytes);
    const { prepared, authority, operation } = input;
    const expectedPurpose = operation === "create"
      ? "task.ordinary_fallback.create" : "task.ordinary_fallback.update";
    if (request.purpose !== expectedPurpose || request.operationId !== prepared.operationId
      || request.taskId !== prepared.taskId || request.subjectHumanId !== authority.subjectHumanId
      || request.committerDeviceId !== authority.deviceId
      || request.committerDeviceSigningKeyGeneration !== authority.deviceGeneration
      || !equal(requestDigest, bytes(prepared.authenticatedRequestDigestBase64url, 32))
      || !equal(request.taskDefinitionContentDigest, fingerprintHumanTaskOrdinaryFallbackContentV1(contentBytes))
      || !equal(request.operationalFieldsDigest, fingerprintTaskOperationalFieldsV1(operation, prepared.task))) {
      throw new TypeError("Task fallback was substituted");
    }
    return { wire, contentBytes, request, requestDigest, content };
  } catch (error) {
    wire.fill(0); contentBytes.fill(0);
    if (error instanceof ProtectedTaskRouteError) throw error;
    throw new ProtectedTaskRouteError(400, "task_fallback_invalid", "Task fallback request is invalid");
  }
}

export interface TaskOrdinaryFallbackPorts {
  planCreate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    request: TaskOrdinaryFallbackPlanCreateRequestV1;
  }>): Promise<TaskOrdinaryFallbackCreatePlanV1>;
  planUpdate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    request: TaskOrdinaryFallbackPlanUpdateRequestV1;
  }>): Promise<TaskOrdinaryFallbackUpdatePlanV1>;
  publishCreate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    prepared: TaskOrdinaryFallbackPreparedCreateRequestV1;
  }>): Promise<TaskCreateResponse>;
  publishUpdate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    prepared: TaskOrdinaryFallbackPreparedUpdateRequestV1;
  }>): Promise<TaskContentSummaryV1>;
}

function unavailable(): never {
  throw new ProtectedTaskRouteError(
    409, "task_ordinary_fallback_unavailable", "Task ordinary fallback is unavailable",
  );
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function bytes(value: string, length?: number): Uint8Array {
  const decoded = decodeCanonicalBase64url(value, length);
  if (decoded === null) {
    throw new ProtectedTaskRouteError(400, "task_fallback_invalid", "Task fallback bytes are invalid");
  }
  return decoded;
}

/** Fingerprint the complete server-read tuple, including PostgreSQL's exact CAS token.
 * JSONB children already have the database's canonical order; no client object is accepted. */
export function fingerprintTaskOrdinaryFallbackSourceV1(
  crypto: LatticeCrypto,
  source: Source | null,
  identity: Readonly<{ taskId: string; subjectHumanId: string; agentId: string }>,
): Uint8Array {
  const fields = source === null ? null : Object.entries(source)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => [key, value instanceof Uint8Array
      ? { bytea: Buffer.from(value).toString("base64url") } : value]);
  const encoded = new TextEncoder().encode(JSON.stringify([
    "nautilo/task/ordinary-fallback-source/v1", identity.taskId,
    identity.subjectHumanId, identity.agentId, fields,
  ]));
  try { return crypto.hash(encoded); }
  finally { encoded.fill(0); }
}

export function isTaskOrdinaryFallbackMutableV1(task: Task): boolean {
  if ((task.status !== "pending" && task.status !== "paused")
    || task.fireLockId !== null || task.parentTaskId !== null || task.depth !== 0
    || task.ownerId !== task.requestorId) return false;
  if (task.contentRepresentation === "ordinary") {
    return task.contentRevision === 0 && task.contentNamespaceId === null
      && task.cryptoObjectId === null && task.cryptoAccessRevision === 0
      && task.cryptoRequiredNamespaceFingerprint === null && task.cryptoMappingState === "unmapped";
  }
  return (task.contentRepresentation === "dual" || task.contentRepresentation === "protected")
    && task.contentRevision > 0 && task.contentNamespaceId !== null
    && task.cryptoObjectId !== null && task.cryptoRequiredNamespaceFingerprint?.length === 32
    && (task.cryptoMappingState === "verified" || task.cryptoMappingState === "stale");
}

function validateUpdate(source: Task, task: TaskOrdinaryFallbackPlanUpdateRequestV1["task"]): void {
  validateSchedule({
    scheduleKind: task.scheduleKind ?? source.scheduleKind,
    runAt: task.runAt === undefined ? source.runAt : parseRunAt(task.runAt),
    cron: task.cron ?? source.cron,
    timezone: task.timezone ?? source.timezone,
  });
  const selected = task.tools === undefined
    ? { toolsMode: source.toolsMode, toolsWhitelist: source.toolsWhitelist }
    : toolsFields(task.tools);
  const error = validateTaskModelSelectionForCreate({
    requestedModelId: task.requestedModelId === undefined ? source.requestedModelId : task.requestedModelId,
    profile: task.selectionProfile ?? source.selectionProfile,
    spec: task.selectionSpec === undefined ? source.selectionSpec : task.selectionSpec,
    toolsMode: "toolsMode" in selected ? selected.toolsMode : source.toolsMode,
    toolsWhitelist: "toolsWhitelist" in selected ? selected.toolsWhitelist : source.toolsWhitelist,
  });
  if (error !== null) throw new ProtectedTaskRouteError(422, "task_selection_invalid", error);
}

/** Separate signed Fallback publication; ordinary endpoints never enter this owner. */
export function createTaskOrdinaryFallbackPorts(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  owner: EncryptionDataOperationOwner;
  observer: { kick(): void };
  now?: () => number;
}>): TaskOrdinaryFallbackPorts {
  const now = input.now ?? Date.now;
  const currentPolicy = async (transaction: ProductTransaction, expected?: number) => {
    const policy = await acquireEncryptionConsumptionFence(transaction);
    if (!selectLiveEncryptionRepresentationPolicy(policy).allowOrdinaryFallback
      || (expected !== undefined && policy.revision !== expected)) unavailable();
    return policy.revision;
  };
  const sourceFor = async (database: DirectDatabase, authority: ProtectedTaskRouteAuthority, taskId: string) => {
    const source = await getTaskByIdWithMutationVersion(database, taskId);
    const resolved = source === undefined ? null : resolveOwnedProtectedTaskAuthority(authority, source);
    if (source === undefined || resolved === null || source.requestorId !== authority.userId) {
      throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
    }
    return { source, authority: resolved };
  };
  const signingRevision = async (authority: ProtectedTaskRouteAuthority) => {
    if (authority.admission === undefined || authority.admission.expiresAt <= now()) unavailable();
    const rows = await executeTypedCryptoQuery(input.restricted,
      cryptoTypedDb.select({ revision: humanCryptoDevices.revision })
        .from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, authority.deviceId),
          eq(humanCryptoDevices.deviceGeneration, authority.deviceGeneration),
          eq(humanCryptoDevices.humanId, authority.subjectHumanId),
          eq(humanCryptoDevices.userId, authority.userId),
          eq(humanCryptoDevices.state, "active"),
        )).limit(2));
    if (rows.length !== 1 || rows[0] === undefined) unavailable();
    // Restricted SQL transports PostgreSQL bigint counters as decimal text.
    const revision = Number(rows[0].revision);
    if (!Number.isSafeInteger(revision) || revision < 0) unavailable();
    return revision;
  };
  const withDevice = async <Value>(
    authority: ProtectedTaskRouteAuthority,
    hostAuthorizationRevision: number,
    use: (key: Uint8Array) => Promise<Value>,
  ): Promise<Value> => {
    if (authority.admission === undefined || authority.admission.expiresAt <= now()) unavailable();
    const result = await withCurrentHumanDeviceSigningAuthority(input.restricted, {
      subjectUserId: authority.userId,
      subjectHumanId: authority.subjectHumanId,
      humanActorId: authority.actorId,
      deviceId: authority.deviceId,
      deviceSigningKeyGeneration: authority.deviceGeneration,
      hostAuthorizationRevision,
    }, use);
    if (result === null) unavailable();
    return result;
  };

  const plan = async (
    authority: ProtectedTaskRouteAuthority,
    taskId: string | null,
    request: TaskOrdinaryFallbackPlanCreateRequestV1 | TaskOrdinaryFallbackPlanUpdateRequestV1,
  ) => input.owner.metadata(async () => {
    // Reject unavailable policy before touching Device authority or any Task body.
    const admittedPolicyRevision = await input.db.transaction(transaction => currentPolicy(transaction));
    const operation = taskId === null ? "create" : "update";
    const id = taskId ?? deterministicTaskId(authority, request.operationId);
    const revision = await signingRevision(authority);
    return withDevice(authority, revision, () => input.db.transaction(async transaction => {
      const policyRevision = await currentPolicy(transaction, admittedPolicyRevision);
      const current = taskId === null ? null : await sourceFor(transaction as unknown as DirectDatabase, authority, id);
      const effective = current?.authority ?? authority;
      if (current !== null) {
        if (!isTaskOrdinaryFallbackMutableV1(current.source)) unavailable();
        validateUpdate(current.source, request.task);
      } else {
        validateCreateShape(request.task);
        validateSchedule({ scheduleKind: request.task.scheduleKind ?? "now",
          runAt: parseRunAt(request.task.runAt), cron: request.task.cron,
          timezone: request.task.timezone ?? "UTC" });
      }
      const issuedAt = now();
      const fields: HumanTaskOrdinaryFallbackPlanV1 = {
        formatVersion: 1,
        purpose: operation === "create" ? "task.ordinary_fallback.create" : "task.ordinary_fallback.update",
        reason: "target_encryption_not_ready",
        operationId: request.operationId,
        taskId: id,
        sourceDigest: fingerprintTaskOrdinaryFallbackSourceV1(input.crypto, current?.source ?? null,
          { taskId: id, subjectHumanId: effective.subjectHumanId, agentId: effective.agentId }),
        operationalFieldsDigest: fingerprintTaskOperationalFieldsV1(operation, request.task),
        expectedContentRevision: current?.source.contentRevision ?? 0,
        expectedCryptoAccessRevision: current?.source.cryptoAccessRevision ?? 0,
        expectedUpdatedAt: current?.source.updatedAt.toISOString() ?? null,
        policyRevision,
        subjectHumanId: effective.subjectHumanId,
        committerDeviceId: effective.deviceId,
        committerDeviceSigningKeyGeneration: effective.deviceGeneration,
        hostAuthorizationRevision: revision,
        planIssuedAt: issuedAt,
        planDeadlineAt: issuedAt + HUMAN_TASK_PUBLICATION_REQUEST_MAX_TTL_MS_V1,
      };
      const { sourceDigest, operationalFieldsDigest, ...coordinates } = fields;
      return {
        ...coordinates,
        sourceDigestBase64url: Buffer.from(sourceDigest).toString("base64url"),
        operationalFieldsDigestBase64url: Buffer.from(operationalFieldsDigest).toString("base64url"),
        planDigestBase64url: Buffer.from(fingerprintHumanTaskOrdinaryFallbackPlanV1(fields)).toString("base64url"),
      };
    }));
  });

  const publish = async (
    authority: ProtectedTaskRouteAuthority,
    prepared: Prepared,
    operation: "create" | "update",
  ): Promise<Task> => input.owner.runMutation({ dual: async () => {
    const { wire, contentBytes, request, requestDigest, content } = importTaskOrdinaryFallbackSubmissionV1({
      authority, prepared, operation,
    });
    try {
      if (operation === "create" && (prepared.taskId !== deterministicTaskId(authority, prepared.operationId)
        || content.retainedHistoricalError !== null)) unavailable();
      return await withDevice(authority, request.hostAuthorizationRevision, key => input.db.transaction(async transaction => {
        await currentPolicy(transaction, request.policyRevision);
        const database = transaction as unknown as DirectDatabase;
        await lockProtectedTaskForegroundCreationIdentity(transaction, prepared.taskId);
        const source = await getTaskByIdWithMutationVersion(database, prepared.taskId);
        if (source !== undefined && (source.ownerId !== authority.userId
          || source.requestorId !== authority.userId)) unavailable();
        const exactReplay = source?.ordinaryFallbackOperationId === request.operationId
          && source.ordinaryFallbackRequestDigest !== null
          && equal(source.ordinaryFallbackRequestDigest, requestDigest);
        const assertCurrentDeadline = () => {
          if (authority.admission === undefined || authority.admission.expiresAt <= now()
            || !exactReplay && now() >= request.deadlineAt) unavailable();
        };
        try {
          verifyHumanTaskOrdinaryFallbackRequestV1(input.crypto, {
            requestBytes: wire, signingPublicKey: key, now: now(),
            ...(exactReplay ? { replayAdmission: createHumanTaskOrdinaryFallbackReplayAdmissionV1({
              operationId: request.operationId, taskId: request.taskId, requestDigest,
            }) } : {}),
          });
        } catch {
          throw new ProtectedTaskRouteError(409, "task_fallback_request_invalid", "Task fallback signature or deadline is invalid");
        }
        assertCurrentDeadline();
        if (exactReplay && source !== undefined) return source;
        if (source?.ordinaryFallbackOperationId === request.operationId) unavailable();
        const effective = source === undefined ? authority : resolveOwnedProtectedTaskAuthority(authority, source);
        if (effective === null || (operation === "create" ? source !== undefined : source === undefined)) unavailable();
        const expectedSource = fingerprintTaskOrdinaryFallbackSourceV1(input.crypto, source ?? null,
          { taskId: prepared.taskId, subjectHumanId: effective.subjectHumanId, agentId: effective.agentId });
        const planFields = fallbackPlanFields(request);
        if (!equal(expectedSource, request.sourceDigest)
          || !equal(fingerprintHumanTaskOrdinaryFallbackPlanV1(planFields), request.planDigest)
          || request.expectedContentRevision !== (source?.contentRevision ?? 0)
          || request.expectedCryptoAccessRevision !== (source?.cryptoAccessRevision ?? 0)
          || request.expectedUpdatedAt !== (source?.updatedAt.toISOString() ?? null)) unavailable();
        if (source !== undefined) {
          if (!isTaskOrdinaryFallbackMutableV1(source)) unavailable();
          validateUpdate(source, prepared.task);
          // A protected publication may have reserved n+1 before this fallback.
          // Never let its later recovery attach older ciphertext to the new sibling.
          const pending = await transaction.select({ taskId: taskDefinitionCryptoRevisions.taskId })
            .from(taskDefinitionCryptoRevisions).where(and(
              eq(taskDefinitionCryptoRevisions.taskId, source.id),
              eq(taskDefinitionCryptoRevisions.contentRevision, source.contentRevision + 1),
            )).limit(1).for("share");
          if (pending.length !== 0) unavailable();
        }
        const receipt = {
          ordinaryFallbackOperationId: request.operationId,
          ordinaryFallbackRequestDigest: requestDigest,
          ordinaryFallbackReason: request.reason,
          ordinaryFallbackPolicyRevision: request.policyRevision,
          ordinaryFallbackCompletedAt: new Date(now()),
        } as const;
        const classified = classifyProtectedTaskMetadataV1(source?.metadata ?? {});
        if (classified.status !== "supported") unavailable();
        const reconstructed = reconstructProtectedTaskMetadataV1(
          classified.operational, content.payload.protectedMetadata,
        );
        if (reconstructed.status !== "supported") unavailable();
        if (source === undefined) {
          const createRequest = prepared as TaskOrdinaryFallbackPreparedCreateRequestV1;
          const scopeId = createRequest.task.useScope === true
            ? await prepareProtectedTaskScope(transaction, { taskId: prepared.taskId,
                requesterUserId: authority.userId, agentId: authority.agentId,
                scopeId: createRequest.task.scopeId ?? null }) : createRequest.task.scopeId;
          await createTask({
            db: database, observer: { kick() {} },
            invocationAuthority: createAcceptedInvocationAuthority(authority.userId),
            provenance: createHumanApiTaskCreationProvenance({ ownerId: authority.userId, requestedParentTaskId: null }),
            admission: getPlaintextTaskCreationAdmission(),
          }, { ...taskCreateInput(authority, prepared.taskId, {
              ...createRequest.task, ...(scopeId == null ? {} : { scopeId }),
            }, content.payload), metadata: reconstructed.metadata });
          const [created] = await transaction.update(tasks).set(receipt)
            .where(and(eq(tasks.id, prepared.taskId), eq(tasks.ownerId, authority.userId))).returning();
          if (created === undefined) throw new Error("Task fallback creation disappeared");
          assertCurrentDeadline();
          return created;
        }
        const patch: Partial<NewTask> = {
          ...taskUpdatePatch(source, prepared.task, content.payload),
          metadata: reconstructed.metadata,
          lastError: content.retainedHistoricalError ?? source.lastError,
          ...receipt,
          ...(source.contentRepresentation === "ordinary" ? {} : {
            contentRepresentation: "dual", cryptoMappingState: "stale",
          }),
        };
        const updated = await updateTaskIfCurrent(database, {
          id: source.id, ownerId: authority.userId,
          expectedStatus: source.status as "pending" | "paused",
          expectedMutationVersion: source.mutationVersion,
          expectedContentRevision: source.contentRevision,
        }, patch);
        if (updated === undefined) unavailable();
        assertCurrentDeadline();
        return updated;
      }));
    } finally {
      wire.fill(0); contentBytes.fill(0); requestDigest.fill(0);
    }
  } });

  return {
    planCreate: async operation => await plan(operation.authority, null, operation.request) as TaskOrdinaryFallbackCreatePlanV1,
    planUpdate: async operation => await plan(operation.authority, operation.taskId, operation.request) as TaskOrdinaryFallbackUpdatePlanV1,
    publishCreate: async operation => {
      const task = await publish(operation.authority, operation.prepared, "create");
      if (task.status === "pending" && task.scheduleKind === "now") input.observer.kick();
      return { taskId: task.id, status: task.status, nextFireAt: task.nextFireAt?.toISOString() ?? null };
    },
    publishUpdate: async operation => {
      if (operation.taskId !== operation.prepared.taskId) unavailable();
      const task = await publish(operation.authority, operation.prepared, "update");
      return toTaskContentSummaryV1(task, {
        agentName: null, lastModelId: null, allowOrdinaryFallbackDefinition: true,
      });
    },
  };
}

function fallbackPlanFields(request: HumanTaskOrdinaryFallbackRequestV1): HumanTaskOrdinaryFallbackPlanV1 {
  const { planDigest: _plan, taskDefinitionContentDigest: _content,
    issuedAt: _issued, deadlineAt: _deadline, signature: _signature, ...fields } = request;
  return fields;
}
