import { sql } from "drizzle-orm";
import { tasks } from "@nautilo/db";
import { CLAUDE_EXECUTION_MAX_TEXT_BYTES } from "@nautilo/relay";
import { parseClaudeTaskExecutionMetadata } from "../claude/task-execution-route";

export type ProtectedTaskClaudeSelection = Readonly<{
  profileRef: string;
  catalogModelId: string;
  selectedModel: string;
}>;

/**
 * Only the closed Claude routing fields may leave the product row. Shadow
 * metadata can also contain protected content, so selecting the complete
 * metadata object is not an execution-admission shortcut.
 */
export function protectedTaskClaudeSelectionProjection() {
  return sql<unknown>`case
    when jsonb_typeof(${tasks.metadata}) = 'object'
    then case
      when (${tasks.metadata} - 'execution' - 'preparation' - 'lastInterruption') = '{}'::jsonb
        and jsonb_typeof(${tasks.metadata}->'execution') = 'object'
        and ${tasks.preset} in ('task', 'in_scope', 'in_private_namespace', 'in_background', 'schedule')
      then case
        when ((${tasks.metadata}->'execution') - 'version' - 'harnessId' - 'source'
          - 'profileRef' - 'catalogModelId' - 'selectedModel') = '{}'::jsonb
          and ${tasks.metadata}->'execution'->'version' = '1'::jsonb
          and jsonb_typeof(${tasks.metadata}->'execution'->'harnessId') = 'string'
          and ${tasks.metadata}->'execution'->>'harnessId' = 'claude-code'
          and jsonb_typeof(${tasks.metadata}->'execution'->'source') = 'string'
          and ${tasks.metadata}->'execution'->>'source' = 'genie'
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'profileRef') = 'string'
            then octet_length(${tasks.metadata}->'execution'->>'profileRef') between 1 and ${CLAUDE_EXECUTION_MAX_TEXT_BYTES}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'catalogModelId') = 'string'
            then octet_length(${tasks.metadata}->'execution'->>'catalogModelId') between 1 and ${CLAUDE_EXECUTION_MAX_TEXT_BYTES}
            else false end
          and case when jsonb_typeof(${tasks.metadata}->'execution'->'selectedModel') = 'string'
            then octet_length(${tasks.metadata}->'execution'->>'selectedModel') between 1 and ${CLAUDE_EXECUTION_MAX_TEXT_BYTES}
            else false end
        then jsonb_build_object(
          'version', 1,
          'harnessId', 'claude-code',
          'source', 'genie',
          'profileRef', ${tasks.metadata}->'execution'->>'profileRef',
          'catalogModelId', ${tasks.metadata}->'execution'->>'catalogModelId',
          'selectedModel', ${tasks.metadata}->'execution'->>'selectedModel'
        )
        else null
      end
      else null
    end
    else null
  end`.as("claude_execution_selection");
}

export function parseProtectedTaskClaudeSelection(value: unknown): ProtectedTaskClaudeSelection | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = parseClaudeTaskExecutionMetadata({ execution: value });
  if (metadata === null) return null;
  const { profileRef, catalogModelId, selectedModel } = metadata.execution;
  return Object.freeze({ profileRef, catalogModelId, selectedModel });
}

export function sameProtectedTaskClaudeSelection(
  left: ProtectedTaskClaudeSelection | null | undefined,
  right: ProtectedTaskClaudeSelection,
): boolean {
  return left !== null && left !== undefined
    && left.profileRef === right.profileRef
    && left.catalogModelId === right.catalogModelId
    && left.selectedModel === right.selectedModel;
}
