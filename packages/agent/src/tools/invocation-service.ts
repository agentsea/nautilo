import { browserToolMayMutate, isBrowserTool } from "@nautilo/relay";
import { readBrowserHistory } from "./browser/browser-history";
import { resolveBrowserDecisionModel } from "./browser/browser-snapshot";
import { browserDecisionPlanError, browserDecisionPlanSchema, currentBrowserDecision, interpretBrowserDecisionCall, interpretBrowserDecisionPlanArgs } from "../graph/browser-decision";
import { parseNativeDecisionPlan } from "../graph/native-decision-plan";
import { currentNativeDecision, nativeDecisionDispatchError } from "../graph/native-decision";
import { computerUseContractSupportedForState } from "../config/computer-use-catalogue/live-selection";
import { readResearchContext } from "./security/research-context";
import { localToolControlFailure } from "./security/research-control-feedback";
import { SECURITY_SCAN_MAX_RESULTS } from "@nautilo/types";
import { deriveResearchWorkContext, parseResearchHandoffRequest, performResearchHandoff, researchWorkFinalizationError, researchScanRestartError, researchReviewMutationError } from "./security/research-work-context";
import { isTaskReadErrorReceipt } from "./tasks/read-projection";
import { researchContextRecoveryToolError, researchRuntimeRecoveryFacts } from "./security/research-context-rollover";
import { getModelTokenLimit } from "../providers/models";
import { unfinishedFileDiscovery } from "./security/discovery-continuation";
import { securityScanProgressText, type RelaySecurityScanProgressMessage } from "@nautilo/relay";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { NautiloState } from "../agent/state";
import { defaultPostModelDeps } from "../agent/post-model-deps";
import type { UncontainedHostCommandsDispatchRequest } from "../nodes/post-model";
import type { RunnableConfig } from "@langchain/core/runnables";
import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { log, warn } from "@nautilo/logger";
import { assignStableToolMessageId } from "@nautilo/message-invariants";
import {
  fromRuntimeConfig,
  resolveInstance,
  resolveServerPosture,
  type NetworkAllowRule,
} from "@nautilo/config";
import { buildRelaySandboxProfile } from "../relay/sandbox-profile-builder";
import {
  approvedNetworkAllowRulesForLane,
  approvedWritablePathsForLane,
  approvalToolKey,
  consumeOneShotNetworkAllowRulesForTool,
  recordApprovedNetworkAllowRule,
} from "../nodes/approval-widening";
import { getToolCatalog, type ToolCatalog } from "@nautilo/catalog";
import { getToolPolicy, envelopeReadableNamespaces, type ToolImpact } from "@nautilo/trust";
import { modelSupportsInput } from "@nautilo/model-capabilities";
import {
  BLOCKED_CONTENT_USER_MESSAGE,
  scanCommand,
  checkPathAccess,
  scanToolResult,
  type SecurityLevel,
} from "@nautilo/security";
import {
  localMcpInstallFailure,
  securityScanProbeSchema,
  securityScanRecordKindSchema,
  securityScanOperationSchema,
  securityScanRelayRequestSchema,
  securityScanToolResultSchema,
  securityScanTrustedContextSchema,
  type SecurityScanRelayRequest,
  type SecurityScanFileCitationInput,
  type ApprovalAskNetworkContext,
  type ApprovalReplyVerb,
  type LocalMcpInstallPrepared,
  type StructuredSshApproval,
  type ToolRunShellProgressEvent,
  type ToolStructuredSshProgressEvent,
} from "@nautilo/types";
import { turnContextKey } from "../runtime/turn-context";
import { genieRecoveryResult } from "./genie-recovery";
import type {
  RelayCapabilities,
  RelayDispatchResult,
  RelaySandboxProfile,
  RelayFsRequest,
  RelayFsResult,
  RelayLocalFileRequest,
  RelayLocalFileResult,
  RelayLocalApplyPatchRequest,
  RelayLocalApplyPatchResult,
  RelayBrowserResearchReadRequest,
  RelayBrowserResearchSnapshotInspectionRequest,
  BrowserPageReadResult,
  BrowserPageSnapshotInspectionResult,
  RelayDesktopFilesystemGrantSnapshot,
  RelaySshApprovedRequestV1,
  RelaySshPrepareResponseV1,
  RelaySshDispatchBindingV1,
  RelaySshOperation,
  RelaySshResolutionFailure,
  RelayWorkstationProfileSnapshot,
  RelayWorkstationShellBinding,
  RelayRunShellProgressMessage,
  RelayStructuredSshProgressMessage,
  ComputerUseHostDispatchRequest,
} from "@nautilo/relay";
import {
  DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
  RELAY_SSH_DISPATCH_BINDING_VERSION,
  RELAY_SSH_APPROVED_REQUEST_VERSION,
  computeRelaySshApprovedRequestDigestV1,
  parseRelaySshApprovedRequestV1,
  parseRelaySshPrepareResponse,
} from "@nautilo/relay";
import {
  RELAY_WORKSTATION_SHELL_BINDING_VERSION,
  RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
} from "@nautilo/relay";
import { AgentToolCallTracker, emitAgentEvent } from "../runtime-hooks";
import { redactSecrets } from "@nautilo/vault";
import { sanitizeToolArgsForEvent } from "../utils/tool-argument-redaction";
import { resolveRunShellTimeout } from "../tools/shell/run-shell";
import { resolveStructuredSshTimeout } from "../tools/structured-ssh/structured-ssh";
import { modelIdForCapabilityProjection } from "../config/model-role-resolution";
import { parseSelectCurrentFolderArgs } from "../tools/current-folder/select-current-folder";
import { createEngagedSkillsHandle } from "../tools/skills/view-skill";
import {
  createActivatedToolsHandle,
  selectedActivatedToolNamesForActor,
  type ActivatedToolLease,
} from "../tools/meta/activated-tools-handle";
import { resolveFileToolResultScanPolicy } from "../tools/file/file-result-scan";
import { captureFileToolResult, type FileResultStatus } from "../tools/file/file-result-status";
import type { FileToolRawArgs } from "../tools/file/schema";
import {
  buildFocusedLocalFileHints,
  runWithFocusedLocalFileHints,
} from "../tools/file/local-file-routing";
import { resolveToolsForExposure } from "../nodes/pre-model";
import {
  recallRecordsToolContextForState,
  type RecallRecordsPort,
} from "./memory/recall-records";
import { buildApplyPatchToolContext } from "./apply-patch/execution-router";
import { createBrowserResearchExecutionPort } from "./utilities/browser-research-execution";
import {
  classifyHostScope,
  resolveToolCallHostScope,
  type HostScopeRequirement,
} from "../runtime/host-scoped-tools";
import { getOrdinaryHostResolver } from "../runtime/ordinary-host-resolver";
import { bindOrdinaryContentAccessExecution, ORDINARY_CONTENT_ACCESS_RECOVERY, OrdinaryContentAccessRetryRequiredError, type OrdinaryContentAccessSelection } from "../runtime/ordinary-content-access";
import {
  runWithRequiredOrdinaryHostContext,
  type RequiredOrdinaryHostDispatchContext,
} from "../runtime/ordinary-host-dispatch-context";
import {
  executeTrustedProjection,
  findProjectionSnapshot,
  isProjectionLikeShareCall,
  projectionApprovalArgs,
} from "./memory/projection-sharing";
import { getLocalMcpToolRuntime } from "./mcp/local-mcp-runtime";
import {
  createUnboundMediaGenerationFailure,
  submitMediaGenerationApproval,
  verifyMediaGenerationPreparedApproval,
} from "./media/media-generation-approval-runtime";
import {
  StrictShadowEnforcementError,
  type ProtectedAgentMemoryRepository,
  type ProtectedAgentMemorySearchPort,
} from "@nautilo/lattice-bridge";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryScopeLifecyclePort,
} from "./memory/protected-memory-ports";
import { getCurrentInitiatingClientSurface } from "../runtime/initiating-client-surface-context";
import {
  runWithTaskCreationContexts,
  taskCreationReturnContextForState,
} from "../runtime/task-creation-return-context";
import {
  taskCreationBackgroundTaskProvenanceForState,
  taskCreationLiveMiniAppContextForState,
} from "../runtime/task-creation-live-mini-app-context";
import { effectiveLiveMiniAppSessionForState } from "../runtime/live-mini-app-execution-context";
import {
  deepResearchReturnContextForState,
  runWithDeepResearchReturnContext,
} from "../runtime/deep-research-return-context";
import { hasAvailableTaskReportBackContinuation } from "../runtime/task-report-back-continuation";
import {
  isComputerUseToolName,
  isSupportedComputerUseToolName,
  deriveComputerUseInvocationId,
  parseComputerUseInvocationBinding,
  resolveComputerUseHostInvocationRequest,
  type ComputerUseInvocationBinding,
} from "../runtime/computer-use-admission";
import {
  computerResultDurableSidecar,
  projectSemanticComputerResult,
} from "./computer/model-result-projector";

function isCheckpointLocalMcpInstallPrepared(value: unknown): value is LocalMcpInstallPrepared {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["binding"] !== null && typeof record["binding"] === "object" &&
    record["request"] !== null && typeof record["request"] === "object" &&
    record["preview"] !== null && typeof record["preview"] === "object";
}

/**
 * Recover observed OpenAI-compatible read-only serialization defects without
 * turning arbitrary malformed commands into executable operations. GLM may
 * concatenate a read-only command and one `path`, `query`, or `glob` argument
 * using its internal `<arg_key>/<arg_value>` markers (occasionally duplicating
 * the opening marker), or carry security citation field names
 * (`startLine`/`endLine`) into a file `lineRange`. Repairs are allowed only on
 * read-only operations and only for structurally unambiguous aliases. Mutations,
 * zones, unknown keys, conflicting values, and any other corruption remain
 * invalid and fail at the ordinary tool schema.
 */
export function normalizeFileProviderArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const command = args["command"];
  if (typeof command !== "string") return args;
  let normalized = args;
  const embedded = /^(list|read|glob|grep|stat)(?:<arg_key>)+(path|query|glob)<\/arg_key><arg_value>([^<\0]{1,1024})(?:<\/arg_value>)?$/.exec(command);
  if (embedded !== null) {
    const baseCommand = embedded[1]!;
    const key = embedded[2]!;
    const value = embedded[3]!.trim();
    const keyAllowed = key === "path" || (baseCommand === "grep" && (key === "query" || key === "glob"));
    const existing = args[key];
    const grepHasQuery = baseCommand !== "grep"
      || key === "query"
      || (typeof args["query"] === "string" && args["query"].trim().length > 0);
    if (value.length > 0 && keyAllowed && grepHasQuery && (existing === undefined || existing === value)) {
      normalized = { ...args, command: baseCommand, [key]: value };
    }
  }
  const canonicalCommand = normalized["command"];
  const rawLineRange = args["lineRange"];
  if (
    (canonicalCommand === "read" || canonicalCommand === "grep")
    && rawLineRange !== null
    && typeof rawLineRange === "object"
    && !Array.isArray(rawLineRange)
  ) {
    const range = rawLineRange as Record<string, unknown>;
    const aliasedFrom = range["from"] === undefined ? range["startLine"] : range["from"];
    const aliasedTo = range["to"] === undefined ? range["endLine"] : range["to"];
    const canonicalFrom = aliasedFrom === 0 ? 1 : aliasedFrom;
    const validFrom = Number.isSafeInteger(canonicalFrom) && (canonicalFrom as number) > 0;
    const validTo = Number.isSafeInteger(aliasedTo) && (aliasedTo as number) > 0;
    if (validFrom && validTo) {
      normalized = {
        ...normalized,
        lineRange: { from: canonicalFrom, to: aliasedTo },
      };
    }
  }
  return normalized;
}

/** Execution routing policy — catalog metadata with static relayCapability fallback. */
export type ExecutionPolicy = {
  executor: "cloud" | "relay";
  impact: ToolImpact;
  hostScope: HostScopeRequirement;
  relayCapability?: string | undefined;
  /**
   * relay id owning a relay-hosted MCP tool. When set,
   * dispatch is PINNED to this relay (not capability-selected) so the call
   * reaches the machine actually running the MCP server.
   */
  hostedBy?: string | null | undefined;
};

/**
 * Resolve executor/impact for toolsNode dispatch. Catalog entries are
 * authoritative for executor and impact, including dynamic app tools. Built-in
 * relay tools keep `relayCapability` from static TOOL_POLICIES because
 * catalog entries do not carry that field.
 */
export function resolveExecutionPolicy(
  toolName: string,
  catalog: Pick<ToolCatalog, "get">,
): ExecutionPolicy {
  const entry = catalog.get(toolName);
  if (entry) {
    const executor = entry.executor === "relay" ? "relay" : "cloud";
    const policy: ExecutionPolicy = {
      executor,
      impact: entry.impact,
      hostScope: classifyHostScope({
        toolName,
        executor,
        hostedBy: entry.hostedBy,
      }),
    };
    if (executor === "relay") {
      const staticRelay = getToolPolicy(toolName).relayCapability;
      if (staticRelay) {
        policy.relayCapability = staticRelay;
      }
      // a relay-hosted MCP tool carries its owning relay id;
      // dispatch pins to it rather than capability-selecting a relay.
      if (entry.hostedBy) {
        policy.hostedBy = entry.hostedBy;
      }
    }
    return policy;
  }

  const staticPolicy = getToolPolicy(toolName);
  return {
    executor: staticPolicy.executor,
    impact: staticPolicy.impact,
    relayCapability: staticPolicy.relayCapability,
    hostScope: classifyHostScope({
      toolName,
      executor: staticPolicy.executor,
    }),
  };
}

/**
 * Per-command log label for the
 * unified `file` tool. Returns `"file:<command>"` when the tool
 * dispatch carries a string `command` arg, bare tool name
 * otherwise.
 *
 * Consumed by every log line in this file that formats `tc.name`
 * so `grep '[file:str_replace]' nautilo-server.log` reconstructs
 * the entire lifecycle of a str_replace call — from cloud-vs-relay
 * routing decision through execution through result scanning.
 *
 * The WS-event tool name (tool.start / tool.end payloads) stays
 * bare `file` — tool-card renderer keys on that name
 * for its visual dispatch + expects it unchanged. Log labeling is
 * a separate channel (server log only), so the two surfaces
 * don't conflict.
 */
function formatToolLogLabel(tc: { name: string; args: unknown }): string {
  if (tc.name !== "file") return tc.name;
  const args = tc.args as { command?: unknown } | null | undefined;
  if (args && typeof args["command"] === "string") {
    return `${tc.name}:${args["command"]}`;
  }
  return tc.name;
}

/**
 * explicit tool-execution status, stamped onto every
 * `ToolMessage` produced by this node as `additional_kwargs.nautilo_tool_status`.
 *
 * The no-progress breaker (see `graph/no-progress.ts`) keys failure streaks
 * on an EXPLICIT error signal at the execution seam — never inferred from
 * arbitrary successful content ( / spec). Without this marker the breaker
 * would have to pattern-match content prefixes, which is brittle and would
 * misclassify a tool that legitimately returns an "Error: …" string as its
 * successful payload. The marker is internal (`nautilo_` prefix, same
 * convention as `nautilo_event_summary` / `nautilo_reply_to_message_id`),
 * rides `additional_kwargs` (preserved by message-invariants), and does NOT
 * change the `content` the model sees — external tool semantics are
 * unchanged.
 */
function setToolMessageStatus(tm: ToolMessage, status: "success" | "error"): ToolMessage {
  tm.additional_kwargs = {
    ...(tm.additional_kwargs ?? {}),
    nautilo_tool_status: status,
  };
  return tm;
}

/**
 * read the explicit status marker a tools node stamped onto a
 * `ToolMessage`. Returns `null` when the marker is absent (e.g. a ToolMessage
 * produced by an older code path or a tool's own `func` that did not pass
 * through this node's status setter). The breaker treats `null` as "not an
 * error" so it never false-positives on unmarked messages.
 */
function readToolMessageStatus(tm: ToolMessage): "success" | "error" | null {
  const v = (tm.additional_kwargs ?? {})["nautilo_tool_status"];
  if (v === "success" || v === "error") return v;
  return null;
}

/** bounded readable fallback carried inside typed semantic recovery. */
const GOOGLE_AUTH_REQUIRED_GUIDANCE =
  "Google Workspace is not connected on this device or the login expired. " +
  "Open Google Workspace setup, sign in, then retry.";

/** @internal Exported for unit tests. */
export function formatGoogleAuthRequiredRelayError(relayError?: string): string {
  void relayError;
  return genieRecoveryResult("google_workspace", GOOGLE_AUTH_REQUIRED_GUIDANCE);
}

function relayResultErrorCode(result: RelayDispatchResult): string | undefined {
  const code = (result as RelayDispatchResult & { errorCode?: string }).errorCode;
  return typeof code === "string" ? code : undefined;
}

const RUN_SHELL_OUTPUT_ARTIFACT_CONTINUATION_ERROR_CODES = new Set([
  "RUN_SHELL_OUTPUT_ARTIFACT_REQUEST_INVALID",
  "RUN_SHELL_OUTPUT_ARTIFACT_UNAVAILABLE",
  "RUN_SHELL_OUTPUT_ARTIFACT_NOT_FOUND",
  "RUN_SHELL_OUTPUT_ARTIFACT_SEARCH_UNSUPPORTED",
]);

const STRUCTURED_SSH_OUTPUT_ARTIFACT_CONTINUATION_ERROR_CODES = new Set([
  "STRUCTURED_SSH_OUTPUT_ARTIFACT_REQUEST_INVALID",
  "STRUCTURED_SSH_OUTPUT_ARTIFACT_UNAVAILABLE",
  "STRUCTURED_SSH_OUTPUT_ARTIFACT_NOT_FOUND",
]);

/**
 * Continuation retrieval is the only relay error whose typed disposition is
 * useful to Genie: an old Desktop rejecting search should trigger one
 * legacy-page fallback, never a rerun. Keep every unrelated relay error
 * byte-for-byte compatible and do not reflect arbitrary relay error codes.
 */
function formatRelayToolError(
  tc: { name: string; args: Record<string, unknown> },
  result: RelayDispatchResult,
): string {
  const detail = result.error ?? "unknown error";
  const code = relayResultErrorCode(result);
  const outputArtifact = tc.args["output_artifact"];
  const knownContinuationCode =
    tc.name === "run_shell"
      ? code !== undefined && RUN_SHELL_OUTPUT_ARTIFACT_CONTINUATION_ERROR_CODES.has(code)
      : tc.name === "structured_ssh_output"
        ? code !== undefined && STRUCTURED_SSH_OUTPUT_ARTIFACT_CONTINUATION_ERROR_CODES.has(code)
        : false;
  if (
    outputArtifact !== null &&
    typeof outputArtifact === "object" &&
    !Array.isArray(outputArtifact) &&
    knownContinuationCode
  ) {
    return `Error from relay (${code}): ${detail}`;
  }
  if (tc.name.startsWith("structured_ssh_")) {
    const diagnosticCode = code !== undefined && /^STRUCTURED_SSH_[A-Z0-9_]+$/.test(code)
      ? code
      : "STRUCTURED_SSH_UNKNOWN";
    return `Error from relay (${diagnosticCode}): ${detail}`;
  }
  return `Error from relay: ${detail}`;
}

