/**
 * TartDriver — VmDriver implementation for Tart-managed macOS VMs.
 *
 * Shells out to `tart` (plus `tart exec` via the Tart Guest Agent,
 * avoiding SSH auth). Snapshot restore is a destroy + re-clone pattern
 * because Tart doesn't have live snapshots: the "clone from a named
 * source VM" is its idiom.
 *
 * Special case: snapshotRestore("baseline") re-clones from the
 * persistent baseline VM created during setup-macos.sh, then re-plants
 * honeypot fixtures (runtime-written state doesn't survive `tart
 * clone`, so the honeypot only ever lives on the working VM).
 *
 * D063 Phase 2 task 2.4.
 */

import type {
  VmDriver,
  VmStatus,
  HealthProbeOptions,
} from "./driver.ts";
import type {
  Platform,
  HealthProbeResult,
  ExecResult,
  ExecOptions,
  ProbeName,
} from "./types.ts";
import { runCommand } from "./exec.ts";

export interface TartDriverOptions {
  /** Working VM name. Default: "nautilo-smoke-macos". */
  readonly vmName?: string;
  /** Baseline VM name for "restore baseline" path. Default: "nautilo-smoke-macos-baseline". */
  readonly baselineName?: string;
  /** User inside the guest that commands run as. Default: "admin". */
  readonly defaultUser?: string;
}

export class TartDriver implements VmDriver {
  readonly platform: Platform = "macos";
  readonly vmName: string;
  readonly baselineName: string;
  readonly defaultUser: string;

  constructor(opts: TartDriverOptions = {}) {
    this.vmName = opts.vmName ?? "nautilo-smoke-macos";
    this.baselineName = opts.baselineName ?? "nautilo-smoke-macos-baseline";
    this.defaultUser = opts.defaultUser ?? "admin";
  }

  async start(): Promise<void> {
    const s = await this.status();
    if (s === "running") return;
    if (s === "missing") {
      throw new Error(
        `TartDriver: VM '${this.vmName}' does not exist. Run setup-macos.sh first.`,
      );
    }
    // Tart has no start-and-wait subcommand. Spawn `tart run` in the
    // background and poll the guest agent until it responds.
    await runCommand(
      "bash",
      ["-c", `nohup tart run ${shellQuote(this.vmName)} --no-graphics >/dev/null 2>&1 &`],
      { timeoutMs: 5_000 },
    );
    await this.waitForGuestAgent();
  }

  async stop(): Promise<void> {
    const s = await this.status();
    if (s !== "running") return;
    const r = await runCommand("tart", ["stop", this.vmName], {
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `TartDriver: tart stop failed (exit ${r.exitCode}): ${r.stderr}`,
      );
    }
  }

