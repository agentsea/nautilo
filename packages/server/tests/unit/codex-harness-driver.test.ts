import { describe, expect, test } from "bun:test";
import type { HarnessExecutionAdmission } from "@nautilo/runtime";
import { createCodexHarnessControlPlane } from "../../src/codex/harness-composition";
import {
  CODEX_HARNESS_DESCRIPTOR,
  CODEX_HARNESS_ID,
} from "../../src/codex/harness-driver";

describe("CodexHarnessDriver", () => {
  test("registers data-only Codex facts and lazily selects an injected execution port", async () => {
    let starts = 0;
    const controlPlane = createCodexHarnessControlPlane({
      execution: {
        async *start(_admission: HarnessExecutionAdmission) {
          starts += 1;
          yield {
            kind: "terminal" as const,
            attribution: {
              bindingId: "binding",
              bindingGeneration: "generation",
              taskId: "task",
              roomId: null,
              vendorSessionId: null,
              vendorTurnId: "turn",
              vendorItemId: null,
            },
            status: "completed" as const,
          };
        },
      },
    });

    expect(controlPlane.listDescriptors()).toEqual([CODEX_HARNESS_DESCRIPTOR]);
    expect(starts).toBe(0);

    const driver = await controlPlane.requireOperation(CODEX_HARNESS_ID, "start");
    expect(starts).toBe(0);
    expect(driver.execution.start).toBeDefined();
  });

  test("reports execution as ready without manufacturing unsupported optional operations", async () => {
    const controlPlane = createCodexHarnessControlPlane({
      execution: {
        async *start() {
          yield {
            kind: "terminal" as const,
            attribution: {
              bindingId: "binding",
              bindingGeneration: "generation",
              taskId: "task",
              roomId: null,
              vendorSessionId: null,
              vendorTurnId: "turn",
              vendorItemId: null,
            },
            status: "completed" as const,
          };
        },
      },
    });

    expect(await controlPlane.requireOperation(CODEX_HARNESS_ID, "start")).toBeDefined();
    try {
      await controlPlane.requireOperation(CODEX_HARNESS_ID, "steer");
      throw new Error("Expected steer to remain unavailable");
    } catch (error) {
      expect(error).toMatchObject({ code: "harness_capability_unsupported" });
    }
  });

  test("confirms native requests only when the injected execution facet can respond", async () => {
    const withResponses = createCodexHarnessControlPlane({
      execution: {
        async *start() {},
        async respond() {},
      },
    });
    expect(await withResponses.requireOperation(CODEX_HARNESS_ID, "respond_to_request")).toBeDefined();

    const withoutResponses = createCodexHarnessControlPlane({
      execution: { async *start() {} },
    });
    try {
      await withoutResponses.requireOperation(CODEX_HARNESS_ID, "respond_to_request");
      throw new Error("Expected requests to remain unavailable without respond()");
    } catch (error) {
      expect(error).toMatchObject({ code: "harness_capability_unsupported" });
    }

    const lyingProbe = createCodexHarnessControlPlane({
      execution: { async *start() {} },
      probeCapabilities: async () => ({ requests: "supported" }),
    });
    try {
      await lyingProbe.requireOperation(CODEX_HARNESS_ID, "respond_to_request");
      throw new Error("Expected a probe not to upgrade absent respond()");
    } catch (error) {
      expect(error).toMatchObject({ code: "harness_capability_unsupported" });
    }
  });
});
