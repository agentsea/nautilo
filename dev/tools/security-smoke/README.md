# `nautilo-security-smoke-mcp`

Stdio MCP server that exposes the Nautilo security smoke harness (D063)
to any MCP-capable agent — Cursor, Claude Desktop, Nautilo itself.

Sibling of [`dev/tools/electron-debug/`](../electron-debug/). Same shape,
different target: this one drives `nautilo-smoke serve` via its HTTP API.

## Tools

| Tool | What |
|---|---|
| `run_security_smoke` | Execute the matrix (or a filtered subset), block until done, return a summarized report |
| `smoke_list_tests` | List the test catalog, optionally filtered by layer / platform / pattern |
| `smoke_status` | Combined VM health for both platforms |
| `smoke_snapshot` | Take a named snapshot on a given platform |
| `smoke_restore` | Restore from a named snapshot |
| `smoke_report` | Fetch a past run's report by `run_id` |

## Install

### 1. Start the smoke server

This MCP is a thin client over the HTTP API. Before using it, run the
server:

```bash
cd /path/to/nautilo
bun run bin/nautilo-smoke/src/index.ts serve
# or: bun nautilo-smoke serve (if installed as a binary)
```

First start creates `~/.nautilo/smoke-token` with mode 0600. The MCP
reads the token from that file (or `NAUTILO_SMOKE_TOKEN` env var).

### 2. Install dependencies for this MCP

```bash
cd dev/tools/security-smoke
bun install
```

### 3. Add to your agent's MCP config

For Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "nautilo-security-smoke": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/nautilo/dev/tools/security-smoke/index.ts"]
    }
  }
}
```

For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nautilo-security-smoke": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/nautilo/dev/tools/security-smoke/index.ts"],
      "env": {
        "NAUTILO_SMOKE_URL": "http://127.0.0.1:7788"
      }
    }
  }
}
```

### 4. Try it

In Cursor chat:

> "Run the full security smoke on both platforms and summarize."

The agent translates that into `run_security_smoke({ platform: "both" })`,
the suite runs in the VMs (~6.5 min), and you get a structured summary.

Or narrower:

> "Run just the PATH-* tests on Linux and tell me which ones failed."

## Environment variables

- `NAUTILO_SMOKE_URL` — HTTP API base URL. Default `http://127.0.0.1:7788`.
- `NAUTILO_SMOKE_TOKEN` — bearer token override. If unset, read from
  `~/.nautilo/smoke-token`.

## Exit / lifecycle

The MCP server runs as stdio — the agent spawns it, talks JSON-RPC
over stdin/stdout, and kills it on agent exit. There's no persistent
state on the MCP side; all run history lives in the `nautilo-smoke serve`
process (which retains up to 32 completed runs in memory by default).

## Related

- [`@nautilo/smoke-runner`](../../../packages/smoke-runner/) — library core
- [`bin/nautilo-smoke`](../../../bin/nautilo-smoke/) — CLI (including `serve`)
- [Security test environment](../../../scripts/security-test-env/README.md) — setup and expected outcomes
