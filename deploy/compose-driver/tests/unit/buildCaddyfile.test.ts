import { describe, expect, test } from "bun:test";
import type { ResolvedInstance } from "@nautilo/config";
import { buildCaddyfile } from "../../src/buildCaddyfile.ts";
import type { ComposeDriverProfile } from "../../src/types.ts";

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
    name: "remote-le",
    transport: "remote",
    lifecycle: "compose",
    from_source: true,
    domain: "alpha.example.com",
    https: "letsencrypt",
    ssh: { host: "1.2.3.4", user: "root" },
    ...over,
  };
}

describe("buildCaddyfile", () => {
  test("letsencrypt without acme_staging emits production Caddyfile", () => {
    const out = buildCaddyfile({
      profile: profile(),
      inst: fakeInstance(),
      acmeEmail: "ops@example.com",
    });
    expect(out).toContain("{$NAUTILO_DOMAIN} {");
    expect(out).toContain("auth.{$NAUTILO_DOMAIN} {");
    expect(out).toContain("reverse_proxy nautilo-server:3001");
    // M201 — compress large engine assets (bundle.js/css/wasm) to the browser.
    expect(out).toContain("encode zstd gzip");
    expect(out).toContain("reverse_proxy logto:{$NAUTILO_DEPLOY_LOGTO_PORT}");
    expect(out).toContain("email {$ACME_EMAIL}");
    expect(out).not.toContain("acme_ca");
  });

  test("letsencrypt with acme_staging emits staging acme_ca", () => {
    const out = buildCaddyfile({
      profile: profile({ acme_staging: true }),
      inst: fakeInstance(),
      acmeEmail: "ops@example.com",
    });
    expect(out).toContain(
      "acme_ca https://acme-staging-v02.api.letsencrypt.org/directory",
    );
  });

  test("https=off throws", () => {
    expect(() =>
      buildCaddyfile({
        profile: profile({ https: "off" }),
        inst: fakeInstance(),
        acmeEmail: "ops@example.com",
      }),
    ).toThrow(/https=off profiles do not use Caddy/);
  });

  // M201 R2 §3.4 — the office engine rides the SAME `{$NAUTILO_DOMAIN}` vhost
  // (the server's `/office-engine/*` proxy is same-origin), so no separate
  // office vhost is needed. Caddy v2 `reverse_proxy` upgrades WebSockets and
  // streams large tile/asset bodies out of the box — no extra directive.
  // This is a documented invariant: if a future change adds an `office.` vhost
  // or a WS-specific directive, revisit the M201 topology assumptions.
  test("M201 — office rides the single {$NAUTILO_DOMAIN} vhost (no separate office vhost)", () => {
    const out = buildCaddyfile({
      profile: profile(),
      inst: fakeInstance(),
      acmeEmail: "ops@example.com",
    });
    // Exactly one reverse_proxy to the server (office traffic goes through it).
    const serverProxies = out
      .split("\n")
      .filter((l) => l.includes("reverse_proxy nautilo-server:3001"));
    expect(serverProxies).toHaveLength(1);
    // No dedicated office subdomain vhost.
    expect(out).not.toContain("office.{$NAUTILO_DOMAIN}");
    expect(out).not.toContain("reverse_proxy collabora");
    expect(out).not.toContain("reverse_proxy office");
  });

  test("M214 Phase 13 — @sse matcher stays unbuffered before encode", () => {
    const out = buildCaddyfile({
      profile: profile(),
      inst: fakeInstance(),
      acmeEmail: "ops@example.com",
    });
    const lines = out.split("\n");
    const sseMatcherIdx = lines.findIndex((l) => l.includes("@sse path /api/workspace/artifacts/events*"));
    const sseProxyIdx = lines.findIndex((l) => l.includes("reverse_proxy @sse nautilo-server:3001"));
    const flushIdx = lines.findIndex((l) => l.trim() === "flush_interval -1");
    const encodeIdx = lines.findIndex((l) => l.trim() === "encode zstd gzip");
    const defaultProxyIdx = lines.findIndex((l) => l.trim() === "reverse_proxy nautilo-server:3001");

    expect(sseMatcherIdx).toBeGreaterThanOrEqual(0);
    expect(sseProxyIdx).toBeGreaterThan(sseMatcherIdx);
    expect(flushIdx).toBeGreaterThan(sseProxyIdx);
    expect(encodeIdx).toBeGreaterThan(flushIdx);
    expect(defaultProxyIdx).toBeGreaterThan(encodeIdx);
  });

  test("M214 Phase 13 — Caddy forwards upstream cache headers (no Cache-Control override)", () => {
    const out = buildCaddyfile({
      profile: profile(),
      inst: fakeInstance(),
      acmeEmail: "ops@example.com",
    });
    expect(out).not.toMatch(/\bheader\s+-?Cache-Control\b/i);
    expect(out).not.toMatch(/\bheader\s*\{/);
    expect(out).toContain("encode zstd gzip");
  });

  test("disables HTTP/3 — TLS listener serves h1 and h2 only", () => {
    const out = buildCaddyfile({
      profile: profile(),
      inst: fakeInstance(),
      acmeEmail: "ops@example.com",
    });
    expect(out).toContain("servers :443 {");
    expect(out).toContain("protocols h1 h2");
    expect(out).not.toMatch(/\bprotocols\b[^\n]*\bh3\b/);
  });

  test("clears cached H3 Alt-Svc on both HTTPS vhosts", () => {
    const out = buildCaddyfile({
      profile: profile(),
      inst: fakeInstance(),
      acmeEmail: "ops@example.com",
    });
    const altSvcLines = out.split("\n").filter((l) => l.includes('header Alt-Svc "clear"'));
    expect(altSvcLines).toHaveLength(2);

    const nautiloBlock = out.slice(
      out.indexOf("{$NAUTILO_DOMAIN} {"),
      out.indexOf("auth.{$NAUTILO_DOMAIN} {"),
    );
    const authBlock = out.slice(out.indexOf("auth.{$NAUTILO_DOMAIN} {"));
    expect(nautiloBlock).toContain('header Alt-Svc "clear"');
    expect(authBlock).toContain('header Alt-Svc "clear"');
  });
});
