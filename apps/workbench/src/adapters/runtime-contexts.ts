import { createContext, useContext } from "react";
import type { DesktopBrowserResearchIntervention } from "../lib/desktop";
import type {
  ConnectedWebActionAttention,
  ConnectedWebActionResumeFailed,
} from "./connected-web-action-attention";
import type {
  ApprovalAskReason,
  ApprovalAskNetworkContext,
  ApprovalReplyVerb,
  ApprovalScopeInfo,
  LocalMcpInstallApproval,
  MediaGenerationApproval,
  StructuredSshApproval,
  CodexRequestEvent,
  CodexRequestResponse,
  CodexRoomRequestList,
  ChatSearchConversationHit,
  ChatSearchMessageHit,
  ChatSearchOptions,
  ChatSearchPage,
  ChatFocusedResourceRef,
  ProveItToolInfo,
  RoomMessageSearchCursor,
  RoomMessageSearchHit,
  RoomMessageSearchMode,
  RoomMessageSearchOptions,
  RoomMessageSearchPage,
} from "@nautilo/types";
import type { ServerEvent } from "@nautilo/types";
import type {
  RunningSubagent,
  SubagentHeartbeat,
} from "../modes/rooms/subagents/running-subagents-model";
import type { RuntimeShellState } from "./runtime-shell-state";
import type { RoomInitialHydrationState } from "./room-initial-hydration";
import { unavailableRoomMessageOperations, type RoomMessageOperations } from "./room-message-operations";

export const RoomMessageOperationsContext = createContext<RoomMessageOperations>(
  unavailableRoomMessageOperations,
);

export function useRoomMessageOperations(): RoomMessageOperations {
  return useContext(RoomMessageOperationsContext);
}

// ---------- Child-room event routing (D426) ----------

/**
 * The main runtime owns the one authenticated WebSocket. A visible thread
 * drawer registers its single child room here; it never creates a second
 * socket or reaches out through a browser-global event bridge.
 */
export type ThreadRoomLaneResolver = (laneKey: string) => string | null;

export interface ThreadRoomRegistration {
  roomId: string;
  /** Parent lane mirrored only for an edit of the displayed anchor. */
  parentRoomId?: string;
  anchorLogicalMessageKey?: string;
  ingestEvent: (event: ServerEvent, resolveRoomId: ThreadRoomLaneResolver) => void;
  /** Allows lane-less job terminals only when this controller already knows the job. */
  ownsJobId: (jobId: string) => boolean;
}

export interface ThreadRoomEventRouter {
  registerThreadRoom: (registration: ThreadRoomRegistration) => () => void;
}

const noThreadRoomRegistration = (): (() => void) => () => {};

export const ThreadRoomEventRouterContext = createContext<ThreadRoomEventRouter>({
  registerThreadRoom: noThreadRoomRegistration,
});

export function useThreadRoomEventRouter(): ThreadRoomEventRouter {
  return useContext(ThreadRoomEventRouterContext);
}

const CHILD_ROOM_EVENT_TYPES = new Set<ServerEvent["type"]>([
  "message.new",
  "message.updated",
  "message.tokens",
  "message.deleted",
  "reaction.added",
  "reaction.removed",
  "job.dispatched",
  "job.status",
  "job.progress",
  "tool.start",
  "tool.end",
  "tool.run_shell.progress",
  "tool.structured_ssh.progress",
  "approval.ask",
  "approval.resolved",
  "prove_it.challenge",
]);

/**
 * Fail-closed admission before the parent runtime's active-room gate. Parent
 * frames cannot enter the child controller, and no lane-less frame is
 * broadcast into it. The narrow job-terminal exception supports older server
 * frames only after the child controller established correlation itself.
 */
export function shouldRouteEventToThreadRoom(
  registration: ThreadRoomRegistration,
  event: ServerEvent,
  resolveRoomId: ThreadRoomLaneResolver,
): boolean {
  if (!CHILD_ROOM_EVENT_TYPES.has(event.type)) return false;
  if ("laneKey" in event && typeof event.laneKey === "string") {
    const roomId = resolveRoomId(event.laneKey);
    if (
      event.type === "message.updated" &&
      roomId === registration.parentRoomId &&
      event.logicalMessageKey === registration.anchorLogicalMessageKey
    ) {
      return true;
    }
    return roomId === registration.roomId;
  }
  return (
    (event.type === "job.status" || event.type === "job.progress") &&
    registration.ownsJobId(event.jobId)
  );
}

/**
 * Focus remains owned by the shared room-focus hook rather than the child
 * transcript controller. Admit only the displayed child's focus signal so the
 * runtime can publish it to that hook before the active-parent gate drops it.
 */
export function shouldPublishThreadRoomFocusEvent(
  registration: ThreadRoomRegistration,
  event: ServerEvent,
  resolveRoomId: ThreadRoomLaneResolver,
): event is Extract<ServerEvent, { type: "conductor.focus_changed" }> {
  return event.type === "conductor.focus_changed" &&
    event.roomId === registration.roomId &&
    resolveRoomId(event.laneKey) === registration.roomId;
}

/**
 * Shared context plumbing for the Nautilo runtime.
 *
 * These live in their own module (separate from `nautilo-runtime.tsx`) because
 * React Fast Refresh only supports modules that export COMPONENTS. A module
 * that mixes a component export (`NautiloRuntimeProvider`) with non-component
 * exports (hooks, types, contexts) cannot be Fast-Refreshed, and any hot
 * update that touches the dependency chain invalidates the whole tree —
 * which triggers a subtree unmount + remount (D080).
 *
 * Keep this file free of React component exports.
 */

// ---------- WebSocket transport state ----------

