import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { NotificationStateResponse, ServerEvent } from "@nautilo/types";

import { getApiClient } from "@/lib/api";
import {
  applyMobileNotificationDelta,
  applyMobileNotificationLoad,
  canApplyMobileNotificationRequest,
  notificationAttentionPresentation,
  pruneMobileNotificationSnapshots,
  type MobileAttentionServerSnapshot,
  type MobileNotificationAttentionPresentation,
} from "@/lib/mobile-notification-attention";
import {
  createMobileNotificationStateLoader,
  loadMobileNotificationStateBatch,
  type MobileNotificationStateLoader,
} from "@/lib/push-badge-reconciler";
import { useAuth } from "@/providers/auth";
import { usePushLifecycle } from "@/providers/push-lifecycle";
import { useRealtime } from "@/providers/realtime";
import { useServers } from "@/providers/server-registry";

export interface MobileServerAttention extends MobileNotificationAttentionPresentation {
  readonly stale: boolean;
}

interface NotificationStateValue {
  readonly activeSnapshot: NotificationStateResponse | null;
  readonly activeAttention: MobileNotificationAttentionPresentation | null;
  readonly roomAttention: (roomId: string, label: string) => MobileNotificationAttentionPresentation | null;
  readonly serverAttention: (serverId: string, label: string) => MobileServerAttention | null;
  readonly refresh: () => Promise<void>;
}

const NotificationStateContext = createContext<NotificationStateValue | null>(null);

function serverAttention(
  entry: MobileAttentionServerSnapshot | undefined,
  label: string,
): MobileServerAttention | null {
  if (!entry) return null;
  const presentation = notificationAttentionPresentation({
    unreadCount: entry.snapshot.totals.unreadCount,
    importantUnreadCount: entry.snapshot.totals.importantUnreadCount,
    label,
  });
  if (!presentation) return null;
  return {
    ...presentation,
    stale: entry.stale,
    accessibilityLabel: entry.stale
      ? `Last known — ${presentation.accessibilityLabel}`
      : presentation.accessibilityLabel,
  };
}

/**
 * Mobile's one in-app projection of canonical notification state. The active
 * server is kept current from its live delta stream; inactive servers are
 * refreshed through the badge reconciler's isolated headless auth/client
 * loader and retain an explicitly labelled last-known snapshot on failure.
 */
