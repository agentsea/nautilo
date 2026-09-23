import {
  taskDetailTranscriptToPresentation,
  taskRunTranscriptToPresentation,
  type TaskContentDetailV1,
  type TaskContentSummaryV1,
  type TaskDetail,
  type TaskRunSummary,
  type TaskRunSummaryV1,
  type TaskSummary,
  type TaskTranscriptMessageVM,
} from "@nautilo/types";

/** Mobile has no protected Task key custody yet. Retain lifecycle, never invent text. */
export type MobileTaskSummary = TaskSummary | TaskContentSummaryV1;
export type MobileTaskDetail = TaskDetail | TaskContentDetailV1;
export type MobileTaskRun = TaskRunSummary | TaskRunSummaryV1;

export const MOBILE_PROTECTED_TASK_LABEL = "Encrypted Task — open in Browser or Desktop";
export const MOBILE_PROTECTED_TASK_DETAIL = "This Task's encrypted content is unavailable on this device.";

export type MobileTaskContentPresentation =
  | { readonly status: "ordinary"; readonly prompt: string }
  | { readonly status: "unsupported_client"; readonly prompt: typeof MOBILE_PROTECTED_TASK_LABEL };

export function mobileTaskSummaryContent(task: MobileTaskSummary): MobileTaskContentPresentation {
  if (!("content" in task)) return { status: "ordinary", prompt: task.prompt };
  if (task.content.status === "ordinary") {
    return { status: "ordinary", prompt: task.content.promptPreview };
  }
  return { status: "unsupported_client", prompt: MOBILE_PROTECTED_TASK_LABEL };
}

export function mobileTaskDefinitionContent(detail: MobileTaskDetail): MobileTaskContentPresentation & {
  readonly expectedOutput: string | null;
} {
  if (!("definition" in detail)) {
    return { status: "ordinary", prompt: detail.task.prompt, expectedOutput: detail.task.expectedOutput };
  }
  if (detail.definition.status === "ordinary") {
    return {
      status: "ordinary",
      prompt: detail.definition.prompt,
      expectedOutput: detail.definition.expectedOutput,
    };
  }
  return { status: "unsupported_client", prompt: MOBILE_PROTECTED_TASK_LABEL, expectedOutput: null };
}

export function mobileTaskRunContent(run: MobileTaskRun): Readonly<{
  status: "ordinary" | "unsupported_client";
  resultText: string | null;
  lastError: string | null;
}> {
  if (!("content" in run)) {
    return { status: "ordinary", resultText: run.resultText, lastError: run.lastError };
  }
  if (run.content.status === "ordinary") {
    return { status: "ordinary", resultText: run.content.resultText, lastError: run.content.lastError };
  }
  return { status: "unsupported_client", resultText: null, lastError: null };
}

export function mobileTaskTranscript(detail: MobileTaskDetail): TaskTranscriptMessageVM[] {
  if (!("definition" in detail)) return taskDetailTranscriptToPresentation(detail);
  if (detail.definition.status !== "ordinary") return [];
  const latest = detail.runs.at(-1);
  return latest?.content.status === "ordinary"
    ? taskRunTranscriptToPresentation(latest.content.transcript, latest.id)
    : [];
}

function httpStatus(error: unknown): number | null {
  return error !== null && typeof error === "object" && "status" in error
    && typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

/** A previous server may not expose the opt-in projection yet. */
export function isMissingTaskContentProjection(error: unknown): boolean {
  const status = httpStatus(error);
  return status === 404 || status === 405 || status === 501;
}
