import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInstanceUncached } from "@nautilo/config";
import { buildRegistryImageRef } from "../../src/buildRegistryOverlay.ts";
import {
  ComposeDriver,
  type ComposeDriverDeps,
  type ExecFn,
  type ExecResult,
} from "../../src/ComposeDriver.ts";
import type { RunBootstrapFn } from "../../src/bootstrapLogtoForProfile.ts";
import { DIRECT_TRANSPORT_BASELINE_REFUSAL } from "../../src/direct-transport-baseline.ts";
import type { RemoteDeploymentManifest } from "../../src/remote-deployment-manifest.ts";
import {
  RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT,
  RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT,
  RETIRED_TOPOLOGY_PRESENCE_REFUSAL,
} from "../../src/retired-topology-presence.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const CANONICAL_IMAGE_REF = `ghcr.io/agentsea/nautilo-runtime-v2@sha256:${"a".repeat(64)}`;
const tmpDirs: string[] = [];

function mktmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

interface ExecCall {
  cmd: string;
  args: string[];
}

function makeDeps(exec: ExecFn, over: Partial<ComposeDriverDeps> = {}): ComposeDriverDeps {
  const repoRoot = mktmp("m215-orch-repo-");
  const templateDir = join(repoRoot, "deploy/compose-driver/templates");
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "docker-compose.yml"), "# unit-test template marker\n");
  const infraDir = join(repoRoot, "infra");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "postgres-init.sh"), "#!/bin/sh\n");
  const localRoot = mktmp("m215-orch-home-");
  const fakeFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const fakeRunBootstrap: RunBootstrapFn = async () => {};
  return {
    exec,
    localExec: exec,
    fetch: fakeFetch,
    runBootstrap: fakeRunBootstrap as ComposeDriverDeps["runBootstrap"],
    ensureRemotePairingPepper: async () => "a".repeat(64),
    ensurePushTokenEncryptionKey: async () => "b".repeat(64),
    resolveSourceBuildSha: async () => "c".repeat(40),
    fs: nodeFs,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
    templateDir,
    pollIntervalMs: 1,
    logtoHealthTimeoutMs: 1000,
    serverHealthTimeoutMs: 1000,
    resolveInstanceRootDir: () => localRoot,
    resolveLocalInstanceRootDir: () => localRoot,
    resolveInstance: () =>
      resolveInstanceUncached(
        { ...process.env, HOME: localRoot },
        { userHomeDir: localRoot, skipHostBindProbe: true },
      ),
    readInstanceLogtoEnv: async () => ({
      LOGTO_ENDPOINT: "http://localhost:3301",
      LOGTO_ISSUER: "http://localhost:3301/oidc",
      LOGTO_JWKS_URI: "http://localhost:3301/oidc/jwks",
      LOGTO_RESOURCE: "https://api.nautilo.local",
      LOGTO_M2M_APP_ID: "m2m-id",
      LOGTO_M2M_APP_SECRET: "m2m-secret",
      LOGTO_WORKBENCH_APP_ID: "wb",
    }),
    ensureDbPasswords: async () => ({
      appDbPassword: "fake_app_pw",
      postgresPassword: "fake_pg_pw",
      nautilo: "fake_nautilo_pw",
      logto: "fake_logto_pw",
      nautiloAgent: "fake_agent_pw",
      nautiloCrypto: "fake_crypto_pw",
    }),
    ensureForgotPasswordWebhookSecret: async () => "fake_webhook_secret",
    ...over,
  };
}

const localProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

const remoteRegistryProfile: ComposeDriverProfile = {
  name: "remote-prod",
  transport: "remote",
  lifecycle: "compose",
  from_source: false,
  image_ref: CANONICAL_IMAGE_REF,
  instance_id: "prod",
  ssh: { host: "1.2.3.4", user: "root" },
};

