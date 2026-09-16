import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  backupManifestSchema,
  BUNDLE_INTEGRITY_FILES,
  ComposeDriver,
  type BackupManifest,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
} from "../../src/index.ts";
import {
  atomicDbRestoreScript,
  failClosedRestoreScript,
  LOGTO_SCHEMA_RESET_SQL,
  NAUTILO_SCHEMA_RESET_SQL,
  validateRestoreDumpScript,
} from "../../src/ComposeDriver.ts";
import { WEBHOOK_SECRET_KEY } from "../../src/ensureForgotPasswordWebhookSecret.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

interface ExecCall {
  cmd: string;
  args: string[];
  opts: Parameters<ExecFn>[2];
}

const RESTORE_SERVER_INSTANCE_ID = "123e4567-e89b-42d3-a456-426614174000";
const RESTORE_IDENTITY_JSON = JSON.stringify({
  id: "self",
  instance_id: "",
  created_at: "2026-05-19T12:00:00.000Z",
  server_instance_id: RESTORE_SERVER_INSTANCE_ID,
  server_binding_generation: 1,
});

function identityDump(instanceId = ""): Buffer {
  return gzipSync(
    [
      "COPY public.nautilo_instance_identity (id, instance_id, created_at, server_instance_id, server_binding_generation) FROM stdin;",
      `self\t${instanceId}\t2026-05-19 12:00:00+00\t${RESTORE_SERVER_INSTANCE_ID}\t1`,
      String.raw`\.`,
      "",
    ].join("\n"),
  );
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
    const response = responder(call);
    if (
      cmd === "sh" &&
      commandText(call).includes("to_jsonb(identity_row)") &&
      response.code === 0 &&
      response.stdout === ""
    ) {
      const identity = JSON.parse(RESTORE_IDENTITY_JSON) as Record<string, unknown>;
      if (commandText(call).includes("nautilo-prod")) identity["instance_id"] = "prod";
      return { ...response, stdout: `${JSON.stringify(identity)}\n` };
    }
    return response;
  };
  return { exec, calls };
}

const baseProfile: ComposeDriverProfile = {
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

function commandText(call: ExecCall): string {
  return [call.cmd, ...call.args].join(" ");
}

function decodeRemoteFileWrite(script: string, remotePath: string): string | undefined {
  const escaped = remotePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = script.match(
    new RegExp(
      `printf %s ([^;]+) \\| base64 -d > (?:'${escaped}|${escaped}\\.tmp-\\$\\$'|${escaped}\\.tmp-\\$\\$)`,
    ),
  );
  if (!match) return undefined;
  const quoted = match[1]!.trim();
  const encoded =
    quoted.startsWith("'") && quoted.endsWith("'")
      ? quoted.slice(1, -1).replace(/'\\''/g, "'")
      : quoted;
  return Buffer.from(encoded, "base64").toString("utf8");
}

function pathText(path: Parameters<typeof nodeFs.writeFile>[0]): string {
  if (typeof path === "string") return path;
  if (Buffer.isBuffer(path)) return path.toString("utf8");
  if (path instanceof URL) return fileURLToPath(path);
  throw new Error("test fixture expected a path-like fs argument");
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

function makeFetch(events: string[], setupReady = false): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/api/setup/status")) {
      events.push("setup-probe");
      return new Response(
        setupReady ? '{"setupState":"ready"}' : '{"setupState":"new"}',
        { status: 200 },
      );
    }
    if (url.includes("/health")) {
      events.push("health-poll");
      return new Response("ok", { status: 200 });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
}

function makeDeps(
  events: string[],
  over: Partial<ComposeDriverDeps> = {},
): ComposeDriverDeps {
  const repoRoot = mktmp("compose-driver-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template\n");
  const infraDir = join(repoRoot, "infra");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "postgres-init.sh"), "#!/bin/sh\n");
  const { exec } = makeFakeExec();
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  const recordingFs: ComposeDriverDeps["fs"] = {
    ...nodeFs,
    writeFile: (async (path, data, options) => {
      const textPath = pathText(path);
      if (textPath.endsWith("deploy.restore-overlay.yml")) {
        events.push("pin-overlay");
      }
      await nodeFs.mkdir(join(textPath, ".."), { recursive: true });
      return nodeFs.writeFile(path, data, options);
    }) as typeof nodeFs.writeFile,
  };
  return {
    exec,
    localExec: exec,
    fetch: makeFetch(events),
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    ensureRemotePairingPepper: async () => "a".repeat(64),
    ensurePushTokenEncryptionKey: async () => "b".repeat(64),
    fs: recordingFs,
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
    // Restore reaches the webhook-secret ensure before several failure gates.
    // Keep every unit row hermetic: the production ensure uses config-guard's
    // intentional package-wide 10 applying-transactions/minute limiter.
    ensureForgotPasswordWebhookSecret: async () => "fake-webhook-secret",
    getAppDbRepairSql: () => "/* m212-test */ SELECT 1;",
    ...over,
  };
}

function writeBundle(
  root: string,
  over: Partial<BackupManifest> = {},
): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "logto_nautilo.sql.gz"), "");
  writeFileSync(join(root, "artifacts.tgz"), "");
  writeFileSync(join(root, "instance.env"), "SECRET=1\n");
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
    createdAt: "2026-05-19T12:34:56.000Z",
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
      instanceEnv: true,
      operatorFiles: true,
      caddyData: false,
      caddyConfig: false,
      localCaCerts: false,
    },
    https: "off",
    ...over,
  });
  writeFileSync(join(root, "nautilo.sql.gz"), identityDump(manifest.instanceId));
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  return root;
}

test("backup manifest accepts pre-media v1 bundles", () => {
  const parsed = backupManifestSchema.parse({
    version: 1,
    createdAt: "2026-05-19T12:34:56.000Z",
    profileName: "legacy",
    instanceId: "",
    transport: "local",
    composeProjectName: "nautilo",
    image: { mode: "registry" },
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
  });
  expect(parsed.contents.media).toBe(false);
});

test("backup manifest accepts pre-apps v1 bundles", () => {
  const parsed = backupManifestSchema.parse({
    version: 1,
    createdAt: "2026-05-19T12:34:56.000Z",
    profileName: "legacy",
    instanceId: "",
    transport: "local",
    composeProjectName: "nautilo",
    image: { mode: "registry" },
    contents: {
      nautiloDb: true,
      logtoDb: true,
      artifacts: true,
      media: true,
      instanceEnv: true,
      operatorFiles: false,
      caddyData: false,
      caddyConfig: false,
      localCaCerts: false,
    },
  });
  expect(parsed.contents.apps).toBe(false);
});

test("BUNDLE_INTEGRITY_FILES maps apps to apps.tgz", () => {
  expect(BUNDLE_INTEGRITY_FILES.apps).toBe("apps.tgz");
});

