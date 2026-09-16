export function VoicePlaybackStopPill({
  enabled,
  playing,
  onStop,
}: {
  readonly enabled: boolean;
  readonly playing: boolean;
  readonly onStop: () => void;
}) {
  if (!enabled || !playing) return null;

  return (
    <div
      data-testid="voice-playback-stop-pill"
      className="flex justify-end"
    >
      <div className="flex items-center gap-2 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground-muted shadow-sm">
        <span>Speaking...</span>
        <button
          type="button"
          onClick={onStop}
          data-testid="voice-playback-stop"
          className="rounded-full bg-background-element px-2 py-0.5 font-medium text-foreground hover:bg-[var(--primary-muted)]"
        >
          Stop talking
        </button>
      </div>
    </div>
  );
}
