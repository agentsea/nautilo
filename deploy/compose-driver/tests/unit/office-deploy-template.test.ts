/**
 * M201 R2/R3 — deploy compose template office/collabora invariants.
 *
 * Text-based assertions (no YAML dependency — same convention as
 * `compose-file-drift-guard.test.ts`) that the deploy template wires the two
 * office engines securely: `app` profile (always-on, up with the server),
 * internal-only (no host ports), coolwsd admin console off, no default creds,
 * a tight (non-`*`) frame_ancestors, and the server's topology-aware env.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "../../../..");
const DEPLOY = join(REPO_ROOT, "deploy/compose-driver/templates/docker-compose.yml");
const deployText = readFileSync(DEPLOY, "utf8");

/** Slice the two office-engine service blocks (from `  office:` to `volumes:`). */
function officeEnginesBlock(): string {
  const start = deployText.indexOf("\n  office:\n");
  const end = deployText.indexOf("\nvolumes:");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return deployText.slice(start, end);
}

describe("M201 deploy template — office/collabora services", () => {
  test("both office engines are defined", () => {
    expect(deployText).toContain("\n  office:\n");
    expect(deployText).toContain("\n  collabora:\n");
  });

  test("both engines use the opt-in office profile (not app/full)", () => {
    const engines = officeEnginesBlock();
    const profileLines = engines
      .split("\n")
      .filter((l) => l.trim().startsWith("profiles:"));
    expect(profileLines).toHaveLength(2);
    for (const line of profileLines) {
      expect(line).toContain('["office"]');
    }
  });

  test("server container receives the NAUTILO_OFFICE_ENABLED runtime flag", () => {
    expect(deployText).toContain("NAUTILO_OFFICE_ENABLED:");
  });

  test("neither engine publishes a host port (internal deploy-net only)", () => {
    const engines = officeEnginesBlock();
    // No `ports:` mapping key and no `- "<host>:<container>"` publish line.
    expect(engines).not.toContain("ports:");
    expect(engines).not.toMatch(/-\s*"\d+:\d+"/);
    // Both are attached to deploy-net.
    const networkLines = engines
      .split("\n")
      .filter((l) => l.trim() === "- deploy-net");
    expect(networkLines.length).toBeGreaterThanOrEqual(2);
  });

  test("coolwsd admin console is disabled and has no default creds", () => {
    const engines = officeEnginesBlock();
    expect(engines).toContain("--o:admin_console.enable=false");
    // The dev compose sets username/password=admin; the deploy template must not.
    expect(engines).not.toContain("username: admin");
    expect(engines).not.toContain("password: admin");
  });

  test("frame_ancestors + server_name + ssl.termination are topology-driven (browser-facing, not the internal engine host)", () => {
    const engines = officeEnginesBlock();
    // frame_ancestors = public origin, never wildcard.
    expect(engines).toContain("--o:net.frame_ancestors=${NAUTILO_PUBLIC_BASE_URL");
    expect(engines).not.toContain("frame_ancestors=*");
    // server_name = the browser-facing host:port (NOT the internal collabora
    // compose host); must NOT be hardcoded to a domain-only var.
    expect(engines).toContain("--o:server_name=${NAUTILO_PUBLIC_HOST");
    expect(engines).not.toContain("--o:server_name=${NAUTILO_DOMAIN");
    // ssl.termination is env-driven (true only behind edge TLS), NOT hardcoded.
    expect(engines).toContain("--o:ssl.termination=${NAUTILO_COOLWSD_SSL_TERMINATION");
    expect(engines).not.toContain("--o:ssl.termination=true ");
    expect(engines).toContain("--o:net.service_root=/office-engine");
  });

  test("collabora WOPI-host allowlist matches the server callback origin", () => {
    const engines = officeEnginesBlock();
    expect(engines).toContain('aliasgroup1: "http://nautilo-server:3001"');
  });

  test("server container gets the topology-aware engine env (P1 vars)", () => {
    expect(deployText).toContain("NAUTILO_COLLABORA_ENGINE_URL: http://collabora:9980");
    expect(deployText).toContain("NAUTILO_WOPI_CALLBACK_ORIGIN: http://nautilo-server:3001");
    expect(deployText).toContain("NAUTILO_OFFICE_URL: http://office:2003/");
  });
});
