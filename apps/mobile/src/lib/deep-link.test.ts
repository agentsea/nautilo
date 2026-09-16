import { describe, expect, test } from "bun:test";

const { parseDeepLink } = await import("./deep-link");
const challengeId = "445e9ba2-b7f9-4771-8ebc-ebdd41918a7b";
const context = "ab".repeat(32);

describe("mobile deep links", () => {
  test("parses a complete remote pairing link without inventing a server", () => {
    expect(
      parseDeepLink(
        `nautilo://remote/pair?challengeId=${challengeId}&secret=one-time-secret&ceremonyContext=${context}`,
      ),
    ).toEqual({
      kind: "remote-pair",
      challengeId,
      secret: "one-time-secret",
      ceremonyContext: context,
    });
  });

  test("rejects incomplete or malformed remote pairing links", () => {
    for (const value of [
      `nautilo://remote/pair?challengeId=${challengeId}&ceremonyContext=${context}`,
      `nautilo://remote/pair?challengeId=wrong&secret=x&ceremonyContext=${context}`,
      `nautilo://remote/pair?challengeId=${challengeId}&secret=x&ceremonyContext=wrong`,
    ]) {
      expect(parseDeepLink(value).kind).toBe("unknown");
    }
  });

  test("preserves existing add-server and callback routing", () => {
    expect(parseDeepLink("nautilo://add-server/example.com")).toEqual({
      kind: "add-server",
      url: "https://example.com",
    });
    expect(parseDeepLink("nautilo://callback")).toEqual({
      kind: "callback",
    });
  });
});

describe("server-qualified invite locators", () => {
  test("parses server-minted HTTPS and custom app locators", () => {
    expect(parseDeepLink("https://alpha.example.test/redeem/inv_abc-123_DEF")).toEqual({
      kind: "invite", serverUrl: "https://alpha.example.test", token: "inv_abc-123_DEF",
    });
    expect(parseDeepLink("nautilo://invite?server=https%3A%2F%2Falpha.example.test&token=inv_abc123")).toEqual({
      kind: "invite", serverUrl: "https://alpha.example.test", token: "inv_abc123",
    });
  });

  test("rejects token-only and malformed locators without retaining tokens", () => {
    expect(parseDeepLink("nautilo://invite/inv_secret")).toEqual({ kind: "invalid-invite", reason: "missing-server" });
    expect(parseDeepLink("nautilo://invite?server=https%3A%2F%2Falpha.example.test&token=not-an-invite")).toEqual({ kind: "invalid-invite", reason: "invalid-token" });
  });
});
