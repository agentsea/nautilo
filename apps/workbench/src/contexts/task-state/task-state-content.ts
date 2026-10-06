import type {
  TaskContentListV1,
  TaskContentSummaryV1,
  TaskSummary,
} from "@nautilo/types";
import { ApiError, type NautiloApiClient } from "@nautilo/api-client/browser";
import type { ConversationEncryptionPolicyMode } from
  "../../adapters/runtime-contexts";

type TaskStateContentClient = Pick<
  NautiloApiClient,
  "listTaskContentV1" | "listTasks"
>;

/**
 * The established Workbench Task store is a plaintext presentation cache.
 * Keep ordinary rows byte-for-byte compatible while refusing to manufacture
 * prompt/error text for protected or temporarily unavailable definitions.
 */
export function ordinaryTaskSummariesFromContentV1(
  rows: TaskContentListV1,
): TaskSummary[] {
  const summaries: TaskSummary[] = [];
  for (const row of rows) {
    if (row.content.status !== "ordinary") continue;
    const { content, ...lifecycle } = row;
    summaries.push({
      ...lifecycle,
      prompt: content.promptPreview,
      lastError: content.lastError,
    });
  }
  return summaries;
}

export type TaskStateRecord = TaskSummary | TaskContentSummaryV1;

export function isOrdinaryTaskStateRecord(
  task: TaskStateRecord,
): task is TaskSummary {
  return !("content" in task);
}

/**
 * Keep protected/unavailable rows as lifecycle-only records. Ordinary rows
 * retain the legacy shape so existing Plain consumers remain byte-compatible.
 */
export function taskStateRecordsFromContentV1(
  rows: TaskContentListV1,
): TaskStateRecord[] {
  return rows.map((row) => {
    if (row.content.status !== "ordinary") return row;
    const { content, ...lifecycle } = row;
    return {
      ...lifecycle,
      prompt: content.promptPreview,
      lastError: content.lastError,
    };
  });
}

function isMissingContentProjection(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 405 || status === 501;
}

/** Plain takes the legacy route unless stored protected rows require the safe projection. */
export async function listTaskStateSummaries(
  client: TaskStateContentClient,
  mode: ConversationEncryptionPolicyMode,
): Promise<TaskStateRecord[]> {
  const query = { includeTerminal: true } as const;
  if (mode === "plaintext_only") {
    try {
      return await client.listTasks(query);
    } catch (error) {
      if (!(error instanceof ApiError)
        || error.status !== 409
        || error.message !== "task_content_requires_current_client") throw error;
      return taskStateRecordsFromContentV1(await client.listTaskContentV1(query));
    }
  }
  if (mode === "unknown") return [];
  try {
    return taskStateRecordsFromContentV1(await client.listTaskContentV1(query));
  } catch (error) {
    if (!isMissingContentProjection(error)) throw error;
    return client.listTasks(query);
  }
}
