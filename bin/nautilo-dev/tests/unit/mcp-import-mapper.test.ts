import { describe, expect, test } from "bun:test";
import { claudeDesktopConfigToRows, mcpCmd } from "../../src/commands/mcp";

describe("claudeDesktopConfigToRows (D384 2.3.3)", () => {
  test("maps a stdio server and captures env NAMES only (values dropped)", () => {
    const plan = claudeDesktopConfigToRows({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "ghp_SECRETVALUE", FOO: "bar" },
        },
      },
    });
    expect(plan.rows).toHaveLength(1);
    const row = plan.rows[0]!;
    expect(row.name).toBe("github");
    expect(row.transportKind).toBe("stdio");
    expect(row.transport).toEqual({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] });
    expect(row.enabled).toBe(false);
    // env NAMES captured...
    expect(row.envPassthrough).toEqual(["GITHUB_TOKEN", "FOO"]);
    // ...and the secret VALUE never appears anywhere in the serialized row.
    expect(JSON.stringify(row)).not.toContain("ghp_SECRETVALUE");
    expect(plan.droppedSecrets).toEqual([{ name: "github", keys: ["GITHUB_TOKEN", "FOO"] }]);
  });

  test("maps a url server to streamable-http", () => {
    const plan = claudeDesktopConfigToRows({
      mcpServers: { remote: { url: "https://mcp.example.com/mcp" } },
    });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]!.transportKind).toBe("streamable-http");
    expect(plan.rows[0]!.transport).toEqual({ url: "https://mcp.example.com/mcp" });
    expect(plan.droppedSecrets).toEqual([]);
  });

  test("stdio server without env has no envPassthrough and no dropped secrets", () => {
    const plan = claudeDesktopConfigToRows({
      mcpServers: { fs: { command: "mcp-fs", args: ["/tmp"] } },
    });
    expect(plan.rows[0]!.envPassthrough).toBeUndefined();
    expect(plan.droppedSecrets).toEqual([]);
  });

  test("skips entries with neither command nor url", () => {
    const plan = claudeDesktopConfigToRows({
      mcpServers: { broken: {} },
    });
    expect(plan.rows).toHaveLength(0);
    expect(plan.skipped).toEqual([{ name: "broken", reason: "no `command` or `url`" }]);
  });

  test("empty / missing mcpServers yields an empty plan", () => {
    expect(claudeDesktopConfigToRows({}).rows).toHaveLength(0);
    expect(claudeDesktopConfigToRows({ mcpServers: {} }).rows).toHaveLength(0);
  });
});

describe("mcpCmd arg validation (no DB)", () => {
  test("enable without a name exits 2 (before any DB access)", async () => {
    expect(await mcpCmd(["enable"])).toBe(2);
  });
  test("disable without a name exits 2 (before any DB access)", async () => {
    expect(await mcpCmd(["disable"])).toBe(2);
  });
  test("unknown subcommand exits 1", async () => {
    expect(await mcpCmd(["frobnicate"])).toBe(1);
  });
});
