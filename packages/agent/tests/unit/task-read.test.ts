import { z } from "zod";
import { afterEach, expect, spyOn, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import * as store from "../../src/store/session-store";
import { readTaskSection, type TaskReadRun } from "../../src/tools/tasks/read";
import { isTaskReadPageReceipt, pageSchema, projectOversizedTaskRead, taskReadPageFingerprint } from "../../src/tools/tasks/read-projection";
import { dispatchTaskCommand } from "../../src/tools/tasks/dispatch";
import { setTaskToolRuntime } from "../../src/tools/tasks/task-tool-runtime";
import * as db from "@nautilo/db";

const json = (text: string): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(JSON.parse(text));
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); setTaskToolRuntime(null); });
const run: TaskReadRun = { id: "run", graphThreadId: "subagent:child", status: "completed", modelId: "openai:test",
  resultText: 'Detailed finding: record_final_501. "Quoted" recovery evidence 😀\n'.repeat(200), lastError: null,
  startedAt: new Date("2026-09-07T12:00:00Z"), completedAt: new Date("2026-09-07T13:00:00Z") };
const ctx = { ownerId: "owner", agentId: "task-agent", maxResponseBytes: 2400 };
const data = { task: { id: "task", status: "completed", prompt: "Audit carefully" }, runs: [{ ...run, transcript: [] }] };
const args = { command: "read" as const, taskId: "task", runId: "run", readSection: "result" as const };

async function readAll(selection: Parameters<typeof readTaskSection>[0], context = ctx) {
  let next = selection;
  let text = "";
  const receipts: Array<ReturnType<typeof pageSchema.parse>> = [];
  let complete = false;
  do {
    const raw = await readTaskSection(next, context, data, [run]);
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(context.maxResponseBytes);
    const page = pageSchema.parse(JSON.parse(raw));
    expect(isTaskReadPageReceipt(page)).toBe(true);
    expect(page.startByte).toBe(Buffer.byteLength(text, "utf8"));
    text += page.text;
    receipts.push(page);
    complete = page.complete;
    if (page.nextCursor) next = { ...selection, readCursor: page.nextCursor };
  } while (!complete);
  return { text, receipts };
}

test("escaped report pages reconstruct every UTF-8 byte inside the actual whole-receipt allowance", async () => {
  const { text, receipts } = await readAll(args);
  expect(receipts.length).toBeGreaterThan(1);
  expect(JSON.parse(text)).toEqual({ resultText: run.resultText, lastError: null });
  expect(text).toContain("record_final_501");
  expect(text).not.toContain("�");
  const shrink = projectOversizedTaskRead(receipts[1], receipts[1]!.resolvedSelection, 2300)!;
  expect(shrink["kind"]).toBe("replay");
  expect(shrink["read"]).toEqual(receipts[1]!.resolvedSelection);
  expect(shrink["read"]).not.toEqual({ ...receipts[1]!.resolvedSelection, readCursor: receipts[1]!.nextCursor });
});

test("small full responses remain intact; oversized defaults disclose omitted data and exact selectors", async () => {
  const compact = json(await readTaskSection({ command: "read", taskId: "task" }, ctx, data, [run]));
  expect(compact["kind"]).toBe("overview");
  expect((compact["read"] as Record<string, unknown>)["result"]).toEqual(args);
  expect((compact["omitted"] as Record<string, unknown>)["resultBytes"]).toBe(Buffer.byteLength(run.resultText!, "utf8"));
  expect(JSON.stringify(compact)).not.toContain("record_final_501");
  const small = { ...data, runs: [] };
  expect(json(await readTaskSection({ command: "read", taskId: "task" }, ctx, small, []))).toEqual(small);
  const metadata = await readAll({ command: "read", taskId: "task", readSection: "metadata" });
  const metadataValue = JSON.parse(metadata.text) as { task: { prompt: string }; runs: Array<{ id: string; resultText?: string }> };
  expect(metadataValue.task.prompt).toBe(data.task.prompt);
  expect(metadataValue.runs[0]?.id).toBe(run.id);
  expect(metadataValue.runs[0]?.resultText).toBeUndefined();
});

