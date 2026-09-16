import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  buildRemoteRuntimeAcceptanceTransport,
  type RemoteRuntimeFetchSpawn,
} from "../../src/remote-runtime-acceptance-fetch.ts";
import {
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
  type RestoreOptions,
  type UpgradeOptions,
  applyUpgradeStrategy,
  resolveUpgradeStrategy,
} from "../../src/ComposeDriver.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ReleasePlanReport } from "../../../contracts/release.ts";
import type {
  ComposeDriverProfile,
  UpgradeArtifact,
  UpgradeLocation,
  UpgradeScope,
} from "../../src/types.ts";
import { dockerHostFor, wrapWithDockerHost } from "../../src/wrap-docker-host.ts";

interface ExecCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: "inherit" | "pipe" };
}

const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
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
    if (result.code !== 0 || result.stdout.trim() !== "") return result;

    // Full upgrades capture the current server image before stopping it.
    // Supply the prior source-image fixture unless a test has a more specific
    // Docker response.
    const command = [cmd, ...args].join(" ");
    if (
      (cmd === "docker" && args[0] === "ps") ||
      (cmd === "sh" &&
        (command.includes("docker ps -aq") || command.includes("docker ps -q")))
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

function makeDeps(over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("upgrade-orchestrator-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  const localRoot = mktmp("upgrade-orchestrator-home-");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template marker\n");
  const infraDir = join(repoRoot, "infra");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "postgres-init.sh"), "#!/bin/sh\n");
  const { exec } = makeFakeExec();
  const fakeFetch = (async () =>
    new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    resolveSourceBuildSha: async () => "c".repeat(40),
    fs: nodeFs,
    now: () => new Date("2026-05-19T12:34:56.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    resolveInstanceRootDir: () => localRoot,
    resolveLocalInstanceRootDir: () => localRoot,
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

const profile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

const canonicalImageRef = "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1";

const remoteProfile: ComposeDriverProfile = {
  name: "remote-prod",
  transport: "remote",
  lifecycle: "compose",
  from_source: false,
  image_ref: canonicalImageRef,
  instance_id: "prod",
  ssh: { host: "1.2.3.4", user: "root" },
};

function remoteDeploymentManifest(remoteRoot: string) {
  return {
    version: 1,
    instanceId: "prod",
    composeProjectName: "nautilo-prod",
    lifecycle: "compose" as const,
    image: {
      mode: "registry" as const,
      reference: "ghcr.io/agentsea/nautilo-server:main",
    },
    remoteRoot,
    https: "off" as const,
    createdAt: "2026-05-19T12:00:00.000Z",
    updatedAt: "2026-05-19T12:30:00.000Z",
  };
}

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpDirs.length = 0;
});

