import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanInstalledApps } from "../../src/apps/app-registry";
import { setAppDisabled } from "../../src/apps/app-state-store";
import { seedFirstPartyApps } from "../../src/apps/seed-first-party-apps";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function prepareBoardSource(sourceRoot: string): Promise<string> {
  const repositoryBoard = join(import.meta.dir, "../../../first-party-apps/board");
  const boardRoot = join(sourceRoot, "board");
  await cp(repositoryBoard, boardRoot, { recursive: true });
  const engineRoot = join(boardRoot, "engine");
  await rm(engineRoot, { recursive: true, force: true });
  await mkdir(engineRoot);
  const files: Record<string, string> = {};
  for (const name of ["main.js", "agent-tools.js", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    const content = `${name}: qualified\n`;
    await writeFile(join(engineRoot, name), content);
    files[name] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(join(engineRoot, "provenance.json"), `${JSON.stringify({ files })}\n`);
  return boardRoot;
}

describe("packaged Board lifecycle", () => {
  test("fresh seed is enabled while an explicit disable survives a packaged upgrade", async () => {
    const sourceRoot = await temporaryRoot("nautilo-board-release-source-");
    const appsRoot = await temporaryRoot("nautilo-board-release-apps-");
    const boardRoot = await prepareBoardSource(sourceRoot);

    expect((await seedFirstPartyApps({ sourceRoot, appsRoot })).seeded).toEqual(["nautilo-board"]);
    expect((await scanInstalledApps(appsRoot)).find((app) => app.id === "nautilo-board")?.enabled).toBe(true);

    await setAppDisabled(appsRoot, "nautilo-board", true);
    await writeFile(join(boardRoot, "README.md"), `${await readFile(join(boardRoot, "README.md"), "utf8")}\npackaged upgrade\n`);

    expect((await seedFirstPartyApps({ sourceRoot, appsRoot })).seeded).toEqual(["nautilo-board"]);
    expect((await scanInstalledApps(appsRoot)).find((app) => app.id === "nautilo-board")?.enabled).toBe(false);
  });
});
