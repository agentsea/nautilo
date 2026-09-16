import { describe, test, expect } from "bun:test";
import type { RunReport, TestResult } from "../../src/types";
import { formatJson, formatMarkdown, formatReport } from "../../src/reporter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    testId: "TEST-01",
    platform: "linux",
    mode: "destructive",
    securityLevel: "standard",
    outcome: "pass",
    startedAt: "2026-04-20T18:00:00.000Z",
    finishedAt: "2026-04-20T18:00:04.210Z",
    durationMs: 4210,
    blocked: true,
    messages: ["Security: command blocked"],
    watchdogEvents: [],
    ...overrides,
  };
}

function mkReport(results: TestResult[], overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: "2026-04-20T18-42-00Z-abcd",
    startedAt: "2026-04-20T18:42:00.000Z",
    finishedAt: "2026-04-20T18:48:30.000Z",
    durationMs: 390000,
    platform: "both",
    mode: "destructive",
    securityLevel: "standard",
    results,
    summary: summarize(results),
    ...overrides,
  };
}

function summarize(results: TestResult[]): RunReport["summary"] {
  const base = { total: results.length, pass: 0, fail: 0, warn: 0, vmDead: 0, skipped: 0, error: 0 };
  for (const r of results) {
    if (r.outcome === "pass") base.pass++;
    else if (r.outcome === "fail") base.fail++;
    else if (r.outcome === "warn") base.warn++;
    else if (r.outcome === "vm_dead") base.vmDead++;
    else if (r.outcome === "skipped") base.skipped++;
    else if (r.outcome === "error") base.error++;
  }
  return base;
}

// ---------------------------------------------------------------------------
// formatJson — byte-stable key ordering
// ---------------------------------------------------------------------------

