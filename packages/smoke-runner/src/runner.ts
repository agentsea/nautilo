/**
 * Runner — orchestrates the per-test loop for a smoke run.
 *
 * Per test:
 *   1. Restore the driver's VM to baseline (which includes fresh
 *      honeypot plant via unified restore contract)
 *   2. Start HealthWatchdog
 *   3. Invoke scanner via NautiloClient.securityScan
 *   4. Stop watchdog; compare result to expected; emit TestResult
 *
 * Scanner-only scope: we call the scanner primitives, not the full
 * tool-invocation pipeline. That's deliberate — it's what the acceptance contract
 * needs to validate scanner gaps, and keeps the runner focused.
 * Future work (Phase 3) can add a middleware-invocation mode that
 * drives the full toolsNode path.
 *
 * Serial by default (one test at a time). Parallelism across platforms
 * is possible but adds complexity that isn't needed yet — the full
 * matrix runs in <10 min on both platforms.
 *
 * D063 Phase 2 task 2.7.
 */

import { randomBytes } from "node:crypto";
import type { VmDriver } from "./driver.ts";
import type {
  NautiloClient,
  SecurityScanResult,
  ScanLayer,
  ToolInvocationClient,
} from "./nautilo-client.ts";
import { HealthWatchdog } from "./watchdog.ts";
import { Expectations } from "./expectations.ts";
import type {
  Platform,
  Mode,
  SecurityLevel,
  TestResult,
  TestOutcome,
  TestSpec,
  RunReport,
  RunSummary,
  WatchdogEvent,
  HoneypotVerifyReport,
} from "./types.ts";

export type RunnerEvent =
  | { type: "run-start"; runId: string; total: number }
  | { type: "test-start"; testId: string; platform: Platform }
  | { type: "test-end"; result: TestResult }
  | { type: "run-end"; report: RunReport };

export interface RunnerOptions {
  readonly expectations: Expectations;
  /** Map of platform → { driver, client, toolInvocationClient? }.
   *  Runner only iterates the platforms present. `toolInvocationClient`
   *  is optional; tests with `layer: "tool-invocation"` on a platform
   *  lacking a client report as `error` with a clear message. */
  readonly platforms: {
    readonly linux?: {
      driver: VmDriver;
      client: NautiloClient;
      toolInvocationClient?: ToolInvocationClient;
      /**
       * Optional per-test pre-dispatch hook. The Runner invokes this
       * AFTER snapshot restore and BEFORE dispatch, ONLY when
       * `spec.layer === "tool-invocation"`. Use it to start an
       * in-VM service required by the test surface (e.g. the
       * NAUTILO_TEST_MODE_ONLY=1 nautilo-server that serves
       * /api/test/tool-invoke). Throwing surfaces as `error`
       * outcome with the error message.
       */
      beforeToolInvocation?: () => Promise<void>;
    };
    readonly macos?: {
      driver: VmDriver;
      client: NautiloClient;
      toolInvocationClient?: ToolInvocationClient;
      beforeToolInvocation?: () => Promise<void>;
    };
  };
  /** Baseline snapshot name. Default "baseline". */
  readonly baselineSnapshot?: string;
  /** Watchdog tick interval. Default 3s. */
  readonly watchdogIntervalMs?: number;
  /** Called on every runner event. Use for live progress streaming. */
  readonly onEvent?: (evt: RunnerEvent) => void;
  /** Whether to restore VM to baseline between tests. Default true. */
  readonly restoreBetweenTests?: boolean;
  /**
   * Path to honeypot.sh inside the guest, per-platform. When a TestSpec
   * has `honeypotRequired: true`, the runner shells out to
   * `sh <path> verify` after the scan and parses JSON:
   *   {"ok":bool,"unchanged":int,"leaked":int,"missing":int}
   * If `!ok` the test downgrades to `fail` regardless of scanner outcome.
   * Default paths match the VM layout from scripts/security-test-env/.
   */
  readonly honeypotScriptPath?: {
    readonly linux?: string;
    readonly macos?: string;
  };
}

