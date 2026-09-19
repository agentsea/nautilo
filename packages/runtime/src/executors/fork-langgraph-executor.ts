import { finishMemoryReviewTurn, memoryReviewAdmission, memoryReviewCompletionState } from "../memory-review/admission";
import type { ServerEvent } from "@nautilo/types";
import { StrictShadowEnforcementError } from "@nautilo/lattice-bridge";
import {
  createNautiloGraph,
  defaultPostModelDeps,
  deleteEphemeralCheckpointThread,
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
  maybeSummarizeImagesWithVisionFallback,
  clearAgentTurnContext,
  clearAgentTurnContextByKey,
  turnContextKey,
  buildRuntimeCapabilityTokens,
  getRelayRegistry,
  buildForegroundUserHumanMessage,
  type NautiloGraphDeps,
} from "@nautilo/agent";
import type { MemoryAccessEnvelope, RoomParticipant } from "@nautilo/trust";
import { envelopeReadableNamespaces, getPolicyResolver } from "@nautilo/trust";
import { log, warn } from "@nautilo/logger";
import { eventBus } from "../event-bus";
import { TokenBatcher, ToolCallTracker } from "../utils/token-batcher";
import {
  AgentProgressHeartbeat,
  noteAgentProgressFromStreamEvent,
} from "../utils/agent-progress-heartbeat";
import { persistMessages } from "./persist-messages";
import { loadForegroundAuthoredContext } from "./foreground-authored-context";
import { SentenceDetector, type SentenceDetectorConfig } from "../utils/sentence-detector";
import { parseMultimodalImagesFromJobInput } from "./multimodal-job-input";
import {
  processStreamEvent,
  type StreamProcessorContext,
  resolveForegroundHistoryMessages,
  freshForegroundRecordContextEligible,
  freshForegroundActivationState,
  freshForegroundTurnScopedGraphContext,
  parseVerifiedOrdinaryOrigin,
} from "./langgraph-executor";
import type { ForkRunMetadata } from "../fork/fork-metadata";
import { buildForkBackgroundMarker } from "../fork/fork-initial-messages";
import type { CompiledNautiloGraph } from "../fork/fork-initial-messages";
import { forkCoordinator } from "../fork/fork-coordinator";
import {
  resolveGraphExecutionPolicy,
  GraphExecutionMetrics,
  toGraphBudgetOutcome,
} from "@nautilo/agent";
import {
  buildProtectedRoomTranscriptContext,
} from "../context/build-transcript-context";
import {
  checkpointSaverForConversationExecution,
  type ProtectedConversationExecutorTurnScope,
  type ProtectedConversationExecutionServices,
} from "../conversation/conversation-execution-services";
import {
  disposeProtectedCheckpointSaver,
} from "../conversation/protected-checkpoint-saver-disposal";
import { foregroundRecordContextPortForRoom } from
  "../reflection/foreground-record-context";
import { foregroundRecordRecallPortForState } from
  "../reflection/foreground-record-recall";
import {
  enforceLiveShadowForegroundHistoryBoundary,
  getCurrentLiveShadowTurnContext,
  protectLiveShadowForegroundMemories,
  protectLiveShadowForegroundRecordContext,
  protectLiveShadowForegroundRecordRecall,
} from
  "../conversation/live-shadow-turn-context";
import { stageProtectedPromptMemoryBrief } from
  "../conversation/protected-prompt-memory-staging";
import { prepareForegroundEncryptedContext } from
  "../conversation/foreground-context-preparation";
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

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/** Scheduling a Human turn on a fork preserves its verified foreground origin. */
export function freshForkActivationState(input: Record<string, unknown>) {
  const foreground = freshForegroundActivationState(input);
  return {
    ...foreground,
    // Reuse direct-Human admission; the fork itself grants no authority to
    // inferred group wakes, task receipts, or other automatic executions.
    trustedExecutionEntrypoint: foreground.trustedExecutionEntrypoint === "foreground.main"
      ? "foreground.fork" as const
      : null,
  };
}

/** Coordinate-first wakes inject the Human turn but must not append it again. */
export function shouldPersistForkHumanMessage(input: {
  protectedTurn: boolean;
  humanAlreadyPersisted: boolean;
}): boolean {
  return !input.protectedTurn && !input.humanAlreadyPersisted;
}

/**
 * fork-on-busy path: checkpoint on `forkThreadId`, transcript on parent thread id.
 */