export function NotificationStateProvider({ children }: { readonly children: ReactNode }) {
  const { servers, activeServer } = useServers();
  const { status, viewer } = useAuth();
  const { recoveryRevision, subscribe } = useRealtime();
  const { activationRevision, refreshBadge } = usePushLifecycle();
  const activeViewerId = status === "signed-in" ? viewer?.userId ?? null : null;
  const activeIdentityKey = activeServer && activeViewerId ? `${activeServer.id}:${activeViewerId}` : null;
  const loaderRef = useRef<MobileNotificationStateLoader | null>(null);
  if (!loaderRef.current) loaderRef.current = createMobileNotificationStateLoader();
  const snapshotsRef = useRef<ReadonlyMap<string, MobileAttentionServerSnapshot>>(new Map());
  const activeRequestGenerationRef = useRef(0);
  const inactiveRequestGenerationRef = useRef(0);
  const activeIdentityRef = useRef<{ serverId: string | null; viewerId: string | null }>({ serverId: null, viewerId: null });
  const identityKeyRef = useRef<string | null>(activeIdentityKey);
  identityKeyRef.current = activeIdentityKey;
  const [snapshots, setSnapshots] = useState<ReadonlyMap<string, MobileAttentionServerSnapshot>>(new Map());

  const publish = useCallback((next: ReadonlyMap<string, MobileAttentionServerSnapshot>) => {
    snapshotsRef.current = next;
    setSnapshots(next);
  }, []);

  const update = useCallback((apply: (current: ReadonlyMap<string, MobileAttentionServerSnapshot>) => ReadonlyMap<string, MobileAttentionServerSnapshot>) => {
    const next = apply(snapshotsRef.current);
    publish(next);
  }, [publish]);

  useEffect(() => {
    const previous = activeIdentityRef.current;
    const next = { serverId: activeServer?.id ?? null, viewerId: activeViewerId };
    activeIdentityRef.current = next;
    if (previous.serverId !== next.serverId || previous.viewerId === next.viewerId) return;
    activeRequestGenerationRef.current += 1;
    update((current) => {
      const snapshots = new Map(current);
      snapshots.delete(next.serverId!);
      return snapshots;
    });
  }, [activeServer?.id, activeViewerId, update]);

  const refreshActive = useCallback(async (): Promise<void> => {
    const server = activeServer;
    const generation = ++activeRequestGenerationRef.current;
    const requestIdentityKey = activeIdentityKey;
    if (!server || !activeViewerId || !requestIdentityKey) return;
    try {
      const snapshot = await getApiClient(server.serverUrl).getNotificationState();
      if (!canApplyMobileNotificationRequest({
        requestGeneration: generation,
        currentGeneration: activeRequestGenerationRef.current,
        requestIdentityKey,
        currentIdentityKey: identityKeyRef.current,
      })) return;
      update((current) => applyMobileNotificationLoad(current, server.id, { kind: "fresh", snapshot }, activeViewerId));
    } catch {
      if (!canApplyMobileNotificationRequest({
        requestGeneration: generation,
        currentGeneration: activeRequestGenerationRef.current,
        requestIdentityKey,
        currentIdentityKey: identityKeyRef.current,
      })) return;
      update((current) => applyMobileNotificationLoad(current, server.id, { kind: "unavailable" }, activeViewerId));
    }
  }, [activeIdentityKey, activeServer, activeViewerId, update]);

  const refreshInactive = useCallback(async (): Promise<void> => {
    const generation = ++inactiveRequestGenerationRef.current;
    const inactive = servers.filter((server) => server.id !== activeServer?.id);
    if (!activeViewerId) return;
    const results = await loadMobileNotificationStateBatch(inactive, loaderRef.current!);
    for (const server of inactive) {
      const result = results.get(server.id) ?? { kind: "unavailable" };
      if (generation !== inactiveRequestGenerationRef.current) return;
      update((current) => applyMobileNotificationLoad(current, server.id, result));
    }
  }, [activeServer?.id, activeViewerId, servers, update]);

  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([refreshActive(), refreshInactive()]);
  }, [refreshActive, refreshInactive]);

  // Reset removed and explicitly signed-out state immediately. Existing
  // inactive state deliberately survives a transient refresh failure.
  useEffect(() => {
    const currentIds = new Set(servers.map((server) => server.id));
    update((current) => pruneMobileNotificationSnapshots(current, currentIds, activeServer?.id ?? null, activeViewerId !== null));
  }, [activeServer?.id, activeViewerId, servers, update]);

  useEffect(() => {
    if (!activeViewerId) return;
    void refresh();
  }, [activeIdentityKey, refresh]);

  const previousActivationRevisionRef = useRef(activationRevision);
  useEffect(() => {
    const previous = previousActivationRevisionRef.current;
    previousActivationRevisionRef.current = activationRevision;
    if (!activeViewerId || activationRevision <= previous) return;
    // Realtime owns the active Server's foreground repair. Activation only
    // refreshes inactive Servers, which have no resumed socket of their own.
    void refreshInactive();
  }, [activationRevision, activeViewerId, refreshInactive]);

  const previousRecoveryRevisionRef = useRef(recoveryRevision);
  useEffect(() => {
    const previous = previousRecoveryRevisionRef.current;
    previousRecoveryRevisionRef.current = recoveryRevision;
    if (!activeViewerId || recoveryRevision <= previous) return;
    void refreshActive();
  }, [activeViewerId, recoveryRevision, refreshActive]);

  useEffect(() => {
    if (!activeServer || !activeViewerId) return;
    const client = getApiClient(activeServer.serverUrl);
    client.setNotificationStateInvalidationHandler(() => {
      void Promise.all([refreshActive(), refreshBadge()]);
    });
    return () => client.setNotificationStateInvalidationHandler(null);
  }, [activeServer, activeViewerId, refreshActive, refreshBadge]);

  useEffect(() => {
    if (!activeServer || !activeViewerId) return;
    return subscribe((event: ServerEvent) => {
      if (event.type !== "room.notification.changed" || event.userId !== viewer?.userId) return;
      const patched = applyMobileNotificationDelta(snapshotsRef.current, activeServer.id, event);
      if (patched.kind === "dirty") {
        void Promise.all([refreshActive(), refreshBadge()]);
        return;
      }
      update(() => patched.snapshots);
      void refreshBadge();
    });
  }, [activeServer, activeViewerId, refreshActive, refreshBadge, subscribe, update, viewer?.userId]);

  const activeEntry = activeServer ? snapshots.get(activeServer.id) : undefined;
  const activeSnapshot = activeEntry?.viewerId === activeViewerId ? activeEntry.snapshot : null;
  const activeAttention = activeSnapshot
    ? notificationAttentionPresentation({
      unreadCount: activeSnapshot.totals.unreadCount,
      importantUnreadCount: activeSnapshot.totals.importantUnreadCount,
      label: "Chats",
    })
    : null;
  const value = useMemo<NotificationStateValue>(() => ({
    activeSnapshot,
    activeAttention,
    roomAttention: (roomId, label) => {
      const room = activeSnapshot?.rooms.find((candidate) => candidate.roomId === roomId);
      return room ? notificationAttentionPresentation({
        unreadCount: room.unreadCount,
        importantUnreadCount: room.importantUnreadCount,
        label,
      }) : null;
    },
    serverAttention: (serverId, label) => {
      return serverAttention(snapshots.get(serverId), label);
    },
    refresh,
  }), [activeAttention, activeSnapshot, refresh, snapshots]);

  return <NotificationStateContext.Provider value={value}>{children}</NotificationStateContext.Provider>;
}

export function useNotificationState(): NotificationStateValue {
  const value = useContext(NotificationStateContext);
  if (!value) throw new Error("useNotificationState must be used within NotificationStateProvider");
  return value;
}