export type ToolRelayRegistry = {
  findByCapabilityForUser(capability: string, userId: string): string[];
  getCapabilities(relayId: string): RelayCapabilities | null | undefined;
  /** protocol version a relay registered with (gates the `fs` class). */
  getProtocolVersion?(relayId: string): number | null | undefined;
  /** protocol v7 — relay owner user (null when not connected). */
  getUserId?(relayId: string): string | null | undefined;
  /** protocol v7 — relay desktop session id (null when none / not connected). */
  getDesktopSessionId?(relayId: string): string | null | undefined;
  /** server-minted per-socket generation for report-back continuation. */
  getRelaySessionId?(relayId: string): string | null | undefined;
  /** exact relay must remain heartbeat-fresh at late revalidation. */
  isRelayHeartbeatFresh?(relayId: string, now?: number): boolean;
  /** protocol v7 — relay capability revision (null when not connected). */
  getCapabilityRevision?(relayId: string): number | null | undefined;
  /**
   * server-derived pairing generation (validated relay-token
   * row id; null when not connected or never carried).
   */
  getPairingGeneration?(relayId: string): string | null | undefined;
  /**
   * the relay's validated advisory Workstation Profile binding snapshot
   * (null when none advertised / not connected). Advisory binding data only;
   * the live compiled profile on the desktop relay remains final.
   */
  getWorkstationProfileSnapshot?(
    relayId: string,
  ): RelayWorkstationProfileSnapshot | null | undefined;
  /**
   * the relay's validated advisory active-grant snapshot for the
   * chosen authenticated relay, or null/undefined when none was advertised.
   *
   * DISCOVERY ONLY. This snapshot is never filesystem authority: it exists so
   * the server can reference (not create) at most one already-held grant id in
   * a `desktopFilesystemGrantRequest`. The desktop live grant store remains
   * authoritative — the relay-local resolver reloads it and re-validates
   * subject/policy/lifetime/identity before any access, so a stale or revoked
   * reference sourced from this snapshot fails closed locally.
   */
  getDesktopFilesystemGrantSnapshot?(
    relayId: string,
  ): RelayDesktopFilesystemGrantSnapshot | null | undefined;
  /**
   * reconnect/session split-brain fix — the LIVE active Full
   * Workstation session for a user, or null/undefined when no session is
   * active or no lookup was wired. Read by the no-plan `run_shell` gate so
   * it fails closed for an active session bound to the selected relay EVEN
   * WHEN the relay's profile snapshot is absent (the split-brain window
   * behind the snapshot-cleared invalidation seam). Non-Full-Mode behavior
   * is byte-for-byte preserved: no session + no snapshot ⇒ generic path.
   */
  getActiveWorkstationSession?(
    userId: string,
  ): ActiveWorkstationSessionView | null | undefined;
  /** server-owned correlated request for Electron-local SSH preparation. */
  prepareStructuredSsh?(
    relayId: string,
    input: {
      readonly instanceId: string;
      readonly userId: string;
      readonly actorId: string;
      readonly actorRole: "owner" | "admin";
      readonly agentId: string;
      readonly executionEntrypoint: "foreground.main";
      readonly toolCallId: string;
      readonly approvedRequestDigest: string;
      readonly operation: RelaySshOperation;
      /** Exact model request already admitted by the Human-review pipeline. */
      readonly approvedRequest: RelaySshApprovedRequestV1;
      readonly timeoutMs?: number | undefined;
    },
  ): Promise<RelaySshPrepareResponseV1>;
  dispatch(
    relayId: string,
    request: {
      toolName: string;
      args: Record<string, unknown>;
      impact: "read-only" | "low" | "high" | "destructive";
      approvalObtained: boolean;
      /** exact Relay provenance for a hosted MCP tool. */
      hostedBy?: string | undefined;
      allowedRoots?: string[] | undefined;
      timeout?: number | undefined;
      sandboxProfile?: RelaySandboxProfile | undefined;
      executionClass?: "computer_use" | "desktop" | "fs" | "browser" | "local-file" | "real_workstation" | "structured-ssh" | undefined;
      /**
       * task 3.1.3b — optional plan-bound shell-binding envelope for a
       * generic `run_shell` dispatch. Carries only opaque ids / binding /
       * operation metadata; the desktop relay revalidates it against its live
       * Electron authority/profile state. The runtime relay registry forwards
       * it to the wire `relay:dispatch` message.
       */
      workstationShellBinding?: RelayWorkstationShellBinding | undefined;
      /** server-owned marker for dispatches admitted by the live uncontained session resolver. */
      uncontainedHostCommandsSession?: true | undefined;
      onSecurityScanProgress?: ((progress: RelaySecurityScanProgressMessage) => void) | undefined;
      onRunShellProgress?: ((progress: RelayRunShellProgressMessage) => void) | undefined;
      onStructuredSshProgress?: ((progress: RelayStructuredSshProgressMessage) => void) | undefined;
      /** Server-local cancellation authority; never serialized onto the relay wire. */
      signal?: AbortSignal | undefined;
      /** validated, secret-free structured SSH admission metadata. */
      sshBinding?: RelaySshDispatchBindingV1 | undefined;
      /** exact server-admitted semantic computer invocation binding. */
      desktopAutomationBinding?: ComputerUseInvocationBinding | undefined;
      /** Exact active-catalogue Host descriptor and validated JSON. */
      computerUseRequest?: ComputerUseHostDispatchRequest | undefined;
      /** server-local Task continuation fence; never serialized. */
      requiredRelaySessionId?: string | undefined;
      requiredDesktopSessionId?: string | undefined;
      requiredPairingGeneration?: string | undefined;
    },
  ): Promise<RelayDispatchResult>;
  /** typed convenience for the `fs` execution class (see InMemoryRelayRegistry). */
  fsDispatch?(
    relayId: string,
    req: RelayFsRequest,
    opts: { mutating: boolean; timeoutMs?: number },
  ): Promise<RelayFsResult>;
  /** typed convenience for the `local-file` execution class (see InMemoryRelayRegistry). */
  localFileDispatch?(
    relayId: string,
    req: RelayLocalFileRequest,
    opts: {
      mutating: boolean;
      approvalObtained: boolean;
      timeoutMs?: number;
      sandboxProfile?: RelaySandboxProfile;
      requiredRelaySessionId?: string;
      requiredDesktopSessionId?: string;
      requiredPairingGeneration?: string;
    },
  ): Promise<RelayLocalFileResult>;
  /** dedicated local apply-patch dispatch; Electron resolves Current Folder authority. */
  applyPatchDispatch?(
    relayId: string,
    req: RelayLocalApplyPatchRequest,
    opts: {
      sandboxProfile: RelaySandboxProfile;
      timeoutMs?: number;
      requiredRelaySessionId?: string;
      requiredDesktopSessionId?: string;
      requiredPairingGeneration?: string;
    },
  ): Promise<RelayLocalApplyPatchResult>;
  /** exact, owner-pinned browser research read; never a relay selector. */
  browserResearchReadDispatch?(
    relayId: string,
    actorId: string,
    request: RelayBrowserResearchReadRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrowserPageReadResult>;
  /** exact, owner-pinned inert retained-page inspection. */
  browserResearchSnapshotInspectionDispatch?(
    relayId: string,
    actorId: string,
    request: RelayBrowserResearchSnapshotInspectionRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BrowserPageSnapshotInspectionResult>;
  browserResearchConsentRecoveryDispatch?(
    relayId: string,
    actorId: string,
    request: import("@nautilo/relay").RelayBrowserResearchConsentRecoveryRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<import("@nautilo/relay").BrowserResearchConsentRecoveryResult>;
  browserResearchSearchDispatch?(
    relayId: string,
    actorId: string,
    request: import("@nautilo/relay").RelayBrowserResearchSearchRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<import("@nautilo/relay").BrowserResearchSearchResult>;
};

function resolveExactTaskContinuationCapabilities(input: {
  registry: ToolRelayRegistry;
  continuation: NautiloState["taskReportBackContinuation"];
  userId: string;
  requiredRelayId: string;
}): RelayCapabilities | null {
  const { registry, continuation, userId, requiredRelayId } = input;
  if (!hasAvailableTaskReportBackContinuation(continuation)) return null;
  const capabilities = registry.getCapabilities(continuation.relayId);
  if (
    requiredRelayId !== continuation.relayId
    || registry.isRelayHeartbeatFresh?.(continuation.relayId) !== true
    || registry.getUserId?.(continuation.relayId) !== userId
    || registry.getRelaySessionId?.(continuation.relayId) !== continuation.relaySessionId
    || registry.getDesktopSessionId?.(continuation.relayId) !== continuation.desktopSessionId
    || registry.getPairingGeneration?.(continuation.relayId) !== continuation.pairingGeneration
    || capabilities?.currentFolderRoot !== continuation.currentFolder
    || (capabilities.workspaceRoot ?? "") !== continuation.workspacePath
  ) return null;
  return capabilities;
}

// ---------------------------------------------------------------------------
// task 3.1.2 — WorkstationDispatchPlan consumption (relay pinning).
//
// The server-side post-model override resolver admits one transient
// `WorkstationDispatchPlan` per tool-call id (binding tool-call id + user +
// relay + instance + desktop session + server binding + profile/revision +
// grant ids + capability revision + operation class). The tools node
// consumes that plan at dispatch time and pins the relay selection to
// `plan.relayId` after re-validating the bound relay is still the EXACT
// bound relay. It must NOT choose a different first-eligible relay after
// approval: a plan whose bound relay is stale/gone fails closed rather than
// falling back to another relay.
//
// The plan is ADMISSION METADATA ONLY — it never replaces local Electron
// grant authority and never widens `allowedRoots` (the sandbox profile +
// relay caps still compute `allowedRoots` exactly as before). The plan only
// selects the relay.
//
// The agent package cannot import `@nautilo/runtime` (runtime imports the
// agent package for the graph executor, so a reverse import would cycle).
// The plan + registry are therefore consumed through STRUCTURAL view types
// that `@nautilo/runtime`'s `InMemoryWorkstationDispatchPlanRegistry`
// satisfies without the agent depending on the runtime package. The view
// types MUST stay structurally compatible with
// `packages/runtime/src/workstation-dispatch-plan.ts`.
// ---------------------------------------------------------------------------

/**
 * Structural view of `WorkstationDispatchPlan` read by the tools node. Only
 * the binding fields the tools node re-validates + the `relayId` it pins.
 * `executionClass` / `admittedAt` are not read here, so they are omitted
 * (the runtime plan carries them; extra fields are fine for assignability).
 */
export interface WorkstationDispatchPlanView {
  readonly toolCallId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly instanceId: string;
  readonly desktopSessionId: string;
  readonly serverBindingId: string;
  /**
   * the server-derived `pairingGeneration` the active Full
   * Workstation session was activated with (never client-authored).
   */
  readonly pairingGeneration: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly grantIds: readonly string[];
  readonly capabilityRevision: number;
  /**
   * the Current Folder the operation was admitted for. When
   * present, the dispatch seam fails closed if the live Current Folder
   * differs (a re-bind to a new Current Folder is an authority change). The
   * runtime plan carries it; extra fields are fine for assignability, so
   * this is optional for backward-compat with earlier plan fixtures.
   */
  readonly currentFolder?: string;
  /** durable grant-store revision at admission (optional). */
  readonly grantRevision?: number | null;
  /** protected-policy version at admission (optional). */
  readonly protectedPolicyVersion?: number | null;
}

/**
 * Structural view of `WorkstationRelayFingerprint` built by the tools node
 * from the live relay registry for the plan's `relayId`.
 */
export interface WorkstationRelayFingerprintView {
  readonly userId: string | null;
  readonly desktopSessionId: string | null;
  readonly capabilityRevision: number | null;
  readonly profileId: string | null;
  readonly profileRevision: number | null;
  /**
   * the live relay's server-derived pairing generation, or
   * `null` when the relay is not connected or never carried one.
   */
  readonly pairingGeneration: string | null;
  /** live grant-store revision (null when not advertised). */
  readonly grantRevision?: number | null;
  /** live protected-policy version (null when not advertised). */
  readonly protectedPolicyVersion?: number | null;
}

export type WorkstationPlanRevalidationReasonView =
  | "relay_not_connected"
  | "user_mismatch"
  | "desktop_session_mismatch"
  | "pairing_generation_mismatch"
  | "capability_revision_mismatch"
  | "profile_binding_mismatch"
  | "binding_metadata_missing"
  | "grant_revision_mismatch"
  | "protected_policy_mismatch"
  | "current_folder_drift"
  | "no_plan";

/**
 * reconnect/session split-brain fix — minimal structural view of an
 * active Full Workstation session read by the no-plan `run_shell` gate.
 * Only the binding fields the gate compares against the selected relay are
 * exposed; the runtime `RelayActiveWorkstationSessionView` satisfies this
 * structurally without the agent importing the runtime package.
 */
export interface ActiveWorkstationSessionView {
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly capabilityRevision: number;
}

export type WorkstationPlanRevalidationResultView =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: WorkstationPlanRevalidationReasonView;
      readonly detail: string;
    };

/**
 * Structural view of `InMemoryWorkstationDispatchPlanRegistry` consumed by
 * the tools node. `revalidate` is declared with method syntax so it stays
 * bivariant under `strictFunctionTypes` — letting the runtime registry
 * (whose `revalidate` accepts the full `WorkstationDispatchPlan`) satisfy
 * this interface without the agent importing the runtime type.
 */
export interface WorkstationDispatchPlanRegistry {
  get(toolCallId: string): WorkstationDispatchPlanView | null;
  revalidate(
    plan: WorkstationDispatchPlanView,
    fingerprint: WorkstationRelayFingerprintView,
  ): WorkstationPlanRevalidationResultView;
  /**
   * same-authority re-admission for a missing / TTL-expired
   * plan. Returns a freshly admitted plan when the live binding (sourced by
   * the registry's injected `getActiveBinding` provider) exactly matches the
   * live relay fingerprint, or `null` when the provider is unwired, no
   * session is active, or authority drifted. Declared with method syntax so
   * it stays bivariant under `strictFunctionTypes`. The runtime registry
   * satisfies this structurally; the agent never imports the runtime type.
   */
  readmit?(input: {
    readonly toolCallId: string;
    readonly userId: string;
    readonly currentFolder: string;
    readonly executionClass: "profile_bound_sandbox" | "typed_broker" | "real_workstation";
    readonly fingerprint: WorkstationRelayFingerprintView;
  }): WorkstationDispatchPlanView | null;
}

let _workstationDispatchPlanRegistry: WorkstationDispatchPlanRegistry | null = null;

/**
 * task 3.1.2 — install the transient `WorkstationDispatchPlan` store
 * the tools node consults to pin relay dispatches. Called once at server
 * startup (after the relay + session registries are constructed). Pass
 * `null` to release (the tools node then skips plan pinning and falls back
 * to the normal first-eligible-relay path — fail-closed, byte-for-byte
 * earlier dispatch behavior).
 */
export function setWorkstationDispatchPlanRegistry(
  registry: WorkstationDispatchPlanRegistry | null,
): void {
  _workstationDispatchPlanRegistry = registry;
}

/** Read the plan registry set at server startup (null if unset). */
export function getWorkstationDispatchPlanRegistry():
  | WorkstationDispatchPlanRegistry
  | null {
  return _workstationDispatchPlanRegistry;
}

/** source Memory ids are private provenance and never room-scoped telemetry. */
export function sanitizeToolCallArgsForEvent(
  tc: { name: string; args: unknown; id?: string },
  state: NautiloState,
): unknown {
  if (
    tc.name === "manage_local_mcp" &&
    tc.args !== null &&
    typeof tc.args === "object" &&
    !Array.isArray(tc.args) &&
    (tc.args as Record<string, unknown>)["action"] === "install"
  ) {
    return { action: "install" };
  }
  if (tc.name === "share_memory" && isProjectionLikeShareCall(tc)) {
    const snapshot = findProjectionSnapshot(state, tc);
    return snapshot ? projectionApprovalArgs(snapshot) : { mode: "project" };
  }
  return sanitizeToolArgsForEvent(tc.args);
}

let _relayRegistry: ToolRelayRegistry | null = null;

/**
 * Set the relay registry for tool dispatch. Called once at server startup.
 * Tools with executor:"relay" dispatch through this registry. Without it,
 * relay tools fail with a clear error — there is no fallback.
 */
export function setRelayRegistry(registry: ToolRelayRegistry | null): void {
  _relayRegistry = registry;
}

/** Read the relay registry set at server startup (null if unset). */
export function getRelayRegistry(): ToolRelayRegistry | null {
  return _relayRegistry;
}

/** Runtime-only immutable report export. Never admits a scan mutation or chooses another host. */
export async function readSecurityResearchExportPage(
  state: NautiloState,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const continuation = state.taskReportBackContinuation;
  if (!state.subagentRun || !state.toolWhitelist?.includes("security_scan")
    || !_relayRegistry || !hasAvailableTaskReportBackContinuation(continuation)) {
    throw new Error("SECURITY_RESEARCH_EXPORT_AUTHORITY_UNAVAILABLE");
  }
  const capabilities = resolveExactTaskContinuationCapabilities({ registry: _relayRegistry,
    continuation, userId: state.userId, requiredRelayId: continuation.relayId });
  if (capabilities?.canReadWorkspace !== true) throw new Error("SECURITY_RESEARCH_EXPORT_HOST_REVOKED");
  const request = securityScanRelayRequestSchema.parse({
    operation: { version: "security-scan-v1", operation: "results", scanId: TASK_BOUND_SECURITY_SCAN_ID,
      category: "all", finalize: false, limit: SECURITY_SCAN_MAX_RESULTS, ...(cursor === undefined ? {} : { cursor }) },
    trustedContext: { taskId: state.currentTaskId, taskRunId: state.currentTaskRunId,
      toolCallId: `security-export-${randomUUID()}`, modelId: state.model },
    expectedCurrentFolder: continuation.currentFolder,
  });
  const result = await _relayRegistry.dispatch(continuation.relayId, {
    toolName: "security_scan", args: request, impact: "read-only", approvalObtained: true,
    allowedRoots: capabilities.allowedRoots,
    requiredRelaySessionId: continuation.relaySessionId,
    requiredDesktopSessionId: continuation.desktopSessionId,
    requiredPairingGeneration: continuation.pairingGeneration,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  if (result.status === "error") {
    const rejected = securityScanToolResultSchema.safeParse(result.result);
    if (rejected.success && !rejected.data.ok) return rejected.data;
    throw new Error("SECURITY_RESEARCH_EXPORT_READ_FAILED");
  }
  return result.result;
}

export interface NautiloToolInvocationCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly authorityRef: string;
}

export type InvocationAuthorityResolution =
  | { readonly status: "allowed" }
  | { readonly status: "denied"; readonly reason: string };

export type InvocationAuthorityResolver = (input: {
  readonly call: NautiloToolInvocationCall;
  readonly authorityRef: string;
}) => InvocationAuthorityResolution | Promise<InvocationAuthorityResolution>;

export interface NautiloToolInvocationResult {
  readonly callId: string;
  readonly toolName: string;
  readonly status: "success" | "error";
  readonly content: ToolMessage["content"];
  readonly additionalKwargs?: ToolMessage["additional_kwargs"];
  readonly eventSummary?: string;
}

export interface NautiloToolInvocationSnapshot {
  readonly engagedSkillNames: readonly string[];
  readonly activatedToolNames: readonly string[];
  readonly activatedToolLeases: readonly ActivatedToolLease[];
}

const invocationServerContexts = new WeakSet<object>();
declare const invocationServerContextBrand: unique symbol;
export interface NautiloToolInvocationServerContext {
  readonly [invocationServerContextBrand]: true;
}
export type ServerToolInvocationContextOptions = Readonly<{
  readonly ordinaryContentAccess?: OrdinaryContentAccessSelection;
  /** Exact server-admitted Full policy for this invocation. */
  readonly fullEncryptionOnly?: boolean;
  /** Exact invocation-bound organized Room recall capability. */
  readonly recallRecordsPort?: RecallRecordsPort;
  /** Process-local protected Memory capability for this invocation only. */
  readonly protectedMemoryRepository?: ProtectedAgentMemoryRepository;
  readonly protectedMemorySearch?: ProtectedAgentMemorySearchPort;
  readonly protectedMemoryAccessPort?: ProtectedAgentMemoryAccessPort;
  readonly protectedMemoryProjectionPort?: ProtectedAgentMemoryProjectionPort;
  readonly protectedMemoryScopeLifecyclePort?: ProtectedAgentMemoryScopeLifecyclePort;
}>;
class ServerToolInvocationContext implements NautiloToolInvocationServerContext {
  declare readonly [invocationServerContextBrand]: true;
  readonly #protectedMemoryRepository:
    | ProtectedAgentMemoryRepository
    | undefined;
  readonly #protectedMemorySearch: ProtectedAgentMemorySearchPort | undefined;
  readonly #protectedMemoryAccessPort: ProtectedAgentMemoryAccessPort | undefined;
  readonly #protectedMemoryProjectionPort:
    | ProtectedAgentMemoryProjectionPort
    | undefined;
  readonly #protectedMemoryScopeLifecyclePort:
    | ProtectedAgentMemoryScopeLifecyclePort
    | undefined;
  readonly #recallRecordsPort: RecallRecordsPort | undefined;
  readonly #fullEncryptionOnly: boolean;
  readonly #ordinaryContentAccess: OrdinaryContentAccessSelection | undefined;

  constructor(
    readonly state: NautiloState,
    readonly authorityResolver: InvocationAuthorityResolver,
    options: ServerToolInvocationContextOptions,
  ) {
    this.#ordinaryContentAccess = options.ordinaryContentAccess;
    this.#recallRecordsPort = options.recallRecordsPort;
    this.#fullEncryptionOnly = options.fullEncryptionOnly === true;
    this.#protectedMemoryRepository = options.protectedMemoryRepository;
    this.#protectedMemorySearch = options.protectedMemorySearch;
    this.#protectedMemoryAccessPort = options.protectedMemoryAccessPort;
    this.#protectedMemoryProjectionPort = options.protectedMemoryProjectionPort;
    this.#protectedMemoryScopeLifecyclePort =
      options.protectedMemoryScopeLifecyclePort;
    invocationServerContexts.add(this);
    Object.freeze(this);
  }

  protectedMemoryRepository(): ProtectedAgentMemoryRepository | undefined {
    return this.#protectedMemoryRepository;
  }

  protectedMemorySearch(): ProtectedAgentMemorySearchPort | undefined {
    return this.#protectedMemorySearch;
  }

  protectedMemoryAccessPort(): ProtectedAgentMemoryAccessPort | undefined {
    return this.#protectedMemoryAccessPort;
  }

  protectedMemoryProjectionPort(): ProtectedAgentMemoryProjectionPort | undefined {
    return this.#protectedMemoryProjectionPort;
  }

  protectedMemoryScopeLifecyclePort():
  ProtectedAgentMemoryScopeLifecyclePort | undefined {
    return this.#protectedMemoryScopeLifecyclePort;
  }

  recallRecordsPort(): RecallRecordsPort | undefined {
    return this.#recallRecordsPort;
  }

  fullEncryptionOnly(): boolean {
    return this.#fullEncryptionOnly;
  }

  ordinaryContentAccess(): OrdinaryContentAccessSelection | undefined {
    return this.#ordinaryContentAccess;
  }
}

/**
 * Internal server adapter. This is intentionally not exported from the agent
 * package root: only trusted server/node composition may turn graph authority
 * into an invocation context.
 */
export function createServerToolInvocationContext(
  state: NautiloState,
  authorityResolver: InvocationAuthorityResolver,
  options: ServerToolInvocationContextOptions = {},
): NautiloToolInvocationServerContext {
  return new ServerToolInvocationContext(state, authorityResolver, options);
}

export interface NautiloToolInvocationSession {
  invoke(call: NautiloToolInvocationCall): Promise<NautiloToolInvocationResult>;
  snapshot(): NautiloToolInvocationSnapshot;
}

function validateInvocationCall(value: NautiloToolInvocationCall): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_tool_invocation_call");
  }
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "args,authorityRef,callId,toolName") {
    throw new Error("invalid_tool_invocation_call");
  }
  if (
    typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    typeof value.toolName !== "string" ||
    value.toolName.length === 0 ||
    typeof value.authorityRef !== "string" ||
    value.authorityRef.length === 0 ||
    !value.args ||
    typeof value.args !== "object" ||
    Array.isArray(value.args)
  ) {
    throw new Error("invalid_tool_invocation_call");
  }
}

export function readToolInvocationStatus(
  tm: ToolMessage,
): "success" | "error" | null {
  return readToolMessageStatus(tm);
}

export function createNautiloToolInvocationSession(
  serverContext: NautiloToolInvocationServerContext,
  config?: RunnableConfig,
): NautiloToolInvocationSession {
  if (
    !serverContext ||
    typeof serverContext !== "object" ||
    !invocationServerContexts.has(serverContext)
  ) {
    throw new Error("invalid_tool_invocation_server_context");
  }
  const trustedContext = serverContext as ServerToolInvocationContext;
  const state = trustedContext.state;
  const protectedMemoryRepository =
    trustedContext.protectedMemoryRepository();
  const protectedMemorySearch = trustedContext.protectedMemorySearch();
  const protectedMemoryAccessPort = trustedContext.protectedMemoryAccessPort();
  const protectedMemoryProjectionPort =
    trustedContext.protectedMemoryProjectionPort();
  const protectedMemoryScopeLifecyclePort =
    trustedContext.protectedMemoryScopeLifecyclePort();
  const recallRecordsPort = trustedContext.recallRecordsPort();
  const fullEncryptionOnly = trustedContext.fullEncryptionOnly();
  const ordinaryContentAccess = trustedContext.ordinaryContentAccess();
  const ordinaryContentAccessErrors = new Set<string>();
  const ordinaryContentAccessRetryRequired = new Set<string>();
  const recallRecordsContext = recallRecordsToolContextForState(
    state,
    recallRecordsPort,
  );

  const catalog = getToolCatalog();
  if (!catalog) throw new Error("ToolCatalog not initialized");
  const catalogChecked = catalog;

  const runtimeConfig = fromRuntimeConfig();
  const securityLevel: SecurityLevel = runtimeConfig.nautilo_security_level;
  // Tool execution consumes the model chosen by the graph; it does not select
  // or invoke a provider. Use the shared policy ID only for capability
  // projection when legacy/test state omitted that already-selected ID.
  const requestedModelId = modelIdForCapabilityProjection(
    "chat",
    state.model || runtimeConfig.nautilo_model,
  );

  // Shared engaged-skill set for this turn's tool
  // execution. Seeded from checkpointed state; `view_skill` engages, `eject`
  // clears. Persisted back below so the next pre-model rebuild re-injects only
  // the still-engaged bodies from graph state.
  const engagedSkills = createEngagedSkillsHandle(state.engagedSkillNames ?? []);
  const isGuest = state.actorRole === "guest";
  const activatedToolNames = selectedActivatedToolNamesForActor(
    state.actorRole,
    state.activatedToolNames,
  );
  // A guest may execute core tools but gets an empty mutable activation
  // surface: a forged meta-tool call cannot observe or mutate an owner's
  // selection/lease checkpoint on a shared graph thread.
  const activatedTools = createActivatedToolsHandle(
    activatedToolNames,
    undefined,
    isGuest ? [] : state.activatedToolLeases ?? [],
    runtimeConfig.nautilo_tool_activation_retention_turns,
  );
  const activeModelCapabilities = (["image", "file"] as const).filter(
    (capability) => modelSupportsInput(requestedModelId, capability),
  );
  const applyPatchContext = buildApplyPatchToolContext(
    {
      ownerId: state.userId,
      actorRole: state.actorRole,
      agentId: state.agentId,
      turnId: state.turnId,
      roomId: state.roomId,
      memoryAccessEnvelope: state.memoryAccessEnvelope,
      currentFolder: state.currentFolder ?? "",
      currentFolderRelayId: state.currentFolderRelayId ?? "",
      focusedResources: state.focusedResources ?? [],
    },
    { relayRegistry: _relayRegistry },
  );
  const resolveToolMap = (toolCallId: string, invocationCall: NautiloState["approvedToolCalls"][number]) => {
    const tools = resolveToolsForExposure(
      catalog,
      runtimeConfig.nautilo_tool_exposure_mode,
      {
        context: {
          ownerId: state.userId,
          personaId: state.personaId,
          currentThreadId: state.currentThreadId,
          voiceMode: state.voiceMode,
          memoryAccessEnvelope: state.memoryAccessEnvelope,
          actorRole: state.actorRole,
          auditActorId: state.memoryAccessEnvelope?.actorId ?? null,
          securityAuditClientMeta: state.securityAuditClientMeta,
          currentFolder: state.currentFolder,
          workspacePath: state.workspacePath,
          userTimezone: state.userTimezone,
          userId: state.userId,
          agentId: state.agentId,
          roomId: state.roomId,
          callingRoomId: state.callingRoomId,
          currentTaskId: state.currentTaskId,
          currentTaskRunId: state.currentTaskRunId,
          turnId: state.turnId,
          toolCallId,
          signal: config?.signal,
          browserDecision: currentBrowserDecision(state),
          browserDecisionCall: invocationCall,
          browserDecisionSingleton: [...state.messages].reverse().find((message) => AIMessage.isInstance(message))?.tool_calls?.length === 1,
          browserHistoryMessages: state.messages,
          ordinaryContentAccessRequired: ordinaryContentAccess?.mode === "plaintext_only",
          ...(ordinaryContentAccess?.mode !== "plaintext_only" ? {} : {
            ordinaryContentAccess: {
              async commit() {
                const result = await bindOrdinaryContentAccessExecution(
                  state,
                  state.approvedToolCalls.find((call) => call.id === toolCallId) ?? { id: toolCallId, name: "", args: {} },
                  state.ordinaryContentAccessBindings?.[toolCallId],
                  ordinaryContentAccess.port,
                ).commit();
                if (result.status === "error") ordinaryContentAccessErrors.add(toolCallId);
                if (result.recovery === "retry_same_call") ordinaryContentAccessRetryRequired.add(toolCallId);
                return result;
              },
            },
          }),
          // Connected-web admission binds one provider run to the exact
          // trusted delivery/thread/lane; these are not model arguments.
          laneKey: resolveLaneKey(state),
          liveMiniAppSession: effectiveLiveMiniAppSessionForState(state),
          turnContextId: turnContextKey(state.turnId, state.agentId),
          subagentDepth: state.subagentDepth,
          subagentMaxDepth: state.subagentMaxDepth,
          roomRoster: state.roomRoster,
          activeModelId: requestedModelId,
          // Task continuation is derived from canonical paired receipts; the
          // model never needs to copy a long opaque cursor. Parallel reads
          // share the complete prepared request's remaining page workspace.
          taskReadMessages: state.messages,
          taskReadPendingPages: state.taskReadPendingPages ?? [],
          taskReadMaxResponseBytes: state.taskReadPageBytes == null ? undefined : Math.floor(state.taskReadPageBytes / Math.max(1,
            [...state.messages].reverse().find((message) => AIMessage.isInstance(message))?.tool_calls?.filter((call) =>
              call.name === "task" && call.args["command"] === "read").length ?? 0)),
          relayCapabilities: state.relayCapabilities,
          // Focused-resource consumers such as ask_peer need the authoritative
          // per-turn manifest, not just the apply_patch router derived from it.
          focusedResources: state.focusedResources ?? [],
          connectedAppProviderIds: state.connectedAppProviderIds ?? [],
          verifiedOrdinaryOrigin: state.verifiedOrdinaryOrigin,
          taskReportBackContinuation: state.taskReportBackContinuation,
          toolWhitelist: state.toolWhitelist,
          engagedSkills,
          activatedTools,
          activatedToolNames: activatedTools.snapshotNames(),
          readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
          activeModelCapabilities,
          trustedExecutionEntrypoint: state.trustedExecutionEntrypoint,
          deepResearchForegroundAvailable: deepResearchReturnContextForState(state) !== null,
          initiatingClientSurface: getCurrentInitiatingClientSurface(),
          ...recallRecordsContext,
          browserResearchExecutionPort: createBrowserResearchExecutionPort({
            ownerId: state.userId,
            actorRole: state.actorRole,
            verifiedOrdinaryOrigin: state.verifiedOrdinaryOrigin,
            relayRegistry: _relayRegistry,
            toolCallId,
            laneKey: resolveLaneKey(state),
            ...(state.turnId ? { turnId: state.turnId } : {}),
            ...(state.agentId ? { authorAgentId: state.agentId } : {}),
          }),
          ...(protectedMemoryRepository === undefined
            ? {}
            : { protectedMemoryRepository }),
          ...(protectedMemorySearch === undefined
            ? {}
            : { protectedMemorySearch }),
          ...(protectedMemoryAccessPort === undefined
            ? {}
            : { protectedMemoryAccessPort }),
          ...(protectedMemoryProjectionPort === undefined
            ? {}
            : { protectedMemoryProjectionPort }),
          ...(protectedMemoryScopeLifecyclePort === undefined
            ? {}
            : { protectedMemoryScopeLifecyclePort }),
          ...applyPatchContext,
        },
        toolPolicy: state.memoryAccessEnvelope?.toolPolicy,
        relayCapabilities: state.relayCapabilities ?? undefined,
        readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
        activeModelCapabilities,
        toolNameWhitelist: state.toolWhitelist,
        activatedToolNames: activatedTools.snapshotNames(),
        fullEncryptionOnly,
      },
    ).tools;
    return new Map(tools.map((tool) => [tool.name, tool]));
  };

  // 2a.1.11 / chrome-bundle follow-up — emit tool.start + tool.end
  // events over the WS event bus so the workbench Activity tab,
  // cited-file glyph, and future ToolCard primitive have a lifecycle
  // to render. Previously only LangGraph-native `on_tool_start` /
  // `on_tool_end` events were translated (via processStreamEvent), but
  // this custom tools node dispatches through the relay — which
  // bypasses LangGraph's built-in tool tracing entirely. Without the
  // explicit emits, the UI had NO telemetry about tool execution.
  //
  // The tracker is local to this node invocation; per-tool
  // lifecycles. Tool IDs are stable across start/end so the UI can
  // correlate (activity-tab does exactly this).
  const toolTracker = new AgentToolCallTracker(
    resolveLaneKey(state),
    state.agentId ?? undefined,
    state.turnId || undefined,
  );
  const allowToolTelemetry = !state.suppressToolLifecycleEvents;
  const taskCreationRelayId = state.verifiedOrdinaryOrigin?.kind === "local_electron"
    ? state.verifiedOrdinaryOrigin.relayId
    : null;
  const taskCreationRelaySessionId = taskCreationRelayId === null
    ? null
    : _relayRegistry?.getRelaySessionId?.(taskCreationRelayId);
  const taskCreationBrowserSessionId = taskCreationRelayId === null
    ? null
    : _relayRegistry?.getCapabilities(taskCreationRelayId)?.browserSessionId;
  const taskCreationReturnContext = taskCreationReturnContextForState(
    state,
    taskCreationRelaySessionId,
    taskCreationBrowserSessionId,
  );
  const taskCreationLiveMiniAppContext = taskCreationLiveMiniAppContextForState(state);
  const taskCreationBackgroundTaskProvenance = taskCreationBackgroundTaskProvenanceForState(state);
  const deepResearchReturnContext = deepResearchReturnContextForState(state);

  async function runApprovedToolCall(
    tc: NonNullable<NautiloState["approvedToolCalls"]>[number],
  ): Promise<ToolMessage> {
      // Eligibility is intentionally re-resolved for every dispatch. An old
      // admission receipt can prove approval provenance, but cannot resurrect
      // a tool removed by current actor/catalog/model/relay policy.
      const toolCallId = tc.id ?? `${tc.name}_${Date.now()}`;
      const connectedPlan = tc.name === "control_connected_web_operation" ? interpretBrowserDecisionCall(tc) : null;
      if (connectedPlan?.kind === "invalid") {
        const tm = new ToolMessage({
          content: browserDecisionPlanError(connectedPlan.error, connectedPlan.code,
            connectedPlan.instruction.replaceAll("browser_snapshot", "control_connected_web_operation snapshot")),
          tool_call_id: toolCallId, name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }
      const connectedArgs = tc.args as Record<string, unknown>;
      const invocationArgs = connectedPlan?.kind === "plan" ? {
        operationId: connectedArgs["operationId"], expectedControlEpoch: connectedArgs["expectedControlEpoch"],
        command: connectedArgs["command"], decisionPlan: connectedPlan.plan,
      } : tc.args;
      if (state.ordinaryContentAccessBindings?.[toolCallId] && ordinaryContentAccess?.mode !== "plaintext_only") {
        const tm = new ToolMessage({
          content: JSON.stringify({ error: "content_access_policy_changed", recovery: "prepare_new_call", message: ORDINARY_CONTENT_ACCESS_RECOVERY }),
          tool_call_id: toolCallId, name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }
      const catalogEntry = catalogChecked.get(tc.name);
      if (fullEncryptionOnly && catalogEntry?.fullEncryptionSupport !== "supported") {
        const tm = new ToolMessage({
          content: "Error: This tool is unavailable while Full encryption is active.",
          tool_call_id: toolCallId,
          name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }
      const missingFullProtectedPort = fullEncryptionOnly && (
        (tc.name === "search_memory"
          && protectedMemorySearch === undefined
          && protectedMemoryRepository === undefined)
        || (tc.name === "manage_memory"
          && protectedMemoryRepository === undefined)
        || (tc.name === "share_memory"
          && (isProjectionLikeShareCall(tc)
            ? protectedMemoryProjectionPort === undefined
            : protectedMemoryAccessPort === undefined))
        || (tc.name === "recall_records" && recallRecordsPort === undefined)
      );
      if (missingFullProtectedPort) {
        const tm = new ToolMessage({
          content: "Error: Protected tool access is unavailable while Full encryption is active.",
          tool_call_id: toolCallId,
          name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }
      const toolMap = resolveToolMap(toolCallId, tc);
      const tool = toolMap.get(tc.name);

      if (!tool) {
        const unavailableReason = state.actorRole === "guest" ||
            state.memoryAccessEnvelope?.toolPolicy?.[tc.name] === "forbidden"
          ? null
          : catalogChecked.getUnavailableReasonForExposure(tc.name, {
              context: {
                connectedAppProviderIds: state.connectedAppProviderIds ?? [],
                deepResearchForegroundAvailable: deepResearchReturnContextForState(state) !== null,
              },
              toolPolicy: state.memoryAccessEnvelope?.toolPolicy,
              relayCapabilities: state.relayCapabilities ?? undefined,
              readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
              activeModelCapabilities,
              toolNameWhitelist: state.toolWhitelist,
              activatedToolNames: runtimeConfig.nautilo_tool_exposure_mode === "progressive"
                ? activatedTools.snapshotNames()
                : [...activatedTools.snapshotNames(), tc.name],
              fullEncryptionOnly,
            });
        if (unavailableReason !== null) {
          warn(`[nautilo/tools] Tool prerequisite unavailable: ${formatToolLogLabel(tc)}`);
          const tm = new ToolMessage({
            content: `Error: ${unavailableReason}`,
            tool_call_id: toolCallId,
            name: tc.name,
          });
          assignStableToolMessageId(tm);
          setToolMessageStatus(tm, "error");
          return tm;
        }
        warn(`[nautilo/tools] Unknown tool: ${formatToolLogLabel(tc)}`);
        // No tool.start/end for unknown tools — nothing actually
        // ran. The agent will see the error ToolMessage and decide
        // how to recover.
        const tm = new ToolMessage({
          content: `Error: Unknown tool "${tc.name}"`,
          tool_call_id: toolCallId,
          name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }

      const missingProtectedPort = protectedMemoryRepository !== undefined
        && (
          (tc.name === "share_memory"
            && (isProjectionLikeShareCall(tc)
              ? protectedMemoryProjectionPort === undefined
              : protectedMemoryAccessPort === undefined))
          || (["create_scope", "add_memory_to_scope", "close_scope"].includes(tc.name)
            && protectedMemoryScopeLifecyclePort === undefined)
        );
      if (missingProtectedPort) {
        const tm = new ToolMessage({
          content:
            "Error: encrypted Memory access-set support is not ready for this operation.",
          tool_call_id: toolCallId,
          name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }

      // --- Security validation before execution ---
      const recoveryBlocked = researchContextRecoveryToolError(state, tc.name, tc.args);
      const blocked = recoveryBlocked ?? validateBeforeExecution(tc.name, tc.args, securityLevel);
      if (blocked) {
        // Historical paging corrections use the same display-safe receipt as
        // local reader failures, so task cards show the actual next action.
        // A malformed nonlocal operation cannot execute or resolve recovery.
        // Report its exact shape error before prescribing more recovery work;
        // a valid operation remains blocked. Handoff shape parsing is also pure;
        // its authority, checkpoint and transition checks stay at execution.
        const handoffRequest = recoveryBlocked && tc.name === "security_scan" && tc.args["operation"] === "handoff"
          ? parseResearchHandoffRequest(tc.args) : null;
        const parsed = recoveryBlocked && tc.name === "security_scan"
          && tc.args["operation"] !== "context" && tc.args["operation"] !== "handoff"
          ? parseSecurityScanOperationRequest(tc.args, state, latestSecurityScanResultsCursor(state.messages, tc.args)) : null;
        const blockedContent = handoffRequest?.ok === false
          ? localToolControlFailure(tc.name, tc.args, "invalid_request", handoffRequest.errorMessage)
          : parsed?.ok === false ? parsed.errorMessage : recoveryBlocked
          ? localToolControlFailure(tc.name, tc.args, "context_recovery_pending", blocked, researchRuntimeRecoveryFacts(state))
          : blocked;
        // Emit start+end as a pair so the UI records the attempt —
        // "we tried to run X, it was blocked before execution." Gives
        // the user visible feedback even for blocked calls.
        if (allowToolTelemetry) {
          emitAgentEvent(toolTracker.toolStart(toolCallId, tc.name, sanitizeToolCallArgsForEvent(tc, state)));
          emitAgentEvent(
            toolTracker.toolEnd(toolCallId, tc.name, "error", blockedContent),
          );
        }
        const tm = new ToolMessage({
          content: blockedContent,
          tool_call_id: toolCallId,
          name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }

      // execution, not selection, renews residency. This is after the
      // executable tool-map lookup and pre-execution security gate, and before
      // relay/cloud dispatch so ordinary executor and result-scan failures
      // still retain a concrete eligible deferred tool for the next turn.
      if (!isGuest && catalogEntry?.exposure === "discoverable") {
        activatedTools.renew(tc.name);
      }

      const localResearchContext = tc.name === "security_scan" && tc.args["operation"] === "context";
      const localResearchHandoff = tc.name === "security_scan" && tc.args["operation"] === "handoff";
      const policy = resolveExecutionPolicy(tc.name, catalogChecked);
      const effectiveHostScope = resolveToolCallHostScope({
        classified: policy.hostScope,
        toolName: tc.name,
        args: (tc.args ?? {}) as Record<string, unknown>,
        currentFolder: state.currentFolder ?? "",
      });
      if (!localResearchContext && !localResearchHandoff && effectiveHostScope === "required" && !isSupportedComputerUseToolName(tc.name)) {
        const requiredRelayId = tc.id ? state.requiredHostRelays?.[tc.id] : undefined;
        if (
          (!state.verifiedOrdinaryOrigin
            && !hasAvailableTaskReportBackContinuation(state.taskReportBackContinuation))
          || !requiredRelayId
        ) {
          const message = `Error: ${tc.name} requires a verified request and exact authorized computer selection.`;
          if (allowToolTelemetry) {
            emitAgentEvent(toolTracker.toolStart(toolCallId, tc.name, sanitizeToolCallArgsForEvent(tc, state)));
            emitAgentEvent(toolTracker.toolEnd(toolCallId, tc.name, "error", message));
          }
          const tm = new ToolMessage({ content: message, tool_call_id: toolCallId, name: tc.name });
          assignStableToolMessageId(tm);
          setToolMessageStatus(tm, "error");
          return tm;
        }
      }

      // Fire tool.start BEFORE execution so the UI can render
      // "running…" state for the duration. toolTracker stashes
      // startTime internally; toolEnd uses it to compute duration.
      if (allowToolTelemetry) {
        emitAgentEvent(toolTracker.toolStart(toolCallId, tc.name, sanitizeToolCallArgsForEvent(tc, state)));
      }

      try {
        // Resolve the raw execution output (as a string) from either the
        // cloud executor or the relay dispatch path. Both paths then flow
        // through a single scanToolResult call below — security policy is
        // applied once, regardless of executor. Relays are dumb executors;
        // the scan is the server's responsibility. See .
        let rawContent: string;
        // explicit file-result status, captured
        // out-of-band around the cloud `file` invocation (see
        // `file-result-status.ts`). Default "success"; only the cloud
        // `file` path flips it via a `fileToolError` marker inside the
        // handler. Relay-executor tools keep "success" here (their
        // errors surface through `relayResult.ok === false` above).
        let fileStatus: FileResultStatus = "success";
        // Delivery can succeed while the typed domain operation fails. Keep
        // its complete receipt but stamp failure for UI and no-progress truth.
        let relayToolError: string | null = null;
        let projectionError: "stale" | "idempotency_conflict" | "missing_snapshot" | null = null;

        if (localResearchHandoff) {
          const receipt = performResearchHandoff(state, tc.args);
          rawContent = JSON.stringify(receipt);
          if (!receipt.ok) fileStatus = "error";
        } else if (localResearchContext) {
          // This reads only the current trusted canonical TaskRun history. It
          // stays inside ordinary admission, result scanning and Shadow protection.
          const latestModelMessage = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
          const parallelContextReads = latestModelMessage?.tool_calls?.filter((call) =>
            call.name === "security_scan" && call.args["operation"] === "context").length || 1;
          const page = readResearchContext(state, tc.args, {
            runtimeRecovery: researchRuntimeRecoveryFacts(state),
            // The allowance belongs to the entire tool batch. Parallel reads
            // share it rather than each consuming the next whole workspace.
            maxPageBytes: Math.floor((state.researchContextPageBytes ?? Math.floor(
              getModelTokenLimit(state.model || requestedModelId) * runtimeConfig.nautilo_token_budget_fraction,
            )) / parallelContextReads),
          });
          rawContent = JSON.stringify(page);
          if (!page.ok) fileStatus = "error";
        } else if (tc.name === "share_memory" && isProjectionLikeShareCall(tc)) {
          const snapshot = findProjectionSnapshot(state, tc);
          if (!snapshot) {
            projectionError = "missing_snapshot";
            rawContent = JSON.stringify({
              error: "Projected Memory approval is missing its trusted snapshot; nothing was created.",
            });
          } else {
            const result = await executeTrustedProjection(
              snapshot,
              state,
              protectedMemoryProjectionPort,
            );
            rawContent = result.status === "success"
              ? `${result.message}\nMemory ID: ${result.memoryId}`
              : JSON.stringify({ error: result.message });
            if (result.status !== "success") projectionError = result.status;
          }
        } else if (policy.executor === "relay") {
          const relayResult = await executeViaRelayRaw(tc, policy, state, {
            toolCallId, fullEncryptionOnly,
            // provenance must retain the actual Task-selected model.
            // `requestedModelId` is only a capability-projection fallback and
            // can name a built-in candidate that the Task never selected.
            ...(tc.name === "security_scan" && state.model?.trim()
              ? { resolvedModelId: state.model.trim() }
              : {}),
            ...(config?.signal ? { signal: config.signal } : {}),
          });
          if (!relayResult.ok) {
            const denial = relayResult.networkDenied ?? null;
            if (denial !== null) {
              const approvedRetry = await handleNetworkApprovalAndRetry(
                tc,
                policy,
                state,
                denial,
                toolCallId,
                config?.signal,
                fullEncryptionOnly,
              );
              if (approvedRetry.ok) {
                if ("multimodal" in approvedRetry) {
                  const entry = catalogChecked.get(tc.name);
                  const scanPolicy = entry?.resultScanPolicy ?? "never";
                  const scanned = scanToolResult(tc.name, approvedRetry.multimodal.text, {
                    scanPolicy,
                    securityLevel,
                    stripInvisibleUnicode: entry?.scanInvisibleUnicode === "strip",
                  });
                  if (scanned.blocked) {
                    warn(`[nautilo/tools] Text content from multimodal ${formatToolLogLabel(tc)} BLOCKED: ${scanned.threats.join(", ")}`);
                    const tm = new ToolMessage({
                      content: scanned.content,
                      tool_call_id: toolCallId,
                      name: tc.name,
                    });
                    assignStableToolMessageId(tm);
                    setToolMessageStatus(tm, "error");
                    if (allowToolTelemetry) {
                      emitAgentEvent(
                        toolTracker.toolEnd(
                          toolCallId,
                          tc.name,
                          "error",
                          BLOCKED_CONTENT_USER_MESSAGE,
                          scanned.content,
                        ),
                      );
                    }
                    return tm;
                  }
                  const { tm, contentForEvent } = buildRelayMultimodalToolMessage(
                    tc,
                    toolCallId,
                    { ...approvedRetry.multimodal, text: scanned.content },
                  );
                  if (allowToolTelemetry) {
                    emitAgentEvent(
                      toolTracker.toolEnd(toolCallId, tc.name, "success", undefined, contentForEvent),
                    );
                  }
                  return tm;
                }
                rawContent = approvedRetry.rawContent;
                relayToolError = approvedRetry.toolError ?? null;
              } else {
                if (allowToolTelemetry) {
                  emitAgentEvent(
                    toolTracker.toolEnd(toolCallId, tc.name, "error", approvedRetry.errorMessage),
                  );
                }
                const tm = new ToolMessage({
                  content: approvedRetry.errorMessage,
                  tool_call_id: toolCallId,
                  name: tc.name,
                });
                assignStableToolMessageId(tm);
                setToolMessageStatus(tm, "error");
                return tm;
              }
            } else {
            // Policy-decision errors (no registry / no relay / relay-returned
            // error / dispatch threw) are server-generated strings and
            // bypass scanning — same semantics as the cloud path's
            // catch-block errors below.
            const safeRelayError = redactSecrets(relayResult.errorMessage).text;
            // ( / ) — in a background/async Task run there is no
            // present human to relay a "connect your relay" tool message to.
            // When the relay vanished mid-run (`relayUnavailable`), fail the
            // whole run with a recognizable `relay_unavailable` error rather
            // than letting the agent shrug it off and continue cloud-only. The
            // throw is re-raised past the tool-error catch below and propagates
            // out of `runScopeSubagentUntilPause` to `taskRunExecutor`, which
            // routes it through `reportBackTaskError`. Foreground / in-chat
            // scope runs (`taskRun` false) keep the existing tool-message UX.
            if (state.taskRun && relayResult.relayUnavailable) {
              if (allowToolTelemetry) {
                emitAgentEvent(
                  toolTracker.toolEnd(
                    toolCallId,
                    tc.name,
                    "error",
                    safeRelayError,
                    undefined,
                    relayResult.runShellOutcome,
                  ),
                );
              }
              // Security ledger writes have durable tool-call receipts. Reads have no effects.
              // Other dispatched mutations retain their existing unknown-outcome handling.
              if (tc.name === "security_scan" || (tc.name === "file" && ["read", "list", "grep"].includes(String(tc.args["command"])))) {
                assertResearchDesktopAvailable(state);
              }
              throw new RelayUnavailableError(safeRelayError);
            }
            if (allowToolTelemetry) {
              emitAgentEvent(
                toolTracker.toolEnd(
                  toolCallId,
                  tc.name,
                  "error",
                  safeRelayError,
                  undefined,
                  relayResult.runShellOutcome,
                ),
              );
            }
            const tm = new ToolMessage({
              content: safeRelayError,
              tool_call_id: toolCallId,
              name: tc.name,
              ...(relayResult.browserFailure ? { additional_kwargs: { nautilo_browser_failure: relayResult.browserFailure } } : {}),
            });
            assignStableToolMessageId(tm);
            setToolMessageStatus(tm, "error");
            return tm;
            }
          } else if ("multimodal" in relayResult) {
            const entry = catalogChecked.get(tc.name);
            const scanPolicy = entry?.resultScanPolicy ?? "never";
            const scanned = scanToolResult(tc.name, relayResult.multimodal.text, {
              scanPolicy,
              securityLevel,
              stripInvisibleUnicode: entry?.scanInvisibleUnicode === "strip",
            });
            if (scanned.blocked) {
              warn(`[nautilo/tools] Text content from multimodal ${formatToolLogLabel(tc)} BLOCKED: ${scanned.threats.join(", ")}`);
              const tm = new ToolMessage({
                content: scanned.content,
                tool_call_id: toolCallId,
                name: tc.name,
              });
              assignStableToolMessageId(tm);
              setToolMessageStatus(tm, "error");
              if (allowToolTelemetry) {
                emitAgentEvent(
                  toolTracker.toolEnd(
                    toolCallId,
                    tc.name,
                    "error",
                    BLOCKED_CONTENT_USER_MESSAGE,
                    scanned.content,
                  ),
                );
              }
              return tm;
            }
            const { tm, contentForEvent } = buildRelayMultimodalToolMessage(
              tc,
              toolCallId,
              { ...relayResult.multimodal, text: scanned.content },
            );
            if (allowToolTelemetry) {
              emitAgentEvent(
                toolTracker.toolEnd(toolCallId, tc.name, "success", undefined, contentForEvent),
              );
            }
            return tm;
          } else {
            rawContent = relayResult.rawContent;
            relayToolError = relayResult.toolError ?? null;
          }
        } else if (
          tc.name === "manage_local_mcp" &&
          tc.args["action"] === "install"
        ) {
          // no model-provided request reaches the launch service here.
          // Post-model replaced the args with an opaque approval binding, and
          // the service refuses a missing/stale/tampered receipt.
          const approvalId = typeof tc.args["approvalId"] === "string"
            ? tc.args["approvalId"]
            : "";
          const digest = typeof tc.args["digest"] === "string"
            ? tc.args["digest"]
            : "";
          const prepared: unknown = tc.args["prepared"] as unknown;
          const result = isCheckpointLocalMcpInstallPrepared(prepared)
            ? await getLocalMcpToolRuntime().install(
              { userId: state.userId },
              { prepared, approvalId, toolCallId: tc.id ?? "", digest },
            )
            : {
              ok: false,
              name: "local-mcp",
              relayId: "",
              digest,
              failure: localMcpInstallFailure("approval_stale"),
            };
          rawContent = JSON.stringify(result);
        } else if (tc.name === "generate_video" && tc.args["action"] === "prepare") {
          // This is the unified tool's deterministic, no-spend workcard path.
          // Post-model admits only the strict schema shape; provider execution
          // remains impossible without the separate prepared approval binding.
          rawContent = String(await tool.invoke(tc.args, {
            ...config,
            configurable: { ...(config?.configurable ?? {}) },
          }));
        } else if (tc.name === "generate_video" || tc.name === "generate_music") {
          const approvalId = typeof tc.args["approvalId"] === "string" ? tc.args["approvalId"] : "";
          const receiptId = typeof tc.args["receiptId"] === "string" ? tc.args["receiptId"] : "";
          const digest = typeof tc.args["digest"] === "string" ? tc.args["digest"] : "";
          const quoteDigest = typeof tc.args["quoteDigest"] === "string" ? tc.args["quoteDigest"] : "";
          const revision = typeof tc.args["revision"] === "number" ? tc.args["revision"] : 0;
          const prepared: unknown = tc.args["prepared"];
          const threadId = state.langgraphThreadId || state.currentThreadId;
          const laneKey = state.approvalLaneKey || "";
          const valid = verifyMediaGenerationPreparedApproval(prepared, {
            userId: state.userId,
            roomId: state.roomId,
            threadId,
            turnId: state.turnId,
            laneKey,
            toolCallId: tc.id ?? "",
            toolName: tc.name,
            approvalId,
            receiptId,
            digest,
            quoteDigest,
            revision,
          });
          const result = valid
            ? await submitMediaGenerationApproval(
              { userId: state.userId, roomId: state.roomId, agentId: state.agentId },
              {
                prepared,
                approvalId,
                receiptId,
                digest,
                quoteDigest,
                revision,
                toolCallId: tc.id ?? "",
              },
            )
            : createUnboundMediaGenerationFailure({
              toolName: tc.name,
              code: "APPROVAL_STALE",
              message: "This media approval is stale or does not match the prepared request. Request a fresh quote.",
            });
          rawContent = JSON.stringify(result);
        } else {
          log(`[nautilo/tools] Executing (cloud): ${formatToolLogLabel(tc)}`);
          // wrap cloud `file` invocations in the explicit
          // file-result-status capture so an out-of-band `fileToolError`
          // marker inside a `file` command handler carries the error
          // status to this node WITHOUT content guessing (no `Error:`
          // prefix sniffing, no JSON-envelope inference). Non-file
          // cloud tools bypass the capture; their status stays
          // "success" exactly as before. The capture is a single
          // AsyncLocalStorage context, so markers in deeply-nested
          // handlers (workspace dispatch, local-file dispatch,
          // staged-patch helpers) reach the same cell as long as they
          // are on the call chain that produces the final `file` result.
          const isFileTool = tc.name === "file";
          const invoke = () => runWithTaskCreationContexts(
            taskCreationReturnContext,
            taskCreationLiveMiniAppContext,
            taskCreationBackgroundTaskProvenance,
            () => runWithDeepResearchReturnContext(
              deepResearchReturnContext,
              () => tool.invoke(invocationArgs, {
                ...config,
                configurable: {
                  ...(config?.configurable ?? {}),
                  fileToolMutationRequestId: toolCallId,
                  memoryToolMutationRequestId: toolCallId,
                  connectedWebActionDeliveryId: toolCallId,
                },
              }),
            ),
          );
          const captured = isFileTool
            ? await captureFileToolResult(invoke)
            : null;
          const result: unknown = captured !== null ? captured.result : await invoke();
          if (isFileTool && captured !== null) {
            fileStatus = captured.status;
          }
          if (result instanceof ToolMessage) {
            const r = result;
            // non-string content (multimodal: image/PDF blocks)
            // can't ride the WS event's `result: string` field. The
            // tool may stash a structured summary on
            // `additional_kwargs.nautilo_event_summary` (JSON string)
            // for the workbench renderer to parse and render a
            // thumbnail. Fall back to the placeholder when no summary
            // was provided.
            let contentForEvent: string;
            if (typeof r.content === "string") {
              contentForEvent = r.content;
            } else {
              const summary = r.additional_kwargs?.["nautilo_event_summary"];
              contentForEvent =
                typeof summary === "string" ? summary : "[multimodal tool result]";
            }
            // the captured status drives the tool.end
            // event kind and the `nautilo_tool_status` marker. A
            // `file` multimodal read never calls `fileToolError`, so
            // `fileStatus` is "success" here; non-file tools default
            // to "success". The model-facing `content` is preserved
            // byte-for-byte. Emit is unconditional, matching the
            // pre- multimodal path.
            emitAgentEvent(
              toolTracker.toolEnd(
                toolCallId,
                tc.name,
                fileStatus,
                undefined,
                contentForEvent,
              ),
            );
            const tm = new ToolMessage({
              content: r.content,
              tool_call_id: toolCallId,
              name: tc.name,
              ...(r.additional_kwargs ? { additional_kwargs: r.additional_kwargs } : {}),
            });
            assignStableToolMessageId(tm);
            setToolMessageStatus(tm, fileStatus);
            return tm;
          }
          rawContent = typeof result === "string" ? result : JSON.stringify(result);
        }

        if (tc.name === "security_scan" && !localResearchContext && !localResearchHandoff && state.subagentRun) {
          try {
            const receipt = securityScanToolResultSchema.safeParse(JSON.parse(rawContent));
            if (receipt.success) rawContent = JSON.stringify({ ...receipt.data, runtimeRecovery: researchRuntimeRecoveryFacts(state) });
          } catch { /* Preserve malformed/error output for the ordinary pipeline. */ }
        }

        // --- Post-execution content scanning (applies to BOTH executors) ---
        // Look up the catalog entry for this tool to get its resultScanPolicy.
        const entry = catalogChecked.get(tc.name);
        const catalogScanPolicy = entry?.resultScanPolicy ?? "never";
        const scanPolicy =
          tc.name === "file"
            ? resolveFileToolResultScanPolicy(tc.args as FileToolRawArgs, catalogScanPolicy)
            : catalogScanPolicy;
        const scanned = scanToolResult(tc.name, rawContent, {
          scanPolicy,
          securityLevel,
          stripInvisibleUnicode: entry?.scanInvisibleUnicode === "strip",
        });

        if (scanned.blocked) {
          warn(`[nautilo/tools] Content from ${formatToolLogLabel(tc)} BLOCKED: ${scanned.threats.join(", ")}`);
          // audit — the client sees a single bounded,
          // human-safe reason and the safe replacement, never raw scanner
          // identifiers. Detailed identifiers remain in the warning above.
          if (allowToolTelemetry) {
            emitAgentEvent(
              toolTracker.toolEnd(
                toolCallId,
                tc.name,
                "error",
                BLOCKED_CONTENT_USER_MESSAGE,
                scanned.content,
              ),
            );
          }
          const tm = new ToolMessage({
            content: scanned.content,
            tool_call_id: toolCallId,
            name: tc.name,
          });
          assignStableToolMessageId(tm);
          setToolMessageStatus(tm, "error");
          return tm;
        }

        // Normal success path. Duration computed by toolTracker from
        // the startTime it stashed on toolStart above. the current implementation:
        // pass the scanned (post-security) content as the result so
        // the inline ToolCard can render real stdout / file content /
        // search matches instead of the legacy "Done (Xms)"
        // placeholder. Server-side cap lives in toolTracker
        // (TOOL_RESULT_MAX_BYTES); the ToolMessage going to the LLM
        // carries the full content regardless.
        //
        // the file-result status was captured
        // out-of-band around the cloud `file` invocation above (see
        // `captureFileToolResult`). An explicit `fileToolError`
        // marker inside a `file` command handler flips `fileStatus`
        // to "error"; the default is "success". There is no `Error:`
        // prefix sniffing or JSON-envelope inference.
        // Full model-facing content and the scan above are preserved
        // either way — only the status stamp + tool.end event kind
        // change for a captured file error. A successful `read`
        // whose actual file contents begin with `Error:` stays
        // "success" because the read handler never calls
        // `fileToolError` on the success-content path.
        let taskReadError = false;
        let connectedBrowserError = false;
        let connectedBrowserFailure: string | undefined;
        if (tc.name === "control_connected_web_operation") {
          // This tool owns a typed server result envelope; page text remains nested data.
          try {
            const receipt = JSON.parse(rawContent) as Record<string, unknown>;
            connectedBrowserError = receipt["ok"] === false || typeof receipt["error"] === "string";
            if (connectedBrowserError && typeof receipt["browserFailure"] === "string") connectedBrowserFailure = receipt["browserFailure"];
          } catch { connectedBrowserError = true; }
        }
        if (ordinaryContentAccessRetryRequired.has(toolCallId)) throw new OrdinaryContentAccessRetryRequiredError();
        if (tc.name === "task" && tc.args["command"] === "read") {
          try { taskReadError = isTaskReadErrorReceipt(JSON.parse(rawContent)); } catch { /* Not a typed Task read receipt. */ }
        }
        if (fileStatus === "error" || projectionError !== null || relayToolError !== null || taskReadError || connectedBrowserError || ordinaryContentAccessErrors.has(toolCallId)) {
          if (allowToolTelemetry) {
            emitAgentEvent(
              toolTracker.toolEnd(
                toolCallId,
                tc.name,
                "error",
                projectionError ?? relayToolError ?? undefined,
                scanned.content,
              ),
            );
          }
          const tm = new ToolMessage({
            content: scanned.content,
            tool_call_id: toolCallId,
            name: tc.name,
            ...(connectedBrowserFailure ? { additional_kwargs: { nautilo_browser_failure: connectedBrowserFailure } } : {}),
          });
          assignStableToolMessageId(tm);
          setToolMessageStatus(tm, "error");
          return tm;
        }

        if (allowToolTelemetry) {
          emitAgentEvent(
            toolTracker.toolEnd(
              toolCallId,
              tc.name,
              "success",
              undefined,
              scanned.content,
            ),
          );
        }

        const tm = new ToolMessage({
          content: projectSemanticComputerResult(tc.name, scanned.content),
          tool_call_id: toolCallId,
          name: tc.name,
          additional_kwargs: computerResultDurableSidecar(tc.name, scanned.content),
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "success");
        return tm;
      } catch (error) {
        if (isGraphBubbleUp(error)) throw error;
        if (error instanceof OrdinaryContentAccessRetryRequiredError) throw error;
        // Strict Shadow failures are crypto-boundary control flow, not an
        // ordinary tool error the model may receive and continue past.
        if (error instanceof StrictShadowEnforcementError) throw error;
        // a Task-run relay-drop must propagate (it fails the run via
        // reportBackTaskError); do NOT swallow it into a recoverable
        // ToolMessage the agent could ignore. Foreground never throws this.
        if (error instanceof RelayUnavailableError) throw error;

        const msg = redactSecrets(error instanceof Error ? error.message : String(error)).text;
        warn(`[nautilo/tools] Tool ${formatToolLogLabel(tc)} failed: ${msg}`);
        if (allowToolTelemetry) {
          emitAgentEvent(toolTracker.toolEnd(toolCallId, tc.name, "error", msg));
        }
        const tm = new ToolMessage({
          content: `Error executing ${tc.name}: ${msg}`,
          tool_call_id: toolCallId,
          name: tc.name,
        });
        assignStableToolMessageId(tm);
        setToolMessageStatus(tm, "error");
        return tm;
      }
  }

  const focusedHints = buildFocusedLocalFileHints(state.focusedResources);
  const invokeOne = async (
    call: NautiloToolInvocationCall,
  ): Promise<NautiloToolInvocationResult> => {
      validateInvocationCall(call);
      assertResearchDesktopAvailable(state);
      const authority = await trustedContext.authorityResolver({
        call,
        authorityRef: call.authorityRef,
      });
      if (authority.status !== "allowed") {
        return {
          callId: call.callId,
          toolName: call.toolName,
          status: "error",
          content: authority.reason,
        };
      }
      if (call.toolName === "file") {
        call = { ...call, args: normalizeFileProviderArgs(call.args) };
      }
      const requiredRelayId = state.requiredHostRelays?.[call.callId] ?? null;
      let requiredHostContext: RequiredOrdinaryHostDispatchContext | null =
        requiredRelayId === null ? null : { relayId: requiredRelayId };
      const taskContinuation = state.taskReportBackContinuation;
      if (requiredRelayId !== null && hasAvailableTaskReportBackContinuation(taskContinuation)) {
        const capabilities = _relayRegistry === null
          ? null
          : resolveExactTaskContinuationCapabilities({
              registry: _relayRegistry,
              continuation: taskContinuation,
              userId: state.userId ?? "",
              requiredRelayId,
            });
        if (capabilities === null) {
          return {
            callId: call.callId,
            toolName: call.toolName,
            status: "error",
            content: `Error: ${call.toolName}'s exact Task continuation is no longer live and eligible.`,
          };
        }
        requiredHostContext = {
          relayId: requiredRelayId,
          currentFolderRoot: taskContinuation.currentFolder,
          workspaceRoot: taskContinuation.workspacePath,
          requiredRelaySessionId: taskContinuation.relaySessionId,
          requiredDesktopSessionId: taskContinuation.desktopSessionId,
          requiredPairingGeneration: taskContinuation.pairingGeneration,
        };
      }
      const ordinaryOrigin = state.verifiedOrdinaryOrigin;
      if (
        requiredRelayId !== null &&
        ordinaryOrigin?.kind === "paired_mobile" &&
        (call.toolName === "file" || call.toolName === "apply_patch")
      ) {
        const entry = catalogChecked.get(call.toolName);
        if (entry) {
          const policy = resolveExecutionPolicy(call.toolName, catalogChecked);
          const hostScope = resolveToolCallHostScope({
            classified: policy.hostScope,
            toolName: call.toolName,
            args: call.args,
            currentFolder: state.currentFolder ?? "",
          });
          const resolver = getOrdinaryHostResolver();
          if (hostScope === "required" && resolver) {
            const resolution = await resolver.resolve({
              origin: ordinaryOrigin,
              toolCallId: call.callId,
              toolName: call.toolName,
              relayCapability: policy.relayCapability ?? "canReadWorkspace",
              ...(policy.hostedBy ? { hostedBy: policy.hostedBy } : {}),
            });
            if (resolution.status === "selected" && resolution.host.relayId === requiredRelayId) {
              requiredHostContext = resolution.host;
            }
          }
        }
      }
      const message = await runWithRequiredOrdinaryHostContext(requiredHostContext, () =>
        runWithFocusedLocalFileHints(focusedHints, () =>
          runApprovedToolCall({
            id: call.callId,
            name: call.toolName,
            args: call.args,
            type: "tool_call",
          }),
        ),
      );
      const status = readToolMessageStatus(message) ?? "success";
      const additionalKwargs = { ...message.additional_kwargs };
      // Mint content-free operation metadata only from this successful normalized
      // invocation. Never trust a tool/source-supplied copy of the reserved field.
      delete additionalKwargs["nautilo_file_operation"];
      const fileCommand = call.toolName === "file" ? call.args["command"] : undefined;
      if (status === "success" && (fileCommand === "read" || fileCommand === "grep"
        || fileCommand === "glob" || fileCommand === "list" || fileCommand === "stat")) {
        additionalKwargs["nautilo_file_operation"] = fileCommand;
      }
      const summary = additionalKwargs["nautilo_event_summary"];
      return {
        callId: call.callId,
        toolName: call.toolName,
        status,
        content: message.content,
        ...(additionalKwargs ? { additionalKwargs } : {}),
        ...(typeof summary === "string" ? { eventSummary: summary } : {}),
      };
  };
  let invocationTail: Promise<unknown> = Promise.resolve();
  return Object.freeze({
    invoke(call: NautiloToolInvocationCall): Promise<NautiloToolInvocationResult> {
      const current = invocationTail.then(
        () => invokeOne(call),
        () => invokeOne(call),
      );
      invocationTail = current.then(
        () => undefined,
        () => undefined,
      );
      return current;
    },
    snapshot(): NautiloToolInvocationSnapshot {
      return {
        engagedSkillNames: engagedSkills.toArray(),
        activatedToolNames: isGuest ? [] : activatedTools.snapshotNames(),
        activatedToolLeases: isGuest ? [] : activatedTools.snapshotLeases(),
      };
    },
  });
}

/**
 * Dispatch a tool call to a connected relay and return the raw content
 * string (for success) or a pre-formatted error message (for all failure
 * paths). The caller (toolsNode) wraps success output in scanToolResult
 * and builds the final ToolMessage; error messages are server-generated
 * and bypass scanning. See .
 */
type RelayDispatchOutcome =
  | { ok: true; rawContent: string; toolError?: string }
  | {
      ok: true;
      multimodal: {
        kind: "browser_screenshot_vision" | "computer_observation_vision" | "computer_use_host_vision";
        text: string;
        image: { mime: string; base64: string };
      };
    }
  | {
      ok: false;
      errorMessage: string;
      networkDenied?: ApprovalAskNetworkContext;
      /**
       * true when the failure is "no relay could be reached for this
       * capability" (no registry, no eligible relay for the user, or the
       * dispatch threw because the device disconnected). Distinct from a
       * relay-*returned* error (a real tool failure the agent should see) or a
       * timeout-tier violation. In a Task run this flag makes the dispatch seam
       * throw `RelayUnavailableError` so the run fails cleanly instead of the
       * agent silently continuing cloud-only ( / ).
       */
      relayUnavailable?: boolean;
      /** A dispatched Desktop shell lost its final relay receipt. */
      runShellOutcome?: "unknown";
      browserFailure?: "browser_observation_stale" | "browser_cancelled" | "browser_authority_lost" | "browser_outcome_unknown" | "browser_observation_invalid";
      /** A dispatched structured SSH operation lost its final relay receipt. */
      structuredSshOutcome?: "unknown";
      /** A semantic desktop mutation lost its final relay receipt. */
      desktopAutomationOutcome?: "unknown";
    };

/**
 * a relay-executor tool could not reach a relay mid-run (the relay
 * vanished after being live at run start). Thrown ONLY for Task runs
 * (`state.taskRun`), where there is no present human to relay a "connect your
 * relay" tool message to; it propagates out of the tools node (past the
 * tool-error catch, which re-throws this type) and out of
 * `runScopeSubagentUntilPause`, so `taskRunExecutor` finalizes the run via
 * `reportBackTaskError` with a human-readable `relay_unavailable` cause. The
 * `.code` is grep-able and the message is surfaced to the owner.
 */
export class RelayUnavailableError extends Error {
  readonly code = "relay_unavailable" as const;
  constructor(detail: string, readonly researchInterruption?: "desktop_disconnected" | "desktop_authorization_changed") {
    super(`relay_unavailable: ${detail}`);
    this.name = "RelayUnavailableError";
  }
}

/** Check live facts before another model turn or local invocation. No retry policy here. */
export function assertResearchDesktopAvailable(state: Partial<NautiloState>): void {
  if (!state.taskRun || !state.researchWorkEnabled) return;
  const continuation = state.taskReportBackContinuation;
  if (!hasAvailableTaskReportBackContinuation(continuation)) return;
  if (!_relayRegistry || !_relayRegistry.isRelayHeartbeatFresh?.(continuation.relayId)
    || !_relayRegistry.getRelaySessionId?.(continuation.relayId)) {
    throw new RelayUnavailableError("Desktop disconnected or heartbeat expired; investigation checkpoint preserved.", "desktop_disconnected");
  }
  if (resolveExactTaskContinuationCapabilities({ registry: _relayRegistry, continuation,
    userId: state.userId ?? "", requiredRelayId: continuation.relayId }) === null) {
    throw new RelayUnavailableError("Desktop session or authorization changed; exact continuation requires revalidation.", "desktop_authorization_changed");
  }
}

/** Structural counterpart to runtime's cycle-safe dispatch error discriminant. */
function isRunShellOutcomeUnknown(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { runShellOutcome?: unknown }).runShellOutcome === "unknown";
}

function uncontainedHostOutcomeUnknownGuidance(): string {
  return "Error: The uncontained host-command activation was revoked while this command was in flight. " +
    "Its effects may have occurred; reconcile the host before retrying.";
}

/** Structural counterpart to runtime's cycle-safe structured SSH discriminant. */
function isStructuredSshOutcomeUnknown(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { structuredSshOutcome?: unknown }).structuredSshOutcome === "unknown";
}

/** Structural counterpart to runtime's effectful desktop receipt-loss discriminant. */
function isDesktopAutomationOutcomeUnknown(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { desktopAutomationOutcome?: unknown }).desktopAutomationOutcome === "unknown";
}

function structuredSshUnknownOutcomeGuidance(operation: RelaySshOperation | undefined): string {
  const label = operation === undefined ? "operation" : `${operation} operation`;
  return `Error: The exact structured SSH ${label} may have executed, but no canonical result was received. ` +
    "Reconcile the remote effect before any retry; do not retry this operation blindly.";
}

function isRelayVisionResult(
  value: unknown,
): value is {
  kind: "browser_screenshot_vision" | "computer_observation_vision" | "computer_use_host_vision";
  text: string;
  image: { mime: string; base64: string };
} {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const kind = obj["kind"];
  if (kind !== "browser_screenshot_vision" && kind !== "computer_observation_vision" && kind !== "computer_use_host_vision") return false;
  if (typeof obj["text"] !== "string") return false;
  const image = obj["image"];
  if (image === null || typeof image !== "object") return false;
  const img = image as Record<string, unknown>;
  return typeof img["base64"] === "string" && typeof img["mime"] === "string";
}

function relayVisionResultHeader(
  kind: "browser_screenshot_vision" | "computer_observation_vision" | "computer_use_host_vision",
  bytes: number,
  mime: string,
): string {
  if (kind === "computer_observation_vision" || kind === "computer_use_host_vision") {
    return `Computer observation (vision) (${bytes} bytes, ${mime})`;
  }
  return `Browser screenshot (vision) (${bytes} bytes, ${mime})`;
}

function buildRelayMultimodalToolMessage(
  tc: { name: string },
  toolCallId: string,
  multimodal: {
    kind: "browser_screenshot_vision" | "computer_observation_vision" | "computer_use_host_vision";
    text: string;
    image: { mime: string; base64: string };
  },
): { tm: ToolMessage; contentForEvent: string } {
  const { kind, text, image } = multimodal;
  const bytes = Buffer.from(image.base64, "base64").byteLength;
  const headerText = relayVisionResultHeader(kind, bytes, image.mime);
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: projectSemanticComputerResult(tc.name, text) },
    {
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${image.base64}` },
    },
  ];
  const eventSummary = JSON.stringify({
    multimodal: true,
    kind: "image",
    mime: image.mime,
    bytes,
    header: headerText,
  });
  const tm = new ToolMessage({
    content: content as never,
    tool_call_id: toolCallId,
    name: tc.name,
    additional_kwargs: {
      nautilo_event_summary: eventSummary,
      ...computerResultDurableSidecar(tc.name, text),
    },
  });
  assignStableToolMessageId(tm);
  setToolMessageStatus(tm, "success");
  const contentForEvent = isSupportedComputerUseToolName(tc.name) ? text : headerText;
  return { tm, contentForEvent };
}

type StructuredSshDispatchPreparation = {
  readonly operation: RelaySshOperation;
  readonly destination: RelaySshApprovedRequestV1["args"]["destination"];
  readonly args: Record<string, unknown>;
  readonly request: RelaySshApprovedRequestV1;
  readonly approvedRequestDigest: string;
  readonly toolCallId: string;
};

const SSH_HUMAN_APPROVAL_MAX_ENTRIES = 128;
const SSH_HUMAN_APPROVAL_PREFIX = "ssh-prepare-approval:";

type StructuredSshPrepareExpectation = {
  readonly relayId: string;
  readonly instanceId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly actorRole: "owner" | "admin";
  readonly agentId: string;
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly operation: RelaySshOperation;
  readonly destination: StructuredSshDispatchPreparation["destination"];
};

type PendingStructuredSshHumanApproval = {
  readonly approvalId: string;
  readonly prepared: RelaySshPrepareResponseV1;
  readonly expected: StructuredSshPrepareExpectation;
  readonly args: Record<string, unknown>;
  /** A parked Human review must not become an auto-approved dispatch on resume. */
  readonly requiresHumanReview: boolean;
};

const pendingStructuredSshHumanApprovals = new Map<string, PendingStructuredSshHumanApproval>();

function sameStructuredSshHumanApproval(
  pending: PendingStructuredSshHumanApproval,
  expected: StructuredSshPrepareExpectation,
): boolean {
  return pending.expected.relayId === expected.relayId &&
    pending.expected.instanceId === expected.instanceId &&
    pending.expected.userId === expected.userId &&
    pending.expected.actorId === expected.actorId &&
    pending.expected.actorRole === expected.actorRole &&
    pending.expected.agentId === expected.agentId &&
    pending.expected.toolCallId === expected.toolCallId &&
    pending.expected.approvedRequestDigest === expected.approvedRequestDigest &&
    pending.expected.operation === expected.operation;
}

function sameStructuredSshDestination(
  left: RelaySshPrepareResponseV1["approval"]["requestedDestination"],
  right: RelaySshPrepareResponseV1["approval"]["requestedDestination"],
): boolean {
  if ("connection" in left || "connection" in right) {
    return "connection" in left && "connection" in right && left.connection === right.connection;
  }
  return left.host === right.host && left.user === right.user && left.port === right.port;
}

function sameStructuredSshSubject(
  left: RelaySshPrepareResponseV1["subject"],
  right: RelaySshPrepareResponseV1["subject"],
): boolean {
  return left.userId === right.userId &&
    left.actorId === right.actorId &&
    left.actorRole === right.actorRole &&
    left.agentId === right.agentId &&
    left.executionEntrypoint === right.executionEntrypoint &&
    left.instanceId === right.instanceId &&
    left.relayId === right.relayId &&
    left.relaySessionId === right.relaySessionId &&
    left.desktopSessionId === right.desktopSessionId &&
    left.pairingGenerationRef === right.pairingGenerationRef &&
    left.capabilityRevision === right.capabilityRevision;
}

/**
 * A renewed Electron preparation may replace a Human-approved one without a
 * second prompt only when every reviewed fact and every dynamic authority
 * binding still match. `preparationId` deliberately differs: it is the new
 * one-use Electron handle that makes the resumed dispatch safe.
 */
export function classifyStructuredSshPreparationRefresh(
  approved: RelaySshPrepareResponseV1,
  refreshed: RelaySshPrepareResponseV1,
): "unchanged" | "review_required" {
  const previous = approved.approval;
  const current = refreshed.approval;
  return sameStructuredSshSubject(approved.subject, refreshed.subject) &&
    sameStructuredSshDestination(previous.requestedDestination, current.requestedDestination) &&
    previous.host === current.host &&
    previous.port === current.port &&
    previous.remoteUser === current.remoteUser &&
    previous.operation === current.operation &&
    previous.hostKeyFingerprint === current.hostKeyFingerprint &&
    previous.hostTrust === current.hostTrust &&
    previous.previousHostKeyFingerprint === current.previousHostKeyFingerprint
    ? "unchanged"
    : "review_required";
}

function structuredSshReviewStaleRecovery(): string {
  return "Error: Structured SSH review is stale (review_stale). The Mac could not confirm the exact reviewed operation after approval; no SSH operation was started. Review the current operation and approve it again.";
}

function structuredSshPreEffectFailure(
  code: string,
  detail: string,
  recovery: string,
): string {
  return `Error: Structured SSH did not start (${code}). ${detail} No SSH operation was started. ${recovery}`;
}

function structuredSshHumanApprovalReason(
  pending: PendingStructuredSshHumanApproval,
): string {
  const summary = pending.prepared.approval;
  const trust = summary.hostTrust === "trusted"
    ? "already trusted"
    : summary.hostTrust === "changed"
      ? `changed from ${summary.previousHostKeyFingerprint ?? "the previous key"}`
      : "not yet trusted";
  const command = pending.expected.operation === "exec"
    ? ` Program and argv: ${JSON.stringify(pending.args)}.`
    : pending.expected.operation === "copy-upload"
      ? ` Upload local path ${JSON.stringify(pending.args["localPath"])} to literal remote path ${JSON.stringify(pending.args["remotePath"])}.`
      : pending.expected.operation === "copy-download"
        ? ` Download literal remote path ${JSON.stringify(pending.args["remotePath"])} to local path ${JSON.stringify(pending.args["localPath"])}.`
        : " Authentication only; no remote command.";
  const budget = typeof pending.args["timeoutSeconds"] === "number"
    ? ` Execution budget: ${pending.args["timeoutSeconds"]} seconds${typeof pending.args["timeoutReason"] === "string" ? ` (${pending.args["timeoutReason"]})` : ""}.`
    : "";
  return `Review and approve this exact SSH operation: ${summary.host}:${summary.port} as ${summary.remoteUser}; ` +
    `host key ${summary.hostKeyFingerprint} (${trust}); operation ${summary.operation}.${command}${budget}`;
}

/** Secret-free recovery copy for typed Electron connection-resolution failures. */
export function structuredSshPrepareFailureGuidance(code: unknown, failure?: RelaySshResolutionFailure): string | null {
  if (code === "ssh_prepare_timeout") {
    return "Error: The connected Mac did not complete the exact SSH preparation request before the bounded relay timeout. No SSH operation or trust change was started. Retrying is safe; retry once, then report the relay preparation timeout if it persists. Do not re-enable SSH or create another grant.";
  }
  if (failure?.phase === "trust_store_lookup") {
    const reason = code === "trust_store_corrupt" || code === "trust_store_instance_mismatch"
      ? code
      : "trust_store_unavailable";
    return `Error: The Mac could not complete its app-local SSH trust-store lookup (${reason}) before any SSH operation or trust change. Retrying is safe; retry once, then report the local trust-store condition if it persists. Do not re-enable SSH or create another grant.`;
  }
  if (failure?.phase === "host_key_scan") {
    const reason = [
      "scan_invalid_request", "scan_failed", "scan_timed_out", "scan_aborted", "scan_output_limited",
      "scanner_output_invalid", "host_key_missing", "host_key_changed", "host_key_ambiguous",
    ].includes(code as string)
      ? code as string
      : "scan_failed";
    const timeout = reason === "scan_timed_out" ? " timed out after about 5 seconds" : " could not complete";
    return `Error: The Mac's SSH host-key scan${timeout} (${reason}) before any SSH operation or trust change. Retrying is safe; retry once, then check the exact host's reachability and report the scan failure if it persists. Do not re-enable SSH or create another grant.`;
  }
  if (failure?.phase === "known_hosts_lookup") {
    const reason = [
      "lookup_invalid_request", "observer_unavailable", "lookup_failed", "lookup_timed_out", "lookup_aborted",
      "lookup_output_limited", "lookup_output_invalid",
    ].includes(code as string)
      ? code as string
      : "observer_unavailable";
    const timeout = reason === "lookup_timed_out" ? " timed out after about 5 seconds" : " could not complete";
    return `Error: The Mac's read-only known_hosts lookup${timeout} (${reason}) before any SSH operation or trust change. Retrying is safe; retry once, then report the local known_hosts observation failure if it persists. Do not re-enable SSH or create another grant.`;
  }
  if (code === "connection_not_found") {
    return "Error: No complete authoritative local SSH connection has that name. Ask the Human for the configured connection name or an exact user@host endpoint; do not guess or probe accounts.";
  }
  if (code === "remote_user_missing") {
    return "Error: The SSH destination has no authoritative remote username. Inspect the relevant connection or project context; if it still cannot be determined, ask the Human which SSH account to use, then retry with destination.user. Do not use the local workstation username or probe remote accounts.";
  }
  if (code === "connection_ambiguous") {
    return "Error: More than one authoritative local SSH connection matches that name. Ask the Human which configured connection they mean; do not guess or probe accounts.";
  }
  if (code === "connection_catalog_malformed" || code === "connection_catalog_unreadable" ||
    code === "openssh_connection_catalog_malformed" || code === "openssh_connection_catalog_unreadable" ||
    code === "openssh_connection_catalog_unsupported_match" || code === "openssh_connection_catalog_unsupported_source") {
    return "Error: The Mac’s authoritative SSH connection configuration needs repair before this operation can run. Ask the Human to repair the configured connection source; do not create a grant, use a local username fallback, or probe accounts.";
  }
  if (code === "connection_catalog_overflow" || code === "openssh_connection_catalog_overflow") {
    return "Error: The Mac’s SSH connection catalog exceeded its safe observation bound. Ask the Human to reduce or repair the configured catalog, then retry; do not guess or probe accounts.";
  }
  if (code === "invalid_destination" || code === "invalid_host" || code === "invalid_remote_user" || code === "invalid_port" || code === "config_destination_mismatch") {
    return "Error: The requested SSH destination is not an exact supported connection or endpoint. Correct the destination and retry; do not substitute a local username or probe accounts.";
  }
  if (code === "resolve_aborted" || code === "resolve_spawn_failed" || code === "resolve_timed_out" || code === "resolve_output_limited" || code === "resolve_failed" || code === "config_output_invalid" || code === "config_required_value_missing" || code === "config_value_invalid" || code === "config_unsafe_directive") {
    return "Error: The connected Mac could not safely resolve this SSH destination. Retry once; if it persists, ask the Human to repair the connection configuration. Do not create a grant, use a local username fallback, or probe accounts.";
  }
  if (failure?.phase === "dispatch_reresolve") {
    return "Error: The SSH connection changed after approval and was not executed. Review the updated configured connection and retry; do not guess or probe accounts.";
  }
  if (code === "connection_source_drift") {
    return "Error: The SSH connection changed after approval and was not executed. Review the updated configured connection and retry; do not guess or probe accounts.";
  }
  if (code === "connection_catalog_unavailable") {
    return "Error: This Mac's authoritative SSH connection configuration could not be read safely. No SSH connection was attempted. Report that local connection configuration needs repair; do not guess a username or redirect the Human to SSH enablement.";
  }
  return null;
}

function structuredSshHumanApprovalDto(
  pending: PendingStructuredSshHumanApproval,
): StructuredSshApproval {
  const summary = pending.prepared.approval;
  const program = pending.args["program"];
  const argv = pending.args["argv"];
  const safeArgv = Array.isArray(argv) && argv.every((value): value is string => typeof value === "string")
    ? argv
    : undefined;
  return {
    version: "structured-ssh-v1",
    toolCallId: pending.expected.toolCallId,
    approvedRequestDigest: pending.expected.approvedRequestDigest,
    preparationId: pending.prepared.preparationId,
    operation: pending.expected.operation,
    host: summary.host,
    port: summary.port,
    remoteUser: summary.remoteUser,
    hostKeyFingerprint: summary.hostKeyFingerprint,
    hostTrust: summary.hostTrust,
    ...(summary.hostTrust === "changed" ? { previousHostKeyFingerprint: summary.previousHostKeyFingerprint } : {}),
    ...(pending.expected.operation === "exec" && typeof program === "string" && safeArgv !== undefined
      ? { program, argv: [...safeArgv] }
      : {}),
    ...((pending.expected.operation === "copy-upload" || pending.expected.operation === "copy-download") &&
      typeof pending.args["localPath"] === "string" && typeof pending.args["remotePath"] === "string"
      ? { localPath: pending.args["localPath"], remotePath: pending.args["remotePath"] }
      : {}),
    ...(typeof pending.args["timeoutSeconds"] === "number"
      ? {
          timeoutSeconds: pending.args["timeoutSeconds"],
          ...(typeof pending.args["timeoutReason"] === "string" ? { timeoutReason: pending.args["timeoutReason"] } : {}),
        }
      : {}),
  };
}

type StructuredSshHumanApprovalOutcome = "approved" | "denied" | "repark";

/**
 * Keep structured-SSH approval receipts exact, while recognizing the one
 * graph-resume race where a later tool call is re-entered with the preceding
 * call's otherwise-valid `once` receipt. That receipt must not authorize this
 * call, but it also is not a Human denial of this call: re-park the current
 * exact approval instead.
 */
export function classifyStructuredSshHumanApproval(
  pendingApprovalId: string,
  rawDecision: unknown,
): StructuredSshHumanApprovalOutcome {
  const decision = rawDecision !== null && typeof rawDecision === "object" && !Array.isArray(rawDecision)
    ? rawDecision as Record<string, unknown>
    : null;
  const echoedApprovalId = decision?.["structuredSshApprovalId"];
  if (
    decision?.["approved"] === true &&
    decision["verb"] === "once" &&
    typeof echoedApprovalId === "string" &&
    echoedApprovalId.length > 0
  ) {
    return echoedApprovalId === pendingApprovalId ? "approved" : "repark";
  }
  return "denied";
}

/**
 * Consume at most one stale chained receipt. The second consumption is the
 * current operation's newly parked exact approval; another mismatch fails
 * closed rather than allowing an unbounded replay loop.
 */
export function resolveStructuredSshHumanApprovalReplay(
  consume: () => StructuredSshHumanApprovalOutcome,
): "approved" | "denied" {
  const initialOutcome = consume();
  if (initialOutcome !== "repark") return initialOutcome;
  return consume() === "approved" ? "approved" : "denied";
}

/**
 * Auto-Approve may bypass the graph interrupt only for a host whose exact pin
 * is already trusted locally. Unknown and changed host keys always retain the
 * Human review boundary.
 */
export function shouldAutoApproveStructuredSsh(
  autoApprove: boolean | undefined,
  hostTrust: "trusted" | "unknown" | "changed",
): boolean {
  return autoApprove === true && hostTrust === "trusted";
}

function consumeStructuredSshHumanApproval(
  pending: PendingStructuredSshHumanApproval,
): StructuredSshHumanApprovalOutcome {
  const rawDecision: unknown = interrupt({
    type: "approval_ask" as const,
    approvalId: pending.approvalId,
    tools: [{
      name: pending.expected.operation === "auth" ? "structured_ssh_auth" : pending.expected.operation === "exec" ? "structured_ssh_exec" : pending.expected.operation === "copy-upload" ? "structured_ssh_copy_upload" : "structured_ssh_copy_download",
      args: pending.args,
      id: pending.expected.toolCallId,
    }],
    reason: structuredSshHumanApprovalReason(pending),
    reasonCode: "destructive-tool" as const,
    allowedVerbs: ["once", "deny"] as ApprovalReplyVerb[],
    requiresExplicitReview: true,
    structuredSsh: structuredSshHumanApprovalDto(pending),
  });
  // The resume route echoes the opaque approval id only after it has accepted
  // the parked approval. Re-check it here with the process-local exact tuple;
  // a stale, denied, broadened, or cross-call resume can never reach dispatch.
  return classifyStructuredSshHumanApproval(pending.approvalId, rawDecision);
}

/** Rebuild the only model-controlled SSH fields; all local authority follows prepare. */
function structuredSshApprovedDispatch(
  tc: { id?: string; name: string; args: Record<string, unknown> },
  toolCallId: string | undefined,
): StructuredSshDispatchPreparation | null {
  if (toolCallId === undefined || toolCallId.length === 0) return null;
  const timeout = tc.name === "structured_ssh_auth"
    ? null
    : resolveStructuredSshTimeout(tc.args);
  if (timeout !== null && !timeout.ok) return null;
  const timeoutArgs = timeout === null
    ? {}
    : {
        timeoutSeconds: timeout.timeoutSeconds,
        ...(timeout.timeoutReason === undefined ? {} : { timeoutReason: timeout.timeoutReason }),
      };
  const raw = tc.name === "structured_ssh_auth"
    ? {
        version: RELAY_SSH_APPROVED_REQUEST_VERSION,
        toolCallId,
        toolName: "structured_ssh_auth" as const,
        args: { destination: tc.args["destination"] },
      }
    : tc.name === "structured_ssh_exec"
      ? {
          version: RELAY_SSH_APPROVED_REQUEST_VERSION,
          toolCallId,
          toolName: "structured_ssh_exec" as const,
          args: {
            destination: tc.args["destination"],
            program: tc.args["program"],
            argv: tc.args["argv"],
            ...timeoutArgs,
          },
        }
      : tc.name === "structured_ssh_copy_upload"
        ? {
            version: RELAY_SSH_APPROVED_REQUEST_VERSION,
            toolCallId,
            toolName: "structured_ssh_copy_upload" as const,
            args: {
              destination: tc.args["destination"],
              localPath: tc.args["localPath"],
              remotePath: tc.args["remotePath"],
              ...timeoutArgs,
            },
          }
        : tc.name === "structured_ssh_copy_download"
          ? {
              version: RELAY_SSH_APPROVED_REQUEST_VERSION,
              toolCallId,
              toolName: "structured_ssh_copy_download" as const,
              args: {
                destination: tc.args["destination"],
                remotePath: tc.args["remotePath"],
              localPath: tc.args["localPath"],
              ...timeoutArgs,
              },
            }
      : null;
  // Every model-visible SSH operation has an exact finite argument shape.
  if (raw === null ||
    (tc.name === "structured_ssh_auth" &&
      (Object.keys(tc.args).length !== 1 || !("destination" in tc.args))) ||
    (tc.name === "structured_ssh_exec" &&
      (Object.keys(tc.args).some((key) => !["destination", "program", "argv", "timeout_seconds", "timeout_reason"].includes(key)) ||
        !("destination" in tc.args) || !("program" in tc.args) || !("argv" in tc.args))) ||
    ((tc.name === "structured_ssh_copy_upload" || tc.name === "structured_ssh_copy_download") &&
      (Object.keys(tc.args).some((key) => !["destination", "localPath", "remotePath", "timeout_seconds", "timeout_reason"].includes(key)) ||
        !("destination" in tc.args) || !("localPath" in tc.args) || !("remotePath" in tc.args)))) return null;
  const parsed = parseRelaySshApprovedRequestV1(raw);
  if (!parsed.ok) return null;
  return {
    operation: parsed.request.toolName === "structured_ssh_auth"
      ? "auth"
      : parsed.request.toolName === "structured_ssh_exec"
        ? "exec"
        : parsed.request.toolName === "structured_ssh_copy_upload"
          ? "copy-upload"
          : "copy-download",
    destination: parsed.request.args.destination,
    args: parsed.request.toolName === "structured_ssh_auth"
      ? { operation: "auth", destination: parsed.request.args.destination }
      : parsed.request.toolName === "structured_ssh_exec" ? {
          operation: "exec",
          destination: parsed.request.args.destination,
          program: parsed.request.args.program,
          argv: parsed.request.args.argv,
          timeoutSeconds: parsed.request.args.timeoutSeconds,
          ...(parsed.request.args.timeoutReason === undefined ? {} : { timeoutReason: parsed.request.args.timeoutReason }),
        } : parsed.request.toolName === "structured_ssh_copy_upload" ? {
          operation: "copy-upload",
          destination: parsed.request.args.destination,
          localPath: parsed.request.args.localPath,
          remotePath: parsed.request.args.remotePath,
          timeoutSeconds: parsed.request.args.timeoutSeconds,
          ...(parsed.request.args.timeoutReason === undefined ? {} : { timeoutReason: parsed.request.args.timeoutReason }),
        } : {
          operation: "copy-download",
          destination: parsed.request.args.destination,
          remotePath: parsed.request.args.remotePath,
          localPath: parsed.request.args.localPath,
          timeoutSeconds: parsed.request.args.timeoutSeconds,
          ...(parsed.request.args.timeoutReason === undefined ? {} : { timeoutReason: parsed.request.args.timeoutReason }),
        },
    request: parsed.request,
    approvedRequestDigest: computeRelaySshApprovedRequestDigestV1(parsed.request),
    toolCallId: parsed.request.toolCallId,
  };
}

function isExactStructuredSshPrepareResponse(
  response: RelaySshPrepareResponseV1,
  expected: StructuredSshPrepareExpectation,
): boolean {
  const parsed = parseRelaySshPrepareResponse(response);
  if (!parsed.ok) return false;
  const value = parsed.response;
  return value.toolCallId === expected.toolCallId &&
    value.approvedRequestDigest === expected.approvedRequestDigest &&
    value.operation === expected.operation &&
    value.approval.operation === expected.operation &&
    sameStructuredSshDestination(value.approval.requestedDestination, expected.destination) &&
    ("connection" in expected.destination ||
      (value.approval.host === expected.destination.host &&
        value.approval.remoteUser === expected.destination.user &&
        (expected.destination.port === undefined || value.approval.port === expected.destination.port))) &&
    value.subject.relayId === expected.relayId &&
    value.subject.instanceId === expected.instanceId &&
    value.subject.userId === expected.userId &&
    value.subject.actorId === expected.actorId &&
    value.subject.actorRole === expected.actorRole &&
    value.subject.agentId === expected.agentId &&
    value.subject.executionEntrypoint === "foreground.main";
}

async function prepareStructuredSshExact(
  registry: ToolRelayRegistry,
  relayId: string,
  expected: StructuredSshPrepareExpectation,
  approved: StructuredSshDispatchPreparation,
): Promise<
  | { readonly ok: true; readonly prepared: RelaySshPrepareResponseV1 }
  | { readonly ok: false; readonly errorMessage: string }
> {
  try {
    const prepared = await registry.prepareStructuredSsh!(relayId, {
      instanceId: expected.instanceId,
      userId: expected.userId,
      actorId: expected.actorId,
      actorRole: expected.actorRole,
      agentId: expected.agentId,
      executionEntrypoint: "foreground.main",
      toolCallId: expected.toolCallId,
      approvedRequestDigest: expected.approvedRequestDigest,
      operation: expected.operation,
      approvedRequest: approved.request,
    });
    return { ok: true, prepared };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : null;
    warn(`[nautilo/tools] Structured SSH prepare failed (code=${code ?? "unknown"}; detail=${error instanceof Error ? error.message : "unknown"})`);
    const failure = typeof error === "object" && error !== null && "failure" in error
      ? (error.failure as RelaySshResolutionFailure | undefined)
      : undefined;
    const guidance = structuredSshPrepareFailureGuidance(code, failure);
    return {
      ok: false,
      errorMessage: guidance ??
        structuredSshPreEffectFailure(
          "prepare_unknown",
          "The connected Mac rejected or failed the exact preparation request without a recognized resolution phase.",
          "Retry once; if it persists, report this code and the desktop logs instead of re-enabling SSH or creating another connection.",
        ),
    };
  }
}

/**
 * 's only model-to-Desktop translation. The operation is validated from
 * the admitted model call, while every identity is re-derived from the active
 * server Task state. Do not add roots, relays, Task ids, or model ids to the
 * public schema: the exact continuation contributes the stale current-folder
 * assertion and the envelope keeps that authority separate from model input.
 */
const SECURITY_SCAN_ENTRY_KEYS: Readonly<Record<string, readonly string[]>> = {
  review_unit: ["kind", "summary", "surfaceKey", "paths", "state", "trace", "notes", "blocker", "evidenceRefs", "counterevidenceRefs", "openRecordIds"],
  repository_map: ["kind", "summary", "surfaces", "evidenceRefs"],
  hypothesis: ["kind", "summary", "state", "evidenceRefs", "counterevidenceRefs"],
  evidence: ["kind", "summary", "evidenceRefs"],
  counterevidence: ["kind", "summary", "evidenceRefs"],
  finding: ["kind", "title", "summary", "confidence", "impact", "exploitPreconditions", "evidenceRefs", "counterevidenceRefs"],
  dismissal: ["kind", "summary", "evidenceRefs", "counterevidenceRefs"],
  coverage: ["kind", "surfaceKey", "state", "rationale", "evidenceRefs", "blocker"],
  checkpoint: ["kind", "summary", "nextWork", "openRecordIds", "evidenceRefs"],
  open_question: ["kind", "question", "evidenceRefs", "resolution"],
};

const TASK_BOUND_SECURITY_SCAN_ID = "scan_task_bound";

interface SecurityScanNormalizationContext {
  readonly nextResultsCursor?: string | null;
  readonly recentFileReadCitations?: readonly SecurityScanFileCitationInput[];
  readonly knownEvidenceReferenceKeys?: ReadonlySet<string>;
  readonly latestLedgerRecord?: {
    readonly id: string;
    readonly kind: string;
  };
}

function securityScanResultsIdentity(args: Record<string, unknown>): string {
  const filter = (name: string) => Array.isArray(args[name])
    ? [...new Set(args[name])].sort() : undefined;
  return JSON.stringify({ category: args["category"], finalize: args["finalize"] === true,
    probes: filter("probes"), recordKinds: filter("recordKinds"), recordIds: filter("recordIds") });
}

/** Echo only a paired receipt's cursor for this exact result query. */
export function latestSecurityScanResultsCursor(messages: NautiloState["messages"], args: Record<string, unknown>): string | null | undefined {
  const identity = securityScanResultsIdentity(args);
  const calls = new Map<string, Record<string, unknown>>();
  let cursor: string | null | undefined;
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.name === "security_scan" && call.id) calls.set(call.id, call.args);
      continue;
    }
    if (!ToolMessage.isInstance(message) || message.name !== "security_scan" || typeof message.content !== "string") continue;
    const call = calls.get(message.tool_call_id);
    calls.delete(message.tool_call_id);
    if (!call || call["operation"] !== "results" || securityScanResultsIdentity(call) !== identity) continue;
    let value: unknown;
    try { value = JSON.parse(message.content) as unknown; } catch { continue; }
    const parsed = securityScanToolResultSchema.safeParse(value);
    if (parsed.success && parsed.data.ok && parsed.data.operation === "results") cursor = parsed.data.result.nextCursor;
  }
  return cursor;
}

function securityScanEvidenceReferenceKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function knownSecurityScanEvidenceReferenceKeys(messages: NautiloState["messages"]): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    if (!ToolMessage.isInstance(message) || message.name !== "security_scan" || typeof message.content !== "string") continue;
    let value: unknown;
    try { value = JSON.parse(message.content) as unknown; } catch { continue; }
    if (value === null || typeof value !== "object" || (value as { ok?: unknown }).ok !== true) continue;
    const result = (value as { result?: unknown }).result;
    if (result === null || typeof result !== "object") continue;
    const resultRecord = result as Record<string, unknown>;
    const observations = resultRecord["observations"];
    if (Array.isArray(observations)) {
      for (const observation of observations) {
        if (observation !== null && typeof observation === "object" && typeof (observation as { id?: unknown }).id === "string") {
          keys.add(securityScanEvidenceReferenceKey("scanner_observation", (observation as { id: string }).id));
        }
      }
    }
    const records = resultRecord["records"];
    if (Array.isArray(records)) {
      for (const record of records) {
        if (record !== null && typeof record === "object" && typeof (record as { id?: unknown }).id === "string") {
          keys.add(securityScanEvidenceReferenceKey("ledger_record", (record as { id: string }).id));
        }
      }
    }
    const record = resultRecord["record"];
    if (record !== null && typeof record === "object" && typeof (record as { id?: unknown }).id === "string") {
      keys.add(securityScanEvidenceReferenceKey("ledger_record", (record as { id: string }).id));
    }
  }
  return keys;
}

function latestImmediateSecurityScanLedgerRecord(
  messages: NautiloState["messages"],
): SecurityScanNormalizationContext["latestLedgerRecord"] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!ToolMessage.isInstance(message)) continue;
    if (message.name !== "security_scan" || typeof message.content !== "string") return undefined;
    let value: unknown;
    try { value = JSON.parse(message.content) as unknown; } catch { return undefined; }
    if (
      value === null
      || typeof value !== "object"
      || (value as { ok?: unknown }).ok !== true
      || (value as { operation?: unknown }).operation !== "record"
    ) return undefined;
    const result = (value as { result?: unknown }).result;
    if (result === null || typeof result !== "object") return undefined;
    const record = (result as { record?: unknown }).record;
    if (record === null || typeof record !== "object") return undefined;
    const id = (record as { id?: unknown }).id;
    const entry = (record as { entry?: unknown }).entry;
    if (typeof id !== "string" || entry === null || typeof entry !== "object") return undefined;
    const recordKind = (entry as { kind?: unknown }).kind;
    return typeof recordKind === "string" ? { id, kind: recordKind } : undefined;
  }
  return undefined;
}

function successfulFileReadCitationAt(
  messages: NautiloState["messages"],
  resultIndex: number,
  result: ToolMessage,
): SecurityScanFileCitationInput | undefined {
  if (
    result.name !== "file"
    || typeof result.content !== "string"
    || result.content.startsWith("Error")
  ) return undefined;
  const footer = /<<< lines (\d+)-(\d+) of \d+; metadata, not source >>>\s*$/.exec(result.content);
  let startLine = footer ? Number(footer[1]) : NaN;
  let endLine = footer ? Number(footer[2]) : NaN;
  if (!footer) {
    try {
      const page = JSON.parse(result.content) as Record<string, unknown>;
      if (page["command"] !== "read" || typeof page["content"] !== "string") return undefined;
      // A fragment of a long line is useful evidence, but cannot automatically
      // stand in for inspection of the entire line. The model can cite it after
      // recovering and checking all fragments through readCursor.
      if (page["partialStartLine"] || page["partialEndLine"]) return undefined;
      startLine = Number(page["startLine"]);
      endLine = Number(page["endLine"]);
    } catch { return undefined; }
  }
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine <= 0 || endLine < startLine) {
    return undefined;
  }

  for (let index = resultIndex - 1; index >= 0; index -= 1) {
    const calls = (messages[index] as { tool_calls?: unknown } | undefined)?.tool_calls;
    if (!Array.isArray(calls)) continue;
    const call = calls.find((value): value is { id: string; name: string; args: Record<string, unknown> } => {
      if (value === null || typeof value !== "object") return false;
      const candidate = value as { id?: unknown; name?: unknown; args?: unknown };
      return candidate.id === result.tool_call_id
        && candidate.name === "file"
        && candidate.args !== null
        && typeof candidate.args === "object"
        && !Array.isArray(candidate.args);
    });
    if (call === undefined) continue;
    const args = normalizeFileProviderArgs(call.args);
    const path = args["path"];
    if (
      args["command"] !== "read"
      || args["zone"] !== "current"
      || typeof path !== "string"
      || path.length === 0
      || path.startsWith("/")
    ) return undefined;
    return { relativePath: path, startLine, endLine };
  }
  return undefined;
}

function recentSuccessfulFileReadCitations(
  messages: NautiloState["messages"],
): readonly SecurityScanFileCitationInput[] {
  const citations: SecurityScanFileCitationInput[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!ToolMessage.isInstance(message)) continue;
    if (message.name === "security_scan" && typeof message.content === "string") {
      let value: unknown;
      try { value = JSON.parse(message.content) as unknown; } catch { value = null; }
      if (
        value !== null
        && typeof value === "object"
        && (value as { ok?: unknown }).ok === true
        && ((value as { operation?: unknown }).operation === "start" || (value as { operation?: unknown }).operation === "record")
      ) break;
    }
    const citation = successfulFileReadCitationAt(messages, index, message);
    if (citation !== undefined) citations.push(citation);
  }
  return citations.reverse();
}

function selectSecurityScanFields(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

/**
 * Provider schemas must remain one flat object for OpenAI-compatible gateways.
 * This small compatibility boundary removes fields belonging to another
 * operation/record kind and repairs only structurally unambiguous legacy
 * spellings. It never invents substantive research content.
 */
export function normalizeSecurityScanOperationArgs(
  args: Record<string, unknown>,
  context: SecurityScanNormalizationContext = {},
): Record<string, unknown> {
  const operation = args["operation"];
  if (operation === "start") return selectSecurityScanFields(args, ["version", "operation", "mode", "targetDirectory", "priorScanId"]);
  if (operation === "status") return { ...selectSecurityScanFields(args, ["version", "operation"]), scanId: TASK_BOUND_SECURITY_SCAN_ID };
  if (operation === "cancel") return { ...selectSecurityScanFields(args, ["version", "operation", "reason"]), scanId: TASK_BOUND_SECURITY_SCAN_ID };
  if (operation === "results") {
    const normalized: Record<string, unknown> = {
      ...selectSecurityScanFields(args, ["version", "operation", "category", "limit", "finalize"]),
      scanId: TASK_BOUND_SECURITY_SCAN_ID,
    };
    // Flat-schema providers have also copied the returned cursor into the
    // record operation's `recordId` field. Treat that field only as a request
    // to advance; its value is never trusted or forwarded.
    const wantsContinuation = args["continueResults"] === true
      || args["cursor"] !== undefined
      || args["recordId"] !== undefined;
    if (wantsContinuation && typeof context.nextResultsCursor === "string") {
      normalized["cursor"] = context.nextResultsCursor;
    }
    const probes = Array.isArray(args["probes"])
      ? args["probes"].filter((value) => securityScanProbeSchema.safeParse(value).success)
      : [];
    const recordKinds = Array.isArray(args["recordKinds"])
      ? args["recordKinds"].filter((value) => securityScanRecordKindSchema.safeParse(value).success)
      : [];
    if (probes.length > 0) normalized["probes"] = probes;
    if (recordKinds.length > 0) normalized["recordKinds"] = recordKinds;
    if (args["recordIds"] !== undefined) normalized["recordIds"] = args["recordIds"];
    return normalized;
  }
  if (operation !== "record") return args;

  const rawEntry = args["entry"];
  if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return {
      ...selectSecurityScanFields(args, ["version", "operation", "action", "recordId", "expectedRevision", "entry", "fileCitations"]),
      scanId: TASK_BOUND_SECURITY_SCAN_ID,
    };
  }
  const entry = rawEntry as Record<string, unknown>;
  // Never turn a malformed update into an append by stripping its identity.
  // Let the strict canonical schema reject misplaced/conflicting controls.
  if (["action", "recordId", "expectedRevision"].some((key) => entry[key] !== undefined)
    || (args["action"] !== "update" && (args["recordId"] !== undefined || args["expectedRevision"] !== undefined))) {
    return { ...args, scanId: TASK_BOUND_SECURITY_SCAN_ID };
  }
  const kind = typeof entry["kind"] === "string" ? entry["kind"] : "";
  const kindAdjustedEntry: Record<string, unknown> = {
    ...entry,
    ...(kind === "coverage" && entry["rationale"] === undefined && typeof entry["summary"] === "string"
      ? { rationale: entry["summary"] }
      : {}),
    ...(kind === "open_question" && entry["question"] === undefined && typeof entry["summary"] === "string"
      ? { question: entry["summary"] }
      : {}),
  };
  const allowed = SECURITY_SCAN_ENTRY_KEYS[kind];
  const normalizedEntry = allowed === undefined ? kindAdjustedEntry : selectSecurityScanFields(kindAdjustedEntry, allowed);
  for (const field of ["evidenceRefs", "counterevidenceRefs"] as const) {
    const references = normalizedEntry[field];
    if (!Array.isArray(references)) continue;
    normalizedEntry[field] = references.filter((reference): boolean => {
      if (reference === null || typeof reference !== "object") return false;
      const candidate = reference as { kind?: unknown; id?: unknown };
      if (
        (candidate.kind !== "scanner_observation" && candidate.kind !== "ledger_record")
        || ((kind === "evidence" || kind === "counterevidence") && candidate.kind === "ledger_record")
        || typeof candidate.id !== "string"
      ) return false;
      return context.knownEvidenceReferenceKeys === undefined
        || context.knownEvidenceReferenceKeys.has(securityScanEvidenceReferenceKey(candidate.kind, candidate.id));
    });
  }
  const isUpdate = args["action"] === "update";
  if (isUpdate && kind === "hypothesis") {
    const transition = normalizedEntry["state"];
    const evidenceField = transition === "supported"
      ? "evidenceRefs"
      : transition === "rejected"
        ? "counterevidenceRefs"
        : null;
    const matchingPriorKind = transition === "supported" ? "evidence" : "counterevidence";
    const priorRecord = context.latestLedgerRecord;
    if (
      evidenceField !== null
      && (!Array.isArray(normalizedEntry[evidenceField]) || normalizedEntry[evidenceField].length === 0)
      && priorRecord?.kind === matchingPriorKind
    ) {
      normalizedEntry[evidenceField] = [{ kind: "ledger_record", id: priorRecord.id }];
    }
  }
  if (allowed !== undefined && !isUpdate) {
    if (normalizedEntry["evidenceRefs"] === undefined) normalizedEntry["evidenceRefs"] = [];
    // Coverage without an explicit state cannot truthfully be treated as
    // reviewed. Preserve the model's rationale and choose the conservative
    // bounded state so harmless flat-schema omission does not derail the
    // TaskRun or manufacture completed coverage.
    if (kind === "coverage" && normalizedEntry["state"] === undefined) normalizedEntry["state"] = "limited";
    if ((kind === "hypothesis" || kind === "finding" || kind === "dismissal" || kind === "review_unit") && normalizedEntry["counterevidenceRefs"] === undefined) {
      normalizedEntry["counterevidenceRefs"] = [];
    }
    if ((kind === "checkpoint" || kind === "review_unit") && normalizedEntry["openRecordIds"] === undefined) normalizedEntry["openRecordIds"] = [];
  }
  const nestedCitations = kindAdjustedEntry["fileCitations"];
  const normalized: Record<string, unknown> = {
    ...selectSecurityScanFields(args, ["version", "operation", "action", "recordId", "expectedRevision", "fileCitations"]),
    scanId: TASK_BOUND_SECURITY_SCAN_ID,
  };
  normalized["entry"] = normalizedEntry;
  if (normalized["fileCitations"] === undefined && Array.isArray(nestedCitations)) normalized["fileCitations"] = nestedCitations;
  if (normalized["action"] === undefined || normalized["action"] === "create") normalized["action"] = "append";
  const recentFileReadCitations = context.recentFileReadCitations ?? [];
  const isDirectEvidence = kind === "evidence" || kind === "counterevidence";
  const needsDirectCitation = isDirectEvidence
    || (
      (kind === "finding" || kind === "dismissal")
      && Array.isArray(normalizedEntry["evidenceRefs"])
      && normalizedEntry["evidenceRefs"].length === 0
    );
  if (
    normalized["action"] === "append"
    && needsDirectCitation
    && (!Array.isArray(normalized["fileCitations"]) || normalized["fileCitations"].length === 0)
    && recentFileReadCitations.length > 0
  ) normalized["fileCitations"] = [...recentFileReadCitations];
  return normalized;
}

/** Parse only: argument diagnostics must not be hidden by a recovery block.
 * Binding, authorization, cursor validity and dispatch remain in their existing gates. */
function parseSecurityScanOperationRequest(args: Record<string, unknown>, state: NautiloState, nextResultsCursor: string | null | undefined) {
  // Recovery may have projected an unread result. Do not automatically
  // cite source bytes the model has not yet seen in its working context.
  const recentFileReadCitations = state.researchContextRecovery?.pendingRefs.length
    ? [] : recentSuccessfulFileReadCitations(state.messages.slice(deriveResearchWorkContext(state)?.startIndex ?? 0));
  const knownEvidenceReferenceKeys = knownSecurityScanEvidenceReferenceKeys(state.messages);
  const latestLedgerRecord = latestImmediateSecurityScanLedgerRecord(state.messages);
  const operation = securityScanOperationSchema.safeParse(normalizeSecurityScanOperationArgs(
    args,
    {
      ...(nextResultsCursor === undefined ? {} : { nextResultsCursor }),
      recentFileReadCitations,
      knownEvidenceReferenceKeys,
      ...(latestLedgerRecord === undefined ? {} : { latestLedgerRecord }),
    },
  ));
  if (!operation.success) {
    const issues = operation.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    const requestedOperation = typeof args["operation"] === "string" ? args["operation"] : null;
    // Context and handoff are validated locally above; the remaining choices
    // come from the canonical relay contract rather than a second enum.
    const supportedOperations: readonly string[] = [...securityScanOperationSchema.options.map((schema) => schema.shape.operation.value), "context", "handoff"];
    const correction = requestedOperation === "start"
      ? "Correct the listed fields for the requested start operation. A deep_research start has the shape {\"version\":\"security-scan-v1\",\"operation\":\"start\",\"mode\":\"deep_research\",\"targetDirectory\":\"<requested directory>\"}. Preserve the originally requested mode and directory, then inspect the receipt. An existing scan must not be restarted."
      : requestedOperation !== null && supportedOperations.includes(requestedOperation)
        ? `Correct the listed fields, retry the corrected ${requestedOperation} operation, and inspect its receipt. Do not send scanId; the server binds this TaskRun to its scan. Do not start, finalize, or reopen a scan because this validation failure was not dispatched.`
        : `Choose the operation matching your intended action from the supported operations: ${supportedOperations.join(", ")}. Correct its required fields and inspect the receipt. Omit scanId; the server supplies any existing TaskRun scan binding. This request was not dispatched. Do not start, reopen or reset a scan merely to recover from this argument error.`;
    return {
      ok: false as const,
      errorMessage: localToolControlFailure("security_scan", args, "invalid_request",
        `Error: security_scan received invalid arguments${issues ? ` (${issues})` : ""}. ` +
        correction + (args["operation"] === "record"
          ? ' Updates must use top-level action:"update", recordId and expectedRevision beside entry; entry contains only the changed record fields. Never append a replacement for a rejected update.' : "")
        + (operation.error.issues.some((issue) => issue.path[0] === "fileCitations")
          ? " Add top-level fileCitations:[{relativePath:<exact inspected path relative to Current Folder>,startLine:<first inspected line>,endLine:<last inspected line>}]. Mentioning paths in entry.summary is not a citation. Retry one corrected record alone and inspect its receipt."
          : "")),
    };
  }

  return { ok: true as const, operation };
}

function buildSecurityScanRelayRequest(
  args: Record<string, unknown>,
  state: NautiloState,
  toolCallId: string,
  resolvedModelId: string | undefined,
):
  | { readonly ok: true; readonly request: SecurityScanRelayRequest }
  | { readonly ok: false; readonly errorMessage: string } {
  if (args["operation"] === "start") {
    const restartError = researchScanRestartError(state);
    if (restartError) return { ok: false, errorMessage: `Error: security_scan ${restartError}` };
  }
  const nextResultsCursor = latestSecurityScanResultsCursor(state.messages, args);
  if (args["operation"] === "results" && (args["continueResults"] === true || args["cursor"] !== undefined || args["recordId"] !== undefined)
    && typeof nextResultsCursor !== "string") {
    return { ok: false, errorMessage: "Error: security_scan has no remaining accepted page for these exact results filters. Start this category/filter query without continueResults; never reuse a cursor from inventory, targeted notes or intermediate results for final report paging." };
  }
  const parsed = parseSecurityScanOperationRequest(args, state, nextResultsCursor);
  if (!parsed.ok) return parsed;
  const operation = parsed.operation;
  const reviewMutationError = researchReviewMutationError(state, args);
  if (reviewMutationError) return { ok: false, errorMessage: localToolControlFailure("security_scan", args, "invalid_request", reviewMutationError) };

  if (operation.data.operation === "results" && operation.data.finalize === true) {
    const workError = researchWorkFinalizationError(state);
    if (workError) return { ok: false, errorMessage: `Error: security_scan research_incomplete. ${workError}` };
    const pendingDiscovery = unfinishedFileDiscovery(state.messages);
    if (pendingDiscovery) return { ok: false, errorMessage: `Error: security_scan research_incomplete. ${pendingDiscovery}` };
  }

  const continuation = state.taskReportBackContinuation;
  if (!hasAvailableTaskReportBackContinuation(continuation)) {
    return {
      ok: false,
      errorMessage: "Error: security_scan is a Task-internal worker tool. From a Room, start an in_background task with tools [\"file\", \"security_scan\"]; the Task will receive the exact live Desktop continuation.",
    };
  }
  if (!resolvedModelId) {
    return {
      ok: false,
      errorMessage: "Error: security_scan needs the Task's resolved catalog model before it can run.",
    };
  }
  const trustedContext = securityScanTrustedContextSchema.safeParse({
    taskId: state.currentTaskId,
    taskRunId: state.currentTaskRunId,
    toolCallId,
    modelId: resolvedModelId,
  });
  if (!trustedContext.success) {
    return {
      ok: false,
      errorMessage: "Error: security_scan is a Task-internal worker tool and needs an active durable Task run. From a Room, start an in_background task with tools [\"file\", \"security_scan\"].",
    };
  }
  const request = securityScanRelayRequestSchema.safeParse({
    operation: operation.data,
    trustedContext: trustedContext.data,
    expectedCurrentFolder: continuation.currentFolder,
  });
  if (!request.success) {
    return {
      ok: false,
      errorMessage: "Error: security_scan could not establish its trusted Desktop request.",
    };
  }
  return { ok: true, request: request.data };
}

async function executeViaRelayRaw(
  tc: { id?: string; name: string; args: Record<string, unknown> },
  policy: ExecutionPolicy,
  state: NautiloState,
  opts: {
    readonly extraNetworkAllowRules?: readonly NetworkAllowRule[];
    /** Stable lifecycle id generated before dispatch, including tc.id-less calls. */
    readonly toolCallId?: string;
    /** Enclosing graph/job cancellation authority. */
    readonly signal?: AbortSignal;
    /** Trusted live account policy, never model arguments. */
    readonly fullEncryptionOnly?: boolean;
    /** Already selected catalog model; only used for the private envelope. */
    readonly resolvedModelId?: string;
  } = {},
): Promise<RelayDispatchOutcome> {
  const browserPlan = tc.name === "browser_snapshot" ? interpretBrowserDecisionPlanArgs(tc.args) : null;
  if (browserPlan?.kind === "invalid") {
    return { ok: false, errorMessage: browserDecisionPlanError(
      browserPlan.error, browserPlan.code, browserPlan.instruction,
    ) };
  }
  if (tc.name === "browser_snapshot" && tc.args["historyToolCallId"] !== undefined) {
    const source = tc.args["historyToolCallId"];
    if (typeof source !== "string" || source.trim().length === 0 || Object.keys(tc.args).some(key => key !== "historyToolCallId")) {
      return { ok: false, errorMessage: "Historical browser read requires only historyToolCallId: a nonempty tool-call ID from this conversation. It cannot be combined with a decision plan or browser selector. No browser request was sent." };
    }
    const content = readBrowserHistory(state.messages, source);
    return content === null
      ? { ok: false, errorMessage: "browser_history_unavailable: No unique successful browser observation or page read with that tool-call ID is retained in this conversation. No other conversation was searched and no browser request was sent. A fresh snapshot can show only the current page." }
      : { ok: true, rawContent: content };
  }
  if (!_relayRegistry) {
    warn(`[nautilo/tools] Relay tool ${formatToolLogLabel(tc)} called but no relay registry configured`);
    return {
      ok: false,
      errorMessage: `Error: ${tc.name} requires a connected relay (desktop app or nautilo-relay). No relay registry is configured on this server.`,
      relayUnavailable: true,
    };
  }

  // this is deliberately before generic host resolution. Current
  // Folder adoption is meaningful only on the local Electron that received
  // the ordinary request; it must never select a paired-mobile host or the
  // first relay advertising a capability.
  if (tc.name === "select_current_folder") {
    return await executeSelectCurrentFolderViaRelay(tc, state, _relayRegistry);
  }

  const capability = policy.relayCapability ?? "canReadWorkspace";
  const userId = state.userId ?? "";
  const isStructuredSsh = tc.name === "structured_ssh_auth" || tc.name === "structured_ssh_exec" || tc.name === "structured_ssh_copy_upload" || tc.name === "structured_ssh_copy_download";
  const isStructuredSshOutput = tc.name === "structured_ssh_output";
  const isSemanticComputerUse = isSupportedComputerUseToolName(tc.name);
  const computerUseRequest = resolveComputerUseHostInvocationRequest(tc.name, tc.args);
  const nativeDecision = currentNativeDecision(state);
  const nativeDispatchError = nativeDecisionDispatchError(state, tc);
  if (nativeDispatchError || (nativeDecision && nativeDecision.pending && nativeDecision.pending.id === tc.id
    && (!opts.signal || opts.signal.aborted
      || !resolveBrowserDecisionModel({ turnId: state.turnId, fullEncryptionOnly: opts.fullEncryptionOnly }, nativeDecision.modelId)))) {
    return { ok: false, errorMessage: nativeDispatchError ?? "Native decision authority or model availability changed. No request was sent." };
  }
  if (tc.name === "computer_observe" && Object.hasOwn(tc.args, "decisionPlan")) {
    const source = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
    if (!parseNativeDecisionPlan(tc.name, tc.args) || source?.tool_calls?.length !== 1
      || source.tool_calls[0]?.id !== tc.id
      || !resolveBrowserDecisionModel({ turnId: state.turnId, fullEncryptionOnly: opts.fullEncryptionOnly })) {
      return { ok: false, errorMessage: "Native delegation requires one standalone window_state call without selector, a valid decisionPlan and an available decision model. Omit decisionPlan for ordinary Computer Use. No request was sent." };
    }
  }
  if (isComputerUseToolName(tc.name) && !isSemanticComputerUse) {
    return {
      ok: false,
      errorMessage: "Error: unsupported semantic computer tool.",
      relayUnavailable: false,
    };
  }
  if (isSemanticComputerUse && computerUseRequest === null) {
    return {
      ok: false,
      errorMessage: "Error: this Computer Use contract is not active in the checked catalogue.",
      relayUnavailable: false,
    };
  }
  // is intentionally foreground-main only. This runs before relay
  // selection/prepare so forks, background tasks, and subagents cannot even
  // request a local grant selection.
  if ((isStructuredSsh || isStructuredSshOutput) && state.trustedExecutionEntrypoint !== "foreground.main") {
    return {
      ok: false,
      errorMessage: "Error: Structured SSH is available only from the main foreground conversation.",
      relayUnavailable: false,
    };
  }

  let relayId: string | undefined;
  let desktopAutomationBinding: ComputerUseInvocationBinding | undefined;
  let pairedMobileWorkspace: string | undefined;
  let pairedMobileCurrentFolder: string | undefined;
  if (isSemanticComputerUse) {
    const binding = tc.id === undefined
      ? null
      : parseComputerUseInvocationBinding(state.computerUseInvocationBindings?.[tc.id]);
    const provenance = state.desktopAutomationProvenance;
    const routeBinding = state.desktopAutomationRouteBinding;
    const origin = state.verifiedOrdinaryOrigin;
    const localOrigin = origin?.kind === "local_electron" ? origin : null;
    const expectedInvocationId = binding === null
      ? null
      : deriveComputerUseInvocationId(binding.computerUseContextId, tc);
    const authorityMismatches = [
      [binding === null, "binding_missing"],
      [expectedInvocationId === null, "invocation_id_uncomputable"],
      [binding !== null && binding.computerUseInvocationId !== expectedInvocationId, "invocation_id_mismatch"],
      [provenance == null, "provenance_missing"],
      [routeBinding == null, "route_binding_missing"],
      [provenance != null && routeBinding != null && routeBinding.grantGeneration !== provenance.grantGeneration, "route_grant_generation_mismatch"],
      [localOrigin === null, "origin_not_local_electron"],
      [state.trustedExecutionEntrypoint !== "foreground.main", "entrypoint_not_foreground_main"],
      [binding !== null && binding.originHumanId !== userId, "binding_human_mismatch"],
      [binding !== null && binding.originHumanId !== localOrigin?.userId, "origin_human_mismatch"],
      [binding !== null && provenance != null && binding.originHumanId !== provenance.originHumanId, "provenance_human_mismatch"],
      [binding !== null && binding.originAgentId !== state.agentId, "binding_agent_mismatch"],
      [binding !== null && provenance != null && binding.originAgentId !== provenance.originAgentId, "provenance_agent_mismatch"],
      [binding !== null && provenance != null && binding.originRunId !== provenance.originRunId, "run_mismatch"],
      [binding !== null && provenance != null && binding.lineageId !== provenance.lineageId, "lineage_mismatch"],
      [binding !== null && provenance != null && binding.installationEpoch !== provenance.installationEpoch, "installation_epoch_mismatch"],
      [binding !== null && provenance != null && binding.grantGeneration !== provenance.grantGeneration, "grant_generation_mismatch"],
      [binding !== null && routeBinding != null && binding.provider !== routeBinding.provider, "provider_mismatch"],
      [binding !== null && routeBinding != null && binding.providerGeneration !== routeBinding.providerGeneration, "provider_generation_mismatch"],
      [binding !== null && binding.relayId !== localOrigin?.relayId, "relay_mismatch"],
      [binding !== null && binding.desktopSessionId !== localOrigin?.desktopSessionId, "desktop_session_mismatch"],
    ].flatMap(([failed, label]) => failed ? [label as string] : []);
    if (authorityMismatches.length > 0) {
      warn(`[computer-use] pre-dispatch authority mismatch: ${authorityMismatches.join(",")}`);
      return {
        ok: false,
        errorMessage: "Error: desktop automation authority changed before execution.",
        relayUnavailable: false,
      };
    }
    relayId = binding!.relayId;
    desktopAutomationBinding = binding!;
    if (computerUseRequest === null || !computerUseContractSupportedForState(state, computerUseRequest.contract)) {
      return { ok: false, errorMessage: "Computer Use Host support changed before dispatch. Refresh the connected Host and tool catalogue; no operation was sent.", relayUnavailable: false };
    }
  }
  const taskContinuation = state.taskReportBackContinuation;
  const hasTaskContinuation = hasAvailableTaskReportBackContinuation(taskContinuation);
  if (
    !isSemanticComputerUse && policy.hostScope === "required"
    && !state.verifiedOrdinaryOrigin && !hasTaskContinuation
  ) {
    return {
      ok: false,
      errorMessage: `Error: ${tc.name} requires a verified request from an authorized computer or paired phone.`,
      relayUnavailable: false,
    };
  }
  if (!isSemanticComputerUse && policy.hostScope === "required" && hasTaskContinuation) {
    const admittedRelayId = tc.id ? state.requiredHostRelays?.[tc.id] : undefined;
    const relaySessionId = _relayRegistry.getRelaySessionId?.(taskContinuation.relayId);
    const capabilities = admittedRelayId === undefined
      ? null
      : resolveExactTaskContinuationCapabilities({
          registry: _relayRegistry,
          continuation: taskContinuation,
          userId,
          requiredRelayId: admittedRelayId,
        });
    if (
      capabilities === null
      || capabilities[capability as keyof RelayCapabilities] !== true
      || (tc.name.startsWith("browser_")
        && (!taskContinuation.browserSessionId
          || capabilities.browserSessionId !== taskContinuation.browserSessionId))
    ) {
      return {
        ok: false,
        errorMessage: `Error: ${tc.name}'s exact Task continuation is no longer live and eligible.`,
        relayUnavailable: relaySessionId === null || relaySessionId === undefined,
      };
    }
    relayId = taskContinuation.relayId;
  }
  if (!isSemanticComputerUse && state.verifiedOrdinaryOrigin && policy.hostScope === "required") {
    const admittedRelayId = tc.id ? state.requiredHostRelays?.[tc.id] : undefined;
    if (!admittedRelayId) {
      return {
        ok: false,
        errorMessage: `Error: ${tc.name} has no exact authorized computer admission for this invocation.`,
        relayUnavailable: false,
      };
    }
    if (state.verifiedOrdinaryOrigin.kind === "local_electron") {
      if (state.verifiedOrdinaryOrigin.relayId !== admittedRelayId) {
        return {
          ok: false,
          errorMessage: `Error: ${tc.name}'s authorized computer changed before execution.`,
          relayUnavailable: false,
        };
      }
      relayId = admittedRelayId;
    }
    if (
      state.verifiedOrdinaryOrigin.kind === "paired_mobile" &&
      tc.name.startsWith("browser_")
    ) {
      return {
        ok: false,
        errorMessage: "Error: browser tools are not available from paired mobile in this release.",
        relayUnavailable: false,
      };
    }
    const resolver = getOrdinaryHostResolver();
    if (state.verifiedOrdinaryOrigin.kind === "paired_mobile" && !resolver) {
      return {
        ok: false,
        errorMessage: "Error: authorized computer resolution is unavailable.",
        relayUnavailable: true,
      };
    }
    const resolution = state.verifiedOrdinaryOrigin.kind === "paired_mobile"
      ? await resolver!.resolve({
          origin: state.verifiedOrdinaryOrigin,
          toolCallId: tc.id ?? "",
          toolName: tc.name,
          relayCapability: capability,
          ...(policy.hostedBy ? { hostedBy: policy.hostedBy } : {}),
        })
      : null;
    if (resolution?.status === "unavailable") {
      return {
        ok: false,
        errorMessage: `Error: ${tc.name} is unavailable because no authorized computer is online and eligible for this operation.`,
        relayUnavailable: true,
      };
    }
    if (resolution?.status === "choice_required") {
      return {
        ok: false,
        errorMessage: `Error: ${tc.name} requires choosing an eligible computer before it can run.`,
        relayUnavailable: false,
      };
    }
    if (resolution?.status === "selected" && resolution.host.relayId !== admittedRelayId) {
      return {
        ok: false,
        errorMessage: `Error: ${tc.name}'s authorized computer changed before execution. Choose the computer again.`,
        relayUnavailable: false,
      };
    }
    if (resolution?.status === "selected") {
      relayId = admittedRelayId;
      pairedMobileWorkspace = resolution.host.workspaceRoot;
      pairedMobileCurrentFolder = resolution.host.currentFolderRoot;
    }
  }
  // -----------------------------------------------------------------
  // task 3.1.2 — WorkstationDispatchPlan relay pinning.
  //
  // Before the first-eligible / hosted-MCP relay selection, consult the
  // transient plan registry. When a plan was admitted for this tool-call id
  // (the server-side post-model override resolver selected the exact
  // active-session-bound relay and bound this tool-call id to it), pin the
  // dispatch to `plan.relayId` AFTER re-validating the bound relay is still
  // the EXACT bound relay. A stale/gone binding fails closed — the dispatch
  // is NOT silently re-routed to a different first-eligible relay, because
  // the operation was approved only for that exact workstation binding.
  //
  // The plan is admission metadata only: it selects the relay, it does NOT
  // widen `allowedRoots`, NOT replace the sandbox profile, and NOT override
  // the local Electron grant authority. `allowedRoots` / sandbox below are
  // computed from the relay caps + sandbox profile exactly as before.
  // -----------------------------------------------------------------
  const isRunShellOutputArtifact =
    tc.name === "run_shell" && tc.args["output_artifact"] !== undefined;
  const planRegistry = _workstationDispatchPlanRegistry;
  let plan = !isSemanticComputerUse && !isRunShellOutputArtifact && planRegistry
    ? planRegistry.get(tc.id ?? "")
    : null;
  // -----------------------------------------------------------------
  // same-authority re-admission for a missing / TTL-expired
  // plan. When no plan was admitted for this tool-call id (missing OR
  // lazily purged after the 5-minute TTL) but an active Full Workstation
  // session is still bound to the selected relay AND the live relay
  // fingerprint still matches that session's authority tuple, re-admit
  // ONE fresh plan for this tool-call id and retry the dispatch. This runs
  // BEFORE any relay dispatch, so side effects are known not started; the
  // caller retries at most once. Authority drift (any binding field
  // changed) is caught inside `readmit` (it revalidates the candidate plan
  // against the live fingerprint) and returns `null` — the dispatch then
  // falls through to the existing fail-closed Full Workstation gate. A bare
  // `readmit` that is not wired (legacy / earlier) is a no-op: `plan` stays
  // `null` and byte-for-byte earlier behavior is preserved.
  // -----------------------------------------------------------------
  if (
    (relayId === undefined || state.verifiedOrdinaryOrigin?.kind === "local_electron") &&
    plan === null &&
    planRegistry?.readmit !== undefined &&
    tc.name === "run_shell" &&
    !isRunShellOutputArtifact &&
    tc.args["execution"] !== "workstation"
  ) {
    const activeSession = _relayRegistry.getActiveWorkstationSession?.(userId) ?? null;
    if (activeSession !== null) {
      const refreshFingerprint = readWorkstationRelayFingerprint(activeSession.relayId);
      if (refreshFingerprint.userId !== null) {
        const readmitted = planRegistry.readmit({
          toolCallId: tc.id ?? "",
          userId,
          currentFolder: state.currentFolder ?? "",
          executionClass:
            tc.args["git"] !== undefined ? "typed_broker" : "profile_bound_sandbox",
          fingerprint: refreshFingerprint,
        });
        if (readmitted !== null) {
          log(
            `[nautilo/tools] Workstation dispatch plan for ${formatToolLogLabel(tc)} ` +
              `re-admitted under the same authority tuple (relay ${readmitted.relayId}); ` +
              `retrying the dispatch once.`,
          );
          plan = readmitted;
        }
      }
    }
  }
  if (relayId !== undefined && plan && plan.relayId !== relayId) {
    return {
      ok: false,
      errorMessage: `Error: ${tc.name} was admitted for a different workstation than the paired computer selected for this operation. Choose the computer again.`,
      relayUnavailable: false,
    };
  }
  if (plan) {
    const fingerprint = readWorkstationRelayFingerprint(plan.relayId);
    const revalidation = planRegistry!.revalidate(plan, fingerprint);
    if (!revalidation.ok) {
      warn(
        `[nautilo/tools] Workstation dispatch plan for ${formatToolLogLabel(tc)} ` +
          `bound relay ${plan.relayId} failed re-validation ` +
          `(${revalidation.reason}); refusing to re-route to a different relay.`,
      );
      // Fail closed. The operation was approved only for the exact bound
      // relay; a stale binding never falls back to another eligible relay.
      // `relay_not_connected` is a relay-vanished mid-run failure for
      // Task runs; the other drift reasons are binding-stale denials. The
      // structured disposition block carries the cause / retry-safety /
      // recovery action for the agent + UI; the human fallback copy stays
      // stable for existing readers.
      return {
        ok: false,
        errorMessage:
          `Error: ${tc.name} was approved for a specific workstation relay ` +
          `(${plan.relayId}) that is no longer the exact bound relay ` +
          `(${revalidation.reason}). Re-approve the operation on the ` +
          `currently bound workstation relay.` +
          renderWorkstationShellDisposition(
            revalidation.reason === "relay_not_connected"
              ? {
                  kind: "offline",
                  retrySafe: false,
                  action: "reconnect_relay",
                  detail: `relay ${plan.relayId} is not connected`,
                }
              : {
                  kind: "approval_required",
                  retrySafe: false,
                  driftReason: revalidation.reason,
                  action: "re_authorize",
                  detail: `relay ${plan.relayId} binding drifted (${revalidation.reason})`,
                  currentFolder: state.currentFolder ?? "",
                },
          ),
        relayUnavailable: revalidation.reason === "relay_not_connected",
      };
    }
    // Current Folder coherence. The plan pinned the Current
    // Folder the operation was admitted for; a drift to a different live
    // Current Folder is an authority change. Fail closed and require
    // re-authorization on the currently selected Current Folder. The plan
    // never silently re-binds to a new Current Folder and never broadens
    // roots (the sandbox profile below is computed exactly as before).
    if (
      plan.currentFolder !== undefined &&
      plan.currentFolder.length > 0 &&
      state.currentFolder !== plan.currentFolder
    ) {
      warn(
        `[nautilo/tools] Workstation dispatch plan for ${formatToolLogLabel(tc)} ` +
          `was admitted for Current Folder ${plan.currentFolder} but the live ` +
          `Current Folder is ${state.currentFolder ?? ""}; refusing to re-bind.`,
      );
      return {
        ok: false,
        errorMessage:
          `Error: ${tc.name} was approved for Current Folder ` +
          `"${plan.currentFolder}" but the live Current Folder is ` +
          `"${state.currentFolder ?? ""}". Re-approve the operation on the ` +
          `currently selected Current Folder.` +
          renderWorkstationShellDisposition({
            kind: "approval_required",
            retrySafe: false,
            driftReason: "current_folder_drift",
            action: "re_authorize",
            detail: `Current Folder drifted from ${plan.currentFolder} to ${state.currentFolder ?? ""}`,
            currentFolder: state.currentFolder ?? "",
          }),
        relayUnavailable: false,
      };
    }
    // Hosted MCP tools are already pinned to an owning relay; a plan that
    // pins a DIFFERENT relay is a binding conflict — fail closed rather
    // than dispatching to either under a mismatched admission.
    if (policy.hostedBy && policy.hostedBy !== plan.relayId) {
      warn(
        `[nautilo/tools] Workstation dispatch plan for ${formatToolLogLabel(tc)} ` +
          `pins relay ${plan.relayId} but the MCP tool is hosted on ${policy.hostedBy}; ` +
          `refusing the mismatched dispatch.`,
      );
      return {
        ok: false,
        errorMessage:
          `Error: ${tc.name} workstation dispatch plan pins relay ${plan.relayId} ` +
          `but the tool is hosted on relay ${policy.hostedBy}.`,
        relayUnavailable: true,
      };
    }
    relayId = plan.relayId;
  } else if (relayId !== undefined) {
    // Exact ordinary-origin resolution already selected and revalidated the
    // Relay. Downstream sandbox and local authority checks still apply.
  } else if (policy.hostedBy) {
    // relay-hosted MCP tool: PIN to the owning relay. SEC6
    // defense-in-depth: only dispatch if that relay is connected FOR THIS
    // USER (a relay the requesting user doesn't own is never a valid target,
    // even though C6 visibility already prevents cross-user tool exposure).
    const userRelays = _relayRegistry.findByCapabilityForUser("canReadWorkspace", userId);
    if (!userRelays.includes(policy.hostedBy)) {
      warn(`[nautilo/tools] MCP tool ${formatToolLogLabel(tc)} hosted on relay ${policy.hostedBy}, not connected for user ${userId}`);
      return {
        ok: false,
        errorMessage: `Error: ${tc.name} runs on a local MCP server that isn't connected right now. Start the relay hosting it and try again.`,
        relayUnavailable: true,
      };
    }
    relayId = policy.hostedBy;
  } else {
    const relays = _relayRegistry.findByCapabilityForUser(capability, userId);
    const eligibleRelays = relays;

    if (eligibleRelays.length === 0) {
      const requiredRelayCapability = capability;
      warn(`[nautilo/tools] Relay tool ${formatToolLogLabel(tc)} called but no relay with ${requiredRelayCapability} connected for user ${userId}`);
      return {
        ok: false,
        errorMessage: `Error: ${tc.name} requires a connected relay with ${requiredRelayCapability}. Connect a desktop app or run nautilo-relay to enable this tool.`,
        // the relay-vanished-mid-run case : live at run start, gone now.
        relayUnavailable: true,
      };
    }
    relayId = eligibleRelays[0]!;
  }
  log(`[nautilo/tools] Dispatching via relay (${relayId}): ${formatToolLogLabel(tc)}`);

  let structuredSsh: {
    readonly args: Record<string, unknown>;
    readonly binding: RelaySshDispatchBindingV1;
  } | undefined;
  if (isStructuredSsh) {
    if (tc.name !== "structured_ssh_auth") {
      const timeout = resolveStructuredSshTimeout(tc.args);
      if (!timeout.ok) {
        return { ok: false, errorMessage: `Error: ${timeout.error}`, relayUnavailable: false };
      }
    }
    const approved = structuredSshApprovedDispatch(tc, opts.toolCallId ?? tc.id);
    const actorRole = state.actorRole === "owner" || state.actorRole === "admin"
      ? state.actorRole
      : null;
    const actorId = state.memoryAccessEnvelope?.actorId ?? userId;
    const agentId = state.agentId ?? "";
    if (approved === null) {
      return {
        ok: false,
        errorMessage: structuredSshPreEffectFailure(
          "request_invalid",
          "The program, argv, destination, or tool-call identifier did not satisfy the structured SSH contract.",
          "Correct the rejected request fields and retry; do not re-enable SSH or create another connection.",
        ),
        relayUnavailable: false,
      };
    }
    if (actorRole === null) {
      return {
        ok: false,
        errorMessage: structuredSshPreEffectFailure(
          "actor_role_not_authorized",
          "The signed-in Human is not an owner or admin authorized to delegate this capability.",
          "Use an authorized account; changing the SSH connection will not repair this.",
        ),
        relayUnavailable: false,
      };
    }
    if (actorId.length === 0 || agentId.length === 0) {
      return {
        ok: false,
        errorMessage: structuredSshPreEffectFailure(
          "session_identity_missing",
          "The current foreground turn is missing its exact Human or Genie identity binding.",
          "Start a fresh foreground turn after the session identity is restored; do not guess an identity.",
        ),
        relayUnavailable: false,
      };
    }
    if (_relayRegistry.prepareStructuredSsh === undefined) {
      return {
        ok: false,
        errorMessage: structuredSshPreEffectFailure(
          "desktop_prepare_unsupported",
          "The connected desktop relay does not implement structured SSH preparation.",
          "Update or reconnect that desktop; changing the SSH connection will not repair this.",
        ),
        relayUnavailable: true,
      };
    }
    const instanceId = resolveInstance().instanceId;
    const expected = {
      relayId,
      instanceId,
      userId,
      actorId,
      actorRole,
      agentId,
      toolCallId: approved.toolCallId,
      approvedRequestDigest: approved.approvedRequestDigest,
      operation: approved.operation,
      destination: approved.destination,
    } as const;
    let pending = pendingStructuredSshHumanApprovals.get(approved.toolCallId);
    if (pending !== undefined && !sameStructuredSshHumanApproval(pending, expected)) {
      pendingStructuredSshHumanApprovals.delete(approved.toolCallId);
      pending = undefined;
    }
    if (pending === undefined) {
      const preparation = await prepareStructuredSshExact(_relayRegistry, relayId, expected, approved);
      if (!preparation.ok) {
        return {
          ok: false,
          errorMessage: preparation.errorMessage,
          relayUnavailable: false,
        };
      }
      if (!isExactStructuredSshPrepareResponse(preparation.prepared, expected)) {
        return {
          ok: false,
          errorMessage: structuredSshPreEffectFailure(
            "prepare_response_mismatch",
            "The desktop returned a preparation for different request or identity facts.",
            "Retry once on the same foreground turn; if it persists, report the desktop/server binding mismatch.",
          ),
          relayUnavailable: false,
        };
      }
      if (pendingStructuredSshHumanApprovals.size >= SSH_HUMAN_APPROVAL_MAX_ENTRIES) {
        return {
          ok: false,
          errorMessage: structuredSshPreEffectFailure(
            "approval_capacity_exhausted",
            "The bounded in-process SSH review registry is full.",
            "Finish or cancel outstanding SSH reviews, then retry; do not create another connection.",
          ),
          relayUnavailable: false,
        };
      }
      pending = {
        approvalId: `${SSH_HUMAN_APPROVAL_PREFIX}${randomUUID()}`,
        prepared: preparation.prepared,
        expected,
        args: approved.args,
        requiresHumanReview: !shouldAutoApproveStructuredSsh(
          state.autoApprove,
          preparation.prepared.approval.hostTrust,
        ),
      };
      pendingStructuredSshHumanApprovals.set(approved.toolCallId, pending);
    }
    if (pending === undefined) {
      return {
        ok: false,
        errorMessage: structuredSshPreEffectFailure(
          "approval_state_missing",
          "The exact in-process SSH review state disappeared before authorization.",
          "Retry the exact operation once; if it persists, report an approval lifecycle defect.",
        ),
        relayUnavailable: false,
      };
    }
    const trustedHostAutoApproved = !pending.requiresHumanReview && shouldAutoApproveStructuredSsh(
      state.autoApprove,
      pending.prepared.approval.hostTrust,
    );
    if (!trustedHostAutoApproved) {
      // LangGraph replays interrupt calls from the start of the node. During a
      // chained multi-tool turn, it can therefore hand this call the previous
      // tool's accepted receipt. Re-issuing this same exact interrupt parks the
      // current approval ID; it never converts the prior receipt into authority
      // for this call. The helper bounds that retry to one re-park.
      const pendingForApproval = pending;
      const approvalOutcome = resolveStructuredSshHumanApprovalReplay(
        () => consumeStructuredSshHumanApproval(pendingForApproval),
      );
      if (approvalOutcome !== "approved") {
        pendingStructuredSshHumanApprovals.delete(approved.toolCallId);
        return {
          ok: false,
          errorMessage: "Error: Structured SSH approval was denied or is no longer current.",
          relayUnavailable: false,
        };
      }
      // A Human decision authorizes only the exact summary they saw, never a
      // now-expired Electron handle. Refresh after each manual approval. The
      // fresh one-use handle dispatches transparently only when the complete
      // summary and dynamic subject/topology/capability tuple are unchanged.
      // A valid drift re-parks an exact new review; an invalid refresh is a
      // typed pre-effect stale-review recovery rather than old authority.
      while (true) {
        const refresh = await prepareStructuredSshExact(_relayRegistry, relayId, expected, approved);
        if (!refresh.ok) {
          pendingStructuredSshHumanApprovals.delete(approved.toolCallId);
          return {
            ok: false,
            errorMessage: refresh.errorMessage,
            relayUnavailable: false,
          };
        }
        if (!isExactStructuredSshPrepareResponse(refresh.prepared, expected)) {
          pendingStructuredSshHumanApprovals.delete(approved.toolCallId);
          return {
            ok: false,
            errorMessage: structuredSshReviewStaleRecovery(),
            relayUnavailable: false,
          };
        }
        if (classifyStructuredSshPreparationRefresh(pending.prepared, refresh.prepared) === "unchanged") {
          pending = { ...pending, prepared: refresh.prepared };
          pendingStructuredSshHumanApprovals.set(approved.toolCallId, pending);
          break;
        }

        // The old receipt never applies to a changed summary or binding.
        // Give the Human the exact fresh facts, then renew again after that
        // approval before dispatching its one-use Electron preparation.
        pending = {
          ...pending,
          approvalId: `${SSH_HUMAN_APPROVAL_PREFIX}${randomUUID()}`,
          prepared: refresh.prepared,
        };
        pendingStructuredSshHumanApprovals.set(approved.toolCallId, pending);
        const pendingForRefreshedApproval = pending;
        const refreshedApprovalOutcome = resolveStructuredSshHumanApprovalReplay(
          () => consumeStructuredSshHumanApproval(pendingForRefreshedApproval),
        );
        if (refreshedApprovalOutcome !== "approved") {
          pendingStructuredSshHumanApprovals.delete(approved.toolCallId);
          return {
            ok: false,
            errorMessage: "Error: Structured SSH approval was denied or is no longer current.",
            relayUnavailable: false,
          };
        }
      }
    } else {
      log(`[nautilo/tools] Structured SSH auto-approved for trusted host (${approved.operation})`);
    }
    // A resume can consume this exact record only once. Electron independently
    // enforces the final one-use preparation replay barrier.
    pendingStructuredSshHumanApprovals.delete(approved.toolCallId);
    structuredSsh = {
      args: approved.args,
      binding: {
        version: RELAY_SSH_DISPATCH_BINDING_VERSION,
        admissionId: `ssh-admission-${randomUUID()}`,
        toolCallId: approved.toolCallId,
        approvedRequestDigest: approved.approvedRequestDigest,
        operation: approved.operation,
        preparationId: pending.prepared.preparationId,
        subject: pending.prepared.subject,
      },
    };
  }

  // Sprint 1 G5.4.b — build the per-turn sandbox envelope from
  // server-enforced posture + relay-reported paths. : this is the
  // SINGLE dispatch seam — a Task-origin relay call (subagent/`taskRun`) and a
  // foreground turn build the profile identically (keyed on `resolveLaneKey` +
  // relay caps, with no task-vs-foreground branch), so sandbox /
  // six-layer ladder applies the same for background runs. Returns null if
  // the relay hasn\u0027t reported dataDir / toolsBin yet (older client
  // pre-G5.4.c); we log + dispatch without an envelope. Release
  // builds will refuse that dispatch once G5.4.c lands the guard.
  const relayCaps = isStructuredSsh ? undefined : _relayRegistry.getCapabilities(relayId);
  let sandboxProfile = undefined;
  if (!isStructuredSsh && relayCaps) {
    const laneKey = resolveLaneKey(state);
    const built = buildRelaySandboxProfile({
      posture: resolveServerPosture(),
      relayCaps,
      currentFolder:
        state.verifiedOrdinaryOrigin?.kind === "paired_mobile"
          ? (pairedMobileCurrentFolder ?? null)
          : state.currentFolder,
      extraWritablePaths: [
        ...approvedWritablePathsForLane(laneKey),
        ...(state.verifiedOrdinaryOrigin?.kind === "paired_mobile" &&
        pairedMobileWorkspace !== undefined &&
        pairedMobileWorkspace !== pairedMobileCurrentFolder
          ? [pairedMobileWorkspace]
          : []),
      ],
      extraNetworkAllowRules: [
        ...approvedNetworkAllowRulesForLane(laneKey),
        ...consumeOneShotNetworkAllowRulesForTool(laneKey, approvalToolKey(tc)),
        ...(opts.extraNetworkAllowRules ?? []),
      ],
    });
    if (built === null) {
      warn(
        `[nautilo/tools] Relay ${relayId} did not report the paths ` +
          `needed to build a sandbox profile (dataDir / toolsBin / ` +
          `workspace). Dispatching without an envelope — G5.4.c will ` +
          `make this a hard failure in release builds.`,
      );
    } else {
      sandboxProfile = built;
    }
  }

  // run_shell tiered timeout . Only run_shell carries timeout_seconds.
  // The resolver enforces: ≤soft free, soft→hard needs a non-empty
  // timeout_reason, >hard refused. A Human approval surface receives that
  // reason as first-class intent; auto execution has no Human judge, so it is
  // execution-intent/audit information. On a violation we return a coherent
  // error WITHOUT dispatching (no silent clamp). undefined timeoutMs omits the
  // key so the relay applies its 60s default.
  let timeoutMs: number | undefined;
  if (tc.name === "run_shell") {
    const isOutputArtifact = tc.args["output_artifact"] !== undefined;
    const resolved = resolveRunShellTimeout(tc.args);
    if (!resolved.ok) {
      return { ok: false, errorMessage: resolved.error };
    }
    if (!isOutputArtifact) {
      timeoutMs = resolved.timeoutMs;
    }
  }
  if (structuredSsh !== undefined && typeof structuredSsh.args["timeoutSeconds"] === "number") {
    timeoutMs = structuredSsh.args["timeoutSeconds"] * 1_000;
  }

  // run_shell admits exactly one of raw `command`, structured `git`,
  // or bounded Desktop-local `output_artifact` continuation retrieval. The
  // LLM-facing Zod schema enforces this with a superRefine, but relay tools
  // dispatch through `args` WITHOUT a schema parse, so re-check here at the
  // dispatch seam and return a coherent error WITHOUT dispatching on a
  // violation. A raw `command: "git ..."` is intentionally NOT promoted into
  // the broker — it stays a raw command and flows through the ordinary sandbox
  // below with no metadata/template exception.
  if (tc.name === "run_shell") {
    const hasCommand = typeof tc.args["command"] === "string" && tc.args["command"].length > 0;
    const hasGit = tc.args["git"] !== undefined;
    const hasOutputArtifact = tc.args["output_artifact"] !== undefined;
    if (Number(hasCommand) + Number(hasGit) + Number(hasOutputArtifact) !== 1) {
      return {
        ok: false,
        errorMessage:
          "Error: run_shell requires exactly one of `command`, `git`, or `output_artifact`.",
      };
    }
    if (!hasCommand && tc.args["execution"] !== undefined) {
      return {
        ok: false,
        errorMessage:
          "Error: run_shell execution is available only for raw `command`.",
      };
    }
  }

  // adds a seamless server-owned lane for ordinary raw commands that do
  // not select an execution mode. Existing internal callers that explicitly
  // request the Full Workstation or sandbox lane retain their prior semantics.
  // The model-facing schema no longer requires or advertises this selector.
  const explicitlyRequestedRealWorkstation =
    tc.name === "run_shell" && tc.args["execution"] === "workstation";
  let isRealWorkstationRunShell = explicitlyRequestedRealWorkstation;
  let uncontainedActivationSignal: AbortSignal | undefined;
  const origin = state.verifiedOrdinaryOrigin;
  const localOrigin = origin?.kind === "local_electron" ? origin : null;
  const isUncontainedCandidate =
    tc.name === "run_shell" &&
    typeof tc.args["command"] === "string" &&
    tc.args["command"].length > 0 &&
    tc.args["git"] === undefined &&
    tc.args["output_artifact"] === undefined &&
    tc.args["execution"] === undefined &&
    state.trustedExecutionEntrypoint === "foreground.main" &&
    localOrigin !== null &&
    localOrigin.userId === userId &&
    localOrigin.relayId === relayId;
  if (isUncontainedCandidate) {
    const resolver = defaultPostModelDeps.resolveUncontainedHostCommandsDispatch;
    if (resolver !== undefined) {
      const request: UncontainedHostCommandsDispatchRequest = {
        userId,
        actorId: state.memoryAccessEnvelope?.actorId ?? userId,
        toolCallId: tc.id ?? "",
        relayId,
        foregroundLocalElectron: {
          userId: localOrigin.userId,
          actorId: localOrigin.actorId,
          relayId: localOrigin.relayId,
          desktopSessionId: localOrigin.desktopSessionId,
          pairingGeneration: localOrigin.pairingGeneration,
        },
        clientMeta: state.securityAuditClientMeta ?? null,
      };
      try {
        const decision = await resolver(request);
        if (decision.admitted && decision.executionClass === "real_workstation") {
          isRealWorkstationRunShell = true;
          uncontainedActivationSignal = decision.activationSignal;
        }
      } catch (err) {
        warn(
          `[nautilo/tools] Uncontained host command resolution failed for ${formatToolLogLabel(tc)}: ` +
            `${err instanceof Error ? err.message : String(err)}; retaining contained execution.`,
        );
      }
    }
  }
  const dispatchArgs = isRealWorkstationRunShell
    ? { ...tc.args, execution: "workstation" }
    : tc.args;
  const securityScanRequest = tc.name === "security_scan"
    ? buildSecurityScanRelayRequest(tc.args, state, opts.toolCallId ?? tc.id ?? "", opts.resolvedModelId)
    : null;
  if (securityScanRequest?.ok === false) {
    return {
      ok: false,
      errorMessage: securityScanRequest.errorMessage,
      relayUnavailable: false,
    };
  }
  const trustedDispatchArgs = securityScanRequest?.ok === true
    ? securityScanRequest.request
    : dispatchArgs;

  // task 3.1.3b — when a WorkstationDispatchPlan pinned this dispatch AND
  // the tool is a generic `run_shell`, attach the plan-bound shell-binding
  // envelope. It carries ONLY the opaque ids / binding / operation metadata the
  // desktop relay needs to prove the dispatch maps to the active
  // profile/session grant authority — no roots, no paths. The relay revalidates
  // every field against its live Electron state and may use profile-bound roots
  // only after that revalidation succeeds. The plan never widens
  // `allowedRoots` (computed above exactly as before); the binding is admission
  // metadata only.
  const shellBinding =
    plan !== null && tc.name === "run_shell" && !isRealWorkstationRunShell && !isRunShellOutputArtifact
      ? (buildWorkstationShellBindingFromPlan(plan, tc.id ?? "") ?? undefined)
      : undefined;

  // protected-shell enforcement — a Full Workstation eligible relay
  // (one advertising an active Workstation Profile binding snapshot) must
  // NEVER run a generic `run_shell` through the server's sandbox envelope,
  // which carries no `protectedPaths`. `protectedPaths` enter the sandbox
  // ONLY through the plan-bound `workstationShellBinding` path above. So
  // when the selected relay is Full Workstation eligible AND this run_shell
  // has no valid plan-bound binding (missing or stale plan / session), fail
  // closed with a stable error rather than dispatch an unprotected shell.
  //
  // reconnect/session split-brain fix — the gate ALSO fails closed
  // when an active Full Workstation session is bound to the selected relay
  // EVEN IF the relay's profile snapshot is absent. A reconnect that
  // re-registered frozen pre-activation capabilities (or a capability
  // refresh that transiently cleared the snapshot) can leave the server
  // relay registry's profile snapshot null while the session remains
  // active; without this session-aware check the gate would skip and
  // dispatch an unbound generic shell under the active session. The
  // snapshot-cleared invalidation seam is the primary defense; this is the
  // defense-in-depth at the dispatch seam. Non-Full-Mode behavior is
  // byte-for-byte preserved: no advertised profile + no active session
  // bound here ⇒ the generic sandbox path remains valid.
  if (tc.name === "run_shell" && !isRealWorkstationRunShell &&
    !isRunShellOutputArtifact && shellBinding === undefined) {
    const advertisedProfile =
      _relayRegistry.getWorkstationProfileSnapshot?.(relayId) ?? null;
    const activeSession =
      _relayRegistry.getActiveWorkstationSession?.(userId) ?? null;
    const sessionBoundHere =
      activeSession !== null && activeSession.relayId === relayId;
    if (advertisedProfile !== null || sessionBoundHere) {
      const reason =
        advertisedProfile !== null
          ? `profile ${advertisedProfile.profileId}@${advertisedProfile.profileRevision}`
          : `active Full Workstation session bound to relay ${relayId} ` +
            `(profile snapshot absent — split-brain)`;
      const liveRevision = _relayRegistry.getCapabilityRevision?.(relayId) ?? null;
      const revisionRolledBack = sessionBoundHere && liveRevision !== null &&
        liveRevision < activeSession.capabilityRevision;
      const bindingDetail = revisionRolledBack
        ? `Relay capability revision rolled back from active session ${activeSession.capabilityRevision} to ${liveRevision}; workstation session requires reconciliation`
        : `no valid plan-bound shell binding for relay ${relayId} (${reason})`;
      warn(
        `[nautilo/tools] Refusing generic run_shell dispatch to Full Workstation ` +
          `relay ${relayId} (${reason}) without a valid plan-bound shell ` +
          `binding; ${bindingDetail}; protectedPaths require the plan-bound path.`,
      );
      return {
        ok: false,
        errorMessage:
          `Error: ${tc.name} cannot run on Full Workstation relay ${relayId} ` +
          `without a valid plan-bound shell binding. The operation was not ` +
          `admitted against the currently bound workstation session ` +
          (revisionRolledBack
            ? `because the Relay Host capability revision reset (${activeSession.capabilityRevision} → ${liveRevision}). Restore Workstation access in Settings before retrying; approving the same command again cannot repair this binding.`
            : `(missing or stale plan). Re-approve the operation on the currently bound workstation relay.`) +
          renderWorkstationShellDisposition({
            kind: "approval_required",
            retrySafe: false,
            driftReason: revisionRolledBack ? "capability_revision_mismatch" : "no_plan",
            action: "re_authorize",
            detail: bindingDetail,
            currentFolder: state.currentFolder ?? "",
          }),
      };
    }
  }

  // pairs the already-existing enclosing Job signal with the exact
  // process-memory activation fence. The combined signal never crosses the
  // relay protocol; `InMemoryRelayRegistry` already turns it into one exact
  // cancellation correlation. Keep the original signal byte-for-byte for
  // every other dispatch.
  const dispatchAbortController = uncontainedActivationSignal === undefined
    ? null
    : new AbortController();
  const dispatchAbortSources = dispatchAbortController === null
    ? []
    : [opts.signal, uncontainedActivationSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
  const abortDispatch = () => dispatchAbortController?.abort();
  for (const signal of dispatchAbortSources) {
    signal.addEventListener("abort", abortDispatch, { once: true });
    if (signal.aborted) abortDispatch();
  }
  const dispatchSignal = dispatchAbortController?.signal ?? opts.signal;

  try {
    const dispatchAllowedRoots =
      isStructuredSsh || isStructuredSshOutput
        ? undefined
        : sandboxProfile !== undefined
        ? [
            sandboxProfile.workspace,
            ...(relayCaps?.allowedRoots ?? []).filter(
              (root) => root !== sandboxProfile.workspace,
            ),
          ]
        : relayCaps?.allowedRoots;
    const relayDispatchArgs = { ...dispatchArgs };
    if (tc.name === "computer_observe") delete relayDispatchArgs["decisionPlan"];
    if (tc.name.startsWith("browser_")) {
      if (tc.name === "browser_snapshot" && browserPlan?.kind === "plan") {
        const source = [...state.messages].reverse().find((message) => AIMessage.isInstance(message));
        if (source?.tool_calls && (source.tool_calls.length !== 1 || source.tool_calls[0]?.id !== (opts.toolCallId ?? tc.id))) {
          return { ok: false, errorMessage: browserDecisionPlanError(null, "decision_plan_requires_singleton",
            "Send browser_snapshot with decisionPlan as its own tool call, after preceding tools finish. No browser request was sent for this delegation; other calls in the batch may execute normally.") };
        }
        if (!resolveBrowserDecisionModel({ turnId: state.turnId, fullEncryptionOnly: opts.fullEncryptionOnly })) {
          return { ok: false, errorMessage: "Routine browser decisions are unavailable. Omit decisionPlan and use ordinary browser tools; no browser request was sent." };
        }
      }
      // Model-visible plans remain in the graph; only server-owned bindings cross the relay.
      delete relayDispatchArgs["decisionPlan"];
      if (tc.name === "browser_snapshot" && browserPlan?.kind === "plan" && browserPlan.source === "top_level") {
        for (const key of Object.keys(browserDecisionPlanSchema.shape)) delete relayDispatchArgs[key];
      }
      delete relayDispatchArgs["_requiredSession"];
      delete relayDispatchArgs["_requiredObservationId"];
      if (hasTaskContinuation && taskContinuation.browserSessionId) {
        relayDispatchArgs["_requiredSession"] = taskContinuation.browserSessionId;
      }
      const decision = currentBrowserDecision(state);
      const pending = decision?.pending;
      if (pending && pending.call.id === (opts.toolCallId ?? tc.id)) {
        if (decision?.phase !== "waiting" || pending.call.name !== tc.name
          || JSON.stringify(pending.call.args) !== JSON.stringify(tc.args)
          || !resolveBrowserDecisionModel({ turnId: state.turnId, fullEncryptionOnly: opts.fullEncryptionOnly }, decision.modelId)
          || (relayDispatchArgs["_requiredSession"] !== undefined
            && relayDispatchArgs["_requiredSession"] !== pending.browserSessionId)) {
          return { ok: false, errorMessage: "Browser decision binding changed; return to the Genie for fresh observation." };
        }
        relayDispatchArgs["_requiredSession"] = pending.browserSessionId;
        if (pending.observationId !== null) relayDispatchArgs["_requiredObservationId"] = pending.observationId;
      }
    }
    const result = await _relayRegistry.dispatch(relayId, {
      toolName: isStructuredSsh ? "ssh" : tc.name,
      args: structuredSsh?.args ?? (tc.name === "security_scan" ? trustedDispatchArgs : relayDispatchArgs),
      ...(tc.name === "security_scan" && state.currentTaskId && state.currentTaskRunId ? {
        onSecurityScanProgress: (progress: RelaySecurityScanProgressMessage) => emitAgentEvent({
          type: "task.progress", taskId: state.currentTaskId!, taskRunId: state.currentTaskRunId!,
          ownerId: state.userId, detail: securityScanProgressText(progress),
          preparation: { stage: progress.stage, ...(progress.probe ? { probe: progress.probe } : {}),
            ...(progress.stage === "inventory_progress" && typeof progress.filesObserved === "number"
              && typeof progress.directoriesObserved === "number" ? { filesObserved: progress.filesObserved,
              directoriesObserved: progress.directoriesObserved } : {}) },
        }),
      } : {}),
      impact: policy.impact as "read-only" | "low" | "high" | "destructive",
      approvalObtained: true,
      ...(policy.hostedBy ? { hostedBy: policy.hostedBy } : {}),
      allowedRoots: dispatchAllowedRoots,
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      sandboxProfile,
      ...(isRealWorkstationRunShell
        ? { executionClass: "real_workstation" as const }
        : isStructuredSsh
          ? { executionClass: "structured-ssh" as const }
        : isStructuredSshOutput
          ? { executionClass: "desktop" as const }
        : isSemanticComputerUse
          ? { executionClass: "computer_use" as const }
        : isBrowserTool(tc.name)
          ? { executionClass: "browser" as const }
          : {}),
      ...(shellBinding !== undefined ? { workstationShellBinding: shellBinding } : {}),
      ...(uncontainedActivationSignal !== undefined
        ? { uncontainedHostCommandsSession: true as const }
        : {}),
      ...(structuredSsh !== undefined ? { sshBinding: structuredSsh.binding } : {}),
      ...(desktopAutomationBinding !== undefined ? { desktopAutomationBinding } : {}),
      ...(computerUseRequest !== null ? { computerUseRequest } : {}),
      ...(hasTaskContinuation && policy.hostScope === "required"
        ? {
            requiredRelaySessionId: taskContinuation.relaySessionId,
            requiredDesktopSessionId: taskContinuation.desktopSessionId,
            requiredPairingGeneration: taskContinuation.pairingGeneration,
          }
        : {}),
      ...(tc.name === "run_shell" && opts.toolCallId !== undefined && !state.suppressToolLifecycleEvents
        ? {
            onRunShellProgress: (progress: RelayRunShellProgressMessage) => {
              const event: ToolRunShellProgressEvent = {
                type: "tool.run_shell.progress",
                ...(resolveLaneKey(state) ? { laneKey: resolveLaneKey(state) } : {}),
                ...(state.agentId ? { authorAgentId: state.agentId } : {}),
                ...(state.turnId ? { turnId: state.turnId } : {}),
                toolCallId: opts.toolCallId!,
                version: progress.version,
                sequence: progress.sequence,
                stream: progress.stream,
                offsetBytes: progress.offsetBytes,
                endOffsetBytes: progress.endOffsetBytes,
                text: progress.text,
                ...(progress.droppedBytes !== undefined ? { droppedBytes: progress.droppedBytes } : {}),
                elapsedMs: progress.elapsedMs,
                phase: progress.phase,
              };
              emitAgentEvent(event);
            },
          }
        : {}),
      ...(isStructuredSsh && opts.toolCallId !== undefined && !state.suppressToolLifecycleEvents
        ? {
            onStructuredSshProgress: (progress: RelayStructuredSshProgressMessage) => {
              const provenance = {
                ...(resolveLaneKey(state) ? { laneKey: resolveLaneKey(state) } : {}),
                ...(state.agentId ? { authorAgentId: state.agentId } : {}),
                ...(state.turnId ? { turnId: state.turnId } : {}),
                toolCallId: opts.toolCallId!,
                version: progress.version,
                sequence: progress.sequence,
                elapsedMs: progress.elapsedMs,
              };
              const event: ToolStructuredSshProgressEvent = progress.kind === "exec-output"
                ? {
                    type: "tool.structured_ssh.progress",
                    ...provenance,
                    operation: progress.operation,
                    kind: "exec-output",
                    stream: progress.stream,
                    offsetBytes: progress.offsetBytes,
                    endOffsetBytes: progress.endOffsetBytes,
                    text: progress.text,
                    ...(progress.droppedBytes !== undefined ? { droppedBytes: progress.droppedBytes } : {}),
                    phase: progress.phase,
                  }
                : {
                    type: "tool.structured_ssh.progress",
                    ...provenance,
                    operation: progress.operation,
                    kind: "transfer",
                    phase: progress.phase,
                    transferredBytes: progress.transferredBytes,
                    ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {}),
                  };
              emitAgentEvent(event);
            },
          }
        : {}),
      ...(((tc.name === "run_shell" && typeof tc.args["command"] === "string")
        || isStructuredSsh
        || isSemanticComputerUse
        || tc.name.startsWith("browser_")
        || tc.name === "security_scan") && dispatchSignal
        ? { signal: dispatchSignal }
        : {}),
    });

    // `resolveDispatch` handed us the particular activation object that
    // admitted this command. A later activation must not make an old result
    // valid again: its permanently aborted signal fences every receipt,
    // including a success that raced the cancel frame.
    if (uncontainedActivationSignal?.aborted) {
      return {
        ok: false,
        errorMessage: uncontainedHostOutcomeUnknownGuidance(),
        runShellOutcome: "unknown" as const,
      };
    }

    if (result.status === "error") {
      if (tc.name.startsWith("browser_")) {
        const code = result.errorCode;
        if (code === "browser_observation_stale" || code === "browser_cancelled" || code === "browser_authority_lost"
          || code === "browser_outcome_unknown" || code === "browser_observation_invalid") {
          return { ok: false, errorMessage: formatRelayToolError(tc, result), browserFailure: code };
        }
      }
      warn(`[nautilo/tools] Relay tool ${formatToolLogLabel(tc)} returned error: ${result.error}`);
      if (result.networkDeniedDestination !== undefined) {
        return {
          ok: false,
          errorMessage: formatRelayToolError(tc, result),
          networkDenied: networkContextFromDeniedDestination(result.networkDeniedDestination),
        };
      }
      if (tc.name === "google_workspace" && relayResultErrorCode(result) === "google_auth_required") {
        return {
          ok: false,
          errorMessage: formatGoogleAuthRequiredRelayError(result.error),
        };
      }
      return {
        ok: false,
        errorMessage: formatRelayToolError(tc, result),
      };
    }

    if (isRelayVisionResult(result.result)) {
      const { kind, text, image } = result.result;
      return {
        ok: true,
        multimodal: { kind, text, image: { mime: image.mime, base64: image.base64 } },
      };
    }

    if (tc.name === "security_scan") {
      const parsed = securityScanToolResultSchema.safeParse(result.result);
      if (!parsed.success) {
        return {
          ok: false,
          errorMessage: "Error: security_scan returned an invalid Desktop result.",
          relayUnavailable: false,
        };
      }
      const researchStatus = parsed.data.ok
        ? (parsed.data.operation === "start" || parsed.data.operation === "status"
          ? parsed.data.result : parsed.data.operation === "results" ? parsed.data.result.status : null)
        : null;
      if (researchStatus?.mode === "deep_research" && !researchStatus.researchProgress) {
        const message = "The connected Desktop predates accountable research. Update that Desktop before continuing this audit; no comprehensive report was qualified.";
        return { ok: true, rawContent: JSON.stringify({ ok: false, operation: parsed.data.operation,
          error: { code: "desktop_upgrade_required", retryable: false, message } }), toolError: message };
      }
      return { ok: true, rawContent: JSON.stringify(parsed.data),
        ...(parsed.data.ok ? {} : { toolError: parsed.data.error.message }) };
    }

    const rawContent = typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result);
    return { ok: true, rawContent };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    warn(`[nautilo/tools] Relay dispatch for ${formatToolLogLabel(tc)} failed: ${msg}`);
    const structuredSshOutcomeUnknown = isStructuredSsh && isStructuredSshOutcomeUnknown(error);
    const browserMutationOutcomeUnknown = browserToolMayMutate(tc.name) && isDesktopAutomationOutcomeUnknown(error);
    const desktopMutationOutcomeUnknown =
      isSemanticComputerUse && computerUseRequest?.contract.effectClass !== "read" && isDesktopAutomationOutcomeUnknown(error);
    // A pre-send activation abort is a known cancellation: the registry
    // rejects before constructing/sending a frame. Only its explicit
    // post-send unknown discriminant may widen a thrown raw-shell outcome.
    const uncontainedHostOutcomeUnknown =
      isRealWorkstationRunShell && isRunShellOutcomeUnknown(error);
    return {
      ok: false,
      ...(browserMutationOutcomeUnknown ? { browserFailure: "browser_outcome_unknown" as const } : {}),
      errorMessage: browserMutationOutcomeUnknown
        ? `Error: ${tc.name} outcome is unknown because its final receipt was lost. Do not replay it blindly. Obtain a fresh browser observation and inspect the result before deciding how to recover.\nUnderlying relay error: ${msg}`
        : desktopMutationOutcomeUnknown
        ? "Error: Computer Use outcome is unknown because its final receipt was lost. "
          + "Do not replay the operation. Obtain fresh Computer Use state before deciding the next action."
        : uncontainedHostOutcomeUnknown
          ? uncontainedHostOutcomeUnknownGuidance()
        : structuredSshOutcomeUnknown
          ? structuredSshUnknownOutcomeGuidance(structuredSsh?.binding.operation)
          : `Error dispatching ${tc.name} to relay: ${msg}`,
      // a thrown dispatch (e.g. the device disconnected/slept while the
      // call was in flight) is a relay-unavailable failure, not a tool error.
      // a structurally confirmed post-send SSH outcome is different:
      // the exact broker operation may have run, so do not label it a
      // pre-effect relay-unavailable failure or encourage a blind retry.
      relayUnavailable: !structuredSshOutcomeUnknown &&
        !browserMutationOutcomeUnknown &&
        !desktopMutationOutcomeUnknown &&
        !uncontainedHostOutcomeUnknown,
      ...(tc.name === "run_shell" && isRunShellOutcomeUnknown(error)
        ? { runShellOutcome: "unknown" as const }
        : uncontainedHostOutcomeUnknown
          ? { runShellOutcome: "unknown" as const }
          : {}),
      ...(structuredSshOutcomeUnknown ? { structuredSshOutcome: "unknown" as const } : {}),
      ...(desktopMutationOutcomeUnknown ? { desktopAutomationOutcome: "unknown" as const } : {}),
    };
  } finally {
    for (const signal of dispatchAbortSources) {
      signal.removeEventListener("abort", abortDispatch);
    }
  }
}

const CURRENT_FOLDER_PREPARE_ERROR_CODES = new Set([
  "invalid_request",
  "source_unavailable",
  "source_symlink",
  "target_missing",
  "target_not_directory",
  "target_symlink",
  "target_outside_source",
  "target_protected",
  "target_unsafe",
  "preparation_unavailable",
]);

const CURRENT_FOLDER_COMMIT_ERROR_CODES = new Set([
  "approval_required",
  "preparation_unknown",
  "preparation_expired",
  "source_stale",
  "target_stale",
  "current_folder_stale",
  "target_missing",
  "target_not_directory",
  "target_symlink",
  "target_outside_source",
  "target_protected",
  "target_unsafe",
  "commit_failed",
]);

function currentFolderFailure(code: string, relayUnavailable = false): RelayDispatchOutcome {
  return {
    ok: false,
    errorMessage: JSON.stringify({ ok: false, code }),
    ...(relayUnavailable ? { relayUnavailable: true } : {}),
  };
}

function recordResult(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedOpaquePreparationId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value)
    ? value
    : null;
}

