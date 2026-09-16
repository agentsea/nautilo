// The global, authenticated owner for Mobile approvals and PIN challenges.
// Task surfaces only select/reopen exact records here; they never maintain an
// approval, modal, or PIN authority of their own.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "expo-router";

import { getApiClient } from "@/lib/api";
import {
  recoverMobileCapabilityDenial,
  type MobileCapabilityScope,
} from "@/lib/mobile-capability-denial";
import { roomIdFromLaneKey } from "@/lib/messages";
import { viewerCan } from "@/lib/viewer-capabilities";
import { useAutoApprove } from "@/providers/auto-approve";
import { useAuth } from "@/providers/auth";
import { mayHandleAttentionEvent } from "@/providers/attention-policy";
import {
  createAttentionAuthorityCoordinator,
  isExpiredChallenge,
  mayAdmitAttentionEvent,
  sameAttentionScope,
  taskApprovalMatches,
  taskChallengeMatches,
  type AttentionAuthorityState,
  type AttentionScope,
  type PinChallenge,
  type TaskPinChallengeEvent,
} from "@/providers/attention-state";
import { useRealtime } from "@/providers/realtime";
import { useServers } from "@/providers/server-registry";
import { shouldAutoResolveAsk } from "@nautilo/types";
import type {
  ApprovalAskEvent,
  ApprovalReplyVerb,
  HostChoiceEvent,
  ServerEvent,
} from "@nautilo/types";

export type { PinChallenge } from "@/providers/attention-state";

interface AttentionValue {
  pendingApprovals: readonly ApprovalAskEvent[];
  capabilityError: string | null;
  dismissCapabilityError: () => void;
  attentionApproval: ApprovalAskEvent | null;
  attentionHostChoice: HostChoiceEvent | null;
  /** Presented through the one global PinModal, or null when it is hidden. */
  activeChallenge: PinChallenge | null;
  pendingApprovalForRoom: (roomId: string) => ApprovalAskEvent | null;
  pendingApprovalForTask: (taskId: string, taskRunId?: string | null) => ApprovalAskEvent | null;
  /** Returns the exact current Task challenge even when the modal is hidden. */
  activeChallengeForTask: (taskId: string, taskRunId?: string | null) => PinChallenge | null;
  presentChallenge: (expected: PinChallenge) => void;
  pendingHostChoiceForRoom: (roomId: string) => HostChoiceEvent | null;
  replyToHostChoice: (choice: HostChoiceEvent, selector: string) => Promise<{ ok: boolean }>;
  replyToApproval: (approval: ApprovalAskEvent, verb: ApprovalReplyVerb) => Promise<{ ok: boolean }>;
  resolveChallenge: (expected: PinChallenge, pin: string) => Promise<{ ok: boolean }>;
  denyChallenge: (expected: PinChallenge) => Promise<{ ok: boolean }>;
  /** Hides, rather than resolves, the exact identity challenge. */
  dismissChallenge: (expected: PinChallenge) => void;
}

const AttentionContext = createContext<AttentionValue | null>(null);

