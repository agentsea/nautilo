import { z } from "zod";

/** Server-owned intent. This metadata never crosses the Computer Use Host protocol. */
export const nativeDecisionPlanSchema = z.object({
  goal: z.string().trim().min(1),
  constraints: z.array(z.string()).default([]),
  values: z.record(z.string(), z.string()).default({}).describe("Exact supplied values keyed by purpose. Offered unchanged as insertion or replacement against fresh controls; never guessed from UI content."),
  actions: z.array(z.object({
    purpose: z.string().min(1),
    target: z.enum(["each_control", "window", "exact"]),
    operation: z.record(z.string(), z.json()).describe("An ordinary computer_do operation. For each_control or window omit target: the runtime binds fresh authority. For exact supply every argument. No invented keys, values, pixels or menu paths."),
  }).strict()).default([{ purpose: "Activate an observed control", target: "each_control", operation: { kind: "click" } }]),
}).strict();
export type NativeDecisionPlan = z.infer<typeof nativeDecisionPlanSchema>;

export function parseNativeDecisionPlan(name: string, args: Record<string, unknown>) {
  if (name !== "computer_observe" || args["decisionPlan"] === undefined) return null;
  // Delegation consumes a control collection, never a selected control or pixels.
  if (args["operation"] !== "window_state" || args["selector"] !== undefined) return null;
  const parsed = nativeDecisionPlanSchema.safeParse(args["decisionPlan"]);
  return parsed.success ? parsed.data : null;
}

/** Preserve the ordinary signed schema for every Host-bound argument. */
export function nativeDecisionHostArguments(name: string, args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  if (!Object.hasOwn(record, "decisionPlan")) return args;
  if (parseNativeDecisionPlan(name, record) === null) return args;
  const { decisionPlan: _plan, ...hostArgs } = record;
  return hostArgs;
}
