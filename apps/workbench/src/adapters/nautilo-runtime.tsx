import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
} from "react";
import { useNavigate } from "react-router-dom";
import { dedupeThreadMessagesById, newMessageId } from "../lib/message-id";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from "@assistant-ui/react";
import {
  isProtectedMessageRealtimeEventV2,
  normalizeHumanMessageText,
  GENIE_APPLICATION_BRIDGE_VERSION_V1,
  type ChatUploadedAttachmentRef,
  type ChatFocusedResourceRef,
  type ChatAttachmentStatus,
  type ModelFallbackEvent,
  type LiveShadowMessageRealtimeEventV1,
  type FullEncryptionMessageRealtimeContentEventV2,
  type ServerEvent,
  type RealtimeControlEvent,
  type ProveItToolInfo,
} from "@nautilo/types";
import {
  createWsRealtimeClient,
  type RealtimeClient,
} from "@nautilo/realtime-client";
import type {
  MessageBackfillUrgentSelection,
  RoomPendingAttentionRecoveryResponse,
} from "@nautilo/api-client/browser";
import { resumeRealtimeAfterAdmission } from "./admission-realtime-resume";
import { PinDialog } from "../components/pin-dialog";
import { mergeFocusedResourcesForSend } from "./focused-resource-send";
import { mergeProtectedMessageUpdate, readProtectedMessageUpdate } from "./protected-message-update";
import { ApprovalDialog } from "../components/approval-dialog";
import {
  parseSerializedToolArgsForDisplay,
  projectToolArgsForCardDisplay,
  projectToolResultTextForDisplay,
} from "../components/tool-argument-preview";
import {
  applyCanonicalToolEndToActivity,
  finalizeRunningToolActivityWithoutReceipt,
  finalizeToolCallMessagesWithoutReceipt,
  isSameToolLifecycleCandidate,
  missingToolReceiptMessage,
  type ToolLifecycleCandidates,
  type ToolTerminalJob,
} from "./tool-lifecycle-reconciliation";
import { preserveComputerUseResultForCard } from "../components/tool-card/renderers/computer-use";
import { preserveConnectedAppResultForCard } from "../components/tool-card/renderers/connected-app-receipt";
import { VoicePlayer } from "./voice-player";
import { apiClient, WS_URL } from "../lib/api";
import {
  assertCryptoAdmissionAccess,
  getCryptoAdmissionSnapshot,
  isCryptoAdmissionAllowed,
  isCryptoAdmissionGenerationCurrent,
  requestCryptoAdmissionRefresh,
  runWithCryptoAdmission,
  subscribeCryptoAdmissionAccess,
} from "../lib/crypto-admission-access";
import {
  clearClientActionSession,
  currentClientActionSessionIdForResume,
  installClientActionSession,
  retainClientUiAction,
  withCurrentClientActionSession,
} from "../lib/client-action-session";
import { presentWorkbenchApplicationTarget } from "../lib/genie-application-targets";
import { readWorkbenchTheme } from "../lib/genie-soft-prompt";
import { useSetupStatus } from "../contexts/setup-status-context";
import { readFileContext } from "./file-context-ref";
import { readActiveMiniApp, readLiveMiniAppSession, clearLiveMiniAppSessionIfMatches } from "./mini-app-context-ref";
import {
  parsePlatformLiveAppProposal,
  publishLiveAppProposal,
  requestLiveAppProposalReconciliation,
} from "../apps/live-app-proposal-bus";
import {
  liveAppMutationFromToolEnd,
  publishLiveAppMutationCommitted,
} from "../apps/live-app-mutation-bus";
import { publishLiveAppSessionClosed } from "../apps/live-app-session-close-bus";
import {
  clearAttachments,
  getAttachments,
  updateAttachment,
  type ComposerAttachment,
} from "./composer-attachments-ref";
import { clearArtifactRefs, getArtifactRefs } from "./composer-artifact-refs-ref";
import type {
  AdvancedVideoWorkcardContinuation,
  ChatArtifactRef,
  RoomDetailResponse,
} from "@nautilo/types";
import {
  clearFocusedResources,
  getFocusedResources,
} from "./composer-focused-resources-ref";
import {
  desktopAPI,
  initiatingClientSurfaceForWorkbench,
  computeInitialLastOpenAtSeed,
  getShellStateOnBoot,
  isDesktop,
  subscribeToDesktopProtectedRoomAccessState,
  type DesktopForegroundShadowAPI,
  type DesktopReadyToWorkAPI,
} from "../lib/desktop";
import { roomMessageSendFailureReason } from "../lib/room-message-send-failure";
import { createWorkbenchDataOperationOwner } from "../lib/encryption-data-operation-policy";
import { createRoomMessageOperations, isConfidentialRoomEvent } from "./room-message-operations";
import { createRoomHistoryDataAdapter } from "./room-history-data-adapter";
import {
  createWorkbenchMessageBackfillScheduler,
  createDesktopMessageBackfillSchedulerClient,
  type PrioritizedHistoryRefreshResult,
} from "./message-backfill-scheduler";
import { restoreRoomReadOutcome } from "./room-read-outcome";
import { createVisibilityGate, shouldHandleVisibility } from "./ws-visibility-gate";
import { setFocusedTurnDispatcher, setRevertDispatcher } from "./tool-invoke-ref";
import {
  dedupeMessageArtifactOpenRefs,
  MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY,
  restoreSessionMessages,
  type RoomHistoryShadowReadAdapter,
} from "./session-rehydrate";
import { reconcileAdvancedVideoWorkcardMessage } from "./message-new-reconciliation";
import { shouldApplyWsEventForActiveRoom, roomIdFromLaneKey } from "./ws-event-room";
import {
  applyTokensContentChunk,
  finalizeAllStreamsOnCancel,
  finalizeTokensDone,
  findAssistantReconcileIndex,
  laneAuthorStreamLookupKey,
  reconcileAssistantDurableMessage,
  plannedShutdownReconnectMessage,
  resolveFailedJobStreamFinalization,
  streamKey,
  type StreamState,
} from "./nautilo-stream-state";
import { applyThreadSummarySnapshot } from "./thread-summary-snapshot";
import { ModelFallbackStatusNotice } from "./model-fallback-notice";
import { DeepResearchStatusNotice } from "./deep-research-status-notice";
import { ForegroundContextStatusNotice } from "./foreground-context-status-notice";
import { PendingAttentionRecoveryNotice } from "./pending-attention-recovery-notice";
import { OrdinaryContentAccessRecoveryNotice } from
  "../components/content-access/ordinary-content-access-recovery";
import { PendingContentAccessRecoveryNotice } from
  "../components/content-access/pending-content-access-recovery";
import { useAutoDismiss } from "./use-auto-dismiss";
import { consumeConductorAskUserWsEvent } from "./ws-event-ask-user";
import {
  applyReactionDelta,
  applyActorReaction,
} from "../modes/rooms/shape/reactions/reaction-aggregate";
import type { ReactionAggregate } from "../modes/rooms/shape/reactions/ReactionStrip";
import { useAuth } from "../hooks/use-auth";
import { useCan } from "../hooks/use-can";
import { addAuthTransitionListener } from "../lib/auth-transition";
import { useRoomNavigation } from "../contexts/room-navigation-context";
import { parseRouteRoomId } from "../routes/room-route";
import {
  clearRoomPanelMessageCountOptimisticOverlay,
  handleRoomPanelJobDispatched,
  handleRoomPanelJobStatus,
} from "../rooms/rooms-panel-model";
import {
  ApiError,
  type LiveShadowEncryptionTransitionMode,
} from "@nautilo/api-client/browser";
import {
  createBrowserLiveShadowMessageReceiver,
  createBrowserHumanPeerLiveShadowMessageReceiver,
  createBrowserSharedAgentLiveShadowMessageReceiver,
  createBrowserSharedAgentOutputLiveShadowReceiver,
  createBrowserLiveShadowMessageClient,
  createBrowserBackgroundAuthorizationClientV2,
  deriveBrowserCryptoDeviceId,
  createBrowserRoomHistoryShadowMessageReader,
  createBrowserMessageBackfillClient,
  type ProtectedRoomAccessStateV2,
} from
  "@nautilo/lattice-bridge/client/browser";
import { createCoalescedBackgroundAuthorizationSweepV2 } from
  "@nautilo/lattice-bridge/client/background";
import {
  classifyDataOperationFailure,
  isProtectedTopLevelRoomKind,
  type MessagePayloadV2,
} from "@nautilo/lattice-bridge";
import { projectLiveShadowMessageResult } from
  "./live-shadow-message-projection";
import { sendOrdinaryRoomMessage } from "../lib/ordinary-room-message";
import {
  editRoomMessageWithPolicy,
  type RoomMessageEdit,
} from "../lib/room-message-edit";
import { rememberAskUserResumeContext } from
  "../components/composer/ask-user-resume-context";
import {
  connectedWebActionAttentionKey,
  consumePendingAttentionForToolStart,
  parseConnectedWebActionAttention,
  parseConnectedWebActionResumeFailed,
  type ConnectedWebActionAttention,
  type ConnectedWebActionResumeFailed,
} from "./connected-web-action-attention";
import { readOrCreateBrowserCryptoInstallationId } from
  "../lib/browser-crypto-installation";
import {
  WsStateContext,
  ChatsSearchContext,
  RoomHistoryContext,
  RoomInitialHistoryContext,
  RoomMessageSearchContext,
  VoiceControlsContext,
  ToolActivityContext,
  RevisionStateContext,
  ApprovalAskContext,
  CodexRequestContext,
  AutoApproveContext,
  RuntimeShellStateContext,
  ConversationEncryptionPolicyModeContext,
  RoomMessageEditContext,
  allowsOrdinaryConversationPersistence,
  RoomReactionsContext,
  ThreadRoomEventRouterContext,
  RoomMessageOperationsContext,
  NotificationRuntimeEventSourceContext,
  ProtectedRoomAccessContext,
  TOOL_ACTIVITY_CAP,
  type WsState,
  type VoiceControls,
  type TurnStopFailureReason,
  type TurnStopStatus,
  type ToolActivityEvent,
  type RevisionStateSnapshot,
  type ApprovalAskState,
  type ApprovalAskControls,
  type CodexRequestControls,
  type AutoApproveControls,
  type RoomReactionControls,
  type ThreadRoomEventRouter,
  type ThreadRoomRegistration,
  type NotificationRuntimeEvent,
  type RoomHistoryControls,
  type RoomInitialHistoryControls,
  type ChatsSearchController,
  type ChatsSearchControls,
  type ChatsSearchState,
  type RoomMessageSearchController,
  type RoomMessageSearchControls,
  type RoomMessageSearchState,
  shouldPublishThreadRoomFocusEvent,
  shouldRouteEventToThreadRoom,
  initialCodexRequestLifecycleState,
  isCodexOwner,
  isCodexRequestForViewer,
  reduceCodexRequestLifecycle,
  selectCodexRequestsForRoom,
  type CodexRequestLifecycleSourceAction,
  type ProtectedRoomCoverageState,
} from "./runtime-contexts";

import { createChatsSearchController } from "./chats-search-state";
import { createRoomMessageSearchController } from "./room-search-state";
import {
  createRoomHistoryAroundController,
  mergeRoomMessagesAround,
  mountedRoomHistoryPrioritySelection,
  nextMountedHistoryPrioritySelection,
  mountedRoomHistoryRefreshRequest,
  mountedRoomHistoryRefreshTarget,
  mountedRoomHistoryRefreshTargetState,
  replaceRefreshedRoomMessage,
  type RoomHistoryAroundController,
  type RoomHistoryAroundState,
} from "./room-history-around";
import { isMediaGenerationApproval, shouldAutoResolveAsk } from "@nautilo/types";
import {
  deriveRuntimeShellState,
  type RuntimeShellState,
} from "./runtime-shell-state";
import {
  deriveApprovalAskView,
  enqueuePendingApprovalPreviews,
  initialApprovalLifecycleState,
  initialPendingApprovalPreviewQueue,
  reduceApprovalLifecycle,
  reconcilePendingApprovalPreviewSnapshot,
  resolutionFromVerb,
  settlePendingApprovalPreview,
  shouldQueueApprovalAsk,
  type ApprovalAskPayload,
  type ApprovalLifecycleAction,
  type PendingApprovalPreviewQueue,
} from "../approval/approval-lifecycle";
import {
  clearAutoApproveSession,
  readAutoApproveSession,
  writeAutoApproveSession,
} from "../approval/auto-approve-session";
import {
  TaskStateProvider,
  RunningSubagentsFromTaskState,
  type TaskStateBridge,
} from "../contexts/task-state/task-state-context";
import { setAgentStreamingVisibleOutput } from "../modes/rooms/typing/presence-typing-strip-model";
import { publishTypingCommitted, setTypingPingSender } from "../modes/rooms/typing/typing-bus";

type PendingAttentionPreviewEvent = Extract<
  ServerEvent,
  { type: "approval.ask" | "identity.challenge" | "prove_it.challenge" }
>;
type QueuedPendingAttentionPreview = Readonly<{
  key: string;
  event: PendingAttentionPreviewEvent;
  recovered: boolean;
}>;

function pendingAttentionPreviewKey(event: PendingAttentionPreviewEvent): string {
  if (event.type === "approval.ask") return `approval:${event.approvalId}`;
  if (event.type === "identity.challenge") return `identity:${event.challengeId}`;
  return event.challengeId === undefined
    ? `prove-it-legacy:${event.threadId}:${event.laneKey}`
    : `prove-it:${event.challengeId}`;
}

function isPendingAttentionPreviewEvent(
  event: ServerEvent,
): event is PendingAttentionPreviewEvent {
  return event.type === "approval.ask"
    || event.type === "identity.challenge"
    || event.type === "prove_it.challenge";
}

/** Task/subagent prompts are owner-scoped live UI, not Room checkpoint recovery. */
export function isTaskPendingAttentionPreviewEvent(
  event: ServerEvent,
): event is PendingAttentionPreviewEvent {
  return isPendingAttentionPreviewEvent(event)
    && (event.origin === "task" || event.laneKey.startsWith("task:"));
}

export function pendingAttentionPreviewIngress(
  event: ServerEvent,
  changesActiveRoomPendingAttention: boolean,
): "not-preview" | "direct" | "enqueue" | "drop" {
  if (!isPendingAttentionPreviewEvent(event)) return "not-preview";
  if (isTaskPendingAttentionPreviewEvent(event)) return "direct";
  return changesActiveRoomPendingAttention ? "enqueue" : "drop";
}

export function recoverDesktopRoomPendingAttention(
  desktopForegroundShadow: Pick<DesktopForegroundShadowAPI, "recoverRoomPendingAttention">,
  input: Readonly<{
    roomId: string;
    clientActionSessionId: string;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  }>,
  runWithAdmission: <T>(operation: () => Promise<T>) => Promise<T> = runWithCryptoAdmission,
): Promise<RoomPendingAttentionRecoveryResponse> {
  if (input.signal?.aborted || input.isCurrent?.() === false) {
    return Promise.resolve({ status: "unavailable", events: [] });
  }
  if (desktopForegroundShadow.recoverRoomPendingAttention === undefined) {
    return Promise.resolve({ status: "unavailable", events: [] });
  }
  return runWithAdmission(async () => {
    const result = await desktopForegroundShadow.recoverRoomPendingAttention!({
      roomId: input.roomId,
      clientActionSessionId: input.clientActionSessionId,
    });
    return input.signal?.aborted || input.isCurrent?.() === false
      ? { status: "unavailable" as const, events: [] }
      : result;
  });
}
import { reconcileCanonicalHumanMessage, settleHumanMessageVerification } from "./message-new-reconciliation";
import { projectVerifiedFullHumanEvent, readPendingFullHumanMessage, reconcileVerifiedFullHumanMessage, takePendingFullHumanEvents } from "./full-human-message-reconciliation";
import {
  liveArrivalsSince,
  isLatestRoomHydration,
  mergeHydratedRoomMessages,
  type RoomHydrationRequest,
  type RoomLiveArrival,
} from "./room-hydration-reconciliation";
import {
  createDisconnectCache,
  createLocalStorageBackend,
  type DisconnectCache,
  type DisconnectCacheScope,
} from "../lib/disconnect-cache";
import {
  beginRoomInitialHydration,
  transitionRoomInitialHydration,
  type RoomInitialHydrationScope,
  type RoomInitialHydrationState,
  type RoomInitialHydrationTransition,
} from "./room-initial-hydration";
import {
  createRoomHydrationTiming,
  type RoomHydrationTimingAttempt,
} from "./room-hydration-timing";
import { RECONNECT_RECONCILED_EVENT } from "../components/reconnect-toast";
import {
  readHasEverBeenOpen,
  markHasEverBeenOpen,
} from "../lib/persisted-ws-history";
import { applyMaintenanceStatus } from "../components/maintenance-notice-state";
import { publishEventFeedChanged } from "../event-feed/event-feed-change-bus";
import type { ApprovalReplyVerb, CodexRequestResponse } from "@nautilo/types";

const RUN_SHELL_LIVE_TEXT_MAX_BYTES = 16 * 1024;

type RunShellProgressEvent = Extract<ServerEvent, { type: "tool.run_shell.progress" }>;
type StructuredSshProgressEvent = Extract<ServerEvent, { type: "tool.structured_ssh.progress" }>;
type RunShellContinuity = "connected" | "disconnected" | "outcome_unknown";

type RunShellActivity = ToolActivityEvent & {
  runShellContinuity?: RunShellContinuity;
  runShellContinuityChangedAt?: number;
};

function appendBoundedRunShellText(current: string, next: string): {
  text: string;
  droppedBytes: number;
} {
  const encoder = new TextEncoder();
  const currentBytes = encoder.encode(current);
  const nextBytes = encoder.encode(next);
  const remaining = Math.max(0, RUN_SHELL_LIVE_TEXT_MAX_BYTES - currentBytes.length);
  if (nextBytes.length <= remaining) return { text: current + next, droppedBytes: 0 };
  let accepted = remaining;
  while (accepted > 0 && ((nextBytes[accepted] ?? 0) & 0xc0) === 0x80) accepted -= 1;
  return {
    text: current + new TextDecoder().decode(nextBytes.subarray(0, accepted)),
    droppedBytes: nextBytes.length - accepted,
  };
}

/**
 * Apply one provisional shell frame without weakening the final-result seam.
 * Only an explicitly disconnected observation may resume after an un-replayed
 * byte range. While connected, accepting a gap would manufacture output
 * continuity. Frames behind either the global sequence or this stream's
 * accepted byte offset remain no-ops.
 */
export function applyRunShellProgressEvent(
  activity: ToolActivityEvent,
  event: RunShellProgressEvent,
): ToolActivityEvent | null {
  const shell = activity as RunShellActivity;
  if (
    activity.toolCallId !== event.toolCallId ||
    activity.toolName !== "run_shell" ||
    activity.status !== "running" ||
    shell.runShellContinuity === "outcome_unknown"
  ) {
    return null;
  }
  const prior = activity.runShellProgress ?? {
    stdout: "",
    stderr: "",
    stdoutOffsetBytes: 0,
    stderrOffsetBytes: 0,
    droppedBytes: 0,
    lastSequence: -1,
    phase: "running" as const,
    elapsedMs: 0,
  };
  const offsetKey = event.stream === "stdout" ? "stdoutOffsetBytes" : "stderrOffsetBytes";
  const expectedOffset = prior[offsetKey];
  if (
    event.sequence <= prior.lastSequence ||
    event.offsetBytes < expectedOffset ||
    (shell.runShellContinuity !== "disconnected" && event.offsetBytes !== expectedOffset) ||
    event.endOffsetBytes < event.offsetBytes
  ) {
    return null;
  }
  const currentText = event.stream === "stdout" ? prior.stdout : prior.stderr;
  const appended = appendBoundedRunShellText(currentText, event.text);
  const unobservedGap = event.offsetBytes - expectedOffset;
  const nextProgress = {
    ...prior,
    ...(event.stream === "stdout" ? { stdout: appended.text } : { stderr: appended.text }),
    [offsetKey]: event.endOffsetBytes,
    droppedBytes:
      prior.droppedBytes +
      unobservedGap +
      (event.droppedBytes ?? 0) +
      appended.droppedBytes,
    lastSequence: event.sequence,
    phase: event.phase,
    elapsedMs: event.elapsedMs,
  };
  return {
    ...activity,
    runShellProgress: nextProgress,
    runShellContinuity: "connected",
    runShellContinuityChangedAt: undefined,
  } as ToolActivityEvent;
}

function isStructuredSshProgressForActivity(
  activity: ToolActivityEvent,
  event: StructuredSshProgressEvent,
): boolean {
  if (activity.toolCallId !== event.toolCallId || activity.status !== "running") return false;
  return (event.operation === "exec" && event.kind === "exec-output" && activity.toolName === "structured_ssh_exec") ||
    (event.operation === "copy-upload" && event.kind === "transfer" && activity.toolName === "structured_ssh_copy_upload") ||
    (event.operation === "copy-download" && event.kind === "transfer" && activity.toolName === "structured_ssh_copy_download");
}

function isSafeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * D500 v15 accepts only exact, ordered observations for the active structured
 * SSH call. This is display state, never execution authority: a missing or
 * malformed frame is ignored and the final tool.end remains the sole outcome.
 */
export function applyStructuredSshProgressEvent(
  activity: ToolActivityEvent,
  event: StructuredSshProgressEvent,
): ToolActivityEvent | null {
  if (
    !isStructuredSshProgressForActivity(activity, event) ||
    !isSafeNonnegativeInteger(event.sequence) ||
    !isSafeNonnegativeInteger(event.elapsedMs)
  ) return null;

  const prior = activity.structuredSshProgress;
  // Unlike raw run_shell, this contract has no disconnected-gap recovery.
  // Every accepted observation must be the next exact sequence number.
  if (event.sequence !== (prior?.lastSequence ?? -1) + 1) return null;

  if (event.kind === "exec-output") {
    const previous = prior?.operation === "exec" ? prior : {
      operation: "exec" as const,
      stdout: "",
      stderr: "",
      stdoutOffsetBytes: 0,
      stderrOffsetBytes: 0,
      droppedBytes: 0,
      lastSequence: -1,
      phase: "running" as const,
      elapsedMs: 0,
    };
    const offsetKey = event.stream === "stdout" ? "stdoutOffsetBytes" : "stderrOffsetBytes";
    const textKey = event.stream === "stdout" ? "stdout" : "stderr";
    const droppedBytes = event.droppedBytes ?? 0;
    const textBytes = new TextEncoder().encode(event.text).byteLength;
    if (
      !isSafeNonnegativeInteger(event.offsetBytes) ||
      !isSafeNonnegativeInteger(event.endOffsetBytes) ||
      !isSafeNonnegativeInteger(droppedBytes) ||
      event.offsetBytes !== previous[offsetKey] ||
      event.endOffsetBytes !== event.offsetBytes + textBytes + droppedBytes
    ) return null;
    const appended = appendBoundedRunShellText(previous[textKey], event.text);
    return {
      ...activity,
      structuredSshProgress: {
        ...previous,
        [textKey]: appended.text,
        [offsetKey]: event.endOffsetBytes,
        droppedBytes: previous.droppedBytes + droppedBytes + appended.droppedBytes,
        lastSequence: event.sequence,
        elapsedMs: event.elapsedMs,
      },
    };
  }

  const previous = prior?.operation === event.operation ? prior : undefined;
  if (
    previous === undefined &&
    (event.phase !== "starting" || event.transferredBytes !== 0)
  ) return null;
  // A transfer start establishes its one stable baseline. A later `starting`
  // frame would reset the visible phase, even if its bytes were monotonic.
  if (previous !== undefined && event.phase === "starting") return null;
  const baseline = previous ?? {
    operation: event.operation,
    transferredBytes: 0,
    lastSequence: -1,
    phase: "starting" as const,
    elapsedMs: 0,
  };
  if (
    !isSafeNonnegativeInteger(event.transferredBytes) ||
    (event.totalBytes !== undefined && !isSafeNonnegativeInteger(event.totalBytes)) ||
    event.transferredBytes < baseline.transferredBytes ||
    (event.totalBytes !== undefined && baseline.totalBytes !== undefined && event.totalBytes !== baseline.totalBytes) ||
    (event.totalBytes !== undefined && event.transferredBytes > event.totalBytes)
  ) return null;
  const totalBytes = event.totalBytes ?? baseline.totalBytes;
  if (totalBytes !== undefined && event.transferredBytes > totalBytes) return null;
  return {
    ...activity,
    structuredSshProgress: {
      operation: event.operation,
      transferredBytes: event.transferredBytes,
      ...(totalBytes !== undefined ? { totalBytes } : {}),
      lastSequence: event.sequence,
      phase: event.phase,
      elapsedMs: event.elapsedMs,
    },
  };
}

function setRunShellContinuity(
  activity: ToolActivityEvent,
  continuity: Exclude<RunShellContinuity, "connected">,
  changedAt: number,
): ToolActivityEvent {
  const shell = activity as RunShellActivity;
  if (
    activity.toolName !== "run_shell" ||
    activity.status !== "running" ||
    shell.runShellContinuity === "outcome_unknown"
  ) {
    return activity;
  }
  if (shell.runShellContinuity === continuity) return activity;
  return {
    ...activity,
    runShellContinuity: continuity,
    runShellContinuityChangedAt: changedAt,
  } as ToolActivityEvent;
}

/** Freeze one exact dispatched shell at its last observed evidence. */
export function markRunShellOutcomeUnknown(
  activity: ToolActivityEvent,
  changedAt: number,
): ToolActivityEvent {
  return setRunShellContinuity(activity, "outcome_unknown", changedAt);
}

export function markRunShellActivitiesDisconnected(
  activities: ToolActivityEvent[],
  disconnectedAt: number,
): ToolActivityEvent[] {
  let changed = false;
  const next = activities.map((activity) => {
    const updated = setRunShellContinuity(
      activity,
      "disconnected",
      disconnectedAt,
    );
    if (updated !== activity) changed = true;
    return updated;
  });
  return changed ? next : activities;
}

/** A late private failure can annotate only the still-running exact tool. */
export function applyConnectedWebActionResumeFailureToActivity(
  current: ToolActivityEvent | undefined,
  failed: ConnectedWebActionResumeFailed,
): ToolActivityEvent | undefined {
  if (!current || current.toolName !== "act_connected_web_account"
    || current.status !== "running" || current.laneKey !== failed.laneKey) return current;
  return {
    ...current,
    connectedWebActionAttention: undefined,
    connectedWebActionResumeFailed: failed,
  };
}

// M087 — auto-detected IANA timezone, re-resolved when the tab becomes
// visible again (a user who changed tz while backgrounded gets picked up).
let detectedTimezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      try {
        detectedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || detectedTimezone;
      } catch {
        /* keep prior value */
      }
    }
  });
}


/** Legacy lane label — product-level chat selection is `roomId` (D106); laneKey remains for server compatibility. */
const LANE_KEY = "app:default";
const VISIBLE_OUTPUT_QUIET_MS = 900;

/**
 * Consumer-side authority check for D530's initial history projection.
 * A stale context object is indistinguishable from no history at all: it must
 * not reveal a different Room's cached transcript or admit a composer send.
 */
export function roomInitialHistoryAdmission(input: {
  readonly state: RoomInitialHydrationState | null;
  readonly origin: string;
  readonly viewerKey: string | null;
  readonly viewerGeneration: number;
  readonly roomId: string | null;
}): { readonly displayTranscript: boolean; readonly sendAuthorized: boolean } {
  const state = input.state;
  if (
    !state ||
    !input.viewerKey ||
    state.scope.origin !== input.origin ||
    state.scope.viewerKey !== input.viewerKey ||
    state.scope.viewerGeneration !== input.viewerGeneration ||
    state.scope.roomId !== input.roomId
  ) {
    return { displayTranscript: false, sendAuthorized: false };
  }
  switch (state.kind) {
    case "syncing":
      return { displayTranscript: true, sendAuthorized: false };
    case "waiting-for-authority":
      return { displayTranscript: true, sendAuthorized: state.sendAuthorized };
    case "ready":
    case "empty":
      return { displayTranscript: true, sendAuthorized: true };
    case "recoverable-error":
      return { displayTranscript: state.retainsCachedFrame, sendAuthorized: false };
    case "unresolved":
    case "access-terminal-error":
      return { displayTranscript: false, sendAuthorized: false };
  }
}

/** Classifies only the terminal projection; token bootstrap is deliberately non-terminal. */
export function initialHistoryServerDisposition(input: {
  readonly status: "no-token" | "ok" | "empty" | "unauthorized" | "not-found" | "failed";
  readonly failureClass?: "key_waiting";
  readonly containsUnavailableHistory?: boolean;
  readonly reconciledMessageCount?: number;
}): "pending" | "ready" | "empty" | "waiting-for-authority" | "access-terminal-error" | "recoverable-error" {
  if (input.status === "no-token") return "pending";
  if (input.status === "ok") {
    return input.containsUnavailableHistory === true ? "waiting-for-authority" : "ready";
  }
  if (input.status === "empty") {
    return (input.reconciledMessageCount ?? 0) > 0 ? "ready" : "empty";
  }
  if (input.status === "unauthorized" || input.status === "not-found") {
    return "access-terminal-error";
  }
  if (input.failureClass === "key_waiting") return "waiting-for-authority";
  return "recoverable-error";
}

export function roomHistoryContainsUnavailableMessage(
  messages: readonly ThreadMessageLike[],
): boolean {
  return messages.some((message) =>
    message.metadata?.custom?.historyUnavailable === true
  );
}

export function roomHistoryWaitsOnlyForKeys(
  messages: readonly ThreadMessageLike[],
): boolean {
  const unavailable = messages.filter((message) =>
    message.metadata?.custom?.historyUnavailable === true
  );
  return unavailable.length > 0 && unavailable.every((message) =>
    message.metadata?.custom?.historyUnavailableReason === "key_waiting"
  );
}

/** A verified Domain delivery is a latency hint for the exact active Room.
 * Re-read only an unresolved authority projection; normal ready transcripts
 * do not incur a history request for unrelated key maintenance. */
export function mountedKeyWaitingHistorySelection(
  roomId: string | null,
  messages: readonly ThreadMessageLike[],
): MessageBackfillUrgentSelection | null {
  return mountedKeyWaitingHistorySelections(roomId, messages)[0] ?? null;
}

export function mountedKeyWaitingHistorySelections(
  roomId: string | null,
  messages: readonly ThreadMessageLike[],
): readonly MessageBackfillUrgentSelection[] {
  if (roomId === null) return [];
  return messages.flatMap((message) => {
    if (message.metadata?.custom?.historyUnavailable !== true
      || message.metadata.custom.historyUnavailableReason !== "key_waiting") return [];
    const messageId = Number(message.id);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return [];
    const revision = message.metadata.custom.editRevision;
    return [{
      roomId,
      messageId,
      revision: typeof revision === "number" && Number.isSafeInteger(revision)
        && revision >= 0 ? revision : 0,
    }];
  });
}

export async function refreshMountedKeyWaitingHistorySnapshot(input: Readonly<{
  selections: readonly MessageBackfillUrgentSelection[];
  isCurrent(): boolean;
  refresh(selection: MessageBackfillUrgentSelection): Promise<PrioritizedHistoryRefreshResult>;
  onRetry?(selection: MessageBackfillUrgentSelection): void;
}>): Promise<"completed" | "cancelled" | "retry" | "ignored"> {
  for (const selection of input.selections) {
    if (!input.isCurrent()) return "cancelled";
    const outcome = await input.refresh(selection);
    if (!input.isCurrent()) return "cancelled";
    if (outcome === "retry") {
      input.onRetry?.(selection);
      return outcome;
    }
    if (outcome === "ignored") return outcome;
  }
  return "completed";
}

export function shouldRefreshInitialHistoryAfterDomainDelivery(input: Readonly<{
  eventRoomId: string;
  activeRoomId: string | null;
  hydrationState: RoomInitialHydrationState | null;
}>): boolean {
  if (input.activeRoomId === null || input.eventRoomId !== input.activeRoomId) return false;
  return input.hydrationState?.scope.roomId === input.activeRoomId
    && input.hydrationState.kind === "waiting-for-authority"
    && !input.hydrationState.sendAuthorized;
}

export function canAcknowledgeInitialHistoryTranscriptCommit(input: {
  readonly activeScope: RoomInitialHydrationScope | null;
  readonly pendingScope: RoomInitialHydrationScope;
  readonly projectedMessageIds: readonly string[];
  readonly renderedMessageIds: readonly string[];
}): boolean {
  return input.activeScope === input.pendingScope &&
    input.projectedMessageIds.length === input.renderedMessageIds.length &&
    input.projectedMessageIds.every((id, index) => id === input.renderedMessageIds[index]);
}

/** A member-refresh may never replace a stream that began after its fetch. */
export function shouldDeferBackgroundHistoryProjection(input: {
  readonly backgroundRefresh: boolean;
  readonly hasActiveStream: boolean;
  readonly isRunning: boolean;
  readonly resultStatus: "ok" | "empty" | "failed" | "unauthorized" | "not-found";
}): boolean {
  if (!input.backgroundRefresh) return false;
  // Access terminal outcomes are privacy boundaries and must still clear a
  // frame immediately; ordinary successful/empty snapshots can wait.
  if (input.resultStatus === "unauthorized" || input.resultStatus === "not-found") {
    return false;
  }
  return (input.resultStatus === "ok" || input.resultStatus === "empty") &&
    (input.hasActiveStream || input.isRunning);
}

export function createDomainKeyRecipientSyncScheduler(input: Readonly<{
  service(roomId: string, namespaceId: string, keyClass: "human" | "ai"): Promise<boolean>;
  onReady?(displayRoomId: string): void;
  schedule(run: () => void): () => void;
}>) {
  const pending = new Map<string, Readonly<{
    sourceRoomId: string;
    namespaceId: string;
  }>>();
  let cancelScheduled: (() => void) | null = null;
  let running = false;
  let disposed = false;
  const schedule = (): void => {
    if (disposed || running || cancelScheduled !== null || pending.size === 0
      || !isCryptoAdmissionAllowed()) return;
    cancelScheduled = input.schedule(() => {
      cancelScheduled = null;
      if (disposed || !isCryptoAdmissionAllowed()) return;
      running = true;
      const attempts = [...pending].map(async ([displayRoomId, coordinate]) => {
        const results = await Promise.allSettled((["human", "ai"] as const).map(
          async (keyClass) => input.service(
            coordinate.sourceRoomId,
            coordinate.namespaceId,
            keyClass,
          ),
        ));
        if (results.every((result) => result.status === "fulfilled" && result.value)
          && pending.get(displayRoomId) === coordinate) {
          pending.delete(displayRoomId);
          input.onReady?.(displayRoomId);
        }
      });
      void Promise.all(attempts).finally(() => {
        running = false;
        schedule();
      });
    });
  };
  const unsubscribe = subscribeCryptoAdmissionAccess(schedule);
  return Object.freeze({
    enqueue(
      displayRoomId: string,
      namespaceId: string,
      sourceRoomId: string = displayRoomId,
    ): void {
      if (!pending.has(displayRoomId) && pending.size >= 64) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      pending.set(displayRoomId, Object.freeze({ sourceRoomId, namespaceId }));
      schedule();
    },
    dispose(): void {
      disposed = true;
      cancelScheduled?.();
      cancelScheduled = null;
      pending.clear();
      unsubscribe();
    },
  });
}

export function protectedHistoryRecipientSyncCoordinate(
  displayRoomId: string,
  detail: Pick<
    RoomDetailResponse,
    "id" | "kind" | "parentRoomId" | "namespaceId"
  >,
): Readonly<{
  displayRoomId: string;
  sourceRoomId: string;
  namespaceId: string;
}> | null {
  if (
    detail.id !== displayRoomId
    || typeof detail.namespaceId !== "string"
    || detail.namespaceId.length === 0
  ) return null;
  if (isProtectedTopLevelRoomKind(detail.kind)) {
    return detail.parentRoomId == null
      ? Object.freeze({
          displayRoomId,
          sourceRoomId: displayRoomId,
          namespaceId: detail.namespaceId,
        })
      : null;
  }
  if (
    detail.kind !== "subthread"
    || typeof detail.parentRoomId !== "string"
    || detail.parentRoomId.length === 0
  ) return null;
  return Object.freeze({
    displayRoomId,
    sourceRoomId: detail.parentRoomId,
    namespaceId: detail.namespaceId,
  });
}

export function shouldDemandProtectedHistoryAuthority(input: Readonly<{
  admissionReady: boolean;
  wsState: WsState;
  isRunning: boolean;
  activeStreamCount: number;
  activeRoomId: string | null;
  hydrationState: RoomInitialHydrationState | null;
}>): boolean {
  return input.admissionReady
    && input.wsState === "open"
    && !input.isRunning
    && input.activeStreamCount === 0
    && input.activeRoomId !== null
    && input.hydrationState?.kind === "waiting-for-authority"
    && input.hydrationState.scope.roomId === input.activeRoomId;
}

export function canCommitProtectedHistoryAuthorityDemand(input: Readonly<{
  admissionCurrent: boolean;
  requestedDisplayRoomId: string;
  activeRoomId: string | null;
  requestedViewerKey: string;
  currentViewerKey: string | null;
  requestedViewerGeneration: number;
  currentViewerGeneration: number;
  requestedOrigin: string;
  currentOrigin: string;
}>): boolean {
  return input.admissionCurrent
    && input.activeRoomId === input.requestedDisplayRoomId
    && input.currentViewerKey === input.requestedViewerKey
    && input.currentViewerGeneration === input.requestedViewerGeneration
    && input.currentOrigin === input.requestedOrigin;
}

export function replayableProtectedHistoryAuthorityDemand(input: Readonly<{
  observedRoomId: string | null;
  activeRoomId: string | null;
  recipientSyncReady: boolean;
}>): string | null {
  return input.recipientSyncReady
    && input.observedRoomId !== null
    && input.observedRoomId === input.activeRoomId
    ? input.observedRoomId
    : null;
}