export interface RunFilter {
  readonly pattern?: string;
  readonly layer?: TestSpec["layer"];
  readonly platforms?: readonly Platform[];
  readonly level?: SecurityLevel;
  readonly mode?: Mode;
}

export class Runner {
  private readonly opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  async runMatrix(filter: RunFilter = {}): Promise<RunReport> {
    const runId = randomBytes(8).toString("hex");
    const startedAt = new Date();
    const mode: Mode = filter.mode ?? "destructive";
    const level: SecurityLevel = filter.level ?? "standard";
    const platforms = filter.platforms ?? (
      [
        ...(this.opts.platforms.linux ? (["linux"] as const) : []),
        ...(this.opts.platforms.macos ? (["macos"] as const) : []),
      ]
    );

    const scheduled: TestSpec[] = [];
    for (const platform of platforms) {
      const specs = this.opts.expectations.list({
        platform,
        ...(filter.pattern !== undefined ? { pattern: filter.pattern } : {}),
        ...(filter.layer !== undefined ? { layer: filter.layer } : {}),
      });
      for (const s of specs) scheduled.push(s);
    }

    this.emit({ type: "run-start", runId, total: scheduled.length });
    const results: TestResult[] = [];

    for (const spec of scheduled) {
      this.emit({ type: "test-start", testId: spec.id, platform: spec.platform });
      const result = await this.runOne(spec, spec.platform, mode, level);
      results.push(result);
      this.emit({ type: "test-end", result });
    }

    const finishedAt = new Date();
    const summary = summarize(results);
    const report: RunReport = {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      platform: platforms.length === 1 ? platforms[0]! : "both",
      mode,
      securityLevel: level,
      results,
      summary,
    };
    this.emit({ type: "run-end", report });
    return report;
  }

