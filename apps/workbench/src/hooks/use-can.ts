import type { CapabilitySlug } from "@nautilo/types";

import { useAuth } from "./use-auth";

/**
 * M129 — cosmetic UI gating only. Returns a `can(cap)` predicate that is
 * true when the viewer holds `cap` (from `whoami.capabilities`).
 *
 * NEVER the sole gate on a sensitive action — the server enforces every
 * gate (ISSUE-M129 §1.1 / AR-1). Use this to hide/disable controls that
 * would otherwise 403. A missing/empty capability set (guest, stale boot)
 * behaves as "no extra privileges" (AR-6).
 */
export function useCan(): (cap: CapabilitySlug) => boolean {
  const { viewer } = useAuth();
  return (cap) => viewer.capabilities?.includes(cap) === true;
}
