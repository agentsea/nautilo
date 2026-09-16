import { AsyncLocalStorage } from "node:async_hooks";
import type { NautiloState } from "../agent/state";

/**
 * Trusted destination for a background Deep Research report. The model never
 * supplies these values: the foreground tools node derives them from its
 * accepted Room turn and carries them out-of-band to the job admission hook.
 */
export interface DeepResearchReturnContext {
  readonly ownerId: string;
  readonly requestorId: string;
  readonly roomId: string;
  readonly laneKey: string;
  readonly agentId: string;
  readonly graphThreadId: string;
  readonly modelId: string | null;
}

const storage = new AsyncLocalStorage<DeepResearchReturnContext | null>();

export function deepResearchReturnContextForState(
  state: NautiloState,
): DeepResearchReturnContext | null {
  const roomId = state.roomId;
  const laneKey = state.approvalLaneKey;
  const graphThreadId = state.langgraphThreadId || state.currentThreadId;
  if (
    state.trustedExecutionEntrypoint !== "foreground.main" ||
    !state.userId ||
    !state.causalHumanUserId ||
    !roomId ||
    !state.agentId ||
    !graphThreadId ||
    laneKey !== `room:${roomId}`
  ) {
    return null;
  }
  return Object.freeze({
    ownerId: state.userId,
    requestorId: state.causalHumanUserId,
    roomId,
    laneKey,
    agentId: state.agentId,
    graphThreadId,
    modelId: state.model,
  });
}

export function runWithDeepResearchReturnContext<T>(
  context: DeepResearchReturnContext | null,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getDeepResearchReturnContext(): DeepResearchReturnContext | null {
  return storage.getStore() ?? null;
}