describe("formatJson — byte-stable output", () => {
  test("keys are alphabetically sorted at every depth", () => {
    const r = mkReport([mkResult()]);
    const json = formatJson(r);
    // Find the first "durationMs" and "finishedAt" lines; they should
    // appear in sort order (durationMs < finishedAt).
    const iDur = json.indexOf(`"durationMs"`);
    const iFin = json.indexOf(`"finishedAt"`);
    expect(iDur).toBeGreaterThan(-1);
    expect(iFin).toBeGreaterThan(iDur);
  });

  test("two calls on the same input produce identical output", () => {
    const r = mkReport([mkResult(), mkResult({ testId: "TEST-02", outcome: "fail" })]);
    expect(formatJson(r)).toBe(formatJson(r));
  });

  test("two reports with semantically equal content produce identical output regardless of key insertion order", () => {
    const a = mkReport([mkResult()]);
    // Build an equivalent report with same logical content but keys
    // reconstructed in a different order.
    const b: RunReport = {
      durationMs: a.durationMs,
      mode: a.mode,
      finishedAt: a.finishedAt,
      platform: a.platform,
      results: a.results,
      runId: a.runId,
      securityLevel: a.securityLevel,
      startedAt: a.startedAt,
      summary: a.summary,
    };
    expect(formatJson(a)).toBe(formatJson(b));
  });

  test("output ends with a trailing newline", () => {
    const r = mkReport([mkResult()]);
    expect(formatJson(r).endsWith("\n")).toBe(true);
  });

  test("arrays preserve insertion order (not sorted)", () => {
    // The results array is chronologically ordered; sorting would
    // destroy meaningful information.
    const r = mkReport([
      mkResult({ testId: "B-LATER", startedAt: "2026-04-20T18:00:02.000Z" }),
      mkResult({ testId: "A-EARLIER", startedAt: "2026-04-20T18:00:01.000Z" }),
    ]);
    const json = formatJson(r);
    expect(json.indexOf("B-LATER")).toBeLessThan(json.indexOf("A-EARLIER"));
  });

  test("null and primitive values pass through unchanged", () => {
    const r = mkReport([mkResult({ blocked: null })]);
    const parsed = JSON.parse(formatJson(r)) as RunReport;
    expect(parsed.results[0]!.blocked).toBeNull();
    // reasonPhrase is optional — absence round-trips as undefined.
    expect(parsed.results[0]!.reasonPhrase).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatMarkdown — human-readable output
// ---------------------------------------------------------------------------

describe("formatMarkdown — human-readable output", () => {
  test("all-pass report includes summary table, no failure section", () => {
    const r = mkReport([
      mkResult({ testId: "A", platform: "linux", outcome: "pass" }),
      mkResult({ testId: "B", platform: "macos", outcome: "pass" }),
    ]);
    const md = formatMarkdown(r);
    expect(md).toContain("# Smoke run ");
    expect(md).toContain("## Summary");
    expect(md).toContain("| Platform ");
    expect(md).toContain("linux  ");
    expect(md).toContain("macos  ");
    expect(md).not.toContain("## Failures");
    expect(md).not.toContain("## Warnings");
    expect(md).not.toContain("## Harness errors");
  });

  test("failure section lists each failure with reason", () => {
    const r = mkReport([
      mkResult({ testId: "PATH-03", platform: "macos", outcome: "fail", reasonPhrase: "realpath did not resolve /private/var" }),
    ]);
    const md = formatMarkdown(r);
    expect(md).toContain("## Failures (1)");
    expect(md).toContain("`PATH-03`");
    expect(md).toContain("macos");
    expect(md).toContain("realpath did not resolve /private/var");
  });

  test("vm_dead results appear in their own section with probe detail", () => {
    const r = mkReport([
      mkResult({
        testId: "SCAN-02",
        outcome: "vm_dead",
        watchdogEvents: [
          { at: "2026-04-20T18:00:01.000Z", probe: "ssh", ok: true },
          { at: "2026-04-20T18:00:04.000Z", probe: "canary-files", ok: false, detail: "/etc/hostname unreadable" },
        ],
      }),
    ]);
    const md = formatMarkdown(r);
    expect(md).toContain("## VM dead during test (1)");
    expect(md).toContain("canary-files");
    expect(md).toContain("/etc/hostname unreadable");
  });

  test("warn results appear in their own section", () => {
    const r = mkReport([
      mkResult({
        testId: "SCAN-99",
        outcome: "warn",
        blocked: false,
        reasonPhrase: "sudo apt update",
        messages: ["nothing blocked, command was inert in this env"],
      }),
    ]);
    const md = formatMarkdown(r);
    expect(md).toContain("## Warnings");
    expect(md).toContain("SCAN-99");
    expect(md).toContain("sudo apt update");
  });

  test("multi-platform summary includes total row", () => {
    const r = mkReport([
      mkResult({ platform: "linux", outcome: "pass" }),
      mkResult({ platform: "linux", outcome: "fail" }),
      mkResult({ platform: "macos", outcome: "pass" }),
    ]);
    const md = formatMarkdown(r);
    expect(md).toContain("**total**");
  });

  test("single-platform summary omits total row", () => {
    const r = mkReport([mkResult({ platform: "linux" })], { platform: "linux" });
    const md = formatMarkdown(r);
    expect(md).not.toContain("**total**");
  });

  test("meta line includes git commit and branch when present", () => {
    const r = mkReport([mkResult()], {
      gitCommit: "abcdef1234567890",
      gitBranch: "dj-test",
    });
    const md = formatMarkdown(r);
    expect(md).toContain("abcdef123456");
    expect(md).toContain("dj-test");
  });

  test("meta line omits git fields when absent", () => {
    const r = mkReport([mkResult()]);
    const md = formatMarkdown(r);
    expect(md).not.toContain("**Commit**");
    expect(md).not.toContain("**Branch**");
  });

  test("truncates very long messages in failure section", () => {
    const longMsg = "x".repeat(500);
    const r = mkReport([mkResult({ outcome: "fail", messages: [longMsg] })]);
    const md = formatMarkdown(r);
    expect(md).toContain("…");
    // Full 500 chars should not be present; truncation cap is 200.
    expect(md).not.toContain(longMsg);
  });

  test("honeypot leak surfaces in failure block", () => {
    const r = mkReport([
      mkResult({
        outcome: "fail",
        honeypotVerifyAfter: {
          ok: false,
          unchanged: 3,
          leaked: 1,
          missing: 0,
          details: "FAKE_NAUTILO_SMOKE_id_rsa appeared in transcript",
        },
      }),
    ]);
    const md = formatMarkdown(r);
    expect(md).toContain("LEAKED");
    expect(md).toContain("sentinel");
  });

  test("honeypot missing-fixture surfaces alongside leaks", () => {
    const r = mkReport([
      mkResult({
        outcome: "fail",
        honeypotVerifyAfter: {
          ok: false,
          unchanged: 2,
          leaked: 0,
          missing: 2,
        },
      }),
    ]);
    const md = formatMarkdown(r);
    expect(md).toContain("fixture(s) missing");
  });
});

// ---------------------------------------------------------------------------
// formatReport — dispatcher
// ---------------------------------------------------------------------------

describe("formatReport — dispatcher", () => {
  test("dispatches to JSON or Markdown based on format arg", () => {
    const r = mkReport([mkResult()]);
    expect(formatReport(r, "json")).toBe(formatJson(r));
    expect(formatReport(r, "md")).toBe(formatMarkdown(r));
  });
});
