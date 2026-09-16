export type {
  CapabilityProvenance,
  ActiveModelCapabilityCatalogEntry,
  ModelCapabilityFeatures,
  ModelInputModality,
  ModelOutputModality,
  ResolvedModelCapabilities,
  ModelCapabilitiesCacheFile,
  OpenRouterCapabilitySnapshot,
} from "./types";

export {
  MODEL_CAPABILITY_OVERRIDES,
  NAUTILO_ID_TO_OPENROUTER_SLUG,
} from "./overrides";

export {
  mapOpenRouterModalitiesToInput,
  mapOpenRouterModalitiesToOutput,
  mapOpenRouterSupportedParameters,
  fetchOpenRouterCapabilitiesSnapshot,
} from "./openrouter";

export {
  hydrateModelCapabilitiesCache,
  readCapabilitiesCacheFromDisk,
  getCachedOpenRouterModels,
  resetModelCapabilitiesCacheForTests,
  setModelCapabilitiesCacheForTests,
} from "./cache";

export {
  resolveModelCapabilities,
  modelSupportsInput,
  modelSupportsOutput,
  resolveModelFeatures,
  modelSupportsFeature,
  replaceActiveModelCapabilityCatalog,
} from "./catalog";
