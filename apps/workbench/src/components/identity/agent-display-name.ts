export interface AgentDisplayNameInput {
  readonly displayName: string;
  /**
   * The Agent's own `handle` (e.g. `jeannie`), unique per Server. Used as
   * the collision suffix when two visible Agents share a `displayName`.
   * Matches the `handle` field on `OwnedAgentSummary` from `@nautilo/types`.
   */
  readonly handle?: string;
}

/**
 * Render-layer disambiguation for Agent display names (Stack 28 AD-3).
 *
 * For a single Agent in scope the function returns the plain `displayName`.
 * When two or more Agents share the same `displayName` (multi-Agent
 * surface, future), it returns `displayName (@handle)` Discord-style.
 *
 * Agents on the same Server are guaranteed unique by `handle`, so the
 * suffix always disambiguates without revealing owner identity (handles
 * are operator-visible already).
 *
 * In M1 (single-Agent-per-Server) the collision branch is unreachable;
 * the helper is wired for the future multi-Agent surface.
 */
export function formatAgentDisplayName(
  agent: AgentDisplayNameInput,
  otherAgentsInScope: ReadonlyArray<{ displayName: string }>,
): string {
  const sameNameCount = otherAgentsInScope.filter(
    (a) => a.displayName === agent.displayName,
  ).length;
  if (sameNameCount <= 1) return agent.displayName;
  if (agent.handle) return `${agent.displayName} (@${agent.handle})`;
  return agent.displayName;
}
