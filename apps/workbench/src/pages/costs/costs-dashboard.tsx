import { useEffect, useMemo, type ReactNode } from "react";
import { ArrowLeft, Info, RefreshCw } from "lucide-react";
import type { CostsRangeKey } from "../../lib/costs-api";
import { RANGE_OPTIONS } from "./costs-view-model";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  callTypeLabel,
  formatCompact,
  formatDayShort,
  formatInt,
  formatPercent,
  formatUsd,
  type ModelCostBarRow,
} from "./costs-view-model";

const PRIMARY = "var(--color-primary)";

export function CostsDashboardPage({
  title,
  description,
  returnLabel,
  onReturn,
  range,
  onRangeChange,
  onRefresh,
  loading,
  loadingLabel,
  error,
  info,
  children,
}: {
  title: string;
  description: string;
  returnLabel: string;
  onReturn: () => void;
  range: CostsRangeKey;
  onRangeChange: (range: CostsRangeKey) => void;
  onRefresh: () => void;
  loading: boolean;
  loadingLabel: string;
  error: string | null;
  info: ReactNode;
  children?: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      if (
        event.key === "Escape" &&
        (!active ||
          (active.tagName !== "INPUT" &&
            active.tagName !== "TEXTAREA" &&
            !active.isContentEditable))
      )
        onReturn();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onReturn]);

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-5 overflow-y-auto px-6 py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <nav className="mb-2 flex items-center gap-1 text-xs text-foreground-muted">
            <button
              type="button"
              onClick={onReturn}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {returnLabel}
            </button>
            <span aria-hidden="true"> / </span>
            <span className="text-foreground">{title}</span>
          </nav>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-foreground-muted">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <RangePicker range={range} onChange={onRangeChange} />
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh"
            aria-label="Refresh"
            className="rounded-md border border-border bg-background-panel p-2 text-foreground-muted hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>
      <div className="flex items-start gap-2 rounded-md border border-border bg-background-element px-3 py-2 text-xs text-foreground-muted">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{info}</span>
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error"
        >
          {error}
        </div>
      ) : null}
      {loading ? (
        <div className="py-12 text-center text-sm text-foreground-muted">
          {loadingLabel}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function RangePicker({
  range,
  onChange,
}: {
  range: CostsRangeKey;
  onChange: (range: CostsRangeKey) => void;
}) {
  return (
    <div
      className="flex rounded-md border border-border bg-background-panel p-0.5"
      aria-label="Cost range"
    >
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          aria-pressed={range === option.key}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${range === option.key ? "bg-primary text-white" : "text-foreground-muted hover:text-foreground"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface NormalizedCostsDashboard {
  totals: {
    calls: number;
    providerOperations: number;
    unknownProviderOperations: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    actualCostUsd: number;
    totalCostUsd: number;
    unresolvedModelAttempts: number;
  };
  byModel: ModelCostBarRow[];
  byCallType: Array<{ callType: string; calls: number; totalCostUsd: number }>;
  byProvider: Array<{
    provider: string;
    operation: string;
    operations: number;
    unknownOperations: number;
    totalCostUsd: number;
  }>;
  timeSeries: Array<{ day: string; totalCostUsd: number }>;
}

export function CostsDashboard({
  data,
  providerHeading = "Paid providers",
  emptyMessage,
  beforeBreakdowns,
  afterBreakdowns,
}: {
  data: NormalizedCostsDashboard;
  providerHeading?: string;
  emptyMessage: string;
  beforeBreakdowns?: ReactNode;
  afterBreakdowns?: ReactNode;
}) {
  const { totals } = data;
  const totalOperations = totals.calls + totals.providerOperations;
  const topModel = data.byModel[0];
  const chartData = useMemo(
    () =>
      data.timeSeries.map((point) => ({
        day: point.day,
        label: formatDayShort(point.day),
        total: Number(point.totalCostUsd.toFixed(4)),
      })),
    [data.timeSeries],
  );

  if (totalOperations === 0) {
    return (
      <div className="rounded-lg border border-border bg-background-panel py-12 text-center text-sm text-foreground-muted">
        {emptyMessage}
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard
          label="Known spend"
          value={formatUsd(totals.totalCostUsd)}
          sub={`${formatUsd(totals.actualCostUsd)} actual · ${formatUsd(totals.estimatedCostUsd)} current estimate${totals.unknownProviderOperations > 0 ? ` · ${formatInt(totals.unknownProviderOperations)} unknown paid ${totals.unknownProviderOperations === 1 ? "operation" : "operations"}` : ""}${totals.unresolvedModelAttempts > 0 ? ` · ${formatInt(totals.unresolvedModelAttempts)} unresolved model ${totals.unresolvedModelAttempts === 1 ? "attempt" : "attempts"}` : ""}`}
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
          sub={`${formatInt(totals.calls)} model attempts · ${formatInt(totals.providerOperations)} paid tool`}
        />
        <StatCard
          label="Top model"
          value={topModel?.label ?? "—"}
          sub={
            topModel
              ? `${formatUsd(topModel.amount)} · ${formatPercent(topModel.amount, totals.totalCostUsd)}`
              : undefined
          }
        />
      </div>

      {beforeBreakdowns}

      <Panel title="Spend over time">
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--color-border)"
                vertical={false}
              />
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
                tickFormatter={(value) => formatUsd(Number(value))}
              />
              <Tooltip
                formatter={(value) => [formatUsd(Number(value)), "Spend"]}
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

      <Panel title={providerHeading}>
        <ProviderCostList rows={data.byProvider} />
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="By model / provider">
          <BarList rows={data.byModel} total={totals.totalCostUsd} />
        </Panel>
        <Panel title="By model call type">
          <BarList
            rows={data.byCallType.map((row) => ({
              key: row.callType,
              label: callTypeLabel(row.callType),
              amount: row.totalCostUsd,
            }))}
            total={totals.totalCostUsd}
          />
        </Panel>
      </div>
      {afterBreakdowns}
    </>
  );
}

export function CostsCompactSummary({
  data,
  periodLabel,
  action,
  footer,
}: {
  data: NormalizedCostsDashboard;
  periodLabel: string;
  action: ReactNode;
  footer?: ReactNode;
}) {
  const { totals } = data;
  const unresolved =
    totals.unresolvedModelAttempts + totals.unknownProviderOperations;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MiniStat
          label={`Known spend (${periodLabel})`}
          value={formatUsd(totals.totalCostUsd)}
          sub={`${formatUsd(totals.actualCostUsd)} actual · ${formatUsd(totals.estimatedCostUsd)} current estimate${unresolved > 0 ? " · unresolved excluded" : ""}`}
        />
        <MiniStat
          label="Model usage"
          value={formatCompact(totals.totalTokens)}
          sub={`${formatCompact(totals.calls)} attempts`}
        />
        <MiniStat
          label="Paid operations"
          value={formatCompact(totals.providerOperations)}
          sub={
            totals.unknownProviderOperations > 0
              ? `${formatCompact(totals.unknownProviderOperations)} unknown`
              : "Tracked paid-service operations"
          }
        />
      </div>
      {footer}
      <div>{action}</div>
    </div>
  );
}

export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-background-panel">
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background-panel px-4 py-3">
      <div className="text-xs text-foreground-muted">{label}</div>
      <div
        className="mt-1 truncate text-lg font-semibold tracking-tight"
        title={value}
      >
        {value}
      </div>
      {sub ? (
        <div className="mt-0.5 text-xs text-foreground-muted">{sub}</div>
      ) : null}
    </div>
  );
}

function MiniStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-border bg-background-element px-3 py-2">
      <div className="text-xs text-foreground-muted">{label}</div>
      <div
        className="mt-0.5 truncate text-base font-semibold tracking-tight"
        title={value}
      >
        {value}
      </div>
      {sub ? <div className="text-xs text-foreground-muted">{sub}</div> : null}
    </div>
  );
}

