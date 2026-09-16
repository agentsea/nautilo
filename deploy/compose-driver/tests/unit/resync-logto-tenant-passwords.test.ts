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
  buildLogtoTenantPasswordResyncPipeline,
  buildLogtoTenantPasswordResyncSql,
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
  runLogtoTenantPasswordResync,
} from "../../src/index.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { RemoteDeploymentManifest } from "../../src/remote-deployment-manifest.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const TEST_RESYNC_SQL = "/* logto-tenant-password-resync */ SELECT 1;";
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
  const repoRoot = mktmp("resync-logto-tenant-passwords-repo-");
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
    ...rest,
    exec,
    localExec,
  };
}

function commandText(call: ExecCall): string {
  return [call.cmd, ...call.args].join(" ");
}

function minimalInstanceJson(): string {
  const projectName = "nautilo";
  return JSON.stringify({
    schemaVersion: 1,
    instanceId: "",
    server: { host: "localhost", port: 3001, url: "http://localhost:3001" },
    workbench: { port: 3002, url: "http://localhost:3002" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:5434/nautilo",
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5435, corePort: 3003, adminPort: 3004 },
    compose: {
      projectName,
      containers: {
        postgres: `${projectName}-app-postgres-1`,
        legacyPostgres: `${projectName}-postgres-1`,
        server: `${projectName}-nautilo-server-1`,
        logtoPostgres: `${projectName}-logto-postgres-1`,
        logto: `${projectName}-logto-1`,
        logtoCore: `${projectName}-logto-core-1`,
        logtoSeed: `${projectName}-logto-seed-1`,
      },
    },
    hostname: {
      federated: "nautilo.local",
      mdns: "nautilo.local",
      tlsSan: "nautilo.local",
      caddyAuthHost: "auth.nautilo.local",
      caddyAuthAdminHost: "auth-admin.nautilo.local",
    },
    deploymentMode: "local-self-host",
  });
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

function writeFullRestoreBundle(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "nautilo.sql.gz"), "");
  writeFileSync(join(root, "logto_nautilo.sql.gz"), "");
  writeFileSync(join(root, "artifacts.tgz"), "");
  writeFileSync(join(root, "instance.env"), "LOGTO_ENDPOINT=http://localhost:3301\n");
  mkdirSync(join(root, "operator", "profiles"), { recursive: true });
  mkdirSync(join(root, "operator", "bootstrap-tokens"), { recursive: true });
  writeFileSync(
    join(root, "operator", "profiles", "local-default.toml"),
    "name = \"local-default\"\n",
  );
  writeFileSync(join(root, "operator", "bootstrap-tokens", "local-default"), "tok\n");
  writeFileSync(join(root, "operator", "instance.json"), minimalInstanceJson());
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
      artifacts: true,
      media: false,
      instanceEnv: true,
      operatorFiles: true,
      caddyData: false,
      caddyConfig: false,
      localCaCerts: false,
    },
    https: "off",
  });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  return root;
}

describe("buildLogtoTenantPasswordResyncSql", () => {
  test("guards on public.tenants and iterates db_user + db_user_password rows", () => {
    const sql = buildLogtoTenantPasswordResyncSql();
    expect(sql).toContain("to_regclass('public.tenants') IS NOT NULL");
    expect(sql).toContain(
      "FOR r IN SELECT db_user, db_user_password FROM public.tenants LOOP",
    );
    expect(sql).not.toContain("DROP ROLE");
    expect(sql).not.toContain("DROP SCHEMA");
    expect(sql).not.toMatch(/postgres:\/\//);
  });

  test("uses format(%I, %L) inside EXECUTE for ALTER and CREATE branches", () => {
    const sql = buildLogtoTenantPasswordResyncSql();
    expect(sql).toContain("format('ALTER ROLE %I WITH LOGIN PASSWORD %L'");
    expect(sql).toContain("format('CREATE ROLE %I WITH LOGIN PASSWORD %L'");
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.db_user)");
    expect(sql).toContain("DO $do$");
  });
});

