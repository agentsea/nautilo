import { artifactsRelocateModule } from "../../src/commands/artifacts-relocate.ts";
import { relocationPlanSha256, type ArtifactRelocationPlan } from "@nautilo/compose-driver";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";

import type { ComposeDriver } from "@nautilo/compose-driver";
import { resetConfigGuardRateLimitForTests } from "@nautilo/config-guard";
import {
  deriveComposeContainerBundle,
  InstanceJsonSchema,
  __resetResolvedInstanceForTests,
  type InstanceJson,
} from "@nautilo/config";

import { deployModule } from "../../src/commands/deploy.ts";
import { releaseModule } from "../../src/commands/release.ts";
import { restartModule } from "../../src/commands/restart.ts";
import { logsModule } from "../../src/commands/logs.ts";
import { upgradeModule } from "../../src/commands/upgrade.ts";
import { backupModule } from "../../src/commands/backup.ts";
import { restoreModule } from "../../src/commands/restore.ts";
import { destroyModule } from "../../src/commands/destroy.ts";
import { migrateArtifactsToVolumeModule } from "../../src/commands/migrate-artifacts-to-volume.ts";
import { migrateMediaToVolumeModule } from "../../src/commands/migrate-media-to-volume.ts";
import { statusModule } from "../../src/commands/status.ts";
import { authModule } from "../../src/commands/auth.ts";
import {
  buildFirstDeployProviderConsumeHook,
  resolveDeployConfigForCompose,
  setComposeDriverFactoryForTests,
  type FactoryOptions,
} from "../../src/lib/compose-driver-factory.ts";
import { setCliProfileFlagOverride } from "../../src/lib/profile-aware-server.ts";
import { runComposeVerb } from "../../src/lib/run-compose-verb.ts";
import {
  setComposeOwnerClaimDependenciesForTests,
} from "../../src/lib/compose-owner-claim.ts";
import { KeyringComposeOwnerClaimStore } from "../../src/lib/compose-owner-claim-store.ts";
import { setStableRuntimeImageResolverForTests } from "../../src/lib/stable-runtime-image.ts";

const tmpDirs: string[] = [];
const STABLE_IMAGE = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"7".repeat(64)}`;
let prevHome: string | undefined;
let prevDotenv: string | undefined;

function trackTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nautilo-compose-cli-"));
  tmpDirs.push(d);
  return d;
}

function writeLocalComposeProfile(home: string, name: string): void {
  const profilesDir = join(home, ".nautilo", "profiles");
  mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(profilesDir, `${name}.toml`),
    `name = "${name}"
transport = "local"
lifecycle = "compose"
from_source = true
`,
    { mode: 0o600 },
  );
  writeFileSync(join(profilesDir, ".active"), `${name}\n`, { mode: 0o600 });
}

function writeExternalLocalProfile(home: string, name: string): void {
  const profilesDir = join(home, ".nautilo", "profiles");
  mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(profilesDir, `${name}.toml`),
    `name = "${name}"
