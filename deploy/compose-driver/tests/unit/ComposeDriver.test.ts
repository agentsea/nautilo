import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ComposeDriver,
  createComposeDriver,
  sshRsyncSpec,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
} from "../../src/ComposeDriver.ts";
import {
  backupManifestSchema,
  BUNDLE_INTEGRITY_FILES,
} from "../../src/backup-manifest.ts";
import { dockerHostFor, wrapWithDockerHost } from "../../src/wrap-docker-host.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";
import type { RemoteDeploymentManifest } from "../../src/remote-deployment-manifest.ts";
import { createRemoteFs } from "../../src/remote-fs.ts";
import { buildAppliedAuthContract } from "../../../contracts/applied-auth-contract.ts";
import { buildAuthContract } from "../../../contracts/auth.ts";
import { LOGTO_ENV_KEY_NAMES } from "@nautilo/local/bootstrap-logto";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

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

/**
 * D427 Wave 1 — write a real v2 recovery bundle on disk whose per-file
 * integrity inventory matches its members, with valid gzip dumps and
 * restrictive permissions. `adopt --confirm` verifies this before writing
 * the deployment manifest.
 */
function buildVerifiedBundle(root: string): string {
  mkdirSync(root, { recursive: true });
  const contents = {
    nautiloDb: true,
    logtoDb: true,
    artifacts: true,
    media: false,
    apps: false,
    composeTemplate: false,
    instanceEnv: true,
    operatorFiles: false,
    caddyData: false,
    caddyConfig: false,
    localCaCerts: false,
  };
  writeFileSync(
    join(root, BUNDLE_INTEGRITY_FILES.nautiloDb),
    Bun.gzipSync(new TextEncoder().encode("SELECT 1;\n")),
  );
  writeFileSync(
    join(root, BUNDLE_INTEGRITY_FILES.logtoDb),
    Bun.gzipSync(new TextEncoder().encode("SELECT 1;\n")),
  );
  writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.artifacts), "artifacts-bytes");
  writeFileSync(join(root, BUNDLE_INTEGRITY_FILES.instanceEnv), "SECRET=1\n");
  const integrity: Record<string, { sha256: string; sizeBytes: number }> = {};
  for (const key of Object.keys(BUNDLE_INTEGRITY_FILES) as Array<
    keyof typeof BUNDLE_INTEGRITY_FILES
  >) {
    if (!contents[key]) continue;
    const data = readFileSync(join(root, BUNDLE_INTEGRITY_FILES[key]));
    integrity[key] = {
      sha256: createHash("sha256").update(data).digest("hex"),
      sizeBytes: data.length,
    };
  }
  const manifest = backupManifestSchema.parse({
    version: 2,
    createdAt: "2026-07-16T11:00:00.000Z",
    profileName: "remote-prod",
    instanceId: "prod",
    transport: "remote",
    composeProjectName: "nautilo-prod",
    image: {
      mode: "source",
      imageId: "sha256:legacy-source",
      backupTag: "nautilo-server:legacy-source",
    },
    contents,
    https: "letsencrypt",
    integrity,
  });
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  chmodSync(root, 0o700);
  chmodSync(join(root, "manifest.json"), 0o600);
  chmodSync(join(root, BUNDLE_INTEGRITY_FILES.instanceEnv), 0o600);
  return root;
}

