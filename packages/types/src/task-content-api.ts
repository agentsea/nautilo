import type { SelectionProfile, ComboSpec } from "./model-selection";
import type {
  ListTasksQuery,
  TaskCreatePayload,
  TaskRunTranscriptMessage,
  TaskSummary,
  TaskUpdatePayload,
} from "./task-api";
import type {
  ProtectedTaskContentResponseV1,
  ProtectedTaskContentUnavailableDtoV1,
} from "./protected-task-dto";

/** Opt-in Task HTTP projection. Legacy Task responses retain their existing shape. */
export const TASK_CONTENT_API_VERSION_V1 = 1 as const;

export type TaskOperationalCreateV1 = Omit<TaskCreatePayload, "prompt" | "expectedOutput">;
export type TaskOperationalUpdateV1 = Omit<TaskUpdatePayload, "prompt" | "expectedOutput">;

export type TaskLifecycleSummaryV1 = Omit<TaskSummary, "prompt" | "lastError">;

export type OrdinaryTaskSummaryContentV1 = Readonly<{
  dtoVersion: typeof TASK_CONTENT_API_VERSION_V1;
  status: "ordinary";
  promptPreview: string;
  lastError: string | null;
}>;

export type TaskContentSummaryV1 = TaskLifecycleSummaryV1 & Readonly<{
  content: OrdinaryTaskSummaryContentV1 | ProtectedTaskContentResponseV1;
}>;

export type TaskContentListV1 = readonly TaskContentSummaryV1[];
export type TaskContentListQueryV1 = ListTasksQuery;

export type OrdinaryTaskDefinitionContentV1 = Readonly<{
  dtoVersion: typeof TASK_CONTENT_API_VERSION_V1;
  status: "ordinary";
  prompt: string;
  expectedOutput: string | null;
  lastError: string | null;
}>;

export type TaskDefinitionContentV1 =
  | OrdinaryTaskDefinitionContentV1
  | ProtectedTaskContentResponseV1;

export type TaskDetailLifecycleV1 = TaskLifecycleSummaryV1 & Readonly<{
  cron: string | null;
  runAt: string | null;
  timezone: string;
  targetChat: string;
  resultDelivery: string;
  useScope: boolean;
  scopeId: string | null;
  toolsMode: string;
  toolsWhitelist: string[];
  selectionProfile: SelectionProfile;
  selectionSpec: ComboSpec | null;
  requestedModelId: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type TaskRunContentV1 = Readonly<{
  dtoVersion: typeof TASK_CONTENT_API_VERSION_V1;
  status: "ordinary";
  resultText: string | null;
  lastError: string | null;
  transcript: TaskRunTranscriptMessage[];
}> | ProtectedTaskContentUnavailableDtoV1;

export type TaskRunSummaryV1 = Readonly<{
  id: string;
  status: string;
  modelId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  content: TaskRunContentV1;
}>;

export type TaskContentDetailV1 = Readonly<{
  task: TaskDetailLifecycleV1;
  definition: TaskDefinitionContentV1;
  runs: TaskRunSummaryV1[];
}>;
