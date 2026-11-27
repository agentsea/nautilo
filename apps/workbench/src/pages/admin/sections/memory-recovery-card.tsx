import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { MemoryAdminStatus, MemoryRecoveryLaneResult, MemoryRecoveryRun, ReflectionAdminStatus, StenographerAdminStatus } from "@nautilo/types";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";

const buttonClass = "rounded-md border border-border bg-background-element px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-panel disabled:opacity-50";
type RecoveryState = "catching_up" | "waiting" | "healthy" | "paused" | "needs_attention";
type RecoverySummary = { state: RecoveryState; detail: string; recovery?: string; counts?: string };

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
  const unknownOutcome = status.unresolvedProviderOutcomes === undefined
    ? status.recentFailures.some(({ errorCode }) => errorCode === "provider_outcome_unknown")
    : status.unresolvedProviderOutcomes > 0;
  if (unknownOutcome) return { state: "needs_attention", detail: "A journal batch is held because the provider outcome is unknown." };
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
  const succeededWithoutResult = status.providerSucceededResultMissing ?? 0;
  const unresolved = status.unresolvedProviderOutcomes ?? 0;
  const ambiguous = Math.max(0, unresolved - succeededWithoutResult);
  const holds = status.quarantinedByReason;
  const sourceHolds = [
    holds?.invalidSelection ? `${holds.invalidSelection.toLocaleString()} with invalid source links` : null,
    holds?.missingAuthority ? `${holds.missingAuthority.toLocaleString()} missing current access evidence` : null,
    holds?.stalePlan ? `${holds.stalePlan.toLocaleString()} with outdated publication plans` : null,
    holds?.unavailableSource ? `${holds.unavailableSource.toLocaleString()} missing a publication source` : null,
  ].filter(Boolean).join(" · ");
  const recovery = status.resumedFromSavedProposal === undefined
    ? undefined
    : `${status.resumedFromSavedProposal.toLocaleString()} resumed from a saved proposal. Completed in the past 24 hours: ${status.last24h.completedWork.toLocaleString()}. Held work is excluded.`;
  if (succeededWithoutResult > 0 || ambiguous > 0) {
    const reasons = [
      succeededWithoutResult > 0
        ? `${succeededWithoutResult.toLocaleString()} ${succeededWithoutResult === 1 ? "job has" : "jobs have"} a successful provider call and a missing result`
        : null,
      ambiguous > 0
        ? `${ambiguous.toLocaleString()} ${ambiguous === 1 ? "job has" : "jobs have"} an unknown provider outcome`
        : null,
    ].filter((value): value is string => value !== null).join(". ");
    return {
      state: "needs_attention",
      detail: `${reasons}. Automatic retries are on hold.${sourceHolds ? ` Quarantined: ${sourceHolds}.` : ""}`,
      ...(recovery === undefined ? {} : { recovery }),
    };
  }
  if (status.scheduler.state === "disabled" || status.scheduler.state === "pressure_paused") {
    const reason = status.scheduler.pauseReason?.replaceAll("_", " ");
    return { state: "paused", detail: reason ? `Automatic Reflection is paused: ${reason}.` : "Automatic Reflection is paused." };
  }
  if (status.health === "degraded" || status.current.staleLeases > 0 || status.current.quarantined > 0
    || status.current.currentParentViolations > 0 || status.currentFailures.some(({ errorCode }) => errorCode === "retry_exhausted")) {
    return {
      state: "needs_attention",
      detail: sourceHolds ? `Quarantined: ${sourceHolds}.` : "Reflection details show the current failures and their causes.",
      recovery,
    };
  }
  const active = status.current.backlog + status.current.due + status.current.claimed + status.current.checkpointed
    + status.current.recoveryEligible + status.projections.pending;
  if (active > 0) return { state: "catching_up", detail: "Reflection or projection work is waiting, recovering, or processing automatically.", ...(recovery === undefined ? {} : { recovery }) };
  if (status.current.totalRecords === 0 || status.scheduler.state === "cooldown") {
    return { state: "waiting", detail: "Healthy and waiting for eligible Stenographer work or the next scheduler poll.", ...(recovery === undefined ? {} : { recovery }) };
  }
  return { state: "healthy", detail: "Reflection records and search projections are caught up.", ...(recovery === undefined ? {} : { recovery }) };
}

