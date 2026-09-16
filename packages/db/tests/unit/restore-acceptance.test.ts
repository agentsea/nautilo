import { describe, expect, test } from "bun:test";
import {
  buildAppRolePasswordReconcileSql,
  LOGTO_TENANT_PASSWORD_RESYNC_SQL,
  parseDotenv,
  planCredentialReconciliation,
  runRuntimeAcceptance,
  sqlLiteral,
  type RuntimeAcceptanceTransport,
} from "@nautilo/db";

/**
 * D427 (Wave 4 task 4.1.1 / 4.1.2) — shared pure recovery/acceptance helpers.
 * These are the canonical extraction used by BOTH the Compose restore/upgrade
 * path and the `nautilo-dev` restore/upgrade/verify path. The Compose path's
 * exact-string acceptance tests (`deploy/compose-driver/tests/unit/upgrade-
 * orchestrator.test.ts`) exercise the same helper end-to-end; here we pin the
 * pure SQL builders, the reconciliation planner, and the gate's fail-closed
 * contract + canonical error messages directly.
 */
describe("D427 restore-acceptance — sqlLiteral + parseDotenv", () => {
  test("sqlLiteral escapes single quotes", () => {
    expect(sqlLiteral("o'brien")).toBe("'o''brien'");
    expect(sqlLiteral("plain")).toBe("'plain'");
  });

  test("parseDotenv strips quotes and skips blanks/comments", () => {
    const parsed = parseDotenv(
      [
        "# comment",
        "",
        "NAUTILO_DB_PASSWORD=secret",
        'NAUTILO_AGENT_DB_PASSWORD="quoted"',
        "EMPTY=",
      ].join("\n"),
    );
    expect(parsed["NAUTILO_DB_PASSWORD"]).toBe("secret");
    expect(parsed["NAUTILO_AGENT_DB_PASSWORD"]).toBe("quoted");
    expect(parsed["EMPTY"]).toBe("");
  });
});

describe("D427 restore-acceptance — buildAppRolePasswordReconcileSql", () => {
  test("emits an idempotent ALTER/CREATE ROLE DO block per present password", () => {
    const sql = buildAppRolePasswordReconcileSql("nautilo-pw-123", "agent-pw-456");
    expect(sql).toContain("ALTER ROLE %I WITH LOGIN PASSWORD %L");
    expect(sql).toContain("CREATE ROLE %I WITH LOGIN PASSWORD %L");
    expect(sql).toContain("'nautilo'");
    expect(sql).toContain("'nautilo_agent'");
    // The restored passwords are embedded as SQL literals (escaped).
    expect(sql).toContain("'nautilo-pw-123'");
    expect(sql).toContain("'agent-pw-456'");
  });

  test("returns empty string when neither password is present (clean skip)", () => {
    expect(buildAppRolePasswordReconcileSql(undefined, undefined)).toBe("");
    expect(buildAppRolePasswordReconcileSql("  ", "")).toBe("");
  });

  test("emits only the roles whose password is present", () => {
    const sql = buildAppRolePasswordReconcileSql(undefined, "agent-pw");
    expect(sql).not.toContain("'nautilo'");
    expect(sql).toContain("'nautilo_agent'");
    expect(sql).toContain("'agent-pw'");
  });
});

describe("D427 restore-acceptance — LOGTO_TENANT_PASSWORD_RESYNC_SQL", () => {
  test("is a server-side loop over the tenants table, no-op when absent", () => {
    expect(LOGTO_TENANT_PASSWORD_RESYNC_SQL).toContain("tenants");
    expect(LOGTO_TENANT_PASSWORD_RESYNC_SQL).toContain("db_user_password FROM tenants");
    expect(LOGTO_TENANT_PASSWORD_RESYNC_SQL).toContain("information_schema.tables");
    expect(LOGTO_TENANT_PASSWORD_RESYNC_SQL).toContain("RETURN; END IF");
    expect(LOGTO_TENANT_PASSWORD_RESYNC_SQL).toContain("ALTER ROLE %I WITH LOGIN PASSWORD %L");
  });
});

