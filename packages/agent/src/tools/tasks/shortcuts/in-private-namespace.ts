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
 * M144 — `in_private_namespace` intent shortcut (M137 `do_in_private_namespace`
 * parity, async). A thin `TaskCreateInput` builder for a wide-envelope
 * excursion into the speaker's OWN private namespace with their FULL tool set.
 *
 * The wide envelope + `returnRoomNamespaceId` are built at the dispatch seam;
 * this shortcut only stores intent: `preset:"in_private_namespace"`,
 * requester-only `targetUserIds`, and `metadata.bringBack` for the seam to
 * read. It is gated on `invoke_agents` in `register-all.ts` +
 * `tool-policies.ts`.
 */
const inPrivateNamespaceSchema = z.object({
  brief: z.string().min(1).describe("What to do inside your private space."),
  bring_back: z
    .boolean()
    .optional()
    .describe(
      "Bring the result back into this room (default true). When false, the excursion stays private and only the result text is reported back.",
    ),
  model_selection: modelSelectionParam,
  model_id: modelIdParam,
});

type InPrivateNamespaceArgs = z.infer<typeof inPrivateNamespaceSchema>;

const IN_PRIVATE_NAMESPACE_DESCRIPTION =
  "Go into your own private space, do the task there with your full tool set, and (by default) bring the result back to this room. Runs in the background; I'll report back when done. After calling this, tell the user the work is running in the background.";

export function createInPrivateNamespaceTool(context?: unknown) {
  const ctx: ShortcutContext = shortcutContextFromUnknown(context);

  return new DynamicStructuredTool({
    name: "in_private_namespace",
    description: IN_PRIVATE_NAMESPACE_DESCRIPTION,
    schema: inPrivateNamespaceSchema,
    func: async (args: InPrivateNamespaceArgs) => {
      log(`[in_private_namespace]`);
      if (!ctx.ownerId || !ctx.agentId) {
        return "Cannot start private-namespace task: missing owner or agent context.";
      }
      if (!ctx.causalHumanUserId) return "Cannot start task: initiating Human is unavailable.";
      const selectionError = validateTaskModelSelectionForCreate({
        requestedModelId: args.model_id,
        profile: args.model_selection,
        // in_private_namespace runs with the full tool set (auto).
        toolsMode: "auto",
      });
      if (selectionError) return selectionError;
      // Default true (R4). The dispatch seam reads `metadata.bringBack` to
      // decide whether to thread `returnRoomNamespaceId` into the wide envelope.
      const bringBack = args.bring_back ?? true;
      const rt = getTaskToolRuntime();
      const input: TaskToolCreateInput = {
        ownerId: ctx.ownerId,
        requestorId: ctx.causalHumanUserId,
        agentId: ctx.agentId,
        prompt: args.brief,
        preset: "in_private_namespace",
        scheduleKind: "now",
        useScope: false,
        toolsMode: "auto",
        targetChat: "orphan",
        awaitResponse: false,
        callingRoomId: ctx.roomId || null,
        targetUserIds: [ctx.causalHumanUserId],
        metadata: { bringBack },
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
          "The private-namespace excursion is running in the background; it will report back to this chat when done.",
      });
    },
  });
}
