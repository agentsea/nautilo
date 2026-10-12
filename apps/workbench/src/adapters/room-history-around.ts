import type { ThreadMessageLike } from "@assistant-ui/react";
import type { RoomMessagesAroundOptions, RoomMessagesAroundPage } from "@nautilo/types";
import type { MessageBackfillUrgentSelection } from "@nautilo/api-client/browser";
import type { RoomHistoryRange } from "./runtime-contexts";

// Matches the signed Human history acknowledgement result bound and trusted
// history reader limit. Around HTTP defaults to 100, so reconciliation must
// request a compatible page; remaining mounted rows retain their own urgency.
const BACKFILL_HISTORY_PAGE_SIZE = 50;

export interface RoomHistoryAroundState {
  roomId: string | null;
  generation: number;
  loadingMessageId: string | null;
  ranges: readonly RoomHistoryRange[];
}

export interface RoomHistoryAroundController {
  getSnapshot: () => RoomHistoryAroundState;
  subscribe: (listener: () => void) => () => void;
  setRoomId: (roomId: string | null) => void;
  load: (messageId: string) => Promise<boolean>;
  dispose: () => void;
}

function messageIdOf(message: ThreadMessageLike): string {
  return String(message.id);
}

const CANONICAL_MODEL_TOOL_CALL_ID = /^nc_[0-9a-f]{32}_[0-9]+$/;