// M058 — `"authenticating"` covers the WS first-frame auth handshake
// window. Existing consumers branched on `=== "open"` for "really
// connected"; that semantic is preserved (we only fire `"open"`
// after the server's `auth.accepted`). UI surfaces (disconnect
// banner, ws dot) treat `"authenticating"` as "still connecting".
export type WsTransportState =
  | "connecting"
  | "authenticating"
  | "open"
  | "closed";

/**
 * Internal alias retained for readability inside the provider — same values
 * as WsTransportState, kept for the provider's internal state.
 */
export type WsState = WsTransportState;

/** Snapshot exposed to consumers via WsStateContext. */
export interface WsStateSnapshot {
  state: WsState;
  /** Epoch ms of the last time state was "open", or null if never. */
  lastOpenAt: number | null;
}

export const WsStateContext = createContext<WsStateSnapshot>({
  state: "closed",
  lastOpenAt: null,
});

export function useWsStateContext(): WsStateSnapshot {
  return useContext(WsStateContext);
}

// ---------- Protected Room coverage (M301) ----------

export type ProtectedRoomCoverageState = "ready" | "waiting";

export interface ProtectedRoomAccessSnapshot {
  stateForRoom(roomId: string): ProtectedRoomCoverageState | null;
  markMembershipPending(roomId: string, namespaceId: string): void;
}

export const ProtectedRoomAccessContext =
  createContext<ProtectedRoomAccessSnapshot>({
    stateForRoom: () => null,
    markMembershipPending: () => {},
  });

export function useProtectedRoomAccess(): ProtectedRoomAccessSnapshot {
  return useContext(ProtectedRoomAccessContext);
}

// ---------- Notification intelligence events (M236) ----------

export type NotificationRuntimeEvent = Extract<
  ServerEvent,
  {
    type:
      | "room.notification.changed"
      | "notification.message.important";
  }
>;

export interface NotificationRuntimeEventSource {
  subscribe: (listener: (event: NotificationRuntimeEvent) => void) => () => void;
}

export const NotificationRuntimeEventSourceContext =
  createContext<NotificationRuntimeEventSource>({
    subscribe: () => () => {},
  });

export function useNotificationRuntimeEventSource(): NotificationRuntimeEventSource {
  return useContext(NotificationRuntimeEventSourceContext);
}

// ---------- Runtime shell state (ISSUE-D145) ----------

/**
 * Consumer-facing seam for the shell-state discriminated union.
 *
 * P-5 lens — kept distinct from `WsStateContext`: shellState is for
 * UI consumers that need the high-level "are we authenticated and
 * connected?" question (empty-state copy, composer tooltip,
 * reconnect banner). `WsStateContext` continues to expose raw
 * transport state for things that genuinely need it (footer ws
 * dot, prolonged-disconnect toast escalator).
 */
export const RuntimeShellStateContext = createContext<RuntimeShellState>({
  kind: "bootstrapping",
});

export function useRuntimeShellState(): RuntimeShellState {
  return useContext(RuntimeShellStateContext);
}

// ---------- Encryption policy presentation ----------

export type ConversationEncryptionPolicyMode =
  | "plaintext_only"
  | "shadow_encryption"
  | "encrypted_only"
  | "unknown";

/** Read-only projection of the runtime provider's canonical policy refresh. */
export const ConversationEncryptionPolicyModeContext =
  createContext<ConversationEncryptionPolicyMode>("unknown");

/** The runtime owns device custody and mode-aware transport, not message UI. */
export const RoomMessageEditContext = createContext<
  import("../lib/room-message-edit").RoomMessageEdit | null
>(null);

export function useRoomMessageEdit(): import("../lib/room-message-edit").RoomMessageEdit | null {
  return useContext(RoomMessageEditContext);
}

export function useConversationEncryptionPolicyMode(): ConversationEncryptionPolicyMode {
  return useContext(ConversationEncryptionPolicyModeContext);
}

export function allowsOrdinaryConversationPersistence(
  mode: ConversationEncryptionPolicyMode,
): boolean {
  return mode === "plaintext_only" || mode === "shadow_encryption";
}

// ---------- Initial Room transcript hydration (D530) ----------

/**
 * Narrow consumer projection for the first authoritative Room-history pass.
 * This intentionally stays separate from cursor pagination: a cache-backed
 * transcript can be visible and still be waiting for its initial server
 * snapshot, while ordinary "load older" remains fully usable on a ready Room.
 */
export interface RoomInitialHistoryControls {
  readonly state: RoomInitialHydrationState | null;
  retry: () => void;
}

export const RoomInitialHistoryContext = createContext<RoomInitialHistoryControls>({
  state: null,
  retry: () => {},
});

export function useRoomInitialHistory(): RoomInitialHistoryControls {
  return useContext(RoomInitialHistoryContext);
}

// ---------- Room history pagination ----------

export interface RoomHistoryControls {
  hasMoreBefore: boolean;
  loadingBefore: boolean;
  loadOlder: () => Promise<boolean>;
  /** D430 — target-centered ranges are not ordinary cursor-history continuity. */
  ranges: readonly RoomHistoryRange[];
  loadingAroundMessageId: string | null;
  loadHistoryAround: (messageId: string) => Promise<boolean>;
}

export interface RoomHistoryRange {
  target: RoomMessageSearchCursor;
  messageIds: readonly string[];
  includedToolCallCompanion: boolean;
  hasOlder: boolean;
  hasNewer: boolean;
}

export const RoomHistoryContext = createContext<RoomHistoryControls>({
  hasMoreBefore: false,
  loadingBefore: false,
  loadOlder: () => Promise.resolve(false),
  ranges: [],
  loadingAroundMessageId: null,
  loadHistoryAround: () => Promise.resolve(false),
});

export function useRoomHistoryControls(): RoomHistoryControls {
  return useContext(RoomHistoryContext);
}

