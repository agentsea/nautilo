import { createHash } from "node:crypto";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { getRunAgentTranscriptSnapshot, type GetRunAgentTranscriptOptions, type RunTranscriptBoundary } from "../../store/session-store";
import type { TaskToolArgs } from "./schema";
import { boundarySchema, sectionSchema, selectionSchema, pageSchema, projectOversizedTaskRead, taskReadPageFingerprint, type TaskReadData, type TaskReadPendingPage } from "./read-projection";

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cursorSchema = z.strictObject({ version: z.literal("task-read-v1"), ownerId: z.string(), taskId: z.string(),
  agentId: z.string(), runId: z.string().nullable(), graphThreadId: z.string().nullable(),
  readSection: sectionSchema, readSearch: z.string().nullable(), snapshotEnd: boundarySchema.nullable(),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative().safe() });
type ReadCursor = z.infer<typeof cursorSchema>;
function error(code: string, message: string) { return { version: "task-read-v1", kind: "error", code, message }; }
function decodeCursor(raw: string): ReadCursor | null {
  try { return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))); } catch { return null; }
}
function encodeCursor(cursor: ReadCursor): string { return Buffer.from(JSON.stringify(cursorSchema.parse(cursor))).toString("base64url"); }

export interface TaskReadRun {
  id: string; status: string; modelId: string | null; resultText: string | null; lastError: string | null;
  startedAt: Date | null; completedAt: Date | null; graphThreadId: string;
}
export interface TaskReadContext { ownerId: string; agentId: string; maxResponseBytes?: number | undefined; messages?: readonly BaseMessage[] | undefined; pendingPages?: readonly TaskReadPendingPage[] | undefined }

/** Canonical calls are consumed once. A later complete receipt ends its stream;
 * pages omitted from provider context leave a gap that must be reread first. */
function continuedSelection(args: TaskToolArgs, messages: readonly BaseMessage[], pendingPages: readonly TaskReadPendingPage[]): z.infer<typeof selectionSchema> | "complete" | null {
  const pending = new Map<string, { name: string; args: Record<string, unknown> } | null>();
  const pages: Array<{ receipt: z.infer<typeof pageSchema>; hidden: boolean }> = [];
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) if (call.id) pending.set(call.id, pending.has(call.id) ? null : call);
      continue;
    }
    if (!ToolMessage.isInstance(message)) continue;
    const call = pending.get(message.tool_call_id);
    pending.delete(message.tool_call_id);
    if (!call || call.name !== "task" || message.name !== "task" || message.status === "error"
      || message.additional_kwargs?.["nautilo_tool_status"] === "error" || typeof message.content !== "string") continue;
    let raw: unknown;
    try { raw = JSON.parse(message.content); } catch { continue; }
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) continue;
    const receipt = parsed.data;
    if (call.args["command"] !== "read" || call.args["taskId"] !== receipt.taskId || receipt.taskId !== args.taskId) continue;
    const matches = (input: Record<string, unknown>) => (input["runId"] === undefined || input["runId"] === receipt.runId)
      && (input["readSection"] === undefined || input["readSection"] === receipt.readSection)
      && (input["readSearch"] === undefined || input["readSearch"] === receipt.readSearch);
    if (!matches(call.args) || !matches(args) || call.args["readCursor"] !== undefined && call.args["readCursor"] !== receipt.resolvedSelection.readCursor) continue;
    const fingerprint = taskReadPageFingerprint(message.content);
    pages.push({ receipt, hidden: fingerprint !== null && pendingPages.some((page) => page.fingerprint === fingerprint && page.startByte < page.endByte) });
  }
  const latest = pages.at(-1)?.receipt;
  const pendingMatches = (page: TaskReadPendingPage) => page.startByte < page.endByte && page.taskId === args.taskId
    && (args.runId === undefined || args.runId === page.runId)
    && (args.readSection === undefined || args.readSection === page.readSection)
    && (args.readSearch === undefined || args.readSearch === page.readSearch);
  if (!latest) {
    const pending = pendingPages.find(pendingMatches);
    if (!pending?.resolvedSelection.readCursor) return null;
    const original = decodeCursor(pending.resolvedSelection.readCursor);
    return original ? { ...pending.resolvedSelection, readCursor: encodeCursor({ ...original, offset: pending.startByte }) } : null;
  }
  const sameStream = pages.filter(({ receipt }) => receipt.sourceVersion === latest.sourceVersion
    && receipt.taskId === latest.taskId && receipt.runId === latest.runId && receipt.readSection === latest.readSection
    && receipt.readSearch === latest.readSearch && JSON.stringify(receipt.snapshotEnd) === JSON.stringify(latest.snapshotEnd));
  const presented = sameStream.filter((page) => !page.hidden);
  // A retained later page is a continuation anchor; ordinary history eviction
  // does not make its earlier, already-presented pages unread again.
  let position = presented.at(-1)?.receipt.endByte ?? latest.startByte;
  const missingRanges = pendingPages.filter((page) => pendingMatches(page) && page.sourceVersion === latest.sourceVersion
    && page.runId === latest.runId && page.readSection === latest.readSection && page.readSearch === latest.readSearch);
  for (const missing of missingRanges) {
    let gap = missing.startByte;
    for (const { receipt } of [...presented].sort((a, b) => a.receipt.startByte - b.receipt.startByte)) {
      if (receipt.startByte > gap) break;
      if (receipt.endByte > gap) gap = receipt.endByte;
    }
    if (gap < missing.endByte) position = Math.min(position, gap);
  }
  if (position === latest.totalBytes) return "complete";
  const original = latest.resolvedSelection.readCursor ? decodeCursor(latest.resolvedSelection.readCursor) : null;
  if (!original) return null;
  return { ...latest.resolvedSelection, readCursor: encodeCursor({ ...original, offset: position }) };
}

