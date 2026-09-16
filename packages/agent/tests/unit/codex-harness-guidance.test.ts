import { describe, expect, test } from "bun:test";
import { parseGenieRecoveryResultV1 } from "@nautilo/types";
import { codexHarnessFailureGuidance } from "../../src/tools/tasks/codex-harness-guidance";

describe("codexHarnessFailureGuidance — D513 typed semantic recovery", () => {
  test.each([
    [
      "CODEX_NOT_ENABLED",
      { target: "connections.codex", requirement: "human_enablement", domainTool: "task" },
    ],
    [
      "CODEX_PROFILE_UNAVAILABLE",
      { target: "connections.codex", requirement: "login", domainTool: "task" },
    ],
    [
      "CODEX_HOST_UNAVAILABLE",
      { target: "connections.codex", requirement: "desktop", domainTool: "task" },
    ],
  ] as const)("returns %s as semantic recovery", (code, expected) => {
    expect(parseGenieRecoveryResultV1(JSON.parse(codexHarnessFailureGuidance(new Error(code)) ?? "null") as unknown).recovery).toEqual(expected);
    expect(parseGenieRecoveryResultV1(JSON.parse(codexHarnessFailureGuidance(new Error(code), "in_background") ?? "null") as unknown).recovery).toEqual({
      ...expected,
      domainTool: "in_background",
    });
  });

  test("keeps non-recovery Codex failures as readable route-free domain text", () => {
    const guidance = codexHarnessFailureGuidance(new Error("CODEX_MODEL_UNAVAILABLE"));
    expect(guidance).toContain("model is not available");
    expect(guidance).not.toContain("/connections");
    expect(() => { void JSON.parse(guidance ?? ""); }).toThrow();
  });

  test.each([
    ["CLAUDE_TASK_FORBIDDEN", "cannot be controlled"],
    ["CLAUDE_TURN_UNAVAILABLE", "no active turn"],
    ["CLAUDE_STEER_UNAVAILABLE", "could not deliver"],
  ])("keeps %s as concise Claude steer guidance", (code, text) => {
    expect(codexHarnessFailureGuidance(new Error(code))).toContain(text);
  });

  test("returns null for an unknown failure code so callers retain their current fallback", () => {
    expect(codexHarnessFailureGuidance(new Error("CODEX_FUTURE_FAILURE"))).toBeNull();
  });
});
