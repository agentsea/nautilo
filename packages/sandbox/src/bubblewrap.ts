/**
 * Bubblewrap arg builder for `@nautilo/sandbox`. D060 Phase 1 task 1.5.
 *
 * Port: Spacebot `src/sandbox.rs:478-636` (`wrap_bubblewrap`). The
 * implementation is a 1:1 translation with TS adaptations. Every
 * step is numbered to match the comments in the Rust source so a
 * reviewer can diff the two side-by-side.
 *
 * Mount order MATTERS — later mounts override earlier ones in
 * bwrap. Changing the order silently breaks isolation. The numbered
 * sequence below is the canonical order:
 *
 *   1.  --ro-bind each LINUX_READ_ONLY_SYSTEM_PATHS entry that exists
 *   1a. --ro-bind the tools-bin dir (if it exists)
 *   2.  --dev /dev      (writable device mount)
 *   3.  --proc /proc    (iff procSupported)
 *   4.  --tmpfs /tmp    (private per invocation)
 *   5.  --bind workspace workspace    (writable)
 *   6a. --ro-bind each readOnlyPaths entry (canonicalized, if present)
 *   6b. --bind each writable path (canonicalized)  ← wins over 6a if overlap
 *   7.  --tmpfs dataDir (mask agent data dir even if workspace-overlapping)
 *   7a. --tmpfs each protectedPaths entry (D418 3.2.1 deny-overrides) ← wins over 1/5/6
 *   8.  --unshare-pid --new-session --die-with-parent  (isolation + no orphans)
 *   8a. --unshare-net iff networkPolicy.mode is not "host" (D103 Linux fail-closed)
 *   9.  --clearenv      (default-deny env)
 *   10. --chdir cwd     (working directory inside sandbox)
 *   11. --setenv PATH + HOME + TMPDIR + CI + DEBIAN_FRONTEND  (hardened defaults)
 *   12. --setenv SAFE_ENV_VARS forwards  (from parent where present)
 *   13. --setenv passthroughEnv (user-configured; skip reserved)
 *   14. --setenv commandEnv (per-call; skip reserved, DROP dangerous w/ WARN)
 *   15. --  program  args
 */

import { existsSync, lstatSync } from "node:fs";
import { delimiter as pathDelimiter } from "node:path";

import { debug, warn } from "@nautilo/logger";

import {
  SAFE_ENV_VARS,
  isDangerousEnvVar,
  isReservedEnvVar,
} from "./env-vars";
import { canonicalize } from "./paths";
import { LINUX_READ_ONLY_SYSTEM_PATHS } from "./system-paths";
import type { SandboxConfig, SpawnArgs } from "./types";

export interface BubblewrapBuildOptions {
  readonly workspace: string;
  readonly dataDir: string;
  readonly toolsBin: string;
  readonly procSupported: boolean;
  /** Detector-proved support for safe late regular-file overmounts. */
  readonly fileMaskSupported?: boolean;
  readonly config: SandboxConfig;
  readonly cwd: string;
  /** Per-invocation env from the tool caller — RESERVED skipped, DANGEROUS dropped w/ WARN. */
  readonly commandEnv: Readonly<Record<string, string>>;
  /**
   * Program + args to execute inside the sandbox. Appended after
   * the `--` sentinel that bwrap uses to separate its own flags
   * from the inner command.
   */
  readonly program: string;
  readonly args: readonly string[];
}

/**
 * Build the `bwrap` spawn command. The child process that execs bwrap
 * gets a minimal env (currently PATH only); bwrap then injects the
 * sandboxed program's env via `--clearenv` + `--setenv` chains.
 *
 * This matters because loader-level vars like LD_PRELOAD affect the
 * bwrap process itself before `--clearenv` can run.
 */
