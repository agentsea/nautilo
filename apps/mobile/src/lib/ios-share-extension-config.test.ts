import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import appConfig from "../../app.json";

const pluginPath = path.resolve(
  import.meta.dir,
  "../../plugins/with-nautilo-share-extension.js",
);
// Config plugins run in Node during CNG, so exercise their stable public
// constants separately from React Native's runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharePlugin = require(pluginPath) as {
  shareExtensionConfig(bundleIdentifier: string, marketingVersion: string): {
    appGroup: string;
    bundleIdentifier: string;
    marketingVersion: string;
    targetName: string;
  };
  constants: {
    APPLE_DEVELOPMENT_TEAM: string;
    MAX_TEXT_OR_URL_BYTES: number;
    MAX_INBOUND_FILE_BYTES: number;
    FILE_PAYLOAD_KEY: string;
    PAYLOAD_KEY: string;
    TARGET_NAME: string;
  };
};

describe("iOS Share Extension CNG contract", () => {
  test("declares the local config plugin on the production app identity", () => {
    expect(appConfig.expo.plugins).toContain("./plugins/with-nautilo-share-extension");
    expect(appConfig.expo.ios.bundleIdentifier).toBe("ai.nautilo.app");
    expect(appConfig.expo.extra.eas.build.experimental.ios.appExtensions).toEqual([
      {
        targetName: "NautiloShare",
        bundleIdentifier: "ai.nautilo.app.share",
        entitlements: {
          "com.apple.security.application-groups": ["group.ai.nautilo.app.share"],
        },
      },
    ]);
  });

  test("derives one exact extension identity and App Group", () => {
    expect(sharePlugin.shareExtensionConfig("ai.nautilo.app", "0.1.0")).toEqual({
      appGroup: "group.ai.nautilo.app.share",
      bundleIdentifier: "ai.nautilo.app.share",
      marketingVersion: "0.1.0",
      targetName: "NautiloShare",
    });
    expect(sharePlugin.constants.APPLE_DEVELOPMENT_TEAM).toBe("UWBR65VS6Z");
  });

  test("keeps the extension bounded and free of auth/network implementation", () => {
    const source = readFileSync(pluginPath, "utf8");
    expect(sharePlugin.constants.MAX_TEXT_OR_URL_BYTES).toBe(1024);
    expect(sharePlugin.constants.MAX_INBOUND_FILE_BYTES).toBe(100 * 1024 * 1024);
    expect(sharePlugin.constants.FILE_PAYLOAD_KEY).toBe("ai.nautilo.share.pending-file-v1");
    expect(sharePlugin.constants.PAYLOAD_KEY).toBe("ai.nautilo.share.pending-v1");
    expect(source).toContain("NSExtensionActivationSupportsText");
    expect(source).toContain("NSExtensionActivationSupportsWebURLWithMaxCount");
    expect(source).toContain("NSExtensionActivationSupportsImageWithMaxCount");
    expect(source).toContain("NSExtensionActivationSupportsFileWithMaxCount");
    expect(source).toContain("<key>NSExtensionActivationRule</key>");
    expect(source).toContain("CFBundleVersion");
    expect(source).toContain("GENERATE_INFOPLIST_FILE = \"NO\"");
    expect(source).toContain(
      "buildConfiguration.buildSettings.DEVELOPMENT_TEAM = APPLE_DEVELOPMENT_TEAM",
    );
    expect(source).toContain("UserDefaults(suiteName: NautiloShareStaging.appGroup)");
    expect(source).toContain("item as? String");
    expect(source).toContain("URL(string: value)");
    expect(source).toContain("loadFileRepresentation");
    expect(source).toContain("loadInPlaceFileRepresentation");
    expect(source).toContain("startAccessingSecurityScopedResource");
    expect(source).toContain("stopAccessingSecurityScopedResource");
    expect(source).toContain("copyBounded");
    expect(source).toContain("copied <= NautiloShareStaging.maxInboundFileBytes");
    expect(source).toContain("FileProtectionType.completeUntilFirstUserAuthentication");
    expect(source).toContain('defaults?.object(forKey: NautiloShareStaging.filePayloadKey) != nil');
    expect(source).toContain("guard candidate, let defaults, !pending, let container");
    expect(source).toContain('"nativeReceiptId": nativeReceiptId');
    expect(source).not.toContain('"uri":');
    expect(source).not.toContain('"path":');
    expect(source.indexOf("providers.compactMap")).toBeLessThan(
      source.indexOf("hasItemConformingToTypeIdentifier(UTType.url.identifier)"),
    );
    expect(source).toContain("!url.isFileURL");
    expect(source.indexOf("hasItemConformingToTypeIdentifier(UTType.url.identifier)")).toBeLessThan(
      source.indexOf("contentText?.trimmingCharacters"),
    );
    expect(source).not.toContain("URLSession");
    expect(source).not.toContain("Authorization");
    expect(source).not.toContain("SecureStore");
  });
});
