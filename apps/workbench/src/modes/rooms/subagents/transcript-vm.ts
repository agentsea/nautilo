/**
 * D314 (Stack 92) — LOCAL view-model for the Subagent Transcript Inspector
 * (L1 condensed feed + L2 full-transcript drawer).
 *
 * Shared runtime-free mapping lives in `@nautilo/types`. Desktop and Mobile retain the mapper's stable renderer key for
 * identity across transcript refreshes and virtualized row remounts.
 */

import {
  isTaskTranscriptToolRow,
  taskDetailTranscriptToPresentation,
  taskRunTranscriptToPresentation,
  type TaskDetail,
  type TaskTranscriptMessageVM,
} from "@nautilo/types";
import {
  projectToolArgsForCardDisplay,
} from "../../../components/tool-argument-preview";

/** A single rendered row in the transcript feed / surface. */
export type TranscriptMessageVM = Omit<TaskTranscriptMessageVM, "key"> & { readonly key?: string };

/** True when a row should render as a tool card rather than a text bubble. */
export function isToolRow(message: TranscriptMessageVM): boolean {
  return isTaskTranscriptToolRow(message);
}

/**
 * Condense a transcript message to a single `line3`-style step string for the
 * L1 feed (e.g. "run_shell(bun test)" or a truncated assistant line).
 */
export function stepLineFor(message: TranscriptMessageVM, maxChars = 72): string {
  const safeArgs = projectToolArgsForCardDisplay(message.args ?? {});
  const raw = isToolRow(message)
    ? `${message.toolName}(${firstArgSummary(safeArgs)})`
    : message.content;
  return truncate(raw.replace(/\s+/g, " ").trim(), maxChars);
}

function firstArgSummary(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/**
 * Map wire transcript rows onto the local VM. Pairs assistant `toolCalls` with
 * following `tool` result rows (preferring matching `toolName`); unconsumed
 * tool rows become orphan fallbacks. Preserves chronological order.
 */
export function taskRunToVMs(messages: Parameters<typeof taskRunTranscriptToPresentation>[0]): TranscriptMessageVM[] {
  return taskRunTranscriptToPresentation(messages);
}

/** Map `GET /api/tasks/:id` detail — uses the latest run's transcript. */
export function taskDetailToVMs(detail: TaskDetail): TranscriptMessageVM[] {
  return taskDetailTranscriptToPresentation(detail);
}
