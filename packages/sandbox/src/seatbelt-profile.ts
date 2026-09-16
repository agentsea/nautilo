/**
 * SBPL (Sandbox Profile Language) generator for macOS `sandbox-exec`.
 * D060 Phase 2 task 2.1.
 *
 * Hybrid implementation, preserving upstream provenance below:
 *   - **Scaffold + env + worktree auto-detect** from Gemini CLI
 *     (`EXTERNAL/gemini-cli/packages/core/src/sandbox/macos/seatbeltArgsBuilder.ts`
 *     lines 50-212 for the builder; `baseProfile.ts` for the
 *     `(import "system.sb")` base + PTY + sysctl + mach-lookup + IOKit
 *     rules that standard tools need to avoid "Abort trap: 6").
 *   - **Workspace + writable + env semantics + dangerous-env drop**
 *     from Spacebot (`EXTERNAL/spacebot/src/sandbox.rs:640-830`, the
 *     `wrap_sandbox_exec` Rust implementation). Spacebot's scaffold is
 *     too coarse on its own; Gemini CLI's surgical governance + secret
 *     regex denies fill in the gap that D053's command scanner can't.
 *
 * Rule ordering matters: Seatbelt evaluates rules top-to-bottom and
 * the LAST matching rule for a given path wins. That means deny rules
 * for `.git` / `.env` MUST come AFTER the workspace file-write allow,
 * not before, or the allow overrides them. Each function below is
 * ordered to enforce this; a reviewer should see the sequence:
 *
 *   1. Base (`(version 1) (deny default) (import "system.sb")` + Apple's
 *      system sb + standard execution + sysctl + mach + IOKit + PTY +
 *      base file-read for /System, /usr/bin, /bin, /sbin, /opt/homebrew
 *      etc. + file-read+write for /tmp + `/dev/null`).
 *   2. Workspace file-read+write (original AND realpath form — `/var` →
 *      `/private/var` canonicalization matters on macOS).
 *   3a. readOnlyPaths (D060 Sprint 1 G5.1) — file-read* only, no
 *       file-write* allow. Emitted BEFORE writablePaths so later-wins
 *       gives writable overlays their file-write* grant.
 *   3b. Additional writable paths (each original + realpath).
 *   4. Tools-bin file-read (prepended on PATH at spawn time).
 *   5. Governance file denies (`.git`, `.gitignore`, `.claudeignore`)
 *      AFTER the workspace allow so they override.
 *      A locally revalidated Developer Workstation Current Folder may opt out
 *      through runtime-only authority so full existing-repository Git remains
 *      available while ordinary sandboxes retain these denies.
 *   6. Secret file regex denies (`.env`, `.env.*`) — anchored to
 *      workspace + allowedPaths so we don't over-block `$HOME/.env`.
 *   6a. D574 — public template read/write carve-out
 *       (terminal suffixes `.example`, `.sample`, `.template`,
 *       `.dist` at any depth, e.g. `.env.local-smoke.example`)
 *       emitted AFTER the secret deny so later-wins re-opens ordinary
 *       workspace reads and writes. Live secret variants remain denied.
 *   6b. D418 A2 — narrow macOS xcrun cache exception: allow ONLY
 *       `<user-tmpdir>/xcrun_db*` so `git`/`clang` Xcode shims can
 *       update their cache without broadening `/private/var/folders`.
 *   7. Git worktree detection — if workspace is a worktree (the `.git`
 *      is a file, not a dir, containing `gitdir: <path>`), allow both
 *      `worktreeGitDir` AND the main repo's `.git`. Without this, git
 *      commands in a worktree silently fail.
 *   8. dataDir deny-all (masks the agent's secret store even when it
 *      overlaps the workspace — mirrors Phase 1's bubblewrap `--tmpfs
 *      dataDir` step 7).
 *   9. D418 task 3.2.1 — canonical protected-path deny-overrides,
 *      emitted AFTER every allow so a protected subtree stays
 *      unreadable + unwritable even when a granted root overlaps it.
 *   10. network policy — host allows all, isolated denies all, and
 *      proxy-allowlist allows only the local proxy port.
 *
 * Everything else (read-only system paths, ptmx, devfs, etc.) is
 * inherited from `(import "system.sb")` + the base sections below.
 * Emitting redundant rules is harmless; omitting required rules
 * breaks basic tools with obscure "Abort trap: 6" errors that look
 * like crashes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { canonicalize, tryRealpath } from "./paths";
import type { SandboxConfig } from "./types";

/**
 * Base profile — `(version 1) (deny default)` + Apple's `system.sb`
 * import + all the sysctl / mach-lookup / IOKit / PTY / file-read
 * rules that standard Unix tools need to avoid "Abort trap: 6"
 * crashes. Ported verbatim from Gemini CLI's `baseProfile.ts` with
 * one deliberate change: removed the network block (we emit
 * `(allow network*)` explicitly downstream so network can be
 * toggled per-invocation rather than hardcoded into the scaffold).
 */
