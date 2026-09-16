/**
 * M059 — `nautilo-dev upgrade`. Operator-facing one-shot:
 *
 *   1. Auto-snapshot (unless --dry-run) — covers Nautilo + Logto DBs +
 *      ~/.nautilo + .env. The rollback path if anything below fails.
 *   2. `bun run db:migrate` (drizzle-kit) for the Nautilo DB.
 *   3. `bun x @logto/cli@<pinned> db alteration deploy <pinned>` for the
 *      Logto DB, ONLY if `logto_nautilo` exists on the running cluster.
 *      The CLI version AND the deploy target are pinned to the deployed
 *      Logto server version (see LOGTO_CLI_VERSION) — an unpinned `@latest`
 *      both errors "Missing target version" and would push alterations
 *      newer than the running server.
 *
 * Order is load-bearing: drizzle BEFORE Logto. If drizzle fails we
 * abort with the snapshot intact, so the operator's rollback is
 * `bun run dev:restore <auto-pre-upgrade-...>`.
 *
 * Pure runner takes injectable deps so unit tests cover every branch
 * (snapshot ran or skipped, drizzle ok or failed, Logto present or
 * absent) without touching docker / Postgres / npx.
 */
import { save } from "./save";
import { logtoDatabaseExists, getLogtoDbUrl } from "../lib/logto-db";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";
import {
  runLocalCredentialReconciliation,
  runLocalRuntimeAcceptanceExitCode,
} from "../lib/verify";
import { DEPENDENCY_PINS } from "../../../../deploy/dependency-pins";
import { resolveInstance } from "@nautilo/config";
import { ensureInfraCryptoDbPasswordForInstance } from "../lib/compose-infra";
import { join } from "node:path";

/**
 * Logto CLI version + `db alteration deploy` target, DERIVED from the
 * deployed Logto server image tag (`deploy/dependency-pins.ts` — the single
 * source of truth for "what Logto version runs here"). The alteration set
 * applied to the DB must match the running server by definition, so the CLI
 * version and the deploy target follow the image pin automatically.
 *
 * Why pinning matters at all: an unpinned `bun x @logto/cli` pulls `@latest`,
 * whose `deploy` with no target errors "Missing target version" — and would
 * otherwise deploy alterations NEWER than the running server.
 */
const LOGTO_CLI_VERSION = DEPENDENCY_PINS.logtoImageTag;

export interface UpgradeArgs {
  dryRun?: boolean | undefined;
  /** D202: explicit opt-in to upgrade the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
}

export interface UpgradeDeps {
  /** Take a snapshot. Real impl is `save(...)` from this package. */
  snapshot: (name: string) => Promise<void>;
  /** Returns true iff `logto_nautilo` is present on the cluster. */
  hasLogtoDb: () => boolean;
  /** Run a shell command. Resolves `{ ok, code }`. Tests inject. */
  runShell: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<{ ok: boolean; code: number }>;
  /** Resolves `DB_URL` for the Logto CLI. */
  logtoDbUrl: () => string;
  /** Logger; defaults to console.log. */
  log?: (msg: string) => void;
  /** ISO-stamp generator for the snapshot name (test seam). */
  isoStamp?: () => string;
  /**
   * M231 — create/reconcile nautilo_crypto before Drizzle can apply policies
   * scoped to that role. Optional for the pure legacy runner; production
   * always wires it.
   */
  prepareDbRoles?: () => Promise<number>;
  /**
   * D427 (Wave 4 task 4.1.1) — credential reconciliation run AFTER migrations
   * succeed. Re-pins app-role + Logto tenant role passwords to the restored
   * state. Returns 0 on success, non-zero on fail-closed failure. Optional:
   * the pure runner skips it when unset (legacy test behavior); the production
   * entry always wires the real @nautilo/db-backed implementation.
   */
  reconcile?: () => Promise<number>;
  /**
   * D427 (Wave 4 task 4.1.2) — authoritative runtime-acceptance gate run
   * AFTER reconciliation. Returns 0 on success, non-zero on fail-closed
   * failure (runtime-role / Neon HTTP / OIDC / identity / SPA). Optional:
   * skipped when unset; production always wires the real gate.
   */
  accept?: () => Promise<number>;
}

/**
 * Pure runner — exit code only. The CLI dispatcher passes this to
 * `process.exit(...)`. Real wiring (process spawning, save() import)
 * is in `upgrade()` below.
 */
