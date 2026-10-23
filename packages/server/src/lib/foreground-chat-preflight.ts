import {
  foregroundModelControlPlanFromSnapshot,
  getAgentExecutionConfigById,
  getDefaultForegroundAgentModelId,
  hydrateSurplusChatCatalog,
  loadForegroundModelControlSnapshot,
  resolveProviderKey,
} from "@nautilo/agent";
import { getCachedServerModelConfigRow } from "@nautilo/db";
import { resolveModelFunding } from "./model-funding";

export interface ForegroundChatPreflightDeps {
  loadSnapshot: typeof loadForegroundModelControlSnapshot;
  getExecutionConfig: typeof getAgentExecutionConfigById;
  defaultForegroundModelId: typeof getDefaultForegroundAgentModelId;
  resolveFunding: typeof resolveModelFunding;
  hydrateSurplusChatCatalog?: typeof hydrateSurplusChatCatalog;
  getPreferSurplus?: () => boolean;
  getSurplusKeyConfigured?: () => boolean;
}

/** @internal Stable production wiring, exported for an identity-level unit assertion. */
export const DEFAULT_FOREGROUND_CHAT_PREFLIGHT_DEPS = Object.freeze({
  loadSnapshot: loadForegroundModelControlSnapshot,
  getExecutionConfig: getAgentExecutionConfigById,
  defaultForegroundModelId: getDefaultForegroundAgentModelId,
  resolveFunding: resolveModelFunding,
  hydrateSurplusChatCatalog,
  getPreferSurplus: () => getCachedServerModelConfigRow()?.preferSurplus === true,
  getSurplusKeyConfigured: () => resolveProviderKey("surplus") !== null,
}) satisfies ForegroundChatPreflightDeps;

/** Project the executor's selected model before auxiliary work can spend.
 * This is not a funded session; dispatch still rechecks live authority. */
export async function resolveForegroundChatPreflightModelId(
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
  if (!input.turnModelId && !snapshot.roomSelection?.modelId
    && !snapshot.agentSelection?.modelId && !profile?.defaultModel
    && deps.getPreferSurplus?.() === true
    && deps.getSurplusKeyConfigured?.() === true
    && deps.hydrateSurplusChatCatalog) {
    try {
      await deps.hydrateSurplusChatCatalog();
    } catch {
      // The synchronous default resolver remains fail-closed on the last
      // verified map and can still select a directly credentialed model.
    }
  }
  const plan = foregroundModelControlPlanFromSnapshot(snapshot, () =>
    input.turnModelId || profile?.defaultModel || deps.defaultForegroundModelId(),
  );
  return plan.initialModelId;
}

export async function resolveForegroundChatPreflightFunding(
  input: Readonly<{ humanUserId: string; roomId: string; agentId: string; turnModelId: string | null }>,
  deps: ForegroundChatPreflightDeps = DEFAULT_FOREGROUND_CHAT_PREFLIGHT_DEPS,
) {
  const modelId = await resolveForegroundChatPreflightModelId(input, deps);
  return deps.resolveFunding({
    humanUserId: input.humanUserId,
    modelId,
    workload: "foreground_text_chat",
  });
}
