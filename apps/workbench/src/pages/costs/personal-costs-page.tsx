import { useCallback, useEffect, useRef, useState } from "react";
import type { PersonalCostsRangeKey, PersonalCostsSummary } from "@nautilo/api-client/browser";
import { Link } from "react-router-dom";

import { apiClient } from "../../lib/api";
import { useAuth } from "../../hooks/use-auth";

const RANGES: readonly PersonalCostsRangeKey[] = ["7d", "30d", "90d"];

function usd(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
}

function count(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function PersonalCostsPage() {
  const auth = useAuth();
  const identityGeneration = auth.viewerGeneration;
  const [range, setRange] = useState<PersonalCostsRangeKey>("30d");
  const [data, setData] = useState<PersonalCostsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setData(null);
    try {
      const next = await apiClient.getPersonalCosts(range);
      if (generation !== generationRef.current) return;
      setData(next);
    } catch {
      if (generation !== generationRef.current) return;
      setError("Your costs could not be loaded. Check your connection and try again.");
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    // Identity generation is an invalidation token: a server/account switch
    // must clear this route even when the requested range did not change.
    void identityGeneration;
    void load();
    return () => { generationRef.current += 1; };
  }, [identityGeneration, load]);

  const unresolved = data
    ? data.recovery.pendingAttempts + data.recovery.unknownAttempts
    : 0;

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Your costs</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              Charges and estimates for work paid with your personal provider keys. Server-funded work stays in the separate administrator dashboard.
            </p>
          </div>
          <Link className="text-sm text-primary hover:underline" to="/settings#personal-provider-keys">Manage your API keys</Link>
        </header>

        <div className="flex gap-2" aria-label="Cost range">
          {RANGES.map((value) => <button
            key={value}
            type="button"
            onClick={() => setRange(value)}
            aria-pressed={range === value}
            className={`rounded-md border px-3 py-1.5 text-sm ${range === value ? "border-primary bg-primary/10 text-foreground" : "border-border text-foreground-muted"}`}
          >{value}</button>)}
        </div>

        {loading ? <p className="text-sm text-foreground-muted">Loading your costs…</p> : null}
        {error ? <div className="flex items-center gap-3"><p role="alert" className="text-sm text-error">{error}</p><button type="button" className="text-sm text-primary hover:underline" onClick={() => void load()}>Retry</button></div> : null}

        {!loading && !error && data && !data.entry.available ? (
          <section className="rounded-lg border border-border bg-background-panel p-5">
            <h2 className="text-sm font-semibold">No personal-key costs yet</h2>
            <p className="mt-1 text-sm text-foreground-muted">Add a supported personal key to pay for eligible work from your own provider account.</p>
            <Link className="mt-3 inline-flex text-sm text-primary hover:underline" to="/settings#personal-provider-keys">Add a personal API key</Link>
          </section>
        ) : null}

        {!loading && !error && data?.entry.available ? <>
          <section className="grid gap-3 sm:grid-cols-3">
            <SummaryCard label="Known personal-key cost" value={usd(data.totals.totalCostUsd)} detail={`${usd(data.totals.actualCostUsd)} actual · ${usd(data.totals.estimatedCostUsd)} estimated${unresolved > 0 ? " · unresolved charges excluded" : ""}`} />
            <SummaryCard label="Model attempts" value={count(data.totals.calls)} detail={`${count(data.totals.totalTokens)} tokens`} />
            <SummaryCard label="Cost status" value={unresolved === 0 ? "Settled" : `${count(unresolved)} unresolved`} detail={unresolved === 0 ? "No delayed receipts" : "See recovery status below"} />
          </section>

          {unresolved > 0 ? <section className="rounded-lg border border-warning/40 bg-warning/5 p-4" aria-label="Cost recovery status">
            <h2 className="text-sm font-semibold">Some costs are still being resolved</h2>
            <p className="mt-1 text-xs text-foreground-muted">Pending {count(data.recovery.pendingAttempts)} · Unknown {count(data.recovery.unknownAttempts)}. Of these, {count(data.recovery.retryableAttempts)} retrying and {count(data.recovery.blockedAttempts)} blocked.</p>
            {data.recovery.blockedAttempts > 0 ? <p className="mt-2 text-xs text-warning">A provider key cannot currently read its cost receipts. Grant receipt-read permission to the key that created those requests, then use Check again in Settings. Receipts from a removed or replaced key may remain unresolved.</p> : null}
          </section> : null}

          <section className="rounded-lg border border-border bg-background-panel">
            <header className="border-b border-border px-5 py-3"><h2 className="text-sm font-semibold">Models paid by you</h2></header>
            {data.byModel.length === 0 ? <p className="p-5 text-sm text-foreground-muted">No personal-key model usage in this period.</p> : <div className="divide-y divide-border">
              {data.byModel.map((row) => <div key={`${row.provider}:${row.model}`} className="grid gap-1 px-5 py-3 sm:grid-cols-[1fr_auto]">
                <div><p className="text-sm font-medium">{row.displayName}</p><p className="text-xs text-foreground-muted">{row.provider} · {count(row.calls)} attempts · {count(row.inputTokens + row.outputTokens)} tokens</p></div>
                <div className="text-left sm:text-right"><p className="text-sm font-medium">{row.totalCostUsd === 0 && row.unknownAttempts + row.pendingAttempts > 0 ? "Cost pending" : usd(row.totalCostUsd)}</p><p className="text-xs text-foreground-muted">{row.totalCostUsd === 0 && row.unknownAttempts + row.pendingAttempts > 0 ? "Unknown or pending receipt" : row.hasActual ? "Includes actual provider charges" : "Estimate"}{row.unknownAttempts + row.pendingAttempts > 0 ? " · unresolved attempts" : ""}</p></div>
              </div>)}
            </div>}
          </section>

          <section className="rounded-lg border border-border bg-background-panel">
            <header className="border-b border-border px-5 py-3"><h2 className="text-sm font-semibold">Provider routes</h2><p className="mt-1 text-xs text-foreground-muted">The marketplace or direct provider that actually handled each operation.</p></header>
            {data.byProvider.length === 0 ? <p className="p-5 text-sm text-foreground-muted">No personal-key provider usage in this period.</p> : <div className="divide-y divide-border">
              {data.byProvider.map((row) => {
                const costPending = row.totalCostUsd === 0 && row.unknownOperations > 0;
                return <div key={`${row.provider}:${row.operation}`} className="grid gap-1 px-5 py-3 sm:grid-cols-[1fr_auto]">
                  <div><p className="text-sm font-medium">{row.provider} / {row.operation}</p><p className="text-xs text-foreground-muted">{count(row.operations)} operations{row.unknownOperations > 0 ? ` · ${count(row.unknownOperations)} unresolved` : ""}</p></div>
                  <div className="text-left sm:text-right"><p className="text-sm font-medium">{costPending ? "Cost pending" : usd(row.totalCostUsd)}</p><p className="text-xs text-foreground-muted">{costPending ? "Unknown or pending receipt" : `${usd(row.actualCostUsd)} actual · ${usd(row.estimatedCostUsd)} estimated`}{row.unknownOperations > 0 ? " · unresolved charges excluded" : ""}</p></div>
                </div>;
              })}
            </div>}
          </section>
        </> : null}
      </main>
    </div>
  );
}

function SummaryCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="rounded-lg border border-border bg-background-panel p-4"><p className="text-xs text-foreground-muted">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p><p className="mt-1 text-xs text-foreground-muted">{detail}</p></div>;
}
