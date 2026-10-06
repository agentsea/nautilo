import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/use-auth";
import { useCan } from "../../hooks/use-can";
import {
  fetchCostsSummary,
  type CostsRangeKey,
  type CostsSummary,
} from "../../lib/costs-api";
import { GuestPlaceholder, PermissionPlaceholder } from "../settings/ui";
import { CostsDashboard, CostsDashboardPage, Panel } from "./costs-dashboard";
import { CostsRecoveryPanel } from "./costs-recovery-panel";
import {
  formatCompact,
  formatInt,
  formatUsd,
  normalizeAdminCosts,
} from "./costs-view-model";

export const COSTS_ADMIN_RETURN_PATH = "/admin#costs";

export function shouldReturnFromCostsOnEscape(
  key: string,
  active: Pick<HTMLElement, "tagName" | "isContentEditable"> | null,
): boolean {
  return (
    key === "Escape" &&
    (!active ||
      (active.tagName !== "INPUT" &&
        active.tagName !== "TEXTAREA" &&
        !active.isContentEditable))
  );
}

export function CostsPage() {
  const auth = useAuth();
  const allowed = useCan()("manage_billing");
  const navigate = useNavigate();
  const [range, setRange] = useState<CostsRangeKey>("30d");
  const [loaded, setLoaded] = useState<{ identityGeneration: number; range: CostsRangeKey; data: CostsSummary } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const load = useCallback(async (nextRange: CostsRangeKey) => {
    const request = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchCostsSummary(nextRange);
      if (request === requestGeneration.current) setLoaded({ identityGeneration: auth.viewerGeneration, range: nextRange, data: next });
    } catch (cause) {
      if (request === requestGeneration.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (request === requestGeneration.current) setLoading(false);
    }
  }, [auth.viewerGeneration]);
  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    void load(range);
    return () => { requestGeneration.current += 1; };
  }, [allowed, load, range]);

  const data = loaded !== null && loaded.identityGeneration === auth.viewerGeneration && loaded.range === range ? loaded.data : null;

  if (!allowed) {
    return (
      <div className="mx-auto flex h-full max-w-5xl flex-col px-6 py-6">
        {auth.viewer.isVerified ? (
          <PermissionPlaceholder what="the costs dashboard" />
        ) : (
          <GuestPlaceholder what="The costs dashboard" />
        )}
      </div>
    );
  }

  const goBack = () => {
    void navigate(COSTS_ADMIN_RETURN_PATH);
  };
  return (
    <CostsDashboardPage
      title="Costs"
      description="Known model and accounted paid-tool spend."
      returnLabel="Server admin"
      onReturn={goBack}
      range={range}
      onRangeChange={setRange}
      onRefresh={() => void load(range)}
      loading={loading}
      loadingLabel="Loading…"
      error={error}
      info={
        <>
          Costs include supported model and paid-tool activity. Some amounts are
          estimated from usage; others come directly from providers. If a cost
          cannot be determined, it is shown as unknown—not $0.
        </>
      }
    >
      {data ? (
        <CostsDashboard
          data={normalizeAdminCosts(data)}
          emptyMessage="No model or accounted paid-tool usage recorded in this window yet."
          afterBreakdowns={<>
            <AdminUsers data={data} />
            <CostsRecoveryPanel attempts={data.recovery?.attempts ?? []} keysPath="/admin#provider-credentials" />
          </>}
        />
      ) : null}
    </CostsDashboardPage>
  );
}

function AdminUsers({ data }: { data: CostsSummary }) {
  return (
    <Panel title="By user">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-foreground-muted">
              <th className="pb-2 font-medium">User</th>
              <th className="pb-2 text-right font-medium">Calls</th>
              <th className="pb-2 text-right font-medium">Paid ops</th>
              <th className="pb-2 text-right font-medium">Tokens</th>
              <th className="pb-2 text-right font-medium">Estimated</th>
              <th className="pb-2 text-right font-medium">Actual</th>
              <th className="pb-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.byUser.map((user) => (
              <tr
                key={user.userId ?? "system"}
                className="border-t border-border"
              >
                <td className="py-1.5">{user.label}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatInt(user.calls)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatInt(user.providerOperations)}
                  {user.unknownProviderOperations > 0
                    ? ` (${formatInt(user.unknownProviderOperations)} unknown)`
                    : ""}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatCompact(user.totalTokens)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatUsd(user.estimatedCostUsd)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-foreground-muted">
                  {user.actualCostUsd > 0 ? formatUsd(user.actualCostUsd) : "—"}
                </td>
                <td className="py-1.5 text-right font-medium tabular-nums">
                  {formatUsd(user.totalCostUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
