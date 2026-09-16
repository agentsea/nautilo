import { afterEach, describe, expect, test } from "bun:test";
import type { ResolvedInstance } from "@nautilo/config";
import { buildServerOverlayEnv } from "../../src/buildServerOverlayEnv.ts";

function inst(corePort: number): ResolvedInstance {
  return {
    schemaVersion: 1,
    instanceId: "",
    server: { host: "127.0.0.1", port: 4001, url: "http://localhost:4001" },
    workbench: { port: 4000, url: "http://localhost:4000" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:6434/nautilo",
      postgresHostPort: 6434,
    },
    logto: { dbPort: 6432, corePort, adminPort: corePort + 1 },
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

function namedInst(corePort: number, instanceId: string): ResolvedInstance {
  const base = inst(corePort);
  return {
    ...base,
    instanceId,
    compose: {
      ...base.compose,
      projectName: `nautilo-${instanceId}`,
    },
  };
}

describe("buildServerOverlayEnv", () => {
  const prevHosting = process.env["NAUTILO_HOSTING_MODE"];
  const prevDriver = process.env["NAUTILO_PASSWORD_RECOVERY_DRIVER"];

  afterEach(() => {
    if (prevHosting === undefined) delete process.env["NAUTILO_HOSTING_MODE"];
    else process.env["NAUTILO_HOSTING_MODE"] = prevHosting;
    if (prevDriver === undefined) delete process.env["NAUTILO_PASSWORD_RECOVERY_DRIVER"];
    else process.env["NAUTILO_PASSWORD_RECOVERY_DRIVER"] = prevDriver;
  });

  test("rewrites LOGTO_JWKS_URI from localhost to logto container DNS", () => {
    const env = buildServerOverlayEnv(inst(4301), {
      LOGTO_JWKS_URI: "http://localhost:4301/oidc/jwks",
      LOGTO_ISSUER: "http://localhost:4301/oidc",
      LOGTO_ENDPOINT: "http://localhost:4301",
      LOGTO_RESOURCE: "https://api.nautilo.local",
      LOGTO_M2M_APP_ID: "m2m-id",
      LOGTO_M2M_APP_SECRET: "m2m-secret",
      LOGTO_WORKBENCH_APP_ID: "wb",
      LOGTO_TUI_APP_ID: "tui",
      LOGTO_TUI_LOOPBACK_APP_ID: "tuilb",
      LOGTO_DESKTOP_APP_ID: "dsk",
      LOGTO_MOBILE_APP_ID: "mob",
      LOGTO_MOBILE_WEB_APP_ID: "mob-web",
    });
    expect(env["LOGTO_JWKS_URI"]).toBe("http://logto:4301/oidc/jwks");
    // LOGTO_ISSUER is NOT rewritten — must match Logto's iss claim.
    expect(env["LOGTO_ISSUER"]).toBe("http://localhost:4301/oidc");
    // LOGTO_ENDPOINT stays host-facing for workbench / desktop /
    // /health response (browser cannot resolve docker DNS).
    expect(env["LOGTO_ENDPOINT"]).toBe("http://localhost:4301");
    // LOGTO_ENDPOINT_INTERNAL is the container-DNS sibling the server
    // uses for fetches (Management API, clock-skew, bearer mint).
    expect(env["LOGTO_ENDPOINT_INTERNAL"]).toBe("http://logto:4301");
    expect(env["LOGTO_RESOURCE"]).toBe("https://api.nautilo.local");
    expect(env["LOGTO_M2M_APP_ID"]).toBe("m2m-id");
    expect(env["LOGTO_M2M_APP_SECRET"]).toBe("m2m-secret");
    expect(env["LOGTO_WORKBENCH_APP_ID"]).toBe("wb");
    expect(env["LOGTO_TUI_APP_ID"]).toBe("tui");
    expect(env["LOGTO_TUI_LOOPBACK_APP_ID"]).toBe("tuilb");
    expect(env["LOGTO_DESKTOP_APP_ID"]).toBe("dsk");
    expect(env["LOGTO_MOBILE_APP_ID"]).toBe("mob");
    expect(env["LOGTO_MOBILE_WEB_APP_ID"]).toBe("mob-web");
    expect(env["NAUTILO_PUBLIC_BASE_URL"]).toBe("http://localhost:4001");
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("");
    expect(env["NAUTILO_PASSWORD_RECOVERY_DRIVER"]).toBe("oss_relay");
  });

  test("threads instance id into server overlay so deploy DB identity is stamped correctly", () => {
    const env = buildServerOverlayEnv(namedInst(4301, "beta"), {});
    expect(env["NAUTILO_INSTANCE_ID"]).toBe("beta");
  });

  test("threads the guarded remote pairing pepper into only the server overlay", () => {
    const pepper = "a".repeat(64);
    const env = buildServerOverlayEnv(inst(4301), {}, { remotePairingPepper: pepper });
    expect(env["NAUTILO_REMOTE_PAIRING_PEPPER"]).toBe(pepper);
  });

  test("does not emit a blank remote pairing pepper", () => {
    const env = buildServerOverlayEnv(inst(4301), {}, { remotePairingPepper: "   " });
    expect(env["NAUTILO_REMOTE_PAIRING_PEPPER"]).toBeUndefined();
  });

  test("threads the guarded push-token encryption key into only the server overlay", () => {
    const key = "b".repeat(64);
    const env = buildServerOverlayEnv(inst(4301), {}, { pushTokenEncryptionKey: key });
    expect(env["NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY"]).toBe(key);
  });

  test("does not emit a blank push-token encryption key", () => {
    const env = buildServerOverlayEnv(inst(4301), {}, { pushTokenEncryptionKey: "   " });
    expect(env["NAUTILO_PUSH_TOKEN_ENCRYPTION_KEY"]).toBeUndefined();
  });

  test("preserves a LOGTO_JWKS_URI that does not match the host pattern", () => {
    const env = buildServerOverlayEnv(inst(4301), {
      LOGTO_JWKS_URI: "https://example.com/jwks",
    });
    expect(env["LOGTO_JWKS_URI"]).toBe("https://example.com/jwks");
  });

  test("remote public IP endpoint gets container-DNS server fetch paths", () => {
    const env = buildServerOverlayEnv(inst(5201), {
      LOGTO_ENDPOINT: "http://203.0.113.30:5201",
      LOGTO_ISSUER: "http://203.0.113.30:5201/oidc",
      LOGTO_JWKS_URI: "http://203.0.113.30:5201/oidc/jwks",
      LOGTO_M2M_APP_ID: "m2m-id",
      LOGTO_M2M_APP_SECRET: "m2m-secret",
    });
    expect(env["LOGTO_ENDPOINT"]).toBe("http://203.0.113.30:5201");
    expect(env["LOGTO_ENDPOINT_INTERNAL"]).toBe("http://logto:5201");
    expect(env["LOGTO_JWKS_URI"]).toBe("http://logto:5201/oidc/jwks");
    expect(env["LOGTO_ISSUER"]).toBe("http://203.0.113.30:5201/oidc");
  });

  test("preserves a custom LOGTO_ENDPOINT and does NOT emit _INTERNAL for it", () => {
    // Operator-supplied custom URL is left alone — they already
    // routed it. We don't second-guess by emitting a container-DNS
    // sibling that may not match their topology.
    const env = buildServerOverlayEnv(inst(4301), {
      LOGTO_ENDPOINT: "https://logto.example.com",
    });
    expect(env["LOGTO_ENDPOINT"]).toBe("https://logto.example.com");
    expect(env["LOGTO_ENDPOINT_INTERNAL"]).toBeUndefined();
  });

  test("uses an inspected remote core port instead of stale operator-local metadata", () => {
    const env = buildServerOverlayEnv(
      inst(4501),
      {
        LOGTO_ENDPOINT: "https://auth.beta.example.test",
        LOGTO_ISSUER: "https://auth.beta.example.test/oidc",
        LOGTO_JWKS_URI: "https://auth.beta.example.test/oidc/jwks",
      },
      { containerCorePort: 6301 },
    );

    expect(env["LOGTO_ENDPOINT"]).toBe("https://auth.beta.example.test");
    expect(env["LOGTO_ISSUER"]).toBe("https://auth.beta.example.test/oidc");
    expect(env["LOGTO_JWKS_URI"]).toBe("http://logto:6301/oidc/jwks");
    expect(env["LOGTO_JWKS_URI"]).not.toContain("4501");
  });

  test("skips keys that are absent from instance.env", () => {
    const env = buildServerOverlayEnv(inst(4301), {
      LOGTO_M2M_APP_ID: "only-this",
    });
    expect(env).toEqual({
      NAUTILO_INSTANCE_ID: "",
      NAUTILO_PUBLIC_BASE_URL: "http://localhost:4001",
      NAUTILO_PASSWORD_RECOVERY_DRIVER: "oss_relay",
      LOGTO_M2M_APP_ID: "only-this",
    });
  });

  test("rewrite uses the resolved instance's corePort, not a fixed 3301", () => {
    const env = buildServerOverlayEnv(inst(4301), {
      LOGTO_JWKS_URI: "http://localhost:4301/oidc/jwks",
    });
    expect(env["LOGTO_JWKS_URI"]).toBe("http://logto:4301/oidc/jwks");
  });

  test("cloud mode defaults server overlay to Logto-native recovery", () => {
    process.env["NAUTILO_HOSTING_MODE"] = "cloud";
    delete process.env["NAUTILO_PASSWORD_RECOVERY_DRIVER"];
    const env = buildServerOverlayEnv(inst(4301), {});
    expect(env["NAUTILO_PASSWORD_RECOVERY_DRIVER"]).toBe("logto_native");
  });
});
