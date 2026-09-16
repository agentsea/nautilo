import { z } from "zod";
import { ConfigGuardError } from "./types";
import type { CheckInput, TransactionInput } from "./types";

export const ConfigOperationSchema = z.object({
  type: z.enum(["set", "remove"]),
  key: z.string(),
  value: z.string().optional(),
});

export const TransactionInputSchema = z.object({
  operations: z.array(ConfigOperationSchema),
  healthCheck: z.enum(["keys", "server", "none"]),
  overwrite: z.boolean().optional(),
  reason: z.string(),
  actor: z.enum(["setup-spa", "agent", "cli", "test"]),
});

export const CheckInputSchema = z.object({
  validate: z.boolean().optional(),
});

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
}

export function parseTransactionInput(input: unknown): TransactionInput {
  const r = TransactionInputSchema.safeParse(input);
  if (!r.success) {
    throw new ConfigGuardError("VALIDATION", formatZodError(r.error));
  }
  return r.data;
}

export function parseCheckInput(input: unknown): CheckInput {
  const r = CheckInputSchema.safeParse(
    input === undefined || input === null ? {} : input,
  );
  if (!r.success) {
    throw new ConfigGuardError("VALIDATION", formatZodError(r.error));
  }
  return r.data;
}
