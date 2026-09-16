import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetResolvedInstanceForTests } from "@nautilo/config";
import {
  runLocalCredentialReconciliation,
} from "../../src/lib/verify";
import { startServerThenRunRuntimeAcceptance } from "../../src/commands/restore";

const isolatedEnvKeys = [
  "HOME",
  "USERPROFILE",
  "NAUTILO_INSTANCE_ID",
  "NAUTILO_DOTENV_PATH",
] as const;
let isolatedHome: string;
let previousEnv: Partial<Record<(typeof isolatedEnvKeys)[number], string | undefined>>;

beforeEach(() => {
  previousEnv = Object.fromEntries(
    isolatedEnvKeys.map((key) => [key, process.env[key]]),
  );
  isolatedHome = mkdtempSync(join(tmpdir(), "nautilo-restore-reconcile-"));
  process.env["HOME"] = isolatedHome;
  process.env["USERPROFILE"] = isolatedHome;
  process.env["NAUTILO_INSTANCE_ID"] = "restore-reconcile-test";
  process.env["NAUTILO_DOTENV_PATH"] = join(isolatedHome, "instance.env");
  __resetResolvedInstanceForTests();
});

afterEach(() => {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetResolvedInstanceForTests();
  rmSync(isolatedHome, { recursive: true, force: true });
});

/**
 * D427 (Wave 4 task 4.1.1) — `nautilo-dev restore`/`upgrade` share credential
 * reconciliation and runtime acceptance semantics with the Compose path via
 * the @nautilo/db helpers. These tests pin:
 *   - the local reconciliation planner: app roles from the restored env, Logto
 *     conditional on its DB/container availability, fail-closed on a nonzero
 *     psql exit, no-op when there is nothing to reconcile;
 *   - the restore.ts wiring: reconciliation runs AFTER the .env restore,
 *     acceptance runs fail-closed at the end, and neither reports success on
 *     a desynced / unverified target.
 */
describe("D427 dev:restore — runLocalCredentialReconciliation", () => {
  test("app + logto pipelines run against the right container/db when both are in scope", async () => {
    const calls: Array<{ kind: string; container: string; db: string; sql: string }> = [];
    await runLocalCredentialReconciliation({
      instanceEnvRaw: "NAUTILO_DB_PASSWORD=pw\nNAUTILO_AGENT_DB_PASSWORD=apw\n",
      logtoAvailable: true,
      execPsql: (args) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stderr: "" });
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.kind).toBe("app");
    expect(calls[0]?.db).toBe("postgres");
    expect(calls[0]?.sql).toContain("'pw'");
    expect(calls[0]?.sql).toContain("'apw'");
    expect(calls[0]?.sql).toContain("ALTER ROLE %I WITH LOGIN PASSWORD %L");
    expect(calls[0]?.container).toContain("-postgres");
    expect(calls[1]?.kind).toBe("logto");
    expect(calls[1]?.db).toBe("logto_nautilo");
    expect(calls[1]?.sql).toContain("db_user_password FROM tenants");
  });

  test("Logto reconciliation is conditional on Logto availability (skipped when unavailable)", async () => {
    const calls: Array<{ kind: string }> = [];
    await runLocalCredentialReconciliation({
      instanceEnvRaw: "NAUTILO_DB_PASSWORD=pw\n",
      logtoAvailable: false,
      execPsql: (args) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stderr: "" });
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("app");
  });

  test("crypto reconciliation uses stdin SQL, exact attributes, and never argv", async () => {
    const calls: Array<{ kind: string; sql: string }> = [];
    await runLocalCredentialReconciliation({
      instanceEnvRaw:
        "NAUTILO_DB_PASSWORD=pw\nNAUTILO_CRYPTO_DB_PASSWORD=crypto-secret\n",
      logtoAvailable: false,
      execPsql: (args) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stderr: "" });
      },
    });
    expect(calls).toHaveLength(3);
    const crypto = calls[1]?.sql ?? "";
    expect(crypto).toContain("CREATE ROLE nautilo_crypto");
    expect(crypto).toContain("NOBYPASSRLS");
    expect(crypto).toContain("\\set crypto_password 'crypto-secret'");
    expect(calls[2]?.sql).toContain(
      "REVOKE ALL ON TABLE public.crypto_domains FROM PUBLIC, nautilo_agent",
    );
    expect(calls[2]?.sql).toContain(
      "GRANT SELECT, INSERT ON TABLE public.crypto_objects TO nautilo_crypto",
    );
  });

  test("no app passwords and Logto unavailable → no pipelines, no docker call", async () => {
    const calls: Array<{ kind: string }> = [];
    await runLocalCredentialReconciliation({
      instanceEnvRaw: "",
      logtoAvailable: false,
      execPsql: (args) => {
        calls.push(args);
        return Promise.resolve({ code: 0, stderr: "" });
      },
    });
    expect(calls).toHaveLength(0);
  });

  test("a nonzero psql exit is fail-closed (throws with the pipeline label)", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      runLocalCredentialReconciliation({
        instanceEnvRaw: "NAUTILO_DB_PASSWORD=pw\n",
        logtoAvailable: false,
        execPsql: () => Promise.resolve({ code: 1, stderr: "password authentication failed" }),
      }),
    ).rejects.toThrow(/nautilo app-role password reconcile failed \(exit 1\): password authentication failed/);
  });

  test("Logto pipeline failure is fail-closed too", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(
      runLocalCredentialReconciliation({
        instanceEnvRaw: "",
        logtoAvailable: true,
        execPsql: (args) =>
          args.kind === "logto"
            ? Promise.resolve({ code: 2, stderr: "tenants table missing" })
            : Promise.resolve({ code: 0, stderr: "" }),
      }),
    ).rejects.toThrow(/logto tenant-role password resync failed \(exit 2\)/);
  });
});

