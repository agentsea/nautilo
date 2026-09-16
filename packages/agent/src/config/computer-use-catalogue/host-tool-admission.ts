import { validate, type Schema } from "@cfworker/json-schema";
import { canonicalizeComputerUseJson, type ComputerUseJson } from "@nautilo/computer-use-contracts";
import {
  parseComputerUseHostControlMessage,
  parseComputerUseHostRejectedResult,
  projectComputerUseHostRejectionSettlement,
} from "@nautilo/computer-use-host-protocol";
import { getActiveComputerUseContractCatalogueSync } from "./runtime-catalogue";
import type { ComputerUseContractCatalogueEntry, ComputerUseContractDescriptor } from "./schema";

export type ComputerUseHostToolDefinition = Readonly<{
  name: string;
  entry: ComputerUseContractCatalogueEntry;
  impact: "read-only" | "high" | "destructive";
  tags: readonly string[];
}>;

function sameDescriptor(left: ComputerUseContractDescriptor, right: ComputerUseContractDescriptor): boolean {
  return left.contractNamespace === right.contractNamespace
    && left.contractId === right.contractId
    && left.contractVersion === right.contractVersion
    && left.schemaDigest === right.schemaDigest
    && left.effectClass === right.effectClass
    && left.replayClass === right.replayClass
    && left.authorityClass === right.authorityClass
    && left.attachmentClass === right.attachmentClass
    && left.disclosureClass === right.disclosureClass;
}

function impact(entry: ComputerUseContractCatalogueEntry): ComputerUseHostToolDefinition["impact"] {
  return entry.descriptor.effectClass === "read" ? "read-only"
    : entry.descriptor.effectClass === "sensitive" ? "destructive"
      : "high";
}

/**
 * `@cfworker/json-schema` annotates the schema object it receives while
 * validating. The active signed catalogue is authority, not validator scratch
 * space, so validation must never receive that shared object by reference.
 */
function validates(value: unknown, schema: ComputerUseContractCatalogueEntry["publicSchemas"]["input"]["jsonSchema"]): boolean {
  const privateSchema = JSON.parse(JSON.stringify(schema)) as Schema;
  return validate(value, privateSchema).valid;
}

function resultPresentationSummary(
  settlement: string,
  result: unknown,
): string {
  if (settlement === "unknown_completion") return "Computer Use may have changed state, but completion could not be confirmed. Observe current state and do not replay the action.";
  if (settlement === "cancelled") return "Computer Use was cancelled.";
  if (settlement === "revoked") return "Computer Use authority was revoked before completion.";
  if (settlement === "stale") return "Computer Use did not complete because its target was stale. Observe current state before continuing.";
  if (settlement === "fenced") return "Computer Use did not complete because its execution context changed. Observe current state before continuing.";
  if (settlement === "failed") return "Computer Use failed.";
  if (settlement !== "completed") return "Computer Use did not complete. Follow the returned recovery information.";
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const nested = typeof record["observation"] === "object"
      && record["observation"] !== null
      && !Array.isArray(record["observation"])
      ? record["observation"] as Record<string, unknown>
      : record;
    if (nested["completeness"] === "partial") {
      return "Computer Use completed with a partial result. Continue from the returned result where available.";
    }
  }
  return "Computer Use completed.";
}

/** The signed catalogue owns every runnable Host contract. */
export function activeComputerUseHostToolDefinitions(): readonly ComputerUseHostToolDefinition[] {
  return Object.freeze(getActiveComputerUseContractCatalogueSync().contracts
    .filter((entry) => entry.executionLane === "host")
    .map((entry) => Object.freeze({
      name: entry.projection.toolName, entry, impact: impact(entry),
      tags: Object.freeze(["computer", "automation", "catalogue"]),
    })));
}

export function computerUseHostToolDefinition(name: string): ComputerUseHostToolDefinition | null {
  return activeComputerUseHostToolDefinitions().find((definition) => definition.name === name) ?? null;
}

