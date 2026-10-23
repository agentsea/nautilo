import { DynamicStructuredTool } from "@langchain/core/tools";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { getTaskById, getTaskRuns } from "@nautilo/db";
import { readCurrentOrdinaryTranscriptExposureRows, readExecutionToolResult, getRunAgentTranscriptSnapshot } from "../../store/session-store";
import { getTaskToolRuntime } from "../tasks/task-tool-runtime";
import { readResultWindow, resultReadSchema, resultVersion, type ResultReference } from "./result-window";

export interface ResultReaderContext {
  userId: string;
  agentId: string;
  roomId: string;
  resultReaderThreadId: string;
  taskReadMessages?: readonly BaseMessage[];
  taskReadMaxResponseBytes?: number;
  fullEncryptionOnly?: boolean;
}

export async function resolveRetainedResult(reference: ResultReference, ctx: ResultReaderContext): Promise<string> {
  if (ctx.fullEncryptionOnly || !ctx.userId || !ctx.agentId) throw new Error("Result is unavailable under current content authority");
  let content: string | undefined;
  if (reference.kind === "call") {
    const matches = (ctx.taskReadMessages ?? []).filter((message) => ToolMessage.isInstance(message)
      && message.tool_call_id === reference.callId && typeof message.content === "string");
    if (matches.length === 1) content = matches[0]!.content as string;
    else if (matches.length === 0) content = (await readExecutionToolResult({ ownerId: ctx.userId,
      agentId: ctx.agentId, graphThreadId: ctx.resultReaderThreadId, callId: reference.callId }))?.content;
  } else if (reference.kind === "room") {
    if (!ctx.roomId || reference.roomId !== ctx.roomId) throw new Error("Result belongs to another Room");
    const rows = await readCurrentOrdinaryTranscriptExposureRows({ ownerId: ctx.userId, agentId: ctx.agentId,
      roomIds: [ctx.roomId], messageIds: [reference.messageId] });
    if (rows.length === 1 && rows[0]!.role === "tool") content = rows[0]!.content;
  } else {
    const rt = getTaskToolRuntime();
    const task = await getTaskById(rt.db, reference.taskId);
    if (!task || task.ownerId !== ctx.userId || task.contentRepresentation === "protected"
      || task.contentRepresentation === "dual" || rt.canUseLegacyTaskContent && !await rt.canUseLegacyTaskContent()) {
      throw new Error("Task result is unavailable under current content authority");
    }
    const run = (await getTaskRuns(rt.db, task.id)).find((candidate) => candidate.id === reference.runId);
    if (!run) throw new Error("Task run is unavailable");
    const snapshot = await getRunAgentTranscriptSnapshot({ ownerId: ctx.userId, agentId: task.agentId,
      graphThreadId: run.graphThreadId, startedAt: run.startedAt, completedAt: run.completedAt });
    content = snapshot.messages.find((message) => message.id === reference.messageId && message.role === "tool")?.content;
  }
  if (content === undefined) throw new Error("Retained result is unavailable; do not rerun the original operation to recover output");
  if (resultVersion(content) !== reference.sourceVersion) throw new Error("Retained result changed; obtain its current reference");
  return content;
}

export function createReadToolResult(context?: unknown) {
  const ctx = context as ResultReaderContext;
  return new DynamicStructuredTool({
    name: "read_tool_result",
    description: "Inspect, read or literally search a retained tool result using its exact receipt reference. Never executes the original operation. Inspect lists JSON fields or array sizes; path selects exact JSON keys/indices. Read uses lossless UTF-8 pages; search returns match locations and nearby text. Continue with nextCursor and the same selection, or read at a match's startByte. Pages can split records; do not infer unseen content or claim complete analysis from a search/preview. Binary documents remain in their original artifact viewer.",
    schema: resultReadSchema,
    func: async (args) => {
      try {
        if (!ctx || !ctx.taskReadMaxResponseBytes) throw new Error("No response budget is available");
        return readResultWindow(await resolveRetainedResult(args.reference, ctx), args, ctx.taskReadMaxResponseBytes);
      } catch (error) {
        return JSON.stringify({ version: "tool-result-v1", kind: "error", message: error instanceof Error ? error.message : "Result read failed" });
      }
    },
  });
}