describe("D427 dev:restore — runLocalRuntimeAcceptanceExitCode (fail-closed wiring)", () => {
  test("delegates to the authoritative gate and returns 1 on failure (lexical guard)", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "lib", "verify.ts"),
      "utf8",
    );
    // The exit-code wrapper calls verify({}) (authoritative) and maps a
    // non-allPassed report to exit 1 — fail-closed, never reports success on
    // a failing gate. The real gate's fail-closed contract is pinned in the
    // @nautilo/db restore-acceptance tests; we don't invoke it here to avoid
    // a 30s /health poll against a non-running server.
    expect(src).toContain("async function runLocalRuntimeAcceptanceExitCode");
    expect(src).toContain('verify({})');
    expect(src).toContain("if (!report.allPassed)");
    expect(src).toContain("return 1");
    expect(src).toContain("return 0");
  });
});

describe("D427 dev:restore — local server start before acceptance", () => {
  test("starts the local server before running authoritative acceptance", async () => {
    const events: string[] = [];
    const code = await startServerThenRunRuntimeAcceptance({
      startServer: async () => {
        events.push("start-server");
        return 0;
      },
      accept: async () => {
        events.push("accept");
        return 0;
      },
    });

    expect(code).toBe(0);
    expect(events).toEqual(["start-server", "accept"]);
  });

  test("a failed local server start is fail-closed and skips acceptance", async () => {
    const events: string[] = [];
    const code = await startServerThenRunRuntimeAcceptance({
      startServer: async () => {
        events.push("start-server");
        return 1;
      },
      accept: async () => {
        events.push("accept");
        return 0;
      },
    });

    expect(code).toBe(1);
    expect(events).toEqual(["start-server"]);
  });
});

