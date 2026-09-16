import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import {
  buildAuthoritativeTargets,
  buildAuthoritativeExecEnv,
  runAuthoritativeAcceptance,
  verify,
  type VerifyReport,
} from "../../src/lib/verify";
import {
  authoritativeVerifyFailureIds,
  parseAuthoritativeVerifyFailureId,
  serializeAuthoritativeVerifyFailureIds,
} from "../../src/commands/verify";
import type { RuntimeAcceptanceTransport } from "@nautilo/db";

/**
 * D427 (Wave 4 task 4.1.2) — `nautilo-dev verify` is authoritative by default
 * (fail-closed on runtime-role, parameterized Neon HTTP, OIDC, identity, SPA)
 * and `--smoke` preserves the pre-Wave-4 nonfatal diagnostic. The authoritative
 * gate is the shared @nautilo/db `runRuntimeAcceptance` helper; these tests pin
 * the local-dev wiring (transport construction, target URLs, probe commands,
 * report mapping, mode routing) without running docker/fetch.
 */

function fakeResponse(ok: boolean, status: number, body: string): {
  ok: boolean;
  status: number;
  text(): Promise<string>;
} {
  return { ok, status, text: () => Promise.resolve(body) };
}

function fakeTransport(over: {
  fetch?: RuntimeAcceptanceTransport["fetch"];
  execSh?: RuntimeAcceptanceTransport["execSh"];
  pollHealth?: RuntimeAcceptanceTransport["pollHealth"];
} = {}): RuntimeAcceptanceTransport {
  return {
    fetch:
      over.fetch ??
      ((url: string) => {
        if (url.includes("/health")) return Promise.resolve(fakeResponse(true, 200, "ok"));
        if (url.includes("/api/setup/status"))
          return Promise.resolve(fakeResponse(true, 200, JSON.stringify({ instanceId: "" })));
        if (url.includes("/oidc/.well-known/openid-configuration"))
          return Promise.resolve(fakeResponse(true, 200, JSON.stringify({ issuer: "http://logto" })));
        return Promise.resolve(fakeResponse(true, 200, "<html>spa</html>"));
      }),
    execSh: over.execSh ?? (() => Promise.resolve({ code: 0, stderr: "" })),
    pollHealth: over.pollHealth ?? (() => Promise.resolve()),
  };
}

describe("authoritative verify secret-free failure IDs", () => {
  test("serializes only allowlisted failed IDs and never report detail", () => {
    const report: VerifyReport = {
      allPassed: false,
      mode: "authoritative",
      checks: [
        { id: "health", title: "Health", passed: true, detail: "ok" },
        { id: "runtime-role", title: "Role", passed: false, detail: "password=secret-value" },
        { id: "oidc", title: "OIDC", passed: false, detail: "token=secret-value" },
      ],
    };
    expect(authoritativeVerifyFailureIds(report)).toEqual(["runtime-role", "oidc"]);
    const serialized = serializeAuthoritativeVerifyFailureIds(report);
    expect(serialized).toBe('["runtime-role","oidc"]');
    expect(serialized).not.toContain("secret");
    expect(parseAuthoritativeVerifyFailureId(`raw password=secret\n${serialized}\nmore output`))
      .toBe("runtime-role");
  });

  test("round-trips the defensive gate ID and maps malformed or unrecognized output to unknown", () => {
    const report: VerifyReport = {
      allPassed: false,
      mode: "authoritative",
      checks: [{ id: "gate", title: "Gate", passed: false, detail: "password=secret-value" }],
    };
    expect(authoritativeVerifyFailureIds(report)).toEqual(["gate"]);
    const serialized = serializeAuthoritativeVerifyFailureIds(report);
    expect(serialized).toBe('["gate"]');
    expect(serialized).not.toContain("secret");
    expect(parseAuthoritativeVerifyFailureId(serialized)).toBe("gate");
    expect(parseAuthoritativeVerifyFailureId("password=secret-value")).toBe("unknown");
    expect(parseAuthoritativeVerifyFailureId('["password=secret-value"]'))
      .toBe("unknown");
    expect(parseAuthoritativeVerifyFailureId('["health","health"]')).toBe("unknown");
    expect(parseAuthoritativeVerifyFailureId('["oidc","health"]')).toBe("unknown");
  });
});

