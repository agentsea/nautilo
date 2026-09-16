import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RedeemInput, RedeemResult } from "@nautilo/api-client";
import type { DeployConfig, ResolvedDeployConfig } from "@nautilo/deploy-config";
import {
  runSetupInstance,
  type SetupInstanceDeps,
  type SetupInstanceStatus,
} from "../../src/commands/setup-instance.ts";

const minimalDeploy: DeployConfig = {
  schemaVersion: 1,
  admin: {
    handle: "owner",
    displayName: "Owner",
    password: { value: "password12345" },
  },
  providers: [],
};

const minimalResolved: ResolvedDeployConfig = {
  ...minimalDeploy,
  admin: {
    handle: "owner",
    displayName: "Owner",
    password: { value: "password12345" },
  },
  providers: [],
};

const resolvedWithPendingProvider: ResolvedDeployConfig = {
  ...minimalResolved,
  providers: [{ key: "OPENAI_API_KEY", value: { value: "sk-test-from-deploy" } }],
};

function baseGuest(overrides: Partial<SetupInstanceStatus>): SetupInstanceStatus {
  return {
    instanceId: "",
    serverUrl: "http://127.0.0.1:9",
    deploymentMode: "local-self-host",
    setupState: "ready",
    claimRequired: false,
    recommendedSetupSurface: { kind: "cli", url: null },
    deployConfigConsumedAt: null,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<SetupInstanceDeps>): SetupInstanceDeps {
  return {
    resolveStatus: async () => baseGuest({}),
    redeemInvite: async () => {
      throw new Error("redeemInvite not stubbed");
    },
    setAuthFromRedeem: () => false,
    consumeProviders: async () => [],
    postReloadEnv: async () => ({ ok: true, status: 200 }),
    stampDeployConsumed: () => {},
    readConsumedStamp: () => null,
    readClaimInvite: () => null,
    loadDeployConfig: () => minimalDeploy,
    resolveSecrets: () => minimalResolved,
    envLookup: () => undefined,
    log: () => {},
    warn: () => {},
    ...overrides,
  };
}

describe("runSetupInstance (M100)", () => {
  test("claimed-needs-auth exits 2 and does not stamp", async () => {
    let stampCalls = 0;
    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () =>
          baseGuest({ setupState: "claimed-needs-auth", claimRequired: true }),
        stampDeployConsumed: () => {
          stampCalls += 1;
        },
      }),
      { instanceId: "", serverUrl: "http://127.0.0.1:9" },
    );
    expect(code).toBe(2);
    expect(stampCalls).toBe(0);
  });

  test("ready + stamped is a no-op (no stamp, no providers, no reload)", async () => {
    let stampCalls = 0;
    let consumeCalls = 0;
    let reloadCalls = 0;
    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () =>
          baseGuest({
            setupState: "ready",
            claimRequired: false,
            deployConfigConsumedAt: "2026-05-01T00:00:00.000Z",
          }),
        stampDeployConsumed: () => {
          stampCalls += 1;
        },
        consumeProviders: async () => {
          consumeCalls += 1;
          return [];
        },
        postReloadEnv: async () => {
          reloadCalls += 1;
          return { ok: true, status: 200 };
        },
      }),
      { instanceId: "", serverUrl: "http://127.0.0.1:9" },
    );
    expect(code).toBe(0);
    expect(stampCalls).toBe(0);
    expect(consumeCalls).toBe(0);
    expect(reloadCalls).toBe(0);
  });

  test("ready + unstamped backfill: providers + stamp, no redeem, no reload-env", async () => {
    const order: string[] = [];
    let redeemCalls = 0;
    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () =>
          baseGuest({
            setupState: "ready",
            claimRequired: false,
            deployConfigConsumedAt: null,
          }),
        redeemInvite: async (_t: string, _b: RedeemInput) => {
          redeemCalls += 1;
          return {} as RedeemResult;
        },
        consumeProviders: async () => {
          order.push("consume");
          return [{ key: "OPENAI_API_KEY", status: "unchanged" }];
        },
        postReloadEnv: async () => {
          order.push("reload");
          return { ok: true, status: 200 };
        },
        stampDeployConsumed: () => {
          order.push("stamp");
        },
      }),
      { instanceId: "", serverUrl: "http://127.0.0.1:9" },
    );
    expect(code).toBe(0);
    expect(redeemCalls).toBe(0);
    expect(order).toEqual(["consume", "stamp"]);
  });

  test("fresh-unclaimed: redeem then providers, reload-env, stamp in order", async () => {
    const order: string[] = [];
    const logs: string[] = [];
    let statusCall = 0;
    const redeemResult: RedeemResult = {
      ok: true,
      logtoSession: { accessToken: "tok", expiresIn: 3600 },
      recoveryCodes: ["rc-1", "rc-2"],
    };

    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () => {
          statusCall += 1;
          if (statusCall === 1) {
            return baseGuest({ setupState: "fresh-unclaimed", claimRequired: true });
          }
          return baseGuest({ setupState: "ready", claimRequired: false });
        },
        redeemInvite: async (_token: string, body: RedeemInput) => {
          order.push("redeem");
          expect(body).toMatchObject({
            handle: "owner",
            displayName: "Owner",
            password: "password12345",
          });
          expect(body.forcePasswordChange).toBe(false);
          return redeemResult;
        },
        setAuthFromRedeem: () => {
          order.push("auth");
          return true;
        },
        consumeProviders: async () => {
          order.push("consume");
          return [{ key: "OPENAI_API_KEY", status: "written" }];
        },
        postReloadEnv: async () => {
          order.push("reload");
          return { ok: true, status: 200 };
        },
        stampDeployConsumed: () => {
          order.push("stamp");
        },
        readClaimInvite: () => "inv_token",
        log: (s) => logs.push(s),
      }),
      { instanceId: "beta", serverUrl: "http://127.0.0.1:3001" },
    );

    expect(code).toBe(0);
    expect(order).toEqual(["redeem", "auth", "consume", "reload", "stamp"]);
    expect(logs.join("\n")).toContain("Recovery codes");
    expect(logs.join("\n")).toContain("rc-1");
  });

  test("fresh-unclaimed: no session token still prints recovery codes before exiting 2", async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    let statusCall = 0;

    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () => {
          statusCall += 1;
          return statusCall === 1
            ? baseGuest({ setupState: "fresh-unclaimed", claimRequired: true })
            : baseGuest({ setupState: "claimed-needs-auth", claimRequired: false });
        },
        redeemInvite: async () => ({
          ok: true,
          recoveryCodes: ["rc-alpha", "rc-beta"],
        }),
        setAuthFromRedeem: () => false,
        readClaimInvite: () => "inv_token",
        log: (s) => logs.push(s),
        warn: (s) => warns.push(s),
      }),
      { instanceId: "beta", serverUrl: "http://127.0.0.1:3001" },
    );

    expect(code).toBe(2);
    expect(logs.join("\n")).toContain("Recovery codes");
    expect(logs.join("\n")).toContain("rc-alpha");
    expect(warns.join("\n")).toContain("recovery codes were printed above");
  });
});

