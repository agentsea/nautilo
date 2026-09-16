import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetResolvedInstanceForTests, resolveInstance } from "@nautilo/config";
import { NAUTILO_REPO_ROOT } from "../../src/lib/compose-infra";
import {
  applyNautiloWorkbenchDistEnvIfUnset,
  ensureServerCapabilitySecrets,
  serverDaemonEnv,
} from "../../src/commands/server-start";

function minimalInstanceJson(instanceId: string, serverPort: number, workbenchDist?: string): string {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    instanceId,
    server: { host: "127.0.0.1", port: serverPort, url: `http://127.0.0.1:${serverPort}` },
    workbench: { port: serverPort + 1, url: `http://127.0.0.1:${serverPort + 1}` },
    db: {
      directConnection: "postgresql://x",
      postgresHostPort: 5434,
    },
    logto: { dbPort: 5432, corePort: 3301, adminPort: 3302 },
    compose: { projectName: `nautilo-${instanceId || "default"}` },
    hostname: {
      federated: "n.local",
      mdns: "n.local",
      tlsSan: "n.local",
      caddyAuthHost: "a.local",
      caddyAuthAdminHost: "aa.local",
    },
  };
  if (workbenchDist !== undefined) {
    base["workbenchDist"] = workbenchDist;
  }
  return `${JSON.stringify(base)}\n`;
}

describe("D172 applyNautiloWorkbenchDistEnvIfUnset", () => {
  let userHomeDir: string;
  const prev: Partial<Record<string, string | undefined>> = {};

  beforeEach(() => {
    __resetResolvedInstanceForTests();
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-srvstart-"));
    for (const k of ["HOME", "USERPROFILE", "NAUTILO_INSTANCE_ID", "NAUTILO_WORKBENCH_DIST"] as const) {
      prev[k] = process.env[k];
    }
    process.env["HOME"] = userHomeDir;
    process.env["USERPROFILE"] = userHomeDir;
    delete process.env["NAUTILO_WORKBENCH_DIST"];
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
    for (const k of Object.keys(prev)) {
      const v = prev[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  test("env unset + instance.json absent → repo-root fallback + log", () => {
    process.env["NAUTILO_INSTANCE_ID"] = "";
    const logs: string[] = [];
    applyNautiloWorkbenchDistEnvIfUnset("", (s) => logs.push(s));
    const expected = join(NAUTILO_REPO_ROOT, "apps/workbench/dist");
    expect(process.env["NAUTILO_WORKBENCH_DIST"]).toBe(expected);
    expect(logs.some((l) => l.includes("[server-start] resolved NAUTILO_WORKBENCH_DIST"))).toBe(true);
    expect(logs.some((l) => l.includes("repo-root fallback"))).toBe(true);
  });

  test("env unset + instance.json with workbenchDist → persisted path + log", () => {
    process.env["NAUTILO_INSTANCE_ID"] = "beta";
    const root = join(userHomeDir, ".nautilo-beta");
    mkdirSync(root, { recursive: true });
    const persistedPath = join(userHomeDir, "custom-workbench", "dist");
    writeFileSync(join(root, "instance.json"), minimalInstanceJson("beta", 3101, persistedPath), "utf8");

    const logs: string[] = [];
    applyNautiloWorkbenchDistEnvIfUnset("beta", (s) => logs.push(s));
    expect(process.env["NAUTILO_WORKBENCH_DIST"]).toBe(persistedPath);
    expect(logs.some((l) => l.includes("instance.json"))).toBe(true);
  });

  test("env var already set → no resolution log", () => {
    process.env["NAUTILO_INSTANCE_ID"] = "";
    process.env["NAUTILO_WORKBENCH_DIST"] = "/already/set/dist";
    const logs: string[] = [];
    applyNautiloWorkbenchDistEnvIfUnset("", (s) => logs.push(s));
    expect(process.env["NAUTILO_WORKBENCH_DIST"]).toBe("/already/set/dist");
    expect(logs.some((l) => l.includes("[server-start] resolved NAUTILO_WORKBENCH_DIST"))).toBe(false);
  });

  test("persisted value points at non-existent dir → still uses persisted string", () => {
    process.env["NAUTILO_INSTANCE_ID"] = "gamma";
    const root = join(userHomeDir, ".nautilo-gamma");
    mkdirSync(root, { recursive: true });
    const ghost = join(userHomeDir, "nope-not-here", "dist");
    writeFileSync(join(root, "instance.json"), minimalInstanceJson("gamma", 3202, ghost), "utf8");

    const logs: string[] = [];
    applyNautiloWorkbenchDistEnvIfUnset("gamma", (s) => logs.push(s));
    expect(process.env["NAUTILO_WORKBENCH_DIST"]).toBe(ghost);
    expect(existsSync(ghost)).toBe(false);
    expect(logs.some((l) => l.includes("[server-start] resolved NAUTILO_WORKBENCH_DIST"))).toBe(true);
  });

  test("named instances replace restored runtime DB URLs with their allocated ports", () => {
    const inst = {
      server: {
        host: "127.0.0.1",
        port: 6101,
        url: "http://127.0.0.1:6101",
      },
      db: {
        directConnection: "postgresql://postgres:postgres@localhost:6134/nautilo",
        postgresHostPort: 6134,
      },
    } as ReturnType<typeof resolveInstance>;
    const env = serverDaemonEnv(inst, "d425-source", {
      DB_CONNECTION_STRING: "postgres://nautilo:stale@localhost:4445/nautilo",
      DB_AGENT_CONNECTION_STRING: "postgres://nautilo_agent:stale@localhost:4445/nautilo",
      NAUTILO_DB_PASSWORD: "restored-app",
      NAUTILO_AGENT_DB_PASSWORD: "restored-agent",
      NAUTILO_CRYPTO_DB_PASSWORD: "restored-crypto",
    });

    expect(env["DB_CONNECTION_STRING"]).toBe("postgres://nautilo:restored-app@localhost:6134/nautilo");
    expect(env["DB_AGENT_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_agent:restored-agent@localhost:6134/nautilo",
    );
    expect(env["DB_CRYPTO_CONNECTION_STRING"]).toBe(
      "postgres://nautilo_crypto:restored-crypto@localhost:6134/nautilo",
    );
    expect(env["NAUTILO_CRYPTO_DB_PASSWORD"]).toBeUndefined();
    expect(env["NAUTILO_OPENCONNECTOR_BASE_URL"]).toBe("http://127.0.0.1:6110");
  });
});

describe("server capability secret provisioning", () => {
  test("provisions every server capability secret before startup", async () => {
    const calls: string[] = [];

    await ensureServerCapabilitySecrets("/tmp/nautilo-test-instance", {
      ensureRemotePairingPepper: async (rootDir) => {
        calls.push(`pairing:${rootDir}`);
      },
      ensurePushTokenEncryptionKey: async (rootDir) => {
        calls.push(`push:${rootDir}`);
      },
    });

    expect(calls).toEqual([
      "pairing:/tmp/nautilo-test-instance",
      "push:/tmp/nautilo-test-instance",
    ]);
  });
});
