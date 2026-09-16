/**
 * D083 Phase 2 — unit tests for the run_shell renderer's pure
 * helper (result-text parser). The React component itself is
 * live-verified in Electron; this file covers the JSON shape
 * handling so new relay output shapes / malformed payloads
 * degrade gracefully.
 */

import { describe, test, expect } from "bun:test";
import {
  parseShellResult,
  runShellContextLabel,
} from "../../src/components/tool-card/renderers/run-shell";

describe("parseShellResult (D083 Phase 2)", () => {
  test("undefined input returns empty object (no output to render)", () => {
    expect(parseShellResult(undefined)).toEqual({});
  });

  test("plain string result (simple relay or custom tool) falls through to raw", () => {
    expect(parseShellResult("hello from the shell\n")).toEqual({
      raw: "hello from the shell\n",
    });
  });

  test("canonical {stdout, stderr} relay shape parses cleanly", () => {
    const raw = JSON.stringify({
      stdout: "phase-2-result-test\n       2 /tmp/log",
      stderr: "",
    });
    const out = parseShellResult(raw);
    expect(out.stdout).toBe("phase-2-result-test\n       2 /tmp/log");
    expect(out.stderr).toBe("");
    expect(out.raw).toBeUndefined();
  });

  test("stdout-only payload", () => {
    const raw = JSON.stringify({ stdout: "ok\n" });
    const out = parseShellResult(raw);
    expect(out.stdout).toBe("ok\n");
    expect(out.stderr).toBeUndefined();
  });

  test("stderr-only payload (command had no stdout but errored)", () => {
    const raw = JSON.stringify({ stderr: "command not found\n" });
    const out = parseShellResult(raw);
    expect(out.stderr).toBe("command not found\n");
    expect(out.stdout).toBeUndefined();
  });

  test("payload with exitCode", () => {
    const raw = JSON.stringify({
      stdout: "",
      stderr: "exited badly",
      exitCode: 127,
    });
    const out = parseShellResult(raw);
    expect(out.exitCode).toBe(127);
    expect(out.stderr).toBe("exited badly");
  });

  test("D502 DesktopShellResult preserves final process disposition and per-stream truncation", () => {
    const out = parseShellResult(JSON.stringify({
      execution: "workstation",
      stdout: "build output\n",
      stderr: "warning\n",
      exitCode: 137,
      signal: "SIGKILL",
      timedOut: true,
      cancelled: false,
      durationMs: 60_000,
      stdoutTruncated: true,
      stderrTruncated: false,
      sideEffectsMayHaveStarted: true,
    }));
    expect(out).toMatchObject({
      execution: "workstation",
      stdout: "build output\n",
      stderr: "warning\n",
      exitCode: 137,
      signal: "SIGKILL",
      timedOut: true,
      cancelled: false,
      durationMs: 60_000,
      stdoutTruncated: true,
      stderrTruncated: false,
      sideEffectsMayHaveStarted: true,
    });
  });

  test("D505 literal-search continuation parses bounded stream and artifact offsets", () => {
    const out = parseShellResult(JSON.stringify({
      version: 1,
      operation: "search",
      reference: "a".repeat(43),
      matches: [{
        stream: "stderr",
        matchOffsetBytes: 9,
        artifactOffsetBytes: 48,
        matchBytes: 4,
        contextOffsetBytes: 0,
        context: "warn FAIL details",
      }],
      totalMatches: 1,
      matchesTruncated: false,
      capturedBytes: 96,
      totalBytes: 96,
      truncated: false,
      expiresAt: "2026-08-07T12:00:00.000Z",
    }));
    expect(out.outputArtifactSearch).toEqual({
      matches: [{
        stream: "stderr",
        matchOffsetBytes: 9,
        artifactOffsetBytes: 48,
        matchBytes: 4,
        contextOffsetBytes: 0,
        context: "warn FAIL details",
      }],
      totalMatches: 1,
      matchesTruncated: false,
      capturedBytes: 96,
      totalBytes: 96,
      truncated: false,
      expiresAt: "2026-08-07T12:00:00.000Z",
    });
  });

  test("D505 malformed literal-search continuation falls through without inventing matches", () => {
    const raw = JSON.stringify({
      version: 1,
      operation: "search",
      matches: [{ stream: "stderr", matchOffsetBytes: 9 }],
    });
    expect(parseShellResult(raw)).toEqual({ raw });
  });

  test("malformed JSON (truncated mid-stream) falls through to raw", () => {
    const raw = '{"stdout": "incomp';
    const out = parseShellResult(raw);
    expect(out.raw).toBe(raw);
    expect(out.stdout).toBeUndefined();
  });

  test("non-shell JSON (object with unrelated fields) falls through to raw", () => {
    const raw = JSON.stringify({ result: "something", count: 3 });
    const out = parseShellResult(raw);
    expect(out.raw).toBe(raw);
  });

  test("JSON array (unexpected shape) falls through to raw", () => {
    const raw = JSON.stringify(["line 1", "line 2"]);
    const out = parseShellResult(raw);
    expect(out.raw).toBe(raw);
  });

  test("JSON with non-string stdout field (defensive against type drift) falls through", () => {
    const raw = JSON.stringify({ stdout: 42 });
    const out = parseShellResult(raw);
    expect(out.raw).toBe(raw);
    expect(out.stdout).toBeUndefined();
  });

  test("result starts with '{' but isn't JSON (e.g. a shell brace-expansion echo) falls through", () => {
    const raw = "{a,b,c}";
    const out = parseShellResult(raw);
    expect(out.raw).toBe(raw);
  });

  test("result starts with whitespace + JSON is still parsed", () => {
    const raw = "\n  " + JSON.stringify({ stdout: "ok" });
    const out = parseShellResult(raw);
    expect(out.stdout).toBe("ok");
  });

  test("empty string result → raw empty (rendered as '(no output)' by the component)", () => {
    const out = parseShellResult("");
    expect(out.raw).toBe("");
    expect(out.stdout).toBeUndefined();
  });
});

describe("runShellContextLabel (D502)", () => {
  test("labels the default sandboxed Current Folder", () => {
    expect(runShellContextLabel({ command: "pwd" })).toBe("Current Folder · sandboxed");
  });

  test("labels an explicit workstation command in a contained cwd", () => {
    expect(runShellContextLabel({ command: "pwd", execution: "workstation", cwd: "apps/workbench" })).toBe(
      "Current Folder / apps/workbench · explicit workstation",
    );
  });

  test("uses the canonical workstation receipt when live args were redacted", () => {
    expect(runShellContextLabel({}, "workstation")).toBe("Local workspace · explicit workstation");
  });

  test("does not present untrusted absolute or traversal cwd args as execution context", () => {
    expect(runShellContextLabel({ cwd: "/private/secret" })).toBe("Current Folder · sandboxed");
    expect(runShellContextLabel({ cwd: "../../private/secret" })).toBe("Current Folder · sandboxed");
  });
});
