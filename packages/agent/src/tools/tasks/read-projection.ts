import { createHash } from "node:crypto";
import { z } from "zod";
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
export const boundarySchema = z.strictObject({ createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))), id: z.number().int().positive().safe() });
export const sectionSchema = z.enum(["metadata", "result", "transcript"]);
export const selectionSchema = z.strictObject({ command: z.literal("read"), taskId: z.string(), runId: z.string().optional(),
  readSection: sectionSchema, readSearch: z.string().optional(), readCursor: z.string().optional() });
export const pageSchema = z.strictObject({ version: z.literal("task-read-v1"), kind: z.literal("page"),
  taskId: z.string(), runId: z.string().nullable(), readSection: sectionSchema, readSearch: z.string().optional(),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), snapshotEnd: boundarySchema.nullable(),
  startByte: z.number().int().nonnegative().safe(), endByte: z.number().int().nonnegative().safe(), totalBytes: z.number().int().nonnegative().safe(),
  text: z.string(), complete: z.boolean(), nextCursor: z.string().nullable(), resolvedSelection: selectionSchema,
  transcriptEntries: z.number().int().nonnegative().optional(), matchingEntries: z.number().int().nonnegative().optional(),
  interpretation: z.string(),
}).refine((page) => page.endByte > page.startByte && page.endByte <= page.totalBytes
  && Buffer.byteLength(page.text, "utf8") === page.endByte - page.startByte
  && page.complete === (page.endByte === page.totalBytes) && page.complete === (page.nextCursor === null)
  && page.resolvedSelection.taskId === page.taskId && (page.resolvedSelection.runId ?? null) === page.runId
  && page.resolvedSelection.readSection === page.readSection && page.resolvedSelection.readSearch === page.readSearch);
/** Compact omitted-page range. startByte === endByte acknowledges that smaller
 * presented pieces covered the page while its original fingerprint is retained. */
