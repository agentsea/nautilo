import { createHash } from "node:crypto";

import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  ProtectedTaskDefinitionReadReadyEnvelopeV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
  ProtectedTaskPublicationPlanRequestV1,
  ProtectedTaskPublicationPlanV1,
} from "@nautilo/api-client";
import {
  validateTaskModelSelectionForCreate,
} from "@nautilo/agent";
import {
  and,
  createPostgresJsBridgeConnection,
  encryptionTransitionPolicy,
  eq,
  getLatestRunModelByTask,
  getOwnerAgentDisplayNamesByAgentId,
  getTaskById,
  getTaskByIdWithMutationVersion,
  humanCryptoDevices,
  inArray,
  updateTaskIfCurrent,
  type DirectDatabase,
  type NewTask,
  type PostgresJsBridgeConnection,
  type Task,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
  type TaskContentAuthorityV1,
  type TaskContentPayloadV1,
} from "@nautilo/lattice-bridge";
import {
  createPostgresTaskContentRepositoryV1,
  destroyVerifiedStoredObjectAccessManifestChainV5,
  PostgresDomainKeyAuthorityRepository,
  PostgresHumanDeviceSignerHistory,
  PostgresLatticeStorage,
  PostgresNamespaceProductAuthority,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  verifyCryptoPostgresHandle,
  verifyStoredObjectAccessManifestChainV5,
  withCurrentHumanDeviceSigningAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  LatticeCrypto,
  type HumanTaskPublicationRequest,
} from "@nautilo/lattice-crypto";
import { decodeHumanTaskPublicationRequestV1 } from "@nautilo/lattice-crypto/wire";
import {
  computeNextFireAt,
  createHumanApiTaskCreationProvenance,
  createTask as runtimeCreateTask,
  getPlaintextTaskCreationAdmission,
  type TaskCreateInput,
} from "@nautilo/runtime";
import {
  classifyProtectedTaskMetadataV1,
  type ListTasksQuery,
  type TaskContentListV1,
  type TaskContentSummaryV1,
  type TaskCreateResponse,
} from "@nautilo/types";
import {
  AgentInvocationDeniedError,
  ServerProviderCredentialsDeniedError,
  createAcceptedInvocationAuthority,
  findAgentOwnerPrivateRoom,
} from "@nautilo/trust";

import { createHumanProductTransactionContext } from "./human-message-product-store";
import { importProtectedTaskPublicationV1 } from "./task-protected-publication";
import { listProtectedTaskContentV1, toTaskContentSummaryV1 } from "./tasks";

export type ProtectedTaskRouteAuthority = Readonly<{
  userId: string;
  subjectHumanId: string;
  actorId: string;
  agentId: string;
  deviceId: string;
  deviceGeneration: number;
}>;

export interface ProtectedTaskRoutePorts {
  list(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    query: ListTasksQuery;
  }>): Promise<TaskContentListV1>;
  readDefinition(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    objectId: string;
    contentRevision: number;
    cryptoAccessRevision: 0;
  }>): Promise<ProtectedTaskDefinitionReadReadyEnvelopeV1>;
  plan(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string | null;
    request: ProtectedTaskPublicationPlanRequestV1;
  }>): Promise<ProtectedTaskPublicationPlanV1>;
  publishCreate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    prepared: ProtectedTaskPreparedCreateRequestV1 | DualTaskPreparedCreateRequestV1;
  }>): Promise<TaskCreateResponse>;
  publishUpdate(input: Readonly<{
    authority: ProtectedTaskRouteAuthority;
    taskId: string;
    prepared: ProtectedTaskPreparedUpdateRequestV1 | DualTaskPreparedUpdateRequestV1;
  }>): Promise<TaskContentSummaryV1>;
}

export class ProtectedTaskRouteError extends Error {
  constructor(
    readonly statusCode: 400 | 403 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtectedTaskRouteError";
  }
}

declare const PROTECTED_TASK_TEST_AUTHORITY: unique symbol;
export type ProtectedTaskTestAuthority = Readonly<{
  [PROTECTED_TASK_TEST_AUTHORITY]: true;
}>;

type ProtectedTaskTestComposition = Readonly<{
  mode: "protected_task_test_shadow";
  target: ProtectedTaskRouteAuthority;
  ports: ProtectedTaskRoutePorts;
}>;

type ProtectedTaskProductionComposition = Readonly<{
  mode: "protected_task_production";
  ports: ProtectedTaskRoutePorts;
}>;

export type ProtectedTaskComposition =
  | ProtectedTaskTestComposition
  | ProtectedTaskProductionComposition;

const testAuthorities = new WeakSet<object>();
const testCompositions = new WeakSet<object>();
const productionCompositions = new WeakSet<object>();

export function createProtectedTaskTestAuthority(): ProtectedTaskTestAuthority {
  const authority = Object.freeze({}) as ProtectedTaskTestAuthority;
  testAuthorities.add(authority);
  return authority;
}

export function createProtectedTaskTestComposition(input: Readonly<{
  authority: ProtectedTaskTestAuthority;
  target: ProtectedTaskRouteAuthority;
  ports: ProtectedTaskRoutePorts;
}>): ProtectedTaskComposition {
  if (!testAuthorities.has(input.authority as object)) {
    throw new TypeError("Protected Task test authority is not recognized");
  }
  const composition = Object.freeze({
    mode: "protected_task_test_shadow" as const,
    target: Object.freeze({ ...input.target }),
    ports: input.ports,
  });
  testCompositions.add(composition);
  return composition;
}