export function summarizeMemory(status: MemoryAdminStatus): RecoverySummary {
  if (!status.enabled) return { state: "paused", detail: "Automatic Memory review is paused; pending conversation is preserved." };
  if (status.current.blocked > 0 || status.health === "degraded" || status.health === "unavailable") {
    return { state: "needs_attention", detail: "Memory details show the current blocked reviews and their recorded failures." };
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
      {summary.counts ? <p className="mt-1 text-sm text-foreground">{summary.counts}</p> : null}
      <p className="mt-1 text-xs text-foreground-muted">{summary.detail}</p>
      {summary.recovery ? <p className="mt-1 text-xs text-foreground-muted"><span className="font-medium text-foreground">Recovery evidence:</span> {summary.recovery}</p> : null}
      <Link to={href} className="mt-2 inline-flex text-xs font-medium text-primary hover:underline">View {name} details</Link>
    </li>
  );
}

function admissionText(lane: MemoryRecoveryLaneResult | null): string {
  if (lane === null) return "Request in progress";
  if (lane.state === "paused") return "Paused by server policy";
  if (lane.state === "unavailable") return "Could not assess this processor. Press Recover all memory to resume this request.";
  const admission = lane.queued || lane.held
    ? `${lane.queued.toLocaleString()} queued · ${lane.held.toLocaleString()} held at request`
    : "No work needed a retry";
  const repair = lane.derivedRepair;
  if (!repair) return admission;
  const details = [
    repair.summariesQueued
      ? `Generated summaries queued for reassessment: ${repair.summariesQueued.toLocaleString()}.`
      : null,
    repair.retired
      ? `Generated summaries retired: ${repair.retired.toLocaleString()}.`
      : null,
    repair.sourcesQueued
      ? `Source records queued for rebuilding: ${repair.sourcesQueued.toLocaleString()}.`
      : null,
  ].filter((detail): detail is string => detail !== null);
  return details.length === 0 ? admission : `${admission}. ${details.join(" ")}`;
}

