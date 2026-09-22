import { MessageTimestamp, messageDayStarts, validMessageSentAt } from "./message-timestamp";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ComponentProps,
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
  forwardRef,
} from "react";
import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useMessage,
  useComposer,
  useComposerRuntime,
  useThread,
  useAuiState,
  useThreadViewport,
  useThreadViewportStore,
} from "@assistant-ui/react";
import type { Unstable_TriggerItem } from "@assistant-ui/core";
import { useConversationLiveEdgeRecovery } from "../hooks/use-conversation-live-edge-recovery";
import { MessageEditConflictError } from "@nautilo/api-client/browser";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, Mic, Paperclip, SendHorizontal, Loader2, Square, X } from "lucide-react";
import { HumanMessageContent } from "./human-message-content";
import {
  TerminalExecutionNotices,
  terminalExecutionsFromMessageMetadata,
} from "./terminal-execution-notice";
import {
  createBrowserPageDraftDispatcher,
  type GenieHandoffBridge,
} from "../lib/genie-handoff";
import { setHasUnsentComposerText } from "../adapters/upgrade-reload-guard";
import { useSpeechRecognition } from "../hooks/use-speech-recognition";
import { applyComposerPostSubmit } from "./composer-post-submit";
import { useProfile } from "../hooks/use-profile";
import { AuthenticatedAvatar } from "./avatar/authenticated-image";
import {
  getMessageActionDescriptors,
  SHELL_AGENT_NAME,
  type MessageActionDescriptor,
  type ChatFocusedResourceRef,
} from "@nautilo/types";
import { useWsState } from "../hooks/use-ws-state";
import { MENU_SPEAK_EVENT } from "../hooks/use-desktop-menu";
import {
  useRoomHistoryControls,
  useRoomInitialHistory,
  useRoomMessageSearch,
  useRuntimeShellState,
  useAutoApprove,
  useVoiceControls,
  useRoomReactions,
  useRoomMessageEdit,
} from "../adapters/runtime-contexts";
import { RoomInitialHistorySurface } from "./room-initial-history-surface";
import type {
  RoomInitialHydrationScope,
  RoomInitialHydrationState,
} from "../adapters/room-initial-hydration";
import { ApprovalAskDock } from "./approval-ask-dock";
import { CodexRequestDock } from "./codex-request-dock";
import { AutoApproveBar } from "./auto-approve-bar";
import { TerminalControlRequestDock } from "./terminal-control-request-dock";
import { FullAuthoredContextNotice } from "./full-authored-context-notice";
import { useTerminalControlRequest } from "./terminal-control-request-context";
import { ToolCard } from "./tool-card/tool-card";
import { harnessTaskToolRenderers } from "../modes/rooms/subagents/HarnessTaskToolCard";
import {
  TranscriptWindow,
  scheduleFrameWithFallback,
  type TranscriptWindowHandle,
} from "./transcript-window";
import {
  createConversationNavigationController,
  returnConversationToLatest,
  waitForConversationCommit,
  waitForConversationTarget,
  type ConversationJumpOutcome,
  type ConversationJumpState,
} from "./conversation-navigation";
import {
  conversationViewportScopeKey,
  createConversationTranscriptHydrationCoordinator,
  freezeConversationViewportForRoomSwitch,
  isConversationViewportAway,
  isConversationViewportAtPhysicalLiveEdge,
  isConversationTranscriptReadyForRestore,
  isConversationViewportReadyForRead,
  isConversationViewportScopeReady,
  isConversationViewportFollowing,
  isConversationViewportOperationCurrent,
  materializeFirstConversationAnchor,
  scheduleConversationLiveTailScroll,
  selectFirstSurvivingConversationAnchor,
  selectVisibleConversationAnchors,
  shouldScheduleConversationLiveTailScroll,
  shouldConversationTranscriptFollowTail,
  shouldAutoLoadOlderConversationHistory,
  storeConversationSnapshotForReadyScope,
  transitionConversationViewport,
  type ConversationAnchorCandidate,
  type ConversationViewportMode,
} from "./conversation-viewport";
import { deriveTranscriptSync } from "./conversation-transcript-sync";
import { ReactionStrip } from "../modes/rooms/shape/reactions/ReactionStrip";
import { useMessageReactions } from "../modes/rooms/shape/reactions/use-message-reactions";
import { MessageActionRail } from "./message-actions/MessageActionRail";
import { buildMessageActions } from "./message-actions/message-actions";
import {
  inlineEditKeyAction,
  remoteEditResolution,
} from "./message-edit-policy";
import { useOpenThread } from "../modes/rooms/thread-drawer/use-open-thread";
import {
  buildAuthorLabels,
  resolveAssistantAuthorLabel,
  resolveRoomAgentChromeLabel,
} from "../modes/rooms/shape/agent-author-label";
import { useRoomMembers as useRoomMembersData } from "../modes/rooms/shape/use-room-members";
import { resolveDirectHumanRoom } from "../modes/rooms/shape/direct-human-room";
import { isEmojiOnlyMessage } from "../lib/emoji-only";
import { PresenceTypingStrip } from "../modes/rooms/typing/PresenceTypingStrip";
import { useComposerTypingPing } from "../modes/rooms/typing/use-composer-typing-ping";
import { useTypingOthers } from "../modes/rooms/typing/use-typing-others";
import { ComposerEmojiButton } from "./composer/ComposerEmojiButton";
import { useRoomFocusContext } from "../modes/rooms/shape/room-focus-context";
import { FocusCountdownRing } from "../modes/rooms/shape/FocusCountdownRing";
import { focusTooltipLabel } from "../modes/rooms/shape/focus-reason";
import {
  NAUTILO_ARTIFACT_REF_MIME,
  NAUTILO_FILE_REF_MIME,
  classifyComposerDrop,
  flattenNautiloFileRefs,
  localFileFocusedResourceLabel,
} from "../lib/composer-paste-file";
import {
  formatComposerAttachmentSkipToast,
  preflightComposerChatAttachment,
  type ComposerChatAttachmentSkip,
} from "../lib/composer-attachment-preflight";
import { useToast } from "./toast";
import { AssistantMarkdownTextPrimitive } from "./assistant-markdown-text";
import {
  desktopAPI,
  getDesktopRelayId,
  isDesktop,
  isWorkbenchSurfaceFocused,
  onDesktopWindowFocusChanged,
} from "../lib/desktop";
import { uploadComposerAttachment, uploadComposerBlob } from "../lib/composer-upload";
import { stripAssistantArtifacts } from "../lib/strip-assistant-artifacts";
import { extractFullMessageText } from "../lib/message-copy-text";
import { copyTextToClipboard } from "../lib/copy-to-clipboard";
import {
  pickComposerDisabledTitle,
  pickConversationEmptyCopy,
} from "../lib/conversation-shell-copy";
import {
  decodeKnownFileHref,
  linkKnownFileMentions,
  getKnownFileRef,
  useKnownFileRefs,
} from "../lib/known-file-links";
import { shouldSmoothAssistantMarkdown } from "../lib/assistant-markdown-smooth";
import { requestOpenFile } from "../adapters/open-file-ref";
import { openTargetForKnownRef } from "./browser-column/open-file-target";
import {
  artifactOpenRefsFromMessageMetadata,
  MessageArtifactOpenCards,
} from "./artifact-open-card";
import { useKnownArtifacts } from "../lib/use-known-artifacts";
import { useWorkspaceArtifacts } from "../artifacts/workspace-artifacts-provider";
import {
  readerFocusedResourcesForSend,
  type ReaderFocusedResourceTarget,
} from "./conversation/reader-focused-resource";
import {
  addAttachment,
  getAttachmentsSnapshot,
  newAttachmentId,
  removeAttachment,
  subscribeAttachments,
  type ComposerAttachment,
} from "../adapters/composer-attachments-ref";
import {
  addFocusedResource,
  getFocusedResources,
  getFocusedResourcesSnapshot,
  hasFocusedResource,
  removeFocusedResource,
  restoreFocusedResources,
  subscribeFocusedResources,
} from "../adapters/composer-focused-resources-ref";
import { relativeFromWorkspace } from "./browser-column/cited-paths";
import { useRoomNavigation } from "../contexts/room-navigation-context";
import { useNotificationState } from "../notifications/notification-state-context";
import {
  type PendingRoomReply,
  useRoomComposerDraftStore,
  useRoomComposerSendPending,
  useRoomPendingReply,
} from "../contexts/room-composer-draft-context";
import { useAuth } from "../hooks/use-auth";
import { isAuthenticatedHumanViewer } from "../hooks/viewer-authentication";
import { useCan } from "../hooks/use-can";
import { apiClient } from "../lib/api";
import { shouldMarkRoomReadAtBottom } from "../modes/rooms/shape/read-tracking/mark-room-read-at-bottom";
import { useLocation, useNavigate } from "react-router-dom";
import { createRoomMessageRouteIntentConsumer } from "../routes/room-route";
import { RoomTabStrip } from "./rooms/room-tab-strip";
import { RoomsPanel } from "./rooms/rooms-panel";
import { RoomTranscriptFindBar } from "./rooms/room-transcript-find-bar";
import {
  captureRoomFindFocusRestoreTarget,
  moveRoomFindSelection,
  reconcileRoomFindSelection,
  roomFindTotalLabel,
  shouldOwnRoomFindShortcut,
  type FindDirection,
  type RoomFindSelection,
} from "./rooms/room-transcript-find-navigation";
import {
  createRoomFindActivationController,
  type RoomFindActivationState,
} from "./rooms/room-transcript-find-activation";
import { ParentMessageReplyAffordance } from "../modes/rooms/thread-drawer/components/ParentMessageReplyAffordance";
import { ThreadContextMenu } from "../modes/rooms/thread-drawer/components/ThreadContextMenu";
import {
  defaultNewChatLabel,
  moveRoomIdBeforeTarget,
  pickNeighborTabId,
  selectRoomsForTabStrip,
} from "../rooms/room-tab-strip-model";
import { chatPanelUsesCompactRoomChrome } from "../rooms/chat-panel-density";
import { UserAvatar } from "./avatar/UserAvatar";
import {
  buildMemberByHandle,
  mentionAtHandleFormatter,
  MentionAwareLexicalComposerInput,
  RoomMentionTriggerPopover,
  useMentionAdapterForRoom,
} from "./composer/MentionAdapter";
import { commandSlashFormatter, useCommandAdapter } from "./composer/CommandAdapter";
import { ComposerDirectiveChip } from "./composer/ComposerDirectiveChip";
import { buildLastSpokeAtMsFromThread } from "./composer/mention-recency";
import { AskUserPicker } from "./composer/AskUserPicker";
import { ModelSwitcher } from "./composer/ModelSwitcher";
import { resolveRoomModelAgentTarget } from "./composer/room-model-agent-target";
import { hasStoppableRoomTask } from "./composer/composer-stop-state";
import { ComposerSendButton } from "./composer/ComposerSendButton";
import {
  ownsSubmittedComposerPresentation,
  sendIfComposerPresentationCurrent,
} from "./composer/composer-send-ownership";
import { useTaskState } from "../contexts/task-state/task-state-context";
import {
  clearAskUserPicker,
  findMessageContentById,
  setAskUserPendingContent,
  useAskUserPicker,
} from "./composer/ask-user-state";
import { resumeAskUserPick } from "./composer/ask-user-resume";
import "./composer/ask-user-bus";
import { VoicePlaybackStopPill } from "./conversation/VoicePlaybackStopPill";
import {
  demoteUnknownResourceDirectives,
  projectResourceDirectives,
  resourceEntryIdsInText,
  serializeResourceDirective,
} from "./composer/resource-directives";
import {
  humanMentionDirectivesToPlainText,
  projectHumanMentionDirectives,
} from "./composer/human-mention-directives";
import {
  currentComposerSelectionOffset,
  insertDroppedResourceDirective,
} from "./composer/composer-resource-drop";

export type ConversationChromeDensity = "default" | "readerRail";

export interface ConversationProps {
  /**
   * D110 — `readerRail` enables narrow-rail compact room chrome + padding only in
   * the document-reading chat sidecar. Default center chat is unchanged.
   */
  chromeDensity?: ConversationChromeDensity;
  /**
   * Only the Workbench reader rail receives this shell-owned registrar. Other
   * Conversation mounts never become a browser handoff destination.
   */
  registerSendToGenieDraftDispatcher?: GenieHandoffBridge["registerBrowserPageDraftDispatcher"];
  /** Exact workspace artifact or local file visibly owning the Reader chat rail. */
  readerFocusedResourceTarget?: ReaderFocusedResourceTarget;
}

/**
 * D193 follow-up (Smoke-3) + D210 — per-room context that carries:
 *
 *   1. `labels` — map of `userId → displayName` for multi-author message
 *      rendering (D205). Returning `null` from the hook means "viewer is
 *      the author or label unknown" → fall back to "You:".
 *   2. `members` — full room member list, used by D210's `@`-mention
 *      picker in the composer. Optional so existing consumers
 *      (`Conversation` rendered outside a shape parent) keep working.
 *
 * The shape parent (`SlackShapeRoom`) and the reader-rail mount
 * (`workbench-shell`) both wrap `<Conversation />` in `MessageAuthorProvider`
 * via the shared `RoomAuthorScope`. D352 also adds a self-source fallback
 * (`SelfSourcedAuthorScope`) so a `Conversation` mounted with NO provider above
 * it still resolves the active room's roster itself rather than going inert.
 */
import type { RoomMemberDto } from "@nautilo/types";

type AuthorContextValue = {
  labels: ReadonlyMap<string, string>;
  members: readonly RoomMemberDto[];
};

const AuthorContext = createContext<AuthorContextValue | null>(null);

export function MessageAuthorProvider({
  labels,
  members,
  children,
}: {
  labels: ReadonlyMap<string, string>;
  /** D210 — full room roster for the composer's @-mention picker. */
  members?: readonly RoomMemberDto[];
  children: ReactNode;
}) {
  const value = useMemo<AuthorContextValue>(
    () => ({ labels, members: members ?? [] }),
    [labels, members],
  );
  return <AuthorContext.Provider value={value}>{children}</AuthorContext.Provider>;
}

function useAuthorLabel(sourceUserId: string | undefined): string | null {
  const ctx = useContext(AuthorContext);
  const auth = useAuth();
  if (!sourceUserId) return null;
  if (sourceUserId === auth.viewer.sessionUserId) return null;
  if (!ctx) return null;
  return ctx.labels.get(sourceUserId) ?? null;
}

/** D210 — used by the composer's mention picker. */
function useRoomMembers(): readonly RoomMemberDto[] {
  const ctx = useContext(AuthorContext);
  return ctx?.members ?? [];
}

/**
 * D352 (B) — self-healing author scope. When `Conversation` is mounted WITHOUT
 * a `MessageAuthorProvider` above it (any future bare mount), it sources the
 * active room's roster itself — cached + deduped by `use-room-members`, so no
 * extra round-trip — and provides the same author context the center path gets
 * via `RoomAuthorScope`. When a provider IS present (center chat + the D352
 * reader-rail wrap), this is never rendered and the existing context wins.
 */
function SelfSourcedAuthorScope({ children }: { children: ReactNode }) {
  const roomNav = useRoomNavigation();
  const { members } = useRoomMembersData(roomNav.activeRoomId);
  const labels = useMemo(() => buildAuthorLabels(members), [members]);
  return (
    <MessageAuthorProvider labels={labels} members={members}>
      {children}
    </MessageAuthorProvider>
  );
}

/**
 * D359 (Stack 126, Phase 2) — Telegram-shape inline quote-reply state, shared
 * between the per-message Reply affordance (sets a pending reply) and the
 * Composer (renders the reply-preview bar + forwards `replyToMessageId` on
 * send). `jumpToMessage` scrolls the quoted parent into view and briefly
 * highlights it. Provided by `ConversationBody`; consumed by `Message`,
 * `Composer`, and `QuotedReplyStrip`.
 */
type PendingReply = PendingRoomReply;

export type ConversationReplyContextValue = {
  pendingReply: PendingReply | null;
  beginReply: (reply: PendingReply) => void;
  cancelReply: () => void;
  /** Canonical loaded/unloaded navigation seam, also consumed by Room search. */
  jumpToMessage: (messageId: number) => Promise<ConversationJumpOutcome>;
  returnToLatest: () => void;
  awayFromLatest: boolean;
  jumpState: ConversationJumpState;
  highlightedMessageId: number | null;
};

const ConversationReplyContext = createContext<ConversationReplyContextValue | null>(null);

interface ConversationViewportApi {
  isAtBottom: () => boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

interface ConversationScrollSnapshot {
  scrollTop: number;
  anchors: readonly ConversationAnchorCandidate[];
}

interface ConversationViewportVisit {
  scopeKey: string;
  visitId: number;
}

function captureConversationScrollSnapshot(
  viewport: HTMLElement,
): ConversationScrollSnapshot {
  const viewportRect = viewport.getBoundingClientRect();
  const anchors = selectVisibleConversationAnchors({
    viewportTop: viewportRect.top,
    viewportBottom: viewportRect.bottom,
    messages: Array.from(
    viewport.querySelectorAll<HTMLElement>('[data-transcript-row="true"] [data-message-id]'),
    ).map((message) => {
      const rect = message.getBoundingClientRect();
      return {
        messageId: message.dataset.messageId ?? "",
        top: rect.top,
        bottom: rect.bottom,
      };
    }).filter((message) => message.messageId.length > 0),
  });
  return {
    scrollTop: viewport.scrollTop,
    anchors,
  };
}

/**
 * Projects assistant-ui's viewport store into Nautilo chrome without creating
 * another scroll authority. Every automatic or explicit tail request still
 * enters through the store's supported `scrollToBottom` seam.
 */
function ConversationViewportBridge({
  apiRef,
  onAtBottomChange,
}: {
  apiRef: { current: ConversationViewportApi | null };
  onAtBottomChange: (atBottom: boolean) => void;
}): null {
  const isAtBottom = useThreadViewport((state) => state.isAtBottom);
  const viewportStore = useThreadViewportStore();
  const api = useMemo<ConversationViewportApi>(
    () => ({
      isAtBottom: () => viewportStore.getState().isAtBottom,
      scrollToBottom: (behavior = "auto") =>
        viewportStore.getState().scrollToBottom({ behavior }),
    }),
    [viewportStore],
  );

  useLayoutEffect(() => {
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [api, apiRef]);

  useLayoutEffect(() => {
    onAtBottomChange(isAtBottom);
  }, [isAtBottom, onAtBottomChange]);

  return null;
}

/**
 * Shares D359 quote-reply state with an alternate Room composer. Subthreads
 * provide this explicitly because their composer is intentionally not the
 * main Conversation composer.
 */
export function ConversationReplyProvider({
  value,
  children,
}: {
  value: ConversationReplyContextValue;
  children: ReactNode;
}): ReactElement {
  return (
    <ConversationReplyContext.Provider value={value}>
      {children}
    </ConversationReplyContext.Provider>
  );
}

function useConversationReply(): ConversationReplyContextValue | null {
  return useContext(ConversationReplyContext);
}

/** First text part of an assistant-ui message's content, or "". */
function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const po = part as { type?: string; text?: string };
    if (po.type === "text" && typeof po.text === "string") return po.text;
  }
  return "";
}

