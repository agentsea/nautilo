/**
 * useViewerAffordances — workbench React hook for UI affordance gating.
 *
 * Thin wrapper over `getViewerAffordances` from `@nautilo/types` per
 * D201 / Stack 26 architectural decisions AD-1 (UI affordance gating
 * is distinct from trust-layer Capability) and AD-2 (role-slug-based,
 * not role-string-hardcoded).
 *
 * Usage:
 *
 *   const { canMutateAgentProfile, canToggleSessionSpeech } = useViewerAffordances();
 *   if (canMutateAgentProfile) { ... show owner-only controls ... }
 *
 * NOTE: this is NOT a trust-layer authorization hook. RLS + server-side
 * Capability checks are the actual security boundary. This hook only
 * decides which UI controls to render, not what the server allows.
 */

import { useMemo } from "react";
import { getViewerAffordances, type ViewerAffordances } from "@nautilo/types";

import { useAuth } from "./use-auth";

export function useViewerAffordances(): ViewerAffordances {
  const auth = useAuth();
  const role = auth.viewer.role;
  const userId = auth.viewer.sessionUserId;
  // M129 — capability-backed: `canMutateAgentProfile` resolves from
  // `manage_agents` when caps are present (role-set is a legacy fallback).
  const capabilities = auth.viewer.capabilities;

  return useMemo(
    () => getViewerAffordances({ role, userId, capabilities }),
    [role, userId, capabilities],
  );
}
