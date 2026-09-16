import { describe, expect, test } from "bun:test";
import {
  classifyWorkstationExecutionClass,
  requiresNormalWorkstationCommandApproval,
} from "../../src/workstation-execution-class";

describe("workstation execution class", () => {
  test("requires the exact tool and exact typed opt-in", () => {
    expect(
      classifyWorkstationExecutionClass("run_shell", { execution: "workstation" }),
    ).toBe("real_workstation");
    for (const args of [
      undefined,
      {},
      { execution: "sandbox" },
      { execution: "WORKSTATION" },
      { workstation: true },
      { command: "execution=workstation" },
    ]) {
      expect(classifyWorkstationExecutionClass("run_shell", args)).toBe(
        "profile_bound_sandbox",
      );
    }
  });

  test("routes the structured Git payload to the typed broker", () => {
    expect(
      classifyWorkstationExecutionClass("run_shell", {
        git: { operation: "status" },
      }),
    ).toBe("typed_broker");
  });

  test("another tool cannot smuggle the workstation argument", () => {
    for (const tool of ["file", "terminal", "github", "run_shell_extra", ""]) {
      expect(
        classifyWorkstationExecutionClass(tool, { execution: "workstation" }),
      ).toBe("profile_bound_sandbox");
    }
  });
});

describe("workstation command safety branch", () => {
  test("returns critical destruction and elevation to normal approval", () => {
    for (const command of ["rm -rf /", "sudo gh auth status", "git reset --hard"]) {
      expect(
        requiresNormalWorkstationCommandApproval({
          toolName: "run_shell",
          executionClass: "real_workstation",
          args: { command },
        }),
      ).toBe(true);
    }
  });

  test("routine and medium developer commands proceed to Electron consent", () => {
    for (const command of [
      "gh auth status",
      "gh api user --jq .login",
      "npm install react",
      "/bin/bash <<'BASH'\nprintf '%s\\n' ok\nBASH",
      "",
    ]) {
      expect(
        requiresNormalWorkstationCommandApproval({
          toolName: "run_shell",
          executionClass: "real_workstation",
          args: { command },
        }),
      ).toBe(false);
    }
  });

  test("does not apply shell scanning to another tool or the typed broker", () => {
    expect(
      requiresNormalWorkstationCommandApproval({
        toolName: "file",
        executionClass: "real_workstation",
        args: { command: "sudo rm -rf /" },
      }),
    ).toBe(false);
    expect(
      requiresNormalWorkstationCommandApproval({
        toolName: "run_shell",
        executionClass: "typed_broker",
        args: { command: "sudo rm -rf /" },
      }),
    ).toBe(false);
  });

  test("missing, non-object, and non-string command arguments stay routine", () => {
    for (const args of [undefined, null, "sudo rm -rf /", 7, { command: 7 }]) {
      expect(
        requiresNormalWorkstationCommandApproval({
          toolName: "run_shell",
          executionClass: "real_workstation",
          args,
        }),
      ).toBe(false);
    }
  });
});
