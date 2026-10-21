import {
  createAuthorizedHumanTaskRunTranscriptReaderV1,
  createBrowserHumanTaskClient,
  createBrowserHumanTaskRunResultReader,
  createBrowserRoomHistoryShadowMessageReader,
} from
  "@nautilo/lattice-bridge/client/browser";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import type {
  ListTasksQuery,
  TaskContentSummaryV1,
  TaskDetail,
  TaskOperationRunResultReadV1,
  TaskOperationRunTranscriptReadV1,
  TaskOperationalCreateV1,
  TaskOperationalUpdateV1,
  TaskRunSummary,
  TaskRunSummaryV1,
} from "@nautilo/types";
import { ApiError } from "@nautilo/api-client/browser";
import type { TaskPayloadV1 } from "@nautilo/lattice-bridge";
import { apiClient } from "./api";
import { readOrCreateBrowserCryptoInstallationId } from
  "./browser-crypto-installation";
import { desktopAPI, isDesktop } from "./desktop";

export interface WorkbenchProtectedHumanTaskController {
  list(query?: ListTasksQuery): ReturnType<ReturnType<
    typeof createBrowserHumanTaskClient
  >["list"]>;
  open(task: TaskContentSummaryV1): ReturnType<ReturnType<
    typeof createBrowserHumanTaskClient
  >["open"]>;
  create(input: Readonly<{
    payload: TaskPayloadV1;
    task: TaskOperationalCreateV1;
  }>): ReturnType<ReturnType<typeof createBrowserHumanTaskClient>["create"]>;
  update(current: TaskContentSummaryV1, input: Readonly<{
    payload: TaskPayloadV1;
    task: TaskOperationalUpdateV1;
  }>): ReturnType<ReturnType<typeof createBrowserHumanTaskClient>["update"]>;
  openResult(input: Readonly<{
    taskId: string;
    taskRunId: string;
    agentId: string;
  }>): Promise<TaskOperationRunResultReadV1>;
  openTranscript(input: Readonly<{
    taskId: string;
    taskRunId: string;
    agentId: string;
    cursor?: string;
    limit?: number;
  }>): Promise<TaskOperationRunTranscriptReadV1>;
}

export type ProtectedScheduledTaskProjection =
  | Readonly<{
      availability: "opened";
      task: TaskContentSummaryV1;
      prompt: string;
      expectedOutput: string | null;
      /** Authenticated display snapshot; never Task lifecycle authority. */
      retainedHistoricalError: string | null;
    }>
  | Readonly<{
      availability: "unavailable";
      task: TaskContentSummaryV1;
      reason: "waiting_for_authorization" | "device_not_ready"
        | "authority_changed" | "unsupported_client" | "integrity_failure";
    }>;

function isTaskContentIntegrityFailure(error: unknown): boolean {
  return error instanceof ClassifiedDataOperationError
      && error.failureClass === "integrity"
    || error instanceof ApiError
      && error.status === 409
      && error.message === "task_content_integrity_failure";
}

export async function listProtectedScheduledTasks(
  controller: WorkbenchProtectedHumanTaskController,
): Promise<readonly ProtectedScheduledTaskProjection[]> {
  const listed = await controller.list({ includeTerminal: true });
  const scheduled = listed.filter((task) =>
    task.scheduleKind === "cron" || task.scheduleKind === "one_shot"
  );
  const opened = await Promise.all(scheduled.map(async (task) => {
    try {
      const definition = await controller.open(task);
      if (definition.content.status !== "protected") {
        return task.content.status === "unavailable"
          ? Object.freeze({
              availability: "unavailable" as const,
              task,
              reason: task.content.reason,
            })
          : null;
      }
      return Object.freeze({
        availability: "opened" as const,
        task: definition.task,
        prompt: definition.content.payload.prompt,
        expectedOutput: definition.content.payload.expectedOutput,
        retainedHistoricalError: definition.content.retainedHistoricalError,
      });
    } catch (error) {
      if (isTaskContentIntegrityFailure(error)) {
        return Object.freeze({
          availability: "unavailable" as const,
          task,
          reason: "integrity_failure" as const,
        });
      }
      if (task.content.status !== "unavailable"
        || !(error instanceof ClassifiedDataOperationError)
        || (error.failureClass !== "recoverable_availability"
          && error.failureClass !== "key_waiting")) throw error;
      return Object.freeze({
        availability: "unavailable" as const,
        task,
        reason: task.content.reason,
      });
    }
  }));
  return Object.freeze(opened.filter(
    (row): row is ProtectedScheduledTaskProjection => row !== null,
  ));
}

