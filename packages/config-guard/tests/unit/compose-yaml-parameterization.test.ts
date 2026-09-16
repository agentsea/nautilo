import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/** Monorepo root (`nautilo/`), from `packages/config-guard/tests/unit/`. */
const repoRoot = join(import.meta.dir, "../../../..");

async function readCompose(relativeFromRoot: string): Promise<string> {
  return await Bun.file(join(repoRoot, relativeFromRoot)).text();
}

describe("M071 compose YAML parameterization", () => {
  test("infra/compose/nautilo.yml uses env-driven host ports and project name", async () => {
    const yml = await readCompose("infra/compose/nautilo.yml");
    expect(yml).toMatch(/^name:\s*\$\{COMPOSE_PROJECT_NAME:-nautilo\}\s*$/m);
    expect(yml).toContain("${NAUTILO_LOGTO_DB_PORT:-5432}:5432");
    expect(yml).toContain("${NAUTILO_LOGTO_PORT:-3301}:${NAUTILO_LOGTO_PORT:-3301}");
    expect(yml).toContain("${NAUTILO_LOGTO_ADMIN_PORT:-3302}:${NAUTILO_LOGTO_ADMIN_PORT:-3302}");
    expect(yml).toContain("PORT: ${NAUTILO_LOGTO_PORT:-3301}");
    expect(yml).toContain("ADMIN_PORT: ${NAUTILO_LOGTO_ADMIN_PORT:-3302}");
    expect(yml).toContain('CASE_SENSITIVE_USERNAME: "false"');
    expect(yml).not.toMatch(/-\s*"5432:5432"/);
    expect(yml).not.toMatch(/-\s*"3301:3301"/);
    expect(yml).not.toMatch(/-\s*"3302:3302"/);
  });

  test("packages/db/docker/docker-compose.yml templates legacy postgres only (M215)", async () => {
    const yml = await readCompose("packages/db/docker/docker-compose.yml");
    expect(yml).toMatch(/^name:\s*\$\{COMPOSE_PROJECT_NAME:-nautilo\}\s*$/m);
    expect(yml).toContain("legacy-postgres:");
    expect(yml).toContain("container_name: ${COMPOSE_PROJECT_NAME:-nautilo}-postgres");
    expect(yml).toContain("${NAUTILO_DB_PORT:-5434}:5432");
    expect(yml).not.toContain("neon-proxy");
    expect(yml).not.toContain("NAUTILO_NEON_PROXY_PORT");
    expect(yml).not.toContain("Neon-Pool-Opt-In");
    expect(yml).not.toMatch(/-\s*"5434:5432"/);
  });
});
