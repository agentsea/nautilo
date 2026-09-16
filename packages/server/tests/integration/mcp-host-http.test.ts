/**
 * D384 Phase 1 ship gate (task 1.3.3) — github MCP over Streamable HTTP with
 * an env-token, end-to-end.
 *
 * ENV-GATED: needs a real GitHub token in `GITHUB_MCP_PAT` + network, so it is
 * skipped when the token is absent (never flakes CI). The stdio ship gate
 * (`mcp-host.test.ts`) is the always-on end-to-end proof; the HTTP transport +
 * env-token auth are unit-covered in `@nautilo/mcp-client`. Run this with a
 * PAT exported to fully verify the HTTP path against the real github server.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { ToolCatalog } from "@nautilo/catalog";
import type { DirectDatabase } from "@nautilo/db";
import type { McpClientManager } from "@nautilo/mcp-client";
import { startMcpHost } from "../../src/mcp/mcp-host";

const TOKEN_ENV = "GITHUB_MCP_PAT";
const gate = process.env[TOKEN_ENV] ? test : test.skip;

let manager: McpClientManager | undefined;

function fakeDb(row: Record<string, unknown>): DirectDatabase {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
  } as unknown as DirectDatabase;
}

function githubRow(): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-00000000gh01",
    name: "github",
    host: "server",
    transportKind: "streamable-http",
    transport: { url: "https://api.githubcopilot.com/mcp/" },
    envPassthrough: null,
    envLiteral: null,
    authRef: { type: "env", envVar: TOKEN_ENV },
    namespaceId: null,
    includeTools: null,
    excludeTools: null,
    enabled: true,
    trustTier: null,
    spawnSandboxProfile: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

afterAll(async () => {
  await manager?.stopAll();
});

describe("startMcpHost — github MCP over HTTP (env-gated)", () => {
  gate(
    "connects github over Streamable HTTP with an env token and registers tools",
    async () => {
      const catalog = new ToolCatalog();
      manager = await startMcpHost({ catalog, db: fakeDb(githubRow()) });
      expect(manager.getState("github")).toBe("connected");
      expect(catalog.query({ source: "mcp" }).length).toBeGreaterThan(0);
    },
    90_000,
  );
});
