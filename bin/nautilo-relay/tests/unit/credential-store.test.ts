import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KeyringRelayCredentialStore,
  RelayCredentialStorageError,
  relayCredentialScope,
  relayPairingMetadataPath,
  type RelayKeyringEntry,
} from "../../src/credential-store";

class MemoryKeyringEntry implements RelayKeyringEntry {
  value: string | null = null;

  async getPassword(): Promise<string | null> {
    return this.value;
  }

  async setPassword(password: string): Promise<void> {
    this.value = password;
  }

  async deleteCredential(): Promise<boolean> {
    const existed = this.value !== null;
    this.value = null;
    return existed;
  }
}

const roots: string[] = [];
function subject(serverUrl = "https://example.test/") {
  const root = mkdtempSync(join(tmpdir(), "nautilo-relay-credential-"));
  roots.push(root);
  const entry = new MemoryKeyringEntry();
  const dataDir = join(root, ".nautilo");
  return {
    dataDir,
    entry,
    store: new KeyringRelayCredentialStore({ serverUrl, dataDir, entry }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Relay credential storage", () => {
  test("persists stable non-secret pairing metadata with owner-only permissions", async () => {
    const { dataDir, store } = subject();
    const first = await store.getOrCreatePairingIdentity();
    const second = await store.getOrCreatePairingIdentity();

    expect(second).toEqual(first);
    expect(first.serverUrl).toBe("https://example.test");
    expect(statSync(join(dataDir, "relay")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "relay", "pairings")).mode & 0o777).toBe(0o700);
    expect(statSync(relayPairingMetadataPath(dataDir, store.serverUrl)).mode & 0o777).toBe(0o600);
  });

  test("keeps the token and authenticated user together in the OS keyring envelope", async () => {
    const { entry, store } = subject();
    const identity = await store.getOrCreatePairingIdentity();
    await store.save({
      ...identity,
      userId: "22222222-2222-4222-8222-222222222222",
      relayToken: `rty_${"a".repeat(32)}`,
    });

    expect(await store.load()).toEqual({
      ...identity,
      userId: "22222222-2222-4222-8222-222222222222",
      relayToken: `rty_${"a".repeat(32)}`,
    });
    expect(entry.value).toContain("22222222-2222-4222-8222-222222222222");
    expect(entry.value).toContain("rty_");

    await store.clear();
    expect(await store.load()).toBeNull();
    expect(await store.getOrCreatePairingIdentity()).toEqual(identity);
  });

  test("scopes credentials by normalized server and rejects cross-target envelopes", async () => {
    expect(relayCredentialScope("https://one.test/")).toBe(relayCredentialScope("https://one.test"));
    expect(relayCredentialScope("https://one.test")).not.toBe(relayCredentialScope("https://two.test"));

    const { entry, store } = subject("https://one.test");
    const identity = await store.getOrCreatePairingIdentity();
    entry.value = JSON.stringify({
      formatVersion: 1,
      serverScope: relayCredentialScope("https://two.test"),
      installationId: identity.installationId,
      userId: "22222222-2222-4222-8222-222222222222",
      relayToken: `rty_${"b".repeat(32)}`,
    });
    const failure = await store.load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayCredentialStorageError);
  });

  test("fails closed when pairing metadata becomes group-readable", async () => {
    const { dataDir, store } = subject();
    await store.getOrCreatePairingIdentity();
    chmodSync(relayPairingMetadataPath(dataDir, store.serverUrl), 0o640);
    const failure = await store.load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayCredentialStorageError);
    expect((failure as Error).message).toContain("unsafe");
  });

  test("rejects a pairing-directory symlink without changing its target mode", async () => {
    const { dataDir, store } = subject();
    const target = join(dataDir, "unrelated");
    mkdirSync(target, { recursive: true, mode: 0o755 });
    symlinkSync(target, join(dataDir, "relay"));

    const failure = await store.getOrCreatePairingIdentity().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayCredentialStorageError);
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});
