import { z } from "zod";

// These are the existing retained-output contract bounds, shared with the
// legacy nested schema so extraction does not change its accepted requests.
export const outputArtifactPageSchema = z.object({
  reference: z.string().min(32).describe("Opaque retained-output reference returned by a shell command."),
  offset_bytes: z.number().int().nonnegative().optional().describe("Page offset; omit for the first page."),
  max_bytes: z.number().int().positive().max(16 * 1024).optional().describe("Requested page bytes, capped at 16 KiB."),
  delete_after_read: z.boolean().optional().describe("Delete only when this read reaches the final page."),
}).strict().describe("Retrieve a bounded page from a short-lived Desktop-local shell continuation.");

export const outputArtifactSearchSchema = z.object({
  reference: z.string().min(32).describe("Opaque retained-output reference returned by a shell command."),
  operation: z.literal("search"),
  query: z.string().min(1).max(1024)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 1024, "Literal search query must be at most 1024 UTF-8 bytes.")
    .describe("Case-sensitive literal diagnostic, path, or test name to find; regex is not supported."),
  max_matches: z.number().int().positive().max(20).optional().describe("Maximum literal matches to return (at most 20)."),
  context_bytes: z.number().int().nonnegative().max(1024).optional().describe("Bytes of surrounding context per match (at most 1024)."),
}).strict().describe("Search already-retained output literally; this never reruns the original command.");
