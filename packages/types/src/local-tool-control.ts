import { z } from "zod";
import { securityResearchRuntimeRecoverySchema } from "./security-scan";

/** Invalid operation shapes remain invalid requests; identify their tool without coercion. */
export function localToolRequestedOperation(toolName: string, args: Record<string, unknown> | null | undefined): string {
  const operation = args?.["operation"] ?? args?.["command"];
  return typeof operation === "string" && operation.length > 0 ? operation : toolName;
}

/** Server-generated pre-dispatch correction. Never a tool result or source inspection. */
export const localToolControlReceiptSchema = z.strictObject({
  ok: z.literal(false),
  operation: z.literal("local_tool_control"),
  toolName: z.string().min(1),
  requestedOperation: z.string().min(1),
  notDispatched: z.literal(true),
  error: z.strictObject({
    code: z.enum(["invalid_request", "context_recovery_pending"]),
    message: z.string().min(1),
    retryable: z.literal(false),
  }),
  runtimeRecovery: securityResearchRuntimeRecoverySchema.optional(),
});
export type LocalToolControlReceipt = z.infer<typeof localToolControlReceiptSchema>;
/** Browser projection: runtime controls without the private canonical reference. */
export const localToolControlDisplaySchema = localToolControlReceiptSchema.extend({
  runtimeRecovery: securityResearchRuntimeRecoverySchema.omit({ nextContextRef: true }).optional(),
});