describe("runLogtoTenantPasswordResync command construction", () => {
  test("local compose exec prefix targets logto-postgres psql with ON_ERROR_STOP", () => {
    const pipeline = buildLogtoTenantPasswordResyncPipeline(
      {
        transport: "local_compose",
        composeBin: "docker",
        composeArgs: ["compose"],
        composeProjectArgs: [
          "--project-name",
          "nautilo",
          "-f",
          "/templates/docker-compose.yml",
          "--profile",
          "auth",
          "--profile",
          "app",
        ],
      },
      TEST_RESYNC_SQL,
    );
    expect(pipeline).toContain("exec -T logto-postgres ");
    expect(pipeline).toContain("psql -U postgres -d logto_nautilo -v ON_ERROR_STOP=1");
    expect(pipeline).toContain("printf %s ");
    expect(pipeline).toContain(TEST_RESYNC_SQL);
    expect(pipeline).not.toMatch(/postgres:\/\//);
    expect(pipeline).not.toMatch(/LOGTO_DB_PASSWORD/);
  });

  test("remote SSH resync uses docker compose exec on the remote root", () => {
    const pipeline = buildLogtoTenantPasswordResyncPipeline(
      {
        transport: "remote_ssh",
        remoteRoot: "/opt/nautilo",
        projectName: "nautilo",
        overlays: { volumes: true, registry: true, server: true },
        profiles: ["auth", "app"],
      },
      TEST_RESYNC_SQL,
    );
    expect(pipeline).toContain("docker compose");
    expect(pipeline).not.toContain("exec docker compose");
    expect(pipeline).toContain("/opt/nautilo/docker-compose.yml");
    expect(pipeline).toContain("exec -T logto-postgres ");
    expect(pipeline).toContain("psql -U postgres -d logto_nautilo -v ON_ERROR_STOP=1");
    expect(pipeline).not.toMatch(/postgres:\/\//);
  });
});

describe("runLogtoTenantPasswordResync logging", () => {
  test("runner never logs SQL or passwords", async () => {
    const logs: string[] = [];
    const { exec } = makeFakeExec();
    await runLogtoTenantPasswordResync(
      {
        transport: "staged_compose",
        execPrefix: "docker compose exec -T logto-postgres ",
      },
      {
        exec,
        getLogtoTenantPasswordResyncSql: () =>
          "ALTER ROLE logto_tenant_logto_nautilo_default WITH LOGIN PASSWORD 'sekret';",
        log: (msg) => logs.push(msg),
      },
    );
    const joined = logs.join("\n");
    expect(joined).toContain("no credentials logged");
    expect(joined).not.toContain("ALTER ROLE");
    expect(joined).not.toContain("sekret");
    expect(joined).not.toContain("db_user_password");
  });
});

describe("Logto tenant password resync preflight ordering", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    home = mktmp("logto-resync-preflight-home-");
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    cleanupTmp();
  });

  test("local deploy orders logto-postgres → pre-seed → tenant-password resync → auth up → logto recreate → health poll", async () => {
    const order: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("logto-postgres")
      ) {
        order.push("logto-postgres-up");
        expect(call.args).toContain("--wait");
      }
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes(TEST_LOGTO_PRESEED_SQL)) {
        order.push("logto-preseed");
      }
      if (call.cmd === "sh" && script.includes(TEST_RESYNC_SQL)) {
        order.push("tenant-password-resync");
      }
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("--profile") &&
        call.args.includes("auth") &&
        !call.args.includes("logto-postgres") &&
        !call.args.includes("app-postgres") &&
        !call.args.includes("--force-recreate")
      ) {
        order.push("auth-up");
      }
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("--force-recreate") &&
        call.args.includes("logto") &&
        !call.args.includes("logto-postgres")
      ) {
        order.push("logto-core-recreate");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/oidc/.well-known/openid-configuration")) {
        order.push("health-poll");
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: fetchFn,
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
    expect(order.indexOf("tenant-password-resync")).toBeGreaterThan(order.indexOf("logto-preseed"));
    expect(order.indexOf("auth-up")).toBeGreaterThan(order.indexOf("tenant-password-resync"));
    expect(order.indexOf("logto-core-recreate")).toBeGreaterThan(order.indexOf("auth-up"));
    expect(order.indexOf("health-poll")).toBeGreaterThan(order.indexOf("logto-core-recreate"));
  });

  test("remote registry day-two orders logto-postgres → pre-seed → tenant-password resync → auth up → logto recreate", async () => {
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
      if (call.cmd === "sh" && script.includes(TEST_LOGTO_PRESEED_SQL)) {
        order.push("logto-preseed");
      }
      if (call.cmd === "sh" && script.includes(TEST_RESYNC_SQL)) {
        order.push("tenant-password-resync");
      }
      if (
        call.cmd === "sh" &&
        script.includes(" up -d") &&
        !script.includes("app-postgres") &&
        !script.includes("logto-postgres") &&
        !script.includes("--force-recreate")
      ) {
        order.push("auth-up");
      }
      if (
        call.cmd === "sh" &&
        script.includes("--force-recreate") &&
        script.includes(" logto")
      ) {
        order.push("logto-core-recreate");
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
    expect(order).toContain("tenant-password-resync");
    expect(order.indexOf("logto-preseed")).toBeGreaterThan(order.indexOf("logto-postgres-up"));
    expect(order.indexOf("tenant-password-resync")).toBeGreaterThan(order.indexOf("logto-preseed"));
    expect(order.indexOf("auth-up")).toBeGreaterThan(order.indexOf("tenant-password-resync"));
    expect(order.indexOf("logto-core-recreate")).toBeGreaterThan(order.indexOf("auth-up"));
  });

  test("injected runLogtoCoreRecreate seam is used on deploy preflight", async () => {
    let seamCalls = 0;
    const { exec } = makeFakeExec();
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
        runLogtoCoreRecreate: async () => {
          seamCalls += 1;
        },
      }),
    );

    await driver.deploy(baseProfile);
    expect(seamCalls).toBeGreaterThanOrEqual(1);
  });

  test("injected runLogtoTenantPasswordResync seam is used on deploy preflight", async () => {
    let seamCalls = 0;
    const { exec } = makeFakeExec();
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
        runLogtoTenantPasswordResync: async () => {
          seamCalls += 1;
        },
      }),
    );

    await driver.deploy(baseProfile);
    expect(seamCalls).toBeGreaterThanOrEqual(1);
  });
});

