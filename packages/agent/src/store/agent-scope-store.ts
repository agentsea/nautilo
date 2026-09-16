/**
 * M033 Phase 2B — agent-side scope attach via `agentDb` +
 * `withAgentTrustContext`. The scope row is locked in the same transaction as
 * the attachment so an M251 close cannot race a new seed edge.
 */
import {
  and,
  agentDb as db,
  agentScopes,
  eq,
  inArray,
  memories,
  memoryNamespaces,
  memoryScopes,
} from "@nautilo/db";
import { withAgentTrustContext } from "./trust-agent-db";

export type AttachMemoryToScopeContext = {
  agentId: string;
  speakerUserId: string;
  readableNamespaceIds: string[];
};

export type AttachMemoryToScopeResult =
  | { status: "attached" | "already_attached"; scopeName: string }
  | {
      error:
        | "memory_not_found"
        | "memory_not_visible"
        | "scope_not_found"
        | "scope_closing";
    };

/**
 * M080 — attach an existing memory to an agent scope. Enforces M081
 * visibility (namespace overlap + `agent_id`) and scope ownership
 * (`parent_agent_id`, `speaker_user_id`). Never filters `memories` by
 * `speakerUserId` — that field matches the scope row only.
 *
 * Hot path: one SELECT with join + EXISTS semantics (namespace overlap +
 * agent guard). If that misses, a second bare `memories.id` lookup
 * distinguishes `memory_not_found` vs `memory_not_visible`.
 */
export async function attachMemoryToScope(
  memoryId: string,
  scopeId: string,
  ctx: AttachMemoryToScopeContext,
): Promise<AttachMemoryToScopeResult> {
  if (ctx.readableNamespaceIds.length === 0) {
    return { error: "memory_not_visible" };
  }

  return withAgentTrustContext(
    { userId: ctx.speakerUserId, agentId: ctx.agentId },
    async (tx) => {
      const handle = tx as unknown as typeof db;

      const [visible] = await handle
        .select({ id: memories.id })
        .from(memories)
        .innerJoin(memoryNamespaces, eq(memoryNamespaces.memoryId, memories.id))
        .where(
          and(
            eq(memories.id, memoryId),
            inArray(memoryNamespaces.namespaceId, ctx.readableNamespaceIds),
          ),
        )
        .limit(1);

      if (visible) {
        const [scope] = await handle
          .select({
            name: agentScopes.name,
            lifecycleState: agentScopes.lifecycleState,
          })
          .from(agentScopes)
          .where(and(
            eq(agentScopes.id, scopeId),
            eq(agentScopes.parentAgentId, ctx.agentId),
            eq(agentScopes.speakerUserId, ctx.speakerUserId),
          ))
          .limit(1)
          .for("update");
        if (!scope) {
          return { error: "scope_not_found" };
        }
        if (scope.lifecycleState !== "open") {
          return { error: "scope_closing" };
        }

        const inserted = await handle
          .insert(memoryScopes)
          .values({ memoryId, scopeId, origin: "seed" })
          .onConflictDoNothing()
          .returning({ memoryId: memoryScopes.memoryId });

        return inserted.length > 0
          ? { status: "attached", scopeName: scope.name }
          : { status: "already_attached", scopeName: scope.name };
      }

      const [bare] = await handle
        .select({ id: memories.id })
        .from(memories)
        .where(eq(memories.id, memoryId))
        .limit(1);
      if (!bare) {
        return { error: "memory_not_found" };
      }
      return { error: "memory_not_visible" };
    },
  );
}
