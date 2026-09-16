import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "../../../lib/api";
import { useToast } from "../../../components/toast";
import { useAuth } from "../../../hooks/use-auth";
import {
  isAskUserCandidate,
  subscribeAskUserPicker,
} from "../../../components/composer/ask-user-state";
import {
  resolveFocusRing,
  isRingTarget,
  isHeldFocus,
  type ActiveFocusLite,
  type FocusRing,
} from "./members-panel-model";
import { formatFocusReason, type FocusSource } from "./focus-reason";

/**
 * D278 P2 — the Conversational Focus data layer, extracted from
 * `RoomFocusControls` so both the members drawer and the compact column can
 * render the per-avatar focus ring from one source.
 *
 * Focus is **viewer-private** (`GET /api/rooms/:id/focus` returns only the
 * requester's foci), a **set** of per-bot links with a sliding 90s TTL. The
 * ring marks the single *routing target* (see `resolveFocusRing`); held-but-
 * ambiguous foci get a subtle dot.
 */

interface FocusEntry {
  readonly focusId: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly source: FocusSource;
  readonly reason: string | null;
}

const EXPIRING_SOON_MS = 15_000;
/** Mirrors the server's sliding focus window (packages/trust FOCUS_TTL_MS). */
const FOCUS_TTL_MS = 90_000;

export type ConductorFocusChangedDetail = {
  roomId: string;
  userActorId: string;
  change: "opened" | "extended" | "cleared";
  botActorId: string;
  source: FocusSource;
  reason: string | null;
};

export interface RoomFocusState {
  /** The routing-target ring (single / ambiguous / none). */
  readonly ring: FocusRing;
  /** Is this bot the sole routing target (gets the ring)? */
  readonly isTarget: (botActorId: string) => boolean;
  /** Is this bot held in focus but ambiguous (gets a subtle dot)? */
  readonly isHeld: (botActorId: string) => boolean;
  /** Is this bot's focus within the expiring-soon window? */
  readonly isExpiringSoon: (botActorId: string) => boolean;
  /** Whole seconds left on this bot's focus, or null if not focused. */
  readonly secondsLeft: (botActorId: string) => number | null;
  /** Fraction of the focus window remaining (0..1), or null if not focused. */
  readonly remainingFraction: (botActorId: string) => number | null;
  /** Short friendly routing reason for tooltips, or null when not focused. */
  readonly reasonFor: (botActorId: string) => string | null;
  /** Per-bot in-flight flag for the open/clear toggle. */
  readonly isBusy: (botActorId: string) => boolean;
  /** Open focus if inactive, clear it if active. No message is sent. */
  readonly toggle: (botActorId: string) => void;
  /**
   * Requester-private access recency for eligible Genies in this room.
   * Optional while legacy focus providers which have no access-history source
   * remain mounted; consumers fall back to their stable roster ordering.
   */
  readonly recentBotActorIds?: readonly string[];
  readonly refresh: () => Promise<void>;
}

