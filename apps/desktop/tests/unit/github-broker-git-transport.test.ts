import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
test.skipIf(process.platform !== "darwin")("Apple Git/helper can read synthetic credentials from an inherited unlinked descriptor", async () => {
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
    const selected = spawnSync("/usr/bin/xcrun", ["--find", "git"], { env, encoding: "utf8" });
    expect(selected.status).toBe(0);
    const git = realpathSync(selected.stdout.trim());
    const helper = spawnSync(git, ["--exec-path"], { env, encoding: "utf8" }).stdout.trim();
    const headers: string[] = [];
    const server = createServer((request, response) => {
        headers.push(request.headers.authorization ?? "");
        if (!request.headers.authorization) {
            response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' });
            response.end();
            return;
        }
        response.writeHead(200, { "Content-Type": "application/x-git-upload-pack-advertisement" });
        response.end("001e# service=git-upload-pack\n00000000");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Loopback fixture missing");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "github-git-descriptor-")));
    const config = join(root, "credential-config");
    mkdirSync(join(root, "home"));
    const synthetic = `Basic ${Buffer.from("x-access-token:synthetic-proof").toString("base64")}`;
    writeFileSync(config, "username=x-access-token\npassword=synthetic-proof\n\n", { mode: 0o600 });
    const adapter = join(root, "credential-adapter");
    writeFileSync(adapter, 'case "$1" in get) exec /bin/cat /dev/fd/3 ;; store|erase) exit 0 ;; *) exit 1 ;; esac\n', { mode: 0o600 });
    const descriptor = openSync(config, "r");
    unlinkSync(config);
    try {
        const argv = ["-c", "credential.helper=", "-c", `credential.helper=!/bin/sh '${adapter}'`, "ls-remote", `http://127.0.0.1:${address.port}/fixture.git`, "refs/heads/main"];
        const spawnEnv = { ...env, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_EXEC_PATH: helper, GIT_TERMINAL_PROMPT: "0" };
        const child = spawn(git, argv, { cwd: root, env: spawnEnv, stdio: ["ignore", "pipe", "pipe", descriptor] });
        let error = "";
        child.stderr!.on("data", chunk => { error += String(chunk); });
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        expect({ code, error }).toEqual({ code: 0, error: "" });
        expect(headers).toEqual(["", synthetic]);
        for (const forbidden of ["synthetic-proof", synthetic]) {
            expect(JSON.stringify({ argv, env: spawnEnv })).not.toContain(forbidden);
            expect(readFileSync(adapter, "utf8")).not.toContain(forbidden);
        }
        expect(() => readFileSync(config)).toThrow();
    }
    finally {
        closeSync(descriptor);
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});
import { afterEach } from "bun:test";
import { lstatSync, chmodSync, watch, writeSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { createGitHubGitTransport, type GitTransportCommand, type GitTransportCommandResult } from "../../electron/github-broker/git-transport";
const paths: string[] = [];
afterEach(() => {
    for (const path of paths.splice(0))
        rmSync(path, { recursive: true, force: true });
});
const sourceOid = "a".repeat(40), oldOid = "b".repeat(40);
async function transportFixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "typed-git-transport-")));
    paths.push(root);
    const storage = join(root, "protected"), source = join(root, "project-objects");
    mkdirSync(storage, { mode: 0o700 });
    mkdirSync(source, { mode: 0o700 });
    mkdirSync(join(source, "aa"));
    writeFileSync(join(source, "aa", "a".repeat(38)), "synthetic objects");
    let current = true, apiCalls = 0, custodyCalls = 0;
    const commands: GitTransportCommand[] = [];
    let intervene: (command: GitTransportCommand) => void = () => { };
    let uncertain: string | undefined;
    let advertisedOid = oldOid;
    const runtime = { verify: async () => ({ git: "/trusted/git", httpsHelper: "/trusted/libexec/git-remote-https", execPath: "/trusted/libexec", isCurrent: () => current }), retire: () => { current = false; } };
    const credentials = { withGitClient: async <T>(_signal: AbortSignal | undefined, action: (port: {
            api: {
                request: () => Promise<{
                    status: number;
                    data: unknown;
                }>;
            };
            writeCredential: (fd: number) => Promise<void>;
            isCurrent: () => boolean;
        }) => Promise<T>) => {
            custodyCalls++;
            return await action({ api: { request: async () => { apiCalls++; return { status: 200, data: apiCalls % 2 === 1 ? { id: 10, login: "fixture-user" } : { id: 20, full_name: "fixture-org/project" } }; } }, writeCredential: async (fd) => { writeSync(fd, Buffer.from("username=x-access-token\npassword=synthetic-proof\n\n"), 0, Buffer.byteLength("username=x-access-token\npassword=synthetic-proof\n\n"), 0); }, isCurrent: () => current });
        } };
    const run = async (command: GitTransportCommand): Promise<GitTransportCommandResult> => {
        commands.push(command);
        intervene(command);
        if (!command.isCurrent() || (command.beforeSpawn && !command.beforeSpawn()))
            return { exitCode: null, stdout: "", cleanupConfirmed: true, spawned: false };
        if (command.args.includes("init")) {
            mkdirSync(join(command.cwd, "repo", "objects"), { recursive: true });
        }
        let stdout = "";
        if (command.args.includes("ls-remote"))
            stdout = `${advertisedOid}\trefs/heads/main\n`;
        if (command.args.includes("rev-parse"))
            stdout = `${sourceOid}\n`;
        if (command.args.includes("mktree"))
            stdout = "4b825dc642cb6eb9a060e54bf8d69288fbee4904\n";
        return { exitCode: 0, stdout, cleanupConfirmed: !command.args.includes(uncertain ?? "not-a-command"), spawned: true };
    };
    const transport = createGitHubGitTransport({ runtime, credentials, storage: { admit: async () => ({ directory: storage, isCurrent: () => current }) }, timeoutMs: 1000, maxOutputBytes: 4096, run });
    return { root, storage, source, commands, transport, remote: { repository: "fixture-org/project", repositoryId: 20, accountId: 10, accountLogin: "fixture-user", branch: "main", oid: oldOid }, context: { isCurrent: () => current }, revoke: () => { current = false; }, intervene: (f: typeof intervene) => { intervene = f; }, uncertain: (name: string) => { uncertain = name; }, advertised: (value: string) => { advertisedOid = value; }, counts: () => ({ apiCalls, custodyCalls }) };
}
test("typed push snapshots objects before custody, verifies closure and ancestry, and consumes only at final send", async () => {
    const f = await transportFixture();
    let approvals = 0;
    f.intervene(command => {
        if (command.args.includes("fsck") && f.counts().custodyCalls === 0) {
            expect(f.counts().apiCalls).toBe(0);
            expect(command.descriptor).toBeUndefined();
        }
    });
    expect(await f.transport.push({ ...f.context, remote: f.remote, sourceObjectsPath: f.source, sourceOid, beforeSend: () => { approvals++; return true; } })).toEqual({ outcome: "pushed", sent: true });
    expect(approvals).toBe(1);
    const push = f.commands.find(command => command.args.includes("push"))!;
    expect(push.args).toContain(`--force-with-lease=refs/heads/main:${oldOid}`);
    expect(f.commands.some(command => command.args.includes("merge-base"))).toBe(true);
    for (const command of f.commands) {
        expect(JSON.stringify({ args: command.args, env: command.env })).not.toContain("synthetic-proof");
        expect(JSON.stringify(command.args)).not.toContain(f.source);
        expect(command.env["GH_TOKEN"]).toBeUndefined();
    }
    expect(readdirSync(f.storage)).toEqual([]);
});

