/**
 * D440 Phase 3 — strict parser for the structured `run_shell` git operation
 * variant (`parseRelayRunShellGitOperation`).
 *
 * The parser is the desktop relay's JSON ingress gate: it admits ONLY the six
 * bounded broker operations with explicit `paths` / `message` / `ref` /
 * `target` fields, and rejects pathspec magic, extra keys, wrong types, and
 * missing required fields. A raw `command: "git ..."` is never parsed here —
 * it stays on the ordinary sandboxed shell path.
 */

import { describe, expect, test } from "bun:test";
import { parseRelayRunShellGitOperation } from "../../src/protocol";

describe("D440 Phase 3 — parseRelayRunShellGitOperation", () => {
  test("status admits only `operation`", () => {
    expect(parseRelayRunShellGitOperation({ operation: "status" })).toEqual({
      ok: true,
      operation: { operation: "status" },
    });
  });

  test("status with extra key fails closed", () => {
    expect(parseRelayRunShellGitOperation({ operation: "status", ref: "HEAD" }).ok).toBe(false);
  });

  test("diff without ref", () => {
    expect(parseRelayRunShellGitOperation({ operation: "diff" })).toEqual({
      ok: true,
      operation: { operation: "diff" },
    });
  });

  test("diff with a bare ref", () => {
    const r = parseRelayRunShellGitOperation({ operation: "diff", ref: "HEAD" });
    expect(r).toEqual({ ok: true, operation: { operation: "diff", ref: "HEAD" } });
  });

  test("diff with pathspec magic ref fails", () => {
    expect(parseRelayRunShellGitOperation({ operation: "diff", ref: ":(glob)**" }).ok).toBe(false);
  });

  test("add with a non-empty paths array", () => {
    const r = parseRelayRunShellGitOperation({ operation: "add", paths: ["a.txt", "b.txt"] });
    expect(r.ok).toBe(true);
    if (r.ok && r.operation.operation === "add") {
      expect(r.operation.paths).toEqual(["a.txt", "b.txt"]);
    }
  });

  test("add with empty paths fails", () => {
    expect(parseRelayRunShellGitOperation({ operation: "add", paths: [] }).ok).toBe(false);
  });

  test("add with pathspec magic in a path fails", () => {
    expect(parseRelayRunShellGitOperation({ operation: "add", paths: [":(magic)x"] }).ok).toBe(false);
  });

  test("add with a non-string path fails", () => {
    expect(parseRelayRunShellGitOperation({ operation: "add", paths: ["ok", 7] }).ok).toBe(false);
  });

  test("commit with a non-blank message", () => {
    const r = parseRelayRunShellGitOperation({ operation: "commit", message: "broker commit" });
    expect(r).toEqual({ ok: true, operation: { operation: "commit", message: "broker commit" } });
  });

  test("commit with a blank message fails", () => {
    expect(parseRelayRunShellGitOperation({ operation: "commit", message: "   " }).ok).toBe(false);
  });

  test("worktree-add with absolute target and ref", () => {
    const r = parseRelayRunShellGitOperation({
      operation: "worktree-add",
      target: "/Users/test/wt",
      ref: "HEAD",
    });
    expect(r).toEqual({
      ok: true,
      operation: { operation: "worktree-add", target: "/Users/test/wt", ref: "HEAD" },
    });
  });

  test("worktree-add with a relative target fails (must be absolute)", () => {
    expect(
      parseRelayRunShellGitOperation({ operation: "worktree-add", target: "wt", ref: "HEAD" }).ok,
    ).toBe(false);
  });

  test("worktree-add with pathspec magic ref fails", () => {
    expect(
      parseRelayRunShellGitOperation({
        operation: "worktree-add",
        target: "/Users/test/wt",
        ref: ":**",
      }).ok,
    ).toBe(false);
  });

  test("worktree-remove with absolute target", () => {
    const r = parseRelayRunShellGitOperation({ operation: "worktree-remove", target: "/Users/test/wt" });
    expect(r).toEqual({ ok: true, operation: { operation: "worktree-remove", target: "/Users/test/wt" } });
  });

  test("worktree-remove with extra key fails", () => {
    expect(
      parseRelayRunShellGitOperation({ operation: "worktree-remove", target: "/x", ref: "HEAD" }).ok,
    ).toBe(false);
  });

  test("unknown operation fails", () => {
    expect(parseRelayRunShellGitOperation({ operation: "stash" }).ok).toBe(false);
    expect(parseRelayRunShellGitOperation({ operation: "push" }).ok).toBe(false);
    expect(parseRelayRunShellGitOperation({ operation: "reset" }).ok).toBe(false);
  });

  test("non-object value fails", () => {
    expect(parseRelayRunShellGitOperation("git status").ok).toBe(false);
    expect(parseRelayRunShellGitOperation(null).ok).toBe(false);
    expect(parseRelayRunShellGitOperation(undefined).ok).toBe(false);
    expect(parseRelayRunShellGitOperation([]).ok).toBe(false);
  });

  test("missing operation discriminator fails", () => {
    expect(parseRelayRunShellGitOperation({ paths: ["a"] }).ok).toBe(false);
  });

  test("NUL bytes in any string field fail", () => {
    expect(parseRelayRunShellGitOperation({ operation: "commit", message: "bad\0msg" }).ok).toBe(false);
    expect(parseRelayRunShellGitOperation({ operation: "add", paths: ["bad\0path"] }).ok).toBe(false);
  });
});
