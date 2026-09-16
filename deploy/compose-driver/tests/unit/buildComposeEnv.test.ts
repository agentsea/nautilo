import { describe, expect, test } from "bun:test";
import type { ResolvedInstance } from "@nautilo/config";
import { buildComposeEnv } from "../../src/buildComposeEnv.ts";
import type { DbPasswords } from "../../src/ensureDbPasswords.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

function fakePasswords(): DbPasswords {
  return {
    appDbPassword: "test_app_pw",
    postgresPassword: "test_pg_pw",
    nautilo: "test_nautilo_pw",
    logto: "test_logto_pw",
    nautiloAgent: "test_agent_pw",
    nautiloCrypto: "test_crypto_pw",
  };
}

function fakeInstance(over: Partial<ResolvedInstance> = {}): ResolvedInstance {
  const base: ResolvedInstance = {
    schemaVersion: 1,
    instanceId: "",
    server: { host: "127.0.0.1", port: 4001, url: "http://localhost:4001" },
    workbench: { port: 4000, url: "http://localhost:4000" },
    db: {
      directConnection: "postgresql://postgres:postgres@localhost:6434/nautilo",
      postgresHostPort: 6434,
    },
    logto: { dbPort: 6432, corePort: 4301, adminPort: 4302 },
    compose: {
      projectName: "nautilo",
      containers: {
        legacyPostgres: "nautilo-legacy-postgres-1",
        logtoPostgres: "nautilo-logto-postgres-1",
        logtoCore: "nautilo-logto-1",
        logtoSeed: "nautilo-logto-seed-1",
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
  return { ...base, ...over };
}

function profile(over: Partial<ComposeDriverProfile> = {}): ComposeDriverProfile {
  return {
    name: "local-default",
    transport: "local",
    lifecycle: "compose",
    from_source: true,
    ...over,
  };
}

describe("buildComposeEnv", () => {
  test("emits the exact key set listed in .env.local-smoke.example", () => {
    const env = buildComposeEnv(profile(), fakeInstance(), fakePasswords(), {
      sourceBuildSha: "a".repeat(40),
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "APP_DB_PASSWORD",
        "COMPOSE_PROJECT_NAME",
        "LOGTO_ADMIN_ENDPOINT",
        "LOGTO_CONTAINER_ADMIN_ENDPOINT",
        "LOGTO_DB_PASSWORD",
        "LOGTO_ENDPOINT",
        "LOGTO_IMAGE",
        "LOGTO_IMAGE_TAG",
        "LOGTO_TRUST_PROXY",
        "PGVECTOR_IMAGE",
        "POSTGRES_IMAGE",
        "NAUTILO_AGENT_DB_PASSWORD",
        "NAUTILO_CRYPTO_DB_PASSWORD",
        "NAUTILO_DB_PASSWORD",
        "NAUTILO_DEPLOY_APP_DB_PORT",
        "NAUTILO_DEPLOY_DB_PORT",
        "NAUTILO_DEPLOY_LOGTO_ADMIN_PORT",
        "NAUTILO_DEPLOY_LOGTO_PORT",
        "NAUTILO_DEPLOY_SERVER_PORT",
        "NAUTILO_DISABLE_TLS",
        "NAUTILO_HOSTING_MODE",
        "NAUTILO_INSTANCE_ID",
        "NAUTILO_OFFICE_ENABLED",
        "NAUTILO_PASSWORD_RECOVERY_DRIVER",
        "NAUTILO_PUBLIC_BASE_URL",
        "NAUTILO_PUBLIC_HOST",
        "NAUTILO_COOLWSD_SSL_TERMINATION",
        "NAUTILO_SERVER_TAG",
        "NAUTILO_SOURCE_SHA",
        "POSTGRES_PASSWORD",
        "POSTGRES_USER",
      ].sort(),
    );
  });

  test("scalar values match resolved instance", () => {
    const inst = fakeInstance();
    const env = buildComposeEnv(profile({ tag: "custom-tag" }), inst, fakePasswords());
    expect(env["COMPOSE_PROJECT_NAME"]).toBe("nautilo");
    expect(env["NAUTILO_HOSTING_MODE"]).toBe("local");
    expect(env["NAUTILO_PASSWORD_RECOVERY_DRIVER"]).toBe("oss_relay");
    expect(env["NAUTILO_SERVER_TAG"]).toBe("custom-tag");
    expect(env["NAUTILO_DEPLOY_APP_DB_PORT"]).toBe("6434");
    expect(env["NAUTILO_DEPLOY_DB_PORT"]).toBe("6432");
    expect(env["NAUTILO_DEPLOY_LOGTO_PORT"]).toBe("4301");
    expect(env["NAUTILO_DEPLOY_LOGTO_ADMIN_PORT"]).toBe("4302");
    expect(env["NAUTILO_DEPLOY_SERVER_PORT"]).toBe("4001");
    expect(env["NAUTILO_PUBLIC_BASE_URL"]).toBe("http://localhost:4001");
    // M201 — office (coolwsd) server_name host + plain-http ssl.termination.
    expect(env["NAUTILO_PUBLIC_HOST"]).toBe("localhost:4001");
    expect(env["NAUTILO_COOLWSD_SSL_TERMINATION"]).toBe("false");
    expect(env["NAUTILO_OFFICE_ENABLED"]).toBe("false");
    expect(env["LOGTO_ENDPOINT"]).toBe("http://localhost:4301");
    expect(env["LOGTO_ADMIN_ENDPOINT"]).toBe("http://localhost:4302");
    expect(env["LOGTO_CONTAINER_ADMIN_ENDPOINT"]).toBe("http://127.0.0.1:4302");
    expect(env["APP_DB_PASSWORD"]).toBe("test_app_pw");
    expect(env["POSTGRES_PASSWORD"]).toBe("test_pg_pw");
    expect(env["LOGTO_DB_PASSWORD"]).toBe("test_logto_pw");
    expect(env["NAUTILO_DB_PASSWORD"]).toBe("test_nautilo_pw");
    expect(env["NAUTILO_AGENT_DB_PASSWORD"]).toBe("test_agent_pw");
    expect(env["NAUTILO_CRYPTO_DB_PASSWORD"]).toBe("test_crypto_pw");
    expect(env["LOGTO_TRUST_PROXY"]).toBe("0");
    expect(env["LOGTO_IMAGE_TAG"]).toBe("1.38.0");
    expect(env["LOGTO_IMAGE"]).toBe("ghcr.io/logto-io/logto:1.38.0");
    expect(env["NAUTILO_DISABLE_TLS"]).toBe("1");
    expect(Object.keys(env)).not.toContain("NEON_PROXY_IMAGE");
    expect(Object.keys(env)).not.toContain("NGINX_IMAGE");
  });

  test("source identity is explicit and registry env does not gain an ambient fallback", () => {
    const sha = "e".repeat(40);
    expect(buildComposeEnv(profile(), fakeInstance(), fakePasswords(), { sourceBuildSha: sha })["NAUTILO_SOURCE_SHA"]).toBe(sha);
    expect(buildComposeEnv(profile({ from_source: false }), fakeInstance(), fakePasswords())["NAUTILO_SOURCE_SHA"]).toBeUndefined();
    expect(() => buildComposeEnv(profile(), fakeInstance(), fakePasswords(), { sourceBuildSha: "dirty" })).toThrow(
      "exact lowercase 40- or 64-character Git SHA",
    );
  });

  test('default tag is "local-dev" when profile.tag is undefined', () => {
    const env = buildComposeEnv(profile(), fakeInstance(), fakePasswords());
    expect(env["NAUTILO_SERVER_TAG"]).toBe("local-dev");
  });

  test("named instance produces nautilo-<id> compose project", () => {
    const env = buildComposeEnv(
      profile({ instance_id: "beta" }),
      fakeInstance(),
      fakePasswords(),
    );
    expect(env["COMPOSE_PROJECT_NAME"]).toBe("nautilo-beta");
  });

  test("profile password_recovery is emitted into compose env", () => {
    const env = buildComposeEnv(
      profile({ password_recovery: "logto_native" }),
      fakeInstance(),
      fakePasswords(),
    );
    expect(env["NAUTILO_PASSWORD_RECOVERY_DRIVER"]).toBe("logto_native");
  });

  test("M117 — LOGTO_TRUST_PROXY=1 in https=letsencrypt mode (Caddy forwards X-Forwarded-Proto)", () => {
    const env = buildComposeEnv(
      profile({
        name: "remote-le",
        transport: "remote",
        ssh: { host: "1.2.3.4", user: "root" },
        domain: "test.example.com",
        https: "letsencrypt",
        acme_email: "ops@example.com",
      }),
      fakeInstance(),
      fakePasswords(),
      { acmeEmail: "ops@example.com", caddyfilePath: "/opt/x/deploy.Caddyfile" },
    );
    expect(env["LOGTO_TRUST_PROXY"]).toBe("1");
  });

  test("M117 — LOGTO_TRUST_PROXY=0 stays in https=off mode (default)", () => {
    const env = buildComposeEnv(profile(), fakeInstance(), fakePasswords());
    expect(env["LOGTO_TRUST_PROXY"]).toBe("0");
  });

  test("remote profile emits non-localhost LOGTO_ENDPOINT", () => {
    const env = buildComposeEnv(
      profile({
        name: "remote-droplet",
        transport: "remote",
        ssh: { host: "1.2.3.4", user: "root" },
      }),
      fakeInstance(),
      fakePasswords(),
    );
    expect(env["LOGTO_ENDPOINT"]).toContain("1.2.3.4");
    expect(env["LOGTO_ENDPOINT"]).not.toContain("localhost");
    expect(env["LOGTO_ADMIN_ENDPOINT"]).toBe("http://1.2.3.4:4302");
    expect(env["LOGTO_CONTAINER_ADMIN_ENDPOINT"]).toBe("http://127.0.0.1:4302");
  });

  test("letsencrypt mode emits NAUTILO_DOMAIN, ACME_EMAIL, NAUTILO_DEPLOY_CADDYFILE_PATH", () => {
    const env = buildComposeEnv(
      profile({
        name: "remote-le",
        transport: "remote",
        https: "letsencrypt",
        domain: "alpha.example.com",
        acme_email: "ops@example.com",
        ssh: { host: "1.2.3.4", user: "root" },
      }),
      fakeInstance(),
      fakePasswords(),
      {
        acmeEmail: "ops@example.com",
        caddyfilePath: "/opt/nautilo/deploy.Caddyfile",
      },
    );
    expect(env["NAUTILO_DOMAIN"]).toBe("alpha.example.com");
    expect(env["ACME_EMAIL"]).toBe("ops@example.com");
    expect(env["NAUTILO_DEPLOY_CADDYFILE_PATH"]).toBe("/opt/nautilo/deploy.Caddyfile");
    expect(env["LOGTO_ENDPOINT"]).toBe("https://auth.alpha.example.com");
    expect(env["NAUTILO_PUBLIC_BASE_URL"]).toBe("https://alpha.example.com");
    // M201 — LE deploy: coolwsd server_name = bare domain, edge-TLS termination.
    expect(env["NAUTILO_PUBLIC_HOST"]).toBe("alpha.example.com");
    expect(env["NAUTILO_COOLWSD_SSL_TERMINATION"]).toBe("true");
  });

  test("https=off mode (default) does NOT emit the three new keys", () => {
    const env = buildComposeEnv(profile(), fakeInstance(), fakePasswords());
    expect(Object.keys(env)).not.toContain("NAUTILO_DOMAIN");
    expect(Object.keys(env)).not.toContain("ACME_EMAIL");
    expect(Object.keys(env)).not.toContain("NAUTILO_DEPLOY_CADDYFILE_PATH");
  });
});
