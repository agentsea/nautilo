import { finishMemoryReviewTurn, memoryReviewAdmission, memoryReviewCompletionState } from "../memory-review/admission";
import type { ServerEvent, VerifiedOrdinaryOrigin } from "@nautilo/types";
import {
  StrictShadowEnforcementError,
  type ProtectedAgentMemoryRepository,
  type StrictShadowEnforcementPolicy,
} from "@nautilo/lattice-bridge";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildForegroundUserHumanMessage,
  createNautiloGraph,
  defaultPostModelDeps,
  selectPromptBriefMemories,
  stagePromptBriefMemoryStructuralPage,
  loadPromptBriefMemoryOrdinarySelections,
  commitPromptBriefMemoryOverflow,
  getAgentExecutionConfigById,
  getAgentDisplayNameById,
  getDefaultModel,
  loadForegroundModelControlSnapshot,
  foregroundModelControlPlanFromSnapshot,
  resolveModelRole,
  collectPendingInterruptEvents,
  interruptValueToServerEvent,
  maybeSummarizeImagesWithVisionFallback,
  postTurnFallbackContextForTurn,
  postTurnFallbackContextForTurnByKey,
  shouldSuppressFallbackEmission,
  clearAgentTurnContext,
  buildRuntimeCapabilityTokens,
  getRelayRegistry,
  getOrCreateAgentTurnContextByKey,
  getAgentTurnContextByKey,
  reportModelAttemptProgressByKey,
  getAgentTurnContext,
  resolveEnabledBodies,
  turnContextKey,
  seedAgentRedirectDepthByKey,
  consumeAgentRedirectRequestByKey,
  clearAgentTurnContextByKey,
  resolveGraphExecutionPolicy,
  GraphExecutionMetrics,
  toGraphBudgetOutcome,
  type NautiloGraphDeps,
  parseTaskReportBackContinuation,
  classifyModelStreamProgress,
  modelAttemptIdFromStreamEvent,
} from "@nautilo/agent";

// Re-export so existing importers (notably the runtime's own unit
// tests) keep their import path stable after D084 relocated the
// helper into `@nautilo/agent`.
export { interruptValueToServerEvent };
import { debug, log, warn } from "@nautilo/logger";
import { classifyTurnKind, type TurnKind } from "./turn-kind";
import {
  buildProtectedRoomHybridContext,
  buildTranscriptContext,
  type BuildTranscriptContextDeps,
} from "../context/build-transcript-context";
import { defaultBuildTranscriptContextDeps } from "../context/build-transcript-context-deps";
import type { MemoryAccessEnvelope, RoomParticipant } from "@nautilo/trust";
import {
  envelopeReadableNamespaces,
  getPolicyResolver,
  isScopeMemoryEnvelope,
} from "@nautilo/trust";
import { eventBus } from "../event-bus";
import {
  notifyRedirectCompletion,
  type RedirectRequestView,
} from "../agent-redirect";
import { TokenBatcher, ToolCallTracker } from "../utils/token-batcher";
import {
  AgentProgressHeartbeat,
  noteAgentProgressFromStreamEvent,
} from "../utils/agent-progress-heartbeat";
import { persistMessages, sanitizeMessageForTranscript } from "./persist-messages";
import { SentenceDetector, type SentenceDetectorConfig } from "../utils/sentence-detector";
import { parseMultimodalImagesFromJobInput } from "./multimodal-job-input";
import {
  parseActiveMiniAppInput,
  parseArtifactRefsInput,
  parseFocusedResourcesInput,
  parseTrustedLiveMiniAppSessionInput,
} from "../lane-coalescer";
import {
  checkpointSaverForConversationExecution,
  type ProtectedConversationExecutorTurnScope,
  type ProtectedConversationExecutionServices,
} from "../conversation/conversation-execution-services";
import {
  disposeProtectedCheckpointSaver,
} from "../conversation/protected-checkpoint-saver-disposal";
import { foregroundRecordRecallPortForState } from "../reflection/foreground-record-recall";
import { foregroundRecordContextPortForRoom } from "../reflection/foreground-record-context";
import { admitFreshComputerUseRoot } from "./computer-use-root-admission";
import {
  enforceLiveShadowForegroundHistoryBoundary,
  getCurrentLiveShadowTurnContext,
  protectLiveShadowForegroundHistory,
  protectLiveShadowForegroundJournal,
  protectLiveShadowForegroundMemories,
  protectLiveShadowForegroundRecordContext,
  protectLiveShadowForegroundRecordRecall,
} from
  "../conversation/live-shadow-turn-context";
import { prepareForegroundEncryptedContext } from
  "../conversation/foreground-context-preparation";
import { stageProtectedPromptMemoryBrief } from
  "../conversation/protected-prompt-memory-staging";
import { createLiveShadowAgentRuntimeTurn } from
  "../conversation/live-shadow-agent-runtime";
import {
  createLiveShadowCheckpointSaver,
  requiresEncryptedForegroundCheckpoint,
} from
  "../conversation/live-shadow-checkpoint-saver";
import {
  protectLiveShadowAssistantToken,
  publishLiveShadowRuntimeMessages,
} from "../conversation/live-shadow-agent-runtime-events";
import type { LiveShadowAgentRuntimeTurn } from
  "../conversation/live-shadow-agent-runtime";
import type {
  LiveShadowAgentTurnSession,
} from "@nautilo/lattice-bridge/server";
import { loadForegroundAuthoredContext } from
  "./foreground-authored-context";

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/**
 * Resolve the protected mutation repository once for a normal foreground
 * Namespace turn. Plaintext, scope, task and fork paths remain unchanged.
 */
export async function resolveForegroundProtectedMemoryRepository(
  input: Readonly<{
    envelope: MemoryAccessEnvelope | null;
    session: Pick<
      LiveShadowAgentTurnSession,
      "createForegroundMemoryRepository"
    > | null | undefined;
    policy: StrictShadowEnforcementPolicy | undefined;
    normalForeground: boolean;
  }>,
): Promise<ProtectedAgentMemoryRepository | undefined> {
  if (
    !input.normalForeground
    || input.envelope === null
    || isScopeMemoryEnvelope(input.envelope)
    || input.policy?.mode === "plaintext_only"
    || input.policy === undefined
    || input.session === null
    || input.session === undefined
  ) return undefined;
  if (input.session.createForegroundMemoryRepository === undefined) {
    if (input.policy.mode === "shadow_encryption"
      && input.policy.shadowBehavior === "fallback") return undefined;
    throw new StrictShadowEnforcementError({
      boundaryId: "memory.write.foreground_agent",
      family: "memory",
      operation: "mutation_tools",
      actorClass: "agent",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
      policyRevision: input.policy.revision,
    });
  }
  return input.session.createForegroundMemoryRepository(input.envelope);
}

/** Shared fresh/resumed foreground composition; all custody stays invocation-local. */
export async function resolveForegroundProtectedMemoryGraphDeps(input: Readonly<{
  envelope: MemoryAccessEnvelope | null;
  session: Pick<LiveShadowAgentTurnSession, "createForegroundMemoryRepository"
    | "createForegroundMemoryAccessPort" | "createForegroundMemoryProjectionPort"> | null | undefined;
  policy: StrictShadowEnforcementPolicy | undefined;
  normalForeground: boolean;
}>): Promise<NautiloGraphDeps> {
  const repository = await resolveForegroundProtectedMemoryRepository(input);
  const envelope = input.envelope;
  const fullEncryptionOnlyForState = () => input.policy?.mode === "encrypted_only";
  if (repository === undefined || envelope === null || isScopeMemoryEnvelope(envelope)) {
    return { fullEncryptionOnlyForState };
  }
  const access = await input.session?.createForegroundMemoryAccessPort?.(envelope);
  const projection = await input.session?.createForegroundMemoryProjectionPort?.(envelope);
  const assertInvocation = (state: Parameters<NonNullable<NautiloGraphDeps["protectedMemoryRepositoryForState"]>>[0]) => {
    const current = state.memoryAccessEnvelope;
    const sameNamespaces = (left: readonly string[], right: readonly string[]) =>
      JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
    const eligible = !state.taskRun && !state.subagentRun && state.userId === envelope.ownerId
    && state.memoryAccessEnvelope?.actorId === envelope.actorId
    && state.memoryAccessEnvelope?.agentId === envelope.agentId
    && state.memoryAccessEnvelope?.roomId === envelope.roomId
    && current !== null && current !== undefined && !isScopeMemoryEnvelope(current)
    && sameNamespaces(current.readableNamespaces, envelope.readableNamespaces)
    && sameNamespaces(current.mutableNamespaces, envelope.mutableNamespaces)
    && sameNamespaces(current.writableNamespaces, envelope.writableNamespaces);
    if (!eligible) throw new TypeError("Foreground Memory invocation authority changed");
  };
  return {
    fullEncryptionOnlyForState,
    protectedMemoryRepositoryForState: (state) => { assertInvocation(state); return repository; },
    ...(access === undefined ? {} : {
      protectedMemoryAccessPortForState: (state: Parameters<typeof assertInvocation>[0]) => { assertInvocation(state); return access; },
    }),
    ...(projection === undefined ? {} : {
      protectedMemoryProjectionPortForState: (state: Parameters<typeof assertInvocation>[0]) => { assertInvocation(state); return projection; },
    }),
  };
}

/** Server-authored continuation metadata, never inferred from message text. */
function connectedWebSupervisionMetadata(input: Readonly<Record<string, unknown>>) {
  const metadata = input["metadata"] as Record<string, unknown> | undefined;
  if (metadata?.["originatedBy"] !== "connected_web_operation"
    || typeof metadata["operationId"] !== "string" || !metadata["operationId"]
    || !Number.isSafeInteger(metadata["controlEpoch"]) || Number(metadata["controlEpoch"]) < 1) return undefined;
  return { originatedBy: "connected_web_operation", operationId: metadata["operationId"], controlEpoch: metadata["controlEpoch"] };
}

