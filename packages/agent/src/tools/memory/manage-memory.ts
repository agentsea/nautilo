import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { saveMemory, replaceMemory, demoteMemory, promoteMemory } from "../../store/memory-store";
import {
  saveScopeMemory,
  replaceScopeMemory,
  demoteScopeMemory,
  promoteScopeMemory,
  ScopeMemoryMutationError,
} from "../../store/scope-memory-store";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  isScopeMemoryEnvelope,
  envelopeWritableNamespaces,
  envelopeReadableNamespaces,
  resolveSpeakerUserId,
} from "@nautilo/trust";
import {
  StrictShadowEnforcementError,
  type ProtectedAgentMemoryRepository,
  type ProtectedMemoryResult,
} from "@nautilo/lattice-bridge";
import { protectedMemoryAuthorityFromEnvelope } from "./protected-memory-authority";
import {
  protectedMemoryToolOperationId,
  protectedMemoryToolRequestId,
  ProtectedMemoryToolUnavailableError,
} from "./protected-memory-ports";

interface MemoryToolContext {
  memoryAccessEnvelope?: MemoryAccessEnvelope | null;
  /** Invocation-bound protected composition; ordinary mode leaves this absent. */
  protectedMemoryRepository?: ProtectedAgentMemoryRepository;
}

function requireProtectedSuccess<Value>(
  result: ProtectedMemoryResult<Value>,
): asserts result is Extract<ProtectedMemoryResult<Value>, { status: "success" }> {
  if (result.status === "unavailable") {
    throw new ProtectedMemoryToolUnavailableError(result.reason);
  }
}

