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

export const memoryEmbeddingCanonicalSpaceV2Schema = z.object({
  provider: z.enum(["openai", "openrouter", "venice"]),
  model: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u),
  dimensions: z.literal(1536),
}).strict();

export const memoryEmbeddingProcessingRouteV2Schema = z.discriminatedUnion(
  "transport",
  [
    z.object({ transport: z.literal("direct") }).strict(),
    z.object({
      transport: z.literal("surplus_marketplace"),
      marketplacePolicyVersion: z.literal("surplus-embedding-marketplace-v1"),
      dataRecipientClasses: z.tuple([
        z.literal("surplus"),
        z.literal("marketplace_seller"),
        z.literal("seller_upstream_processor"),
      ]).readonly(),
    }).strict(),
  ],
);

/** Exact user-visible disclosure authorized by new protected Memory clients. */
export const memoryEmbeddingDisclosureV2Schema = z.object({
  contractVersion: z.literal(2),
  canonicalSpace: memoryEmbeddingCanonicalSpaceV2Schema,
  processingRoute: memoryEmbeddingProcessingRouteV2Schema,
}).strict().superRefine((value, context) => {
  if (value.processingRoute.transport === "surplus_marketplace"
    && (value.canonicalSpace.provider !== "venice"
      || value.canonicalSpace.model !== "text-embedding-3-large")) {
    context.addIssue({ code: "custom",
      message: "Surplus marketplace embeddings require the admitted Venice 3-large space" });
  }
});

/** Versioned separately so strict V1 clients never reinterpret a marketplace route. */
export const memoryProcessorRecipientV2Schema = z.object({
  formatVersion: z.literal(2),
  purpose: z.literal("memory.foreground_embedding"),
  recipientId: bytes.length(43),
  publicKeyBase64url: bytes.length(87),
  embedding: memoryEmbeddingDisclosureV2Schema.optional(),
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
export type MemoryEmbeddingCanonicalSpaceV2 = z.infer<
  typeof memoryEmbeddingCanonicalSpaceV2Schema
>;
export type MemoryEmbeddingProcessingRouteV2 = z.infer<
  typeof memoryEmbeddingProcessingRouteV2Schema
>;
export type MemoryEmbeddingDisclosureV2 = z.infer<
  typeof memoryEmbeddingDisclosureV2Schema
>;
export type MemoryProcessorRecipientV2 = z.infer<
  typeof memoryProcessorRecipientV2Schema
>;
export type MemoryProcessorSealedRequestV1 = z.infer<
  typeof memoryProcessorSealedRequestV1Schema
>;
export type MemoryProcessorRequestPurposeV1 = z.infer<
  typeof memoryProcessorRequestPurposeV1Schema
>;
