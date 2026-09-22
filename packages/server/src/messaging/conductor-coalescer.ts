/**
 * D302 P7 — same-sender conductor coalescing (server-side helper).
 *
 * Buffers routing items keyed by `(roomId, userActorId)` with an intentional
 * always-debounce policy: every non-explicit item waits for a short first-item
 * quiet window so rapid follow-ups can collapse into the same arbitration; once
 * a second item arrives, the longer sliding burst window takes over. Explicit
 * boundaries bypass. Does not route or touch the DB; callers wire `onFlush`
 * into dispatch.
 */
import type { RoutingView } from "@nautilo/runtime";
import type { ForegroundTurnCandidate } from "@nautilo/runtime";
import type {
  ChatAttachmentStatus,
  ActiveMiniAppRequestContext,
  ChatArtifactRef,
  ChatFocusedResourceRef,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import type { VerifiedOrdinaryOrigin } from "@nautilo/types";

const DEFAULT_CONDUCTOR_COALESCE_DEBOUNCE_MS = 1_500;
const DEFAULT_CONDUCTOR_COALESCE_FIRST_QUIET_MS = 500;
const DEFAULT_CONDUCTOR_COALESCE_MAX_WAIT_MS = 5_000;
export const CONDUCTOR_COALESCE_POLICY = "always_debounce";

/** @mention-like token — explicit bot targeting bypasses coalescing. */
const MENTION_LIKE_TOKEN = /@\w/;

export interface ConductorPersistedHuman {
  messageId: number | null;
  humanTurnId: string;
  attachments: ChatAttachmentStatus[];
  coalesced: boolean;
  routingView: RoutingView;
  /** M296 — content-free protected sibling identity for this exact Message. */
  sharedAgentOperationId?: string;
}

/** One persisted human send ready for async conductor routing. */
export interface ConductorRoutingItem {
  roomId: string;
  userActorId: string;
  /** Verified paired-mobile provenance for this exact signed request. */
  ordinaryOrigin?: VerifiedOrdinaryOrigin;
  content: string;
  voiceMode: boolean;
  /** Ephemeral approval posture; latest item wins when a burst coalesces. */
  autoApprove?: boolean;
  currentFolder: string | null;
  /** Explicit Current Folder→Desktop relay identity; latest item wins. */
  currentFolderRelayId: string | null;
  workspacePath: string | null;
  activeMiniApp: ActiveMiniAppRequestContext | null;
  liveMiniAppSession?: TrustedLiveMiniAppSessionContext | null;
  attachmentRefs: string[];
  /** D356 — metadata-only artifact references; unioned (dedupe by id) on coalesce. */
  artifactRefs: ChatArtifactRef[];
  /**
   * D423 Phase 4 — generic focus refs (workspace artifact / local file);
   * unioned (kind-specific dedupe) on coalesce. Local-file refs fail closed
   * downstream this phase; coalescing still preserves them so a future
   * resolver can act on the merged burst.
   */
  focusedResources?: ChatFocusedResourceRef[];
  replyToMessageId?: number | null;
  uiSelectedBotActorId?: string | null;
  searchHistoryFlag: boolean;
  /** Structured Room-wide Human intent is an explicit routing boundary. */
  mentionEveryone?: boolean;
  /**
   * D371 R2 — per-turn model override (nullable). Coalesce rule = LATEST WINS
   * (mirrors `currentFolder`, NOT the `.some()` OR-reduce used for `voiceMode`).
   * Null/absent means "no override".
   */
  model?: string | null;
  /** Private exact-client fence; never persisted, logged, or sent to the conductor. */
  coalescingContext?: NonNullable<ForegroundTurnCandidate["coalescingContext"]>;
  persistedHuman: ConductorPersistedHuman;
}

function coalescingContextsAreCompatible(
  left: ConductorRoutingItem["coalescingContext"],
  right: ConductorRoutingItem["coalescingContext"],
): boolean {
  return left !== undefined
    && right !== undefined
    && left.clientSessionToken === right.clientSessionToken
    && left.initiatingClientSurface === right.initiatingClientSurface;
}

/** Merged same-sender burst handed to the conductor wake path. */
export interface CoalescedConductorRoutingItem extends ConductorRoutingItem {
  burstCount: number;
  coveredMessageIds: Array<number | null>;
  coveredHumanTurnIds: string[];
  coveredSharedAgentOperationIds: string[];
}

export type ConductorCoalesceEnqueueResult = "buffered" | "bypass";

export function conductorCoalesceKey(roomId: string, userActorId: string): string {
  return `${roomId}:${userActorId}`;
}

/**
 * Explicit intent boundaries must not merge with surrounding thought fragments.
 * Bypass items route immediately; callers should flush any pending buffer first
 * via {@link ConductorCoalescer.enqueue} or {@link ConductorCoalescer.flushIfPending}.
 */
export function shouldBypassConductorCoalescing(item: ConductorRoutingItem): boolean {
  // A signature covers one exact request body. Never merge it with another
  // signed or unsigned body under the same provenance.
  if (item.ordinaryOrigin) return true;
  if (item.mentionEveryone === true) return true;
  if (item.content.trimStart().startsWith("/")) return true;
  if (typeof item.replyToMessageId === "number" && Number.isInteger(item.replyToMessageId)) {
    return true;
  }
  const ui = item.uiSelectedBotActorId;
  if (typeof ui === "string" && ui.length > 0) return true;
  if (MENTION_LIKE_TOKEN.test(item.content)) return true;
  return false;
}

export function mergeConductorRoutingItems(
  items: readonly ConductorRoutingItem[],
): CoalescedConductorRoutingItem {
  const first = items[0]!;
  if (items.length === 1) {
    return {
      ...first,
      burstCount: 1,
      coveredMessageIds: [first.persistedHuman.messageId],
      coveredHumanTurnIds: [first.persistedHuman.humanTurnId],
      coveredSharedAgentOperationIds: first.persistedHuman.sharedAgentOperationId
        ? [first.persistedHuman.sharedAgentOperationId]
        : [],
    };
  }

  const last = items[items.length - 1]!;
  const content = items.map((i) => i.content).join("\n\n");
  const voiceMode = items.some((i) => i.voiceMode);
  const searchHistoryFlag = items.some((i) => i.searchHistoryFlag);
  const mentionEveryone = items.some((i) => i.mentionEveryone === true);
  const attachmentRefs = items.flatMap((i) => i.attachmentRefs);
  // D356 — union artifact refs across the burst, dedupe by external artifactId.
  const seenArtifactIds = new Set<string>();
  const artifactRefs: ChatArtifactRef[] = [];
  for (const i of items) {
    for (const ref of i.artifactRefs ?? []) {
      if (seenArtifactIds.has(ref.artifactId)) continue;
      seenArtifactIds.add(ref.artifactId);
      artifactRefs.push(ref);
    }
  }
  // D423 — union generic focus refs across the burst with kind-specific dedupe
  // (workspace-artifact by artifactId; local-file by (relayId, path)).
  const seenFocusKeys = new Set<string>();
  const focusedResources: ChatFocusedResourceRef[] = [];
  for (const i of items) {
    for (const ref of i.focusedResources ?? []) {
      const key =
        ref.kind === "workspace-artifact"
          ? `workspace-artifact:${ref.artifactId}`
          : `local-file:${ref.relayId}:${ref.path}`;
      if (seenFocusKeys.has(key)) continue;
      seenFocusKeys.add(key);
      focusedResources.push(ref);
    }
  }
  const attachments = items.flatMap((i) => i.persistedHuman.attachments);

  return {
    roomId: first.roomId,
    userActorId: first.userActorId,
    content,
    voiceMode,
    autoApprove: last.autoApprove === true,
    searchHistoryFlag,
    ...(mentionEveryone ? { mentionEveryone: true } : {}),
    currentFolder: last.currentFolder,
    currentFolderRelayId: last.currentFolderRelayId,
    workspacePath: last.workspacePath,
    activeMiniApp: last.activeMiniApp,
    ...(last.liveMiniAppSession !== undefined
      ? { liveMiniAppSession: last.liveMiniAppSession }
      : {}),
    // D371 R2 — per-turn model override: LATEST WINS (mirrors currentFolder,
    // not the OR-reduce used for voiceMode).
    ...(last.model ? { model: last.model } : {}),
    attachmentRefs,
    artifactRefs,
    ...(focusedResources.length > 0 ? { focusedResources } : {}),
    ...(last.replyToMessageId !== undefined
      ? { replyToMessageId: last.replyToMessageId }
      : {}),
    ...(last.uiSelectedBotActorId !== undefined
      ? { uiSelectedBotActorId: last.uiSelectedBotActorId }
      : {}),
    ...(first.coalescingContext ? { coalescingContext: first.coalescingContext } : {}),
    persistedHuman: {
      ...last.persistedHuman,
      attachments,
      coalesced: true,
    },
    burstCount: items.length,
    coveredMessageIds: items.map((i) => i.persistedHuman.messageId),
    coveredHumanTurnIds: items.map((i) => i.persistedHuman.humanTurnId),
    coveredSharedAgentOperationIds: items.flatMap((item) =>
      item.persistedHuman.sharedAgentOperationId
        ? [item.persistedHuman.sharedAgentOperationId]
        : []
    ),
  };
}

interface BufferEntry {
  items: ConductorRoutingItem[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  firstBufferedAt: number;
}

export class ConductorCoalescer {
  private readonly buffers = new Map<string, BufferEntry>();
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly firstQuietMs: number;
  private readonly now: () => number;

  constructor(
    private readonly setTimer: typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout,
    private readonly onFlush: (key: string, merged: CoalescedConductorRoutingItem) => void,
    debounceMs: number = DEFAULT_CONDUCTOR_COALESCE_DEBOUNCE_MS,
    maxWaitMs: number = DEFAULT_CONDUCTOR_COALESCE_MAX_WAIT_MS,
    now: () => number = Date.now,
    firstQuietMs: number = DEFAULT_CONDUCTOR_COALESCE_FIRST_QUIET_MS,
  ) {
    this.debounceMs = debounceMs;
    this.maxWaitMs = maxWaitMs;
    this.firstQuietMs = firstQuietMs;
    this.now = now;
  }

  /**
   * Buffer coalesceable items or signal bypass. Bypass flushes any pending
   * buffer for the same `(roomId, userActorId)` key before the caller routes.
   */
  enqueue(item: ConductorRoutingItem): ConductorCoalesceEnqueueResult {
    const key = conductorCoalesceKey(item.roomId, item.userActorId);
    if (shouldBypassConductorCoalescing(item)) {
      this.flushIfPending(key);
      return "bypass";
    }

    const existing = this.buffers.get(key);
    if (!existing) {
      const entry: BufferEntry = {
        items: [item],
        flushTimer: null,
        firstBufferedAt: this.now(),
      };
      this.buffers.set(key, entry);
      this.scheduleFlush(key, entry);
      return "buffered";
    }

    if (!coalescingContextsAreCompatible(existing.items[0]?.coalescingContext, item.coalescingContext)) {
      this.flush(key);
      return this.enqueue(item);
    }

    existing.items.push(item);
    this.scheduleFlush(key, existing);
    return "buffered";
  }

  flushIfPending(key: string): void {
    if (this.buffers.has(key)) this.flush(key);
  }

  /** Takes pending items without invoking `onFlush` (tests / introspection). */
  drainKey(key: string): CoalescedConductorRoutingItem | null {
    const entry = this.buffers.get(key);
    if (!entry) return null;
    if (entry.flushTimer) this.clearTimer(entry.flushTimer);
    this.buffers.delete(key);
    return mergeConductorRoutingItems(entry.items);
  }

  private scheduleFlush(key: string, entry: BufferEntry): void {
    if (entry.flushTimer) this.clearTimer(entry.flushTimer);
    const now = this.now();
    const quietMs = entry.items.length === 1 ? this.firstQuietMs : this.debounceMs;
    const debounceDeadline = now + quietMs;
    const maxWaitDeadline = entry.firstBufferedAt + this.maxWaitMs;
    const fireAt = Math.min(debounceDeadline, maxWaitDeadline);
    const delay = Math.max(0, fireAt - now);
    entry.flushTimer = this.setTimer(() => {
      this.flush(key);
    }, delay);
  }

  private flush(key: string): void {
    const entry = this.buffers.get(key);
    if (!entry) return;
    if (entry.flushTimer) this.clearTimer(entry.flushTimer);
    this.buffers.delete(key);
    const merged = mergeConductorRoutingItems(entry.items);
    this.onFlush(key, merged);
  }
}