// ---------- Room transcript search (D430) ----------

export type RoomMessageSearchStatus =
  | "idle"
  | "invalid"
  | "debouncing"
  | "loading"
  | "ready"
  | "empty"
  | "error";

export interface RoomMessageSearchCachedPage {
  index: number;
  page: RoomMessageSearchPage;
}

export interface RoomMessageSearchState {
  roomId: string | null;
  query: string;
  mode: RoomMessageSearchMode;
  ignoreCase: boolean;
  status: RoomMessageSearchStatus;
  generation: number;
  asOf: RoomMessageSearchCursor | null;
  currentPageIndex: number;
  pages: readonly RoomMessageSearchCachedPage[];
  /** Hits on the selected cached page, ordered newest-first by the server. */
  hits: readonly RoomMessageSearchHit[];
  hasMoreOlder: boolean;
  canLoadNewer: boolean;
  error: string | null;
}

export interface RoomMessageSearchControls extends RoomMessageSearchState {
  setQuery: (query: string) => void;
  setMode: (mode: RoomMessageSearchMode) => void;
  setIgnoreCase: (ignoreCase: boolean) => void;
  loadOlder: () => Promise<boolean>;
  loadNewer: () => Promise<boolean>;
  clear: () => void;
}

export type RoomMessageSearchFetcher = (
  options: RoomMessageSearchOptions,
) => Promise<RoomMessageSearchPage>;

export interface RoomMessageSearchController {
  getSnapshot: () => RoomMessageSearchState;
  subscribe: (listener: () => void) => () => void;
  setRoomId: (roomId: string | null) => void;
  setQuery: (query: string) => void;
  setMode: (mode: RoomMessageSearchMode) => void;
  setIgnoreCase: (ignoreCase: boolean) => void;
  loadOlder: () => Promise<boolean>;
  loadNewer: () => Promise<boolean>;
  clear: () => void;
  dispose: () => void;
}

export const RoomMessageSearchContext = createContext<RoomMessageSearchControls>({
  roomId: null,
  query: "",
  mode: "prefix",
  ignoreCase: true,
  status: "idle",
  generation: 0,
  asOf: null,
  currentPageIndex: 0,
  pages: [],
  hits: [],
  hasMoreOlder: false,
  canLoadNewer: false,
  error: null,
  setQuery: () => {},
  setMode: () => {},
  setIgnoreCase: () => {},
  loadOlder: () => Promise.resolve(false),
  loadNewer: () => Promise.resolve(false),
  clear: () => {},
});

export function useRoomMessageSearch(): RoomMessageSearchControls {
  return useContext(RoomMessageSearchContext);
}

// ---------- Chats-wide search (D470) ----------

export interface ChatsSearchScope {
  serverKey: string | null;
  viewerKey: string | null;
  viewerGeneration: number;
}

export type ChatsSearchStatus = RoomMessageSearchStatus;

export interface ChatsSearchCachedPage {
  index: number;
  page: ChatSearchPage;
}

export interface ChatsSearchState {
  scope: ChatsSearchScope;
  query: string;
  mode: RoomMessageSearchMode;
  ignoreCase: boolean;
  status: ChatsSearchStatus;
  generation: number;
  messageAsOf: RoomMessageSearchCursor | null;
  currentMessagePageIndex: number;
  pages: readonly ChatsSearchCachedPage[];
  conversations: readonly ChatSearchConversationHit[];
  conversationsTruncated: boolean;
  messages: readonly ChatSearchMessageHit[];
  hasMoreOlderMessages: boolean;
  canLoadNewerMessages: boolean;
  error: string | null;
}

export interface ChatsSearchControls extends ChatsSearchState {
  setQuery: (query: string) => void;
  setMode: (mode: RoomMessageSearchMode) => void;
  setIgnoreCase: (ignoreCase: boolean) => void;
  loadOlderMessages: () => Promise<boolean>;
  loadNewerMessages: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  clear: () => void;
}

export type ChatsSearchFetcher = (
  options: ChatSearchOptions,
  signal: AbortSignal,
) => Promise<ChatSearchPage>;

export interface ChatsSearchController {
  getSnapshot: () => ChatsSearchState;
  subscribe: (listener: () => void) => () => void;
  setScope: (scope: ChatsSearchScope) => void;
  setQuery: (query: string) => void;
  setMode: (mode: RoomMessageSearchMode) => void;
  setIgnoreCase: (ignoreCase: boolean) => void;
  loadOlderMessages: () => Promise<boolean>;
  loadNewerMessages: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  clear: () => void;
  dispose: () => void;
}

const EMPTY_CHATS_SEARCH_SCOPE: ChatsSearchScope = {
  serverKey: null,
  viewerKey: null,
  viewerGeneration: 0,
};

export const ChatsSearchContext = createContext<ChatsSearchControls>({
  scope: EMPTY_CHATS_SEARCH_SCOPE,
  query: "",
  mode: "prefix",
  ignoreCase: true,
  status: "idle",
  generation: 0,
  messageAsOf: null,
  currentMessagePageIndex: 0,
  pages: [],
  conversations: [],
  conversationsTruncated: false,
  messages: [],
  hasMoreOlderMessages: false,
  canLoadNewerMessages: false,
  error: null,
  setQuery: () => {},
  setMode: () => {},
  setIgnoreCase: () => {},
  loadOlderMessages: () => Promise.resolve(false),
  loadNewerMessages: () => Promise.resolve(false),
  retry: () => Promise.resolve(false),
  clear: () => {},
});

export function useChatsSearch(): ChatsSearchControls {
  return useContext(ChatsSearchContext);
}

// ---------- Voice controls ----------

export type TurnStopFailureReason = "no-target" | "request-failed" | "not-live";