function boundedFolderLabel(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[\\/\0\r\n]/.test(value)
    ? value
    : null;
}

function boundedRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

async function executeSelectCurrentFolderViaRelay(
  tc: { id?: string; name: string; args: Record<string, unknown> },
  state: NautiloState,
  registry: ToolRelayRegistry,
): Promise<RelayDispatchOutcome> {
  const args = parseSelectCurrentFolderArgs(tc.args);
  if (!args) return currentFolderFailure("invalid_request");

  if (state.verifiedOrdinaryOrigin?.kind !== "local_electron") {
    return currentFolderFailure("local_electron_required");
  }
  const relayId = tc.id ? state.requiredHostRelays?.[tc.id] : undefined;
  if (!relayId || state.verifiedOrdinaryOrigin.relayId !== relayId) {
    return currentFolderFailure("exact_local_relay_required");
  }
  // Folder adoption is handled by Electron main and does not need Computer Use
  // Accessibility. The verified local-Electron origin and exact relay binding
  // above remain the authority boundary; canRunShell proves this is the local
  // workstation relay rather than a cloud-only registry entry.
  if (!registry.findByCapabilityForUser("canRunShell", state.userId ?? "").includes(relayId)) {
    return currentFolderFailure("relay_unavailable", true);
  }

  let prepare: RelayDispatchResult;
  try {
    prepare = await registry.dispatch(relayId, {
      toolName: "nautilo_current_folder_prepare",
      args,
      impact: "high",
      approvalObtained: true,
      executionClass: "desktop",
    });
  } catch {
    return currentFolderFailure("prepare_dispatch_failed", true);
  }
  if (prepare.status === "error") return currentFolderFailure("prepare_failed");

  const prepared = recordResult(prepare.result);
  if (!prepared) return currentFolderFailure("prepare_invalid_response");
  if (prepared["ok"] !== true) {
    const code = prepared["code"];
    return currentFolderFailure(
      typeof code === "string" && CURRENT_FOLDER_PREPARE_ERROR_CODES.has(code)
        ? code
        : "prepare_failed",
    );
  }
  const preparationId = boundedOpaquePreparationId(prepared["preparationId"]);
  const preparedLabel = boundedFolderLabel(prepared["label"]);
  const preparedRevision = boundedRevision(prepared["currentFolderRevision"]);
  if (!preparationId || !preparedLabel || preparedRevision === null) {
    return currentFolderFailure("prepare_invalid_response");
  }

  let commit: RelayDispatchResult;
  try {
    commit = await registry.dispatch(relayId, {
      toolName: "nautilo_current_folder_commit",
      args: { preparationId },
      impact: "high",
      approvalObtained: true,
      executionClass: "desktop",
    });
  } catch {
    return currentFolderFailure("commit_dispatch_failed", true);
  }
  if (commit.status === "error") return currentFolderFailure("commit_failed");

  const committed = recordResult(commit.result);
  if (!committed) return currentFolderFailure("commit_invalid_response");
  if (committed["ok"] !== true) {
    const code = committed["code"];
    return currentFolderFailure(
      typeof code === "string" && CURRENT_FOLDER_COMMIT_ERROR_CODES.has(code)
        ? code
        : "commit_failed",
    );
  }
  const label = boundedFolderLabel(committed["label"]);
  const revision = boundedRevision(committed["currentFolderRevision"]);
  if (!label || revision === null) return currentFolderFailure("commit_invalid_response");

  return { ok: true, rawContent: JSON.stringify({ ok: true, label, revision }) };
}