function makeFakeFetch(succeedAfter = 1): {
  fetch: typeof fetch;
  count: () => number;
  urls: () => string[];
} {
  let n = 0;
  const urls: string[] = [];
  const fakeFetch = (async (input: string | URL) => {
    urls.push(String(input));
    n += 1;
    if (n >= succeedAfter) {
      return new Response("ok", { status: 200 });
    }
    return new Response("not yet", { status: 503 });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, count: () => n, urls: () => urls };
}

const baseProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

const CANONICAL_IMAGE_REF = "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1";

const remoteComposeProfile: ComposeDriverProfile = {
  name: "remote-droplet",
  transport: "remote",
  lifecycle: "compose",
  from_source: true,
  image_ref: CANONICAL_IMAGE_REF,
  ssh: { host: "1.2.3.4", user: "root" },
};

const remoteRegistryProfile: ComposeDriverProfile = {
  ...remoteComposeProfile,
  from_source: false,
  image_ref: CANONICAL_IMAGE_REF,
};

function validRemoteManifest(
  overrides: Partial<RemoteDeploymentManifest> = {},
): RemoteDeploymentManifest {
  const manifest = {
    version: 1,
    instanceId: "",
    composeProjectName: "nautilo",
    lifecycle: "compose",
    image: { mode: "registry", reference: CANONICAL_IMAGE_REF },
    remoteRoot: "/opt/nautilo",
    https: "off",
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:30:00.000Z",
    ...overrides,
  };
  return manifest as RemoteDeploymentManifest;
}

function defaultRemotePersistentVolumeGuardResponse(script: string): ExecResult | undefined {
  if (!script.includes('missing=""')) {
    return undefined;
  }
  return { code: 0, stdout: "", stderr: "" };
}

function mockReleaseDockerInspectScriptResponse(
  script: string,
  opts: {
    requested?: string;
    immutableId?: string;
    repoDigest?: string;
  } = {},
): ExecResult | undefined {
  if (!script.includes("exec docker")) {
    return undefined;
  }
  if (script.includes(" ps ") && script.includes("nautilo-server")) {
    return { code: 0, stdout: "server-container\n", stderr: "" };
  }
  if (script.includes(" inspect ") && script.includes("Config.Image")) {
    const immutableId = opts.immutableId ?? `sha256:${"a".repeat(64)}`;
    const requested = opts.requested ?? CANONICAL_IMAGE_REF;
    return { code: 0, stdout: `${immutableId}\n${requested}\n`, stderr: "" };
  }
  if (script.includes("image inspect") && script.includes("repoDigests")) {
    return { code: 0, stdout: JSON.stringify({
      id: opts.immutableId ?? `sha256:${"a".repeat(64)}`,
      repoDigests: [opts.repoDigest, opts.requested ?? CANONICAL_IMAGE_REF].filter(Boolean),
    }), stderr: "" };
  }
  if (script.includes("image inspect")) {
    const repoDigest =
      opts.repoDigest ??
      `ghcr.io/agentsea/nautilo-server@sha256:${"d".repeat(64)}`;
    return { code: 0, stdout: `${repoDigest}\n`, stderr: "" };
  }
  return undefined;
}

function makeRemoteLifecycleExec(
  manifest: RemoteDeploymentManifest,
  responder?: (call: ExecCall) => ExecResult | undefined,
): { exec: ExecFn; calls: ExecCall[] } {
  const manifestJson = JSON.stringify(manifest);
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    const call: ExecCall = { cmd, args, opts };
    calls.push(call);
    const custom = responder?.(call);
    if (custom !== undefined) return custom;
    if (cmd === "cat" && args.some((a) => a.includes("deployment-manifest.json"))) {
      return { code: 0, stdout: `${manifestJson}\n`, stderr: "" };
    }
    if (
      cmd === "cat" &&
      args.some((a) => a.includes("runtime-config/instance.env"))
    ) {
      return {
        code: 0,
        stdout:
          "LOGTO_DB_PASSWORD=remote_logto_pw\n" +
          "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET=remote_webhook_secret\n",
        stderr: "",
      };
    }
    if (cmd === "sh" && args[0] === "-lc") {
      const script = args[1] ?? "";
      if (
        script.includes("find_one logto") &&
        script.includes("logto_core=")
      ) {
        return {
          code: 0,
          stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
          stderr: "",
        };
      }
      const releaseInspect = mockReleaseDockerInspectScriptResponse(script);
      if (releaseInspect !== undefined) return releaseInspect;
      const persistentVolumeGuard = defaultRemotePersistentVolumeGuardResponse(script);
      if (persistentVolumeGuard !== undefined) return persistentVolumeGuard;
      if (script.includes(" ps ") || script.endsWith(" ps --format json")) {
        return {
          code: 0,
          stdout: '[{"Name":"nautilo-nautilo-server","State":"running"}]\n',
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function expectRemoteSshNativeInvocation(call: ExecCall, remoteRoot: string): void {
  expect(call.cmd).toBe("sh");
  expect(call.args[0]).toBe("-lc");
  const script = call.args[1] ?? "";
  expect(script).toContain(`cd -- ${remoteRoot}`);
  expect(script).toContain("exec docker compose");
  expect(script).toContain(`${remoteRoot}/docker-compose.yml`);
  expect(script).toContain(`${remoteRoot}/deploy.compose.env`);
  expect(script).toContain(`${remoteRoot}/deploy.volumes-overlay.yml`);
  expect(script).toContain(`${remoteRoot}/deploy.registry-overlay.yml`);
  expect(script).not.toContain("DOCKER_HOST");
  expect(script).not.toContain(".remote-staging");
  expect(call.opts.env?.["DOCKER_HOST"]).toBeUndefined();
}

function expectRemoteDeployProfiles(
  script: string,
  opts: { office?: boolean } = {},
): void {
  const envIdx = script.indexOf("deploy.compose.env");
  const authIdx = script.indexOf("--profile auth");
  const appIdx = script.indexOf("--profile app");
  expect(authIdx).toBeGreaterThan(envIdx);
  expect(appIdx).toBeGreaterThan(authIdx);
  if (opts.office === true) {
    const officeIdx = script.indexOf("--profile office");
    expect(officeIdx).toBeGreaterThan(appIdx);
  } else {
    expect(script).not.toContain("--profile office");
  }
}

function extractRemoteFileWrites(
  script: string,
): Array<{ path: string; contents: string; mode: string }> {
  const writes: Array<{ path: string; contents: string; mode: string }> = [];
  const re =
    /printf %s ([^ ]+) \| base64 -d > ([^;]+); chmod (\d+) ([^;]+); mv -f -- [^ ]+ ([^;]+)/g;
  for (let match = re.exec(script); match !== null; match = re.exec(script)) {
    const encodedArg = match[1]!;
    const pathArg = match[5]!.trim();
    const mode = match[3]!;
    const encoded =
      encodedArg.startsWith("'") && encodedArg.endsWith("'")
        ? encodedArg.slice(1, -1)
        : encodedArg;
    const path =
      pathArg.startsWith("'") && pathArg.endsWith("'")
        ? pathArg.slice(1, -1)
        : pathArg;
    writes.push({
      path,
      contents: Buffer.from(encoded, "base64").toString("utf8"),
      mode,
    });
  }
  return writes;
}

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

function parseEnvFile(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function makeDeps(over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("compose-driver-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  // Marker file so we can assert the template path is referenced.
  writeFileSync(
    join(templateDir, "docker-compose.yml"),
    "# unit-test template marker\n",
  );
  // Aux files the remote deploy path copies into staging.
  const infraInitPath = join(repoRoot, "infra/postgres-init.sh");
  mkdirSync(join(infraInitPath, ".."), { recursive: true });
  writeFileSync(infraInitPath, "#!/bin/sh\n# unit-test init marker\n");
  const { exec } = makeFakeExec();
  const { fetch: fakeFetch } = makeFakeFetch(1);
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
    ensureForgotPasswordWebhookSecret: async () => "fake_webhook_secret",
    ensureRemotePairingPepper: async () => "a".repeat(64),
    ensurePushTokenEncryptionKey: async () => "b".repeat(64),
    resolveSourceBuildSha: async () => "c".repeat(40),
    getAppDbRepairSql: () => "/* m212-test */ SELECT 1;",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("ComposeDriver", () => {
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
    if (hadInstanceKey) {
      process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    } else {
      delete process.env["NAUTILO_INSTANCE_ID"];
    }
    cleanupTmp();
  });

  test("authPlan reads a local stamp without invoking compose or writing state", async () => {
    const root = mktmp("compose-auth-plan-");
    const contract = buildAuthContract();
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "docker" && call.args[0] === "ps") {
        return { code: 0, stdout: "logto-container\n", stderr: "" };
      }
      if (call.cmd === "docker" && call.args[0] === "inspect") {
        return { code: 0, stdout: `${contract.logtoEngine.image}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    let writes = 0;
    const stamp = buildAppliedAuthContract("2026-07-12T12:00:00.000Z", contract);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => root,
        fs: {
          ...nodeFs,
          readFile: (async () =>
            JSON.stringify(stamp)) as unknown as typeof nodeFs.readFile,
          writeFile: async (...args) => {
            writes += 1;
            return nodeFs.writeFile(...args);
          },
        },
      }),
    );

    const plan = await driver.authPlan(baseProfile, contract);

    expect(plan.classification).toBe("compatible");
    expect(calls.map((call) => call.args[0])).toEqual(["ps", "inspect"]);
    expect(writes).toBe(0);
  });

  test("authPlan fails closed when the running Logto image cannot be inspected", async () => {
    const root = mktmp("compose-auth-plan-missing-image-");
    const contract = buildAuthContract();
    const driver = new ComposeDriver(
      makeDeps({
        resolveInstanceRootDir: () => root,
        fs: {
          ...nodeFs,
          readFile: (async () =>
            JSON.stringify(
              buildAppliedAuthContract("2026-07-12T12:00:00.000Z", contract),
            )) as unknown as typeof nodeFs.readFile,
        },
      }),
    );

    const plan = await driver.authPlan(baseProfile, contract);

    expect(plan.classification).toBe("unknown");
    expect(plan.live.inspected).toBe(false);
  });

  test("authPlan inspects the remote running Logto image without compose mutation", async () => {
    const contract = buildAuthContract();
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: {
        authApplied: buildAppliedAuthContract(
          "2026-07-12T12:00:00.000Z",
          contract,
        ),
      },
    };
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("Config.Image")) {
        return { code: 0, stdout: `${contract.logtoEngine.image}\n`, stderr: "" };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
      }),
    );

    const plan = await driver.authPlan(remoteComposeProfile, contract);

    expect(plan.classification).toBe("compatible");
    expect(calls.map((call) => call.cmd)).toEqual(["cat", "sh"]);
    expect(calls[1]!.args[1]).toContain("docker inspect");
    expect(calls[1]!.args[1]).not.toContain("docker compose");
  });

  test("authReconcile refuses without explicit session-impact confirmation", async () => {
    const driver = new ComposeDriver(makeDeps());

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(baseProfile, { confirmSessionImpact: false }),
    ).rejects.toThrow("--confirm-session-impact");
  });

  test("authReconcile backs up, verifies live state, then advances the local stamp", async () => {
    const root = mktmp("compose-auth-reconcile-");
    const incoming = buildAuthContract();
    const prior = {
      ...incoming,
      hash: "a".repeat(64),
      impact: {
        requiresExplicitAuthReconcile: true,
        mayAffectExistingSessions: false,
      },
    };
    writeFileSync(
      join(root, "auth-contract-applied.json"),
      JSON.stringify(buildAppliedAuthContract("2026-07-12T12:00:00.000Z", prior)),
    );
    const order: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (call.args[0] === "ps") return { code: 0, stdout: "logto-container\n", stderr: "" };
      if (call.args[0] === "inspect") {
        return { code: 0, stdout: `${incoming.logtoEngine.image}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => root,
        resolveLocalInstanceRootDir: () => root,
        runBootstrap: (async () => {
          order.push("bootstrap");
        }) as ComposeDriverDeps["runBootstrap"],
      }),
    );
    driver.backup = async () => {
      order.push("backup");
      return join(root, "backups", "pre-reconcile");
    };

    const result = await driver.authReconcile(baseProfile, {
      confirmSessionImpact: true,
    });

    expect(order).toEqual(["backup", "bootstrap"]);
    expect(result.preflight.classification).toBe("session-disruptive");
    expect(result.postflight.classification).toBe("compatible");
    const stamped = JSON.parse(
      readFileSync(join(root, "auth-contract-applied.json"), "utf8"),
    ) as { contractHash: string };
    expect(stamped.contractHash).toBe(incoming.hash);
  });

  test("authReconcile leaves the existing stamp when postflight inspection fails", async () => {
    const root = mktmp("compose-auth-reconcile-postflight-");
    const incoming = buildAuthContract();
    const prior = buildAppliedAuthContract("2026-07-12T12:00:00.000Z", {
      ...incoming,
      hash: "b".repeat(64),
    });
    writeFileSync(join(root, "auth-contract-applied.json"), JSON.stringify(prior));
    let inspectCalls = 0;
    const { exec } = makeFakeExec((call) => {
      if (call.args[0] === "ps") return { code: 0, stdout: "logto-container\n", stderr: "" };
      if (call.args[0] === "inspect") {
        inspectCalls += 1;
        return inspectCalls === 1
          ? { code: 0, stdout: `${incoming.logtoEngine.image}\n`, stderr: "" }
          : { code: 1, stdout: "", stderr: "inspection failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => root,
        resolveLocalInstanceRootDir: () => root,
      }),
    );
    driver.backup = async () => join(root, "backups", "pre-reconcile");

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(baseProfile, { confirmSessionImpact: true }),
    ).rejects.toThrow("postflight verification");

    const stamped = JSON.parse(
      readFileSync(join(root, "auth-contract-applied.json"), "utf8"),
    ) as { contractHash: string };
    expect(stamped.contractHash).toBe(prior.contractHash);
  });

  test("authReconcile backs up and stamps a known legacy-adopted remote manifest", async () => {
    const incoming = buildAuthContract();
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      image: { mode: "source", reference: "nautilo-server:legacy-source" },
      contracts: { legacyAdopted: true },
    };
    const order: string[] = [];
    const logs: string[] = [];
    let tunnelForwards:
      | Array<{ local: number; remoteHost: string; remote: number }>
      | undefined;
    let canonicalEnvReads = 0;
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (
        call.cmd === "cat" &&
        call.args.some((arg) =>
          arg.includes("runtime-config/instance.env"),
        )
      ) {
        canonicalEnvReads += 1;
        return {
          code: 0,
          stdout:
            "LOGTO_DB_PASSWORD=remote_logto_pw\n" +
            "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET=remote_webhook_secret\n" +
            `PROVIDER_KEY=${canonicalEnvReads === 1 ? "before" : "concurrent-change"}\n`,
          stderr: "",
        };
      }
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("Config.Image")) {
        return { code: 0, stdout: `${incoming.logtoEngine.image}\n`, stderr: "" };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
        resolveLocalInstanceRootDir: () => "/tmp/nautilo",
        log: (message) => logs.push(message),
        ensureDbPasswords: async () => {
          throw new Error("operator-local passwords must not be used");
        },
        openSshTunnel: async (_ssh, forwards) => {
          tunnelForwards = forwards;
          return { close: async () => {} };
        },
        runBootstrap: (async (options) => {
          order.push("bootstrap");
          expect(options?.postgresUrl).toContain("remote_logto_pw");
          expect(options?.postgresUrl).toContain("@localhost:8432/");
          expect(options?.adminEndpoint).toBe("http://127.0.0.1:6302");
          expect(options?.defaultTenantEndpoint).toBe(
            "http://127.0.0.1:6301",
          );
          expect(options?.envPath).toBe(process.env["NAUTILO_DOTENV_PATH"]);
          const managedLogtoEnv = LOGTO_ENV_KEY_NAMES.map(
            (key) =>
              `${key}=${key === "LOGTO_WORKBENCH_APP_ID" ? "remote-app" : `reconciled-${key.toLowerCase()}`}`,
          ).join("\n");
          writeFileSync(
            options!.envPath!,
            `${readFileSync(options!.envPath!, "utf8")}${managedLogtoEnv}\n`,
          );
        }) as ComposeDriverDeps["runBootstrap"],
      }),
    );
    driver.backup = async () => {
      order.push("backup");
      return "/tmp/nautilo/backups/pre-reconcile";
    };

    const result = await driver.authReconcile(remoteComposeProfile, {
      confirmSessionImpact: true,
    });

    expect(order).toEqual(["backup", "bootstrap"]);
    expect(tunnelForwards?.map((forward) => forward.remote)).toEqual([
      6301, 6302, 8432,
    ]);
    expect(tunnelForwards?.map((forward) => forward.local)).toEqual([
      6301, 6302, 8432,
    ]);
    expect(
      tunnelForwards?.every(
        (forward) => forward.remoteHost === "127.0.0.1",
      ),
    ).toBe(true);
    expect(result.preflight.classification).toBe("compatible");
    expect(result.postflight.classification).toBe("compatible");
    const writes = calls.flatMap((call) => extractRemoteFileWrites(call.args[1] ?? ""));
    const stamped = JSON.parse(
      writes.find((write) => write.path === "/opt/nautilo/deployment-manifest.json")!
        .contents,
    ) as RemoteDeploymentManifest;
    expect(stamped.version).toBe(2);
    if (stamped.version !== 2) throw new Error("expected a v2 manifest");
    expect(stamped.contracts).toMatchObject({
      legacyAdopted: true,
      authApplied: { contractHash: incoming.hash },
    });
    const canonicalEnvWrite = writes.find(
      (write) =>
        write.path === "/opt/nautilo/runtime-config/instance.env",
    );
    expect(canonicalEnvWrite?.contents).toContain(
      "LOGTO_DB_PASSWORD=remote_logto_pw",
    );
    expect(canonicalEnvWrite?.contents).toContain(
      "LOGTO_WORKBENCH_APP_ID=remote-app",
    );
    expect(canonicalEnvWrite?.contents).toContain(
      "PROVIDER_KEY=concurrent-change",
    );
    expect(canonicalEnvWrite?.contents).not.toContain("PROVIDER_KEY=before");
    expect(logs.join("\n")).not.toContain("remote_logto_pw");
    expect(logs.join("\n")).not.toContain("remote_webhook_secret");
  });

  test("authReconcile refuses undiscoverable remote ports before backup or auth mutation", async () => {
    const incoming = buildAuthContract();
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: { legacyAdopted: true },
    };
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("find_one logto")) {
        return {
          code: 41,
          stdout: "",
          stderr: "service logto has 0 running containers",
        };
      }
      if (call.cmd === "sh" && script.includes("Config.Image")) {
        return {
          code: 0,
          stdout: `${incoming.logtoEngine.image}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
      }),
    );
    let backups = 0;
    driver.backup = async () => {
      backups += 1;
      return "/tmp/unused";
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, {
        confirmSessionImpact: true,
      }),
    ).rejects.toThrow(
      /unable to discover.*service logto has 0 running containers.*No backup or auth changes/,
    );

    expect(backups).toBe(0);
    expect(
      calls.flatMap((call) =>
        extractRemoteFileWrites(call.args[1] ?? ""),
      ),
    ).toEqual([]);
  });

  test("authReconcile refuses a missing canonical remote Logto password before backup", async () => {
    const incoming = buildAuthContract();
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: { legacyAdopted: true },
    };
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      if (
        call.cmd === "cat" &&
        call.args.some((arg) =>
          arg.includes("runtime-config/instance.env"),
        )
      ) {
        return {
          code: 0,
          stdout: "LOGTO_ENDPOINT=https://auth.example.test\n",
          stderr: "",
        };
      }
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("Config.Image")) {
        return {
          code: 0,
          stdout: `${incoming.logtoEngine.image}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
      }),
    );
    let backups = 0;
    driver.backup = async () => {
      backups += 1;
      return "/tmp/unused";
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, {
        confirmSessionImpact: true,
      }),
    ).rejects.toThrow(
      /canonical remote instance\.env has no LOGTO_DB_PASSWORD.*No backup or auth changes/,
    );

    expect(backups).toBe(0);
  });

  test("authReconcile refuses a missing canonical remote relay secret before backup", async () => {
    const incoming = buildAuthContract();
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: { legacyAdopted: true },
    };
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      if (
        call.cmd === "cat" &&
        call.args.some((arg) =>
          arg.includes("runtime-config/instance.env"),
        )
      ) {
        return {
          code: 0,
          stdout: "LOGTO_DB_PASSWORD=remote_logto_pw\n",
          stderr: "",
        };
      }
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("Config.Image")) {
        return {
          code: 0,
          stdout: `${incoming.logtoEngine.image}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
      }),
    );
    let backups = 0;
    driver.backup = async () => {
      backups += 1;
      return "/tmp/unused";
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, {
        confirmSessionImpact: true,
      }),
    ).rejects.toThrow(
      /no NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET.*No backup or auth changes/,
    );

    expect(backups).toBe(0);
  });

  test("authReconcile reports a bounded remote bootstrap failure without advancing the stamp", async () => {
    const incoming = buildAuthContract();
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: { legacyAdopted: true },
    };
    const localRoot = mktmp("compose-auth-remote-failure-");
    let tunnelClosed = false;
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("Config.Image")) {
        return {
          code: 0,
          stdout: `${incoming.logtoEngine.image}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
        resolveLocalInstanceRootDir: () => localRoot,
        openSshTunnel: async () => ({
          close: async () => {
            tunnelClosed = true;
          },
        }),
        runBootstrap: (async () => {
          throw new Error(
            "Logto PostgreSQL bootstrap probe failed before any auth mutation: password authentication failed for user \"logto\"",
          );
        }) as ComposeDriverDeps["runBootstrap"],
      }),
    );
    const backupPath = join(localRoot, "backups", "pre-reconcile");
    driver.backup = async () => backupPath;

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, {
        confirmSessionImpact: true,
      }),
    ).rejects.toThrow(
      /bounded Logto bootstrap.*no applied-auth stamp.*Recovery bundle: .*password authentication failed/,
    );

    expect(tunnelClosed).toBe(true);
    const writes = calls.flatMap((call) =>
      extractRemoteFileWrites(call.args[1] ?? ""),
    );
    expect(
      writes.some(
        (write) => write.path === "/opt/nautilo/deployment-manifest.json",
      ),
    ).toBe(false);
  });

  test("authReconcile keeps its temporary env operator-local with production RemoteFs wiring", async () => {
    const incoming = buildAuthContract();
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: { legacyAdopted: true },
    };
    const operatorRoot = mktmp("compose-auth-operator-local-");
    const stagingRoot = mktmp("compose-auth-remote-staging-");
    const remoteFsCalls: ExecCall[] = [];
    const remoteFs = createRemoteFs(remoteComposeProfile, {
      stagingRoot,
      remoteInstanceRoot: "/opt/nautilo",
      exec: async (cmd, args, opts) => {
        remoteFsCalls.push({ cmd, args, opts });
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("Config.Image")) {
        return {
          code: 0,
          stdout: `${incoming.logtoEngine.image}\n`,
          stderr: "",
        };
      }
      return undefined;
    });
    let observedTempPath: string | undefined;
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fs: remoteFs,
        localFs: nodeFs,
        resolveInstanceRootDir: () => "/opt/nautilo",
        resolveLocalInstanceRootDir: () => operatorRoot,
        openSshTunnel: async () => ({ close: async () => {} }),
        runBootstrap: (async (options) => {
          observedTempPath = options?.envPath;
          expect(observedTempPath?.startsWith(operatorRoot)).toBe(true);
          expect(existsSync(observedTempPath!)).toBe(true);
          throw new Error("stop after proving local temp authority");
        }) as ComposeDriverDeps["runBootstrap"],
      }),
    );
    driver.backup = async () => join(operatorRoot, "backups", "pre-reconcile");

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, {
        confirmSessionImpact: true,
      }),
    ).rejects.toThrow(/stop after proving local temp authority/);

    expect(observedTempPath).toBeDefined();
    expect(existsSync(observedTempPath!)).toBe(false);
    expect(
      existsSync(
        join(
          stagingRoot,
          "__abs__",
          observedTempPath!.replace(/^\//, ""),
        ),
      ),
    ).toBe(false);
    expect(remoteFsCalls).toEqual([]);
  });

  test("authReconcile refuses an unmarked remote manifest without an auth stamp", async () => {
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: {},
    };
    const { exec } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => "/opt/nautilo" }),
    );
    let backups = 0;
    driver.backup = async () => {
      backups += 1;
      return "/tmp/unused";
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, { confirmSessionImpact: true }),
    ).rejects.toThrow("auth plan is unknown");

    expect(backups).toBe(0);
  });

  test("authReconcile refuses a legacy-adopted manifest with an incompatible engine", async () => {
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      contracts: { legacyAdopted: true },
    };
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("docker inspect")) {
        return { code: 0, stdout: "ghcr.io/logto-io/logto:1.37.0\n", stderr: "" };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => "/opt/nautilo" }),
    );
    let backups = 0;
    driver.backup = async () => {
      backups += 1;
      return "/tmp/unused";
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, { confirmSessionImpact: true }),
    ).rejects.toThrow("auth plan is incompatible");

    expect(backups).toBe(0);
  });

  test("authReconcile refuses an unreadable remote manifest before backup", async () => {
    const { exec } = makeFakeExec(() => ({ code: 1, stdout: "", stderr: "permission denied" }));
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => "/opt/nautilo" }),
    );
    let backups = 0;
    driver.backup = async () => {
      backups += 1;
      return "/tmp/unused";
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, { confirmSessionImpact: true }),
    ).rejects.toThrow("Remote deployment manifest unavailable");

    expect(backups).toBe(0);
  });

  test("missing remote manifest presents safe fresh-versus-adopt recovery paths", async () => {
    const { exec } = makeFakeExec(() => ({
      code: 1,
      stdout: "",
      stderr: "not found",
    }));
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => "/opt/nautilo-beta" }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, {
        confirmSessionImpact: true,
      }),
    ).rejects.toThrow(
      /existing legacy install.*adopt --dry-run --profile remote.*confirmed fresh and empty.*deploy --profile remote/s,
    );
  });

  test("invalid remote manifest refuses deploy and adopt recovery advice", async () => {
    const { exec } = makeFakeExec(() => ({
      code: 0,
      stdout: "not-json",
      stderr: "",
    }));
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => "/opt/nautilo-beta" }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.authReconcile(remoteComposeProfile, {
        confirmSessionImpact: true,
      }),
    ).rejects.toThrow(
      /Do not deploy or adopt over this invalid manifest.*verified backup/s,
    );
  });

  test("sshRsyncSpec enables strict host-key verification when pinned", () => {
    expect(
      sshRsyncSpec({
        ...remoteComposeProfile,
        ssh: {
          host: "1.2.3.4",
          user: "root",
          known_hosts_file: "/tmp/known_hosts",
        },
      }),
    ).toBe(
      "ssh -p 22 -o BatchMode=yes -o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=yes",
    );
  });

  // -------------------------------------------------------------------------
  // gates
  // -------------------------------------------------------------------------
  test("deploy: gates fail loudly with documented messages", async () => {
    const driver = new ComposeDriver(makeDeps());
    /* eslint-disable @typescript-eslint/await-thenable -- bun `expect().rejects` */
    await expect(
      driver.deploy({
        ...baseProfile,
        transport: "remote",
        lifecycle: "external",
      }),
    ).rejects.toThrow(/M092 ComposeDriver only operates on lifecycle=compose/);
    await expect(
      driver.deploy({ ...baseProfile, lifecycle: "external" }),
    ).rejects.toThrow(/M092 ComposeDriver only operates on lifecycle=compose/);
    /* eslint-enable @typescript-eslint/await-thenable */
  });

  // -------------------------------------------------------------------------
  // deploy happy path
  // -------------------------------------------------------------------------
  test("deploy: happy path orchestrates compose, bootstrap, overlay, server up, health", async () => {
    const { exec, calls } = makeFakeExec();
    const { fetch: fakeFetch, count: fetchCount, urls } = makeFakeFetch(1);

    let bootstrapCalls = 0;
    let bootstrapEnvIdSeen: string | undefined;
    let bootstrapOptions: Parameters<RunBootstrapFn>[0];
    const fakeRunBootstrap: RunBootstrapFn = async (opts) => {
      bootstrapCalls += 1;
      bootstrapOptions = opts;
      bootstrapEnvIdSeen = process.env["NAUTILO_INSTANCE_ID"];
    };

    const fakeInstanceLogtoEnv = {
      LOGTO_ENDPOINT: "http://localhost:3301",
      LOGTO_ISSUER: "http://localhost:3301/oidc",
      LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
      LOGTO_RESOURCE: "https://api.nautilo.local",
      LOGTO_M2M_APP_ID: "m2m-id",
      LOGTO_M2M_APP_SECRET: "m2m-secret",
      LOGTO_WORKBENCH_APP_ID: "wb",
    };

    let firstDeployCalls = 0;

    const deps = makeDeps({
      exec,
      fetch: fakeFetch,
      runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
      readInstanceLogtoEnv: async () => fakeInstanceLogtoEnv,
      firstDeployConsume: async () => {
        firstDeployCalls += 1;
      },
    });

    const driver = new ComposeDriver(deps);
    await driver.deploy(baseProfile);

    // Logto health was polled.
    expect(fetchCount()).toBeGreaterThanOrEqual(1);

    // Bootstrap ran exactly once, with the suffixed env in scope.
    expect(bootstrapCalls).toBe(1);
    expect(bootstrapEnvIdSeen).toBe("");
    expect(bootstrapOptions?.forgotPasswordRelay).toEqual({
      webhookEndpoint: "http://nautilo-server:3001/api/internal/logto/email-webhook",
      webhookSecret: "fake_webhook_secret",
    });

    // First-deploy hook ran.
    expect(firstDeployCalls).toBe(1);

    // env mutations restored.
    expect(process.env["HOME"]).toBe(home);
    expect("NAUTILO_INSTANCE_ID" in process.env).toBe(hadInstanceKey);

    // Compose was invoked: app-postgres + logto-postgres preflight ups + full-stack up.
    const composeUpCalls = calls.filter(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("up") &&
        c.args.includes("--build"),
    );
    expect(composeUpCalls.length).toBe(3);
    const postgresUp = composeUpCalls.find((c) => c.args.includes("app-postgres"));
    const logtoPostgresUp = composeUpCalls.find((c) => c.args.includes("logto-postgres"));
    const fullUp = composeUpCalls.find(
      (c) => !c.args.includes("app-postgres") && !c.args.includes("logto-postgres"),
    );
    expect(postgresUp).toBeDefined();
    expect(postgresUp!.args).toContain("--wait");
    expect(logtoPostgresUp).toBeDefined();
    expect(logtoPostgresUp!.args).toContain("--wait");
    expect(fullUp).toBeDefined();
    expect(fullUp!.args).not.toContain("--wait");
    expect(fullUp!.args).toContain("--scale");
    expect(fullUp!.args).toContain("nautilo-server=0");
    const composeUp = fullUp!;
    expect(composeUp.args).toContain("--project-name");
    expect(composeUp.args).toContain("nautilo");
    expect(composeUp.args).toContain("--profile");
    expect(composeUp.args).toContain("auth");
    expect(composeUp.args).toContain("app");

    // Two server `up -d --no-deps` calls: first after bootstrap
    // (LOGTO_* env), second after firstDeployConsume (providers /
    // anything else config-guard wrote during the hook).
    const serverUpCalls = calls.filter(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("up") &&
        c.args.includes("--no-deps") &&
        c.args.includes("nautilo-server"),
    );
    expect(serverUpCalls.length).toBe(2);
    for (const up of serverUpCalls) {
      expect(up.args).toContain("-f"); // overlay -f present
      // M117 regression: re-up must enable both auth+app profiles so
      // the Caddy overlay's `depends_on: logto` validates even though
      // --no-deps narrows the actual up to nautilo-server.
      const profileIndices = up.args
        .map((a, i) => (a === "--profile" ? i : -1))
        .filter((i) => i >= 0);
      const profileValues = profileIndices.map((i) => up.args[i + 1]);
      expect(profileValues).toContain("auth");
      expect(profileValues).toContain("app");
    }

    // Server /health is polled via injected fetch (plain HTTP — the
    // deploy stack sets NAUTILO_DISABLE_TLS=1, no curl shell-out
    // needed). Logto poll + first server poll = 2 fetches minimum when
    // retired topology is absent (no post-deploy full runtime acceptance).
    expect(fetchCount()).toBeGreaterThanOrEqual(2);
    expect(urls().some((u) => u.includes("/health"))).toBe(true);

    // env files were written under the per-instance root.
    const instanceRootDir = join(home, ".nautilo");
    expect(existsSync(join(instanceRootDir, "deploy.compose.env"))).toBe(true);
    expect(existsSync(join(instanceRootDir, "deploy.server.env"))).toBe(true);
    // The auth-plan reader owns this root-level lifecycle stamp. The
    // canonical dotenv moved under runtime-config/, but that must not move
    // the applied-contract record out of authPlan's authority path.
    expect(existsSync(join(instanceRootDir, "auth-contract-applied.json"))).toBe(true);
    expect(
      existsSync(
        join(instanceRootDir, "runtime-config", "auth-contract-applied.json"),
      ),
    ).toBe(false);
    expect(
      existsSync(join(instanceRootDir, "deploy.server-overlay.yml")),
    ).toBe(true);

    const composeEnv = readFileSync(
      join(instanceRootDir, "deploy.compose.env"),
      "utf8",
    );
    expect(composeEnv).toContain("COMPOSE_PROJECT_NAME=nautilo");
    expect(composeEnv).toContain("NAUTILO_HOSTING_MODE=local");
    expect(composeEnv).toContain("NAUTILO_PASSWORD_RECOVERY_DRIVER=oss_relay");
    expect(composeEnv).toContain("LOGTO_DB_PASSWORD=fake_logto_pw");
    expect(composeEnv).toContain("APP_DB_PASSWORD=fake_app_pw");

    const serverEnv = readFileSync(
      join(instanceRootDir, "deploy.server.env"),
      "utf8",
    );
    // The container-DNS rewrite landed in the overlay file.
    expect(serverEnv).toContain("LOGTO_JWKS_URI=http://logto:3301/oidc/jwks");
    expect(serverEnv).toContain("LOGTO_ISSUER=http://localhost:3301/oidc");
    expect(serverEnv).toContain("LOGTO_M2M_APP_SECRET=m2m-secret");
    expect(serverEnv).toContain("NAUTILO_PASSWORD_RECOVERY_DRIVER=oss_relay");
    expect(serverEnv).toContain(
      "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET=fake_webhook_secret",
    );
    expect(serverEnv).toContain(
      `NAUTILO_REMOTE_PAIRING_PEPPER=${"a".repeat(64)}`,
    );
    expect(serverEnv).toContain(
      `NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY=${"b".repeat(64)}`,
    );

    // Overlay YAML mounts BOTH instance.env (full key set incl.
    // providers) and deploy.server.env (container-DNS overrides).
    const overlayYml = readFileSync(
      join(instanceRootDir, "deploy.server-overlay.yml"),
      "utf8",
    );
    const canonicalEnv = join(
      instanceRootDir,
      "runtime-config",
      "instance.env",
    );
    expect(overlayYml).toContain(canonicalEnv);
    expect(overlayYml).toContain(
      `${join(instanceRootDir, "runtime-config")}:/var/lib/nautilo/config`,
    );
    expect(overlayYml).not.toContain(
      `${instanceRootDir}:/var/lib/nautilo/config`,
    );
    expect(overlayYml).toContain(
      "NAUTILO_DOTENV_PATH: /var/lib/nautilo/config/instance.env",
    );
    expect(overlayYml).toContain(join(instanceRootDir, "deploy.server.env"));
    // Order matters — instance.env first so deploy.server.env wins.
    const instanceIdx = overlayYml.indexOf(canonicalEnv);
    const serverIdx = overlayYml.indexOf(join(instanceRootDir, "deploy.server.env"));
    expect(instanceIdx).toBeLessThan(serverIdx);
  });

  test("deploy: registry mode pulls the published image and never builds", async () => {
    const { exec, calls } = makeFakeExec();
    const { fetch: fakeFetch } = makeFakeFetch(1);

    const fakeInstanceLogtoEnv = {
      LOGTO_ENDPOINT: "http://localhost:3301",
      LOGTO_ISSUER: "http://localhost:3301/oidc",
      LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
      LOGTO_RESOURCE: "https://api.nautilo.local",
      LOGTO_M2M_APP_ID: "m2m-id",
      LOGTO_M2M_APP_SECRET: "m2m-secret",
      LOGTO_WORKBENCH_APP_ID: "wb",
    };

    let sourceIdentityCalls = 0;
    const deps = makeDeps({
      exec,
      fetch: fakeFetch,
      resolveSourceBuildSha: async () => {
        sourceIdentityCalls += 1;
        throw new Error("registry deploy must not resolve source identity");
      },
      readInstanceLogtoEnv: async () => fakeInstanceLogtoEnv,
    });
    const driver = new ComposeDriver(deps);

    await driver.deploy({ ...baseProfile, from_source: false, image_ref: CANONICAL_IMAGE_REF });

    const instanceRootDir = join(home, ".nautilo");
    const registryOverlayPath = join(instanceRootDir, "deploy.registry-overlay.yml");
    expect(existsSync(registryOverlayPath)).toBe(true);
    const registryOverlay = readFileSync(registryOverlayPath, "utf8");
    expect(registryOverlay).toContain(
      `image: ${CANONICAL_IMAGE_REF}`,
    );
    expect(registryOverlay).toContain("build: !reset null");

    const pullCall = calls.find(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("pull") &&
        c.args.includes("nautilo-server"),
    );
    expect(pullCall).toBeDefined();
    expect(pullCall!.args).toContain("-f");
    expect(pullCall!.args).toContain(registryOverlayPath);

    // D248 — the registry pull must enable the `auth` profile (alongside
    // `app`) so the caddy overlay's `depends_on: logto` validates. Without
    // `auth`, compose rejects the project with "service 'caddy' depends on
    // undefined service 'logto'" before the named pull runs.
    const pullProfileIdxs = pullCall!.args
      .map((a, i) => (a === "--profile" ? i : -1))
      .filter((i) => i >= 0);
    const pullProfiles = pullProfileIdxs.map((i) => pullCall!.args[i + 1]);
    expect(pullProfiles).toContain("auth");
    expect(pullProfiles).toContain("app");

    const buildCalls = calls.filter(
      (c) => c.cmd === "docker" && c.args.includes("--build"),
    );
    expect(buildCalls).toHaveLength(0);
    expect(sourceIdentityCalls).toBe(0);

    const serverUpCalls = calls.filter(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("up") &&
        c.args.includes("--no-deps") &&
        c.args.includes("nautilo-server"),
    );
    expect(serverUpCalls).toHaveLength(1);
    expect(serverUpCalls[0]!.args).toContain("--no-build");
    expect(serverUpCalls[0]!.args).toContain(registryOverlayPath);
  });

  test("deploy: source identity is persisted before local builds", async () => {
    const sha = "d".repeat(40);
    const driver = new ComposeDriver(makeDeps({ resolveSourceBuildSha: async () => sha }));

    await driver.deploy(baseProfile);

    const composeEnv = readFileSync(join(home, ".nautilo", "deploy.compose.env"), "utf8");
    expect(composeEnv).toContain(`NAUTILO_SOURCE_SHA=${sha}`);
  });

  test("deploy: source identity failure precedes instance-root and Docker mutation", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRootDir = join(home, ".nautilo-source-refused");
    const driver = new ComposeDriver(makeDeps({
      exec,
      resolveInstanceRootDir: () => instanceRootDir,
      resolveLocalInstanceRootDir: () => instanceRootDir,
      resolveSourceBuildSha: async () => {
        throw new Error("source deploy refused before mutation: dirty checkout");
      },
    }));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.deploy(baseProfile)).rejects.toThrow("dirty checkout");
    expect(existsSync(instanceRootDir)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("deploy: ensureBootstrapToken (when wired) is invoked before the first nautilo-server up", async () => {
    // Regression guard for the M118 drive-by: local-profile deploys need
    // NAUTILO_BOOTSTRAP_TOKEN to land in the server container's env
    // BEFORE the first `compose up -d nautilo-server`, because the
    // privileged owner-claim controller requests arrive from the Docker
    // bridge gateway (not loopback) inside the container and fail closed
    // without a configured token.
    const callOrder: string[] = [];
    const { exec } = makeFakeExec((call) => {
      if (
        call.cmd === "docker" &&
        call.args.includes("up") &&
        call.args.includes("nautilo-server")
      ) {
        callOrder.push("server-up");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const { fetch: fakeFetch } = makeFakeFetch(1);
    const ensureBootstrapTokenCalls: Array<{
      profileName: string;
      home: string;
    }> = [];
    const deps = makeDeps({
      exec,
      fetch: fakeFetch,
      readInstanceLogtoEnv: async () => ({
        LOGTO_ENDPOINT: "http://localhost:3301",
        LOGTO_ISSUER: "http://localhost:3301/oidc",
        LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
        LOGTO_RESOURCE: "https://api.nautilo.local",
        LOGTO_M2M_APP_ID: "m2m-id",
        LOGTO_M2M_APP_SECRET: "m2m-secret",
        LOGTO_WORKBENCH_APP_ID: "wb",
      }),
      ensureBootstrapToken: (profile, home) => {
        callOrder.push("ensureBootstrapToken");
        ensureBootstrapTokenCalls.push({ profileName: profile.name, home });
        return "fake-token-value";
      },
    });
    const driver = new ComposeDriver(deps);
    await driver.deploy(baseProfile);

    expect(ensureBootstrapTokenCalls.length).toBe(1);
    expect(ensureBootstrapTokenCalls[0]?.profileName).toBe(baseProfile.name);
    // The first event in `callOrder` MUST be ensureBootstrapToken, and
    // every `server-up` (initial + post-hook re-up) must follow it.
    expect(callOrder[0]).toBe("ensureBootstrapToken");
    const firstServerUpIdx = callOrder.indexOf("server-up");
    expect(firstServerUpIdx).toBeGreaterThan(0);
    expect(callOrder.slice(0, firstServerUpIdx)).toContain("ensureBootstrapToken");
  });

  test("deploy: adopts bootstrap authority into the explicitly resolved operator root", async () => {
    const operatorRoot = mktmp("compose-explicit-operator-root-");
    const legacyEnv = join(operatorRoot, "instance.env");
    const canonicalEnv = join(operatorRoot, "runtime-config", "instance.env");
    const token = "explicit-operator-bootstrap-token";
    const driver = new ComposeDriver(makeDeps({
      resolveInstanceRootDir: () => operatorRoot,
      resolveLocalInstanceRootDir: () => operatorRoot,
      readInstanceLogtoEnv: async () => ({
        LOGTO_ENDPOINT: "http://localhost:3301",
        LOGTO_ISSUER: "http://localhost:3301/oidc",
        LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
        LOGTO_RESOURCE: "https://api.nautilo.local",
        LOGTO_M2M_APP_ID: "m2m-id",
        LOGTO_M2M_APP_SECRET: "m2m-secret",
        LOGTO_WORKBENCH_APP_ID: "wb",
      }),
      ensureBootstrapToken: () => {
        // Match the control-plane authority writer: its atomic rename replaces
        // the compatibility symlink with a completed regular file.
        rmSync(legacyEnv, { force: true });
        writeFileSync(legacyEnv, `NAUTILO_BOOTSTRAP_TOKEN=${token}\n`, { mode: 0o600 });
        return token;
      },
    }));

    await driver.deploy(baseProfile);

    expect(readFileSync(canonicalEnv, "utf8")).toContain(`NAUTILO_BOOTSTRAP_TOKEN=${token}`);
    expect(readFileSync(legacyEnv, "utf8")).toBe(readFileSync(canonicalEnv, "utf8"));
    expect(existsSync(join(home, ".nautilo", "runtime-config", "instance.env"))).toBe(false);
  });

  test("deploy: ensureBootstrapToken is omitted-friendly (no-op when undefined)", async () => {
    // Unit-test path doesn't wire the helper; deploy must still complete
    // (the helper is optional — production wires it via the factory).
    const deps = makeDeps({
      readInstanceLogtoEnv: async () => ({
        LOGTO_ENDPOINT: "http://localhost:3301",
        LOGTO_ISSUER: "http://localhost:3301/oidc",
        LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
        LOGTO_RESOURCE: "https://api.nautilo.local",
        LOGTO_M2M_APP_ID: "m2m-id",
        LOGTO_M2M_APP_SECRET: "m2m-secret",
        LOGTO_WORKBENCH_APP_ID: "wb",
      }),
    });
    const driver = new ComposeDriver(deps);
    const result = await driver.deploy(baseProfile);
    expect(result).toBeUndefined();
  });

  test("status: probes health and setup via fetch (no curl)", async () => {
    const statusRoot = mktmp("compose-status-");
    writeFileSync(join(statusRoot, "deploy.compose.env"), "TEST=1\n");
    const { exec, calls } = makeFakeExec((call) => ({
      code: 0,
      stdout: call.args.includes("-aq")
        ? "container-id\n"
        : call.args.includes("ps")
          ? '[{"Name":"nautilo-server"}]'
          : "",
      stderr: "",
    }));
    const { fetch: fakeFetch, count: fetchCount } = makeFakeFetch(1);
    const driver = new ComposeDriver(makeDeps({
      exec,
      fetch: fakeFetch,
      resolveInstanceRootDir: () => statusRoot,
    }));
    const observation = await driver.status(baseProfile);
    expect(calls.filter((c) => c.cmd === "curl").length).toBe(0);
    expect(fetchCount()).toBe(2);
    expect(observation.health).toBe("ready");
  });

  test("status: pretty-prints setupState summary when setup body is JSON", async () => {
    const statusRoot = mktmp("compose-status-");
    writeFileSync(join(statusRoot, "deploy.compose.env"), "TEST=1\n");
    const { exec, calls } = makeFakeExec((call) => ({
      code: 0,
      stdout: call.args.includes("-aq")
        ? "container-id\n"
        : call.args.includes("ps")
          ? '[{"Name":"nautilo-server"}]'
          : "",
      stderr: "",
    }));
    const fetchMock = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/setup/status")) {
        return new Response(
          JSON.stringify({ setupState: "ready", claimRequired: false }),
          { status: 200 },
        );
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const logLines: string[] = [];
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: fetchMock,
        log: (msg) => logLines.push(msg),
        resolveInstanceRootDir: () => statusRoot,
      }),
    );
    const observation = await driver.status(baseProfile);
    expect(observation).toMatchObject({
      health: "ready",
      setupState: "ready",
      claimRequired: false,
    });
    expect(calls.filter((c) => c.cmd === "curl").length).toBe(0);
    expect(logLines.some((l) => l.includes("setupState=ready"))).toBe(true);
    expect(logLines.some((l) => l.includes("claim done"))).toBe(true);
  });

  test("status: proves an absent Compose project without probing HTTP", async () => {
    const { exec } = makeFakeExec();
    const { fetch: fakeFetch, count: fetchCount } = makeFakeFetch();
    const driver = new ComposeDriver(makeDeps({ exec, fetch: fakeFetch }));

    const observation = await driver.status(baseProfile);

    expect(observation).toMatchObject({
      compose: "absent",
      health: "unavailable",
    });
    expect(fetchCount()).toBe(0);
  });

  test("upgrade: remote source uses legacy M139 flow with DOCKER_HOST, no manifest", async () => {
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
      const script = call.args[1] ?? "";
      if (
        call.cmd === "sh" &&
        (script.includes("docker ps -aq") || script.includes("docker ps -q"))
      ) {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (call.cmd === "sh" && script.includes("docker inspect")) {
        return {
          code: 0,
          stdout: "sha256:remote-source\nnautilo-server:local-dev\n",
          stderr: "",
        };
      }
      if (call.cmd === "cat") {
        order.push("manifest");
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const exec = wrapWithDockerHost(
      innerExec,
      dockerHostFor(remoteComposeProfile),
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

    await driver.upgrade(remoteComposeProfile);

    // D420 — stop-before-snapshot: upgrade stops nautilo-server for backup, then
    // deploy brings it back; no intermediate docker start before deploy.
    // M215 adds a direct-transport baseline inspect before mutation (extra remote sh).
    expect(order).toEqual(["doctor", "stop", "backup", "deploy", "health"]);
    expect(calls.some((c) => c.cmd === "cat")).toBe(false);
    const remoteCapture = calls.filter(
      (c) =>
        c.cmd === "sh" &&
        ((c.args[1] ?? "").includes("docker ps -aq") ||
          (c.args[1] ?? "").includes("docker inspect")),
    );
    expect(remoteCapture).toHaveLength(3);
    expect(remoteCapture.every((c) => c.opts.env?.["DOCKER_HOST"] === undefined)).toBe(true);
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

  test("deploy: remote registry day-two uses SSH-native pull/up without bootstrap or staging", async () => {
    const remoteRoot = "/opt/nautilo";
    const profile = { ...remoteComposeProfile, from_source: false, tag: "main" };
    const manifest = validRemoteManifest({ remoteRoot });
    const events: string[] = [];
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd === "sh") {
        const script = call.args[1] ?? "";
        if (script.includes("docker pull")) events.push("direct-pull");
        else if (script.includes(" pull nautilo-server")) events.push("pull");
        else if (script.includes(" up -d")) events.push("up");
        else if (script.includes("deployment-manifest.json")) events.push("manifest");
      }
      return undefined;
    });
    let bootstrapCalls = 0;
    let tokenCalls = 0;
    let syncCalls = 0;
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: (async () => {
          events.push("health");
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
        runBootstrap: (async () => {
          bootstrapCalls += 1;
        }) as ComposeDriverDeps["runBootstrap"],
        ensureBootstrapToken: () => {
          tokenCalls += 1;
          return "not-used";
        },
        fs: {
          ...nodeFs,
          syncToRemote: async () => {
            syncCalls += 1;
          },
          toLocalStagingPath: (path: string) => path,
        } as ComposeDriverDeps["fs"],
      }),
    );

    await driver.deploy(profile);

    const composeCalls = calls.filter(
      (call) =>
        call.cmd === "sh" &&
        ((call.args[1] ?? "").includes(" pull nautilo-server") ||
          (call.args[1] ?? "").includes(" up -d")),
    );
    expect(composeCalls).toHaveLength(6);
    expectRemoteSshNativeInvocation(composeCalls[0]!, remoteRoot);
    expect(composeCalls[0]!.args[1]).toContain(" pull nautilo-server");
    expectRemoteDeployProfiles(composeCalls[0]!.args[1]!);
    expectRemoteSshNativeInvocation(composeCalls[1]!, remoteRoot);
    expect(composeCalls[1]!.args[1]).toContain(" up -d");
    expect(composeCalls[1]!.args[1]).toContain("app-postgres");
    expect(composeCalls[1]!.args[1]).toContain("--wait");
    expectRemoteDeployProfiles(composeCalls[1]!.args[1]!);
    expectRemoteSshNativeInvocation(composeCalls[2]!, remoteRoot);
    expect(composeCalls[2]!.args[1]).toContain(" up -d");
    expect(composeCalls[2]!.args[1]).toContain("logto-postgres");
    expect(composeCalls[2]!.args[1]).toContain("--wait");
    expectRemoteDeployProfiles(composeCalls[2]!.args[1]!);
    expectRemoteSshNativeInvocation(composeCalls[3]!, remoteRoot);
    expect(composeCalls[3]!.args[1]).toContain(" up -d");
    expect(composeCalls[3]!.args[1]).not.toContain("app-postgres");
    expect(composeCalls[3]!.args[1]).not.toContain("logto-postgres");
    expect(composeCalls[3]!.args[1]).not.toContain("--wait");
    expect(composeCalls[3]!.args[1]).not.toContain("--force-recreate");
    expectRemoteDeployProfiles(composeCalls[3]!.args[1]!);
    expectRemoteSshNativeInvocation(composeCalls[4]!, remoteRoot);
    expect(composeCalls[4]!.args[1]).toContain("--force-recreate");
    expect(composeCalls[4]!.args[1]).toContain(" logto");
    expect(composeCalls[4]!.args[1]).not.toContain("logto-postgres");
    expectRemoteDeployProfiles(composeCalls[4]!.args[1]!);
    expectRemoteSshNativeInvocation(composeCalls[5]!, remoteRoot);
    expect(composeCalls[5]!.args[1]).toContain("--force-recreate");
    expect(composeCalls[5]!.args[1]).toContain("--no-deps");
    expect(composeCalls[5]!.args[1]).toContain(" nautilo-server");
    expectRemoteDeployProfiles(composeCalls[5]!.args[1]!);
    expect(events).toEqual([
      "pull",
      "up",
      "up",
      "up",
      "up",
      "up",
      "health",
      "manifest",
    ]);
    expect(bootstrapCalls).toBe(0);
    expect(tokenCalls).toBe(0);
    expect(syncCalls).toBe(0);
    expect(calls.some((call) => call.cmd === "docker")).toBe(false);
    expect(events).not.toContain("direct-pull");
    expect(
      calls.flatMap((call) => extractRemoteFileWrites(call.args[1] ?? ""))
        .filter((write) => write.path === `${remoteRoot}/docker-compose.yml`),
    ).toHaveLength(1);
  });

  test("deploy: remote registry day-two adds stable host-canonical push secrets", async () => {
    const remoteRoot = mktmp("remote-day-two-pepper-");
    const operatorRoot = mktmp("remote-day-two-operator-");
    const runtimeConfig = join(remoteRoot, "runtime-config");
    mkdirSync(runtimeConfig, { recursive: true });
    writeFileSync(
      join(runtimeConfig, "instance.env"),
      "LOGTO_DB_PASSWORD=remote_logto_pw\n",
      { mode: 0o600 },
    );
    writeFileSync(join(remoteRoot, "deploy.server.env"), "LOGTO_ENDPOINT=x\n", {
      mode: 0o600,
    });
    const profile = { ...remoteComposeProfile, from_source: false, tag: "main" };
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes(".push-secrets.lock")) {
        const result = spawnSync("sh", ["-lc", script], { encoding: "utf8" });
        return {
          code: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
        resolveLocalInstanceRootDir: () => operatorRoot,
      }),
    );

    await driver.deploy(profile);
    const firstCanonical = readFileSync(join(runtimeConfig, "instance.env"), "utf8");
    const firstPepper = /^NAUTILO_REMOTE_PAIRING_PEPPER=([a-f0-9]{64})$/m.exec(
      firstCanonical,
    )?.[1];
    expect(firstPepper).toBeDefined();
    expect(readFileSync(join(remoteRoot, "deploy.server.env"), "utf8")).toContain(
      `NAUTILO_REMOTE_PAIRING_PEPPER=${firstPepper}`,
    );
    const firstPushTokenKey = /^NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY=([a-f0-9]{64})$/m.exec(
      firstCanonical,
    )?.[1];
    expect(firstPushTokenKey).toBeDefined();
    expect(readFileSync(join(remoteRoot, "deploy.server.env"), "utf8")).toContain(
      `NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY=${firstPushTokenKey}`,
    );

    await driver.deploy(profile);
    const secondCanonical = readFileSync(join(runtimeConfig, "instance.env"), "utf8");
    expect(secondCanonical).toContain(`NAUTILO_REMOTE_PAIRING_PEPPER=${firstPepper}`);
    expect(secondCanonical.match(/^NAUTILO_REMOTE_PAIRING_PEPPER=/gm)).toHaveLength(1);
    expect(secondCanonical).toContain(
      `NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY=${firstPushTokenKey}`,
    );
    expect(secondCanonical.match(/^NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY=/gm)).toHaveLength(1);
    expect(existsSync(join(operatorRoot, "instance.env"))).toBe(false);
    expect(calls.map((call) => call.args.join(" ")).join("\n")).not.toContain(
      firstPepper!,
    );
  });

  test("deploy: remote registry day-two includes office profile when enabled", async () => {
    const remoteRoot = "/opt/nautilo";
    const profile = {
      ...remoteComposeProfile,
      from_source: false,
      tag: "main",
      office: true,
    };
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.deploy(profile);

    const composeCalls = calls.filter(
      (call) =>
        call.cmd === "sh" &&
        ((call.args[1] ?? "").includes(" pull ") || (call.args[1] ?? "").includes(" up -d")),
    );
    expect(composeCalls).toHaveLength(6);
    for (const call of composeCalls) {
      expectRemoteDeployProfiles(call.args[1]!, { office: true });
    }
    expect(composeCalls[1]!.args[1]).toContain("app-postgres");
    expect(composeCalls[1]!.args[1]).toContain("--wait");
    expect(composeCalls[2]!.args[1]).toContain("logto-postgres");
    expect(composeCalls[2]!.args[1]).toContain("--wait");
    expect(composeCalls[4]!.args[1]).toContain("--force-recreate");
    expect(composeCalls[4]!.args[1]).toContain(" logto");
    expect(composeCalls[5]!.args[1]).toContain("--force-recreate");
    expect(composeCalls[5]!.args[1]).toContain("--no-deps");
    expect(composeCalls[5]!.args[1]).toContain(" nautilo-server");
  });

  test("deploy: profile/manifest mismatch fails before remote compose mutation", async () => {
    const remoteRoot = "/opt/nautilo";
    const { exec, calls } = makeRemoteLifecycleExec(
      validRemoteManifest({ remoteRoot, composeProjectName: "wrong-project" }),
    );
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.deploy({ ...remoteComposeProfile, from_source: false, tag: "main" }),
    ).rejects.toThrow(/identity mismatch/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("cat");
  });

  test("deploy: missing manifest refuses nonempty root and running project adoption", async () => {
    for (const detectedState of ["existing-root", "running-project"]) {
      const { exec, calls } = makeFakeExec((call) => {
        if (call.cmd === "cat") return { code: 1, stdout: "", stderr: "not found" };
        if (call.cmd === "sh" && (call.args[1] ?? "").includes("docker ps -aq")) {
          return {
            code: 0,
            stdout: detectedState === "existing-root" ? "existing" : "existing",
            stderr: "",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(
        makeDeps({ exec, resolveInstanceRootDir: () => "/opt/nautilo" }),
      );

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
      await expect(
        driver.deploy({ ...remoteComposeProfile, from_source: false, tag: "main" }),
      ).rejects.toThrow(/explicit adoption/);
      expect(calls).toHaveLength(2);
      expect(calls[0]!.cmd).toBe("cat");
      expect(calls[1]!.args[1]).toContain("docker ps -aq");
    }
  });

  test("adopt: inspects a legacy remote source install without compose mutation, then atomically writes only on confirm", async () => {
    const remoteRoot = "/opt/nautilo";
    const { exec, calls } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("docker inspect --format")) {
        return {
          code: 0,
          stdout: "nautilo-server:legacy-source\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      }),
    );
    const profile = {
      ...remoteComposeProfile,
      base_url: "https://nautilo.example",
    };

    await driver.adopt(profile, { dryRun: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[1]).toContain("docker inspect --format");
    expect(calls[0]!.args[1]).not.toMatch(/\b(up|pull|build|restart)\b/);
    // A Docker-over-SSH legacy source stack records the operator checkout as
    // `com.docker.compose.project.working_dir`, not the remote persistent
    // root. During a partial registry migration, newly recreated services use
    // remoteRoot while the untouched services retain one legacy label; that
    // bounded pair is accepted, while two distinct non-root labels are not.
    expect(calls[0]!.args[1]).toContain('legacy_working_dir=""');
    expect(calls[0]!.args[1]).toContain(
      'if [ "$working_dir" != "$root" ]',
    );
    expect(calls[0]!.args[1]).not.toContain(
      'if [ "$working_dir" != "$root" ]; then exit 47; fi',
    );

    // D427 Wave 1 — confirmed adoption requires a verified recovery bundle
    // and persists its provenance in the deployment manifest.
    const bundlePath = buildVerifiedBundle(mktmp("verified-bundle-"));
    await driver.adopt(profile, { confirm: true, bundlePath });

    const write = calls.find(
      (call) =>
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes("deployment-manifest.json") &&
        (call.args[1] ?? "").includes('ln "$tmp" "$manifest"'),
    );
    expect(write).toBeDefined();
    const encoded = /printf %s ([^ ]+) \| base64 -d/.exec(write!.args[1] ?? "")?.[1];
    expect(encoded).toBeDefined();
    const manifest = JSON.parse(
      Buffer.from(encoded!, "base64").toString("utf8"),
    ) as RemoteDeploymentManifest;
    expect(manifest).toMatchObject({
      version: 2,
      image: { mode: "source", reference: "nautilo-server:legacy-source" },
      remoteRoot,
      contracts: { legacyAdopted: true },
    });
    expect(manifest.version).toBe(2);
    if (manifest.version === 2) {
      expect(manifest.contracts.adoption).toBeDefined();
      expect(manifest.contracts.adoption!.phase).toBe("confirmed");
      expect(manifest.contracts.adoption!.runningImageReference).toBe(
        "nautilo-server:legacy-source",
      );
      expect(manifest.contracts.adoption!.bundle.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.contracts.adoption!.bundle.imageMode).toBe("source");
      expect(manifest.contracts.adoption!.bundle.imageReference).toBe(
        "sha256:legacy-source",
      );
    }
    expect(
      calls.flatMap((call) => extractRemoteFileWrites(call.args[1] ?? ""))
        .filter((written) => written.path === `${remoteRoot}/docker-compose.yml`),
    ).toHaveLength(0);
  });

  test("adopt --confirm refuses an absent bundle reference", async () => {
    const remoteRoot = "/opt/nautilo";
    const { exec } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("docker inspect --format")) {
        return { code: 0, stdout: "nautilo-server:legacy-source\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      }),
    );
    const profile = { ...remoteComposeProfile, base_url: "https://nautilo.example" };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.adopt(profile, { confirm: true })).rejects.toThrow(
      /requires a verified recovery bundle reference/,
    );
  });

  test("bootstrap legacy refuses confirmed conversion without both approvals and a bundle before remote I/O", async () => {
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec }));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.bootstrapLegacy(remoteComposeProfile, {
        plan: false,
        confirmAdoption: true,
      }),
    ).rejects.toThrow(/requires both --confirm-adoption and --confirm-deploy/);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.bootstrapLegacy(remoteComposeProfile, {
        plan: false,
        confirmAdoption: true,
        confirmDeploy: true,
      }),
    ).rejects.toThrow(/requires --bundle/);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.bootstrapLegacy(remoteComposeProfile, {
        plan: false,
        confirmAdoption: true,
        confirmDeploy: true,
        bundlePath: "/verified-bundle",
      }),
    ).rejects.toThrow(/requires --image/);
    expect(calls).toHaveLength(0);
  });

  test("bootstrap legacy plan inspects an explicit image without remote mutation", async () => {
    const imageRef =
      "registry.example/nautilo/server@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const { exec, calls } = makeFakeExec((call) => {
      if (call.cmd === "sh" && (call.args[1] ?? "").includes("docker inspect --format")) {
        return { code: 0, stdout: "nautilo-server:legacy-source\n", stderr: "" };
      }
      if (call.cmd === "cat") return { code: 1, stdout: "", stderr: "not found" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        resolveInstanceRootDir: () => "/opt/nautilo",
      }),
    );

    await driver.bootstrapLegacy(
      { ...remoteComposeProfile, base_url: "https://nautilo.example" },
      { plan: true, imageRef },
    );

    expect(
      calls.some(
        (call) =>
          (call.args[1] ?? "").includes("docker pull") ||
          (call.args[1] ?? "").includes("docker compose") ||
          (call.args[1] ?? "").includes("mv -f"),
      ),
    ).toBe(false);
  });

  test("bootstrap legacy refuses a resumed conversion with a different pinned image", async () => {
    const originalImage =
      "registry.example/nautilo/server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const retriedImage =
      "registry.example/nautilo/server@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest(),
      version: 2,
      image: { mode: "source", reference: "nautilo-server:legacy-source" },
      contracts: {
        legacyAdopted: true,
        adoption: {
          phase: "confirmed",
          confirmedAt: "2026-07-16T11:00:00.000Z",
          bundle: {
            manifestSha256: "a".repeat(64),
            createdAt: "2026-07-16T11:00:00.000Z",
            verifiedAt: "2026-07-16T11:00:00.000Z",
            imageMode: "source",
            imageReference: "sha256:legacy-source",
          },
          runningImageReference: "nautilo-server:legacy-source",
        },
        legacyBootstrap: {
          phase: "adopted",
          imageReference: originalImage,
          updatedAt: "2026-07-16T11:00:00.000Z",
        },
      },
    };
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => "/opt/nautilo" }),
    );
    const bundlePath = buildVerifiedBundle(mktmp("verified-bundle-"));

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.bootstrapLegacy(remoteComposeProfile, {
        plan: false,
        confirmAdoption: true,
        confirmDeploy: true,
        bundlePath,
        imageRef: retriedImage,
      }),
    ).rejects.toThrow(/does not match the originally confirmed image/);
    expect(calls.map((call) => call.cmd)).toEqual(["cat"]);
  });

  test("adopt --confirm refuses an unverified (v1) bundle", async () => {
    const remoteRoot = "/opt/nautilo";
    const { exec } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && script.includes("docker inspect --format")) {
        return { code: 0, stdout: "nautilo-server:legacy-source\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      }),
    );
    const profile = { ...remoteComposeProfile, base_url: "https://nautilo.example" };
    // A v1 bundle cannot establish verified provenance.
    const v1Bundle = mktmp("v1-bundle-");
    mkdirSync(v1Bundle, { recursive: true });
    chmodSync(v1Bundle, 0o700);
    writeFileSync(
      join(v1Bundle, "manifest.json"),
      JSON.stringify(
        backupManifestSchema.parse({
          version: 1,
          createdAt: "2026-07-16T11:00:00.000Z",
          profileName: "remote-prod",
          instanceId: "prod",
          transport: "remote",
          composeProjectName: "nautilo-prod",
          image: { mode: "source", imageId: "sha256:legacy-source" },
          contents: {
            nautiloDb: true,
            logtoDb: true,
            artifacts: true,
            media: false,
            instanceEnv: true,
            operatorFiles: false,
            caddyData: false,
            caddyConfig: false,
            localCaCerts: false,
          },
          https: "letsencrypt",
        }),
        null,
        2,
      ),
    );
    chmodSync(join(v1Bundle, "manifest.json"), 0o600);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.adopt(profile, { confirm: true, bundlePath: v1Bundle }),
    ).rejects.toThrow(/did not pass verification/);
  });

  test("deploy: adopted legacy source install materializes from remote canonical env without an operator mirror", async () => {
    const remoteRoot = "/opt/nautilo";
    const operatorRoot = mktmp("legacy-adopt-operator-");
    const operatorInstanceEnv = [
      "LOGTO_ENDPOINT=http://198.51.100.2:6301",
      "LOGTO_JWKS_URI=http://198.51.100.2:6301/oidc/jwks",
      "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET=preserved-secret",
      "",
    ].join("\n");
    writeFileSync(join(operatorRoot, "instance.env"), operatorInstanceEnv);
    let adoptedManifest = "";
    const events: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "cat" && call.args[0] === `${remoteRoot}/deployment-manifest.json`) {
        return { code: 0, stdout: adoptedManifest, stderr: "" };
      }
      if (
        call.cmd === "cat" &&
        call.args[0] === `${remoteRoot}/runtime-config/instance.env`
      ) {
        return { code: 0, stdout: operatorInstanceEnv, stderr: "" };
      }
      if (
        call.cmd === "sh" &&
        script.includes("find_one logto") &&
        script.includes("logto_core=")
      ) {
        return {
          code: 0,
          stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
          stderr: "",
        };
      }
      const releaseInspect = mockReleaseDockerInspectScriptResponse(script, {
        requested: CANONICAL_IMAGE_REF,
        repoDigest: `ghcr.io/agentsea/nautilo-server@sha256:${"e".repeat(64)}`,
      });
      if (releaseInspect !== undefined) return releaseInspect;
      if (call.cmd === "sh" && script.includes("docker inspect --format")) {
        return {
          code: 0,
          stdout: "nautilo-server:legacy-source\n",
          stderr: "",
        };
      }
      if (call.cmd === "sh" && script.includes('ln "$tmp" "$manifest"')) {
        const encoded = /printf %s ([^ ]+) \| base64 -d/.exec(script)?.[1];
        adoptedManifest = `${Buffer.from(encoded!, "base64").toString("utf8")}\n`;
        events.push("adopt");
      } else if (call.cmd === "sh" && script.includes('missing=""')) {
        return { code: 0, stdout: "", stderr: "" };
      } else if (
        call.cmd === "sh" &&
        script.includes("printf %s") &&
        script.includes("docker-compose.yml")
      ) {
        events.push("template");
      } else if (call.cmd === "sh" && script.includes("docker pull")) {
        events.push("direct-pull");
      } else if (call.cmd === "sh" && script.includes(" up -d")) {
        events.push("up");
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        resolveLocalInstanceRootDir: () => operatorRoot,
        readInstanceLogtoEnv: async () => ({
          LOGTO_ENDPOINT: "http://198.51.100.2:6301",
          LOGTO_JWKS_URI: "http://198.51.100.2:6301/oidc/jwks",
        }),
        fetch: (async () => {
          events.push("health");
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );
    const sourceProfile = {
      ...remoteComposeProfile,
      base_url: "https://nautilo.example",
    };

    const bundlePath = buildVerifiedBundle(mktmp("verified-bundle-"));
    await driver.adopt(sourceProfile, { confirm: true, bundlePath });

    expect(events).toEqual(["health", "adopt"]);
    expect(
      calls.flatMap((call) => extractRemoteFileWrites(call.args[1] ?? ""))
        .filter((written) => written.path === `${remoteRoot}/docker-compose.yml`),
    ).toHaveLength(0);

    await driver.deploy({
      ...remoteRegistryProfile,
      tag: "sha-04749d5",
    });

    expect(events.slice(0, 5)).toEqual([
      "health",
      "adopt",
      "template",
      "template",
      "direct-pull",
    ]);
    expect(events.at(-1)).toBe("health");
    const legacyBootstrapCall = calls.find(
      (call) =>
        call.cmd === "sh" &&
        extractRemoteFileWrites(call.args[1] ?? "").some(
          (written) => written.path === `${remoteRoot}/deploy.server.env`,
        ),
    );
    const bootstrapWrites = extractRemoteFileWrites(legacyBootstrapCall!.args[1] ?? "");
    const templateWrite = bootstrapWrites.find(
      (written) => written.path === `${remoteRoot}/docker-compose.yml`,
    )!;
    expect(templateWrite).toMatchObject({
      path: `${remoteRoot}/docker-compose.yml`,
      contents: "# unit-test template marker\n",
      mode: "644",
    });
    expect(
      bootstrapWrites.some((written) => written.path === `${remoteRoot}/instance.env`),
    ).toBe(false);
    const serverEnvWrite = bootstrapWrites.find(
      (written) => written.path === `${remoteRoot}/deploy.server.env`,
    )!;
    expect(serverEnvWrite).toMatchObject({
      path: `${remoteRoot}/deploy.server.env`,
      mode: "600",
    });
    expect(serverEnvWrite.contents).toContain(
      "LOGTO_ENDPOINT_INTERNAL=http://logto:6301",
    );
    expect(serverEnvWrite.contents).toContain(
      "LOGTO_JWKS_URI=http://logto:6301/oidc/jwks",
    );
    const serverOverlayWrite = bootstrapWrites.find(
      (written) => written.path === `${remoteRoot}/deploy.server-overlay.yml`,
    )!;
    expect(serverOverlayWrite).toMatchObject({
      path: `${remoteRoot}/deploy.server-overlay.yml`,
      mode: "600",
    });
    expect(serverOverlayWrite.contents).toContain(
      [
        `      - ${remoteRoot}/runtime-config/instance.env`,
        `      - ${remoteRoot}/deploy.server.env`,
      ].join("\n"),
    );
    expect(serverOverlayWrite.contents).toContain(
      `- ${remoteRoot}/runtime-config:/var/lib/nautilo/config`,
    );
    const upCall = calls.find(
      (call) => call.cmd === "sh" && (call.args[1] ?? "").includes(" up -d"),
    );
    expect(calls.indexOf(legacyBootstrapCall!)).toBeLessThan(calls.indexOf(upCall!));
  });

  test("deploy: adopted legacy source registry bootstrap refuses a missing canonical remote instance.env before mutation", async () => {
    const remoteRoot = "/opt/nautilo";
    const operatorRoot = mktmp("legacy-adopt-missing-operator-");
    const manifest: RemoteDeploymentManifest = {
      ...validRemoteManifest({ remoteRoot }),
      version: 2,
      image: { mode: "source", reference: "nautilo-server:legacy-source" },
      contracts: { legacyAdopted: true },
    };
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (
        call.cmd === "cat" &&
        call.args.some((arg) =>
          arg.includes("runtime-config/instance.env"),
        )
      ) {
        return { code: 1, stdout: "", stderr: "not found" };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        resolveLocalInstanceRootDir: () => operatorRoot,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.deploy({ ...remoteRegistryProfile, tag: "sha-04749d5" }),
    ).rejects.toThrow(/canonical remote instance\.env is missing or unreadable/);
    expect(
      calls.some(
        (call) =>
          (call.args[1] ?? "").includes("docker pull") ||
          (call.args[1] ?? "").includes("exec docker compose"),
      ),
    ).toBe(false);
    const remoteWrites = calls.flatMap((call) =>
      extractRemoteFileWrites(call.args[1] ?? ""),
    );
    expect(remoteWrites.length).toBeGreaterThan(0);
    expect(
      remoteWrites.every((write) => write.path === `${remoteRoot}/docker-compose.yml`),
    ).toBe(true);
  });

  test("adopt: refuses an existing manifest before public health or writes", async () => {
    const { exec, calls } = makeFakeExec(() => ({
      code: 40,
      stdout: "",
      stderr: "",
    }));
    let healthChecks = 0;
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => "/opt/nautilo",
        fetch: (async () => {
          healthChecks += 1;
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.adopt({ ...remoteComposeProfile, base_url: "https://nautilo.example" }),
    ).rejects.toThrow(/manifest is already present/);
    expect(calls).toHaveLength(1);
    expect(healthChecks).toBe(0);
  });

  test("deploy: fresh remote registry first install stages, validates, promotes, then publishes manifest", async () => {
    const remoteRoot = "/opt/nautilo";
    const events: string[] = [];
    const { exec, calls } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "cat") return { code: 1, stdout: "", stderr: "not found" };
      if (script.includes("docker ps -aq")) return { code: 0, stdout: "fresh", stderr: "" };
      if (script.includes("deployment-manifest.json")) events.push("manifest");
      else if (script.includes(" config")) events.push("config");
      else if (script.includes("mv --")) events.push("promote");
      else if (script.includes(" pull ")) events.push("pull");
      else if (script.includes(" up -d")) events.push("up");
      return { code: 0, stdout: "", stderr: "" };
    });
    let bootstrapCalls = 0;
    let tokenCalls = 0;
    let syncCalls = 0;
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: (async () => {
          events.push("health");
          return new Response("ok", { status: 200 });
        }) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
        readInstanceLogtoEnv: async () => ({ LOGTO_ENDPOINT: "http://127.0.0.1:3301" }),
        runBootstrap: (async () => {
          bootstrapCalls += 1;
        }) as ComposeDriverDeps["runBootstrap"],
        ensureBootstrapToken: () => {
          tokenCalls += 1;
          return "fresh-only-token";
        },
        openSshTunnel: async () => ({ close: async () => {} }),
        fs: {
          ...nodeFs,
          syncToRemote: async () => {
            syncCalls += 1;
          },
          toLocalStagingPath: (path: string) => path,
        } as ComposeDriverDeps["fs"],
      }),
    );

    await driver.deploy({
      ...remoteComposeProfile,
      from_source: false,
      instance_id: "isolated",
      tag: "main",
    });

    expect(events.indexOf("config")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("config")).toBeLessThan(events.indexOf("promote"));
    expect(events.indexOf("promote")).toBeLessThan(events.indexOf("pull"));
    expect(events.indexOf("manifest")).toBeGreaterThan(events.lastIndexOf("health"));
    const configCall = calls.find(
      (call) => call.cmd === "sh" && / config(?:\s|$)/.test(call.args[1] ?? ""),
    );
    expect(configCall?.opts.stdio).toBe("pipe");
    const deployComposeCalls = calls.filter(
      (call) =>
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes("docker compose") &&
        / (config|pull |up -d)/.test(call.args[1] ?? ""),
    );
    expect(deployComposeCalls.length).toBeGreaterThanOrEqual(3);
    for (const call of deployComposeCalls) {
      expectRemoteDeployProfiles(call.args[1]!);
    }
    expect(bootstrapCalls).toBe(1);
    expect(tokenCalls).toBe(1);
    expect(syncCalls).toBe(0);
    const manifestCall = calls.find(
      (call) =>
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes("deployment-manifest.json"),
    );
    const manifestWrites = extractRemoteFileWrites(manifestCall!.args[1] ?? "");
    const manifest = JSON.parse(manifestWrites[0]!.contents) as RemoteDeploymentManifest;
    expect(manifest.version).toBe(2);
    if (manifest.version !== 2) throw new Error("expected v2 manifest");
    expect(manifest.contracts.authApplied?.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.some((call) => call.cmd === "docker")).toBe(false);
    const stagedComposeEnv = calls
      .filter((call) => call.cmd === "sh" && (call.args[1] ?? "").includes(".nautilo-stage-"))
      .flatMap((call) => extractRemoteFileWrites(call.args[1] ?? ""))
      .find((write) => write.path.endsWith("deploy.compose.env"));
    expect(stagedComposeEnv?.contents).toContain("NAUTILO_INSTANCE_ID=isolated");
    const stagedConfigCall = calls.find(
      (call) =>
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes("runtime-config/instance.env") &&
        (call.args[1] ?? "").includes("ln -s"),
    );
    expect(stagedConfigCall).toBeDefined();
    expect(stagedConfigCall!.args[1]).toContain(
      "ln -s runtime-config/instance.env",
    );
    expect(
      extractRemoteFileWrites(stagedConfigCall!.args[1] ?? "").some((write) =>
        write.path.endsWith("/runtime-config/instance.env"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.cmd === "sh" &&
          (call.args[1] ?? "").includes(".nautilo-stage-") &&
          (call.args[1] ?? "").includes("chmod 600"),
      ),
    ).toBe(true);
  });

  test("deploy: fresh remote letsencrypt first install rewrites compose env to active root before pull", async () => {
    const remoteRoot = "/opt/nautilo";
    const { exec, calls } = makeFakeExec((call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "cat") return { code: 1, stdout: "", stderr: "not found" };
      if (script.includes("docker ps -aq")) return { code: 0, stdout: "fresh", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
        readInstanceLogtoEnv: async () => ({ LOGTO_ENDPOINT: "http://127.0.0.1:3301" }),
        runBootstrap: (async () => {}) as ComposeDriverDeps["runBootstrap"],
        openSshTunnel: async () => ({ close: async () => {} }),
        fs: {
          ...nodeFs,
          syncToRemote: async () => {},
          toLocalStagingPath: (path: string) => path,
        } as ComposeDriverDeps["fs"],
      }),
    );

    await driver.deploy({
      ...remoteComposeProfile,
      from_source: false,
      tag: "main",
      domain: "alpha.example.com",
      https: "letsencrypt",
      acme_email: "admin@example.com",
    });

    const promoteIdx = calls.findIndex(
      (call) => call.cmd === "sh" && (call.args[1] ?? "").includes("mv --"),
    );
    expect(promoteIdx).toBeGreaterThanOrEqual(0);

    const pullIdx = calls.findIndex(
      (call) =>
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes("docker compose") &&
        (call.args[1] ?? "").includes(" pull "),
    );
    expect(pullIdx).toBeGreaterThan(promoteIdx);

    const postPromotionWrite = calls.find(
      (call, idx) =>
        idx > promoteIdx &&
        idx < pullIdx &&
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes(`${remoteRoot}/deploy.compose.env`) &&
        !(call.args[1] ?? "").includes(".nautilo-stage-"),
    );
    expect(postPromotionWrite).toBeDefined();

    const writes = extractRemoteFileWrites(postPromotionWrite!.args[1] ?? "");
    const composeEnvWrite = writes.find((w) => w.path.endsWith("/deploy.compose.env"));
    expect(composeEnvWrite).toBeDefined();
    expect(composeEnvWrite!.mode).toBe("600");
    expect(composeEnvWrite!.contents).toContain(
      `NAUTILO_DEPLOY_CADDYFILE_PATH=${remoteRoot}/deploy.Caddyfile`,
    );
    expect(composeEnvWrite!.contents).not.toContain(".nautilo-stage-");

    const configCall = calls.find(
      (call) => call.cmd === "sh" && (call.args[1] ?? "").includes(" config"),
    );
    expect(configCall?.args[1]).toContain(".nautilo-stage-");

    const pullScript = calls[pullIdx]!.args[1] ?? "";
    expect(pullScript).toContain(`${remoteRoot}/deploy.compose.env`);
    expect(pullScript).not.toContain(".nautilo-stage-");
  });

  test("deploy: day-two health failure does not commit the incoming manifest", async () => {
    const remoteRoot = "/opt/nautilo";
    const events: string[] = [];
    let manifestWrites = 0;
    const { exec } = makeRemoteLifecycleExec(validRemoteManifest({ remoteRoot }), (call) => {
      if (call.cmd === "sh") {
        const script = call.args[1] ?? "";
        if (script.includes(" pull ") || script.includes(" up -d")) events.push("compose");
        if (script.includes("deployment-manifest.json")) manifestWrites += 1;
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        serverHealthTimeoutMs: 0,
        pollIntervalMs: 1,
        fetch: (async () => {
          events.push("health");
          return new Response("down", { status: 503 });
        }) as unknown as typeof fetch,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.deploy({ ...remoteComposeProfile, from_source: false, tag: "main" }),
    ).rejects.toThrow(/Remote runtime acceptance failed after compose update/);
    expect(events[0]).toBe("compose");
    expect(events).toContain("health");
    expect(manifestWrites).toBe(0);
  });

  test("Logto health makes one immediate probe when its retry budget is zero", async () => {
    const urls: string[] = [];
    const driver = new ComposeDriver(
      makeDeps({
        logtoHealthTimeoutMs: 0,
        fetch: (async (input: Parameters<typeof fetch>[0]) => {
          urls.push(
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url,
          );
          return new Response("down", { status: 503 });
        }) as unknown as typeof fetch,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      (driver as unknown as {
        pollLogtoHealth(endpoint: string): Promise<void>;
      }).pollLogtoHealth("http://logto.example"),
    ).rejects.toThrow(/Logto discovery doc never became ready within 0ms/);
    expect(urls).toEqual([
      "http://logto.example/oidc/.well-known/openid-configuration",
    ]);
  });

  // -------------------------------------------------------------------------
  // M207 — remote registry day-two image/overlay/manifest correction
  // -------------------------------------------------------------------------
  test("deploy: remote day-two explicit image direct-pulls, writes overlay, up, updates manifest", async () => {
    const remoteRoot = "/opt/nautilo";
    const imageRef = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"c".repeat(64)}`;
    const profile = { ...remoteComposeProfile, from_source: false, image_ref: imageRef };
    const manifest = validRemoteManifest({
      remoteRoot,
      image: { mode: "registry", reference: CANONICAL_IMAGE_REF },
    });
    const events: string[] = [];
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd !== "sh") return undefined;
      const script = call.args[1] ?? "";
      const releaseInspect = mockReleaseDockerInspectScriptResponse(script, {
        requested: imageRef,
        repoDigest: imageRef,
      });
      if (releaseInspect !== undefined) return releaseInspect;
      if (script.includes("docker pull")) events.push("direct-pull");
      else if (
        script.includes("printf %s") &&
        script.includes("deploy.registry-overlay.yml") &&
        !script.includes("psql")
      ) {
        events.push("overlay");
      } else if (script.includes(" up -d")) events.push("up");
      else if (script.includes("deployment-manifest.json")) events.push("manifest");
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        now: () => new Date("2026-07-10T18:00:00.000Z"),
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.deploy(profile);

    expect(events).toEqual([
      "direct-pull",
      "overlay",
      "up",
      "up",
      "up",
      "up",
      "up",
      "manifest",
    ]);
    const pullCall = calls.find(
      (call) => call.cmd === "sh" && (call.args[1] ?? "").includes("docker pull"),
    );
    expect(pullCall).toBeDefined();
    expect(pullCall!.args[1]).toContain(imageRef);
    expect(pullCall!.args[1]).not.toContain("DOCKER_HOST");

    const overlayCall = calls.find(
      (call) =>
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes("printf %s") &&
        (call.args[1] ?? "").includes("deploy.registry-overlay.yml"),
    );
    const overlayWrites = extractRemoteFileWrites(overlayCall!.args[1] ?? "");
    expect(overlayWrites).toHaveLength(1);
    expect(overlayWrites[0]!.path).toBe(`${remoteRoot}/deploy.registry-overlay.yml`);
    expect(overlayWrites[0]!.contents).toContain(imageRef);

    const manifestCall = calls.find(
      (call) =>
        call.cmd === "sh" && (call.args[1] ?? "").includes("deployment-manifest.json"),
    );
    const manifestWrites = extractRemoteFileWrites(manifestCall!.args[1] ?? "");
    expect(manifestWrites).toHaveLength(1);
    const written = JSON.parse(manifestWrites[0]!.contents) as RemoteDeploymentManifest;
    expect(written.image.reference).toBe(imageRef);
    expect(written.image.mode).toBe("registry");
    expect(written.updatedAt).toBe("2026-07-10T18:00:00.000Z");
    expect(written.createdAt).toBe(manifest.createdAt);
    expect(written.remoteRoot).toBe(remoteRoot);

    expect(calls.some((call) => (call.args[1] ?? "").includes(" pull nautilo-server"))).toBe(
      false,
    );
  });

  test("deploy: current remote registry day-two matching tag pulls only server, then broadly ups active profiles", async () => {
    const remoteRoot = "/opt/nautilo";
    const repoDigest = `ghcr.io/agentsea/nautilo-server@sha256:${"b".repeat(64)}`;
    const manifest = validRemoteManifest({ remoteRoot });
    const events: string[] = [];
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd !== "sh") return undefined;
      const script = call.args[1] ?? "";
      const releaseInspect = mockReleaseDockerInspectScriptResponse(script, { repoDigest });
      if (releaseInspect !== undefined) return releaseInspect;
      if (script.includes("docker pull")) events.push("direct-pull");
      else if (script.includes(" pull nautilo-server")) events.push("pull");
      else if (script.includes(" up -d")) events.push("up");
      else if (script.includes("deployment-manifest.json")) events.push("manifest");
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        now: () => new Date("2026-07-10T18:00:00.000Z"),
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.deploy({ ...remoteComposeProfile, from_source: false, tag: "main" });

    expect(events).toEqual(["pull", "up", "up", "up", "up", "up", "manifest"]);
    expect(events).not.toContain("direct-pull");
    const pullCall = calls.find(
      (call) =>
        call.cmd === "sh" &&
        (call.args[1] ?? "").includes(" pull nautilo-server"),
    );
    expect(pullCall).toBeDefined();
    expect(pullCall!.args[1]).not.toContain("--no-deps");

    // Characterize the current day-two contract before `release` deliberately
    // narrows it: image pull names only nautilo-server, but the follow-up
    // compose `up` is intentionally broad across active auth/app profiles.
    const upCalls = calls.filter(
      (call) => call.cmd === "sh" && (call.args[1] ?? "").includes(" up -d"),
    );
    expect(upCalls.length).toBeGreaterThanOrEqual(3);
    const fullUpCall = upCalls.find(
      (call) =>
        !(call.args[1] ?? "").includes("app-postgres") &&
        !(call.args[1] ?? "").includes("--force-recreate"),
    );
    expect(fullUpCall).toBeDefined();
    expectRemoteDeployProfiles(fullUpCall!.args[1]!);
    expect(fullUpCall!.args[1]).not.toContain("--no-build");
    expect(fullUpCall!.args[1]).not.toContain("--no-deps");
    expect(fullUpCall!.args[1]).not.toContain(" up -d nautilo-server");
    expect(
      calls.filter(
        (call) =>
          call.cmd === "sh" &&
          (call.args[1] ?? "").includes("printf %s") &&
          (call.args[1] ?? "").includes("deploy.registry-overlay.yml") &&
          !(call.args[1] ?? "").includes("psql"),
      ),
    ).toHaveLength(0);

    const manifestCall = calls.find(
      (call) =>
        call.cmd === "sh" && (call.args[1] ?? "").includes("deployment-manifest.json"),
    );
    const manifestWrites = extractRemoteFileWrites(manifestCall!.args[1] ?? "");
    const written = JSON.parse(manifestWrites[0]!.contents) as RemoteDeploymentManifest;
    expect(written.image.reference).toBe(CANONICAL_IMAGE_REF);
    expect(written.image.mode).toBe("registry");
    expect(written.updatedAt).toBe("2026-07-10T18:00:00.000Z");
    expect(written.createdAt).toBe(manifest.createdAt);
  });

  test("deploy: remote day-two refuses before mutation when server lacks media volume", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const events: string[] = [];
    const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd !== "sh") return undefined;
      const script = call.args[1] ?? "";
      if (script.includes('missing=""')) {
        return { code: 0, stdout: "media", stderr: "" };
      }
      if (script.includes("docker pull") || script.includes("printf %s")) {
        events.push("mutation");
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.deploy({ ...remoteComposeProfile, from_source: false, tag: "main" }),
    ).rejects.toThrow(/migrate-media-to-volume/);
    expect(events).toHaveLength(0);
    expect(calls.some((call) => (call.args[1] ?? "").includes(" up -d"))).toBe(false);
  });

  test("deploy: remote day-two --allow-artifact-loss permits missing media with warning", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const logLines: string[] = [];
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd !== "sh") return undefined;
      const script = call.args[1] ?? "";
      if (script.includes('missing=""')) {
        return { code: 0, stdout: "media", stderr: "" };
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        log: (msg) => logLines.push(msg),
        fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.deploy(
      { ...remoteComposeProfile, from_source: false, tag: "main" },
      { allowArtifactLoss: true },
    );
    expect(
      logLines.some(
        (line) => line.includes("warning") && line.includes("media"),
      ),
    ).toBe(true);
  });

  test("deploy: https=off (default) does NOT write Caddyfile or overlay", async () => {
    const { exec, calls } = makeFakeExec();
    const { fetch: fakeFetch } = makeFakeFetch(1);
    const instanceRootDir = join(home, ".nautilo");

    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: fakeFetch,
        readInstanceLogtoEnv: async () => ({}),
        resolveInstanceRootDir: () => instanceRootDir,
      }),
    );
    await driver.deploy(baseProfile);

    expect(existsSync(join(instanceRootDir, "deploy.Caddyfile"))).toBe(false);
    expect(existsSync(join(instanceRootDir, "deploy.caddy-overlay.yml"))).toBe(false);

    const composeUpCalls = calls.filter(
      (c) =>
        c.cmd === "docker" &&
        c.args.includes("up") &&
        c.args.includes("--build"),
    );
    for (const up of composeUpCalls) {
      expect(up.args.some((a) => a.includes("deploy.caddy-overlay.yml"))).toBe(false);
    }
  });

  test("deploy: https=letsencrypt without acme_email throws", async () => {
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-le",
      transport: "local",
      lifecycle: "compose",
      from_source: true,
      domain: "alpha.example.com",
      https: "letsencrypt",
    };
    const instanceRootDir = mktmp("compose-driver-le-no-email-");
    const driver = new ComposeDriver(
      makeDeps({
        readInstanceLogtoEnv: async () => ({}),
        resolveInstanceRootDir: () => instanceRootDir,
      }),
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.deploy(remoteProfile)).rejects.toThrow(/requires an ACME email/);
  });

  test("deploy: https=letsencrypt uses resolveAcmeEmail callback fallback", async () => {
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-le",
      transport: "local",
      lifecycle: "compose",
      from_source: true,
      domain: "alpha.example.com",
      https: "letsencrypt",
    };
    const instanceRootDir = mktmp("compose-driver-le-fallback-");
    const { exec } = makeFakeExec();
    const { fetch: fakeFetch } = makeFakeFetch(1);

    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: fakeFetch,
        readInstanceLogtoEnv: async () => ({}),
        resolveInstanceRootDir: () => instanceRootDir,
        resolveAcmeEmail: () => "fallback@example.com",
      }),
    );
    await driver.deploy(remoteProfile);

    const composeEnv = readFileSync(
      join(instanceRootDir, "deploy.compose.env"),
      "utf8",
    );
    expect(composeEnv).toContain("ACME_EMAIL=fallback@example.com");
  });

  // -------------------------------------------------------------------------
  // restore --force gate
  // -------------------------------------------------------------------------
  test("restore: refuses without --force when setupState=ready", async () => {
    const { fetch: fakeFetch } = makeFakeFetch(1);
    const fetchMock = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/setup/status")) {
        return new Response('{"setupState":"ready"}', { status: 200 });
      }
      return fakeFetch(input);
    }) as unknown as typeof fetch;
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec, fetch: fetchMock }));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      driver.restore(baseProfile, { fromPath: "/tmp/x.sql.gz", force: false }),
    ).rejects.toThrow(/restore refused/);
    expect(calls.filter((c) => c.cmd === "curl").length).toBe(0);
  });

  test("restore: --force bypasses the readiness gate", async () => {
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec, localExec: fakeLocalExec }));
    await driver.restore(baseProfile, {
      fromPath: "/tmp/x.sql.gz",
      force: true,
    });
    expect(
      calls.some(
        (c) =>
          c.cmd === "docker" &&
          c.args.includes("stop") &&
          c.args.includes("nautilo-server"),
      ),
    ).toBe(true);
    expect(
      localExecCalls.some((c) => c.cmd === "sh" && c.args.some((a) => a.includes("gunzip"))),
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.cmd === "docker" &&
          c.args.includes("start") &&
          c.args.includes("nautilo-server"),
      ),
    ).toBe(true);
  });

  test("restore: remote profile sets DOCKER_HOST on restore pipeline", async () => {
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const { exec } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec, localExec: fakeLocalExec }));
    await driver.restore(remoteProfile, {
      fromPath: join(home, ".nautilo", "backups", "dump.sql.gz"),
      force: true,
    });
    // D420 3.1.1: the legacy restore now runs TWO sh pipelines through
    // localExec — a gzip validation gate, then the fail-closed gunzip|psql
    // restore. Both must run with the remote DOCKER_HOST env so they target
    // the droplet daemon, and the restore pipeline must still carry gunzip.
    const shCalls = localExecCalls.filter((c) => c.cmd === "sh");
    expect(shCalls.length).toBeGreaterThanOrEqual(2);
    const validate = shCalls.find((c) => c.args.join(" ").includes("gzip -t"));
    expect(validate).toBeDefined();
    expect(validate!.opts.env?.["DOCKER_HOST"]).toBe("ssh://root@1.2.3.4");
    const restore = shCalls.find((c) => c.args.join(" ").includes("gunzip"));
    expect(restore).toBeDefined();
    expect(restore!.opts.env?.["DOCKER_HOST"]).toBe("ssh://root@1.2.3.4");
    expect(restore!.args.join(" ")).toContain("ON_ERROR_STOP=1");
  });

  // -------------------------------------------------------------------------
  // destroy --hard wipes .bootstrap
  // -------------------------------------------------------------------------
  test("destroy --hard wipes .bootstrap and runs `down -v`", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRootDir = join(home, ".nautilo");
    mkdirSync(join(instanceRootDir, ".bootstrap"), { recursive: true });
    writeFileSync(
      join(instanceRootDir, ".bootstrap", "claim-invite"),
      "x\n",
    );

    const driver = new ComposeDriver(makeDeps({ exec }));
    await driver.destroy(baseProfile, { hard: true });

    expect(existsSync(join(instanceRootDir, ".bootstrap"))).toBe(false);
    const downCall = calls.find(
      (c) => c.cmd === "docker" && c.args.includes("down"),
    );
    expect(downCall).toBeDefined();
    expect(downCall!.args).toContain("-v");
  });

  test("destroy without --hard: down (no -v), .bootstrap preserved", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRootDir = join(home, ".nautilo");
    mkdirSync(join(instanceRootDir, ".bootstrap"), { recursive: true });
    writeFileSync(
      join(instanceRootDir, ".bootstrap", "claim-invite"),
      "x\n",
    );

    const driver = new ComposeDriver(makeDeps({ exec }));
    await driver.destroy(baseProfile, { hard: false });

    expect(existsSync(join(instanceRootDir, ".bootstrap"))).toBe(true);
    const downCall = calls.find(
      (c) => c.cmd === "docker" && c.args.includes("down"),
    );
    expect(downCall).toBeDefined();
    expect(downCall!.args).not.toContain("-v");
  });

  test("destroy: includes caddy overlay -f when deploy.caddy-overlay.yml exists", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRootDir = join(home, ".nautilo");
    mkdirSync(instanceRootDir, { recursive: true });
    // Simulate a prior LE deploy
    writeFileSync(join(instanceRootDir, "deploy.caddy-overlay.yml"), "# fake overlay\n");
    writeFileSync(join(instanceRootDir, "deploy.compose.env"), "FOO=bar\n");
    const driver = new ComposeDriver(makeDeps({ exec }));
    await driver.destroy(baseProfile, { hard: false });
    const down = calls.find((c) => c.cmd === "docker" && c.args.includes("down"));
    expect(down).toBeDefined();
    // The overlay path must appear after a `-f` flag in the args.
    const fIndices = down!.args
      .map((a, i) => (a === "-f" ? i : -1))
      .filter((i) => i >= 0);
    const fValues = fIndices.map((i) => down!.args[i + 1]);
    expect(fValues.some((v) => v?.endsWith("deploy.caddy-overlay.yml"))).toBe(true);
  });

  test("destroy --hard --keep-certs runs down without -v + removes data volumes", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRootDir = join(home, ".nautilo");
    mkdirSync(instanceRootDir, { recursive: true });
    writeFileSync(join(instanceRootDir, "deploy.caddy-overlay.yml"), "# fake overlay\n");
    writeFileSync(join(instanceRootDir, "deploy.compose.env"), "FOO=bar\n");
    const driver = new ComposeDriver(makeDeps({ exec }));
    await driver.destroy(baseProfile, { hard: true, keepCerts: true });

    const down = calls.find((c) => c.cmd === "docker" && c.args.includes("down"));
    expect(down).toBeDefined();
    // No -v on the down call
    expect(down!.args).not.toContain("-v");

    // Explicit `docker volume rm` calls for DB volumes
    const volRmCalls = calls.filter(
      (c) => c.cmd === "docker" && c.args[0] === "volume" && c.args[1] === "rm",
    );
    const volNames = volRmCalls.map((c) => c.args[c.args.length - 1]);
    expect(volNames).toContain("nautilo_app_pgdata");
    expect(volNames).toContain("nautilo_logto_pgdata");
    expect(volNames).toContain("nautilo_app_artifacts");
    expect(volNames).toContain("nautilo_app_media");
    expect(volNames).toContain("nautilo_app_apps");
    // Caddy volumes NOT touched
    expect(volNames.some((v) => v && v.includes("caddy"))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // assertArtifactVolumePresentOrMigrated (M139)
  // -------------------------------------------------------------------------
  describe("assertArtifactVolumePresentOrMigrated", () => {
    test("deploy: guard passes when no nautilo-server is running", async () => {
      const { exec, calls } = makeFakeExec((call) => {
        if (call.args.includes("ps")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(
        makeDeps({
          exec,
          readInstanceLogtoEnv: async () => ({}),
        }),
      );
      await driver.deploy(baseProfile);
      expect(calls.some((c) => c.args.includes("inspect"))).toBe(false);
    });

    test("deploy: guard throws when server running but artifact volume missing", async () => {
      const { exec } = makeFakeExec((call) => {
        if (call.args.includes("ps")) {
          return { code: 0, stdout: "nautilo-nautilo-server-1\n", stderr: "" };
        }
        if (call.args[0] === "volume" && call.args[1] === "inspect") {
          return { code: 1, stdout: "", stderr: "no such volume" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(makeDeps({ exec }));
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driver.deploy(baseProfile)).rejects.toThrow(
        /migrate-artifacts-to-volume/,
      );
    });

    test("deploy: guard names migrate-media-to-volume when only media is missing", async () => {
      const { exec } = makeFakeExec((call) => {
        if (call.args.includes("ps")) {
          return { code: 0, stdout: "nautilo-nautilo-server-1\n", stderr: "" };
        }
        if (call.args[0] === "volume" && call.args[1] === "inspect") {
          return call.args[2] === "nautilo_app_media"
            ? { code: 1, stdout: "", stderr: "no such volume" }
            : { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(makeDeps({ exec }));
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(driver.deploy(baseProfile)).rejects.toThrow(/migrate-media-to-volume/);
    });

    test("deploy: --allow-artifact-loss overrides the guard", async () => {
      const logLines: string[] = [];
      const { exec } = makeFakeExec((call) => {
        if (call.args.includes("ps")) {
          return { code: 0, stdout: "nautilo-nautilo-server-1\n", stderr: "" };
        }
        if (call.args[0] === "volume" && call.args[1] === "inspect") {
          return { code: 1, stdout: "", stderr: "no such volume" };
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(
        makeDeps({
          exec,
          readInstanceLogtoEnv: async () => ({}),
          log: (m) => logLines.push(m),
        }),
      );
      await driver.deploy(baseProfile, { allowArtifactLoss: true });
      expect(
        logLines.some(
          (line) => line.includes("warning") || line.includes("artifact"),
        ),
      ).toBe(true);
    });
  });

  test("destroy --hard without --keep-certs preserves existing -v behavior", async () => {
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec }));
    await driver.destroy(baseProfile, { hard: true });
    const down = calls.find((c) => c.cmd === "docker" && c.args.includes("down"));
    expect(down).toBeDefined();
    expect(down!.args).toContain("-v");
    // No explicit volume rm in the non-keep-certs path
    const volRmCalls = calls.filter(
      (c) => c.cmd === "docker" && c.args[0] === "volume" && c.args[1] === "rm",
    );
    expect(volRmCalls.length).toBe(0);
  });

  test("inspectCleanup proves only exact project-labelled resources are absent", async () => {
    const { exec, calls } = makeFakeExec((call) => {
      if (call.args[0] === "volume") {
        return {
          code: 0,
          stdout: "nautilo_caddy_data\nnautilo_caddy_config\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const driver = new ComposeDriver(makeDeps({ exec }));

    expect(await driver.inspectCleanup(baseProfile, true)).toEqual({
      containersAbsent: true,
      networksAbsent: true,
      dataVolumesAbsent: true,
      preservedCertificateVolumes: [
        "nautilo_caddy_data",
        "nautilo_caddy_config",
      ],
    });
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.args.includes(
      "label=com.docker.compose.project=nautilo",
    ))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // backup
  // -------------------------------------------------------------------------
  test("backup: writes timestamped sql.gz in the instance backups dir", async () => {
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const driver = new ComposeDriver(
      makeDeps({
        localExec: fakeLocalExec,
        now: () => new Date("2026-05-19T12:34:56.000Z"),
      }),
    );
    const target = await driver.backup(baseProfile);
    expect(target).toMatch(/20260519T123456Z\.sql\.gz$/);
    expect(target.startsWith(join(home, ".nautilo", "backups"))).toBe(true);
    expect(existsSync(join(home, ".nautilo", "backups"))).toBe(true);

    const sh = localExecCalls.find((c) => c.cmd === "sh");
    expect(sh).toBeDefined();
    expect(sh!.args.join(" ")).toContain("pg_dump");
    expect(sh!.args.join(" ")).toContain("gzip");
    expect(sh!.opts.env?.["DOCKER_HOST"]).toBeUndefined();
  });

  test("backup: local profile uses operator-side path without DOCKER_HOST", async () => {
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const driver = new ComposeDriver(
      makeDeps({
        localExec: fakeLocalExec,
        now: () => new Date("2026-05-19T12:34:56.000Z"),
      }),
    );
    const target = await driver.backup(baseProfile);
    expect(target.startsWith(join(home, ".nautilo", "backups"))).toBe(true);
    const sh = localExecCalls.find((c) => c.cmd === "sh");
    expect(sh).toBeDefined();
    expect(sh!.opts.env?.["DOCKER_HOST"]).toBeUndefined();
  });

  test("backup: remote profile writes to operator-side path with DOCKER_HOST", async () => {
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-droplet",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      instance_id: "prod",
      ssh: { host: "1.2.3.4", user: "root" },
    };
    const localExecCalls: ExecCall[] = [];
    const fakeLocalExec: ExecFn = async (cmd, args, opts) => {
      localExecCalls.push({ cmd, args, opts });
      return { code: 0, stdout: "", stderr: "" };
    };
    const driver = new ComposeDriver(
      makeDeps({
        localExec: fakeLocalExec,
        resolveInstanceRootDir: () => "/opt/nautilo-prod",
        now: () => new Date("2026-05-19T12:34:56.000Z"),
      }),
    );
    const target = await driver.backup(remoteProfile);
    expect(target).toMatch(/20260519T123456Z\.sql\.gz$/);
    expect(target.startsWith(join(home, ".nautilo-prod", "backups"))).toBe(true);
    expect(target.includes("/opt/nautilo")).toBe(false);

    const sh = localExecCalls.find((c) => c.cmd === "sh");
    expect(sh).toBeDefined();
    expect(sh!.opts.env?.["DOCKER_HOST"]).toBe("ssh://root@1.2.3.4");
    expect(sh!.args.join(" ")).toContain("pg_dump");
  });

  // -------------------------------------------------------------------------
  // restart + logs minimal smoke
  // -------------------------------------------------------------------------
  test("restart: keeps the default server-only restart unchanged", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRoot = mktmp("compose-driver-restart-default-");
    const serverOverlay = join(instanceRoot, "deploy.server-overlay.yml");
    writeFileSync(serverOverlay, "services: {}\n");
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => instanceRoot,
      }),
    );

    await driver.restart(baseProfile);

    const r = calls.find(
      (c) => c.cmd === "docker" && c.args.includes("restart"),
    );
    expect(r).toBeDefined();
    expect(r!.args).toContain("nautilo-server");
    expect(r!.args).not.toContain("up");
    expect(r!.args).not.toContain(serverOverlay);
  });

  test("restart --full: resumes local profiles with the persisted server Logto overlay", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRoot = mktmp("compose-driver-restart-full-");
    const instanceEnvPath = join(instanceRoot, "instance.env");
    const serverEnvPath = join(instanceRoot, "deploy.server.env");
    const serverOverlayPath = join(instanceRoot, "deploy.server-overlay.yml");
    writeFileSync(
      instanceEnvPath,
      [
        "LOGTO_ENDPOINT=https://auth.omega.example.com",
        "LOGTO_ISSUER=https://auth.omega.example.com/oidc",
        "LOGTO_JWKS_URI=https://auth.omega.example.com/oidc/jwks",
        "LOGTO_RESOURCE=https://api.omega.example.com",
        "LOGTO_M2M_APP_ID=omega-m2m",
        "LOGTO_M2M_APP_SECRET=omega-secret",
        "",
      ].join("\n"),
    );
    writeFileSync(
      serverEnvPath,
      "LOGTO_JWKS_URI=http://logto:3301/oidc/jwks\n",
    );
    writeFileSync(
      serverOverlayPath,
      [
        "services:",
        "  nautilo-server:",
        "    env_file:",
        `      - ${instanceEnvPath}`,
        `      - ${serverEnvPath}`,
        "",
      ].join("\n"),
    );
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => instanceRoot,
      }),
    );

    await driver.restart(baseProfile, { full: true });

    expect(calls).toHaveLength(2);
    const up = calls[0]!;
    const restart = calls[1]!;
    expect(up.cmd).toBe("docker");
    expect(up.args).toContain("--profile");
    expect(up.args).toContain("auth");
    expect(up.args).toContain("app");
    expect(up.args).toContain(serverOverlayPath);
    expect(up.args.slice(-7)).toEqual([
      "--profile",
      "auth",
      "--profile",
      "app",
      "up",
      "-d",
      "--no-build",
    ]);
    expect(restart.cmd).toBe("docker");
    expect(restart.args).toContain(serverOverlayPath);
    expect(restart.args.slice(-5)).toEqual([
      "restart",
      "app-postgres",
      "logto-postgres",
      "logto",
      "nautilo-server",
    ]);
    expect(restart.args).not.toContain("logto-seed");

    const overlayYml = readFileSync(serverOverlayPath, "utf8");
    expect(overlayYml).toContain(instanceEnvPath);
    expect(overlayYml).toContain(serverEnvPath);
    expect(overlayYml.indexOf(instanceEnvPath)).toBeLessThan(
      overlayYml.indexOf(serverEnvPath),
    );

    // Docker Compose evaluates env_file entries in order, so the no-build
    // recovery recreates nautilo-server with persisted Logto discovery and
    // client credentials; deploy.server.env only overrides container DNS.
    const serverEnv = {
      ...parseEnvFile(instanceEnvPath),
      ...parseEnvFile(serverEnvPath),
    };
    expect(serverEnv).toMatchObject({
      LOGTO_ENDPOINT: "https://auth.omega.example.com",
      LOGTO_ISSUER: "https://auth.omega.example.com/oidc",
      LOGTO_JWKS_URI: "http://logto:3301/oidc/jwks",
      LOGTO_RESOURCE: "https://api.omega.example.com",
      LOGTO_M2M_APP_ID: "omega-m2m",
      LOGTO_M2M_APP_SECRET: "omega-secret",
    });
    for (const call of calls) {
      expect(call.args).not.toContain("build");
      expect(call.args).not.toContain("pull");
      expect(call.args).not.toContain("migrate");
    }
  });

  test("restart --full: retains the persisted pinned registry image for both compose invocations", async () => {
    const { exec, calls } = makeFakeExec();
    const instanceRoot = mktmp("compose-driver-restart-full-registry-");
    const registryOverlayPath = join(instanceRoot, "deploy.registry-overlay.yml");
    writeFileSync(
      registryOverlayPath,
      [
        "services:",
        "  nautilo-server:",
        `    image: ${CANONICAL_IMAGE_REF}`,
        "",
      ].join("\n"),
    );
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => instanceRoot,
      }),
    );

    await driver.restart(
      {
        ...baseProfile,
        from_source: undefined,
        image_ref: CANONICAL_IMAGE_REF,
      },
      { full: true },
    );

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toContain(registryOverlayPath);
      expect(call.args).not.toContain("build");
      expect(call.args).not.toContain("pull");
    }
    expect(calls[0]!.args.slice(-3)).toEqual(["up", "-d", "--no-build"]);
    expect(calls[1]!.args.slice(-5)).toEqual([
      "restart",
      "app-postgres",
      "logto-postgres",
      "logto",
      "nautilo-server",
    ]);
    expect(calls[1]!.args).not.toContain("logto-seed");
  });

  test("restart --full: uses no-build up before all-service restart for source remote", async () => {
    const { exec, calls } = makeFakeExec();
    const remoteRoot = "/opt/nautilo";
    const stagingRoot = mktmp("compose-driver-restart-source-remote-");
    const serverOverlayPath = join(stagingRoot, "deploy.server-overlay.yml");
    writeFileSync(serverOverlayPath, "services: {}\n");
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
        fs: {
          ...nodeFs,
          syncToRemote: async () => {},
          toLocalStagingPath: (path: string) =>
            join(stagingRoot, path.slice(remoteRoot.length + 1)),
        } as ComposeDriverDeps["fs"],
      }),
    );

    await driver.restart(remoteComposeProfile, { full: true });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe("docker");
    expect(calls[0]!.args).toContain(serverOverlayPath);
    expect(calls[0]!.args.slice(-7)).toEqual([
      "--profile",
      "auth",
      "--profile",
      "app",
      "up",
      "-d",
      "--no-build",
    ]);
    expect(calls[1]!.cmd).toBe("docker");
    expect(calls[1]!.args).toContain(serverOverlayPath);
    expect(calls[1]!.args.slice(-5)).toEqual([
      "restart",
      "app-postgres",
      "logto-postgres",
      "logto",
      "nautilo-server",
    ]);
    expect(calls[1]!.args).not.toContain("logto-seed");
  });

  test("restart --full includes office in both compose invocations when enabled", async () => {
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec }));

    await driver.restart({ ...baseProfile, office: true }, { full: true });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args).toContain("--profile");
      expect(call.args).toContain("office");
    }
    expect(calls[1]!.args.slice(-7)).toEqual([
      "restart",
      "app-postgres",
      "logto-postgres",
      "logto",
      "nautilo-server",
      "office",
      "collabora",
    ]);
    expect(calls[1]!.args).not.toContain("logto-seed");
  });

  test("logs: passes -f through when follow=true", async () => {
    const { exec, calls } = makeFakeExec();
    const driver = new ComposeDriver(makeDeps({ exec }));
    await driver.logs(baseProfile, { follow: true, service: "logto" });
    const r = calls.find(
      (c) => c.cmd === "docker" && c.args.includes("logs"),
    );
    expect(r).toBeDefined();
    expect(r!.args).toContain("-f");
    expect(r!.args).toContain("logto");
  });

  test("release plan pulls the configured canonical registry digest directly", async () => {
    const logLines: string[] = [];
    const driver = new ComposeDriver(
      makeDeps({ log: (message) => logLines.push(message) }),
    );
    const internal = driver as unknown as {
      prepareReleaseArtifact: (
        profile: ComposeDriverProfile,
      ) => Promise<{ requested: string; immutableId: string }>;
      runReleaseDocker: (
        profile: ComposeDriverProfile,
        args: string[],
      ) => Promise<ExecResult>;
      inspectRemoteImageId: (image: string) => Promise<string>;
      inspectRemoteRepoDigest: (image: string) => Promise<string>;
      readRemoteImageAuthContract: (image: string) => Promise<ReturnType<typeof buildAuthContract>>;
    };
    const calls: string[][] = [];
    internal.runReleaseDocker = async (_profile, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    internal.inspectRemoteImageId = async () => "sha256:incoming";
    internal.inspectRemoteRepoDigest = async () => "ghcr.io/agentsea/nautilo-server@sha256:incoming";
    internal.readRemoteImageAuthContract = async () => buildAuthContract();
    const profile = {
      ...remoteRegistryProfile,
      image_ref: CANONICAL_IMAGE_REF,
    };

    const artifact = await internal.prepareReleaseArtifact(profile);

    expect(artifact.requested).toBe(CANONICAL_IMAGE_REF);
    expect(calls).toEqual([["pull", CANONICAL_IMAGE_REF]]);
    expect(logLines).toEqual([
      `release: pulling incoming remote image ${CANONICAL_IMAGE_REF}...`,
      `release: pulled incoming remote image ${CANONICAL_IMAGE_REF}`,
    ]);
  });

  test("release plan builds remote source artifacts through Docker-over-SSH Compose", async () => {
    const root = mktmp("remote-source-release-");
    const composeEnvPath = join(root, "deploy.compose.env");
    const oldSha = "a".repeat(40);
    const newSha = "b".repeat(40);
    writeFileSync(composeEnvPath, `COMPOSE_PROJECT_NAME=nautilo-remote\nNAUTILO_SOURCE_SHA=${oldSha}\n`, { mode: 0o600 });
    const driver = new ComposeDriver(makeDeps({
      resolveInstanceRootDir: () => root,
      resolveSourceBuildSha: async () => newSha,
    }));
    const internal = driver as unknown as {
      prepareReleaseArtifact: (
        profile: ComposeDriverProfile,
      ) => Promise<{ mode: string; immutableId: string }>;
      runCompose: (
        args: string[],
        opts: { stdio: "inherit" | "pipe" },
      ) => Promise<ExecResult>;
      runRemoteReleaseCompose: () => Promise<ExecResult>;
      inspectLocalImageId: (image: string) => Promise<string>;
      readLocalImageAuthContract: (image: string) => Promise<ReturnType<typeof buildAuthContract>>;
    };
    const calls: string[][] = [];
    internal.runCompose = async (args, opts) => {
      if (args.includes("build")) {
        expect(readFileSync(composeEnvPath, "utf8")).toContain(`NAUTILO_SOURCE_SHA=${newSha}`);
        expect(readFileSync(composeEnvPath, "utf8")).not.toContain(`NAUTILO_SOURCE_SHA=${oldSha}`);
      }
      calls.push(args);
      return {
        code: 0,
        stdout: opts.stdio === "pipe" ? "nautilo-server:local-dev\n" : "",
        stderr: "",
      };
    };
    internal.runRemoteReleaseCompose = async () => {
      throw new Error("remote Compose must not build operator source trees");
    };
    internal.inspectLocalImageId = async () => "sha256:source";
    internal.readLocalImageAuthContract = async () => buildAuthContract();

    const artifact = await internal.prepareReleaseArtifact({
      ...remoteComposeProfile,
      from_source: true,
    });

    expect(artifact).toMatchObject({ mode: "source", immutableId: "sha256:source" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.slice(-2)).toEqual(["build", "nautilo-server"]);
    expect(calls[0]?.some((arg) => arg.endsWith("/docker-compose.source.yml"))).toBe(true);
    expect(calls[1]).toContain("--profile");
    expect(calls[1]).toContain("auth");
    expect(calls[1]).toContain("app");
  });

  test("source release refreshes a local persisted SHA A to checkout SHA B", async () => {
    const root = mktmp("local-source-release-");
    const composeEnvPath = join(root, "deploy.compose.env");
    const oldSha = "1".repeat(40);
    const newSha = "2".repeat(40);
    writeFileSync(composeEnvPath, `COMPOSE_PROJECT_NAME=nautilo\nNAUTILO_SOURCE_SHA=${oldSha}\n`, { mode: 0o600 });
    const driver = new ComposeDriver(makeDeps({
      resolveInstanceRootDir: () => root,
      resolveSourceBuildSha: async () => newSha,
    }));
    const internal = driver as unknown as {
      refreshSourceBuildIdentity: (profile: ComposeDriverProfile) => Promise<string>;
    };

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().resolves`
    await expect(internal.refreshSourceBuildIdentity(baseProfile)).resolves.toBe(newSha);
    const refreshed = readFileSync(composeEnvPath, "utf8");
    expect(refreshed).toContain(`NAUTILO_SOURCE_SHA=${newSha}`);
    expect(refreshed).not.toContain(`NAUTILO_SOURCE_SHA=${oldSha}`);
  });

  test("remote source release stop uses Docker-over-SSH Compose", async () => {
    const remoteRoot = "/opt/nautilo";
    const { exec } = makeRemoteLifecycleExec(
      validRemoteManifest({
        remoteRoot,
        version: 2,
        image: { mode: "source", reference: "sha256:current-source" },
        contracts: {},
      }),
    );
    const driver = new ComposeDriver(
      makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }),
    );
    const internal = driver as unknown as {
      releaseServerAction: (
        profile: ComposeDriverProfile,
        action: "stop" | "start",
      ) => Promise<void>;
      runCompose: (
        args: string[],
        opts: { stdio: "inherit" | "pipe" },
      ) => Promise<ExecResult>;
      runRemoteReleaseCompose: () => Promise<ExecResult>;
    };
    const calls: string[][] = [];
    internal.runCompose = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    internal.runRemoteReleaseCompose = async () => {
      throw new Error("remote source actions must not use the target Compose CLI");
    };

    await internal.releaseServerAction(
      { ...remoteComposeProfile, from_source: true },
      "stop",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(-2)).toEqual(["stop", "nautilo-server"]);
  });

  test("release apply captures the registry digest from image inspection, not container inspection", async () => {
    const driver = new ComposeDriver(makeDeps());
    const internal = driver as unknown as {
      captureRunningServerArtifact: (
        profile: ComposeDriverProfile,
      ) => Promise<{ mode: string; requested: string; immutableId: string; repoDigest?: string }>;
      runReleaseDocker: (
        profile: ComposeDriverProfile,
        args: string[],
      ) => Promise<ExecResult>;
    };
    const calls: string[][] = [];
    internal.runReleaseDocker = async (_profile, args) => {
      calls.push(args);
      if (args[0] === "ps") return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "inspect") {
        return {
          code: 0,
          stdout: "sha256:running\nghcr.io/agentsea/nautilo-server:sha-old\n",
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: `ghcr.io/agentsea/nautilo-server@sha256:${"a".repeat(64)}\n`,
        stderr: "",
      };
    };

    const artifact = await internal.captureRunningServerArtifact(remoteRegistryProfile);

    expect(artifact).toEqual({
      mode: "registry",
      requested: "ghcr.io/agentsea/nautilo-server:sha-old",
      immutableId: "sha256:running",
      repoDigest: `ghcr.io/agentsea/nautilo-server@sha256:${"a".repeat(64)}`,
    });
    expect(calls[1]).not.toContain("RepoDigests");
    expect(calls[2]).toEqual([
      "image",
      "inspect",
      "--format",
      "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}",
      "ghcr.io/agentsea/nautilo-server:sha-old",
    ]);
  });

  test("immutable capture retains the requested namespace regardless of RepoDigests order", async () => {
    const requested = CANONICAL_IMAGE_REF;
    const legacy = requested.replace("nautilo-runtime-v2@", "nautilo-runtime@");
    const imageId = `sha256:${"f".repeat(64)}`; // Docker ID need not equal the requested index digest.
    for (const profile of [{ ...baseProfile, from_source: false }, remoteRegistryProfile]) {
      for (const repoDigests of [[legacy, requested], [requested, legacy]]) {
        const driver = new ComposeDriver(makeDeps());
        const internal = driver as unknown as {
          captureRunningServerArtifact: (profile: ComposeDriverProfile) => Promise<{ repoDigest?: string; immutableId: string }>;
          runReleaseDocker: (profile: ComposeDriverProfile, args: string[]) => Promise<ExecResult>;
        };
        internal.runReleaseDocker = async (_profile, args) => ({ code: 0, stderr: "", stdout:
          args[0] === "ps" ? "container\n" : args[0] === "inspect" ? `${imageId}\n${requested}\n` :
          JSON.stringify({ id: imageId, repoDigests }) });
        const captured = await internal.captureRunningServerArtifact(profile);
        expect(captured.repoDigest).toBe(requested);
        expect(captured.immutableId).toBe(imageId);
      }
    }
  });

  test("immutable capture refuses missing exact refs, platform substitutions, malformed inspection and mismatched image IDs", async () => {
    const requested = CANONICAL_IMAGE_REF; const imageId = `sha256:${"f".repeat(64)}`;
    const legacy = requested.replace("nautilo-runtime-v2@", "nautilo-runtime@");
    const child = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"e".repeat(64)}`;
    for (const inspected of [
      JSON.stringify({ id: imageId, repoDigests: [legacy] }),
      JSON.stringify({ id: imageId, repoDigests: [child] }),
      JSON.stringify({ id: `sha256:${"e".repeat(64)}`, repoDigests: [requested] }),
      JSON.stringify({ id: imageId, repoDigests: null }), "not-json",
    ]) {
      const driver = new ComposeDriver(makeDeps());
      const internal = driver as unknown as {
        captureRunningServerArtifact: (profile: ComposeDriverProfile) => Promise<unknown>;
        runReleaseDocker: (profile: ComposeDriverProfile, args: string[]) => Promise<ExecResult>;
      };
      internal.runReleaseDocker = async (_profile, args) => ({ code: 0, stderr: "", stdout:
        args[0] === "ps" ? "container\n" : args[0] === "inspect" ? `${imageId}\n${requested}\n` : inspected });
      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
      await expect(internal.captureRunningServerArtifact(remoteRegistryProfile)).rejects.toThrow(/identity/i);
    }
  });

  test("local and remote release preparation bind the requested pin to the inspected image ID", async () => {
    const requested = CANONICAL_IMAGE_REF; const imageId = `sha256:${"f".repeat(64)}`;
    for (const profile of [{ ...baseProfile, from_source: false, image_ref: requested }, remoteRegistryProfile]) {
      for (const mismatch of [false, true]) {
        const { exec, calls } = makeFakeExec(({ args }) => {
          const command = args.join(" ");
          if (command.includes("repoDigests")) return { code: 0, stderr: "", stdout: JSON.stringify({
            id: mismatch ? `sha256:${"e".repeat(64)}` : imageId,
            repoDigests: [requested.replace("nautilo-runtime-v2@", "nautilo-runtime@"), requested],
          }) };
          if (command.includes("{{.Id}}")) return { code: 0, stderr: "", stdout: imageId };
          return { code: 0, stderr: "", stdout: "" };
        });
        const driver = new ComposeDriver(makeDeps({ exec }));
        const internal = driver as unknown as {
          prepareReleaseArtifact: (profile: ComposeDriverProfile) => Promise<{ repoDigest: string; immutableId: string }>;
          readRemoteImageAuthContract: () => Promise<ReturnType<typeof buildAuthContract>>;
          readLocalImageAuthContract: () => Promise<ReturnType<typeof buildAuthContract>>;
        };
        internal.readRemoteImageAuthContract = async () => buildAuthContract();
        internal.readLocalImageAuthContract = async () => buildAuthContract();
        if (mismatch) {
          // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
          await expect(internal.prepareReleaseArtifact(profile)).rejects.toThrow(/exact requested digest and image ID/);
        } else {
          const artifact = await internal.prepareReleaseArtifact(profile);
          expect(artifact.repoDigest).toBe(requested); expect(artifact.immutableId).toBe(imageId);
        }
        expect(calls.some(call => call.args.join(" ").includes("repoDigests"))).toBeTrue();
        expect(calls.some(call => call.args.join(" ").includes("index .RepoDigests"))).toBeFalse();
      }
    }
  });

  test("release capture treats a synthetic local RepoDigest as a source image", async () => {
    const driver = new ComposeDriver(makeDeps());
    const internal = driver as unknown as {
      captureRunningServerArtifact: (
        profile: ComposeDriverProfile,
      ) => Promise<{ mode: string; requested: string; immutableId: string; repoDigest?: string }>;
      runReleaseDocker: (
        profile: ComposeDriverProfile,
        args: string[],
      ) => Promise<ExecResult>;
    };
    internal.runReleaseDocker = async (_profile, args) => {
      if (args[0] === "ps") {
        return { code: 0, stdout: "container-id\n", stderr: "" };
      }
      if (args[0] === "inspect") {
        return {
          code: 0,
          stdout: "sha256:source-image\nnautilo-server:local-dev\n",
          stderr: "",
        };
      }
      return {
        code: 0,
        stdout: `nautilo-server@sha256:${"a".repeat(64)}\n`,
        stderr: "",
      };
    };

    const artifact = await internal.captureRunningServerArtifact(remoteComposeProfile);

    expect(artifact).toEqual({
      mode: "source",
      requested: "nautilo-server:local-dev",
      immutableId: "sha256:source-image",
    });
  });

  // -------------------------------------------------------------------------
  // env-mutation discipline
  // -------------------------------------------------------------------------
  test("deploy: NAUTILO_INSTANCE_ID is restored after a successful deploy", async () => {
    process.env["NAUTILO_INSTANCE_ID"] = "previous";
    const driver = new ComposeDriver(
      makeDeps({
        readInstanceLogtoEnv: async () => ({}),
      }),
    );
    await driver.deploy(baseProfile);
    expect(process.env["NAUTILO_INSTANCE_ID"]).toBe("previous");
  });

  test("createComposeDriver accepts optional firstDeployConsume", () => {
    const templateDir = mktmp("compose-factory-");
    writeFileSync(join(templateDir, "docker-compose.yml"), "# factory test\n");
    const driver = createComposeDriver({
      templateDir,
      firstDeployConsume: async () => {},
    });
    expect(driver).toBeInstanceOf(ComposeDriver);
  });

  test("createComposeDriver passes its explicit operator home to bootstrap custody", () => {
    const templateDir = mktmp("compose-explicit-home-factory-");
    const operatorHome = mktmp("compose-explicit-home-");
    writeFileSync(join(templateDir, "docker-compose.yml"), "# factory test\n");
    let observedHome: string | undefined;
    const driver = createComposeDriver({
      templateDir,
      operatorHome,
      ensureBootstrapToken: (_profile, callbackHome) => {
        observedHome = callbackHome;
        return "factory-token";
      },
    });
    const internal = driver as unknown as {
      deps: { ensureBootstrapToken?: (profile: ComposeDriverProfile, callbackHome: string) => string };
    };

    internal.deps.ensureBootstrapToken?.(baseProfile, join(home, "wrong-home"));

    expect(observedHome).toBe(operatorHome);
  });

  test("deploy: happy path does not include deploy.workbench-overlay.yml", async () => {
    const { exec, calls } = makeFakeExec();
    const { fetch: fakeFetch } = makeFakeFetch(1);
    const instanceRootDir = join(home, ".nautilo");
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: fakeFetch,
        readInstanceLogtoEnv: async () => ({
          LOGTO_ENDPOINT: "http://localhost:3301",
          LOGTO_ISSUER: "http://localhost:3301/oidc",
          LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
          LOGTO_RESOURCE: "https://api.nautilo.local",
          LOGTO_M2M_APP_ID: "m2m-id",
          LOGTO_M2M_APP_SECRET: "m2m-secret",
          LOGTO_WORKBENCH_APP_ID: "wb",
        }),
        resolveInstanceRootDir: () => instanceRootDir,
      }),
    );
    await driver.deploy(baseProfile);
    for (const call of calls) {
      if (call.cmd === "docker") {
        expect(
          call.args.some((a) => a.includes("deploy.workbench-overlay.yml")),
        ).toBe(false);
      }
    }
    expect(existsSync(join(instanceRootDir, "deploy.workbench-overlay.yml"))).toBe(false);
  });

  test("deploy: NAUTILO_INSTANCE_ID is restored even when deploy throws", async () => {
    process.env["NAUTILO_INSTANCE_ID"] = "previous";
    const exec: ExecFn = async () => ({
      code: 1,
      stdout: "",
      stderr: "compose blew up",
    });
    const driver = new ComposeDriver(makeDeps({ exec }));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.deploy(baseProfile)).rejects.toThrow();
    expect(process.env["NAUTILO_INSTANCE_ID"]).toBe("previous");
  });

  // -------------------------------------------------------------------------
  // M207 Phase 2 — remote lifecycle (status / restart / logs)
  // -------------------------------------------------------------------------
  test("status (remote): reads manifest via cat, runs SSH-native compose ps, no DOCKER_HOST", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const logLines: string[] = [];
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        log: (msg) => logLines.push(msg),
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    const observation = await driver.status(remoteRegistryProfile);
    expect(observation.health).toBe("ready");

    const catCall = calls.find(
      (c) => c.cmd === "cat" && c.args.some((a) => a.includes("deployment-manifest.json")),
    );
    expect(catCall).toBeDefined();
    expect(catCall!.opts.env?.["DOCKER_HOST"]).toBeUndefined();

    const composeCall = calls.find(
      (c) => c.cmd === "sh" && c.args[0] === "-lc" && (c.args[1] ?? "").includes(" ps "),
    );
    expect(composeCall).toBeDefined();
    expectRemoteSshNativeInvocation(composeCall!, remoteRoot);
    expect((composeCall!.args[1] ?? "").includes("--profile auth")).toBe(false);
    expect(calls.filter((c) => c.cmd === "docker").length).toBe(0);
    expect(logLines.some((l) => l.includes("nautilo-nautilo-server"))).toBe(true);
  });

  test("status (remote): succeeds when HTTP API fetch fails and logs unavailable", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec } = makeRemoteLifecycleExec(manifest);
    const fetchMock = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const logLines: string[] = [];
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        fetch: fetchMock,
        log: (msg) => logLines.push(msg),
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    const observation = await driver.status(remoteRegistryProfile);
    expect(observation.health).toBe("unavailable");
    expect(logLines.some((l) => l.includes("status: HTTP API unavailable..."))).toBe(
      true,
    );
  });

  test("status (remote): works without local deploy env files", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.status(remoteRegistryProfile);

    expect(calls.some((c) => c.cmd === "docker")).toBe(false);
    const composeCall = calls.find(
      (c) => c.cmd === "sh" && (c.args[1] ?? "").includes("docker compose"),
    );
    expect(composeCall).toBeDefined();
    expect((composeCall!.args[1] ?? "").includes("deploy.compose.env")).toBe(true);
  });

  test("restart (remote): SSH-native compose restart with remote paths only", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.restart(remoteRegistryProfile);

    const composeCall = calls.find(
      (c) =>
        c.cmd === "sh" &&
        c.args[0] === "-lc" &&
        (c.args[1] ?? "").includes(" restart nautilo-server"),
    );
    expect(composeCall).toBeDefined();
    expectRemoteSshNativeInvocation(composeCall!, remoteRoot);
    expect((composeCall!.args[1] ?? "").includes("--profile auth")).toBe(false);
    expect(calls.filter((c) => c.cmd === "docker").length).toBe(0);
  });

  test("restart --full (remote): SSH-native no-build up precedes all-service restart", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.restart(remoteRegistryProfile, { full: true });

    const composeCalls = calls.filter(
      (c) => c.cmd === "sh" && c.args[0] === "-lc" && (c.args[1] ?? "").includes("docker compose"),
    );
    expect(composeCalls).toHaveLength(2);
    const upScript = composeCalls[0]!.args[1] ?? "";
    const restartScript = composeCalls[1]!.args[1] ?? "";
    expectRemoteSshNativeInvocation(composeCalls[0]!, remoteRoot);
    expectRemoteSshNativeInvocation(composeCalls[1]!, remoteRoot);
    expectRemoteDeployProfiles(upScript);
    expect(upScript).toContain(" up -d --no-build");
    expect(upScript).toContain(`${remoteRoot}/deploy.server-overlay.yml`);
    expect(restartScript).toContain(`${remoteRoot}/deploy.server-overlay.yml`);
    expect(restartScript).toMatch(
      / restart app-postgres logto-postgres logto nautilo-server$/,
    );
    expect(restartScript).not.toContain("logto-seed");
    expect(restartScript).not.toContain("restart nautilo-server");
    for (const script of [upScript, restartScript]) {
      expect(script).not.toContain(" build ");
      expect(script).not.toContain(" pull ");
      expect(script).not.toContain("migrate");
    }
    expect(calls.filter((c) => c.cmd === "docker")).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "sh")).toHaveLength(2);
  });

  test("logs (remote): SSH-native compose logs with follow and service", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({ remoteRoot });
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.logs(remoteRegistryProfile, {
      follow: true,
      service: "logto",
    });

    const composeCall = calls.find(
      (c) =>
        c.cmd === "sh" &&
        c.args[0] === "-lc" &&
        (c.args[1] ?? "").includes(" logs -f logto"),
    );
    expect(composeCall).toBeDefined();
    expectRemoteSshNativeInvocation(composeCall!, remoteRoot);
    expect((composeCall!.args[1] ?? "").includes("--profile auth")).toBe(false);
    expect(calls.filter((c) => c.cmd === "docker").length).toBe(0);
  });

  test("remote lifecycle: manifest identity mismatch fails before compose", async () => {
    const remoteRoot = "/opt/nautilo";
    const manifest = validRemoteManifest({
      remoteRoot,
      composeProjectName: "nautilo-staging",
    });
    let composeInvoked = false;
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      if (
        call.cmd === "sh" &&
        call.args[0] === "-lc" &&
        (call.args[1] ?? "").includes("docker compose")
      ) {
        composeInvoked = true;
      }
      return undefined;
    });
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(driver.status(remoteRegistryProfile)).rejects.toThrow(
      /composeProjectName: expected 'nautilo', got 'nautilo-staging'/,
    );
    expect(composeInvoked).toBe(false);
  });

  test("status (remote): letsencrypt manifest includes caddy overlay in compose script", async () => {
    const remoteRoot = "/opt/nautilo-prod";
    const manifest = validRemoteManifest({
      remoteRoot,
      instanceId: "prod",
      composeProjectName: "nautilo-prod",
      https: "letsencrypt",
    });
    const profile: ComposeDriverProfile = {
      ...remoteRegistryProfile,
      instance_id: "prod",
    };
    const { exec, calls } = makeRemoteLifecycleExec(manifest);
    const driver = new ComposeDriver(
      makeDeps({
        exec,
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );

    await driver.status(profile);

    const composeCall = calls.find(
      (c) => c.cmd === "sh" && (c.args[1] ?? "").includes("docker compose"),
    );
    expect((composeCall!.args[1] ?? "").includes("deploy.caddy-overlay.yml")).toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // Remote deployment-manifest transition + commit invariants
  // -------------------------------------------------------------------------
  describe("remote deployment-manifest transitions", () => {
    test("deploy: source manifest registry day-two materializes host-canonical inputs without operator staging", async () => {
      const remoteRoot = "/opt/nautilo";
      const operatorRoot = mktmp("source-manifest-operator-");
      const remoteInstanceEnv = [
        "LOGTO_ENDPOINT=http://198.51.100.2:3301",
        "LOGTO_ISSUER=http://198.51.100.2:3301/oidc",
        "LOGTO_JWKS_URI=http://198.51.100.2:3301/oidc/jwks",
        "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET=remote-canonical",
        "",
      ].join("\n");
      const manifest: RemoteDeploymentManifest = {
        ...validRemoteManifest({ remoteRoot }),
        version: 2,
        image: { mode: "source", reference: "nautilo-server:running-source" },
        contracts: {},
      };
      const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
        if (
          call.cmd === "cat" &&
          call.args[0] === `${remoteRoot}/runtime-config/instance.env`
        ) {
          return { code: 0, stdout: remoteInstanceEnv, stderr: "" };
        }
        return undefined;
      });
      const driver = new ComposeDriver(
        makeDeps({
          exec,
          resolveInstanceRootDir: () => remoteRoot,
          resolveLocalInstanceRootDir: () => operatorRoot,
          fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        }),
      );

      await driver.deploy({ ...remoteRegistryProfile, tag: "sha-cutover" });

      expect(existsSync(join(operatorRoot, "instance.env"))).toBe(false);
      const hostCanonicalWrite = calls.find(
        (call) =>
          call.cmd === "sh" &&
          extractRemoteFileWrites(call.args[1] ?? "").some(
            (written) => written.path === `${remoteRoot}/deploy.server-overlay.yml`,
          ),
      );
      expect(hostCanonicalWrite).toBeDefined();
      const hostCanonicalFiles = extractRemoteFileWrites(
        hostCanonicalWrite!.args[1] ?? "",
      );
      const overlayWrite = hostCanonicalFiles.find(
        (written) => written.path === `${remoteRoot}/deploy.server-overlay.yml`,
      )!;
      const serverEnvWrite = hostCanonicalFiles.find(
        (written) => written.path === `${remoteRoot}/deploy.server.env`,
      )!;
      expect(overlayWrite.contents).toContain(`${remoteRoot}/runtime-config/instance.env`);
      expect(overlayWrite.contents).toContain(`${remoteRoot}/deploy.server.env`);
      expect(serverEnvWrite.contents).toContain(
        "LOGTO_JWKS_URI=http://logto:6301/oidc/jwks",
      );
      expect(serverEnvWrite.contents).not.toContain(
        "LOGTO_JWKS_URI=http://logto:3301/oidc/jwks",
      );
      expect(hostCanonicalFiles.some((written) => written.path === `${remoteRoot}/postgres-init.sh`)).toBe(true);
      expect(
        hostCanonicalFiles.some(
          (written) => written.path === `${remoteRoot}/deploy.volumes-overlay.yml`,
        ),
      ).toBe(true);
      expect(
        calls.some(
          (call) =>
            call.cmd === "sh" &&
            (call.args[1] ?? "").includes(" up -d") &&
            calls.indexOf(call) > calls.indexOf(hostCanonicalWrite!),
        ),
      ).toBe(true);
    });

    test("deploy: remote day-two refreshes the server JWKS port after Logto reconciliation", async () => {
      const remoteRoot = "/opt/nautilo";
      const remoteInstanceEnv = [
        "LOGTO_ENDPOINT=https://auth.alpha.example.test",
        "LOGTO_ISSUER=https://auth.alpha.example.test/oidc",
        "LOGTO_JWKS_URI=https://auth.alpha.example.test/oidc/jwks",
        "",
      ].join("\n");
      const manifest: RemoteDeploymentManifest = {
        ...validRemoteManifest({ remoteRoot }),
        version: 2,
        image: { mode: "source", reference: "nautilo-server:running-source" },
        contracts: {},
      };
      let runtimeInspections = 0;
      const generatedServerEnvs: string[] = [];
      const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
        const script = call.args[1] ?? "";
        if (
          call.cmd === "cat" &&
          call.args[0] === `${remoteRoot}/runtime-config/instance.env`
        ) {
          return { code: 0, stdout: remoteInstanceEnv, stderr: "" };
        }
        if (
          call.cmd === "sh" &&
          script.includes("find_one logto") &&
          script.includes("logto_core=")
        ) {
          runtimeInspections += 1;
          const corePort = runtimeInspections === 1 ? 4001 : 5901;
          return {
            code: 0,
            stdout:
              `logto_core_container=${corePort}\n` +
              `logto_core=${corePort}\n` +
              `logto_admin=${corePort + 1}\n` +
              "logto_db=5432\n",
            stderr: "",
          };
        }
        if (call.cmd === "sh" && script.includes("deploy.server.env")) {
          const write = extractRemoteFileWrites(script).find(
            (candidate) => candidate.path === `${remoteRoot}/deploy.server.env`,
          );
          if (write !== undefined) generatedServerEnvs.push(write.contents);
        }
        return undefined;
      });
      const driver = new ComposeDriver(
        makeDeps({
          exec,
          resolveInstanceRootDir: () => remoteRoot,
          fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        }),
      );

      await driver.deploy({ ...remoteRegistryProfile, tag: "sha-cutover" });

      expect(runtimeInspections).toBe(2);
      expect(generatedServerEnvs[0]).toContain(
        "LOGTO_JWKS_URI=http://logto:4001/oidc/jwks",
      );
      expect(generatedServerEnvs.at(-1)).toContain(
        "LOGTO_JWKS_URI=http://logto:5901/oidc/jwks",
      );
      const finalOverlayWriteIndex = calls.map(
        (call) =>
          call.cmd === "sh" &&
          extractRemoteFileWrites(call.args[1] ?? "").some(
            (write) => write.path === `${remoteRoot}/deploy.server.env`,
          ),
      ).lastIndexOf(true);
      const serverRecreateIndex = calls.findIndex(
        (call, index) =>
          index > finalOverlayWriteIndex &&
          call.cmd === "sh" &&
          (call.args[1] ?? "").includes(" up -d") &&
          (call.args[1] ?? "").includes("--force-recreate") &&
          (call.args[1] ?? "").includes("--no-deps") &&
          (call.args[1] ?? "").includes(" nautilo-server"),
      );
      expect(serverRecreateIndex).toBeGreaterThan(finalOverlayWriteIndex);
    });

    test("releaseApply: source to registry uses host-canonical files and commits registry mode only after health", async () => {
      const remoteRoot = "/opt/nautilo";
      const operatorRoot = mktmp("release-cutover-operator-");
      const remoteInstanceEnv = "LOGTO_ENDPOINT=http://10.0.0.2:3301\n";
      const repoDigest = `ghcr.io/agentsea/nautilo-server@sha256:${"c".repeat(64)}`;
      let manifestJson = JSON.stringify({
        ...validRemoteManifest({ remoteRoot }),
        version: 2,
        image: { mode: "source", reference: "nautilo-server:legacy" },
        contracts: {},
      } satisfies RemoteDeploymentManifest);
      const events: string[] = [];
      const composeScripts: string[] = [];
      const { exec } = makeFakeExec((call) => {
        const script = call.args[1] ?? "";
        if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
          return { code: 0, stdout: `${manifestJson}\n`, stderr: "" };
        }
        if (
          call.cmd === "cat" &&
          call.args[0] === `${remoteRoot}/runtime-config/instance.env`
        ) {
          return { code: 0, stdout: remoteInstanceEnv, stderr: "" };
        }
        if (
          call.cmd === "sh" &&
          script.includes("find_one logto") &&
          script.includes("logto_core=")
        ) {
          return {
            code: 0,
            stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
            stderr: "",
          };
        }
        const releaseInspect = mockReleaseDockerInspectScriptResponse(script, { repoDigest });
        if (releaseInspect !== undefined) return releaseInspect;
        if (call.cmd === "sh" && script.includes("printf %s")) {
          if (
            extractRemoteFileWrites(script).some(
              (write) => write.path === `${remoteRoot}/docker-compose.yml`,
            )
          ) {
            events.push("template-refresh");
          }
          if (script.includes("deployment-manifest.json")) {
            events.push("manifest-commit");
            const write = extractRemoteFileWrites(script)[0];
            if (write) manifestJson = write.contents;
          }
          if (script.includes("deploy.server-overlay.yml")) events.push("host-canonical");
        }
        if (call.cmd === "sh" && script.includes("docker compose")) {
          composeScripts.push(script);
          if (script.includes(" stop nautilo-server")) events.push("stop");
        }
        if (call.cmd === "sh" && script.includes(" up -d --no-build --no-deps nautilo-server")) {
          events.push("release-up");
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(
        makeDeps({
          exec,
          resolveInstanceRootDir: () => remoteRoot,
          resolveLocalInstanceRootDir: () => operatorRoot,
          fetch: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
        }),
      );
      const internal = driver as unknown as {
        releasePlan: () => Promise<{
          artifact: {
            mode: "registry";
            requested: string;
            immutableId: string;
            repoDigest: string;
          };
          auth: { classification: string };
          compatible: boolean;
          limitations: readonly string[];
        }>;
        assertArtifactVolumePresentOrMigrated: () => Promise<void>;
        backup: (_profile: ComposeDriverProfile, opts: { toPath?: string }) => Promise<string>;
        checkServerHealth: () => Promise<void>;
      };
      internal.releasePlan = async () => ({
        artifact: {
          mode: "registry",
          requested: CANONICAL_IMAGE_REF,
          immutableId: "sha256:incoming",
          repoDigest,
        },
        auth: { classification: "compatible" },
        compatible: true,
        limitations: [],
      });
      internal.assertArtifactVolumePresentOrMigrated = async () => {};
      internal.backup = async (_profile, opts) => {
        events.push("backup");
        return opts?.toPath ?? "";
      };
      internal.checkServerHealth = async () => {};

      await driver.releaseApply({ ...remoteRegistryProfile, tag: "incoming" });

      expect(existsSync(join(operatorRoot, "instance.env"))).toBe(false);
      expect(events.indexOf("host-canonical")).toBeLessThan(events.indexOf("stop"));
      expect(events.indexOf("stop")).toBeLessThan(events.indexOf("backup"));
      expect(events.lastIndexOf("template-refresh")).toBeGreaterThan(
        events.indexOf("backup"),
      );
      expect(events.lastIndexOf("template-refresh")).toBeLessThan(
        events.indexOf("release-up"),
      );
      expect(events.indexOf("release-up")).toBeLessThan(events.indexOf("manifest-commit"));
      const stop = composeScripts.find((script) => script.includes(" stop nautilo-server"));
      expect(stop).toBeDefined();
      expect(stop).not.toContain("deploy.registry-overlay.yml");
      const committed = JSON.parse(manifestJson) as RemoteDeploymentManifest;
      expect(committed.image).toEqual({
        mode: "registry",
        reference: CANONICAL_IMAGE_REF,
      });
    });

    test("releaseApply: image to source commits source mode after health", async () => {
      const remoteRoot = "/opt/nautilo";
      const immutableId = "sha256:incoming-source";
      let manifestJson = JSON.stringify(validRemoteManifest({ remoteRoot }));
      const events: string[] = [];
      const { exec } = makeFakeExec((call) => {
        const script = call.args[1] ?? "";
        if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
          return { code: 0, stdout: `${manifestJson}\n`, stderr: "" };
        }
        const releaseInspect = mockReleaseDockerInspectScriptResponse(script, {
          requested: "compose-source",
          immutableId: "sha256:restored-source",
        });
        if (releaseInspect !== undefined) {
          if (script.includes("image inspect")) {
            return { code: 0, stdout: "\n", stderr: "" };
          }
          return releaseInspect;
        }
        if (call.cmd === "sh" && script.includes("deployment-manifest.json")) {
          events.push("manifest-commit");
          const write = extractRemoteFileWrites(script)[0];
          if (write) manifestJson = write.contents;
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }));
      const internal = driver as unknown as {
        releasePlan: () => Promise<{
          artifact: {
            mode: "source";
            requested: string;
            immutableId: string;
          };
          auth: { classification: string };
          compatible: boolean;
          limitations: readonly string[];
        }>;
        assertArtifactVolumePresentOrMigrated: () => Promise<void>;
        releaseServerAction: () => Promise<void>;
        backup: (_profile: ComposeDriverProfile, opts: { toPath?: string }) => Promise<string>;
        releaseServerUp: () => Promise<void>;
        checkServerHealth: () => Promise<void>;
      };
      internal.releasePlan = async () => ({
        artifact: {
          mode: "source",
          requested: "compose-source",
          immutableId,
        },
        auth: { classification: "compatible" },
        compatible: true,
        limitations: [],
      });
      internal.assertArtifactVolumePresentOrMigrated = async () => {};
      internal.releaseServerAction = async () => {};
      internal.backup = async (_profile, opts) => opts?.toPath ?? "";
      internal.releaseServerUp = async () => {};
      internal.checkServerHealth = async () => {};

      await driver.releaseApply({ ...remoteComposeProfile, from_source: true });

      expect(events).toEqual(["manifest-commit"]);
      const committed = JSON.parse(manifestJson) as RemoteDeploymentManifest;
      expect(committed.image).toEqual({ mode: "source", reference: immutableId });
    });

    test("source manifest commit ignores synthetic repo digests and uses immutable image ID", async () => {
      const remoteRoot = "/opt/nautilo";
      let manifestJson = JSON.stringify(validRemoteManifest({ remoteRoot }));
      const { exec } = makeFakeExec((call) => {
        const script = call.args[1] ?? "";
        if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
          return { code: 0, stdout: `${manifestJson}\n`, stderr: "" };
        }
        if (call.cmd === "sh" && script.includes("deployment-manifest.json")) {
          const write = extractRemoteFileWrites(script)[0];
          if (write) manifestJson = write.contents;
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(
        makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }),
      );
      const internal = driver as unknown as {
        commitRemoteDeploymentManifestArtifact: (
          profile: ComposeDriverProfile,
          artifact: {
            mode: "source";
            requested: string;
            immutableId: string;
            repoDigest: string;
          },
        ) => Promise<void>;
      };

      await internal.commitRemoteDeploymentManifestArtifact(
        remoteComposeProfile,
        {
          mode: "source",
          requested: "compose-source",
          immutableId: "sha256:source-image-id",
          repoDigest: "nautilo-server@sha256:synthetic",
        },
      );

      const committed = JSON.parse(manifestJson) as RemoteDeploymentManifest;
      expect(committed.image).toEqual({
        mode: "source",
        reference: "sha256:source-image-id",
      });
    });

    test("manifest commit refuses an empty source identity before writing", async () => {
      const remoteRoot = "/opt/nautilo";
      const manifest = validRemoteManifest({ remoteRoot });
      const { exec, calls } = makeRemoteLifecycleExec(manifest);
      const driver = new ComposeDriver(
        makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }),
      );
      const internal = driver as unknown as {
        commitRemoteDeploymentManifestArtifact: (
          profile: ComposeDriverProfile,
          artifact: {
            mode: "source";
            requested: string;
            immutableId: string;
          },
        ) => Promise<void>;
      };

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
      await expect(
        internal.commitRemoteDeploymentManifestArtifact(remoteComposeProfile, {
          mode: "source",
          requested: "compose-source",
          immutableId: "",
        }),
      ).rejects.toThrow(/source artifact identity is empty/);
      expect(
        calls.some(
          (call) =>
            call.cmd === "sh" &&
            (call.args[1] ?? "").includes("deployment-manifest.json"),
        ),
      ).toBe(false);
    });

    test("releaseApply: legacy-adopted image upgrade refreshes server overlay from live remote ports", async () => {
      const remoteRoot = "/opt/nautilo";
      const incomingDigest = `ghcr.io/agentsea/nautilo-server@sha256:${"9".repeat(64)}`;
      let manifestJson = JSON.stringify({
        ...validRemoteManifest({ remoteRoot }),
        version: 2,
        contracts: { legacyAdopted: true },
      } satisfies RemoteDeploymentManifest);
      const events: string[] = [];
      let regeneratedServerEnv = "";
      const { exec } = makeFakeExec((call) => {
        const script = call.args[1] ?? "";
        if (call.cmd === "cat" && call.args[0]?.endsWith("deployment-manifest.json")) {
          return { code: 0, stdout: `${manifestJson}\n`, stderr: "" };
        }
        if (
          call.cmd === "cat" &&
          call.args[0] === `${remoteRoot}/runtime-config/instance.env`
        ) {
          return {
            code: 0,
            stdout:
              "LOGTO_ENDPOINT=https://auth.beta.example.test\n" +
              "LOGTO_ISSUER=https://auth.beta.example.test/oidc\n" +
              "LOGTO_JWKS_URI=https://auth.beta.example.test/oidc/jwks\n",
            stderr: "",
          };
        }
        if (
          call.cmd === "sh" &&
          script.includes("find_one logto") &&
          script.includes("logto_core=")
        ) {
          return {
            code: 0,
            stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
            stderr: "",
          };
        }
        const releaseInspect = mockReleaseDockerInspectScriptResponse(script, {
          repoDigest: incomingDigest,
        });
        if (releaseInspect !== undefined) return releaseInspect;
        if (call.cmd === "sh" && script.includes("deploy.server.env")) {
          const serverEnvWrite = extractRemoteFileWrites(script).find(
            (written) => written.path === `${remoteRoot}/deploy.server.env`,
          );
          if (serverEnvWrite !== undefined) {
            events.push("host-canonical");
            regeneratedServerEnv = serverEnvWrite.contents;
          }
        }
        if (call.cmd === "sh" && script.includes("deployment-manifest.json")) {
          events.push("manifest-commit");
          const write = extractRemoteFileWrites(script)[0];
          if (write) manifestJson = write.contents;
        }
        return { code: 0, stdout: "", stderr: "" };
      });
      const driver = new ComposeDriver(makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }));
      const internal = driver as unknown as {
        releasePlan: () => Promise<{
          artifact: {
            mode: "registry";
            requested: string;
            immutableId: string;
            repoDigest: string;
          };
          auth: { classification: string };
          compatible: boolean;
          limitations: readonly string[];
        }>;
        assertArtifactVolumePresentOrMigrated: () => Promise<void>;
        releaseServerAction: () => Promise<void>;
        backup: (_profile: ComposeDriverProfile, opts: { toPath?: string }) => Promise<string>;
        releaseServerUp: () => Promise<void>;
        checkServerHealth: () => Promise<void>;
      };
      internal.releasePlan = async () => ({
        artifact: {
          mode: "registry",
          requested: CANONICAL_IMAGE_REF,
          immutableId: "sha256:incoming",
          repoDigest: incomingDigest,
        },
        auth: { classification: "compatible" },
        compatible: true,
        limitations: [],
      });
      internal.assertArtifactVolumePresentOrMigrated = async () => {};
      internal.releaseServerAction = async () => {};
      internal.backup = async (_profile, opts) => opts?.toPath ?? "";
      internal.releaseServerUp = async () => {};
      internal.checkServerHealth = async () => {};

      await driver.releaseApply({ ...remoteRegistryProfile, tag: "incoming" });

      expect(events).toEqual(["host-canonical", "manifest-commit"]);
      expect(regeneratedServerEnv).toContain(
        "LOGTO_JWKS_URI=http://logto:6301/oidc/jwks",
      );
      expect(regeneratedServerEnv).not.toContain(
        "LOGTO_JWKS_URI=http://logto:3301/oidc/jwks",
      );
      const committed = JSON.parse(manifestJson) as RemoteDeploymentManifest;
      expect(committed.image).toEqual({
        mode: "registry",
        reference: CANONICAL_IMAGE_REF,
      });
    });

    test("releaseApply: source cutover backup failure restarts prior source without registry overlay", async () => {
      const remoteRoot = "/opt/nautilo";
      const remoteInstanceEnv = "LOGTO_ENDPOINT=http://10.0.0.2:3301\n";
      const manifest: RemoteDeploymentManifest = {
        ...validRemoteManifest({ remoteRoot }),
        version: 2,
        image: { mode: "source", reference: "sha256:current-source" },
        contracts: {},
      };
      const events: string[] = [];
      const composeScripts: string[] = [];
      const { exec, calls } = makeRemoteLifecycleExec(manifest, (call) => {
        const script = call.args[1] ?? "";
        if (
          call.cmd === "cat" &&
          call.args[0] === `${remoteRoot}/runtime-config/instance.env`
        ) {
          return { code: 0, stdout: remoteInstanceEnv, stderr: "" };
        }
        if (
          call.cmd === "sh" &&
          script.includes("find_one logto") &&
          script.includes("logto_core=")
        ) {
          return {
            code: 0,
            stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
            stderr: "",
          };
        }
        if (call.cmd === "sh" && script.includes("printf %s")) {
          const writes = extractRemoteFileWrites(script);
          if (writes.some((write) => write.path.endsWith("deploy.server-overlay.yml"))) {
            events.push("canonicalize");
          }
        }
        if (call.cmd === "sh" && script.includes("docker compose")) {
          composeScripts.push(script);
          if (script.includes(" stop nautilo-server")) events.push("stop");
          if (script.includes(" start nautilo-server")) events.push("restart");
        }
        return undefined;
      });
      const driver = new ComposeDriver(
        makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }),
      );
      const internal = driver as unknown as {
        releasePlan: () => Promise<{
          artifact: {
            mode: "registry";
            requested: string;
            immutableId: string;
          };
          auth: { classification: string };
          compatible: boolean;
          limitations: readonly string[];
        }>;
        assertArtifactVolumePresentOrMigrated: () => Promise<void>;
        backup: () => Promise<string>;
        checkServerHealth: () => Promise<void>;
      };
      internal.releasePlan = async () => ({
        artifact: {
          mode: "registry",
          requested: CANONICAL_IMAGE_REF,
          immutableId: "sha256:incoming",
        },
        auth: { classification: "compatible" },
        compatible: true,
        limitations: [],
      });
      internal.assertArtifactVolumePresentOrMigrated = async () => {};
      internal.backup = async () => {
        events.push("backup");
        throw new Error("snapshot failed");
      };
      internal.checkServerHealth = async () => {};

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
      await expect(
        driver.releaseApply({ ...remoteRegistryProfile, tag: "incoming" }),
      ).rejects.toThrow(/old server restarted.*post-restart health = ready/);

      expect(events).toEqual(["canonicalize", "stop", "backup", "restart"]);
      const stopAndRestart = composeScripts.filter(
        (script) =>
          script.includes(" stop nautilo-server") ||
          script.includes(" start nautilo-server"),
      );
      expect(stopAndRestart).toHaveLength(2);
      expect(
        stopAndRestart.every(
          (script) => !script.includes("deploy.registry-overlay.yml"),
        ),
      ).toBe(true);
      expect(
        calls
          .flatMap((call) => extractRemoteFileWrites(call.args[1] ?? ""))
          .some((write) => write.path.endsWith("deploy.registry-overlay.yml")),
      ).toBe(false);
    });

    test("releaseApply: manifest commit failure triggers full-bundle rollback", async () => {
      const remoteRoot = "/opt/nautilo";
      const { exec } = makeRemoteLifecycleExec(validRemoteManifest({ remoteRoot }));
      const driver = new ComposeDriver(
        makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }),
      );
      const events: string[] = [];
      const internal = driver as unknown as {
        releasePlan: () => Promise<{
          artifact: {
            mode: "registry";
            requested: string;
            immutableId: string;
          };
          auth: { classification: string };
          compatible: boolean;
          limitations: readonly string[];
        }>;
        assertArtifactVolumePresentOrMigrated: () => Promise<void>;
        releaseServerAction: () => Promise<void>;
        backup: (_profile: ComposeDriverProfile, opts: { toPath?: string }) => Promise<string>;
        releaseServerUp: () => Promise<void>;
        checkServerHealth: () => Promise<void>;
        commitRemoteDeploymentManifestArtifact: () => Promise<void>;
        restore: () => Promise<void>;
      };
      internal.releasePlan = async () => ({
        artifact: {
          mode: "registry",
          requested: CANONICAL_IMAGE_REF,
          immutableId: "sha256:incoming",
        },
        auth: { classification: "compatible" },
        compatible: true,
        limitations: [],
      });
      internal.assertArtifactVolumePresentOrMigrated = async () => {};
      internal.releaseServerAction = async () => {};
      internal.backup = async (_profile, opts) => opts?.toPath ?? "";
      internal.releaseServerUp = async () => {};
      internal.checkServerHealth = async () => {
        events.push("health");
      };
      internal.commitRemoteDeploymentManifestArtifact = async () => {
        events.push("manifest-commit");
        throw new Error("manifest disk full");
      };
      internal.restore = async () => {
        events.push("restore");
      };

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
      await expect(
        driver.releaseApply({ ...remoteRegistryProfile, tag: "incoming" }),
      ).rejects.toThrow(
        /full-bundle rollback succeeded.*post-rollback health = ready.*manifest disk full/,
      );
      expect(events).toEqual([
        "health",
        "manifest-commit",
        "restore",
        "health",
      ]);
    });

    test("releaseApply: failed health does not commit incoming registry mode", async () => {
      const remoteRoot = "/opt/nautilo";
      let manifestWrites = 0;
      const manifest = validRemoteManifest({
        remoteRoot,
        version: 2,
        image: { mode: "source", reference: "nautilo-server:legacy" },
        contracts: {},
      });
      const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
        if (
          call.cmd === "cat" &&
          call.args[0] === `${remoteRoot}/runtime-config/instance.env`
        ) {
          return {
            code: 0,
            stdout: "LOGTO_ENDPOINT=http://10.0.0.2:3301\n",
            stderr: "",
          };
        }
        if (call.cmd === "sh" && (call.args[1] ?? "").includes("deployment-manifest.json")) {
          manifestWrites += 1;
        }
        return undefined;
      });
      const driver = new ComposeDriver(makeDeps({ exec, resolveInstanceRootDir: () => remoteRoot }));
      const internal = driver as unknown as {
        releasePlan: () => Promise<{
          artifact: {
            mode: "registry";
            requested: string;
            immutableId: string;
            repoDigest: string;
          };
          auth: { classification: string };
          compatible: boolean;
          limitations: readonly string[];
        }>;
        assertArtifactVolumePresentOrMigrated: () => Promise<void>;
        releaseServerAction: () => Promise<void>;
        backup: (_profile: ComposeDriverProfile, opts: { toPath?: string }) => Promise<string>;
        releaseServerUp: () => Promise<void>;
        checkServerHealth: () => Promise<void>;
        restore: () => Promise<void>;
      };
      internal.releasePlan = async () => ({
        artifact: {
          mode: "registry",
          requested: CANONICAL_IMAGE_REF,
          immutableId: "sha256:incoming",
          repoDigest: `ghcr.io/agentsea/nautilo-server@sha256:${"a".repeat(64)}`,
        },
        auth: { classification: "compatible" },
        compatible: true,
        limitations: [],
      });
      internal.assertArtifactVolumePresentOrMigrated = async () => {};
      internal.releaseServerAction = async () => {};
      internal.backup = async (_profile, opts) => opts?.toPath ?? "";
      internal.releaseServerUp = async () => {};
      let healthCalls = 0;
      internal.checkServerHealth = async () => {
        healthCalls += 1;
        if (healthCalls === 1) {
          throw new Error("incoming not ready");
        }
      };
      internal.restore = async () => {};

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
      await expect(
        driver.releaseApply({ ...remoteRegistryProfile, tag: "incoming" }),
      ).rejects.toThrow(/full-bundle rollback succeeded/);
      expect(manifestWrites).toBe(0);
    });
  });
});