function sameAuthority(
  left: ProtectedTaskRouteAuthority,
  right: ProtectedTaskRouteAuthority,
): boolean {
  return left.userId === right.userId
    && left.subjectHumanId === right.subjectHumanId
    && left.actorId === right.actorId
    && left.agentId === right.agentId
    && left.deviceId === right.deviceId
    && left.deviceGeneration === right.deviceGeneration;
}

/** Resolve an owner-visible Task through its durable agent binding. */
export function resolveOwnedProtectedTaskAuthority(
  authority: ProtectedTaskRouteAuthority,
  task: Pick<Task, "ownerId" | "agentId">,
): ProtectedTaskRouteAuthority | null {
  if (task.ownerId !== authority.userId) return null;
  return task.agentId === authority.agentId
    ? authority
    : Object.freeze({ ...authority, agentId: task.agentId });
}

export function resolveProtectedTaskComposition(input: Readonly<{
  composition: ProtectedTaskComposition;
  authority: ProtectedTaskRouteAuthority;
}>): ProtectedTaskRoutePorts | null {
  if (productionCompositions.has(input.composition as object)
    && input.composition.mode === "protected_task_production") {
    return input.composition.ports;
  }
  return testCompositions.has(input.composition as object)
      && input.composition.mode === "protected_task_test_shadow"
      && sameAuthority(input.composition.target, input.authority)
    ? input.composition.ports
    : null;
}

type OperationalCreate = Extract<
  ProtectedTaskPublicationPlanRequestV1,
  { operation: "create" }
>["task"];
type OperationalUpdate = Extract<
  ProtectedTaskPublicationPlanRequestV1,
  { operation: "update" }
>["task"];
type TaskDefinitionPayload = Extract<
  TaskContentPayloadV1,
  { coordinate: { kind: "definition" } }
>["payload"];

type ProductionDependencies = Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  owner: EncryptionDataOperationOwner;
  observer: { kick(): void };
  now?: () => number;
}>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Protected Task plan is not canonical");
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function digestJson(crypto: LatticeCrypto, value: unknown): string {
  const bytes = new TextEncoder().encode(
    `nautilo/protected-task-publication-plan/v1\n${canonicalJson(value)}`,
  );
  try { return Buffer.from(crypto.hash(bytes)).toString("base64url"); }
  finally { bytes.fill(0); }
}

function deterministicTaskId(
  authority: ProtectedTaskRouteAuthority,
  operationId: string,
): string {
  const digest = createHash("sha256").update([
    "nautilo/protected-task-id/v1",
    authority.subjectHumanId,
    authority.agentId,
    operationId,
  ].join("\n")).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  digest.fill(0);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseRunAt(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ProtectedTaskRouteError(400, "invalid_schedule", "Task runAt is invalid");
  }
  return date;
}

function validateSchedule(input: Readonly<{
  scheduleKind: Task["scheduleKind"];
  runAt: Date | null | undefined;
  cron: string | null | undefined;
  timezone: string;
}>): void {
  try {
    computeNextFireAt(
      input.scheduleKind,
      input.runAt,
      input.cron,
      input.timezone,
    );
  } catch (error) {
    throw new ProtectedTaskRouteError(
      400,
      "invalid_schedule",
      error instanceof Error ? error.message : "Task schedule is invalid",
    );
  }
}

function toolsFields(
  tools: readonly string[] | undefined,
): Pick<NewTask, "toolsMode" | "toolsWhitelist"> | Record<string, never> {
  if (tools === undefined) return {};
  return tools.length === 0
    ? { toolsMode: "none", toolsWhitelist: [] }
    : { toolsMode: "whitelist", toolsWhitelist: [...tools] };
}

function metadataFor(task: Pick<Task, "metadata">) {
  const classified = classifyProtectedTaskMetadataV1(task.metadata ?? {});
  if (classified.status !== "supported") {
    throw new ProtectedTaskRouteError(
      409,
      "task_metadata_unsupported",
      "Task metadata cannot be protected",
    );
  }
  return classified.operational;
}

function emptyMetadata() {
  return metadataFor({ metadata: {} });
}

function validateCreateShape(task: OperationalCreate): void {
  if (task.parentTaskId != null) {
    throw new ProtectedTaskRouteError(
      422,
      "nested_task_unsupported",
      "Protected nested Tasks are not supported",
    );
  }
  if (task.useScope === true && task.scopeId == null) {
    throw new ProtectedTaskRouteError(
      422,
      "protected_scope_requires_existing_scope",
      "Protected scope Tasks require an existing scope",
    );
  }
  validateSelection(task);
}

function validateSelection(
  task: Pick<OperationalCreate, "requestedModelId" | "selectionProfile"
    | "selectionSpec" | "tools">,
): void {
  const selectedTools = toolsFields(task.tools);
  const error = validateTaskModelSelectionForCreate({
    requestedModelId: task.requestedModelId,
    profile: task.selectionProfile,
    spec: task.selectionSpec,
    toolsMode: "toolsMode" in selectedTools ? selectedTools.toolsMode : "auto",
    toolsWhitelist: "toolsWhitelist" in selectedTools
      ? selectedTools.toolsWhitelist : undefined,
  });
  if (error !== null) {
    throw new ProtectedTaskRouteError(422, "task_selection_invalid", error);
  }
}

