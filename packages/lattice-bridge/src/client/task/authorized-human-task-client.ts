import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  NautiloApiClient,
  ProtectedTaskDefinitionReadReadyEnvelopeV1,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
  TaskOrdinaryFallbackCreatePlanV1,
  TaskOrdinaryFallbackPreparedCreateRequestV1,
  TaskOrdinaryFallbackPreparedUpdateRequestV1,
  TaskOrdinaryFallbackUpdatePlanV1,
} from "@nautilo/api-client/browser";
import type {
  ListTasksQuery,
  OrdinaryTaskDefinitionContentV1,
  ProtectedTaskContentDtoV1,
  TaskContentListV1,
  TaskContentSummaryV1,
  TaskCreateResponse,
  TaskOperationalCreateV1,
  TaskOperationalUpdateV1,
} from "@nautilo/types";
import {
  deriveTaskHistoricalContentCryptoObjectIdV1,
} from "../../task/task-historical-content-identity.ts";
import {
  decodeTaskDefinitionContent,
  decodeTaskPayloadV1,
  encodeTaskPayloadV1,
  TASK_PAYLOAD_MAX_WIRE_BYTES_V1,
  type DecodedTaskDefinitionContent,
  type TaskDefinitionContent,
  type TaskPayloadV1,
} from "../../task/task-payload-v1.ts";
import { parseTaskHistoricalRepairProvenanceV1 } from
  "../../task/task-historical-repair-provenance.ts";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
} from "../../transition/encryption-data-operation-owner.ts";
import type {
  PreparedHumanTaskMutation,
  PreparedMutationJournalIndex,
} from "../memory/prepared-mutation-journal.ts";

type TaskApi = Pick<NautiloApiClient,
  | "listTaskContentV1"
  | "getTaskContentV1"
  | "createPreparedTaskV1"
  | "updatePreparedTaskV1"
  | "createDualPreparedTaskV1"
  | "updateDualPreparedTaskV1"
  | "createTaskOrdinaryFallbackV1"
  | "updateTaskOrdinaryFallbackV1"
>;

/** Server-authored coordinates required before a Human device may encrypt. */
export type TaskDefinitionPublicationPlanV1 = Readonly<{
  planVersion: 1;
  operation: "create" | "update";
  operationId: string;
  taskId: string;
  expectedContentRevision: number;
  nextContentRevision: number;
  expectedCryptoAccessRevision: number;
  planDigestBase64url: string;
  /** Complete canonical V1/V2 definition bytes for an authorized stale-Dual
   * forward repair. Absent plans are not repair instructions. */
  ordinaryRepairPayloadBase64url?: string | undefined;
  authority: Readonly<{
    requesterHumanId: string;
    sourceRoomId: string;
    namespaceId: string;
    domainId: string;
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
    bindingHashBase64url: string;
    keyGeneration: number;
  }>;
}>;

/** Exact ciphertext/proof read; the server must never place plaintext here. */
export type TaskDefinitionReadEnvelopeV1 = Readonly<{
  readVersion: 1;
  taskId: string;
  objectId: string;
  contentRevision: number;
  cryptoAccessRevision: number;
  namespaceId: string;
  readAuthority: ProtectedTaskDefinitionReadReadyEnvelopeV1["readAuthority"];
  encryptedPayloadBytes: Uint8Array;
  accessManifestBytes: Uint8Array;
  accessManifestProofBytes: readonly Uint8Array[];
  namespaceEnvelopeBytes: Uint8Array;
  historicalRepair?: ProtectedTaskDefinitionReadReadyEnvelopeV1["historicalRepair"];
  /** Device port authenticates the exact signer chain and current authority. */
  signerEvidence: readonly unknown[];
}>;