function validRemoteManifest(
  overrides: Partial<RemoteDeploymentManifest> = {},
): RemoteDeploymentManifest {
  return {
    version: 1,
    instanceId: "prod",
    composeProjectName: "nautilo-prod",
    lifecycle: "compose",
    image: { mode: "registry", reference: buildRegistryImageRef(CANONICAL_IMAGE_REF) },
    remoteRoot: "/opt/nautilo-prod",
    https: "off",
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:30:00.000Z",
    ...overrides,
  } as RemoteDeploymentManifest;
}

function isRetiredTopologyPresenceScript(script: string): boolean {
  return (
    script.includes("com.docker.compose.service=$service") &&
    script.includes("neon-proxy") &&
    script.includes('refuse "$refusal"') &&
    !script.includes("docker rm")
  );
}

function isRetiredTopologyPresenceQueryScript(script: string): boolean {
  return (
    script.includes("com.docker.compose.service=$service") &&
    script.includes("neon-proxy") &&
    script.includes(`exit ${RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT}`) &&
    script.includes(`exit ${RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT}`) &&
    !script.includes('refuse "$refusal"') &&
    !script.includes("docker rm")
  );
}

function isDirectTransportBaselineScript(script: string): boolean {
  return script.includes("validate_db_url") && script.includes("count_retired");
}

function defaultRemotePersistentVolumeGuardResponse(script: string): ExecResult | undefined {
  if (!script.includes('missing=""')) {
    return undefined;
  }
  return { code: 0, stdout: "", stderr: "" };
}

