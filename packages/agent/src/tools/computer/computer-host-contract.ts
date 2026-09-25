import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  computerUseHostToolDefinition,
} from "../../config/computer-use-catalogue/host-tool-admission";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";
import { z } from "zod";
import { nativeDecisionPlanSchema } from "../../graph/native-decision-plan";
import { resolveNativeDecisionModel } from "../../config/native-decision-model";
import { nativeHistoryInputSchema, nativeRoomHistoryInputSchema } from "./native-history";

function exposesControlCollection(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(exposesControlCollection);
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  const properties = record["properties"] as Record<string, unknown> | undefined;
  return properties?.["controlCollection"] !== undefined || Object.values(record).some(exposesControlCollection);
}

function withDecisionPlan(value: unknown, workflow: boolean): unknown {
  if (Array.isArray(value)) return value.map(child => withDecisionPlan(child, workflow));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const properties = record["properties"] as Record<string, unknown> | undefined;
  if (typeof (properties?.["operation"] as { const?: unknown } | undefined)?.const === "string") {
    const window = (properties!["operation"] as { const?: unknown }).const === "window_state";
    if (window || workflow) return { ...record, properties: { ...properties, decisionPlan: z.toJSONSchema(
      workflow ? (window ? nativeDecisionPlanSchema : nativeDecisionPlanSchema.extend({ execution: z.literal("workflow") }))
        : nativeDecisionPlanSchema.omit({ execution: true }), { io: "input" }) } };
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, withDecisionPlan(child, workflow)]));
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

/** Model-facing wrapper. Fresh operations use the Host; retained evidence reads stay local. */
export function createComputerHostContractTool(name: string, context?: { turnId?: string | undefined; fullEncryptionOnly?: boolean | undefined }) {
  const definition = computerUseHostToolDefinition(name);
  if (definition === null) throw new Error("Computer Use Host catalogue entry is unavailable");
  const model = name === "computer_observe" && exposesControlCollection(definition.entry.publicSchemas.result.jsonSchema)
    ? resolveNativeDecisionModel(context) : null;
  const workflow = model !== null;
  const schema = model ? withDecisionPlan(definition.entry.publicSchemas.input.jsonSchema, workflow) : definition.entry.publicSchemas.input.jsonSchema;
  const workflowDescription = workflow ? " For routine native UI work, delegate the complete workflow to the eligible fast native decision loop rather than performing each setup step yourself. On one standalone fresh observation, supply decisionPlan.execution=workflow, the complete goal/constraints, and exact authored content once in values. Preserve known app/document names and other semantic referents in that goal so fresh choices can be matched; do not reduce a known document to an ambiguous phrase such as 'the open document'. These names are lookup hints, not authority to reuse historical handles. This route handles app/window discovery and recovery; do not first launch, focus or select a window merely to prepare delegation. Compose content once when needed, then delegate the complete remaining UI goal. The interpreter is optional; text-grounded Choice decisions and code-owned readback remain available without it. Use window-only delegation only when intentionally delegating a bounded segment. Code binds original values and targets through ordinary authority. Do not attach plans to history reads." : "";
  const historyDescription = name === "computer_observe"
    ? " HISTORY: use only historyToolCallId for retained active-turn evidence, or only historyRoomRef for an explicitly offered Room-history reference. Reads do not contact the desktop. Historical targets/pixels are stale, never action authority. Missing history returns an explicit error; this does not search other rooms."
    : "";
  return new DynamicStructuredTool({
    name,
    description: `${definition.entry.projection.modelDescription} ${definition.entry.projection.argumentsSummary} Available only through a live, authorized Computer Use desktop connection.${workflowDescription}${model ? ` Alternatively, for control selection inside one selected window, omit execution and delegate to ${model.displayName} with one standalone window_state call with decisionPlan and no selector. Supply the goal, constraints and exact composed values once; use actions to specify intended ordinary computer_do operations. In this window-only mode, omitted actions offer observed clicks plus insertion/replacement of supplied values; explicit actions restrict the segment, including an empty read-only list. For type_text/set_value templates, omit text/value to bind named values. Exact keys, menus and other arguments belong in actions. The runtime observes after actions and uses ordinary Computer Use authority, with no role whitelist or invented pixels/arguments. This window-only selector returns to Genie for visual interpretation, ambiguity, missing inputs, uncertain effects or final verification. Whole-workflow execution instead uses a Choice-led loop with an optional fast interpreter and checked completion. Without decisionPlan this remains read-only; all ordinary tools remain available without a decision model.` : ""}`,
    schema: modelInputSchema(name === "computer_observe" ? { type: "object", description: historyDescription + workflowDescription, anyOf: [schema,
      z.toJSONSchema(nativeHistoryInputSchema, { io: "input" }), z.toJSONSchema(nativeRoomHistoryInputSchema, { io: "input" })] } : schema) as JsonSchema7Type,
    func: () => Promise.reject(new Error(
      `${name} is a Computer Use Host tool — execution goes through the context-bound generic Host protocol, not direct invocation.`,
    )),
  });
}
