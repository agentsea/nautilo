# nautilo-server-logs MCP

D082 PR C. Read the server log (`logs/nautilo-server.log`) over an
MCP channel with structured filters — the canonical way to inspect
server-side behavior from inside a Cursor / Claude Code agent
session. Pairs with `electron_console_logs` (renderer) and the
D082 PR B `turnId` plumbing.

## Install (one-time, manual)

The MCP runs as a stdio server that Cursor / Claude Code launches on
demand. Two steps:

### 1. Install dependencies in this folder

```bash
cd dev/tools/nautilo-server-logs
bun install
```

### 2. Symlink into `~/.nautilo-dev/tools/`

```bash
ln -s /absolute/path/to/nautilo-worktree/dev/tools/nautilo-server-logs \
      ~/.nautilo-dev/tools/nautilo-server-logs
```

Using a symlink (rather than a copy) means repo edits to this
MCP's `index.ts` are instantly reflected — just toggle the MCP
off/on in Cursor to reload. The sibling MCPs
(`electron-debug`, `nautilo-db`) use the same
pattern.

### 3. Register the MCP in Cursor's project-level config

Add an entry to the project's `.cursor/mcp.json` — for the Nautilo
mono-repo that lives at
`<workspace-root>/.cursor/mcp.json` — alongside the existing
`electron-debug` and `nautilo-db` entries:

```json
{
  "mcpServers": {
    "nautilo-server-logs": {
      "command": "/opt/homebrew/bin/npx",
      "args": [
        "-y",
        "tsx",
        "/Users/example/.nautilo-dev/tools/nautilo-server-logs/index.ts"
      ],
      "env": {
        "NAUTILO_SERVER_LOG_PATH": "/absolute/path/to/nautilo-worktree/logs/nautilo-server.log"
      }
    }
  }
}
```

Toggle the MCP ON in Cursor's MCP panel. The `nautilo_server_logs`
tool should now be available alongside `electron_console_logs`.

## Usage

See the tool's description in `index.ts` — it covers the full
filter set (last / since / grep / turnId / level / clear / path)
and typical debugging flow.

Quick examples:

```
# last 50 lines
nautilo_server_logs({ last: 50 })

# full flow of a single turn (requires D082 PR B turnId in the log)
nautilo_server_logs({ turnId: "d7ac0193-069b-43c9-990d-a86f4f21f477" })

# everything in the last 5 minutes that mentions "approval"
nautilo_server_logs({ since: "5m", grep: "approval" })

# clean-slate test: archive + truncate, then capture the next action
nautilo_server_logs({ clear: true })
# ... trigger the action ...
nautilo_server_logs({ last: 100 })
```

## Log path resolution

Tries (first match wins):

1. Tool call `path` argument (explicit per-call override)
2. `NAUTILO_SERVER_LOG_PATH` env var (recommended; set in MCP config)
3. `~/.nautilo/logs/nautilo-server.log`

If none resolve, the tool returns a clear error telling the user to
set `NAUTILO_SERVER_LOG_PATH`.

## Why this is separate from `electron_console_logs`

- Different data source: renderer console is an ephemeral ring
  buffer; server log is a persistent file.
- Different failure modes: renderer logs vanish on page reload;
  server logs persist across restarts.
- Different filters: turnId matters for server flows; renderer logs
  don't carry turnId today.

The two tools are designed to be used together — a single debugging
session typically pulls from both.
