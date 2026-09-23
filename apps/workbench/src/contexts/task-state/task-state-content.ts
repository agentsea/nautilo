import type { TaskContentListV1, TaskSummary } from "@nautilo/types";
import type { NautiloApiClient } from "@nautilo/api-client/browser";

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

function isMissingContentProjection(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 404 || status === 405 || status === 501;
}

/** Current projection first; only an absent endpoint permits legacy fallback. */
export async function listTaskStateSummaries(
  client: TaskStateContentClient,
): Promise<TaskSummary[]> {
  const query = { includeTerminal: true } as const;
  try {
    return ordinaryTaskSummariesFromContentV1(
      await client.listTaskContentV1(query),
    );
  } catch (error) {
    if (!isMissingContentProjection(error)) throw error;
    return client.listTasks(query);
  }
}
