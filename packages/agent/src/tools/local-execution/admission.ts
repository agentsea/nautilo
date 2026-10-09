import { RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION } from "@nautilo/relay";
import { toRelayNetworkPolicy } from "../../relay/sandbox-profile-builder";
import { resolveServerPosture } from "@nautilo/config";
import { parseRelayLocalExecutionCapability, LOCAL_EXECUTION_MAX_IDENTITIES, RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION } from "@nautilo/relay";
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

/** Build or revalidate a checkpoint pin from a live Task source and the exact
 * current transport. A persisted pin cannot select a replacement generation. */
export function bindDelegatedLocalExecution(input: {
  registry: import("../../nodes/tools").ToolRelayRegistry;
  source: import("../../runtime/local-execution-delegation").DelegatedLocalExecutionAdmission;
  state: Pick<import("../../agent/state").NautiloState, "currentTaskId" | "currentTaskRunId" | "agentId" | "roomId" | "currentThreadId" | "langgraphThreadId" | "causalHumanUserId" | "trustedExecutionEntrypoint">;
  invocationId: string;
  operation: RelayLocalExecutionBinding["operation"];
  executionId?: string;
  previous?: import("@nautilo/relay").RelayLocalExecutionBindingV4;
}): import("@nautilo/relay").RelayLocalExecutionBindingV4 | null {
  const { registry, source, state } = input;
  const { delegation } = source;
  const relayId = delegation.target.relayId;
  const caps = registry.getCapabilities(relayId);
  const capability = parseRelayLocalExecutionCapability(caps?.localExecution);
  const localNetworkPolicy = toRelayNetworkPolicy(resolveServerPosture().localNetworkPolicy ?? { mode: "host" });
  if (capability?.localNetworkPolicy !== true
    || (registry.getProtocolVersion?.(relayId) ?? 0) < RELAY_LOCAL_EXECUTION_NETWORK_POLICY_PROTOCOL_VERSION) return null;
  const desktopSessionId = registry.getDesktopSessionId?.(relayId);
  const pairingGeneration = registry.getLocalExecutionPairingGeneration?.(relayId);
  if (!capability || capability.capacity > LOCAL_EXECUTION_MAX_IDENTITIES || !desktopSessionId || !pairingGeneration
    || source.signal.aborted || caps?.profile !== "desktop-agent" || caps.canExecuteLocal !== true || caps.canDelegateLocalExecution !== true
    || (registry.getProtocolVersion?.(relayId) ?? 0) < RELAY_DELEGATED_LOCAL_EXECUTION_PROTOCOL_VERSION
    || registry.getUserId?.(relayId) !== delegation.humanUserId
    || registry.getPairingGeneration?.(relayId) !== delegation.target.pairingGeneration
    || source.taskId !== state.currentTaskId || source.taskRunId !== state.currentTaskRunId
    || delegation.agentId !== state.agentId || delegation.humanUserId !== state.causalHumanUserId
    || state.trustedExecutionEntrypoint !== "background.task") return null;
  const owner: RelayLocalExecutionOwnerV1 = { instanceId: delegation.target.instanceId,
    humanUserId: delegation.humanUserId, agentId: delegation.agentId, runId: source.taskRunId,
    conversationId: state.currentThreadId || state.langgraphThreadId,
    relayId, desktopSessionId, pairingGeneration, serverBindingId: `instance:${delegation.target.instanceId}`,
    profileId: delegation.profile?.id ?? null, profileRevision: delegation.profile?.revision ?? null,
    grantIds: [delegation.projectGrantId], grantRevision: null,
    protectedPolicyVersion: caps.workstationProfileSnapshot?.protectedPolicyVersion ?? caps.basicExecution?.protectedPolicyVersion ?? null };
  const retained = input.operation === "start" ? undefined : registry.getLocalExecutionBinding?.(relayId, input.executionId ?? "");
  const original = input.previous ?? retained;
  if (original) {
    if ((input.operation === "start" || input.operation === "input")
      && localNetworkPolicy.mode !== "host"
      && JSON.stringify(original.localNetworkPolicy) !== JSON.stringify(localNetworkPolicy)) return null;
    if (original.version !== 4 || original.generation !== capability.generation
      || original.authority.taskId !== source.taskId || original.authority.taskRunId !== source.taskRunId
      || original.owner.runId !== owner.runId || original.authority.roomId !== (state.roomId || delegation.sourceRoomId)
      || JSON.stringify(original.authority.delegation) !== JSON.stringify(delegation)
      || !sameLocalExecutionCaller(original, { instanceId: owner.instanceId, humanUserId: owner.humanUserId,
        agentId: owner.agentId, conversationId: owner.conversationId, relayId, desktopSessionId, pairingGeneration }, capability.generation)
      || (input.operation === "start" && original.invocationId !== input.invocationId)
      || (input.operation !== "start" && original.executionId !== input.executionId)) return null;
    return { ...original, operation: input.operation, invocationId: input.invocationId };
  }
  if (input.operation !== "start" || !owner.conversationId) return null;
  return { ...(capability.localNetworkPolicy === true ? { localNetworkPolicy } : {}), version: 4, generation: capability.generation, invocationId: input.invocationId,
    executionId: localExecutionId(capability.generation, owner, input.invocationId), operation: "start", owner,
    authority: { kind: "delegated", taskId: source.taskId, taskRunId: source.taskRunId,
      roomId: state.roomId || delegation.sourceRoomId, delegation: structuredClone(delegation) } };
}
