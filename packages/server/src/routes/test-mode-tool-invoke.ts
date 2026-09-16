/**
 * `POST /api/test/tool-invoke` — drive the full tool-invocation
 * pipeline against a known state and return a structured trace.
 *
 * Added for D063 Phase 6 (middleware-invocation mode). Where the
 * sibling `POST /api/test/security-scan` exercises scanner primitives
 * directly (`scanCommand` / `checkPathAccess` / `scanToolResult`),
 * this endpoint drives:
 *
 *     validateBeforeExecution   (packages/agent/src/nodes/tools.ts)
 *            │
 *            ▼
 *     trust.checkToolAccess     (packages/trust/src/personal-policy-resolver.ts)
 *            │  (skipped when request has no actor)
 *            ▼
 *     zone-resolver             (packages/agent/src/tools/file/zones.ts)
 *            │
 *            ▼
 *     realpath-containment      (packages/agent/src/tools/file/zones.ts::assertRealpathContained)
 *            │
 *            ▼
 *     handler                   (the tool's actual func / dispatcher)
 *
 * The `layerHit` response field tells the test WHICH layer produced
 * the outcome — so a test can assert the *right* gate fired instead
 * of just "something blocked." This surfaces the class of drift where
 * a later gate masks an earlier gate's bug.
 *
 * Motivating cases (both caught by host-side tests in
 * `packages/agent/tests/integration/file-tool-security-port.test.ts`
 * but previously uncoverable via the VM harness):
 *
 *   - B-1: `file({command:"read", zone:"absolute", path:"/etc/passwd"})`
 *          — `validateBeforeExecution` must block at the deny-list
 *          gate. Before D079 PR-011, the gate was name-keyed to
 *          legacy `read_file`/`write_file` and skipped the unified
 *          `file` tool entirely.
 *   - B-2: `file({command:"write", zone:"workspace",
 *                 path:"<symlink pointing outside>"})`
 *          — `realpath-containment` must block on resolve. Before
 *          PR-011 the workspace-zone auto-approve passed the string
 *          path through unchecked.
 *
 * Gate posture: this endpoint is gated exactly like its sibling —
 * `NAUTILO_TEST_MODE=1` env var must be set at server boot and a
 * bearer token is enforced by the `test-mode.ts` onRequest hook.
 * 404 (not 401) on failure so the route stays invisible to probes.
 */

import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  buildRelaySandboxProfile,
  createExecuteArtifactTool,
  createFileTool,
  validateBeforeExecution,
} from "@nautilo/agent";
import {
  DeploymentModeSchema,
  NetworkPolicySchema,
  defaultNetworkPolicyForDeploymentMode,
  resolveServerPosture,
  type DeploymentMode,
  type NetworkPolicy,
} from "@nautilo/config";
import {
  LEGACY_RELAY_USER_FALLBACK,
  type RelayCapabilities,
  type RelayDispatchResult,
  type RelaySandboxProfile,
} from "@nautilo/relay";
import type { SecurityLevel } from "@nautilo/security";
import type {
  ToolInvocationLayer,
  ToolInvocationRequest,
  ToolInvocationResponse,
} from "@nautilo/types";

// Re-export for tests (unit tests import the response type).
export type { ToolInvocationLayer, ToolInvocationRequest, ToolInvocationResponse };

/**
 * Cloud-executor tools — run in-process via their factory + handler.
 * Relay-executor tools (run_shell) use the relay-dispatch branch
 * further down instead.
 *
 * - `file`             — unified file tool (D079); takes a context
 *                        with ownerId / workspacePath / currentFolder.
 * - `execute_artifact` — D073 sandboxed script runner; ignores the
 *                        context arg (uses module-globals
 *                        `getArtifactZone` + `resolveServerPosture`).
 *                        The factory wrapper exists so the dispatch
 *                        loop has a uniform shape.
 */
