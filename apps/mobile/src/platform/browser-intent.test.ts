import { describe, expect, test } from "bun:test";

import { parseBrowserMobileIntent } from "./browser-intent.web";

describe("Mobile Web URL intake", () => {
  test("accepts only same-origin routes in the explicit /mobile namespace", () => {
    expect(parseBrowserMobileIntent(
      "https://nautilo.example/mobile/chat/room-1?messageId=42",
      "https://nautilo.example",
    )).toEqual({ kind: "route", pathname: "/chat/room-1", search: "?messageId=42" });
    expect(parseBrowserMobileIntent(
      "https://other.example/mobile/chat/room-1",
      "https://nautilo.example",
    )).toEqual({ kind: "rejected", reason: "cross-origin" });
    expect(parseBrowserMobileIntent(
      "https://nautilo.example/chat/room-1",
      "https://nautilo.example",
    )).toEqual({ kind: "rejected", reason: "outside-mobile" });
  });

  test("rejects native schemes and secret-bearing push/share/device payloads", () => {
    expect(parseBrowserMobileIntent("nautilo://add-server?url=https://a.example", "https://nautilo.example"))
      .toEqual({ kind: "rejected", reason: "native" });
    expect(parseBrowserMobileIntent("https://nautilo.example/mobile?push=receipt", "https://nautilo.example"))
      .toEqual({ kind: "rejected", reason: "secret-bearing" });
    expect(parseBrowserMobileIntent("https://nautilo.example/mobile/share?token=secret", "https://nautilo.example"))
      .toEqual({ kind: "rejected", reason: "secret-bearing" });
    expect(parseBrowserMobileIntent("https://nautilo.example/mobile#device-proof", "https://nautilo.example"))
      .toEqual({ kind: "rejected", reason: "secret-bearing" });
    expect(parseBrowserMobileIntent("https://user:pass@nautilo.example/mobile", "https://nautilo.example"))
      .toEqual({ kind: "rejected", reason: "cross-origin" });
    expect(parseBrowserMobileIntent("https://nautilo.example/mobile?password=secret", "https://nautilo.example"))
      .toEqual({ kind: "rejected", reason: "secret-bearing" });
  });

  test("classifies the exact callback for Task 1.3 without consuming it", () => {
    expect(parseBrowserMobileIntent(
      "https://nautilo.example/mobile/callback",
      "https://nautilo.example",
    )).toEqual({ kind: "callback" });
  });
});