export const BASE_SEATBELT_PROFILE = `(version 1)
(deny default)

(import "system.sb")

; Core execution requirements.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info*)

; Map system frameworks + dylibs for the dynamic loader.
(allow file-map-executable
  (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks")
  (subpath "/usr/lib")
  (subpath "/bin")
  (subpath "/usr/bin")
  ; Homebrew/Python.org-hosted interpreters (python3/node/etc.) dlopen extension
  ; modules and dylibs from these trees. Read permission alone is not enough
  ; under Seatbelt; without file-map-executable they can be SIGKILL'd with no
  ; stderr, or fail while resolving /usr/local/bin symlinks.
  (subpath "/opt/homebrew")
  (subpath "/usr/local")
  (subpath "/Library/Frameworks")
)

; /dev/null writes bypass the generic file-write rules.
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))

; sysctls that most toolchains read at startup.
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable.")
)

(allow sysctl-write
  (sysctl-name "kern.grade_cputype"))

; Mach services standard tools contact.
(allow mach-lookup
  (global-name "com.apple.sysmond")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.logd")
  (global-name "com.apple.secinitd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.trustd")
  (global-name "com.apple.analyticsd")
  (global-name "com.apple.analyticsd.messagetracer")
  (global-name "com.apple.PowerManagement.control")
)

; IOKit registry lookups some frameworks do at init.
(allow iokit-open
  (iokit-registry-entry-class "RootDomainUserClient")
)

; Python multiprocessing needs POSIX semaphores.
(allow ipc-posix-sem)

; PTY + terminal support (interactive shells, test runners).
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))

; Base read-only system paths. The MACOS_READ_ONLY_SYSTEM_PATHS
; constant in system-paths.ts enumerates this list; keeping the
; rules inline so a single (import "system.sb") + this scaffold is
; enough to boot standard tools.
(allow file-read*
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (subpath "/usr/bin")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/usr/local/bin")
  (subpath "/opt/homebrew")
  (subpath "/Library")
  (subpath "/private/var/run")
  (subpath "/private/var/db")
  (subpath "/private/etc")
)

; Read/write access to temp + common device nodes.
(allow file-read* file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/tty")
  (subpath "/dev/fd")
  (subpath "/tmp")
  (subpath "/private/tmp")
)

; Metadata-only access to root + /var — listing these is fine, but
; reading their contents requires explicit allow rules below.
(allow file-read-metadata
  (literal "/")
  (literal "/usr")
  (literal "/usr/bin")
  (literal "/usr/local")
  (literal "/usr/local/bin")
  (literal "/opt")
  (literal "/opt/homebrew")
  (literal "/opt/homebrew/bin")
  (literal "/Library")
  (literal "/Library/Developer")
  (subpath "/var")
  (subpath "/private/var")
  (subpath "/dev")
)

`;

/**
 * Files that count as "governance" and should be unwritable even
 * inside a writable workspace. The `write` denies land AFTER the
 * workspace allow rule; evaluation is later-wins.
 *
 * `isDirectory` default is used when the path doesn't exist on disk
 * at profile-build time (e.g. fresh worktree scaffolding where `.git`
 * hasn't been created yet). When the path exists we `lstat` and use
 * the real type.
 *
 * Port: Gemini CLI `services/sandboxManager.ts::GOVERNANCE_FILES`.
 */
export const GOVERNANCE_FILES = [
  { path: ".git", isDirectory: true },
  { path: ".gitignore", isDirectory: false },
  { path: ".claudeignore", isDirectory: false },
] as const satisfies readonly { path: string; isDirectory: boolean }[];

/**
 * Filename-pattern denies emitted as SBPL regex rules. Anchored to
 * each workspace / writable-path base to avoid blocking
 * `$HOME/.env.production` when the agent is iterating in
 * `/Users/me/proj/`.
 *
 * `*` suffix means "match the pattern + any extension", e.g. `.env*`
 * matches `.env`, `.env.local`, `.env.production`. No suffix = exact
 * filename match.
 *
 * Port: Gemini CLI `services/sandboxManager.ts::SECRET_FILES`.
 */
export const SECRET_FILES = [
  { pattern: ".env*" },
  { pattern: ".secret" },
  { pattern: ".secrets" },
  { pattern: "credentials" },
  { pattern: "credentials.json" },
] as const satisfies readonly { pattern: string }[];

/**
 * Recognized public template terminal suffixes. Files whose basename ends
 * with one of these (e.g. `.env.example`, `.env.local-smoke.example`,
 * `config/app.sample`) are carved out as public workspace files after the `.env*`
 * secret deny. D418 A2 follow-up: exact-filename matching missed
 * compound stems like `.env.local-smoke.example` that still carry live
 * secrets only in the non-suffixed variants.
 *
 * Live secret variants (`.env`, `.env.local`, `.env.production`, ...)
 * do NOT end with a terminal suffix, so the `.env*` secret deny still
 * blocks them. Non-terminal shapes like `.env.example.local` also stay
 * blocked — the suffix must be terminal on the basename.
 *
 * Never a broad `.env*` exemption and never general temp storage; only
 * these four suffixes at the end of a path component under a secret base.
 * Their read/write authority still comes from the enclosing workspace or
 * explicit writable root; this rule only undoes the broader secret-name deny.
 */