export interface TaskReadPendingPage {
  fingerprint: string;
  taskId: string;
  runId: string | null;
  readSection: z.infer<typeof sectionSchema>;
  readSearch?: string | undefined;
  sourceVersion: string;
  startByte: number;
  endByte: number;
  resolvedSelection: z.infer<typeof selectionSchema>;
}
export function taskReadPageFingerprint(content: string): string | null {
  try { const parsed = pageSchema.safeParse(JSON.parse(content)); return parsed.success
    ? createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex") : null; } catch { return null; }
}
const taskReadErrorReceiptSchema = z.strictObject({ version: z.literal("task-read-v1"), kind: z.literal("error"),
  code: z.enum(["task_read_budget_unavailable", "invalid_task_read", "task_read_continuation_unavailable", "task_read_complete",
    "task_read_cursor_invalid", "task_read_unavailable", "task_run_not_found", "task_read_cursor_scope_changed", "task_read_source_changed", "task_read_cursor_range_invalid"]),
  message: z.string(),
});
export function isTaskReadErrorReceipt(value: unknown): boolean { return taskReadErrorReceiptSchema.safeParse(value).success; }
export function isTaskReadPageReceipt(value: unknown): boolean { return pageSchema.safeParse(value).success; }

function error(code: string, message: string) { return { version: "task-read-v1", kind: "error", code, message }; }
export interface TaskReadData { task: Record<string, unknown> & { id: string; status: string }; runs: Array<Record<string, unknown> & { id: string }>; harness?: unknown }

/** Compact lifecycle facts, with exact retrieval selectors instead of source excerpts. */
export function projectOversizedTaskRead(value: unknown, pairedArgs: Record<string, unknown>, maxBytes: number): Record<string, unknown> | null {
  if (pairedArgs["command"] !== "read" || typeof pairedArgs["taskId"] !== "string") return null;
  const unavailable = () => {
    const result = error("task_read_budget_unavailable", "No Task source text is presented. Reserve more caller workspace and repeat the same task.read selection.");
    if (bytes(result) <= maxBytes) return result;
    const minimal = { error: "task_read_budget_unavailable" };
    return bytes(minimal) <= maxBytes ? minimal : null;
  };
  const reread = () => {
    const selection = selectionSchema.safeParse({ command: "read", taskId: pairedArgs["taskId"], runId: pairedArgs["runId"], readSection: pairedArgs["readSection"] ?? "metadata", readSearch: pairedArgs["readSearch"], readCursor: pairedArgs["readCursor"] });
    const result = { version: "task-read-v1", kind: "reread", taskId: pairedArgs["taskId"],
      read: selection.success ? selection.data : { command: "read", taskId: pairedArgs["taskId"], readSection: "metadata" },
      disclosure: "The prior task.read body is unavailable or does not fit this workspace. No body excerpt is presented. Read metadata to recover run IDs, then the selected result/transcript section; use continueRead for server-managed continuation." };
    return bytes(result) <= maxBytes ? result : unavailable();
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return reread();
  const page = pageSchema.safeParse(value);
  if (page.success) {
    if (pairedArgs["taskId"] !== page.data.taskId
      || pairedArgs["runId"] !== undefined && pairedArgs["runId"] !== page.data.runId
      || pairedArgs["readSection"] !== undefined && pairedArgs["readSection"] !== page.data.readSection
      || pairedArgs["readSearch"] !== undefined && pairedArgs["readSearch"] !== page.data.readSearch
      || pairedArgs["readCursor"] !== undefined && pairedArgs["readCursor"] !== page.data.resolvedSelection.readCursor) return reread();
    const replay = { version: "task-read-v1", kind: "replay", taskId: page.data.taskId,
      omittedBytes: page.data.endByte - page.data.startByte, read: page.data.resolvedSelection,
      disclosure: "This exact page no longer fits the current caller workspace. Its text is omitted here; repeat the returned read selection with the newly available response budget. Do not skip to its nextCursor." };
    return bytes(replay) <= maxBytes ? replay : unavailable();
  }
  const data = value as Partial<TaskReadData>;
  if (!data.task || typeof data.task.id !== "string" || !Array.isArray(data.runs)
    || pairedArgs["taskId"] !== data.task.id) return reread();
  const run = data.runs[0];
  const result = { version: "task-read-v1", kind: "overview", task: { id: data.task.id, status: data.task.status,
    preparation: data.task["preparation"] ?? null,
    ...(data.task["canResumeResearch"] === true ? { canResumeResearch: true } : {}) },
    latestRun: run ? { id: run.id, status: run["status"], modelId: run["modelId"] } : null,
    omitted: { promptBytes: Buffer.byteLength(typeof data.task["prompt"] === "string" ? data.task["prompt"] : "", "utf8"),
      runs: data.runs.length, transcriptEntries: data.runs.reduce((count, entry) => count + (Array.isArray(entry["transcript"]) ? entry["transcript"].length : 0), 0),
      resultBytes: data.runs.reduce((count, entry) => count + Buffer.byteLength(typeof entry["resultText"] === "string" ? entry["resultText"] : "", "utf8"), 0),
    },
    read: { metadata: { command: "read", taskId: data.task.id, readSection: "metadata" },
      ...(run ? { result: { command: "read", taskId: data.task.id, runId: run.id, readSection: "result" },
        transcript: { command: "read", taskId: data.task.id, runId: run.id, readSection: "transcript" } } : {}) },
    disclosure: "Prompt, run details, results and transcripts are omitted from this overview. Read metadata for all run IDs, then select a run's result or transcript. Use continueRead for server-managed continuation; readSearch is literal transcript lookup, not audit coverage.",
  };
  if (bytes(result) <= maxBytes) return result;
  const minimal = error("task_read_budget_unavailable", "Task overview does not fit the caller workspace. Reserve more response space; no source content was returned.");
  return bytes(minimal) <= maxBytes ? minimal : unavailable();
}