/** Reads one section; cursor positions are selections, never access authority. */
export async function readTaskSection(args: TaskToolArgs, ctx: TaskReadContext, data: TaskReadData, runs: readonly TaskReadRun[]): Promise<string> {
  const budget = ctx.maxResponseBytes;
  if (!Number.isSafeInteger(budget) || !budget || budget < 1) return JSON.stringify(error("task_read_budget_unavailable", "The runtime must reserve caller-model response space before reading Task data."));
  let selected: TaskToolArgs = args;
  if (args.continueRead) {
    if (args.readCursor) return JSON.stringify(error("invalid_task_read", "Use continueRead or an explicit readCursor, not both."));
    const prior = continuedSelection(args, ctx.messages ?? [], ctx.pendingPages ?? []);
    if (prior === "complete") return JSON.stringify(error("task_read_complete", "The latest matching saved section has already been returned completely. Select another section/search or omit continueRead to start a fresh snapshot."));
    if (!prior) return JSON.stringify(error("task_read_continuation_unavailable", "No matching successful incomplete task.read page exists in this Task's canonical history. Select taskId, runId and readSection explicitly."));
    selected = { ...args, ...prior, continueRead: false };
  }
  const cursor = selected.readCursor ? decodeCursor(selected.readCursor) : null;
  if (selected.readCursor && !cursor) return JSON.stringify(error("task_read_cursor_invalid", "Invalid readCursor. Restart the explicit Task/run/section selection."));
  const section = selected.readSection ?? cursor?.readSection;
  if (!section && (selected.runId !== undefined || selected.readSearch !== undefined)) return JSON.stringify(error("invalid_task_read", "Select readSection before specifying runId or readSearch."));
  if (!section) return JSON.stringify(bytes(data) <= budget ? data : projectOversizedTaskRead(data, args, budget)
    ?? error("task_read_budget_unavailable", "Reserve more caller-model response space."));
  const runId = selected.runId ?? cursor?.runId ?? (section === "metadata" ? undefined : runs[0]?.id);
  const run = runId ? runs.find((candidate) => candidate.id === runId) : undefined;
  if (runId && !run || section !== "metadata" && !run) return JSON.stringify(error("task_run_not_found", "The selected run is not available for this Task."));
  if (selected.readSearch !== undefined && section !== "transcript") return JSON.stringify(error("invalid_task_read", "readSearch is literal lookup within a selected run transcript only."));
  const search = selected.readSearch ?? cursor?.readSearch ?? undefined;
  if (cursor && (cursor.ownerId !== ctx.ownerId || cursor.agentId !== ctx.agentId || cursor.taskId !== data.task.id
    || cursor.runId !== (run?.id ?? null) || cursor.graphThreadId !== (run?.graphThreadId ?? null)
    || cursor.readSection !== section || cursor.readSearch !== (search ?? null))) return JSON.stringify(error("task_read_cursor_scope_changed", "The cursor belongs to a different owner, Task, run or selection. Restart the desired selection; do not combine pages."));
  let value: unknown;
  let snapshotEnd: RunTranscriptBoundary | null = null;
  let counts = {};
  let sourceSnapshot: unknown;
  if (section === "transcript" && run) {
    const options: GetRunAgentTranscriptOptions = { ownerId: ctx.ownerId, agentId: ctx.agentId,
      graphThreadId: run.graphThreadId, startedAt: run.startedAt, completedAt: run.completedAt };
    let snapshot: Awaited<ReturnType<typeof getRunAgentTranscriptSnapshot>>;
    try { snapshot = await getRunAgentTranscriptSnapshot(options, cursor?.snapshotEnd); }
    catch { return JSON.stringify(error("task_read_unavailable", "The saved ordinary transcript could not be read. No encrypted fallback or partial source was returned. Retry this exact selection when transcript access is available.")); }
    snapshotEnd = snapshot.end;
    sourceSnapshot = snapshot.messages;
    const matched = search === undefined ? snapshot.messages : snapshot.messages.filter((message) => message.content.includes(search) || JSON.stringify(message.toolCalls).includes(search));
    // The ordinary session row does not persist ToolMessage.status. Preserve
    // that uncertainty instead of interpreting an error-looking content string.
    value = matched.map((message) => ({ ...message, ...(message.role === "tool" ? { outcome: "unknown" as const } : {}) }));
    counts = { transcriptEntries: snapshot.messages.length, matchingEntries: matched.length };
  } else if (section === "result" && run) value = { resultText: run.resultText, lastError: run.lastError };
  else value = { task: data.task, runs: data.runs.filter((entry) => !run || entry.id === run.id).map(({ transcript: _transcript, resultText: _result, ...metadata }) => metadata), ...(data.harness ? { harness: data.harness } : {}) };
  const sourceVersion = digest(sourceSnapshot ?? value);
  if (cursor && cursor.sourceVersion !== sourceVersion) return JSON.stringify(error("task_read_source_changed", "Previously selected Task data changed. Restart this section and do not combine old and new pages. Later appended transcript rows do not change the frozen snapshot."));
  const content = Buffer.from(JSON.stringify(value), "utf8");
  const startByte = cursor?.offset ?? 0;
  if (startByte >= content.length || startByte > 0 && (content[startByte]! & 0xc0) === 0x80) return JSON.stringify(error("task_read_cursor_range_invalid", "Cursor does not select a valid UTF-8 position. Restart this section."));
  const binding: ReadCursor = { version: "task-read-v1", ownerId: ctx.ownerId, agentId: ctx.agentId, taskId: data.task.id,
    runId: run?.id ?? null, graphThreadId: run?.graphThreadId ?? null, readSection: section, readSearch: search ?? null,
    snapshotEnd, sourceVersion, offset: startByte };
  const resolvedSelection = { command: "read" as const, taskId: data.task.id, ...(run ? { runId: run.id } : {}), readSection: section,
    ...(search !== undefined ? { readSearch: search } : {}), readCursor: selected.readCursor ?? encodeCursor(binding) };
  const envelope = (end: number) => ({ version: "task-read-v1", kind: "page", taskId: data.task.id, runId: run?.id ?? null,
    readSection: section, ...(search !== undefined ? { readSearch: search } : {}), sourceVersion, snapshotEnd,
    startByte, endByte: end, totalBytes: content.length, text: content.subarray(startByte, end).toString("utf8"),
    complete: end === content.length, nextCursor: end === content.length ? null : encodeCursor({ ...binding, offset: end }),
    resolvedSelection, ...counts,
    interpretation: search === undefined ? "Exact UTF-8 fragment of saved Task JSON; fields may cross page boundaries. Interpret only visible content and never infer missing fields. Use continueRead, save useful notes, and select relevant sections or literal searches; do not rebuild the whole transcript in working context. Retrieval does not certify research coverage."
      : "Literal matching transcript entries only, in exact UTF-8 JSON fragments that may split fields. Interpret visible content only, use continueRead and save useful notes; do not infer missing fields or rebuild the whole transcript in working context. This lookup is not a summary or proof that unmatched code or messages were reviewed.",
  });
  if (bytes(envelope(content.length)) <= budget) return JSON.stringify(envelope(content.length));
  const align = (end: number) => { while (end > startByte && end < content.length && (content[end]! & 0xc0) === 0x80) end--; return end; };
  let low = startByte, high = Math.min(content.length - 1, startByte + budget);
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (bytes(envelope(align(mid))) <= budget) low = mid; else high = mid - 1; }
  const end = align(low);
  if (end <= startByte) return JSON.stringify(error("task_read_budget_unavailable", "The selected page framing and one UTF-8 character do not fit the caller workspace. Reserve more response space; the section remains available."));
  return JSON.stringify(envelope(end));
}
