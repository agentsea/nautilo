import {
  foregroundModelControlPlanFromSnapshot,
  getAgentExecutionConfigById,
  getDefaultModel,
  loadForegroundModelControlSnapshot,
} from "@nautilo/agent";
import { resolveModelFunding } from "./model-funding";

interface PreflightDeps {
  loadSnapshot: typeof loadForegroundModelControlSnapshot;
  getExecutionConfig: typeof getAgentExecutionConfigById;
  defaultModel: typeof getDefaultModel;
  resolveFunding: typeof resolveModelFunding;
}

/** Project the executor's selected model before auxiliary work can spend.
 * This is not a funded session; dispatch still rechecks live authority. */
export async function resolveForegroundChatPreflightFunding(
  input: Readonly<{
    humanUserId: string;
    roomId: string;
    agentId: string;
    turnModelId: string | null;
  }>,
  deps: PreflightDeps = {
    loadSnapshot: loadForegroundModelControlSnapshot,
    getExecutionConfig: getAgentExecutionConfigById,
    defaultModel: getDefaultModel,
    resolveFunding: resolveModelFunding,
  },
) {
  const snapshot = await deps.loadSnapshot(input.roomId, input.agentId, input.turnModelId);
  const profile = await deps.getExecutionConfig(input.agentId).catch(() => null);
  const plan = foregroundModelControlPlanFromSnapshot(snapshot, () =>
    input.turnModelId || profile?.defaultModel || deps.defaultModel().id,
  );
  return deps.resolveFunding({
    humanUserId: input.humanUserId,
    modelId: plan.initialModelId,
    workload: "foreground_text_chat",
  });
}
