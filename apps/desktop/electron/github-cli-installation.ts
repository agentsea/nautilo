import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface GitHubCliInstallationInvocation {
  readonly executable: string;
  readonly executableDirectory: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Recheck immediately before invoking a process or releasing its result. */
  readonly isCurrent: () => boolean;
}

export interface GitHubCliInstallation {
  verify(signal?: AbortSignal): Promise<GitHubCliInstallationInvocation>;
  retire(): void;
}

const unavailable = (): Error => new Error("GITHUB_INSTALLATION_UNAVAILABLE");

function identity(info: Stats): string {
  return `${info.dev}:${info.ino}`;
}

export function githubCliInstallationPathModeAllowed(
  path: string,
  info: {
    readonly uid: number;
    readonly gid: number;
    readonly mode: number;
    readonly directory: boolean;
  },
  uid: number,
): boolean {
  if (info.uid !== 0 && info.uid !== uid) return false;
  if ((info.mode & 0o022) === 0) return true;
  if (info.directory && info.uid === 0 && (info.mode & 0o1000) !== 0) return true;
  // macOS administrators can already replace the running app. This exact
  // system-owned application ancestor is not an arbitrary group-write escape.
  return path === "/Applications" && info.directory && info.uid === 0 &&
    info.gid === 80 && (info.mode & 0o002) === 0;
}

function inspectExecutable(path: string): ReadonlyMap<string, string> {
  const identities = new Map<string, string>();
  for (let candidate = path; ; candidate = dirname(candidate)) {
    const info = lstatSync(candidate);
    const uid = process.getuid?.();
    if (
      uid === undefined || info.isSymbolicLink() ||
      !githubCliInstallationPathModeAllowed(candidate, {
        uid: info.uid,
        gid: info.gid,
        mode: info.mode,
        directory: info.isDirectory(),
      }, uid)
    ) {
      throw unavailable();
    }
    if (candidate === path && (!info.isFile() || info.nlink !== 1)) {
      throw unavailable();
    }
    identities.set(candidate, identity(info));
    if (candidate === dirname(candidate)) return identities;
  }
}

/**
 * Pins the bundled GitHub CLI executable while leaving native GitHub, Git,
 * credential-helper, SSH-agent, and configuration selection to the supplied
 * trusted user environment. No credential file or token is inspected here.
 */
export function createGitHubCliInstallation(options: {
  readonly executable: string;
  readonly executableSha256: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly isCurrent: () => boolean;
}): GitHubCliInstallation {
  if (!isAbsolute(options.executable) || !/^[a-f0-9]{64}$/.test(options.executableSha256)) {
    throw unavailable();
  }
  const environment = Object.freeze({ ...options.environment });
  let retired = false;
  let pinned: ReadonlyMap<string, string> | undefined;

  const inspect = (): { executable: string; identities: ReadonlyMap<string, string> } => {
    const executable = realpathSync(options.executable);
    if (executable !== options.executable) throw unavailable();
    const identities = inspectExecutable(executable);
    if (pinned && [...identities].some(([path, value]) => pinned!.get(path) !== value)) {
      throw unavailable();
    }
    const descriptor = openSync(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      if (
        (info.mode & 0o111) === 0 || identity(info) !== identities.get(executable) ||
        createHash("sha256").update(readFileSync(descriptor)).digest("hex") !== options.executableSha256
      ) {
        throw unavailable();
      }
    } finally {
      closeSync(descriptor);
    }
    return { executable, identities };
  };

  return {
    verify(signal) {
      return Promise.resolve().then(() => {
        signal?.throwIfAborted();
        if (retired || !options.isCurrent()) throw unavailable();
        try {
          const current = inspect();
          if (retired || signal?.aborted || !options.isCurrent()) throw unavailable();
          pinned = current.identities;
          const executableDirectory = dirname(current.executable);
          return Object.freeze({
            executable: current.executable,
            executableDirectory,
            cwd: executableDirectory,
            env: environment,
            isCurrent: () => !retired && !signal?.aborted && options.isCurrent(),
          });
        } catch {
          retired = true;
          throw unavailable();
        }
      });
    },
    retire() {
      retired = true;
    },
  };
}
