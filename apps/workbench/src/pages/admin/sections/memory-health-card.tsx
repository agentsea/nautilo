import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MemoryAdminStatus } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { formatRelativeTime } from "../../../components/approvals/format-relative-time";

// Same display-refresh cadence as the existing Encryption Admin card; not worker policy.
const AUTO_REFRESH_MS = 10_000;
const count = (value: number | null) => value === null ? "Not measured" : value.toLocaleString();
const time = (value: string | null) => value === null ? "Not measured" : formatRelativeTime(value);
const buttonClass = "rounded-md border border-border bg-background-element px-2.5 py-1 text-xs font-medium disabled:opacity-50";

export function memoryStatusHeadline(status: MemoryAdminStatus): string {
  if (!status.enabled) return "Paused — pending conversation is preserved";
  if (!status.model.available) return "Model unavailable — change model";
  if (!status.encryption.available) return "Waiting for authorized processing access";
  if (status.health === "unavailable") return "Memory processing is unavailable";
  if (status.followUpPending > 0) return "Memory saved; follow-up processing pending";
  if (status.current.processing > 0) return "Reviewing conversation";
  if (status.current.blocked > 0) return "Some reviews need recovery";
  if (status.current.retrying > 0) return "Retrying failed reviews";
  if (status.current.due > 0) return "Conversation is waiting for review";
  if (status.current.accumulating > 0 || status.trackedSince === null) return "Waiting for more conversation";
  return "Tracked conversation is caught up";
}

