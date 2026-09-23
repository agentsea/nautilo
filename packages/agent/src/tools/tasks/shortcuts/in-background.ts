import { DynamicStructuredTool } from "@langchain/core/tools";
import { log } from "@nautilo/logger";
import { z } from "zod";
import {
  getTaskToolRuntime,
  resolveTaskToolCreateLineage,
  type TaskToolCreateInput,
  type TaskToolHarnessCreateInput,
} from "../task-tool-runtime";
import {
  shortcutContextFromUnknown,
  modelSelectionParam,
  modelIdParam,
  type ShortcutContext,
} from "./shortcut-context";
import { validateTaskModelSelectionForCreate } from "../selection-validation";
import { codexHarnessFailureGuidance } from "../codex-harness-guidance";
import { getTaskCreationReturnContext } from "../../../runtime/task-creation-return-context";
import { genieRecoveryResult } from "../../genie-recovery";

/**
 * M144 — `in_background` intent shortcut (generic, no scoping). A thin
 * `TaskCreateInput` builder that runs a task using THIS room's context (the
 * basic namespace envelope at the dispatch seam) and reports back when done.
 *
 * Requester-only like `in_private_namespace`, but `preset:"in_background"`
 * (not `in_private_namespace`) so the seam's discriminator routes it to the
 * basic-namespace branch, NOT the wide branch (S3).
 */
const inBackgroundSchema = z.object({
  brief: z.string().min(1).describe("What to do in the background."),
  harness: z
    .literal("codex")
    .optional()
    .describe(
      "Use the connected Codex coding harness. Omit for Nautilo Native. Exact Codex selection never falls back to Native.",
    ),
  working_directory: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe(
      "Optional absolute directory on the selected Desktop where Codex should start. Native tasks inherit the exact Current Folder automatically; for Native, an exact matching value is accepted only as an assertion and never selects another path.",
    ),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      "Restrict the task to these tools. Omit to use the normal task tool set and, when the active live app permits delegation, inherit its eligible live operations. An empty list disables all tools.",
    ),
  result_delivery: z
    .enum(["wake", "raw", "raw_and_wake"])
    .optional()
    .describe(
      "How the result comes back: 'raw_and_wake' posts the result then resumes the agent (default), 'wake' resumes with a hidden result, and 'raw' only posts the result.",
    ),
  model_selection: modelSelectionParam,
  model_id: modelIdParam,
});

type InBackgroundArgs = z.infer<typeof inBackgroundSchema>;

/** Mirror of the `task` tool's tools→mode mapping (dispatch.ts). */
function toolsFieldsFromArgs(
  tools: string[] | undefined,
): Pick<TaskToolCreateInput, "toolsMode" | "toolsWhitelist"> {
  if (tools === undefined) return { toolsMode: "auto" };
  if (tools.length === 0) return { toolsMode: "none" };
  return { toolsMode: "whitelist", toolsWhitelist: tools };
}

const IN_BACKGROUND_DESCRIPTION =
  "Do a task in the background using this room's context and tell me when it's done. Runs asynchronously; I'll report back to this chat when complete. If an active live app permits background delegation, omit tools to inherit its eligible document operations; an explicit tools list is a ceiling, and an empty list disables tools. Omit harness for Nautilo Native; use harness: 'codex' for substantial coding work that benefits from the connected Codex harness. Codex either runs exactly or returns setup guidance, never Native fallback. When tools includes security_scan, the Task uses the Agent's configured default model unless an exact model_id or model_selection is deliberately supplied. Honor explicit model and privacy choices. Thorough security research requires careful source analysis; a model selection or completed ledger does not certify audit quality. For security research, include both file and security_scan and put the exact requested directory in the brief as security_scan targetDirectory. The worker must pass targetDirectory explicitly on start; it may be an absolute directory or a subfolder within Current Folder. Native working_directory does not select the scan target. Never silently substitute Current Folder or a parent directory. A create receipt means accepted, not that scanners started. On failure inspect task read before explaining it; do not invent missing tool grants, announce a report, or claim local processes stopped from a timeout. Automatic task-result wakes cannot create fresh Desktop scan authority; ask for a new Human Desktop request instead of launching repeated replacements. For other tasks, report the returned lifecycle state and explain they can be stopped from the Task card or Room Stop button.";