transport = "local"
lifecycle = "external"
host = "127.0.0.1"
port = 3001
`,
    { mode: 0o600 },
  );
  writeFileSync(join(profilesDir, ".active"), `${name}\n`, { mode: 0o600 });
}

function minimalInstance(overrides: Partial<InstanceJson> = {}): InstanceJson {
  const projectName = "nautilo-compose-cli-test";
  return InstanceJsonSchema.parse({
    schemaVersion: 1,
    instanceId: "",
    server: { host: "localhost", port: 3001, url: "http://localhost:3001" },
    workbench: { port: 3002, url: "http://localhost:3002" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:5434/nautilo",
      neonProxyPort: 5433,
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5435, corePort: 3003, adminPort: 3004 },
    compose: {
      projectName,
      containers: deriveComposeContainerBundle(projectName),
    },
    hostname: {
      federated: "nautilo.local",
      mdns: "nautilo.local",
      tlsSan: "nautilo.local",
      caddyAuthHost: "auth.nautilo.local",
      caddyAuthAdminHost: "auth-admin.nautilo.local",
    },
    deploymentMode: "local-self-host",
    ...overrides,
  });
}

function writeMinimalInstanceJson(root: string, overrides: Partial<InstanceJson> = {}): void {
  writeFileSync(join(root, "instance.json"), JSON.stringify(minimalInstance(overrides)), "utf8");
}

type VerbCall = { method: string; args: unknown[] };

function makeFakeDriver(): ComposeDriver & { calls: VerbCall[] } {
  const calls: VerbCall[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
    };
  return {
    calls,
    deploy: record("deploy"),
    status: record("status"),
    restart: record("restart"),
    logs: record("logs"),
    upgrade: record("upgrade"),
    backup: async (...args: unknown[]) => {
      calls.push({ method: "backup", args });
      return typeof args[1] === "object" &&
        args[1] !== null &&
        "toPath" in args[1]
        ? (args[1] as { toPath: string }).toPath
        : "/tmp/fake-backup.sql.gz";
    },
    restore: record("restore"),
    destroy: record("destroy"),
    inspectCleanup: async (...args: unknown[]) => {
      calls.push({ method: "inspectCleanup", args });
      return {
        containersAbsent: true,
        networksAbsent: true,
        dataVolumesAbsent: true,
        preservedCertificateVolumes: [],
      };
    },
    migrateArtifactsToVolume: record("migrateArtifactsToVolume"),
    migrateMediaToVolume: record("migrateMediaToVolume"),
    authPlan: async (...args: unknown[]) => {
      calls.push({ method: "authPlan", args });
      return {
        classification: "compatible",
        incoming: {},
        applied: null,
        live: { logtoEngineVersion: null, inspected: false },
        reasons: [],
        limitations: [],
      };
    },
    releasePlan: async (...args: unknown[]) => {
      calls.push({ method: "releasePlan", args });
      return { artifact: "image" };
    },
  } as unknown as ComposeDriver & { calls: VerbCall[] };
}

function argvWithDefaults(extra: Record<string, unknown>): Record<string, unknown> {
  return { _: [], $0: "nautilo", ...extra };
}

function controlForTests() {
  return {
    targetUrl: "http://localhost:3001",
    fetchImpl: fetch,
    transport: { validateTargetUrl: (value: string) => new URL(value) },
  };
}

async function runHandler(
  mod: { handler?: (...args: never[]) => void | Promise<void> },
  argv: Record<string, unknown>,
): Promise<void> {
  if (!mod.handler) throw new Error("missing handler");
  await (mod.handler as (args: Record<string, unknown>) => Promise<void>)(
    argvWithDefaults(mod === deployModule
      ? { "owner-mode": "claim", ...argv }
      : argv),
  );
}

describe("compose CLI verbs (M092 Step 5)", () => {
  let home: string;
  let fake: ReturnType<typeof makeFakeDriver>;
  let factoryInvoked: boolean;
  let factoryOptions: FactoryOptions | undefined;
  let ownerDeletes: number;
  let ownerStoreCreates: number;

  beforeEach(() => {
    home = trackTmp();
    prevHome = process.env["HOME"];
    prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
    process.env["HOME"] = home;
    delete process.env["NAUTILO_INSTANCE_ID"];
    setCliProfileFlagOverride(undefined);
    process.exitCode = 0;
    fake = makeFakeDriver();
    factoryInvoked = false;
    factoryOptions = undefined;
    ownerDeletes = 0;
    ownerStoreCreates = 0;
    setComposeDriverFactoryForTests((_profile, opts) => {
      factoryInvoked = true;
      factoryOptions = opts;
      return fake;
    });
    setStableRuntimeImageResolverForTests(async () => STABLE_IMAGE);
    let ownerCredential: string | null = null;
    setComposeOwnerClaimDependenciesForTests({
      createStore: async () => {
        ownerStoreCreates += 1;
        return new KeyringComposeOwnerClaimStore({
          getPassword: async () => ownerCredential,
          setPassword: async (value) => { ownerCredential = value; },
          deleteCredential: async () => { ownerDeletes += 1; ownerCredential = null; return true; },
        });
      },
      createTarget: () => ({
        status: async () => ({ schemaVersion: 1, state: "owner-bound" }),
        install: async () => { throw new Error("owner-bound target must not install"); },
      }),
      resolveControlPlane: () => ({
        targetUrl: "http://localhost:3001",
        fetchImpl: fetch,
        transport: { validateTargetUrl: (value) => new URL(value) },
      }),
      resolveServerUrl: () => "http://localhost:3001",
    });
    writeLocalComposeProfile(home, "local-default");
    writeMinimalInstanceJson(join(home, ".nautilo"));
  });

  afterEach(() => {
    setComposeDriverFactoryForTests(undefined);
    setStableRuntimeImageResolverForTests(undefined);
    setComposeOwnerClaimDependenciesForTests(undefined);
    setCliProfileFlagOverride(undefined);
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
    else delete process.env["HOME"];
    if (prevDotenv !== undefined) process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    else delete process.env["NAUTILO_DOTENV_PATH"];
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpDirs.length = 0;
    resetConfigGuardRateLimitForTests();
    process.exitCode = undefined;
  });

  test("deploy: invokes driver.deploy and exits 0", async () => {
    await runHandler(deployModule, { profile: "local-default" });
    expect(process.exitCode).toBe(0);
    expect(factoryInvoked).toBe(true);
    expect(fake.calls.some((c) => c.method === "deploy")).toBe(true);
  });

  test("deploy: unavailable stable image fails before custody and driver construction", async () => {
    setStableRuntimeImageResolverForTests(async () => {
      throw new Error("No signed stable Nautilo release is currently available");
    });

    await runHandler(deployModule, { profile: "local-default" });

    expect(process.exitCode).toBe(2);
    expect(factoryInvoked).toBe(false);
    expect(ownerStoreCreates).toBe(0);
  });

  test("deploy prepares custody before driver construction and observes owner only after deploy", async () => {
    const order: string[] = [];
    let credential: string | null = null;
    setComposeOwnerClaimDependenciesForTests({
      createStore: async () => new KeyringComposeOwnerClaimStore({
        getPassword: async () => credential,
        setPassword: async (value) => { order.push("custody"); credential = value; },
        deleteCredential: async () => { credential = null; return true; },
      }),
      createTarget: () => ({
        status: async () => { order.push("status"); return { schemaVersion: 1, state: "owner-bound" }; },
        install: async () => { throw new Error("must not install"); },
      }),
      resolveControlPlane: () => controlForTests(),
      resolveServerUrl: () => "http://localhost:3001",
    });
    setComposeDriverFactoryForTests((_profile, opts) => {
      order.push("factory");
      factoryOptions = opts;
      fake.deploy = async () => { order.push("deploy"); };
      return fake;
    });
    await runHandler(deployModule, { profile: "local-default" });
    expect(order).toEqual(["custody", "factory", "deploy", "status"]);
    expect(factoryOptions?.firstDeployConsume).toBeUndefined();
  });

  test("provider consumption uses the config frozen before Docker despite later file drift", async () => {
    const root = trackTmp();
    const configPath = join(root, "deploy.toml");
    const instanceRoot = join(root, "instance");
    mkdirSync(instanceRoot, { mode: 0o700 });
    writeFileSync(join(instanceRoot, "instance.env"), "", { mode: 0o600 });
    writeMinimalInstanceJson(instanceRoot);
    const config = (providerValue: string) => `schemaVersion = 1