describe("D427 restore-acceptance — planCredentialReconciliation", () => {
  test("emits app pipeline only when restored env carries app-role passwords", () => {
    const plan = planCredentialReconciliation({
      instanceEnvRaw: "NAUTILO_DB_PASSWORD=pw\nNAUTILO_AGENT_DB_PASSWORD=apw\n",
      reconcileNautilo: true,
      reconcileLogto: false,
    });
    expect(plan.pipelines).toHaveLength(1);
    expect(plan.pipelines[0]?.id).toBe("app-role-password-reconcile");
    expect(plan.pipelines[0]?.label).toBe("nautilo app-role password reconcile");
    expect(plan.pipelines[0]?.kind).toBe("app");
    expect(plan.pipelines[0]?.sql).toContain("'pw'");
    expect(plan.appRolePasswords.nautilo).toBe("pw");
    expect(plan.appRolePasswords.nautiloAgent).toBe("apw");
  });

  test("emits logto pipeline only when reconcileLogto is true (caller gates on availability)", () => {
    const plan = planCredentialReconciliation({
      instanceEnvRaw: "",
      reconcileNautilo: true,
      reconcileLogto: true,
    });
    // No app passwords → no app pipeline; logto pipeline still emitted.
    expect(plan.pipelines).toHaveLength(1);
    expect(plan.pipelines[0]?.id).toBe("logto-tenant-role-resync");
    expect(plan.pipelines[0]?.kind).toBe("logto");
    expect(plan.pipelines[0]?.label).toBe("logto tenant-role password resync");
    expect(plan.pipelines[0]?.sql).toBe(LOGTO_TENANT_PASSWORD_RESYNC_SQL);
  });

  test("a data-only restore without instance.env skips app but keeps logto when in scope", () => {
    const plan = planCredentialReconciliation({
      instanceEnvRaw: "",
      reconcileNautilo: true,
      reconcileLogto: true,
    });
    expect(plan.pipelines.some((p) => p.kind === "app")).toBe(false);
    expect(plan.pipelines.some((p) => p.kind === "logto")).toBe(true);
  });

  test("order is app before logto when both are in scope", () => {
    const plan = planCredentialReconciliation({
      instanceEnvRaw: "NAUTILO_DB_PASSWORD=pw\n",
      reconcileNautilo: true,
      reconcileLogto: true,
    });
    expect(plan.pipelines.map((p) => p.kind)).toEqual(["app", "logto"]);
  });
});

// ---------------------------------------------------------------------------
// runRuntimeAcceptance — transport-parameterized gate.
// ---------------------------------------------------------------------------

function fakeResponse(ok: boolean, status: number, body: string): {
  ok: boolean;
  status: number;
  text(): Promise<string>;
} {
  return { ok, status, text: () => Promise.resolve(body) };
}

function makeTransport(over: {
  fetch?: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  execSh?: (cmd: string) => Promise<{ code: number; stderr: string }>;
  pollHealth?: (baseUrl: string) => Promise<void>;
  log?: (msg: string) => void;
} = {}): RuntimeAcceptanceTransport {
  const transport: RuntimeAcceptanceTransport = {
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
    execSh:
      over.execSh ?? (() => Promise.resolve({ code: 0, stderr: "" })),
    pollHealth: over.pollHealth ?? (() => Promise.resolve()),
  };
  if (over.log !== undefined) transport.log = over.log;
  return transport;
}

const defaultTargets = {
  serverBaseUrl: "http://localhost:3000",
  spaUrl: "http://localhost:5173",
  expectedInstanceId: "",
  oidcUrl: "http://localhost:3301/oidc/.well-known/openid-configuration",
  appRoleProbes: [
    { role: "nautilo", cmd: "psql -U nautilo" },
    { role: "nautilo_agent", cmd: "psql -U nautilo_agent" },
  ],
  directPostgresProbe: {
    label: "nautilo_agent direct PostgreSQL probe",
    cmd: "psql -h 127.0.0.1 -U nautilo_agent",
  },
};

