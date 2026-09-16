#!/usr/bin/env node
/**
 * Nautilo Server Logs — MCP server for tailing the nautilo-server log.
 *
 * D082 PR C. Mirrors the shape of `electron_console_logs` from the
 * electron-debug MCP. Exposes the server log over the dev-tool MCP
 * channel so agent + human investigators stop reading terminal
 * files directly.
 *
 * Log file discovery (first match wins):
 *   1. Tool call `path` argument (explicit override)
 *   2. Tool call `instance` argument:
 *      `~/.nautilo-<instance>/logs/nautilo-server.log`
 *   3. `NAUTILO_SERVER_LOG_PATH` env var (MCP-config default)
 *   4. `NAUTILO_INSTANCE_ID` env var:
 *      `~/.nautilo-<instance>/logs/nautilo-server.log`
 *   5. `~/.nautilo/logs/nautilo-server.log` (default instance layout)
 *
 * IMPORTANT — explicit tool args (`path`, `instance`) win over the
 * `NAUTILO_SERVER_LOG_PATH` env var. The env is just a default; when a
 * caller names a log explicitly they mean it, even if the env points
 * elsewhere (e.g. a stale main-repo log while running a worktree
 * instance). The `instance` aliases `default` / `(default)` map to the
 * suffix-less `~/.nautilo` root, NOT `~/.nautilo-default`.
 *
 * When none of the above resolves to an existing file, the tool
 * returns a clear error telling the caller to set
 * NAUTILO_SERVER_LOG_PATH — rather than silently returning an empty
 * result that would look like "no matching logs."
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  existsSync,
  readFileSync,
  copyFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { resolve as resolvePath, dirname } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Log path resolution
// ---------------------------------------------------------------------------

const SERVER_LOG_FILE_NAME = "nautilo-server.log";

// The default instance lives at the suffix-less `~/.nautilo` root; only
// named instances get a `~/.nautilo-<id>` suffix.
const DEFAULT_INSTANCE_ALIASES = new Set(["default", "(default)"]);

function instanceRoot(instanceId: string): string {
  const trimmed = instanceId.trim();
  if (trimmed.length === 0 || DEFAULT_INSTANCE_ALIASES.has(trimmed.toLowerCase())) {
    return resolvePath(homedir(), ".nautilo");
  }
  return resolvePath(homedir(), `.nautilo-${trimmed}`);
}

function resolveLogPath(
  explicit?: string,
  opts: { instance?: string } = {},
): string | null {
  const fileName = SERVER_LOG_FILE_NAME;
  // Explicit tool args (path, instance) come BEFORE the env var: a caller
  // who names a log means it, even if NAUTILO_SERVER_LOG_PATH points at a
  // stale/other log (e.g. main-repo log while debugging a worktree).
  const candidates: (string | undefined)[] = [
    explicit,
    opts.instance !== undefined
      ? resolvePath(instanceRoot(opts.instance), "logs", fileName)
      : undefined,
    process.env["NAUTILO_SERVER_LOG_PATH"],
    process.env["NAUTILO_INSTANCE_ID"] !== undefined
      ? resolvePath(instanceRoot(process.env["NAUTILO_INSTANCE_ID"]), "logs", fileName)
      : undefined,
    resolvePath(homedir(), ".nautilo/logs", fileName),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const abs = c.startsWith("~") ? c.replace(/^~/, homedir()) : c;
    if (existsSync(abs)) return abs;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Line parsing — our logger emits:
//   "[<ISO-timestamp>] [turn=<id>]? [LEVEL-TAG]? <message>"
//
// Level tags (from packages/logger/src/logger.ts emit): `[DEBUG]`,
// `[WARN]`, `[ERROR]`. Info lines have no explicit tag (they're the
// unmarked default), so `level: "info"` means "no level tag" in
// our filtering model.
// ---------------------------------------------------------------------------

interface ParsedLine {
  raw: string;
  ts?: Date;
  level: "info" | "debug" | "warn" | "error";
  turnId?: string;
}

const TS_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\]\s/;
const TURN_RE = /\[turn=([^\]]+)\]/;
const LEVEL_RE = /\[(DEBUG|WARN|ERROR)\]/;

function parseLine(raw: string): ParsedLine {
  const tsMatch = TS_RE.exec(raw);
  const levelMatch = LEVEL_RE.exec(raw);
  const turnMatch = TURN_RE.exec(raw);

  let level: ParsedLine["level"] = "info";
  if (levelMatch) {
    const tag = levelMatch[1];
    if (tag === "DEBUG") level = "debug";
    else if (tag === "WARN") level = "warn";
    else if (tag === "ERROR") level = "error";
  }

  return {
    raw,
    ts: tsMatch ? new Date(tsMatch[1] as string) : undefined,
    level,
    turnId: turnMatch ? turnMatch[1] : undefined,
  };
}

// ---------------------------------------------------------------------------
// since= parsing — accepts ISO timestamp OR relative like "5m", "2h", "30s"
// ---------------------------------------------------------------------------

function parseSince(input: string): Date | null {
  const rel = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  if (rel) {
    const n = parseInt(rel[1] as string, 10);
    const unit = rel[2];
    const ms =
      unit === "s" ? n * 1000 :
      unit === "m" ? n * 60_000 :
      unit === "h" ? n * 3_600_000 :
      n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const iso = new Date(input);
  if (Number.isNaN(iso.getTime())) return null;
  return iso;
}

// ---------------------------------------------------------------------------
// Clear — archive-then-truncate. Non-destructive: the archive is kept.
// ---------------------------------------------------------------------------

function archiveAndTruncate(logPath: string): string {
  const archivePath = `${logPath}.${Date.now()}.archived`;
  copyFileSync(logPath, archivePath);
  writeFileSync(logPath, "");
  return archivePath;
}

// ---------------------------------------------------------------------------
// Read + filter
// ---------------------------------------------------------------------------

interface ReadOpts {
  last?: number;
  since?: Date;
  grep?: RegExp;
  turnId?: string;
  level?: "error" | "warn" | "info" | "debug";
}

function readAndFilter(logPath: string, opts: ReadOpts): ParsedLine[] {
  const raw = readFileSync(logPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  let out = lines.map(parseLine);

  if (opts.since) {
    const sinceTs = opts.since.getTime();
    out = out.filter((p) => (p.ts ? p.ts.getTime() >= sinceTs : false));
  }

  if (opts.turnId) {
    out = out.filter((p) => p.turnId === opts.turnId);
  }

  if (opts.level) {
    out = out.filter((p) => p.level === opts.level);
  }

  if (opts.grep) {
    out = out.filter((p) => (opts.grep as RegExp).test(p.raw));
  }

  if (opts.last && opts.last > 0) {
    out = out.slice(-opts.last);
  }

  return out;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "nautilo-server-logs",
  version: "0.1.0",
});

server.tool(
  "nautilo_server_logs",
  `Read the Nautilo server log (logs/nautilo-server.log).

HOW LOG COLLECTION WORKS:
- The server process writes to a FILE (not a ring buffer). The file
  grows indefinitely unless rotated or cleared; this MCP can tail it
  without missing anything — logs from BEFORE this MCP started are
  still visible, unlike electron_console_logs.
- Levels recognized: 'info' (unmarked default), 'debug' ([DEBUG]
  tag), 'warn' ([WARN] tag), 'error' ([ERROR] tag).
- D082 PR B threads a per-turn UUID through every log line via
  AsyncLocalStorage. Use \`turnId\` to reconstruct one user-turn's
  full flow in chronological order.

TYPICAL DEBUGGING FLOW:
1. Run the action (chat message, approval reply, PIN verify, etc.)
2. nautilo_server_logs({ last: 50 })                    # recent tail
3. nautilo_server_logs({ turnId: "abc-123" })           # one turn end-to-end
4. nautilo_server_logs({ grep: "approval" })            # approval-related lines

FILTERS (combine freely; they AND together):
- last: N              — most recent N matching entries
- since: "5m" | "<ISO>"— lines with timestamp at-or-after; accepts
                          relative (s/m/h/d) or full ISO-8601
- grep: "<regex>"      — regex match against the full line
- turnId: "<uuid>"     — convenience for \`grep '\\[turn=<uuid>\\]'\`
- level: 'info' | 'warn' | 'error' | 'debug'
- clear: true          — archive the log to <path>.<ts>.archived AND
                          truncate the live file (destructive; use for
                          a clean-slate test). The READ happens first,
                          then the archive, so the response still shows
                          what was there.
- path: "<abs>"        — explicit log file path (overrides env vars)
- instance: "<id>"     — read ~/.nautilo-<id>/logs/nautilo-server.log

LOG-PATH DISCOVERY (first existing file wins):
  1. tool call \`path\` arg
  2. tool call \`instance\` arg  (\`default\`/\`(default)\` → ~/.nautilo)
  3. $NAUTILO_SERVER_LOG_PATH env var
  4. $NAUTILO_INSTANCE_ID env var
  5. ~/.nautilo/logs/nautilo-server.log

Explicit args (\`path\`, \`instance\`) WIN over the env var — pass
instance: "default" to read ~/.nautilo/logs even when the MCP env
points at a different (e.g. stale main-repo) log.

If none resolve, returns a clear error. Typical setup: register this
MCP in Cursor with env { "NAUTILO_SERVER_LOG_PATH":
"/abs/path/to/nautilo-worktree-1/logs/nautilo-server.log" }.

PAIRS WITH:
- electron_console_logs — renderer-side log buffer (different tool)
- electron_eval         — run JS in the renderer for correlated probes`,
  {
    last: z.number().int().positive().optional().describe(
      "Return only the last N matching entries.",
    ),
    since: z.string().optional().describe(
      "ISO-8601 timestamp OR relative (5m, 2h, 30s, 1d). Filter: only entries at-or-after this time.",
    ),
    grep: z.string().optional().describe(
      "Regex pattern. Matched against the full line (after any other filters).",
    ),
    turnId: z.string().optional().describe(
      "D082 PR B turnId. Shorthand for grep '[turn=<id>]' — reconstructs one user-turn's chronological flow.",
    ),
    level: z.enum(["info", "warn", "error", "debug"]).optional().describe(
      "Filter by log level. 'info' = lines without an explicit level tag (the unmarked default).",
    ),
    clear: z.boolean().optional().describe(
      "After reading, archive the log to <path>.<timestamp>.archived AND truncate the live file.",
    ),
    path: z.string().optional().describe(
      "Explicit log file path. Overrides env vars. Absolute; tilde (~) expanded.",
    ),
    instance: z.string().optional().describe(
      "Named Nautilo instance id. Reads ~/.nautilo-<id>/logs/nautilo-server.log.",
    ),
  },
  async ({ last, since, grep, turnId, level, clear, path, instance }) => {
    const logPath = resolveLogPath(path, { instance });
    if (!logPath) {
      return {
        content: [{
          type: "text" as const,
          text: [
            "No nautilo-server.log found.",
            "Set NAUTILO_SERVER_LOG_PATH in the MCP env config, pass",
            "path: '<abs-path>', or pass instance: '<id>'.",
            "Tried: $NAUTILO_SERVER_LOG_PATH, instance-scoped logs,",
            "$NAUTILO_INSTANCE_ID logs, and ~/.nautilo/logs/nautilo-server.log.",
          ].join("\n"),
        }],
      };
    }

    const opts: ReadOpts = {};
    if (last !== undefined) opts.last = last;
    if (since !== undefined) {
      const parsed = parseSince(since);
      if (!parsed) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid \`since\` value: ${JSON.stringify(since)}. Expected ISO-8601 or relative like '5m', '2h', '30s', '1d'.`,
          }],
        };
      }
      opts.since = parsed;
    }
    if (grep !== undefined) {
      try {
        opts.grep = new RegExp(grep);
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid \`grep\` regex: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    }
    if (turnId !== undefined) opts.turnId = turnId;
    if (level !== undefined) opts.level = level;

    let entries: ParsedLine[];
    try {
      entries = readAndFilter(logPath, opts);
    } catch (err) {
      return {
        content: [{
          type: "text" as const,
          text: `Error reading ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
        }],
      };
    }

    let archivedPath: string | null = null;
    if (clear === true) {
      try {
        archivedPath = archiveAndTruncate(logPath);
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error archiving ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    }

    const body = entries.length > 0
      ? entries.map((e) => e.raw).join("\n")
      : `(no lines matched the filter; ${logPath} has ${statSync(logPath).size} bytes total before any clear)`;

    const header = [
      `# ${logPath}`,
      `# ${entries.length} line(s) matched`,
      archivedPath ? `# archived to ${archivedPath} then truncated` : undefined,
    ].filter(Boolean).join("\n");

    return {
      content: [{
        type: "text" as const,
        text: `${header}\n\n${body}`,
      }],
    };
  },
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  // Touch the default log dir so read-time discovery doesn't fail on a
  // fresh machine that's never run the server — users who don't have a
  // log yet can still see a clean "no file" error instead of a misleading
  // "empty result".
  try {
    mkdirSync(dirname(resolvePath(homedir(), ".nautilo/logs/nautilo-server.log")), { recursive: true });
  } catch { /* best effort */ }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