[admin]
handle = "operator"
displayName = "Operator"
password = { value = "permanent-password" }
pin = { value = "123456" }
[[providers]]
key = "OPENAI_API_KEY"
value = { value = "${providerValue}" }
`;
    writeFileSync(configPath, config("sk-proj-frozen-12345678901234567890"), { mode: 0o600 });
    chmodSync(configPath, 0o600);
    const resolved = resolveDeployConfigForCompose(configPath, instanceRoot);
    const hook = buildFirstDeployProviderConsumeHook({ resolved });
    writeFileSync(configPath, config("sk-proj-drifted-1234567890123456789"), { mode: 0o600 });
    await hook({
      profile: { name: "frozen", transport: "local", lifecycle: "compose", instance_id: "frozen" },
      instanceRootDir: instanceRoot,
      deployTomlPath: configPath,
    });
    const env = readFileSync(join(instanceRoot, "instance.env"), "utf8");
    expect(env).toContain("sk-proj-frozen-12345678901234567890");
    expect(env).not.toContain("drifted");
  });

  test("config mode rejects removed force-password policy before custody and driver", async () => {
    const configRoot = trackTmp();
    const resultRoot = trackTmp();
    let custodyWrites = 0;
    setComposeOwnerClaimDependenciesForTests({
      createStore: async () => new KeyringComposeOwnerClaimStore({
        getPassword: async () => null,
        setPassword: async () => { custodyWrites += 1; },
        deleteCredential: async () => true,
      }),
    });
    for (const forceLine of [
      "forcePasswordChangeOnFirstSignIn = false\n",
      "forcePasswordChangeOnFirstSignIn = true\n",
    ]) {
      const configPath = join(configRoot, `owner-${forceLine.length}.toml`);
      writeFileSync(configPath, `schemaVersion = 1
[admin]
handle = "operator"
displayName = "Operator"
password = { value = "permanent-password" }
pin = { value = "123456" }
${forceLine}`, { mode: 0o600 });
      chmodSync(configPath, 0o600);
      factoryInvoked = false;
      await runHandler(deployModule, {
        profile: "local-default",
        "owner-mode": "config",
        "owner-config": configPath,
        "owner-result": join(resultRoot, `result-${forceLine.length}.json`),
      });
      expect(process.exitCode).toBe(2);
      expect(factoryInvoked).toBe(false);
    }
    expect(custodyWrites).toBe(0);
  });

  test("omitted force-password policy reaches direct seed with a permanent owner password", async () => {
    const configRoot = trackTmp();
    const resultRoot = trackTmp();
    const configPath = join(configRoot, "owner.toml");
    const resultPath = join(resultRoot, "owner-result.json");
    writeFileSync(configPath, `schemaVersion = 1
[admin]
handle = "operator"
displayName = "Operator"
password = { value = "permanent-password" }
pin = { value = "123456" }
`, { mode: 0o600 });
    chmodSync(configPath, 0o600);
    let credential: string | null = null;
    let statusCalls = 0;
    let redeems = 0;
    let opened = "";
    setComposeOwnerClaimDependenciesForTests({
      createStore: async () => new KeyringComposeOwnerClaimStore({
        getPassword: async () => credential,
        setPassword: async (value) => { credential = value; },
        deleteCredential: async () => { credential = null; return true; },
      }),
      createTarget: () => ({
        status: async () => ({
          schemaVersion: 1,
          state: statusCalls++ === 0 ? "awaiting-owner" : "owner-bound",
        }),
        install: async () => ({ schemaVersion: 1, state: "claim-active" }),
      }),
      resolveControlPlane: () => controlForTests(),
      resolveServerUrl: () => "http://localhost:3001",
      readBootstrapToken: () => "b".repeat(32),
      redeemOwner: async (_url, _claim, input) => {
        redeems += 1;
        expect(input).toEqual({
          handle: "operator",
          displayName: "Operator",
          password: "permanent-password",
          pin: "123456",
        });
        return {
          schemaVersion: 1,
          state: "owner-bound",
          recoveryCodes: Array.from({ length: 8 }, (_, index) => index.toString(16).padStart(24, "0")),
        };
      },
      publishOwnerResult: async ({ result }) => ({ kind: "published", path: resultPath, result }),
      openBrowser: async (url) => { opened = url; },
    });
    await runHandler(deployModule, {
      profile: "local-default",
      "owner-mode": "config",
      "owner-config": configPath,
      "owner-result": resultPath,
      "open-browser": true,
    });
    expect(redeems).toBe(1);
    expect(factoryOptions?.firstDeployConsume).toBeDefined();
    expect(process.exitCode).toBe(0);
    expect(credential).toBeNull();
    expect(opened).toBe("http://localhost:3001/help/server");
  });

  test("remote https-off claim rejects before driver construction", async () => {
    const profilesDir = join(home, ".nautilo", "profiles");
    writeFileSync(join(profilesDir, "remote-http.toml"), `name = "remote-http"
