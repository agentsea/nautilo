import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const pluginPath = path.resolve(import.meta.dir, "../../plugins/with-nautilo-local-dev-network.js");
const requireFromThisFile = createRequire(import.meta.url);
const plugin = requireFromThisFile(pluginPath) as {
  constants: { DEBUG_MANIFEST: string; NETWORK_SECURITY_CONFIG: string };
  writeDebugLoopbackNetworkPolicy(projectRoot: string): Promise<void>;
};

describe("Android local development network policy", () => {
  test("generates a debug-only loopback allow-list without broad cleartext traffic", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "nautilo-local-network-"));
    try {
      await plugin.writeDebugLoopbackNetworkPolicy(projectRoot);
      const debugManifest = await readFile(
        path.join(projectRoot, "android/app/src/debug/AndroidManifest.xml"),
        "utf8",
      );
      const networkConfig = await readFile(
        path.join(projectRoot, "android/app/src/debug/res/xml/nautilo_local_dev_network_security_config.xml"),
        "utf8",
      );

      expect(debugManifest).toContain('android:networkSecurityConfig="@xml/nautilo_local_dev_network_security_config"');
      expect(debugManifest).not.toContain("usesCleartextTraffic");
      expect(networkConfig).toContain('<base-config cleartextTrafficPermitted="false" />');
      expect(networkConfig).toContain('<domain includeSubdomains="false">localhost</domain>');
      expect(networkConfig).toContain('<domain includeSubdomains="false">127.0.0.1</domain>');
      // Expo's Android development client rewrites host loopback to the
      // emulator's canonical host alias before opening its Metro socket.
      expect(networkConfig).toContain('<domain includeSubdomains="false">10.0.2.2</domain>');
      expect(networkConfig).not.toContain('<base-config cleartextTrafficPermitted="true"');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("does not change a generated production manifest", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "nautilo-local-network-main-"));
    const mainManifest = path.join(projectRoot, "android/app/src/main/AndroidManifest.xml");
    const sentinel = '<manifest><application android:label="Nautilo" /></manifest>';
    try {
      await mkdir(path.dirname(mainManifest), { recursive: true });
      await writeFile(mainManifest, sentinel);
      await plugin.writeDebugLoopbackNetworkPolicy(projectRoot);

      expect(await readFile(mainManifest, "utf8")).toBe(sentinel);
      expect(plugin.constants.DEBUG_MANIFEST).not.toContain('src/main');
      expect(plugin.constants.NETWORK_SECURITY_CONFIG).toContain("localhost");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
