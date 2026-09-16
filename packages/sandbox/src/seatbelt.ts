/**
 * macOS Seatbelt (`sandbox-exec`) arg builder for `@nautilo/sandbox`.
 * D060 Phase 2 task 2.2.
 *
 * Port: Spacebot `src/sandbox.rs:640-830` (`wrap_sandbox_exec`) for
 * the env handling + spawn shape. Gemini CLI's `seatbeltArgsBuilder.ts`
 * informs the SBPL profile shape (see `seatbelt-profile.ts`).
 *
 * Why this is structurally different from bubblewrap:
 *
 *   - bubblewrap takes env values as CLI flags (`--setenv NAME VAL`)
 *     interleaved with mount flags, while the bwrap process itself
 *     runs with a minimal spawn env.
 *   - `sandbox-exec` has NO env manipulation. It just runs the given
 *     program with a sandbox profile applied. Env handling happens at
 *     the `spawn()` level — we return an explicit `env` map to
 *     `child_process.spawn()` / `Bun.spawn()` that IS the child's
 *     env. No re-injection via the sandbox layer.
 *
 * So this file's job is:
 *   1. Build the SBPL profile (delegate to `seatbelt-profile.ts`).
 *   2. Return `{ program: "/usr/bin/sandbox-exec", args: ["-p", profile,
 *      <originalProgram>, ...originalArgs], env: <constructed-map>, cwd }`.
 *   3. Enforce the same env taxonomy as bubblewrap — SAFE forwarded,
 *      reserved dropped silently, dangerous DROPPED with WARN, command
 *      env layered last with the same rules.
 *
 * A reviewer should be able to diff the env-handling block below
 * against bubblewrap.ts Steps 11-14 and see the same semantics
 * expressed differently: bwrap emits `--setenv` flags; here we mutate
 * a local `env` object.
 */

import { existsSync, realpathSync } from "node:fs";
import { delimiter as pathDelimiter, dirname, join } from "node:path";

import { warn } from "@nautilo/logger";

import {
  SAFE_ENV_VARS,
  isDangerousEnvVar,
  isReservedEnvVar,
} from "./env-vars";
import { buildSbplProfile } from "./seatbelt-profile";
import type { SandboxConfig, SpawnArgs } from "./types";

export interface SandboxExecBuildOptions {
  readonly workspace: string;
  readonly dataDir: string;
  readonly toolsBin: string;
  readonly config: SandboxConfig;
  readonly cwd: string;
  /** Per-invocation env from the tool caller — RESERVED skipped, DANGEROUS dropped w/ WARN. */
  readonly commandEnv: Readonly<Record<string, string>>;
  readonly program: string;
  readonly args: readonly string[];
  /** Trusted local Developer Workstation profile; never sourced from wire config. */
  readonly allowWorkspaceGovernanceWrites?: boolean;
  /**
   * Whether to allow outbound + inbound network. Defaults to true
   * for Phase 2 (parity with bubblewrap — no network containment).
   *
   * Phase 3 (network allowlist via local proxy) is the consumer
   * that flips this per-invocation. Until then, `Sandbox.wrap()`
   * does NOT thread this option through — the default `true` is
   * the only path exercised by the relay today, which is why
   * there's no wire-up yet. If you're reading this after Phase 3
   * lands and the option is STILL unreachable from the dispatch
   * path, something slipped during Phase 3's integration; add an
   * explicit test that exercises `networkAccess: false` through
   * `Sandbox.wrap()`.
   */
  readonly networkAccess?: boolean;
  /** Local Nautilo proxy URL when D103 proxy-allowlist is active. */
  readonly networkProxyUrl?: string;
  /** Local Nautilo proxy port when D103 proxy-allowlist is active. */
  readonly networkProxyPort?: number;
  /**
   * D418 A2 — optional override for the narrow macOS xcrun cache
   * exception dir. Production leaves this undefined so
   * `buildSbplProfile` defaults to `os.tmpdir()` on Darwin; tests
   * supply a controlled dir for deterministic cross-platform asserts.
   */
  readonly xcrunCacheDir?: string;
}

function resolvedToolBinDir(toolsBin: string, executable: string): string | null {
  const toolPath = join(toolsBin, executable);
  if (!existsSync(toolPath)) return null;

  try {
    const real = realpathSync(toolPath);
    const realDir = dirname(real);
    return realDir === toolsBin ? null : realDir;
  } catch {
    return null;
  }
}

/**
 * Build the `sandbox-exec` spawn command. Returns a `SpawnArgs` with
 * an explicit `env` map — unlike bubblewrap which uses `--setenv`
 * and relies on in-sandbox `--setenv` re-injection, sandbox-exec
 * has no env flags and the spawn's env IS the child's env.
 */
