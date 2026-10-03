import {
  foregroundModelControlPlanFromSnapshot,
  getAgentExecutionConfigById,
  getDefaultForegroundAgentModelId,
  loadForegroundModelControlSnapshot,
} from "@nautilo/agent";
import { resolveModelFunding } from "./model-funding";

export interface ForegroundChatPreflightDeps {
  loadSnapshot: typeof loadForegroundModelControlSnapshot;
  getExecutionConfig: typeof getAgentExecutionConfigById;
  defaultForegroundModelId: typeof getDefaultForegroundAgentModelId;
  resolveFunding: typeof resolveModelFunding;
}

/** @internal Stable production wiring, exported for an identity-level unit assertion. */
export const DEFAULT_FOREGROUND_CHAT_PREFLIGHT_DEPS = Object.freeze({
  loadSnapshot: loadForegroundModelControlSnapshot,
  getExecutionConfig: getAgentExecutionConfigById,
  defaultForegroundModelId: getDefaultForegroundAgentModelId,
  resolveFunding: resolveModelFunding,
}) satisfies ForegroundChatPreflightDeps;

/** Project the executor's selected model before auxiliary work can spend.
 * This is not a funded session; dispatch still rechecks live authority. */
export async function resolveForegroundChatPreflightFunding(
  input: Readonly<{
    humanUserId: string;
    roomId: string;
    agentId: string;
    turnModelId: string | null;
  }>,
  deps: ForegroundChatPreflightDeps = DEFAULT_FOREGROUND_CHAT_PREFLIGHT_DEPS,
) {
  const snapshot = await deps.loadSnapshot(input.roomId, input.agentId, input.turnModelId);
  const profile = await deps.getExecutionConfig(input.agentId).catch(() => null);
  const plan = foregroundModelControlPlanFromSnapshot(snapshot, () =>
    input.turnModelId || profile?.defaultModel || deps.defaultForegroundModelId(),
  );
  return deps.resolveFunding({
    humanUserId: input.humanUserId,
    modelId: plan.initialModelId,
    workload: "foreground_text_chat",
  });
}
