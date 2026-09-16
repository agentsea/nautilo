import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  StenographerAdminStatus,
  StenographerProtectionStatus,
} from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { formatRelativeTime } from "../../../components/approvals/format-relative-time";

const INTEGER_FORMAT = new Intl.NumberFormat();

function formatCount(value: number | null): string {
  return value === null ? "—" : INTEGER_FORMAT.format(Math.round(value));
}

function formatStenographerDuration(valueMs: number | null): string {
  if (valueMs === null) return "—";
  if (valueMs < 1_000) return `${Math.round(valueMs)} ms`;
  if (valueMs < 60_000) return `${(valueMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(valueMs / 60_000)}m ${Math.round((valueMs % 60_000) / 1_000)}s`;
}

function statusPillClass(health: StenographerAdminStatus["health"]): string {
  switch (health) {
    case "healthy":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "delayed":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "degraded":
      return "border-error/40 bg-error/10 text-error";
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background-element px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-foreground-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function ProtectionFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-foreground-muted">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function StenographerProtectionStatusPanel({
  status,
  unavailable,
  headingId,
}: {
  status: StenographerProtectionStatus | null;
  unavailable: boolean;
  headingId: string;
}) {
  if (status === null) {
    return unavailable ? (
      <p
        className="mt-3 text-xs text-foreground-muted"
        data-testid="stenographer-protection-unavailable"
      >
        Protection status unavailable.
      </p>
    ) : null;
  }

  const current = status.queue.current;
  const recent = status.queue.last24h;
  const fallback = status.plaintextFallback;

  return (
    <section
      className="mt-4 border-t border-border/60 pt-3"
      aria-labelledby={headingId}
      data-testid="stenographer-protection-status"
    >
      <h4
        id={headingId}
        className="text-xs font-semibold uppercase tracking-wide text-foreground-muted"
      >
        Protected background processing
      </h4>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
        <ProtectionFact label="Waiting for a device" value={current.waitingForDevice} />
        <ProtectionFact
          label="Waiting for authority"
          value={`${status.authorityWait.extractionRooms} extraction · ${status.authorityWait.compactionRooms} compaction`}
        />
        <ProtectionFact
          label="Processed with encryption (24h)"
          value={recent.protectedCompleted}
        />
        <ProtectionFact
          label="Repaired after plaintext processing (24h)"
          value={recent.outputRepairCompleted}
        />
        <ProtectionFact
          label="Fallback outputs awaiting protection"
          value={`${fallback.missingProtection.extractionBatches} extraction · ${fallback.missingProtection.compactionRollups} compaction`}
        />
        <ProtectionFact
          label="Terminal failures (24h)"
          value={recent.terminalFailures}
        />
      </dl>
      <p className="mt-2 text-xs text-foreground-muted">
        Preparing authorization {current.awaitingRecipient} · grant ready {current.grantReady}
        {" · "}claimed {current.claimed} · running {current.running} · reconciling publication{" "}
        {current.publicationReconciliation} · cancelled (24h) {recent.cancelled}
      </p>
      <p className="mt-1 text-xs text-foreground-muted">
        Oldest queued wait{" "}
        {current.oldestWaitingAt ? formatRelativeTime(current.oldestWaitingAt) : "—"}
        {" · "}oldest authority wait{" "}
        {status.authorityWait.oldestAt
          ? formatRelativeTime(status.authorityWait.oldestAt)
          : "—"}
        {" · "}oldest missing protection{" "}
        {fallback.missingProtection.oldestAt
          ? formatRelativeTime(fallback.missingProtection.oldestAt)
          : "—"}
      </p>
      <p className="mt-1 text-xs text-foreground-muted">
        Plaintext fallbacks (24h): extraction {fallback.last24h.extraction.device} device /{" "}
        {fallback.last24h.extraction.authority} authority · compaction{" "}
        {fallback.last24h.compaction.device} device /{" "}
        {fallback.last24h.compaction.authority} authority
      </p>
    </section>
  );
}

