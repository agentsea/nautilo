#!/usr/bin/env node
/**
 * Nautilo DB — MCP server for read-only SQL inspection of the dev database.
 *
 * DESIGN INTENT
 * -------------
 * Debugging Nautilo frequently requires asking questions like:
 *   "Is there a session row for user X?"
 *   "How many agent_messages were inserted in the last 5 minutes?"
 *   "What are the distinct values of jobs.status right now?"
 *
 * Rather than hand-writing `psql` one-liners or adding ad-hoc REST endpoints,
 * this MCP gives the agent a first-class read-only SQL surface.
 *
 * SAFETY POSTURE
 * --------------
 * The agent is trusted but fallible. We assume this MCP is only connected to
 * **dev / local databases**. Even so, we enforce defense-in-depth:
 *
 * 1. READ ONLY TRANSACTION — every query runs in a transaction set to
 *    READ ONLY. Attempts to INSERT/UPDATE/DELETE/DDL raise a Postgres error
 *    (`cannot execute ... in a read-only transaction`). This is Postgres's
 *    own enforcement, not a regex.
 *
 * 2. STATEMENT TIMEOUT — the server sets statement_timeout = 5s before the
 *    query runs. Runaway queries can't block the database.
 *
 * 3. ROW LIMIT — results are capped at `limit` rows (default 100, max 1000).
 *    We append `LIMIT n` is NOT done (would break aggregate / window queries);
 *    instead we fetch with a cursor and slice client-side. If there are more
 *    rows available, the response says so.
 *
 * 4. SINGLE STATEMENT — multi-statement queries (multiple `;` separated
 *    statements) are rejected. This reduces the risk of a prepared-statement
 *    attack or accidental compound query.
 *
 * 5. CONNECTION SCOPE — we require DB_CONNECTION_STRING to point at a
 *    `localhost` or `127.0.0.1` database, OR the env var
 *    `NAUTILO_DB_ALLOW_REMOTE=1` to be set. This is a guardrail against
 *    accidentally running this MCP with a production DATABASE_URL in env.
 *
 * 6. AUDIT LOG — every query is logged to stderr with timestamp and SHA-256
 *    prefix. Doesn't prevent misuse, but makes it visible.
 *
 * ENVIRONMENT
 * -----------
 *   DB_CONNECTION_STRING — Postgres connection string.
 *     Falls back to postgresql://postgres:postgres@localhost:5434/nautilo
 *     which matches the default docker-compose / dev env.
 *   NAUTILO_DB_ALLOW_REMOTE — set to `1` to permit non-localhost hosts.
 *
 * TOOLS
 * -----
 *   nautilo_db_query({ sql, limit? }) — run a single SELECT-style query.
 *   nautilo_db_schema({ table? })     — describe tables / columns / types.
 *   nautilo_db_tables()               — list all tables in the public schema.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pg from "pg";
import { createHash } from "node:crypto";

const DEFAULT_CONN =
  "postgresql://postgres:postgres@localhost:5434/nautilo";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_MAX_CELL_CHARS = 0;
const MAX_CELL_CHARS = 200_000;
const STATEMENT_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Connection guardrail
// ---------------------------------------------------------------------------

function assertLocalOrAllowed(connString: string): void {
  const allowRemote = process.env["NAUTILO_DB_ALLOW_REMOTE"] === "1";
  if (allowRemote) return;

  let host: string | null = null;
  try {
    const url = new URL(connString);
    host = url.hostname;
  } catch {
    // Not a URL-shaped string — probably a libpq keyword string. Skip check
    // and let the pool fail if it's somehow remote.
    return;
  }

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "host.docker.internal";

  if (!isLocal) {
    throw new Error(
      `nautilo-db refuses to connect to non-localhost host "${host}". ` +
        `Set NAUTILO_DB_ALLOW_REMOTE=1 to override.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Pool (lazy init)
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (_pool) return _pool;
  const connString =
    process.env["DB_CONNECTION_STRING"] ?? DEFAULT_CONN;
  assertLocalOrAllowed(connString);
  _pool = new pg.Pool({
    connectionString: connString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    max: 2, // MCP is single-user; no need for a big pool.
  });
  _pool.on("error", (err) => {
    // Idle client error — log to stderr, don't crash the server.
    console.error(`[nautilo-db] pool error: ${err.message}`);
  });
  return _pool;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: { name: string; dataTypeID: number }[];
  truncated: boolean;
  elapsedMs: number;
}

function stripTrailingSemicolons(s: string): string {
  return s.replace(/;+\s*$/u, "").trim();
}

function isSingleStatement(sql: string): boolean {
  // Very light multi-statement detector: strip string literals and line
  // comments, then look for a `;` that isn't at the very end.
  const stripped = sql
    .replace(/'(?:[^']|'')*'/g, "''") // single-quoted strings
    .replace(/"(?:[^"]|"")*"/g, "\"\"") // quoted identifiers
    .replace(/--[^\n]*/g, "") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ""); // block comments
  const trimmed = stripped.trim().replace(/;+\s*$/u, "");
  return !trimmed.includes(";");
}

