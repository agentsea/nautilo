import type { MediaGenerationApproval } from "@nautilo/types";
import { MediaGenerationApprovalDetail } from "./approval-ask-dock";
import { generationPrice, type GenerationReviewPresentation } from "./media-generation-visual-review";

/**
 * Parent-owned D525 review. The iframe never receives this projection's
 * private review handle, nor can it choose standing/room/Genie approval.
 */
export function VideoGenerationReviewOverlay({
  approval,
  presentation,
  roomId,
  busy = false,
  error,
  onOnce,
  onCancel,
}: {
  approval: MediaGenerationApproval | null;
  presentation?: GenerationReviewPresentation;
  roomId?: string;
  busy?: boolean;
  error?: string | null;
  onOnce: () => void;
  onCancel: () => void;
}) {
  if (!approval) return null;
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/45 p-4"
      role="presentation"
      data-testid="video-generation-review-overlay"
    >
      <section
        className="flex max-h-full w-full max-w-2xl flex-col rounded-xl border border-border bg-background p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-generation-review-title"
        aria-describedby="video-generation-review-copy"
      >
        <div className="min-h-0 overflow-y-auto">
        <h2 id="video-generation-review-title" className="text-base font-semibold text-foreground">
          Review video generation
        </h2>
        <p id="video-generation-review-copy" className="mt-1 text-sm text-foreground-muted">
          Review this one paid generation before it starts.
        </p>
        <MediaGenerationApprovalDetail approval={approval} presentation={presentation} roomId={roomId} />
        {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button type="button" className="rounded-md border border-border px-3 py-1.5 text-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-[var(--on-primary)] disabled:opacity-60" onClick={onOnce} disabled={busy}>
            {busy ? "Starting…" : `Generate · ${generationPrice(approval)}`}
          </button>
        </div>
      </section>
    </div>
  );
}