export async function* forkLanggraphExecutor(
  input: Record<string, unknown>,
  jobId: string,
  laneKey: string | null,
  signal: AbortSignal,
  protectedServices?: ProtectedConversationExecutionServices,
  protectedTurn?: ProtectedConversationExecutorTurnScope,
): AsyncGenerator<ServerEvent> {
  if ((protectedServices === undefined) !== (protectedTurn === undefined)) {
    throw new TypeError(
      "Protected fork services and authorized turn scope must be supplied together",
    );
  }
  const forkRun = input["forkRun"] as ForkRunMetadata | undefined;
  if (!forkRun || forkRun.mode !== "fork") {
    throw new Error('forkLanggraphExecutor requires forkRun.mode === "fork"');
  }

  const ownerId = typeof input["ownerId"] === "string" ? input["ownerId"] : "";
  const message = typeof input["message"] === "string" ? input["message"] : "";
  const attachmentTextBlocks = parseStringArray(input["attachmentTextBlocks"]);
  const multimodalImages = parseMultimodalImagesFromJobInput(input["multimodalImages"]);
  const transcriptThreadId = forkRun.transcriptThreadId;
  const checkpointThreadId = forkRun.checkpointThreadId;
  const effectiveLaneKey = laneKey ?? "app:default";
  const memoryAccessEnvelope = (input["memoryAccessEnvelope"] as MemoryAccessEnvelope | undefined) ?? null;
  const actorRole = typeof input["actorRole"] === "string" ? input["actorRole"] : "owner";
  // agentId is required — fail loudly rather than
  // borrow the bootstrap default (see langgraph-executor.ts).
  const agentIdFromInput =
    typeof input["agentId"] === "string" && input["agentId"]
      ? input["agentId"]
      : "";
  const agentId =
    agentIdFromInput || memoryAccessEnvelope?.agentId || "";
  if (!agentId) {
    throw new Error(
      "fork-langgraph-executor: agentId required (input.agentId or memoryAccessEnvelope.agentId)",
    );
  }
  const roomId =
    (typeof input["roomId"] === "string" && input["roomId"])
      ? input["roomId"]
      : memoryAccessEnvelope?.roomId ?? "";
  // preserve the canonical child Room id through forked turns too;
  // their transcript rows share the same authoritative root summary contract
  // as the main foreground executor.
  const subthreadRoomId =
    typeof input["subthreadRoomId"] === "string" && input["subthreadRoomId"]
      ? input["subthreadRoomId"]
      : "";
  const roomRoster: RoomParticipant[] = Array.isArray(input["roomRoster"])
    ? (input["roomRoster"] as RoomParticipant[])
    : [];
  // transcript owner of the parent thread (mirrors the non-forked turn
  // on this thread; falls back to the memory-scoped ownerId like does).
  const transcriptOwnerId =
    typeof input["transcriptOwnerId"] === "string" && input["transcriptOwnerId"]
      ? input["transcriptOwnerId"]
      : ownerId;
  // subthread scope, threaded through exactly as main path
  // does (passthrough keys on the job input). Absent ⇒ plain room scope.
  const subthreadParentRoomId =
    typeof input["subthreadParentRoomId"] === "string" ? input["subthreadParentRoomId"] : "";
  const subthreadAnchorMessageId =
    typeof input["subthreadAnchorMessageId"] === "number"
      ? input["subthreadAnchorMessageId"]
      : undefined;
  const currentMessageId =
    typeof input["currentMessageId"] === "number"
      ? input["currentMessageId"]
      : undefined;
  const turnId = typeof input["turnId"] === "string" ? input["turnId"] : "";
  const causalHumanUserId =
    typeof input["causalHumanUserId"] === "string" && input["causalHumanUserId"]
      ? input["causalHumanUserId"]
      : null;
  const mentionedHumanUserIds = parseStringArray(input["mentionedHumanUserIds"]);
  // A fork has its own checkpoint, but is still a fresh foreground execution.
  // Seed exactly the same fresh lifecycle/activation projection as main turns;
  // do not borrow a parent turn's one-shot approval or activation state.
  const foregroundActivationState = freshForkActivationState(input);
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
  if (liveShadowRuntime !== undefined) {
    foregroundActivationState.suppressToolLifecycleEvents = true;
  }
  const { suppressToolLifecycleEvents } = foregroundActivationState;
  const serverTimePrefixIso =
    typeof input["serverTimePrefixIso"] === "string" ? input["serverTimePrefixIso"] : undefined;
  const currentFolder = typeof input["currentFolder"] === "string" ? input["currentFolder"] : "";
  const currentFolderRelayId = typeof input["currentFolderRelayId"] === "string" ? input["currentFolderRelayId"] : "";
  const workspacePath = typeof input["workspacePath"] === "string" ? input["workspacePath"] : "";
  const autoApprove = input["autoApprove"] === true;
  const {
    activeMiniApp,
    liveMiniAppSession,
    artifactRefs,
    focusedResources,
  } = freshForegroundTurnScopedGraphContext(input);
  // parity: retain only a strictly validated ordinary-origin proof from
  // this fork's own accepted job input. The parent checkpoint is never a
  // source of host authority.
  const verifiedOrdinaryOrigin = parseVerifiedOrdinaryOrigin(
    input["verifiedOrdinaryOrigin"],
  );
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

  const hasPayload =
    message.trim().length > 0 ||
    attachmentTextBlocks.some((s) => s.trim().length > 0) ||
    multimodalImages.length > 0;

  if (!hasPayload) {
    throw new Error("Empty message");
  }

  const policyResolver = getPolicyResolver();
  // one shared graph execution policy seam (recursion ceiling
  // resolved here, threaded into `streamConfig` below). Metrics counts
  // supersteps / model invocations / tool calls from the existing
  // `streamEvents` hook; logged at stream end / on error (telemetry-only).
  const executionPolicy = resolveGraphExecutionPolicy(input);
  const metrics = new GraphExecutionMetrics();
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
    fullEncryptionOnlyForState: () =>
      liveShadowContext?.enforcementPolicy?.mode === "encrypted_only",
  };
  const isGuest = actorRole === "guest";
  // Profile is 1:1 with Agent. Forked/background turns can carry
  // an authorization owner that differs from the speaking agent; identity
  // fields like soul/name/model must resolve by `agentId`.
  const authoredContext = await loadForegroundAuthoredContext({
    agentId,
    ownerId,
    isGuest,
  }, {
    getExecutionConfigByAgentId: getAgentExecutionConfigById,
    // Fork execution has never loaded authored Skill bodies.
    resolveEnabledBodies: () => Promise.resolve([]),
  });
  const profile = authoredContext.profile;
  const soulFile = authoredContext.soulFile;
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
  const perTurnModel = typeof input["model"] === "string" ? input["model"].trim() : "";
  const foregroundModelControlSnapshot = await loadForegroundModelControlSnapshot(
    roomId, agentId, perTurnModel || null,
  );
  const foregroundModelPlan = foregroundModelControlPlanFromSnapshot(foregroundModelControlSnapshot, () =>
    profile?.defaultModel
      ? resolveModelRole("chat", { configuredId: profile.defaultModel })
      : getDefaultModel().id,
  );
  const modelId = resolveModelRole("chat", { configuredId: foregroundModelPlan.initialModelId });

  // a fork rebuilds its history from the DB transcript (single source of
  // truth) at start, like the non-forked turn on this thread . The
  // checkpoint COPY of parent history is gone. The fork still does NOT redo an
  // in-flight predecessor because we re-inject a transient [FORK BACKGROUND]
  // marker (R2b) — only the predecessor's not-yet-committed *reply content* is
  // stale (decision 10.2.4).
  //
  // Reuse the current seam directly: resolveForegroundHistoryMessages owns the
  // createDirectDb(1) pool lifecycle (try/finally close), subthread scoping,
  // and excludeMessageId — so we neither leak a pool per fork nor re-implement
  // that plumbing. Ordinary legacy forks persist their own user row after this
  // rebuild. Coordinate-first protected forks already persisted it, however,
  // and carry currentMessageId so the trigger cannot enter both history and the
  // live fork input.
  const resolvedInitialRecordContext =
    roomId && freshForegroundRecordContextEligible(input)
      ? foregroundRecordContextPortForRoom(roomId)
      : undefined;
  const initialRecordContext = resolvedInitialRecordContext === undefined
    ? undefined
    : protectedTurn === undefined
      ? protectLiveShadowForegroundRecordContext(
        resolvedInitialRecordContext,
      )
      : resolvedInitialRecordContext.representation === "protected"
        ? resolvedInitialRecordContext
        : undefined;
  const historyMessages = protectedTurn === undefined
    ? await prepareForegroundEncryptedContext(
      () => resolveForegroundHistoryMessages({
        turnKind: "fresh",
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
    : buildProtectedRoomTranscriptContext(
      protectedTurn.history,
      modelId,
    );

  // Do not mutate Memory tiers until every selected pre-model family is
  // ready. Any later context wait repeats this executor with the same product
  // selection instead of progressively draining the brief.
  if (protectedMemoryBriefOverflowIds.length > 0) {
    await commitPromptBriefMemoryOverflow(
      protectedMemoryBriefOverflowIds,
      agentId || undefined,
      ownerId || undefined,
    );
  }

  // Like the main executor, a live Shadow fork verifies all selected context
  // before allowing the image-summary model to run.
  const visionSummaryBlocks = await maybeSummarizeImagesWithVisionFallback({
    mainModelId: modelId,
    images: multimodalImages,
    signal,
  });
  const mergedAttachmentTextBlocks = [
    ...visionSummaryBlocks,
    ...attachmentTextBlocks,
  ];

  // R2b — in-flight-predecessor marker. forkRun.pendingTurns is the slimmed
  // {sequence, turnId}[] the coordinator registered at dispatch. When non-empty,
  // each predecessor's user message is ALREADY in `historyMessages` (committed
  // to the DB); we only add the "don't redo it, it's being handled" instruction.
  // Transient (nautilo_transient_context) → never persisted to the transcript.
  const inFlightMarker =
    forkRun.pendingTurns.length > 0
      ? [buildForkBackgroundMarker(forkRun.pendingTurns.length)]
      : [];

  // The fork's own user message. The server-time prefix (when present) lives
  // only in the fork checkpoint; the clean copy is persisted to the parent
  // transcript (unchanged behavior).
  const forkUser = buildForegroundUserHumanMessage({
    userText: message,
    attachmentTextBlocks: mergedAttachmentTextBlocks,
    multimodalImages,
    modelId,
    ...(serverTimePrefixIso ? { serverTimePrefixIso } : {}),
  });
  const forkUserForTranscript = serverTimePrefixIso
    ? buildForegroundUserHumanMessage({
        userText: message,
        attachmentTextBlocks: mergedAttachmentTextBlocks,
        multimodalImages,
        modelId,
      })
    : forkUser;

  const clientVoiceMode = input["voiceMode"] === true;
  const hasElevenLabsKey = !!process.env["ELEVENLABS_API_KEY"]?.trim();
  const voiceEnabled = clientVoiceMode && hasElevenLabsKey;

  const forkMessages = [...historyMessages, ...inFlightMarker, forkUser];

  const graphInput = {
    noProgressStreaks: new Map(),
    browserDecision: null,
    noProgressPendingCorrection: null,
    noProgressPendingStop: null,
    messages: forkMessages,
    userId: ownerId,
    personaId: "owner",
    assistantName,
    soulFile,
    memoryBrief,
    memoryDelta: "",
    voiceMode: voiceEnabled,
    source: "api",
    model: modelId,
    foregroundModelControlSnapshot,
    currentThreadId: transcriptThreadId,
    langgraphThreadId: checkpointThreadId,
    approvalLaneKey: effectiveLaneKey,
    ...foregroundActivationState,
    memoryAccessEnvelope,
    actorRole,
    autoApprove,
    agentId,
    relayCapabilities: buildRuntimeCapabilityTokens(getRelayRegistry(), ownerId),
    verifiedOrdinaryOrigin,
    roomId,
    roomRoster,
    turnId,
    causalHumanUserId: causalHumanUserId ?? "",
    currentFolder,
    currentFolderRelayId,
    workspacePath,
    activeMiniApp,
    liveMiniAppSession,
    artifactRefs,
    focusedResources,
    securityAuditClientMeta,
  };

  const tokenBatcher = new TokenBatcher({
    laneKey: effectiveLaneKey,
    ...(agentId ? { authorAgentId: agentId } : {}),
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
    jobId,
    ...(turnId ? { turnId } : {}),
    ...(liveShadowRuntime === undefined ? {} : { liveShadowRuntime }),
    laneKey: effectiveLaneKey,
  };
  const liveShadowStreamState = Object.freeze({
    ordinals: new Map<string, number>(),
  });
  const savedFingerprints = new Set<string>();

  const persistOptsBase = {
    ...await memoryReviewAdmission(memoryAccessEnvelope, checkpointThreadId, { threadId: transcriptThreadId, transcriptOwnerId: ownerId, turnId, input }),
    agentId,
    roomId,
    ...(subthreadRoomId ? { subthreadRoomId } : {}),
    laneKey: effectiveLaneKey,
    eventBus,
    ...(turnId ? { humanTurnId: turnId } : {}),
    trustedExecutionEntrypoint: "foreground.fork" as const,
    notificationContext: {
      mentionedHumanUserIds: [],
      causalHumanUserId,
      causalHumanTurnId: causalHumanUserId ? turnId || null : null,
    },
  };

  // Persist the CLEAN fork-user copy to the transcript — the server-time
  // prefix (when present) lives only in the fork checkpoint + parent splice.
  if (protectedTurn !== undefined && input["humanAlreadyPersisted"] !== true) {
    throw new TypeError(
      "Protected fork Human input must be coordinate-first persisted before Agent execution",
    );
  }
  if (shouldPersistForkHumanMessage({
    protectedTurn: protectedTurn !== undefined,
    humanAlreadyPersisted: input["humanAlreadyPersisted"] === true,
  })) {
    await persistMessages(
      transcriptThreadId,
      ownerId,
      [forkUserForTranscript],
      savedFingerprints,
      {
        ...persistOptsBase,
        notificationContext: {
          mentionedHumanUserIds,
          causalHumanUserId: null,
          causalHumanTurnId: null,
        },
      },
    );
  }

  const protectedCheckpointSaver = protectedServices === undefined
    ? null
    : checkpointSaverForConversationExecution(
      protectedServices,
      {
        logicalThreadId: checkpointThreadId,
        kind: "foreground.fork",
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
          logicalThreadId: checkpointThreadId,
          checkpoint: liveShadowContext.session.checkpoint,
        })
      : null;
  if (liveShadowCheckpointSaver !== null) {
    try {
      await liveShadowCheckpointSaver.deleteThread(checkpointThreadId);
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
  let graph: CompiledNautiloGraph;
  try {
    graph = createNautiloGraph(
      checkpointSaver,
      policyResolver,
      postModelDeps,
    ) as CompiledNautiloGraph;
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
    configurable: { thread_id: checkpointThreadId },
    signal,
    recursionLimit: executionPolicy.recursionLimit,
    version: "v2",
  };

  log(`[nautilo/executor] fork stream checkpoint=${checkpointThreadId} transcript=${transcriptThreadId}`);

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

  let memoryReviewRecorded = false;
  try {
    const eventStream = graph.streamEvents(graphInput, streamConfig);

    for await (const ev of eventStream) {
      if (signal.aborted) {
        await finishMemoryReviewTurn({ threadId: transcriptThreadId, agentId, turnId, state: "interrupted" });
        memoryReviewRecorded = true;
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
        if (
          event.type === "message.tokens"
          && "content" in event
          && event.content.trim().length > 0
        ) {
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
              transcriptThreadId,
              ownerId,
              [...ordinaryMessages],
              savedFingerprints,
              {
                ...persistOptsBase,
                ...(assistantMessageKey ? { assistantMessageKey } : {}),
              },
            ),
          });
          for (const protectedEvent of protectedEvents) yield protectedEvent;
        } else if (protectedTurn === undefined) {
          await persistMessages(
            transcriptThreadId,
            ownerId,
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

    let hasPendingInterrupt = true;
    let memoryReviewState: "completed" | "awaiting" | "pending" = "pending";
    try {
      const postState = await graph.getState({ configurable: { thread_id: checkpointThreadId } });
      memoryReviewState = memoryReviewCompletionState(postState);
      hasPendingInterrupt = memoryReviewState !== "completed";
      const hasAnyPendingInterrupt = (
        (postState as Record<string, unknown> | undefined)?.["tasks"] as
          Array<Record<string, unknown>> | undefined
      )?.some((task) =>
        Array.isArray(task["interrupts"]) && task["interrupts"].length > 0
      ) ?? false;
      if (hasAnyPendingInterrupt) {
        memoryReviewState = "awaiting";
        hasPendingInterrupt = true;
      }
      const events = collectPendingInterruptEvents(
        postState as { tasks?: Array<Record<string, unknown>>; values?: unknown } | undefined,
        checkpointThreadId,
        effectiveLaneKey,
      );
      for (const evOut of events) {
        log(`[nautilo/executor] ${evOut.type} interrupt detected (fork)`);
        hasPendingInterrupt = true;
        yield evOut;
      }
    } catch (e) {
      log(`[nautilo/executor] Error checking interrupt state (fork): ${e instanceof Error ? e.message : String(e)}`);
    }

    log(
      `[nautilo/executor] Fork stream complete checkpoint=${checkpointThreadId} transcript=${transcriptThreadId} ${metrics.formatLogToken()}`,
    );

    // the splice is gone. On clean completion the fork's reply rows are
    // already in the parent transcript (persisted as the stream produced them),
    // so the fork's contribution reaches the parent's next turn via the DB
    // rebuild , NOT via a checkpoint splice. We only advance the lane's
    // commit ordering so a later main turn cannot write ahead of this fork
    // ('s hasUnreconciledLowerTurns gate). On a pending interrupt (paused
    // fork) we do NOT advance — the resume path (auth.ts, ) will, once the
    // post-resume rows are persisted.
    //
    // the fork-coordinator lane key is the bot checkpoint thread
    // (the serialization axis), i.e. the parent thread id.
    if (hasPendingInterrupt) {
      await finishMemoryReviewTurn({ threadId: transcriptThreadId, agentId, turnId, state: memoryReviewState });
      memoryReviewRecorded = true;
    }
    if (!hasPendingInterrupt) {
      forkCoordinator.markForkCompleted(forkRun.parentThreadId, forkRun.sequence);
      await finishMemoryReviewTurn({ threadId: transcriptThreadId, agentId, turnId, state: "completed" });
      memoryReviewRecorded = true;
      // the fork's `:fork:` checkpoint thread is terminal and
      // ephemeral: its reply rows are already durably in the parent transcript
      // (persisted as the stream produced them) and the lane's commit ordering
      // has just advanced (above), so the checkpoint is no longer load-bearing.
      // Delete it best-effort AFTER the transcript + ordering commit landed and
      // ONLY when no interrupt is pending (a paused fork resumes from this
      // checkpoint). Never on abort / awaiting / approval / PIN / identity /
      // those branches return or throw before reaching here.
      // `deleteEphemeralCheckpointThread` guards the ephemeral-thread predicate
      // and swallows failures, so this can never turn the successful fork into
      // a failure.
      if (!signal.aborted) {
        if (encryptedCheckpointSaver === null) {
          await deleteEphemeralCheckpointThread(
            checkpointSaverForConversationExecution(undefined),
            checkpointThreadId,
          );
        } else {
          try {
            await checkpointSaver.deleteThread(checkpointThreadId);
          } catch {
            warn("[checkpoint] protected terminal cleanup deferred");
          }
        }
      }
    }
  } catch (error) {
    if (!memoryReviewRecorded) {
      await finishMemoryReviewTurn({ threadId: transcriptThreadId, agentId, turnId, state: "interrupted" });
      memoryReviewRecorded = true;
    }
    if (signal.aborted) return;
    checkpointPrimaryError = true;

    // surface the typed internal graph-budget outcome distinctly
    // in telemetry . The user-safe sentence is produced by
    // `toFriendlyError` at the runtime job-loop catch site.
    const budgetOutcome = toGraphBudgetOutcome(error, executionPolicy.recursionLimit);
    if (budgetOutcome) {
      log(
        `[nautilo/executor] Fork graph budget exceeded checkpoint=${checkpointThreadId} ` +
          `outcome=${budgetOutcome.kind} recursionLimit=${budgetOutcome.recursionLimit} ${metrics.formatLogToken()}`,
      );
    } else {
      log(
        `[nautilo/executor] Fork stream error checkpoint=${checkpointThreadId} ${metrics.formatLogToken()}`,
      );
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

    throw error;
  } finally {
    agentProgressHeartbeat?.dispose();
    if (turnId) clearAgentTurnContext(turnId);
    if (turnId && agentId) {
      clearAgentTurnContextByKey(turnContextKey(turnId, agentId));
    }
    if (encryptedCheckpointSaver !== null) {
      await disposeProtectedCheckpointSaver({
        saver: encryptedCheckpointSaver,
        primaryErrorPresent: checkpointPrimaryError,
      });
    }
  }
}
