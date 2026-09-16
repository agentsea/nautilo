import { DynamicStructuredTool } from "@langchain/core/tools";
import { log } from "@nautilo/logger";
import { z } from "zod";
import { CronExpressionParser } from "cron-parser";
import {
  getTaskToolRuntime,
  type TaskToolCreateInput,
} from "../task-tool-runtime";
import {
  shortcutContextFromUnknown,
  modelSelectionParam,
  modelIdParam,
  type ShortcutContext,
} from "./shortcut-context";
import { validateTaskModelSelectionForCreate } from "../selection-validation";

/**
 * M145 (spec §7) — `schedule` shortcut. A thin `TaskCreateInput` builder that
 * authors a one-shot (concrete offset-qualified ISO datetime) or recurring
 * (raw 5-field cron) task on the existing M142 engine. No execution, no
 * scheduler, no recurrence compiler — validation + a `createTask()` call only.
 */
const scheduleSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe(
      "What to do / the reminder text, phrased as an instruction (e.g. 'Remind me to drink water', 'Summarize today's unread email'). This becomes the task brief the agent acts on when it fires.",
    ),
  when: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("once"),
        at: z
          .string()
          .describe(
            "Concrete ISO-8601 datetime WITH an explicit UTC offset or 'Z' for a one-off run (e.g. '2026-06-09T14:30:00-07:00' or '2026-06-09T21:30:00Z'). Must be in the future. Use the current time AND UTC offset from your '## Current time' context to compute it — do NOT emit a bare local datetime, it is ambiguous.",
          ),
      }),
      z.object({
        kind: z.literal("recurring"),
        cron: z
          .string()
          .describe(
            "A standard 5-field cron expression for a recurring run, interpreted in the user's timezone (e.g. '0 9 * * 1-5' = every weekday at 09:00). Author it concretely; do not use natural language.",
          ),
      }),
    ])
    .describe("One-off (once) or recurring (cron) schedule."),
  model_selection: modelSelectionParam,
  model_id: modelIdParam,
});

type ScheduleArgs = z.infer<typeof scheduleSchema>;

const SCHEDULE_DESCRIPTION =
  "Schedule a one-off or recurring task / reminder at a concrete time. Use `once` with an ISO-8601 datetime for a single run, or `recurring` with a 5-field cron expression (interpreted in the user's timezone) for repeats. Compute concrete values from your '## Current time' context — do not pass natural language. Runs asynchronously and reports back to this chat when it fires; after calling this, confirm to the user exactly what you scheduled and when.";

/** Matches a trailing UTC offset or 'Z' on an ISO-8601 string. */
const HAS_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/;

export function createScheduleTool(context?: unknown) {
  const ctx: ShortcutContext = shortcutContextFromUnknown(context);

  return new DynamicStructuredTool({
    name: "schedule",
    description: SCHEDULE_DESCRIPTION,
    schema: scheduleSchema,
    func: async (args: ScheduleArgs) => {
      log(`[schedule]`);
      if (!ctx.ownerId || !ctx.agentId) {
        return "Cannot schedule task: missing owner or agent context.";
      }
      const selectionError = validateTaskModelSelectionForCreate({
        requestedModelId: args.model_id,
        profile: args.model_selection,
        // schedule runs with the full tool set (auto).
        toolsMode: "auto",
      });
      if (selectionError) return selectionError;
      const timezone = ctx.timezone || "UTC";

      let scheduleKind: "one_shot" | "cron";
      let runAt: Date | undefined;
      let cron: string | undefined;

      if (args.when.kind === "once") {
        const at = args.when.at;
        if (!HAS_OFFSET.test(at)) {
          return "That time is missing a UTC offset. Include the explicit offset (or 'Z') from your '## Current time' context — a bare local datetime is ambiguous (e.g. '2026-06-09T14:30:00-07:00').";
        }
        const d = new Date(at);
        if (Number.isNaN(d.getTime())) {
          return "That datetime is invalid. Supply a valid offset-qualified ISO-8601 time (e.g. '2026-06-09T14:30:00-07:00').";
        }
        if (d.getTime() <= Date.now()) {
          return "That time is in the past — supply a future time (the current time is in your '## Current time' context).";
        }
        scheduleKind = "one_shot";
        runAt = d;
      } else {
        try {
          CronExpressionParser.parse(args.when.cron, {
            currentDate: new Date(),
            tz: timezone,
          });
        } catch {
          return "That cron expression is invalid. Supply a standard 5-field cron string (e.g. '0 9 * * 1-5').";
        }
        scheduleKind = "cron";
        cron = args.when.cron;
      }

      const rt = getTaskToolRuntime();
      const input: TaskToolCreateInput = {
        ownerId: ctx.ownerId,
        requestorId: ctx.ownerId,
        agentId: ctx.agentId,
        prompt: args.message,
        preset: "schedule",
        scheduleKind,
        ...(runAt ? { runAt } : {}),
        ...(cron ? { cron } : {}),
        timezone,
        useScope: false,
        targetChat: "last_in_namespace",
        resultDelivery: "wake",
        awaitResponse: false,
        toolsMode: "auto",
        callingRoomId: ctx.roomId || null,
        targetUserIds: [ctx.ownerId],
        depth: 0,
        ...(args.model_selection !== undefined
          ? { selectionProfile: args.model_selection }
          : {}),
        ...(args.model_id !== undefined ? { requestedModelId: args.model_id } : {}),
      };
      const { taskId, status, nextFireAt } = await rt.createTask(input);
      return JSON.stringify({
        taskId,
        status,
        nextFireAt,
        message:
          "Scheduled. I'll run it at the time you set and report back here.",
      });
    },
  });
}
