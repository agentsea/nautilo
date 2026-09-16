import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { backfillOwnedPhotoLibraryForAppBoot, materializeServerProfileForAppBoot } from "../../src/app";

describe("server-profile boot materialization option", () => {
  test("defaults false and performs no persistence work", async () => {
    let calls = 0;
    await materializeServerProfileForAppBoot(undefined, () => {
      calls++;
      return Promise.resolve();
    });
    expect(calls).toBe(0);
  });

  test("true executes the materialization exactly once", async () => {
    let calls = 0;
    await materializeServerProfileForAppBoot(true, () => {
      calls++;
      return Promise.resolve();
    });
    expect(calls).toBe(1);
  });

  test("enabled materialization failures reject app boot", async () => {
    const failure = new Error("unexpected materialization failure");
    expect(
      materializeServerProfileForAppBoot(true, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });

  test("createApp uses the explicit option and binary passes !TEST_MODE_ONLY", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const [appSource, binarySource] = await Promise.all([
      Bun.file(join(repoRoot, "packages/server/src/app.ts")).text(),
      Bun.file(join(repoRoot, "bin/nautilo-server/src/index.ts")).text(),
    ]);

    const productionAppStart = appSource.indexOf("export async function createApp(");
    expect(productionAppStart).toBeGreaterThanOrEqual(0);
    const productionAppSource = appSource.slice(productionAppStart);
    expect(productionAppSource).toContain("options?.materializeServerProfileAtBoot");
    expect(productionAppSource).not.toContain(
      'process.env["NAUTILO_TEST_MODE_ONLY"]',
    );
    expect(binarySource).toContain(
      "materializeServerProfileAtBoot: !TEST_MODE_ONLY",
    );
  });
});

describe("owned-photo-library boot backfill option", () => {
  test("defaults false and runs exactly once only when enabled", async () => {
    let calls = 0;
    const backfill = () => { calls += 1; return Promise.resolve(); };
    await backfillOwnedPhotoLibraryForAppBoot(undefined, backfill);
    expect(calls).toBe(0);
    await backfillOwnedPhotoLibraryForAppBoot(true, backfill);
    expect(calls).toBe(1);
  });

  test("real binary enables backfill while reusable createApp stays explicit", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const [appSource, binarySource] = await Promise.all([
      Bun.file(join(repoRoot, "packages/server/src/app.ts")).text(),
      Bun.file(join(repoRoot, "bin/nautilo-server/src/index.ts")).text(),
    ]);
    expect(appSource).toContain("options?.backfillOwnedPhotoLibraryAtBoot");
    expect(binarySource).toContain("backfillOwnedPhotoLibraryAtBoot: !TEST_MODE_ONLY");
  });
});