export function freshForegroundActivationState(input: Record<string, unknown>): {
  subagentDepth: 0;
  subagentRun: false;
  taskRun: false;
  trustedExecutionEntrypoint: "foreground.main" | "foreground.task_report_back" | null;
  suppressToolLifecycleEvents: boolean;
  modelFallbackMode: "agent_chain";
  researchContextRecovery: null;
  researchContextPageBytes: null;
  researchContinuationRequired: false;
} {
  return {
    subagentDepth: 0,
    subagentRun: false,
    taskRun: false,
    // Persisting a group-Room Human message before routing is a storage detail,
    // not an authority downgrade. A directly addressed Agent (mention, reply,
    // or UI choice) remains the Human's foreground turn and may retain its
    // verified Desktop return binding. Inferred/magic-router wakes still fail
    // closed and cannot borrow that authority. Direct agent-mediated sends
    // carry the same server-authored causal Human id.
    trustedExecutionEntrypoint: connectedWebSupervisionMetadata(input) !== undefined ? null :
      (input["metadata"] as Record<string, unknown> | undefined)?.["originatedBy"] === "task"
        ? "foreground.task_report_back"
        : typeof input["causalHumanUserId"] === "string"
      && input["causalHumanUserId"].length > 0
      && (
        input["humanAlreadyPersisted"] !== true
        || input["explicitlySelected"] === true
      )
        ? "foreground.main"
        : null,
    suppressToolLifecycleEvents: connectedWebSupervisionMetadata(input) !== undefined || input["suppressToolLifecycleEvents"] === true,
    modelFallbackMode: "agent_chain",
    researchContextRecovery: null,
    researchContextPageBytes: null,
    researchContinuationRequired: false,
  };
}

/** Wave 9 initial context is conversational Room-only, including group wakes. */
export function freshForegroundRecordContextEligible(
  input: Readonly<Record<string, unknown>>,
): boolean {
  const metadata = input["metadata"] as Readonly<Record<string, unknown>> | undefined;
  return typeof input["roomId"] === "string"
    && input["roomId"].length > 0
    && input["taskRun"] !== true
    && input["subagentRun"] !== true
    && metadata?.["originatedBy"] !== "task"
    && metadata?.["originatedBy"] !== "connected_web_operation"
    && typeof input["scopeId"] !== "string";
}

/**
 * Fresh foreground turns must overwrite these ephemeral checkpoint channels.
 * Resume handlers do not call this executor, so their checkpoint state remains
 * intact while a missing/invalid fresh-turn payload deliberately clears it.
 */
export function freshForegroundTurnScopedGraphContext(input: Record<string, unknown>) {
  return {
    activeMiniApp: parseActiveMiniAppInput(input["activeMiniApp"]),
    liveMiniAppSession: parseTrustedLiveMiniAppSessionInput(input["liveMiniAppSession"]),
    artifactRefs: parseArtifactRefsInput(input["artifactRefs"]),
    focusedResources: parseFocusedResourcesInput(input["focusedResources"]),
  };
}

/**
 * Strict boundary parser shared by main and M085 fork foreground executors.
 * A job input is not itself authority: only this complete server-authored
 * ordinary-origin shape may reach graph state and host admission.
 */
export function parseVerifiedOrdinaryOrigin(value: unknown): VerifiedOrdinaryOrigin | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const origin = value as Record<string, unknown>;
  if (origin["kind"] === "local_electron") {
    if (
      typeof origin["userId"] !== "string" ||
      typeof origin["actorId"] !== "string" ||
      typeof origin["relayId"] !== "string" ||
      typeof origin["desktopSessionId"] !== "string" ||
      typeof origin["pairingGeneration"] !== "string" ||
      typeof origin["requestId"] !== "string"
    ) return null;
    return origin as unknown as VerifiedOrdinaryOrigin;
  }
  if (
    origin["kind"] !== "paired_mobile" ||
    typeof origin["serverInstanceId"] !== "string" ||
    !Number.isInteger(origin["serverBindingGeneration"]) ||
    typeof origin["userId"] !== "string" ||
    typeof origin["actorId"] !== "string" ||
    typeof origin["controllerInstallationId"] !== "string" ||
    !Number.isInteger(origin["installationGeneration"]) ||
    typeof origin["requestId"] !== "string"
  ) return null;
  return origin as unknown as VerifiedOrdinaryOrigin;
}

/**
 * Compatibility seam for the redirect tests. Runtime no longer calls this:
 * the Agent-owned supervisor makes the no-splice/fallback decision from the
 * same turn-context visibility fact before it cancels an attempt.
 */
export function shouldGraphAbortOnStreamTimeout(turnId: string | undefined): boolean {
  if (!turnId?.trim()) return false;
  return getAgentTurnContext(turnId)?.assistantVisibleOutput === true;
}

/** D421 Phase 4.2 — key-explicit variant for the per-agent slot. */
export function shouldGraphAbortOnStreamTimeoutByKey(key: string | undefined): boolean {
  const k = key?.trim();
  if (!k) return false;
  return getAgentTurnContextByKey(k)?.assistantVisibleOutput === true;
}

/** D421 Phase 4.2 — key-explicit variant for the per-agent slot. */
function markAssistantVisibleOutputForTurnByKey(key: string | undefined): void {
  const k = key?.trim();
  if (!k) return;
  getOrCreateAgentTurnContextByKey(k).assistantVisibleOutput = true;
}

/**
 * D421 Phase 4.2 — consume the recorded redirect request exactly once on the
 * executor SUCCESS path and notify the runtime-internal completion hook. The
 * request is consumed BEFORE turn-context cleanup ({@link clearAgentTurnContext})
 * so the single-consumption CAS cannot race cleanup. The hook is invoked
 * in-memory (never on the room `eventBus`). The tool's raw internal reason is
 * discarded here and never crosses into runtime. On a no-request success the hook is notified with
 * `completed_no_request` so the server can clean its pending context.
 */
async function finalizeSourceRedirectOnSuccess(
  turnContextId: string,
  humanTurnId: string,
  sourceAgentId: string,
): Promise<void> {
  if (!turnContextId.trim() || !humanTurnId.trim() || !sourceAgentId.trim()) return;
  const sourceAssistantVisibleOutput =
    getAgentTurnContextByKey(turnContextId)?.assistantVisibleOutput === true;
  const request = consumeAgentRedirectRequestByKey(turnContextId);
  if (request) {
    const view: RedirectRequestView = {
      targetHandle: request.targetHandle,
      depth: 1,
    };
    await notifyRedirectCompletion({
      kind: "fulfilled",
      turnContextId,
      humanTurnId,
      sourceAgentId,
      request: view,
      sourceAssistantVisibleOutput,
    });
  } else {
    await notifyRedirectCompletion({
      kind: "completed_no_request",
      turnContextId,
      humanTurnId,
      sourceAgentId,
    });
  }
}

/**
 * D421 Phase 4.2 — notify the completion hook of a non-success terminal
 * (error / abort) so the server can clean its pending redirect context. The
 * recorded request is NOT consumed (an errored/aborted source does not
 * enqueue a target); it is dropped with the turn-context cleanup.
 */
async function finalizeSourceRedirectOnTerminal(
  kind: "error" | "aborted",
  turnContextId: string,
  humanTurnId: string,
  sourceAgentId: string,
): Promise<void> {
  if (!turnContextId.trim() || !humanTurnId.trim() || !sourceAgentId.trim()) return;
  await notifyRedirectCompletion({
    kind,
    turnContextId,
    humanTurnId,
    sourceAgentId,
  });
}

function messageTokensEventHasVisibleContent(event: ServerEvent): boolean {
  return event.type === "message.tokens"
    && "content" in event
    && typeof event.content === "string"
    && event.content.length > 0;
}

/**
 * LangGraph executor for the Job class. Replaces echo/slow-task stubs.
 * Wraps graph.streamEvents and yields ServerEvents through the event bus.
 */
