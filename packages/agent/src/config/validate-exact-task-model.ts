/**
 * D429 Phase 3 — shared exact-task-model selection validation.
 *
 * One validator used by every Task entry surface (the `task` tool's
 * create/update, the intent shortcuts, and the HTTP route) AND by the dispatch
 * seam. Single-sources the locked D429 v1 contract:
 *
 *   - An exact `requestedModelId` is a STRICT pin (same-model retries only;
 *     Phase 4 enforces no cross-model fallback). It is mutually exclusive with
 *     the M152 selection profile/spec — passing both is a `conflict`.
 *   - Exact calls only accept curated IDs returned by `listResolvedCatalogModels`.
 *     Arbitrary dynamic `openrouter:` / `gateway:` values are invalid in v1
 *     even though `resolveCatalogModel` can synthesize a config for them; they
 *     are rejected as `unknown_model` via curated-list membership, not via the
 *     availability state.
 *   - `tools: []` (tool-free) may use a model whose tool capability is `null`
 *     (unknown); auto/whitelist tool use requires a CONFIRMED `tools === true`.
 *     A `false` or `null` capability never satisfies a positive tool
 *     requirement (Phase 0 strict capability truth).
 *   - Validation never attempts a paid provider call — the resolved catalog is
 *     pure / cache-backed (Phase 0; `tests/unit/resolved-catalog.test.ts` stubs
 *     `globalThis.fetch` to throw to prove it).
 *
 * Returns a typed failure (`code` + actionable `message`) or `null` when the
 * exact selection is satisfiable OR no exact id was requested (the caller then
 * falls through to the M152 profile/spec resolver). The dispatch seam throws a
 * stable, prefixed error from the same failure so the observer/report-back
 * path records it verbatim.
 */
import {
  listResolvedCatalogModels,
  resolveCatalogModel,
} from "./resolved-catalog";
import type { ResolvedCatalogModel } from "@nautilo/trust";
import type { SelectionProfile, ComboSpec } from "@nautilo/types";

export type ExactModelSelectionFailureCode =
  | "conflict"
  | "unknown_model"
  | "missing_credentials"
  | "routing_filtered"
  | "disabled"
  | "capability_mismatch";

export interface ExactModelSelectionFailure {
  code: ExactModelSelectionFailureCode;
  /** Stable, actionable, human-readable message (single-sourced per code). */
  message: string;
  /** The requested id, when an id was supplied. */
  modelId?: string;
}

export interface ValidateExactTaskModelInput {
  // `| undefined` on every optional so callers may pass `undefined` (e.g. a
  // Zod-inferred optional arg) under `exactOptionalPropertyTypes`.
  requestedModelId?: string | null | undefined;
  /** M152 Tier-1 intent. `balanced` (the default) is NOT a conflict. */
  profile?: SelectionProfile | null | undefined;
  /** M152 Tier-2 explicit override. */
  spec?: ComboSpec | null | undefined;
  /** Tools composition — drives the strict tool-capability check. */
  toolsMode?: "auto" | "none" | "whitelist" | undefined;
  toolsWhitelist?: string[] | undefined;
  /** Phase-0 routing opt-in (venice china-anonymized SKUs). */
  allowChinaUpstream?: boolean | undefined;
  /** Override the credential environment (tests / server injection). */
  env?: NodeJS.ProcessEnv | undefined;
}

/**
 * `null` when no exact id was requested (caller falls back to profile/spec).
 * Otherwise a failure or `null` (satisfiable).
 */
