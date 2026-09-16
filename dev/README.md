# Development Tools

Internal development tools for the Nautilo project. Not shipped as product code.
Nothing in `packages/`, `apps/`, `native/`, or `bin/` may import from `dev/`.

## Directory Structure

```
dev/
  tools/
    electron-debug/    — MCP server for inspecting the Electron desktop app via CDP
    nautilo-backup/    — MCP server for inspecting/preflighting dev snapshots
    nautilo-db/        — MCP server for read-only SQL against the local dev Postgres
    nautilo-server-logs/ — MCP server for tailing / searching the server log
    png-to-svg/        — Bun wrapper around vtracer for trying PNG/JPEG → SVG (dev-only)
  playground/          — experimental prototypes and proofs of concept
```

## Install pattern for MCPs

All MCP servers live in `dev/tools/<name>/` (source of truth, tracked in git)
but are **invoked by Cursor from an installed copy** at
`~/.nautilo-dev/tools/<name>/` (with its own `node_modules`). This keeps
Cursor's MCP config independent of which worktree you're editing in, and
avoids polluting product `node_modules`.

Whenever you edit an MCP's source, sync the copy:

```bash
SRC=dev/tools/<name>
DST=~/.nautilo-dev/tools/<name>
cp "$SRC/index.ts" "$SRC/package.json" "$DST/"
cd "$DST" && bun install   # only needed if package.json changed
```

Then toggle the server off and on in Cursor's MCP panel so it re-spawns
with the new code.

## Electron Debug (MCP)

An MCP server that connects to the Nautilo Electron app's Chrome DevTools
Protocol endpoint. Lets AI agents evaluate JavaScript, read console logs, and
list windows in the running desktop app.

### Setup

The desktop app must be launched with `--remote-debugging-port=9222` (this is
the default in the `dev` script).

Install to `~/.nautilo-dev/tools/` (once, works across all worktrees):

```bash
mkdir -p ~/.nautilo-dev/tools
cp -r dev/tools/electron-debug ~/.nautilo-dev/tools/
cd ~/.nautilo-dev/tools/electron-debug && bun install
```

Add to Cursor's MCP config (`.cursor/mcp.json` in the workspace):

```json
{
  "mcpServers": {
    "electron-debug": {
      "command": "/opt/homebrew/bin/bun",
      "args": ["~/.nautilo-dev/tools/electron-debug/index.ts"]
    }
  }
}
```

Source lives in `dev/tools/electron-debug/`. Installed copy lives in
`~/.nautilo-dev/tools/electron-debug/`. The separation keeps dev tools
out of `~/.nautilo/` (which is runtime-only — config, certs, state).

### Tools

| Tool | What it does |
|------|-------------|
| `electron_eval` | Evaluate JavaScript in the Electron renderer window |
| `electron_console_logs` | Collect console logs for N seconds |
| `electron_list_windows` | List all CDP targets (windows) |
| `electron_screenshot` | Capture a PNG/JPEG/WebP of the renderer (viewport, region, or full page) |

### Example

```
electron_eval({ expression: "window.nautiloDesktop.relayStatus.get()" })
electron_eval({ expression: "document.querySelectorAll('.error').length" })
electron_console_logs({ duration_ms: 5000 })
electron_screenshot({ fullPage: true })
electron_screenshot({ path: "~/tmp/workbench.png", clip: { x: 0, y: 0, width: 800, height: 600 } })
```

## Nautilo DB (MCP)

A read-only SQL surface against the local Nautilo Postgres. Every query
runs inside a `READ ONLY` transaction with a 5s statement timeout and a
row-limit cursor. Refuses to connect to anything other than `localhost`
unless `NAUTILO_DB_ALLOW_REMOTE=1` is explicitly set.

Install:

```bash
mkdir -p ~/.nautilo-dev/tools
cp -r dev/tools/nautilo-db ~/.nautilo-dev/tools/
cd ~/.nautilo-dev/tools/nautilo-db && bun install
```

