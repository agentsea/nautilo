import type { MessageBackfillProgress } from "@nautilo/api-client/browser";

const STATUS_LABELS: Readonly<Record<MessageBackfillProgress["status"], string>> = {
  active: "Active",
  waiting: "Waiting",
  failed: "Failed",
  caught_up: "Caught up",
  disabled: "Disabled",
};

function formatSnapshotAt(snapshotAt: number): string {
  return new Date(snapshotAt).toLocaleString();
}

export function MessageHistoryBackfillProgress({
  progress,
  unavailable = false,
}: Readonly<{
  progress: MessageBackfillProgress | null;
  unavailable?: boolean;
}>) {
  if (progress === null && !unavailable) return null;

  return (
    <div
      className="mt-4 rounded-md border border-border bg-background-element/40 p-3 text-xs"
      aria-labelledby="message-history-repair-title"
    >
      <h4 id="message-history-repair-title" className="font-medium text-foreground">
        Message history repair
      </h4>
      {progress === null ? (
        <p className="mt-1 text-foreground-muted">
          Repair progress is temporarily unavailable.
        </p>
      ) : (
        <>
          <p className="mt-1 text-foreground-muted">
            Status: <span className="font-medium text-foreground">{STATUS_LABELS[progress.status]}</span>
          </p>
          <p className="mt-1 text-foreground-muted">
            Snapshot: {formatSnapshotAt(progress.snapshotAt)} · Snapshot complete: {progress.snapshotComplete ? "Yes" : "No"} · Caught up: {progress.caughtUp ? "Yes" : "No"}
          </p>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-foreground-muted">
            <dt>Eligible messages</dt><dd className="tabular-nums text-foreground">{progress.counts.eligible.toLocaleString()}</dd>
            <dt>Authenticated without independent parity</dt><dd className="tabular-nums text-foreground">{progress.counts.alreadyAuthenticated.toLocaleString()}</dd>
            <dt>Independent parity verified</dt><dd className="tabular-nums text-foreground">{progress.counts.independentlyParityVerified.toLocaleString()}</dd>
            <dt>Claimed or repairing</dt><dd className="tabular-nums text-foreground">{progress.counts.claimedRepairing.toLocaleString()}</dd>
            <dt>Repaired and verified</dt><dd className="tabular-nums text-foreground">{progress.counts.repairedAndVerified.toLocaleString()}</dd>
            <dt>Waiting for an authorized device</dt><dd className="tabular-nums text-foreground">{progress.waiting.authorizedDevice?.toLocaleString() ?? "Unknown"}</dd>
            <dt>Waiting for authority</dt><dd className="tabular-nums text-foreground">{progress.waiting.authority?.toLocaleString() ?? "Unknown"}</dd>
            <dt>Unsupported</dt><dd className="tabular-nums text-foreground">{progress.counts.unsupported.toLocaleString()}</dd>
          </dl>
          {progress.counts.failed > 0 ? (
            <p className="mt-1 text-[var(--warning)]">
              Failed messages: {progress.counts.failed.toLocaleString()}
            </p>
          ) : null}
          <p className="mt-2 text-foreground-muted">
            The protected Message count above means authenticated ciphertext. Repair checks its permitted plaintext counterpart independently.
          </p>
        </>
      )}
    </div>
  );
}