export function createManageMemoryTool(context?: MemoryToolContext) {
  return new DynamicStructuredTool({
    name: "manage_memory",
    description: `Save, update, or remove a persistent Memory in the current authorized Memory context. These actions do not share a Memory or grant anyone access.

Use "save" when you learn something new and important:
- A preference ("prefers formal tone in investor docs")
- A fact about them or their work ("CEO of Acme Corp, ARR is $2.3M")
- A decision ("decided to use Q1 numbers for the pitch deck")
- A goal ("ship the pitch deck by Friday")
- Their identity ("name is Alex, works at Northlight Labs")

Use "replace" when information changes (requires memory_id from search_memory).
Use "promote" when a searchable Memory (Tier 2) becomes important enough to return to the brief. Promote changes recall tier only; it is not sharing.
Use "remove" when the user asks you to forget something (demotes to archive, never deletes).

Be selective — only save things useful in future conversations.`,

    schema: z.object({
      action: z.enum(["save", "replace", "promote", "remove"])
        .describe("Save in the current authorized context, edit, change recall tier, or remove; never grants access"),
      content: z.string().optional().describe("The memory content — a clear, concise statement"),
      type: z
        .enum(["preference", "decision", "fact", "event", "identity", "goal", "observation", "todo"])
        .optional()
        .default("fact")
        .describe("Category of memory"),
      memory_id: z.string().optional().describe("Required for replace/remove — the ID from search_memory"),
    }),

    func: async (
      { action, content, type, memory_id },
      runManager,
      runConfig,
    ) => {
      try {
        const envelope = context?.memoryAccessEnvelope;

        if (context?.protectedMemoryRepository) {
          const authority = protectedMemoryAuthorityFromEnvelope(envelope);
          if (!authority) {
            throw new ProtectedMemoryToolUnavailableError("authorization_required");
          }
          const configuredRequestId: unknown =
            runConfig?.configurable?.["memoryToolMutationRequestId"];
          const trustedRequestId = protectedMemoryToolRequestId(
            runManager?.runId,
            configuredRequestId,
          );
          if (!trustedRequestId) {
            throw new ProtectedMemoryToolUnavailableError("authorization_required");
          }
          const operationId = protectedMemoryToolOperationId({
            requestId: trustedRequestId,
            action,
            ...(memory_id === undefined ? {} : { subjectId: memory_id }),
          });
          if (action === "save") {
            if (!content) return "Content is required for save.";
            const result = await context.protectedMemoryRepository.save({
              operationId,
              authority,
              type: type ?? "fact",
              content,
            });
            requireProtectedSuccess(result);
            // The publication receipt owns semantic-change delivery. A tool
            // retry must not invent a second notification outside that owner.
            const message = result.value.action === "updated"
              ? `Updated existing memory (id: ${result.value.id}) — similar content already existed (similarity: ${result.value.similarity?.toFixed(2) ?? "n/a"}).`
              : `Saved memory (id: ${result.value.id}, type: ${type ?? "fact"}): "${content}"`;
            return result.followUpPending ? `${message} Follow-up processing pending.` : message;
          }
          if (!memory_id) return "memory_id is required for this action.";
          const result = action === "replace"
            ? content
              ? await context.protectedMemoryRepository.replace({
                operationId,
                authority,
                memoryId: memory_id,
                content,
              })
              : null
            : await context.protectedMemoryRepository.setTier({
              operationId,
              authority,
              memoryId: memory_id,
              action: action === "promote" ? "promote" : "demote",
            });
          if (result === null) return "content is required for replace.";
          requireProtectedSuccess(result);
          const message = action === "replace" ? `Updated memory (id: ${memory_id}).`
            : action === "promote" ? `Memory (id: ${memory_id}) promoted back into the prompt brief.`
            : `Memory (id: ${memory_id}) demoted to archive. It won't appear in normal searches but is not deleted.`;
          return result.followUpPending ? `${message} Follow-up processing pending.` : message;
        }

        if (isScopeMemoryEnvelope(envelope)) {
          const speakerUserId = await resolveSpeakerUserId(envelope);
          if (!speakerUserId) {
            return "Cannot perform scope memory operation: speaker identity missing in this context.";
          }
          const agentId = envelope.agentId;
          const scopeId = envelope.scopeId;
          try {
            if (action === "save") {
              if (!content) return "Content is required for save.";
              const result = await saveScopeMemory({
                speakerUserId,
                agentId,
                scopeId,
                type: type ?? "fact",
                content,
              });
              if (result.action === "updated") {
                return `Updated existing scope memory (id: ${result.id}) — similar content already existed (similarity: ${result.similarity?.toFixed(2) ?? "n/a"}).`;
              }
              return `Saved scope memory (id: ${result.id}, type: ${type ?? "fact"}): "${content}"`;
            }
            if (action === "replace") {
              if (!memory_id) return "memory_id is required for replace.";
              if (!content) return "content is required for replace.";
              await replaceScopeMemory({ speakerUserId, agentId, scopeId, memoryId: memory_id, content });
              return `Updated scope memory (id: ${memory_id}).`;
            }
            if (action === "remove") {
              if (!memory_id) return "memory_id is required for remove.";
              await demoteScopeMemory({ speakerUserId, agentId, scopeId, memoryId: memory_id });
              return `Scope memory (id: ${memory_id}) demoted to archive.`;
            }
            if (action === "promote") {
              if (!memory_id) return "memory_id is required for promote.";
              await promoteScopeMemory({ speakerUserId, agentId, scopeId, memoryId: memory_id });
              return `Scope memory (id: ${memory_id}) promoted back into the prompt brief.`;
            }
            return `Unknown action: ${String(action)}`;
          } catch (err) {
            if (err instanceof ScopeMemoryMutationError) {
              return `Memory operation failed: ${err.message}`;
            }
            throw err;
          }
        }

        const namespaceId = envelopeWritableNamespaces(envelope)[0];
        const mutableNs =
          (envelope && !isScopeMemoryEnvelope(envelope)
            ? envelope.mutableNamespaces
            : undefined) ?? envelopeReadableNamespaces(envelope);

        if (action === "save") {
          if (!content) return "Content is required for save.";
          // M125 Phase 2.7: agentId must come from the envelope. Pre-M125
          // a missing envelope agentId silently borrowed the bootstrap
          // default, which routed every anonymous / background-job memory
          // save into the first claimer's `agent_id` partition (cross-user
          // data risk). Fail closed and surface to the LLM.
          const agentId = envelope?.agentId ?? "";
          if (!agentId) {
            return "manage_memory unavailable: no agent context.";
          }
          const saveOpts: Parameters<typeof saveMemory>[0] = {
            agentId,
            type: type ?? "fact",
            content,
          };
          if (namespaceId) saveOpts.namespaceId = namespaceId;
          if (envelope?.ownerId) saveOpts.userId = envelope.ownerId;
          const result = await saveMemory(saveOpts);
          if (result.action === "updated") {
            return `Updated existing memory (id: ${result.id}) — similar content already existed (similarity: ${result.similarity?.toFixed(2) ?? "n/a"}).`;
          }
          return `Saved memory (id: ${result.id}, type: ${type ?? "fact"}): "${content}"`;
        }

        if (action === "replace") {
          if (!memory_id) return "memory_id is required for replace.";
          if (!content) return "content is required for replace.";
          await replaceMemory(memory_id, content, mutableNs.length > 0 ? mutableNs : undefined, {
            userId: envelope?.ownerId,
            agentId: envelope?.agentId,
          });
          return `Updated memory (id: ${memory_id}).`;
        }

        if (action === "remove") {
          if (!memory_id) return "memory_id is required for remove.";
          await demoteMemory(memory_id, mutableNs.length > 0 ? mutableNs : undefined, {
            userId: envelope?.ownerId,
            agentId: envelope?.agentId,
          });
          return `Memory (id: ${memory_id}) demoted to archive. It won't appear in normal searches but is not deleted.`;
        }

        if (action === "promote") {
          if (!memory_id) return "memory_id is required for promote.";
          await promoteMemory(memory_id, mutableNs.length > 0 ? mutableNs : undefined, {
            userId: envelope?.ownerId,
            agentId: envelope?.agentId,
          });
          return `Memory (id: ${memory_id}) promoted back into the prompt brief.`;
        }

        return `Unknown action: ${String(action)}`;
      } catch (error) {
        // The invocation owner must record failed protected publication as a
        // failed tool, not a successful text result describing a failed save.
        if (context?.protectedMemoryRepository) throw error;
        if (runConfig?.signal?.aborted === true) throw error;
        if (error instanceof StrictShadowEnforcementError) throw error;
        if (error instanceof ProtectedMemoryToolUnavailableError) throw error;
        const msg = error instanceof Error ? error.message : String(error);
        return `Memory operation failed: ${msg}`;
      }
    },
  });
}
