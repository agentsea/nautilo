import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupManifestSchema,
  ComposeDriver,
  type BackupManifest,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
} from "../../src/index.ts";
import {
  failClosedDumpScript,
  validateDumpScript,
} from "../../src/ComposeDriver.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" };
}

function makeFakeExec(
  responder: (call: ExecCall) => ExecResult = () => ({
    code: 0,
    stdout: "",
    stderr: "",
  }),
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    const call: ExecCall = { cmd, args, opts };
    calls.push(call);
    const result = responder(call);
    if (
      result.code === 0 &&
      cmd === "docker" &&
      args[0] === "inspect" &&
      result.stdout.trim() !== "" &&
      !result.stdout.trim().includes("\n")
    ) {
      return {
        ...result,
        stdout: `${result.stdout.trim()}\nnautilo-server:local-dev\n`,
      };
    }
    if (result.code !== 0 || result.stdout.trim() !== "") return result;

    // Full backups now capture the actual running server image. Preserve the
    // existing happy-path fixtures unless a row supplies a more specific
    // Docker response (such as the registry regression below).
    const command = commandText(call);
    if (
      (cmd === "docker" && args[0] === "ps") ||
      (cmd === "sh" && command.includes("docker ps -q"))
    ) {
      return { ...result, stdout: "running-server\n" };
    }
    if (
      (cmd === "docker" && args[0] === "inspect") ||
      (cmd === "sh" && command.includes("docker inspect"))
    ) {
      return {
        ...result,
        stdout: "sha256:source-id\nnautilo-server:local-dev\n",
      };
    }
    return result;
  };
  return { exec, calls };
}

const baseProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

const remoteProfile: ComposeDriverProfile = {
  name: "remote-prod",
  transport: "remote",
  lifecycle: "compose",
  from_source: true,
  instance_id: "prod",
  ssh: { host: "1.2.3.4", user: "root" },
};

const tmpDirs: string[] = [];
function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function cleanupTmp() {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
}

function makeDeps(over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("compose-driver-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template\n");
  const { exec } = makeFakeExec();
  const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    fs: nodeFs,
    now: () => new Date("2026-05-19T12:34:56.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    getAppDbRepairSql: () => "/* m212-test */ SELECT 1;",
    ...over,
  };
}

function seedOperatorFiles(home: string, profile = baseProfile): void {
  mkdirSync(join(home, ".nautilo", "profiles"), { recursive: true });
  mkdirSync(join(home, ".nautilo", "bootstrap-tokens"), { recursive: true });
  writeFileSync(
    join(home, ".nautilo", "profiles", `${profile.name}.toml`),
    `name = "${profile.name}"\n`,
  );
  writeFileSync(join(home, ".nautilo", "bootstrap-tokens", profile.name), "tok\n");
  writeFileSync(join(home, ".nautilo", "instance.env"), "SECRET=1\n");
  writeFileSync(join(home, ".nautilo", "instance.json"), "{}\n");
}

function readManifest(bundlePath: string): BackupManifest {
  return backupManifestSchema.parse(
    JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8")),
  );
}

function commandText(call: ExecCall): string {
  return [call.cmd, ...call.args].join(" ");
}

async function shExit(script: string): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.exitCode ?? -1;
}