export const PUBLIC_TEMPLATE_TERMINAL_SUFFIXES = [
  "example",
  "sample",
  "template",
  "dist",
] as const satisfies readonly string[];

/** SBPL regex alternation for {@link PUBLIC_TEMPLATE_TERMINAL_SUFFIXES}. */
function publicTemplateSuffixAlternation(): string {
  return PUBLIC_TEMPLATE_TERMINAL_SUFFIXES.join("|");
}

/**
 * Escape a path for use inside an SBPL string literal `"..."`.
 * Scheme requires escaping `\` and `"`. Path characters that might
 * be special in other contexts (`$`, `.`, etc.) are literals inside
 * a string, so we only escape the two that would break the literal.
 *
 * Port: Gemini CLI `seatbeltArgsBuilder.ts:escapeSchemeString`.
 */
export function escapeSchemeString(str: string): string {
  return str.replace(/[\\"]/g, "\\$&");
}

/**
 * Escape a path for use inside an SBPL regex literal `#"..."`.
 *
 * Empirical behavior of sandbox-exec's `-p` mode on macOS Sonoma
 * (14.8.4, Darwin 23.6, host `tart` 2.32.1): the Scheme-like
 * reader embedded in sandbox-exec does NOT standard-unescape `\\`
 * to `\`. A literal `\\` in the profile text reaches the regex
 * engine as two literal backslashes, which (in the engine's
 * flavor) means "literal `\` character in the target string" —
 * never matches real paths. So the Gemini CLI pattern of
 * `str.replace(/\./g, '\\\\.')` (four-backslash source → two
 * runtime backslashes → regex `\\`) produces rules that are
 * silently INERT.
 *
 * The escapes that DO work under `-p` mode:
 *
 * - Regex metachar `X` (including `.`) → emit `\X` in the profile
 *   (ONE backslash + metachar). JS source `"\\" + c` → JS string
 *   `\<c>` (2 chars) → profile bytes `\<c>` → regex sees `\<c>`,
 *   which the engine interprets as "literal <c>".
 *
 * - Literal backslash `\` → emit `\\` in the profile (TWO
 *   backslashes). JS source `"\\\\"` → JS string `\\` → profile
 *   bytes `\\` → regex sees `\\`, meaning "literal backslash".
 *   In practice paths rarely contain `\`, but we cover it for
 *   completeness + cross-platform symmetry with Phase 1.
 *
 * - Double quote `"` → emit `\"` for the Scheme string literal
 *   close-quote escape. Doesn't reach the regex engine — just
 *   keeps the `#"..."` syntax valid.
 *
 * A regression test in seatbelt-profile.test.ts runs the emitted
 * profile under real `/usr/bin/sandbox-exec` with `.env` +
 * `.env.local` files planted in a tmp workspace, asserting
 * BOTH are blocked. This is the only way to guard against a
 * future Apple update changing the reader semantics silently.
 */
export function escapeRegexForSchemeLiteral(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\"]/g, (c) => {
    if (c === '"') {
      // Scheme string literal close-quote escape.
      return '\\"';
    }
    if (c === "\\") {
      // Profile bytes `\\` → regex sees literal backslash.
      return "\\\\";
    }
    // Profile bytes `\<c>` → regex sees literal <c> (escaped metachar).
    return "\\" + c;
  });
}

function ancestorPathsForMetadata(raw: string): string[] {
  const resolved = resolve(raw);
  const out: string[] = [];
  let current = resolved;
  while (current !== dirname(current)) {
    out.push(current);
    current = dirname(current);
  }
  return out.reverse();
}

function appendMetadataAllows(profile: string, raw: string): string {
  let next = profile;
  for (const p of ancestorPathsForMetadata(raw)) {
    next += `(allow file-read-metadata (literal "${escapeSchemeString(p)}"))\n`;
  }
  return next;
}

export interface SbplProfileOptions {
  readonly workspace: string;
  readonly dataDir: string;
  readonly toolsBin: string;
  readonly config: SandboxConfig;
  /** Whether to emit `(allow network*)`. Phase 2 defaults true; Phase 3 will swap in allowlists. */
  readonly networkAccess?: boolean;
  /** Local proxy port for D103 proxy-allowlist enforcement. */
  readonly networkProxyPort?: number;
  /**
   * D418 A2 — the current user's macOS temp dir to narrow-scope the
   * xcrun cache exception to (`<dir>/xcrun_db*` only). Defaults to
   * `os.tmpdir()` on Darwin (the per-UID `confstr(_CS_DARWIN_USER_TEMP_DIR)`
   * dir xcrun actually writes to — NOT `$TMPDIR`, which the sandbox
   * already redirects to `/private/tmp`). Omitted off-Darwin unless a
   * caller (tests) supplies one. Never broadens to all of
   * `/private/var/folders` or sibling temp files.
   */
  readonly xcrunCacheDir?: string;
  /**
   * Locally revalidated Developer Workstation profile trust for the selected
   * repository. Deliberately outside `SandboxConfig`, so an untrusted wire
   * envelope cannot suppress governance denies.
   */
  readonly allowWorkspaceGovernanceWrites?: boolean;
}

