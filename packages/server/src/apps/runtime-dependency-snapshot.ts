import { cp, mkdir, readFile, realpath, stat, symlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { nodeModulesPackagePath, type LocalFileDependencySource } from "./app-registry";

interface RuntimeDependencies {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}
interface PackageNode {
  source: string;
  destination: string;
  dependencies: Map<string, PackageNode>;
}

async function installedDependency(root: string, name: string): Promise<string | null> {
  let directory = root;
  for (;;) {
    if (basename(directory) !== "node_modules") {
      const candidate = nodeModulesPackagePath(directory, name);
      try {
        // Reused installs can leave empty package directories behind. Node
        // continues searching ancestors; these are not package identities.
        if ((await stat(candidate)).isDirectory()
          && (await stat(join(candidate, "package.json"))).isFile()) return await realpath(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** Snapshot resolved package identities once, retaining their dependency edges. */
export async function snapshotRuntimeDependencies(
  sourceRoot: string,
  stagingRoot: string,
  publishedRoot: string,
  localDependencies: readonly LocalFileDependencySource[],
): Promise<void> {
  const overrides = new Map<string, string>();
  for (const dependency of localDependencies) {
    const installed = await installedDependency(sourceRoot, dependency.name);
    if (!installed) throw new Error("Missing installed runtime dependency " + dependency.name);
    overrides.set(installed, dependency.root);
  }
  const packages = new Map<string, PackageNode>();

  async function edges(installedRoot: string, manifestRoot: string): Promise<Map<string, PackageNode>> {
    const manifest = JSON.parse(await readFile(join(manifestRoot, "package.json"), "utf8")) as RuntimeDependencies;
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    const result = new Map<string, PackageNode>();
    for (const name of names) {
      const installed = await installedDependency(installedRoot, name);
      if (installed) {
        result.set(name, await packageNode(installed));
      } else if (Object.hasOwn(manifest.dependencies ?? {}, name) && !Object.hasOwn(manifest.optionalDependencies ?? {}, name)) {
        throw new Error("Missing installed runtime dependency " + name + "; run bun install --frozen-lockfile");
      }
    }
    return result;
  }

  async function packageNode(installed: string): Promise<PackageNode> {
    const existing = packages.get(installed);
    if (existing) return existing;
    const node: PackageNode = {
      source: overrides.get(installed) ?? installed,
      destination: join(stagingRoot, "node_modules", ".nautilo-packages", String(packages.size), "package"),
      dependencies: new Map(),
    };
    // Register before discovering edges: cycles refer to this same node.
    packages.set(installed, node);
    node.dependencies = await edges(installed, node.source);
    return node;
  }

  const rootDependencies = await edges(sourceRoot, sourceRoot);
  for (const node of packages.values()) {
    await mkdir(dirname(node.destination), { recursive: true });
    const excluded = join(node.source, "node_modules");
    await cp(node.source, node.destination, { recursive: true, dereference: true, errorOnExist: true, filter: path => path !== excluded });
  }

  async function linkDependencies(root: string, dependencies: ReadonlyMap<string, PackageNode>): Promise<void> {
    for (const [name, node] of dependencies) {
      const link = nodeModulesPackagePath(root, name);
      await mkdir(dirname(link), { recursive: true });
      // Windows junctions use absolute targets. Point them at the published
      // root so the staging-directory rename does not invalidate the graph.
      const target = process.platform === "win32"
        ? join(publishedRoot, relative(stagingRoot, node.destination))
        : relative(dirname(link), node.destination);
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    }
  }
  for (const node of packages.values()) await linkDependencies(node.destination, node.dependencies);
  await linkDependencies(stagingRoot, rootDependencies);
}