/** Signed family guidance only when this provider turn binds an exact active catalogue tool. */
export function activeComputerUseModelGuidanceForBoundTools(
  tools: readonly Readonly<{ name: string }>[],
): string {
  const catalogue = getActiveComputerUseContractCatalogueSync();
  if (catalogue.modelGuidance === undefined) return "";
  const activeNames = new Set(catalogue.contracts
    .filter((entry) => entry.executionLane === "host")
    .map((entry) => entry.projection.toolName));
  return tools.some((tool) => activeNames.has(tool.name))
    ? `\n\n${catalogue.modelGuidance}`
    : "";
}

/** Active signed descriptor + public-schema-validated JSON; Relay/Desktop stay semantic-free. */
export function resolveComputerUseHostToolRequest(
  name: string,
  args: unknown,
): Readonly<{ contract: ComputerUseContractDescriptor; arguments: Readonly<Record<string, ComputerUseJson>> }> | null {
  const definition = computerUseHostToolDefinition(name);
  if (definition === null) return null;
  try {
    if (!validates(args, definition.entry.publicSchemas.input.jsonSchema)) return null;
  } catch { return null; }
  const canonical = canonicalizeComputerUseJson(args);
  if (typeof canonical !== "object" || canonical === null || Array.isArray(canonical)) return null;
  const argumentsRecord: Record<string, ComputerUseJson> = {};
  for (const [key, value] of Object.entries(canonical)) argumentsRecord[key] = value;
  const active = getActiveComputerUseContractCatalogueSync().contracts.find((candidate) => (
    candidate.executionLane === "host" && sameDescriptor(candidate.descriptor, definition.entry.descriptor)
  ));
  return active === undefined ? null : Object.freeze({
    contract: active.descriptor,
    arguments: Object.freeze(argumentsRecord),
  });
}

/** Strip Host fences/descriptors after independently validating the signed public result schema. */
export function projectComputerUseHostToolResult(name: string, value: unknown): string | null {
  const definition = computerUseHostToolDefinition(name);
  if (definition === null) return null;
  try {
    const message = parseComputerUseHostControlMessage(value);
    if (message.kind !== "result" || !sameDescriptor(message.contract, definition.entry.descriptor)) return null;
    let brokerRejection: ReturnType<typeof parseComputerUseHostRejectedResult> | null = null;
    try { brokerRejection = parseComputerUseHostRejectedResult(message.result); } catch { /* contract result below */ }
    if (brokerRejection !== null) {
      const projectedSettlement = projectComputerUseHostRejectionSettlement(brokerRejection.reason, message.contract);
      // Host v0.1.8 used `failed` for every handler exception. Preserve wire
      // compatibility while projecting at-most-once failures conservatively;
      // newer Hosts publish `unknown_completion` directly.
      const legacyAtMostOnceFailure = brokerRejection.reason === "host_failure"
        && projectedSettlement === "unknown_completion"
        && message.settlement === "failed";
      if (message.attachment !== undefined
        || (message.settlement !== projectedSettlement && !legacyAtMostOnceFailure)) return null;
      const unknownMutation = projectedSettlement === "unknown_completion";
      return JSON.stringify({
        version: 1,
        ok: false,
        settlement: projectedSettlement,
        presentation: {
          label: definition.entry.projection.label,
          summary: unknownMutation
            ? "Computer Use Host lost completion certainty. Observe current state and do not replay the mutation."
            : brokerRejection.reason === "cancelled"
            ? "Computer Use was cancelled."
            : "Computer Use Host could not complete the request. Observe current state before continuing.",
        },
        result: brokerRejection,
      });
    }
    if (!validates(message.result, definition.entry.publicSchemas.result.jsonSchema)) return null;
    return JSON.stringify({
      version: 1,
      ok: message.settlement === "completed",
      settlement: message.settlement,
      // The signed catalogue is the sole source of human-facing Computer Use
      // labels.  No descriptor, provider fact, reference, or fence crosses
      // this projection boundary.
      presentation: {
        label: definition.entry.projection.label,
        summary: resultPresentationSummary(
          message.settlement,
          message.result,
        ),
      },
      result: message.result,
    });
  } catch { return null; }
}