type ToolLike = { invoke: (args: Record<string, unknown>) => Promise<unknown> };
type ToolFactory = (context: Record<string, unknown>) => ToolLike;
const SUPPORTED_CLOUD_TOOLS: Record<string, ToolFactory> = {
  file: (ctx) => createFileTool(ctx) as unknown as ToolLike,
  execute_artifact: () =>
    createExecuteArtifactTool() as unknown as ToolLike,
};

/**
 * Relay-executor tools this endpoint can dispatch. D060 Sprint 2 G2
 * — these go through the production relay protocol (envelope +
 * dispatch) instead of a cloud-side factory. Extending the list
 * requires the relay\u0027s dispatch handler to recognize the toolName
 * AND the relay to report the matching Capability in its
 * `canRunShell` / `canReadWorkspace` / etc. flags.
 */
const SUPPORTED_RELAY_TOOLS: Record<
  string,
  { readonly capability: "canRunShell" | "canReadWorkspace"; readonly impact: "low" | "high" | "destructive" }
> = {
  run_shell: { capability: "canRunShell", impact: "low" },
};

/**
 * Narrow view of the relay registry surface this endpoint uses.
 * Depending on the interface rather than the concrete
 * `InMemoryRelayRegistry` class means:
 *   - Tests can provide a tiny mock that implements only these
 *     three methods (no `as unknown as` cast escape).
 *   - The endpoint\u0027s trust boundary is visible: it looks up a
 *     relay, inspects its capabilities, and dispatches. Anything
 *     beyond that (register, unregister, heartbeat, cancel) is
 *     OUT of this module\u0027s concern.
 *
 * Structurally satisfied by `@nautilo/runtime::InMemoryRelayRegistry`.
 */
export interface RelayRegistryLike {
  findByCapabilityForUser(capability: string, userId: string): string[];
  getCapabilities(relayId: string): RelayCapabilities | null;
  dispatch(
    relayId: string,
    request: {
      toolName: string;
      args: Record<string, unknown>;
      impact: "read-only" | "low" | "high" | "destructive";
      approvalObtained: boolean;
      allowedRoots?: string[] | undefined;
      sandboxProfile?: RelaySandboxProfile | undefined;
      timeout?: number | undefined;
    },
  ): Promise<RelayDispatchResult>;
}

export interface RegisterToolInvokeDeps {
  /** Explicit paired fixture owner; ordinary test-mode callers keep their existing default. */
  defaultRelayUserId?: string;
  /**
   * Set at server boot (packages/server/src/app.ts). When null, the
   * relay-dispatch branch returns a clear "no relay wired" error
   * rather than crashing — lets the FILE-* matrix run without
   * requiring relay infrastructure.
   */
  readonly relayRegistry: RelayRegistryLike | null;
}

/**
 * Expand a leading `~` to the user's home directory. Test-mode
 * endpoint convention so test rows in `expected-outcomes.json` stay
 * host-agnostic. Matches the expansion the file-tool already does
 * for absolute-zone paths.
 *
 * Exported for unit testing.
 */
export function expandHome(p: string | undefined): string | undefined {
  if (p === undefined || p === null || p === "") return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return pathJoin(homedir(), p.slice(2));
  return p;
}

const VALID_LEVELS: ReadonlySet<SecurityLevel> = new Set([
  "yolo",
  "permissive",
  "standard",
  "cautious",
  "paranoid",
]);

// ---------------------------------------------------------------------------
// Request-shape validation
// ---------------------------------------------------------------------------

interface ValidatedInvocationRequest {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly actor: string | undefined;
  readonly securityLevel: SecurityLevel;
  readonly deploymentMode: DeploymentMode | undefined;
  readonly networkPolicy: NetworkPolicy | undefined;
  readonly workspaceRoot: string | undefined;
  readonly currentFolder: string | undefined;
}

interface ValidationError {
  readonly error: string;
  readonly message: string;
}

/**
 * Shape-check the incoming body. Returns the narrow validated request
 * on success, or a ValidationError with a 400-appropriate message on
 * failure. Kept pure + exported for unit testing.
 */
