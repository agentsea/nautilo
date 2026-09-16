import type { AssistantModelSummary } from '@nautilo/api-client/browser';

/** Local projection only; the server remains authoritative for eligibility. */
export function filterModelCatalogue(
  models: readonly AssistantModelSummary[],
  query: string,
): AssistantModelSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...models];
  return models.filter((model) => {
    const searchable = `${model.displayName} ${model.provider ?? ''} ${model.id}`.toLocaleLowerCase();
    return searchable.includes(normalized);
  });
}
