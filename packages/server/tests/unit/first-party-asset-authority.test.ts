import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAppSourceHash } from "../../src/apps/app-registry";
import { hasFirstPartyAssetAuthority } from "../../src/apps/first-party-asset-authority";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ canonical: string; installed: string; hash: string }> {
  const root = await mkdtemp(join(tmpdir(), "nautilo-first-party-asset-"));
  roots.push(root);
  const canonical = join(root, "canonical");
  const installed = join(root, "installed");
  await mkdir(canonical);
  await writeFile(join(canonical, "app.json"), '{"id":"nautilo-design"}\n');
  await writeFile(join(canonical, "main.ts"), "export const design = true;\n");
  await cp(canonical, installed, { recursive: true });
  return { canonical, installed, hash: await computeAppSourceHash(canonical) };
}

async function slidesFixture(): Promise<{ canonical: string; installed: string; hash: string }> {
  const value = await fixture();
  await writeFile(join(value.canonical, "app.json"), '{"id":"nautilo-presentation"}\n');
  await writeFile(join(value.installed, "app.json"), '{"id":"nautilo-presentation"}\n');
  const hash = await computeAppSourceHash(value.canonical);
  return { ...value, hash };
}

describe("first-party raster asset authority", () => {
  test("grants the exact canonical Slides source used by the worker", async () => {
    const value = await slidesFixture();
    expect(await hasFirstPartyAssetAuthority({
      appId: "nautilo-presentation", appRoot: value.installed, sourceHash: value.hash,
    }, { canonicalAppRoot: value.canonical })).toBe(true);
  });
  test("grants only the exact canonical Design source used by the worker", async () => {
    const value = await fixture();
    expect(await hasFirstPartyAssetAuthority({
      appId: "nautilo-design",
      appRoot: value.installed,
      sourceHash: value.hash,
    }, { canonicalDesignRoot: value.canonical })).toBe(true);

    await writeFile(join(value.installed, "main.ts"), "export const design = false;\n");
    expect(await hasFirstPartyAssetAuthority({
      appId: "nautilo-design",
      appRoot: value.installed,
      sourceHash: value.hash,
    }, { canonicalDesignRoot: value.canonical })).toBe(false);
  });

  test("fails closed for a copied app id, stale build hash, or unavailable source", async () => {
    const value = await fixture();
    expect(await hasFirstPartyAssetAuthority({
      appId: "third-party-design",
      appRoot: value.installed,
      sourceHash: value.hash,
    }, { canonicalDesignRoot: value.canonical })).toBe(false);
    expect(await hasFirstPartyAssetAuthority({
      appId: "nautilo-design",
      appRoot: value.installed,
      sourceHash: "0".repeat(64),
    }, { canonicalDesignRoot: value.canonical })).toBe(false);
    expect(await hasFirstPartyAssetAuthority({
      appId: "nautilo-design",
      appRoot: join(value.installed, "missing"),
      sourceHash: value.hash,
    }, { canonicalDesignRoot: value.canonical })).toBe(false);
  });
});


test("Board assets require exact canonical source and refuse a modified installed copy", async () => {
  const value = await fixture();
  for (const dir of [value.canonical, value.installed]) await writeFile(join(dir, "app.json"), '{"id":"nautilo-board"}');
  const sourceHash = await computeAppSourceHash(value.canonical);
  const identity = { appId: "nautilo-board", appRoot: value.installed, sourceHash };
  expect(await hasFirstPartyAssetAuthority(identity, { canonicalAppRoot: value.canonical })).toBe(true);
  await writeFile(join(value.installed, "main.ts"), "export const changed = true;");
  expect(await hasFirstPartyAssetAuthority(identity, { canonicalAppRoot: value.canonical })).toBe(false);
});
