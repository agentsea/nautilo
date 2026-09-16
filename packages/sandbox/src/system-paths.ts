/**
 * Per-platform read-only system paths exposed to sandboxed children.
 * D060 Phase 1 task 1.4 (Linux list) + Phase 2 (macOS list).
 *
 * Port: Spacebot `src/sandbox.rs:126-146`
 *   - `LINUX_READ_ONLY_SYSTEM_PATHS` — minimal runtime allowlist for
 *     bwrap `--ro-bind` mounts. Worker/user data dirs NOT mounted
 *     unless explicitly configured as writable.
 *   - `MACOS_READ_ONLY_SYSTEM_PATHS` — Seatbelt SBPL allow-read
 *     entries. Includes `/private/*` canonicalized paths (the macOS
 *     /var → /private/var quirk per paths.ts).
 *
 * Both lists are DELIBERATELY tiny. User `writablePaths` +
 * `projectPaths` extend this surface; the base is what any shell
 * command needs to run at all.
 */

/**
 * Linux ro-bind mount targets. Callers check each path's existence
 * before emitting `--ro-bind <p> <p>` — missing paths are skipped
 * silently (bwrap would otherwise fail on a non-existent source).
 *
 * Port: Spacebot `src/sandbox.rs:126-128`.
 */
export const LINUX_READ_ONLY_SYSTEM_PATHS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/etc",
  "/opt",
  "/run",
  "/nix",
] as const satisfies readonly string[];

/**
 * macOS SBPL `(allow file-read* (subpath …))` targets. `/private/etc`
 * + `/private/var/run` + `/private/tmp` are the canonicalized forms
 * of `/etc`, `/var/run`, `/tmp` respectively — but we emit BOTH
 * shapes because SBPL rule evaluation is path-literal.
 *
 * Port: Spacebot `src/sandbox.rs:133-146`.
 */
export const MACOS_READ_ONLY_SYSTEM_PATHS = [
  "/System",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/Library",
  "/Applications",
  "/private/etc",
  "/private/var/run",
  "/private/tmp",
  "/etc",
  "/dev",
] as const satisfies readonly string[];