export type TurnStopStatus =
  | { state: "idle"; attemptId: number }
  | { state: "queued"; attemptId: number }
  | { state: "stopping"; attemptId: number }
  | { state: "stopped"; attemptId: number }
  | {
      state: "failed";
      attemptId: number;
      reason: TurnStopFailureReason;
    };

export interface VoiceControls {
  enabled: boolean;
  playing: boolean;
  toggle: () => void;
  stop: () => void;
  /** Resolves true when a chat message was accepted by the server (composer may clear). */
  sendText: (text: string, options?: {
    replyToMessageId?: number;
    mentionedHumanUserIds?: string[];
    mentionEveryone?: boolean;
    onOptimisticUserMessage?: () => void;
    /**
     * D371 R2 — optional per-turn model override. Forwarded through the
     * runtime send pipeline to the executor; inert until R3 wires UI to set it.
     */
    model?: string;
    /** Exact current work-surface resources to merge into this turn only. */
    contextualFocusedResources?: readonly ChatFocusedResourceRef[];
  }) => Promise<boolean>;
  /**
   * True only when the rendered transcript and outbound send target are bound
   * to the same active room. False during room-history handoff.
   */
  roomBindingReady: boolean;
  /** M147 — true while a turn (main or fork) is running in the active room. */
  isRunning: boolean;
  /** D341 — user-visible status for stopping work/turns, not voice playback. */
  turnStopStatus: TurnStopStatus;
  /**
   * M147 — abort every live job (main turn + forks) in the active room via
   * `POST /api/jobs/:id/stop`. Bypasses assistant-ui's `cancelRun` (which does
   * message-repository surgery incompatible with our WS-owned message list).
   */
  stopActiveJobs: () => void;
}

export const VoiceControlsContext = createContext<VoiceControls>({
  enabled: false,
  playing: false,
  toggle: () => {},
  stop: () => {},
  sendText: () => Promise.resolve(false),
  roomBindingReady: false,
  isRunning: false,
  turnStopStatus: { state: "idle", attemptId: 0 },
  stopActiveJobs: () => {},
});

export function useVoiceControls(): VoiceControls {
  return useContext(VoiceControlsContext);
}

// ---------- Tool-call activity stream ----------

/**
 * Tool-call activity stream (D057 2a.1.11 / 2a.1.9). Rolling log of the
 * most recent tool calls observed on the WS. Used by:
 *   - Activity tab (renders the last 20 as a feed)
 *   - Files tab "cited" glyph (derived: paths that appear in
 *     read_file / write_file / list_directory args)
 *
 * Bounded to TOOL_ACTIVITY_CAP events so an all-day session doesn't
 * accumulate state unbounded. Oldest entries drop off the end.
 */
export interface ToolActivityEvent {
  toolCallId: string;
  toolName: string;
  laneKey?: string;
  authorAgentId?: string;
  /** Server turn provenance retained for exact terminal-job reconciliation. */
  turnId?: string;
  /** Client-observed Job binding; display-only and never execution authority. */
  jobId?: string;
  browserResearchIntervention?: DesktopBrowserResearchIntervention;
  connectedWebActionAttention?: ConnectedWebActionAttention;
  /** The protected graph resume failed while this exact tool stayed parked. */
  connectedWebActionResumeFailed?: ConnectedWebActionResumeFailed;
  /** Tool args as a JS object, or {} when argsSummary didn't parse. */
  args: Record<string, unknown>;
  status: "running" | "ok" | "error";
  /** Epoch ms — when we first saw `tool.start`. */
  startedAt: number;
  /** Epoch ms — populated on `tool.end` (ok | error). */
  endedAt?: number;
  /** Error message if status === "error". */
  error?: string;
  /**
   * D083 Phase 2 — actual tool output string. Populated on
   * `tool.end` from the corresponding field on `ToolEndEvent`.
   * The inline ToolCard renders it (per-tool: run_shell shows
   * stdout/stderr/exit, read_file shows code-fence preview,
   * grep shows match list, etc.). Capped server-side at
   * TOOL_RESULT_MAX_BYTES; `resultTruncated` flags that the
   * full output was longer than the cap.
   */
  result?: string;
  resultTruncated?: boolean;
  /** D502 provisional Desktop raw-shell streams; final tool.end is canonical. */
  runShellProgress?: {
    stdout: string;
    stderr: string;
    stdoutOffsetBytes: number;
    stderrOffsetBytes: number;
    droppedBytes: number;
    lastSequence: number;
    phase: "running";
    elapsedMs: number;
  };
  /** D500 v15 provisional structured SSH observation; final tool.end is canonical. */
  structuredSshProgress?:
    | {
        operation: "exec";
        stdout: string;
        stderr: string;
        stdoutOffsetBytes: number;
        stderrOffsetBytes: number;
        droppedBytes: number;
        lastSequence: number;
        phase: "running";
        elapsedMs: number;
      }
    | {
        operation: "copy-upload" | "copy-download";
        transferredBytes: number;
        totalBytes?: number;
        lastSequence: number;
        phase: "starting" | "transferring";
        elapsedMs: number;
      };
}

export const TOOL_ACTIVITY_CAP = 50;

export const ToolActivityContext = createContext<ToolActivityEvent[]>([]);

export function useToolActivity(): ToolActivityEvent[] {
  return useContext(ToolActivityContext);
}

// ---------- Revision state (D087 Phase 3 §3.10) --------------------

/**
 * Latest-revision snapshot for one absolute path. Mirrors
 * `RevisionsStateChangedEvent.latest` from @nautilo/types but
 * kept inline here so workbench components don't need to pull
 * the server-event type directly.
 */
