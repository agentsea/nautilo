import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedOrdinaryHost } from "./ordinary-host-resolver";

export type RequiredOrdinaryHostDispatchContext = Readonly<
  Pick<ResolvedOrdinaryHost, "relayId"> &
  Partial<Pick<ResolvedOrdinaryHost, "workspaceRoot" | "currentFolderRoot">> & {
    /** M286 server-local exact Task continuation fence; never model-authored or serialized. */
    readonly requiredRelaySessionId?: string;
    readonly requiredDesktopSessionId?: string;
    readonly requiredPairingGeneration?: string;
  }
>;

const requiredHostStorage = new AsyncLocalStorage<RequiredOrdinaryHostDispatchContext | null>();

/** Bind the freshly revalidated host snapshot to one approved Tool invocation. */
export function runWithRequiredOrdinaryHostContext<T>(
  context: RequiredOrdinaryHostDispatchContext | null,
  fn: () => T,
): T {
  return requiredHostStorage.run(context, fn);
}

/** Compatibility helper for consumers that need only the exact Relay pin. */
export function runWithRequiredOrdinaryHostRelay<T>(
  relayId: string | null,
  fn: () => T,
): T {
  return runWithRequiredOrdinaryHostContext(relayId === null ? null : { relayId }, fn);
}

/** Private execution context; model and renderer state never supply these values. */
export function getRequiredOrdinaryHostContext(): RequiredOrdinaryHostDispatchContext | null {
  return requiredHostStorage.getStore() ?? null;
}
