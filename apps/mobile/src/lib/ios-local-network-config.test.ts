import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";

import appConfig from "../../app.json";

const pluginPath = path.resolve(import.meta.dir, "../../plugins/with-nautilo-ios-local-network.js");
const requireFromThisFile = createRequire(import.meta.url);
const plugin = requireFromThisFile(pluginPath) as {
  stripExpoDevelopmentBonjourService(infoPlist: Record<string, unknown>): Record<string, unknown>;
};

describe("iOS local-network release configuration", () => {
  test("declares the truthful narrow local-network exception", () => {
    const infoPlist = appConfig.expo.ios.infoPlist;

    expect(infoPlist.NSLocalNetworkUsageDescription).toBe(
      "Nautilo connects to servers you add on your local network.",
    );
    expect(infoPlist.NSAppTransportSecurity).toEqual({
      NSAllowsLocalNetworking: true,
    });
  });

  test("does not broaden transport policy or claim Bonjour discovery", () => {
    const infoPlist = appConfig.expo.ios.infoPlist as Record<string, unknown>;
    const transport = infoPlist.NSAppTransportSecurity as Record<string, unknown>;

    expect(transport).not.toHaveProperty("NSAllowsArbitraryLoads");
    expect(transport).not.toHaveProperty("NSAllowsArbitraryLoadsInWebContent");
    expect(transport).not.toHaveProperty("NSExceptionDomains");
    expect(infoPlist).not.toHaveProperty("NSBonjourServices");
  });

  test("strips Expo's development discovery service from generated native configuration", () => {
    const infoPlist: Record<string, unknown> = {
      NSBonjourServices: ["_expo._tcp", "_nautilo-admin._tcp."],
    };

    expect(plugin.stripExpoDevelopmentBonjourService(infoPlist)).toEqual({
      NSBonjourServices: ["_nautilo-admin._tcp."],
    });
    expect(appConfig.expo.plugins).toContain("./plugins/with-nautilo-ios-local-network");
  });

  test("removes the Bonjour key when Expo's development service is the only entry", () => {
    const infoPlist: Record<string, unknown> = { NSBonjourServices: ["_expo._tcp."] };

    expect(plugin.stripExpoDevelopmentBonjourService(infoPlist)).not.toHaveProperty(
      "NSBonjourServices",
    );
  });
});
