import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface HookInstallDependencies {
  configuredHooksPath(): string | null;
  installLefthook(): void;
  announce(message: string): void;
}

/** Preserve explicit hook ownership; installing dependencies must not replace another manager. */
export function installGitHooks(cwd: string, dependencies: HookInstallDependencies): void {
  const configured = dependencies.configuredHooksPath();
  if (configured === null) {
    dependencies.installLefthook();
    return;
  }
  if (!configured.trim()) throw new Error("Configured Git hooks path is empty; repair hook setup before installing dependencies.");
  const directory = isAbsolute(configured) ? configured : resolve(cwd, configured);
  // These hooks carry this repository's commit and push checks. Symlinked hooks
  // are valid, but dangling links, directories and non-executable files are not.
  for (const name of ["pre-commit", "pre-push"]) {
    try {
      const hook = realpathSync(resolve(directory, name));
      if (!statSync(hook).isFile()) throw new Error("not a regular hook");
      accessSync(hook, constants.X_OK);
    } catch {
      throw new Error(`Configured Git hooks are missing an executable ${name}; repair hook setup before installing dependencies.`);
    }
  }
  dependencies.announce("[setup] Preserving configured executable Git hooks; dependency setup continues. Commit and push checks remain enabled.");
}

if (import.meta.main) {
  try {
    installGitHooks(process.cwd(), {
      configuredHooksPath() {
        const result = spawnSync("git", ["config", "--path", "--get", "core.hooksPath"], { encoding: "utf8" });
        if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error("Cannot inspect Git hook configuration.");
        return result.status === 1 ? null : result.stdout.trim();
      },
      installLefthook() {
        const result = spawnSync("lefthook", ["install"], { stdio: "inherit" });
        if (result.error || result.status !== 0) throw new Error("Git hook installation failed.");
      },
      announce: console.log,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Git hook setup failed.");
    process.exitCode = 1;
  }
}