transport = "remote"
lifecycle = "compose"
https = "off"
[ssh]
host = "203.0.113.4"
user = "root"
`, { mode: 0o600 });
    factoryInvoked = false;
    await runHandler(deployModule, { profile: "remote-http" });
    expect(process.exitCode).toBe(2);
    expect(factoryInvoked).toBe(false);
  });

  test("runComposeVerb preserves action-required and interrupt exit outcomes", async () => {
    await runComposeVerb({ profile: "local-default" }, async () => ({ exitCode: 1 }));
    expect(process.exitCode).toBe(1);
    await runComposeVerb({ profile: "local-default" }, async () => ({ exitCode: 130 }));
    expect(process.exitCode).toBe(130);
  });

  test("deploy JSON returns the exact product destination and never opens implicitly", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let stdout = "";
    process.stdout.write = ((value: string | Uint8Array) => {
      stdout += String(value);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runHandler(deployModule, {
        profile: "local-default",
        finish: "product",
        "open-browser": true,
        json: true,
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 1,
      backend: "compose",
      operation: "deploy",
      finish: "product",
      browser: "not-requested",
      profile: "local-default",
      destinations: {
        serverUrl: "http://localhost:3001",
        finalUrl: "http://localhost:3001/",
      },
    });
  });

  test("deploy builder: does not register workbench-only or revert (D249)", () => {
    const optionNames: string[] = [];
    const chain = {
      option: (name: string) => {
        optionNames.push(name);
        return chain;
      },
      example: () => chain,
      epilogue: () => chain,
    };
    if (typeof deployModule.builder === "function") {
      deployModule.builder(chain as never);
    }
    expect(optionNames).not.toContain("workbench-only");
    expect(optionNames).not.toContain("revert");
    expect(optionNames).not.toContain("tag");
    expect(optionNames).not.toContain("from-registry");
    expect(optionNames).toContain("image");
    expect(optionNames).toContain("redeem");
    expect(optionNames).toContain("allow-artifact-loss");
    expect(optionNames).toContain("finish");
    expect(optionNames).toContain("open-browser");
    expect(optionNames).toContain("json");
  });

  test("deploy rejects the removed --from-registry flag without constructing a driver", async () => {
    await runHandler(deployModule, {
      profile: "local-default",
      "from-registry": true,
    });

    expect(process.exitCode).toBe(2);
    expect(factoryInvoked).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  test("deploy defaults to the latest signed stable runtime image", async () => {
    await runHandler(deployModule, { profile: "local-default" });

    expect(process.exitCode).toBe(0);
    const deployCall = fake.calls.find((c) => c.method === "deploy");
    expect(deployCall).toBeDefined();
    expect(deployCall!.args[0]).toMatchObject({
      name: "local-default",
      from_source: false,
      image_ref: STABLE_IMAGE,
    });
  });

  test("deploy --image passes an exact full image reference without stable lookup", async () => {
    const image = "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1";
    setStableRuntimeImageResolverForTests(async () => {
      throw new Error("explicit image must bypass stable lookup");
    });
    await runHandler(deployModule, {
      profile: "local-default",
      image,
    });

    expect(process.exitCode).toBe(0);
    const deployCall = fake.calls.find((c) => c.method === "deploy");
    expect(deployCall!.args[0]).toMatchObject({
      name: "local-default",
      from_source: false,
      image_ref: image,
    });
  });

  test("deploy rejects mutable and historical registry image selection", async () => {
    await runHandler(deployModule, {
      profile: "local-default",
      image: "ghcr.io/agentsea/nautilo-runtime-v2:main",
    });
    expect(process.exitCode).toBe(2);
    expect(fake.calls).toHaveLength(0);

    process.exitCode = 0;
    await runHandler(deployModule, {
      profile: "local-default",
      image: "ghcr.io/agentsea/nautilo-server@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1",
    });
    expect(process.exitCode).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  test("deploy: gate failure on non-compose profile exits 2", async () => {
    writeExternalLocalProfile(home, "ext");
    await runHandler(deployModule, { profile: "ext", redeem: false });
    expect(process.exitCode).toBe(2);
    expect(fake.calls.length).toBe(0);
  });

  test("restart: success and gate failure", async () => {
    await runHandler(restartModule, { profile: "local-default" });
    expect(process.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      method: "restart",
      args: [expect.objectContaining({ name: "local-default" })],
    });
    expect(fake.calls[0]!.args).toHaveLength(1);

    process.exitCode = 0;
    fake.calls.length = 0;
    writeExternalLocalProfile(home, "ext2");
    await runHandler(restartModule, { profile: "ext2" });
    expect(process.exitCode).toBe(2);
    expect(fake.calls.length).toBe(0);
  });

  test("restart --full requests full-stack existing-image recovery only", async () => {
    await runHandler(restartModule, { profile: "local-default", full: true });

    expect(process.exitCode).toBe(0);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      method: "restart",
      args: [expect.objectContaining({ name: "local-default" }), { full: true }],
    });
    expect(
      fake.calls.some((call) =>
        ["deploy", "upgrade", "backup", "restore", "migrateArtifactsToVolume", "migrateMediaToVolume"].includes(
          call.method,
        ),
      ),
    ).toBe(false);
  });

  test("restart --full documents all-service Docker DNS recovery", () => {
    const options = new Map<string, Record<string, unknown>>();
    const chain = {
      option: (name: string, config: Record<string, unknown>) => {
        options.set(name, config);
        return chain;
      },
      example: () => chain,
    };
    if (typeof restartModule.builder === "function") {
      restartModule.builder(chain as never);
    }

    expect(options.get("full")).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(options.get("full")?.["describe"]).toContain("restart all services");
    expect(options.get("full")?.["describe"]).toContain("Docker DNS");
    expect(options.get("full")?.["describe"]).toContain("no builds, pulls, backups, migrations");
  });

  test("logs: passes follow and service", async () => {
    await runHandler(logsModule, {
      profile: "local-default",
      follow: true,
      service: "nautilo-server",
    });
    expect(process.exitCode).toBe(0);
    const call = fake.calls.find((c) => c.method === "logs");
    expect(call?.args[1]).toEqual({ follow: true, service: "nautilo-server" });

    process.exitCode = 0;
    writeExternalLocalProfile(home, "ext3");
    await runHandler(logsModule, { profile: "ext3" });
    expect(process.exitCode).toBe(2);
  });

  test("upgrade exposes the canonical artifact, scope, and maintenance flags", () => {
    const options = new Map<string, Record<string, unknown>>();
    const chain = {
      option: (name: string, config: Record<string, unknown>) => {
        options.set(name, config);
        return chain;
      },
      example: () => chain,
    };
    if (typeof upgradeModule.builder === "function") {
      upgradeModule.builder(chain as never);
    }

    expect([...options.keys()]).toEqual([
      "from-sources",
      "image",
      "full",
      "wait-for",
      "no-rollback",
      "allow-artifact-loss",
      "backup-dir",
    ]);
    expect(options.get("from-sources")).toMatchObject({ type: "boolean", default: false });
    expect(options.get("image")).toMatchObject({ type: "string" });
    expect(options.get("full")).toMatchObject({ type: "boolean", default: false });
    expect(options.get("wait-for")).toMatchObject({ type: "string" });
    expect(options.get("no-rollback")).toMatchObject({ type: "boolean", default: false });
    expect(options.get("allow-artifact-loss")).toMatchObject({ type: "boolean", default: false });
    expect(options.get("backup-dir")).toMatchObject({ type: "string" });
    expect(options.get("backup-dir")).not.toHaveProperty("default");
  });

  test("auth plan: is an additive auth subcommand that dispatches read-only planning", async () => {
    const commands: unknown[] = [];
    const chain = {
      command: (command: unknown) => {
        commands.push(command);
        return chain;
      },
      demandCommand: () => chain,
    };
    if (typeof authModule.builder === "function") {
      authModule.builder(chain as never);
    }
    const plan = commands.find(
      (command) =>
        typeof command === "object" &&
        command !== null &&
        "command" in command &&
        (command as { command?: string }).command === "plan",
    ) as { handler?: (...args: never[]) => Promise<void> };
    expect(plan).toBeDefined();

    const output: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runHandler(plan, { profile: "local-default" });
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(process.exitCode).toBe(0);
    expect(fake.calls.some((call) => call.method === "authPlan")).toBe(true);
    expect(output.join("")).toContain('"classification": "compatible"');
  });

  test("release plan previews the latest signed stable runtime image", async () => {
    const commands: unknown[] = [];
    const chain = {
      command: (command: unknown) => {
        commands.push(command);
        return chain;
      },
      demandCommand: () => chain,
    };
    if (typeof releaseModule.builder === "function") {
      releaseModule.builder(chain as never);
    }
    const plan = commands.find(
      (command) =>
        typeof command === "object" &&
        command !== null &&
        "command" in command &&
        (command as { command?: string }).command === "plan",
    ) as { handler?: (...args: never[]) => Promise<void> };

    await runHandler(plan, { profile: "local-default" });

    const call = fake.calls.find(({ method }) => method === "releasePlan");
    expect(call?.args[0]).toMatchObject({
      name: "local-default",
      from_source: false,
      image_ref: STABLE_IMAGE,
    });
  });

  test("upgrade dispatches source/full strategy and maintenance options", async () => {
    await runHandler(upgradeModule, {
      profile: "local-default",
      "from-sources": true,
      full: true,
      "wait-for": "30s",
      "no-rollback": true,
      "allow-artifact-loss": true,
      "backup-dir": "  /tmp/legacy-upgrade-backups  ",
    });
    expect(process.exitCode).toBe(0);
    expect(factoryInvoked).toBe(true);
    expect(factoryOptions?.doctor).toBeInstanceOf(Function);
    expect(fake.calls).toHaveLength(1);
    const upgradeCall = fake.calls.find((c) => c.method === "upgrade");
    expect(upgradeCall?.args[0]).toMatchObject({
      name: "local-default",
      transport: "local",
      lifecycle: "compose",
    });
    expect(upgradeCall?.args[1]).toEqual({
      artifact: "source",
      scope: "full",
      waitForMs: 30_000,
      noRollback: true,
      allowArtifactLoss: true,
      backupDir: "/tmp/legacy-upgrade-backups",
    });
  });

  test("upgrade defaults to the latest signed stable image with a five-minute ceiling", async () => {
    await runHandler(upgradeModule, { profile: "local-default" });
    expect(process.exitCode).toBe(0);
    const upgradeCall = fake.calls.find((c) => c.method === "upgrade");
    expect(upgradeCall).toBeDefined();
    expect(upgradeCall!.args[1]).toEqual({
      artifact: "image",
      imageRef: STABLE_IMAGE,
      scope: "server-only",
      waitForMs: 300_000,
      noRollback: false,
      allowArtifactLoss: false,
    });

    process.exitCode = 0;
    writeExternalLocalProfile(home, "ext4");
    await runHandler(upgradeModule, { profile: "ext4" });
    expect(process.exitCode).toBe(2);
  });

  test("upgrade --from-sources and --image are mutually exclusive (gate failure exits 2)", async () => {
    await runHandler(upgradeModule, {
      profile: "local-default",
      "from-sources": true,
      image: "ghcr.io/example/nautilo-server:sha-1",
    });
    expect(process.exitCode).toBe(2);
    expect(fake.calls.some((c) => c.method === "upgrade")).toBe(false);
  });

  test("upgrade --image routes a full-image override through the canonical upgrade call", async () => {
    const image = "ghcr.io/agentsea/nautilo-runtime-v2@sha256:74c76a08d65399d83f752cae76caa2bb4b0a4218e57f74ece87ac8a5a1c06ec1";
    setStableRuntimeImageResolverForTests(async () => {
      throw new Error("explicit image must bypass stable lookup");
    });
    await runHandler(upgradeModule, {
      profile: "local-default",
      image,
      full: true,
      "wait-for": "90s",
    });
    expect(process.exitCode).toBe(0);
    const upgradeCall = fake.calls.find((c) => c.method === "upgrade");
    expect(upgradeCall?.args[1]).toEqual({
      artifact: "image",
      imageRef: image,
      scope: "full",
      waitForMs: 90_000,
      noRollback: false,
      allowArtifactLoss: false,
    });
  });

  test("artifact relocation writes a private immutable plan and requires its explicit digest for apply", async () => {
    const plan: ArtifactRelocationPlan = { schemaVersion: 1, sourceRoot: "/old/artifacts", targetRoot: "/new/artifacts", target: { instanceId: "fixture", project: "fixture", serverContainer: "server", databaseContainer: "db", imageId: "image", artifactsRoot: "/new/artifacts" }, before: { identity: { instance_id: "fixture" }, artifacts: [], message_attachments: [], workspace_document_mutation_entries: [] }, files: [], source: { bundlePath: "/backup", manifestSha256: "a".repeat(64), archiveSha256: "b".repeat(64), files: [] } };
    const operations: unknown[] = [];
    fake.relocateArtifacts = async (_profile, options) => { operations.push(options); return "sourceRoot" in options ? plan : { outcome: "applied", planSha256: options.planSha256 }; };
    const planPath = join(home, "relocation.json");
    await runHandler(artifactsRelocateModule, { profile: "local-default", mode: "plan", plan: planPath, "from-root": "/old/artifacts", backup: "/backup" });
    expect(process.exitCode).toBe(0); expect(statSync(planPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(planPath, "utf8"))).toEqual(plan);
    await runHandler(artifactsRelocateModule, { profile: "local-default", mode: "plan", plan: planPath, "from-root": "/old/artifacts", backup: "/backup" });
    expect(process.exitCode).toBe(2); expect(JSON.parse(readFileSync(planPath, "utf8"))).toEqual(plan);
    const count = operations.length;
    await runHandler(artifactsRelocateModule, { profile: "local-default", mode: "apply", plan: planPath });
    expect(process.exitCode).toBe(2); expect(operations).toHaveLength(count);
    const sha256 = relocationPlanSha256(plan);
    await runHandler(artifactsRelocateModule, { profile: "local-default", mode: "apply", plan: planPath, sha256 });
    expect(process.exitCode).toBe(0); expect(operations.at(-1)).toEqual({ plan, planSha256: sha256, rollback: false });
    chmodSync(planPath, 0o644);
    await runHandler(artifactsRelocateModule, { profile: "local-default", mode: "apply", plan: planPath, sha256 });
    expect(process.exitCode).toBe(2); expect(operations).toHaveLength(count + 1);
  });

  test("migrate-artifacts-to-volume: success and gate failure", async () => {
    await runHandler(migrateArtifactsToVolumeModule, { profile: "local-default" });
    expect(process.exitCode).toBe(0);
    expect(fake.calls.some((c) => c.method === "migrateArtifactsToVolume")).toBe(true);

    process.exitCode = 0;
    writeExternalLocalProfile(home, "extM");
    await runHandler(migrateArtifactsToVolumeModule, { profile: "extM" });
    expect(process.exitCode).toBe(2);
  });

  test("migrate-media-to-volume: success and gate failure", async () => {
    await runHandler(migrateMediaToVolumeModule, { profile: "local-default" });
    expect(process.exitCode).toBe(0);
    expect(fake.calls.some((c) => c.method === "migrateMediaToVolume")).toBe(true);

    process.exitCode = 0;
    writeExternalLocalProfile(home, "extMedia");
    await runHandler(migrateMediaToVolumeModule, { profile: "extMedia" });
    expect(process.exitCode).toBe(2);
  });

  test("backup: prints path on success; gate failure", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    await runHandler(backupModule, { profile: "local-default" });
    process.stdout.write = orig;
    expect(process.exitCode).toBe(0);
    expect(chunks.join("")).toContain("/tmp/fake-backup.sql.gz");

    process.exitCode = 0;
    writeExternalLocalProfile(home, "ext5");
    await runHandler(backupModule, { profile: "ext5" });
    expect(process.exitCode).toBe(2);
  });

  test("backup: positional path passes full-bundle options", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runHandler(backupModule, {
        profile: "local-default",
        path: "./bundle",
      });
    } finally {
      process.stdout.write = orig;
    }

    expect(process.exitCode).toBe(0);
    const call = fake.calls.find((c) => c.method === "backup");
    expect(call?.args[1]).toEqual({
      toPath: "./bundle",
      noOperatorFiles: false,
      tarball: false,
      stream: false,
    });
    expect(chunks.join("")).toContain("./bundle");
  });

  test("restore: requires path or --from; success and gate failure", async () => {
    await runHandler(restoreModule, { profile: "local-default" });
    expect(process.exitCode).toBe(2);

    process.exitCode = 0;
    await runHandler(restoreModule, {
      profile: "local-default",
      from: "/tmp/dump.sql.gz",
      force: true,
    });
    expect(process.exitCode).toBe(0);
    const call = fake.calls.find((c) => c.method === "restore");
    expect(call?.args[1]).toEqual({
      fromPath: "/tmp/dump.sql.gz",
      force: true,
      mode: "full",
      stream: false,
    });

    process.exitCode = 0;
    writeExternalLocalProfile(home, "ext6");
    await runHandler(restoreModule, { profile: "ext6", from: "/tmp/x.sql.gz" });
    expect(process.exitCode).toBe(2);
  });

  test("restore: positional path routes to driver.restore", async () => {
    await runHandler(restoreModule, {
      profile: "local-default",
      path: "./bundle",
    });

    expect(process.exitCode).toBe(0);
    const call = fake.calls.find((c) => c.method === "restore");
    expect(call?.args[1]).toEqual({
      fromPath: "./bundle",
      force: false,
      mode: "full",
      stream: false,
    });
  });

  test("destroy: passes hard flag; gate failure", async () => {
    await runHandler(destroyModule, { profile: "local-default", hard: true });
    expect(process.exitCode).toBe(0);
    expect(fake.calls.find((c) => c.method === "destroy")?.args[1]).toEqual({
      hard: true,
      keepCerts: false,
    });
    expect(ownerDeletes).toBe(1);

    ownerDeletes = 0;
    await runHandler(destroyModule, { profile: "local-default", hard: false });
    expect(process.exitCode).toBe(0);
    expect(ownerDeletes).toBe(0);

    fake.destroy = async () => { throw new Error("teardown failed"); };
    await runHandler(destroyModule, { profile: "local-default", hard: true });
    expect(process.exitCode).toBe(2);
    expect(ownerDeletes).toBe(0);

    process.exitCode = 0;
    writeExternalLocalProfile(home, "ext7");
    await runHandler(destroyModule, { profile: "ext7" });
    expect(process.exitCode).toBe(2);
  });

  test("destroy parser rejects unknown flags before driver construction and accepts explicit automation acknowledgement", async () => {
    const rejected = yargs(["destroy", "--hard", "--unexpected-flag"])
      .scriptName("nautilo")
      .strict()
      .exitProcess(false)
      .command(destroyModule)
      .fail((message, error) => { throw error ?? new Error(message); });
    let failure: unknown;
    try {
      await rejected.parseAsync();
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe("Unknown argument: unexpected-flag");
    expect(factoryInvoked).toBeFalse();
    expect(fake.calls.some((call) => call.method === "destroy")).toBeFalse();
    expect(ownerDeletes).toBe(0);

    const positionalRejected = yargs(["destroy", "garbage"])
      .scriptName("nautilo")
      .strict()
      .exitProcess(false)
      .command(destroyModule)
      .fail((message, error) => { throw error ?? new Error(message); });
    failure = undefined;
    try {
      await positionalRejected.parseAsync();
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe("Unknown argument: garbage");
    expect(factoryInvoked).toBeFalse();
    expect(fake.calls.some((call) => call.method === "destroy")).toBeFalse();
    expect(ownerDeletes).toBe(0);

    const accepted = yargs(["destroy", "--hard", "--yes"])
      .scriptName("nautilo")
      .strict()
      .exitProcess(false)
      .command(destroyModule)
      .fail((message, error) => { throw error ?? new Error(message); });
    await accepted.parseAsync();
    expect(factoryInvoked).toBeTrue();
    expect(fake.calls.filter((call) => call.method === "destroy")).toHaveLength(1);
  });

  test("hard destroy keychain failure returns nonzero with exact idempotent cleanup command", async () => {
    setComposeOwnerClaimDependenciesForTests({
      createStore: async () => new KeyringComposeOwnerClaimStore({
        getPassword: async () => null,
        setPassword: async () => undefined,
        deleteCredential: async () => { throw new Error("keychain unavailable"); },
      }),
    });
    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((value: string | Uint8Array) => {
      stderr += String(value);
      return true;
    }) as typeof process.stderr.write;
    try {
      await runHandler(destroyModule, {
        profile: "local-default",
        hard: true,
        "keep-certs": true,
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(process.exitCode).toBe(2);
    expect(stderr).toContain(
      "nautilo destroy --hard --profile local-default --keep-certs",
    );
    expect(fake.calls.some((call) => call.method === "destroy")).toBe(true);
  });

  test("status: local+compose dispatches to ComposeDriver.status", async () => {
    await runHandler(statusModule, { format: "human" });
    expect(process.exitCode).toBe(0);
    expect(factoryInvoked).toBe(true);
    expect(fake.calls.some((c) => c.method === "status")).toBe(true);
  });

  test("status: remote+compose dispatches to ComposeDriver.status", async () => {
    const profilesDir = join(home, ".nautilo", "profiles");
    writeFileSync(
      join(profilesDir, "remote-compose.toml"),
      `name = "remote-compose"
