/**
 * Stack 39 Phase 3D — getFirstRunConnectTargets includes recent servers.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tempRoot = "";
let browseFailure: unknown = null;
let browseRows = [
  {
    name: "mdns-hit",
    serverUrl: "https://upgrade.example.test/",
  },
];

mock.module("electron", () => ({
  app: {
    getPath: () => os.tmpdir(),
    isPackaged: false,
  },
}));

mock.module("electron-log/main", () => ({
  default: {
    warn: () => {},
    info: () => {},
    error: () => {},
  },
}));

mock.module("../../electron/paths", () => ({
  recentServersFilePath: () => path.join(tempRoot, "recent-servers.json"),
  browserControlStateFilePath: () => path.join(tempRoot, "browser-control-state.json"),
  browserControlAgentBrowserConfigPath: () =>
    path.join(tempRoot, "agent-browser-provider.json"),
  toolRuntimeConfigFilePath: () => path.join(tempRoot, "tool-runtimes.json"),
  localFileHistoryDirPath: () => path.join(tempRoot, "local-file-history"),
}));

mock.module("@nautilo/instance-discovery/node", () => ({
  listLocalInstances: async () => [
    {
      projectName: "local-dev",
      root: "/tmp/layout-root",
      state: "running" as const,
    },
  ],
  browseLocalInstances: async () => {
    if (browseFailure !== null) throw browseFailure;
    return browseRows;
  },
  readPersistedTuiServerTarget: () => "https://tui-last.example",
  readServerUrlFromLayoutRoot: () => "https://upgrade.example.test",
}));

let getFirstRunConnectTargets: typeof import("../../electron/first-run-connect-options").getFirstRunConnectTargets;
let pushRecentServer: typeof import("../../electron/recent-servers").pushRecentServer;

beforeEach(async () => {
  browseFailure = null;
  browseRows = [{ name: "mdns-hit", serverUrl: "https://upgrade.example.test/" }];
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-first-run-connect-"));
  const connectMod = await import("../../electron/first-run-connect-options");
  const recentMod = await import("../../electron/recent-servers");
  getFirstRunConnectTargets = connectMod.getFirstRunConnectTargets;
  pushRecentServer = recentMod.pushRecentServer;
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("getFirstRunConnectTargets", () => {
  test("includes recentServers from storage", async () => {
    pushRecentServer({ url: "https://recent.example", displayName: "Recent" });
    const result = await getFirstRunConnectTargets();
    expect(result.recentServers).toHaveLength(1);
    expect(result.recentServers[0]?.url).toBe("https://recent.example");
    expect(result.recentServers[0]?.displayName).toBe("Recent");
  });

  test("empty storage → recentServers: []", async () => {
    const result = await getFirstRunConnectTargets();
    expect(result.recentServers).toEqual([]);
  });

  test("dedupes mDNS/layout candidates that match a recent server (recent wins)", async () => {
    pushRecentServer({ url: "https://upgrade.example.test" });
    const result = await getFirstRunConnectTargets();
    expect(result.recentServers).toHaveLength(1);
    expect(result.recentServers[0]?.url).toBe("https://upgrade.example.test");
    expect(result.candidates.some((c) => c.url.includes("upgrade.example.test"))).toBe(
      false,
    );
  });

  test("still returns suggestedUrl from TUI target", async () => {
    const result = await getFirstRunConnectTargets();
    expect(result.suggestedUrl).toBe("https://tui-last.example");
    expect(result.localDiscovery).toEqual({ kind: "completed" });
  });

  test("reports a completed empty browse without claiming permission availability", async () => {
    browseRows = [];
    const result = await getFirstRunConnectTargets();
    expect(result.localDiscovery).toEqual({ kind: "completed" });
    expect(result.candidates).toHaveLength(1);
  });

  test("keeps layout, recent, and manual-target data when the bounded browse rejects", async () => {
    browseFailure = Object.assign(new Error("denied"), { code: "ERR_NETWORK_ACCESS_DENIED" });
    pushRecentServer({ url: "https://recent.example", displayName: "Recent" });
    const result = await getFirstRunConnectTargets();
    expect(result.localDiscovery).toEqual({ kind: "unavailable" });
    expect(result.candidates).toHaveLength(1);
    expect(result.recentServers).toMatchObject([{ url: "https://recent.example" }]);
    expect(result.suggestedUrl).toBe("https://tui-last.example");
  });

  test("keeps discovery optional without presenting an empty or unavailable scan as a failure", async () => {
    const source = fs.readFileSync(
      path.join(import.meta.dir, "../../electron/first-run-connect-options.ts"),
      "utf8",
    );
    const picker = fs.readFileSync(path.join(import.meta.dir, "../../first-run/index.tsx"), "utf8");
    expect(source).toContain("browseLocalInstances({ timeoutMs: 2000 })");
    expect(source.match(/browseLocalInstances\(/g)).toHaveLength(1);
    expect(picker).not.toContain("Automatic local-server discovery could not complete");
    expect(picker).not.toContain("No additional LAN-advertised Nautilo servers appeared in this scan");
    expect(picker).not.toContain("System Settings > Privacy & Security > Local Network");
    expect(picker).not.toContain("Retry local scan");
    expect(picker).not.toContain("Could not scan automatically");
    expect(picker).not.toContain("Local Network discovery was denied");
  });
});
