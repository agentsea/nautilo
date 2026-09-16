/**
 * Backend detection for `@nautilo/sandbox`. D060 Phase 1 task 1.3.
 *
 * Probes the host at `Sandbox.create()` time and caches the result.
 * Returns a `SandboxBackend` discriminated union; callers use the
 * `kind` to dispatch in `wrap()` without re-probing per call.
 *
 * Port: Spacebot `src/sandbox.rs` — `detect_backend()` pattern (not
 * quoted line range; the Rust impl spreads across the module between
 * the enum and the `Sandbox::new` constructor around lines 182-227).
 *
 * Test strategy: mock `execFile` via dependency injection so the unit
 * tests don't need a real bwrap binary. The default export probes the
 * real shell; tests use `detectBackendWith` with their own prober.
 */

import { execFile } from "node:child_process";

import type { SandboxBackend } from "./types";

/**
 * Result of running an external binary. Narrower than Node's
 * ChildProcess shape because we only care about exit code for the
 * presence/absence probe.
 */
interface ProbeResult {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Run a binary with args; resolve with exit code + stderr. Never
 * throws — failures (binary missing, timeout) resolve with
 * exitCode=-1 and a descriptive stderr.
 *
 * Exported so tests can stub it via `detectBackendWith()`.
 */
export type Prober = (binary: string, args: readonly string[]) => Promise<ProbeResult>;

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Production prober — uses node:child_process.execFile.
 *
 * Exit-code mapping:
 *   - Child exited 0                  → exitCode: 0
 *   - Child exited non-zero numeric   → exitCode: <numeric>
 *   - Binary missing (ENOENT)         → exitCode: 127 (POSIX "not found" convention)
 *   - Timeout / signal / other errno  → exitCode: -1
 *
 * Callers only check `exitCode !== 0` for presence/absence, so the
 * specific negative / 127 distinction is cosmetic — but keeping the
 * conventional 127 for ENOENT makes logs less confusing.
 */
export const realProber: Prober = (binary, args) =>
  new Promise<ProbeResult>((resolve) => {
    execFile(binary, [...args], { timeout: DEFAULT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err === null) {
        resolve({ exitCode: 0, stderr: stderr.toString() });
        return;
      }
      const errno = (err as NodeJS.ErrnoException).code;
      let exitCode: number;
      if (typeof errno === "number") {
        // Child exited with a numeric non-zero status.
        exitCode = errno;
      } else if (errno === "ENOENT") {
        exitCode = 127;
      } else {
        // Timeout, EACCES, signal, etc.
        exitCode = -1;
      }
      resolve({ exitCode, stderr: stderr.toString() });
    });
  });

/**
 * Core detection logic — pure function of platform + prober. Tests
 * stub the prober to cover every branch without shelling out.
 *
 * Rules:
 *   - On Linux: probe `bwrap --version`. If absent, return `{none}`.
 *     If present, additionally probe `/proc` support (nested-Docker
 *     scenarios sometimes can't mount `/proc`). `procSupported` is
 *     carried on the returned backend so the bwrap builder in 1.5
 *     can skip `--proc /proc` when false.
 *   - On Darwin: probe `/usr/bin/sandbox-exec` with a minimal profile
 *     and `/usr/bin/true`. Some macOS builds do NOT support `-V`;
 *     a real no-op sandbox run is the portable presence check.
 *   - Other platforms (Windows, etc.): `{none}` + caller-side
 *     "no backend available" handling.
 */
export async function detectBackendCore(
  platform: NodeJS.Platform,
  prober: Prober,
): Promise<SandboxBackend> {
  if (platform === "linux") {
    const versionProbe = await prober("bwrap", ["--version"]);
    if (versionProbe.exitCode !== 0) {
      return { kind: "none" };
    }
    // Probe /proc support — some nested-Docker environments can't
    // mount /proc inside bwrap. Run `bwrap --proc /proc --ro-bind
    // /bin /bin -- true` — if it exits 0, /proc is mountable. If
    // non-zero (usually "no_new_privs failed" or "mount: Operation
    // not permitted"), we have bwrap but need to skip the --proc
    // arg in the builder.
    const procProbe = await prober("bwrap", [
      "--proc",
      "/proc",
      "--ro-bind",
      "/bin",
      "/bin",
      "--",
      "true",
    ]);
    // Capability probe for D418 protected regular-file masks. A late
    // --ro-bind of /usr/bin/true onto /usr/bin/false must make the latter
    // execute successfully. This proves the file-overmount primitive used
    // by guarded profiles without relying on /dev/null or exposing data.
    const fileMaskProbe = await prober("bwrap", [
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/usr/bin/true",
      "/usr/bin/false",
      "--",
      "/usr/bin/false",
    ]);
    return {
      kind: "bubblewrap",
      procSupported: procProbe.exitCode === 0,
      fileMaskSupported: fileMaskProbe.exitCode === 0,
    };
  }

  if (platform === "darwin") {
    const probe = await prober("/usr/bin/sandbox-exec", [
      "-p",
      "(version 1)\n(allow default)",
      "/usr/bin/true",
    ]);
    if (probe.exitCode !== 0) {
      return { kind: "none" };
    }
    return { kind: "sandbox-exec" };
  }

  return { kind: "none" };
}

/**
 * Detect using the real shell + current platform. Production callers
 * use this; tests use `detectBackendCore` with a stub prober.
 */
export async function detectBackend(): Promise<SandboxBackend> {
  return detectBackendCore(process.platform, realProber);
}
