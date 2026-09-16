/** User- or tool-visible modalities we route attachments against. */
export type ModelInputModality = "text" | "image" | "file";

/** Output transport modality. Music is emitted as `audio`, not a third modality. */
export type ModelOutputModality = "text" | "image" | "audio" | "video" | "embedding";

export type CapabilityProvenance = "override" | "openrouter" | "smoke" | "default";

/** Derived from OpenRouter `supported_parameters` where present. */
export interface ModelCapabilityFeatures {
  readonly tools: boolean | null;
  readonly structuredOutputs: boolean | null;
  readonly reasoning: boolean | null;
}

/**
 * Trusted projection of one entry from the active, validated signed catalog.
 * The Agent runtime replaces the complete snapshot through its existing
 * catalog lifecycle; ordinary callers cannot append individual assertions.
 */
export interface ActiveModelCapabilityCatalogEntry {
  readonly id: string;
  readonly modalities?: {
    readonly input: readonly ModelInputModality[];
    readonly output: readonly ModelOutputModality[];
  } | undefined;
  readonly features?: ModelCapabilityFeatures | undefined;
  readonly capabilityProvenance?: CapabilityProvenance | undefined;
}

export interface ResolvedModelCapabilities {
  readonly modelId: string;
  readonly input: readonly ModelInputModality[];
  readonly output: readonly ModelOutputModality[];
  readonly provenance: CapabilityProvenance;
  /** Present when imported from OpenRouter or explicitly overridden */
  readonly features?: ModelCapabilityFeatures | undefined;
  /** When metadata came from OpenRouter cache import */
  readonly fetchedAt?: string | undefined;
  /** Last successful smoke verification (ISO), if any */
  readonly lastVerifiedAt?: string | undefined;
}

export interface OpenRouterCapabilitySnapshot {
  input: ModelInputModality[];
  output: ModelOutputModality[];
  /** From OpenRouter `supported_parameters` */
  features?: ModelCapabilityFeatures | undefined;
}

export interface ModelCapabilitiesCacheFile {
  fetchedAt: string;
  /** Keyed by OpenRouter model id (e.g. anthropic/claude-3.5-sonnet) */
  models: Record<string, OpenRouterCapabilitySnapshot>;
}
