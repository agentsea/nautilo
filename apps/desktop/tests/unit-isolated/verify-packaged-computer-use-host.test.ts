import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchIsInManagedStorage } from "../../scripts/verify-packaged-computer-use-host.ts";

describe("packaged Computer Use Host verifier", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  test("accepts a canonical managed release reached through an aliased parent path", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-packaged-host-path-")); roots.push(root);
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    const runtimeRoot = join(actual, "runtime");
    const resourceDirectory = join(actual, "bundle");
    const entrypoint = join(runtimeRoot, "releases", `sha256-${"a".repeat(64)}`, "nautilo-computer-use-host");
    await mkdir(join(entrypoint, ".."), { recursive: true });
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(entrypoint, "host");
    await symlink(actual, alias);

    expect(await launchIsInManagedStorage({
      runtimeRoot: join(alias, "runtime"),
      resourceDirectory: join(alias, "bundle"),
      entrypoint,
    })).toBeTrue();
  });

  test("rejects the mutable bundled entrypoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "nautilo-packaged-host-bundle-")); roots.push(root);
    const runtimeRoot = join(root, "runtime");
    const resourceDirectory = join(root, "bundle");
    const entrypoint = join(resourceDirectory, "nautilo-computer-use-host");
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(resourceDirectory, { recursive: true });
    await writeFile(entrypoint, "host");

    expect(await launchIsInManagedStorage({ runtimeRoot, resourceDirectory, entrypoint })).toBeFalse();
  });
});
