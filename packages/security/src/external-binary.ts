/**
 * External-binary heuristic for D061 Phase 4 (dead code until Phase 2 wiring).
 *
 * Detects commands whose first token is a path to a file that Nautilo did
 * not create or install — `./install.sh`, `../run`, `/tmp/x`, `~/bin/foo`.
 * These deserve a light `ask` gate even when command-scanner + path-deny
 * otherwise permit them, because the *content* of the script is opaque
 * to regex/AST analysis and "did the user vet this file" is an
 * attribution signal distinct from severity.
 *
 * This is a pure syntactic check — no filesystem access. A production
 * enhancement could verify the file exists + is executable, but doing so
 * at policy-resolution time couples the check to the guest's FS state
 * and is a race-prone operation. The shell does that verification at
 * exec time anyway; our goal here is "does this look like a path the
 * user might not have vetted?"
 *
 * --- Known limitations (document these so they surface in PR review) ---
 *
 * 1. Wrapper-shell invocations bypass the first-token check:
 *      bash ./install.sh
 *      source ./foo.sh
 *      env FOO=1 ./x.sh
 *    First token is `bash` / `source` / `env` — not a path. The command
 *    scanner catches `bash -c '<stuff>'` patterns; `bash ./foo.sh` without
 *    `-c` currently slips through both. Acceptable for Phase 4 scope —
 *    the design doc explicitly scopes this gate to "first token is a
 *    path". Document in the playbook as a Phase 6 enhancement candidate
 *    (tokenize + walk wrapper candidates until a non-wrapper leading
 *    token is found).
 *
 * 2. Env-var assignment prefixes look like paths:
 *      PATH=/tmp ./install.sh  → first token "PATH=/tmp" contains "/"
 *    The heuristic will flag this as external. False positive on the
 *    safe side (user sees a dialog for a real external-script run
 *    anyway — the env-var noise doesn't change the approval outcome).
 *
 * 3. Shell expansion happens before we see the string, but not always:
 *      $SCRIPT        → may or may not expand to a path at exec time
 *    If the agent emits `$SCRIPT` literally, first token has no `/` and
 *    we don't flag. Acceptable — the agent is unlikely to emit
 *    unexpanded `$SCRIPT` and even if it did, shell rules apply.
 *
 * Relative executable paths follow the first-token rules documented above.
 */

/**
 * Absolute-path prefixes that refer to system or package-manager-installed
 * binaries. Anything rooted here is treated as non-external because
 * installation already went through a trusted channel (Homebrew, system
 * package manager, official shell init scripts).
 *
 * We do NOT include `/Users/*` home dirs as system prefixes — a homedir
 * script is the exact case we want to flag. Version-manager shim paths
 * inside homedirs (asdf / nvm / volta) are intentionally not special-cased
 * because their bin dirs get put on PATH; bare invocations (`node foo.js`)
 * go through the PATH lookup branch and are trusted.
 */
const SYSTEM_PATH_PREFIXES = [
  "/usr/bin/",
  "/usr/local/bin/",
  "/usr/sbin/",
  "/usr/local/sbin/",
  "/bin/",
  "/sbin/",
  "/opt/homebrew/bin/",
  "/opt/homebrew/sbin/",
  "/home/linuxbrew/.linuxbrew/bin/",
  "/home/linuxbrew/.linuxbrew/sbin/",
];

/**
 * Returns true when the command's first token is an unvetted external
 * script/binary per the heuristic above.
 *
 * Examples that return true:
 *   ./install.sh
 *   ./build/run
 *   ../scripts/deploy
 *   /tmp/boho
 *   ~/Downloads/installer
 *
 * Examples that return false:
 *   git push
 *   npm install
 *   /usr/bin/git clone ...
 *   node server.js
 *   bun run dev
 */
export function isExternalUnknownBinary(command: string): boolean {
  // Normalize the same way command-scanner does, for defense-in-depth
  // against unicode/ANSI obfuscation. A caller passing pre-scanned
  // output pays this cost twice — acceptable (string ops, microseconds).
  const normalized = normalizeForDetection(command);
  const token = extractFirstToken(normalized);
  if (!token) return false;

  // Home-relative: always external. `~/bin/foo` is the user's homedir which
  // is exactly the "did you vet this file" case.
  if (token === "~" || token.startsWith("~/")) return true;

  // Bare names (no path separator) — PATH lookup, not a file path. The
  // external-binary gate is about script attribution, not custom PATH
  // binaries. Bare `mycustomtool` is user-installed and deliberate.
  if (!token.includes("/")) return false;

  // Absolute paths: trusted only under system prefixes.
  if (token.startsWith("/")) {
    return !SYSTEM_PATH_PREFIXES.some((p) => token.startsWith(p));
  }

  // Relative paths (./ ../  or implicit-relative like `scripts/run`) are
  // always external.
  return true;
}

/**
 * Extract the first whitespace-delimited token from the command, stripping
 * a leading opening quote character (shell quoting semantics — a full
 * tokenizer is overkill for the syntactic signal we need here).
 */
function extractFirstToken(command: string): string {
  if (!command) return "";
  const match = /^\s*(['"])?([^'"\s]+)/.exec(command);
  if (!match) return "";
  return match[2] ?? "";
}

// eslint-disable-next-line no-control-regex -- intentional: stripping ANSI escape sequences
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Matches command-scanner's `normalizeCommandForDetection` minus the
 * `.toLowerCase()` step — path-case matters on case-sensitive filesystems,
 * and "~/Bin/Foo" is still external regardless of case.
 *
 * Kept local rather than importing the command-scanner helper because
 * the lowercase difference matters and duplicating 4 lines is cheaper
 * than exporting two nearly-identical normalizers.
 */
function normalizeForDetection(command: string): string {
  return command
    .replace(ANSI_REGEX, "")
    .replaceAll("\0", "")
    .normalize("NFKC")
    .trim();
}