export async function openProtectedTaskById(
  controller: WorkbenchProtectedHumanTaskController,
  taskId: string,
) {
  const tasks = await controller.list({ includeTerminal: true });
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new ClassifiedDataOperationError(
      "recoverable_availability",
      "Protected Task is unavailable",
    );
  }
  return controller.open(task);
}

export type WorkbenchTaskViewerRead =
  | Readonly<{ representation: "ordinary"; detail: TaskDetail }>
  | Readonly<{
      representation: "protected";
      opened: Awaited<ReturnType<WorkbenchProtectedHumanTaskController["open"]>>;
      runs: readonly TaskRunSummaryV1[];
    }>;

export type WorkbenchTaskRunResultViewerRead =
  | Readonly<{ representation: "ordinary"; run: TaskRunSummary }>
  | Readonly<{
      representation: "protected";
      result: TaskOperationRunResultReadV1;
    }>;

function taskContentFailure(
  reason: "waiting_for_authorization" | "device_not_ready" | "authority_changed"
    | "unsupported_client" | "integrity_failure",
): ClassifiedDataOperationError {
  const failureClass = reason === "waiting_for_authorization"
      || reason === "device_not_ready"
    ? "key_waiting" as const
    : reason === "authority_changed"
      ? "authority" as const
      : reason === "integrity_failure"
        ? "integrity" as const
        : "unsupported" as const;
  return new ClassifiedDataOperationError(
    failureClass,
    "Protected Task content is unavailable",
  );
}

/** Exact owner-selected viewer read; Plain retains one legacy detail request. */
export async function readWorkbenchTaskForViewer(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  taskId: string;
  protectedController?: WorkbenchProtectedHumanTaskController | undefined;
}>): Promise<WorkbenchTaskViewerRead> {
  const selected = await input.owner.read<
    TaskDetail,
    Readonly<{
      opened: Awaited<ReturnType<WorkbenchProtectedHumanTaskController["open"]>>;
      runs: readonly TaskRunSummaryV1[];
    }>,
    WorkbenchTaskViewerRead
  >({
    ordinary: () => apiClient.getTask(input.taskId),
    protected: async () => {
      const classified = await apiClient.getTaskContentV1(input.taskId);
      if (input.protectedController === undefined) {
        if (classified.definition.status === "unavailable") {
          throw taskContentFailure(classified.definition.reason);
        }
        throw new ClassifiedDataOperationError(
          "key_waiting",
          "Protected Task device custody is unavailable",
        );
      }
      const content: TaskContentSummaryV1["content"] =
        classified.definition.status === "ordinary"
          ? Object.freeze({
              dtoVersion: 1 as const,
              status: "ordinary" as const,
              promptPreview: classified.definition.prompt,
              lastError: classified.definition.lastError,
            })
          : classified.definition;
      const opened = await input.protectedController.open(Object.freeze({
        ...classified.task,
        content,
      }));
      if (opened.content.status !== "protected") {
        throw new ClassifiedDataOperationError(
          "recoverable_availability",
          "Protected Task representation resolved to its ordinary sibling",
        );
      }
      return Object.freeze({ opened, runs: classified.runs });
    },
    consumeOrdinary: (detail) => Object.freeze({
      representation: "ordinary" as const,
      detail,
    }),
    consumeProtected: ({ opened, runs }) => Object.freeze({
      representation: "protected" as const,
      opened,
      runs,
    }),
  });
  return selected.value;
}

/**
 * Select one exact result without manufacturing an ordinary counterpart. The
 * optional legacy detail must already belong to the same viewer read.
 */
export async function readWorkbenchTaskRunResultForViewer(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  taskId: string;
  taskRunId: string;
  agentId: string;
  ordinaryDetail?: TaskDetail | undefined;
  protectedController?: WorkbenchProtectedHumanTaskController | undefined;
}>): Promise<WorkbenchTaskRunResultViewerRead> {
  const ordinaryDetail = input.ordinaryDetail;
  const selected = await input.owner.read<
    TaskRunSummary,
    TaskOperationRunResultReadV1,
    WorkbenchTaskRunResultViewerRead
  >({
    ordinary: ordinaryDetail === undefined ? undefined : () => {
      if (ordinaryDetail.task.id !== input.taskId) {
        return Promise.reject(new ClassifiedDataOperationError(
          "integrity",
          "Ordinary Task result identity was substituted",
        ));
      }
      const run = ordinaryDetail.runs.find(
        candidate => candidate.id === input.taskRunId,
      );
      if (run === undefined) {
        return Promise.reject(new ClassifiedDataOperationError(
          "recoverable_availability",
          "Ordinary Task result is unavailable",
        ));
      }
      return Promise.resolve(run);
    },
    protected: async () => {
      if (input.protectedController === undefined) {
        throw new ClassifiedDataOperationError(
          "recoverable_availability",
          "Protected Task result custody is unavailable in this client",
        );
      }
      const result = await input.protectedController.openResult({
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        agentId: input.agentId,
      });
      if (ordinaryDetail !== undefined
        && result.status === "unavailable"
        && result.reason === "result_not_protected") {
        throw new ClassifiedDataOperationError(
          "recoverable_availability",
          "Protected Task result resolved to its ordinary sibling",
        );
      }
      return result;
    },
    consumeOrdinary: (run) => Object.freeze({
      representation: "ordinary" as const,
      run,
    }),
    consumeProtected: (result) => Object.freeze({
      representation: "protected" as const,
      result,
    }),
  });
  return selected.value;
}

