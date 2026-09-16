import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { NotificationStateResponse, ServerEvent } from "@nautilo/types";

import { getApiClient } from "@/lib/api";
import {
  applyMobileNotificationDelta,
  notificationAttentionPresentation,
  type MobileNotificationAttentionPresentation,
} from "@/lib/mobile-notification-attention";
import { useAuth } from "@/providers/auth";
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

/** Current-origin, in-app state only. Web v1 owns no inactive-server or OS badge worker. */
export function NotificationStateProvider({ children }: { readonly children: ReactNode }) {
  const { activeServer } = useServers();
  const { status, viewer } = useAuth();
  const { recoveryRevision, subscribe } = useRealtime();
  const generationRef = useRef(0);
  const [snapshot, setSnapshot] = useState<NotificationStateResponse | null>(null);
  const activeViewerId = status === "signed-in" ? viewer?.userId ?? null : null;

  const refresh = useCallback(async () => {
    const server = activeServer;
    const viewerId = activeViewerId;
    const generation = ++generationRef.current;
    if (!server || !viewerId) { setSnapshot(null); return; }
    try {
      const next = await getApiClient(server.serverUrl).getNotificationState();
      if (generationRef.current === generation) setSnapshot(next);
    } catch {
      if (generationRef.current === generation) setSnapshot(null);
    }
  }, [activeServer, activeViewerId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const previousRecoveryRevisionRef = useRef(recoveryRevision);
  useEffect(() => {
    const previous = previousRecoveryRevisionRef.current;
    previousRecoveryRevisionRef.current = recoveryRevision;
    if (recoveryRevision > previous) void refresh();
  }, [recoveryRevision, refresh]);
  useEffect(() => {
    if (!activeServer || !activeViewerId) return;
    return subscribe((event: ServerEvent) => {
      if (event.type !== "room.notification.changed" || event.userId !== activeViewerId) return;
      setSnapshot((current) => {
        if (!current) { void refresh(); return current; }
        const snapshots = new Map([[activeServer.id, { snapshot: current, stale: false, viewerId: activeViewerId }]]);
        const patched = applyMobileNotificationDelta(snapshots, activeServer.id, event);
        if (patched.kind === "dirty") { void refresh(); return current; }
        return patched.snapshots.get(activeServer.id)?.snapshot ?? null;
      });
    });
  }, [activeServer, activeViewerId, refresh, subscribe]);

  const activeAttention = snapshot ? notificationAttentionPresentation({
    unreadCount: snapshot.totals.unreadCount,
    importantUnreadCount: snapshot.totals.importantUnreadCount,
    label: "Chats",
  }) : null;
  const value = useMemo<NotificationStateValue>(() => ({
    activeSnapshot: snapshot,
    activeAttention,
    roomAttention: (roomId, label) => {
      const room = snapshot?.rooms.find((candidate) => candidate.roomId === roomId);
      return room ? notificationAttentionPresentation({
        unreadCount: room.unreadCount,
        importantUnreadCount: room.importantUnreadCount,
        label,
      }) : null;
    },
    serverAttention: (serverId, label) => {
      if (!activeServer || activeServer.id !== serverId || !snapshot) return null;
      const presentation = notificationAttentionPresentation({
        unreadCount: snapshot.totals.unreadCount,
        importantUnreadCount: snapshot.totals.importantUnreadCount,
        label,
      });
      return presentation ? { ...presentation, stale: false } : null;
    },
    refresh,
  }), [activeAttention, activeServer, refresh, snapshot]);
  return <NotificationStateContext.Provider value={value}>{children}</NotificationStateContext.Provider>;
}

export function useNotificationState(): NotificationStateValue {
  const value = useContext(NotificationStateContext);
  if (!value) throw new Error("useNotificationState must be used within NotificationStateProvider");
  return value;
}
