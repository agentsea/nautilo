/**
 * Structured report formatter for smoke runs (D063 Phase 2.8).
 *
 * Inputs a `RunReport` and produces either JSON (machine-readable,
 * byte-stable so two runs of the same code produce identical output)
 * or Markdown (human-readable, suitable for PR comments).
 *
 * Pure functions — no filesystem access. Callers write the result.
 *
 * Consumers:
 *   - bin/nautilo-smoke run --report=<path> (replaces ad-hoc
 *     JSON.stringify in commands/run.ts)
 *   - bin/nautilo-smoke report --run-id=<id> --format=json|md
 *     (Phase 3.6 — reads persisted run state)
 *   - HTTP API GET /api/smoke/runs/:id/report (Phase 3.3)
 *   - stdio MCP `run_security_smoke` / `smoke_report` tools (Phase 4)
 */

import type { RunReport, TestResult, Platform } from "./types.ts";

export type ReportFormat = "json" | "md";

/**
 * Serialize a RunReport as stable JSON. Object keys are emitted in
 * alphabetical order at every depth so two runs of the same code
 * produce byte-identical output — critical for CI diff-on-regression.
 */
export function formatJson(report: RunReport): string {
  return JSON.stringify(report, stableKeyReplacer, 2) + "\n";
}

/**
 * Serialize a RunReport as Markdown. Intended for PR comments and
 * terminal-friendly review. Layout:
 *
 *   # Smoke run <runId>
 *   - meta line (platforms, mode, level, duration)
 *   - per-platform summary table
 *   - failures section (only if any)
 *   - VM-dead section (only if any)
 *   - warn section (only if any)
 */
export function formatMarkdown(report: RunReport): string {
  const out: string[] = [];

  out.push(`# Smoke run ${report.runId}`);
  out.push("");
  out.push(metaLine(report));
  out.push("");

  out.push("## Summary");
  out.push("");
  out.push(summaryTable(report));
  out.push("");

  const failures = report.results.filter((r) => r.outcome === "fail");
  if (failures.length > 0) {
    out.push(`## Failures (${failures.length})`);
    out.push("");
    for (const r of failures) out.push(formatFailure(r));
    out.push("");
  }

  const vmDead = report.results.filter((r) => r.outcome === "vm_dead");
  if (vmDead.length > 0) {
    out.push(`## VM dead during test (${vmDead.length})`);
    out.push("");
    for (const r of vmDead) out.push(formatVmDead(r));
    out.push("");
  }

  const warns = report.results.filter((r) => r.outcome === "warn");
  if (warns.length > 0) {
    out.push(`## Warnings — unexpected allow but no damage (${warns.length})`);
    out.push("");
    for (const r of warns) out.push(formatWarn(r));
    out.push("");
  }

  const errors = report.results.filter((r) => r.outcome === "error");
  if (errors.length > 0) {
    out.push(`## Harness errors (${errors.length})`);
    out.push("");
    for (const r of errors) out.push(formatError(r));
    out.push("");
  }

  return out.join("\n");
}

/**
 * Format a RunReport in the chosen format. Thin dispatcher.
 */
export function formatReport(report: RunReport, format: ReportFormat): string {
  return format === "json" ? formatJson(report) : formatMarkdown(report);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * JSON.stringify replacer that sorts object keys alphabetically. Arrays
 * preserve insertion order (they carry meaningful ordering, e.g. the
 * chronological results list). Primitives pass through untouched.
 */
function stableKeyReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}

function metaLine(report: RunReport): string {
  const duration = formatDuration(report.durationMs);
  return [
    `**Started**: ${report.startedAt}`,
    `**Duration**: ${duration}`,
    `**Platform**: ${report.platform}`,
    `**Mode**: ${report.mode}`,
    `**Security level**: ${report.securityLevel}`,
    report.gitCommit ? `**Commit**: \`${report.gitCommit.slice(0, 12)}\`` : "",
    report.gitBranch ? `**Branch**: \`${report.gitBranch}\`` : "",
  ]
    .filter(Boolean)
    .join("  \n");
}

