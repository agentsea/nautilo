import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ReflectionAdminStatus } from "@nautilo/types";
import type { ServerContextConfig } from "@nautilo/api-client";
import { apiClient } from "../../../lib/api";
import { useCan } from "../../../hooks/use-can";
import { formatRelativeTime } from "../../../components/approvals/format-relative-time";

const INTEGER_FORMAT = new Intl.NumberFormat();

function count(value: number | string): string {
  return INTEGER_FORMAT.format(typeof value === "string" ? BigInt(value) : value);
}

function duration(valueMs: number): string {
  if (valueMs < 1_000) return `${Math.round(valueMs)} ms`;
  if (valueMs < 60_000) return `${(valueMs / 1_000).toFixed(1)} s`;
  return `${Math.floor(valueMs / 60_000)}m ${Math.round((valueMs % 60_000) / 1_000)}s`;
}

function pillClass(health: ReflectionAdminStatus["health"]): string {
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

function StatusBody({
  status,
  canViewCosts,
}: {
  status: ReflectionAdminStatus;
  canViewCosts: boolean;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span
          data-testid="reflection-health-pill"
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${pillClass(status.health)}`}
        >
          {status.health}
        </span>
        <span className="text-xs text-foreground-muted">
          Generated {formatRelativeTime(status.generatedAt)}
        </span>
      </div>

      <div
        data-testid="reflection-scheduler-status"
        className="mt-3 rounded-md border border-border/60 bg-background-element px-3 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
              Sleep scheduler
            </h4>
            <p className="mt-1 text-sm font-semibold capitalize text-foreground">
              {status.scheduler.state.replaceAll("_", " ")}
              {status.scheduler.pauseReason
                ? ` · ${status.scheduler.pauseReason.replaceAll("_", " ")}`
                : ""}
            </p>
          </div>
          <p className="text-xs text-foreground-muted">
            {status.scheduler.nextEligiblePollAt
              ? `Next eligible ${formatRelativeTime(status.scheduler.nextEligiblePollAt)}`
              : "No poll scheduled"}
          </p>
        </div>
        <p className="mt-2 text-xs text-foreground-muted">
          Recovery interval {duration(status.scheduler.recoveryIntervalMs)} · backlog{" "}
          {count(status.scheduler.backlog.size)} · oldest{" "}
          {duration(status.scheduler.backlog.oldestAgeMs)} · amplification{" "}
          {status.scheduler.amplification}
        </p>
        <p className="mt-1 text-xs text-foreground-muted">
          Window: {count(status.scheduler.window.polls)} polls ·{" "}
          {count(status.scheduler.window.admitted)} admitted ·{" "}
          {count(status.scheduler.window.completed)} completed ·{" "}
          {count(status.scheduler.window.created)} created
        </p>
        {status.scheduler.lastPoll ? (
          <p className="mt-1 text-xs text-foreground-muted">
            Last poll: {duration(status.scheduler.lastPoll.elapsedMs)} ·{" "}
            {count(status.scheduler.lastPoll.claims)} claims ·{" "}
            {count(status.scheduler.lastPoll.databaseWork)} durable operations ·{" "}
            {count(status.scheduler.lastPoll.modelCalls)} model attempts ·{" "}
            {count(status.scheduler.lastPoll.modelFailures)} provider failures
          </p>
        ) : null}
        {status.scheduler.lastPoll ? (
          <p className="mt-1 text-xs text-foreground-muted">
            Planning: {count(status.scheduler.lastPoll.sameRoomPlans)} same-Room ·{" "}
            {count(status.scheduler.lastPoll.crossRoomPlans)} cross-Room ·{" "}
            completed {count(status.scheduler.lastPoll.sameRoomCompletions)} same-Room /{" "}
            {count(status.scheduler.lastPoll.crossRoomCompletions)} cross-Room ·{" "}
            {count(status.scheduler.lastPoll.candidatesOpened)} opened ·{" "}
            {count(status.scheduler.lastPoll.unsupportedAuthorityShapes)} unsupported authority ·{" "}
            {count(status.scheduler.lastPoll.stalePlans)} stale ·{" "}
            {count(status.scheduler.lastPoll.capacityOutcomes)} capacity ·{" "}
            {count(status.scheduler.lastPoll.noEffectiveAudience)} empty audience ·{" "}
            {count(status.scheduler.lastPoll.protectedExecutionUnavailable)} protected unavailable
          </p>
        ) : null}
        {status.scheduler.lastPoll ? (
          <p className="mt-1 text-xs text-foreground-muted">
            Stages: authority {duration(status.scheduler.lastPoll.authorityElapsedMs)} ·{" "}
            search {duration(status.scheduler.lastPoll.searchProjectionElapsedMs)} ·{" "}
            candidates {duration(status.scheduler.lastPoll.candidateElapsedMs)} ·{" "}
            model {duration(status.scheduler.lastPoll.modelElapsedMs)} ·{" "}
            publication {duration(status.scheduler.lastPoll.publicationElapsedMs)} ·{" "}
            {count(status.scheduler.lastPoll.deterministicNoChanges)} fast no-change
          </p>
        ) : null}
        <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
          {([
            ["Same-Room", status.scheduler.latency.sameRoom],
            ["Cross-Room", status.scheduler.latency.crossRoom],
          ] as const).map(([label, latency]) => (
            <div key={label}>
              <h5 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
                {label} item latency
              </h5>
              {latency.endToEnd.samples === 0 ? (
                <p className="mt-1 text-xs text-foreground-muted">
                  No completed samples in this process yet.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-foreground-muted">
                    {count(latency.endToEnd.samples)} samples · end-to-end p50{" "}
                    {duration(latency.endToEnd.p50Ms)} · p90{" "}
                    {duration(latency.endToEnd.p90Ms)} · max{" "}
                    {duration(latency.endToEnd.maximumMs)}
                  </p>
                  <p className="mt-1 text-xs text-foreground-muted">
                    p50 queue {duration(latency.queue.p50Ms)} · candidates{" "}
                    {duration(latency.candidate.p50Ms)} · model{" "}
                    {duration(latency.model.p50Ms)} · publish{" "}
                    {duration(latency.publication.p50Ms)}
                  </p>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {status.protectedAuthority ? (
        <div
          data-testid="reflection-protected-authority-status"
          className="mt-3 rounded-md border border-border/60 bg-background-element px-3 py-3"
        >
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Protected authority maintenance
          </h4>
          <p className="mt-1 text-xs text-foreground-muted">
            Authority maintenance only. These counts do not represent model
            Reflection, and ordinary fallback is not a protected success.
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Fact
              label="Awaiting recipient"
              value={count(status.protectedAuthority.current.awaitingRecipient)}
            />
            <Fact
              label="Eligible device and keys"
              value={count(
                status.protectedAuthority.current.awaitingEligibleDeviceAndKeys,
              )}
            />
            <Fact
              label="Ready / running"
              value={count(status.protectedAuthority.current.readyOrRunning)}
            />
            <Fact
              label="Verified authority"
              value={count(status.protectedAuthority.current.verifiedAuthority)}
            />
            <Fact
              label="Reconciliation pending"
              value={count(status.protectedAuthority.current.reconciliationPending)}
            />
            <Fact
              label="Retirement pending"
              value={count(status.protectedAuthority.current.retirementPending)}
            />
            <Fact
              label="Terminal / stale"
              value={count(status.protectedAuthority.current.terminalOrStale)}
            />
          </dl>
          <p className="mt-2 text-xs text-foreground-muted">
            “Eligible device and keys” is one wait state: the server cannot
            distinguish an offline device from unavailable keys.
          </p>
          <p className="mt-1 text-xs text-foreground-muted">
            Last 24 hours: {count(status.protectedAuthority.last24h.verifiedAuthority)}{" "}
            verified authority · {count(status.protectedAuthority.last24h.terminalOrStale)}{" "}
            terminal / stale
          </p>
        </div>
      ) : null}

      {status.current.totalRecords === 0 ? (
        <p className="mt-3 text-sm text-foreground-muted">
          No Reflection Records yet. Sleep is healthy and waiting for Stenographer work.
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Fact label="Records" value={count(status.current.totalRecords)} />
        <Fact label="Backlog" value={count(status.current.backlog)} />
        <Fact label="Processing" value={count(status.current.claimed)} />
        <Fact label="Deferred" value={count(status.current.deferred)} />
        <Fact label="Quarantined" value={count(status.current.quarantined)} />
        <Fact label="Recovery eligible" value={count(status.current.recoveryEligible)} />
        <Fact label="Recovery round" value={count(status.current.maximumRecoveryRound)} />
        <Fact label="Stale leases" value={count(status.current.staleLeases)} />
        <Fact label="Oldest overdue" value={duration(status.current.oldestOverdueMs)} />
        <Fact label="Maximum attempts" value={count(status.current.maximumAttempts)} />
        <Fact
          label="Multiple current parents"
          value={count(status.current.currentParentViolations)}
        />
        <Fact label="Completed" value={count(status.current.complete)} />
      </dl>

      <div className="mt-4 grid gap-3 border-t border-border/60 pt-3 sm:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Work stages
          </h4>
          <p className="mt-1 text-xs text-foreground">
            Authority {count(status.stages.authorityProjection)} · search projection{" "}
            {count(status.stages.searchProjection)} · organization{" "}
            {count(status.stages.organization)}
          </p>
          <p className="mt-1 text-xs text-foreground-muted">
            Due {count(status.current.due)} · checkpointed{" "}
            {count(status.current.checkpointed)}
          </p>
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Search projections
          </h4>
          <p className="mt-1 text-xs text-foreground">
            Current {count(status.projections.current)} /{" "}
            {count(status.projections.availableRecords)} · pending{" "}
            {count(status.projections.pending)} · incompatible{" "}
            {count(status.projections.incompatible)}
          </p>
        </div>
      </div>

      <div className="mt-4 border-t border-border/60 pt-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
          Last 24 hours
        </h4>
        <p className="mt-1 text-xs text-foreground">
          Completed work {count(status.last24h.completedWork)} · synthetic parents{" "}
          {count(status.last24h.syntheticParentsCreated)}
        </p>
        <p className="mt-1 text-xs text-foreground-muted">
          Last completed {status.lastCompletedAt
            ? formatRelativeTime(status.lastCompletedAt)
            : "—"}
        </p>
        <p className="mt-1 text-xs text-foreground-muted">
          Next quarantine recovery {status.nextRecoveryAt
            ? formatRelativeTime(status.nextRecoveryAt)
            : "—"}
        </p>
      </div>

      {status.currentFailures.length > 0 ? (
        <div className="mt-4 border-t border-border/60 pt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            Current failures
          </h4>
          <ul className="mt-2 space-y-1 text-xs" data-testid="reflection-current-failures">
            {status.currentFailures.map((failure) => (
              <li
                key={`${failure.stage}:${failure.occurredAt}:${failure.attemptCount}`}
                className="text-foreground-muted"
              >
                <span className="font-medium text-foreground">
                  {failure.stage.replaceAll("_", " ")}
                </span>
                {" · "}{failure.errorCode.replaceAll("_", " ")}
                {" · "}{formatRelativeTime(failure.occurredAt)}
                {" · attempt "}{failure.attemptCount}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canViewCosts ? (
        <Link to="/costs" className="mt-4 inline-flex text-xs font-medium text-primary hover:underline">
          View model costs
        </Link>
      ) : null}
    </>
  );
}

export function ReflectionHealthCard() {
  const can = useCan();
  const canRead = can("read_server_settings");
  const canManage = can("manage_server_operations");
  const canViewCosts = can("manage_billing");
  const [status, setStatus] = useState<ReflectionAdminStatus | null>(null);
  const [loading, setLoading] = useState(canRead);
  const [error, setError] = useState<string | null>(null);
  const [contextConfig, setContextConfig] = useState<ServerContextConfig | null>(null);
  const [controlLoading, setControlLoading] = useState(canRead);
  const [controlSaving, setControlSaving] = useState<"sleep" | "recall" | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await apiClient.admin.reflectionStatus.get());
    } catch {
      setError("Reflection status is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  const loadControls = useCallback(async () => {
    if (!canRead) return;
    setControlLoading(true);
    setControlError(null);
    try {
      setContextConfig(await apiClient.admin.serverContext.get());
    } catch {
      setControlError("Reflection controls are unavailable.");
    } finally {
      setControlLoading(false);
    }
  }, [canRead]);

  const setPassiveRecall = useCallback(async (enabled: boolean) => {
    if (!canManage || contextConfig === null) return;
    setControlSaving("recall");
    setControlError(null);
    try {
      setContextConfig(await apiClient.admin.serverContext.set({
        passiveRecallEnabled: enabled,
      }));
    } catch {
      setControlError("Could not update passive recall.");
    } finally {
      setControlSaving(null);
    }
  }, [canManage, contextConfig]);

  const setReflectionSleep = useCallback(async (enabled: boolean) => {
    if (!canManage || contextConfig === null) return;
    setControlSaving("sleep");
    setControlError(null);
    try {
      setContextConfig(await apiClient.admin.serverContext.set({
        reflectionSleepEnabled: enabled,
      }));
    } catch {
      setControlError("Could not update Reflection Sleep.");
    } finally {
      setControlSaving(null);
    }
  }, [canManage, contextConfig]);

  useEffect(() => {
    if (!canRead) return;
    void loadStatus();
    void loadControls();
  }, [canRead, loadControls, loadStatus]);

  if (!canRead) return null;

  return (
    <div data-testid="reflection-health-card" className="mt-4 rounded-lg border border-border bg-background-panel/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Reflection / Sleep health</h3>
          <p className="mt-0.5 text-xs text-foreground-muted">
            Content-free hierarchical memory processing status.
          </p>
        </div>
        <button
          type="button"
          data-testid="reflection-refresh"
          disabled={loading}
          onClick={() => void loadStatus()}
          className="rounded-md border border-border bg-background-element px-2.5 py-1 text-xs font-medium text-foreground hover:bg-background-panel disabled:opacity-50"
        >
          {loading && status ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {controlError ? (
        <p className="mt-3 text-xs text-error" role="alert">{controlError}</p>
      ) : null}
      <div className="mt-3 flex items-start justify-between gap-4 rounded-md border border-border/60 bg-background-element px-3 py-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Reflection Sleep</p>
          <p className="mt-0.5 max-w-2xl text-xs text-foreground-muted">
            Builds and maintains organized Records in the background. This is
            on by default for new servers. Turning it off stops new background
            claims and preserves the durable backlog; existing Records, passive
            and explicit recall, Journal context, and Stenographer remain
            available. Existing servers keep their persisted selection.
          </p>
          {!canManage && contextConfig !== null ? (
            <p className="mt-1 text-xs text-foreground-muted">
              Read-only — manage server operations permission is required.
            </p>
          ) : null}
        </div>
        {controlLoading && contextConfig === null ? (
          <span className="text-xs text-foreground-muted">Loading…</span>
        ) : contextConfig !== null ? (
          <button
            type="button"
            role="switch"
            aria-label="Reflection Sleep"
            aria-checked={contextConfig.reflectionSleepEnabled}
            data-testid="reflection-sleep-switch"
            disabled={!canManage || controlSaving !== null}
            onClick={() => void setReflectionSleep(!contextConfig.reflectionSleepEnabled)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold disabled:opacity-60 ${
              contextConfig.reflectionSleepEnabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "border-border bg-background-panel text-foreground-muted"
            }`}
          >
            {controlSaving === "sleep"
              ? "Saving…"
              : contextConfig.reflectionSleepEnabled ? "On" : "Off"}
          </button>
        ) : null}
      </div>
      <div className="mt-3 flex items-start justify-between gap-4 rounded-md border border-border/60 bg-background-element px-3 py-3">
        <div>
          <p className="text-sm font-semibold text-foreground">Passive recall</p>
          <p className="mt-0.5 max-w-2xl text-xs text-foreground-muted">
            Automatically searches authorized organized Records for each fresh
            Room turn and adds relevant results to the prompt. Turn this off to
            remove that optional foreground lookup; Journal context, explicit
            recall, and background Reflection / Sleep continue working.
          </p>
          {!canManage && contextConfig !== null ? (
            <p className="mt-1 text-xs text-foreground-muted">
              Read-only — manage server operations permission is required.
            </p>
          ) : null}
        </div>
        {controlLoading && contextConfig === null ? (
          <span className="text-xs text-foreground-muted">Loading…</span>
        ) : contextConfig !== null ? (
          <button
            type="button"
            role="switch"
            aria-label="Passive recall"
            aria-checked={contextConfig.passiveRecallEnabled}
            data-testid="passive-recall-switch"
            disabled={!canManage || controlSaving !== null}
            onClick={() => void setPassiveRecall(!contextConfig.passiveRecallEnabled)}
            className={`shrink-0 rounded-full border px-3 py-1 text-xs font-semibold disabled:opacity-60 ${
              contextConfig.passiveRecallEnabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "border-border bg-background-panel text-foreground-muted"
            }`}
          >
            {controlSaving === "recall"
              ? "Saving…"
              : contextConfig.passiveRecallEnabled ? "On" : "Off"}
          </button>
        ) : null}
      </div>
      {loading && !status ? (
        <p className="mt-3 text-sm text-foreground-muted">Loading Reflection status…</p>
      ) : error ? (
        <p className="mt-3 text-sm text-error" role="alert">{error}</p>
      ) : status ? (
        <div className="mt-3"><StatusBody status={status} canViewCosts={canViewCosts} /></div>
      ) : null}
    </div>
  );
}
