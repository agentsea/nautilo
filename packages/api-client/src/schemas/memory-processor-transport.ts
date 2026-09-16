import { z } from "zod";

const bytes = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => value.length % 4 !== 1);

export const memoryProcessorRequestPurposeV1Schema = z.enum([
  "memory.content_embedding",
  "memory.query_embedding",
  "memory.ordinary_fallback",
]);

/** Public, process-local recipient. It confers no object/Namespace access. */
export const memoryProcessorRecipientV1Schema = z.object({
  formatVersion: z.literal(1),
  purpose: z.literal("memory.foreground_embedding"),
  recipientId: bytes.length(43),
  publicKeyBase64url: bytes.length(87),
  embedding: z.object({
    provider: z.enum(["openai", "openrouter", "venice"]),
    model: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u),
    dimensions: z.literal(1536),
  }).strict().optional(),
}).strict();

/** Request content is opened only inside the foreground embedding boundary. */
export const memoryProcessorSealedRequestV1Schema = z.object({
  formatVersion: z.literal(1),
  recipientId: bytes.length(43),
  ciphertextBase64url: bytes,
}).strict();

export type MemoryProcessorRecipientV1 = z.infer<
  typeof memoryProcessorRecipientV1Schema
>;
export type MemoryProcessorSealedRequestV1 = z.infer<
  typeof memoryProcessorSealedRequestV1Schema
>;
export type MemoryProcessorRequestPurposeV1 = z.infer<
  typeof memoryProcessorRequestPurposeV1Schema
>;
