import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PersonalCostsRangeKey,
  PersonalCostsSummary,
} from "@nautilo/api-client/browser";
import { useNavigate } from "react-router-dom";
import { apiClient } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";
import { CostsDashboard, CostsDashboardPage } from "./costs-dashboard";
import { formatInt, formatUsd, normalizePersonalCosts } from "./costs-view-model";
import {
  CostsRecoveryPanel,
  CostsServiceOperations,
  CostsServiceRecoveryPanel,
  CostsTaskAttribution,
} from "./costs-recovery-panel";

export const PERSONAL_COSTS_RETURN_PATH = "/settings#personal-costs";

export function PersonalCostsPage() {
  const identityGeneration = useAuth().viewerGeneration;
  const navigate = useNavigate();
  const [range, setRange] = useState<PersonalCostsRangeKey>("30d");
  const [loaded, setLoaded] = useState<{
    identityGeneration: number;
    range: PersonalCostsRangeKey;
    data: PersonalCostsSummary;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setLoaded(null);
    try {
      const next = await apiClient.getPersonalCosts(range);
      if (generation === generationRef.current) {
        setLoaded({ identityGeneration, range, data: next });
      }
    } catch {
      if (generation === generationRef.current) {
        setError(
          "Your costs could not be loaded. Check your connection and try again.",
        );
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [identityGeneration, range]);

  useEffect(() => {
    void identityGeneration;
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [identityGeneration, load]);

  const goBack = useCallback(() => {
    void navigate(PERSONAL_COSTS_RETURN_PATH);
  }, [navigate]);
  const data =
    loaded !== null && loaded.identityGeneration === identityGeneration && loaded.range === range ? loaded.data : null;

  return (
    <CostsDashboardPage
      title="Your costs"
      description="API-key spending and ChatGPT plan usage for your account. Server-funded work stays in the separate administrator dashboard."
      returnLabel="Settings"
      onReturn={goBack}
      range={range}
      onRangeChange={setRange}
      onRefresh={() => void load()}
      loading={loading}
      loadingLabel="Loading your costs…"
      error={error}
      info={
        <>
          Known spend combines reported provider charges and fallback estimates.
          Unresolved costs remain excluded until a receipt is available. ChatGPT plan usage is shown separately.
        </>
      }
    >
      {!loading && !error && data && !data.entry.available ? (
        <section className="rounded-lg border border-border bg-background-panel p-5">
          <h2 className="text-sm font-semibold">No personal usage yet</h2>
          <p className="mt-1 text-sm text-foreground-muted">
            Connect your ChatGPT plan or add a supported API key to fund eligible work.
            Usage history remains available after you disconnect.
          </p>
          <button
            type="button"
            className="mt-3 text-sm text-primary hover:underline"
            onClick={() => void navigate("/settings#personal-provider-keys")}
          >
            Add a key or subscription
          </button>
        </section>
      ) : null}
      {!loading && !error && data?.entry.available ? (
        <>
        <SubscriptionUsage rows={data.subscriptions ?? []} />
        <CostsDashboard
          data={normalizePersonalCosts(data)}
          providerHeading="Provider routes and services"
          emptyMessage="No personal-key usage recorded in this window yet."
          beforeBreakdowns={<PersonalRecovery data={data} />}
          afterBreakdowns={<>
            <CostsTaskAttribution rows={data.byTask ?? []} />
            <CostsServiceOperations summary={data.serviceOperations ?? null} />
            <CostsServiceRecoveryPanel attempts={data.serviceRecovery?.attempts ?? []} />
            <CostsRecoveryPanel attempts={data.recovery.attempts ?? []} keysPath="/settings#personal-provider-keys" />
          </>}
        />
        </>
      ) : null}
    </CostsDashboardPage>
  );
}

function SubscriptionUsage({ rows }: { rows: NonNullable<PersonalCostsSummary["subscriptions"]> }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-background-panel p-5" aria-label="ChatGPT plan usage">
      <h2 className="text-sm font-semibold">Your ChatGPT plan usage</h2>
      <p className="mt-1 text-sm text-foreground-muted">
        Included in your ChatGPT plan allowance. API-equivalent estimates are comparisons,
        not additional charges, and are excluded from the spending totals. This does not show your remaining plan allowance.
      </p>
      <ul className="mt-3 space-y-3">
        {rows.map(row => (
          <li key={`${row.registrationId ?? "unknown"}:${row.model}`} className="text-sm">
            <p className="font-medium">{row.model} · ChatGPT connection {row.registrationId?.slice(0, 8) ?? "unavailable"}</p>
            <p>{formatInt(row.attempts)} attempts · {formatInt(row.inputTokens)} input tokens
              {" "}({formatInt(row.cachedInputTokens)} cached) · {formatInt(row.outputTokens)} output tokens</p>
            <p className="text-foreground-muted">API-equivalent estimate: {formatUsd(row.apiEquivalentCostUsd)} for reported usage.</p>
            {row.unresolvedAttempts > 0 ? <p className="text-warning">{formatInt(row.unresolvedAttempts)} attempts have unconfirmed outcomes; reported tokens may be incomplete. Check any partial output before retrying.</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PersonalRecovery({ data }: { data: PersonalCostsSummary }) {
  const modelUnresolved =
    data.recovery.pendingAttempts + data.recovery.unknownAttempts;
  const unknownPaid =
    (
      data.totals as PersonalCostsSummary["totals"] & {
        unknownProviderOperations?: number;
      }
    ).unknownProviderOperations ?? 0;
  if (modelUnresolved + unknownPaid === 0) return null;
  return (
    <section
      className="rounded-lg border border-warning/40 bg-warning/5 p-4"
      aria-label="Cost recovery status"
    >
      <h2 className="text-sm font-semibold">
        Some costs are still being resolved
      </h2>
      <p className="mt-1 text-xs text-foreground-muted">
        Pending {formatInt(data.recovery.pendingAttempts)} · Unknown model
        attempts {formatInt(data.recovery.unknownAttempts)} · Unknown paid
        operations {formatInt(unknownPaid)}. Of the model attempts,{" "}
        {formatInt(data.recovery.retryableAttempts)} are retrying and{" "}
        {formatInt(data.recovery.blockedAttempts)} are blocked.
      </p>
      {data.recovery.blockedAttempts > 0 ? (
        <p className="mt-2 text-xs text-warning">
          A provider key cannot currently read its cost receipts. Grant
          receipt-read permission to the key that created those requests, then
          use Check again in Settings. Receipts from a removed or replaced key
          may remain unresolved.
        </p>
      ) : null}
    </section>
  );
}
