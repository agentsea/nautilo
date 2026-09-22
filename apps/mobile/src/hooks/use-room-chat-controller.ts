// D424 Phase 4.1 — room-independent chat controller extracted from the
// monolithic `app/chat/[roomId].tsx` screen. Owns transcript state, the
// realtime streaming subscription, send path, reactions, typing, paging,
// approvals wiring, voice input, attachments, model selection, routing
// receipts, reply targets, and stop behavior.
//
// The full-screen chat route and the future docked artifact-viewer pane
// both consume this controller so send/streaming logic is not duplicated.
// Screen-only chrome (room header title, members sheet, agent focus bar,
// model switcher sheet, keyboard/safe-area tuning) stays in the route and
// is wired via the controller's exposed state + a few register callbacks.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppState, FlatList, Platform } from "react-native";

import type { RoutingReceiptData } from "@/components/routing-receipt";
import {
  askUserCorrelationKey,
  buildAskUserResumeBody,
  isCurrentAskUserScope,
  projectAskUserRoutingState,
  type AskUserResumeBody,
  type AskUserRoutingPayload,
  type AskUserRoutingScope,
  type AskUserRoutingState,
} from "@/features/room-chat-pane/ask-user-routing";
import {
  MOBILE_CONTENT_FILTER_NOTICE,
  assessMobileHumanPosting,
} from "@/features/room-chat-pane/mobile-content-filter";
import { getApiClient } from "@/lib/api";
import { loadAssetBearer } from "@/lib/asset-bearer";
import {
  latestTranscriptWindow,
  mergeTranscriptWindow,
  returnTranscriptToLatest,
  targetToRestoreAfterLatestReload,
  type TranscriptWindowState,
} from "@/features/room-chat-search/transcript-window";
import {
  createTranscriptTargetNavigator,
  type TranscriptTargetNavigator,
} from "@/features/room-chat-search/target-navigation";
import {
  createRoomOperationGuard,
  type RoomOperationToken,
} from "@/features/room-chat-pane/room-operation-guard";
import { mayMarkRoomRead } from "@/features/room-chat-pane/viewport-state";
import { canEditMobileMessage, saveMobileMessageEdit } from "@/features/room-chat-pane/message-edit";
import { prepareRemoteOrdinaryRequestProof } from "@/features/remote/controller-ordinary-proof";
import {
  descriptorFromPickerAsset,
  pickImages,
  uploadImageAsset,
  type ImageUploadDescriptor,
} from "@/lib/attachments";
import {
  applyOptimisticReaction,
  applyReactionEvent,
  applyStreamEvent,
  applyThreadSummaryEvent,
  chatItemKey,
  chatItemPresentationKey,
  computeMessageGroupings,
  fromHistoryMessages,
  makeOptimisticUserItem,
  reconcileLatestHistoryItems,
  reconcileMessageReactions,
  reconcilePersistedHumanMessage,
  removeEmptyStreamingAssistantPlaceholder,
  roomIdFromLaneKey,
  type AttachmentResolver,
  type ChatItem,
} from "@/lib/messages";
import { getRoomModelSelection, setRoomModelSelection } from "@/lib/room-model-selection";
import {
  recoverMobileCapabilityDenial,
  type MobileCapabilityScope,
} from "@/lib/mobile-capability-denial";
import { viewerCan } from "@/lib/viewer-capabilities";
import { isDirectAgentRoom, isDirectHumanRoom } from "@/lib/direct-human-room";
import { projectMobileHumanMentions } from "@/features/room-chat-pane/human-mentions";
import {
  buildAuthorLabels,
  isGroupRoom,
  resolveAgentAuthorLabel,
} from "@/lib/room-authors";
import {
  consumeRoomDraftSnapshot,
  saveRoomDraft,
  saveRoomDraftSnapshot,
  type RoomDraftScope,
} from "@/lib/room-drafts";
import { useAttention } from "@/providers/attention";
import { useAutoApprove } from "@/providers/auto-approve";
import { useAuth } from "@/providers/auth";
import { useRealtime } from "@/providers/realtime";
import { useServers } from "@/providers/server-registry";
import { useVoice } from "@/providers/voice";
import { useVoiceInput } from "@/lib/voice-stt";
import {
  ApiError,
  DirectHumanInteractionBlockedError,
} from "@nautilo/api-client/browser";
import type { AssistantModelSummary } from "@nautilo/api-client/browser";
import {
  TYPING_DECAY_MS,
  TYPING_PING_INTERVAL_MS,
  MAX_CHAT_ATTACHMENTS_PER_MESSAGE,
  type ChatArtifactRef,
  type RoomMemberDto,
  type ServerEvent,
  type RoomDetailResponse,
  type HumanBlockStatusResponse,
} from "@nautilo/types";

const INITIAL_LIMIT = 30;
const PAGE_LIMIT = 30;
// D181 cursor sentinels for the initial "latest page" room-history request.
// Keep the id within Postgres int4 range; see session-rehydrate.ts.
const INITIAL_BEFORE_ID = "2147483647";
const INITIAL_BEFORE_CREATED_AT = "2099-12-31T00:00:00.000Z";
// Throttle for markRoomRead: the endpoint is idempotent, but we don't want
// to spam it on every render tick. One call per 2s is plenty.
const MARK_READ_THROTTLE_MS = 2000;
const MOBILE_CONTENT_FILTER_ENABLED = Platform.OS === "ios" || Platform.OS === "android";

// D382 — pending composer attachment (image). `status` drives the chip UI:
// "uploading" → spinner overlay; "ready" → ready to send;
// "failed" → error indicator + tap to retry.
export type PendingAttachment = {
  localId: string;
  /** Omitted for a recovered server-side upload; never persist a local URI. */
  uri?: string;
  name: string;
  mimeType?: string;
  status: "uploading" | "ready" | "failed";
  attachmentId?: string;
  /** Present only for a restored Share-upload draft; never a local file path. */
  sharedSizeBytes?: number;
};

function recoverableSharedAttachments(attachments: readonly PendingAttachment[]) {
  return attachments
    .filter((attachment) => attachment.status === "ready" && attachment.attachmentId && attachment.sharedSizeBytes !== undefined)
    .map((attachment) => ({
      kind: "server" as const,
      attachmentId: attachment.attachmentId!,
      filename: attachment.name,
      mimeType: attachment.mimeType ?? "application/octet-stream",
      sizeBytes: attachment.sharedSizeBytes!,
    }));
}

type PageInfo = {
  hasMoreBefore: boolean;
  oldestCursor: { id: string; createdAt: string } | null;
};

/** D408 — active inline-reply target (persisted messages only). */
export type ReplyTarget = {
  messageId: number;
  senderName: string;
  snippet: string;
};

export type MessageItem = Extract<ChatItem, { kind: "message" }>;

const REPLY_SNIPPET_MAX = 80;

function messageSnippet(item: MessageItem): string {
  const trimmed = item.text.trim();
  if (trimmed.length > 0) {
    return trimmed.length > REPLY_SNIPPET_MAX
      ? `${trimmed.slice(0, REPLY_SNIPPET_MAX - 1)}…`
      : trimmed;
  }
  if (item.attachments && item.attachments.length > 0) return "Photo";
  return "a message";
}

