/**
 * Runtime allowlist for `execute_artifact` — D073 + D060 Sprint 2.
 *
 * The tool accepts SCRIPT files (interpreted) only, never compiled
 * binaries. The map keys are file extensions; values are the
 * interpreter program + canonical args. Each entry represents a
 * deliberate decision to support a language. Add a new extension
 * only after:
 *   - Confirming the interpreter is present inside the sandbox\u0027s
 *     toolsBin PATH on Linux (bwrap) AND macOS (sandbox-exec).
 *   - Confirming the interpreter respects `--` / `--script` or
 *     equivalent to stop argv-parsing before the user args (prevents
 *     flag-injection via `args`).
 *
 * `program` is an ABSOLUTE path. The sandbox\u0027s toolsBin bind-mount
 * exposes /usr/bin + /opt/homebrew/bin + ~/.bun/bin; we use
 * absolute paths because the sandbox wipes PATH by default and
 * `spawnSandboxed` doesn\u0027t consult the parent\u0027s PATH.
 */

export interface RuntimeSpec {
  /** Absolute path to the interpreter. */
  readonly program: string;
  /**
   * Baseline args the interpreter takes BEFORE the script path.
   * For most interpreters empty; for `bun run` it\u0027s `["run"]`.
   */
  readonly preScriptArgs: readonly string[];
  /**
   * Argv separator the interpreter honors. After this marker, no
   * further flags are parsed — user args land as positional params.
   * Falls back to empty (no separator) for interpreters that don\u0027t
   * support one; in that case user args are appended verbatim.
   */
  readonly argvSeparator: readonly string[];
}

/**
 * Extension → RuntimeSpec. Keys are lowercase + leading-dot-free
 * (e.g. `"py"`, not `".py"`). The handler normalizes the extension
 * with `path.extname().slice(1).toLowerCase()` before lookup.
 */
export const RUNTIME_ALLOWLIST: Readonly<Record<string, RuntimeSpec>> = {
  py: {
    program: "/usr/bin/env",
    // `env python3` so we pick up whatever python3 the sandbox PATH
    // resolves; absolute `/usr/bin/python3` is macOS-system-only and
    // breaks on Linux distros that ship Python under /usr/local.
    preScriptArgs: ["python3"],
    argvSeparator: ["--"],
  },
  ts: {
    program: "/usr/bin/env",
    preScriptArgs: ["bun", "run"],
    argvSeparator: ["--"],
  },
  js: {
    program: "/usr/bin/env",
    preScriptArgs: ["node"],
    argvSeparator: ["--"],
  },
  mjs: {
    program: "/usr/bin/env",
    preScriptArgs: ["node"],
    argvSeparator: ["--"],
  },
  sh: {
    program: "/bin/sh",
    preScriptArgs: [],
    // `sh` doesn\u0027t have a strict argv separator; pre-script args
    // stop at the first non-option, which IS the script path.
    argvSeparator: [],
  },
  bash: {
    program: "/bin/bash",
    preScriptArgs: [],
    argvSeparator: [],
  },
  rb: {
    program: "/usr/bin/env",
    preScriptArgs: ["ruby"],
    argvSeparator: ["--"],
  },
  r: {
    program: "/usr/bin/env",
    preScriptArgs: ["Rscript"],
    // Rscript takes --args to delimit user args from interpreter args.
    argvSeparator: ["--args"],
  },
};

/**
 * Resolve a file path to a runtime spec, or null if the extension is
 * not on the allowlist. Case-insensitive on the extension.
 */
export function detectRuntime(filePath: string): RuntimeSpec | null {
  // path.extname returns ".py" / "" — strip the leading dot + lower.
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1 || dotIdx === filePath.length - 1) return null;
  const ext = filePath.slice(dotIdx + 1).toLowerCase();
  return RUNTIME_ALLOWLIST[ext] ?? null;
}

/**
 * Human-readable list of supported extensions for error messages.
 * Stable-sorted so the message doesn\u0027t flap between runs.
 */
export function listSupportedExtensions(): string {
  return Object.keys(RUNTIME_ALLOWLIST).sort().map((e) => `.${e}`).join(", ");
}