function taskCreateInput(
  authority: ProtectedTaskRouteAuthority,
  taskId: string,
  task: OperationalCreate,
  payload: TaskDefinitionPayload | null,
): TaskCreateInput {
  validateCreateShape(task);
  return {
    id: taskId,
    ownerId: authority.userId,
    requestorId: authority.userId,
    agentId: authority.agentId,
    prompt: payload?.prompt ?? "",
    expectedOutput: payload?.expectedOutput ?? null,
    metadata: emptyMetadata(),
    scheduleKind: task.scheduleKind ?? "now",
    runAt: parseRunAt(task.runAt) ?? null,
    cron: task.cron ?? null,
    timezone: task.timezone ?? "UTC",
    targetChat: task.targetChat ?? "orphan",
    resultDelivery: task.resultDelivery ?? "wake",
    useScope: task.useScope ?? false,
    ...(task.scopeId == null ? {} : { scopeId: task.scopeId }),
    ...(task.timeLimitSeconds === undefined
      ? {} : { timeLimitSeconds: task.timeLimitSeconds }),
    ...(task.selectionProfile === undefined
      ? {} : { selectionProfile: task.selectionProfile }),
    ...(task.selectionSpec === undefined
      ? {} : { selectionSpec: task.selectionSpec }),
    ...(task.requestedModelId === undefined
      ? {} : { requestedModelId: task.requestedModelId }),
    preset: "task",
    depth: 0,
    ...toolsFields(task.tools),
  };
}

async function readCreatedTask(
  db: DirectDatabase,
  authority: ProtectedTaskRouteAuthority,
  taskId: string,
): Promise<Task> {
  const current = await getTaskById(db, taskId);
  if (current === undefined || current.ownerId !== authority.userId
    || current.agentId !== authority.agentId) {
    throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
  }
  // The requested schedule was stored with the paused placeholder and its
  // mapping atomically made the task pending. A replay must only observe the
  // current task; recomputing the schedule could resurrect a completed run.
  return current;
}