function unavailable(): never {
  throw new ClassifiedDataOperationError(
    "unsupported",
    "Protected Task custody is unavailable in this client",
  );
}

/**
 * Separate protected Task surface. Plain callers continue to use the legacy
 * Task API and never enter this composition.
 */
export function createWorkbenchProtectedHumanTaskController(input: Readonly<{
  owner: EncryptionDataOperationOwner;
  serverScope: string;
  userId: string;
  humanActorId: string;
}>): WorkbenchProtectedHumanTaskController | undefined {
  if (isDesktop) {
    const taskBridge = desktopAPI?.foregroundShadow?.task;
    if (taskBridge === undefined) return undefined;
    const operate: typeof taskBridge.operateV1 = (request) =>
      taskBridge.operateV1(request);
    return Object.freeze({
      async list(query = {}) {
        const response = await operate({ version: 1, operation: "list", query });
        return response.status === "ready" && response.operation === "list"
          ? response.data : unavailable();
      },
      async open(task: TaskContentSummaryV1) {
        const response = await operate({ version: 1, operation: "open", task });
        return response.status === "ready" && response.operation === "open"
          ? response.data : unavailable();
      },
      async create(intent: Readonly<{
        payload: TaskPayloadV1;
        task: TaskOperationalCreateV1;
      }>) {
        const response = await operate({ version: 1, operation: "create", ...intent });
        return response.status === "ready" && response.operation === "create"
          ? response.data : unavailable();
      },
      async update(current: TaskContentSummaryV1, intent: Readonly<{
        payload: TaskPayloadV1;
        task: TaskOperationalUpdateV1;
      }>) {
        const response = await operate({
          version: 1, operation: "update", current, ...intent,
        });
        return response.status === "ready" && response.operation === "update"
          ? response.data : unavailable();
      },
      async openResult(intent: Readonly<{
        taskId: string;
        taskRunId: string;
        agentId: string;
      }>) {
        const response = await operate({
          version: 1, operation: "open_result", ...intent,
        });
        return response.status === "ready"
          && response.operation === "open_result"
          ? response.data : unavailable();
      },
      async openTranscript(intent: Readonly<{
        taskId: string;
        taskRunId: string;
        agentId: string;
        cursor?: string;
        limit?: number;
      }>) {
        const response = await operate({
          version: 1, operation: "open_transcript", ...intent,
        });
        return response.status === "ready"
          && response.operation === "open_transcript"
          ? response.data : unavailable();
      },
    });
  }

  const installationId = readOrCreateBrowserCryptoInstallationId({
    serverScope: input.serverScope,
    userId: input.userId,
    humanActorId: input.humanActorId,
  });
  if (installationId === null) return undefined;
  const common = {
    dataOperationOwner: input.owner,
    api: apiClient,
    serverScope: input.serverScope,
    userId: input.userId,
    humanActorId: input.humanActorId,
    installationId,
    resolveDeviceAdmissionStatus: () => apiClient.deviceAdmission.status(),
  } as const;
  const taskClient = createBrowserHumanTaskClient(common);
  const resultReader = createBrowserHumanTaskRunResultReader(common);
  const history = createBrowserRoomHistoryShadowMessageReader(common);
  const transcriptReader = createAuthorizedHumanTaskRunTranscriptReaderV1({
    api: apiClient,
    owner: input.owner,
    history,
    createClientRequestKey: () => globalThis.crypto.randomUUID(),
  });
  return Object.freeze({
    ...taskClient,
    openResult(intent: Readonly<{
      taskId: string;
      taskRunId: string;
      agentId: string;
    }>) {
      return resultReader.read(intent);
    },
    openTranscript(intent: Readonly<{
      taskId: string;
      taskRunId: string;
      agentId: string;
      cursor?: string;
      limit?: number;
    }>) {
      return transcriptReader.read(intent);
    },
  });
}
