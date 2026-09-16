/**
 * D316/D574 — when the user directly selected this agent by mention, reply,
 * or an `ask_user` UI choice, the agent must not be able to silently `skip`.
 * Withhold the `skip` tool for that turn so the addressed agent is forced to
 * answer. Inferred turns keep `skip` unchanged.
 *
 * D421 Phase 6.4 — `skip` is now the sole model-facing yield tool (targetless
 * silence OR one-hop redirect via `target_handle`). The explicit-picker
 * withhold still applies: a user-picked agent must answer, so it cannot
 * yield (silently or by redirect). `skip` cannot be withheld on other turns
 * because targetless
 * silence is always valid. Redirect eligibility for the target-bearing
 * form is enforced server-side: the server authors `redirectAllowed` and
 * revalidates the request against the live roster, one-hop depth, visible
 * output, self-target, and silence/wakeable authority before any hand-off
 * (see packages/server/src/messaging/agent-redirect-handler.ts). The
 * recorder's tool-time shape/bounds/self/visible-output/duplicate guards
 * remain in `skip.ts` + `runtime/turn-context.ts`.
 */
export function withholdSkipForExplicitSelection<T extends { name: string }>(
  tools: readonly T[],
  explicitlySelected: boolean | undefined,
): T[] {
  return explicitlySelected
    ? tools.filter((t) => t.name !== "skip")
    : [...tools];
}
