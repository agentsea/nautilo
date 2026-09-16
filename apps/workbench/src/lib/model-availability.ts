import type { AssistantModelSummary } from "@nautilo/api-client/browser";

export function isSelectableModel(model: AssistantModelSummary): boolean {
  return model.availability === undefined || model.availability === "selectable";
}

export function mergeModelRows(
  runnable: readonly AssistantModelSummary[],
  retained: readonly AssistantModelSummary[],
): AssistantModelSummary[] {
  const byId = new Map(runnable.map((model) => [model.id, model]));
  for (const model of retained) byId.set(model.id, model);
  return Array.from(byId.values()).sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );
}
