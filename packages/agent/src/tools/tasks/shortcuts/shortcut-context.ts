/**
 * M144 — shared context extraction for the Phase 3 intent shortcuts
 * (`in_scope` / `in_private_namespace` / `in_background`). Mirrors the
 * `task` tool's `contextFromUnknown` (task-tool.ts): the tool factory receives
 * an opaque `context`; we pull the owner / agent / room ids the shortcut needs
 * to build a `TaskCreateInput`. No business logic lives here.
 */
import { z } from "zod";
import { SELECTION_PROFILES, type ResolvedFocusedResource } from "@nautilo/types";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { OrdinaryContentAccessExecution } from "../../../runtime/ordinary-content-access";
import { causalHumanForExecution } from "../../../runtime/causal-human-context";

export interface ShortcutContext {
  ownerId: string;
  causalHumanUserId: string;
  agentId: string;
  roomId: string;
  /** Exact Desktop Current Folder captured for this turn, when present. */
  currentFolder: string;
  timezone: string;
  turnId: string;
  memoryAccessEnvelope: MemoryAccessEnvelope | null;
  focusedResources: readonly ResolvedFocusedResource[];
  /** Server-authored Task/TaskRun identity when this tool runs inside a Task. */
  currentTaskId: string;
  ordinaryContentAccessRequired: boolean;
  ordinaryContentAccess?: OrdinaryContentAccessExecution;
}

/**
 * M152 — the shared `model_selection` param every intent shortcut accepts.
 * Defaults to `balanced` (the saved Agent model, then the server chat default
 * when that Agent follows the default). Room overrides stay foreground-only.
 * When the user asks to prioritize privacy / cost / smartness, the agent sets
 * a profile.
 */
export const modelSelectionParam = z
  .enum(SELECTION_PROFILES)
  .optional()
  .describe(
    "Bias which model runs this task. 'balanced' (default) inherits the saved Agent model setting, then the server chat default when the Agent uses Follow default. A Room model override is separate and is not inherited; use model_id when this task needs an exact model. Singles: 'most_private' / 'smartest' / 'cheapest'. Pairs '<X>_<Y>' = qualify by X then optimize Y (e.g. 'private_cheap', 'smart_cheap'). Picks the best CONFIGURED model; a private_* profile errors when no private-enough model is configured.",
  );

/**
 * D429 Phase 3 — shared exact-model pin param every intent shortcut accepts.
 * Mutually exclusive with {@link modelSelectionParam}: pass model_id OR a
 * model_selection bias, never both. Genie must first call `discover_models`
 * and copy the exact stable curated id; only curated ids are accepted in v1.
 * Kept as one named helper so the description is single-sourced across every
 * shortcut (no per-tool duplication).
 */
export const modelIdParam = z
  .string()
  .nullable()
  .optional()
  .describe(
    "Pin the EXACT model this task's run will use (strict same-model pin, no cross-model fallback). First call `discover_models` and copy the EXACT stable curated model id it returns; do not guess. Only curated ids are accepted in v1 (dynamic openrouter:/gateway: ids are rejected). Mutually exclusive with model_selection — pass model_id OR a model_selection bias, never both. A tool-using task requires a model with confirmed tool support; pass tools: [] for a tool-free run.",
  );

export function shortcutContextFromUnknown(ctx: unknown): ShortcutContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const ownerId =
    typeof c["ownerId"] === "string"
      ? c["ownerId"]
      : typeof c["userId"] === "string"
        ? c["userId"]
        : "";
  return {
    ownerId,
    causalHumanUserId: causalHumanForExecution(
      typeof c["causalHumanUserId"] === "string" ? c["causalHumanUserId"] : "",
    ),
    agentId: typeof c["agentId"] === "string" ? c["agentId"] : "",
    roomId: typeof c["roomId"] === "string" ? c["roomId"] : "",
    currentFolder:
      typeof c["currentFolder"] === "string" ? c["currentFolder"] : "",
    timezone: typeof c["userTimezone"] === "string" ? c["userTimezone"] : "",
    turnId: typeof c["turnId"] === "string" ? c["turnId"] : "",
    memoryAccessEnvelope:
      c["memoryAccessEnvelope"] && typeof c["memoryAccessEnvelope"] === "object"
        ? c["memoryAccessEnvelope"] as MemoryAccessEnvelope
        : null,
    focusedResources: Array.isArray(c["focusedResources"])
      ? c["focusedResources"] as ResolvedFocusedResource[]
      : [],
    currentTaskId: typeof c["currentTaskId"] === "string" ? c["currentTaskId"] : "",
    ordinaryContentAccessRequired: c["ordinaryContentAccessRequired"] === true,
    ...(c["ordinaryContentAccess"] && typeof c["ordinaryContentAccess"] === "object"
      && typeof (c["ordinaryContentAccess"] as { commit?: unknown }).commit === "function"
      ? { ordinaryContentAccess: c["ordinaryContentAccess"] as OrdinaryContentAccessExecution }
      : {}),
  };
}
