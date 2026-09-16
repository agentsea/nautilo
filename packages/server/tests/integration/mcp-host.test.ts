/**
 * D384 Phase 0 ship-gate (tasks 0.7.2 / 0.7.3).
 *
 * End-to-end: a `mcp_servers` config row → `startMcpHost` → real
 * `@modelcontextprotocol/server-filesystem` spawned over stdio → tools
 * registered in the ToolCatalog → a live `read_file` round-trip.
 *
 * The DB read is stubbed (a fake handle returning one row) so the test
 * needs no migrations; everything else is real — real SDK client, real
 * child process, real MCP protocol. This is the credential-less path
 * (no authRef, no vault).
 *
 * Spawns `npx -y @modelcontextprotocol/server-filesystem`, so it needs
 * network + npx on first run (same as the Phase-0 SDK spike). Generous
 * per-test timeout accordingly.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCatalog } from "@nautilo/catalog";
import type { DirectDatabase } from "@nautilo/db";
import type { McpClientManager } from "@nautilo/mcp-client";
import { startMcpHost } from "../../src/mcp/mcp-host";

const SERVER_NAME = "test-fs";
// D384 C6 (2.1.2): the fs server is scoped to namespace A. An actor whose
// readable namespaces don't include A must not see its tools.
const NS_A = "11111111-1111-1111-1111-111111111111";
const NS_B = "22222222-2222-2222-2222-222222222222";

let workDir: string;
let filePath: string;
let catalog: ToolCatalog;
let manager: McpClientManager;

/** Build a fake `mcp_servers` row for the filesystem server over stdio. */
function fsServerRow(dir: string): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-0000000000fs",
    name: SERVER_NAME,
    host: "server",
    transportKind: "stdio",
    transport: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", dir],
    },
    envPassthrough: null,
    envLiteral: null,
    authRef: null,
    namespaceId: NS_A,
    includeTools: null,
    excludeTools: null,
    enabled: true,
    trustTier: null,
    spawnSandboxProfile: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Minimal DirectDatabase stub: `select().from().where()` → one fs row. */
function fakeDb(row: Record<string, unknown>): DirectDatabase {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([row]),
      }),
    }),
  } as unknown as DirectDatabase;
}

beforeAll(async () => {
  // realpath: the filesystem server canonicalizes its allowed-dir list, so
  // a symlinked $TMPDIR (macOS) would otherwise reject every read.
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-host-e2e-")));
  filePath = join(workDir, "sample.txt");
  writeFileSync(filePath, "hello mcp e2e", "utf8");

  catalog = new ToolCatalog();
  manager = await startMcpHost({ catalog, db: fakeDb(fsServerRow(workDir)) });
});

afterAll(async () => {
  await manager?.stopAll();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe("startMcpHost — filesystem MCP end-to-end", () => {
  test("connects the server and registers its tools in the catalog", () => {
    expect(manager.getState(SERVER_NAME)).toBe("connected");
    // The filesystem server exposes read_file + list_directory among others.
    expect(catalog.has("read_file")).toBe(true);
    const entry = catalog.get("read_file");
    expect(entry?.source).toBe("mcp");
    expect(entry?.exposure).toBe("discoverable");
    expect(entry?.sourceServer).toBe(SERVER_NAME);
    expect(entry?.executor).toBe("cloud");
    const mcpTools = catalog.query({ source: "mcp" });
    expect(mcpTools.length).toBeGreaterThan(0);
  });

  test("dispatch reads a real file through the MCP server (ship gate)", async () => {
    const out = await manager.dispatch("read_file", { path: filePath });
    expect(out).toContain("hello mcp e2e");
  });

  test("C6 (2.1.2): namespace-scoped MCP tools honor the actor's readable namespaces (Phase-2 ship gate)", () => {
    // startMcpHost stamped the server's namespace onto each registered entry.
    expect(catalog.get("read_file")?.namespaceId).toBe(NS_A);

    const namesFor = (readableNamespaces?: readonly string[]) =>
      catalog
        .getToolsForActor(
          {},
          undefined,
          undefined,
          undefined,
          readableNamespaces ? { readableNamespaces } : undefined,
        )
        .map((t) => t.name);

    // Actor in a room whose readable namespaces INCLUDE A → sees the tool.
    expect(namesFor([NS_A])).toContain("read_file");
    // Actor in a NON-superset room (only B readable) → tool is invisible.
    expect(namesFor([NS_B])).not.toContain("read_file");
    // Actor with NO readable namespaces (guest/scope envelope) → invisible (fail-closed).
    expect(namesFor([])).not.toContain("read_file");
    // No namespace filter supplied → unchanged (backward compatible).
    expect(namesFor(undefined)).toContain("read_file");
  });
});
