import {
  actors,
  and,
  eq,
  type DirectDatabase,
} from "@nautilo/db";
import { parseDesktopAutomationOpaqueId } from "@nautilo/types";

/**
 * The durable authority for a Human selecting a Genie is the Agent's actor
 * mirror: one `kind = agent` row whose `agentId` and `ownerId` exactly match
 * the dispatching Genie and authenticated Human. Relay receipts and graph
 * provenance are necessary but cannot substitute for this current DB fact.
 */
export interface ComputerUseAgentOwnershipInput {
  readonly userId: string;
  readonly agentId: string;
}

interface ComputerUseAgentOwnershipRow {
  readonly ownerId: unknown;
  readonly agentId: unknown;
  readonly kind: unknown;
}

/**
 * Pure, fail-closed row evaluation. More than one mirror is an ownership
 * anomaly, not a reason to choose a row by order.
 */
export function hasExactComputerUseAgentOwnership(
  input: ComputerUseAgentOwnershipInput,
  rows: readonly ComputerUseAgentOwnershipRow[],
): boolean {
  const userId = parseDesktopAutomationOpaqueId(input.userId);
  const agentId = parseDesktopAutomationOpaqueId(input.agentId);
  if (userId === null || agentId === null || rows.length !== 1) return false;

  const row = rows[0]!;
  return row.kind === "agent"
    && row.ownerId === userId
    && row.agentId === agentId;
}

/**
 * Build a server-owned current-ownership check. It deliberately performs no
 * caching, TTL, retry, or list limit: every authority decision reads the
 * canonical Agent actor row and fails closed on an unavailable DB.
 */
export function createComputerUseAgentOwnershipAuthorizer(
  db: DirectDatabase,
): (input: ComputerUseAgentOwnershipInput) => Promise<boolean> {
  return async (input) => {
    const agentId = parseDesktopAutomationOpaqueId(input.agentId);
    const userId = parseDesktopAutomationOpaqueId(input.userId);
    if (agentId === null || userId === null) return false;

    try {
      const rows = await db
        .select({
          ownerId: actors.ownerId,
          agentId: actors.agentId,
          kind: actors.kind,
        })
        .from(actors)
        .where(and(eq(actors.kind, "agent"), eq(actors.agentId, agentId)));
      return hasExactComputerUseAgentOwnership({ userId, agentId }, rows);
    } catch {
      return false;
    }
  };
}