async function handleNetworkApprovalAndRetry(
  tc: { id?: string; name: string; args: Record<string, unknown> },
  policy: ExecutionPolicy,
  state: NautiloState,
  denial: ApprovalAskNetworkContext,
  toolCallId?: string,
  signal?: AbortSignal,
  fullEncryptionOnly?: boolean,
): Promise<RelayDispatchOutcome> {
  const payload = {
    type: "approval_ask" as const,
    approvalId: randomUUID(),
    tools: [{
      name: tc.name,
      args: tc.args,
      ...(tc.id ? { id: tc.id } : {}),
    }],
    reason: `Agent attempted network access to ${denial.host}:${denial.port}`,
    reasonCode: "network-egress-denied" as const,
    network: denial,
    allowedVerbs: ["once", "room", "always", "deny"] as ApprovalReplyVerb[],
  };
  const decision: { approved?: boolean; verb?: ApprovalReplyVerb } | undefined = interrupt(payload);
  const verb = decision?.verb ?? "deny";
  if (verb === "deny" || decision?.approved === false) {
    return {
      ok: false,
      errorMessage: `Network access denied by owner: ${denial.host}:${denial.port}`,
    };
  }

  if (verb === "room" || verb === "always") {
    // Network egress widening is lane-keyed (not command-approval
    // DB). Both room + always map to a persisted lane network allow-rule;
    // durable DB-backed network rules are a deliberate follow-up.
    const laneKey = resolveLaneKey(state);
    if (laneKey) {
      recordApprovedNetworkAllowRule(laneKey, denial.suggestedRule as NetworkAllowRule);
    }
  }

  return await executeViaRelayRaw(tc, policy, state, {
    extraNetworkAllowRules: [denial.suggestedRule as NetworkAllowRule],
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(signal ? { signal } : {}),
    ...(fullEncryptionOnly === undefined ? {} : { fullEncryptionOnly }),
  });
}

