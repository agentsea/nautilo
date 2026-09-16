/**
 * Env var taxonomy for `@nautilo/sandbox`. D060 Phase 1 task 1.2.
 *
 * Three lists, each with a specific role in subprocess env plumbing:
 *
 *   SAFE        — forwarded from parent when present. Minimal set
 *                 needed for any process to run (USER, LANG, TERM).
 *   RESERVED    — set by the hardened sandbox defaults (PATH, HOME,
 *                 TMPDIR, CI, DEBIAN_FRONTEND, proxy vars). Names in this list
 *                 CANNOT be overridden via `passthroughEnv` or
 *                 per-command `env` — the taxonomy owns them.
 *   DANGEROUS   — library-injection / runtime-loader vectors (e.g.
 *                 LD_PRELOAD, DYLD_INSERT_LIBRARIES). Silently
 *                 dropped from per-command env even if the caller
 *                 explicitly set them. Defense-in-depth against a
 *                 command scanner that missed a `env LD_PRELOAD=…`
 *                 prefix.
 *
 * Port: Spacebot `src/sandbox.rs:80-106`. The constant names and
 * case-insensitivity of the DANGEROUS check are load-bearing — the
 * research doc §Q3 cites Spacebot's lists verbatim as the canonical
 * set we adopt.
 *
 * Heuristic H-NNN (proposed in research doc): any PR that forwards a
 * DANGEROUS var through the sandbox layer without explicit
 * justification fails review.
 */

/**
 * Always forwarded from parent into sandbox when present. These are
 * required for subprocess basics (shell prompts, locale, TTY type).
 * The set is deliberately tiny — anything more specific should go
 * through `passthroughEnv`.
 *
 * Port: Spacebot `src/sandbox.rs:80` (`SAFE_ENV_VARS`).
 */
export const SAFE_ENV_VARS = ["USER", "LANG", "TERM"] as const satisfies readonly string[];

/**
 * Set by the hardened sandbox defaults. `passthroughEnv` entries + per-
 * command env entries matching these names are silently skipped — the
 * taxonomy has the final say.
 *
 * Why each one is reserved (copied verbatim from Spacebot lines 82-87):
 *   PATH              — dropping `tools/bin` precedence breaks layer-
 *                       provided commands (bun, etc.)
 *   HOME              — sandbox-local path is deterministic; user HOME
 *                       leaks pointer to real filesystem
 *   TMPDIR            — private /tmp is part of the isolation model
 *   CI                — suppresses npm/yarn interactive prompts; stdin
 *                       is unavailable under subprocess exec
 *   DEBIAN_FRONTEND   — same for apt-get
 *   HTTP(S)_PROXY     — D103 network policy owns these when a local
 *                       egress proxy is active. User-supplied values
 *                       must not bypass or replace the policy proxy.
 *   NO_PROXY          — same; sandbox sets the loopback bypass shape.
 *
 * Port: Spacebot `src/sandbox.rs:88`.
 */
export const RESERVED_ENV_VARS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "CI",
  "DEBIAN_FRONTEND",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const satisfies readonly string[];

/**
 * Library-injection / runtime-loader vectors. Silently dropped from
 * per-command env even if the caller explicitly set them. This is
 * defense-in-depth: even if D053's command scanner missed a
 * `env LD_PRELOAD=evil.so cmd` prefix, the sandbox layer catches it.
 *
 * The case-insensitive match matters — shells on macOS sometimes
 * normalize to uppercase, and POSIX says env vars are case-sensitive
 * but lots of tooling doesn't care. Matching case-insensitively
 * maximizes the block surface without false negatives.
 *
 * Port: Spacebot `src/sandbox.rs:93-106` (`DANGEROUS_ENV_VARS`) +
 * line 117-121 (`is_dangerous_env_var`'s `eq_ignore_ascii_case`).
 */
export const DANGEROUS_ENV_VARS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "NODE_OPTIONS",
  "RUBYOPT",
  "PERL5OPT",
  "PERL5LIB",
  "BASH_ENV",
  "ENV",
] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// Classifiers
// ---------------------------------------------------------------------------

/**
 * True if `name` is reserved OR safe — either way the taxonomy owns
 * it and user-supplied values with this name must be skipped. This
 * is the single check callers use; RESERVED and SAFE are separate
 * lists for documentation reasons but collapse into one predicate
 * at runtime.
 *
 * Port: Spacebot `src/sandbox.rs:111-113` (`is_reserved_env_var`).
 */
export function isReservedEnvVar(name: string): boolean {
  return (
    (RESERVED_ENV_VARS as readonly string[]).includes(name) ||
    (SAFE_ENV_VARS as readonly string[]).includes(name)
  );
}

/**
 * True if `name` matches a DANGEROUS env var (case-insensitive).
 *
 * Port: Spacebot `src/sandbox.rs:117-121` (`is_dangerous_env_var`).
 */
export function isDangerousEnvVar(name: string): boolean {
  const upper = name.toUpperCase();
  for (const dangerous of DANGEROUS_ENV_VARS) {
    if (dangerous.toUpperCase() === upper) return true;
  }
  return false;
}
