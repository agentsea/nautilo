import type { AssistantModelSummary } from "@nautilo/api-client/browser";

export interface ModelDefaultDisplay {
  readonly id: string | null;
  readonly label: string;
  readonly detail: string;
  readonly selectable: boolean;
}

export interface ModelPickerRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly selectable: boolean;
  readonly selected: boolean;
}

export interface ModelPickerGroup {
  readonly id: string;
  readonly label: string;
  readonly rows: readonly ModelPickerRow[];
}

/** A model can be written as an Agent default only when the catalogue says so. */
export function isSelectableModel(model: AssistantModelSummary): boolean {
  return model.enabled && (model.availability === undefined || model.availability === "selectable");
}

/**
 * Retains a currently persisted ID even when the latest catalogue no longer
 * knows it. This is display-only; unknown or unavailable values cannot be
 * re-saved from mobile.
 */
export function modelDefaultDisplay(
  defaultModel: string | null,
  models: readonly AssistantModelSummary[],
): ModelDefaultDisplay {
  if (defaultModel === null) {
    return {
      id: null,
      label: "Server default",
      detail: "Your Agent inherits this server's current default model.",
      selectable: true,
    };
  }
  const model = models.find((candidate) => candidate.id === defaultModel);
  if (!model) {
    return {
      id: defaultModel,
      label: defaultModel,
      detail: "This saved model ID is no longer in this server's catalogue. Choose an available model or reset to the server default.",
      selectable: false,
    };
  }
  if (!isSelectableModel(model)) {
    return {
      id: model.id,
      label: model.displayName || model.id,
      detail: unavailableDescription(model),
      selectable: false,
    };
  }
  return {
    id: model.id,
    label: model.displayName || model.id,
    detail: `${model.id} · ${providerLabel(model)}`,
    selectable: true,
  };
}

/** Groups catalogue rows by the server-provided provider family after search. */
export function modelPickerGroups(
  models: readonly AssistantModelSummary[],
  query: string,
  selectedId: string | null,
): readonly ModelPickerGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  const matching = models.filter((model) => {
    if (!needle) return true;
    return [model.id, model.displayName, model.provider ?? ""].some((value) =>
      value.toLocaleLowerCase().includes(needle),
    );
  });
  const byProvider = new Map<string, AssistantModelSummary[]>();
  for (const model of matching) {
    const provider = providerLabel(model);
    const group = byProvider.get(provider) ?? [];
    group.push(model);
    byProvider.set(provider, group);
  }
  return [...byProvider.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, entries]) => ({
      id: provider.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-"),
      label: provider,
      rows: entries
        .slice()
        .sort((left, right) => left.priority - right.priority || left.displayName.localeCompare(right.displayName))
        .map((model) => ({
          id: model.id,
          label: model.displayName || model.id,
          description: isSelectableModel(model)
            ? `${model.id} · ${provider}`
            : `${model.id} · ${unavailableDescription(model)}`,
          selectable: isSelectableModel(model),
          selected: model.id === selectedId,
        })),
    }));
}

function unavailableDescription(model: AssistantModelSummary): string {
  return model.unavailableReason?.trim()
    || (model.availability === "missing-key"
      ? "Unavailable: this server is missing the required provider key."
      : model.availability === "filtered"
        ? "Unavailable under this server's current policy."
        : "Unavailable on this server.");
}

function providerLabel(model: AssistantModelSummary): string {
  return model.provider?.trim() || model.id.split(":", 1)[0] || "Other";
}