test("fetched callback receives only readonly clean metadata and an existing empty tree, with callback lifetime", async () => {
    const f = await transportFixture();
    f.advertised(sourceOid);
    const result = await f.transport.withFetchedObjects({ ...f.context, remote: { ...f.remote, oid: sourceOid } }, async (objects, metadata) => {
        expect(metadata).toBeDefined();
        expect(Object.isFrozen(metadata)).toBe(true);
        expect(metadata?.objectFormat).toBe("sha1");
        expect(metadata?.emptyTreeOid).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
        expect(objects).toBe(join(metadata!.gitDir, "objects"));
        expect(Object.keys(metadata!).sort()).toEqual(["emptyTreeOid", "gitDir", "objectFormat"]);
        expect(existsSync(metadata!.gitDir)).toBe(true);
        return metadata!.gitDir;
    });
    expect(existsSync(result)).toBe(false);
    expect(f.commands.some(command => command.args.includes("mktree"))).toBe(true);
});
test("source alternates/symlinks are rejected before retrieving any credentials", async () => {
    const f = await transportFixture();
    mkdirSync(join(f.source, "info"));
    symlinkSync("/dev/null", join(f.source, "info", "alternates"));
    expect(await f.transport.push({ ...f.context, remote: f.remote, sourceObjectsPath: f.source, sourceOid, beforeSend: () => true })).toEqual({ outcome: "rejected", sent: false });
    expect(f.counts().custodyCalls).toBe(0);
});
test("uncertain verification cleanup blocks later commands and retains protected scratch", async () => {
    const f = await transportFixture();
    f.uncertain("fsck");
    let approvals = 0;
    expect(await f.transport.push({ ...f.context, remote: f.remote, sourceObjectsPath: f.source, sourceOid, beforeSend: () => { approvals++; return true; } })).toEqual({ outcome: "rejected", sent: false });
    expect(approvals).toBe(0);
    expect(f.counts().custodyCalls).toBe(0);
    expect(readdirSync(f.storage)).toHaveLength(1);
});
test("lost cleanup after consumed push is unknown and never retry-classified as unsent", async () => {
    const f = await transportFixture();
    f.uncertain("push");
    expect(await f.transport.push({ ...f.context, remote: f.remote, sourceObjectsPath: f.source, sourceOid, beforeSend: () => true })).toEqual({ outcome: "unknown", sent: true });
    expect(readdirSync(f.storage)).toHaveLength(1);
});
test("revocation or denied approval before push is rejected without consuming another effect", async () => {
    for (const revoke of [false, true]) {
        const f = await transportFixture();
        let approvals = 0;
        if (revoke)
            f.intervene(command => {
                if (command.args.includes("push"))
                    f.revoke();
            });
        expect(await f.transport.push({ ...f.context, remote: f.remote, sourceObjectsPath: f.source, sourceOid, beforeSend: () => { approvals++; return false; } })).toEqual({ outcome: "rejected", sent: false });
        expect(approvals).toBe(revoke ? 0 : 1);
    }
});
test("fetched objects are callback-local and removed after a current callback returns", async () => {
    const f = await transportFixture();
    f.advertised(sourceOid);
    let objects = "";
    const result = await f.transport.withFetchedObjects({ ...f.context, remote: { ...f.remote, oid: sourceOid } }, async (path) => { objects = path; expect(existsSync(path)).toBe(true); expect(path).not.toContain(f.source); return "consumed"; });
    expect(result).toBe("consumed");
    expect(existsSync(objects)).toBe(false);
    expect(existsSync(f.source)).toBe(true);
});
test("account/repo mismatch and post-callback source revocation never release fetched result", async () => {
    const f = await transportFixture();
    let called = false;
    await rejects(f.transport.withFetchedObjects({ ...f.context, remote: { ...f.remote, repositoryId: 21 } }, async () => { called = true; }));
    expect(called).toBe(false);
    expect(readdirSync(f.storage)).toEqual([]);
    f.advertised(sourceOid);
    await rejects(f.transport.withFetchedObjects({ ...f.context, remote: { ...f.remote, oid: sourceOid } }, async () => { f.revoke(); return "private result"; }));
    expect(readdirSync(f.storage)).toEqual([]);
});
async function rejects(promise: Promise<unknown>): Promise<void> {
    try {
        await promise;
    }
    catch {
        expect(true).toBe(true);
        return;
    }
    throw new Error("Expected operation to fail closed");
}
test.skipIf(process.platform !== "darwin")("real Apple Git clean-object push succeeds and exact lease preserves a concurrently replaced remote", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "typed-git-real-plumbing-")));
    paths.push(root);
    const closedEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
    const git = realpathSync(spawnSync("/usr/bin/xcrun", ["--find", "git"], { env: closedEnv, encoding: "utf8" }).stdout.trim());
    const execPath = spawnSync(git, ["--exec-path"], { env: closedEnv, encoding: "utf8" }).stdout.trim();
    const command = (args: string[], input?: string) => {
        const result = spawnSync(git, args, { env: closedEnv, cwd: root, encoding: "utf8", input });
        if (result.status !== 0)
            throw new Error("Synthetic Git fixture failed");
        return result.stdout.trim();
    };
    const source = join(root, "source.git"), remote = join(root, "remote.git"), storage = join(root, "protected");
    mkdirSync(storage, { mode: 0o700 });
    command(["init", "--bare", source]);
    command(["init", "--bare", remote]);
    const tree = command([`--git-dir=${source}`, "mktree"], "");
    const base = command([`--git-dir=${source}`, "commit-tree", tree], "base\n");
    const tip = command([`--git-dir=${source}`, "commit-tree", tree, "-p", base], "tip\n");
    const competitor = command([`--git-dir=${source}`, "commit-tree", tree, "-p", base], "competitor\n");
    command([`--git-dir=${source}`, "update-ref", "refs/heads/main", tip]);
    command([`--git-dir=${remote}`, "fetch", source, `${base}:refs/heads/main`, `${competitor}:refs/heads/competitor`]);
    command([`--git-dir=${source}`, "repack", "-a", "-d", "--write-bitmap-index"]);
    command([`--git-dir=${source}`, "commit-graph", "write", "--reachable"]);
    command([`--git-dir=${source}`, "multi-pack-index", "write", "--bitmap"]);
    expect(existsSync(join(source, "objects", "info", "commit-graph"))).toBe(true);
    expect(existsSync(join(source, "objects", "pack", "multi-pack-index"))).toBe(true);
    const marker = join(root, "project-code-executed"), hooks = join(source, "hostile-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\n/usr/bin/touch '${marker}'\n`, { mode: 0o700 });
    const included = join(source, "hostile-config");
    writeFileSync(included, `[credential]\n helper = !/usr/bin/touch '${marker}'\n[url "https://unapproved.example/"]\n insteadOf = https://github.com/\n`);
    writeFileSync(join(source, "config"), readFileSync(join(source, "config"), "utf8") + `\n[core]\n hooksPath = ${hooks}\n[include]\n path = ${included}\n`);
    let sends = 0;
    const transport = createGitHubGitTransport({ timeoutMs: 10000, maxOutputBytes: 1024 * 1024,
        runtime: { verify: async () => ({ git, execPath, httpsHelper: join(execPath, "git-remote-https"), isCurrent: () => true }), retire: () => { } },
        storage: { admit: async () => ({ directory: storage, isCurrent: () => true }) },
        credentials: { withGitClient: async (_signal, action) => await action({ api: { request: async (_method, path) => ({ status: 200, data: path === "/user" ? { id: 10, login: "fixture-user" } : { id: 20, full_name: "fixture-org/project" } }) }, writeCredential: async (fd) => { writeFileSync(fd, "username=x-access-token\npassword=synthetic-proof\n\n"); }, isCurrent: () => true }) },
        run: async (request) => {
            // Production still supplies HTTPS-only commands. This fixture alone maps
            // the exact closed destination to a freshly created local bare remote.
            const destination = "https://github.com/fixture-org/project.git";
            const args = request.args.map(value => value === destination ? remote : value);
            for (const value of request.args.filter(value => value.startsWith("https://")))
                expect(value).toBe(destination);
            if (request.beforeSpawn && !request.beforeSpawn())
                return { exitCode: null, stdout: "", cleanupConfirmed: true, spawned: false };
            const result = spawnSync(request.executable, ["-c", "protocol.file.allow=always", ...args], { cwd: request.cwd, env: request.env, encoding: "utf8", timeout: request.timeoutMs, maxBuffer: request.maxOutputBytes,
                stdio: ["ignore", "pipe", "pipe", request.descriptor ?? "ignore"] });
            return { exitCode: result.status, stdout: result.stdout ?? "", cleanupConfirmed: !result.error, spawned: true };
        } });
    const inspected = await transport.inspect({ repository: "fixture-org/project", branch: "main", isCurrent: () => true });
    expect(inspected.oid).toBe(base);
    expect(await transport.push({ remote: inspected, sourceObjectsPath: join(source, "objects"), sourceOid: tip, isCurrent: () => true, beforeSend: () => { sends++; return true; } })).toEqual({ outcome: "pushed", sent: true });
    expect(command([`--git-dir=${remote}`, "rev-parse", "refs/heads/main"])).toBe(tip);
    command([`--git-dir=${remote}`, "update-ref", "refs/heads/main", base]);
    const result = await transport.push({ remote: inspected, sourceObjectsPath: join(source, "objects"), sourceOid: tip, isCurrent: () => true, beforeSend: () => { sends++; command([`--git-dir=${remote}`, "update-ref", "refs/heads/main", competitor]); return true; } });
    expect(result.sent).toBe(true);
    expect(result.outcome).not.toBe("pushed");
    expect(command([`--git-dir=${remote}`, "rev-parse", "refs/heads/main"])).toBe(competitor);
    expect(sends).toBe(2);
    expect(readdirSync(storage)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
});
test("the production private adapter rejects mismatched protocol/host/repository before its only descriptor read", async () => {
    const f = await transportFixture();
    let checked = false;
    f.intervene(command => {
        if (checked || command.descriptor === undefined)
            return;
        checked = true;
        const config = command.args.find(value => value.startsWith("credential.https://github.com.helper="))!;
        const script = /!\/bin\/sh '([^']+)'/.exec(config)![1]!;
        const run = (input: string) => spawnSync("/bin/sh", [script, "get"], { env: { PATH: "/usr/bin:/bin" }, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe", command.descriptor!] });
        for (const scope of ["protocol=http\nhost=github.com\npath=fixture-org/project.git\n\n", "protocol=https\nhost=other.example\npath=fixture-org/project.git\n\n", "protocol=https\nhost=github.com\npath=fixture-org/other.git\n\n"]) {
            const result = run(scope);
            expect(result.status).toBe(1);
            expect(result.stdout).toBe("");
        }
        const result = run("protocol=https\nhost=github.com\npath=fixture-org/project.git\n\n");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("username=x-access-token\npassword=synthetic-proof\n\n");
    });
    await f.transport.inspect({ ...f.context, repository: f.remote.repository, branch: f.remote.branch });
    expect(checked).toBe(true);
});
function fixtureChildPid(receipt: string): number | undefined {
    if (!/^[1-9][0-9]*$/.test(receipt)) return undefined;
    const pid = Number(receipt);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}