test("continuation requires a paired canonical successful receipt and preserves its exact run selection", async () => {
  const first = pageSchema.parse(json(await readTaskSection(args, ctx, data, [run])));
  const call = new AIMessage({ content: "", tool_calls: [{ id: "read-one", name: "task", args }] });
  const receipt = new ToolMessage({ content: JSON.stringify(first), tool_call_id: "read-one", name: "task", status: "success" });
  const next = pageSchema.parse(json(await readTaskSection({ command: "read", taskId: "task", continueRead: true }, { ...ctx, messages: [call, receipt] }, data, [run])));
  expect(next.startByte).toBe(first.endByte);
  expect(next.runId).toBe(first.runId);
  expect(next.resolvedSelection.readCursor).toBe(first.nextCursor!);
  for (const messages of [[receipt], [call, new ToolMessage({ content: JSON.stringify(first), tool_call_id: "read-one", name: "task", status: "error" })],
    [new AIMessage({ content: JSON.stringify(first) })],
    [new AIMessage({ content: "", tool_calls: [{ id: "read-one", name: "task", args: { ...args, readSection: "transcript" } }] }), receipt]]) {
    const denied = json(await readTaskSection({ command: "read", taskId: "task", continueRead: true }, { ...ctx, messages }, data, [run]));
    expect(denied["code"]).toBe("task_read_continuation_unavailable");
  }
});

test("changed report bytes and changed owner/run/query reject a prior cursor", async () => {
  const first = pageSchema.parse(json(await readTaskSection(args, ctx, data, [run])));
  const selected = { ...args, readCursor: first.nextCursor! };
  expect(json(await readTaskSection(selected, ctx, data, [{ ...run, resultText: "changed" }]))["code"]).toBe("task_read_source_changed");
  expect(json(await readTaskSection(selected, { ...ctx, ownerId: "other" }, data, [run]))["code"]).toBe("task_read_cursor_scope_changed");
  expect(json(await readTaskSection({ ...selected, runId: "other-run" }, ctx, data, [run]))["code"]).toBe("task_run_not_found");
  expect(json(await readTaskSection({ ...selected, readSection: "transcript" }, ctx, data, [run]))["code"]).toBe("task_read_cursor_scope_changed");
  expect(json(await readTaskSection({ ...args, readCursor: "not-a-cursor" }, ctx, data, [run]))["code"]).toBe("task_read_cursor_invalid");
});

test("literal transcript lookup reaches a finding after row500, freezes append boundary and detects edited saved rows", async () => {
  const rows = Array.from({ length: 503 }, (_, index) => ({ id: index + 1, role: "tool", content: index === 501 ? 'finding record_final_501: "permission after revocation" 😀'.repeat(200) : `status ${index}`,
    toolName: "security_scan", toolCalls: null, createdAt: new Date("2026-09-07T12:10:00Z") }));
  const frozen = { createdAt: "2026-09-07 12:10:00+00", id: 503 };
  const spy = spyOn(store, "getRunAgentTranscriptSnapshot").mockImplementation(async (_opts, end) => ({
    end: end ?? frozen, messages: rows.filter((row) => row.id <= (end?.id ?? frozen.id)),
  }));
  restores.push(() => spy.mockRestore());
  const selection = { ...args, readSection: "transcript" as const, readSearch: "record_final_501" };
  const first = pageSchema.parse(json(await readTaskSection(selection, ctx, data, [run])));
  expect(first.transcriptEntries).toBe(503);
  expect(first.matchingEntries).toBe(1);
  expect(first.interpretation).toContain("not a summary");
  const quoted = pageSchema.parse(json(await readTaskSection({ ...selection, readSearch: '"permission after revocation" 😀' }, ctx, data, [run])));
  expect(quoted.matchingEntries).toBe(1);
  rows.push({ ...rows[0]!, id: 504, content: "later finding appended" });
  const restored = await readAll(selection);
  expect(JSON.parse(restored.text)).toEqual(JSON.parse(JSON.stringify([{ ...rows[501], outcome: "unknown" }])));
  const next = pageSchema.parse(json(await readTaskSection({ ...selection, readCursor: first.nextCursor! }, ctx, data, [run])));
  expect(next.snapshotEnd).toEqual(frozen);
  rows[0]!.content = "edited existing nonmatching row";
  expect(json(await readTaskSection({ ...selection, readCursor: first.nextCursor! }, ctx, data, [run]))["code"]).toBe("task_read_source_changed");
  expect(json(await readTaskSection({ ...selection, readSearch: "different", readCursor: first.nextCursor! }, ctx, data, [run]))["code"]).toBe("task_read_cursor_scope_changed");
});