function networkContextFromDeniedDestination(destination: {
  readonly host: string;
  readonly port: number;
  readonly reason: string;
}): ApprovalAskNetworkContext {
  return {
    host: destination.host,
    port: destination.port,
    reason: destination.reason,
    suggestedRule: {
      type: "domain",
      host: destination.host,
      ports: [destination.port],
    },
  };
}

function resolveLaneKey(state: NautiloState): string {
  if (state.roomId) return `room:${state.roomId}`;
  if (state.langgraphThreadId) return state.langgraphThreadId;
  if (typeof state.threadId === "number" && state.threadId > 0) return `thread-${state.threadId}`;
  return "";
}

/**
 * task 3.1.2 — read the live relay-binding fingerprint for a relay id
 * from the relay registry, for `WorkstationDispatchPlan` re-validation.
 * Each field is `null` when the relay is not connected or has not advertised
 * that piece of binding state (a single `null` fails the re-validation
 * closed as `relay_not_connected`). The profile id / revision come from the
 * relay's advisory Workstation Profile binding snapshot; the user / desktop
 * session / capability revision come from the registry's retained
 * registration state.
 */
function readWorkstationRelayFingerprint(relayId: string): WorkstationRelayFingerprintView {
  const reg = _relayRegistry;
  if (!reg) {
    return {
      userId: null,
      desktopSessionId: null,
      capabilityRevision: null,
      profileId: null,
      profileRevision: null,
      pairingGeneration: null,
    };
  }
  const profile = reg.getWorkstationProfileSnapshot?.(relayId) ?? null;
  const grant = reg.getDesktopFilesystemGrantSnapshot?.(relayId) ?? null;
  return {
    userId: reg.getUserId?.(relayId) ?? null,
    desktopSessionId: reg.getDesktopSessionId?.(relayId) ?? null,
    capabilityRevision: reg.getCapabilityRevision?.(relayId) ?? null,
    profileId: profile?.profileId ?? null,
    profileRevision: profile?.profileRevision ?? null,
    pairingGeneration: reg.getPairingGeneration?.(relayId) ?? null,
    // live grant-store + protected-policy revisions for
    // revision-coherent re-validation. Absent when the relay did not
    // advertise the corresponding snapshot; revalidation skips the check
    // when either side is absent.
    grantRevision: grant?.revision ?? null,
    protectedPolicyVersion: profile?.protectedPolicyVersion ?? null,
  };
}

