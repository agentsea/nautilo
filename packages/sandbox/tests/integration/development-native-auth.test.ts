import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSandboxExec } from "../../src/seatbelt";

const systemTools = ["/usr/bin/sandbox-exec", "/usr/bin/git", "/usr/bin/ssh-keygen", "/usr/bin/ssh-agent", "/usr/bin/ssh-add"];
const native = process.platform === "darwin" && systemTools.every(tool => existsSync(tool)) ? test : test.skip;

native("Development preserves synthetic native Git credential helpers and an owned SSH agent", () => {
  const root = realpathSync(mkdtempSync("/tmp/nautilo-native-auth-"));
  const home = join(root, "home");
  const workspace = join(root, "project");
  const dataDir = join(root, "private-state");
  const sshDirectory = join(home, ".ssh");
  const agentDirectory = join(root, "agent");
  const socket = join(agentDirectory, "agent.sock");
  const privateKey = join(sshDirectory, "fixture-key");
  let agentPid: number | undefined;
  try {
    for (const directory of [home, workspace, dataDir, sshDirectory, agentDirectory]) mkdirSync(directory, { recursive: true });
    const credentials = join(home, ".git-credentials");
    writeFileSync(credentials, "https://synthetic-user:synthetic-pass@example.invalid\n", { mode: 0o600 });
    writeFileSync(join(home, ".gitconfig"), `[credential]\n\thelper = store --file ${credentials}\n`, { mode: 0o600 });

    const generated = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "synthetic-native-auth", "-f", privateKey], {
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 15_000,
    });
    expect(generated.status).toBe(0);
    chmodSync(privateKey, 0o600);

    const started = spawnSync("/usr/bin/ssh-agent", ["-s", "-a", socket], {
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 15_000,
    });
    expect(started.status).toBe(0);
    const pidMatch = started.stdout.match(/SSH_AGENT_PID=(\d+)/);
    expect(pidMatch).not.toBeNull();
    agentPid = Number(pidMatch![1]);
    const nativeEnvironment = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SSH_AUTH_SOCK: socket,
      TMPDIR: "/tmp", LANG: "en_US.UTF-8" };
    const added = spawnSync("/usr/bin/ssh-add", [privateKey], { env: nativeEnvironment, encoding: "utf8", timeout: 15_000 });
    expect(added.status).toBe(0);

    const run = (command: string) => {
      const wrapped = buildSandboxExec({ workspace, dataDir, toolsBin: "/usr/bin",
        config: { mode: "enabled", writablePaths: [home, socket], projectPaths: [], passthroughEnv: [], networkPolicy: { mode: "host" } },
        cwd: workspace, preparedEnvironment: nativeEnvironment, commandEnv: {}, program: "/bin/sh", args: ["-c", command],
        allowWorkspaceGovernanceWrites: true, allowUserCredentialFiles: true });
      return spawnSync(wrapped.program, [...wrapped.args], { cwd: wrapped.cwd, env: wrapped.env ?? {}, encoding: "utf8", timeout: 15_000 });
    };

    const credential = run("printf 'protocol=https\\nhost=example.invalid\\n\\n' | /usr/bin/git credential fill");
    expect(credential.status).toBe(0);
    expect(credential.stdout).toContain("username=synthetic-user");
    expect(credential.stdout).toContain("password=synthetic-pass");

    const identities = run("/usr/bin/ssh-add -L");
    expect(identities.status).toBe(0);
    expect(identities.stdout.trim()).toBe(readFileSync(`${privateKey}.pub`, "utf8").trim());
  } finally {
    if (agentPid !== undefined) {
      try { process.kill(agentPid, "SIGTERM"); } catch { /* The owned agent may already have exited. */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