test("owner and selected-run checks happen before transcript access and use the Task's agent RLS", async () => {
  setTaskToolRuntime({ db: {} as never, createTask: async () => ({ taskId: "task", status: "pending" }), computeNextFireAt: () => new Date(),
    pauseTask: async () => ({ ok: true, status: "paused", message: "" }), unpauseTask: async () => ({ ok: true, status: "pending", message: "" }), stopTask: async () => ({ ok: true, status: "cancelled", message: "" }) });
  const task = spyOn(db, "getTaskById").mockResolvedValue({ ...data.task, ownerId: "owner", agentId: "task-agent" } as never);
  const runs = spyOn(db, "getTaskRuns").mockResolvedValue([run] as never);
  const transcript = spyOn(store, "getRunAgentTranscriptSnapshot").mockResolvedValue({ end: null, messages: [] });
  const full = spyOn(store, "getRunAgentTranscript").mockRejectedValue(new Error("must not load all transcripts for an explicit selection"));
  restores.push(() => { task.mockRestore(); runs.mockRestore(); transcript.mockRestore(); full.mockRestore(); });
  const dispatchCtx = { ownerId: "owner", agentId: "caller-agent", roomId: "room", taskReadMaxResponseBytes: 2400 };
  await dispatchTaskCommand({ ...args, readSection: "metadata" }, dispatchCtx);
  await dispatchTaskCommand({ ...args, readSection: "result" }, dispatchCtx);
  expect(transcript).not.toHaveBeenCalled();
  expect(full).not.toHaveBeenCalled();
  await dispatchTaskCommand({ ...args, readSection: "transcript" }, dispatchCtx);
  expect(transcript).toHaveBeenCalledTimes(1);
  expect(transcript.mock.calls[0]![0].agentId).toBe("task-agent");
  expect(full).not.toHaveBeenCalled();
  transcript.mockClear();
  expect(json(await dispatchTaskCommand({ ...args, readSection: "transcript", runId: "foreign" }, dispatchCtx))["code"]).toBe("task_run_not_found");
  expect(transcript).not.toHaveBeenCalled();
  expect(await dispatchTaskCommand({ ...args, readSection: "transcript" }, { ...dispatchCtx, ownerId: "other" })).toBe("Task not found.");
  expect(transcript).not.toHaveBeenCalled();
});

test("already truncated legacy read data gets valid reread instructions and inconsistent pages cannot redirect recovery", async () => {
  const projected = projectOversizedTaskRead('{"runs":[ [middle omitted]', args, 2400)!;
  expect(projected["kind"]).toBe("reread");
  expect(projected["read"]).toEqual(args);
  const page = pageSchema.parse(json(await readTaskSection(args, ctx, data, [run])));
  const forged = { ...page, resolvedSelection: { ...page.resolvedSelection, taskId: "foreign" } };
  expect(isTaskReadPageReceipt(forged)).toBe(false);
  const safe = projectOversizedTaskRead(forged, args, 2400)!;
  expect(JSON.stringify(safe)).not.toContain("foreign");
});


test("continueRead stops at the latest complete receipt and never replays an older partial page", async () => {
  const first = pageSchema.parse(json(await readTaskSection(args, ctx, data, [run])));
  const complete = pageSchema.parse(json(await readTaskSection(args, { ...ctx, maxResponseBytes: 100_000 }, data, [run])));
  const messages = [new AIMessage({ content: "", tool_calls: [{ id: "a", name: "task", args }] }),
    new ToolMessage({ content: JSON.stringify(first), tool_call_id: "a", name: "task" }),
    new AIMessage({ content: "", tool_calls: [{ id: "b", name: "task", args }] }),
    new ToolMessage({ content: JSON.stringify(complete), tool_call_id: "b", name: "task" })];
  const next = json(await readTaskSection({ command: "read", taskId: "task", continueRead: true }, { ...ctx, messages }, data, [run]));
  expect(next["code"]).toBe("task_read_complete");
});

test("unpresented canonical pages leave a gap that smaller visible pieces recover without skipping bytes", async () => {
  const firstRaw = await readTaskSection(args, ctx, data, [run]);
  const first = pageSchema.parse(JSON.parse(firstRaw));
  const messages = [new AIMessage({ content: "", tool_calls: [{ id: "big", name: "task", args }] }),
    new ToolMessage({ content: firstRaw, tool_call_id: "big", name: "task" })];
  const context = { ...ctx, maxResponseBytes: 2100, messages, pendingPages: [{ fingerprint: taskReadPageFingerprint(firstRaw)!, taskId: first.taskId, runId: first.runId, readSection: first.readSection, sourceVersion: first.sourceVersion, startByte: first.startByte, endByte: first.endByte, resolvedSelection: first.resolvedSelection }] };
  const selection = { command: "read" as const, taskId: "task", continueRead: true };
  const replayRaw = await readTaskSection(selection, context, data, [run]);
  const replay = pageSchema.parse(JSON.parse(replayRaw));
  expect(replay.startByte).toBe(0);
  expect(replay.endByte).toBeLessThan(first.endByte);
  expect(replay.sourceVersion).toBe(first.sourceVersion);
  messages.push(new AIMessage({ content: "", tool_calls: [{ id: "small", name: "task", args: selection }] }),
    new ToolMessage({ content: replayRaw, tool_call_id: "small", name: "task" }));
  const next = pageSchema.parse(json(await readTaskSection(selection, context, data, [run])));
  expect(next.startByte).toBe(replay.endByte);
  expect(next.startByte).toBeLessThan(first.endByte);
  expect(taskReadPageFingerprint(JSON.stringify(JSON.parse(firstRaw), null, 2))).toBe(taskReadPageFingerprint(firstRaw));
});

