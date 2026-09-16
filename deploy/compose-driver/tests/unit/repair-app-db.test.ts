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
  buildAppDbRepairPipeline,
  buildLocalComposeExecPrefix,
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
  resolveAppDbRepairSql,
} from "../../src/index.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { RemoteDeploymentManifest } from "../../src/remote-deployment-manifest.ts";
import { RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT } from "../../src/retired-topology-presence.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const TEST_REPAIR_SQL = "/* m212-unit */ SELECT 1;";
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
  const repoRoot = mktmp("repair-app-db-repo-");
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
    getAppDbRepairSql: () => TEST_REPAIR_SQL,
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

describe("repairAppDb command construction", () => {
  test("production repair includes the shared password-safe crypto-role contract", () => {
    const sql = resolveAppDbRepairSql();
    expect(sql).toContain("CREATE ROLE nautilo_crypto");
    expect(sql).toContain("\\getenv crypto_password NAUTILO_CRYPTO_DB_PASSWORD");
    expect(sql).not.toContain("DB_CRYPTO_CONNECTION_STRING");
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.crypto_domains FROM PUBLIC, nautilo_agent",
    );
    expect(sql).toContain(
      "IF to_regclass('public.crypto_domains') IS NOT NULL THEN",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON TABLE public.crypto_objects TO nautilo_crypto",
    );
    expect(sql.indexOf("CREATE ROLE nautilo_crypto")).toBeLessThan(
      sql.indexOf("GRANT SELECT, INSERT ON TABLE public.crypto_objects"),
    );
    expect(sql.match(
      /GRANT SELECT, INSERT ON TABLE public\.crypto_objects TO nautilo_crypto/g,
    )).toHaveLength(1);
  });

  test("local compose exec prefix targets app-postgres psql with ON_ERROR_STOP", () => {
    const prefix = buildLocalComposeExecPrefix("docker", ["compose"], [
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
    const pipeline = buildAppDbRepairPipeline(
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
      TEST_REPAIR_SQL,
    );
    expect(prefix).toContain("exec -T app-postgres ");
    expect(pipeline).toContain("psql -U postgres -d nautilo -v ON_ERROR_STOP=1");
    expect(pipeline).toContain("printf %s ");
    expect(pipeline).toContain(TEST_REPAIR_SQL);
    expect(pipeline).not.toMatch(/postgres:\/\//);
    expect(pipeline).not.toMatch(/NAUTILO_DB_PASSWORD/);
  });

  test("remote SSH repair uses docker compose exec on the remote root", () => {
    const pipeline = buildAppDbRepairPipeline(
      {
        transport: "remote_ssh",
        remoteRoot: "/opt/nautilo",
        projectName: "nautilo",
        overlays: { volumes: true, registry: true, server: true },
        profiles: ["auth", "app"],
      },
      TEST_REPAIR_SQL,
    );
    expect(pipeline).toContain("docker compose");
    expect(pipeline).not.toContain("exec docker compose");
    expect(pipeline).toContain("/opt/nautilo/docker-compose.yml");
    expect(pipeline).toContain("exec -T app-postgres ");
    expect(pipeline).toContain("psql -U postgres -d nautilo -v ON_ERROR_STOP=1");
    expect(pipeline).not.toMatch(/postgres:\/\//);
  });

  test("resolveAppDbRepairSql loads canonical vector install, ownership, and agent grant SQL", () => {
    const sql = resolveAppDbRepairSql();
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(sql).toContain("ALTER TABLE public.%I OWNER TO nautilo");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO nautilo_agent");
    expect(sql.indexOf("CREATE EXTENSION IF NOT EXISTS vector")).toBeLessThan(
      sql.indexOf("ALTER TABLE public.%I OWNER TO nautilo"),
    );
    expect(sql.indexOf("CREATE ROLE nautilo_crypto")).toBeLessThan(
      sql.indexOf("CREATE EXTENSION IF NOT EXISTS vector"),
    );
  });
});

describe("repairAppDb lifecycle ordering", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    home = mktmp("repair-lifecycle-home-");
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    cleanupTmp();
  });

  test("deploy runs repair after app-postgres up and before nautilo-server up", async () => {
    const order: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "docker" && call.args.includes("up") && call.args.includes("app-postgres")) {
        order.push("postgres-up");
        expect(call.args).toContain("--wait");
      }
      if (call.cmd === "sh" && call.args[1]?.includes("app-postgres") && call.args[1]?.includes("psql")) {
        order.push("repair");
      }
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("nautilo-server")
      ) {
        order.push("server-up");
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

    expect(order.indexOf("postgres-up")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("repair")).toBeGreaterThan(order.indexOf("postgres-up"));
    expect(order.indexOf("server-up")).toBeGreaterThan(order.indexOf("repair"));
    const repairCall = calls.find(
      (c) => c.cmd === "sh" && c.args[1]?.includes(TEST_REPAIR_SQL),
    );
    expect(repairCall).toBeDefined();
  });

  test("deploy psql repair is gated behind app-postgres up --wait (no race)", async () => {
    let postgresReady = false;
    const { exec } = makeFakeExec((call) => {
      if (call.cmd === "docker" && call.args.includes("up") && call.args.includes("app-postgres")) {
        expect(call.args).toContain("--wait");
        postgresReady = true;
      }
      if (call.cmd === "sh" && call.args[1]?.includes("app-postgres") && call.args[1]?.includes("psql")) {
        if (!postgresReady) {
          throw new Error("psql raced ahead of healthy app-postgres");
        }
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

    expect(postgresReady).toBe(true);
  });

  test("source release prepares and repairs app-postgres before incoming server up", async () => {
    const order: string[] = [];
    const instanceRoot = mktmp("repair-source-release-");
    writeFileSync(join(instanceRoot, "instance.env"), "NAUTILO_CRYPTO_DB_PASSWORD=crypto\n");
    const { exec } = makeFakeExec((call) => {
      if (call.cmd === "docker" && call.args.includes("up") && call.args.includes("app-postgres")) {
        order.push("postgres-up");
        expect(call.args).toContain("--wait");
        expect(call.args).toContain("--force-recreate");
      }
      if (call.cmd === "docker" && call.args.includes("up") && call.args.includes("nautilo-server")) {
        order.push("server-up");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => instanceRoot,
        resolveLocalInstanceRootDir: () => instanceRoot,
        runAppDbRepair: async (ctx) => {
          expect(ctx.transport).toBe("local_compose");
          order.push("repair");
        },
      }),
    );
    const internal = driver as unknown as {
      releaseServerUp: (
        profile: ComposeDriverProfile,
        artifact: { mode: "source"; archiveTag: string; immutableId: string },
      ) => Promise<void>;
    };

    await internal.releaseServerUp(baseProfile, {
      mode: "source",
      archiveTag: "nautilo-server:test-release",
      immutableId: "sha256:test-release",
    });

    expect(order).toEqual(["postgres-up", "repair", "server-up"]);
  });

  test("registry release prepares and repairs remote app-postgres before incoming server up", async () => {
    const order: string[] = [];
    const manifest = validRemoteManifest();
    const { exec } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "cat" && call.args[0] === "/opt/nautilo/deployment-manifest.json") {
        return { code: 0, stdout: `${JSON.stringify(manifest)}\n`, stderr: "" };
      }
      if (call.cmd === "sh" && script.includes(" up -d") && script.includes("app-postgres")) {
        order.push("postgres-up");
        expect(script).toContain("--wait");
        expect(script).toContain("--force-recreate");
      }
      if (call.cmd === "sh" && script.includes(" up -d --no-build --no-deps nautilo-server")) {
        order.push("server-up");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
        runAppDbRepair: async (ctx) => {
          expect(ctx.transport).toBe("remote_ssh");
          order.push("repair");
        },
      }),
    );
    const internal = driver as unknown as {
      releaseServerUp: (
        profile: ComposeDriverProfile,
        artifact: { mode: "registry"; requested: string; immutableId: string },
      ) => Promise<void>;
    };

    await internal.releaseServerUp(remoteRegistryProfile, {
      mode: "registry",
      requested: "ghcr.io/agentsea/nautilo-server:test-release",
      immutableId: "sha256:test-release",
    });

    expect(order).toEqual(["postgres-up", "repair", "server-up"]);
  });

  test("remote registry day-two repairs before server health postcheck when retired topology remains", async () => {
    const order: string[] = [];
    const manifest = validRemoteManifest();
    const { exec } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (
        call.cmd === "sh" &&
        script.includes("com.docker.compose.service=$service") &&
        script.includes("neon-proxy") &&
        script.includes(`exit ${RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT}`)
      ) {
        return { code: RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT, stdout: "", stderr: "" };
      }
      if (call.cmd === "cat" && call.args[0] === "/opt/nautilo/deployment-manifest.json") {
        return { code: 0, stdout: JSON.stringify(manifest) + "\n", stderr: "" };
      }
      if (call.cmd === "sh" && script.includes("find_one logto")) {
        return {
          code: 0,
          stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
          stderr: "",
        };
      }
      if (call.cmd === "cat" && call.args[0] === "/opt/nautilo/deploy.compose.env") {
        return {
          code: 0,
          stdout:
            "APP_DB_PASSWORD=app\nNAUTILO_DB_PASSWORD=owner\nNAUTILO_AGENT_DB_PASSWORD=agent\n",
          stderr: "",
        };
      }
      if (
        call.cmd === "cat" &&
        call.args[0] === "/opt/nautilo/runtime-config/instance.env"
      ) {
        return {
          code: 0,
          stdout: "NAUTILO_DB_PASSWORD=owner\n",
          stderr: "",
        };
      }
      if (call.cmd === "sh" && script.includes(" up -d") && script.includes("app-postgres")) {
        order.push("postgres-up");
        expect(script).toContain("--wait");
      }
      if (call.cmd === "sh" && script.includes("psql") && script.includes("app-postgres")) {
        order.push("repair");
      }
      if (
        call.cmd === "sh" &&
        script.includes(" up -d") &&
        !script.includes("app-postgres") &&
        !script.includes("logto-postgres")
      ) {
        order.push("full-up");
        expect(script).not.toContain("--wait");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    let healthChecked = false;
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      }),
    );
    driver.checkServerHealth = (async () => {
      healthChecked = true;
    }) as typeof driver.checkServerHealth;

    await driver.deploy(remoteRegistryProfile);

    expect(order).toContain("postgres-up");
    expect(order).toContain("repair");
    expect(order.indexOf("repair")).toBeLessThan(order.indexOf("full-up"));
    expect(healthChecked).toBe(true);
    expect(order.indexOf("repair")).toBeLessThan(order.indexOf("full-up"));
  });

  test("restore runs repair after nautilo DB load and before nautilo-server start", async () => {
    const order: string[] = [];
    const bundleDir = writeRestoreBundle(mktmp("repair-restore-bundle-"));
    const localExecCalls: ExecCall[] = [];
    const localExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      const text = commandText({ cmd, args, opts });
      if (text.includes("gunzip") && text.includes("/nautilo.sql.gz")) {
        order.push("db-restore");
      }
      if (text.includes("psql") && text.includes(TEST_REPAIR_SQL)) {
        order.push("repair");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec } = makeFakeExec((call) => {
      if (call.cmd === "docker" && call.args.includes("start") && call.args.includes("nautilo-server")) {
        order.push("server-start");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const instanceRoot = join(home, ".nautilo");
    mkdirSync(instanceRoot, { recursive: true });
    writeFileSync(join(instanceRoot, "deploy.compose.env"), "COMPOSE_PROJECT_NAME=nautilo\n");
    const { fetch: fakeFetch } = makeFakeFetch(1);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec,
        fetch: fakeFetch,
        resolveInstanceRootDir: () => instanceRoot,
        resolveLocalInstanceRootDir: () => instanceRoot,
      }),
    );

    await driver.restore(baseProfile, { fromPath: bundleDir, force: true, mode: "data-only" });

    const repairIndex = order.indexOf("repair");
    expect(repairIndex).toBeGreaterThan(order.lastIndexOf("db-restore"));
    expect(order.indexOf("server-start")).toBeGreaterThan(repairIndex);
    expect(localExecCalls.some((c) => c.args[1]?.includes("ON_ERROR_STOP=1"))).toBe(true);
  });

  test("injected runAppDbRepair seam is used instead of the default runner", async () => {
    let seamCalls = 0;
    const { exec } = makeFakeExec();
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        runAppDbRepair: async () => {
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
