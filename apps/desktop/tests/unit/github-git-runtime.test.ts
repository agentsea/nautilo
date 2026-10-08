import { afterEach, expect, test } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubGitRuntime, type GitRuntimeCommand } from "../../electron/github-git-runtime";
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "apple-git-runtime-")));
    roots.push(root);
    const git = join(root, "git"), execPath = join(root, "libexec");
    mkdirSync(execPath, { mode: 0o700 });
    const helper = join(execPath, "git-remote-http");
    for (const path of [git, helper]) {
        writeFileSync(path, "fixture executable");
        chmodSync(path, 0o700);
    }
    symlinkSync("git-remote-http", join(execPath, "git-remote-https"));
    let current = true;
    let writableRoots: readonly string[] = [];
    const commands: GitRuntimeCommand[] = [];
    const runtime = createGitHubGitRuntime({ timeoutMs: 1000, maxOutputBytes: 1024, authority: async () => ({ writableRoots, isCurrent: () => current }), run: command => {
            commands.push(command);
            if (command.executable === "/usr/bin/xcrun")
                return git;
            if (command.args[0] === "--exec-path")
                return execPath;
            return "";
        } });
    return { root, git, helper, execPath, runtime, commands, revoke: () => { current = false; }, roots: (value: readonly string[]) => { writableRoots = value; } };
}
test.skipIf(process.platform !== "darwin")("OS selection and Apple inline attestation use fixed tools and closed environment", async () => {
    const f = fixture();
    const invocation = await f.runtime.verify();
    expect(invocation.git).toBe(f.git);
    expect(invocation.httpsHelper).toBe(join(f.execPath, "git-remote-https"));
    expect(f.commands[0]?.executable).toBe("/usr/bin/xcrun");
    for (const command of f.commands) {
        expect(command.env["DEVELOPER_DIR"]).toBeUndefined();
        expect(command.env["GH_TOKEN"]).toBeUndefined();
    }
    const signatures = f.commands.filter(command => command.executable === "/usr/bin/codesign");
    expect(signatures.length).toBeGreaterThan(1);
    for (const command of signatures)
        expect(command.args[command.args.indexOf("-R") + 1]).toBe("=anchor apple");
    f.revoke();
    expect(invocation.isCurrent()).toBe(false);
    await rejects(f.runtime.verify());
});
test.skipIf(process.platform !== "darwin")("temporary writable overlap repairs but executable drift never repins", async () => {
    const f = fixture();
    await f.runtime.verify();
    f.roots([f.root]);
    await rejects(f.runtime.verify());
    f.roots([join(f.root, "missing", "child")]);
    await f.runtime.verify();
    writeFileSync(f.git, "different");
    await rejects(f.runtime.verify());
    writeFileSync(f.git, "fixture executable");
    await rejects(f.runtime.verify());
});
test.skipIf(process.platform !== "darwin")("changed helper target retires the admitted pair", async () => {
    const f = fixture();
    await f.runtime.verify();
    rmSync(join(f.execPath, "git-remote-https"));
    symlinkSync("../git", join(f.execPath, "git-remote-https"));
    await rejects(f.runtime.verify());
});
async function rejects(promise: Promise<unknown>): Promise<void> {
    try {
        await promise;
    }
    catch {
        expect(true).toBe(true);
        return;
    }
    throw new Error("Expected runtime to fail closed");
}
test.skipIf(process.platform !== "darwin")("a missing top-level sibling keeps its full basename during root admission", async () => {
    const f = fixture();
    const missing = `/x${f.root.split("/")[1]}`;
    expect(existsSync(missing)).toBe(false);
    f.roots([missing]);
    await f.runtime.verify();
});
