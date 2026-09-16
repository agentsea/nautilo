import type { LiveDirectMutationExtension } from "./live-review-extension-registry";
import { validateStaleDesignMutation } from "../../../first-party-apps/design/src/agent-tool-handlers";

/**
 * Trusted, boot-time declaration of Design's live tool family. The manifest
 * still has to opt in and declare matching tools; it cannot nominate this
 * extension or add arbitrary live handlers.
 */
export const designLiveToolExtension: LiveDirectMutationExtension = {
  appId: "nautilo-design",
  mode: "direct_mutation",
  liveToolIds: ["inspect-open-design", "edit-open-design"],
  taskDelegation: { mode: "direct_only" },
  directMutationToolIds: ["edit-open-design"],
  hostOwnsSessionBinding: true,
  hostOwnsIdempotencyKey: true,
  rebaseStaleDirectMutation: validateStaleDesignMutation,
  guidance:
    "Use the active Design session only. Inspect before editing and include the inspection-issued semantic preconditions in each edit. The host owns the active session binding and idempotency bookkeeping, including exact lost-response replay. It automatically handles disjoint/create stale recovery from frozen preconditions with no second model call or approval, applying only the exact approved batch against the current binding. Changed dependencies return semantic_conflict with stateChanged false, retrySafe false, and recovery action ask_user/refresh_intent; never overwrite automatically. Edit operations apply atomically to the open design and return a receipt.",
};