function summaryTable(report: RunReport): string {
  // One row per platform observed in results, plus a total row if >1.
  const byPlatform = new Map<Platform, TallyRow>();
  for (const r of report.results) {
    const t = byPlatform.get(r.platform) ?? { pass: 0, fail: 0, warn: 0, vmDead: 0, skipped: 0, error: 0, total: 0 };
    t[tallyKey(r.outcome)]++;
    t.total++;
    byPlatform.set(r.platform, t);
  }

  const lines: string[] = [];
  lines.push("| Platform | Pass | Fail | Warn | VM dead | Skipped | Error | Total |");
  lines.push("|----------|------|------|------|---------|---------|-------|-------|");
  for (const [platform, t] of Array.from(byPlatform.entries()).sort()) {
    lines.push(`| ${platform.padEnd(8)} | ${t.pass} | ${t.fail} | ${t.warn} | ${t.vmDead} | ${t.skipped} | ${t.error} | ${t.total} |`);
  }
  if (byPlatform.size > 1) {
    const s = report.summary;
    lines.push(`| **total** | **${s.pass}** | **${s.fail}** | **${s.warn}** | **${s.vmDead}** | **${s.skipped}** | **${s.error}** | **${s.total}** |`);
  }
  return lines.join("\n");
}

interface TallyRow {
  pass: number;
  fail: number;
  warn: number;
  vmDead: number;
  skipped: number;
  error: number;
  total: number;
}

function tallyKey(outcome: TestResult["outcome"]): Exclude<keyof TallyRow, "total"> {
  switch (outcome) {
    case "pass":    return "pass";
    case "fail":    return "fail";
    case "warn":    return "warn";
    case "vm_dead": return "vmDead";
    case "skipped": return "skipped";
    case "error":   return "error";
  }
}

function formatFailure(r: TestResult): string {
  const lines: string[] = [];
  lines.push(`### \`${r.testId}\` (${r.platform}) — ${r.outcome}`);
  lines.push("");
  lines.push(`- **Duration**: ${formatDuration(r.durationMs)}`);
  lines.push(`- **Blocked**: ${r.blocked === null ? "n/a" : r.blocked ? "yes" : "no"}`);
  if (r.reasonPhrase) lines.push(`- **Reason**: ${r.reasonPhrase}`);
  if (r.messages.length > 0) {
    lines.push(`- **Messages**:`);
    for (const m of r.messages) lines.push(`  - ${truncate(m, 200)}`);
  }
  if (r.honeypotVerifyAfter && !r.honeypotVerifyAfter.ok) {
    const hp = r.honeypotVerifyAfter;
    const parts: string[] = [];
    if (hp.leaked > 0) parts.push(`${hp.leaked} sentinel(s) LEAKED into transcript`);
    if (hp.missing > 0) parts.push(`${hp.missing} fixture(s) missing`);
    lines.push(`- **Honeypot**: ${parts.join("; ") || "verify failed"}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatVmDead(r: TestResult): string {
  const lines: string[] = [];
  lines.push(`### \`${r.testId}\` (${r.platform}) — VM died during test`);
  lines.push("");
  const dead = r.watchdogEvents.find((e) => !e.ok);
  if (dead) {
    lines.push(`- **Probe that failed**: \`${dead.probe}\`${dead.detail ? " — " + truncate(dead.detail, 200) : ""}`);
  }
  lines.push(`- **Duration before death**: ${formatDuration(r.durationMs)}`);
  lines.push("");
  return lines.join("\n");
}

function formatWarn(r: TestResult): string {
  const lines: string[] = [];
  lines.push(`### \`${r.testId}\` (${r.platform}) — allowed but no damage`);
  lines.push("");
  lines.push(`- **Command**: \`${truncate(r.reasonPhrase ?? "", 120)}\``);
  if (r.messages.length > 0) lines.push(`- **Response**: ${truncate(r.messages[0]!, 200)}`);
  lines.push("");
  return lines.join("\n");
}

function formatError(r: TestResult): string {
  const lines: string[] = [];
  lines.push(`### \`${r.testId}\` (${r.platform}) — harness error`);
  lines.push("");
  if (r.errorDetail) lines.push(`- **Detail**: ${truncate(r.errorDetail, 400)}`);
  lines.push("");
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
