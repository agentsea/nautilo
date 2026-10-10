import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBunRuntimeCached, recordBunRuntimeCache } from "../../scripts/bun-vendor-cache";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Bun vendor cache identity", () => {
  test("Windows refresh cannot mark older Darwin binaries current", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-bun-cache-"));
    roots.push(root);
    const mac = join(root, "x64", "bun");
    const win = join(root, "x64", "bun.exe");
    mkdirSync(join(root, "x64"));
    writeFileSync(mac, "old-mac-runtime");
    recordBunRuntimeCache(mac, "old");
    writeFileSync(win, "new-win-runtime");
    recordBunRuntimeCache(win, "new");
    expect(isBunRuntimeCached(win, "new")).toBe(true);
    expect(isBunRuntimeCached(mac, "new")).toBe(false);
    expect(isBunRuntimeCached(mac, "old")).toBe(true);
  });
  test("same-size corruption invalidates a cache", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-bun-cache-"));
    roots.push(root);
    const binary = join(root, "bun.exe");
    writeFileSync(binary, "good");
    recordBunRuntimeCache(binary, "pin");
    writeFileSync(binary, "evil");
    expect(isBunRuntimeCached(binary, "pin")).toBe(false);
  });
});