function statusPillClass(health: MemoryAdminStatus["health"]): string {
  switch (health) {
    case "healthy":
    case "waiting":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "delayed":
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "degraded":
    case "unavailable":
      return "border-error/40 bg-error/10 text-error";
    case "paused":
      return "border-border bg-background-element text-foreground-muted";
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

export function MemorySection() {
  const can = useCan();
  const canRead = can("read_server_settings");
  const canManage = can("manage_server_operations");
  const [status, setStatus] = useState<MemoryAdminStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const cardVisible = useRef(true);
  const refreshing = useRef(false);
  const mutating = useRef(false);
  const refresh = useCallback(async () => {
    if (!canRead || refreshing.current) return;
    refreshing.current = true;
    setLoading(true);
    try {
      setStatus(await apiClient.admin.memoryStatus.get());
      setError(null);
    } catch {
      setError("Memory processing status unavailable.");
    } finally {
      refreshing.current = false;
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    if (!canRead) return;
    const refreshVisible = () => {
      if (document.visibilityState !== "hidden" && cardVisible.current && !mutating.current) void refresh();
    };
    refreshVisible();
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      const wasVisible = cardVisible.current;
      cardVisible.current = entries.some(entry => entry.isIntersecting);
      if (cardVisible.current && !wasVisible) refreshVisible();
    });
    if (card.current) observer?.observe(card.current);
    document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("focus", refreshVisible);
    const interval = window.setInterval(refreshVisible, AUTO_REFRESH_MS);
    return () => {
      observer?.disconnect();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshVisible);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [canRead, refresh]);

  const mutate = async (action: "toggle" | "retry") => {
    if (!canManage || !status || mutating.current) return;
    mutating.current = true;
    setSaving(true);
    setMutationError(null);
    setNotice(null);
    try {
      if (action === "toggle") {
        await apiClient.admin.serverContext.set({ memoryReviewEnabled: !status.enabled });
      } else {
        const result = await apiClient.admin.memoryStatus.retry();
        setNotice(`${result.requested} failed review${result.requested === 1 ? "" : "s"} scheduled for normal retry.`);
      }
      await refresh();
    } catch {
      setMutationError("Change could not be confirmed. Refresh to check the current state before retrying.");
    } finally {
      mutating.current = false;
      setSaving(false);
    }
  };
  if (!canRead) return null;
  return <section ref={card} id="memory" aria-label="Memory" data-testid="admin-memory-section">
    <div className="rounded-lg border border-border bg-background-panel/50 p-4" data-testid="memory-health-card">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold">Memory processing</h3>
          <p className="text-xs text-foreground-muted">Automatic review of conversation into editable Memories.</p></div>
        <button className={buttonClass} disabled={loading} onClick={() => void refresh()} type="button">Refresh</button>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-error">{error}{status ? " Displayed values are stale." : ""}</p> : null}
      {mutationError ? <p role="alert" className="mt-3 text-sm text-error">{mutationError}</p> : null}
      {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
      {!status && loading ? <p className="mt-3 text-sm">Loading Memory status…</p> : null}
      {status ? <div className="mt-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span data-testid="memory-health-pill"
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${statusPillClass(status.health)}`}>
            {status.health}
          </span>
          <span className="text-xs text-foreground-muted">Updated {time(status.generatedAt)}{error ? " · Stale" : ""}</span>
        </div>
        <p className="text-sm font-semibold" data-testid="memory-headline">{memoryStatusHeadline(status)}</p>
        <div className="flex flex-wrap items-center gap-2">
          {canManage ? <>
            <button type="button" className={buttonClass} disabled={saving || loading || !!error} onClick={() => void mutate("toggle")}>
              {status.enabled ? "Pause automatic review" : "Enable automatic review"}</button>
            {status.current.safelyRetryable > 0 ? <button type="button" className={buttonClass} disabled={saving || loading || !!error}
              onClick={() => void mutate("retry")}>Retry failed reviews</button> : null}
          </> : null}
          <Link to="/admin#models" className="text-xs text-primary hover:underline">Model settings</Link>
        </div>
        <p className="text-xs text-foreground-muted">Counts are Agent/transcript scopes. Different access scopes are tracked independently.</p>
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          {(["accumulating", "due", "processing", "retrying", "blocked", "caughtUp"] as const).map(key =>
            <Fact key={key} label={key === "caughtUp" ? "Caught up" : key[0].toUpperCase() + key.slice(1)} value={count(status.current[key])} />)}
          <Fact label="Oldest overdue" value={status.current.oldestOverdueMs === null ? "Not measured" : `${Math.round(status.current.oldestOverdueMs / 1000)} s`} />
          <Fact label="Last successful review" value={time(status.lastSuccessfulReviewAt)} />
          <Fact label="Last attempt" value={time(status.lastAttemptAt)} />
        </dl>
        <p className="text-xs text-foreground-muted">{status.trackedSince ? `Tracked since ${new Date(status.trackedSince).toLocaleString()}. Earlier coverage is unknown.` : "Tracking starts with eligible conversation; earlier coverage is unknown."}</p>
        <h4 className="border-t border-border/60 pt-3 text-xs font-semibold uppercase tracking-wide text-foreground-muted">Last 24 hours</h4>
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          {Object.entries({ completedReviews: "Completed reviews", noChangeReviews: "No-change reviews", created: "Created", replaced: "Replaced", promoted: "Promoted", demoted: "Demoted", failures: "Failures" }).map(([key, label]) =>
            <Fact key={key} label={label} value={count(status.last24h[key as keyof typeof status.last24h])} />)}
          <Fact label="Last review duration" value={status.last24h.lastReviewDurationMs === null ? "Not measured" : `${Math.round(status.last24h.lastReviewDurationMs)} ms`} />
        </dl>
        {status.recentFailures.length ? <div><h4 className="text-xs font-semibold">Recent failures</h4>
          <ul className="mt-1 space-y-1 text-xs">{status.recentFailures.map((failure, index) => <li key={`${failure.occurredAt}:${index}`}>
            {failure.phase.replaceAll("_", " ")} · {failure.code.replaceAll("_", " ")} · {time(failure.occurredAt)}.
            {failure.code === "iteration_exhausted" ? " Review reached its configured iteration budget; check model settings and reviewer configuration." : ""}
            {failure.nextRetryAt ? ` Next retry ${time(failure.nextRetryAt)}.` : failure.retryable ? " Safe retry is available." : " No automatic retry is scheduled; current work is shown above."}
          </li>)}</ul></div> : null}
        <details className="text-xs"><summary className="cursor-pointer">Processing details</summary>
          <p className="mt-2">Exit flush: not scheduled</p>
          <p>Execution policy: {status.encryption.mode}. {status.encryption.available ? "Current processing access is available." : "Current processing access is unavailable."} Ordinary processing is not protected execution.</p>
          <p>Pending follow-up deliveries: {count(status.followUpPending)}</p>
        </details>
        {can("manage_billing") ? <Link to="/costs" className="inline-flex text-xs text-primary hover:underline">View model costs — Memory review and Memory flush</Link> : null}
      </div> : null}
    </div>
  </section>;
}
