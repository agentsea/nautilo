import { deepResearchReturnContextForState } from "../runtime/deep-research-return-context";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { interrupt, task } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { nativeDecisionDispatchError } from "../graph/native-decision";
import type { NautiloState } from "../agent/state";
import type { PolicyResolver, ToolAccessDecision } from "@nautilo/trust";
import { getToolCatalog } from "@nautilo/catalog";
import { modelSupportsInput } from "@nautilo/model-capabilities";
import type { ProtectedAgentMemoryAccessPort } from "@nautilo/lattice-bridge";
import { ProtectedMemoryToolUnavailableError } from "../tools/memory/protected-memory-ports";
import { fromRuntimeConfig } from "@nautilo/config";
import type { NetworkAllowRule } from "@nautilo/config";
import {
  coerceHybridSensitivity,
  resolveApproval,
  scanCommand,
  isExternalUnknownBinary,
  type ResolvedApproval,
  type SecurityLevel,
  type ToolImpact,
} from "@nautilo/security";
import type {
  ApprovalAskNetworkContext,
  ApprovalReplyVerb,
  ApprovalAskReason,
  ApprovalScopeInfo,
  LocalMcpInstallApproval,
  LocalMcpInstallModelIntent,
  LocalMcpInstallPrepared,
  MediaGenerationApproval,
  MediaGenerationPreparedApproval,
  MediaGenerationToolName,
  StructuredSshApproval,
  ProveItToolInfo,
} from "@nautilo/types";
import { redactToolTranscriptCredentialMaterial } from "@nautilo/types";
import {
  resolveFileCommandPolicy,
  classifyCall,
  matchCommandApproval,
  createCommandApproval,
  matchCapabilityApproval,
  createCapabilityApproval,
  envelopeReadableNamespaces,
  type CommandApprovalScope,
  type WorkstationAdmissionDecision,
} from "@nautilo/trust";
import { log, warn } from "@nautilo/logger";
import { mergeMessagesPreservingInvariants } from "@nautilo/message-invariants";
import { selectedActivatedToolNamesForActor } from "../tools/meta/activated-tools-handle";
import { modelIdForCapabilityProjection } from "../config/model-role-resolution";
import {
  approvalToolKey,
  extractApprovedWritablePath,
  recordApprovedNetworkAllowRule,
  recordOneShotNetworkAllowRule,
  recordApprovedWritablePath,
} from "./approval-widening";
import { computeShareMemoryApprovalPreview } from "../tools/memory/share-memory";
import {
  findProjectionSnapshot,
  isProjectionLikeShareCall,
  projectionApprovalArgs,
  projectionApprovalPreview,
  projectionSnapshotExpiresAt,
  projectionSnapshotRoomKind,
} from "../tools/memory/projection-sharing";
import { computeShareArtifactApprovalPreview } from "../tools/file/share-artifact";
import { parseOrdinaryContentAccessIntent } from "../tools/content-access-intent";
import {
  matchesOrdinaryContentAccessBinding,
  ordinaryContentAccessDigest,
  ORDINARY_CONTENT_ACCESS_RECOVERY,
  type OrdinaryContentAccessForState,
} from "../runtime/ordinary-content-access";
import { resolveRunShellTimeout } from "../tools/shell/run-shell";
import { resolveToolsForExposure } from "./pre-model";
import { resolveExecutionPolicy } from "./tools";
import { getOrdinaryHostResolver } from "../runtime/ordinary-host-resolver";
import {
  checkCategoricalHostAdmissionPrerequisite,
  resolveToolCallHostScope,
} from "../runtime/host-scoped-tools";
import { hasAvailableTaskReportBackContinuation } from "../runtime/task-report-back-continuation";
import {
  isComputerUseToolName,
  isSupportedComputerUseToolName,
  type ComputerUseAdmissionResolver,
  type ComputerUseInvocationBinding,
  type ComputerUseNeedsUserDecision,
  type ComputerUseRootGrantResolver,
} from "../runtime/computer-use-admission";
import { getLocalMcpToolRuntime } from "../tools/mcp/local-mcp-runtime";
import {
  isRecallRecordsToolAvailable,
  recallRecordsToolContextForState,
  type RecallRecordsPortForState,
} from "../tools/memory/recall-records";
import {
  mediaGenerationApprovalFromPrepared,
  prepareMediaGenerationApproval,
  verifyMediaGenerationPreparedApproval,
} from "../tools/media/media-generation-approval-runtime";

// ---------------------------------------------------------------------------
// Interrupt payloads
// ---------------------------------------------------------------------------

/** Existing prove_it payload. */
interface ProveItInterruptPayload {
  type: "prove_it_challenge";
  tools: ProveItToolInfo[];
  /** WS user-scoped delivery + resume auth. */
  userId?: string;
}

/**
 * Pre-prove_it enrollment challenge.
 *
 * Fires when a `prove_it_challenge` is about to be raised, the caller
 * supplied `deps.isPinEnrolled`, and the Logto-authenticated user
 * doesn't have a PIN yet.
 * The workbench renders the PinDialog in "set" mode; the user POSTs
 * to `/api/auth/pin` with `{ newPin }`; that endpoint resumes the
 * graph, which re-enters this node and falls through to the
 * existing prove_it_challenge path.
 */
interface IdentityChallengeEnrollPinPayload {
  type: "identity_challenge";
  mode: "enrollPin";
  userId?: string;
  /** Exact conditional batch; internal only and omitted by public event mapping. */
  enrollmentToolCallIds: string[];
  /** Content-free custody obligation; internal only. */
  protectedMemoryTools?: Array<{
    toolCallId: string;
    mode: "attach" | "project";
  }>;
}

/**
 * Dependency for the enrollPin pre-step.
 *
 * Optional so existing callers (and unit tests) can omit it; the
 * pre-step is then never fired and the existing prove_it flow runs as
 * before. Production wires this from `createNautiloGraph`'s deps.
 */
export interface PostModelDeps {
  /** Live Server policy selection; never inferred from protected-port absence. */
  ordinaryContentAccessForState?: OrdinaryContentAccessForState;
  protectedMemoryAccessPortForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemoryAccessPort | undefined;
  /** Current server policy gate; never inferred from checkpointed state. */
  fullEncryptionOnlyForState?: (state: NautiloState) => boolean;
  /**
   * Server/runtime-owned exact invocation binding for organized Room
   * recall. Undefined keeps recall_records absent. The Agent never constructs
   * authority or repository selection from graph state itself.
   */
  recallRecordsPortForState?: RecallRecordsPortForState;
  isPinEnrolled?: (userId: string) => Promise<boolean>;
  /**
   * Invoked when a pending `ask` (or `auto`-anomaly) tool call is
   * auto-approved by a matching standing approval, so the caller can write
   * a `security-audit-log` `approval_auto_approved` row. Optional: the
   * agent package cannot import the server's audit writer, so the default
   * deps leave this unset (a grep-able server log line is always emitted).
   * The server wires this to `writeSecurityAuditEvent`.
   */
  recordAutoApproval?: (info: {
    userId: string;
    scope: CommandApprovalScope;
    toolName: string;
    signatureKey: string;
    standingApprovalId: string;
  }) => void;
  /**
   * Injectable command-approval DB functions. Default to the real
   * `@nautilo/trust` implementations; unit tests inject stubs so they never
   * touch Postgres.
   */
  matchCommandApproval?: typeof matchCommandApproval;
  createCommandApproval?: typeof createCommandApproval;
  matchCapabilityApproval?: typeof matchCapabilityApproval;
  createCapabilityApproval?: typeof createCapabilityApproval;
  /**
   * Server-owned Full Workstation approval override
   * resolver. When present, Pass 2 consults it for each `ask` / `prove_it` /
   * `auto`-anomaly candidate BEFORE batching (and BEFORE the standing-
   * approval matcher). A `{ override: "auto" }` decision moves the call to
   * `approved` (suppressing the prompt); a `{ override: "none" }` decision
   * leaves the normal approval logic intact (the matcher / interrupt path
   * run unchanged). `block` is a hard policy stop and is NEVER overridable —
   * the resolver is not consulted for it.
   *
   * Fail-closed by construction: the resolver reads the LIVE server session
   * registry, so a bare client Auto-Approve flag cannot satisfy
   * it (the server-side evidence is authoritative). A throw is swallowed +
   * warned and treated as `none` so a resolver bug can never widen approval.
   * Skipped entirely for anonymous turns (no `state.userId`) so client-only
   * identity can never drive an override.
   *
   * Production wires this from `app.ts` via `defaultPostModelDeps`
   * (`packages/agent/src/agent/post-model-deps.ts`); the executor threads
   * those deps into `createNautiloGraph`. Unit tests inject a stub.
   */
  resolveWorkstationApprovalOverride?: WorkstationApprovalOverrideResolver;
  /**
   * Semantic desktop admission is not a generic approval override.
   * It returns an exact Electron binding or a hard denial. The tools node
   * revalidates that binding before dispatch through the Computer Use Host.
   */
  resolveComputerUseAdmission?: ComputerUseAdmissionResolver;
  /** Fresh foreground ingress resolver; never consulted by a child/resume. */
  resolveComputerUseRootGrant?: ComputerUseRootGrantResolver;
  /**
   * The sole live execution-lane resolver. The tools node calls it after
   * exact relay selection and immediately before dispatch. It is server-owned
   * and a non-admission always leaves the contained path intact.
   */
  resolveUncontainedHostCommandsDispatch?: UncontainedHostCommandsDispatchResolver;
}

/**
 * The per-dispatch request the post-model hands to the
 * Full Workstation override resolver. Carries everything the resolver needs
 * to build the live evidence bundle: the authenticated subject, the tool
 * call, and the turn's resolved actor / room / two-path context. The
 * resolver adds the ONE piece only the live server holds — the active Full
 * Workstation session — plus the per-operation side evidence it computes
 * from the dispatch binding / profile compiler / protected-path matcher /
 * capability resolver / command scanner / OS probe, then returns the
 * override decision.
 */
export interface WorkstationApprovalOverrideRequest {
  readonly userId: string;
  readonly toolCall: ToolCall;
  /** The actor id resolved for this turn (envelope.actorId ?? state.userId). */
  readonly actorId: string;
  readonly roomId: string;
  readonly currentFolder: string;
  readonly workspacePath: string;
  /** Paired-mobile turns pin any Workstation plan to this exact host. */
  readonly requiredRelayId?: string;
  /**
   * Request-side audit envelope (ip / userAgent) from the
   * executing turn's `securityAuditClientMeta`, stamped onto the redacted
   * `workstation_admission` audit row by the server-side resolver. `null`
   * for background / resume-only paths that omit it (the audit sink falls
   * back to an empty ip).
   */
  readonly clientMeta?: { readonly ip: string; readonly userAgent?: string | undefined } | null;
}

/**
 * Server-owned resolver that returns one Workstation
 * execution-admission decision for one dispatch. `auto` ⇒ the caller MAY
 * suppress the normal `ask` / `prove_it` prompt; `none` ⇒ the caller MUST
 * leave the normal approval logic intact (NOT an execution denial). Sync or
 * async; the post-model `await`s either.
 */
export type WorkstationApprovalOverrideResolver = (
  request: WorkstationApprovalOverrideRequest,
) => WorkstationAdmissionDecision | Promise<WorkstationAdmissionDecision>;

export interface UncontainedHostCommandsDispatchRequest {
  readonly userId: string;
  readonly actorId: string;
  readonly toolCallId: string;
  readonly relayId: string;
  readonly foregroundLocalElectron: {
    readonly userId: string;
    readonly actorId: string;
    readonly relayId: string;
    readonly desktopSessionId: string;
    readonly pairingGeneration: string;
  };
  readonly clientMeta?: { readonly ip: string; readonly userAgent?: string | undefined } | null;
}

export type UncontainedHostCommandsDispatchResolver = (
  request: UncontainedHostCommandsDispatchRequest,
) =>
  | {
    readonly admitted: true;
    readonly executionClass: "real_workstation";
    /** Server-local activation fence; never serialized into a relay frame. */
    readonly activationSignal: AbortSignal;
  }
  | { readonly admitted: false; readonly reason: string }
  | Promise<
    | {
      readonly admitted: true;
      readonly executionClass: "real_workstation";
      readonly activationSignal: AbortSignal;
    }
    | { readonly admitted: false; readonly reason: string }
  >;

