import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import { Button, GuestPlaceholder, PermissionPlaceholder, SectionCard } from "../../settings/ui";
import { fetchCostsSummary, type CostsSummary } from "../../../lib/costs-api";
import {
  formatCompact,
  formatPercent,
  formatUsd,
} from "../../costs/costs-view-model";

/**
 * Server admin → Costs. A compact 30-day spend summary gated on `manage_billing`,
 * with a button to the full `/costs` dashboard. Keeps cost out of the always-on
 * navigation rail while staying one click away for the people who manage it.
 */
export function CostsSummarySection() {
  const auth = useAuth();
  const can = useCan();
  const navigate = useNavigate();
  const allowed = can("manage_billing");

  const [data, setData] = useState<CostsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const summary = await fetchCostsSummary("30d");
        if (!cancelled) setData(summary);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  return (
    <SectionCard
      id="costs"
      title="Costs"
      description="Known model and accounted paid-tool spend (last 30 days)."
    >
      {!allowed ? (
        auth.viewer.isVerified ? (
          <PermissionPlaceholder what="cost and usage data" />
        ) : (
          <GuestPlaceholder what="Cost and usage data" />
        )
      ) : loading ? (
        <div className="py-4 text-sm text-foreground-muted">Loading…</div>
      ) : error ? (
        <div className="text-sm text-error">{error}</div>
      ) : data ? (
        <CostsSummaryBody data={data} onOpen={() => { void navigate("/costs"); }} />
      ) : null}
    </SectionCard>
  );
}

function CostsSummaryBody({
  data,
  onOpen,
}: {
  data: CostsSummary;
  onOpen: () => void;
}) {
  const { totals } = data;
  const hasActual = totals.actualCostUsd > 0;
  const cachedPct = formatPercent(totals.cachedInputTokens, totals.inputTokens);
  const cachingCold = totals.inputTokens > 0 && totals.cachedInputTokens === 0;

  if (totals.calls + totals.providerOperations === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-foreground-muted">
          No model or accounted paid-tool usage recorded in the last 30 days.
        </p>
        <div>
          <Button variant="secondary" onClick={onOpen}>
            View full cost dashboard
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MiniStat
          label="Known spend (30d)"
          value={formatUsd(totals.totalCostUsd)}
          sub={`${hasActual ? "estimated + actual" : "estimated"} · partial tool coverage`}
        />
        <MiniStat
          label="Model tokens"
          value={formatCompact(totals.totalTokens)}
          sub={`${formatCompact(totals.calls)} calls`}
        />
        <MiniStat
          label="Paid operations"
          value={formatCompact(totals.providerOperations)}
          sub={totals.unknownProviderOperations > 0
            ? `${formatCompact(totals.unknownProviderOperations)} unknown`
            : "tracked paid-tool operations"}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-foreground-muted">
        {cachingCold ? (
          <>
            <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-error" />
            <span>
              Cached: <strong>0%</strong> — prompt caching is off; every turn
              re-bills the full prompt (tracked in D407).
            </span>
          </>
        ) : (
          <span>
            Cached input: <strong>{cachedPct}</strong> of prompt tokens.
          </span>
        )}
      </div>

      <div>
        <Button variant="secondary" onClick={onOpen}>
          View full cost dashboard
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-background-element px-3 py-2">
      <div className="text-xs text-foreground-muted">{label}</div>
      <div className="mt-0.5 truncate text-base font-semibold tracking-tight" title={value}>
        {value}
      </div>
      {sub ? <div className="truncate text-xs text-foreground-muted">{sub}</div> : null}
    </div>
  );
}
