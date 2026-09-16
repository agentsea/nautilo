import { describe, expect, test } from "bun:test";

import {
  createWorkspaceGuard,
  type RelayDispatchRequest,
  type RelayDispatchResult,
} from "@nautilo/relay";

import {
  makeDispatchHandler,
  probeOpenHue,
  resolveOpenHueBinary,
} from "../../src/index";

function hueRequest(): RelayDispatchRequest {
  return {
    correlationId: "relay-hue-dispatch-test",
    toolName: "hue_lights",
    args: { action: "list_lights" },
    impact: "low",
    approvalObtained: false,
  };
}

describe("headless relay Hue dispatch", () => {
  test("routes hue_lights through the typed handler before sandbox resolution", async () => {
    const guard = createWorkspaceGuard({ workspaceRoot: process.cwd() });
    let sandboxCalls = 0;
    const expected: RelayDispatchResult = {
      status: "ok",
      result: [{ id: "kitchen" }],
    };
    const handler = makeDispatchHandler(guard, {
      isProduction: true,
      createSandbox: async () => {
        sandboxCalls += 1;
        throw new Error("Hue dispatch must not construct a sandbox");
      },
      hueHandler: async (args) => {
        expect(args).toEqual({ action: "list_lights" });
        return expected;
      },
    });

    const result = await Promise.resolve(handler(hueRequest()));
    expect(result).toEqual(expected);
    expect(sandboxCalls).toBe(0);
  });

  test("resolves OpenHue override, tools bin, then PATH in order", () => {
    expect(
      resolveOpenHueBinary(
        {
          NAUTILO_OPENHUE_BIN: "/custom/openhue",
          NAUTILO_TOOLS_BIN: "/tools",
        },
        "/resolved-tools",
        () => false,
      ),
    ).toBe("/custom/openhue");
    expect(
      resolveOpenHueBinary(
        { NAUTILO_TOOLS_BIN: "/tools" },
        "/resolved-tools",
        (candidate) => candidate === "/tools/openhue",
      ),
    ).toBe("/tools/openhue");
    expect(
      resolveOpenHueBinary(
        { NAUTILO_TOOLS_BIN: "/missing-tools" },
        "/resolved-tools",
        (candidate) => candidate === "/resolved-tools/openhue",
      ),
    ).toBe("/resolved-tools/openhue");
    expect(resolveOpenHueBinary({}, "/resolved-tools", () => false)).toBe(
      "openhue",
    );
    expect(resolveOpenHueBinary({}, "")).toBe("openhue");
  });

  test("advertises Hue only when the version probe succeeds", async () => {
    const successful = await probeOpenHue(
      {
        execute: async () => ({ stdout: "0.24.0", stderr: "", exitCode: 0 }),
      },
      "openhue",
    );
    const failed = await probeOpenHue(
      {
        execute: async () => ({ stdout: "", stderr: "not found", exitCode: 127 }),
      },
      "openhue",
    );

    expect(successful).toBe(true);
    expect(failed).toBe(false);
  });
});