// D391 — resolve history attachment refs to authed byte-route sources.
// Loads the server bearer once so `<Image>` can fetch the retained blob
// (the byte route is namespace-gated; a missing token just yields 401 on
// the image load, not a crash).
async function buildAttachmentResolver(serverUrl: string, roomId: string): Promise<AttachmentResolver> {
  const client = getApiClient(serverUrl);
  const token = await loadAssetBearer(serverUrl);
  return (ref) => ({
    kind: "retained" as const,
    ...ref,
    uri: client.getMessageAttachmentUrl(ref.attachmentId, { roomId }),
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
}

/**
 * Composer capabilities for a chat surface. The full-screen chat enables
 * everything; the docked artifact-viewer pane (D424 Phase 4.2) disables only
 * the features its compact layout intentionally omits. Keep this
 * explicit so the docked pane is a real, opt-in consumer of the same
 * controller — not an opaque wrapper.
 */
export type RoomChatComposerCapabilities = {
  /** Image attachment pick / upload / chip row. */
  attachments: boolean;
  /** Push-to-talk mic input (hold → slide-cancel / release-send). */
  voiceInput: boolean;
  /** TTS playback toggle + stop-talking pill. */
  voicePlayback: boolean;
};

export const FULL_CHAT_CAPABILITIES: RoomChatComposerCapabilities = {
  attachments: true,
  voiceInput: true,
  voicePlayback: true,
};

export type RoomChatControllerOptions = {
  /** Route room id; the controller no-ops its effects until it is valid. */
  roomId: string | undefined;
  /** Optional exact persisted message requested by Search all chats. */
  targetMessageId?: string;
  /**
   * Workspace files kept in focus for every turn sent from this chat surface.
   * The server authoritatively resolves these metadata-only pointers.
   */
  artifactRefs?: readonly ChatArtifactRef[];
};

export type RoomChatController = ReturnType<typeof useRoomChatController>;

export function useRoomChatController({
  roomId,
  targetMessageId,
  artifactRefs = [],
}: RoomChatControllerOptions) {
  const { activeServer } = useServers();
  const { subscribe, send, recoveryRevision, withClientActionSession } = useRealtime();
  const { viewer, viewerState, status, refreshViewer } = useAuth();
  const canInvokeAgents = viewerCan(viewer, "invoke_agents");
  const canMentionEveryone = viewerCan(viewer, "manage_rooms");
  const { pendingApprovalForRoom, pendingHostChoiceForRoom } = useAttention();
  const { enabled: autoApproveEnabled } = useAutoApprove();
  const {
    enabled: voiceEnabled,
    toggle: toggleVoice,
    stop: stopVoice,
    speaking,
  } = useVoice();
  const { startRecording, stopAndTranscribe, cancelRecording } = useVoiceInput(
    activeServer?.serverUrl,
  );

  const [items, setItems] = useState<ChatItem[]>([]);
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
  const [transcriptWindow, setTranscriptWindow] = useState<TranscriptWindowState>(
    latestTranscriptWindow,
  );
  const transcriptWindowRef = useRef(transcriptWindow);
  transcriptWindowRef.current = transcriptWindow;
  const rehydrateAfterLoadRef = useRef<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<{ messageId: string; requestId: number } | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [targetNavigationError, setTargetNavigationError] = useState<string | null>(null);
  const targetRequestCounterRef = useRef(0);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paging, setPaging] = useState<PageInfo | null>(null);
  const [pagingOperation, setPagingOperation] = useState<RoomOperationToken | null>(null);
  const [typing, setTyping] = useState<{ displayName: string; at: number } | null>(
    null,
  );
  // Requester-private settled Conductor decision. It remains until dismissed
  // or replaced by a newer receipt for this room.
  const [routingReceipt, setRoutingReceipt] = useState<RoutingReceiptData | null>(null);
  // D524 — an ambiguous route is an ephemeral, requester-private recovery
  // action. It holds only the exact server-issued candidates and correlation
  // needed to re-send the already-persisted Human row once.
  const [askUserChoice, setAskUserChoice] = useState<AskUserRoutingState | null>(null);
  const askUserChoiceRef = useRef<AskUserRoutingState | null>(null);
  askUserChoiceRef.current = askUserChoice;
  const askUserContentByMessageIdRef = useRef(new Map<string, string>());
  const askUserResumeInFlightRef = useRef<string | null>(null);
  const [sendingOperation, setSendingOperation] = useState<RoomOperationToken | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [contentFilterNotice, setContentFilterNotice] = useState<string | null>(null);
  // The stream placeholder is not a job lifecycle signal: it can settle
  // between model output and a tool call. Keep the server-dispatched job live
  // until its terminal `job.status`, matching desktop's presence strip.
  const [liveJobIds, setLiveJobIds] = useState<ReadonlySet<string>>(() => new Set());
  // Local "turn was stopped" override so the composer's stop button greys down
  // the instant the user taps stop (mirrors desktop `voice.isRunning` flipping
  // false), instead of waiting on a terminal stream event that a stopped turn
  // may never deliver. Reset when a new turn is sent.
  const [stopped, setStopped] = useState(false);
  // Transient "Stopped" note shown on the AutoApproveBar row (auto-fades ~2.5s,
  // also dismissable). `stopNoteVisible` drives fade in/out.
  const [stopNoteVisible, setStopNoteVisible] = useState(false);

  useEffect(() => {
    setLiveJobIds(new Set());
  }, [roomId]);
  const stopNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // D412 — session-only model selection is keyed by paired server + room.
  // This revision counter only re-renders after a store write; it does not
  // retain a selection itself.
  const [, refreshModelSelection] = useReducer((revision: number) => revision + 1, 0);
  // Best-effort model list fetch so the chip can resolve the selected id to a
  // display name. The ModelSwitcherSheet fetches its own copy on open; this
  // one is the chip's label source. Failure is silent (chip falls back to
  // "Model").
  const [models, setModels] = useState<AssistantModelSummary[]>([]);
  // The absence of a Room override is still a real, usable model choice: the
  // authenticated Human's Agent default (or ultimately the server default).
  // Keep that inherited value explicit so the chip never lies with a generic
  // "Model" placeholder.
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  // D382 — pending image attachments; the chip row is
  // rendered above the composer input via `attachmentsSlot`. Cleared after
  // a successful send.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>(attachments);
  attachmentsRef.current = attachments;
  // Friendly inline note when the user denies media-library permission
  // (no crash, no system toast spam). Cleared on next successful pick.
  const [attachPermissionNote, setAttachPermissionNote] = useState<string | null>(null);
  const attachmentCounterRef = useRef(0);
  // AuthProvider is the sole source of viewer identity. Cached values are
  // advisory display data; server authorization remains authoritative.
  const viewerActorId = viewer?.actorId ?? null;
  const targetViewerEpochRef = useRef({ viewer, epoch: 0 });
  if (targetViewerEpochRef.current.viewer !== viewer) {
    targetViewerEpochRef.current = { viewer, epoch: targetViewerEpochRef.current.epoch + 1 };
  }
  const viewerUserId = viewer?.userId ?? null;
  const roomIdValid = typeof roomId === "string" && roomId.length > 0;
  const viewportScopeKey = activeServer && viewerActorId && roomIdValid && roomId
    ? `${activeServer.id}:${viewerActorId}:${targetViewerEpochRef.current.epoch}:${roomId}`
    : `unavailable:${targetViewerEpochRef.current.epoch}:${roomId ?? "none"}`;
  const [viewportReadState, setViewportReadState] = useState({
    scopeKey: viewportScopeKey,
    mounted: false,
    atLiveEdge: false,
  });
  const reportViewportReadState = useCallback((input: {
    scopeKey: string;
    mounted: boolean;
    atLiveEdge: boolean;
  }) => {
    if (input.scopeKey !== viewportScopeKey) return;
    setViewportReadState((current) =>
      current.scopeKey === input.scopeKey &&
      current.mounted === input.mounted &&
      current.atLiveEdge === input.atLiveEdge
        ? current
        : input,
    );
  }, [viewportScopeKey]);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      setAppIsActive(next === "active");
    });
    return () => subscription.remove();
  }, []);
  const askUserScope = useMemo<AskUserRoutingScope | null>(() =>
    activeServer && viewerUserId && viewerActorId && roomIdValid && roomId
      ? {
          serverId: activeServer.id,
          viewerUserId,
          viewerActorId,
          roomId,
        }
      : null,
  [activeServer?.id, roomId, roomIdValid, viewerActorId, viewerUserId]);
  const askUserScopeRef = useRef<AskUserRoutingScope | null>(askUserScope);
  askUserScopeRef.current = askUserScope;
  // Advance synchronously during render so a prior Room's in-flight work is
  // already stale before the new Room's effects start.
  const roomOperationGuardRef = useRef(createRoomOperationGuard());
  roomOperationGuardRef.current.activate({
    serverId: activeServer?.id ?? null,
    viewerId: viewerUserId,
    roomId: roomIdValid ? roomId : null,
  });
  const sending = sendingOperation !== null && roomOperationGuardRef.current.isCurrent(sendingOperation);
  const pagingLoading = pagingOperation !== null
    && roomOperationGuardRef.current.isCurrentPaging(pagingOperation);
  // D471 — encrypted, per-server/per-viewer/per-Room text draft recovery.
  // A draft is never a pending send: only the explicit Send handler can use it.
  const [draftText, setDraftTextState] = useState("");
  const draftTextRef = useRef(draftText);
  draftTextRef.current = draftText;
  const draftScope = useMemo<RoomDraftScope | null>(() =>
    activeServer && viewerState === "verified" && viewerUserId && roomIdValid && roomId
      ? { serverId: activeServer.id, viewerId: viewerUserId, roomId }
      : null,
  [activeServer?.id, roomId, roomIdValid, viewerState, viewerUserId]);
  const draftScopeRef = useRef<RoomDraftScope | null>(draftScope);
  draftScopeRef.current = draftScope;
  const previousDraftScopeRef = useRef<RoomDraftScope | null>(draftScope);
  if (draftScope) previousDraftScopeRef.current = draftScope;
  const draftGenerationRef = useRef(0);
  const setDraftText = useCallback((text: string) => {
    setContentFilterNotice(null);
    setDraftTextState(text);
    const scope = draftScopeRef.current;
    if (!scope) return;
    const recoveredAttachments = recoverableSharedAttachments(attachmentsRef.current);
    const persist = recoveredAttachments.length > 0
      ? saveRoomDraftSnapshot(scope, { text, attachments: recoveredAttachments })
      : saveRoomDraft(scope, text);
    // Draft persistence is best-effort machinery. Failure must not
    // interrupt or alarm the user because the live draft remains sendable.
    void persist.catch(() => {});
  }, []);
  useEffect(() => {
    const generation = ++draftGenerationRef.current;
    setDraftTextState("");
    if (!draftScope) return;
    void consumeRoomDraftSnapshot(draftScope).then((snapshot) => {
      if (draftGenerationRef.current === generation && draftScopeRef.current === draftScope) {
        setDraftTextState(snapshot.text);
        setAttachments(snapshot.attachments.flatMap((attachment) => attachment.kind === "server" ? [{
          localId: `draft-${attachment.attachmentId}`,
          name: attachment.filename,
          mimeType: attachment.mimeType,
          status: "ready" as const,
          attachmentId: attachment.attachmentId,
          sharedSizeBytes: attachment.sizeBytes,
        }] : []));
      }
    }).catch(() => {});
  }, [draftScope]);
  useEffect(() => {
    if (status === "signed-in") return;
    const prior = previousDraftScopeRef.current;
    previousDraftScopeRef.current = null;
    if (prior) void saveRoomDraft(prior, "").catch(() => {});
  }, [status]);
  const discardDraft = useCallback(() => setDraftText(""), [setDraftText]);
  const viewerActorIdRef = useRef<string | null>(null);
  viewerActorIdRef.current = viewerActorId;
  const viewerUserIdRef = useRef<string | null>(null);
  viewerUserIdRef.current = viewerUserId;
  const activeServerIdRef = useRef<string | null>(null);
  activeServerIdRef.current = activeServer?.id ?? null;
  const currentCapabilityScope = useCallback((): MobileCapabilityScope | null => {
    const serverId = activeServerIdRef.current;
    const userId = viewerUserIdRef.current;
    return serverId && userId ? { serverId, userId } : null;
  }, []);
  const hadViewerIdentityRef = useRef(viewerActorId != null && viewerUserId != null);
  // D408 — room roster for multi-participant sender labels + avatars.
  const [roomMembers, setRoomMembers] = useState<RoomMemberDto[]>([]);
  // Do not briefly render a group conversation as 1:1 while its roster loads:
  // the roster determines the transcript's stable incoming gutter.
  const [roomMembersLoading, setRoomMembersLoading] = useState(true);
  // The room id whose roster is represented in `roomMembers`. This prevents a
  // just-navigated room from inheriting the previous room's direct-chat chrome
  // during the single render before its new fetch begins.
  const [roomMembersRoomId, setRoomMembersRoomId] = useState<string | null>(null);
  // Room label for the screen's header title (set by the controller's room
  // fetch; the route owns navigation.setOptions).
  const [roomLabel, setRoomLabel] = useState("Chat");
  const [roomType, setRoomType] = useState<string | null>(null);
  // D408 — inline quote-reply composer target.
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);
  const [latestViewportRequest, setLatestViewportRequest] = useState<{
    id: number;
    origin: "control" | "local-send";
    awaitContentCommit: boolean;
  }>({ id: 0, origin: "control", awaitContentCommit: false });
  const activeRoomIdRef = useRef<string | undefined>(roomId);
  activeRoomIdRef.current = roomId;
  const roomRosterRequestRef = useRef(0);

  // Ref mirror so handlers read the latest page boundary without re-binding effects.
  const pagingRef = useRef(paging);
  pagingRef.current = paging;

  // Typing decay timer + outbound ping throttle + read throttle.
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPingRef = useRef<number>(0);
  const lastMarkReadRef = useRef<number>(0);
  const optimisticCounterRef = useRef(0);

  useEffect(() => {
    setTranscriptWindow(returnTranscriptToLatest());
    setScrollTarget(null);
    setHighlightedMessageId(null);
    setTargetNavigationError(null);
    setCapabilityError(null);
    setContentFilterNotice(null);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, [activeServer?.id, roomId, viewer]);

  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);
  // Keep the normal composition visible until the current roster has settled.
  // A direct Human conversation is defined only by its live member counts,
  // never by room kind.
  const directHumanRoom =
    !roomMembersLoading &&
    roomMembersRoomId === roomId &&
    isDirectHumanRoom(roomMembers);
  const directAgentRoom =
    !roomMembersLoading &&
    roomMembersRoomId === roomId &&
    isDirectAgentRoom(roomMembers);
  const directHumanPeerUserId = useMemo(() => {
    if (!directHumanRoom || !viewerUserId) return null;
    return roomMembers.find(
      (member) => member.kind === "user" && member.userId !== viewerUserId,
    )?.userId ?? null;
  }, [directHumanRoom, roomMembers, viewerUserId]);
  const [directHumanBlockStatus, setDirectHumanBlockStatus] =
    useState<HumanBlockStatusResponse | null>(null);
  const [blockedHumanUserIds, setBlockedHumanUserIds] = useState<Set<string>>(new Set());

  const refreshBlockedHumanUserIds = useCallback(async (): Promise<void> => {
    if (!activeServer) {
      setBlockedHumanUserIds(new Set());
      return;
    }
    try {
      setBlockedHumanUserIds(
        new Set(await getApiClient(activeServer.serverUrl).listBlockedHumanUserIds()),
      );
    } catch {
      // Preserve the previous list across transient transport failures.
    }
  }, [activeServer]);

  const refreshDirectHumanBlockStatus = useCallback(async (): Promise<void> => {
    if (!activeServer || !directHumanPeerUserId) {
      setDirectHumanBlockStatus(null);
      return;
    }
    try {
      const status = await getApiClient(activeServer.serverUrl)
        .getHumanBlockStatus(directHumanPeerUserId);
      setDirectHumanBlockStatus(status);
    } catch {
      // The server remains authoritative. A failed status read must not hide
      // history or turn an unrelated transport error into a local block.
      setDirectHumanBlockStatus(null);
    }
  }, [activeServer, directHumanPeerUserId]);

  useEffect(() => {
    void refreshDirectHumanBlockStatus();
  }, [refreshDirectHumanBlockStatus]);

  useEffect(() => {
    void refreshBlockedHumanUserIds();
  }, [refreshBlockedHumanUserIds]);

  const handleBlockHuman = useCallback(async (userId: string): Promise<boolean> => {
    if (!activeServer) return false;
    try {
      const status = await getApiClient(activeServer.serverUrl).blockHuman(userId);
      setBlockedHumanUserIds((current) => new Set(current).add(userId));
      if (userId === directHumanPeerUserId) setDirectHumanBlockStatus(status);
      return true;
    } catch {
      return false;
    }
  }, [activeServer, directHumanPeerUserId]);

  const handleUnblockHuman = useCallback(async (userId: string): Promise<boolean> => {
    if (!activeServer) return false;
    try {
      const status = await getApiClient(activeServer.serverUrl).unblockHuman(userId);
      setBlockedHumanUserIds((current) => {
        const next = new Set(current);
        next.delete(userId);
        return next;
      });
      if (userId === directHumanPeerUserId) setDirectHumanBlockStatus(status);
      return true;
    } catch {
      return false;
    }
  }, [activeServer, directHumanPeerUserId]);

  const directHumanInteractionBlocked =
    directHumanBlockStatus?.directInteractionBlocked === true;
  const modelId =
    canInvokeAgents && activeServer && roomIdValid
      ? getRoomModelSelection(activeServer.id, roomId)
      : null;

  useEffect(() => {
    setRoutingReceipt(null);
    askUserResumeInFlightRef.current = null;
    askUserContentByMessageIdRef.current.clear();
    askUserChoiceRef.current = null;
    setAskUserChoice(null);
  }, [askUserScope?.serverId, askUserScope?.viewerUserId, askUserScope?.viewerActorId, askUserScope?.roomId]);

  useEffect(() => {
    const current = askUserChoiceRef.current;
    if (!current || current.originalContent || !isCurrentAskUserScope(current, askUserScope)) return;
    const content = items.find(
      (item): item is MessageItem => item.kind === "message" &&
        item.role === "user" && String(item.id) === current.messageId,
    )?.text;
    if (!content || content.trim().length === 0) return;
    askUserContentByMessageIdRef.current.set(current.messageId, content);
    const hydrated = { ...current, originalContent: content };
    askUserChoiceRef.current = hydrated;
    setAskUserChoice((pending) => pending &&
      askUserCorrelationKey(pending) === askUserCorrelationKey(current)
        ? hydrated
        : pending,
    );
  }, [askUserChoice, askUserScope, items]);

  const handleModelSelect = useCallback(
    (selectedModelId: string | null) => {
      if (!canInvokeAgents || !activeServer || !roomIdValid) return;
      setRoomModelSelection(activeServer.id, roomId, selectedModelId);
      refreshModelSelection();
    },
    [activeServer, canInvokeAgents, roomId, roomIdValid],
  );

  // The in-room approval card source. Re-derived on every render from
  // the attention provider; cleared locally when the user replies.
  const roomApproval = canInvokeAgents && roomIdValid && roomId
    ? pendingApprovalForRoom(roomId)
    : null;
  const roomHostChoice = canInvokeAgents && roomIdValid && roomId
    ? pendingHostChoiceForRoom(roomId)
    : null;

  // ---- Room roster (label + grouping source) ----
  // The route reads `roomLabel` to push the AppBar title; the controller
  // owns the fetch + roster state so docking reuses the same source. Every
  // refresh is sequence- and room-guarded so an old room response cannot
  // replace the current room's canonical composition.
  const refreshRoomRoster = useCallback(async () => {
    if (!activeServer || !roomIdValid || !roomId) {
      roomRosterRequestRef.current += 1;
      setRoomMembers([]);
      setRoomMembersLoading(false);
      setRoomMembersRoomId(null);
      setRoomLabel("Chat");
      setRoomType(null);
      return;
    }
    const requestId = ++roomRosterRequestRef.current;
    setRoomMembersLoading(true);
    setRoomMembersRoomId(null);
    try {
      const room = await getApiClient(activeServer.serverUrl).getRoom(roomId);
      if (
        requestId !== roomRosterRequestRef.current ||
        activeRoomIdRef.current !== roomId
      ) {
        return;
      }
      setRoomLabel(room.label && room.label.length > 0 ? room.label : "Chat");
      setRoomType(room.type);
      setRoomMembers(room.members ?? []);
      setRoomMembersRoomId(roomId);
    } catch {
      if (
        requestId === roomRosterRequestRef.current &&
        activeRoomIdRef.current === roomId
      ) {
        setRoomLabel("Chat");
        setRoomType(null);
        setRoomMembers([]);
        setRoomMembersRoomId(roomId);
      }
    } finally {
      if (
        requestId === roomRosterRequestRef.current &&
        activeRoomIdRef.current === roomId
      ) {
        setRoomMembersLoading(false);
      }
    }
  }, [activeServer, roomId, roomIdValid]);

  /** Publish the canonical response from the shared rename mutation to room chrome immediately. */
  const applyCanonicalRoomDetail = useCallback((detail: RoomDetailResponse) => {
    if (!roomIdValid || detail.id !== roomId) return;
    setRoomLabel(detail.label && detail.label.length > 0 ? detail.label : "Chat");
    setRoomType(detail.type);
    setRoomMembers(detail.members ?? []);
    setRoomMembersRoomId(roomId);
    setRoomMembersLoading(false);
  }, [roomId, roomIdValid]);

  useEffect(() => {
    void refreshRoomRoster();
  }, [refreshRoomRoster]);

  // ---- Model list (chip label source) ----
  // Do not fetch a presentation-only catalog for a settled direct Human
  // conversation: it has no picker. The sheet separately fetches on open,
  // and the route unmounts it in this state.
  useEffect(() => {
    if (!canInvokeAgents || !activeServer || roomMembersLoading || directHumanRoom) {
      setModels([]);
      setDefaultModelId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const api = getApiClient(activeServer.serverUrl);
        const profile = await api.getProfile().catch(() => null);
        const retainedIds = [
          modelId,
          profile?.viewerRole === "owner" ? profile.agent.defaultModel : null,
        ].filter((id): id is string => !!id);
        const [list, retained] = await Promise.all([
          api.getModels(),
          retainedIds.length > 0
            ? api.resolveRetainedModels(retainedIds)
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const byId = new Map(list.map((model) => [model.id, model]));
        for (const model of retained) byId.set(model.id, model);
        setModels(Array.from(byId.values()));
        setDefaultModelId(
          profile?.viewerRole === "owner" ? profile.agent.defaultModel : null,
        );
      } catch {
        if (!cancelled) {
          setModels([]);
          setDefaultModelId(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeServer, canInvokeAgents, roomMembersLoading, directHumanRoom, modelId]);

  const defaultModelLabel = useMemo(() => {
    if (!defaultModelId) return "Server default";
    const found = models.find((model) => model.id === defaultModelId);
    return found?.displayName || defaultModelId;
  }, [defaultModelId, models]);

  // Resolve the explicit override or inherited default to a truthful label.
  const modelLabel = useMemo(() => {
    if (!modelId) return defaultModelLabel;
    const found = models.find((m) => m.id === modelId);
    return found?.displayName || modelId;
  }, [defaultModelLabel, modelId, models]);

  // ---- Initial load (latest room history page) ----
  const loadInitial = useCallback(async (options?: { background?: boolean }) => {
    if (!activeServer || !roomIdValid || !roomId) {
      setItems([]);
      setLoading(false);
      return;
    }
    const background = options?.background === true && itemsRef.current.length > 0;
    const operation = roomOperationGuardRef.current.beginInitialHistory();
    // Catch-up must not replace a mounted transcript with a loading screen.
    // Only the genuine first load (or explicit retry from an empty/error
    // surface) owns the blocking spinner.
    if (!background) setLoading(true);
    if (!background) setError(null);
    try {
      const res = await getApiClient(activeServer.serverUrl).getOlderRoomMessages({
        roomId,
        beforeId: INITIAL_BEFORE_ID,
        beforeCreatedAt: INITIAL_BEFORE_CREATED_AT,
        limit: INITIAL_LIMIT,
      });
      const resolve = await buildAttachmentResolver(activeServer.serverUrl, roomId);
      if (!roomOperationGuardRef.current.isCurrentInitialHistory(operation)) return;
      const latestItems = fromHistoryMessages(res.messages, resolve, viewerActorIdRef.current);
      if (background) {
        setItems((current) => {
          const reconciled = reconcileLatestHistoryItems(current, latestItems);
          itemsRef.current = reconciled;
          return reconciled;
        });
      } else {
        rehydrateAfterLoadRef.current = targetToRestoreAfterLatestReload(
          transcriptWindowRef.current,
        );
        itemsRef.current = latestItems;
        setItems(latestItems);
      }
      setPaging(res.pageInfo ?? null);
    } catch (e) {
      if (!background && roomOperationGuardRef.current.isCurrentInitialHistory(operation)) {
        setError(e instanceof Error ? e.message : "Could not load conversation.");
      }
    } finally {
      if (!background && roomOperationGuardRef.current.isCurrentInitialHistory(operation)) {
        setLoading(false);
      }
    }
  }, [activeServer, roomId, roomIdValid]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // Reconcile history reaction `mine` flags once AuthProvider delivers identity.
  // Group layout re-evaluates via `viewerUserId` deps on messageGroupings /
  // resolveSenderChrome without a history refetch.
  useEffect(() => {
    const hasIdentity = viewerActorId != null && viewerUserId != null;
    if (hasIdentity && !hadViewerIdentityRef.current && roomIdValid && activeServer) {
      hadViewerIdentityRef.current = true;
      void loadInitial({ background: itemsRef.current.length > 0 });
    }
    if (!hasIdentity) hadViewerIdentityRef.current = false;
  }, [viewerActorId, viewerUserId, roomIdValid, activeServer, loadInitial]);

  // ---- Pagination (older messages, prepend) ----
  const loadOlder = useCallback(async () => {
    if (!activeServer || !roomIdValid || !roomId) return;
    const p = pagingRef.current;
    if (!p || !p.hasMoreBefore || !p.oldestCursor) return;
    const operation = roomOperationGuardRef.current.begin();
    if (!roomOperationGuardRef.current.acquirePaging(operation)) return;
    setPagingOperation(operation);
    try {
      const res = await getApiClient(activeServer.serverUrl).getOlderRoomMessages({
        roomId,
        beforeId: p.oldestCursor.id,
        beforeCreatedAt: p.oldestCursor.createdAt,
        limit: PAGE_LIMIT,
      });
      const resolve = await buildAttachmentResolver(activeServer.serverUrl, roomId);
      if (!roomOperationGuardRef.current.isCurrentPaging(operation)) return;
      const older = fromHistoryMessages(res.messages, resolve, viewerActorIdRef.current);
      setItems((prev) => {
        const seen = new Set(prev.map(chatItemKey));
        const fresh = older.filter((it) => !seen.has(chatItemKey(it)));
        return [...fresh, ...prev];
      });
      setPaging(res.pageInfo ?? null);
    } catch {
      // silent — keep current list; user can retry by scrolling up again
    } finally {
      const ownsPaging = roomOperationGuardRef.current.isCurrentPaging(operation);
      roomOperationGuardRef.current.releasePaging(operation);
      if (ownsPaging) setPagingOperation(null);
    }
  }, [activeServer, roomId, roomIdValid]);

  const focusTranscriptTarget = useCallback((messageId: string) => {
    targetRequestCounterRef.current += 1;
    setScrollTarget({ messageId, requestId: targetRequestCounterRef.current });
    setHighlightedMessageId(messageId);
    setTargetNavigationError(null);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedMessageId((current) => current === messageId ? null : current);
    }, 2200);
  }, []);

  const targetRuntimeRef = useRef({ activeServer, roomId });
  targetRuntimeRef.current = { activeServer, roomId };
  const targetNavigatorRef = useRef<TranscriptTargetNavigator | null>(null);
  if (!targetNavigatorRef.current) {
    targetNavigatorRef.current = createTranscriptTargetNavigator({
      getItems: () => itemsRef.current,
      fetchAround: async (messageId) => {
        const runtime = targetRuntimeRef.current;
        if (!runtime.activeServer || !runtime.roomId) throw new Error("No active Room");
        return getApiClient(runtime.activeServer.serverUrl).getRoomMessagesAround({
          roomId: runtime.roomId,
          messageId,
          limit: 30,
        });
      },
      hydrate: async (page) => {
        const runtime = targetRuntimeRef.current;
        if (!runtime.activeServer) throw new Error("No active Server");
        const resolve = await buildAttachmentResolver(runtime.activeServer.serverUrl, runtime.roomId!);
        return fromHistoryMessages(page.messages, resolve, viewerActorIdRef.current);
      },
      apply: (nextItems, window) => {
        setItems((current) => mergeTranscriptWindow({
          current,
          hydrated: nextItems,
          targetMessageId: window.targetMessageId ?? "",
          hasOlder: window.hasOlderGap,
          hasNewer: window.hasNewerGap,
        }).items);
        setTranscriptWindow(window);
      },
      focus: focusTranscriptTarget,
      fail: setTargetNavigationError,
    });
  }
  const targetNavigator = targetNavigatorRef.current;
  const targetScopeKey = activeServer && roomIdValid && roomId && viewerActorId
    ? `${activeServer.id}:${viewerActorId}:${targetViewerEpochRef.current.epoch}:${roomId}`
    : null;
  useEffect(() => targetNavigator.setScope(targetScopeKey), [targetNavigator, targetScopeKey]);
  useEffect(() => () => targetNavigator.dispose(), [targetNavigator]);

  const activateMessageTarget = useCallback(
    (messageId: string): Promise<boolean> => targetNavigator.activate(messageId),
    [targetNavigator],
  );

  const cancelMessageTargetNavigation = useCallback(() => {
    targetNavigator.cancel();
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setScrollTarget(null);
    setHighlightedMessageId(null);
    setTargetNavigationError(null);
  }, [targetNavigator]);

  useEffect(() => {
    if (loading) return;
    const restore = rehydrateAfterLoadRef.current;
    if (!restore) return;
    rehydrateAfterLoadRef.current = null;
    void activateMessageTarget(restore);
  }, [activateMessageTarget, loading]);

  useEffect(() => {
    if (!targetMessageId || loading || !roomIdValid) return;
    void activateMessageTarget(targetMessageId);
  }, [activateMessageTarget, loading, roomIdValid, targetMessageId]);

  const requestLatestViewport = useCallback((
    origin: "control" | "local-send",
    awaitContentCommit = false,
  ) => {
    cancelMessageTargetNavigation();
    setTranscriptWindow(returnTranscriptToLatest());
    setLatestViewportRequest((request) => ({
      id: request.id + 1,
      origin,
      awaitContentCommit,
    }));
  }, [cancelMessageTargetNavigation]);
  const returnToLatest = useCallback(() => requestLatestViewport("control"), [requestLatestViewport]);
  const releaseViewportAtLiveEdge = useCallback(() => {
    cancelMessageTargetNavigation();
    setTranscriptWindow(returnTranscriptToLatest());
  }, [cancelMessageTargetNavigation]);

  const installAskUserPayload = useCallback((payload: AskUserRoutingPayload) => {
    const scope = askUserScopeRef.current;
    if (!scope) return;
    const messageId = payload.messageId;
    const knownContent = messageId
      ? askUserContentByMessageIdRef.current.get(messageId) ??
        itemsRef.current.find(
          (item): item is MessageItem => item.kind === "message" &&
            item.role === "user" && String(item.id) === messageId,
        )?.text
      : null;
    const content = knownContent && knownContent.trim().length > 0 ? knownContent : null;
    const current = askUserChoiceRef.current;
    const next = projectAskUserRoutingState(payload, scope, content, current);
    // No-op for the decision counterpart/reconnect replay. In particular, do
    // not overwrite a synchronous selectingActorId ref with a fresh state.
    if (!next || next === current) return;
    setRoutingReceipt(null);
    askUserChoiceRef.current = next;
    setAskUserChoice(next);
  }, []);

  const handleToggleVoice = useCallback(() => {
    toggleVoice();
  }, [toggleVoice]);

  const reportTargetScrollFailure = useCallback(() => {
    setTargetNavigationError("Could not position that message. Try the result again.");
  }, []);

  const loadHistoricalOlderGap = useCallback(async (): Promise<boolean> => {
    if (!activeServer || !roomIdValid || !roomId) return false;
    const oldest = itemsRef.current.find(
      (item): item is MessageItem => item.kind === "message" && /^\d+$/.test(String(item.id)),
    );
    if (!oldest) {
      setTargetNavigationError("Could not identify the oldest loaded message.");
      return false;
    }
    const operation = roomOperationGuardRef.current.begin();
    if (!roomOperationGuardRef.current.acquirePaging(operation)) return false;
    setPagingOperation(operation);
    try {
      const res = await getApiClient(activeServer.serverUrl).getOlderRoomMessages({
        roomId,
        beforeId: String(oldest.id),
        beforeCreatedAt: oldest.createdAt,
        limit: PAGE_LIMIT,
      });
      const resolve = await buildAttachmentResolver(activeServer.serverUrl, roomId);
      if (!roomOperationGuardRef.current.isCurrentPaging(operation)) return false;
      const older = fromHistoryMessages(res.messages, resolve, viewerActorIdRef.current);
      setItems((current) => {
        const seen = new Set(current.map(chatItemKey));
        return [...older.filter((item) => !seen.has(chatItemKey(item))), ...current];
      });
      setPaging(res.pageInfo ?? null);
      setTranscriptWindow((current) => current.mode === "historical"
        ? { ...current, hasOlderGap: res.pageInfo.hasMoreBefore }
        : current);
      return true;
    } catch {
      if (roomOperationGuardRef.current.isCurrentPaging(operation)) {
        setTargetNavigationError("Could not load older messages. Try again.");
      }
      return false;
    } finally {
      const ownsPaging = roomOperationGuardRef.current.isCurrentPaging(operation);
      roomOperationGuardRef.current.releasePaging(operation);
      if (ownsPaging) setPagingOperation(null);
    }
  }, [activeServer, roomId, roomIdValid]);

  // ---- Streaming + typing subscription ----
  useEffect(() => {
    if (!roomIdValid || !roomId) return;
    const handler = (event: ServerEvent): void => {
      if (event.type === "job.dispatched") {
        if (roomIdFromLaneKey(event.laneKey) !== roomId) return;
        setLiveJobIds((previous) => new Set(previous).add(event.jobId));
        return;
      }
      if (event.type === "job.status") {
        const terminal =
          event.status === "completed" ||
          event.status === "failed" ||
          event.status === "timed_out" ||
          event.status === "cancelled";
        if (!terminal) return;
        setLiveJobIds((previous) => {
          if (!previous.has(event.jobId)) return previous;
          const next = new Set(previous);
          next.delete(event.jobId);
          return next;
        });
        return;
      }
      if (event.type === "typing.ping") {
        if (event.roomId !== roomId) return;
        const now = Date.now();
        setTyping({ displayName: event.displayName, at: now });
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => setTyping(null), TYPING_DECAY_MS);
        return;
      }
      if (event.type === "room_members_changed") {
        if (event.roomId !== roomId) return;
        void refreshRoomRoster();
        return;
      }
      if (event.type === "conductor.ask_user") {
        // This is the canonical chooser transport. It is requester-scoped by
        // its user actor, while the decision receipt below is an idempotent
        // requester-private counterpart; neither raw `reason` nor extra
        // roster candidates enter the UI.
        installAskUserPayload(event);
        return;
      }
      if (event.type === "conductor.decision") {
        // The server delivers this requester-private, but retain all local
        // scope checks: an event replay, stale room, or account switch may
        // never make a different person's persisted message resumable here.
        const scope = askUserScopeRef.current;
        if (
          !scope ||
          event.roomId !== scope.roomId ||
          event.userId !== scope.viewerUserId ||
          event.userActorId !== scope.viewerActorId
        ) return;
        if (event.outcome !== "ask_user") {
          // Wake and silence are normal delivery. Error has no safe local
          // recovery metadata, so it is equally quiet. Only settle the
          // matching choice; a later unrelated receipt must not dismiss it.
          setRoutingReceipt(null);
          const current = askUserChoiceRef.current;
          if (current && current.messageId === event.messageId &&
            current.resumeTurnId === (event.humanTurnId ?? null)) {
            askUserChoiceRef.current = null;
            setAskUserChoice(null);
          }
          return;
        }
        installAskUserPayload(event);
        return;
      }
      if (
        event.type === "message.tokens" ||
        event.type === "message.new" ||
        event.type === "message.updated" ||
        event.type === "message.deleted"
      ) {
        if (roomIdFromLaneKey(event.laneKey) !== roomId) return;
        setItems((prev) => applyStreamEvent(prev, event));
        return;
      }
      if (event.type === "thread.summary.changed") {
        if (roomIdFromLaneKey(event.laneKey) !== roomId) return;
        setItems((prev) => applyThreadSummaryEvent(prev, event));
        return;
      }
      if (event.type === "tool.start" || event.type === "tool.end") {
        // D212 — the agent `react` tool surfaces via reaction.added/removed on
        // the target message, not as a ToolCard. D408 — still clear any empty
        // streaming assistant placeholder the turn may have opened.
        if (event.toolName === "react") {
          if (event.type === "tool.end") {
            setItems((prev) =>
              removeEmptyStreamingAssistantPlaceholder(prev, {
                turnId: event.turnId,
                authorAgentId: event.authorAgentId,
              }),
            );
          }
          return;
        }
        // laneKey optional on tool.* — if absent, apply to active room.
        const matchRoom = roomIdFromLaneKey(event.laneKey);
        if (matchRoom !== null && matchRoom !== roomId) return;
        setItems((prev) => applyStreamEvent(prev, event));
        return;
      }
      if (event.type === "reaction.added" || event.type === "reaction.removed") {
        if (roomIdFromLaneKey(event.laneKey) !== roomId) return;
        setItems((prev) =>
          applyReactionEvent(prev, event, viewerActorIdRef.current),
        );
        return;
      }
    };
    return subscribe(handler);
  }, [subscribe, roomId, roomIdValid, refreshRoomRoster, installAskUserPayload]);

  // Cleanup typing timer on unmount.
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  // ---- Rehydrate on reconnect (preserve composer draft) ----
  // The Composer owns its own text state, so a refetch here doesn't blow
  // away the user's in-progress draft. We only refetch the message list.
  // RealtimeProvider refreshes AuthProvider's viewer identity on this same
  // transition; screens never issue their own whoami repair request.
  const previousRecoveryRevisionRef = useRef(recoveryRevision);
  useEffect(() => {
    const previous = previousRecoveryRevisionRef.current;
    previousRecoveryRevisionRef.current = recoveryRevision;
    if (recoveryRevision > previous) {
      void loadInitial({ background: true });
    }
  }, [recoveryRevision, loadInitial]);

  // ---- Read state ----
  const markRead = useCallback(async () => {
    if (!activeServer || !roomIdValid || !roomId) return;
    const now = Date.now();
    if (now - lastMarkReadRef.current < MARK_READ_THROTTLE_MS) return;
    lastMarkReadRef.current = now;
    try {
      await getApiClient(activeServer.serverUrl).markRoomRead(roomId);
    } catch {
      // best-effort — read state must not block the UI
    }
  }, [activeServer, roomId, roomIdValid]);

  // A mounted transcript may mark its newest visible message read only while
  // the app is active and the native viewport truthfully remains at the live
  // edge. Stable presentation identity suppresses per-token and durable-id
  // reconciliation inflation.
  const newestKey = items.length > 0
    ? chatItemPresentationKey(items[items.length - 1])
    : null;
  const viewportMayMarkRead = mayMarkRoomRead({
    active: appIsActive,
    mounted: viewportReadState.mounted,
    atLiveEdge: viewportReadState.atLiveEdge,
    reportedScopeKey: viewportReadState.scopeKey,
    currentScopeKey: viewportScopeKey,
  });
  useEffect(() => {
    if (!viewportMayMarkRead) return;
    void markRead();
  }, [markRead, newestKey, viewportMayMarkRead]);

  // ---- Outbound typing ping (throttled) ----
  // The Composer primitive doesn't expose onChange (adding it requires
  // editing the primitive, out of this phase's owned-files allow-list).
  // For P6 we emit one ping per sent message — the user had focus + text
  // at send time, so a single ping per message is a faithful "just typed"
  // signal and well below the 3s throttle. True per-keystroke pings are
  // a tracked follow-up that needs an onChange prop on Composer.
  //
  // The server fills in `userId` from socket auth and falls back to
  // "Someone" when displayName is empty (packages/server/src/routes/ws.ts).
  // We don't have a local profile context in P6, so we send an empty
  // displayName; a follow-up can wire the user's profile name once a
  // ProfileProvider exists.
  const emitTypingPing = useCallback(() => {
    if (!roomIdValid || !roomId) return;
    const now = Date.now();
    if (now - lastPingRef.current < TYPING_PING_INTERVAL_MS) return;
    lastPingRef.current = now;
    send({ type: "typing.ping", roomId, displayName: "" });
  }, [send, roomId, roomIdValid]);

  // ---- Attach image ----
  // Multi-pick → one "uploading" chip per asset → upload in parallel → ready/failed.
  const uploadAttachmentChip = useCallback(
    async (localId: string, descriptor: ImageUploadDescriptor) => {
      if (!activeServer || !roomIdValid || !roomId) return;
      try {
        const attachmentId = await uploadImageAsset(
          activeServer.serverUrl,
          roomId,
          descriptor,
        );
        setAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId ? { ...a, status: "ready", attachmentId } : a,
          ),
        );
      } catch {
        setAttachments((prev) =>
          prev.map((a) => (a.localId === localId ? { ...a, status: "failed" } : a)),
        );
      }
    },
    [activeServer, roomId, roomIdValid],
  );

  const handleAttach = useCallback(async () => {
    if (!activeServer || !roomIdValid) return;
    setAttachPermissionNote(null);
    const remaining = MAX_CHAT_ATTACHMENTS_PER_MESSAGE - attachments.length;
    if (remaining <= 0) {
      setAttachPermissionNote("Up to 10 images per message.");
      return;
    }
    const picked = await pickImages(remaining);
    if (picked.length === 0) {
      setAttachPermissionNote("Photo access is required to attach an image.");
      return;
    }
    let assets = picked;
    if (picked.length > remaining) {
      assets = picked.slice(0, remaining);
      setAttachPermissionNote(
        `Only ${remaining} more image${remaining === 1 ? "" : "s"} added (10 per message).`,
      );
    }
    const newChips: PendingAttachment[] = assets.map((asset) => {
      const d = descriptorFromPickerAsset(asset);
      return {
        localId: `att-${Date.now()}-${attachmentCounterRef.current++}`,
        uri: d.uri,
        name: d.name,
        mimeType: d.mimeType,
        status: "uploading" as const,
      };
    });
    setAttachments((prev) => [...prev, ...newChips]);
    for (const chip of newChips) {
      if (!chip.uri) continue;
      void uploadAttachmentChip(chip.localId, {
        uri: chip.uri,
        name: chip.name,
        mimeType: chip.mimeType,
      });
    }
  }, [activeServer, roomIdValid, attachments.length, uploadAttachmentChip]);

  const handleRetry = useCallback(
    (localId: string) => {
      const target = attachments.find((a) => a.localId === localId);
      if (!target || target.status !== "failed" || !target.uri) return;
      const descriptor: ImageUploadDescriptor = {
        uri: target.uri,
        name: target.name,
        mimeType: target.mimeType,
      };
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? { ...a, status: "uploading", attachmentId: undefined }
            : a,
        ),
      );
      void uploadAttachmentChip(localId, descriptor);
    },
    [attachments, uploadAttachmentChip],
  );

  const handleRemoveAttachment = useCallback((localId: string) => {
    setContentFilterNotice(null);
    const target = attachmentsRef.current.find((attachment) => attachment.localId === localId);
    const next = attachmentsRef.current.filter((attachment) => attachment.localId !== localId);
    setAttachments(next);
    const scope = draftScopeRef.current;
    if (scope) {
      const recoverable = recoverableSharedAttachments(next);
      void (recoverable.length > 0
        ? saveRoomDraftSnapshot(scope, { text: draftTextRef.current, attachments: recoverable })
        : saveRoomDraft(scope, draftTextRef.current)
      ).catch(() => {});
    }
    if (target?.attachmentId && activeServer) {
      void getApiClient(activeServer.serverUrl).deleteMessageAttachment(target.attachmentId).catch(() => {
        setAttachPermissionNote("Could not remove the uploaded attachment. Try again.");
      });
    }
  }, [activeServer]);

  // ---- Send ----
  const handleSend = useCallback(
    async (text: string, resume?: AskUserResumeBody): Promise<boolean> => {
      if (!activeServer || !roomIdValid || !roomId) return false;
      if (resume && !canInvokeAgents) return false;
      const readyAttachments = attachments.filter((attachment) => attachment.status === "ready");
      if (!resume && MOBILE_CONTENT_FILTER_ENABLED && assessMobileHumanPosting({
        text,
        attachmentFilenames: readyAttachments.map((attachment) => attachment.name),
      }) === "blocked") {
        setContentFilterNotice(MOBILE_CONTENT_FILTER_NOTICE);
        return false;
      }
      if (!resume) setContentFilterNotice(null);
      const actionScope = currentCapabilityScope();
      setCapabilityError(null);
      const operation = roomOperationGuardRef.current.begin();
      if (!roomOperationGuardRef.current.acquireSend(operation)) return false;
      // Product policy locked by D528: an accepted deliberate local send
      // explicitly returns to newest. Remote run/message events never call it.
      requestLatestViewport("local-send", !resume);
      // Only ready attachments are sent; still-uploading ones are dropped
      // (the user can wait or remove them). v1 simplification: do not block
      // send on uploading chips.
      // New turn → clear any prior stop override so the stop button re-arms.
      if (!resume) setStopped(false);
      const projectedMentions = projectMobileHumanMentions(text, roomMembers);
      const clientId = `opt-${Date.now()}-${optimisticCounterRef.current++}`;
      const optimistic: ChatItem | null = resume ? null : (() => {
        const item = makeOptimisticUserItem(
          clientId,
          text,
          new Date().toISOString(),
          readyAttachments.flatMap((attachment) => attachment.uri ? [{ uri: attachment.uri }] : []),
          viewerUserIdRef.current ?? undefined,
        );
        if (replyTarget && item.kind === "message") {
          return { ...item, replyToMessageId: replyTarget.messageId };
        }
        return item;
      })();
      if (optimistic) setItems((prev) => [...prev, optimistic]);
      // Signal "just typed" to peers at send time (see emitTypingPing note).
      emitTypingPing();
      setSendingOperation(operation);
      try {
        // Ask-user is not a new Human message. Re-use only the persisted
        // content plus the server's exact resume correlation, deliberately
        // excluding current draft/model/attachment/reply state.
        const messageBody = resume ? { ...resume } : {
          content: projectedMentions.content,
          voiceMode: voiceEnabled,
          // Session-only client posture. The server independently permits it
          // only for a Human with current Agent-invocation authority.
          autoApprove: canInvokeAgents && autoApproveEnabled,
          ...(modelId ? { model: modelId } : {}),
          ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}),
          ...(readyAttachments.length > 0
            ? {
                attachments: readyAttachments.map((a) => ({
                  attachmentId: a.attachmentId!,
                })),
              }
            : {}),
          ...(artifactRefs.length > 0 ? { artifactRefs: [...artifactRefs] } : {}),
          ...(projectedMentions.mentionedHumanUserIds.length > 0
            ? { mentionedHumanUserIds: projectedMentions.mentionedHumanUserIds }
            : {}),
          ...(projectedMentions.mentionEveryone ? { mentionEveryone: true } : {}),
        };
        const boundMessageBody = withClientActionSession(messageBody);
        const messagePath = `/api/rooms/${encodeURIComponent(roomId)}/messages`;
        const mobileOriginProof = await prepareRemoteOrdinaryRequestProof({
          serverId: activeServer.id,
          method: "POST",
          path: messagePath,
          body: boundMessageBody,
        });
        const res = await getApiClient(activeServer.serverUrl).sendRoomMessage(
          roomId,
          boundMessageBody,
          mobileOriginProof ? { mobileOriginProof } : undefined,
        );
        if (!roomOperationGuardRef.current.isCurrent(operation)) return false;
        // The server does NOT echo our own message.new back (D124 B3), so
        // mark the optimistic item sent here. If the server returned a
        // messageId, update the id so future reloads dedupe cleanly.
        if (!resume) {
          setItems((prev) =>
            prev.map((it) => {
              if (it.kind !== "message" || it.clientId !== clientId) return it;
              const next = { ...it, status: "sent" as const };
              if (res.messageId != null) next.id = String(res.messageId);
              return next;
            }),
          );
          if (res.messageId != null) {
            const persistedId = String(res.messageId);
            // Own sends are not echoed over WS. Hydrate only this confirmed
            // row's edit identity; do not reload or move the transcript.
            void getApiClient(activeServer.serverUrl).getRoomMessagesAround({
              roomId, messageId: persistedId,
            }).then((page) => {
              if (!roomOperationGuardRef.current.isCurrent(operation)) return;
              const row = page.messages.find((message) => String(message.id) === persistedId);
              if (!row) return;
              const canonical = fromHistoryMessages([row], undefined, viewerActorIdRef.current)[0];
              if (canonical?.kind !== "message") return;
              setItems((current) => roomOperationGuardRef.current.isCurrent(operation)
                ? reconcilePersistedHumanMessage(current, canonical) : current);
            }).catch(() => {
              // Sending succeeded. A later history refresh can restore edit
              // metadata if this optional read fails; never mark the send failed.
            });
            askUserContentByMessageIdRef.current.set(persistedId, messageBody.content);
            const pending = askUserChoiceRef.current;
            if (pending && pending.messageId === persistedId) {
              const hydrated = { ...pending, originalContent: messageBody.content };
              askUserChoiceRef.current = hydrated;
              setAskUserChoice(hydrated);
            }
          }
          // Clear attachments + reply target on a successful ordinary send.
          setAttachments([]);
          setReplyTarget(null);
          const scope = draftScopeRef.current;
          if (scope) void saveRoomDraft(scope, "").catch(() => {});
          // Fence any slower recovery read for the just-sent draft.
          draftGenerationRef.current += 1;
          setDraftTextState("");
        }
        return true;
      } catch (caught) {
        if (!roomOperationGuardRef.current.isCurrent(operation)) return false;
        if (caught instanceof DirectHumanInteractionBlockedError) {
          setCapabilityError("Direct messaging is unavailable for this person.");
          void refreshDirectHumanBlockStatus();
        }
        const denial = await recoverMobileCapabilityDenial({
          error: caught,
          actionScope,
          getCurrentScope: currentCapabilityScope,
          refreshViewer,
        });
        if (!roomOperationGuardRef.current.isCurrent(operation)) return false;
        if (denial) setCapabilityError(denial.message);
        if (!resume) {
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "message" && it.clientId === clientId
                ? { ...it, status: "failed" as const }
                : it,
            ),
          );
        }
        return false;
      } finally {
        roomOperationGuardRef.current.releaseSend(operation);
        if (roomOperationGuardRef.current.isCurrent(operation)) setSendingOperation(null);
      }
    },
    [
      activeServer,
      roomId,
      roomIdValid,
      emitTypingPing,
      modelId,
      attachments,
      artifactRefs,
      voiceEnabled,
      autoApproveEnabled,
      canInvokeAgents,
      currentCapabilityScope,
      refreshViewer,
      replyTarget,
      roomMembers,
      refreshDirectHumanBlockStatus,
      requestLatestViewport,
      withClientActionSession,
    ],
  );

  // ---- Reactions (optimistic toggle + REST) ----
  const mutateReaction = useCallback(
    async (messageId: string, emoji: string, adding: boolean) => {
      if (!activeServer || !roomIdValid || !roomId || !viewerActorId) return;
      const actorId = viewerActorId;
      setItems((prev) => applyOptimisticReaction(prev, messageId, emoji, adding, actorId));
      try {
        const client = getApiClient(activeServer.serverUrl);
        const res = adding
          ? await client.addReaction(roomId, messageId, emoji)
          : await client.removeReaction(roomId, messageId, emoji);
        setItems((prev) =>
          reconcileMessageReactions(
            prev,
            messageId,
            res.reactions,
            viewerActorIdRef.current ?? actorId,
          ),
        );
      } catch {
        setItems((prev) =>
          applyOptimisticReaction(prev, messageId, emoji, !adding, actorId),
        );
      }
    },
    [activeServer, roomId, roomIdValid, viewerActorId],
  );

  const handleToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      const item = items.find(
        (it) => it.kind === "message" && String(it.id) === messageId,
      );
      const existing = item?.kind === "message" ? item.reactions : undefined;
      const mine = existing?.find((r) => r.emoji === emoji)?.mine === true;
      void mutateReaction(messageId, emoji, !mine);
    },
    [items, mutateReaction],
  );

  const handleReact = useCallback(
    (messageId: string, emoji: string) => {
      const item = items.find(
        (it) => it.kind === "message" && String(it.id) === messageId,
      );
      const existing = item?.kind === "message" ? item.reactions : undefined;
      const mine = existing?.find((r) => r.emoji === emoji)?.mine === true;
      if (mine) return;
      void mutateReaction(messageId, emoji, true);
    },
    [items, mutateReaction],
  );

  const canEditMessage = useCallback(
    (item: MessageItem): boolean => Boolean(activeServer && roomIdValid && roomId)
      && canEditMobileMessage(item, viewerUserId),
    [activeServer, roomId, roomIdValid, viewerUserId],
  );

  const handleEditMessage = useCallback(
    async (messageId: string, body: { content: string; expectedRevision: number }): Promise<void> => {
      const operation = roomOperationGuardRef.current.begin();
      const item = itemsRef.current.find((candidate): candidate is MessageItem =>
        candidate.kind === "message" && candidate.id === messageId);
      if (!activeServer || !roomId || !item || !canEditMessage(item)) {
        throw new Error("This message can no longer be edited.");
      }
      const api = getApiClient(activeServer.serverUrl);
      const { message } = await saveMobileMessageEdit({
        content: body.content,
        filterContent: MOBILE_CONTENT_FILTER_ENABLED,
        isCurrent: () => roomOperationGuardRef.current.isCurrent(operation),
        getPolicy: () => api.admin.encryptionTransition.getPolicy(),
        save: () => api.editRoomMessage(roomId, messageId, body),
      });
      if (!roomOperationGuardRef.current.isCurrent(operation)) return;
      setItems((current) => roomOperationGuardRef.current.isCurrent(operation)
        ? applyStreamEvent(current, {
          type: "message.updated", laneKey: `room:${roomId}`,
          logicalMessageKey: message.logicalMessageKey, content: message.content,
          editedAt: message.editedAt, editRevision: message.editRevision,
        }) : current);
    },
    [activeServer, canEditMessage, roomId],
  );

  const canDeleteMessage = useCallback(
    (item: MessageItem): boolean => {
      if (!roomIdValid || !roomId || item.clientId !== undefined || !/^\d+$/.test(item.id)) return false;
      const ownHuman =
        item.role === "user" &&
        (item.sourceUserId == null || (viewerUserId != null && item.sourceUserId === viewerUserId));
      return ownHuman || viewerCan(viewer, "manage_rooms");
    },
    [roomId, roomIdValid, viewer, viewerUserId],
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string): Promise<string | null> => {
      if (!activeServer || !roomIdValid || !roomId || !/^\d+$/.test(messageId)) {
        return "This message can no longer be deleted.";
      }
      const item = itemsRef.current.find(
        (candidate): candidate is MessageItem =>
          candidate.kind === "message" && candidate.id === messageId,
      );
      if (!item || !canDeleteMessage(item)) return "You no longer have permission to delete this message.";
      try {
        await getApiClient(activeServer.serverUrl).deleteRoomMessage(roomId, messageId);
        setItems((previous) => previous.filter(
          (candidate) => candidate.kind !== "message" || candidate.id !== messageId,
        ));
        return null;
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 401) return "Your session expired. Sign in again to delete messages.";
          if (error.status === 403) return "You no longer have permission to delete this message.";
          if (error.status === 404) {
            // Canonical absence is enough to converge and dismiss confirmation.
            setItems((previous) => previous.filter(
              (candidate) => candidate.kind !== "message" || candidate.id !== messageId,
            ));
            return null;
          }
          // The server preserves its special 409 for an anchor that has a child thread.
          if (error.status === 409) return "This message starts a thread and can’t be deleted.";
        }
        return "Could not delete this message. Try again.";
      }
    },
    [activeServer, canDeleteMessage, roomId, roomIdValid],
  );

  // ---- Push-to-talk voice input (Signal-style: hold → slide-cancel / release-send) ----
  const handleMicStart = useCallback(() => {
    void startRecording();
  }, [startRecording]);

  const handleMicRelease = useCallback(() => {
    void (async () => {
      const transcript = await stopAndTranscribe();
      if (transcript) void handleSend(transcript);
    })();
  }, [stopAndTranscribe, handleSend]);

  const handleMicCancel = useCallback(() => {
    void cancelRecording();
  }, [cancelRecording]);

  // ---- Stop ----
  // Best-effort: tell the server to abort the active turn + suppress queued
  // continuation. Errors are swallowed (the in-flight UI state will clear via
  // the streaming events' terminal signal anyway).
  const dismissStopNote = useCallback(() => {
    if (stopNoteTimerRef.current) clearTimeout(stopNoteTimerRef.current);
    setStopNoteVisible(false);
  }, []);

  const handleStop = useCallback(async () => {
    if (!activeServer || !roomIdValid || !roomId) return;
    // Optimistically settle the turn locally so `busy` → false immediately and
    // the stop button greys out (desktop parity); the server abort follows.
    setStopped(true);
    setStopNoteVisible(true);
    if (stopNoteTimerRef.current) clearTimeout(stopNoteTimerRef.current);
    stopNoteTimerRef.current = setTimeout(() => setStopNoteVisible(false), 2500);
    try {
      await getApiClient(activeServer.serverUrl).stopRoom(roomId);
    } catch {
      // best-effort
    }
  }, [activeServer, roomId, roomIdValid]);

  // Clean up the stop-note timer on unmount.
  useEffect(() => {
    return () => {
      if (stopNoteTimerRef.current) clearTimeout(stopNoteTimerRef.current);
    };
  }, []);

  // Busy = live server job OR send in flight OR a streaming assistant bubble
  // OR a running tool. The server lifecycle prevents an activity gap between
  // a settled bubble and the next tool/model event.
  // Drives the Composer's dedicated stop button (active vs greyed). A local
  // `stopped` override forces it false the moment the user stops, since a
  // stopped turn may never deliver the terminal event that clears the
  // `streaming:` bubble; reset when the next turn is sent.
  const busy = useMemo(
    () =>
      !stopped &&
      (liveJobIds.size > 0 ||
        sending ||
        items.some(
          (i) =>
            (i.kind === "message" && i.id.startsWith("streaming:")) ||
            (i.kind === "tool" && i.status === "running"),
        )),
    [stopped, liveJobIds, sending, items],
  );

  // Inverted FlatList: data[0] renders at the bottom. We keep `items`
  // ascending (oldest first) for the model + pagination, and reverse for
  // render so the newest is at the bottom (stick-to-bottom).
  const renderItems = useMemo(() => items.slice().reverse(), [items]);

  const groupedRoom = useMemo(() => isGroupRoom(roomMembers), [roomMembers]);

  const roomAgents = useMemo(
    () => roomMembers.filter((m) => m.kind === "agent"),
    [roomMembers],
  );
  // Match the desktop presence strip: while the agent is working in a quiet
  // gap (before text or between tool calls), identify who is responding. Once
  // visible assistant text is streaming, the bubble itself is the indicator.
  const workingAgentName = useMemo(() => {
    if (!busy) return null;
    const streamingAssistant = [...items].reverse().find(
      (
        item,
      ): item is Extract<ChatItem, { kind: "message" }> =>
        item.kind === "message" &&
        item.role === "assistant" &&
        item.id.startsWith("streaming:"),
    );
    if (streamingAssistant?.text.trim()) return null;
    const agent = streamingAssistant?.authorAgentId
      ? roomAgents.find((member) => member.agentId === streamingAssistant.authorAgentId)
      : roomAgents.length === 1
        ? roomAgents[0]
        : undefined;
    return agent?.displayName || "Assistant";
  }, [busy, items, roomAgents]);
  const agentIdToActorId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of roomAgents) {
      if (m.agentId) map.set(m.agentId, m.actorId);
    }
    return map;
  }, [roomAgents]);
  const authorLabels = useMemo(() => buildAuthorLabels(roomMembers), [roomMembers]);
  const messageGroupings = useMemo(
    () => computeMessageGroupings(items, viewerUserId),
    [items, viewerUserId],
  );

  const resolveSenderChrome = useCallback(
    (item: Extract<ChatItem, { kind: "message" }>) => {
      const grouping = messageGroupings.get(item.id);
      // Self is an ownership decision, not a group-run decision. Streaming
      // assistant rows never become outgoing merely because their grouping
      // metadata has not arrived yet.
      const isSelf =
        item.role === "user" &&
        (item.sourceUserId == null ||
          (viewerUserId != null && item.sourceUserId === viewerUserId));
      if (isSelf) {
        return {
          outgoing: true,
          grouped: false,
          senderName: undefined,
          showSenderName: false,
          showSenderAvatar: false,
          senderUserId: undefined,
          senderAgentId: undefined,
          senderAgentAvatar: undefined,
        };
      }

      // 1:1 stays avatar-free, with every non-self message incoming.
      if (!groupedRoom) {
        return {
          outgoing: false,
          grouped: false,
          senderName: undefined,
          showSenderName: false,
          showSenderAvatar: false,
          senderUserId: undefined,
          senderAgentId: undefined,
          senderAgentAvatar: undefined,
        };
      }

      // Group room rows always reserve incoming chrome. A temporarily missing
      // grouping entry is conservative: show the first-run chrome rather than
      // falling back to a 1:1-style row and making the gutter jump.
      const showSenderName = grouping?.showName ?? true;
      const showSenderAvatar = grouping?.showAvatar ?? true;

      if (item.role === "user") {
        const uid = item.sourceUserId;
        return {
          outgoing: false,
          grouped: true,
          senderName: uid ? (authorLabels.get(uid) ?? "Someone") : "Someone",
          showSenderName,
          showSenderAvatar,
          senderUserId: uid,
          senderAgentId: undefined,
          senderAgentAvatar: undefined,
        };
      }

      if (item.role === "assistant") {
        const author = resolveAgentAuthorLabel({
          authorAgentId: item.authorAgentId,
          members: roomMembers,
          viewerUserId,
          fallbackName: "Assistant",
          roomId: roomId ?? "",
        });
        const member = roomMembers.find(
          (m) => m.kind === "agent" && m.agentId === item.authorAgentId,
        );
        const displayName =
          author.ownerCue != null ? `${author.name} · ${author.ownerCue}` : author.name;
        return {
          outgoing: false,
          grouped: true,
          senderName: displayName,
          showSenderName,
          // Missing legacy agent ids have no trustworthy avatar route. Reserve
          // the incoming column, but do not render a generic avatar as though
          // it represented a real known agent.
          showSenderAvatar:
            showSenderAvatar && item.authorAgentId != null && member != null,
          senderUserId: undefined,
          senderAgentId: item.authorAgentId,
          senderAgentAvatar: member?.agentAvatar,
        };
      }

      return {
        outgoing: false,
        grouped: false,
        senderName: undefined,
        showSenderName: false,
        showSenderAvatar: false,
        senderUserId: undefined,
        senderAgentId: undefined,
        senderAgentAvatar: undefined,
      };
    },
    [groupedRoom, messageGroupings, authorLabels, roomMembers, viewerUserId, roomId],
  );

  const resolveMessageSenderName = useCallback(
    (item: MessageItem): string => {
      if (item.role === "user") {
        if (
          item.sourceUserId == null ||
          (viewerUserId != null && item.sourceUserId === viewerUserId)
        ) {
          return "You";
        }
        return authorLabels.get(item.sourceUserId) ?? "Someone";
      }
      if (item.role === "assistant") {
        const author = resolveAgentAuthorLabel({
          authorAgentId: item.authorAgentId,
          members: roomMembers,
          viewerUserId,
          fallbackName: "Assistant",
          roomId: roomId ?? "",
        });
        return author.ownerCue != null
          ? `${author.name} · ${author.ownerCue}`
          : author.name;
      }
      return "System";
    },
    [authorLabels, roomMembers, viewerUserId, roomId],
  );

  const resolveReplyQuote = useCallback(
    (
      replyToMessageId: number,
    ): { senderName: string; snippet: string } | null => {
      const original = items.find(
        (it): it is MessageItem =>
          it.kind === "message" && String(it.id) === String(replyToMessageId),
      );
      if (!original) {
        return { senderName: "Someone", snippet: "a message" };
      }
      return {
        senderName: resolveMessageSenderName(original),
        snippet: messageSnippet(original),
      };
    },
    [items, resolveMessageSenderName],
  );

  const handleReplyPress = useCallback(
    (messageId: string) => {
      const numericId = Number(messageId);
      if (!Number.isInteger(numericId) || numericId < 1) return;
      const item = items.find(
        (it): it is MessageItem =>
          it.kind === "message" && String(it.id) === messageId,
      );
      if (!item) return;
      setReplyTarget({
        messageId: numericId,
        senderName: resolveMessageSenderName(item),
        snippet: messageSnippet(item),
      });
    },
    [items, resolveMessageSenderName],
  );

  const handleReplyHeaderPress = useCallback(
    (replyToMessageId: number) => {
      const idx = renderItems.findIndex(
        (it) => it.kind === "message" && String(it.id) === String(replyToMessageId),
      );
      if (idx < 0) return;
      focusTranscriptTarget(String(replyToMessageId));
    },
    [focusTranscriptTarget, renderItems],
  );

  // D424 — agent avatar → focus is a full-screen-only room target (the
  // AgentFocusBar lives in the route). The route passes its `toggleFocus` to
  // the shared pane's `onAgentAvatarPress` so the message column can wire
  // onAvatarPress without the controller owning the focus provider.

  const dismissRoutingReceipt = useCallback(() => setRoutingReceipt(null), []);
  const dismissAskUserChoice = useCallback(() => {
    // Once a choice is being sent, closing the sheet would make a successful
    // request appear cancellable. Keep it visible until that request settles.
    if (askUserChoiceRef.current?.selectingActorId) return;
    askUserChoiceRef.current = null;
    setAskUserChoice(null);
  }, []);
  const selectAskUserCandidate = useCallback(async (botActorId: string): Promise<void> => {
    if (!canInvokeAgents) return;
    const choice = askUserChoiceRef.current;
    const scope = askUserScopeRef.current;
    if (
      !choice ||
      !scope ||
      !isCurrentAskUserScope(choice, scope) ||
      !choice.originalContent ||
      choice.selectingActorId !== null ||
      !choice.options.some((option) => option.botActorId === botActorId)
    ) return;
    const resume = buildAskUserResumeBody(choice, botActorId);
    if (!resume) return;
    const correlation = askUserCorrelationKey(choice);
    if (askUserResumeInFlightRef.current !== null) return;
    askUserResumeInFlightRef.current = correlation;
    const selecting = { ...choice, selectingActorId: botActorId, retryable: false };
    askUserChoiceRef.current = selecting;
    setAskUserChoice(selecting);
    const sent = await handleSend(choice.originalContent, resume);
    if (askUserResumeInFlightRef.current !== correlation) return;
    askUserResumeInFlightRef.current = null;
    const stillCurrent = askUserChoiceRef.current;
    if (!stillCurrent || askUserCorrelationKey(stillCurrent) !== correlation ||
      !isCurrentAskUserScope(stillCurrent, askUserScopeRef.current)) return;
    const settled = sent ? null : { ...stillCurrent, selectingActorId: null, retryable: true };
    askUserChoiceRef.current = settled;
    setAskUserChoice(settled);
  }, [canInvokeAgents, handleSend]);
  const cancelReply = useCallback(() => setReplyTarget(null), []);

  return {
    // identity + room
    roomId,
    roomIdValid,
    serverUrl: activeServer?.serverUrl,
    serverId: activeServer?.id,
    viewer,
    viewerState,
    viewerActorId,
    viewerUserId,
    roomLabel,
    roomType,
    applyCanonicalRoomDetail,
    roomMembers,
    roomMembersLoading,
    directHumanRoom,
    directAgentRoom,
    directHumanPeerUserId,
    directHumanBlockStatus,
    directHumanInteractionBlocked,
    blockedHumanUserIds,
    refreshDirectHumanBlockStatus,
    refreshBlockedHumanUserIds,
    handleBlockHuman,
    handleUnblockHuman,
    roomAgents,
    // transcript
    items,
    renderItems,
    loading,
    error,
    paging,
    pagingLoading,
    listRef,
    viewportScopeKey,
    latestViewportRequest,
    reportViewportReadState,
    keyExtractor: chatItemPresentationKey,
    loadInitial,
    loadOlder,
    transcriptWindow,
    scrollTarget,
    highlightedMessageId,
    targetNavigationError,
    activateMessageTarget,
    cancelMessageTargetNavigation,
    returnToLatest,
    releaseViewportAtLiveEdge,
    loadHistoricalOlderGap,
    reportTargetScrollFailure,
    // transcript render building blocks (consumed by RoomChatPane)
    groupedRoom,
    agentIdToActorId,
    resolveSenderChrome,
    resolveReplyQuote,
    handleToggleReaction,
    handleReact,
    canDeleteMessage,
    canEditMessage,
    handleEditMessage,
    handleDeleteMessage,
    handleReplyPress,
    handleReplyHeaderPress,
    // composer state
    draftText,
    setDraftText,
    discardDraft,
    sending,
    busy,
    typing,
    workingAgentName,
    routingReceipt,
    askUserChoice: canInvokeAgents ? askUserChoice : null,
    replyTarget,
    stopNoteVisible,
    dismissStopNote,
    dismissRoutingReceipt,
    dismissAskUserChoice,
    selectAskUserCandidate,
    cancelReply,
    capabilityError,
    contentFilterNotice,
    canInvokeAgents,
    canMentionEveryone,
    roomApproval,
    roomHostChoice,
    // model selection
    modelId,
    modelLabel,
    defaultModelLabel,
    models,
    handleModelSelect,
    // send / stop / mic
    handleSend,
    handleStop,
    handleMicStart,
    handleMicRelease,
    handleMicCancel,
    // voice playback
    voiceEnabled,
    toggleVoice: handleToggleVoice,
    stopVoice,
    speaking,
    // attachments
    attachments,
    attachPermissionNote,
    handleAttach,
    handleRetry,
    handleRemoveAttachment,
  };
}
