/* eslint-disable @typescript-eslint/await-thenable -- Bun `.rejects` */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStorageZones,
  toRelayStorageZones,
} from "../../src/create-storage-zones";
import { ensureDirectoryTree } from "../../src/ensure-directory-tree";
import { resolveNautiloRuntimePaths } from "../../src/runtime-paths";
import { fromRuntimeConfig } from "../../src/config";
import {
  StoragePathTraversalError,
} from "../../src/storage-provider";

function makeRoot(): string {
  const path = join(
    tmpdir(),
    `zones-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(path, { recursive: true });
  return path;
}

describe("createStorageZones", () => {
  let root: string;

  beforeEach(async () => {
    root = makeRoot();
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: root,
    });
    await ensureDirectoryTree(paths);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns exactly four zones (no inbox)", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: root,
    });
    const zones = createStorageZones(paths);

    const keys = Object.keys(zones).sort();
    expect(keys).toEqual(["data", "home", "scratch", "vault"]);
  });

  test("each provider is rooted at its canonical zone path", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: root,
    });
    const zones = createStorageZones(paths);

    expect(zones.home.rootPath).toBe(realpathSync(paths.homeRootDir));
    expect(zones.scratch.rootPath).toBe(realpathSync(paths.scratchDir));
    expect(zones.data.rootPath).toBe(realpathSync(paths.dataDir));
    expect(zones.vault.rootPath).toBe(realpathSync(paths.vaultDir));
  });

  test("zones are isolated: home provider cannot reach scratch files", async () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: root,
    });
    const zones = createStorageZones(paths);

    // Put a file in scratch via the scratch provider.
    await zones.scratch.write("leaked.txt", "secret");

    // home provider can't traverse to it.
    await expect(
      zones.home.readText("../scratch/leaked.txt"),
    ).rejects.toBeInstanceOf(StoragePathTraversalError);
  });

  test("toRelayStorageZones drops data + vault", () => {
    const paths = resolveNautiloRuntimePaths({
      config: fromRuntimeConfig({}),
      env: {},
      userHomeDir: root,
    });
    const zones = createStorageZones(paths);
    const relayZones = toRelayStorageZones(zones);

    expect(Object.keys(relayZones).sort()).toEqual(["home", "scratch"]);
    expect(relayZones.home).toBe(zones.home);
    expect(relayZones.scratch).toBe(zones.scratch);
  });
});