describe("D427 dev:verify — buildAuthoritativeTargets", () => {
  // buildAuthoritativeTargets resolves the live instance, which reads
  // NAUTILO_INSTANCE_ID. Sibling tests in the full suite mutate that env var,
  // so pin the default instance + reset the resolve cache for these assertions.
  const prevInstance = process.env["NAUTILO_INSTANCE_ID"];
  beforeEach(() => {
    delete process.env["NAUTILO_INSTANCE_ID"];
    __resetResolvedInstanceForTests();
  });
  afterEach(() => {
    if (prevInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = prevInstance;
    __resetResolvedInstanceForTests();
  });

  test("app-role probes use the published port rather than stale container env", () => {
    const t = buildAuthoritativeTargets();
    expect(t.appRoleProbes).toHaveLength(3);
    const nautilo = t.appRoleProbes.find((p) => p.role === "nautilo");
    const agent = t.appRoleProbes.find((p) => p.role === "nautilo_agent");
    const crypto = t.appRoleProbes.find((p) => p.role === "nautilo_crypto");
    expect(nautilo).toBeDefined();
    expect(agent).toBeDefined();
    expect(crypto).toBeDefined();
    expect(nautilo!.cmd).toContain("psql -h 127.0.0.1 -p ");
    expect(nautilo!.cmd).toContain("-U nautilo ");
    expect(nautilo!.cmd).toContain("-d nautilo");
    expect(nautilo!.cmd).toContain("SELECT 1");
    expect(nautilo!.cmd).toContain("NAUTILO_DB_PASSWORD");
    expect(agent!.cmd).toContain("-U nautilo_agent ");
    expect(agent!.cmd).toContain("NAUTILO_AGENT_DB_PASSWORD");
    expect(crypto!.cmd).toContain("-U nautilo_crypto ");
    expect(crypto!.cmd).toContain("NAUTILO_CRYPTO_DB_PASSWORD");
    expect(nautilo!.cmd).not.toContain("docker exec");
    expect(agent!.cmd).not.toContain("docker exec");
  });

  test("probe transport selects canonical file credentials over ambient drift", () => {
    const root = mkdtempSync(join(tmpdir(), "nautilo-verify-env-"));
    const instanceEnvPath = join(root, "instance.env");
    writeFileSync(
      instanceEnvPath,
      [
        "NAUTILO_DB_PASSWORD=selected-full",
        "NAUTILO_AGENT_DB_PASSWORD=selected-agent",
        "NAUTILO_CRYPTO_DB_PASSWORD=selected-crypto",
        "LOGTO_DB_PASSWORD=selected-logto",
      ].join("\n"),
      "utf8",
    );
    const env = buildAuthoritativeExecEnv({
      env: {
        NAUTILO_DB_PASSWORD: "stale-container-full",
        NAUTILO_AGENT_DB_PASSWORD: "stale-container-agent",
        LOGTO_DB_PASSWORD: "stale-container-logto",
      },
      instanceId: "",
      instanceEnvPath,
    });
    expect(env["NAUTILO_DB_PASSWORD"]).toBe("selected-full");
    expect(env["NAUTILO_AGENT_DB_PASSWORD"]).toBe("selected-agent");
    expect(env["NAUTILO_CRYPTO_DB_PASSWORD"]).toBe("selected-crypto");
    expect(env["LOGTO_DB_PASSWORD"]).toBe("selected-logto");
  });

  test("direct postgres probe targets the published postgres port with a parameterized query", () => {
    const t = buildAuthoritativeTargets();
    expect(t.directPostgresProbe.cmd).toContain("psql -h 127.0.0.1 -p ");
    expect(t.directPostgresProbe.cmd).toContain("nautilo_agent");
    expect(t.directPostgresProbe.cmd).toContain("NAUTILO_AGENT_DB_PASSWORD");
    expect(t.directPostgresProbe.cmd).toContain("PREPARE m215_verify_probe");
    expect(t.directPostgresProbe.cmd).not.toContain("/sql");
    expect(t.directPostgresProbe.cmd).not.toContain("Neon-Connection-String");
  });

  test("oidc + spa + server URLs resolve from the local instance", () => {
    const t = buildAuthoritativeTargets();
    expect(t.oidcUrl).toContain("/oidc/.well-known/openid-configuration");
    expect(t.oidcUrl).toContain("localhost:");
    expect(t.spaUrl).toBe(t.serverBaseUrl);
    expect(t.serverBaseUrl).toMatch(/^http/);
  });
});

describe("D427 dev:verify — runAuthoritativeAcceptance (report mapping)", () => {
  test("happy path → mode authoritative, allPassed true, eight checks", async () => {
    const report = await runAuthoritativeAcceptance(fakeTransport());
    expect(report.mode).toBe("authoritative");
    expect(report.allPassed).toBe(true);
    // health + identity + spa + three app-cluster roles + direct postgres + oidc
    expect(report.checks).toHaveLength(8);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  test("a failing check makes allPassed false (fail-closed, no nonFatal in authoritative mode)", async () => {
    const report = await runAuthoritativeAcceptance(
      fakeTransport({
        execSh: (cmd) =>
          cmd.includes("-U nautilo ")
            ? Promise.resolve({ code: 1, stderr: "password authentication failed for user nautilo" })
            : Promise.resolve({ code: 0, stderr: "" }),
      }),
    );
    expect(report.mode).toBe("authoritative");
    expect(report.allPassed).toBe(false);
    // Authoritative gate has NO non-fatal checks — a failure is a failure.
    const failing = report.checks.filter((c) => !c.passed);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.every((c) => c.nonFatal === undefined)).toBe(true);
    expect(
      report.checks.some(
        (c) =>
          c.id === "runtime-role" &&
          typeof c.detail === "string" &&
          c.detail.includes("nautilo app-role connection probe failed"),
      ),
    ).toBe(true);
  });

  test("identity mismatch fails closed", async () => {
    const report = await runAuthoritativeAcceptance(
      fakeTransport({
        fetch: (url) =>
          url.includes("/api/setup/status")
            ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ instanceId: "wrong" })))
            : url.includes("/health")
              ? Promise.resolve(fakeResponse(true, 200, "ok"))
              : url.includes("/oidc/.well-known/openid-configuration")
                ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ issuer: "http://logto" })))
                : Promise.resolve(fakeResponse(true, 200, "<html>spa</html>")),
      }),
    );
    expect(report.allPassed).toBe(false);
    expect(
      report.checks.some(
        (c) => c.id === "identity" && typeof c.detail === "string" && c.detail.includes("instanceId mismatch"),
      ),
    ).toBe(true);
  });
});

