import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { apiClient } from "../../../lib/api";
import { useToast } from "../../../components/toast";
import {
  getMaintenanceNoticeSnapshot,
  subscribeMaintenanceNotice,
} from "../../../components/maintenance-notice-state";

export type SilenceState = {
  id: string;
  kind: "mute" | "deaf";
  botActorId: string | null;
  botDisplayName: string | null;
  setByDisplayName: string;
  expiresAt: string;
};

const POLL_MS = 30_000;

function formatCountdown(expiresAtMs: number, nowMs: number): string {
  const secondsLeft = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  if (secondsLeft <= 0) return "0:00";
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Pure copy builder — exported for unit tests (D190 MR3 copy accuracy). */
export function buildSilenceBannerCopy(
  silence: SilenceState,
  nowMs: number,
): { headline: string; detail: string } | null {
  const expiresAtMs = new Date(silence.expiresAt).getTime();
  if (expiresAtMs <= nowMs) return null;

  const countdown = formatCountdown(expiresAtMs, nowMs);
  const isDeaf = silence.kind === "deaf";
  const targetLabel =
    silence.botDisplayName != null && silence.botDisplayName.length > 0
      ? silence.botDisplayName
      : "bots";

  return {
    headline: isDeaf
      ? `Bots out of the room · ${countdown}`
      : `${silence.setByDisplayName} muted ${targetLabel} · ${countdown}`,
    detail: isDeaf
      ? `${silence.setByDisplayName} put ${targetLabel} out of the room`
      : "Bots are muted but still listening",
  };
}

export function formatSilenceCountdown(silence: SilenceState, nowMs: number): string | null {
  const expiresAtMs = new Date(silence.expiresAt).getTime();
  if (expiresAtMs <= nowMs) return null;
  return formatCountdown(expiresAtMs, nowMs);
}

export function useRoomSilence(roomId: string): {
  readonly silence: SilenceState | null;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly now: number;
  readonly start: (kind: "mute" | "deaf", durationMs?: number) => void;
  readonly clear: () => void;
} {
  const toast = useToast();
  const maintenance = useSyncExternalStore(
    subscribeMaintenanceNotice,
    getMaintenanceNoticeSnapshot,
    getMaintenanceNoticeSnapshot,
  );
  const [silence, setSilence] = useState<SilenceState | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    // During a planned replacement, this endpoint is expected to be
    // temporarily unavailable. Keep the last known state instead of polling a
    // server that is draining or offline, then refresh when maintenance ends.
    if (getMaintenanceNoticeSnapshot().kind !== "normal") return;

    try {
      const res = await apiClient.getRoomSilence(roomId);
      // A response from the server being replaced is not useful once the
      // renderer has learned that maintenance started.
      if (getMaintenanceNoticeSnapshot().kind !== "normal") return;
      setSilence(res.silence);
      setCanManage(res.canManage);
    } catch (e) {
      // The request may have started immediately before a maintenance frame.
      // Suppress that expected failure, but leave ordinary failures actionable.
      if (getMaintenanceNoticeSnapshot().kind !== "normal") return;
      toast.show({
        variant: "error",
        title: "Could not load silence state",
        message: e instanceof Error ? e.message : "Unknown error.",
      });
    }
  }, [roomId, toast]);

  useEffect(() => {
    if (maintenance.kind === "normal") {
      void refresh();
    }
  }, [maintenance.kind, refresh]);

  useEffect(() => {
    const onSilenceChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ roomId?: string; silence?: SilenceState | null }>)
        .detail;
      if (detail?.roomId !== roomId) return;
      setSilence(detail.silence ?? null);
    };
    window.addEventListener("nautilo:room-silence-changed", onSilenceChanged);
    return () => window.removeEventListener("nautilo:room-silence-changed", onSilenceChanged);
  }, [roomId]);

  useEffect(() => {
    const pollId = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(pollId);
  }, [refresh]);

  useEffect(() => {
    const tickId = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickId);
  }, []);

  const clear = useCallback(() => {
    if (!canManage || busy) return;
    setBusy(true);
    void (async () => {
      try {
        const res = await apiClient.clearRoomSilence(roomId);
        setSilence(res.silence);
        setCanManage(true);
      } catch (e) {
        toast.show({
          variant: "error",
          title: "Could not clear silence",
          message: e instanceof Error ? e.message : "Unknown error.",
        });
      } finally {
        setBusy(false);
      }
    })();
  }, [busy, canManage, roomId, toast]);

  const start = useCallback(
    (kind: "mute" | "deaf", durationMs?: number) => {
      if (!canManage || busy) return;
      setBusy(true);
      void (async () => {
        try {
          const res = await apiClient.setRoomSilence(roomId, {
            kind,
            ...(durationMs !== undefined ? { durationMs } : {}),
          });
          setSilence(res.silence);
        } catch (e) {
          toast.show({
            variant: "error",
            title: "Could not silence bots",
            message: e instanceof Error ? e.message : "Unknown error.",
          });
        } finally {
          setBusy(false);
        }
      })();
    },
    [busy, canManage, roomId, toast],
  );

  return { silence, canManage, busy, now, start, clear };
}
