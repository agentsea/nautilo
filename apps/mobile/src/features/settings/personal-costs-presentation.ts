import type { PersonalCostsRangeKey, PersonalCostsSummary } from "@nautilo/api-client/browser";
import type {
  ServiceCostOperationsSummary,
  ServiceCostRecoveryAttempt,
} from "@nautilo/types";

export interface PersonalCostDayRow {
  key: string;
  label: string;
  knownCostUsd: number;
}
export interface PersonalCostCallTypeRow {
  key: string;
  label: string;
  calls: number;
  knownCostUsd: number;
}
export interface PersonalCostProviderEvidence {
  knownCostUsd: number;
  actualCostUsd: number;
  currentEstimateUsd: number;
  unresolvedOperations: number;
  costPending: boolean;
  measuredUsage: string | null;
  detail: string;
}
export interface PersonalCostTaskRow {
  taskId: string;
  modelAttempts: number;
  paidOperations: number;
  actualCostUsd: number;
  currentEstimateUsd: number;
  knownCostUsd: number;
  unresolved: number;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const MEASURED_UNITS = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 8,
});

const CALL_TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
  decision: "Decision",
  deep_research: "Deep research",
  subagent: "Subagents",
  conductor: "Conductor",
  room_stenographer: "Room stenographer",
  room_reflection: "Room Reflection / Sleep",
  room_event_compaction: "Room event compaction",
  embedding: "Embeddings",
  image_gen: "Image generation",
  memory_flush: "Memory flush",
  memory_review: "Memory review",
  web_search: "Web search",
  session_search: "Session search",
  title: "Title generation",
  capability_probe: "Capability probes",
  soul: "Soul generation",
  other: "Other",
};

export function formatPersonalCostUsd(value: number): string {
  if (value > 0 && value < 0.005) return "<$0.01";
  return USD.format(value);
}

export function personalCostsForRequestedRange(
  summary: PersonalCostsSummary | null,
  requestedRange: PersonalCostsRangeKey,
): PersonalCostsSummary | null {
  return summary?.range.key === requestedRange ? summary : null;
}

export function personalCostDayRows(
  summary: Pick<PersonalCostsSummary, "timeSeries">,
): PersonalCostDayRow[] {
  return summary.timeSeries.map((point) => ({
    key: point.day,
    label: formatDay(point.day),
    knownCostUsd: point.totalCostUsd,
  }));
}

export function personalCostCallTypeRows(
  summary: Pick<PersonalCostsSummary, "byCallType">,
): PersonalCostCallTypeRow[] {
  return summary.byCallType.map((row) => ({
    key: row.callType,
    label: CALL_TYPE_LABELS[row.callType] ?? row.callType,
    calls: row.calls,
    knownCostUsd: row.totalCostUsd,
  }));
}

export function personalUnknownProviderOperations(
  summary: Pick<PersonalCostsSummary, "totals">,
): number {
  return (
    (
      summary.totals as PersonalCostsSummary["totals"] & {
        unknownProviderOperations?: number;
      }
    ).unknownProviderOperations ?? 0
  );
}

export function personalCostProviderEvidence(
  row: PersonalCostsSummary["byProvider"][number],
): PersonalCostProviderEvidence {
  const legacy = row as typeof row & {
    actualCostUsd?: number;
    estimatedCostUsd?: number;
    unknownOperations?: number;
    measuredUnits?: number | null;
    unitType?: string | null;
  };
  const actualCostUsd = legacy.actualCostUsd ?? 0;
  const currentEstimateUsd = legacy.estimatedCostUsd ?? 0;
  const unresolvedOperations = legacy.unknownOperations ?? 0;
  const measuredUsage = legacy.measuredUnits === null || legacy.measuredUnits === undefined || !legacy.unitType
    ? null
    : `${MEASURED_UNITS.format(legacy.measuredUnits)} ${legacy.unitType === "cloudconvert_credit" ? "credits" : legacy.unitType}`;
  const costPending = row.totalCostUsd === 0 && unresolvedOperations > 0;
  const costEvidence = costPending
    ? "USD cost unknown"
    : `${formatPersonalCostUsd(actualCostUsd)} actual · ${formatPersonalCostUsd(currentEstimateUsd)} current estimate`;
  return {
    knownCostUsd: row.totalCostUsd,
    actualCostUsd,
    currentEstimateUsd,
    unresolvedOperations,
    costPending,
    measuredUsage,
    detail: `${measuredUsage ? `${measuredUsage} · ` : ""}${costEvidence}${unresolvedOperations > 0 ? " · unresolved charges excluded" : ""}`,
  };
}

export function personalCostTaskRows(
  summary: Pick<PersonalCostsSummary, "byTask">,
): PersonalCostTaskRow[] {
  return (summary.byTask ?? []).map((row) => {
    const service = row as typeof row & {
      providerOperations?: number;
      unknownProviderOperations?: number;
    };
    return {
      taskId: row.taskId,
      modelAttempts: row.calls,
      paidOperations: service.providerOperations ?? 0,
      actualCostUsd: row.actualCostUsd,
      currentEstimateUsd: row.estimatedCostUsd,
      knownCostUsd: row.totalCostUsd,
      unresolved:
        row.pendingAttempts +
        row.unknownAttempts +
        (service.unknownProviderOperations ?? 0),
    };
  });
}

export function personalServiceOperations(
  summary: PersonalCostsSummary,
): ServiceCostOperationsSummary | null {
  return (
    summary as PersonalCostsSummary & {
      serviceOperations?: ServiceCostOperationsSummary;
    }
  ).serviceOperations ?? null;
}

export function personalServiceOutcomeText(
  summary: ServiceCostOperationsSummary,
): string {
  return `${summary.operations} operations · ${summary.succeeded} succeeded · ${summary.failed} failed · ${summary.cancelled} cancelled · ${summary.interrupted} interrupted · ${summary.unknown} unknown${summary.legacy > 0 ? ` · ${summary.legacy} older unclassified` : ""}`;
}

export function personalServiceRecoveryAttempts(
  summary: PersonalCostsSummary,
): readonly ServiceCostRecoveryAttempt[] {
  return (
    summary as PersonalCostsSummary & {
      serviceRecovery?: { attempts?: ServiceCostRecoveryAttempt[] };
    }
  ).serviceRecovery?.attempts ?? [];
}

function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}
