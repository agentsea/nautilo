import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { snapshotRuntimeDependencies } from "../../src/apps/runtime-dependency-snapshot";

const roots: string[] = [];
interface CycleModule {
  id: string;
  next(): CycleModule;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(viaAlias = false) {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "nautilo-runtime-graph-")));
  roots.push(temporaryRoot);
  let root = temporaryRoot;
  if (viaAlias) {
    const target = join(temporaryRoot, "target");
    await mkdir(target);
    root = join(temporaryRoot, "alias");
    await symlink(target, root, process.platform === "win32" ? "junction" : "dir");
  }
  const app = join(root, "source");
  const staging = join(root, "staging");
  const published = join(root, "published");
  await mkdir(app);
  await mkdir(staging);
  async function packageAt(id: string, name: string, version: string, dependencies: Record<string, string>, code: string) {
    const path = join(root, "installed", id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version, dependencies, main: "index.cjs" }));
    await writeFile(join(path, "index.cjs"), code);
    return path;
  }
  async function edge(from: string, name: string, target: string) {
    const path = join(from, "node_modules", ...name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
  }
  async function publish(localDependencies: readonly { name: string; root: string }[] = []) {
    await snapshotRuntimeDependencies(app, staging, published, localDependencies);
    await rename(staging, published);
    return createRequire(join(published, "main.cjs"));
  }
  return { root, app, published, packageAt, edge, publish };
}

test("a direct local source does not replace a nested different version", async () => {
  const f = await fixture();
  const local = await f.packageAt("local", "shared", "1", {}, 'module.exports = "fresh-one";');
  const installedOne = await f.packageAt("one", "shared", "1", {}, 'module.exports = "stale-one";');
  const installedTwo = await f.packageAt("two", "shared", "2", {}, 'module.exports = "two";');
  const consumer = await f.packageAt("consumer", "consumer", "1", { shared: "2" }, 'module.exports = require("shared");');
  await writeFile(join(f.app, "package.json"), JSON.stringify({ dependencies: { shared: "file:../local", consumer: "1" } }));
  await f.edge(f.app, "shared", installedOne);
  await f.edge(f.app, "consumer", consumer);
  await f.edge(consumer, "shared", installedTwo);
  const requireSeed = await f.publish([{ name: "shared", root: local }]);
  expect(requireSeed("shared")).toBe("fresh-one");
  expect(requireSeed("consumer")).toBe("two");
  expect(await readFile(join(f.published, "node_modules", "shared", "index.cjs"), "utf8")).toContain("fresh-one");
});

test.each(["shared", "@scope/shared"])("skips a manifest-less placeholder before the installed ancestor: %s", async (name) => {
  const f = await fixture();
  const shared = await f.packageAt("ancestor", name, "1", {}, 'module.exports = "ancestor-value";');
  const consumer = await f.packageAt("consumer", "consumer", "1", { [name]: "1" }, `module.exports = require(${JSON.stringify(name)});`);
  await writeFile(join(f.app, "package.json"), JSON.stringify({ dependencies: { consumer: "1" } }));
  await f.edge(f.app, "consumer", consumer);
  await mkdir(join(consumer, "node_modules", ...name.split("/")), { recursive: true });
  await f.edge(f.root, name, shared);
  const requireSource = createRequire(join(consumer, "index.cjs"));
  expect(requireSource(name)).toBe("ancestor-value");
  const requireSeed = await f.publish();
  expect(requireSeed("consumer")).toBe("ancestor-value");
});

test.each([false, true])("a cycle preserves package identities and terminates through a directory alias: %s", async (viaAlias) => {
  const f = await fixture(viaAlias);
  const a1 = await f.packageAt("a1", "a", "1", { b: "1" }, 'exports.id = "a1"; exports.next = () => require("b");');
  const b1 = await f.packageAt("b1", "b", "1", { a: "2" }, 'exports.id = "b1"; exports.next = () => require("a");');
  const a2 = await f.packageAt("a2", "a", "2", { b: "2" }, 'exports.id = "a2"; exports.next = () => require("b");');
  const b2 = await f.packageAt("b2", "b", "2", { a: "1" }, 'exports.id = "b2"; exports.next = () => require("a");');
  await writeFile(join(f.app, "package.json"), JSON.stringify({ dependencies: { a: "1" } }));
  await f.edge(f.app, "a", a1);
  await f.edge(a1, "b", b1);
  await f.edge(b1, "a", a2);
  await f.edge(a2, "b", b2);
  await f.edge(b2, "a", a1);
  const requireSeed = await f.publish();
  const first = requireSeed("a") as CycleModule;
  expect([first.id, first.next().id, first.next().next().id, first.next().next().next().id]).toEqual(["a1", "b1", "a2", "b2"]);
  expect(first.next().next().next().next()).toBe(first);
  expect(await readdir(join(f.published, "node_modules", ".nautilo-packages"))).toHaveLength(4);
  const actual = await realpath(join(f.published, "node_modules", "a"));
  const publishedRoot = await realpath(f.published);
  expect(actual.startsWith(publishedRoot + sep)).toBe(true);
});
