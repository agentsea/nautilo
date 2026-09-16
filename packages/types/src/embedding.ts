/** The actual provider result, retained across preparation and persistence. */
export type EmbeddingProvider = "openai" | "openrouter" | "venice";

export interface EmbeddingWithProvenanceV1 {
  readonly vector: readonly number[];
  readonly provider: EmbeddingProvider;
  readonly canonicalModel: string;
  readonly dimensions: number;
  readonly contractVersion: 1;
}