describe("D427 dev:verify — mode routing", () => {
  test("verify({ smoke: true }) routes to the smoke (nonfatal) mode", async () => {
    // Smoke mode runs the real docker/fetch diagnostic; without docker it
    // reports failures, but the mode marker is what we assert here. The
    // authoritative gate is covered by runAuthoritativeAcceptance above.
    const report = await verify({ smoke: true });
    expect(report.mode).toBe("smoke");
  });

  test("the command sources --smoke from process.argv (lexical wiring guard)", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "commands", "verify.ts"),
      "utf8",
    );
    // verifyCmd reads --smoke from process.argv (the dispatcher calls it with
    // no args), and the flag is honored by verify({ smoke }).
    expect(src).toContain('process.argv.slice(2).includes("--smoke")');
    expect(src).toContain('verify({ smoke })');
    // --smoke must NOT claim acceptance.
    expect(src).toContain("NOT acceptance");
  });

  test("verify() default (no smoke) routes to authoritative (lexical guard)", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "lib", "verify.ts"),
      "utf8",
    );
    expect(src).toContain("options?.smoke === true");
    expect(src).toContain("runSmokeChecks");
    expect(src).toContain("runAuthoritativeAcceptance");
  });
});

// VerifyCheck is re-exported by commands/verify.ts and used by the smoke mode;
// importing it here keeps the public shape under the typecheck surface.
export type { VerifyCheck } from "../../src/lib/verify";