describe("backup full bundle", () => {
  let savedHome: string | undefined;
  let savedInstance: string | undefined;
  let hadInstanceKey = false;
  let home: string;

  beforeEach(() => {
    savedHome = process.env["HOME"];
    savedInstance = process.env["NAUTILO_INSTANCE_ID"];
    hadInstanceKey = "NAUTILO_INSTANCE_ID" in process.env;
    home = mktmp("compose-driver-home-");
    process.env["HOME"] = home;
    delete process.env["NAUTILO_SERVER_TAG"];
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env["HOME"] = savedHome;
    else delete process.env["HOME"];
    if (hadInstanceKey) process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    else delete process.env["NAUTILO_INSTANCE_ID"];
    delete process.env["NAUTILO_SERVER_TAG"];
    cleanupTmp();
  });

  test("local bundle captures DBs, persistent bytes, source image identity, manifest, and skips rsync", async () => {
    seedOperatorFiles(home);
    const exec = makeFakeExec((call) => {
      if (call.cmd === "docker" && call.args[0] === "ps") {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (call.cmd === "docker" && call.args[0] === "inspect") {
        return {
          code: 0,
          stdout: "sha256:source-id\nnautilo-server:local-dev\n",
          stderr: "",
        };
      }
      if (call.cmd === "docker" && call.args[0] === "image") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec();
    const bundlePath = join(home, "bundle");
    const driver = new ComposeDriver(
      makeDeps({ exec: exec.exec, localExec: localExec.exec }),
    );

    const out = await driver.backup(baseProfile, { toPath: bundlePath });

    expect(out).toBe(bundlePath);
    const shell = localExec.calls.map(commandText).join("\n");
    expect(shell).toContain("pg_dump -U postgres nautilo");
    expect(shell).toContain("pg_dump -U postgres logto_nautilo");
    expect(shell).toContain("docker run --rm -v nautilo_app_artifacts:/data");
    expect(shell).toContain("docker run --rm -v nautilo_app_media:/data");
    expect(shell).toContain("docker run --rm -v nautilo_app_apps:/data");
    expect(exec.calls.some((c) => c.cmd === "rsync")).toBe(false);
    expect(localExec.calls.some((c) => c.cmd === "rsync")).toBe(false);

    const containerInspect = exec.calls.find(
      (c) => c.cmd === "docker" && c.args[0] === "inspect",
    );
    expect(containerInspect?.args).toContain("running-server");
    const tagCall = exec.calls.find((c) => c.cmd === "docker" && c.args[0] === "tag");
    // Prefer the live configured name so a retagged local-dev still pins under
    // the containerd image store (tag-by-id can return "No such image").
    expect(tagCall?.args).toEqual([
      "tag",
      "nautilo-server:local-dev",
      "nautilo-server:backup-20260519T123456Z",
    ]);

    const manifest = readManifest(bundlePath);
    expect(manifest.image.mode).toBe("source");
    expect(manifest.image.imageId).toBe("sha256:source-id");
    expect(manifest.image.backupTag).toBe("nautilo-server:backup-20260519T123456Z");
    expect(manifest.contents.logtoDb).toBe(true);
    expect(manifest.contents.media).toBe(true);
    expect(manifest.contents.apps).toBe(true);
    expect(manifest.contents.operatorFiles).toBe(true);
    expect(existsSync(join(bundlePath, "operator", "profiles", "local-default.toml"))).toBe(
      true,
    );
  });

  test("registry-backed profile without strategy captures its running registry image", async () => {
    const registryProfile: ComposeDriverProfile = {
      name: "upgrade-fixture-replacement",
      transport: "remote",
      lifecycle: "compose",
      tag: "sha-c9f8517",
      instance_id: "stack39",
      ssh: { host: "10.0.0.39", user: "root" },
    };
    seedOperatorFiles(home, registryProfile);
    const repoDigest =
      `ghcr.io/agentsea/nautilo-server@sha256:${"c".repeat(64)}`;
    const exec = makeFakeExec((call) => {
      const command = commandText(call);
      if (command.includes("image inspect")) {
        return {
          code: 0,
          stdout: `${repoDigest}\n`,
          stderr: "",
        };
      }
      if (command.includes("docker inspect")) {
        return {
          code: 0,
          stdout: "sha256:registry-image\n" +
            "ghcr.io/agentsea/nautilo-server:sha-c9f8517\n",
          stderr: "",
        };
      }
      if (command.includes("docker ps -q")) {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (call.cmd === "test") return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = join(home, "registry-bundle");
    const driver = new ComposeDriver(makeDeps({ exec: exec.exec, localExec: makeFakeExec().exec }));

    await driver.backup(
      registryProfile,
      { toPath: bundlePath, stream: true },
    );

    const manifest = readManifest(bundlePath);
    expect(manifest.image.mode).toBe("registry");
    expect(manifest.image.repoDigest).toBe(repoDigest);
    expect(manifest.image.tag).toBe("ghcr.io/agentsea/nautilo-server:sha-c9f8517");
    const commands = exec.calls.map(commandText).join("\n");
    expect(commands).toContain("ghcr.io/agentsea/nautilo-server:sha-c9f8517");
    expect(commands).not.toContain("image inspect nautilo-server:sha-c9f8517");
    expect(commands).not.toContain("docker tag");
  });

  test("fresh local and remote full bundles preserve v2 when Docker also retains the legacy digest", async () => {
    const requested = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"c".repeat(64)}`;
    const legacy = requested.replace("nautilo-runtime-v2@", "nautilo-runtime@");
    const imageId = `sha256:${"d".repeat(64)}`;
    for (const profile of [baseProfile, remoteProfile]) {
      seedOperatorFiles(home, profile);
      const exec = makeFakeExec((call) => {
        const command = commandText(call);
        if (command.includes("image inspect")) return { code: 0, stderr: "", stdout: JSON.stringify({ id: imageId, repoDigests: [legacy, requested] }) };
        if (command.includes("docker inspect")) return { code: 0, stderr: "", stdout: `${imageId}\n${requested}\n` };
        if (command.includes("docker ps -q")) return { code: 0, stderr: "", stdout: "running-server\n" };
        if (call.cmd === "test") return { code: 1, stderr: "", stdout: "" };
        return { code: 0, stderr: "", stdout: "" };
      });
      const bundlePath = join(home, `v2-bundle-${profile.transport}`);
      const driver = new ComposeDriver(makeDeps({ exec: exec.exec, localExec: makeFakeExec().exec }));
      await driver.backup(profile, { toPath: bundlePath, stream: profile.transport === "remote" });
      const manifest = readManifest(bundlePath);
      expect(manifest.image).toEqual({ mode: "registry", repoDigest: requested, tag: requested });
      expect(manifest.contents.nautiloDb).toBeTrue(); expect(manifest.contents.logtoDb).toBeTrue();
      expect(manifest.contents.artifacts).toBeTrue(); expect(manifest.contents.media).toBeTrue(); expect(manifest.contents.apps).toBeTrue();
      expect(exec.calls.some(call => commandText(call).includes("docker tag"))).toBeFalse();
    }
  });

  test("remote staged bundle writes to remote staging, rsyncs down, and cleans up", async () => {
    seedOperatorFiles(home, remoteProfile);
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (text.includes("pg_total_relation_size")) return { code: 0, stdout: "100\n", stderr: "" };
      if (text.includes("du -sb")) return { code: 0, stdout: "200\n", stderr: "" };
      if (call.cmd === "df") return { code: 0, stdout: "Avail\n999999\n", stderr: "" };
      if (call.cmd === "test") return { code: 1, stdout: "", stderr: "" };
      if (call.cmd === "docker" && call.args.includes("inspect")) {
        return { code: 0, stdout: "sha256:remote-source\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = join(home, "remote-bundle");
    // Report a modern rsync (>=3) so the resumable --append-verify flag is used.
    const localExec = makeFakeExec((call) => {
      if (call.cmd === "rsync" && call.args[0] === "--version") {
        return { code: 0, stdout: "rsync  version 3.2.7  protocol version 31\n", stderr: "" };
      }
      if (call.cmd === "rsync") {
        chmodSync(bundlePath, 0o755);
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => "/opt/nautilo-prod",
      }),
    );

    await driver.backup(remoteProfile, { toPath: bundlePath });

    const remoteCommands = exec.calls.map(commandText).join("\n");
    expect(remoteCommands).toContain("/opt/nautilo-prod/.backup-staging-");
    expect(remoteCommands).toContain("pg_dump -U postgres nautilo");
    expect(remoteCommands).toContain("pg_dump -U postgres logto_nautilo");
    // M139 staged-mode fix: droplet-side commands resolve the container via
    // `docker exec "$(docker ps -q --filter name=<project>-<service>)"` and
    // must NOT use `docker compose exec` (the operator-local `-f <template>`
    // path does not exist on the droplet).
    const dbDumpCmds = exec.calls
      .map(commandText)
      .filter((t) => t.includes("pg_dump") || t.includes("pg_total_relation_size"));
    expect(dbDumpCmds.length).toBeGreaterThan(0);
    for (const t of dbDumpCmds) {
      expect(t).toContain("docker exec -i");
      expect(t).toContain("docker ps -q --filter");
      expect(t).not.toContain("compose");
    }
    const rsync = localExec.calls.find((c) => c.cmd === "rsync" && c.args.includes("-e"));
    expect(rsync?.args).toContain("--partial");
    expect(rsync?.args).toContain("--append-verify");
    expect(rsync?.args.some((a) => a.includes("root@1.2.3.4:/opt/nautilo-prod/.backup-staging-"))).toBe(
      true,
    );
    expect(exec.calls.some((c) => c.cmd === "rm" && c.args[0] === "-rf")).toBe(true);
    expect(statSync(bundlePath).mode & 0o777).toBe(0o700);
  });

  test("macOS rsync 2.6.9 omits --append-verify but keeps --partial (resumable)", async () => {
    seedOperatorFiles(home, remoteProfile);
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (text.includes("pg_total_relation_size")) return { code: 0, stdout: "100\n", stderr: "" };
      if (text.includes("du -sb")) return { code: 0, stdout: "200\n", stderr: "" };
      if (call.cmd === "df") return { code: 0, stdout: "Avail\n999999\n", stderr: "" };
      if (call.cmd === "test") return { code: 1, stdout: "", stderr: "" };
      if (call.cmd === "docker" && call.args.includes("inspect")) {
        return { code: 0, stdout: "sha256:remote-source\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    // Apple's bundled rsync — predates --append-verify.
    const localExec = makeFakeExec((call) =>
      call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 2.6.9  protocol version 29\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const driver = new ComposeDriver(
      makeDeps({
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => "/opt/nautilo-prod",
      }),
    );

    await driver.backup(remoteProfile, { toPath: join(home, "old-rsync-bundle") });

    const rsync = localExec.calls.find((c) => c.cmd === "rsync" && c.args.includes("-e"));
    expect(rsync?.args).toContain("--partial");
    expect(rsync?.args).not.toContain("--append-verify");
  });

  test("remote stream skips staging and rsync, uses DOCKER_HOST pipelines, and warns", async () => {
    seedOperatorFiles(home, remoteProfile);
    const logs: string[] = [];
    const exec = makeFakeExec((call) => {
      if (call.cmd === "cat" && call.args[0] === "/opt/nautilo-prod/docker-compose.yml") {
        return { code: 0, stdout: "# prior remote template\n", stderr: "" };
      }
      if (call.cmd === "test") return { code: 1, stdout: "", stderr: "" };
      if (call.cmd === "docker" && call.args.includes("inspect")) {
        return { code: 0, stdout: "sha256:stream-source\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec();
    const bundlePath = join(home, "stream-bundle");
    const driver = new ComposeDriver(
      makeDeps({
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => "/opt/nautilo-prod",
        log: (msg) => logs.push(msg),
      }),
    );

    await driver.backup(remoteProfile, { toPath: bundlePath, stream: true });

    expect(exec.calls.some((c) => c.cmd === "mkdir")).toBe(false);
    expect(localExec.calls.some((c) => c.cmd === "rsync")).toBe(false);
    const shellPipes = localExec.calls.filter((c) => c.cmd === "sh");
    expect(shellPipes.length).toBeGreaterThan(0);
    expect(shellPipes.every((c) => c.opts.env?.["DOCKER_HOST"] === "ssh://root@1.2.3.4")).toBe(
      true,
    );
    expect(shellPipes.map(commandText).join("\n")).toContain(
      "nautilo-server tar czf - -C /var/lib/nautilo/artifacts",
    );
    expect(shellPipes.map(commandText).join("\n")).toContain(
      "nautilo-server tar czf - -C /var/lib/nautilo/media",
    );
    expect(shellPipes.map(commandText).join("\n")).toContain(
      "nautilo-server tar czf - -C /var/lib/nautilo/apps",
    );
    expect(logs.some((l) => /NOT resumable/i.test(l))).toBe(true);
    expect(exec.calls.some((c) => c.cmd === "cat" && c.args[0] === "/opt/nautilo-prod/docker-compose.yml")).toBe(true);
    const manifest = readManifest(bundlePath);
    expect(manifest.contents.composeTemplate).toBe(true);
    expect(readFileSync(join(bundlePath, "docker-compose.yml"), "utf8")).toBe(
      "# prior remote template\n",
    );
    expect(manifest.version).toBe(2);
    if (manifest.version === 2) {
      expect(manifest.integrity.composeTemplate).toBeDefined();
    }
  });

  test("--no-operator-files omits operator copy", async () => {
    seedOperatorFiles(home);
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args.includes("inspect")
        ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = join(home, "no-operator");
    const driver = new ComposeDriver(makeDeps({ exec: exec.exec, localExec: makeFakeExec().exec }));

    await driver.backup(baseProfile, { toPath: bundlePath, noOperatorFiles: true });

    const manifest = readManifest(bundlePath);
    expect(manifest.contents.operatorFiles).toBe(false);
    expect(existsSync(join(bundlePath, "operator"))).toBe(false);
  });

  test("logto dump failure aborts the bundle before manifest acceptance", async () => {
    seedOperatorFiles(home);
    const logs: string[] = [];
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args.includes("inspect")
        ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const localExec = makeFakeExec((call) => {
      const text = commandText(call);
      // Only the logto dump pipeline contains both pg_dump and logto_nautilo.
      if (text.includes("pg_dump") && text.includes("logto_nautilo")) {
        return { code: 1, stdout: "", stderr: "no such service" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = join(home, "no-logto");
    const driver = new ComposeDriver(
      makeDeps({
        exec: exec.exec,
        localExec: localExec.exec,
        log: (msg) => logs.push(msg),
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.backup(baseProfile, { toPath: bundlePath })).rejects.toThrow(
      /logto DB dump/,
    );
    expect(existsSync(join(bundlePath, "manifest.json"))).toBe(false);
  });

  test("app pg_dump failure cannot be masked by a successful gzip", async () => {
    seedOperatorFiles(home);
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args.includes("inspect")
        ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const localExec = makeFakeExec((call) => {
      const text = commandText(call);
      // The nautilo dump pipeline (fail-closed wrapper) contains the app
      // pg_dump producer; it must surface a nonzero exit instead of letting
      // gzip's success hide it.
      if (text.includes("pg_dump") && text.includes("nautilo ") && !text.includes("logto")) {
        return { code: 1, stdout: "", stderr: "pg_dump: connection refused" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = join(home, "app-pgdump-failed");
    const driver = new ComposeDriver(
      makeDeps({ exec: exec.exec, localExec: localExec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.backup(baseProfile, { toPath: bundlePath })).rejects.toThrow(
      /nautilo DB dump failed/,
    );
    expect(existsSync(join(bundlePath, "manifest.json"))).toBe(false);
  });

  test("empty nautilo dump is rejected by the integrity gate before manifest acceptance", async () => {
    seedOperatorFiles(home);
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args.includes("inspect")
        ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const localExec = makeFakeExec((call) => {
      const text = commandText(call);
      // Dump pipelines succeed (gzip writes an empty-but-valid stream); the
      // nautilo validation gate (gzip -t / non-empty check) must reject it.
      if (text.includes("gzip -t") && text.includes("nautilo.sql.gz")) {
        return { code: 3, stdout: "", stderr: "dump empty" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = join(home, "empty-nautilo");
    const driver = new ComposeDriver(
      makeDeps({ exec: exec.exec, localExec: localExec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.backup(baseProfile, { toPath: bundlePath })).rejects.toThrow(
      /nautilo DB dump validation/,
    );
    expect(existsSync(join(bundlePath, "manifest.json"))).toBe(false);
  });

  test("corrupt logto dump is rejected by the integrity gate before manifest acceptance", async () => {
    seedOperatorFiles(home);
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args.includes("inspect")
        ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const localExec = makeFakeExec((call) => {
      const text = commandText(call);
      if (text.includes("gzip -t") && text.includes("logto_nautilo.sql.gz")) {
        return { code: 4, stdout: "", stderr: "dump corrupt gzip" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = join(home, "corrupt-logto");
    const driver = new ComposeDriver(
      makeDeps({ exec: exec.exec, localExec: localExec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.backup(baseProfile, { toPath: bundlePath })).rejects.toThrow(
      /logto DB dump validation/,
    );
    expect(existsSync(join(bundlePath, "manifest.json"))).toBe(false);
  });

  test("happy path validates both DB dumps and records both in the manifest", async () => {
    seedOperatorFiles(home);
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args.includes("inspect")
        ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const localExec = makeFakeExec();
    const bundlePath = join(home, "validated-bundle");
    const driver = new ComposeDriver(
      makeDeps({ exec: exec.exec, localExec: localExec.exec }),
    );

    await driver.backup(baseProfile, { toPath: bundlePath });

    const shell = localExec.calls.map(commandText).join("\n");
    // Both dump pipelines are fail-closed (pg_dump producer + gzip consumer).
    expect(shell).toMatch(/pg_dump -U postgres nautilo[^_]/);
    expect(shell).toContain("pg_dump -U postgres logto_nautilo");
    // Both artifacts are validated: non-empty + gzip -t integrity.
    const validations = localExec.calls
      .map(commandText)
      .filter((t) => t.includes("gzip -t"));
    expect(validations.some((t) => t.includes("nautilo.sql.gz"))).toBe(true);
    expect(validations.some((t) => t.includes("logto_nautilo.sql.gz"))).toBe(true);
    const manifest = readManifest(bundlePath);
    expect(manifest.contents.nautiloDb).toBe(true);
    expect(manifest.contents.logtoDb).toBe(true);
  });

  test("letsencrypt profile captures caddy volumes", async () => {
    seedOperatorFiles(home);
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args.includes("inspect")
        ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const localExec = makeFakeExec();
    const bundlePath = join(home, "le-bundle");
    const driver = new ComposeDriver(
      makeDeps({ exec: exec.exec, localExec: localExec.exec }),
    );

    await driver.backup(
      {
        ...baseProfile,
        https: "letsencrypt",
        domain: "example.com",
        acme_email: "ops@example.com",
      },
      { toPath: bundlePath },
    );

    const shell = localExec.calls.map(commandText).join("\n");
    expect(shell).toContain("nautilo_caddy_data:/data");
    expect(shell).toContain("nautilo_caddy_config:/data");
    const manifest = readManifest(bundlePath);
    expect(manifest.contents.caddyData).toBe(true);
    expect(manifest.contents.caddyConfig).toBe(true);
  });

  test("remote staged disk preflight aborts when free space is insufficient", async () => {
    seedOperatorFiles(home, remoteProfile);
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (text.includes("pg_total_relation_size")) return { code: 0, stdout: "900\n", stderr: "" };
      if (text.includes("du -sb")) return { code: 0, stdout: "200\n", stderr: "" };
      if (call.cmd === "df") return { code: 0, stdout: "Avail\n100\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec: exec.exec,
        localExec: makeFakeExec().exec,
        resolveInstanceRootDir: () => "/opt/nautilo-prod",
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.backup(remoteProfile, { toPath: join(home, "too-small") }),
    ).rejects.toThrow(/re-run with --stream/);
    expect(exec.calls.some((c) => c.cmd === "mkdir")).toBe(false);
    expect(exec.calls.some((c) => commandText(c).includes("pg_dump -U postgres nautilo"))).toBe(
      false,
    );
  });

  test("fail-closed backup scripts execute in POSIX sh and preserve producer failures", async () => {
    const dump = join(home, "shell-validated.sql.gz");
    expect(await shExit(failClosedDumpScript("printf 'SELECT 1;\\n'", dump))).toBe(0);
    expect(await shExit(validateDumpScript(dump))).toBe(0);

    const failedDump = join(home, "producer-failed.sql.gz");
    expect(await shExit(failClosedDumpScript("sh -c 'exit 7'", failedDump))).toBe(7);
  });

  // D420 (Wave 3 task 3.3.1) — consolidated backup integrity fault table. The
  // recovery bundle is the rollback target for the entire upgrade transaction,
  // so every integrity failure must fail CLOSED: reject the bundle before
  // manifest acceptance (a corrupt/empty/partial bundle can never become an
  // accepted rollback target) and surface an exact, DB-named error. The table
  // proves the gate runs AFTER the dump pipeline (not instead of it) for each
  // of the four integrity modes: app pg_dump failure (not masked by gzip),
  // logto dump failure, empty nautilo dump, and corrupt logto gzip.
  describe("D420 (3.3.1) backup integrity fault table", () => {
    const modes: Array<{
      label: string;
      fail: string;
      expectErr: RegExp;
      pipeline: "nautilo" | "logto";
    }> = [
      {
        label: "nautilo pg_dump failure cannot be masked by gzip",
        fail: "nautilo-pgdump",
        expectErr: /nautilo DB dump failed/,
        pipeline: "nautilo",
      },
      {
        label: "logto dump failure aborts the bundle",
        fail: "logto-dump",
        expectErr: /logto DB dump/,
        pipeline: "logto",
      },
      {
        label: "empty nautilo dump is rejected by the integrity gate",
        fail: "nautilo-empty",
        expectErr: /nautilo DB dump validation/,
        pipeline: "nautilo",
      },
      {
        label: "corrupt logto dump is rejected by the integrity gate",
        fail: "logto-corrupt",
        expectErr: /logto DB dump validation/,
        pipeline: "logto",
      },
    ];

    for (const mode of modes) {
      test(mode.label, async () => {
        seedOperatorFiles(home);
        const exec = makeFakeExec((call) =>
          call.cmd === "docker" && call.args.includes("inspect")
            ? { code: 0, stdout: "sha256:source-id\n", stderr: "" }
            : { code: 0, stdout: "", stderr: "" },
        );
        const localExec = makeFakeExec((call) => {
          const text = commandText(call);
          if (
            mode.fail === "nautilo-pgdump" &&
            text.includes("pg_dump") &&
            text.includes("nautilo ") &&
            !text.includes("logto")
          ) {
            return { code: 1, stdout: "", stderr: "pg_dump: connection refused" };
          }
          if (mode.fail === "logto-dump" && text.includes("pg_dump") && text.includes("logto_nautilo")) {
            return { code: 1, stdout: "", stderr: "no such service" };
          }
          if (mode.fail === "nautilo-empty" && text.includes("gzip -t") && text.includes("nautilo.sql.gz")) {
            return { code: 3, stdout: "", stderr: "dump empty" };
          }
          if (mode.fail === "logto-corrupt" && text.includes("gzip -t") && text.includes("logto_nautilo.sql.gz")) {
            return { code: 4, stdout: "", stderr: "dump corrupt gzip" };
          }
          return { code: 0, stdout: "", stderr: "" };
        });
        const bundlePath = join(home, `fault-${mode.fail}`);
        const driver = new ComposeDriver(
          makeDeps({ exec: exec.exec, localExec: localExec.exec }),
        );

        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
        await expect(driver.backup(baseProfile, { toPath: bundlePath })).rejects.toThrow(
          mode.expectErr,
        );

        // Every integrity failure fails closed: no manifest is ever written.
        expect(existsSync(join(bundlePath, "manifest.json"))).toBe(false);
        // The fail-closed dump pipeline for the failing DB actually ran — the
        // integrity gate runs after the dump, not instead of it.
        const shell = localExec.calls.map(commandText).join("\n");
        if (mode.pipeline === "nautilo") {
          expect(shell).toMatch(/pg_dump -U postgres nautilo[^_]/);
        } else {
          expect(shell).toContain("pg_dump -U postgres logto_nautilo");
        }
      });
    }
  });
});