function ProviderCostList({
  rows,
}: {
  rows: NormalizedCostsDashboard["byProvider"];
}) {
  if (rows.length === 0)
    return (
      <div className="py-4 text-center text-xs text-foreground-muted">
        No accounted paid-tool activity
      </div>
    );
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
            <tr
              key={`${row.provider}:${row.operation}`}
              className="border-t border-border"
            >
              <td className="py-1.5">
                {providerOperationLabel(row.provider, row.operation)}
              </td>
              <td className="py-1.5 text-right tabular-nums">
                {formatInt(row.operations)}
              </td>
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

function providerOperationLabel(
  provider: string,
  operation: string,
): string {
  if (provider === "browser_use" && operation === "hosted_read")
    return "Browser Use · Hosted read";
  return `${provider} · ${operation}`
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

interface BarListRow {
  key: string;
  label: string;
  amount: number;
  title?: string;
  badges?: ModelCostBarRow["badges"];
}
function BarList({ rows, total }: { rows: BarListRow[]; total: number }) {
  const max = rows.reduce((value, row) => Math.max(value, row.amount), 0);
  if (rows.length === 0)
    return (
      <div className="py-4 text-center text-xs text-foreground-muted">
        No data
      </div>
    );
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate" title={row.title ?? row.label}>
              {row.label}
              {(row.badges ?? []).map((badge) => (
                <span
                  key={badge}
                  className="ml-1.5 rounded bg-background-element px-1 py-0.5 text-[10px] uppercase tracking-wide text-foreground-muted"
                >
                  {badge}
                </span>
              ))}
            </span>
            <span className="shrink-0 tabular-nums">
              {formatUsd(row.amount)}
              <span className="ml-1.5 text-xs text-foreground-muted">
                {formatPercent(row.amount, total)}
              </span>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-background-element">
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${max > 0 ? Math.max(2, (row.amount / max) * 100) : 0}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
