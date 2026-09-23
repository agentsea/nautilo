import type {
  DualTaskPreparedCreateRequestV1,
  DualTaskPreparedUpdateRequestV1,
  NautiloApiClient,
  ProtectedTaskPreparedCreateRequestV1,
  ProtectedTaskPreparedUpdateRequestV1,
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
  decodeTaskPayloadV1,
  encodeTaskPayloadV1,
  type TaskPayloadV1,
} from "../../task/task-payload-v1.ts";
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
  encryptedPayloadBytes: Uint8Array;
  accessManifestBytes: Uint8Array;
  accessManifestProofBytes: readonly Uint8Array[];
  namespaceEnvelopeBytes: Uint8Array;
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
  readExact(input: Readonly<{
    taskId: string;
    reference: ProtectedTaskContentDtoV1;
  }>): Promise<TaskDefinitionReadEnvelopeV1>;
}

/** No private keys or plaintext cross this port's durable boundary. */
export interface HumanTaskDeviceContentPortV1 {
  prepareCreate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskPayloadV1;
    task: TaskOperationalCreateV1;
  }>): Promise<ProtectedTaskPreparedCreateRequestV1>;
  prepareUpdate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskPayloadV1;
    task: TaskOperationalUpdateV1;
  }>): Promise<ProtectedTaskPreparedUpdateRequestV1>;
  prepareDualCreate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskPayloadV1;
    task: TaskOperationalCreateV1;
  }>): Promise<DualTaskPreparedCreateRequestV1>;
  prepareDualUpdate(input: Readonly<{
    plan: TaskDefinitionPublicationPlanV1;
    payload: TaskPayloadV1;
    task: TaskOperationalUpdateV1;
  }>): Promise<DualTaskPreparedUpdateRequestV1>;
  /** Authenticate the manifest chain, exact envelope and Namespace keyring before returning bytes. */
  openExact(input: Readonly<{
    reference: ProtectedTaskContentDtoV1;
    envelope: TaskDefinitionReadEnvelopeV1;
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
    | Readonly<{ status: "protected"; payload: TaskPayloadV1 }>;
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
  if (
    envelope.readVersion !== 1
    || envelope.taskId !== taskId
    || envelope.objectId !== reference.objectId
    || envelope.contentRevision !== reference.contentRevision
    || envelope.cryptoAccessRevision !== reference.cryptoAccessRevision
    || !envelope.namespaceId
  ) throw integrity("Protected Task read was substituted");
}

/**
 * Policy-bound Task operations. Production binding remains dark until the
 * server supplies authenticated publication plans and exact ciphertext reads.
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
  const sendPrepared = async (
    mutation: PreparedHumanTaskMutation,
  ): Promise<TaskCreateResponse | TaskContentSummaryV1> => {
    if (mutation.kind === "task_create") {
      const response = "representation" in mutation.request
        ? await input.api.createDualPreparedTaskV1(mutation.request)
        : await input.api.createPreparedTaskV1(mutation.request);
      if (response.taskId !== mutation.taskId) {
        throw integrity("Protected Task creation receipt was substituted");
      }
      return response;
    }
    const response = "representation" in mutation.request
      ? await input.api.updateDualPreparedTaskV1(mutation.taskId, mutation.request)
      : await input.api.updatePreparedTaskV1(mutation.taskId, mutation.request);
    if (
      response.id !== mutation.taskId
      || response.content.status !== "protected"
      || response.content.contentRevision !== mutation.request.nextContentRevision
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
        TaskPayloadV1,
        HumanTaskOpenedDefinitionV1["content"]
      >({
        ordinary: async () => {
          const detail = await input.api.getTaskContentV1(taskId);
          if (detail.task.id !== taskId) throw integrity("Task detail was substituted");
          if (detail.definition.status !== "ordinary") {
            throw new ClassifiedDataOperationError("recoverable_availability", "Ordinary Task content is unavailable");
          }
          return detail.definition;
        },
        protected: async () => {
          if (task.content.status === "unavailable") {
            throw new ClassifiedDataOperationError(
              unavailableReason(task.content.reason),
              "Protected Task content is unavailable",
            );
          }
          if (task.content.status !== "protected") {
            throw new ClassifiedDataOperationError("recoverable_availability", "Protected Task content is unavailable");
          }
          const envelope = await input.plans.readExact({ taskId, reference: task.content });
          try {
            checkedRead(taskId, task.content, envelope);
            const bytes = await input.content.openExact({ reference: task.content, envelope });
            try {
              return decodeTaskPayloadV1(bytes);
            } finally {
              bytes.fill(0);
            }
          } finally {
            wipeReadEnvelope(envelope);
          }
        },
        consumeOrdinary: (content) => Object.freeze({
          status: "ordinary" as const,
          prompt: content.prompt,
          expectedOutput: content.expectedOutput,
          lastError: content.lastError,
        }),
        consumeProtected: (payload) => Object.freeze({ status: "protected" as const, payload }),
      });
      return Object.freeze({ task, content: result.value });
    },
    create(inputIntent: Readonly<{
      payload: TaskPayloadV1;
      task: TaskOperationalCreateV1;
    }>): Promise<TaskCreateResponse> {
      const payload = canonicalPayload(inputIntent.payload);
      return input.owner.mutate<
        | Readonly<{ representation: "ordinary" }>
        | Readonly<{ representation: "protected"; request: ProtectedTaskPreparedCreateRequestV1 }>
        | Readonly<{ representation: "dual"; request: DualTaskPreparedCreateRequestV1 }>,
        TaskCreateResponse
      >({
        ordinary: () => Promise.resolve({ representation: "ordinary" }),
        protected: async () => {
          const operationId = input.createOperationId();
          const plan = checkedPlan(await input.plans.create({ operationId, task: inputIntent.task }), "create", operationId);
          const request = await input.content.prepareCreate({ plan, payload, task: inputIntent.task });
          checkedPrepared(request, plan);
          return { representation: "protected", request };
        },
        dual: async () => {
          const operationId = input.createOperationId();
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
      return input.owner.mutate<
        | Readonly<{ representation: "ordinary" }>
        | Readonly<{ representation: "protected"; request: ProtectedTaskPreparedUpdateRequestV1 }>
        | Readonly<{ representation: "dual"; request: DualTaskPreparedUpdateRequestV1 }>,
        TaskContentSummaryV1
      >({
        ordinary: () => Promise.resolve({ representation: "ordinary" }),
        protected: async () => {
          if (current.content.status !== "protected") {
            throw new ClassifiedDataOperationError(
              "recoverable_availability", "Protected Task content is unavailable",
            );
          }
          const operationId = input.createOperationId();
          const plan = checkedPlan(await input.plans.update({
            operationId, taskId, current, task: inputIntent.task,
          }), "update", operationId, taskId);
          const request = await input.content.prepareUpdate({ plan, payload, task: inputIntent.task });
          checkedPrepared(request, plan);
          return { representation: "protected", request };
        },
        dual: async () => {
          if (current.content.status !== "protected") {
            throw new ClassifiedDataOperationError(
              "recoverable_availability",
              "Protected Task content is unavailable",
            );
          }
          const operationId = input.createOperationId();
          const plan = checkedPlan(await input.plans.update({
            operationId, taskId, current, task: inputIntent.task,
          }), "update", operationId, taskId);
          const request = await input.content.prepareDualUpdate({
            plan,
            payload,
            task: inputIntent.task,
          });
          checkedPrepared(request, plan);
          return { representation: "dual", request };
        },
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
