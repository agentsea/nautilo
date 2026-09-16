import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ownedPackages = ["packages/office-core", "packages/office-docs", "packages/office-slides"];
const ownedDependencyRoots = new Map(ownedPackages.map(path => [`@nautilo/${path.slice("packages/".length)}`, path]));
const excluded = new Set(["dist", "node_modules", ".git", ".turbo", ".cache", "coverage"]);

async function filesBelow(root, path = "", source = false) {
  const files = [];
  for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
    if (source && excluded.has(entry.name)) continue;
    if (source && path === "" && (entry.name === "test" || entry.name === "tests")) continue;
    const child = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(root, child, source));
    else if (entry.isFile() && (!source || (
      !/\.(test|integration\.test)\.tsx?$/.test(entry.name)
      && !/\.(tsbuildinfo|log)$/.test(entry.name)
    ))) files.push(child);
  }
  return files.sort();
}

const digest = value => createHash("sha256").update(value).digest("hex");

export async function fingerprintSlidesSource(root) {
  const inputs = ["package.json", "bun.lock", "turbo.json"];
  for (const packagePath of ownedPackages) {
    inputs.push(...(await filesBelow(join(root, packagePath), "", true)).map(path => `${packagePath}/${path}`));
  }
  const hash = createHash("sha256");
  for (const path of inputs.sort()) hash.update(path).update("\0").update(await readFile(join(root, path))).update("\0");
  return hash.digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal})`);
}

async function packageLicenseTexts(packageRoot, pkg) {
  const names = (await readdir(packageRoot)).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name)).sort();
  const texts = [];
  for (const name of names) {
    try { texts.push(`### ${name}\n\n${await readFile(join(packageRoot, name), "utf8")}`); }
    catch (error) { if (error.code !== "EISDIR") throw error; }
  }
  if (texts.length === 0 && pkg.license) texts.push(`Declared package license: ${pkg.license}\n`);
  if (texts.length === 0) throw new Error(`Missing dependency license text: ${pkg.name}`);
  return texts;
}

async function dependencyNotices(root) {
  const queue = ownedPackages.map(path => join(root, path));
  const seen = new Set();
  const sections = [];
  for (let index = 0; index < queue.length; index++) {
    const packageRoot = await realpath(queue[index]);
    if (seen.has(packageRoot)) continue;
    seen.add(packageRoot);
    const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    sections.push(`## ${pkg.name}@${pkg.version ?? "workspace"} (${pkg.license ?? "see license"})\n\n${(await packageLicenseTexts(packageRoot, pkg)).join("\n\n")}`);
    const require = createRequire(join(packageRoot, "package.json"));
    for (const name of Object.keys(pkg.dependencies ?? {}).sort()) {
      const owned = ownedDependencyRoots.get(name);
      if (owned) { queue.push(join(root, owned)); continue; }
      let manifest;
      try { manifest = require.resolve(`${name}/package.json`); }
      catch {
        let candidate = dirname(require.resolve(name));
        while (true) {
          try {
            const candidatePackage = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
            if (candidatePackage.name === name) { manifest = join(candidate, "package.json"); break; }
          } catch (error) { if (error.code !== "ENOENT") throw error; }
          const parent = dirname(candidate);
          if (parent === candidate) throw new Error(`Cannot resolve dependency notice: ${name}`);
          candidate = parent;
        }
      }
      queue.push(dirname(manifest));
    }
  }
  return `# Nautilo Slides bundled dependency notices\n\n${sections.sort().join("\n\n")}\n`;
}

async function assertBuilt(dist) {
  for (const path of ["wafflebase-slides.es.js", "wafflebase-slides.cjs", "node.js", "node.cjs", "index.d.ts", "node.d.ts"]) {
    let info;
    try { info = await stat(join(dist, path)); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`Incomplete @nautilo/office-slides build: ${path}`);
      throw error;
    }
    if (!info.isFile() || info.size === 0) throw new Error(`Incomplete @nautilo/office-slides build: ${path}`);
  }
}

