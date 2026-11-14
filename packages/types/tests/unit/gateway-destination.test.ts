import { describe, expect, test } from "bun:test";
import { gatewayKeyDestination, normalizeGatewayBaseUrl } from "../../src/gateway-destination";

describe("gateway destination", () => {
  test("normalizes a trimmed http(s) base URL without trailing slashes", () => {
    expect(normalizeGatewayBaseUrl("  https://gateway.example.test/v1//  ")).toBe("https://gateway.example.test/v1");
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:8888/v1")).toBe("http://127.0.0.1:8888/v1");
    for (const value of [undefined, null, 42, "", "   ", "not a url", "file:///tmp/gateway", "ftp://gateway.example.test"]) {
      expect(normalizeGatewayBaseUrl(value)).toBeUndefined();
    }
  });

  test("a key destination is the normalized base and refuses credentials, query, and fragment", () => {
    expect(gatewayKeyDestination("https://gateway.example.test/v1/")).toBe("https://gateway.example.test/v1");
    for (const value of [
      undefined,
      "file:///tmp/gateway",
      "https://user:pass@gateway.example.test/v1",
      "https://user@gateway.example.test/v1",
      "https://gateway.example.test/v1?token=x",
      "https://gateway.example.test/v1#frag",
    ]) {
      expect(gatewayKeyDestination(value)).toBeNull();
    }
  });
});
