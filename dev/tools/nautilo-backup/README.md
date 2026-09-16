# nautilo-backup (MCP)

A Model Context Protocol server for inspecting and safely operating on
Nautilo dev snapshots. Sibling to the `bin/nautilo-dev/` CLI — they
share the same snapshot format and point at the same `~/.nautilo/dev-snapshots/`
directory.

## What it does

| Tool | Type | Purpose |
|---|---|---|
| `backup_list` | read-only | Enumerate available snapshots, including backup mode and Logto dump presence |
| `backup_inspect` | read-only | Snapshot metadata plus Nautilo per-table row counts + column lists for dump-mode snapshots |
| `backup_preflight` | read-only | Dry-run a dump-mode restore, report schema drift per table |
| `backup_save` | safe-write | Create a new snapshot (cannot overwrite); pass `requireLogto: true` for migration-grade backups; pass `mode: "basebackup"` for a physical app-Postgres backup |
| `backup_verify` | read-only | Post-restore smoke check (DB, owner, row counts, server health) |

## What it deliberately does NOT do

- `backup_restore` — destructive; use the CLI `bun run dev:restore`
- `backup_clean` — destructive; use the CLI `bun run dev:clean`
- `backup_delete` — not exposed; remove directories by hand if you truly want to

Destructive operations stay CLI-only so a human is always at the
keyboard with an explicit intent. The agent can READ, DIAGNOSE, and
SAFELY SAVE without human involvement.

## Install

```bash
mkdir -p ~/.nautilo-dev/tools
cp -r dev/tools/nautilo-backup ~/.nautilo-dev/tools/
cd ~/.nautilo-dev/tools/nautilo-backup && bun install
```

Register in Cursor's MCP config (your workspace's `.cursor/mcp.json`):

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

Adjust `NAUTILO_REPO_DIR` if your repo lives elsewhere. If omitted the
MCP checks `$HOME/nautilo` and its source checkout as fallbacks.

## Architecture

The MCP is a **thin wrapper** over the `bin/nautilo-dev` CLI — it
spawns `bun <repo>/bin/nautilo-dev/src/index.ts <subcmd>` for every
tool call. This keeps the CLI as the single source of truth and means
CLI bug fixes automatically flow through the MCP.

For Logto cutovers, use `backup_save` with `requireLogto: true`, which
maps to `bun run dev:save <name> --require-logto`. The command fails
unless both the app DB backup and `logto_nautilo.sql.gz` are captured.
The default `mode: "dump"` writes portable, table-inspectable
`database.sql.gz`; `mode: "basebackup"` writes `basebackup.tar.gz` for
faster full-cluster rollback but cannot be inspected or preflighted
table-by-table.
Destructive restore remains CLI-only; use
`bun run dev:restore <name> -- --require-logto` when the Logto DB must
be restored as part of the rollback.

Rationale:
- Same code path for human + agent use (no drift).
- Subprocess isolation — the MCP can't accidentally `rm -rf`.
- Tiny MCP surface area to maintain (~200 lines, no business logic).

## Updating

Whenever you edit the MCP source, sync the installed copy:

```bash
SRC=dev/tools/nautilo-backup
DST=~/.nautilo-dev/tools/nautilo-backup
cp "$SRC/index.ts" "$SRC/package.json" "$DST/"
cd "$DST" && bun install   # only if package.json changed
```

Toggle the server off and on in Cursor's MCP panel so it re-spawns.
