import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { __resetResolvedInstanceForTests, resolveInstance } from "@nautilo/config";
import {
  buildAuthoritativeTargets,
  buildAuthoritativeExecEnv,
  runAuthoritativeAcceptance,
  verify,
  type VerifyReport,
} from "../../src/lib/verify";
import {
  buildLocalPostgresProbeSpecs,
  localPostgresProbeConnect,
  runLocalPostgresProbe,
} from "../../src/lib/runtime-acceptance-pg-probe";
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
    pollHealth: over.pollHealth ?? (() => Promise.resolve()),
  };
}

/** Real local targets with fake credentials and a fake PostgreSQL driver. */
function fakeTargets(onQuery: (user: string) => void = () => {}) {
  return buildAuthoritativeTargets({
    execEnv: () => ({
      NAUTILO_DB_PASSWORD: "pw-full",
      NAUTILO_AGENT_DB_PASSWORD: "pw-agent",
      NAUTILO_CRYPTO_DB_PASSWORD: "pw-crypto",
    }),
    connect: (options) => ({
      query: () => {
        onQuery(options.user);
        return Promise.resolve([{ ok: 1 }]);
      },
      close: () => Promise.resolve(),
    }),
  });
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

  test("app-role probes authenticate each role on the published port without a host shell or psql", async () => {
    const connections: Array<Record<string, unknown>> = [];
    const queries: Array<{ text: string; params: readonly number[] }> = [];
    const t = buildAuthoritativeTargets({
      execEnv: () => ({
        NAUTILO_DB_PASSWORD: "pw-full",
        NAUTILO_AGENT_DB_PASSWORD: "pw-agent",
        NAUTILO_CRYPTO_DB_PASSWORD: "pw-crypto",
      }),
      connect: (options) => {
        connections.push({ ...options });
        return {
          query: (text, params) => {
            queries.push({ text, params });
            return Promise.resolve([{ ok: 1 }]);
          },
          close: () => Promise.resolve(),
        };
      },
    });
    expect(t.appRoleProbes.map((p) => p.role)).toEqual(["nautilo", "nautilo_agent", "nautilo_crypto"]);
    expect(t.appRoleProbes.every((p) => !("cmd" in p))).toBe(true);
    for (const probe of t.appRoleProbes) {
      expect(await probe.run()).toEqual({ code: 0, stderr: "" });
    }
    const port = resolveInstance().db.postgresHostPort;
    expect(connections).toEqual([
      { host: "127.0.0.1", port, user: "nautilo", password: "pw-full", database: "nautilo" },
      { host: "127.0.0.1", port, user: "nautilo_agent", password: "pw-agent", database: "nautilo" },
      { host: "127.0.0.1", port, user: "nautilo_crypto", password: "pw-crypto", database: "nautilo" },
    ]);
    expect(queries.every((q) => q.text === "SELECT 1 AS ok" && q.params.length === 0)).toBe(true);
  });

  test("probe specs cover all three runtime roles plus the parameterized agent wire probe", () => {
    const specs = buildLocalPostgresProbeSpecs(15432);
    expect(specs.appRoles).toEqual([
      { host: "127.0.0.1", port: 15432, database: "nautilo", role: "nautilo", passwordEnv: "NAUTILO_DB_PASSWORD", query: "select-1" },
      { host: "127.0.0.1", port: 15432, database: "nautilo", role: "nautilo_agent", passwordEnv: "NAUTILO_AGENT_DB_PASSWORD", query: "select-1" },
      { host: "127.0.0.1", port: 15432, database: "nautilo", role: "nautilo_crypto", passwordEnv: "NAUTILO_CRYPTO_DB_PASSWORD", query: "select-1" },
    ]);
    expect(specs.direct).toEqual({
      host: "127.0.0.1",
      port: 15432,
      database: "nautilo",
      role: "nautilo_agent",
      passwordEnv: "NAUTILO_AGENT_DB_PASSWORD",
      query: "parameterized",
    });
  });

  test("a missing role password fails the probe without connecting", async () => {
    let connected = false;
    const result = await runLocalPostgresProbe(
      buildLocalPostgresProbeSpecs(15432).appRoles[2]!,
      { NAUTILO_DB_PASSWORD: "pw-full" },
      () => {
        connected = true;
        throw new Error("must not connect");
      },
    );
    expect(result).toEqual({ code: 1, stderr: "NAUTILO_CRYPTO_DB_PASSWORD is not set" });
    expect(connected).toBe(false);
  });

  test("driver failures fail closed with the password redacted and the client closed", async () => {
    let closed = 0;
    const result = await runLocalPostgresProbe(
      buildLocalPostgresProbeSpecs(15432).appRoles[0]!,
      { NAUTILO_DB_PASSWORD: "s3cret-pw" },
      () => ({
        query: () => Promise.reject(new Error('password authentication failed for user "nautilo" (tried s3cret-pw)')),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('password authentication failed for user "nautilo"');
    expect(result.stderr).not.toContain("s3cret-pw");
    expect(closed).toBe(1);
  });

  test("an unexpected probe row fails closed", async () => {
    const result = await runLocalPostgresProbe(
      buildLocalPostgresProbeSpecs(15432).direct,
      { NAUTILO_AGENT_DB_PASSWORD: "pw-agent" },
      () => ({
        query: () => Promise.resolve([{ ok: 2 }]),
        close: () => Promise.resolve(),
      }),
    );
    expect(result.code).toBe(1);
  });

  test("real sockets: a server that never closes its side cannot hold up probe cleanup", async () => {
    // Speaks just enough of the PostgreSQL wire protocol to accept the
    // session and answer every query with zero rows, and keeps its half of
    // the socket open after the client hangs up. The driver's close waits
    // for the socket to close, so only the cleanup bound lets the probe
    // return.
    const message = (type: string, body: Buffer = Buffer.alloc(0)): Buffer => {
      const length = Buffer.alloc(4);
      length.writeInt32BE(body.length + 4);
      return Buffer.concat([Buffer.from(type), length, body]);
    };
    const readyForQuery = message("Z", Buffer.from("I"));
    const commandComplete = message("C", Buffer.from("SELECT 0\0"));
    const replies: Record<string, Buffer> = {
      P: message("1"), // Parse -> ParseComplete
      D: Buffer.concat([message("t", Buffer.alloc(2)), message("n")]), // Describe -> no parameters, NoData
      B: message("2"), // Bind -> BindComplete
      E: commandComplete, // Execute
      S: readyForQuery, // Sync
      Q: Buffer.concat([commandComplete, readyForQuery]), // simple Query
    };
    const sockets: Socket[] = [];
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.push(socket);
      let started = false;
      let pending = Buffer.alloc(0);
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        if (!started) {
          // The startup message; AuthenticationOk needs no password exchange.
          started = true;
          socket.write(Buffer.concat([message("R", Buffer.alloc(4)), readyForQuery]));
          return;
        }
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5 && pending.length >= 1 + pending.readInt32BE(1)) {
          const reply = replies[String.fromCharCode(pending[0]!)];
          if (reply) socket.write(reply);
          pending = pending.subarray(1 + pending.readInt32BE(1));
        }
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const { port } = server.address() as AddressInfo;
      const startedAt = Date.now();
      const result = await runLocalPostgresProbe(
        buildLocalPostgresProbeSpecs(port).direct,
        { NAUTILO_AGENT_DB_PASSWORD: "pw-agent" },
        localPostgresProbeConnect(0.2),
      );
      expect(result).toEqual({ code: 1, stderr: `unexpected probe result from 127.0.0.1:${port}` });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  }, 30_000);

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

  test("direct postgres probe targets the published postgres port with a bound parameter", async () => {
    const seen: Array<{ user: string; port: number; text: string; params: readonly number[] }> = [];
    const t = buildAuthoritativeTargets({
      execEnv: () => ({ NAUTILO_AGENT_DB_PASSWORD: "pw-agent" }),
      connect: (options) => ({
        query: (text, params) => {
          seen.push({ user: options.user, port: options.port, text, params });
          return Promise.resolve([{ ok: 1 }]);
        },
        close: () => Promise.resolve(),
      }),
    });
    expect(t.directPostgresProbe.label).toBe("nautilo_agent direct PostgreSQL probe");
    expect(await t.directPostgresProbe.run()).toEqual({ code: 0, stderr: "" });
    expect(seen).toEqual([{
      user: "nautilo_agent",
      port: resolveInstance().db.postgresHostPort,
      text: "SELECT $1::int AS ok",
      params: [1],
    }]);
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
  // The root Bun preload routes tests to the scratch instance. These fake
  // responses represent the default instance, so pin that identity here.
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

  test("happy path → mode authoritative, allPassed true, eight checks", async () => {
    const report = await runAuthoritativeAcceptance(fakeTransport(), fakeTargets());
    expect(report.mode).toBe("authoritative");
    expect(report.allPassed).toBe(true);
    // health + identity + spa + three app-cluster roles + direct postgres + oidc
    expect(report.checks).toHaveLength(8);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  test("a failing check makes allPassed false (fail-closed, no nonFatal in authoritative mode)", async () => {
    const report = await runAuthoritativeAcceptance(
      fakeTransport(),
      fakeTargets((user) => {
        if (user === "nautilo") throw new Error("password authentication failed for user nautilo");
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
      fakeTargets(),
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