export function buildSandboxExec(opts: SandboxExecBuildOptions): SpawnArgs {
  // --- Step 1: build the SBPL profile.
  //
  // Delegates to `seatbelt-profile.ts` so the profile generation is
  // unit-testable without pulling in `child_process` or env state.
  const profile = buildSbplProfile({
    workspace: opts.workspace,
    dataDir: opts.dataDir,
    toolsBin: opts.toolsBin,
    config: opts.config,
    ...(opts.allowWorkspaceGovernanceWrites === true
      ? { allowWorkspaceGovernanceWrites: true }
      : {}),
    ...(opts.networkAccess !== undefined
      ? { networkAccess: opts.networkAccess }
      : {}),
    ...(opts.networkProxyPort !== undefined
      ? { networkProxyPort: opts.networkProxyPort }
      : {}),
    ...(opts.xcrunCacheDir !== undefined
      ? { xcrunCacheDir: opts.xcrunCacheDir }
      : {}),
  });

  // --- Step 2: build the env map. Mirrors bubblewrap steps 11-14.
  //
  // env-clear-and-rebuild: start with `{}` and only add what we
  // explicitly approve. Unlike the bwrap path, we NEVER let parent
  // env leak — spawn will pass exactly this object.
  const env: Record<string, string> = {};

  // Hardened defaults (match bubblewrap.ts Step 11 Spacebot
  // src/sandbox.rs:556-570).
  const parentPath = process.env["PATH"] ?? "";
  const pathSegments = [opts.toolsBin];
  const resolvedPythonBin = resolvedToolBinDir(opts.toolsBin, "python3");
  if (resolvedPythonBin !== null) {
    pathSegments.unshift(resolvedPythonBin);
  }
  if (parentPath.length > 0) {
    pathSegments.push(parentPath);
  }
  const pathVal = pathSegments.join(pathDelimiter);
  env["PATH"] = pathVal;
  // HOME = workspace matches bwrap — keeps tools that read HOME
  // (npm, python's `~/.cache`, etc.) constrained to the same
  // writable scope the sandbox allows.
  //
  // Side effect noted in PR-014 N-2 (same for bubblewrap): any
  // interactive shell or history-keeping tool (bash → .bash_history,
  // vim → .viminfo, python → .python_history, etc.) will scribble
  // those dotfiles into the workspace directory rather than the
  // real HOME. Matches Spacebot's port semantic and is the lesser
  // evil vs leaking HOME-relative reads into the agent's actual
  // home directory. Documented in `packages/sandbox/README.md`.
  env["HOME"] = opts.workspace;
  env["TMPDIR"] = "/tmp";
  env["CI"] = "true";
  env["DEBIAN_FRONTEND"] = "noninteractive";
  if (opts.networkProxyUrl !== undefined) {
    env["HTTP_PROXY"] = opts.networkProxyUrl;
    env["HTTPS_PROXY"] = opts.networkProxyUrl;
    env["NO_PROXY"] = "localhost,127.0.0.1,::1";
  }

  // SAFE_ENV_VARS forwards (match bwrap Step 12). Forward IFF
  // present in the parent — absent vars stay absent rather than
  // being set to empty string (which could confuse locale-sensitive
  // tools).
  for (const name of SAFE_ENV_VARS) {
    const val = process.env[name];
    if (val !== undefined) {
      env[name] = val;
    }
  }

  // passthroughEnv from user config — skip reserved (matches bwrap
  // Step 13 Spacebot src/sandbox.rs:590-600).
  for (const name of opts.config.passthroughEnv) {
    if (isReservedEnvVar(name)) continue;
    const val = process.env[name];
    if (val !== undefined) {
      env[name] = val;
    }
  }

  // per-command env (matches bwrap Step 14 Spacebot src/sandbox.rs:602-614):
  //   - reserved → silently skip (the hardened defaults above win
  //     over per-call overrides for PATH/HOME/TMPDIR/CI/DEBIAN_FRONTEND).
  //   - dangerous (DYLD_INSERT_LIBRARIES, LD_PRELOAD, PYTHONPATH, ...)
  //     → DROP with WARN. Passing these to a sandboxed child would
  //     let the LLM-emitted command hijack the process regardless of
  //     the filesystem containment the SBPL profile provides.
  //   - otherwise → include.
  for (const [name, value] of Object.entries(opts.commandEnv)) {
    if (isReservedEnvVar(name)) continue;
    if (isDangerousEnvVar(name)) {
      warn(
        `[sandbox/seatbelt] dropping dangerous per-command env var: ${name}`,
      );
      continue;
    }
    env[name] = value;
  }

  // --- Step 3: return SpawnArgs.
  //
  // `/usr/bin/sandbox-exec -p <profile> <program> <args...>`
  //
  // The `-p` flag takes the profile as a STRING argument rather
  // than reading from a file. This avoids an intermediate temp file
  // and keeps the sandbox invocation self-contained — a profile
  // typo manifests as a sandbox-exec error with a reasonable
  // line/column pointer, not a "failed to read profile file".
  return {
    program: "/usr/bin/sandbox-exec",
    args: ["-p", profile, opts.program, ...opts.args],
    env,
    cwd: opts.cwd,
  };
}
