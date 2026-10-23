import type {
  ListTasksQuery,
  TaskCreateResponse,
  TaskRunTranscriptMessage,
} from "./task-api";
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

/** Platform-neutral projection of the canonical protected TaskRun result. */
export type TaskOperationRunResultReadV1 =
  | Readonly<{
      status: "ready";
      payload: Readonly<{
        formatVersion: 1;
        resultText: string | null;
        lastError: string | null;
      }>;
    }>
  | Readonly<{ status: "waiting"; reason: "result_not_mapped" }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "result_not_protected"
        | "authority_changed"
        | "unsupported_crypto_access_revision"
        | "integrity_failure";
    }>;

/** Authenticated, platform-neutral page of one exact protected TaskRun transcript. */
export type TaskOperationRunTranscriptReadV1 =
  | Readonly<{
      status: "ready";
      messages: readonly TaskRunTranscriptMessage[];
      nextCursor: string | null;
    }>
  | Readonly<{ status: "waiting"; reason: "transcript_not_mapped" }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "transcript_not_protected"
        | "not_in_message_audience"
        | "message_history_unavailable"
        | "device_not_ready"
        | "authority_changed"
        | "integrity_failure";
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
      operation: "open_result";
      taskId: string;
      taskRunId: string;
      agentId: string;
    }>
  | Readonly<{
      version: 1;
      operation: "open_transcript";
      taskId: string;
      taskRunId: string;
      agentId: string;
      cursor?: string;
      limit?: number;
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
    | Readonly<{
        status: "protected";
        payload: TaskOperationPayloadV1;
        /** Authenticated display snapshot; never Task lifecycle authority. */
        retainedHistoricalError: string | null;
      }>;
}>;

export type TaskOperationResponseV1 =
  | Readonly<{ version: 1; status: "unavailable"; reason: "unsupported_client" }>
  | Readonly<{ version: 1; status: "ready"; operation: "list"; data: TaskContentListV1 }>
  | Readonly<{ version: 1; status: "ready"; operation: "open"; data: TaskOperationOpenedDefinitionV1 }>
  | Readonly<{
      version: 1;
      status: "ready";
      operation: "open_result";
      data: TaskOperationRunResultReadV1;
    }>
  | Readonly<{
      version: 1;
      status: "ready";
      operation: "open_transcript";
      data: TaskOperationRunTranscriptReadV1;
    }>
  | Readonly<{ version: 1; status: "ready"; operation: "create"; data: TaskCreateResponse }>
  | Readonly<{ version: 1; status: "ready"; operation: "update"; data: TaskContentSummaryV1 }>;