function toolCallPartOf(message: ThreadMessageLike): Record<string, unknown> | null {
  const content: unknown = message.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const part: unknown = content[0];
  if (part === null || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  return record["type"] === "tool-call" ? record : null;
}

function toolCallIdOf(message: ThreadMessageLike): string | null {
  const part = toolCallPartOf(message);
  return typeof part?.["toolCallId"] === "string" ? part["toolCallId"] : null;
}

function toolNameOf(message: ThreadMessageLike): string | null {
  const part = toolCallPartOf(message);
  return typeof part?.["toolName"] === "string" ? part["toolName"] : null;
}

function customString(message: ThreadMessageLike, key: string): string | undefined {
  const value = message.metadata?.custom?.[key];
  return typeof value === "string" ? value : undefined;
}

function matchesToolOwner(
  message: ThreadMessageLike,
  coordinate: Readonly<{ toolName?: string; laneKey?: string; authorAgentId?: string }>,
): boolean {
  const laneKey = customString(message, "laneKey");
  const authorAgentId = customString(message, "authorAgentId");
  const toolName = toolNameOf(message);
  return !((toolName !== null && coordinate.toolName !== undefined && toolName !== coordinate.toolName)
    || (laneKey !== undefined && coordinate.laneKey !== undefined && laneKey !== coordinate.laneKey)
    || (authorAgentId !== undefined && coordinate.authorAgentId !== undefined
      && authorAgentId !== coordinate.authorAgentId));
}

/** Resolve one mounted card for a lifecycle event. Legacy/provider IDs may use
 * only their exact synthetic presentation ID. A canonical ID can also resolve
 * one durable row after history adoption or cold load. Conflicting provenance
 * and ambiguous canonical rows fail closed. */
export function findMountedCanonicalToolCardIndex(
  messages: readonly ThreadMessageLike[],
  coordinate: Readonly<{
    toolCallId: string;
    toolName?: string;
    laneKey?: string;
    authorAgentId?: string;
  }>,
): number {
  const syntheticId = `tool-${coordinate.toolCallId}`;
  const exact = messages.flatMap((message, index) =>
    messageIdOf(message) === syntheticId
      && toolCallIdOf(message) === coordinate.toolCallId
      && matchesToolOwner(message, coordinate) ? [index] : []);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return -1;
  if (!CANONICAL_MODEL_TOOL_CALL_ID.test(coordinate.toolCallId)) return -1;
  const candidates = messages.flatMap((message, index) => {
    if (toolCallIdOf(message) !== coordinate.toolCallId
      || !matchesToolOwner(message, coordinate)) return [];
    return [index];
  });
  return candidates.length === 1 ? candidates[0] : -1;
}

function mergePersistedToolRowWithLiveCard(
  persisted: ThreadMessageLike,
  live: ThreadMessageLike,
): ThreadMessageLike {
  const persistedCustom = persisted.metadata?.custom;
  const liveCustom = live.metadata?.custom;
  const persistedPart = toolCallPartOf(persisted);
  const livePart = toolCallPartOf(live);
  return {
    ...persisted,
    ...live,
    id: persisted.id,
    ...(persistedPart !== null && livePart !== null
      ? { content: [{ ...persistedPart, ...livePart }] as unknown as ThreadMessageLike["content"] }
      : {}),
    ...(persisted.metadata !== undefined || live.metadata !== undefined
      ? {
          metadata: {
            ...persisted.metadata,
            ...live.metadata,
            ...(persistedCustom !== undefined || liveCustom !== undefined
              ? { custom: { ...persistedCustom, ...liveCustom } }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * A current model invocation has a reserved canonical ID and its hot card uses
 * the exact `tool-${id}` presentation ID. When one durable row later arrives,
 * adopt that row ID while retaining the newer mounted projection. Historical
 * provider IDs and ambiguous duplicates remain separate because neither shape
 * establishes that they represent one execution.
 */
function reconcilePersistedToolRows(
  existing: readonly ThreadMessageLike[],
  restoredAround: readonly ThreadMessageLike[],
): readonly ThreadMessageLike[] {
  const persistedByCallId = new Map<string, ThreadMessageLike[]>();
  for (const message of restoredAround) {
    const toolCallId = toolCallIdOf(message);
    if (toolCallId === null || !CANONICAL_MODEL_TOOL_CALL_ID.test(toolCallId)) continue;
    const matches = persistedByCallId.get(toolCallId);
    if (matches === undefined) persistedByCallId.set(toolCallId, [message]);
    else matches.push(message);
  }

  const liveByCallId = new Map<string, ThreadMessageLike[]>();
  for (const message of existing) {
    const toolCallId = toolCallIdOf(message);
    if (toolCallId === null
      || !CANONICAL_MODEL_TOOL_CALL_ID.test(toolCallId)
      || messageIdOf(message) !== `tool-${toolCallId}`) continue;
    const matches = liveByCallId.get(toolCallId);
    if (matches === undefined) liveByCallId.set(toolCallId, [message]);
    else matches.push(message);
  }

  return existing.map((message) => {
    const toolCallId = toolCallIdOf(message);
    if (toolCallId === null) return message;
    const persisted = persistedByCallId.get(toolCallId);
    const live = liveByCallId.get(toolCallId);
    const persistedRow = persisted?.length === 1 ? persisted[0] : undefined;
    const conflictingOwner = persistedRow !== undefined
      && ((customString(persistedRow, "authorAgentId") !== undefined
        && customString(message, "authorAgentId") !== undefined
        && customString(persistedRow, "authorAgentId") !== customString(message, "authorAgentId"))
        || (toolNameOf(persistedRow) !== null && toolNameOf(message) !== null
          && toolNameOf(persistedRow) !== toolNameOf(message)));
    return persistedRow !== undefined && live?.length === 1 && live[0] === message
      && !conflictingOwner
      ? mergePersistedToolRowWithLiveCard(persistedRow, message)
      : message;
  });
}

function isUnavailableHistoryMessage(message: ThreadMessageLike): boolean {
  return message.metadata?.custom?.historyUnavailable === true;
}

function editRevisionOf(message: ThreadMessageLike): number {
  const custom = message.metadata?.custom;
  if (custom && typeof custom === "object" && "editRevision" in custom) {
    const revision = custom.editRevision;
    if (typeof revision === "number" && Number.isInteger(revision) && revision >= 0) return revision;
  }
  return 0;
}

/** Capture the exact mounted projection that authorized an asynchronous
 * backfill reread. Object identity protects same-revision live changes while
 * the coordinate check also rejects an in-place edit-revision change. */
export function mountedRoomHistoryRefreshTarget(
  mounted: readonly ThreadMessageLike[],
  selection: MessageBackfillUrgentSelection,
): Readonly<{ projection: ThreadMessageLike; unavailable: boolean }> | null {
  const projection = mounted.find((message) =>
    messageIdOf(message) === String(selection.messageId)
    && editRevisionOf(message) === selection.revision
  );
  return projection === undefined
    ? null
    : { projection, unavailable: isUnavailableHistoryMessage(projection) };
}

export function mountedRoomHistoryRefreshTargetState(
  mounted: readonly ThreadMessageLike[],
  selection: MessageBackfillUrgentSelection,
  expectedTarget: Readonly<{ projection: ThreadMessageLike; unavailable: boolean }>,
): "current" | "retry" | "ignored" {
  const current = mountedRoomHistoryRefreshTarget(mounted, selection);
  if (current === null) return "ignored";
  if (current.projection === expectedTarget.projection
    && current.unavailable === expectedTarget.unavailable) return "current";
  return current.unavailable ? "retry" : "ignored";
}

/** Admit an adapter hint only after its page has reached the mounted Room.
 * This maps a child Subthread coordinate to the active parent projection and
 * rejects missing/offscreen rows before they can occupy the durable priority. */
export function mountedRoomHistoryPrioritySelection(
  activeRoomId: string | null,
  mounted: readonly ThreadMessageLike[],
  selection: MessageBackfillUrgentSelection,
): MessageBackfillUrgentSelection | null {
  if (activeRoomId === null) return null;
  const exact = mounted.find((message) =>
    messageIdOf(message) === String(selection.messageId)
    && editRevisionOf(message) === selection.revision
  );
  return exact === undefined ? null : { ...selection, roomId: activeRoomId };
}

/** Continue from the mounted transcript only after the acknowledged target
 * visibly opened. Around pages may contain an unavailable offscreen neighbor;
 * it must not displace a row the person is actually looking at. */
export function nextMountedUnavailableHistorySelection(
  activeRoomId: string | null,
  mounted: readonly ThreadMessageLike[],
  refreshedMessageId: string,
  options: Readonly<{ refreshedTargetRemoved?: boolean }> = {},
): MessageBackfillUrgentSelection | null {
  if (activeRoomId === null) return null;
  const refreshed = mounted.find((message) => messageIdOf(message) === refreshedMessageId);
  if ((refreshed === undefined && options.refreshedTargetRemoved !== true)
    || (refreshed !== undefined && isUnavailableHistoryMessage(refreshed))) return null;
  const next = mounted.find(isUnavailableHistoryMessage);
  if (next === undefined) return null;
  const messageId = Number(messageIdOf(next));
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  return { roomId: activeRoomId, messageId, revision: editRevisionOf(next) };
}

/** Continue a completed visible refresh from the adapter's structural view.
 * A ready around response can identify another missing Fallback row even
 * though that row deliberately has no unavailable marker. The exact mounted
 * fence rejects stale/offscreen hints, while excluding the completed
 * coordinate prevents refresh -> prioritize feedback. Strict placeholders
 * remain the fallback when the adapter supplied no different mounted row. */
export function nextMountedHistoryPrioritySelection(
  activeRoomId: string | null,
  mounted: readonly ThreadMessageLike[],
  refreshedSelection: MessageBackfillUrgentSelection,
  adapterHint: MessageBackfillUrgentSelection | null,
  options: Readonly<{ refreshedTargetRemoved?: boolean }> = {},
): MessageBackfillUrgentSelection | null {
  const mountedHint = adapterHint === null
    ? null
    : mountedRoomHistoryPrioritySelection(activeRoomId, mounted, adapterHint);
  if (mountedHint !== null
    && (mountedHint.messageId !== refreshedSelection.messageId
      || mountedHint.revision !== refreshedSelection.revision)) {
    return mountedHint;
  }
  return nextMountedUnavailableHistorySelection(
    activeRoomId,
    mounted,
    String(refreshedSelection.messageId),
    options,
  );
}

/** Resolve an acknowledged source coordinate through the currently mounted
 * Room. A Subthread Message may be projected in its parent Session history,
 * so the authenticated around read uses the active Room rather than the
 * claim's canonical child Room. */
export function mountedRoomHistoryRefreshRequest(
  activeRoomId: string | null,
  mounted: readonly ThreadMessageLike[],
  selection: MessageBackfillUrgentSelection,
): RoomMessagesAroundOptions | null {
  if (activeRoomId === null
    || mountedRoomHistoryRefreshTarget(mounted, selection) === null) return null;
  return { roomId: activeRoomId, messageId: String(selection.messageId), limit: BACKFILL_HISTORY_PAGE_SIZE };
}

/**
 * Keeps existing message objects (including active streams and optimistic
 * rows) authoritative by stable id. The server's around page is chronological;
 * when it overlaps the mounted window, that overlap anchors the insertion.
 * With no overlap the historical page is prepended, leaving the live tail last.
 */
export function mergeRoomMessagesAround(
  existing: readonly ThreadMessageLike[],
  restoredAround: readonly ThreadMessageLike[],
): ThreadMessageLike[] {
  const reconciledExisting = reconcilePersistedToolRows(existing, restoredAround);
  const existingById = new Map(reconciledExisting.map((message) => [messageIdOf(message), message]));
  const aroundIds = new Set(restoredAround.map(messageIdOf));
  const anchored = restoredAround.map((message) => existingById.get(messageIdOf(message)) ?? message);
  const firstOverlap = reconciledExisting.findIndex((message) => aroundIds.has(messageIdOf(message)));
  if (firstOverlap < 0) return [...anchored, ...reconciledExisting];

  let lastOverlap = firstOverlap;
  for (let index = reconciledExisting.length - 1; index >= firstOverlap; index -= 1) {
    if (aroundIds.has(messageIdOf(reconciledExisting[index]))) {
      lastOverlap = index;
      break;
    }
  }
  const retainedMiddle = reconciledExisting
    .slice(firstOverlap, lastOverlap + 1)
    .filter((message) => !aroundIds.has(messageIdOf(message)));
  return [
    ...reconciledExisting.slice(0, firstOverlap),
    ...anchored,
    ...retainedMiddle,
    ...reconciledExisting.slice(lastOverlap + 1),
  ];
}

/** Replace repaired rows that are already mounted around the exact target.
 * Pagination cursors, loaded older rows, optimistic rows and live tail objects
 * remain owned by their existing projections. */
export function replaceRefreshedRoomMessage(
  existing: readonly ThreadMessageLike[],
  refreshedAround: readonly ThreadMessageLike[],
  messageId: string,
  options: Readonly<{ removeUnavailableTargetWhenAbsent?: boolean }> = {},
): ThreadMessageLike[] {
  const matches = refreshedAround.filter((message) => messageIdOf(message) === messageId);
  const existingTarget = existing.find((message) => messageIdOf(message) === messageId);
  if (existingTarget === undefined) {
    return [...existing];
  }
  if (matches.length === 0
    && options.removeUnavailableTargetWhenAbsent === true
    && isUnavailableHistoryMessage(existingTarget)) {
    return existing.filter((message) => messageIdOf(message) !== messageId);
  }
  if (matches.length !== 1) return [...existing];
  const refreshedTarget = matches[0];
  return existing.map((message) =>
    messageIdOf(message) === messageId ? refreshedTarget : message
  );
}

/**
 * D430 — one target-centered hydration at a time per active Room and target.
 * Completion is admitted only by this controller's dedicated generation and
 * the runtime-owned active-Room ref; it neither owns nor resets transcript
 * pagination state.
 */
export function createRoomHistoryAroundController(args: {
  fetchPage: (options: RoomMessagesAroundOptions) => Promise<RoomMessagesAroundPage>;
  getActiveRoomId: () => string | null;
  isMessageLoaded: (messageId: string) => boolean;
  onPage: (page: RoomMessagesAroundPage) => void;
}): RoomHistoryAroundController {
  let roomId: string | null = null;
  let generation = 0;
  let loadingMessageId: string | null = null;
  let ranges: readonly RoomHistoryRange[] = [];
  const pending = new Map<string, { generation: number; promise: Promise<boolean> }>();
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const current = (requestRoomId: string, requestGeneration: number): boolean =>
    roomId === requestRoomId &&
    generation === requestGeneration &&
    args.getActiveRoomId() === requestRoomId;

  return {
    getSnapshot: () => ({ roomId, generation, loadingMessageId, ranges }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setRoomId: (nextRoomId) => {
      if (roomId === nextRoomId) return;
      roomId = nextRoomId;
      generation += 1;
      loadingMessageId = null;
      ranges = [];
      emit();
    },
    load: (messageId) => {
      const requestRoomId = roomId;
      if (!requestRoomId || !messageId || args.isMessageLoaded(messageId)) {
        return Promise.resolve(false);
      }
      const key = `${requestRoomId}:${messageId}`;
      const existing = pending.get(key);
      if (existing && loadingMessageId === messageId) return existing.promise;

      const requestGeneration = ++generation;
      loadingMessageId = messageId;
      emit();
      const promise = (async (): Promise<boolean> => {
        try {
          const page = await args.fetchPage({ roomId: requestRoomId, messageId });
          if (!current(requestRoomId, requestGeneration)) return false;
          args.onPage(page);
          ranges = [
            ...ranges.filter((range) => range.target.messageId !== page.target.messageId),
            {
              target: page.target,
              messageIds: page.messages.map((message) => message.id),
              includedToolCallCompanion: page.includedToolCallCompanion,
              hasOlder: page.hasOlder,
              hasNewer: page.hasNewer,
            },
          ];
          return true;
        } catch {
          return false;
        } finally {
          if (current(requestRoomId, requestGeneration)) {
            loadingMessageId = null;
            emit();
          }
          if (pending.get(key)?.generation === requestGeneration) pending.delete(key);
        }
      })();
      pending.set(key, { generation: requestGeneration, promise });
      return promise;
    },
    dispose: () => {
      generation += 1;
      roomId = null;
      loadingMessageId = null;
      ranges = [];
      pending.clear();
      listeners.clear();
    },
  };
}
