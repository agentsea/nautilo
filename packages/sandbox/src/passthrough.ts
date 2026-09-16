/**
 * Passthrough (no-containment) spawn builder. D060 Phase 1 task 1.6.
 *
 * Used when:
 *   - `config.mode === "disabled"` (operator opted out of containment)
 *   - `backend.kind === "none"` (no bwrap / sandbox-exec available) at
 *     non-paranoid levels — the operator's security-level policy in 1.7
 *     decides whether this path is acceptable or a hard fail.
 *
 * Passthrough still ENFORCES the env taxonomy (RESERVED + DANGEROUS)
 * so a missing backend doesn't silently degrade the env-blocklist
 * discipline. Specifically:
 *
 *   - PATH / HOME / TMPDIR / CI / DEBIAN_FRONTEND are set to hardened
 *     defaults (sandbox-local intent preserved even without
 *     containment; tests that depend on HOME pointing at a specific
 *     dir should still pass).
 *   - SAFE_ENV_VARS forwarded from parent.
 *   - passthroughEnv forwarded, reserved names skipped.
 *   - commandEnv forwarded, reserved names skipped, dangerous names
 *     dropped with WARN — same discipline as the bwrap builder.
 *
 * Port: Spacebot `src/sandbox.rs:716-784` (`wrap_passthrough`), minus
 * the Linux session-keyring isolation (deferred to D041 when our
 * secret store ships).
 */

import { delimiter as pathDelimiter } from "node:path";

import { warn } from "@nautilo/logger";

import {
  SAFE_ENV_VARS,
  isDangerousEnvVar,
  isReservedEnvVar,
} from "./env-vars";
import type { SandboxConfig, SpawnArgs } from "./types";

export interface PassthroughBuildOptions {
  readonly workspace: string;
  readonly toolsBin: string;
  readonly config: SandboxConfig;
  readonly cwd: string;
  readonly commandEnv: Readonly<Record<string, string>>;
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * Build the passthrough spawn. Returns SpawnArgs with `env: <map>` —
 * the caller spawns with exactly this env (no inheritance). That's
 * intentional: inheriting parent env leaks system secrets (OpenAI
 * keys, DB creds, etc.) into shell subprocesses.
 *
 * HOME handling mirrors Spacebot: prefer parent's HOME for
 * user-expected behavior when containment is off, fall back to the
 * workspace path.
 */
export function buildPassthrough(opts: PassthroughBuildOptions): SpawnArgs {
  const env: Record<string, string> = {};

  // PATH: tools-bin prepended ahead of parent PATH (same as bwrap
  // builder so the sandbox vs. passthrough paths are environment-
  // indistinguishable to the child).
  const parentPath = process.env["PATH"] ?? "";
  env["PATH"] =
    parentPath.length > 0
      ? `${opts.toolsBin}${pathDelimiter}${parentPath}`
      : opts.toolsBin;

  // HOME: prefer parent's when set + non-empty, fall back to the
  // workspace path. Spacebot's `wrap_passthrough` lines 727-729 use
  // the same pattern.
  const parentHome = process.env["HOME"];
  env["HOME"] =
    parentHome !== undefined && parentHome.length > 0 ? parentHome : opts.workspace;

  env["TMPDIR"] = process.env["TMPDIR"] ?? "/tmp";
  env["CI"] = "true";
  env["DEBIAN_FRONTEND"] = "noninteractive";

  // SAFE forwards
  for (const name of SAFE_ENV_VARS) {
    const val = process.env[name];
    if (val !== undefined) {
      env[name] = val;
    }
  }

  // passthroughEnv (skip reserved)
  for (const name of opts.config.passthroughEnv) {
    if (isReservedEnvVar(name)) continue;
    const val = process.env[name];
    if (val !== undefined) {
      env[name] = val;
    }
  }

  // commandEnv (skip reserved, DROP dangerous w/ WARN)
  for (const [name, value] of Object.entries(opts.commandEnv)) {
    if (isReservedEnvVar(name)) continue;
    if (isDangerousEnvVar(name)) {
      warn(`[sandbox/passthrough] dropping dangerous per-command env var: ${name}`);
      continue;
    }
    env[name] = value;
  }

  return {
    program: opts.program,
    args: [...opts.args],
    env,
    cwd: opts.cwd,
  };
}
