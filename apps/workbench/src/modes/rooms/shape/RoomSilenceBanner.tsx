import type { ReactElement } from "react";
import {
  buildSilenceBannerCopy,
  formatSilenceCountdown,
  useRoomSilence,
} from "./use-room-silence";

/**
 * D190 MR3 — room header chip for active mute/deaf windows only.
 * Visible to all members; managers can dismiss early. Idle triggers live
 * in MembersPanel (D279 silence-UX relocation).
 */
export function RoomSilenceBanner({
  roomId,
}: {
  readonly roomId: string;
}): ReactElement | null {
  const { silence, canManage, busy, now, clear } = useRoomSilence(roomId);

  const copy = silence ? buildSilenceBannerCopy(silence, now) : null;
  if (!silence || !copy) return null;

  const countdown = formatSilenceCountdown(silence, now);
  if (!countdown) return null;

  const isDeaf = silence.kind === "deaf";
  const chipLine = isDeaf
    ? `Bots out of the room · ${countdown}`
    : `${silence.setByDisplayName} muted bots · ${countdown} — quiet, still listening`;

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="room-silence-banner"
      data-kind={silence.kind}
      className={
        isDeaf
          ? "flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background-muted px-4 py-1 text-[11px]"
          : "flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background-panel/60 px-4 py-1 text-[11px]"
      }
    >
      <p className="min-w-0 truncate font-medium text-foreground">{chipLine}</p>
      {canManage ? (
        <button
          type="button"
          data-testid="room-silence-clear"
          disabled={busy}
          className="shrink-0 rounded border border-border bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-background-element disabled:opacity-50"
          onClick={clear}
        >
          {busy ? "Clearing…" : "Clear"}
        </button>
      ) : null}
    </div>
  );
}