export async function runUpgrade(
  args: UpgradeArgs,
  deps: UpgradeDeps,
): Promise<number> {
  const log = deps.log ?? console.log;
  const isoStamp = deps.isoStamp ?? defaultIsoStamp;

  log("[upgrade] Upgrading Nautilo + Logto schemas...");

  // -- Step 1: auto-snapshot (skip on --dry-run) -------------------
  if (!args.dryRun) {
    const name = `auto-pre-upgrade-${isoStamp()}`;
    log(`[upgrade] Auto-saving current state as "${name}"...`);
    try {
      await deps.snapshot(name);
      log(`[upgrade] Roll back with: bun run dev:restore ${name}`);
    } catch (err) {
      log(
        `[upgrade] Auto-save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      log(
        "[upgrade] Refusing to upgrade. Fix the snapshot path or pass --dry-run.",
      );
      return 1;
    }
  } else {
    log("[upgrade] DRY-RUN — skipping auto-snapshot.");
  }

  // -- Step 2: M231 role preflight ----------------------------------
  if (!args.dryRun && deps.prepareDbRoles) {
    log("[upgrade] Preparing database roles before migrations...");
    const rc = await deps.prepareDbRoles();
    if (rc !== 0) {
      log(`[upgrade] Database-role preparation FAILED (exit ${rc}).`);
      return rc;
    }
  }

  // -- Step 3: Nautilo DB migration --------------------------------
  log("[upgrade] Running drizzle-kit migrate...");
  if (args.dryRun) {
    log("[upgrade]   [dry-run] would run: bun run db:migrate");
  } else {
    const r = await deps.runShell("bun", ["run", "db:migrate"], {
      cwd: join(import.meta.dir, "../../../../packages/db"),
    });
    if (!r.ok) {
      log(
        `[upgrade] drizzle-kit migrate FAILED (exit ${r.code}). Logto migration skipped.`,
      );
      log(
        "[upgrade] Roll back with: bun run dev:restore auto-pre-upgrade-...",
      );
      return r.code;
    }
  }

  // -- Step 4: Logto DB migration ----------------------------------
  if (!deps.hasLogtoDb()) {
    log(
      "[upgrade] No logto_nautilo on the running cluster — skipping Logto migration.",
    );
  } else {
    log("[upgrade] Running Logto db alteration deploy...");
    const dbUrl = deps.logtoDbUrl();
    if (args.dryRun) {
      log(
        `[upgrade]   [dry-run] would run: bun x @logto/cli@${LOGTO_CLI_VERSION} db alteration deploy ${LOGTO_CLI_VERSION}`,
      );
      log(`[upgrade]   [dry-run]   with DB_URL=postgres://logto:***@.../logto_nautilo`);
    } else {
      const r = await deps.runShell(
        "bun",
        ["x", `@logto/cli@${LOGTO_CLI_VERSION}`, "db", "alteration", "deploy", LOGTO_CLI_VERSION],
        { env: { ...process.env, DB_URL: dbUrl } },
      );
      if (!r.ok) {
        log(`[upgrade] Logto migration FAILED (exit ${r.code}).`);
        log(
          "[upgrade] Roll back with: bun run dev:restore auto-pre-upgrade-...",
        );
        return r.code;
      }
    }
  }

  // -- Step 5: D427 (Wave 4 task 4.1.1) — credential reconciliation --
  // Re-pin app-role + Logto tenant role passwords to the restored state
  // after migrations land. Fail-closed: a reconcile failure aborts the
  // upgrade with the snapshot intact. Skipped on --dry-run (no mutations)
  // and when no `reconcile` dep is wired (legacy test behavior).
  if (!args.dryRun && deps.reconcile) {
    log("[upgrade] Reconciling restored credentials...");
    const rc = await deps.reconcile();
    if (rc !== 0) {
      log(`[upgrade] Credential reconciliation FAILED (exit ${rc}).`);
      log(
        "[upgrade] Roll back with: bun run dev:restore auto-pre-upgrade-...",
      );
      return rc;
    }
  }

  // -- Step 6: D427 (Wave 4 task 4.1.2) — runtime acceptance gate -----
  // The upgrade does NOT report success until the runtime-role,
  // parameterized Neon HTTP, OIDC, instance identity, and SPA checks
  // pass. Fail-closed. Skipped on --dry-run and when no `accept` dep is
  // wired (legacy test behavior).
  if (!args.dryRun && deps.accept) {
    log("[upgrade] Running runtime acceptance gate...");
    const ac = await deps.accept();
    if (ac !== 0) {
      log(`[upgrade] Runtime acceptance FAILED (exit ${ac}).`);
      log(
        "[upgrade] Roll back with: bun run dev:restore auto-pre-upgrade-...",
      );
      return ac;
    }
  }

  log("[upgrade] Upgrade complete.");
  return 0;
}

function defaultIsoStamp(): string {
  // Match the convention used by restore.ts / clean.ts — colons + dots
  // are filename-hostile; strip them.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// Production entry — wires the real `save()` + `spawn()` deps.
// ---------------------------------------------------------------------------

export async function upgrade(args: UpgradeArgs): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:upgrade",
    cwd: process.cwd(),
    isDryRunOrReadOnly: args.dryRun === true,
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  const { spawn } = await import("node:child_process");

  const runShell = (
    cmd: string,
    spawnArgs: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ ok: boolean; code: number }> => {
    return new Promise((resolve) => {
      const proc = spawn(cmd, spawnArgs, {
        stdio: "inherit",
        cwd: opts?.cwd,
        env: opts?.env ?? process.env,
      });
      proc.on("close", (code) => {
        resolve({ ok: code === 0, code: code ?? 1 });
      });
    });
  };

  return runUpgrade(args, {
    snapshot: (name) => save(name),
    hasLogtoDb: () => logtoDatabaseExists(),
    runShell,
    logtoDbUrl: () => getLogtoDbUrl(),
    prepareDbRoles: async () => {
      try {
        await ensureInfraCryptoDbPasswordForInstance(resolveInstance());
        await runLocalCredentialReconciliation({
          logtoAvailable: false,
          reconcileCryptoPrivileges: false,
          log: (m) => console.log(m),
        });
        return 0;
      } catch (err) {
        console.error(
          `[upgrade] ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    },
    // D427 (Wave 4) — production always wires the shared fail-closed
    // reconciliation + acceptance so the local upgrade shares the Compose
    // path's contract. The pure runner skips these when unset (test seam).
    reconcile: async () => {
      try {
        await ensureInfraCryptoDbPasswordForInstance(resolveInstance());
        await runLocalCredentialReconciliation({ log: (m) => console.log(m) });
        return 0;
      } catch (err) {
        console.error(
          `[upgrade] ${err instanceof Error ? err.message : String(err)}`,
        );
        return 1;
      }
    },
    accept: () => runLocalRuntimeAcceptanceExitCode((m) => console.log(m)),
  });
}
