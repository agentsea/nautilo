import type { CapabilitySlug } from "@nautilo/types";

type ViewerCapabilitySource = Readonly<{
  capabilities: readonly CapabilitySlug[];
}>;

/** Presentation-only effective-Capability check. Server admission remains authoritative. */
export function viewerCan(
  viewer: ViewerCapabilitySource | null | undefined,
  capability: CapabilitySlug,
): boolean {
  return viewer?.capabilities.includes(capability) === true;
}
