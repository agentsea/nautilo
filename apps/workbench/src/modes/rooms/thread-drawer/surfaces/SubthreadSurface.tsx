import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Search, SendHorizontal, Square, X } from "lucide-react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useComposer,
  useComposerRuntime,
  useExternalStoreRuntime,
  useThreadViewport,
  useThreadViewportStore,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  isMediaGenerationApproval,
  shouldAutoResolveAsk,
  type ApprovalReplyVerb,
  type RoomMemberDto,
} from "@nautilo/types";
import type {
  ApprovalAskControls,
  RoomReactionControls,
  ToolActivityEvent,
} from "../../../../adapters/runtime-contexts";
import {
  ApprovalAskContext,
  RoomReactionsContext,
  ToolActivityContext,
  useAutoApprove,
  useWsStateContext,
} from "../../../../adapters/runtime-contexts";
import { restoreSessionMessages } from "../../../../adapters/session-rehydrate";
import { ApprovalAskDock } from "../../../../components/approval-ask-dock";
import { ApprovalDialog } from "../../../../components/approval-dialog";
import {
  ConversationReplyProvider,
  ConversationTranscript,
  MessageAuthorProvider,
  type ConversationReplyContextValue,
} from "../../../../components/conversation";
import { RoomTranscriptFindBar } from "../../../../components/rooms/room-transcript-find-bar";
import type { TranscriptWindowHandle } from "../../../../components/transcript-window";
import type { PendingRoomReply } from "../../../../contexts/room-composer-draft-context";
import { apiClient } from "../../../../lib/api";
import { deriveBrowserCryptoDeviceId } from
  "@nautilo/lattice-bridge/client/browser";
import { readOrCreateBrowserCryptoInstallationId } from
  "../../../../lib/browser-crypto-installation";
import { currentClientActionSessionIdForResume } from
  "../../../../lib/client-action-session";
import {
  isWorkbenchSurfaceFocused,
  onDesktopWindowFocusChanged,
} from "../../../../lib/desktop";
import { useProfile } from "../../../../hooks/use-profile";
import { useAuth } from "../../../../hooks/use-auth";
import { useNotificationState } from "../../../../notifications/notification-state-context";
import {
  buildMemberByHandle,
  mentionAtHandleFormatter,
  MentionAwareLexicalComposerInput,
  RoomMentionTriggerPopover,
  useMentionAdapterForRoom,
} from "../../../../components/composer/MentionAdapter";
import { ComposerDirectiveChip } from "../../../../components/composer/ComposerDirectiveChip";
import { projectHumanMentionDirectives } from "../../../../components/composer/human-mention-directives";
import { PresenceTypingStrip } from "../../typing/PresenceTypingStrip";
import { useComposerTypingPing } from "../../typing/use-composer-typing-ping";
import { useTypingOthers } from "../../typing/use-typing-others";
import {
  memberKey,
  SelectablePicker,
  type SelectableCandidate,
} from "../../new-conversation/SelectablePicker";
import { buildAuthorLabels } from "../../shape/agent-author-label";
import { MemberFocusAvatar } from "../../shape/MemberFocusAvatar";
import type { RoomFocusState } from "../../shape/use-room-focus";
import { useRoomFocus } from "../../shape/use-room-focus";
import { shouldMarkRoomReadAtBottom } from "../../shape/read-tracking/mark-room-read-at-bottom";
import { DrawerShell } from "../components/DrawerShell";
import type { ThreadReactionOperation, ThreadToolActivity } from "../thread-room-controller";
import {
  parseSerializedToolArgsForDisplay,
  projectToolArgsForCardDisplay,
} from "../../../../components/tool-argument-preview";
import { useThreadRoomController, type ThreadRoomController } from "../use-thread-room-controller";
import {
  useThreadTranscriptFind,
  type ThreadTranscriptViewportApi,
} from "../use-thread-transcript-find";

export interface SubthreadSurfaceProps {
  subthreadRoomId: string;
  anchorMessageId: number;
  parentRoomId: string;
}