describe("Logto tenant password resync restore ordering", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    home = mktmp("logto-resync-restore-home-");
    process.env["HOME"] = home;
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    cleanupTmp();
  });

  test("full restore orders DB restore → tenant ACL grants → password resync → server start", async () => {
    const order: string[] = [];
    const bundleDir = writeFullRestoreBundle(mktmp("logto-resync-restore-bundle-"));
    const localExec: ExecFn = async (cmd, args, opts) => {
      const text = commandText({ cmd, args, opts });
      if (text.includes("gunzip") && text.includes("logto_nautilo.sql.gz")) {
        order.push("load-logto");
      }
      if (
        text.includes("logto_tenant_%") &&
        text.includes("GRANT USAGE ON SCHEMA public")
      ) {
        order.push("regrant-logto-tenant-roles");
      }
      if (text.includes(TEST_LOGTO_PRESEED_SQL)) {
        order.push("logto-preseed");
      }
      if (text.includes(TEST_RESYNC_SQL)) {
        order.push(
          order.includes("load-logto")
            ? "restore-tenant-password-resync"
            : "preflight-tenant-password-resync",
        );
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec } = makeFakeExec((call) => {
      if (
        call.cmd === "docker" &&
        call.args.includes("start") &&
        call.args.includes("nautilo-server")
      ) {
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

    expect(order.indexOf("load-logto")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("regrant-logto-tenant-roles")).toBeGreaterThan(
      order.indexOf("load-logto"),
    );
    expect(order).toContain("preflight-tenant-password-resync");
    expect(order).toContain("restore-tenant-password-resync");
    expect(order.indexOf("restore-tenant-password-resync")).toBeGreaterThan(
      order.indexOf("regrant-logto-tenant-roles"),
    );
    expect(order.indexOf("server-start")).toBeGreaterThan(
      order.indexOf("restore-tenant-password-resync"),
    );
  });

  test("data-only restore loads logto DB but skips password resync", async () => {
    const events: string[] = [];
    const bundleDir = writeFullRestoreBundle(mktmp("logto-resync-data-only-"));
    const { exec } = makeFakeExec((call) => {
      const text = commandText(call);
      if (text.includes(TEST_RESYNC_SQL)) events.push("resync");
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec: exec,
        fetch: (async (input: string | URL) => {
          const url = String(input);
          if (url.includes("/health")) {
            return new Response("ok", { status: 200 });
          }
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
        resolveInstanceRootDir: () => join(home, ".nautilo"),
        resolveLocalInstanceRootDir: () => join(home, ".nautilo"),
      }),
    );

    await driver.restore(baseProfile, {
      fromPath: bundleDir,
      force: true,
      mode: "data-only",
    });

    expect(events).not.toContain("resync");
  });

  test("remote registry full restore resyncs passwords after tenant ACL regrant", async () => {
    const order: string[] = [];
    const remoteRoot = "/opt/nautilo-prod";
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: false,
      image_ref: CANONICAL_IMAGE_REF,
      instance_id: "prod",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const manifest = validRemoteManifest({
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      remoteRoot,
    });
    const bundleDir = writeFullRestoreBundle(mktmp("logto-resync-remote-bundle-"));
    const rawManifest = JSON.parse(
      await nodeFs.readFile(join(bundleDir, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    rawManifest["transport"] = "remote";
    rawManifest["instanceId"] = "prod";
    rawManifest["composeProjectName"] = "nautilo-prod";
    await nodeFs.writeFile(join(bundleDir, "manifest.json"), JSON.stringify(rawManifest));
    const bundleInstance = JSON.parse(
      await nodeFs.readFile(join(bundleDir, "operator", "instance.json"), "utf8"),
    ) as { instanceId: string };
    bundleInstance.instanceId = "prod";
    await nodeFs.writeFile(
      join(bundleDir, "operator", "instance.json"),
      JSON.stringify(bundleInstance),
    );

    const { exec } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
        return { code: 0, stdout: JSON.stringify(manifest) + "\n", stderr: "" };
      }
      if (script.includes("gunzip") && script.includes("logto_nautilo.sql.gz")) {
        order.push("load-logto");
      }
      if (
        script.includes("logto_tenant_%") &&
        script.includes("GRANT USAGE ON SCHEMA public")
      ) {
        order.push("regrant-logto-tenant-roles");
      }
      if (script.includes(TEST_LOGTO_PRESEED_SQL)) {
        order.push("logto-preseed");
      }
      if (script.includes(TEST_RESYNC_SQL)) {
        order.push(
          order.includes("load-logto")
            ? "restore-tenant-password-resync"
            : "preflight-tenant-password-resync",
        );
      }
      if (script.includes(" start nautilo-server")) {
        order.push("server-start");
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
        fetch: (async (input: string | URL) => {
          const url = String(input);
          if (url.includes("/health")) {
            return new Response("ok", { status: 200 });
          }
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );

    await driver.restore(remoteProfile, {
      fromPath: bundleDir,
      force: true,
      mode: "full",
    });

    expect(order).toContain("load-logto");
    expect(order).toContain("regrant-logto-tenant-roles");
    expect(order).toContain("preflight-tenant-password-resync");
    expect(order).toContain("restore-tenant-password-resync");
    expect(order.indexOf("restore-tenant-password-resync")).toBeGreaterThan(
      order.indexOf("regrant-logto-tenant-roles"),
    );
    expect(order.indexOf("server-start")).toBeGreaterThan(
      order.indexOf("restore-tenant-password-resync"),
    );
  });

  test("injected runLogtoTenantPasswordResync seam is used on full restore", async () => {
    let seamCalls = 0;
    const bundleDir = writeFullRestoreBundle(mktmp("logto-resync-seam-bundle-"));
    const { exec } = makeFakeExec();
    const instanceRoot = join(home, ".nautilo");
    mkdirSync(instanceRoot, { recursive: true });
    writeFileSync(join(instanceRoot, "deploy.compose.env"), "COMPOSE_PROJECT_NAME=nautilo\n");
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        localExec: exec,
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
        runLogtoTenantPasswordResync: async () => {
          seamCalls += 1;
        },
      }),
    );

    await driver.restore(baseProfile, { fromPath: bundleDir, force: true, mode: "full" });
    expect(seamCalls).toBe(2);
  });
});
