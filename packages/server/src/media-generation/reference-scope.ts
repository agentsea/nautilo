import type { MediaGenerationApprovalActorContext } from "@nautilo/agent";
import type { MediaGenerationScope } from "@nautilo/db";
import { envelopeReadableNamespaces, findActorByOwnerId, getPolicyResolver, isScopeMemoryEnvelope, type MemoryAccessEnvelope } from "@nautilo/trust";

/** Reference reads follow the current Workspace envelope. Output still belongs
 * to the one writable project namespace. Rebuild this at preparation AND submit
 * so a quote never preserves access that has since been revoked. */
export async function resolveMediaReferenceNamespaces(
  scope: MediaGenerationScope,
  actor: MediaGenerationApprovalActorContext,
  buildEnvelope: (humanActorId: string) => Promise<MemoryAccessEnvelope> = async humanActorId => {
    const resolver = getPolicyResolver();
    if (!resolver) throw new Error("Workspace access is unavailable");
    return resolver.buildEnvelope(humanActorId, `room:${actor.roomId}`, actor.agentId, actor.roomId);
  },
  findHumanActor: (userId: string) => Promise<{ id: string } | null> = findActorByOwnerId,
): Promise<readonly string[]> {
  if (actor.userId !== scope.ownerId || actor.roomId !== scope.roomId) throw new Error("Reference actor changed");
  const human = await findHumanActor(actor.userId);
  if (!human) throw new Error("Reference actor unavailable");
  const envelope = await buildEnvelope(human.id);
  if (isScopeMemoryEnvelope(envelope) || envelope.actorId !== human.id || envelope.ownerId !== actor.userId ||
      envelope.roomId !== actor.roomId || envelope.agentId !== actor.agentId ||
      envelope.writableNamespaces.length !== 1 || envelope.writableNamespaces[0] !== scope.namespaceId) {
    throw new Error("Reference access changed");
  }
  return envelopeReadableNamespaces(envelope);
}