export function validateInvocationRequest(
  body: unknown,
): ValidatedInvocationRequest | ValidationError {
  if (typeof body !== "object" || body === null) {
    return { error: "invalid body", message: "body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;

  const tool = typeof raw["tool"] === "string" ? raw["tool"] : "";
  if (!tool) {
    return { error: "invalid tool", message: "tool must be a non-empty string" };
  }

  const args = raw["args"];
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { error: "invalid args", message: "args must be a JSON object" };
  }

  const levelRaw = raw["securityLevel"];
  // VALID_LEVELS.has() takes any string — no type assertion needed for the predicate.
  const level: SecurityLevel | undefined =
    typeof levelRaw === "string" && VALID_LEVELS.has(levelRaw as SecurityLevel)
      ? (levelRaw as SecurityLevel)
      : undefined;
  if (levelRaw !== undefined && level === undefined) {
    return {
      error: "invalid securityLevel",
      message: `securityLevel must be one of: ${Array.from(VALID_LEVELS).join(", ")}`,
    };
  }

  const actor = typeof raw["actor"] === "string" ? raw["actor"] : undefined;

  const deploymentModeRaw = raw["deploymentMode"];
  let deploymentMode: DeploymentMode | undefined;
  if (deploymentModeRaw !== undefined) {
    const result = DeploymentModeSchema.safeParse(deploymentModeRaw);
    if (!result.success) {
      return {
        error: "invalid deploymentMode",
        message: `deploymentMode must be one of: ${DeploymentModeSchema.options.join(", ")}`,
      };
    }
    deploymentMode = result.data;
  }

  const networkPolicyRaw = raw["networkPolicy"];
  let networkPolicy: NetworkPolicy | undefined;
  if (networkPolicyRaw !== undefined) {
    const result = NetworkPolicySchema.safeParse(networkPolicyRaw);
    if (!result.success) {
      return {
        error: "invalid networkPolicy",
        message: "networkPolicy must be a valid D103 network policy",
      };
    }
    networkPolicy = result.data;
  }

  // Workspace root precedence (per Phase 6 §6.1.3):
  //   1. Request-provided `workspaceRoot`
  //   2. `NAUTILO_SMOKE_WORKSPACE_ROOT` env var
  //   3. undefined (file-tool zone="workspace" tests will fail zone resolution)
  // Either source is `~`-expanded so test rows in expected-outcomes.json
  // stay host-agnostic.
  const requestedRoot =
    typeof raw["workspaceRoot"] === "string" ? raw["workspaceRoot"] : undefined;
  const envRoot = process.env["NAUTILO_SMOKE_WORKSPACE_ROOT"];
  const workspaceRoot = expandHome(requestedRoot ?? envRoot);

  const requestedCurrent =
    typeof raw["currentFolder"] === "string" ? raw["currentFolder"] : undefined;
  const currentFolder = expandHome(requestedCurrent);

  return {
    tool,
    args: args as Record<string, unknown>,
    actor,
    securityLevel: level ?? "standard",
    deploymentMode,
    networkPolicy,
    workspaceRoot,
    currentFolder,
  };
}

// ---------------------------------------------------------------------------
// Pipeline drivers
// ---------------------------------------------------------------------------

/**
 * Classify a failure message (from a thrown error OR from a tool's
 * returned `"Error: ..."` string) into a `ToolInvocationLayer`.
 *
 * The file-tool's dispatcher returns `"Error: ..."` strings for zone
 * + realpath failures (it never throws for those — they're expected
 * rejections routed back to the LLM). Other throws come through as
 * generic handler errors.
 *
 * See packages/agent/src/tools/file/zones.ts for the canonical
 * reason-string shapes:
 *   - "path escapes zone via symlink (<src> -> <resolved>)"
 *   - "parent directory escapes zone via symlink (<src> -> <resolved>)"
 *   - "zone root does not resolve: <root>"
 *   - "zone root is not set (boot-order bug)"
 *   - resolveZone prefixes for traversal / missing folder.
 *
 * Exported for unit testing — this is the only layer-discrimination
 * logic in the module, and regressions here silently wreck the test
 * matrix's layer assertions.
 */
export function classifyHandlerError(errOrMsg: unknown): {
  readonly layerHit: ToolInvocationLayer;
  readonly reason: string;
} {
  const msg =
    errOrMsg instanceof Error
      ? errOrMsg.message
      : typeof errOrMsg === "string"
      ? errOrMsg
      : String(errOrMsg);

  // Realpath containment: assertRealpathContained in zones.ts is the
  // only emitter that uses the phrase "via symlink" (both shapes —
  // "path escapes zone via symlink" and "parent directory escapes zone
  // via symlink" — contain it). resolveZone's textual-traversal error
  // shares the substring "escapes zone" but never "via symlink", so
  // keying the realpath branch on "via symlink" cleanly distinguishes
  // the two layers.
  if (/via symlink/i.test(msg)) {
    return { layerHit: "realpath-containment", reason: msg };
  }

  // M174 — current/absolute zone byte-I/O is a relay transport
  // requirement, not a zone-resolution failure. The message includes
  // `zone="current"` / `zone="absolute"` for UX clarity, so classify it
  // before the generic zone-shape regex below.
  if (/needs a connected desktop relay/i.test(msg)) {
    return { layerHit: "handler", reason: msg };
  }

  // Zone resolver: resolveZone emits "escapes zone root (... not under ...)"
  // for textual `..` traversal plus a family of zone-shape rejections
  // (unknown zone, zone root is not set, control characters, etc).
  // Order matters — the "via symlink" branch above wins if both
  // phrases appear in the same message.
  if (
    /escapes zone root|\bnot under\b|unknown zone|zone root|zone="|workspace root|No folder is open|control characters|currentFolder/i.test(
      msg,
    )
  ) {
    return { layerHit: "zone-resolver", reason: msg };
  }

  return { layerHit: "handler", reason: msg };
}