export interface HumanTaskPublicationPlansV1 {
  /** Content-free lifecycle plus protected coordinates; ordinary text is never serialized. */
  listProtected(query: ListTasksQuery): Promise<TaskContentListV1>;
  create(input: Readonly<{
    operationId: string;
    task: TaskOperationalCreateV1;
  }>): Promise<TaskDefinitionPublicationPlanV1>;
  update(input: Readonly<{
    operationId: string;
    taskId: string;
    current: TaskContentSummaryV1;
    task: TaskOperationalUpdateV1;
  }>): Promise<TaskDefinitionPublicationPlanV1>;
  ordinaryFallbackCreate?(input: Readonly<{
    operationId: string;
    task: TaskOperationalCreateV1;
  }>): Promise<TaskOrdinaryFallbackCreatePlanV1>;
  ordinaryFallbackUpdate?(input: Readonly<{
    operationId: string;
    taskId: string;
    task: TaskOperationalUpdateV1;
  }>): Promise<TaskOrdinaryFallbackUpdatePlanV1>;
  readExact(input: Readonly<{
    taskId: string;
    reference: ProtectedTaskContentDtoV1;
  }>): Promise<TaskDefinitionReadEnvelopeV1>;
}

/** No private keys or plaintext cross this port's durable boundary. */
export interface HumanTaskDeviceContentPortV1 {
  prepareOrdinaryFallbackCreate(input: Readonly<{
    plan: TaskOrdinaryFallbackCreatePlanV1;
    payload: TaskPayloadV1;
    task: TaskOperationalCreateV1;
  }>): Promise<TaskOrdinaryFallbackPreparedCreateRequestV1>;
  prepareOrdinaryFallbackUpdate(input: Readonly<{
    plan: TaskOrdinaryFallbackUpdatePlanV1;
    payload: TaskDefinitionContent;
    task: TaskOperationalUpdateV1;
  }>): Promise<TaskOrdinaryFallbackPreparedUpdateRequestV1>;
  prepareCreate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskPayloadV1;
    task: TaskOperationalCreateV1;
  }>): Promise<ProtectedTaskPreparedCreateRequestV1>;
  prepareUpdate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskDefinitionContent;
    task: TaskOperationalUpdateV1;
  }>): Promise<ProtectedTaskPreparedUpdateRequestV1>;
  prepareDualCreate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskPayloadV1;
    task: TaskOperationalCreateV1;
  }>): Promise<DualTaskPreparedCreateRequestV1>;
  prepareDualUpdate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskDefinitionContent;
    task: TaskOperationalUpdateV1;
  }>): Promise<DualTaskPreparedUpdateRequestV1>;
  /** Authenticate the manifest chain, exact envelope and Namespace keyring before returning bytes. */
  openExact(input: Readonly<{
    reference: ProtectedTaskContentDtoV1;
    envelope: TaskDefinitionReadEnvelopeV1;
    expectedAgentId?: string;
  }>): Promise<Uint8Array>;
}

export interface HumanTaskPreparedJournalV1 {
  putBeforeSend(mutation: PreparedHumanTaskMutation): Promise<Readonly<{
    status: "inserted" | "duplicate";
    index: PreparedMutationJournalIndex;
  }>>;
  withPrepared<Result>(operationId: string, use: (
    mutation: PreparedHumanTaskMutation,
  ) => Promise<Result> | Result): Promise<Result>;
  recordOutcome(input: Readonly<{
    operationId: string;
    authenticatedRequestDigestBase64url: string;
    outcome: "completed" | "retryable" | "stale" | "denied" | "integrity" | "expired" | "collision";
  }>): Promise<void>;
};

export interface HumanTaskOrdinaryPublicationPortV1 {
  create(input: Readonly<{
    payload: TaskPayloadV1;
    task: TaskOperationalCreateV1;
  }>): Promise<TaskCreateResponse>;
  update(input: Readonly<{
    taskId: string;
    payload: TaskPayloadV1;
    task: TaskOperationalUpdateV1;
  }>): Promise<TaskContentSummaryV1>;
};

export type HumanTaskOpenedDefinitionV1 = Readonly<{
  task: TaskContentSummaryV1;
  content:
    | Readonly<{
        status: "ordinary";
        prompt: string;
        expectedOutput: string | null;
        lastError: string | null;
      }>
    | Readonly<{
        status: "protected";
        payload: TaskPayloadV1;
        retainedHistoricalError: string | null;
      }>;
}>;

function checkedProtectedList(list: TaskContentListV1): TaskContentListV1 {
  if (list.some((item) => item.content.status === "ordinary")) {
    throw integrity("Protected Task list contained ordinary content");
  }
  return list;
}

