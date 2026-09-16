import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_MINI_APP_MANIFEST } from "../helpers/test-mini-app-manifest";
import { computeAppSourceHash, scanInstalledApps } from "../../src/apps/app-registry";
import { seedFirstPartyApps } from "../../src/apps/seed-first-party-apps";

let appsRoot = "";

afterEach(async () => {
  if (appsRoot) {
    await rm(appsRoot, { recursive: true, force: true });
    appsRoot = "";
  }
});

async function makeAppsRoot(): Promise<string> {
  appsRoot = await mkdtemp(join(tmpdir(), "nautilo-apps-registry-"));
  return appsRoot;
}

async function writeTestApp(root: string, manifest = TEST_MINI_APP_MANIFEST): Promise<void> {
  const appDir = join(root, "test-canvas");
  await mkdir(appDir, { recursive: true });
  await writeFile(join(appDir, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(appDir, "main.ts"), "export {};\n");
  await writeFile(
    join(appDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
}

describe("app-registry scan", () => {
  test("valid app becomes ready", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const apps = await scanInstalledApps(root);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.status).toBe("ready");
    expect(apps[0]?.id).toBe("test-canvas");
    expect(apps[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(apps[0]?.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("invalid manifest becomes invalid_manifest without crashing scan", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root, { ...TEST_MINI_APP_MANIFEST, id: "BAD" });
    const apps = await scanInstalledApps(root);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.status).toBe("invalid_manifest");
    expect(apps[0]?.manifest).toBeNull();
    expect(apps[0]?.sourceHash).toBeNull();
    expect(apps[0]?.error).toBeTruthy();
  });

  test("node_modules and .cache do not affect source hash", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const before = await computeAppSourceHash(join(root, "test-canvas"));
    await mkdir(join(root, "test-canvas", "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "test-canvas", "node_modules", "pkg", "index.js"), "noise");
    await mkdir(join(root, "test-canvas", ".cache"), { recursive: true });
    await writeFile(join(root, "test-canvas", ".cache", "bundle.js"), "noise");
    const after = await computeAppSourceHash(join(root, "test-canvas"));
    expect(after).toBe(before);
  });

  test("file: shared-core dependency identity is included without hashing all node_modules", async () => {
    const root = await makeAppsRoot();
    const appDir = join(root, "nautilo-writer");
    const coreDir = join(root, "shared-core");
    await mkdir(join(coreDir, "src"), { recursive: true });
    await writeFile(join(coreDir, "package.json"), `${JSON.stringify({ name: "@scope/shared-core", private: true }, null, 2)}\n`);
    await writeFile(join(coreDir, "src", "index.ts"), "export const v = 1;\n");

    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "app.json"), `${JSON.stringify({ id: "nautilo-writer", name: "Writer", version: "0.1.0" }, null, 2)}\n`);
    await writeFile(join(appDir, "main.ts"), "export {};\n");
    await writeFile(
      join(appDir, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: { "@scope/shared-core": "file:../shared-core" },
        },
        null,
        2,
      )}\n`,
    );

    const before = await computeAppSourceHash(appDir);
    await mkdir(join(appDir, "node_modules", "other-pkg"), { recursive: true });
    await writeFile(join(appDir, "node_modules", "other-pkg", "index.js"), "noise");
    const afterNoise = await computeAppSourceHash(appDir);
    expect(afterNoise).toBe(before);

    await writeFile(join(coreDir, "src", "index.ts"), "export const v = 2;\n");
    const afterCoreChange = await computeAppSourceHash(appDir);
    expect(afterCoreChange).not.toBe(before);
  });

  test("source hash changes when a real source file changes", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const appDir = join(root, "test-canvas");
    const before = await computeAppSourceHash(appDir);
    await writeFile(join(appDir, "main.ts"), "export const x = 1;\n");
    const after = await computeAppSourceHash(appDir);
    expect(after).not.toBe(before);
  });

  test("scan order is deterministic by id", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    const betaDir = join(root, "beta");
    await mkdir(betaDir, { recursive: true });
    await writeFile(
      join(betaDir, "app.json"),
      `${JSON.stringify(
        {
          ...TEST_MINI_APP_MANIFEST,
          id: "beta",
          name: "Beta",
        },
        null,
        2,
      )}\n`,
    );
    const apps = await scanInstalledApps(root);
    expect(apps.map((app) => app.id)).toEqual(["beta", "test-canvas"]);
  });

  test("needs_dependencies when package.json declares deps and node_modules missing", async () => {
    const root = await makeAppsRoot();
    await writeTestApp(root);
    await writeFile(
      join(root, "test-canvas", "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: { lodash: "^4.0.0" },
        },
        null,
        2,
      )}\n`,
    );
    const apps = await scanInstalledApps(root);
    expect(apps[0]?.status).toBe("needs_dependencies");
  });

  test("validation-only dev and peer declarations do not require a runtime install", async () => {
    const root = await makeAppsRoot();
    const appDir = join(root, "validation-only");
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, "app.json"),
      JSON.stringify({
        ...TEST_MINI_APP_MANIFEST,
        id: "validation-only",
        name: "Validation Only",
      }),
    );
    await writeFile(join(appDir, "main.ts"), "export {};\n");
    await writeFile(join(appDir, "index.html"), "<main></main>\n");
    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify({
        devDependencies: { typescript: "1.0.0" },
        peerDependencies: { react: "1.0.0" },
      }),
    );

    const apps = await scanInstalledApps(root);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.status).toBe("ready");
  });

  test("seeded first-party apps are scannable and enabled", async () => {
    // Seed from a controlled fake source tree that mirrors the shipped
    // sourceDir → appId map (Writer + Design) but WITHOUT
    // real `node_modules`. Seeding the real first-party root here is
    // non-deterministic: `cp` with `dereference: true` throws ENOENT on any
    // dangling dependency symlink present in a developer's install. This keeps
    // the seed → scan contract deterministic.
    const sourceRoot = await mkdtemp(join(tmpdir(), "nautilo-registry-src-"));
    const firstPartyApps: ReadonlyArray<readonly [string, string]> = [
      ["writer", "nautilo-writer"],
      ["design", "nautilo-design"],
    ];
    for (const [dir, id] of firstPartyApps) {
      const appDir = join(sourceRoot, dir);
      await mkdir(appDir, { recursive: true });
      await writeFile(
        join(appDir, "app.json"),
        `${JSON.stringify({ ...TEST_MINI_APP_MANIFEST, id, name: id }, null, 2)}\n`,
      );
      await writeFile(join(appDir, "main.ts"), "export {};\n");
      await writeFile(
        join(appDir, "package.json"),
        `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      );
    }

    const root = await makeAppsRoot();
    const { seeded } = await seedFirstPartyApps({ appsRoot: root, sourceRoot });
    await rm(sourceRoot, { recursive: true, force: true });

    const apps = await scanInstalledApps(root);
    expect(seeded).toEqual(["nautilo-writer", "nautilo-design"]);
    expect(apps.length).toBe(seeded.length);
    expect(apps.find((a) => a.id === "nautilo-writer")?.status).toBe("ready");
    expect(apps.find((a) => a.id === "nautilo-design")?.status).toBe("ready");
    expect(apps.every((a) => a.status === "ready")).toBe(true);
    // D343 — nothing disabled by default, so every seeded app is enabled.
    expect(apps.every((a) => a.enabled)).toBe(true);
  });

  test("ignores non-directories and folders without app.json", async () => {
    const root = await makeAppsRoot();
    await writeFile(join(root, "readme.txt"), "ignore me");
    await mkdir(join(root, "empty-dir"), { recursive: true });
    const apps = await scanInstalledApps(root);
    expect(apps).toHaveLength(0);
  });

  test("ignores dot-prefixed seed and previous staging folders with app.json", async () => {
    const root = await makeAppsRoot();
    const manifest = { ...TEST_MINI_APP_MANIFEST, id: "nautilo-writer", name: "Writer" };

    async function writeAppDir(folderName: string): Promise<void> {
      const appDir = join(root, folderName);
      await mkdir(appDir, { recursive: true });
      await writeFile(join(appDir, "app.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(appDir, "main.ts"), "export {};\n");
      await writeFile(
        join(appDir, "package.json"),
        `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
      );
    }

    await writeAppDir("nautilo-writer");
    await writeAppDir(".nautilo-writer.seed-abc123");
    await writeAppDir(".nautilo-writer.previous-abc123");

    const apps = await scanInstalledApps(root);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.id).toBe("nautilo-writer");
    expect(apps[0]?.root).toBe(join(root, "nautilo-writer"));
  });
});
