import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  createWorkspaceGuard,
  type OpenHueExecutor,
  type RelayDispatchRequest,
} from "@nautilo/relay";

import { createHueDispatchHandler } from "../../electron/relay-dispatch/local-applications.ts";
import { FIXED_DESKTOP_DISPATCH_NOT_HANDLED } from "../../electron/relay-dispatch/router.ts";

const guard = createWorkspaceGuard({ workspaceRoot: "/tmp" });

function request(
  toolName: string,
  args: Record<string, unknown> = {},
  overrides: Partial<RelayDispatchRequest> = {},
): RelayDispatchRequest {
  return {
    correlationId: "local-application-adapter",
    toolName,
    args,
    impact: "read-only",
    approvalObtained: false,
    ...overrides,
  };
}

describe("fixed local application dispatch adapters", () => {
  let restoreClock: () => void;
  beforeEach(() => {
    // Assert the exact adapter budget without racing wall-clock milliseconds.
    const clock = spyOn(Date, "now").mockReturnValue(0);
    restoreClock = () => clock.mockRestore();
  });
  afterEach(() => restoreClock());

  test("Hue declines nonmatches before binary resolution or execution", async () => {
    let binaryCalls = 0;
    let executionCalls = 0;
    const handler = createHueDispatchHandler({
      resolveBinary: () => {
        binaryCalls += 1;
        return "/managed/openhue";
      },
      executor: {
        execute: async () => {
          executionCalls += 1;
          return { stdout: "", stderr: "", exitCode: 0 };
        },
      },
    });

    expect(await handler({
      request: request("desktop_click", {}, { executionClass: "desktop" }),
      signal: undefined,
      guard,
    })).toBe(FIXED_DESKTOP_DISPATCH_NOT_HANDLED);
    expect(binaryCalls).toBe(0);
    expect(executionCalls).toBe(0);
  });

  test("Hue resolves its owner binary and executes the existing fixed handler without a signal", async () => {
    const executions: Array<{
      binary: string;
      argv: readonly string[];
      timeoutMs: number;
      hasSignal: boolean;
    }> = [];
    let binaryCalls = 0;
    const executor: OpenHueExecutor = {
      execute: async (binary, argv, options) => {
        executions.push({
          binary,
          argv,
          timeoutMs: options.timeoutMs,
          hasSignal: "signal" in options,
        });
        return {
          stdout: '[{"id":"light-1"}]',
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const handler = createHueDispatchHandler({
      executor,
      resolveBinary: () => {
        binaryCalls += 1;
        return "/managed/openhue";
      },
    });

    expect(await handler({
      request: request("hue_lights", { action: "list_lights" }),
      signal: new AbortController().signal,
      guard,
    })).toEqual({
      handled: true,
      result: { status: "ok", result: [{ id: "light-1" }] },
    });
    expect(binaryCalls).toBe(1);
    expect(executions).toEqual([{
      binary: "/managed/openhue",
      argv: ["get", "light", "--json"],
      timeoutMs: 15_000,
      hasSignal: false,
    }]);
  });
});
