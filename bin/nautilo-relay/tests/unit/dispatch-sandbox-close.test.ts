import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspaceGuard, type RelayDispatchRequest } from "@nautilo/relay";
import { makeDispatchHandler } from "../../src/index";

function request(
  toolName: "run_shell" | "terminal",
  args: Record<string, unknown>,
): RelayDispatchRequest {
  return {
    correlationId: `retired-${toolName}`,
    toolName,
    args,
    impact: "destructive",
    approvalObtained: true,
  };
}

describe("headless relay retired local execution", () => {
  test.each([
    ["run_shell", (marker: string) => ({ command: `touch ${marker}` })],
    ["terminal", (marker: string) => ({ action: "run", data: `touch ${marker}` })],
  ] as const)("%s rejects stale dispatch without an effect", async (toolName, args) => {
    const workspace = mkdtempSync(join(tmpdir(), "relay-retired-local-execution-"));
    const marker = join(workspace, "must-not-exist");
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: workspace }),
      );
      const result = await handler(request(toolName, args(marker)));

      expect(result).toMatchObject({
        status: "error",
        errorCode: "LOCAL_EXECUTION_DESKTOP_UPGRADE_REQUIRED",
      });
      expect(result.status === "error" && result.error).toContain(
        "Connect an up-to-date Nautilo Desktop",
      );
      expect(result.status === "error" && result.error).toContain("No command or terminal action was run");
      expect(existsSync(marker)).toBeFalse();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("unknown legacy names remain errors", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "relay-unknown-tool-"));
    try {
      const handler = makeDispatchHandler(
        createWorkspaceGuard({ workspaceRoot: workspace }),
      );
      const result = await handler({
        ...request("run_shell", {}),
        toolName: "list_directory",
      });

      expect(result).toEqual({ status: "error", error: "Unknown tool: list_directory" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
