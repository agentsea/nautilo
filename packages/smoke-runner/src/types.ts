/**
 * Core types for the security smoke runner.
 *
 * Consumed by:
 *   - VmDriver implementations (Lima, Tart)
 *   - Runner orchestrating the per-test loop
 *   - CLI (bin/nautilo-smoke), HTTP API (serve mode), stdio MCP server
 *
 * See scripts/security-test-env/README.md for the disposable VM harness.
 */

// ---------------------------------------------------------------------------
// Platform / mode / level enums
// ---------------------------------------------------------------------------

export type Platform = "linux" | "macos";

export type Mode = "destructive" | "substitution";

export type SecurityLevel =
  | "yolo"
  | "permissive"
  | "standard"
  | "cautious"
  | "paranoid";

export const ALL_PLATFORMS: readonly Platform[] = ["linux", "macos"] as const;

export const ALL_SECURITY_LEVELS: readonly SecurityLevel[] = [
  "yolo",
  "permissive",
  "standard",
  "cautious",
  "paranoid",
] as const;

// ---------------------------------------------------------------------------
// Test specification (mirror of expected-outcomes.json entry)
// ---------------------------------------------------------------------------

/**
 * One row from expected-outcomes.json, normalized.
 *
 * The raw JSON uses optional per-platform overrides
 * (destructive_command_linux / destructive_command_macos); after loading,
 * we materialize one TestSpec per (test_id, platform) pair with the
 * resolved commands.
 */
export interface TestSpec {
  readonly id: string;
  /**
   * The single platform THIS materialized spec targets. Used by the
   * Runner to schedule one run per (id, platform). Compare to
   * `applicablePlatforms` which lists all platforms the source JSON
   * row claims for this test.
   */
  readonly platform: Platform;
  /** All platforms this test row applies to, per expected-outcomes.json. */
  readonly applicablePlatforms: readonly Platform[];
  readonly layer: TestLayer;
  readonly description: string;
  readonly destructiveCommand: string | null;
  readonly substitutionCommand: string | null;
  readonly modesSupported: readonly Mode[];
  readonly expectBlocked: boolean;
  readonly expectMessageContains: readonly string[];
  readonly honeypotRequired: boolean;
  readonly securityLevels: readonly SecurityLevel[];
  readonly timeoutMs: number;
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly actor?: string;
  readonly setupNotes?: string;
  /**
   * Tool-invocation payload (D063 Phase 6). Present only when
   * `layer === "tool-invocation"`. The runner dispatches through
   * the per-platform ToolInvocationClient instead of the scanner
   * client when this field is set.
   */
  readonly toolInvocation?: Readonly<{
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly workspaceRoot?: string;
    readonly currentFolder?: string;
    readonly deploymentMode?: "server" | "desktop-permissive" | "desktop-locked";
    readonly networkPolicy?:
      | { readonly mode: "host" }
      | { readonly mode: "isolated" }
      | {
          readonly mode: "proxy-allowlist";
          readonly allow: readonly (
            | { readonly type: "domain"; readonly host: string; readonly ports?: readonly number[] | undefined }
            | { readonly type: "wildcard"; readonly suffix: string; readonly ports?: readonly number[] | undefined }
            | { readonly type: "cidr"; readonly cidr: string; readonly ports?: readonly number[] | undefined }
          )[];
          readonly defaultPort?: 443 | undefined;
        };
  }>;
  /**
   * Tool-invocation expectation (D063 Phase 6). When set, the runner
   * asserts `response.layerHit === expectLayerHit` in addition to
   * the standard blocked/message checks. Catches the class of drift
   * where a later gate masks an earlier gate's bug (B-1/B-2 shape).
   */
  readonly expectLayerHit?:
    | "validate-before-execution"
    | "trust-envelope"
    | "zone-resolver"
    | "realpath-containment"
    | "handler"
    | "unknown";
}