/** Collapse whitespace + truncate to a single-line quote snippet. */
function makeReplySnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 119).trimEnd()}…` : collapsed;
}

/**
 * Resolve a display sender name for an arbitrary thread message (used by the
 * inline quoted strip). Mirrors the bubble's own author resolution: assistant
 * rows resolve via `authorAgentId`, human rows via the peer-label map (falling
 * back to "You" for the viewer, or the roster label for a peer).
 */
function resolveThreadMessageSender(
  message: { role?: string; metadata?: unknown },
  ctx: {
    labels: ReadonlyMap<string, string> | undefined;
    viewerUserId: string | null;
    members: readonly RoomMemberDto[];
    assistantName: string;
  },
): string {
  const custom = (message.metadata as {
    custom?: { sourceUserId?: unknown; authorAgentId?: unknown; authorHarnessId?: unknown };
  })?.custom;
  if (message.role === "assistant") {
    const authorAgentId =
      typeof custom?.authorAgentId === "string" ? custom.authorAgentId : undefined;
    const authorHarnessId =
      typeof custom?.authorHarnessId === "string" ? custom.authorHarnessId : undefined;
    return resolveAssistantAuthorLabel({
      authorAgentId,
      authorHarnessId,
      members: ctx.members,
      viewerUserId: ctx.viewerUserId,
      fallbackName: ctx.assistantName,
      fallbackAvatarSrc: "",
    }).name;
  }
  const sourceUserId =
    typeof custom?.sourceUserId === "string" ? custom.sourceUserId : undefined;
  if (!sourceUserId || sourceUserId === ctx.viewerUserId) return "You";
  return ctx.labels?.get(sourceUserId) ?? "Someone";
}

/**
 * D359 — Telegram-style inline quoted strip: accent bar + parent author +
 * 1-line snippet, rendered ABOVE the reply body. Tapping it jumps to (and
 * highlights) the quoted parent. When the parent isn't in the loaded thread
 * (deleted or not-yet-paged), renders a non-interactive "(deleted message)".
 */
function QuotedReplyStrip({
  parentId,
  assistantName,
}: {
  parentId: number;
  assistantName: string;
}): React.ReactElement {
  const messages = useThread((s) => s.messages);
  const reply = useConversationReply();
  const authorCtx = useContext(AuthorContext);
  const auth = useAuth();
  const members = useRoomMembers();

  const parent = useMemo(
    () => messages.find((m) => Number(m.id) === parentId) ?? null,
    [messages, parentId],
  );

  if (!parent) {
    return (
      <div
        data-testid="quoted-reply-deleted"
        className="mb-1 flex items-stretch gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1"
      >
        <span aria-hidden className="w-0.5 shrink-0 rounded-full bg-border" />
        <span className="truncate text-[11px] italic text-foreground-muted">
          replied to a deleted message
        </span>
      </div>
    );
  }

  const senderName = resolveThreadMessageSender(parent, {
    labels: authorCtx?.labels,
    viewerUserId: auth.viewer.sessionUserId,
    members,
    assistantName,
  });
  const rawText = extractMessageText(parent.content);
  const snippet = makeReplySnippet(
    parent.role === "assistant" ? stripAssistantArtifacts(rawText) : rawText,
  );

  return (
    <button
      type="button"
      onClick={() => { void reply?.jumpToMessage(parentId); }}
      data-testid="quoted-reply-strip"
      data-parent-id={parentId}
      className="mb-1 flex w-full items-stretch gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-left transition-colors hover:bg-background-element"
    >
      <span aria-hidden className="w-0.5 shrink-0 rounded-full bg-accent" />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold text-accent">{senderName}</span>
        <span className="block truncate text-[11px] text-foreground-muted">
          {snippet.length > 0 ? snippet : "(no text)"}
        </span>
      </span>
    </button>
  );
}

export function Conversation(props: ConversationProps) {
  // D352 (B) — if no author/member provider wraps this mount, self-source the
  // roster so mentions/identity/peer-labels work anywhere. Provider presence is
  // fixed per mount (the parent either wraps or not), so this branch is stable
  // across renders and never violates hook order.
  const hasAuthorProvider = useContext(AuthorContext) !== null;
  if (hasAuthorProvider) return <ConversationBody {...props} />;
  return (
    <SelfSourcedAuthorScope>
      <ConversationBody {...props} />
    </SelfSourcedAuthorScope>
  );
}

function browserGuestOwnsFind(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" && target instanceof Element &&
    Boolean(target.closest('[data-testid="saas-app-surface"], iframe'));
}

/**
 * The agent empty state is an authoritative claim: for an authenticated Room
 * it must wait until this exact scope's first server history pass has proven
 * there are no messages. Guest and no-Room surfaces retain their existing
 * empty behavior because they have no Room-history contract.
 */
export function shouldRenderConversationEmptyState(input: {
  readonly isAuthenticatedRoom: boolean;
  readonly currentScope: ConversationInitialHistoryScope | null;
  readonly initialHistoryState: RoomInitialHydrationState | null;
}): boolean {
  if (!input.isAuthenticatedRoom) return true;
  return selectCurrentConversationInitialHistoryState(input)?.kind === "empty";
}

/**
 * Only unresolved work is marked busy. Retry and terminal disclosures are
 * already final outcomes, so assistive technology should not hear a stale
 * loading state after the initial request settles.
 */
export function isConversationInitialHistoryBusy(input: {
  readonly isAuthenticatedRoom: boolean;
  readonly currentScope: ConversationInitialHistoryScope | null;
  readonly initialHistoryState: RoomInitialHydrationState | null;
}): boolean {
  if (!input.isAuthenticatedRoom) return false;
  const state = selectCurrentConversationInitialHistoryState(input);
  return state === null ||
    state.kind === "unresolved" ||
    state.kind === "syncing";
}

type ConversationInitialHistoryScope = Pick<
  RoomInitialHydrationScope,
  "origin" | "viewerKey" | "viewerGeneration" | "roomId"
>;

function hasCurrentConversationInitialHistoryScope(
  stateScope: RoomInitialHydrationScope,
  currentScope: ConversationInitialHistoryScope | null,
): boolean {
  return currentScope !== null &&
    stateScope.origin === currentScope.origin &&
    stateScope.viewerKey === currentScope.viewerKey &&
    stateScope.viewerGeneration === currentScope.viewerGeneration &&
    stateScope.roomId === currentScope.roomId;
}

/**
 * The presentation surface must receive the same full-scope projection as the
 * Empty and busy gates. A stale state from another server or viewer otherwise
 * looks "ready" to a surface that intentionally only knows the Room id.
 */
export function selectCurrentConversationInitialHistoryState(input: {
  readonly currentScope: ConversationInitialHistoryScope | null;
  readonly initialHistoryState: RoomInitialHydrationState | null;
}): RoomInitialHydrationState | null {
  const state = input.initialHistoryState;
  return state !== null && hasCurrentConversationInitialHistoryScope(state.scope, input.currentScope)
    ? state
    : null;
}

function ConversationBody({
  chromeDensity = "default",
  registerSendToGenieDraftDispatcher,
  readerFocusedResourceTarget,
}: ConversationProps) {
  const { agent, avatarSrc } = useProfile();
  const assistantName = agent?.name ?? SHELL_AGENT_NAME;
  const auth = useAuth();
  const can = useCan();
  const canInvokeAgents = can("invoke_agents");
  const location = useLocation();
  const navigate = useNavigate();
  const roomNav = useRoomNavigation();
  const notifications = useNotificationState();
  const activeRoomId = roomNav.activeRoomId;
  const activeRoom = roomNav.activeRoom;
  const activeRoomUnreadCount = activeRoomId
    ? notifications.roomsById.get(activeRoomId)?.ownUnreadCount ?? 0
    : 0;
  const roomComposerDrafts = useRoomComposerDraftStore();
  useKnownArtifacts(activeRoomId);
  // D441 — live peer typing state for the active room, fed into
  // PresenceTypingStrip below. Self-pings never appear here because the
  // server excludes the sender's socket.
  const typingOthers = useTypingOthers(activeRoomId);
  const roomHistory = useRoomHistoryControls();
  const roomInitialHistory = useRoomInitialHistory();
  const roomHistoryRef = useRef(roomHistory);
  roomHistoryRef.current = roomHistory;
  const roomSearch = useRoomMessageSearch();
  const roomSearchRef = useRef(roomSearch);
  roomSearchRef.current = roomSearch;
  const roomMembers = useRoomMembers();
  const directHumanRoom = useMemo(
    () =>
      resolveDirectHumanRoom({
        members: roomMembers,
        viewerActorId: auth.viewer.sessionActorId,
        viewerUserId: auth.viewer.sessionUserId,
      }),
    [auth.viewer.sessionActorId, auth.viewer.sessionUserId, roomMembers],
  );
  const [directHumanInteractionBlocked, setDirectHumanInteractionBlocked] = useState(false);
  useEffect(() => {
    const peerUserId = directHumanRoom.peer?.userId;
    if (!directHumanRoom.isDirectHumanRoom || !peerUserId) {
      setDirectHumanInteractionBlocked(false);
      return;
    }
    let current = true;
    const refresh = (): void => {
      void apiClient.getHumanBlockStatus(peerUserId).then(
        (status) => {
          if (current) setDirectHumanInteractionBlocked(status.directInteractionBlocked);
        },
        () => {
          // Keep the last known posture. The send endpoint remains the
          // authority if this advisory read is temporarily unavailable.
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [directHumanRoom.isDirectHumanRoom, directHumanRoom.peer?.userId]);
  const focus = useRoomFocusContext();
  const terminalControlRequest = useTerminalControlRequest();
  const focusedBotActorIds =
    focus.ring.kind === "single"
      ? [focus.ring.botActorId]
      : focus.ring.kind === "ambiguous"
        ? [...focus.ring.botActorIds]
        : [];
  const agentChromeLabel = resolveRoomAgentChromeLabel({
    members: roomMembers,
    focusedBotActorIds,
    fallbackName: assistantName,
  });
  const conversationPeerLabel = directHumanRoom.peer?.displayName ?? agentChromeLabel;
  const [newChatBusy, setNewChatBusy] = useState(false);
  const [roomsPanelOpen, setRoomsPanelOpen] = useState(false);
  const [transcriptFindOpen, setTranscriptFindOpen] = useState(false);
  const [transcriptFindSelection, setTranscriptFindSelection] = useState<RoomFindSelection | null>(null);
  const [transcriptFindBoundary, setTranscriptFindBoundary] = useState<string | null>(null);
  const [transcriptFindActivation, setTranscriptFindActivation] = useState<RoomFindActivationState>({ state: "idle" });
  const [compactRoomChrome, setCompactRoomChrome] = useState(false);
  const stripContainerRef = useRef<HTMLDivElement>(null);
  const transcriptFindOpenerRef = useRef<HTMLElement | null>(null);
  const previousSearchGenerationRef = useRef(roomSearch.generation);
  const transcriptFindSelectionRef = useRef<RoomFindSelection | null>(null);
  transcriptFindSelectionRef.current = transcriptFindSelection;
  const transcriptFindOpenRef = useRef(false);
  transcriptFindOpenRef.current = transcriptFindOpen;

  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportApiRef = useRef<ConversationViewportApi | null>(null);
  // D246 Wave 3 — imperative access to the bounded transcript window so
  // programmatic navigation (quote-reply jump, and any future search / retry /
  // edit target) can materialize an offscreen row before scrolling to it.
  const transcriptHandleRef = useRef<TranscriptWindowHandle>(null);
  const followingLiveEdgeRef = useRef(false);
  const lastCommittedTailRef = useRef<{
    scopeKey: string;
    visitId: number;
    messageId: string | null;
  } | null>(null);
  const cancelLiveTailScrollRef = useRef<(() => void) | null>(null);
  const activeRoomForJumpRef = useRef<string | null>(activeRoomId);
  activeRoomForJumpRef.current = activeRoomId;
  const activeViewportScopeKey = conversationViewportScopeKey(activeRoomId);
  const activeViewportScopeRef = useRef(activeViewportScopeKey);
  activeViewportScopeRef.current = activeViewportScopeKey;
  const scrollSnapshotByRoomRef = useRef(new Map<string, ConversationScrollSnapshot>());
  const markReadInFlightRef = useRef(new Set<string>());
  const restoreGenerationRef = useRef(0);
  const activeViewportVisitRef = useRef<ConversationViewportVisit>({
    scopeKey: activeViewportScopeKey,
    visitId: 0,
  });
  if (activeViewportVisitRef.current.scopeKey !== activeViewportScopeKey) {
    activeViewportVisitRef.current = {
      scopeKey: activeViewportScopeKey,
      visitId: activeViewportVisitRef.current.visitId + 1,
    };
    restoreGenerationRef.current += 1;
  }
  const activeViewportVisit = activeViewportVisitRef.current;
  const transcriptHydrationCoordinatorRef = useRef(
    createConversationTranscriptHydrationCoordinator(),
  );
  transcriptHydrationCoordinatorRef.current.beginVisit(activeViewportScopeKey);
  const [viewportReadyVisit, setViewportReadyVisit] = useState<ConversationViewportVisit | null>(null);
  const viewportReadyVisitRef = useRef<ConversationViewportVisit | null>(null);
  if (viewportReadyVisitRef.current?.visitId !== activeViewportVisit.visitId) {
    viewportReadyVisitRef.current = null;
  }
  const publishViewportReadyVisit = useCallback((visit: ConversationViewportVisit | null) => {
    if (visit && activeViewportVisitRef.current.visitId !== visit.visitId) return;
    viewportReadyVisitRef.current = visit;
    setViewportReadyVisit(visit);
  }, []);
  const effectiveViewportReadyScopeKey = viewportReadyVisit?.visitId === activeViewportVisit.visitId
    ? viewportReadyVisit.scopeKey
    : null;
  const [transcriptReadyVisit, setTranscriptReadyVisit] = useState<ConversationViewportVisit | null>(null);
  const handleTranscriptCommit = useCallback((
    scopeKey: string,
    visitId: number,
    messageIds: readonly string[],
  ) => {
    if (
      activeViewportScopeRef.current !== scopeKey ||
      activeViewportVisitRef.current.visitId !== visitId
    ) return;
    const visit = activeViewportVisitRef.current;
    const roomId = activeRoomForJumpRef.current;
    const snapshot = roomId === null ? undefined : scrollSnapshotByRoomRef.current.get(roomId);
    transcriptHydrationCoordinatorRef.current.commit({
      scopeKey,
      snapshotAnchorIds: snapshot?.anchors.map((anchor) => anchor.messageId) ?? [],
      committedMessageIds: messageIds,
      loadHistoryAround: (messageId) => roomHistoryRef.current.loadHistoryAround(messageId),
      isCurrent: () => activeViewportScopeRef.current === scopeKey &&
        activeViewportVisitRef.current.visitId === visit.visitId,
      onReady: () => {
        if (activeViewportVisitRef.current.visitId === visit.visitId) {
          setTranscriptReadyVisit(visit);
        }
      },
    });

    const committedTailMessageId = messageIds.at(-1) ?? null;
    const previous = lastCommittedTailRef.current;
    const previousTailMessageId =
      previous?.scopeKey === scopeKey && previous.visitId === visitId
        ? previous.messageId
        : null;
    lastCommittedTailRef.current = {
      scopeKey,
      visitId,
      messageId: committedTailMessageId,
    };
    const readyVisit = viewportReadyVisitRef.current;
    if (!shouldScheduleConversationLiveTailScroll({
      followingLiveEdge: followingLiveEdgeRef.current,
      activeScopeKey: activeViewportScopeRef.current,
      activeVisitId: activeViewportVisitRef.current.visitId,
      readyScopeKey: readyVisit?.scopeKey ?? null,
      readyVisitId: readyVisit?.visitId ?? null,
      committedScopeKey: scopeKey,
      committedVisitId: visitId,
      previousTailMessageId,
      committedTailMessageId,
    })) return;

    cancelLiveTailScrollRef.current?.();
    const expectedTailMessageId = committedTailMessageId;
    cancelLiveTailScrollRef.current = scheduleConversationLiveTailScroll({
      schedule: scheduleFrameWithFallback,
      isCurrent: () => {
        cancelLiveTailScrollRef.current = null;
        const currentVisit = activeViewportVisitRef.current;
        const currentReadyVisit = viewportReadyVisitRef.current;
        const currentTail = lastCommittedTailRef.current;
        return followingLiveEdgeRef.current &&
          currentVisit.scopeKey === scopeKey &&
          currentVisit.visitId === visitId &&
          currentReadyVisit?.scopeKey === scopeKey &&
          currentReadyVisit.visitId === visitId &&
          currentTail?.scopeKey === scopeKey &&
          currentTail.visitId === visitId &&
          currentTail.messageId === expectedTailMessageId;
      },
      scrollToBottom: () => viewportApiRef.current?.scrollToBottom("instant"),
    });
  }, []);
  const effectiveTranscriptReadyScopeKey =
    transcriptReadyVisit?.visitId === activeViewportVisit.visitId
      ? transcriptReadyVisit.scopeKey
      : null;

  // D359 (Stack 126) — inline quote-reply state shared with the composer +
  // message bubbles via ConversationReplyContext.
  const pendingReply = useRoomPendingReply(activeRoomId);
  const [highlightedMessageId, setHighlightedMessageId] = useState<number | null>(null);
  const [viewportMode, setViewportMode] = useState<ConversationViewportMode>("following");
  const followingLiveEdge = isConversationViewportFollowing({
    mode: viewportMode,
    activeScopeKey: activeViewportScopeKey,
    readyScopeKey: effectiveViewportReadyScopeKey,
  });
  followingLiveEdgeRef.current = followingLiveEdge;
  const awayFromLatest = isConversationViewportAway({
    mode: viewportMode,
    activeScopeKey: activeViewportScopeKey,
    readyScopeKey: effectiveViewportReadyScopeKey,
  });
  const handleViewportAtBottomChange = useCallback((
    atLiveEdge: boolean,
    origin: "layout" | "human" = "layout",
  ) => {
    setViewportMode((mode) =>
      transitionConversationViewport(mode, { type: "viewport-observed", atLiveEdge, origin }));
  }, []);
  const humanViewportGestureRef = useRef(false);
  useConversationLiveEdgeRecovery({
    viewportRef,
    readerAway: awayFromLatest && viewportMode === "reader-away",
    visitId: activeViewportVisit.visitId,
    onAtBottomChange: handleViewportAtBottomChange,
  });
  const humanViewportGestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportTouchStartYRef = useRef<number | null>(null);
  const markHumanViewportGesture = useCallback(() => {
    restoreGenerationRef.current += 1;
    transcriptHydrationCoordinatorRef.current.supersede(activeViewportScopeRef.current);
    publishViewportReadyVisit(activeViewportVisitRef.current);
    humanViewportGestureRef.current = true;
    if (humanViewportGestureTimerRef.current) {
      clearTimeout(humanViewportGestureTimerRef.current);
    }
    humanViewportGestureTimerRef.current = setTimeout(() => {
      humanViewportGestureRef.current = false;
      humanViewportGestureTimerRef.current = null;
    }, 250);
  }, [publishViewportReadyVisit]);
  const [jumpState, setJumpState] = useState<ConversationJumpState>({ state: "idle" });
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supersedeConversationRestore = useCallback(() => {
    restoreGenerationRef.current += 1;
    transcriptHydrationCoordinatorRef.current.supersede(activeViewportScopeRef.current);
    publishViewportReadyVisit(activeViewportVisitRef.current);
  }, [publishViewportReadyVisit]);

  const navigationControllerRef = useRef<ReturnType<typeof createConversationNavigationController> | null>(null);
  if (!navigationControllerRef.current) {
    navigationControllerRef.current = createConversationNavigationController({
      getActiveRoomId: () => activeRoomForJumpRef.current,
      materializeById: (messageId) => transcriptHandleRef.current?.materializeById(messageId) ?? false,
      loadHistoryAround: (messageId) => roomHistoryRef.current.loadHistoryAround(messageId),
      waitForCommit: waitForConversationCommit,
      scrollAndFocus: async (messageId, focusTarget) => {
        supersedeConversationRestore();
        const viewport = viewportRef.current;
        const findTarget = (): HTMLElement | null =>
          viewport?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`) ?? null;
        let el = findTarget();
        if (!el && viewport) {
          // The runtime update, assistant-ui projection, and TranscriptWindow
          // commit are separate steps. Observe the pinned window instead of
          // assuming they all finish within two animation frames.
          el = await waitForConversationTarget({
            findTarget,
            subscribe: (notify) => {
              const observer = new MutationObserver(notify);
              observer.observe(viewport, { childList: true, subtree: true });
              return () => observer.disconnect();
            },
            setFallback: (callback, delayMs) => setTimeout(callback, delayMs),
            clearFallback: (handle) => clearTimeout(handle),
          });
        }
        if (!el) {
          transcriptHandleRef.current?.releaseMaterializedTarget(messageId);
          return false;
        }
        // Find navigation must land deterministically even when Electron
        // throttles animation frames; smooth scrolling can otherwise leave the
        // highlighted row outside the viewport while the counter advances.
        el.scrollIntoView({ behavior: "auto", block: "center" });
        if (focusTarget) el.focus({ preventScroll: true });
        transcriptHandleRef.current?.releaseMaterializedTarget(messageId);
        return true;
      },
      onState: (state) => {
        if (state.state === "loading") supersedeConversationRestore();
        setJumpState(state);
      },
      onCompleted: (messageId) => {
        setViewportMode((mode) =>
          transitionConversationViewport(mode, { type: "target-navigation" }));
        setHighlightedMessageId(messageId);
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1600);
      },
    });
  }
  const navigationController = navigationControllerRef.current;
  const routeIntentConsumerRef = useRef<ReturnType<typeof createRoomMessageRouteIntentConsumer> | null>(null);
  if (!routeIntentConsumerRef.current) {
    routeIntentConsumerRef.current = createRoomMessageRouteIntentConsumer();
  }
  const routeIntentConsumer = routeIntentConsumerRef.current;
  const transcriptFindActivationControllerRef = useRef<ReturnType<typeof createRoomFindActivationController> | null>(null);
  if (!transcriptFindActivationControllerRef.current) {
    transcriptFindActivationControllerRef.current = createRoomFindActivationController({
      // Preserve the full navigation signature. In particular, Room find passes
      // `{ focusTarget: false }` so result activation scrolls without taking
      // keyboard focus from the query input.
      jumpToMessage: navigationController.jumpToMessage,
      isCurrent: (request) => transcriptFindOpenRef.current &&
        activeRoomForJumpRef.current === request.roomId &&
        roomSearchRef.current.generation === request.generation &&
        transcriptFindSelectionRef.current?.messageId === request.messageId,
      onState: setTranscriptFindActivation,
    });
  }
  const transcriptFindActivationController = transcriptFindActivationControllerRef.current;

  const beginReply = useCallback(
    (reply: PendingReply) => {
      if (activeRoomId) roomComposerDrafts.setPendingReply(activeRoomId, reply);
    },
    [activeRoomId, roomComposerDrafts],
  );
  const cancelReply = useCallback(() => {
    if (activeRoomId) roomComposerDrafts.setPendingReply(activeRoomId, null);
  }, [activeRoomId, roomComposerDrafts]);
  const jumpToMessage = useCallback(
    (messageId: number) => navigationController.jumpToMessage(messageId),
    [navigationController],
  );
  const returnToLatest = useCallback(() => {
    supersedeConversationRestore();
    setViewportMode((mode) =>
      transitionConversationViewport(mode, { type: "return-to-latest" }));
    returnConversationToLatest({
      supersede: navigationController.supersede,
      followTail: () => transcriptHandleRef.current?.followTail(),
      clearNavigation: () => {
        if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
        setHighlightedMessageId(null);
      },
      scheduleTailScroll: () => {
        const api = viewportApiRef.current;
        if (!api) {
          handleViewportAtBottomChange(false);
          return;
        }
        api.scrollToBottom("instant");
        requestAnimationFrame(() => {
          const viewport = viewportRef.current;
          handleViewportAtBottomChange(
            viewport !== null && isConversationViewportAtPhysicalLiveEdge(viewport),
          );
        });
      },
    });
  }, [handleViewportAtBottomChange, navigationController, supersedeConversationRestore]);

  useEffect(() => {
    navigationController.supersede();
    transcriptFindActivationController.supersede();
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightedMessageId(null);
  }, [activeRoomId, navigationController, transcriptFindActivationController]);

  useEffect(() => {
    void routeIntentConsumer.consume({
      locationKey: location.key,
      pathname: location.pathname,
      search: location.search,
      activeRoomId,
      replaceRoute: (path) => { void navigate(path, { replace: true }); },
      jumpToMessage: navigationController.jumpToMessage,
    });
  }, [
    activeRoomId,
    location.key,
    location.pathname,
    location.search,
    navigate,
    navigationController,
    routeIntentConsumer,
  ]);

  useEffect(() => {
    setTranscriptFindOpen(false);
    setTranscriptFindSelection(null);
    setTranscriptFindBoundary(null);
    transcriptFindActivationController.supersede();
  }, [activeRoomId, transcriptFindActivationController]);

  useEffect(() => {
    const search = roomSearchRef.current;
    const previousGeneration = previousSearchGenerationRef.current;
    const queryChanged = previousGeneration !== search.generation;
    setTranscriptFindSelection((selection) => reconcileRoomFindSelection({
      previousGeneration,
      generation: search.generation,
      query: search.query,
      selection,
      search,
    }));
    previousSearchGenerationRef.current = search.generation;
    setTranscriptFindBoundary(null);
    if (queryChanged) transcriptFindActivationController.supersede();
  }, [roomSearch.currentPageIndex, roomSearch.generation, roomSearch.hits, roomSearch.pages, roomSearch.query, transcriptFindActivationController]);

  useEffect(() => {
    if (!transcriptFindOpen || !activeRoomId || !transcriptFindSelection || jumpState.state === "loading") return;
    void transcriptFindActivationController.activate({
      roomId: activeRoomId,
      generation: roomSearch.generation,
      messageId: transcriptFindSelection.messageId,
    });
  }, [
    activeRoomId,
    jumpState.state,
    roomSearch.generation,
    transcriptFindActivationController,
    transcriptFindOpen,
    transcriptFindSelection,
  ]);

  useEffect(() => {
    return () => {
      cancelLiveTailScrollRef.current?.();
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      if (humanViewportGestureTimerRef.current) {
        clearTimeout(humanViewportGestureTimerRef.current);
      }
    };
  }, []);

  const replyContextValue = useMemo<ConversationReplyContextValue>(
    () => ({ pendingReply, beginReply, cancelReply, jumpToMessage, returnToLatest, awayFromLatest, jumpState, highlightedMessageId }),
    [pendingReply, beginReply, cancelReply, jumpToMessage, returnToLatest, awayFromLatest, jumpState, highlightedMessageId],
  );

  /** D106 + D528 — Room restore is an explicit navigation request. */
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const nextRoom = activeRoomId;
    const nextScopeKey = conversationViewportScopeKey(nextRoom);
    const nextVisit = activeViewportVisitRef.current;
    publishViewportReadyVisit(null);

    if (transcriptHydrationCoordinatorRef.current.isSuperseded(nextScopeKey)) return;

    const snapshot = nextRoom === null
      ? undefined
      : scrollSnapshotByRoomRef.current.get(nextRoom);
    if (!isConversationTranscriptReadyForRestore({
      activeScopeKey: nextScopeKey,
      transcriptReadyScopeKey: effectiveTranscriptReadyScopeKey,
      snapshotHasIdentity: (snapshot?.anchors.length ?? 0) > 0,
    })) {
      return;
    }

    const restoreGeneration = restoreGenerationRef.current;

    {
      requestAnimationFrame(() => {
        if (
          viewportRef.current !== el ||
          activeViewportScopeRef.current !== nextScopeKey ||
          activeViewportVisitRef.current.visitId !== nextVisit.visitId
        ) return;
        if (restoreGenerationRef.current !== restoreGeneration) {
          publishViewportReadyVisit(nextVisit);
          return;
        }
        if (!snapshot) {
          viewportApiRef.current?.scrollToBottom("instant");
          requestAnimationFrame(() => {
            if (
              viewportRef.current !== el ||
              activeViewportScopeRef.current !== nextScopeKey ||
              activeViewportVisitRef.current.visitId !== nextVisit.visitId
            ) return;
            if (restoreGenerationRef.current !== restoreGeneration) {
              publishViewportReadyVisit(nextVisit);
              return;
            }
            // The assistant-ui store can lag one frame behind the physical
            // viewport during initial hydration. The completed restore owns
            // this decision, so do not turn that transient false into a
            // reader-away state and a spurious Return to latest button.
            const restoredAtLiveEdge = isConversationViewportAtPhysicalLiveEdge(el);
            setViewportMode((mode) => transitionConversationViewport(mode, {
              type: "room-switch",
              restoredAtLiveEdge,
            }));
            publishViewportReadyVisit(nextVisit);
          });
        } else {
          void materializeFirstConversationAnchor({
            candidates: snapshot.anchors,
            materializeById: (messageId) =>
              transcriptHandleRef.current?.materializeById(messageId) ?? false,
            findTarget: (messageId) =>
              el.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`),
            releaseMaterializedTarget: (messageId) =>
              transcriptHandleRef.current?.releaseMaterializedTarget(messageId),
            waitForCommit: waitForConversationCommit,
            loadHistoryAround: (messageId) =>
              roomHistoryRef.current.loadHistoryAround(messageId),
            isCurrent: () => viewportRef.current === el &&
              activeViewportScopeRef.current === nextScopeKey &&
              activeViewportVisitRef.current.visitId === nextVisit.visitId &&
              restoreGenerationRef.current === restoreGeneration,
          }).then((restored) => {
            if (
              viewportRef.current !== el ||
              activeViewportScopeRef.current !== nextScopeKey ||
              activeViewportVisitRef.current.visitId !== nextVisit.visitId
            ) return;
            if (restoreGenerationRef.current !== restoreGeneration) {
              publishViewportReadyVisit(nextVisit);
              return;
            }
            if (restored) {
              const currentOffset = restored.target.getBoundingClientRect().top -
                el.getBoundingClientRect().top;
              el.scrollTop += currentOffset - restored.anchor.offsetPx;
              transcriptHandleRef.current?.releaseMaterializedTarget(restored.anchor.messageId);
            } else if (snapshot.anchors.length === 0) {
              el.scrollTop = snapshot.scrollTop;
            }
            const restoredAtLiveEdge = Math.abs(
              el.scrollHeight - el.scrollTop - el.clientHeight,
            ) <= 1;
            setViewportMode((mode) => transitionConversationViewport(mode, {
              type: "room-switch",
              restoredAtLiveEdge,
            }));
            publishViewportReadyVisit(nextVisit);
          });
        }
      });
    }

  }, [activeRoomId, effectiveTranscriptReadyScopeKey, publishViewportReadyVisit]);

  const readerRail = chromeDensity === "readerRail";

  /** D110 — narrow reading chat rail only: compact room strip + padding from measured width. */
  useLayoutEffect(() => {
    if (!readerRail) {
      setCompactRoomChrome(false);
      return;
    }
    const el = stripContainerRef.current;
    if (!el) return;
    const apply = (): void => {
      const w = el.getBoundingClientRect().width;
      setCompactRoomChrome(chatPanelUsesCompactRoomChrome(w));
    };
    apply();
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompactRoomChrome(chatPanelUsesCompactRoomChrome(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [readerRail]);

  const verified = isAuthenticatedHumanViewer(auth.viewer);
  const shellState = useRuntimeShellState();
  const isAuthenticatedRoom = verified && activeRoomId !== null;
  const currentInitialHistoryScope: ConversationInitialHistoryScope | null =
    isAuthenticatedRoom && auth.viewer.sessionUserId
      ? {
          origin: typeof window === "undefined" ? "" : window.location.origin,
          viewerKey: auth.viewer.sessionUserId,
          viewerGeneration: auth.viewerGeneration,
          roomId: activeRoomId,
        }
      : null;
  const surfaceInitialHistoryState = selectCurrentConversationInitialHistoryState({
    currentScope: currentInitialHistoryScope,
    initialHistoryState: roomInitialHistory.state,
  });
  const shouldRenderEmptyState = shouldRenderConversationEmptyState({
    isAuthenticatedRoom,
    currentScope: currentInitialHistoryScope,
    initialHistoryState: roomInitialHistory.state,
  });
  const initialHistoryBusy = isConversationInitialHistoryBusy({
    isAuthenticatedRoom,
    currentScope: currentInitialHistoryScope,
    initialHistoryState: roomInitialHistory.state,
  });
  const tabStripRooms = selectRoomsForTabStrip(roomNav.rooms, activeRoomId);
  const stripError =
    roomNav.status === "error" && roomNav.rooms.length === 0 ? roomNav.roomListError : null;

  const prepareRoomSwitch = useCallback(() => {
    const el = viewportRef.current;
    const visit = activeViewportVisitRef.current;
    freezeConversationViewportForRoomSwitch({
      activeRoomId,
      activeScopeKey: visit.scopeKey,
      readyScopeKey: viewportReadyVisitRef.current?.scopeKey ?? null,
      activeVisitId: visit.visitId,
      readyVisitId: viewportReadyVisitRef.current?.visitId ?? null,
      snapshots: scrollSnapshotByRoomRef.current,
      createSnapshot: () => el
        ? captureConversationScrollSnapshot(el)
        : { scrollTop: 0, anchors: [] },
      freeze: () => {
        // Freeze the outgoing visit before room navigation can clear/project
        // the shared assistant-ui store and emit a stale scroll event.
        viewportReadyVisitRef.current = null;
        setViewportReadyVisit(null);
        restoreGenerationRef.current += 1;
      },
    });
  }, [activeRoomId]);

  const handleSelectRoom = useCallback((roomId: string) => {
    if (roomId === activeRoomId) return;
    roomNav.setActiveRoom(roomId);
  }, [activeRoomId, roomNav]);

  useLayoutEffect(
    () => roomNav.registerBeforeActiveRoomChange?.(() => prepareRoomSwitch()),
    [prepareRoomSwitch, roomNav],
  );

  const handleCloseTab = useCallback(
    (roomId: string) => {
      const visible = selectRoomsForTabStrip(roomNav.rooms, roomNav.activeRoomId);
      const wasActive = roomNav.activeRoomId === roomId;
      const neighbor = wasActive ? pickNeighborTabId(visible, roomId) : null;

      if (wasActive) {
        if (neighbor && neighbor !== roomId) {
          handleSelectRoom(neighbor);
        } else {
          const fallback = roomNav.rooms.find((r) => r.id !== roomId && !r.closedTab);
          if (fallback) {
            handleSelectRoom(fallback.id);
          } else {
            prepareRoomSwitch();
            void navigate("/");
          }
        }
      }

      roomNav.closeTabForRoom(roomId);
    },
    [handleSelectRoom, navigate, prepareRoomSwitch, roomNav],
  );

  const handleOpenTranscriptFind = useCallback(
    (opener: HTMLElement | null) => {
      if (!activeRoomId) return;
      transcriptFindOpenerRef.current = opener;
      const search = roomSearchRef.current;
      setTranscriptFindSelection((selection) => reconcileRoomFindSelection({
        previousGeneration: search.generation,
        generation: search.generation,
        query: search.query,
        selection,
        search,
      }));
      setTranscriptFindBoundary(null);
      setTranscriptFindOpen(true);
    },
    [activeRoomId],
  );
  const handleCloseTranscriptFind = useCallback(() => {
    transcriptFindActivationController.supersede();
    setTranscriptFindOpen(false);
    setTranscriptFindSelection(null);
    setTranscriptFindBoundary(null);
    requestAnimationFrame(() => transcriptFindOpenerRef.current?.focus());
  }, [transcriptFindActivationController]);

  const handleRetryTranscriptFindActivation = useCallback(() => {
    if (!activeRoomId || !transcriptFindSelection) return;
    void transcriptFindActivationController.retry({
      roomId: activeRoomId,
      generation: roomSearchRef.current.generation,
      messageId: transcriptFindSelection.messageId,
    });
  }, [activeRoomId, transcriptFindActivationController, transcriptFindSelection]);

  const handleMoveTranscriptFind = useCallback(async (direction: FindDirection) => {
    const result = await moveRoomFindSelection({
      selection: transcriptFindSelection,
      direction,
      getSearch: () => roomSearchRef.current,
    });
    if (result.kind === "selected") {
      setTranscriptFindSelection(result.selection);
      setTranscriptFindBoundary(null);
    } else if (result.kind === "boundary") {
      setTranscriptFindBoundary(result.direction === "older"
        ? "No older search results."
        : "No newer search results.");
    }
  }, [transcriptFindSelection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const root = stripContainerRef.current;
      const target = event.target;
      const insideConversation = typeof Node !== "undefined" && target instanceof Node && root?.contains(target) === true;
      if (!shouldOwnRoomFindShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        insideConversation,
        browserGuestFocused: browserGuestOwnsFind(target),
      })) return;
      event.preventDefault();
      handleOpenTranscriptFind(captureRoomFindFocusRestoreTarget(
        target instanceof Element ? target : null,
        root,
      ));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleOpenTranscriptFind]);

  const toast = useToast();

  const loadOlderHistoryInFlightRef = useRef(false);
  const loadOlderHistoryRef = useRef<() => Promise<void>>(async () => {});
  const handleLoadOlderHistory = useCallback(async () => {
    const el = viewportRef.current;
    const scopeKey = activeViewportScopeRef.current;
    const visitId = activeViewportVisitRef.current.visitId;
    const generation = restoreGenerationRef.current;
    const history = roomHistoryRef.current;
    if (
      !el ||
      loadOlderHistoryInFlightRef.current ||
      viewportReadyVisitRef.current?.visitId !== visitId ||
      history.loadingBefore ||
      !history.hasMoreBefore
    ) return;
    loadOlderHistoryInFlightRef.current = true;
    try {
      const previousHeight = el.scrollHeight;
      const previousTop = el.scrollTop;
      const anchor = captureConversationScrollSnapshot(el);
      const previousTranscriptTotal = el
        .querySelector<HTMLElement>('[data-testid="transcript-window"]')
        ?.getAttribute("data-transcript-total") ?? null;
      const loaded = await history.loadOlder();
      const visitStillCurrent = (): boolean =>
        viewportRef.current === el &&
        activeViewportScopeRef.current === scopeKey &&
        activeViewportVisitRef.current.visitId === visitId;
      if (!loaded || !visitStillCurrent()) return;

      // Runtime pagination resolves after publishing to assistant-ui, not after
      // React has committed the prepended transcript. Waiting only one animation
      // frame can therefore restore against the old DOM; the subsequent virtual
      // window commit inserts a tall spacer above the mounted anchor while the
      // viewport stays at scrollTop=0, producing an apparently empty transcript.
      const transcriptCommitted = await waitForConversationTarget({
        findTarget: () => {
          const transcript = el.querySelector<HTMLElement>(
            '[data-testid="transcript-window"]',
          );
          return transcript?.getAttribute("data-transcript-total") !== previousTranscriptTotal
            ? transcript
            : null;
        },
        subscribe: (notify) => {
          const observer = new MutationObserver(notify);
          observer.observe(el, {
            attributes: true,
            attributeFilter: ["data-transcript-total"],
            childList: true,
            subtree: true,
          });
          return () => observer.disconnect();
        },
        setFallback: (callback, delayMs) => setTimeout(callback, delayMs),
        clearFallback: (handle) => clearTimeout(handle),
      });
      if (!transcriptCommitted || !visitStillCurrent()) return;

      if (isConversationViewportOperationCurrent({
        capturedViewport: el,
        currentViewport: viewportRef.current,
        capturedScopeKey: scopeKey,
        currentScopeKey: activeViewportScopeRef.current,
        capturedGeneration: generation,
        currentGeneration: restoreGenerationRef.current,
      })) {
        const restoredAnchor = selectFirstSurvivingConversationAnchor(
          anchor.anchors,
          (messageId) => el.querySelector(`[data-message-id="${messageId}"]`) !== null,
        );
        const target = restoredAnchor
          ? el.querySelector<HTMLElement>(`[data-message-id="${restoredAnchor.messageId}"]`)
          : null;
        if (target && restoredAnchor) {
          const currentOffset = target.getBoundingClientRect().top -
            el.getBoundingClientRect().top;
          el.scrollTop += currentOffset - restoredAnchor.offsetPx;
        } else if (anchor.anchors.length === 0) {
          el.scrollTop = el.scrollHeight - previousHeight + previousTop;
        }
      }

      // A fast upward gesture can legitimately supersede positional restore.
      // If it still leaves the reader in the prefetch zone, immediately pump
      // the next page without requiring another scroll event. A failed page
      // returns false above and stops here, leaving the button as the fallback.
      if (shouldAutoLoadOlderConversationHistory(el)) {
        requestAnimationFrame(() => {
          if (visitStillCurrent()) void loadOlderHistoryRef.current();
        });
      }
    } finally {
      loadOlderHistoryInFlightRef.current = false;
    }
  }, []);
  loadOlderHistoryRef.current = handleLoadOlderHistory;

  // M158 — scroll-to-bottom marks the whole room read (the shape-agnostic dot
  // clearer for the Slack/mixed path: 1:1 user↔agent, single-agent, and group
  // rooms all render through this component).
  const maybeMarkActiveRoomRead = useCallback(() => {
    const rid = activeRoomId;
    const el = viewportRef.current;
    const viewportAtBottom = viewportApiRef.current?.isAtBottom() === true;
    if (
      !rid ||
      !isConversationViewportReadyForRead({
        activeRoomId: rid,
        readyRoomId: effectiveViewportReadyScopeKey === activeViewportScopeKey ? rid : null,
        viewportAtBottom,
        followingLiveEdge,
      }) ||
      !shouldMarkRoomReadAtBottom({
        roomId: rid,
        verified,
        unreadCount: activeRoomUnreadCount,
        inFlight: markReadInFlightRef.current.has(rid),
        documentVisible:
          typeof document !== "undefined" ? document.visibilityState === "visible" : true,
        documentFocused: isWorkbenchSurfaceFocused(),
        thresholdPx: 1,
        viewport: el
          ? {
              scrollHeight: el.scrollHeight,
              scrollTop: el.scrollTop,
              clientHeight: el.clientHeight,
            }
          : null,
      })
    ) {
      return;
    }
    markReadInFlightRef.current.add(rid);
    void apiClient
      .markRoomRead(rid)
      .catch(() => {})
      .finally(() => {
        markReadInFlightRef.current.delete(rid);
      });
  }, [
    activeRoomId,
    activeRoomUnreadCount,
    activeViewportScopeKey,
    followingLiveEdge,
    verified,
    effectiveViewportReadyScopeKey,
  ]);

  const handleViewportScroll = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const viewportScopeReady = isConversationViewportScopeReady({
      activeScopeKey: activeViewportScopeKey,
      readyScopeKey: viewportReadyVisitRef.current?.scopeKey ?? null,
    }) && viewportReadyVisitRef.current?.visitId === activeViewportVisit.visitId;
    if (humanViewportGestureRef.current) {
      storeConversationSnapshotForReadyScope({
        activeRoomId,
        activeScopeKey: activeViewportScopeKey,
        readyScopeKey: viewportReadyVisitRef.current?.scopeKey ?? null,
        activeVisitId: activeViewportVisit.visitId,
        readyVisitId: viewportReadyVisitRef.current?.visitId ?? null,
        snapshots: scrollSnapshotByRoomRef.current,
        createSnapshot: () => captureConversationScrollSnapshot(el),
      });
      handleViewportAtBottomChange(
        Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= 1,
        "human",
      );
    }
    if (viewportScopeReady && shouldAutoLoadOlderConversationHistory(el)) {
      void handleLoadOlderHistory();
    }
    maybeMarkActiveRoomRead();
  }, [
    activeRoomId,
    activeViewportScopeKey,
    handleLoadOlderHistory,
    handleViewportAtBottomChange,
    maybeMarkActiveRoomRead,
    activeViewportVisit.visitId,
  ]);

  // Rooms that open already pinned to the bottom never fire a scroll event,
  // so re-check whenever the active room or its unread count changes.
  useEffect(() => {
    const raf = requestAnimationFrame(() => maybeMarkActiveRoomRead());
    return () => cancelAnimationFrame(raf);
  }, [maybeMarkActiveRoomRead]);

  // Returning to a hidden or unfocused surface (where inbound messages were
  // left unread) should mark the active, at-bottom room read again.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onActivation = (): void => maybeMarkActiveRoomRead();
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
  }, [maybeMarkActiveRoomRead]);

  const handleNewChat = useCallback(async () => {
    setNewChatBusy(true);
    try {
      await roomNav.createRoom(defaultNewChatLabel());
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create a new chat.";
      toast.show({
        variant: "error",
        title: "New chat failed",
        message: msg,
      });
    } finally {
      setNewChatBusy(false);
    }
  }, [roomNav, toast]);

  const missingRoom = verified && roomNav.activeResolution.kind === "missing";

  const railNarrow = readerRail && compactRoomChrome;
  const railPadX = railNarrow ? "px-3" : "px-4";
  const railPadTop = railNarrow ? "pt-3" : "pt-4";

  return (
    <ConversationReplyContext.Provider value={replyContextValue}>
    <div ref={stripContainerRef} className="relative flex h-full min-h-0 min-w-0 flex-col">
      <ThreadPrimitive.Root className="flex h-full min-h-0 min-w-0 flex-col">
      {verified ? (
        <RoomTabStrip
          rooms={tabStripRooms}
          activeRoomId={activeRoomId}
          viewerActorId={auth.viewer.sessionActorId}
          loading={roomNav.status === "loading"}
          errorMessage={stripError}
          onRetry={() => void roomNav.refreshRooms()}
          onSelect={handleSelectRoom}
          onClose={handleCloseTab}
          onReorder={(draggedRoomId, targetRoomId) => {
            roomNav.reorderOpenTabs(
              moveRoomIdBeforeTarget(
                tabStripRooms.map((room) => room.id),
                draggedRoomId,
                targetRoomId,
              ),
            );
          }}
          onNew={() => void handleNewChat()}
          showNew={canInvokeAgents}
          newDisabled={newChatBusy || roomNav.status === "loading"}
          onSearchOpen={handleOpenTranscriptFind}
          searchOpen={transcriptFindOpen}
          searchDisabled={!activeRoomId || roomNav.status === "loading"}
          roomsPanelOpen={roomsPanelOpen}
          onRoomsPanelOpenChange={setRoomsPanelOpen}
          roomsPanel={<RoomsPanel onClose={() => setRoomsPanelOpen(false)} />}
          compact={railNarrow}
        />
      ) : null}

      {verified && activeRoomId ? (
        <RoomTranscriptFindBar
          search={roomSearch}
          open={transcriptFindOpen}
          onClose={handleCloseTranscriptFind}
          selectedHitIndex={transcriptFindSelection?.indexInPage}
          ordinal={transcriptFindSelection?.ordinal}
          totalLabel={roomFindTotalLabel({ selection: transcriptFindSelection, search: roomSearch })}
          onPrevious={() => void handleMoveTranscriptFind("newer")}
          onNext={() => void handleMoveTranscriptFind("older")}
          previousDisabled={!transcriptFindSelection}
          nextDisabled={!transcriptFindSelection}
          boundaryMessage={transcriptFindBoundary}
          activationState={transcriptFindActivation}
          onRetryActivation={handleRetryTranscriptFindActivation}
          showReturnToLatest={awayFromLatest}
          onReturnToLatest={returnToLatest}
          highlightedMessageId={highlightedMessageId}
        />
      ) : null}

      {missingRoom ? (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-amber-500/15 px-4 py-2 text-xs"
        >
          <span className="min-w-0 text-foreground">
            This chat room is not available. It may have been removed or you may not have access.
          </span>
          <button
            type="button"
            className="shrink-0 rounded border border-border bg-background px-2 py-1 text-[11px] font-medium hover:bg-[var(--primary-muted)]"
            onClick={() => {
              void navigate("/");
            }}
          >
            Go to default chat
          </button>
        </div>
      ) : null}

      {directHumanInteractionBlocked ? (
        <div
          role="status"
          className="border-b border-border bg-background-panel px-4 py-2 text-xs text-foreground-muted"
        >
          Direct messaging is unavailable. Existing messages remain visible.
        </div>
      ) : null}

      <div className="relative flex min-h-0 min-w-0 flex-1">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        autoScroll={followingLiveEdge}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnInitialize
        scrollToBottomOnThreadSwitch={false}
        className={`flex h-full min-h-0 w-full min-w-0 flex-col overflow-x-hidden overflow-y-auto ${railPadX} ${railPadTop}`}
        onScroll={handleViewportScroll}
        aria-busy={initialHistoryBusy ? "true" : undefined}
        onPointerDown={(event) => {
          // A pointer on the scroll surface itself is a scrollbar/track intent;
          // clicks on message controls must never authorize follow resumption.
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
      >
        <ConversationViewportBridge
          apiRef={viewportApiRef}
          onAtBottomChange={handleViewportAtBottomChange}
        />
        {roomHistory.hasMoreBefore ? (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              className="rounded border border-border bg-background-panel px-3 py-1 text-xs text-foreground-muted hover:bg-background-element hover:text-foreground disabled:opacity-50"
              disabled={roomHistory.loadingBefore}
              onClick={() => void handleLoadOlderHistory()}
            >
              {roomHistory.loadingBefore ? "Loading older messages..." : "Load older messages"}
            </button>
          </div>
        ) : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {shouldRenderEmptyState ? (
            <ThreadPrimitive.Empty>
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-background-element text-2xl">
                  {directHumanRoom.peer?.userId ? (
                    <UserAvatar
                      userId={directHumanRoom.peer.userId}
                      displayName={directHumanRoom.peer.displayName}
                      size={64}
                    />
                  ) : directHumanRoom.isDirectHumanRoom ? (
                    <span
                      aria-label={conversationPeerLabel}
                      className="flex h-full w-full items-center justify-center bg-primary/20 text-xl font-semibold text-foreground"
                    >
                      {conversationPeerLabel.slice(0, 1).toUpperCase()}
                    </span>
                  ) : (
                    <AuthenticatedAvatar
                      src={avatarSrc}
                      alt={conversationPeerLabel}
                      className="h-full w-full object-cover"
                      fallback={<span aria-hidden>🐚</span>}
                    />
                  )}
                </div>
                <h2 className="text-lg font-semibold">{conversationPeerLabel}</h2>
                {verified && activeRoom ? (
                  <p className="max-w-md text-center text-xs font-medium text-foreground-muted">
                    Room: {activeRoom.label}
                  </p>
                ) : null}
                <p className="max-w-md text-center text-sm text-foreground-muted">
                  {/* ISSUE-D145 — empty-state copy decision is extracted into
                      `pickConversationEmptyCopy` so the bug-locus is
                      greppable + unit-testable. See
                      `lib/conversation-shell-copy.ts`. */}
                  {directHumanRoom.isDirectHumanRoom
                    ? `Start a conversation with ${conversationPeerLabel}.`
                    : pickConversationEmptyCopy({
                        shellState,
                        verified,
                        activeRoomLabel: activeRoom?.label ?? null,
                      })}
                </p>
              </div>
            </ThreadPrimitive.Empty>
          ) : null}

          {/* D246 Wave 3 — bounded transcript rendering. `ConversationTranscript`
              subscribes to the thread messages itself (a leaf) so token-level
              streaming updates don't re-render the whole conversation shell, and
              `TranscriptWindow` mounts only a measured window of rows + the
              streaming tail instead of every message root. */}
          <ConversationTranscript
            key={activeRoomId ?? "unverified-room"}
            assistantName={conversationPeerLabel}
            assistantAvatarSrc={avatarSrc}
            roomId={activeRoomId}
            followIntent={followingLiveEdge}
            viewportRef={viewportRef}
            handleRef={transcriptHandleRef}
            viewportVisitId={activeViewportVisit.visitId}
            onTranscriptCommit={handleTranscriptCommit}
            searchHighlight={{
              messageId: transcriptFindSelection ? Number(transcriptFindSelection.messageId) : null,
              query: roomSearch.query,
              mode: roomSearch.mode,
              ignoreCase: roomSearch.ignoreCase,
            }}
          />
          {isAuthenticatedRoom ? (
            <RoomInitialHistorySurface
              activeRoomId={activeRoomId}
              onRetry={roomInitialHistory.retry}
              state={surfaceInitialHistoryState}
            />
          ) : null}
        </div>
      </ThreadPrimitive.Viewport>
      {awayFromLatest ? (
        <button
          type="button"
          data-testid="conversation-return-to-latest"
          className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-background-panel px-3 py-1.5 text-xs font-medium text-foreground shadow-lg hover:bg-background-element"
          aria-label="Return to latest messages"
          onClick={returnToLatest}
        >
          {activeRoomUnreadCount > 0 ? "New messages · Return to latest" : "Return to latest"}
        </button>
      ) : null}
      </div>

      {/* D061 Phase 2-client (Chunk 5) — ApprovalAskDock sits between the
          scrolling viewport and the composer. Renders null when no
          approval is pending so the composer's border-top still reads
          as a single horizontal divider. When an approval is live, the
          dock appears as a warning-tinted band above the composer,
          keeping history scrollable behind it. */}
      {canInvokeAgents ? <ApprovalAskDock /> : null}
      {/* D453 — native Codex requests are an inline, owner-private protocol
          surface. Keep them between transcript and composer; they must never
          behave like a toast, overlay, or modal over the user's draft. */}
      {canInvokeAgents ? <CodexRequestDock /> : null}
      {canInvokeAgents && terminalControlRequest?.sessionId ? (
        <TerminalControlRequestDock
          sessionId={terminalControlRequest.sessionId}
          assistantName={conversationPeerLabel}
          onApprove={terminalControlRequest.onApprove}
          onDeny={terminalControlRequest.onDeny}
          onOpenTerminal={terminalControlRequest.onOpenTerminal}
        />
      ) : null}

      <PresenceTypingStrip
        assistantName={conversationPeerLabel}
        others={typingOthers}
        composerInset={railNarrow ? "compact" : "default"}
      />

      {/* D375 — Auto-Approve corner toggle. Anchored directly above the
          composer (below the presence strip) so it stays flush and does
          NOT bounce when the "…is thinking" strip appears/disappears. */}
      {canInvokeAgents && !directHumanRoom.isDirectHumanRoom ? <AutoApproveBar /> : null}

      <div className={`border-t border-border bg-background ${railPadX} ${railNarrow ? "py-2" : "py-3"}`}>
        <Composer
          assistantName={canInvokeAgents ? conversationPeerLabel : activeRoom?.label ?? "room"}
          tightLayout={railNarrow}
          directHumanRoom={directHumanRoom.isDirectHumanRoom}
          directHumanInteractionBlocked={directHumanInteractionBlocked}
          registerSendToGenieDraftDispatcher={registerSendToGenieDraftDispatcher}
          readerFocusedResourceTarget={readerFocusedResourceTarget}
        />
      </div>
    </ThreadPrimitive.Root>
    </div>
    </ConversationReplyContext.Provider>
  );
}

function Composer({
  assistantName,
  tightLayout = false,
  directHumanRoom = false,
  directHumanInteractionBlocked = false,
  registerSendToGenieDraftDispatcher,
  readerFocusedResourceTarget,
}: {
  assistantName: string;
  /** D110 — reduce horizontal padding in narrow chat rails */
  tightLayout?: boolean;
  /** Exactly two Humans, no Agents: preserve human controls and omit Agent chrome. */
  directHumanRoom?: boolean;
  /** M297 — server-authored posture for this exact Human pair. */
  directHumanInteractionBlocked?: boolean;
  registerSendToGenieDraftDispatcher?: GenieHandoffBridge["registerBrowserPageDraftDispatcher"];
  readerFocusedResourceTarget?: ReaderFocusedResourceTarget;
}) {
  const voice = useVoiceControls();
  const autoApprove = useAutoApprove();
  const speech = useSpeechRecognition();
  const toast = useToast();
  const auth = useAuth();
  const can = useCan();
  const canInvokeAgents = can("invoke_agents");
  const canWriteArtifacts = can("write_artifacts");
  const composerText = useComposer((s) => s.text);
  const composerRuntime = useComposerRuntime();
  const browserAttachmentInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setHasUnsentComposerText(composerText.trim().length > 0);
    return () => setHasUnsentComposerText(false);
  }, [composerText]);
  const roomNav = useRoomNavigation();
  const { response: profileResponse } = useProfile();
  const focus = useRoomFocusContext();
  const activeRoomId = roomNav.activeRoomId;
  const roomComposerSendPending = useRoomComposerSendPending(activeRoomId);
  const workspaceArtifacts = useWorkspaceArtifacts();
  const resolveContextualFocusedResources = useCallback(
    async (): Promise<readonly ChatFocusedResourceRef[]> => {
      const relayId = readerFocusedResourceTarget?.kind === "local-file"
        ? await getDesktopRelayId()
        : null;
      return readerFocusedResourcesForSend({
        ...(readerFocusedResourceTarget ? { target: readerFocusedResourceTarget } : {}),
        relayId,
        activeRoomId,
        artifactProjectionRoomId: workspaceArtifacts.roomId,
        artifacts: workspaceArtifacts.artifacts,
      });
    },
    [
      activeRoomId,
      readerFocusedResourceTarget,
      workspaceArtifacts.artifacts,
      workspaceArtifacts.roomId,
    ],
  );
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;
  const { tasks: roomTasks } = useTaskState();
  const roomHasStoppableTask = useMemo(
    () => hasStoppableRoomTask(roomTasks, activeRoomId),
    [activeRoomId, roomTasks],
  );
  const canStopRoomWork = voice.isRunning || roomHasStoppableTask;
  // D210 — mention picker adapter built from the room roster (provided
  // by SlackShapeRoom via MessageAuthorProvider).
  // Outside a shape parent, members is empty → adapter returns no
  // categories → mention popover stays inert. No regression for legacy
  // /chat surfaces.
  const roomMembers = useRoomMembers();
  // D462: a Room override must be keyed to an exact owned Agent. Other
  // members' Agents cannot make the viewer's sole owned Agent ambiguous.
  const activeRoomAgentId = useMemo(() => {
    if (!canInvokeAgents) return null;
    const ownedAgentIds = new Set(
      profileResponse?.viewerRole === "owner"
        ? profileResponse.ownedAgents.map((ownedAgent) => ownedAgent.agentId)
        : [],
    );
    return resolveRoomModelAgentTarget({
      members: roomMembers,
      ownedAgentIds,
      ring: focus.ring,
    });
  }, [canInvokeAgents, focus.ring, profileResponse, roomMembers]);
  const threadMessages = useThread((s) => s.messages);
  const lastSpokeAtMs = useMemo(
    () =>
      buildLastSpokeAtMsFromThread(
        threadMessages,
        roomMembers,
        auth.viewer.sessionUserId ?? undefined,
      ),
    [threadMessages, roomMembers, auth.viewer.sessionUserId],
  );
  const mentionableRoomMembers = useMemo(
    () => canInvokeAgents ? roomMembers : roomMembers.filter((member) => member.kind === "user"),
    [canInvokeAgents, roomMembers],
  );
  const memberByHandle = useMemo(
    () => buildMemberByHandle(mentionableRoomMembers),
    [mentionableRoomMembers],
  );
  const memberByActorId = useMemo(() => {
    const m = new Map<string, RoomMemberDto>();
    for (const member of roomMembers) m.set(member.actorId, member);
    return m;
  }, [roomMembers]);
  const mentionAdapter = useMentionAdapterForRoom(
    mentionableRoomMembers,
    auth.viewer.sessionActorId ?? undefined,
    lastSpokeAtMs,
  );
  const commandAdapter = useCommandAdapter();
  const reply = useConversationReply();
  // D359 — hitting Reply should drop the cursor straight into the composer so
  // the user can type immediately (Telegram/Slack behavior). assistant-ui only
  // auto-focuses on run-start / thread-switch, so we focus the textarea inside
  // the composer <form> whenever a new reply target is set.
  const composerRootRef = useRef<HTMLFormElement>(null);
  const pendingReplyTargetId = reply?.pendingReply?.targetId ?? null;
  useEffect(() => {
    if (pendingReplyTargetId == null) return;
    const focusComposerInput = () => {
      composerRootRef.current
        ?.querySelector<HTMLElement>("[data-nautilo-composer-input] [contenteditable='true']")
        ?.focus({ preventScroll: true });
    };
    const raf = requestAnimationFrame(focusComposerInput);
    return () => cancelAnimationFrame(raf);
  }, [pendingReplyTargetId]);
  const askUser = useAskUserPicker();
  const askUserVisible =
    canInvokeAgents && askUser.active && askUser.roomId === activeRoomId && askUser.options.length >= 2;
  const askUserPendingContent = useMemo(() => {
    if (!askUserVisible) return null;
    return (
      askUser.pendingContent ??
      findMessageContentById(threadMessages, askUser.messageId)
    );
  }, [
    askUser.messageId,
    askUser.pendingContent,
    askUserVisible,
    threadMessages,
  ]);
  const lastTurnStopToastAttemptRef = useRef(0);

  useEffect(() => {
    if (!askUserVisible || askUser.pendingContent || !askUser.messageId) return;
    const resolved = findMessageContentById(threadMessages, askUser.messageId);
    if (resolved) setAskUserPendingContent(resolved);
  }, [
    askUser.messageId,
    askUser.pendingContent,
    askUserVisible,
    threadMessages,
  ]);

  useEffect(() => {
    const status = voice.turnStopStatus;
    if (status.state !== "failed") return;
    if (lastTurnStopToastAttemptRef.current === status.attemptId) return;
    lastTurnStopToastAttemptRef.current = status.attemptId;

    if (status.reason === "no-target") {
      toast.show({
        variant: "warning",
        title: "Stop couldn't find the running turn",
        message:
          "Nautilo thought a turn was active, but no stop target was available. Try reconnecting if it keeps running.",
      });
      return;
    }
    if (status.reason === "not-live") {
      toast.show({
        variant: "warning",
        title: "Turn was not live",
        message: "The server did not find an active job for this Stop target.",
      });
      return;
    }
    toast.show({
      variant: "error",
      title: "Stop request failed",
      message: "The server did not confirm the stop request. The turn may still be running.",
    });
  }, [toast, voice.turnStopStatus]);

  const handleAskUserPick = useCallback(
    (botActorId: string) => {
      if (!askUserVisible || !activeRoomId) return;
      const content = askUserPendingContent;
      if (!content) return;
      void resumeAskUserPick({
        roomId: activeRoomId,
        botActorId,
        content,
        humanTurnId: askUser.humanTurnId,
        messageId: askUser.messageId,
        voiceMode: voice.enabled,
        autoApprove: autoApprove.enabled,
      });
    },
    [
      activeRoomId,
      askUserPendingContent,
      askUserVisible,
      askUser.humanTurnId,
      askUser.messageId,
      autoApprove.enabled,
      voice.enabled,
    ],
  );

  const handleAskUserDismiss = useCallback(() => {
    clearAskUserPicker();
  }, []);
  const roomComposerDrafts = useRoomComposerDraftStore();
  const restoringFocusedDraftRef = useRef(false);
  const prevRoomForDraftRef = useRef<string | null>(null);
  const restoringRoomDraftRef = useRef<{
    roomId: string;
    text: string;
    focusedResourceEntryIds: readonly string[];
  } | null>(null);
  const composerTextRef = useRef(composerText);
  composerTextRef.current = composerText;
  // D441/D454 — this is shared with the child-room thread composer. It emits
  // only from native input capture, so programmatic draft restoration remains
  // silent in both surfaces.
  useComposerTypingPing({
    rootRef: composerRootRef,
    roomId: activeRoomId,
    displayName: auth.viewer.label,
  });

  // D459 — the provider owns this envelope across center/reader-rail mounts.
  // Always adopt provider state on mount. This also clears assistant-ui's
  // shared composer when a presentation remounts after the active Room changed
  // while no Conversation surface was mounted.
  useLayoutEffect(() => {
    const prev = prevRoomForDraftRef.current;
    const next = activeRoomId;

    if (prev === next) return;

    if (prev !== null) {
      roomComposerDrafts.saveComposition(prev, {
        text: composerTextRef.current,
        focusedResources: getFocusedResources(),
      });
    }

    const restored = next !== null ? roomComposerDrafts.get(next) : undefined;
    const text = restored?.text ?? "";
    const focusedResources = restored?.focusedResources ?? [];
    // Restore refs first so resource directives become atomic MentionNodes.
    restoringFocusedDraftRef.current = true;
    restoringRoomDraftRef.current = next
      ? {
          roomId: next,
          text,
          focusedResourceEntryIds: focusedResources.map((item) => item.entryId),
        }
      : null;
    restoreFocusedResources(focusedResources);
    composerRuntime.setText(text);
    prevRoomForDraftRef.current = next;
  }, [activeRoomId, composerRuntime, roomComposerDrafts]);

  // D057 2a.10 / D059 3.4 — gate send on WS connection. We don't disable
  // the input itself (user can still type / queue a message mentally)
  // just the button + the assistant-ui Send primitive.
  const ws = useWsState();
  const shellState = useRuntimeShellState();
  const roomReady =
    !isAuthenticatedHumanViewer(auth.viewer) || roomNav.activeResolution.kind === "selected";
  const canSend =
    ws.state === "open" &&
    roomReady &&
    voice.roomBindingReady &&
    !directHumanInteractionBlocked;
  // ISSUE-D145 — composer-disabled tooltip extracted into
  // `pickComposerDisabledTitle` so both `authenticated_disconnected`
  // AND `authenticated_resuming` produce the honest "Server
  // unreachable …" copy (PR #173 review fix: the resuming variant
  // was previously falling through to "Waiting for server
  // connection"). See `lib/conversation-shell-copy.ts` and tests.
  const sendDisabledTitle = directHumanInteractionBlocked
    ? "Direct messaging is unavailable for this person."
    : pickComposerDisabledTitle({
        shellState,
        wsOpen: ws.state === "open",
        roomReady,
      });
  const [hasText, setHasText] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [pickingAttachments, setPickingAttachments] = useState(false);
  const prevTranscriptRef = useRef("");

  useEffect(() => {
    setHasText(composerText.length > 0);
  }, [composerText]);

  useEffect(() => {
    if (!speech.isListening && speech.transcript && speech.transcript !== prevTranscriptRef.current) {
      prevTranscriptRef.current = speech.transcript;
      // D528 policy: a deliberate local send resumes live-edge following.
      reply?.returnToLatest();
      void resolveContextualFocusedResources().then((contextualFocusedResources) =>
        voice.sendText(speech.transcript, { contextualFocusedResources }),
      );
    }
  }, [reply, resolveContextualFocusedResources, speech.isListening, speech.transcript, voice]);

  const handleMicToggle = useCallback(() => {
    if (speech.isListening) {
      speech.stopListening();
    } else {
      voice.stop();
      prevTranscriptRef.current = "";
      speech.startListening();
    }
  }, [speech, voice]);

  // D057 2a.4 — native app menu's "Speak" item (⌘⇧V) dispatches this
  // event so the composer's mic toggles without the menu needing to
  // know about speech-recognition internals.
  useEffect(() => {
    const onMenuSpeak = (): void => handleMicToggle();
    window.addEventListener(MENU_SPEAK_EVENT, onMenuSpeak);
    return () => window.removeEventListener(MENU_SPEAK_EVENT, onMenuSpeak);
  }, [handleMicToggle]);

  const showMic = speech.isSupported && !hasText;

  const insertEmoji = useCallback(
    (emoji: string) => {
      composerRuntime.setText(composerTextRef.current + emoji);
      setHasText(true);
    },
    [composerRuntime],
  );

  // D513 — only the shell-designated reader rail registers the active
  // editable composer. Advance its ref before React schedules work so two
  // same-tick browser handoffs compose in their original order.
  useEffect(() => {
    if (!registerSendToGenieDraftDispatcher) return;
    return registerSendToGenieDraftDispatcher(createBrowserPageDraftDispatcher({
      apiClient,
      getCurrentRoomId: () => activeRoomIdRef.current,
      getCurrentDraft: () => composerTextRef.current,
      setCurrentDraft: (next) => {
        // Advance synchronously: a second handoff before React rerenders must
        // compose against this exact draft instead of losing the first one.
        composerTextRef.current = next;
        composerRuntime.setText(next);
        setHasText(true);
      },
      refreshRooms: roomNav.refreshRooms,
      setActiveRoom: roomNav.setActiveRoom,
    }));
  }, [composerRuntime, registerSendToGenieDraftDispatcher, roomNav.refreshRooms, roomNav.setActiveRoom]);

  // Cursor-style file chips. Drag a file onto the textarea: we add a
  // metadata-only attachment. The server-side D066 gate reads and scans
  // content on send; the visible textarea stays clean.
  const attachments = useSyncExternalStore(
    subscribeAttachments,
    getAttachmentsSnapshot,
    getAttachmentsSnapshot,
  );

  const focusedResources = useSyncExternalStore(
    subscribeFocusedResources,
    getFocusedResourcesSnapshot,
    getFocusedResourcesSnapshot,
  );
  const focusedResourcesRef = useRef(focusedResources);
  focusedResourcesRef.current = focusedResources;
  const unboundComposerSendInFlightRef = useRef(false);
  const [unboundComposerSendPending, setUnboundComposerSendPending] = useState(false);
  const composerSendPending = activeRoomId
    ? roomComposerSendPending
    : unboundComposerSendPending;
  const composerPresentationMountedRef = useRef(false);
  useLayoutEffect(() => {
    composerPresentationMountedRef.current = true;
    return () => {
      composerPresentationMountedRef.current = false;
    };
  }, []);

  // Keep a complete envelope current while this presentation is mounted. The
  // handoff guard prevents the new mount's pre-restore AUI value from racing
  // over the provider snapshot it is about to adopt.
  useLayoutEffect(() => {
    if (!activeRoomId) return;
    const restoring = restoringRoomDraftRef.current;
    if (restoring?.roomId === activeRoomId) {
      const resourceIds = focusedResources.map((item) => item.entryId);
      if (
        composerText !== restoring.text ||
        resourceIds.length !== restoring.focusedResourceEntryIds.length ||
        resourceIds.some((entryId, index) => entryId !== restoring.focusedResourceEntryIds[index])
      ) {
        return;
      }
      restoringRoomDraftRef.current = null;
    }
    roomComposerDrafts.saveComposition(activeRoomId, {
      text: composerText,
      focusedResources,
    });
  }, [activeRoomId, composerText, focusedResources, roomComposerDrafts]);

  useLayoutEffect(() => {
    return () => {
      const roomId = prevRoomForDraftRef.current;
      if (!roomId) return;
      roomComposerDrafts.saveComposition(roomId, {
        text: composerTextRef.current,
        focusedResources: focusedResourcesRef.current,
      });
    };
  }, [roomComposerDrafts]);

  // The text is the source of inline-node presence. Delete/cut removes the
  // final directive's authority; explicit store removal demotes its directive
  // back to harmless display text.
  useEffect(() => {
    if (restoringFocusedDraftRef.current) {
      restoringFocusedDraftRef.current = false;
      return;
    }
    const present = resourceEntryIdsInText(composerText);
    for (const item of focusedResources) {
      if (!present.has(item.entryId)) removeFocusedResource(item.entryId);
    }
  }, [composerText, focusedResources]);

  useEffect(() => {
    const next = demoteUnknownResourceDirectives(composerText, hasFocusedResource);
    if (next !== composerText) composerRuntime.setText(next);
  }, [composerText, composerRuntime, focusedResources]);

  /** Bypass assistant-ui Send/Enter when `isRunning && !queue` (external-store defaults queue=false). */
  const canSubmitComposer =
    canSend &&
    !composerSendPending &&
    (composerText.trim().length > 0 || attachments.length > 0 || focusedResources.length > 0);

  const submitComposer = useCallback(async () => {
    if (!canSubmitComposer) return;
    const submittedRoomId = activeRoomId;
    const providerAttemptId = submittedRoomId
      ? roomComposerDrafts.beginSend(submittedRoomId)
      : null;
    if (submittedRoomId && providerAttemptId === null) return;
    if (!submittedRoomId) {
      if (unboundComposerSendInFlightRef.current) return;
      unboundComposerSendInFlightRef.current = true;
      setUnboundComposerSendPending(true);
    }
    // D528 policy: only this local intent (never a generic run-start event)
    // may move a reader from history back to the live edge.
    reply?.returnToLatest();
    const projectedMentions = projectHumanMentionDirectives(
      composerText,
      roomMembers,
    );
    const text = projectResourceDirectives(projectedMentions.text);
    // Capture the complete Room envelope before runtime adds its optimistic
    // bubble. The runtime clears focused resources before its request settles;
    // restoring this snapshot on false keeps a failed send editable.
    const submittedDraft = {
      text: composerText,
      focusedResources: [...focusedResources],
      pendingReply: reply?.pendingReply ?? null,
    };
    const replyTargetId = submittedDraft.pendingReply?.targetId;
    let composerCleaned = false;
    const cleanupComposer = (): void => {
      if (composerCleaned) return;
      composerCleaned = true;
      const stillOwnsPresentation = ownsSubmittedComposerPresentation({
        mounted: composerPresentationMountedRef.current,
        activeRoomId: activeRoomIdRef.current,
        submittedRoomId,
      });
      if (stillOwnsPresentation) {
        // Post-submit cleanup. The `setHasText(false)` step inside the
        // helper is load-bearing for the mic-button gate (`showMic =
        // speech.isSupported && !hasText`) — see
        // `composer-post-submit.ts` module header. Pinned by
        // `composer-post-submit.test.ts` regression suite; the helper
        // exists so this never silently regresses again.
        void applyComposerPostSubmit(
          { sent: true, activeRoomId: submittedRoomId },
          {
            resetComposerRuntime: () => composerRuntime.reset(),
            resetHasText: setHasText,
          },
        );
      }
      if (submittedRoomId) {
        roomComposerDrafts.clear(submittedRoomId);
        if (stillOwnsPresentation) {
          // The focused-resource ref store remains the authority for attachments
          // and chips; clear only this sent Room's composition snapshot.
          restoreFocusedResources([]);
          composerTextRef.current = "";
          focusedResourcesRef.current = [];
        }
      }
    };
    try {
      const contextualFocusedResources = await resolveContextualFocusedResources();
      const sent = await sendIfComposerPresentationCurrent({
        isMounted: () => composerPresentationMountedRef.current,
        getActiveRoomId: () => activeRoomIdRef.current,
        submittedRoomId,
        send: () => voice.sendText(text, {
          // Clear synchronously with the optimistic bubble. Delaying this until
          // HTTP success lets an old A attempt reset the shared B composer after
          // a room switch or center/rail remount.
          onOptimisticUserMessage: cleanupComposer,
          ...(replyTargetId !== undefined ? { replyToMessageId: replyTargetId } : {}),
          ...(projectedMentions.mentionedHumanUserIds.length > 0
            ? {
                mentionedHumanUserIds:
                  projectedMentions.mentionedHumanUserIds,
              }
            : {}),
          ...(projectedMentions.mentionEveryone ? { mentionEveryone: true } : {}),
          ...(contextualFocusedResources.length > 0 ? { contextualFocusedResources } : {}),
        }),
      });
      if (sent) {
        if (!composerCleaned) cleanupComposer();
      }
      if (!sent && submittedRoomId) {
        const currentDraft = roomComposerDrafts.get(submittedRoomId);
        const stillOwnsPresentation =
          composerPresentationMountedRef.current &&
          activeRoomIdRef.current === submittedRoomId;
        const activeText = stillOwnsPresentation ? composerTextRef.current : "";
        const activeResources = stillOwnsPresentation ? focusedResourcesRef.current : [];
        const hasReplacementDraft = stillOwnsPresentation
          ? (
              activeText.length > 0 ||
              activeResources.length > 0 ||
              currentDraft?.pendingReply != null
            )
          : Boolean(
              currentDraft && (
                currentDraft.text.length > 0 ||
                currentDraft.focusedResources.length > 0 ||
                currentDraft.pendingReply !== null
              ),
            );
        const preservedDraft = hasReplacementDraft
          ? {
              text: stillOwnsPresentation ? activeText : currentDraft?.text ?? "",
              focusedResources: stillOwnsPresentation
                ? activeResources
                : currentDraft?.focusedResources ?? [],
              pendingReply: currentDraft?.pendingReply ?? null,
            }
          : submittedDraft;
        roomComposerDrafts.saveComposition(submittedRoomId, {
          text: preservedDraft.text,
          focusedResources: preservedDraft.focusedResources,
        });
        roomComposerDrafts.setPendingReply(submittedRoomId, preservedDraft.pendingReply);
        // Do not overwrite a different Room the user selected while the request
        // was pending; its surface will adopt this envelope on return instead.
        if (stillOwnsPresentation) {
          restoringFocusedDraftRef.current = true;
          restoringRoomDraftRef.current = {
            roomId: submittedRoomId,
            text: preservedDraft.text,
            focusedResourceEntryIds: preservedDraft.focusedResources.map((item) => item.entryId),
          };
          restoreFocusedResources(preservedDraft.focusedResources);
          composerTextRef.current = preservedDraft.text;
          focusedResourcesRef.current = preservedDraft.focusedResources;
          composerRuntime.setText(preservedDraft.text);
          setHasText(preservedDraft.text.length > 0);
        }
      }
    } finally {
      if (submittedRoomId && providerAttemptId !== null) {
        roomComposerDrafts.finishSend(submittedRoomId, providerAttemptId);
      } else {
        unboundComposerSendInFlightRef.current = false;
        if (composerPresentationMountedRef.current) {
          setUnboundComposerSendPending(false);
        }
      }
    }
  }, [
    canSubmitComposer,
    composerText,
    voice,
    composerRuntime,
    activeRoomId,
    activeRoomIdRef,
    reply,
    roomComposerDrafts,
    roomMembers,
    focusedResources,
    resolveContextualFocusedResources,
  ]);

  const handleComposerDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    const types = Array.from(e.dataTransfer.types);
    if (
      types.includes(NAUTILO_ARTIFACT_REF_MIME) ||
      (canWriteArtifacts && types.includes("Files")) ||
      (isDesktop && auth.viewer.isVerified && types.includes(NAUTILO_FILE_REF_MIME))
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, [auth.viewer.isVerified, canWriteArtifacts]);

  const queueBrowserComposerFiles = useCallback((files: Iterable<File>) => {
    const skipped: ComposerChatAttachmentSkip[] = [];
    for (const file of files) {
      const pf = preflightComposerChatAttachment(file.name);
      if (!pf.ok) {
        skipped.push(pf.skip);
        continue;
      }
      const id = newAttachmentId();
      const added = addAttachment({
        id,
        path: "",
        rootPath: "",
        name: file.name,
        sizeBytes: file.size,
        status: "pending",
      });
      if (!added) {
        setAttachmentError("Attachment limit reached. Send or remove files before adding more.");
        break;
      }
      setAttachmentError(null);
      void uploadComposerBlob(id, file, file.name, { roomId: activeRoomId });
    }
    if (skipped.length > 0) {
      const { title, message } = formatComposerAttachmentSkipToast(skipped);
      toast.show({ variant: "warning", title, message });
    }
  }, [activeRoomId, toast]);

  const handleComposerDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      const dispatch = classifyComposerDrop(e.dataTransfer);
      // Resolve artifact refs first so the existing server-side artifact is
      // referenced, not redundantly uploaded as a native or browser file.
      if (dispatch.kind === "artifact-ref") {
        e.preventDefault();
        const name = dispatch.payload.path.split(/[/\\]/).pop() || "artifact";
        const item = addFocusedResource(
          { kind: "workspace-artifact", artifactId: dispatch.payload.artifactId },
          `@${name}`,
        );
        if (!item) {
          setAttachmentError("Reference limit reached. Send or remove items before adding more.");
        } else {
          const root = composerRootRef.current?.querySelector<HTMLElement>(
            "[data-nautilo-composer-input]",
          ) ?? null;
          const nextText = insertDroppedResourceDirective({
            text: composerTextRef.current,
            directive: serializeResourceDirective(item.entryId, item.label),
            root,
            point: { x: e.clientX, y: e.clientY },
            selectionOffset: currentComposerSelectionOffset(root),
          });
          composerTextRef.current = nextText;
          composerRuntime.setText(nextText);
          setAttachmentError(null);
        }
        return;
      }
      if (e.dataTransfer.files.length > 0) {
        if (!canWriteArtifacts) return;
        e.preventDefault();
        queueBrowserComposerFiles(e.dataTransfer.files);
        return;
      }
      if (dispatch.kind === "ignore") return;
      if (!auth.viewer.isVerified) return;
      e.preventDefault();
      // Internal Files-pane MIME is metadata-only focus. Deliberately do not
      // preflight, read bytes, or call either D271 upload helper here.
      void getDesktopRelayId().then((relayId) => {
        if (!relayId) {
          setAttachmentError("Desktop relay is unavailable; reconnect it before focusing local files.");
          return;
        }
        for (const file of flattenNautiloFileRefs(dispatch.payload)) {
          const name = file.path.split(/[/\\]/).pop() ?? "file";
          const item = addFocusedResource(
            { kind: "local-file", path: file.path, rootPath: file.rootPath, name, relayId },
            localFileFocusedResourceLabel(name),
          );
          if (!item) {
            setAttachmentError("Reference limit reached. Send or remove items before adding more.");
            break;
          }
          const root = composerRootRef.current?.querySelector<HTMLElement>(
            "[data-nautilo-composer-input]",
          ) ?? null;
          const nextText = insertDroppedResourceDirective({
            text: composerTextRef.current,
            directive: serializeResourceDirective(item.entryId, item.label),
            root,
            point: { x: e.clientX, y: e.clientY },
            selectionOffset: currentComposerSelectionOffset(root),
          });
          composerTextRef.current = nextText;
          composerRuntime.setText(nextText);
          setAttachmentError(null);
        }
      });
    },
    [auth.viewer.isVerified, canWriteArtifacts, composerRuntime, queueBrowserComposerFiles],
  );

  const handlePaperclipClick = useCallback(async () => {
    if (!canWriteArtifacts) return;
    if (!isDesktop || !desktopAPI) {
      browserAttachmentInputRef.current?.click();
      return;
    }
    setAttachmentError(null);
    setPickingAttachments(true);
    let pickedFiles: Array<{ name: string; sizeBytes: number; base64: string }>;
    try {
      pickedFiles = await desktopAPI.pickFiles();
    } catch {
      setAttachmentError("Could not open the file picker.");
      return;
    } finally {
      setPickingAttachments(false);
    }
    if (pickedFiles.length === 0) return;

    const skipped: ComposerChatAttachmentSkip[] = [];
    for (const file of pickedFiles) {
      const pf = preflightComposerChatAttachment(file.name);
      if (!pf.ok) {
        skipped.push(pf.skip);
        continue;
      }
      const id = newAttachmentId();
      const added = addAttachment({
        id,
        path: "",
        rootPath: "",
        name: file.name,
        sizeBytes: file.sizeBytes,
        status: "pending",
      });
      if (!added) {
        setAttachmentError("Attachment limit reached. Send or remove files before adding more.");
        break;
      }
      setAttachmentError(null);
      void uploadComposerAttachment(id, file, { roomId: activeRoomId });
    }
    if (skipped.length > 0) {
      const { title, message } = formatComposerAttachmentSkipToast(skipped);
      toast.show({ variant: "warning", title, message });
    }
  }, [activeRoomId, canWriteArtifacts, toast]);

  const handleBrowserAttachmentChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.currentTarget.files) queueBrowserComposerFiles(e.currentTarget.files);
    e.currentTarget.value = "";
  }, [queueBrowserComposerFiles]);

  const composerChromePad = tightLayout ? "px-3 py-2" : "px-4 py-3";
  const stopButtonTitle =
    voice.turnStopStatus.state === "queued"
      ? "Stopping when the turn starts"
      : voice.turnStopStatus.state === "stopping"
        ? "Stopping"
        : voice.turnStopStatus.state === "stopped"
          ? "Stopped"
        : canStopRoomWork
          ? "Stop"
          : "Nothing to stop";

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col">
      <FullAuthoredContextNotice />
      {askUserVisible ? (
        <AskUserPicker
          options={askUser.options}
          pendingContent={askUserPendingContent}
          memberByActorId={memberByActorId}
          onPick={handleAskUserPick}
          onDismiss={handleAskUserDismiss}
        />
      ) : null}
      {speech.permissionError && (
        <MicPermissionBanner
          message={speech.permissionError}
          canOpenSettings={
            typeof window !== "undefined" &&
            "nautiloDesktop" in window &&
            // Type-narrow from unknown — window.nautiloDesktop is our bridge.
            (window as { nautiloDesktop?: { platform?: string } }).nautiloDesktop?.platform === "darwin"
          }
        />
      )}
      {speech.sttError && (
        <div
          role="alert"
          className="mb-2 flex items-start gap-2 rounded-md border border-[var(--warning,#b58900)]/40 bg-[var(--warning,#b58900)]/10 px-3 py-2 text-xs text-foreground"
        >
          <span className="shrink-0" aria-hidden>
            ⚠
          </span>
          <span className="flex-1">{speech.sttError}</span>
        </div>
      )}
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root
        ref={composerRootRef}
        className={`relative flex flex-col gap-2 rounded-xl border border-border bg-background-element ${composerChromePad}`}
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
      >
        <RoomMentionTriggerPopover
          adapter={mentionAdapter}
          memberByHandle={memberByHandle}
        />
        {canInvokeAgents ? <ComposerPrimitive.Unstable_TriggerPopover
          char="/"
          adapter={commandAdapter}
          className="absolute bottom-full left-0 z-50 mb-2 max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-lg"
        >
          <ComposerPrimitive.Unstable_TriggerPopover.Directive
            formatter={commandSlashFormatter}
          />
          <ComposerPrimitive.Unstable_TriggerPopoverItems>
            {(items) => (
              <>
                {items.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-foreground-muted">
                    No matching commands.
                  </div>
                ) : (
                  items.map((item) => (
                    <ComposerPrimitive.Unstable_TriggerPopoverItem
                      key={item.id}
                      item={item}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors hover:bg-[var(--primary-muted)] focus:bg-[var(--primary-muted)] data-[highlighted]:bg-[var(--primary-muted)]"
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <CommandSuggestionRow item={item} />
                    </ComposerPrimitive.Unstable_TriggerPopoverItem>
                  ))
                )}
              </>
            )}
          </ComposerPrimitive.Unstable_TriggerPopoverItems>
        </ComposerPrimitive.Unstable_TriggerPopover> : null}
        {reply?.pendingReply ? (
          <div
            data-testid="composer-reply-preview"
            className="flex items-stretch gap-2 rounded-md border border-border bg-background px-2 py-1.5"
          >
            <span aria-hidden className="w-0.5 shrink-0 rounded-full bg-accent" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold text-accent">
                Replying to {reply.pendingReply.senderName}
              </div>
              <div className="truncate text-[11px] text-foreground-muted">
                {reply.pendingReply.snippet.length > 0
                  ? reply.pendingReply.snippet
                  : "(no text)"}
              </div>
            </div>
            <button
              type="button"
              onClick={() => reply.cancelReply()}
              aria-label="Cancel reply"
              className="flex h-5 w-5 shrink-0 items-center justify-center self-center rounded text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
            >
              <X aria-hidden="true" className="h-3 w-3" />
            </button>
          </div>
        ) : null}
        {attachments.length > 0 && (
          <AttachmentChipRow attachments={attachments} />
        )}
        {attachmentError && (
          <div className="text-[11px] text-error">
            {attachmentError}
          </div>
        )}
        <VoicePlaybackStopPill
          enabled={voice.enabled}
          playing={voice.playing}
          onStop={voice.stop}
        />
        <MentionAwareLexicalComposerInput
          autoFocus
          aria-label={`Message ${assistantName}`}
          placeholder={speech.isListening ? "Listening…" : `Message ${assistantName}…`}
          className="relative max-h-48 min-h-[1.5rem] w-full overflow-y-auto bg-transparent text-sm leading-relaxed outline-none [&_.aui-lexical-input]:min-h-[1.5rem] [&_.aui-lexical-input]:whitespace-pre-wrap [&_.aui-lexical-input]:break-words [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:text-foreground-disabled"
          // D057 2a.1 — stable selector hook for browser-column's file-
          // click → paste-into-composer flow. Placeholder-based selectors
          // miss when composer is in "Listening…" state.
          data-nautilo-composer-input
          submitMode="none"
          cancelOnEscape
          directiveChip={ComposerDirectiveChip}
          formatter={mentionAtHandleFormatter}
          onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            if (speech.isListening || speech.isTranscribing || showMic) return;
            e.preventDefault();
            void submitComposer();
          }}
        />
        {/* D371 — two-row composer: input row above; control bar below.
            Left cluster holds the model switcher (D371 R3); right cluster
            holds attach / emoji / stop / mic-send. */}
        <div className="flex items-center justify-between gap-2">
          <div data-testid="composer-left-cluster" className="flex items-center gap-2">
            {canInvokeAgents && !directHumanRoom ? (
              <ModelSwitcher roomId={activeRoomId} agentId={activeRoomAgentId} compact={tightLayout} />
            ) : null}
          </div>
          <div className="flex items-center gap-2">
        {canWriteArtifacts && (
          <>
          <input
            ref={browserAttachmentInputRef}
            type="file"
            multiple
            hidden
            onChange={handleBrowserAttachmentChange}
            aria-label="Choose files to attach"
          />
          <button
            type="button"
            disabled={pickingAttachments}
            onClick={() => void handlePaperclipClick()}
            title="Attach files"
            aria-label="Attach files"
            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted hover:bg-background-element hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
          >
            <Paperclip aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
          </button>
          </>
        )}
      {/* D278 §9.1 — emoji (functional) + stop. M147: STOP aborts every live
          job (main turn + forks) in this room via POST /api/jobs/:id/stop.
          Calls `voice.stopActiveJobs` directly (NOT assistant-ui's cancelRun,
          which mutates the message repository and corrupts our WS-owned list).
          Enabled only while a turn is running. */}
      <ComposerEmojiButton onSelect={insertEmoji} disabled={!canSend} />
      <button
        type="button"
        onClick={() => voice.stopActiveJobs()}
        disabled={!canStopRoomWork}
        title={stopButtonTitle}
        aria-label={stopButtonTitle}
        data-testid="composer-stop"
        className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground-muted hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <Square aria-hidden className="h-3.5 w-3.5 stroke-[1.75]" />
      </button>
      {speech.isTranscribing ? (
        <button
          type="button"
          disabled
          className="mb-0.5 shrink-0 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] opacity-60"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>Sending</span>
        </button>
      ) : speech.isListening ? (
        <button
          type="button"
          onClick={handleMicToggle}
          disabled={!canSend}
          title={sendDisabledTitle}
          className="mb-0.5 shrink-0 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] cursor-pointer hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
          <span>Send</span>
        </button>
      ) : showMic && !composerSendPending ? (
        <button
          type="button"
          onClick={handleMicToggle}
          disabled={!canSend}
          title={sendDisabledTitle ?? "Hold to talk"}
          className="mb-0.5 shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-[var(--on-primary)] cursor-pointer hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Mic className="h-4 w-4" />
        </button>
      ) : (
        <ComposerSendButton
          disabled={!canSubmitComposer}
          pending={composerSendPending}
          disabledTitle={sendDisabledTitle}
          onSend={() => void submitComposer()}
        />
      )}
          </div>
        </div>
      </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </div>
  );
}