/** Ask-verb payload. Client presents four-button dialog. */
export interface ApprovalAskInterruptPayload {
  type: "approval_ask";
  approvalId: string;
  tools: ProveItToolInfo[];
  reason: string;
  reasonCode: ApprovalAskReason;
  network?: ApprovalAskNetworkContext;
  allowedVerbs: ApprovalReplyVerb[];
  /** Per-tool generalization grain, index-aligned with `tools`. */
  scopeInfo?: ApprovalScopeInfo[];
  localMcpInstall?: LocalMcpInstallApproval;
  mediaGeneration?: MediaGenerationApproval;
  structuredSsh?: StructuredSshApproval;
  requiresExplicitReview?: boolean;
  userId?: string;
}

/** Shape the client returns via /api/auth/approval-reply.
 *  `verb` is present for ask-interrupts; absent for legacy prove_it
 *  interrupts (which just return `{ approved }`). */
interface ResumeDecision {
  approved?: boolean;
  verb?: ApprovalReplyVerb;
  /** Exact approval receipt; mandatory with the digest for local MCPs. */
  localMcpInstallApprovalId?: string;
  /** Echo of the exact digest rendered in the approval dock. */
  localMcpInstallDigest?: string;
  /** The reply lane supplied by the authenticated resume route. */
  localMcpInstallLaneKey?: string;
  /** Exact paid media receipt echoed by the authenticated resume route. */
  mediaGenerationApprovalId?: string;
  mediaGenerationDigest?: string;
  mediaGenerationQuoteDigest?: string;
  mediaGenerationLaneKey?: string;
  mediaGenerationRevision?: number;
  /** Exact Electron SSH preparation approval receipt. */
  structuredSshApprovalId?: string;
}

interface HostChoiceResumeDecision {
  choiceId?: string;
  selector?: string;
}

// ---------------------------------------------------------------------------
// Main node factory
// ---------------------------------------------------------------------------

/**
 * Creates the post-model node.
 *
 * Pipeline:
 *   1. Run `PolicyResolver.checkToolAccess` for each tool call (existing).
 *      - `allow` / `read_only`  → approve
 *      - `forbidden`            → deny with ToolMessage
 *      - `require_approval`     → hand to the verb map (step 2)
 *
 *   2. For each `require_approval` tool, consult the verb map via
 *      `resolveApproval()`:
 *      - If a standing approval (room/server) matches → auto-approve
 *        (bypass interrupts); emit a grep-able auto-approval log line.
 *      - Else `verb === "ask"`      → new approval_ask interrupt
 *      -       `verb === "prove_it"` → existing prove_it interrupt
 *      -       `verb === "block"`    → deny with ToolMessage
 *      -       `verb === "auto"`     → if a standing rule matches, approve;
 *                                      else escalate to ask (the verb-map /
 *                                      trust disagreement anomaly).
 *
 *   3. Fire interrupts (prove_it first if any, then ask). On the ask
 *      reply, write room/always standing-approval rules to the DB.
 *
 * If no PolicyResolver is provided, fail closed (rejects all tool calls).
 */