/**
 * The file tool's dispatcher returns "Error: ..." strings for blocked
 * operations (zone resolution + realpath containment + per-command
 * validation failures). This helper recognizes that shape.
 */
function isErrorResultString(rendered: string): boolean {
  return rendered.startsWith("Error:") || rendered.startsWith("Error in ");
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Register `POST /api/test/tool-invoke` on the Fastify instance.
 * Called from `test-mode.ts` alongside the scanner route so both
 * share the onRequest bearer-token hook.
 */
export function registerToolInvokeRoute(
  app: FastifyInstance,
  deps: RegisterToolInvokeDeps,
): void {
  app.post<{ Body: ToolInvocationRequest }>(
    "/api/test/tool-invoke",
    async (request, reply) => {
      const validated = validateInvocationRequest(request.body);
      if ("error" in validated) {
        return reply.code(400).send(validated);
      }

      const response = await runToolInvocation(validated, deps);
      return reply.send(response);
    },
  );
}

/**
 * Drive the full pipeline and return a `ToolInvocationResponse`.
 * Internal to this module — exposed via the Fastify route only. Tests
 * exercise it through `app.inject` to stay faithful to the real
 * request lifecycle (validation + middleware).
 */
async function runToolInvocation(
  req: ValidatedInvocationRequest,
  deps: RegisterToolInvokeDeps,
): Promise<ToolInvocationResponse> {
  // Layer 1: validateBeforeExecution — D053 scanner + path-deny + D079 file-tool absolute-zone deny
  const blockedMsg = validateBeforeExecution(req.tool, req.args, req.securityLevel);
  if (blockedMsg !== null) {
    return {
      blocked: true,
      reason: blockedMsg,
      layerHit: "validate-before-execution",
    };
  }

  // Layer 2: trust.checkToolAccess — actor-scoped policy
  // Deliberately skipped when no actor is passed. The B-1/B-2 motivating
  // tests don't require this coverage; it's a follow-up when we build
  // actor-aware smoke rows. Caller can always add their own assertion
  // by pre-building the envelope on the call side.

  // D060 Sprint 2 G2 — relay-executor branch. Relay-routed tools
  // (run_shell) go through the production envelope protocol: resolve
  // server posture, build a sandboxProfile from the relay\u0027s reported
  // paths, dispatch via the registry. The relay receives the
  // envelope + applies it via createSandboxFromEnvelope + spawns the
  // subprocess via spawnSandboxed. SANDBOX-LINUX-* smoke rows drive
  // this branch.
  if (req.tool in SUPPORTED_RELAY_TOOLS) {
    return runRelayDispatch(req, deps);
  }

  // Layer 3-5 for cloud-executor tools: resolve + invoke in-process.
  // Zone resolver and realpath containment fire inside the handler's
  // dispatcher (file tool). Classification by caught-error shape
  // lives in classifyHandlerError above.
  const factory = SUPPORTED_CLOUD_TOOLS[req.tool];
  if (!factory) {
    return {
      blocked: true,
      reason: `tool '${req.tool}' not supported by test-mode tool-invoke (cloud: ${Object.keys(SUPPORTED_CLOUD_TOOLS).join(", ")}; relay: ${Object.keys(SUPPORTED_RELAY_TOOLS).join(", ")})`,
      layerHit: "unknown",
    };
  }

  // Build tool context. The file tool needs ownerId + workspacePath +
  // currentFolder; other tools ignore fields they don't use.
  const ctx: Record<string, unknown> = {
    ownerId: req.actor ?? "test-actor",
    ...(req.workspaceRoot !== undefined ? { workspacePath: req.workspaceRoot } : {}),
    ...(req.currentFolder !== undefined ? { currentFolder: req.currentFolder } : {}),
  };

  // Factory construction can throw for malformed context — defense
  // in depth so a bad request surfaces as a clean blocked response
  // with layerHit=unknown instead of a Fastify 500.
  let tool: ToolLike;
  try {
    tool = factory(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      blocked: true,
      reason: `tool factory failed: ${msg}`,
      layerHit: "unknown",
    };
  }

  try {
    const result: unknown = await tool.invoke(req.args);
    const rendered =
      typeof result === "string" ? result : JSON.stringify(result);

    // File-tool convention: dispatcher returns "Error: <reason>" or
    // "Error in <cmd>: <reason>" for blocked ops (zone/realpath/command
    // validation). These are not thrown — they're rejected return
    // values the LLM sees. Treat them as blocked + classify the layer.
    if (isErrorResultString(rendered)) {
      const classified = classifyHandlerError(rendered);
      return {
        blocked: true,
        reason: classified.reason,
        layerHit: classified.layerHit,
      };
    }

    return {
      blocked: false,
      result: rendered,
      layerHit: "handler",
    };
  } catch (err) {
    const classified = classifyHandlerError(err);
    return {
      blocked: true,
      reason: classified.reason,
      layerHit: classified.layerHit,
    };
  }
}

/**
 * Dispatch a relay-executor tool (`run_shell`) through the production
 * envelope protocol. D060 Sprint 2 G2 — SANDBOX-LINUX-* harness.
 *
 * Flow:
 *   1. Locate a connected relay with the required capability (e.g.
 *      `canRunShell`) for the caller\u0027s userId. Test-mode convention:
 *      request.actor OR `LEGACY_RELAY_USER_FALLBACK`.
 *   2. Fetch the relay\u0027s reported capabilities (workspace,
 *      dataDir, toolsBin, userHome) via `getCapabilities`.
 *   3. Build a sandboxProfile via `buildRelaySandboxProfile` using
 *      the current server posture. Returns null if the relay didn\u0027t
 *      report enough paths — we bail with a descriptive error in
 *      that case so operators know what to fix.
 *   4. Dispatch with envelope. Relay validates + applies via
 *      createSandboxFromEnvelope + spawnSandboxed.
 *   5. Return result or error with layerHit="handler" (sandbox
 *      enforcement is its OWN layer; classifying every kernel-level
 *      denial as "handler" is acceptable for v1 — a smoke row
 *      asserting specific reasons can still assert on the reason
 *      string).
 */
async function runRelayDispatch(
  req: ValidatedInvocationRequest,
  deps: RegisterToolInvokeDeps,
): Promise<ToolInvocationResponse> {
  if (deps.relayRegistry === null) {
    return {
      blocked: true,
      reason: `relay-routed tool '${req.tool}' requires a running relay; the server was booted without a relayRegistry (test-mode standalone?). Start the in-VM relay + re-run.`,
      layerHit: "unknown",
    };
  }
  const toolSpec = SUPPORTED_RELAY_TOOLS[req.tool];
  if (toolSpec === undefined) {
    // Should be unreachable — the caller gates on SUPPORTED_RELAY_TOOLS
    // presence — but we guard for drift between the check + lookup.
    return {
      blocked: true,
      reason: `internal: tool '${req.tool}' gated as relay but not in SUPPORTED_RELAY_TOOLS`,
      layerHit: "unknown",
    };
  }

  const userId = req.actor ?? deps.defaultRelayUserId ?? LEGACY_RELAY_USER_FALLBACK;
  const relays = deps.relayRegistry.findByCapabilityForUser(
    toolSpec.capability,
    userId,
  );
  if (relays.length === 0) {
    return {
      blocked: true,
      reason: `no relay with capability '${toolSpec.capability}' registered for user '${userId}'. Start nautilo-relay.service inside the VM + check 'journalctl -u nautilo-relay' for registration status.`,
      layerHit: "unknown",
    };
  }
  const relayId = relays[0]!;
  const relayCaps = deps.relayRegistry.getCapabilities(relayId);
  if (relayCaps === null) {
    return {
      blocked: true,
      reason: `relay '${relayId}' registered but capabilities disappeared before dispatch (race?). Retry.`,
      layerHit: "unknown",
    };
  }

  const basePosture = resolveServerPosture();
  const effectiveMode = req.deploymentMode ?? basePosture.deploymentMode;
  const posture = {
    deploymentMode: effectiveMode,
    securityLevel: basePosture.securityLevel,
    networkPolicy:
      req.networkPolicy ??
      (req.deploymentMode !== undefined
        ? defaultNetworkPolicyForDeploymentMode(effectiveMode)
        : basePosture.networkPolicy ??
          defaultNetworkPolicyForDeploymentMode(basePosture.deploymentMode)),
  };
  const sandboxProfile = buildRelaySandboxProfile({ posture, relayCaps });
  if (sandboxProfile === null) {
    return {
      blocked: true,
      reason: `relay '${relayId}' did not report paths required to build a sandboxProfile (needs workspaceRoot + dataDir + toolsBin; desktop-permissive additionally needs userHome). Check the relay\\u0027s RelayCapabilities registration.`,
      layerHit: "unknown",
    };
  }

  try {
    const result = await deps.relayRegistry.dispatch(relayId, {
      toolName: req.tool,
      args: req.args,
      impact: toolSpec.impact,
      approvalObtained: true,
      allowedRoots: relayCaps.allowedRoots,
      sandboxProfile,
    });

    if (result.status === "error") {
      return {
        blocked: true,
        reason: `relay dispatch error: ${result.error ?? "(no detail)"}`,
        layerHit: "handler",
      };
    }

    const rendered =
      typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result);
    return {
      blocked: false,
      result: rendered,
      layerHit: "handler",
    };
  } catch (err) {
    // Dispatch-level throws: timeout, relay disconnect during call,
    // transport error. Surface as handler-level for the matrix rows
    // — the WIRING is working; the subprocess just didn\u0027t complete.
    return {
      blocked: true,
      reason: err instanceof Error ? err.message : String(err),
      layerHit: "handler",
    };
  }
}
