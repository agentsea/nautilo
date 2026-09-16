import { describe, expect, test } from "bun:test";

import {
  isLocalNetworkServerUrl,
  shouldOfferIosLocalNetworkRecovery,
} from "./ios-local-network-recovery";

describe("iOS local-network recovery", () => {
  test("recognizes user-entered local server addresses without changing URL policy", () => {
    for (const url of [
      "localhost:3001",
      "127.0.0.1:3001",
      "10.0.0.8:3001",
      "172.16.4.8:3001",
      "192.168.1.8:3001",
      "169.254.10.2:3001",
      "[fd00::1]:3001",
      "[fe80::1]:3001",
      "https://my-nas.local:3001",
      "https://homeserver:3001",
    ]) {
      expect(isLocalNetworkServerUrl(url)).toBe(true);
    }

    for (const url of [
      "https://nautilo.ai",
      "https://alpha.example.test",
      "https://8.8.8.8",
      "not a url",
    ]) {
      expect(isLocalNetworkServerUrl(url)).toBe(false);
    }
  });

  test("offers Settings recovery only for iOS local transport failures", () => {
    expect(shouldOfferIosLocalNetworkRecovery({
      platform: "ios",
      serverUrl: "http://192.168.1.8:3001",
      error: "Server unreachable: Network request failed",
    })).toBe(true);
    expect(shouldOfferIosLocalNetworkRecovery({
      platform: "ios",
      serverUrl: "https://my-nas.local",
      error: "Couldn’t reach that server. Check your connection and the URL, then try again.",
    })).toBe(true);

    for (const input of [
      { platform: "android" as const, serverUrl: "http://192.168.1.8", error: "Network request failed" },
      { platform: "web" as const, serverUrl: "http://192.168.1.8", error: "Network request failed" },
      { platform: "ios" as const, serverUrl: "https://nautilo.ai", error: "Network request failed" },
      { platform: "ios" as const, serverUrl: "http://192.168.1.8", error: "Not a Nautilo server" },
      { platform: "ios" as const, serverUrl: "http://192.168.1.8", error: null },
    ]) {
      expect(shouldOfferIosLocalNetworkRecovery(input)).toBe(false);
    }
  });
});
