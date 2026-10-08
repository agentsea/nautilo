import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { githubInstallationPathModeAllowed, type GitHubInstallationAuthority } from "./github-broker/installation";
export interface GitHubGitRuntimeInvocation {
    readonly git: string;
    readonly httpsHelper: string;
    readonly execPath: string;
    readonly isCurrent: () => boolean;
}
export interface GitHubGitRuntime {
    verify(signal?: AbortSignal): Promise<GitHubGitRuntimeInvocation>;
    retire(): void;
}
export interface GitRuntimeCommand {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
}
const env = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const unavailable = () => new Error("GITHUB_GIT_RUNTIME_UNAVAILABLE");
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
function canonicalRoot(path: string): string {
    try {
        return realpathSync(path);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path)
            throw error;
        return join(canonicalRoot(dirname(path)), basename(path));
    }
}
function contains(root: string, path: string): boolean {
    const suffix = relative(root, path);
    return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
function execute(input: GitRuntimeCommand): string {
    const result = spawnSync(input.executable, [...input.args], { env: input.env, encoding: "utf8", timeout: input.timeoutMs, maxBuffer: input.maxOutputBytes });
    if (result.error || result.status !== 0)
        throw unavailable();
    return result.stdout;
}
/** xcrun selects the OS developer installation. Neither PATH nor
 * DEVELOPER_DIR can select credential-bearing Git or its HTTPS helper. */
export function createGitHubGitRuntime(options: {
    readonly authority: () => Promise<GitHubInstallationAuthority>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly run?: (input: GitRuntimeCommand) => string;
}): GitHubGitRuntime {
    if (![options.timeoutMs, options.maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0) || options.timeoutMs > 2147483647)
        throw unavailable();
    const run = (executable: string, args: readonly string[]) => (options.run ?? execute)({ executable, args, env, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes });
    let retired = false;
    let pinned: {
        git: string;
        httpsHelper: string;
        execPath: string;
        identities: string;
    } | undefined;
    const inspect = (git: string, execPath: string): string => {
        const helper = join(execPath, "git-remote-https");
        if (!isAbsolute(git) || !isAbsolute(execPath) || realpathSync(git) !== git || realpathSync(execPath) !== execPath)
            throw unavailable();
        const link = lstatSync(helper);
        if (link.isSymbolicLink() && readlinkSync(helper) !== "git-remote-http")
            throw unavailable();
        const canonicalHelper = realpathSync(helper);
        if (canonicalHelper !== helper && canonicalHelper !== join(execPath, "git-remote-http"))
            throw unavailable();
        const fingerprints = new Map<string, string>();
        for (const file of [git, canonicalHelper]) {
            const info = lstatSync(file);
            if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0)
                throw unavailable();
            for (let path = file;; path = dirname(path)) {
                const item = lstatSync(path);
                const uid = process.getuid?.();
                if (uid === undefined || item.isSymbolicLink() || !githubInstallationPathModeAllowed(path, { uid: item.uid, gid: item.gid, mode: item.mode, directory: item.isDirectory() }, uid))
                    throw unavailable();
                fingerprints.set(path, `${item.dev}:${item.ino}:${item.mode}`);
                if (dirname(path) === path)
                    break;
            }
            run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R", "=anchor apple", file]);
            fingerprints.set(`${file}:hash`, digest(file));
        }
        fingerprints.set(helper, `${link.dev}:${link.ino}:${link.mode}:${canonicalHelper}`);
        return JSON.stringify([...fingerprints]);
    };
    return {
        async verify(signal) {
            signal?.throwIfAborted();
            if (retired || process.platform !== "darwin")
                throw unavailable();
            const authority = await options.authority();
            if (retired || signal?.aborted || !authority.isCurrent())
                throw unavailable();
            try {
                const git = pinned?.git ?? run("/usr/bin/xcrun", ["--find", "git"]).trim();
                if (!isAbsolute(git) || realpathSync(git) !== git)
                    throw unavailable();
                // Attest Git before asking that executable for its fixed helper path.
                run("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", "-R", "=anchor apple", git]);
                const execPath = pinned?.execPath ?? run(git, ["--exec-path"]).trim();
                const identities = inspect(git, execPath);
                if (pinned && identities !== pinned.identities) {
                    retired = true;
                    throw unavailable();
                }
                for (const root of authority.writableRoots) {
                    if (!isAbsolute(root))
                        throw unavailable();
                    for (const file of [git, realpathSync(join(execPath, "git-remote-https"))]) {
                        for (let path = file;; path = dirname(path)) {
                            if (contains(root, path) || contains(canonicalRoot(root), path))
                                throw new Error("GITHUB_GIT_ROOT_OVERLAP");
                            if (dirname(path) === path)
                                break;
                        }
                    }
                }
                if (!authority.isCurrent() || retired || signal?.aborted)
                    throw new Error("GITHUB_GIT_AUTHORITY_CHANGED");
                pinned ??= { git, execPath, httpsHelper: join(execPath, "git-remote-https"), identities };
                return Object.freeze({ git, execPath, httpsHelper: pinned.httpsHelper, isCurrent: () => !retired && !signal?.aborted && authority.isCurrent() });
            }
            catch (error) {
                if (pinned && !(error instanceof Error && ["GITHUB_GIT_ROOT_OVERLAP", "GITHUB_GIT_AUTHORITY_CHANGED"].includes(error.message)))
                    retired = true;
                throw unavailable();
            }
        },
        retire() { retired = true; },
    };
}
