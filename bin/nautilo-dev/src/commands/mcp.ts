/**
 * D384 P2 / 2.3.3 — `nautilo-dev mcp <verb>` operator CLI for the MCP host.
 *
 * Thin skin over the existing `mcp_servers` config table + `@nautilo/mcp-client`:
 *
 *   mcp list                 Show configured MCP servers (name, transport, ns, enabled).
 *   mcp test <name>          Connect to ONE configured server + list its tools (no DB write).
 *   mcp import <path>        Parse a Claude-Desktop config and (with --apply) insert rows.
 *
 * Security posture (matches D384 C0): the `mcp_servers` table NEVER stores
 * secrets. `import` therefore captures env-var NAMES only (as `envPassthrough`)
 * and DROPS the literal values Claude-Desktop embeds, warning the operator to
 * set them in the host environment. Imported rows are `enabled: false` so an
 * unreviewed local MCP never auto-connects on the next boot.
 */
import { readFileSync } from "node:fs";
import {
  createDirectDb,
  eq,
  mcpServers,
} from "@nautilo/db";
import {
  McpClientManager,
  type McpAuthRef,
  type McpServerConfig,
  type McpTransportConfig,
  type McpTransportKind,
} from "@nautilo/mcp-client";
import type { ToolTrustTier } from "@nautilo/types";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

type McpServerRow = typeof mcpServers.$inferSelect;
type NewMcpServerRow = typeof mcpServers.$inferInsert;

// ---------------------------------------------------------------------------
// arg helpers (local — mirrors the tiny helpers other commands use)
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--config-env"]);

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

/** Non-flag positionals (skips `--flag` and the value of value-flags). */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (VALUE_FLAGS.has(a) && i + 1 < args.length) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const USAGE = `
nautilo-dev mcp — inspect and configure MCP servers (D384)

Usage:
  mcp list [--json]                 List configured mcp_servers rows
  mcp test <name>                   Connect to one server + list its tools (no DB write)
  mcp import <path> [--apply]       Import a Claude-Desktop config into mcp_servers
                                    (dry-run by default; --apply writes)
  mcp enable <name>                 Set a server's enabled=true (connects at next boot)
  mcp disable <name>                Set a server's enabled=false

Flags:
  --json                            (list) machine-readable output
  --apply                           (import) actually insert rows (default: dry-run)
  --config-env <path>               override instance.env path
  --i-know-what-i-am-doing          (import --apply / enable / disable) allow the protected default instance
`.trim();

// ---------------------------------------------------------------------------
// row → McpServerConfig (mirror of server-side dbRowToMcpServerConfig; inlined
// so the CLI doesn't pull in all of @nautilo/server for one mapper)
// ---------------------------------------------------------------------------

function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    name: row.name,
    host: row.host,
    transportKind: row.transportKind as McpTransportKind,
    transport: row.transport as McpTransportConfig,
    envPassthrough: row.envPassthrough ?? null,
    envLiteral: (row.envLiteral as Record<string, string> | null) ?? null,
    authRef: (row.authRef as McpAuthRef | null) ?? null,
    namespaceId: row.namespaceId ?? null,
    includeTools: row.includeTools ?? null,
    excludeTools: row.excludeTools ?? null,
    enabled: row.enabled,
    trustTier: (row.trustTier as ToolTrustTier | null) ?? null,
    spawnSandboxProfile: row.spawnSandboxProfile ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Claude-Desktop config → mcp_servers rows (pure — unit tested)
// ---------------------------------------------------------------------------

interface ClaudeDesktopServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}
interface ClaudeDesktopConfig {
  mcpServers?: Record<string, ClaudeDesktopServer>;
}

