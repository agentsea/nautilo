import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "../../../..");

const COMPOSE_PATHS = {
  devDb: join(REPO_ROOT, "packages/db/docker/docker-compose.yml"),
  devLogto: join(REPO_ROOT, "infra/compose/nautilo.yml"),
  deploy: join(
    REPO_ROOT,
    "deploy/compose-driver/templates/docker-compose.yml",
  ),
  source: join(
    REPO_ROOT,
    "deploy/compose-driver/templates/docker-compose.source.yml",
  ),
} as const;

/** Extract `${VAR}` references from compose YAML text. */
function portEnvVars(yaml: string): Set<string> {
  const out = new Set<string>();
  const re = /\$\{([A-Z][A-Z0-9_]+)/g;
  for (const m of yaml.matchAll(re)) {
    out.add(m[1]!);
  }
  return out;
}

function readYaml(path: string): string {
  return readFileSync(path, "utf8");
}

describe("compose-file drift guard (Acceptance #6)", () => {
  test("deploy template uses NAUTILO_DEPLOY_*; dev infra does not leak deploy prefixes", () => {
    const deployVars = portEnvVars(readYaml(COMPOSE_PATHS.deploy));
    const devDbVars = portEnvVars(readYaml(COMPOSE_PATHS.devDb));
    const devLogtoVars = portEnvVars(readYaml(COMPOSE_PATHS.devLogto));
    const devVars = new Set([...devDbVars, ...devLogtoVars]);

    const deployPortVars = [...deployVars].filter((v) => v.includes("PORT"));
    expect(deployPortVars.some((v) => v.startsWith("NAUTILO_DEPLOY_"))).toBe(
      true,
    );
    expect(deployPortVars.every((v) => v.startsWith("NAUTILO_DEPLOY_"))).toBe(
      true,
    );

    for (const v of devVars) {
      expect(v.startsWith("NAUTILO_DEPLOY_")).toBe(false);
    }
  });

  test("deploy template has no retired neon-proxy/db-host topology", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);
    expect(deployText).not.toMatch(/\n {2}neon-proxy:/);
    expect(deployText).not.toMatch(/\n {2}db-host:/);
    expect(deployText).not.toContain("NEON_PROXY_IMAGE");
    expect(deployText).not.toContain("NGINX_IMAGE");
    expect(deployText).not.toContain("NAUTILO_DEPLOY_NEON_PROXY_PORT");
    expect(deployText).not.toContain("NAUTILO_NEON_PROXY_PORT");
    expect(deployText).not.toContain("db.localtest.me");
  });

  test("deploy template default project is nautilo (nautilo-deploy legacy default gone)", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);
    expect(deployText).toMatch(
      /^name:\s*\$\{COMPOSE_PROJECT_NAME:-nautilo\}/m,
    );
    expect(deployText).not.toMatch(
      /^name:\s*\$\{COMPOSE_PROJECT_NAME:-nautilo-deploy\}/m,
    );
  });

  test("D442 — dev and deploy Logto usernames are case-insensitive", () => {
    const devLogtoText = readYaml(COMPOSE_PATHS.devLogto);
    const deployText = readYaml(COMPOSE_PATHS.deploy);

    expect(devLogtoText).toContain('CASE_SENSITIVE_USERNAME: "false"');
    expect(deployText).toContain('CASE_SENSITIVE_USERNAME: "false"');
  });

  test("M116 — deploy template mounts canonical infra/postgres-init.sh and uses nautilo role for migrations", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);

    const canonicalMount =
      "../../../infra/postgres-init.sh:/docker-entrypoint-initdb.d/01-nautilo.sh:ro";
    const mountCount = deployText.split(canonicalMount).length - 1;
    expect(mountCount).toBe(2);

    expect(deployText).toMatch(
      /DB_DIRECT_CONNECTION: postgres:\/\/nautilo:\$\{NAUTILO_DB_PASSWORD:\?/,
    );
    expect(deployText).not.toMatch(
      /DB_DIRECT_CONNECTION: postgres:\/\/postgres:/,
    );
    expect(deployText).toContain(
      "NAUTILO_AGENT_DB_PASSWORD: ${NAUTILO_AGENT_DB_PASSWORD:?NAUTILO_AGENT_DB_PASSWORD must be set by ensureDbPasswords (M116)}",
    );
  });

  test("M231 — crypto credential reaches app-postgres only, never Logto or server", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);
    const appBlock = deployText.match(
      /\x20{2}app-postgres:[\s\S]*?(?=\n\x20{2}logto-postgres:)/,
    )?.[0];
    const logtoBlock = deployText.match(
      /\x20{2}logto-postgres:[\s\S]*?(?=\n\x20{2}logto:)/,
    )?.[0];
    const serverBlock = deployText.match(
      /\x20{2}nautilo-server:[\s\S]*?(?=\n\x20{2}[a-z][\w-]*:|\nvolumes:)/,
    )?.[0];

    expect(appBlock).toContain("NAUTILO_POSTGRES_CLUSTER_KIND: app");
    expect(appBlock).toContain("NAUTILO_CRYPTO_DB_PASSWORD");
    expect(logtoBlock).toContain("NAUTILO_POSTGRES_CLUSTER_KIND: logto");
    expect(logtoBlock).not.toContain("NAUTILO_CRYPTO_DB_PASSWORD");
    expect(serverBlock).not.toContain("NAUTILO_CRYPTO_DB_PASSWORD");
    expect(serverBlock).not.toContain("DB_CRYPTO_CONNECTION_STRING");
  });

  test("M139 — deploy template wires artifact, durable-media, and apps volumes", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);

    expect(deployText).toContain(
      "NAUTILO_ARTIFACTS_ROOT: /var/lib/nautilo/artifacts",
    );
    expect(deployText).toContain("NAUTILO_MEDIA_ROOT: /var/lib/nautilo/media");
    expect(deployText).toContain("- app_artifacts:/var/lib/nautilo/artifacts");
    expect(deployText).toContain("- app_media:/var/lib/nautilo/media");
    expect(deployText).toContain("- app_apps:/var/lib/nautilo/apps");
    expect(deployText).not.toContain("NAUTILO_APPS_ROOT");
    expect(deployText).toMatch(
      /^volumes:\n {2}app_pgdata:\n {2}logto_pgdata:\n {2}app_artifacts:\n {2}app_media:\n {2}app_apps:/m,
    );
  });

  test("M212/M215 — deploy server uses four direct app-postgres role URLs only", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);
    const serverBlock = deployText.match(
      /\x20{2}nautilo-server:[\s\S]*?(?=\n\x20{2}[a-z][\w-]*:|\nvolumes:)/,
    )?.[0];
    expect(serverBlock).toBeDefined();

    expect(serverBlock).toMatch(
      /DB_CONNECTION_STRING: postgres:\/\/nautilo:\$\{NAUTILO_DB_PASSWORD:\?/,
    );
    expect(serverBlock).toMatch(
      /DB_DIRECT_CONNECTION: postgres:\/\/nautilo:\$\{NAUTILO_DB_PASSWORD:\?/,
    );
    expect(serverBlock).toMatch(
      /DB_AGENT_CONNECTION_STRING: postgres:\/\/nautilo_agent:\$\{NAUTILO_AGENT_DB_PASSWORD:\?/,
    );
    expect(serverBlock).toMatch(
      /DB_AGENT_DIRECT_CONNECTION: postgres:\/\/nautilo_agent:\$\{NAUTILO_AGENT_DB_PASSWORD:\?/,
    );

    for (const key of [
      "DB_CONNECTION_STRING",
      "DB_DIRECT_CONNECTION",
      "DB_AGENT_CONNECTION_STRING",
      "DB_AGENT_DIRECT_CONNECTION",
    ] as const) {
      const match = serverBlock!.match(
        new RegExp(`${key}: [^\n]+@([^:]+):5432/nautilo`),
      );
      expect(match?.[1]).toBe("app-postgres");
    }

    expect(serverBlock).not.toMatch(
      /DB_CONNECTION_STRING:[^\n]*db\.localtest\.me/,
    );
    expect(serverBlock).not.toMatch(
      /DB_AGENT_CONNECTION_STRING:[^\n]*db\.localtest\.me/,
    );
    expect(serverBlock).toMatch(/depends_on:[\s\S]*app-postgres:/);
    expect(serverBlock).not.toContain("db-host:");
    expect(serverBlock).not.toContain("neon-proxy:");
  });

  test("D237 — deploy server receives public base URL but not bind-changing server URL", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);

    expect(deployText).toContain(
      'NAUTILO_PUBLIC_BASE_URL: "${NAUTILO_PUBLIC_BASE_URL:-}"',
    );
    expect(deployText).not.toContain(
      'NAUTILO_SERVER_URL: "${NAUTILO_SERVER_URL:-}"',
    );
  });

  test("deploy server healthcheck uses the bundled Bun runtime, never curl", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);
    const serverBlock = deployText.match(
      /\x20{2}nautilo-server:[\s\S]*?(?=\n\x20{2}[a-z][\w-]*:|\nvolumes:)/,
    )?.[0];
    expect(serverBlock).toBeDefined();
    expect(serverBlock).toContain('"CMD", "bun", "-e"');
    expect(serverBlock).toContain("fetch('http://localhost:3001/health')");
    expect(serverBlock).not.toContain('"curl"');
  });

  test("deploy PostgreSQL healthchecks require final PID 1 before readiness", () => {
    const deployText = readYaml(COMPOSE_PATHS.deploy);
    const appPostgres = deployText.match(
      /\x20{2}app-postgres:[\s\S]*?(?=\n\x20{2}logto-postgres:)/,
    )?.[0];
    const logtoPostgres = deployText.match(
      /\x20{2}logto-postgres:[\s\S]*?(?=\n\x20{2}logto:)/,
    )?.[0];

    for (const service of [appPostgres, logtoPostgres]) {
      expect(service).toBeDefined();
      expect(service).toContain('test: ["CMD-SHELL", "test \\"$$(cat /proc/1/comm)\\" = postgres');
      expect(service).toContain("pg_isready");
    }
  });
});