transport = "remote"
lifecycle = "compose"
from_source = true

[ssh]
host = "1.2.3.4"
user = "root"
`,
      { mode: 0o600 },
    );
    writeFileSync(join(profilesDir, ".active"), "remote-compose\n", { mode: 0o600 });

    factoryInvoked = false;
    fake.calls.length = 0;
    await runHandler(statusModule, { format: "human" });
    expect(process.exitCode).toBe(0);
    expect(factoryInvoked).toBe(true);
    expect(fake.calls.some((c) => c.method === "status")).toBe(true);
    const statusCall = fake.calls.find((c) => c.method === "status");
    expect(statusCall?.args[0]).toMatchObject({
      name: "remote-compose",
      transport: "remote",
      lifecycle: "compose",
    });
  });

  test("status: --server skips compose dispatch", async () => {
    factoryInvoked = false;
    await runHandler(statusModule, {
      server: "http://127.0.0.1:59999",
      format: "json",
    });
    expect(factoryInvoked).toBe(false);
    expect(fake.calls.some((c) => c.method === "status")).toBe(false);
    expect(process.exitCode).toBe(2);
  });

  test("status: remote profile uses legacy fetch path", async () => {
    const profilesDir = join(home, ".nautilo", "profiles");
    writeFileSync(
      join(profilesDir, "remote.toml"),
      `name = "remote"
transport = "remote"
lifecycle = "external"
domain = "demo.example.com"
`,
      { mode: 0o600 },
    );
    writeFileSync(join(profilesDir, ".active"), "remote\n", { mode: 0o600 });

    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          instanceId: "x",
          serverUrl: "http://127.0.0.1:1",
          deploymentMode: "local-self-host",
          setupState: "ready",
          claimRequired: false,
          viewer: {
            canManageServerSettings: true,
            genieCustomized: true,
            byokConfigured: true,
            pinEnrolled: false,
            handleAutoGenerated: false,
            passwordWasTemp: null,
          },
          providers: { hasLlm: true, managedByCloud: false },
          recommendedSetupSurface: { kind: "cli", url: null },
        });
      },
    });
    try {
      process.env["NAUTILO_SERVER_URL"] = `http://127.0.0.1:${server.port}`;
      factoryInvoked = false;
      await runHandler(statusModule, { format: "json" });
      expect(factoryInvoked).toBe(false);
      expect(fake.calls.some((c) => c.method === "status")).toBe(false);
      expect(process.exitCode).toBe(0);
    } finally {
      server.stop();
      delete process.env["NAUTILO_SERVER_URL"];
    }
  });
});
