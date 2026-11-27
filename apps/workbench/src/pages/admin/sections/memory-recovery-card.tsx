import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { MemoryAdminStatus, ReflectionAdminStatus, StenographerAdminStatus } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";

const buttonClass = "rounded-md border border-border bg-background-element px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-panel disabled:opacity-50";
type RecoveryState = "catching_up" | "waiting" | "healthy" | "paused" | "needs_attention";
type RecoverySummary = { state: RecoveryState; detail: string };

function stateLabel(state: RecoveryState): string {
  switch (state) {
    case "catching_up": return "Catching up";
    case "waiting": return "Waiting";
    case "healthy": return "Healthy";
    case "paused": return "Paused";
    case "needs_attention": return "Needs attention";
  }
}

function stateClass(state: RecoveryState): string {
  switch (state) {
    case "healthy": return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "catching_up":
    case "waiting": return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "needs_attention": return "border-error/40 bg-error/10 text-error";
    case "paused": return "border-border bg-background-element text-foreground-muted";
  }
}

export function summarizeStenographer(status: StenographerAdminStatus): RecoverySummary {
  const unknownOutcome = (status.unresolvedProviderOutcomes ?? 0) > 0
    || status.recentFailures.some(({ errorCode }) => errorCode === "provider_outcome_unknown");
  if (unknownOutcome) return { state: "needs_attention", detail: "A provider outcome is unknown. Inspect Stenographer details before assuming the attempt completed." };
  if (status.health === "degraded" || status.current.staleLeases > 0 || status.compaction.staleLeases > 0) {
    return { state: "needs_attention", detail: "Recovery has unresolved failures or stale work. Stenographer details show the blocking stage and reason." };
  }
  const active = status.current.processingRooms + status.current.retryingRooms + status.current.dueRooms
    + status.current.rebuildingRooms + status.current.historicalPendingRooms + status.compaction.awaitingRooms
    + status.compaction.processingRooms + status.compaction.retryingRooms;
  if (active > 0) return { state: "catching_up", detail: "Journal or compaction work is queued, retrying, or processing automatically." };
  if (status.current.eligibleRooms === 0 || status.current.accumulatingRooms > 0) {
    return { state: "waiting", detail: "Healthy and waiting for enough eligible conversation to process." };
  }
  return { state: "healthy", detail: "Eligible Room journals are caught up." };
}

export function summarizeReflection(status: ReflectionAdminStatus): RecoverySummary {
  if ((status.unresolvedProviderOutcomes ?? 0) > 0) {
    return { state: "needs_attention", detail: "A Reflection provider outcome remains unresolved." };
  }
  if (status.scheduler.state === "disabled" || status.scheduler.state === "pressure_paused") {
    const reason = status.scheduler.pauseReason?.replaceAll("_", " ");
    return { state: "paused", detail: reason ? `Automatic Reflection is paused: ${reason}.` : "Automatic Reflection is paused." };
  }
  if (status.health === "degraded" || status.current.staleLeases > 0
    || status.current.currentParentViolations > 0 || status.currentFailures.some(({ errorCode }) => errorCode === "retry_exhausted")) {
    return { state: "needs_attention", detail: "Recovery has unresolved or exhausted work. Reflection details show the blocking stage and reason." };
  }
  const active = status.current.backlog + status.current.due + status.current.claimed + status.current.checkpointed
    + status.current.recoveryEligible + status.projections.pending;
  if (active > 0) return { state: "catching_up", detail: "Reflection or projection work is waiting, recovering, or processing automatically." };
  if (status.current.totalRecords === 0 || status.scheduler.state === "cooldown") {
    return { state: "waiting", detail: "Healthy and waiting for eligible Stenographer work or the next scheduler poll." };
  }
  return { state: "healthy", detail: "Reflection records and search projections are caught up." };
}

