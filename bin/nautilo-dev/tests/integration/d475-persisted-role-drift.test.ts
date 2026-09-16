/**
 * D475 destructive-safe live regression.
 *
 * Opt in explicitly:
 *   NAUTILO_D475_LIVE=1 bun test \
 *     bin/nautilo-dev/tests/integration/d475-persisted-role-drift.test.ts
 *
 * The fixture creates a uniquely named disposable instance, proves canonical
 * credentials work, deliberately drifts all three persisted service-role
 * domains, proves authentication fails, and then proves a bare infraStart()
 * repairs the roles without changing row counts or volume identity. Cleanup
 * targets only the exact unique containers/volumes created by this test.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { __resetResolvedInstanceForTests, resolveInstance } from "@nautilo/config";
import { infraStart } from "../../src/commands/infra-start";
import {
  infraPersistentVolumeNames,
  type InstanceServiceSecretPlan,
  resolveInstanceServiceSecrets,
} from "../../src/lib/compose-infra";
import { reconcileServiceRoles } from "../../src/lib/service-role-reconcile";

const enabled = process.env["NAUTILO_D475_LIVE"] === "1";
const originalHome = process.env["HOME"];
const originalInstance = process.env["NAUTILO_INSTANCE_ID"];
const fixtureHome = enabled
  ? mkdtempSync(join(tmpdir(), "nautilo-d475-live-"))
  : join(tmpdir(), "nautilo-d475-live-disabled");
const suffix = `${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const instanceId = `d475-${suffix}`.slice(0, 48);
const projectName = `nautilo-${instanceId}`;
const portBase = 41_000 + (process.pid % 1_000) * 7;
let servicePlan: InstanceServiceSecretPlan | undefined;
let beforeCounts: { users: number; tenants: number } | undefined;

function runDocker(args: string[], input?: string): string {
  const result = spawnSync("docker", args, {
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ""} failed (exit ${result.status ?? 1})`);
  }
  return result.stdout.trim();
}

async function quietInfraStart(): Promise<{ code: number; phases: string[] }> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const phases: string[] = [];
  const capturePhase = (...args: unknown[]): void => {
    const line = args.map(String).join(" ");
    if (
      line.startsWith("[infra") ||
      line.startsWith("[instance-secrets]") ||
      line.startsWith("internal service-role")
    ) {
      phases.push(line);
    }
  };
  console.log = capturePhase;
  console.warn = capturePhase;
  console.error = capturePhase;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return { code: await infraStart({}), phases };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

async function expectInfraStartSuccess(): Promise<void> {
  const result = await quietInfraStart();
  if (result.code !== 0) {
    throw new Error(
      `infraStart failed (exit ${result.code}); redacted phases: ${result.phases.join(" | ")}`,
    );
  }
}

async function roleProbe(
  role: string,
  password: string,
  port: number,
  database: string,
): Promise<void> {
  const url = new URL(`postgres://${role}@127.0.0.1:${port}/${database}`);
  url.password = password;
  const sql = postgres(url.toString(), { max: 1, connect_timeout: 3 });
  try {
    await sql`select 1`;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

async function expectRoleProbeFailure(probe: Promise<void>): Promise<void> {
  let failed = false;
  try {
    await probe;
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

function counts(): { users: number; tenants: number } {
  const inst = resolveInstance();
  return {
    users: Number(
      runDocker([
        "exec",
        inst.compose.containers.legacyPostgres,
        "psql",
        "-U",
        "postgres",
        "-d",
        "nautilo",
        "-t",
        "-A",
        "-c",
        "SELECT count(*) FROM users",
      ]),
    ),
    tenants: Number(
      runDocker([
        "exec",
        inst.compose.containers.logtoPostgres,
        "psql",
        "-U",
        "postgres",
        "-d",
        "logto_nautilo",
        "-t",
        "-A",
        "-c",
        "SELECT count(*) FROM tenants",
      ]),
    ),
  };
}

function expectSeedFailureBeforeRepair(canonicalPassword: string): void {
  const inst = resolveInstance();
  const url = new URL("postgres://logto@postgres:5432/logto_nautilo");
  url.password = canonicalPassword;
  const envFile = join(fixtureHome, "seed-failure.env");
  writeFileSync(envFile, `DB_URL=${url.toString()}\n`, { mode: 0o600 });
  const seed = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      `${inst.compose.projectName}_default`,
      "--env-file",
      envFile,
      "ghcr.io/logto-io/logto:1.38.0",
      "cli",
      "--",
      "db",
      "seed",
      "--swe",
    ],
    { stdio: "ignore" },
  );
  expect(seed.status).not.toBe(0);
}

describe.skipIf(!enabled)("D475 persisted service-role drift", () => {
  beforeAll(async () => {
    process.env["HOME"] = fixtureHome;
    process.env["NAUTILO_INSTANCE_ID"] = instanceId;
    const root = join(fixtureHome, `.nautilo-${instanceId}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "instance.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          instanceId,
          server: {
            host: "127.0.0.1",
            port: portBase,
            url: `http://localhost:${portBase}`,
          },
          workbench: {
            port: portBase + 1,
            url: `http://localhost:${portBase + 1}`,
          },
          db: {
            directConnection: `postgresql://postgres:postgres@localhost:${portBase + 2}/nautilo`,
            postgresHostPort: portBase + 2,
          },
          logto: {
            dbPort: portBase + 3,
            corePort: portBase + 4,
            adminPort: portBase + 5,
          },
          compose: { projectName },
          hostname: {
            federated: `${instanceId}.nautilo.local`,
            mdns: `${instanceId}.local`,
            tlsSan: "",
            caddyAuthHost: `auth.${instanceId}.local`,
            caddyAuthAdminHost: `auth-admin.${instanceId}.local`,
          },
          deploymentMode: "dev-multi-instance",
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(root, "instance.env"),
      [
        `NAUTILO_DB_PASSWORD=${randomBytes(24).toString("base64url")}`,
        `NAUTILO_AGENT_DB_PASSWORD=${randomBytes(24).toString("base64url")}`,
        `LOGTO_DB_PASSWORD=${randomBytes(24).toString("base64url")}`,
        "",
      ].join("\n"),
    );
    __resetResolvedInstanceForTests();
    const inst = resolveInstance();
    servicePlan = resolveInstanceServiceSecrets({
      instanceId,
      instanceEnvPath: join(root, "instance.env"),
    });
    await expectInfraStartSuccess();
    beforeCounts = counts();
    for (const volume of infraPersistentVolumeNames(inst)) {
      expect(runDocker(["volume", "inspect", volume, "--format", "{{.Name}}"])).toBe(
        volume,
      );
    }
  }, 180_000);

  afterAll(() => {
    __resetResolvedInstanceForTests();
    const inst = resolveInstance();
    for (const container of Object.values(inst.compose.containers)) {
      spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    }
    for (const volume of infraPersistentVolumeNames(inst)) {
      spawnSync("docker", ["volume", "rm", volume], { stdio: "ignore" });
    }
    for (const network of [
      `${inst.compose.projectName}_default`,
      `${inst.compose.projectName}_nautilo-local`,
    ]) {
      spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
    }
    const compatibilityRoot = join(homedir(), `.nautilo-${instanceId}`);
    if (compatibilityRoot.startsWith(`${homedir()}/.nautilo-d475-`)) {
      rmSync(compatibilityRoot, { recursive: true, force: true });
    }
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    if (originalInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = originalInstance;
    __resetResolvedInstanceForTests();
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  test(
    "bare startup detects and repairs all persisted role drift without data loss",
    async () => {
      const inst = resolveInstance();
      if (!servicePlan || !beforeCounts) throw new Error("fixture did not initialize");
      const wrong = randomBytes(24).toString("base64url");
      await reconcileServiceRoles({
        container: inst.compose.containers.legacyPostgres,
        roles: [
          { name: "nautilo", password: wrong },
          { name: "nautilo_agent", password: wrong },
        ],
      });
      await reconcileServiceRoles({
        container: inst.compose.containers.logtoPostgres,
        roles: [{ name: "logto", password: wrong }],
      });

      await expectRoleProbeFailure(
        roleProbe(
          "nautilo",
          servicePlan.serviceSecrets.NAUTILO_DB_PASSWORD,
          inst.db.postgresHostPort,
          "nautilo",
        ),
      );
      await expectRoleProbeFailure(
        roleProbe(
          "logto",
          servicePlan.serviceSecrets.LOGTO_DB_PASSWORD,
          inst.logto.dbPort,
          "logto_nautilo",
        ),
      );
      expectSeedFailureBeforeRepair(
        servicePlan.serviceSecrets.LOGTO_DB_PASSWORD,
      );

      await expectInfraStartSuccess();
      await roleProbe(
        "nautilo",
        servicePlan.serviceSecrets.NAUTILO_DB_PASSWORD,
        inst.db.postgresHostPort,
        "nautilo",
      );
      await roleProbe(
        "nautilo_agent",
        servicePlan.serviceSecrets.NAUTILO_AGENT_DB_PASSWORD,
        inst.db.postgresHostPort,
        "nautilo",
      );
      await roleProbe(
        "logto",
        servicePlan.serviceSecrets.LOGTO_DB_PASSWORD,
        inst.logto.dbPort,
        "logto_nautilo",
      );
      expect(counts()).toEqual(beforeCounts);
      expect(
        (
          await fetch(
            `http://localhost:${inst.logto.corePort}/oidc/.well-known/openid-configuration`,
          )
        ).status,
      ).toBe(200);
    },
    180_000,
  );
});
