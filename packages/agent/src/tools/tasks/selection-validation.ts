/**
 * M152 / D429 Phase 3 — shared create-time guard for task model selection.
 *
 * Every task-creation surface (the `task` tool's create/update, the intent
 * shortcuts, and the HTTP route via `@nautilo/agent`) funnels through this one
 * helper so the actionable error message is single-sourced and the validation
 * logic is exercised once, not per-surface.
 *
 * Two selection modes, mutually exclusive:
 *   - exact `requestedModelId` (D429 Phase 3) — a strict pin validated by
 *     {@link validateExactTaskModelSelection} (curated IDs only; capability
 *     truth; never a paid call).
 *   - M152 profile/spec — a bias over the privacy/smart/cheap axes, validated
 *     by {@link validateTaskModelSelection}.
 *
 * Returns a user-facing message when the selection can't be satisfied, else
 * `null`. `balanced` / no-selection always passes. When an exact id is
 * supplied, the exact validator owns the decision (including the
 * mutual-exclusion conflict with profile/spec); the profile/spec resolver is
 * not run.
 */
import { getDefaultModel } from "../../config/assistant-models";
import {
  validateTaskModelSelection,
  type ResolveTaskModelInput,
} from "../../config/resolve-task-model";
import {
  validateExactTaskModelSelection,
  type ValidateExactTaskModelInput,
} from "../../config/validate-exact-task-model";
import type { SelectionProfile, ComboSpec } from "@nautilo/types";

/**
 * M152-only guard (no exact id). Kept for callers that have already split on
 * `requestedModelId` absence and for the existing M152 tests.
 */
export function validateTaskSelectionForCreate(
  profile: SelectionProfile | null | undefined,
  spec?: ComboSpec | null,
  options: Readonly<Pick<ResolveTaskModelInput, "env" | "purpose" | "runnableModelIds"> & {
    baseModelId?: string;
  }> = {},
): string | null {
  if ((profile == null || profile === "balanced") && spec == null) return null;
  const failure = validateTaskModelSelection({
    baseModelId: options.baseModelId ?? getDefaultModel().id,
    profile: profile ?? null,
    spec: spec ?? null,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.runnableModelIds === undefined ? {} : { runnableModelIds: options.runnableModelIds }),
  });
  return failure ? failure.message : null;
}

export type ValidateTaskModelSelectionForCreateInput = ValidateExactTaskModelInput &
  Readonly<{
    baseModelId?: string;
    purpose?: "chat" | "task-tools";
    runnableModelIds?: readonly string[];
  }>;

/**
 * D429 Phase 3 — combined create/update guard. Single-sources the message for
 * BOTH selection modes and the mutual-exclusion conflict between them. This is
 * the one the `task` tool, shortcuts, and HTTP route call before persistence.
 */
export function validateTaskModelSelectionForCreate(
  input: ValidateTaskModelSelectionForCreateInput,
): string | null {
  if (input.requestedModelId !== null && input.requestedModelId !== undefined) {
    const exact = validateExactTaskModelSelection(input);
    return exact ? exact.message : null;
  }
  return validateTaskSelectionForCreate(input.profile, input.spec, {
    ...(input.baseModelId === undefined ? {} : { baseModelId: input.baseModelId }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.runnableModelIds === undefined ? {} : { runnableModelIds: input.runnableModelIds }),
  });
}