/**
 * Build a complete SBPL profile string. Deterministic for a given
 * input (no time-dependence, no caching) — unit tests snapshot this.
 *
 * Separated from `seatbelt.ts::buildSandboxExec` so the SBPL
 * generation is testable in isolation (no `child_process`, no env
 * handling).
 */
export function buildSbplProfile(opts: SbplProfileOptions): string {
  const networkPolicy = opts.config.networkPolicy;
  const networkAccess =
    opts.networkAccess !== false &&
    (networkPolicy === undefined || networkPolicy.mode === "host");

  let profile = BASE_SEATBELT_PROFILE;

  // --- Workspace file-read + file-write (both original AND realpath)
  //
  // On macOS, most user paths under `/var/...` canonicalize to
  // `/private/var/...` because `/var` is a symlink. SBPL rule
  // evaluation is path-literal — a rule on the original form does
  // NOT apply to the canonical form and vice-versa. Emitting both
  // is the only way to avoid a silent gap where the agent writes
  // via one path and a different rule fires on the other.
  // See packages/sandbox/src/paths.ts for the quirk's full docstring.
  // Use `canonicalize` (always returns a string, falls back to input)
  // rather than `tryRealpath` (returns null on failure) so a
  // workspace that hasn't been created yet still gets its raw form
  // in the profile — existence-checking happens at mount time on
  // Linux via bwrap, and on macOS Seatbelt silently ignores rules
  // against missing subpaths, so emitting both forms is always safe.
  const workspaceReal = canonicalize(opts.workspace);
  profile = appendMetadataAllows(profile, opts.workspace);
  if (workspaceReal !== opts.workspace) {
    profile = appendMetadataAllows(profile, workspaceReal);
  }
  profile += `(allow file-read* (subpath "${escapeSchemeString(opts.workspace)}"))\n`;
  profile += `(allow file-write* (subpath "${escapeSchemeString(opts.workspace)}"))\n`;
  if (workspaceReal !== opts.workspace) {
    profile += `(allow file-read* (subpath "${escapeSchemeString(workspaceReal)}"))\n`;
    profile += `(allow file-write* (subpath "${escapeSchemeString(workspaceReal)}"))\n`;
  }

  // --- Tools-bin read access (also prepended on PATH in seatbelt.ts).
  if (existsSync(opts.toolsBin)) {
    const toolsReal = canonicalize(opts.toolsBin);
    profile += `(allow file-read* (subpath "${escapeSchemeString(opts.toolsBin)}"))\n`;
    if (toolsReal !== opts.toolsBin) {
      profile += `(allow file-read* (subpath "${escapeSchemeString(toolsReal)}"))\n`;
    }
  }

  // --- Read-only paths (D060 Sprint 1 G5.1).
  //
  // Broad-read / narrow-write shape for deployment profiles like
  // `desktop-permissive`: emit `(allow file-read* (subpath …))` only —
  // NO corresponding file-write allow. Both raw + canonical forms
  // emitted for the /var → /private/var quirk. Deny rules below
  // (governance, secret regex, dataDir) still fire after these
  // allows — Seatbelt is later-wins, so readOnlyPaths providing a
  // broad read surface does NOT re-allow what later denies block.
  for (const raw of opts.config.readOnlyPaths ?? []) {
    if (!existsSync(raw)) continue;
    const real = canonicalize(raw);
    profile += `(allow file-read* (subpath "${escapeSchemeString(raw)}"))\n`;
    if (real !== raw) {
      profile += `(allow file-read* (subpath "${escapeSchemeString(real)}"))\n`;
    }
  }

  // --- Additional writable paths from config.
  //
  // `writablePaths` is user-configured; `projectPaths` is
  // auto-injected by D057's workspace switcher (re-populated on
  // workspace change via Sandbox.refreshProjectPaths). Emitted
  // AFTER readOnlyPaths so a writable path overlapping a read-only
  // parent (e.g. readOnly /Users/example + writable /Users/example/Downloads)
  // gets the file-write* allow via Seatbelt's later-wins evaluation.
  const allWritables = [
    ...opts.config.writablePaths,
    ...opts.config.projectPaths,
  ];
  for (const raw of allWritables) {
    if (!existsSync(raw)) continue;
    const real = canonicalize(raw);
    profile += `(allow file-read* (subpath "${escapeSchemeString(raw)}"))\n`;
    profile += `(allow file-write* (subpath "${escapeSchemeString(raw)}"))\n`;
    if (real !== raw) {
      profile += `(allow file-read* (subpath "${escapeSchemeString(real)}"))\n`;
      profile += `(allow file-write* (subpath "${escapeSchemeString(real)}"))\n`;
    }
  }

  // --- Governance file denies (AFTER workspace allow so they win).
  //
  // Without these, `rm -rf .git` inside a writable workspace is
  // allowed. Seatbelt is later-wins; we use `subpath` for `.git`
  // (directory) and `literal` for `.gitignore` / `.claudeignore`
  // (files). If the path doesn't exist yet we fall back to the
  // spec's default shape — the rule will take effect once the file
  // is created inside the sandbox.
  //
  // Self-review finding (D060 Phase 2 2.4): emit denies for BOTH
  // the raw workspace + canonicalized workspace bases so the rule
  // coverage matches the allow rules (which also emit both forms).
  // Seatbelt likely canonicalizes VFS paths internally, but we've
  // chosen a belt-and-suspenders shape throughout this module —
  // making the deny side asymmetric would be a trap waiting for a
  // future OS update that changes canonicalization behavior.
  const workspaceBases = [opts.workspace];
  if (workspaceReal !== opts.workspace) workspaceBases.push(workspaceReal);

  if (opts.allowWorkspaceGovernanceWrites !== true) {
    for (const base of workspaceBases) {
      for (const gov of GOVERNANCE_FILES) {
        const govPath = join(base, gov.path);
        const govReal = canonicalize(govPath);

        let isDirectory: boolean = gov.isDirectory;
        try {
          if (existsSync(govReal)) {
            isDirectory = statSync(govReal).isDirectory();
          }
        } catch {
          // Fall back to the spec's default; the rule still applies
          // when the file eventually gets created.
        }
        const ruleType = isDirectory ? "subpath" : "literal";

        profile += `(deny file-write* (${ruleType} "${escapeSchemeString(govPath)}"))\n`;
        if (govReal !== govPath) {
          profile += `(deny file-write* (${ruleType} "${escapeSchemeString(govReal)}"))\n`;
        }
      }
    }
  }

  // --- Secret file regex denies (anchored to workspace + writables).
  //
  // Regex rather than `subpath` because the file can live anywhere
  // under the base. Anchored to each base so `$HOME/.env.production`
  // isn't blocked when the agent is iterating in `/Users/me/proj`.
  // Emits read+write denies — a secret shouldn't even be readable
  // by a run_shell command.
  // Self-review (2.4): emit regex denies anchored to BOTH the raw
  // base and the canonicalized base (same belt-and-suspenders as the
  // governance section above). Deduped below so we don't emit
  // redundant lines when raw === real.
  const secretBasesRaw = [opts.workspace, ...allWritables];
  const secretBases: string[] = [];
  for (const base of secretBasesRaw) {
    if (!secretBases.includes(base)) secretBases.push(base);
    const real = canonicalize(base);
    if (!secretBases.includes(real)) secretBases.push(real);
  }
  for (const base of secretBases) {
    const escapedBase = escapeRegexForSchemeLiteral(base);
    for (const secret of SECRET_FILES) {
      let regexPattern: string;
      if (secret.pattern.endsWith("*")) {
        // Per escapeRegexForSchemeLiteral's docstring: ONE backslash
        // in the profile bytes (not two) is what sandbox-exec's `-p`
        // reader + regex engine actually need to treat `.` as a
        // literal dot. Gemini CLI's `'\\\\.'` pattern silently emits
        // an inert rule under `-p`; the regression test exercises
        // the live binary to keep us honest.
        //
        // Quantifier: `[^/]*$` (zero-or-more non-slash to end) so
        // that `.env` bare AND `.env.local` / `.env.production` all
        // match. The original Gemini port used `[^/]+$` (one-or-more)
        // which missed bare `.env` — the exact filename most
        // operators think of when they hear "block secret files".
        //
        // PR-015 MINOR #2 — stem escape now routes through the same
        // canonical `escapeRegexForSchemeLiteral` helper that
        // `escapedBase` uses. Today's SECRET_FILES entries contain
        // only `.` + word chars so hand-rolled `.replace(/\./g,
        // "\\.")` was equivalent, but a future pattern with `+`,
        // `*`, `(`, `[`, `|` would silently produce an inert rule
        // via the hand-rolled path — exactly the SEC-1 shape the
        // self-review commit `755ffec` fixed. Route through the
        // helper so the canonical invariant holds for all entries.
        const stem = escapeRegexForSchemeLiteral(secret.pattern.slice(0, -1));
        regexPattern = `^${escapedBase}/(.*/)?${stem}[^/]*$`;
      } else {
        const lit = escapeRegexForSchemeLiteral(secret.pattern);
        regexPattern = `^${escapedBase}/(.*/)?${lit}$`;
      }
      profile += `(deny file-read* file-write* (regex #"${regexPattern}"))\n`;
    }
  }

  // --- D574 — public template read/write carve-out (terminal suffix).
  //
  // The `.env*` secret regex above also matches public, secret-free
  // templates whose basename ends with `.example`, `.sample`,
  // `.template`, or `.dist` — including compound stems like
  // `.env.local-smoke.example` under `deploy/compose-driver/templates/`.
  // Carve them back out as ordinary workspace files: emit an allow-read/write
  // AFTER the secret deny (Seatbelt is later-wins). The former explicit
  // deny-write applied to every `*.example` file, including unrelated tracked
  // files such as `nautilo-server.service.example`, and made normal checkout
  // impossible. Public templates are scaffolding, not live credentials.
  // Anchored to the same secret bases (workspace + writables, both raw +
  // canonical) and to any depth (`(.*/)?`). The suffix must be terminal
  // on the basename — `.env.example.local` stays blocked. Live secret
  // variants (`.env`, `.env.local`, `.env.production`, ...) equally
  // stay blocked. Never a broad `.env*` or temp-dir exemption.
  const suffixAlt = publicTemplateSuffixAlternation();
  for (const base of secretBases) {
    const escapedBase = escapeRegexForSchemeLiteral(base);
    const anchor = `^${escapedBase}/(.*/)?[^/]+\\.(${suffixAlt})$`;
    profile += `(allow file-read* file-write* (regex #"${anchor}"))\n`;
  }

  // --- D418 A2 — narrow macOS xcrun cache exception.
  //
  // `xcrun` (invoked by the Xcode shims at `/usr/bin/git`, `/usr/bin/clang`,
  // `/usr/bin/swift`, ...) writes its `xcrun_db*` cache to the current
  // user's `confstr(_CS_DARWIN_USER_TEMP_DIR)` dir — `/var/folders/.../T/`
  // — NOT to `$TMPDIR` (which seatbelt.ts already redirects to
  // `/private/tmp`). Confstr is per-UID and not redirectable via env, so
  // redirecting cache/temp to the private per-dispatch scratch is not
  // feasible for xcrun; a Seatbelt exception is genuinely required.
  //
  // Least-privilege shape: allow ONLY `xcrun_db*` files under the
  // current user's temp dir (default `os.tmpdir()` on Darwin). Both raw
  // + canonical forms emitted for the `/var` → `/private/var` quirk.
  // The regex `xcrun_db[^/]*$` matches ONLY xcrun_db files — never all
  // of `/private/var/folders` and never arbitrary sibling temp files
  // (`<dir>/other.txt` stays denied by `(deny default)`). Emitted
  // BEFORE the dataDir + protected-path deny sections so those
  // load-bearing final denies still win if a future protected subtree
  // ever overlapped the user temp dir. Linux/bubblewrap is unaffected:
  // no xcrun exists there, and the rule is omitted unless a caller
  // (tests) supplies an explicit `xcrunCacheDir` off-Darwin.
  const xcrunCacheDir =
    opts.xcrunCacheDir ?? (process.platform === "darwin" ? tmpdir() : undefined);
  if (xcrunCacheDir !== undefined) {
    const cacheReal = canonicalize(xcrunCacheDir);
    const cacheBases = [xcrunCacheDir];
    if (cacheReal !== xcrunCacheDir) cacheBases.push(cacheReal);
    for (const base of cacheBases) {
      const escapedBase = escapeRegexForSchemeLiteral(base);
      profile += `(allow file-read* file-write* (regex #"^${escapedBase}/xcrun_db[^/]*$"))\n`;
    }
  }

  // --- Git worktree support.
  //
  // If `workspace/.git` is a FILE (not a directory), the workspace
  // is a linked worktree and the actual `.git/` lives elsewhere.
  // Git commands need read+write access to BOTH the worktree-scoped
  // git dir (under the main repo's `.git/worktrees/<name>`) AND the
  // main repo's `.git/`. Without this, `git status` silently fails
  // inside the sandbox. Port: Gemini CLI `resolveGitWorktreePaths`.
  // PR-015 MINOR #3 — emit worktree allow for BOTH the canonical and
  // raw (pre-realpath) forms of each git dir. Matches the
  // workspace/governance/secret/dataDir emit-both-forms discipline
  // elsewhere in this file (the `/var → /private/var` quirk on
  // macOS). The helper returns null on the raw form when it's
  // identical to the canonical form so we never emit duplicate
  // rules.
  const worktree = resolveGitWorktreePaths(workspaceReal);
  if (worktree.worktreeGitDir !== null) {
    profile += `(allow file-read* file-write* (subpath "${escapeSchemeString(worktree.worktreeGitDir)}"))\n`;
  }
  if (worktree.worktreeGitDirRaw !== null) {
    profile += `(allow file-read* file-write* (subpath "${escapeSchemeString(worktree.worktreeGitDirRaw)}"))\n`;
  }
  if (worktree.mainGitDir !== null) {
    profile += `(allow file-read* file-write* (subpath "${escapeSchemeString(worktree.mainGitDir)}"))\n`;
  }
  if (worktree.mainGitDirRaw !== null) {
    profile += `(allow file-read* file-write* (subpath "${escapeSchemeString(worktree.mainGitDirRaw)}"))\n`;
  }

  // --- dataDir deny (masks the agent's data/secret-store even if it
  // overlaps the workspace). Mirrors bubblewrap step 7
  // (`--tmpfs dataDir`). Emitted LAST so it overrides any
  // workspace-write rule above.
  const dataDirReal = canonicalize(opts.dataDir);
  profile += `(deny file-read* file-write* (subpath "${escapeSchemeString(opts.dataDir)}"))\n`;
  if (dataDirReal !== opts.dataDir) {
    profile += `(deny file-read* file-write* (subpath "${escapeSchemeString(dataDirReal)}"))\n`;
  }

  // --- D418 task 3.2.1 — canonical protected-path denies (deny-overrides).
  //
  // Emitted AFTER every allow (workspace, readOnly, writable, tools-bin,
  // governance, secret, git worktree, dataDir) so Seatbelt's later-wins
  // evaluation makes a protected subtree stay unreadable + unwritable
  // EVEN WHEN a granted root (profile-bound or baseline) overlaps or
  // contains it. Both raw + canonical forms for the `/var` →
  // `/private/var` quirk, same belt-and-suspenders shape as the
  // workspace / governance / secret / dataDir sections.
  //
  // Unlike readOnlyPaths / writablePaths, denies are emitted even when
  // the path does not yet exist on disk: a protected subtree must
  // remain protected the moment it is created inside the sandbox, and
  // Seatbelt silently ignores denies against currently-missing subpaths
  // so emitting is always safe. The relay curates which descriptor
  // categories reach this field (it excludes system paths the sandbox
  // needs for tool operation); the builder denies whatever it receives.
  for (const raw of opts.config.protectedPaths ?? []) {
    const real = canonicalize(raw);
    profile += `(deny file-read* file-write* (subpath "${escapeSchemeString(raw)}"))\n`;
    if (real !== raw) {
      profile += `(deny file-read* file-write* (subpath "${escapeSchemeString(real)}"))\n`;
    }
  }

  // --- Network.
  //
  // D103:
  //   - isolated: emit no network allow rules (BASE denies by default).
  //   - proxy-allowlist: allow ONLY loopback access to the local proxy
  //     port, if provided by buildSandboxExec/Sandbox.create.
  //   - host/default: preserve Phase 2 allow-all network.
  if (networkPolicy?.mode === "proxy-allowlist" && opts.networkProxyPort !== undefined) {
    profile += buildNetworkProxyRules(opts.networkProxyPort);
  } else if (networkAccess) {
    profile += NETWORK_ALLOW_RULES;
  }

  return profile;
}