function roomIdFromPath(pathname: string | undefined | null): string | null {
  if (!pathname) return null;
  const match = /^\/chat\/([^/?#]+)/.exec(pathname);
  return match ? match[1] : null;
}

function approvalForMobile(event: ApprovalAskEvent): ApprovalAskEvent {
  if (!event.requiresExplicitReview) return event;
  // D547 neither owns paid-media quote rendering nor its canonical receipt
  // echo. Keep it visibly unresolved rather than offering an unsafe partial
  // review; D525's dedicated owner remains authoritative.
  if (event.mediaGeneration || (!event.localMcpInstall && !event.structuredSsh)) {
    return {
      ...event,
      allowedVerbs: [],
      reason: "This exact local action needs review details, but they were unavailable. It cannot be approved from this client.",
    };
  }
  return { ...event, allowedVerbs: ["once", "deny"] };
}

/** A final endpoint guard; admission itself remains in the coordinator. */
function exactApprovalEndpointAllowed(approval: ApprovalAskEvent, verb: ApprovalReplyVerb): boolean {
  if (approval.requiresExplicitReview !== true) return true;
  const missingExactDetails = approval.localMcpInstall?.digest === undefined
    && approval.structuredSsh === undefined;
  return !missingExactDetails && !(verb !== "once" && verb !== "deny");
}

export function AttentionProvider({ children }: { children: React.ReactNode }) {
  const { subscribe, openRevision } = useRealtime();
  const { activeServer } = useServers();
  const { viewer, refreshViewer, status: authStatus, viewerState } = useAuth();
  const { enabled: autoApproveEnabled } = useAutoApprove();
  const pathname = usePathname();
  const canInvokeAgents = viewerCan(viewer, "invoke_agents");

  // A same-ID account can receive a fresh viewer object after re-auth. Its
  // distinct epoch prevents old in-memory challenges crossing that boundary.
  const viewerEpochRef = useRef({ viewer, epoch: 0 });
  if (viewerEpochRef.current.viewer !== viewer) {
    viewerEpochRef.current = { viewer, epoch: viewerEpochRef.current.epoch + 1 };
  }
  const scope = useMemo<AttentionScope | null>(() => (
    activeServer && viewer && authStatus === "signed-in" && viewerState === "verified" && canInvokeAgents
      ? {
          serverId: activeServer.id,
          serverUrl: activeServer.serverUrl,
          userId: viewer.userId,
          actorId: viewer.actorId,
          epoch: viewerEpochRef.current.epoch,
        }
      : null
  ), [activeServer, authStatus, canInvokeAgents, viewer, viewerState]);
  const scopeRef = useRef<AttentionScope | null>(scope);
  scopeRef.current = scope;

  const [authority, setAuthority] = useState<AttentionAuthorityState>(() => ({
    scope: null, approvals: [], approvalTombstones: [], challenge: null,
  }));
  const [hostChoices, setHostChoices] = useState<readonly HostChoiceEvent[]>([]);
  const hostChoiceScopeRef = useRef<AttentionScope | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);

  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const viewerUserIdRef = useRef(viewer?.userId ?? null);
  viewerUserIdRef.current = viewer?.userId ?? null;
  const autoApproveEnabledRef = useRef(autoApproveEnabled);
  autoApproveEnabledRef.current = autoApproveEnabled;
  const canInvokeAgentsRef = useRef(canInvokeAgents);
  canInvokeAgentsRef.current = canInvokeAgents;
  const currentCapabilityScope = useCallback((): MobileCapabilityScope | null => {
    const serverId = activeServerRef.current?.id ?? null;
    const userId = viewerUserIdRef.current;
    return serverId && userId ? { serverId, userId } : null;
  }, []);
  const reportCapabilityDenial = useCallback(async (error: unknown, actionScope: MobileCapabilityScope | null): Promise<void> => {
    const denial = await recoverMobileCapabilityDenial({
      error,
      actionScope,
      getCurrentScope: currentCapabilityScope,
      refreshViewer,
    });
    if (denial) setCapabilityError(denial.message);
  }, [currentCapabilityScope, refreshViewer]);
  const reportRef = useRef(reportCapabilityDenial);
  reportRef.current = reportCapabilityDenial;

  const coordinatorRef = useRef<ReturnType<typeof createAttentionAuthorityCoordinator> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createAttentionAuthorityCoordinator({
      currentScope: () => scopeRef.current,
      onStateChange: (next) => {
        setAuthority(next);
      },
      onEndpointError: (error, actionScope) => reportRef.current(error, { serverId: actionScope.serverId, userId: actionScope.userId }),
      endpoints: {
        approvalReply: async (actionScope, approval, verb) => {
          if (!exactApprovalEndpointAllowed(approval, verb)) return false;
          return Boolean((await getApiClient(actionScope.serverUrl).approvalReply(
            verb,
            approval.threadId,
            approval.laneKey,
            approval.approvalId,
            approval.localMcpInstall?.digest,
          )).ok);
        },
        proveIt: async (actionScope, challenge, pin) => Boolean((await getApiClient(actionScope.serverUrl).proveItAndResume(pin, challenge.threadId, challenge.laneKey)).ok),
        denyProveIt: async (actionScope, challenge) => Boolean((await getApiClient(actionScope.serverUrl).denyProveIt(challenge.threadId, challenge.laneKey)).ok),
        verifyIdentity: async (actionScope, challenge, pin) => Boolean((await getApiClient(actionScope.serverUrl).identityVerifyResume(pin, challenge.threadId, challenge.laneKey)).ok),
        enrollPin: async (actionScope, challenge, pin) => Boolean((await getApiClient(actionScope.serverUrl).postAuthPin({
          newPin: pin,
          threadId: challenge.threadId,
          laneKey: challenge.laneKey,
        })).ok),
      },
    });
  }
  const coordinator = coordinatorRef.current;

  // A changed external identity cancels all internal in-flight custody. Until
  // this effect runs, every selector below fails closed on the scope mismatch.
  useEffect(() => {
    coordinator.reconcileScope(scope);
    hostChoiceScopeRef.current = scope;
    setHostChoices([]);
  }, [coordinator, scope]);
  useEffect(() => { setCapabilityError(null); }, [activeServer?.id, viewer?.userId]);

  const handleAttentionEvent = useCallback((event: ServerEvent): void => {
    if (!mayHandleAttentionEvent(event.type, canInvokeAgentsRef.current)) return;
    const currentScope = scopeRef.current;
    if (!currentScope) return;
    if (!mayAdmitAttentionEvent(currentScope, event)) return;
    switch (event.type) {
      case "approval.ask": {
        const approval = approvalForMobile(event);
        coordinator.receiveApproval(currentScope, approval, shouldAutoResolveAsk({
          enabled: autoApproveEnabledRef.current,
          hasNetworkContext: event.network != null,
          requiresExplicitReview: event.requiresExplicitReview === true,
          structuredSshHostTrust: event.structuredSsh?.hostTrust,
        }));
        return;
      }
      case "approval.resolved":
        coordinator.receiveResolvedApproval(currentScope, event);
        return;
      case "prove_it.challenge":
        coordinator.receiveChallenge(currentScope, { kind: "prove_it", event });
        return;
      case "identity.challenge":
        coordinator.receiveChallenge(currentScope, { kind: "identity", event });
        return;
      case "host.choice":
        setHostChoices((previous) => {
          if (!sameAttentionScope(scopeRef.current, currentScope)) return previous;
          hostChoiceScopeRef.current = currentScope;
          return [...previous.filter((choice) => choice.choiceId !== event.choiceId), event];
        });
        return;
      case "message.new": {
        const roomId = roomIdFromLaneKey(event.laneKey);
        if (roomId === null) return;
        setHostChoices((previous) => previous.filter((choice) => roomIdFromLaneKey(choice.laneKey) !== roomId));
        return;
      }
      default:
        return;
    }
  }, [coordinator]);

  useEffect(() => subscribe(handleAttentionEvent), [handleAttentionEvent, subscribe]);

  // Live approval frames are intentionally ephemeral, but a parked Task
  // checkpoint is durable. Rehydrate only after the post-connect viewer
  // refresh has established the final security epoch; scope changes cancel
  // the response before it can cross a re-auth or server boundary.
  useEffect(() => {
    if (!scope || openRevision === 0) return;
    const requestedScope = scope;
    let cancelled = false;
    void getApiClient(scope.serverUrl).listPendingTaskAttention().then((events) => {
      if (cancelled || !sameAttentionScope(scopeRef.current, requestedScope)) return;
      for (const event of events) handleAttentionEvent(event);
    }).catch(() => {
      // Best effort. A future reconnect/foreground transition retries, while
      // canonical Task state remains visible as awaiting.
    });
    return () => { cancelled = true; };
  }, [handleAttentionEvent, openRevision, scope]);

  const currentAuthority = sameAttentionScope(authority.scope, scope) ? authority : null;
  const visibleApprovals = currentAuthority?.approvals
    .filter((record) => !record.hidden)
    .map((record) => record.approval) ?? [];
  const visibleChallenge = currentAuthority?.challenge?.presented
    ? currentAuthority.challenge.challenge
    : null;
  const currentRoom = roomIdFromPath(pathname);

  const pendingApprovalForRoom = useCallback((roomId: string): ApprovalAskEvent | null =>
    visibleApprovals.find((approval) => roomIdFromLaneKey(approval.laneKey) === roomId) ?? null,
  [visibleApprovals]);
  const pendingApprovalForTask = useCallback((taskId: string, taskRunId?: string | null): ApprovalAskEvent | null =>
    visibleApprovals.find((approval) => taskApprovalMatches(approval, taskId, taskRunId)) ?? null,
  [visibleApprovals]);
  const activeChallengeForTask = useCallback((taskId: string, taskRunId?: string | null): PinChallenge | null => {
    const challenge = currentAuthority?.challenge?.challenge;
    if (challenge?.kind === "identity" && isExpiredChallenge(challenge.event)) return null;
    return challenge && taskChallengeMatches(challenge.event as TaskPinChallengeEvent, taskId, taskRunId) ? challenge : null;
  }, [currentAuthority]);
  const presentChallenge = useCallback((expected: PinChallenge): void => {
    const currentScope = scopeRef.current;
    if (currentScope) coordinator.presentChallenge(currentScope, expected);
  }, [coordinator]);
  const dismissChallenge = useCallback((expected: PinChallenge): void => {
    const currentScope = scopeRef.current;
    if (currentScope) coordinator.hideChallenge(currentScope, expected);
  }, [coordinator]);
  const resolveChallenge = useCallback<AttentionValue["resolveChallenge"]>((expected, pin) => {
    const currentScope = scopeRef.current;
    return currentScope ? coordinator.resolveChallenge(currentScope, expected, pin) : Promise.resolve({ ok: false });
  }, [coordinator]);
  const denyChallenge = useCallback<AttentionValue["denyChallenge"]>((expected) => {
    const currentScope = scopeRef.current;
    return currentScope ? coordinator.denyChallenge(currentScope, expected) : Promise.resolve({ ok: false });
  }, [coordinator]);
  const replyToApproval = useCallback<AttentionValue["replyToApproval"]>((approval, verb) => {
    const currentScope = scopeRef.current;
    return currentScope ? coordinator.replyApproval(currentScope, approval, verb) : Promise.resolve({ ok: false });
  }, [coordinator]);

  useEffect(() => {
    const record = currentAuthority?.challenge;
    const currentScope = scopeRef.current;
    if (!record || !currentScope || record.challenge.kind !== "identity") return;
    const expiresAt = Date.parse(record.challenge.event.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      coordinator.expireChallenge(currentScope, record.challenge);
      return;
    }
    const timeout = setTimeout(() => coordinator.expireChallenge(currentScope, record.challenge), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [coordinator, currentAuthority, scope]);

  const pendingHostChoiceForRoom = useCallback((roomId: string): HostChoiceEvent | null =>
    sameAttentionScope(hostChoiceScopeRef.current, scopeRef.current)
      ? hostChoices.find((choice) => roomIdFromLaneKey(choice.laneKey) === roomId) ?? null
      : null,
  [hostChoices]);
  const replyToHostChoice = useCallback<AttentionValue["replyToHostChoice"]>(async (choice, selector) => {
    const currentScope = scopeRef.current;
    if (!currentScope || !sameAttentionScope(hostChoiceScopeRef.current, currentScope) || !hostChoices.includes(choice)) return { ok: false };
    try {
      const result = await getApiClient(currentScope.serverUrl).hostChoiceReply(choice.choiceId, selector, choice.threadId, choice.laneKey);
      if (result?.ok && sameAttentionScope(scopeRef.current, currentScope)) {
        setHostChoices((previous) => previous.filter((item) => item !== choice));
      }
      return { ok: Boolean(result?.ok) };
    } catch (error) {
      await reportCapabilityDenial(error, { serverId: currentScope.serverId, userId: currentScope.userId });
      return { ok: false };
    }
  }, [hostChoices, reportCapabilityDenial]);

  const attentionApproval = useMemo<ApprovalAskEvent | null>(() => {
    for (const approval of visibleApprovals) {
      if (approval.origin === "task") return approval;
      const roomId = roomIdFromLaneKey(approval.laneKey);
      if (roomId === null || roomId !== currentRoom) return approval;
    }
    return null;
  }, [currentRoom, visibleApprovals]);
  const attentionHostChoice = useMemo<HostChoiceEvent | null>(() => {
    if (!sameAttentionScope(hostChoiceScopeRef.current, scopeRef.current)) return null;
    for (const choice of hostChoices) {
      const roomId = roomIdFromLaneKey(choice.laneKey);
      if (roomId === null || roomId !== currentRoom) return choice;
    }
    return null;
  }, [currentRoom, hostChoices]);
  const dismissCapabilityError = useCallback(() => setCapabilityError(null), []);

  const value = useMemo<AttentionValue>(() => ({
    pendingApprovals: visibleApprovals,
    capabilityError,
    dismissCapabilityError,
    attentionApproval,
    attentionHostChoice,
    activeChallenge: visibleChallenge,
    pendingApprovalForRoom,
    pendingApprovalForTask,
    activeChallengeForTask,
    presentChallenge,
    pendingHostChoiceForRoom,
    replyToHostChoice,
    replyToApproval,
    resolveChallenge,
    denyChallenge,
    dismissChallenge,
  }), [
    activeChallengeForTask,
    attentionApproval,
    attentionHostChoice,
    capabilityError,
    denyChallenge,
    dismissCapabilityError,
    dismissChallenge,
    pendingApprovalForRoom,
    pendingApprovalForTask,
    pendingHostChoiceForRoom,
    presentChallenge,
    replyToApproval,
    replyToHostChoice,
    resolveChallenge,
    visibleApprovals,
    visibleChallenge,
  ]);

  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}

export function useAttention(): AttentionValue {
  const context = useContext(AttentionContext);
  if (!context) throw new Error("useAttention must be used within AttentionProvider");
  return context;
}