describe("restore full bundle", () => {
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
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env["HOME"] = savedHome;
    else delete process.env["HOME"];
    if (hadInstanceKey) process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    else delete process.env["NAUTILO_INSTANCE_ID"];
    cleanupTmp();
  });

  test("full/data restore rejects a manifest missing either mandatory DB before mutation", async () => {
    for (const mode of ["full", "data-only"] as const) {
      const events: string[] = [];
      const exec = makeFakeExec();
      const bundlePath = writeBundle(join(home, `partial-${mode}`));
      const raw = JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8")) as {
        contents: Record<string, boolean>;
      };
      raw.contents["logtoDb"] = false;
      writeFileSync(join(bundlePath, "manifest.json"), JSON.stringify(raw));
      const driver = new ComposeDriver(
        makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(
        driver.restore(baseProfile, { fromPath: bundlePath, force: true, mode }),
      ).rejects.toThrow(/must declare both Nautilo and Logto DB dumps/);
      expect(exec.calls).toHaveLength(0);
      expect(events).toHaveLength(0);
    }
  });

  test("restore accepts an identity-free fresh target and retains the bundle identity", async () => {
    let identityProbe = 0;
    const exec = makeFakeExec((call) => {
      if (call.cmd === "sh" && commandText(call).includes("to_jsonb(identity_row)")) {
        identityProbe += 1;
        return identityProbe === 1
          ? {
              code: 0,
              stdout: "__NAUTILO_INSTANCE_IDENTITY_ABSENT__\n",
              stderr: "",
            }
          : { code: 0, stdout: `${RESTORE_IDENTITY_JSON}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "fresh-target"));
    const driver = new ComposeDriver(
      makeDeps([], { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    expect(identityProbe).toBe(2);
    expect(exec.calls.map(commandText).join("\n")).not.toContain(
      "DELETE FROM public.nautilo_instance_identity",
    );
  });

  test("restore refuses a different target identity before destructive DB mutation", async () => {
    const conflictingIdentity = JSON.stringify({
      ...JSON.parse(RESTORE_IDENTITY_JSON),
      server_instance_id: "987e6543-e21b-42d3-a456-426614174999",
    });
    const exec = makeFakeExec((call) =>
      call.cmd === "sh" && commandText(call).includes("to_jsonb(identity_row)")
        ? { code: 0, stdout: `${conflictingIdentity}\n`, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "conflicting-target"));
    const driver = new ComposeDriver(
      makeDeps([], { exec: exec.exec, localExec: exec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      driver.restore(baseProfile, { fromPath: bundlePath, force: true }),
    ).rejects.toThrow(/different logical server identity/);

    expect(exec.calls.map(commandText).join("\n")).not.toContain(
      "--single-transaction",
    );
  });

  test("restore fails closed when the post-restore identity differs", async () => {
    let identityProbe = 0;
    const changedIdentity = JSON.stringify({
      ...JSON.parse(RESTORE_IDENTITY_JSON),
      server_binding_generation: 2,
    });
    const exec = makeFakeExec((call) => {
      if (call.cmd === "sh" && commandText(call).includes("to_jsonb(identity_row)")) {
        identityProbe += 1;
        return {
          code: 0,
          stdout: `${identityProbe === 1 ? RESTORE_IDENTITY_JSON : changedIdentity}\n`,
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "post-restore-drift"));
    const driver = new ComposeDriver(
      makeDeps([], { exec: exec.exec, localExec: exec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      driver.restore(baseProfile, { fromPath: bundlePath, force: true }),
    ).rejects.toThrow(/did not retain the backup's logical server identity/);

    expect(exec.calls.map(commandText).join("\n")).toContain(
      "--single-transaction",
    );
  });

  test("disaster recovery orders pin, up, stop, data loads, artifact load, start, health", async () => {
    const events: string[] = [];
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (call.cmd === "docker" && call.args.includes("pull")) events.push("pull");
      if (call.cmd === "docker" && call.args.includes("up")) events.push("up");
      if (call.cmd === "docker" && call.args.includes("stop")) events.push("stop-server");
      if (call.cmd === "docker" && call.args.includes("start")) events.push("start-server");
      if (
        call.cmd === "sh" &&
        text.includes("gunzip") &&
        text.includes("nautilo.sql.gz") &&
        !text.includes("logto_nautilo.sql.gz") &&
        text.includes("--single-transaction")
      ) {
        events.push("atomic-restore-nautilo");
      }
      if (
        call.cmd === "sh" &&
        text.includes("gunzip") &&
        text.includes("logto_nautilo.sql.gz") &&
        text.includes("--single-transaction")
      ) {
        events.push("atomic-restore-logto");
      }
      if (
        call.cmd === "sh" &&
        text.includes("logto_tenant_%") &&
        text.includes("GRANT USAGE ON SCHEMA public")
      ) {
        events.push("regrant-logto-tenant-roles");
      }
      if (
        call.cmd === "sh" &&
        text.includes("public.tenants") &&
        text.includes("ALTER ROLE %I WITH LOGIN PASSWORD %L")
      ) {
        events.push("resync-logto-tenant-passwords");
      }
      if (call.cmd === "sh" && text.includes("artifacts.tgz")) {
        events.push("load-artifacts");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "bundle"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    expect(events).toEqual([
      "up",
      "pin-overlay",
      "pull",
      "up",
      "resync-logto-tenant-passwords",
      "up",
      "stop-server",
      "atomic-restore-nautilo",
      "atomic-restore-logto",
      "regrant-logto-tenant-roles",
      "resync-logto-tenant-passwords",
      "load-artifacts",
      "start-server",
      "health-poll",
    ]);
    expect(exec.calls.map(commandText).join("\n")).not.toContain(
      "DELETE FROM public.nautilo_instance_identity",
    );

    // D420 atomic restore: reset + dump share one psql `--single-transaction`.
    const nautiloRestore = exec.calls.find(
      (c) =>
        c.cmd === "sh" &&
        commandText(c).includes("gunzip") &&
        commandText(c).includes("nautilo.sql.gz") &&
        !commandText(c).includes("logto_nautilo.sql.gz"),
    );
    const logtoRestore = exec.calls.find(
      (c) =>
        c.cmd === "sh" &&
        commandText(c).includes("gunzip") &&
        commandText(c).includes("logto_nautilo.sql.gz"),
    );
    expect(nautiloRestore).toBeDefined();
    expect(logtoRestore).toBeDefined();
    for (const restoreCall of [nautiloRestore!, logtoRestore!]) {
      const text = commandText(restoreCall);
      expect(text).toContain("ON_ERROR_STOP=1");
      expect(text).toContain("--single-transaction");
      expect(text).toContain("-X");
      expect(text).toContain("restorerc");
      expect(text).toContain("gunzip_rc");
      expect(text).toContain("DROP SCHEMA");
      expect(text).not.toMatch(/psql[^|]*-c/);
    }
    const nautiloText = commandText(nautiloRestore!);
    expect(nautiloText).toContain("nautilo.allow_destructive");
    expect(
      exec.calls.filter(
        (c) =>
          c.cmd === "sh" &&
          commandText(c).includes("DROP SCHEMA") &&
          commandText(c).includes("nautilo.sql.gz") &&
          !commandText(c).includes("logto_nautilo.sql.gz"),
      ),
    ).toHaveLength(1);
    expect(
      exec.calls.some(
        (c) =>
          c.cmd === "sh" &&
          commandText(c).includes("DROP SCHEMA") &&
          commandText(c).includes("nautilo.sql.gz") &&
          !commandText(c).includes("logto_nautilo.sql.gz") &&
          !commandText(c).includes("--single-transaction"),
      ),
    ).toBe(false);
    // The pre-DROP validation gate ran for both dumps before any DROP.
    const nautiloValidate = exec.calls.find(
      (c) =>
        c.cmd === "sh" &&
        commandText(c).includes("gzip -t") &&
        commandText(c).includes("nautilo.sql.gz") &&
        !commandText(c).includes("logto_nautilo.sql.gz"),
    );
    const logtoValidate = exec.calls.find(
      (c) =>
        c.cmd === "sh" &&
        commandText(c).includes("gzip -t") &&
        commandText(c).includes("logto_nautilo.sql.gz"),
    );
    expect(nautiloValidate).toBeDefined();
    expect(logtoValidate).toBeDefined();
    // Validation must precede the first atomic DB restore (reset is inside it).
    const restoreIndex = exec.calls.findIndex(
      (c) =>
        c.cmd === "sh" &&
        commandText(c).includes("gunzip") &&
        commandText(c).includes("--single-transaction"),
    );
    const firstValidateIndex = exec.calls.findIndex(
      (c) => c.cmd === "sh" && commandText(c).includes("gzip -t"),
    );
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(firstValidateIndex).toBeGreaterThan(-1);
    expect(firstValidateIndex).toBeLessThan(restoreIndex);
  });

  test("rolled-back server is recreated WITH the server overlay (fixes instance-id + LOGTO loss)", async () => {
    // Regression: the image-pin restore overlay alone recreated nautilo-server
    // WITHOUT NAUTILO_INSTANCE_ID (→ default-instance self-identity) and WITHOUT
    // any LOGTO_* env (→ auth dead behind a green /health). Restore must
    // regenerate the server overlay from the restored instance.env and layer it
    // into the compose `up` that recreates the container.
    const events: string[] = [];
    const exec = makeFakeExec();
    const bundlePath = writeBundle(join(home, "overlay-bundle"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    // (a) the overlay is regenerated and wires in deploy.server.env, which
    // carries the instance identity.
    const overlayYml = readFileSync(
      join(home, ".nautilo", "deploy.server-overlay.yml"),
      "utf8",
    );
    expect(overlayYml).toContain("deploy.server.env");
    const serverEnv = readFileSync(
      join(home, ".nautilo", "deploy.server.env"),
      "utf8",
    );
    expect(serverEnv).toContain("NAUTILO_INSTANCE_ID=");

    // (b) it is threaded into the `up` that recreates the container — not just
    // the image-pin overlay.
    const upCall = exec.calls.find(
      (c) =>
        c.args.includes("up") &&
        c.args.some((a) => a.endsWith("deploy.server-overlay.yml")),
    );
    expect(upCall).toBeDefined();
    expect(
      upCall?.args.some((a) => a.endsWith("deploy.server-overlay.yml")),
    ).toBe(true);
  });

  test("re-grants Logto tenant roles after the logto DB restore (idempotent, role-agnostic)", async () => {
    const events: string[] = [];
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (
        call.cmd === "sh" &&
        text.includes("logto_tenant_%") &&
        text.includes("GRANT USAGE ON SCHEMA public") &&
        text.includes("ON ALL TABLES IN SCHEMA public") &&
        text.includes("ON ALL SEQUENCES IN SCHEMA public")
      ) {
        events.push("regrant");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "regrant-bundle"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    expect(events).toContain("regrant");
  });

  // D420 (Wave 3 task 3.3.2) — restore-time role password reconciliation.
  // A restored target can boot green behind a password desync: grants are
  // correct but the cluster-level `nautilo` / `nautilo_agent` / Logto tenant
  // roles keep their pre-restore passwords. Restore must re-pin them from
  // the restored `instance.env` (app roles) and the restored `tenants` table
  // (Logto tenant roles) BEFORE application startup, idempotently and
  // fail-closed.
  test("reconciles nautilo/nautilo_agent role passwords from restored instance.env before startup", async () => {
    const events: string[] = [];
    const logs: string[] = [];
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (
        call.cmd === "sh" &&
        text.includes("-d postgres") &&
        call.opts.stdin?.includes("ALTER ROLE") &&
        call.opts.stdin.includes("nautilo_agent")
      ) {
        events.push("reconcile-nautilo-roles");
      }
      if (
        call.cmd === "sh" &&
        text.includes("-d logto_nautilo") &&
        call.opts.stdin?.includes("db_user_password FROM tenants")
      ) {
        events.push("resync-logto-tenant-roles");
      }
      if (call.cmd === "sh" && text.includes("DROP SCHEMA") && text.includes("nautilo.sql.gz")) {
        events.push("atomic-restore-nautilo");
      }
      if (call.cmd === "docker" && call.args.includes("start")) {
        events.push("start-server");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "reconcile-bundle"));
    writeFileSync(
      join(bundlePath, "instance.env"),
      "NAUTILO_DB_PASSWORD=nautilo-pw-123\nNAUTILO_AGENT_DB_PASSWORD=agent-pw-456\n",
    );
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec, log: (line) => logs.push(line) }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    // Both restored passwords reach only private stdin, never process argv or logs.
    expect(events).toContain("reconcile-nautilo-roles");
    const reconcileCall = exec.calls.find(
      (c) =>
        c.cmd === "sh" &&
        commandText(c).includes("-d postgres") &&
        c.opts.stdin?.includes("ALTER ROLE"),
    );
    expect(reconcileCall).toBeDefined();
    const reconcileText = commandText(reconcileCall!);
    expect(reconcileText).not.toContain("nautilo-pw-123");
    expect(reconcileText).not.toContain("agent-pw-456");
    expect(reconcileCall!.opts.stdin).toContain("nautilo-pw-123");
    expect(reconcileCall!.opts.stdin).toContain("agent-pw-456");
    expect(reconcileCall!.opts.stdio).toBe("pipe");
    for (const secret of ["nautilo-pw-123", "agent-pw-456"]) {
      expect(logs.join("\n")).not.toContain(secret);
      expect(exec.calls.map(commandText).join("\n")).not.toContain(secret);
    }
    // It runs after the atomic nautilo restore and before the server restart.
    expect(events.indexOf("atomic-restore-nautilo")).toBeLessThan(
      events.indexOf("reconcile-nautilo-roles"),
    );
    expect(events.indexOf("reconcile-nautilo-roles")).toBeLessThan(
      events.indexOf("start-server"),
    );
  });

  test("resyncs Logto tenant role passwords after the logto DB restore (even without app passwords)", async () => {
    const events: string[] = [];
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (
        call.cmd === "sh" &&
        text.includes("-d logto_nautilo") &&
        call.opts.stdin?.includes("db_user_password FROM tenants")
      ) {
        events.push("resync-logto-tenant-roles");
      }
      if (
        call.cmd === "sh" &&
        text.includes("logto_tenant_%") &&
        text.includes("GRANT USAGE ON SCHEMA public")
      ) {
        events.push("regrant");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    // Bundle instance.env has NO app-role passwords → app-role reconcile
    // skips, but the Logto tenant resync still runs after the logto restore.
    const bundlePath = writeBundle(join(home, "resync-only-bundle"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    expect(events).toContain("regrant");
    expect(events).toContain("resync-logto-tenant-roles");
    expect(events.indexOf("regrant")).toBeLessThan(
      events.indexOf("resync-logto-tenant-roles"),
    );
    // No app-role reconcile command was emitted (no passwords to embed).
    expect(
      exec.calls.some(
        (c) =>
          c.cmd === "sh" &&
          commandText(c).includes("-d postgres") &&
          c.opts.stdin?.includes("ALTER ROLE"),
      ),
    ).toBe(false);
  });

  test.each(["exit", "throw"])("app-role reconcile %s failure withholds echoed credential SQL and fails closed", async (failure) => {
    const logs: string[] = [];
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      if (
        call.cmd === "sh" &&
        text.includes("-d postgres") &&
        call.opts.stdin?.includes("ALTER ROLE")
      ) {
        if (failure === "throw") throw new Error(`executor echoed ${call.opts.stdin}`);
        return { code: 1, stdout: call.opts.stdin, stderr: `psql echoed ${call.opts.stdin}` };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "reconcile-fail-bundle"));
    writeFileSync(
      join(bundlePath, "instance.env"),
      "NAUTILO_DB_PASSWORD=nautilo-pw\nNAUTILO_AGENT_DB_PASSWORD=agent-pw\n",
    );
    const driver = new ComposeDriver(
      makeDeps([], { exec: exec.exec, localExec: exec.exec, log: (line) => logs.push(line) }),
    );

    let caught: unknown;
    try { await driver.restore(baseProfile, { fromPath: bundlePath, force: true }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).toContain("nautilo app-role password reconcile failed");
    expect(String(caught)).toContain("sensitive SQL diagnostics withheld");
    for (const secret of ["nautilo-pw", "agent-pw"]) {
      expect(String(caught)).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
      expect(exec.calls.map(commandText).join("\n")).not.toContain(secret);
    }
  });

  test("registry manifest writes repoDigest overlay and pulls nautilo-server", async () => {
    const events: string[] = [];
    const exec = makeFakeExec();
    const bundlePath = writeBundle(join(home, "registry-bundle"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    const overlay = readFileSync(
      join(home, ".nautilo", "deploy.restore-overlay.yml"),
      "utf8",
    );
    expect(overlay).toContain(
      "image: ghcr.io/agentsea/nautilo-server@sha256:abc",
    );
    expect(
      exec.calls.some(
        (c) =>
          c.cmd === "docker" &&
          c.args.includes("pull") &&
          c.args.includes("nautilo-server"),
      ),
    ).toBe(true);
  });

  test("source manifest with present backupTag pins tag and does not pull", async () => {
    const events: string[] = [];
    const exec = makeFakeExec();
    const bundlePath = writeBundle(join(home, "source-bundle"), {
      image: {
        mode: "source",
        imageId: "sha256:source-id",
        backupTag: "nautilo-server:backup-XYZ",
      },
    });
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    const overlay = readFileSync(
      join(home, ".nautilo", "deploy.restore-overlay.yml"),
      "utf8",
    );
    expect(overlay).toContain("image: nautilo-server:backup-XYZ");
    expect(exec.calls.some((c) => c.cmd === "docker" && c.args.includes("pull"))).toBe(
      false,
    );
  });

  test("source manifest fails clearly when backupTag image is absent", async () => {
    const events: string[] = [];
    const exec = makeFakeExec((call) =>
      call.cmd === "docker" && call.args[0] === "image" && call.args[1] === "inspect"
        ? { code: 1, stdout: "", stderr: "missing" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "source-missing"), {
      image: {
        mode: "source",
        imageId: "sha256:source-id",
        backupTag: "nautilo-server:backup-XYZ",
      },
    });
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.restore(baseProfile, { fromPath: bundlePath, force: true }),
    ).rejects.toThrow(/registry mode/);
  });

  test("--force gate refuses a healthy setupState=ready bundle target", async () => {
    const events: string[] = [];
    const bundlePath = writeBundle(join(home, "force-gate"));
    const driver = new ComposeDriver(
      makeDeps(events, {
        fetch: makeFetch(events, true),
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.restore(baseProfile, { fromPath: bundlePath, force: false }),
    ).rejects.toThrow(/restore refused/);
  });

  test("mode=data-only skips bring-up and loads only databases", async () => {
    const events: string[] = [];
    const exec = makeFakeExec();
    const bundlePath = writeBundle(join(home, "data-only"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, {
      fromPath: bundlePath,
      force: true,
      mode: "data-only",
    });

    const all = exec.calls.map(commandText).join("\n");
    expect(all).not.toContain(" pull ");
    expect(all).not.toContain(" up ");
    expect(all).not.toContain("deploy.server-overlay.yml");
    expect(all).toContain("nautilo.sql.gz");
    expect(all).toContain("logto_nautilo.sql.gz");
    expect(all).not.toContain("artifacts.tgz");
  });

  test("mode=artifacts-only loads only the artifact volume", async () => {
    const events: string[] = [];
    const exec = makeFakeExec();
    const bundlePath = writeBundle(join(home, "artifacts-only"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    await driver.restore(baseProfile, {
      fromPath: bundlePath,
      force: true,
      mode: "artifacts-only",
    });

    const all = exec.calls.map(commandText).join("\n");
    expect(all).toContain("artifacts.tgz");
    expect(all).not.toContain("nautilo.sql.gz");
    expect(all).not.toContain("logto_nautilo.sql.gz");
    expect(all).not.toContain(" psql ");
    expect(events).not.toContain("health-poll");
  });

  test("full and artifacts-only restores load durable media when the bundle includes it", async () => {
    const bundlePath = writeBundle(join(home, "media-bundle"));
    writeFileSync(join(bundlePath, "media.tgz"), "");
    const rawManifest = JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8")) as {
      contents: Record<string, boolean>;
    };
    rawManifest.contents["media"] = true;
    writeFileSync(join(bundlePath, "manifest.json"), JSON.stringify(rawManifest));

    const fullExec = makeFakeExec();
    const fullDriver = new ComposeDriver(
      makeDeps([], { exec: fullExec.exec, localExec: fullExec.exec }),
    );
    await fullDriver.restore(baseProfile, { fromPath: bundlePath, force: true });
    expect(fullExec.calls.map(commandText).join("\n")).toContain("media.tgz");

    const bytesExec = makeFakeExec();
    const bytesDriver = new ComposeDriver(
      makeDeps([], { exec: bytesExec.exec, localExec: bytesExec.exec }),
    );
    await bytesDriver.restore(baseProfile, {
      fromPath: bundlePath,
      force: true,
      mode: "artifacts-only",
    });
    const all = bytesExec.calls.map(commandText).join("\n");
    expect(all).toContain("artifacts.tgz");
    expect(all).toContain("media.tgz");
    expect(all).not.toContain("nautilo.sql.gz");
  });

  test("old bundles without media skip the media volume restore", async () => {
    const exec = makeFakeExec();
    const bundlePath = writeBundle(join(home, "legacy-media-less"));
    const driver = new ComposeDriver(makeDeps([], { exec: exec.exec, localExec: exec.exec }));

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    expect(exec.calls.map(commandText).join("\n")).not.toContain("media.tgz");
  });

  test("full and artifacts-only restores load durable apps when the bundle includes it", async () => {
    const bundlePath = writeBundle(join(home, "apps-bundle"));
    writeFileSync(join(bundlePath, "apps.tgz"), "");
    const rawManifest = JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8")) as {
      contents: Record<string, boolean>;
    };
    rawManifest.contents["apps"] = true;
    writeFileSync(join(bundlePath, "manifest.json"), JSON.stringify(rawManifest));

    const fullExec = makeFakeExec();
    const fullDriver = new ComposeDriver(
      makeDeps([], { exec: fullExec.exec, localExec: fullExec.exec }),
    );
    await fullDriver.restore(baseProfile, { fromPath: bundlePath, force: true });
    expect(fullExec.calls.map(commandText).join("\n")).toContain("apps.tgz");
    expect(fullExec.calls.map(commandText).join("\n")).toContain("nautilo_app_apps");

    const bytesExec = makeFakeExec();
    const bytesDriver = new ComposeDriver(
      makeDeps([], { exec: bytesExec.exec, localExec: bytesExec.exec }),
    );
    await bytesDriver.restore(baseProfile, {
      fromPath: bundlePath,
      force: true,
      mode: "artifacts-only",
    });
    const all = bytesExec.calls.map(commandText).join("\n");
    expect(all).toContain("apps.tgz");
    expect(all).toContain("nautilo_app_apps");
    expect(all).not.toContain("nautilo.sql.gz");
  });

  test("old bundles without apps skip the apps volume restore", async () => {
    const exec = makeFakeExec();
    const bundlePath = writeBundle(join(home, "legacy-apps-less"));
    const driver = new ComposeDriver(makeDeps([], { exec: exec.exec, localExec: exec.exec }));

    await driver.restore(baseProfile, { fromPath: bundlePath, force: true });

    expect(exec.calls.map(commandText).join("\n")).not.toContain("apps.tgz");
  });

  test("remote registry bundle restore uses remote overlays and SSH-native compose only", async () => {
    const events: string[] = [];
    const remoteRoot = "/opt/nautilo-prod";
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: false,
      tag: "main",
      instance_id: "prod",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const deploymentManifest = {
      version: 1,
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      lifecycle: "compose",
      image: {
        mode: "registry" as const,
        reference: "ghcr.io/agentsea/nautilo-server:main",
      },
      remoteRoot,
      https: "off" as const,
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:30:00.000Z",
    };
    const exec = makeFakeExec((call) => {
      if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
        return { code: 0, stdout: JSON.stringify(deploymentManifest), stderr: "" };
      }
      const text = commandText(call);
      if (call.cmd === "sh" && text.includes("docker compose")) {
        if (text.includes(" pull nautilo-server")) events.push("pull");
        else if (text.includes(" up -d --no-build")) events.push("up");
        else if (text.includes(" stop nautilo-server")) events.push("stop");
        else if (text.includes(" start nautilo-server")) events.push("start");
      }
      if (
        text.includes("gunzip") &&
        text.includes("nautilo.sql.gz") &&
        !text.includes("logto_nautilo.sql.gz") &&
        text.includes("--single-transaction")
      ) {
        events.push("load-nautilo");
      }
      if (
        text.includes("gunzip") &&
        text.includes("logto_nautilo.sql.gz") &&
        text.includes("--single-transaction")
      ) {
        events.push("load-logto");
      }
      if (text.includes("artifacts.tgz")) events.push("load-artifacts");
      if (text.includes("media.tgz")) events.push("load-media");
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec((call) =>
      call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 3.2.7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "remote-registry-bundle"), {
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      transport: "remote",
    });
    const bundleInstance = JSON.parse(
      readFileSync(join(bundlePath, "operator", "instance.json"), "utf8"),
    ) as { instanceId: string };
    bundleInstance.instanceId = "prod";
    writeFileSync(
      join(bundlePath, "operator", "instance.json"),
      JSON.stringify(bundleInstance),
    );
    writeFileSync(join(bundlePath, "media.tgz"), "");
    const remoteBundleManifest = JSON.parse(
      readFileSync(join(bundlePath, "manifest.json"), "utf8"),
    ) as {
      contents: Record<string, boolean>;
      image: { repoDigest?: string };
    };
    remoteBundleManifest.contents["media"] = true;
    remoteBundleManifest.contents["composeTemplate"] = true;
    remoteBundleManifest.image.repoDigest =
      `ghcr.io/agentsea/nautilo-server@sha256:${"a".repeat(64)}`;
    writeFileSync(join(bundlePath, "manifest.json"), JSON.stringify(remoteBundleManifest));
    writeFileSync(join(bundlePath, "docker-compose.yml"), "# captured pre-upgrade template\n");
    const driver = new ComposeDriver(
      makeDeps(events, {
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.restore(remoteProfile, { fromPath: bundlePath, force: true });

    expect(events).toEqual([
      "pull",
      "up",
      "stop",
      "load-nautilo",
      "load-logto",
      "load-artifacts",
      "load-media",
      "start",
      "health-poll",
    ]);
    expect(exec.calls.some((call) => call.cmd === "docker")).toBe(false);
    expect(
      exec.calls.every((call) => call.opts.env?.["DOCKER_HOST"] === undefined),
    ).toBe(true);
    expect(localExec.calls.some((call) => call.cmd === "rsync")).toBe(true);

    const remoteCompose = exec.calls
      .filter((call) => call.cmd === "sh" && (call.args[1] ?? "").includes("docker compose"))
      .map((call) => call.args[1] ?? "");
    expect(remoteCompose.length).toBeGreaterThanOrEqual(4);
    for (const script of remoteCompose) {
      expect(script).toContain(`${remoteRoot}/deploy.volumes-overlay.yml`);
      expect(script).toContain(`${remoteRoot}/deploy.server-overlay.yml`);
      expect(script).toContain(`${remoteRoot}/deploy.restore-overlay.yml`);
      expect(script).not.toContain("DOCKER_HOST");
      expect(script).not.toContain(".remote-staging");
    }
    const up = remoteCompose.find((script) => script.includes(" up -d --no-build"));
    expect(up).toBeDefined();
    const logtoPostgresUp = remoteCompose.find(
      (script) => script.includes("logto-postgres") && script.includes(" up -d"),
    );
    expect(logtoPostgresUp).toBeDefined();
    expect(logtoPostgresUp).toContain("--wait");
    const fullStackUp = remoteCompose.find(
      (script) =>
        script.includes(" up -d --no-build") &&
        !script.includes("logto-postgres") &&
        !script.includes("app-postgres"),
    );
    expect(fullStackUp).toBeDefined();
    expect(fullStackUp).not.toContain("--wait");
    expect(up!.indexOf("deploy.server-overlay.yml")).toBeLessThan(
      up!.indexOf("deploy.restore-overlay.yml"),
    );
    const remoteWrites = exec.calls
      .filter((call) => call.cmd === "sh" && (call.args[1] ?? "").includes("printf %s"))
      .map((call) => call.args[1] ?? "")
      .join("\n");
    expect(remoteWrites).toContain(`${remoteRoot}/deploy.server-overlay.yml`);
    expect(remoteWrites).toContain(`${remoteRoot}/deploy.volumes-overlay.yml`);
    expect(remoteWrites).toContain(`${remoteRoot}/deploy.restore-overlay.yml`);
    expect(remoteWrites).toContain(`${remoteRoot}/instance.env`);
    expect(
      exec.calls
        .map((call) =>
          decodeRemoteFileWrite(call.args[1] ?? "", `${remoteRoot}/docker-compose.yml`),
        )
        .find((contents) => contents !== undefined),
    ).toBe("# captured pre-upgrade template\n");
  });

  test("remote full restore from a source-current target reconciles registry bundle identity", async () => {
    const remoteRoot = mktmp("remote-source-current-");
    const repoDigest = `ghcr.io/agentsea/nautilo-server@sha256:${"f".repeat(64)}`;
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      tag: "main",
      instance_id: "prod",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const deploymentManifest = {
      version: 2,
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      lifecycle: "compose",
      image: {
        mode: "source" as const,
        reference: "sha256:incoming-source",
      },
      remoteRoot,
      https: "off" as const,
      contracts: {},
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:30:00.000Z",
    };
    const exec = makeFakeExec((call) => {
      if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
        return { code: 0, stdout: JSON.stringify(deploymentManifest), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec((call) =>
      call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 3.2.7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "remote-manifest-registry-bundle"), {
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      transport: "remote",
    });
    const bundleInstance = JSON.parse(
      readFileSync(join(bundlePath, "operator", "instance.json"), "utf8"),
    ) as { instanceId: string };
    bundleInstance.instanceId = "prod";
    writeFileSync(
      join(bundlePath, "operator", "instance.json"),
      JSON.stringify(bundleInstance),
    );
    process.env["NAUTILO_INSTANCE_ID"] = "prod";
    const remoteBundleManifest = JSON.parse(
      readFileSync(join(bundlePath, "manifest.json"), "utf8"),
    ) as { image: { repoDigest?: string } };
    remoteBundleManifest.image.repoDigest = repoDigest;
    writeFileSync(join(bundlePath, "manifest.json"), JSON.stringify(remoteBundleManifest));
    const driver = new ComposeDriver(
      makeDeps([], {
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.restore(remoteProfile, { fromPath: bundlePath, force: true, mode: "full" });

    // Older bundles have no composeTemplate flag, so retain the established
    // fallback to the current driver template rather than refusing recovery.
    expect(
      exec.calls
        .map((call) =>
          decodeRemoteFileWrite(call.args[1] ?? "", `${remoteRoot}/docker-compose.yml`),
        )
        .find((contents) => contents !== undefined),
    ).toBe("# unit-test template\n");
    const manifestWrite = exec.calls
      .map((call) => decodeRemoteFileWrite(call.args[1] ?? "", `${remoteRoot}/deployment-manifest.json`))
      .find((contents) => contents !== undefined);
    expect(manifestWrite).toBeDefined();
    const reconciled = JSON.parse(manifestWrite!) as { image: { mode: string; reference: string } };
    expect(reconciled.image).toEqual({
      mode: "registry",
      reference: repoDigest,
    });
    const reconciliationCall = exec.calls.find((call) => {
      const script = call.args[1] ?? "";
      return (
        decodeRemoteFileWrite(
          script,
          `${remoteRoot}/deployment-manifest.json`,
        ) !== undefined &&
        decodeRemoteFileWrite(
          script,
          `${remoteRoot}/deploy.registry-overlay.yml`,
        ) !== undefined
      );
    });
    expect(reconciliationCall).toBeDefined();
    expect(
      decodeRemoteFileWrite(
        reconciliationCall!.args[1] ?? "",
        `${remoteRoot}/deploy.registry-overlay.yml`,
      ),
    ).toContain(repoDigest);
    const restoreComposeScripts = exec.calls
      .filter(
        (call) =>
          call.cmd === "sh" &&
          (call.args[1] ?? "").includes("docker compose") &&
          (call.args[1] ?? "").includes("deploy.restore-overlay.yml"),
      )
      .map((call) => call.args[1] ?? "");
    expect(restoreComposeScripts.length).toBeGreaterThan(0);
    expect(
      restoreComposeScripts.every(
        (script) => !script.includes("deploy.registry-overlay.yml"),
      ),
    ).toBe(true);

    exec.calls.length = 0;
    localExec.calls.length = 0;
    await driver.restore(remoteProfile, {
      fromPath: bundlePath,
      force: true,
      mode: "full",
      stream: true,
    });
    const streamedReconciliation = exec.calls.find((call) => {
      const script = call.args[1] ?? "";
      return (
        decodeRemoteFileWrite(
          script,
          `${remoteRoot}/deployment-manifest.json`,
        ) !== undefined &&
        decodeRemoteFileWrite(
          script,
          `${remoteRoot}/deploy.registry-overlay.yml`,
        ) !== undefined
      );
    });
    expect(streamedReconciliation).toBeDefined();
    expect(
      decodeRemoteFileWrite(
        streamedReconciliation!.args[1] ?? "",
        `${remoteRoot}/deploy.registry-overlay.yml`,
      ),
    ).toContain(repoDigest);
  });

  test("remote full restore treats a synthetic local RepoDigest as a retained source tag", async () => {
    const remoteRoot = "/opt/nautilo-prod";
    const backupTag = "nautilo-server:rollback-source";
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: false,
      tag: "main",
      instance_id: "prod",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const deploymentManifest = {
      version: 2,
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      lifecycle: "compose",
      image: {
        mode: "registry" as const,
        reference: `ghcr.io/agentsea/nautilo-server@sha256:${"a".repeat(64)}`,
      },
      remoteRoot,
      https: "off" as const,
      contracts: {},
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:30:00.000Z",
    };
    const exec = makeFakeExec((call) => {
      if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
        return { code: 0, stdout: JSON.stringify(deploymentManifest), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec((call) =>
      call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 3.2.7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "remote-manifest-source-bundle"), {
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      transport: "remote",
    });
    writeFileSync(
      join(bundlePath, "manifest.json"),
      JSON.stringify({
        ...JSON.parse(readFileSync(join(bundlePath, "manifest.json"), "utf8")),
        image: {
          mode: "registry",
          repoDigest: `nautilo-server@sha256:${"b".repeat(64)}`,
          imageId: "sha256:legacy-source",
          tag: backupTag,
        },
      }),
    );
    const bundleInstance = JSON.parse(
      readFileSync(join(bundlePath, "operator", "instance.json"), "utf8"),
    ) as { instanceId: string };
    bundleInstance.instanceId = "prod";
    writeFileSync(
      join(bundlePath, "operator", "instance.json"),
      JSON.stringify(bundleInstance),
    );
    process.env["NAUTILO_INSTANCE_ID"] = "prod";
    const driver = new ComposeDriver(
      makeDeps([], {
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.restore(remoteProfile, { fromPath: bundlePath, force: true, mode: "full" });

    const manifestWrite = exec.calls
      .map((call) => decodeRemoteFileWrite(call.args[1] ?? "", `${remoteRoot}/deployment-manifest.json`))
      .find((contents) => contents !== undefined);
    expect(manifestWrite).toBeDefined();
    const reconciled = JSON.parse(manifestWrite!) as { image: { mode: string; reference: string } };
    expect(reconciled.image).toEqual({
      mode: "source",
      reference: backupTag,
    });
    const reconciliationCall = exec.calls.find((call) => {
      const script = call.args[1] ?? "";
      return (
        decodeRemoteFileWrite(
          script,
          `${remoteRoot}/deployment-manifest.json`,
        ) !== undefined &&
        decodeRemoteFileWrite(
          script,
          `${remoteRoot}/deploy.registry-overlay.yml`,
        ) !== undefined
      );
    });
    expect(reconciliationCall).toBeDefined();
    expect(
      decodeRemoteFileWrite(
        reconciliationCall!.args[1] ?? "",
        `${remoteRoot}/deploy.registry-overlay.yml`,
      ),
    ).toContain(backupTag);
    expect(
      exec.calls.some(
        (call) =>
          call.cmd === "sh" &&
          (call.args[1] ?? "").includes(" pull nautilo-server"),
      ),
    ).toBe(false);
  });

  test("remote data-only restore does not reconcile deployment-manifest", async () => {
    const remoteRoot = "/opt/nautilo-prod";
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: false,
      tag: "main",
      instance_id: "prod",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const deploymentManifest = {
      version: 1,
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      lifecycle: "compose",
      image: {
        mode: "registry" as const,
        reference: "ghcr.io/agentsea/nautilo-server:main",
      },
      remoteRoot,
      https: "off" as const,
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:30:00.000Z",
    };
    const exec = makeFakeExec((call) => {
      if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
        return { code: 0, stdout: JSON.stringify(deploymentManifest), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec((call) =>
      call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 3.2.7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "remote-data-only-manifest"), {
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      transport: "remote",
    });
    const driver = new ComposeDriver(
      makeDeps([], {
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.restore(remoteProfile, {
      fromPath: bundlePath,
      force: true,
      mode: "data-only",
    });

    expect(
      exec.calls.some((call) => (call.args[1] ?? "").includes("deployment-manifest.json")),
    ).toBe(false);
  });

  test("remote bundle restore does not generate operator-local webhook secret (M207)", async () => {
    const events: string[] = [];
    const remoteRoot = "/opt/nautilo-prod";
    const bundleCanonicalSecret = "bundle-canonical-webhook-secret";
    const operatorGeneratedSecret = "operator-generated-webhook-secret";
    let ensureHookCalls = 0;
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: false,
      tag: "main",
      instance_id: "prod",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const deploymentManifest = {
      version: 1,
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      lifecycle: "compose",
      image: {
        mode: "registry" as const,
        reference: "ghcr.io/agentsea/nautilo-server:main",
      },
      remoteRoot,
      https: "off" as const,
      createdAt: "2026-05-19T12:00:00.000Z",
      updatedAt: "2026-05-19T12:30:00.000Z",
    };
    const exec = makeFakeExec((call) => {
      if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
        return { code: 0, stdout: JSON.stringify(deploymentManifest), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const localExec = makeFakeExec((call) =>
      call.cmd === "rsync" && call.args[0] === "--version"
        ? { code: 0, stdout: "rsync  version 3.2.7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "remote-m207-secret-bundle"), {
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      transport: "remote",
    });
    writeFileSync(
      join(bundlePath, "instance.env"),
      `${WEBHOOK_SECRET_KEY}=${bundleCanonicalSecret}\n`,
    );
    const bundleInstance = JSON.parse(
      readFileSync(join(bundlePath, "operator", "instance.json"), "utf8"),
    ) as { instanceId: string };
    bundleInstance.instanceId = "prod";
    writeFileSync(
      join(bundlePath, "operator", "instance.json"),
      JSON.stringify(bundleInstance),
    );
    const driver = new ComposeDriver(
      makeDeps(events, {
        exec: exec.exec,
        localExec: localExec.exec,
        resolveInstanceRootDir: () => remoteRoot,
        ensureForgotPasswordWebhookSecret: async () => {
          ensureHookCalls += 1;
          return operatorGeneratedSecret;
        },
      }),
    );

    await driver.restore(remoteProfile, { fromPath: bundlePath, force: true });

    expect(ensureHookCalls).toBe(0);
    const remoteWriteScript = exec.calls
      .filter((call) => call.cmd === "sh" && (call.args[1] ?? "").includes("printf %s"))
      .map((call) => call.args[1] ?? "")
      .join("\n");
    const remoteServerEnv = decodeRemoteFileWrite(
      remoteWriteScript,
      `${remoteRoot}/deploy.server.env`,
    );
    expect(remoteServerEnv).toBeDefined();
    expect(remoteServerEnv).not.toContain(WEBHOOK_SECRET_KEY);
    expect(remoteServerEnv).not.toContain(operatorGeneratedSecret);
    const remoteInstanceEnv = decodeRemoteFileWrite(
      remoteWriteScript,
      `${remoteRoot}/runtime-config/instance.env`,
    );
    expect(remoteInstanceEnv).toContain(
      `${WEBHOOK_SECRET_KEY}=${bundleCanonicalSecret}`,
    );
    expect(remoteWriteScript).toContain("ln -s runtime-config/instance.env");
  });

  test("remote bundle restore refuses manifest mismatch before remote mutation", async () => {
    const events: string[] = [];
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: false,
      tag: "main",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const exec = makeFakeExec((call) =>
      call.cmd === "cat"
        ? {
            code: 0,
            stdout: JSON.stringify({
              version: 1,
              instanceId: "",
              composeProjectName: "wrong-project",
              lifecycle: "compose",
              image: {
                mode: "registry",
                reference: "ghcr.io/agentsea/nautilo-server:main",
              },
              remoteRoot: "/opt/nautilo",
              https: "off",
              createdAt: "2026-05-19T12:00:00.000Z",
              updatedAt: "2026-05-19T12:30:00.000Z",
            }),
            stderr: "",
          }
        : { code: 0, stdout: "", stderr: "" },
    );
    const bundlePath = writeBundle(join(home, "remote-mismatch-bundle"), {
      transport: "remote",
    });
    const driver = new ComposeDriver(
      makeDeps(events, {
        exec: exec.exec,
        localExec: makeFakeExec().exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.restore(remoteProfile, { fromPath: bundlePath, force: true }),
    ).rejects.toThrow(/identity mismatch/);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.cmd).toBe("cat");
  });

  test("plain .sql.gz routes through the legacy single-DB restore path", async () => {
    const events: string[] = [];
    const localExecCalls: ExecCall[] = [];
    const localExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const exec = makeFakeExec();
    const legacyPath = join(home, "legacy.sql.gz");
    writeFileSync(legacyPath, "");
    const driver = new ComposeDriver(
      makeDeps(events, {
        exec: exec.exec,
        localExec,
        fs: {
          ...nodeFs,
          readFile: (async (path, options) => {
            if (pathText(path).includes("manifest.json")) {
              throw new Error("manifest should not be read");
            }
            return nodeFs.readFile(path, options);
          }) as typeof nodeFs.readFile,
        },
      }),
    );

    await driver.restore(baseProfile, { fromPath: legacyPath, force: true });

    const shell = localExecCalls.map(commandText).join("\n");
    expect(shell).toContain(`gunzip -c ${legacyPath}`);
    expect(shell).toContain("exec -T app-postgres psql -U postgres nautilo");
    expect(shell).not.toContain("manifest");
  });

  test("corrupt nautilo gzip fails validation before any destructive schema reset", async () => {
    const events: string[] = [];
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      // D420 3.1.1: simulate a corrupt/truncated nautilo dump — the
      // pre-DROP validation gate exits nonzero. The logto dump is fine.
      if (
        call.cmd === "sh" &&
        text.includes("gzip -t") &&
        text.includes("nautilo.sql.gz") &&
        !text.includes("logto_nautilo.sql.gz")
      ) {
        return { code: 1, stdout: "", stderr: "dump corrupt gzip" };
      }
      if (call.cmd === "sh" && text.includes("DROP SCHEMA")) {
        events.push("drop-attempted");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "corrupt-nautilo"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.restore(baseProfile, { fromPath: bundlePath, force: true }),
    ).rejects.toThrow(/nautilo DB dump validation failed/);

    // No destructive schema reset ran on either DB — the corrupt dump was
    // rejected before either schema was destroyed.
    expect(events).not.toContain("drop-attempted");
    expect(
      exec.calls.some(
        (c) => c.cmd === "sh" && commandText(c).includes("DROP SCHEMA"),
      ),
    ).toBe(false);
    // The nautilo restore pipeline (gunzip|psql) never ran either.
    expect(
      exec.calls.some(
        (c) =>
          c.cmd === "sh" &&
          commandText(c).includes("gunzip") &&
          commandText(c).includes("nautilo.sql.gz"),
      ),
    ).toBe(false);
  });

  test("corrupt logto gzip fails validation before any destructive schema reset", async () => {
    const events: string[] = [];
    const exec = makeFakeExec((call) => {
      const text = commandText(call);
      // nautilo dump is valid (default code 0); logto dump is corrupt.
      if (
        call.cmd === "sh" &&
        text.includes("gzip -t") &&
        text.includes("logto_nautilo.sql.gz")
      ) {
        return { code: 1, stdout: "", stderr: "dump corrupt gzip" };
      }
      if (call.cmd === "sh" && text.includes("DROP SCHEMA")) {
        events.push("drop-attempted");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const bundlePath = writeBundle(join(home, "corrupt-logto"));
    const driver = new ComposeDriver(
      makeDeps(events, { exec: exec.exec, localExec: exec.exec }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.restore(baseProfile, { fromPath: bundlePath, force: true }),
    ).rejects.toThrow(/logto DB dump validation failed/);

    // nautilo validation passed, but NO schema reset ran on either DB — the
    // logto dump was rejected before the first DROP.
    expect(events).not.toContain("drop-attempted");
    expect(
      exec.calls.some(
        (c) => c.cmd === "sh" && commandText(c).includes("DROP SCHEMA"),
      ),
    ).toBe(false);
  });

  // D420 (Wave 3 task 3.3.1) — consolidated restore validation fault table.
  // Restore is the rollback action for the entire upgrade transaction, so a
  // restore validation failure must fail CLOSED before ANY destructive schema
  // reset AND before the restore pipeline (gunzip|psql) loads a byte — a
  // corrupt dump can never partially overwrite the live DB. The table proves
  // both guarantees uniformly for each DB: no DROP attempted, and the failing
  // DB's restore pipeline never ran. (R9A: validate compressed input before
  // schema destruction; decompression failure aborts recovery.)
  describe("D420 (3.3.1) restore validation fault table", () => {
    const modes: Array<{
      label: string;
      inject: "nautilo" | "logto";
      expectErr: RegExp;
      dumpFile: string;
    }> = [
      {
        label: "corrupt nautilo gzip fails before any destructive schema reset or load",
        inject: "nautilo",
        expectErr: /nautilo DB dump validation failed/,
        dumpFile: "nautilo.sql.gz",
      },
      {
        label: "corrupt logto gzip fails before any destructive schema reset or load",
        inject: "logto",
        expectErr: /logto DB dump validation failed/,
        dumpFile: "logto_nautilo.sql.gz",
      },
    ];

    for (const mode of modes) {
      test(mode.label, async () => {
        const events: string[] = [];
        const exec = makeFakeExec((call) => {
          const text = commandText(call);
          const isNautiloValidate =
            text.includes("gzip -t") &&
            text.includes("nautilo.sql.gz") &&
            !text.includes("logto_nautilo.sql.gz");
          const isLogtoValidate =
            text.includes("gzip -t") && text.includes("logto_nautilo.sql.gz");
          if (mode.inject === "nautilo" && isNautiloValidate) {
            return { code: 1, stdout: "", stderr: "dump corrupt gzip" };
          }
          if (mode.inject === "logto" && isLogtoValidate) {
            return { code: 1, stdout: "", stderr: "dump corrupt gzip" };
          }
          if (call.cmd === "sh" && text.includes("DROP SCHEMA")) {
            events.push("drop-attempted");
          }
          return { code: 0, stdout: "", stderr: "" };
        });
        const bundlePath = writeBundle(join(home, `restore-fault-${mode.inject}`));
        const driver = new ComposeDriver(
          makeDeps(events, {
            exec: exec.exec,
            localExec: exec.exec,
            // Hermetic: avoid a real config-guard.transaction() for the webhook
            // secret so these fault rows do not push the package-wide 10/min
            // config-guard rate-limit window (the restore path reaches the
            // webhook-secret ensure before the validation gate throws).
            ensureForgotPasswordWebhookSecret: async () => "fake-webhook-secret",
          }),
        );

        // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
        await expect(
          driver.restore(baseProfile, { fromPath: bundlePath, force: true }),
        ).rejects.toThrow(mode.expectErr);

        // No destructive schema reset ran on either DB.
        expect(events).not.toContain("drop-attempted");
        expect(
          exec.calls.some(
            (c) => c.cmd === "sh" && commandText(c).includes("DROP SCHEMA"),
          ),
        ).toBe(false);
        // The restore pipeline (gunzip|psql) never ran for the failing DB —
        // validation gates the destructive load, not just the DROP.
        expect(
          exec.calls.some(
            (c) =>
              c.cmd === "sh" &&
              commandText(c).includes("gunzip") &&
              commandText(c).includes(mode.dumpFile),
          ),
        ).toBe(false);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// D420 3.1.1 / R9A — exercise the fail-closed restore pipeline + dump
// validation gate in a REAL POSIX shell (no faked exec). A stub `psql`
// stands in for the database client so we can prove the side-file status
// propagation actually defeats the gunzip-masking and first-SQL-error cases
// that plain `gunzip | psql` would hide.
// ---------------------------------------------------------------------------

async function shExit(script: string): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", script], {
    stdout: "ignore",
    stderr: "pipe",
  });
  await proc.exited;
  // exitCode is null when the process was killed by a signal; map that to a
  // nonzero sentinel so failure assertions still hold and success (0) is not
  // falsely reported.
  const code = proc.exitCode;
  return code === null ? -1 : code;
}

const PSQL_OK = "sh -c 'cat >/dev/null 2>&1; exit 0'";
const PSQL_FAIL = "sh -c 'cat >/dev/null 2>&1; exit 1'";

function writeValidGzip(path: string, contents = "SELECT 1;\n"): void {
  const bytes = Bun.gzipSync(new TextEncoder().encode(contents));
  writeFileSync(path, bytes);
}

function writeCorruptGzip(path: string): void {
  // A truncated gzip stream: valid header, missing body/CRC. `gzip -t`
  // rejects it and `gunzip -c` exits nonzero (may emit partial output).
  const bytes = Bun.gzipSync(new TextEncoder().encode("SELECT 1;\n"));
  const truncated = bytes.slice(0, Math.max(2, Math.floor(bytes.length / 2)));
  writeFileSync(path, truncated);
}

describe("restore fail-closed pipeline (real shell)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "restore-failclosed-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("validateRestoreDumpScript accepts a valid gzip and rejects missing/empty/corrupt", async () => {
    const valid = join(dir, "valid.sql.gz");
    writeValidGzip(valid);
    expect(await shExit(validateRestoreDumpScript(valid))).toBe(0);

    const missing = join(dir, "missing.sql.gz");
    expect(await shExit(validateRestoreDumpScript(missing))).toBe(2);

    const empty = join(dir, "empty.sql.gz");
    writeFileSync(empty, "");
    expect(await shExit(validateRestoreDumpScript(empty))).toBe(3);

    const corrupt = join(dir, "corrupt.sql.gz");
    writeCorruptGzip(corrupt);
    expect(await shExit(validateRestoreDumpScript(corrupt))).toBe(4);
  });

  test("a valid gzip + successful psql restores (exit 0)", async () => {
    const dump = join(dir, "nautilo.sql.gz");
    writeValidGzip(dump, "CREATE TABLE t (x int);\nINSERT INTO t VALUES (1);\n");
    const script = failClosedRestoreScript(dump, PSQL_OK);
    expect(await shExit(script)).toBe(0);
  });

  test("gunzip failure is NOT masked by psql success", async () => {
    // The masking case: gunzip fails on a corrupt stream, but psql exits 0
    // on the empty/partial input. Plain `gunzip | psql` would return 0;
    // the fail-closed script must propagate gunzip's nonzero status.
    const dump = join(dir, "nautilo.sql.gz");
    writeCorruptGzip(dump);
    const script = failClosedRestoreScript(dump, PSQL_OK);
    const code = await shExit(script);
    expect(code).not.toBe(0);
  });

  test("a first SQL error (psql nonzero) stops the restore", async () => {
    // psql aborts on the first SQL error (ON_ERROR_STOP=1); the fail-closed
    // script must surface psql's nonzero status rather than reporting success.
    const dump = join(dir, "nautilo.sql.gz");
    writeValidGzip(dump);
    const script = failClosedRestoreScript(dump, PSQL_FAIL);
    const code = await shExit(script);
    expect(code).not.toBe(0);
  });

  test("the restore script invokes psql with ON_ERROR_STOP=1", async () => {
    const dump = join(dir, "nautilo.sql.gz");
    writeValidGzip(dump);
    const script = failClosedRestoreScript(dump, "psql -U postgres -d nautilo");
    expect(script).toContain("-v ON_ERROR_STOP=1");
    // gunzip failure is captured via a side status file, not pipefail.
    expect(script).toContain("restorerc.$$");
    expect(script).toContain("gunzip_rc");
  });

  test("a valid restore preserves the decompressed byte sequence to psql", async () => {
    // End-to-end: real gunzip feeds a stub psql that captures its stdin to
    // a file; the captured bytes must equal the original (uncompressed) SQL,
    // proving the pipeline preserves sequence fidelity on a valid restore.
    const sql = "CREATE TABLE t (x int);\nINSERT INTO t VALUES (42);\n";
    const dump = join(dir, "nautilo.sql.gz");
    writeValidGzip(dump, sql);
    const captured = join(dir, "captured.sql");
    const capturePsql = `sh -c 'cat >${shellQuoteLit(captured)}'`;
    const script = failClosedRestoreScript(dump, capturePsql);
    expect(await shExit(script)).toBe(0);
    expect(readFileSync(captured, "utf8")).toBe(sql);
  });
});

describe("atomic DB restore (real shell)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "restore-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reset SQL and dump load share one psql --single-transaction invocation", async () => {
    const dump = join(dir, "nautilo.sql.gz");
    writeValidGzip(dump, "CREATE TABLE t (x int);\n");
    const script = atomicDbRestoreScript(dump, PSQL_OK, NAUTILO_SCHEMA_RESET_SQL);
    expect(script).toContain("--single-transaction");
    expect(script).toContain("-X");
    expect(script).toContain("nautilo.allow_destructive");
    expect(script).not.toMatch(/psql[^|]*-c/);
    expect(await shExit(script)).toBe(0);
  });

  test("reset is prepended before dump bytes in the same stdin stream", async () => {
    const dumpSql = "CREATE TABLE restored (x int);\n";
    const dump = join(dir, "nautilo.sql.gz");
    writeValidGzip(dump, dumpSql);
    const captured = join(dir, "stdin-capture.sql");
    const capturePsql = `sh -c 'cat >${shellQuoteLit(captured)}'`;
    const script = atomicDbRestoreScript(dump, capturePsql, NAUTILO_SCHEMA_RESET_SQL);
    expect(await shExit(script)).toBe(0);
    const capturedText = readFileSync(captured, "utf8");
    expect(capturedText.startsWith(NAUTILO_SCHEMA_RESET_SQL)).toBe(true);
    expect(capturedText.endsWith(dumpSql)).toBe(true);
    expect(capturedText.indexOf("DROP SCHEMA")).toBeLessThan(
      capturedText.indexOf("CREATE TABLE restored"),
    );
  });

  test("logto reset omits nautilo.allow_destructive but stays atomic", async () => {
    const dump = join(dir, "logto_nautilo.sql.gz");
    writeValidGzip(dump, "SELECT 1;\n");
    const script = atomicDbRestoreScript(
      dump,
      "sh -c 'cat >/dev/null'",
      LOGTO_SCHEMA_RESET_SQL,
    );
    expect(script).toContain("--single-transaction");
    expect(script).not.toContain("nautilo.allow_destructive");
    expect(await shExit(script)).toBe(0);
  });

  test("gunzip failure prevents psql from reporting success", async () => {
    const dump = join(dir, "corrupt.sql.gz");
    writeCorruptGzip(dump);
    const script = atomicDbRestoreScript(
      dump,
      "sh -c 'cat >/dev/null; exit 0'",
      NAUTILO_SCHEMA_RESET_SQL,
    );
    const code = await shExit(script);
    expect(code).not.toBe(0);
  });

  test("psql/dump failure returns nonzero and rolls back atomically at the DB layer", async () => {
    const dump = join(dir, "nautilo.sql.gz");
    writeValidGzip(dump, "SELECT 1;\nBROKEN SQL;\n");
    const script = atomicDbRestoreScript(
      dump,
      PSQL_FAIL,
      NAUTILO_SCHEMA_RESET_SQL,
    );
    const code = await shExit(script);
    expect(code).not.toBe(0);
  });

  test("validateRestoreDumpScript runs independently before atomic restore begins", async () => {
    const missing = join(dir, "missing.sql.gz");
    expect(await shExit(validateRestoreDumpScript(missing))).not.toBe(0);
    const corrupt = join(dir, "corrupt.sql.gz");
    writeCorruptGzip(corrupt);
    expect(await shExit(validateRestoreDumpScript(corrupt))).not.toBe(0);
    const valid = join(dir, "valid.sql.gz");
    writeValidGzip(valid);
    expect(await shExit(validateRestoreDumpScript(valid))).toBe(0);
    expect(await shExit(atomicDbRestoreScript(valid, PSQL_OK, NAUTILO_SCHEMA_RESET_SQL))).toBe(
      0,
    );
  });
});

// shellQuote is not re-exported for tests; inline the safe-path form so the
// capture target (a tmp dir path) is quoted for the embedded shell fragment.
function shellQuoteLit(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9._:/=@%+-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
