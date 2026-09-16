import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ActiveMiniAppRequestContext,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import type { NautiloState } from "../agent/state";

/** Ephemeral authority for one running background Writer Task. */
export interface LiveMiniAppExecutionContext {
  readonly activeMiniApp: ActiveMiniAppRequestContext;
  readonly liveMiniAppSession: TrustedLiveMiniAppSessionContext;
}

const storage = new AsyncLocalStorage<LiveMiniAppExecutionContext | null>();

export function runWithLiveMiniAppExecutionContext<T>(
  context: LiveMiniAppExecutionContext | null,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getLiveMiniAppExecutionContext(): LiveMiniAppExecutionContext | null {
  return storage.getStore() ?? null;
}

/**
 * Checkpointed live session state is never authority for background Tasks.
 * Foreground executions retain their established state-backed behavior.
 */
export function effectiveLiveMiniAppSessionForState(
  state: Pick<NautiloState, "trustedExecutionEntrypoint" | "liveMiniAppSession">,
): TrustedLiveMiniAppSessionContext | null {
  if (state.trustedExecutionEntrypoint === "background.task") {
    return getLiveMiniAppExecutionContext()?.liveMiniAppSession ?? null;
  }
  return state.liveMiniAppSession ?? null;
}