/**
 * structured shell-binding disposition surfaced to the agent
 * (and, via the tool message, to the UI) when a plan-bound `run_shell`
 * dispatch cannot proceed. Carries the non-secret cause, retry-safety,
 * refreshability, and the exact recovery action. No credentials, approval
 * tokens, roots, or command text cross this boundary.
 */
export type WorkstationShellDisposition =
  | {
      readonly kind: "stale_refreshable";
      readonly refreshed: boolean;
      readonly retrySafe: true;
      readonly action: "retry";
      readonly detail: string;
    }
  | {
      readonly kind: "approval_required";
      readonly driftReason: WorkstationPlanRevalidationReasonView;
      readonly retrySafe: false;
      readonly action: "re_authorize";
      readonly detail: string;
      readonly currentFolder: string;
    }
  | {
      readonly kind: "offline";
      readonly retrySafe: false;
      readonly action: "reconnect_relay";
      readonly detail: string;
    }
  | {
      readonly kind: "unknown_outcome";
      readonly retrySafe: false;
      readonly action: "do_not_retry";
      readonly detail: string;
    };

/**
 * render a {@link WorkstationShellDisposition} as a compact,
 * grep-able, machine-parseable block appended to the stable human-readable
 * error copy. The human copy stays byte-for-byte compatible with existing
 * readers (it still contains the "missing or stale plan" / "no longer the
 * exact bound relay" / "Re-approve the operation" substrings); the
 * `NAUTILO_WORKSTATION_DISPOSITION` block adds the structured cause /
 * retry-safety / recovery action for the agent + UI to consume without
 * parsing free text.
 */
