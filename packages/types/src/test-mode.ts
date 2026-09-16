/**
 * Test-mode endpoint contract (`POST /api/test/tool-invoke`).
 *
 * Single source of truth for the request + response shapes. Imported
 * by:
 *   - `@nautilo/server` (handler + validation)
 *   - `@nautilo/smoke-runner` (HttpToolInvocationClient + VmToolInvocationClient)
 *
 * Keeping these in `@nautilo/types` (which both packages already
 * depend on) prevents the drift class where server + runner disagree
 * on the response shape.
 *
 * D063 Phase 6 middleware-invocation mode.
 */

/**
 * Security levels recognized by the Nautilo agent.
 * Duplicated here (rather than imported from `@nautilo/security`) so
 * `@nautilo/types` stays a leaf package. The security package's
 * `SecurityLevel` union is the authoritative source; they must stay
 * in sync. If they drift, the server-side validator (which uses the
 * security package's type) will reject requests the client sent.
 */
type SecurityLevel = "yolo" | "permissive" | "standard" | "cautious" | "paranoid";
type DeploymentMode = "server" | "desktop-permissive" | "desktop-locked";
type NetworkPolicy =
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

/**
 * Which pipeline layer produced the outcome. Tests assert on this in
 * addition to the outcome itself so drift between layers surfaces —
 * the right-outcome-wrong-gate class of bug that D079 PR-011 B-1
 * caught.
 *
 *   - `validate-before-execution` — D053 scanner / path-deny /
 *     D079 absolute-zone deny (name-keyed per-tool gate in
 *     `packages/agent/src/nodes/tools.ts::validateBeforeExecution`)
 *   - `trust-envelope` — actor-scoped policy check
 *     (`packages/trust/src/personal-policy-resolver.ts::checkToolAccess`);
 *     skipped when request has no actor
 *   - `zone-resolver` — file-tool zone resolution
 *     (`packages/agent/src/tools/file/zones.ts::resolveZone`)
 *   - `realpath-containment` — symlink-follow containment check
 *     (`zones.ts::assertRealpathContained`)
 *   - `handler` — tool's own dispatcher completed successfully
 *   - `unknown` — tool not wired into the test endpoint, or classifier
 *     couldn't place the error message
 */
export type ToolInvocationLayer =
  | "validate-before-execution"
  | "trust-envelope"
  | "zone-resolver"
  | "realpath-containment"
  | "handler"
  | "unknown";

export interface ToolInvocationRequest {
  /** Catalog tool name (e.g. `"file"`). Server-side SUPPORTED_TOOLS map gates which tools are invokable. */
  readonly tool: string;
  /** Validated by the tool's own Zod schema on the server. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Actor ID for trust-envelope resolution. Omit to skip the trust layer. */
  readonly actor?: string;
  /** Security level for `validateBeforeExecution`. Defaults to `"standard"` when omitted. */
  readonly securityLevel?: SecurityLevel;
  /** Test-only posture deployment-mode override for relay-routed sandbox envelopes. */
  readonly deploymentMode?: DeploymentMode;
  /** Test-only posture network-policy override for relay-routed sandbox envelopes. */
  readonly networkPolicy?: NetworkPolicy;
  /**
   * Isolated workspace root for file-tool `zone: "workspace"` tests.
   * Accepts `~`-prefixed paths (server expands via `os.homedir()`).
   * When omitted, server falls back to `NAUTILO_SMOKE_WORKSPACE_ROOT`
   * env var.
   */
  readonly workspaceRoot?: string;
  /** Current-folder value for file-tool `zone: "current"` tests. Same `~` expansion. */
  readonly currentFolder?: string;
}

export interface ToolInvocationResponse {
  /** True if any pipeline layer blocked the call. `handler` success ⇒ false. */
  readonly blocked: boolean;
  /** Human-readable reason. Present when blocked; may be present on error paths. */
  readonly reason?: string;
  /** Tool result on success. Truncated server-side (tests assert on prefix). */
  readonly result?: string;
  /** Which pipeline layer produced the outcome. */
  readonly layerHit: ToolInvocationLayer;
}
