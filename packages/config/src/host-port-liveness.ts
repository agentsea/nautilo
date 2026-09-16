import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_TIMEOUT_MS = 5000;

/**
 * Process-local runtime seam for a packaged server-admin CLI. The default
 * remains the probe shipped beside this module; a compiled Bun executable has
 * that module in Bun's virtual filesystem and must explicitly provide its
 * verified real-filesystem copy before a lifecycle command can allocate ports.
 *
 * This is deliberately not an environment variable or a user-facing option:
 * release asset selection is owned by the CLI bundle verifier.
 */
let packagedProbeExecutableOverride: string | undefined;

function probeScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "host-bundle-probe.cjs");
}

/**
 * Select the verified native port-probe helper for this process. Passing
 * undefined restores normal source/npm module-relative CJS resolution through
 * the current Node/Bun executable.
 */
export function setHostPortLivenessProbeExecutableForProcess(path: string | undefined): void {
  if (path === undefined) {
    packagedProbeExecutableOverride = undefined;
    return;
  }
  if (!path.startsWith("/")) {
    throw new Error("Host port probe override must be an absolute path.");
  }
  let details;
  try {
    details = lstatSync(path);
  } catch {
    throw new Error(`Missing host port probe script at ${path}.`);
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Host port probe override must be a regular non-symlink file: ${path}.`);
  }
  if ((details.mode & 0o111) === 0) {
    throw new Error(`Host port probe override must be executable: ${path}.`);
  }
  packagedProbeExecutableOverride = path;
}

/**
 * True if the current process can bind each TCP port in `ports` on
 * `127.0.0.1` (or `NAUTILO_PORT_BIND_PROBE_HOST`) right now — i.e. no other
 * listener is holding them from this host’s perspective.
 *
 * Implemented as a short-lived child process so callers (including
 * synchronous `resolveInstance`) stay on a simple blocking API without
 * blocking the main thread’s libuv listen callbacks.
 */
export function bundlePassesHostTcpBindProbeSync(ports: number[]): boolean {
  if (ports.length !== 6) {
    throw new Error("internal: bundlePassesHostTcpBindProbeSync expects exactly six port numbers");
  }
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error("internal: invalid TCP port in bundlePassesHostTcpBindProbeSync");
  }
  const script = probeScriptPath();
  const executable = packagedProbeExecutableOverride ?? process.execPath;
  if (packagedProbeExecutableOverride === undefined && !existsSync(script)) {
    throw new Error(
      `Missing host port probe script at ${script}. Reinstall @nautilo/config or report a broken package layout.`,
    );
  }
  const payload = JSON.stringify({
    workbench: ports[0],
    server: ports[1],
    dbPostgres: ports[2],
    logtoDb: ports[3],
    logtoCore: ports[4],
    logtoAdmin: ports[5],
  });
  const r = spawnSync(
    executable,
    packagedProbeExecutableOverride === undefined ? [script] : [],
    {
      input: payload,
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: process.env,
    },
  );
  if (r.error !== undefined) {
    return false;
  }
  if (r.signal !== null) {
    return false;
  }
  return r.status === 0;
}