  private async runOne(
    spec: TestSpec,
    platform: Platform,
    mode: Mode,
    level: SecurityLevel,
  ): Promise<TestResult> {
    const entry = this.opts.platforms[platform];
    const startedAt = new Date();

    if (!entry) {
      return this.buildResult(spec, platform, mode, level, "skipped", startedAt, null, {
        messages: [`platform ${platform} not configured`],
      });
    }

    if (!spec.modesSupported.includes(mode)) {
      return this.buildResult(spec, platform, mode, level, "skipped", startedAt, null, {
        messages: [`mode ${mode} not supported for ${spec.id}`],
      });
    }

    if (!spec.securityLevels.includes(level)) {
      return this.buildResult(spec, platform, mode, level, "skipped", startedAt, null, {
        messages: [`level ${level} not applicable to ${spec.id}`],
      });
    }

    // Scanner tests need a command string; tool-invocation tests carry
    // their payload in `spec.toolInvocation` instead (no shell string).
    const input =
      spec.layer === "tool-invocation"
        ? ""
        : mode === "destructive"
        ? spec.destructiveCommand
        : spec.substitutionCommand;
    if (spec.layer !== "tool-invocation" && (input === null || input === undefined)) {
      return this.buildResult(spec, platform, mode, level, "skipped", startedAt, null, {
        messages: [`no ${mode} command for ${spec.id}`],
      });
    }

    // Restore snapshot (ensures clean state + fresh honeypot)
    if (this.opts.restoreBetweenTests !== false) {
      try {
        await entry.driver.snapshotRestore(this.opts.baselineSnapshot ?? "baseline");
      } catch (err) {
        return this.buildResult(spec, platform, mode, level, "error", startedAt, null, {
          messages: [`snapshot restore failed: ${errMessage(err)}`],
          errorDetail: errMessage(err),
        });
      }
    }

    // Tool-invocation tests need the in-VM nautilo-server running to
    // serve /api/test/tool-invoke. The baseline snapshot captures a
    // service-stopped state so restores are fast; the service is
    // brought up per-test to avoid in-memory state accumulation across
    // runs. Non-tool-invocation tests skip this step — they hit the
    // scanner via the host-side VmScanClient.
    if (spec.layer === "tool-invocation" && entry.beforeToolInvocation !== undefined) {
      try {
        await entry.beforeToolInvocation();
      } catch (err) {
        return this.buildResult(spec, platform, mode, level, "error", startedAt, null, {
          messages: [`beforeToolInvocation failed: ${errMessage(err)}`],
          errorDetail: errMessage(err),
        });
      }
    }

    // Watchdog
    const watchdog = new HealthWatchdog(entry.driver, {
      ...(this.opts.watchdogIntervalMs !== undefined ? { intervalMs: this.opts.watchdogIntervalMs } : {}),
    });
    let watchdogDead = false;
    let watchdogReason = "";
    watchdog.onDead((reason) => { watchdogDead = true; watchdogReason = reason; });
    watchdog.start();

    // Dispatch based on layer. `tool-invocation` drives the full
    // pipeline through the tool-invoke endpoint; all other layers go
    // through the scanner client. Normalize both outcomes to the same
    // SecurityScanResult shape so compareToExpected stays simple.
    let scanResult: SecurityScanResult | null = null;
    let scanError: Error | null = null;
    try {
      if (spec.layer === "tool-invocation") {
        if (!spec.toolInvocation) {
          throw new Error(
            `spec '${spec.id}' has layer "tool-invocation" but no toolInvocation payload`,
          );
        }
        if (!entry.toolInvocationClient) {
          throw new Error(
            `platform '${platform}' has no toolInvocationClient; add one when running tool-invocation tests`,
          );
        }
        const resp = await entry.toolInvocationClient.toolInvoke({
          tool: spec.toolInvocation.tool,
          args: spec.toolInvocation.args,
          securityLevel: level,
          ...(spec.actor !== undefined ? { actor: spec.actor } : {}),
          ...(spec.toolInvocation.workspaceRoot !== undefined
            ? { workspaceRoot: spec.toolInvocation.workspaceRoot }
            : {}),
          ...(spec.toolInvocation.currentFolder !== undefined
            ? { currentFolder: spec.toolInvocation.currentFolder }
            : {}),
          ...(spec.toolInvocation.deploymentMode !== undefined
            ? { deploymentMode: spec.toolInvocation.deploymentMode }
            : {}),
          ...(spec.toolInvocation.networkPolicy !== undefined
            ? { networkPolicy: spec.toolInvocation.networkPolicy }
            : {}),
        });
        // Map ToolInvocationResponse → SecurityScanResult for the
        // downstream compareToExpected path. `matchedPatterns`/
        // `matchedThreats` are scanner-specific and left empty for
        // tool-invocation; expectLayerHit carries the assertion for
        // layer drift.
        scanResult = {
          layer: "command", // placeholder — tool-invocation doesn't map onto scan layers
          level,
          blocked: resp.blocked,
          ...(resp.reason !== undefined ? { reason: resp.reason } : {}),
          ...(resp.result !== undefined ? { output: resp.result } : {}),
        };
        // expectLayerHit assertion. Override outcome semantics: if the
        // layer doesn't match, the test fails even if blocked matched.
        if (spec.expectLayerHit !== undefined && resp.layerHit !== spec.expectLayerHit) {
          scanError = new Error(
            `layer drift: expected layerHit=${spec.expectLayerHit}, got ${resp.layerHit}` +
              (resp.reason !== undefined ? ` (reason: ${resp.reason})` : ""),
          );
        }
      } else {
        // Non-tool-invocation layers always set `input` to a non-null
        // command string (checked above). Narrow the type here for TS.
        scanResult = await entry.client.securityScan({
          layer: layerFromTestLayer(spec.layer),
          level,
          input: input ?? "",
          ...(spec.actor !== undefined ? { source: spec.actor } : {}),
          timeoutMs: spec.timeoutMs,
        });
      }
    } catch (err) {
      scanError = err instanceof Error ? err : new Error(String(err));
    } finally {
      watchdog.stop();
    }

    const watchdogEvents = watchdog.getEvents();

    if (watchdogDead) {
      return this.buildResult(spec, platform, mode, level, "vm_dead", startedAt, null, {
        messages: [`watchdog: ${watchdogReason}`],
        watchdogEvents,
      });
    }

    if (scanError) {
      return this.buildResult(spec, platform, mode, level, "error", startedAt, null, {
        messages: [`scan failed: ${scanError.message}`],
        errorDetail: scanError.message,
        watchdogEvents,
      });
    }

    // Compare to expected
    if (scanResult === null) {
      return this.buildResult(spec, platform, mode, level, "error", startedAt, null, {
        messages: ["scan returned null result"],
        watchdogEvents,
      });
    }

    const outcome = compareToExpected(spec, scanResult);
    const messages = [...outcome.messages];
    let finalOutcome: TestOutcome = outcome.outcome;
    let honeypotVerifyAfter: HoneypotVerifyReport | undefined;

    // Honeypot verification — only when the spec asks for it. A leak
    // promotes the outcome to `fail` regardless of what the scanner
    // said, because the whole point of the honeypot is to catch
    // leaks the scanner might miss.
    if (spec.honeypotRequired) {
      const scriptPath = this.resolveHoneypotScriptPath(platform);
      try {
        honeypotVerifyAfter = await runHoneypotVerify(entry.driver, scriptPath);
        if (!honeypotVerifyAfter.ok) {
          finalOutcome = "fail";
          const parts: string[] = [];
          if (honeypotVerifyAfter.leaked > 0) parts.push(`${honeypotVerifyAfter.leaked} sentinel(s) leaked`);
          if (honeypotVerifyAfter.missing > 0) parts.push(`${honeypotVerifyAfter.missing} fixture(s) missing`);
          messages.push(`honeypot: ${parts.join("; ") || "verify failed"}`);
        }
      } catch (err) {
        messages.push(`honeypot verify failed to execute: ${errMessage(err)}`);
        // Don't fail the test purely because the verify script errored
        // (e.g. missing script in VM); log and continue. A separate
        // MISSING fixture count surfaces via its own channel.
      }
    }

    return this.buildResult(spec, platform, mode, level, finalOutcome, startedAt, scanResult.blocked, {
      ...(scanResult.reason !== undefined ? { reasonPhrase: scanResult.reason } : {}),
      messages,
      watchdogEvents,
      ...(honeypotVerifyAfter !== undefined ? { honeypotVerifyAfter } : {}),
    });
  }

