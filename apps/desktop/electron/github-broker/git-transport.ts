import { spawn } from "node:child_process";
import { type Stats, closeSync, constants, createReadStream, createWriteStream, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import type { GitNetworkContext, GitNetworkRemote, GitNetworkTransport } from "../../../../packages/sandbox/src/git-broker/network";
import { isGitHubBranchName, isGitHubRepositoryName } from "../../../../packages/types/src/github-broker";
import type { GitHubGitRuntime, GitHubGitRuntimeInvocation } from "../github-git-runtime";
import type { GitHubApiClient, GitHubGitCredentialProvider } from "./credentials";
/** Existing Desktop protected-storage authority, supplied by trusted main
 * composition. Permissions alone cannot establish this authority. */
export interface GitHubGitStorage {
    admit(signal?: AbortSignal): Promise<{
        readonly directory: string;
        readonly isCurrent: () => boolean;
    }>;
}
export interface GitTransportCommand {
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly descriptor?: number;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly isCurrent: () => boolean;
    readonly beforeSpawn?: () => boolean;
}
export interface GitTransportCommandResult {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly cleanupConfirmed: boolean;
    readonly spawned: boolean;
}
const unavailable = () => new Error("GITHUB_GIT_UNAVAILABLE");
const oid = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
function groupAbsent(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return false;
    }
    catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
}
async function execute(command: GitTransportCommand): Promise<GitTransportCommandResult> {
    if (!command.isCurrent() || command.signal?.aborted || (command.beforeSpawn && !command.beforeSpawn()))
        return { exitCode: null, stdout: "", cleanupConfirmed: true, spawned: false };
    if (!command.isCurrent() || command.signal?.aborted)
        return { exitCode: null, stdout: "", cleanupConfirmed: true, spawned: false };
    const child = spawn(command.executable, [...command.args], { cwd: command.cwd, env: command.env, detached: true,
        stdio: ["ignore", "pipe", "pipe", ...(command.descriptor === undefined ? [] : [command.descriptor])] });
    let output = Buffer.alloc(0), produced = 0, terminated = false, interrupted = false;
    const stop = () => {
        if (terminated)
            return;
        terminated = true;
        if (child.pid !== undefined) {
            try {
                process.kill(-child.pid, "SIGKILL");
            }
            catch { /* Close and absence proof remain authoritative. */ }
        }
    };
    const interrupt = () => { interrupted = true; stop(); };
    child.stdout!.on("data", (chunk: Buffer) => {
        produced += chunk.length;
        if (produced > command.maxOutputBytes)
            interrupt();
        else
            output = Buffer.concat([output, chunk]);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
        produced += chunk.length;
        if (produced > command.maxOutputBytes)
            interrupt();
    });
    child.once("exit", stop);
    command.signal?.addEventListener("abort", interrupt, { once: true });
    if (command.signal?.aborted)
        interrupt();
    const timer = setTimeout(interrupt, command.timeoutMs);
    timer.unref();
    try {
        return await new Promise(resolve => {
            // Spawn errors are followed by close. Never delete scratch on error alone.
            child.once("error", () => { });
            child.once("close", exitCode => resolve({ exitCode: interrupted ? null : exitCode,
                stdout: output.toString("utf8"), cleanupConfirmed: child.pid === undefined || groupAbsent(child.pid), spawned: child.pid !== undefined }));
        });
    }
    finally {
        clearTimeout(timer);
        command.signal?.removeEventListener("abort", interrupt);
        output.fill(0);
    }
}
/** Private adapter for this one broker operation. It is never installed in a
 * project, supplied to model Git, or exposed as a general credential helper.
 * Only the exact HTTPS GitHub repository can read the unlinked fd once. */
