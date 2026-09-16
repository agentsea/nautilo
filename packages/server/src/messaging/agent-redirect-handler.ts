/**
 * D421 Phase 4.3 — dispatch-owned one-hop redirect completion handler.
 *
 * Runtime owns only the in-memory completion-hook registration/notification
 * contract. This server module owns every piece of pending wake context,
 * timeout cleanup, live roster/silence revalidation, target enqueue, focus
 * transfer, and requester-private receipt emission.
 */
import { getSharedDirectDb } from "@nautilo/db";
import { log } from "@nautilo/logger";
import {
  clearFocus,
  loadActiveFoci,
  openOrExtendFocus,
  type FocusDb,
  type MemoryAccessEnvelope,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import {
  eventBus,
  filterWakeableAgents,
  setRedirectCompletionHook,
  type MaintenanceAcceptanceAuthority,
  type RedirectCompletionNotification,
  type ConductorDecision,
  type RoomMemberView,
} from "@nautilo/runtime";
import type {
  ActiveMiniAppRequestContext,
  ChatArtifactRef,
  ChatFocusedResourceRef,
  ConductorDecisionReceiptEvent,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import { classifyRedirectDecision, type RedirectOutcomeCode } from "./conductor-observability";

/**
 * Lost-completion defense only; normal terminal notifications are primary
 * cleanup. One hour exceeds a two-attempt source turn (10-minute provider
 * timeout per attempt) plus the post-tool model turn.
 */
export const AGENT_REDIRECT_PENDING_TIMEOUT_MS = 3_600_000;

export interface RedirectTargetMember {
  actorId: string;
  agentId: string;
  handle: string;
}

/**
 * Original source-wake payload retained by dispatch. These values are all
 * server-authored or validated at human ingress; none are derived from the
 * redirect tool request.
 */
export interface RedirectOriginalWakePayload {
  content: string;
  voiceMode: boolean;
  currentFolder: string | null;
  currentFolderRelayId: string | null;
  workspacePath: string | null;
  activeMiniApp: ActiveMiniAppRequestContext | null;
  liveMiniAppSession: TrustedLiveMiniAppSessionContext | null;
  attachmentRefs: string[];
  artifactRefs: ChatArtifactRef[];
  focusedResources: ChatFocusedResourceRef[];
  model: string | null;
  replyToMessageId?: number;
  subthreadParentRoomId?: string;
  subthreadAnchorMessageId?: number;
  transcriptOwnerId: string;
  canonicalMemoryAccessEnvelope: MemoryAccessEnvelope;
}

export interface PendingAgentRedirectContext {
  roomId: string;
  senderActorId: string;
  senderUserId: string;
  sourceAgentId: string;
  sourceAgentActorId: string;
  sourceHandle: string;
  persistedMessageId: number | null;
  humanTurnId: string;
  acceptanceAuthority: MaintenanceAcceptanceAuthority;
  invocationAuthority: AcceptedInvocationAuthority;
  redirectAllowed: true;
  sourceRedirectDepth: 0;
  /** Resolves after the source job is accepted and its normal focus write ends. */
  sourceWakeReady: Promise<boolean>;
  original: RedirectOriginalWakePayload;
  loadLiveMembers: () => Promise<RoomMemberView[]>;
  loadActiveSilence: () => Promise<
    Array<{ botActorId: string | null; kind: "mute" | "deaf" }>
  >;
  enqueueTarget: (
    target: RedirectTargetMember,
    original: RedirectOriginalWakePayload,
    continuation: {
      humanTurnId: string;
      persistedMessageId: number | null;
      acceptanceAuthority: MaintenanceAcceptanceAuthority;
      invocationAuthority: AcceptedInvocationAuthority;
      humanAlreadyPersisted: true;
      redirectDepth: 1;
      redirectAllowed: false;
    },
  ) => Promise<void>;
}

export interface RedirectHandlerDeps {
  getDb: () => FocusDb;
  loadActiveFoci: typeof loadActiveFoci;
  clearFocus: typeof clearFocus;
  openOrExtendFocus: typeof openOrExtendFocus;
  emit: (event: ConductorDecisionReceiptEvent | {
    type: "conductor.focus_changed";
    laneKey: string;
    roomId: string;
    userActorId: string;
    change: "opened" | "extended" | "cleared";
    botActorId: string;
    source: "inferred";
    reason: string;
  }) => void;
  now: () => Date;
}

const defaultDeps: RedirectHandlerDeps = {
  getDb: getSharedDirectDb,
  loadActiveFoci,
  clearFocus,
  openOrExtendFocus,
  emit: (event) => eventBus.emit(event),
  now: () => new Date(),
};

const pending = new Map<string, PendingAgentRedirectContext>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
let installed = false;
let installRefs = 0;
let timeoutMsOverride: number | undefined;
let handlerDeps: RedirectHandlerDeps = defaultDeps;

/** Server authority predicate: fail closed outside inferred single-wake. */
export function isRedirectAllowedForConductorWake(
  decision: ConductorDecision,
  wakeCount: number,
  acceptanceAuthority: MaintenanceAcceptanceAuthority | undefined,
): boolean {
  return (
    decision.kind === "wake" &&
    decision.source === "inferred" &&
    wakeCount === 1 &&
    acceptanceAuthority !== undefined
  );
}

function clearPending(key: string): PendingAgentRedirectContext | undefined {
  const normalized = key.trim();
  if (!normalized) return undefined;
  const context = pending.get(normalized);
  pending.delete(normalized);
  const timer = pendingTimers.get(normalized);
  if (timer) clearTimeout(timer);
  pendingTimers.delete(normalized);
  return context;
}

export function registerPendingAgentRedirect(
  key: string,
  context: PendingAgentRedirectContext,
): void {
  const normalized = key.trim();
  if (!normalized) return;
  clearPending(normalized);
  pending.set(normalized, context);
  const timer = setTimeout(() => {
    clearPending(normalized);
  }, timeoutMsOverride ?? AGENT_REDIRECT_PENDING_TIMEOUT_MS);
  pendingTimers.set(normalized, timer);
}

export function clearPendingAgentRedirect(key: string): void {
  clearPending(key);
}

export function pendingAgentRedirectCount(): number {
  return pending.size;
}

export function getPendingAgentRedirect(
  key: string,
): PendingAgentRedirectContext | undefined {
  return pending.get(key.trim());
}

function emitReceipt(
  context: PendingAgentRedirectContext,
  code: RedirectOutcomeCode,
  selectedHandle?: string,
): void {
  const outcome = classifyRedirectDecision(code);
  const event: ConductorDecisionReceiptEvent = {
    type: "conductor.decision",
    laneKey: `room:${context.roomId}`,
    roomId: context.roomId,
    userId: context.senderUserId,
    userActorId: context.senderActorId,
    messageId:
      context.persistedMessageId == null ? null : String(context.persistedMessageId),
    humanTurnId: context.humanTurnId,
    outcome: outcome.outcome,
    reasonCode: outcome.reasonCode,
    displayReason: outcome.displayReason,
    ...(selectedHandle ? { selectedHandles: [`@${selectedHandle}`] } : {}),
  };
  handlerDeps.emit(event);
}

async function transferFocus(
  context: PendingAgentRedirectContext,
  target: RedirectTargetMember,
): Promise<void> {
  const db = handlerDeps.getDb();
  const now = handlerDeps.now();
  const active = await handlerDeps.loadActiveFoci(
    db,
    context.roomId,
    context.senderActorId,
    now,
  );
  for (const focus of active) {
    if (focus.botActorId !== context.sourceAgentActorId) continue;
    await handlerDeps.clearFocus(db, {
      roomId: context.roomId,
      userActorId: context.senderActorId,
      focusId: focus.focusId,
      reason: "agent redirect",
      now,
    });
    handlerDeps.emit({
      type: "conductor.focus_changed",
      laneKey: `room:${context.roomId}`,
      roomId: context.roomId,
      userActorId: context.senderActorId,
      change: "cleared",
      botActorId: context.sourceAgentActorId,
      source: "inferred",
      reason: "agent redirect",
    });
  }
  const opened = await handlerDeps.openOrExtendFocus(db, {
    roomId: context.roomId,
    userActorId: context.senderActorId,
    botActorId: target.actorId,
    source: "inferred",
    reason: "agent redirect",
    now,
  });
  handlerDeps.emit({
    type: "conductor.focus_changed",
    laneKey: `room:${context.roomId}`,
    roomId: context.roomId,
    userActorId: context.senderActorId,
    change: opened.created ? "opened" : "extended",
    botActorId: target.actorId,
    source: "inferred",
    reason: "agent redirect",
  });
}

async function handleCompletion(
  notification: RedirectCompletionNotification,
): Promise<void> {
  const context = clearPending(notification.turnContextId);
  if (!context) return;

  // Normal completion without a request, errors, and cancellation only clean
  // the server-owned pending entry. They are not redirect decisions.
  if (notification.kind !== "fulfilled" || !notification.request) return;
  let receiptAttempted = false;
  const finish = (code: RedirectOutcomeCode, selectedHandle?: string): void => {
    receiptAttempted = true;
    emitReceipt(context, code, selectedHandle);
  };

  try {
    // Server-side authority/depth/source checks. Runtime's request view is
    // privacy-minimized to targetHandle + depth.
    if (
      context.redirectAllowed !== true ||
      context.sourceRedirectDepth !== 0 ||
      notification.request.depth !== 1
    ) {
      finish("duplicate");
      return;
    }
    if (notification.sourceAssistantVisibleOutput === true) {
      finish("visible_output");
      return;
    }
    if (
      notification.humanTurnId !== context.humanTurnId ||
      notification.sourceAgentId !== context.sourceAgentId
    ) {
      finish("ineligible_target");
      return;
    }
    if (!(await context.sourceWakeReady)) return;

    const liveMembers = await context.loadLiveMembers();
    const exactMatches = liveMembers.filter(
      (member) => member.handle === notification.request?.targetHandle,
    );
    if (exactMatches.length === 0 || exactMatches.length > 1) {
      finish("unknown_target");
      return;
    }
    const exact = exactMatches[0]!;
    if (exact.kind !== "agent" || !exact.agentId) {
      finish("ineligible_target");
      return;
    }
    if (
      exact.actorId === context.sourceAgentActorId ||
      exact.agentId === context.sourceAgentId
    ) {
      finish("self_target");
      return;
    }

    const silence = await context.loadActiveSilence();
    const wakeable = filterWakeableAgents(liveMembers, silence);
    if (!wakeable.some((member) => member.actorId === exact.actorId)) {
      finish("ineligible_target");
      return;
    }

    const target: RedirectTargetMember = {
      actorId: exact.actorId,
      agentId: exact.agentId,
      handle: exact.handle,
    };
    try {
      await context.enqueueTarget(target, context.original, {
        humanTurnId: context.humanTurnId,
        persistedMessageId: context.persistedMessageId,
        acceptanceAuthority: context.acceptanceAuthority,
        invocationAuthority: context.invocationAuthority,
        humanAlreadyPersisted: true,
        redirectDepth: 1,
        redirectAllowed: false,
      });
    } catch {
      finish("enqueue_failed");
      return;
    }

    try {
      await transferFocus(context, target);
    } catch {
      // Target enqueue already succeeded and cannot be rolled back. The
      // accepted receipt remains truthful about wake delivery.
      log("[agent-redirect] focus_transfer_failed");
    }
    finish("accepted", target.handle);
  } catch {
    log("[agent-redirect] completion_processing_failed");
    if (!receiptAttempted) {
      try {
        finish("enqueue_failed");
      } catch {
        // The requester transport itself failed; runtime must still not
        // receive or log raw server/provider details.
      }
    }
  }
}

/**
 * Install exactly one runtime completion hook for this server process.
 * Returns a teardown function suitable for Fastify's `onClose`.
 */
export function installAgentRedirectCompletionHandler(
  deps: Partial<RedirectHandlerDeps> = {},
): () => void {
  installRefs += 1;
  if (installed) return uninstallAgentRedirectCompletionHandler;
  handlerDeps = { ...defaultDeps, ...deps };
  setRedirectCompletionHook(handleCompletion);
  installed = true;
  return uninstallAgentRedirectCompletionHandler;
}

export function uninstallAgentRedirectCompletionHandler(): void {
  if (installRefs > 0) installRefs -= 1;
  if (!installed || installRefs > 0) return;
  setRedirectCompletionHook(null);
  installed = false;
  handlerDeps = defaultDeps;
  for (const key of [...pending.keys()]) clearPending(key);
}

/** Test-only reset/timeout seams. */
export function _resetAgentRedirectHandlerForTests(): void {
  installRefs = 0;
  if (installed) {
    setRedirectCompletionHook(null);
    installed = false;
  }
  handlerDeps = defaultDeps;
  for (const key of [...pending.keys()]) clearPending(key);
  for (const timer of pendingTimers.values()) clearTimeout(timer);
  pendingTimers.clear();
  timeoutMsOverride = undefined;
}

export function _setAgentRedirectPendingTimeoutMsForTests(
  ms: number | undefined,
): void {
  timeoutMsOverride = ms;
}