function isFixtureZombie(pid: number, processStat: string): boolean {
    // Linux retains a killed orphan's PID until its reaper waits for it. Only
    // the exact PID's kernel state Z proves it can no longer execute; stopped,
    // sleeping, running, malformed and unavailable observations prove nothing.
    const matched = /^([1-9][0-9]*) \([^\n]*\) Z [0-9]+ [0-9]+ [0-9]+ (?:-?[0-9]+(?: |\n|$))+$/.exec(processStat);
    return matched?.[1] === String(pid);
}
function observeFixtureChild(pid: number): { absent: boolean; zombie: boolean; processStat?: string } {
    let absent = false;
    try {
        process.kill(pid, 0);
    }
    catch (error) {
        absent = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    let zombie = false;
    let processStat: string | undefined;
    if (!absent && process.platform === "linux") {
        try {
            processStat = readFileSync(`/proc/${pid}/stat`, "utf8");
            zombie = isFixtureZombie(pid, processStat);
        }
        catch {
            // The child may be reaped between the two observations. Require
            // ESRCH rather than treating a failed read as proof.
            try { process.kill(pid, 0); }
            catch (error) { absent = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }
    }
    return { absent, zombie, processStat };
}
async function eventuallySettledFixtureChild(pid: number, initial: ReturnType<typeof observeFixtureChild>): Promise<ReturnType<typeof observeFixtureChild>> {
    let observation = initial;
    for (let attempt = 0; attempt < 50 && !observation.absent && !observation.zombie; attempt++) {
        await Bun.sleep(10);
        observation = observeFixtureChild(pid);
    }
    return observation;
}
function stopFixtureChild(pid: number | undefined, program: string): boolean {
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return false;
    const inspected = spawnSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
        env: { PATH: "/usr/bin:/bin", LANG: "C" }, encoding: "utf8",
    });
    if (inspected.status !== 0 || inspected.stdout.trim() !== `/bin/sh ${program}`) return false;
    try { process.kill(pid, "SIGTERM"); return true; }
    catch { return false; }
}
test("fixture cleanup rejects malformed process receipts and never signals a non-fixture process", () => {
    for (const receipt of ["", "0", "1", "-1", "NaN", "12\n34", "9007199254740992"]) {
        expect(fixtureChildPid(receipt)).toBeUndefined();
        expect(stopFixtureChild(fixtureChildPid(receipt), "/nonexistent-fixture-child")).toBe(false);
    }
    expect(stopFixtureChild(process.pid, "/nonexistent-fixture-child")).toBe(false);
});
test("fixture zombie proof requires the exact PID and positive kernel zombie state", () => {
    const zombie = "42 (sh) Z 1 41 41 0 -1 0 0\n";
    expect(isFixtureZombie(42, zombie)).toBe(true);
    expect(isFixtureZombie(43, zombie)).toBe(false);
    for (const state of ["R", "S", "D", "T", "t", "X", "I"]) {
        expect(isFixtureZombie(42, zombie.replace(") Z ", `) ${state} `))).toBe(false);
    }
    for (const invalid of ["", "42 (sh) Z", "42 (Z) S 1 41 41 0 -1 0 0\n", "42 (sh) Z bogus 41 41 0", "42 (sh) Z 1 41 41 0\nforged"]) {
        expect(isFixtureZombie(42, invalid)).toBe(false);
    }
});
for (const termination of ["abort", "timeout", "leader-exit"] as const)
    test(`default executor ${termination} settles a pipe-holding child before releasing protected scratch or acquiring credentials`, async () => {
        const f = await transportFixture();
        const executable = join(f.root, "fixture-git"), childFile = join(f.root, "child-pid"), childProgram = join(f.root, "fixture-child");
        writeFileSync(childProgram, '#!/bin/sh\n/bin/sleep 30 &\nsleeper=$!\ntrap \'kill "$sleeper" 2>/dev/null; exit\' TERM INT\nwait "$sleeper"\n', { mode: 0o700 });
        // Each invocation publishes a complete receipt atomically. A second
        // private Git command cannot expose an empty, truncated PID as zero.
        writeFileSync(executable, `#!/bin/sh\n/bin/sh '${childProgram}' &\nreceipt='${childFile}'.$$\nprintf '%s' "$!" > "$receipt"\n/bin/mv "$receipt" '${childFile}'\n${termination === "leader-exit" ? "exit 0" : "wait"}\n`, { mode: 0o700 });
        chmodSync(executable, 0o700);
        const abort = new AbortController();
        let credentials = 0;
        let childPid: number | undefined;
        const transport = createGitHubGitTransport({ runtime: { verify: async () => ({ git: executable, httpsHelper: executable, execPath: f.root, isCurrent: () => true }), retire: () => { } },
            credentials: { withGitClient: async () => { credentials++; throw new Error("Unexpected custody"); } }, storage: { admit: async () => ({ directory: f.storage, isCurrent: () => true }) }, timeoutMs: termination === "timeout" ? 5000 : 15000, maxOutputBytes: 4096 });
        let changed!: () => void;
        const started = new Promise<void>(resolve => { changed = resolve; });
        const observer = watch(f.root, () => {
            if (existsSync(childFile) && readFileSync(childFile, "utf8").length > 0)
                changed();
        });
        try {
            const pending = transport.push({ ...f.context, signal: abort.signal, remote: f.remote, sourceObjectsPath: f.source, sourceOid, beforeSend: () => true });
            await Promise.race([started, pending.then(() => { })]);
            expect(existsSync(childFile)).toBe(true);
            childPid = fixtureChildPid(readFileSync(childFile, "utf8"));
            expect(childPid).toBeDefined();
            if (childPid === undefined) throw new Error("Fixture child did not publish a valid owned PID");
            if (termination === "abort")
                abort.abort();
            expect(await pending).toEqual({ outcome: "rejected", sent: false });
            expect(credentials).toBe(0);
            // Snapshot the production cleanup decision at the return boundary.
            // A later kernel observation must never upgrade this authority.
            const retainedAtReturn = readdirSync(f.storage);
            expect(retainedAtReturn.length).toBeLessThanOrEqual(1);
            for (const name of retainedAtReturn) {
                expect(name.startsWith("github-git-")).toBe(true);
                const info = lstatSync(join(f.storage, name));
                expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
                expect(info.mode & 0o077).toBe(0);
            }
            const initial = observeFixtureChild(childPid);
            if (!initial.absent && !initial.zombie)
                expect(retainedAtReturn).toHaveLength(1);
            const { absent, zombie, processStat } = await eventuallySettledFixtureChild(childPid, initial);
            if (!absent && !zombie) {
                // Report only this synthetic child's numeric kernel coordinates,
                // never its command line, environment, or fixture filesystem path.
                const fields = /^([1-9][0-9]*) \([^\n]*\) ([A-Za-z]) ([0-9]+) ([0-9]+) ([0-9]+) /.exec(processStat ?? "");
                console.error("Fixture child cleanup observation", {
                    platform: process.platform, termination, childPid,
                    observedPid: fields?.[1] ?? null, state: fields?.[2] ?? null,
                    parentPid: fields?.[3] ?? null, processGroup: fields?.[4] ?? null,
                    sessionId: fields?.[5] ?? null, absent, zombie, credentials,
                    scratchCountAtReturn: retainedAtReturn.length,
                    // The private executor result is not exposed here. Removal
                    // is observable only after its cleanupConfirmed guard wins.
                    cleanupConfirmedAtReturnByScratchRemoval: retainedAtReturn.length === 0,
                });
            }
            expect({ absent, zombie }).not.toEqual({ absent: false, zombie: false });
            // A zombie proves no executable child remains, but is deliberately
            // NOT group-absence proof. Production must retain protected scratch.
            // A later child absence probe cannot upgrade an inconclusive
            // close-boundary group probe. Either proven cleanup or protected
            // retained scratch is truthful; never force removal from this test.
            if (zombie) expect(retainedAtReturn).toHaveLength(1);
        }
        finally {
            observer.close();
            abort.abort();
            stopFixtureChild(childPid, childProgram);
        }
    }, 20000);
test("a multi-chunk object copy retains exact bytes without reopening source paths", async () => {
    const f = await transportFixture();
    const bytes = Buffer.alloc(1024 * 1024 + 17, 0x5a);
    writeFileSync(join(f.source, "aa", "a".repeat(38)), bytes);
    let verified = false;
    f.intervene(command => { if (command.args.includes("fsck") && f.counts().custodyCalls === 0) {
        expect(readFileSync(join(command.cwd, "repo", "objects", "aa", "a".repeat(38)))).toEqual(bytes);
        verified = true;
    } });
    expect(await f.transport.push({ ...f.context, remote: f.remote, sourceObjectsPath: f.source, sourceOid, beforeSend: () => true })).toEqual({ outcome: "pushed", sent: true });
    expect(verified).toBe(true);
});