function renderWorkstationShellDisposition(
  disposition: WorkstationShellDisposition,
): string {
  const parts: string[] = [
    `kind=${disposition.kind}`,
    `retrySafe=${disposition.retrySafe}`,
    `action=${disposition.action}`,
  ];
  if (disposition.kind === "approval_required") {
    parts.push(`driftReason=${disposition.driftReason}`);
    parts.push(`currentFolder=${disposition.currentFolder}`);
  } else if (disposition.kind === "stale_refreshable") {
    parts.push(`refreshed=${disposition.refreshed}`);
  }
  parts.push(`detail=${disposition.detail}`);
  return `\n[NAUTILO_WORKSTATION_DISPOSITION] ${parts.join(" ")}`;
}

/**
 * task 3.1.3b — build the plan-bound `RelayWorkstationShellBinding` from a
 * pinned `WorkstationDispatchPlan` + the live tool-call id. The binding carries
 * ONLY the opaque plan binding tuple and the classified shell operation — no
 * roots, no paths, no filesystem identity. The `agentScope` is the durable
 * desktop-agent scope (`all_owned_agents`) the plan's subject was admitted
 * under; the plan view carries `userId` / `instanceId` / `relayId` directly.
 *
 * The binding is admission metadata only: it never widens `allowedRoots` and
 * never replaces the sandbox profile. The desktop relay revalidates it against
 * its live Electron authority/profile state before it can use profile-bound
 * roots.
 */