export function validateExactTaskModelSelection(
  input: ValidateExactTaskModelInput,
): ExactModelSelectionFailure | null {
  const requestedModelId = normalizeId(input.requestedModelId);
  if (requestedModelId === null) return null;

  // 1. Mutual-exclusion with the M152 selection intent. `balanced` is the
  //    default no-op (not a real selection), so it is allowed alongside a pin.
  if (hasNonDefaultSelection(input.profile, input.spec)) {
    return {
      code: "conflict",
      modelId: requestedModelId,
      message:
        `Cannot combine an exact model_id ("${requestedModelId}") with a ` +
        `model_selection_profile / model_selection_spec. Pass one or the ` +
        `other: model_id is a strict pin; the profile/spec is a bias. ` +
        `Drop model_id to bias, or drop the profile/spec to pin.`,
    };
  }

  // 2. Curated membership. v1 exact calls only accept curated IDs returned by
  //    listResolvedCatalogModels; dynamic openrouter:/gateway: ids are rejected
  //    here even though resolveCatalogModel can synthesize a config for them.
  const options = {
    includeUnavailable: true,
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.allowChinaUpstream !== undefined
      ? { allowChinaUpstream: input.allowChinaUpstream }
      : {}),
  } as const;
  const curated = listResolvedCatalogModels(options);
  const curatedRow = curated.find((r) => r.id === requestedModelId);
  if (!curatedRow) {
    return {
      code: "unknown_model",
      modelId: requestedModelId,
      message:
        `Unknown model_id "${requestedModelId}". Exact task model selection ` +
        `only accepts curated model ids returned by the discover_models ` +
        `tool (list/get). Dynamic openrouter:/gateway: ids are not ` +
        `accepted in v1. Run discover_models to copy the exact stable id.`,
    };
  }

  // 3. Availability (credentials / routing / disabled), evaluated separately
  //    from membership so the message distinguishes each failure.
  const row: ResolvedCatalogModel = resolveCatalogModel(
    requestedModelId,
    options,
  );
  switch (row.availability) {
    case "selectable":
      break;
    case "missing_credentials":
      return {
        code: "missing_credentials",
        modelId: requestedModelId,
        message:
          `Model "${requestedModelId}" has no runnable credentials configured ` +
          `(${row.unavailableReason ?? "required provider API key not set"}). ` +
          `Ask a server administrator to configure that provider, or pick a different model_id.`,
      };
    case "routing_filtered":
      return {
        code: "routing_filtered",
        modelId: requestedModelId,
        message:
          `Model "${requestedModelId}" is routing-filtered ` +
          `(${row.unavailableReason ?? "routing policy"}). It cannot be ` +
          `selected without the matching routing opt-in.`,
      };
    case "disabled":
      return {
        code: "disabled",
        modelId: requestedModelId,
        message:
          `Model "${requestedModelId}" is disabled in the catalog ` +
          `(${row.unavailableReason ?? "catalog row disabled"}). Pick a ` +
          `different model_id.`,
      };
    case "unknown_model":
      return {
        code: "unknown_model",
        modelId: requestedModelId,
        message:
          `Unknown model_id "${requestedModelId}". Run discover_models to ` +
          `copy the exact stable curated id.`,
      };
  }

  // 4. Strict tool-capability truth. Tool-FREE tasks (tools_mode "none" or an
  //    empty whitelist) may use a model whose tool capability is unknown
  //    (`null`). Tool-USING tasks (auto, or a non-empty whitelist) require a
  //    CONFIRMED `tools === true`; `null`/`false` never satisfies it.
  if (taskRequiresTools(input.toolsMode, input.toolsWhitelist)) {
    if (row.features.tools !== true) {
      return {
        code: "capability_mismatch",
        modelId: requestedModelId,
        message:
          `Model "${requestedModelId}" does not support tool/function ` +
          `calling (capability is ${describeCapability(
            row.features.tools,
          )}). Tool-using tasks require a model with confirmed tool support; ` +
          `pass tools: [] for a tool-free run, or pick a model_id that ` +
          `supports tools.`,
      };
    }
  }

  return null;
}

/**
 * Dispatch-seam variant: throws a stable, prefixed error from the same
 * failure so the observer/report-back path records it verbatim (mirrors the
 * M152 `[task-model-selection]` prefix contract).
 */
export function assertExactTaskModelSelection(
  input: ValidateExactTaskModelInput,
): void {
  const failure = validateExactTaskModelSelection(input);
  if (failure) {
    throw new Error(
      `[task-model-selection] exact model_id "${failure.modelId ?? "?"}" ` +
        `rejected: ${failure.message}`,
    );
  }
}

function normalizeId(id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const trimmed = id.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function hasNonDefaultSelection(
  profile: SelectionProfile | null | undefined,
  spec: ComboSpec | null | undefined,
): boolean {
  if (spec != null) return true;
  return profile != null && profile !== "balanced";
}

function taskRequiresTools(
  toolsMode: "auto" | "none" | "whitelist" | undefined,
  toolsWhitelist: string[] | undefined,
): boolean {
  if (toolsMode === "none") return false;
  if (toolsMode === "whitelist") {
    return (toolsWhitelist?.length ?? 0) > 0;
  }
  // "auto" (the default) and undefined both mean "full tool set" → tools required.
  return true;
}

function describeCapability(value: boolean | null): string {
  if (value === true) return "supported";
  if (value === false) return "confirmed unsupported";
  return "unknown";
}
