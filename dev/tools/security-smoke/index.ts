#!/usr/bin/env node
/**
 * Nautilo Security Smoke — stdio MCP server.
 *
 * Exposes 6 tools that drive the security smoke harness (@nautilo/smoke-runner)
 * via the local HTTP API (`nautilo-smoke serve` from D063 Phase 3).
 *
 * Agents — Cursor, Claude Desktop, Nautilo itself — add this to their
 * MCP config and can then ask natural-language questions like
 *   "run the path-deny suite on macOS and summarize what failed"
 * which the agent translates into `run_security_smoke({ pattern: "PATH-*",
 * platform: "macos" })` and gets back a structured report.
 *
 * Sibling of `dev/tools/electron-debug/`. Same stdio MCP shape, zero
 * dependencies on the rest of the monorepo — just `@modelcontextprotocol/sdk`
 * and `zod`. The server spawns its own fetches against 127.0.0.1; it
 * does NOT import `@nautilo/smoke-runner` directly because that would
 * pull the workspace graph into agents' config paths.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Config — env-driven so agents can point at non-default server
// ---------------------------------------------------------------------------

const SERVER_URL = (process.env["NAUTILO_SMOKE_URL"] ?? "http://127.0.0.1:7788").replace(/\/$/, "");
const TOKEN_FILE = join(homedir(), ".nautilo", "smoke-token");

function resolveToken(): string {
  const envValue = process.env["NAUTILO_SMOKE_TOKEN"];
  if (envValue && envValue.trim().length > 0) return envValue.trim();
  if (existsSync(TOKEN_FILE)) {
    const body = readFileSync(TOKEN_FILE, "utf8").trim();
    if (body.length > 0) return body;
  }
  throw new Error(
    `NAUTILO_SMOKE_TOKEN not set and ${TOKEN_FILE} missing or empty. ` +
    `Run \`nautilo-smoke serve\` first to bootstrap the token.`,
  );
}

/**
 * Thin fetch wrapper that adds the bearer token + sane error surface.
 * The MCP tools call this rather than raw fetch so error messages are
 * consistent across tools.
 */
async function smokeFetch<T>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${resolveToken()}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const ctype = res.headers.get("content-type") ?? "";
    const payload = ctype.includes("application/json")
      ? ((await res.json()) as unknown)
      : await res.text();
    if (!res.ok) {
      const detail = typeof payload === "string" ? payload : JSON.stringify(payload);
      throw new Error(
        `nautilo-smoke-mcp: ${init.method ?? "GET"} ${path} → ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`,
      );
    }
    return payload as T;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`nautilo-smoke-mcp: ${path} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// MCP server + tool registration
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "nautilo-security-smoke",
  version: "0.1.0",
});

// Shared schema pieces
const platformSchema = z.enum(["linux", "macos", "both"]).default("both");
const modeSchema = z.enum(["destructive", "substitution"]).default("destructive");
const levelSchema = z
  .enum(["yolo", "permissive", "standard", "cautious", "paranoid"])
  .default("standard");
const vmSchema = z.enum(["linux", "macos"]);

// -- run_security_smoke ------------------------------------------------------

server.tool(
  "run_security_smoke",
  "Execute the Nautilo security smoke matrix in disposable VMs. Starts a run, polls until complete, returns a summarized report. Use pattern to narrow the matrix (glob match on test id, e.g. 'PATH-*' or 'SCAN-01').",
  {
    pattern: z.string().optional().describe("Test ID glob. Defaults to all tests."),
    platform: platformSchema,
    mode: modeSchema,
    level: levelSchema,
    maxWaitMs: z
      .number()
      .int()
      .positive()
      .max(1_800_000)
      .default(900_000)
      .describe("Max time to wait for the run to finish (ms). Default 15min."),
  },
  async ({ pattern, platform, mode, level, maxWaitMs }) => {
    const startRes = await smokeFetch<{ runId: string; startedAt: string; status: string }>(
      "/api/smoke/runs",
      {
        method: "POST",
        body: JSON.stringify({ pattern, platform, mode, level }),
        timeoutMs: 10_000,
      },
    );
    const runId = startRes.runId;

    // Poll until finished or timeout.
    const deadline = Date.now() + maxWaitMs;
    let lastStatus = startRes.status;
    let finalRecord: { status: string; progress: { done: number; total: number }; error?: string } | undefined;
    while (Date.now() < deadline) {
      const rec = await smokeFetch<{
        runId: string;
        status: string;
        progress: { done: number; total: number };
        error?: string;
      }>(`/api/smoke/runs/${encodeURIComponent(runId)}`, { timeoutMs: 5_000 });
      lastStatus = rec.status;
      finalRecord = rec;
      if (rec.status !== "running") break;
      await sleep(1_500);
    }

    if (lastStatus === "running") {
      return {
        content: [
          {
            type: "text",
            text:
              `Run ${runId} did not finish within ${maxWaitMs}ms. ` +
              `Last progress: ${finalRecord?.progress.done ?? 0}/${finalRecord?.progress.total ?? "?"}. ` +
              `Poll /api/smoke/runs/${runId} manually or call smoke_report later.`,
          },
        ],
      };
    }
    if (lastStatus === "failed") {
      return {
        isError: true,
        content: [
          { type: "text", text: `Run ${runId} failed: ${finalRecord?.error ?? "(no detail)"}` },
        ],
      };
    }

    // Fetch the full report for summarization.
    const report = await smokeFetch<SmokeReport>(`/api/smoke/runs/${encodeURIComponent(runId)}/report`, {
      timeoutMs: 10_000,
    });
    return {
      content: [
        { type: "text", text: summarizeReport(report) },
      ],
    };
  },
);

// -- smoke_list_tests --------------------------------------------------------

server.tool(
  "smoke_list_tests",
  "List the security smoke test catalog. Optional layer / platform / pattern filters map to query-string args on the HTTP API.",
  {
    layer: z
      .enum([
        "command-scanner",
        "path-deny",
        "security-level",
        "required-capabilities",
        "content-scanner",
        "sandbox",
      ])
      .optional(),
    platform: z.enum(["linux", "macos"]).optional(),
    pattern: z.string().optional(),
  },
  async ({ layer, platform, pattern }) => {
    const query = new URLSearchParams();
    if (layer) query.set("layer", layer);
    if (platform) query.set("platform", platform);
    if (pattern) query.set("pattern", pattern);
    const qs = query.toString();
    const tests = await smokeFetch<{ tests: SmokeTestInfo[] }>(
      `/api/smoke/tests${qs ? `?${qs}` : ""}`,
    );
    return {
      content: [
        { type: "text", text: formatTestCatalog(tests.tests) },
      ],
    };
  },
);

// -- smoke_status ------------------------------------------------------------

server.tool(
  "smoke_status",
  "Summarize VM health for both platforms (Lima/Linux and Tart/macOS). Any unreachable platform is reported explicitly.",
  {},
  async () => {
    const parts: string[] = [];
    for (const vm of ["linux", "macos"] as const) {
      try {
        const r = await smokeFetch<{ ok: boolean; reason?: string; checkedAt: string }>(
          `/api/smoke/vms/${vm}/health`,
          { timeoutMs: 10_000 },
        );
        parts.push(`${vm}: ${r.ok ? "OK" : `DEAD — ${r.reason ?? "unknown"}`} (checked ${r.checkedAt})`);
      } catch (err) {
        parts.push(`${vm}: not reachable — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { content: [{ type: "text", text: parts.join("\n") }] };
  },
);

