import { isComputerUseOpaqueId } from "./contracts.ts";

/** A server-projected Agent that the authenticated Human currently owns. */
export interface ComputerUseOwnedAgent {
  readonly agentId: string;
  readonly displayName: string;
  readonly handle: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept the complete owner projection exactly as the server emitted it.
 * There is deliberately no local Agent-count limit or positional preference:
 * a Human must choose one of these current server-owned identities.
 */
export function parseComputerUseOwnedAgents(value: unknown): readonly ComputerUseOwnedAgent[] | null {
  if (!isRecord(value) || value["viewerRole"] !== "owner" || !Array.isArray(value["ownedAgents"])) {
    return null;
  }
  const agents: ComputerUseOwnedAgent[] = [];
  const seenAgentIds = new Set<string>();
  for (const raw of value["ownedAgents"]) {
    if (!isRecord(raw)
      || !isComputerUseOpaqueId(raw["agentId"])
      || typeof raw["displayName"] !== "string"
      || typeof raw["handle"] !== "string"
      || seenAgentIds.has(raw["agentId"])) {
      return null;
    }
    seenAgentIds.add(raw["agentId"]);
    agents.push({
      agentId: raw["agentId"],
      displayName: raw["displayName"],
      handle: raw["handle"],
    });
  }
  return agents;
}

/** Returns the exact current ownership entry, never a positional fallback. */
export function selectComputerUseOwnedAgent(
  agents: readonly ComputerUseOwnedAgent[],
  requestedAgentId: unknown,
): ComputerUseOwnedAgent | null {
  if (!isComputerUseOpaqueId(requestedAgentId)) return null;
  return agents.find((agent) => agent.agentId === requestedAgentId) ?? null;
}
