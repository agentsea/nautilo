/**
 * D091 Phase 1 — `useOrb` hook.
 *
 * A tiny wrapper around `useState` that gives the wizard a named
 * API for changing the orb's visual state. Exists so screens can
 * call `setOrbState("compiling")` instead of threading the raw
 * setState through props — semantically clearer and lets us add
 * side effects (analytics, a11y announcements) later without
 * touching every caller.
 *
 * Phase 2 expectations: per-screen defaults map to an OrbState:
 *   Welcome     → "idle"
 *   Language    → "idle"
 *   Keys        → "idle"
 *   Privacy     → "idle"
 *   WorkLife    → "idle"
 *   Owner       → "idle"
 *   Personality → "idle"
 *   Compiling   → "compiling"
 *   Avatar      → "idle"
 *   Name        → "idle"
 *   Voice       → "speaking" (during preview playback)
 *   Reveal      → "speaking" → "hidden" (fades out after greeting)
 */

import { useCallback, useState } from "react";
import type { OrbState } from "../types";

export interface UseOrbReturn {
  orbState: OrbState;
  setOrbState: (next: OrbState) => void;
}

export function useOrb(initial: OrbState = "idle"): UseOrbReturn {
  const [orbState, setState] = useState<OrbState>(initial);
  const setOrbState = useCallback((next: OrbState) => {
    setState(next);
  }, []);
  return { orbState, setOrbState };
}
