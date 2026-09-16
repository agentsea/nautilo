/** The three selection axes. */
export type SelectionAxis = "privacy" | "smart" | "cheap";

/**
 * A combo: optionally qualify by a `band` axis (the "X" in "X but Y"), then
 * optimize the `objective` axis. `band` omitted = a single "best in objective".
 * Direction is implied by the axis: privacy↑, smart↑, cheap↓ (lower cost).
 * `absoluteFloors` is a Tier-2-only override (power users); profiles never set it.
 */
export interface ComboSpec {
  // Optionals explicitly admit `undefined` so a Zod-inferred shape
  // (`.optional()` → `T | undefined`) is assignable under
  // `exactOptionalPropertyTypes`. The resolver only ever reads these.
  band?: SelectionAxis | undefined;
  objective: SelectionAxis;
  absoluteFloors?:
    | { privacy?: number | undefined; intelligenceRank?: number | undefined; maxCost?: number | undefined }
    | undefined;
}

export const SELECTION_PROFILES = [
  "balanced",
  "most_private",
  "smartest",
  "cheapest",
  "private_cheap",
  "private_smart",
  "cheap_private",
  "cheap_smart",
  "smart_private",
  "smart_cheap",
] as const;
export type SelectionProfile = (typeof SELECTION_PROFILES)[number];
