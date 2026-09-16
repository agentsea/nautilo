import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowLeft, RefreshCw, Info } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../hooks/use-auth";
import { useCan } from "../../hooks/use-can";
import { Button, GuestPlaceholder, PermissionPlaceholder } from "../settings/ui";
import {
  fetchCostsSummary,
  type CostsRangeKey,
  type CostsSummary,
} from "../../lib/costs-api";
import {
  RANGE_OPTIONS,
  buildModelBarRows,
  callTypeLabel,
  formatCompact,
  formatDayShort,
  formatInt,
  formatPercent,
  formatUsd,
  type ModelCostBarRow,
} from "./costs-view-model";

const PRIMARY = "var(--color-primary)";
export const COSTS_ADMIN_RETURN_PATH = "/admin#costs";

export function shouldReturnFromCostsOnEscape(
  key: string,
  active: Pick<HTMLElement, "tagName" | "isContentEditable"> | null,
): boolean {
  if (key !== "Escape") return false;
  if (!active) return true;
  return active.tagName !== "INPUT"
    && active.tagName !== "TEXTAREA"
    && !active.isContentEditable;
}

export function CostsPage() {
  const auth = useAuth();
  const can = useCan();
  const navigate = useNavigate();
  const allowed = can("manage_billing");

  const goBackToServerAdmin = useCallback(() => {
    void navigate(COSTS_ADMIN_RETURN_PATH);
  }, [navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (!shouldReturnFromCostsOnEscape(event.key, active)) return;
      void navigate(COSTS_ADMIN_RETURN_PATH);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const [range, setRange] = useState<CostsRangeKey>("30d");
  const [data, setData] = useState<CostsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (r: CostsRangeKey) => {
      setLoading(true);
      setError(null);
      try {
        setData(await fetchCostsSummary(r));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    void load(range);
  }, [allowed, range, load]);

  if (!allowed) {
    return (
      <PageFrame>
        {auth.viewer.isVerified ? (
          <PermissionPlaceholder what="the costs dashboard" />
        ) : (
          <GuestPlaceholder what="The costs dashboard" />
        )}
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="mb-2 flex items-center gap-1 text-xs text-foreground-muted">
            <button
              type="button"
              onClick={goBackToServerAdmin}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Server admin
            </button>
            <span aria-hidden="true"> / </span>
            <span className="text-foreground">Costs</span>
          </nav>
          <h1 className="text-2xl font-semibold tracking-tight">Costs</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Known model and accounted paid-tool spend.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border bg-background-panel p-0.5">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setRange(opt.key)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  range === opt.key
                    ? "bg-primary text-white"
                    : "text-foreground-muted hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <Button onClick={() => void load(range)} variant="secondary" title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="flex items-start gap-2 rounded-md border border-border bg-background-element px-3 py-2 text-xs text-foreground-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Costs include supported model and paid-tool activity. Some amounts are
          estimated from usage; others come directly from providers. If a cost
          cannot be determined, it is shown as unknown—not $0.
        </span>
      </div>

      {error ? (
        <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="py-12 text-center text-sm text-foreground-muted">Loading…</div>
      ) : data ? (
        <CostsContent data={data} />
      ) : null}
    </PageFrame>
  );
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-5 overflow-y-auto px-6 py-6">
      {children}
    </div>
  );
}

function CostsContent({ data }: { data: CostsSummary }) {
  const { totals } = data;
  const topModel = data.byModel[0];
  const hasAnyActual = totals.actualCostUsd > 0;
  const totalOperations = totals.calls + totals.providerOperations;

  const chartData = useMemo(
    () =>
      data.timeSeries.map((p) => ({
        day: p.day,
        label: formatDayShort(p.day),
        total: Number(p.totalCostUsd.toFixed(4)),
      })),
    [data.timeSeries],
  );

  if (totalOperations === 0) {
    return (
      <div className="rounded-lg border border-border bg-background-panel py-12 text-center text-sm text-foreground-muted">
        No model or accounted paid-tool usage recorded in this window yet.
      </div>
    );
  }

  return (
    <>
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard
          label="Known spend"
          value={formatUsd(totals.totalCostUsd)}
          sub={`${hasAnyActual
            ? `${formatUsd(totals.estimatedCostUsd)} est · ${formatUsd(totals.actualCostUsd)} actual`
            : "estimated"}${totals.unknownProviderOperations > 0
            ? ` · ${formatInt(totals.unknownProviderOperations)} unknown`
            : ""}`}
        />
        <StatCard
          label="Tokens"
          value={formatCompact(totals.totalTokens)}
          sub={`${formatCompact(totals.inputTokens)} in · ${formatCompact(totals.outputTokens)} out`}
        />
        <StatCard
          label="Cached"
          value={formatPercent(totals.cachedInputTokens, totals.inputTokens)}
          sub={
            totals.cachedInputTokens > 0
              ? `${formatCompact(totals.cachedInputTokens)} of input reads`
              : "of input tokens"
          }
        />
        <StatCard
          label="Operations"
          value={formatInt(totalOperations)}
          sub={`${formatInt(totals.calls)} model · ${formatInt(totals.providerOperations)} paid tool`}
        />
        <StatCard
          label="Top model"
          value={topModel ? topModel.displayName : "—"}
          sub={
            topModel
              ? `${formatUsd(topModel.totalCostUsd)} · ${formatPercent(topModel.totalCostUsd, totals.totalCostUsd)}`
              : undefined
          }
        />
      </div>

      {/* Time series */}
      <Panel title="Spend over time">
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: "var(--color-foreground-muted)" }}
                tickLine={false}
                axisLine={{ stroke: "var(--color-border)" }}
                minTickGap={24}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--color-foreground-muted)" }}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v) => formatUsd(Number(v))}
              />
              <Tooltip
                formatter={(v) => [formatUsd(Number(v)), "Spend"]}
                contentStyle={{
                  background: "var(--color-background-panel)",
                  border: "1px solid var(--color-border)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke={PRIMARY}
                strokeWidth={2}
                fill="url(#costFill)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel title="Paid providers">
        <ProviderCostList rows={data.byProvider} />
      </Panel>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="By model / provider">
          <BarList rows={buildModelBarRows(data.byModel)} total={totals.totalCostUsd} />
        </Panel>
        <Panel title="By model call type">
          <BarList
            rows={data.byCallType.map((c) => ({
              key: c.callType,
              label: callTypeLabel(c.callType),
              amount: c.totalCostUsd,
            }))}
            total={totals.totalCostUsd}
          />
        </Panel>
      </div>

      {/* By user */}
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
              {data.byUser.map((u) => (
                <tr key={u.userId ?? "system"} className="border-t border-border">
                  <td className="py-1.5">{u.label}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatInt(u.calls)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatInt(u.providerOperations)}
                    {u.unknownProviderOperations > 0 ? ` (${formatInt(u.unknownProviderOperations)} unknown)` : ""}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatCompact(u.totalTokens)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatUsd(u.estimatedCostUsd)}</td>
                  <td className="py-1.5 text-right tabular-nums text-foreground-muted">
                    {u.actualCostUsd > 0 ? formatUsd(u.actualCostUsd) : "—"}
                  </td>
                  <td className="py-1.5 text-right font-medium tabular-nums">
                    {formatUsd(u.totalCostUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

function ProviderCostList({ rows }: { rows: CostsSummary["byProvider"] }) {
  if (rows.length === 0) {
    return <div className="py-4 text-center text-xs text-foreground-muted">No accounted paid-tool activity</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-foreground-muted">
            <th className="pb-2 font-medium">Provider / operation</th>
            <th className="pb-2 text-right font-medium">Operations</th>
            <th className="pb-2 text-right font-medium">Unknown</th>
            <th className="pb-2 text-right font-medium">Known spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.provider}:${row.operation}`} className="border-t border-border">
              <td className="py-1.5">{providerOperationLabel(row.provider, row.operation)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatInt(row.operations)}</td>
              <td className="py-1.5 text-right tabular-nums text-foreground-muted">
                {formatInt(row.unknownOperations)}
              </td>
              <td className="py-1.5 text-right font-medium tabular-nums">
                {formatUsd(row.totalCostUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function providerOperationLabel(provider: string, operation: string): string {
  if (provider === "browser_use" && operation === "hosted_read") {
    return "Browser Use · Hosted read";
  }
  const words = `${provider} · ${operation}`.replaceAll("_", " ");
  return words.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background-panel px-4 py-3">
      <div className="text-xs text-foreground-muted">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tracking-tight" title={value}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 truncate text-xs text-foreground-muted">{sub}</div> : null}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-background-panel">
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

interface BarListRow {
  key: string;
  label: string;
  amount: number;
  /** Raw id/detail for diagnosis; defaults to label. */
  title?: string;
  badges?: ModelCostBarRow["badges"];
}

function BarList({ rows, total }: { rows: BarListRow[]; total: number }) {
  const max = rows.reduce((m, r) => Math.max(m, r.amount), 0);
  if (rows.length === 0) {
    return <div className="py-4 text-center text-xs text-foreground-muted">No data</div>;
  }
  return (
    <ul className="space-y-2">
      {rows.map((r) => {
        const width = max > 0 ? Math.max(2, (r.amount / max) * 100) : 0;
        return (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate" title={r.title ?? r.label}>
                {r.label}
                {(r.badges ?? []).map((badge) => (
                  <span
                    key={badge}
                    className="ml-1.5 rounded bg-background-element px-1 py-0.5 text-[10px] uppercase tracking-wide text-foreground-muted"
                  >
                    {badge}
                  </span>
                ))}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatUsd(r.amount)}
                <span className="ml-1.5 text-xs text-foreground-muted">
                  {formatPercent(r.amount, total)}
                </span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-background-element">
              <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
