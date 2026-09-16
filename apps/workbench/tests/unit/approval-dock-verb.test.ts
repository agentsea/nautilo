/**
 * D079 Phase 4 / G4 commit 11 — approval dock composite-verb tests.
 *
 * Regression guard on the canonical `formatToolPreview` logic used by
 * both approval surfaces. The `file` tool's
 * composite-verb display is the decision record's
 * "Approval-dock display" mitigation — critical UX surface.
 *
 */

import { describe, test, expect } from "bun:test";
import {
  formatToolDisplayName as formatToolName,
  formatToolPreview,
} from "../../src/components/tool-argument-preview";

describe("formatToolName (D079 Phase 4 composite-verb)", () => {
  test("file tool with command → composite verb file.<command>", () => {
    expect(
      formatToolName({ name: "file", args: { command: "str_replace" } }),
    ).toBe("file.str_replace");
    expect(
      formatToolName({ name: "file", args: { command: "write" } }),
    ).toBe("file.write");
    expect(
      formatToolName({ name: "file", args: { command: "delete" } }),
    ).toBe("file.delete");
  });

  test("file tool without command → bare 'file' (defensive)", () => {
    expect(formatToolName({ name: "file", args: {} })).toBe("file");
    expect(formatToolName({ name: "file", args: { path: "/x" } })).toBe("file");
  });

  test("file tool with non-string command → bare 'file' (defensive)", () => {
    expect(
      formatToolName({ name: "file", args: { command: 42 } }),
    ).toBe("file");
    expect(
      formatToolName({ name: "file", args: { command: null } }),
    ).toBe("file");
  });

  test("non-'file' tools → bare tool name, no transformation", () => {
    expect(
      formatToolName({ name: "run_shell", args: { command: "ls" } }),
    ).toBe("run_shell");
    expect(
      formatToolName({ name: "transcribe_audio", args: { path: "x" } }),
    ).toBe("transcribe_audio");
  });
});

describe("formatToolPreview — composite verb + arg filter", () => {
  test("file tool shows composite verb + filters `command` out of args", () => {
    const preview = formatToolPreview({
      name: "file",
      args: { command: "str_replace", path: "notes.md", zone: "workspace" },
    });
    // Composite verb present
    expect(preview).toContain("file.str_replace");
    // Command arg FILTERED OUT of the args preview (it's already in the verb)
    expect(preview).not.toContain("command: str_replace");
    // Other args present
    expect(preview).toContain("path: notes.md");
    expect(preview).toContain("zone: workspace");
  });

  test("file tool with only command arg → bare verb, empty args paren dropped", () => {
    const preview = formatToolPreview({
      name: "file",
      args: { command: "list" },
    });
    // No args beyond command, so no parens
    expect(preview).toBe("file.list");
  });

  test("non-file tool: args unchanged, including any `command` field", () => {
    const preview = formatToolPreview({
      name: "run_shell",
      args: { command: "ls -la", cwd: "/tmp" },
    });
    expect(preview).toContain("run_shell");
    // run_shell's "command" arg is meaningful and should NOT be filtered
    expect(preview).toContain("command: ls -la");
  });

  test("truncates long string args at 40 chars with ellipsis", () => {
    const long = "x".repeat(100);
    const preview = formatToolPreview({
      name: "file",
      args: { command: "write", path: long, content: "..." },
    });
    expect(preview).toContain("file.write");
    // Truncation marker on the long path
    expect(preview).toMatch(/path: x{37}…/);
  });

  test("caps displayed args at 3 (file tool's command arg doesn't count)", () => {
    const preview = formatToolPreview({
      name: "file",
      args: {
        command: "write",
        path: "a",
        zone: "workspace",
        content: "c",
        mode: "overwrite",
      },
    });
    // Command is filtered; of remaining 4 (path, zone, content, mode),
    // first 3 should appear (path, zone, content).
    expect(preview).toContain("path: a");
    expect(preview).toContain("zone: workspace");
    expect(preview).toContain("content: c");
    expect(preview).not.toContain("mode: overwrite");
  });
});
