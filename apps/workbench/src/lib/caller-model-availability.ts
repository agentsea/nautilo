import type { AssistantModelSummary } from "@nautilo/api-client/browser";
import { isSelectableModel } from "./model-availability";

export const PERSONAL_PROVIDER_CREDENTIALS_CHANGED_EVENT =
  "nautilo:personal-provider-credentials-changed";

interface CallerModelClient {
  getCallerModels(query: { includeUnavailable: true }): Promise<AssistantModelSummary[]>;
  resolveRetainedModels(ids: readonly string[]): Promise<AssistantModelSummary[]>;
}

/**
 * Load the server-authoritative caller catalogue and supplement it only for
 * saved IDs no longer represented by that catalogue. Generic retained-model
 * resolution can describe an old choice, but it cannot make that choice
 * runnable for the current Human.
 */
export async function loadCallerModelRows(
  client: CallerModelClient,
  retainedIds: readonly string[],
): Promise<AssistantModelSummary[]> {
  const callerRows = await client.getCallerModels({ includeUnavailable: true });
  const callerIds = new Set(callerRows.map((model) => model.id));
  const missingIds = [...new Set(retainedIds)].filter((id) => !callerIds.has(id));
  const genericRetained = missingIds.length > 0
    ? await client.resolveRetainedModels(missingIds)
    : [];
  const byId = new Map<string, AssistantModelSummary>();
  for (const model of genericRetained) {
    byId.set(model.id, isSelectableModel(model)
      ? {
          ...model,
          availability: "filtered",
          unavailableReason: "This saved model is not available for your account.",
        }
      : model);
  }
  for (const model of callerRows) byId.set(model.id, model);
  return [...byId.values()].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );
}