export interface RevisionStateSnapshot {
  availableRevisions: number;
  latest: {
    revisionId: string;
    turnId: string;
    createdAt: string;
    operation: string;
    summary: string;
    pinned: boolean;
    redoEligible: boolean;
  } | null;
}

/**
 * Path-keyed map of the most recent revision-state snapshot seen on
 * the WS bus. Keys are absolute file paths; values are the latest
 * snapshot. Populated by NautiloRuntimeProvider's handling of
 * `revisions.state_changed` events; read by the undo/redo UI via
 * `useRevisionState`.
 */
export const RevisionStateContext = createContext<
  Readonly<Record<string, RevisionStateSnapshot>>
>({});

/**
 * Hook: subscribe to revision-state updates.
 *
 *   - `useRevisionState(path)` — returns `{ canUndo, canRedo,
 *     snapshot }` for that specific absolute path. `canUndo`
 *     is true iff at least one revision exists; `canRedo` is true
 *     iff the latest revision was itself produced by an undo
 *     acceptance (has `redoEligible=true`).
 *   - `useRevisionState()` — returns the whole map, useful for
 *     UI that needs to aggregate across many files (e.g. a
 *     "recent edits" badge summing all paths).
 *
 * A component re-renders only when its specific path's entry
 * changes (via React's reference-equality on context value; any
 * consumer in the tree re-renders on context change, but the
 * selector-shaped API keeps render cost bounded for the common
 * path-specific case).
 */
export interface PathRevisionView {
  canUndo: boolean;
  canRedo: boolean;
  snapshot: RevisionStateSnapshot | null;
}

/**
 * D087 Phase 3 §3.8 — derive the "most-recently-touched path" from
 * the revision-state map. Drives the persistent undo/redo bar and
 * the `⌘Z` / `⌘⇧Z` keybinds: the keyboard shortcut targets
 * whichever file has the newest non-null revision snapshot.
 *
 * Returns null when no file in the map has availableRevisions > 0
 * (no history yet, everything's been GC'd, etc.) — caller
 * disables the affordance.
 *
 * The "newest" comparison is done on `latest.createdAt` (ISO-8601
 * lexicographic order is chronological for this format).
 *
 * Future `useRevisionState(path)` hook for per-file contexts (§3.9
 * context menu) will key off the same RevisionStateContext.
 */
export function useMostRecentlyTouchedPath(): {
  path: string | null;
  view: PathRevisionView;
} {
  const map = useContext(RevisionStateContext);
  let best: { path: string; createdAt: string; snapshot: RevisionStateSnapshot } | null = null;
  for (const [path, snapshot] of Object.entries(map)) {
    if (!snapshot.latest) continue;
    if (snapshot.availableRevisions === 0) continue;
    if (!best || snapshot.latest.createdAt > best.createdAt) {
      best = { path, createdAt: snapshot.latest.createdAt, snapshot };
    }
  }
  if (!best) {
    return {
      path: null,
      view: { canUndo: false, canRedo: false, snapshot: null },
    };
  }
  return {
    path: best.path,
    view: {
      canUndo: best.snapshot.availableRevisions > 0,
      canRedo: best.snapshot.latest?.redoEligible === true,
      snapshot: best.snapshot,
    },
  };
}

// ---------- Approval-ask (D061 Phase 2-client / Chunk 5) ----------

/**
 * Snapshot of an open `approval.ask` challenge. When `show` is false the
 * runtime has no pending ask; the dock renders nothing. When `show` is
 * true the dock renders with the populated fields.
 *
 * Distinct from prove_it: prove_it needs a PIN (centered modal is
 * correct there — attention-demanding security gate). Ask is the
 * lighter "approve this once / session / always / deny" tier with no
 * PIN, which is why the UI is an inline dock above the composer
 * instead of a centered modal.
 */
export interface ApprovalAskState {
  roomId?: string;
  show: boolean;
  approvalId: string | null;
  tools: ProveItToolInfo[];
  /** Human-readable "why this is gated" line. */
  reason: string;
  /** Machine-readable reason code for theming / analytics. */
  reasonCode: ApprovalAskReason | null;
  /** Optional D103 network destination context. */
  network: ApprovalAskNetworkContext | null;
  /** Subset of verbs the server allows the client to offer. */
  allowedVerbs: ApprovalReplyVerb[];
  /** M037 — per-tool generalization grain, index-aligned with `tools`. */
  scopeInfo: ApprovalScopeInfo[];
  localMcpInstall: LocalMcpInstallApproval | null;
  mediaGeneration: MediaGenerationApproval | null;
  structuredSsh: StructuredSshApproval | null;
  requiresExplicitReview: boolean;
  /** Last submit error (HTTP failure, etc.). null when clean. */
  error: string | null;
  /** In-flight submit — disable all buttons while true. */
  submitting: boolean;
}

export interface ApprovalAskControls {
  state: ApprovalAskState;
  /** Send a verb reply. Resolves when the server has accepted (or the
   *  UI has recorded the error in `state.error`). */
  submit: (verb: ApprovalReplyVerb) => Promise<void>;
}

const DEFAULT_APPROVAL_ASK_STATE: ApprovalAskState = {
  show: false,
  approvalId: null,
  tools: [],
  reason: "",
  reasonCode: null,
  network: null,
  allowedVerbs: ["once", "room", "always", "deny"],
  scopeInfo: [],
  localMcpInstall: null,
  mediaGeneration: null,
  structuredSsh: null,
  requiresExplicitReview: false,
  error: null,
  submitting: false,
};

export const ApprovalAskContext = createContext<ApprovalAskControls>({
  state: DEFAULT_APPROVAL_ASK_STATE,
  submit: async () => {
    // No-op default so consumers that render before the provider
    // mounts don't throw — the Provider in NautiloRuntimeProvider
    // supplies the real implementation at runtime.
  },
});

