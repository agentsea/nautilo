import type { RoomHistoryTerminalExecutionSummary } from "@nautilo/types";

const EMPTY_TERMINAL_EXECUTIONS: readonly RoomHistoryTerminalExecutionSummary[] =
  Object.freeze([]);

export function terminalExecutionsFromMessageMetadata(
  metadata: unknown,
): readonly RoomHistoryTerminalExecutionSummary[] {
  const candidate = (metadata as {
    custom?: { terminalExecutions?: unknown };
  } | null | undefined)?.custom?.terminalExecutions;
  if (!Array.isArray(candidate)) return EMPTY_TERMINAL_EXECUTIONS;
  const valid = candidate.every((value) => {
    if (typeof value !== "object" || value === null) return false;
    const summary = value as Partial<RoomHistoryTerminalExecutionSummary>;
    return Number.isSafeInteger(summary.messageId)
      && typeof summary.executionId === "string"
      && summary.executionId.length > 0
      && (summary.classification === "cancelled"
        || summary.classification === "process_lost");
  });
  return valid
    ? candidate as readonly RoomHistoryTerminalExecutionSummary[]
    : EMPTY_TERMINAL_EXECUTIONS;
}

export function TerminalExecutionNotices({
  summaries,
}: {
  summaries: readonly RoomHistoryTerminalExecutionSummary[];
}) {
  if (summaries.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-xs text-foreground-muted">
      {summaries.map((summary) => (
        <div role="status" key={summary.executionId}>
          {summary.classification === "cancelled"
            ? "Response stopped."
            : "Response interrupted when Nautilo restarted."}
        </div>
      ))}
    </div>
  );
}
