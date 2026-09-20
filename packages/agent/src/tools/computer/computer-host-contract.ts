import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  computerUseHostToolDefinition,
} from "../../config/computer-use-catalogue/host-tool-admission";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";
import { z } from "zod";
import { nativeDecisionPlanSchema } from "../../graph/native-decision-plan";
import { resolveNativeDecisionModel } from "../../config/native-decision-model";

function exposesControlCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(exposesControlCollection);
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const properties = record["properties"] as Record<string, unknown> | undefined;
  return properties?.["controlCollection"] !== undefined || Object.values(record).some(exposesControlCollection);
}

function withDecisionPlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withDecisionPlan);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const properties = record["properties"] as Record<string, unknown> | undefined;
  if ((properties?.["operation"] as { const?: unknown } | undefined)?.const === "window_state") {
    return { ...record, properties: { ...properties, decisionPlan: z.toJSONSchema(nativeDecisionPlanSchema, { io: "input" }) } };
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, withDecisionPlan(child)]));
}

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
export function createComputerHostContractTool(name: string, context?: { turnId?: string | undefined; fullEncryptionOnly?: boolean | undefined }) {
  const definition = computerUseHostToolDefinition(name);
  if (definition === null) throw new Error("Computer Use Host catalogue entry is unavailable");
  const model = name === "computer_observe" && exposesControlCollection(definition.entry.publicSchemas.result.jsonSchema)
    ? resolveNativeDecisionModel(context) : null;
  const schema = model ? withDecisionPlan(definition.entry.publicSchemas.input.jsonSchema) : definition.entry.publicSchemas.input.jsonSchema;
  return new DynamicStructuredTool({
    name,
    description: `${definition.entry.projection.modelDescription} ${definition.entry.projection.argumentsSummary} Available only through a live, authorized Computer Use desktop connection.${model ? ` Delegate routine native control selection to ${model.displayName}: after selecting the intended window, use one standalone window_state call with decisionPlan and no selector rather than choosing each control in separate model turns. Supply the goal, constraints and exact composed values once; use actions to specify intended ordinary computer_do operations. Omitted actions offer observed clicks plus insertion/replacement of supplied values; explicit actions restrict the segment, including an empty read-only list. For type_text/set_value templates, omit text/value to bind named values. Exact keys, menus and other arguments belong in actions. The runtime observes after actions and uses ordinary Computer Use authority, with no role whitelist or invented pixels/arguments. Keep composition and visual interpretation here; the decision loop returns for ambiguity, missing inputs, uncertain effects or final verification. Without decisionPlan this remains read-only; all ordinary tools remain available without a decision model.` : ""}`,
    schema: modelInputSchema(schema) as JsonSchema7Type,
    func: () => Promise.reject(new Error(
      `${name} is a Computer Use Host tool — execution goes through the context-bound generic Host protocol, not direct invocation.`,
    )),
  });
}