function SubthreadViewportBridge({
  apiRef,
  onAtBottomChange,
}: {
  apiRef: { current: ThreadTranscriptViewportApi | null };
  onAtBottomChange: (atBottom: boolean) => void;
}): null {
  const isAtBottom = useThreadViewport((viewport) => viewport.isAtBottom);
  const viewportStore = useThreadViewportStore();
  const api = useMemo<ThreadTranscriptViewportApi>(() => ({
    isAtBottom: () => viewportStore.getState().isAtBottom,
    scrollToBottom: (behavior = "auto") =>
      viewportStore.getState().scrollToBottom({ behavior }),
  }), [viewportStore]);

  useLayoutEffect(() => {
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [api, apiRef]);

  useLayoutEffect(() => onAtBottomChange(isAtBottom), [isAtBottom, onAtBottomChange]);
  return null;
}

function activityFor(tool: ThreadToolActivity): ToolActivityEvent {
  const endedAt = tool.duration === undefined ? undefined : Date.now();
  return {
    toolCallId: tool.toolCallId,
    toolName: tool.toolName,
    args: projectToolArgsForCardDisplay(parseSerializedToolArgsForDisplay(tool.argsSummary)),
    status: tool.status === "success" ? "ok" : tool.status,
    startedAt: endedAt === undefined ? Date.now() : endedAt - (tool.duration ?? 0),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(tool.result ? { result: tool.result } : {}),
    ...(tool.error ? { error: tool.error } : {}),
  };
}

function appendMessageText(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function reactionOperationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function isReactionTogglePending(
  operations: Readonly<Record<string, ThreadReactionOperation>>,
  roomId: string,
  messageId: number,
  emoji: string,
): boolean {
  return Object.values(operations).some((operation) =>
    operation.roomId === roomId &&
    operation.messageId === messageId &&
    operation.emoji === emoji,
  );
}

/**
 * The anchor is parent-room content rendered for context only. Namespace its
 * Assistant UI id so a parent/child numeric id collision cannot bind a child
 * control to the anchor; preserve the canonical parent id in metadata.
 */
export function buildSubthreadRuntimeMessages(
  parentRoomId: string,
  anchor: ThreadMessageLike | null,
  childMessages: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
  const namespacedAnchor = anchor === null ? [] : [{
    ...anchor,
    id: `thread-anchor:${parentRoomId}:${String(anchor.id)}`,
    metadata: {
      ...(anchor.metadata ?? {}),
      custom: {
        ...((anchor.metadata as { custom?: Record<string, unknown> } | undefined)?.custom ?? {}),
        parentAnchorMessageId: String(anchor.id),
        parentAnchorRoomId: parentRoomId,
      },
    },
  } as ThreadMessageLike];
  return [...namespacedAnchor, ...childMessages];
}

/**
 * The thread conch is deliberately ordered from requester-private focus state,
 * never from whichever Genie happened to speak most recently in this room.
 */
export function orderThreadGenies(
  members: readonly RoomMemberDto[],
  focus: RoomFocusState,
  recentBotActorIds: readonly string[] = [],
): RoomMemberDto[] {
  const recentIndex = new Map(recentBotActorIds.map((actorId, index) => [actorId, index]));
  return members
    .filter((member) => member.kind === "agent" && member.agentResponseMode !== "observe")
    .slice()
    .sort((left, right) => {
      const leftActive = focus.isTarget(left.actorId) ? 0 : 1;
      const rightActive = focus.isTarget(right.actorId) ? 0 : 1;
      if (leftActive !== rightActive) return leftActive - rightActive;

      const leftRecent = recentIndex.get(left.actorId) ?? Number.MAX_SAFE_INTEGER;
      const rightRecent = recentIndex.get(right.actorId) ?? Number.MAX_SAFE_INTEGER;
      if (leftRecent !== rightRecent) return leftRecent - rightRecent;

      // A stable fallback makes the whole roster usable when no private access
      // history is available yet (including after a new device signs in).
      const leftKey = `${left.displayName}\u0000${left.actorId}`;
      const rightKey = `${right.displayName}\u0000${right.actorId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function ThreadGenieConchStrip({
  roomId,
  members,
  focus,
  disabled,
}: {
  readonly roomId: string;
  readonly members: readonly RoomMemberDto[];
  readonly focus: RoomFocusState;
  readonly disabled: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const eligibleGenies = useMemo(
    () => orderThreadGenies(members, focus, focus.recentBotActorIds),
    [focus, members],
  );
  const searchEligibleGenies = useCallback((query: string): Promise<SelectableCandidate[]> => {
    const needle = query.trim().toLowerCase();
    return Promise.resolve(
      eligibleGenies
        .filter((member) => {
          if (!needle) return true;
          return `${member.displayName} ${member.handle ?? ""}`.toLowerCase().includes(needle);
        })
        .map((member) => ({
          kind: "agent" as const,
          // This picker normally works with agent ids. In this constrained
          // child-room focus surface the actionable identity is the member's
          // actor id, and its generic action-mode contract supports that.
          id: member.actorId,
          displayName: member.displayName,
          handle: member.handle ?? undefined,
        })),
    );
  }, [eligibleGenies]);
  const busyAgent = eligibleGenies.find((member) => focus.isBusy(member.actorId));

  return (
    <div
      aria-label="Thread Genie focus"
      data-testid="thread-genie-conch-strip"
      className="min-w-0 border-b border-border bg-background px-2 py-2"
    >
      {searchOpen ? (
        <div
          role="dialog"
          aria-label="Genie search popover"
          className="mb-2 max-h-64 w-full min-w-0 overflow-y-auto rounded-lg border border-border bg-background-panel p-2 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">Search Genies</span>
            <button
              type="button"
              aria-label="Close Genie search"
              onClick={() => setSearchOpen(false)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-foreground-muted hover:bg-muted hover:text-foreground"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </div>
          <SelectablePicker
            search={searchEligibleGenies}
            emptyLabel="No eligible Genies."
            busyKey={busyAgent ? memberKey("agent", busyAgent.actorId) : null}
            onPick={(candidate) => {
              focus.toggle(candidate.id);
              setSearchOpen(false);
            }}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2" data-testid="thread-genie-conch-row">
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-foreground-muted">
          Genies
        </span>
        <button
          type="button"
          aria-label="Search Genies"
          aria-expanded={searchOpen}
          onClick={() => setSearchOpen((open) => !open)}
          disabled={disabled}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <Search aria-hidden className="h-3.5 w-3.5" />
        </button>
        <div
          aria-label="Eligible Genies"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]"
        >
          {eligibleGenies.map((member) => (
            <MemberFocusAvatar
              key={member.actorId}
              member={member}
              focus={focus}
              roomId={roomId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadComposer({
  controller,
  members,
  focus,
  pendingReply,
  onCancelReply,
  onSentReply,
  onLocalSend,
}: {
  controller: ThreadRoomController;
  members: readonly RoomMemberDto[];
  focus: RoomFocusState;
  pendingReply: PendingRoomReply | null;
  onCancelReply: () => void;
  onSentReply: (reply: PendingRoomReply | null) => void;
  onLocalSend: () => void;
}) {
  const composer = useComposerRuntime();
  const composerText = useComposer((snapshot) => snapshot.text);
  const auth = useAuth();
  const viewerActorId = auth.viewer.sessionActorId ?? undefined;
  const composerRootRef = useRef<HTMLDivElement>(null);
  const mentionAdapter = useMentionAdapterForRoom(members, viewerActorId);
  const memberByHandle = useMemo(() => buildMemberByHandle(members), [members]);
  const { state } = controller;
  const hasChildWork = state.activeJobIds.length > 0 ||
    Object.values(state.streams).some((stream) => !stream.done);

  useComposerTypingPing({
    rootRef: composerRootRef,
    roomId: state.roomId,
    displayName: auth.viewer.label,
  });

  useEffect(() => {
    if (state.send.status === "error" && state.draft) composer.setText(state.draft);
  }, [composer, state.draft, state.send.status]);

  const send = useCallback(async () => {
    const projected = projectHumanMentionDirectives(composerText, members);
    const sent = await controller.sendText(
      projected.text,
      {
        ...(pendingReply
          ? { replyToMessageId: pendingReply.targetId }
          : {}),
        ...(projected.mentionedHumanUserIds.length > 0
          ? { mentionedHumanUserIds: projected.mentionedHumanUserIds }
          : {}),
        ...(projected.mentionEveryone ? { mentionEveryone: true } : {}),
      },
    );
    if (sent) {
      onLocalSend();
      void composer.reset();
      onSentReply(pendingReply);
    }
  }, [composer, composerText, controller, members, onLocalSend, onSentReply, pendingReply]);
  const sendDisabled = state.phase !== "ready" || !state.detail ||
    state.send.status === "sending" || composerText.trim().length === 0;

  return (
    <div data-testid="thread-composer" className="shrink-0 border-t border-border bg-background">
      <ThreadGenieConchStrip
        roomId={state.roomId ?? ""}
        members={members}
        focus={focus}
        disabled={state.phase !== "ready" || !state.detail}
      />
      <div ref={composerRootRef} className="p-2">
        <ComposerPrimitive.Unstable_TriggerPopoverRoot>
          <ComposerPrimitive.Root
            data-testid="thread-composer-surface"
            className="relative flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-background-element p-3"
          >
            <RoomMentionTriggerPopover adapter={mentionAdapter} memberByHandle={memberByHandle} />
            {pendingReply ? (
              <div
                data-testid="thread-composer-reply-preview"
                className="flex items-stretch gap-2 rounded-md border border-border bg-background px-2 py-1.5"
              >
                <span aria-hidden className="w-0.5 shrink-0 rounded-full bg-accent" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold text-accent">
                    Replying to {pendingReply.senderName}
                  </div>
                  <div className="truncate text-[11px] text-foreground-muted">
                    {pendingReply.snippet.length > 0 ? pendingReply.snippet : "(no text)"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onCancelReply}
                  aria-label="Cancel reply"
                  className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </div>
            ) : null}
            {state.send.error ? (
              <div role="alert" className="text-xs text-error">{state.send.error}</div>
            ) : null}
            <MentionAwareLexicalComposerInput
              aria-label="Thread reply"
              placeholder="Reply in thread..."
              data-nautilo-composer-input
              submitMode="none"
              cancelOnEscape
              directiveChip={ComposerDirectiveChip}
              formatter={mentionAtHandleFormatter}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (!sendDisabled) void send();
              }}
              className="relative max-h-48 min-h-[1.5rem] w-full overflow-y-auto bg-transparent text-sm leading-relaxed text-foreground outline-none [&_.aui-lexical-input]:min-h-[1.5rem] [&_.aui-lexical-input]:whitespace-pre-wrap [&_.aui-lexical-input]:break-words [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:text-foreground-disabled"
            />
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1" />
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled
                  aria-label="Attach files"
                  title="Attachments are not yet supported in threads"
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Paperclip aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
                </button>
                <button
                  type="button"
                  onClick={() => void controller.stop()}
                  disabled={!hasChildWork || state.stopping}
                  aria-label="Stop child reply"
                  title={state.stopping ? "Stopping child reply" : hasChildWork ? "Stop child reply" : "No active child reply"}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Square aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
                </button>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={sendDisabled}
                  aria-label="Send thread reply"
                  className="mb-0.5 shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <SendHorizontal className="h-4 w-4" aria-hidden />
                </button>
              </div>
            </div>
          </ComposerPrimitive.Root>
        </ComposerPrimitive.Unstable_TriggerPopoverRoot>
      </div>
    </div>
  );
}

export function resolveThreadPresenceAgentName({
  members,
  focus,
  streams,
  tools,
  fallbackName,
}: {
  readonly members: readonly RoomMemberDto[];
  readonly focus: RoomFocusState;
  readonly streams: ThreadRoomController["state"]["streams"];
  readonly tools: ThreadRoomController["state"]["tools"];
  readonly fallbackName: string;
}): string {
  const eligible = members.filter(
    (member) => member.kind === "agent" && member.agentResponseMode !== "observe",
  );
  const activeStreamAuthorId = Object.values(streams).find(
    (stream) => !stream.done && stream.authorAgentId,
  )?.authorAgentId;
  // `tool.start` intentionally retires the text stream to keep the transcript
  // compact. Its existing child-local author metadata carries identity through
  // that D313 quiet gap. Do not use completed tools: without a new lifecycle
  // correlation, an old author could be attributed to a later live job.
  const toolAuthorId = Object.values(tools).find(
    (tool) => tool.status === "running" && tool.authorAgentId,
  )?.authorAgentId;
  const activeAuthor = eligible.find(
    (member) => member.agentId === (activeStreamAuthorId ?? toolAuthorId),
  );
  const focused = eligible.find((member) => focus.isTarget(member.actorId));

  return activeAuthor?.displayName ?? focused?.displayName ??
    (eligible.length === 1 ? eligible[0]?.displayName : undefined) ?? fallbackName;
}

export function SubthreadSurface({ subthreadRoomId, parentRoomId, anchorMessageId }: SubthreadSurfaceProps) {
  const ws = useWsStateContext();
  const controller = useThreadRoomController({
    roomId: subthreadRoomId,
    parentRoomId,
    anchorMessageId,
    visible: true,
    connected: ws.state === "open",
  });
  const { agent, avatarSrc } = useProfile();
  const auth = useAuth();
  const foregroundCryptoBinding = useMemo(() => {
    if (
      typeof window === "undefined"
      || auth.viewer.sessionUserId === null
      || auth.viewer.sessionActorId === null
    ) return undefined;
    const installationId = readOrCreateBrowserCryptoInstallationId({
      serverScope: window.location.origin,
      userId: auth.viewer.sessionUserId,
      humanActorId: auth.viewer.sessionActorId,
    });
    if (installationId === null) return undefined;
    return {
      clientActionSessionId: currentClientActionSessionIdForResume(),
      authorizationDeviceId: deriveBrowserCryptoDeviceId({
        serverScope: window.location.origin,
        userId: auth.viewer.sessionUserId,
        humanActorId: auth.viewer.sessionActorId,
        installationId,
      }),
    };
  }, [auth.viewer.sessionActorId, auth.viewer.sessionUserId]);
  const notifications = useNotificationState();
  const autoApprove = useAutoApprove();
  const [members, setMembers] = useState<RoomMemberDto[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string>();
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const [proveItError, setProveItError] = useState<string>();
  const [proveItSubmitting, setProveItSubmitting] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportApiRef = useRef<ThreadTranscriptViewportApi | null>(null);
  const humanViewportGestureRef = useRef(false);
  const humanViewportGestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportTouchStartYRef = useRef<number | null>(null);
  const transcriptHandleRef = useRef<TranscriptWindowHandle>(null);
  const [pendingReply, setPendingReply] = useState<PendingRoomReply | null>(null);
  const { state } = controller;
  const markChildRead = controller.markRead;
  const childUnreadCount =
    notifications.subthreadsById.get(subthreadRoomId)?.unreadCount ?? 0;
  const lastReadAttemptRef = useRef<{
    roomId: string;
    unreadCount: number;
  } | null>(null);
  const failedReadAttemptRef = useRef<{
    roomId: string;
    unreadCount: number;
  } | null>(null);
  const childFollowIntentRef = useRef(false);
  const attemptChildRead = useCallback(() => {
    if (childUnreadCount <= 0) {
      lastReadAttemptRef.current = null;
      return;
    }
    const viewport = viewportRef.current;
    const attempt = {
      roomId: subthreadRoomId,
      unreadCount: childUnreadCount,
    };
    const previousAttempt = lastReadAttemptRef.current;
    if (
      previousAttempt?.roomId === attempt.roomId &&
      previousAttempt.unreadCount === attempt.unreadCount
    ) {
      return;
    }
    if (
      !childFollowIntentRef.current ||
      viewportApiRef.current?.isAtBottom() !== true ||
      !shouldMarkRoomReadAtBottom({
        roomId:
          state.phase === "ready" && state.roomId === subthreadRoomId
            ? state.roomId
            : null,
        verified: auth.viewer.isVerified,
        unreadCount: childUnreadCount,
        inFlight: state.read.status === "marking",
        viewport: viewport
          ? {
              scrollHeight: viewport.scrollHeight,
              scrollTop: viewport.scrollTop,
              clientHeight: viewport.clientHeight,
            }
          : null,
        documentVisible: document.visibilityState === "visible",
        documentFocused: isWorkbenchSurfaceFocused(),
        thresholdPx: 1,
      })
    ) {
      return;
    }
    lastReadAttemptRef.current = attempt;
    void markChildRead().then((success) => {
      const currentAttempt = lastReadAttemptRef.current;
      if (
        !success &&
        currentAttempt?.roomId === attempt.roomId &&
        currentAttempt.unreadCount === attempt.unreadCount
      ) {
        failedReadAttemptRef.current = attempt;
      }
    });
  }, [
    auth.viewer.isVerified,
    childUnreadCount,
    markChildRead,
    state.phase,
    state.read.status,
    state.roomId,
    subthreadRoomId,
  ]);
  const retryChildRead = useCallback(() => {
    const failedAttempt = failedReadAttemptRef.current;
    const lastAttempt = lastReadAttemptRef.current;
    if (
      failedAttempt?.roomId === lastAttempt?.roomId &&
      failedAttempt?.unreadCount === lastAttempt?.unreadCount
    ) {
      failedReadAttemptRef.current = null;
      lastReadAttemptRef.current = null;
    }
    attemptChildRead();
  }, [attemptChildRead]);
  const dispatchThreadAction = useCallback(
    (action: Parameters<ThreadRoomController["dispatch"]>[0]) => controller.dispatch(action),
    [controller],
  );
  const transcriptFind = useThreadTranscriptFind({
    roomId: subthreadRoomId,
    state,
    dispatch: dispatchThreadAction,
    viewportRef,
    transcriptHandleRef,
    viewportApiRef,
  });
  childFollowIntentRef.current = transcriptFind.followingLiveEdge;
  const onSubthreadViewportAtBottomChange = transcriptFind.onViewportAtBottomChange;
  const markHumanViewportGesture = useCallback(() => {
    humanViewportGestureRef.current = true;
    if (humanViewportGestureTimerRef.current) {
      clearTimeout(humanViewportGestureTimerRef.current);
    }
    humanViewportGestureTimerRef.current = setTimeout(() => {
      humanViewportGestureRef.current = false;
      humanViewportGestureTimerRef.current = null;
    }, 250);
  }, []);
  const handleSubthreadViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (viewport && humanViewportGestureRef.current) {
      onSubthreadViewportAtBottomChange(
        Math.abs(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight) <= 1,
        "human",
      );
    }
    retryChildRead();
  }, [onSubthreadViewportAtBottomChange, retryChildRead]);
  useEffect(() => () => {
    if (humanViewportGestureTimerRef.current) {
      clearTimeout(humanViewportGestureTimerRef.current);
    }
  }, []);
  const focus = useRoomFocus(subthreadRoomId);
  const typingOthers = useTypingOthers(subthreadRoomId);
  const autoApprovalAttemptedRef = useRef<string | null>(null);

  useEffect(() => {
    if (
      childUnreadCount <= 0 ||
      ws.state !== "open" ||
      state.phase !== "ready" ||
      state.roomId !== subthreadRoomId
    ) {
      lastReadAttemptRef.current = null;
      failedReadAttemptRef.current = null;
      return;
    }
    const frame = window.requestAnimationFrame(attemptChildRead);
    return () => window.cancelAnimationFrame(frame);
  }, [
    attemptChildRead,
    childUnreadCount,
    state.messages.length,
    state.phase,
    state.roomId,
    subthreadRoomId,
    transcriptFind.followingLiveEdge,
    ws.state,
  ]);

  useEffect(() => {
    const onActivation = (): void => {
      if (
        document.visibilityState === "visible" &&
        isWorkbenchSurfaceFocused()
      ) {
        retryChildRead();
      }
    };
    window.addEventListener("focus", onActivation);
    document.addEventListener("visibilitychange", onActivation);
    const unsubscribeDesktopFocus = onDesktopWindowFocusChanged((focused) => {
      if (focused) onActivation();
    });
    return () => {
      window.removeEventListener("focus", onActivation);
      document.removeEventListener("visibilitychange", onActivation);
      unsubscribeDesktopFocus();
    };
  }, [retryChildRead]);

  const beginReply = useCallback((reply: PendingRoomReply) => setPendingReply(reply), []);
  const cancelReply = useCallback(() => setPendingReply(null), []);
  const clearSentReply = useCallback((sentReply: PendingRoomReply | null) => {
    setPendingReply((current) => current === sentReply ? null : current);
  }, []);
  // A drawer switch must never carry a quote target across child Rooms.
  useEffect(() => {
    setPendingReply(null);
  }, [subthreadRoomId]);
  const replyContextValue = useMemo<ConversationReplyContextValue>(
    () => ({
      pendingReply,
      beginReply,
      cancelReply,
      jumpToMessage: transcriptFind.jumpToMessage,
      returnToLatest: transcriptFind.returnToLatest,
      awayFromLatest: transcriptFind.awayFromLatest,
      jumpState: transcriptFind.jumpState,
      highlightedMessageId: transcriptFind.highlightedMessageId,
    }),
    [beginReply, cancelReply, pendingReply, transcriptFind.awayFromLatest, transcriptFind.highlightedMessageId, transcriptFind.jumpState, transcriptFind.jumpToMessage, transcriptFind.returnToLatest],
  );

  useEffect(() => {
    let cancelled = false;
    void apiClient.getRoom(parentRoomId).then(
      (room) => {
        if (!cancelled) {
          setMembers(room.members);
          setRosterError(null);
        }
      },
      () => {
        if (!cancelled) setRosterError("Could not load thread participants.");
      },
    );
    return () => { cancelled = true; };
  }, [parentRoomId]);

  const submitApproval = useCallback(async (verb: ApprovalReplyVerb): Promise<void> => {
    const approval = state.approvals.approval;
    if (!approval || approvalSubmitting) return;
    const mediaGeneration = isMediaGenerationApproval(approval.mediaGeneration)
      ? approval.mediaGeneration
      : null;
    if (
      approval.requiresExplicitReview === true &&
      (!approval.approvalId ||
        (approval.localMcpInstall == null && mediaGeneration == null && approval.structuredSsh == null) ||
        (verb !== "once" && verb !== "deny"))
    ) {
      setApprovalError("This exact local review cannot be completed safely from this client.");
      return;
    }
    setApprovalSubmitting(true);
    setApprovalError(undefined);
    try {
      await apiClient.approvalReply(
        verb,
        approval.threadId,
        approval.laneKey,
        approval.approvalId,
        approval.localMcpInstall?.digest,
        mediaGeneration
          ? {
              digest: mediaGeneration.digest,
              quoteDigest: mediaGeneration.quoteDigest,
              revision: mediaGeneration.revision,
            }
          : undefined,
        foregroundCryptoBinding,
      );
      controller.dispatch({ type: "approval.localCleared", kind: "ask", approvalId: approval.approvalId });
    } catch (cause) {
      setApprovalError(cause instanceof Error ? cause.message : "Approval failed.");
    } finally {
      setApprovalSubmitting(false);
    }
  }, [approvalSubmitting, controller, foregroundCryptoBinding, state.approvals.approval]);

  const approval = state.approvals.approval;
  const shouldAutoApproveCurrentAsk =
    approval !== null &&
    approvalError === undefined &&
    shouldAutoResolveAsk({
      enabled: autoApprove.enabled,
      hasNetworkContext: approval.network != null,
      requiresExplicitReview: approval.requiresExplicitReview === true || approval.mediaGeneration !== undefined,
      structuredSshHostTrust: approval.structuredSsh?.hostTrust,
    });

  useEffect(() => {
    if (
      !approval ||
      !shouldAutoApproveCurrentAsk ||
      autoApprovalAttemptedRef.current === approval.approvalId
    ) {
      return;
    }
    autoApprovalAttemptedRef.current = approval.approvalId;
    void submitApproval("once");
  }, [approval, shouldAutoApproveCurrentAsk, submitApproval]);

  const approvalControls = useMemo<ApprovalAskControls>(() => {
    const hasMediaGenerationField = approval?.mediaGeneration !== undefined;
    const mediaGeneration = isMediaGenerationApproval(approval?.mediaGeneration)
      ? approval?.mediaGeneration ?? null
      : null;
    const requiresExactReview = approval?.requiresExplicitReview === true || hasMediaGenerationField;
    const canRenderExactReview = !requiresExactReview ||
      approval?.localMcpInstall != null || mediaGeneration != null || approval?.structuredSsh != null;
    return {
      state: {
        // Match the parent Room's no-flash contract: an eligible ask remains
        // hidden while the once-reply is in flight. A failed reply sets
        // approvalError, making the dock visible for a manual retry.
        show: approval !== null && !shouldAutoApproveCurrentAsk,
        approvalId: approval?.approvalId ?? null,
        tools: canRenderExactReview ? approval?.tools ?? [] : [],
        reason: canRenderExactReview
          ? approval?.reason ?? ""
          : "This exact approval needs review details, but they were unavailable. It cannot be approved from this client.",
        reasonCode: approval?.reasonCode ?? null,
        network: approval?.network ?? null,
        allowedVerbs: !canRenderExactReview
          ? []
          : requiresExactReview
            ? ["once", "deny"]
            : approval?.allowedVerbs.length
              ? approval.allowedVerbs
              : ["once", "room", "always", "deny"],
        scopeInfo: approval?.scopeInfo ?? [],
        localMcpInstall: approval?.localMcpInstall ?? null,
        mediaGeneration,
        structuredSsh: approval?.structuredSsh ?? null,
        requiresExplicitReview: requiresExactReview,
        error: approvalError ?? null,
        submitting: approvalSubmitting,
      },
      submit: submitApproval,
    };
  }, [
    approval,
    approvalError,
    approvalSubmitting,
    shouldAutoApproveCurrentAsk,
    submitApproval,
  ]);

  const submitProveIt = useCallback(async (pin: string): Promise<void> => {
    const challenge = state.approvals.proveIt;
    if (!challenge || proveItSubmitting) return;
    setProveItSubmitting(true);
    setProveItError(undefined);
    try {
      await apiClient.proveItAndResume(
        pin,
        challenge.threadId,
        challenge.laneKey,
        foregroundCryptoBinding,
      );
      controller.dispatch({ type: "approval.localCleared", kind: "proveIt" });
    } catch (cause) {
      setProveItError(cause instanceof Error ? cause.message : "Approval failed.");
    } finally {
      setProveItSubmitting(false);
    }
  }, [controller, foregroundCryptoBinding, proveItSubmitting, state.approvals.proveIt]);

  const denyProveIt = useCallback(async (): Promise<void> => {
    const challenge = state.approvals.proveIt;
    if (!challenge || proveItSubmitting) return;
    setProveItSubmitting(true);
    setProveItError(undefined);
    try {
      await apiClient.denyProveIt(
        challenge.threadId,
        challenge.laneKey,
        foregroundCryptoBinding,
      );
      controller.dispatch({ type: "approval.localCleared", kind: "proveIt" });
    } catch (cause) {
      setProveItError(cause instanceof Error ? cause.message : "Could not deny approval.");
    } finally {
      setProveItSubmitting(false);
    }
  }, [controller, foregroundCryptoBinding, proveItSubmitting, state.approvals.proveIt]);

  const anchorMessage = useMemo<ThreadMessageLike | null>(() =>
    state.anchor ? restoreSessionMessages([state.anchor])[0] ?? null : null, [state.anchor]);
  const childRuntimeMessages = useMemo(
    () => state.runtimeMessages.map((message) => {
      const metadata = (message.metadata ?? {}) as { custom?: Record<string, unknown> };
      return {
        ...message,
        metadata: {
          ...metadata,
          custom: { ...(metadata.custom ?? {}), subthreadReactionEligible: true },
        },
      } as ThreadMessageLike;
    }),
    [state.runtimeMessages],
  );
  const runtimeMessages = useMemo(
    () => buildSubthreadRuntimeMessages(parentRoomId, anchorMessage, childRuntimeMessages),
    [anchorMessage, childRuntimeMessages, parentRoomId],
  );
  const hasChildWork = state.activeJobIds.length > 0 ||
    Object.values(state.streams).some((stream) => !stream.done);
  const childAgentStreamingVisibleOutput = Object.values(state.streams).some(
    (stream) => !stream.done && stream.content.length > 0,
  );
  const agentPresent = members.some(
    (member) => member.kind === "agent" && member.agentResponseMode !== "observe",
  );
  const threadAgentName = resolveThreadPresenceAgentName({
    members,
    focus,
    streams: state.streams,
    tools: state.tools,
    fallbackName: agent?.name ?? "Genie",
  });
  const returnSubthreadToLatest = transcriptFind.returnToLatest;
  const onNew = useCallback(async (message: AppendMessage) => {
    const sent = await controller.sendText(appendMessageText(message));
    if (sent) returnSubthreadToLatest();
  }, [controller, returnSubthreadToLatest]);
  const toggleChildReaction = useCallback((messageId: number, emoji: string, currentlySelf: boolean) => {
    const targetRoomId = state.roomId;
    const actorId = auth.viewer.sessionActorId;
    if (!targetRoomId || targetRoomId !== subthreadRoomId || !actorId) return;
    // Serialize one emoji/message toggle. This avoids an older failed request
    // rolling back a newer already-settled intent while the server echoes are
    // still in flight.
    if (isReactionTogglePending(state.reactionOperations, targetRoomId, messageId, emoji)) return;
    const delta: 1 | -1 = currentlySelf ? -1 : 1;
    const operationId = reactionOperationId();
    controller.dispatch({ type: "reaction.optimistic", operationId, roomId: targetRoomId, messageId, emoji, delta, actorId });
    const request = currentlySelf
      ? apiClient.removeReaction(targetRoomId, String(messageId), emoji)
      : apiClient.addReaction(targetRoomId, String(messageId), emoji);
    void request.then(
      () => controller.dispatch({ type: "reaction.succeeded", roomId: targetRoomId, operationId }),
      () => {
      // The reducer's exact room gate makes a late failure from a closed or
      // switched drawer a no-op instead of corrupting a sibling transcript.
      controller.dispatch({
        type: "reaction.failed",
        roomId: targetRoomId,
        operationId,
      });
      },
    );
  }, [auth.viewer.sessionActorId, controller, state.reactionOperations, state.roomId, subthreadRoomId]);
  const childReactionControls = useMemo<RoomReactionControls>(() => ({
    toggleReaction: toggleChildReaction,
    viewerActorId: auth.viewer.sessionActorId,
  }), [auth.viewer.sessionActorId, toggleChildReaction]);
  const runtime = useExternalStoreRuntime({
    messages: runtimeMessages,
    setMessages: () => {},
    onNew,
    isRunning: hasChildWork,
    isSendDisabled: state.phase !== "ready" || !state.detail || state.send.status === "sending",
    convertMessage: (message) => message,
  });

  const labels = useMemo(() => buildAuthorLabels(members), [members]);
  const toolActivity = useMemo(
    () => Object.values(state.tools).map(activityFor),
    [state.tools],
  );
  const title = state.anchor
    ? `Thread: ${state.anchor.content.substring(0, 40) || "Message"}`
    : "Thread";
  return (
    <DrawerShell
      title={title}
      actions={(
        <button
          type="button"
          aria-label="Search thread transcript"
          aria-expanded={transcriptFind.open}
          title="Search thread transcript"
          className="shrink-0 rounded p-1 text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
          onClick={(event) => transcriptFind.openFind(event.currentTarget)}
        >
          <Search aria-hidden className="h-4 w-4" />
        </button>
      )}
    >
      {state.phase === "hydrating" || state.phase === "closed" ? (
        <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">Loading thread...</div>
      ) : (
        <MessageAuthorProvider labels={labels} members={members}>
          <ToolActivityContext.Provider value={toolActivity}>
            <ApprovalAskContext.Provider value={approvalControls}>
              <RoomReactionsContext.Provider value={childReactionControls}>
              <AssistantRuntimeProvider runtime={runtime}>
                <ConversationReplyProvider value={replyContextValue}>
                <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
                  <RoomTranscriptFindBar
                    search={transcriptFind.search}
                    open={transcriptFind.open}
                    compact
                    onClose={transcriptFind.closeFind}
                    selectedHitIndex={transcriptFind.selection?.indexInPage}
                    ordinal={transcriptFind.selection?.ordinal}
                    totalLabel={transcriptFind.totalLabel}
                    onPrevious={() => { void transcriptFind.move("newer"); }}
                    onNext={() => { void transcriptFind.move("older"); }}
                    previousDisabled={!transcriptFind.selection}
                    nextDisabled={!transcriptFind.selection}
                    boundaryMessage={transcriptFind.boundaryMessage}
                    activationState={transcriptFind.activationState}
                    onRetryActivation={transcriptFind.retryActivation}
                    showReturnToLatest={transcriptFind.awayFromLatest}
                    onReturnToLatest={transcriptFind.returnToLatest}
                    highlightedMessageId={transcriptFind.highlightedMessageId}
                  />
                  {state.error || rosterError ? (
                    <div role="alert" className="shrink-0 border-b border-border px-3 py-2 text-xs text-error">
                      {state.error ?? rosterError}
                    </div>
                  ) : null}
                  <div className="relative flex min-h-0 min-w-0 flex-1">
                  <ThreadPrimitive.Viewport
                    key={subthreadRoomId}
                    ref={viewportRef}
                    autoScroll={transcriptFind.followingLiveEdge}
                    scrollToBottomOnRunStart={false}
                    scrollToBottomOnInitialize
                    scrollToBottomOnThreadSwitch={false}
                    onScroll={handleSubthreadViewportScroll}
                    onPointerDown={(event) => {
                      if (event.target === event.currentTarget) markHumanViewportGesture();
                    }}
                    onTouchStart={(event) => {
                      viewportTouchStartYRef.current = event.touches[0]?.clientY ?? null;
                    }}
                    onTouchMove={(event) => {
                      const startY = viewportTouchStartYRef.current;
                      const currentY = event.touches[0]?.clientY;
                      if (startY != null && currentY != null && Math.abs(currentY - startY) >= 4) {
                        markHumanViewportGesture();
                      }
                    }}
                    onWheel={markHumanViewportGesture}
                    onKeyDown={(event) => {
                      if (
                        event.target === event.currentTarget &&
                        ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)
                      ) {
                        markHumanViewportGesture();
                      }
                    }}
                    data-testid="thread-transcript-scroll"
                    className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto px-2 py-3 [&>*]:min-w-0 [&>*]:max-w-full"
                  >
                    <SubthreadViewportBridge
                      apiRef={viewportApiRef}
                      onAtBottomChange={transcriptFind.onViewportAtBottomChange}
                    />
                    <ConversationTranscript
                      assistantName={agent?.name ?? "Genie"}
                      assistantAvatarSrc={avatarSrc}
                      roomId={subthreadRoomId}
                      followIntent={transcriptFind.followingLiveEdge}
                      viewportRef={viewportRef}
                      handleRef={transcriptHandleRef}
                      searchHighlight={{
                        messageId: transcriptFind.selection ? Number(transcriptFind.selection.messageId) : null,
                        query: transcriptFind.search.query,
                        mode: transcriptFind.search.mode,
                        ignoreCase: transcriptFind.search.ignoreCase,
                      }}
                      interactiveMessages={false}
                      reactionMessages
                      childMessageDeleteEnabled
                      childMessageEditEnabled
                      childMessageReplyEnabled
                    />
                  </ThreadPrimitive.Viewport>
                  {!transcriptFind.open && transcriptFind.awayFromLatest ? (
                    <button
                      type="button"
                      data-testid="subthread-return-to-latest"
                      className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-background-panel px-3 py-1.5 text-xs font-medium text-foreground shadow-lg hover:bg-background-element"
                      aria-label="Return to latest thread messages"
                      onClick={transcriptFind.returnToLatest}
                    >
                      {childUnreadCount > 0
                        ? "New messages · Return to latest"
                        : "Return to latest"}
                    </button>
                  ) : null}
                  </div>
                  <ApprovalAskDock />
                  {state.approvals.proveIt ? (
                    <ApprovalDialog
                      tools={state.approvals.proveIt.tools}
                      onSubmit={(pin) => { void submitProveIt(pin); }}
                      onDeny={() => { void denyProveIt(); }}
                      error={proveItError}
                    />
                  ) : null}
                  <PresenceTypingStrip
                    assistantName={threadAgentName}
                    others={typingOthers}
                    agentPresent={agentPresent}
                    agentRunning={hasChildWork}
                    agentStreamingVisibleOutput={childAgentStreamingVisibleOutput}
                  />
                  <ThreadComposer
                    controller={controller}
                    members={members}
                    focus={focus}
                    pendingReply={pendingReply}
                    onCancelReply={cancelReply}
                    onSentReply={clearSentReply}
                    onLocalSend={transcriptFind.returnToLatest}
                  />
                </ThreadPrimitive.Root>
                </ConversationReplyProvider>
              </AssistantRuntimeProvider>
              </RoomReactionsContext.Provider>
            </ApprovalAskContext.Provider>
          </ToolActivityContext.Provider>
        </MessageAuthorProvider>
      )}
    </DrawerShell>
  );
}
