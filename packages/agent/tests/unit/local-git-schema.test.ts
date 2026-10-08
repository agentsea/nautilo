import { describe, expect, test } from "bun:test";
import { parseRelayRunShellGitOperation } from "@nautilo/relay";
import type { z } from "zod";
import { createLocalGitTool, localGitSchema } from "../../src/tools/local-git/local-git";

describe("local Git ingress", () => {
  const operations: z.input<typeof localGitSchema>[] = [
    { operation: "status" }, { operation: "diff" }, { operation: "diff", ref: "HEAD" },
    { operation: "add", paths: ["src/example.ts"] }, { operation: "commit", message: "Update example" },
    { operation: "worktree-add", target: "/synthetic/granted/worktree", ref: "HEAD" },
    { operation: "worktree-remove", target: "/synthetic/granted/worktree" },
  ];
  test("admits exactly the existing typed broker operations", () => {
    for (const operation of operations) {
      expect(localGitSchema.parse(operation)).toEqual(operation);
      expect(parseRelayRunShellGitOperation(operation).ok).toBe(true);
    }
  });
  test("rejects privilege selectors and shell or account payloads for every operation", () => {
    for (const operation of operations) for (const key of ["command", "cwd", "execution", "env", "token", "git"]) {
      expect(localGitSchema.safeParse({ ...operation, [key]: "untrusted" }).success).toBe(false);
    }
  });
  test("keeps the wire parser's ref, path and nonblank validation", () => {
    for (const operation of [
      { operation: "diff", ref: " " }, { operation: "diff", ref: ":(top)HEAD" },
      { operation: "add", paths: [] }, { operation: "add", paths: [":(top)*"] },
      { operation: "add", paths: ["src/**"] }, { operation: "add", paths: ["bad\0path"] },
      { operation: "commit", message: " " },
      { operation: "worktree-add", target: "relative", ref: "HEAD" },
      { operation: "worktree-remove", target: "relative" },
      { operation: "push", ref: "HEAD" }, { operation: "clone", url: "https://example.test/repo" },
    ]) {
      expect(localGitSchema.safeParse(operation).success).toBe(false);
      expect(parseRelayRunShellGitOperation(operation).ok).toBe(false);
    }
  });
  test("cannot execute through the tool's local function", async () => {
    const tool = createLocalGitTool();
    expect(tool.name).toBe("local_git");
    const error: unknown = await tool.invoke({ operation: "status" }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toContain("admitted Desktop Git broker");
  });
});