async function runReadOnlyQuery(
  sql: string,
  limit: number,
): Promise<QueryResult> {
  const effectiveLimit = Math.max(1, Math.min(MAX_LIMIT, limit));
  const client = await getPool().connect();
  const start = Date.now();

  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query(
      `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`,
    );

    // Fetch limit+1 to detect truncation without rerunning the query.
    // We do this by using a named cursor so we don't buffer giant result sets.
    const cursorName = `nautilo_cur_${Date.now()}`;
    await client.query(
      `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${stripTrailingSemicolons(sql)}`,
    );
    const fetched = await client.query(
      `FETCH ${effectiveLimit + 1} FROM ${cursorName}`,
    );

    let truncated = false;
    let rows = fetched.rows as Record<string, unknown>[];
    if (rows.length > effectiveLimit) {
      truncated = true;
      rows = rows.slice(0, effectiveLimit);
    }

    await client.query(`CLOSE ${cursorName}`);
    await client.query("COMMIT");

    return {
      rows,
      rowCount: rows.length,
      fields: fetched.fields.map((f) => ({
        name: f.name,
        dataTypeID: f.dataTypeID,
      })),
      truncated,
      elapsedMs: Date.now() - start,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

function auditLog(sql: string): void {
  const sha = createHash("sha256").update(sql).digest("hex").slice(0, 12);
  const ts = new Date().toISOString();
  const preview = sql.replace(/\s+/g, " ").slice(0, 120);
  console.error(`[nautilo-db] ${ts} ${sha} ${preview}`);
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function formatResult(
  result: QueryResult,
  limit: number,
  maxCellChars: number,
): string {
  if (result.rowCount === 0) {
    return `(0 rows, ${result.elapsedMs}ms)`;
  }

  const header = result.fields.map((f) => f.name);
  const rows = result.rows.map((row) =>
    header.map((h) => formatCell(row[h], maxCellChars)),
  );

  // Simple pipe-delimited table. We keep this compact because the response is
  // consumed by an LLM, not a human.
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join(" | ");

  const divider = widths.map((w) => "-".repeat(w)).join("-+-");
  const lines: string[] = [
    line(header),
    divider,
    ...rows.map(line),
  ];

  const footer = result.truncated
    ? `\n(showing first ${result.rowCount} rows, limit=${limit} reached; more rows exist, ${result.elapsedMs}ms)`
    : `\n(${result.rowCount} rows, ${result.elapsedMs}ms)`;

  return lines.join("\n") + footer;
}

function formatCell(v: unknown, maxCellChars: number): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  let s: string;
  if (typeof v === "object") {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  } else {
    s = String(v);
  }
  if (maxCellChars <= 0 || s.length <= maxCellChars) return s;
  const marker = `...[truncated ${s.length - maxCellChars} chars]`;
  if (maxCellChars <= marker.length) return s.slice(0, maxCellChars);
  return `${s.slice(0, maxCellChars - marker.length)}${marker}`;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "nautilo-db",
  version: "0.1.0",
});

server.tool(
  "nautilo_db_query",
  `Run a read-only SQL query against the local Nautilo Postgres database.

The query runs inside a READ ONLY transaction with a 5-second statement
timeout. Any attempt to INSERT/UPDATE/DELETE/CREATE/DROP will raise an
error from Postgres itself. Only single statements are allowed.

USE FOR
- Confirming data exists ("is there a session row for user X?")
- Counting / aggregating recent activity
- Inspecting job / message / artifact state during debugging
- Validating migrations / seed behavior

DO NOT USE FOR
- Mutating data — use a migration or a server route instead
- Production databases — this MCP refuses non-localhost connections unless
  NAUTILO_DB_ALLOW_REMOTE=1 is set (don't do that)

OUTPUT
- Formatted as a pipe-delimited text table (header row, divider, data)
- Cell values are not truncated by default. Pass \`maxCellChars\` to cap each
  cell when you intentionally want compact output.
- Returns up to \`limit\` rows (default 100, max 1000). If the query has
  more rows, the footer says so.

EXAMPLE
  nautilo_db_query({ sql: "SELECT id, status FROM jobs ORDER BY created_at DESC", limit: 20 })`,
  {
    sql: z.string().min(1).describe(
      "A single SELECT-style SQL statement. No DDL/DML; read-only is enforced by Postgres.",
    ),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(
      `Max rows to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
    ),
    maxCellChars: z.number().int().min(0).max(MAX_CELL_CHARS).optional().describe(
      `Maximum characters per cell. Default ${DEFAULT_MAX_CELL_CHARS} means no per-cell truncation; max ${MAX_CELL_CHARS}.`,
    ),
  },
  async ({ sql, limit, maxCellChars }) => {
    const effectiveLimit = limit ?? DEFAULT_LIMIT;
    const effectiveMaxCellChars = maxCellChars ?? DEFAULT_MAX_CELL_CHARS;

    if (!isSingleStatement(sql)) {
      return {
        content: [{
          type: "text" as const,
          text: "Error: multiple SQL statements are not allowed. Submit one query at a time.",
        }],
      };
    }

    auditLog(sql);

    try {
      const result = await runReadOnlyQuery(sql, effectiveLimit);
      return {
        content: [{
          type: "text" as const,
          text: formatResult(result, effectiveLimit, effectiveMaxCellChars),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: "text" as const,
          text: `Query error: ${msg}`,
        }],
      };
    }
  },
);

server.tool(
  "nautilo_db_tables",
  `List tables in the public schema of the Nautilo database.

Returns table name, row count (approximate, from pg_class.reltuples), and
size. Useful as a first step when exploring the schema.`,
  {},
  async () => {
    try {
      const result = await runReadOnlyQuery(
        `
        SELECT
          c.relname AS table,
          c.reltuples::bigint AS approx_rows,
          pg_size_pretty(pg_total_relation_size(c.oid)) AS size
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
        ORDER BY c.relname
        `,
        500,
      );
      return {
        content: [{
          type: "text" as const,
          text: formatResult(result, 500, DEFAULT_MAX_CELL_CHARS),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
      };
    }
  },
);

server.tool(
  "nautilo_db_schema",
  `Show column definitions for a table (or all public tables if table omitted).

Returns: table, column, data_type, is_nullable, default. Useful before
writing a query to remember exact column names and types.`,
  {
    table: z.string().optional().describe(
      "Table name (public schema). If omitted, returns schema for all tables.",
    ),
  },
  async ({ table }) => {
    const filter = table
      ? `AND table_name = '${table.replace(/'/g, "''")}'`
      : "";
    try {
      const result = await runReadOnlyQuery(
        `
        SELECT
          table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ${filter}
        ORDER BY table_name, ordinal_position
        `,
        1000,
      );
      return {
        content: [{
          type: "text" as const,
          text: formatResult(result, 1000, DEFAULT_MAX_CELL_CHARS),
        }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[nautilo-db] MCP ready (conn=${
      (process.env["DB_CONNECTION_STRING"] ?? DEFAULT_CONN).replace(
        /:[^:@]*@/,
        ":***@",
      )
    })`,
  );
}

main().catch((err) => {
  console.error(`[nautilo-db] fatal: ${err}`);
  process.exit(1);
});