/** Narrow admission for the durable native user-input recovery read. */
export function canStartCodexRequestHydration(input: {
  readonly authState: string;
  readonly viewerKey: string | null;
  readonly roomId: string | null;
  readonly wsState: WsState;
}): boolean {
  return input.authState === "signed-in" &&
    input.viewerKey !== null &&
    input.roomId !== null &&
    input.wsState === "open";
}

/** Exact active-Room events that can arm, replace, consume, or settle approval. */
export function changesPendingAttention(
  event: ServerEvent,
  current: Readonly<{
    roomId: string | null;
    userId: string | null;
    laneKeyToRoomId: ReadonlyMap<string, string>;
    jobIdToRoomId: ReadonlyMap<string, string>;
  }>,
): boolean {
  if (current.roomId === null || current.userId === null) return false;
  if (event.type === "approval.ask"
    || event.type === "prove_it.challenge"
    || event.type === "identity.challenge") {
    return event.userId === current.userId
      && roomIdFromLaneKey(event.laneKey, current.laneKeyToRoomId) === current.roomId;
  }
  if (event.type === "approval.resolved") {
    return event.userId === current.userId
      && roomIdFromLaneKey(
        event.laneKey ?? event.threadId,
        current.laneKeyToRoomId,
      ) === current.roomId;
  }
  if (event.type !== "job.status"
    || (event.status !== "completed" && event.status !== "failed"
      && event.status !== "cancelled" && event.status !== "timed_out")) return false;
  return (current.jobIdToRoomId.get(event.jobId)
    ?? (event.laneKey === undefined
      ? null
      : roomIdFromLaneKey(event.laneKey, current.laneKeyToRoomId))) === current.roomId;
}

export function isPendingAttentionSubmissionCurrent(input: Readonly<{
  capturedKey: string | null;
  capturedRoomId: string | null;
  capturedViewerGeneration: number;
  capturedScopeGeneration: number;
  currentKey: string | null;
  currentRoomId: string | null;
  currentViewerGeneration: number;
  currentScopeGeneration: number;
}>): boolean {
  return input.capturedKey !== null
    && input.capturedKey === input.currentKey
    && input.capturedRoomId === input.currentRoomId
    && input.capturedViewerGeneration === input.currentViewerGeneration
    && input.capturedScopeGeneration === input.currentScopeGeneration;
}

/** Recovered previews always require a fresh Human click, even in Auto-Approve. */
export function shouldAutoResolvePendingAttentionAsk(input: Readonly<{
  recovered: boolean;
  enabled: boolean;
  hasNetworkContext: boolean;
  requiresExplicitReview: boolean;
  structuredSshHostTrust?: "trusted" | "unknown" | "changed";
}>): boolean {
  return !input.recovered && shouldAutoResolveAsk({
    enabled: input.enabled,
    hasNetworkContext: input.hasNetworkContext,
    requiresExplicitReview: input.requiresExplicitReview,
    structuredSshHostTrust: input.structuredSshHostTrust,
  });
}

/** Recovery starts only after the authenticated Room transcript is current. */
export function canStartRoomPendingAttentionRecovery(input: Readonly<{
  authState: string;
  viewerKey: string | null;
  humanActorId: string | null;
  viewerGeneration: number;
  origin: string;
  roomId: string | null;
  wsState: WsState;
  clientActionSessionId?: string;
  authorizationDeviceId: string | null;
  history: RoomInitialHydrationState | null;
}>): boolean {
  return input.authState === "signed-in"
    && input.viewerKey !== null
    && input.humanActorId !== null
    && input.roomId !== null
    && input.wsState === "open"
    && input.clientActionSessionId !== undefined
    && input.authorizationDeviceId !== null
    && input.history !== null
    && (input.history.kind === "ready" || input.history.kind === "empty")
    && input.history.scope.origin === input.origin
    && input.history.scope.viewerKey === input.viewerKey
    && input.history.scope.viewerGeneration === input.viewerGeneration
    && input.history.scope.roomId === input.roomId;
}

/**
 * A GET may only replace the durable user-input slice if it still belongs to
 * the same authenticated viewer, visible Room, and active fetch generation.
 * Any failed fence preserves newer local/WS state unchanged.
 */
export interface CodexRequestHydrationFence {
  readonly generation: number;
  readonly viewerKey: string;
  readonly roomId: string;
  readonly liveSequenceAtStart: number;
  readonly arrivals: ReadonlyArray<unknown>;
  readonly overflowed: boolean;
}

export function canCommitCodexRequestHydration(input: {
  readonly cancelled: boolean;
  readonly hydration: CodexRequestHydrationFence;
  readonly activeHydration: CodexRequestHydrationFence | null;
  readonly viewerKey: string | null;
  readonly activeRoomId: string | null;
  readonly wsState: WsState;
  readonly responseRoomId: string;
}): boolean {
  return !input.cancelled &&
    input.activeHydration === input.hydration &&
    input.viewerKey === input.hydration.viewerKey &&
    input.activeRoomId === input.hydration.roomId &&
    input.wsState === "open" &&
    input.responseRoomId === input.hydration.roomId &&
    !input.hydration.overflowed;
}

/**
 * Refresh Electron's cached server auth configuration once the realtime
 * connection becomes available. This is intentionally independent of session
 * tokens: `auth:reprobe-server` only refreshes main-process Logto metadata.
 */
export async function reprobeDesktopServerOnReconnect(
  previous: WsState,
  next: WsState,
  desktop: { auth?: { reprobeServer?: () => Promise<unknown> } } | null,
): Promise<void> {
  if (previous === "open" || next !== "open") return;
  try {
    await desktop?.auth?.reprobeServer?.();
  } catch {
    // Realtime recovery must not be interrupted when an older preload or a
    // transient main-process IPC failure cannot service the optional reprobe.
  }
}

/** D264 — categorical reason → status copy (catalog model IDs only). */
const MODEL_FALLBACK_REASON_VERB: Record<ModelFallbackEvent["reason"], string> = {
  timeout: "timed out",
  rate_limit: "was rate-limited",
  auth: "couldn't authenticate",
  bad_request: "rejected the request",
  context_exceeded: "ran out of context",
  provider_unavailable: "was unavailable",
  unknown: "failed",
};

/**
 * D264 — plain status line for runtime UI (not assistant markdown).
 * Privacy posture: only catalog `from` / `to` IDs + categorical `reason`.
 */
export function formatModelFallbackStatusLine(
  from: string,
  to: string,
  reason: ModelFallbackEvent["reason"],
): string {
  const verb = MODEL_FALLBACK_REASON_VERB[reason] ?? "failed";
  return `${from} ${verb} — trying ${to}`;
}

export type ModelFallbackStatusSnapshot = {
  from: string;
  to: string;
  reason: ModelFallbackEvent["reason"];
  line: string;
  turnId: string;
};

export function modelFallbackStatusFromEvent(
  event: Pick<ModelFallbackEvent, "from" | "to" | "reason" | "turnId">,
): ModelFallbackStatusSnapshot {
  return {
    from: event.from,
    to: event.to,
    reason: event.reason,
    turnId: event.turnId,
    line: formatModelFallbackStatusLine(event.from, event.to, event.reason),
  };
}

/**
 * D264 — documents the assistant-stream contract for unit tests: fallback
 * telemetry must not seed/append stream accumulators or assistant messages.
 */
export function modelFallbackAssistantStreamEffects(input: {
  streams: ReadonlyMap<string, StreamState>;
  event: Pick<ModelFallbackEvent, "from" | "to" | "reason" | "turnId">;
}): {
  streams: ReadonlyMap<string, StreamState>;
  createsAssistantMessage: false;
  updatesLastAssistant: false;
  status: ModelFallbackStatusSnapshot;
} {
  return {
    streams: input.streams,
    createsAssistantMessage: false,
    updatesLastAssistant: false,
    status: modelFallbackStatusFromEvent(input.event),
  };
}

// D323 — backstop lifetime for the fallback pill. The notice is SET on
// `model.fallback` and historically had no timer and no dismiss affordance,
// so any turn whose terminal clear didn't reach the active room left it
// stranded until the next turn. Room-scoping the SET (see ws-event-room.ts)
// removes the proven cross-room misfire; the auto-dismiss timer plus the
// pill's own click handler (ModelFallbackStatusNotice) are the belt-and-
// suspenders that make it self-clear and be dismissable regardless of which
// terminal event arrives.
//
// Sized as a BACKSTOP, deliberately above the per-hop first-token budget
// (`MODEL_STREAM_FIRST_TOKEN_TIMEOUT_MS = 60s`, chat-model-invocation.ts): a
// fallback hop can legitimately take ~60s before the next model produces
// output, so a shorter timer would hide the "trying Y" pill while Y is still
// working. In the normal case the real turn-end clears (message.tokens done /
// terminal job.status) fire first; this timer only triggers in the rare
// filtered-clear case, and manual dismiss covers impatience.
const MODEL_FALLBACK_NOTICE_TTL_MS = 90_000;

const WS_ROUTE_MAP_CAP = 64;

function publishConductorFocusChanged(
  event: Extract<ServerEvent, { type: "conductor.focus_changed" }>,
): void {
  window.dispatchEvent(
    new CustomEvent("nautilo:conductor-focus-changed", {
      detail: {
        roomId: event.roomId,
        userActorId: event.userActorId,
        change: event.change,
        botActorId: event.botActorId,
        source: event.source,
        reason: event.reason,
      },
    }),
  );
}

function trimBoundedStringMap(
  map: Map<string, string>,
  preserve?: ReadonlySet<string>,
): void {
  if (map.size <= WS_ROUTE_MAP_CAP) return;
  // D353 — evict oldest-first, but skip keys in `preserve` (live job ids).
  // `jobIdToRoomId` is bounded while `liveJobIdsRef` is not, so blind FIFO
  // eviction can drop a still-live job's room mapping; its later terminal
  // `job.status` then fails to route and the job is never retired (ghost
  // `isRunning`). Preserving live ids keeps that retirement path intact.
  // (The `ws-event-room` laneKey fallback is the other half of this belt.)
  // If every over-cap key is preserved we tolerate a brief overflow rather
  // than evicting a live mapping — the live set is small in practice.
  for (const key of [...map.keys()]) {
    if (map.size <= WS_ROUTE_MAP_CAP) break;
    if (preserve?.has(key)) continue;
    map.delete(key);
  }
}

function trimBoundedStringSet(set: Set<string>, cap = WS_ROUTE_MAP_CAP): void {
  while (set.size > cap) {
    const first = set.values().next().value;
    if (first === undefined) break;
    set.delete(first);
  }
}

function buildAttachmentBubbleSummary(
  queuedAttachments: readonly ComposerAttachment[],
  statuses: readonly ChatAttachmentStatus[],
): string {
  if (statuses.length === 0) {
    return queuedAttachments.map((a) => a.name).join(", ");
  }
  const byId = new Map(statuses.map((status) => [status.id, status]));
  return queuedAttachments
    .map((att) => {
      // D271: server statuses are keyed by the server attachmentId, while
      // the chip key is a local optimistic id. Fall back to the local id so
      // legacy/error paths still render.
      const status = (att.attachmentId ? byId.get(att.attachmentId) : undefined) ?? byId.get(att.id);
      if (!status) return null;
      const prefix =
        status.decision === "accept"
          ? "ok"
          : status.decision === "stub"
            ? "stub"
            : status.decision === "blocked"
              ? "blocked"
              : "rejected";
      return `${att.name} (${prefix})`;
    })
    .filter((value): value is string => value !== null)
    .join(", ");
}

export function buildUserBubbleText(input: {
  text: string;
  queuedAttachments: readonly ComposerAttachment[];
  attachmentStatuses?: readonly ChatAttachmentStatus[];
}): string {
  if (input.queuedAttachments.length === 0) {
    return input.text;
  }
  const summary = buildAttachmentBubbleSummary(
    input.queuedAttachments,
    input.attachmentStatuses ?? [],
  );
  const preface = `📎 Attached: ${summary}`;
  return input.text.trim().length > 0 ? `${preface}\n\n${input.text}` : preface;
}

type MessageCustomMetadata = Record<string, unknown>;

function messageMetadata(
  message: ThreadMessageLike,
): { custom?: MessageCustomMetadata } & Record<string, unknown> {
  return (message.metadata ?? {}) as { custom?: MessageCustomMetadata } & Record<string, unknown>;
}

export function reconcileOptimisticMessageId(
  messages: readonly ThreadMessageLike[],
  localId: string,
  realId: string,
): readonly ThreadMessageLike[] {
  if (localId === realId) return messages;
  const idx = messages.findIndex((m) => m.id === localId);
  if (idx < 0) return messages;
  // A WS echo may have appended the canonical message before this response
  // reconciles the local id. Remove the now-redundant optimistic bubble rather
  // than preserving two renders of the same persisted row.
  if (messages.some((m) => m.id === realId)) {
    return messages.filter((m) => m.id !== localId);
  }
  const prev = messages[idx];
  return [
    ...messages.slice(0, idx),
    { ...prev, id: realId } as ThreadMessageLike,
    ...messages.slice(idx + 1),
  ];
}

export function updateMessageTextInList(
  messages: readonly ThreadMessageLike[],
  id: string,
  text: string,
): readonly ThreadMessageLike[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return messages;
  const prev = messages[idx];
  return [
    ...messages.slice(0, idx),
    { ...prev, content: [{ type: "text" as const, text }] },
    ...messages.slice(idx + 1),
  ];
}

export function applyMessageUpdatedInList(
  messages: readonly ThreadMessageLike[],
  event: Extract<ServerEvent, { type: "message.updated" }>,
): readonly ThreadMessageLike[] {
  if (isProtectedMessageRealtimeEventV2(event)) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const custom = messageMetadata(message).custom ?? {};
    const currentRevision =
      typeof custom.editRevision === "number" ? custom.editRevision : 0;
    if (
      custom.logicalMessageKey !== event.logicalMessageKey ||
      event.editRevision <= currentRevision
    ) {
      return message;
    }
    changed = true;
    const metadata = messageMetadata(message);
    return {
      ...message,
      content: [{ type: "text" as const, text: event.content }],
      metadata: {
        ...metadata,
        custom: {
          ...custom,
          editedAt: event.editedAt,
          editRevision: event.editRevision,
        },
      },
    } as ThreadMessageLike;
  });
  return changed ? next : messages;
}

export function markMessageSendFailedInList(
  messages: readonly ThreadMessageLike[],
  id: string,
  reason?: string,
): readonly ThreadMessageLike[] {
  const idx = messages.findIndex((m) => m.id === id);
  if (idx < 0) return messages;
  const prev = messages[idx];
  const meta = messageMetadata(prev);
  const custom = meta.custom ?? {};
  if (custom.sendFailed === true && custom.sendFailureReason === reason) {
    return messages;
  }
  return [
    ...messages.slice(0, idx),
    {
      ...prev,
      metadata: {
        ...meta,
        custom: {
          ...custom,
          sendFailed: true,
          ...(reason ? { sendFailureReason: reason } : {}),
        },
      },
    } as ThreadMessageLike,
    ...messages.slice(idx + 1),
  ];
}

/**
 * Resolve the only room an outbound send may target.
 *
 * `undefined` means a room is selected but its transcript has not yet been
 * grounded to that same room, so sending must be rejected. `null` is the
 * legacy non-room chat path.
 */
export function resolveBoundRoomIdForSend(
  activeRoomId: string | null,
  hydratedRoomId: string | null | undefined,
  routeRoomId: string | null | undefined,
): string | null | undefined {
  const intendedRoomId = activeRoomId ?? routeRoomId;
  if (!intendedRoomId) return null;
  return hydratedRoomId === intendedRoomId ? intendedRoomId : undefined;
}

/**
 * The two renderer-owned Ready-to-work components deliberately remain owned
 * by their existing Workbench controls. This adapter only translates the
 * narrow Desktop request into those controls and returns their observed
 * result; it never receives a PIN, receipt, identity, or approval authority.
 */
export interface ReadyToWorkRendererOwnerPort {
  readVoice(): boolean;
  setVoice(enabled: boolean): void;
  primeVoice?(): Promise<void>;
  readAutoApprove(): boolean;
  setAutoApprove(enabled: boolean): void;
}

export interface ReadyToWorkRendererOwnerAdapter {
  /** Reports manual owner drift without requesting another restoration. */
  reportIfChanged(): void;
  dispose(): void;
}

/** Both renderer owners are canonical only after the exact Human is verified. */
export function canInstallReadyToWorkRendererOwnerAdapter(
  readyToWork: DesktopReadyToWorkAPI | undefined,
  autoApproveViewerId: string | null,
): readyToWork is DesktopReadyToWorkAPI {
  return readyToWork !== undefined && autoApproveViewerId !== null;
}

function readReadyToWorkRendererOwners(
  owners: ReadyToWorkRendererOwnerPort,
): { voice: boolean; autoApprove: boolean } {
  // A renderer owner that cannot be observed must fail closed in the aggregate.
  let voice = false;
  let autoApprove = false;
  try { voice = Boolean(owners.readVoice()); } catch { /* fail closed */ }
  try { autoApprove = Boolean(owners.readAutoApprove()); } catch { /* fail closed */ }
  return { voice, autoApprove };
}

/**
 * Installs the one renderer-owner listener before asking Desktop to restore.
 * `restore` is intentionally a one-shot caller choice so React's development
 * effect replay does not make a second startup attempt.
 */
