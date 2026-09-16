import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildCaddyOverlay } from "../../src/buildCaddyOverlay.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const templateText = readFileSync(
  join(REPO_ROOT, "deploy/compose-driver/templates/docker-compose.yml"),
  "utf8",
);

interface ComposeService {
  ports?: string[];
}

interface ComposeTemplate {
  services: Record<string, ComposeService>;
}

const template = Bun.YAML.parse(templateText) as ComposeTemplate;

function ports(service: string): string[] {
  return template.services[service]?.ports ?? [];
}

describe("M292 packaged Compose private-port bindings", () => {
  test("binds both databases and Logto administration to host loopback", () => {
    expect(ports("app-postgres")).toEqual([
      "127.0.0.1:${NAUTILO_DEPLOY_APP_DB_PORT:-6434}:5432",
    ]);
    expect(ports("logto-postgres")).toEqual([
      "127.0.0.1:${NAUTILO_DEPLOY_DB_PORT:-6432}:5432",
    ]);
    expect(ports("logto")[1]).toBe(
      "127.0.0.1:${NAUTILO_DEPLOY_LOGTO_ADMIN_PORT:-4302}:${NAUTILO_DEPLOY_LOGTO_ADMIN_PORT:-4302}",
    );
  });

  test("preserves same-network mobile access through user-facing ports", () => {
    expect(ports("nautilo-server")).toEqual([
      "${NAUTILO_DEPLOY_SERVER_PORT:-4001}:3001",
    ]);
    expect(ports("logto")[0]).toBe(
      "${NAUTILO_DEPLOY_LOGTO_PORT:-4301}:${NAUTILO_DEPLOY_LOGTO_PORT:-4301}",
    );
  });

  test("keeps the public-HTTPS overlay from rewriting either Logto binding", () => {
    const overlay = buildCaddyOverlay();
    expect(overlay).not.toContain("\n  logto:\n    ports:");
    expect(overlay).toContain("  nautilo-server:\n    ports: !reset []");
  });
});