export async function* langgraphExecutor(
  input: Record<string, unknown>,
  _jobId: string,
  laneKey: string | null,
  signal: AbortSignal,
  protectedServices?: ProtectedConversationExecutionServices,
  protectedTurn?: ProtectedConversationExecutorTurnScope,
): AsyncGenerator<ServerEvent> {
  if ((protectedServices === undefined) !== (protectedTurn === undefined)) {
    throw new TypeError(
      "Protected conversation services and authorized turn scope must be supplied together",
    );
  }
  const ownerId = typeof input["ownerId"] === "string" ? input["ownerId"] : "";
  const transcriptOwnerId =
    typeof input["transcriptOwnerId"] === "string" && input["transcriptOwnerId"]
      ? input["transcriptOwnerId"]
      : ownerId;
  const message = typeof input["message"] === "string" ? input["message"] : "";
  const attachmentTextBlocks = parseStringArray(input["attachmentTextBlocks"]);
  const multimodalImages = parseMultimodalImagesFromJobInput(input["multimodalImages"]);
  // D391 — retained attachment ids to link to this turn's human row (stamped in
  // persistMessages once the human fingerprint is known).
  const retainedAttachmentIds = parseStringArray(input["retainedAttachmentIds"]);
  const threadId = typeof input["threadId"] === "string" ? input["threadId"] : (laneKey ?? "default");
  const effectiveLaneKey = laneKey ?? "app:default";
  const memoryAccessEnvelope = (input["memoryAccessEnvelope"] as MemoryAccessEnvelope | undefined) ?? null;
  const actorRole = typeof input["actorRole"] === "string" ? input["actorRole"] : "owner";
  // M125 Phase 2.6: agentId flows through every turn. The caller (chat
  // route) populates it from the envelope, which got it from
  // resolveContext. Background jobs / older callers that don't thread
  // it explicitly must now also stamp it — fail loudly here rather
  // than silently borrowing the bootstrap default (which routed every
  // anonymous job to the first claimer's agent).
  const agentIdFromInput =
    typeof input["agentId"] === "string" && input["agentId"]
      ? input["agentId"]
      : "";
  const agentId =
    agentIdFromInput || memoryAccessEnvelope?.agentId || "";
  if (!agentId) {
    throw new Error(
      "langgraph-executor: agentId required (input.agentId or memoryAccessEnvelope.agentId)",
    );
  }

  // M042B: room routing identity (room:<uuid> laneKey separately is
  // captured above in effectiveLaneKey). roomId is carried into state
  // for pre_model / memory store. Defensive fallbacks for background
  // jobs and older test fixtures that don't thread room context.
  const roomId =
    (typeof input["roomId"] === "string" && input["roomId"])
      ? input["roomId"]
      : memoryAccessEnvelope?.roomId ?? "";
  // D426 — the server supplies the canonical child Room id on Subthread
  // wakes. Keep it separate from `roomId` so plain room turns cannot
  // accidentally participate in a parent root summary.
  const subthreadRoomId =
    typeof input["subthreadRoomId"] === "string" && input["subthreadRoomId"]
      ? input["subthreadRoomId"]
      : "";
  const roomRoster: RoomParticipant[] = Array.isArray(input["roomRoster"])
    ? (input["roomRoster"] as RoomParticipant[])
    : [];

  // D082 PR B — populate turnId on graph state so the checkpoint
  // carries it across HTTP-request boundaries. Resume handlers
  // (`/api/auth/approval-reply`, `/api/auth/identity-challenge`,
  // `/api/auth/prove-and-resume`) read it back via graph.getState
  // and re-bind via `runWithTurn(state.turnId, ...)`, so the
  // whole multi-request turn grep-correlates on a single id.
  // Empty default = legacy/background callers that didn't thread
  // one in; logger's ALS prefix degrades to no-prefix cleanly.
  const turnId = typeof input["turnId"] === "string" ? input["turnId"] : "";
  const causalHumanUserId =
    typeof input["causalHumanUserId"] === "string" && input["causalHumanUserId"]
      ? input["causalHumanUserId"]
      : null;
  const mentionedHumanUserIds = parseStringArray(input["mentionedHumanUserIds"]);

  // D421 Phase 4.2 — per-agent execution context isolation. Group multi-wake
  // jobs share the human `turnId`; keying skip / redirect / visible-output /
  // depth state by it alone would let one bot's `skip` suppress another's
  // fallback. Derive a per-agent `turnContextId` from `humanTurnId + agentId`
  // and thread it explicitly through tool-factory and stream contexts so
  // every turn-context helper resolves to a per-bot slot. The human
  // transcript/event fingerprint stays the original `turnId`.
  const turnContextId =
    turnId && agentId ? turnContextKey(turnId, agentId) : turnId;
  // D421 Phase 4.3 — target depth is seeded only when the executor actually
  // starts. This avoids leaking a seeded context when a queued target is
  // cancelled before execution, while still preceding graph/model/tool work.
  if (input["redirectDepth"] === 1 && turnContextId) {
    seedAgentRedirectDepthByKey(turnContextId);
  }

  // D316/D574 — the Human directly addressed this Agent by mention, reply, or
  // UI choice. Carried onto graph state so pre_model/agent withhold `skip`,
  // inject the selection steering prompt, and retain foreground authority.
  const supervisionMetadata = connectedWebSupervisionMetadata(input);
  const explicitlySelected = supervisionMetadata === undefined && input["explicitlySelected"] === true;

  // D079 Phase 2 — two-path API. Paths came pre-validated from the
  // chat route (absolute-only, control-chars rejected, system-path
  // blocklist applied). `null` in the input means "client didn't
  // provide / no folder open" — we coerce to empty-string here so
  // the graph state's default matches and pre-model's block-omission
  // logic reads cleanly. Background jobs and legacy tests that don't
  // thread these fields get the same empty defaults.
  const currentFolder = typeof input["currentFolder"] === "string" ? input["currentFolder"] : "";
  const currentFolderRelayId = typeof input["currentFolderRelayId"] === "string" ? input["currentFolderRelayId"] : "";
  const workspacePath = typeof input["workspacePath"] === "string" ? input["workspacePath"] : "";
  const autoApprove = input["autoApprove"] === true;
  // D356/D423 — in-focus artifacts and their resolved manifest are
  // turn-scoped alongside mini-app context, so fresh graph input always carries
  // their normalized values, including empty arrays.
  const {
    activeMiniApp,
    liveMiniAppSession,
    artifactRefs,
    focusedResources,
  } = freshForegroundTurnScopedGraphContext(input);
  // M087 — time-awareness context resolved at chat ingress. `userTimezone`
  // is always a valid IANA name (server resolves request ?? stored ?? "UTC");
  // background/legacy callers that omit it get the "UTC" default. The reducer
  // default for `previousUserMessageAt` is null (first-message fallback).
  const userTimezone =
    typeof input["userTimezone"] === "string" && input["userTimezone"].length > 0
      ? input["userTimezone"]
      : "UTC";
  const previousUserMessageAt =
    typeof input["previousUserMessageAt"] === "string" ? input["previousUserMessageAt"] : null;
  const securityAuditIp = typeof input["securityAuditIp"] === "string" ? input["securityAuditIp"] : "";
  const securityAuditUserAgent =
    typeof input["securityAuditUserAgent"] === "string" ? input["securityAuditUserAgent"] : "";
  const securityAuditClientMeta =
    securityAuditIp.length > 0
      ? {
          ip: securityAuditIp,
          ...(securityAuditUserAgent.length > 0
            ? { userAgent: securityAuditUserAgent }
            : {}),
        }
      : null;
  const verifiedOrdinaryOrigin = parseVerifiedOrdinaryOrigin(
    input["verifiedOrdinaryOrigin"],
  );

  const replyToRaw = input["replyToMessageId"];
  const replyToMessageId =
    typeof replyToRaw === "number" && Number.isInteger(replyToRaw) && replyToRaw > 0
      ? replyToRaw
      : undefined;

  const hasPayload =
    message.trim().length > 0 ||
    attachmentTextBlocks.some((s) => s.trim().length > 0) ||
    multimodalImages.length > 0;

  if (!hasPayload) {
    throw new Error("Empty message");
  }

  const policyResolver = getPolicyResolver();
  // Stack 208 P0 — one shared graph execution policy seam. The recursion ceiling
  // is resolved here (100 in P0) and threaded into `streamConfig` below; no
  // call site hardcodes `100`. `GraphExecutionMetrics` counts supersteps /
  // model invocations / tool calls from the existing `streamEvents` hook and
  // is logged at stream end / on error (telemetry-only, no persistence).
  const executionPolicy = resolveGraphExecutionPolicy(input);
  const metrics = new GraphExecutionMetrics();
  // D418 task 3.2.5 — thread the Full Workstation approval override
  // resolver (if `app.ts` installed one on `defaultPostModelDeps`) into the
  // graph. A per-turn shallow copy keeps the graph's deps snapshot stable
  // for the turn even if the server-wide singleton is later replaced; the
  // resolver reference itself is shared. When no resolver was installed the
  // field is `undefined` and post-model Pass 2 behavior is unchanged.
  const liveShadowContext = getCurrentLiveShadowTurnContext();
  await prepareForegroundEncryptedContext(() =>
    enforceLiveShadowForegroundHistoryBoundary({
      roomId,
      protectedTurnAvailable: protectedTurn !== undefined
        || liveShadowContext?.session?.protectForegroundHistory !== undefined,
    }),
    liveShadowContext?.session?.authorizationDeadlineAt,
  );
  const liveShadowRuntime = liveShadowContext?.session === null
    || liveShadowContext?.session === undefined
    ? undefined
    : createLiveShadowAgentRuntimeTurn(
      liveShadowContext.session,
      liveShadowContext.enforcementPolicy,
      liveShadowContext.observeBoundary,
      liveShadowContext.dataOperationPolicy,
    );
  const protectedMemoryDeps =
    await resolveForegroundProtectedMemoryGraphDeps({
      envelope: memoryAccessEnvelope,
      session: liveShadowContext?.session,
      policy: liveShadowContext?.enforcementPolicy,
      normalForeground: protectedTurn === undefined,
    });
  const postModelDeps: NautiloGraphDeps = {
    ...defaultPostModelDeps,
    recallRecordsPortForState: (state) => {
      const ordinary = foregroundRecordRecallPortForState(state);
      return ordinary === undefined
        ? undefined
        : protectLiveShadowForegroundRecordRecall(ordinary);
    },
    ...(liveShadowRuntime === undefined
      ? {}
      : {
        liveShadowToolBoundaryForState: () =>
          liveShadowRuntime.toolBoundary,
      }),
    ...protectedMemoryDeps,
  };
  const foregroundActivationState = freshForegroundActivationState(input);
  if (liveShadowRuntime !== undefined) {
    foregroundActivationState.suppressToolLifecycleEvents = true;
  }
  const trustedExecutionEntrypoint = foregroundActivationState.trustedExecutionEntrypoint;
  const taskReportBackContinuation = parseTaskReportBackContinuation(
    input["taskReportBackContinuation"],
  );
  const desktopAutomationAdmission = await admitFreshComputerUseRoot({
    userId: ownerId,
    actorId: memoryAccessEnvelope?.actorId ?? ownerId,
    causalHumanUserId: causalHumanUserId ?? "",
    agentId,
    trustedExecutionEntrypoint,
    verifiedOrdinaryOrigin,
  }, {
    resolveGrant: postModelDeps.resolveComputerUseRootGrant,
  });
  const isGuest = actorRole === "guest";
  // M132/M156 — Profile is 1:1 with Agent. `ownerId` in room turns is the
  // authorization / transcript owner and can differ from the speaking agent's
  // owner (e.g. a foreign-owned agent in a shared room). Agent identity
  // fields like soul/name/model must therefore resolve by `agentId`.
  const authoredContext = await loadForegroundAuthoredContext({
    agentId,
    ownerId,
    isGuest,
  }, {
    getExecutionConfigByAgentId: getAgentExecutionConfigById,
    resolveEnabledBodies,
  });
  const profile = authoredContext.profile;
  const soulFile = authoredContext.soulFile;
  const skills = authoredContext.skills;
  const displayNameFromAgent =
    !isGuest && agentId ? await getAgentDisplayNameById(agentId).catch(() => null) : null;
  const assistantName = displayNameFromAgent ?? profile?.name ?? "Nautilo";
  const briefNamespaces = envelopeReadableNamespaces(memoryAccessEnvelope);
  const selectMemoryBrief = () => selectPromptBriefMemories(
    briefNamespaces,
    agentId || undefined,
    ownerId || undefined,
  );
  let protectedMemoryBriefOverflowIds: readonly string[] = [];
  const stageProtectedMemoryBrief = async () => {
    const staged = await stageProtectedPromptMemoryBrief({
      ...(signal === undefined ? {} : { signal }),
      loadPage: (cursor) => stagePromptBriefMemoryStructuralPage(
        briefNamespaces, cursor, agentId || undefined, ownerId || undefined,
      ),
      openPage: (page) => protectLiveShadowForegroundMemories(
        () => Promise.resolve(page), signal,
        () => loadPromptBriefMemoryOrdinarySelections(
          briefNamespaces, page, agentId || undefined, ownerId || undefined,
        ),
      ),
    });
    protectedMemoryBriefOverflowIds = staged.overflowIds;
    return staged.memories;
  };
  const memoryBriefItems = (
    protectedTurn === undefined
    && !isGuest
    && briefNamespaces.length > 0
  )
    ? liveShadowContext?.session != null
        && liveShadowContext.enforcementPolicy?.mode !== "plaintext_only"
      ? await prepareForegroundEncryptedContext(
        stageProtectedMemoryBrief,
        liveShadowContext.session.authorizationDeadlineAt,
      )
      : await selectMemoryBrief().catch(() => [])
    : [];
  const memoryBrief = memoryBriefItems
    .map((memory) => `- [${memory.type}] ${memory.content}`)
    .join("\n");
  // D371 R2 — per-turn model override (decision A: per-thread). Explicit
  // Room/Agent state is never silently replaced if it becomes unavailable.
  const perTurnModelRaw = typeof input["model"] === "string" ? input["model"].trim() : "";
  const configuredModel = perTurnModelRaw || profile?.defaultModel || null;
  const foregroundModelControlSnapshot = await loadForegroundModelControlSnapshot(
    roomId, agentId, perTurnModelRaw || null,
  );
  const foregroundModelPlan = foregroundModelControlPlanFromSnapshot(foregroundModelControlSnapshot, () =>
    configuredModel
      ? resolveModelRole("chat", { configuredId: configuredModel })
      : getDefaultModel().id,
  );
  const modelId = resolveModelRole("chat", { configuredId: foregroundModelPlan.initialModelId });
  if (perTurnModelRaw) {
    log(`[nautilo/executor] per-turn model override applied: ${perTurnModelRaw}`);
  }

  const serverTimePrefixIso =
    typeof input["serverTimePrefixIso"] === "string" ? input["serverTimePrefixIso"] : undefined;
  // D302 P4 — "wake against an already-persisted human message". When true, the
  // human row already exists in the transcript (optimistic delivery / ask_user
  // pre-persist), so we still inject the message into the graph (the model must
  // respond to it) but SKIP the transcript persist + its message.new — avoiding
  // a duplicate human row without relying on read-time fingerprint collapse.
  const humanAlreadyPersisted = input["humanAlreadyPersisted"] === true;
  // Voice mode is a per-request client decision, not a server-wide setting.
  // The client sends voiceMode:true in the POST body only when its local UI
  // toggle is on. Server-side TTS additionally requires ELEVENLABS_API_KEY
  // in the environment (loaded from ~/.nautilo/instance.env). D021.
  const clientVoiceMode = input["voiceMode"] === true;
  const hasElevenLabsKey = !!process.env["ELEVENLABS_API_KEY"]?.trim();
  const voiceEnabled = clientVoiceMode && hasElevenLabsKey;
  if (voiceEnabled) log(`[nautilo/executor] Voice mode ENABLED (client requested, API key present)`);
  else if (clientVoiceMode) log(`[nautilo/executor] Voice mode requested but ELEVENLABS_API_KEY not set`);
  else log(`[nautilo/executor] Voice mode disabled`);

  const langgraphThreadId = threadId;

  // M166 Phase B — explicit turn-kind signal. The foreground executor is always
  // a FRESH turn (resume replies flow through the dedicated resumeGraphWith*
  // handlers, not here).
  const turnKind: TurnKind = classifyTurnKind({});
  log(`[nautilo/executor] turnKind=${turnKind}`);

  // M168 — rebuild the conversation HISTORY from the DB transcript (single
  // source of truth) on FRESH room turns. The `messages` channel reducer is
  // overwrite (`(_, update) => update`), so this replaces — not appends to —
  // prior state. M171 (Phase H) removed the old checkpoint-history read path;
  // the checkpoint is STILL written by the graph below (it holds in-flight
  // execution state for resume), it is just no longer read for history.
  // R5 — group/subthread wakes fire against an already-persisted human row;
  // `currentMessageId` excludes it so the triggering message isn't duplicated.
  const subthreadParentRoomId =
    typeof input["subthreadParentRoomId"] === "string" ? input["subthreadParentRoomId"] : "";
  const subthreadAnchorMessageId =
    typeof input["subthreadAnchorMessageId"] === "number"
      ? input["subthreadAnchorMessageId"]
      : undefined;
  const currentMessageId =
    typeof input["currentMessageId"] === "number" ? input["currentMessageId"] : undefined;

  // M171 R2 — a foreground turn without a `roomId` is a stateless single-shot
  // (empty history). If it nonetheless LOOKS like a room turn — a populated
  // roster or a `room:`-shaped thread id — the `roomId` was dropped upstream;
  // surface it as a warn so the gap is observable rather than a silent `[]`.
  if (!roomId && (roomRoster.length > 0 || langgraphThreadId.startsWith("room:"))) {
    warn(
      `[nautilo/executor] room-shaped foreground turn reached the executor without a roomId ` +
        `(threadId=${langgraphThreadId}, rosterSize=${roomRoster.length}); history will be empty`,
    );
  }

  const resolvedInitialRecordContext = roomId && freshForegroundRecordContextEligible(input)
    ? foregroundRecordContextPortForRoom(roomId)
    : undefined;
  const initialRecordContext = resolvedInitialRecordContext === undefined
    ? undefined
    : protectedTurn === undefined
      ? protectLiveShadowForegroundRecordContext(resolvedInitialRecordContext)
      : resolvedInitialRecordContext.representation === "protected"
        ? resolvedInitialRecordContext
        : undefined;
  const historyMessages = protectedTurn === undefined
    ? await prepareForegroundEncryptedContext(
      () => resolveForegroundHistoryMessages({
        turnKind,
        roomId,
        transcriptOwnerId,
        agentId,
        modelId,
        currentHumanText: message,
        ...(initialRecordContext === undefined
          ? {}
          : { recordContext: initialRecordContext }),
        signal,
        ...(subthreadParentRoomId ? { subthreadParentRoomId } : {}),
        ...(subthreadAnchorMessageId != null ? { subthreadAnchorMessageId } : {}),
        ...(currentMessageId != null ? { currentMessageId } : {}),
      }),
      liveShadowContext?.session?.authorizationDeadlineAt,
    )
    : await buildProtectedRoomHybridContext({
        hits: protectedTurn.history,
        journal: protectedTurn.journal ?? { rollup: null, events: [] },
        currentHumanText: message,
        ...(initialRecordContext === undefined
          ? {}
          : { recordContext: initialRecordContext }),
        modelId,
        signal,
      });

  // A later Message/Journal/Record authority wait restarts this executor.
  // Commit the existing brief-overflow lifecycle only after every selected
  // pre-model context family has verified, so retries remain read-only.
  if (protectedMemoryBriefOverflowIds.length > 0) {
    await commitPromptBriefMemoryOverflow(
      protectedMemoryBriefOverflowIds,
      agentId || undefined,
      ownerId || undefined,
    );
  }

  // Context repair must finish before any model is invoked. Image summaries
  // use the model too, so they deliberately run after Message, Journal,
  // Reflection, and Memory context has passed the Strict gate above.
  const visionSummaryBlocks = await maybeSummarizeImagesWithVisionFallback({
    mainModelId: modelId,
    images: multimodalImages,
    signal,
  });
  const suppressImageDropNote = visionSummaryBlocks.length > 0;
  const mergedAttachmentTextBlocks = [
    ...visionSummaryBlocks,
    ...attachmentTextBlocks,
  ];
  const userMessageArgs = {
    userText: message,
    attachmentTextBlocks: mergedAttachmentTextBlocks,
    multimodalImages,
    modelId,
    suppressImageDropNote,
    replyToMessageId,
  };
  // M135 P6 — the server-time prefix is for the LLM's time grounding, so it
  // belongs ONLY in the checkpoint (what the model sees). The persisted
  // transcript (`session_messages`, shown in the UI) must stay clean — hence
  // a separate un-prefixed copy below. When no prefix is set (group rooms /
  // guests) both are the same object, so behavior is byte-for-byte unchanged.
  const userMessage = buildForegroundUserHumanMessage({
    ...userMessageArgs,
    serverTimePrefixIso,
  });
  const userMessageForTranscript = serverTimePrefixIso
    ? buildForegroundUserHumanMessage(userMessageArgs)
    : userMessage;

  // M168 R6 — the full transcript subsumes the old transient peer-diff /
  // subthread context block (deleted in M171); only the live turn message is
  // appended to the rebuilt history.
  const newTurnMessages: BaseMessage[] = [userMessage];

  const { suppressToolLifecycleEvents } = foregroundActivationState;

  const graphInput = {
    noProgressStreaks: new Map(),
    noProgressPendingCorrection: null,
    noProgressPendingStop: null,
    // eslint-disable-next-line nautilo-msg/no-naked-message-concat -- historyMessages is the transcript narration (0..1 HumanMessage, no ToolMessages); newTurnMessages is just the live user message — no tool_call_id invariant to preserve.
    messages: [...historyMessages, ...newTurnMessages],
    userId: ownerId,
    personaId: "owner",
    assistantName,
    soulFile,
    skills,
    memoryBrief,
    memoryDelta: "",
    voiceMode: voiceEnabled,
    source: "api",
    model: modelId,
    foregroundModelControlSnapshot,
    currentThreadId: langgraphThreadId,
    langgraphThreadId,
    approvalLaneKey: effectiveLaneKey,
    // D447 / ISSUE-M217 — each foreground user/task input begins a fresh
    // foreground epoch. Fresh foreground and task report-back turns reuse the
    // room-bot checkpoint, while tools/pre-model loops and approval resumes
    // omit these inputs. The agent owns bounded activation-lease aging from
    // that epoch; ingress must only reset M217's stale nested/background
    // lifecycle state so it cannot affect foreground classification or behavior.
    ...foregroundActivationState,
    taskReportBackContinuation,
    memoryAccessEnvelope,
    actorRole,
    autoApprove,
    agentId,
    relayCapabilities: buildRuntimeCapabilityTokens(
      getRelayRegistry(),
      ownerId,
      trustedExecutionEntrypoint === "foreground.main" && desktopAutomationAdmission !== null
        ? agentId
        : undefined,
    ),
    verifiedOrdinaryOrigin,
    desktopAutomationProvenance: desktopAutomationAdmission?.provenance ?? null,
    desktopAutomationRouteBinding: desktopAutomationAdmission?.routeBinding ?? null,
    computerUseInvocationBindings: {},
    // M042B: room context on graph state. roomId + roomRoster are
    // read by pre_model for the "Room participants" prompt block.
    // For the seeded default room, langgraphThreadId above equals
    // graphThreadId ("app:default"), not the laneKey ("room:<uuid>").
    roomId,
    roomRoster,
    turnId,
    causalHumanUserId: causalHumanUserId ?? "",
    explicitlySelected,
    // D421 Phase 4.2 — server-owned redirect authority (Requirement B). `true`
    // ONLY for a single inferred wake; the tool-factory gate fails closed on
    // missing/`false`. Default `false` keeps legacy / background / DM callers
    // and pre-Phase-4.2 checkpoints inert.
    redirectAllowed: input["redirectAllowed"] === true,
    // D079 Phase 2 — two-path context into agent state. Read by
    // pre-model's `buildTwoPathBlock` to inject the file-surfaces
    // block into the system prompt. Persists in the checkpoint so
    // resume paths see the same paths (matches turnId pattern,
    // H-023).
    currentFolder,
    currentFolderRelayId,
    workspacePath,
    activeMiniApp,
    liveMiniAppSession,
    artifactRefs,
    focusedResources,
    // M087 — time-awareness context. Read by pre-model's `## Current time`
    // block and the `get_current_time` tool. Checkpointed like turnId so
    // resume paths see a stable value (H-023).
    userTimezone,
    previousUserMessageAt,
    securityAuditClientMeta,
    // A foreground turn never inherits the hard tool ceiling of an earlier
    // background/subagent execution sharing a checkpoint. Task report-back is
    // a fresh foreground continuation whose tools are recomputed from current
    // policy, Relay liveness, and its validated return binding.
    toolWhitelist: undefined,
  };

  const tokenBatcher = new TokenBatcher({
    laneKey: effectiveLaneKey,
    authorAgentId: agentId,
    ...(turnId ? { turnId } : {}),
  });
  const voiceSubjectId = memoryAccessEnvelope?.ownerId ?? ownerId;
  const sentenceDetectorConfig: SentenceDetectorConfig = {};
  if (voiceSubjectId) {
    sentenceDetectorConfig.userId = voiceSubjectId;
  }
  if (agentId) {
    sentenceDetectorConfig.agentId = agentId;
  }
  if (roomId) {
    sentenceDetectorConfig.roomId = roomId;
  }
  const sentenceDetector = voiceEnabled ? new SentenceDetector(sentenceDetectorConfig) : null;
  const toolTracker = new ToolCallTracker(agentId || undefined, turnId || undefined);
  const streamCtx: StreamProcessorContext = {
    jobId: _jobId,
    quietSupervision: supervisionMetadata !== undefined,
    publishProjectionPreflightLifecycle:
      shouldPublishProjectionPreflightLifecycle({
        hasLiveShadowRuntime: liveShadowRuntime !== undefined,
        hasProtectedTurn: protectedTurn !== undefined,
        suppressToolLifecycleEvents,
        quietSupervision: supervisionMetadata !== undefined,
      }),
    ...(turnId ? { turnId } : {}),
    ...(turnContextId ? { turnContextId } : {}),
    ...(liveShadowRuntime === undefined ? {} : { liveShadowRuntime }),
    laneKey: effectiveLaneKey,
  };
  const liveShadowStreamState = Object.freeze({
    ordinals: new Map<string, number>(),
  });
  const savedFingerprints = new Set<string>();

  const persistOptsBase = {
    ...(supervisionMetadata === undefined
      ? await memoryReviewAdmission(memoryAccessEnvelope, langgraphThreadId, {
          threadId: langgraphThreadId, transcriptOwnerId, turnId, input,
        })
      : {}),
    agentId,
    roomId,
    ...(subthreadRoomId ? { subthreadRoomId } : {}),
    laneKey: effectiveLaneKey,
    eventBus,
    ...(supervisionMetadata ? { internalToolMetadata: supervisionMetadata } : {}),
    ...(turnId ? { humanTurnId: turnId } : {}),
    trustedExecutionEntrypoint: foregroundActivationState.trustedExecutionEntrypoint,
    notificationContext: {
      mentionedHumanUserIds: [],
      causalHumanUserId,
      causalHumanTurnId: causalHumanUserId ? turnId || null : null,
    },
  };
  // D424 — preserve the user-sent workspace artifact focus lane through the
  // async executor path. `persistMessages` resolves these external ids against
  // the canonical room namespace before recording durable card relations; local
  // file focus refs are deliberately excluded.
  const messageArtifactExternalIds = Array.from(
    new Set([
      ...artifactRefs.map((ref) => ref.artifactId),
      ...focusedResources.flatMap((resource) => {
        if (resource.kind !== "workspace-artifact") return [];
        const locator = resource.locator;
        if (
          locator &&
          typeof locator === "object" &&
          typeof (locator as { artifactId?: unknown }).artifactId === "string"
        ) {
          return [(locator as { artifactId: string }).artifactId];
        }
        return [];
      }),
    ]),
  );

  // M143/D568 — internal wakes retain an audit input without publishing a fake
  // Human message. Never apply the input metadata to an entire output batch:
  // browser supervision uses internalToolMetadata for tool plumbing only, while
  // a deliberate tool-free answer stays visible. Task report-back is unchanged.
  const inputMetadata =
    input["metadata"] && typeof input["metadata"] === "object"
      ? (input["metadata"] as Record<string, unknown>)
      : undefined;
  const isTaskOriginated = inputMetadata?.["originatedBy"] === "task";
  const isAdvancedVideoWorkcard = inputMetadata?.["originatedBy"] === "advanced_video_workcard";

  // D302 P4 — skip persisting the human row when it already exists (the bot is
  // waking against an already-delivered message). The model still sees it via
  // `graphInput.messages`; only the duplicate transcript row + event are avoided.
  if (protectedTurn !== undefined && !humanAlreadyPersisted) {
    throw new TypeError(
      "Protected Human input must be coordinate-first persisted before Agent execution",
    );
  }
  if (!humanAlreadyPersisted && protectedTurn === undefined) {
    // D391 — stamp turn_id on this turn's retained attachments when the human
    // row is persisted (only on the human persist call, which carries the ids).
    const humanPersistOpts = {
      ...persistOptsBase,
      notificationContext: {
        mentionedHumanUserIds,
        causalHumanUserId: null,
        causalHumanTurnId: null,
      },
      ...(retainedAttachmentIds.length > 0 ? { retainedAttachmentIds } : {}),
      ...(messageArtifactExternalIds.length > 0
        ? { messageArtifactExternalIds }
        : {}),
    };
    await persistMessages(
      langgraphThreadId,
      transcriptOwnerId,
      [userMessageForTranscript],
      savedFingerprints,
      isTaskOriginated || supervisionMetadata !== undefined
        ? { ...humanPersistOpts, metadata: supervisionMetadata ?? inputMetadata!, suppressUserMessageEvents: true }
        : isAdvancedVideoWorkcard
          ? { ...humanPersistOpts, metadata: inputMetadata }
          : humanPersistOpts,
    );
  }

  const protectedCheckpointSaver = protectedServices === undefined
    ? null
    : checkpointSaverForConversationExecution(
      protectedServices,
      {
        logicalThreadId: threadId,
        kind: "foreground.main",
        authorization: protectedServices.authorization,
      },
    );
  const encryptedLiveShadowCheckpointRequired =
    requiresEncryptedForegroundCheckpoint(
      liveShadowContext?.enforcementPolicy,
    );
  if (
    protectedCheckpointSaver === null
    && encryptedLiveShadowCheckpointRequired
    && liveShadowContext?.session?.checkpoint === undefined
  ) {
    throw new StrictShadowEnforcementError({
      boundaryId: "conversation.write.foreground_checkpoint",
      family: "checkpoint",
      operation: "write",
      actorClass: "agent",
      state: "unsupported",
      reason: "unsupported_operation",
      retryable: false,
      policyRevision: liveShadowContext?.enforcementPolicy?.revision ?? 0,
    });
  }
  const liveShadowCheckpointSaver =
    protectedCheckpointSaver === null
      && encryptedLiveShadowCheckpointRequired
      && liveShadowContext?.session?.checkpoint !== undefined
      ? createLiveShadowCheckpointSaver({
          logicalThreadId: threadId,
          checkpoint: liveShadowContext.session.checkpoint,
        })
      : null;
  if (liveShadowCheckpointSaver !== null) {
    // A fresh turn rebuilds its state from product storage. Removing the prior
    // encrypted graph state also guarantees this invocation needs only the
    // current Namespace generation supplied by the entity gateway.
    try {
      await liveShadowCheckpointSaver.deleteThread(threadId);
    } catch (error) {
      await disposeProtectedCheckpointSaver({
        saver: liveShadowCheckpointSaver,
        primaryErrorPresent: true,
      });
      throw error;
    }
  }
  const encryptedCheckpointSaver = protectedCheckpointSaver
    ?? liveShadowCheckpointSaver;
  const checkpointSaver = encryptedCheckpointSaver
    ?? checkpointSaverForConversationExecution(undefined);
  let checkpointPrimaryError = false;
  let graph: ReturnType<typeof createNautiloGraph>;
  try {
    graph = createNautiloGraph(
      checkpointSaver,
      policyResolver,
      postModelDeps,
    );
  } catch (error) {
    if (encryptedCheckpointSaver !== null) {
      await disposeProtectedCheckpointSaver({
        saver: encryptedCheckpointSaver,
        primaryErrorPresent: true,
      });
    }
    throw error;
  }

  const streamConfig: Record<string, unknown> = {
    configurable: { thread_id: langgraphThreadId },
    signal,
    recursionLimit: executionPolicy.recursionLimit,
    version: "v2",
  };

  log(`[nautilo/executor] Starting stream for thread ${langgraphThreadId}`);

  const agentProgressHeartbeat =
    turnId && !suppressToolLifecycleEvents
      ? new AgentProgressHeartbeat({
          laneKey: effectiveLaneKey,
          turnId,
          authorAgentId: agentId || undefined,
          emit: (event) => {
            eventBus.emit(event);
          },
        })
      : null;
  agentProgressHeartbeat?.start();

  // D421 Phase 4.2 — per-agent turnContextId (`turnContextKey(humanTurnId,
  // agentId)`) is threaded explicitly (not via ALS): the skip / redirect tools
  // compute it from their factory context, the stream processor reads it from
  // `streamCtx.turnContextId`, and chat-model-invocation computes it from the
  // logger ALS `getCurrentTurnId()` + its `agentId` param. Two bots sharing
  // one human `turnId` therefore never collide on skip / redirect /
  // visible-output / depth state. The bare-`turnId` fallback paths below cover
  // legacy callers / background jobs where no `agentId` is bound.

  let memoryReviewRecorded = supervisionMetadata !== undefined;
  try {
    const eventStream = graph.streamEvents(graphInput, streamConfig);

    for await (const ev of eventStream) {
      if (signal.aborted) {
        if (!memoryReviewRecorded) {
          await finishMemoryReviewTurn({ threadId: langgraphThreadId, agentId, turnId, state: "interrupted" });
          memoryReviewRecorded = true;
        }
        await finalizeSourceRedirectOnTerminal(
          "aborted",
          turnContextId,
          turnId,
          agentId,
        );
        return;
      }

      metrics.noteStreamEvent(ev);
      noteAgentProgressFromStreamEvent(ev, agentProgressHeartbeat);

      const { events, messagesToPersist, assistantMessageKey } = processStreamEvent(ev, tokenBatcher, toolTracker, streamCtx, sentenceDetector);
      for (const event of events) {
        if (liveShadowRuntime !== undefined) {
          const protectedStream = await protectLiveShadowAssistantToken({
            runtime: liveShadowRuntime,
            operationId: liveShadowContext!.operationId,
            laneKey: effectiveLaneKey,
            state: liveShadowStreamState,
            event,
            messagesToPersist,
          });
          for (const protectedEvent of protectedStream.events) {
            yield protectedEvent;
          }
          if (protectedStream.handled) continue;
        }
        if (messageTokensEventHasVisibleContent(event)) {
          markAssistantVisibleOutputForTurnByKey(streamCtx.turnContextId ?? turnId);
          agentProgressHeartbeat?.noteVisibleToken();
        }
        if (event.type === "message.tokens" && event.done) {
          agentProgressHeartbeat?.noteMessageDone();
        }
        yield event;
      }

      if (messagesToPersist.length > 0) {
        if (liveShadowRuntime !== undefined) {
          const protectedEvents = await publishLiveShadowRuntimeMessages({
            runtime: liveShadowRuntime,
            operationId: liveShadowContext!.operationId,
            laneKey: effectiveLaneKey,
            agentId,
            messages: messagesToPersist,
            warn,
            persistOrdinary: (ordinaryMessages) => persistMessages(
              langgraphThreadId,
              transcriptOwnerId,
              [...ordinaryMessages],
              savedFingerprints,
              {
                ...persistOptsBase,
                ...(assistantMessageKey ? { assistantMessageKey } : {}),
              },
            ),
          });
          for (const protectedEvent of protectedEvents) yield protectedEvent;
          continue;
        } else if (protectedTurn === undefined) {
          await persistMessages(
            langgraphThreadId,
            transcriptOwnerId,
            messagesToPersist,
            savedFingerprints,
            {
              ...persistOptsBase,
              ...(assistantMessageKey ? { assistantMessageKey } : {}),
            },
          );
        } else {
          await protectedTurn.persist(messagesToPersist);
        }
      }
    }

    tokenBatcher.completeMessage();
    for (const event of tokenBatcher.drain()) {
      yield event;
    }

    if (sentenceDetector) {
      sentenceDetector.complete();
      for (const event of sentenceDetector.drain()) {
        yield event;
      }
    }

    log(`[nautilo/executor] Stream complete thread=${langgraphThreadId} ${metrics.formatLogToken()}`);

    // Unknown checkpoint state remains incomplete, never reviewed as success.
    let memoryReviewState: "completed" | "awaiting" | "pending" = "pending";
    // Check for pending interrupts (identity challenge, prove_it, or D061 approval_ask)
    try {
      const postState = await graph.getState({ configurable: { thread_id: langgraphThreadId } });
      memoryReviewState = memoryReviewCompletionState(postState);
      const hasAnyPendingInterrupt = (
        (postState as Record<string, unknown> | undefined)?.["tasks"] as
          Array<Record<string, unknown>> | undefined
      )?.some((task) =>
        Array.isArray(task["interrupts"]) && task["interrupts"].length > 0
      ) ?? false;
      if (hasAnyPendingInterrupt) memoryReviewState = "awaiting";
      const events = collectPendingInterruptEvents(
        postState as { tasks?: Array<Record<string, unknown>>; values?: unknown } | undefined,
        langgraphThreadId,
        effectiveLaneKey,
      );
      for (const event of events) {
        log(`[nautilo/executor] ${event.type} interrupt detected`);
        yield event;
      }
    } catch (e) {
      log(`[nautilo/executor] Error checking interrupt state: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!memoryReviewRecorded) {
      await finishMemoryReviewTurn({ threadId: langgraphThreadId, agentId, turnId, state: memoryReviewState });
      memoryReviewRecorded = true;
    }

    // D421 Phase 4.2 — consume the recorded redirect request exactly once on
    // the SUCCESS path and notify the runtime-internal completion hook BEFORE
    // turn-context cleanup. No-op when no request was recorded; the hook is
    // still notified with `completed_no_request` so the server can clean its
    // pending context. Awaiting here sequences the consumer safely ahead of
    // the source cleanup so source cleanup cannot race target seeding.
    await finalizeSourceRedirectOnSuccess(turnContextId, turnId, agentId);

    // D128 — release the per-turn agent context (skipFlag, etc.) so the
    // next turn on this thread starts clean. No-op when turnId is empty.
    if (turnContextId) clearAgentTurnContextByKey(turnContextId);
    else if (turnId) clearAgentTurnContext(turnId);
  } catch (error) {
    if (!memoryReviewRecorded) {
      await finishMemoryReviewTurn({ threadId: langgraphThreadId, agentId, turnId, state: "interrupted" });
      memoryReviewRecorded = true;
    }
    if (signal.aborted) {
      // D421 Phase 4.2 — aborted source: do NOT consume the redirect request
      // (an aborted source does not enqueue a target); notify the hook so the
      // server can clean its pending context, then drop the turn context.
      await finalizeSourceRedirectOnTerminal("aborted", turnContextId, turnId, agentId);
      if (turnContextId) clearAgentTurnContextByKey(turnContextId);
      else if (turnId) clearAgentTurnContext(turnId);
      return;
    }
    checkpointPrimaryError = true;

    // Stack 208 P0 — surface the typed internal graph-budget outcome distinctly
    // in telemetry (R9). The user-safe sentence is produced by
    // `toFriendlyError` at the runtime job-loop catch site; here we only log
    // the outcome + metrics so `rg "graph_budget_exceeded" server.log`
    // bridges to the specific failure. Raw framework detail stays in logs.
    const budgetOutcome = toGraphBudgetOutcome(error, executionPolicy.recursionLimit);
    if (budgetOutcome) {
      log(
        `[nautilo/executor] Graph budget exceeded thread=${langgraphThreadId} ` +
          `outcome=${budgetOutcome.kind} recursionLimit=${budgetOutcome.recursionLimit} ${metrics.formatLogToken()}`,
      );
    } else {
      log(
        `[nautilo/executor] Stream error thread=${langgraphThreadId} ${metrics.formatLogToken()}`,
      );
    }

    const errorSkipSuppressed = fallbackSuppressedForTurn(turnId);
    tokenBatcher.completeMessage();
    const drained = tokenBatcher.drain();
    if (!errorSkipSuppressed) {
      for (const event of drained) yield event;
    }

    if (sentenceDetector) {
      sentenceDetector.complete();
      const sdrained = sentenceDetector.drain();
      if (!errorSkipSuppressed) {
        for (const event of sdrained) yield event;
      }
    }

    // D421 Phase 4.2 — errored source: do NOT consume the redirect request;
    // notify the hook so the server can clean its pending context.
    await finalizeSourceRedirectOnTerminal("error", turnContextId, turnId, agentId);
    if (turnContextId) clearAgentTurnContextByKey(turnContextId);
    else if (turnId) clearAgentTurnContext(turnId);
    throw error;
  } finally {
    agentProgressHeartbeat?.dispose();
    // D421 Phase 4.2 — belt-and-suspenders cleanup of the per-agent
    // turn-context slot. The success/error/abort paths already cleared it,
    // but a `return` from inside the try (e.g. abort) reaches here too, and a
    // lost-completion defense must not leave the slot leaking.
    if (turnContextId) {
      clearAgentTurnContextByKey(turnContextId);
    } else if (turnId) {
      clearAgentTurnContext(turnId);
    }
    if (encryptedCheckpointSaver !== null) {
      await disposeProtectedCheckpointSaver({
        saver: encryptedCheckpointSaver,
        primaryErrorPresent: checkpointPrimaryError,
      });
    }
  }
}

/**
 * M168/M171 — resolve a fresh foreground room turn's conversation HISTORY.
 *
 * On `turnKind === "fresh"` with a `roomId` (the always-true foreground case),
 * rebuilds history from the DB transcript via `buildTranscriptContext`:
 *  - DM / group → `{ kind:"room", roomId, ownerId, agentId?, excludeMessageId? }`
 *    (full labelled room transcript).
 *  - subthread → the same scope plus `subthread:{ parentRoomId, anchorMessageId }`
 *    (parent up-to-anchor window ++ subthread window).
 *
 * M171 (Phase H) removed the old `readCheckpointHistory` fallback: a non-fresh
 * or no-`roomId` foreground turn is now a stateless single-shot that returns
 * **`[]`** (the DB transcript is the single source of truth — there is no
 * checkpoint-history read left). The caller logs an R2 observability warn when a
 * room-shaped turn nonetheless arrives without a `roomId`.
 *
 * `depsOverride` is injected by unit tests; production constructs (and closes)
 * `defaultBuildTranscriptContextDeps()` per call. Exported for unit coverage.
 */
export async function resolveForegroundHistoryMessages(
  args: {
    turnKind: TurnKind;
    roomId: string;
    transcriptOwnerId: string;
    agentId: string;
    modelId?: string;
    currentHumanText?: string;
    recordContext?: import("@nautilo/reflection/foreground").ForegroundRecordContextPort;
    signal?: AbortSignal;
    subthreadParentRoomId?: string;
    subthreadAnchorMessageId?: number;
    currentMessageId?: number;
  },
  depsOverride?: BuildTranscriptContextDeps,
): Promise<BaseMessage[]> {
  if (args.turnKind !== "fresh" || !args.roomId) {
    return [];
  }
  const owned = depsOverride ? null : defaultBuildTranscriptContextDeps();
  const deps = depsOverride ?? owned;
  if (!deps) return [];
  const liveShadowContext = getCurrentLiveShadowTurnContext();
  const effectiveDeps: BuildTranscriptContextDeps =
    liveShadowContext?.session == null
      ? deps
      : {
        ...deps,
        readRoomTranscript: async (scope) =>
          protectLiveShadowForegroundHistory(
            await deps.readRoomTranscript(scope),
            args.signal,
          ),
        ...(deps.readRoomJournal === undefined
          ? {}
          : {
              readRoomJournal: (scope) =>
                protectLiveShadowForegroundJournal(
                  () => deps.readRoomJournal!(scope),
                  args.signal,
                ),
            }),
      };
  try {
    return await buildTranscriptContext(
      {
        ...(args.modelId ? { modelId: args.modelId } : {}),
        ...(args.currentHumanText === undefined
          ? {}
          : { currentHumanText: args.currentHumanText }),
        ...(args.recordContext === undefined
          ? {}
          : { recordContext: args.recordContext }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
        scope: {
          kind: "room",
          roomId: args.roomId,
          ownerId: args.transcriptOwnerId,
          ...(args.agentId ? { agentId: args.agentId } : {}),
          ...(args.currentMessageId != null ? { excludeMessageId: args.currentMessageId } : {}),
          ...(args.subthreadParentRoomId && args.subthreadAnchorMessageId != null
            ? {
                subthread: {
                  parentRoomId: args.subthreadParentRoomId,
                  anchorMessageId: args.subthreadAnchorMessageId,
                },
              }
            : {}),
        },
        // R4 — verbatim first cut (no recency window / summarization).
        maxLines: Number.MAX_SAFE_INTEGER,
      },
      effectiveDeps,
    );
  } finally {
    if (owned) await owned.close();
  }
}

// `interruptValueToServerEvent` lives in `@nautilo/agent` (D084 —
// packages/agent/src/graph/interrupt-mapping.ts). See the top-of-file
// import + re-export. This keeps the executor's stream-completion
// interrupt scan and the resume paths' chained-interrupt scan using
// the exact same mapping table.

interface ProcessResult {
  events: ServerEvent[];
  messagesToPersist: BaseMessage[];
  assistantMessageKey?: string;
}

export interface StreamProcessorContext {
  jobId?: string;
  /** Internal supervision publishes only a deliberate tool-free answer, not pre-tool narration. */
  quietSupervision?: boolean;
  /** Ordinary foreground-only projection rejection telemetry. Protected,
   * supervised, and other executor callers must leave this disabled. */
  publishProjectionPreflightLifecycle?: boolean;
  /** Track whether we're inside a final_report_generation node for deep research streaming */
  inFinalReportNode?: boolean;
  /**
   * D128 — current turnId, used to look up the agent turn context's
   * `skipFlag` (set by the `skip` tool) and suppress fallback
   * assistant-text emissions + persistence for the remainder of the
   * turn. Tool-message and tool-call AIMessage persistence is preserved
   * for graph integrity per D128 Decision 4 ("skip wins for fallback
   * only — explicit replies / tool plumbing still flow").
   */
  turnId?: string;
  /**
   * D421 Phase 4.2 — per-agent turnContextId
   * (`turnContextKey(humanTurnId, agentId)`). When present, the stream
   * processor resolves the per-bot slot for `skipFlag` suppression,
   * visible-output marking, and chat-model stream-activity stamping, so
   * two bots sharing one human `turnId` cannot collide. Falls back to
   * `turnId` when absent (legacy callers, background jobs).
   */
  turnContextId?: string;
  /** D563 — exact attempt metadata from Agent's actual `model.invoke`. */
  modelAttemptId?: string;
  /** D563 — Runtime owns classification-only usage high-water, not timers. */
  modelOutputTokensHighWaterMark?: number;
  laneKey?: string;
  liveShadowRuntime?: LiveShadowAgentRuntimeTurn;
}

/** @internal Exported for focused production-composition tests only. */
export function shouldPublishProjectionPreflightLifecycle(input: Readonly<{
  hasLiveShadowRuntime: boolean;
  hasProtectedTurn: boolean;
  suppressToolLifecycleEvents: boolean;
  quietSupervision: boolean;
}>): boolean {
  return !input.hasLiveShadowRuntime
    && !input.hasProtectedTurn
    && !input.suppressToolLifecycleEvents
    && !input.quietSupervision;
}

function projectionPreflightRejection(message: BaseMessage, ordinary = false): Readonly<{
  toolName: string;
  toolCallId: string;
  error: string;
  content: string;
}> | null {
  if (
    !ToolMessage.isInstance(message)
    || (ordinary ? !["share_memory", "share_artifact", "ask_peer"].includes(message.name ?? "") : message.name !== "share_memory")
    || message.status !== "error"
    || message.additional_kwargs["nautilo_tool_status"] !== "error"
    || typeof message.tool_call_id !== "string"
    || message.tool_call_id.length === 0
    || typeof message.content !== "string"
  ) return null;
  try {
    const parsed: unknown = JSON.parse(message.content);
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || (!ordinary && Object.keys(parsed).length !== 1)
      || !("error" in parsed)
      || typeof parsed.error !== "string"
      || parsed.error.length === 0
    ) return null;
    if (ordinary && (Object.keys(parsed).length !== 3 || parsed.error !== "content_access_preparation_failed"
      || !("recovery" in parsed) || parsed.recovery !== "prepare_new_call"
      || !("message" in parsed) || typeof parsed.message !== "string")) return null;
    return {
      toolName: message.name!,
      toolCallId: message.tool_call_id,
      error: ordinary && "message" in parsed ? String(parsed.message) : parsed.error,
      content: message.content,
    };
  } catch {
    return null;
  }
}

/**
 * D128 — checks whether the agent's `skip` tool has been called this turn.
 * Returns false when no `turnId` is bound (legacy callers, background jobs).
 */
function fallbackSuppressedForTurn(turnId: string | undefined): boolean {
  if (!turnId?.trim()) return false;
  return shouldSuppressFallbackEmission(postTurnFallbackContextForTurn(turnId));
}

/**
 * D421 Phase 4.2 — key-explicit variant for the per-agent slot. Returns false
 * when no key is bound (legacy callers, background jobs).
 */
function fallbackSuppressedForTurnByKey(key: string | undefined): boolean {
  const k = key?.trim();
  if (!k) return false;
  return shouldSuppressFallbackEmission(postTurnFallbackContextForTurnByKey(k));
}

/**
 * D128 — keep tool-call AIMessages + every ToolMessage, drop pure-text
 * AIMessages. The agent's `skip` tool ends the turn with no visible
 * assistant text; the graph state must still reflect the tool call that
 * was made.
 */
function filterMessagesForSkippedTurn(messages: BaseMessage[]): BaseMessage[] {
  return messages.filter((msg) => {
    if (!AIMessage.isInstance(msg)) return true;
    return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  });
}

export function processStreamEvent(
  ev: unknown,
  tokenBatcher: TokenBatcher,
  // D083 keeps ordinary executed-tool lifecycle in the custom tools node.
  // This tracker is used only for an opted-in projection-preflight rejection,
  // whose call never reaches that node and therefore has no existing pair.
  toolTracker: ToolCallTracker,
  ctx?: StreamProcessorContext,
  sentenceDetector?: SentenceDetector | null,
): ProcessResult {
  if (!ev || typeof ev !== "object") return { events: [], messagesToPersist: [] };

  const eventObj = ev as Record<string, unknown>;
  const event = typeof eventObj["event"] === "string" ? eventObj["event"] : "";
  const name = typeof eventObj["name"] === "string" ? eventObj["name"] : "";
  const data = eventObj["data"] as Record<string, unknown> | undefined;

  const events: ServerEvent[] = [];
  const messagesToPersist: BaseMessage[] = [];
  let assistantMessageKey: string | undefined;

  // Track deep research final_report_generation node for selective token streaming
  if (ctx && event === "on_chain_start" && name === "final_report_generation") {
    ctx.inFinalReportNode = true;
  }
  if (ctx && event === "on_chain_end" && name === "final_report_generation") {
    ctx.inFinalReportNode = false;
  }

  // Forward custom progress events from deep-research sub-graphs
  if (event === "on_custom_event" && name === "job.progress" && data && ctx?.jobId) {
    const phase = typeof data["phase"] === "string" ? data["phase"] : "Processing...";
    const detail = typeof data["detail"] === "string" ? data["detail"] : undefined;
    const progressEvent: ServerEvent = {
      type: "job.progress" as const,
      jobId: ctx.jobId,
      phase,
      detail,
    };
    events.push(progressEvent);
  }

  const skipSuppressed = fallbackSuppressedForTurnByKey(ctx?.turnContextId) || fallbackSuppressedForTurn(ctx?.turnId);

  if (event === "on_chat_model_start") {
    if (ctx) {
      const attemptId = modelAttemptIdFromStreamEvent(ev);
      if (attemptId) ctx.modelAttemptId = attemptId;
      else delete ctx.modelAttemptId;
      delete ctx.modelOutputTokensHighWaterMark;
    }
  } else if (event === "on_chat_model_stream") {
    const progress = classifyModelStreamProgress(ev, ctx?.modelOutputTokensHighWaterMark ?? 0);
    if (progress.outputTokens !== undefined && progress.outputTokens > (ctx?.modelOutputTokensHighWaterMark ?? 0) && ctx) {
      ctx.modelOutputTokensHighWaterMark = progress.outputTokens;
    }
    if (progress.meaningful) {
      reportModelAttemptProgressByKey(
        ctx?.turnContextId ?? ctx?.turnId,
        modelAttemptIdFromStreamEvent(ev) ?? ctx?.modelAttemptId,
      );
    }
    // D128 — once `skip` flipped the turn context flag, swallow every
    // subsequent fallback token. We don't even feed the batcher so its
    // chunk-sequence counter stays clean and no stale chunks can leak
    // through a later flush. Synchronous tool emits (future `reply`
    // tool) bypass this path entirely.
    if (skipSuppressed || ctx?.quietSupervision) {
      return { events: [], messagesToPersist: [] };
    }
    handleTokenStream(data, tokenBatcher, sentenceDetector, eventObj["metadata"]);
    for (const e of tokenBatcher.drain()) {
      events.push(e);
    }
    if (sentenceDetector) {
      for (const e of sentenceDetector.drain()) {
        events.push(e);
      }
    }
    //
    // D083 Phase 2b audit — LangChain's `on_tool_start` /
    // `on_tool_end` stream events used to be handled HERE (as
    // sibling `else if` branches of this function's dispatch),
    // emitting a SECOND tool.start / tool.end pair on top of the
    // custom `toolsNode`'s explicit emit (D082 PR A+). For
    // cloud-executor tools (any tool that runs via
    // `await tool.invoke(...)` inside
    // `packages/agent/src/nodes/tools.ts`) LangChain's tracing
    // fires on_tool_start / on_tool_end for the SAME invocation
    // the custom node just emitted for — causing every cloud tool
    // call to render as TWO cards in the inline ToolCard stream
    // (one with args + result, one "bare"). Relay tools didn't
    // double because `executeViaRelayRaw` bypasses `tool.invoke`.
    //
    // The custom emit is the authoritative source for both code
    // paths:
    //   - it sees the real `tc.args` before execution (richer
    //     than LangChain's tracing payload, which can reorder /
    //     rename)
    //   - it runs the post-security scan and passes
    //     `scanned.content` as the Phase 2 result (matches what
    //     the ToolMessage carries forward to the LLM)
    //   - it fires even when tools are rejected pre-execution by
    //     the security scan, where LangChain's tracing wouldn't
    //     fire
    //
    // Removing the auto-emit handling eliminates the duplicate
    // cards with zero loss of information. If a future subgraph
    // uses LangGraph's stock `ToolNode` (instead of ours) and
    // needs auto-emit, reintroduce here with a guard against
    // double-firing.
  } else if (event === "on_chain_end" && data) {
    if (process.env["NAUTILO_DEBUG_PERSIST"] === "1") {
      const output = data["output"] as Record<string, unknown> | undefined;
      const outputKeys = output && typeof output === "object"
        ? Object.keys(output).join(",")
        : `<${typeof output}>`;
      const messagesField = output ? output["messages"] : undefined;
      const messagesShape = Array.isArray(messagesField)
        ? `array[${messagesField.length}]`
        : messagesField === undefined
          ? "undefined"
          : `<${typeof messagesField}>`;
      log(
        `[nautilo/persist-debug] on_chain_end name=${JSON.stringify(name)} dataKeys=${Object.keys(data).join(",")} outputKeys=${outputKeys} output.messages=${messagesShape}`,
      );
    }
    const isProcessableNode = name === "agent"
      || name === "projection_preflight"
      || name === "ordinary_content_access_preflight"
      || name === "post_model"
      || name === "tools";
    if (isProcessableNode) {
      assistantMessageKey = tokenBatcher.completeMessage();
      const drained = tokenBatcher.drain();
      if (!skipSuppressed) {
        for (const e of drained) events.push(e);
      }
      // When skipSuppressed: any tokens that slipped through before the
      // skip tool ran are dropped here as well. The batcher is still
      // completed/drained so chunkSequence resets for the next turn.

      if (sentenceDetector) {
        sentenceDetector.complete();
        const sdrained = sentenceDetector.drain();
        if (!skipSuppressed) {
          for (const e of sdrained) events.push(e);
        }
      }

      const output = data["output"] as Record<string, unknown> | undefined;
      if (output) {
        const outMessages = output["messages"] as BaseMessage[] | undefined;
        const inputObj = data["input"] as Record<string, unknown> | undefined;
        const inMessages = inputObj
          ? (inputObj["messages"] as BaseMessage[] | undefined)
          : undefined;
        const inputLen = Array.isArray(inMessages) ? inMessages.length : 0;
        if (Array.isArray(outMessages) && outMessages.length > inputLen) {
          const delta = outMessages.slice(inputLen);
          // D128 — a skipped turn produces zero agent rows in
          // session_messages. Drop pure-text AIMessages so the
          // transcript doesn't surface fallback content the user
          // never saw on the WS stream. Tool-call AIMessages and
          // ToolMessages still persist so the LangGraph history /
          // tool lifecycle stays consistent.
          const filtered = (skipSuppressed
            ? filterMessagesForSkippedTurn(delta)
            : delta
          ).map(sanitizeMessageForTranscript);
          messagesToPersist.push(...filtered);
          if (
            (name === "projection_preflight" || name === "ordinary_content_access_preflight")
            && ctx?.publishProjectionPreflightLifecycle === true
            && !ctx.quietSupervision
            && !skipSuppressed
          ) {
            for (const message of filtered) {
              const rejection = projectionPreflightRejection(message, name === "ordinary_content_access_preflight");
              if (rejection === null) continue;
              // Projection arguments can contain confidential Memory source
              // IDs. A rejected call never executed, so publish a correlated
              // no-args attempt and its terminal error without inspecting the
              // model-authored arguments.
              events.push({
                ...toolTracker.toolStart(
                  rejection.toolCallId,
                  rejection.toolName,
                ),
                ...(ctx.laneKey ? { laneKey: ctx.laneKey } : {}),
              });
              events.push({
                ...toolTracker.toolEnd(
                  rejection.toolCallId,
                  rejection.toolName,
                  "error",
                  rejection.error,
                  rejection.content,
                ),
                ...(ctx.laneKey ? { laneKey: ctx.laneKey } : {}),
              });
            }
          }
          // Routine tool calls (including skip) remain audit/checkpoint data.
          // Publish only a tool-free answer at its node boundary so narration
          // emitted before an inspection cannot escape before skip is chosen.
          if (ctx?.quietSupervision && !skipSuppressed) {
            for (const message of filtered) {
              if (!AIMessage.isInstance(message) || message.tool_calls?.length) continue;
              const text = typeof message.content === "string" ? message.content
                : messageContentBlocksToVisibleText(message.content);
              tokenBatcher.addToken(text);
              sentenceDetector?.addToken(text);
              sentenceDetector?.complete();
              if (sentenceDetector) events.push(...sentenceDetector.drain());
              assistantMessageKey = tokenBatcher.completeMessage();
              events.push(...tokenBatcher.drain());
            }
          }
        }
      }
    }
  }

  return {
    events,
    messagesToPersist,
    ...(assistantMessageKey ? { assistantMessageKey } : {}),
  };
}

function streamMetadataLooksFireworksOrDeepSeek(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  const ls = m["ls_provider"];
  if (typeof ls === "string" && /fireworks|deepseek/i.test(ls)) return true;
  const model =
    typeof m["ls_model_name"] === "string"
      ? m["ls_model_name"]
      : typeof m["model"] === "string"
        ? m["model"]
        : typeof m["model_name"] === "string"
          ? m["model_name"]
          : "";
  return /deepseek|fireworks/i.test(model);
}

function messageContentBlocksToVisibleText(blocks: unknown[]): string {
  let out = "";
  for (const b of blocks) {
    if (typeof b === "string") {
      out += b;
      continue;
    }
    if (!b || typeof b !== "object") continue;
    const o = b as Record<string, unknown>;
    const t = typeof o["type"] === "string" ? o["type"] : "";
    if (t === "reasoning" || t === "redacted_thinking" || t === "thinking") continue;
    if (typeof o["text"] === "string") out += o["text"];
    else if (typeof o["content"] === "string") out += o["content"];
  }
  return out;
}

function summarizeChatModelChunkForDebug(chunk: unknown, streamMetadata: unknown): Record<string, unknown> {
  const meta =
    streamMetadata && typeof streamMetadata === "object"
      ? Object.keys(streamMetadata).slice(0, 12)
      : [];
  if (chunk === null || chunk === undefined) {
    return { chunkKind: typeof chunk, streamMetaKeys: meta };
  }
  if (typeof chunk === "string") {
    return { chunkKind: "string", len: chunk.length, head: chunk.slice(0, 120), streamMetaKeys: meta };
  }
  if (typeof chunk !== "object") {
    return { chunkKind: typeof chunk, streamMetaKeys: meta };
  }
  const c = chunk as Record<string, unknown>;
  const keys = Object.keys(c).slice(0, 20);
  const snap: Record<string, unknown> = { chunkKeys: keys, streamMetaKeys: meta };
  if (typeof c["content"] === "string") snap["contentHead"] = (c["content"]).slice(0, 160);
  if (Array.isArray(c["content"])) {
    snap["contentBlockTypes"] = (c["content"] as unknown[])
      .map((x) =>
        x && typeof x === "object" && "type" in (x)
          ? (x as { type?: string }).type
          : typeof x,
      )
      .slice(0, 12);
  }
  if (typeof c["reasoning_content"] === "string") {
    snap["reasoning_contentLen"] = (c["reasoning_content"]).length;
    snap["reasoning_contentHead"] = (c["reasoning_content"]).slice(0, 120);
  }
  const ak = c["additional_kwargs"];
  if (ak && typeof ak === "object") snap["additionalKwargsKeys"] = Object.keys(ak).slice(0, 15);
  const delta = c["delta"];
  if (delta && typeof delta === "object") {
    const d = delta as Record<string, unknown>;
    snap["deltaKeys"] = Object.keys(d).slice(0, 12);
    if (typeof d["reasoning_content"] === "string") {
      snap["deltaReasoningLen"] = (d["reasoning_content"]).length;
    }
  }
  return snap;
}

function handleTokenStream(
  data: Record<string, unknown> | undefined,
  batcher: TokenBatcher,
  sentenceDetector?: SentenceDetector | null,
  streamMetadata?: unknown,
): void {
  if (!data) return;

  const chunk = data["chunk"];
  let token = "";

  if (chunk && typeof chunk === "object") {
    const chunkRecord = chunk as Record<string, unknown>;
    const meta = (chunkRecord["usage_metadata"] ?? chunkRecord["response_metadata"]) as Record<string, unknown> | undefined;
    if (meta) {
      const input = typeof meta["input_tokens"] === "number" ? meta["input_tokens"]
        : typeof meta["prompt_tokens"] === "number" ? meta["prompt_tokens"] : 0;
      const output = typeof meta["output_tokens"] === "number" ? meta["output_tokens"]
        : typeof meta["completion_tokens"] === "number" ? meta["completion_tokens"] : 0;
      const total = typeof meta["total_tokens"] === "number" ? meta["total_tokens"] : input + output;
      if (input > 0 || output > 0) {
        log(`[nautilo/executor] Token usage: in=${input} out=${output} total=${total}`);
        batcher.setUsage({ inputTokens: input, outputTokens: output, totalTokens: total });
      }
    }
  }

  if (typeof chunk === "string") {
    token = chunk;
  } else if (chunk && typeof chunk === "object") {
    const chunkObj = chunk as Record<string, unknown>;

    if (typeof chunkObj["content"] === "string") {
      token = chunkObj["content"];
    } else if (Array.isArray(chunkObj["content"])) {
      token = messageContentBlocksToVisibleText(chunkObj["content"] as unknown[]);
    } else if (chunkObj["delta"] && typeof chunkObj["delta"] === "object") {
      const delta = chunkObj["delta"] as Record<string, unknown>;
      if (typeof delta["content"] === "string") {
        token = delta["content"];
      } else if (Array.isArray(delta["content"])) {
        token = messageContentBlocksToVisibleText(delta["content"] as unknown[]);
      }
    }
    if (!token && chunkObj["message"] && Array.isArray((chunkObj["message"] as { content?: unknown[] }).content)) {
      const mc = (chunkObj["message"] as { content: unknown[] }).content;
      token = messageContentBlocksToVisibleText(mc);
    }
  }

  const debugStream = process.env["NAUTILO_DEBUG_FIREWORKS_STREAM"] === "1";
  if (debugStream && streamMetadataLooksFireworksOrDeepSeek(streamMetadata)) {
    debug(
      "[nautilo/executor] on_chat_model_stream chunk:",
      summarizeChatModelChunkForDebug(chunk, streamMetadata),
      "extractedTokenLen:",
      token.length,
    );
  } else if (debugStream && !token && chunk != null) {
    warn(
      "[nautilo/executor] on_chat_model_stream empty token (NAUTILO_DEBUG_FIREWORKS_STREAM=1):",
      summarizeChatModelChunkForDebug(chunk, streamMetadata),
    );
  }

  if (token) {
    batcher.addToken(token);
    sentenceDetector?.addToken(token);
  }
}
