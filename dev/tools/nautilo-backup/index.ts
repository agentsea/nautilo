#!/usr/bin/env node
/**
 * nautilo-backup — MCP server for inspecting + preflight-ing Nautilo
 * development snapshots.
 *
 * DESIGN INTENT
 * =============
 *
 * The `bin/nautilo-dev/` CLI owns backup/restore as the human-facing
 * interface. This MCP is a THIN, READ-LEANING wrapper that lets an
 * agent autonomously:
 *
 *   - List snapshots and inspect their contents
 *   - Dry-run a restore (preflight) against the live schema
 *   - Take a new snapshot (safe write — can never overwrite)
 *   - Smoke-check a post-restore state (DB, owner, server health)
 *
 * It deliberately DOES NOT expose destructive operations (restore,
 * clean, delete). Those live in the CLI only, where a human is
 * sitting at the keyboard with an explicit command. If an agent
 * wants to restore, it should describe the plan in text and ask the
 * human to run `bun run dev:restore <name>`.
 *
 * SAFETY POSTURE
 * ==============
 *
 *   1. Process boundary — this runs as an MCP subprocess, not inside
 *      the user's shell. It cannot escalate to `rm -rf` or `docker
 *      run` via shell injection.
 *
 *   2. Read-leaning — only `backup_save` writes, and it writes to a
 *      NEW directory that must not already exist (matches the CLI).
 *
 *   3. Subprocess-only — every tool here spawns the existing
 *      `bin/nautilo-dev` CLI via `bun` rather than importing its
 *      modules directly. This keeps the MCP tiny, makes the CLI the
 *      single source of truth for behavior, and means CLI bug fixes
 *      automatically flow through.
 *
 * ENVIRONMENT
 * ===========
 *
 *   NAUTILO_REPO_DIR — absolute path to the Nautilo repository. Used
 *     to find the `bin/nautilo-dev` CLI. Defaults to the directory
 *     two levels up from this file's installed location — i.e. it
 *     works out of the box when installed via the standard
 *     `~/.nautilo-dev/tools/nautilo-backup/` path AND ALSO when run
 *     in-place from the git tree.
 *
 *     Override when the repo lives in a non-standard location (e.g.
 *     a second worktree).
 *
 *   Snapshot directory follows the Nautilo runtime path resolver
 *   (typically `~/.nautilo/dev-snapshots/`). Integration tests use a
 *   temporary `$HOME` so the tree stays isolated.
 *
 * TOOLS
 * =====
 *
 *   backup_list()               — enumerate snapshots + metadata
 *   backup_inspect(name)        — row counts + column lists per table
 *   backup_preflight(name)      — dry-run schema-drift diff
 *   backup_save(name, requireLogto?, mode?) — create a new snapshot (safe write)
 *   backup_verify()             — post-restore smoke check
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

function discoverRepoDir(): string {
  const fromEnv = process.env["NAUTILO_REPO_DIR"]?.trim();
  if (fromEnv && existsSync(join(fromEnv, "bin", "nautilo-dev", "src", "index.ts"))) {
    return fromEnv;
  }

  // Installed copies need an explicit repository or the conventional
  // ~/nautilo checkout. No maintainer-specific workspace paths are assumed.
  const candidates = [
    // $HOME/nautilo
    join(process.env["HOME"] ?? "", "nautilo"),
    // Relative to this file: ../../../
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "bin", "nautilo-dev", "src", "index.ts"))) {
      return candidate;
    }
  }

  throw new Error(
    "Could not locate the Nautilo repo. Set NAUTILO_REPO_DIR to the " +
      "absolute path of the `nautilo/` repository root.",
  );
}

const REPO_DIR = discoverRepoDir();
const CLI_ENTRY = join(REPO_DIR, "bin", "nautilo-dev", "src", "index.ts");

const snapshotNameInputSchema = z.object({
  name: z.string().min(1).describe("Snapshot name (must already exist)"),
});
type SnapshotNameInput = z.infer<typeof snapshotNameInputSchema>;

const backupSaveInputSchema = z.object({
  name: z.string().min(1).max(100).describe(
    "Snapshot name — alphanumeric with hyphens/underscores",
  ),
  requireLogto: z.boolean().optional().describe(
    "Fail unless logto_nautilo.sql.gz is included in the snapshot",
  ),
  mode: z.enum(["dump", "basebackup"]).optional().describe(
    "Backup mode. dump is the portable/table-inspectable default; basebackup writes a physical cluster backup.",
  ),
});
type BackupSaveInput = z.infer<typeof backupSaveInputSchema>;

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

/**
 * Invoke the nautilo-dev CLI via `bun` and return stdout + stderr as
 * text. Never throws on non-zero exit; callers inspect `.code` and
 * decide whether to report a tool error or surface the message.
 */
interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): ExecResult {
  try {
    const stdout = execFileSync("bun", [CLI_ENTRY, ...args], {
      cwd: REPO_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as {
      status?: number;
      code?: number;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
    };
    return {
      code: e.status ?? e.code ?? 1,
      stdout: e.stdout ? e.stdout.toString() : "",
      stderr: e.stderr ? e.stderr.toString() : (e.message ?? "unknown error"),
    };
  }
}

function validateSnapshotName(name: string): string | null {
  if (!name) return "name is required";
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return "name must be alphanumeric with hyphens/underscores (no spaces, no path separators)";
  }
  if (name.length > 100) return "name must be <= 100 characters";
  return null;
}

function formatResult(result: ExecResult): string {
  if (result.code === 0) {
    return result.stdout.trim() || "(no output)";
  }
  return `Error (exit ${result.code}):\n${result.stdout}${result.stderr ? "\n" + result.stderr : ""}`.trim();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "nautilo-backup",
  version: "0.1.0",
});

server.tool(
  "backup_list",
  `List every dev-snapshot available in the current Nautilo repo.

Returns a human-readable table with columns: NAME, CREATED, MODE, DB SIZE,
LOGTO DB, KEYS. Sorted newest-first when created-at is available, then
alphabetically.

This is a READ-ONLY operation. No DB or filesystem writes.`,
  {},
  () => {
    const result = runCli(["list"]);
    return {
      content: [{ type: "text" as const, text: formatResult(result) }],
    };
  },
);

server.tool(
  "backup_inspect",
  `Inspect a single dev-snapshot's contents.

Returns:
  - Snapshot metadata (path, created-at, env key count, DB dump size,
    Logto DB dump size / absence)
  - Per-table row count + column list from the Nautilo gzipped pg_dump

Streams the dump without holding it in memory, so it is safe to run
on multi-hundred-MB dumps. READ-ONLY.

Use this BEFORE a restore to see what data is actually in the
snapshot and what schema (column list) the dump was taken against.`,
  snapshotNameInputSchema.shape,
  ({ name }: SnapshotNameInput) => {
    const err = validateSnapshotName(name);
    if (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
    const result = runCli(["inspect", name]);
    return {
      content: [{ type: "text" as const, text: formatResult(result) }],
    };
  },
);

server.tool(
  "backup_preflight",
  `Dry-run a restore and report what WOULD happen, without writing
anything to the database.

For each table in the snapshot, reports one of:
  OK                   — exact column match, clean COPY
  OK (additive)        — current schema added nullable/defaulted cols
  REMAP (registry)     — restore-migration hook handles shape change
  SKIP (table gone)    — table dropped since snapshot
  SKIP (col dropped)   — dump names a column that no longer exists
  SKIP (col required)  — current schema added a NOT NULL column
  SKIP (not targeted)  — table is not in DATA_TABLES allowlist

Exit 1 if any table would fail — that tells the caller to add a
restore-migration rule before running the real restore. READ-ONLY.

Requires the nautilo-postgres container to be running for schema
comparison. Without it, returns the dump side of the diff only.`,
  snapshotNameInputSchema.shape,
  ({ name }: SnapshotNameInput) => {
    const err = validateSnapshotName(name);
    if (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
    const result = runCli(["preflight", name]);
    return {
      content: [{ type: "text" as const, text: formatResult(result) }],
    };
  },
);

server.tool(
  "backup_save",
  `Create a new dev-snapshot of the CURRENT state.

Captures:
  - Full pg_dump of the nautilo database (gzipped), by default
  - OR a physical pg_basebackup of the app Postgres cluster when mode=basebackup
  - Full pg_dump of the logto_nautilo database when the Logto stack is running
  - Current config.env (at ~/.nautilo/config.env)
  - ~/.nautilo/ tree (soul.md, state, certs, etc.) minus dev-snapshots

mode=dump is portable and table-inspectable. mode=basebackup is intended
for faster full-cluster rollback and cannot be used with backup_inspect
or backup_preflight.

Set requireLogto=true for Logto migration backups. That makes the
snapshot fail unless logto_nautilo is captured too.

This is a SAFE WRITE — the tool fails (does not overwrite) if a
snapshot with the same name already exists. Use unique, descriptive
names ("pre-D087-merge", "pre-migration-0017", etc.).

Requires the nautilo-postgres container to be running. With
requireLogto=true, the Logto Postgres container must also be running
and contain logto_nautilo.`,
  backupSaveInputSchema.shape,
  ({ name, requireLogto, mode }: BackupSaveInput) => {
    const err = validateSnapshotName(name);
    if (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
    }
    const args = ["save", name];
    if (requireLogto) args.push("--require-logto");
    if (mode) args.push("--mode", mode);
    const result = runCli(args);
    return {
      content: [{ type: "text" as const, text: formatResult(result) }],
    };
  },
);

server.tool(
  "backup_verify",
  `Post-restore smoke check: run the full CLI \`dev:verify\` assertion
set and return the pass/fail report.

Checks:
  1. nautilo-postgres container is running
  2. nautilo database exists
  3. NAUTILO_OWNER_ID matches a row in users
  4. That user has a profile
  5. Row counts for users / profiles / sessions / session_messages / memories
  6. Server /health is 2xx (best-effort — server may not be running)

READ-ONLY. Exit 1 if any check fails.`,
  {},
  () => {
    const result = runCli(["verify"]);
    return {
      content: [{ type: "text" as const, text: formatResult(result) }],
    };
  },
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[nautilo-backup] MCP ready (repo=${REPO_DIR})`);
}

main().catch((err) => {
  console.error(`[nautilo-backup] fatal: ${err}`);
  process.exit(1);
});
