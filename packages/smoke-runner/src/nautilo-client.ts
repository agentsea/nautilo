/**
 * NautiloClient — drives security-scan tests inside a VM.
 *
 * The runner uses an implementation of NautiloClient per test. There
 * are two implementations:
 *
 *   VmScanClient (default, used by the Runner) — runs
 *     scripts/security-test-env/scan-helper.ts inside the VM via
 *     driver.execShell. Exercises the @nautilo/security build that
 *     is in the VM's snapshotted disk (i.e., the version the maintainer
 *     wants to validate).
 *
 *   HttpScanClient — calls the /api/test/security-scan endpoint on a
 *     running Nautilo server (with NAUTILO_TEST_MODE=1). Useful from
 *     a host that doesn't have VM access, or via the stdio MCP server
 *     (Phase 4).
 *
 * Both return the same SecurityScanResult shape so the Runner doesn't
 * care which backend fired.
 *
 * D063 Phase 2 task 2.6.
 */

import type { VmDriver } from "./driver.ts";
import type {
  SecurityLevel,
  ToolInvocationRequest,
  ToolInvocationResponse,
} from "./types.ts";

export type ScanLayer = "command" | "path" | "content";
export type ResultScanPolicy = "never" | "always" | "on-suspicious";

export interface SecurityScanRequest {
  readonly layer: ScanLayer;
  readonly level: SecurityLevel;
  readonly input: string;
  readonly source?: string;
  readonly resultScanPolicy?: ResultScanPolicy;
  /** Per-request timeout. Default 10s. */
  readonly timeoutMs?: number;
}

export interface SecurityScanResult {
  readonly layer: ScanLayer;
  readonly level: SecurityLevel;
  readonly blocked: boolean;
  readonly reason?: string;
  readonly matchedPatterns?: ReadonlyArray<{
    readonly key: string;
    readonly severity: string;
    readonly description: string;
  }>;
  readonly matchedThreats?: readonly string[];
  readonly contentReplaced?: boolean;
  readonly output?: string;
}

export interface NautiloClient {
  securityScan(req: SecurityScanRequest): Promise<SecurityScanResult>;
}

// ---------------------------------------------------------------------------
// VmScanClient — runs scan-helper.ts inside the VM via driver.execShell
// ---------------------------------------------------------------------------

export interface VmScanClientOptions {
  /** Path to scan-helper.ts inside the guest. Default matches our VM layout. */
  readonly helperPath?: string;
  /** Default per-scan timeout. */
  readonly defaultTimeoutMs?: number;
}

export class VmScanClient implements NautiloClient {
  private readonly driver: VmDriver;
  private readonly helperPath: string;
  private readonly defaultTimeoutMs: number;

  constructor(driver: VmDriver, opts: VmScanClientOptions = {}) {
    this.driver = driver;
    this.helperPath =
      opts.helperPath ??
      (driver.platform === "linux"
        ? "/home/nautilotest/nautilo/packages/smoke-runner/scan-helper.ts"
        : "/Users/admin/nautilo/packages/smoke-runner/scan-helper.ts");
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
  }

  async securityScan(req: SecurityScanRequest): Promise<SecurityScanResult> {
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    // Build the stdin JSON and stream into bun via heredoc. The VmDriver's
    // execShell doesn't accept stdin, so we inline the JSON in the shell
    // command. Base64-wrap to avoid escape-hell with single-quoted JSON
    // containing single quotes (e.g., shell commands with apostrophes).
    const bodyJson = JSON.stringify({
      layer: req.layer,
      level: req.level,
      input: req.input,
      ...(req.source !== undefined ? { source: req.source } : {}),
      ...(req.resultScanPolicy !== undefined ? { resultScanPolicy: req.resultScanPolicy } : {}),
    });
    const bodyB64 = Buffer.from(bodyJson, "utf8").toString("base64");

    // Bun is installed at ~/.bun/bin/bun on both platforms. helperPath
    // points inside $HOME/nautilo so bun's workspace resolution finds
    // @nautilo/security.
    const cmd =
      `echo ${bodyB64} | base64 -d | "$HOME/.bun/bin/bun" run ${shellQuote(this.helperPath)}`;

    const r = await this.driver.execShell(cmd, { timeoutMs });

    if (r.exitCode !== 0) {
      throw new Error(
        `VmScanClient: scan-helper exit ${r.exitCode}, stderr: ${r.stderr.slice(0, 500)}`,
      );
    }

    const parsed = JSON.parse(r.stdout) as SecurityScanResult;
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// HttpScanClient — calls /api/test/security-scan on a Nautilo server
// ---------------------------------------------------------------------------

export interface HttpScanClientOptions {
  /** Base URL of the Nautilo server (e.g. "http://localhost:3001"). */
  readonly baseUrl: string;
  /** Bearer token. See resolveTestToken in @nautilo/server. */
  readonly token: string;
  /** Default per-scan timeout. Default 10s. */
  readonly defaultTimeoutMs?: number;
}

export class HttpScanClient implements NautiloClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: HttpScanClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
  }