function unavailableReason(reason: string): "key_waiting" | "stale" | "unsupported" | "integrity" {
  if (reason === "waiting_for_authorization" || reason === "device_not_ready") return "key_waiting";
  if (reason === "authority_changed") return "stale";
  if (reason === "integrity_failure") return "integrity";
  return "unsupported";
}

function canonicalPayload(payload: TaskPayloadV1): TaskPayloadV1 {
  const bytes = encodeTaskPayloadV1(payload);
  try {
    return decodeTaskPayloadV1(bytes);
  } finally {
    bytes.fill(0);
  }
}

function integrity(message: string): ClassifiedDataOperationError {
  return new ClassifiedDataOperationError("integrity", message);
}

function decodeOrdinaryRepairPayload(value: string): DecodedTaskDefinitionContent {
  const maximumEncodedLength = Math.ceil(TASK_PAYLOAD_MAX_WIRE_BYTES_V1 / 3) * 4;
  if (value.length === 0 || value.length > maximumEncodedLength
    || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw integrity("Protected Task repair payload is invalid");
  }
  let bytes: Uint8Array;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      + "=".repeat((4 - value.length % 4) % 4);
    bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0));
  } catch (cause) {
    throw new ClassifiedDataOperationError(
      "integrity", "Protected Task repair payload is invalid", { cause },
    );
  }
  try {
    if (bytes.length === 0 || bytes.length > TASK_PAYLOAD_MAX_WIRE_BYTES_V1) {
      throw integrity("Protected Task repair payload is invalid");
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    if (btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
      .replace(/=+$/u, "") !== value) {
      throw integrity("Protected Task repair payload is not canonical base64url");
    }
    try {
      return decodeTaskDefinitionContent(bytes);
    } catch (cause) {
      throw new ClassifiedDataOperationError(
        "integrity", "Protected Task repair definition is invalid", { cause },
      );
    }
  } finally {
    bytes.fill(0);
  }
}

function wipeReadEnvelope(envelope: TaskDefinitionReadEnvelopeV1): void {
  envelope.encryptedPayloadBytes.fill(0);
  envelope.accessManifestBytes.fill(0);
  envelope.namespaceEnvelopeBytes.fill(0);
  for (const proof of envelope.accessManifestProofBytes) proof.fill(0);
}

function checkedPlan(
  plan: TaskDefinitionPublicationPlanV1,
  operation: "create" | "update",
  operationId: string,
  taskId?: string,
): TaskDefinitionPublicationPlanV1 {
  if (
    plan.planVersion !== 1
    || plan.operation !== operation
    || plan.operationId !== operationId
    || (taskId !== undefined && plan.taskId !== taskId)
    || plan.nextContentRevision !== plan.expectedContentRevision + 1
    || (operation === "create" && (plan.expectedContentRevision !== 0
      || plan.expectedCryptoAccessRevision !== 0))
    || !plan.authority.sourceRoomId
    || !plan.authority.namespaceId
    || !plan.authority.domainId
    || !plan.authority.requesterHumanId
  ) throw integrity("Protected Task publication plan disagrees with the operation");
  return plan;
}

function checkedOrdinaryFallbackPlan<Plan extends
  TaskOrdinaryFallbackCreatePlanV1 | TaskOrdinaryFallbackUpdatePlanV1>(
  plan: Plan,
  operation: "create" | "update",
  operationId: string,
  taskId?: string,
): Plan {
  if (
    plan.purpose !== `task.ordinary_fallback.${operation}`
    || plan.operationId !== operationId
    || (taskId !== undefined && plan.taskId !== taskId)
  ) throw integrity("Task ordinary fallback plan disagrees with the operation");
  return plan;
}

function checkedPrepared(
  request: ProtectedTaskPreparedCreateRequestV1
    | ProtectedTaskPreparedUpdateRequestV1
    | DualTaskPreparedCreateRequestV1
    | DualTaskPreparedUpdateRequestV1,
  plan: TaskDefinitionPublicationPlanV1,
): void {
  if (
    request.operation !== plan.operation
    || request.operationId !== plan.operationId
    || request.taskId !== plan.taskId
    || request.planDigestBase64url !== plan.planDigestBase64url
    || request.expectedContentRevision !== plan.expectedContentRevision
    || request.nextContentRevision !== plan.nextContentRevision
    || request.expectedCryptoAccessRevision !== plan.expectedCryptoAccessRevision
    || request.requiredNamespaceIds.length !== 1
    || request.requiredNamespaceIds[0] !== plan.authority.namespaceId
    || request.namespaceEnvelopes[0]?.namespaceId !== plan.authority.namespaceId
  ) throw integrity("Prepared Task publication disagrees with its plan");
}

