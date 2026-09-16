import type { RelayDispatchRequest, RelayDispatchResult, WorkspaceGuard } from "@nautilo/relay";

export const FIXED_DESKTOP_DISPATCH_NOT_HANDLED = Object.freeze({ handled: false as const });

export type DesktopDispatchDecision =
  | typeof FIXED_DESKTOP_DISPATCH_NOT_HANDLED
  | { readonly handled: true; readonly result: RelayDispatchResult };

export interface FixedDesktopDispatchContext {
  readonly request: RelayDispatchRequest;
  readonly signal: AbortSignal | undefined;
  readonly guard: WorkspaceGuard;
}

export type FixedDesktopDispatchHandler = (
  context: FixedDesktopDispatchContext,
) => Promise<DesktopDispatchDecision>;

export const FIXED_DESKTOP_DISPATCH_ORDER = [
  "computerUse",
  "structuredSsh",
  "runShellOutput",
  "currentFolder",
  "browserResearch",
  "realWorkstation",
  "hue",
  "media",
  "interactiveBrowser",
  "googleWorkspace",
  "directLocalFile",
  "filesystem",
  "sandboxedLocalSearch",
  "sandboxedRunShell",
  "terminal",
] as const;

export type FixedDesktopDispatchHandlers = {
  readonly [K in (typeof FIXED_DESKTOP_DISPATCH_ORDER)[number]]: FixedDesktopDispatchHandler;
};

export function createFixedDesktopDispatchRouter(
  handlers: FixedDesktopDispatchHandlers,
  fallback: (context: FixedDesktopDispatchContext) => Promise<RelayDispatchResult>,
): (context: FixedDesktopDispatchContext) => Promise<RelayDispatchResult> {
  const orderedHandlers = FIXED_DESKTOP_DISPATCH_ORDER.map(
    (name) => handlers[name],
  );

  return async (context) => {
    for (const handler of orderedHandlers) {
      const decision = await handler(context);
      if (decision.handled) return decision.result;
    }
    return await fallback(context);
  };
}
