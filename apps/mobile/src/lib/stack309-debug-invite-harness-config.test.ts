import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const pluginPath = path.resolve(import.meta.dir, "../../plugins/with-nautilo-stack309-debug-invite-harness.js");
const localNetworkPluginPath = path.resolve(
  import.meta.dir,
  "../../plugins/with-nautilo-local-dev-network.js",
);
const requireFromThisFile = createRequire(import.meta.url);
const plugin = requireFromThisFile(pluginPath) as {
  constants: {
    DEBUG_RECEIVER_ACTION: string;
    DEBUG_RECEIVER_CLASS: string;
    STAGED_FILENAME: string;
    KOTLIN_SOURCE: string;
    TEST_MANIFEST: string;
    SECURE_INPUT_METHOD: string;
  };
  writeDebugInviteHarness(projectRoot: string): Promise<void>;
};
const localNetworkPlugin = requireFromThisFile(localNetworkPluginPath) as {
  writeDebugLoopbackNetworkPolicy(projectRoot: string): Promise<void>;
};

describe("Stack 309 Android debug invite harness", () => {
  test("generates the one-shot receiver only under the debug overlay", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "nautilo-stack309-invite-"));
    const mainManifest = path.join(projectRoot, "android/app/src/main/AndroidManifest.xml");
    const sentinel = '<manifest><application android:label="Nautilo" /></manifest>';
    try {
      await mkdir(path.dirname(mainManifest), { recursive: true });
      await writeFile(mainManifest, sentinel);
      await plugin.writeDebugInviteHarness(projectRoot);

      const debugManifest = await readFile(
        path.join(projectRoot, "android/app/src/debug/AndroidManifest.xml"),
        "utf8",
      );
      const receiver = await readFile(
        path.join(projectRoot, "android/app/src/debug/java/ai/nautilo/app/Stack309InviteHarnessReceiver.kt"),
        "utf8",
      );
      const networkConfig = await readFile(
        path.join(projectRoot, "android/app/src/debug/res/xml/nautilo_local_dev_network_security_config.xml"),
        "utf8",
      );
      const testManifest = await readFile(
        path.join(projectRoot, "android/app/src/androidTest/AndroidManifest.xml"),
        "utf8",
      );
      const secureInput = await readFile(
        path.join(projectRoot, "android/app/src/androidTest/java/ai/nautilo/app/Stack309SecureInputMethodService.java"),
        "utf8",
      );

      expect(await readFile(mainManifest, "utf8")).toBe(sentinel);
      expect(debugManifest).toContain(plugin.constants.DEBUG_RECEIVER_ACTION);
      expect(debugManifest).toContain(plugin.constants.DEBUG_RECEIVER_CLASS);
      expect(debugManifest).toContain('android:networkSecurityConfig="@xml/nautilo_local_dev_network_security_config"');
      expect(networkConfig).toContain('<base-config cleartextTrafficPermitted="false" />');
      expect(networkConfig).toContain("localhost");
      expect(networkConfig).toContain("127.0.0.1");
      expect(receiver).toContain("intent.extras != null");
      expect(receiver).toContain("staged.renameTo(claimed)");
      expect(receiver).toContain("finally");
      expect(receiver).toContain("claimed.delete()");
      expect(receiver).toContain(plugin.constants.STAGED_FILENAME);
      expect(testManifest).toContain("Stack309SecureInputMethodService");
      expect(testManifest).toContain("android.permission.BIND_INPUT_METHOD");
      expect(secureInput).toContain("connection.commitText");
      expect(secureInput).toContain('Pattern.compile("^[A-Za-z0-9_-]{12,64}$")');
      expect(secureInput).toContain("getCurrentInputEditorInfo()");
      expect(secureInput).toContain("InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD");
      expect(secureInput).toContain('claimedName.contains("password")');
      expect(secureInput).toContain("Context.RECEIVER_EXPORTED");
      expect(secureInput).toContain("fixture.delete()");
      expect(secureInput).not.toContain("Log.");
      expect(secureInput).not.toContain("Clipboard");
      expect(secureInput).not.toContain("exec-out");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test("does not disguise the local receiver as a production invite parser", () => {
    const source = plugin.constants.KOTLIN_SOURCE;
    expect(source).toContain("Debug-only acceptance harness");
    expect(source).toContain("ACTION_CONSUME");
    expect(source).not.toContain("Log.");
    expect(source).not.toContain("android.permission.INTERNET");
  });

  test("keeps secure input in androidTest and out of the shipped manifests", () => {
    expect(plugin.constants.TEST_MANIFEST).toContain("<service");
    expect(plugin.constants.SECURE_INPUT_METHOD).toContain("input method");
    expect(plugin.constants.SECURE_INPUT_METHOD).toContain("commitText");
    expect(plugin.constants.KOTLIN_SOURCE).not.toContain("Stack309SecureInputMethodService");
  });

  test("runs after the local debug network overlay so both remain present", async () => {
    const appConfig = JSON.parse(await readFile(path.resolve(import.meta.dir, "../../app.json"), "utf8")) as {
      expo: { plugins: string[] };
    };
    const plugins = appConfig.expo.plugins;
    expect(plugins.indexOf("./plugins/with-nautilo-local-dev-network"))
      .toBeLessThan(plugins.indexOf("./plugins/with-nautilo-stack309-debug-invite-harness"));
  });

  test("preserves the debug receiver and loopback policy when both plugins run in config order", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "nautilo-stack309-plugin-order-"));
    const mainManifest = path.join(projectRoot, "android/app/src/main/AndroidManifest.xml");
    const sentinel = '<manifest><application android:label="Nautilo" /></manifest>';
    try {
      await mkdir(path.dirname(mainManifest), { recursive: true });
      await writeFile(mainManifest, sentinel);

      await localNetworkPlugin.writeDebugLoopbackNetworkPolicy(projectRoot);
      await plugin.writeDebugInviteHarness(projectRoot);

      const debugManifest = await readFile(
        path.join(projectRoot, "android/app/src/debug/AndroidManifest.xml"),
        "utf8",
      );
      expect(debugManifest).toContain(plugin.constants.DEBUG_RECEIVER_ACTION);
      expect(debugManifest).toContain(
        'android:networkSecurityConfig="@xml/nautilo_local_dev_network_security_config"',
      );
      const mainOutput = await readFile(mainManifest, "utf8");
      expect(mainOutput).toBe(sentinel);
      expect(mainOutput).not.toContain(plugin.constants.DEBUG_RECEIVER_ACTION);
      expect(mainOutput).not.toContain("nautilo_local_dev_network_security_config");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