describe("D427 restore-acceptance — runRuntimeAcceptance (report mode, fail-closed)", () => {
  test("happy path: all checks pass → allPassed true, seven checks (two app-role probes)", async () => {
    const report = await runRuntimeAcceptance(makeTransport(), defaultTargets);
    expect(report.allPassed).toBe(true);
    // health + identity + spa + nautilo role + nautilo_agent role + direct postgres + oidc
    expect(report.checks).toHaveLength(7);
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.checks[0]?.id).toBe("health");
    expect(report.checks[1]?.id).toBe("identity");
    expect(report.checks[2]?.id).toBe("spa");
    expect(report.checks[3]?.id).toBe("runtime-role");
    expect(report.checks[4]?.id).toBe("runtime-role");
    expect(report.checks[5]?.id).toBe("direct-postgres");
    expect(report.checks[6]?.id).toBe("oidc");
  });

  test("identity mismatch fails closed (profile vs live instanceId)", async () => {
    const report = await runRuntimeAcceptance(
      makeTransport({
        fetch: (url) =>
          url.includes("/api/setup/status")
            ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ instanceId: "wrong" })))
            : url.includes("/oidc/.well-known/openid-configuration")
              ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ issuer: "http://logto" })))
              : url.includes("/health")
                ? Promise.resolve(fakeResponse(true, 200, "ok"))
                : Promise.resolve(fakeResponse(true, 200, "<html>spa</html>")),
      }),
      { ...defaultTargets, expectedInstanceId: "expected-id" },
    );
    expect(report.allPassed).toBe(false);
    expect(
      report.checks.some((c) => c.id === "identity" && c.detail.includes("target instanceId mismatch") && c.detail.includes("profile=expected-id") && c.detail.includes("live=wrong")),
    ).toBe(true);
  });

  test("SPA returning non-HTML fails closed", async () => {
    const report = await runRuntimeAcceptance(
      makeTransport({
        fetch: (url) =>
          url.includes("/health")
            ? Promise.resolve(fakeResponse(true, 200, "ok"))
            : url.includes("/api/setup/status")
              ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ instanceId: "" })))
              : url.includes("/oidc/.well-known/openid-configuration")
                ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ issuer: "http://logto" })))
                : Promise.resolve(fakeResponse(true, 200, "plain-text-not-html")),
      }),
      defaultTargets,
    );
    expect(report.allPassed).toBe(false);
    expect(report.checks.some((c) => c.id === "spa" && c.detail.includes("non-HTML body"))).toBe(true);
  });

  test("app-role probe failure fails closed with the canonical message", async () => {
    const report = await runRuntimeAcceptance(
      makeTransport({
        execSh: (cmd) =>
          cmd === "psql -U nautilo"
            ? Promise.resolve({ code: 1, stderr: "password authentication failed for user nautilo" })
            : Promise.resolve({ code: 0, stderr: "" }),
      }),
      defaultTargets,
    );
    expect(report.allPassed).toBe(false);
    expect(
      report.checks.some(
        (c) =>
          c.id === "runtime-role" &&
          c.detail === "runtime acceptance failed: nautilo app-role connection probe failed (exit 1): password authentication failed for user nautilo",
      ),
    ).toBe(true);
  });

  test("direct PostgreSQL probe failure fails closed with the canonical message", async () => {
    const report = await runRuntimeAcceptance(
      makeTransport({
        execSh: (cmd) =>
          cmd.includes("psql -h 127.0.0.1")
            ? Promise.resolve({ code: 1, stderr: "connection refused" })
            : Promise.resolve({ code: 0, stderr: "" }),
      }),
      defaultTargets,
    );
    expect(report.allPassed).toBe(false);
    expect(
      report.checks.some(
        (c) =>
          c.id === "direct-postgres" &&
          c.detail ===
            "runtime acceptance failed: nautilo_agent direct PostgreSQL probe failed (exit 1): connection refused",
      ),
    ).toBe(true);
  });

  test("OIDC discovery with no issuer fails closed", async () => {
    const report = await runRuntimeAcceptance(
      makeTransport({
        fetch: (url) =>
          url.includes("/oidc/.well-known/openid-configuration")
            ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ issuer: "" })))
            : url.includes("/health")
              ? Promise.resolve(fakeResponse(true, 200, "ok"))
              : url.includes("/api/setup/status")
                ? Promise.resolve(fakeResponse(true, 200, JSON.stringify({ instanceId: "" })))
                : Promise.resolve(fakeResponse(true, 200, "<html>spa</html>")),
      }),
      defaultTargets,
    );
    expect(report.allPassed).toBe(false);
    expect(report.checks.some((c) => c.id === "oidc" && c.detail.includes("has no issuer"))).toBe(true);
  });

  test("health poll timeout fails closed", async () => {
    const report = await runRuntimeAcceptance(
      makeTransport({
        pollHealth: () => Promise.reject(new Error("nautilo-server /health never became ready within 1000ms (http://localhost:3000/health): HTTP 503")),
      }),
      defaultTargets,
    );
    expect(report.allPassed).toBe(false);
    expect(report.checks.some((c) => c.id === "health" && c.detail.includes("never became ready"))).toBe(true);
  });
});

describe("D427 restore-acceptance — runRuntimeAcceptance (throwOnFirstFailure mode)", () => {
  test("throws on the first failing check with the canonical message", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      runRuntimeAcceptance(
        makeTransport({
          execSh: (cmd) =>
            cmd === "psql -U nautilo"
              ? Promise.resolve({ code: 1, stderr: "password authentication failed for user nautilo" })
              : Promise.resolve({ code: 0, stderr: "" }),
        }),
        defaultTargets,
        { throwOnFirstFailure: true },
      ),
    ).rejects.toThrow(/runtime acceptance failed: nautilo app-role connection probe failed \(exit 1\)/);
  });

  test("re-throws the health poll failure verbatim", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      runRuntimeAcceptance(
        makeTransport({
          pollHealth: () => Promise.reject(new Error("nautilo-server /health never became ready within 1000ms (http://localhost:3000/health): HTTP 503")),
        }),
        defaultTargets,
        { throwOnFirstFailure: true },
      ),
    ).rejects.toThrow(/nautilo-server \/health never became ready/);
  });

  test("happy path resolves (no throw) and returns allPassed true", async () => {
    const report = await runRuntimeAcceptance(makeTransport(), defaultTargets, {
      throwOnFirstFailure: true,
    });
    expect(report.allPassed).toBe(true);
  });
});