// -- smoke_snapshot ----------------------------------------------------------

server.tool(
  "smoke_snapshot",
  "Take a named VM snapshot on the given platform. Useful before starting a multi-test run you want to roll back to.",
  {
    vm: vmSchema,
    name: z.string().default("baseline"),
  },
  async ({ vm, name }) => {
    const r = await smokeFetch<{ ok: boolean; name: string; tookMs: number }>(
      `/api/smoke/vms/${vm}/snapshot`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
    return {
      content: [
        { type: "text", text: `snapshot ${name} on ${vm}: ${r.ok ? "OK" : "FAILED"} (took ${r.tookMs}ms)` },
      ],
    };
  },
);

// -- smoke_restore -----------------------------------------------------------

server.tool(
  "smoke_restore",
  "Restore the VM to a named snapshot (default: baseline). Typically a few seconds per platform.",
  {
    vm: vmSchema,
    name: z.string().default("baseline"),
  },
  async ({ vm, name }) => {
    const r = await smokeFetch<{ ok: boolean; name: string; tookMs: number }>(
      `/api/smoke/vms/${vm}/restore`,
      { method: "POST", body: JSON.stringify({ name }) },
    );
    return {
      content: [
        { type: "text", text: `restore ${name} on ${vm}: ${r.ok ? "OK" : "FAILED"} (took ${r.tookMs}ms)` },
      ],
    };
  },
);

// -- smoke_report ------------------------------------------------------------

server.tool(
  "smoke_report",
  "Fetch a past run's report by run_id. Use this when run_security_smoke returned before the run finished (exceeded maxWaitMs).",
  {
    run_id: z.string().min(1),
  },
  async ({ run_id }) => {
    const report = await smokeFetch<SmokeReport>(
      `/api/smoke/runs/${encodeURIComponent(run_id)}/report`,
      { timeoutMs: 10_000 },
    );
    return { content: [{ type: "text", text: summarizeReport(report) }] };
  },
);

// ---------------------------------------------------------------------------
// Helpers — report / catalog summarization
// ---------------------------------------------------------------------------

interface SmokeReport {
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

interface SmokeTestInfo {
  id: string;
  platform: string;
  layer: string;
  description: string;
  expectBlocked: boolean;
  honeypotRequired: boolean;
}

function summarizeReport(report: SmokeReport): string {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`Run ${report.runId} — ${report.platform}, ${report.mode}, ${report.securityLevel}`);
  lines.push(`Duration: ${formatDuration(report.durationMs)}`);
  lines.push(`Summary: ${s.pass} pass · ${s.fail} fail · ${s.warn} warn · ${s.vmDead} vm_dead · ${s.skipped} skipped · ${s.error} error (${s.total} total)`);

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

function formatTestCatalog(tests: SmokeTestInfo[]): string {
  if (tests.length === 0) return "No tests match the filter.";
  const lines: string[] = [];
  lines.push(`${tests.length} test(s):`);
  const byLayer = new Map<string, SmokeTestInfo[]>();
  for (const t of tests) {
    const list = byLayer.get(t.layer) ?? [];
    list.push(t);
    byLayer.set(t.layer, list);
  }
  for (const [layer, group] of Array.from(byLayer.entries()).sort()) {
    lines.push("");
    lines.push(`${layer}:`);
    for (const t of group) {
      const hp = t.honeypotRequired ? " 🍯" : "";
      lines.push(`  ${t.id} (${t.platform})${hp} — ${t.description}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
// eslint-disable-next-line no-console -- stderr lifecycle log; stdout is reserved for the MCP stream
console.error(`[nautilo-security-smoke] stdio MCP server ready → ${SERVER_URL}`);