test("ambiguous pending call IDs and repeated consumed tool messages cannot manufacture continuation progress", async () => {
  const firstRaw = await readTaskSection(args, ctx, data, [run]);
  const first = pageSchema.parse(JSON.parse(firstRaw));
  const secondRaw = await readTaskSection({ ...args, readCursor: first.nextCursor! }, ctx, data, [run]);
  const call = new AIMessage({ content: "", tool_calls: [{ id: "duplicate", name: "task", args }] });
  const receipt = new ToolMessage({ content: firstRaw, tool_call_id: "duplicate", name: "task" });
  const selection = { command: "read" as const, taskId: "task", continueRead: true };
  expect(json(await readTaskSection(selection, { ...ctx, messages: [call, call, receipt] }, data, [run]))["code"]).toBe("task_read_continuation_unavailable");
  const next = pageSchema.parse(json(await readTaskSection(selection, { ...ctx, messages: [call, receipt,
    new ToolMessage({ content: secondRaw, tool_call_id: "duplicate", name: "task" })] }, data, [run])));
  expect(next.startByte).toBe(first.endByte);
});


test("a retained later or intentionally selected mid-section page continues from its own end", async () => {
  const first = pageSchema.parse(json(await readTaskSection(args, ctx, data, [run])));
  const selection = { ...args, readCursor: first.nextCursor! };
  const secondRaw = await readTaskSection(selection, ctx, data, [run]);
  const second = pageSchema.parse(json(secondRaw));
  const messages = [new AIMessage({ content: "", tool_calls: [{ id: "later", name: "task", args: selection }] }),
    new ToolMessage({ content: secondRaw, tool_call_id: "later", name: "task" })];
  const continued = pageSchema.parse(json(await readTaskSection({ command: "read", taskId: "task", continueRead: true }, { ...ctx, messages }, data, [run])));
  expect(continued.startByte).toBe(second.endByte);
  expect(continued.startByte).toBeGreaterThan(0);
});


test("durable pending ranges resume after the original receipt leaves history and empty ranges acknowledge recovery", async () => {
  const firstRaw = await readTaskSection(args, ctx, data, [run]);
  const first = pageSchema.parse(json(firstRaw));
  const pending = { fingerprint: taskReadPageFingerprint(firstRaw)!, taskId: first.taskId, runId: first.runId,
    readSection: first.readSection, sourceVersion: first.sourceVersion, startByte: first.startByte, endByte: first.endByte,
    resolvedSelection: first.resolvedSelection };
  const resumed = pageSchema.parse(json(await readTaskSection({ command: "read", taskId: "task", continueRead: true },
    { ...ctx, messages: [], pendingPages: [pending] }, data, [run])));
  expect(resumed.startByte).toBe(0);
  expect(resumed.sourceVersion).toBe(first.sourceVersion);
  const messages = [new AIMessage({ content: "", tool_calls: [{ id: "old", name: "task", args }] }),
    new ToolMessage({ content: firstRaw, tool_call_id: "old", name: "task" })];
  const continued = pageSchema.parse(json(await readTaskSection({ command: "read", taskId: "task", continueRead: true },
    { ...ctx, messages, pendingPages: [{ ...pending, startByte: pending.endByte }] }, data, [run])));
  expect(continued.startByte).toBe(first.endByte);
});


test("unavailable ordinary transcript fails explicitly without exposing raw store errors or falling back", async () => {
  const source = spyOn(store, "getRunAgentTranscriptSnapshot").mockRejectedValue(new Error("private database diagnostic"));
  restores.push(() => source.mockRestore());
  const raw = await readTaskSection({ ...args, readSection: "transcript" }, ctx, data, [run]);
  expect(json(raw)["code"]).toBe("task_read_unavailable");
  expect(raw).not.toContain("private database diagnostic");
});


test("oversized Task overview preserves a server-confirmed Resume affordance", () => {
  const value = { task: { id: "recoverable-task", status: "errored", canResumeResearch: true,
    prompt: "saved research ".repeat(500) }, runs: [] };
  const args = { command: "read", taskId: value.task.id };
  const projected = projectOversizedTaskRead(value, args, 2400);
  expect(projected?.["task"]).toMatchObject({ id: value.task.id, status: "errored", canResumeResearch: true });
  const unavailable = projectOversizedTaskRead({ ...value, task: { ...value.task, canResumeResearch: "true" } }, args, 2400);
  expect(unavailable?.["task"]).not.toHaveProperty("canResumeResearch");
});