async function copyDeclarationPackage(root, packageName, stage) {
  const sourceRoot = join(root, "packages", packageName);
  const destinationRoot = join(stage, "node_modules", "@nautilo", packageName);
  await mkdir(destinationRoot, { recursive: true });
  await cp(join(sourceRoot, "package.json"), join(destinationRoot, "package.json"));
  for (const path of await filesBelow(join(sourceRoot, "dist"))) {
    if (!path.endsWith(".d.ts")) continue;
    const destination = join(destinationRoot, "dist", path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(sourceRoot, "dist", path), destination);
  }
}

export async function buildSlidesArtifacts(root, destination, { build = true, pin: trustedPin } = {}) {
  const pin = trustedPin ?? JSON.parse(await readFile(join(here, "upstream.json"), "utf8"));
  const sourceSha256 = await fingerprintSlidesSource(root);
  if (build) run("bunx", ["turbo", "run", "build", "--filter=@nautilo/office-slides..."], root);
  const dist = join(root, "packages/office-slides/dist");
  await assertBuilt(dist);
  const stage = `${destination}.staging-${process.pid}`;
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  try {
    for (const path of await filesBelow(dist)) {
      if (!path.endsWith(".js") && !path.endsWith(".cjs") && !path.endsWith(".d.ts")) continue;
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await cp(join(dist, path), join(stage, path));
    }
    await writeFile(join(stage, "browser.js"), 'export * from "./wafflebase-slides.es.js";\n');
    await writeFile(join(stage, "browser.d.ts"), 'export * from "./index";\n');
    // Slides declarations name Docs and Core types. Package only their emitted
    // declarations beside the engine so a seeded app never reaches back into
    // the monorepo (and avoid copying either dependency's runtime source/code).
    await copyDeclarationPackage(root, "office-core", stage);
    await copyDeclarationPackage(root, "office-docs", stage);
    await writeFile(join(stage, "package.json"), JSON.stringify({ private: true, type: "module", exports: {
      ".": { types: "./index.d.ts", import: "./browser.js" },
      "./browser": { types: "./browser.d.ts", import: "./browser.js", require: "./wafflebase-slides.cjs" },
      "./node": { types: "./node.d.ts", import: "./node.js", require: "./node.cjs" },
    } }, null, 2) + "\n");
    await cp(join(root, "packages/office-slides/LICENSE"), join(stage, "LICENSE"));
    await cp(join(root, "packages/office-slides/NOTICE.md"), join(stage, "NOTICE.md"));
    await mkdir(join(stage, "dictionaries"));
    for (const name of ["en_US.aff", "en_US.dic"]) {
      await cp(join(root, "packages/office-docs/src/spell/dict", name), join(stage, "dictionaries", name));
    }
    await cp(join(root, "packages/office-docs/DICTIONARY-LICENSE.txt"), join(stage, "dictionaries/DICTIONARY-LICENSE.txt"));
    await writeFile(join(stage, "THIRD_PARTY_NOTICES.md"), await dependencyNotices(root));
    const files = {};
    for (const path of await filesBelow(stage)) files[path] = digest(await readFile(join(stage, path)));
    await writeFile(join(stage, "provenance.json"), JSON.stringify({
      ...pin,
      sourceSha256,
      recipeSha256: digest(await readFile(fileURLToPath(import.meta.url))),
      artifactTransforms: [],
      inputs: ownedPackages,
      files,
    }, null, 2) + "\n");
    const backup = `${destination}.previous-${process.pid}`;
    let existed = false;
    try { await rename(destination, backup); existed = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    try { await rename(stage, destination); } catch (error) { if (existed) await rename(backup, destination); throw error; }
    if (existed) await rm(backup, { recursive: true, force: true });
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, mode] = process.argv.slice(2);
  if (!destination) throw new Error("Usage: node packaging/wafflebase/slides-artifacts.mjs OUTPUT [--copy-built|--fingerprint]");
  const root = resolve(here, "../..");
  if (destination === "--fingerprint") console.log(await fingerprintSlidesSource(root));
  else await buildSlidesArtifacts(root, resolve(destination), { build: mode !== "--copy-built" });
}
