import { describe, expect, test } from "bun:test";
import type { McpServer } from "../../lib/mcp-servers-api";
import { resolveConnectionEditorSelection } from "./connections-view-model";

function row(id: string, host: string): McpServer {
  return {
    id, name: "shared", host, transportKind: "stdio", transport: {},
    envPassthrough: null, envLiteral: null, authRef: null, namespaceId: null,
    includeTools: null, excludeTools: null, enabled: false, trustTier: null,
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
  };
}

describe("connection editor exact-row selection", () => {
  test("hostless duplicate deep links require a choice; exact host selects deterministically", () => {
    const servers = [row("official", "server"), row("local", "relay-desktop")];
    expect(resolveConnectionEditorSelection(servers, "shared", null)).toEqual({
      kind: "ambiguous", choices: servers,
    });
    expect(resolveConnectionEditorSelection(servers, "shared", "relay-desktop")).toEqual({
      kind: "selected", server: servers[1],
    });
    expect(resolveConnectionEditorSelection(servers, "shared", "missing")).toEqual({ kind: "missing" });
  });
});
