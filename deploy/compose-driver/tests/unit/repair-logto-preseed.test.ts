import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupManifestSchema,
  buildLogtoPreSeedRecoveryPipeline,
  buildLocalLogtoPostgresExecPrefix,
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
  buildLogtoPreSeedRecoverySql,
  LOGTO_TENANT_ROLE_PREFIX,
} from "../../src/index.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { RemoteDeploymentManifest } from "../../src/remote-deployment-manifest.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const TEST_LOGTO_PRESEED_SQL = "/* m212-logto-preseed */ SELECT 1;";
const CANONICAL_IMAGE_REF = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"a".repeat(64)}`;

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
    return responder(call);
  };
  return { exec, calls };
}

function makeFakeFetch(succeedAfter = 1): {
  fetch: typeof fetch;
  count: () => number;
} {
  let n = 0;
  const fetchFn = (async () => {
    n += 1;
    return new Response("ok", { status: n >= succeedAfter ? 200 : 503 });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, count: () => n };
}

const baseProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

const remoteRegistryProfile: ComposeDriverProfile = {
  name: "remote-registry",
  transport: "remote",
  lifecycle: "compose",
  from_source: false,
  image_ref: CANONICAL_IMAGE_REF,
  ssh: { host: "203.0.113.10", user: "root" },
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
  const repoRoot = mktmp("repair-logto-preseed-repo-");
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
  const { fetch: fakeFetch } = makeFakeFetch(1);
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    fetch: fakeFetch,
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
    getAppDbRepairSql: () => "/* m212-app */ SELECT 1;",
    getLogtoPreSeedRecoverySql: () => TEST_LOGTO_PRESEED_SQL,
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ensureForgotPasswordWebhookSecret: async () => "fake_webhook_secret",
    ...rest,
    exec,
    localExec,
  };
}

function commandText(call: ExecCall): string {
  return [call.cmd, ...call.args].join(" ");
}

function validRemoteManifest(
  overrides: Partial<RemoteDeploymentManifest> = {},
): RemoteDeploymentManifest {
  return {
    version: 1,
    instanceId: "",
    composeProjectName: "nautilo",
    lifecycle: "compose",
    image: { mode: "registry", reference: "ghcr.io/agentsea/nautilo-server:main" },
    remoteRoot: "/opt/nautilo",
    https: "off",
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    ...overrides,
  } as RemoteDeploymentManifest;
}

function writeRestoreBundle(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "nautilo.sql.gz"), "");
  writeFileSync(join(root, "logto.sql.gz"), "");
  const manifest = backupManifestSchema.parse({
    version: 1,
    createdAt: "2026-07-16T12:00:00.000Z",
    profileName: "local-default",
    instanceId: "",
    transport: "local",
    composeProjectName: "nautilo",
    image: {
      mode: "registry",
      repoDigest: "ghcr.io/agentsea/nautilo-server@sha256:abc",
      tag: "main",
    },
    contents: {
      nautiloDb: true,
      logtoDb: true,
      artifacts: false,
      media: false,
      instanceEnv: false,
      operatorFiles: false,
      caddyData: false,
      caddyConfig: false,
      localCaCerts: false,
    },
    https: "off",
  });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return root;
}

describe("Logto pre-seed recovery SQL guard", () => {
  test("guards on public.tenants and only drops logto_tenant_logto_nautilo% roles", () => {
    const sql = buildLogtoPreSeedRecoverySql();
    expect(sql).toContain("to_regclass('public.tenants') IS NULL");
    expect(sql).toContain(`rolname LIKE '${LOGTO_TENANT_ROLE_PREFIX}%'`);
    expect(sql).toContain(
      "format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', r.rolname)",
    );
    expect(sql).toContain("format('DROP ROLE IF EXISTS %I', r.rolname)");
    expect(sql).not.toContain("DROP DATABASE");
    expect(sql).not.toContain("DROP SCHEMA");
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).not.toMatch(/postgres:\/\//);
  });

  test("no-op branch leaves roles untouched when tenants exists", () => {
    const sql = buildLogtoPreSeedRecoverySql();
    expect(sql).toMatch(
      /IF to_regclass\('public\.tenants'\) IS NULL THEN[\s\S]*FOR r IN[\s\S]*END IF;/,
    );
    expect(sql).not.toContain("ELSE");
    expect(sql.indexOf("REVOKE ALL PRIVILEGES ON SCHEMA public")).toBeLessThan(
      sql.indexOf("DROP ROLE IF EXISTS"),
    );
    expect(sql.split("DROP ROLE").length - 1).toBe(1);
  });
});

describe("repairLogtoPreSeed command construction", () => {
  test("local compose exec prefix targets logto-postgres psql with ON_ERROR_STOP", () => {
    const prefix = buildLocalLogtoPostgresExecPrefix("docker", ["compose"], [
      "--project-name",
      "nautilo",
      "-f",
      "/templates/docker-compose.yml",
      "--env-file",
      "/instance/deploy.compose.env",
      "--profile",
      "auth",
      "--profile",
      "app",
    ]);
    const pipeline = buildLogtoPreSeedRecoveryPipeline(
      {
        transport: "local_compose",
        composeBin: "docker",
        composeArgs: ["compose"],
        composeProjectArgs: [
          "--project-name",
          "nautilo",
          "-f",
          "/templates/docker-compose.yml",
          "--env-file",
          "/instance/deploy.compose.env",
          "--profile",
          "auth",
          "--profile",
          "app",
        ],
      },
      TEST_LOGTO_PRESEED_SQL,
    );
    expect(prefix).toContain("exec -T logto-postgres ");
    expect(pipeline).toContain("psql -U postgres -d logto_nautilo -v ON_ERROR_STOP=1");
    expect(pipeline).toContain("printf %s ");
    expect(pipeline).toContain(TEST_LOGTO_PRESEED_SQL);
    expect(pipeline).not.toMatch(/postgres:\/\//);
    expect(pipeline).not.toMatch(/LOGTO_DB_PASSWORD/);
  });

  test("remote SSH recovery uses docker compose exec on the remote root", () => {
    const pipeline = buildLogtoPreSeedRecoveryPipeline(
      {
        transport: "remote_ssh",
        remoteRoot: "/opt/nautilo",
        projectName: "nautilo",
        overlays: { volumes: true, registry: true, server: true },
        profiles: ["auth", "app"],
      },
      TEST_LOGTO_PRESEED_SQL,
    );
    expect(pipeline).toContain("docker compose");
    expect(pipeline).not.toContain("exec docker compose");
    expect(pipeline).toContain("/opt/nautilo/docker-compose.yml");
    expect(pipeline).toContain("exec -T logto-postgres ");
    expect(pipeline).toContain("psql -U postgres -d logto_nautilo -v ON_ERROR_STOP=1");
    expect(pipeline).not.toMatch(/postgres:\/\//);
  });
});

describe("repairLogtoPreSeed lifecycle ordering", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    home = mktmp("logto-preseed-lifecycle-home-");
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    cleanupTmp();
  });

  test("deploy runs Logto pre-seed after logto-postgres up and before auth profile up", async () => {
    const order: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("logto-postgres")
      ) {
        order.push("logto-postgres-up");
        expect(call.args).toContain("--wait");
      }
      if (
        call.cmd === "sh" &&
        call.args[1]?.includes("logto-postgres") &&
        call.args[1]?.includes("psql")
      ) {
        order.push("logto-preseed");
      }
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("--profile") &&
        call.args.includes("auth") &&
        !call.args.includes("logto-postgres") &&
        !call.args.includes("app-postgres")
      ) {
        order.push("auth-up");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        readInstanceLogtoEnv: async () => ({
          LOGTO_ENDPOINT: "http://localhost:3301",
          LOGTO_ISSUER: "http://localhost:3301/oidc",
          LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
          LOGTO_RESOURCE: "https://api.nautilo.local",
          LOGTO_M2M_APP_ID: "m2m",
          LOGTO_M2M_APP_SECRET: "secret",
          LOGTO_WORKBENCH_APP_ID: "wb",
        }),
      }),
    );

    await driver.deploy(baseProfile);

    expect(order.indexOf("logto-postgres-up")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("logto-preseed")).toBeGreaterThan(order.indexOf("logto-postgres-up"));
    expect(order.indexOf("auth-up")).toBeGreaterThan(order.indexOf("logto-preseed"));
    const preseedCall = calls.find(
      (c) => c.cmd === "sh" && c.args[1]?.includes(TEST_LOGTO_PRESEED_SQL),
    );
    expect(preseedCall).toBeDefined();
  });

  test("remote registry day-two pre-seeds before full auth profile up", async () => {
    const order: string[] = [];
    const manifest = validRemoteManifest();
    const { exec } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
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
      if (call.cmd === "sh" && script.includes("find_one logto")) {
        return {
          code: 0,
          stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
          stderr: "",
        };
      }
      if (call.cmd === "sh" && script.includes(" up -d") && script.includes("logto-postgres")) {
        order.push("logto-postgres-up");
        expect(script).toContain("--wait");
      }
      if (call.cmd === "sh" && script.includes("psql") && script.includes("logto-postgres")) {
        order.push("logto-preseed");
      }
      if (
        call.cmd === "sh" &&
        script.includes(" up -d") &&
        !script.includes("app-postgres") &&
        !script.includes("logto-postgres")
      ) {
        order.push("full-up");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
        fetch: (async (input: string | URL) => {
          const url = String(input);
          if (url.includes("/health")) {
            return new Response("ok", { status: 200 });
          }
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );

    await driver.deploy(remoteRegistryProfile);

    expect(order).toContain("logto-postgres-up");
    expect(order).toContain("logto-preseed");
    expect(order.indexOf("logto-preseed")).toBeLessThan(order.indexOf("full-up"));
  });

  test("full restore runs Logto pre-seed after logto-postgres up and before auth profile up", async () => {
    const order: string[] = [];
    const bundleDir = writeRestoreBundle(mktmp("logto-preseed-restore-bundle-"));
    const localExecCalls: ExecCall[] = [];
    const localExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      const text = commandText({ cmd, args, opts });
      if (text.includes("logto-postgres") && text.includes("psql")) {
        order.push("logto-preseed");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "docker" && call.args.includes("up") && call.args.includes("logto-postgres")) {
        order.push("logto-postgres-up");
        expect(call.args).toContain("--wait");
      }
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("auth") &&
        !call.args.includes("logto-postgres")
      ) {
        order.push("auth-up");
      }
      if (call.cmd === "docker" && call.args.includes("start") && call.args.includes("nautilo-server")) {
        order.push("server-start");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const instanceRoot = join(home, ".nautilo");
    mkdirSync(instanceRoot, { recursive: true });
    writeFileSync(join(instanceRoot, "deploy.compose.env"), "COMPOSE_PROJECT_NAME=nautilo\n");
    writeFileSync(join(instanceRoot, "instance.env"), "LOGTO_ENDPOINT=http://localhost:3301\n");
    const { fetch: fakeFetch } = makeFakeFetch(1);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec,
        fetch: fakeFetch,
        resolveInstanceRootDir: () => instanceRoot,
        resolveLocalInstanceRootDir: () => instanceRoot,
        readInstanceLogtoEnv: async () => ({
          LOGTO_ENDPOINT: "http://localhost:3301",
          LOGTO_ISSUER: "http://localhost:3301/oidc",
          LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
          LOGTO_RESOURCE: "https://api.nautilo.local",
          LOGTO_M2M_APP_ID: "m2m",
          LOGTO_M2M_APP_SECRET: "secret",
          LOGTO_WORKBENCH_APP_ID: "wb",
        }),
      }),
    );

    await driver.restore(baseProfile, { fromPath: bundleDir, force: true, mode: "full" });

    expect(order.indexOf("logto-postgres-up")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("logto-preseed")).toBeGreaterThan(order.indexOf("logto-postgres-up"));
    expect(order.indexOf("auth-up")).toBeGreaterThan(order.indexOf("logto-preseed"));
    const logtoPostgresUp = calls.find(
      (c) => c.cmd === "docker" && c.args.includes("up") && c.args.includes("logto-postgres"),
    );
    expect(logtoPostgresUp?.args).toContain("--wait");
    expect(localExecCalls.some((c) => c.args[1]?.includes("ON_ERROR_STOP=1"))).toBe(true);
  });

  test("injected runLogtoPreSeedRecovery seam is used instead of the default runner", async () => {
    let seamCalls = 0;
    const { exec } = makeFakeExec();
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        runLogtoPreSeedRecovery: async () => {
          seamCalls += 1;
        },
        readInstanceLogtoEnv: async () => ({
          LOGTO_ENDPOINT: "http://localhost:3301",
          LOGTO_ISSUER: "http://localhost:3301/oidc",
          LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
          LOGTO_RESOURCE: "https://api.nautilo.local",
          LOGTO_M2M_APP_ID: "m2m",
          LOGTO_M2M_APP_SECRET: "secret",
          LOGTO_WORKBENCH_APP_ID: "wb",
        }),
      }),
    );
    await driver.deploy(baseProfile);
    expect(seamCalls).toBeGreaterThanOrEqual(1);
  });
});