MCP registration (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "nautilo-db": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "tsx", "/Users/example/.nautilo-dev/tools/nautilo-db/index.ts"],
      "env": {
        "DB_CONNECTION_STRING": "postgresql://postgres:postgres@localhost:5434/nautilo"
      }
    }
  }
}
```

### Tools

| Tool | What it does |
|------|-------------|
| `nautilo_db_query` | Run a single read-only SQL statement (cursor-backed, row-limited) |
| `nautilo_db_tables` | List all tables in `public` with row count and size |
| `nautilo_db_schema` | Show column definitions for a table (or all tables) |

### Example

```
nautilo_db_tables()
nautilo_db_schema({ table: "jobs" })
nautilo_db_query({ sql: "SELECT id, status, created_at FROM jobs ORDER BY created_at DESC", limit: 20 })
```

Writes are impossible: `INSERT / UPDATE / DELETE / DDL` fail at the cursor
parser, and anything that somehow sneaks through (e.g. CTE-in-select)
is blocked by Postgres' own `READ ONLY` enforcement.

## Nautilo Backup (MCP)

A thin MCP wrapper over the `bin/nautilo-dev/` snapshot CLI. Lets an
agent autonomously list, inspect, and preflight-test dev snapshots
without having to shell out. **Destructive operations (restore,
clean) are intentionally NOT exposed** — they stay CLI-only so a
human is always at the keyboard for them.

Install:

```bash
mkdir -p ~/.nautilo-dev/tools
cp -r dev/tools/nautilo-backup ~/.nautilo-dev/tools/
cd ~/.nautilo-dev/tools/nautilo-backup && bun install
```

MCP registration (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "nautilo-backup": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "tsx", "/Users/example/.nautilo-dev/tools/nautilo-backup/index.ts"],
      "env": {
        "NAUTILO_REPO_DIR": "/absolute/path/to/nautilo"
      }
    }
  }
}
```

Adjust `NAUTILO_REPO_DIR` for non-standard repo paths. If omitted the
MCP checks `$HOME/nautilo` and its source checkout.

### Tools

| Tool | Type | What it does |
|------|------|-------------|
| `backup_list` | read-only | Enumerate snapshots + metadata, including Logto dump presence |
| `backup_inspect` | read-only | Snapshot metadata plus Nautilo row counts + column lists |
| `backup_preflight` | read-only | Dry-run a restore; report per-table schema drift vs today's DB |
| `backup_save` | safe-write | Create a new snapshot (cannot overwrite); pass `requireLogto: true` for migration-grade backups |
| `backup_verify` | read-only | Post-restore smoke check: container, DB, owner, row counts, server /health |

### Corresponding CLI commands

Every MCP tool has a matching CLI command. The MCP just spawns the
CLI under the hood, so CLI bug fixes flow through automatically.

| CLI | Equivalent MCP tool |
|-----|---------------------|
| `bun run dev:list` | `backup_list` |
| `bun run dev:inspect <name>` | `backup_inspect` |
| `bun run dev:preflight <name>` | `backup_preflight` |
| `bun run dev:save <name>` | `backup_save` |
| `bun run dev:verify` | `backup_verify` |
| `bun run dev:restore <name> [--no-autosave]` | **CLI only** (destructive) |
| `bun run dev:clean [--no-autosave]` | **CLI only** (destructive) |

The CLI also provides:
- Logto migration guardrails — `dev:save <name> -- --require-logto`
  refuses to create a Nautilo-only snapshot, and
  `dev:restore <name> -- --require-logto` refuses partial rollback when
  `logto_nautilo.sql.gz` or the Logto Postgres container is absent.
- Automatic pre-destructive snapshots — `dev:clean` and `dev:restore`
  both save an `auto-pre-<cmd>-<ISO>` snapshot before wiping, unless
  `--no-autosave` is passed.
- Schema-drift awareness — `restoreFromGzip` consults the
  restore-migration registry in `bin/nautilo-dev/src/lib/restore-migrations.ts`
  to hand-insert rows that can't be COPY'd due to column shape changes
  (e.g. M043's `credentials.actor_id → user_id` remap).
- Correct sequencing — home-dir tar extract runs BEFORE instance.env
  write, so the env file can never be wiped by the home-dir restore.
  Regression-tested at `bin/nautilo-dev/tests/unit/restore-sequencing.test.ts`.


## Guidelines

- Tools may depend on system tools (Python) not in project deps
- Output files are gitignored; source is tracked
- `dev/` must not be imported by shipped code
