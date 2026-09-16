/**
 * D079 Phase 4 / G2 — `FILE_COMMAND_POLICIES` + resolver helpers tests.
 *
 * Covers:
 *   - The 10 commands shipping in Phase 4 each map to an expected
 *     severity (regression guard — if someone changes the table, a
 *     test has to change too).
 *   - Unknown commands fail-closed to `destructive_high`.
 *   - Null / undefined / non-string inputs tolerated without
 *     throwing (defensive — callers may pass pre-Zod LLM input).
 *   - `isDestructiveFileCommand` returns the correct boolean for
 *     every known command.
 *   - `formatFileToolVerb` produces `file.<command>` for the `file`
 *     tool and falls back to bare `toolName` for everything else.
 *   - `listFileCommandNames` round-trips every known command.
 *
 * Behavior-locking tests, not implementation tests — if someone
 * adds a new command or tightens a severity, these must be updated
 * in lockstep with `file-tool-policies.ts`. Test failures are the
 * audit trail.
 */

import { describe, test, expect } from "bun:test";
import {
  resolveFileCommandPolicy,
  isDestructiveFileCommand,
  listFileCommandNames,
  formatFileToolVerb,
  type FileCommandName,
  type FileCommandSeverity,
} from "../../src/file-tool-policies";

describe("resolveFileCommandPolicy — full command matrix", () => {
  const expected: Record<FileCommandName, FileCommandSeverity> = {
    // Phase 4 — filesystem commands
    list: "read_only",
    read: "read_only",
    glob: "read_only",
    grep: "read_only",
    stat: "read_only",
    // D087 Phase 1 §1.3 + §1.3.5 — every mutating command (content
    // AND structural) now stages through the substrate. Call-time is
    // inert; the DiffView Accept click is the HIL gate. Pre-stage
    // approval would double-gate and hide the helpful preview.
    write: "read_only",
    insert: "read_only",
    str_replace: "read_only",
    move: "read_only",
    copy: "read_only",
    delete: "read_only",
    // D087 Phase 3 §3.1 + §3.2 + §3.3 — history commands.
    // read_only at this layer because the DiffView Accept click(s)
    // are the real HIL gate, same reasoning as the other
    // staging-layer entries above.
    undo: "read_only",
    undo_turn: "read_only",
    redo: "read_only",
    // D087 Phase 3 §3.4 — pure enumeration, no side effects.
    list_revisions: "read_only",
    // D087 Phase 3 §3.5 — single-column UPDATE on the pinned flag.
    // No disk, no staging. Approval-dock-wise this is read_only.
    pin_revision: "read_only",
    unpin_revision: "read_only",
    // D089 Phase 1 — stages generated binary bytes; DiffView Accept is the gate.
    write_xlsx: "read_only",
    write_pptx: "read_only",
    // D121-P6 / M162 — block-edit commands. read_only at the approval
    // dock; the catalog forbidden-filter + namespace envelope is the
    // real boundary. Mutators apply immediately and are revertable.
    list_blocks: "read_only",
    read_block: "read_only",
    replace_block: "read_only",
    insert_block: "read_only",
    move_block: "read_only",
    rewrite_block: "read_only",
  };

  for (const [command, severity] of Object.entries(expected) as Array<[FileCommandName, FileCommandSeverity]>) {
    test(`${command} → ${severity}`, () => {
      expect(resolveFileCommandPolicy(command)).toBe(severity);
    });
  }
});

describe("resolveFileCommandPolicy — fail-closed on unknowns", () => {
  test("unknown command → destructive_high (never silently allowed)", () => {
    expect(resolveFileCommandPolicy("typo_command")).toBe("destructive_high");
    expect(resolveFileCommandPolicy("drop_database")).toBe("destructive_high");
    expect(resolveFileCommandPolicy("rm_rf")).toBe("destructive_high");
  });

  test("null / undefined / non-string → destructive_high (no throw)", () => {
    expect(resolveFileCommandPolicy(null)).toBe("destructive_high");
    expect(resolveFileCommandPolicy(undefined)).toBe("destructive_high");
    expect(resolveFileCommandPolicy(42 as unknown as string)).toBe("destructive_high");
    expect(resolveFileCommandPolicy({} as unknown as string)).toBe("destructive_high");
  });

  test("empty string → destructive_high", () => {
    expect(resolveFileCommandPolicy("")).toBe("destructive_high");
  });
});

