import type { TaskReadPendingPage } from "./read-projection";
import type { BaseMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { log } from "@nautilo/logger";
import { dispatchTaskCommand, type TaskDispatchContext } from "./dispatch";
import { createTaskToolSchema, type TaskToolArgs } from "./schema";
import { isClaudeCodeTasksEnabled } from "./task-tool-runtime";

interface TaskToolContext {
  ownerId: string;
  agentId: string;
  roomId: string;
  callingRoomId: string;
  currentTaskId: string;
  taskReadMaxResponseBytes?: number | undefined;
  taskReadMessages?: readonly BaseMessage[] | undefined;
  taskReadPendingPages?: readonly TaskReadPendingPage[] | undefined;
}

function contextFromUnknown(ctx: unknown): TaskToolContext {
  const c = (ctx ?? {}) as Record<string, unknown>;
  const ownerId =
    typeof c["ownerId"] === "string"
      ? c["ownerId"]
      : typeof c["userId"] === "string"
        ? c["userId"]
        : "";
  return {
    taskReadMaxResponseBytes: typeof c["taskReadMaxResponseBytes"] === "number" ? c["taskReadMaxResponseBytes"] : undefined,
    taskReadPendingPages: Array.isArray(c["taskReadPendingPages"]) ? c["taskReadPendingPages"] as TaskReadPendingPage[] : undefined,
    taskReadMessages: Array.isArray(c["taskReadMessages"]) ? c["taskReadMessages"] as BaseMessage[] : undefined,
    ownerId,
    agentId: typeof c["agentId"] === "string" ? c["agentId"] : "",
    roomId: typeof c["roomId"] === "string" ? c["roomId"] : "",
    callingRoomId:
      typeof c["callingRoomId"] === "string" ? c["callingRoomId"] : "",
    currentTaskId:
      typeof c["currentTaskId"] === "string" ? c["currentTaskId"] : "",
  };
}

const TASK_TOOL_DESCRIPTION =
  "Start, inspect, and edit background tasks (your own only). create: start a background task (full control over schedule, target chat, tools, scope) that runs on its own and reports back when done. EXECUTION: omit `harness` for Nautilo Native (the default). A Nautilo Native create receipt may deterministically report that its task is running in the background. If the user explicitly asks for Codex, use `harness: 'codex'`; it either uses Codex or returns an actionable setup/availability failure, never another executor. For an external harness create receipt, say only that the task was accepted. Do not describe an external harness task as pending or running from the create receipt alone; the authoritative task card and report-back determine whether it started and how it ended. Harness tasks run immediately in the current Room; omit routing, scheduling, scope, tool, delivery, and model-selection fields. A second Codex create is an ordinary follow-up Task: it is serialized behind active Codex work and must never steer or fork that active turn. Use `steer` with the existing taskId and a short prompt only when the user explicitly wants to redirect the currently active harness turn; never infer steering from an ordinary follow-up. Do not attempt login, account selection, permission approval, or posture changes; explain how the user can complete those in Connections when the result says Codex is unavailable. STATUS TRUTH: Before answering whether existing work is still running or waiting, use read/list for its current state. An old creation receipt or elapsed time is not current execution evidence. Awaiting means execution is parked; do not say it is still working. Task execution completed does not establish that its requested research scope was completed; preserve partial coverage and blockers from the result. read: inspect a task and its runs. Small responses remain complete. An oversized overview explicitly omits prompt/results/transcripts and returns per-run section selectors. Use readSection metadata for all run IDs, result for the full report, transcript for saved assistant/tool entries; use literal readSearch to locate findings or notes. Pages are exact UTF-8 JSON sections: use continueRead:true with the same taskId for server-managed continuation. Fields can span pages: interpret only visible content, save useful notes and select relevant sections or searches; never rebuild the whole transcript in working context or infer missing fields. Explicit readCursor remains available for exact replay. A byte page or search match is not a summary or proof of audit coverage. list: list your tasks with status. unpause: resume a paused task, or an errored research task only when current read/list reports canResumeResearch:true. This continues its saved work; the runtime revalidates eligibility and access. update: edit a pending or paused task (re-prompt, re-schedule, change tools/target). MODEL CHOICE FOR NATIVE TASKS: an omitted model or `balanced` inherits the saved Agent model setting, then the server chat default when the Agent uses Follow default. A Room model override is separate and is not inherited; pass `model_id` when this Task needs an exact model. When the user asks to prioritize privacy, cost, or smartness (e.g. 'do this privately', 'as cheaply as possible', 'use the smartest model'), pass `model_selection_profile` (or, advanced, `model_selection_spec`). The SAME `model_selection` choice is also available on the in_background / schedule / in_scope / in_private_namespace / ask_peer shortcuts. Prefer an intent shortcut when one fits (in_scope for a narrow scoped helper, in_private_namespace for a private excursion, in_background for a generic background run, schedule for reminders); reach for this low-level tool only for advanced or unusual parameter combinations a shortcut doesn't cover.";

const CLAUDE_CODE_TASK_GUIDANCE =
  " CLAUDE CODE: when the user explicitly asks for Claude Code, first call `list_harness_models` with `harness: 'claude-code'`, then create with that exact picker id. It either uses Claude Code or returns an actionable Desktop/Connections failure; it never falls back.";

export function createTaskTool(context?: unknown) {
  const taskCtx = contextFromUnknown(context);
  const claudeCodeTasksEnabled = isClaudeCodeTasksEnabled();

  return new DynamicStructuredTool({
    name: "task",
    description: claudeCodeTasksEnabled
      ? `${TASK_TOOL_DESCRIPTION}${CLAUDE_CODE_TASK_GUIDANCE}`
      : TASK_TOOL_DESCRIPTION,
    schema: createTaskToolSchema({ claudeCode: claudeCodeTasksEnabled }),
    func: async (args: TaskToolArgs) => {
      log(`[task:${args.command}]`);

      const dispatchCtx: TaskDispatchContext = {
        ownerId: taskCtx.ownerId,
        agentId: taskCtx.agentId,
        roomId: taskCtx.roomId || taskCtx.callingRoomId,
        currentTaskId: taskCtx.currentTaskId,
        taskReadMaxResponseBytes: taskCtx.taskReadMaxResponseBytes,
        taskReadMessages: taskCtx.taskReadMessages,
        taskReadPendingPages: taskCtx.taskReadPendingPages,
      };

      return dispatchTaskCommand(args, dispatchCtx);
    },
  });
}
