import { agentScopes, and, eq, type DirectDatabase } from "@nautilo/db";

type ProductTransaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

/** Called only inside the protected Task product-creation transaction. */
export async function prepareProtectedTaskScope(
  transaction: ProductTransaction,
  input: Readonly<{
    taskId: string;
    requesterUserId: string;
    agentId: string;
    scopeId: string | null;
  }>,
): Promise<string> {
  if (input.scopeId !== null) {
    const [scope] = await transaction.select({ id: agentScopes.id })
      .from(agentScopes).where(and(
        eq(agentScopes.id, input.scopeId),
        eq(agentScopes.parentAgentId, input.agentId),
        eq(agentScopes.speakerUserId, input.requesterUserId),
        eq(agentScopes.lifecycleState, "open"),
      )).limit(1).for("share");
    if (scope === undefined) throw new TypeError("Protected Task Scope is unavailable");
    return scope.id;
  }

  // The Task identity is structural. Neither a Full prompt nor its Shadow
  // sibling may be copied into ordinary Scope name/purpose fields.
  const [scope] = await transaction.insert(agentScopes).values({
    parentAgentId: input.agentId,
    speakerUserId: input.requesterUserId,
    name: `task:${input.taskId}`,
    purpose: null,
  }).onConflictDoNothing().returning({ id: agentScopes.id });
  if (scope === undefined) throw new TypeError("Protected Task Scope identity conflicts");
  return scope.id;
}
