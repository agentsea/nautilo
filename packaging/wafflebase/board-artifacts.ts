import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSlidesArtifacts } from "./slides-artifacts.mjs";

const inputs = ["packages/first-party-apps/board", "packages/office-board", "packages/office-slides", "packages/office-docs", "packages/office-core"];
const excluded = new Set(["dist", "engine", "node_modules", ".git", ".turbo", "coverage", "test", "tests"]);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function filesBelow(root: string, relative = "", source = false): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    if (source && excluded.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await filesBelow(root, child, source));
    else if (entry.isFile() && (!source || (!/\.(?:test|integration\.test)\.tsx?$/.test(entry.name) && !/\.(?:tsbuildinfo|log)$/.test(entry.name)))) result.push(child);
  }
  return result.sort();
}

export async function fingerprintBoardSource(root: string): Promise<{ hash: string; paths: string[] }> {
  const paths = ["package.json", "bun.lock", "turbo.json", "tsconfig.base.json", "packaging/wafflebase/board-artifacts.ts", "packaging/wafflebase/slides-artifacts.mjs", "packaging/wafflebase/upstream.json"];
  for (const packagePath of inputs) paths.push(...(await filesBelow(join(root, packagePath), "", true)).map(path => `${packagePath}/${path}`));
  const hash = createHash("sha256");
  for (const path of paths.sort()) hash.update(path).update("\0").update(await readFile(join(root, path))).update("\0");
  return { hash: hash.digest("hex"), paths };
}

async function assertFile(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Incomplete Board artifact: ${path}`);
}

export async function buildBoardArtifacts(root: string, destination: string, { build = true } = {}): Promise<void> {
  if (build) {
    const process = Bun.spawnSync(["bunx", "turbo", "run", "build", "--filter=@nautilo/office-board..."], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (process.exitCode !== 0) throw new Error(`Board dependency build failed (${process.exitCode})`);
  }
  const fingerprint = await fingerprintBoardSource(root);
  const stage = `${destination}.staging-${process.pid}`;
  const noticeStage = await mkdtemp(join(tmpdir(), "nautilo-board-notices-"));
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    const appRoot = join(root, "packages/first-party-apps/board");
    const browser = await Bun.build({ entrypoints: [join(appRoot, "main.ts")], outdir: stage, target: "browser", format: "esm", naming: "main.js" });
    if (!browser.success) throw new AggregateError(browser.logs, "Board browser bundle failed");
    const tools = await Bun.build({ entrypoints: [join(appRoot, "agent-tools.ts")], outdir: stage, target: "node", format: "esm", naming: "agent-tools.js" });
    if (!tools.success) throw new AggregateError(tools.logs, "Board agent-tools bundle failed");
    await assertFile(join(stage, "main.js")); await assertFile(join(stage, "agent-tools.js"));
    await cp(join(root, "packages/office-board/LICENSE"), join(stage, "LICENSE"));
    await cp(join(root, "packages/office-board/NOTICE.md"), join(stage, "NOTICE.md"));
    await buildSlidesArtifacts(root, noticeStage, { build: false });
    const notices = await readFile(join(noticeStage, "THIRD_PARTY_NOTICES.md"), "utf8");
    const boardNotice = await readFile(join(root, "packages/office-board/NOTICE.md"), "utf8");
    await writeFile(join(stage, "THIRD_PARTY_NOTICES.md"), `${notices}\n## @nautilo/office-board\n\n${boardNotice}\n`);
    const files: Record<string, string> = {};
    for (const path of await filesBelow(stage)) files[path] = digest(await readFile(join(stage, path)));
    await writeFile(join(stage, "provenance.json"), JSON.stringify({ sourceSha256: fingerprint.hash, recipeSha256: digest(await readFile(import.meta.filename)), inputs: fingerprint.paths, files }, null, 2) + "\n");
    const backup = `${destination}.previous-${process.pid}`;
    let existed = false;
    try { await rename(destination, backup); existed = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(stage, destination); } catch (error) { if (existed) await rename(backup, destination); throw error; }
    if (existed) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(noticeStage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: bun packaging/wafflebase/board-artifacts.ts <destination>");
  await buildBoardArtifacts(join(import.meta.dir, "../.."), destination);
}