/**
 * Network rules appended when `networkAccess: true`. Allows outbound
 * + inbound + DNS resolution + TLS cert validation. Phase 3 will
 * replace this with a proxy-gated allowlist. Ported from Gemini CLI
 * `baseProfile.ts::NETWORK_SEATBELT_PROFILE`.
 */
export const NETWORK_ALLOW_RULES = `
; Network (Phase 2 = allow all; Phase 3 swaps in proxy-gated rules).
(allow network-outbound)
(allow network-inbound)
(allow network-bind)

(allow system-socket
  (require-all
    (socket-domain AF_SYSTEM)
    (socket-protocol 2)
  )
)

(allow mach-lookup
    (global-name "com.apple.bsd.dirhelper")
    (global-name "com.apple.system.opendirectoryd.membership")
    (global-name "com.apple.SecurityServer")
    (global-name "com.apple.networkd")
    (global-name "com.apple.ocspd")
    (global-name "com.apple.trustd.agent")
    (global-name "com.apple.mDNSResponder")
    (global-name "com.apple.mDNSResponderHelper")
    (global-name "com.apple.SystemConfiguration.DNSConfiguration")
    (global-name "com.apple.SystemConfiguration.configd")
)

(allow sysctl-read
  (sysctl-name-regex #"^net.routetable")
)
`;

