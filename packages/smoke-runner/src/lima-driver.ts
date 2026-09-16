/**
 * LimaDriver — VmDriver implementation for Lima-managed Linux VMs.
 *
 * Shells out to limactl. Snapshot restore is apply + stop + start
 * (Lima's SSH usernet forwarder gets stuck after QEMU loadvm alone).
 *
 * D063 Phase 2 task 2.3.
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

export interface LimaDriverOptions {
  /** Instance name. Default: "nautilo-smoke-linux". */
  readonly vmName?: string;
  /** User inside the guest that commands run as. Default: "nautilotest". */
  readonly defaultUser?: string;
}

export class LimaDriver implements VmDriver {
  readonly platform: Platform = "linux";
  readonly vmName: string;
  readonly defaultUser: string;

  constructor(opts: LimaDriverOptions = {}) {
    this.vmName = opts.vmName ?? "nautilo-smoke-linux";
    this.defaultUser = opts.defaultUser ?? "nautilotest";
  }

  async start(): Promise<void> {
    const s = await this.status();
    if (s === "running") return;
    if (s === "missing") {
      throw new Error(
        `LimaDriver: VM '${this.vmName}' does not exist. Run setup-linux.sh first.`,
      );
    }
    const r = await runCommand("limactl", ["start", "--tty=false", this.vmName], {
      timeoutMs: 120_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `LimaDriver: limactl start failed (exit ${r.exitCode}): ${r.stderr}`,
      );
    }
  }

  async stop(): Promise<void> {
    const s = await this.status();
    if (s !== "running") return;
    const r = await runCommand("limactl", ["stop", "--force", this.vmName], {
      timeoutMs: 60_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(
        `LimaDriver: limactl stop failed (exit ${r.exitCode}): ${r.stderr}`,
      );
    }
  }

  async status(): Promise<VmStatus> {
    const r = await runCommand("limactl", ["list", "--format=json"], {
      timeoutMs: 10_000,
    });
    if (r.exitCode !== 0) return "missing";
    // limactl list --format=json emits one JSON object per line, not
    // a JSON array. Parse line-by-line.
    for (const line of r.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { name?: string; status?: string };
        if (parsed.name === this.vmName) {
          const state = (parsed.status ?? "").toLowerCase();
          if (state === "running") return "running";
          if (state === "stopped") return "stopped";
          return "stopped";
        }
      } catch {
        // ignore non-JSON lines (warnings, etc.)
      }
    }
    return "missing";
  }

  async snapshotTake(name: string): Promise<void> {
    const r = await runCommand(
      "limactl",
      ["snapshot", "create", this.vmName, "--tag", name, "-y"],
      { timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `LimaDriver: snapshot create '${name}' failed (exit ${r.exitCode}): ${r.stderr}`,
      );
    }
  }

  async snapshotRestore(name: string): Promise<void> {
    // Phase: apply → clear stuck SSH → stop → start → wait for SSH →
    // re-plant honeypot.
    //
    // The honeypot re-plant at the end mirrors TartDriver's behavior
    // and removes a whole category of "is the honeypot in the snapshot"
    // bugs — depending on when the Lima baseline was created, the
    // honeypot may or may not be captured. Replanting guarantees
    // every restore ends with 9+ fresh sentinels at the expected paths,
    // regardless of snapshot lineage. Costs ~1s.
    const apply = await runCommand(
      "limactl",
      ["snapshot", "apply", this.vmName, "--tag", name, "-y"],
      { timeoutMs: 60_000 },
    );
    if (apply.exitCode !== 0) {
      throw new Error(
        `LimaDriver: snapshot apply '${name}' failed (exit ${apply.exitCode}): ${apply.stderr}`,
      );
    }

    // Kill any stuck ssh multiplex; pkill isn't universally available in
    // every macOS shell context, so best-effort.
    await runCommand("pkill", ["-f", `ssh.*${this.vmName}`], { timeoutMs: 5_000 });

    await this.stop();
    await this.start();
    await this.waitForSsh();

    // Re-plant honeypot: restore first (no-op if manifest absent),
    // then plant. honeypot.sh plant bails if manifest exists; the
    // restore-then-plant sequence is idempotent across snapshot
    // lineages that do or don't include honeypot state.
    await this.execShell(
      "sh $HOME/nautilo/scripts/security-test-env/honeypot.sh restore 2>/dev/null; " +
        "sh $HOME/nautilo/scripts/security-test-env/honeypot.sh plant",
      { timeoutMs: 15_000 },
    );
  }

  async snapshotList(): Promise<readonly string[]> {
    const r = await runCommand(
      "limactl",
      ["snapshot", "list", this.vmName],
      { timeoutMs: 10_000 },
    );
    if (r.exitCode !== 0) return [];
    // Output format (text): header + rows; TAG is column 2
    const tags: string[] = [];
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("ID") || line.startsWith("time=")) continue;
      const cols = line.split(/\s+/);
      if (cols.length >= 2 && cols[1]) {
        tags.push(cols[1]);
      }
    }
    return tags;
  }

  async execShell(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    const user = opts?.user ?? this.defaultUser;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    // Build a login-shell command that runs as the target user with
    // an env block. -l ensures PATH is set (bun is in ~/.bun/bin).
    //
    // Env vars use `export VAR=val;` inside the bash session, NOT
    // `VAR=val cmd` prefix — the latter applies to a single child
    // process, but the prefix gets expanded by the outer shell
    // before it reaches the variable, yielding empty substitution.
    const envScript = buildEnvScript(opts?.env);
    const full = `sudo -u ${user} bash -lc ${shellQuote(envScript + cmd)}`;

    const r = await runCommand(
      "limactl",
      ["shell", this.vmName, "--", "bash", "-c", full],
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

    // 1. SSH responds
    const sshProbe = await runCommand(
      "limactl",
      ["shell", this.vmName, "--", "true"],
      { timeoutMs },
    );
    results.push({
      probe: "ssh",
      ok: sshProbe.exitCode === 0,
      ...(sshProbe.exitCode !== 0 ? { detail: sshProbe.stderr.slice(0, 200) } : {}),
    });
    if (sshProbe.exitCode !== 0) {
      return {
        ok: false,
        reason: "SSH not responding",
        checkedAt: new Date().toISOString(),
        probeResults: results,
      };
    }

    // 2. Canary files (read-only FS sanity). Portable set: /etc/hosts,
    // /bin/sh, /usr/bin/env — all exist on both Linux and macOS by
    // POSIX convention. /etc/hostname is Linux-specific and missing
    // from cirruslabs macOS base images.
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
    const manifest = await this.execShell("test -f $HOME/.honeypot-manifest.json", { timeoutMs });
    results.push({
      probe: "honeypot-manifest",
      ok: manifest.exitCode === 0,
      ...(manifest.exitCode !== 0 ? { detail: "~/.honeypot-manifest.json missing" } : {}),
    });

    // 4. Nautilo process (optional)
    if (opts?.requireNautiloProcess) {
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

  private async waitForSsh(maxAttempts = 60, intervalMs = 1_000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const r = await runCommand(
        "limactl",
        ["shell", this.vmName, "--", "true"],
        { timeoutMs: 5_000 },
      );
      if (r.exitCode === 0) return;
      await sleep(intervalMs);
    }
    throw new Error(
      `LimaDriver: VM '${this.vmName}' did not become SSH-ready within ${maxAttempts}s`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
  // POSIX single-quote everything; escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
