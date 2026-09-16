import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  KeyringRailwayOAuthCredentialStore,
  type RailwayOAuthKeyringEntry,
} from "../../src/lib/railway-oauth-credential-store";

class MemoryKeyringEntry implements RailwayOAuthKeyringEntry {
  value: string | null | undefined;

  getPassword(): Promise<string | null | undefined> {
    return Promise.resolve(this.value);
  }

  setPassword(password: string): Promise<void> {
    this.value = password;
    return Promise.resolve();
  }

  deleteCredential(): Promise<boolean> {
    const existed = this.value !== undefined;
    this.value = undefined;
    return Promise.resolve(existed);
  }
}

const directories: string[] = [];

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nautilo-railway-oauth-"));
  directories.push(directory);
  const entry = new MemoryKeyringEntry();
  const lockPath = join(directory, "auth", "railway-oauth.lock");
  return {
    directory,
    entry,
    lockPath,
    store: new KeyringRailwayOAuthCredentialStore(entry, lockPath),
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error("non-error rejection");
  }
  throw new Error("expected promise to reject");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Railway OS credential-store lease", () => {
  test("stores only the refresh envelope in keyring and only an empty owner-only lock on disk", async () => {
    const { entry, lockPath, store } = await fixture();
    const lease = await store.acquireExclusiveRefreshLease();
    expect(lease.credential).toBeNull();
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    expect(lock).toMatchObject({ formatVersion: 1, pid: process.pid });

    expect(await lease.replace({ refreshToken: "rotating-secret", generation: 1 })).toBe("stored");
    expect(entry.value).toBe(JSON.stringify({
      formatVersion: 1,
      generation: 1,
      refreshToken: "rotating-secret",
    }));
    expect(await readFile(lockPath, "utf8")).not.toContain("rotating-secret");
    await lease.release();
  });

  test("treats the macOS binding's observed null sentinel as an absent credential", async () => {
    const { entry, store } = await fixture();
    entry.value = null;
    const lease = await store.acquireExclusiveRefreshLease();
    expect(lease.credential).toBeNull();
    await lease.release();
  });

  test("prevents concurrent processes from acquiring the same refresh slot", async () => {
    const { store } = await fixture();
    const first = await store.acquireExclusiveRefreshLease();
    expect((await rejection(store.acquireExclusiveRefreshLease())).message).not.toBe("");
    await first.release();
    const second = await store.acquireExclusiveRefreshLease();
    await second.release();
  });

  test("reclaims a well-formed lock whose process owner is dead", async () => {
    const { lockPath, store } = await fixture();
    await mkdir(join(lockPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, JSON.stringify({
      formatVersion: 1,
      pid: 2_147_483_647,
      createdAt: Date.now(),
    }), { mode: 0o600 });
    const lease = await store.acquireExclusiveRefreshLease();
    expect(lease.credential).toBeNull();
    await lease.release();
  });

  test("fails stale replacement if the keyring generation changes outside the lease", async () => {
    const { entry, store } = await fixture();
    entry.value = JSON.stringify({
      formatVersion: 1,
      generation: 4,
      refreshToken: "leased-token",
    });
    const lease = await store.acquireExclusiveRefreshLease();
    entry.value = JSON.stringify({
      formatVersion: 1,
      generation: 5,
      refreshToken: "other-writer",
    });
    expect(await lease.replace({ refreshToken: "must-not-win", generation: 5 })).toBe("stale-lease");
    expect(entry.value).not.toContain("must-not-win");
    await lease.release();
  });

  test("rejects corrupt keyring state and unsafe lock directories without exposing values", async () => {
    const { directory, entry, store } = await fixture();
    entry.value = "not-json-secret";
    expect((await rejection(store.acquireExclusiveRefreshLease())).message).toBe(
      "Railway OAuth credential is invalid",
    );

    if (process.platform !== "win32") {
      await chmod(join(directory, "auth"), 0o777);
      expect((await rejection(store.acquireExclusiveRefreshLease())).message).toBe(
        "Railway OAuth lock directory is unsafe",
      );
    }
  });
});
