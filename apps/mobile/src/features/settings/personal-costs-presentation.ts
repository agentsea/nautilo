import type { PersonalCostsSummary } from "@nautilo/api-client/browser";

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

const CALL_TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
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