export type TestLayer =
  | "command-scanner"
  | "path-deny"
  | "security-level"
  | "required-capabilities"
  | "content-scanner"
  | "sandbox"
  | "tool-invocation"; // D063 Phase 6 — full tool pipeline (validateBeforeExecution + zone resolver + realpath containment + handler)

// ---------------------------------------------------------------------------
// Test result
// ---------------------------------------------------------------------------

export type TestOutcome =
  | "pass" // block/allow matched expectation, VM healthy, honeypot clean
  | "fail" // response diverged from expected (wrong block message, etc.)
  | "warn" // unexpected allow but no damage — scanner is loose but nothing broke
  | "vm_dead" // watchdog detected VM compromise; restored
  | "skipped" // test not applicable to this platform/mode
  | "error"; // harness failure (not the test subject's fault)

export interface TestResult {
  readonly testId: string;
  readonly platform: Platform;
  readonly mode: Mode;
  readonly securityLevel: SecurityLevel;
  readonly outcome: TestOutcome;
  readonly startedAt: string; // ISO 8601
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly blocked: boolean | null; // null = never ran (skipped/error)
  readonly reasonPhrase?: string; // from the scanner, if blocked
  readonly messages: readonly string[]; // pass-through of observed messages
  readonly watchdogEvents: readonly WatchdogEvent[];
  readonly honeypotVerifyAfter?: HoneypotVerifyReport;
  readonly errorDetail?: string; // only set when outcome === "error"
}

export interface WatchdogEvent {
  readonly at: string;
  readonly probe: ProbeName;
  readonly ok: boolean;
  readonly detail?: string;
}

export type ProbeName =
  | "ssh"
  | "canary-files"
  | "honeypot-manifest"
  | "nautilo-process"
  | "disk-sanity";

// ---------------------------------------------------------------------------
// Run report
// ---------------------------------------------------------------------------

export interface RunReport {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly platform: Platform | "both";
  readonly mode: Mode;
  readonly securityLevel: SecurityLevel;
  readonly gitCommit?: string;
  readonly gitBranch?: string;
  readonly results: readonly TestResult[];
  readonly summary: RunSummary;
}

export interface RunSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly warn: number;
  readonly vmDead: number;
  readonly skipped: number;
  readonly error: number;
}

// ---------------------------------------------------------------------------
// Health probe + exec (VmDriver surface)
// ---------------------------------------------------------------------------

export interface HealthProbeResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly checkedAt: string;
  readonly probeResults: ReadonlyArray<{
    readonly probe: ProbeName;
    readonly ok: boolean;
    readonly detail?: string;
  }>;
}

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated?: boolean;
}

export interface ExecOptions {
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly user?: string; // e.g. "nautilotest"
}

// ---------------------------------------------------------------------------
// Honeypot
// ---------------------------------------------------------------------------

export interface HoneypotVerifyReport {
  readonly ok: boolean;
  readonly unchanged: number;
  readonly leaked: number;
  readonly missing: number;
  readonly details?: string; // raw report body when ok === false
}

// ---------------------------------------------------------------------------
// Nautilo client (tool call surface)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool-invocation pipeline (D063 Phase 6)
// ---------------------------------------------------------------------------

// Canonical shapes live in @nautilo/types so the server (handler) and
// smoke-runner (client) share a single source of truth. Re-export here
// so existing `import { ToolInvocationRequest } from "@nautilo/smoke-runner"`
// call-sites keep working.
export type {
  ToolInvocationLayer,
  ToolInvocationRequest,
  ToolInvocationResponse,
} from "@nautilo/types";

/**
 * @deprecated Use `ToolInvocationRequest` / `ToolInvocationResponse`
 * from `@nautilo/types` (re-exported above) which carry full pipeline
 * metadata. These names were stubbed in Phase 2 but never consumed;
 * kept as aliases for any in-flight branch referencing them.
 */
export type { ToolInvocationRequest as ToolCallRequest } from "@nautilo/types";
export type { ToolInvocationResponse as ToolCallResult } from "@nautilo/types";
