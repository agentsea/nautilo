import { DynamicStructuredTool } from "@langchain/core/tools";
import { log } from "@nautilo/logger";
import { z } from "zod";
import {
  getTaskToolRuntime,
  type TaskToolCreateInput,
} from "../task-tool-runtime";
import {
  modelIdParam,
  modelSelectionParam,
  shortcutContextFromUnknown,
  type ShortcutContext,
} from "./shortcut-context";
import { validateTaskModelSelectionForCreate } from "../selection-validation";

/**
 * D363 (Stack-128) — `generate_repo_docs` entry tool. A thin
 * `TaskCreateInput` builder that mints a `repo_docs` task and returns
 * immediately. It does NOT run the doc agent — a separate executor path
 * (built in parallel) consumes the task. Mirrors `in_background`'s
 * context plumbing; the executor-side contract is carried in
 * `metadata: { target, mode, publish, instructions }`.
 *
 * Gated on `use_project_execution` in register-all.ts + tool-policies.ts;
 * requires explicit confirm-level approval.
 */
const generateRepoDocsSchema = z.object({
  target: z
    .string()
    .min(1)
    .describe(
      "Repository to document: a local filesystem path or a git URL the executor can clone.",
    ),
  mode: z
    .enum(["init", "update", "auto"])
    .default("auto")
    .describe(
      "init = fresh generation; update = refresh existing docs in place; auto = let the executor decide based on existing state.",
    ),
  instructions: z
    .string()
    .optional()
    .describe(
      "Optional guidance for the doc agent (audience, scope, conventions). Defaults to a generic generate/maintain brief.",
    ),
  publish: z
    .enum(["branch", "push", "pr"])
    .default("branch")
    .describe(
      "How results land: branch = leave changes on a new local branch/worktree; push = push the branch to the remote; pr = push the branch and report that a PR should be opened for it. NOTE (v1): automatic PR creation is NOT enabled yet — 'pr' currently behaves like 'push' and instructs the caller to open the PR manually.",
    ),
  model_selection: modelSelectionParam,
  model_id: modelIdParam,
});

type GenerateRepoDocsArgs = z.infer<typeof generateRepoDocsSchema>;

const GENERATE_REPO_DOCS_DESCRIPTION =
  "Create a repository-docs task for a separate doc-agent executor to generate or maintain docs for a repo (local path or git URL). This only creates the task and returns immediately — the executor picks it up asynchronously. Without model_id, model_selection defaults to 'smart_cheap'. With model_id, the task uses that exact curated model as a strict pin with no cross-model fallback. After calling this, tell the user the doc generation is queued and to watch the subagent dock for progress.";

export function createGenerateRepoDocsTool(context?: unknown) {
  const ctx: ShortcutContext = shortcutContextFromUnknown(context);

  return new DynamicStructuredTool({
    name: "generate_repo_docs",
    description: GENERATE_REPO_DOCS_DESCRIPTION,
    schema: generateRepoDocsSchema,
    func: async (args: GenerateRepoDocsArgs) => {
      log(`[generate_repo_docs] target=${args.target} mode=${args.mode} publish=${args.publish}`);
      if (!ctx.ownerId || !ctx.agentId) {
        return "Cannot start repo_docs task: missing owner or agent context.";
      }
      // Preserve the D363 smart_cheap default only when no exact pin is
      // supplied. An exact model_id must not conflict with an implicit
      // profile the caller never requested.
      const selection =
        args.model_id == null
          ? (args.model_selection ?? "smart_cheap")
          : args.model_selection;
      const selectionError = validateTaskModelSelectionForCreate({
        requestedModelId: args.model_id,
        profile: selection,
        // repo_docs always runs with the file whitelist, so exact selection
        // requires confirmed tool support.
        toolsMode: "whitelist",
        toolsWhitelist: ["file"],
      });
      if (selectionError) return selectionError;
      const rt = getTaskToolRuntime();
      const input: TaskToolCreateInput = {
        ownerId: ctx.ownerId,
        requestorId: ctx.ownerId,
        agentId: ctx.agentId,
        prompt: args.instructions ?? "Generate/maintain repository documentation.",
        preset: "repo_docs",
        scheduleKind: "now",
        useScope: false,
        targetChat: "orphan",
        awaitResponse: false,
        callingRoomId: ctx.roomId || null,
        targetUserIds: [ctx.ownerId],
        depth: 0,
        ...(selection !== undefined ? { selectionProfile: selection } : {}),
        ...(args.model_id != null
          ? { requestedModelId: args.model_id }
          : {}),
        toolsMode: "whitelist",
        toolsWhitelist: ["file"],
        metadata: {
          target: args.target,
          mode: args.mode,
          publish: args.publish,
          instructions: args.instructions,
        },
      };
      const { taskId, status } = await rt.createTask(input);
      return JSON.stringify({
        taskId,
        status,
        message: `Repo docs task started — watch the subagent dock (task ${taskId}).`,
      });
    },
  });
}
