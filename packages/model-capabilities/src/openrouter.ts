import type {
  ModelCapabilitiesCacheFile,
  ModelCapabilityFeatures,
  ModelInputModality,
  ModelOutputModality,
  OpenRouterCapabilitySnapshot,
} from "./types";

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: string;
    supported_parameters?: string[];
    architecture?: {
      input_modalities?: string[];
      output_modalities?: string[];
    };
  }>;
}

export function mapOpenRouterSupportedParameters(raw: string[] | undefined): ModelCapabilityFeatures {
  const set = new Set((raw ?? []).map((s) => String(s).toLowerCase()));
  return {
    tools: set.has("tools"),
    structuredOutputs: set.has("structured_outputs") || set.has("response_format"),
    reasoning: set.has("reasoning") || set.has("include_reasoning"),
  };
}

export function mapOpenRouterModalitiesToInput(raw: string[] | undefined): ModelInputModality[] {
  if (!raw?.length) {
    return ["text"];
  }
  const set = new Set<ModelInputModality>();
  for (const m of raw) {
    const low = m.toLowerCase();
    if (low === "text") set.add("text");
    else if (low === "image") set.add("image");
    else if (low === "file" || low === "document") set.add("file");
  }
  if (set.size === 0) set.add("text");
  return [...set];
}

export function mapOpenRouterModalitiesToOutput(raw: string[] | undefined): ModelOutputModality[] {
  if (!raw?.length) {
    return ["text"];
  }
  const set = new Set<ModelOutputModality>();
  for (const m of raw) {
    const low = m.toLowerCase();
    if (low === "text") set.add("text");
    else if (low === "image") set.add("image");
  }
  if (set.size === 0) set.add("text");
  return [...set];
}

export async function fetchOpenRouterCapabilitiesSnapshot(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<ModelCapabilitiesCacheFile> {
  const res = await fetchFn("https://openrouter.ai/api/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter models fetch failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as OpenRouterModelsResponse;
  const models: Record<string, OpenRouterCapabilitySnapshot> = {};
  for (const row of json.data ?? []) {
    const id = row.id;
    if (!id) continue;
    models[id] = {
      input: mapOpenRouterModalitiesToInput(row.architecture?.input_modalities),
      output: mapOpenRouterModalitiesToOutput(row.architecture?.output_modalities),
      features: mapOpenRouterSupportedParameters(row.supported_parameters),
    };
  }
  return { fetchedAt: new Date().toISOString(), models };
}