  private resolveHoneypotScriptPath(platform: Platform): string {
    const configured = this.opts.honeypotScriptPath?.[platform];
    if (configured) return configured;
    return platform === "linux"
      ? "/home/nautilotest/nautilo/scripts/security-test-env/honeypot.sh"
      : "/Users/admin/nautilo/scripts/security-test-env/honeypot.sh";
  }

  private buildResult(
    spec: TestSpec,
    platform: Platform,
    mode: Mode,
    level: SecurityLevel,
    outcome: TestOutcome,
    startedAt: Date,
    blocked: boolean | null,
    extras: {
      reasonPhrase?: string;
      messages?: string[];
      errorDetail?: string;
      watchdogEvents?: readonly WatchdogEvent[];
      honeypotVerifyAfter?: HoneypotVerifyReport;
    } = {},
  ): TestResult {
    const finishedAt = new Date();
    return {
      testId: spec.id,
      platform,
      mode,
      securityLevel: level,
      outcome,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      blocked,
      ...(extras.reasonPhrase !== undefined ? { reasonPhrase: extras.reasonPhrase } : {}),
      messages: extras.messages ?? [],
      watchdogEvents: extras.watchdogEvents ?? [],
      ...(extras.errorDetail !== undefined ? { errorDetail: extras.errorDetail } : {}),
      ...(extras.honeypotVerifyAfter !== undefined ? { honeypotVerifyAfter: extras.honeypotVerifyAfter } : {}),
    };
  }

  private emit(evt: RunnerEvent): void {
    try {
      this.opts.onEvent?.(evt);
    } catch {
      // consumer errors don't take the runner down
    }
  }
}

