import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayMcpHostHandle } from "@nautilo/mcp-client";
import type {
  RelayClaudeConnectionHostPort,
  RelayClaudeExecutionHostPort,
} from "@nautilo/relay";
import { createDesktopHostedRelayAdapter } from "../../electron/relay-hosted-adapters.ts";

const desktopRoot = join(import.meta.dir, "../..");
const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const builder = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
const build = readFileSync(join(desktopRoot, "scripts/build-electron.ts"), "utf8");
const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");

test("D452 bundles the SDK JavaScript at build time but never packages its optional Claude CLI artifact", () => {
  // The host is used only by the esbuild main bundle. Keeping it out of
  // production dependencies means electron-builder cannot traverse its large
  // optional platform CLI package into app.asar or app.asar.unpacked.
  expect(packageJson.devDependencies?.["@nautilo/claude-agent-sdk-host"]).toBe("workspace:*");
  expect(packageJson.dependencies?.["@nautilo/claude-agent-sdk-host"]).toBeUndefined();
  expect(packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toBeUndefined();
  expect(packageJson.dependencies?.["@anthropic-ai/claude-agent-sdk-darwin-arm64"]).toBeUndefined();
  expect(build).not.toMatch(/external:\s*\[[^\]]*claude-agent-sdk/s);
  // No resource mapping or unpack rule can select the SDK's optional CLI.
  expect(builder).not.toContain("claude-agent-sdk-darwin");
  expect(builder).not.toContain("tools-claude");
  expect(builder).not.toContain("vendor/claude");
});

test("D452 advertises the compiled host while every Check again revalidates ambient runtime truth", () => {
  expect(main).toContain("claudeConnectionHostPort: claudeConnection");
  expect(main).not.toContain("claudeConnection.isRuntimeAvailable");
  let ready = false;
  const claudeConnectionHostPort: RelayClaudeConnectionHostPort = {
    isReady: () => ready,
    onRegistered: () => {},
    onDiscover: () => {},
  };
  const hosted = createDesktopHostedRelayAdapter({ claudeConnectionHostPort });
  expect(hosted.capabilities()).toEqual({ mcpTools: [] });
  ready = true;
  expect(hosted.capabilities()).toEqual({
    mcpTools: [],
    claude: {
      version: 1,
      hostKind: "electron",
      registrations: ["claude-agent-sdk"],
    },
  });
});

test("D452 keeps Current-Folder Claude execution explicitly gated and separate from discovery", () => {
  expect(main).toContain('let claudeExecutionHost: ElectronClaudeExecutionHost | null = null;');
  expect(main).toContain('process.env["NAUTILO_CLAUDE_CODE_TASKS"] === "1"');
  expect(main).toContain("claudeExecutionHost = new ElectronClaudeExecutionHost({");
  expect(main).toContain("currentFolder: () => currentFolderPath === null");
  expect(main).toContain("Object.freeze({ path: currentFolderPath, revision: currentFolderRevision })");
  expect(main).toContain("...(claudeExecutionHost === null ? {} : { claudeExecutionHostPort: claudeExecutionHost })");
  expect(main).not.toMatch(/claudeExecutionHost[\s\S]{0,240}genieWorkspaceRoot/);

  const claudeConnectionHostPort: RelayClaudeConnectionHostPort = {
    isReady: () => false,
    onRegistered: () => {},
    onDiscover: () => {},
  };
  const claudeExecutionHostPort: RelayClaudeExecutionHostPort = {
    isReady: () => true,
    onRegistered: () => {},
    onCommand: () => {},
  };
  const hosted = createDesktopHostedRelayAdapter({
    claudeConnectionHostPort,
    claudeExecutionHostPort,
  });
  expect(hosted.capabilities()).toEqual({
    mcpTools: [],
    claudeExecution: { version: 2 },
  });
  const mcpHost = { identity: "candidate" } as unknown as RelayMcpHostHandle;
  const ports = hosted.clientPorts(mcpHost);
  expect(ports.mcpHost).toBe(mcpHost);
  expect(ports.claudeConnectionHostPort).toBe(claudeConnectionHostPort);
  expect(ports.claudeExecutionHostPort).toBe(claudeExecutionHostPort);

  const assignment = main.indexOf("currentFolderPath = p;");
  const revoked = main.indexOf("claudeExecutionHost?.onCurrentFolderChanged();", assignment);
  const recent = main.indexOf("pushRecentCurrentFolder(p);", assignment);
  expect(assignment).toBeGreaterThan(-1);
  expect(revoked).toBeGreaterThan(assignment);
  expect(recent).toBeGreaterThan(revoked);
  expect(main).toContain("const currentFolderChanged = currentFolderPath !== p;");
  expect(main).toContain("if (currentFolderChanged) claudeExecutionHost?.onCurrentFolderChanged();");
});
