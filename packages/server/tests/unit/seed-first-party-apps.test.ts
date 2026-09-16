import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFirstPartyApps } from "../../src/apps/seed-first-party-apps";

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

/** Build a fake first-party app source dir under `sourceRoot/<dirName>/`. */
async function makeFakeAppSource(
  sourceRoot: string,
  dirName: string,
  appId: string,
): Promise<void> {
  const appDir = join(sourceRoot, dirName);
  await mkdir(appDir, { recursive: true });
  await writeFile(
    join(appDir, "app.json"),
    `${JSON.stringify({ id: appId, name: appId, version: "0.1.0" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(appDir, "main.ts"), `// entry for ${appId}\n`, "utf8");
}

describe("seedFirstPartyApps", () => {
  test("creates apps root when missing and seeds Writer with marker", async () => {
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    await makeFakeAppSource(sourceRoot, "writer", "nautilo-writer");

    const parent = await makeTempDir("nautilo-seed-parent-");
    const appsRoot = join(parent, "apps");
    const result = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(result.seeded).toEqual(["nautilo-writer"]);

    const writerDir = join(appsRoot, "nautilo-writer");
    await stat(writerDir);
    const marker = JSON.parse(
      await readFile(join(writerDir, ".nautilo-seed.json"), "utf8"),
    ) as Record<string, string>;
    expect(marker["seededFrom"]).toBe("first-party");
    expect(marker["appId"]).toBe("nautilo-writer");
    expect(marker["initialVersion"]).toBe("0.1.0");
    expect(marker["sourceHash"]).toMatch(/^[a-f0-9]{64}$/);
    await stat(join(writerDir, "app.json"));
    await stat(join(writerDir, "main.ts"));
  });

  test("refreshes existing Writer folder when installed source differs", async () => {
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    await makeFakeAppSource(sourceRoot, "writer", "nautilo-writer");

    const appsRoot = await makeTempDir("nautilo-seed-existing-");
    const writerDir = join(appsRoot, "nautilo-writer");

    const first = await seedFirstPartyApps({ appsRoot, sourceRoot });
    await mkdir(join(appsRoot, ".cache", "nautilo-writer", "old-hash"), { recursive: true });
    await writeFile(join(writerDir, "main.ts"), "// local edit\n");
    const second = await seedFirstPartyApps({ appsRoot, sourceRoot });
    const third = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(first.seeded).toEqual(["nautilo-writer"]);
    expect(second.seeded).toEqual(["nautilo-writer"]);
    expect(third.seeded).toEqual([]);

    expect(await readFile(join(writerDir, "main.ts"), "utf8")).not.toBe("// local edit\n");
    let staleCacheExists = true;
    try {
      await stat(join(appsRoot, ".cache", "nautilo-writer", "old-hash"));
    } catch {
      staleCacheExists = false;
    }
    expect(staleCacheExists).toBe(false);
  });

  test("retries a transient Writer nested-file ENOENT without exposing a partial seed", async () => {
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    await makeFakeAppSource(sourceRoot, "writer", "nautilo-writer");
    const nestedDependencyFile = join(
      sourceRoot,
      "writer",
      "node_modules",
      "pako",
      "README.md",
    );
    await mkdir(join(nestedDependencyFile, ".."), { recursive: true });
    await writeFile(nestedDependencyFile, "dependency readme\n", "utf8");

    const appsRoot = await makeTempDir("nautilo-seed-writer-retry-");
    await seedFirstPartyApps({ appsRoot, sourceRoot });
    const writerDest = join(appsRoot, "nautilo-writer");
    await writeFile(join(writerDest, "main.ts"), "// known-good seed\n", "utf8");
    await writeFile(join(sourceRoot, "writer", "main.ts"), "// refreshed writer seed\n", "utf8");
    await mkdir(join(appsRoot, ".cache", "nautilo-writer", "old-hash"), { recursive: true });

    let copyAttempts = 0;
    const result = await seedFirstPartyApps({
      appsRoot,
      sourceRoot,
      copyDirectory: async (source, destination, options) => {
        copyAttempts += 1;
        if (copyAttempts === 1) {
          // The live destination must stay available while the failed attempt
          // is confined to its staging sibling.
          expect(await readFile(join(writerDest, "main.ts"), "utf8")).toBe("// known-good seed\n");
          throw Object.assign(
            new Error(`ENOENT: no such file or directory, copyfile '${nestedDependencyFile}'`),
            { code: "ENOENT" },
          );
        }
        await cp(source, destination, options);
      },
    });

    expect(copyAttempts).toBe(2);
    expect(result.seeded).toEqual(["nautilo-writer"]);
    expect(await readFile(join(writerDest, "main.ts"), "utf8")).toBe("// refreshed writer seed\n");
    expect(await readFile(join(writerDest, "node_modules", "pako", "README.md"), "utf8")).toBe(
      "dependency readme\n",
    );

    const transientArtifacts = (await readdir(appsRoot)).filter((name) =>
      name.startsWith(".nautilo-writer.seed-") || name.startsWith(".nautilo-writer.previous-"),
    );
    expect(transientArtifacts).toEqual([]);
    try {
      await stat(join(appsRoot, ".cache", "nautilo-writer", "old-hash"));
      throw new Error("stale cache should be removed");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });

  test("seeds the shipped set and skips retired or unprepared apps", async () => {
    // The legacy `slides` app remains retired. Compiled Sheets is shipped only
    // when its prepared engine artifacts are present, so an unprepared source
    // directory is omitted.
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    await makeFakeAppSource(sourceRoot, "spreadsheet-lite", "spreadsheet-lite");
    await makeFakeAppSource(sourceRoot, "writer", "nautilo-writer");
    await makeFakeAppSource(sourceRoot, "design", "nautilo-design");
    await makeFakeAppSource(sourceRoot, "video", "nautilo-video");
    await makeFakeAppSource(sourceRoot, "slides", "nautilo-slides");
    await makeFakeAppSource(sourceRoot, "spreadsheet", "nautilo-spreadsheet");

    const appsRoot = await makeTempDir("nautilo-seed-both-");
    const result = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(result.seeded).toEqual([
      "nautilo-writer",
      "nautilo-design",
      "nautilo-video",
    ]);

    const writerDir = join(appsRoot, "nautilo-writer");
    await stat(writerDir);
    await stat(join(appsRoot, "nautilo-design"));
    await stat(join(appsRoot, "nautilo-video"));

    // Retired apps must NOT be seeded even if stray source dirs exist.
    for (const retired of ["spreadsheet-lite", "nautilo-slides"]) {
      let retiredExists = true;
      try {
        await stat(join(appsRoot, retired));
      } catch {
        retiredExists = false;
      }
      expect(retiredExists).toBe(false);
    }

    const writerMarker = JSON.parse(
      await readFile(join(writerDir, ".nautilo-seed.json"), "utf8"),
    ) as Record<string, string>;
    expect(writerMarker["seededFrom"]).toBe("first-party");
    expect(writerMarker["appId"]).toBe("nautilo-writer");
    expect(writerMarker["initialVersion"]).toBe("0.1.0");
    expect(writerMarker["sourceHash"]).toMatch(/^[a-f0-9]{64}$/);
    await stat(join(writerDir, "app.json"));
    await stat(join(writerDir, "main.ts"));
  });

  test("dereferences dependency symlinks so seeded apps are self-contained", async () => {
    // Uses a shipped app (Writer) so the case still exercises the
    // seeder's `dereference: true` path. The behavior is generic to any seeded app.
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    await makeFakeAppSource(sourceRoot, "writer", "nautilo-writer");

    const dependencySource = await makeTempDir("nautilo-seed-dep-");
    await mkdir(join(dependencySource, "dist"), { recursive: true });
    await writeFile(join(dependencySource, "dist", "index.js"), "export const ok = true;\n", "utf8");

    const appNodeModulesScope = join(sourceRoot, "writer", "node_modules", "@wafflebase");
    await mkdir(appNodeModulesScope, { recursive: true });
    await symlink(dependencySource, join(appNodeModulesScope, "sheets"), "dir");

    const appsRoot = await makeTempDir("nautilo-seed-deref-");
    const result = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(result.seeded).toEqual(["nautilo-writer"]);

    const seededDependency = join(
      appsRoot,
      "nautilo-writer",
      "node_modules",
      "@wafflebase",
      "sheets",
    );
    const seededStat = await lstat(seededDependency);
    expect(seededStat.isSymbolicLink()).toBe(false);
    expect(await readFile(join(seededDependency, "dist", "index.js"), "utf8")).toBe(
      "export const ok = true;\n",
    );
  });

  test("reseeds Writer from the declared file: source when its installed dependency copy is stale", async () => {
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    const coreRoot = join(sourceRoot, "writer-proposal-core");
    await mkdir(join(coreRoot, "src"), { recursive: true });
    await writeFile(
      join(coreRoot, "package.json"),
      `${JSON.stringify({ name: "@nautilo/writer-proposal-core", private: true }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(coreRoot, "src", "index.ts"), "export const core = 1;\n", "utf8");

    const writerDir = join(sourceRoot, "writer");
    await mkdir(writerDir, { recursive: true });
    await writeFile(
      join(writerDir, "app.json"),
      `${JSON.stringify({ id: "nautilo-writer", name: "Writer", version: "0.1.0" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(writerDir, "main.ts"), "// writer entry\n", "utf8");
    await writeFile(
      join(writerDir, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          type: "module",
          dependencies: { "@nautilo/writer-proposal-core": "file:../writer-proposal-core" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const writerCoreInstall = join(
      writerDir,
      "node_modules",
      "@nautilo",
      "writer-proposal-core",
    );
    await mkdir(join(writerCoreInstall, "src"), { recursive: true });
    await writeFile(
      join(writerCoreInstall, "package.json"),
      `${JSON.stringify({ name: "@nautilo/writer-proposal-core", private: true }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(writerCoreInstall, "src", "index.ts"),
      "export const core = 1;\n",
      "utf8",
    );

    const appsRoot = await makeTempDir("nautilo-seed-core-change-");
    const first = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(first.seeded).toEqual(["nautilo-writer"]);

    const writerDest = join(appsRoot, "nautilo-writer");
    const markerBefore = JSON.parse(
      await readFile(join(writerDest, ".nautilo-seed.json"), "utf8"),
    ) as Record<string, string>;
    const seededCoreBefore = await readFile(
      join(writerDest, "node_modules", "@nautilo", "writer-proposal-core", "src", "index.ts"),
      "utf8",
    );

    await writeFile(join(coreRoot, "src", "index.ts"), "export const core = 2;\n", "utf8");
    expect(await readFile(join(writerCoreInstall, "src", "index.ts"), "utf8")).toBe(
      "export const core = 1;\n",
    );
    const second = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(second.seeded).toEqual(["nautilo-writer"]);

    const markerAfter = JSON.parse(
      await readFile(join(writerDest, ".nautilo-seed.json"), "utf8"),
    ) as Record<string, string>;
    const seededCoreAfter = await readFile(
      join(writerDest, "node_modules", "@nautilo", "writer-proposal-core", "src", "index.ts"),
      "utf8",
    );

    expect(markerAfter["sourceHash"]).not.toBe(markerBefore["sourceHash"]);
    expect(seededCoreAfter).toBe("export const core = 2;\n");
    expect(seededCoreBefore).toBe("export const core = 1;\n");
  });

  test("does not overlay validation-only file dependencies into a production seed", async () => {
    const sourceRoot = await makeTempDir("nautilo-seed-validation-deps-source-");
    const appsRoot = await makeTempDir("nautilo-seed-validation-deps-apps-");
    const writerDir = join(sourceRoot, "writer");
    await makeFakeAppSource(sourceRoot, "writer", "nautilo-writer");
    await writeFile(
      join(writerDir, "package.json"),
      `${JSON.stringify({
        devDependencies: { "@nautilo/dev-only": "file:../dev-only" },
        peerDependencies: { "@nautilo/peer-only": "file:../peer-only" },
      }, null, 2)}\n`,
    );
    for (const name of ["dev-only", "peer-only"]) {
      const dependencyRoot = join(sourceRoot, name);
      await mkdir(dependencyRoot, { recursive: true });
      await writeFile(join(dependencyRoot, "package.json"), `${JSON.stringify({ name })}\n`);
    }

    const result = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(result.seeded).toEqual(["nautilo-writer"]);
    expect(
      stat(join(appsRoot, "nautilo-writer", "node_modules", "@nautilo", "dev-only")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      stat(join(appsRoot, "nautilo-writer", "node_modules", "@nautilo", "peer-only")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("skips missing Writer source dir and still seeds Video without throwing", async () => {
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    await makeFakeAppSource(sourceRoot, "video", "nautilo-video");
    // intentionally no writer/ dir

    const appsRoot = await makeTempDir("nautilo-seed-missing-writer-");
    const result = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(result.seeded).toEqual(["nautilo-video"]);

    await stat(join(appsRoot, "nautilo-video"));
    let writerDestExists = true;
    try {
      await stat(join(appsRoot, "nautilo-writer"));
    } catch {
      writerDestExists = false;
    }
    expect(writerDestExists).toBe(false);
  });

  test("seeds nautilo-video (source dir 'video' → app id 'nautilo-video') with marker", async () => {
    const sourceRoot = await makeTempDir("nautilo-seed-src-");
    await makeFakeAppSource(sourceRoot, "video", "nautilo-video");

    const appsRoot = await makeTempDir("nautilo-seed-video-");
    const result = await seedFirstPartyApps({ appsRoot, sourceRoot });
    expect(result.seeded).toEqual(["nautilo-video"]);

    const videoDir = join(appsRoot, "nautilo-video");
    await stat(videoDir);
    const videoMarker = JSON.parse(
      await readFile(join(videoDir, ".nautilo-seed.json"), "utf8"),
    ) as Record<string, string>;
    expect(videoMarker["seededFrom"]).toBe("first-party");
    expect(videoMarker["appId"]).toBe("nautilo-video");
    expect(videoMarker["initialVersion"]).toBe("0.1.0");
    expect(videoMarker["sourceHash"]).toMatch(/^[a-f0-9]{64}$/);
    await stat(join(videoDir, "app.json"));
    await stat(join(videoDir, "main.ts"));
  });
});

describe("optional compiled Sheets", () => {
  async function fixture() {
    const sourceRoot = await makeTempDir("nautilo-sheets-source-");
    const appsRoot = await makeTempDir("nautilo-sheets-apps-");
    await makeFakeAppSource(sourceRoot, "spreadsheet", "nautilo-spreadsheet");
    return { sourceRoot, appsRoot };
  }
  async function engine(sourceRoot: string) {
    const root = join(sourceRoot, "spreadsheet", "engine");
    await mkdir(root, { recursive: true });
    const files: Record<string, string> = {};
    for (const name of ["index.js", "browser.js", "node.js", "LICENSE"]) {
      const content = name === "LICENSE" ? "Apache-2.0" : 'export const version = "qualified";';
      await writeFile(join(root, name), content);
      files[name] = createHash("sha256").update(content).digest("hex");
    }
    await writeFile(join(root, "provenance.json"), JSON.stringify({ files }));
  }
  test("unprepared app omitted; prepared app enabled on a fresh install", async () => {
    const options = await fixture();
    expect((await seedFirstPartyApps(options)).seeded).toEqual([]);
    await engine(options.sourceRoot);
    expect((await seedFirstPartyApps(options)).seeded).toEqual(["nautilo-spreadsheet"]);
    const { isAppDisabled } = await import("../../src/apps/app-state-store");
    expect(await isAppDisabled(options.appsRoot, "nautilo-spreadsheet")).toBe(false);
  });
  test("refresh retains user's enable/disable choice", async () => {
    const options = await fixture();
    await engine(options.sourceRoot);
    await seedFirstPartyApps(options);
    const { isAppDisabled, setAppDisabled } = await import("../../src/apps/app-state-store");
    await setAppDisabled(options.appsRoot, "nautilo-spreadsheet", false);
    await writeFile(join(options.sourceRoot, "spreadsheet", "main.ts"), "// upgrade one");
    await seedFirstPartyApps(options);
    expect(await isAppDisabled(options.appsRoot, "nautilo-spreadsheet")).toBe(false);
    await setAppDisabled(options.appsRoot, "nautilo-spreadsheet", true);
    await writeFile(join(options.sourceRoot, "spreadsheet", "main.ts"), "// upgrade two");
    await seedFirstPartyApps(options);
    expect(await isAppDisabled(options.appsRoot, "nautilo-spreadsheet")).toBe(true);
  });
  test("partial artifact refuses refresh and preserves installed source", async () => {
    const options = await fixture();
    await engine(options.sourceRoot);
    await seedFirstPartyApps(options);
    const installed = await readFile(join(options.appsRoot, "nautilo-spreadsheet", "main.ts"), "utf8");
    await rm(join(options.sourceRoot, "spreadsheet", "engine", "node.js"));
    expect(seedFirstPartyApps(options)).rejects.toThrow("Incomplete compiled engine");
    expect(await readFile(join(options.appsRoot, "nautilo-spreadsheet", "main.ts"), "utf8")).toBe(installed);
  });
});

describe("prepared native Slides", () => {
  async function fixture() {
    const sourceRoot = await makeTempDir("nautilo-slides-source-");
    const appsRoot = await makeTempDir("nautilo-slides-apps-");
    await makeFakeAppSource(sourceRoot, "presentation", "nautilo-presentation");
    return { sourceRoot, appsRoot };
  }

  async function engine(sourceRoot: string) {
    const root = join(sourceRoot, "presentation", "engine");
    await mkdir(join(root, "dictionaries"), { recursive: true });
    await mkdir(join(root, "node_modules", "@nautilo", "office-core", "dist", "geometry"), { recursive: true });
    await mkdir(join(root, "node_modules", "@nautilo", "office-docs", "dist"), { recursive: true });
    const files: Record<string, string> = {};
    for (const name of [
      "browser.js",
      "node.js",
      "index.d.ts",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "dictionaries/DICTIONARY-LICENSE.txt",
      "dictionaries/en_US.aff",
      "dictionaries/en_US.dic",
      "node_modules/@nautilo/office-core/dist/geometry/index.d.ts",
      "node_modules/@nautilo/office-docs/dist/index.d.ts",
    ]) {
      const content = `${name}: qualified\n`;
      await writeFile(join(root, name), content);
      files[name] = createHash("sha256").update(content).digest("hex");
    }
    await writeFile(join(root, "provenance.json"), JSON.stringify({ files }));
  }

  test("omits unprepared Slides and seeds a prepared build enabled by default", async () => {
    const options = await fixture();
    expect((await seedFirstPartyApps(options)).seeded).toEqual([]);
    await engine(options.sourceRoot);
    expect((await seedFirstPartyApps(options)).seeded).toEqual(["nautilo-presentation"]);
    const { isAppDisabled } = await import("../../src/apps/app-state-store");
    expect(await isAppDisabled(options.appsRoot, "nautilo-presentation")).toBe(false);
  });

  test("preserves an explicit disabled choice across upgrade and no-op startup", async () => {
    const options = await fixture();
    await engine(options.sourceRoot);
    await seedFirstPartyApps(options);
    const { isAppDisabled, setAppDisabled } = await import("../../src/apps/app-state-store");
    await setAppDisabled(options.appsRoot, "nautilo-presentation", true);
    await writeFile(join(options.sourceRoot, "presentation", "main.ts"), "// qualified refresh\n");
    expect((await seedFirstPartyApps(options)).seeded).toEqual(["nautilo-presentation"]);
    expect(await isAppDisabled(options.appsRoot, "nautilo-presentation")).toBe(true);
    expect((await seedFirstPartyApps(options)).seeded).toEqual([]);
    expect(await isAppDisabled(options.appsRoot, "nautilo-presentation")).toBe(true);
  });

  test("rejects an upgraded Slides engine missing its dictionary closure and preserves the installed app", async () => {
    const options = await fixture();
    await engine(options.sourceRoot);
    await seedFirstPartyApps(options);
    const installed = await readFile(join(options.appsRoot, "nautilo-presentation", "main.ts"), "utf8");
    await writeFile(join(options.sourceRoot, "presentation", "main.ts"), "// incomplete upgrade\n");
    await rm(join(options.sourceRoot, "presentation", "engine", "dictionaries", "en_US.dic"));
    expect(seedFirstPartyApps(options)).rejects.toThrow("Incomplete compiled engine");
    expect(await readFile(join(options.appsRoot, "nautilo-presentation", "main.ts"), "utf8")).toBe(installed);
  });
});

describe("prepared native Board", () => {
  async function fixture() {
    const sourceRoot = await makeTempDir("nautilo-board-source-");
    const appsRoot = await makeTempDir("nautilo-board-apps-");
    await makeFakeAppSource(sourceRoot, "board", "nautilo-board");
    return { sourceRoot, appsRoot };
  }

  async function engine(sourceRoot: string) {
    const root = join(sourceRoot, "board", "engine");
    await mkdir(root, { recursive: true });
    const files: Record<string, string> = {};
    for (const name of ["main.js", "agent-tools.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      const content = `${name}: qualified\n`;
      await writeFile(join(root, name), content);
      files[name] = createHash("sha256").update(content).digest("hex");
    }
    await writeFile(join(root, "provenance.json"), JSON.stringify({ files }));
  }

  test("omits an unprepared Board and refuses a tampered engine without replacing the installed app", async () => {
    const options = await fixture();
    expect((await seedFirstPartyApps(options)).seeded).toEqual([]);

    await engine(options.sourceRoot);
    expect((await seedFirstPartyApps(options)).seeded).toEqual(["nautilo-board"]);
    const installed = await readFile(join(options.appsRoot, "nautilo-board", "main.ts"), "utf8");

    await writeFile(join(options.sourceRoot, "board", "main.ts"), "// tampered upgrade\n");
    await writeFile(join(options.sourceRoot, "board", "engine", "main.js"), "tampered bytes\n");
    expect(seedFirstPartyApps(options)).rejects.toThrow("Compiled engine integrity mismatch for nautilo-board: main.js");
    expect(await readFile(join(options.appsRoot, "nautilo-board", "main.ts"), "utf8")).toBe(installed);
  });
});
