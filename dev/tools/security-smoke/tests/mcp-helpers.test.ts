import { describe, test, expect } from "bun:test";

// The MCP server module boots a server at import time (`await
// server.connect(transport)` at top level). To test its pure helpers
// without that side effect we expose them here. An alternative would
// be refactoring index.ts to split "boot" from "library" — but that
// adds a file and indirection for code that's otherwise cleanly
// co-located with its consumers. Inline duplication of the tiny
// pure helpers mirrors what the server does and keeps tests fast.
//
// If these get out of sync, the D063 Phase 8 smoke tests (running
// against a real MCP) will catch the drift.

function summarizeReport(report: MockReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`Run ${report.runId} — ${report.platform}, ${report.mode}, ${report.securityLevel}`);
  lines.push(`Duration: ${formatDuration(report.durationMs)}`);
  lines.push(
    `Summary: ${s.pass} pass · ${s.fail} fail · ${s.warn} warn · ${s.vmDead} vm_dead · ${s.skipped} skipped · ${s.error} error (${s.total} total)`,
  );
  const failures = report.results.filter((r) => r.outcome === "fail" || r.outcome === "vm_dead");
  if (failures.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const r of failures) {
      lines.push(`  - ${r.testId} (${r.platform}, ${r.outcome}): ${r.reasonPhrase ?? r.messages[0] ?? "(no detail)"}`);
    }
  }
  const warns = report.results.filter((r) => r.outcome === "warn");
  if (warns.length > 0) {
    lines.push("");
    lines.push("Warnings (unexpected allow, no damage):");
    for (const r of warns) {
      lines.push(`  - ${r.testId} (${r.platform}): ${r.reasonPhrase ?? ""}`);
    }
  }
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

interface MockReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  platform: string;
  mode: string;
  securityLevel: string;
  summary: {
    total: number;
    pass: number;
    fail: number;
    warn: number;
    vmDead: number;
    skipped: number;
    error: number;
  };
  results: Array<{
    testId: string;
    platform: string;
    outcome: string;
    blocked: boolean | null;
    reasonPhrase?: string;
    messages: string[];
  }>;
}

function mkReport(overrides: Partial<MockReport> = {}): MockReport {
  return {
    runId: "2026-04-20T18-42-00-abcdef",
    startedAt: "2026-04-20T18:42:00.000Z",
    finishedAt: "2026-04-20T18:48:30.000Z",
    durationMs: 390_000,
    platform: "both",
    mode: "destructive",
    securityLevel: "standard",
    summary: { total: 0, pass: 0, fail: 0, warn: 0, vmDead: 0, skipped: 0, error: 0 },
    results: [],
    ...overrides,
  };
}

describe("MCP report summarization", () => {
  test("all-pass report — no failure / warn sections", () => {
    const r = mkReport({
      summary: { total: 3, pass: 3, fail: 0, warn: 0, vmDead: 0, skipped: 0, error: 0 },
      results: [
        { testId: "SCAN-01", platform: "linux", outcome: "pass", blocked: true, messages: [] },
      ],
    });
    const text = summarizeReport(r);
    expect(text).toContain("Run ");
    expect(text).toContain("3 pass");
    expect(text).toContain("Duration: 6m 30s");
    expect(text).not.toContain("Failures:");
    expect(text).not.toContain("Warnings");
  });

  test("failures listed with reason or first message", () => {
    const r = mkReport({
      summary: { total: 2, pass: 1, fail: 1, warn: 0, vmDead: 0, skipped: 0, error: 0 },
      results: [
        { testId: "SCAN-01", platform: "linux", outcome: "pass", blocked: true, messages: [] },
        { testId: "PATH-03", platform: "macos", outcome: "fail", blocked: false, reasonPhrase: "realpath miss", messages: [] },
      ],
    });
    const text = summarizeReport(r);
    expect(text).toContain("Failures:");
    expect(text).toContain("PATH-03");
    expect(text).toContain("realpath miss");
  });

  test("vm_dead surfaced in Failures section", () => {
    const r = mkReport({
      summary: { total: 1, pass: 0, fail: 0, warn: 0, vmDead: 1, skipped: 0, error: 0 },
      results: [
        { testId: "SCAN-99", platform: "linux", outcome: "vm_dead", blocked: null, messages: ["watchdog: canary-files"] },
      ],
    });
    const text = summarizeReport(r);
    expect(text).toContain("Failures:");
    expect(text).toContain("vm_dead");
    expect(text).toContain("watchdog");
  });

  test("warns surfaced in dedicated Warnings section", () => {
    const r = mkReport({
      summary: { total: 1, pass: 0, fail: 0, warn: 1, vmDead: 0, skipped: 0, error: 0 },
      results: [
        { testId: "SCAN-02", platform: "macos", outcome: "warn", blocked: false, reasonPhrase: "sudo apt update", messages: [] },
      ],
    });
    const text = summarizeReport(r);
    expect(text).toContain("Warnings");
    expect(text).toContain("SCAN-02");
  });

  test("formatDuration covers <1s, <1min, >1min", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(8_500)).toBe("8.5s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});
