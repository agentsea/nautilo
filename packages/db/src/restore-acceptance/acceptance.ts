// D427 (Wave 4 task 4.1.1 / 4.1.2) — shared runtime-acceptance gate.
//
// Post-deploy / post-restore / post-upgrade verification that replaces a
// `/health`-only advisory with a fail-closed gate. Without requiring a
// browser or end-user session, it proves:
//   1. the server `/health` is ready (via the caller's health poll);
//   2. target/profile instance identity via `GET /api/setup/status` (the
//      live `instanceId` must match the profile's instance id);
//   3. SPA availability (the public surface serves HTML);
//   4. real credentialed app-role connection probes — `nautilo` and
//      `nautilo_agent` each authenticate against the restored cluster with
//      the runtime credentials (privilege checks alone are insufficient);
//   4b. a real parameterized direct PostgreSQL wire probe for the agent role
//      on the host-published postgres port so a wrong port cannot hide behind
//      a passing in-container psql probe;
//   5. Logto OIDC discovery (the well-known doc is live after tenant-role
//      password reconciliation).
//
// The helper is transport-parameterized: the caller builds the transport-
// specific probe commands (compose-exec for the deploy driver, docker-exec
// for the local dev tool) and supplies `fetch` / `execSh` / `pollHealth`
// thunks. The gate supplies the check catalog, ordering, fail-closed
// semantics, and the canonical error messages. This is the small
// transport-parameterized helper the Wave 4 design calls for — not a broad
// new abstraction.
//
// This module is dependency-free so it can be imported by operator tooling
// without pulling the full @nautilo/db runtime.

/** The five required acceptance checks plus the retained health poll. */
export type RuntimeAcceptanceCheckId =
  | "health"
  | "identity"
  | "spa"
  | "runtime-role"
  | "direct-postgres"
  | "oidc";

export interface RuntimeAcceptanceResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface RuntimeAcceptanceExecResult {
  code: number;
  stderr: string;
}

/**
 * Transport the caller wires. `fetch` mirrors the global `fetch` surface the
 * gate needs (`ok`, `status`, `text()`). `execSh` runs a single `sh -c`
 * probe command and returns its exit code + stderr — the caller routes
 * Docker to the right daemon (DOCKER_HOST for remote profiles) and expands
 * credentials inside the target container. `pollHealth` throws on timeout so
 * the gate surfaces the canonical "/health never became ready" failure.
 */
export interface RuntimeAcceptanceTransport {
  fetch(url: string): Promise<RuntimeAcceptanceResponse>;
  execSh(cmd: string): Promise<RuntimeAcceptanceExecResult>;
  pollHealth(serverBaseUrl: string): Promise<void>;
  log?: (msg: string) => void;
}

export interface RuntimeAcceptanceAppRoleProbe {
  /** Postgres role name; used in the fail-closed error message. */
  role: string;
  /** The fully-built `sh -c` probe command (caller constructs). */
  cmd: string;
}

export interface RuntimeAcceptanceDirectPostgresProbe {
  /** Label used in the fail-closed error message. */
  label: string;
  /** The fully-built `sh -c` probe command (caller constructs). */
  cmd: string;
}

export interface RuntimeAcceptanceTargets {
  serverBaseUrl: string;
  spaUrl: string;
  /** Profile's expected instance id (empty string = default instance). */
  expectedInstanceId: string;
  oidcUrl: string;
  appRoleProbes: RuntimeAcceptanceAppRoleProbe[];
  /** M215 — host-side or runtime parameterized direct wire probe. */
  directPostgresProbe?: RuntimeAcceptanceDirectPostgresProbe;
}

export interface RuntimeAcceptanceCheck {
  id: RuntimeAcceptanceCheckId;
  title: string;
  passed: boolean;
  detail: string;
}

export interface RuntimeAcceptanceReport {
  allPassed: boolean;
  checks: RuntimeAcceptanceCheck[];
}

export interface RuntimeAcceptanceOptions {
  /**
   * Throw on the first failing check with the canonical
   * `runtime acceptance failed: ...` message. This is the Compose
   * deploy/upgrade/rollback gate behavior — a failure drives rollback.
   * Default `false`: run every check, return a report (the `dev:verify`
   * behavior — report every failure rather than short-circuiting).
   */
  throwOnFirstFailure?: boolean;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint"
  ) {
    return String(err);
  }
  try {
    const json = JSON.stringify(err);
    if (json !== undefined) return json;
  } catch {
    /* fall through */
  }
  return "unknown error";
}

function acceptanceError(detail: string): Error {
  return new Error(detail);
}