export function buildNetworkProxyRules(port: number): string {
  return `
; Network (D103 proxy-allowlist): direct network denied by default.
; Only the local Nautilo proxy may be contacted; the proxy enforces
; the host/port allowlist.
(allow network-outbound (remote tcp "localhost:${port}"))
`;
}

// ---------------------------------------------------------------------------
// Internal: git worktree path detection
// ---------------------------------------------------------------------------

interface WorktreePaths {
  /**
   * Canonical (realpath-resolved) worktree-scoped git dir
   * (e.g. `/private/Users/…/main/.git/worktrees/feature-x`).
   */
  readonly worktreeGitDir: string | null;
  /**
   * Canonical (realpath-resolved) main repo git dir
   * (e.g. `/private/Users/…/main/.git`).
   */
  readonly mainGitDir: string | null;
  /**
   * Pre-realpath worktree-scoped git dir. Same value as
   * `worktreeGitDir` when the workspace already sits on the
   * canonical volume, but differs on macOS under the
   * `/var → /private/var` (and `/tmp → /private/tmp`) quirk. The
   * SBPL `(allow subpath ...)` rule must be emitted for BOTH forms
   * so fs ops addressed through the raw form match — same
   * belt-and-suspenders pattern the workspace / governance / secret
   * rules use. Null when the same rule would duplicate the
   * canonical form (dedup at emit site).
   *
   * PR-015 MINOR #3.
   */
  readonly worktreeGitDirRaw: string | null;
  /** Pre-realpath main repo git dir. Same rationale as `worktreeGitDirRaw`. */
  readonly mainGitDirRaw: string | null;
}

