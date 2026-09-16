/**
 * M059 — `nautilo-dev verify-config-env`. Read-only validator that
 * catches "missing key" / "invalid format" issues in the operator's
 * `~/.nautilo/instance.env` Logto block.
 *
 * Output is a ✓ / ✗ table per LOGTO_* key (M2M_APP_SECRET masked) plus
 * the `crossKeyInvariants` aggregate verdict.
 *
 * Used by:
 *   - The migration playbook §1.0 — operators run this first when
 *     pre-flighting a Logto rollout.
 *   - CI deployment-readiness checks.
 *
 * Pure separation: `runVerifyConfigEnv()` takes a `LoadEnv` dep so the
 * unit tests pass deterministic env shapes without touching disk.
 */
import {
  assertLogtoConfigComplete,
  getModeReport,
  type ModeReportEntry,
} from "@nautilo/config-guard";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveDotenvPath } from "../lib/paths";

export interface VerifyConfigEnvArgs {
  configEnvPath?: string | undefined;
}

export interface VerifyConfigEnvDeps {
  /**
   * Returns the env snapshot to validate. Default reads
   * `~/.nautilo/instance.env` (without stomping `process.env`) and merges
   * over the result. Tests inject a literal `NodeJS.ProcessEnv`.
   */
  loadEnv: (path: string) => NodeJS.ProcessEnv;
  /** Logger; defaults to console.log. */
  log?: (msg: string) => void;
}

/**
 * Pure runner. Returns the exit code (0 = config valid, 1 = invalid
 * or load failure).
 */
export function runVerifyConfigEnv(
  args: VerifyConfigEnvArgs,
  deps: VerifyConfigEnvDeps,
): number {
  const log = deps.log ?? console.log;
  const path = args.configEnvPath?.trim() || resolveDotenvPath();

  const env = deps.loadEnv(path);
  log(`[verify-config-env] reading ${path}`);

  const report = getModeReport(env);
  log("");

  // Per-key table — entries already carry redaction-aware values via
  // getModeReport. Status is "set" / "missing"; we render the `✓ / ✗`
  // mark accordingly.
  for (const entry of report.entries) {
    log(formatRow(entry));
  }

  log("");

  // Operator-facing readiness check: always demand every LOGTO_* key is set,
  // independent of the bootstrap-aware crossKeyInvariants used by the
  // transaction validator (M116).
  const invariantErrors = assertLogtoConfigComplete(env);
  if (invariantErrors.length === 0) {
    log("✓ Logto configuration is valid.");
    return 0;
  }
  for (const err of invariantErrors) {
    log(`✗ ${err}`);
  }
  log("✗ Config is INVALID — fix the missing LOGTO_* key(s) above.");
  return 1;
}

function formatRow(entry: ModeReportEntry): string {
  if (entry.status === "missing") {
    return `✗ ${entry.envVar} — missing`;
  }
  // `value` is already masked by getModeReport when `redact` is true.
  // Append "(redacted)" to make the masking visible to the operator.
  const display = entry.redacted ? `${entry.value} (redacted)` : entry.value ?? "";
  return `✓ ${entry.envVar} = ${display}`;
}

// ---------------------------------------------------------------------------
// Production entry — wires the real `loadConfigEnvIntoProcess`.
// ---------------------------------------------------------------------------

export function verifyConfigEnv(args: VerifyConfigEnvArgs): number {
  // Build a layered env snapshot WITHOUT mutating process.env so this
  // command stays read-only. We start from a copy of process.env and
  // overlay anything from the file that isn't already set, mirroring
  // the loadConfigEnvIntoProcess "pre-set wins" semantics.
  return runVerifyConfigEnv(args, {
    loadEnv: (path) => {
      const overlay: NodeJS.ProcessEnv = { ...process.env };
      // loadConfigEnvIntoProcess takes an env handle and mutates it in
      // place; safe to reuse against our local overlay.
      loadConfigEnvIntoProcess({ path }, overlay);
      return overlay;
    },
  });
}