function adapter(repository: string): string {
    return `case "$1" in store|erase) exit 0 ;; get) ;; *) exit 1 ;; esac\nprotocol= host= path=\nwhile IFS= read -r line; do\n [ -n "$line" ] || break\n case "$line" in protocol=*) protocol=\${line#protocol=} ;; host=*) host=\${line#host=} ;; path=*) path=\${line#path=} ;; esac\ndone\n[ "$protocol" = https ] && [ "$host" = github.com ] && [ "$path" = ${quoted(`${repository}.git`)} ] || exit 1\nexec /bin/cat /dev/fd/3\n`;
}
export function createGitHubGitTransport(options: {
    readonly runtime: GitHubGitRuntime;
    readonly credentials: GitHubGitCredentialProvider;
    readonly storage: GitHubGitStorage;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly run?: (command: GitTransportCommand) => Promise<GitTransportCommandResult>;
}): GitNetworkTransport {
    if (![options.timeoutMs, options.maxOutputBytes].every(value => Number.isSafeInteger(value) && value > 0) || options.timeoutMs > 2147483647)
        throw unavailable();
    const run = options.run ?? execute;
    const check = (context: GitNetworkContext) => {
        if (context.signal?.aborted || !context.isCurrent())
            throw unavailable();
    };
    const identity = async (api: GitHubApiClient, repository: string) => {
        const user = await api.request("GET", "/user"), repo = await api.request("GET", `/repos/${repository}`);
        const account = object(user.data), resource = object(repo.data);
        if (user.status !== 200 || repo.status !== 200 || !positive(account?.["id"]) || typeof account["login"] !== "string"
            || !/^[A-Za-z0-9-]+$/.test(account["login"]) || !positive(resource?.["id"]) || typeof resource["full_name"] !== "string"
            || resource["full_name"].toLowerCase() !== repository.toLowerCase())
            throw unavailable();
        return { accountId: account["id"], accountLogin: account["login"], repositoryId: resource["id"] };
    };
    interface SessionPort {
        root: string;
        api: GitHubApiClient;
        assertCurrent: () => void;
        command: (args: readonly string[], authenticated?: boolean, beforeSpawn?: () => boolean) => Promise<GitTransportCommandResult>;
    }
    const session = async <T>(context: GitNetworkContext, repository: string, action: (port: SessionPort) => Promise<T>, stage?: (root: string, local: (args: readonly string[]) => Promise<GitTransportCommandResult>) => Promise<void>): Promise<T> => {
        check(context);
        if (!isGitHubRepositoryName(repository))
            throw unavailable();
        const storage = await options.storage.admit(context.signal);
        check(context);
        if (!storage.isCurrent() || realpathSync(storage.directory) !== storage.directory)
            throw unavailable();
        const info = lstatSync(storage.directory);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
            throw unavailable();
        const root = mkdtempSync(join(storage.directory, "github-git-"));
        let cleanupConfirmed = true;
        try {
            mkdirSync(join(root, "home"), { mode: 0o700 });
            mkdirSync(join(root, "template"), { mode: 0o700 });
            const local = async (args: readonly string[]) => {
                check(context);
                if (!cleanupConfirmed)
                    throw unavailable();
                const runtime = await options.runtime.verify(context.signal);
                const isCurrent = () => !context.signal?.aborted && context.isCurrent() && storage.isCurrent() && runtime.isCurrent();
                if (!isCurrent())
                    throw unavailable();
                const earlierCleanup = cleanupConfirmed;
                cleanupConfirmed = false;
                const result = await run({ executable: runtime.git, args: ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", ...args], cwd: root,
                    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_EXEC_PATH: runtime.execPath, GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" },
                    timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, ...(context.signal ? { signal: context.signal } : {}), isCurrent });
                cleanupConfirmed = earlierCleanup && result.cleanupConfirmed;
                if (!isCurrent() || result.exitCode !== 0 || !result.cleanupConfirmed)
                    throw unavailable();
                return result;
            };
            await stage?.(root, local);
            check(context);
            return await options.credentials.withGitClient(context.signal, async (credentials) => {
                let heldRuntime: GitHubGitRuntimeInvocation | undefined;
                let heldStorage = storage;
                const assertCurrent = () => {
                    check(context);
                    if (!storage.isCurrent() || !heldStorage.isCurrent() || !credentials.isCurrent() || (heldRuntime && !heldRuntime.isCurrent()))
                        throw unavailable();
                };
                const command = async (args: readonly string[], authenticated = false, beforeSpawn?: () => boolean) => {
                    check(context);
                    if (!cleanupConfirmed)
                        throw unavailable();
                    const runtime = await options.runtime.verify(context.signal);
                    const currentStorage = await options.storage.admit(context.signal);
                    heldRuntime = runtime;
                    heldStorage = currentStorage;
                    const isCurrent = () => context.isCurrent() && !context.signal?.aborted && storage.isCurrent()
                        && currentStorage.directory === storage.directory && currentStorage.isCurrent() && runtime.isCurrent() && credentials.isCurrent();
                    if (!isCurrent())
                        throw unavailable();
                    let descriptor: number | undefined;
                    const privateConfig = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "credential.useHttpPath=true",
                        "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false", "-c", "http.sslVerify=true", "-c", "http.proxy="];
                    try {
                        if (authenticated) {
                            const secret = join(root, "credential");
                            descriptor = openSync(secret, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                            unlinkSync(secret);
                            await credentials.writeCredential(descriptor);
                            if (!isCurrent())
                                throw unavailable();
                            const script = join(root, "credential-adapter");
                            writeFileSync(script, adapter(repository), { mode: 0o600, flag: "w" });
                            privateConfig.push("-c", `credential.https://github.com.helper=!/bin/sh ${quoted(script)}`);
                        }
                        const earlierCleanup = cleanupConfirmed;
                        cleanupConfirmed = false;
                        const result = await run({ executable: runtime.git, args: [...privateConfig, ...args], cwd: root,
                            env: { PATH: `${dirname(runtime.git)}:${runtime.execPath}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: "C", HOME: join(root, "home"),
                                XDG_CONFIG_HOME: join(root, "home"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_EXEC_PATH: runtime.execPath,
                                GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false", GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1" },
                            ...(descriptor === undefined ? {} : { descriptor }), ...(context.signal === undefined ? {} : { signal: context.signal }),
                            timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, isCurrent,
                            ...(beforeSpawn === undefined ? {} : { beforeSpawn }) });
                        cleanupConfirmed = earlierCleanup && result.cleanupConfirmed;
                        if (!isCurrent() || !result.cleanupConfirmed)
                            throw unavailable();
                        return result;
                    }
                    finally {
                        if (descriptor !== undefined)
                            closeSync(descriptor);
                    }
                };
                const runtime = await options.runtime.verify(context.signal);
                if (!runtime.isCurrent() || !storage.isCurrent())
                    throw unavailable();
                heldRuntime = runtime;
                const api: GitHubApiClient = { request: async (...args) => { assertCurrent(); const result = await credentials.api.request(...args); assertCurrent(); return result; } };
                return await action({ root, api, command, assertCurrent });
            });
        }
        finally {
            // Failed/unknown group cleanup leaves the protected scratch intact. A
            // caller must not treat that directory as released or erase under writers.
            if (cleanupConfirmed)
                rmSync(root, { recursive: true, force: true });
        }
    };
    const validateRemote = (remote: GitNetworkRemote) => {
        if (!isGitHubRepositoryName(remote.repository) || !isGitHubBranchName(remote.branch) || !positive(remote.repositoryId)
            || !positive(remote.accountId) || !/^[A-Za-z0-9-]+$/.test(remote.accountLogin) || (remote.oid !== null && !oid(remote.oid)))
            throw unavailable();
    };
    const destination = (repository: string) => `https://github.com/${repository}.git`;
    const advertised = async (port: SessionPort, branch: string, repository: string) => {
        const result = await port.command(["ls-remote", "--refs", "--", destination(repository), `refs/heads/${branch}`], true);
        if (result.exitCode !== 0 || !result.cleanupConfirmed)
            throw unavailable();
        if (result.stdout.trim() === "")
            return null;
        const lines = result.stdout.trim().split("\n");
        const match = /^([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(lines[0]!);
        if (lines.length !== 1 || !match || match[2] !== `refs/heads/${branch}`)
            throw unavailable();
        return match[1]!;
    };
    const verifyRemote = async (port: SessionPort, remote: GitNetworkRemote) => {
        const current = await identity(port.api, remote.repository);
        if (current.accountId !== remote.accountId || current.accountLogin !== remote.accountLogin || current.repositoryId !== remote.repositoryId
            || await advertised(port, remote.branch, remote.repository) !== remote.oid)
            throw unavailable();
    };
    const initialize = async (port: SessionPort, hash: string) => {
        const result = await port.command(["init", "--bare", `--object-format=${hash.length === 64 ? "sha256" : "sha1"}`, `--template=${join(port.root, "template")}`, join(port.root, "repo")]);
        if (result.exitCode !== 0 || !result.cleanupConfirmed)
            throw unavailable();
    };
    const repositoryCommand = (root: string) => [`--git-dir=${join(root, "repo")}`];
    return {
        inspect: provided => {
            const input = { ...provided };
            if (!isGitHubBranchName(input.branch))
                return Promise.reject(unavailable());
            return session(input, input.repository, async (port) => {
                const account = await identity(port.api, input.repository);
                const commit = await advertised(port, input.branch, input.repository);
                port.assertCurrent();
                return { repository: input.repository, branch: input.branch, oid: commit, ...account };
            });
        },
        withFetchedObjects: (provided, consume) => {
            const input = { ...provided, remote: { ...provided.remote } };
            validateRemote(input.remote);
            if (input.remote.oid === null)
                return Promise.reject(unavailable());
            return session(input, input.remote.repository, async (port) => {
                await verifyRemote(port, input.remote);
                await initialize(port, input.remote.oid!);
                const result = await port.command([...repositoryCommand(port.root), "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance",
                    "--", destination(input.remote.repository), `${input.remote.oid}:refs/heads/nautilo-source`], true);
                if (result.exitCode !== 0 || !result.cleanupConfirmed)
                    throw unavailable();
                const verified = await port.command([...repositoryCommand(port.root), "rev-parse", "--verify", "refs/heads/nautilo-source^{commit}"]);
                const checked = await port.command([...repositoryCommand(port.root), "fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"]);
                if (verified.stdout.trim() !== input.remote.oid || verified.exitCode !== 0 || checked.exitCode !== 0)
                    throw unavailable();
                const empty = await port.command([...repositoryCommand(port.root), "mktree"]);
                const emptyTreeOid = empty.stdout.trim();
                if (empty.exitCode !== 0 || !empty.cleanupConfirmed || !oid(emptyTreeOid)
                    || emptyTreeOid.length !== input.remote.oid.length) throw unavailable();
                port.assertCurrent();
                const resultValue = await consume(realpathSync(join(port.root, "repo", "objects")), Object.freeze({
                    gitDir: realpathSync(join(port.root, "repo")), objectFormat: input.remote.oid.length === 64 ? "sha256" as const : "sha1" as const,
                    emptyTreeOid,
                }));
                port.assertCurrent();
                return resultValue;
            });
        },
        async push(provided) {
            const input = { ...provided, remote: { ...provided.remote } };
            let sent = false;
            try {
                validateRemote(input.remote);
                if (!oid(input.sourceOid))
                    throw unavailable();
                return await session(input, input.remote.repository, async (port) => {
                    await verifyRemote(port, input.remote);
                    const verify = await port.command([...repositoryCommand(port.root), "rev-parse", "--verify", `${input.sourceOid}^{commit}`]);
                    const checked = await port.command([...repositoryCommand(port.root), "fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"]);
                    if (verify.exitCode !== 0 || verify.stdout.trim() !== input.sourceOid || checked.exitCode !== 0)
                        throw unavailable();
                    if (input.remote.oid !== null) {
                        const fetched = await port.command([...repositoryCommand(port.root), "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance", "--", destination(input.remote.repository), input.remote.oid], true);
                        if (fetched.exitCode !== 0)
                            throw unavailable();
                        const ancestor = await port.command([...repositoryCommand(port.root), "merge-base", "--is-ancestor", input.remote.oid, input.sourceOid]);
                        if (ancestor.exitCode !== 0)
                            throw unavailable();
                    }
                    const result = await port.command([...repositoryCommand(port.root), "push", "--porcelain", "--no-verify", "--recurse-submodules=no",
                        `--force-with-lease=refs/heads/${input.remote.branch}:${input.remote.oid ?? ""}`, "--", destination(input.remote.repository), `${input.sourceOid}:refs/heads/${input.remote.branch}`], true, () => {
                        if (!input.isCurrent() || input.signal?.aborted || !input.beforeSend())
                            return false;
                        sent = true;
                        return true;
                    });
                    return { outcome: sent && result.spawned && result.cleanupConfirmed && result.exitCode === 0 ? "pushed" as const : sent ? "unknown" as const : "rejected" as const, sent };
                }, async (root, local) => {
                    await local(["init", "--bare", `--object-format=${input.sourceOid.length === 64 ? "sha256" : "sha1"}`, `--template=${join(root, "template")}`, join(root, "repo")]);
                    await copyObjects(input.sourceObjectsPath, join(root, "repo", "objects"), input);
                    const verified = await local([...repositoryCommand(root), "rev-parse", "--verify", `${input.sourceOid}^{commit}`]);
                    if (verified.stdout.trim() !== input.sourceOid)
                        throw unavailable();
                    await local([...repositoryCommand(root), "fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"]);
                });
            }
            catch {
                return { outcome: sent ? "unknown" : "rejected", sent };
            }
        },
    };
}
/** Object bytes only; project metadata, hooks, config and alternates never
 * enter an authenticated Git child. Snapshot mutations invalidate the copy. */
async function copyObjects(source: string, destination: string, context: GitNetworkContext): Promise<void> {
    const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    const directory = lstatSync(source);
    if (realpathSync(source) !== source || !directory.isDirectory() || directory.isSymbolicLink())
        throw unavailable();
    const walk = async (directory: string, target: string, prefix = ""): Promise<void> => {
        if (context.signal?.aborted || !context.isCurrent())
            throw unavailable();
        const parent = lstatSync(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory)
            throw unavailable();
        for (const name of readdirSync(directory)) {
            const path = join(directory, name), relative = `${prefix}${name}`, before = lstatSync(path);
            if (before.isSymbolicLink())
                throw unavailable();
            if (before.isDirectory()) {
                const derivedDirectory = relative === "info/commit-graphs" || relative === "pack/multi-pack-index.d";
                if (!derivedDirectory && (prefix !== "" || (!/^[a-f0-9]{2}$/.test(name) && name !== "pack" && name !== "info")))
                    throw unavailable();
                mkdirSync(join(target, name), { recursive: true, mode: 0o700 });
                await walk(path, join(target, name), `${name}/`);
            }
            else {
                // Derived indexes are unnecessary in the private store. Validate
                // their filesystem identity but never parse/copy their contents.
                const ignored = ["info/packs", "info/commit-graph", "info/commit-graphs/commit-graph-chain", "pack/multi-pack-index", "pack/multi-pack-index.d/multi-pack-index-chain"].includes(relative)
                    || /^info\/commit-graphs\/graph-(?:[a-f0-9]{40}|[a-f0-9]{64})\.graph$/.test(relative)
                    || /^pack\/multi-pack-index(?:\.d\/multi-pack-index)?-(?:[a-f0-9]{40}|[a-f0-9]{64})\.(?:bitmap|midx|rev)$/.test(relative)
                    || /^pack\/pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.(?:keep|bitmap)$/.test(relative);
                if (!before.isFile() || before.nlink !== 1 || (!ignored && !(/^[a-f0-9]{2}\/(?:[a-f0-9]{38}|[a-f0-9]{62})$/.test(relative) || /^pack\/pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.(?:pack|idx|rev)$/.test(relative))))
                    throw unavailable();
                const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    if (!same(before, fstatSync(fd)) || realpathSync(directory) !== directory || !same(parent, lstatSync(directory)))
                        throw unavailable();
                    if (!ignored)
                        await pipeline(createReadStream(path, { fd, autoClose: false }), createWriteStream(join(target, name), { mode: 0o600, flags: "wx" }), ...(context.signal ? [{ signal: context.signal }] : []));
                    if (context.signal?.aborted || !context.isCurrent())
                        throw unavailable();
                    if (!same(before, fstatSync(fd)) || !same(before, lstatSync(path)))
                        throw unavailable();
                }
                finally {
                    closeSync(fd);
                }
            }
        }
        if (!same(parent, lstatSync(directory)) || realpathSync(directory) !== directory)
            throw unavailable();
    };
    await walk(source, destination);
}