export function MemoryRecoveryCard() {
  const can = useCan();
  const canRead = can("read_server_settings");
  const canManage = can("manage_server_operations");
  const [summaries, setSummaries] = useState<Record<string, RecoverySummary | null>>({ stenographer: null, reflection: null, memory: null });
  const [loading, setLoading] = useState(canRead);
  const [running, setRunning] = useState(false);
  const [receiptKnown, setReceiptKnown] = useState(false);
  const [run, setRun] = useState<MemoryRecoveryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<string | null>(null);
  const submitting = useRef(false);
  const refreshSequence = useRef(0);
  const hasRun = run !== null;
  const refresh = useCallback(async () => {
    if (!canRead) return;
    const sequence = ++refreshSequence.current;
    setLoading(true);
    const [stenographer, reflection, memory, receipt] = await Promise.allSettled([
      apiClient.admin.stenographerStatus.get({ includeRecovery: true }),
      apiClient.admin.reflectionStatus.get({ includeRecovery: true }),
      apiClient.admin.memoryStatus.get(),
      apiClient.admin.memoryRecovery.latest(),
    ]);
    if (sequence !== refreshSequence.current) return;
    if (receipt.status === "fulfilled") {
      setRun(receipt.value.run);
      setReceiptKnown(true);
    }
    setSummaries({
      stenographer: stenographer.status === "fulfilled" ? {
        ...summarizeStenographer(stenographer.value),
        counts: `${stenographer.value.current.caughtUpRooms.toLocaleString()} of ${stenographer.value.current.eligibleRooms.toLocaleString()} Rooms caught up`,
      } : null,
      reflection: reflection.status === "fulfilled" ? {
        ...summarizeReflection(reflection.value),
        counts: `${reflection.value.current.claimed.toLocaleString()} processing · ${reflection.value.current.deferred.toLocaleString()} deferred · ${reflection.value.current.quarantined.toLocaleString()} quarantined`,
      } : null,
      memory: memory.status === "fulfilled" ? {
        ...summarizeMemory(memory.value),
        counts: `${memory.value.current.processing.toLocaleString()} processing · ${memory.value.current.blocked.toLocaleString()} blocked`,
      } : null,
    });
    setLoading(false);
  }, [canRead]);
  useEffect(() => { void refresh(); return () => { refreshSequence.current++; }; }, [refresh]);
  useEffect(() => {
    if (!canRead || !hasRun) return;
    const poll = window.setInterval(() => {
      if (document.visibilityState !== "hidden" && !submitting.current) void refresh();
    }, 10_000);
    return () => window.clearInterval(poll);
  }, [canRead, hasRun, refresh]);
  async function recover() {
    if (!canManage || !receiptKnown || submitting.current) return;
    submitting.current = true;
    setRunning(true);
    setError(null);
    const unfinished = run && [run.stenographer, run.reflection, run.memory].some(lane => lane === null || lane.state === "unavailable");
    const requestId = pendingRequest.current ?? (unfinished ? run.requestId : crypto.randomUUID());
    pendingRequest.current = requestId;
    try {
      const result = await apiClient.admin.memoryRecovery.run(requestId);
      pendingRequest.current = null;
      setRun(result);
      await refresh();
    } catch {
      setError("The server could not confirm the request. Press Recover all memory to resume the same request.");
    } finally {
      submitting.current = false;
      setRunning(false);
    }
  }
  if (!canRead) return null;
  const unavailable: RecoverySummary = { state: "needs_attention", detail: "Status is unavailable, so the current recovery outcome is unknown. Open details or refresh before drawing a conclusion." };
  return (
    <div className="mt-4 rounded-lg border border-border bg-background-panel/50 p-4" data-testid="memory-recovery-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold">Memory recovery</h3>
          <p id="memory-recovery-cost" className="mt-1 max-w-prose text-xs text-foreground-muted">
            Recover stuck work across all Rooms using the configured <Link to="/admin#models" className="text-primary hover:underline">Server Models</Link>. Recovery can queue generated summaries for reassessment. Workers check current sources and access before repairing a generated summary. Starting it authorizes provider calls, including a possible second charge for an earlier attempt.
          </p>
        </div>
        <div className="flex gap-2">
          <button className={buttonClass} type="button" disabled={loading || running} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button>
          {canManage ? <button className={`${buttonClass} border-primary text-primary`} type="button" disabled={running || !receiptKnown}
            aria-describedby="memory-recovery-cost" onClick={() => void recover()}>{running ? "Starting recovery…" : "Recover all memory"}</button> : null}
        </div>
      </div>
      {canManage && !loading && !receiptKnown ? <p role="alert" className="mt-3 text-xs text-error">Refresh to load the last recovery request before starting another.</p> : null}
      {error ? <p role="alert" className="mt-3 text-xs text-error">{error}</p> : null}
      {run ? <div role="status" className="mt-3 text-xs">
        <p className="font-semibold">Last recovery request · {new Date(run.observedThrough).toLocaleString()}</p>
        <ul className="mt-1 text-foreground-muted">
          {(["stenographer", "reflection", "memory"] as const).map(lane => <li key={lane}><span className="capitalize">{lane}</span> — {admissionText(run[lane])}</li>)}
        </ul>
        <p className="mt-1 text-foreground-muted">Workers process queued jobs in the background. Current status updates below.</p>
      </div> : null}
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
