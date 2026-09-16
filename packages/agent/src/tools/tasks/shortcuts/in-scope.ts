import { DynamicStructuredTool } from "@langchain/core/tools";
import { log } from "@nautilo/logger";
import { z } from "zod";
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
 * M144 — `in_scope` intent shortcut (M084 `delegate_to_subagent` parity, async).
 *
 * A thin `TaskCreateInput` builder: it pre-fills the scope-memory preset and
 * calls the shared M142 `createTask()`. NO execution / envelope / whitelist
 * logic lives here — the dispatch seam (`dispatch-task-run.ts`) builds the
 * `ScopeMemoryEnvelope` and validates the whitelist at dispatch time.
 */
const inScopeSchema = z.object({
  brief: z.string().min(1).describe("What the scoped helper should do."),
  tools: z
    .array(z.string())
    .describe("Tool names the helper may use (empty list = no tools / reasoning-only)."),
  expected_output: z
    .string()
    .optional()
    .describe("Optional description of the result you want back."),
  scope_id: z
    .string()
    .optional()
    .describe("Reuse an existing memory scope; omit to mint an ephemeral one."),
  model_selection: modelSelectionParam,
  model_id: modelIdParam,
});

type InScopeArgs = z.infer<typeof inScopeSchema>;

const IN_SCOPE_DESCRIPTION =
  "Have a helper do a narrow task with only the tools you list and none of your private memory (scoped). Runs in the background; I'll report back to this chat when it's done. After calling this, tell the user the work is running in the background.";

export function createInScopeTool(context?: unknown) {
  const ctx: ShortcutContext = shortcutContextFromUnknown(context);

  return new DynamicStructuredTool({
    name: "in_scope",
    description: IN_SCOPE_DESCRIPTION,
    schema: inScopeSchema,
    func: async (args: InScopeArgs) => {
      log(`[in_scope]`);
      if (!ctx.ownerId || !ctx.agentId) {
        return "Cannot start scoped task: missing owner or agent context.";
      }
      const selectionError = validateTaskModelSelectionForCreate({
        requestedModelId: args.model_id,
        profile: args.model_selection,
        // in_scope is always tool-using with a (possibly empty) whitelist.
        toolsMode: "whitelist",
        toolsWhitelist: args.tools,
      });
      if (selectionError) return selectionError;
      const rt = getTaskToolRuntime();
      const input: TaskToolCreateInput = {
        ownerId: ctx.ownerId,
        requestorId: ctx.ownerId,
        agentId: ctx.agentId,
        prompt: args.brief,
        ...(args.expected_output !== undefined
          ? { expectedOutput: args.expected_output }
          : {}),
        preset: "in_scope",
        scheduleKind: "now",
        useScope: true,
        scopeId: args.scope_id ?? null,
        toolsMode: "whitelist",
        toolsWhitelist: args.tools,
        targetChat: "orphan",
        awaitResponse: false,
        callingRoomId: ctx.roomId || null,
        targetUserIds: [ctx.ownerId],
        depth: 0,
        ...(args.model_selection !== undefined
          ? { selectionProfile: args.model_selection }
          : {}),
        ...(args.model_id !== undefined ? { requestedModelId: args.model_id } : {}),
      };
      const { taskId, status } = await rt.createTask(input);
      return JSON.stringify({
        taskId,
        status,
        message:
          "The scoped helper is running in the background; it will report back to this chat when done.",
      });
    },
  });
}
