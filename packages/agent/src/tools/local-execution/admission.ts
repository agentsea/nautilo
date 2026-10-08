import { createHash } from "node:crypto";
import type { RelayLocalExecutionBinding, RelayLocalExecutionOwnerV1 } from "@nautilo/relay";

export function localExecutionOwnerKey(owner: RelayLocalExecutionOwnerV1): string {
  return JSON.stringify([owner.instanceId, owner.humanUserId, owner.agentId, owner.runId, owner.conversationId,
    owner.relayId, owner.desktopSessionId, owner.pairingGeneration, owner.serverBindingId,
    owner.profileId, owner.profileRevision, [...owner.grantIds].sort(), owner.grantRevision, owner.protectedPolicyVersion]);
}
export function localExecutionId(generation: string, owner: RelayLocalExecutionOwnerV1, invocationId: string): string {
  // Mutable authority revisions must conflict with the retained execution,
  // rather than minting another process identity for the same tool call.
  return createHash("sha256").update(JSON.stringify([generation, owner.instanceId, owner.humanUserId,
    owner.agentId, owner.conversationId, owner.runId, owner.relayId, owner.desktopSessionId,
    owner.pairingGeneration, invocationId])).digest("hex");
}
export function sameLocalExecutionCaller(original: RelayLocalExecutionBinding,
  current: Pick<RelayLocalExecutionOwnerV1, "instanceId" | "humanUserId" | "agentId" | "conversationId" | "relayId" | "desktopSessionId" | "pairingGeneration">,
  generation: string): boolean {
  return original.generation === generation && Object.entries(current).every(([key, value]) =>
    original.owner[key as keyof RelayLocalExecutionOwnerV1] === value);
}