export function useApprovalAsk(): ApprovalAskControls {
  return useContext(ApprovalAskContext);
}

// ---------- Native Codex human requests (D453) ----------

/**
 * Native Codex requests are a short-lived owner-private handshake, not a
 * Nautilo tool-policy approval.  Keep their lifecycle separate so a Codex
 * decision neither writes Nautilo approval state nor inherits its verbs.
 */
const CODEX_REQUEST_PENDING_CAP = 16;
/** Mirrors `codexRoomRequestListSchema.items.max(16)` and the server recovery query cap. */
const CODEX_USER_INPUT_RECOVERY_CAP = 16;
const CODEX_REQUEST_TERMINAL_CAP = 64;

export interface CodexRequestState {
  /** Requests for the currently selected room, oldest first. */
  requests: readonly CodexRequestView[];
  /** The single request whose response POST is in flight. */
  submittingRequestId: string | null;
  /** A failed POST leaves the exact card in place for a retry. */
  errors: Readonly<Record<string, string>>;
}

/**
 * An unavailable user-input fact is deliberately retained after a restart so
 * the owner gets an honest explanation, but it must never regain controls.
 * Approval kinds are live-only and therefore always actionable while present.
 */
export interface CodexRequestView {
  readonly event: CodexRequestEvent;
  readonly availability: "actionable" | "unavailable";
}

export interface CodexRequestControls {
  state: CodexRequestState;
  respond: (requestId: string, response: CodexRequestResponse) => Promise<void>;
  dismiss: (requestId: string) => void;
}

const DEFAULT_CODEX_REQUEST_STATE: CodexRequestState = {
  requests: [],
  submittingRequestId: null,
  errors: {},
};

export const CodexRequestContext = createContext<CodexRequestControls>({
  state: DEFAULT_CODEX_REQUEST_STATE,
  respond: async () => {},
  dismiss: () => {},
});

export function useCodexRequests(): CodexRequestControls {
  return useContext(CodexRequestContext);
}

/** Owner-private WS admission. Never retain another viewer's request frame. */
export function isCodexOwner(ownerId: string, viewerKey: string | null): boolean {
  return viewerKey !== null && ownerId === viewerKey;
}

export function isCodexRequestForViewer(
  event: CodexRequestEvent,
  viewerKey: string | null,
): boolean {
  return isCodexOwner(event.ownerId, viewerKey);
}

/** Internal bounded map + insertion order. The public context is room-filtered. */
export interface CodexRequestLifecycleState {
  readonly byId: Readonly<Record<string, CodexRequestEvent>>;
  readonly availabilityById: Readonly<Record<string, "actionable" | "unavailable">>;
  readonly order: readonly string[];
  readonly submittingRequestId: string | null;
  readonly errors: Readonly<Record<string, string>>;
  readonly terminalRequestIds: readonly string[];
  readonly terminalTaskIds: readonly string[];
  readonly terminalJobIds: readonly string[];
}

export type CodexRequestLifecycleSourceAction =
  | { readonly kind: "arm"; readonly event: CodexRequestEvent }
  | { readonly kind: "resolved"; readonly requestId: string }
  | { readonly kind: "clear_job"; readonly jobId: string }
  | { readonly kind: "clear_task"; readonly taskId: string }
  | { readonly kind: "submit_start"; readonly requestId: string }
  | { readonly kind: "submit_failed"; readonly requestId: string; readonly message: string }
  | { readonly kind: "submit_accepted"; readonly requestId: string }
  | { readonly kind: "mark_unavailable"; readonly requestId: string }
  | { readonly kind: "dismiss"; readonly requestId: string };

export type CodexRequestLifecycleAction =
  | CodexRequestLifecycleSourceAction
  | { readonly kind: "reset_owner" }
  | {
    readonly kind: "hydrate_room";
    readonly roomId: string;
    readonly ownerId: string;
    readonly items: CodexRoomRequestList["items"];
    readonly baselineRequestIds: readonly string[];
    /** Source actions that arrived after this GET began. */
    readonly newerActions: readonly CodexRequestLifecycleSourceAction[];
  };

export function initialCodexRequestLifecycleState(): CodexRequestLifecycleState {
  return {
    byId: {},
    availabilityById: {},
    order: [],
    submittingRequestId: null,
    errors: {},
    terminalRequestIds: [],
    terminalTaskIds: [],
    terminalJobIds: [],
  };
}

function addTerminalId(ids: readonly string[], id: string): readonly string[] {
  if (ids.includes(id)) return ids;
  return [...ids.slice(-(CODEX_REQUEST_TERMINAL_CAP - 1)), id];
}

function withTerminalRequests(
  state: CodexRequestLifecycleState,
  requestIds: ReadonlySet<string>,
): CodexRequestLifecycleState {
  if (requestIds.size === 0) return state;
  let terminalRequestIds = state.terminalRequestIds;
  for (const requestId of requestIds) terminalRequestIds = addTerminalId(terminalRequestIds, requestId);
  return { ...state, terminalRequestIds };
}

function withoutCodexRequest(
  state: CodexRequestLifecycleState,
  requestIds: ReadonlySet<string>,
): CodexRequestLifecycleState {
  if (requestIds.size === 0) return state;
  const nextOrder = state.order.filter((requestId) => !requestIds.has(requestId));
  if (nextOrder.length === state.order.length) return state;
  const nextById = { ...state.byId };
  const nextAvailability = { ...state.availabilityById };
  const nextErrors = { ...state.errors };
  for (const requestId of requestIds) {
    delete nextById[requestId];
    delete nextAvailability[requestId];
    delete nextErrors[requestId];
  }
  return {
    byId: nextById,
    availabilityById: nextAvailability,
    order: nextOrder,
    submittingRequestId:
      state.submittingRequestId !== null && requestIds.has(state.submittingRequestId)
        ? null
        : state.submittingRequestId,
    errors: nextErrors,
    terminalRequestIds: state.terminalRequestIds,
    terminalTaskIds: state.terminalTaskIds,
    terminalJobIds: state.terminalJobIds,
  };
}

