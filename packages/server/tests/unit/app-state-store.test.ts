import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDisabledAppIds,
  isAppDisabled,
  setAppDisabled,
} from "../../src/apps/app-state-store";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("app-state-store", () => {
  test("missing state file yields an empty disabled set", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-empty-");
    const disabled = await getDisabledAppIds(appsRoot);
    expect(disabled.size).toBe(0);
    expect(await isAppDisabled(appsRoot, "excel")).toBe(false);
  });

  test("unparseable state file is treated as empty (no throw)", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-corrupt-");
    await writeFile(join(appsRoot, ".app-state.json"), "{ not valid json");
    const disabled = await getDisabledAppIds(appsRoot);
    expect(disabled.size).toBe(0);
  });

  test("non-object state JSON is treated as empty", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-array-");
    await writeFile(join(appsRoot, ".app-state.json"), JSON.stringify(["excel"]));
    const disabled = await getDisabledAppIds(appsRoot);
    expect(disabled.size).toBe(0);
  });

  test("round-trip disable then enable", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-roundtrip-");

    await setAppDisabled(appsRoot, "excel", true);
    expect(await isAppDisabled(appsRoot, "excel")).toBe(true);
    let disabled = await getDisabledAppIds(appsRoot);
    expect([...disabled]).toEqual(["excel"]);

    const raw = await readFile(join(appsRoot, ".app-state.json"), "utf8");
    const parsed = JSON.parse(raw) as { disabled: string[] };
    expect(parsed.disabled).toEqual(["excel"]);
    expect(raw.endsWith("\n")).toBe(true);

    await setAppDisabled(appsRoot, "excel", false);
    expect(await isAppDisabled(appsRoot, "excel")).toBe(false);
    disabled = await getDisabledAppIds(appsRoot);
    expect(disabled.size).toBe(0);
  });

  test("disable is idempotent; enable is idempotent", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-idempotent-");

    await setAppDisabled(appsRoot, "excel", true);
    await setAppDisabled(appsRoot, "excel", true);
    expect([...(await getDisabledAppIds(appsRoot))]).toEqual(["excel"]);

    await setAppDisabled(appsRoot, "excel", false);
    await setAppDisabled(appsRoot, "excel", false);
    expect([...(await getDisabledAppIds(appsRoot))]).toEqual([]);
  });

  test("disable persists multiple distinct ids and removes only the targeted one", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-multi-");
    await setAppDisabled(appsRoot, "excel", true);
    await setAppDisabled(appsRoot, "nautilo-writer", true);
    expect([...(await getDisabledAppIds(appsRoot)).values()].sort()).toEqual([
      "excel",
      "nautilo-writer",
    ]);

    await setAppDisabled(appsRoot, "excel", false);
    expect([...(await getDisabledAppIds(appsRoot))]).toEqual(["nautilo-writer"]);
  });

  test("invalid appId is rejected by setAppDisabled", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-invalid-");
    const expectRejects = async (appId: string): Promise<void> => {
      let threw = false;
      try {
        await setAppDisabled(appsRoot, appId, true);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    };
    await expectRejects("BAD ID!");
    await expectRejects("");
    // No state file should have been written.
    let exists = true;
    try {
      await readFile(join(appsRoot, ".app-state.json"), "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  test("unsafe ids in the state file are filtered on read", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-filter-");
    await mkdir(appsRoot, { recursive: true });
    await writeFile(
      join(appsRoot, ".app-state.json"),
      `${JSON.stringify({
        disabled: ["excel", "BAD ID", "also-bad!", "  ", "excel"],
      })}\n`,
    );
    const disabled = await getDisabledAppIds(appsRoot);
    expect([...disabled]).toEqual(["excel"]);
  });

  test("disabled value is not an array -> treated as empty", async () => {
    const appsRoot = await makeTempDir("nautilo-app-state-notarr-");
    await writeFile(
      join(appsRoot, ".app-state.json"),
      `${JSON.stringify({ disabled: "excel" })}\n`,
    );
    expect([...(await getDisabledAppIds(appsRoot))]).toEqual([]);
  });

  test("setAppDisabled creates appsRoot if missing", async () => {
    const parent = await makeTempDir("nautilo-app-state-mkdir-");
    const appsRoot = join(parent, "nested", "apps");
    await setAppDisabled(appsRoot, "excel", true);
    const raw = await readFile(join(appsRoot, ".app-state.json"), "utf8");
    expect((JSON.parse(raw) as { disabled: string[] }).disabled).toEqual(["excel"]);
  });
});
