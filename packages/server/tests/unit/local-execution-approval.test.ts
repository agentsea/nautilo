import { describe, expect, test } from "bun:test";
import { classifyWorkstationExecutionClass, requiresNormalWorkstationCommandApproval } from "../../src/workstation-execution-class";

describe("contained execution approval", () => {
  test("scans the admitted cmd field and cannot opt into real workstation execution", () => {
    for (const cmd of ["rm -rf /", "sudo gh auth status", "git reset --hard"]) {
      expect(requiresNormalWorkstationCommandApproval({ toolName: "exec_command", executionClass: "profile_bound_sandbox", args: { cmd } })).toBe(true);
    }
    expect(requiresNormalWorkstationCommandApproval({ toolName: "exec_command", executionClass: "profile_bound_sandbox", args: { cmd: "npm run build" } })).toBe(false);
    expect(classifyWorkstationExecutionClass("exec_command", { execution: "workstation" })).toBe("profile_bound_sandbox");
  });

  test("every input byte follows normal approval while retrieval and cancellation remain cleanup operations", () => {
    for (const chars of ["echo fixture\n", "sudo rm -rf /\n", "\n"]) {
      expect(requiresNormalWorkstationCommandApproval({ toolName: "write_stdin", executionClass: "profile_bound_sandbox", args: { chars } })).toBe(true);
    }
    for (const args of [{}, { chars: "" }, { cancel: true }]) {
      expect(requiresNormalWorkstationCommandApproval({ toolName: "write_stdin", executionClass: "profile_bound_sandbox", args })).toBe(false);
    }
  });
});
