import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxFromEnvelope } from "../../src/from-envelope";
import { buildSandboxExec } from "../../src/seatbelt";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const native = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") ? test : test.skip;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "developer-user-environment-"))); roots.push(root);
  const home = join(root, "home"), workspace = join(root, "project"), prefix = join(root, "package-prefix"), dataDir = join(home, "private-state");
  for (const directory of [home, workspace, prefix, dataDir, join(home, ".config", "gh"), join(home, ".ssh")]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, ".env"), "synthetic-credential");
  writeFileSync(join(home, ".config", "gh", "credentials.json"), "synthetic-credential");
  writeFileSync(join(home, ".ssh", "key"), "synthetic-credential");
  writeFileSync(join(dataDir, "authority"), "synthetic-private-state");
  const config = { mode: "enabled" as const, writablePaths: [home, prefix], projectPaths: [], passthroughEnv: [],
    protectedPaths: [dataDir], networkPolicy: { mode: "host" as const } };
  const environment = { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: "/tmp", LANG: "en_US.UTF-8" };
  function run(command: string, trusted = true, isolated = false) {
    const wrapped = buildSandboxExec({ workspace, dataDir, toolsBin: "/usr/bin", config: {
      ...config, networkPolicy: { mode: isolated ? "isolated" : "host" },
    }, cwd: workspace, preparedEnvironment: environment, commandEnv: {}, program: "/bin/sh", args: ["-c", command],
    allowWorkspaceGovernanceWrites: trusted, allowUserCredentialFiles: trusted });
    return spawnSync(wrapped.program, [...wrapped.args], { cwd: wrapped.cwd, env: wrapped.env ?? {}, encoding: "utf8", timeout: 15_000 });
  }
  return { home, workspace, prefix, dataDir, config, environment, run };
}

native("native Development reads and refreshes HOME credentials while private application state remains denied", () => {
  const f = fixture();
  expect(f.run('test "$(cat "$HOME/.env")" = synthetic-credential && test "$(cat "$HOME/.config/gh/credentials.json")" = synthetic-credential && cat "$HOME/.ssh/key" >/dev/null && printf refreshed > "$HOME/.env"').status).toBe(0);
  expect(f.run('cat "$HOME/private-state/authority" >/dev/null').status).not.toBe(0);
  expect(f.run('printf altered > "$HOME/private-state/authority"').status).not.toBe(0);
  expect(f.run('cat "$HOME/.env" >/dev/null', false).status).not.toBe(0);
});

native("native Development installs and replaces user executables and performs ordinary Git writes", () => {
  const f = fixture();
  const result = f.run(`mkdir -p "$HOME/.local/bin" && printf '#!/bin/sh\nexit 0\n' > "$HOME/.local/bin/fixture" && chmod +x "$HOME/.local/bin/fixture" && "$HOME/.local/bin/fixture" && rm "$HOME/.local/bin/fixture" && touch '${f.prefix}/installed' && rm '${f.prefix}/installed' && git init -q && printf fixture > content && git add content && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm fixture && git status --porcelain`);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
});

native("native Development binds a local listener while isolated networking still denies it", () => {
  const f = fixture();
  const command = `/usr/bin/python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); print("listening"); s.close()'`;
  const allowed = f.run(command);
  expect(allowed.status).toBe(0);
  expect(allowed.stdout.trim()).toBe("listening");
  expect(f.run(command, true, true).status).not.toBe(0);
});

native("serialized policy cannot enable the local credential exception", async () => {
  const f = fixture();
  const sandbox = await createSandboxFromEnvelope({ workspace: f.workspace, dataDir: f.dataDir, toolsBin: "/usr/bin",
    mode: "desktop-locked", securityLevel: "paranoid", failIfNoBackend: true,
    config: { ...f.config, allowUserCredentialFiles: true }, allowUserCredentialFiles: true,
  } as Parameters<typeof createSandboxFromEnvelope>[0], { preparedEnvironment: f.environment });
  try {
    const wrapped = sandbox.wrap("/bin/cat", [join(f.home, ".env")], f.workspace, {});
    const result = spawnSync(wrapped.program, [...wrapped.args], { cwd: wrapped.cwd, env: wrapped.env ?? {}, stdio: "ignore", timeout: 5000 });
    expect(result.status).not.toBe(0);
  } finally { await sandbox.close(); }
});