export function createReadyToWorkRendererOwnerAdapter(
  readyToWork: DesktopReadyToWorkAPI,
  owners: ReadyToWorkRendererOwnerPort,
  options: { restore?: boolean } = {},
): ReadyToWorkRendererOwnerAdapter {
  let disposed = false;
  let lastReported = readReadyToWorkRendererOwners(owners);

  const unsubscribe = readyToWork.onRestoreRendererOwners((request) => {
    if (disposed) return;

    if (request.voice !== null) {
      try {
        owners.setVoice(request.voice);
        // Reuse VoicePlayer's guarded priming path. This cannot manufacture a
        // user gesture; it only lets browsers that permit it resume playback.
        if (request.voice && owners.readVoice()) {
          void owners.primeVoice?.().catch(() => undefined);
        }
      } catch {
        // The acknowledgement below reports the observed fail-closed result.
      }
    }
    if (request.autoApprove !== null) {
      try {
        owners.setAutoApprove(request.autoApprove);
      } catch {
        // The approval owner remains authoritative and may reject the change.
      }
    }

    const actual = readReadyToWorkRendererOwners(owners);
    lastReported = actual;
    void readyToWork.acknowledgeRendererOwners({ attemptId: request.attemptId, ...actual })
      .catch(() => undefined);
  });

  // Register first: Desktop may already have emitted its startup event before
  // Workbench mounted, and this replay is the single recovery seam.
  if (options.restore !== false) {
    void readyToWork.restore().catch(() => undefined);
  }

  return {
    reportIfChanged() {
      if (disposed) return;
      const current = readReadyToWorkRendererOwners(owners);
      if (current.voice === lastReported.voice && current.autoApprove === lastReported.autoApprove) {
        return;
      }
      lastReported = current;
      void readyToWork.reportRendererOwners(current).catch(() => undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}

/**
 * Nautilo runtime provider — connects assistant-ui to the Nautilo backend.
 *
 * Uses the shared realtime-client pattern:
 * 1. POST /api/chat with { message, laneKey } → { jobId }
 * 2. WebSocket /ws delivers ServerEvents (message.tokens, tool.start/end, job.status)
 * 3. useExternalStoreRuntime renders whatever is in the messagesRef
 *
 * The messagesRef pattern avoids the React state race where
 * useExternalStoreRuntime's internal setMessages overwrites what the
 * WS handler just wrote. The ref is source of truth; we setState to
 * trigger re-renders.
 */
export function NautiloRuntimeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // M072 — Logto-only: AuthGate gates to `signed-in` before this provider
  // mounts for normal routes; bearer comes from `auth.session.getAccessToken()`.
  const auth = useAuth();
  const setupStatus = useSetupStatus();
  const can = useCan();
  const canInvokeAgents = can("invoke_agents");
  const navigate = useNavigate();
  const [shadowPolicyMode, setShadowPolicyMode] = useState<
    LiveShadowEncryptionTransitionMode | "unknown"
  >("unknown");
  const shadowPolicyModeRef = useRef(shadowPolicyMode);
  const [admissionReady, setAdmissionReady] = useState(isCryptoAdmissionAllowed);
  const [admissionResumeGeneration, setAdmissionResumeGeneration] = useState(0);
  const wsRef = useRef<RealtimeClient | null>(null);
  shadowPolicyModeRef.current = shadowPolicyMode;
  const [protectedRoomAccessByRoom, setProtectedRoomAccessByRoom] = useState<
    ReadonlyMap<string, Readonly<{
      namespaceId: string;
      human?: ProtectedRoomCoverageState;
      ai?: ProtectedRoomCoverageState;
    }>>
  >(new Map());
  const observeProtectedRoomAccess = useCallback(
    (state: ProtectedRoomAccessStateV2): void => {
      setProtectedRoomAccessByRoom((current) => {
        const prior = current.get(state.roomId);
        const base = prior?.namespaceId === state.namespaceId
          ? prior
          : { namespaceId: state.namespaceId };
        if (base[state.keyClass] === state.status) return current;
        const next = new Map(current);
        next.set(state.roomId, Object.freeze({
          ...base,
          [state.keyClass]: state.status,
        }));
        return next;
      });
    }, [],
  );
  const protectedRoomAccess = useMemo(() => Object.freeze({
    stateForRoom(roomId: string): ProtectedRoomCoverageState | null {
      if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") return null;
      const state = protectedRoomAccessByRoom.get(roomId);
      if (state === undefined) return null;
      if (state.human === "waiting" || state.ai === "waiting") return "waiting";
      return state.human === "ready" && state.ai === "ready" ? "ready" : null;
    },
    markMembershipPending(roomId: string, namespaceId: string): void {
      if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") return;
      setProtectedRoomAccessByRoom((current) => {
        const next = new Map(current);
        next.set(roomId, Object.freeze({
          namespaceId,
          human: "waiting" as const,
          ai: "waiting" as const,
        }));
        return next;
      });
    },
  }), [protectedRoomAccessByRoom, shadowPolicyMode]);
  useEffect(() => {
    setProtectedRoomAccessByRoom(new Map());
  }, [auth.viewerGeneration]);
  const desktopForegroundShadow = isDesktop
    ? desktopAPI?.foregroundShadow
    : undefined;
  useEffect(() => {
    if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") {
      setProtectedRoomAccessByRoom(new Map());
      return;
    }
    return subscribeToDesktopProtectedRoomAccessState(
      desktopForegroundShadow,
      observeProtectedRoomAccess,
    );
  }, [desktopForegroundShadow, observeProtectedRoomAccess, shadowPolicyMode]);
  const [desktopForegroundShadowDeviceId, setDesktopForegroundShadowDeviceId] =
    useState<string | null>(null);
  useEffect(() => {
    // Retain the known installation while admission is temporarily paused.
    // The gate owns reproof; a background inspection must not tear down clients.
    if (!admissionReady) return;
    if (desktopForegroundShadow === undefined
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) {
      setDesktopForegroundShadowDeviceId(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inspect = (): void => {
      void desktopForegroundShadow.inspect()
        .then((result) => {
          if (cancelled) return;
          setDesktopForegroundShadowDeviceId(
            result.status === "ready" ? result.deviceId : null,
          );
          if (result.status !== "ready") {
            timer = setTimeout(inspect, 2_000);
          }
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(inspect, 2_000);
        });
    };
    inspect();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    admissionReady,
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadow,
  ]);
  const liveShadowMessageReceiverRef = useRef<ReturnType<
    typeof createBrowserLiveShadowMessageReceiver
  > | undefined>(undefined);
  const humanPeerOrdinarySiblingsRef = useRef(
    new Map<string, MessagePayloadV2>(),
  );
  const strictPendingHumanEventsRef = useRef(new Map<string, Extract<
    ServerEvent,
    { type: "message.new"; messageId: string }
  >>());
  const pendingHumanShadowEventsRef = useRef(new Map<string, Extract<
    ServerEvent,
    { type: "message.human_peer_shadow" | "message.shared_agent_shadow" }
  >>());
  useEffect(() => {
    strictPendingHumanEventsRef.current.clear();
    pendingHumanShadowEventsRef.current.clear();
  }, [auth.viewerGeneration]);
  useEffect(() => {
    let previousSnapshot = getCryptoAdmissionSnapshot();
    const synchronize = (): void => {
      const snapshot = getCryptoAdmissionSnapshot();
      const allowed = isCryptoAdmissionAllowed();
      setAdmissionReady(allowed);
      if (resumeRealtimeAfterAdmission({
        client: wsRef.current,
        previous: previousSnapshot,
        current: snapshot,
      })) {
        setAdmissionResumeGeneration((value) => value + 1);
        window.dispatchEvent(new CustomEvent("nautilo:admission-resumed"));
      }
      previousSnapshot = snapshot;
      // Retain the clients and their in-memory state while admission is paused.
      // Transport/consumption fences prevent using them until revalidated.
      if (snapshot.status !== "open" || snapshot.policy === null) return;
      const policy = snapshot.policy;
      setShadowPolicyMode((current) => current === policy.mode ? current : policy.mode);
    };
    synchronize();
    return subscribeCryptoAdmissionAccess(synchronize);
  }, []);
  const pendingAttentionAuthorizationDeviceId = useMemo(() => {
    if (isDesktop) return desktopForegroundShadowDeviceId;
    if (typeof window === "undefined"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return null;
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    return installationId === null ? null : deriveBrowserCryptoDeviceId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
      installationId,
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadowDeviceId,
  ]);
  const liveShadowMessageClient = useMemo(() => {
    if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") return undefined;
    if (isDesktop) {
      if (desktopForegroundShadow === undefined
        || desktopForegroundShadowDeviceId === null) return undefined;
      return Object.freeze({
        deviceId: desktopForegroundShadowDeviceId,
        send: (roomId: string, body: Parameters<
          DesktopForegroundShadowAPI["send"]
        >[1]) => runWithCryptoAdmission(() => desktopForegroundShadow.send(roomId, body)),
        edit: desktopForegroundShadow.edit === undefined ? undefined
          : (roomId: string, messageId: string, body: Parameters<RoomMessageEdit>[2]) =>
            runWithCryptoAdmission(() => desktopForegroundShadow.edit!(roomId, messageId, body)),
        recoverPending: () => runWithCryptoAdmission(() => desktopForegroundShadow.recoverPending()),
        recoverRoomPendingAttention: (input: Readonly<{
          roomId: string;
          clientActionSessionId: string;
          signal?: AbortSignal;
          isCurrent?: () => boolean;
        }>) => recoverDesktopRoomPendingAttention(desktopForegroundShadow, input),
        completePending: () => Promise.resolve(true),
        synchronizeHumanPeerRecipients: (roomId: string, namespaceId: string) =>
          runWithCryptoAdmission(() => desktopForegroundShadow.synchronizeRecipients(roomId, namespaceId)),
        serviceDomainKeyRequests: (
          roomId: string,
          namespaceId: string,
          keyClass: "human" | "ai",
        ) => runWithCryptoAdmission(() => desktopForegroundShadow.synchronizeRecipients(
          roomId,
          namespaceId,
          keyClass,
        )),
        serviceDomainKeyBacklog: () =>
          runWithCryptoAdmission(() => desktopForegroundShadow.serviceDomainKeyBacklog?.()
            ?? Promise.resolve(false)),
        receiveDomainKeyDelivery: (roomId: string, namespaceId: string) =>
          runWithCryptoAdmission(() => desktopForegroundShadow.synchronizeRecipients(roomId, namespaceId)),
        authorizeSharedAgentExecution: (event: Parameters<
          DesktopForegroundShadowAPI["authorize"]
        >[0]) => runWithCryptoAdmission(() => desktopForegroundShadow.authorize(event)),
      });
    }
    if (typeof window === "undefined"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    if (installationId === null) return undefined;
    return createBrowserLiveShadowMessageClient({
      api: apiClient,
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
      installationId,
      onProtectedRoomAccessState: observeProtectedRoomAccess,
      normalizeContent: normalizeHumanMessageText,
      onHumanVerified: (verified) =>
        liveShadowMessageReceiverRef.current?.registerHuman(verified),
      onDurableRecovery: async (event) => {
        assertCryptoAdmissionAccess();
        const generation = getCryptoAdmissionSnapshot().generation;
        const result = await liveShadowMessageReceiverRef.current?.receive(event);
        assertCryptoAdmissionAccess(generation);
        return result?.status === "durable_verified";
      },
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadow,
    desktopForegroundShadowDeviceId,
    observeProtectedRoomAccess,
    shadowPolicyMode,
  ]);
  const editRoomMessage = useCallback<RoomMessageEdit>((roomId, messageId, body) =>
    editRoomMessageWithPolicy({
      api: apiClient,
      owner: createWorkbenchDataOperationOwner(),
      protectedEdit: liveShadowMessageClient?.edit === undefined ? undefined
        : (targetRoomId, targetMessageId, editBody) =>
          liveShadowMessageClient.edit!(targetRoomId, targetMessageId, editBody),
      roomId,
      messageId,
      body,
    }), [liveShadowMessageClient]);
  const liveShadowMessageReceiver = useMemo(() => {
    if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") return undefined;
    if (isDesktop) {
      if (desktopForegroundShadow === undefined
        || desktopForegroundShadowDeviceId === null) return undefined;
      return Object.freeze({
        registerHuman: () => Promise.resolve(),
        receive: async (event: Parameters<
          ReturnType<typeof createBrowserLiveShadowMessageReceiver>["receive"]
        >[0]) => {
          const received = await desktopForegroundShadow.receive({
            kind: "standard",
            event: event as LiveShadowMessageRealtimeEventV1,
          });
          if (received.kind !== "standard" || received.result === null) {
            throw new Error("Desktop foreground Shadow receive result disagrees");
          }
          return received.result;
        },
        destroy: () => undefined,
      });
    }
    if (typeof window === "undefined"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    if (installationId === null) return undefined;
    return createBrowserLiveShadowMessageReceiver({
      api: apiClient,
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
      installationId,
      onProtectedRoomAccessState: observeProtectedRoomAccess,
      onTerminalVerification: async (operationId) => {
        await liveShadowMessageClient?.completePending(operationId);
      },
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadow,
    desktopForegroundShadowDeviceId,
    liveShadowMessageClient,
    observeProtectedRoomAccess,
    shadowPolicyMode,
  ]);
  const humanPeerLiveShadowMessageReceiver = useMemo(() => {
    if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") return undefined;
    if (isDesktop) {
      if (desktopForegroundShadow === undefined
        || desktopForegroundShadowDeviceId === null) return undefined;
      return Object.freeze({
        receive: async (
          event: Parameters<ReturnType<
            typeof createBrowserHumanPeerLiveShadowMessageReceiver
          >["receive"]>[0],
          ordinarySibling?: MessagePayloadV2,
        ) => {
          const received = await desktopForegroundShadow.receive({
            kind: "human_peer",
            event: event as LiveShadowMessageRealtimeEventV1
              | FullEncryptionMessageRealtimeContentEventV2,
            ...(ordinarySibling === undefined ? {} : { ordinarySibling }),
          });
          if (received.kind !== "human_peer") {
            throw new Error("Desktop Human-peer Shadow result disagrees");
          }
          return received.result;
        },
      });
    }
    if (typeof window === "undefined"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    if (installationId === null) return undefined;
    return createBrowserHumanPeerLiveShadowMessageReceiver({
      api: apiClient,
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
      installationId,
      onProtectedRoomAccessState: observeProtectedRoomAccess,
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadow,
    desktopForegroundShadowDeviceId,
    observeProtectedRoomAccess,
    shadowPolicyMode,
  ]);
  const sharedAgentLiveShadowMessageReceiver = useMemo(() => {
    if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") return undefined;
    if (isDesktop) {
      if (desktopForegroundShadow === undefined
        || desktopForegroundShadowDeviceId === null) return undefined;
      return Object.freeze({
        receive: async (
          event: Parameters<ReturnType<
            typeof createBrowserSharedAgentLiveShadowMessageReceiver
          >["receive"]>[0],
          ordinarySibling?: MessagePayloadV2,
        ) => {
          const received = await desktopForegroundShadow.receive({
            kind: "shared_agent",
            event: event as LiveShadowMessageRealtimeEventV1
              | FullEncryptionMessageRealtimeContentEventV2,
            ...(ordinarySibling === undefined ? {} : { ordinarySibling }),
          });
          if (received.kind !== "shared_agent") {
            throw new Error("Desktop shared-Agent Shadow result disagrees");
          }
          return received.result;
        },
      });
    }
    if (typeof window === "undefined"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    if (installationId === null) return undefined;
    return createBrowserSharedAgentLiveShadowMessageReceiver({
      api: apiClient,
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
      installationId,
      onProtectedRoomAccessState: observeProtectedRoomAccess,
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadow,
    desktopForegroundShadowDeviceId,
    observeProtectedRoomAccess,
    shadowPolicyMode,
  ]);
  const sharedAgentOutputLiveShadowReceiver = useMemo(() => {
    if (shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only") return undefined;
    if (isDesktop) {
      if (desktopForegroundShadow === undefined
        || desktopForegroundShadowDeviceId === null) return undefined;
      return Object.freeze({
        receive: async (event: Parameters<ReturnType<
          typeof createBrowserSharedAgentOutputLiveShadowReceiver
        >["receive"]>[0]) => {
          const received = await desktopForegroundShadow.receive({
            kind: "shared_agent_output",
            event: event as LiveShadowMessageRealtimeEventV1,
          });
          if (received.kind !== "shared_agent_output"
            || received.result === null) {
            throw new Error("Desktop shared-Agent output result disagrees");
          }
          return received.result;
        },
        destroy: () => undefined,
      });
    }
    if (typeof window === "undefined"
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    if (installationId === null) return undefined;
    return createBrowserSharedAgentOutputLiveShadowReceiver({
      api: apiClient,
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
      installationId,
      onProtectedRoomAccessState: observeProtectedRoomAccess,
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadow,
    desktopForegroundShadowDeviceId,
    observeProtectedRoomAccess,
    shadowPolicyMode,
  ]);
  useEffect(() => () => {
    sharedAgentOutputLiveShadowReceiver?.destroy();
  }, [sharedAgentOutputLiveShadowReceiver]);
  useEffect(() => {
    liveShadowMessageReceiverRef.current = liveShadowMessageReceiver;
    return () => {
      if (liveShadowMessageReceiverRef.current === liveShadowMessageReceiver) {
        liveShadowMessageReceiverRef.current = undefined;
      }
      liveShadowMessageReceiver?.destroy();
    };
  }, [liveShadowMessageReceiver]);
  const messageBackfillSchedulerRef = useRef<ReturnType<typeof createWorkbenchMessageBackfillScheduler> | null>(null);
  const recipientSyncSchedulerRef = useRef<ReturnType<
    typeof createDomainKeyRecipientSyncScheduler
  > | null>(null);
  const refreshMountedKeyWaitingHistoryRef = useRef<(displayRoomId: string) => void>(
    () => undefined,
  );
  const requestProtectedRoomAuthorityRef = useRef<(displayRoomId: string) => void>(
    () => undefined,
  );
  const authorityWaitingRoomRef = useRef<string | null>(null);
  const pendingMountedBackfillPriorityRef = useRef<MessageBackfillUrgentSelection | null>(null);
  const drainMountedBackfillPriorityRef = useRef<() => void>(() => undefined);
  const messageBackfillClient = useMemo(() => {
    if (!auth.viewer.isVerified || auth.viewer.sessionUserId === null || auth.viewer.sessionActorId === null) return undefined;
    if (isDesktop) {
      if (desktopForegroundShadow === undefined || desktopForegroundShadowDeviceId === null) return undefined;
      return createDesktopMessageBackfillSchedulerClient({
        service: (urgent) => runWithCryptoAdmission(() => desktopForegroundShadow.serviceMessageBackfill(urgent)),
        cancel: () => desktopForegroundShadow.cancelMessageBackfill(),
      });
    }
    if (typeof window === "undefined") return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId, humanActorId: auth.viewer.sessionActorId});
    if (installationId === null) return undefined;
    return createBrowserMessageBackfillClient({api: apiClient, serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId, humanActorId: auth.viewer.sessionActorId, installationId,
      dataOperationOwner: createWorkbenchDataOperationOwner(), onProtectedRoomAccessState: observeProtectedRoomAccess});
  }, [auth.viewer.isVerified, auth.viewer.sessionUserId, auth.viewer.sessionActorId,
    desktopForegroundShadow, desktopForegroundShadowDeviceId, observeProtectedRoomAccess]);
  const roomHistoryShadowReadAdapter = useMemo<
    RoomHistoryShadowReadAdapter | undefined
  >(() => {
    if ((shadowPolicyMode !== "shadow_encryption" && shadowPolicyMode !== "encrypted_only")
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return undefined;
    const desktopHistory = isDesktop
      ? desktopForegroundShadow?.history
      : undefined;
    let reader: ReturnType<
      typeof createBrowserRoomHistoryShadowMessageReader
    > | null = null;
    let readerDeviceId: string;
    if (isDesktop) {
      if (desktopHistory === undefined
        || desktopForegroundShadowDeviceId === null) return undefined;
      readerDeviceId = desktopForegroundShadowDeviceId;
    } else {
      if (typeof window === "undefined") return undefined;
      const installationId = readOrCreateBrowserCryptoInstallationId({
        serverScope: window.location.origin,
        userId: auth.viewer.sessionUserId,
        humanActorId: auth.viewer.sessionActorId,
      });
      if (installationId === null) return undefined;
      reader = createBrowserRoomHistoryShadowMessageReader({
        api: apiClient,
        serverScope: window.location.origin,
        userId: auth.viewer.sessionUserId,
        humanActorId: auth.viewer.sessionActorId,
        installationId,
        onProtectedRoomAccessState: observeProtectedRoomAccess,
        onHistoryVerificationDiagnostic: (diagnostic) => {
          console.warn("[nautilo-runtime] Protected history verification diagnostic", JSON.stringify(diagnostic));
        },
      });
      readerDeviceId = reader.readerDeviceId;
    }
    return createRoomHistoryDataAdapter({
      owner: createWorkbenchDataOperationOwner(),
      readerDeviceId,
      prioritize: (selection) => {pendingMountedBackfillPriorityRef.current = selection;},
      onAuthorityWaiting: (roomId) => {
        if (roomId !== activeRoomIdRef.current) return;
        authorityWaitingRoomRef.current = roomId;
        requestProtectedRoomAuthorityRef.current(roomId);
      },
      read: async (readerInput, acknowledgement) => {
        if (desktopHistory !== undefined) {
          return desktopHistory.reconcile({ readerInput, acknowledgement });
        }
        if (reader === null) throw new Error("Room history reader is unavailable");
        const result = await reader.reconcile(readerInput);
        try {
          await reader.acknowledge({ ...acknowledgement, result });
        } catch (error) {
          if (import.meta.env.DEV) console.warn(
            "[nautilo-runtime] Room history acknowledgement failed", error,
          );
        }
        return result;
      },
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    desktopForegroundShadow,
    desktopForegroundShadowDeviceId,
    observeProtectedRoomAccess,
    shadowPolicyMode,
  ]);
  useEffect(() => {
    if (
      !admissionReady || liveShadowMessageClient === undefined
      || liveShadowMessageReceiver === undefined
    ) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = (): void => {
      void liveShadowMessageClient.recoverPending()
        .catch((error: unknown) => {
          console.error("[nautilo-runtime] live Shadow recovery failed", error);
        })
        .finally(() => {
          if (!cancelled) timer = setTimeout(recover, 5_000);
        });
    };
    recover();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [admissionReady, liveShadowMessageClient, liveShadowMessageReceiver]);
  const roomMessageOperations = useMemo(() => createRoomMessageOperations({
    owner: createWorkbenchDataOperationOwner(),
    api: apiClient,
    around: apiClient,
    ordinarySend: (roomId, body) => sendOrdinaryRoomMessage(
      apiClient, roomId, withCurrentClientActionSession(body),
    ),
    ...(liveShadowMessageClient === undefined ? {} : {
      protectedSend: (roomId: string, body: Parameters<typeof apiClient.sendRoomMessage>[1]) =>
        liveShadowMessageClient.send(roomId, withCurrentClientActionSession(body)),
    }),
    ...(roomHistoryShadowReadAdapter === undefined ? {} : { historyReader: roomHistoryShadowReadAdapter }),
  }), [liveShadowMessageClient, roomHistoryShadowReadAdapter]);
  const roomMessageOperationsRef = useRef(roomMessageOperations);
  roomMessageOperationsRef.current = roomMessageOperations;
  const roomNav = useRoomNavigation();
  const activeRoomId = roomNav.activeRoomId;
  /** D163 — bump to re-render subtree (RoomsPanel reads optimistic overlay from rooms-panel-model). */
  const [, setRoomSidebarTick] = useState(0);
  const tickRoomSidebar = useCallback(() => {
    setRoomSidebarTick((n) => n + 1);
  }, []);

  const activeRoomIdRef = useRef<string | null>(null);
  activeRoomIdRef.current = activeRoomId;
  useEffect(() => {
    authorityWaitingRoomRef.current = null;
  }, [activeRoomId, auth.viewerGeneration]);

  // D430 — search owns only bounded result pages. Its active-Room ref guard
  // rejects completions during the render→effect window of a Room switch.
  const roomSearchControllerRef = useRef<RoomMessageSearchController | null>(null);
  if (!roomSearchControllerRef.current) {
    roomSearchControllerRef.current = createRoomMessageSearchController({
      fetchPage: (options) => apiClient.searchRoomMessages(options),
      getActiveRoomId: () => activeRoomIdRef.current,
    });
  }
  const roomSearchController = roomSearchControllerRef.current;
  const [roomSearchState, setRoomSearchState] = useState<RoomMessageSearchState>(
    () => roomSearchController.getSnapshot(),
  );
  useEffect(
    () => roomSearchController.subscribe(() => setRoomSearchState(roomSearchController.getSnapshot())),
    [roomSearchController],
  );
  useEffect(() => {
    roomSearchController.setRoomId(activeRoomId);
  }, [activeRoomId, roomSearchController]);
  useEffect(() => () => roomSearchController.dispose(), [roomSearchController]);

  // D470 — one runtime-owned Chats search controller serves every Desktop
  // entry point. The active origin and authenticated actor generation are part
  // of its authority scope, so an account or in-process Server switch clears
  // visible results synchronously and aborts the prior transport request.
  const chatsSearchControllerRef = useRef<ChatsSearchController | null>(null);
  if (!chatsSearchControllerRef.current) {
    chatsSearchControllerRef.current = createChatsSearchController({
      fetchPage: (options, signal) => apiClient.searchChats(options, { signal }),
    });
  }
  const chatsSearchController = chatsSearchControllerRef.current;
  const [chatsSearchState, setChatsSearchState] = useState<ChatsSearchState>(
    () => chatsSearchController.getSnapshot(),
  );
  useEffect(
    () => chatsSearchController.subscribe(() =>
      setChatsSearchState(chatsSearchController.getSnapshot())),
    [chatsSearchController],
  );
  useEffect(() => {
    chatsSearchController.setScope({
      serverKey: typeof window === "undefined" ? null : window.location.origin,
      viewerKey: auth.viewer.isVerified ? auth.viewer.sessionActorId : null,
      viewerGeneration: auth.viewerGeneration,
    });
  }, [
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewerGeneration,
    chatsSearchController,
  ]);
  useEffect(() => () => chatsSearchController.dispose(), [chatsSearchController]);

  const laneKeyToRoomIdRef = useRef(new Map<string, string>());
  // D426 — one visible child-room controller can register with the owner of
  // the authenticated socket. This deliberately lives in the provider (not a
  // module or window singleton), so an unmounted/switching drawer cannot
  // receive replayed frames.
  const threadRoomRegistrationRef = useRef<ThreadRoomRegistration | null>(null);
  const registerThreadRoom = useCallback((registration: ThreadRoomRegistration) => {
    threadRoomRegistrationRef.current = registration;
    return () => {
      if (threadRoomRegistrationRef.current === registration) {
        threadRoomRegistrationRef.current = null;
      }
    };
  }, []);
  const threadRoomEventRouter = useMemo<ThreadRoomEventRouter>(
    () => ({ registerThreadRoom }),
    [registerThreadRoom],
  );
  const jobIdToRoomIdRef = useRef(new Map<string, string>());
  const virtualJobIdToRoomIdRef = useRef(new Map<string, string>());
  // M147 — live (dispatched, not-yet-terminal) foreground/fork job ids. The
  // composer STOP button aborts every live job in the active room via
  // `POST /api/jobs/:id/stop`. Populated on `job.dispatched` (forks emit it
  // too), pruned on terminal `job.status`.
  const liveJobIdsRef = useRef(new Set<string>());
  /** Coalesce owner-private identity reads for duplicate terminal frames. */
  const pendingToolJobReconciliationIdsRef = useRef(new Set<string>());
  // D341 — Stop can be clicked while a room send only has the coalescer's
  // virtual id. Hold the room-level stop intent until `job.dispatched` maps
  // virtual ids to a real persisted job id that `/api/jobs/:id/stop` accepts.
  const pendingStopRoomIdsRef = useRef(new Set<string>());
  const pendingStopVirtualJobIdsRef = useRef(new Set<string>());
  const lastStreamLaneKeyRef = useRef<string | null>(null);
  const liveShadowReceiveQueueRef = useRef<Promise<void>>(Promise.resolve());
  // Foreground authorization has a short server-held deadline. It must never
  // sit behind history opening, durable verification, or Domain catch-up: any
  // of those can legitimately wait for missing authority while the current
  // Agent turn still needs its device approval immediately.
  const liveShadowAuthorizationQueueRef = useRef<Promise<void>>(
    Promise.resolve(),
  );
  const backgroundAuthorizationWakeRef = useRef<() => void>(() => undefined);
  const projectedLiveShadowEventRef = useRef<(event: ServerEvent) => void>(
    () => undefined,
  );
  const protectedProjectedEventsRef = useRef(new WeakSet<object>());
  // Separate consumption admission from cryptographic verification. An
  // ordinary Fallback event must never be marked as verified ciphertext.
  const consumedRoomEventsRef = useRef(new WeakSet<object>());
  /** Tracks the room id used for the last completed history hydrate (clears UI on room switch). */
  const lastRehydratedRoomRef = useRef<string | null | undefined>(undefined);
  // D459 — history requests are snapshots, while WebSocket events are deltas.
  // Keep a small Room-scoped journal so a snapshot cannot erase a persisted
  // message which arrived after that request began. A later request supersedes
  // an earlier one, even when both target the same Room.
  const roomHydrationGenerationRef = useRef(0);
  const activeRoomHydrationRef = useRef<RoomHydrationRequest | null>(null);
  const roomLiveArrivalSequenceRef = useRef(0);
  const roomLiveArrivalsRef = useRef<RoomLiveArrival<ThreadMessageLike>[]>([]);
  const activeInitialHydrationScopeRef = useRef<RoomInitialHydrationScope | null>(null);
  const [roomInitialHydrationState, setRoomInitialHydrationState] =
    useState<RoomInitialHydrationState | null>(null);
  const roomInitialHydrationStateRef = useRef<RoomInitialHydrationState | null>(null);
  roomInitialHydrationStateRef.current = roomInitialHydrationState;
  const pendingNoTokenScopeRef = useRef<RoomInitialHydrationScope | null>(null);
  const [roomHydrationRetry, setRoomHydrationRetry] = useState<{
    nonce: number;
    backgroundScope: Omit<RoomInitialHydrationScope, "generation"> | null;
  }>({ nonce: 0, backgroundScope: null });
  const roomHydrationTimingRef = useRef(createRoomHydrationTiming());
  const pendingTranscriptCommitAckRef = useRef<{
    readonly scope: RoomInitialHydrationScope;
    readonly projectedMessageIds: readonly string[];
    readonly timing: RoomHydrationTimingAttempt;
  } | null>(null);
  const retryRoomInitialHydration = useCallback(() => {
    setRoomHydrationRetry((current) => ({
      nonce: current.nonce + 1,
      backgroundScope: null,
    }));
  }, []);
  const refreshRoomInitialHydrationInBackground = useCallback(() => {
    // A membership event is not allowed to replace an in-progress streamed
    // transcript. The regular history/reconnect paths will reconcile once the
    // live turn finishes.
    if (streamsRef.current.size > 0) return;
    const state = roomInitialHydrationStateRef.current;
    if (!state) return;
    const { generation: _generation, ...backgroundScope } = state.scope;
    setRoomHydrationRetry((current) => ({
      nonce: current.nonce + 1,
      backgroundScope,
    }));
  }, []);
  const refreshBackfilledRoomMessageRef = useRef<(
    selection: MessageBackfillUrgentSelection,
    options?: Readonly<{ scheduleContinuation?: boolean }>,
  ) => Promise<PrioritizedHistoryRefreshResult>>(
    (_selection: MessageBackfillUrgentSelection) => Promise.resolve("ignored" as const),
  );
  const backfillHistoryRefreshGenerationRef = useRef(0);
  const pendingBackfillHistoryRefreshesRef = useRef(
    new Set<string>(),
  );

  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [historyCursor, setHistoryCursor] = useState<{ id: string; createdAt: string } | null>(null);
  const retainedHistoryCursorRef = useRef(historyCursor);
  retainedHistoryCursorRef.current = historyCursor;
  const [hasMoreHistoryBefore, setHasMoreHistoryBefore] = useState(false);
  const [loadingHistoryBefore, setLoadingHistoryBefore] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(isRunning);
  isRunningRef.current = isRunning;
  const [turnStopStatus, setTurnStopStatus] = useState<TurnStopStatus>({
    state: "idle",
    attemptId: 0,
  });
  const turnStopAttemptIdRef = useRef(0);
  const [wsState, setWsStateRaw] = useState<WsState>("closed");
  const [ordinaryContentAccessRecoveryGeneration,
    setOrdinaryContentAccessRecoveryGeneration] = useState(0);
  const [clientActionSessionGeneration, setClientActionSessionGeneration] =
    useState(0);
  const pendingAttentionLiveSequenceRef = useRef(0);
  const pendingAttentionRecoveryGenerationRef = useRef(0);
  const pendingAttentionReplayRef = useRef(false);
  const pendingAttentionUiScopeGenerationRef = useRef(0);
  const pendingAttentionPreviewQueueRef = useRef<PendingApprovalPreviewQueue<QueuedPendingAttentionPreview>>(
    initialPendingApprovalPreviewQueue(),
  );
  const settlePendingAttentionPreviewRef = useRef<(key: string) => void>(() => {});
  const enqueuePendingAttentionPreviewRef = useRef<(
    events: readonly PendingAttentionPreviewEvent[],
    recovered?: boolean,
  ) => void>(() => {});
  const [pendingAttentionRecoveryRetryGeneration,
    setPendingAttentionRecoveryRetryGeneration] = useState(0);
  const [pendingAttentionRecoveryUnavailable, setPendingAttentionRecoveryUnavailable] =
    useState<Readonly<{
      roomId: string;
      viewerKey: string;
      viewerGeneration: number;
      origin: string;
      retryable: boolean;
    }> | null>(null);
  const notificationEventListenersRef = useRef(
    new Set<(event: NotificationRuntimeEvent) => void>(),
  );
  const notificationRuntimeEventSource = useMemo(
    () => ({
      subscribe(listener: (event: NotificationRuntimeEvent) => void) {
        notificationEventListenersRef.current.add(listener);
        return () => {
          notificationEventListenersRef.current.delete(listener);
        };
      },
    }),
    [],
  );
  // Epoch ms of the most recent "open" transition. Null until first open.
  // Derived consumers (useWsState) use this to compute disconnect duration.
  //
  // ISSUE-D145, PR #173 review-fix-3 — seeded via
  // `computeInitialLastOpenAtSeed()` (has-ever-open bit + D154
  // `shellStateOnBoot` tiebreaker) so a hard reload during a server outage
  // (where the WS won't reach "open" because the server is dead)
  // still produces `authenticated_disconnected` rather than
  // `authenticated_connecting`. The seed is `Date.now()` (a fresh
  // disconnect-since timer rather than the literal prior-session
  // timestamp) so prolonged-disconnect-toast escalation thresholds
  // start from "now" per reload, matching the user's experience.
  const [lastOpenAt, setLastOpenAt] = useState<number | null>(() =>
    computeInitialLastOpenAtSeed({
      hasEverBeenOpen: readHasEverBeenOpen(),
      shellStateOnBoot: getShellStateOnBoot(),
      now: Date.now(),
    }),
  );
  // ISSUE-D145 — epoch ms when the current reconnect started (set when
  // wsState leaves "open" after having been open; cleared on next
  // open). Drives the `authenticated_resuming` shell-state variant.
  const [reconnectStartedAt, setReconnectStartedAt] = useState<number | null>(null);
  /** D146 — suppress `reconnectStartedAt` when leaving `open` for visibility suspend. */
  const visibilityDisconnectSuppressRef = useRef(false);
  const [visibilityHidden, setVisibilityHidden] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voicePlaying, setVoicePlaying] = useState(false);
  // D057 2a.1.11 — rolling activity log consumed by the Activity tab.
  // We push on tool.start + mutate the matching entry on tool.end, and
  // cap total length so a long session doesn't bloat state.
  const [toolActivity, setToolActivity] = useState<ToolActivityEvent[]>([]);
  const toolActivityByIdRef = useRef<Map<string, ToolActivityEvent>>(new Map());
  const pendingBrowserResearchInterventionsRef = useRef(new Map<string, NonNullable<ToolActivityEvent["browserResearchIntervention"]>>());
  const pendingConnectedWebActionAttentionRef = useRef(new Map<string, ConnectedWebActionAttention>());
  const connectedWebActionAttentionRevisionRef = useRef(0);
  const applyConnectedWebActionAttention = useCallback((raw: unknown): void => {
    const viewerUserId = auth.viewer.sessionUserId;
    if (viewerUserId === null) return;
    const attention = parseConnectedWebActionAttention(
      raw,
      ++connectedWebActionAttentionRevisionRef.current,
      viewerUserId,
    );
    if (!attention) return;
    const bindingKey = connectedWebActionAttentionKey(attention);
    pendingConnectedWebActionAttentionRef.current.set(bindingKey, attention);
    const current = toolActivityByIdRef.current.get(attention.toolCallId);
    if (!current || current.toolName !== "act_connected_web_account" || current.status !== "running" || current.laneKey !== attention.laneKey) return;
    const next = {
      ...current,
      connectedWebActionAttention: attention,
      connectedWebActionResumeFailed: undefined,
    };
    toolActivityByIdRef.current.set(attention.toolCallId, next);
    pendingConnectedWebActionAttentionRef.current.delete(bindingKey);
    setToolActivity((activities) => activities.map((activity) =>
      activity.toolCallId === attention.toolCallId && activity.laneKey === attention.laneKey
        ? next
        : activity));
  }, [auth.viewer.sessionUserId]);
  const applyConnectedWebActionResumeFailed = useCallback((raw: unknown): void => {
    const viewerUserId = auth.viewer.sessionUserId;
    if (viewerUserId === null) return;
    const failed = parseConnectedWebActionResumeFailed(raw, viewerUserId);
    if (!failed) return;
    pendingConnectedWebActionAttentionRef.current.delete(connectedWebActionAttentionKey(failed));
    const current = toolActivityByIdRef.current.get(failed.toolCallId);
    const next = applyConnectedWebActionResumeFailureToActivity(current, failed);
    if (!next || next === current) return;
    toolActivityByIdRef.current.set(failed.toolCallId, next);
    setToolActivity((activities) => activities.map((activity) =>
      activity.toolCallId === failed.toolCallId && activity.laneKey === failed.laneKey
        ? next
        : activity));
  }, [auth.viewer.sessionUserId]);
  useEffect(() => {
    const api = desktopAPI?.browserResearch;
    if (!api) return;
    const applyIntervention = (intervention: NonNullable<ToolActivityEvent["browserResearchIntervention"]>): void => {
      const bindingKey = `${intervention.laneKey}\0${intervention.toolCallId}`;
      pendingBrowserResearchInterventionsRef.current.set(bindingKey, intervention);
      const current = toolActivityByIdRef.current.get(intervention.toolCallId);
      if (!current || current.status !== "running" || current.laneKey !== intervention.laneKey ||
        (intervention.authorAgentId !== undefined && current.authorAgentId !== intervention.authorAgentId)) return;
      const next = { ...current, browserResearchIntervention: intervention };
      toolActivityByIdRef.current.set(intervention.toolCallId, next);
      setToolActivity((activities) => activities.map((activity) =>
        activity.toolCallId === intervention.toolCallId && activity.laneKey === intervention.laneKey
          ? next
          : activity));
    };
    const unsubscribe = api.onIntervention(applyIntervention);
    void api.getActiveIntervention().then((intervention) => {
      if (intervention) applyIntervention(intervention);
    }).catch(() => undefined);
    return unsubscribe;
  }, []);
  // D087 Phase 3 §3.10 — path-keyed revision-state map populated by
  // `revisions.state_changed` WS events. Drives the undo/redo bar,
  // context menu's "Undo" item enable state, and the files-tree
  // revision badge.
  const [revisionState, setRevisionState] = useState<
    Readonly<Record<string, RevisionStateSnapshot>>
  >({});
  /** D264 — model-chain hop telemetry; status UI only (never assistant prose / TTS). */
  const [modelFallbackStatus, setModelFallbackStatus] =
    useState<ModelFallbackStatusSnapshot | null>(null);
  const [deepResearchStatus, setDeepResearchStatus] = useState<{
    jobId: string;
    line: string;
  } | null>(null);
  const [foregroundContextStatus, setForegroundContextStatus] = useState<{
    jobId: string;
    line: string;
  } | null>(null);
  useEffect(() => {
    setForegroundContextStatus(null);
  }, [activeRoomId]);
  // D323 — backstop auto-dismiss so the pill never outlives its turn even when
  // the routed terminal `job.status` clear doesn't reach the active room.
  // Re-arms on each new snapshot (new hop / new turnId yields a new object).
  useAutoDismiss(
    modelFallbackStatus,
    () => setModelFallbackStatus(null),
    MODEL_FALLBACK_NOTICE_TTL_MS,
  );
  // Mirror into a ref so the `/undo` slash-command handler inside
  // `sendText` can resolve "most-recently-touched path" without
  // rebinding on every state change.
  const revisionStateRef = useRef<Readonly<Record<string, RevisionStateSnapshot>>>({});
  useEffect(() => {
    revisionStateRef.current = revisionState;
  }, [revisionState]);
  const taskStateBridgeRef = useRef<TaskStateBridge | null>(null);

  const setWsState = useCallback((next: WsState) => {
    setWsStateRaw((prev) => {
      if (next === "open") {
        // D103 P4d.9 — the Electron main process can have started while the
        // server was down, leaving its Logto config unresolved. Re-probe only
        // when this transition newly reaches open; do not touch the session
        // token or sign-out state.
        void reprobeDesktopServerOnReconnect(prev, next, desktopAPI);
        setLastOpenAt(Date.now());
        setReconnectStartedAt(null);
        // ISSUE-D145, PR #173 review-fix-3 — record on this device
        // that we've seen a successful open at least once. Seeds
        // `computeInitialLastOpenAtSeed()` on subsequent mounts so a hard
        // reload during an outage produces authenticated_disconnected
        // rather than authenticated_connecting. Idempotent localStorage
        // write; tolerates storage failure silently.
        markHasEverBeenOpen();
      } else if (prev === "open" && !visibilityDisconnectSuppressRef.current) {
        // Had been open, now leaving — reconnect underway. Drives
        // the `authenticated_resuming` shell-state variant.
        setReconnectStartedAt(Date.now());
      }
      return next;
    });
  }, []);

  const previousWsStateForRunShellRef = useRef<WsState>(wsState);
  useEffect(() => {
    const previous = previousWsStateForRunShellRef.current;
    previousWsStateForRunShellRef.current = wsState;
    if (previous !== "open" || wsState === "open") return;
    const disconnectedAt = Date.now();
    // D502 — losing the authenticated event stream cannot be presented as
    // proof that a one-shot process stopped. Freeze every exact running shell
    // at its last observed evidence until progress or the canonical final
    // receipt restores certainty. This lives outside the state updater because
    // React may replay updater functions.
    for (const [toolCallId, activity] of toolActivityByIdRef.current) {
      const nextActivity = setRunShellContinuity(
        activity,
        "disconnected",
        disconnectedAt,
      );
      if (nextActivity !== activity) {
        toolActivityByIdRef.current.set(toolCallId, nextActivity);
      }
    }
    setToolActivity((activities) =>
      markRunShellActivitiesDisconnected(activities, disconnectedAt)
    );
  }, [wsState]);

  // Identity challenge (verify_identity → PinDialog)
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [pinError, setPinError] = useState<string | undefined>();
  const challengeThreadIdRef = useRef<string | null>(null);
  // Identity challenge flavor:
  //   "verify"    → POST /api/auth/identity-verify-resume (Logto JWT)
  //   "enrollPin" → POST /api/auth/pin (first-time PIN under Logto)
  const challengeModeRef = useRef<"verify" | "enrollPin">("verify");
  const challengeLaneKeyRef = useRef<string | null>(null);
  const challengePreviewKeyRef = useRef<string | null>(null);

  // Prove-it challenge (destructive tool approval → ApprovalDialog)
  const [showApprovalDialog, setShowApprovalDialog] = useState(false);
  const [approvalError, setApprovalError] = useState<string | undefined>();
  const [approvalTools, setApprovalTools] = useState<ProveItToolInfo[]>([]);
  const approvalThreadIdRef = useRef<string | null>(null);
  const approvalLaneKeyRef = useRef<string | null>(null);
  const approvalChallengeIdRef = useRef<string | null>(null);
  const approvalPreviewKeyRef = useRef<string | null>(null);

  // D061 Phase 2-client (Chunk 5) — graduated ask-verb approval.
  // Distinct from prove_it above: ask is the light tier (no PIN, four
  // verbs: once / session / always / deny), presented inline above
  // the composer rather than as a centered modal. State + refs mirror
  // the prove_it pattern so the two flows don't share mutable state
  // accidentally.
  //
  // ISSUE-D440 — the dock is now driven by a pure lifecycle reducer
  // (`../approval/approval-lifecycle`) keyed by `approvalId`. The
  // reducer owns the invariants: a lost HTTP acknowledgement keeps
  // the dock visible (no false clear, no invented terminal
  // evidence); completion / denial / cancellation / expiry clears
  // exactly once; a late or duplicate `approval.ask` for an
  // already-terminal id cannot reopen the dock; and unrelated
  // `tool.end` / `job.status` events never dispatch here, so they
  // cannot clear another approval by construction. The
  // requester-private `approval.resolved` ServerEvent is handled
  // below as authoritative terminal evidence after canonical resume;
  // submit-error remains conservative until that event arrives.
  const [approvalLifecycle, dispatchApprovalLifecycle] = useReducer(
    reduceApprovalLifecycle,
    undefined,
    initialApprovalLifecycleState,
  );
  const approvalLifecycleRef = useRef(approvalLifecycle);
  approvalLifecycleRef.current = approvalLifecycle;
  const dispatchCurrentApprovalLifecycle = useCallback((action: ApprovalLifecycleAction) => {
    approvalLifecycleRef.current = reduceApprovalLifecycle(approvalLifecycleRef.current, action);
    dispatchApprovalLifecycle(action);
  }, []);
  const approvalAskState: ApprovalAskState = useMemo(
    () => deriveApprovalAskView(approvalLifecycle),
    [approvalLifecycle],
  );
  // Refs mirror the pending payload so the stable WS handler and the
  // submit callback can read threadId / laneKey without re-subscribing.
  const approvalAskThreadIdRef = useRef<string | null>(null);
  const approvalAskLaneKeyRef = useRef<string | null>(null);

  // D453 — native Codex approvals are live-only provider semantics; Plan
  // user-input has bounded, answer-free recovery facts. Neither belongs in
  // Nautilo ApprovalAsk policy state. Keep the bounded pending map in this
  // socket owner; the context exposes only the visible owner's Room cards.
  const [codexRequestLifecycle, dispatchCodexRequestLifecycle] = useReducer(
    reduceCodexRequestLifecycle,
    undefined,
    initialCodexRequestLifecycleState,
  );
  const codexRequestLifecycleRef = useRef(codexRequestLifecycle);
  useEffect(() => {
    codexRequestLifecycleRef.current = codexRequestLifecycle;
  }, [codexRequestLifecycle]);

  /**
   * Native user-input recovery uses the same narrow fence as Room transcript
   * hydration: only lifecycle facts that arrive while this one GET is in
   * flight are journaled, then replayed onto its response. This is not a
   * permanent control-plane log and never stores answer values.
   */
  const codexRequestLiveSequenceRef = useRef(0);
  const codexRequestHydrationGenerationRef = useRef(0);
  const codexRequestHydrationRef = useRef<{
    readonly generation: number;
    readonly viewerKey: string;
    readonly roomId: string;
    readonly liveSequenceAtStart: number;
    readonly baselineRequestIds: readonly string[];
    readonly arrivals: Array<{
      readonly sequence: number;
      readonly action: CodexRequestLifecycleSourceAction;
    }>;
    overflowed: boolean;
  } | null>(null);
  const dispatchTrackedCodexRequestLifecycle = useCallback((action: CodexRequestLifecycleSourceAction) => {
    const sequence = ++codexRequestLiveSequenceRef.current;
    const hydration = codexRequestHydrationRef.current;
    if (hydration && sequence > hydration.liveSequenceAtStart) {
      // A request has a hard cap of 16 visible cards. Keep the tiny fetch
      // window journal proportionate while preserving every terminal/action
      // fact likely to affect such a card.
      if (hydration.arrivals.length >= 64) {
        // A truncated journal could lose terminal evidence and let a stale
        // snapshot resurrect a request. Preserve current state instead.
        hydration.overflowed = true;
      } else {
        hydration.arrivals.push({ sequence, action });
      }
    }
    dispatchCodexRequestLifecycle(action);
  }, []);
  const codexRequestState = useMemo(
    () => selectCodexRequestsForRoom(codexRequestLifecycle, activeRoomId, auth.viewer.sessionUserId),
    [activeRoomId, auth.viewer.sessionUserId, codexRequestLifecycle],
  );

  // D375 / D500 — ephemeral, renderer-session Auto-Approve mode. Keep it
  // across route remounts and maintenance reloads, but bind it to the exact
  // verified human so it cannot cross a sign-out or account switch.
  const autoApproveViewerId = auth.viewer.isVerified
    ? auth.viewer.sessionUserId
    : null;
  const [autoApprove, setAutoApprove] = useState(() =>
    readAutoApproveSession(autoApproveViewerId),
  );
  const autoApproveRef = useRef(autoApprove);
  useEffect(() => {
    if (auth.session.state === "signed-out") {
      clearAutoApproveSession();
      autoApproveRef.current = false;
      setAutoApprove(false);
      return;
    }
    if (!autoApproveViewerId) {
      autoApproveRef.current = false;
      setAutoApprove(false);
      return;
    }
    const restored = readAutoApproveSession(autoApproveViewerId);
    autoApproveRef.current = restored;
    setAutoApprove(restored);
  }, [auth.session.state, autoApproveViewerId]);

  const setSessionAutoApprove = useCallback(
    (enabled: boolean) => {
      const next = Boolean(enabled && autoApproveViewerId);
      autoApproveRef.current = next;
      setAutoApprove(next);
      writeAutoApproveSession(autoApproveViewerId, next);
    },
    [autoApproveViewerId],
  );
  const setSessionAutoApproveRef = useRef(setSessionAutoApprove);
  setSessionAutoApproveRef.current = setSessionAutoApprove;

  // M054 — keep the latest `auth` API in a ref so the effects
  // below depend on `authState` (a primitive) rather than the
  // whole `auth` object. `useAuth()` returns a stable object now
  // (via useMemo on primitive deps), but the ref hardens us against
  // future drift and matches how the runtime adapter handles its
  // other refs.
  const authRef = useRef(auth);
  authRef.current = auth;
  const authState = auth.session.state;

  // ISSUE-D145 — viewer scope for the disconnect cache. We key cache
  // entries by the authenticated session-user id (preferred stable
  // storage scope per use-auth.ts). Guests / pre-whoami have no
  // viewerKey and the cache is a no-op for them.
  const viewerKey = auth.viewer.sessionUserId;
  const viewerKeyRef = useRef<string | null>(viewerKey);
  viewerKeyRef.current = viewerKey;
  const humanActorIdRef = useRef<string | null>(auth.viewer.sessionActorId);
  humanActorIdRef.current = auth.viewer.sessionActorId;
  const viewerGenerationRef = useRef(auth.viewerGeneration);
  viewerGenerationRef.current = auth.viewerGeneration;
  const serverOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const serverOriginRef = useRef(serverOrigin);
  serverOriginRef.current = serverOrigin;
  requestProtectedRoomAuthorityRef.current = (displayRoomId) => {
    if (
      displayRoomId !== activeRoomIdRef.current
      || !isCryptoAdmissionAllowed()
    ) return;
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    const sourceViewerKey = viewerKeyRef.current;
    const sourceViewerGeneration = viewerGenerationRef.current;
    const sourceOrigin = serverOriginRef.current;
    if (sourceViewerKey === null || sourceOrigin.length === 0) return;
    void apiClient.getRoom(displayRoomId).then((detail) => {
      if (!canCommitProtectedHistoryAuthorityDemand({
        admissionCurrent:
          isCryptoAdmissionGenerationCurrent(admissionGeneration),
        requestedDisplayRoomId: displayRoomId,
        activeRoomId: activeRoomIdRef.current,
        requestedViewerKey: sourceViewerKey,
        currentViewerKey: viewerKeyRef.current,
        requestedViewerGeneration: sourceViewerGeneration,
        currentViewerGeneration: viewerGenerationRef.current,
        requestedOrigin: sourceOrigin,
        currentOrigin: serverOriginRef.current,
      })) return;
      const coordinate = protectedHistoryRecipientSyncCoordinate(
        displayRoomId,
        detail,
      );
      if (coordinate === null) return;
      recipientSyncSchedulerRef.current?.enqueue(
        coordinate.displayRoomId,
        coordinate.namespaceId,
        coordinate.sourceRoomId,
      );
    }).catch(() => {
      // A later Room read, reconnect, or membership hint retries demand.
    });
  };

  // Single cache instance per provider mount. Backed by localStorage
  // today; the backend interface is shaped to admit AsyncStorage /
  // electron-store later without churning call sites.
  const disconnectCacheRef = useRef<DisconnectCache | null>(null);
  if (disconnectCacheRef.current === null) {
    disconnectCacheRef.current = createDisconnectCache(createLocalStorageBackend());
  }
  const ordinaryDisconnectCache = (): DisconnectCache | null =>
    allowsOrdinaryConversationPersistence(shadowPolicyModeRef.current)
      ? disconnectCacheRef.current
      : null;

  // D530 — pending writes are keyed by their complete durable scope. Both
  // the scope and a shallow message snapshot are captured at schedule time;
  // delayed work must never inspect the mutable live transcript.
  interface PendingCacheWrite {
    timer: ReturnType<typeof setTimeout>;
    readonly scope: DisconnectCacheScope;
  }
  const cacheWriteTimersRef = useRef(new Map<string, PendingCacheWrite>());
  useEffect(() => subscribeCryptoAdmissionAccess(() => {
    if (isCryptoAdmissionAllowed()) return;
    for (const pending of cacheWriteTimersRef.current.values()) clearTimeout(pending.timer);
    cacheWriteTimersRef.current.clear();
    if (getCryptoAdmissionSnapshot().status === "blocked" && viewerKeyRef.current !== null) {
      disconnectCacheRef.current?.clearForViewer({
        serverOrigin: serverOriginRef.current,
        viewerKey: viewerKeyRef.current,
      });
    }
  }), []);
  const cacheScopeKey = (scope: DisconnectCacheScope): string =>
    `${scope.serverOrigin}\u0000${scope.viewerKey}\u0000${scope.roomId}`;
  const activeCacheScope = (roomId: string | null): DisconnectCacheScope | null => {
    const activeViewerKey = viewerKeyRef.current;
    const activeOrigin = serverOriginRef.current;
    if (!activeOrigin || !activeViewerKey || !roomId) return null;
    return { serverOrigin: activeOrigin, viewerKey: activeViewerKey, roomId };
  };

  // ISSUE-D145 — clear cached frames for the previous viewer when the
  // signed-in identity changes (sign-out, switch actor). Prevents a
  // prior identity's cached prose from leaking into a new session
  // before the WS reopens.
  //
  // PR #173 review fix — also cancel any pending cache-write timers
  // scheduled under the old viewer key BEFORE clearing storage. Without
  // this, an in-flight 1s debounce timer scheduled just before
  // sign-out could fire post-clear and re-write the prior viewer's
  // messages back into storage. The timer-cancel walks
  // `cacheWriteTimersRef.current` directly rather than calling the
  // helper to avoid an effect-deps dependency on a function declared
  // later in this same component (the helper is exposed for any
  // future call sites).
  const prevViewerKeyRef = useRef<string | null>(viewerKey);
  useEffect(() => {
    const prev = prevViewerKeyRef.current;
    const next = viewerKey;
    if (prev !== null && prev !== next) {
      // The render selector already hides A's cards synchronously. Purge the
      // retained maps/tombstones before B's recovery read can settle.
      codexRequestHydrationRef.current = null;
      dispatchCodexRequestLifecycle({ kind: "reset_owner" });
      const timers = cacheWriteTimersRef.current;
      for (const [key, pending] of timers) {
        if (
          pending.scope.serverOrigin === serverOriginRef.current &&
          pending.scope.viewerKey === prev
        ) {
          clearTimeout(pending.timer);
          timers.delete(key);
        }
      }
      disconnectCacheRef.current?.clearForViewer({
        serverOrigin: serverOriginRef.current,
        viewerKey: prev,
      });
    }
    prevViewerKeyRef.current = next;
  }, [viewerKey]);

  // ISSUE-D145 — derived once per render; consumed via context by
  // Conversation/Composer for empty-state copy + tooltip; mirrored
  // into a ref so the rehydrate effect (below) can branch on it
  // without depending on an extra deps slot.
  const shellState: RuntimeShellState = deriveRuntimeShellState({
    authState,
    wsState,
    lastOpenAt,
    reconnectStartedAt,
    visibilityHidden,
  });
  const shellStateRef = useRef<RuntimeShellState>(shellState);
  shellStateRef.current = shellState;

  const messagesRef = useRef<ThreadMessageLike[]>([]);
  drainMountedBackfillPriorityRef.current = () => {
    const pending = pendingMountedBackfillPriorityRef.current;
    const scheduler = messageBackfillSchedulerRef.current;
    if (pending === null || scheduler === null) return;
    pendingMountedBackfillPriorityRef.current = null;
    const mounted = mountedRoomHistoryPrioritySelection(
      activeRoomIdRef.current,
      messagesRef.current,
      pending,
    );
    if (mounted !== null) {
      scheduler.prioritize(mounted);
      scheduler.refreshHistory(mounted);
    }
  };
  const scheduleCacheWrite = useCallback((roomId: string | null) => {
    if (!isCryptoAdmissionAllowed()) return;
    const scope = activeCacheScope(roomId);
    if (!scope) return;
    const cache = ordinaryDisconnectCache();
    if (!cache) return;
    const scopeKey = cacheScopeKey(scope);
    const existing = cacheWriteTimersRef.current.get(scopeKey);
    if (existing) clearTimeout(existing.timer);
    const snapshot = [...messagesRef.current];
    const timer = setTimeout(() => {
      cacheWriteTimersRef.current.delete(scopeKey);
      if (!isCryptoAdmissionAllowed()) return;
      ordinaryDisconnectCache()?.writeActiveRoom(scope, snapshot);
    }, 1_000);
    cacheWriteTimersRef.current.set(scopeKey, {
      timer,
      scope,
    });
  }, []);
  useEffect(() => {
    const timers = cacheWriteTimersRef.current;
    return () => {
      for (const pending of timers.values()) {
        clearTimeout(pending.timer);
      }
      timers.clear();
    };
  }, []);

  const streamsRef = useRef<Map<string, StreamState>>(new Map());
  const streamKeyByLaneAuthorRef = useRef<Map<string, string>>(new Map());
  const visibleOutputQuietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicePlayerRef = useRef<VoicePlayer | null>(null);
  const voiceEnabledRef = useRef(false);
  const readyToWorkOwnerAdapterRef = useRef<ReadyToWorkRendererOwnerAdapter | null>(null);
  const readyToWorkRestoreAttemptedRef = useRef(false);

  if (!voicePlayerRef.current) {
    voicePlayerRef.current = new VoicePlayer((playing) => setVoicePlaying(playing));
  }

  const flush = useCallback(() => {
    const deduped = dedupeThreadMessagesById(messagesRef.current);
    if (deduped.length !== messagesRef.current.length) {
      messagesRef.current = deduped;
      if (import.meta.env.DEV) {
        console.warn(
          "[nautilo-runtime] dropped duplicate message id(s) before assistant-ui sync (resume/replayed tool.start)",
        );
      }
    }
    setMessages([...messagesRef.current]);
  }, []);

  const acknowledgeTranscriptAfterLayout = useCallback((
    scope: RoomInitialHydrationScope,
    timing: RoomHydrationTimingAttempt,
    projected: readonly ThreadMessageLike[],
  ) => {
    pendingTranscriptCommitAckRef.current = {
      scope,
      timing,
      projectedMessageIds: projected.map((message) => String(message.id)),
    };
  }, []);

  // `flush()` schedules React work; this layout pass is the first point at
  // which the exact projected transcript has reached the renderer. Do not
  // report a commit merely because the async continuation called setState.
  useLayoutEffect(() => {
    const pending = pendingTranscriptCommitAckRef.current;
    if (!pending) return;
    if (!canAcknowledgeInitialHistoryTranscriptCommit({
      activeScope: activeInitialHydrationScopeRef.current,
      pendingScope: pending.scope,
      projectedMessageIds: pending.projectedMessageIds,
      renderedMessageIds: messages.map((message) => String(message.id)),
    })) return;
    pendingTranscriptCommitAckRef.current = null;
    pending.timing.transcriptCommitted();
  }, [messages, roomInitialHydrationState]);

  // Reconnect and post-PIN rehydrates already have authoritative server
  // results. They may supersede the initial attempt, so settle its consumer
  // projection only when it still names the exact currently selected scope.
  const settleInitialHistoryFromAuthoritativeResult = useCallback((input: {
    readonly roomId: string | null;
    readonly kind: "ready" | "empty" | "waiting-for-authority" | "recoverable-error" | "access-terminal-error";
    readonly reason?: "unauthorized" | "not-found";
    readonly sendAuthorized?: boolean;
  }) => {
    setRoomInitialHydrationState((current) => {
      if (
        !current ||
        !input.roomId ||
        current.scope.origin !== serverOriginRef.current ||
        current.scope.viewerKey !== viewerKeyRef.current ||
        current.scope.viewerGeneration !== viewerGenerationRef.current ||
        current.scope.roomId !== input.roomId ||
        activeRoomIdRef.current !== input.roomId
      ) return current;
      if (input.kind === "ready") return { kind: "ready", scope: current.scope };
      if (input.kind === "empty") return { kind: "empty", scope: current.scope };
      if (input.kind === "waiting-for-authority") {
        return {
          kind: "waiting-for-authority",
          scope: current.scope,
          sendAuthorized: input.sendAuthorized === true,
        };
      }
      if (input.kind === "recoverable-error") {
        return { kind: "recoverable-error", scope: current.scope, retainsCachedFrame: false };
      }
      return {
        kind: "access-terminal-error",
        scope: current.scope,
        reason: input.reason ?? "not-found",
      };
    });
  }, []);

  // D430 — around-message hydration intentionally leaves ordinary history
  // cursor facts alone. Existing rows win by id, preserving live streams and
  // optimistic objects while the bounded server page supplies missing rows.
  const roomHistoryAroundControllerRef = useRef<RoomHistoryAroundController | null>(null);
  if (!roomHistoryAroundControllerRef.current) {
    roomHistoryAroundControllerRef.current = createRoomHistoryAroundController({
      fetchPage: (options) => roomMessageOperationsRef.current.readRoomMessagesAround(options),
      getActiveRoomId: () => activeRoomIdRef.current,
      isMessageLoaded: (messageId) =>
        messagesRef.current.some((message) => String(message.id) === messageId),
      onPage: (page) => {
        const restored = restoreSessionMessages(page.messages);
        messagesRef.current = mergeRoomMessagesAround(messagesRef.current, restored);
        flush();
        drainMountedBackfillPriorityRef.current();
      },
    });
  }
  const roomHistoryAroundController = roomHistoryAroundControllerRef.current;
  const [roomHistoryAroundState, setRoomHistoryAroundState] = useState<RoomHistoryAroundState>(
    () => roomHistoryAroundController.getSnapshot(),
  );
  useEffect(
    () => roomHistoryAroundController.subscribe(() =>
      setRoomHistoryAroundState(roomHistoryAroundController.getSnapshot())),
    [roomHistoryAroundController],
  );
  useEffect(() => {
    roomHistoryAroundController.setRoomId(activeRoomId);
  }, [activeRoomId, roomHistoryAroundController]);
  useEffect(() => () => roomHistoryAroundController.dispose(), [roomHistoryAroundController]);

  useEffect(() => {
    backfillHistoryRefreshGenerationRef.current += 1;
    pendingMountedBackfillPriorityRef.current = null;
    const pendingRefreshes = pendingBackfillHistoryRefreshesRef.current;
    return () => {
      backfillHistoryRefreshGenerationRef.current += 1;
      pendingMountedBackfillPriorityRef.current = null;
      pendingRefreshes.clear();
    };
  }, [activeRoomId, auth.viewerGeneration]);
  refreshBackfilledRoomMessageRef.current = (selection, options = {}) => {
    const mountedRoomId = activeRoomIdRef.current;
    const expectedTarget = mountedRoomHistoryRefreshTarget(
      messagesRef.current,
      selection,
    );
    const request = mountedRoomHistoryRefreshRequest(
      mountedRoomId,
      messagesRef.current,
      selection,
    );
    if (request === null || expectedTarget === null) return Promise.resolve("ignored" as const);
    if (streamsRef.current.size > 0) return Promise.resolve("retry" as const);
    const key = `${mountedRoomId}:${selection.messageId}:${selection.revision}`;
    if (pendingBackfillHistoryRefreshesRef.current.has(key)) {
      return Promise.resolve("retry" as const);
    }
    pendingBackfillHistoryRefreshesRef.current.add(key);
    const generation = backfillHistoryRefreshGenerationRef.current;
    const viewerGeneration = viewerGenerationRef.current;
    return (async () => {
      try {
        const page = await roomMessageOperationsRef.current.readRoomMessagesAround(request);
        if (generation !== backfillHistoryRefreshGenerationRef.current
          || viewerGeneration !== viewerGenerationRef.current
          || activeRoomIdRef.current !== mountedRoomId) return "ignored" as const;
        const targetState = mountedRoomHistoryRefreshTargetState(
          messagesRef.current,
          selection,
          expectedTarget,
        );
        if (targetState !== "current") return targetState;
        if (streamsRef.current.size > 0
          || !page.messages.some((message) => String(message.id) === String(selection.messageId)
            && (message.editRevision ?? 0) === selection.revision)) return "retry" as const;
        const restored = restoreSessionMessages(page.messages);
        const targetWasIntentionallyOmitted = !restored.some(
          (message) => String(message.id) === String(selection.messageId),
        ) && page.messages.some((message) =>
          String(message.id) === String(selection.messageId)
          && (message.editRevision ?? 0) === selection.revision
          && Reflect.get(message, "historyUnavailable") !== true
        );
        const refreshedMessages = replaceRefreshedRoomMessage(
          messagesRef.current,
          restored,
          String(selection.messageId),
          { removeUnavailableTargetWhenAbsent: targetWasIntentionallyOmitted },
        );
        const projectedTarget = refreshedMessages.find((message) =>
          String(message.id) === String(selection.messageId)
        );
        const projectedRevision = projectedTarget?.metadata?.custom?.editRevision;
        const exactProjectionSucceeded = targetWasIntentionallyOmitted
          ? projectedTarget === undefined
          : projectedTarget !== undefined
            && projectedTarget.metadata?.custom?.historyUnavailable !== true
            && (typeof projectedRevision === "number" ? projectedRevision : 0)
              === selection.revision;
        if (!exactProjectionSucceeded) return "retry" as const;
        messagesRef.current = refreshedMessages;
        const adapterHint = pendingMountedBackfillPriorityRef.current;
        pendingMountedBackfillPriorityRef.current = null;
        flush();
        if (!roomHistoryContainsUnavailableMessage(messagesRef.current)) {
          settleInitialHistoryFromAuthoritativeResult({
            roomId: mountedRoomId,
            kind: "ready",
          });
        }
        const next = nextMountedHistoryPrioritySelection(
          mountedRoomId,
          messagesRef.current,
          selection,
          adapterHint,
          { refreshedTargetRemoved: targetWasIntentionallyOmitted },
        );
        if (next !== null && options.scheduleContinuation !== false) {
          const scheduler = messageBackfillSchedulerRef.current;
          scheduler?.prioritize(next);
          scheduler?.refreshHistory(next);
        }
        return "refreshed" as const;
      } catch {
        return generation === backfillHistoryRefreshGenerationRef.current
            && viewerGeneration === viewerGenerationRef.current
            && activeRoomIdRef.current === mountedRoomId
          ? "retry" as const
          : "ignored" as const;
      } finally {
        pendingBackfillHistoryRefreshesRef.current.delete(key);
      }
    })();
  };
  refreshMountedKeyWaitingHistoryRef.current = (displayRoomId) => {
    if (displayRoomId !== activeRoomIdRef.current) return;
    const waitingSelections = mountedKeyWaitingHistorySelections(
      displayRoomId,
      messagesRef.current,
    );
    if (waitingSelections.length === 0) {
      if (shouldRefreshInitialHistoryAfterDomainDelivery({
        eventRoomId: displayRoomId,
        activeRoomId: activeRoomIdRef.current,
        hydrationState: roomInitialHydrationStateRef.current,
      })) refreshRoomInitialHydrationInBackground();
      return;
    }
    const sourceAdmissionGeneration = getCryptoAdmissionSnapshot().generation;
    const sourceRefreshGeneration = backfillHistoryRefreshGenerationRef.current;
    const sourceViewerGeneration = viewerGenerationRef.current;
    const sourceViewerKey = viewerKeyRef.current;
    const sourceOrigin = serverOriginRef.current;
    void refreshMountedKeyWaitingHistorySnapshot({
      selections: waitingSelections,
      isCurrent: () =>
        isCryptoAdmissionGenerationCurrent(sourceAdmissionGeneration)
        && backfillHistoryRefreshGenerationRef.current === sourceRefreshGeneration
        && viewerGenerationRef.current === sourceViewerGeneration
        && viewerKeyRef.current === sourceViewerKey
        && serverOriginRef.current === sourceOrigin
        && activeRoomIdRef.current === displayRoomId,
      refresh: (selection) => refreshBackfilledRoomMessageRef.current(
        selection,
        { scheduleContinuation: false },
      ),
      // The recipient-sync coordinate is consumed before this exact reread.
      // Hand a transient failure to the bounded backfill scheduler so its
      // visibility/readiness gates and retry cadence continue this row, then
      // the remaining mounted rows, without waiting for another delivery.
      onRetry: (selection) => {
        pendingMountedBackfillPriorityRef.current = selection;
        drainMountedBackfillPriorityRef.current();
      },
    }).catch((error: unknown) => {
      console.error(
        "[nautilo-runtime] Mounted key-waiting history refresh failed",
        error instanceof Error ? error.name : typeof error,
      );
    });
  };

  const addMessage = useCallback(
    (msg: ThreadMessageLike) => {
      messagesRef.current = [...messagesRef.current, msg];
      flush();
    },
    [flush],
  );

  const recordLiveRoomMessage = useCallback((roomId: string, messageId: string) => {
    const request = activeRoomHydrationRef.current;
    if (!request || request.roomId !== roomId) return;
    const message = messagesRef.current.find((candidate) => String(candidate.id) === messageId);
    if (!message) return;
    const sequence = ++roomLiveArrivalSequenceRef.current;
    const arrivals = roomLiveArrivalsRef.current;
    // Only the active request can consume these entries. Keep the list bounded
    // against a pathological high-volume room while it is loading.
    roomLiveArrivalsRef.current = [
      ...arrivals.slice(-199),
      { roomId, sequence, message },
    ];
  }, []);

  const updateMessageById = useCallback(
    (id: string, content: string, extras?: Partial<ThreadMessageLike>) => {
      const msgs = messagesRef.current;
      const idx = msgs.findIndex((m) => m.id === id);
      if (idx < 0) return;
      const prev = msgs[idx];
      messagesRef.current = [
        ...msgs.slice(0, idx),
        { ...prev, ...extras, content: [{ type: "text" as const, text: content }] },
        ...msgs.slice(idx + 1),
      ];
      flush();
    },
    [flush],
  );

  const reconcileMessageId = useCallback(
    (localId: string, realId: string) => {
      const next = reconcileOptimisticMessageId(messagesRef.current, localId, realId);
      if (next === messagesRef.current) return;
      messagesRef.current = [...next];
      flush();
    },
    [flush],
  );

  const updateMessageText = useCallback(
    (id: string, text: string) => {
      const next = updateMessageTextInList(messagesRef.current, id, text);
      if (next === messagesRef.current) return;
      messagesRef.current = [...next];
      flush();
    },
    [flush],
  );

  const markMessageSendFailed = useCallback(
    (id: string, reason?: string) => {
      const next = markMessageSendFailedInList(messagesRef.current, id, reason);
      if (next === messagesRef.current) return;
      messagesRef.current = [...next];
      flush();
    },
    [flush],
  );

  const clearAgentStreamingVisibleOutput = useCallback(() => {
    if (visibleOutputQuietTimerRef.current) {
      clearTimeout(visibleOutputQuietTimerRef.current);
      visibleOutputQuietTimerRef.current = null;
    }
    setAgentStreamingVisibleOutput(false);
  }, []);

  const markAgentStreamingVisibleOutputActive = useCallback(() => {
    setAgentStreamingVisibleOutput(true);
    if (visibleOutputQuietTimerRef.current) {
      clearTimeout(visibleOutputQuietTimerRef.current);
    }
    visibleOutputQuietTimerRef.current = setTimeout(() => {
      visibleOutputQuietTimerRef.current = null;
      setAgentStreamingVisibleOutput(false);
    }, VISIBLE_OUTPUT_QUIET_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (visibleOutputQuietTimerRef.current) {
        clearTimeout(visibleOutputQuietTimerRef.current);
        visibleOutputQuietTimerRef.current = null;
      }
    };
  }, []);

  const hasLiveJobForActiveRoom = useCallback(() => {
    const activeRoom = activeRoomIdRef.current;
    for (const id of liveJobIdsRef.current) {
      if (!activeRoom || jobIdToRoomIdRef.current.get(id) === activeRoom) {
        return true;
      }
    }
    return false;
  }, []);

  const nextTurnStopAttemptId = useCallback(() => {
    turnStopAttemptIdRef.current += 1;
    return turnStopAttemptIdRef.current;
  }, []);

  const setTurnStopFailed = useCallback(
    (reason: TurnStopFailureReason, attemptId = nextTurnStopAttemptId()) => {
      setTurnStopStatus({ state: "failed", reason, attemptId });
    },
    [nextTurnStopAttemptId],
  );

  const stopKnownJobIds = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return false;
      const stoppedIds = [...ids];
      const attemptId = nextTurnStopAttemptId();
      setTurnStopStatus({ state: "stopping", attemptId });
      clearAgentStreamingVisibleOutput();
      setIsRunning(false);
      for (const id of stoppedIds) liveJobIdsRef.current.delete(id);
      void Promise.allSettled(stoppedIds.map((id) => apiClient.stopJob(id))).then((results) => {
        let failure: TurnStopFailureReason | null = null;
        results.forEach((result, index) => {
          const id = stoppedIds[index] ?? "<unknown>";
          if (result.status === "rejected") {
            failure = "request-failed";
            if (import.meta.env.DEV) {
              console.warn("[nautilo-runtime] stop job request failed", id, result.reason);
            }
            return;
          }
          if (!result.value.stopped) {
            failure = "not-live";
            if (import.meta.env.DEV) {
              console.warn("[nautilo-runtime] stop job request returned stopped=false", id);
            }
          }
        });
        if (turnStopAttemptIdRef.current !== attemptId) return;
        if (failure) {
          for (const id of stoppedIds) liveJobIdsRef.current.add(id);
          setIsRunning(hasLiveJobForActiveRoom());
          setTurnStopStatus({ state: "failed", reason: failure, attemptId });
          return;
        }
        setTurnStopStatus({ state: "stopped", attemptId });
      });
      return true;
    },
    [clearAgentStreamingVisibleOutput, hasLiveJobForActiveRoom, nextTurnStopAttemptId],
  );

  // D212 P2 — apply a reaction add/remove to the target message's
  // aggregated `metadata.custom.reactions`. Counts mirror distinct
  // reacting actors: M121 only emits reaction.added/removed on a real
  // row change (idempotent re-adds don't fire), so +1 / -1 is correct.
  // Match by string-compared id because restored history ids and live
  // event messageIds can differ in number-vs-string form.
  const updateMessageReactions = useCallback(
    (messageId: number, emoji: string, delta: 1 | -1, actorId?: string) => {
      const msgs = messagesRef.current;
      const target = String(messageId);
      const idx = msgs.findIndex((m) => String(m.id) === target);
      if (idx < 0) return; // message not in view (older page / other room)
      const prev = msgs[idx];
      const meta = (prev.metadata ?? {}) as {
        custom?: Record<string, unknown>;
      };
      const custom = meta.custom ?? {};
      const current = Array.isArray(custom.reactions)
        ? (custom.reactions as ReactionAggregate[])
        : [];

      // D312 — when the acting actor is known, keep `actorIds` in sync and
      // make the count change idempotent per actor so our optimistic toggle
      // and the server's WS echo collapse to a single +1/-1 (see
      // applyActorReaction). Falls back to the blind count delta when no
      // actorId is supplied (defensive; all live paths now pass one).
      const next = actorId
        ? applyActorReaction(current, emoji, delta, actorId)
        : applyReactionDelta(current, emoji, delta);

      messagesRef.current = [
        ...msgs.slice(0, idx),
        {
          ...prev,
          metadata: { ...meta, custom: { ...custom, reactions: next } },
        } as ThreadMessageLike,
        ...msgs.slice(idx + 1),
      ];
      flush();
    },
    [flush],
  );

  const settleToolsMissingFinalReceipt = useCallback((
    job: ToolTerminalJob,
    candidates?: ToolLifecycleCandidates,
  ): number => {
    const finalizedIds = new Set<string>();
    const endedAt = Date.now();
    for (const [toolCallId, activity] of toolActivityByIdRef.current) {
      if (!isSameToolLifecycleCandidate(toolCallId, activity, candidates)) continue;
      const activityRoomId = activity.laneKey
        ? roomIdFromLaneKey(activity.laneKey, laneKeyToRoomIdRef.current)
        : null;
      const next = finalizeRunningToolActivityWithoutReceipt(
        activity,
        activityRoomId,
        job,
        endedAt,
      );
      if (next === activity) continue;
      toolActivityByIdRef.current.set(toolCallId, next);
      finalizedIds.add(toolCallId);
    }
    if (finalizedIds.size === 0) return 0;

    setToolActivity((activities) => activities.map((activity) =>
      finalizedIds.has(activity.toolCallId)
        ? toolActivityByIdRef.current.get(activity.toolCallId) ?? activity
        : activity,
    ));
    const nextMessages = finalizeToolCallMessagesWithoutReceipt(
      messagesRef.current,
      finalizedIds,
      missingToolReceiptMessage(job.status),
    );
    if (nextMessages !== messagesRef.current) {
      messagesRef.current = [...nextMessages];
      flush();
      scheduleCacheWrite(job.roomId);
    }
    return finalizedIds.size;
  }, [flush, scheduleCacheWrite]);

  // D312 — optimistic tap-to-react toggle. Applies the change locally,
  // then PUT/DELETEs; the actor-aware echo above reconciles (idempotent on
  // our actorId), and a failed request rolls the optimistic change back.
  const toggleReaction = useCallback(
    (messageId: number, emoji: string, currentlySelf: boolean) => {
      const roomId = activeRoomIdRef.current;
      const myActorId = authRef.current.viewer.sessionActorId;
      if (!roomId || !myActorId) return;
      const delta: 1 | -1 = currentlySelf ? -1 : 1;
      updateMessageReactions(messageId, emoji, delta, myActorId);
      const req = currentlySelf
        ? apiClient.removeReaction(roomId, String(messageId), emoji)
        : apiClient.addReaction(roomId, String(messageId), emoji);
      void req.catch((err: unknown) => {
        console.error(
          "[nautilo-runtime] reaction toggle failed; rolling back",
          err,
        );
        updateMessageReactions(messageId, emoji, currentlySelf ? 1 : -1, myActorId);
      });
    },
    [updateMessageReactions],
  );

  const handleWsEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "encryption.policy.changed") {
        requestCryptoAdmissionRefresh("encryption_policy_changed");
        return;
      }
      if (event.type === "event_feed.changed") {
        publishEventFeedChanged();
        return;
      }
      if (!isCryptoAdmissionAllowed()) return;
      if (event.type === "crypto.background_authorization_requested") {
        backgroundAuthorizationWakeRef.current();
        return;
      }
      const receivingAdmissionGeneration = getCryptoAdmissionSnapshot().generation;
      const receivingViewer = viewerKeyRef.current;
      const receivingGeneration = viewerGenerationRef.current;
      const receivingOrigin = serverOriginRef.current;
      const sameReceivingViewer = () => isCryptoAdmissionGenerationCurrent(receivingAdmissionGeneration)
        && viewerKeyRef.current === receivingViewer
        && viewerGenerationRef.current === receivingGeneration
        && serverOriginRef.current === receivingOrigin;
      const retainPendingHumanEvent = (pending: Extract<ServerEvent, {
        type: "message.human_peer_shadow" | "message.shared_agent_shadow";
      }>) => {
        // Reuse the existing bounded sibling backlog; Full entries contain
        // ciphertext only and are retried by exact Namespace/key-class hints.
        const backlog = pendingHumanShadowEventsRef.current;
        if (!backlog.has(pending.logicalMessageKey) && backlog.size >= 128) {
          const oldest = backlog.keys().next().value;
          if (oldest !== undefined) backlog.delete(oldest);
        }
        backlog.set(pending.logicalMessageKey, pending);
      };
      // D082 PR A — WS receipt log for control events. Pairs with the
      // server's `[ws] → type` emit log so a grep across both can
      // reconstruct the full send/receive timeline. High-frequency
      // events (message.tokens, voice.audio, voice.sentence) are
      // suppressed to keep the log readable — they'd drown every
      // other event during a response stream.
      const suppressedTypes: ReadonlySet<ServerEvent["type"]> = new Set<
        ServerEvent["type"]
      >([
        "message.tokens",
        "message.shadow_stream_frame",
        "voice.audio",
        "voice.sentence",
        "agent.progress",
      ]);
      if (!suppressedTypes.has(event.type)) {
        const threadId =
          "threadId" in event ? (event as { threadId: unknown }).threadId : "-";
        const line = `[ws] ← ${event.type} (threadId=${String(threadId)})`;
        console.info(line);
        // Also forward to main-process log on desktop so the server
        // emit log and the client receipt log end up side-by-side in
        // main.log via electron-log. Silent no-op on web.
        try {
          const api = (window as unknown as {
            nautiloDesktop?: { logger?: { info?: (m: string) => void } };
          }).nautiloDesktop;
          api?.logger?.info?.(line);
        } catch {
          /* noop */
        }
      }

      if (
        event.type === "message.shared_agent_authorization_required"
        || event.type === "message.runtime_invocation_authorization_required"
      ) {
        if (liveShadowMessageClient === undefined) return;
        liveShadowAuthorizationQueueRef.current =
          liveShadowAuthorizationQueueRef.current
          .then(async () => {
            if (!sameReceivingViewer()) return;
            const authorized = await liveShadowMessageClient
              .authorizeSharedAgentExecution(event);
            if (!authorized && import.meta.env.DEV) {
              const coordinate = "invocationId" in event
                ? event.invocationId
                : event.executionId;
              console.warn(
                `[live-shadow] Foreground Runtime ${coordinate} authorization was unavailable`,
              );
            }
          })
          .catch((error: unknown) => {
            console.error(
              "[nautilo-runtime] Shared-Agent authorization failed",
              error,
            );
          });
        return;
      }

      if (event.type === "crypto.domain_key_catch_up_requested") {
        messageBackfillSchedulerRef.current?.notify();
        if (liveShadowMessageClient === undefined) return;
        liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current
          .then(async () => {
            if (!sameReceivingViewer()) return;
            await liveShadowMessageClient.serviceDomainKeyRequests(
              event.roomId,
              event.namespaceId,
              event.keyClass,
            );
            if (sameReceivingViewer()) {
              messageBackfillSchedulerRef.current?.notify();
            }
          })
          .catch((error: unknown) => {
            console.error(
              "[nautilo-runtime] V2 Domain-key catch-up failed",
              error instanceof Error ? error.name : typeof error,
            );
          });
        return;
      }

      if (event.type === "crypto.domain_key_catch_up_delivered") {
        messageBackfillSchedulerRef.current?.notify();
        if (liveShadowMessageClient === undefined) return;
        liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current
          .then(async () => {
            if (!sameReceivingViewer()) return;
            await liveShadowMessageClient.receiveDomainKeyDelivery(
              event.roomId,
              event.namespaceId,
              event.keyClass,
            );
            if (!sameReceivingViewer()) return;
            backgroundAuthorizationWakeRef.current();
            messageBackfillSchedulerRef.current?.notify();
            if (event.roomId === activeRoomIdRef.current) {
              refreshMountedKeyWaitingHistoryRef.current(event.roomId);
            }
            for (const pending of takePendingFullHumanEvents(
              pendingHumanShadowEventsRef.current, event,
            )) {
              // The original send authorization can expire while keys are
              // offline. Re-open the accepted durable message with current
              // read authority; never revive an expired send authorization.
              if (pending.wireVersion !== 2 || roomHistoryShadowReadAdapter === undefined) continue;
              const projection = pending.protectedMessage.projection;
              const isDisplayed = () => activeRoomIdRef.current === projection.roomId
                || threadRoomRegistrationRef.current?.roomId === projection.roomId;
              if (!sameReceivingViewer() || !isDisplayed()) continue;
              try {
                const reader = roomHistoryShadowReadAdapter;
                const opened = await readPendingFullHumanMessage({
                  event: pending, reader,
                  loadSidecar: () => apiClient.getRoomMessageShadowRead({
                    roomId: projection.roomId, intent: reader.createIntent(),
                    coordinate: {
                      sessionId: projection.sessionId, messageId: Number(projection.messageId),
                      editRevision: projection.editRevision, role: projection.role,
                      logicalMessageKey: pending.logicalMessageKey,
                    },
                  }),
                });
                if (!sameReceivingViewer() || !isDisplayed()) continue;
                if (threadRoomRegistrationRef.current?.roomId === projection.roomId) {
                  const projected = projectVerifiedFullHumanEvent(projection, opened.content, pending.logicalMessageKey);
                  protectedProjectedEventsRef.current.add(projected);
                  projectedLiveShadowEventRef.current(projected);
                  continue;
                }
                const next = reconcileVerifiedFullHumanMessage(messagesRef.current, projection,
                  opened.content, pending.logicalMessageKey, receivingViewer);
                if (next !== messagesRef.current) {
                  messagesRef.current = [...next];
                  flush();
                  recordLiveRoomMessage(projection.roomId, projection.messageId);
                  scheduleCacheWrite(projection.roomId);
                }
              } catch {
                if (sameReceivingViewer()) retainPendingHumanEvent(pending);
                console.warn("[nautilo-runtime] Pending Full Human history read unavailable");
              }
            }
          })
          .catch((error: unknown) => {
            console.error(
              "[nautilo-runtime] V2 Domain-key delivery failed",
              error instanceof Error ? error.name : typeof error,
            );
          });
        return;
      }

      if (
        event.type === "message.shadow_stream_start"
        || event.type === "message.shadow_stream_frame"
        || event.type === "message.shadow_durable"
      ) {
        const receiver = liveShadowMessageReceiver;
        if (receiver === undefined) return;
        liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current
          .then(async () => {
            if (!sameReceivingViewer()) return;
            const result = await receiver.receive(event);
            if (!sameReceivingViewer()) return;
            if (result.status === "failed" && result.checkpoint !== undefined) {
              console.warn(
                `[live-shadow] Foreground client rejected ${event.type} at ${result.checkpoint}`,
              );
            }
            for (const projected of projectLiveShadowMessageResult({
              event,
              result,
            })) {
              if (result.status !== "failed") protectedProjectedEventsRef.current.add(projected);
              projectedLiveShadowEventRef.current(projected);
            }
          })
          .catch((error: unknown) => {
            console.error("[nautilo-runtime] live Shadow receive failed", error);
          });
        return;
      }

      if (event.type === "message.human_peer_shadow") {
        const sibling = humanPeerOrdinarySiblingsRef.current.get(
          event.logicalMessageKey,
        );
        const receiver = humanPeerLiveShadowMessageReceiver;
        const failVerification = () => {
          const pending = strictPendingHumanEventsRef.current.get(event.logicalMessageKey);
          if (pending === undefined) return;
          const next = settleHumanMessageVerification(messagesRef.current, pending.messageId, { status: "failed" });
          if (next !== messagesRef.current) {
            messagesRef.current = [...next];
            flush();
          }
        };
        if (event.wireVersion === 1 && sibling === undefined) {
          retainPendingHumanEvent(event);
          return;
        }
        if (receiver === undefined) { failVerification(); return; }
        const pending = strictPendingHumanEventsRef.current.get(
          event.logicalMessageKey,
        );
        humanPeerOrdinarySiblingsRef.current.delete(event.logicalMessageKey);
        liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current
          .then(async () => {
            if (!sameReceivingViewer()) return;
            const result = await receiver.receive(event, sibling);
            if (!sameReceivingViewer()) return;
            if (result === null) { failVerification(); return; }
            if (result.status === "verified") {
              pendingHumanShadowEventsRef.current.delete(event.logicalMessageKey);
              strictPendingHumanEventsRef.current.delete(
                event.logicalMessageKey,
              );
              if (event.wireVersion === 2) {
                const projection = event.protectedMessage.projection;
                if (threadRoomRegistrationRef.current?.roomId === projection.roomId) {
                  const projected = projectVerifiedFullHumanEvent(projection, result.payload.content, event.logicalMessageKey);
                  protectedProjectedEventsRef.current.add(projected);
                  projectedLiveShadowEventRef.current(projected);
                  return;
                }
                if (activeRoomIdRef.current !== projection.roomId) return;
                const next = reconcileVerifiedFullHumanMessage(
                  messagesRef.current, projection, result.payload.content,
                  event.logicalMessageKey, receivingViewer,
                );
                if (next !== messagesRef.current) {
                  messagesRef.current = [...next];
                  flush();
                  recordLiveRoomMessage(projection.roomId, result.messageId);
                  scheduleCacheWrite(projection.roomId);
                }
                return;
              }
              if (pending !== undefined && threadRoomRegistrationRef.current?.roomId
                === roomIdFromLaneKey(pending.laneKey, laneKeyToRoomIdRef.current)) {
                const projected = { ...pending, content: result.payload.content };
                protectedProjectedEventsRef.current.add(projected);
                projectedLiveShadowEventRef.current(projected);
                return;
              }
              const reconciled = pending === undefined
                ? messagesRef.current
                : reconcileCanonicalHumanMessage(
                  messagesRef.current,
                  {
                    messageId: pending.messageId,
                    createdAt: pending.createdAt,
                    content: result.payload.content,
                    sourceUserId: pending.sourceUserId!,
                    logicalMessageKey: event.logicalMessageKey,
                    ...(typeof pending.editRevision === "number"
                      ? { editRevision: pending.editRevision }
                      : {}),
                    ...(typeof pending.replyToMessageId === "number"
                      ? { replyToMessageId: pending.replyToMessageId }
                      : {}),
                    ...(pending.artifacts === undefined
                      ? {}
                      : { artifacts: pending.artifacts }),
                  },
                  viewerKeyRef.current,
                );
              const next = settleHumanMessageVerification(reconciled, result.messageId, {
                status: "verified", content: result.payload.content,
              });
              if (next !== messagesRef.current) {
                messagesRef.current = [...next];
                flush();
              }
            } else {
              if (event.wireVersion === 2 && (result.reason === "authority_stale"
                || result.reason === "namespace_unavailable")) {
                retainPendingHumanEvent(event);
                return;
              }
              failVerification();
              if (import.meta.env.DEV) console.warn(
                `[live-shadow] Human peer ${result.operationId} fell back: ${
                  result.reason
                }`,
              );
            }
          })
          .catch((error: unknown) => {
            if (!sameReceivingViewer()) return;
            failVerification();
            console.error(
              "[nautilo-runtime] Human-peer live Shadow receive failed",
              error,
            );
          });
        return;
      }

      if (event.type === "message.shared_agent_shadow") {
        const sibling = humanPeerOrdinarySiblingsRef.current.get(
          event.logicalMessageKey,
        );
        const receiver = sharedAgentLiveShadowMessageReceiver;
        const failVerification = () => {
          const pending = strictPendingHumanEventsRef.current.get(event.logicalMessageKey);
          if (pending === undefined) return;
          const next = settleHumanMessageVerification(messagesRef.current, pending.messageId, { status: "failed" });
          if (next !== messagesRef.current) {
            messagesRef.current = [...next];
            flush();
          }
        };
        if (event.wireVersion === 1 && sibling === undefined) {
          retainPendingHumanEvent(event);
          return;
        }
        if (receiver === undefined) { failVerification(); return; }
        const pending = strictPendingHumanEventsRef.current.get(
          event.logicalMessageKey,
        );
        humanPeerOrdinarySiblingsRef.current.delete(event.logicalMessageKey);
        liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current
          .then(async () => {
            if (!sameReceivingViewer()) return;
            const result = await receiver.receive(event, sibling);
            if (!sameReceivingViewer()) return;
            if (result === null) { failVerification(); return; }
            if (result.status === "verified") {
              pendingHumanShadowEventsRef.current.delete(event.logicalMessageKey);
              strictPendingHumanEventsRef.current.delete(
                event.logicalMessageKey,
              );
              if (event.wireVersion === 2) {
                const projection = event.protectedMessage.projection;
                if (threadRoomRegistrationRef.current?.roomId === projection.roomId) {
                  const projected = projectVerifiedFullHumanEvent(projection, result.payload.content, event.logicalMessageKey);
                  protectedProjectedEventsRef.current.add(projected);
                  projectedLiveShadowEventRef.current(projected);
                  return;
                }
                if (activeRoomIdRef.current !== projection.roomId) return;
                const next = reconcileVerifiedFullHumanMessage(
                  messagesRef.current, projection, result.payload.content,
                  event.logicalMessageKey, receivingViewer,
                );
                if (next !== messagesRef.current) {
                  messagesRef.current = [...next];
                  flush();
                  recordLiveRoomMessage(projection.roomId, result.messageId);
                  scheduleCacheWrite(projection.roomId);
                }
                return;
              }
              if (pending !== undefined && threadRoomRegistrationRef.current?.roomId
                === roomIdFromLaneKey(pending.laneKey, laneKeyToRoomIdRef.current)) {
                const projected = { ...pending, content: result.payload.content };
                protectedProjectedEventsRef.current.add(projected);
                projectedLiveShadowEventRef.current(projected);
                return;
              }
              const reconciled = pending === undefined
                ? messagesRef.current
                : reconcileCanonicalHumanMessage(
                  messagesRef.current,
                  {
                    messageId: pending.messageId,
                    createdAt: pending.createdAt,
                    content: result.payload.content,
                    sourceUserId: pending.sourceUserId!,
                    logicalMessageKey: event.logicalMessageKey,
                    ...(typeof pending.editRevision === "number"
                      ? { editRevision: pending.editRevision }
                      : {}),
                    ...(typeof pending.replyToMessageId === "number"
                      ? { replyToMessageId: pending.replyToMessageId }
                      : {}),
                    ...(pending.artifacts === undefined
                      ? {}
                      : { artifacts: pending.artifacts }),
                  },
                  viewerKeyRef.current,
                );
              const next = settleHumanMessageVerification(reconciled, result.messageId, {
                status: "verified", content: result.payload.content,
              });
              if (next !== messagesRef.current) {
                messagesRef.current = [...next];
                flush();
              }
            } else {
              if (event.wireVersion === 2 && (result.reason === "authority_stale"
                || result.reason === "namespace_unavailable")) {
                retainPendingHumanEvent(event);
                return;
              }
              failVerification();
              if (import.meta.env.DEV) console.warn(
                `[live-shadow] Shared-Agent Human ${result.operationId} fell back: ${
                  result.reason
                }`,
              );
            }
          })
          .catch((error: unknown) => {
            if (!sameReceivingViewer()) return;
            failVerification();
            console.error(
              "[nautilo-runtime] Shared-Agent Human live Shadow receive failed",
              error,
            );
          });
        return;
      }

      if (
        event.type === "message.shared_agent_stream_start"
        || event.type === "message.shared_agent_stream_frame"
        || event.type === "message.shared_agent_output_shadow"
      ) {
        const receiver = sharedAgentOutputLiveShadowReceiver;
        if (receiver === undefined) return;
        liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current
          .then(async () => {
            if (!sameReceivingViewer()) return;
            const result = await receiver.receive(event);
            if (!sameReceivingViewer()) return;
            if (result === null) return;
            for (const projected of projectLiveShadowMessageResult({
              event,
              result,
            })) {
              if (result.status !== "failed") protectedProjectedEventsRef.current.add(projected);
              projectedLiveShadowEventRef.current(projected);
            }
          })
          .catch((error: unknown) => {
            console.error(
              "[nautilo-runtime] Shared-Agent output receive failed",
              error,
            );
          });
        return;
      }

      if (isProtectedMessageRealtimeEventV2(event)) {
        if (event.type !== "message.updated" || roomHistoryShadowReadAdapter === undefined) return;
        const roomId = event.message.projection.roomId;
        const viewer = viewerKeyRef.current;
        const viewerGeneration = viewerGenerationRef.current;
        const origin = serverOriginRef.current;
        const current = (): boolean => sameReceivingViewer()
          && (activeRoomIdRef.current === roomId || threadRoomRegistrationRef.current?.roomId === roomId)
          && viewerKeyRef.current === viewer
          && viewerGenerationRef.current === viewerGeneration
          && serverOriginRef.current === origin;
        if (!current()) return;
        const reader = roomHistoryShadowReadAdapter;
        liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current
          .then(async () => {
            if (!current()) return;
            const updated = await readProtectedMessageUpdate({
              event,
              reader,
              loadSidecar: () => apiClient.getRoomMessageShadowRead({
                roomId,
                intent: reader.createIntent(),
                coordinate: {
                  sessionId: event.message.projection.sessionId,
                  messageId: Number(event.message.projection.messageId),
                  editRevision: event.editRevision,
                  role: event.message.projection.role,
                  logicalMessageKey: event.logicalMessageKey,
                },
              }),
            });
            if (!current()) return;
            if (threadRoomRegistrationRef.current?.roomId === roomId) {
              if (typeof updated.editedAt !== "string") throw new Error("Protected edit timestamp unavailable");
              const projected = {
                type: "message.updated" as const, laneKey: event.laneKey,
                logicalMessageKey: event.logicalMessageKey, content: updated.content,
                editRevision: event.editRevision, editedAt: updated.editedAt,
              };
              protectedProjectedEventsRef.current.add(projected);
              projectedLiveShadowEventRef.current(projected);
              return;
            }
            const next = mergeProtectedMessageUpdate(messagesRef.current, updated);
            if (next === messagesRef.current) return;
            messagesRef.current = [...next];
            for (const message of next) {
              if (message.metadata?.custom?.logicalMessageKey === updated.logicalMessageKey) {
                recordLiveRoomMessage(roomId, String(message.id));
              }
            }
            flush();
            scheduleCacheWrite(roomId);
          })
          .catch((error: unknown) => {
            console.warn("[nautilo-runtime] Protected edit verification unavailable", classifyDataOperationFailure(error));
          });
        return;
      }

      if (event.type === "connected_web.action_attention") {
        // This event is requester-private and may arrive while its Room is not
        // foregrounded. Buffer/attach it to only the exact lane + tool now so
        // returning to that Room does not lose the sign-in intervention.
        applyConnectedWebActionAttention(event);
        return;
      }
      if (event.type === "connected_web.action_resume_failed") {
        applyConnectedWebActionResumeFailed(event);
        return;
      }

      // D420 R12 — maintenance is global server truth, never room-scoped.
      // Apply it before the room-routing gate so a future routing change cannot
      // hide the applying snapshot that protects planned replacement reconnects.
      if (event.type === "maintenance.status") {
        applyMaintenanceStatus(event);
        return;
      }

      if ((event as { type?: string }).type === "live-mini-app.session.closed") {
        const closed = event as unknown as {
          type: "live-mini-app.session.closed";
          sessionId: string;
          reason: "relay_disconnected" | "session_closed";
        };
        if (clearLiveMiniAppSessionIfMatches(closed.sessionId)) {
          publishLiveAppSessionClosed({
            sessionId: closed.sessionId,
            reason: closed.reason,
          });
        }
        return;
      }

      // D426 — focus is shared room state rather than child transcript state.
      // Publish the displayed child's requester-private focus signal before
      // the active-parent gate, which correctly rejects all other child frames.
      const threadRoomRegistration = threadRoomRegistrationRef.current;
      if (isConfidentialRoomEvent(event) && !consumedRoomEventsRef.current.has(event)) {
        const forChild = threadRoomRegistration !== null && shouldRouteEventToThreadRoom(
          threadRoomRegistration, event,
          (laneKey) => roomIdFromLaneKey(laneKey, laneKeyToRoomIdRef.current),
        );
        if (!forChild && !shouldApplyWsEventForActiveRoom({
          event, activeRoomId: activeRoomIdRef.current,
          laneKeyToRoomId: laneKeyToRoomIdRef.current,
          jobIdToRoomId: jobIdToRoomIdRef.current,
          lastStreamLaneKey: lastStreamLaneKeyRef.current,
        })) return;
        const verified = protectedProjectedEventsRef.current.has(event);
        // Shadow authentication compares the ordinary sibling, but only the
        // owner below may admit that body for display. This shared backlog is
        // also used by child Rooms; do not create an ordinary-only child path.
        if (!verified && event.type === "message.new"
          && (event.role === "user" || event.role === "human")
          && event.logicalMessageKey && typeof event.sourceUserId === "string") {
          for (const backlog of [humanPeerOrdinarySiblingsRef.current, strictPendingHumanEventsRef.current]) {
            if (!backlog.has(event.logicalMessageKey) && backlog.size >= 128) {
              const oldest = backlog.keys().next().value;
              if (oldest !== undefined) backlog.delete(oldest);
            }
          }
          humanPeerOrdinarySiblingsRef.current.set(event.logicalMessageKey,
            Object.freeze({ role: "user", content: event.content }));
          strictPendingHumanEventsRef.current.set(event.logicalMessageKey, event);
          const pendingShadow = pendingHumanShadowEventsRef.current.get(event.logicalMessageKey);
          if (pendingShadow !== undefined) {
            pendingHumanShadowEventsRef.current.delete(event.logicalMessageKey);
            projectedLiveShadowEventRef.current(pendingShadow);
          }
        }
        void roomMessageOperations.consumeRealtime(event, verified).then((accepted) => {
          if (!sameReceivingViewer()) return;
          consumedRoomEventsRef.current.add(accepted);
          projectedLiveShadowEventRef.current(accepted);
        }).catch((error: unknown) => {
          // Waiting is normal convergence. No body is sent to either reducer
          // until the verified projection arrives through this same boundary.
          if (classifyDataOperationFailure(error) !== "key_waiting") {
            console.warn("[nautilo-runtime] Room event unavailable", classifyDataOperationFailure(error));
          }
        });
        return;
      }
      if (
        threadRoomRegistration &&
        shouldPublishThreadRoomFocusEvent(
          threadRoomRegistration,
          event,
          (laneKey) => roomIdFromLaneKey(laneKey, laneKeyToRoomIdRef.current),
        )
      ) {
        publishConductorFocusChanged(event);
        return;
      }

      // D426 — a thread drawer is a second view over this one runtime, not a
      // second runtime. Route a known child frame before the active-parent
      // gate and return so it can never mutate parent transcript/job state.
      // The registration admits only the displayed child and fail-closes
      // lane-less events except known job terminals.
      if (threadRoomRegistration && shouldRouteEventToThreadRoom(
        threadRoomRegistration,
        event,
        (laneKey) => roomIdFromLaneKey(laneKey, laneKeyToRoomIdRef.current),
      )) {
        if (
          event.type === "message.new" &&
          (event.role === "user" || event.role === "human") &&
          typeof event.sourceUserId === "string" && event.sourceUserId.length > 0
        ) {
          const roomId = roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current);
          if (roomId) publishTypingCommitted({ roomId, userId: event.sourceUserId });
        }
        threadRoomRegistration.ingestEvent(
          event,
          (laneKey) => roomIdFromLaneKey(laneKey, laneKeyToRoomIdRef.current),
        );
        const mirroredParentAnchorEdit =
          event.type === "message.updated" &&
          roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current) ===
            threadRoomRegistration.parentRoomId;
        if (!mirroredParentAnchorEdit) return;
      }

      const routed = shouldApplyWsEventForActiveRoom({
        event,
        activeRoomId: activeRoomIdRef.current,
        laneKeyToRoomId: laneKeyToRoomIdRef.current,
        jobIdToRoomId: jobIdToRoomIdRef.current,
        lastStreamLaneKey: lastStreamLaneKeyRef.current,
      });
      if (!routed) {
        return;
      }

      switch (event.type) {
        case "thread.summary.changed": {
          // The generic active-room gate runs above. Keep an explicit parent
          // check here because summary frames are snapshots for a parent
          // anchor, never global deltas and never child-room traffic.
          const parentRoomId = roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current);
          if (!parentRoomId || parentRoomId !== activeRoomIdRef.current) break;

          const next = applyThreadSummarySnapshot(
            messagesRef.current,
            event,
          );
          if (next === messagesRef.current) break;
          messagesRef.current = next;
          flush();
          break;
        }

        case "job.dispatched": {
          setTurnStopStatus((current) =>
            current.state === "stopped"
              ? { state: "idle", attemptId: current.attemptId }
              : current,
          );
          const rid = roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current);
          if (rid) {
            jobIdToRoomIdRef.current.set(event.jobId, rid);
            for (const virtualJobId of event.virtualJobIds) {
              virtualJobIdToRoomIdRef.current.set(virtualJobId, rid);
            }
            trimBoundedStringMap(jobIdToRoomIdRef.current, liveJobIdsRef.current);
            trimBoundedStringMap(virtualJobIdToRoomIdRef.current);
          }
          // M147 — track this as a live job (main turn or fork) so STOP can abort it.
          liveJobIdsRef.current.add(event.jobId);
          // D341 — if the user clicked Stop while this turn was still only a
          // coalesced virtual id, consume that pending intent as soon as the
          // server maps the virtual id(s) to the real persisted job id.
          const shouldStopDispatchedJob =
            (rid && pendingStopRoomIdsRef.current.has(rid)) ||
            event.virtualJobIds.some((id) => pendingStopVirtualJobIdsRef.current.has(id));
          if (shouldStopDispatchedJob) {
            if (rid) pendingStopRoomIdsRef.current.delete(rid);
            for (const virtualJobId of event.virtualJobIds) {
              pendingStopVirtualJobIdsRef.current.delete(virtualJobId);
              virtualJobIdToRoomIdRef.current.delete(virtualJobId);
            }
          }
          // D302/P4 — group-room sends return HTTP 202 with jobId=null because
          // conductor routing/wake happens after optimistic delivery. The later
          // job.dispatched frame is therefore the first reliable response-start
          // signal for the floating "Genie is responding" affordance.
          if (!shouldStopDispatchedJob) {
            clearAgentStreamingVisibleOutput();
            setIsRunning(true);
          }
          if (handleRoomPanelJobDispatched({ jobId: event.jobId, roomId: rid })) {
            tickRoomSidebar();
          }
          if (shouldStopDispatchedJob) {
            stopKnownJobIds([event.jobId]);
          }
          break;
        }

        case "job.coalesced":
          break;

        case "message.tokens": {
          lastStreamLaneKeyRef.current = event.laneKey;
          const tokenTurnId = (event as { turnId?: string }).turnId;
          const key = streamKey({
            assistantMessageKey: event.assistantMessageKey,
            turnId: tokenTurnId,
            laneKey: event.laneKey,
            authorAgentId: event.authorAgentId,
          });
          const laneAuthorKey = laneAuthorStreamLookupKey(event);
          if (event.content) {
            const custom = {
              ...(typeof event.authorAgentId === "string" && event.authorAgentId.length > 0
                ? { authorAgentId: event.authorAgentId }
                : {}),
              ...(event.assistantMessageKey
                ? { assistantMessageKey: event.assistantMessageKey }
                : {}),
            };
            const applied = applyTokensContentChunk({
              streams: streamsRef.current,
              key,
              content: event.content,
              newBubbleId: newMessageId("assistant"),
            });
            if (applied.createdBubble) {
              addMessage({
                id: applied.bubbleId,
                role: "assistant",
                content: [{ type: "text", text: "" }],
                ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
              });
            }
            updateMessageById(applied.bubbleId, applied.acc);
            streamKeyByLaneAuthorRef.current.set(laneAuthorKey, key);
            markAgentStreamingVisibleOutputActive();
          }
          if (event.done) {
            let { bubbleId, acc } = finalizeTokensDone({
              streams: streamsRef.current,
              key,
            });
            if (!bubbleId) {
              const fallbackKey = streamKeyByLaneAuthorRef.current.get(laneAuthorKey);
              if (fallbackKey && fallbackKey !== key) {
                ({ bubbleId, acc } = finalizeTokensDone({
                  streams: streamsRef.current,
                  key: fallbackKey,
                }));
              }
            }
            if (bubbleId) {
              updateMessageById(bubbleId, acc);
            }
            streamKeyByLaneAuthorRef.current.delete(laneAuthorKey);
            clearAgentStreamingVisibleOutput();
            setModelFallbackStatus(null);
            // D313 — isRunning tracks live job lifetime; per-message done is not turn end.
            // ISSUE-D145 — finalized assistant turn; mirror to disconnect
            // cache for the active room (debounced).
            scheduleCacheWrite(activeRoomIdRef.current);
          }
          break;
        }

        case "message.new": {
          lastStreamLaneKeyRef.current = event.laneKey;
          if (event.workcardContinuation?.kind === "advanced_video") {
            const reconciled = reconcileAdvancedVideoWorkcardMessage(messagesRef.current, {
              messageId: event.messageId,
              content: event.content,
              continuation: event.workcardContinuation,
            });
            if (reconciled !== messagesRef.current) {
              messagesRef.current = [...reconciled];
              flush();
            }
            const roomId = roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current);
            if (roomId) recordLiveRoomMessage(roomId, event.messageId);
            scheduleCacheWrite(activeRoomIdRef.current);
            break;
          }
          if (
            event.role === "ai" &&
            event.content
          ) {
            const artifacts = dedupeMessageArtifactOpenRefs(event.artifacts);
            const custom = {
              ...(event.createdAt ? { sentAt: event.createdAt } : {}),
              ...(typeof event.authorAgentId === "string" && event.authorAgentId.length > 0
                ? { authorAgentId: event.authorAgentId }
                : {}),
              ...(typeof event.authorHarnessId === "string" && event.authorHarnessId.length > 0
                ? { authorHarnessId: event.authorHarnessId }
                : {}),
              ...(event.assistantMessageKey
                ? { assistantMessageKey: event.assistantMessageKey }
                : {}),
              ...(artifacts !== undefined
                ? { [MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY]: artifacts }
                : {}),
            };
            // M158 — the runtime now emits `message.new` for the agent's visible
            // reply (to drive the unread dot). For the ACTIVE viewer that reply
            // already rendered via streaming, so reconcile the just-streamed
            // bubble's id to the DB id instead of adding a duplicate. If no
            // matching streamed bubble exists (e.g. task report-back, cold
            // load), fall through to append.
            const aiMsgs = messagesRef.current;
            const realIdx = findAssistantReconcileIndex({
              messages: aiMsgs,
              content: event.content,
              authorAgentId: event.authorAgentId,
              assistantMessageKey: event.assistantMessageKey,
            });
            if (realIdx >= 0) {
              const reconciled = reconcileAssistantDurableMessage({
                messages: aiMsgs,
                index: realIdx,
                messageId: event.messageId,
                custom,
              });
              if (reconciled !== aiMsgs) {
                messagesRef.current = [...reconciled];
                flush();
              }
              const roomId = roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current);
              if (roomId) recordLiveRoomMessage(roomId, event.messageId);
              // D313 — reconcile id only; isRunning stays true until terminal job.status.
              break;
            }
            addMessage({
              id: event.messageId,
              role: "assistant",
              content: [{ type: "text", text: event.content }],
              ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
            });
            const roomId = roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current);
            if (roomId) recordLiveRoomMessage(roomId, event.messageId);
            // D313 — non-streamed assistant message.new; job may still be live.
            break;
          }
          if (
            (event.role === "user" || event.role === "human") &&
            event.content &&
            typeof event.sourceUserId === "string" &&
            event.sourceUserId.length > 0
          ) {
            const reconciled = reconcileCanonicalHumanMessage(
              messagesRef.current,
              {
                messageId: event.messageId,
                createdAt: event.createdAt,
                content: event.content,
                sourceUserId: event.sourceUserId,
                ...(event.logicalMessageKey
                  ? { logicalMessageKey: event.logicalMessageKey }
                  : {}),
                ...(typeof event.editRevision === "number"
                  ? { editRevision: event.editRevision }
                  : {}),
                ...(typeof event.replyToMessageId === "number"
                  ? { replyToMessageId: event.replyToMessageId }
                  : {}),
                ...(event.artifacts !== undefined
                  ? { artifacts: event.artifacts }
                  : {}),
              },
              viewerKeyRef.current,
            );
            if (reconciled !== messagesRef.current) {
              messagesRef.current = [...reconciled];
              flush();
            }
            const roomId = roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current);
            if (roomId) recordLiveRoomMessage(roomId, event.messageId);
            // D459 — a persisted human message is decisive evidence that this
            // author stopped composing. The usual decay remains the fallback
            // for abandoned drafts or a lost commit frame.
            if (roomId) {
              publishTypingCommitted({ roomId, userId: event.sourceUserId });
            }
          }
          // ISSUE-D145 — both ai and user `message.new` events can
          // commit finalized state (the assistant case appends a
          // bubble; user case is a no-op for messagesRef but the
          // server has acknowledged the turn). Schedule a cache
          // write so the disconnect frame stays current.
          scheduleCacheWrite(activeRoomIdRef.current);
          break;
        }

        case "message.updated": {
          const next = applyMessageUpdatedInList(messagesRef.current, event);
          if (next !== messagesRef.current) {
            messagesRef.current = [...next];
            flush();
            scheduleCacheWrite(activeRoomIdRef.current);
          }
          break;
        }

        case "profile.updated": {
          // ProfileProvider listens for this browser event and re-fetches the
          // full authenticated profile. Without this bridge, Settings can show
          // a stale Agent default model even after the server has saved it and
          // foreground turns are already using the new model.
          window.dispatchEvent(new Event("nautilo:profile-changed"));
          break;
        }

        case "tool.start": {
          // D212 P0 — the agent `react` tool surfaces as a reaction strip
          // on the target message (via reaction.added / inlined GET), NOT
          // as a thread tool card or an activity-feed row. Drop it before
          // it becomes a tool-call part (a nulled renderer would still
          // leave a non-text part and render an empty assistant bubble).
          if (event.toolName === "react") break;
          // Reconnect/replay may repeat a lifecycle start. For tools with
          // bounded live observations, retaining accepted offsets and the
          // Human's collapse preference is safer than replacing them with a
          // fresh empty activity row.
          const existingActivity = toolActivityByIdRef.current.get(event.toolCallId);
          if (
            (event.toolName === "run_shell" || event.toolName === "structured_ssh_exec" || event.toolName === "structured_ssh_copy_upload" || event.toolName === "structured_ssh_copy_download") &&
            existingActivity?.toolName === event.toolName &&
            existingActivity.status === "running"
          ) {
            break;
          }
          // Tool execution has already crossed the trusted server boundary.
          // The client needs only a bounded display projection: do not admit
          // raw credentials into Assistant UI, activity state, or its cache.
          const parsedArgs = projectToolArgsForCardDisplay(
            parseSerializedToolArgsForDisplay(event.argsSummary),
          );
          const toolCustom =
            typeof event.authorAgentId === "string" && event.authorAgentId.length > 0
              ? { authorAgentId: event.authorAgentId }
              : null;
          addMessage({
            id: `tool-${event.toolCallId}`,
            role: "assistant",
            content: [
              {
                type: "tool-call" as const,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                // assistant-ui expects ReadonlyJSONObject. The canonical
                // display projector returns a newly allocated JSON-like object.
                args: parsedArgs as unknown as Record<string, never>,
              },
            ],
            ...(toolCustom ? { metadata: { custom: toolCustom } } : {}),
          });
          // D057 2a.1.11 — push a "running" entry into the activity log.
          // Cap preserves the newest TOOL_ACTIVITY_CAP entries.
          const interventionBindingKey = event.laneKey
            ? `${event.laneKey}\0${event.toolCallId}`
            : null;
          const pendingIntervention = interventionBindingKey
            ? pendingBrowserResearchInterventionsRef.current.get(interventionBindingKey)
            : undefined;
          const pendingConnectedWebActionAttention = consumePendingAttentionForToolStart(
            pendingConnectedWebActionAttentionRef.current,
            event.toolName,
            event.laneKey,
            event.toolCallId,
          );
          const next: ToolActivityEvent = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: parsedArgs,
            status: "running",
            startedAt: Date.now(),
            ...(event.laneKey ? { laneKey: event.laneKey } : {}),
            ...(event.authorAgentId ? { authorAgentId: event.authorAgentId } : {}),
            ...(event.turnId ? { turnId: event.turnId } : {}),
            ...(pendingIntervention &&
              (pendingIntervention.authorAgentId === undefined || pendingIntervention.authorAgentId === event.authorAgentId)
              ? { browserResearchIntervention: pendingIntervention }
              : {}),
            ...(event.toolName === "act_connected_web_account" && pendingConnectedWebActionAttention
              ? { connectedWebActionAttention: pendingConnectedWebActionAttention }
              : {}),
          };
          toolActivityByIdRef.current.set(event.toolCallId, next);
          setToolActivity((prev) => {
            return [next, ...prev].slice(0, TOOL_ACTIVITY_CAP);
          });
          clearAgentStreamingVisibleOutput();
          break;
        }

        case "tool.end": {
          // D212 P0 — `react` never created a tool-call part or activity
          // entry (see tool.start guard); nothing to finalize here.
          if (event.toolName === "react") break;
          if (event.status !== "error") {
            const proposal = parsePlatformLiveAppProposal(event.result);
            if (proposal) publishLiveAppProposal(proposal);
            if (event.toolName.endsWith("__edit_open_writer")) {
              requestLiveAppProposalReconciliation();
            }
            const committedMutation = liveAppMutationFromToolEnd(event);
            if (committedMutation) publishLiveAppMutationCommitted(committedMutation);
          }
          // D057 2a.1.11 — flip the running entry to ok/error + set end.
          // D083 Phase 2 — also store event.result + resultTruncated
          // so the inline ToolCard's per-tool renderers (run_shell,
          // read_file, grep, etc.) can show actual output instead of
          // the legacy "Done (Xms)" placeholder.
          const activityEntry = toolActivityByIdRef.current.get(event.toolCallId);
          const displayEventResult = preserveComputerUseResultForCard(event.toolName, event.result)
            ?? preserveConnectedAppResultForCard(event.toolName, event.result)
            ?? projectToolResultTextForDisplay(event.result);
          const displayEventError = projectToolResultTextForDisplay(event.error);
          if (event.laneKey) {
            pendingBrowserResearchInterventionsRef.current.delete(`${event.laneKey}\0${event.toolCallId}`);
            for (const [key, attention] of pendingConnectedWebActionAttentionRef.current) {
              if (attention.laneKey === event.laneKey && attention.toolCallId === event.toolCallId) {
                pendingConnectedWebActionAttentionRef.current.delete(key);
              }
            }
          }
          // A registry loss after the dispatch seam is terminal for this
          // observation, but not proof the child completed or stopped. Keep
          // the exact running card and its last provisional bytes frozen;
          // only a later canonical tool.end may replace it.
          if (
            event.toolName === "run_shell" &&
            event.runShellOutcome === "unknown" &&
            activityEntry?.toolName === "run_shell" &&
            activityEntry.status === "running"
          ) {
            const unknownAt = Date.now();
            const unknown = markRunShellOutcomeUnknown(activityEntry, unknownAt);
            toolActivityByIdRef.current.set(event.toolCallId, unknown);
            setToolActivity((prev) => prev.map((entry) =>
              entry.toolCallId === event.toolCallId
                ? markRunShellOutcomeUnknown(entry, unknownAt)
                : entry,
            ));
            break;
          }
          if (activityEntry) {
            toolActivityByIdRef.current.set(event.toolCallId, applyCanonicalToolEndToActivity(
              activityEntry,
              {
                status: event.status,
                endedAt: Date.now(),
                error: event.status === "error" ? (displayEventError ?? "unknown") : undefined,
                ...(displayEventResult !== undefined ? { result: displayEventResult } : {}),
                ...(event.resultTruncated === true ? { resultTruncated: true } : {}),
              },
            ));
          }
          setToolActivity((prev) =>
            prev.map((a) =>
              a.toolCallId === event.toolCallId
                ? applyCanonicalToolEndToActivity(a, {
                    status: event.status,
                    endedAt: Date.now(),
                    error: event.status === "error" ? (displayEventError ?? "unknown") : undefined,
                    ...(displayEventResult !== undefined ? { result: displayEventResult } : {}),
                    ...(event.resultTruncated === true ? { resultTruncated: true } : {}),
                  })
                : a,
            ),
          );
          const msgs = messagesRef.current;
          const toolMsgId = `tool-${event.toolCallId}`;
          const idx = msgs.findIndex((m) => m.id === toolMsgId);
          if (idx >= 0) {
            const existing = msgs[idx];
            const rawContent = existing.content as unknown;
            const firstPart: unknown = Array.isArray(rawContent)
              ? (rawContent as unknown[])[0]
              : undefined;
            type ToolCallPart = {
              type: "tool-call";
              toolCallId?: string;
              toolName: string;
              args?: Readonly<Record<string, unknown>>;
              result?: string;
              isError?: boolean;
            };
            let toolCall: ToolCallPart | null = null;
            if (
              firstPart &&
              typeof firstPart === "object" &&
              "type" in firstPart &&
              (firstPart as { type: unknown }).type === "tool-call"
            ) {
              toolCall = firstPart as ToolCallPart;
            }
            if (toolCall) {
              // D083 Phase 2 — prefer the real tool output for the
              // assistant-ui `result` surface; fall back to the
              // legacy "Done (Xms)" / "Error: ..." synthetic string
              // for older-server clients that don't populate
              // `event.result` yet.
              const realResult = displayEventResult;
              const assistantUiResult =
                event.status === "error"
                  ? (realResult ?? `Error: ${displayEventError ?? "unknown"}`)
                  : (realResult ?? `Done (${event.duration}ms)`);
              messagesRef.current = [
                ...msgs.slice(0, idx),
                {
                  ...existing,
                  content: [
                    {
                      ...toolCall,
                      result: assistantUiResult,
                      isError: event.status === "error",
                    },
                  ],
                } as ThreadMessageLike,
                ...msgs.slice(idx + 1),
              ];
              flush();
            }
          }
          // ISSUE-D145 — tool.end is a finalized event (the tool card
          // has its terminal state). Mirror to cache.
          scheduleCacheWrite(activeRoomIdRef.current);
          break;
        }

        case "reaction.added": {
          // D212 P2 — emoji reaction landed on a message in this room
          // (from a human or an agent's `react` tool). Update the target
          // message's aggregated reactions; the strip renders + animates.
          updateMessageReactions(event.messageId, event.emoji, 1, event.actorId);
          scheduleCacheWrite(activeRoomIdRef.current);
          break;
        }

        case "reaction.removed": {
          updateMessageReactions(event.messageId, event.emoji, -1, event.actorId);
          scheduleCacheWrite(activeRoomIdRef.current);
          break;
        }

        case "message.deleted": {
          // ISSUE-M172 — a room message was hard-deleted; remove it from the
          // active room's message list. Idempotent: removing an already-removed
          // id is a no-op (covers the optimistic-removal + WS-echo race).
          const targetId = String(event.messageId);
          const deletedRoomId = activeRoomIdRef.current;
          // Preserve WS ordering against asynchronous Full opens/history reads.
          // Otherwise a read already in flight could reinsert the deleted row.
          liveShadowReceiveQueueRef.current = liveShadowReceiveQueueRef.current.then(() => {
            if (!sameReceivingViewer()) return;
            for (const [key, pending] of pendingHumanShadowEventsRef.current) {
              if (pending.wireVersion === 2
                && pending.protectedMessage.projection.messageId === targetId) {
                pendingHumanShadowEventsRef.current.delete(key);
              }
            }
            if (activeRoomIdRef.current !== deletedRoomId) return;
            const before = messagesRef.current.length;
            messagesRef.current = messagesRef.current.filter((m) => String(m.id) !== targetId);
            if (messagesRef.current.length !== before) {
              flush();
              scheduleCacheWrite(deletedRoomId);
            }
          });
          break;
        }

        case "model.fallback": {
          // D264 — structured runtime status only. Must not seed/append
          // stream accumulators, update assistant bubbles by id, or create
          // assistant prose (TTS reads voice.* events, not this line).
          setModelFallbackStatus(modelFallbackStatusFromEvent(event));
          break;
        }

        case "job.progress": {
          if (event.kind === "deep-research") {
            setDeepResearchStatus({ jobId: event.jobId, line: event.phase });
          } else if (event.kind === "foreground-context") {
            setForegroundContextStatus((current) =>
              event.detail === "ready"
                ? current?.jobId === event.jobId ? null : current
                : { jobId: event.jobId, line: event.phase },
            );
          }
          break;
        }

        case "job.status": {
          const terminalStatus =
            event.status === "completed" || event.status === "failed" ||
            event.status === "cancelled" || event.status === "timed_out"
              ? event.status
              : null;
          const terminalRoomId = event.laneKey
            ? roomIdFromLaneKey(event.laneKey, laneKeyToRoomIdRef.current)
            : jobIdToRoomIdRef.current.get(event.jobId) ?? null;
          if (
            event.status === "failed" &&
            terminalRoomId !== null &&
            terminalRoomId === activeRoomIdRef.current
          ) {
            setOrdinaryContentAccessRecoveryGeneration((generation) => generation + 1);
          }
          if (terminalStatus !== null && terminalRoomId !== null) {
            // First settle activity bound to this Job or to exact trusted
            // turn/Agent identity carried by an ephemeral resume lifecycle.
            // Older durable Jobs without that metadata use the authenticated
            // Job read below; Room proximity alone is never enough.
            settleToolsMissingFinalReceipt({
              jobId: event.jobId,
              roomId: terminalRoomId,
              ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
              ...(event.authorAgentId === undefined
                ? {}
                : { authorAgentId: event.authorAgentId }),
              status: terminalStatus,
            });
            const exactIdentityCandidates = new Map(
              [...toolActivityByIdRef.current.entries()]
                .filter(([, activity]) =>
                  activity.status === "running" && activity.jobId === undefined &&
                  activity.turnId !== undefined && activity.laneKey !== undefined &&
                  roomIdFromLaneKey(activity.laneKey, laneKeyToRoomIdRef.current) === terminalRoomId
                )
            );
            if (
              exactIdentityCandidates.size > 0 &&
              event.turnId === undefined &&
              !pendingToolJobReconciliationIdsRef.current.has(event.jobId)
            ) {
              pendingToolJobReconciliationIdsRef.current.add(event.jobId);
              void apiClient.getJobStatus(event.jobId).then((jobStatus) => {
                if (!sameReceivingViewer() || activeRoomIdRef.current !== terminalRoomId) return;
                const input = jobStatus.id === event.jobId && jobStatus.input !== null
                  ? jobStatus.input
                  : null;
                const turnId = input && typeof input["turnId"] === "string"
                  ? input["turnId"]
                  : undefined;
                if (turnId === undefined) return;
                const authorAgentId = input && typeof input["agentId"] === "string"
                  ? input["agentId"]
                  : undefined;
                settleToolsMissingFinalReceipt({
                  jobId: event.jobId,
                  roomId: terminalRoomId,
                  turnId,
                  ...(authorAgentId ? { authorAgentId } : {}),
                  status: terminalStatus,
                }, exactIdentityCandidates);
              }).catch(() => undefined).finally(() => {
                pendingToolJobReconciliationIdsRef.current.delete(event.jobId);
              });
            }
          }
          // A native Codex prompt cannot outlive the job that owns it. This
          // is intentionally independent of the active-room filter: the
          // lifecycle map may still hold a request from a room the user has
          // navigated away from, and a terminal event must retire it.
          if (
            event.status === "completed" ||
            event.status === "failed" ||
            event.status === "cancelled" ||
            event.status === "timed_out"
          ) {
            dispatchTrackedCodexRequestLifecycle({ kind: "clear_job", jobId: event.jobId });
          }
          // M147 — any terminal status retires the job from the live set.
          if (
            event.status === "completed" ||
            event.status === "failed" ||
            event.status === "cancelled" ||
            event.status === "timed_out"
          ) {
            liveJobIdsRef.current.delete(event.jobId);
            setDeepResearchStatus((current) =>
              current?.jobId === event.jobId ? null : current,
            );
            setForegroundContextStatus((current) =>
              current?.jobId === event.jobId ? null : current,
            );
          }
          if (event.status === "cancelled") {
            // The terminal WebSocket receipt is stronger and often faster
            // evidence than the room-stop HTTP response. Do not leave the
            // composer latched on its transitional "Stopping" label while
            // that response is still unwinding.
            setTurnStopStatus((current) =>
              current.state === "stopping" || current.state === "queued"
                ? { state: "stopped", attemptId: current.attemptId }
                : current,
            );
            // M147 STOP — the server aborted the run mid-stream. Finalize any
            // partial assistant bubbles in place (keep the streamed text) and
            // detach stream entries so the NEXT turn starts fresh messages.
            for (const entry of finalizeAllStreamsOnCancel({
              streams: streamsRef.current,
            })) {
              updateMessageById(entry.bubbleId, entry.acc);
            }
            streamKeyByLaneAuthorRef.current.clear();
            clearAgentStreamingVisibleOutput();
            setIsRunning(hasLiveJobForActiveRoom());
            setModelFallbackStatus(null);
          }
          if (event.status === "failed") {
            // D141 Phase 1 — render the friendly translator's one-line
            // sentence as the primary error copy. `event.message` is
            // already the friendly sentence — translation happens at
            // the runtime job-loop chokepoint (`packages/runtime/src/job.ts`).
            //
            // The raw upstream-provider blob is intentionally NOT in
            // `job.status`: that event is room-broadcast, and the
            // upstream `error.message` can echo prompt content or
            // model output (cross-user leak). Power-user "Details"
            // disclosure waits for D141-P3's user-scoped error event.
            // See ISSUE-D141 §"Locked Decisions" LD-8. Raw details
            // remain in `server.log` for operator debugging.
            const friendlyText = event.message ?? "Something went wrong reaching the model. Try again in a moment.";
            const messageBody = `**Error:** ${friendlyText}`;
            const failedFinalization = resolveFailedJobStreamFinalization({
              streams: streamsRef.current,
              messageBody,
            });
            streamKeyByLaneAuthorRef.current.clear();
            for (const update of failedFinalization.updates) {
              updateMessageById(update.bubbleId, update.content);
            }
            if (failedFinalization.standaloneError) {
              addMessage({
                id: `error-${event.jobId}`,
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: failedFinalization.standaloneError,
                  },
                ],
              });
            }
            clearAgentStreamingVisibleOutput();
            setIsRunning(hasLiveJobForActiveRoom());
            setModelFallbackStatus(null);
          } else if (event.status === "completed" || event.status === "timed_out") {
            streamsRef.current.clear();
            streamKeyByLaneAuthorRef.current.clear();
            clearAgentStreamingVisibleOutput();
            setIsRunning(hasLiveJobForActiveRoom());
            setModelFallbackStatus(null);
          }
          {
            const roomIdForSidebar =
              activeRoomIdRef.current ?? jobIdToRoomIdRef.current.get(event.jobId) ?? null;
            const outcome = handleRoomPanelJobStatus({
              jobId: event.jobId,
              roomId: roomIdForSidebar,
              status: event.status,
            });
            if (outcome.didMutateOptimistic) {
              tickRoomSidebar();
            }
            if (outcome.shouldRefetchRooms) {
              void roomNav.refreshRooms().then(
                () => {
                  clearRoomPanelMessageCountOptimisticOverlay();
                  tickRoomSidebar();
                },
                () => {
                  tickRoomSidebar();
                },
              );
            }
          }
          break;
        }

        case "voice.audio": {
          voicePlayerRef.current?.handleAudioEvent(event);
          break;
        }

        case "identity.challenge": {
          // `event.mode` selects the submit path:
          //   "verify" (default) → identity-verify-resume
          //   "enrollPin"      → POST /api/auth/pin (first enrollment)
          challengeThreadIdRef.current = event.threadId;
          challengeLaneKeyRef.current = event.laneKey;
          challengeModeRef.current = event.mode ?? "verify";
          challengePreviewKeyRef.current = pendingAttentionPreviewKey(event);
          setPinError(undefined);
          setShowPinDialog(true);
          break;
        }

        case "revisions.state_changed": {
          // D087 Phase 3 §3.10 — merge the per-path snapshot into
          // the map. A zero-count eviction still updates the map
          // (availableRevisions=0, latest=null) so the UI correctly
          // transitions "undo available" → "undo disabled".
          setRevisionState((prev) => ({
            ...prev,
            [event.path]: {
              availableRevisions: event.availableRevisions,
              latest: event.latest,
            },
          }));
          break;
        }

        case "prove_it.challenge": {
          approvalThreadIdRef.current = event.threadId;
          approvalLaneKeyRef.current = event.laneKey;
          approvalChallengeIdRef.current = event.challengeId ?? null;
          approvalPreviewKeyRef.current = pendingAttentionPreviewKey(event);
          setApprovalTools(event.tools);
          setApprovalError(undefined);
          setShowApprovalDialog(true);
          break;
        }

        case "tool.run_shell.progress": {
          const activityEntry = toolActivityByIdRef.current.get(event.toolCallId);
          if (!activityEntry) break;
          const next = applyRunShellProgressEvent(activityEntry, event);
          if (!next) break;
          toolActivityByIdRef.current.set(event.toolCallId, next);
          setToolActivity((prev) => prev.map((entry) =>
            entry.toolCallId === event.toolCallId ? next : entry,
          ));
          break;
        }

        case "tool.structured_ssh.progress": {
          const activityEntry = toolActivityByIdRef.current.get(event.toolCallId);
          if (!activityEntry) break;
          const next = applyStructuredSshProgressEvent(activityEntry, event);
          if (!next) break;
          toolActivityByIdRef.current.set(event.toolCallId, next);
          setToolActivity((prev) => prev.map((entry) =>
            entry.toolCallId === event.toolCallId ? next : entry,
          ));
          break;
        }

        case "approval.ask": {
          // D061 Phase 2-client — graduated ask-verb approval. Inline
          // above the composer (ApprovalAskDock), not a centered modal.
          //
          // ISSUE-D440 — the dock is driven by the pure approval
          // lifecycle reducer. We arm the pending ask (the reducer's
          // late/duplicate guard ignores any `approvalId` already in
          // the terminal set, so a stale ask cannot reopen a resolved
          // approval) and mirror threadId/laneKey into refs for the
          // submit callback.
          if (!shouldQueueApprovalAsk(approvalLifecycleRef.current, event.approvalId)) {
            settlePendingAttentionPreviewRef.current(pendingAttentionPreviewKey(event));
            break;
          }
          approvalAskThreadIdRef.current = event.threadId;
          approvalAskLaneKeyRef.current = event.laneKey;
          const hasMediaGenerationField = event.mediaGeneration !== undefined;
          const requiresExactReview = event.requiresExplicitReview === true || hasMediaGenerationField;
          const mediaGeneration = isMediaGenerationApproval(event.mediaGeneration)
            ? event.mediaGeneration
            : null;
          const canRenderExactReview = !requiresExactReview ||
            event.localMcpInstall !== undefined || event.structuredSsh !== undefined ||
            mediaGeneration !== null;
          const askPayload: ApprovalAskPayload = {
            ...(activeRoomIdRef.current ? { roomId: activeRoomIdRef.current } : {}),
            approvalId: event.approvalId,
            threadId: event.threadId,
            laneKey: event.laneKey,
            tools: canRenderExactReview ? event.tools : [],
            reason: canRenderExactReview
              ? event.reason
              : "This exact approval needs review details, but they were unavailable. It cannot be approved from this client.",
            reasonCode: event.reasonCode,
            network: event.network ?? null,
            allowedVerbs: !canRenderExactReview
              ? []
              : requiresExactReview
                ? ["once", "deny"]
                : event.allowedVerbs.length > 0
                  ? event.allowedVerbs
                  : ["once", "room", "always", "deny"],
            scopeInfo: event.scopeInfo ?? [],
            localMcpInstall: event.localMcpInstall ?? null,
            mediaGeneration,
            structuredSsh: event.structuredSsh ?? null,
            requiresExplicitReview: requiresExactReview,
          };

          // D375 — Auto-Approve session mode: auto-resolve ask-tier
          // approvals WITHOUT surfacing the dock. Boundary: network-egress
          // asks (`event.network` populated) still surface — network egress
          // stays gated. `prove_it.challenge` / `identity.challenge` are
          // separate cases and remain gated by construction. We reply
          // `"once"` (safest grain: writes NO standing rule, keeps posture
          // ephemeral). On failure we fall back to the dock so the user is
          // never stuck. Boundary lives in `shouldAutoResolveAsk` (pure +
          // unit-tested) — network-egress asks are carved out there.
          //
          // The reducer arms the ask with `silent: true` so the dock
          // does NOT flash before the HTTP reply resolves; on a lost
          // ack `submitError` surfaces it so the user can retry.
          if (
            shouldAutoResolvePendingAttentionAsk({
              recovered: pendingAttentionReplayRef.current,
              enabled: autoApproveRef.current,
              hasNetworkContext: event.network != null,
              requiresExplicitReview: requiresExactReview,
              structuredSshHostTrust: event.structuredSsh?.hostTrust,
            })
          ) {
            pendingAttentionLiveSequenceRef.current += 1;
            dispatchCurrentApprovalLifecycle({ kind: "ask", payload: askPayload, silent: true });
            const previewKey = pendingAttentionPreviewKey(event);
            const roomId = activeRoomIdRef.current;
            const viewerGeneration = viewerGenerationRef.current;
            const scopeGeneration = pendingAttentionUiScopeGenerationRef.current;
            const isCurrentSubmission = () => isPendingAttentionSubmissionCurrent({
              capturedKey: previewKey,
              capturedRoomId: roomId,
              capturedViewerGeneration: viewerGeneration,
              capturedScopeGeneration: scopeGeneration,
              currentKey: approvalLifecycleRef.current.pending === null
                ? null
                : `approval:${approvalLifecycleRef.current.pending.approvalId}`,
              currentRoomId: activeRoomIdRef.current,
              currentViewerGeneration: viewerGenerationRef.current,
              currentScopeGeneration: pendingAttentionUiScopeGenerationRef.current,
            });
            void (async () => {
              try {
                await apiClient.approvalReply(
                  "once",
                  event.threadId,
                  event.laneKey ?? undefined,
                  event.approvalId ?? undefined,
                  undefined,
                  undefined,
                  {
                    clientActionSessionId:
                      currentClientActionSessionIdForResume(),
                    authorizationDeviceId: liveShadowMessageClient?.deviceId,
                  },
                );
                if (!isCurrentSubmission()) return;
                dispatchCurrentApprovalLifecycle({
                  kind: "submitAck",
                  approvalId: event.approvalId,
                  resolution: resolutionFromVerb("once"),
                });
                settlePendingAttentionPreviewRef.current(
                  pendingAttentionPreviewKey(event),
                );
              } catch (err) {
                if (!isCurrentSubmission()) return;
                dispatchCurrentApprovalLifecycle({
                  kind: "submitError",
                  approvalId: event.approvalId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            })();
            break;
          }

          dispatchCurrentApprovalLifecycle({ kind: "ask", payload: askPayload });
          break;
        }

        case "codex.request": {
          // Requests are owner-private at the server boundary. Keep every
          // admitted request in the bounded local map so navigating back to
          // an owned Room can reveal its pending card; the context projection
          // below filters rendering to the currently displayed Room. Never
          // infer a room from task/job ids.
          if (isCodexRequestForViewer(event, viewerKeyRef.current)) {
            dispatchTrackedCodexRequestLifecycle({ kind: "arm", event });
          }
          break;
        }

        case "codex.request.resolved": {
          // This acknowledgement is authoritative after the driver accepts a
          // response. It is harmless after our optimistic accepted-receipt
          // clear and is required for another client/tab's response path.
          if (isCodexOwner(event.ownerId, viewerKeyRef.current)) {
            dispatchTrackedCodexRequestLifecycle({ kind: "resolved", requestId: event.requestId });
          }
          break;
        }

        case "approval.resolved": {
          // ISSUE-D440 — authoritative approval terminal event. When
          // the server emits this for the currently-pending approval
          // id, the reducer clears the dock exactly once and records
          // the id as terminal so a late/duplicate ask cannot reopen
          // it. A resolution for a stale/different id only records
          // terminality (it must not wipe a newer pending ask).
          //
          // The D440 server producer emits this requester-private
          // event after the canonical main-thread or Task resume
          // settles. That makes lost-ack reconciliation authoritative;
          // submit-error remains conservative until this event arrives.
          dispatchCurrentApprovalLifecycle({
            kind: "resolved",
            approvalId: event.approvalId,
            resolution: event.resolution,
            source: "server-event",
          });
          settlePendingAttentionPreviewRef.current(`approval:${event.approvalId}`);
          break;
        }

        case "policy.changed": {
          window.dispatchEvent(new CustomEvent("nautilo:policy-changed", {
            detail: event,
          }));
          break;
        }

        case "room_members_changed": {
          window.dispatchEvent(
            new CustomEvent("nautilo:room-members-changed", {
              detail: {
                roomId: event.roomId,
                ...(event.recipientSyncNamespaceId === undefined
                  ? {}
                  : {
                    recipientSyncNamespaceId:
                      event.recipientSyncNamespaceId,
                  }),
              },
            }),
          );
          break;
        }

        case "room.catalog.changed": {
          window.dispatchEvent(new CustomEvent("nautilo:room-catalog-changed"));
          break;
        }

        case "room.notification.changed":
        case "notification.message.important": {
          for (const listener of notificationEventListenersRef.current) {
            listener(event);
          }
          break;
        }

        case "room.silence.changed": {
          window.dispatchEvent(
            new CustomEvent("nautilo:room-silence-changed", {
              detail: { roomId: event.roomId, silence: event.silence },
            }),
          );
          break;
        }

        case "room.conductor_mode.changed": {
          window.dispatchEvent(
            new CustomEvent("nautilo:room-conductor-mode-changed", {
              detail: { roomId: event.roomId, conductorMode: event.conductorMode },
            }),
          );
          break;
        }

        case "conductor.ask_user": {
          // D279 Phase 4 — Conductor couldn't attribute the message to one bot;
          // surface the disambiguation picker. Wakes no bot; the helper holds
          // { options, messageId, roomId } for the composer strip + held-dots.
          consumeConductorAskUserWsEvent({
            event,
            viewerUserId: authRef.current.viewer.sessionUserId,
            viewerActorId: authRef.current.viewer.sessionActorId,
            activeRoomId: activeRoomIdRef.current,
            laneKeyToRoomId: laneKeyToRoomIdRef.current,
            jobIdToRoomId: jobIdToRoomIdRef.current,
            lastStreamLaneKey: lastStreamLaneKeyRef.current,
          });
          break;
        }

        case "conductor.focus_changed": {
          publishConductorFocusChanged(event);
          break;
        }

        case "conductor.routing": {
          window.dispatchEvent(
            new CustomEvent("nautilo:conductor-routing", {
              detail: {
                roomId: event.roomId,
                userActorId: event.userActorId,
                state: event.state,
              },
            }),
          );
          break;
        }

        case "typing.ping": {
          window.dispatchEvent(
            new CustomEvent("nautilo:typing-ping", {
              detail: {
                roomId: event.roomId,
                userId: event.userId,
                displayName: event.displayName,
              },
            }),
          );
          break;
        }

        case "task.fired":
        case "task.awaiting_reply":
        case "task.progress": {
          taskStateBridgeRef.current?.applyWsEvent(event);
          break;
        }
        case "task.status": {
          taskStateBridgeRef.current?.applyWsEvent(event);
          if (event.status === "awaiting") requestLiveAppProposalReconciliation();
          if (
            event.status === "completed" ||
            event.status === "errored" ||
            event.status === "cancelled"
          ) {
            dispatchTrackedCodexRequestLifecycle({ kind: "clear_task", taskId: event.taskId });
          }
          break;
        }
        case "task.completed":
        case "task.errored": {
          taskStateBridgeRef.current?.applyWsEvent(event);
          dispatchTrackedCodexRequestLifecycle({ kind: "clear_task", taskId: event.taskId });
          break;
        }
      }
    },
    [
      addMessage,
      dispatchCurrentApprovalLifecycle,
      updateMessageById,
      markAgentStreamingVisibleOutputActive,
      clearAgentStreamingVisibleOutput,
      hasLiveJobForActiveRoom,
      stopKnownJobIds,
      updateMessageReactions,
      flush,
      recordLiveRoomMessage,
      scheduleCacheWrite,
      tickRoomSidebar,
      roomNav,
      dispatchTrackedCodexRequestLifecycle,
      liveShadowMessageReceiver,
      humanPeerLiveShadowMessageReceiver,
      sharedAgentLiveShadowMessageReceiver,
      sharedAgentOutputLiveShadowReceiver,
      liveShadowMessageClient,
      roomHistoryShadowReadAdapter,
      roomMessageOperations,
      applyConnectedWebActionAttention,
      applyConnectedWebActionResumeFailed,
      settleToolsMissingFinalReceipt,
    ],
  );

  projectedLiveShadowEventRef.current = handleWsEvent;

  // The WS client lifecycle is mount-scoped: one socket per mount, NOT
  // per render. `handleWsEvent` is recreated on room change (its deps
  // include `roomNav`, whose context value's identity changes when
  // `activeRoomId` changes). Putting it in this effect's deps caused a
  // full teardown + reconnect on every room navigation — 4 sockets in
  // ~50ms (close+reconnect cascade), the visible "Reconnecting to
  // server…" banner flash, and the gratuitous WS churn the user sees.
  //
  // Fix: stash the handler in a ref kept current by a separate sync
  // effect; the WS effect itself has empty deps so the socket survives
  // every render. Same pattern is canonical for any long-lived
  // subscription whose listener closes over stale state.
  const handleWsEventRef = useRef(handleWsEvent);
  useEffect(() => {
    handleWsEventRef.current = handleWsEvent;
  }, [handleWsEvent]);

  const showRecoveredPendingAttentionPreview = useCallback(
    (queued: QueuedPendingAttentionPreview): void => {
      pendingAttentionReplayRef.current = queued.recovered;
      try {
        handleWsEventRef.current(queued.event);
      } finally {
        pendingAttentionReplayRef.current = false;
      }
    },
    [],
  );
  const enqueueRecoveredPendingAttentionPreviews = useCallback(
    (events: readonly PendingAttentionPreviewEvent[], recovered = true): void => {
      const queuedEvents = events
        .filter((event) => event.type !== "approval.ask"
          || shouldQueueApprovalAsk(approvalLifecycleRef.current, event.approvalId))
        .map((event) => ({
        key: pendingAttentionPreviewKey(event),
        event,
        recovered,
        }));
      const prior = pendingAttentionPreviewQueueRef.current;
      const next = enqueuePendingApprovalPreviews(prior, queuedEvents, (item) => item.key);
      pendingAttentionPreviewQueueRef.current = next;
      if (prior.active === null && next.active !== null) {
        showRecoveredPendingAttentionPreview(next.active);
      }
    },
    [showRecoveredPendingAttentionPreview],
  );
  enqueuePendingAttentionPreviewRef.current = enqueueRecoveredPendingAttentionPreviews;
  const reconcileCanonicalPendingAttentionPreviews = useCallback(
    (events: readonly PendingAttentionPreviewEvent[]): void => {
      const canonical = events
        .filter((event) => event.type !== "approval.ask"
          || shouldQueueApprovalAsk(approvalLifecycleRef.current, event.approvalId))
        .map((event) => ({ key: pendingAttentionPreviewKey(event), event, recovered: true }));
      const reconciled = reconcilePendingApprovalPreviewSnapshot(
        pendingAttentionPreviewQueueRef.current,
        canonical,
        (item) => item.key,
      );
      pendingAttentionPreviewQueueRef.current = reconciled.queue;
      if (reconciled.retainedActive) return;

      pendingAttentionUiScopeGenerationRef.current += 1;
      setShowPinDialog(false);
      setPinError(undefined);
      challengeThreadIdRef.current = null;
      challengeLaneKeyRef.current = null;
      challengePreviewKeyRef.current = null;
      challengeModeRef.current = "verify";
      setShowApprovalDialog(false);
      setApprovalError(undefined);
      setApprovalTools([]);
      approvalThreadIdRef.current = null;
      approvalLaneKeyRef.current = null;
      approvalChallengeIdRef.current = null;
      approvalPreviewKeyRef.current = null;
      dispatchCurrentApprovalLifecycle({ kind: "hide" });
      approvalAskThreadIdRef.current = null;
      approvalAskLaneKeyRef.current = null;
      if (reconciled.queue.active !== null) {
        showRecoveredPendingAttentionPreview(reconciled.queue.active);
      }
    },
    [dispatchCurrentApprovalLifecycle, showRecoveredPendingAttentionPreview],
  );
  settlePendingAttentionPreviewRef.current = (key) => {
    const prior = pendingAttentionPreviewQueueRef.current;
    const next = settlePendingApprovalPreview(prior, (active) => active.key === key);
    pendingAttentionPreviewQueueRef.current = next;
    if (prior.active !== next.active && next.active !== null) {
      showRecoveredPendingAttentionPreview(next.active);
    }
  };
  useEffect(() => {
    pendingAttentionUiScopeGenerationRef.current += 1;
    pendingAttentionPreviewQueueRef.current = initialPendingApprovalPreviewQueue();
  }, [activeRoomId, auth.viewerGeneration, viewerKey]);

  // D513 Phase 3.4 — socket-local automatic actions are consumed before the
  // normal ServerEvent router. Their action IDs live only for this mounted
  // authenticated socket, so reconnect/unmount clearing prevents replay.
  const handleWsControlEvent = useCallback((event: RealtimeControlEvent): void => {
    if (event.type === "client.session.v1") {
      installClientActionSession(event);
      setClientActionSessionGeneration((generation) => generation + 1);
      return;
    }
    if (!isCryptoAdmissionAllowed()) return;
    if (!retainClientUiAction(event)) return;
    void presentWorkbenchApplicationTarget({
      version: GENIE_APPLICATION_BRIDGE_VERSION_V1,
      target: event.target,
      presentation: event.presentation,
    }, {
      availability: {
        isVerified: auth.viewer?.isVerified ?? true,
        capabilities: auth.viewer?.capabilities ?? [],
        isDesktopShell: isDesktop && desktopAPI !== null,
        isSelfManaged: setupStatus?.providers?.managedByCloud === false,
      },
      navigate,
      customization: {
        hasDesktopBridge: isDesktop && desktopAPI !== null,
        onboardingOpen: desktopAPI?.onboarding.open,
        getAccessToken: () => auth.session.getAccessToken(),
        getTheme: () => readWorkbenchTheme((key) => {
          try { return localStorage.getItem(key); } catch { return null; }
        }),
      },
    });
  }, [auth.session, auth.viewer?.capabilities, auth.viewer?.isVerified, navigate, setupStatus?.providers?.managedByCloud]);
  const handleWsControlEventRef = useRef(handleWsControlEvent);
  useEffect(() => {
    handleWsControlEventRef.current = handleWsControlEvent;
  }, [handleWsControlEvent]);

  // D441 — mirror `wsState` into a ref so the outbound typing-ping
  // sender closure can read the live transport state without being
  // re-installed on every transport transition (same pattern as
  // `handleWsEventRef` above). `wsState === "open"` is only reached
  // after `auth.accepted`, so it is the correct "authenticated/open"
  // gate for the drop-when-closed rule.
  const wsStateRef = useRef(wsState);
  useEffect(() => {
    wsStateRef.current = wsState;
  }, [wsState]);

  // Recover the durable, owner-private user-input facts only after the same
  // authenticated WS gate that admits their realtime siblings. A failed GET
  // deliberately leaves the local map untouched; it must not erase a card
  // whose more recent WS frame is still live in this browser.
  useEffect(() => {
    if (!isCryptoAdmissionAllowed()) return;
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    if (!canStartCodexRequestHydration({
      authState,
      viewerKey,
      roomId: activeRoomId,
      wsState,
    })) return;
    // `canStart…` is intentionally a tested policy helper; retain these
    // local narrowing guards so TypeScript keeps the fetch identity strict.
    if (!viewerKey || !activeRoomId) return;
    const baselineRequestIds = codexRequestLifecycleRef.current.order.filter((requestId) => {
      const event = codexRequestLifecycleRef.current.byId[requestId];
      return event?.ownerId === viewerKey &&
        event.roomId === activeRoomId &&
        event.request.kind === "user_input_required";
    });
    const hydration: NonNullable<typeof codexRequestHydrationRef.current> = {
      generation: ++codexRequestHydrationGenerationRef.current,
      viewerKey,
      roomId: activeRoomId,
      liveSequenceAtStart: codexRequestLiveSequenceRef.current,
      baselineRequestIds,
      arrivals: [],
      overflowed: false,
    };
    codexRequestHydrationRef.current = hydration;
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await apiClient.codex.listUserInputRequests(hydration.roomId);
        assertCryptoAdmissionAccess(admissionGeneration);
        // Treat any cross-owner DTO as an invalid response. Do not let it
        // tombstone the current owner's baseline facts by implication.
        if (snapshot.items.some((item) => item.event.ownerId !== hydration.viewerKey)) return;
        if (!canCommitCodexRequestHydration({
          cancelled,
          hydration,
          activeHydration: codexRequestHydrationRef.current,
          viewerKey: viewerKeyRef.current,
          activeRoomId: activeRoomIdRef.current,
          wsState: wsStateRef.current,
          responseRoomId: snapshot.roomId,
        })) return;
        dispatchCodexRequestLifecycle({
          kind: "hydrate_room",
          roomId: hydration.roomId,
          ownerId: hydration.viewerKey,
          items: snapshot.items,
          baselineRequestIds: hydration.baselineRequestIds,
          newerActions: hydration.arrivals.map((arrival) => arrival.action),
        });
      } catch {
        // Keep current cards. The next Room/open/auth transition retries.
      } finally {
        if (codexRequestHydrationRef.current === hydration) {
          codexRequestHydrationRef.current = null;
        }
      }
    })();

    return () => {
      cancelled = true;
      if (codexRequestHydrationRef.current === hydration) {
        codexRequestHydrationRef.current = null;
      }
    };
  }, [activeRoomId, admissionResumeGeneration, authState, viewerKey, wsState]);

  // D441 — install the outbound typing-ping sender. The sender
  // short-circuits (drops the ping) unless the WS is authenticated/
  // open, so the ping never reaches `RealtimeClient.send(...)`'s
  // buffering path and the disconnected outbound queue can never
  // replay stale typing after reconnect. `wsStateRef` and `wsRef` are
  // refs, so they must NOT appear in this effect's deps (the sender
  // closure reads their current values at call time). Cleared on
  // unmount so a hot-reload/teardown cannot call a stale closure.
  useEffect(() => {
    setTypingPingSender((payload) => {
      if (!isCryptoAdmissionAllowed()) return;
      if (wsStateRef.current !== "open" || wsRef.current == null) return;
      wsRef.current.send({
        type: "typing.ping",
        roomId: payload.roomId,
        displayName: payload.displayName,
      });
    });
    return () => {
      setTypingPingSender(null);
    };
  }, []);

  useEffect(() => {
    let openedOnce = false;
    const client = createWsRealtimeClient(WS_URL, {
      onEvent: (event) => {
        const changesActivePendingAttention = changesPendingAttention(event, {
          roomId: activeRoomIdRef.current,
          userId: viewerKeyRef.current,
          laneKeyToRoomId: laneKeyToRoomIdRef.current,
          jobIdToRoomId: jobIdToRoomIdRef.current,
        });
        if (changesActivePendingAttention) {
          pendingAttentionLiveSequenceRef.current += 1;
          setPendingAttentionRecoveryUnavailable(null);
        }
        const previewIngress = pendingAttentionPreviewIngress(
          event,
          changesActivePendingAttention,
        );
        if (previewIngress === "direct") {
          // Preserve M164's owner-scoped Task/subagent attention path. These
          // prompts have task lanes rather than Room lanes and are intentionally
          // excluded from the Room-bound durable checkpoint queue below.
          handleWsEventRef.current(event as PendingAttentionPreviewEvent);
          return;
        }
        if (previewIngress === "enqueue") {
          enqueuePendingAttentionPreviewRef.current(
            [event as PendingAttentionPreviewEvent],
            false,
          );
          return;
        }
        if (previewIngress === "drop") return;
        handleWsEventRef.current(event);
      },
      onControlEvent: (event) => handleWsControlEventRef.current(event),
      onStateChange: (state) => {
        if (state === "open" && openedOnce) requestCryptoAdmissionRefresh("transport_reconnected");
        else if (state !== "open" && wsStateRef.current === "open") requestCryptoAdmissionRefresh("transport_disconnected");
        if (state === "open") openedOnce = true;
        if (state !== "open") clearClientActionSession();
        setWsState(state);
      },
      onError: (err) => console.error("[ws]", err),
      initiatingClientSurface: initiatingClientSurfaceForWorkbench({ isDesktop, desktopAPI }),
      // M058 — first-frame auth handshake. Resolve bearer via Logto
      // (Electron IPC or browser SDK; silent refresh near expiry).
      getToken: async () => {
        try {
          return await authRef.current.session.getAccessToken();
        } catch {
          return null;
        }
      },
      onAuthRejected: (reason) => {
        window.dispatchEvent(
          new CustomEvent("nautilo:auth-rejected", { detail: { reason } }),
        );
      },
    });
    wsRef.current = client;

    // Stack 19 Phase 5.5 hotfix (2026-05-16) — debounced visibility
    // gate; see `ws-visibility-gate.ts` module header for full
    // rationale + the 5-reconnects-in-5-minutes smoke that prompted
    // the fix. Electron skips the gate entirely; browser debounces
    // hidden→suspend by 30s, resume is immediate.
    const handleVisibility = shouldHandleVisibility(desktopAPI !== null);
    const gate = handleVisibility
      ? createVisibilityGate({
          suspend: () => client.suspend(),
          resume: () => {
            client.resume();
          },
          onSuspendedChange: (suspended) => {
            visibilityDisconnectSuppressRef.current = suspended;
            setVisibilityHidden(suspended);
          },
        })
      : null;

    const onVisibilityChange = (): void => gate?.onVisibilityChange();
    if (handleVisibility) {
      document.addEventListener("visibilitychange", onVisibilityChange);
      // Drive the initial snapshot through the gate so a boot-hidden
      // session arms the debounce (rather than suspending instantly).
      gate?.onVisibilityChange();
    } else {
      visibilityDisconnectSuppressRef.current = false;
      setVisibilityHidden(false);
    }

    return () => {
      clearClientActionSession();
      if (handleVisibility) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      gate?.dispose();
      visibilityDisconnectSuppressRef.current = false;
      client.close();
      wsRef.current = null;
    };
    // The WS lifecycle remains mount-scoped because setWsState is a stable
    // useCallback([]); handleWsEvent is reached via handleWsEventRef.
  }, [setWsState]);

  // D530 — select/cache/fence in the layout phase so Room A cannot appear
  // under Room B before the first paint. The server fetch deliberately starts
  // only after that authoritative local projection is installed.
  useLayoutEffect(() => {
    let cancelled = false;
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    const roomForHistory = activeRoomId;
    const origin = serverOrigin;
    const hydrationViewerKey = viewerKey;
    const hydrationViewerGeneration = auth.viewerGeneration;

    if (!roomForHistory || !origin || !hydrationViewerKey) {
      activeRoomHydrationRef.current = null;
      activeInitialHydrationScopeRef.current = null;
      setRoomInitialHydrationState(null);
      lastRehydratedRoomRef.current = undefined;
      messagesRef.current = [];
      setHistoryCursor(null);
      setHasMoreHistoryBefore(false);
      flush();
      return () => { cancelled = true; };
    }

    const backgroundScope = roomHydrationRetry.backgroundScope;
    const backgroundRefresh = Boolean(
      backgroundScope &&
      backgroundScope.origin === origin &&
      backgroundScope.viewerKey === hydrationViewerKey &&
      backgroundScope.viewerGeneration === hydrationViewerGeneration &&
      backgroundScope.roomId === roomForHistory &&
      roomInitialHydrationStateRef.current,
    );

    const generation = ++roomHydrationGenerationRef.current;
    const hydrationRequest: RoomHydrationRequest = {
      roomId: roomForHistory,
      generation,
      liveSequenceAtStart: roomLiveArrivalSequenceRef.current,
    };
    const scope: RoomInitialHydrationScope = {
      origin,
      viewerKey: hydrationViewerKey,
      viewerGeneration: hydrationViewerGeneration,
      roomId: roomForHistory,
      generation,
    };
    const cacheScope: DisconnectCacheScope = {
      serverOrigin: origin,
      viewerKey: hydrationViewerKey,
      roomId: roomForHistory,
    };
    const timing = roomHydrationTimingRef.current.start(generation);
    activeRoomHydrationRef.current = hydrationRequest;
    activeInitialHydrationScopeRef.current = scope;
    pendingTranscriptCommitAckRef.current = null;
    if (!backgroundRefresh) pendingNoTokenScopeRef.current = null;

    // A selected Room receives the C+A pre-paint cache projection. A member
    // refresh is deliberately background-only: it must not tear down active
    // streams, PIN/approval state, or the live transcript it is refreshing.
    if (!backgroundRefresh) {
      lastRehydratedRoomRef.current = undefined;
      setHistoryCursor(null);
      setHasMoreHistoryBefore(false);
      setLoadingHistoryBefore(false);
      streamsRef.current.clear();
      streamKeyByLaneAuthorRef.current.clear();
      setModelFallbackStatus(null);
      setDeepResearchStatus(null);
      clearAgentStreamingVisibleOutput();
      lastStreamLaneKeyRef.current = null;
      setIsRunning(false);
      setShowPinDialog(false);
      setShowApprovalDialog(false);
      dispatchCurrentApprovalLifecycle({ kind: "hide" });
      approvalAskThreadIdRef.current = null;
      approvalAskLaneKeyRef.current = null;
    }

    const cached = backgroundRefresh
      ? null
      : ordinaryDisconnectCache()?.readActiveRoom(cacheScope) ?? null;
    const initialState = transitionRoomInitialHydration(
      beginRoomInitialHydration(scope),
      cached ? { kind: "cache-hit", scope } : { kind: "cache-miss", scope },
    );
    if (!backgroundRefresh) {
      setRoomInitialHydrationState(initialState);
      messagesRef.current = cached ? [...cached.messages] : [];
      flush();
    }

    const isCurrent = (): boolean =>
      !cancelled &&
      isCryptoAdmissionGenerationCurrent(admissionGeneration) &&
      activeRoomIdRef.current === roomForHistory &&
      viewerKeyRef.current === hydrationViewerKey &&
      viewerGenerationRef.current === hydrationViewerGeneration &&
      serverOriginRef.current === origin &&
      activeInitialHydrationScopeRef.current === scope &&
      isLatestRoomHydration(hydrationRequest, activeRoomHydrationRef.current);
    const setStateIfCurrent = (transition: RoomInitialHydrationTransition): void => {
      if (!isCurrent()) return;
      if (!backgroundRefresh) {
        setRoomInitialHydrationState(transitionRoomInitialHydration(initialState, transition));
        return;
      }
      switch (transition.kind) {
        case "server-success":
          setRoomInitialHydrationState({ kind: "ready", scope });
          return;
        case "server-empty":
          setRoomInitialHydrationState({ kind: "empty", scope });
          return;
        case "server-waiting-for-authority":
          setRoomInitialHydrationState({
            kind: "waiting-for-authority",
            scope,
            sendAuthorized: transition.sendAuthorized,
          });
          return;
        case "access-terminal":
          setRoomInitialHydrationState({
            kind: "access-terminal-error",
            scope,
            reason: transition.reason,
          });
          return;
        case "server-failure":
          // A failed background member refresh leaves the accepted live frame
          // intact; no cache is read or used as a replacement candidate.
          return;
        case "cache-hit":
        case "cache-miss":
          return;
      }
    };
    const cancelPendingCacheWrite = (): void => {
      const key = cacheScopeKey(cacheScope);
      const pending = cacheWriteTimersRef.current.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        cacheWriteTimersRef.current.delete(key);
      }
    };
    const complete = (): void => {
      if (activeRoomHydrationRef.current === hydrationRequest) {
        activeRoomHydrationRef.current = null;
      }
      if (pendingNoTokenScopeRef.current === scope) {
        pendingNoTokenScopeRef.current = null;
      }
    };
    const mergeLiveArrivals = (hydrated: readonly ThreadMessageLike[]): readonly ThreadMessageLike[] =>
      mergeHydratedRoomMessages(
        hydrated,
        liveArrivalsSince(hydrationRequest, roomLiveArrivalsRef.current),
      );

    void (async () => {
      try {
        const bearer = await authRef.current.session.getAccessToken();
        if (!isCurrent()) return;
        if (!bearer) {
          const disposition = initialHistoryServerDisposition({ status: "no-token" });
          if (disposition === "pending") {
            // Auth bootstrapping has not reached a terminal history outcome.
            // Retain the honest unresolved/syncing disclosure until the typed
            // auth transition allocates a replacement generation.
            pendingNoTokenScopeRef.current = scope;
            return;
          }
          return;
        }
        timing.tokenReady();
        const result = await restoreRoomReadOutcome(() => roomMessageOperations.readRoomMessages(roomForHistory));
        timing.historyResponse();
        if (!isCurrent()) return;
        if (
          result.status !== "no-token" &&
          shouldDeferBackgroundHistoryProjection({
            backgroundRefresh,
            hasActiveStream: streamsRef.current.size > 0,
            isRunning: isRunningRef.current,
            resultStatus: result.status,
          })
        ) {
          // The stream began after this member-refresh fetch. Leave its live
          // transcript/status untouched; a later authoritative reconcile can
          // safely catch up once the turn is terminal.
          timing.superseded();
          complete();
          return;
        }

        if (result.status === "ok" && result.restored) {
          const reconciled = mergeLiveArrivals(result.restored);
          const waitingForAuthority = roomHistoryWaitsOnlyForKeys(reconciled);
          messagesRef.current = [...reconciled];
          lastRehydratedRoomRef.current = roomForHistory;
          setHistoryCursor(result.pageInfo?.oldestCursor ?? null);
          setHasMoreHistoryBefore(result.pageInfo?.hasMoreBefore === true);
          cancelPendingCacheWrite();
          if (!waitingForAuthority) {
            ordinaryDisconnectCache()?.writeActiveRoom(cacheScope, reconciled);
          }
          const disposition = initialHistoryServerDisposition({
            status: "ok",
            containsUnavailableHistory: waitingForAuthority,
          });
          setStateIfCurrent(disposition === "waiting-for-authority"
            ? { kind: "server-waiting-for-authority", scope, sendAuthorized: true }
            : { kind: "server-success", scope });
          flush();
          drainMountedBackfillPriorityRef.current();
          if (waitingForAuthority) timing.failed();
          else acknowledgeTranscriptAfterLayout(scope, timing, reconciled);
          complete();
          return;
        }

        if (result.status === "empty") {
          const reconciled = mergeLiveArrivals([]);
          messagesRef.current = [...reconciled];
          lastRehydratedRoomRef.current = roomForHistory;
          setHistoryCursor(null);
          setHasMoreHistoryBefore(false);
          cancelPendingCacheWrite();
          ordinaryDisconnectCache()?.writeActiveRoom(cacheScope, reconciled);
          setStateIfCurrent({
            kind: initialHistoryServerDisposition({
              status: "empty",
              reconciledMessageCount: reconciled.length,
            }) === "ready" ? "server-success" : "server-empty",
            scope,
          });
          flush();
          acknowledgeTranscriptAfterLayout(scope, timing, reconciled);
          complete();
          return;
        }

        if (result.status === "unauthorized" || result.status === "not-found") {
          cancelPendingCacheWrite();
          ordinaryDisconnectCache()?.invalidateActiveRoom(cacheScope);
          messagesRef.current = [];
          lastRehydratedRoomRef.current = roomForHistory;
          setHistoryCursor(null);
          setHasMoreHistoryBefore(false);
          setStateIfCurrent({ kind: "access-terminal", scope, reason: result.status });
          flush();
          if (result.status === "unauthorized") authRef.current.latchAccessToken(null);
          timing.failed();
          complete();
          return;
        }

        if (result.status === "failed" && result.failureClass === "key_waiting") {
          setStateIfCurrent({
            kind: "server-waiting-for-authority",
            scope,
            sendAuthorized: false,
          });
          timing.failed();
          complete();
          return;
        }

        const shell = shellStateRef.current;
        const retainCachedFrame = Boolean(cached) && (
          shell.kind === "authenticated_disconnected" ||
          shell.kind === "authenticated_resuming" ||
          shell.kind === "authenticated_connecting"
        );
        if (!retainCachedFrame && !backgroundRefresh) {
          messagesRef.current = [];
          setHistoryCursor(null);
          setHasMoreHistoryBefore(false);
          flush();
        }
        setStateIfCurrent({ kind: "server-failure", scope, retainCachedFrame });
        timing.failed();
        complete();
      } catch {
        if (!isCurrent()) return;
        const shell = shellStateRef.current;
        const retainCachedFrame = Boolean(cached) && (
          shell.kind === "authenticated_disconnected" ||
          shell.kind === "authenticated_resuming" ||
          shell.kind === "authenticated_connecting"
        );
        if (!retainCachedFrame && !backgroundRefresh) {
          messagesRef.current = [];
          setHistoryCursor(null);
          setHasMoreHistoryBefore(false);
          flush();
        }
        setStateIfCurrent({ kind: "server-failure", scope, retainCachedFrame });
        timing.failed();
        complete();
      }
    })();

    return () => {
      cancelled = true;
      timing.superseded();
    };
  }, [
    activeRoomId,
    auth.viewerGeneration,
    acknowledgeTranscriptAfterLayout,
    clearAgentStreamingVisibleOutput,
    dispatchCurrentApprovalLifecycle,
    flush,
    roomHydrationRetry,
    roomMessageOperations,
    serverOrigin,
    viewerKey,
  ]);

  // The durable checkpoint remains the approval authority after hydration or
  // reconnect. Replay only through the ordinary ServerEvent router, and only
  // if no newer live approval/terminal fact arrived during the read.
  useEffect(() => {
    const clientActionSessionId = currentClientActionSessionIdForResume();
    if (!canStartRoomPendingAttentionRecovery({
      authState,
      viewerKey,
      humanActorId: auth.viewer.sessionActorId,
      viewerGeneration: auth.viewerGeneration,
      origin: serverOrigin,
      roomId: activeRoomId,
      wsState,
      clientActionSessionId,
      authorizationDeviceId: pendingAttentionAuthorizationDeviceId,
      history: roomInitialHydrationState,
    })) return;
    const humanActorId = auth.viewer.sessionActorId;
    if (!viewerKey || !humanActorId || !activeRoomId || !clientActionSessionId
      || !pendingAttentionAuthorizationDeviceId) return;
    setPendingAttentionRecoveryUnavailable(null);
    const controller = new AbortController();
    const recoveryGeneration = ++pendingAttentionRecoveryGenerationRef.current;
    const liveSequenceAtStart = pendingAttentionLiveSequenceRef.current;
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    const viewerGeneration = auth.viewerGeneration;
    const roomId = activeRoomId;
    const origin = serverOrigin;
    const isCurrent = (): boolean => !controller.signal.aborted
      && pendingAttentionRecoveryGenerationRef.current === recoveryGeneration
      && pendingAttentionLiveSequenceRef.current === liveSequenceAtStart
      && isCryptoAdmissionGenerationCurrent(admissionGeneration)
      && viewerKeyRef.current === viewerKey
      && viewerGenerationRef.current === viewerGeneration
      && humanActorIdRef.current === humanActorId
      && activeRoomIdRef.current === roomId
      && serverOriginRef.current === origin
      && wsStateRef.current === "open"
      && currentClientActionSessionIdForResume() === clientActionSessionId;

    void (async () => {
      const result = liveShadowMessageClient === undefined
        ? await apiClient.recoverOrdinaryRoomPendingAttention(roomId, {
            clientActionSessionId,
            authorizationDeviceId: pendingAttentionAuthorizationDeviceId,
          }, {
            signal: controller.signal,
            isCurrent,
            expectedUserId: viewerKey,
            expectedHumanActorId: humanActorId,
          })
        : await liveShadowMessageClient.recoverRoomPendingAttention({
            roomId,
            clientActionSessionId,
            signal: controller.signal,
            isCurrent,
          });
      if (!isCurrent()) return;
      if (result.status !== "ready") {
        setPendingAttentionRecoveryUnavailable({
          roomId,
          viewerKey,
          viewerGeneration,
          origin,
          retryable: !isDesktop
            || desktopForegroundShadow?.recoverRoomPendingAttention !== undefined,
        });
        return;
      }
      setPendingAttentionRecoveryUnavailable(null);
      reconcileCanonicalPendingAttentionPreviews(
        result.events.filter(isPendingAttentionPreviewEvent),
      );
    })().catch(() => {
      if (isCurrent()) {
        setPendingAttentionRecoveryUnavailable({
          roomId,
          viewerKey,
          viewerGeneration,
          origin,
          retryable: true,
        });
      }
    });

    return () => {
      controller.abort();
      if (pendingAttentionRecoveryGenerationRef.current === recoveryGeneration) {
        pendingAttentionRecoveryGenerationRef.current += 1;
      }
    };
  }, [
    activeRoomId,
    auth.viewerGeneration,
    auth.viewer.sessionActorId,
    authState,
    clientActionSessionGeneration,
    desktopForegroundShadow,
    reconcileCanonicalPendingAttentionPreviews,
    liveShadowMessageClient,
    pendingAttentionAuthorizationDeviceId,
    pendingAttentionRecoveryRetryGeneration,
    roomInitialHydrationState,
    serverOrigin,
    viewerKey,
    wsState,
  ]);

  useEffect(() => {
    const recipientSync = createDomainKeyRecipientSyncScheduler({
      service: (roomId, namespaceId, keyClass) => {
        if (liveShadowMessageClient === undefined) return Promise.resolve(false);
        return liveShadowMessageClient.serviceDomainKeyRequests(roomId, namespaceId, keyClass);
      },
      onReady: (displayRoomId) => {
        if (authorityWaitingRoomRef.current === displayRoomId) {
          authorityWaitingRoomRef.current = null;
        }
        refreshMountedKeyWaitingHistoryRef.current(displayRoomId);
      },
      schedule: (run) => {
        const timer = setTimeout(run, 5_000);
        return () => clearTimeout(timer);
      },
    });
    recipientSyncSchedulerRef.current = recipientSync;
    const replayRoomId = replayableProtectedHistoryAuthorityDemand({
      observedRoomId: authorityWaitingRoomRef.current,
      activeRoomId: activeRoomIdRef.current,
      recipientSyncReady: liveShadowMessageClient !== undefined,
    });
    if (replayRoomId !== null) {
      requestProtectedRoomAuthorityRef.current(replayRoomId);
    }
    const onAuthChanged = (): void => {
      const pending = pendingNoTokenScopeRef.current;
      if (
        pending &&
        pending.origin === serverOriginRef.current &&
        pending.viewerKey === viewerKeyRef.current &&
        pending.viewerGeneration === viewerGenerationRef.current &&
        pending.roomId === activeRoomIdRef.current
      ) {
        retryRoomInitialHydration();
      }
    };
    const onRoomMembersChanged = (ev: Event): void => {
      const detail = (ev as CustomEvent<{
        roomId?: string;
        recipientSyncNamespaceId?: string;
      }>).detail;
      const roomId = detail?.roomId;
      const recipientSyncNamespaceId = detail?.recipientSyncNamespaceId;
      if (
        roomId
        && recipientSyncNamespaceId
        && liveShadowMessageClient !== undefined
      ) {
        recipientSync.enqueue(roomId, recipientSyncNamespaceId);
      }
      if (roomId && roomId === activeRoomIdRef.current) {
        refreshRoomInitialHydrationInBackground();
      }
    };
    const removeAuthListener = addAuthTransitionListener(onAuthChanged);
    window.addEventListener("nautilo:room-members-changed", onRoomMembersChanged);
    return () => {
      if (recipientSyncSchedulerRef.current === recipientSync) {
        recipientSyncSchedulerRef.current = null;
      }
      recipientSync.dispose();
      removeAuthListener();
      window.removeEventListener("nautilo:room-members-changed", onRoomMembersChanged);
    };
  }, [
    liveShadowMessageClient,
    refreshRoomInitialHydrationInBackground,
    retryRoomInitialHydration,
  ]);

  useEffect(() => {
    if (liveShadowMessageClient === undefined) return;
    if (!shouldDemandProtectedHistoryAuthority({
      admissionReady,
      wsState,
      isRunning,
      activeStreamCount: streamsRef.current.size,
      activeRoomId,
      hydrationState: roomInitialHydrationState,
    })) return;
    if (activeRoomId === null) return;
    requestProtectedRoomAuthorityRef.current(activeRoomId);
  }, [
    activeRoomId,
    admissionReady,
    admissionResumeGeneration,
    isRunning,
    liveShadowMessageClient,
    roomInitialHydrationState,
    wsState,
  ]);

  // Durable Domain delivery is server-backed queue work. Realtime events are
  // only latency hints: a ready device also asks for missed work on initial
  // readiness, reconnect, and Room navigation. The server response is bounded,
  // and the client fulfils only Domains for which it already holds authority.
  useEffect(() => {
    if (!admissionReady || wsState !== "open" || liveShadowMessageClient === undefined) return;
    void liveShadowMessageClient.serviceDomainKeyBacklog();
  }, [activeRoomId, admissionReady, admissionResumeGeneration, liveShadowMessageClient, wsState]);

  // Durable background authorization is discovered from the authenticated
  // API. Realtime carries only a content-free wake hint; mount, each transport
  // state change, admission resume, and foreground readiness all request the
  // same coalesced full sweep. A wake received during a sweep leaves another
  // pass pending.
  useEffect(() => {
    if (!admissionReady
      || (shadowPolicyMode !== "shadow_encryption"
        && shadowPolicyMode !== "encrypted_only")
      || !auth.viewer.isVerified
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null) return;

    const abort = new AbortController();
    let idle: (() => Promise<void>) | undefined;
    let request: () => Promise<void>;
    if (isDesktop) {
      if (desktopForegroundShadow === undefined
        || desktopForegroundShadowDeviceId === null
        || desktopForegroundShadow.serviceBackgroundAuthorization
          === undefined) return;
      request = () => runWithCryptoAdmission(
        () => desktopForegroundShadow.serviceBackgroundAuthorization!(),
      );
    } else {
      const installationId = readOrCreateBrowserCryptoInstallationId({
        serverScope: window.location.origin,
        userId: auth.viewer.sessionUserId,
        humanActorId: auth.viewer.sessionActorId,
      });
      if (installationId === null) return;
      const client = createBrowserBackgroundAuthorizationClientV2({
        api: apiClient,
        serverScope: window.location.origin,
        userId: auth.viewer.sessionUserId,
        humanActorId: auth.viewer.sessionActorId,
        installationId,
      });
      const sweeps = createCoalescedBackgroundAuthorizationSweepV2({
        signal: abort.signal,
        sweep: () => client.service({signal: abort.signal}),
      });
      request = () => sweeps.request();
      idle = () => sweeps.idle();
    }

    const service = (): void => {
      if (abort.signal.aborted) return;
      void request().catch((error: unknown) => {
        if (!abort.signal.aborted) {
          console.error(
            "[nautilo-runtime] Background authorization sweep failed",
            error instanceof Error ? error.name : typeof error,
          );
        }
      });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") service();
    };
    backgroundAuthorizationWakeRef.current = service;
    window.addEventListener("nautilo:admission-resumed", service);
    window.addEventListener("online", service);
    document.addEventListener("visibilitychange", onVisibility);
    service();
    return () => {
      if (backgroundAuthorizationWakeRef.current === service) {
        backgroundAuthorizationWakeRef.current = () => undefined;
      }
      window.removeEventListener("nautilo:admission-resumed", service);
      window.removeEventListener("online", service);
      document.removeEventListener("visibilitychange", onVisibility);
      abort.abort();
      void idle?.().catch(() => undefined);
    };
  }, [
    admissionReady,
    admissionResumeGeneration,
    auth.viewer.isVerified,
    auth.viewer.sessionActorId,
    auth.viewer.sessionUserId,
    auth.viewerGeneration,
    desktopForegroundShadow,
    desktopForegroundShadowDeviceId,
    shadowPolicyMode,
    wsState,
  ]);

  useEffect(() => {
    if (messageBackfillClient === undefined) return;
    const scheduler = createWorkbenchMessageBackfillScheduler({client: messageBackfillClient, visibility: document,
      clock: {now: Date.now, schedule(callback, delayMs) {const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer);}},
      // Same browser reconnect retry cadence; errors remain transient and do not consume attempts.
      errorResumeAt: () => Date.now() + 30_000,
      onPrioritizedHistoryChanged: (selection) =>
        refreshBackfilledRoomMessageRef.current(selection),
    });
    messageBackfillSchedulerRef.current = scheduler;
    drainMountedBackfillPriorityRef.current();
    const hint = () => scheduler.notify();
    window.addEventListener("nautilo:admission-resumed", hint);
    window.addEventListener("nautilo:room-members-changed", hint);
    return () => {
      if (messageBackfillSchedulerRef.current === scheduler) messageBackfillSchedulerRef.current = null;
      window.removeEventListener("nautilo:admission-resumed", hint);
      window.removeEventListener("nautilo:room-members-changed", hint);
      scheduler.dispose();
    };
  }, [messageBackfillClient]);
  useEffect(() => {
    const scheduler = messageBackfillSchedulerRef.current;
    scheduler?.setForegroundBusy(isRunning);
    scheduler?.setReady(admissionReady && wsState === "open");
    if (admissionReady && wsState === "open") scheduler?.notify();
  }, [messageBackfillClient, admissionReady, admissionResumeGeneration,
    shadowPolicyMode, wsState, isRunning]);

  // ISSUE-D145 — reconcile-on-reconnect.
  //
  // When the WS transitions back to "open" after having been open
  // before this session (i.e. a real reconnect, not first-paint),
  // re-pull the active-room messages from the server so any events
  // that fired during the outage atomically replace the cached
  // frame. After a successful reconcile we dispatch a window event
  // that the `ReconnectToast` component (mounted in workbench-shell
  // alongside ProlongedDisconnectToast) translates into the
  // "Reconnected — Caught up." toast — running it from there
  // because `useToast()` lives downstream of this provider.
  const hadEverBeenOpenRef = useRef(false);
  const lastReconciledOpenAtRef = useRef(lastOpenAt);
  const deferredAdmissionHistoryRoomRef = useRef<string | null>(null);
  useEffect(() => {
    if (deferredAdmissionHistoryRoomRef.current !== activeRoomId) {
      deferredAdmissionHistoryRoomRef.current = null;
      return;
    }
    if (!admissionReady || isRunning || streamsRef.current.size > 0) return;
    if (deferredAdmissionHistoryRoomRef.current === null) return;
    deferredAdmissionHistoryRoomRef.current = null;
    setAdmissionResumeGeneration((value) => value + 1);
  }, [activeRoomId, admissionReady, isRunning]);
  useEffect(() => {
    if (!admissionReady || !isCryptoAdmissionAllowed() || wsState !== "open") return;
    if (!hadEverBeenOpenRef.current) {
      hadEverBeenOpenRef.current = true;
      lastReconciledOpenAtRef.current = lastOpenAt;
      return;
    }
    let cancelled = false;
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    const isCurrentAdmission = (): boolean => !cancelled
      && isCryptoAdmissionGenerationCurrent(admissionGeneration);
    const notifyReconnect = lastReconciledOpenAtRef.current !== lastOpenAt;
    void (async () => {
      const bearer = await authRef.current.session.getAccessToken();
      if (!isCurrentAdmission() || !bearer) return;
      const roomId = activeRoomIdRef.current;
      const hydrationRequest: RoomHydrationRequest = {
        roomId,
        generation: ++roomHydrationGenerationRef.current,
        liveSequenceAtStart: roomLiveArrivalSequenceRef.current,
      };
      activeRoomHydrationRef.current = hydrationRequest;
      const result = roomId
        ? await restoreRoomReadOutcome(() => roomMessageOperations.readReconnectWindow(roomId, retainedHistoryCursorRef.current))
        : { status: "empty" as const, restored: null };
      if (!isCurrentAdmission()) return;
      if (activeRoomIdRef.current !== roomId) return;
      if (!isLatestRoomHydration(hydrationRequest, activeRoomHydrationRef.current)) return;
      const liveOnly = liveArrivalsSince(
        hydrationRequest,
        roomLiveArrivalsRef.current,
      );
      if (shouldDeferBackgroundHistoryProjection({
        backgroundRefresh: true,
        hasActiveStream: streamsRef.current.size > 0,
        isRunning: isRunningRef.current,
        resultStatus: result.status === "no-token" ? "failed" : result.status,
      })) {
        // An uncommitted streaming bubble is not necessarily in history yet.
        // Keep it mounted and catch up after authoritative job completion.
        deferredAdmissionHistoryRoomRef.current = roomId;
      } else if (result.status === "ok" && result.restored) {
        const reconciled = mergeHydratedRoomMessages(
          result.restored,
          liveOnly,
        );
        const waitingForAuthority = roomHistoryWaitsOnlyForKeys(reconciled);
        lastRehydratedRoomRef.current = roomId ?? null;
        messagesRef.current = [...reconciled];
        setHistoryCursor(result.pageInfo?.oldestCursor ?? null);
        setHasMoreHistoryBefore(result.pageInfo?.hasMoreBefore === true);
        flush();
        drainMountedBackfillPriorityRef.current();
        const cacheScope = activeCacheScope(roomId);
        if (cacheScope && !waitingForAuthority) {
          const pending = cacheWriteTimersRef.current.get(cacheScopeKey(cacheScope));
          if (pending) {
            clearTimeout(pending.timer);
            cacheWriteTimersRef.current.delete(cacheScopeKey(cacheScope));
          }
          ordinaryDisconnectCache()?.writeActiveRoom(cacheScope, reconciled);
        }
        settleInitialHistoryFromAuthoritativeResult({
          roomId,
          kind: waitingForAuthority
            ? "waiting-for-authority"
            : reconciled.length > 0 ? "ready" : "empty",
          ...(waitingForAuthority ? { sendAuthorized: true } : {}),
        });
        if (activeRoomHydrationRef.current === hydrationRequest) {
          activeRoomHydrationRef.current = null;
        }
        lastReconciledOpenAtRef.current = lastOpenAt;
        if (notifyReconnect) window.dispatchEvent(new CustomEvent(RECONNECT_RECONCILED_EVENT));
      } else if (result.status === "unauthorized" || result.status === "not-found") {
        const cacheScope = activeCacheScope(roomId);
        if (cacheScope) {
          const key = cacheScopeKey(cacheScope);
          const pending = cacheWriteTimersRef.current.get(key);
          if (pending) {
            clearTimeout(pending.timer);
            cacheWriteTimersRef.current.delete(key);
          }
          ordinaryDisconnectCache()?.invalidateActiveRoom(cacheScope);
        }
        if (result.status === "unauthorized") authRef.current.latchAccessToken(null);
        lastRehydratedRoomRef.current = roomId ?? null;
        messagesRef.current = [];
        setHistoryCursor(null);
        setHasMoreHistoryBefore(false);
        flush();
        settleInitialHistoryFromAuthoritativeResult({
          roomId,
          kind: "access-terminal-error",
          reason: result.status,
        });
      } else if (result.status === "failed" || result.status === "no-token") {
        // A failed background reconciliation is not an empty Room. Retain the
        // already displayed, admitted frame and its loaded history/scroll,
        // including its initial-hydration readiness (there is no new result).
      } else {
        lastRehydratedRoomRef.current = roomId ?? null;
        const reconciled = result.status === "empty"
          ? mergeHydratedRoomMessages([], liveOnly)
          : [];
        messagesRef.current = [...reconciled];
        setHistoryCursor(null);
        setHasMoreHistoryBefore(false);
        if (result.status === "empty") {
          const cacheScope = activeCacheScope(roomId);
          if (cacheScope) {
            const key = cacheScopeKey(cacheScope);
            const pending = cacheWriteTimersRef.current.get(key);
            if (pending) {
              clearTimeout(pending.timer);
              cacheWriteTimersRef.current.delete(key);
            }
            ordinaryDisconnectCache()?.writeActiveRoom(cacheScope, reconciled);
          }
        }
        flush();
        if (result.status === "empty") {
          settleInitialHistoryFromAuthoritativeResult({
            roomId,
            kind: messagesRef.current.length > 0 ? "ready" : "empty",
          });
        } else {
          settleInitialHistoryFromAuthoritativeResult({
            roomId,
            kind: "recoverable-error",
          });
        }
      }
      if (activeRoomHydrationRef.current === hydrationRequest) {
        activeRoomHydrationRef.current = null;
      }

      // D353 — reconcile RUN-STATE from server truth, not just message
      // history. A terminal `job.status` dropped during the WS gap leaves a
      // ghost id in `liveJobIdsRef`, so `isRunning` stays stuck true ("Genie
      // is responding" never clears and Stop reports no-target). Rebuild ONLY
      // the active room's slice of the live-job set from
      // `GET /api/rooms/:id/active-jobs`; other rooms' tracked ids are left
      // untouched (cross-room isolation, per the issue's MANDATORY req). This
      // runs once per real reconnect (the `hadEverBeenOpenRef` gate above).
      if (roomId) {
        try {
          const { jobIds } = await apiClient.getRoomActiveJobs(roomId);
          if (!isCurrentAdmission() || activeRoomIdRef.current !== roomId) return;
          const serverLive = new Set(jobIds);
          // Drop this room's stale ids the server no longer reports running.
          for (const id of [...liveJobIdsRef.current]) {
            if (jobIdToRoomIdRef.current.get(id) === roomId && !serverLive.has(id)) {
              const terminal = await apiClient.getJobStatus(id).catch(() => null);
              if (!isCurrentAdmission() || activeRoomIdRef.current !== roomId) return;
              const restartMessage = terminal === null
                ? null
                : plannedShutdownReconnectMessage(terminal);
              if (
                terminal !== null &&
                (terminal.status === "completed" || terminal.status === "failed" ||
                  terminal.status === "cancelled" || terminal.status === "timed_out")
              ) {
                const turnId = terminal.input !== null && typeof terminal.input["turnId"] === "string"
                  ? terminal.input["turnId"]
                  : undefined;
                const authorAgentId = terminal.input !== null && typeof terminal.input["agentId"] === "string"
                  ? terminal.input["agentId"]
                  : undefined;
                settleToolsMissingFinalReceipt({
                  jobId: id,
                  roomId,
                  ...(turnId ? { turnId } : {}),
                  ...(authorAgentId ? { authorAgentId } : {}),
                  status: terminal.status,
                });
              }
              if (restartMessage !== null) {
                const finalization = resolveFailedJobStreamFinalization({
                  streams: streamsRef.current,
                  messageBody: restartMessage,
                });
                streamKeyByLaneAuthorRef.current.clear();
                for (const update of finalization.updates) {
                  updateMessageById(update.bubbleId, update.content);
                }
                if (finalization.standaloneError !== null) {
                  addMessage({
                    id: `error-${id}`,
                    role: "assistant",
                    content: [{
                      type: "text",
                      text: finalization.standaloneError,
                    }],
                  });
                }
                clearAgentStreamingVisibleOutput();
                setModelFallbackStatus(null);
              }
              liveJobIdsRef.current.delete(id);
            }
          }
          // Re-add any genuinely-live id we lost, restoring its room mapping
          // so its eventual terminal `job.status` routes and retires it.
          for (const id of jobIds) {
            liveJobIdsRef.current.add(id);
            jobIdToRoomIdRef.current.set(id, roomId);
          }
          trimBoundedStringMap(jobIdToRoomIdRef.current, liveJobIdsRef.current);
          setIsRunning(hasLiveJobForActiveRoom());
          if (jobIds.length === 0 && deferredAdmissionHistoryRoomRef.current === roomId) {
            // The terminal WS event may itself have been missed during pause.
            // Durable job truth permits replacing the old partial transcript.
            deferredAdmissionHistoryRoomRef.current = null;
            streamsRef.current.clear();
            streamKeyByLaneAuthorRef.current.clear();
            setAdmissionResumeGeneration((value) => value + 1);
          }
        } catch (err) {
          if (import.meta.env.DEV) {
            console.warn(
              "[nautilo-runtime] active-jobs run-state reconcile failed",
              roomId,
              err,
            );
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    addMessage,
    admissionReady,
    admissionResumeGeneration,
    lastOpenAt,
    clearAgentStreamingVisibleOutput,
    wsState,
    flush,
    hasLiveJobForActiveRoom,
    roomMessageOperations,
    settleToolsMissingFinalReceipt,
    settleInitialHistoryFromAuthoritativeResult,
    liveShadowMessageClient?.deviceId,
    updateMessageById,
  ]);

  const loadOlderHistory = useCallback(async (): Promise<boolean> => {
    if (!isCryptoAdmissionAllowed()) return false;
    const admissionGeneration = getCryptoAdmissionSnapshot().generation;
    const roomId = activeRoomIdRef.current;
    const cursor = historyCursor;
    if (!roomId || !cursor || !hasMoreHistoryBefore || loadingHistoryBefore) {
      return false;
    }
    setLoadingHistoryBefore(true);
    try {
      const page = await roomMessageOperations.readOlderRoomMessages({
        roomId,
        beforeId: cursor.id,
        beforeCreatedAt: cursor.createdAt,
        limit: 50,
      });
      if (activeRoomIdRef.current !== roomId) {
        return false;
      }
      const restored = restoreSessionMessages(page.messages);
      assertCryptoAdmissionAccess(admissionGeneration);
      const existingIds = new Set(messagesRef.current.map((m) => m.id));
      const older = restored.filter((m) => !existingIds.has(m.id));
      if (older.length > 0) {
        messagesRef.current = [...older, ...messagesRef.current];
        flush();
      }
      drainMountedBackfillPriorityRef.current();
      setHistoryCursor(page.pageInfo.oldestCursor);
      setHasMoreHistoryBefore(page.pageInfo.hasMoreBefore);
      return older.length > 0;
    } catch (err) {
      if (import.meta.env.DEV) {
        console.warn("[nautilo-runtime] failed loading older room history", err);
      }
      return false;
    } finally {
      setLoadingHistoryBefore(false);
    }
  }, [
    flush,
    hasMoreHistoryBefore,
    historyCursor,
    loadingHistoryBefore,
    roomMessageOperations,
  ]);

  const sendText = useCallback(
    async (
      text: string,
      options?: {
        replyToMessageId?: number;
        mentionedHumanUserIds?: string[];
        onOptimisticUserMessage?: () => void;
        /**
         * D371 R2 — optional per-turn model override. Forwarded into
         * `sendExtras` and on to `apiClient.sendRoomMessage`. Inert until R3
         * wires a UI to set it; the field is omitted entirely when absent so
         * server behavior is unchanged.
         */
        model?: string;
        /** Card-owned follow-up resources that must not consume Composer state. */
        detachedFocusedResources?: readonly ChatFocusedResourceRef[];
        /** Exact current work-surface resources merged with Composer focus. */
        contextualFocusedResources?: readonly ChatFocusedResourceRef[];
        /** A closed workcard presentation, never free-form authored metadata. */
        cardContinuation?: "advanced_video";
      },
    ): Promise<boolean> => {
      if (!isCryptoAdmissionAllowed()) return false;
      // D087 Phase 3 §3.7 — slash-command interception. Intercept
      // BEFORE the normal send pipeline so `/undo` doesn't reach the
      // LLM; instead it dispatches through the direct-invoke
      // endpoint (zero synthetic user message, zero LLM turn).
      //
      // Supported:
      //   /undo              — undo most-recent edit on most-recently-
      //                        touched file. No visible user message
      //                        in the thread; the DiffView card fires
      //                        via the tool-activity stream.
      //   /undo <abs-path>   — undo most-recent edit on the given
      //                        absolute path.
      //   /redo [abs-path]   — symmetric.
      //
      // Unknown slash-commands fall through to normal send (the Agent
      // sees them as user text). No-arg /undo with no history
      // surfaces an inline error bubble via the tool-activity
      // stream's error channel.
      // D448 — outbound room identity is admitted only when the active/route
      // room and the hydrated visible transcript agree. During a room switch,
      // reject before slash commands, optimistic bubbles, attachment cleanup,
      // or network I/O. This prevents a stale room-A frame from sending into B.
      const routeRoomId =
        typeof window !== "undefined" ? parseRouteRoomId(window.location.pathname) : null;
      const roomIdForSend = resolveBoundRoomIdForSend(
        activeRoomIdRef.current,
        lastRehydratedRoomRef.current,
        routeRoomId,
      );
      if (roomIdForSend === undefined) return false;
      const slashMatch = text.trim().match(/^\/(undo|redo)(?:\s+(.+))?$/i);
      if (slashMatch) {
        const slashCommand = slashMatch[1].toLowerCase() as "undo" | "redo";
        const pathArg = slashMatch[2]?.trim();
        const fileContext = readFileContext();
        // Derive target path: explicit arg wins; else fall back to
        // the most-recently-touched path which the undo bar already
        // tracks. This reuses the same scoping rule as ⌘Z so slash
        // + keybind agree.
        const map = revisionStateRef.current;
        let targetPath: string | null = pathArg ?? null;
        if (!targetPath) {
          let best: { path: string; createdAt: string } | null = null;
          for (const [p, snap] of Object.entries(map)) {
            if (!snap.latest) continue;
            if (snap.availableRevisions === 0) continue;
            if (!best || snap.latest.createdAt > best.createdAt) {
              best = { path: p, createdAt: snap.latest.createdAt };
            }
          }
          if (best) targetPath = best.path;
        }
        if (!targetPath) {
          addMessage({
            id: newMessageId("assistant"),
            role: "assistant",
            content: [
              {
                type: "text",
                text: `Nothing to ${slashCommand} — no edits recorded this session. Run a write/edit first or pass an absolute path: \`/${slashCommand} /abs/path/to/file\`.`,
              },
            ],
          });
          return false;
        }
        // PR-018 MINOR #2 — same try/catch discipline as
        // undo-redo-bar.tsx. Rejection (503 on flag off, 401 on
        // missing ownerId, net blip) would vanish silently through
        // the void-cast; surface to console for operator visibility.
        // User-facing success signal is the DiffView tool-card that
        // the staged-patch pipeline will render; failure to dispatch
        // means the staged patch never materializes.
        void (async () => {
          try {
            await apiClient.invokeDirect({
              command: slashCommand,
              args: { path: targetPath, zone: "absolute" },
              ...(roomIdForSend ? { roomId: roomIdForSend } : {}),
              workspacePath: fileContext.workspacePath ?? null,
              currentFolder: fileContext.currentFolder ?? null,
            });
          } catch (err) {
            console.warn(
              `[slash-command] /${slashCommand} dispatch failed`,
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
        return true;
      }

      // D271 — attachments are uploaded at attach time; the chip carries the
      // server `attachmentId`. The send references ids only (no paths/bytes).
      const isDetachedFocusedTurn = options?.detachedFocusedResources !== undefined;
      const queuedAttachments = isDetachedFocusedTurn ? [] : getAttachments();
      const fileContext = readFileContext();
      const attachments: ChatUploadedAttachmentRef[] = [];
      for (const att of queuedAttachments) {
        if (att.attachmentId && att.status !== "error") {
          attachments.push({ attachmentId: att.attachmentId });
        } else {
          updateAttachment(att.id, {
            status: "error",
            errorReason: att.errorReason ?? "Attachment upload did not finish; re-attach the file.",
          });
        }
      }

      // D356 — metadata-only artifact references ("focus on these"). Unlike
      // attachments these carry no bytes; map to the wire shape (drop entryId).
      const queuedArtifactRefs = isDetachedFocusedTurn ? [] : getArtifactRefs();
      const artifactRefs: ChatArtifactRef[] = queuedArtifactRefs.map((r) => ({
        artifactId: r.artifactId,
        path: r.path,
        mimeType: r.mimeType,
        size: r.size,
      }));
      const hasArtifactRefPayload = artifactRefs.length > 0;
      const focusedResources = options?.detachedFocusedResources
        ? [...options.detachedFocusedResources]
        : mergeFocusedResourcesForSend(
            getFocusedResources().map((item) => item.ref),
            options?.contextualFocusedResources ?? [],
          );
      const hasFocusedResourcePayload = focusedResources.length > 0;

      const hasAttachmentPayload = attachments.length > 0;
      const trimmedText = text.trim();
      if (!trimmedText && !hasAttachmentPayload && !hasArtifactRefPayload && !hasFocusedResourcePayload) return false;
      if (roomIdForSend) {
        pendingStopRoomIdsRef.current.delete(roomIdForSend);
      }

      if (auth.viewer.isVerified && !roomIdForSend) {
        addMessage({
          id: newMessageId("error"),
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Cannot send: this room is not available. Select or create a room and try again.",
            },
          ],
        });
        return false;
      }

      // D204 follow-up — defer setIsRunning(true) until AFTER the HTTP
      // response. If the D128 gate suppresses, the response comes back
      // with jobId=null and we never set isRunning at all (no flash).
      // For the active path, the WS `job.dispatched` event arrives a
      // beat later and the existing handlers light up the indicator.
      // The visible cost is ~50–200ms of "no indicator yet" on active
      // turns — fine; the user already sees their own bubble in the
      // transcript so the eye has somewhere to land.

      const optimisticId = newMessageId("user");
      const optimisticBubbleText = buildUserBubbleText({
        text,
        queuedAttachments: hasAttachmentPayload ? queuedAttachments : [],
      });
      const workcardContinuation: AdvancedVideoWorkcardContinuation | undefined =
        options?.cardContinuation === "advanced_video"
          ? { kind: "advanced_video", referenceCount: focusedResources.length }
          : undefined;
      addMessage(
        workcardContinuation
          ? {
              id: optimisticId,
              role: "system",
              content: [{
                type: "text",
                text: `Advanced video workcard · Requested exact quote with ${workcardContinuation.referenceCount} reference${workcardContinuation.referenceCount === 1 ? "" : "s"}.`,
              }],
              metadata: {
                custom: {
                  workcardContinuation,
                  workcardContinuationRequestText: text,
                },
              },
            }
          : {
              id: optimisticId,
              role: "user",
              content: [{ type: "text", text: optimisticBubbleText }],
              metadata: {
                custom: {
                  optimisticAuthoredText: text,
                  ...(options?.replyToMessageId !== undefined
                    ? { replyToMessageId: options.replyToMessageId }
                    : {}),
                } as Record<string, unknown>,
              },
            },
      );
      if (!isDetachedFocusedTurn) {
        clearAttachments();
        clearArtifactRefs();
        clearFocusedResources();
      }
      options?.onOptimisticUserMessage?.();

      try {
        // D079 Phase 2 — pick up the current file-surface context
        // from the shared ref populated by BrowserColumnProvider.
        // Read-on-send semantics so the LATEST folder is always in
        // the outbound message, even if the user swapped folders
        // mid-conversation between this send and the previous one.
        // `workspacePath` is null until D079 Phase 3 wires it; the
        // server tolerates absence gracefully (omits the workspace
        // sub-block in the system prompt).
        const activeMiniApp = readActiveMiniApp();
        const liveMiniAppSession = readLiveMiniAppSession();
        const sendExtras = {
          voiceMode: voiceEnabledRef.current,
          // Carry the Human's ephemeral posture with the turn so trusted-host
          // structured SSH can be admitted before LangGraph parks. Handling
          // the flag only after `approval.ask` would replay earlier tools.
          autoApprove: autoApproveRef.current,
          currentFolder: fileContext.currentFolder,
          currentFolderRelayId: fileContext.currentFolderRelayId,
          workspacePath: fileContext.workspacePath,
          attachments,
          userTimezone: detectedTimezone,
          ...(activeMiniApp ? { activeMiniApp } : {}),
          ...(liveMiniAppSession ? { liveMiniAppSession } : {}),
          ...(hasArtifactRefPayload ? { artifactRefs } : {}),
          ...(hasFocusedResourcePayload ? { focusedResources } : {}),
          ...(options?.replyToMessageId !== undefined
            ? { replyToMessageId: options.replyToMessageId }
            : {}),
          ...(options?.mentionedHumanUserIds &&
          options.mentionedHumanUserIds.length > 0
            ? { mentionedHumanUserIds: options.mentionedHumanUserIds }
            : {}),
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.cardContinuation ? { cardContinuation: options.cardContinuation } : {}),
        };

        type PendingSend = {
          laneKeyForMaps: string;
          jobId: string | null;
          coalesced: boolean | undefined;
          attachments: ChatAttachmentStatus[] | undefined;
          /**
           * D212 — the persisted numeric id of THIS user message, returned
           * by `POST /api/rooms/:id/messages`. The same user's other desktop
           * can receive `message.new`, but this response remains the earliest
           * authoritative id for the sending client. We stamp the optimistic
           * bubble with it (instead of a `user-…` client id) so live
           * `reaction.added` events — which key on the numeric id — match
           * and the reaction strip pops in without a reload.
           */
          userMessageId: number | null;
        };

        let pending: PendingSend;
        if (roomIdForSend) {
          const roomBody = withCurrentClientActionSession({
            content: text,
            laneKey: LANE_KEY,
            ...sendExtras,
          });
          const r = await roomMessageOperations.sendRoomMessage(roomIdForSend, roomBody);
          rememberAskUserResumeContext(roomIdForSend, r.messageId, roomBody);
          // MR1 canonical JSON has no `laneKey`; legacy `/api/chat` still returns
          // `room:<uuid>`. Keep lane→room correlation aligned with the room lane id.
          pending = {
            laneKeyForMaps: `room:${roomIdForSend}`,
            jobId: r.jobId,
            coalesced: r.coalesced,
            attachments: r.attachments,
            userMessageId: r.messageId,
          };
        } else {
          const r = await apiClient.sendMessage(withCurrentClientActionSession({
            message: text,
            laneKey: LANE_KEY,
            ...sendExtras,
          }));
          pending = {
            laneKeyForMaps: r.laneKey,
            jobId: r.jobId,
            coalesced: r.coalesced,
            attachments: r.attachments,
            userMessageId: null,
          };
        }

        const rid = roomIdForSend;
        if (rid && pending.jobId && pending.coalesced) {
          laneKeyToRoomIdRef.current.set(pending.laneKeyForMaps, rid);
          virtualJobIdToRoomIdRef.current.set(pending.jobId, rid);
          trimBoundedStringMap(laneKeyToRoomIdRef.current);
          trimBoundedStringMap(virtualJobIdToRoomIdRef.current);
        } else if (rid && pending.jobId) {
          laneKeyToRoomIdRef.current.set(pending.laneKeyForMaps, rid);
          jobIdToRoomIdRef.current.set(pending.jobId, rid);
          trimBoundedStringMap(laneKeyToRoomIdRef.current);
          trimBoundedStringMap(jobIdToRoomIdRef.current, liveJobIdsRef.current);
        } else if (rid && pending.coalesced) {
          laneKeyToRoomIdRef.current.set(pending.laneKeyForMaps, rid);
          trimBoundedStringMap(laneKeyToRoomIdRef.current);
        } else if (import.meta.env.DEV) {
          console.warn(
            "[nautilo-runtime] sendMessage without activeRoomId — using legacy session resolution",
          );
        }

        // D128 / D204 — only flip the thinking indicator true when the
        // server confirmed an LLM turn was dispatched. A null jobId is
        // the unambiguous "no agent turn was dispatched" signal (see
        // packages/server/src/messaging/agent-mediated.ts ::
        // persistAgentRoomMessageWithoutLlm) — that happens when the
        // D128 gate suppresses (`mention_only` without @mention, or
        // `observe` mode) or when this room has no agent member. In
        // either case, we never want to show the indicator.
        if (pending.jobId !== null) {
          setIsRunning(true);
        } else if (rid) {
          // Belt-and-suspenders: if some prior turn left isRunning true
          // (rapid send-while-thinking edge case), make sure the new
          // suppressed send doesn't leave it true.
          setIsRunning(false);
        }

        // The bubble in history shows what the user authored — their
        // typed prose — with attachment filenames and server-side outcomes
        // summarized. Attachment content is added server-side by the
        // attachment security gate.
        // classification/scanning.
        if (hasAttachmentPayload) {
          updateMessageText(
            optimisticId,
            buildUserBubbleText({
              text,
              queuedAttachments,
              attachmentStatuses: pending.attachments ?? [],
            }),
          );
        }
        if (pending.userMessageId != null) {
          // D212 — use the persisted numeric id when the server returned
          // one so live reactions on this just-sent message resolve; fall
          // back to a client id for the legacy /api/chat path.
          reconcileMessageId(optimisticId, String(pending.userMessageId));
        }
        return true;
      } catch (err) {
        markMessageSendFailed(
          optimisticId,
          roomMessageSendFailureReason(err),
        );
        clearAgentStreamingVisibleOutput();
        setIsRunning(false);
        return false;
      }
    },
    [
      addMessage,
      auth.viewer.isVerified,
      clearAgentStreamingVisibleOutput,
      markMessageSendFailed,
      roomMessageOperations,
      reconcileMessageId,
      updateMessageText,
    ],
  );

  const onNew = useCallback(
    async (msg: AppendMessage) => {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("");

      await sendText(text);
    },
    [sendText],
  );

  useEffect(() => {
    setRevertDispatcher((text) => void sendText(text));
    setFocusedTurnDispatcher((text, resources, cardContinuation) => {
      void sendText(text, { detachedFocusedResources: resources, cardContinuation });
    });
    return () => {
      setRevertDispatcher(null);
      setFocusedTurnDispatcher(null);
    };
  }, [sendText]);

  // --- Voice controls ---

  const toggleVoice = useCallback(() => {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    voicePlayerRef.current?.setEnabled(next);
    if (next) {
      // Construct + resume the AudioContext while we still have the click
      // gesture's transient activation. If we defer to the first audio
      // chunk (which can arrive seconds later, after the LLM prelude
      // and first-sentence synth), Chromium's autoplay policy blocks
      // ctx.resume() and playback becomes silent.
      void voicePlayerRef.current?.prime();
    } else {
      voicePlayerRef.current?.stop();
      wsRef.current?.send({ type: "voice.stop" });
    }
  }, [voiceEnabled]);

  const stopVoice = useCallback(() => {
    voicePlayerRef.current?.stop();
    wsRef.current?.send({ type: "voice.stop" });
  }, []);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
    voicePlayerRef.current?.setEnabled(voiceEnabled);
  }, [voiceEnabled]);

  // Navigation changes the local foreground authority immediately. Clear any
  // buffered/playing sentence without aborting server synthesis, because a
  // different client may still be viewing the originating Room.
  useEffect(() => {
    voicePlayerRef.current?.stop();
  }, [activeRoomId]);

  // D557 — install only after both canonical renderer owners exist, then ask
  // Desktop for one replay in case its startup event predated this mount.
  const readyToWork = desktopAPI?.readyToWork;
  useEffect(() => {
    if (!canInstallReadyToWorkRendererOwnerAdapter(readyToWork, autoApproveViewerId)) return;
    const shouldRestore = !readyToWorkRestoreAttemptedRef.current;
    readyToWorkRestoreAttemptedRef.current = true;
    const adapter = createReadyToWorkRendererOwnerAdapter(readyToWork, {
      readVoice: () => voicePlayerRef.current?.isEnabled() ?? false,
      setVoice: (enabled) => {
        voicePlayerRef.current?.setEnabled(enabled);
        const actual = voicePlayerRef.current?.isEnabled() ?? false;
        voiceEnabledRef.current = actual;
        setVoiceEnabled(actual);
      },
      primeVoice: () => voicePlayerRef.current?.prime() ?? Promise.resolve(),
      readAutoApprove: () => autoApproveRef.current,
      setAutoApprove: (enabled) => setSessionAutoApproveRef.current(enabled),
    }, { restore: shouldRestore });
    readyToWorkOwnerAdapterRef.current = adapter;
    return () => {
      if (readyToWorkOwnerAdapterRef.current === adapter) {
        readyToWorkOwnerAdapterRef.current = null;
      }
      adapter.dispose();
    };
  }, [autoApproveViewerId, readyToWork]);

  // The Desktop report path only observes drift. It cannot re-enter restore,
  // and the adapter suppresses identical snapshots to avoid report churn.
  useEffect(() => {
    readyToWorkOwnerAdapterRef.current?.reportIfChanged();
  }, [autoApprove, voiceEnabled]);

  // D349 — STOP is conversation-scoped when a room is active: abort live jobs
  // and suppress queued/coalesced continuation via `POST /api/rooms/:id/stop`.
  // Fall back to job-id Stop only when no active room is known.
  const stopActiveJobs = useCallback(() => {
    const activeRoom = activeRoomIdRef.current;
    const ids = Array.from(liveJobIdsRef.current).filter((id) =>
      activeRoom ? jobIdToRoomIdRef.current.get(id) === activeRoom : true,
    );
    if (activeRoom) {
      const attemptId = nextTurnStopAttemptId();
      setTurnStopStatus({ state: "stopping", attemptId });
      pendingStopRoomIdsRef.current.add(activeRoom);
      trimBoundedStringSet(pendingStopRoomIdsRef.current);
      void apiClient.stopRoom(activeRoom).then((result) => {
        if (turnStopAttemptIdRef.current !== attemptId) return;
        if (!result.stopped) {
          setTurnStopStatus({ state: "failed", reason: "no-target", attemptId });
          return;
        }
        setTurnStopStatus({ state: "stopped", attemptId });
      }).catch((err: unknown) => {
        if (turnStopAttemptIdRef.current !== attemptId) return;
        if (import.meta.env.DEV) {
          console.warn("[nautilo-runtime] room stop request failed", activeRoom, err);
        }
        setTurnStopStatus({ state: "failed", reason: "request-failed", attemptId });
      });
      return;
    }
    if (stopKnownJobIds(ids)) return;

    const virtualIds = activeRoom
      ? Array.from(virtualJobIdToRoomIdRef.current)
          .filter(([, roomId]) => roomId === activeRoom)
          .map(([id]) => id)
      : [];
    if (activeRoom && virtualIds.length > 0) {
      // D341 — a send can return the coalescer's virtual id before the real
      // persisted job id arrives over `job.dispatched`. Preserve the user's
      // Stop intent and apply it as soon as that mapping arrives.
      const attemptId = nextTurnStopAttemptId();
      setTurnStopStatus({ state: "queued", attemptId });
      pendingStopRoomIdsRef.current.add(activeRoom);
      trimBoundedStringSet(pendingStopRoomIdsRef.current);
      for (const id of virtualIds) pendingStopVirtualJobIdsRef.current.add(id);
      trimBoundedStringSet(pendingStopVirtualJobIdsRef.current);
      clearAgentStreamingVisibleOutput();
      setIsRunning(false);
      if (import.meta.env.DEV) {
        console.info("[nautilo-runtime] queued stop until job.dispatched", {
          activeRoom,
          virtualIds,
        });
      }
      return;
    }

    if (import.meta.env.DEV) {
      console.warn("[nautilo-runtime] Stop clicked with no live or virtual job ids", {
        activeRoom,
        isRunning,
      });
    }
    setTurnStopFailed("no-target");
  }, [
    clearAgentStreamingVisibleOutput,
    isRunning,
    nextTurnStopAttemptId,
    setTurnStopFailed,
    stopKnownJobIds,
  ]);

  const initialHistoryAdmission = roomInitialHistoryAdmission({
    state: roomInitialHydrationState,
    origin: serverOrigin,
    viewerKey,
    viewerGeneration: auth.viewerGeneration,
    roomId: activeRoomId,
  });

  const voiceControls: VoiceControls = {
    enabled: voiceEnabled,
    playing: voicePlaying,
    toggle: toggleVoice,
    stop: stopVoice,
    sendText: (
      text: string,
      options?: {
        replyToMessageId?: number;
        mentionedHumanUserIds?: string[];
        onOptimisticUserMessage?: () => void;
        model?: string;
        contextualFocusedResources?: readonly ChatFocusedResourceRef[];
      },
    ) => sendText(text, options),
    roomBindingReady:
      initialHistoryAdmission.sendAuthorized &&
      resolveBoundRoomIdForSend(
        activeRoomId,
        lastRehydratedRoomRef.current,
        typeof window !== "undefined" ? parseRouteRoomId(window.location.pathname) : null,
      ) !== undefined,
    isRunning,
    turnStopStatus,
    stopActiveJobs,
  };

  // --- Identity challenge handlers (verify_identity → PinDialog) ---

  const submitPin = useCallback(async (pin: string) => {
    const threadId = challengeThreadIdRef.current;
    const previewKey = challengePreviewKeyRef.current;
    const roomId = activeRoomIdRef.current;
    const viewerGeneration = viewerGenerationRef.current;
    const scopeGeneration = pendingAttentionUiScopeGenerationRef.current;
    const isCurrentSubmission = () => isPendingAttentionSubmissionCurrent({
      capturedKey: previewKey,
      capturedRoomId: roomId,
      capturedViewerGeneration: viewerGeneration,
      capturedScopeGeneration: scopeGeneration,
      currentKey: challengePreviewKeyRef.current,
      currentRoomId: activeRoomIdRef.current,
      currentViewerGeneration: viewerGenerationRef.current,
      currentScopeGeneration: pendingAttentionUiScopeGenerationRef.current,
    });
    if (!threadId) return;
    setPinError(undefined);

    if (challengeModeRef.current === "enrollPin") {
      try {
        await apiClient.postAuthPin({
          newPin: pin,
          threadId,
          clientActionSessionId: currentClientActionSessionIdForResume(),
          authorizationDeviceId: liveShadowMessageClient?.deviceId,
          ...(challengeLaneKeyRef.current
            ? { laneKey: challengeLaneKeyRef.current }
            : {}),
        });
        if (!isCurrentSubmission()) return;
        setShowPinDialog(false);
        challengeThreadIdRef.current = null;
        challengeLaneKeyRef.current = null;
        challengePreviewKeyRef.current = null;
        challengeModeRef.current = "verify";
        if (previewKey) settlePendingAttentionPreviewRef.current(previewKey);
      } catch (err) {
        if (!isCurrentSubmission()) return;
        if (err instanceof ApiError) {
          if (err.status === 429) {
            setPinError("Too many attempts. Please wait.");
          } else if (err.status === 400) {
            setPinError(err.message || "PIN didn't meet requirements.");
          } else {
            setPinError(err.message || "Couldn't set PIN. Try again.");
          }
        } else {
          setPinError(
            `Network error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }

    try {
      await apiClient.identityVerifyResume(
        pin,
        threadId,
        challengeLaneKeyRef.current ?? undefined,
        {
          clientActionSessionId: currentClientActionSessionIdForResume(),
          authorizationDeviceId: liveShadowMessageClient?.deviceId,
        },
      );
      if (!isCurrentSubmission()) return;
      const bearer = await authRef.current.session.getAccessToken();
      if (!isCurrentSubmission()) return;
      if (!bearer) {
        setPinError("Session expired. Please sign in again.");
        return;
      }
      setShowPinDialog(false);
      challengeThreadIdRef.current = null;
      challengeLaneKeyRef.current = null;
      challengePreviewKeyRef.current = null;
      challengeModeRef.current = "verify";
      if (previewKey) settlePendingAttentionPreviewRef.current(previewKey);

      messagesRef.current = [];
      streamsRef.current.clear();
      streamKeyByLaneAuthorRef.current.clear();
      clearAgentStreamingVisibleOutput();
      setHistoryCursor(null);
      setHasMoreHistoryBefore(false);
      setLoadingHistoryBefore(false);

      let postPinHydration: RoomHydrationRequest | null = null;
      try {
        const hydrationRequest: RoomHydrationRequest = {
          roomId,
          generation: ++roomHydrationGenerationRef.current,
          liveSequenceAtStart: roomLiveArrivalSequenceRef.current,
        };
        postPinHydration = hydrationRequest;
        activeRoomHydrationRef.current = hydrationRequest;
        const result = roomId
          ? await restoreRoomReadOutcome(() => roomMessageOperations.readRoomMessages(roomId))
          : { status: "empty" as const, restored: null };
        if (
          activeRoomIdRef.current === roomId &&
          isLatestRoomHydration(hydrationRequest, activeRoomHydrationRef.current) &&
          result.status === "ok" && result.restored
        ) {
          const reconciled = mergeHydratedRoomMessages(
            result.restored,
            liveArrivalsSince(hydrationRequest, roomLiveArrivalsRef.current),
          );
          const waitingForAuthority = roomHistoryWaitsOnlyForKeys(reconciled);
          messagesRef.current = [
            {
              id: newMessageId("system-verified"),
              role: "assistant",
              content: [{ type: "text", text: "Identity verified. Welcome back." }],
            },
            ...reconciled,
          ];
          lastRehydratedRoomRef.current = roomId ?? null;
          setHistoryCursor(result.pageInfo?.oldestCursor ?? null);
          setHasMoreHistoryBefore(result.pageInfo?.hasMoreBefore === true);
          const cacheScope = activeCacheScope(roomId);
          if (cacheScope && !waitingForAuthority) {
            const key = cacheScopeKey(cacheScope);
            const pending = cacheWriteTimersRef.current.get(key);
            if (pending) {
              clearTimeout(pending.timer);
              cacheWriteTimersRef.current.delete(key);
            }
            ordinaryDisconnectCache()?.writeActiveRoom(cacheScope, reconciled);
          }
          settleInitialHistoryFromAuthoritativeResult({
            roomId,
            kind: waitingForAuthority ? "waiting-for-authority" : "ready",
            ...(waitingForAuthority ? { sendAuthorized: true } : {}),
          });
        } else if (
          activeRoomIdRef.current === roomId &&
          isLatestRoomHydration(hydrationRequest, activeRoomHydrationRef.current) &&
          (result.status === "unauthorized" || result.status === "not-found")
        ) {
          const cacheScope = activeCacheScope(roomId);
          if (cacheScope) {
            const key = cacheScopeKey(cacheScope);
            const pending = cacheWriteTimersRef.current.get(key);
            if (pending) {
              clearTimeout(pending.timer);
              cacheWriteTimersRef.current.delete(key);
            }
            ordinaryDisconnectCache()?.invalidateActiveRoom(cacheScope);
          }
          if (result.status === "unauthorized") authRef.current.latchAccessToken(null);
          messagesRef.current = [];
          lastRehydratedRoomRef.current = roomId ?? null;
          settleInitialHistoryFromAuthoritativeResult({
            roomId,
            kind: "access-terminal-error",
            reason: result.status,
          });
        } else if (
          activeRoomIdRef.current === roomId &&
          isLatestRoomHydration(hydrationRequest, activeRoomHydrationRef.current)
        ) {
          const reconciled = result.status === "empty"
            ? mergeHydratedRoomMessages(
              [],
              liveArrivalsSince(hydrationRequest, roomLiveArrivalsRef.current),
            )
            : [];
          messagesRef.current = [
            {
              id: newMessageId("system-verified"),
              role: "assistant",
              content: [{ type: "text", text: "Identity verified. Welcome back." }],
            },
            ...reconciled,
          ];
          if (result.status === "empty") {
            const cacheScope = activeCacheScope(roomId);
            if (cacheScope) {
              const key = cacheScopeKey(cacheScope);
              const pending = cacheWriteTimersRef.current.get(key);
              if (pending) {
                clearTimeout(pending.timer);
                cacheWriteTimersRef.current.delete(key);
              }
              ordinaryDisconnectCache()?.writeActiveRoom(cacheScope, reconciled);
            }
            settleInitialHistoryFromAuthoritativeResult({
              roomId,
              kind: messagesRef.current.length > 0 ? "ready" : "empty",
            });
          } else if (result.status === "failed" && result.failureClass === "key_waiting") {
            settleInitialHistoryFromAuthoritativeResult({
              roomId,
              kind: "waiting-for-authority",
              sendAuthorized: false,
            });
          } else {
            settleInitialHistoryFromAuthoritativeResult({
              roomId,
              kind: "recoverable-error",
            });
          }
        }
        if (activeRoomHydrationRef.current === hydrationRequest) {
          activeRoomHydrationRef.current = null;
        }
      } catch {
        const roomId = postPinHydration?.roomId ?? null;
        if (
          roomId &&
          postPinHydration &&
          activeRoomIdRef.current === roomId &&
          isLatestRoomHydration(postPinHydration, activeRoomHydrationRef.current)
        ) {
          messagesRef.current = [];
          lastRehydratedRoomRef.current = roomId;
          settleInitialHistoryFromAuthoritativeResult({
            roomId,
            kind: "recoverable-error",
          });
          activeRoomHydrationRef.current = null;
        }
      }

      flush();
    } catch (err) {
      if (!isCurrentSubmission()) return;
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setPinError("Too many attempts. Please wait.");
        } else {
          setPinError(err.message || "Wrong PIN. Try again.");
        }
      } else {
        setPinError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [
    flush,
    clearAgentStreamingVisibleOutput,
    liveShadowMessageClient?.deviceId,
    roomMessageOperations,
    settleInitialHistoryFromAuthoritativeResult,
  ]);

  const cancelPin = useCallback(() => {
    const previewKey = challengePreviewKeyRef.current;
    setShowPinDialog(false);
    setPinError(undefined);
    challengeThreadIdRef.current = null;
    challengeLaneKeyRef.current = null;
    challengePreviewKeyRef.current = null;
    challengeModeRef.current = "verify";
    if (previewKey) settlePendingAttentionPreviewRef.current(previewKey);
  }, []);

  // --- Prove-it challenge handlers (ApprovalDialog) ---

  const submitProveIt = useCallback(async (pin: string) => {
    const threadId = approvalThreadIdRef.current;
    const previewKey = approvalPreviewKeyRef.current;
    const roomId = activeRoomIdRef.current;
    const viewerGeneration = viewerGenerationRef.current;
    const scopeGeneration = pendingAttentionUiScopeGenerationRef.current;
    const isCurrentSubmission = () => isPendingAttentionSubmissionCurrent({
      capturedKey: previewKey,
      capturedRoomId: roomId,
      capturedViewerGeneration: viewerGeneration,
      capturedScopeGeneration: scopeGeneration,
      currentKey: approvalPreviewKeyRef.current,
      currentRoomId: activeRoomIdRef.current,
      currentViewerGeneration: viewerGenerationRef.current,
      currentScopeGeneration: pendingAttentionUiScopeGenerationRef.current,
    });
    if (!threadId) return;
    pendingAttentionLiveSequenceRef.current += 1;
    setApprovalError(undefined);
    try {
      await apiClient.proveItAndResume(
        pin,
        threadId,
        approvalLaneKeyRef.current ?? undefined,
        {
          clientActionSessionId: currentClientActionSessionIdForResume(),
          authorizationDeviceId: liveShadowMessageClient?.deviceId,
        },
        approvalChallengeIdRef.current ?? undefined,
      );
      if (!isCurrentSubmission()) return;
      setShowApprovalDialog(false);
      addMessage({
        id: newMessageId("system"),
        role: "assistant",
        content: [{ type: "text", text: `Approved: ${approvalTools.map((t) => t.name).join(", ")}` }],
      });
      approvalThreadIdRef.current = null;
      approvalLaneKeyRef.current = null;
      approvalChallengeIdRef.current = null;
      approvalPreviewKeyRef.current = null;
      setApprovalTools([]);
      if (previewKey) settlePendingAttentionPreviewRef.current(previewKey);
    } catch (err) {
      if (!isCurrentSubmission()) return;
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setApprovalError("Too many attempts. Please wait.");
        } else if (err.status === 401) {
          setApprovalError("Wrong PIN. Try again.");
        } else {
          setApprovalError(err.message || "Approval failed.");
        }
      } else {
        setApprovalError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [approvalTools, addMessage, liveShadowMessageClient?.deviceId]);

  const denyProveIt = useCallback(async () => {
    const threadId = approvalThreadIdRef.current;
    const previewKey = approvalPreviewKeyRef.current;
    const roomId = activeRoomIdRef.current;
    const viewerGeneration = viewerGenerationRef.current;
    const scopeGeneration = pendingAttentionUiScopeGenerationRef.current;
    const isCurrentSubmission = () => isPendingAttentionSubmissionCurrent({
      capturedKey: previewKey,
      capturedRoomId: roomId,
      capturedViewerGeneration: viewerGeneration,
      capturedScopeGeneration: scopeGeneration,
      currentKey: approvalPreviewKeyRef.current,
      currentRoomId: activeRoomIdRef.current,
      currentViewerGeneration: viewerGenerationRef.current,
      currentScopeGeneration: pendingAttentionUiScopeGenerationRef.current,
    });
    if (!threadId) {
      setShowApprovalDialog(false);
      return;
    }
    pendingAttentionLiveSequenceRef.current += 1;
    setApprovalError(undefined);
    try {
      await apiClient.denyProveIt(
        threadId,
        approvalLaneKeyRef.current ?? undefined,
        {
          clientActionSessionId: currentClientActionSessionIdForResume(),
          authorizationDeviceId: liveShadowMessageClient?.deviceId,
        },
        approvalChallengeIdRef.current ?? undefined,
      );
      if (!isCurrentSubmission()) return;
      setShowApprovalDialog(false);
      addMessage({
        id: newMessageId("system"),
        role: "assistant",
        content: [{ type: "text", text: `Denied: ${approvalTools.map((t) => t.name).join(", ")}` }],
      });
      approvalThreadIdRef.current = null;
      approvalLaneKeyRef.current = null;
      approvalChallengeIdRef.current = null;
      approvalPreviewKeyRef.current = null;
      setApprovalTools([]);
      setApprovalError(undefined);
      if (previewKey) settlePendingAttentionPreviewRef.current(previewKey);
    } catch (err) {
      if (!isCurrentSubmission()) return;
      if (err instanceof ApiError) {
        setApprovalError(err.message || "Could not deny approval.");
      } else {
        setApprovalError(`Network error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [approvalTools, addMessage, liveShadowMessageClient?.deviceId]);

  // --- D061 Phase 2-client (Chunk 5) — approval-ask dock submission ---
  //
  // One place for all four verbs. Dock passes the verb; we POST +
  // update state + append a small confirmation/system message. On
  // error we keep the dock open with an error line so the user can
  // retry while the active approval remains visible.
  //
  // ISSUE-D440 — the dock state is owned by the approval lifecycle
  // reducer. `submitStart` arms the in-flight flag; on a successful
  // HTTP ack `submitAck` clears the dock exactly once and records
  // the approvalId as terminal so a late/duplicate ask cannot
  // reopen it; on a lost ack `submitError` keeps the dock visible
  // with the error so the user can retry (we do NOT invent terminal
  // evidence — the server may or may not have received the decision).
  const submitApprovalAsk = useCallback(
    async (verb: ApprovalReplyVerb) => {
      const threadId = approvalAskThreadIdRef.current;
      const approvalId = approvalAskState.approvalId;
      const previewKey = approvalId === null ? null : `approval:${approvalId}`;
      const roomId = activeRoomIdRef.current;
      const viewerGeneration = viewerGenerationRef.current;
      const scopeGeneration = pendingAttentionUiScopeGenerationRef.current;
      const isCurrentSubmission = () => isPendingAttentionSubmissionCurrent({
        capturedKey: previewKey,
        capturedRoomId: roomId,
        capturedViewerGeneration: viewerGeneration,
        capturedScopeGeneration: scopeGeneration,
        currentKey: approvalLifecycleRef.current.pending === null
          ? null
          : `approval:${approvalLifecycleRef.current.pending.approvalId}`,
        currentRoomId: activeRoomIdRef.current,
        currentViewerGeneration: viewerGenerationRef.current,
        currentScopeGeneration: pendingAttentionUiScopeGenerationRef.current,
      });
      if (!threadId) return;
      if (
        approvalAskState.requiresExplicitReview &&
        (!approvalAskState.approvalId ||
          (approvalAskState.localMcpInstall === null &&
            approvalAskState.mediaGeneration === null &&
            approvalAskState.structuredSsh === null) ||
          (verb !== "once" && verb !== "deny"))
      ) {
        dispatchCurrentApprovalLifecycle({
          kind: "submitError",
          error: "This exact local review cannot be completed safely from this client.",
        });
        return;
      }
      pendingAttentionLiveSequenceRef.current += 1;
      dispatchCurrentApprovalLifecycle({ kind: "submitStart" });
      try {
        await apiClient.approvalReply(
          verb,
          threadId,
          approvalAskLaneKeyRef.current ?? undefined,
          approvalAskState.approvalId ?? undefined,
          approvalAskState.localMcpInstall?.digest,
          approvalAskState.mediaGeneration
            ? {
                digest: approvalAskState.mediaGeneration.digest,
                quoteDigest: approvalAskState.mediaGeneration.quoteDigest,
                revision: approvalAskState.mediaGeneration.revision,
              }
            : undefined,
          {
            clientActionSessionId: currentClientActionSessionIdForResume(),
            authorizationDeviceId: liveShadowMessageClient?.deviceId,
          },
        );
        if (!isCurrentSubmission()) return;
        // Accepted — close the dock. We deliberately do NOT append a
        // synthetic "Approved once: run_shell" assistant bubble here:
        // in a multi-step task with graduated approvals that pattern
        // stacks N identical bubbles that push the real narrative
        // off-screen and makes the stream read as duplicate assistant
        // filler. The dock's disappearance + the tool card (D083)
        // that follows are the visible signal the graph resumed.
        approvalAskThreadIdRef.current = null;
        approvalAskLaneKeyRef.current = null;
        dispatchCurrentApprovalLifecycle({
          kind: "submitAck",
          ...(approvalId === null ? {} : { approvalId }),
          resolution: resolutionFromVerb(verb),
        });
        if (approvalId) settlePendingAttentionPreviewRef.current(`approval:${approvalId}`);
      } catch (err) {
        if (!isCurrentSubmission()) return;
        dispatchCurrentApprovalLifecycle({
          kind: "submitError",
          ...(approvalId === null ? {} : { approvalId }),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [
      approvalAskState.approvalId,
      approvalAskState.localMcpInstall,
      approvalAskState.mediaGeneration,
      approvalAskState.requiresExplicitReview,
      approvalAskState.structuredSsh,
      dispatchCurrentApprovalLifecycle,
      liveShadowMessageClient?.deviceId,
    ],
  );

  const approvalAskControls = useMemo<ApprovalAskControls>(
    () => ({ state: approvalAskState, submit: submitApprovalAsk }),
    [approvalAskState, submitApprovalAsk],
  );

  const respondToCodexRequest = useCallback(
    async (requestId: string, response: CodexRequestResponse) => {
      const pending = codexRequestLifecycleRef.current.byId[requestId];
      // A delayed click after a terminal frame or room switch must not send a
      // response into a new/other request. The server repeats this exact
      // owner/request admission check, but fail closed at the UI seam too.
      if (
        !pending ||
        pending.ownerId !== viewerKeyRef.current ||
        pending.roomId !== activeRoomIdRef.current
      ) return;
      dispatchTrackedCodexRequestLifecycle({ kind: "submit_start", requestId });
      try {
        const receipt = await apiClient.codex.respondRequest(requestId, response);
        if (receipt.requestId !== requestId) {
          throw new Error("Codex response acknowledgement did not match the request");
        }
        // The requester-private `codex.request.resolved` frame is still
        // authoritative and will harmlessly no-op after this receipt clear.
        // Clearing on the accepted receipt prevents a dead card when that
        // realtime frame races with a room switch or socket reconnect.
        dispatchTrackedCodexRequestLifecycle({ kind: "submit_accepted", requestId });
      } catch (error) {
        // A durable user-input POST gets 404/409 when the server has proved
        // that the live Electron/relay closure no longer exists. Retain an
        // honest restart notice instead of offering a retry that cannot work.
        // Approval kinds remain the old ephemeral retry path.
        if (
          pending.request.kind === "user_input_required" &&
          error instanceof ApiError &&
          (error.status === 404 || error.status === 409)
        ) {
          dispatchTrackedCodexRequestLifecycle({ kind: "mark_unavailable", requestId });
        } else {
          dispatchTrackedCodexRequestLifecycle({
            kind: "submit_failed",
            requestId,
            message: error instanceof Error ? error.message : "Could not send the Codex response. Try again.",
          });
        }
      }
    },
    [dispatchTrackedCodexRequestLifecycle],
  );

  const dismissCodexRequest = useCallback((requestId: string) => {
    const pending = codexRequestLifecycleRef.current.byId[requestId];
    if (
      pending?.ownerId === viewerKeyRef.current &&
      codexRequestLifecycleRef.current.availabilityById[requestId] === "unavailable"
    ) {
      dispatchTrackedCodexRequestLifecycle({ kind: "dismiss", requestId });
    }
  }, [dispatchTrackedCodexRequestLifecycle]);

  const codexRequestControls = useMemo<CodexRequestControls>(
    () => ({ state: codexRequestState, respond: respondToCodexRequest, dismiss: dismissCodexRequest }),
    [codexRequestState, dismissCodexRequest, respondToCodexRequest],
  );

  // D375 — non-guest gate: only authenticated verified members may flip
  // the session mode (role !== guest/stranger). Guests never see the
  // toggle. This is intentionally LIGHTER than `manage_server_security`
  // (which stays reserved for the durable `security.level` posture): the
  // session flag can't do anything the viewer's own click-approve couldn't.
  const autoApproveControls = useMemo<AutoApproveControls>(
    () => ({
      enabled: autoApprove,
      setEnabled: setSessionAutoApprove,
      canToggle: auth.viewer.isVerified,
    }),
    [autoApprove, auth.viewer.isVerified, setSessionAutoApprove],
  );

  const roomHistoryControls = useMemo<RoomHistoryControls>(
    () => ({
      hasMoreBefore: hasMoreHistoryBefore,
      loadingBefore: loadingHistoryBefore,
      loadOlder: loadOlderHistory,
      ranges: roomHistoryAroundState.ranges,
      loadingAroundMessageId: roomHistoryAroundState.loadingMessageId,
      loadHistoryAround: roomHistoryAroundController.load,
    }),
    [
      hasMoreHistoryBefore,
      loadingHistoryBefore,
      loadOlderHistory,
      roomHistoryAroundController,
      roomHistoryAroundState,
    ],
  );

  const roomInitialHistoryControls = useMemo<RoomInitialHistoryControls>(
    () => ({ state: roomInitialHydrationState, retry: retryRoomInitialHydration }),
    [retryRoomInitialHydration, roomInitialHydrationState],
  );

  const roomMessageSearchControls = useMemo<RoomMessageSearchControls>(
    () => ({
      ...roomSearchState,
      setQuery: roomSearchController.setQuery,
      setMode: roomSearchController.setMode,
      setIgnoreCase: roomSearchController.setIgnoreCase,
      loadOlder: roomSearchController.loadOlder,
      loadNewer: roomSearchController.loadNewer,
      clear: roomSearchController.clear,
    }),
    [roomSearchController, roomSearchState],
  );

  const chatsSearchControls = useMemo<ChatsSearchControls>(
    () => ({
      ...chatsSearchState,
      setQuery: chatsSearchController.setQuery,
      setMode: chatsSearchController.setMode,
      setIgnoreCase: chatsSearchController.setIgnoreCase,
      loadOlderMessages: chatsSearchController.loadOlderMessages,
      loadNewerMessages: chatsSearchController.loadNewerMessages,
      retry: chatsSearchController.retry,
      clear: chatsSearchController.clear,
    }),
    [chatsSearchController, chatsSearchState],
  );

  const roomReactionControls = useMemo<RoomReactionControls>(
    () => ({ toggleReaction, viewerActorId: auth.viewer.sessionActorId }),
    [toggleReaction, auth.viewer.sessionActorId],
  );

  // A cache-backed syncing frame is safe to display but is never enough to
  // authorize a send. Keep those two admissions deliberately separate.
  const visibleMessages = initialHistoryAdmission.displayTranscript ? messages : [];
  const showPendingAttentionRecoveryUnavailable =
    pendingAttentionRecoveryUnavailable !== null
    && pendingAttentionRecoveryUnavailable.roomId === activeRoomId
    && pendingAttentionRecoveryUnavailable.viewerKey === viewerKey
    && pendingAttentionRecoveryUnavailable.viewerGeneration === auth.viewerGeneration
    && pendingAttentionRecoveryUnavailable.origin === serverOrigin;

  const runtime = useExternalStoreRuntime({
    messages: visibleMessages,
    setMessages: () => {
      // Don't let the runtime overwrite messagesRef — it's the WS handler's
      // source of truth. The runtime may drop tool-call messages during its
      // internal conversion round-trip.
    },
    onNew,
    // NOTE: deliberately NOT wiring assistant-ui's `onCancel`. Its `cancelRun`
    // does message-repository surgery (deletes the optimistic assistant msg and
    // the trailing user msg, copying its text into the composer) which corrupts
    // our WS-owned message list (our `setMessages` is a no-op). STOP instead
    // calls `stopActiveJobs` directly via the composer button (voiceControls).
    isRunning,
    convertMessage: (m) => m,
  });

  return (
    <TaskStateProvider wsState={wsState} bridgeRef={taskStateBridgeRef}>
    <RunningSubagentsFromTaskState>
    <WsStateContext.Provider value={{ state: wsState, lastOpenAt }}>
      <ProtectedRoomAccessContext.Provider value={protectedRoomAccess}>
      <NotificationRuntimeEventSourceContext.Provider
        value={notificationRuntimeEventSource}
      >
      <RoomMessageOperationsContext.Provider value={roomMessageOperations}>
      <ThreadRoomEventRouterContext.Provider value={threadRoomEventRouter}>
      <ConversationEncryptionPolicyModeContext.Provider value={shadowPolicyMode}>
      <RoomMessageEditContext.Provider value={editRoomMessage}>
      <RuntimeShellStateContext.Provider value={shellState}>
      <ChatsSearchContext.Provider value={chatsSearchControls}>
      <RoomMessageSearchContext.Provider value={roomMessageSearchControls}>
      <RoomInitialHistoryContext.Provider value={roomInitialHistoryControls}>
      <RoomHistoryContext.Provider value={roomHistoryControls}>
        <ToolActivityContext.Provider value={toolActivity}>
          <RevisionStateContext.Provider value={revisionState}>
          <VoiceControlsContext.Provider value={voiceControls}>
            <ApprovalAskContext.Provider value={approvalAskControls}>
              <CodexRequestContext.Provider value={codexRequestControls}>
              <AutoApproveContext.Provider value={autoApproveControls}>
              <RoomReactionsContext.Provider value={roomReactionControls}>
                <AssistantRuntimeProvider runtime={runtime}>
                  {children}

                  {modelFallbackStatus ? (
                    <ModelFallbackStatusNotice
                      line={modelFallbackStatus.line}
                      onDismiss={() => setModelFallbackStatus(null)}
                    />
                  ) : null}

                  {deepResearchStatus ? (
                    <DeepResearchStatusNotice line={deepResearchStatus.line} />
                  ) : null}

                  {foregroundContextStatus ? (
                    <ForegroundContextStatusNotice line={foregroundContextStatus.line} />
                  ) : null}

                  {showPendingAttentionRecoveryUnavailable ? (
                    <PendingAttentionRecoveryNotice
                      onRetry={pendingAttentionRecoveryUnavailable?.retryable === true
                        ? () => {
                            setPendingAttentionRecoveryUnavailable(null);
                            setPendingAttentionRecoveryRetryGeneration(
                              (generation) => generation + 1,
                            );
                          }
                        : undefined}
                    />
                  ) : null}

                  {shadowPolicyMode === "plaintext_only" &&
                  wsState === "open" &&
                  canInvokeAgents &&
                  auth.viewer.isVerified &&
                  viewerKey !== null &&
                  activeRoomId !== null &&
                  serverOrigin.length > 0 ? (
                    <OrdinaryContentAccessRecoveryNotice
                      key={`${serverOrigin}:${auth.viewerGeneration}:${viewerKey}:${activeRoomId}`}
                      roomId={activeRoomId}
                      scopeKey={`${serverOrigin}:${auth.viewerGeneration}:${viewerKey}:${activeRoomId}`}
                      discoveryGeneration={ordinaryContentAccessRecoveryGeneration}
                      foregroundRunning={isRunning}
                    />
                  ) : null}

                  {shadowPolicyMode === "plaintext_only" &&
                  wsState === "open" &&
                  auth.viewer.isVerified &&
                  viewerKey !== null &&
                  activeRoomId !== null &&
                  serverOrigin.length > 0 ? (
                    <PendingContentAccessRecoveryNotice
                      key={`pending-access:${serverOrigin}:${auth.viewerGeneration}:${viewerKey}:${activeRoomId}`}
                      serverOrigin={serverOrigin}
                      userId={viewerKey}
                      roomId={activeRoomId}
                      authGeneration={auth.viewerGeneration}
                    />
                  ) : null}

                {canInvokeAgents && showPinDialog && (
                  <PinDialog
                    key={challengePreviewKeyRef.current ?? "identity-challenge"}
                    onSubmit={(pin) => {
                      void submitPin(pin);
                    }}
                    onCancel={cancelPin}
                    error={pinError}
                    {...(challengeModeRef.current === "enrollPin"
                      ? {
                          title: "Set a PIN",
                          prompt:
                            "Pick a 6–8 digit PIN to confirm sensitive actions in the future.",
                        }
                      : {})}
                  />
                )}

                {canInvokeAgents && showApprovalDialog && (
                  <ApprovalDialog
                    key={approvalPreviewKeyRef.current ?? "prove-it-challenge"}
                    tools={approvalTools}
                    onSubmit={(pin) => {
                      void submitProveIt(pin);
                    }}
                    onDeny={() => {
                      void denyProveIt();
                    }}
                    error={approvalError}
                  />
                )}
                </AssistantRuntimeProvider>
              </RoomReactionsContext.Provider>
              </AutoApproveContext.Provider>
              </CodexRequestContext.Provider>
            </ApprovalAskContext.Provider>
          </VoiceControlsContext.Provider>
          </RevisionStateContext.Provider>
        </ToolActivityContext.Provider>
      </RoomHistoryContext.Provider>
      </RoomInitialHistoryContext.Provider>
      </RoomMessageSearchContext.Provider>
      </ChatsSearchContext.Provider>
      </RuntimeShellStateContext.Provider>
      </RoomMessageEditContext.Provider>
      </ConversationEncryptionPolicyModeContext.Provider>
      </ThreadRoomEventRouterContext.Provider>
      </RoomMessageOperationsContext.Provider>
      </NotificationRuntimeEventSourceContext.Provider>
      </ProtectedRoomAccessContext.Provider>
    </WsStateContext.Provider>
    </RunningSubagentsFromTaskState>
    </TaskStateProvider>
  );
}

export { type WsState };
