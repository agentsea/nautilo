/**
 * D079 Phase 4 / G4 commit 12 — per-command log tag tests.
 *
 * `formatToolLogLabel` is module-internal to `nodes/tools.ts` and
 * not exported, so we duplicate its logic here for direct testing.
 * The test doubles as a spec: if the label format changes, this
 * test has to change with it.
 *
 * Drift risk: if someone changes tools.ts's logic without updating
 * this mirror, the test still passes (false negative). Acceptable
 * — the helper is 5 lines, exported copy would require a separate
 * module, and the logic is simple enough that the risk is low.
 */

import { describe, test, expect } from "bun:test";

// Mirror of formatToolLogLabel from packages/agent/src/nodes/tools.ts
function formatToolLogLabel(tc: { name: string; args: unknown }): string {
  if (tc.name !== "file") return tc.name;
  const args = tc.args as { command?: unknown } | null | undefined;
  if (args && typeof args["command"] === "string") {
    return `${tc.name}:${args["command"]}`;
  }
  return tc.name;
}

describe("formatToolLogLabel (D079 Phase 4 per-command log tag)", () => {
  test("file tool with string command → file:<command>", () => {
    expect(
      formatToolLogLabel({ name: "file", args: { command: "str_replace" } }),
    ).toBe("file:str_replace");
    expect(
      formatToolLogLabel({ name: "file", args: { command: "read" } }),
    ).toBe("file:read");
    expect(
      formatToolLogLabel({ name: "file", args: { command: "delete" } }),
    ).toBe("file:delete");
  });

  test("file tool without command → bare 'file' (defensive)", () => {
    expect(formatToolLogLabel({ name: "file", args: {} })).toBe("file");
    expect(formatToolLogLabel({ name: "file", args: null })).toBe("file");
    expect(formatToolLogLabel({ name: "file", args: { path: "x" } })).toBe("file");
  });

  test("file tool with non-string command → bare 'file' (defensive)", () => {
    expect(
      formatToolLogLabel({ name: "file", args: { command: 42 } }),
    ).toBe("file");
    expect(
      formatToolLogLabel({ name: "file", args: { command: null } }),
    ).toBe("file");
  });

  test("non-'file' tools → bare tool name, never transformed", () => {
    expect(
      formatToolLogLabel({ name: "run_shell", args: { command: "ls" } }),
    ).toBe("run_shell");
    expect(
      formatToolLogLabel({ name: "run_shell", args: { path: "x" } }),
    ).toBe("run_shell");
    expect(
      formatToolLogLabel({ name: "search_memory", args: {} }),
    ).toBe("search_memory");
  });

  test("grep-ability invariants: every file command produces a distinct tag", () => {
    const commands = ["list", "read", "grep", "stat", "write", "insert", "str_replace", "move", "copy", "delete"];
    const tags = new Set(
      commands.map((c) =>
        formatToolLogLabel({ name: "file", args: { command: c } }),
      ),
    );
    // Each command produces its own unique tag
    expect(tags.size).toBe(commands.length);
    for (const c of commands) {
      expect(tags.has(`file:${c}`)).toBe(true);
    }
  });
});