export interface ClaudeImportPlan {
  rows: NewMcpServerRow[];
  /** Per server: env var names captured as passthrough (values were dropped). */
  droppedSecrets: Array<{ name: string; keys: string[] }>;
  /** Entries we could not map (neither command nor url). */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Map a parsed Claude-Desktop config into `mcp_servers` insert rows.
 *
 * - `{ command, args, env }` → stdio transport; env var NAMES become
 *   `envPassthrough`, env VALUES are dropped (never stored — D384 C0).
 * - `{ url }` → streamable-http transport.
 * - imported rows are `enabled: false` (operator reviews then enables).
 */
export function claudeDesktopConfigToRows(
  parsed: ClaudeDesktopConfig,
): ClaudeImportPlan {
  const rows: NewMcpServerRow[] = [];
  const droppedSecrets: ClaudeImportPlan["droppedSecrets"] = [];
  const skipped: ClaudeImportPlan["skipped"] = [];

  const servers = parsed.mcpServers ?? {};
  for (const [name, def] of Object.entries(servers)) {
    if (def.command) {
      const envKeys = def.env ? Object.keys(def.env) : [];
      const row: NewMcpServerRow = {
        name,
        host: "server",
        transportKind: "stdio",
        transport: { command: def.command, args: def.args ?? [] },
        enabled: false,
        ...(envKeys.length > 0 ? { envPassthrough: envKeys } : {}),
      };
      rows.push(row);
      if (envKeys.length > 0) droppedSecrets.push({ name, keys: envKeys });
    } else if (def.url) {
      rows.push({
        name,
        host: "server",
        transportKind: "streamable-http",
        transport: { url: def.url },
        enabled: false,
      });
    } else {
      skipped.push({ name, reason: "no `command` or `url`" });
    }
  }

  return { rows, droppedSecrets, skipped };
}

// ---------------------------------------------------------------------------
// verbs
// ---------------------------------------------------------------------------

async function mcpList(args: string[]): Promise<number> {
  loadConfigEnvIntoProcess({ path: flagValue(args, "--config-env") });
  const db = createDirectDb(1);
  try {
    const rows = await db.select().from(mcpServers).orderBy(mcpServers.name);
    if (hasFlag(args, "--json")) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      console.log("[mcp] No mcp_servers configured.");
      return 0;
    }
    console.log(`[mcp] ${rows.length} server(s):`);
    for (const r of rows) {
      const ns = r.namespaceId ?? "global";
      const state = r.enabled ? "enabled" : "disabled";
      console.log(
        `  ${r.name}  ·  ${r.transportKind}  ·  host=${r.host}  ·  ns=${ns}  ·  ${state}  ·  tier=${r.trustTier ?? "standard"}`,
      );
    }
    return 0;
  } finally {
    await db.end();
  }
}

