import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedInstance } from "@nautilo/config";
import {
  bootstrapLogtoForProfile,
  type RunBootstrapFn,
} from "../../src/bootstrapLogtoForProfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

const tmpDirs: string[] = [];

function mktmp(): string {
  const d = mkdtempSync(join(tmpdir(), "compose-driver-bootstrap-"));
  tmpDirs.push(d);
  return d;
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

const baseProfile: ComposeDriverProfile = {
  name: "local-default",
  transport: "local",
  lifecycle: "compose",
  from_source: true,
};

function fakeInstance(corePort: number, dbPort: number): ResolvedInstance {
  return {
    schemaVersion: 1,
    instanceId: "",
    server: { host: "127.0.0.1", port: 4001, url: "http://localhost:4001" },
    workbench: { port: 4000, url: "http://localhost:4000" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:6434/nautilo",
      postgresHostPort: 6434,
    },
    logto: { dbPort, corePort, adminPort: corePort + 1 },
    compose: {
      projectName: "nautilo",
      containers: {
        legacyPostgres: "x",
        logtoPostgres: "x",
        logtoCore: "x",
        logtoSeed: "x",
      },
    },
    hostname: {
      federated: "nautilo.local",
      mdns: "nautilo.local",
      tlsSan: "",
      caddyAuthHost: "auth.nautilo.local",
      caddyAuthAdminHost: "auth-admin.nautilo.local",
    },
  };
}

describe("bootstrapLogtoForProfile", () => {
  let savedHome: string | undefined;
  let savedInstance: string | undefined;
  let hadInstanceKey = false;
  let savedDotenvPath: string | undefined;
  let hadDotenvPathKey = false;

  beforeEach(() => {
    savedHome = process.env["HOME"];
    savedInstance = process.env["NAUTILO_INSTANCE_ID"];
    hadInstanceKey = "NAUTILO_INSTANCE_ID" in process.env;
    savedDotenvPath = process.env["NAUTILO_DOTENV_PATH"];
    hadDotenvPathKey = "NAUTILO_DOTENV_PATH" in process.env;
    process.env["HOME"] = mktmp();
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env["HOME"] = savedHome;
    else delete process.env["HOME"];
    if (hadInstanceKey) {
      process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    } else {
      delete process.env["NAUTILO_INSTANCE_ID"];
    }
    if (hadDotenvPathKey) {
      process.env["NAUTILO_DOTENV_PATH"] = savedDotenvPath;
    } else {
      delete process.env["NAUTILO_DOTENV_PATH"];
    }
  });

  test("calls runBootstrap with port-shifted overrides derived from resolved instance", async () => {
    const calls: Array<Parameters<RunBootstrapFn>[0]> = [];
    let observedInstanceIdAtCall: string | undefined;
    const fakeRunBootstrap: RunBootstrapFn = async (opts) => {
      calls.push(opts);
      observedInstanceIdAtCall = process.env["NAUTILO_INSTANCE_ID"];
    };

    await bootstrapLogtoForProfile(baseProfile, {
      runBootstrap: fakeRunBootstrap,
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => "/tmp/instance.env",
      resolveInstance: () => fakeInstance(4301, 6432),
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.endpoint).toBe("http://localhost:4301");
    expect(calls[0]?.postgresUrl).toBe(
      "postgres://logto:logto@localhost:6432/logto_nautilo",
    );
    expect(calls[0]?.envPath).toBe("/tmp/instance.env");
    expect(observedInstanceIdAtCall).toBe("");
  });

  test("M116 — uses dbPasswords.logto in postgresUrl when provided", async () => {
    const calls: Array<Parameters<RunBootstrapFn>[0]> = [];
    const fakeRunBootstrap: RunBootstrapFn = async (opts) => {
      calls.push(opts);
    };

    await bootstrapLogtoForProfile(baseProfile, {
      runBootstrap: fakeRunBootstrap,
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => "/tmp/instance.env",
      resolveInstance: () => fakeInstance(4301, 6432),
      dbPasswords: {
        appDbPassword: "x_app",
        postgresPassword: "x_pg",
        nautilo: "x_nautilo",
        logto: "deadbeef".repeat(6),
        nautiloAgent: "x_agent",
        nautiloCrypto: "fake_crypto_pw",
      },
    });

    expect(calls[0]?.postgresUrl).toBe(
      `postgres://logto:${"deadbeef".repeat(6)}@localhost:6432/logto_nautilo`,
    );
  });

  test("remote tunnel ports override operator instance ports without changing the public endpoint", async () => {
    const root = mktmp();
    const remoteProfile: ComposeDriverProfile = {
      name: "remote-port-authority",
      transport: "remote",
      lifecycle: "compose",
      ssh: { host: "203.0.113.20", user: "root" },
      domain: "example.test",
      https: "letsencrypt",
      acme_email: "ops@example.test",
    };
    const resolved = fakeInstance(4501, 6632);
    let captured: Parameters<RunBootstrapFn>[0];
    await bootstrapLogtoForProfile(remoteProfile, {
      runBootstrap: async (options) => {
        captured = options;
      },
      resolveInstance: () => resolved,
      resolveDotenvPath: () => join(root, "instance.env"),
      remoteTunnelPorts: { core: 6301, admin: 6302, db: 8432 },
    });

    expect(captured?.endpoint).toBe("https://auth.example.test");
    expect(captured?.adminEndpoint).toBe("http://127.0.0.1:6302");
    expect(captured?.defaultTenantEndpoint).toBe("http://127.0.0.1:6301");
    expect(captured?.postgresUrl).toContain("@localhost:8432/");
  });

  test("writes a secret-free applied contract atomically only after bootstrap succeeds", async () => {
    const root = mktmp();
    const envPath = join(root, "instance.env");
    await bootstrapLogtoForProfile(baseProfile, {
      runBootstrap: async () => {},
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => envPath,
      resolveInstance: () => fakeInstance(4301, 6432),
    });

    const stampPath = join(root, "auth-contract-applied.json");
    expect(existsSync(stampPath)).toBe(true);
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(stamp).sort()).toEqual([
      "appliedAt",
      "contractHash",
      "contractVersion",
      "logtoEngine",
    ]);
    expect(stamp["contractHash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stamp)).not.toContain("secret");
  });

  test("does not write an applied contract when bootstrap fails", async () => {
    const root = mktmp();
    const envPath = join(root, "instance.env");
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      bootstrapLogtoForProfile(baseProfile, {
        runBootstrap: async () => {
          throw new Error("bootstrap failed");
        },
        resetResolvedInstanceCache: () => {},
        resolveDotenvPath: () => envPath,
        resolveInstance: () => fakeInstance(4301, 6432),
      }),
    ).rejects.toThrow("bootstrap failed");
    expect(existsSync(join(root, "auth-contract-applied.json"))).toBe(false);
  });

  test("sets NAUTILO_INSTANCE_ID to profile's id during the call, restores afterwards", async () => {
    process.env["NAUTILO_INSTANCE_ID"] = "previous";
    let observed: string | undefined;
    const fakeRunBootstrap: RunBootstrapFn = async () => {
      observed = process.env["NAUTILO_INSTANCE_ID"];
    };
    await bootstrapLogtoForProfile(
      { ...baseProfile, instance_id: "beta" },
      {
        runBootstrap: fakeRunBootstrap,
        resetResolvedInstanceCache: () => {},
        resolveDotenvPath: () => "/tmp/x",
        resolveInstance: () => fakeInstance(5301, 7432),
      },
    );
    expect(observed).toBe("beta");
    expect(process.env["NAUTILO_INSTANCE_ID"]).toBe("previous");
  });

  test("pins config-guard writes to the explicit env path and restores the prior override", async () => {
    process.env["NAUTILO_DOTENV_PATH"] = "/tmp/prior.env";
    let observed: string | undefined;
    await bootstrapLogtoForProfile(baseProfile, {
      runBootstrap: async () => {
        observed = process.env["NAUTILO_DOTENV_PATH"];
      },
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => "/tmp/reconcile.env",
      resolveInstance: () => fakeInstance(4301, 6432),
    });

    expect(observed).toBe("/tmp/reconcile.env");
    expect(process.env["NAUTILO_DOTENV_PATH"]).toBe("/tmp/prior.env");
  });

  test("M117 — https=letsencrypt threads workbench LE redirect URIs into runBootstrap", async () => {
    const calls: Array<Parameters<RunBootstrapFn>[0]> = [];
    const fakeRunBootstrap: RunBootstrapFn = async (opts) => {
      calls.push(opts);
    };

    const remoteLeProfile: ComposeDriverProfile = {
      name: "omega",
      transport: "remote",
      lifecycle: "compose",
      from_source: true,
      ssh: { host: "203.0.113.30", user: "root" },
      domain: "nautilo.example.test",
      https: "letsencrypt",
      acme_email: "ops@example.com",
    };

    await bootstrapLogtoForProfile(remoteLeProfile, {
      runBootstrap: fakeRunBootstrap,
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => "/tmp/instance.env",
      resolveInstance: () => fakeInstance(5301, 7432),
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.extraWorkbenchRedirectUris).toEqual([
      "https://nautilo.example.test/auth/callback",
    ]);
    expect(calls[0]?.extraWorkbenchPostLogoutUris).toEqual([
      "https://nautilo.example.test",
      "https://nautilo.example.test/logout",
    ]);
    // Endpoint should also be the LE auth URL (per resolveLogtoPublicUrl).
    expect(calls[0]?.endpoint).toBe("https://auth.nautilo.example.test");
    // Remote bootstrap mints its admin token and calls the default tenant
    // through SSH-forwarded loopback endpoints, independent of public DNS.
    expect(calls[0]?.adminEndpoint).toBe("http://127.0.0.1:5302");
    expect(calls[0]?.defaultTenantEndpoint).toBe("http://127.0.0.1:5301");
  });

  test("M117 — https=off does NOT pass extra workbench redirect URIs", async () => {
    const calls: Array<Parameters<RunBootstrapFn>[0]> = [];
    const fakeRunBootstrap: RunBootstrapFn = async (opts) => {
      calls.push(opts);
    };

    await bootstrapLogtoForProfile(baseProfile, {
      runBootstrap: fakeRunBootstrap,
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => "/tmp/instance.env",
      resolveInstance: () => fakeInstance(4301, 6432),
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.extraWorkbenchRedirectUris).toBeUndefined();
    expect(calls[0]?.extraWorkbenchPostLogoutUris).toBeUndefined();
  });

  test("M120 — threads forgotPasswordRelay (container-DNS endpoint + secret) when a webhook secret is provided", async () => {
    const calls: Array<Parameters<RunBootstrapFn>[0]> = [];
    const fakeRunBootstrap: RunBootstrapFn = async (opts) => {
      calls.push(opts);
    };

    await bootstrapLogtoForProfile(baseProfile, {
      runBootstrap: fakeRunBootstrap,
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => "/tmp/instance.env",
      resolveInstance: () => fakeInstance(4301, 6432),
      forgotPasswordWebhookSecret: "s3cr3t",
    });

    expect(calls[0]?.forgotPasswordRelay).toEqual({
      webhookEndpoint: "http://nautilo-server:3001/api/internal/logto/email-webhook",
      webhookSecret: "s3cr3t",
    });
    expect(calls[0]?.unknownSessionRedirectUrl).toBe("http://localhost:4001");
  });

  test("M120 — no forgotPasswordRelay when no webhook secret is provided", async () => {
    const calls: Array<Parameters<RunBootstrapFn>[0]> = [];
    const fakeRunBootstrap: RunBootstrapFn = async (opts) => {
      calls.push(opts);
    };

    await bootstrapLogtoForProfile(baseProfile, {
      runBootstrap: fakeRunBootstrap,
      resetResolvedInstanceCache: () => {},
      resolveDotenvPath: () => "/tmp/instance.env",
      resolveInstance: () => fakeInstance(4301, 6432),
    });

    expect(calls[0]?.forgotPasswordRelay).toBeUndefined();
  });

  test("restores NAUTILO_INSTANCE_ID even when runBootstrap throws", async () => {
    delete process.env["NAUTILO_INSTANCE_ID"];
    process.env["NAUTILO_DOTENV_PATH"] = "/tmp/prior.env";
    const fakeRunBootstrap: RunBootstrapFn = async () => {
      throw new Error("boom");
    };
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun `expect().rejects`
    await expect(
      bootstrapLogtoForProfile(baseProfile, {
        runBootstrap: fakeRunBootstrap,
        resetResolvedInstanceCache: () => {},
        resolveDotenvPath: () => "/tmp/x",
        resolveInstance: () => fakeInstance(4301, 6432),
      }),
    ).rejects.toThrow(/boom/);
    expect("NAUTILO_INSTANCE_ID" in process.env).toBe(false);
    expect(process.env["NAUTILO_DOTENV_PATH"]).toBe("/tmp/prior.env");
  });
});
