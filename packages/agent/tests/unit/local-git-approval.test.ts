import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { clearToolCatalog, getToolCatalog, initToolCatalog, ToolCatalog } from "@nautilo/catalog";
import { resolveApprovalForToolCall } from "../../src/nodes/post-model";
import { createLocalGitTool } from "../../src/tools/local-git/local-git";

describe("typed local Git approval", () => {
  let previous: ReturnType<typeof getToolCatalog>;
  beforeAll(() => {
    previous = getToolCatalog();
    const catalog = new ToolCatalog();
    catalog.register({ name: "local_git", factory: createLocalGitTool, category: "development", executor: "relay",
      trustTier: "admin", impact: "destructive", requiresApproval: true, requiredCapabilities: ["use_workstation"] });
    initToolCatalog(catalog);
  });
  afterAll(() => { if (previous) initToolCatalog(previous); else clearToolCatalog(); });
  const approval = (args: Record<string, unknown>) => resolveApprovalForToolCall({ name: "local_git", id: "git-fixture", args }, "standard");

  test("valid status and diff are classified as read-only", () => {
    expect(approval({ operation: "status" }).verb).toBe("auto");
    expect(approval({ operation: "diff", ref: "HEAD" }).verb).toBe("auto");
  });
  test("mutations retain normal approval in the absence of an admitted session override", () => {
    for (const args of [
      { operation: "add", paths: ["src/example.ts"] }, { operation: "commit", message: "Update example" },
      { operation: "worktree-add", target: "/synthetic/granted/tree", ref: "HEAD" },
      { operation: "worktree-remove", target: "/synthetic/granted/tree" },
    ]) expect(approval(args).verb).toBe("ask");
  });
  test("malformed read requests cannot receive the read-only classification", () => {
    for (const args of [{ operation: "status", command: "unexpected" }, { operation: "diff", ref: " " },
      { operation: "push" }, { operation: "status", execution: "workstation" }]) {
      expect(approval(args).verb).toBe("ask");
    }
  });
});
