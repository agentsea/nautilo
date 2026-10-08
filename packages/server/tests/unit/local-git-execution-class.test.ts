import { describe, expect, test } from "bun:test";
import { classifyWorkstationExecutionClass } from "../../src/workstation-execution-class";

describe("local Git execution classification", () => {
  test("the exact tool selects only typed-broker execution", () => {
    for (const args of [undefined, { operation: "status" }, { execution: "workstation", command: "sudo rm -rf /" }]) {
      expect(classifyWorkstationExecutionClass("local_git", args)).toBe("typed_broker");
    }
  });
  test("names and command contents cannot acquire broker authority", () => {
    for (const name of ["local_git_extra", "git", "terminal", "exec_command"]) {
      expect(classifyWorkstationExecutionClass(name, { operation: "status", execution: "workstation" })).toBe("profile_bound_sandbox");
    }
    expect(classifyWorkstationExecutionClass("run_shell", { command: "git status" })).toBe("profile_bound_sandbox");
    expect(classifyWorkstationExecutionClass("run_shell", { git: { operation: "status" } })).toBe("typed_broker");
  });
});
