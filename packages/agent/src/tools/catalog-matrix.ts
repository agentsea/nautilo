import type {
  ToolApprovalMode,
  ToolCatalogEntry,
  ToolCategory,
  ToolExposure,
} from "@nautilo/types";
import {
  TOOL_EXPOSURE_MANIFEST,
  type ToolExposureManifest,
  type ToolFamilyName,
} from "./exposure/manifest";

/** D556 removed this as an active capability; it may exist only in migration fixtures. */
const RETIRED_HIGH_IMPACT_GATE = "use_high_impact_tools";

export interface ToolCatalogMatrixRow {
  name: string;
  category: ToolCategory;
  discoveryCategories: readonly ToolCategory[];
  family: ToolFamilyName | null;
  source: ToolCatalogEntry["source"];
  exposure: ToolExposure;
  executor: ToolCatalogEntry["executor"];
  impact: ToolCatalogEntry["impact"];
  approval: ToolApprovalMode | NonNullable<ToolCatalogEntry["approvalLevel"]> | "required" | "none";
  requiredCapabilities: readonly string[];
  conditionalCapabilities: readonly string[];
  relayCapabilities: readonly string[];
  activeRetiredGates: readonly string[];
}

function familyByToolName(manifest: ToolExposureManifest): ReadonlyMap<string, ToolFamilyName> {
  return new Map(
    Object.entries(manifest.families).flatMap(([family, names]) =>
      names.map((name) => [name, family as ToolFamilyName] as const),
    ),
  );
}

/**
 * Derive the exhaustive review matrix from the live catalogue snapshot.
 * This is a projection, never a second registration or authorization source.
 */
export function buildToolCatalogMatrix(
  entries: readonly ToolCatalogEntry[],
  manifest: ToolExposureManifest = TOOL_EXPOSURE_MANIFEST,
): readonly ToolCatalogMatrixRow[] {
  const familyByName = familyByToolName(manifest);
  return [...entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      category: entry.category,
      discoveryCategories: entry.discoveryCategories ?? [],
      family: familyByName.get(entry.name) ?? null,
      source: entry.source,
      exposure: entry.exposure ?? "discoverable",
      executor: entry.executor,
      impact: entry.impact,
      approval: entry.approvalMode ??
        entry.approvalLevel ??
        (entry.requiresApproval ? "required" : "none"),
      requiredCapabilities: entry.requiredCapabilities,
      conditionalCapabilities: entry.conditionalCapabilities ?? [],
      relayCapabilities: entry.relayCapabilities ?? [],
      activeRetiredGates: [
        ...entry.requiredCapabilities,
        ...(entry.conditionalCapabilities ?? []),
      ].filter((capability) => capability === RETIRED_HIGH_IMPACT_GATE),
    }));
}
