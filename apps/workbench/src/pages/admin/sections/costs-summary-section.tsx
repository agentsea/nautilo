import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { useAuth } from "../../../hooks/use-auth";
import { useCan } from "../../../hooks/use-can";
import {
  Button,
  GuestPlaceholder,
  PermissionPlaceholder,
  SectionCard,
} from "../../settings/ui";
import { fetchCostsSummary, type CostsSummary } from "../../../lib/costs-api";
import {
  formatPercent,
  normalizeAdminCosts,
} from "../../costs/costs-view-model";
import { CostsCompactSummary } from "../../costs/costs-dashboard";

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

  const [loaded, setLoaded] = useState<{ identityGeneration: number; data: CostsSummary } | null>(null);
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
        if (!cancelled) setLoaded({ identityGeneration: auth.viewerGeneration, data: summary });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed, auth.viewerGeneration]);

  const data = loaded !== null && loaded.identityGeneration === auth.viewerGeneration ? loaded.data : null;

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
        <CostsSummaryBody
          data={data}
          onOpen={() => {
            void navigate("/costs");
          }}
        />
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
  const cachedPct = formatPercent(totals.cachedInputTokens, totals.inputTokens);

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
    <CostsCompactSummary
      data={normalizeAdminCosts(data)}
      periodLabel="30d"
      footer={
        <p className="text-xs text-foreground-muted">
          Cached input: <strong>{cachedPct}</strong> of recorded prompt tokens.
        </p>
      }
      action={
        <Button variant="secondary" onClick={onOpen}>
          View full cost dashboard
          <ArrowRight className="h-4 w-4" />
        </Button>
      }
    />
  );
}
