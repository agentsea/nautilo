import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  computerUseHostToolDefinition,
} from "../../config/computer-use-catalogue/host-tool-admission";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";

/**
 * Model providers do not share one regex dialect. In particular, OpenAI
 * rejects otherwise valid JSON-Schema patterns that use Unicode properties.
 * The signed catalogue remains the exact admission authority, so the
 * model-facing projection may safely widen only regex constraints: every
 * emitted call is still checked against the untouched signed schema before it
 * can cross the Host boundary.
 */
function modelInputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(modelInputSchema);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, child]) => key !== "pattern"
      || typeof child !== "string"
      || !/\\[pP]\{/u.test(child))
    .map(([key, child]) => [key, modelInputSchema(child)]));
}

/** Model-facing wrapper only. Execution is always the generic bound Host lane. */
export function createComputerHostContractTool(name: string) {
  const definition = computerUseHostToolDefinition(name);
  if (definition === null) throw new Error("Computer Use Host catalogue entry is unavailable");
  return new DynamicStructuredTool({
    name,
    description: `${definition.entry.projection.modelDescription} ${definition.entry.projection.argumentsSummary} Available only through a live, authorized Computer Use desktop connection.`,
    schema: modelInputSchema(definition.entry.publicSchemas.input.jsonSchema) as JsonSchema7Type,
    func: () => Promise.reject(new Error(
      `${name} is a Computer Use Host tool — execution goes through the context-bound generic Host protocol, not direct invocation.`,
    )),
  });
}
