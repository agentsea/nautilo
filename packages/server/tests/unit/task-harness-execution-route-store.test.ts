import { describe, expect, test } from "bun:test";
import {
  TaskHarnessExecutionRouteFailure,
} from "../../src/harness/task-execution-route";
import {
  projectTaskHarnessExecutionDescriptor,
} from "../../src/harness/task-execution-route-store";

describe("projectTaskHarnessExecutionDescriptor", () => {
  test("keeps Native Tasks on the native executor when no execution metadata exists", () => {
    expect(projectTaskHarnessExecutionDescriptor({ title: "ordinary task" })).toBeNull();
  });

  test("projects only the strict public base and omits provider-private fields", () => {
    const descriptor = projectTaskHarnessExecutionDescriptor({
      execution: {
        version: 1,
        harnessId: "codex",
        source: "genie",
        harnessModelId: "picker-5.5",
        workingDirectory: "/private/workspace",
        readiness: { relayId: "relay", pairingGenerationRef: "generation", capabilityRevision: 1 },
      },
      browserSuppliedProfile: "never-enters-router",
    });

    expect(descriptor).toEqual({ version: 1, harnessId: "codex", source: "genie" });
    expect(descriptor).not.toHaveProperty("workingDirectory");
    expect(descriptor).not.toHaveProperty("harnessModelId");
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  test("fails closed for every present malformed or near-match execution base", () => {
    for (const metadata of [
      { execution: null },
      { execution: [] },
      { execution: { version: 2, harnessId: "codex", source: "genie" } },
      { execution: { version: 1, harnessId: "codex", source: "browser" } },
      { execution: { version: 1, harnessId: "", source: "genie" } },
      { execution: { version: 1, harnessId: "codex" } },
    ]) {
      expect(() => projectTaskHarnessExecutionDescriptor(metadata)).toThrow(
        new TaskHarnessExecutionRouteFailure("TASK_HARNESS_DESCRIPTOR_INVALID"),
      );
    }
  });
});
