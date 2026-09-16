/**
 * D141 P2 / LD-1 — resolve a user's effective fallback policy at
 * invocation time.
 *
 * Precedence (highest first):
 *   1. Per-agent override (`agents.customization.fallback.*`) when an
 *      agentId is supplied AND the agent has the field defined.
 *   2. Per-user default (`profiles.fallback_enabled` /
 *      `profiles.fallback_chain`).
 *   3. Hard fallback to `{ enabled: false, chain: [] }`.
 *
 * The per-agent envelope (`AgentCustomization`) is owned jointly with
 * D140 (customize-in-place); we extend the shape, never redefine it.
 *
 * Reader-only. Writes go through:
 *   - `apps/workbench` chain-editor → server `PATCH /api/profile/fallback`
 *     for per-user.
 *   - server `PATCH /api/agents/:id/customization` for per-agent
 *     (coordinated with D140's writer when D140 lands).
 *
 * Called from `invokeChatModelWithFallback` for configured per-error hops.
 * Internal roles resolve their own shared candidate policy and do not consult
 * a user's foreground fallback chain.
 *
 * See ISSUE-D141 §"Locked Decisions" §LD-1.
 */

import {
  agents,
  agentDb as db,
  eq,
  getCachedServerModelConfigRow,
  kickServerModelConfigRefresh,
  profiles,
} from "@nautilo/db";
import type { AgentCustomization } from "@nautilo/db";

/** Effective fallback policy resolved for one (user, agent?) pair. */
export interface ResolvedFallbackPolicy {
  /** Whether to fall back on error. False = primary fails → user sees error. */
  enabled: boolean;
  /**
   * Ordered list of catalog model IDs to attempt in sequence on error.
   * Empty array is allowed; behaves like `enabled: false` for the
   * purposes of `invokeChatModelWithFallback` (nothing to fall back to).
   */
  chain: string[];
}

const HARD_DEFAULT: ResolvedFallbackPolicy = { enabled: false, chain: [] };

/**
 * Resolve the policy. Accepts a null/undefined agentId to mean "skip
 * the per-agent layer" (system tasks pass this; the chat path passes
 * the active agent's id).
 *
 * Failure mode: on DB error (connection lost, schema mismatch, etc.)
 * returns the hard default. This is honest under LD-4 — a corrupt DB
 * means we shouldn't silently route to anyone's prior chain.
 */
export async function resolveFallbackPolicy(
  userId: string,
  agentId?: string | null,
): Promise<ResolvedFallbackPolicy> {
  if (!userId.trim()) return HARD_DEFAULT;

  let userPolicy: ResolvedFallbackPolicy | null = null;
  try {
    const profileRows = await db
      .select({
        fallbackEnabled: profiles.fallbackEnabled,
        fallbackChain: profiles.fallbackChain,
      })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    const profile = profileRows[0];
    if (profile) {
      userPolicy = {
        enabled: profile.fallbackEnabled,
        chain: profile.fallbackChain,
      };
    }
  } catch {
    return HARD_DEFAULT;
  }

  let agentOverride: AgentCustomization["fallback"] | undefined;
  if (agentId && agentId.trim()) {
    try {
      const agentRows = await db
        .select({ customization: agents.customization })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      agentOverride = agentRows[0]?.customization?.fallback;
    } catch {
      // Per-agent read failure: silently fall through to user policy.
      // Less destructive than HARD_DEFAULT — the user's own preference
      // is still consulted.
      agentOverride = undefined;
    }
  }

  // D281 — server-wide fallback chain (DB-backed, live via cache) sits beneath
  // per-user, above the hard default. Precedence: agent override > user policy
  // > server default > hard default. A non-empty server chain implies enabled.
  kickServerModelConfigRefresh();
  const serverChain = getCachedServerModelConfigRow()?.fallbackChain ?? null;
  const serverPolicy: ResolvedFallbackPolicy | null =
    serverChain && serverChain.length > 0
      ? { enabled: true, chain: serverChain }
      : null;

  const baseline = userPolicy ?? serverPolicy ?? HARD_DEFAULT;
  const enabled = agentOverride?.enabled ?? baseline.enabled;
  const chain = agentOverride?.chain ?? baseline.chain;

  return { enabled, chain };
}
