import type { TaskPreparationProgress } from "@nautilo/types";

type ReviewCounts = Pick<NonNullable<TaskPreparationProgress["research"]>, "unitsCompleted" | "unitsTotal">;

/** A view of the current ledger plan, never a time estimate or report-completion signal. */
function researchReviewPercent({ unitsCompleted, unitsTotal }: ReviewCounts): number | null {
  if (unitsTotal <= 0) return null;
  // Keep an unfinished plan below 100%, even when rounding a large denominator.
  return unitsCompleted >= unitsTotal ? 100 : Math.min(99, Math.round(unitsCompleted / unitsTotal * 100));
}

export function researchReviewLabel(progress: ReviewCounts): string {
  const percent = researchReviewPercent(progress);
  return percent === null ? "Planning review" : `${percent}% of review plan · ${progress.unitsCompleted}/${progress.unitsTotal} review units complete`;
}

export function ResearchProgress({ progress }: { progress: ReviewCounts }) {
  const percent = researchReviewPercent(progress);
  return <div aria-label="Audit review progress" className="space-y-1 text-xs">
    <p className="font-medium text-foreground">{researchReviewLabel(progress)}</p>
    {percent !== null && <>
      <div role="progressbar" aria-label="Review units completed" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent} aria-valuetext={researchReviewLabel(progress)}
        className="h-1.5 overflow-hidden rounded-full bg-background-element">
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-foreground-muted">This measures planned source review. Report review and export are separate.</p>
    </>}
  </div>;
}
