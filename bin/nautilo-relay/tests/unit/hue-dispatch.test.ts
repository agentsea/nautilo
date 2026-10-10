import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

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
    const expected: RelayDispatchResult = {
      status: "ok",
      result: [{ id: "kitchen" }],
    };
    const handler = makeDispatchHandler(guard, {
      hueHandler: async (args) => {
        expect(args).toEqual({ action: "list_lights" });
        return expected;
      },
    });

    const result = await Promise.resolve(handler(hueRequest()));
    expect(result).toEqual(expected);
  });

  test("resolves OpenHue override, tools bin, then PATH in order", () => {
    const customBinary = resolve("custom", "openhue");
    const tools = resolve("tools");
    const resolvedTools = resolve("resolved-tools");
    const missingTools = resolve("missing-tools");
    expect(
      resolveOpenHueBinary(
        {
          NAUTILO_OPENHUE_BIN: customBinary,
          NAUTILO_TOOLS_BIN: tools,
        },
        resolvedTools,
        () => false,
      ),
    ).toBe(customBinary);
    expect(
      resolveOpenHueBinary(
        { NAUTILO_TOOLS_BIN: tools },
        resolvedTools,
        (candidate) => candidate === join(tools, "openhue"),
      ),
    ).toBe(join(tools, "openhue"));
    expect(
      resolveOpenHueBinary(
        { NAUTILO_TOOLS_BIN: missingTools },
        resolvedTools,
        (candidate) => candidate === join(resolvedTools, "openhue"),
      ),
    ).toBe(join(resolvedTools, "openhue"));
    expect(resolveOpenHueBinary({}, resolvedTools, () => false)).toBe(
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
