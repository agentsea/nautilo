import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const desktopRoot = join(import.meta.dir, "../..");
const providerPath = join(desktopRoot, "electron/browser-control-provider.js");

function invokeProvider(input: unknown, statePath?: string) {
  const result = spawnSync("node", [providerPath, ...(statePath ? ["--state", statePath] : [])], {
    input: JSON.stringify(input),
    encoding: "utf-8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("browser-control provider plugin", () => {
  test("returns plugin manifest", () => {
    expect(invokeProvider({
      protocol: "agent-browser.plugin.v1",
      type: "plugin.manifest",
      capability: "plugin.manifest",
      request: {},
    })).toEqual({
      protocol: "agent-browser.plugin.v1",
      success: true,
      manifest: {
        name: "nautilo-browser",
        capabilities: ["browser.provider"],
        description: "Nautilo managed SaaS browser view provider",
      },
    });
  });

  test("returns active view cdpUrl with directPage", () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-browser-provider-"));
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      activeAppId: "google-docs",
      views: [
        {
          appId: "google-docs",
          partition: "persist:google-docs",
          url: "https://docs.google.com",
          visible: true,
          state: "hot",
          cdpUrl: "ws://127.0.0.1:1234/token",
        },
      ],
    }));

    expect(invokeProvider({
      protocol: "agent-browser.plugin.v1",
      type: "browser.launch",
      capability: "browser.provider",
      request: {},
    }, statePath)).toEqual({
      protocol: "agent-browser.plugin.v1",
      success: true,
      browser: {
        cdpUrl: "ws://127.0.0.1:1234/token",
        directPage: true,
        metadata: {
          appId: "google-docs",
          source: "nautilo-browser-control",
        },
      },
    });
  });

  test("fails closed when no active view is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "nautilo-browser-provider-"));
    const statePath = join(dir, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      activeAppId: null,
      views: [],
    }));

    const response = invokeProvider({
      protocol: "agent-browser.plugin.v1",
      type: "browser.launch",
      capability: "browser.provider",
      request: {},
    }, statePath);
    expect(response["success"]).toBe(false);
    expect(response["error"]).toBe("no active Nautilo browser view");
  });
});
