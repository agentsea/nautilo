// D408 — viewer-private conductor focus state for a room. Hydrates from
// GET /api/rooms/:id/focus, toggles via open/clear, refreshes on
// conductor.focus_changed WS events.
import { useCallback, useEffect, useMemo, useState } from "react";

import { getApiClient } from "@/lib/api";
import { useRealtime } from "@/providers/realtime";

export type RoomFocusEntry = {
  focusId: string;
  expiresAt: string;
};

export type RoomFocusMap = Record<string, RoomFocusEntry>;

export function useRoomFocus(
  serverUrl: string | undefined,
  roomId: string | undefined,
  viewerActorId?: string | null,
) {
  const { subscribe } = useRealtime();
  const [fociRaw, setFociRaw] = useState<RoomFocusMap>({});
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    if (!serverUrl || !roomId) {
      setFociRaw({});
      return;
    }
    try {
      const { foci } = await getApiClient(serverUrl).getRoomFocus(roomId);
      const map: RoomFocusMap = {};
      for (const f of foci) {
        map[f.botActorId] = { focusId: f.focusId, expiresAt: f.expiresAt };
      }
      setFociRaw(map);
    } catch {
      // Background hydration — keep last-known focus on transient failures.
    }
  }, [serverUrl, roomId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!roomId) return;
    return subscribe((event) => {
      if (event.type === "conductor.focus_changed") {
        if (event.roomId !== roomId) return;
        if (viewerActorId != null && event.userActorId !== viewerActorId) return;
        void refresh();
        return;
      }
      if (event.type === "room.conductor_mode.changed") {
        if (event.roomId !== roomId) return;
        void refresh();
      }
    });
  }, [subscribe, roomId, viewerActorId, refresh]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const foci = useMemo(() => {
    const active: RoomFocusMap = {};
    for (const [botActorId, entry] of Object.entries(fociRaw)) {
      if (new Date(entry.expiresAt).getTime() > now) {
        active[botActorId] = entry;
      }
    }
    return active;
  }, [fociRaw, now]);

  const primaryFocusedBotActorId = useMemo(() => {
    // The DTO has no activation timestamp. Focuses share a duration, so the
    // latest expiry is the best available proxy for most recently activated;
    // actor ID makes equal expiries deterministic.
    return (
      Object.entries(foci)
        .sort(([leftId, left], [rightId, right]) => {
          const expiryDifference =
            new Date(right.expiresAt).getTime() - new Date(left.expiresAt).getTime();
          return expiryDifference !== 0 ? expiryDifference : leftId.localeCompare(rightId);
        })
        .at(0)?.[0] ?? null
    );
  }, [foci]);

  const isFocused = useCallback(
    (botActorId: string) => foci[botActorId] != null,
    [foci],
  );

  const secondsLeft = useCallback(
    (botActorId: string): number | null => {
      const entry = foci[botActorId];
      if (!entry) return null;
      const ms = new Date(entry.expiresAt).getTime() - now;
      if (ms <= 0) return null;
      return Math.ceil(ms / 1000);
    },
    [foci, now],
  );

  const toggleFocus = useCallback(
    (botActorId: string) => {
      if (!serverUrl || !roomId) return;
      const entry = foci[botActorId];
      void (async () => {
        try {
          const client = getApiClient(serverUrl);
          if (entry) {
            await client.clearRoomFocus(roomId, entry.focusId);
          } else {
            await client.openRoomFocus(roomId, botActorId);
          }
          await refresh();
        } catch {
          // silent — next refresh/event repairs state
        }
      })();
    },
    [serverUrl, roomId, foci, refresh],
  );

  return {
    foci,
    primaryFocusedBotActorId,
    // Compatibility alias for chat screens that have not adopted the primary name.
    focusedBotActorId: primaryFocusedBotActorId,
    isFocused,
    secondsLeft,
    toggleFocus,
    refresh,
  };
}
