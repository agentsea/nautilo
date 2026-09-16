/**
 * D079 PR-011 security port — tests for `validateBeforeExecution`,
 * the pre-execution security gate in `toolsNode`. Focused on the
 * new `file` tool branch (B-1a): absolute-zone paths must flow
 * through `checkPathAccess` so the deny-list (path-deny.ts) fires
 * before any fs op reaches a protected path.
 *
 * The existing `run_shell` branch is exercised by
 * `tools-relay-scan-parity.test.ts` and `tools-lifecycle-events.test.ts`
 * end-to-end; this file pins the file-tool branch directly so future
 * refactors can't silently drop the gate.
 *
 * M088B — `read_file` / `write_file` / `list_directory` were removed;
 * the legacy regression guards below are pruned to assert the unified
 * `file` tool now owns those code paths exclusively.
 */

import { describe, test, expect } from "bun:test";
import { validateBeforeExecution } from "../../src/nodes/tools";

describe("validateBeforeExecution — file tool (D079 PR-011 B-1a)", () => {
  test("file tool + absolute zone + deny-listed path → blocked", () => {
    const result = validateBeforeExecution(
      "file",
      { command: "read", zone: "absolute", path: "/etc/passwd" },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("Security");
  });

  test("file tool + absolute zone + home-relative deny (~/.ssh/id_rsa) → blocked", () => {
    // path-deny.ts resolves HOME-relative entries; checkPathAccess
    // handles `~/...` expansion via its internal resolve.
    const result = validateBeforeExecution(
      "file",
      { command: "read", zone: "absolute", path: "~/.ssh/id_rsa" },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("Security");
  });

  test("file tool + absolute zone + innocuous path → allowed", () => {
    const result = validateBeforeExecution(
      "file",
      { command: "read", zone: "absolute", path: "/tmp/notes.md" },
      "standard",
    );
    expect(result).toBeNull();
  });

  test("file tool + workspace zone + relative path → allowed (containment check lives in dispatcher)", () => {
    // The deny-list is meaningless against relative paths — the
    // containment check for workspace/current zones happens in
    // `assertRealpathContained` inside the dispatcher, not here.
    const result = validateBeforeExecution(
      "file",
      { command: "read", zone: "workspace", path: "notes.md" },
      "standard",
    );
    expect(result).toBeNull();
  });

  test("file tool + current zone + relative path → allowed (containment check lives in dispatcher)", () => {
    const result = validateBeforeExecution(
      "file",
      { command: "read", zone: "current", path: "draft.md" },
      "standard",
    );
    expect(result).toBeNull();
  });

  test("file tool + absolute zone + missing path → null (handler surfaces its own error)", () => {
    const result = validateBeforeExecution(
      "file",
      { command: "read", zone: "absolute" },
      "standard",
    );
    expect(result).toBeNull();
  });

  test("file tool + write + absolute zone + deny-listed path → blocked", () => {
    // The gate fires on the tool+zone, not on the command. Writes
    // and deletes to deny-listed absolute paths are blocked the
    // same way reads are.
    const result = validateBeforeExecution(
      "file",
      { command: "write", zone: "absolute", path: "/etc/passwd", content: "hi" },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("Security");
  });

  test("file tool + grep + absolute zone + deny-listed directory → blocked", () => {
    const result = validateBeforeExecution(
      "file",
      { command: "grep", zone: "absolute", path: "/etc/ssh", query: "PermitRootLogin" },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("Security");
  });

  test("file tool + yolo security level disables deny-list (matches legacy behavior)", () => {
    // Yolo level: path-deny.ts disables pathDeny layer. This is the
    // "I know what I'm doing, let me pwn myself" escape hatch. Same
    // behavior as legacy read_file under yolo level.
    const result = validateBeforeExecution(
      "file",
      { command: "read", zone: "absolute", path: "/etc/passwd" },
      "yolo",
    );
    expect(result).toBeNull();
  });

  test("file tool + copy + absolute destinationPath deny-listed → blocked", () => {
    const result = validateBeforeExecution(
      "file",
      {
        command: "copy",
        zone: "workspace",
        path: "draft.md",
        destinationZone: "absolute",
        destinationPath: "/etc/passwd",
      },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("destinationPath");
  });

  test("file tool + copy defaults omitted destinationZone to source zone for scan", () => {
    const result = validateBeforeExecution(
      "file",
      {
        command: "copy",
        zone: "absolute",
        path: "/tmp/source.md",
        destinationPath: "/etc/passwd",
      },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("destinationPath");
  });

  test("file tool + move defaults omitted destinationZone to source zone for scan", () => {
    const result = validateBeforeExecution(
      "file",
      {
        command: "move",
        zone: "absolute",
        path: "/tmp/source.md",
        destinationPath: "/etc/passwd",
      },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("destinationPath");
  });
});

describe("validateBeforeExecution — legacy branches (regression guards)", () => {
  test("run_shell block still fires", () => {
    const result = validateBeforeExecution(
      "run_shell",
      { command: "rm -rf /" },
      "standard",
    );
    expect(result).not.toBeNull();
    expect(result).toContain("Security");
  });

  test("run_shell medium match proceeds after the approval resolver admits it", () => {
    const result = validateBeforeExecution(
      "run_shell",
      { command: "find packages -name package.json -exec sh -c 'printf %s \\\"$1\\\"' _ {} \\;" },
      "paranoid",
    );
    expect(result).toBeNull();
  });

  test("run_shell high match proceeds after the approval resolver admits it", () => {
    const result = validateBeforeExecution(
      "run_shell",
      { command: "sudo -n true" },
      "standard",
    );
    expect(result).toBeNull();
  });

  test("legacy read_file tool name → null (M088B removed; unified file tool is the only filesystem surface)", () => {
    const result = validateBeforeExecution(
      "read_file",
      { path: "/etc/passwd" },
      "standard",
    );
    expect(result).toBeNull();
  });

  test("legacy list_directory tool name → null (M088B removed)", () => {
    const result = validateBeforeExecution(
      "list_directory",
      { path: "/etc/ssh" },
      "standard",
    );
    expect(result).toBeNull();
  });

  test("unknown tool → null (not our concern)", () => {
    expect(
      validateBeforeExecution(
        "search_memory",
        { query: "foo" },
        "standard",
      ),
    ).toBeNull();
  });
});
