/**
 * Shared mock VmDriver + NautiloClient for the Phase 2.11 integration
 * tests. Controllable from the test body — each scenario sets up the
 * canned responses, runs the Runner, asserts on TestResult shape.
 *
 * Not a public smoke-runner API. Lives under tests/ intentionally so
 * it doesn't pollute the package surface.
 */

import type {
  VmDriver,
  VmStatus,
  HealthProbeOptions,
} from "../../src/driver";
import type {
  Platform,
  HealthProbeResult,
  ExecResult,
  ExecOptions,
} from "../../src/types";
import type {
  NautiloClient,
  SecurityScanRequest,
  SecurityScanResult,
} from "../../src/nautilo-client";
import { Expectations } from "../../src/expectations";

export interface MockDriverOptions {
  platform: Platform;
  /** When provided, healthProbe returns this static result. */
  healthProbeResult?: HealthProbeResult;
  /** When provided, each call to healthProbe pulls the next item until exhausted. Overrides healthProbeResult. */
  healthProbeSequence?: HealthProbeResult[];
  /** Override `execShell`. Default: returns empty stdout, exit 0. */
  execShell?: (cmd: string, opts?: ExecOptions) => Promise<ExecResult>;
  /** Snapshot operations always succeed unless this throws. */
  snapshotRestoreImpl?: (name: string) => Promise<void>;
}

export function makeMockDriver(opts: MockDriverOptions): VmDriver & {
  readonly execShellCalls: string[];
  readonly snapshotRestoreCalls: string[];
} {
  const execShellCalls: string[] = [];
  const snapshotRestoreCalls: string[] = [];
  let probeIdx = 0;

  const defaultProbeOk: HealthProbeResult = {
    ok: true,
    checkedAt: new Date().toISOString(),
    probeResults: [
      { probe: "ssh", ok: true },
      { probe: "canary-files", ok: true },
      { probe: "honeypot-manifest", ok: true },
      { probe: "disk-sanity", ok: true },
    ],
  };

  const driver: VmDriver & {
    readonly execShellCalls: string[];
    readonly snapshotRestoreCalls: string[];
  } = {
    platform: opts.platform,
    vmName: `nautilo-smoke-${opts.platform}`,
    get execShellCalls() { return execShellCalls; },
    get snapshotRestoreCalls() { return snapshotRestoreCalls; },

    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    status: () => Promise.resolve("running" as VmStatus),

    snapshotTake: (_name: string) => Promise.resolve(),
    snapshotRestore: async (name: string) => {
      snapshotRestoreCalls.push(name);
      if (opts.snapshotRestoreImpl) await opts.snapshotRestoreImpl(name);
    },
    snapshotList: () => Promise.resolve(["baseline"] as readonly string[]),

    execShell: async (cmd: string, execOpts?: ExecOptions) => {
      execShellCalls.push(cmd);
      if (opts.execShell) return opts.execShell(cmd, execOpts);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 10,
        timedOut: false,
      };
    },

    healthProbe: (_probeOpts?: HealthProbeOptions) => {
      if (opts.healthProbeSequence && probeIdx < opts.healthProbeSequence.length) {
        const r = opts.healthProbeSequence[probeIdx]!;
        probeIdx++;
        return Promise.resolve(r);
      }
      return Promise.resolve(opts.healthProbeResult ?? defaultProbeOk);
    },
  };

  return driver;
}

export interface MockClientOptions {
  /** Queued scan results, popped one per call. Last one sticks if queue empties. */
  scanResults?: SecurityScanResult[];
  /** Override scan to throw. */
  scanThrows?: Error;
  /** Delay in ms before resolving each scan (test timing-dependent paths). */
  scanDelayMs?: number;
}

export function makeMockClient(opts: MockClientOptions = {}): NautiloClient & {
  readonly scanCalls: SecurityScanRequest[];
} {
  const scanCalls: SecurityScanRequest[] = [];
  const queue = [...(opts.scanResults ?? [])];

  return {
    get scanCalls() { return scanCalls; },
    async securityScan(req: SecurityScanRequest): Promise<SecurityScanResult> {
      scanCalls.push(req);
      if (opts.scanDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.scanDelayMs));
      }
      if (opts.scanThrows) throw opts.scanThrows;
      if (queue.length > 1) return queue.shift()!;
      if (queue.length === 1) return queue[0]!;
      return {
        layer: req.layer,
        level: req.level,
        blocked: true,
        reason: "default mock response",
      };
    },
  };
}

/**
 * Build a minimal Expectations object from inline specs. Avoids having
 * to load expected-outcomes.json in unit tests.
 *
 * The `as never` cast is intentional — the public `Expectations`
 * constructor expects a strict `Record<string, RawEntry>` shape with
 * many optional fields, but spelling every field out in every test
 * fixture would dominate the test body with boilerplate unrelated to
 * what each test is actually asserting. The constructor already has
 * `?? defaults` for every optional field. Casting sidesteps the
 * structural check; the runtime defaulting protects correctness.
 */
export function makeExpectations(rawTests: Record<string, Record<string, unknown>>): Expectations {
  return new Expectations(rawTests as never);
}
