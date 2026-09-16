import type { StructuredTool } from "@langchain/core/tools";
import { isInteropZodSchema } from "@langchain/core/utils/types";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

export type ToolExposureExclusionReason =
  | "disabled"
  | "unhealthy"
  | "namespace_unreadable"
  | "policy_forbidden"
  | "relay_unavailable"
  | "relay_capability_missing"
  | "not_selected"
  | "whitelist_excluded"
  | "model_capability_missing"
  | "other";

export interface ToolExposureTelemetry {
  /** Tools registered before authorization or progressive exposure filtering. */
  readonly registeredCatalogTools: number;
  /** Tools admitted by normal authorization, health, namespace, and relay gates. */
  readonly eligibleTools: number;
  /** Eligible tools marked as always-on core. */
  readonly coreTools: number;
  /** Eligible tools included by the current intent pack. */
  readonly intentPackTools: number;
  /** Eligible tools included by explicit or automatic activation. */
  readonly activatedTools: number;
  /** Eligible selected tools with a live cross-turn activation lease. */
  readonly retainedTools: number;
  /** Tool descriptions embedded in the system prompt for this turn. */
  readonly promptSchemas: number;
  /** Tool schemas passed to the provider's bindTools call for this turn. */
  readonly providerSchemas: number;
  /** Aggregate description size; no descriptions are retained. */
  readonly descriptionChars: number;
  readonly descriptionEstimatedTokens: number;
  /** Aggregate serialized JSON Schema size; no schemas are retained. */
  readonly serializedSchemaChars: number;
  readonly serializedSchemaEstimatedTokens: number;
  /** Stable aggregate exclusion categories, without tool or namespace identifiers. */
  readonly exclusionReasons: Readonly<Partial<Record<ToolExposureExclusionReason, number>>>;
}

export interface ToolExposureTelemetryInput {
  readonly registeredCatalogTools: number;
  readonly eligibleEntries: readonly { name: string; exposure?: string | undefined }[];
  readonly exclusionReasons: readonly string[];
  readonly activatedToolNames?: readonly string[];
  /** Cross-turn lease metadata; only its names participate in this aggregate. */
  readonly activatedToolLeases?: readonly { name: string }[];
  readonly intentPackToolNames?: readonly string[];
  readonly tools: readonly StructuredTool[];
}

function serializedSchemaChars(tool: StructuredTool): number {
  try {
    const schema = isInteropZodSchema(tool.schema) ? toJsonSchema(tool.schema) : tool.schema;
    return JSON.stringify(schema)?.length ?? 0;
  } catch {
    // Observability must never alter tool construction or binding.
    return 0;
  }
}

function classifyToolExposureExclusion(reason: string): ToolExposureExclusionReason {
  if (reason === "disabled by owner") return "disabled";
  if (reason.startsWith("health=")) return "unhealthy";
  if (reason.startsWith("namespace ")) return "namespace_unreadable";
  if (reason === "forbidden by actor toolPolicy") return "policy_forbidden";
  if (reason === "requires relay but no relay connected") return "relay_unavailable";
  if (reason.startsWith("requires relay capability ")) return "relay_capability_missing";
  if (reason === "not selected for progressive exposure") return "not_selected";
  if (reason === "not in explicit tool whitelist") return "whitelist_excluded";
  if (reason.startsWith("requires model capability ")) return "model_capability_missing";
  return "other";
}

/**
 * Aggregate-only D419 progressive exposure telemetry. Inputs may contain
 * catalog metadata, but the result intentionally retains neither tool names,
 * user text, tool arguments, credentials, nor namespace identifiers.
 */
export function measureProgressiveToolExposure(
  input: ToolExposureTelemetryInput,
): ToolExposureTelemetry {
  const eligibleNames = new Set(input.eligibleEntries.map((entry) => entry.name));
  const countEligibleSelected = (names: readonly string[] | undefined) =>
    new Set((names ?? []).filter((name) => eligibleNames.has(name))).size;
  const selectedLeaseNames = new Set(
    (input.activatedToolLeases ?? [])
      .map((lease) => lease.name)
      .filter((name) => typeof name === "string"),
  );
  const retainedTools = new Set(
    (input.activatedToolNames ?? []).filter(
      (name) => eligibleNames.has(name) && selectedLeaseNames.has(name),
    ),
  ).size;
  const exclusionReasons: Partial<Record<ToolExposureExclusionReason, number>> = {};
  let descriptionChars = 0;
  let serializedSchemaCharsTotal = 0;

  for (const reason of input.exclusionReasons) {
    const category = classifyToolExposureExclusion(reason);
    exclusionReasons[category] = (exclusionReasons[category] ?? 0) + 1;
  }
  for (const tool of input.tools) {
    descriptionChars += tool.description.length;
    serializedSchemaCharsTotal += serializedSchemaChars(tool);
  }

  return Object.freeze({
    registeredCatalogTools: input.registeredCatalogTools,
    eligibleTools: eligibleNames.size,
    coreTools: input.eligibleEntries.filter((entry) => entry.exposure === "core").length,
    intentPackTools: countEligibleSelected(input.intentPackToolNames),
    activatedTools: countEligibleSelected(input.activatedToolNames),
    retainedTools,
    promptSchemas: input.tools.length,
    providerSchemas: input.tools.length,
    descriptionChars,
    descriptionEstimatedTokens: Math.ceil(descriptionChars / 4),
    serializedSchemaChars: serializedSchemaCharsTotal,
    serializedSchemaEstimatedTokens: Math.ceil(serializedSchemaCharsTotal / 4),
    exclusionReasons: Object.freeze(exclusionReasons),
  });
}

/** Keep intent telemetry aligned with the projection actually bound this step. */
export function selectIntentPackToolsForTelemetry(
  intentPackToolNames: readonly string[],
  activatedToolNames: readonly string[],
): string[] {
  const selectedNames = new Set(activatedToolNames);
  return intentPackToolNames.filter((name) => selectedNames.has(name));
}