/**
 * Run the shared runtime-acceptance gate. Checks run in the canonical order
 * (health → identity → spa → app-role probes → direct postgres → OIDC). In
 * `throwOnFirstFailure` mode the first failing check throws
 * `runtime acceptance failed: ...` (the health check re-throws its poll
 * failure verbatim). In report mode every check runs and the report's
 * `allPassed` is the fail-closed aggregate — a single failure means
 * `allPassed === false`.
 */
export async function runRuntimeAcceptance(
  transport: RuntimeAcceptanceTransport,
  targets: RuntimeAcceptanceTargets,
  options?: RuntimeAcceptanceOptions,
): Promise<RuntimeAcceptanceReport> {
  const log = transport.log ?? (() => {});
  const throwOnFirstFailure = options?.throwOnFirstFailure ?? false;
  const checks: RuntimeAcceptanceCheck[] = [];

  const record = (check: RuntimeAcceptanceCheck): void => {
    checks.push(check);
    if (throwOnFirstFailure && !check.passed) {
      throw acceptanceError(check.detail);
    }
  };

  // 1. Retained normal health check (caller's poll throws on timeout).
  try {
    await transport.pollHealth(targets.serverBaseUrl);
    log(`runtime acceptance: /health ready at ${targets.serverBaseUrl}/health`);
    checks.push({
      id: "health",
      title: "Nautilo server /health",
      passed: true,
      detail: "ready",
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    record({
      id: "health",
      title: "Nautilo server /health",
      passed: false,
      detail,
    });
  }

  // 2. Target/profile instance identity via the setup-status surface.
  const setupUrl = `${targets.serverBaseUrl}/api/setup/status`;
  try {
    const setupRes = await transport.fetch(setupUrl);
    if (!setupRes.ok) {
      record({
        id: "identity",
        title: "Target/profile instance identity",
        passed: false,
        detail: `runtime acceptance failed: GET ${setupUrl} returned HTTP ${setupRes.status}`,
      });
    } else {
      let setupBody: string;
      try {
        setupBody = await setupRes.text();
      } catch (err) {
        record({
          id: "identity",
          title: "Target/profile instance identity",
          passed: false,
          detail: `runtime acceptance failed: could not read ${setupUrl} body: ${errorMessage(err)}`,
        });
        setupBody = "";
      }
      if (setupBody !== "") {
        let setup: { instanceId?: unknown };
        try {
          setup = JSON.parse(setupBody) as { instanceId?: unknown };
        } catch {
          record({
            id: "identity",
            title: "Target/profile instance identity",
            passed: false,
            detail: `runtime acceptance failed: ${setupUrl} returned non-JSON body`,
          });
          setup = {};
        }
        if (setup !== null && typeof setup === "object" && "instanceId" in setup) {
          const liveInstanceId =
            typeof setup.instanceId === "string" ? setup.instanceId.trim() : "";
          if (liveInstanceId !== targets.expectedInstanceId) {
            record({
              id: "identity",
              title: "Target/profile instance identity",
              passed: false,
              detail:
                `runtime acceptance failed: target instanceId mismatch ` +
                `(profile=${targets.expectedInstanceId || "<default>"} live=${
                  liveInstanceId || "<default>"
                })`,
            });
          } else {
            log(
              `runtime acceptance: instance identity verified (${liveInstanceId || "<default>"})`,
            );
            checks.push({
              id: "identity",
              title: "Target/profile instance identity",
              passed: true,
              detail: `instanceId=${liveInstanceId || "<default>"}`,
            });
          }
        }
      }
    }
  } catch (err) {
    record({
      id: "identity",
      title: "Target/profile instance identity",
      passed: false,
      detail: `runtime acceptance failed: could not reach ${setupUrl}: ${errorMessage(err)}`,
    });
  }

  // 3. SPA availability — the public surface serves HTML.
  try {
    const spaRes = await transport.fetch(targets.spaUrl);
    if (!spaRes.ok) {
      record({
        id: "spa",
        title: "SPA availability",
        passed: false,
        detail: `runtime acceptance failed: SPA GET ${targets.spaUrl} returned HTTP ${spaRes.status}`,
      });
    } else {
      const spaBody = await spaRes.text();
      if (!/</.test(spaBody)) {
        record({
          id: "spa",
          title: "SPA availability",
          passed: false,
          detail: `runtime acceptance failed: SPA GET ${targets.spaUrl} returned a non-HTML body`,
        });
      } else {
        log(`runtime acceptance: SPA available at ${targets.spaUrl}`);
        checks.push({
          id: "spa",
          title: "SPA availability",
          passed: true,
          detail: "serves HTML",
        });
      }
    }
  } catch (err) {
    record({
      id: "spa",
      title: "SPA availability",
      passed: false,
      detail: `runtime acceptance failed: could not reach ${targets.spaUrl}: ${errorMessage(err)}`,
    });
  }

  // 4. Real credentialed app-role connection probes.
  for (const probe of targets.appRoleProbes) {
    log(`runtime acceptance: probing ${probe.role} app-role connection...`);
    try {
      const probeRes = await transport.execSh(probe.cmd);
      if (probeRes.code !== 0) {
        record({
          id: "runtime-role",
          title: `${probe.role} app-role connection probe`,
          passed: false,
          detail: `runtime acceptance failed: ${probe.role} app-role connection probe failed (exit ${probeRes.code}): ${probeRes.stderr.trim()}`,
        });
      } else {
        log(`runtime acceptance: ${probe.role} app-role connection verified`);
        checks.push({
          id: "runtime-role",
          title: `${probe.role} app-role connection probe`,
          passed: true,
          detail: "SELECT 1 ok",
        });
      }
    } catch (err) {
      record({
        id: "runtime-role",
        title: `${probe.role} app-role connection probe`,
        passed: false,
        detail: `runtime acceptance failed: ${probe.role} app-role connection probe errored: ${errorMessage(err)}`,
      });
    }
  }

  // 4b. Real parameterized direct PostgreSQL wire probe for the agent role.
  if (targets.directPostgresProbe) {
    const wireProbe = targets.directPostgresProbe;
    log(`runtime acceptance: probing ${wireProbe.label}...`);
    try {
      const wireProbeRes = await transport.execSh(wireProbe.cmd);
      if (wireProbeRes.code !== 0) {
        record({
          id: "direct-postgres",
          title: "nautilo_agent direct PostgreSQL probe",
          passed: false,
          detail: `runtime acceptance failed: ${wireProbe.label} failed (exit ${wireProbeRes.code}): ${wireProbeRes.stderr.trim()}`,
        });
      } else {
        log(`runtime acceptance: ${wireProbe.label} verified`);
        checks.push({
          id: "direct-postgres",
          title: "nautilo_agent direct PostgreSQL probe",
          passed: true,
          detail: "parameterized SELECT ok",
        });
      }
    } catch (err) {
      record({
        id: "direct-postgres",
        title: "nautilo_agent direct PostgreSQL probe",
        passed: false,
        detail: `runtime acceptance failed: ${wireProbe.label} errored: ${errorMessage(err)}`,
      });
    }
  }

  // 5. Logto OIDC discovery (live after tenant-role password reconciliation).
  try {
    const oidcRes = await transport.fetch(targets.oidcUrl);
    if (!oidcRes.ok) {
      record({
        id: "oidc",
        title: "Logto OIDC discovery",
        passed: false,
        detail: `runtime acceptance failed: Logto OIDC discovery GET ${targets.oidcUrl} returned HTTP ${oidcRes.status}`,
      });
    } else {
      const oidcBody = await oidcRes.text();
      let oidc: { issuer?: unknown };
      try {
        oidc = JSON.parse(oidcBody) as { issuer?: unknown };
      } catch {
        record({
          id: "oidc",
          title: "Logto OIDC discovery",
          passed: false,
          detail: `runtime acceptance failed: Logto OIDC discovery at ${targets.oidcUrl} returned non-JSON body`,
        });
        oidc = {};
      }
      if (oidc !== null && typeof oidc === "object" && "issuer" in oidc) {
        if (typeof oidc.issuer !== "string" || oidc.issuer.trim() === "") {
          record({
            id: "oidc",
            title: "Logto OIDC discovery",
            passed: false,
            detail: `runtime acceptance failed: Logto OIDC discovery at ${targets.oidcUrl} has no issuer`,
          });
        } else {
          log(`runtime acceptance: Logto OIDC discovery live at ${targets.oidcUrl}`);
          checks.push({
            id: "oidc",
            title: "Logto OIDC discovery",
            passed: true,
            detail: `issuer=${oidc.issuer}`,
          });
        }
      }
    }
  } catch (err) {
    record({
      id: "oidc",
      title: "Logto OIDC discovery",
      passed: false,
      detail: `runtime acceptance failed: could not reach ${targets.oidcUrl}: ${errorMessage(err)}`,
    });
  }

  return {
    allPassed: checks.length > 0 && checks.every((c) => c.passed),
    checks,
  };
}