function checkedRead(
  taskId: string,
  reference: ProtectedTaskContentDtoV1,
  envelope: TaskDefinitionReadEnvelopeV1,
): void {
  let historicalRepair = envelope.historicalRepair;
  if (historicalRepair !== undefined) {
    try {
      const parsed = parseTaskHistoricalRepairProvenanceV1(historicalRepair);
      if (parsed.version !== 2) throw new TypeError("unsupported version");
      historicalRepair = parsed;
    } catch (cause) {
      throw new ClassifiedDataOperationError(
        "integrity", "Protected Task historical read metadata is invalid",
        { cause },
      );
    }
  }
  const historicalSourceDigest = historicalRepair === undefined
    || !/^[0-9a-f]{64}$/u.test(historicalRepair.sourceDigest)
    ? null
    : Uint8Array.from(historicalRepair.sourceDigest.match(/../gu)!,
        byte => Number.parseInt(byte, 16));
  const historicalObjectId = historicalSourceDigest === null
    ? null : deriveTaskHistoricalContentCryptoObjectIdV1({
        coordinate: {
          kind: "definition",
          taskId,
          contentRevision: envelope.contentRevision,
        },
        namespaceId: envelope.namespaceId,
        sourceDigest: historicalSourceDigest,
      });
  if (
    envelope.readVersion !== 1
    || envelope.taskId !== taskId
    || envelope.objectId !== reference.objectId
    || envelope.contentRevision !== reference.contentRevision
    || envelope.cryptoAccessRevision !== reference.cryptoAccessRevision
    || envelope.accessManifestProofBytes.length !== reference.cryptoAccessRevision
    || !envelope.namespaceId
    || historicalRepair !== undefined
      && (historicalSourceDigest === null
        || envelope.contentRevision !== 1
        || historicalObjectId !== envelope.objectId
        || envelope.signerEvidence.length === 0
        || envelope.signerEvidence.some(entry =>
          (entry as { kind?: unknown }).kind !== "human_device")
        || !envelope.signerEvidence.some(entry =>
          (entry as { kind?: unknown; committerDeviceId?: unknown }).kind
              === "human_device"
            && (entry as { committerDeviceId?: unknown }).committerDeviceId
              === historicalRepair.publisherDeviceId))
  ) throw integrity("Protected Task read was substituted");
}

/**
 * Task operations through the shared policy owner, authenticated publication
 * plans, exact ciphertext reads and the Device's durable prepared journal.
 */
