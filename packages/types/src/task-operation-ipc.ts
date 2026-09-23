import type { ListTasksQuery, TaskCreateResponse } from "./task-api";
import type {
  TaskContentListV1,
  TaskContentSummaryV1,
  TaskOperationalCreateV1,
  TaskOperationalUpdateV1,
} from "./task-content-api";
import type { ProtectedTaskMetadataClassificationV1 } from
  "./protected-task-metadata";

/** Versioned, platform-neutral Task operation envelope for a Human client. */
export const TASK_OPERATION_IPC_VERSION_V1 = 1 as const;

type TaskProtectedMetadataContentV1 = Extract<
  ProtectedTaskMetadataClassificationV1,
  { status: "supported" }
>["protectedContent"];

export type TaskOperationPayloadV1 = Readonly<{
  formatVersion: 1;
  prompt: string;
  expectedOutput: string | null;
  protectedMetadata: TaskProtectedMetadataContentV1;
}>;

export type TaskOperationRequestV1 =
  | Readonly<{
      version: 1;
      operation: "list";
      query?: ListTasksQuery | undefined;
    }>
  | Readonly<{
      version: 1;
      operation: "open";
      task: TaskContentSummaryV1;
    }>
  | Readonly<{
      version: 1;
      operation: "create";
      payload: TaskOperationPayloadV1;
      task: TaskOperationalCreateV1;
    }>
  | Readonly<{
      version: 1;
      operation: "update";
      current: TaskContentSummaryV1;
      payload: TaskOperationPayloadV1;
      task: TaskOperationalUpdateV1;
    }>;

export type TaskOperationOpenedDefinitionV1 = Readonly<{
  task: TaskContentSummaryV1;
  content:
    | Readonly<{
        status: "ordinary";
        prompt: string;
        expectedOutput: string | null;
        lastError: string | null;
      }>
    | Readonly<{ status: "protected"; payload: TaskOperationPayloadV1 }>;
}>;

export type TaskOperationResponseV1 =
  | Readonly<{ version: 1; status: "unavailable"; reason: "unsupported_client" }>
  | Readonly<{ version: 1; status: "ready"; operation: "list"; data: TaskContentListV1 }>
  | Readonly<{ version: 1; status: "ready"; operation: "open"; data: TaskOperationOpenedDefinitionV1 }>
  | Readonly<{ version: 1; status: "ready"; operation: "create"; data: TaskCreateResponse }>
  | Readonly<{ version: 1; status: "ready"; operation: "update"; data: TaskContentSummaryV1 }>;
