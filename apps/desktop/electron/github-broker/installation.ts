import { createHash } from "node:crypto";
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Captured by the existing Desktop session/grant owner, never by model arguments. */
export interface GitHubInstallationAuthority {
  readonly writableRoots: readonly string[];
  readonly isCurrent: () => boolean;
}
export interface GitHubInstallationInvocation {
  readonly executable: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Recheck immediately before invoking a process or releasing its result. */
  readonly isCurrent: () => boolean;
}
export interface GitHubInstallation {
  verify(signal?: AbortSignal): Promise<GitHubInstallationInvocation>;
  retire(): void;
}

const unavailable = (): Error => new Error("GITHUB_INSTALLATION_UNAVAILABLE");
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
function contains(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    result.push(current);
    if (current === dirname(current)) return result;
  }
}
function canonicalExistingParent(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    const parent = dirname(path);
    if (!missing(error) || parent === path) throw unavailable();
    return join(canonicalExistingParent(parent), path.slice(parent.length + (parent === sep ? 0 : 1)));
  }
}
function identity(info: Stats): string {
  return `${info.dev}:${info.ino}`;
}
export function githubInstallationPathModeAllowed(path: string, info: { readonly uid: number; readonly gid: number; readonly mode: number; readonly directory: boolean }, uid: number): boolean {
  if (info.uid !== 0 && info.uid !== uid) return false;
  if ((info.mode & 0o022) === 0) return true;
  if (info.directory && info.uid === 0 && (info.mode & 0o1000) !== 0) return true;
  // macOS administrators can already replace the running app. This exact
  // system-owned application ancestor is not an arbitrary group-write escape.
  return path === "/Applications" && info.directory && info.uid === 0 && info.gid === 80 && (info.mode & 0o002) === 0;
}
function checkOwnership(path: string, info: Stats): void {
  const uid = process.getuid?.();
  if (uid === undefined || !githubInstallationPathModeAllowed(path,
    { uid: info.uid, gid: info.gid, mode: info.mode, directory: info.isDirectory() }, uid)) throw unavailable();
}
function inspectPath(path: string, allowMissing: boolean, file: boolean): Map<string, string> {
  const identities = new Map<string, string>();
  for (const candidate of ancestors(path).reverse()) {
    let info: Stats;
    try { info = lstatSync(candidate); }
    catch (error) { if (allowMissing && missing(error)) continue; throw unavailable(); }
    if (info.isSymbolicLink()) throw unavailable();
    checkOwnership(candidate, info);
    if (candidate === path && file) {
      if (!info.isFile() || info.nlink !== 1) throw unavailable();
    } else if (!info.isDirectory()) throw unavailable();
    identities.set(candidate, identity(info));
  }
  return identities;
}
function inspectConfig(home: string): void {
  const config = join(home, ".config", "gh");
  inspectPath(config, true, false);
  for (const name of ["hosts.yml", "config.yml"]) inspectPath(join(config, name), true, true);
}


/**
 * Pins a trusted runtime identity, rather than promoting arbitrary PATH bytes.
 * The resolver must supply its independently admitted digest. There is no
 * automatic repin: replacement retires this handle and its parked operations.
 * This protects against contained writers; arbitrary same-OS-user processes
 * remain outside the Desktop sandbox trust boundary.
 */
export function createGitHubInstallation(options: {
  readonly executable: string;
  readonly executableSha256: string;
  readonly homeDir: string;
  readonly authority: () => Promise<GitHubInstallationAuthority>;
}): GitHubInstallation {
  if (![options.executable, options.homeDir].every(isAbsolute) || !/^[a-f0-9]{64}$/.test(options.executableSha256)) throw unavailable();
  let retired = false;
  let pinned: ReadonlyMap<string, string> | undefined;
  const inspect = (): { executable: string; home: string; identities: Map<string, string> } => {
    const executable = realpathSync(options.executable);
    const home = realpathSync(options.homeDir);
    if (executable !== options.executable) throw unavailable();
    const identities = inspectPath(executable, false, true);
    if (pinned && [...identities].some(([path, value]) => pinned!.get(path) !== value)) throw unavailable();
    const descriptor = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      if ((info.mode & 0o111) === 0 || identity(info) !== identities.get(executable)
        || createHash("sha256").update(readFileSync(descriptor)).digest("hex") !== options.executableSha256) throw unavailable();
    } finally { closeSync(descriptor); }
    for (const [path, value] of inspectPath(home, false, false)) {
      if (pinned?.has(path) && pinned.get(path) !== value) throw unavailable();
      identities.set(path, value);
    }
    return { executable, home, identities };
  };
  return {
    async verify(signal) {
      signal?.throwIfAborted();
      if (retired) throw unavailable();
      try {
        const authority = await options.authority();
        if (retired || signal?.aborted || !authority.isCurrent()) throw unavailable();
        let current: ReturnType<typeof inspect>;
        try { current = inspect(); }
        catch { retired = true; throw unavailable(); }
        inspectConfig(current.home);
        const protectedNames = [...ancestors(current.executable), ...ancestors(join(current.home, ".config", "gh"))];
        for (const root of authority.writableRoots) {
          if (!isAbsolute(root)) throw unavailable();
          let canonical: string;
          try { canonical = canonicalExistingParent(root); }
          catch { throw unavailable(); }
          if (protectedNames.some(candidate => contains(root, candidate) || contains(canonical, candidate))) throw unavailable();
        }
        if (!authority.isCurrent()) throw unavailable();
        pinned = current.identities;
        return Object.freeze({
          executable: current.executable,
          cwd: dirname(current.executable),
          env: Object.freeze({ HOME: current.home, GH_CONFIG_DIR: join(current.home, ".config", "gh"), GH_HOST: "github.com",
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1" }),
          isCurrent: () => !retired && !signal?.aborted && authority.isCurrent(),
        });
      } catch { throw unavailable(); }
    },
    retire() { retired = true; },
  };
}