describe("D427 dev:restore — wiring (lexical guards)", () => {
  const restoreSrc = readFileSync(
    join(import.meta.dir, "..", "..", "src", "commands", "restore.ts"),
    "utf8",
  );

  test("reconciliation runs AFTER the restored .env is on disk", () => {
    const envRestoreIdx = restoreSrc.indexOf(".env restored.");
    // Anchor on the CALL site, not the import.
    const reconcileIdx = restoreSrc.indexOf("await runLocalCredentialReconciliation");
    expect(envRestoreIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(-1);
    // The reconcile call must come after the .env restore step so the
    // restored app-role passwords are readable.
    expect(reconcileIdx).toBeGreaterThan(envRestoreIdx);
  });

  test("legacy restored env gains the crypto credential before reconciliation", () => {
    const ensureIdx = restoreSrc.indexOf(
      "await ensureInfraCryptoDbPasswordForInstance",
    );
    const reconcileIdx = restoreSrc.indexOf(
      "await runLocalCredentialReconciliation",
    );
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeLessThan(reconcileIdx);
  });

  test("reconciliation is fail-closed (process.exit(1) on reconcile failure)", () => {
    expect(restoreSrc).toContain("runLocalCredentialReconciliation");
    // The reconcile try/catch exits non-zero on a throw.
    const tryIdx = restoreSrc.indexOf("await runLocalCredentialReconciliation");
    const block = restoreSrc.slice(tryIdx, tryIdx + 400);
    expect(block).toContain("process.exit(1)");
  });

  test("Logto reconciliation is conditional on its DB/container availability", () => {
    // The shared helper defaults to isLogtoContainerRunning() && logtoDatabaseExists();
    // restore.ts delegates that decision to the helper (no unconditional Logto
    // reconcile).
    expect(restoreSrc).not.toContain("reconcileLogto: true");
  });

  test("authoritative runtime acceptance runs fail-closed at the end of restore", () => {
    // Anchor on the CALL site, not the import.
    const acceptIdx = restoreSrc.indexOf("await startServerThenRunRuntimeAcceptance");
    const summaryIdx = restoreSrc.indexOf("Summary");
    expect(acceptIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(-1);
    // Acceptance runs after the summary, as the final gate.
    expect(acceptIdx).toBeGreaterThan(summaryIdx);
    const block = restoreSrc.slice(acceptIdx, acceptIdx + 600);
    expect(block).toContain("process.exit(1)");
  });

  test("restore wires serverStart before the authoritative acceptance callback", () => {
    const gateIdx = restoreSrc.indexOf("await startServerThenRunRuntimeAcceptance");
    const gateBlock = restoreSrc.slice(gateIdx, gateIdx + 500);
    expect(gateBlock).toContain("startServer: () => serverStart()");
    expect(gateBlock).toContain("accept: () => runLocalRuntimeAcceptanceExitCode");
  });

  test("restore no longer advertises the old advisory-only verify hint", () => {
    // The pre-Wave-4 message told the operator to run dev:verify as a
    // smoke check; restore now runs the authoritative gate itself.
    expect(restoreSrc).not.toContain("smoke-check the restored state");
  });
});

describe("D427 dev:upgrade — wiring (lexical guards)", () => {
  const upgradeSrc = readFileSync(
    join(import.meta.dir, "..", "..", "src", "commands", "upgrade.ts"),
    "utf8",
  );

  test("runUpgrade wires reconcile + accept as optional fail-closed deps after migrations", () => {
    expect(upgradeSrc).toContain("reconcile?:");
    expect(upgradeSrc).toContain("accept?:");
    expect(upgradeSrc).toContain("deps.reconcile");
    expect(upgradeSrc).toContain("deps.accept");
    // Reconcile runs before accept (order is load-bearing).
    const reconcileIdx = upgradeSrc.indexOf("deps.reconcile");
    const acceptIdx = upgradeSrc.indexOf("deps.accept");
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(acceptIdx).toBeGreaterThan(reconcileIdx);
  });

  test("production upgrade() wires the real shared reconciliation + acceptance", () => {
    expect(upgradeSrc).toContain("runLocalCredentialReconciliation");
    expect(upgradeSrc).toContain("runLocalRuntimeAcceptanceExitCode");
  });

  test("reconcile/accept are skipped on --dry-run (no mutations)", () => {
    // The gate is behind `!args.dryRun && deps.reconcile` / `deps.accept`.
    expect(upgradeSrc).toContain("!args.dryRun && deps.reconcile");
    expect(upgradeSrc).toContain("!args.dryRun && deps.accept");
  });
});
