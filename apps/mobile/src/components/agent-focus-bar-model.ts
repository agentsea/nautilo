import type { RoomMemberDto } from "@nautilo/types";

export function agentOwnerLabel(agent: RoomMemberDto): string | null {
  const ownerName = agent.agentOwnerDisplayName?.trim();
  if (ownerName) return ownerName;
  const ownerHandle = agent.agentOwnerHandle?.trim();
  if (ownerHandle) return `@${ownerHandle}`;
  const agentHandle = agent.handle?.trim();
  return agentHandle ? `@${agentHandle}` : null;
}

export function agentFinderMetadata(agent: RoomMemberDto): string | null {
  const owner = agentOwnerLabel(agent);
  const handle = agent.handle?.trim();
  if (!handle) return owner;
  const renderedHandle = `@${handle}`;
  return owner && owner !== renderedHandle ? `${owner} · ${renderedHandle}` : renderedHandle;
}

export function agentRailSecondaryLabel(
  agent: RoomMemberDto,
  agents: readonly RoomMemberDto[],
): string | null {
  const owner = agentOwnerLabel(agent);
  if (!owner) return null;
  const identityRepeats = agents.some((candidate) =>
    candidate.actorId !== agent.actorId &&
    candidate.displayName.trim().toLocaleLowerCase() === agent.displayName.trim().toLocaleLowerCase() &&
    agentOwnerLabel(candidate)?.toLocaleLowerCase() === owner.toLocaleLowerCase(),
  );
  return identityRepeats ? agentFinderMetadata(agent) : owner;
}

export function filterAgentFinderEntries(
  agents: readonly RoomMemberDto[],
  query: string,
): RoomMemberDto[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...agents];
  return agents.filter((agent) =>
    [
      agent.displayName,
      agent.handle,
      agent.agentOwnerDisplayName,
      agent.agentOwnerHandle,
    ].some((value) => value?.toLocaleLowerCase().includes(normalized)),
  );
}

export function orderAgentsByRecentUse(
  agents: readonly RoomMemberDto[],
  recentActorIds: readonly string[],
): RoomMemberDto[] {
  if (recentActorIds.length === 0) return [...agents];
  const recentRank = new Map(recentActorIds.map((actorId, index) => [actorId, index]));
  return agents
    .map((agent, originalIndex) => ({ agent, originalIndex }))
    .sort((left, right) => {
      const leftRank = recentRank.get(left.agent.actorId) ?? Number.POSITIVE_INFINITY;
      const rightRank = recentRank.get(right.agent.actorId) ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || left.originalIndex - right.originalIndex;
    })
    .map(({ agent }) => agent);
}

export function agentRailOverflows(contentWidth: number, availableWidth: number): boolean {
  return contentWidth > availableWidth;
}