export function useRoomFocus(roomId: string | null): RoomFocusState {
  const toast = useToast();
  const viewerActorId = useAuth().viewer.sessionActorId;
  const [focusByBot, setFocusByBot] = useState<Map<string, FocusEntry>>(() => new Map());
  const [recentBotActorIds, setRecentBotActorIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  const [, setAskUserTick] = useState(0);

  useEffect(() => subscribeAskUserPicker(() => setAskUserTick((n) => n + 1)), []);

  const refresh = useCallback(async () => {
    if (!roomId) {
      setFocusByBot(new Map());
      setRecentBotActorIds([]);
      return;
    }
    try {
      const { foci, recentBotActorIds: recent } = await apiClient.getRoomFocus(roomId);
      const map = new Map<string, FocusEntry>();
      for (const f of foci) {
        const row = f as typeof f & { source?: FocusSource; reason?: string | null };
        map.set(f.botActorId, {
          focusId: f.focusId,
          expiresAt: new Date(f.expiresAt).getTime(),
          source: row.source ?? null,
          reason: row.reason ?? null,
        });
      }
      setFocusByBot(map);
      setRecentBotActorIds(recent);
    } catch {
      // Background focus hydration is a passive enhancement. During dev-stack
      // restarts / reconnects, surfacing a toast here creates user-visible spam
      // while the websocket layer is already reporting reconnect state. Keep the
      // last-known focus locally and let the next refresh/event repair it.
    }
  }, [roomId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onFocusChanged = (ev: Event): void => {
      const detail = (ev as CustomEvent<ConductorFocusChangedDetail>).detail;
      if (!detail || detail.roomId !== roomId) return;
      // Focus is viewer-private; only act on events for this viewer when known.
      // When sessionActorId is unavailable (guest/loading), roomId-only gating is
      // safe — GET /api/rooms/:id/focus returns only the requester's foci anyway.
      if (viewerActorId != null && detail.userActorId !== viewerActorId) return;

      if (detail.change === "cleared") {
        setFocusByBot((prev) => {
          const next = new Map(prev);
          next.delete(detail.botActorId);
          return next;
        });
      } else {
        setFocusByBot((prev) => {
          const existing = prev.get(detail.botActorId);
          const next = new Map(prev);
          next.set(detail.botActorId, {
            focusId: existing?.focusId ?? "",
            expiresAt: existing?.expiresAt ?? Date.now() + FOCUS_TTL_MS,
            source: detail.source,
            reason: detail.reason,
          });
          return next;
        });
      }
      void refresh();
    };
    window.addEventListener("nautilo:conductor-focus-changed", onFocusChanged);
    return () => window.removeEventListener("nautilo:conductor-focus-changed", onFocusChanged);
  }, [roomId, viewerActorId, refresh]);

  // Local TTL tick so the ring expires / shows "expiring soon" without refetch.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ring = useMemo<FocusRing>(() => {
    const active: ActiveFocusLite[] = [];
    for (const [botActorId, entry] of focusByBot) {
      active.push({ botActorId, expiresAt: entry.expiresAt });
    }
    return resolveFocusRing(active, now);
  }, [focusByBot, now]);

  const toggle = useCallback(
    (botActorId: string) => {
      if (!roomId) return;
      const entry = focusByBot.get(botActorId);
      const active = entry != null && entry.expiresAt > Date.now();
      setBusy((s) => ({ ...s, [botActorId]: true }));
      void (async () => {
        try {
          if (active && entry) {
            await apiClient.clearRoomFocus(roomId, entry.focusId);
          } else {
            await apiClient.openRoomFocus(roomId, botActorId);
          }
          await refresh();
        } catch (e) {
          toast.show({
            variant: "error",
            title: active ? "Could not clear focus" : "Could not open focus",
            message: e instanceof Error ? e.message : "Unknown error.",
          });
        } finally {
          setBusy((s) => {
            const { [botActorId]: _drop, ...rest } = s;
            return rest;
          });
        }
      })();
    },
    [roomId, focusByBot, refresh, toast],
  );

  const reasonFor = useCallback(
    (botActorId: string): string | null => {
      const entry = focusByBot.get(botActorId);
      if (!entry || entry.expiresAt <= now) return null;
      return formatFocusReason({ source: entry.source, reason: entry.reason });
    },
    [focusByBot, now],
  );

  return {
    ring,
    isTarget: (botActorId) => isRingTarget(ring, botActorId),
    isHeld: (botActorId) =>
      isHeldFocus(ring, botActorId) || isAskUserCandidate(botActorId),
    isExpiringSoon: (botActorId) => {
      const entry = focusByBot.get(botActorId);
      return entry != null && entry.expiresAt > now && entry.expiresAt - now <= EXPIRING_SOON_MS;
    },
    secondsLeft: (botActorId) => {
      const entry = focusByBot.get(botActorId);
      if (!entry || entry.expiresAt <= now) return null;
      return Math.ceil((entry.expiresAt - now) / 1000);
    },
    remainingFraction: (botActorId) => {
      const entry = focusByBot.get(botActorId);
      if (!entry || entry.expiresAt <= now) return null;
      return Math.max(0, Math.min(1, (entry.expiresAt - now) / FOCUS_TTL_MS));
    },
    reasonFor,
    isBusy: (botActorId) => busy[botActorId] === true,
    toggle,
    recentBotActorIds,
    refresh,
  };
}