async function mcpTest(name: string, args: string[]): Promise<number> {
  loadConfigEnvIntoProcess({ path: flagValue(args, "--config-env") });
  const db = createDirectDb(1);
  let row: McpServerRow | undefined;
  try {
    [row] = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .limit(1);
  } finally {
    await db.end();
  }
  if (!row) {
    console.error(`[mcp] test: no server named "${name}" in mcp_servers.`);
    return 1;
  }

  // Force-enable for the probe so a disabled row can still be tested.
  const cfg: McpServerConfig = { ...rowToConfig(row), enabled: true };
  const mgr = new McpClientManager();
  try {
    console.log(`[mcp] connecting "${name}" (${cfg.transportKind})…`);
    const tools = await mgr.connect(cfg);
    console.log(`[mcp] OK — ${tools.length} tool(s):`);
    for (const t of tools) {
      console.log(`  ${t.name}${t.description ? `  — ${t.description}` : ""}`);
    }
    return 0;
  } catch (e) {
    console.error(
      `[mcp] test FAILED for "${name}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  } finally {
    await mgr.stopAll();
  }
}

async function mcpImport(path: string, args: string[]): Promise<number> {
  const apply = hasFlag(args, "--apply");

  let parsed: ClaudeDesktopConfig;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as ClaudeDesktopConfig;
  } catch (e) {
    console.error(
      `[mcp] import: could not read/parse "${path}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return 2;
  }

  const plan = claudeDesktopConfigToRows(parsed);
  if (plan.rows.length === 0 && plan.skipped.length === 0) {
    console.log("[mcp] import: no `mcpServers` entries found in the config.");
    return 0;
  }

  console.log(
    `[mcp] import ${apply ? "APPLY" : "DRY-RUN"} — ${plan.rows.length} server(s) to insert (enabled=false):`,
  );
  for (const r of plan.rows) {
    console.log(`  ${r.name}  ·  ${r.transportKind}`);
  }
  for (const d of plan.droppedSecrets) {
    console.log(
      `  ⚠ "${d.name}": captured env NAMES [${d.keys.join(", ")}] as passthrough — VALUES were NOT stored (set them in the host environment).`,
    );
  }
  for (const s of plan.skipped) {
    console.log(`  ⤳ skipped "${s.name}": ${s.reason}`);
  }

  if (!apply) {
    console.log("");
    console.log(
      "[mcp] DRY-RUN — nothing written. Re-run with --apply to insert. Imported servers are created disabled; enable after review.",
    );
    return 0;
  }

  if (plan.rows.length === 0) {
    console.log("[mcp] import: nothing to insert.");
    return 0;
  }

  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:mcp import",
    cwd: process.cwd(),
    isDryRunOrReadOnly: false,
    ...(hasFlag(args, "--i-know-what-i-am-doing") ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: flagValue(args, "--config-env") });
  const db = createDirectDb(1);
  try {
    const inserted = await db
      .insert(mcpServers)
      .values(plan.rows)
      .onConflictDoNothing()
      .returning({ name: mcpServers.name });
    console.log("");
    console.log(
      `[mcp] APPLIED — inserted ${inserted.length} server(s); ${plan.rows.length - inserted.length} skipped (name conflict). Enable with an UPDATE once reviewed.`,
    );
    return 0;
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// enable / disable — flip the `enabled` flag on one server
// ---------------------------------------------------------------------------

async function mcpSetEnabled(
  name: string,
  enabled: boolean,
  args: string[],
): Promise<number> {
  // Mutates mcp_servers → same default-instance guard as `import --apply`.
  const verb = enabled ? "enable" : "disable";
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: `dev:mcp ${verb}`,
    cwd: process.cwd(),
    isDryRunOrReadOnly: false,
    ...(hasFlag(args, "--i-know-what-i-am-doing") ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: flagValue(args, "--config-env") });
  const db = createDirectDb(1);
  try {
    const r = await db
      .update(mcpServers)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(mcpServers.name, name))
      .returning({ name: mcpServers.name, enabled: mcpServers.enabled });
    if (r.length === 0) {
      console.error(`[mcp] ${verb}: no server named "${name}" in mcp_servers.`);
      return 1;
    }
    console.log(
      `[mcp] "${name}" ${verb}d.${enabled ? " Restart the server (startMcpHost reads enabled rows at boot) to connect it." : ""}`,
    );
    return 0;
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function mcpCmd(args: string[]): Promise<number> {
  const pos = positionals(args);
  const verb = pos[0];
  switch (verb) {
    case "list":
    case "ls":
      return mcpList(args);
    case "test": {
      const name = pos[1];
      if (!name) {
        console.error("[mcp] test: missing <name>. Usage: mcp test <name>");
        return 2;
      }
      return mcpTest(name, args);
    }
    case "import": {
      const path = pos[1];
      if (!path) {
        console.error("[mcp] import: missing <path>. Usage: mcp import <path> [--apply]");
        return 2;
      }
      return mcpImport(path, args);
    }
    case "enable":
    case "disable": {
      const name = pos[1];
      if (!name) {
        console.error(`[mcp] ${verb}: missing <name>. Usage: mcp ${verb} <name>`);
        return 2;
      }
      return mcpSetEnabled(name, verb === "enable", args);
    }
    case "help":
    case undefined:
      console.log(USAGE);
      return 0;
    default:
      console.error(`[mcp] unknown subcommand: ${verb}\n`);
      console.log(USAGE);
      return 1;
  }
}
