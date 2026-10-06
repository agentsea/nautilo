import { describe, expect, test } from "bun:test";
import { extractToolProgressDetailFromStreamEvent, scopeSubagentStreamErrorDetail } from "./run";

describe("scope subagent progress argument projection", () => {
  test("keeps inspect intent while omitting top-level and nested credentials", () => {
    const detail = extractToolProgressDetailFromStreamEvent({
      event: "on_tool_start",
      name: "inspect_open_design",
      data: {
        input: {
          sessionToken: "progress-session-secret",
          cursor: "page:2",
          request: {
            Authorization: "Bearer progress-nested-secret",
            intent: "inspect next page",
          },
        },
      },
    });

    expect(detail).toContain("inspect_open_design");
    expect(detail).toContain("inspect next page");
    expect(detail).not.toContain("cursor");
    expect(detail).not.toContain("page:2");
    expect(detail).not.toContain("progress-session-secret");
    expect(detail).not.toContain("progress-nested-secret");
    expect(detail).not.toContain("sessionToken");
    expect(detail).not.toContain("Authorization");
    expect(detail).not.toContain("REDACTED");
  });

  test("shows only the tool name when every argument is sensitive", () => {
    expect(extractToolProgressDetailFromStreamEvent({
      event: "on_tool_start",
      name: "inspect_open_design",
      data: { input: { session_token: "only-secret" } },
    })).toBe("inspect_open_design");
  });
});

describe("scope subagent stream error custody", () => {
  test("never formats provider error content on the protected path", () => {
    const canary = "private-task-provider-error-canary";
    expect(scopeSubagentStreamErrorDetail(new Error(canary), true))
      .toBe("Protected Task graph execution failed");
    const hostileError = { toString() { throw new Error(canary); } };
    expect(scopeSubagentStreamErrorDetail(hostileError, true))
      .toBe("Protected Task graph execution failed");
  });

  test("preserves ordinary Error and non-Error diagnostics", () => {
    expect(scopeSubagentStreamErrorDetail(new Error("ordinary provider error"), false))
      .toBe("ordinary provider error");
    expect(scopeSubagentStreamErrorDetail("ordinary thrown value", false))
      .toBe("ordinary thrown value");
  });
});
