import { parseProtectedTaskOpenCodeSelection, protectedTaskOpenCodeSelectionProjection, type ProtectedTaskOpenCodeSelection } from "./protected-task-opencode-selection";
import { parseProtectedTaskDeepResearchSelection, protectedTaskDeepResearchSelectionProjection, type ProtectedTaskDeepResearchSelection } from "./protected-task-deep-research-selection";
import { parseProtectedTaskCodexSelection, protectedTaskCodexSelectionProjection, type ProtectedTaskCodexSelection } from "./protected-task-codex-selection";
import { parseProtectedTaskHermesSelection, protectedTaskHermesSelectionProjection, type ProtectedTaskHermesSelection } from "./protected-task-hermes-selection";
import { and, eq, inArray, sql, tasks, type DirectDatabase } from "@nautilo/db";
import type { ProtectedTaskRuntimeGrantPlanBuilderDependencies } from "./protected-task-runtime-grant-plan";
import { parseProtectedTaskClaudeSelection, protectedTaskClaudeSelectionProjection,
  type ProtectedTaskClaudeSelection } from "./protected-task-claude-selection";
import { parseProtectedTaskRepoDocsSelection, protectedTaskRepoDocsSelectionProjection,
  type ProtectedTaskRepoDocsSelection } from "./protected-task-repo-docs-selection";

type Prepare = ProtectedTaskRuntimeGrantPlanBuilderDependencies["prepareExecution"];

/** Select a closed operational route before creating any execution grant. */
export function createProtectedTaskExecutionPreparation(input: Readonly<{
  db: DirectDatabase;
  native: Prepare;
  claude?(selection: ProtectedTaskClaudeSelection, preparation: Parameters<Prepare>[0]): ReturnType<Prepare>;
  codex?(selection: ProtectedTaskCodexSelection, preparation: Parameters<Prepare>[0]): ReturnType<Prepare>;
  opencode?(selection: ProtectedTaskOpenCodeSelection, preparation: Parameters<Prepare>[0]): ReturnType<Prepare>;
  hermes?(selection: ProtectedTaskHermesSelection, preparation: Parameters<Prepare>[0]): ReturnType<Prepare>;
  deepResearch?(selection: ProtectedTaskDeepResearchSelection, preparation: Parameters<Prepare>[0]): ReturnType<Prepare>;
  repoDocs?(selection: ProtectedTaskRepoDocsSelection, preparation: Parameters<Prepare>[0]): ReturnType<Prepare>;
}>): Prepare {
  return async preparation => {
    const occurrence = preparation.occurrence;
    const rows = await input.db.select({
      native: sql<boolean>`case when jsonb_typeof(${tasks.metadata}) = 'object' then
        coalesce(${inArray(tasks.preset, ["task", "in_scope", "in_private_namespace", "in_background", "schedule"])}
          and (${tasks.metadata} - 'preparation' - 'lastInterruption') = '{}'::jsonb, false)
        else false end`,
      claude: protectedTaskClaudeSelectionProjection(),
      codex: protectedTaskCodexSelectionProjection(),
      hermes: protectedTaskHermesSelectionProjection(),
      opencode: protectedTaskOpenCodeSelectionProjection(),
      deepResearch: protectedTaskDeepResearchSelectionProjection(),
      repoDocs: protectedTaskRepoDocsSelectionProjection(),
    }).from(tasks).where(and(
      eq(tasks.id, occurrence.task.id), eq(tasks.ownerId, occurrence.task.ownerId),
      eq(tasks.requestorId, occurrence.task.requestorId), eq(tasks.agentId, occurrence.task.agentId),
      eq(tasks.contentRevision, occurrence.task.contentRevision), eq(tasks.cryptoObjectId, occurrence.task.cryptoObjectId),
      eq(tasks.contentNamespaceId, occurrence.task.contentNamespaceId), eq(tasks.cryptoMappingState, "verified"),
    )).limit(2);
    if (rows.length !== 1) throw new TypeError("Protected Task execution definition changed");
    const selected = rows[0]!;
    if (selected.native === true) return input.native(preparation);
    const claude = parseProtectedTaskClaudeSelection(selected.claude);
    if (claude !== null && input.claude !== undefined) return input.claude(claude, preparation);
    const codex = parseProtectedTaskCodexSelection(selected.codex);
    if (codex !== null && input.codex !== undefined) return input.codex(codex, preparation);
    const hermes = parseProtectedTaskHermesSelection(selected.hermes);
    if (hermes !== null && input.hermes !== undefined) return input.hermes(hermes, preparation);
    const opencode = parseProtectedTaskOpenCodeSelection(selected.opencode);
    if (opencode !== null && input.opencode !== undefined) return input.opencode(opencode, preparation);
    const deepResearch = parseProtectedTaskDeepResearchSelection(selected.deepResearch);
    if (deepResearch !== null && input.deepResearch !== undefined) return input.deepResearch(deepResearch, preparation);
    const repoDocs = parseProtectedTaskRepoDocsSelection(selected.repoDocs);
    if (repoDocs !== null && input.repoDocs !== undefined) return input.repoDocs(repoDocs, preparation);
    throw new TypeError("Protected Task execution route is unavailable");
  };
}
