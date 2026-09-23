import { createBrowserHumanTaskClient } from
  "@nautilo/lattice-bridge/client/browser";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
} from "@nautilo/lattice-bridge";
import type {
  ListTasksQuery,
  TaskContentSummaryV1,
  TaskDetail,
  TaskOperationalCreateV1,
  TaskOperationalUpdateV1,
} from "@nautilo/types";
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
}

export type OpenedProtectedScheduledTask = Readonly<{
  task: TaskContentSummaryV1;
  prompt: string;
  expectedOutput: string | null;
}>;

export async function listOpenedProtectedScheduledTasks(
  controller: WorkbenchProtectedHumanTaskController,
): Promise<readonly OpenedProtectedScheduledTask[]> {
  const listed = await controller.list({ includeTerminal: true });
  const scheduled = listed.filter((task) =>
    task.scheduleKind === "cron" || task.scheduleKind === "one_shot"
  );
  const opened = await Promise.all(scheduled.map(async (task) => {
    const definition = await controller.open(task);
    if (definition.content.status !== "protected") return null;
    return Object.freeze({
      task,
      prompt: definition.content.payload.prompt,
      expectedOutput: definition.content.payload.expectedOutput,
    });
  }));
  return Object.freeze(opened.filter(
    (row): row is OpenedProtectedScheduledTask => row !== null,
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
    }>;

/** Exact policy-aware viewer read; Plain retains the legacy route unchanged. */
export async function readWorkbenchTaskForViewer(input: Readonly<{
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only" | "unknown";
  taskId: string;
  protectedController?: WorkbenchProtectedHumanTaskController | undefined;
}>): Promise<WorkbenchTaskViewerRead> {
  if (input.mode === "plaintext_only") {
    return Object.freeze({
      representation: "ordinary" as const,
      detail: await apiClient.getTask(input.taskId),
    });
  }
  if (input.mode === "unknown") unavailable();
  if (input.mode === "shadow_encryption" || input.mode === "encrypted_only") {
    const classified = await apiClient.getTaskContentV1(input.taskId);
    if (classified.definition.status === "ordinary") {
      return Object.freeze({
        representation: "ordinary" as const,
        detail: await apiClient.getTask(input.taskId),
      });
    }
    if (classified.definition.status === "protected") {
      if (input.protectedController === undefined) unavailable();
      return Object.freeze({
        representation: "protected" as const,
        opened: await input.protectedController.open(Object.freeze({
          ...classified.task,
          content: classified.definition,
        })),
      });
    }
    throw new ClassifiedDataOperationError(
      "key_waiting",
      "Protected Task content is unavailable",
    );
  }
  return unavailable();
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
    });
  }

  const installationId = readOrCreateBrowserCryptoInstallationId({
    serverScope: input.serverScope,
    userId: input.userId,
    humanActorId: input.humanActorId,
  });
  if (installationId === null) return undefined;
  return createBrowserHumanTaskClient({
    dataOperationOwner: input.owner,
    api: apiClient,
    serverScope: input.serverScope,
    userId: input.userId,
    humanActorId: input.humanActorId,
    installationId,
    resolveDeviceAdmissionStatus: () => apiClient.deviceAdmission.status(),
  });
}