export function buildBubblewrap(opts: BubblewrapBuildOptions): SpawnArgs {
  const bwrapArgs: string[] = [];

  // Step 1: --ro-bind each system path that exists.
  // Port: Spacebot src/sandbox.rs:494-500.
  for (const sysPath of LINUX_READ_ONLY_SYSTEM_PATHS) {
    if (existsSync(sysPath)) {
      bwrapArgs.push("--ro-bind", sysPath, sysPath);
    }
  }

  // Step 1a: --ro-bind the tools-bin path if present.
  // Port: src/sandbox.rs:503-507.
  if (existsSync(opts.toolsBin)) {
    bwrapArgs.push("--ro-bind", opts.toolsBin, opts.toolsBin);
  }

  // Step 2: --dev /dev (writable device mount).
  // Port: src/sandbox.rs:510.
  bwrapArgs.push("--dev", "/dev");

  // Step 3: --proc /proc (iff procSupported).
  // Port: src/sandbox.rs:513-515.
  if (opts.procSupported) {
    bwrapArgs.push("--proc", "/proc");
  }

  // Step 4: --tmpfs /tmp (private per invocation).
  // Port: src/sandbox.rs:518.
  bwrapArgs.push("--tmpfs", "/tmp");

  // Step 5: --bind workspace writable.
  // Port: src/sandbox.rs:521.
  bwrapArgs.push("--bind", opts.workspace, opts.workspace);

  // Step 6a: --ro-bind each readOnlyPaths entry (D060 Sprint 1 G5.1).
  // Canonicalized; missing paths skipped with a debug log — a
  // non-existent readOnly path shouldn't abort bootstrap (fresh
  // project without ~/Downloads, etc.). Deployment profiles
  // (§5.2) populate this field; `desktop-permissive` sets it to
  // the user's home so the agent can READ but not WRITE home
  // files. Step 6b below then re-asserts the narrow writable
  // surface — bwrap later-wins means overlapping writable paths
  // override the ro-bind.
  for (const raw of opts.config.readOnlyPaths ?? []) {
    const canonical = canonicalize(raw);
    if (existsSync(canonical)) {
      bwrapArgs.push("--ro-bind", canonical, canonical);
    } else {
      debug(`[sandbox/bwrap] skipping non-existent readOnlyPaths entry: ${raw}`);
    }
  }

  // Step 6b: --bind each writable path (user-configured + project-injected),
  // canonicalized. Missing paths are skipped with a debug log (PR-014 M-2).
  // Port: src/sandbox.rs:524-537.
  const allWritables = [
    ...opts.config.writablePaths,
    ...opts.config.projectPaths,
  ];
  for (const raw of allWritables) {
    const canonical = canonicalize(raw);
    if (existsSync(canonical)) {
      bwrapArgs.push("--bind", canonical, canonical);
    } else {
      debug(`[sandbox/bwrap] skipping non-existent writable path: ${raw}`);
    }
  }

  // Step 7: --tmpfs dataDir (mask agent data even if overlapping workspace).
  // Port: src/sandbox.rs:541.
  bwrapArgs.push("--tmpfs", opts.dataDir);

  // Step 7a: D418 task 3.2.1 — mask each canonical protected path with an
  // empty tmpfs, AFTER every bind (system ro-binds, readOnlyPaths,
  // workspace, writable/projectPaths, dataDir) so bwrap's later-mount-wins
  // makes the deny override any granted root that overlaps it. A protected
  // subtree stays unreadable + unwritable even when a parent root is bound
  // (e.g. a readOnly home bind + a protected `~/.ssh` under it).
  //
  // A late --tmpfs safely masks DIRECTORY subtrees. Existing protected files
  // use a locally-created, zero-byte, read-only regular file overmounted with
  // --ro-bind. It is not /dev/null and carries no source data; the guarded
  // relay creates and validates it in its per-dispatch scratch directory
  // before this builder runs. If the trusted mask is absent or malformed,
  // refuse instead of falling back to a readable host file.
  for (const raw of opts.config.protectedPaths ?? []) {
    const canonical = canonicalize(raw);
    if (existsSync(canonical)) {
      let stat;
      try {
        stat = lstatSync(canonical);
      } catch {
        throw new Error(`[sandbox/bwrap] cannot inspect protected path: ${canonical}`);
      }
      if (!stat.isDirectory()) {
        const mask = opts.config.protectedFileMaskPath;
        if (opts.fileMaskSupported !== true) {
          throw new Error(
            `[sandbox/bwrap] guarded protected-file mask capability is unavailable: ${canonical}`,
          );
        }
        if (mask === undefined) {
          throw new Error(
            `[sandbox/bwrap] refusing protected non-directory path without a safe file mask: ${canonical}`,
          );
        }
        let maskStat;
        try {
          maskStat = lstatSync(mask);
        } catch {
          throw new Error(`[sandbox/bwrap] trusted protected file mask is unavailable: ${mask}`);
        }
        if (!maskStat.isFile() || maskStat.size !== 0) {
          throw new Error(`[sandbox/bwrap] trusted protected file mask must be a zero-byte regular file: ${mask}`);
        }
        bwrapArgs.push("--ro-bind", mask, canonical);
        continue;
      }
    }
    bwrapArgs.push("--tmpfs", canonical);
  }

  // Step 8: isolation flags.
  // Port: src/sandbox.rs:544-546.
  bwrapArgs.push("--unshare-pid");
  bwrapArgs.push("--new-session");
  bwrapArgs.push("--die-with-parent");

  // Step 8a: D103 Linux network isolation. bwrap has no proxy route yet,
  // so proxy-allowlist must fail closed instead of silently sharing host net.
  if (opts.config.networkPolicy?.mode !== undefined && opts.config.networkPolicy.mode !== "host") {
    bwrapArgs.push("--unshare-net");
  }

  // Step 9: --clearenv (default-deny).
  // Port: src/sandbox.rs:550.
  bwrapArgs.push("--clearenv");

  // Step 10: --chdir cwd.
  // Port: src/sandbox.rs:553.
  bwrapArgs.push("--chdir", opts.cwd);

  // Step 11: hardened env defaults.
  // PATH includes toolsBin prepended (Spacebot src/sandbox.rs:418-429).
  // Port: src/sandbox.rs:556-570.
  const parentPath = process.env["PATH"] ?? "";
  const path =
    parentPath.length > 0
      ? `${opts.toolsBin}${pathDelimiter}${parentPath}`
      : opts.toolsBin;
  bwrapArgs.push("--setenv", "PATH", path);
  bwrapArgs.push("--setenv", "HOME", opts.workspace);
  bwrapArgs.push("--setenv", "TMPDIR", "/tmp");
  bwrapArgs.push("--setenv", "CI", "true");
  bwrapArgs.push("--setenv", "DEBIAN_FRONTEND", "noninteractive");

  // Step 12: SAFE_ENV_VARS forwards from parent (if present).
  // Port: src/sandbox.rs:573-577.
  for (const name of SAFE_ENV_VARS) {
    const val = process.env[name];
    if (val !== undefined) {
      bwrapArgs.push("--setenv", name, val);
    }
  }

  // Step 13: passthroughEnv from user config (skip reserved).
  // Port: src/sandbox.rs:590-600.
  for (const name of opts.config.passthroughEnv) {
    if (isReservedEnvVar(name)) continue;
    const val = process.env[name];
    if (val !== undefined) {
      bwrapArgs.push("--setenv", name, val);
    }
  }

  // Step 14: per-command env (skip reserved, DROP dangerous w/ WARN).
  // Port: src/sandbox.rs:602-614.
  for (const [name, value] of Object.entries(opts.commandEnv)) {
    if (isReservedEnvVar(name)) continue;
    if (isDangerousEnvVar(name)) {
      warn(`[sandbox/bwrap] dropping dangerous per-command env var: ${name}`);
      continue;
    }
    bwrapArgs.push("--setenv", name, value);
  }

  // Step 15: `--` program args
  // Port: src/sandbox.rs:630-633.
  bwrapArgs.push("--", opts.program, ...opts.args);

  return {
    program: "bwrap",
    args: bwrapArgs,
    env: { PATH: parentPath },
    cwd: opts.cwd,
  };
}