function taskUpdatePatch(
  current: Task,
  task: OperationalUpdate,
  payload: TaskDefinitionPayload | null,
): Partial<NewTask> {
  const patch: Partial<NewTask> = {
    metadata: metadataFor(current),
    ...(payload === null ? {} : {
      prompt: payload.prompt,
      expectedOutput: payload.expectedOutput,
    }),
  };
  if (task.scheduleKind !== undefined) patch.scheduleKind = task.scheduleKind;
  const runAt = parseRunAt(task.runAt);
  if (runAt !== undefined) patch.runAt = runAt;
  if (task.cron !== undefined) patch.cron = task.cron;
  if (task.timezone !== undefined) patch.timezone = task.timezone;
  if (task.targetChat !== undefined) patch.targetChat = task.targetChat;
  if (task.resultDelivery !== undefined) patch.resultDelivery = task.resultDelivery;
  if (task.tools !== undefined) Object.assign(patch, toolsFields(task.tools));
  if (task.timeLimitSeconds !== undefined) patch.timeLimitSeconds = task.timeLimitSeconds;
  if (task.selectionProfile !== undefined) patch.selectionProfile = task.selectionProfile;
  if (task.selectionSpec !== undefined) patch.selectionSpec = task.selectionSpec;
  if (task.requestedModelId !== undefined) patch.requestedModelId = task.requestedModelId;
  if (task.scheduleKind !== undefined || task.runAt !== undefined
    || task.cron !== undefined || task.timezone !== undefined) {
    patch.nextFireAt = computeNextFireAt(
      task.scheduleKind ?? current.scheduleKind,
      runAt ?? current.runAt,
      task.cron ?? current.cron,
      task.timezone ?? current.timezone,
    );
  }
  return patch;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** @internal Exact device/custody lock held through the product mapping commit. */
export async function withCurrentProtectedTaskPublicationDeviceAuthority<Value>(
  restricted: PostgresJsBridgeConnection,
  authority: ProtectedTaskRouteAuthority,
  request: HumanTaskPublicationRequest,
  publish: () => Promise<Value>,
): Promise<Value> {
  if (request.subjectHumanId !== authority.subjectHumanId
    || request.committerDeviceId !== authority.deviceId) {
    throw new ProtectedTaskRouteError(
      403,
      "task_authority_unavailable",
      "Task authority is unavailable",
    );
  }
  const result = await withCurrentHumanDeviceSigningAuthority(restricted, {
    subjectUserId: authority.userId,
    subjectHumanId: authority.subjectHumanId,
    humanActorId: authority.actorId,
    deviceId: request.committerDeviceId,
    deviceSigningKeyGeneration: authority.deviceGeneration,
    hostAuthorizationRevision: request.hostAuthorizationRevision,
  }, publish);
  if (result === null) {
    throw new ProtectedTaskRouteError(
      403,
      "task_authority_unavailable",
      "Task authority is unavailable",
    );
  }
  return result;
}

function decodePreparedTaskPublicationRequest(
  prepared: ProtectedTaskPreparedCreateRequestV1
    | DualTaskPreparedCreateRequestV1
    | ProtectedTaskPreparedUpdateRequestV1
    | DualTaskPreparedUpdateRequestV1,
): HumanTaskPublicationRequest {
  const bytes = Uint8Array.from(Buffer.from(
    prepared.signedPublicationRequestBytesBase64url,
    "base64url",
  ));
  try {
    return decodeHumanTaskPublicationRequestV1(bytes);
  } finally {
    bytes.fill(0);
  }
}

function destroyTaskPublicationRequest(request: HumanTaskPublicationRequest): void {
  request.planDigest.fill(0);
  request.operationalFieldsDigest.fill(0);
  request.bindingHash.fill(0);
  request.payloadHash.fill(0);
  request.manifestHash.fill(0);
  request.envelopeHash.fill(0);
  request.signature.fill(0);
}

/** Production Task definition transport backed by current product and crypto authority. */
export function createProductionProtectedTaskComposition(
  dependencies: ProductionDependencies,
): ProtectedTaskComposition {
  const now = dependencies.now ?? Date.now;
  let cryptoHandlePromise: ReturnType<typeof verifyCryptoPostgresHandle> | null = null;
  const cryptoHandle = () =>
    cryptoHandlePromise ??= verifyCryptoPostgresHandle(dependencies.restricted);
  const productConnection = createPostgresJsBridgeConnection(dependencies.db);

  const readPolicyRevision = async (): Promise<number> => {
    const rows = await dependencies.db.select({
      revision: encryptionTransitionPolicy.revision,
      mode: encryptionTransitionPolicy.mode,
    }).from(encryptionTransitionPolicy)
      .where(eq(encryptionTransitionPolicy.id, "server"));
    const policy = rows[0];
    if (rows.length !== 1 || policy === undefined
      || policy.mode === "plaintext_only" || policy.revision < 1) {
      throw new ProtectedTaskRouteError(
        409,
        "protected_task_policy_unavailable",
        "Protected Task policy is unavailable",
      );
    }
    return policy.revision;
  };

  const currentPrivateAuthority = async (
    authority: ProtectedTaskRouteAuthority,
    expectedNamespaceId?: string,
  ): Promise<Readonly<{
    sourceRoomId: string;
    content: TaskContentAuthorityV1;
    bindingHash: Uint8Array;
    keyGeneration: number;
  }> | null> => {
    const privateRoom = await findAgentOwnerPrivateRoom(
      authority.userId,
      authority.agentId,
    );
    if (privateRoom === null || (expectedNamespaceId !== undefined
      && privateRoom.namespaceId !== expectedNamespaceId)) return null;
    return new PostgresNamespaceProductAuthority(productConnection)
      .withCurrentPrivateRoom({
        subjectUserId: authority.userId,
        subjectHumanId: authority.subjectHumanId,
        roomId: privateRoom.roomId,
        namespaceId: privateRoom.namespaceId,
        use: async () => {
          const domain = await new PostgresDomainKeyAuthorityRepository(
            dependencies.restricted,
            dependencies.crypto,
            dependencies.serverScope,
          ).inspectForegroundNamespaceAuthority({
            namespaceId: privateRoom.namespaceId,
            keyClass: "ai",
          });
          if (domain.status !== "ready") return null;
          return Object.freeze({
            sourceRoomId: privateRoom.roomId,
            content: Object.freeze({
              authorityVersion: 1 as const,
              kind: "requester_private_namespace" as const,
              keyClass: "ai" as const,
              requesterHumanId: authority.subjectHumanId,
              namespaceId: privateRoom.namespaceId,
              domainId: domain.domainId,
              expectedAccessRevision: domain.namespaceAccessRevision,
              expectedPolicyRevision: await readPolicyRevision(),
            }),
            bindingHash: domain.bundleDigest.slice(),
            keyGeneration: domain.namespaceKeyGeneration,
          });
        },
      });
  };

  const buildPlan = async (
    authority: ProtectedTaskRouteAuthority,
    taskId: string | null,
    request: ProtectedTaskPublicationPlanRequestV1,
  ): Promise<ProtectedTaskPublicationPlanV1> => {
    if (request.operation === "create") {
      validateCreateShape(request.task);
      validateSchedule({
        scheduleKind: request.task.scheduleKind ?? "now",
        runAt: parseRunAt(request.task.runAt),
        cron: request.task.cron ?? null,
        timezone: request.task.timezone ?? "UTC",
      });
    }
    const id = request.operation === "create"
      ? deterministicTaskId(authority, request.operationId)
      : taskId!;
    let expectedContentRevision = 0;
    let expectedCryptoAccessRevision = 0;
    let expectedNamespaceId: string | undefined;
    let taskAuthority = authority;
    if (request.operation === "update") {
      const task = await getTaskById(dependencies.db, id);
      if (task === undefined) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const resolved = resolveOwnedProtectedTaskAuthority(authority, task);
      if (resolved === null) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      taskAuthority = resolved;
      if ((task.status !== "pending" && task.status !== "paused")
        || task.fireLockId !== null
        || (task.contentRepresentation !== "protected"
          && task.contentRepresentation !== "dual")
        || task.contentNamespaceId === null
        || task.cryptoMappingState !== "verified") {
        throw new ProtectedTaskRouteError(409, "task_not_mutable", "Task cannot be updated");
      }
      expectedContentRevision = task.contentRevision;
      expectedCryptoAccessRevision = task.cryptoAccessRevision;
      expectedNamespaceId = task.contentNamespaceId;
      validateSchedule({
        scheduleKind: request.task.scheduleKind ?? task.scheduleKind,
        runAt: request.task.runAt === undefined
          ? task.runAt : parseRunAt(request.task.runAt),
        cron: request.task.cron ?? task.cron,
        timezone: request.task.timezone ?? task.timezone,
      });
      if (request.task.tools !== undefined
        || request.task.requestedModelId !== undefined
        || request.task.selectionProfile !== undefined
        || request.task.selectionSpec !== undefined) {
        const selectedTools = request.task.tools === undefined
          ? { toolsMode: task.toolsMode, toolsWhitelist: task.toolsWhitelist }
          : toolsFields(request.task.tools);
        const error = validateTaskModelSelectionForCreate({
          requestedModelId: request.task.requestedModelId !== undefined
            ? request.task.requestedModelId : task.requestedModelId,
          profile: request.task.selectionProfile !== undefined
            ? request.task.selectionProfile : task.selectionProfile,
          spec: request.task.selectionSpec !== undefined
            ? request.task.selectionSpec : task.selectionSpec,
          toolsMode: selectedTools.toolsMode,
          toolsWhitelist: selectedTools.toolsWhitelist,
        });
        if (error !== null) {
          throw new ProtectedTaskRouteError(422, "task_selection_invalid", error);
        }
      }
    }
    const current = await currentPrivateAuthority(taskAuthority, expectedNamespaceId);
    if (current === null) {
      throw new ProtectedTaskRouteError(
        403,
        "task_authority_unavailable",
        "Task authority is unavailable",
      );
    }
    try {
      const plan = {
        planVersion: 1 as const,
        operation: request.operation,
        operationId: request.operationId,
        taskId: id,
        expectedContentRevision,
        nextContentRevision: expectedContentRevision + 1,
        expectedCryptoAccessRevision,
        authority: {
          requesterHumanId: current.content.requesterHumanId,
          sourceRoomId: current.sourceRoomId,
          namespaceId: current.content.namespaceId,
          domainId: current.content.domainId,
          expectedAccessRevision: current.content.expectedAccessRevision,
          expectedPolicyRevision: current.content.expectedPolicyRevision,
          bindingHashBase64url: Buffer.from(current.bindingHash).toString("base64url"),
          keyGeneration: current.keyGeneration,
        },
      };
      return Object.freeze({
        ...plan,
        planDigestBase64url: digestJson(dependencies.crypto, {
          ...plan,
          task: request.task,
        }),
      });
    } finally {
      current.bindingHash.fill(0);
    }
  };

  const currentContentAuthority = async (
    authority: ProtectedTaskRouteAuthority,
    expected: Readonly<{ requesterHumanId: string; namespaceId: string }>,
  ): Promise<TaskContentAuthorityV1 | null> => {
    if (expected.requesterHumanId !== authority.subjectHumanId) return null;
    return (await currentPrivateAuthority(authority, expected.namespaceId))
      ?.content ?? null;
  };

  const repository = async (authority: ProtectedTaskRouteAuthority) => {
    const product = await createHumanProductTransactionContext(
      authority.userId,
      dependencies.db,
    );
    const verifiedCryptoHandle = await cryptoHandle();
    const signerHistory = new PostgresHumanDeviceSignerHistory({
      handle: verifiedCryptoHandle,
      crypto: dependencies.crypto,
    });
    const resolveHistoricalHumanDeviceSigningPublicKey = async (context: Readonly<{
      subjectHumanId: string;
      committerDeviceId: string;
      hostAuthorizationRevision: number;
    }>): Promise<Uint8Array | null> => {
      const rows = await executeTypedCryptoQuery(
        verifiedCryptoHandle,
        cryptoTypedDb.select({
          human_id: humanCryptoDevices.humanId,
          signing_public_key: humanCryptoDevices.signingPublicKey,
          revision: humanCryptoDevices.revision,
        }).from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, context.committerDeviceId),
          eq(humanCryptoDevices.humanId, context.subjectHumanId),
          inArray(humanCryptoDevices.state, ["active", "revoked"]),
        )),
      );
      const row = rows[0];
      return rows.length === 1 && row !== undefined
          && row.revision >= context.hostAuthorizationRevision
          && row.signing_public_key instanceof Uint8Array
        ? row.signing_public_key.slice() : null;
    };
    return createPostgresTaskContentRepositoryV1<Task>({
      product: {
        handle: product.handle,
        resolveCurrentAuthority: (expected) =>
          currentContentAuthority(authority, expected),
      },
      crypto: {
        handle: verifiedCryptoHandle,
        crypto: dependencies.crypto,
        resolveCurrentAuthority: async (coordinate) => {
          const task = await getTaskById(dependencies.db, coordinate.taskId);
          if (task === undefined || task.contentNamespaceId === null) return null;
          const taskAuthority = resolveOwnedProtectedTaskAuthority(authority, task);
          if (taskAuthority === null) return null;
          return currentContentAuthority(taskAuthority, {
            requesterHumanId: taskAuthority.subjectHumanId,
            namespaceId: task.contentNamespaceId,
          });
        },
        resolveHistoricalAgentSignerAuthority:
          signerHistory.resolveAgentRuntimeSignerManager,
        resolveHistoricalHumanDeviceSigningPublicKey:
          resolveHistoricalHumanDeviceSigningPublicKey,
      },
      content: {
        prepareProtected: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Server Task preparation is unsupported",
        )),
        publishProduct: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Unprepared Task publication is unsupported",
        )),
        readOrdinary: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Ordinary Task reads are outside protected transport",
        )),
        readProtected: () => Promise.reject(new ClassifiedDataOperationError(
          "unsupported",
          "Protected Task plaintext remains in client custody",
        )),
      },
    });
  };

  const resolveSignedAuthority = async (
    authority: ProtectedTaskRouteAuthority,
    request: HumanTaskPublicationRequest,
  ): Promise<Uint8Array | null> => {
    if (request.subjectHumanId !== authority.subjectHumanId
      || request.committerDeviceId !== authority.deviceId) return null;
    const current = await currentPrivateAuthority(authority, request.namespaceId);
    if (current === null) return null;
    try {
      if (request.domainId !== current.content.domainId
        || request.expectedNamespaceAccessRevision
          !== current.content.expectedAccessRevision
        || request.expectedPolicyRevision
          !== current.content.expectedPolicyRevision
        || request.keyGeneration !== current.keyGeneration
        || !sameBytes(request.bindingHash, current.bindingHash)) return null;
      return withCurrentHumanDeviceSigningAuthority(dependencies.restricted, {
        subjectUserId: authority.userId,
        subjectHumanId: authority.subjectHumanId,
        humanActorId: authority.actorId,
        deviceId: request.committerDeviceId,
        deviceSigningKeyGeneration: authority.deviceGeneration,
        hostAuthorizationRevision: request.hostAuthorizationRevision,
      }, (key) => Promise.resolve(key.slice()));
    } finally {
      current.bindingHash.fill(0);
    }
  };

  const createProduct = async (
    authority: ProtectedTaskRouteAuthority,
    taskId: string,
    task: OperationalCreate,
    payload: TaskDefinitionPayload | null,
  ): Promise<Task> => {
    const existing = await getTaskById(dependencies.db, taskId);
    if (existing !== undefined) {
      if (existing.ownerId !== authority.userId || existing.agentId !== authority.agentId) {
        throw new ProtectedTaskRouteError(409, "task_identity_conflict", "Task identity conflicts");
      }
      return existing;
    }
    try {
      return await dependencies.db.transaction(async (transaction) => {
        const transactionDb = transaction as unknown as DirectDatabase;
        await runtimeCreateTask({
          db: transactionDb,
          observer: { kick() {} },
          invocationAuthority: createAcceptedInvocationAuthority(authority.userId),
          provenance: createHumanApiTaskCreationProvenance({
            ownerId: authority.userId,
            requestedParentTaskId: null,
          }),
          admission: getPlaintextTaskCreationAdmission(),
        }, taskCreateInput(authority, taskId, task, payload));
        const created = await getTaskByIdWithMutationVersion(transactionDb, taskId);
        if (created === undefined) {
          throw new Error("Protected Task product disappeared");
        }
        // The ordinary observer cannot claim a paused revision-zero placeholder.
        // Definition mapping changes it to pending in the same transaction that
        // makes the protected representation dispatchable.
        const parked = await updateTaskIfCurrent(transactionDb, {
          id: created.id,
          ownerId: authority.userId,
          expectedStatus: "pending",
          expectedMutationVersion: created.mutationVersion,
          expectedContentRevision: 0,
        }, { status: "paused" });
        if (parked === undefined) {
          throw new Error("Protected Task placeholder changed during creation");
        }
        return parked;
      });
    } catch (error) {
      if (error instanceof AgentInvocationDeniedError
        || error instanceof ServerProviderCredentialsDeniedError) {
        throw new ProtectedTaskRouteError(
          403,
          "task_creation_forbidden",
          error.message,
        );
      }
      throw error;
    }
  };

  const updateProduct = async (
    authority: ProtectedTaskRouteAuthority,
    taskId: string,
    expectedContentRevision: number,
    task: OperationalUpdate,
    payload: TaskDefinitionPayload | null,
  ): Promise<Task> => {
    const current = await getTaskByIdWithMutationVersion(dependencies.db, taskId);
    if (current === undefined || current.ownerId !== authority.userId
      || current.agentId !== authority.agentId) {
      throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
    }
    if (current.contentRevision === expectedContentRevision + 1
      && current.cryptoMappingState === "verified") return current;
    if (current.status !== "pending" && current.status !== "paused") {
      throw new ProtectedTaskRouteError(409, "task_not_mutable", "Task cannot be updated");
    }
    const updated = await updateTaskIfCurrent(dependencies.db, {
      id: current.id,
      ownerId: authority.userId,
      expectedStatus: current.status,
      expectedMutationVersion: current.mutationVersion,
      expectedContentRevision,
    }, taskUpdatePatch(current, task, payload));
    if (updated === undefined) {
      throw new ProtectedTaskRouteError(
        409,
        "task_changed",
        "Task changed while the update was prepared",
      );
    }
    return updated;
  };

  const ports: ProtectedTaskRoutePorts = {
    list: (input) =>
      listProtectedTaskContentV1(input.authority.userId, input.query),

    async readDefinition(input) {
      const task = await getTaskById(dependencies.db, input.taskId);
      if (task === undefined) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const taskAuthority = resolveOwnedProtectedTaskAuthority(
        input.authority,
        task,
      );
      if (taskAuthority === null) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      if ((task.contentRepresentation !== "protected"
        && task.contentRepresentation !== "dual")
        || task.cryptoMappingState !== "verified"
        || task.cryptoObjectId !== input.objectId
        || task.contentRevision !== input.contentRevision
        || task.cryptoAccessRevision !== input.cryptoAccessRevision
        || task.contentNamespaceId === null) {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_changed",
          "Task content reference changed",
        );
      }
      const current = await currentPrivateAuthority(
        taskAuthority,
        task.contentNamespaceId,
      );
      if (current === null) {
        throw new ProtectedTaskRouteError(
          403,
          "task_authority_unavailable",
          "Task authority is unavailable",
        );
      }
      current.bindingHash.fill(0);
      const verifiedCryptoHandle = await cryptoHandle();
      const storage = new PostgresLatticeStorage(verifiedCryptoHandle);
      const [object, access] = await Promise.all([
        storage.getObject(input.objectId),
        storage.getObjectAccessState(input.objectId),
      ]);
      if (object === null || access === null
        || access.head.accessRevision !== 0
        || access.namespaceEnvelopes.length !== 1
        || access.namespaceEnvelopes[0]?.namespaceId
          !== task.contentNamespaceId) {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_integrity_failure",
          "Task ciphertext is incomplete",
        );
      }
      const history = new PostgresHumanDeviceSignerHistory({
        handle: verifiedCryptoHandle,
        crypto: dependencies.crypto,
      });
      const payloadHash = dependencies.crypto.hash(object.payloadBytes);
      let verified;
      try {
        verified = await verifyStoredObjectAccessManifestChainV5({
          executor: verifiedCryptoHandle,
          crypto: dependencies.crypto,
          objectId: input.objectId,
          headAccessRevision: 0,
          expectedPayloadHash: payloadHash,
          expectedHeadManifestHash: access.head.manifestHash,
          resolveHistoricalAgentManagerAuthority:
            history.resolveAgentRuntimeSignerManager,
        });
      } finally {
        payloadHash.fill(0);
      }
      try {
        if (verified.headManifest.signer.kind !== "human_device"
          || verified.genesisHumanId !== input.authority.subjectHumanId) {
          throw new ProtectedTaskRouteError(
            409,
            "task_content_integrity_failure",
            "Task signer is invalid",
          );
        }
        const signer = verified.headManifest.signer;
        return Object.freeze({
          readVersion: 1 as const,
          status: "ready" as const,
          taskId: input.taskId,
          objectId: input.objectId,
          contentRevision: input.contentRevision,
          cryptoAccessRevision: 0 as const,
          namespaceId: task.contentNamespaceId,
          encryptedPayloadBytesBase64url:
            Buffer.from(object.payloadBytes).toString("base64url"),
          accessManifestBytesBase64url:
            Buffer.from(access.head.manifestBytes).toString("base64url"),
          accessManifestProofBytesBase64url: [] as [],
          namespaceEnvelopeBytesBase64url: Buffer.from(
            access.namespaceEnvelopes[0].envelopeBytes,
          ).toString("base64url"),
          signerEvidence: [Object.freeze({
            kind: "human_device" as const,
            subjectHumanId: signer.subjectHumanId,
            committerDeviceId: signer.committerDeviceId,
            hostAuthorizationRevision:
              verified.headManifest.hostAuthorizationRevision,
            signingPublicKeyBase64url: Buffer.from(
              verified.headSignerPublicKey,
            ).toString("base64url"),
          })],
        });
      } finally {
        object.payloadBytes.fill(0);
        access.head.manifestBytes.fill(0);
        access.head.manifestHash.fill(0);
        for (const envelope of access.namespaceEnvelopes) {
          envelope.envelopeBytes.fill(0);
          envelope.envelopeHash.fill(0);
        }
        destroyVerifiedStoredObjectAccessManifestChainV5(verified);
      }
    },

    plan: (input) =>
      buildPlan(input.authority, input.taskId, input.request),

    async publishCreate({ authority, prepared }) {
      const durable = await repository(authority);
      const freshPlan = await buildPlan(authority, null, {
        requestVersion: 1,
        operation: "create",
        operationId: prepared.operationId,
        task: prepared.task,
      });
      const imported = await importProtectedTaskPublicationV1({
        crypto: dependencies.crypto,
        now: now(),
        plan: freshPlan.planDigestBase64url === prepared.planDigestBase64url
          ? freshPlan : null,
        prepared,
        resolveCurrentAuthority: (request) =>
          resolveSignedAuthority(authority, request),
        lookupPreparedReplay: (request) => durable.lookupPreparedReplay(request),
      });
      const common = {
        owner: dependencies.owner,
        operationId: prepared.operationId,
        requestDigest: imported.requestDigest,
        authority: imported.authority,
        operationalMetadata: emptyMetadata(),
        prepared: imported.prepared,
      } as const;
      const publicationRequest = decodePreparedTaskPublicationRequest(prepared);
      let publication;
      try {
        publication = await withCurrentProtectedTaskPublicationDeviceAuthority(
          dependencies.restricted,
          authority,
          publicationRequest,
          () => imported.representation === "dual"
            ? durable.publishPrepared({
              ...common,
              representation: "dual",
              ordinaryContent: imported.ordinaryContent,
              publishProduct: (content: TaskContentPayloadV1) =>
                createProduct(
                  authority,
                  prepared.taskId,
                  prepared.task,
                  (content as Extract<TaskContentPayloadV1, {
                    coordinate: { kind: "definition" };
                  }>).payload,
                ),
            })
            : durable.publishPrepared({
              ...common,
              representation: "protected",
              publishProduct: () => createProduct(
                authority,
                prepared.taskId,
                prepared.task,
                null,
              ),
            }),
        );
      } finally {
        destroyTaskPublicationRequest(publicationRequest);
      }
      if (publication.protectedRevision?.status !== "mapped"
        && publication.protectedRevision?.status !== "replayed") {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_mapping_pending",
          "Task content mapping is pending",
        );
      }
      const activated = await readCreatedTask(
        dependencies.db,
        authority,
        publication.product.id,
      );
      if (activated.status === "pending" && activated.scheduleKind === "now") {
        dependencies.observer.kick();
      }
      return Object.freeze({
        taskId: activated.id,
        status: activated.status,
        nextFireAt: activated.nextFireAt?.toISOString() ?? null,
      });
    },

    async publishUpdate({ authority, taskId, prepared }) {
      const ownedTask = await getTaskById(dependencies.db, taskId);
      if (ownedTask === undefined) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const taskAuthority = resolveOwnedProtectedTaskAuthority(authority, ownedTask);
      if (taskAuthority === null) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const durable = await repository(taskAuthority);
      const freshPlan = await buildPlan(taskAuthority, taskId, {
        requestVersion: 1,
        operation: "update",
        operationId: prepared.operationId,
        task: prepared.task,
      });
      const imported = await importProtectedTaskPublicationV1({
        crypto: dependencies.crypto,
        now: now(),
        plan: freshPlan.planDigestBase64url === prepared.planDigestBase64url
          ? freshPlan : null,
        prepared,
        resolveCurrentAuthority: (request) =>
          resolveSignedAuthority(taskAuthority, request),
        lookupPreparedReplay: (request) => durable.lookupPreparedReplay(request),
      });
      const current = await getTaskById(dependencies.db, taskId);
      if (current === undefined || current.ownerId !== taskAuthority.userId
        || current.agentId !== taskAuthority.agentId) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const common = {
        owner: dependencies.owner,
        operationId: prepared.operationId,
        requestDigest: imported.requestDigest,
        authority: imported.authority,
        operationalMetadata: metadataFor(current),
        prepared: imported.prepared,
      } as const;
      const publicationRequest = decodePreparedTaskPublicationRequest(prepared);
      let publication;
      try {
        publication = await withCurrentProtectedTaskPublicationDeviceAuthority(
          dependencies.restricted,
          taskAuthority,
          publicationRequest,
          () => imported.representation === "dual"
            ? durable.publishPrepared({
              ...common,
              representation: "dual",
              ordinaryContent: imported.ordinaryContent,
              publishProduct: (content: TaskContentPayloadV1) =>
                updateProduct(
                  taskAuthority,
                  taskId,
                  prepared.expectedContentRevision,
                  prepared.task,
                  (content as Extract<TaskContentPayloadV1, {
                    coordinate: { kind: "definition" };
                  }>).payload,
                ),
            })
            : durable.publishPrepared({
              ...common,
              representation: "protected",
              publishProduct: () => updateProduct(
                taskAuthority,
                taskId,
                prepared.expectedContentRevision,
                prepared.task,
                null,
              ),
            }),
        );
      } finally {
        destroyTaskPublicationRequest(publicationRequest);
      }
      if (publication.protectedRevision?.status !== "mapped"
        && publication.protectedRevision?.status !== "replayed") {
        throw new ProtectedTaskRouteError(
          409,
          "task_content_mapping_pending",
          "Task content mapping is pending",
        );
      }
      const task = await getTaskById(dependencies.db, taskId);
      if (task === undefined) {
        throw new ProtectedTaskRouteError(404, "task_not_found", "Task not found");
      }
      const [names, models] = await Promise.all([
        getOwnerAgentDisplayNamesByAgentId(
          dependencies.db,
          taskAuthority.userId,
          [task.agentId],
        ),
        getLatestRunModelByTask(dependencies.db, [task.id]),
      ]);
      return toTaskContentSummaryV1(task, {
        agentName: names.get(task.agentId) ?? null,
        lastModelId: models.get(task.id) ?? null,
      });
    },
  };

  const composition = Object.freeze({
    mode: "protected_task_production" as const,
    ports: Object.freeze(ports),
  });
  productionCompositions.add(composition);
  return composition;
}