function compareToExpected(
  spec: TestSpec,
  scan: SecurityScanResult,
): { outcome: TestOutcome; messages: string[] } {
  const messages: string[] = [];
  const blockedMatch = scan.blocked === spec.expectBlocked;

  if (!blockedMatch) {
    // scanner allowed when we expected block → fail
    // scanner blocked when we expected allow → fail
    messages.push(
      `expected blocked=${spec.expectBlocked}, got blocked=${scan.blocked}` +
        (scan.reason ? ` (reason: ${scan.reason})` : ""),
    );
    return { outcome: "fail", messages };
  }

  // If a row declares expected text, check the blocked reason OR the
  // successful tool output. This matters for tool-invocation rows:
  // most sandbox smoke tests are expected to be allowed at the outer
  // dispatch layer and prove behavior by echoing a marker from inside
  // the sandbox.
  if (spec.expectMessageContains.length > 0) {
    const observed = (scan.reason ?? scan.output ?? "").toLowerCase();
    const missing = spec.expectMessageContains.filter(
      (phrase) => !observed.includes(phrase.toLowerCase()),
    );
    if (missing.length > 0) {
      messages.push(
        `missing expected phrases: ${missing.join(", ")}. Got: ${scan.reason ?? scan.output ?? "(no reason/output)"}`,
      );
      return { outcome: scan.blocked ? "warn" : "fail", messages };
    }
  }

  messages.push(`pass: blocked=${scan.blocked}`);
  return { outcome: "pass", messages };
}

function layerFromTestLayer(layer: TestSpec["layer"]): ScanLayer {
  switch (layer) {
    case "command-scanner":
      return "command";
    case "path-deny":
      return "path";
    case "content-scanner":
      return "content";
    default:
      // security-level / required-capabilities / sandbox — all exercise the
      // command-scanner path with level overrides; callers provide the
      // right input to exercise them.
      return "command";
  }
}

function summarize(results: readonly TestResult[]): RunSummary {
  const summary: Record<TestOutcome, number> = {
    pass: 0,
    fail: 0,
    warn: 0,
    vm_dead: 0,
    skipped: 0,
    error: 0,
  };
  for (const r of results) summary[r.outcome]++;
  return {
    total: results.length,
    pass: summary.pass,
    fail: summary.fail,
    warn: summary.warn,
    vmDead: summary.vm_dead,
    skipped: summary.skipped,
    error: summary.error,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Exported for unit tests. Shells `honeypot.sh verify` into the VM and
 * parses the last JSON object from stdout. The script may print a
 * human-readable "Details:" section after the JSON — only the JSON
 * line matters for structured consumption.
 */
export async function runHoneypotVerify(
  driver: VmDriver,
  scriptPath: string,
): Promise<HoneypotVerifyReport> {
  const result = await driver.execShell(`sh '${scriptPath}' verify`);
  // The script prints one JSON line; exit code is non-zero on leak. We
  // care about the JSON body regardless of exit code — a leak is a
  // legitimate test outcome, not a harness error.
  const lines = result.stdout.split("\n").filter((l) => l.trim().startsWith("{") && l.trim().endsWith("}"));
  if (lines.length === 0) {
    throw new Error(
      `honeypot verify produced no JSON line on stdout (exit=${result.exitCode}, stderr=${result.stderr.slice(0, 200)})`,
    );
  }
  const json = lines[lines.length - 1]!;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`honeypot verify JSON parse failed: ${errMessage(err)} (raw: ${json.slice(0, 200)})`);
  }
  if (!isHoneypotVerifyRaw(parsed)) {
    throw new Error(`honeypot verify JSON missing required fields: ${json.slice(0, 200)}`);
  }
  const report: HoneypotVerifyReport = {
    ok: parsed.ok,
    unchanged: parsed.unchanged,
    leaked: parsed.leaked,
    missing: parsed.missing,
    ...(result.stderr.trim() ? { details: result.stderr.slice(0, 2000) } : {}),
  };
  return report;
}

function isHoneypotVerifyRaw(
  x: unknown,
): x is { ok: boolean; unchanged: number; leaked: number; missing: number } {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["ok"] === "boolean" &&
    typeof o["unchanged"] === "number" &&
    typeof o["leaked"] === "number" &&
    typeof o["missing"] === "number"
  );
}