  async securityScan(req: SecurityScanRequest): Promise<SecurityScanResult> {
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/test/security-scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          layer: req.layer,
          level: req.level,
          input: req.input,
          ...(req.source !== undefined ? { source: req.source } : {}),
          ...(req.resultScanPolicy !== undefined ? { resultScanPolicy: req.resultScanPolicy } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `HttpScanClient: HTTP ${response.status} from ${this.baseUrl}: ${text.slice(0, 500)}`,
        );
      }
      return (await response.json()) as SecurityScanResult;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Tool-invocation clients (D063 Phase 6 — middleware-invocation mode)
// ---------------------------------------------------------------------------

/**
 * Drives the full tool pipeline (validateBeforeExecution → zone
 * resolver → realpath containment → handler) rather than a single
 * scanner primitive. Used by FILE-* smoke rows whose failure mode
 * is the wiring between layers, not any individual scanner.
 *
 * See packages/server/src/routes/test-mode-tool-invoke.ts for the
 * server-side handler + the `layerHit` contract.
 */
export interface ToolInvocationClient {
  toolInvoke(req: ToolInvocationRequest): Promise<ToolInvocationResponse>;
}

// ---------------------------------------------------------------------------
// HttpToolInvocationClient — calls /api/test/tool-invoke on a Nautilo server
// ---------------------------------------------------------------------------

export interface HttpToolInvocationClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Default 30s — tool invocations can spawn fs ops; allow more headroom than scanner. */
  readonly defaultTimeoutMs?: number;
}

export class HttpToolInvocationClient implements ToolInvocationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: HttpToolInvocationClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  async toolInvoke(req: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.defaultTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/api/test/tool-invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `HttpToolInvocationClient: HTTP ${response.status} from ${this.baseUrl}: ${text.slice(0, 500)}`,
        );
      }
      return (await response.json()) as ToolInvocationResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// VmToolInvocationClient — calls the in-VM Nautilo server
// ---------------------------------------------------------------------------
//
// The VM image has a Nautilo server running on loopback with
// NAUTILO_TEST_MODE=1. This client shells a `curl` inside the VM that
// POSTs to `http://127.0.0.1:<port>/api/test/tool-invoke` using the
// smoke token that was provisioned at image-build time. We do this via
// `driver.execShell` for symmetry with VmScanClient.
//
// Port + token are passed in by the Runner; the VM provisioning script
// writes them to `/etc/nautilo/smoke-env` so the runner can read them
// off the driver at setup time.

export interface VmToolInvocationClientOptions {
  /** In-guest server URL. Defaults to `http://127.0.0.1:3001`. */
  readonly baseUrl?: string;
  /** Bearer token. Required — provisioned in /etc/nautilo/smoke-token. */
  readonly token: string;
  /** Default per-invocation timeout. */
  readonly defaultTimeoutMs?: number;
}

export class VmToolInvocationClient implements ToolInvocationClient {
  private readonly driver: VmDriver;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultTimeoutMs: number;

  constructor(driver: VmDriver, opts: VmToolInvocationClientOptions) {
    this.driver = driver;
    this.baseUrl = (opts.baseUrl ?? "http://127.0.0.1:3001").replace(/\/$/, "");
    this.token = opts.token;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  async toolInvoke(req: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    const bodyJson = JSON.stringify(req);
    const bodyB64 = Buffer.from(bodyJson, "utf8").toString("base64");
    // Use curl --fail-with-body so non-2xx returns the body + exit
    // non-zero. Pipe the JSON in via stdin (--data-binary @-) so we
    // don't have to worry about command-line length limits for args
    // that embed file content (e.g. `write` command + large content).
    const cmd =
      `echo ${bodyB64} | base64 -d | ` +
      `curl --fail-with-body --silent --show-error ` +
      `-H 'Content-Type: application/json' ` +
      `-H ${shellQuote(`Authorization: Bearer ${this.token}`)} ` +
      `--data-binary @- ` +
      shellQuote(`${this.baseUrl}/api/test/tool-invoke`);

    const r = await this.driver.execShell(cmd, { timeoutMs: this.defaultTimeoutMs });
    if (r.exitCode !== 0) {
      throw new Error(
        `VmToolInvocationClient: curl exit ${r.exitCode}, stderr: ${r.stderr.slice(0, 500)}`,
      );
    }
    return JSON.parse(r.stdout) as ToolInvocationResponse;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