function applyCodexRequestLifecycleSourceAction(
  state: CodexRequestLifecycleState,
  action: CodexRequestLifecycleSourceAction,
): CodexRequestLifecycleState {
  switch (action.kind) {
    case "arm": {
      if (
        state.terminalRequestIds.includes(action.event.requestId) ||
        state.terminalTaskIds.includes(action.event.taskId) ||
        state.terminalJobIds.includes(action.event.jobId)
      ) return state;
      const existing = state.byId[action.event.requestId];
      if (existing) {
        return {
          ...state,
          byId: { ...state.byId, [action.event.requestId]: action.event },
          // A one-shot unavailable ref must not regain controls from a late
          // duplicate frame (there is no provider generation to compare).
          availabilityById: {
            ...state.availabilityById,
            [action.event.requestId]: state.availabilityById[action.event.requestId] ?? "actionable",
          },
        };
      }
      const retainedOrder = state.order.slice(-(CODEX_REQUEST_PENDING_CAP - 1));
      const evicted = new Set(state.order.slice(0, Math.max(0, state.order.length - retainedOrder.length)));
      const retained = withoutCodexRequest(state, evicted);
      return {
        ...retained,
        byId: { ...retained.byId, [action.event.requestId]: action.event },
        availabilityById: { ...retained.availabilityById, [action.event.requestId]: "actionable" },
        order: [...retained.order, action.event.requestId],
      };
    }
    case "resolved":
    case "submit_accepted": {
      const requestIds = new Set([action.requestId]);
      return withoutCodexRequest(withTerminalRequests(state, requestIds), requestIds);
    }
    case "mark_unavailable":
      if (!state.byId[action.requestId]) return state;
      return {
        ...state,
        availabilityById: { ...state.availabilityById, [action.requestId]: "unavailable" },
        submittingRequestId:
          state.submittingRequestId === action.requestId ? null : state.submittingRequestId,
        errors: { ...state.errors, [action.requestId]: "" },
      };
    case "dismiss": {
      const requestIds = new Set([action.requestId]);
      return withoutCodexRequest(withTerminalRequests(state, requestIds), requestIds);
    }
    case "clear_job": {
      // Terminal execution removes live controls, but a recovered unavailable
      // fact is the owner's one-shot explanation for why the question ended.
      // Keep it until explicit local dismissal.
      const requestIds = new Set(
        state.order.filter((requestId) =>
          state.byId[requestId]?.jobId === action.jobId &&
          state.availabilityById[requestId] !== "unavailable"
        ),
      );
      return withoutCodexRequest({
        ...withTerminalRequests(state, requestIds),
        terminalJobIds: addTerminalId(state.terminalJobIds, action.jobId),
      }, requestIds);
    }
    case "clear_task": {
      // See clear_job: task terminality fences late actionable frames without
      // erasing an already noninteractive restart receipt.
      const requestIds = new Set(
        state.order.filter((requestId) =>
          state.byId[requestId]?.taskId === action.taskId &&
          state.availabilityById[requestId] !== "unavailable"
        ),
      );
      return withoutCodexRequest({
        ...withTerminalRequests(state, requestIds),
        terminalTaskIds: addTerminalId(state.terminalTaskIds, action.taskId),
      }, requestIds);
    }
    case "submit_start":
      if (!state.byId[action.requestId]) return state;
      return {
        ...state,
        submittingRequestId: action.requestId,
        errors: { ...state.errors, [action.requestId]: "" },
      };
    case "submit_failed":
      if (!state.byId[action.requestId]) return state;
      return {
        ...state,
        submittingRequestId: null,
        errors: { ...state.errors, [action.requestId]: action.message },
      };
  }
}

function replaceRecoveredUserInputForRoom(
  state: CodexRequestLifecycleState,
  action: Extract<CodexRequestLifecycleAction, { readonly kind: "hydrate_room" }>,
): CodexRequestLifecycleState {
  // A corrupt/cross-owner DTO is not an empty authoritative snapshot. Leave
  // every local fact untouched rather than deriving terminality from it.
  if (action.items.some((item) =>
    item.event.ownerId !== action.ownerId || item.event.roomId !== action.roomId,
  )) return state;
  const validItems = action.items.filter((item) =>
    item.event.ownerId === action.ownerId &&
    item.event.roomId === action.roomId &&
    item.event.request.kind === "user_input_required",
  );
  const snapshotIds = new Set(validItems.map((item) => item.event.requestId));
  const baselineIds = new Set(action.baselineRequestIds);
  // The recovery list is newest-first and capped. An omitted id is terminal
  // evidence only when the response is shorter than that exact cap; a full
  // page can have older awaiting rows beyond it. Dispatching/submitted rows
  // are intentionally excluded too, so never infer absence for our active
  // submit handshake.
  const snapshotComplete = action.items.length < CODEX_USER_INPUT_RECOVERY_CAP;
  const absentBaseline = new Set(snapshotComplete
    ? [...baselineIds].filter((requestId) =>
      !snapshotIds.has(requestId) && requestId !== state.submittingRequestId,
    )
    : []);
  // Only ids present when this fetch began are authoritative. This keeps a
  // newer WS arm intact while an older snapshot settles.
  let next = withoutCodexRequest(withTerminalRequests(state, absentBaseline), absentBaseline);

  // For an existing baseline ref, refresh its safe payload/availability in
  // place. Submit state and errors remain untouched until normal lifecycle
  // evidence changes them.
  for (const item of validItems) {
    const event = item.event;
    if (!baselineIds.has(event.requestId)) continue;
    if (!next.byId[event.requestId] || next.terminalRequestIds.includes(event.requestId)) continue;
    next = {
      ...next,
      byId: { ...next.byId, [event.requestId]: event },
      availabilityById: { ...next.availabilityById, [event.requestId]: item.availability },
    };
  }

  // The database list is newest-first; dock order is intentionally oldest
  // first so a multi-question sequence reads in the order Codex asked it.
  const candidates = validItems.filter((item) =>
    !next.byId[item.event.requestId] && !next.terminalRequestIds.includes(item.event.requestId),
  );
  // Retain the newest DB items when live cards consume capacity, then reverse
  // only that retained subset for the oldest-first dock presentation.
  const availableSlots = Math.max(0, CODEX_REQUEST_PENDING_CAP - next.order.length);
  for (const item of candidates.slice(0, availableSlots).reverse()) {
    const event = item.event;
    next = {
      ...next,
      byId: { ...next.byId, [event.requestId]: event },
      availabilityById: { ...next.availabilityById, [event.requestId]: item.availability },
      order: [...next.order, event.requestId],
    };
  }
  return next;
}

