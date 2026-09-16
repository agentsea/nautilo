import { describe, expect, test } from "bun:test";
import {
  parseDeepLink,
  parseDeepLinksFromArgv,
} from "../../../electron/auth/deep-link-parse";

describe("parseDeepLink", () => {
  test("parses invite with token", () => {
    expect(parseDeepLink("nautilo://invite/inv_abc123")).toEqual({
      kind: "invite",
      payload: { token: "inv_abc123" },
    });
  });

  test("returns null for missing token", () => {
    expect(parseDeepLink("nautilo://invite/")).toBeNull();
  });

  test("returns null for token with spaces", () => {
    expect(parseDeepLink("nautilo://invite/has spaces")).toBeNull();
  });

  test("returns null for token with invalid characters", () => {
    expect(parseDeepLink("nautilo://invite/with$bad$char")).toBeNull();
  });

  test("returns null for wrong scheme", () => {
    expect(parseDeepLink("https://nautilo.dev/invite/x")).toBeNull();
  });

  test("parses reset-password with token", () => {
    expect(parseDeepLink("nautilo://reset-password/rst_xyz")).toEqual({
      kind: "reset-password",
      payload: { token: "rst_xyz" },
    });
  });

  test("parses account with empty payload", () => {
    expect(parseDeepLink("nautilo://account")).toEqual({
      kind: "account",
      payload: {},
    });
  });

  test("returns null for unknown host", () => {
    expect(parseDeepLink("nautilo://unknown/whatever")).toBeNull();
  });

  test("returns null for non-URL input", () => {
    expect(parseDeepLink("not-a-url")).toBeNull();
  });
});

describe("parseDeepLinksFromArgv", () => {
  test("extracts nautilo URLs from argv", () => {
    expect(
      parseDeepLinksFromArgv(["/path/to/app", "--flag", "nautilo://invite/abc"]),
    ).toEqual([{ kind: "invite", payload: { token: "abc" } }]);
  });

  test("returns empty array when argv has no nautilo URLs", () => {
    expect(parseDeepLinksFromArgv(["/path/to/app", "--flag"])).toEqual([]);
  });
});
