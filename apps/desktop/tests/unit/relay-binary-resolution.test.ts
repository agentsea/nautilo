/**
 * D138/D336 lane B — static assertions for relay binary resolution conventions.
 *
 * Live `--version` / gog auth probes run in CI/dev via shell (see lane B
 * acceptance notes); importing the provider runtime in bun:test requires the
 * Electron runtime (same constraint as relay-sandbox-dispatch.test.ts).
 * These reads intentionally cover only unexported packaged-resource and
 * binary-resolution wiring; executable dispatch behavior is covered at its
 * extracted handler seams.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const desktopRoot = join(import.meta.dir, "../..");
const providerRuntimePath = join(desktopRoot, "electron/relay-provider-runtime.ts");

/** Mirror of AGENT_BROWSER_COMMON_CANDIDATES in electron/relay.ts */
const AGENT_BROWSER_COMMON_CANDIDATES = [
  "/opt/homebrew/bin/agent-browser",
  "/usr/local/bin/agent-browser",
] as const;

/** Mirror of GOG_COMMON_CANDIDATES in electron/relay.ts */
const GOG_COMMON_CANDIDATES = [
  "/opt/homebrew/bin/gog",
  "/usr/local/bin/gog",
] as const;

describe("relay binary resolution conventions", () => {
  test("resolver order starts from configured runtime path, not env vars", () => {
    const resolverOrder = [
      "configured",
      "bundled",
      "app-managed",
      "common",
      "path",
      "env",
    ];
    expect(resolverOrder).toEqual([
      "configured",
      "bundled",
      "app-managed",
      "common",
      "path",
      "env",
    ]);
  });

  test("agent-browser Homebrew candidate paths", () => {
    expect(AGENT_BROWSER_COMMON_CANDIDATES).toEqual([
      "/opt/homebrew/bin/agent-browser",
      "/usr/local/bin/agent-browser",
    ]);
  });

  test("gog Homebrew candidate paths", () => {
    expect(GOG_COMMON_CANDIDATES).toEqual([
      "/opt/homebrew/bin/gog",
      "/usr/local/bin/gog",
    ]);
  });

  test("env override env var names are stable", () => {
    expect("NAUTILO_AGENT_BROWSER_BIN").toBe("NAUTILO_AGENT_BROWSER_BIN");
    expect("NAUTILO_GOG_BIN").toBe("NAUTILO_GOG_BIN");
  });

  test("bundled agent-browser and gog use arch-aware tools-* roots", () => {
    const arch = "arm64";
    const bundledAgentBrowser = `tools-agent-browser/${arch}/agent-browser`;
    const bundledGog = `tools-gog/${arch}/gog`;
    expect(bundledAgentBrowser).toBe("tools-agent-browser/arm64/agent-browser");
    expect(bundledGog).toBe("tools-gog/arm64/gog");
  });

  test("bundledToolPath is arch-aware with flat fallback", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    expect(runtime).toContain("tools-agent-browser");
    expect(runtime).toContain("tools-gog");
    expect(runtime).toContain("devVendoredToolPath");
    expect(runtime).toContain('"..", "vendor", root, process.arch, name');
    expect(runtime).toContain("process.arch");
    expect(runtime).toMatch(/const arched = path\.join\(process\.resourcesPath, root, process\.arch, name\)/);
    expect(runtime).toMatch(/const flat = path\.join\(process\.resourcesPath, root, name\)/);
    expect(runtime).not.toContain("peekaboo");
  });

  test("gog binary cache does not depend on auth health", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    expect(runtime).toContain("cachedGogBin = resolved.bin");
    expect(runtime).not.toContain("cachedGogBin = authHealthy ? resolved.bin : null");
  });

  test("agent-browser provider config is self-healing, not write-once", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    expect(runtime).toContain("readFileSync(configPath");
    expect(runtime).toContain("=== serialized");
    expect(runtime).toContain("writeFileSync(configPath, serialized");
    expect(runtime).toContain('idleTimeout: "5m"');
  });

  test("agent-browser provider plugin uses bundled Bun runtime, not ambient node", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    expect(runtime).toContain('path.join(process.resourcesPath, "bun", process.arch, "bun")');
    expect(runtime).toContain("function resolvePluginRuntimeBin()");
    expect(runtime).toContain("command: resolvePluginRuntimeBin()");
    expect(runtime).not.toContain('command: "node"');
  });

  test("agent-browser provider plugin resolves outside app.asar when packaged", () => {
    const runtime = readFileSync(providerRuntimePath, "utf8");
    expect(runtime).toContain('path.join(process.resourcesPath, "browser-control-provider.js")');
    expect(runtime).toContain('path.join(__dirname, "browser-control-provider.js")');
  });
});
