import { describe, expect, test } from "bun:test";
import { shouldTrustExplicitDevLoopbackServer } from "../../electron/dev-loopback-trust";

describe("dev-stack explicit loopback trust", () => {
  test("trusts only the exact explicit loopback origin in an unpackaged build", () => {
    expect(shouldTrustExplicitDevLoopbackServer({
      isPackaged: false,
      explicitServerUrl: "http://127.0.0.1:5401",
      resolvedServerUrl: "http://127.0.0.1:5401/",
    })).toBe(true);

    for (const input of [
      {
        isPackaged: true,
        explicitServerUrl: "http://127.0.0.1:5401",
        resolvedServerUrl: "http://127.0.0.1:5401",
      },
      {
        isPackaged: false,
        explicitServerUrl: undefined,
        resolvedServerUrl: "http://127.0.0.1:5401",
      },
      {
        isPackaged: false,
        explicitServerUrl: "https://alpha.example.test",
        resolvedServerUrl: "https://alpha.example.test",
      },
      {
        isPackaged: false,
        explicitServerUrl: "http://127.0.0.1:5401",
        resolvedServerUrl: "http://127.0.0.1:5402",
      },
    ]) {
      expect(shouldTrustExplicitDevLoopbackServer(input)).toBe(false);
    }
  });
});