describe("runSetupInstance — D173 keys-write fall-through (claimed-needs-auth + used_up)", () => {
  let tmpDir: string;
  let prevDotenv: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nautilo-setup-d173-"));
    const envPath = join(tmpDir, "instance.env");
    writeFileSync(envPath, "", "utf8");
    prevDotenv = process.env["NAUTILO_DOTENV_PATH"];
    process.env["NAUTILO_DOTENV_PATH"] = envPath;
  });

  afterEach(() => {
    if (prevDotenv !== undefined) process.env["NAUTILO_DOTENV_PATH"] = prevDotenv;
    else delete process.env["NAUTILO_DOTENV_PATH"];
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("used_up + pending provider rows → skip D157 error, consume keys, exit 0", async () => {
    const logs: string[] = [];
    let redeemCalls = 0;
    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () =>
          baseGuest({ setupState: "claimed-needs-auth", claimRequired: false }),
        readClaimInvite: () => "claim-token",
        redeemInvite: async () => {
          redeemCalls += 1;
          throw new Error("used_up");
        },
        resolveSecrets: () => resolvedWithPendingProvider,
        consumeProviders: async () => [{ key: "OPENAI_API_KEY", status: "written" }],
        stampDeployConsumed: () => {},
        log: (s) => logs.push(s),
      }),
      { instanceId: "d173", serverUrl: "http://127.0.0.1:3001" },
    );
    expect(code).toBe(0);
    expect(redeemCalls).toBe(1);
    expect(logs.some((l) => l.includes("skipping D157 recovery branch"))).toBe(true);
  });

  test("claimed-needs-auth + redeem succeeds (unused invite) → D157 recovery still runs redeem once", async () => {
    let redeemCalls = 0;
    const redeemResult: RedeemResult = {
      ok: true,
      logtoSession: { accessToken: "tok", expiresIn: 3600 },
    };
    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () =>
          baseGuest({ setupState: "claimed-needs-auth", claimRequired: false }),
        readClaimInvite: () => "claim-token",
        redeemInvite: async () => {
          redeemCalls += 1;
          return redeemResult;
        },
        setAuthFromRedeem: () => true,
        consumeProviders: async () => [],
      }),
      { instanceId: "d157-unused", serverUrl: "http://127.0.0.1:3001" },
    );
    expect(code).toBe(0);
    expect(redeemCalls).toBe(1);
  });

  test("used_up + empty providers → exit 2 (no fall-through), message does not push workbench sign-in", async () => {
    const warns: string[] = [];
    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () =>
          baseGuest({ setupState: "claimed-needs-auth", claimRequired: false }),
        readClaimInvite: () => "claim-token",
        redeemInvite: async () => {
          throw new Error("used_up");
        },
        resolveSecrets: () => minimalResolved,
        warn: (s) => warns.push(s),
      }),
      { instanceId: "d173-empty-prov", serverUrl: "http://127.0.0.1:3001" },
    );
    expect(code).toBe(2);
    const joined = warns.join("\n");
    expect(joined).toContain("re-redeem attempt FAILED");
    expect(joined.toLowerCase()).not.toContain("sign in via workbench");
    expect(joined.toLowerCase()).not.toContain("workbench or");
  });

  test("server-needs-keys → no redeem, providers applied, exit 0", async () => {
    let redeemCalls = 0;
    const order: string[] = [];
    const code = await runSetupInstance(
      baseDeps({
        resolveStatus: async () =>
          baseGuest({ setupState: "server-needs-keys", claimRequired: false }),
        redeemInvite: async () => {
          redeemCalls += 1;
          return {} as RedeemResult;
        },
        consumeProviders: async () => {
          order.push("consume");
          return [{ key: "OPENAI_API_KEY", status: "unchanged" }];
        },
        stampDeployConsumed: () => {
          order.push("stamp");
        },
      }),
      { instanceId: "srv-keys", serverUrl: "http://127.0.0.1:3001" },
    );
    expect(code).toBe(0);
    expect(redeemCalls).toBe(0);
    expect(order).toEqual(["consume", "stamp"]);
  });
});