  async status(): Promise<VmStatus> {
    const r = await runCommand("tart", ["list"], { timeoutMs: 10_000 });
    if (r.exitCode !== 0) return "missing";
    // tart list output is columnar plain text:
    //   Source Name                   Disk Size Accessed         State
    //   local  nautilo-smoke-macos    50   26   3 minutes ago    running
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("Source") || line.startsWith("NAME")) continue;
      const cols = line.split(/\s+/);
      // Name is column 2 (index 1). State is the last column.
      if (cols[1] === this.vmName) {
        const state = (cols[cols.length - 1] ?? "").toLowerCase();
        if (state === "running") return "running";
        if (state === "stopped") return "stopped";
        return "stopped";
      }
    }
    return "missing";
  }

  async snapshotTake(name: string): Promise<void> {
    const snapVm = `${this.vmName}-snap-${name}`;

    // Remove any prior snapshot with this name (idempotent)
    if (await this.vmExists(snapVm)) {
      await runCommand("tart", ["delete", snapVm], { timeoutMs: 30_000 });
    }

    // Stop working VM so the clone captures a clean state
    const wasRunning = (await this.status()) === "running";
    if (wasRunning) await this.stop();

    const clone = await runCommand("tart", ["clone", this.vmName, snapVm], {
      timeoutMs: 120_000,
    });
    if (clone.exitCode !== 0) {
      throw new Error(
        `TartDriver: tart clone '${this.vmName}' -> '${snapVm}' failed (exit ${clone.exitCode}): ${clone.stderr}`,
      );
    }

    // Restart working VM so callers can continue using it
    if (wasRunning) await this.start();
  }

  async snapshotRestore(name: string): Promise<void> {
    // Special case: "baseline" restores from the baseline VM (persistent,
    // created during setup-macos.sh). Any other name restores from the
    // named snapshot VM created by snapshotTake().
    const sourceVm = name === "baseline" ? this.baselineName : `${this.vmName}-snap-${name}`;

    if (!(await this.vmExists(sourceVm))) {
      throw new Error(
        `TartDriver: snapshot source '${sourceVm}' not found. ` +
          `Run setup-macos.sh or snapshot-take first.`,
      );
    }

    // Destroy working VM
    if ((await this.status()) === "running") {
      await this.stop();
    }
    if (await this.vmExists(this.vmName)) {
      const del = await runCommand("tart", ["delete", this.vmName], {
        timeoutMs: 30_000,
      });
      if (del.exitCode !== 0) {
        throw new Error(
          `TartDriver: tart delete '${this.vmName}' failed: ${del.stderr}`,
        );
      }
    }

    // Clone fresh copy
    const clone = await runCommand(
      "tart",
      ["clone", sourceVm, this.vmName],
      { timeoutMs: 120_000 },
    );
    if (clone.exitCode !== 0) {
      throw new Error(
        `TartDriver: tart clone '${sourceVm}' -> '${this.vmName}' failed: ${clone.stderr}`,
      );
    }

    await this.start();

    // Re-plant honeypot: `tart clone` doesn't preserve runtime-written
    // state from the source VM. Without this, path-deny tests have no
    // fixtures to protect. restore-then-plant is idempotent regardless
    // of source VM's state.
    await this.execShell(
      "sh $HOME/nautilo/scripts/security-test-env/honeypot.sh restore 2>/dev/null; " +
        "sh $HOME/nautilo/scripts/security-test-env/honeypot.sh plant",
      { timeoutMs: 15_000 },
    );
  }

  async snapshotList(): Promise<readonly string[]> {
    const r = await runCommand("tart", ["list"], { timeoutMs: 10_000 });
    if (r.exitCode !== 0) return [];
    const prefix = `${this.vmName}-snap-`;
    const tags: string[] = [];
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("Source") || line.startsWith("NAME")) continue;
      const cols = line.split(/\s+/);
      const vm = cols[1];
      if (vm && vm.startsWith(prefix)) {
        tags.push(vm.slice(prefix.length));
      }
    }
    // Add "baseline" synthetically if the baseline VM exists — it's the
    // default restore target even though it's not a tart-created snapshot.
    if (await this.vmExists(this.baselineName)) {
      tags.unshift("baseline");
    }
    return tags;
  }

  async execShell(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    // tart exec runs as the VM's logged-in user (admin on cirruslabs images).
    // There's no --user flag; `opts.user` is ignored unless it matches the
    // default, because attempting to sudo-u would require a different
    // auth path than tart exec provides.
    const envScript = buildEnvScript(opts?.env);
    const full = envScript + cmd;

    const r = await runCommand(
      "tart",
      ["exec", this.vmName, "bash", "-c", full],
      { timeoutMs },
    );
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
    };
  }

  async healthProbe(opts?: HealthProbeOptions): Promise<HealthProbeResult> {
    const timeoutMs = opts?.timeoutMs ?? 5_000;
    const results: Array<{ probe: ProbeName; ok: boolean; detail?: string }> = [];

    // 1. Guest agent responds (equivalent to SSH probe on Lima)
    const agentProbe = await runCommand(
      "tart",
      ["exec", this.vmName, "true"],
      { timeoutMs },
    );
    results.push({
      probe: "ssh",
      ok: agentProbe.exitCode === 0,
      ...(agentProbe.exitCode !== 0 ? { detail: agentProbe.stderr.slice(0, 200) } : {}),
    });
    if (agentProbe.exitCode !== 0) {
      return {
        ok: false,
        reason: "Tart Guest Agent not responding",
        checkedAt: new Date().toISOString(),
        probeResults: results,
      };
    }

    // 2. Canary files. Portable set (shared with LimaDriver).
    // /etc/hostname is Linux-specific and missing from cirruslabs
    // macOS base images — use /etc/hosts instead.
    const canary = await this.execShell(
      "test -s /etc/hosts && test -s /bin/sh && test -s /usr/bin/env",
      { timeoutMs },
    );
    results.push({
      probe: "canary-files",
      ok: canary.exitCode === 0,
      ...(canary.exitCode !== 0 ? { detail: "one of /etc/hosts /bin/sh /usr/bin/env missing or empty" } : {}),
    });

    // 3. Honeypot manifest
    const manifest = await this.execShell("test -f $HOME/.honeypot-manifest.json", {
      timeoutMs,
    });
    results.push({
      probe: "honeypot-manifest",
      ok: manifest.exitCode === 0,
      ...(manifest.exitCode !== 0 ? { detail: "~/.honeypot-manifest.json missing" } : {}),
    });

    // 4. Nautilo process (optional)
    if (opts?.requireNautiloProcess) {
      // macOS `pgrep -f` works the same as on Linux
      const proc = await this.execShell("pgrep -f nautilo-server >/dev/null", {
        timeoutMs,
      });
      results.push({
        probe: "nautilo-process",
        ok: proc.exitCode === 0,
        ...(proc.exitCode !== 0 ? { detail: "nautilo-server not in process list" } : {}),
      });
    }

    // 5. Disk sanity
    const disk = await this.execShell("df / | tail -1 | awk '{print $4}'", {
      timeoutMs,
    });
    const freeBlocks = parseInt(disk.stdout.trim(), 10);
    const diskOk = disk.exitCode === 0 && Number.isFinite(freeBlocks) && freeBlocks > 1000;
    results.push({
      probe: "disk-sanity",
      ok: diskOk,
      ...(diskOk ? {} : { detail: `df returned '${disk.stdout.trim()}'` }),
    });

    const allOk = results.every((r) => r.ok);
    return {
      ok: allOk,
      checkedAt: new Date().toISOString(),
      probeResults: results,
      ...(allOk ? {} : { reason: results.find((r) => !r.ok)?.detail ?? "probe failed" }),
    };
  }

  // ------------------------------------------------------------------------
  // private helpers
  // ------------------------------------------------------------------------

  private async vmExists(name: string): Promise<boolean> {
    const r = await runCommand("tart", ["list"], { timeoutMs: 10_000 });
    if (r.exitCode !== 0) return false;
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("Source") || line.startsWith("NAME")) continue;
      const cols = line.split(/\s+/);
      if (cols[1] === name) return true;
    }
    return false;
  }

  private async waitForGuestAgent(maxAttempts = 60, intervalMs = 3_000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const r = await runCommand(
        "tart",
        ["exec", this.vmName, "true"],
        { timeoutMs: 5_000 },
      );
      if (r.exitCode === 0) return;
      await sleep(intervalMs);
    }
    throw new Error(
      `TartDriver: Guest Agent on '${this.vmName}' did not respond within ${
        (maxAttempts * intervalMs) / 1000
      }s`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers (shared shape with lima-driver's env builder)
// ---------------------------------------------------------------------------

function buildEnvScript(env?: Readonly<Record<string, string>>): string {
  if (!env) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    parts.push(`export ${k}=${shellQuote(v)}`);
  }
  return parts.length > 0 ? parts.join("; ") + "; " : "";
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
