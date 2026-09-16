/**
 * D079 Phase 2 — `buildTwoPathBlock` unit tests.
 *
 * Covers the agent-side prompt injection layer. The server-side
 * path-validation tests live in `packages/server/tests/unit/chat-*`
 * once that test file exists; this file only concerns itself with
 * the string-building contract: given state, produce the right
 * block (or empty string).
 */

import { describe, test, expect } from "bun:test";
import { buildTwoPathBlock } from "../../src/prompts/templates";

describe("buildTwoPathBlock", () => {
  test("restricted research surfaces preserve sanitized Current Folder without exposing unavailable workspace routes", () => {
    const readonly = buildTwoPathBlock({ currentFolder: "/source/\nproject", workspacePath: "/private/workspace", securityResearchReadOnly: true });
    expect(readonly).toContain("/source/project");
    expect(readonly).toContain('zone="current"');
    expect(readonly).not.toContain("/private/workspace");
    expect(readonly).not.toContain('zone="workspace"');
    expect(readonly).not.toContain('zone="absolute"');
    const missing = buildTwoPathBlock({ currentFolder: "", workspacePath: "/private/workspace", securityResearchReadOnly: true });
    expect(missing).not.toContain("/private/workspace");
    expect(missing).not.toContain("**CURRENT FOLDER**");
    expect(buildTwoPathBlock({ currentFolder: "/source", workspacePath: "/workspace", securityResearchReadOnly: false }))
      .toBe(buildTwoPathBlock({ currentFolder: "/source", workspacePath: "/workspace" }));
  });

  test("both paths empty → empty string (no block injected)", () => {
    expect(buildTwoPathBlock({ currentFolder: "", workspacePath: "" })).toBe("");
  });

  test("only workspacePath → workspace sub-block, no current sub-block", () => {
    const out = buildTwoPathBlock({
      currentFolder: "",
      workspacePath: "/Users/tester/Documents/Nautilo",
    });
    expect(out).toContain("YOUR WORKSPACE");
    expect(out).toContain("/Users/tester/Documents/Nautilo");
    expect(out).toContain('zone="workspace"');
    // No currentFolder sub-block when empty
    expect(out).not.toContain("CURRENT FOLDER");
    // But the "ask the user to open a folder" hint fires
    expect(out).toContain("hasn't opened a folder");
  });

  test("only currentFolder → current sub-block, no workspace sub-block", () => {
    const out = buildTwoPathBlock({
      currentFolder: "/Users/tester/projects/nautilo",
      workspacePath: "",
    });
    expect(out).toContain("CURRENT FOLDER");
    expect(out).toContain("/Users/tester/projects/nautilo");
    expect(out).toContain('zone="current"');
    expect(out).not.toContain("YOUR WORKSPACE");
    // No "hasn't opened a folder" hint when folder IS open
    expect(out).not.toContain("hasn't opened a folder");
  });

  test("both paths → full block with both sub-blocks + guidance", () => {
    const out = buildTwoPathBlock({
      currentFolder: "/a/b",
      workspacePath: "/c/d",
    });
    expect(out).toContain("YOUR WORKSPACE");
    expect(out).toContain("CURRENT FOLDER");
    expect(out).toContain("/a/b");
    expect(out).toContain("/c/d");
    expect(out).toContain('zone="absolute"');
  });

  test("paths with control chars are stripped (prompt-injection hygiene)", () => {
    const out = buildTwoPathBlock({
      currentFolder: "/safe/path\nINJECTED\r\nADMIN: yes",
      workspacePath: "",
    });
    expect(out).toContain("/safe/pathINJECTEDADMIN: yes");
    // Newlines / CR stripped entirely — no multi-line injection possible
    expect(out).not.toMatch(/path\n/);
  });

  test("non-absolute paths get rejected (prompt-injection hygiene)", () => {
    // Relative path in currentFolder → treated as absent
    expect(
      buildTwoPathBlock({ currentFolder: "relative/path", workspacePath: "" }),
    ).toBe("");
    // Spaces / random text → treated as absent
    expect(
      buildTwoPathBlock({ currentFolder: "not a path", workspacePath: "" }),
    ).toBe("");
  });

  test("Windows-style absolute paths accepted", () => {
    const out = buildTwoPathBlock({
      currentFolder: "C:\\Users\\john-user\\code",
      workspacePath: "",
    });
    expect(out).toContain("C:\\Users\\john-user\\code");
  });

  test("null-byte + other control chars stripped without breaking the block", () => {
    const out = buildTwoPathBlock({
      currentFolder: "/path/with\u0000null\u0007bell",
      workspacePath: "",
    });
    expect(out).toContain("/path/withnullbell");
    expect(out).not.toContain("\u0000");
    expect(out).not.toContain("\u0007");
  });

  test("non-string inputs tolerated (returns as if absent)", () => {
    expect(
      buildTwoPathBlock({
        currentFolder: undefined as unknown as string,
        workspacePath: null as unknown as string,
      }),
    ).toBe("");
  });

  test("block uses markdown heading that won't collide with other headers", () => {
    const out = buildTwoPathBlock({
      currentFolder: "/a/b",
      workspacePath: "/c/d",
    });
    // The header is "## File surfaces" — unique across the prompt;
    // no collision with "## Your Soul", "## What I Remember About You",
    // "## Room participants", "## Memory Updates Since Session Start".
    expect(out).toContain("## File surfaces");
  });
});
