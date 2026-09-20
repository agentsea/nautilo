import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  computerUseHostToolDefinition,
} from "../../config/computer-use-catalogue/host-tool-admission";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";
import { z } from "zod";
import { nativeDecisionPlanSchema } from "../../graph/native-decision-plan";
import { resolveBrowserDecisionModel } from "../browser/browser-snapshot";

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
    ? resolveBrowserDecisionModel(context) : null;
  const schema = model ? withDecisionPlan(definition.entry.publicSchemas.input.jsonSchema) : definition.entry.publicSchemas.input.jsonSchema;
  return new DynamicStructuredTool({
    name,
    description: `${definition.entry.projection.modelDescription} ${definition.entry.projection.argumentsSummary} Available only through a live, authorized Computer Use desktop connection.${model ? ` ${model.displayName} can handle routine native steps. After selecting the intended window, use one standalone window_state call with decisionPlan (goal, exact named values, constraints, optional ordinary computer_do action templates) and no selector. The runtime offers fresh controls without a role whitelist and executes through ordinary Computer Use authority. Omit actions for observed clicks; exact arguments for keys, menus and other operations belong in actions. No pixels or arguments are inferred from prose. Jev returns to you for visual interpretation, ambiguity, missing inputs, uncertain effects or final verification. Without decisionPlan this remains a read-only observation; all ordinary tools remain available without Jev.` : ""}`,
    schema: modelInputSchema(schema) as JsonSchema7Type,
    func: () => Promise.reject(new Error(
      `${name} is a Computer Use Host tool — execution goes through the context-bound generic Host protocol, not direct invocation.`,
    )),
  });
}