export function createInBackgroundTool(context?: unknown) {
  const ctx: ShortcutContext = shortcutContextFromUnknown(context);

  return new DynamicStructuredTool({
    name: "in_background",
    description: IN_BACKGROUND_DESCRIPTION,
    schema: inBackgroundSchema,
    func: async (args: InBackgroundArgs) => {
      log(`[in_background]`);
      if (!ctx.ownerId || !ctx.agentId) {
        return "Cannot start background task: missing owner or agent context.";
      }
      if (!ctx.causalHumanUserId) return "Cannot start task: initiating Human is unavailable.";
      const rt = getTaskToolRuntime();
      const lineage = await resolveTaskToolCreateLineage({
        ownerId: ctx.ownerId,
        db: rt.db,
        ...(ctx.currentTaskId ? { currentTaskId: ctx.currentTaskId } : {}),
      });
      if (!lineage.ok) return lineage.message;
      if (args.harness === "codex") {
        if (
          args.tools !== undefined
          || args.result_delivery !== undefined
          || args.model_selection !== undefined
          || args.model_id !== undefined
        ) {
          return "Cannot start Codex background task: tools, result_delivery, model_selection, and model_id are Native-only shortcut fields; omit them or use the advanced task tool for supported Codex controls.";
        }
        if (!rt.createHarnessTask) {
          return genieRecoveryResult("in_background", "Codex harness execution is unavailable on this server. Open Codex setup, then try again.", { requirement: "desktop" });
        }
        const input: TaskToolHarnessCreateInput = {
          ownerId: ctx.ownerId,
          requestorId: ctx.causalHumanUserId,
          agentId: ctx.agentId,
          prompt: args.brief,
          preset: "in_background",
          scheduleKind: "now",
          callingRoomId: ctx.roomId || null,
          awaitResponse: false,
          ...(lineage.parentTaskId ? { parentTaskId: lineage.parentTaskId } : {}),
          depth: lineage.depth,
          harness: "codex",
          collaborationMode: "work",
          ...(args.working_directory !== undefined
            ? { workingDirectory: args.working_directory }
            : {}),
        };
        try {
          const created = await rt.createHarnessTask(input);
          return JSON.stringify({
            taskId: created.taskId,
            status: created.status,
            execution: created.execution,
            message:
              "The task was accepted for Codex in the background; it will report back to this chat when done.",
          });
        } catch (error) {
          return codexHarnessFailureGuidance(error, "in_background")
            ?? `Cannot start Codex background task: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const securityResearch = args.tools?.includes("security_scan") === true;
      if (securityResearch && !getTaskCreationReturnContext()) {
        return "Cannot start security research: this turn has no direct Human Desktop authorization to create a local scan Task. No task was created. Do not retry with different tools or claim a missing tool grant. Ask the Human to send a fresh request in Desktop with the requested scan directory.";
      }
      if (securityResearch && !args.tools?.includes("file")) {
        return "Cannot start security research: include both file and security_scan in tools so the worker can verify the target and investigate source evidence. No task was created.";
      }
      if (args.working_directory !== undefined) {
        if (!ctx.currentFolder || args.working_directory !== ctx.currentFolder) {
          if (securityResearch) return "Cannot change a Native Task working_directory. Pass the requested repository or subfolder as security_scan targetDirectory in the worker brief; the scanner validates it inside Current Folder. Do not substitute the parent directory as the scan target.";
          return "Cannot start Native background task: working_directory must exactly match the selected Current Folder; omit it to inherit the Current Folder automatically.";
        }
      }
      const toolsFields = toolsFieldsFromArgs(args.tools);
      const selectionError = validateTaskModelSelectionForCreate({
        requestedModelId: args.model_id,
        profile: args.model_selection,
        toolsMode: toolsFields.toolsMode,
        toolsWhitelist: toolsFields.toolsWhitelist,
      });
      if (selectionError) return selectionError;
      const input: TaskToolCreateInput = {
        ownerId: ctx.ownerId,
        requestorId: ctx.causalHumanUserId,
        agentId: ctx.agentId,
        prompt: args.brief,
        preset: "in_background",
        scheduleKind: "now",
        useScope: false,
        targetChat: "orphan",
        resultDelivery: args.result_delivery ?? "raw_and_wake",
        awaitResponse: false,
        callingRoomId: ctx.roomId || null,
        targetUserIds: [ctx.causalHumanUserId],
        ...(lineage.parentTaskId ? { parentTaskId: lineage.parentTaskId } : {}),
        depth: lineage.depth,
        ...(args.model_selection !== undefined
          ? { selectionProfile: args.model_selection }
          : {}),
        ...(args.model_id !== undefined ? { requestedModelId: args.model_id } : {}),
        ...toolsFields,
      };
      const { taskId, status } = await rt.createTask(input);
      return JSON.stringify({
        taskId,
        status,
        execution: "native",
        message:
          securityResearch
            ? "The security research task was accepted. This does not confirm that scanners started or that a report exists; inspect task activity for actual progress."
            : "The task is running in the background; it will report back to this chat when done.",
      });
    },
  });
}
