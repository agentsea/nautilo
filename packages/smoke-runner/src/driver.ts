/**
 * VmDriver — uniform interface over Lima (Linux) and Tart (macOS).
 *
 * Implementations live in ./lima-driver.ts and ./tart-driver.ts
 * (Phase 2 tasks 2.3 and 2.4). The Runner depends only on this
 * interface, so the driver can be mocked in tests.
 */

import type {
  Platform,
  HealthProbeResult,
  ExecResult,
  ExecOptions,
} from "./types.ts";

export type VmStatus = "running" | "stopped" | "missing";

export interface VmDriver {
  readonly platform: Platform;
  readonly vmName: string;

  /** Start the VM if not running. No-op if already running. */
  start(): Promise<void>;

  /** Gracefully stop the VM. No-op if not running. */
  stop(): Promise<void>;

  /** Current state. */
  status(): Promise<VmStatus>;

  /**
   * Create a named snapshot of the current VM state.
   *
   * Lima: `limactl snapshot create <vm> --tag <name> -y`
   * Tart: clone working VM to `<vm>-snap-<name>`
   */
  snapshotTake(name: string): Promise<void>;

  /**
   * Restore VM to a named snapshot. Implementation guarantees the VM
   * is reachable via SSH when the promise resolves.
   *
   * Lima: `limactl snapshot apply` + stop + start (the apply alone
   *   leaves SSH forwarding stuck; stop+start refreshes it).
   * Tart: destroy working VM, re-clone from baseline, start, wait.
   */
  snapshotRestore(name: string): Promise<void>;

  /** List snapshot names available to restore. */
  snapshotList(): Promise<readonly string[]>;

  /**
   * Execute a shell command inside the VM. Runs as the `user` option
   * (default "nautilotest" on Lima, "admin" on Tart).
   */
  execShell(cmd: string, opts?: ExecOptions): Promise<ExecResult>;

  /**
   * Run the 5-probe health ladder:
   *   1. SSH responds within 5s
   *   2. Canary files present (/etc/hostname, /bin/sh, /usr/bin/env)
   *   3. Honeypot manifest present (~/.honeypot-manifest.json)
   *   4. Nautilo server process alive (pgrep -f nautilo-server) — skipped
   *      if the test doesn't run the server
   *   5. Root disk sane (df / returns expected fields)
   *
   * Any one failing → {ok: false, reason, probeResults}.
   */
  healthProbe(opts?: HealthProbeOptions): Promise<HealthProbeResult>;
}

export interface HealthProbeOptions {
  /**
   * If true, probe #4 (nautilo-process) is checked. Default false —
   * not every smoke test requires the server to be running.
   */
  readonly requireNautiloProcess?: boolean;
  /** Per-probe timeout (default 5s). */
  readonly timeoutMs?: number;
}

/** Common base exported for test-mock convenience. */
export interface DriverInfo {
  readonly platform: Platform;
  readonly vmName: string;
}
