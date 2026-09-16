import { describe, expect, test } from "bun:test";
import type { RelayDispatchRequest, RelayDispatchResult, WorkspaceGuard } from "@nautilo/relay";
import {
  FIXED_DESKTOP_DISPATCH_NOT_HANDLED,
  FIXED_DESKTOP_DISPATCH_ORDER,
  createFixedDesktopDispatchRouter,
  type FixedDesktopDispatchHandlers,
} from "../../electron/relay-dispatch/router.ts";

const context = {
  request: { toolName: "test" } as RelayDispatchRequest,
  signal: new AbortController().signal,
  guard: { roots: [] } as unknown as WorkspaceGuard,
};
const result = (value: string): RelayDispatchResult => ({ status: "ok", result: value });

function handlers(
  handler: (name: (typeof FIXED_DESKTOP_DISPATCH_ORDER)[number]) => FixedDesktopDispatchHandlers[keyof FixedDesktopDispatchHandlers],
): FixedDesktopDispatchHandlers {
  return {
    computerUse: handler("computerUse"),
    structuredSsh: handler("structuredSsh"), runShellOutput: handler("runShellOutput"),
    currentFolder: handler("currentFolder"), browserResearch: handler("browserResearch"),
    realWorkstation: handler("realWorkstation"),
    hue: handler("hue"), media: handler("media"), interactiveBrowser: handler("interactiveBrowser"),
    googleWorkspace: handler("googleWorkspace"), directLocalFile: handler("directLocalFile"),
    filesystem: handler("filesystem"), sandboxedLocalSearch: handler("sandboxedLocalSearch"),
    sandboxedRunShell: handler("sandboxedRunShell"), terminal: handler("terminal"),
  };
}

describe("fixed Desktop dispatch router", () => {
  test("pins the intended precedence tuple", () => {
    expect(FIXED_DESKTOP_DISPATCH_ORDER).toEqual([
      "computerUse", "structuredSsh", "runShellOutput", "currentFolder", "browserResearch",
      "realWorkstation", "hue", "media", "interactiveBrowser", "googleWorkspace",
      "directLocalFile", "filesystem", "sandboxedLocalSearch", "sandboxedRunShell", "terminal",
    ]);
    expect(Object.isFrozen(FIXED_DESKTOP_DISPATCH_NOT_HANDLED)).toBe(true);
  });

  test("falls through in fixed order and calls fallback only when none handle", async () => {
    const calls: string[] = [];
    const router = createFixedDesktopDispatchRouter(
      handlers((name) => async (seen) => {
        calls.push(name);
        expect(seen).toBe(context);
        return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
      }),
      async (seen) => { calls.push("fallback"); expect(seen).toBe(context); return result("fallback"); },
    );
    expect(await router(context)).toEqual(result("fallback"));
    expect(calls).toEqual([...FIXED_DESKTOP_DISPATCH_ORDER, "fallback"]);
  });

  test("stops on the first handled success or error", async () => {
    for (const expected of [result("first"), { status: "error", error: "stop" } as RelayDispatchResult]) {
      const calls: string[] = [];
      const router = createFixedDesktopDispatchRouter(
        handlers((name) => async () => {
          calls.push(name);
          return name === "currentFolder"
            ? { handled: true, result: expected }
            : FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
        }),
        async () => result("fallback"),
      );
      expect(await router(context)).toEqual(expected);
      expect(calls).toEqual([
        "computerUse",
        "structuredSsh",
        "runShellOutput",
        "currentFolder",
      ]);
    }
  });

  test("forwards the exact signal and propagates handler rejection", async () => {
    const failure = new Error("handler failure");
    const router = createFixedDesktopDispatchRouter(
      handlers((name) => async (seen) => {
        expect(seen.signal).toBe(context.signal);
        if (name === "computerUse") throw failure;
        return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
      }),
      async () => result("fallback"),
    );
    let caught: unknown;
    try {
      await router(context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });

  test("propagates fallback rejection after every fixed lane declines", async () => {
    const failure = new Error("fallback failure");
    const calls: string[] = [];
    const router = createFixedDesktopDispatchRouter(
      handlers((name) => async () => {
        calls.push(name);
        return FIXED_DESKTOP_DISPATCH_NOT_HANDLED;
      }),
      async (seen) => {
        expect(seen).toBe(context);
        calls.push("fallback");
        throw failure;
      },
    );
    let caught: unknown;
    try {
      await router(context);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(calls).toEqual([...FIXED_DESKTOP_DISPATCH_ORDER, "fallback"]);
  });
});