export function summarizeMemory(status: MemoryAdminStatus): RecoverySummary {
  if (!status.enabled) return { state: "paused", detail: "Automatic Memory review is paused; pending conversation is preserved." };
  const unknownOutcome = status.recentFailures.some(({ code }) => code === "provider_outcome_unknown" || code === "publication_uncertain");
  if (unknownOutcome) return { state: "needs_attention", detail: "An attempt has an unknown outcome. Inspect Memory details before assuming it completed or retrying it." };
  if (status.current.blocked > 0 || status.health === "degraded" || status.health === "unavailable") {
    return { state: "needs_attention", detail: "Some reviews remain blocked. Memory details show the recorded phase, reason, and whether another retry is safe." };
  }
  if (!status.model.available) return { state: "waiting", detail: "Waiting for an effective Memory model in Server Models." };
  if (!status.encryption.available) return { state: "waiting", detail: "Waiting for authorized processing access." };
  const active = status.current.due + status.current.processing + status.current.retrying + status.followUpPending;
  if (active > 0) return { state: "catching_up", detail: "Memory review or follow-up work is queued, retrying, or processing automatically." };
  if (status.current.accumulating > 0 || status.trackedSince === null || status.health === "waiting") {
    return { state: "waiting", detail: "Healthy and waiting for enough eligible conversation to review." };
  }
  return { state: "healthy", detail: "Tracked Memory review work is caught up." };
}

function ProcessorRow({ name, href, summary }: { name: string; href: string; summary: RecoverySummary }) {
  return (
    <li className="rounded-md border border-border/60 bg-background-element px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold text-foreground">{name}</span>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${stateClass(summary.state)}`}>
          {stateLabel(summary.state)}
        </span>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">{summary.detail}</p>
      <Link to={href} className="mt-2 inline-flex text-xs font-medium text-primary hover:underline">View {name} details</Link>
    </li>
  );
}

export function MemoryRecoveryCard() {
  const canRead = useCan()("read_server_settings");
  const [summaries, setSummaries] = useState<Record<string, RecoverySummary | null>>({ stenographer: null, reflection: null, memory: null });
  const [loading, setLoading] = useState(canRead);
  const refresh = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    const [stenographer, reflection, memory] = await Promise.allSettled([
      apiClient.admin.stenographerStatus.get({ includeRecovery: true }),
      apiClient.admin.reflectionStatus.get({ includeRecovery: true }),
      apiClient.admin.memoryStatus.get(),
    ]);
    setSummaries({
      stenographer: stenographer.status === "fulfilled" ? summarizeStenographer(stenographer.value) : null,
      reflection: reflection.status === "fulfilled" ? summarizeReflection(reflection.value) : null,
      memory: memory.status === "fulfilled" ? summarizeMemory(memory.value) : null,
    });
    setLoading(false);
  }, [canRead]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!canRead) return null;
  const unavailable: RecoverySummary = { state: "needs_attention", detail: "Status is unavailable, so the current recovery outcome is unknown. Open details or refresh before drawing a conclusion." };
  return (
    <div className="mt-4 rounded-lg border border-border bg-background-panel/50 p-4" data-testid="memory-recovery-card">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold">Automatic recovery</h3><p className="mt-0.5 text-xs text-foreground-muted">The three processors recover eligible work automatically across the server.</p></div>
        <button className={buttonClass} type="button" disabled={loading} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      <p className="mt-3 text-xs text-foreground-muted">
        After a confirmed provider refusal, eligible work retries with the model selected in <Link to="/admin#models" className="text-primary hover:underline">Server Models</Link>. An uncertain outcome requires attention.
      </p>
      {loading && Object.values(summaries).every(value => value === null) ? <p className="mt-3 text-sm text-foreground-muted">Loading recovery status…</p> : (
        <ul className="mt-3 grid gap-2 lg:grid-cols-3" data-testid="memory-recovery-summary">
          <ProcessorRow name="Stenographer" href="/admin#stenographer" summary={summaries.stenographer ?? unavailable} />
          <ProcessorRow name="Reflection" href="/admin#reflection" summary={summaries.reflection ?? unavailable} />
          <ProcessorRow name="Memory" href="/admin#memory" summary={summaries.memory ?? unavailable} />
        </ul>
      )}
    </div>
  );
}