describe("isDestructiveFileCommand — HIL gate predicate", () => {
  test("read / staging / structural-staging commands are all non-destructive at call time", () => {
    // D087 Phase 1 §1.3 + §1.3.5 — the full mutating matrix now runs
    // through the staged-patch substrate. isDestructiveFileCommand is
    // the HIL gate predicate; since staging is HIL-gated elsewhere
    // (the DiffView Accept click), every command in the matrix
    // returns false. The OS-level action still happens under the
    // external-change guard inside apply_patch.
    const allCommands = [
      "list",
      "read",
      "glob",
      "grep",
      "stat",
      "write",
      "insert",
      "str_replace",
      "move",
      "copy",
      "delete",
    ];
    for (const cmd of allCommands) {
      expect(isDestructiveFileCommand(cmd)).toBe(false);
    }
  });

  test("unknown command is destructive (fail-closed)", () => {
    expect(isDestructiveFileCommand("mystery")).toBe(true);
  });
});

describe("listFileCommandNames", () => {
  test("returns all known commands (filesystem + history + D089 office + D121-P6 block)", () => {
    const names = listFileCommandNames();
    const expected: FileCommandName[] = [
      "copy",
      "delete",
      "glob",
      "grep",
      "insert",
      "list",
      "move",
      "read",
      "stat",
      "str_replace",
      "undo",
      "undo_turn",
      "write",
      "redo",
      "list_revisions",
      "pin_revision",
      "unpin_revision",
      "write_xlsx",
      "write_pptx",
      "list_blocks",
      "read_block",
      "replace_block",
      "insert_block",
      "move_block",
      "rewrite_block",
    ];
    expect([...names].sort()).toEqual([...expected].sort());
  });

  test("every returned name has a valid policy (self-consistency)", () => {
    for (const name of listFileCommandNames()) {
      const policy = resolveFileCommandPolicy(name);
      expect(["read_only", "destructive_low", "destructive", "destructive_high"]).toContain(policy);
    }
  });
});

describe("formatFileToolVerb — approval-dock display helper", () => {
  test("'file' tool with command arg → 'file.<command>'", () => {
    expect(formatFileToolVerb("file", { command: "str_replace" })).toBe("file.str_replace");
    expect(formatFileToolVerb("file", { command: "read" })).toBe("file.read");
    expect(formatFileToolVerb("file", { command: "delete" })).toBe("file.delete");
  });

  test("'file' tool without command arg → bare 'file' (unusual but tolerated)", () => {
    expect(formatFileToolVerb("file", {})).toBe("file");
    expect(formatFileToolVerb("file", null)).toBe("file");
    expect(formatFileToolVerb("file", undefined)).toBe("file");
  });

  test("'file' tool with non-string command arg → bare 'file' (defensive)", () => {
    expect(formatFileToolVerb("file", { command: 42 })).toBe("file");
    expect(formatFileToolVerb("file", { command: null })).toBe("file");
    expect(formatFileToolVerb("file", { command: {} })).toBe("file");
  });

  test("non-'file' tool → bare toolName (no transformation)", () => {
    expect(formatFileToolVerb("run_shell", { command: "str_replace" })).toBe("run_shell");
    expect(formatFileToolVerb("transcribe_audio", { command: "list" })).toBe("transcribe_audio");
    expect(formatFileToolVerb("search_memory", null)).toBe("search_memory");
  });

  test("'file' as tool name but with extra fields still correctly routes on command", () => {
    expect(
      formatFileToolVerb("file", {
        command: "write",
        path: "/foo",
        zone: "workspace",
        content: "...",
      }),
    ).toBe("file.write");
  });
});