describe("M215 — deploy env template has no proxy image pins", () => {
  const localSmokeExample = readFileSync(
    join(REPO_ROOT, "deploy/compose-driver/templates/.env.local-smoke.example"),
    "utf8",
  );

  test(".env.local-smoke.example omits NEON_PROXY_IMAGE and NGINX_IMAGE", () => {
    expect(localSmokeExample).not.toContain("NEON_PROXY_IMAGE");
    expect(localSmokeExample).not.toContain("NGINX_IMAGE");
    expect(localSmokeExample).not.toContain("NAUTILO_DEPLOY_NEON_PROXY_PORT");
  });
});

describe("source image identity wiring", () => {
  test("Compose passes the preflighted source revision into the runtime Dockerfile", () => {
    const deployText = readFileSync(COMPOSE_PATHS.deploy, "utf8");
    const sourceText = readFileSync(COMPOSE_PATHS.source, "utf8");
    expect(deployText).not.toContain("NAUTILO_SOURCE_SHA");
    expect(sourceText).toContain(
      "NAUTILO_SOURCE_SHA: ${NAUTILO_SOURCE_SHA:?NAUTILO_SOURCE_SHA must be resolved from a clean source checkout}",
    );
    expect(deployText).toContain("dockerfile: packaging/docker/Dockerfile");
    const dockerfile = readFileSync(join(REPO_ROOT, "packaging/docker/Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG NAUTILO_SOURCE_SHA");
    expect(dockerfile).toContain("org.opencontainers.image.revision=\"${NAUTILO_SOURCE_SHA}\"");
  });
});
