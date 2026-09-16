/**
 * UI-layer affordance gating for viewers. Determines which Settings
 * controls and chat affordances are rendered based on viewer role +
 * Subject identity.
 *
 * M129 — `getViewerAffordances` is now **capability-backed**: when the
 * caller passes the viewer's `capabilities` (sourced from
 * `whoami.capabilities`), `canMutateAgentProfile` resolves from the
 * `manage_agents` Capability. The legacy role-set fallback remains so
 * older whoami payloads (pre-M129, no caps) keep working. This stays
 * ADVISORY UI-gating only — the server enforces every gate (ISSUE-M129
 * §1.1 / AR-1).
 *
 * NOTE: this is the UI affordance layer. The trust-layer Capability that
 * gates Tool invocations + server-config mutations lives in
 * `packages/trust`; the browser-safe slug union is in
 * `./capabilities.ts`. THIS file maps caps → UI rendering decisions.
 *
 * Consumed by:
 * - `apps/workbench/src/hooks/use-viewer-affordances.ts` (React hook)
 *
 * `RoleSlug` is a type alias for `ViewerRole`, single-sourced from
 * `./profile.ts`. Adding a 6th role (e.g. `co-owner`) updates one place.
 * The two names exist for documentation: `ViewerRole` in profile-projection
 * contexts; `RoleSlug` in affordance-layer contexts.
 */

import type { CapabilitySlug } from "./capabilities";
import type { ViewerRole } from "./profile";

/** Affordance-layer alias for `ViewerRole`. Same literals; distinct name per AD-2 to make affordance-layer code self-documenting. */
export type RoleSlug = ViewerRole;

/**
 * M128 — Roles that can mutate the canonical Agent Profile (voice,
 * soul, personality, default avatar, name, default model). Post-M128
 * every non-guest server Role bundles `manage_agents` per
 * `permission-model.md` §6, so the UI affordance widens to match.
 * M133 removed the dead `household`/`teammate` aliases; `stranger`/
 * `anonymous`/`guest` are denied.
 */
export const ROLES_THAT_CAN_MUTATE_AGENT_PROFILE: ReadonlySet<RoleSlug> = new Set([
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
]);

/**
 * Roles that can select the Agent's canonical voice. M128: owner-only
 * stays a stricter subset than `manage_agents` for now — voice choice
 * is presentation-shaping for the Agent's identity, not just metadata.
 */
export const ROLES_THAT_CAN_SELECT_AGENT_VOICE: ReadonlySet<RoleSlug> = new Set(["owner"]);

/** Affordance booleans returned by `getViewerAffordances`. */
export interface ViewerAffordances {
  /** May the viewer mutate the canonical Agent Profile (owner-only)? */
  readonly canMutateAgentProfile: boolean;
  /** May the viewer select the Agent's canonical voice (owner-only)? */
  readonly canSelectAgentVoice: boolean;
  /** May the viewer toggle their session-local speech playback (universal — no Subject identity required)? */
  readonly canToggleSessionSpeech: boolean;
  /**
   * NOTE: `canCustomizeOwnPresentation` used to live here. It was deleted in
   * Stack 28 AD-3 once the D201 per-viewer presentation substrate
   * (`user_agent_preferences` table, `/api/agent-presentation` route,
   * `PresentationSection` UI) was reversed. Each Human owns their own
   * Agent(s) and customizes those (`canMutateAgentProfile`); nobody
   * mutates anyone else's Agent, not even their view.
   */
}

/** Pure function. No React, no async, no DOM. Consumed by the Workbench hook. */
export function getViewerAffordances(viewer: {
  role: RoleSlug;
  userId: string | null;
  capabilities?: readonly CapabilitySlug[];
}): ViewerAffordances {
  const caps = viewer.capabilities ?? [];
  return {
    // M129 — `manage_agents` = "edit OTHERS' agents". Self-edit of your
    // own agent is handled at the call site via ownedAgents (AR-5), NOT
    // here. The role-set is a legacy fallback for pre-M129 whoami payloads
    // that lack caps.
    canMutateAgentProfile:
      caps.includes("manage_agents") || ROLES_THAT_CAN_MUTATE_AGENT_PROFILE.has(viewer.role),
    // canSelectAgentVoice stays role-based (owner-only) as the fallback.
    // Voice selection for *your own* agent is an ownership decision made
    // at the call site (ownedAgents), not a server capability (ISSUE-M129).
    canSelectAgentVoice: ROLES_THAT_CAN_SELECT_AGENT_VOICE.has(viewer.role),
    canToggleSessionSpeech: true,
  };
}