export function createPostModelNode(
  policyResolver?: PolicyResolver | null,
  deps?: PostModelDeps,
) {
  return async (state: NautiloState): Promise<Partial<NautiloState>> => {
    const terminalMessage = state.messages[state.messages.length - 1];
    // Projection preflight may append rejection ToolMessages for selected calls in a
    // mixed batch. Those are already paired, but the valid sibling calls must
    // still reach approval. Only walk back across those known preflight
    // rejections; ordinary completed tool turns remain terminal as before.
    const lastMessage = AIMessage.isInstance(terminalMessage)
      ? terminalMessage
      : (state.projectionRejectedToolCallIds?.length || state.modelRejectedToolCallIds?.length || state.ordinaryContentAccessRejectedToolCallIds?.length
        ? [...state.messages].reverse().find((message) => AIMessage.isInstance(message))
        : undefined);
    if (!lastMessage || !lastMessage.tool_calls?.length) {
      return {
        approvedToolCalls: [],
        computerUseInvocationBindings: {},
        requiredHostRelays: {},
        pendingApproval: [],
        approvalDenied: false,
        identityEnrollmentToolCallIds: [],
      };
    }

    const rejectedProjectionCallIds = new Set([...(state.projectionRejectedToolCallIds ?? []), ...(state.modelRejectedToolCallIds ?? []), ...(state.ordinaryContentAccessRejectedToolCallIds ?? [])]);
    const toolCalls: ToolCall[] = lastMessage.tool_calls.filter(
      (tc) => !rejectedProjectionCallIds.has(tc.id ?? ""),
    );
    log(`[post_model] Classifying ${toolCalls.length} tool call(s): ${toolCalls.map((tc) => tc.name).join(", ")}`);

    if (!policyResolver) {
      warn(`[post_model] No policy resolver — rejecting all ${toolCalls.length} tool call(s): ${toolCalls.map((tc) => tc.name).join(", ")}`);
      return {
        approvedToolCalls: [],
        computerUseInvocationBindings: {},
        requiredHostRelays: {},
        pendingApproval: [],
        approvalDenied: false,
        identityEnrollmentToolCallIds: [],
      };
    }

    // Injectable DB fns (default real; unit tests stub these).
    const matchFn = deps?.matchCommandApproval ?? matchCommandApproval;
    const createFn = deps?.createCommandApproval ?? createCommandApproval;
    const matchCapabilityFn = deps?.matchCapabilityApproval ?? matchCapabilityApproval;
    const createCapabilityFn = deps?.createCapabilityApproval ?? createCapabilityApproval;

    // -----------------------------------------------------------------
    // Pass 1 — trust-layer routing (existing, unchanged)
    // -----------------------------------------------------------------

    const envelope = state.memoryAccessEnvelope;
    const actorId = envelope?.actorId ?? state.userId;
    const catalog = getToolCatalog();
    const runtimeConfig = fromRuntimeConfig();
    const requestedModelId = modelIdForCapabilityProjection(
      "chat",
      state.model || runtimeConfig.nautilo_model,
    );
    const activeModelCapabilities = (["image", "file"] as const).filter(
      (capability) => modelSupportsInput(requestedModelId, capability),
    );
    const activatedToolNames = selectedActivatedToolNamesForActor(
      state.actorRole,
      state.activatedToolNames,
    );
    const recallRecordsContext = recallRecordsToolContextForState(
      state,
      deps?.recallRecordsPortForState?.(state),
    );
    const exposureOptions = {
      context: {
        ...recallRecordsContext,
        deepResearchForegroundAvailable: deepResearchReturnContextForState(state) !== null,
        relayCapabilities: state.relayCapabilities,
        connectedAppProviderIds: state.connectedAppProviderIds ?? [],
        verifiedOrdinaryOrigin: state.verifiedOrdinaryOrigin,
        taskReportBackContinuation: state.taskReportBackContinuation,
        trustedExecutionEntrypoint: state.trustedExecutionEntrypoint,
      },
      toolPolicy: envelope?.toolPolicy,
      readableNamespaces: envelopeReadableNamespaces(envelope),
      activeModelCapabilities,
      toolNameWhitelist: state.toolWhitelist,
      activatedToolNames,
      // Pre-flight retains its relay-live-check defense model: dispatch
      // revalidates liveness immediately before execution.
      skipRelayLiveCheck: true,
      fullEncryptionOnly: deps?.fullEncryptionOnlyForState?.(state) === true,
    };
    const executableNames = catalog
      ? new Set(
          resolveToolsForExposure(
            catalog,
            runtimeConfig.nautilo_tool_exposure_mode,
            exposureOptions,
          )
            .snapshot.entries
            .map((entry) => entry.name),
        )
      : null;
    let approved: ToolCall[] = [];
    let pending: ToolCall[] = [];
    const forbidden: Array<{ tc: ToolCall; reason?: string }> = [];
    const prerequisiteFailures = new Map<ToolCall, string>();
    const protectedMemoryEntries = new Map<ToolCall, ProveItToolInfo>();
    const memoryPreparationFailures = new Map<ToolCall, string>();
    const protectedMemoryAccessPort = deps?.protectedMemoryAccessPortForState?.(state);
    const ordinarySelection = await deps?.ordinaryContentAccessForState?.(state);
    const invalidOrdinaryBatch = toolCalls.some((tc) => {
      const binding = state.ordinaryContentAccessBindings?.[tc.id ?? ""];
      if (binding) return ordinarySelection?.mode !== "plaintext_only" || !ordinarySelection.port
        || !matchesOrdinaryContentAccessBinding(state, tc, binding);
      if (ordinarySelection?.mode !== "plaintext_only") return false;
      try { return parseOrdinaryContentAccessIntent(tc, state.focusedResources ?? []) !== null; }
      catch { return true; }
    });
    if (invalidOrdinaryBatch) {
      // Do not change interrupt positions within an already parked mixed batch.
      // Invalidate it before entering any new approval or executing a sibling.
      return {
        messages: mergeMessagesPreservingInvariants(state.messages, toolCalls.map(ordinaryShareDenialMessage)),
        approvedToolCalls: [], pendingApproval: [], ordinaryContentAccessBindings: {},
        computerUseInvocationBindings: {}, requiredHostRelays: {}, approvalDenied: true,
        identityEnrollmentToolCallIds: [],
      };
    }
    const ordinaryApprovalByCall = new Map<ToolCall, ResolvedApproval>();
    const ordinaryPreviewByCall = new Map<ToolCall, ProveItToolInfo>();
    const ordinaryFresh = (tc: ToolCall): boolean => {
      const binding = state.ordinaryContentAccessBindings?.[tc.id ?? ""];
      return binding === undefined || (ordinarySelection?.mode === "plaintext_only"
        && matchesOrdinaryContentAccessBinding(state, tc, binding)
        && binding.prepared.operations.every((operation) => operation.expiresAt > Date.now()));
    };
    const approveFresh = (calls: ToolCall[]): ToolCall[] => calls.filter((tc) => {
      if (ordinaryFresh(tc)) return true;
      denialMessages.push(ordinaryShareDenialMessage(tc));
      return false;
    });

    for (const tc of toolCalls) {
      if (executableNames !== null && !executableNames.has(tc.name)) {
        const unavailableReason = catalog?.getUnavailableReasonForExposure(tc.name, {
          ...exposureOptions,
          ...(runtimeConfig.nautilo_tool_exposure_mode === "progressive"
            ? {}
            : { activatedToolNames: [...activatedToolNames, tc.name] }),
        }) ?? null;
        if (unavailableReason !== null) {
          // Availability is not authority. Consult the ordinary actor policy
          // before revealing which server prerequisite is missing.
          const decision = await policyResolver.checkToolAccess(actorId, tc, envelope);
          if (decision.type !== "forbidden") prerequisiteFailures.set(tc, unavailableReason);
        }
        warn(`[post_model] Tool ${tc.name} forbidden: not available in actor catalog snapshot`);
        forbidden.push({ tc, reason: "not available in actor catalog snapshot" });
        continue;
      }
      let decision: ToolAccessDecision = tc.name === "recall_records"
        && isRecallRecordsToolAvailable(recallRecordsContext)
        // Record authority is the complete invocation Room audience. Do not
        // reuse the initiating requester's broader Memory capability policy.
        ? { type: "read_only" }
        : await policyResolver.checkToolAccess(actorId, tc, envelope);
      const ordinaryBinding = state.ordinaryContentAccessBindings?.[tc.id ?? ""];
      if (ordinaryBinding !== undefined || ordinarySelection?.mode === "plaintext_only") {
        let ordinaryIntent;
        try { ordinaryIntent = ordinaryBinding?.intent ?? parseOrdinaryContentAccessIntent(tc, state.focusedResources ?? []); }
        catch { forbidden.push({ tc, reason: ORDINARY_CONTENT_ACCESS_RECOVERY }); continue; }
        if (ordinaryBinding !== undefined || ordinaryIntent !== null) {
          if (ordinarySelection?.mode !== "plaintext_only" || !ordinarySelection.port
            || !matchesOrdinaryContentAccessBinding(state, tc, ordinaryBinding)) {
            forbidden.push({ tc, reason: ORDINARY_CONTENT_ACCESS_RECOVERY });
            continue;
          }
          ordinaryPreviewByCall.set(tc, ordinaryBinding.prepared.preview);
          // ask_peer contact authority cannot stand in for Artifact release.
          if (tc.name === "ask_peer") {
            const shareCall: ToolCall = { ...tc, name: "share_artifact" };
            for (const object of ordinaryBinding.intent.objects) {
              shareCall.args = { artifact_id: object.id, target: ordinaryBinding.intent.target, sensitivity: (tc.args as Record<string, unknown>)["sensitivity"] };
              const shareDecision = await policyResolver.checkToolAccess(actorId, shareCall, envelope);
              if (shareDecision.type === "forbidden" || shareDecision.type === "read_only") {
                decision = { type: "forbidden", reason: "Artifact sharing is not admitted for this peer contact." };
                break;
              }
              if (shareDecision.type === "require_approval" && decision.type !== "forbidden") decision = shareDecision;
            }
            ordinaryApprovalByCall.set(tc, strongerShareApproval(
              resolveApprovalForToolCall(tc, runtimeConfig.nautilo_security_level),
              resolveApprovalForToolCall(shareCall, runtimeConfig.nautilo_security_level),
            ));
          }
        }
      }
      // Protected preparation is authority, not optional preview decoration.
      // Never ask for consent to a call that already lacks its exact binding.
      if (decision.type !== "forbidden" && tc.name === "share_memory"
        && !isProjectionLikeShareCall(tc) && protectedMemoryAccessPort !== undefined) {
        try {
          protectedMemoryEntries.set(tc, await interruptToolEntry(tc, state, protectedMemoryAccessPort));
        } catch (error) {
          const reason = error instanceof ProtectedMemoryToolUnavailableError
            ? error.message
            : "Memory sharing preparation failed. Try a fresh request; no sharing operation was executed.";
          memoryPreparationFailures.set(tc, reason);
          forbidden.push({ tc, reason });
          continue;
        }
      }
      switch (decision.type) {
        case "allow":
        case "read_only":
          // An open-Room projection is never an automatic/read-only
          // action even when another policy layer says allow. Its server
          // snapshot has already bound the audience before this point.
          if (isProjectionLikeShareCall(tc)) {
            const snapshot = findProjectionSnapshot(state, tc);
            const roomKind = snapshot === null
              ? null
              : projectionSnapshotRoomKind(snapshot);
            if (
              !snapshot
              || projectionSnapshotExpiresAt(snapshot) <= Date.now()
              || roomKind === null
            ) {
              forbidden.push({ tc, reason: "missing or expired trusted projection snapshot" });
            } else if (roomKind === "open") {
              pending.push(tc);
            } else {
              approved.push(tc);
            }
          } else {
            approved.push(tc);
          }
          break;
        case "require_approval":
          if (isProjectionLikeShareCall(tc)) {
            const snapshot = findProjectionSnapshot(state, tc);
            if (
              !snapshot
              || projectionSnapshotExpiresAt(snapshot) <= Date.now()
              || projectionSnapshotRoomKind(snapshot) === null
            ) {
              forbidden.push({ tc, reason: "missing or expired trusted projection snapshot" });
            } else {
              pending.push(tc);
            }
          } else {
            pending.push(tc);
          }
          break;
        case "forbidden":
          warn(`[post_model] Tool ${tc.name} forbidden: ${decision.reason}`);
          forbidden.push({ tc, reason: decision.reason });
          break;
      }
    }

    // Resolve verified ordinary-request host scope before any approval override,
    // standing-approval lookup, or user approval. Zero eligible hosts is a
    // stable denial; one is pinned automatically; several pause for an
    // opaque, one-use human choice. The tools node resolves again immediately
    // before dispatch, so a host that changes after this point fails closed.
    const requiredHostByToolCall = new Map<string, string>();
    const verifiedOrdinaryOrigin = state.verifiedOrdinaryOrigin;
    if (verifiedOrdinaryOrigin && !catalog) {
      forbidden.push(
        ...approved.map((tc) => ({ tc, reason: "computer tool catalog is unavailable" })),
        ...pending.map((tc) => ({ tc, reason: "computer tool catalog is unavailable" })),
      );
      approved = [];
      pending = [];
    } else if (catalog) {
      const hostResolver = getOrdinaryHostResolver();
      const resolveCandidates = async (candidates: ToolCall[]): Promise<ToolCall[]> => {
        const retained: ToolCall[] = [];
        for (const tc of candidates) {
          const policy = resolveExecutionPolicy(tc.name, catalog);
          const hostScope = resolveToolCallHostScope({
            classified: policy.hostScope,
            toolName: tc.name,
            args: (tc.args ?? {}) as Record<string, unknown>,
            currentFolder: state.currentFolder ?? "",
          });
          const localResearchContext = tc.name === "security_scan" && ["context", "handoff"].includes(String(tc.args["operation"]))
            && state.subagentRun === true && Boolean(state.currentTaskId && state.currentTaskRunId)
            && state.toolWhitelist?.includes("security_scan") === true;
          if (hostScope !== "required" || localResearchContext) {
            retained.push(tc);
            continue;
          }
          const taskContinuation = state.taskReportBackContinuation;
          if (hasAvailableTaskReportBackContinuation(taskContinuation)) {
            if (tc.name.startsWith("browser_") && !taskContinuation.browserSessionId) {
              forbidden.push({ tc, reason: "the original embedded Browser session is no longer available" });
              continue;
            }
            if (!tc.id) {
              forbidden.push({ tc, reason: "Task continuation tool call is missing an invocation id" });
              continue;
            }
            requiredHostByToolCall.set(tc.id, taskContinuation.relayId);
            retained.push(tc);
            continue;
          }
          const prerequisite = checkCategoricalHostAdmissionPrerequisite({
            hostScope,
            toolName: tc.name,
            verifiedOrdinaryOrigin,
          });
          if (prerequisite.status === "denied") {
            forbidden.push({ tc, reason: prerequisite.reason });
            continue;
          }
          // The shared prerequisite owns the user-visible missing-origin
          // denial above. This unreachable defensive guard narrows the type
          // for exact host resolution below without recreating that policy.
          if (!verifiedOrdinaryOrigin) continue;
          if (!hostResolver || !tc.id) {
            forbidden.push({ tc, reason: "authorized computer resolution is unavailable" });
            continue;
          }
          let resolution = await hostResolver.resolve({
            origin: verifiedOrdinaryOrigin,
            toolCallId: tc.id,
            toolName: tc.name,
            relayCapability: policy.relayCapability ?? "canReadWorkspace",
            ...(policy.hostedBy ? { hostedBy: policy.hostedBy } : {}),
          });
          if (resolution.status === "choice_required") {
            const decision: HostChoiceResumeDecision | undefined = interrupt({
              type: "host_choice",
              choiceId: resolution.choiceId,
              toolCallId: tc.id,
              toolName: tc.name,
              options: resolution.options,
              ...(state.userId ? { userId: state.userId } : {}),
            });
            if (
              !decision ||
              decision.choiceId !== resolution.choiceId ||
              typeof decision.selector !== "string"
            ) {
              forbidden.push({ tc, reason: "paired computer choice was not completed" });
              continue;
            }
            resolution = await hostResolver.resolve({
              origin: verifiedOrdinaryOrigin,
              toolCallId: tc.id,
              toolName: tc.name,
              relayCapability: policy.relayCapability ?? "canReadWorkspace",
              ...(policy.hostedBy ? { hostedBy: policy.hostedBy } : {}),
              choice: { choiceId: decision.choiceId, selector: decision.selector },
            });
          }
          if (resolution.status !== "selected") {
            forbidden.push({ tc, reason: "no authorized computer is online and eligible for this operation" });
            continue;
          }
          requiredHostByToolCall.set(tc.id, resolution.host.relayId);
          retained.push(tc);
        }
        return retained;
      };
      approved = await resolveCandidates(approved);
      pending = await resolveCandidates(pending);
    }

    // Semantic desktop tools never enter generic ask / prove_it /
    // Auto-Approve routing. A server-owned resolver must establish exact
    // live authority first. The per-call binding is retained for tools-node
    // revalidation; it cannot become an unauthenticated Relay call.
    const computerAdmissionResolver = deps?.resolveComputerUseAdmission;
    const computerUseInvocationBindings = new Map<string, ComputerUseInvocationBinding>();
    const computerUseNeedsUser: Array<{
      tc: ToolCall;
      decision: ComputerUseNeedsUserDecision;
    }> = [];
    const resolveComputerCandidates = async (
      candidates: ToolCall[],
      moveAdmittedToApproved: boolean,
    ): Promise<ToolCall[]> => {
      const retained: ToolCall[] = [];
      for (const tc of candidates) {
        if (!isComputerUseToolName(tc.name)) {
          retained.push(tc);
          continue;
        }
        if (!isSupportedComputerUseToolName(tc.name)) {
          forbidden.push({ tc, reason: "unsupported semantic computer tool" });
          continue;
        }
        const nativeError = nativeDecisionDispatchError(state, tc);
        if (nativeError) {
          forbidden.push({ tc, reason: nativeError });
          continue;
        }
        if (!computerAdmissionResolver || !tc.id) {
          forbidden.push({ tc, reason: "desktop automation is unavailable for this run" });
          continue;
        }
        let decision;
        try {
          decision = await computerAdmissionResolver({
            userId: state.userId,
            actorId,
            causalHumanUserId: state.causalHumanUserId ?? "",
            agentId: state.agentId,
            trustedExecutionEntrypoint: state.trustedExecutionEntrypoint,
            verifiedOrdinaryOrigin: state.verifiedOrdinaryOrigin,
            desktopAutomationProvenance: state.desktopAutomationProvenance,
            desktopAutomationRouteBinding: state.desktopAutomationRouteBinding,
            toolCall: tc,
          });
        } catch (err) {
          warn(
            `[post_model] computer-use admission resolver threw for ${tc.name}: ` +
              `${err instanceof Error ? err.message : String(err)}; denying semantic computer call`,
          );
          forbidden.push({ tc, reason: "desktop automation is unavailable for this run" });
          continue;
        }
        if (decision.status !== "admitted") {
          if (decision.status === "needs_user") {
            computerUseNeedsUser.push({ tc, decision });
            continue;
          }
          forbidden.push({ tc, reason: decision.reason });
          continue;
        }
        computerUseInvocationBindings.set(tc.id, decision.binding);
        if (moveAdmittedToApproved) approved.push(tc);
        else retained.push(tc);
      }
      return retained;
    };
    approved = await resolveComputerCandidates(approved, false);
    pending = await resolveComputerCandidates(pending, true);

    // A long-wait intent is only meaningful when its canonical tier resolver
    // accepts it. Reject bad tier/reason combinations here, before any Human
    // approval interrupt can be emitted; toolsNode repeats this at dispatch as
    // the execution seam defense.
    const invalidRunShellTimeouts: Array<{ tc: ToolCall; error: string }> = [];
    pending = pending.filter((tc) => {
      if (tc.name !== "run_shell") return true;
      const resolved = resolveRunShellTimeout((tc.args ?? {}) as Record<string, unknown>);
      if (resolved.ok) return true;
      invalidRunShellTimeouts.push({ tc, error: resolved.error });
      return false;
    });

    // -----------------------------------------------------------------
    // Pass 2 — verb map on `pending`
    // -----------------------------------------------------------------

    const level = resolveSecurityLevel();
    // Lane key still drives sandbox/network widening stores (separate from
    // the command-approval DB). Only compute it when there's pending
    // approval work — otherwise a read-only-tools request from a state
    // missing threadId would fail-closed unnecessarily.
    const laneKey = pending.length > 0 ? resolveLaneKey(state) : "";

    let askBatch: Array<{ tc: ToolCall; approval: ResolvedApproval }> = [];
    const proveItBatch: ToolCall[] = [];
    const blockedBatch: Array<{ tc: ToolCall; reason: string }> = [];

    // `ask` and `auto`-anomaly calls consult the DB command-approval
    // matcher. prove_it / block NEVER consult it (the safety backstop). We
    // classify all candidates first, then run the lookups concurrently to
    // avoid N sequential round-trips on a multi-tool batch.
    interface MatchCandidate {
      tc: ToolCall;
      approval: ResolvedApproval;
      isAutoAnomaly: boolean;
    }
    const matchCandidates: MatchCandidate[] = [];

    for (const tc of pending) {
      // An open-Room projection always has the strongest existing approval
      // verb. This is intentionally before workstation overrides and standing
      // approval lookup, so neither YOLO nor a prior broad rule can bypass PIN.
      const projectionSnapshot = isProjectionLikeShareCall(tc)
        ? findProjectionSnapshot(state, tc)
        : null;
      if (
        projectionSnapshot !== null
        && projectionSnapshotRoomKind(projectionSnapshot) === "open"
      ) {
        proveItBatch.push(tc);
        continue;
      }
      // An install is always a single explicit approval. It does not
      // consult Full Workstation admission, a standing command rule, or the
      // security-level verb map: those mechanisms are deliberately incapable
      // of authorizing an executable launch that has not yet been rendered.
      if (isManageLocalMcpInstall(tc)) {
        const forced = resolveApproval(
          { toolImpact: "destructive", toolName: tc.name },
          level,
        );
        askBatch.push({
          tc,
          approval: {
            ...forced,
            verb: "ask",
            reason: "Installing a local MCP runs the exact launch shown below on your selected Desktop.",
          },
        });
        continue;
      }
      // Removing an MCP permanently deletes its saved local configuration and
      // stops the process. Like install, it cannot be authorized by YOLO,
      // Full Workstation, or a standing rule; the Human confirms this exact
      // name + relay once.
      if (isManageLocalMcpRemove(tc)) {
        const forced = resolveApproval(
          { toolImpact: "destructive", toolName: tc.name },
          level,
        );
        askBatch.push({
          tc,
          approval: {
            ...forced,
            verb: "ask",
            reason: "Removing a local MCP stops it and permanently deletes its saved connection from the selected Desktop.",
          },
        });
        continue;
      }
      // Paid media is authorized only by the exact server-prepared
      // quote for this checkpoint. Workstation mode, standing approvals,
      // and the generic security verb map cannot bypass that review.
      // The unified video's closed `action="prepare"` shape is deterministic
      // UI preparation only: it neither quotes nor admits provider work.
      if (isVideoGenerationPreparationCall(tc)) {
        approved.push(tc);
        continue;
      }
      if (isMediaGenerationToolCall(tc)) {
        const forced = resolveApproval(
          { toolImpact: "destructive", toolName: tc.name },
          level,
        );
        askBatch.push({
          tc,
          approval: {
            ...forced,
            verb: "ask",
            reason: "Starting this media generation spends the exact USD amount shown below.",
          },
        });
        continue;
      }
      const approval = ordinaryApprovalByCall.get(tc) ?? resolveApprovalForToolCall(tc, level);

      // -----------------------------------------------------------------
      // Full Workstation approval override seam.
      //
      // Consult the server-owned resolver BEFORE batching ask / prove_it /
      // auto-anomaly candidates (and BEFORE the standing-approval
      // matcher). `auto` moves the call straight to `approved` (no prompt,
      // no matcher); `none` falls through to the existing verb-map path
      // unchanged. `block` is a hard policy stop — the resolver is NEVER
      // consulted for it, so an override can never bypass a critical deny.
      // Skipped for anonymous turns (no userId) so a client-only identity
      // can never drive an override; a resolver throw is swallowed + warned
      // and treated as `none` so a resolver bug can never widen approval.
      // -----------------------------------------------------------------
      const overrideResolver = deps?.resolveWorkstationApprovalOverride;
      if (
        overrideResolver &&
        approval.verb !== "block" &&
        state.userId
      ) {
        let overrideDecision: WorkstationAdmissionDecision | null = null;
        try {
          overrideDecision = await overrideResolver({
            userId: state.userId,
            toolCall: tc,
            actorId,
            roomId: state.roomId ?? "",
            currentFolder: state.currentFolder ?? "",
            workspacePath: state.workspacePath ?? "",
            ...(tc.id && requiredHostByToolCall.has(tc.id)
              ? { requiredRelayId: requiredHostByToolCall.get(tc.id)! }
              : {}),
            clientMeta: state.securityAuditClientMeta ?? null,
          });
        } catch (err) {
          warn(
            `[post_model] workstation override resolver threw for ${tc.name}: ` +
              `${err instanceof Error ? err.message : String(err)}; leaving normal approval intact`,
          );
          overrideDecision = null;
        }
        if (overrideDecision?.override === "auto") {
          log(
            `[post_model] workstation_admission_auto_approved ${tc.name} ` +
              `(override=auto, executionClass=${overrideDecision.executionClass}); suppressing ${approval.verb} prompt`,
          );
          approved.push(tc);
          continue;
        }
      }

      switch (approval.verb) {
        case "auto":
          // Trust said require_approval but verb map thinks this is benign.
          // A matching standing rule auto-approves; otherwise escalate to ask.
          matchCandidates.push({ tc, approval, isAutoAnomaly: true });
          break;
        case "ask":
          matchCandidates.push({ tc, approval, isAutoAnomaly: false });
          break;
        case "prove_it":
          // Standing approvals DO NOT bypass prove_it (security backstop).
          proveItBatch.push(tc);
          break;
        case "block":
          // Same — block is block. No standing rule overrides critical.
          blockedBatch.push({ tc, reason: approval.reason });
          break;
      }
    }

    // Run DB matches concurrently. Skip entirely for anonymous /
    // unauthenticated turns (no userId) — fail-closed to ask, no cross-user
    // leak.
    const userIdForMatch = state.userId || "";
    const roomIdForMatch = state.roomId ? state.roomId : null;
    const matchResults = await Promise.all(
      matchCandidates.map((cand) =>
        userIdForMatch
          ? matchStandingApprovalForTool({
              userId: userIdForMatch,
              roomId: roomIdForMatch,
              tc: cand.tc,
              matchCapabilityFn,
              matchCommandFn: matchFn,
            })
          : Promise.resolve(null),
      ),
    );

    for (let i = 0; i < matchCandidates.length; i++) {
      const cand = matchCandidates[i]!;
      const matched = matchResults[i];
      if (matched) {
        log(
          `[post_model] approval_auto_approved ${cand.tc.name} scope=${matched.scope} standingApprovalId=${matched.id}` +
            (matched.viaCapability ? ` capability=${matched.capabilitySlug}` : ""),
        );
        if (deps?.recordAutoApproval && userIdForMatch) {
          const signatureKey = matched.viaCapability && matched.capabilitySlug
            ? capabilitySignatureKey(matched.capabilitySlug)
            : classifyCall(
                cand.tc.name,
                (cand.tc.args ?? {}) as Record<string, unknown>,
              ).signatureKey;
          deps.recordAutoApproval({
            userId: userIdForMatch,
            scope: matched.scope,
            toolName: cand.tc.name,
            signatureKey,
            standingApprovalId: matched.id,
          });
        }
        approved.push(cand.tc);
        continue;
      }
      if (cand.isAutoAnomaly) {
        warn(
          `[post_model] Verb-map / trust disagreement for ${cand.tc.name}: trust=require_approval, verbMap=auto, severity=${cand.approval.severity}. Escalating to ask.`,
        );
      }
      askBatch.push({ tc: cand.tc, approval: cand.approval });
    }

    log(
      `[post_model] Trust pass: approved=${approved.length} pending=${pending.length} forbidden=${forbidden.length}. ` +
      `Verb pass: ask=${askBatch.length} prove_it=${proveItBatch.length} blocked=${blockedBatch.length}`,
    );

    const enrollmentReplayIds = [...(state.identityEnrollmentToolCallIds ?? [])]
      .sort();
    const proveItToolCallIds = proveItBatch
      .map((toolCall) => toolCall.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
    const rawToolCallIds = lastMessage.tool_calls
      .map((toolCall) => toolCall.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
    const exactEnrollmentReplay = proveItToolCallIds.length === proveItBatch.length
      && proveItToolCallIds.length === enrollmentReplayIds.length
      && proveItToolCallIds.every((id, index) => id === enrollmentReplayIds[index]);
    const legacyEnrollmentReplay = proveItBatch.length > 0
      && rawToolCallIds.length === lastMessage.tool_calls.length
      && rawToolCallIds.length === enrollmentReplayIds.length
      && rawToolCallIds.every((id, index) => id === enrollmentReplayIds[index]);
    if (
      enrollmentReplayIds.length > 0
      && (!exactEnrollmentReplay && !legacyEnrollmentReplay)
    ) {
      throw new Error("Identity enrollment tool batch changed before prove-it");
    }
    const replayingEnrollment = enrollmentReplayIds.length > 0 || proveItBatch.some((call) =>
      state.ordinaryContentAccessBindings?.[call.id ?? ""]?.pinEnrollmentRequired === true);

    // -----------------------------------------------------------------
    // Handle blocks first — no interrupt needed
    // -----------------------------------------------------------------

    const denialMessages: ToolMessage[] = [];

    for (const rejected of invalidRunShellTimeouts) {
      denialMessages.push(denialMessage(rejected.tc, rejected.error));
    }

    // Local MCP installs are an intentionally one-tool approval batch.
    // Prepare before emitting the interrupt so the dock is populated from the
    // server-normalized request + relay preflight, not from model-provided
    // text. `prepareInstall` is idempotent for this checkpoint/tool/approval
    // tuple, which makes LangGraph interrupt replay safe.
    let localMcpInstallApproval: LocalMcpInstallApproval | undefined;
    let localMcpInstallApprovalKey: string | undefined;
    let localMcpInstallPrepared: LocalMcpInstallPrepared | undefined;
    const localInstallEntries = askBatch.filter(({ tc }) => isManageLocalMcpInstall(tc));
    if (localInstallEntries.length > 0) {
      if (localInstallEntries.length !== 1 || askBatch.length !== 1 || !state.userId) {
        for (let i = askBatch.length - 1; i >= 0; i--) {
          if (isManageLocalMcpInstall(askBatch[i]!.tc)) {
            const removed = askBatch.splice(i, 1)[0]!;
            denialMessages.push(
              denialMessage(
                removed.tc,
                "Local MCP installation must be requested as one explicit action. Nothing was installed.",
              ),
            );
          }
        }
      } else {
        const entry = localInstallEntries[0]!;
        const approvalId = localMcpInstallApprovalId(state, entry.tc, laneKey);
        const request = (entry.tc.args as Record<string, unknown> | null | undefined)?.["request"];
        if (!approvalId || !request || typeof request !== "object" || Array.isArray(request)) {
          askBatch.length = 0;
          denialMessages.push(
            denialMessage(entry.tc, "Local MCP install request is invalid or cannot be bound to this approval."),
          );
        } else {
          try {
            const runtime = getLocalMcpToolRuntime();
            // `turnId` is minted at chat ingress and checkpointed across the
            // interrupt/resume lifecycle. It is the unique admission nonce;
            // graph thread ids deliberately persist across many turns.
            const checkpointKey = state.turnId.trim();
            const graphThreadId = state.langgraphThreadId || state.currentThreadId;
            if (!checkpointKey || !graphThreadId || !entry.tc.id) {
              throw new Error("local MCP install is missing a checkpoint-bound turn identity");
            }
            const prepared = await runtime.prepareInstall(
              { userId: state.userId },
              {
                intent: request as LocalMcpInstallModelIntent,
                approvalId,
                threadId: graphThreadId,
                laneKey,
                toolCallId: entry.tc.id,
                checkpointKey,
              },
            );
            if (!prepared.ok) {
              askBatch.length = 0;
              denialMessages.push(
                denialMessage(
                  entry.tc,
                  `Local MCP install cannot be approved: ${prepared.result.failure?.recovery ?? "review the request and try again."}`,
                ),
              );
            } else {
              const trustedCall: ToolCall = {
                ...entry.tc,
                // The subsequent tool node sees only this opaque receipt.
                // The original model proposal is never execution authority.
                args: {
                  action: "install",
                  approvalId: prepared.prepared.binding.approvalId,
                  digest: prepared.prepared.binding.digest,
                  // Checkpointed inside the trusted approved tool call. It is
                  // server-derived and never accepted from the model again.
                  prepared: prepared.prepared,
                },
              };
              const index = askBatch.indexOf(entry);
              askBatch[index] = { ...entry, tc: trustedCall };
              localMcpInstallApproval = {
                version: "local-mcp-install-v1",
                digest: prepared.prepared.binding.digest,
                preview: prepared.prepared.preview,
              };
              localMcpInstallApprovalKey = prepared.prepared.binding.approvalId;
              localMcpInstallPrepared = prepared.prepared;
            }
          } catch {
            askBatch.length = 0;
            // Proposal data is untrusted and may be secret-shaped. Never log
            // free-form preparation failures into the agent/server log.
            warn("[post_model] local MCP prepare failed");
            denialMessages.push(
              denialMessage(entry.tc, "Local MCP install could not be prepared safely. Nothing was installed."),
            );
          }
        }
      }
    }

    // Paid media asks are also exact, one-tool approvals. Preparation
    // normalizes the complete request and obtains an exact quote before the
    // interrupt; only the bounded public preview leaves this checkpoint.
    let mediaGenerationApproval: MediaGenerationApproval | undefined;
    let mediaGenerationApprovalKey: string | undefined;
    let mediaGenerationPrepared: MediaGenerationPreparedApproval | undefined;
    const mediaEntries = askBatch.filter(({ tc }) => isMediaGenerationToolCall(tc));
    if (mediaEntries.length > 0) {
      if (
        mediaEntries.length !== 1 || askBatch.length !== 1 ||
        !state.userId || !state.roomId || !state.agentId
      ) {
        for (let i = askBatch.length - 1; i >= 0; i--) {
          if (isMediaGenerationToolCall(askBatch[i]!.tc)) {
            const removed = askBatch.splice(i, 1)[0]!;
            denialMessages.push(denialMessage(
              removed.tc,
              "Paid media generation must be requested as one explicit action. No generation was started.",
            ));
          }
        }
      } else {
        const entry = mediaEntries[0]!;
        const approvalId = mediaGenerationApprovalId(state, entry.tc, laneKey);
        const graphThreadId = state.langgraphThreadId || state.currentThreadId;
        if (!approvalId || !graphThreadId || !entry.tc.id || !state.turnId.trim()) {
          askBatch.length = 0;
          denialMessages.push(denialMessage(
            entry.tc,
            "The paid media request could not be bound safely. No generation was started.",
          ));
        } else {
          try {
            const result = await prepareMediaGenerationApproval({
              actor: { userId: state.userId, roomId: state.roomId, agentId: state.agentId },
              intent: entry.tc.args,
              toolName: entry.tc.name === "generate_music" ? "generate_music" : "generate_video",
              approvalId,
              threadId: graphThreadId,
              turnId: state.turnId,
              laneKey,
              toolCallId: entry.tc.id,
            });
            if (!result.ok) {
              askBatch.length = 0;
              warn("[post_model] media generation preparation rejected", { code: result.code });
              denialMessages.push(denialMessage(
                entry.tc,
                result.recovery,
              ));
            } else {
              const prepared = result.prepared;
              const trustedCall: ToolCall = {
                ...entry.tc,
                args: {
                  approvalId: prepared.binding.approvalId,
                  receiptId: prepared.binding.receiptId,
                  digest: prepared.binding.approvalDigest,
                  quoteDigest: prepared.binding.quoteDigest,
                  revision: prepared.binding.revision,
                  prepared,
                },
              };
              askBatch[askBatch.indexOf(entry)] = { ...entry, tc: trustedCall };
              mediaGenerationApproval = mediaGenerationApprovalFromPrepared(prepared);
              mediaGenerationApprovalKey = prepared.binding.approvalId;
              mediaGenerationPrepared = prepared;
            }
          } catch {
            askBatch.length = 0;
            warn("[post_model] media generation quote preparation failed");
            denialMessages.push(denialMessage(
              entry.tc,
              "The exact media quote is unavailable right now. Try again later. No generation was started.",
            ));
          }
        }
      }
    }

    for (const f of forbidden) {
      const semanticComputerDenied = isSupportedComputerUseToolName(f.tc.name);
      denialMessages.push(
        new ToolMessage({
          content: semanticComputerDenied
            ? "Computer Use is unavailable because its live Desktop authorization or provider route is no longer current. Do not retry this tool or ask the Human to enable a separate tool permission. Refresh Computer Use readiness, then start a fresh foreground request."
            : prerequisiteFailures.get(f.tc)
              ?? memoryPreparationFailures.get(f.tc)
              ?? `This tool is not available to you. You do not have permission to use ${f.tc.name}.`,
          tool_call_id: f.tc.id ?? `forbidden_${f.tc.name}_${Date.now()}`,
          name: f.tc.name,
          status: "error",
          additional_kwargs: { nautilo_tool_status: "error" },
        }),
      );
    }

    // A detached/foreign semantic computer call is neither an
    // approval request nor a missing grant that Auto-Approve can repair. The
    // content-free typed payload lets a caller locate the original tool call
    // and reissue its intent from a new eligible foreground Human run.
    for (const { tc, decision } of computerUseNeedsUser) {
      denialMessages.push(
        new ToolMessage({
          content: "Desktop automation needs a new Human-originated foreground Genie run before this action can continue.",
          // The server-owned decision points back to the exact transcript
          // call; never synthesize a replacement refusal identity.
          tool_call_id: decision.intent.toolCallId,
          name: tc.name,
          additional_kwargs: {
            computer_use: {
              status: decision.status,
              reason: decision.reason,
              intent: decision.intent,
              recovery: "start_new_foreground_human_run",
            },
          },
        }),
      );
    }

    for (const b of blockedBatch) {
      denialMessages.push(
        new ToolMessage({
          content: `Security: blocked. ${b.reason}`,
          tool_call_id: b.tc.id ?? `blocked_${b.tc.name}_${Date.now()}`,
          name: b.tc.name,
          status: "error",
          additional_kwargs: { nautilo_tool_status: "error" },
        }),
      );
    }

    // -----------------------------------------------------------------
    // A live override/standing rule can change the batch between interrupts.
    // Retain only its layout commitment, never a second permission snapshot.
    // Otherwise a prior ask reply could occupy a newly introduced PIN slot.
    if (ordinaryPreviewByCall.size > 0) {
      const identity = (call: ToolCall) => ({ id: call.id, name: call.name });
      const layout = ordinaryContentAccessDigest({
        approved: approved.map(identity),
        proveIt: proveItBatch.map(identity),
        ask: askBatch.map(({ tc }) => identity(tc)),
        blocked: blockedBatch.map(({ tc }) => identity(tc)),
        denied: denialMessages.map((message) => message.tool_call_id),
      });
      const preparedLayout = await task("ordinary_content_access_approval_layout", () => Promise.resolve(layout))();
      if (preparedLayout !== layout) return {
        messages: mergeMessagesPreservingInvariants(state.messages, toolCalls.map(ordinaryShareDenialMessage)),
        approvedToolCalls: [], pendingApproval: [], ordinaryContentAccessBindings: {},
        computerUseInvocationBindings: {}, requiredHostRelays: {}, approvalDenied: true,
        identityEnrollmentToolCallIds: [],
      };
    }

    // Fire prove_it interrupt if needed.
    // -----------------------------------------------------------------

    if (proveItBatch.length > 0) {
      const enrollmentToolCallIds = proveItBatch
        .map((toolCall) => toolCall.id)
        .filter((id): id is string => typeof id === "string")
        .sort();
      // The Logto JWT establishes identity but a PIN is what
      // answers `prove_it`'s "are you really sure?" prompt. If the user doesn't have one yet,
      // raise an enrollPin challenge first; on resume we fall
      // through to the prove_it_challenge below as if the PIN had
      // always been there. The check is gated on a deps callback
      // so back-compat callers (and unit tests) get the existing flow
      // verbatim.
      if (
        deps?.isPinEnrolled &&
        state.userId
      ) {
        const enrolled = await deps.isPinEnrolled(state.userId);
        if (!enrolled || replayingEnrollment) {
          const protectedMemoryTools: NonNullable<
            IdentityChallengeEnrollPinPayload["protectedMemoryTools"]
          > = [];
          for (const tc of toolCalls) {
            if (!tc.id) continue;
            if (protectedMemoryEntries.has(tc)) {
              protectedMemoryTools.push({ toolCallId: tc.id, mode: "attach" });
              continue;
            }
            const snapshot = isProjectionLikeShareCall(tc)
              ? findProjectionSnapshot(state, tc)
              : null;
            if (snapshot !== null && "kind" in snapshot
              && snapshot.kind === "protected") {
              protectedMemoryTools.push({ toolCallId: tc.id, mode: "project" });
            }
          }
          protectedMemoryTools.sort((left, right) =>
            left.toolCallId.localeCompare(right.toolCallId)
          );
          const enrollPayload: IdentityChallengeEnrollPinPayload = {
            type: "identity_challenge",
            mode: "enrollPin",
            enrollmentToolCallIds,
            ...(state.userId ? { userId: state.userId } : {}),
            ...(protectedMemoryTools.length === 0
              ? {}
              : { protectedMemoryTools }),
          };
          log(
            `[post_model] Logto user ${state.userId} has no PIN; interrupting for enrollPin before prove_it (${proveItBatch.length} tool(s) pending)`,
          );
          // Resume value is unused here — the route's resumeGraphWith-
          // Identity passes `{ verified: true, ... }` and we just
          // continue. If the user dismisses without enrolling, the
          // graph stays paused on this interrupt and the prove_it
          // never fires. Subsequent attempts re-enter post-model
          // via a fresh turn.
          interrupt(enrollPayload);
        }
      }

      const payload: ProveItInterruptPayload = {
        type: "prove_it_challenge",
        tools: await Promise.all(proveItBatch.map(async (tc) => ordinaryPreviewByCall.get(tc) ?? protectedMemoryEntries.get(tc)
          ?? interruptToolEntry(tc, state, protectedMemoryAccessPort))),
        ...(state.userId ? { userId: state.userId } : {}),
      };
      log(`[post_model] Interrupting for prove_it: ${proveItBatch.map((tc) => tc.name).join(", ")}`);
      const decision: ResumeDecision | undefined = interrupt(payload);

      if (!decision?.approved) {
        // Deny all prove_it tools. Do NOT proceed to ask pass — a user
        // who denied PIN should not be asked a secondary lighter prompt.
        log(`[post_model] prove_it denied — denying ${proveItBatch.length} tool(s) and any ask-batch (${askBatch.length})`);
        for (const tc of proveItBatch) {
          denialMessages.push(denialMessage(tc, "Action denied. PIN approval not granted."));
        }
        for (const a of askBatch) {
          denialMessages.push(denialMessage(a.tc, "Action denied. Prior prove_it in the same batch was not approved."));
        }
        return {
          messages: mergeMessagesPreservingInvariants(state.messages, denialMessages),
          approvedToolCalls: approved,
          computerUseInvocationBindings: Object.fromEntries(computerUseInvocationBindings),
          requiredHostRelays: Object.fromEntries(requiredHostByToolCall),
          pendingApproval: [],
          approvalDenied: true,
          identityEnrollmentToolCallIds: [],
        };
      }

      log(`[post_model] prove_it approved, adding ${proveItBatch.length} tool(s)`);
      approved.push(...approveFresh(proveItBatch));
    }

    // -----------------------------------------------------------------
    // Fire approval_ask interrupt if needed.
    // -----------------------------------------------------------------

    if (askBatch.length > 0) {
      const payload = buildAskPayload(
        askBatch,
        state.userId || undefined,
        localMcpInstallApproval,
        localMcpInstallApprovalKey,
        mediaGenerationApproval,
        mediaGenerationApprovalKey,
      );
      payload.tools = await Promise.all(
        askBatch.map(async ({ tc }) => ordinaryPreviewByCall.get(tc) ?? protectedMemoryEntries.get(tc)
          ?? interruptToolEntry(tc, state, protectedMemoryAccessPort)),
      );
      log(`[post_model] Interrupting for approval_ask: ${askBatch.map(({ tc }) => tc.name).join(", ")} (${payload.reason})`);
      const decision: ResumeDecision | undefined = interrupt(payload);
      const verb: ApprovalReplyVerb = decision?.verb ?? "deny";

      // N-1: the `decision?.approved === false` leg is defensive — today
      // the server route always sets `approved = verb !== "deny"` so any
      // non-deny verb has `approved: true`. We keep the check as a belt-
      // and-suspenders guard against future resume shapes that could
      // decouple the two (e.g., a policy override that allows the server
      // to reject a previously-approved verb before the graph resumes).
      if (verb === "deny" || decision?.approved === false) {
        log(`[post_model] approval_ask denied — denying ${askBatch.length} tool(s)`);
        for (const a of askBatch) {
          denialMessages.push(denialMessage(a.tc, "Action denied by owner."));
        }
        return {
          messages: mergeMessagesPreservingInvariants(state.messages, denialMessages),
          approvedToolCalls: approved,
          computerUseInvocationBindings: Object.fromEntries(computerUseInvocationBindings),
          requiredHostRelays: Object.fromEntries(requiredHostByToolCall),
          pendingApproval: [],
          approvalDenied: true,
          identityEnrollmentToolCallIds: [],
        };
      }

      // The HTTP route echoes this digest only after it has checked the
      // prepared server binding. Check again at the graph boundary so a
      // stale/tampered resume value cannot reach the tools node.
      if (
        localMcpInstallApproval &&
        !matchesLocalMcpInstallResumeBinding({
          state,
          decision,
          prepared: localMcpInstallPrepared,
          laneKey,
          toolCallId: askBatch[0]?.tc.id ?? "",
          approvalId: localMcpInstallApprovalKey ?? "",
          digest: localMcpInstallApproval.digest,
          verb,
        })
      ) {
        log("[post_model] local MCP approval stale or non-explicit; refusing execution");
        for (const a of askBatch) {
          denialMessages.push(denialMessage(a.tc, "Local MCP approval is stale. Nothing was installed."));
        }
        return {
          messages: mergeMessagesPreservingInvariants(state.messages, denialMessages),
          approvedToolCalls: approved,
          computerUseInvocationBindings: Object.fromEntries(computerUseInvocationBindings),
          requiredHostRelays: Object.fromEntries(requiredHostByToolCall),
          pendingApproval: [],
          approvalDenied: true,
          identityEnrollmentToolCallIds: [],
        };
      }

      if (
        mediaGenerationApproval &&
        !matchesMediaGenerationResumeBinding({
          state,
          decision,
          prepared: mediaGenerationPrepared,
          laneKey,
          toolCallId: askBatch[0]?.tc.id ?? "",
          toolName: askBatch[0]?.tc.name === "generate_music" ? "generate_music" : "generate_video",
          approvalId: mediaGenerationApprovalKey ?? "",
          digest: mediaGenerationApproval.digest,
          quoteDigest: mediaGenerationApproval.quoteDigest,
          revision: mediaGenerationApproval.revision,
          verb,
        })
      ) {
        log("[post_model] media generation approval stale or non-explicit; refusing submission");
        for (const a of askBatch) {
          denialMessages.push(denialMessage(
            a.tc,
            "This media quote is stale or no longer matches the request. Request a fresh quote. No generation was started.",
          ));
        }
        return {
          messages: mergeMessagesPreservingInvariants(state.messages, denialMessages),
          approvedToolCalls: approved,
          requiredHostRelays: Object.fromEntries(requiredHostByToolCall),
          pendingApproval: [],
          approvalDenied: true,
          identityEnrollmentToolCallIds: [],
        };
      }

      // Persist room / always standing approvals before approving.
      // An expired exact share must not mint a standing permission on recovery.
      askBatch = askBatch.filter(({ tc }) => approveFresh([tc]).length > 0);
      for (const { tc } of askBatch) {
        if (verb === "room" || verb === "always") {
          if (state.userId) {
            const capabilitySlug = standingApprovalCapabilityForTool(tc.name);
            const scope = standingApprovalScopeForVerb(verb, state.roomId);
            if (scope === null) {
              warn(
                `[post_model] verb=room for ${tc.name} but no roomId on state (background job?) — refusing to persist standing approval.`,
              );
            } else if (capabilitySlug) {
              await createCapabilityFn({
                userId: state.userId,
                scope,
                roomId: scope === "room" ? state.roomId : null,
                capabilitySlug,
              });
              log(`[post_model] ${verb}-capability-rule written for ${tc.name} (${capabilitySlug})`);
            } else {
              const classified = classifyCall(
                tc.name,
                (tc.args ?? {}) as Record<string, unknown>,
              );
              await createFn({
                userId: state.userId,
                scope,
                roomId: scope === "room" ? state.roomId : null,
                toolName: tc.name,
                signature: classified.signature,
                signatureKey: classified.signatureKey,
              });
              log(`[post_model] ${verb}-rule written for ${tc.name} (${classified.signatureKey})`);
            }
          } else {
            warn(
              `[post_model] verb=${verb} for ${tc.name} but no userId on state — cannot persist standing approval.`,
            );
          }
          maybeWidenSandboxForApproval(laneKey, tc, state);
          // Map the DB scope onto the lane-keyed network/sandbox store's
          // lifetime taxonomy: room → "session" (closest lane lifetime),
          // always → "always". Durable network/sandbox rules tied to these
          // DB approvals are a deliberate follow-up (out of scope here).
          maybeWidenNetworkForApproval(
            laneKey,
            tc,
            standingApprovalScopeForVerb(verb, state.roomId) === null ? "once" : verb === "room" ? "session" : "always",
          );
        } else if (verb === "once") {
          maybeWidenNetworkForApproval(laneKey, tc, "once");
        }
        // verb === "once": no persistence, just this invocation
      }

      log(`[post_model] approval_ask verb=${verb} — approving ${askBatch.length} tool(s)`);
      approved.push(...askBatch.map(({ tc }) => tc));
    }

    // -----------------------------------------------------------------
    // Final result
    // -----------------------------------------------------------------

    approved = approveFresh(approved);

    if (denialMessages.length > 0) {
      return {
        messages: mergeMessagesPreservingInvariants(state.messages, denialMessages),
        approvedToolCalls: approved,
        computerUseInvocationBindings: Object.fromEntries(computerUseInvocationBindings),
        requiredHostRelays: Object.fromEntries(requiredHostByToolCall),
        pendingApproval: [],
        approvalDenied: true,
        identityEnrollmentToolCallIds: [],
      };
    }

    return {
      approvedToolCalls: approved,
      computerUseInvocationBindings: Object.fromEntries(computerUseInvocationBindings),
      requiredHostRelays: Object.fromEntries(requiredHostByToolCall),
      pendingApproval: [],
      approvalDenied: false,
      identityEnrollmentToolCallIds: [],
    };
  };
}

/**
 * Standalone post-model node that rejects all tool calls (no resolver = fail-closed).
 * @deprecated Use createPostModelNode(resolver) with an actual resolver instead.
 */
export const postModelNode = createPostModelNode(null);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StandingApprovalMatch {
  id: string;
  scope: CommandApprovalScope;
  viaCapability: boolean;
  capabilitySlug: string | null;
}

/**
 * Resolve the trust-policy capability slug for a tool from the catalog.
 * Unknown tools resolve to the catalog's internal ungrantable sentinel.
 */
export function requiredCapabilityForTool(toolName: string): string | null {
  const catalog = getToolCatalog();
  return catalog?.getToolPolicy(toolName).requiredCapability ?? null;
}

/**
 * Capability-scoped standing approvals are intentionally narrow. They encode
 * user intent for cohesive tool families where "always" naturally means "this
 * capability", not an unrelated umbrella. Add future capability grains
 * deliberately here.
 */
export function standingApprovalCapabilityForTool(toolName: string): string | null {
  const slug = requiredCapabilityForTool(toolName);
  return slug === "control_desktop" ? slug : null;
}

export function standingApprovalScopeForVerb(
  verb: ApprovalReplyVerb,
  roomId: string | null | undefined,
): CommandApprovalScope | null {
  if (verb === "always") return "server";
  if (verb === "room") return roomId ? "room" : null;
  return null;
}

/** Deterministic audit key when a capability standing approval auto-approves. */
export function capabilitySignatureKey(capabilitySlug: string): string {
  return `capability:${capabilitySlug}`;
}

/**
 * Build per-tool scope info for the ask dialog. Capability-gated tools
 * surface a capability grain for room/always; others keep exact-command grain.
 */
export function buildApprovalScopeInfo(tc: ToolCall): ApprovalScopeInfo {
  if (isManageLocalMcpInstall(tc)) {
    // The canonical exact-effect preview is the only user-facing rendering
    // for this receipt. Never run its checkpoint-carried request through the
    // generic command classifier, which serializes arbitrary tool args.
    return {
      onceDisplay: "exact local MCP install shown below",
      generalizedDisplay: "exact local MCP install shown below",
      sameAsOnce: true,
      approvalKind: "tool",
    };
  }
  if (isMediaGenerationToolCall(tc)) {
    return {
      onceDisplay: "exact paid media generation shown below",
      generalizedDisplay: "exact paid media generation shown below",
      sameAsOnce: true,
      approvalKind: "tool",
    };
  }
  const c = classifyCall(tc.name, (tc.args ?? {}) as Record<string, unknown>);
  const capabilitySlug = standingApprovalCapabilityForTool(tc.name);
  if (capabilitySlug) {
    return {
      onceDisplay: c.onceDisplay,
      generalizedDisplay: `capability: ${capabilitySlug}`,
      sameAsOnce: false,
      approvalKind: "capability",
      capabilitySlug,
    };
  }
  return {
    onceDisplay: c.onceDisplay,
    generalizedDisplay: c.generalizedDisplay,
    sameAsOnce: c.sameAsOnce,
    approvalKind: "tool",
  };
}

async function matchStandingApprovalForTool(input: {
  userId: string;
  roomId: string | null;
  tc: ToolCall;
  matchCapabilityFn: typeof matchCapabilityApproval;
  matchCommandFn: typeof matchCommandApproval;
}): Promise<StandingApprovalMatch | null> {
  const { userId, roomId, tc, matchCapabilityFn, matchCommandFn } = input;
  const capabilitySlug = standingApprovalCapabilityForTool(tc.name);
  if (capabilitySlug) {
    const capMatch = await matchCapabilityFn({
      userId,
      roomId,
      capabilitySlug,
    });
    if (capMatch) {
      return {
        id: capMatch.id,
        scope: capMatch.scope,
        viaCapability: true,
        capabilitySlug,
      };
    }
  }
  const cmdMatch = await matchCommandFn({
    userId,
    roomId,
    toolName: tc.name,
    args: (tc.args ?? {}) as Record<string, unknown>,
  });
  if (!cmdMatch) return null;
  return {
    id: cmdMatch.id,
    scope: cmdMatch.scope,
    viaCapability: false,
    capabilitySlug,
  };
}

function toolEntry(tc: ToolCall): ProveItToolInfo {
  const entry: ProveItToolInfo = {
    name: tc.name,
    args: (tc.args ?? {}) as Record<string, unknown>,
  };
  if (tc.id) entry.id = tc.id;
  if (tc.name === "run_shell") {
    const args = entry.args;
    const resolved = resolveRunShellTimeout(args);
    const reason = typeof args["timeout_reason"] === "string" ? args["timeout_reason"] : "";
    if (resolved.ok && resolved.requiresReason && reason.trim()) {
      const { timeout_reason: _timeoutReason, ...approvalArgs } = args;
      entry.args = approvalArgs;
      entry.runShellTimeout = {
        timeoutSeconds: resolved.timeoutMs! / 1_000,
        // This is intentionally not a compact generic-argument preview. Keep
        // the complete Human intent, while preserving the shared credential
        // redaction boundary before it reaches any approval client.
        reason: redactToolTranscriptCredentialMaterial(reason),
      };
    }
  }
  return entry;
}

/** @internal Exported for approval-payload redaction tests. */
export async function interruptToolEntry(
  tc: ToolCall,
  state: NautiloState,
  protectedMemoryAccessPort?: ProtectedAgentMemoryAccessPort,
): Promise<ProveItToolInfo> {
  const base = toolEntry(tc);
  if (isManageLocalMcpInstall(tc)) {
    // The checkpointed prepared receipt is execution authority only. The
    // public interrupt must contain the separately projected exact preview,
    // never actor/session/binding internals that happen to ride the trusted
    // tool call through the tools node.
    return { ...base, args: { action: "install" } };
  }
  if (isMediaGenerationToolCall(tc)) {
    // The full prompt and trusted receipt stay checkpoint-private. The public
    // approval event receives only `mediaGeneration.preview`.
    return { ...base, args: {} };
  }
  if (tc.name === "share_memory") {
    const projectionSnapshot = isProjectionLikeShareCall(tc)
      ? findProjectionSnapshot(state, tc)
      : null;
    if (projectionSnapshot) {
      const preview = projectionApprovalPreview(projectionSnapshot);
      if (preview === null) {
        return { ...base, args: { mode: "project" } };
      }
      return {
        ...base,
        args: projectionApprovalArgs(projectionSnapshot),
        shareMemoryPreview: preview,
      };
    }
    if (isProjectionLikeShareCall(tc)) {
      // Invalid projection-like input is rejected by preflight in a normal
      // graph run. Keep its provenance out of any defensive approval payload.
      return { ...base, args: { mode: "project" } };
    }
    try {
      const preview = await computeShareMemoryApprovalPreview(tc, {
        memoryAccessEnvelope: state.memoryAccessEnvelope,
        userId: state.userId,
        ...(protectedMemoryAccessPort === undefined
          ? {}
          : { protectedMemoryAccessPort }),
      });
      if (!preview && protectedMemoryAccessPort !== undefined) {
        throw new ProtectedMemoryToolUnavailableError("authorization_required");
      }
      return preview ? { ...base, shareMemoryPreview: preview } : base;
    } catch (err) {
      if (protectedMemoryAccessPort !== undefined) throw err;
      warn(`[post_model] share_memory preview enrichment failed: ${String(err)}`);
      return base;
    }
  }
  if (tc.name === "share_artifact") {
    try {
      const preview = await computeShareArtifactApprovalPreview(tc, {
        memoryAccessEnvelope: state.memoryAccessEnvelope,
        userId: state.userId,
      });
      return preview ? { ...base, shareArtifactPreview: preview } : base;
    } catch (err) {
      warn(`[post_model] share_artifact preview enrichment failed: ${String(err)}`);
      return base;
    }
  }
  return base;
}

function denialMessage(tc: ToolCall, content: string): ToolMessage {
  return new ToolMessage({
    content,
    tool_call_id: tc.id ?? `denied_${tc.name}_${Date.now()}`,
    name: tc.name,
    status: "error",
    additional_kwargs: { nautilo_tool_status: "error" },
  });
}

function ordinaryShareDenialMessage(tc: ToolCall): ToolMessage {
  return denialMessage(tc, JSON.stringify({
    error: "content_access_approval_stale", recovery: "prepare_new_call", message: ORDINARY_CONTENT_ACCESS_RECOVERY,
  }));
}

function strongerShareApproval(left: ResolvedApproval, right: ResolvedApproval): ResolvedApproval {
  const rank = { auto: 0, ask: 1, prove_it: 2, block: 3 };
  return rank[right.verb] > rank[left.verb] ? right : left;
}

/**
 * Read the current security level from the canonical runtime configuration.
 * Policy-affecting environment variables must not override server policy.
 */
function resolveSecurityLevel(): SecurityLevel {
  const runtimeConfig = fromRuntimeConfig();
  return runtimeConfig.nautilo_security_level;
}

/**
 * Derive the lane-scope key for sandbox/network widening stores. Prefer
 * the LangGraph thread id (stable across resumes). Fall back to a numeric
 * threadId projected to `thread-<n>`. Fails CLOSED with an Error if
 * neither is available — lane-keyed widening under an unknown lane is
 * a silent cross-user privilege escalation waiting to happen (every
 * orphan request would share one global "lane-unknown" bucket).
 *
 * Never use a shared sentinel as a missing lane's fallback.
 */
function resolveLaneKey(state: NautiloState): string {
  if (state.approvalLaneKey) return state.approvalLaneKey;
  if (state.langgraphThreadId) return state.langgraphThreadId;
  if (typeof state.threadId === "number" && state.threadId > 0) return `thread-${state.threadId}`;
  throw new Error(
    "[post_model] resolveLaneKey: cannot derive a lane key — neither langgraphThreadId nor a positive numeric threadId present on state. " +
    "Session approvals refuse to write under an unknown lane because orphan requests would otherwise collide into a single shared bucket.",
  );
}

function isManageLocalMcpInstall(tc: ToolCall): boolean {
  return tc.name === "manage_local_mcp" &&
    (tc.args as Record<string, unknown> | null | undefined)?.["action"] === "install";
}

function isManageLocalMcpRemove(tc: ToolCall): boolean {
  return tc.name === "manage_local_mcp" &&
    (tc.args as Record<string, unknown> | null | undefined)?.["action"] === "remove";
}

function isMediaGenerationToolCall(tc: ToolCall): tc is ToolCall & { name: MediaGenerationToolName } {
  return tc.name === "generate_video" || tc.name === "generate_music";
}

function isVideoGenerationPreparationCall(tc: ToolCall): boolean {
  return tc.name === "generate_video" &&
    (tc.args as Record<string, unknown> | null | undefined)?.["action"] === "prepare";
}

function mediaGenerationApprovalId(
  state: NautiloState,
  tc: ToolCall,
  laneKey: string,
): string | null {
  const turnId = state.turnId.trim();
  if (!tc.id || !turnId || !laneKey) return null;
  return `media-generation:${turnId}:${laneKey}:${tc.id}`;
}

export function matchesMediaGenerationResumeBinding(input: {
  readonly state: Pick<NautiloState,
    "userId" | "roomId" | "turnId" | "langgraphThreadId" | "currentThreadId" | "approvalLaneKey">;
  readonly decision: Pick<ResumeDecision,
    "mediaGenerationApprovalId" | "mediaGenerationDigest" | "mediaGenerationQuoteDigest" |
    "mediaGenerationLaneKey" | "mediaGenerationRevision"> | undefined;
  readonly prepared: MediaGenerationPreparedApproval | undefined;
  readonly laneKey: string;
  readonly toolCallId: string;
  readonly toolName: MediaGenerationToolName;
  readonly approvalId: string;
  readonly digest: string;
  readonly quoteDigest: string;
  readonly revision: number;
  readonly verb: ApprovalReplyVerb;
  readonly now?: Date;
}): boolean {
  const { state, decision, prepared } = input;
  const threadId = state.langgraphThreadId || state.currentThreadId;
  const approvalLaneKey = state.approvalLaneKey ?? "";
  return input.verb === "once" && prepared !== undefined &&
    decision?.mediaGenerationApprovalId === input.approvalId &&
    decision.mediaGenerationDigest === input.digest &&
    decision.mediaGenerationQuoteDigest === input.quoteDigest &&
    decision.mediaGenerationRevision === input.revision &&
    decision.mediaGenerationLaneKey === approvalLaneKey &&
    input.laneKey === approvalLaneKey &&
    verifyMediaGenerationPreparedApproval(prepared, {
      userId: state.userId,
      roomId: state.roomId,
      threadId,
      turnId: state.turnId,
      laneKey: approvalLaneKey,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      approvalId: input.approvalId,
      receiptId: prepared.binding.receiptId,
      digest: input.digest,
      quoteDigest: input.quoteDigest,
      revision: input.revision,
      ...(input.now ? { now: input.now } : {}),
    });
}

/**
 * Stable across LangGraph's interrupt replay. The checkpointed ingress turn
 * id is a per-turn nonce; a graph thread can span many independent asks.
 */
function localMcpInstallApprovalId(
  state: NautiloState,
  tc: ToolCall,
  laneKey: string,
): string | null {
  const checkpointKey = state.turnId.trim();
  if (!tc.id || !checkpointKey || !laneKey) return null;
  return `local-mcp-install:${checkpointKey}:${laneKey}:${tc.id}`;
}

/**
 * Exact graph-bound receipt check for the only-once local MCP install path.
 * Exported for focused replay/lane tests; no caller may substitute an ambient
 * thread id or a client-provided lane for the checkpoint's own facts.
 */
export function matchesLocalMcpInstallResumeBinding(input: {
  readonly state: Pick<NautiloState, "turnId" | "langgraphThreadId" | "currentThreadId" | "approvalLaneKey">;
  readonly decision: Pick<ResumeDecision,
    "localMcpInstallApprovalId" | "localMcpInstallDigest" | "localMcpInstallLaneKey"> | undefined;
  readonly prepared: LocalMcpInstallPrepared | undefined;
  readonly laneKey: string;
  readonly toolCallId: string;
  readonly approvalId: string;
  readonly digest: string;
  readonly verb: ApprovalReplyVerb;
}): boolean {
  const { state, decision, prepared } = input;
  const graphThreadId = state.langgraphThreadId || state.currentThreadId;
  const approvalLaneKey = state.approvalLaneKey ?? "";
  return input.verb === "once" &&
    prepared !== undefined &&
    state.turnId.length > 0 &&
    graphThreadId.length > 0 &&
    decision?.localMcpInstallApprovalId === input.approvalId &&
    decision.localMcpInstallDigest === input.digest &&
    approvalLaneKey.length > 0 &&
    input.laneKey === approvalLaneKey &&
    decision.localMcpInstallLaneKey === approvalLaneKey &&
    prepared.binding.approvalId === input.approvalId &&
    prepared.binding.digest === input.digest &&
    prepared.binding.threadId === graphThreadId &&
    prepared.binding.laneKey === approvalLaneKey &&
    prepared.binding.toolCallId === input.toolCallId &&
    prepared.binding.checkpointKey === state.turnId;
}

/**
 * Safely extract the `command` string from a run_shell tool call's
 * args object. Returns "" when missing or non-string. Keeps callers
 * from accidentally invoking `String(obj)` on a nested object and
 * getting "[object Object]" (which ESLint catches and would produce
 * misleading scanner input).
 */
function commandFromArgs(args: ToolCall["args"]): string {
  if (!args || typeof args !== "object") return "";
  const raw = (args as Record<string, unknown>)["command"];
  return typeof raw === "string" ? raw : "";
}

function maybeWidenSandboxForApproval(
  laneKey: string,
  tc: ToolCall,
  state: NautiloState,
): void {
  const approvedPath = extractApprovedWritablePath(tc, {
    currentFolder: state.currentFolder,
    workspacePath: state.workspacePath,
  });
  if (approvedPath === null) return;
  recordApprovedWritablePath(laneKey, approvedPath);
  log(
    `[sandbox] writablePaths widened for lane ${laneKey}: ${approvedPath} ` +
      `(approved for ${tc.name})`,
  );
}

function maybeWidenNetworkForApproval(
  laneKey: string,
  tc: ToolCall,
  verb: "once" | "session" | "always",
): void {
  const network = extractStaticNetworkApproval(tc);
  if (network === null) return;
  const rule = network.suggestedRule as NetworkAllowRule;
  if (verb === "once") {
    recordOneShotNetworkAllowRule(laneKey, approvalToolKey(tc), rule);
    log(`[sandbox] one-shot network allow for lane ${laneKey}: ${network.host}:${network.port}`);
    return;
  }
  recordApprovedNetworkAllowRule(laneKey, rule);
  log(`[sandbox] network allow widened for lane ${laneKey}: ${network.host}:${network.port}`);
}

export function extractStaticNetworkApproval(tc: ToolCall): ApprovalAskNetworkContext | null {
  if (tc.name !== "run_shell") return null;
  const command = commandFromArgs(tc.args);
  if (!command) return null;

  const urls = Array.from(command.matchAll(/https?:\/\/[^\s'"`<>]+/g), (match) => match[0]);
  const destinations = new Map<string, ApprovalAskNetworkContext>();
  for (const raw of urls) {
    try {
      const parsed = new URL(raw);
      const port = parsed.port
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "http:"
          ? 80
          : 443;
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) continue;
      const host = parsed.hostname.toLowerCase();
      destinations.set(`${host}:${port}`, {
        host,
        port,
        reason: "static URL in approved shell command",
        suggestedRule: {
          type: "domain",
          host,
          ports: [port],
        },
      });
    } catch {
      // Ignore malformed URL-like substrings; runtime denial still catches them.
    }
  }

  return destinations.size === 1 ? Array.from(destinations.values())[0]! : null;
}

/**
 * Parse hybrid `sensitivity` from tool args; fail-closed to sensitive.
 *
 * Exported for unit tests; not the primary module API.
 */
export function readHybridSensitivity(
  args: Record<string, unknown> | null | undefined,
): { value: "normal" | "sensitive"; wasInvalid: boolean } {
  return coerceHybridSensitivity(args?.["sensitivity"]);
}

/**
 * Run `resolveApproval` for a single tool call. Looks up tool impact
 * from the catalog, runs the command scanner if it's run_shell, and
 * checks the external-binary heuristic. All three feed the resolver.
 *
 * Exported for hybrid mapping and file-impact unit tests.
 */
export function resolveApprovalForToolCall(tc: ToolCall, level: SecurityLevel): ResolvedApproval {
  const catalog = getToolCatalog();
  const policy = catalog?.getToolPolicy(tc.name);
  const baseImpact: ToolImpact = (policy?.impact ?? "destructive") as ToolImpact;

  // Website task admission follows the user's request without a second
  // confirmation. Keep high-impact classification and all capability/envelope
  // checks; the browser pauses at an actual dangerous or out-of-scope action.
  // Do not apply this to an unknown tool or an explicitly approval-gated policy.
  if ((tc.name === "run_website_task" || tc.name === "act_connected_web_account")
    && policy?.requiresApproval === false) {
    return { ...resolveApproval({ toolImpact: baseImpact, toolName: tc.name }, level),
      verb: "auto", reason: "Carrying out the requested website task" };
  }

  const args = tc.args as Record<string, unknown> | null | undefined;
  const askPeerIncludesArtifacts = tc.name === "ask_peer" && (
    args?.["include_focused_artifacts"] === true ||
    (Array.isArray(args?.["artifact_ids"]) && args["artifact_ids"].length > 0)
  );
  // Ordinary ask_peer keeps its established one-confirmation static
  // behavior. Only its exact Artifact handoff branch uses hybrid sensitivity,
  // so adding the optional composition cannot make every legacy peer message
  // fail closed to a PIN challenge when `sensitivity` is absent.
  if (policy?.approvalMode === "hybrid" && (tc.name !== "ask_peer" || askPeerIncludesArtifacts)) {
    const sensitivity = readHybridSensitivity(
      args,
    );
    return resolveApproval(
      {
        toolImpact: baseImpact,
        toolName: tc.name,
        hybridSensitivity: sensitivity.value,
        hybridSensitivityWasInvalid: sensitivity.wasInvalid,
      },
      level,
    );
  }

  if (tc.name === "run_shell") {
    const cmd = commandFromArgs(tc.args);
    const commandScan = scanCommand(cmd, level);
    return resolveApproval(
      {
        toolImpact: baseImpact,
        commandScan,
        isExternalUnknownBinary: isExternalUnknownBinary(cmd),
        toolName: tc.name,
      },
      level,
    );
  }

  // The unified `file` tool dispatches on a
  // `command` arg with per-command severity (read_only / destructive_low
  // / destructive / destructive_high) that varies from the tool-level
  // `impact: "destructive"` registered in register-all.ts. Tool-level
  // impact is the conservative DEFAULT for tier routing; the approval
  // layer consults the per-command table to avoid over-gating harmless
  // reads and to honor "workspace auto, current HIL" zone semantics.
  //
  // Mapping from (command-severity, zone) → effective ToolImpact that
  // feeds the existing verb-map:
  //   read_only         → read-only (auto at every security level)
  //   destructive_low   → if zone==workspace: low (auto)
  //                       else: high (ask)
  //   destructive       → if zone==workspace: low (auto)
  //                       else: destructive (ask)
  //   destructive_high  → destructive (ask) regardless of zone
  //                       (delete + recursive always HIL gated)
  //
  // Defensive: unknown command / non-string command / non-file tool
  // all hit the default path and use tool-level impact unchanged.
  if (tc.name === "file") {
    const effectiveImpact = effectiveFileToolImpact(tc.args, baseImpact);
    return resolveApproval(
      { toolImpact: effectiveImpact, toolName: tc.name },
      level,
    );
  }

  // The `officecli` tool dispatches on a `command` arg and
  // supports `zone: "current" | "absolute"` (the user's machine, via the relay
  // byte transport). Its catalog `impact` is "low" (auto), which is correct for
  // workspace, home and scratch writes (server-owned zones). But
  // current/absolute MUTATIONS touch the user's machine and must HIL-gate like
  // the `file` tool's current/absolute writes. Read-only office commands stay
  // auto regardless of zone.
  if (tc.name === "officecli") {
    const effectiveImpact = effectiveOfficeCliImpact(tc.args, baseImpact);
    return resolveApproval(
      { toolImpact: effectiveImpact, toolName: tc.name },
      level,
    );
  }

  // Local-backend `convert` calls are auto-approved upstream in
  // checkToolAccess (artifact creation, no egress) and never reach here.
  // Anything that does reach here is a CloudConvert egress call → treat as
  // destructive so the verb map returns "ask" (network egress is HIL-gated).
  if (tc.name === "convert") {
    return resolveApproval(
      { toolImpact: "destructive", toolName: tc.name },
      level,
    );
  }

  // Install is forced to an explicit ask by the main post-model
  // admission loop (before workstation or standing-approval handling).
  // Keep this resolver truthful for direct/unit callers too.
  if (tc.name === "manage_local_mcp") {
    const action = (tc.args as Record<string, unknown> | null | undefined)?.["action"];
    if (action === "install" || action === "enable" || action === "remove") {
      const resolved = resolveApproval(
        { toolImpact: "destructive", toolName: tc.name },
        level,
      );
      return action === "install" || action === "remove"
        ? {
            ...resolved,
            verb: "ask",
            reason: action === "install"
              ? "Installing a local MCP requires explicit review of the exact launch."
              : "Removing a local MCP requires explicit confirmation of the exact connection and machine.",
          }
        : resolved;
    }
    // Defensive: a non-install verb should never reach the verb map, but
    // if it does, keep it benign (auto) rather than escalating.
    return resolveApproval({ toolImpact: "low", toolName: tc.name }, level);
  }

  return resolveApproval({ toolImpact: baseImpact, toolName: tc.name }, level);
}

/**
 * Map the `file` tool's command + zone args to an
 * effective `ToolImpact` for the existing security/verb-map layer.
 * Keeps the approval pipeline unchanged structurally; just computes
 * a finer-grained impact for the one tool that dispatches on a
 * command arg.
 *
 * Pulled out as a named helper so tests can pin the mapping
 * explicitly without re-running the whole post-model pipeline.
 *
 * Exported for test-only consumption; not part of the module's
 * primary API.
 */
export function effectiveFileToolImpact(
  args: Record<string, unknown> | null | undefined,
  fallback: ToolImpact,
): ToolImpact {
  const command = typeof args?.["command"] === "string" ? args["command"] : null;
  const zone = typeof args?.["zone"] === "string" ? args["zone"] : null;
  if (!command) return fallback;

  const severity = resolveFileCommandPolicy(command);
  // workspace + home alias are "her drawer" — auto-approve writes.
  // The home and scratch aliases still route to workspace at
  // the zone-resolver layer; honor here for approval too.
  const isWorkspaceZone = zone === "workspace" || zone === "home" || zone === "scratch";

  switch (severity) {
    case "read_only":
      // All read commands auto regardless of zone. Agents `list`-ing
      // the user's current folder is table stakes; prompting for
      // every read would be UX disaster.
      return "read-only";
    case "destructive_low":
      // Non-destructive to source (copy). Workspace auto; other
      // zones get "high" (ask, but not destructive-severity prompts).
      return isWorkspaceZone ? "low" : "high";
    case "destructive":
      // Single-file mutation (write / str_replace / insert / move).
      // Workspace auto (her drawer; she OWNS drafts/research/etc.);
      // other zones prompt with destructive-severity UI.
      return isWorkspaceZone ? "low" : "destructive";
    case "destructive_high":
      // delete — always gates regardless of zone. The spec's "delete
      // + recursive: true always approval-gated regardless of zone"
      // is enforced here by treating the whole command as destructive
      // rather than peering at args.recursive. Conservative; avoids
      // "delete a directory without recursive then get surprised by
      // ENOTEMPTY" UX surface.
      return "destructive";
    default: {
      // Exhaustiveness check — if FileCommandSeverity gains a new
      // variant and this switch isn't updated, TS fails the build.
      const _exhaustive: never = severity;
      void _exhaustive;
      return fallback;
    }
  }
}

/**
 * Read-only OfficeCLI commands (mirror `READ_ONLY_COMMANDS` in
 * `tools/office/officecli.ts`). Everything else is a mutation.
 */
const OFFICECLI_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "view",
  "get",
  "query",
  "validate",
  "dump",
  "raw",
  "help",
]);

/**
 * Map the `officecli` tool's (command, zone) to an effective
 * `ToolImpact` for the verb map. Parallels `effectiveFileToolImpact`:
 *   - read-only command → read-only (auto at every level, any zone)
 *   - mutation on workspace, home or scratch → low (auto — server-owned zones)
 *   - mutation on current/absolute → destructive (ask — touches the user's
 *     machine, parity with the `file` tool's current/absolute single-file
 *     mutations)
 *
 * Exported for test-only consumption; not part of the module's primary API.
 */
export function effectiveOfficeCliImpact(
  args: Record<string, unknown> | null | undefined,
  fallback: ToolImpact,
): ToolImpact {
  const command = typeof args?.["command"] === "string" ? args["command"] : null;
  const zone = typeof args?.["zone"] === "string" ? args["zone"] : null;
  if (!command) return fallback;

  if (OFFICECLI_READ_ONLY_COMMANDS.has(command)) return "read-only";

  // Mutation. current/absolute reach the user's machine → HIL-gate.
  const isRelayZone = zone === "current" || zone === "absolute";
  return isRelayZone ? "destructive" : "low";
}

/**
 * Build the `approval_ask` interrupt payload from a batch of
 * ask-pending tools. Pure function — exported for unit tests
 * that assert payload shape directly rather than inferring from a throw.
 *
 * Responsibilities:
 * - Map each tool call to the `{ name, args, id? }` shape the
 *   client expects.
 * - Concatenate per-tool reasons into a single string. Single-
 *   reason batches emit the reason verbatim; multi-reason batches
 *   emit `"(1) reason; (2) reason; ..."`.
 * - Pick the batch's `reasonCode` via worst-severity-wins
 *   (see `classifyReasonCodeForBatch`).
 * - Expose the full four-verb set as `allowedVerbs`. Future
 *   per-level restriction (e.g. hide `always` in paranoid mode)
 *   will narrow this subset.
 */
export function buildAskPayload(
  batch: ReadonlyArray<{ tc: ToolCall; approval: ResolvedApproval }>,
  subjectUserId?: string,
  localMcpInstall?: LocalMcpInstallApproval,
  localMcpInstallApprovalId?: string,
  mediaGeneration?: MediaGenerationApproval,
  mediaGenerationApprovalId?: string,
): ApprovalAskInterruptPayload {
  const exactLocalMcpRemoval = batch.length === 1 && isManageLocalMcpRemove(batch[0]!.tc);
  const reasons = Array.from(new Set(batch.map(({ approval }) => approval.reason)));
  const combinedReason = reasons.length === 1
    ? reasons[0]!
    : reasons.map((r, i) => `(${i + 1}) ${r}`).join("; ");

  const scopeInfo: ApprovalScopeInfo[] = batch.map(({ tc }) => buildApprovalScopeInfo(tc));

  return {
    type: "approval_ask",
    approvalId: localMcpInstallApprovalId ?? mediaGenerationApprovalId ?? randomUUID(),
    tools: batch.map(({ tc }) => isManageLocalMcpInstall(tc)
      ? { ...toolEntry(tc), args: { action: "install" } }
      : isMediaGenerationToolCall(tc) ? { ...toolEntry(tc), args: {} } : toolEntry(tc)),
    reason: combinedReason,
    reasonCode: classifyReasonCodeForBatch(batch),
    ...(networkContextForAskBatch(batch) !== null
      ? { network: networkContextForAskBatch(batch)! }
      : {}),
    allowedVerbs: localMcpInstall || mediaGeneration || exactLocalMcpRemoval
      ? ["once", "deny"]
      : ["once", "room", "always", "deny"],
    scopeInfo,
    ...(localMcpInstall
      ? { localMcpInstall, requiresExplicitReview: true }
      : mediaGeneration
        ? { mediaGeneration, requiresExplicitReview: true }
        : exactLocalMcpRemoval ? { requiresExplicitReview: true } : {}),
    ...(subjectUserId ? { userId: subjectUserId } : {}),
  };
}

function networkContextForAskBatch(
  batch: ReadonlyArray<{ tc: ToolCall; approval: ResolvedApproval }>,
): ApprovalAskNetworkContext | null {
  if (batch.length !== 1) return null;
  return extractStaticNetworkApproval(batch[0]!.tc);
}

/**
 * Classify why the ask dialog is firing, for client-side theming /
 * analytics. Pure function — exported for batch-path unit tests.
 *
 * Per-entry mapping:
 * - severity === "destructive-high"   → "command-scanner-high"
 * - severity === "destructive-medium" → "command-scanner-medium"
 * - run_shell + isExternalUnknownBinary → "external-binary"
 * - severity === "destructive-low" or "high-impact" → "destructive-tool"
 * - fallback → "tier-bump"
 */
export function classifyReasonCodeForEntry(entry: { tc: ToolCall; approval: ResolvedApproval }): ApprovalAskReason {
  const { approval, tc } = entry;
  if (approval.severity === "destructive-high") return "command-scanner-high";
  if (approval.severity === "destructive-medium") return "command-scanner-medium";
  if (tc.name === "run_shell") {
    const cmd = commandFromArgs(tc.args);
    if (isExternalUnknownBinary(cmd)) return "external-binary";
  }
  if (approval.severity === "destructive-low" || approval.severity === "high-impact") return "destructive-tool";
  return "tier-bump";
}

/**
 * Ordering of `ApprovalAskReason` by severity — higher index means
 * more severe / more friction. Used to pick the batch's reasonCode
 * via worst-severity-wins, rather than presenting only the first tool's
 * reason in a mixed batch.
 */
const REASON_SEVERITY_ORDER: readonly ApprovalAskReason[] = [
  "tier-bump",             // lightest — pure level shift
  "destructive-tool",      // destructive impact but no scanner hit
  "external-binary",       // user-vetting signal
  "command-scanner-medium",// regex hit, medium severity
  "command-scanner-high",  // regex hit, high severity (rare at ask — mostly prove_it)
];

function reasonSeverityRank(reason: ApprovalAskReason): number {
  const idx = REASON_SEVERITY_ORDER.indexOf(reason);
  return idx < 0 ? 0 : idx;
}

/**
 * Batch-aware reasonCode: pick the HIGHEST-severity reason across
 * every tool in the batch. Mixed batches (e.g. one destructive-tool
 * call + one external-binary) surface the stronger signal to the UI,
 * not whichever happened to be first.
 */
export function classifyReasonCodeForBatch(
  batch: ReadonlyArray<{ tc: ToolCall; approval: ResolvedApproval }>,
): ApprovalAskReason {
  if (batch.length === 0) return "tier-bump";
  let worst = classifyReasonCodeForEntry(batch[0]!);
  let worstRank = reasonSeverityRank(worst);
  for (let i = 1; i < batch.length; i++) {
    const candidate = classifyReasonCodeForEntry(batch[i]!);
    const rank = reasonSeverityRank(candidate);
    if (rank > worstRank) {
      worst = candidate;
      worstRank = rank;
    }
  }
  return worst;
}
