import "../bun-dom-preload";
import { afterEach, describe, expect, test } from "bun:test";

import {
  activateFreshBrowserCryptoInstallationId,
  readOrCreateBrowserCryptoInstallationId,
} from
  "../../src/lib/browser-crypto-installation";

afterEach(() => localStorage.clear());

describe("browser crypto installation identity", () => {
  test("persists only one opaque public UUID across reloads", () => {
    const first = readOrCreateBrowserCryptoInstallationId();
    const second = readOrCreateBrowserCryptoInstallationId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).toBe(first);
    expect(localStorage.length).toBe(1);
    expect(JSON.stringify(localStorage)).not.toContain("recovery");
  });

  test("fails closed rather than replacing a corrupt coordinate", () => {
    localStorage.setItem(
      "nautilo.crypto.browser-installation.v1",
      "not-an-installation",
    );
    expect(readOrCreateBrowserCryptoInstallationId()).toBeNull();
    expect(localStorage.getItem("nautilo.crypto.browser-installation.v1"))
      .toBe("not-an-installation");
  });

  test("activates a fresh recovery identity only for the recovered account", () => {
    const alice = {
      serverScope: "https://one.example",
      userId: "11111111-1111-4111-8111-111111111111",
      humanActorId: "22222222-2222-4222-8222-222222222222",
    };
    const bob = {
      ...alice,
      userId: "33333333-3333-4333-8333-333333333333",
      humanActorId: "44444444-4444-4444-8444-444444444444",
    };
    const originalAlice = readOrCreateBrowserCryptoInstallationId(alice);
    const originalBob = readOrCreateBrowserCryptoInstallationId(bob);
    expect(originalAlice).toBe(originalBob);
    const replacement = crypto.randomUUID();
    expect(activateFreshBrowserCryptoInstallationId(replacement, alice))
      .toBe(true);
    expect(readOrCreateBrowserCryptoInstallationId(alice)).toBe(replacement);
    expect(readOrCreateBrowserCryptoInstallationId(bob)).toBe(originalBob);
  });
});