function StatusBody({
  status,
  protectionStatus,
  protectionUnavailable,
  canViewCosts,
}: {
  status: StenographerAdminStatus;
  protectionStatus: StenographerProtectionStatus | null;
  protectionUnavailable: boolean;
  canViewCosts: boolean;
}) {
  const generatedAge = formatRelativeTime(status.generatedAt);
  const current = status.current;
  const last24h = status.last24h;
  const journal = status.journal;
  const compaction = status.compaction;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="stenographer-health-pill"
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${statusPillClass(status.health)}`}
        >
          {status.health}
        </span>
        <span className="text-xs text-foreground-muted">Generated {generatedAge}</span>
      </div>

      {current.eligibleRooms === 0 ? (
        <p className="mt-3 text-sm text-foreground-muted">
          No eligible Agent rooms yet. The service is healthy and waiting for work.
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Fact
          label="Caught up"
          value={`${formatCount(current.caughtUpRooms)} / ${formatCount(current.eligibleRooms)}`}
        />
        <Fact label="Accumulating" value={formatCount(current.accumulatingRooms)} />
        <Fact label="Processing" value={formatCount(current.processingRooms)} />
        <Fact label="Due" value={formatCount(current.dueRooms)} />
        <Fact label="Retrying" value={formatCount(current.retryingRooms)} />
        <Fact label="Stale leases" value={formatCount(current.staleLeases)} />
        <Fact
          label="Oldest overdue"
          value={formatStenographerDuration(current.oldestOverdueMs)}
        />
        <Fact
          label="Historical pending"
          value={formatCount(current.historicalPendingRooms)}
        />
        <Fact
          label="Historical complete"
          value={formatCount(current.historicalCompletedRooms)}
        />
      </dl>

      <div className="mt-4 border-t border-border/60 pt-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
          Last 24 hours
        </h4>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-foreground-muted">Completed</dt>
            <dd>{formatCount(last24h.completedExtractionBatches)}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">With errors</dt>
            <dd>{formatCount(last24h.extractionBatchesWithErrors)}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">Retried</dt>
            <dd>{formatCount(last24h.retriedExtractionBatches)}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">Zero-event (informational)</dt>
            <dd>{formatCount(last24h.zeroEventExtractionBatches)}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">Events written</dt>
            <dd>{formatCount(last24h.eventsWritten)}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">Duration p50</dt>
            <dd>{formatStenographerDuration(last24h.extractionDurationP50Ms)}</dd>
          </div>
          <div>
            <dt className="text-foreground-muted">Duration p95</dt>
            <dd>{formatStenographerDuration(last24h.extractionDurationP95Ms)}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Journal body
          </h4>
          <p className="mt-1 text-xs text-foreground">
            p50 {formatCount(journal.projectedBodyCodePointsP50)} · p95{" "}
            {formatCount(journal.projectedBodyCodePointsP95)} · max{" "}
            {formatCount(journal.projectedBodyCodePointsMax)} code points
          </p>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Compaction
          </h4>
          <p className="mt-1 text-xs text-foreground">
            Waiting {formatCount(compaction.awaitingRooms)} · processing{" "}
            {formatCount(compaction.processingRooms)} · retrying{" "}
            {formatCount(compaction.retryingRooms)} · stale leases{" "}
            {formatCount(compaction.staleLeases)} · oldest overdue{" "}
            {formatStenographerDuration(compaction.oldestOverdueMs)}
          </p>
          <p className="mt-1 text-xs text-foreground-muted">
            Last completed{" "}
            {compaction.lastCompletedAt
              ? formatRelativeTime(compaction.lastCompletedAt)
              : "—"}
          </p>
        </div>
      </div>

      {status.recentFailures.length > 0 ? (
        <div className="mt-4 border-t border-border/60 pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Recent failures
          </h4>
          <ul className="mt-2 space-y-1 text-xs" data-testid="stenographer-recent-failures">
            {status.recentFailures.map((failure) => (
              <li
                key={`${failure.stage}:${failure.occurredAt}:${failure.attemptCount}`}
                className="text-foreground-muted"
              >
                <span className="font-medium capitalize text-foreground">{failure.stage}</span>
                {" · "}
                {failure.errorCode.replaceAll("_", " ")}
                {" · "}
                {formatRelativeTime(failure.occurredAt)}
                {" · attempt "}
                {failure.attemptCount}
                {failure.modelId ? ` · ${failure.modelId}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <StenographerProtectionStatusPanel
        status={protectionStatus}
        unavailable={protectionUnavailable}
        headingId="stenographer-health-protection-heading"
      />

      {canViewCosts ? (
        <Link
          to="/costs"
          className="mt-4 inline-flex text-xs font-medium text-primary hover:underline"
        >
          View model costs
        </Link>
      ) : null}
    </>
  );
}

export function StenographerHealthCard() {
  const can = useCan();
  const canRead = can("read_server_settings");
  const canViewCosts = can("manage_billing");
  const [status, setStatus] = useState<StenographerAdminStatus | null>(null);
  const [protectionStatus, setProtectionStatus] =
    useState<StenographerProtectionStatus | null>(null);
  const [protectionUnavailable, setProtectionUnavailable] = useState(false);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    const [statusResult, protectionResult] = await Promise.allSettled([
      apiClient.admin.stenographerStatus.get(),
      apiClient.admin.stenographerStatus.getProtection(),
    ]);
    if (statusResult.status === "fulfilled") {
      setStatus(statusResult.value);
      if (protectionResult.status === "fulfilled") {
        setProtectionStatus(protectionResult.value);
        setProtectionUnavailable(false);
      } else {
        setProtectionStatus(null);
        setProtectionUnavailable(true);
      }
    } else {
      setError("Stenographer status is unavailable.");
    }
    setLoading(false);
  }, [canRead]);

  useEffect(() => {
    if (!canRead) return;
    void loadStatus();
  }, [canRead, loadStatus]);

  if (!canRead) return null;

  return (
    <div
      data-testid="stenographer-health-card"
      className="mt-4 rounded-lg border border-border bg-background-panel/50 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Stenographer health</h3>
          <p className="mt-0.5 text-xs text-foreground-muted">
            Content-free Room journal processing status.
          </p>
        </div>
        <button
          type="button"
          data-testid="stenographer-refresh"
          disabled={loading}
          onClick={() => {
            void loadStatus();
          }}
          className="rounded-md border border-border bg-background-element px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-panel disabled:opacity-50"
        >
          {loading && status ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {loading && !status ? (
        <p className="mt-3 text-sm text-foreground-muted">Loading Stenographer status…</p>
      ) : error ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {error}
        </p>
      ) : status ? (
        <div className="mt-3">
          <StatusBody
            status={status}
            protectionStatus={protectionStatus}
            protectionUnavailable={protectionUnavailable}
            canViewCosts={canViewCosts}
          />
        </div>
      ) : null}
    </div>
  );
}
