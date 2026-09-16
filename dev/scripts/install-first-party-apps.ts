import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const FIRST_PARTY_APPS_ROOT = join(import.meta.dirname, "..", "..", "packages", "first-party-apps");
export const FIRST_PARTY_APP_INSTALL_ARGS = [
  "install",
  "--frozen-lockfile",
  "--production",
  "--omit=peer",
] as const;
const RUNTIME_DEP_SECTIONS = ["dependencies", "optionalDependencies"] as const;

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function declaresRuntimeDependencies(pkg: PackageJson): boolean {
  return RUNTIME_DEP_SECTIONS.some((section) => {
    const deps = pkg[section];
    return deps !== undefined && Object.keys(deps).length > 0;
  });
}

async function packageJsonPathForApp(appDir: string): Promise<string | null> {
  const path = join(appDir, "package.json");
  try {
    const st = await stat(path);
    return st.isFile() ? path : null;
  } catch {
    return null;
  }
}

type InstallResult = { status: number | null };
type InstallRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: "inherit" },
) => InstallResult;

export async function installFirstPartyApps(options?: {
  appsRoot?: string;
  runInstall?: InstallRunner;
}): Promise<number> {
  const appsRoot = options?.appsRoot ?? FIRST_PARTY_APPS_ROOT;
  const runInstall = options?.runInstall ?? spawnSync;
  const entries = await readdir(appsRoot, { withFileTypes: true }).catch(() => []);
  const appDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appsRoot, entry.name))
    .sort();

  for (const appDir of appDirs) {
    const packageJsonPath = await packageJsonPathForApp(appDir);
    if (!packageJsonPath) continue;
    const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
    if (!declaresRuntimeDependencies(pkg)) continue;

    const label = pkg.name ?? appDir;
    console.log(`[first-party-apps:install] installing production dependencies for ${label}`);
    const result = runInstall("bun", FIRST_PARTY_APP_INSTALL_ARGS, {
      cwd: appDir,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }

  return 0;
}

if (import.meta.main) {
  const status = await installFirstPartyApps();
  if (status !== 0) process.exit(status);
}