/**
 * Detect whether `workspace/.git` is a linked worktree and return
 * the real `worktreeGitDir` (e.g.
 * `/path/to/main/.git/worktrees/feature-x`) + `mainGitDir`
 * (e.g. `/path/to/main/.git`). Returns null for both when the
 * workspace is a regular non-worktree git repo, or not a git repo
 * at all.
 *
 * A linked worktree has a `.git` FILE (not directory) with a single
 * line `gitdir: <absolute-or-relative-path>`. The path points at
 * `<mainGitDir>/worktrees/<name>/`. One directory up from that is
 * the main repo's `.git/`.
 *
 * Port: Gemini CLI `fsUtils.ts::resolveGitWorktreePaths`.
 */
function resolveGitWorktreePaths(workspace: string): WorktreePaths {
  const gitPath = join(workspace, ".git");
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return { worktreeGitDir: null, mainGitDir: null, worktreeGitDirRaw: null, mainGitDirRaw: null };
  }

  if (stat.isDirectory()) {
    // Regular repo (not a worktree) — base rules already cover
    // the `.git` subpath via the workspace allow. Nothing extra.
    return { worktreeGitDir: null, mainGitDir: null, worktreeGitDirRaw: null, mainGitDirRaw: null };
  }

  if (!stat.isFile()) {
    return { worktreeGitDir: null, mainGitDir: null, worktreeGitDirRaw: null, mainGitDirRaw: null };
  }

  let content: string;
  try {
    content = readFileSync(gitPath, "utf8");
  } catch {
    return { worktreeGitDir: null, mainGitDir: null, worktreeGitDirRaw: null, mainGitDirRaw: null };
  }

  const match = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (match === null || match[1] === undefined) {
    return { worktreeGitDir: null, mainGitDir: null, worktreeGitDirRaw: null, mainGitDirRaw: null };
  }

  const rawGitDir = match[1];
  // The gitdir path can be relative (to the workspace) or absolute.
  const absoluteGitDir = rawGitDir.startsWith("/")
    ? rawGitDir
    : resolve(workspace, rawGitDir);

  const worktreeGitDir = tryRealpath(absoluteGitDir);
  if (worktreeGitDir === null) {
    // `.git` file referenced a path that no longer exists on disk.
    // Treat as "not a valid worktree" — base workspace rules still
    // cover the `.git` FILE itself, but no additional scope.
    return { worktreeGitDir: null, mainGitDir: null, worktreeGitDirRaw: null, mainGitDirRaw: null };
  }

  // Walk two directories up: worktreeGitDir is
  // `<mainGitDir>/worktrees/<name>`, so `..` = `<mainGitDir>/worktrees`
  // and `../..` = `<mainGitDir>`.
  const mainGitDir = tryRealpath(dirname(dirname(worktreeGitDir)));

  // PR-015 MINOR #3 — capture the raw (pre-realpath) forms so the
  // caller can emit an SBPL rule for both the canonical and raw
  // paths. Same /var → /private/var belt-and-suspenders pattern the
  // workspace / governance / secret / dataDir rules use elsewhere in
  // this file. The raw forms are `absoluteGitDir` (already resolved
  // relative-to-workspace but not realpath'd) and its `../..`.
  //
  // Dedup rules:
  //   - worktreeGitDirRaw is null when raw === canonical (nothing to
  //     add)
  //   - mainGitDirRaw is null when canonical is null (the realpath of
  //     the computed main-repo path failed — emitting raw would
  //     defend a non-existent path) OR when they match
  const mainGitDirRaw = dirname(dirname(absoluteGitDir));
  const worktreeGitDirRaw =
    absoluteGitDir === worktreeGitDir ? null : absoluteGitDir;
  const mainGitDirRawDedup =
    mainGitDir === null || mainGitDirRaw === mainGitDir
      ? null
      : mainGitDirRaw;

  return {
    worktreeGitDir,
    mainGitDir,
    worktreeGitDirRaw,
    mainGitDirRaw: mainGitDirRawDedup,
  };
}
