import type { AssistantModelSummary } from "@nautilo/api-client/browser";
import type { ModelControlSelection } from "@nautilo/types";

export type RoomReasoningEffort = NonNullable<ModelControlSelection["reasoningEffort"]>;
export type RoomModelControlSelection = ModelControlSelection;

type ControlPanel = "model" | "reasoning" | "serving";

type Controls = NonNullable<AssistantModelSummary["controls"]>;

function formatEffort(effort: string | undefined): string {
  if (!effort) return "Default";
  return effort === "off" ? "Off" : `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}

function formatRate(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}/M`;
}

export function defaultRoomModelControlSelection(
  model: AssistantModelSummary,
): RoomModelControlSelection {
  const controls = model.controls;
  return {
    modelId: model.id,
    ...(controls?.reasoning ? { reasoningEffort: controls.reasoning.defaultLevel } : {}),
    ...(controls?.serving ? { servingProfileId: controls.serving.defaultProfile } : {}),
  };
}

/**
 * Rebuild a Room-local selection against the current model's published controls.
 * A value from another model is never carried into the next provider request.
 */
export function normalizeRoomModelControlSelection(
  model: AssistantModelSummary,
  selection: RoomModelControlSelection | null | undefined,
): RoomModelControlSelection {
  const defaults = defaultRoomModelControlSelection(model);
  if (!selection || selection.modelId !== model.id) return defaults;

  const reasoning = model.controls?.reasoning;
  const serving = model.controls?.serving;
  const reasoningEffort = selection.reasoningEffort;
  const servingProfileId = selection.servingProfileId;
  const validReasoning =
    reasoning !== undefined &&
    reasoningEffort !== undefined &&
    (reasoningEffort === "off"
      ? reasoning.canDisable && !reasoning.mandatory
      : reasoning.levels.includes(reasoningEffort));
  const validServing =
    serving !== undefined &&
    servingProfileId !== undefined &&
    serving.profiles.some((profile) => profile.id === servingProfileId);

  return {
    modelId: model.id,
    ...(reasoning
      ? { reasoningEffort: validReasoning ? reasoningEffort : reasoning.defaultLevel }
      : {}),
    ...(serving
      ? { servingProfileId: validServing ? servingProfileId : serving.defaultProfile }
      : {}),
  };
}

export function hasReasoningPicker(controls: Controls | undefined): boolean {
  return controls?.reasoning !== undefined &&
    (controls.reasoning.levels.length > 0 || (controls.reasoning.canDisable && !controls.reasoning.mandatory));
}

export function hasServingPicker(controls: Controls | undefined): boolean {
  return (controls?.serving?.profiles.length ?? 0) > 1;
}

export function ModelControlRows({
  currentPanel,
  model,
  selection,
  onPanelChange,
}: {
  currentPanel: ControlPanel;
  model: AssistantModelSummary | null;
  selection: RoomModelControlSelection | null;
  onPanelChange: (panel: ControlPanel) => void;
}) {
  const controls = model?.controls;
  const servingProfile = controls?.serving?.profiles.find(
    (profile) => profile.id === selection?.servingProfileId,
  );

  return (
    <div className="border-b border-border/60 p-1" aria-label="Model controls">
      <ControlRow
        active={currentPanel === "model"}
        label="Model"
        value={model?.displayName ?? "Model"}
        onClick={() => onPanelChange("model")}
      />
      {hasReasoningPicker(controls) ? (
        <ControlRow
          active={currentPanel === "reasoning"}
          label="Effort"
          value={formatEffort(selection?.reasoningEffort ?? controls?.reasoning?.defaultLevel)}
          onClick={() => onPanelChange("reasoning")}
        />
      ) : null}
      {hasServingPicker(controls) ? (
        <ControlRow
          active={currentPanel === "serving"}
          label="Serving"
          value={servingProfile?.label ?? "Default"}
          onClick={() => onPanelChange("serving")}
        />
      ) : null}
    </div>
  );
}

function ControlRow({
  active,
  label,
  value,
  onClick,
}: {
  active: boolean;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={[
        "flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs transition-colors",
        active ? "bg-background-element text-foreground" : "text-foreground-muted hover:bg-background-element",
      ].join(" ")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="max-w-40 truncate text-foreground">{value} ›</span>
    </button>
  );
}

export function ReasoningOptions({
  model,
  selection,
  disabled,
  onSelect,
}: {
  model: AssistantModelSummary;
  selection: RoomModelControlSelection;
  disabled: boolean;
  onSelect: (effort: RoomReasoningEffort) => void;
}) {
  const reasoning = model.controls?.reasoning;
  if (!reasoning) return null;
  const options = [
    ...reasoning.levels,
    ...(reasoning.canDisable && !reasoning.mandatory ? ["off"] : []),
  ] as RoomReasoningEffort[];
  return (
    <div role="listbox" aria-label="Reasoning effort" className="min-h-0 flex-1 overflow-y-auto p-1">
      {options.map((effort) => (
        <ChoiceRow
          key={effort}
          selected={selection.reasoningEffort === effort}
          disabled={disabled}
          label={formatEffort(effort)}
          description={effort === "off" ? "Disable reasoning for this Room" : undefined}
          onClick={() => onSelect(effort)}
        />
      ))}
    </div>
  );
}

export function ServingOptions({
  model,
  selection,
  disabled,
  onSelect,
}: {
  model: AssistantModelSummary;
  selection: RoomModelControlSelection;
  disabled: boolean;
  onSelect: (profileId: string) => void;
}) {
  const profiles = model.controls?.serving?.profiles ?? [];
  return (
    <div role="listbox" aria-label="Serving profile" className="min-h-0 flex-1 overflow-y-auto p-1">
      {profiles.map((profile) => (
        <ChoiceRow
          key={profile.id}
          selected={selection.servingProfileId === profile.id}
          disabled={disabled}
          label={profile.label}
          description={[
            profile.description,
            profile.pricing
              ? `Input ${formatRate(profile.pricing.inputPerMtok)} · Cached ${formatRate(profile.pricing.cachedInputPerMtok)} · Output ${formatRate(profile.pricing.outputPerMtok)}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
          onClick={() => onSelect(profile.id)}
        />
      ))}
    </div>
  );
}

function ChoiceRow({
  selected,
  disabled,
  label,
  description,
  onClick,
}: {
  selected: boolean;
  disabled: boolean;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex w-full items-start gap-2 rounded px-2 py-2 text-left text-sm transition-colors disabled:cursor-wait disabled:opacity-50",
        selected ? "bg-[var(--primary-muted)]" : "hover:bg-background-element",
      ].join(" ")}
    >
      <span aria-hidden className="w-4 shrink-0 text-primary">
        {selected ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">{label}</span>
        {description ? <span className="mt-0.5 block text-[11px] text-foreground-muted">{description}</span> : null}
      </span>
    </button>
  );
}
