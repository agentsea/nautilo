import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAppDbRepairPipeline,
  buildLogtoPreSeedRecoveryPipeline,
  buildLogtoTenantPasswordResyncPipeline,
  ComposeDriver,
  type ComposeDriverDeps,
  dockerHostFor,
  type ExecFn,
  sqlPipelineExecForProfile,
  usesRemoteSourceMode,
  wrapWithDockerHost,
} from "../../src/index.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const TEST_REPAIR_SQL = "/* m212-unit */ SELECT 1;";
const TEST_LOGTO_PRESEED_SQL = "/* m212-logto-preseed */ SELECT 1;";
const TEST_RESYNC_SQL = "/* logto-tenant-password-resync */ SELECT 1;";
const CANONICAL_IMAGE_REF = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"a".repeat(64)}`;

interface ExecCall {
  cmd: string;
  args: string[];
  opts: Parameters<ExecFn>[2];
}

const ok = { code: 0, stdout: "", stderr: "" };

function makeFakeExec(
  responder: (call: ExecCall) => typeof ok = () => ok,
): { exec: ExecFn; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    const call: ExecCall = { cmd, args, opts };
    calls.push(call);
    return responder(call);
  };
  return { exec, calls };
}

const remoteSourceProfile: ComposeDriverProfile = {
  name: "remote-source",
  transport: "remote",
  lifecycle: "compose",
  from_source: true,
  ssh: { host: "203.0.113.10", user: "root" },
};

const remoteRegistryProfile: ComposeDriverProfile = {
  name: "remote-registry",
  transport: "remote",
  lifecycle: "compose",
  from_source: false,
  image_ref: CANONICAL_IMAGE_REF,
  ssh: { host: "203.0.113.10", user: "root" },
};

const localProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
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
  const repoRoot = mktmp("sql-pipeline-transport-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template\n");
  const infraInitPath = join(repoRoot, "infra/postgres-init.sh");
  mkdirSync(join(infraInitPath, ".."), { recursive: true });
  writeFileSync(infraInitPath, "#!/bin/sh\n");
  const { exec: defaultExec } = makeFakeExec();
  const { exec: overriddenExec, localExec: overriddenLocalExec, ...rest } = over;
  const exec = overriddenExec ?? defaultExec;
  const localExec = overriddenLocalExec ?? exec;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    ensureRemotePairingPepper: async () => "a".repeat(64),
    ensurePushTokenEncryptionKey: async () => "b".repeat(64),
    resolveSourceBuildSha: async () => "c".repeat(40),
    fs: nodeFs,
    now: () => new Date("2026-07-16T12:00:00.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    getAppDbRepairSql: () => TEST_REPAIR_SQL,
    getLogtoPreSeedRecoverySql: () => TEST_LOGTO_PRESEED_SQL,
    getLogtoTenantPasswordResyncSql: () => TEST_RESYNC_SQL,
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ensureForgotPasswordWebhookSecret: async () => "fake_webhook_secret",
    openSshTunnel: async () => ({ close: async () => {} }),
    ...rest,
    exec,
    localExec,
  };
}

describe("usesRemoteSourceMode", () => {
  test("true for remote + from_source", () => {
    expect(usesRemoteSourceMode(remoteSourceProfile)).toBe(true);
  });

  test("false for remote registry", () => {
    expect(usesRemoteSourceMode(remoteRegistryProfile)).toBe(false);
  });

  test("false for local", () => {
    expect(usesRemoteSourceMode(localProfile)).toBe(false);
  });
});

describe("sqlPipelineExecForProfile", () => {
  test("remote-source routes sh pipelines through localExec with DOCKER_HOST", async () => {
    const sshCalls: ExecCall[] = [];
    const localCalls: ExecCall[] = [];
    const wrapped = sqlPipelineExecForProfile(remoteSourceProfile, {
      exec: async (cmd, args, opts) => {
        sshCalls.push({ cmd, args, opts });
        return ok;
      },
      localExec: async (cmd, args, opts) => {
        localCalls.push({ cmd, args, opts });
        return ok;
      },
    });

    await wrapped("sh", ["-c", "docker compose exec -T app-postgres psql"], {
      stdio: "pipe",
      stdin: "synthetic-private-sql-input",
    });

    expect(sshCalls).toHaveLength(0);
    expect(localCalls).toHaveLength(1);
    expect(localCalls[0]!.opts.stdin).toBe("synthetic-private-sql-input");
    expect(localCalls[0]!.cmd).toBe("sh");
    expect(localCalls[0]!.opts.env?.["DOCKER_HOST"]).toBe(
      dockerHostFor(remoteSourceProfile),
    );
  });

  test("local profile uses localExec without DOCKER_HOST", async () => {
    const localCalls: ExecCall[] = [];
    const wrapped = sqlPipelineExecForProfile(localProfile, {
      exec: async () => ok,
      localExec: async (cmd, args, opts) => {
        localCalls.push({ cmd, args, opts });
        return ok;
      },
    });

    await wrapped("sh", ["-c", "docker compose exec -T app-postgres psql"], {
      stdio: "pipe",
      stdin: "synthetic-private-sql-input",
    });

    expect(localCalls).toHaveLength(1);
    expect(localCalls[0]!.opts.stdin).toBe("synthetic-private-sql-input");
    expect(localCalls[0]!.opts.env?.["DOCKER_HOST"]).toBeUndefined();
  });

  test("remote registry returns exec for SSH-native remote_ssh pipelines", async () => {
    const sshCalls: ExecCall[] = [];
    const localCalls: ExecCall[] = [];
    const wrapped = sqlPipelineExecForProfile(remoteRegistryProfile, {
      exec: async (cmd, args, opts) => {
        sshCalls.push({ cmd, args, opts });
        return ok;
      },
      localExec: async (cmd, args, opts) => {
        localCalls.push({ cmd, args, opts });
        return ok;
      },
    });

    await wrapped("sh", ["-c", "docker compose exec -T app-postgres psql"], {
      stdio: "pipe",
      stdin: "synthetic-private-sql-input",
    });

    expect(localCalls).toHaveLength(0);
    expect(sshCalls).toHaveLength(1);
    expect(sshCalls[0]!.opts.stdin).toBe("synthetic-private-sql-input");
    expect(sshCalls[0]!.opts.env?.["DOCKER_HOST"]).toBeUndefined();
  });
});

describe("remote-source SQL pipeline transport (dispatch seam)", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    home = mktmp("sql-pipeline-dispatch-home-");
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    cleanupTmp();
  });

  test("deploy wires all three helpers through localExec + DOCKER_HOST, not SSH sh", async () => {
    const sshShCalls: ExecCall[] = [];
    const localShCalls: ExecCall[] = [];
    const { exec: innerExec } = makeFakeExec((call) => {
      if (call.cmd === "sh") {
        sshShCalls.push(call);
      }
      return ok;
    });
    const { exec: localExec } = makeFakeExec((call) => {
      if (call.cmd === "sh") {
        localShCalls.push(call);
      }
      return ok;
    });
    const exec = wrapWithDockerHost(
      innerExec,
      dockerHostFor(remoteSourceProfile),
      localExec,
    );

    const captured: {
      helper: string;
      transport: string;
      pipeline?: string;
    }[] = [];

    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec,
        readInstanceLogtoEnv: async () => ({
          LOGTO_ENDPOINT: "http://localhost:3301",
          LOGTO_ISSUER: "http://localhost:3301/oidc",
          LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
          LOGTO_RESOURCE: "https://api.nautilo.local",
          LOGTO_M2M_APP_ID: "m2m",
          LOGTO_M2M_APP_SECRET: "secret",
          LOGTO_WORKBENCH_APP_ID: "wb",
        }),
        runAppDbRepair: async (ctx, deps) => {
          captured.push({
            helper: "repair",
            transport: ctx.transport,
            pipeline: buildAppDbRepairPipeline(ctx, TEST_REPAIR_SQL),
          });
          await deps.exec("sh", ["-c", "repair-probe"], { stdio: "pipe" });
        },
        runLogtoPreSeedRecovery: async (ctx, deps) => {
          captured.push({
            helper: "preseed",
            transport: ctx.transport,
            pipeline: buildLogtoPreSeedRecoveryPipeline(ctx, TEST_LOGTO_PRESEED_SQL),
          });
          await deps.exec("sh", ["-c", "preseed-probe"], { stdio: "pipe" });
        },
        runLogtoTenantPasswordResync: async (ctx, deps) => {
          captured.push({
            helper: "resync",
            transport: ctx.transport,
            pipeline: buildLogtoTenantPasswordResyncPipeline(ctx, TEST_RESYNC_SQL),
          });
          await deps.exec("sh", ["-c", "resync-probe"], { stdio: "pipe" });
        },
      }),
    );

    await driver.deploy(remoteSourceProfile);

    expect(captured.map((c) => c.helper)).toEqual(["repair", "preseed", "resync"]);
    for (const entry of captured) {
      expect(entry.transport).toBe("local_compose");
      expect(entry.pipeline).toContain("docker compose");
      expect(entry.pipeline).not.toContain("/opt/nautilo");
      expect(entry.pipeline).toContain("exec -T");
    }

    expect(sshShCalls.filter((c) => c.args[1]?.includes("-probe"))).toHaveLength(0);
    const probeCalls = localShCalls.filter((c) => c.args[1]?.includes("-probe"));
    expect(probeCalls).toHaveLength(3);
    for (const call of probeCalls) {
      expect(call.opts.env?.["DOCKER_HOST"]).toBe(dockerHostFor(remoteSourceProfile));
    }
  });

  test("remote registry deploy keeps SSH-native remote_ssh pipelines on exec", async () => {
    const manifest = {
      version: 1,
      instanceId: "",
      composeProjectName: "nautilo",
      lifecycle: "compose",
      image: { mode: "registry", reference: "ghcr.io/agentsea/nautilo-server:main" },
      remoteRoot: "/opt/nautilo",
      https: "off",
      createdAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z",
    };
    const sshShCalls: ExecCall[] = [];
    const localShCalls: ExecCall[] = [];
    const { exec: innerExec } = makeFakeExec((call) => {
      if (call.cmd === "sh") {
        sshShCalls.push(call);
      }
      if (call.cmd === "cat" && call.args[0] === "/opt/nautilo/deployment-manifest.json") {
        return { code: 0, stdout: JSON.stringify(manifest) + "\n", stderr: "" };
      }
      if (call.cmd === "cat" && call.args[0] === "/opt/nautilo/runtime-config/instance.env") {
        return {
          code: 0,
          stdout: "LOGTO_ENDPOINT=https://auth.example.com\nLOGTO_JWKS_URI=https://auth.example.com/oidc/jwks\n",
          stderr: "",
        };
      }
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("find_one logto")) {
        return {
          code: 0,
          stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
          stderr: "",
        };
      }
      return ok;
    });
    const { exec: localExec } = makeFakeExec((call) => {
      if (call.cmd === "sh") {
        localShCalls.push(call);
      }
      return ok;
    });

    const captured: { helper: string; transport: string; pipeline?: string }[] = [];
    const driver = new ComposeDriver(
      makeDeps({
        exec: innerExec,
        localExec,
        resolveInstanceRootDir: () => "/opt/nautilo",
        fetch: (async (input: string | URL) => {
          const url = String(input);
          if (url.includes("/health")) {
            return new Response("ok", { status: 200 });
          }
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
        runAppDbRepair: async (ctx, deps) => {
          captured.push({
            helper: "repair",
            transport: ctx.transport,
            pipeline: buildAppDbRepairPipeline(ctx, TEST_REPAIR_SQL),
          });
          await deps.exec("sh", ["-c", "repair-probe"], { stdio: "pipe" });
        },
        runLogtoPreSeedRecovery: async (ctx, deps) => {
          captured.push({
            helper: "preseed",
            transport: ctx.transport,
            pipeline: buildLogtoPreSeedRecoveryPipeline(ctx, TEST_LOGTO_PRESEED_SQL),
          });
          await deps.exec("sh", ["-c", "preseed-probe"], { stdio: "pipe" });
        },
        runLogtoTenantPasswordResync: async (ctx, deps) => {
          captured.push({
            helper: "resync",
            transport: ctx.transport,
            pipeline: buildLogtoTenantPasswordResyncPipeline(ctx, TEST_RESYNC_SQL),
          });
          await deps.exec("sh", ["-c", "resync-probe"], { stdio: "pipe" });
        },
      }),
    );

    await driver.deploy(remoteRegistryProfile);

    expect(captured.map((c) => c.helper)).toEqual(["repair", "preseed", "resync"]);
    for (const entry of captured) {
      expect(entry.transport).toBe("remote_ssh");
      expect(entry.pipeline).toContain("/opt/nautilo/docker-compose.yml");
      expect(entry.pipeline).toContain("exec -T");
    }

    expect(localShCalls.filter((c) => c.args[1]?.includes("-probe"))).toHaveLength(0);
    expect(sshShCalls.filter((c) => c.args[1]?.includes("-probe"))).toHaveLength(3);
  });
});