function CommandSuggestionRow({
  item,
}: {
  item: Unstable_TriggerItem;
}): ReactElement {
  return (
    <div className="min-w-0 flex-1">
      <span className="font-medium text-foreground">/{item.id}</span>
      {item.description ? (
        <div className="truncate text-xs text-foreground-muted">
          {item.description}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Cursor-style chip row rendered above the composer textarea when the
 * user has queued file attachments (drag-and-drop from the Files /
 * Workspace tree). Each chip is an icon + filename + remove button;
 * the file bytes are NOT read here — the runtime reads them at send
 * time, so what ends up in the model's context is always the latest
 * version on disk.
 */
function AttachmentChipRow({
  attachments,
}: {
  attachments: readonly ComposerAttachment[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {attachments.map((att) => (
        <AttachmentChip key={att.id} attachment={att} />
      ))}
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: ComposerAttachment }) {
  const relLabel = relativeFromWorkspace(attachment.rootPath, attachment.path);
  const displayLabel = relLabel.length > 0 ? relLabel : attachment.name;
  const isError = attachment.status === "error";
  const statusLabel = isError
    ? `rejected: ${attachment.errorReason ?? "not sent"}`
    : attachment.status === "pending"
      ? "pending"
      : "ready"; // matched server send — not an upload progress state
  return (
    <span
      className={`flex max-w-[16rem] items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
        isError
          ? "border-error/50 bg-error/10 text-foreground"
          : "border-border bg-background text-foreground"
      }`}
      title={`${attachment.path}\n${statusLabel}`}
      data-testid="composer-attachment"
      data-path={attachment.path}
      data-status={attachment.status ?? "queued"}
    >
      <FileText aria-hidden="true" className="h-3 w-3 shrink-0 text-foreground-muted" />
      <span className="truncate">{displayLabel}</span>
      <span className="shrink-0 text-foreground-muted">· {statusLabel}</span>
      <button
        type="button"
        onClick={() => removeAttachment(attachment.id)}
        aria-label={`Remove ${attachment.name}`}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-foreground-muted hover:bg-[var(--primary-muted)] hover:text-foreground"
      >
        <X aria-hidden="true" className="h-3 w-3" />
      </button>
    </span>
  );
}

/**
 * D057 2a.5 — inline banner surfacing mic-permission errors from the
 * desktop TCC preflight. Shows above the composer with an optional
 * "Open System Settings" action on macOS. This is a temporary home:
 * once the workbench toast surface lands (D057 2a.10 / D059 Phase 3)
 * this lifts into the toast container and the inline banner goes away.
 */
function MicPermissionBanner(props: {
  message: string;
  canOpenSettings: boolean;
}) {
  const handleOpen = useCallback(() => {
    const w = window as { nautiloDesktop?: { media?: { openSystemMicSettings?: () => Promise<void> } } };
    void w.nautiloDesktop?.media?.openSystemMicSettings?.();
  }, []);

  return (
    <div
      role="alert"
      className="mb-2 flex items-start gap-2 rounded-md border border-[var(--warning,#b58900)]/40 bg-[var(--warning,#b58900)]/10 px-3 py-2 text-xs text-foreground"
    >
      <span className="shrink-0" aria-hidden>⚠</span>
      <span className="flex-1">{props.message}</span>
      {props.canOpenSettings && (
        <button
          type="button"
          onClick={handleOpen}
          className="shrink-0 rounded bg-background-element px-2 py-0.5 text-[0.7rem] font-medium text-foreground hover:bg-background underline-offset-2 hover:underline cursor-pointer"
        >
          Open Settings
        </button>
      )}
    </div>
  );
}

type AssistantMessageComponents = NonNullable<
  ComponentProps<typeof MessagePrimitive.Content>["components"]
>;

const userMessageComponents: AssistantMessageComponents = {
  Text: UserText,
};

const assistantComponents: AssistantMessageComponents = {
  Text: AssistantText,
  // D083 Phase 1 — ToolCard replaces the previous inline ToolCallCard.
  // Same assistant-ui fallback seam; the new component adds state
  // glyphs, live duration timer, keyboard accessibility, expanded
  // args + result sections, and cross-refs useToolActivity for
  // accurate WS-backed timestamps.
  tools: {
    // Codex can be dispatched through either the low-level `task` tool or the
    // preferred `in_background` shortcut. Both return the same deterministic
    // harness receipt, so both must enter the same live execution surface.
    by_name: harnessTaskToolRenderers,
    Fallback: ToolCard,
  },
};

function ConversationSystemRow(): React.ReactElement {
  const text = useMessage((s) => {
    const parts = s.content;
    if (!Array.isArray(parts)) return "";
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const po = part as { type?: string; text?: string };
      if (po.type === "text" && typeof po.text === "string") return po.text;
    }
    return "";
  });
  return (
    <div className="my-2 flex justify-center border-y border-dashed border-border/60 py-2">
      <span className="max-w-xl text-center text-[11px] italic text-foreground-muted">{text}</span>
    </div>
  );
}

type MessageByIdComponents = ComponentProps<
  typeof ThreadPrimitive.Unstable_MessageById
>["components"];

/**
 * D246 Wave 3 — thread-subscribing leaf that drives {@link TranscriptWindow}.
 *
 * This is intentionally a separate component from `ConversationBody`: it is the
 * only place that subscribes to the thread message list, so streaming token
 * updates (which mutate the messages array every frame) re-render just this
 * leaf + the bounded window math — never the whole conversation chrome. Rows
 * are mounted via assistant-ui's custom-list
 * `ThreadPrimitive.Unstable_MessageById`, preserving each row's full message
 * context (tool cards, reactions, edit/approval state) while keeping provider
 * identity aligned with the id-keyed measured wrapper across contractions.
 *
 * D246 Wave 3 regression fix — the count + per-index keys are sourced from
 * assistant-ui's SYNCHRONIZED AUI state (`useAuiState((s) => s.thread.messages)`),
 * mirroring upstream `ThreadPrimitive.Messages` (which subscribes to
 * `useAuiState((s) => s.thread.messages.length)`). The synchronized array IS
 * the thread client lookup's state, so its length always equals the lookup's
 * own length. During a room load/reset the legacy runtime thread
 * (`useThread((s) => s.messages)`) can be ahead of the synchronized lookup: the
 * runtime has seeded N messages but `tapClientLookup` inside `ThreadClient`
 * has not yet rebuilt. The former positional renderer sized off the runtime
 * count could then resolve index 0 through an empty lookup and throw
 * `tapClientLookup: Index 0 out of bounds (length: 0)`. Sizing off the
 * synchronized count keeps window geometry aligned with the lookup, while the
 * id-based provider keeps surviving row identity stable across deletion.
 * `isRunning` is sourced the same way (`useAuiState((s) => s.thread.isRunning)`)
 * so the tail-keep signal can never lead the lookup either.
 */
export function collectRoomSearchTextRanges(
  root: Element,
  query: string,
  mode: "prefix" | "whole",
  ignoreCase = true,
): Range[] {
  const terms = query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return [];
  const ranges: Range[] = [];
  const textNodes: Text[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      textNodes.push(node as Text);
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  for (const node of textNodes) {
    const text = node.textContent ?? "";
    for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
      const word = match[0].normalize("NFKC");
      const comparableWord = ignoreCase ? word.toLocaleLowerCase() : word;
      if (!terms.some((term) => {
        const comparableTerm = ignoreCase ? term.toLocaleLowerCase() : term;
        return mode === "prefix"
          ? comparableWord.startsWith(comparableTerm)
          : comparableWord === comparableTerm;
      })) continue;
      const start = match.index;
      const range = root.ownerDocument.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + match[0].length);
      ranges.push(range);
    }
  }
  return ranges;
}

function useRoomSearchTextHighlight(
  viewportRef: RefObject<HTMLElement | null>,
  searchHighlight: { messageId: number | null; query: string; mode: "prefix" | "whole"; ignoreCase: boolean } | undefined,
): void {
  const reactId = useId();
  const highlightName = useMemo(
    () => `nautilo-room-find-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );

  useEffect(() => {
    const css = globalThis.CSS as typeof CSS & {
      highlights?: { set(name: string, value: unknown): void; delete(name: string): boolean };
    };
    const HighlightConstructor = (globalThis as typeof globalThis & {
      Highlight?: new (...ranges: Range[]) => unknown;
    }).Highlight;
    const highlights = css?.highlights;
    if (!highlights || !HighlightConstructor) return;

    const style = document.createElement("style");
    style.textContent = `::highlight(${highlightName}) { background: color-mix(in srgb, var(--accent) 42%, transparent); color: inherit; }`;
    document.head.append(style);
    const apply = (): void => {
      highlights.delete(highlightName);
      const messageId = searchHighlight?.messageId;
      if (!messageId || !searchHighlight.query.trim()) return;
      const row = viewportRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (!row) return;
      const ranges = Array.from(row.querySelectorAll<HTMLElement>("[data-room-search-content]"))
        .flatMap((content) => collectRoomSearchTextRanges(
          content,
          searchHighlight.query,
          searchHighlight.mode,
          searchHighlight.ignoreCase,
        ));
      if (ranges.length > 0) highlights.set(highlightName, new HighlightConstructor(...ranges));
    };
    apply();
    const observer = new MutationObserver(apply);
    const viewport = viewportRef.current;
    if (viewport) observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      highlights.delete(highlightName);
      style.remove();
    };
  }, [highlightName, searchHighlight?.ignoreCase, searchHighlight?.messageId, searchHighlight?.mode, searchHighlight?.query, viewportRef]);
}

export function ConversationTranscript({
  assistantName,
  assistantAvatarSrc,
  roomId,
  viewportRef,
  handleRef,
  searchHighlight,
  interactiveMessages = true,
  reactionMessages = false,
  childMessageDeleteEnabled = false,
  childMessageEditEnabled = false,
  childMessageReplyEnabled = false,
  followIntent,
  viewportVisitId,
  onTranscriptCommit,
}: {
  assistantName: string;
  assistantAvatarSrc: string;
  roomId: string | null;
  viewportRef: RefObject<HTMLElement | null>;
  handleRef?: Ref<TranscriptWindowHandle>;
  searchHighlight?: {
    messageId: number | null;
    query: string;
    mode: "prefix" | "whole";
    ignoreCase: boolean;
  };
  interactiveMessages?: boolean;
  /** Enable only reactions for explicitly marked messages (subthread use). */
  reactionMessages?: boolean;
  /**
   * Enable the Delete action only for explicitly marked child-room rows while
   * preserving the prepended parent anchor as a non-interactive transcript row.
   */
  childMessageDeleteEnabled?: boolean;
  /** Enable author-only editing for marked child rows, never the parent anchor. */
  childMessageEditEnabled?: boolean;
  /** Enable D359 quote-reply only for marked child rows, never the anchor. */
  childMessageReplyEnabled?: boolean;
  /** Reader-owned follow intent supplied by the viewport shell. */
  followIntent?: boolean;
  /** Monotonic identity for the current main-conversation Room visit. */
  viewportVisitId?: number;
  /** Publishes stable message membership for scope-aware restore hydration. */
  onTranscriptCommit?: (
    scopeKey: string,
    visitId: number,
    messageIds: readonly string[],
  ) => void;
}): ReactElement {
  const messages = useAuiState((s) => s.thread.messages);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const followingLiveEdge = shouldConversationTranscriptFollowTail(followIntent);
  useRoomSearchTextHighlight(viewportRef, searchHighlight);

  const { count, keys, latestMessageId } = useMemo(
    () => deriveTranscriptSync(messages),
    [messages],
  );
  useLayoutEffect(() => {
    onTranscriptCommit?.(conversationViewportScopeKey(roomId), viewportVisitId ?? 0, keys);
  }, [keys, onTranscriptCommit, roomId, viewportVisitId]);
  const getItemKey = useCallback(
    (index: number): string => keys[index] ?? String(index),
    [keys],
  );

  // Stable per-role renderer for Unstable_MessageById. Re-created only when the
  // author identity / room changes (never per streamed token), so assistant-ui
  // can keep memoizing each mounted row by stable message id.
  const components = useMemo<MessageByIdComponents>(
    () => ({
      Message: function BoundMessage(): ReactElement {
        return (
          <Message
            assistantName={assistantName}
            assistantAvatarSrc={assistantAvatarSrc}
            roomId={roomId}
            interactive={interactiveMessages}
            reactionMessages={reactionMessages}
            childMessageDeleteEnabled={childMessageDeleteEnabled}
            childMessageEditEnabled={childMessageEditEnabled}
            childMessageReplyEnabled={childMessageReplyEnabled}
            latestMessageId={latestMessageId}
          />
        );
      },
    }),
    [
      assistantName,
      assistantAvatarSrc,
      childMessageDeleteEnabled,
      childMessageEditEnabled,
      childMessageReplyEnabled,
      interactiveMessages,
      latestMessageId,
      reactionMessages,
      roomId,
    ],
  );

  const dayStarts = useMemo(() => messageDayStarts(messages.map((message) => message.metadata.custom?.sentAt)), [messages]);
  const renderItem = useCallback(
    (index: number, id: string): ReactNode => {
      const sentAt = messages[index]?.metadata.custom?.sentAt;
      const date = validMessageSentAt(sentAt);
      const showDay = date && dayStarts.has(index);
      return <>
        {showDay && <div className="mx-2 my-4 flex items-center gap-3 text-[11px] text-foreground-muted" aria-label="Message date">
          <span className="h-px flex-1 bg-border" /><time dateTime={date.toISOString()}>{date.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric" })}</time><span className="h-px flex-1 bg-border" />
        </div>}
        <ThreadPrimitive.Unstable_MessageById messageId={id} components={components} />
      </>;
    },
    [components, messages, dayStarts],
  );

  return (
    <TranscriptWindow
      count={count}
      getItemKey={getItemKey}
      renderItem={renderItem}
      viewportRef={viewportRef}
      isRunning={isRunning}
      followingLiveEdge={followingLiveEdge}
      resetKey={roomId}
      handleRef={handleRef}
    />
  );
}

function Message({
  assistantName,
  assistantAvatarSrc,
  roomId,
  interactive = true,
  reactionMessages = false,
  childMessageDeleteEnabled = false,
  childMessageEditEnabled = false,
  childMessageReplyEnabled = false,
  latestMessageId,
}: {
  assistantName: string;
  assistantAvatarSrc: string;
  roomId: string | null;
  interactive?: boolean;
  reactionMessages?: boolean;
  childMessageDeleteEnabled?: boolean;
  childMessageEditEnabled?: boolean;
  childMessageReplyEnabled?: boolean;
  /** The synchronized canonical tail id; intentionally stable across tokens. */
  latestMessageId: string | null;
}) {
  const [contextMenu, setContextMenu] = useState<{
    messageId: number;
    x: number;
    y: number;
  } | null>(null);

  // IMPORTANT: each useMessage call must return a PRIMITIVE (or a
  // stable reference). Combining message metadata into one selector that
  // returns a fresh object
  // literal on every render → useSyncExternalStore treats every render
  // as a store change → infinite update loop (React error #185, "The
  // result of getSnapshot should be cached"). Pin: see conversation
  // crash on first turn render, 2026-05-18, Phase 10.D session-3.
  const messageId = useMessage((state) => {
    const n = Number(state.id);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  // A subthread prepends a parent-room anchor to a child-room transcript.
  // Only child rows carry this marker, so an equal numeric id can never make
  // an anchor reaction target the child Room.
  const childMessageEligible = useMessage((state) => {
    const custom = (state.metadata as { custom?: { subthreadReactionEligible?: unknown } })?.custom;
    return custom?.subthreadReactionEligible === true;
  });
  const reactionsEnabled = interactive || (reactionMessages && childMessageEligible);
  const childDeleteEnabled = childMessageDeleteEnabled && childMessageEligible;
  const childEditEnabled = childMessageEditEnabled && childMessageEligible;
  const childReplyEnabled = childMessageReplyEnabled && childMessageEligible;
  const replyCount = useMessage(
    (state) => (state.metadata as { custom?: { replyCount?: number } })?.custom?.replyCount ?? 0,
  );
  // D193 follow-up (Smoke-3) — resolve message author for multi-human
  // rooms. `sourceUserId` lives in `metadata.custom` and is set by the
  // runtime adapter when the WS `message.new` event or rehydrated history
  // carries it (server already plumbs it via D124). Default null = "viewer
  // is the author OR no peer label available" → render "You:" as before.
  const sourceUserId = useMessage((state) => {
    const c = (state.metadata as { custom?: { sourceUserId?: unknown } })?.custom;
    return typeof c?.sourceUserId === "string" ? c.sourceUserId : undefined;
  });
  const logicalKey = useMessage((state) => {
    const c = (state.metadata as { custom?: { logicalMessageKey?: unknown } })?.custom;
    return typeof c?.logicalMessageKey === "string" ? c.logicalMessageKey : null;
  });
  const editRevision = useMessage((state) => {
    const c = (state.metadata as { custom?: { editRevision?: unknown } })?.custom;
    return typeof c?.editRevision === "number" ? c.editRevision : 0;
  });
  const editedAt = useMessage((state) => {
    const c = (state.metadata as { custom?: { editedAt?: unknown } })?.custom;
    return typeof c?.editedAt === "string" ? c.editedAt : null;
  });
  const sendFailed = useMessage((state) => {
    const c = (state.metadata as { custom?: { sendFailed?: unknown } })?.custom;
    return c?.sendFailed === true;
  });
  // D424 — a card is rendered only from the server-authored, already
  // authorized pointer list. In particular, this does not inspect message
  // prose, composer focus state, or the legacy known-file mention registry.
  // The runtime owns the array identity, so returning it from the selector is
  // safe; do not map/filter here or useSyncExternalStore will loop on a fresh
  // snapshot for every render.
  const artifactOpenRefs = useMessage((state) => {
    return artifactOpenRefsFromMessageMetadata(state.metadata);
  });
  const terminalExecutions = useMessage((state) => {
    return terminalExecutionsFromMessageMetadata(state.metadata);
  });
  const sendFailureReason = useMessage((state) => {
    const c = (state.metadata as { custom?: { sendFailureReason?: unknown } })?.custom;
    return typeof c?.sendFailureReason === "string" && c.sendFailureReason.trim().length > 0
      ? c.sendFailureReason
      : null;
  });
  const peerLabel = useAuthorLabel(sourceUserId);
  const auth = useAuth();
  const toast = useToast();
  const can = useCan();
  const role = useMessage((state) => state.role);
  // D359 — inline quote-reply plumbing.
  const reply = useConversationReply();
  const members = useRoomMembers();
  const authorAgentId = useMessage((state) => {
    const c = (state.metadata as { custom?: { authorAgentId?: unknown } })?.custom;
    return typeof c?.authorAgentId === "string" ? c.authorAgentId : undefined;
  });
  const authorHarnessId = useMessage((state) => {
    const c = (state.metadata as { custom?: { authorHarnessId?: unknown } })?.custom;
    return typeof c?.authorHarnessId === "string" ? c.authorHarnessId : undefined;
  });
  const replyToMessageId = useMessage((state) => {
    const c = (state.metadata as { custom?: { replyToMessageId?: unknown } })?.custom;
    return typeof c?.replyToMessageId === "number" && Number.isInteger(c.replyToMessageId)
      ? c.replyToMessageId
      : null;
  });
  const highlighted = reply?.highlightedMessageId != null && reply.highlightedMessageId === messageId;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [editBaseRevision, setEditBaseRevision] = useState(0);
  const [editBaseContent, setEditBaseContent] = useState("");
  const [editConflictCurrent, setEditConflictCurrent] = useState<{
    content: string;
    editRevision: number;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [optimisticEditedText, setOptimisticEditedText] = useState<string | null>(null);
  const [optimisticEditedRevision, setOptimisticEditedRevision] = useState<
    number | null
  >(null);
  const messageRootRef = useRef<HTMLDivElement>(null);
  const focusMessageRoot = useCallback(() => {
    requestAnimationFrame(() => messageRootRef.current?.focus());
  }, []);
  // ISSUE-M172 §5/§6.6 — client-side affordance gate (advisory per M129; the
  // server's assertUserCanDeleteMessage is authoritative). Show Delete when it
  // is the caller's own user message, OR the caller holds manage_rooms. Never
  // on agent-authored (role !== "user") rows for non-admins.
  const isOwnUserMessage =
    role === "user" &&
    (sourceUserId == null || sourceUserId === auth.viewer.sessionUserId);
  const canDelete =
    (interactive || childDeleteEnabled) && (isOwnUserMessage || can("manage_rooms"));
  const performDelete = useCallback(async () => {
    setConfirmDelete(false);
    if (messageId === null || !roomId) return;
    try {
      await apiClient.deleteRoomMessage(roomId, String(messageId));
      // Removal is applied by the message.deleted WS echo (idempotent).
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        toast.show({
          variant: "warning",
          title: "Can't delete",
          message: "This message starts a thread. Delete the thread first.",
        });
      } else {
        toast.show({
          variant: "warning",
          title: "Delete failed",
          message: "Could not delete this message.",
        });
      }
    }
  }, [messageId, roomId, toast]);
  // D206 — author identity for the per-message avatar. When the
  // message has a `sourceUserId` (any peer in a multi-human room),
  // use that. Otherwise the message is the viewer's own optimistic
  // bubble or echoed-back send → use the viewer's session userId so
  // their own avatar shows next to "You:".
  const authorUserId = sourceUserId ?? auth.viewer.sessionUserId ?? "";
  const avatarLabel = peerLabel ?? "You";
  const { toggleReaction } = useRoomReactions();
  const editRoomMessage = useRoomMessageEdit();
  const {
    reactions: userReactions,
    animatedEmojis: userAnimatedEmojis,
    selfEmojis: userSelfEmojis,
  } = useMessageReactions(auth.viewer.sessionActorId);
  const userText = useMessage((state) => {
    const parts = state.content;
    if (!Array.isArray(parts)) return "";
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const po = part as { type?: string; text?: string };
      if (po.type === "text" && typeof po.text === "string") return po.text;
    }
    return "";
  });
  useEffect(() => {
    if (
      optimisticEditedText !== null &&
      optimisticEditedRevision !== null &&
      editRevision >= optimisticEditedRevision &&
      userText === optimisticEditedText
    ) {
      setOptimisticEditedText(null);
      setOptimisticEditedRevision(null);
    }
  }, [
    editRevision,
    optimisticEditedRevision,
    optimisticEditedText,
    userText,
  ]);
  const canEdit =
    (interactive || childEditEnabled) &&
    isOwnUserMessage &&
    messageId !== null &&
    logicalKey !== null &&
    !sendFailed &&
    userText.trim().length > 0;
  const beginEdit = useCallback(() => {
    const displayedText = optimisticEditedText ?? userText;
    setEditDraft(displayedText);
    setEditBaseRevision(optimisticEditedRevision ?? editRevision);
    setEditBaseContent(displayedText);
    setEditConflictCurrent(null);
    setEditError(null);
    setEditing(true);
  }, [
    editRevision,
    optimisticEditedRevision,
    optimisticEditedText,
    userText,
  ]);
  const cancelEdit = useCallback(() => {
    if (editSaving) return;
    setEditing(false);
    setEditDraft("");
    setEditConflictCurrent(null);
    setEditError(null);
    focusMessageRoot();
  }, [editSaving, focusMessageRoot]);
  const saveEdit = useCallback(async () => {
    if (!canEdit || editSaving || !roomId || messageId === null) return;
    if (editDraft.trim().length === 0) {
      setEditError("A message can't be empty.");
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      if (editRoomMessage === null) throw new Error("Message editing is unavailable.");
      const result = await editRoomMessage(
        roomId,
        String(messageId),
        {
          content: editDraft,
          expectedRevision: editBaseRevision,
        },
      );
      setOptimisticEditedText(result.content);
      setOptimisticEditedRevision(result.editRevision);
      setEditing(false);
      setEditDraft("");
      setEditConflictCurrent(null);
      focusMessageRoot();
    } catch (err) {
      if (err instanceof MessageEditConflictError) {
        setEditBaseRevision(err.current.editRevision);
        setEditBaseContent(err.current.content);
        setEditConflictCurrent({
          content: err.current.content,
          editRevision: err.current.editRevision,
        });
      }
      const status =
        err instanceof MessageEditConflictError
          ? 409
          : (err as { status?: number })?.status;
      setEditError(
        status === 409
          ? "This message changed elsewhere. Your draft is preserved; cancel and reopen to review it."
          : status === 403
            ? "This message can no longer be edited."
            : "Could not save this edit. Your draft is preserved.",
      );
    } finally {
      setEditSaving(false);
    }
  }, [
    canEdit,
    editBaseRevision,
    editDraft,
    editSaving,
    editRoomMessage,
    focusMessageRoot,
    messageId,
    roomId,
  ]);
  useEffect(() => {
    if (!editing) return;
    const resolution = remoteEditResolution({
      localBaseRevision: editBaseRevision,
      remoteRevision: editRevision,
      localDraft: editDraft,
      localBaseContent: editBaseContent,
    });
    if (resolution === "none") return;
    if (resolution === "close") {
      setEditing(false);
      setEditDraft("");
      setEditConflictCurrent(null);
      focusMessageRoot();
      return;
    }
    setEditBaseRevision(editRevision);
    setEditBaseContent(userText);
    setEditConflictCurrent({ content: userText, editRevision });
    setEditError(
      "This message changed elsewhere. Your draft is preserved; reconcile it before saving.",
    );
  }, [
    editBaseContent,
    editBaseRevision,
    editDraft,
    editRevision,
    editing,
    focusMessageRoot,
    userText,
  ]);
  const userEmojiOnly = isEmojiOnlyMessage(userText);

  // D359 — resolve THIS message's author + snippet so replying to it can show
  // "Replying to <sender>" + a 1-line preview. Assistant snippets strip the
  // <result>/<answer> artifact markers like the bubble body does.
  const currentSenderName =
    role === "assistant"
      ? resolveAssistantAuthorLabel({
          authorAgentId,
          authorHarnessId,
          members,
          viewerUserId: auth.viewer.sessionUserId,
          fallbackName: assistantName,
          fallbackAvatarSrc: assistantAvatarSrc,
          roomId,
        }).name
      : (peerLabel ?? "You");
  const currentSnippet = makeReplySnippet(
    role === "assistant" ? stripAssistantArtifacts(userText) : userText,
  );
  const beginReplyToThis = useMemo(
    () =>
      reply && messageId !== null && (interactive || childReplyEnabled)
        ? () =>
            reply.beginReply({
              targetId: messageId,
              senderName: currentSenderName,
              snippet: currentSnippet,
            })
        : undefined,
    [
      childReplyEnabled,
      currentSenderName,
      currentSnippet,
      interactive,
      messageId,
      reply,
    ],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (messageId === null) return;
      event.preventDefault();
      setContextMenu({ messageId, x: event.clientX, y: event.clientY });
    },
    [messageId],
  );

  // A keyboard user can reach the secondary action route without a pointer.
  // Only handle the message root itself so an
  // inline editor retains its existing Enter/Escape behavior.
  const handleContextMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const isContextMenuKey = event.key === "ContextMenu";
      const isShiftF10 = event.key === "F10" && event.shiftKey;
      if ((!isContextMenuKey && !isShiftF10) || event.target !== event.currentTarget) return;
      if (messageId === null) return;
      event.preventDefault();
      const rect = messageRootRef.current?.getBoundingClientRect();
      setContextMenu({
        messageId,
        x: rect ? Math.round(rect.left + Math.min(rect.width, 12)) : 0,
        y: rect ? Math.round(rect.top + Math.min(rect.height, 12)) : 0,
      });
    },
    [messageId],
  );

  // D367 — "Copy message" copies the FULL message text (all text parts,
  // not the first-part-only snippet). Assistant text is stripped of the
  // `<result>`/`<answer>` scaffold so the clipboard matches the rendered
  // bubble. Empty-after-strip messages expose no copy affordance.
  const fullMessageText = useMessage((state) => extractFullMessageText(state.content));
  const copyText = humanMentionDirectivesToPlainText(
    role === "assistant" ? stripAssistantArtifacts(fullMessageText) : fullMessageText,
  ).trim();
  const canCopy = copyText.length > 0;
  // A subthread prepends a non-interactive parent anchor. It may be textual,
  // but is not a child-room message and must not receive a child action rail
  // or context route.
  const canCopyInSurface = canCopy && (interactive || childMessageEligible);
  const handleCopyMessage = useCallback(() => {
    if (!copyText) return;
    void copyTextToClipboard(copyText).then((ok) => {
      toast.show(
        ok
          ? { variant: "success", message: "Message copied to clipboard." }
          : { variant: "warning", message: "Copy failed — select the text manually." },
      );
    });
  }, [copyText, toast]);

  // Retain the existing handler construction for the secondary context route,
  // while the primary rail is driven by the shared client-neutral action
  // contract below.
  const openThread = useOpenThread();
  const messageActions = useMemo(
    () => {
      if (messageId === null) return [];
      if (!interactive) {
        // A subthread never gets a nested-thread action, but Copy / Reply /
        // authorized mutation actions remain available in its context route.
        return buildMessageActions({
          ...(beginReplyToThis
            ? { reply: { enabled: true, onReply: beginReplyToThis } }
            : {}),
          ...(canCopyInSurface ? { onCopy: handleCopyMessage } : {}),
          ...(canEdit ? { onEdit: beginEdit } : {}),
          ...(canDelete && roomId
            ? { onDelete: () => setConfirmDelete(true) }
            : {}),
        });
      }
      return buildMessageActions({
        ...(roomId
          ? { onOpenThread: () => void openThread(roomId, messageId) }
          : {}),
        ...(beginReplyToThis
          ? { reply: { enabled: true, onReply: beginReplyToThis } }
          : {}),
        ...(canCopyInSurface ? { onCopy: handleCopyMessage } : {}),
        ...(canEdit ? { onEdit: beginEdit } : {}),
        ...(canDelete && roomId
          ? { onDelete: () => setConfirmDelete(true) }
          : {}),
      });
    },
    [
      messageId,
      openThread,
      beginReplyToThis,
      canCopyInSurface,
      handleCopyMessage,
      canEdit,
      beginEdit,
      canDelete,
      interactive,
      roomId,
    ],
  );
  const railDescriptors = useMemo<readonly MessageActionDescriptor[]>(
    () =>
      getMessageActionDescriptors({
        surface: interactive ? "room" : "subthread",
        capabilities: {
          reply: Boolean(beginReplyToThis),
          react: reactionsEnabled && messageId !== null,
          // Once replies exist, their count is the direct thread-entry action;
          // rendering a second thread icon beside it would be redundant.
          replyInThread: interactive && messageId !== null && replyCount === 0,
          copy: canCopyInSurface,
          edit: canEdit,
          delete: Boolean(canDelete && roomId),
        },
      }),
    [
      beginReplyToThis,
      canCopyInSurface,
      canDelete,
      canEdit,
      interactive,
      messageId,
      reactionsEnabled,
      replyCount,
      roomId,
    ],
  );
  const isLatestMessage = messageId !== null && String(messageId) === latestMessageId;
  const hasSecondaryContextMenu = messageActions.length > 0;
  const threadReplyAffordance =
    interactive && messageId !== null ? (
      <ParentMessageReplyAffordance
        parentRoomId={roomId}
        messageId={messageId}
        replyCount={replyCount}
      />
    ) : null;
  // Reserve this slot from the first row render, even while the message is
  // optimistic/streaming. The rail itself is only active for a numeric id.
  const messageActionRail = (
    <MessageActionRail
      descriptors={railDescriptors}
      alwaysVisible={isLatestMessage}
      leading={threadReplyAffordance}
      onReact={(emoji) => {
        if (messageId !== null) {
          toggleReaction(messageId, emoji, userSelfEmojis.has(emoji));
        }
      }}
      onReply={beginReplyToThis ?? (() => undefined)}
      onReplyInThread={() => {
        if (messageId !== null && roomId) void openThread(roomId, messageId);
      }}
      onCopy={handleCopyMessage}
      onEdit={beginEdit}
      onDelete={() => setConfirmDelete(true)}
    />
  );

  // The fixed 32px action slot is the inter-message gutter. Avoid adding a
  // second 16px margin below it: that made short exchanges read like separate
  // sections even when an older row's rail was hidden.
  return (
    <>
      <MessagePrimitive.Root
        ref={messageRootRef}
        tabIndex={railDescriptors.length > 0 ? 0 : -1}
        className={`group relative mx-auto mb-0 w-full max-w-5xl rounded-lg px-2 ${
          highlighted
            ? "bg-accent/10 ring-2 ring-accent/40 transition-colors duration-500"
            : "transition-colors duration-500"
        }`}
        onContextMenu={hasSecondaryContextMenu ? handleContextMenu : undefined}
        onKeyDown={hasSecondaryContextMenu ? handleContextMenuKeyDown : undefined}
      >
        <MessagePrimitive.If user>
          <div className="flex items-start gap-2">
            {authorUserId.length > 0 ? (
              <UserAvatar userId={authorUserId} size={24} displayName={avatarLabel} />
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span
                className={
                  peerLabel !== null
                    ? "text-xs font-semibold text-foreground-muted"
                    : "text-xs font-semibold text-label-user"
                }
              >
                {peerLabel !== null ? peerLabel : "You"}
              </span>
              <MessageTimestamp />
              </div>
              {replyToMessageId !== null ? (
                <div className="mt-0.5">
                  <QuotedReplyStrip parentId={replyToMessageId} assistantName={assistantName} />
                </div>
              ) : null}
              {editing ? (
                <div className="mt-1">
                  <textarea
                    autoFocus
                    value={editDraft}
                    disabled={editSaving}
                    aria-label="Edit message"
                    onChange={(event) => setEditDraft(event.target.value)}
                    onKeyDown={(event) => {
                      const action = inlineEditKeyAction({
                        key: event.key,
                        shiftKey: event.shiftKey,
                        isComposing: event.nativeEvent.isComposing,
                      });
                      if (action === "cancel") {
                        event.preventDefault();
                        cancelEdit();
                        return;
                      }
                      if (action === "save") {
                        event.preventDefault();
                        void saveEdit();
                      }
                    }}
                    className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                  />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-xs text-foreground-muted">
                      Enter to save · Shift+Enter for a new line · Esc to cancel
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={editSaving}
                        onClick={cancelEdit}
                        className="rounded px-2 py-1 text-xs text-foreground-muted hover:bg-background-element disabled:opacity-50"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={editSaving || editDraft.trim().length === 0}
                        onClick={() => void saveEdit()}
                        className="rounded bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {editSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                  {editError ? (
                    <div role="alert" className="mt-1 text-xs text-red-500">
                      {editError}
                    </div>
                  ) : null}
                  {editConflictCurrent ? (
                    <div className="mt-1 rounded border border-border bg-background px-2 py-1 text-xs text-foreground-muted">
                      <span className="font-medium text-foreground">
                        Current message:
                      </span>{" "}
                      <span className="whitespace-pre-wrap">
                        {editConflictCurrent.content}
                      </span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <div
                    data-room-search-content
                    className={`mt-0.5 ${sendFailed ? "text-foreground-muted opacity-70" : "text-foreground"} ${userEmojiOnly ? "emoji-message-pop text-6xl leading-none" : "text-sm"}`}
                  >
                    <HumanMessageContent>{optimisticEditedText !== null ? (
                      <span className="whitespace-pre-wrap">{optimisticEditedText}</span>
                    ) : (
                      <MessagePrimitive.Content components={userMessageComponents} />
                    )}</HumanMessageContent>
                  </div>
                  {editedAt !== null || optimisticEditedText !== null ? (
                    <div className="mt-0.5 text-[11px] text-foreground-muted">edited</div>
                  ) : null}
                </>
              )}
              <MessageArtifactOpenCards artifacts={artifactOpenRefs} />
              <TerminalExecutionNotices summaries={terminalExecutions} />
              {sendFailed ? (
                <div className="mt-1 text-xs text-foreground-muted">
                  Didn't get through
                  {sendFailureReason ? `: ${sendFailureReason}` : ""}
                </div>
              ) : reactionsEnabled ? (
                <ReactionStrip
                  reactions={userReactions}
                  animatedEmojis={userAnimatedEmojis}
                  selfEmojis={userSelfEmojis}
                  onToggle={
                    messageId !== null
                      ? (emoji) =>
                          toggleReaction(messageId, emoji, userSelfEmojis.has(emoji))
                      : undefined
                  }
                  />
                ) : null}
              {messageActionRail}
            </div>
          </div>
        </MessagePrimitive.If>
        <MessagePrimitive.If assistant>
          <AssistantBubble
            assistantName={assistantName}
            avatarSrc={assistantAvatarSrc}
            roomId={roomId}
            replyParentId={replyToMessageId}
            interactive={interactive}
            reactionsEnabled={reactionsEnabled}
          />
          <div className="ml-8">{messageActionRail}</div>
        </MessagePrimitive.If>
        <MessagePrimitive.If system>
          <div className="contents" data-room-search-content>
            <ConversationSystemRow />
          </div>
        </MessagePrimitive.If>
      </MessagePrimitive.Root>
      {contextMenu && (
        <ThreadContextMenu
          parentRoomId={roomId}
          messageId={contextMenu.messageId}
          anchorX={contextMenu.x}
          anchorY={contextMenu.y}
          onClose={() => setContextMenu(null)}
          surface={interactive ? "room" : "subthread"}
          {...(beginReplyToThis
            ? {
                replyPreview: { senderName: currentSenderName, snippet: currentSnippet },
                onReply: beginReplyToThis,
              }
            : {})}
          {...(canCopyInSurface ? { onCopy: handleCopyMessage } : {})}
          {...(canEdit ? { onEdit: beginEdit } : {})}
          {...(canDelete && roomId ? { onDelete: () => setConfirmDelete(true) } : {})}
        />
      )}
      {(interactive || childDeleteEnabled) && confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setConfirmDelete(false)}
        >
          <div
            className="w-[320px] rounded-lg border border-border bg-background p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-foreground">Delete message?</div>
            <div className="mt-1 text-xs text-foreground-muted">
              This permanently removes the message for everyone. This can't be undone.
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded px-3 py-1.5 text-sm text-foreground hover:bg-[var(--primary-muted)]"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-red-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-600"
                onClick={() => void performDelete()}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * D087 UX hotfix — suppress empty assistant bubbles.
 *
 * Context: `stripAssistantArtifacts` removes `<result></result>` /
 * `<answer></answer>` / etc. tag markers from Claude's output.
 * Sometimes the ONLY content in an assistant message is that tag pair
 * wrapping whitespace — after stripping, the message is empty, but
 * the surrounding agent label and bubble still render because
 * assistant-ui doesn't know the body is whitespace-only. The user
 * saw an agent label followed by nothing, which read as the assistant
 * starting to speak and then freezing mid-sentence.
 *
 * Fix: pull the raw message content via `useMessage`, run the same
 * stripping over any text parts, and return null if the combined
 * stripped body is empty / whitespace-only. Non-text parts (tool
 * calls, attachments) always count as "has content" — a tool-card
 * bubble is never empty even if it has no prose next to it.
 */
function AssistantBubble({
  assistantName,
  avatarSrc,
  roomId,
  replyParentId,
  interactive = true,
  reactionsEnabled = interactive,
}: {
  assistantName: string;
  avatarSrc: string;
  roomId: string | null;
  replyParentId?: number | null;
  interactive?: boolean;
  reactionsEnabled?: boolean;
}): React.ReactElement | null {
  const isEmptyAfterStrip = useMessage((state) => {
    const parts = state.content;
    if (!Array.isArray(parts) || parts.length === 0) {
      // No parts yet (streaming) — don't render the bubble until we know
      // there's something to show. Streaming text parts arrive with
      // real content the moment the first token lands.
      return true;
    }
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const partObj = part as { type?: string; text?: string };
      // Non-text parts are always meaningful: tool-call cards, files,
      // sources, etc. If any of those exist, the bubble has content.
      if (partObj.type !== "text") return false;
      const raw = typeof partObj.text === "string" ? partObj.text : "";
      const stripped = stripAssistantArtifacts(raw).trim();
      if (stripped.length > 0) return false;
    }
    return true;
  });

  if (isEmptyAfterStrip) return null;

  return (
    <AssistantBubbleInner
      assistantName={assistantName}
      avatarSrc={avatarSrc}
      roomId={roomId}
      replyParentId={replyParentId}
      interactive={interactive}
      reactionsEnabled={reactionsEnabled}
    />
  );
}

/**
 * R4 — in-transcript agent avatar that doubles as a Conversational Focus
 * toggle. Reads the SHARED room focus (RoomFocusProvider) so clicking here
 * lights up identically in the Members panel, and vice-versa. Isolated as its
 * own leaf so the per-second focus tick re-renders only this 24px button, not
 * the surrounding message content.
 */
function ChatAgentFocusAvatar({
  botActorId,
  avatarSrc,
  name,
}: {
  botActorId: string;
  avatarSrc: string;
  name: string;
}): React.ReactElement {
  const focus = useRoomFocusContext();
  const isTarget = focus.isTarget(botActorId);
  const isHeld = focus.isHeld(botActorId);
  const busy = focus.isBusy(botActorId);
  const expiringSoon = focus.isExpiringSoon(botActorId);
  const remainingFraction = focus.remainingFraction(botActorId);
  const secondsLeft = focus.secondsLeft(botActorId);
  const focused = remainingFraction != null;
  const tooltip = focusTooltipLabel(name, focus.reasonFor(botActorId));
  const ring = isTarget
    ? `ring-2 ring-primary ring-offset-1 ring-offset-background${focus.isExpiringSoon(botActorId) ? " animate-pulse" : ""}`
    : "";
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => focus.toggle(botActorId)}
      title={tooltip}
      aria-label={isTarget ? `Clear focus on ${name}` : `Focus on ${name}`}
      data-testid="chat-agent-focus-avatar"
      data-actor-id={botActorId}
      data-focus-state={isTarget ? "target" : isHeld ? "held" : "none"}
      className={`relative mt-0.5 h-6 w-6 shrink-0 rounded-full disabled:cursor-wait disabled:opacity-50 ${ring}`}
    >
      <AuthenticatedAvatar
        src={avatarSrc}
        alt={name}
        className="h-6 w-6 rounded-full object-cover"
        fallback={
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-background-element text-[10px] font-medium text-foreground-muted">
            {name.charAt(0).toUpperCase()}
          </span>
        }
      />
      {focused ? (
        <FocusCountdownRing
          remainingFraction={remainingFraction}
          expiringSoon={expiringSoon}
          secondsLeft={secondsLeft}
        />
      ) : null}
      {isHeld ? (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-background bg-primary/70"
        />
      ) : null}
    </button>
  );
}

function AssistantBubbleInner({
  assistantName,
  avatarSrc,
  roomId,
  replyParentId,
  interactive = true,
  reactionsEnabled = interactive,
}: {
  assistantName: string;
  avatarSrc: string;
  roomId: string | null;
  replyParentId?: number | null;
  interactive?: boolean;
  reactionsEnabled?: boolean;
}): React.ReactElement {
  const members = useRoomMembers();
  const auth = useAuth();
  const can = useCan();
  const messageId = useMessage((state) => {
    const n = Number(state.id);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const { toggleReaction } = useRoomReactions();
  const { reactions, animatedEmojis, selfEmojis } = useMessageReactions(
    auth.viewer.sessionActorId,
  );
  const authorAgentId = useMessage((state) => {
    const c = (state.metadata as { custom?: { authorAgentId?: unknown } })?.custom;
    return typeof c?.authorAgentId === "string" ? c.authorAgentId : undefined;
  });
  const authorHarnessId = useMessage((state) => {
    const c = (state.metadata as { custom?: { authorHarnessId?: unknown } })?.custom;
    return typeof c?.authorHarnessId === "string" ? c.authorHarnessId : undefined;
  });
  // D570 — ask_peer questions are assistant-authored messages, but their
  // document cards use the same server-authorized metadata lane as ordinary
  // human focus sends. Never infer an attachment from the assistant's prose.
  const artifactOpenRefs = useMessage((state) => {
    return artifactOpenRefsFromMessageMetadata(state.metadata);
  });
  const author = resolveAssistantAuthorLabel({
    authorAgentId,
    authorHarnessId,
    members,
    viewerUserId: auth.viewer.sessionUserId,
    fallbackName: assistantName,
    fallbackAvatarSrc: avatarSrc,
    roomId,
  });
  // R4 / D300 — focus the authoring agent when message metadata identifies it.
  // Single-agent rooms keep the legacy fallback even when old messages have no
  // `authorAgentId`.
  const soleAgentActorId = useMemo(() => {
    const agents = members.filter((m) => m.kind === "agent");
    return agents.length === 1 ? agents[0].actorId : null;
  }, [members]);
  const focusActorId = authorHarnessId ? null : (author.actorId ?? soleAgentActorId);
  return (
    <div className="flex items-start gap-2">
      {interactive && can("invoke_agents") && focusActorId ? (
        <ChatAgentFocusAvatar
          botActorId={focusActorId}
          avatarSrc={author.avatarSrc}
          name={author.name}
        />
      ) : (
        <AuthenticatedAvatar
          src={author.avatarSrc}
          alt={author.name}
          className="mt-0.5 h-6 w-6 shrink-0 rounded-full object-cover"
          fallback={
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background-element text-[10px] font-medium text-foreground-muted">
              {author.name.charAt(0).toUpperCase()}
            </span>
          }
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-xs font-semibold text-label-assistant">
            {author.name}:
          </span>
          {author.ownerCue ? (
            <span className="text-[11px] font-medium text-foreground-muted">
              {author.ownerCue}
            </span>
          ) : null}
          <MessageTimestamp />
        </div>
        {replyParentId != null ? (
          <div className="mt-1 pl-2">
            <QuotedReplyStrip parentId={replyParentId} assistantName={assistantName} />
          </div>
        ) : null}
        <div className="mt-1 pl-2" data-room-search-content>
          <MessagePrimitive.Content components={assistantComponents} />
        </div>
        <div className="pl-2">
          <MessageArtifactOpenCards artifacts={artifactOpenRefs} />
        </div>
        {reactionsEnabled ? <div className="pl-2">
          <ReactionStrip
            reactions={reactions}
            animatedEmojis={animatedEmojis}
            selfEmojis={selfEmojis}
            onToggle={
              messageId !== null
                ? (emoji) => toggleReaction(messageId, emoji, selfEmojis.has(emoji))
                : undefined
            }
          />
        </div> : null}
      </div>
    </div>
  );
}

type MarkdownTextContainerProps = HTMLAttributes<HTMLDivElement> & {
  "data-status"?: string;
};

const MarkdownTextContainer = forwardRef<HTMLDivElement, MarkdownTextContainerProps>(
  function MarkdownTextContainer({ "data-status": _status, ...props }, ref) {
    return <div ref={ref} {...props} />;
  },
);

export function UserText() {
  return (
    <div className="prose prose-sm max-w-none text-sm dark:prose-invert prose-p:my-0 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1 prose-headings:my-2">
      <MarkdownTextPrimitive
        containerComponent={MarkdownTextContainer}
        remarkPlugins={[remarkGfm]}
        smooth={false}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      />
    </div>
  );
}

function AssistantText() {
  const knownFiles = useKnownFileRefs();
  const { activeRoomId } = useRoomNavigation();
  const shouldSmooth = useMessage((state) => {
    return shouldSmoothAssistantMarkdown(state.id);
  });
  const rawText = useMessage((state) => {
    const parts = state.content;
    if (!Array.isArray(parts)) return "";
    return parts
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const po = part as { type?: string; text?: string };
        return po.type === "text" && typeof po.text === "string" ? po.text : "";
      })
      .join("\n");
  });
  const emojiOnly = isEmojiOnlyMessage(stripAssistantArtifacts(rawText));
  // D322 — only auto-linkify once the message has stopped smoothing. Linkifying
  // mid-stream rewrites already-streamed text (a partial `artifacts/lev…`
  // becomes a full `[…](#nautilo-file:…)` link), which breaks the smooth
  // animation's monotonic-append assumption and re-animates the message once
  // per link. Plain text while streaming → links resolve in one pass at
  // completion (shouldSmooth flips false on the reconciled numeric id).
  const preprocess = useCallback(
    (text: string) => {
      const stripped = stripAssistantArtifacts(text);
      return shouldSmooth ? stripped : linkKnownFileMentions(stripped, knownFiles);
    },
    [knownFiles, shouldSmooth],
  );
  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element | null)?.closest("a");
    if (!anchor) return;
    const filePath = decodeKnownFileHref(anchor.getAttribute("href") ?? "");
    if (!filePath) return;
    const ref = getKnownFileRef(filePath);
    if (!ref) return;
    event.preventDefault();
    requestOpenFile(openTargetForKnownRef(ref, activeRoomId));
  }, [activeRoomId]);
  return (
    <div
      className={
        emojiOnly
          ? "emoji-message-pop text-6xl leading-none prose max-w-none dark:prose-invert prose-p:!my-0 prose-p:!text-inherit"
          : "text-sm prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1 prose-headings:my-2"
      }
      onClick={onClick}
    >
      <AssistantMarkdownTextPrimitive
        preprocess={preprocess}
        smooth={shouldSmooth}
      />
    </div>
  );
}