/**
 * Pure request lifecycle used by the realtime adapter. Duplicate frames do
 * not reorder an open card; terminal/accepted paths are idempotent.
 */
export function reduceCodexRequestLifecycle(
  state: CodexRequestLifecycleState,
  action: CodexRequestLifecycleAction,
): CodexRequestLifecycleState {
  if (action.kind === "hydrate_room") {
    let next = replaceRecoveredUserInputForRoom(state, action);
    // The HTTP snapshot predates live frames/local submits that arrived while
    // it was in flight. The provider captures only that fetch window's
    // lifecycle facts and passes them here for a narrow replay.
    for (const newerAction of action.newerActions) {
      next = applyCodexRequestLifecycleSourceAction(next, newerAction);
    }
    return next;
  }
  if (action.kind === "reset_owner") return initialCodexRequestLifecycleState();
  return applyCodexRequestLifecycleSourceAction(state, action);
}

/** Render projection: retain other rooms' pending requests but never surface them here. */
export function selectCodexRequestsForRoom(
  lifecycle: CodexRequestLifecycleState,
  roomId: string | null,
  viewerKey: string | null,
): CodexRequestState {
  return {
    requests: lifecycle.order
      .map((requestId) => {
        const event = lifecycle.byId[requestId];
        return event
          ? { event, availability: lifecycle.availabilityById[requestId] ?? "actionable" }
          : undefined;
      })
      .filter(
        (view): view is CodexRequestView =>
          view !== undefined && view.event.roomId === roomId && view.event.ownerId === viewerKey,
      ),
    submittingRequestId: lifecycle.submittingRequestId,
    errors: lifecycle.errors,
  };
}

// ---------- Auto-Approve session mode (D375) ----------

/**
 * D375 — ephemeral, session+device-scoped "Auto-Approve" mode.
 *
 * When `enabled`, ask-tier tool approvals (`approval.ask`) auto-resolve
 * with the verb `"once"` WITHOUT surfacing the ApprovalAskDock, so a
 * trusted local session runs prompt-free. It is NOT a `security.level`
 * change and touches no server posture.
 *
 * Boundary (enforced at the `approval.ask` seam in nautilo-runtime.tsx,
 * NOT here): `prove_it`/destructive-high (PIN), `critical` block,
 * capability `forbidden`, sandbox containment, network-egress asks
 * (`event.network`), and run_shell hard-timeout all still stop. This
 * maps ONLY `ask → auto`; it deliberately does NOT reuse the more
 * permissive `security.level: "yolo"` verb-map row.
 *
 * `canToggle` reflects the non-guest gate (authenticated verified
 * member). Guests never get the toggle. State is ephemeral — it clears
 * on reload / app restart.
 */
export interface AutoApproveControls {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** True only for authenticated non-guest members. Guests: false. */
  canToggle: boolean;
}

export const AutoApproveContext = createContext<AutoApproveControls>({
  enabled: false,
  setEnabled: () => {},
  canToggle: false,
});

export function useAutoApprove(): AutoApproveControls {
  return useContext(AutoApproveContext);
}

// ---------- Running subagents (D307 Stack 87) ----------

/** Live owner-scoped subagent activity dock snapshot. */
export interface RunningSubagentsSnapshot {
  list: RunningSubagent[];
  heartbeat: SubagentHeartbeat;
}

export const RunningSubagentsContext = createContext<RunningSubagentsSnapshot>({
  list: [],
  heartbeat: { count: 0, line: "" },
});

export function useRunningSubagents(): RunningSubagentsSnapshot {
  return useContext(RunningSubagentsContext);
}

// ---------- Room message reactions (D312 tap-to-react) ----------

/** Tap-to-react controls exposed to per-message bubbles. */
export interface RoomReactionControls {
  /**
   * Toggle the viewer's reaction on a message. `currentlySelf` is the
   * caller's view (from `selfEmojis`) of whether the viewer has already
   * reacted with `emoji`: true → remove (DELETE), false → add (PUT).
   * Optimistic; the actor-aware WS echo reconciles it and a failed
   * request rolls it back.
   */
  toggleReaction: (messageId: number, emoji: string, currentlySelf: boolean) => void;
  /** Viewer's session actor id, for deriving `selfEmojis` (null when guest). */
  viewerActorId: string | null;
}

export const RoomReactionsContext = createContext<RoomReactionControls>({
  toggleReaction: () => {},
  viewerActorId: null,
});

export function useRoomReactions(): RoomReactionControls {
  return useContext(RoomReactionsContext);
}
