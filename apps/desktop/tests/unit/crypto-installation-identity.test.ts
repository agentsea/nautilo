import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateFreshDesktopCryptoInstallationId,
  readOrCreateDesktopCryptoInstallationId,
} from "../../electron/crypto-installation-identity";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop crypto installation identity", () => {
  test("recovery rotates one account without changing relay or sibling identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "nautilo-crypto-identity-"));
    directories.push(directory);
    const fallbackInstallationId = "11111111-1111-4111-8111-111111111111";
    const alice = {
      serverScope: "https://one.example",
      userId: "22222222-2222-4222-8222-222222222222",
      humanActorId: "33333333-3333-4333-8333-333333333333",
    };
    const bob = {
      ...alice,
      userId: "44444444-4444-4444-8444-444444444444",
      humanActorId: "55555555-5555-4555-8555-555555555555",
    };
    expect(readOrCreateDesktopCryptoInstallationId({
      directory,
      account: alice,
      fallbackInstallationId,
    })).toBe(fallbackInstallationId);
    expect(readOrCreateDesktopCryptoInstallationId({
      directory,
      account: bob,
      fallbackInstallationId,
    })).toBe(fallbackInstallationId);

    const replacement = "66666666-6666-4666-8666-666666666666";
    activateFreshDesktopCryptoInstallationId({
      directory,
      account: alice,
      installationId: replacement,
    });

    expect(readOrCreateDesktopCryptoInstallationId({
      directory,
      account: alice,
      fallbackInstallationId,
    })).toBe(replacement);
    expect(readOrCreateDesktopCryptoInstallationId({
      directory,
      account: bob,
      fallbackInstallationId,
    })).toBe(fallbackInstallationId);
  });
});