function makeRemoteLifecycleExec(
  manifest: RemoteDeploymentManifest,
  responder?: (call: ExecCall) => ExecResult | undefined,
): { exec: ExecFn; calls: ExecCall[] } {
  const manifestJson = JSON.stringify(manifest);
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (cmd, args) => {
    const call: ExecCall = { cmd, args };
    calls.push(call);
    const custom = responder?.(call);
    if (custom !== undefined) return custom;
    if (cmd === "cat" && args.some((a) => a.includes("deployment-manifest.json"))) {
      return { code: 0, stdout: `${manifestJson}\n`, stderr: "" };
    }
    if (cmd === "cat" && args.some((a) => a.endsWith("/deploy.compose.env"))) {
      return {
        code: 0,
        stdout:
          "APP_DB_PASSWORD=app\nNAUTILO_DB_PASSWORD=owner\nNAUTILO_AGENT_DB_PASSWORD=agent\n",
        stderr: "",
      };
    }
    if (
      cmd === "cat" &&
      args.some((a) => a.endsWith("/runtime-config/instance.env"))
    ) {
      return {
        code: 0,
        stdout: "NAUTILO_DB_PASSWORD=owner\n",
        stderr: "",
      };
    }
    if (cmd === "sh" && args[0] === "-lc") {
      const script = args[1] ?? "";
      const persistentVolumeGuard = defaultRemotePersistentVolumeGuardResponse(script);
      if (persistentVolumeGuard !== undefined) return persistentVolumeGuard;
      if (script.includes(" ps ") || script.endsWith(" ps --format json")) {
        return {
          code: 0,
          stdout: '[{"Name":"nautilo-prod-nautilo-server","State":"running"}]\n',
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
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

describe("M215 upgrade orchestration", () => {
  test("server-only upgrade refuses retired topology before drain and stop with --full guidance", async () => {
    const order: string[] = [];
    let sawStop = false;
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (cmd === "sh" && isRetiredTopologyPresenceScript(joined)) {
        return { code: 47, stdout: "", stderr: RETIRED_TOPOLOGY_PRESENCE_REFUSAL };
      }
      if (joined.includes(" stop ") || joined.includes("stop nautilo-server")) {
        sawStop = true;
      }
      if (cmd === "docker" && args[0] === "ps") {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "inspect") {
        return { code: 0, stdout: "nautilo-server:local-dev\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return {
        operationId: "op-test",
        transitionApplying: async () => {},
        releaseLease: async () => ({ cancelled: true }),
        completeLease: async () => ({ completed: true }),
      };
    });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile, { scope: "server-only" })).rejects.toThrow(
      /nautilo upgrade --full/,
    );
    expect(order).toEqual([]);
    expect(sawStop).toBe(false);
  });

  test("server-only upgrade with clean topology drains then delegates to releaseApply", async () => {
    const order: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (cmd === "sh" && isRetiredTopologyPresenceScript(joined)) {
        order.push("topology-preflight");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "ps") {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "inspect") {
        return { code: 0, stdout: "nautilo-server:local-dev\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return {
        operationId: "op-test",
        transitionApplying: async () => {},
        releaseLease: async () => ({ cancelled: true }),
        completeLease: async () => ({ completed: true }),
      };
    });
    driver.releaseApply = (async () => {
      order.push("releaseApply");
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
          requested: CANONICAL_IMAGE_REF,
          immutableId: "sha256:1",
        },
        limitations: [],
      };
    }) as typeof driver.releaseApply;

    await driver.upgrade(localProfile, { scope: "server-only" });
    expect(order).toEqual(["topology-preflight", "drain", "releaseApply"]);
  });

  test("remote server-only upgrade resolves manifest composeProjectName before drain", async () => {
    const manifest = validRemoteManifest();
    const order: string[] = [];
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      if (call.cmd === "cat" && call.args.some((a) => a.includes("deployment-manifest.json"))) {
        order.push("read-manifest");
      }
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && isRetiredTopologyPresenceScript(script)) {
        order.push("topology-preflight");
        expect(script).toContain("nautilo-prod");
        return { code: 47, stdout: "", stderr: RETIRED_TOPOLOGY_PRESENCE_REFUSAL };
      }
      return undefined;
    });

    const driver = new ComposeDriver(
      makeDeps(exec, {
        resolveInstanceRootDir: () => manifest.remoteRoot,
      }),
    );
    driver.setMaintenanceDrain(async () => {
      order.push("drain");
      return {
        operationId: "op-test",
        transitionApplying: async () => {},
        releaseLease: async () => ({ cancelled: true }),
        completeLease: async () => ({ completed: true }),
      };
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      driver.upgrade(remoteRegistryProfile, { scope: "server-only" }),
    ).rejects.toThrow(/nautilo upgrade --full/);
    expect(order).toEqual(["read-manifest", "topology-preflight"]);
  });

  test("local server-only upgrade uses profile-derived composeProjectName for retired-topology preflight", async () => {
    const betaProfile: ComposeDriverProfile = { ...localProfile, instance_id: "beta" };
    let topologyScript = "";
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (cmd === "sh" && isRetiredTopologyPresenceScript(joined)) {
        topologyScript = joined;
        return { code: 47, stdout: "", stderr: RETIRED_TOPOLOGY_PRESENCE_REFUSAL };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(betaProfile, { scope: "server-only" })).rejects.toThrow(
      /nautilo upgrade --full/,
    );
    expect(topologyScript).toContain("nautilo-beta");
  });

  test("server-only upgrade refuses retired topology before stop/backup with --full guidance", async () => {
    let sawStop = false;
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (cmd === "sh" && isRetiredTopologyPresenceScript(joined)) {
        return { code: 47, stdout: "", stderr: RETIRED_TOPOLOGY_PRESENCE_REFUSAL };
      }
      if (joined.includes(" stop ") || joined.includes("stop nautilo-server")) {
        sawStop = true;
      }
      if (cmd === "docker" && args[0] === "ps") {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "inspect") {
        return { code: 0, stdout: "nautilo-server:local-dev\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.upgrade(localProfile, { scope: "server-only" })).rejects.toThrow(
      /nautilo upgrade --full/,
    );
    expect(sawStop).toBe(false);
  });

  test("full upgrade runs retired cleanup only after checkServerHealth", async () => {
    const order: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (joined.includes(" stop ") || joined.includes("stop nautilo-server")) {
        order.push("stop");
      }
      if (cmd === "docker" && args[0] === "ps") {
        return { code: 0, stdout: "running-server\n", stderr: "" };
      }
      if (cmd === "docker" && args[0] === "inspect") {
        return { code: 0, stdout: "sha256:source-id\nnautilo-server:local-dev\n", stderr: "" };
      }
      if (cmd === "sh" && isDirectTransportBaselineScript(joined)) {
        order.push("baseline");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "sh" && joined.includes("docker rm -f") && joined.includes("neon-proxy")) {
        order.push("cleanup");
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    driver.backup = (async () => {
      order.push("backup");
      return "/tmp/bundle";
    }) as typeof driver.backup;
    driver.deploy = (async () => {
      order.push("deploy");
    }) as typeof driver.deploy;
    driver.checkServerHealth = (async () => {
      order.push("checkServerHealth");
    }) as typeof driver.checkServerHealth;

    await driver.upgrade(localProfile, { scope: "full" });
    expect(order).toEqual([
      "baseline",
      "stop",
      "backup",
      "deploy",
      "checkServerHealth",
      "cleanup",
    ]);
  });

  test("remote day-two runs direct baseline before pull/write/compose and cleanup after runtime acceptance when retired topology remains", async () => {
    const manifest = validRemoteManifest({
      image: { mode: "registry", reference: "ghcr.io/agentsea/nautilo-server:old-tag" },
    });
    const remoteRoot = manifest.remoteRoot;
    const events: string[] = [];
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && isDirectTransportBaselineScript(script)) {
        events.push("baseline");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (call.cmd === "sh" && script.includes("find_one logto")) {
        return {
          code: 0,
          stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
          stderr: "",
        };
      }
      if (call.cmd === "sh" && isRetiredTopologyPresenceQueryScript(script)) {
        return { code: RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT, stdout: "", stderr: "" };
      }
      if (call.cmd === "sh" && (script.includes("docker pull") || / compose pull /.test(script))) {
        events.push("pull");
      }
      if (
        call.cmd === "sh" &&
        script.includes("docker-compose.yml") &&
        script.includes("base64 -d")
      ) {
        events.push("template");
      }
      if (
        call.cmd === "sh" &&
        script.includes("M231 role-only crypto credential preflight")
      ) {
        events.push("crypto-preflight");
      }
      if (call.cmd === "sh" && script.includes("exec docker compose") && script.includes(" up")) {
        events.push("up");
      }
      if (call.cmd === "sh" && script.includes("docker rm -f")) {
        events.push("cleanup");
      }
      return undefined;
    });

    const driver = new ComposeDriver(
      makeDeps(exec, {
        resolveInstanceRootDir: () => remoteRoot,
      }),
    );
    let healthCalls = 0;
    driver.checkServerHealth = (async () => {
      healthCalls += 1;
      events.push("checkServerHealth");
    }) as typeof driver.checkServerHealth;

    await driver.deploy(remoteRegistryProfile);

    expect(events.indexOf("baseline")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("baseline")).toBeLessThan(events.indexOf("pull"));
    expect(events.indexOf("crypto-preflight")).toBeGreaterThan(
      events.indexOf("baseline"),
    );
    expect(events.indexOf("crypto-preflight")).toBeLessThan(
      events.indexOf("up"),
    );
    expect(events.indexOf("template")).toBeGreaterThan(events.indexOf("baseline"));
    expect(events.indexOf("template")).toBeLessThan(events.indexOf("up"));
    expect(events.indexOf("checkServerHealth")).toBeGreaterThan(events.lastIndexOf("up"));
    expect(events.indexOf("cleanup")).toBeGreaterThan(events.indexOf("checkServerHealth"));
    expect(healthCalls).toBe(1);
  });

  test("remote day-two skips full acceptance and cleanup when retired topology is absent", async () => {
    const manifest = validRemoteManifest({
      image: { mode: "registry", reference: "ghcr.io/agentsea/nautilo-server:old-tag" },
    });
    const events: string[] = [];
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && isDirectTransportBaselineScript(script)) {
        events.push("baseline");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (call.cmd === "sh" && script.includes("find_one logto")) {
        return {
          code: 0,
          stdout: "logto_core_container=6301\nlogto_core=6301\nlogto_admin=6302\nlogto_db=8432\n",
          stderr: "",
        };
      }
      if (call.cmd === "sh" && isRetiredTopologyPresenceQueryScript(script)) {
        return { code: RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT, stdout: "", stderr: "" };
      }
      if (call.cmd === "sh" && (script.includes("docker pull") || / compose pull /.test(script))) {
        events.push("pull");
      }
      if (call.cmd === "sh" && script.includes("docker rm -f")) {
        events.push("cleanup");
      }
      return undefined;
    });

    const driver = new ComposeDriver(
      makeDeps(exec, {
        resolveInstanceRootDir: () => manifest.remoteRoot,
      }),
    );
    let healthCalls = 0;
    driver.checkServerHealth = (async () => {
      healthCalls += 1;
      events.push("checkServerHealth");
    }) as typeof driver.checkServerHealth;

    await driver.deploy(remoteRegistryProfile);

    expect(events).toContain("baseline");
    expect(events).toContain("pull");
    expect(events).not.toContain("checkServerHealth");
    expect(events).not.toContain("cleanup");
    expect(healthCalls).toBe(0);
  });

  test("remote day-two refuses before pull when direct baseline fails", async () => {
    const manifest = validRemoteManifest();
    let sawPull = false;
    const { exec } = makeRemoteLifecycleExec(manifest, (call) => {
      const script = call.args[1] ?? "";
      if (call.cmd === "sh" && isDirectTransportBaselineScript(script)) {
        return { code: 48, stdout: "", stderr: DIRECT_TRANSPORT_BASELINE_REFUSAL };
      }
      if (call.cmd === "sh" && script.includes("docker pull")) {
        sawPull = true;
      }
      return undefined;
    });

    const driver = new ComposeDriver(
      makeDeps(exec, {
        resolveInstanceRootDir: () => manifest.remoteRoot,
      }),
    );

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(driver.deploy(remoteRegistryProfile)).rejects.toThrow(
      /M212 direct-PostgreSQL transport baseline/,
    );
    expect(sawPull).toBe(false);
  });

  test("standalone local deploy runs retired cleanup only after checkServerHealth when retired topology remains", async () => {
    const order: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (joined.includes(" up -d") || (joined.includes(" up ") && joined.includes("nautilo-server"))) {
        order.push("compose-up");
      }
      if (cmd === "sh" && isRetiredTopologyPresenceQueryScript(joined)) {
        return { code: RETIRED_TOPOLOGY_PRESENCE_QUERY_PRESENT, stdout: "", stderr: "" };
      }
      if (cmd === "sh" && joined.includes("docker rm -f") && joined.includes("neon-proxy")) {
        order.push("cleanup");
      }
      if (cmd === "docker" && joined.includes(" volume inspect")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    driver.checkServerHealth = (async () => {
      order.push("checkServerHealth");
    }) as typeof driver.checkServerHealth;

    await driver.deploy(localProfile);
    expect(order.indexOf("checkServerHealth")).toBeGreaterThan(order.indexOf("compose-up"));
    expect(order.indexOf("cleanup")).toBeGreaterThan(order.indexOf("checkServerHealth"));
  });

  test("standalone local deploy skips full acceptance and cleanup when retired topology is absent", async () => {
    const order: string[] = [];
    const exec: ExecFn = async (cmd, args) => {
      const joined = [cmd, ...args].join(" ");
      if (joined.includes(" up -d") || (joined.includes(" up ") && joined.includes("nautilo-server"))) {
        order.push("compose-up");
      }
      if (cmd === "sh" && isRetiredTopologyPresenceQueryScript(joined)) {
        return { code: RETIRED_TOPOLOGY_PRESENCE_QUERY_ABSENT, stdout: "", stderr: "" };
      }
      if (cmd === "sh" && joined.includes("docker rm -f") && joined.includes("neon-proxy")) {
        order.push("cleanup");
      }
      if (cmd === "docker" && joined.includes(" volume inspect")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const driver = new ComposeDriver(makeDeps(exec));
    driver.checkServerHealth = (async () => {
      order.push("checkServerHealth");
    }) as typeof driver.checkServerHealth;

    await driver.deploy(localProfile);
    expect(order).toContain("compose-up");
    expect(order).not.toContain("checkServerHealth");
    expect(order).not.toContain("cleanup");
  });
});
