import { StopTalkingIcon } from "./StopTalkingIcon";
export function VoicePlaybackStopPill({
  enabled,
  playing,
  canStop = playing,
  onStop,
}: {
  readonly enabled: boolean;
  readonly playing: boolean;
  readonly canStop?: boolean;
  readonly onStop: () => void;
}) {
  if (!enabled || !canStop) return null;

  return (
    <div
      data-testid="voice-playback-stop-pill"
      className="voice-playback-stop-pill flex justify-end"
    >
      <div className="flex items-center gap-2 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground-muted shadow-sm">
        <span>{playing ? "Speaking…" : "Speech in progress…"}</span>
        <button
          type="button"
          onClick={onStop}
          data-testid="voice-playback-stop"
          className="voice-playback-stop-button inline-flex items-center gap-1.5 rounded-full bg-background-element px-2 py-0.5 font-medium text-foreground hover:bg-[var(--primary-muted)]"
        >
          <StopTalkingIcon />Stop talking
        </button>
      </div>
    </div>
  );
}