describe("ComposeDriver upgrade orchestrator", () => {
  test("server-only upgrade scopes instance resolution to the selected profile", async () => {
    const previous = process.env["NAUTILO_INSTANCE_ID"];
    const hadPrevious = "NAUTILO_INSTANCE_ID" in process.env;
    const driver = new ComposeDriver(makeDeps());
    let instanceIdDuringRelease = "";
    driver.releaseApply = async (): Promise<ReleasePlanReport> => {
      instanceIdDuringRelease = process.env["NAUTILO_INSTANCE_ID"] ?? "";
      return {
        compatible: true,
        auth: {} as ReleasePlanReport["auth"],
        artifact: {
          mode: "registry",
          requested: "ghcr.io/example/nautilo-server:sha-123",
          immutableId: "sha256:123",
        },
        limitations: [],
      };
    };

    await driver.upgrade(
      {
        name: "profile-scoped",
        transport: "local",
        lifecycle: "compose",
        instance_id: "profile-scoped",
        image_ref: canonicalImageRef,
      },
      { artifact: "image", scope: "server-only" },
    );

    expect(instanceIdDuringRelease).toBe("profile-scoped");
    expect(process.env["NAUTILO_INSTANCE_ID"]).toBe(previous);
    expect("NAUTILO_INSTANCE_ID" in process.env).toBe(hadPrevious);
  });

  test("source release planning includes the app profile when resolving the built server image", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args.includes("config") && call.args.includes("--images")) {
        return { code: 0, stdout: "nautilo-server:local-dev\n", stderr: "" };
      }
      if (call.args[0] === "image" && call.args[1] === "inspect") {
        return { code: 0, stdout: "sha256:incoming-source\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const deps = makeDeps({ exec });
    const instanceRoot = deps.resolveInstanceRootDir?.(profile);
    if (instanceRoot === undefined) throw new Error("missing test instance root");
    writeFileSync(
      join(instanceRoot, "deploy.compose.env"),
      `COMPOSE_PROJECT_NAME=nautilo\nNAUTILO_SOURCE_SHA=${"a".repeat(40)}\n`,
      { mode: 0o600 },
    );
    const driver = new ComposeDriver(deps);
    const internals = driver as unknown as {
      prepareReleaseArtifact: (
        input: ComposeDriverProfile,
      ) => Promise<{ mode: string; immutableId: string }>;
      readLocalImageAuthContract: (image: string) => Promise<unknown>;
    };
    internals.readLocalImageAuthContract = async () => ({});

    const artifact = await internals.prepareReleaseArtifact(profile);

    expect(artifact).toMatchObject({
      mode: "source",
      immutableId: "sha256:incoming-source",
    });
    const imageConfig = calls.find(
      (call) => call.args.includes("config") && call.args.includes("--images"),
    );
    expect(imageConfig?.args).toContain("--profile");
    expect(imageConfig?.args).toContain("app");
  });

  test("server-only local Compose commands retain the server environment overlay", () => {
    const instanceRoot = mktmp("release-server-overlay-");
    const overlayPath = join(instanceRoot, "deploy.server-overlay.yml");
    writeFileSync(overlayPath, "services: {}\n");
    const driver = new ComposeDriver(
      makeDeps({
        resolveInstanceRootDir: () => instanceRoot,
        resolveLocalInstanceRootDir: () => instanceRoot,
      }),
    );
    const internals = driver as unknown as {
      releaseLocalComposeArgs: (
        input: ComposeDriverProfile,
        command: string[],
      ) => string[];
    };

    const args = internals.releaseLocalComposeArgs(profile, ["up", "nautilo-server"]);

    expect(args).toContain(overlayPath);
  });

  test("canonical server-only image upgrade delegates a request-scoped registry profile", async () => {
    const driver = new ComposeDriver(makeDeps());
    let receivedProfile: ComposeDriverProfile | undefined;
    let receivedOptions: { noRollback?: boolean } | undefined;
    driver.releaseApply = async (nextProfile, nextOptions): Promise<ReleasePlanReport> => {
      receivedProfile = nextProfile;
      receivedOptions = nextOptions;
      return {
        compatible: true,
        auth: {
          classification: "compatible",
          incoming: {
            version: 1,
            hash: "incoming",
            logtoEngine: { image: "ghcr.io/logto-io/logto:1.0.0", minimumVersion: "1.0.0" },
            impact: { requiresExplicitAuthReconcile: false, mayAffectExistingSessions: false },
          },
          applied: null,
          live: { logtoEngineImage: null, logtoEngineVersion: null, inspected: false },
          reasons: [],
          limitations: [],
        },
        artifact: {
          mode: "registry",
          requested: canonicalImageRef,
          immutableId: "sha256:123",
        },
        limitations: [],
      };
    };

    await driver.upgrade(
      { name: "default-image", transport: "local", lifecycle: "compose", image_ref: canonicalImageRef },
      {
        artifact: "image",
        imageRef: canonicalImageRef,
        scope: "server-only",
        waitForMs: 30_000,
      },
    );

    expect(receivedProfile).toMatchObject({
      from_source: false,
      image_ref: canonicalImageRef,
    });
    expect(receivedOptions).toBeUndefined();
  });

  test("happy path runs doctor, consistent backup, deploy, and health without restore", async () => {
    const order: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) {
        order.push("stop");
      }
      if (call.args.includes("start") && call.args.includes("nautilo-server")) {
        order.push("start");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const restoreCalls: unknown[][] = [];
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        doctor: async () => {
          order.push("doctor");
        },
      }),
    );
    driver.backup = (async (_p, o) => {
      order.push("backup");
      return o?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.restore = (async (...args) => {
      restoreCalls.push(args);
      order.push("restore");
    }) as typeof driver.restore;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    await driver.upgrade(profile);

    expect(order).toEqual(["doctor", "stop", "backup", "deploy", "health"]);
    expect(restoreCalls).toHaveLength(0);
    expect(
      calls.some((c) => c.args.includes("stop") && c.args.includes("nautilo-server")),
    ).toBe(true);
    expect(
      calls.some((c) => c.args.includes("start") && c.args.includes("nautilo-server")),
    ).toBe(false);
  });

  test("deploy failure restores the pre-upgrade bundle and reports rolled back", async () => {
    const order: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const localRoot = mktmp("upgrade-orchestrator-restore-root-");
    const restoreCalls: unknown[][] = [];
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => localRoot,
        resolveLocalInstanceRootDir: () => localRoot,
      }),
    );
    driver.backup = (async (_p, o) => {
      order.push("backup");
      return o?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
      throw new Error("deploy exploded");
    }) as typeof driver.deploy;
    driver.restore = (async (...args) => {
      restoreCalls.push(args);
      order.push("restore");
    }) as typeof driver.restore;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(profile)).rejects.toThrow(
      /rolled back.*post-rollback health = ready/,
    );

    expect(restoreCalls).toHaveLength(1);
    const restoreOpts = restoreCalls[0]![1] as { fromPath: string; force: boolean };
    expect(restoreOpts).toEqual({
      fromPath: join(localRoot, "backups", "auto-pre-upgrade-20260519T123456Z"),
      force: true,
    });
    expect(order).toEqual(["stop", "backup", "deploy", "restore", "health"]);
  });

  test("deploy succeeds but health failure rolls back and rechecks health", async () => {
    const { exec } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec }));
    const healthCalls: string[] = [];
    driver.backup = (async (_p, o) => o?.toPath ?? "/x") as typeof driver.backup;
    driver.deploy = (async () => {}) as typeof driver.deploy;
    driver.restore = (async () => {}) as typeof driver.restore;
    driver.checkServerHealth = (async () => {
      healthCalls.push("health");
      if (healthCalls.length === 1) throw new Error("not ready");
    }) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(profile)).rejects.toThrow(
      /rolled back.*post-rollback health = ready/,
    );

    expect(healthCalls).toHaveLength(2);
  });

  test("post-rollback health failure reports critical manual recovery", async () => {
    const { exec } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.backup = (async (_p, o) => o?.toPath ?? "/x") as typeof driver.backup;
    driver.deploy = (async () => {
      throw new Error("deploy failed");
    }) as typeof driver.deploy;
    driver.restore = (async () => {}) as typeof driver.restore;
    driver.checkServerHealth = (async () => {
      throw new Error("still broken");
    }) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(profile)).rejects.toThrow(
      /CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED/,
    );
  });

  test("--no-rollback leaves the failed stack as-is and includes manual bundle path", async () => {
    let restoreCalls = 0;
    const driver = new ComposeDriver(makeDeps());
    driver.backup = (async (_p, o) => o?.toPath ?? "/x") as typeof driver.backup;
    driver.deploy = (async () => {
      throw new Error("deploy failed");
    }) as typeof driver.deploy;
    driver.restore = (async () => {
      restoreCalls += 1;
    }) as typeof driver.restore;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(profile, { noRollback: true })).rejects.toThrow(
      /--no-rollback.*leaving the failed target as-is.*auto-pre-upgrade-20260519T123456Z.*nautilo restore/,
    );
    expect(restoreCalls).toBe(0);
  });

  test("ordering keeps server stopped from backup through deploy", async () => {
    const order: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) order.push("stop");
      if (call.args.includes("start") && call.args.includes("nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    driver.backup = (async (_p, o) => {
      order.push("backup");
      return o?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.restore = (async () => {
      order.push("restore");
    }) as typeof driver.restore;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    await driver.upgrade(profile);

    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("backup"));
    expect(order.indexOf("backup")).toBeLessThan(order.indexOf("deploy"));
    expect(order).not.toContain("start");
  });

  test("refuses missing media before stopping a running legacy server for backup", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args.includes("ps")) {
        return { code: 0, stdout: "nautilo-nautilo-server-1\n", stderr: "" };
      }
      if (call.args[0] === "volume" && call.args[1] === "inspect") {
        return call.args[2] === "nautilo_app_media"
          ? { code: 1, stdout: "", stderr: "not found" }
          : { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    let backupCalls = 0;
    driver.backup = (async () => {
      backupCalls += 1;
      return "/x";
    }) as typeof driver.backup;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.upgrade(profile)).rejects.toThrow(/migrate-media-to-volume/);
    expect(backupCalls).toBe(0);
    expect(calls.some((call) => call.args.includes("stop"))).toBe(false);
  });

  test("remote source upgrade uses legacy M139 path without manifest preflight", async () => {
    const remoteSourceProfile: ComposeDriverProfile = {
      name: "remote-source",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const order: string[] = [];
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      if (cmd === "docker" && args[0] === "ps") {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "inspect") {
        return {
          code: 0,
          stdout: "sha256:remote-source\nnautilo-server:local-dev\n",
          stderr: "",
        };
      }
      if (cmd === "docker" && args[0] === "image") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (
        cmd === "docker" &&
        args.includes("stop") &&
        args.includes("nautilo-server")
      ) {
        order.push("stop");
      }
      if (
        cmd === "docker" &&
        args.includes("start") &&
        args.includes("nautilo-server")
      ) {
        order.push("start");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec: innerExec, calls } = makeFakeExec((call) => {
      if (call.cmd === "cat") {
        order.push("manifest");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const exec = wrapWithDockerHost(
      innerExec,
      dockerHostFor(remoteSourceProfile),
      fakeLocalExec,
    );
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        doctor: async () => {
          order.push("doctor");
        },
      }),
    );
    driver.backup = (async (_p, opts) => {
      order.push("backup");
      return opts?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    await driver.upgrade(remoteSourceProfile);

    expect(order).toEqual(["doctor", "stop", "backup", "deploy", "health"]);
    expect(calls.some((c) => c.cmd === "cat")).toBe(false);
    const lifecycleCalls = localExecCalls.filter(
      (c) =>
        c.cmd === "docker" &&
        (c.args.includes("stop") || c.args.includes("start")) &&
        c.args.includes("nautilo-server"),
    );
    expect(lifecycleCalls).toHaveLength(1);
    for (const call of lifecycleCalls) {
      expect(call.opts.env?.["DOCKER_HOST"]).toBe("ssh://root@1.2.3.4");
    }
  });

  test("current M139 remote registry upgrade preflights manifest, stops server, then delegates deploy", async () => {
    const remoteRoot = "/opt/nautilo-prod";
    const order: string[] = [];
    const manifest = remoteDeploymentManifest(remoteRoot);
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "cat") {
        order.push("manifest");
        return { code: 0, stdout: JSON.stringify(manifest), stderr: "" };
      }
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes(" stop nautilo-server")) order.push("stop");
      if (call.cmd === "sh" && script.includes(" start nautilo-server")) order.push("start");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        doctor: async () => {
          order.push("doctor");
        },
      }),
    );
    driver.backup = (async (_p, opts) => {
      order.push("backup");
      return opts?.toPath ?? "/x";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      order.push("health");
    }) as typeof driver.checkServerHealth;

    await driver.upgrade(remoteProfile);

    expect(order).toEqual([
      "manifest",
      "doctor",
      "manifest",
      "stop",
      "backup",
      "deploy",
      "health",
    ]);
    const lifecycleCalls = calls.filter(
      (call) =>
        call.cmd === "sh" &&
        ((call.args[1] ?? "").includes(" stop nautilo-server") ||
          (call.args[1] ?? "").includes(" start nautilo-server")),
    );
    expect(lifecycleCalls).toHaveLength(1);
    for (const call of lifecycleCalls) {
      expect(call.args[1]).toContain(`${remoteRoot}/docker-compose.yml`);
      expect(call.args[1]).toMatch(/ (?:stop|start) nautilo-server/);
      expect(call.args[1]).not.toContain("app-postgres");
      expect(call.args[1]).not.toContain("logto-postgres");
      expect(call.args[1]).not.toContain(" logto");
      expect(call.args[1]).not.toContain(" caddy");
      expect(call.args[1]).not.toContain(" office");
      expect(call.args[1]).not.toContain("DOCKER_HOST");
      expect(call.args[1]).not.toContain(".remote-staging");
      expect(call.opts.env?.["DOCKER_HOST"]).toBeUndefined();
    }
    expect(calls.some((call) => call.cmd === "docker")).toBe(false);
  });

  test("remote deploy failure rolls back through the SSH-native bundle restore", async () => {
    const remoteRoot = "/opt/nautilo";
    const remoteDefault: ComposeDriverProfile = {
      name: "remote-default",
      transport: "remote",
      lifecycle: "compose",
      from_source: false,
      image_ref: canonicalImageRef,
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const manifest = {
      ...remoteDeploymentManifest("/opt/nautilo-prod"),
      instanceId: "",
      composeProjectName: "nautilo",
      remoteRoot,
    };
    const localRoot = mktmp("remote-rollback-home-");
    const bundleDir = join(
      localRoot,
      "backups",
      "auto-pre-upgrade-20260519T123456Z",
    );
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, "nautilo.sql.gz"), "");
    writeFileSync(join(bundleDir, "logto_nautilo.sql.gz"), "");
    writeFileSync(join(bundleDir, "artifacts.tgz"), "");
    writeFileSync(join(bundleDir, "instance.env"), "LOGTO_ENDPOINT=http://localhost:3301\n");
    writeFileSync(
      join(bundleDir, "manifest.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-05-19T12:34:56.000Z",
        profileName: remoteDefault.name,
        instanceId: "",
        transport: "remote",
        composeProjectName: "nautilo",
        image: {
          mode: "registry",
          repoDigest: "ghcr.io/agentsea/nautilo-server@sha256:abc",
          tag: "main",
        },
        contents: {
          nautiloDb: true,
          logtoDb: true,
          artifacts: true,
          instanceEnv: true,
          operatorFiles: false,
          caddyData: false,
          caddyConfig: false,
          localCaCerts: false,
        },
        https: "off",
      }),
    );
    const events: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "cat") {
        return { code: 0, stdout: JSON.stringify(manifest), stderr: "" };
      }
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("to_jsonb(identity_row)")) {
        return {
          code: 0,
          stdout: "__NAUTILO_INSTANCE_IDENTITY_ABSENT__\n",
          stderr: "",
        };
      }
      if (call.cmd === "sh" && script.includes("docker compose")) {
        if (script.includes("pull")) events.push("pull");
        else if (script.includes("up -d") && script.includes("--no-build")) events.push("up");
        else if (script.includes("stop")) events.push("stop");
        else if (script.includes("start")) events.push("start");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec((call) =>
      call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 3.2.7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => remoteRoot,
        resolveLocalInstanceRootDir: () => localRoot,
        ensureForgotPasswordWebhookSecret: async () => "restore-secret",
      }),
    );
    driver.backup = (async () => bundleDir) as typeof driver.backup;
    driver.deploy = (async () => {
      throw new Error("remote deploy exploded");
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      events.push("re-health");
    }) as typeof driver.checkServerHealth;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(remoteDefault)).rejects.toThrow(
      /rolled back.*post-rollback health = ready/,
    );

    const composeScripts = calls
      .filter((call) => call.cmd === "sh" && (call.args[1] ?? "").includes("docker compose"))
      .map((call) => call.args[1] ?? "");
    expect(composeScripts.some((script) => script.includes("deploy.restore-overlay.yml"))).toBe(
      true,
    );
    expect(events).toContain("up");
    expect(events.filter((event) => event === "stop").length).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event === "start").length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1]).toBe("re-health");
    expect(calls.some((call) => call.cmd === "docker")).toBe(false);
    for (const script of composeScripts) {
      expect(script).not.toContain("DOCKER_HOST");
      expect(script).not.toContain(".remote-staging");
    }
  });
});
describe("D420 1.2.2 upgrade strategy matrix", () => {
  const localCell: ComposeDriverProfile = {
    name: "local-cell",
    transport: "local",
    lifecycle: "compose",
    image_ref: canonicalImageRef,
  };
  const lanCell: ComposeDriverProfile = {
    name: "lan-cell",
    transport: "remote",
    lifecycle: "compose",
    https: "off",
    image_ref: canonicalImageRef,
    ssh: { host: "10.0.0.2", user: "root" },
  };
  const remoteCell: ComposeDriverProfile = {
    name: "remote-cell",
    transport: "remote",
    lifecycle: "compose",
    https: "letsencrypt",
    domain: "app.example.com",
    image_ref: canonicalImageRef,
    ssh: { host: "app.example.com", user: "root" },
  };

  const locations: Array<{
    label: UpgradeLocation;
    profile: ComposeDriverProfile;
    transport: "local" | "remote";
    https: "off" | "letsencrypt";
  }> = [
    { label: "local", profile: localCell, transport: "local", https: "off" },
    { label: "lan", profile: lanCell, transport: "remote", https: "off" },
    { label: "remote", profile: remoteCell, transport: "remote", https: "letsencrypt" },
  ];

  const artifacts: Array<{
    artifact: UpgradeArtifact;
    build: (scope: UpgradeScope) => UpgradeOptions;
    expectedImageRef: string | null;
  }> = [
    {
      artifact: "source",
      build: (scope) => ({ artifact: "source", scope, waitForMs: 30_000 }),
      expectedImageRef: null,
    },
    {
      artifact: "image",
      build: (scope) => ({
        artifact: "image",
        imageRef: canonicalImageRef,
        scope,
        waitForMs: 30_000,
      }),
      expectedImageRef: canonicalImageRef,
    },
  ];

  const scopes: UpgradeScope[] = ["server-only", "full"];

  // One named test per cell so a constant strategy selection cannot pass:
  // every cell asserts a different combination of location/transport/https,
  // artifact, imageRef, scope, and previous-image capture.
  for (const loc of locations) {
    for (const art of artifacts) {
      for (const scope of scopes) {
        test(`${loc.label} + ${art.artifact} + ${scope} resolves the correct strategy cell`, () => {
          const strategy = resolveUpgradeStrategy(loc.profile, art.build(scope));
          expect(strategy).toEqual({
            location: loc.label,
            transport: loc.transport,
            https: loc.https,
            artifact: art.artifact,
            imageRef: art.expectedImageRef,
            scope,
            previousImageCapture:
              scope === "server-only" ? "running-container" : "backup-bundle",
          });
        });
      }
    }
  }

  test("image cell without --image resolves the configured canonical image digest", () => {
    const strategy = resolveUpgradeStrategy(lanCell, {
      artifact: "image",
      scope: "server-only",
      waitForMs: 30_000,
    });
    expect(strategy.artifact).toBe("image");
    expect(strategy.imageRef).toBe(canonicalImageRef);
    expect(strategy.scope).toBe("server-only");
    expect(strategy.previousImageCapture).toBe("running-container");
  });

  test("LAN and remote share the remote adapter but split on HTTPS (no third transport)", () => {
    const lan = resolveUpgradeStrategy(lanCell, { artifact: "image", scope: "server-only", waitForMs: 30_000 });
    const remote = resolveUpgradeStrategy(remoteCell, { artifact: "image", scope: "server-only", waitForMs: 30_000 });
    expect(lan.transport).toBe("remote");
    expect(remote.transport).toBe("remote");
    expect(lan.location).toBe("lan");
    expect(remote.location).toBe("remote");
    expect(lan.https).toBe("off");
    expect(remote.https).toBe("letsencrypt");
  });

  test("applyUpgradeStrategy pins source as from_source=true and drops image_ref", () => {
    const profile: ComposeDriverProfile = {
      ...remoteCell,
      image_ref: canonicalImageRef,
    };
    const effective = applyUpgradeStrategy(
      profile,
      resolveUpgradeStrategy(profile, { artifact: "source", scope: "full", waitForMs: 30_000 }),
    );
    expect(effective.from_source).toBe(true);
    expect(effective.image_ref).toBeUndefined();
  });

  test("applyUpgradeStrategy pins an explicit image override as from_source=false + image_ref", () => {
    const effective = applyUpgradeStrategy(
      localCell,
      resolveUpgradeStrategy(localCell, {
        artifact: "image",
        imageRef: canonicalImageRef,
        scope: "server-only",
        waitForMs: 30_000,
      }),
    );
    expect(effective.from_source).toBe(false);
    expect(effective.image_ref).toBe(canonicalImageRef);
  });

  test("applyUpgradeStrategy pins a configured canonical image as from_source=false", () => {
    const effective = applyUpgradeStrategy(
      lanCell,
      resolveUpgradeStrategy(lanCell, { artifact: "image", scope: "full", waitForMs: 30_000 }),
    );
    expect(effective.from_source).toBe(false);
    expect(effective.image_ref).toBe(canonicalImageRef);
  });

  test("rejects --from-sources combined with --image", () => {
    expect(() =>
      resolveUpgradeStrategy(localCell, {
        artifact: "source",
        imageRef: canonicalImageRef,
        scope: "full",
        waitForMs: 30_000,
      }),
    ).toThrow(/--from-sources and --image cannot be used together/);
  });

  test("rejects an image cell with no --image override and no configured digest", () => {
    const noImage: ComposeDriverProfile = {
      name: "local-notag",
      transport: "local",
      lifecycle: "compose",
    };
    expect(() =>
      resolveUpgradeStrategy(noImage, { artifact: "image", scope: "server-only", waitForMs: 30_000 }),
    ).toThrow(/requires a configured immutable runtime image/);
  });

  test("rejects mutable, private, and uppercase image overrides", () => {
    for (const imageRef of [
      "ghcr.io/agentsea/nautilo-runtime-v2:main",
      "ghcr.io/agentsea/nautilo-server@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1",
      "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74C76A08D65399D83F752CAE76CAA2BB4B0A4218E57F74ECE87AC8A5A1C06EC1",
    ]) {
      expect(() => resolveUpgradeStrategy(localCell, {
        artifact: "image",
        imageRef,
        scope: "server-only",
        waitForMs: 30_000,
      })).toThrow(/requires ghcr\.io\/agentsea\/nautilo-runtime-v2@sha256/);
    }
  });

  test("canonical request defaults scope to server-only; absent options retain legacy full scope", () => {
    const canonicalServerOnly = resolveUpgradeStrategy(localCell, {
      artifact: "image",
      waitForMs: 30_000,
    });
    expect(canonicalServerOnly.scope).toBe("server-only");
    expect(canonicalServerOnly.previousImageCapture).toBe("running-container");

    const legacy = resolveUpgradeStrategy({ ...localCell, from_source: true });
    expect(legacy.scope).toBe("full");
    expect(legacy.previousImageCapture).toBe("backup-bundle");
    expect(legacy.artifact).toBe("source");
  });

  test("scope drives the upgrade branch: server-only delegates to releaseApply, full runs deploy", async () => {
    const localRoot = mktmp("upgrade-orchestrator-lan-home-");
    const lanManifest = {
      version: 1,
      instanceId: "",
      composeProjectName: "nautilo",
      lifecycle: "compose" as const,
      image: { mode: "registry" as const, reference: "ghcr.io/example/nautilo-server:stable" },
      remoteRoot: localRoot,
      https: "off" as const,
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:30:00.000Z",
    };
    const { exec: lanExec } = makeFakeExec((call) => {
      if (call.cmd === "cat" && call.args.some((a) => a.includes("deployment-manifest.json"))) {
        return { code: 0, stdout: `${JSON.stringify(lanManifest)}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec: lanExec,
        localExec: lanExec,
        resolveInstanceRootDir: () => localRoot,
      }),
    );
    const routed: string[] = [];
    let receivedProfile: ComposeDriverProfile | undefined;
    driver.releaseApply = (async (nextProfile) => {
      routed.push("releaseApply");
      receivedProfile = nextProfile;
      return {
        compatible: true,
        auth: {
          classification: "compatible",
          incoming: {
            version: 1,
            hash: "incoming",
            logtoEngine: { image: "ghcr.io/logto-io/logto:1.0.0", minimumVersion: "1.0.0" },
            impact: { requiresExplicitAuthReconcile: false, mayAffectExistingSessions: false },
          },
          applied: null,
          live: { logtoEngineImage: null, logtoEngineVersion: null, inspected: false },
          reasons: [],
          limitations: [],
        },
        artifact: {
          mode: "registry",
          requested: "ghcr.io/example/nautilo-server:sha-1",
          immutableId: "sha256:1",
        },
        limitations: [],
      };
    }) as typeof driver.releaseApply;
    driver.deploy = (async () => {
      routed.push("deploy");
    }) as typeof driver.deploy;
    driver.backup = (async (_p, o) => o?.toPath ?? "/x") as typeof driver.backup;
    driver.checkServerHealth = (async () => {}) as typeof driver.checkServerHealth;

    // LAN + image + server-only -> releaseApply with the pinned image profile.
    await driver.upgrade(lanCell, {
      artifact: "image",
      imageRef: canonicalImageRef,
      scope: "server-only",
      waitForMs: 30_000,
    });
    expect(routed).toEqual(["releaseApply"]);
    expect(receivedProfile).toMatchObject({
      from_source: false,
      image_ref: canonicalImageRef,
    });

    // local + source + full -> full deploy path (backup bundle capture),
    // not the server-only releaseApply lane.
    routed.length = 0;
    const { exec } = makeFakeExec((call) => {
      if (call.args.includes("stop") && call.args.includes("nautilo-server")) return { code: 0, stdout: "", stderr: "" };
      if (call.args.includes("start") && call.args.includes("nautilo-server")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const fullDriver = new ComposeDriver(makeDeps({ exec }));
    let fullDeployProfile: ComposeDriverProfile | undefined;
    fullDriver.backup = (async (_p, o) => o?.toPath ?? "/x") as typeof fullDriver.backup;
    fullDriver.deploy = (async (nextProfile) => {
      fullDeployProfile = nextProfile;
      routed.push("deploy");
    }) as typeof fullDriver.deploy;
    fullDriver.checkServerHealth = (async () => {}) as typeof fullDriver.checkServerHealth;

    await fullDriver.upgrade(localCell, {
      artifact: "source",
      scope: "full",
      waitForMs: 30_000,
    });
    expect(routed).toEqual(["deploy"]);
    expect(fullDeployProfile).toMatchObject({ from_source: true });
  });
});
// D420 (Wave 3 task 3.3.1) — fault-inject the COMPLETE full-upgrade transaction.
// Each injected failure must resolve to exactly one deterministic outcome:
//   (a) a healthy full-bundle rollback to the prior image/DB/config/volumes
//       (restore + rollback health proven), with the EXACT bundle path in the
//       operator message; or
//   (b) an explicit CRITICAL manual-recovery outcome carrying the EXACT bundle
//       path; or
//   (c) `--no-rollback`: leave the failed target as-is and emit the EXACT
//       bundle path + `nautilo restore` guidance.
// The table runs both artifact lanes the full path permits (source and image)
// so a constant rollback implementation cannot pass on one artifact and fail
// on the other. No maintenance handle is wired here (legacy/no-drain caller);
// the maintenance-lease outcomes are proven in upgrade-maintenance-drain.test.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Reusable full-upgrade fault harness. Stubs the post-strategy mutation points
// (backup/deploy/restore/checkServerHealth) and records the lifecycle order so
// each table row can assert the deterministic phase sequence + exact bundle.
function wireFullUpgradeFault(
  over: {
    deploy?: () => void | Promise<void>;
    restore?: () => void | Promise<void>;
    health?: (call: number) => void | Promise<void>;
  } = {},
): {
  driver: ComposeDriver;
  order: string[];
  restoreCalls: Array<{ opts: RestoreOptions }>;
  healthCalls: number[];
  localRoot: string;
  bundleDir: string;
} {
  const order: string[] = [];
  const localRoot = mktmp("upgrade-fault-root-");
  const { exec } = makeFakeExec((call) => {
    if (call.args.includes("stop") && call.args.includes("nautilo-server")) {
      order.push("stop");
    }
    if (call.args.includes("start") && call.args.includes("nautilo-server")) {
      order.push("start");
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const driver = new ComposeDriver(
    makeDeps({
      exec,
      resolveInstanceRootDir: () => localRoot,
      resolveLocalInstanceRootDir: () => localRoot,
    }),
  );
  driver.backup = (async (_p, o) => {
    order.push("backup");
    return o?.toPath ?? "/x";
  }) as typeof driver.backup;
  driver.deploy = (async () => {
    order.push("deploy");
    if (over.deploy) await over.deploy();
  }) as typeof driver.deploy;
  const restoreCalls: Array<{ opts: RestoreOptions }> = [];
  driver.restore = (async (_p, opts) => {
    restoreCalls.push({ opts });
    order.push("restore");
    if (over.restore) await over.restore();
  }) as typeof driver.restore;
  const healthCalls: number[] = [];
  driver.checkServerHealth = (async () => {
    healthCalls.push(healthCalls.length + 1);
    order.push("health");
    if (over.health) await over.health(healthCalls.length);
  }) as typeof driver.checkServerHealth;
  // makeDeps pins now() to 2026-05-19T12:34:56Z → stamp 20260519T123456Z.
  const bundleDir = join(localRoot, "backups", "auto-pre-upgrade-20260519T123456Z");
  return { driver, order, restoreCalls, healthCalls, localRoot, bundleDir };
}

describe("D420 (3.3.1) full upgrade transaction fault injection", () => {
  const sourceLane: ComposeDriverProfile = {
    name: "local-source-fault",
    transport: "local",
    lifecycle: "compose",
    from_source: true,
  };
  const imageLane: ComposeDriverProfile = {
    name: "local-image-fault",
    transport: "local",
    lifecycle: "compose",
    from_source: false,
    image_ref: canonicalImageRef,
  };

  const lanes: Array<{ label: string; profile: ComposeDriverProfile }> = [
    { label: "source", profile: sourceLane },
    { label: "image", profile: imageLane },
  ];

  for (const lane of lanes) {
    test(`${lane.label} lane: server replacement/startup failure rolls back to the prior bundle + image and proves health`, async () => {
      const { driver, bundleDir, restoreCalls, order } = wireFullUpgradeFault({
        deploy: () => {
          throw new Error("deploy/startup exploded");
        },
        health: () => {
          /* post-rollback health = ready */
        },
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driver.upgrade(lane.profile)).rejects.toThrow(
        new RegExp(
          `rolled back to the prior image.*post-rollback health = ready.*Bundle: ${escapeRegExp(bundleDir)}.*deploy/startup exploded`,
        ),
      );

      // Exactly one full-bundle restore with the exact bundle path; the
      // transaction ordered stop → backup → deploy → restore → health.
      expect(restoreCalls).toHaveLength(1);
      expect(restoreCalls[0]!.opts).toEqual({ fromPath: bundleDir, force: true });
      expect(order).toEqual(["stop", "backup", "deploy", "restore", "health"]);
    });

    test(`${lane.label} lane: post-migration health failure rolls back through the full bundle (no down-migration)`, async () => {
      const { driver, bundleDir, restoreCalls, healthCalls } = wireFullUpgradeFault({
        deploy: () => {
          /* deploy ok; migrations may have applied */
        },
        health: (call) => {
          if (call === 1) throw new Error("incoming not ready");
          // call 2: post-rollback health = ready
        },
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driver.upgrade(lane.profile)).rejects.toThrow(
        new RegExp(
          `full-bundle rollback succeeded.*post-rollback health = ready.*Bundle: ${escapeRegExp(bundleDir)}.*incoming not ready`,
        ),
      );

      // Snapshot restore (not an intelligent down-migration) is the only
      // recovery action; both health calls ran (deploy-try + rollback).
      expect(restoreCalls).toHaveLength(1);
      expect(restoreCalls[0]!.opts).toEqual({ fromPath: bundleDir, force: true });
      expect(healthCalls).toEqual([1, 2]);
    });

    test(`${lane.label} lane: restore failure during rollback is CRITICAL with the exact bundle`, async () => {
      const { driver, bundleDir, restoreCalls, healthCalls } = wireFullUpgradeFault({
        deploy: () => {
          throw new Error("deploy exploded");
        },
        restore: () => {
          throw new Error("gunzip failed on nautilo.sql.gz");
        },
        health: () => {
          throw new Error("health should not be reached when restore failed");
        },
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driver.upgrade(lane.profile)).rejects.toThrow(
        new RegExp(
          `CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*Bundle: ${escapeRegExp(bundleDir)}.*gunzip failed.*deploy exploded`,
        ),
      );

      // Restore was attempted (and failed); rollback health was never reached.
      expect(restoreCalls).toHaveLength(1);
      expect(healthCalls).toEqual([]);
    });

    test(`${lane.label} lane: rollback-health failure is CRITICAL with the exact bundle (restore succeeded, health did not)`, async () => {
      const { driver, bundleDir, restoreCalls, healthCalls } = wireFullUpgradeFault({
        deploy: () => {
          throw new Error("deploy exploded");
        },
        restore: () => {
          /* restore succeeds */
        },
        health: () => {
          throw new Error("still broken");
        },
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driver.upgrade(lane.profile)).rejects.toThrow(
        new RegExp(
          `CRITICAL.*full-bundle rollback failed.*post-rollback health = FAILED.*Bundle: ${escapeRegExp(bundleDir)}.*still broken.*deploy exploded`,
        ),
      );

      expect(restoreCalls).toHaveLength(1);
      expect(healthCalls).toEqual([1]);
    });

    test(`${lane.label} lane: --no-rollback leaves the failed target as-is and reports the exact bundle`, async () => {
      const { driver, bundleDir, restoreCalls, order } = wireFullUpgradeFault({
        deploy: () => {
          throw new Error("deploy exploded");
        },
      });

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driver.upgrade(lane.profile, { noRollback: true })).rejects.toThrow(
        new RegExp(
          `--no-rollback.*leaving the failed target as-is.*${escapeRegExp(bundleDir)}.*nautilo restore.*deploy exploded`,
        ),
      );

      // No restore is attempted: the failed target is left in place.
      expect(restoreCalls).toEqual([]);
      expect(order).not.toContain("restore");
    });
  }
});

// D420 (Wave 3 task 3.3.2) — runtime acceptance gate. `checkRuntimeAcceptance`
// is the post-deploy/post-rollback verification that replaces `/health`-alone.
// It must (1) retain the `/health` poll, (2) verify target/profile instance
// identity via `/api/setup/status`, (3) confirm the SPA serves HTML, (4) run
// REAL credentialed app-role connection probes for `nautilo` and
// `nautilo_agent` using the runtime `instance.env` passwords, and (5) hit
// Logto OIDC discovery. Any probe failure throws so the upgrade/rollback
// orchestration never reports success on a partially restored target. It
// must NOT require a browser or end-user login.
describe("D420 (3.3.2) ComposeDriver runtime acceptance gate", () => {
  const acceptanceProfile: ComposeDriverProfile = {
    name: "local-acceptance",
    transport: "local",
    lifecycle: "compose",
    from_source: true,
  };

  function makeAcceptanceFetch(over: {
    health?: { status: number };
    setup?: { status: number; body?: string };
    spa?: { status: number; body?: string };
    oidc?: { status: number; body?: string };
  } = {}): typeof fetch {
    return (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/health")) {
        return new Response("ok", { status: over.health?.status ?? 200 });
      }
      if (url.includes("/api/setup/status")) {
        const s = over.setup;
        if (s && s.status !== 200) return new Response("", { status: s.status });
        const body = s?.body ?? JSON.stringify({ instanceId: "" });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/oidc/.well-known/openid-configuration")) {
        const o = over.oidc;
        if (o && o.status !== 200) return new Response("", { status: o.status });
        const body = o?.body ?? JSON.stringify({ issuer: "http://localhost/logto" });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // SPA root is served by the Compose server's public origin.
      const sp = over.spa;
      return new Response(
        sp?.body ?? "<html><body>workbench</body></html>",
        { status: sp?.status ?? 200 },
      );
    }) as unknown as typeof fetch;
  }

  function makeAcceptanceDeps(over: {
    fetch?: typeof fetch;
    exec?: ExecFn;
  } = {}): { driver: ComposeDriver; localRoot: string; calls: ExecCall[] } {
    const localRoot = mktmp("acceptance-home-");
    writeFileSync(
      join(localRoot, "instance.env"),
      "NAUTILO_DB_PASSWORD=nautilo-pw\nNAUTILO_AGENT_DB_PASSWORD=agent-pw\n",
    );
    const { exec, calls } = makeFakeExec();
    const deps = makeDeps({
      resolveInstanceRootDir: () => localRoot,
      resolveLocalInstanceRootDir: () => localRoot,
      fetch: over.fetch ?? makeAcceptanceFetch(),
      exec: over.exec ?? exec,
    });
    return { driver: new ComposeDriver(deps), localRoot, calls };
  }

  test("happy path: all probes succeed and checkRuntimeAcceptance resolves", async () => {
    const { driver, calls } = makeAcceptanceDeps();

    await driver.checkRuntimeAcceptance(acceptanceProfile);

    // All app-cluster role probes ran (nautilo + nautilo_agent + dormant crypto).
    const probeCalls = calls.filter(
      (c) => c.cmd === "sh" && (c.args[1] ?? "").includes("psql"),
    );
    expect(probeCalls).toHaveLength(3);
    const nautiloProbe = probeCalls.find((c) =>
      (c.args[1] ?? "").includes("psql -U nautilo "),
    );
    const agentProbe = probeCalls.find((c) =>
      (c.args[1] ?? "").includes("psql -U nautilo_agent "),
    );
    expect(nautiloProbe).toBeDefined();
    expect(agentProbe).toBeDefined();
    // The probes consume their matching target-container environment variables
    // rather than embedding a password in a host command or connection URL.
    expect(nautiloProbe!.args[1]).toContain("NAUTILO_DB_PASSWORD");
    expect(agentProbe!.args[1]).toContain("NAUTILO_AGENT_DB_PASSWORD");
    const cryptoProbe = calls.find(
      (c) =>
        c.cmd === "sh" &&
        (c.args[1] ?? "").includes("psql -U nautilo_crypto"),
    );
    expect(cryptoProbe).toBeDefined();
    expect(cryptoProbe!.args[1]).toContain("NAUTILO_CRYPTO_DB_PASSWORD");
    expect(nautiloProbe!.args[1]).toContain("SELECT 1");
    expect(agentProbe!.args[1]).toContain("SELECT 1");
    expect(nautiloProbe!.args[1]).not.toContain("nautilo-pw");
    expect(agentProbe!.args[1]).not.toContain("agent-pw");

    // M215/M274 — the postgres.js runtime pool probe execs into
    // nautilo-server and exercises both restricted runtime pools (not direct
    // psql alone).
    const runtimeProbe = calls.find(
      (c) =>
        c.cmd === "sh" &&
        (c.args[1] ?? "").includes('import postgres from "postgres"'),
    );
    expect(runtimeProbe).toBeDefined();
    expect(runtimeProbe!.args[1]).toContain("nautilo-server");
    expect(runtimeProbe!.args[1]).toContain("DB_AGENT_CONNECTION_STRING");
    expect(runtimeProbe!.args[1]).toContain("DB_CRYPTO_CONNECTION_STRING");
    expect(runtimeProbe!.args[1]).toContain(
      "SELECT current_user AS role, ${1}::int AS ok",
    );
    expect(runtimeProbe!.args[1]).not.toContain("db.localtest.me");
    expect(runtimeProbe!.args[1]).not.toContain("agent-pw");
  });

  test("remote/LAN app-role probes use the profile Docker context and target container credentials", async () => {
    const lanProfile: ComposeDriverProfile = {
      name: "lan-acceptance",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      instance_id: "lan-acceptance",
      ssh: { host: "10.20.30.40", user: "deploy" },
    };
    // The probe must route Docker to the target profile, never a local daemon
    // that happens to be healthy. The credential is expanded only inside the
    // target app-postgres container.
    const fetch = makeAcceptanceFetch({
      setup: { status: 200, body: JSON.stringify({ instanceId: "lan-acceptance" }) },
    });
    const { driver, calls } = makeAcceptanceDeps({ fetch });

    await driver.checkRuntimeAcceptance(lanProfile);

    const probeCalls = calls.filter(
      (c) => c.cmd === "sh" && (c.args[1] ?? "").includes("psql"),
    );
    expect(probeCalls).toHaveLength(3);
    for (const call of probeCalls) {
      expect(call.opts.env?.["DOCKER_HOST"]).toBe("ssh://deploy@10.20.30.40");
    }
    expect(
      probeCalls.some((c) => (c.args[1] ?? "").includes("psql -U nautilo ")),
    ).toBe(true);
    expect(
      probeCalls.some((c) => (c.args[1] ?? "").includes("psql -U nautilo_agent ")),
    ).toBe(true);
    expect(
      probeCalls.some((c) => (c.args[1] ?? "").includes("NAUTILO_DB_PASSWORD")),
    ).toBe(true);
    expect(
      probeCalls.some((c) => (c.args[1] ?? "").includes("NAUTILO_AGENT_DB_PASSWORD")),
    ).toBe(true);
    expect(
      probeCalls.some((c) => (c.args[1] ?? "").includes("NAUTILO_CRYPTO_DB_PASSWORD")),
    ).toBe(true);
    for (const call of probeCalls) {
      expect(call.args[1]).not.toContain("nautilo-pw");
      expect(call.args[1]).not.toContain("agent-pw");
    }

    // M215 — runtime pool probe also routes Docker to the target profile daemon.
    const runtimeProbe = calls.find(
      (c) =>
        c.cmd === "sh" &&
        (c.args[1] ?? "").includes('import postgres from "postgres"'),
    );
    expect(runtimeProbe).toBeDefined();
    expect(runtimeProbe!.opts.env?.["DOCKER_HOST"]).toBe("ssh://deploy@10.20.30.40");
    expect(runtimeProbe!.args[1]).not.toContain("agent-pw");
  });

  test("instance identity mismatch throws (live instanceId != profile instance_id)", async () => {
    const fetch = makeAcceptanceFetch({
      setup: { status: 200, body: JSON.stringify({ instanceId: "wrong-id" }) },
    });
    const profileWithId: ComposeDriverProfile = {
      ...acceptanceProfile,
      instance_id: "expected-id",
    };
    const { driver } = makeAcceptanceDeps({ fetch });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(profileWithId)).rejects.toThrow(
      /runtime acceptance failed: target instanceId mismatch.*profile=expected-id.*live=wrong-id/,
    );
  });

  test("SPA returning non-HTML throws", async () => {
    const fetch = makeAcceptanceFetch({
      spa: { status: 200, body: "plain-text-not-html" },
    });
    const { driver } = makeAcceptanceDeps({ fetch });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: SPA .* returned a non-HTML body/,
    );
  });

  test("SPA returning a non-200 status throws", async () => {
    const fetch = makeAcceptanceFetch({ spa: { status: 502 } });
    const { driver } = makeAcceptanceDeps({ fetch });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: SPA GET .* returned HTTP 502/,
    );
  });

  test("app-role connection probe failure throws (credentialed probe, not a privilege check)", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("psql")) {
        return { code: 1, stdout: "", stderr: "password authentication failed for user nautilo" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { driver } = makeAcceptanceDeps({ exec });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: nautilo app-role connection probe failed \(exit 1\)/,
    );
    // The probe was actually attempted (the gate did not skip credentialed
    // verification in favor of a privilege-only check).
    expect(
      calls.some((c) => c.cmd === "sh" && (c.args[1] ?? "").includes("psql")),
    ).toBe(true);
  });

  test("missing target container app-role password fails closed", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("psql")) {
        return { code: 1, stdout: "", stderr: "NAUTILO_DB_PASSWORD is not set" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { driver } = makeAcceptanceDeps({ exec });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: nautilo app-role connection probe failed \(exit 1\)/,
    );
    const probe = calls.find(
      (c) => c.cmd === "sh" && (c.args[1] ?? "").includes("psql -U nautilo "),
    );
    expect(probe).toBeDefined();
    expect(probe!.args[1]).toContain("NAUTILO_DB_PASSWORD");
    expect(probe!.args[1]).not.toContain("nautilo-pw");
  });

  test("nautilo_crypto credentialed acceptance failure aborts the lifecycle", async () => {
    const { exec } = makeFakeExec((call) => {
      const command = call.args[1] ?? "";
      if (call.cmd === "sh" && command.includes("psql -U nautilo_crypto")) {
        return {
          code: 1,
          stdout: "",
          stderr: "password authentication failed for user nautilo_crypto",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { driver } = makeAcceptanceDeps({ exec });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: nautilo_crypto app-role connection probe failed/,
    );
  });

  test("restricted postgres.js runtime pool probe failure throws", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes('import postgres from "postgres"')
      ) {
        return {
          code: 1,
          stdout: "",
          stderr: "connection refused",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { driver } = makeAcceptanceDeps({ exec });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: restricted postgres\.js runtime pool probes \(nautilo_agent \+ nautilo_crypto\)/,
    );
    const runtimeProbe = calls.find(
      (c) =>
        c.cmd === "sh" &&
        (c.args[1] ?? "").includes('import postgres from "postgres"'),
    );
    expect(runtimeProbe).toBeDefined();
    const psqlProbes = calls.filter(
      (c) => c.cmd === "sh" && (c.args[1] ?? "").includes("psql"),
    );
    expect(psqlProbes).toHaveLength(3);
  });

  test("restricted postgres.js runtime pool probe fails closed when DB_AGENT_CONNECTION_STRING is unset", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes('import postgres from "postgres"')
      ) {
        return {
          code: 1,
          stdout: "",
          stderr: "DB_AGENT_CONNECTION_STRING is not set",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { driver } = makeAcceptanceDeps({ exec });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: restricted postgres\.js runtime pool probes \(nautilo_agent \+ nautilo_crypto\).*DB_AGENT_CONNECTION_STRING is not set/,
    );
    const runtimeProbe = calls.find(
      (c) =>
        c.cmd === "sh" &&
        (c.args[1] ?? "").includes('import postgres from "postgres"'),
    );
    expect(runtimeProbe).toBeDefined();
    expect(runtimeProbe!.args[1]).toContain("DB_AGENT_CONNECTION_STRING");
    expect(runtimeProbe!.args[1]).not.toContain("agent-pw");
  });

  test("Logto OIDC discovery failure throws", async () => {
    const fetch = makeAcceptanceFetch({ oidc: { status: 503 } });
    const { driver } = makeAcceptanceDeps({ fetch });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: Logto OIDC discovery GET .* returned HTTP 503/,
    );
  });

  test("Logto OIDC discovery with no issuer throws", async () => {
    const fetch = makeAcceptanceFetch({
      oidc: { status: 200, body: JSON.stringify({ issuer: "" }) },
    });
    const { driver } = makeAcceptanceDeps({ fetch });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkRuntimeAcceptance(acceptanceProfile)).rejects.toThrow(
      /runtime acceptance failed: Logto OIDC discovery .* has no issuer/,
    );
  });

  test("checkServerHealth delegates to checkRuntimeAcceptance (a failing gate makes checkServerHealth throw)", async () => {
    const fetch = makeAcceptanceFetch({ health: { status: 503 } });
    const { driver } = makeAcceptanceDeps({ fetch });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.checkServerHealth(acceptanceProfile)).rejects.toThrow(
      /nautilo-server \/health never became ready/,
    );
  });
});

// D427 (Wave 4 task 4.x) — remote runtime-acceptance + health-poll transport.
// On a split-DNS upgrade (v1 live at 192.0.2.40 instanceId upgrade-fixture,
// public DNS pointing v2 at 198.51.100.40), the gate's global fetch on
// `https://upgrade.example.test` hits v2 and falsely fails/validates v1. With the
// SSH-local transport wired, remote acceptance + health polling route through
// SSH authority on the target (loopback docker-exec for /health +
// /api/setup/status, --resolve vhost curl for HTTPS SPA/OIDC) and never touch
// `deps.fetch` on public DNS. Local behavior is unchanged (proven by the
// acceptance tests above, which never wire the transport).
describe("D427 remote runtime-acceptance transport (false-v2 prevention)", () => {
  const remoteLeProfile: ComposeDriverProfile = {
    name: "remote-le",
    transport: "remote",
    lifecycle: "compose",
    from_source: true,
    instance_id: "upgrade-fixture",
    https: "letsencrypt",
    domain: "upgrade.example.test",
    ssh: { host: "192.0.2.40", user: "root" },
  };

  /** Fake ssh spawn that serves the gate's URLs from the TARGET, not public DNS. */
  function fakeTargetSpawn(opts: {
    health?: { status: number; body?: string };
    setup?: { status: number; body?: string };
    spa?: { status: number; body?: string };
    oidc?: { status: number; body?: string };
  } = {}): { spawnFn: RemoteRuntimeFetchSpawn; calls: { args: string[] }[] } {
    const calls: { args: string[] }[] = [];
    const spawnFn: RemoteRuntimeFetchSpawn = (
      _cmd: string,
      args: string[],
      _so: SpawnOptions,
    ): ChildProcess => {
      calls.push({ args });
      const joined = args.join(" ");
      const child = new EventEmitter() as ChildProcess;
      child.stdout = new PassThrough() as ChildProcess["stdout"];
      child.stderr = new PassThrough() as ChildProcess["stderr"];
      queueMicrotask(() => {
        let out: { stdout: string; stderr: string; code: number };
        if (joined.includes("http://127.0.0.1:3001/health")) {
          const h = opts.health ?? { status: 200, body: "ok" };
          out = { stdout: `${h.body}\n${h.status}`, stderr: "", code: 0 };
        } else if (joined.includes("http://127.0.0.1:3001/api/setup/status")) {
          const s = opts.setup ?? {
            status: 200,
            body: JSON.stringify({ instanceId: "upgrade-fixture" }),
          };
          out = { stdout: `${s.body}\n${s.status}`, stderr: "", code: 0 };
        } else if (joined.includes("auth.upgrade.example.test")) {
          const o = opts.oidc ?? {
            status: 200,
            body: JSON.stringify({ issuer: "https://auth.upgrade.example.test/oidc" }),
          };
          out = { stdout: `${o.body}\n${o.status}`, stderr: "", code: 0 };
        } else {
          // SPA vhost (https://upgrade.example.test/) — the public URL host is
          // curled via --resolve on the target Caddy, not public DNS.
          const sp = opts.spa ?? { status: 200, body: "<html>spa</html>" };
          out = { stdout: `${sp.body}\n${sp.status}`, stderr: "", code: 0 };
        }
        (child.stdout as PassThrough).end(out.stdout);
        (child.stderr as PassThrough).end(out.stderr);
        child.emit("close", out.code);
      });
      return child;
    };
    return { spawnFn, calls };
  }

  function makeRemoteAcceptanceDeps(over: {
    fetch?: typeof fetch;
    spawnFn?: RemoteRuntimeFetchSpawn;
  } = {}): { driver: ComposeDriver; localRoot: string; fetchCalls: string[] } {
    const localRoot = mktmp("remote-acceptance-home-");
    writeFileSync(
      join(localRoot, "instance.env"),
      "NAUTILO_DB_PASSWORD=nautilo-pw\nNAUTILO_AGENT_DB_PASSWORD=agent-pw\n",
    );
    const fetchCalls: string[] = [];
    const fallbackFetch = (async (input: string | URL) => {
      fetchCalls.push(String(input));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const baseFetch = over.fetch ?? fallbackFetch;
    // Wrap whatever fetch is used so fetchCalls records every public-DNS
    // call (proving the gate did or did NOT touch deps.fetch).
    const trackedFetch = (async (input: string | URL, init?: RequestInit) => {
      fetchCalls.push(String(input));
      return baseFetch(input, init);
    }) as unknown as typeof fetch;
    const { exec } = makeFakeExec();
    const deps = makeDeps({
      resolveInstanceRootDir: () => localRoot,
      resolveLocalInstanceRootDir: () => localRoot,
      fetch: trackedFetch,
      exec,
    });
    const driver = new ComposeDriver(deps);
    if (over.spawnFn !== undefined) {
      driver.setRemoteRuntimeAcceptanceTransport(
        buildRemoteRuntimeAcceptanceTransport({
          ssh: remoteLeProfile.ssh!,
          composeProjectName: "nautilo-upgrade-fixture",
          spawnFn: over.spawnFn,
          serverHealthTimeoutMs: 1000,
          pollIntervalMs: 1,
        }),
      );
    }
    return { driver, localRoot, fetchCalls };
  }

  test("remote acceptance routes /health + /api/setup/status through loopback docker exec, never deps.fetch on public DNS", async () => {
    const { spawnFn, calls } = fakeTargetSpawn();
    const { driver, fetchCalls } = makeRemoteAcceptanceDeps({ spawnFn });

    await driver.checkRuntimeAcceptance(remoteLeProfile);

    // deps.fetch (public DNS) is never invoked for the gate — the false-v2
    // vector is removed.
    expect(fetchCalls).toHaveLength(0);

    // /health and /api/setup/status were curled against container loopback
    // on the target, not the public URL host.
    const loopbackCalls = calls.filter((c) =>
      c.args.join(" ").includes("http://127.0.0.1:3001"),
    );
    expect(loopbackCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      calls.some((c) =>
        c.args.join(" ").includes("http://127.0.0.1:3001/health"),
      ),
    ).toBe(true);
    expect(
      calls.some((c) =>
        c.args
          .join(" ")
          .includes("http://127.0.0.1:3001/api/setup/status"),
      ),
    ).toBe(true);
    // The public URL host never appears in a loopback docker-exec command.
    for (const c of loopbackCalls) {
      expect(c.args.join(" ")).not.toContain("upgrade.example.test");
    }
    // ssh authority is the target host, not the operator's DNS.
    expect(calls[0]!.args).toContain("root@192.0.2.40");
  });

  test("remote SPA + OIDC use --resolve <hostname>:443:127.0.0.1 -k (target Caddy + SNI, not public DNS)", async () => {
    const { spawnFn, calls } = fakeTargetSpawn();
    const { driver } = makeRemoteAcceptanceDeps({ spawnFn });

    await driver.checkRuntimeAcceptance(remoteLeProfile);

    const joined = calls.map((c) => c.args.join(" "));
    // SPA vhost: --resolve for upgrade.example.test (the bare domain), NOT auth.*.
    const spaCall = joined.find(
      (j) =>
        j.includes("--resolve") &&
        j.includes("upgrade.example.test:443:127.0.0.1") &&
        !j.includes("auth.upgrade.example.test"),
    );
    expect(spaCall).toBeDefined();
    expect(spaCall).toContain("-k");
    expect(spaCall).not.toContain("docker exec");

    const oidcCall = joined.find((j) =>
      j.includes("auth.upgrade.example.test"),
    );
    expect(oidcCall).toBeDefined();
    expect(oidcCall).toContain("--resolve");
    expect(oidcCall).toContain("auth.upgrade.example.test:443:127.0.0.1");
    expect(oidcCall).toContain("-k");
  });

  test("remote false-v2 identity prevention: a public-DNS v2 instanceId cannot pass the gate", async () => {
    // Simulate the live bug: if the gate used public DNS, deps.fetch would
    // reach v2 and return instanceId="v2-other". The SSH-local transport
    // instead reads /api/setup/status from the TARGET over loopback, which
    // returns the real v1 instanceId. Wire a deps.fetch that would return
    // the WRONG instanceId and prove it is never consulted.
    const misleadingFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/setup/status")) {
        return new Response(
          JSON.stringify({ instanceId: "v2-other" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const { spawnFn } = fakeTargetSpawn({
      setup: { status: 200, body: JSON.stringify({ instanceId: "upgrade-fixture" }) },
    });
    const { driver, fetchCalls } = makeRemoteAcceptanceDeps({
      fetch: misleadingFetch,
      spawnFn,
    });

    // The gate PASSES because it read the target's real instanceId
    // (upgrade-fixture) over loopback, not the v2 value the public-DNS fetch
    // would have returned.
    await driver.checkRuntimeAcceptance(remoteLeProfile);
    expect(fetchCalls).toHaveLength(0);
  });

  test("remote identity mismatch (target reports a different instanceId) still fails closed", async () => {
    const { spawnFn } = fakeTargetSpawn({
      setup: { status: 200, body: JSON.stringify({ instanceId: "wrong-target" }) },
    });
    const { driver } = makeRemoteAcceptanceDeps({ spawnFn });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      driver.checkRuntimeAcceptance(remoteLeProfile),
    ).rejects.toThrow(
      /runtime acceptance failed: target instanceId mismatch.*profile=upgrade-fixture.*live=wrong-target/,
    );
  });

  test("remote health poll isolation: pollServerHealthForProfile uses the SSH loopback transport, not deps.fetch", async () => {
    const { spawnFn, calls } = fakeTargetSpawn();
    const { driver, fetchCalls } = makeRemoteAcceptanceDeps({ spawnFn });

    // pollServerHealthForProfile is the deploy/restore/releaseApply health
    // gate. For a remote profile with the transport wired it MUST route
    // /health through the SSH loopback transport, never deps.fetch on the
    // public URL (which would hit v2 and falsely fail v1).
    await (driver as unknown as {
      pollServerHealthForProfile: (p: ComposeDriverProfile, b: string) => Promise<void>;
    }).pollServerHealthForProfile(remoteLeProfile, "https://upgrade.example.test");

    expect(fetchCalls).toHaveLength(0);
    expect(
      calls.some((c) =>
        c.args.join(" ").includes("http://127.0.0.1:3001/health"),
      ),
    ).toBe(true);
    expect(calls[0]!.args).toContain("root@192.0.2.40");
  });

  test("unwired remote profile retains legacy deps.fetch behavior (no transport = no regression)", async () => {
    // When the CLI factory has NOT wired the transport (legacy/tests), a
    // remote profile falls back to deps.fetch + pollServerHealth. This is
    // the safety valve that keeps existing callers working until wired.
    const legacyFetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      if (url.includes("/api/setup/status")) {
        return new Response(JSON.stringify({ instanceId: "upgrade-fixture" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/oidc/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({ issuer: "https://auth.upgrade.example.test/oidc" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("<html>spa</html>", { status: 200 });
    }) as unknown as typeof fetch;
    const { driver, fetchCalls } = makeRemoteAcceptanceDeps({
      fetch: legacyFetch,
    });

    await driver.checkRuntimeAcceptance(remoteLeProfile);

    // Legacy path: deps.fetch WAS called (health/setup/spa/oidc).
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(fetchCalls.some((u) => u.includes("/health"))).toBe(true);
    expect(
      fetchCalls.some((u) => u.includes("/api/setup/status")),
    ).toBe(true);
  });
});