export function buildWorkstationShellBindingFromPlan(
  plan: WorkstationDispatchPlanView,
  toolCallId: string,
): RelayWorkstationShellBinding | null {
  // Protocol v2 is intentionally strict for profile-bound dispatches. A
  // legacy plan that lacks any revision-coherence field cannot be serialized
  // as a weaker binding; the caller treats null as no valid plan-bound shell
  // binding and follows the existing fail-closed re-authorize path.
  if (
    plan.currentFolder === undefined ||
    plan.currentFolder.length === 0 ||
    plan.grantRevision === undefined ||
    plan.grantRevision === null ||
    !Number.isSafeInteger(plan.grantRevision) ||
    plan.grantRevision < 0 ||
    plan.protectedPolicyVersion === undefined ||
    plan.protectedPolicyVersion === null ||
    !Number.isSafeInteger(plan.protectedPolicyVersion) ||
    plan.protectedPolicyVersion < 1
  ) {
    return null;
  }
  return {
    version: RELAY_WORKSTATION_SHELL_BINDING_VERSION,
    toolCallId: toolCallId.length > 0 ? toolCallId : plan.toolCallId,
    relayId: plan.relayId,
    desktopSessionId: plan.desktopSessionId,
    serverBindingId: plan.serverBindingId,
    pairingGeneration: plan.pairingGeneration,
    profileId: plan.profileId,
    profileRevision: plan.profileRevision,
    grantIds: [...plan.grantIds],
    capabilityRevision: plan.capabilityRevision,
    currentFolder: plan.currentFolder,
    grantRevision: plan.grantRevision,
    protectedPolicyVersion: plan.protectedPolicyVersion,
    subject: {
      userId: plan.userId,
      instanceId: plan.instanceId,
      relayId: plan.relayId,
      agentScope: DESKTOP_FILESYSTEM_GRANT_SNAPSHOT_AGENT_SCOPE,
    },
    operation: "execute",
    executionClass: RELAY_WORKSTATION_SHELL_BINDING_EXECUTION_CLASS,
  };
}

/**
 * Pre-execution security validation. Returns an error message if blocked,
 * null if allowed.
 *
 * Runs before the cloud-vs-relay dispatch split so the same policy applies
 * to both execution paths. Relay tools for filesystem/shell get scanned
 * here before the dispatch leaves the server; cloud tools get scanned
 * before `tool.invoke`.
 *
 * Exported for unit testing. The toolsNode pipeline is the canonical
 * caller; individual tests can import the pure function here to pin
 * per-tool gate behavior without wiring a full toolsNode harness.
 */
export function validateBeforeExecution(
  toolName: string,
  args: Record<string, unknown>,
  level: SecurityLevel,
): string | null {
  if (toolName === "run_shell") {
    const command = typeof args["command"] === "string" ? args["command"] : "";
    if (!command) return null;

    const result = scanCommand(command, level);
    // `runApprovedToolCall` is reached only after post-model has applied the
    // security-level verb map. Medium/high scanner matches therefore already
    // completed their required ask/prove_it path (or were deliberately auto
    // admitted by that level). Re-blocking them here made approval a dead end:
    // the Human could approve the exact command and execution still refused
    // it. Keep this defense-in-depth gate for critical/invalid scanner output;
    // critical commands are `block` at every security level.
    if (!result.allowed && result.severity !== "medium" && result.severity !== "high") {
      const patterns = result.matchedPatterns.map((p) => p.description).join("; ");
      return `Security: command blocked (${result.severity}). Matched: ${patterns}. This command is not allowed.`;
    }
  }

  // PR-011 security port — the unified `file` tool dispatches on
  // a `command` + `zone` arg pair and was not covered by the legacy
  // name-keyed branch above. When `zone === "absolute"`, the agent
  // passed a full absolute path; the deny-list (home-relative and
  // absolute entries in path-deny.ts) is the only gate that fires
  // before the fs op. Without this, `file({command:"read",
  // zone:"absolute", path:"/etc/passwd"})` — or grep on `/` — flows
  // straight to fsp.readFile / directory walk with no HIL and no
  // protected-path check.
  //
  // Workspace/current-zone paths resolve under bounded roots and are
  // re-verified via realpath-containment in the file tool's
  // dispatcher (see packages/agent/src/tools/file/zones.ts
  // assertRealpathContained). The deny-list is not the right gate
  // for those zones — a file under ~/Documents/Nautilo/ is never on
  // the deny list unless the workspace root itself was misconfigured.
  if (toolName === "file") {
    const command = typeof args["command"] === "string" ? args["command"] : "";
    if (!command) return null;

    const candidates: Array<{ label: string; path: string }> = [];
    const zone = typeof args["zone"] === "string" ? args["zone"] : "";
    const targetPath = typeof args["path"] === "string" ? args["path"] : "";
    if (zone === "absolute" && targetPath) {
      candidates.push({ label: "path", path: targetPath });
    }

    // Some file commands have a second filesystem target. If that
    // target uses destinationZone:"absolute", it must pass the same
    // deny-list gate as path/zone. Without this, a safe workspace
    // source could stage a generated file to /etc/passwd via
    // destinationPath (convert/move/copy) without the scanner seeing it.
    const explicitDestinationZone =
      typeof args["destinationZone"] === "string" ? args["destinationZone"] : "";
    const destinationZone =
      command === "move" || command === "copy" || command === "convert"
        ? explicitDestinationZone || zone
        : explicitDestinationZone;
    const destinationPath =
      typeof args["destinationPath"] === "string" ? args["destinationPath"] : "";
    if (
      destinationZone === "absolute" &&
      destinationPath &&
      (command === "move" || command === "copy" || command === "convert")
    ) {
      candidates.push({ label: "destinationPath", path: destinationPath });
    }

    for (const candidate of candidates) {
      const result = checkPathAccess(candidate.path, level);
      if (!result.allowed) {
        return `Security: ${candidate.label}: ${result.reason}`;
      }
    }
  }

  return null;
}