export function createAuthorizedHumanTaskClientV1(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  api: TaskApi;
  plans: HumanTaskPublicationPlansV1;
  content: HumanTaskDeviceContentPortV1;
  journal: HumanTaskPreparedJournalV1;
  ordinary?: HumanTaskOrdinaryPublicationPortV1;
  createOperationId: () => string;
}>) {
  const openProtectedDefinition = async (
    task: TaskContentSummaryV1,
  ): Promise<DecodedTaskDefinitionContent> => {
    const taskId = task.id;
    if (task.content.status === "unavailable") {
      throw new ClassifiedDataOperationError(
        unavailableReason(task.content.reason),
        "Protected Task content is unavailable",
      );
    }
    if (task.content.status !== "protected") {
      throw new ClassifiedDataOperationError(
        "recoverable_availability",
        "Protected Task content is unavailable",
      );
    }
    const envelope = await input.plans.readExact({ taskId, reference: task.content });
    try {
      checkedRead(taskId, task.content, envelope);
      const bytes = await input.content.openExact({
        reference: task.content,
        envelope,
        ...(task.agentId === null || task.agentId === undefined
          ? {}
          : { expectedAgentId: task.agentId }),
      });
      try {
        return decodeTaskDefinitionContent(bytes);
      } finally {
        bytes.fill(0);
      }
    } finally {
      wipeReadEnvelope(envelope);
    }
  };

  const contentForUpdate = (
    payload: TaskPayloadV1,
    retainedHistoricalError: string | null,
  ): TaskDefinitionContent => retainedHistoricalError === null
    ? payload
    : Object.freeze({
        formatVersion: 2 as const,
        prompt: payload.prompt,
        expectedOutput: payload.expectedOutput,
        protectedMetadata: payload.protectedMetadata,
        retainedHistoricalError,
      });

  const openOrdinaryDefinition = async (
    taskId: string,
  ): Promise<OrdinaryTaskDefinitionContentV1> => {
    const detail = await input.api.getTaskContentV1(taskId);
    if (detail.task.id !== taskId) throw integrity("Task detail was substituted");
    if (detail.definition.status !== "ordinary") {
      throw new ClassifiedDataOperationError(
        "recoverable_availability",
        "Ordinary Task content is unavailable",
      );
    }
    return detail.definition;
  };

  const sendPrepared = async (
    mutation: PreparedHumanTaskMutation,
  ): Promise<TaskCreateResponse | TaskContentSummaryV1> => {
    if (mutation.kind === "task_create") {
      const response = "representation" in mutation.request
          && mutation.request.representation === "ordinary_fallback"
        ? await input.api.createTaskOrdinaryFallbackV1(mutation.request)
        : "representation" in mutation.request
        ? await input.api.createDualPreparedTaskV1(mutation.request)
        : await input.api.createPreparedTaskV1(mutation.request);
      if (response.taskId !== mutation.taskId) {
        throw integrity("Protected Task creation receipt was substituted");
      }
      return response;
    }
    const response = "representation" in mutation.request
        && mutation.request.representation === "ordinary_fallback"
      ? await input.api.updateTaskOrdinaryFallbackV1(
          mutation.taskId,
          mutation.request,
        )
      : "representation" in mutation.request
      ? await input.api.updateDualPreparedTaskV1(mutation.taskId, mutation.request)
      : await input.api.updatePreparedTaskV1(mutation.taskId, mutation.request);
    if (
      response.id !== mutation.taskId
      || ("representation" in mutation.request
          && mutation.request.representation === "ordinary_fallback"
        ? response.content.status !== "ordinary"
        : response.content.status !== "protected"
          || response.content.contentRevision
            !== mutation.request.nextContentRevision)
    ) throw integrity("Protected Task update receipt was substituted");
    return response;
  };

  const publishPrepared = async <Result extends TaskCreateResponse | TaskContentSummaryV1>(
    mutation: PreparedHumanTaskMutation,
  ): Promise<Result> => {
    const { index } = await input.journal.putBeforeSend(mutation);
    try {
      const response = await input.journal.withPrepared(
        index.operationId,
        async (retained) => {
          if (retained.taskId !== mutation.taskId || retained.kind !== mutation.kind) {
            throw integrity("Prepared Task journal entry was substituted");
          }
          return sendPrepared(retained);
        },
      );
      await input.journal.recordOutcome({
        operationId: index.operationId,
        authenticatedRequestDigestBase64url: index.authenticatedRequestDigestBase64url,
        outcome: "completed",
      });
      return response as Result;
    } catch (error) {
      await input.journal.recordOutcome({
        operationId: index.operationId,
        authenticatedRequestDigestBase64url: index.authenticatedRequestDigestBase64url,
        outcome: error instanceof ClassifiedDataOperationError
          && error.failureClass === "integrity" ? "integrity" : "retryable",
      });
      throw error;
    }
  };

  return Object.freeze({
    async list(query: ListTasksQuery = {}): Promise<TaskContentListV1> {
      const result = await input.owner.read<
        TaskContentListV1,
        TaskContentListV1,
        TaskContentListV1
      >({
        ordinary: () => input.api.listTaskContentV1(query),
        protected: () => input.plans.listProtected(query),
        consumeOrdinary: (list) => list,
        consumeProtected: checkedProtectedList,
      });
      return result.value;
    },
    async open(task: TaskContentSummaryV1): Promise<HumanTaskOpenedDefinitionV1> {
      const taskId = task.id;
      const result = await input.owner.read<
        OrdinaryTaskDefinitionContentV1,
        Readonly<{ task: TaskContentSummaryV1; definition: DecodedTaskDefinitionContent }>,
        HumanTaskOpenedDefinitionV1
      >({
        ordinary: async () => {
          return openOrdinaryDefinition(taskId);
        },
        protected: async () => Object.freeze({
          task,
          definition: await openProtectedDefinition(task),
        }),
        ...(task.status === "pending" || task.status === "paused" ? {
          repair: { forward: async () => {
            const operationId = input.createOperationId();
            const operational = Object.freeze({});
            const plan = checkedPlan(await input.plans.update({
              operationId,
              taskId,
              current: task,
              task: operational,
            }), "update", operationId, taskId);
            if (plan.ordinaryRepairPayloadBase64url === undefined) {
              throw new ClassifiedDataOperationError(
                "recoverable_availability",
                "Protected Task has no authorized forward repair",
              );
            }
            const source = decodeOrdinaryRepairPayload(
              plan.ordinaryRepairPayloadBase64url,
            );
            const content = contentForUpdate(
              source.payload,
              source.retainedHistoricalError,
            );
            const request = await input.content.prepareDualUpdate({
              plan,
              payload: content,
              task: operational,
            });
            checkedPrepared(request, plan);
            const updated = await publishPrepared<TaskContentSummaryV1>({
              kind: "task_update",
              taskId,
              request,
            });
            return Object.freeze({
              task: updated,
              definition: await openProtectedDefinition(updated),
            });
          } },
        } : {}),
        consumeOrdinary: (content) => Object.freeze({
          task,
          content: Object.freeze({
            status: "ordinary" as const,
            prompt: content.prompt,
            expectedOutput: content.expectedOutput,
            lastError: content.lastError,
          }),
        }),
        consumeProtected: ({ task: openedTask, definition }) => Object.freeze({
          task: openedTask,
          content: Object.freeze({
            status: "protected" as const,
            payload: definition.payload,
            retainedHistoricalError: definition.retainedHistoricalError,
          }),
        }),
      });
      return result.value;
    },
    create(inputIntent: Readonly<{
      payload: TaskPayloadV1;
      task: TaskOperationalCreateV1;
    }>): Promise<TaskCreateResponse> {
      const payload = canonicalPayload(inputIntent.payload);
      let operationId: string | undefined;
      const exactOperationId = () => operationId ??= input.createOperationId();
      return input.owner.mutate<
        | Readonly<{ representation: "ordinary" }>
        | Readonly<{ representation: "protected"; request: ProtectedTaskPreparedCreateRequestV1 }>
        | Readonly<{ representation: "dual"; request: DualTaskPreparedCreateRequestV1 }>
        | Readonly<{ representation: "ordinary_fallback"; request: TaskOrdinaryFallbackPreparedCreateRequestV1 }>,
        TaskCreateResponse
      >({
        ordinary: () => Promise.resolve({ representation: "ordinary" }),
        protected: async () => {
          const operationId = exactOperationId();
          const plan = checkedPlan(await input.plans.create({ operationId, task: inputIntent.task }), "create", operationId);
          const request = await input.content.prepareCreate({ plan, payload, task: inputIntent.task });
          checkedPrepared(request, plan);
          return { representation: "protected", request };
        },
        dual: async () => {
          const operationId = exactOperationId();
          const plan = checkedPlan(
            await input.plans.create({ operationId, task: inputIntent.task }),
            "create",
            operationId,
          );
          const request = await input.content.prepareDualCreate({
            plan,
            payload,
            task: inputIntent.task,
          });
          checkedPrepared(request, plan);
          return { representation: "dual", request };
        },
        ...(input.plans.ordinaryFallbackCreate === undefined ? {} : {
        ordinaryFallback: async () => {
          const operationId = exactOperationId();
          const plan = checkedOrdinaryFallbackPlan(
            await input.plans.ordinaryFallbackCreate!({
              operationId,
              task: inputIntent.task,
            }),
            "create",
            operationId,
          );
          const request = await input.content.prepareOrdinaryFallbackCreate({
            plan,
            payload,
            task: inputIntent.task,
          });
          return { representation: "ordinary_fallback", request };
        }}),
        publish: (plan) => plan.representation === "ordinary"
          ? input.ordinary === undefined
            ? Promise.reject(new ClassifiedDataOperationError("unsupported", "Ordinary Task publication is unavailable"))
            : input.ordinary.create({ payload, task: inputIntent.task })
          : publishPrepared<TaskCreateResponse>({
              kind: "task_create", taskId: plan.request.taskId, request: plan.request,
            }),
      });
    },
    update(current: TaskContentSummaryV1, inputIntent: Readonly<{
      payload: TaskPayloadV1;
      task: TaskOperationalUpdateV1;
    }>): Promise<TaskContentSummaryV1> {
      const taskId = current.id;
      const payload = canonicalPayload(inputIntent.payload);
      let operationId: string | undefined;
      let fallbackContent: TaskDefinitionContent | undefined;
      const exactOperationId = () => operationId ??= input.createOperationId();
      return input.owner.mutate<
        | Readonly<{ representation: "ordinary" }>
        | Readonly<{ representation: "protected"; request: ProtectedTaskPreparedUpdateRequestV1 }>
        | Readonly<{ representation: "dual"; request: DualTaskPreparedUpdateRequestV1 }>
        | Readonly<{ representation: "ordinary_fallback"; request: TaskOrdinaryFallbackPreparedUpdateRequestV1 }>,
        TaskContentSummaryV1
      >({
        ordinary: () => Promise.resolve({ representation: "ordinary" }),
        protected: async () => {
          if (current.content.status !== "protected") {
            throw new ClassifiedDataOperationError(
              "recoverable_availability", "Protected Task content is unavailable",
            );
          }
          const opened = await openProtectedDefinition(current);
          const content = contentForUpdate(payload, opened.retainedHistoricalError);
          const operationId = exactOperationId();
          const plan = checkedPlan(await input.plans.update({
            operationId, taskId, current, task: inputIntent.task,
          }), "update", operationId, taskId);
          const request = await input.content.prepareUpdate({ plan, payload: content, task: inputIntent.task });
          checkedPrepared(request, plan);
          return { representation: "protected", request };
        },
        dual: async () => {
          if (current.content.status !== "protected" && current.content.status !== "ordinary") {
            throw new ClassifiedDataOperationError(
              "recoverable_availability",
              "Protected Task counterpart is unavailable",
            );
          }
          const retainedError = current.content.status === "protected"
            ? (await openProtectedDefinition(current)).retainedHistoricalError
            : (await openOrdinaryDefinition(taskId)).lastError;
          const content = contentForUpdate(payload, retainedError);
          fallbackContent = content;
          const operationId = exactOperationId();
          const plan = checkedPlan(await input.plans.update({
            operationId, taskId, current, task: inputIntent.task,
          }), "update", operationId, taskId);
          const request = await input.content.prepareDualUpdate({
            plan,
            payload: content,
            task: inputIntent.task,
          });
          checkedPrepared(request, plan);
          return { representation: "dual", request };
        },
        ...(input.plans.ordinaryFallbackUpdate === undefined ? {} : {
        ordinaryFallback: async () => {
          if (fallbackContent === undefined
            && current.content.status === "ordinary") {
            const ordinary = await openOrdinaryDefinition(taskId);
            fallbackContent = contentForUpdate(payload, ordinary.lastError);
          }
          if (fallbackContent === undefined) {
            throw new ClassifiedDataOperationError(
              "key_waiting",
              "Task fallback update source content is unavailable",
            );
          }
          const operationId = exactOperationId();
          const plan = checkedOrdinaryFallbackPlan(
            await input.plans.ordinaryFallbackUpdate!({
              operationId,
              taskId,
              task: inputIntent.task,
            }),
            "update",
            operationId,
            taskId,
          );
          const request = await input.content.prepareOrdinaryFallbackUpdate({
            plan,
            payload: fallbackContent,
            task: inputIntent.task,
          });
          return { representation: "ordinary_fallback", request };
        }}),
        publish: (plan) => plan.representation === "ordinary"
          ? input.ordinary === undefined
            ? Promise.reject(new ClassifiedDataOperationError("unsupported", "Ordinary Task publication is unavailable"))
            : input.ordinary.update({ taskId, payload, task: inputIntent.task })
          : publishPrepared<TaskContentSummaryV1>({
              kind: "task_update", taskId, request: plan.request,
            }),
      });
    },
  });
}
