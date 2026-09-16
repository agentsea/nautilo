/** Verify the shipped Board bytes and app lifecycle in an isolated, networkless
 * container. This does not replace authenticated Desktop/storage acceptance.
 * Usage: bun packaging/wafflebase/verify-board-image.mjs IMAGE SOURCE_SHA
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { text } from "node:stream/consumers";
import { build, spawn } from "bun";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));
async function tree(root, relative = "") {
  const found = {};
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(found, await tree(root, path));
    else if (entry.isFile()) found[path] = digest(await readFile(join(root, path)));
  }
  return found;
}
async function run(args) {
  const child = spawn(args, { stdout: "pipe", stderr: "inherit" });
  const output = await text(child.stdout);
  assert.equal(await child.exited, 0, `${args[0]} ${args[1]} failed`);
  return output;
}

if (process.argv[2] !== "--inside") {
  const [image, sourceSha] = process.argv.slice(2);
  assert(image && /^[a-f0-9]{40}$/.test(sourceSha ?? ""), "Pass IMAGE and its full SOURCE_SHA");
  const imageInfo = JSON.parse(await run(["docker", "image", "inspect", image]))[0];
  assert.equal(imageInfo.Config.Labels["org.opencontainers.image.revision"], sourceSha);
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  assert.equal((await run(["git", "-C", root, "rev-parse", "HEAD"])).trim(), sourceSha, "Run from the source commit being qualified");
  const { fingerprintBoardSource } = await import("./board-artifacts.ts");
  const expected = await fingerprintBoardSource(root);
  const expectedRecipe = digest(await readFile(join(root, "packaging/wafflebase/board-artifacts.ts")));
  const script = fileURLToPath(import.meta.url);
  const mounts = [script + ":/verify-board-image.mjs:ro"];
  for (const name of ["board.svg", "board-preview.png"]) mounts.push(join(root, "apps/workbench/public/apps/office", name) + ":/checkout/" + name + ":ro");
  console.log(JSON.stringify({ image: imageInfo.Id, sourceSha, scope: "packaged closure and disposable app lifecycle" }));
  console.log(await run(["docker", "run", "--rm", "--network=none", ...mounts.flatMap(mount => ["-v", mount]), "--entrypoint=bun", imageInfo.Id, "/verify-board-image.mjs", "--inside", expected.hash, expectedRecipe]));
} else {
  const source = "/srv/repo/packages/first-party-apps/board";
  const provenance = await json(join(source, "engine/provenance.json"));
  assert.match(provenance.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(provenance.recipeSha256, /^[a-f0-9]{64}$/);
  assert.equal(provenance.sourceSha256, process.argv[3], "Board must match the qualified checkout source");
  assert.equal(provenance.recipeSha256, process.argv[4], "Board must match the qualified build recipe");
  for (const [path, hash] of Object.entries(provenance.files)) {
    assert(path && !path.startsWith("/") && !path.split("/").includes(".."));
    assert.equal(digest(await readFile(join(source, "engine", path))), hash, path);
  }
  for (const name of ["main.js", "agent-tools.js", "LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md"]) assert(provenance.files[name], name);
  const notices = await readFile(join(source, "engine/THIRD_PARTY_NOTICES.md"), "utf8");
  for (const dependency of ["@nautilo/office-board", "@nautilo/office-slides", "@nautilo/office-docs", "@nautilo/office-core", "parse5"]) assert(notices.includes(dependency));
  for (const name of ["board.svg", "board-preview.png"]) assert.equal(digest(await readFile("/srv/workbench/apps/office/" + name)), digest(await readFile("/checkout/" + name)), name);
  const manifest = await json(join(source, "app.json"));
  assert.equal(manifest.entry, "./engine/main.js");
  assert.equal(manifest.display.groupId, "nautilo-office");
  assert.equal(manifest.agent.tools.length, 6);
  for (const tool of manifest.agent.tools) assert.equal(tool.module, "./engine/agent-tools.js");
  assert.equal(typeof globalThis.document, "undefined");
  const tools = await import(join(source, "engine/agent-tools.js"));
  for (const handler of manifest.agent.tools.map(tool => tool.handler)) assert.equal(typeof tools[handler], "function", handler);
  assert.equal(tools.describeAuthoring({ includeSchema: true }).completeness, "complete");
  const built = await build({ entrypoints: [join(source, "engine/main.js")], target: "browser" });
  assert(built.success, "browser entry must bundle with shipped dependencies alone");

  const serverRoot = "/srv/repo/packages/server/src/apps/";
  const { seedFirstPartyApps } = await import(serverRoot + "seed-first-party-apps.ts");
  const { isAppDisabled, setAppDisabled } = await import(serverRoot + "app-state-store.ts");
  const { computeAppSourceHash } = await import(serverRoot + "app-registry.ts");
  const root = await mkdtemp("/tmp/board-image-lifecycle-");
  const appId = "nautilo-board", appsRoot = join(root, "apps"), v1 = join(root, "v1"), v2 = join(root, "v2");
  const seed = sourceRoot => seedFirstPartyApps({ appsRoot, sourceRoot, appIds: [appId] });
  try {
    await cp(source, join(v1, "board"), { recursive: true });
    assert((await seed(v1)).seeded.includes(appId));
    assert.equal(await isAppDisabled(appsRoot, appId), false);
    const original = await computeAppSourceHash(join(appsRoot, appId));
    await cp(v1, v2, { recursive: true });
    const next = await json(join(v2, "board/app.json"));
    next.version = "0.1.1";
    await writeFile(join(v2, "board/app.json"), JSON.stringify(next));
    await setAppDisabled(appsRoot, appId, true);
    assert((await seed(v2)).seeded.includes(appId));
    const upgraded = await computeAppSourceHash(join(appsRoot, appId));
    assert.notEqual(upgraded, original);
    assert.equal(await isAppDisabled(appsRoot, appId), true);
    assert.deepEqual((await seed(v2)).seeded, []);
    assert.equal(await isAppDisabled(appsRoot, appId), true);
    assert((await seed(v1)).seeded.includes(appId));
    assert.equal(await computeAppSourceHash(join(appsRoot, appId)), original);
    assert.equal(await isAppDisabled(appsRoot, appId), true);
    const backup = join(root, "backup");
    await cp(appsRoot, backup, { recursive: true });
    const before = await tree(backup);
    await setAppDisabled(appsRoot, appId, false);
    await seed(v2);
    await rm(appsRoot, { recursive: true });
    await cp(backup, appsRoot, { recursive: true });
    assert.deepEqual(await tree(appsRoot), before);
    assert.equal(await isAppDisabled(appsRoot, appId), true);
    await setAppDisabled(appsRoot, appId, false);
    await seed(v2);
    assert.equal(await isAppDisabled(appsRoot, appId), false);
    console.log(JSON.stringify({ checks: ["engine hashes and notices", "exact icon and preview", "browser and DOM-free tool exports", "default enabled seed", "explicit disable through upgrade and reseed", "rollback source and preference", "exact app-root backup/restore", "enabled preference through upgrade"], manifestedFiles: Object.keys(provenance.files).length, sourceSha256: provenance.sourceSha256, fullInstanceRestore: "separate live acceptance", failures: [] }, null, 2));
  } finally { await rm(root, { recursive: true, force: true }); }
}
